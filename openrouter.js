import {
  OPENROUTER_API_KEY,
  AI_MODELS,
  AI_TIMEOUT_SECONDS,
  DAILY_AI_LIMIT,
  DIRECT_RESERVE,
} from "./config.js";
import { getUsage, incrementUsage, markExhausted } from "./db.js";

const API = "https://openrouter.ai/api/v1";

// خانواده‌هایی که معمولاً فارسی بهتری دارند؛ به ترتیب اولویت
const PREFERRED = ["deepseek", "qwen", "gemma", "gpt-oss", "llama", "mistral", "glm", "kimi"];
const EXCLUDED = /(vision|-vl|image|embed|guard|audio|tts|ocr|coder|math)/i;

export class QuotaError extends Error {}

let models = [...AI_MODELS];
let initPromise = null;

function score(id) {
  const i = PREFERRED.findIndex((p) => id.toLowerCase().includes(p));
  return i === -1 ? PREFERRED.length : i;
}

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
    .slice(0, 4)
    .map((m) => m.id);
}

export function initModels() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!OPENROUTER_API_KEY || AI_MODELS.length) return models;
    try {
      models = await discoverFreeModels();
    } catch (error) {
      console.error("Free model discovery failed:", error.message);
      models = [];
    }
    if (!models.includes("openrouter/free")) models.push("openrouter/free");
    return models;
  })();
  return initPromise;
}

export function currentModels() {
  return [...models];
}

// مدلی که خطا داده به ته صف می‌رود
function demote(model) {
  const i = models.indexOf(model);
  if (i >= 0 && models.length > 1) {
    models.splice(i, 1);
    models.push(model);
  }
}

function utcDay() {
  return new Date().toISOString().slice(0, 10); // سهمیه OpenRouter با UTC ریست می‌شود
}

export function budget() {
  const u = getUsage(utcDay());
  const remaining = u.exhausted ? 0 : Math.max(0, DAILY_AI_LIMIT - u.count);
  return { used: u.count, limit: DAILY_AI_LIMIT, remaining, exhausted: remaining === 0 };
}

// کارهای غیرضروری (ورود خودکار، حافظه) فقط وقتی انجام می‌شوند که سهم جواب‌های مستقیم محفوظ بماند
export function canSpend(kind = "direct") {
  const { remaining } = budget();
  return kind === "direct" ? remaining > 0 : remaining > DIRECT_RESERVE;
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

export async function chatCompletion(
  messages,
  { temperature = 0.7, maxTokens = 400, maxAttempts = 2, kind = "direct" } = {}
) {
  await initModels();
  let lastError = null;
  const candidates = models.slice(0, maxAttempts);

  for (const model of candidates) {
    if (!canSpend(kind)) throw new QuotaError("daily budget reached");
    incrementUsage(utcDay());

    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "X-Title": "Narges Koochooloo Telegram Bot",
        },
        body: JSON.stringify({ model, messages, temperature, top_p: 0.9, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(AI_TIMEOUT_SECONDS * 1000),
      });

      if (res.status === 429 || res.status === 402) {
        const body = (await res.text()).slice(0, 500);
        if (res.status === 402 || /per[- ]?day|daily/i.test(body)) {
          markExhausted(utcDay());
          throw new QuotaError(body);
        }
        lastError = new Error(`${model} -> 429: ${body}`);
        demote(model);
        continue;
      }

      if (!res.ok) {
        lastError = new Error(`${model} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
        demote(model);
        continue;
      }

      const data = await res.json();
      if (data?.error) {
        lastError = new Error(`${model} -> ${JSON.stringify(data.error).slice(0, 300)}`);
        demote(model);
        continue;
      }

      const text = stripThinking(extractContent(data));
      if (!text) {
        lastError = new Error(`${model} -> empty response`);
        demote(model);
        continue;
      }

      return { text, model: data.model || model };
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      lastError = error;
      demote(model);
    }
  }

  throw lastError || new Error("No AI model available");
}
