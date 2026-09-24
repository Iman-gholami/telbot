import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import {
  BOT_TOKEN,
  ALLOWED_CHAT_IDS,
  ADMIN_IDS,
  ENGINEER_ID,
  AUTO_DEBOUNCE_SECONDS,
  DIRECT_FOLLOWUP_SECONDS,
  DOCTOR_BIAS,
  AUTO_MAX_PROB,
  ROAST_LEVEL,
} from "./config.js";
import {
  DB_PATH,
  BOT_SPEAKER,
  MEMORY_SUBJECTS,
  rememberMessage,
  getLongTermMemories,
  deleteLongTermMemoryLike,
  getSetting,
  setSetting,
  dbStats,
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
import { initModels, budget, monthlyBudget, currentModels, aiMetrics } from "./openrouter.js";
import { scheduleDigest } from "./digest.js";

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 120_000 });
const startedAt = Date.now();

function numberSetting(key, fallback, min, max) {
  const n = Number(getSetting(key, fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function boolSetting(key, fallback) {
  const raw = String(getSetting(key, fallback ? "1" : "0")).toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}
function isAdmin(ctx) {
  const ids = ADMIN_IDS.length ? ADMIN_IDS : (ENGINEER_ID ? [ENGINEER_ID] : []);
  return Boolean(ctx.from && ids.includes(Number(ctx.from.id)));
}
function humanUptime(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} دقیقه`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ساعت و ${min % 60} دقیقه`;
  return `${Math.floor(h / 24)} روز و ${h % 24} ساعت`;
}

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
  return { replyToSpeaker: speaker, replyToText: text.slice(0, 350) };
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
  try { result = await generateReply(ctx, { direct, text, ...replyContext(ctx) }); }
  finally { stopTyping?.(); }
  if (!result?.reply) return null;
  return sendAndRecord(ctx, result.reply, { replyToText: text });
}

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
  const delay = numberSetting("auto_debounce_seconds", AUTO_DEBOUNCE_SECONDS, 0, 120);
  entry.timer = setTimeout(async () => {
    pendingAuto.delete(chatId);
    if (busyAuto.has(chatId)) return;
    busyAuto.add(chatId);
    try { await respond(entry.ctx, { direct: false, text: entry.text }); }
    catch (error) { console.error("Auto reply failed:", error); }
    finally { busyAuto.delete(chatId); }
  }, delay * 1000);
  pendingAuto.set(chatId, entry);
}

const awaitingFollowup = new Map();
function followupKey(ctx) { return `${ctx.chat.id}:${ctx.from.id}`; }
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

function isAllowed(ctx) {
  if (!ALLOWED_CHAT_IDS.length || !ctx.chat) return true;
  if (ALLOWED_CHAT_IDS.includes(String(ctx.chat.id))) return true;
  return ctx.chat.type === "private" && Boolean(roleFromUser(ctx.from));
}

bot.command("id", (ctx) => ctx.reply(`آیدی عددی شما: ${ctx.from.id}\nآیدی این چت: ${ctx.chat.id}`));
bot.use((ctx, next) => (isAllowed(ctx) ? next() : undefined));

const HELP = `من نرگس کوچولوام 😌 بحث رو دنبال می‌کنم، مهندس و خانوم دکتر رو یادم می‌مونه و وقتی حرفی داشته باشم خودم هم می‌پرم وسط.

/memory حافظه دائمی
/remember متن — ذخیره دستی
/forget متن — فراموش کردن
/narges متن — جواب مستقیم
/status وضعیت AI، هزینه و حافظه
/settings پنل تنظیمات (ادمین)
/id آیدی عددی`;

bot.start((ctx) => ctx.reply(HELP));
bot.help((ctx) => ctx.reply(HELP));
bot.command("ping", (ctx) => ctx.reply("بیدارم 😌"));

bot.command("status", (ctx) => {
  const b = budget();
  const m = monthlyBudget();
  const a = aiMetrics();
  const d = dbStats();
  const models = currentModels();
  return ctx.reply([
    `🟢 آپ‌تایم: ${humanUptime(Date.now() - startedAt)}`,
    `🤖 مدل آخر: ${a.lastModel || "هنوز هیچ"}`,
    `🔁 درخواست‌ها: ${a.requests} | موفق: ${a.successes} | 429: ${a.rateLimits}`,
    `💳 fallback پولی: ${a.paidFallbacks} بار`,
    `🌐 سرچ وب: ${a.webSearches} بار`,
    `📊 سهمیه امروز: ${b.used}/${b.limit} — باقی ${b.remaining}`,
    `💰 هزینه ماه ${m.month}: $${m.spentUsd.toFixed(4)} / $${m.limitUsd.toFixed(2)} — باقی $${m.remainingUsd.toFixed(4)}`,
    `🧠 حافظه: ${d.memories} مورد | پیام DB: ${d.messages} | چت‌ها: ${d.chats}`,
    `🗃 DB: ${DB_PATH}`,
    `🧩 مسیر مدل‌ها: ${models.join(" → ") || "فقط fallback ثابت"}`,
    a.cooldownSeconds ? `⏳ cooldown: ${a.cooldownSeconds}s` : null,
    a.lastError ? `⚠️ آخرین خطا: ${a.lastError.slice(0, 250)}` : null,
  ].filter(Boolean).join("\n"));
});

bot.command("memory", (ctx) => {
  const blocks = MEMORY_SUBJECTS.map((subject) => {
    const rows = getLongTermMemories(subject, 15);
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
  if (!subjects.length) {
    await ctx.reply("مشخص کن اینو درباره مهندس یا خانوم دکتر یادم بمونه.");
    return;
  }
  const saved = subjects.filter((s) => saveLongTermMemory(s, content, { importance: 3, source }));
  await sendAndRecord(ctx, saved.length
    ? `باشه، اینو درباره ${saved.map(roleLabel).join(" و ")} یادم می‌مونه 😌`
    : "اینو نتونستم ذخیره کنم.");
}

bot.command("remember", async (ctx) => {
  const text = commandArg(ctx, "remember");
  if (!text) return ctx.reply("بعد از /remember بگو چی یادم بمونه 😌");
  await saveManual(ctx, text, inferMemorySubjects(text, roleFromUser(ctx.from)), "manual");
});

bot.command("forget", async (ctx) => {
  const text = commandArg(ctx, "forget");
  const needle = normalizeMemory(text);
  if (needle.length < 3) return ctx.reply("بعد از /forget حداقل یه کلمه از چیزی که می‌خوای فراموش کنم بنویس.");
  let changes = 0;
  for (const subject of MEMORY_SUBJECTS) changes += deleteLongTermMemoryLike(subject, needle);
  await ctx.reply(changes ? `اوکی، ${changes} مورد پاک شد.` : "چیزی با این مشخصات یادم نیست.");
});

bot.command("narges", async (ctx) => {
  const text = commandArg(ctx, "narges") || "نرگس";
  cancelAuto(ctx.chat.id);
  record(ctx, text);
  await respond(ctx, { direct: true, text });
});

function settingsText() {
  const bias = numberSetting("doctor_bias", DOCTOR_BIAS, 0, 1);
  const auto = numberSetting("auto_max_prob", AUTO_MAX_PROB, 0.02, 1);
  const roast = Math.round(numberSetting("roast_level", ROAST_LEVEL, 1, 3));
  const debounce = numberSetting("auto_debounce_seconds", AUTO_DEBOUNCE_SECONDS, 0, 120);
  return `⚙️ تنظیمات نرگس\n\n👩‍⚕️ گرایش به دکتر در کل‌کل: ${Math.round(bias * 100)}%\n💬 ورود خودکار: حداکثر ${Math.round(auto * 100)}%\n🌶 شدت تیکه: ${roast}/3\n⏱ مکث ورود: ${debounce}s\n🌐 سرچ وب: ${boolSetting("web_search", true) ? "روشن" : "خاموش"}\n💳 fallback پولی: ${boolSetting("paid_fallback", true) ? "روشن" : "خاموش"}`;
}
function settingsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("دکتر 55%", "cfg:bias:0.55"), Markup.button.callback("65%", "cfg:bias:0.65"), Markup.button.callback("75%", "cfg:bias:0.75")],
    [Markup.button.callback("ورود کم", "cfg:auto:0.25"), Markup.button.callback("متوسط", "cfg:auto:0.38"), Markup.button.callback("زیاد", "cfg:auto:0.55")],
    [Markup.button.callback("تیکه 1", "cfg:roast:1"), Markup.button.callback("تیکه 2", "cfg:roast:2"), Markup.button.callback("تیکه 3", "cfg:roast:3")],
    [Markup.button.callback("🌐 روشن/خاموش", "cfg:toggle:web"), Markup.button.callback("💳 پولی روشن/خاموش", "cfg:toggle:paid")],
  ]);
}

bot.command("settings", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("این پنل فقط برای ادمینه.");
  return ctx.reply(settingsText(), settingsKeyboard());
});

bot.action(/^cfg:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("فقط ادمین", { show_alert: true });
  const parts = ctx.match[1].split(":");
  const [kind, value] = parts;
  if (kind === "bias") setSetting("doctor_bias", value);
  else if (kind === "auto") setSetting("auto_max_prob", value);
  else if (kind === "roast") setSetting("roast_level", value);
  else if (kind === "toggle" && value === "web") setSetting("web_search", boolSetting("web_search", true) ? "0" : "1");
  else if (kind === "toggle" && value === "paid") setSetting("paid_fallback", boolSetting("paid_fallback", true) ? "0" : "1");
  await ctx.answerCbQuery("ذخیره شد");
  await ctx.editMessageText(settingsText(), settingsKeyboard()).catch(() => {});
});

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
  if (entry) scheduleAuto(entry.ctx, entry.text);
  if (ctx.message.caption && isDirectlyAddressed(ctx, ctx.message.caption)) {
    cancelAuto(ctx.chat.id);
    await respond(ctx, { direct: true, text: described });
  }
});

bot.catch((error, ctx) => console.error(`Telegram error in update ${ctx.update?.update_id}:`, error));

const models = await initModels();
bot.launch({ allowedUpdates: ["message", "callback_query"] }, () => {
  console.log("🌸 نرگس کوچولو V4 بیدار شد!");
  console.log(`🤖 AI routes: ${models.join(" → ") || "none (fixed replies only)"}`);
  console.log(`🧠 Memory DB: ${DB_PATH}`);
  if (!ALLOWED_CHAT_IDS.length) console.warn("⚠️ ALLOWED_CHAT_IDS خالیه؛ ربات در هر گروهی جواب می‌ده.");
}).catch((error) => {
  console.error("Failed to start Telegram bot:", error);
  process.exit(1);
});

function shutdown(signal) {
  try { bot.stop(signal); }
  finally { closeDb(); }
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
