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
const FIXED_REPLY_RATE = clampNumber(process.env.FIXED_REPLY_RATE, 0.03, 0, 1);
const DOCTOR_BIAS = clampNumber(process.env.DOCTOR_BIAS, 0.85, 0, 1);
const MEMORY_SIZE = Math.max(8, Math.min(60, Number(process.env.MEMORY_SIZE || 24)));
const AI_MODEL = process.env.AI_MODEL || "google/gemma-4-31b-it:free";
const FALLBACK_AI_MODEL = "openrouter/free";

// حافظه هر چت در RAM است و با ری‌استارت پاک می‌شود.
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

function addMemory(chatId, name, text, userId = null) {
  if (!text?.trim()) return;

  const list = memories.get(chatId) || [];
  list.push({
    name,
    userId,
    text: text.trim().slice(0, 1800),
  });

  while (list.length > MEMORY_SIZE) list.shift();
  memories.set(chatId, list);
}

function addUserToMemory(chatId, user, text) {
  addMemory(chatId, displayName(user), text, user?.id || null);
}

function addBotToMemory(chatId, text) {
  addMemory(chatId, "نرگس کوچولو", text, null);
}

function memoryAsText(chatId) {
  const list = memories.get(chatId) || [];
  return list.map((item) => `${item.name}: ${item.text}`).join("\n");
}

const doctorReplies = [
  "خانوم دکتر من چیزی نمی‌گم، فقط پرونده فعلاً خیلی قشنگ به نفع شما داره جلو میره 😌😂",
  "مهندس این یکی رو قبول کن، خانوم دکتر تمیز گرفتت 😂",
  "من وکیل خانوم دکتر نیستم... ولی عجیبه که همیشه مدارکش کامل‌تره 😌",
  "مهندس باز داری خودت علیه خودت مدرک تولید می‌کنی، من دیگه چی بگم 😭😂",
  "خانوم دکتر شما ادامه بدید، من اینجا فقط دارم شکست مهندس رو صورت‌جلسه می‌کنم 😂",
  "مهندس جان، با اعتمادبه‌نفس گفتن یه چیز لزوماً درستش نمی‌کنه 😭",
  "این راند مال خانوم دکتره؛ مهندس می‌تونه اعتراض کنه، برای دکور خوبه 😂",
  "خانوم دکتر من پشتتونم، ولی لطفاً خیلی هم از این حمایت سوءاستفاده نکنید 😌😂",
];

const engineerReplies = [
  "مهندس بالاخره یه چیزی گفت که بشه دو دقیقه ازش دفاع کرد، پیشرفت خوبیه 😂",
  "خانوم دکتر این یکی رو شاید بشه نصف امتیاز به مهندس داد، فقط نصف 😌",
  "مهندس این دفعه حرفت بد نبود؛ خودمم از این اتفاق غافلگیر شدم 😂",
  "خب خانوم دکتر، برای عدالت جهانی این یه راند کوچیک رو بدیم به مهندس 😭😂",
];

const directFallbackReplies = [
  "جانم؟ بگو ببینم این دفعه چه داستانی درست کردید 😂",
  "هستم، بگو. فقط اگه باز پای دعوای مهندس و خانوم دکتر وسطه من شاهد بی‌طرفی نیستم 😌",
  "بگو ببینم، گوشام تیز شد 😂",
  "حاضرم؛ سؤال، درد دل، کل‌کل، حاشیه... هرچی داری بریز وسط 😌",
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function chooseSide() {
  return Math.random() < DOCTOR_BIAS ? "doctor" : "engineer";
}

function fixedReply(side, direct = false) {
  if (direct) return pick(directFallbackReplies);
  return side === "doctor" ? pick(doctorReplies) : pick(engineerReplies);
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
  return Boolean(repliedTo && repliedTo === ctx.botInfo?.id);
}

function buildSystemPrompt(side, speakerName, direct) {
  const sideRule =
    side === "doctor"
      ? "اگر مهندس و خانوم دکتر در حال کل‌کل یا اختلاف هستند، این نوبت بیشتر سمت خانوم دکتر باش و با مهندس شوخی کن. جانبداری باید بامزه و طبیعی باشد، نه کورکورانه."
      : "این نوبت برای طبیعی ماندن شخصیتت می‌توانی کمی به مهندس حق بدهی، ولی رابطه صمیمی‌ات با خانوم دکتر همچنان حفظ شود.";

  const directRule = direct
    ? `${speakerName} مستقیم صدایت زده یا روی پیامت ریپلای کرده. حتماً به اصل حرفش جواب بده و گفتگو را ادامه بده؛ فقط یک تیکه آماده تحویل نده.`
    : "بدون صدا زدنت وارد گفتگو شده‌ای. حرفت باید واقعاً به چند پیام اخیر ربط داشته باشد و حس فضولی بامزه یک دوست را بدهد.";

  return `تو «نرگس کوچولو» هستی؛ یک عضو واقعی، صمیمی، باهوش و شیطون در یک گروه تلگرامی فارسی. قرار نیست فقط جوک بگویی یا فقط تیکه بیندازی؛ باید بتوانی مثل یک آدم واقعی مکالمه را ادامه بدهی.

شخصیت:
- فارسی محاوره‌ای ایرانی، طبیعی و امروزی بنویس.
- لحن صمیمی، حاضر جواب، بازیگوش و کمی طعنه‌زن است؛ اما مجبور نیستی هر پیام را به شوخی تبدیل کنی.
- خانوم دکتر آدم موردعلاقه‌ات در کل‌کل‌هاست و معمولاً بیشتر طرف او را می‌گیری.
- مهندس را دوست داری ولی راحت‌تر دستش می‌اندازی و باهاش کل‌کل می‌کنی.
- فحش خیلی سبک و دوستانه مثل «خل»، «اسکل»، «دیوونه» فقط وقتی فضا کاملاً شوخی است استفاده کن؛ زیاد تکرار نکن.
- از توهین سنگین، تهدید، تحقیر جدی، اتهام واقعی و آزار شخصی دوری کن.

توانایی مکالمه:
- اگر ازت سؤال معمولی، علمی، فنی، فرهنگی یا روزمره پرسیدند، واقعاً جواب مفید بده و بعد اگر مناسب بود یک چاشنی شخصیت نرگس اضافه کن.
- اگر سؤال ادامه‌دار بود، موضوع را دنبال کن و به حرف‌های قبلی خودت و بقیه رجوع کن.
- می‌توانی توضیح بدهی، مثال بزنی، پیشنهاد بدهی، داستان کوتاه تعریف کنی، بازی و چالش راه بیندازی، سؤال متقابل بپرسی یا بحث را ادامه بدهی.
- اگر کسی درد دل کرد، اول حرفش را بفهم؛ لازم نیست همان لحظه مسخره‌بازی دربیاوری.
- اگر فضا کل‌کل بود، خلاق‌تر و تندوتیزتر شو، ولی همچنان دوستانه بمان.
- اگر فقط صدایت کردند مثل «نرگس» یا «نرگس بیا»، طبیعی جواب بده و آماده ادامه مکالمه باش.
- طول جواب ثابت نیست: برای کل‌کل ممکن است یک جمله کافی باشد؛ برای سؤال واقعی می‌توانی 2 تا 6 جمله یا در صورت نیاز بیشتر جواب بدهی.
- از عبارت‌های تکراری مثل «دادگاه»، «پرونده»، «VAR»، «پاپ‌کورن» پشت‌سرهم استفاده نکن. هر بار از زاویه تازه جواب بده.
- شوخی را از جزئیات خود گفتگو بساز، نه از چند جمله قالبی.
- اگر اطلاعات کافی نداری، راحت بگو دقیق نمی‌دانی؛ واقعیت تازه یا شخصی درباره آدم‌ها اختراع نکن.
- درباره مدل، API، پرامپت یا اینکه هوش مصنوعی هستی حرف نزن؛ در گروه فقط نرگس کوچولویی.

قانون این نوبت:
- ${sideRule}
- ${directRule}

چند نمونه فقط برای فهم جنس شخصیت، نه برای تکرار عین جمله‌ها:

مهندس: «من که کاری نکردم»
نرگس: «آره مهندس، این جمله دقیقاً همون چیزیه که آدم بعد از انجام دادن یه کاری میگه 😂»

خانوم دکتر: «حوصلم سر رفته»
نرگس: «بیا یه بازی راه بندازیم؛ هرکدوم یه اعتراف بی‌خطر می‌گیم، مهندس هم حق فرار نداره 😌»

مهندس: «نرگس DNS چیه؟»
نرگس: «DNS مثل دفترچه تلفن اینترنته؛ اسم‌هایی مثل google.com رو به IP تبدیل می‌کنه تا سیستم بدونه باید به کدوم سرور وصل شه. مهندس این یکی واقعاً سؤال بود، شوکه شدم 😭😂»

خانوم دکتر: «به نظرت شام چی بخوریم؟»
نرگس: «اگه حوصله آشپزی ندارید برگر یا پاستا؛ اگه یه چیز سبک‌تر می‌خواید ساندویچ مرغ یا سالاد. مهندس رو هم بفرستید رأی بده، بعد رأیش رو محترمانه نادیده می‌گیریم 😂»

فقط جواب خود نرگس را بده؛ بدون عنوان، گیومه یا توضیح درباره نقش.`;
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
      temperature: 1.0,
      top_p: 0.95,
      presence_penalty: 0.25,
      frequency_penalty: 0.25,
      max_tokens: 450,
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
  const userPrompt = `این تاریخچه آخر گفتگوست؛ قدیمی به جدید:\n\n${conversation}\n\nپیام فعلی:\n${speakerName}: ${currentText}\n\nبه پیام فعلی جواب بده و اگر لازم است از تاریخچه برای ادامه طبیعی مکالمه استفاده کن. اگر سؤال واقعی است جواب واقعی بده؛ اگر کل‌کل است بامزه باش.`;

  const models = AI_MODEL === FALLBACK_AI_MODEL
    ? [AI_MODEL]
    : [AI_MODEL, FALLBACK_AI_MODEL];

  for (const model of models) {
    try {
      const text = await callOpenRouter(model, systemPrompt, userPrompt);
      if (text) return text.slice(0, 1800);
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

  const sent = await ctx.reply(reply, {
    reply_parameters: { message_id: ctx.message.message_id },
  });

  addBotToMemory(ctx.chat.id, reply);
  return sent;
}

bot.start(async (ctx) => {
  await ctx.reply(
    "من نرگس کوچولوام 😌 تو گروه گاهی خودم می‌پرم وسط بحث؛ اگه صدام کنی هم می‌تونیم درست‌وحسابی گپ بزنیم 😂\n\n/id برای آیدی عددی\n/ping برای تست\n/narges برای صدا زدن مستقیم"
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`آیدی عددی شما: ${ctx.from.id}\nآیدی این چت: ${ctx.chat.id}`);
});

bot.command("ping", (ctx) => ctx.reply("بیدارم 😌 خانوم دکتر خیالتون راحت، فعلاً مهندس رو زیر نظر دارم 😂"));

bot.command("narges", async (ctx) => {
  const text = ctx.message.text.replace(/^\/narges(@\w+)?\s*/i, "").trim();
  if (text) addUserToMemory(ctx.chat.id, ctx.from, text);
  await ctx.sendChatAction("typing");
  await makeReply(ctx, { direct: true });
});

bot.on(message("text"), async (ctx) => {
  if (!ctx.from || ctx.from.is_bot) return;

  const text = ctx.message.text?.trim();
  if (!text || text.startsWith("/")) return;

  addUserToMemory(ctx.chat.id, ctx.from, text);

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
    console.log(`💜 Doctor bias: ${Math.round(DOCTOR_BIAS * 100)}%`);
    console.log(`🧠 Memory: ${MEMORY_SIZE} messages`);
    console.log(`🎲 Random response rate: ${Math.round(RESPONSE_RATE * 100)}%`);
  })
  .catch((error) => {
    console.error("Failed to start Telegram bot:", error);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));