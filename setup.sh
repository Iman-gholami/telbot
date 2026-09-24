#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "❌ این اسکریپت باید با root اجرا شود: sudo bash setup.sh"
  exit 1
fi

echo "🌸 Installing Narges Koochooloo (free-only mode)..."

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y build-essential python3 curl git ca-certificates

export NVM_DIR="${NVM_DIR:-/root/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "📦 Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

nvm install 22
nvm use 22
nvm alias default 22

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "❌ فایل .env وجود نداشت و ساخته شد. BOT_TOKEN و OPENROUTER_API_KEY و IDها را داخلش وارد کن و همین دستور را دوباره اجرا کن."
  exit 1
fi

cp .env ".env.backup-$(date +%Y%m%d-%H%M%S)"

remove_env() {
  local key="$1"
  sed -i "/^${key}=/d" .env
}

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

# Remove all legacy/potentially-paid routing settings.
for key in \
  AI_MODEL \
  PAID_FALLBACK_MODEL \
  MONTHLY_AI_BUDGET_USD \
  PAID_INPUT_USD_PER_M \
  PAID_OUTPUT_USD_PER_M \
  WEB_SEARCH_ENGINE \
  WEB_SEARCH_ESTIMATED_COST_USD \
  RESPONSE_RATE \
  FIXED_REPLY_RATE \
  MEMORY_SIZE; do
  remove_env "$key"
done

# Force the personality/behavior requested for this bot.
set_env AI_MODELS ""
set_env AI_TIMEOUT_SECONDS "45"
set_env DAILY_AI_LIMIT "120"
set_env DIRECT_RESERVE "20"
set_env WEB_SEARCH_ENABLED "false"
set_env DOCTOR_BIAS "0.65"
set_env ROAST_LEVEL "2"
set_env AUTO_COOLDOWN_SECONDS "110"
set_env AUTO_MAX_PROB "0.38"
set_env AUTO_DEBOUNCE_SECONDS "8"
set_env DIRECT_FOLLOWUP_SECONDS "7"
set_env HISTORY_SIZE "32"
set_env DB_HISTORY_LIMIT "350"
set_env DIGEST_EVERY "28"
set_env DIGEST_IDLE_SECONDS "90"
set_env DATA_DIR "data"

read_env() {
  local key="$1"
  grep -m1 "^${key}=" .env | cut -d= -f2- || true
}

BOT_TOKEN_VALUE="$(read_env BOT_TOKEN)"
OPENROUTER_KEY_VALUE="$(read_env OPENROUTER_API_KEY)"

if [[ -z "$BOT_TOKEN_VALUE" || "$BOT_TOKEN_VALUE" == *"PASTE_"* ]]; then
  echo "❌ BOT_TOKEN داخل .env خالی است. توکن واقعی تلگرام را وارد کن."
  exit 1
fi
if [[ -z "$OPENROUTER_KEY_VALUE" || "$OPENROUTER_KEY_VALUE" == "sk-or-v1-" || "$OPENROUTER_KEY_VALUE" == *"PASTE_"* ]]; then
  echo "❌ OPENROUTER_API_KEY داخل .env کامل نیست. کلید واقعی OpenRouter را وارد کن."
  exit 1
fi

ENGINEER_ID_VALUE="$(read_env ENGINEER_ID)"
DOCTOR_ID_VALUE="$(read_env DOCTOR_ID)"
if [[ -z "$ENGINEER_ID_VALUE" || -z "$DOCTOR_ID_VALUE" ]]; then
  echo "⚠️ ENGINEER_ID یا DOCTOR_ID خالی است؛ بات اجرا می‌شود ولی تشخیص مهندس/خانوم دکتر کامل نخواهد بود."
fi

echo "📦 Installing Node dependencies..."
rm -rf node_modules
npm install
npm run check

# Runtime settings are persisted in SQLite and can override .env. Reset them
# to the requested final profile and keep all potentially-paid switches off.
node --input-type=module -e '
  const m = await import("./db.js");
  m.setSetting("doctor_bias", "0.65");
  m.setSetting("auto_max_prob", "0.38");
  m.setSetting("roast_level", "2");
  m.setSetting("auto_debounce_seconds", "8");
  m.setSetting("paid_fallback", "0");
  m.setSetting("web_search", "0");
  m.closeDb();
'

NODE_BIN="$(command -v node)"

# Stop an old manually-started copy, if one exists.
pkill -f "$APP_DIR/src/index.js" 2>/dev/null || true
pkill -f "$APP_DIR/index.js" 2>/dev/null || true

cat > /etc/systemd/system/telbot.service <<EOF
[Unit]
Description=Narges Koochooloo Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/index.js
Restart=always
RestartSec=5
KillSignal=SIGINT
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable telbot.service >/dev/null
systemctl restart telbot.service
sleep 3

if ! systemctl is-active --quiet telbot.service; then
  echo "❌ سرویس بالا نیامد. آخرین لاگ‌ها:"
  journalctl -u telbot.service -n 80 --no-pager
  exit 1
fi

echo
echo "✅ نرگس V4 با حالت FREE-ONLY اجرا شد."
echo "🤖 فقط مدل‌های رایگان OpenRouter مجازند؛ AI_MODEL قدیمی نادیده گرفته می‌شود."
echo "💸 fallback پولی و Web Search پولی در کد قفل و غیرفعال‌اند."
echo "📋 وضعیت سرویس: systemctl status telbot --no-pager"
echo "📜 لاگ زنده: journalctl -u telbot -f"
