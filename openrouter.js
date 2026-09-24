import {
  OPENROUTER_API_KEY,
  AI_MODELS,
  AI_TIMEOUT_SECONDS,
  DAILY_AI_LIMIT,
  DIRECT_RESERVE,
} from "./config.js";
import { getUsage, incrementUsage, markExhausted } from "./db.js";

const API = "https://openrouter.ai/api/v1";
const PREFERRED = ["qwen", "deepseek", "nvidia", "minimax", "glm", "mistral", "llama", "gemma", "kimi"];
const EXCLUDED = /(vision|-vl|image|embed|guard|safety|moderation|audio|tts|ocr|coder|math)/i;
const MAX_MODELS_PER_REQUEST = 3;

export class QuotaError extends Error {}

class RetryableRouteError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function isExplicitlyFree(id = "") {
  const value = String(id).trim();
  return value === "openrouter/free" || value.endsWith(":free");
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Never trust an old AI_MODEL/AI_MODELS value blindly. Paid slugs are discarded.
let freeModels = [...new Set(AI_MODELS.filter(isExplicitlyFree))];
let initPromise = null;
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
  routeBatchesTried: 0,
};

function score(id) {
  const i = PREFERRED.findIndex((p) => id.toLowerCase().includes(p));
  return i === -1 ? PREFERRED.length : i;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

async function discoverFreeModels() {
  const res = await fetch(`${API}/models`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OpenRouter models list returned ${res.status}`);
  const data = await res.json();

  return (data?.data || [])
    .filter((m) => {
      const id = String(m.id || "");
      const promptPrice = Number(m.pricing?.prompt);
      const completionPrice = Number(m.pricing?.completion);
      const zeroPriced = promptPrice === 0 && completionPrice === 0;
      const free = id.endsWith(":free") || zeroPriced;
      const outputs = m.architecture?.output_modalities;
      const textOut = !Array.isArray(outputs) || outputs.includes("text");
      return free && textOut && !EXCLUDED.test(id) && (m.context_length || 0) >= 16000 && id !== "openrouter/free";
    })
    .sort((a, b) => score(a.id) - score(b.id) || (b.context_length || 0) - (a.context_length || 0))
    .slice(0, 8)
    .map((m) => m.id);
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
    .replace(/^[\s\S]*<\/think>/i, "")
    .trim();
}

async function requestBatch(models, { messages, temperature, maxTokens }) {
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Narges Koochooloo Telegram Bot",
    },
    body: JSON.stringify({
      models,
      messages,
      temperature,
      top_p: 0.92,
      max_tokens: maxTokens,
      provider: { allow_fallbacks: true },
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_SECONDS * 1000),
  });

  if (res.status === 429) {
    metrics.rateLimits++;
    const body = (await res.text()).slice(0, 700);
    throw new RetryableRouteError(`429: ${body}`, 429);
  }

  if ([404, 408, 500, 502, 503, 504].includes(res.status)) {
    metrics.providerErrors++;
    const body = (await res.text()).slice(0, 700);
    throw new RetryableRouteError(`${res.status}: ${body}`, res.status);
  }

  if (res.status === 401 || res.status === 403) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`OpenRouter API key rejected (${res.status}): ${body}`);
  }

  if (res.status === 402) {
    const body = (await res.text()).slice(0, 700);
    markExhausted(utcDay());
    throw new QuotaError(`OpenRouter free allowance unavailable: ${body}`);
  }

  if (!res.ok) {
    const body = (await res.text()).slice(0, 700);
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }

  const data = await res.json();
  if (data?.error) throw new Error(JSON.stringify(data.error).slice(0, 500));

  const text = stripThinking(extractContent(data));
  if (!text) throw new RetryableRouteError("OpenRouter returned an empty response", 502);

  return { text, model: String(data.model || models[0]), usedPaid: false, usedWeb: false };
}

async function requestOpenRouter({ messages, temperature, maxTokens, countUsage = true }) {
  if (!freeModels.length) throw new Error("No free OpenRouter models are available");

  if (countUsage) {
    incrementUsage(utcDay());
    metrics.requests++;
  }

  const batches = chunk(freeModels, MAX_MODELS_PER_REQUEST);
  let lastRetryable = null;

  for (const models of batches) {
    metrics.routeBatchesTried++;
    try {
      const result = await requestBatch(models, { messages, temperature, maxTokens });
      if (countUsage) metrics.successes++;
      metrics.lastModel = result.model;
      metrics.lastError = null;
      return result;
    } catch (error) {
      if (error instanceof RetryableRouteError) {
        lastRetryable = error;
        metrics.lastError = error.message;
        continue;
      }
      metrics.lastError = error.message;
      throw error;
    }
  }

  globalCooldownUntil = Date.now() + 30_000;
  const reason = lastRetryable?.message || "all free model batches failed";
  throw new QuotaError(`All free OpenRouter routes failed: ${reason}`);
}

async function probeFreeConnection() {
  try {
    const result = await requestOpenRouter({
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      temperature: 0,
      maxTokens: 12,
      countUsage: false,
    });
    metrics.startupProbe = true;
    console.log(`✅ OpenRouter free AI connected: ${result.model}`);
    return result.model;
  } catch (error) {
    metrics.startupProbe = false;
    console.error(`❌ OpenRouter free AI probe failed: ${error.message}`);
    throw error;
  }
}

export function initModels() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is missing");

    if (!freeModels.length) {
      try {
        freeModels = await discoverFreeModels();
      } catch (error) {
        console.warn(`⚠️ Free model discovery failed: ${error.message}`);
        freeModels = [];
      }
    }

    if (!freeModels.includes("openrouter/free")) freeModels.push("openrouter/free");
    if (!freeModels.length) throw new Error("No free OpenRouter model found");

    console.log(`🤖 Free routes discovered: ${freeModels.join(" → ")}`);
    console.log(`🧩 Routing in batches of up to ${MAX_MODELS_PER_REQUEST} models per OpenRouter request`);
    await probeFreeConnection();
    return currentModels();
  })();
  return initPromise;
}

export function currentModels() {
  return [...freeModels];
}

export function budget() {
  const u = getUsage(utcDay());
  const remaining = u.exhausted ? 0 : Math.max(0, DAILY_AI_LIMIT - u.count);
  return { used: u.count, limit: DAILY_AI_LIMIT, remaining, exhausted: remaining === 0 };
}

// Kept for UI compatibility. This build can never route to a paid model.
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
  const { remaining } = budget();
  return kind === "direct" ? remaining > 0 : remaining > DIRECT_RESERVE;
}

export function aiMetrics() {
  return {
    ...metrics,
    cooldownSeconds: Math.max(0, Math.ceil((globalCooldownUntil - Date.now()) / 1000)),
  };
}

export async function chatCompletion(
  messages,
  { temperature = 0.7, maxTokens = 400, kind = "direct" } = {}
) {
  await initModels();
  if (!canSpend(kind)) throw new QuotaError("daily free-request budget reached");
  if (Date.now() < globalCooldownUntil && kind !== "direct") {
    throw new QuotaError("AI cooling down after a free-tier rate limit");
  }

  try {
    return await requestOpenRouter({ messages, temperature, maxTokens, countUsage: true });
  } catch (error) {
    if (!(error instanceof QuotaError)) {
      metrics.providerErrors++;
      metrics.lastError = error.message;
    }
    throw error;
  }
}
