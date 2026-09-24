import {
  OPENROUTER_API_KEY,
  AI_MODELS,
  AI_TIMEOUT_SECONDS,
  DAILY_AI_LIMIT,
  DIRECT_RESERVE,
} from "./config.js";
import { getUsage, incrementUsage, markExhausted } from "./db.js";

const API = "https://openrouter.ai/api/v1";
const PREFERRED = ["mistral", "gemma", "llama", "qwen", "deepseek", "minimax", "glm", "nvidia", "kimi"];
const EXCLUDED = /(vision|-vl|image|embed|guard|safety|moderation|audio|tts|ocr|coder|math|reasoning|thinking|reasoner|r1)/i;

export class QuotaError extends Error {}
class RetryableRouteError extends Error {}

let freeModels = [...new Set(
  AI_MODELS.filter((id) => (id === "openrouter/free" || id.endsWith(":free")) && !EXCLUDED.test(id))
)];
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
  routeAttempts: 0,
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
      const free = id.endsWith(":free") || (promptPrice === 0 && completionPrice === 0);
      const outputs = m.architecture?.output_modalities;
      const textOut = !Array.isArray(outputs) || outputs.includes("text");
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      const structured = params.includes("response_format");
      return free && textOut && structured && !EXCLUDED.test(id) &&
        (m.context_length || 0) >= 16000 && id !== "openrouter/free";
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
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "")
    .replace(/^[\s\S]*<\/analysis>/i, "")
    .trim();
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function requestModel(model, { messages, temperature, maxTokens, jsonMode }) {
  metrics.routeAttempts++;

  const body = {
    model,
    messages,
    temperature,
    top_p: 0.92,
    max_tokens: maxTokens,
    reasoning: { exclude: true },
    provider: {
      allow_fallbacks: true,
      require_parameters: Boolean(jsonMode),
    },
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
      signal: AbortSignal.timeout(AI_TIMEOUT_SECONDS * 1000),
    });
  } catch (error) {
    throw new RetryableRouteError(`${model}: ${error.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`OpenRouter API key rejected (${res.status}): ${text}`);
  }

  if (res.status === 402) {
    const text = (await res.text()).slice(0, 700);
    markExhausted(utcDay());
    throw new QuotaError(`OpenRouter free allowance unavailable: ${text}`);
  }

  if (res.status === 429) {
    metrics.rateLimits++;
    const text = (await res.text()).slice(0, 500);
    throw new RetryableRouteError(`${model} -> 429: ${text}`);
  }

  if (!res.ok) {
    metrics.providerErrors++;
    const text = (await res.text()).slice(0, 500);
    // 400 is retryable here: some free providers advertise a parameter but reject it at runtime.
    if ([400, 404, 408, 422, 500, 502, 503, 504].includes(res.status)) {
      throw new RetryableRouteError(`${model} -> ${res.status}: ${text}`);
    }
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data?.error) throw new RetryableRouteError(`${model}: ${JSON.stringify(data.error).slice(0, 450)}`);

  const text = stripThinking(extractContent(data));
  if (!text) throw new RetryableRouteError(`${model}: empty response`);

  if (jsonMode && !parseJsonObject(text)) {
    throw new RetryableRouteError(`${model}: non-JSON output rejected`);
  }

  return {
    text,
    model: String(data.model || model),
    usedPaid: false,
    usedWeb: false,
  };
}

async function requestOpenRouter({
  messages,
  temperature,
  maxTokens,
  countUsage = true,
  jsonMode = true,
  excludeModels = [],
}) {
  if (!freeModels.length) throw new Error("No free OpenRouter models are available");

  if (countUsage) {
    incrementUsage(utcDay());
    metrics.requests++;
  }

  const excluded = new Set(excludeModels.map(String));
  const candidates = freeModels.filter((m) => !excluded.has(m));
  let lastRetryable = null;

  for (const model of candidates) {
    try {
      const result = await requestModel(model, { messages, temperature, maxTokens, jsonMode });
      if (countUsage) metrics.successes++;
      metrics.lastModel = result.model;
      metrics.lastError = null;
      return result;
    } catch (error) {
      if (error instanceof RetryableRouteError) {
        lastRetryable = error;
        metrics.lastError = error.message;
        console.warn(`↪️ Free route skipped: ${error.message}`);
        continue;
      }
      metrics.lastError = error.message;
      throw error;
    }
  }

  globalCooldownUntil = Date.now() + 30_000;
  throw new QuotaError(`All free OpenRouter routes failed: ${lastRetryable?.message || "no compatible route"}`);
}

async function probeFreeConnection() {
  const result = await requestOpenRouter({
    messages: [
      { role: "system", content: 'Return only JSON: {"reply":"OK"}' },
      { role: "user", content: "Return OK." },
    ],
    temperature: 0,
    maxTokens: 30,
    countUsage: false,
    jsonMode: true,
  });
  metrics.startupProbe = true;
  console.log(`✅ OpenRouter free AI connected: ${result.model}`);
  return result.model;
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

    // Final free router fallback. require_parameters=true still prevents incompatible providers.
    if (!freeModels.includes("openrouter/free")) freeModels.push("openrouter/free");
    if (!freeModels.length) throw new Error("No free OpenRouter model found");

    console.log(`🤖 Structured free routes: ${freeModels.join(" → ")}`);
    console.log("🧩 Routing model-by-model; invalid/meta-shaped output can be rejected and retried.");
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
  {
    temperature = 0.7,
    maxTokens = 400,
    kind = "direct",
    jsonMode = true,
    excludeModels = [],
  } = {}
) {
  await initModels();
  if (!canSpend(kind)) throw new QuotaError("daily free-request budget reached");
  if (Date.now() < globalCooldownUntil && kind !== "direct") {
    throw new QuotaError("AI cooling down after a free-tier rate limit");
  }

  return requestOpenRouter({
    messages,
    temperature,
    maxTokens,
    countUsage: true,
    jsonMode,
    excludeModels,
  });
}
