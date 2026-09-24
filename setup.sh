#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "❌ این اسکریپت باید با root اجرا شود: sudo bash setup.sh"
  exit 1
fi

echo "🌸 Preparing Narges Koochooloo (FREE-ONLY / npm mode)..."

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
  echo "❌ فایل .env ساخته شد. BOT_TOKEN و OPENROUTER_API_KEY و IDها را وارد کن و دوباره همین دستور را اجرا کن."
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

# Remove all legacy or potentially-paid settings.
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

# Requested final profile.
set_env AI_MODELS ""
set_env AI_TIMEOUT_SECONDS "45"
# OpenRouter free accounts are currently capped at 50 free requests/day;
# keep a little headroom for restarts/tests.
set_env DAILY_AI_LIMIT "45"
set_env DIRECT_RESERVE "12"
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
  echo "❌ BOT_TOKEN داخل .env خالی است."
  exit 1
fi
if [[ -z "$OPENROUTER_KEY_VALUE" || "$OPENROUTER_KEY_VALUE" == "sk-or-v1-" || "$OPENROUTER_KEY_VALUE" == *"PASTE_"* ]]; then
  echo "❌ OPENROUTER_API_KEY داخل .env کامل نیست."
  exit 1
fi

ENGINEER_ID_VALUE="$(read_env ENGINEER_ID)"
DOCTOR_ID_VALUE="$(read_env DOCTOR_ID)"
if [[ -z "$ENGINEER_ID_VALUE" || -z "$DOCTOR_ID_VALUE" ]]; then
  echo "⚠️ ENGINEER_ID یا DOCTOR_ID خالی است؛ بات اجرا می‌شود ولی تشخیص مهندس/خانوم دکتر کامل نیست."
fi

echo "📦 Installing Node dependencies..."
rm -rf node_modules
npm install
npm run check

# Runtime settings stored in SQLite can override .env, so reset them too.
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

# This project is intentionally NOT managed by systemd anymore.
# Stop/remove the old unit so it cannot cause Telegram 409 conflicts.
if systemctl list-unit-files 2>/dev/null | grep -q '^telbot.service'; then
  systemctl stop telbot.service 2>/dev/null || true
  systemctl disable telbot.service 2>/dev/null || true
fi
rm -f /etc/systemd/system/telbot.service
systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed 2>/dev/null || true

# Stop stale copies of this exact bot only.
pkill -f "$APP_DIR/src/index.js" 2>/dev/null || true
pkill -f "$APP_DIR/index.js" 2>/dev/null || true
sleep 1

echo
echo "✅ آماده شد: FREE-ONLY، بدون systemd، بدون fallback پولی، بدون Web Search پولی."
echo "🧪 در startup یک درخواست واقعی رایگان زده می‌شود و مدل متصل‌شده چاپ می‌شود."
echo "▶️ اجرای بات با npm run start ..."
echo

exec npm run start
