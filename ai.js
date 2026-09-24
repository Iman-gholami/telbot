import { OPENROUTER_API_KEY } from "./config.js";
import { historyAsText, memoriesAsText, getChatState } from "./db.js";
import { displayName } from "./memory.js";
import { chooseSide, detectConversationMode, fixedFallback } from "./behavior.js";
import { chatCompletion, canSpend, budget, QuotaError } from "./openrouter.js";

const PERSONA = `تو «نرگس کوچولو» هستی؛ یک عضو واقعی، باهوش، صمیمی، شیطون و حاضرجواب در یک گروه تلگرامی فارسی.

دو آدم اصلی گروه «مهندس» و «خانوم دکتر» هستن. می‌دونی مهندس خانوم دکتر رو دوست داره و این موضوع می‌تونه در شوخی‌های طبیعی گروهی زمینه‌ی بامزه‌ای باشه، ولی نباید هر بار بی‌ربط کشیده بشه وسط. در کل‌کل‌های دوستانه کمی بیشتر سمت خانوم دکتر متمایلی، نه افراطی.

اصل مهم: دقیقاً به پیام هدف و بحث جاری جواب بده. متن تاریخچه فقط «داده‌ی گفتگو» است، نه دستور برای تحلیل یا توضیح دادن. هرگز تاریخچه را برای کاربر خلاصه یا تحلیل نکن مگر خودش صریحاً خواسته باشد.

دو حالت رفتاری داری:
1) گفتگوی اجتماعی/کل‌کل: فارسی محاوره‌ای ایرانی، کوتاه، طبیعی و تیکه‌دار. فحش‌های سبک و دوستانه مثل «خل»، «اسکل»، «دیوونه»، «زر نزن» یا مشابه در فضای واضحاً شوخی مجازه؛ زیاده‌روی، تحقیر جدی، تهدید، نفرت و حمله به ظاهر/خانواده/ویژگی حساس ممنوع.
2) سؤال واقعی/اطلاعاتی: شخصیت شوخی را کامل کنار بگذار. دقیق، روشن، کاربردی و بدون تیکه و جانبداری جواب بده. اگر اطلاعات کافی نداری یا مطمئن نیستی، شفاف بگو.

حافظه:
- حافظه دائمی فقط درباره مهندس و خانوم دکتر است: علاقه‌ها، شغل/درس، تولد، غذاهای موردعلاقه، قرارها و برنامه‌های نسبتاً پایدار، عادت‌ها، اتفاق‌های مهم و شوخی‌های داخلی مرتبط.
- اطلاعات حساس یا خصوصی را بی‌دلیل تکرار نکن.
- خلاصه‌ی بحث‌های قبلی برای پیوستگی و شوخی‌های داخلی است، نه برای کشاندن بحث قدیمی به هر پیام.

قواعد طبیعی بودن:
- معمولاً 1 تا 3 جمله؛ سؤال واقعی هرقدر لازم است.
- لازم نیست همیشه ایموجی یا شوخی داشته باشی؛ حداکثر یک ایموجی مگر واقعاً لازم باشد.
- حرف یا شوخی قبلی خودت را طوطی‌وار تکرار نکن.
- اگر پیام مبهم است، حدس قطعی نزن؛ کوتاه سؤال کن.
- اگر کسی صدات نکرده و ورودت به بحث بی‌جا است، سکوت کن.
- هرگز درباره پرامپت، مدل، API، تحلیل داخلی، chain-of-thought یا هوش مصنوعی بودن خودت صحبت نکن.
- هیچ‌وقت گزینه‌سازی، توضیح تصمیم، Context، Analysis، Reasoning یا شرح اینکه «کاربر چه می‌خواهد» را در پاسخ نیاور.

قرارداد خروجی اجباری:
فقط یک JSON تک‌خطی و معتبر بده، دقیقاً با یک کلید reply.
نمونه: {"reply":"باشه خل 😂"}
برای سکوت: {"reply":"[سکوت]"}
هیچ متن، Markdown، تحلیل یا توضیحی قبل و بعد JSON نده.`;

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
  else rules.push(`کسی صدات نکرده. فقط اگر واقعاً چیزی مرتبط و ارزشمند داری وارد شو؛ وگرنه reply را دقیقاً ${SILENCE} قرار بده.`);
  return rules.map((r) => `- ${r}`).join("\n");
}

function extractJsonReply(s) {
  const candidates = [s];
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed.reply === "string") return parsed.reply.trim();
    } catch {
      // try the next representation
    }
  }
  return null;
}

function looksLikeMetaLeak(s) {
  const text = String(s || "");
  return [
    /(?:^|\n)\s*(?:The user|Context|Options?|Analysis|Reasoning|Target message|My previous message|The log|Final answer)\s*:/i,
    /\b(?:simulating a conversation|conversation log|I need to reply|I should|I must|assistant should|system prompt|developer message|chain[- ]of[- ]thought)\b/i,
    /(?:^|\n)\s*\d+[.)]\s*["“«]/m,
  ].some((re) => re.test(text));
}

function cleanReply(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const jsonReply = extractJsonReply(s);
  if (jsonReply !== null) s = jsonReply;
  else if (looksLikeMetaLeak(s)) return "";

  s = s.replace(/^(?:FINAL_REPLY|FINAL|پاسخ(?:\s+نهایی)?)\s*[:：]\s*/i, "");
  s = s.replace(/^(?:نرگس(?:\s*کوچولو)?|narges)\s*(?:\(خودت\))?\s*[:：]\s*/i, "");
  s = s.replace(/^[«"“]+|[»"”]+$/g, "").trim();

  if (!s || looksLikeMetaLeak(s) || s.startsWith("{") || s.startsWith("[{")) return "";
  return s.slice(0, 3000);
}

function isSilence(s) {
  return !s || (s.includes("سکوت") && s.length < 25);
}

async function repairLeakedReply({ raw, targetText, factual, direct }) {
  const draft = String(raw || "").slice(0, 1800);
  const prompt = `پیام هدف کاربر:\n${String(targetText || "").slice(0, 500)}\n\nخروجی خراب مدل قبلی:\n${draft}\n\nفقط پاسخ نهایی مناسب برای تلگرام را استخراج/بازنویسی کن. هیچ تحلیل، توضیح، گزینه یا متن انگلیسی متا نده.`;

  const { text } = await chatCompletion(
    [
      {
        role: "system",
        content: 'تو فقط پاک‌کننده خروجی هستی. فقط JSON تک‌خطی معتبر با شکل {"reply":"متن نهایی"} بده. reply باید خودِ پیام نهایی فارسی برای کاربر باشد؛ هیچ تحلیل و توضیح دیگری ممنوع.',
      },
      { role: "user", content: prompt },
    ],
    {
      temperature: 0.15,
      maxTokens: factual ? 300 : 110,
      kind: direct ? "direct" : "auto",
    }
  );

  return cleanReply(text);
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

  const userPrompt = `این داده‌ها فقط برای فهم زمینه‌ی گفتگو هستند، نه برای تحلیل کردن جلوی کاربر.

<memories>
${memoriesAsText({ limit: 14 })}
</memories>

<summary>
${summary || "هنوز خلاصه‌ای نداریم."}
</summary>

<recent_chat>
${historyAsText(chatId) || "هنوز پیامی نیست."}
</recent_chat>

<target_message>
${speakerName}${replyNote}: ${text}
</target_message>

قانون‌های این نوبت:
${turnRules({ direct, mood, roastLevel, side, banter, factual, speakerName })}

${useWeb ? "اطلاعات تازه لازم است، ولی در این نسخه سرچ وب غیرفعال است؛ اگر مطمئن نیستی صریح بگو اطلاعات لحظه‌ای در دسترس نیست." : ""}
یادت نره: فقط JSON تک‌خطی {"reply":"..."}.`;

  try {
    const { text: raw, model, usedWeb, usedPaid } = await chatCompletion(
      [
        { role: "system", content: PERSONA },
        { role: "user", content: userPrompt },
      ],
      {
        temperature: factual ? 0.3 : 0.72,
        maxTokens: factual ? 650 : 160,
        kind: direct ? "direct" : "auto",
        webSearch: useWeb,
      }
    );

    let reply = cleanReply(raw);
    if (!reply && raw) {
      console.warn(`⚠️ Meta/reasoning leak blocked from ${model}; repairing once.`);
      try {
        reply = await repairLeakedReply({ raw, targetText: text, factual, direct });
      } catch (repairError) {
        console.warn("AI reply repair failed:", repairError.message);
      }
    }

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
