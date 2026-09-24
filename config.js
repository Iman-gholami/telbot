import "dotenv/config";

if (!process.env.BOT_TOKEN) {
  console.error("Missing required environment variable: BOT_TOKEN");
  process.exit(1);
}

export function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function list(value) {
  return [...new Set(String(value || "").split(",").map((x) => x.trim()).filter(Boolean))];
}

const env = process.env;

export const BOT_TOKEN = env.BOT_TOKEN;
export const ENGINEER_ID = Number(env.ENGINEER_ID || 0);
export const DOCTOR_ID = Number(env.DOCTOR_ID || 0);
export const ADMIN_IDS = list(env.ADMIN_IDS).map(Number).filter(Number.isFinite);
export const ALLOWED_CHAT_IDS = list(env.ALLOWED_CHAT_IDS);

export const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || "";

// Free-only safety: legacy AI_MODEL is intentionally ignored so an old .env
// cannot pin the bot to one rate-limited provider. Optional AI_MODELS values
// are accepted only when they are explicitly free routes.
export const AI_MODELS = list(env.AI_MODELS).filter(
  (id) => id === "openrouter/free" || id.endsWith(":free")
);
export const AI_TIMEOUT_SECONDS = clampNumber(env.AI_TIMEOUT_SECONDS, 45, 10, 120);

// OpenRouter's free account allowance is limited, so keep a small safety margin
// and reserve most of it for direct messages. Old .env values cannot raise this.
const configuredDailyLimit = clampNumber(env.DAILY_AI_LIMIT, 45, 1, 45);
export const DAILY_AI_LIMIT = Math.min(configuredDailyLimit, 45);
const configuredReserve = clampNumber(env.DIRECT_RESERVE, 30, 0, 45);
export const DIRECT_RESERVE = Math.min(DAILY_AI_LIMIT, Math.max(Math.min(30, DAILY_AI_LIMIT), configuredReserve));

// Hard-disabled paid features. These constants remain exported for backwards
// compatibility with the runtime, but environment variables cannot enable them.
export const PAID_FALLBACK_MODEL = "";
export const MONTHLY_AI_BUDGET_USD = 0;
export const PAID_INPUT_USD_PER_M = 0;
export const PAID_OUTPUT_USD_PER_M = 0;

// OpenRouter web search can incur cost, so it is hard-disabled in free-only mode.
export const WEB_SEARCH_ENABLED = false;
export const WEB_SEARCH_ENGINE = "parallel";
export const WEB_SEARCH_ESTIMATED_COST_USD = 0;

export const DOCTOR_BIAS = clampNumber(env.DOCTOR_BIAS, 0.65, 0, 1);
export const ROAST_LEVEL = Math.round(clampNumber(env.ROAST_LEVEL, 2, 1, 3));
export const AUTO_COOLDOWN_SECONDS = clampNumber(env.AUTO_COOLDOWN_SECONDS, 110, 15, 3600);
export const AUTO_MAX_PROB = clampNumber(env.AUTO_MAX_PROB, 0.38, 0.02, 1);
// Keep the bot feeling live even if an older .env still contains 8/7-second delays.
export const AUTO_DEBOUNCE_SECONDS = Math.min(clampNumber(env.AUTO_DEBOUNCE_SECONDS, 3, 0, 120), 3);
export const DIRECT_FOLLOWUP_SECONDS = Math.min(clampNumber(env.DIRECT_FOLLOWUP_SECONDS, 1, 0, 60), 1);

export const HISTORY_SIZE = Math.round(clampNumber(env.HISTORY_SIZE, 32, 10, 80));
export const DB_HISTORY_LIMIT = Math.round(clampNumber(env.DB_HISTORY_LIMIT, 350, 100, 3000));
export const DIGEST_EVERY = Math.round(clampNumber(env.DIGEST_EVERY, 28, 10, 200));
export const DIGEST_IDLE_SECONDS = clampNumber(env.DIGEST_IDLE_SECONDS, 90, 10, 3600);
export const DATA_DIR = env.DATA_DIR || "data";
