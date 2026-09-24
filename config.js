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

function bool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

const env = process.env;

export const BOT_TOKEN = env.BOT_TOKEN;
export const ENGINEER_ID = Number(env.ENGINEER_ID || 0);
export const DOCTOR_ID = Number(env.DOCTOR_ID || 0);
export const ADMIN_IDS = list(env.ADMIN_IDS).map(Number).filter(Number.isFinite);
export const ALLOWED_CHAT_IDS = list(env.ALLOWED_CHAT_IDS);

export const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || "";
export const AI_MODELS = list(env.AI_MODELS || env.AI_MODEL);
export const AI_TIMEOUT_SECONDS = clampNumber(env.AI_TIMEOUT_SECONDS, 45, 10, 120);
export const DAILY_AI_LIMIT = clampNumber(env.DAILY_AI_LIMIT, 120, 1, 100000);
export const DIRECT_RESERVE = clampNumber(env.DIRECT_RESERVE, 20, 0, 100000);

export const PAID_FALLBACK_MODEL = env.PAID_FALLBACK_MODEL || "openai/gpt-5-nano";
export const MONTHLY_AI_BUDGET_USD = clampNumber(env.MONTHLY_AI_BUDGET_USD, 1, 0, 1000);
export const PAID_INPUT_USD_PER_M = clampNumber(env.PAID_INPUT_USD_PER_M, 0.05, 0, 1000);
export const PAID_OUTPUT_USD_PER_M = clampNumber(env.PAID_OUTPUT_USD_PER_M, 0.40, 0, 1000);

export const WEB_SEARCH_ENABLED = bool(env.WEB_SEARCH_ENABLED, true);
export const WEB_SEARCH_ENGINE = env.WEB_SEARCH_ENGINE || "parallel";
export const WEB_SEARCH_ESTIMATED_COST_USD = clampNumber(env.WEB_SEARCH_ESTIMATED_COST_USD, 0.001, 0, 1);

export const DOCTOR_BIAS = clampNumber(env.DOCTOR_BIAS, 0.65, 0, 1);
export const ROAST_LEVEL = Math.round(clampNumber(env.ROAST_LEVEL, 2, 1, 3));
export const AUTO_COOLDOWN_SECONDS = clampNumber(env.AUTO_COOLDOWN_SECONDS, 110, 15, 3600);
export const AUTO_MAX_PROB = clampNumber(env.AUTO_MAX_PROB, 0.38, 0.02, 1);
export const AUTO_DEBOUNCE_SECONDS = clampNumber(env.AUTO_DEBOUNCE_SECONDS, 8, 0, 120);
export const DIRECT_FOLLOWUP_SECONDS = clampNumber(env.DIRECT_FOLLOWUP_SECONDS, 7, 0, 60);

export const HISTORY_SIZE = Math.round(clampNumber(env.HISTORY_SIZE, 32, 10, 80));
export const DB_HISTORY_LIMIT = Math.round(clampNumber(env.DB_HISTORY_LIMIT, 350, 100, 3000));
export const DIGEST_EVERY = Math.round(clampNumber(env.DIGEST_EVERY, 28, 10, 200));
export const DIGEST_IDLE_SECONDS = clampNumber(env.DIGEST_IDLE_SECONDS, 90, 10, 3600);
export const DATA_DIR = env.DATA_DIR || "data";
