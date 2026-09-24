import "dotenv/config";

if (!process.env.BOT_TOKEN) {
  console.error("Missing required environment variable: BOT_TOKEN");
  process.exit(1);
}

export function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function unique(items) {
  return [...new Set(items)];
}

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

export const ENGINEER_ID = Number(process.env.ENGINEER_ID || 0);
export const DOCTOR_ID = Number(process.env.DOCTOR_ID || 0);

export const DOCTOR_BIAS = clampNumber(process.env.DOCTOR_BIAS, 0.90, 0, 1);
export const HISTORY_SIZE = Math.max(
  10,
  Math.min(60, Number(process.env.HISTORY_SIZE || 28))
);
export const DB_HISTORY_LIMIT = Math.max(
  HISTORY_SIZE,
  Math.min(500, Number(process.env.DB_HISTORY_LIMIT || 180))
);
export const AUTO_COOLDOWN_SECONDS = Math.max(
  15,
  Number(process.env.AUTO_COOLDOWN_SECONDS || 70)
);
export const AUTO_MAX_PROB = clampNumber(
  process.env.AUTO_MAX_PROB,
  0.62,
  0.05,
  1
);

export const AI_MODELS = unique(
  (process.env.AI_MODELS || process.env.AI_MODEL || "openrouter/free")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);

export const DATA_DIR = process.env.DATA_DIR || "data";
