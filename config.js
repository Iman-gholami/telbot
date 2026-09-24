import "dotenv/config";

if (!process.env.BOT_TOKEN) {
  console.error("Missing required environment variable: BOT_TOKEN");
  process.exit(1);
}

export function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function list(value) {
  return [
    ...new Set(
      String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    ),
  ];
}

const env = process.env;

// Telegram
export const BOT_TOKEN = env.BOT_TOKEN;
export const ENGINEER_ID = Number(env.ENGINEER_ID || 0);
export const DOCTOR_ID = Number(env.DOCTOR_ID || 0);
// اگر خالی باشد ربات در هر گروهی کار می‌کند
export const ALLOWED_CHAT_IDS = list(env.ALLOWED_CHAT_IDS);

// AI
export const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || "";
// اگر خالی باشد، مدل‌های رایگان خودکار از OpenRouter پیدا می‌شوند
export const AI_MODELS = list(env.AI_MODELS || env.AI_MODEL);
export const AI_TIMEOUT_SECONDS = clampNumber(env.AI_TIMEOUT_SECONDS, 45, 10, 120);
export const DAILY_AI_LIMIT = clampNumber(env.DAILY_AI_LIMIT, 45, 1, 100000);
export const DIRECT_RESERVE = clampNumber(env.DIRECT_RESERVE, 15, 0, 100000);

// Personality
export const DOCTOR_BIAS = clampNumber(env.DOCTOR_BIAS, 0.9, 0, 1);

// Context & memory
export const HISTORY_SIZE = clampNumber(env.HISTORY_SIZE, 30, 10, 80);
export const DB_HISTORY_LIMIT = clampNumber(env.DB_HISTORY_LIMIT, 300, 100, 2000);
export const DIGEST_EVERY = clampNumber(env.DIGEST_EVERY, 35, 10, 200);
export const DIGEST_IDLE_SECONDS = clampNumber(env.DIGEST_IDLE_SECONDS, 120, 10, 3600);
export const DATA_DIR = env.DATA_DIR || "data";

// Timing
export const AUTO_COOLDOWN_SECONDS = clampNumber(env.AUTO_COOLDOWN_SECONDS, 120, 15, 3600);
export const AUTO_MAX_PROB = clampNumber(env.AUTO_MAX_PROB, 0.45, 0.02, 1);
export const AUTO_DEBOUNCE_SECONDS = clampNumber(env.AUTO_DEBOUNCE_SECONDS, 10, 0, 120);
export const DIRECT_FOLLOWUP_SECONDS = clampNumber(env.DIRECT_FOLLOWUP_SECONDS, 8, 0, 60);
