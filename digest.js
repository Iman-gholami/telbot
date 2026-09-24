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

const DIGEST_PROMPT = `تو موتور حافظه‌ی «نرگس کوچولو» هستی. وظیفه‌ات اینه که از گفتگو فقط چیزهایی رو نگه داری که بعداً واقعاً به طبیعی‌تر شدن رابطه کمک می‌کنه.

خروجی دو بخش دارد:
1) summary: خلاصه‌ی فشرده و به‌روز از رابطه و بحث‌ها، حداکثر 12 خط کوتاه. شامل موضوع‌های باز، قرارها و برنامه‌ها، اتفاق‌های بامزه، شوخی‌های داخلی و چیزهایی که برای ادامه‌ی گفتگو مهم‌اند. جزئیات کم‌ارزش و قدیمی را حذف کن.
2) حافظه دائمی فقط برای دو subject مجاز است: "engineer" و "doctor".

چه چیزهایی ارزش حافظه دارند:
- علایق و سلیقه‌ها
- شغل، درس و زمینه‌های کاری
- تاریخ تولد یا تاریخ‌های مهمی که خودشان صریح گفته‌اند
- غذاها و چیزهای موردعلاقه
- عادت‌های نسبتاً پایدار
- قرارها یا برنامه‌های مهمی که احتمالاً بعداً به آن برمی‌گردند
- اتفاق‌های بامزه یا شوخی داخلی مرتبط با مهندس/خانوم دکتر
- واقعیت رابطه‌ای روشن؛ مثلاً اگر از خود گفتگو معلوم است مهندس خانوم دکتر را دوست دارد

قواعد حافظه هوشمند:
- حال لحظه‌ای، حدس شخصیتی، شایعه، برداشت خودت یا حرف خود نرگس را واقعیت حساب نکن.
- اطلاعات حساس مثل رمز، مالی، آدرس دقیق، شماره تماس و مسائل پزشکی خصوصی را ذخیره نکن.
- اگر واقعیت جدید نسخه کامل‌تر یا جدیدتر یک حافظه موجود است، update کن نه add.
- اگر واقعیت جدید صریحاً حافظه قبلی را نقض می‌کند، حافظه قبلی را update یا remove کن.
- موارد مشابه را ادغام کن؛ از چند حافظه تکراری پرهیز کن.
- شوخی مشترکی که به هیچ‌کدام مشخصاً تعلق ندارد فقط در summary بماند، نه در حافظه دائمی.

خروجی فقط JSON معتبر:
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
    } catch {}
  }
  return null;
}

function validFact(f) {
  return typeof f === "string" && f.trim().length >= 5 && f.length <= 340 && !looksSensitive(f);
}

async function runDigest(chatId) {
  timers.delete(chatId);
  if (running.has(chatId) || !OPENROUTER_API_KEY || !canSpend("background")) return;
  running.add(chatId);

  try {
    const state = getChatState(chatId);
    const rows = messagesAfter(chatId, state.digested_until, 170);
    if (rows.length < 10) return;
    const lastId = rows[rows.length - 1].id;

    const userPrompt = `خلاصه قبلی:
${state.summary || "(خالی)"}

حافظه‌های فعلی ([id] متن):
${memoriesAsText({ withIds: true, limit: 30 })}

پیام‌های جدید:
${formatMessages(rows, { selfLabel: "نرگس" })}`;

    let parsed = null;
    try {
      const { text } = await chatCompletion(
        [
          { role: "system", content: DIGEST_PROMPT },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.15, maxTokens: 1100, maxAttempts: 3, kind: "background" }
      );
      parsed = parseJson(text);
    } catch (error) {
      console.error("Digest failed:", error.message);
    }

    if (!parsed) {
      setChatState(chatId, { summary: state.summary, digestedUntil: lastId });
      return;
    }

    const summary = typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 1800)
      : state.summary;
    setChatState(chatId, { summary, digestedUntil: lastId });

    let added = 0;
    for (const item of (Array.isArray(parsed.add) ? parsed.add : []).slice(0, 6)) {
      if (!MEMORY_SUBJECTS.includes(item?.subject) || !validFact(item?.fact)) continue;
      const importance = Math.max(1, Math.min(3, Number(item.importance) || 2));
      if (saveLongTermMemory(item.subject, item.fact.trim(), { importance, source: "digest" })) added++;
    }
    for (const item of (Array.isArray(parsed.update) ? parsed.update : []).slice(0, 6)) {
      if (Number.isInteger(item?.id) && validFact(item?.fact)) {
        updateMemory(item.id, item.fact.trim(), normalizeMemory(item.fact));
      }
    }
    for (const id of (Array.isArray(parsed.remove) ? parsed.remove : []).slice(0, 6)) {
      if (Number.isInteger(id)) deleteMemory(id);
    }

    console.log(`🧠 Digest for ${chatId}: ${rows.length} messages, ${added} new memories`);
  } finally {
    running.delete(chatId);
  }
}

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
