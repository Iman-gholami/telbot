import { DIGEST_EVERY, DIGEST_IDLE_SECONDS, OPENROUTER_API_KEY } from "./config.js";
import {
  getChatState,
  setChatState,
  messagesAfter,
  countMessagesAfter,
  formatMessages,
  memoriesAsText,
  updateMemory,
  deleteMemory,
  MEMORY_SUBJECTS,
} from "./db.js";
import { saveLongTermMemory, normalizeMemory, looksSensitive } from "./memory.js";
import { chatCompletion, canSpend } from "./openrouter.js";

const timers = new Map();
const running = new Set();

const DIGEST_PROMPT = `تو بخش حافظه‌ی «نرگس کوچولو» هستی؛ یه عضو شوخ یه گروه تلگرامی فارسی.
کارت دو چیزه:

1) summary: خلاصه قبلی رو با پیام‌های جدید ترکیب کن و یه خلاصه فشرده (حداکثر 10 خط کوتاه) بنویس از: موضوع‌ها و اتفاق‌های مهم، برنامه‌ها و قرارها، بحث‌های باز، شوخی‌ها و تیکه‌کلام‌های داخلی. چیزهای کم‌اهمیت و قدیمی رو حذف کن. فارسی بنویس.

2) واقعیت‌های پایدار درباره آدم‌ها:
- subject: "engineer" برای مهندس، "doctor" برای خانوم دکتر، "group" برای کل گروه یا شوخی‌های داخلی.
- فقط چیزی که مستقیم از پیام‌ها معلومه و بعداً هم مفیده: علایق، سلیقه‌ها، کار و درس، عادت‌ها، اتفاق‌های مهم زندگی، شوخی‌های تکرارشونده.
- حدس، برداشت شخصیتی، حال لحظه‌ای («امروز خسته‌ست») و اطلاعات حساس (رمز، مالی، آدرس، شماره، مسائل پزشکی خصوصی) ممنوع.
- حرف‌های خود نرگس منبع واقعیت نیستن.
- اگه واقعیت جدید با یه حافظه قبلی تناقض داره یا کامل‌ترش می‌کنه، از update با id همون حافظه استفاده کن. اگه حافظه‌ای دیگه درست نیست، id‌ش رو در remove بذار.
- هر fact یه جمله کوتاه سوم‌شخص باشه، مثلاً: «مهندس عاشق قرمه‌سبزیه».
- اگه چیز جدیدی نیست، آرایه‌ها رو خالی بذار.

خروجی فقط یه JSON معتبر، بدون هیچ متن دیگه:
{"summary":"...","add":[{"subject":"engineer","fact":"...","importance":2}],"update":[{"id":0,"fact":"..."}],"remove":[]}`;

function parseJson(raw) {
  const clean = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  for (const candidate of [clean, first >= 0 && last > first ? clean.slice(first, last + 1) : null]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // next
    }
  }
  return null;
}

function validFact(f) {
  return typeof f === "string" && f.trim().length >= 5 && f.length <= 300 && !looksSensitive(f);
}

async function runDigest(chatId) {
  timers.delete(chatId);
  if (running.has(chatId) || !OPENROUTER_API_KEY || !canSpend("background")) return;
  running.add(chatId);

  try {
    const state = getChatState(chatId);
    const rows = messagesAfter(chatId, state.digested_until, 150);
    if (rows.length < 10) return;
    const lastId = rows[rows.length - 1].id;

    const userPrompt = `خلاصه قبلی:
${state.summary || "(خالی)"}

حافظه‌های فعلی ([id] متن):
${memoriesAsText({ withIds: true, limit: 25 })}

پیام‌های جدید:
${formatMessages(rows, { selfLabel: "نرگس" })}`;

    let parsed = null;
    try {
      const { text } = await chatCompletion(
        [
          { role: "system", content: DIGEST_PROMPT },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.2, maxTokens: 1200, maxAttempts: 1, kind: "background" }
      );
      parsed = parseJson(text);
    } catch (error) {
      console.error("Digest failed:", error.message);
    }

    // حتی اگه شکست خورد جلو می‌ریم تا سهمیه روزانه سر یه دسته پیام هدر نره
    if (!parsed) {
      setChatState(chatId, { summary: state.summary, digestedUntil: lastId });
      return;
    }

    const summary = typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 1500)
      : state.summary;
    setChatState(chatId, { summary, digestedUntil: lastId });

    let added = 0;
    for (const item of (Array.isArray(parsed.add) ? parsed.add : []).slice(0, 5)) {
      if (!MEMORY_SUBJECTS.includes(item?.subject) || !validFact(item?.fact)) continue;
      const importance = Math.max(1, Math.min(3, Number(item.importance) || 2));
      if (saveLongTermMemory(item.subject, item.fact.trim(), { importance, source: "digest" })) added++;
    }
    for (const item of (Array.isArray(parsed.update) ? parsed.update : []).slice(0, 5)) {
      if (Number.isInteger(item?.id) && validFact(item?.fact)) {
        updateMemory(item.id, item.fact.trim(), normalizeMemory(item.fact));
      }
    }
    for (const id of (Array.isArray(parsed.remove) ? parsed.remove : []).slice(0, 5)) {
      if (Number.isInteger(id)) deleteMemory(id);
    }

    console.log(`🧠 Digest for ${chatId}: ${rows.length} messages, ${added} new memories`);
  } finally {
    running.delete(chatId);
  }
}

// بعد از هر پیام صدا زده می‌شود؛ وقتی به اندازه کافی پیام جمع شد و گروه کمی ساکت شد، خلاصه‌سازی انجام می‌شود
export function scheduleDigest(chatId) {
  const key = String(chatId);
  const { digested_until } = getChatState(key);
  if (countMessagesAfter(key, digested_until) < DIGEST_EVERY) return;

  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => runDigest(key).catch((e) => console.error("Digest error:", e)), DIGEST_IDLE_SECONDS * 1000)
  );
}
