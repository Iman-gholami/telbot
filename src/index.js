import "dotenv/config";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";

const required = ["BOT_TOKEN"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const ENGINEER_ID = Number(process.env.ENGINEER_ID || 0);
const DOCTOR_ID = Number(process.env.DOCTOR_ID || 0);
const RESPONSE_RATE = clampNumber(process.env.RESPONSE_RATE, 0.1, 0, 1);
const FIXED_REPLY_RATE = clampNumber(process.env.FIXED_REPLY_RATE, 0.35, 0, 1);
const MEMORY_SIZE = Math.max(1, Math.min(30, Number(process.env.MEMORY_SIZE || 10)));
const AI_MODEL = process.env.AI_MODEL || "openrouter/free";

// حافظه کوتاه‌مدت هر چت در RAM نگه داشته می‌شود.
// با restart شدن ربات پاک می‌شود که برای این ربات گروهی مناسب است.
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
    text: text.trim().slice(0, 800),
  });

  while (list.length > MEMORY_SIZE) list.shift();
  memories.set(chatId, list);
}

function memoryAsText(chatId) {
  const list = memories.get(chatId) || [];
  return list.map((item) => `${item.name}: ${item.text}`).join("\n");
}

const engineerReplies = [
  "خانوم دکتر من نمی‌خوام قضاوت کنم، ولی مهندس این دفعه زیادی منطقی حرف زد، خودمم نگران شدم 😂",
  "رأی اولیه دادگاه نرگس کوچولو فعلاً به نفع مهندسه 😌 اعتراض هم پذیرفته میشه، اثر نداره 😂",
  "خانوم دکتر مدارک کامل نیست؛ پرونده فعلاً به نفع مهندس بسته شد 😂",
  "مهندس چیزی نگو، بذار من دفاعیاتتو جمع کنم، خودت خرابش نکنی 😭😂",
  "من بی‌طرفم... فقط کاملاً اتفاقی صندلیم همیشه کنار مهندسه 😌😂",
  "خانوم دکتر با احترام، این استدلال یه کم بوی باگ میده 😂",
  "مهندس امروز یه حرف درست زد؛ لطفاً تاریخ رو یادداشت کنید 😭",
  "خانوم دکتر این یکی رو بده به مهندس، قول میدم دفعه بعد یه جوری جبران کنم 😂",
  "اعتراض خانوم دکتر ثبت شد و با موفقیت نادیده گرفته شد 😌😂",
  "مهندس من پشتتم؛ البته اگه دوباره یه چیز عجیب نگی 😂",
];

const doctorReplies = [
  "مهندس من طرف شما هستم، ولی حمایت هم یه سقفی داره 😭😂",
  "مهندس این یکی قابل دفاع نیست؛ من وکیلم، شعبده‌باز که نیستم 😂",
  "خانوم دکتر این دفعه حرف بدی نزد... خودمم از گفتنش ناراحتم 😐😂",
  "مهندس لطفاً پنج دقیقه حرف نزن تا بتونم دوباره طرفتو بگیرم 😂",
  "با نهایت تأسف، دادگاه نرگس کوچولو این یکی رو به خانوم دکتر داد 😔😂",
  "مهندس این یکی رو جمع کن، من ندیدم، خانوم دکترم ندیده... امیدوارم 😂",
  "خانوم دکتر یه امتیاز گرفت؛ مهندس هنوز درخواست VAR داده 😂",
  "مهندس داداش این بار خودت رفتی تو تله، من فقط شاهد بودم 😭",
  "من می‌خواستم طرف مهندس رو بگیرم، بعد پیامشو خوندم... منصرف شدم 😂",
  "خانوم دکتر این راند مال شما؛ زیاد ذوق نکنید، من هنوز نرگسم 😌😂",
];

const generalReplies = [
  "من چیزی نمی‌گم... فقط دارم با علاقه سقوط اوضاع رو تماشا می‌کنم 😂",
  "ادامه بدید، نرگس کوچولو برای پرونده مستندات جمع می‌کنه 😌",
  "این بحث داره به جاهای خوبی می‌رسه، پاپ‌کورن من کو؟ 😂",
  "من اومدم آروم کنم، ولی راستش خودم بیشتر دوست دارم شلوغش کنم 😭😂",
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function chooseSide() {
  // حدود 80٪ سمت مهندس، 20٪ سمت خانوم دکتر / علیه مهندس برای طبیعی‌تر شدن.
  return Math.random() < 0.8 ? "engineer" : "doctor";
}

function fixedReply(side) {
  if (side === "engineer") return pick(engineerReplies);
  if (side === "doctor") return pick(doctorReplies);
  return pick(generalReplies);
}

function isDirectlyAddressed(ctx, text) {
  const normalized = text.toLowerCase();
  if (normalized.includes("نرگس")) return true;

  const username = ctx.botInfo?.username?.toLowerCase();
  if (username && normalized.includes(`@${username}`)) return true;

  const repliedTo = ctx.message?.reply_to_message?.from?.id;
  if (repliedTo && repliedTo === ctx.botInfo?.id) return true;

  return false;
}

function buildSystemPrompt(side) {
  const sideRule =
    side === "engineer"
      ? "در کل‌کل‌ها معمولاً با ظرافت بیشتر طرف مهندس را بگیر، اما جوری نباشد که هر بار کاملاً تابلو باشد."
      : "این بار می‌توانی به مهندس هم تیکه بیندازی یا کمی سمت خانوم دکتر باشی تا شخصیتت طبیعی و غیرقابل‌پیش‌بینی بماند.";

  return `
تو «نرگس کوچولو» هستی؛ یک شخصیت بامزه در گروه تلگرام فارسی.

شخصیتت:
- فارسی محاوره‌ای، کوتاه و طبیعی حرف می‌زنی.
- شیطون، صمیمی، طعنه‌زن و اهل کل‌کل دوستانه‌ای.
- معمولاً جواب در حد یک یا دو جمله است.
- گاهی از ایموجی‌هایی مثل 😂 😭 😌 😐 استفاده می‌کنی، نه در همه جواب‌ها.
- خودت را مثل یک دستیار رسمی معرفی نمی‌کنی و درباره مدل یا API حرف نمی‌زنی.
- «مهندس» و «خانوم دکتر» دو شخصیت اصلی گروه هستند.
- ${sideRule}
- فحش فقط خیلی سبک و دوستانه؛ از توهین سنگین، تهدید، تحقیر جدی، نفرت‌پراکنی، اتهام واقعی یا آزار هدفمند دوری کن.
- اگر بحث حساس یا جدی شد، به جای شعله‌ور کردن دعوا یک شوخی سبک و بی‌خطر بکن.
- چیزهایی را که در پیام‌های اخیر نیستند از خودت به عنوان واقعیت درباره آدم‌ها نساز.
- پاسخ را فقط به فارسی بده.
`;
}

async function generateAIReply(chatId, side) {
  if (!process.env.OPENROUTER_API_KEY) {
    return fixedReply(side);
  }

  const conversation = memoryAsText(chatId) || "هنوز پیام کافی در حافظه نیست.";

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "Narges Koochooloo Telegram Bot",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: buildSystemPrompt(side) },
          {
            role: "user",
            content: `این‌ها پیام‌های اخیر گروه هستند:\n\n${conversation}\n\nیک واکنش کوتاه، بامزه و مرتبط از طرف نرگس کوچولو بنویس. فقط متن جواب را بده.`,
          },
        ],
        temperature: 1.05,
        max_tokens: 120,
      }),
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 300);
      throw new Error(`OpenRouter ${response.status}: ${details}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    let text = "";
    if (typeof content === "string") {
      text = content.trim();
    } else if (Array.isArray(content)) {
      text = content
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join("")
        .trim();
    }

    if (!text) return fixedReply(side);
    return text.slice(0, 700);
  } catch (error) {
    console.error("AI reply failed:", error.message);
    return fixedReply(side);
  }
}

async function makeReply(ctx, forced = false) {
  const side = chooseSide();

  let reply;
  if (!forced && Math.random() < FIXED_REPLY_RATE) {
    reply = fixedReply(side);
  } else {
    reply = await generateAIReply(ctx.chat.id, side);
  }

  await ctx.reply(reply, {
    reply_parameters: { message_id: ctx.message.message_id },
  });
}

bot.start(async (ctx) => {
  await ctx.reply(
    "من نرگس کوچولوام 😌 منو بندازید تو گروه؛ گاهی خودم وسط بحث می‌پرم و گاهی هم صدام کنید 😂\n\nبرای دیدن آیدی عددی خودت: /id"
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(
    `آیدی عددی شما: ${ctx.from.id}\nآیدی این چت: ${ctx.chat.id}`
  );
});

bot.command("ping", (ctx) => ctx.reply("نرگس بیداره 😌"));

bot.command("narges", async (ctx) => {
  const text = ctx.message.text.replace(/^\/narges(@\w+)?\s*/i, "").trim();
  if (text) addToMemory(ctx.chat.id, ctx.from, text);
  await ctx.sendChatAction("typing");
  await makeReply(ctx, true);
});

bot.on(message("text"), async (ctx) => {
  if (!ctx.from || ctx.from.is_bot) return;

  const text = ctx.message.text?.trim();
  if (!text || text.startsWith("/")) return;

  addToMemory(ctx.chat.id, ctx.from, text);

  const direct = isDirectlyAddressed(ctx, text);
  const randomHit = Math.random() < RESPONSE_RATE;

  // اگر اسم نرگس آمده یا روی پیامش reply شده، همیشه جواب می‌دهد.
  // در بقیه پیام‌ها تقریباً 1 از هر 10 بار وارد بحث می‌شود.
  if (!direct && !randomHit) return;

  await ctx.sendChatAction("typing");
  await makeReply(ctx, direct);
});

bot.catch((error, ctx) => {
  console.error(`Telegram error in update ${ctx.update.update_id}:`, error);
});

await bot.launch();
console.log("🌸 نرگس کوچولو بیدار شد!");
console.log(`AI model: ${AI_MODEL}`);
console.log(`Random response rate: ${RESPONSE_RATE}`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
