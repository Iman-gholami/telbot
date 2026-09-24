import {
  OPENROUTER_API_KEY,
  AI_TIMEOUT_SECONDS,
  DAILY_AI_LIMIT,
  DIRECT_RESERVE,
} from "./config.js";
import { getUsage, incrementUsage, markExhausted } from "./db.js";

const API = "https://openrouter.ai/api/v1";
const ROUTER_MODEL = "openrouter/free";

export class QuotaError extends Error {}

let initialized = false;
let globalCooldownUntil = 0;
const metrics = {
  requests: 0,
  successes: 0,
  rateLimits: 0,
  providerErrors: 0,
  paidFallbacks: 0,
  webSearches: 0,
  lastModel: null,
  lastError: null,
  startupProbe: false,
  routeAttempts: 0,
  preferredModel: ROUTER_MODEL,
};

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function extractContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  return "";
}

export function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "")
    .replace(/^[\s\S]*<\/analysis>/i, "")
    .trim();
}

function isJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || "").trim());
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export async function initModels() {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is missing");
  if (!initialized) {
    initialized = true;
    console.log("🤖 Free AI route: openrouter/free");
    console.log("⚡ One OpenRouter request per AI reply; OpenRouter chooses a compatible free model internally.");
  }
  return currentModels();
}

export function currentModels() {
  return [ROUTER_MODEL];
}

export function budget() {
  const u = getUsage(utcDay());
  const remaining = u.exhausted ? 0 : Math.max(0, DAILY_AI_LIMIT - u.count);
  return { used: u.count, limit: DAILY_AI_LIMIT, remaining, exhausted: remaining === 0 };
}

export function monthlyBudget() {
  return {
    month: new Date().toISOString().slice(0, 7),
    spentUsd: 0,
    limitUsd: 0,
    remainingUsd: 0,
    paidRequests: 0,
    webRequests: 0,
  };
}

export function canSpend(kind = "direct") {
  const { remaining, exhausted } = budget();
  if (exhausted) return false;
  return kind === "direct" ? remaining > 0 : remaining > DIRECT_RESERVE;
}

export function aiMetrics() {
  return {
    ...metrics,
    preferredModel: ROUTER_MODEL,
    cooldownSeconds: Math.max(0, Math.ceil((globalCooldownUntil - Date.now()) / 1000)),
  };
}

export async function chatCompletion(
  messages,
  {
    temperature = 0.7,
    maxTokens = 400,
    kind = "direct",
    jsonMode = true,
    attemptTimeoutMs,
  } = {}
) {
  await initModels();
  if (!canSpend(kind)) throw new QuotaError("daily free-request budget reached");
  if (Date.now() < globalCooldownUntil && kind !== "direct") {
    throw new QuotaError("free router cooling down");
  }

  incrementUsage(utcDay());
  metrics.requests++;
  metrics.routeAttempts++;

  const social = maxTokens <= 180;
  const timeoutMs = Math.max(
    4000,
    Math.min(
      AI_TIMEOUT_SECONDS * 1000,
      Number(attemptTimeoutMs) || (social ? 9000 : 16000)
    )
  );

  const body = {
    model: ROUTER_MODEL,
    messages,
    temperature,
    top_p: 0.92,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  let res;
  try {
    res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "Narges Koochooloo Telegram Bot",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    metrics.providerErrors++;
    metrics.lastError = error.message;
    throw error;
  }

  if (res.status === 401 || res.status === 403) {
    const text = (await res.text()).slice(0, 500);
    metrics.lastError = `${res.status}: ${text}`;
    throw new Error(`OpenRouter API key rejected (${res.status})`);
  }

  if (res.status === 402) {
    const text = (await res.text()).slice(0, 500);
    markExhausted(utcDay());
    metrics.lastError = `402: ${text}`;
    throw new QuotaError("OpenRouter free allowance unavailable");
  }

  if (res.status === 429) {
    metrics.rateLimits++;
    const text = (await res.text()).slice(0, 700);
    metrics.lastError = `429: ${text}`;
    globalCooldownUntil = Date.now() + 20_000;
    throw new QuotaError("OpenRouter free router is temporarily rate-limited");
  }

  if (!res.ok) {
    metrics.providerErrors++;
    const text = (await res.text()).slice(0, 700);
    metrics.lastError = `${res.status}: ${text}`;
    throw new Error(`OpenRouter ${res.status}`);
  }

  const data = await res.json();
  if (data?.error) {
    metrics.providerErrors++;
    metrics.lastError = JSON.stringify(data.error).slice(0, 500);
    throw new Error("OpenRouter returned an error payload");
  }

  const text = stripThinking(extractContent(data));
  if (!text) {
    metrics.providerErrors++;
    metrics.lastError = "empty response";
    throw new Error("OpenRouter returned an empty response");
  }
  if (jsonMode && !isJsonObject(text)) {
    metrics.providerErrors++;
    metrics.lastError = "non-JSON response";
    throw new Error("OpenRouter returned invalid structured output");
  }

  metrics.successes++;
  metrics.lastModel = String(data.model || ROUTER_MODEL);
  metrics.lastError = null;

  return {
    text,
    model: metrics.lastModel,
    routeModel: ROUTER_MODEL,
    usedPaid: false,
    usedWeb: false,
  };
}
