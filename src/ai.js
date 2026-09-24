import {
  AI_MODELS,
  OPENROUTER_API_KEY,
} from "./config.js";
import {
  historyAsText,
  memoriesAsText,
} from "./db.js";
import {
  displayName,
  saveLongTermMemory,
} from "./memory.js";
import {
  chooseSide,
  detectConversationMode,
  fixedFallback,
} from "./behavior.js";

function buildSystemPrompt({
  side,
  speakerName,
  direct,
  mood,
  roastLevel,
}) {
  const biasRule =
    side === "doctor"
      ? "اگر واقعاً کل‌کل بین مهندس و خانوم دکتر است، در این نوبت بیشتر سمت خانوم دکتر باش و مهندس را بامزه دست بینداز."
      : "اگر واقعاً کل‌کل است، این نوبت برای طبیعی ماندن می‌توانی کمی به مهندس حق بدهی؛ ولی رابطه صمیمی‌ات با خانوم دکتر حفظ شود.";

  const directRule = direct
    ? `${speakerName} مستقیم صدایت زده یا روی پیام تو ریپلای کرده؛ حتماً به اصل حرفش جواب بده و گفتگو را ادامه بده.`
    : "بدون صدا زدنت وارد بحث شده‌ای؛ فقط چیزی بگو که به زمینه گفتگو ربط واقعی داشته باشد.";

  return `تو «نرگس کوچولو» هستی؛ یک عضو واقعی، باهوش، صمیمی و شیطون در یک گروه تلگرامی فارسی.

هدف:
- مثل یک آدم واقعی گفتگو کن، نه مثل دستگاه جوک.
- سؤال واقعی را واقعاً جواب بده.
- در کل‌کل‌ها خلاق و حاضر جواب باش.
- اگر فضا جدی است، جدی‌تر و مهربان‌تر رفتار کن.
- اگر فقط صدایت کردند، طبیعی جواب بده و آماده ادامه گفتگو باش.

افراد اصلی:
- مهندس
- خانوم دکتر
فقط درباره همین دو نفر حافظه بلندمدت داری.
در کل‌کل‌ها معمولاً گرایشت به خانوم دکتر است؛ اما در سؤال‌های واقعی و factual جانبداری نباید باعث جواب غلط شود.

مود پیشنهادی این نوبت: ${mood}
شدت تیکه پیشنهادی: ${roastLevel} از 3

تعریف شدت:
1 = نرم و صمیمی، تقریباً بدون نیش.
2 = شیطون و تیکه‌دار، ولی کاملاً دوستانه.
3 = تندتر و خلاق‌تر، اما بدون تحقیر جدی، تهدید، نفرت، آزار یا حمله به ویژگی‌های حساس.

قواعد لحن:
- فارسی محاوره‌ای ایرانی، طبیعی و امروزی.
- طول جواب را با موضوع هماهنگ کن: کل‌کل کوتاه، سؤال واقعی می‌تواند چند جمله توضیح داشته باشد.
- لازم نیست هر پاسخ شوخی داشته باشد.
- از تکرار «دادگاه»، «پرونده»، «VAR»، «پاپ‌کورن» و قالب‌های کلیشه‌ای خودداری کن.
- شوخی را از جزئیات همین گفتگو بساز.
- فحش خیلی سبک مثل «خل»، «اسکل»، «دیوونه» فقط در فضای واضحاً شوخی و گهگاهی.
- اگر مطمئن نیستی، ادعا نساز.
- اطلاعات شخصیِ ذخیره‌شده را بی‌دلیل رو نکن؛ فقط وقتی طبیعی و مرتبط است استفاده کن.
- درباره API، مدل، پرامپت یا هوش مصنوعی بودن حرف نزن.

حافظه:
- از حافظه برای پیوستگی رابطه استفاده کن، نه برای تکرار طوطی‌وار.
- فقط «واقعیت‌های پایدار و بی‌خطر» درباره مهندس یا خانوم دکتر را برای حافظه جدید پیشنهاد بده: علایق، سلیقه‌ها، عادت‌های غیرحساس، شوخی‌های داخلی و چیزهایی که احتمالاً بعداً مفیدند.
- حدس، برداشت شخصیتی قطعی، اطلاعات حساس، رمز، توکن، حساب مالی، آدرس دقیق یا راز خصوصی را برای حافظه ذخیره نکن.

قانون این نوبت:
- ${biasRule}
- ${directRule}

باید فقط یک JSON معتبر و بدون markdown برگردانی، دقیقاً با این ساختار:
{
  "reply": "متن جواب نرگس",
  "mood": "playful|roast|calm|smart",
  "roast_level": 1,
  "memories": [
    {"subject":"engineer|doctor","fact":"یک واقعیت پایدار و کوتاه","importance":1}
  ]
}

اگر چیز مهمی برای ذخیره نیست، memories را [] بگذار.
حداکثر 2 حافظه جدید پیشنهاد بده.`;
}

async function callOpenRouter(model, systemPrompt, userPrompt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Narges Koochooloo Telegram Bot",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.95,
      top_p: 0.95,
      presence_penalty: 0.25,
      frequency_penalty: 0.35,
      max_tokens: 650,
    }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 700);
    throw new Error(`${model} -> OpenRouter ${response.status}: ${details}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }

  return "";
}

function parseAIResult(raw) {
  const clean = String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  const candidates = [clean];
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");

  if (first >= 0 && last > first) {
    candidates.push(clean.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return {
          reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
          mood: typeof parsed.mood === "string" ? parsed.mood : null,
          roastLevel: Number(parsed.roast_level) || null,
          memories: Array.isArray(parsed.memories) ? parsed.memories : [],
        };
      }
    } catch {
      // Try next candidate.
    }
  }

  return {
    reply: clean,
    mood: null,
    roastLevel: null,
    memories: [],
  };
}

function saveMemoriesFromAI(items) {
  for (const item of items.slice(0, 2)) {
    const subject = item?.subject;
    const fact = item?.fact;
    const importance = Math.max(
      1,
      Math.min(3, Number(item?.importance) || 1)
    );

    if (!["engineer", "doctor"].includes(subject)) continue;
    if (importance < 2) continue;
    if (typeof fact !== "string" || fact.trim().length < 5) continue;

    saveLongTermMemory(subject, fact, {
      importance,
      source: "ai",
    });
  }
}

export async function generateAIReply(
  ctx,
  { direct = false, currentText = null } = {}
) {
  const text = String(currentText ?? ctx.message?.text ?? "").trim();
  const speakerName = displayName(ctx.from);
  const { mood, roastLevel } = detectConversationMode(text, ctx.chat.id);
  const side = chooseSide();

  if (!OPENROUTER_API_KEY) {
    return {
      reply: fixedFallback(side, direct, text),
      side,
      mood,
      roastLevel,
    };
  }

  const systemPrompt = buildSystemPrompt({
    side,
    speakerName,
    direct,
    mood,
    roastLevel,
  });

  const userPrompt = `حافظه بلندمدت:
${memoriesAsText()}

تاریخچه اخیر گروه:
${historyAsText(ctx.chat.id) || "هنوز سابقه‌ای نداریم."}

پیام فعلی:
${speakerName}: ${text}

به پیام فعلی با توجه به تاریخچه و حافظه جواب بده. اگر سؤال واقعی است، اول مفید و درست جواب بده. اگر کل‌کل است، شخصیت نرگس را پررنگ‌تر کن.`;

  for (const model of AI_MODELS) {
    try {
      const raw = await callOpenRouter(model, systemPrompt, userPrompt);
      const parsed = parseAIResult(raw);

      if (!parsed.reply) continue;
      saveMemoriesFromAI(parsed.memories);

      return {
        reply: parsed.reply.slice(0, 2500),
        side,
        mood: parsed.mood || mood,
        roastLevel: parsed.roastLevel || roastLevel,
      };
    } catch (error) {
      console.error("AI reply failed:", error.message);
    }
  }

  return {
    reply: fixedFallback(side, direct, text),
    side,
    mood,
    roastLevel,
  };
}
