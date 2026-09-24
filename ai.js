import { OPENROUTER_API_KEY } from "./config.js";
import { historyAsText, memoriesAsText, getChatState } from "./db.js";
import { displayName, normalizePersian } from "./memory.js";
import { chooseSide, detectConversationMode, fixedFallback } from "./behavior.js";
import { chatCompletion, canSpend, QuotaError } from "./openrouter.js";

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
let lastLocalReply = "";

function localPick(items) {
  const usable = items.filter((x) => x !== lastLocalReply);
  const list = usable.length ? usable : items;
  const reply = list[Math.floor(Math.random() * list.length)];
  lastLocalReply = reply;
  return reply;
}

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
  else rules.push(`کسی صدات نکرده؛ اگر ورودت ارزش ندارد reply را ${SILENCE} بگذار.`);
  return rules.map((r) => `- ${r}`).join("\n");
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

function localFastReply(text, speakerName, direct) {
  if (!direct) return null;
  const n = normalizePersian(text)
    .replace(/[.!؟?،,:؛;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const engineer = speakerName === "مهندس";
  const doctor = speakerName === "خانوم دکتر";

  if (!n) return localPick(["هوم؟ 😌", "جانم؟"]);
  if ([...n].length === 1 && /^[\p{L}\p{N}]$/u.test(n)) return `${n} چی؟ 😅`;

  if (/^(نرگس|نرگس کوچولو|خانوم نرگس|خانم نرگس|نرگسی|narges)$/.test(n)) {
    return localPick(["جانم؟ 😌", "هوم؟ بگو", "هستم، چی شده؟", "بله؟ 👀"]);
  }
  if (/^(هستی|کجایی|نرگس کجایی|بیداری|خوابی|زنده ای|زنده‌ای)$/.test(n)) {
    return localPick(["هستم بابا 😌", "اینجام، گم نشدم 😂", "بیدارم، بگو ببینم", "هستم، چه خبره؟ 👀"]);
  }

  if (/^(سلام|سلاممم|سلام نرگس|سلام نرگس کوچولو|درود|های|hello|hi)$/.test(n)) {
    return localPick(["سلاممم 😌", engineer ? "سلام مهندس، چه خبر؟" : doctor ? "سلام خانوم دکتر 😌" : "سلام، چه خبر؟", "عه سلام 👀", "سلام به روی ماهت 😄"]);
  }
  if (/^(صبح بخیر|صبح خیر)$/.test(n)) return localPick(["صبح تو هم بخیر ☀️", "صبح بخیرر، بیدار شدی بالاخره؟ 😂", "صبحت بخیر 😌"]);
  if (/^(شب بخیر|شبت بخیر|من میخوابم|من می‌خوابم|خوابم میاد|خوابم میاددد)$/.test(n)) {
    return localPick(["شب بخیر، برو بخواب دیگه 😴", engineer ? "شب بخیر مهندس، خواب خانوم دکتر ببینی 😂" : "شب بخیرر 😌", "بخواب که فردا زامبی نشی 😴"]);
  }
  if (/^(خدافظ|خداحافظ|بای|فعلا|فعلاً|من رفتم)$/.test(n)) return localPick(["بای بای 😌", "برو به سلامت 😂", "فعلاً، زود برگرد", "خدافظ 👋"]);

  if (/^(خوبی|چطوری|حالت خوبه|چه طوری|چه خبر|چه خبرا)$/.test(n)) {
    return localPick(["خوبم، تو چطوری؟ 😌", "سر پام فعلاً 😂 تو چه خبر؟", "خوبم، شماها نذارین خراب شم 😅", "من خوبم، تو بگو چه خبر"]);
  }
  if (/^(چیکار میکنی|چیکار می‌کنی|داری چیکار میکنی|داری چیکار می‌کنی|چه میکنی|چه می‌کنی)$/.test(n)) {
    return localPick(["فعلاً دارم فضولی شماها رو می‌کنم 😂", "هیچی، منتظرم یکی یه حرف جالب بزنه", engineer ? "حواسم به توئه مهندس 👀" : "دارم گروه رو می‌پام 😌"]);
  }
  if (/^(خسته ام|خسته‌ام|خیلی خستم|له شدم|داغونم)$/.test(n)) {
    return localPick(["یه کم استراحت کن، دنیا فرار نمی‌کنه 😌", "برو یه نفس بکش بعد برگرد", engineer ? "استراحت کن مهندس، قهرمان‌بازی درنیار 😄" : "یه کم به خودت استراحت بده 🌱"]);
  }
  if (/^(حوصلم سر رفته|حوصله ام سر رفته|حوصله‌م سر رفته|حوصلم نیست|حوصله ندارم)$/.test(n)) {
    return localPick(engineer
      ? ["برو خانوم دکترو اذیت کن، تخصصته 😂", "خب یه سوژه بده کل‌کل کنیم", "من هستم، یه چیزی بگو بخندیم"]
      : ["یه سوژه بده کل‌کل کنیم 😌", "من هستم، بگو چی کار کنیم", "خب بیا یکیو اذیت کنیم 😂"]);
  }
  if (/^(گشنمه|گرسنمه|گرسنه ام|گرسنه‌ام)$/.test(n)) return localPick(["برو یه چیزی بخور قبل اینکه اخلاقتم خورده بشه 😂", "غذااا، سریع 😭", "یه چیزی بخور جانم 😌"]);

  if (/^(مرسی|ممنون|دمت گرم|تشکر|مرسی نرگس|ممنون نرگس)$/.test(n)) return localPick(["قربونت 😌", "خواهش می‌کنم", "فدات 😂", "کاری نکردم بابا"]);
  if (/^(ببخشید|شرمنده|معذرت|معذرت میخوام|معذرت می‌خوام)$/.test(n)) return localPick(["ولش کن بابا 😌", "اوکیه، گیر نده به خودت", "بخشیدمت 😂"]);
  if (/^(باشه|اوکی|اوکیه|چشم|قبوله|حله|آره|اره|اره دیگه)$/.test(n)) return localPick(["عه خوبه 😌", "حله", "باشه پس", "اوکی اوکی 😂"]);
  if (/^(نه|نه بابا|نخیر|اصلا|اصلاً)$/.test(n)) return localPick(["باشه بابا، نزن 😂", "خب نه که نه 😌", "اوکی، قانع شدم"]);
  if (/^(هیچی|ولش|ولش کن|بیخیال|بیخیالش|مهم نیست)$/.test(n)) return localPick(["باشه بابا 😌", "اوکی، ولش کردیم", "هیچی که هیچی 😂", "باشه، فضولی نمی‌کنم"]);
  if (/^(چی|ها|هان|هوم|عه|اها|آها|جدی)$/.test(n)) return localPick(["چی شد؟ 👀", "هان؟ 😂", "هوم، ادامه بده", "عه چی؟"]);
  if (/^(کمکم کن|کمک|یه سوال|یه سؤال|سوال دارم|سؤال دارم|یه چیزی بگم)$/.test(n)) return localPick(["بگو ببینم چی شده", "بگو، گوشم با توئه 😌", "بپرس، ببینم چی داری"]);

  if (/^(😂+|🤣+|خخ+|خخخ+|ههه+|هههه+|lol)$/.test(n)) return localPick(["😂😂", "بخند بخند، بعداً حسابتو می‌رسم 😂", "عه خیلی خندیدی 😭", "خوبه حداقل خندیدی 😂"]);

  if (/^(احمق|اسکل|خل|دیوونه|خنگ|خر|گاگول|کودن)$/.test(n)) {
    return localPick(engineer
      ? ["خودتی مهندس 😂", "ادب داشته باش مهندس جان 😌😂", "آینه جلوته؟ 😂", "باشه نابغه 😂"]
      : ["خودتی 😂", "ای بابا شروع شد 😭", "باشه نابغه 😂"]);
  }
  if (/عقل\s+نداری|مغز\s+نداری|بی.?عقلی|مغزت\s+قفل|چرا.*مغزت/.test(n)) {
    return localPick(engineer
      ? ["باشه پروفسور، تو خیلی عاقلی 😂", "مغزم خوبه، تو زیادی فشار میاری بهش 😭", "تو با این سؤالا قفلش می‌کنی مهندس 😂", "حداقل مغزم خانوم دکترو اذیت نمی‌کنه 😌😂"]
      : ["باشه پروفسور 😂", "شماها فشار میارین به مغزم خب 😭", "مغزم سالمه، گروه مشکل داره 😂"]);
  }
  if (/^(ساکت|خفه شو|برو بابا|گمشو|برو)$/.test(n)) return localPick(["چشم رئیس 😂", "باشه میرم یه گوشه قهر کنم 😌", "خودت صدام کردی‌ها 😂", "باشه بابا، چه خشنی 😭"]);
  if (/^(بیا|برگرد|حرف بزن|یه چیزی بگو)$/.test(n)) return localPick(["اومدم 😌", "خب چی بگم، سوژه بده 😂", "حاضرم، شروع کن", "هستم دیگه 👀"]);

  if (/^(دوستت دارم|دوست دارم|عاشقتم)$/.test(n)) return localPick(["منم دوستت دارم خل 😂", "عه احساساتی شدی؟ 😌", "فدات، حالا جو نگیر 😂"]);
  if (/^(دوستم داری|منو دوست داری|عاشقمی)$/.test(n)) return localPick(["آره بابا، حالا ذوق نکن 😂", "دوستت دارم، ولی رو اعصابمم هستی 😌", "یه کم 😏"]);
  if (/^(من کیم|اسم من چیه|منو میشناسی|منو می‌شناسی)$/.test(n)) return engineer ? "تو مهندسی دیگه، مگه چندتا دردسر داریم؟ 😂" : doctor ? "خانوم دکتری 😌" : `تو ${speakerName}ی.`;
  if (/^(تو کی هستی|اسمت چیه|اسمت چیست|کی هستی)$/.test(n)) return localPick(["نرگس کوچولو 😌", "همون نرگس کوچولویی که ول‌کن شما نیست 😂", "نرگسم دیگه 👀"]);
  if (/^(رباتی|ربات هستی|هوش مصنوعی هستی|ai هستی)$/.test(n)) return localPick(["من نرگس کوچولوام، همینو بدون 😌", "باز شروع کردی؟ نرگسم دیگه 😂"]);

  if (/خانوم دکتر.*دوستت دارم|دکتر.*دوستت دارم/.test(n) && engineer) return "خب اینو به خودش بگو قهرمان 😂";
  if (/(?:به\s+(?:خانوم|خانم)\s+دکتر).*(?:بگو|بگی).*(?:دوستش\s+دارم|دوستش دارم)/.test(n)) {
    return engineer ? "خانوم دکتر، مهندس میگه دوستت داره 😌" : "خب خودت بهش بگو دیگه 😄";
  }
  if (/(?:خانوم|خانم)\s+دکتر.*(?:منو|مهندس رو).*دوست.*(?:داره|دارد)/.test(n) && engineer) {
    return localPick(["من که ذهن‌خوان نیستم مهندس 😂 از خودش بپرس", "این یکی رو باید خود خانوم دکتر جواب بده 😌", "جرأت داری مستقیم از خودش بپرس 😂"]);
  }
  if (/^(من خانوم دکترو دوست دارم|من خانوم دکتر رو دوست دارم|خانوم دکترو دوست دارم)$/.test(n) && engineer) {
    return localPick(["آره فهمیدیم مهندس، کل گروه فهمید 😂", "این خبر دیگه محرمانه نیست 😌😂", "جدی؟ اصلاً معلوم نبوداا 😂"]);
  }
  if (/(کیو بیشتر دوست داری|من یا خانوم دکتر|من یا دکتر|طرف کی هستی|طرف کی هستی)/.test(n)) {
    return localPick(["تو دعوا؟ یه ذره بیشتر خانوم دکتر 😌😂", "بستگی داره کی کمتر زر بزنه 😂", "من عدالت‌محورم... با یه کوچولو پارتی‌بازی برای دکتر 😌"]);
  }
  if (/(خانوم دکتر کجاست|دکتر کجاست|خانم دکتر کجاست)/.test(n)) return engineer ? "از خودش بپرس مهندس، من ردیاب دکتر نیستم 😂" : "من که لوکیشن زنده ندارم 😅";
  if (/(دلم براش تنگ شده|دلم برای خانوم دکتر تنگ شده|دلتنگشم)/.test(n) && engineer) return localPick(["پس به خودش بگو، به من گزارش نده 😂", "اووو مهندس احساساتی شد 😌", "خب یه پیام قشنگ بهش بده دیگه"]);

  if (/^(آفرین|دمت گرم نرگس|باحالی|تو باحالی|خوبی تو)$/.test(n)) return localPick(["می‌دونم 😌😂", "بالاخره فهمیدی 😂", "فدات، تو هم بد نیستی 😏"]);
  if (/^(حرف نزن|بس کن|کافیه)$/.test(n)) return localPick(["چشم 😌", "باشه، فعلاً ساکت 😂", "اوکی، سکوت اختیار کردم 🤐"]);

  // Very short casual messages should not waste an API call. Keep factual-looking
  // short prompts for the AI, but handle obvious conversational fragments locally.
  if ([...n].length <= 8 && !/(چرا|چطور|چجوری|چند|کیه|کجاست|چیست|قیمت|خبر|کد|ارور|دارو|پزشک)/.test(n)) {
    return localPick(["ها؟ 😅", "چی شد؟", "ادامه بده 👀", "هوم؟"]);
  }

  return null;
}

function emergencyReply({ text, speakerName, factual }) {
  const local = localFastReply(text, speakerName, true);
  if (local) return local;
  if (factual) return "این یکی رو الان نتونستم دقیق جمع کنم؛ یه کم بعد دوباره بپرس.";
  return fixedFallback();
}

export async function generateReply(ctx, { direct, text, replyToSpeaker = null, replyToText = null }) {
  const chatId = ctx.chat.id;
  const speakerName = displayName(ctx.from);
  const { mood, roastLevel, banter, factual } = detectConversationMode(text, chatId);
  const side = chooseSide();

  const fast = localFastReply(text, speakerName, direct);
  if (fast) return { reply: fast, source: "local" };

  const fallback = () =>
    direct
      ? { reply: emergencyReply({ text, speakerName, factual }), source: "fallback" }
      : { reply: null, source: "silent" };

  if (!OPENROUTER_API_KEY) return fallback();
  if (!canSpend(direct ? "direct" : "auto")) return fallback();

  const summary = String(getChatState(chatId).summary || "").slice(0, factual ? 800 : 520);
  const replyNote = replyToText
    ? ` [در جواب ${replyToSpeaker || "کسی"}: «${replyToText.slice(0, 120)}»]`
    : "";
  const historyLimit = factual ? 8 : (direct ? 10 : 8);
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
        maxTokens: factual ? 360 : 80,
        kind: direct ? "direct" : "auto",
        jsonMode: true,
        attemptTimeoutMs: factual ? 15000 : 9000,
      }
    );

    const reply = parseStrictReply(result.text);
    if (!reply) {
      console.warn(`⚠️ Invalid/meta reply blocked from ${result.model}; using local fallback.`);
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
