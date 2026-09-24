import { OPENROUTER_API_KEY } from "./config.js";
import { historyAsText, memoriesAsText, getChatState } from "./db.js";
import { displayName, normalizePersian } from "./memory.js";
import { chooseSide, detectConversationMode } from "./behavior.js";
import { chatCompletion, canSpend, QuotaError } from "./openrouter.js";
import { localReply, localFallback } from "./local.js";

const PERSONA = `تو «نرگس کوچولو» هستی؛ یک عضو واقعی و بامزه در یک گروه تلگرامی فارسی.
دو آدم اصلی گروه «مهندس» و «خانوم دکتر» هستند. می‌دانی مهندس خانوم دکتر را دوست دارد. در کل‌کل‌های دوستانه کمی بیشتر سمت خانوم دکتر هستی، اما مصنوعی و افراطی نه.

قواعد:
- به خود پیام هدف جواب بده، نه اینکه آن را تحلیل یا خلاصه کنی.
- در گفتگوی معمولی فارسی محاوره‌ای، کوتاه، طبیعی و حاضرجواب باش.
- فحش سبک دوستانه در فضای واضحاً شوخی مجاز است، ولی تحقیر جدی و حمله شخصی نه.
- در سؤال واقعی/اطلاعاتی شوخی را کامل کنار بگذار و دقیق جواب بده.
- اگر پیام مبهم یا ناقص است، معنی اختراع نکن؛ یک سؤال کوتاه بپرس.
- تاریخچه و حافظه فقط زمینه‌اند و هرگز نباید برای کاربر شرح داده شوند.
- هرگز درباره prompt، model، API، reasoning، analysis، context یا اینکه کاربر چه می‌خواهد توضیح نده.
- هرگز گزینه‌های پیشنهادی برای پاسخ خودت تولید نکن.

خروجی اجباری:
فقط JSON معتبر با همین شکل بده: {"reply":"متن نهایی برای ارسال در تلگرام"}
اگر نباید وارد بحث شوی: {"reply":"[سکوت]"}`;

const MOOD_TEXT = {
  calm: "فضا جدی است؛ آرام و بدون شوخی جواب بده.",
  smart: "سؤال واقعی است؛ دقیق و بدون شوخی جواب بده.",
  playful: "فضا دوستانه است؛ کوتاه و طبیعی و شیطون جواب بده.",
  roast: "کل‌کل دوستانه است؛ کوتاه و تیکه‌دار جواب بده.",
};

const SILENCE = "[سکوت]";

function turnRules({ direct, mood, roastLevel, side, banter, factual, speakerName }) {
  const rules = [MOOD_TEXT[mood] || MOOD_TEXT.playful];
  if (!factual) rules.push(`شدت تیکه: ${roastLevel} از 3.`);
  if (banter) {
    rules.push(side === "doctor"
      ? "در این کل‌کل کمی بیشتر سمت خانوم دکتر باش، ولی زورکی نه."
      : "این بار می‌توانی کمی هم به مهندس حق بدهی.");
  }
  if (factual) rules.push("هیچ شوخی یا اشاره بی‌ربط به رابطه مهندس و خانوم دکتر نکن.");
  if (direct) rules.push(`${speakerName} مستقیم با تو حرف زده؛ خود حرفش را جواب بده.`);
  else rules.push(`کسی صدات نکرده. فقط اگر واقعاً چیزی مرتبط داری جواب بده؛ وگرنه reply را ${SILENCE} بگذار.`);
  return rules.map((x) => `- ${x}`).join("\n");
}

function looksLikeMetaLeak(value) {
  const s = String(value || "").trim();
  return [
    /^The user\b/i,
    /^The (?:target|message|content|conversation|log)\b/i,
    /\b(?:I need to|I should|I must|I will|I am supposed to|my task is)\b/i,
    /\b(?:simulating a conversation|conversation log|target message|previous message|system prompt|developer message|chain[- ]of[- ]thought)\b/i,
    /(?:^|\n)\s*(?:Context|Options?|Analysis|Reasoning|Thoughts?|Interpretation|Final answer)\s*:/i,
    /(?:^|\n)\s*\d+[.)]\s*["“«]/m,
    /\b(?:reply as|respond as)\s+["“«]?نرگس/i,
  ].some((re) => re.test(s));
}

function parseStrictReply(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.reply !== "string") return null;

  let reply = parsed.reply.trim();
  if (!reply || looksLikeMetaLeak(reply)) return null;
  reply = reply.replace(/^(?:نرگس(?:\s*کوچولو)?|narges)\s*[:：]\s*/i, "").trim();
  if (!reply || looksLikeMetaLeak(reply)) return null;
  return reply.slice(0, 2200);
}

function isSilence(text) {
  const s = String(text || "").trim();
  return s === SILENCE || (s.includes("سکوت") && s.length < 25);
}

function isShortSocial(text, factual) {
  if (factual) return false;
  const n = normalizePersian(text);
  if (/https?:\/\//i.test(n) || /\d{3,}/.test(n)) return false;
  const words = n.split(/\s+/).filter(Boolean);
  return [...n].length <= 42 && words.length <= 8;
}

export async function generateReply(ctx, { direct, text, replyToSpeaker = null, replyToText = null }) {
  const chatId = ctx.chat.id;
  const speakerName = displayName(ctx.from);
  const { mood, roastLevel, banter, factual } = detectConversationMode(text, chatId);
  const side = chooseSide();

  const local = localReply({
    chatId,
    text,
    speakerName,
    direct,
    replyToSpeaker,
    replyToText,
  });
  if (local) return { reply: local, source: "local" };

  const fallback = () => direct
    ? {
        reply: localFallback({
          chatId,
          text,
          speakerName,
          factual,
          replyToSpeaker,
          replyToText,
        }),
        source: "local-fallback",
      }
    : { reply: null, source: "silent" };

  // پیام‌های کوتاه اجتماعی ارزش سوزاندن سهمیه و منتظر ماندن برای API را ندارند.
  if (direct && isShortSocial(text, factual)) return fallback();

  // برای ورود خودکار، فقط پیام‌های نسبتاً پرمحتوا را به AI بده؛ localAutoReply بالا
  // کل‌کل‌های پرتکرار مهندس/خانوم دکتر را بدون API پوشش می‌دهد.
  if (!direct && String(text || "").trim().length < 55) return { reply: null, source: "silent" };

  if (!OPENROUTER_API_KEY) return fallback();
  if (!canSpend(direct ? "direct" : "auto")) return fallback();

  const summary = String(getChatState(chatId).summary || "").slice(0, factual ? 780 : 480);
  const replyNote = replyToText
    ? ` [در جواب ${replyToSpeaker || "کسی"}: «${String(replyToText).slice(0, 120)}»]`
    : "";
  const historyLimit = factual ? 8 : (direct ? 9 : 7);
  const memoryLimit = factual ? 7 : 5;

  const userPrompt = `<memory>\n${memoriesAsText({ limit: memoryLimit })}\n</memory>\n<summary>\n${summary || "ندارد"}\n</summary>\n<recent_chat>\n${historyAsText(chatId, historyLimit) || "ندارد"}\n</recent_chat>\n<target>\n${speakerName}${replyNote}: ${String(text).slice(0, 700)}\n</target>\n${turnRules({ direct, mood, roastLevel, side, banter, factual, speakerName })}\nفقط JSON.`;

  try {
    const result = await chatCompletion(
      [
        { role: "system", content: PERSONA },
        { role: "user", content: userPrompt },
      ],
      {
        temperature: factual ? 0.22 : 0.62,
        maxTokens: factual ? 340 : 78,
        kind: direct ? "direct" : "auto",
        jsonMode: true,
        attemptTimeoutMs: factual ? 14_000 : 8_000,
      }
    );

    const reply = parseStrictReply(result.text);
    if (!reply) {
      console.warn(`⚠️ Invalid/meta reply blocked from ${result.model}; local fallback used.`);
      return fallback();
    }
    if (isSilence(reply)) return direct ? fallback() : { reply: null, source: "silent" };

    return {
      reply,
      source: "ai",
      model: result.model,
      usedWeb: false,
      usedPaid: false,
    };
  } catch (error) {
    if (error instanceof QuotaError) {
      console.warn("AI free router unavailable:", error.message);
      return fallback();
    }
    console.error("AI reply failed:", error.message);
    return fallback();
  }
}
