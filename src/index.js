import "dotenv/config";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";

if (!process.env.BOT_TOKEN) {
  console.error("Missing required environment variable: BOT_TOKEN");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const ENGINEER_ID = Number(process.env.ENGINEER_ID || 0);
const DOCTOR_ID = Number(process.env.DOCTOR_ID || 0);
const RESPONSE_RATE = clampNumber(process.env.RESPONSE_RATE, 0.10, 0, 1);
const FIXED_REPLY_RATE = clampNumber(process.env.FIXED_REPLY_RATE, 0.15, 0, 1);
const MEMORY_SIZE = Math.max(4, Math.min(30, Number(process.env.MEMORY_SIZE || 10)));
const AI_MODEL = process.env.AI_MODEL || "google/gemma-4-31b-it:free";
const FALLBACK_AI_MODEL = "openrouter/free";

const memories = new Map();

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function displayName(user) {
  if (!user) return "یکی از بچه‌ها";
  if (ENGINEER_ID && user.id === ENGINEER_ID) return "مهندس";
  if (DOCTOR_ID && user.id === DOCTOR_ID) return "خانوم دکتر";
  return user.first_name || user.username || `کاربر ${user.id}`;
}

function addToMemory(chatId, user, text) {
  if (!text?.trim()) return;

  const list = memories.get(chatId) || [];
  list.push({
    name: displayName(user),
    userId: user?.id,
    text: text.trim().slice(0, 1000),
  });

  while (list.length > MEMORY_SIZE) list.shift();
  memories.set(chatId, list);
}

function memoryAsText(chatId) {
  const list = memories.get(chatId) || [];
  return list.map((item) => `${item.name}: ${item.text}`).join("\n");
}

const engineerReplies = [
  "خانوم دکتر، من نمی‌خوام جانبداری کنم ولی این یکی رو مهندس تمیز زد 😂",
  "اعتراض خانوم دکتر ثبت شد؛ نتیجه بررسی: مهندس فعلاً زنده موند 😌😂",
  "مهندس چیزی نگو، همین الان وضعیت به نفعت بود، خرابش نکن 😭",
  "خانوم دکتر این استدلال یه کم نیاز به آپدیت نرم‌افزاری داره 😂",
  "من بی‌طرفم؛ فقط قطب‌نمای من هی سمت مهندس می‌چرخه 😌",
  "مهندس امروز یه حرف درست زد، لطفاً این لحظه تاریخی رو ثبت کنید 😂",
  "خانوم دکتر این راند رو بده به مهندس، بذار یه شب با اعتمادبه‌نفس بخوابه 😭😂",
  "مهندس پشتتم؛ البته تا وقتی خودت شروع نکنی علیه خودت مدرک تولید کنی 😂",
];

const doctorReplies = [
  "مهندس من طرفتم، ولی این یکی رو واقعاً با چه رویی دفاع کنم؟ 😭😂",
  "خانوم دکتر این یکی رو خوب گرفت؛ مهندس فعلاً درخواست VAR داده 😂",
  "مهندس پنج دقیقه سکوت کن شاید بتونم پرونده رو نجات بدم 😐😂",
  "این دفعه خانوم دکتر بد نگفت... گفتنش برای منم درد داشت 😭",
  "مهندس داداش خودت با پای خودت رفتی تو تله، من فقط گزارشگرم 😂",
  "من اومدم طرف مهندس رو بگیرم، پیامشو خوندم، نظرم عوض شد 😭😂",
];

const directFallbackReplies = [
  "جانم؟ نرگس کوچولو در خدمت حاشیه‌سازی 😂",
  "هستم، بگو ببینم این دفعه کیو باید الکی محکوم کنیم 😌",
  "صدام کردی؟ امیدوارم برای کار خیر نباشه 😂",
  "بله؟ من آماده‌ام اوضاع آروم رو غیرضروری پیچیده کنم 😭😂",
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function chooseSide() {
  return Math.random() < 0.8 ? "engineer" : "doctor";
}

function fixedReply(side, direct = false) {
  if (direct) return pick(directFallbackReplies);
  return side === "engineer" ? pick(engineerReplies) : pick(doctorReplies);
}

function normalizePersian(text = "") {
  return text
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[‌\u200c]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDirectlyAddressed(ctx, text) {
  const normalized = normalizePersian(text);

  const callNames = [
    "نرگس",
    "نرگس کوچولو",
    "نرگسی",
    "خانوم نرگس",
    "خانم نرگس",
    "narges",
  ];

  if (callNames.some((name) => normalized.includes(name))) return true;

  const username = ctx.botInfo?.username?.toLowerCase();
  if (username && normalized.includes(`@${username}`)) return true;

  const repliedTo = ctx.message?.reply_to_message?.from?.id;
  if (repliedTo && repliedTo === ctx.botInfo?.id) return true;

  return false;
}

function buildSystemPrompt(side, speakerName, direct) {
  const sideRule =
    side === "engineer"
      ? "اگر بین مهندس و خانوم دکتر کل‌کل است، معمولاً با ظرافت سمت مهندس باش؛ نه آن‌قدر تابلو که مصنوعی شود."
      : "این بار اجازه داری مهندس را هم دست بیندازی یا کمی سمت خانوم دکتر باشی تا شوخی‌ها تکراری نشوند.";

  const directRule = direct
    ? `الان ${speakerName} مستقیماً تو را صدا زده یا به تو جواب داده. اول حرف همان شخص را بفهم و دقیقاً به همان پیام واکنش نشان بده؛ جواب عمومی و بی‌ربط نده.`
    : "الان بدون صدا زدنت وارد گفتگو می‌شوی؛ فقط وقتی واقعاً چیزی بامزه و مرتبط داری حرف بزن.";

  return `تو «نرگس کوچولو» هستی؛ عضو شیطون یک گروه تلگرامی فارسی، نه یک دستیار رسمی.

هویت و لحن:
- فارسی کاملاً محاوره‌ای و طبیعی ایرانی بنویس.
- جواب کوتاه باشد: ترجیحاً 5 تا 22 کلمه، حداکثر دو جمله.
- شوخی باید از خودِ موضوع پیام دربیاید؛ جمله آماده و بی‌ربط نگو.
- شیطون، صمیمی، حاضر جواب، کمی طعنه‌زن و تیکه‌انداز باش.
- فحش خیلی سبک و دوستانه مثل «خل»، «اسکل»، «دیوونه» فقط وقتی به فضای شوخی می‌خورد مجاز است؛ زیاده‌روی نکن.
- معمولاً یک punchline کوتاه بهتر از توضیح طولانی است.
- گاهی ایموجی 😂 😭 😌 🙄 استفاده کن، نه در هر جواب و نه چندتا پشت سر هم.
- هرگز نگو «به عنوان هوش مصنوعی»، «مدل»، «API»، «نمی‌توانم نقش‌آفرینی کنم» و چیزهای رباتی.
- اطلاعاتی درباره افراد اختراع نکن و اتهام واقعی نساز.
- اگر گفتگو جدی/حساس شد، شوخی سبک و بی‌آزار بکن و دعوا را تشدید نکن.

افراد اصلی:
- مهندس: معمولاً عزیزکرده توست و بیشتر سمت اویی، ولی گاهی خودش را هم می‌زنی.
- خانوم دکتر: با او هم صمیمی هستی و تیکه‌ها باید دوستانه بماند.

قانون این نوبت:
- ${sideRule}
- ${directRule}

نمونه جنس جواب خوب:
مهندس: «من که چیزی نگفتم»
نرگس: «آره مهندس، شما معمولاً بعد از گفتن همه‌چی می‌گی چیزی نگفتم 😂»

خانوم دکتر: «این باز شروع کرد»
نرگس: «خانوم دکتر من وکیلمه، معجزه‌گر نیستم؛ یه فرصت به مهندس بدید خودش خرابش کنه 😂»

مهندس: «نرگس تو طرف کی‌ای؟»
نرگس: «من؟ کاملاً بی‌طرفم مهندس، فقط بی‌طرفیم یه مقدار به سمت شما کجه 😌»

فقط خود جواب نرگس را بده؛ بدون گیومه، توضیح یا اسم گوینده.`;
}

async function callOpenRouter(model, systemPrompt, userPrompt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
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
      max_tokens: 100,
    }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
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

async function generateAIReply(ctx, side, direct) {
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn("OPENROUTER_API_KEY is missing; using fixed replies.");
    return fixedReply(side, direct);
  }

  const chatId = ctx.chat.id;
  const currentText = ctx.message?.text?.trim() || "";
  const speakerName = displayName(ctx.from);
  const conversation = memoryAsText(chatId) || "هنوز سابقه‌ای نداریم.";

  const systemPrompt = buildSystemPrompt(side, speakerName, direct);
  const userPrompt = `پیام‌های اخیر گروه (قدیمی به جدید):\n${conversation}\n\nپیام فعلی که باید به آن واکنش نشان بدهی:\n${speakerName}: ${currentText}\n\nبه همان پیام فعلی، با توجه به زمینه بالا، یک جواب کوتاه و بامزه بده.`;

  const models = AI_MODEL === FALLBACK_AI_MODEL
    ? [AI_MODEL]
    : [AI_MODEL, FALLBACK_AI_MODEL];

  for (const model of models) {
    try {
      const text = await callOpenRouter(model, systemPrompt, userPrompt);
      if (text) return text.slice(0, 500);
    } catch (error) {
      console.error("AI reply failed:", error.message);
    }
  }

  return fixedReply(side, direct);
}

async function makeReply(ctx, { direct = false } = {}) {
  const side = chooseSide();

  let reply;
  if (!direct && Math.random() < FIXED_REPLY_RATE) {
    reply = fixedReply(side, false);
  } else {
    reply = await generateAIReply(ctx, side, direct);
  }

  await ctx.reply(reply, {
    reply_parameters: { message_id: ctx.message.message_id },
  });
}

bot.start(async (ctx) => {
  await ctx.reply(
    "من نرگس کوچولوام 😌 تو گروه هم خودم گهگاهی می‌پرم وسط بحث؛ اگه صدام کنی باید جواب بدم 😂\n\n/id برای آیدی عددی\n/ping برای تست\n/narges برای صدا زدن مستقیم"
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`آیدی عددی شما: ${ctx.from.id}\nآیدی این چت: ${ctx.chat.id}`);
});

bot.command("ping", (ctx) => ctx.reply("بیدارم مهندس 😌 این اینترنت شماست که گاهی خوابش می‌بره 😂"));

bot.command("narges", async (ctx) => {
  const text = ctx.message.text.replace(/^\/narges(@\w+)?\s*/i, "").trim();
  if (text) addToMemory(ctx.chat.id, ctx.from, text);
  await ctx.sendChatAction("typing");
  await makeReply(ctx, { direct: true });
});

bot.on(message("text"), async (ctx) => {
  if (!ctx.from || ctx.from.is_bot) return;

  const text = ctx.message.text?.trim();
  if (!text || text.startsWith("/")) return;

  addToMemory(ctx.chat.id, ctx.from, text);

  const direct = isDirectlyAddressed(ctx, text);
  const randomHit = Math.random() < RESPONSE_RATE;

  if (!direct && !randomHit) return;

  try {
    await ctx.sendChatAction("typing");
    await makeReply(ctx, { direct });
  } catch (error) {
    console.error("Reply error:", error.message);
  }
});

bot.catch((error, ctx) => {
  console.error(`Telegram error in update ${ctx.update?.update_id}:`, error);
});

bot.launch()
  .then(() => {
    console.log("🌸 نرگس کوچولو بیدار شد!");
    console.log(`🤖 AI model: ${AI_MODEL}`);
    console.log(`🎲 Random response rate: ${Math.round(RESPONSE_RATE * 100)}%`);
  })
  .catch((error) => {
    console.error("Failed to start Telegram bot:", error);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
