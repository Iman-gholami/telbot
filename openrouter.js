import {
  OPENROUTER_API_KEY,
  AI_MODELS,
  AI_TIMEOUT_SECONDS,
  DAILY_AI_LIMIT,
  DIRECT_RESERVE,
  PAID_FALLBACK_MODEL,
  MONTHLY_AI_BUDGET_USD,
  PAID_INPUT_USD_PER_M,
  PAID_OUTPUT_USD_PER_M,
  WEB_SEARCH_ENABLED,
  WEB_SEARCH_ENGINE,
  WEB_SEARCH_ESTIMATED_COST_USD,
} from "./config.js";
import {
  getUsage,
  incrementUsage,
  markExhausted,
  getMonthlySpend,
  addMonthlySpend,
  getSetting,
} from "./db.js";

const API = "https://openrouter.ai/api/v1";
const PREFERRED = ["qwen", "deepseek", "gemma", "mistral", "llama", "glm", "kimi"];
const EXCLUDED = /(vision|-vl|image|embed|guard|audio|tts|ocr|coder|math)/i;

export class QuotaError extends Error {}

let freeModels = [...AI_MODELS];
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
};

function boolSetting(key, fallback) {
  const value = String(getSetting(key, fallback ? "1" : "0")).toLowerCase();
  return ["1", "true", "on", "yes"].includes(value);
}
function score(id) {
  const i = PREFERRED.findIndex((p) => id.toLowerCase().includes(p));
  return i === -1 ? PREFERRED.length : i;
}
function utcDay() { return new Date().toISOString().slice(0, 10); }
function utcMonth() { return new Date().toISOString().slice(0, 7); }

async function discoverFreeModels() {
  const res = await fetch(`${API}/models`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`models list ${res.status}`);
  const data = await res.json();
  return (data?.data || [])
    .filter((m) => {
      const id = String(m.id || "");
      const free = id.endsWith(":free") || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
      const outputs = m.architecture?.output_modalities;
      const textOut = !Array.isArray(outputs) || outputs.includes("text");
      return free && textOut && !EXCLUDED.test(id) && (m.context_length || 0) >= 16000 && id !== "openrouter/free";
    })
    .sort((a, b) => score(a.id) - score(b.id) || (b.context_length || 0) - (a.context_length || 0))
    .slice(0, 5)
    .map((m) => m.id);
}

export function initModels() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!OPENROUTER_API_KEY) return [];
    if (!freeModels.length) {
      try { freeModels = await discoverFreeModels(); }
      catch (error) {
        console.error("Free model discovery failed:", error.message);
        freeModels = [];
      }
    }
    if (!freeModels.includes("openrouter/free")) freeModels.push("openrouter/free");
    return currentModels();
  })();
  return initPromise;
}

export function currentModels() {
  const paidEnabled = boolSetting("paid_fallback", true) && MONTHLY_AI_BUDGET_USD > 0;
  return [...freeModels, ...(paidEnabled && PAID_FALLBACK_MODEL ? [`${PAID_FALLBACK_MODEL} (paid fallback)`] : [])];
}

export function budget() {
  const u = getUsage(utcDay());
  const remaining = u.exhausted ? 0 : Math.max(0, DAILY_AI_LIMIT - u.count);
  return { used: u.count, limit: DAILY_AI_LIMIT, remaining, exhausted: remaining === 0 };
}

export function monthlyBudget() {
  const spent = getMonthlySpend(utcMonth());
  const remainingUsd = Math.max(0, MONTHLY_AI_BUDGET_USD - Number(spent.usd || 0));
  return {
    month: utcMonth(),
    spentUsd: Number(spent.usd || 0),
    limitUsd: MONTHLY_AI_BUDGET_USD,
    remainingUsd,
    paidRequests: Number(spent.paid_requests || 0),
    webRequests: Number(spent.web_requests || 0),
  };
}

export function canSpend(kind = "direct") {
  const { remaining } = budget();
  return kind === "direct" ? remaining > 0 : remaining > DIRECT_RESERVE;
}

function extractContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  return "";
}

export function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "")
    .trim();
}

function estimatedPaidCost(messages, maxTokens) {
  const chars = messages.reduce((n, m) => n + String(m?.content || "").length, 0);
  const estimatedInputTokens = Math.ceil(chars / 2.5);
  return (estimatedInputTokens * PAID_INPUT_USD_PER_M + maxTokens * PAID_OUTPUT_USD_PER_M) / 1_000_000;
}

function recordCost(data, { usedPaid, usedWeb, estimatedFallbackCost }) {
  const apiCost = Number(data?.usage?.cost);
  let cost = Number.isFinite(apiCost) && apiCost >= 0 ? apiCost : 0;
  if (!cost && usedPaid) {
    const prompt = Number(data?.usage?.prompt_tokens || 0);
    const completion = Number(data?.usage?.completion_tokens || 0);
    cost = prompt || completion
      ? (prompt * PAID_INPUT_USD_PER_M + completion * PAID_OUTPUT_USD_PER_M) / 1_000_000
      : estimatedFallbackCost;
  }
  // Conservative accounting: reserve web-search cost separately so the local $1 cap is never optimistic.
  if (usedWeb) cost += WEB_SEARCH_ESTIMATED_COST_USD;
  if (cost > 0 || usedPaid || usedWeb) addMonthlySpend(utcMonth(), cost, { paid: usedPaid, web: usedWeb });
}

function paidAllowed(kind, messages, maxTokens, webSearch) {
  if (kind !== "direct") return false;
  if (!PAID_FALLBACK_MODEL || !boolSetting("paid_fallback", true)) return false;
  const m = monthlyBudget();
  const estimate = estimatedPaidCost(messages, maxTokens) + (webSearch ? WEB_SEARCH_ESTIMATED_COST_USD : 0);
  return m.remainingUsd > estimate + 0.0001;
}

export function aiMetrics() {
  return { ...metrics, cooldownSeconds: Math.max(0, Math.ceil((globalCooldownUntil - Date.now()) / 1000)) };
}

export async function chatCompletion(
  messages,
  { temperature = 0.7, maxTokens = 400, maxAttempts = 5, kind = "direct", webSearch = false } = {}
) {
  await initModels();
  if (!OPENROUTER_API_KEY) throw new Error("OpenRouter API key missing");
  if (!canSpend(kind)) throw new QuotaError("daily budget reached");
  if (Date.now() < globalCooldownUntil && kind !== "direct") throw new Error("AI temporarily cooling down after rate limit");

  const webEnabled = Boolean(webSearch && WEB_SEARCH_ENABLED && boolSetting("web_search", true));
  const allowPaid = paidAllowed(kind, messages, maxTokens, webEnabled);
  const candidates = [...freeModels.slice(0, Math.max(1, maxAttempts))];
  if (allowPaid && !candidates.includes(PAID_FALLBACK_MODEL)) candidates.push(PAID_FALLBACK_MODEL);
  if (!candidates.length) throw new Error("No AI model available");

  incrementUsage(utcDay());
  metrics.requests++;

  const body = {
    models: candidates,
    messages,
    temperature,
    top_p: 0.92,
    max_tokens: maxTokens,
    provider: { allow_fallbacks: true },
  };
  if (webEnabled) {
    body.tools = [{ type: "openrouter:web_search", parameters: { engine: WEB_SEARCH_ENGINE, max_results: 4 } }];
    body.max_tool_calls = 1;
  }

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
    metrics.providerErrors++;
    metrics.lastError = error.message;
    throw error;
  }

  if (res.status === 429) {
    metrics.rateLimits++;
    globalCooldownUntil = Date.now() + 30_000;
    const text = (await res.text()).slice(0, 700);
    metrics.lastError = `429: ${text}`;
    throw new Error(`OpenRouter 429 after fallbacks: ${text}`);
  }
  if (res.status === 402) {
    const text = (await res.text()).slice(0, 700);
    markExhausted(utcDay());
    metrics.lastError = `402: ${text}`;
    throw new QuotaError(text);
  }
  if (!res.ok) {
    metrics.providerErrors++;
    const text = (await res.text()).slice(0, 700);
    metrics.lastError = `${res.status}: ${text}`;
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data?.error) {
    metrics.providerErrors++;
    metrics.lastError = JSON.stringify(data.error).slice(0, 500);
    throw new Error(metrics.lastError);
  }

  const text = stripThinking(extractContent(data));
  if (!text) throw new Error("AI returned empty response");

  const servedModel = String(data.model || candidates[0]);
  const usedPaid = servedModel === PAID_FALLBACK_MODEL || servedModel.startsWith(`${PAID_FALLBACK_MODEL}:`);
  if (usedPaid) metrics.paidFallbacks++;
  if (webEnabled) metrics.webSearches++;
  metrics.successes++;
  metrics.lastModel = servedModel;
  metrics.lastError = null;

  recordCost(data, {
    usedPaid,
    usedWeb: webEnabled,
    estimatedFallbackCost: estimatedPaidCost(messages, maxTokens),
  });

  return { text, model: servedModel, usedPaid, usedWeb: webEnabled };
}
