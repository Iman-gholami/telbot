import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import {
  BOT_TOKEN,
  ALLOWED_CHAT_IDS,
  AUTO_DEBOUNCE_SECONDS,
  DIRECT_FOLLOWUP_SECONDS,
  DOCTOR_BIAS,
} from "./config.js";
import {
  DB_PATH,
  BOT_SPEAKER,
  MEMORY_SUBJECTS,
  rememberMessage,
  getLongTermMemories,
  deleteLongTermMemoryLike,
  closeDb,
} from "./db.js";
import {
  displayName,
  roleFromUser,
  roleLabel,
  looksSensitive,
  inferMemorySubjects,
  extractManualMemory,
  normalizeMemory,
  saveLongTermMemory,
} from "./memory.js";
import { isDirectlyAddressed, isBareCall, interventionProbability } from "./behavior.js";
import { generateReply } from "./ai.js";
import { initModels, budget, currentModels } from "./openrouter.js";
import { scheduleDigest } from "./digest.js";

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 120_000 });

// ---------- Helpers ----------

function describeMedia(msg) {
  if (!msg) return null;
  const caption = msg.caption ? ` ${msg.caption}` : "";
  if (msg.sticker) return `[استیکر ${msg.sticker.emoji || ""}]`.replace(" ]", "]");
  if (msg.photo) return `[عکس]${caption}`;
  if (msg.animation) return `[گیف]${caption}`;
  if (msg.video) return `[ویدیو]${caption}`;
  if (msg.video_note) return "[ویدیو مسیج]";
  if (msg.voice) return "[ویس]";
  if (msg.audio) return `[آهنگ${msg.audio.title ? `: ${msg.audio.title}` : ""}]${caption}`;
  if (msg.document) return `[فایل]${caption}`;
  if (msg.poll) return `[نظرسنجی: ${msg.poll.question}]`;
  if (msg.location) return "[لوکیشن]";
  if (msg.contact) return "[کانتکت]";
  return null;
}

function replyContext(ctx) {
  const r = ctx.message?.reply_to_message;
  if (!r) return {};
  const text = r.text || describeMedia(r);
  if (!text) return {};
  const speaker = r.from?.id === ctx.botInfo?.id ? BOT_SPEAKER : displayName(r.from);
  return { replyToSpeaker: speaker, replyToText: text.slice(0, 300) };
}

function record(ctx, text) {
  rememberMessage({
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id,
    speaker: displayName(ctx.from),
    userId: ctx.from.id,
    text,
    ...replyContext(ctx),
  });
  scheduleDigest(ctx.chat.id);
}

function keepTyping(ctx) {
  const send = () => ctx.sendChatAction("typing").catch(() => {});
  send();
  const timer = setInterval(send, 4500);
  return () => clearInterval(timer);
}

async function sendAndRecord(ctx, text, { replyToText } = {}) {
  const sent = await ctx.reply(text, {
    reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
  });
  rememberMessage({
    chatId: ctx.chat.id,
    messageId: sent.message_id,
    speaker: BOT_SPEAKER,
    userId: ctx.botInfo?.id,
    text,
    replyToSpeaker: displayName(ctx.from),
    replyToText: replyToText ?? ctx.message.text ?? ctx.message.caption ?? null,
  });
  return sent;
}

async function respond(ctx, { direct, text }) {
  const stopTyping = direct ? keepTyping(ctx) : null;
  let result;
  try {
    result = await generateReply(ctx, { direct, text, ...replyContext(ctx) });
  } finally {
    stopTyping?.();
  }
  if (!result?.reply) return null;
  return sendAndRecord(ctx, result.reply, { replyToText: text });
}

// ---------- Timing: debounce & follow-ups ----------

// ورود خودکار: صبر می‌کنه تا رگبار پیام‌ها تموم بشه، بعد به آخرین پیام جواب می‌ده
const pendingAuto = new Map();
const busyAuto = new Set();

function cancelAuto(chatId) {
  const entry = pendingAuto.get(chatId);
  if (entry) clearTimeout(entry.timer);
  pendingAuto.delete(chatId);
}

function scheduleAuto(ctx, text) {
  const chatId = ctx.chat.id;
  cancelAuto(chatId);
  const entry = { ctx, text };
  entry.timer = setTimeout(async () => {
    pendingAuto.delete(chatId);
    if (busyAuto.has(chatId)) return;
    busyAuto.add(chatId);
    try {
      await respond(entry.ctx, { direct: false, text: entry.text });
    } catch (error) {
      console.error("Auto reply failed:", error);
    } finally {
      busyAuto.delete(chatId);
    }
  }, AUTO_DEBOUNCE_SECONDS * 1000);
  pendingAuto.set(chatId, entry);
}

// وقتی فقط «نرگس» رو صدا می‌زنن، چند ثانیه صبر می‌کنه ببینه پیام بعدی‌شون چیه
const awaitingFollowup = new Map();

function followupKey(ctx) {
  return `${ctx.chat.id}:${ctx.from.id}`;
}

function awaitFollowup(ctx, text) {
  const key = followupKey(ctx);
  clearTimeout(awaitingFollowup.get(key)?.timer);
  const entry = { ctx, text };
  entry.timer = setTimeout(() => {
    awaitingFollowup.delete(key);
    respond(ctx, { direct: true, text }).catch((e) => console.error("Follow-up reply failed:", e));
  }, DIRECT_FOLLOWUP_SECONDS * 1000);
  awaitingFollowup.set(key, entry);
}

function takeFollowup(ctx) {
  const key = followupKey(ctx);
  const entry = awaitingFollowup.get(key);
  if (!entry) return null;
  clearTimeout(entry.timer);
  awaitingFollowup.delete(key);
  return entry;
}

// ---------- Access control ----------

function isAllowed(ctx) {
  if (!ALLOWED_CHAT_IDS.length || !ctx.chat) return true;
  if (ALLOWED_CHAT_IDS.includes(String(ctx.chat.id))) return true;
  return ctx.chat.type === "private" && Boolean(roleFromUser(ctx.from));
}

// /id همه‌جا کار می‌کنه تا بشه آیدی گروه رو پیدا کرد
bot.command("id", (ctx) => ctx.reply(`آیدی عددی شما: ${ctx.from.id}\nآیدی این چت: ${ctx.chat.id}`));

bot.use((ctx, next) => (isAllowed(ctx) ? next() : undefined));

// ---------- Commands ----------

const HELP = `من نرگس کوچولوام 😌 بحث‌ها رو دنبال می‌کنم، آدما رو یادم می‌مونه و هر وقت حرف حسابی داشتم می‌پرم وسط.

/memory چیزایی که یادمه
/remember متن — یه چیزی رو یادم بمونه
/forget متن — یه چیزی رو فراموش کنم
/narges متن — مجبورم کن جواب بدم
/status وضعیت و سهمیه امروز
/id آیدی عددی

یا کافیه بگی «نرگس یادت باشه که ...»`;

bot.start((ctx) => ctx.reply(HELP));
bot.help((ctx) => ctx.reply(HELP));

bot.command("ping", (ctx) => ctx.reply("بیدارم 😌 خانوم دکتر خیالتون راحت، مهندس هنوز تحت نظارته 😂"));

bot.command("status", (ctx) => {
  const b = budget();
  const models = currentModels();
  return ctx.reply(
    `سهمیه امروز: ${b.used} از ${b.limit} (باقی‌مانده ${b.remaining})\nمدل‌ها: ${models.join("، ") || "—"}`
  );
});

bot.command("memory", (ctx) => {
  const blocks = MEMORY_SUBJECTS.map((subject) => {
    const rows = getLongTermMemories(subject, 12);
    const title = roleLabel(subject);
    return rows.length ? `${title}:\n${rows.map((x) => `• ${x.content}`).join("\n")}` : `${title}: هنوز چیزی ندارم.`;
  });
  return ctx.reply(blocks.join("\n\n"));
});

function commandArg(ctx, name) {
  return ctx.message.text.replace(new RegExp(`^/${name}(@\\w+)?\\s*`, "i"), "").trim();
}

async function saveManual(ctx, content, subjects, source) {
  if (looksSensitive(content)) {
    await ctx.reply("این یکی زیادی حساسه؛ رمز، اطلاعات مالی و چیزای خصوصی رو نگه نمی‌دارم 🌱");
    return;
  }
  const saved = subjects.filter((s) => saveLongTermMemory(s, content, { importance: 3, source }));
  const reply = saved.length
    ? `باشه، اینو درباره ${saved.map(roleLabel).join(" و ")} یادم می‌مونه 😌`
    : "اینو نتونستم ذخیره کنم.";
  await sendAndRecord(ctx, reply);
}

bot.command("remember", async (ctx) => {
  const text = commandArg(ctx, "remember");
  if (!text) return ctx.reply("بعد از /remember بگو چی یادم بمونه 😌");
  await saveManual(ctx, text, inferMemorySubjects(text, roleFromUser(ctx.from)), "manual");
});

bot.command("forget", async (ctx) => {
  const text = commandArg(ctx, "forget");
  const needle = normalizeMemory(text);
  if (needle.length < 3) {
    return ctx.reply("بعد از /forget حداقل یه کلمه از چیزی که می‌خوای فراموش کنم بنویس.");
  }
  let changes = 0;
  for (const subject of MEMORY_SUBJECTS) changes += deleteLongTermMemoryLike(subject, needle);
  await ctx.reply(changes ? `اوکی، ${changes} مورد از حافظه‌م پاک شد.` : "چیزی با این مشخصات یادم نیست.");
});

bot.command("narges", async (ctx) => {
  const text = commandArg(ctx, "narges") || "نرگس";
  cancelAuto(ctx.chat.id);
  record(ctx, text);
  await respond(ctx, { direct: true, text });
});

// ---------- Messages ----------

bot.on(message("text"), async (ctx) => {
  if (!ctx.from || ctx.from.is_bot) return;
  const text = ctx.message.text?.trim();
  if (!text || text.startsWith("/")) return;

  const chatId = ctx.chat.id;
  record(ctx, text);

  const manual = extractManualMemory(text, roleFromUser(ctx.from));
  if (manual) {
    cancelAuto(chatId);
    takeFollowup(ctx);
    await saveManual(ctx, manual.content, manual.subjects, "manual-natural");
    return;
  }

  // قبلاً فقط اسمش رو صدا زده بودن؛ این پیام ادامه‌شه
  const waiting = takeFollowup(ctx);
  if (waiting) {
    cancelAuto(chatId);
    await respond(ctx, { direct: true, text: `${waiting.text}\n${text}` });
    return;
  }

  if (isDirectlyAddressed(ctx, text)) {
    cancelAuto(chatId);
    if (DIRECT_FOLLOWUP_SECONDS > 0 && isBareCall(ctx, text)) {
      awaitFollowup(ctx, text);
      return;
    }
    await respond(ctx, { direct: true, text });
    return;
  }

  // اگه منتظر ورود خودکار بودیم، هدف رو به جدیدترین پیام منتقل کن و تایمر رو از نو بشمار
  if (pendingAuto.has(chatId)) {
    scheduleAuto(ctx, text);
    return;
  }

  if (Math.random() < interventionProbability(ctx, text)) scheduleAuto(ctx, text);
});

bot.on("message", async (ctx) => {
  if (!ctx.from || ctx.from.is_bot) return;
  const described = describeMedia(ctx.message);
  if (!described) return;

  record(ctx, described);

  const entry = pendingAuto.get(ctx.chat.id);
  if (entry) scheduleAuto(entry.ctx, entry.text); // بحث هنوز داغه؛ صبر کن

  if (ctx.message.caption && isDirectlyAddressed(ctx, ctx.message.caption)) {
    cancelAuto(ctx.chat.id);
    await respond(ctx, { direct: true, text: described });
  }
});

bot.catch((error, ctx) => {
  console.error(`Telegram error in update ${ctx.update?.update_id}:`, error);
});

// ---------- Startup ----------

const models = await initModels();

bot
  .launch({ allowedUpdates: ["message"] }, () => {
    console.log("🌸 نرگس کوچولو V3 بیدار شد!");
    console.log(`🤖 AI models: ${models.join(", ") || "none (fixed replies only)"}`);
    console.log(`🧠 Memory DB: ${DB_PATH}`);
    console.log(`👩‍⚕️ Doctor bias in banter: ${Math.round(DOCTOR_BIAS * 100)}%`);
    if (!ALLOWED_CHAT_IDS.length) console.warn("⚠️ ALLOWED_CHAT_IDS خالیه؛ ربات در هر گروهی جواب می‌ده.");
  })
  .catch((error) => {
    console.error("Failed to start Telegram bot:", error);
    process.exit(1);
  });

function shutdown(signal) {
  try {
    bot.stop(signal);
  } finally {
    closeDb();
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
