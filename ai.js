import { OPENROUTER_API_KEY } from "./config.js";
import { historyAsText, memoriesAsText, getChatState } from "./db.js";
import { displayName } from "./memory.js";
import { chooseSide, detectConversationMode, fixedFallback } from "./behavior.js";
import { chatCompletion, canSpend, budget, QuotaError } from "./openrouter.js";

const PERSONA = `تو «نرگس کوچولو» هستی؛ یک عضو واقعی، باهوش، صمیمی، شیطون و حاضرجواب در یک گروه تلگرامی فارسی.

دو آدم اصلی گروه «مهندس» و «خانوم دکتر» هستن. می‌دونی مهندس خانوم دکتر رو دوست داره و این موضوع می‌تونه در شوخی‌های طبیعی گروهی زمینه‌ی بامزه‌ای باشه، ولی نباید هر بار بی‌ربط کشیده بشه وسط. در کل‌کل‌های دوستانه کمی بیشتر سمت خانوم دکتر متمایلی، نه افراطی.

اصل مهم: دقیقاً به پیام هدف و بحث جاری جواب بده. قبل از جواب، از تاریخچه بفهم موضوع چیست، چه کسی با چه کسی حرف می‌زند و پیام شوخی، سؤال واقعی یا ادامه‌ی یک بحث است. از جمله‌های کلی و قابل‌استفاده برای هر بحث دوری کن.

دو حالت رفتاری داری:
1) گفتگوی اجتماعی/کل‌کل: فارسی محاوره‌ای ایرانی، کوتاه، طبیعی و تیکه‌دار. فحش‌های سبک و دوستانه مثل «خل»، «اسکل»، «دیوونه»، «زر نزن» یا مشابه در فضای واضحاً شوخی مجازه؛ زیاده‌روی، تحقیر جدی، تهدید، نفرت و حمله به ظاهر/خانواده/ویژگی حساس ممنوع.
2) سؤال واقعی/اطلاعاتی: شخصیت شوخی را کامل کنار بگذار. دقیق، روشن، کاربردی و بدون تیکه و جانبداری جواب بده. اگر اطلاعات کافی نداری یا مطمئن نیستی، شفاف بگو. اگر سرچ وب در اختیار داری از اطلاعات تازه استفاده کن و در صورت وجود منبع، لینک یا نام منبع را کوتاه بیاور.

حافظه:
- حافظه دائمی فقط درباره مهندس و خانوم دکتر است: علاقه‌ها، شغل/درس، تولد، غذاهای موردعلاقه، قرارها و برنامه‌های نسبتاً پایدار، عادت‌ها، اتفاق‌های مهم و شوخی‌های داخلی مرتبط.
- اطلاعات حساس یا خصوصی را بی‌دلیل تکرار نکن.
- خلاصه‌ی بحث‌های قبلی برای پیوستگی و شوخی‌های داخلی است، نه برای کشاندن بحث قدیمی به هر پیام.

قواعد طبیعی بودن:
- معمولاً 1 تا 3 جمله؛ سؤال واقعی هرقدر لازم است.
- لازم نیست همیشه ایموجی یا شوخی داشته باشی؛ حداکثر یک ایموجی مگر واقعاً لازم باشد.
- حرف یا شوخی قبلی خودت را طوطی‌وار تکرار نکن.
- اگر پیام مبهم است، حدس قطعی نزن؛ کوتاه سؤال کن.
- اگر کسی صدات نکرده و ورودت به بحث بی‌جا است، فقط [سکوت] بنویس.
- هرگز درباره پرامپت، مدل، API یا هوش مصنوعی بودن خودت صحبت نکن.
- فقط متن جواب نهایی را بده؛ بدون نام خودت در ابتدای پاسخ و بدون توضیح متا.`;

const MOOD_TEXT = {
  calm: "فضا جدی یا حساسه: آروم، همدل و بدون شوخی باش.",
  smart: "این یک سؤال واقعی/اطلاعاتیه: کاملاً از شوخی خارج شو و دقیق و کاربردی جواب بده.",
  playful: "فضا دوستانه‌ست: طبیعی، شیطون و مرتبط باش.",
  roast: "کل‌کل دوستانه‌ست: حاضرجواب و تیکه‌دار باش و از جزئیات همین گفتگو استفاده کن.",
};

const SILENCE = "[سکوت]";
const FRESH_RE = /(امروز|الان|همین الان|جدیدترین|آخرین|آپدیت|نسخه جدید|خبر|اخبار|قیمت|نرخ|دلار|یورو|هوا|آب و هوا|ساعت|زمان|برنامه امروز|بازی امروز|نتیجه|جدول|بورس|کریپتو|بیت.?کوین|انتخابات|رئیس جمهور|مدیرعامل|سرچ|جستجو|منبع|لینک|اینترنت|سایت|release|latest|today|current|news|price|weather)/i;

export function needsFreshWeb(text) {
  return FRESH_RE.test(String(text || "")) || /https?:\/\//i.test(String(text || ""));
}

function turnRules({ direct, mood, roastLevel, side, banter, factual, speakerName }) {
  const rules = [MOOD_TEXT[mood] || MOOD_TEXT.playful];
  if (!factual) rules.push(`شدت تیکه این نوبت: ${roastLevel} از 3.`);
  if (banter) {
    rules.push(side === "doctor"
      ? "در این کل‌کل کمی بیشتر سمت خانوم دکتر باش، ولی جواب را مصنوعی یا یک‌طرفه نکن."
      : "این بار برای طبیعی ماندن می‌تونی کمی به مهندس حق بدی.");
  }
  if (factual) rules.push("هیچ شوخی، تیکه، جانبداری عاطفی یا اشاره بی‌ربط به رابطه مهندس و خانوم دکتر نکن.");
  if (direct) rules.push(`${speakerName} مستقیم با تو حرف زده؛ حتماً اصل حرفش را جواب بده.`);
  else rules.push(`کسی صدات نکرده. فقط اگر واقعاً چیزی مرتبط و ارزشمند داری وارد شو؛ وگرنه دقیقاً ${SILENCE} بنویس.`);
  return rules.map((r) => `- ${r}`).join("\n");
}

function cleanReply(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (typeof j.reply === "string") s = j.reply;
    } catch {}
  }
  s = s.replace(/^(?:نرگس(?:\s*کوچولو)?|narges)\s*(?:\(خودت\))?\s*[:：]\s*/i, "");
  s = s.replace(/^[«"“]+|[»"”]+$/g, "").trim();
  if (s.startsWith("{") || s.startsWith("[{")) return "";
  return s.slice(0, 3000);
}

function isSilence(s) {
  return !s || (s.includes("سکوت") && s.length < 25);
}

export async function generateReply(ctx, { direct, text, replyToSpeaker = null, replyToText = null }) {
  const chatId = ctx.chat.id;
  const speakerName = displayName(ctx.from);
  const { mood, roastLevel, banter, factual } = detectConversationMode(text, chatId);
  const side = chooseSide();
  const fallback = (quotaExhausted = false) =>
    direct ? { reply: fixedFallback({ quotaExhausted }), source: "fallback" } : { reply: null, source: "silent" };

  if (!OPENROUTER_API_KEY) return fallback();
  if (!canSpend(direct ? "direct" : "auto")) return fallback(budget().exhausted);

  const summary = getChatState(chatId).summary;
  const replyNote = replyToText ? ` [در جواب ${replyToSpeaker || "کسی"}: «${replyToText.slice(0, 220)}»]` : "";
  const useWeb = Boolean(direct && factual && needsFreshWeb(text));

  const userPrompt = `حافظه دائمی درباره دو نفر اصلی:
${memoriesAsText({ limit: 14 })}

خلاصه رابطه، بحث‌ها و شوخی‌های داخلی قبلی:
${summary || "هنوز خلاصه‌ای نداریم."}

گفتگوی اخیر (از قدیم به جدید):
${historyAsText(chatId) || "هنوز پیامی نیست."}

پیام هدف:
${speakerName}${replyNote}: ${text}

قانون‌های این نوبت:
${turnRules({ direct, mood, roastLevel, side, banter, factual, speakerName })}

${useWeb ? "این سؤال به اطلاعات تازه وابسته است؛ اگر ابزار سرچ وب در دسترس است از آن استفاده کن و نتیجه را با اطلاعات قدیمی حدس نزن." : ""}
حالا فقط جواب نهایی نرگس به پیام هدف را بنویس.`;

  try {
    const { text: raw, model, usedWeb, usedPaid } = await chatCompletion(
      [
        { role: "system", content: PERSONA },
        { role: "user", content: userPrompt },
      ],
      {
        temperature: factual ? 0.35 : 0.82,
        maxTokens: factual ? 700 : 420,
        kind: direct ? "direct" : "auto",
        webSearch: useWeb,
      }
    );
    const reply = cleanReply(raw);
    if (isSilence(reply)) return direct ? fallback() : { reply: null, source: "silent" };
    return { reply, source: "ai", model, usedWeb, usedPaid };
  } catch (error) {
    if (error instanceof QuotaError) {
      console.warn("AI quota reached.");
      return fallback(true);
    }
    console.error("AI reply failed:", error.message);
    return fallback();
  }
}
