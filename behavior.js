import { DOCTOR_BIAS, AUTO_COOLDOWN_SECONDS, AUTO_MAX_PROB } from "./config.js";
import { recentHistory, lastBotAt, BOT_SPEAKER } from "./db.js";
import { normalizePersian, roleFromUser } from "./memory.js";

const CALL_NAMES = ["نرگس کوچولو", "خانوم نرگس", "خانم نرگس", "نرگسی", "نرگس", "narges"];

export function isDirectlyAddressed(ctx, text) {
  if (ctx.chat?.type === "private") return true;

  const n = normalizePersian(text);
  if (CALL_NAMES.some((name) => n.includes(name))) return true;

  const username = ctx.botInfo?.username?.toLowerCase();
  if (username && n.includes(`@${username}`)) return true;

  return isReplyToBot(ctx);
}

export function isReplyToBot(ctx) {
  const repliedTo = ctx.message?.reply_to_message?.from?.id;
  return Boolean(repliedTo && repliedTo === ctx.botInfo?.id);
}

// «نرگس» یا «نرگس جان؟» بدون هیچ حرف دیگه
export function isBareCall(ctx, text) {
  if (ctx.chat?.type === "private" || isReplyToBot(ctx)) return false;
  let n = normalizePersian(text);
  const username = ctx.botInfo?.username?.toLowerCase();
  if (username) n = n.replaceAll(`@${username}`, " ");
  for (const name of CALL_NAMES) n = n.replaceAll(name, " ");
  const FILLER = new Set(["جان", "جون", "جونم", "کجایی", "هستی", "هی", "اهای", "آهای", "بیا", "عزیزم"]);
  const rest = n
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !FILLER.has(w));
  return rest.length === 0;
}

const SERIOUS =
  /(ناراحت|غمگین|حالم بده|حالم خوب نیست|استرس|نگران|دعوا جدی|مشکل جدی|خسته شدم|گریه|افسرده|بیمارستان|تسلیت|فوت)/;
const BANTER =
  /(😂|🤣|خخخ|ههه|کل.?کل|باز شروع|چی میگی|نه بابا|گیر دادی|برو بابا|زر نزن|اسکل|خل|دیوونه|مسخره)/;

export function detectConversationMode(text, chatId) {
  const n = normalizePersian(text);
  const recent = recentHistory(chatId, 6).map((x) => normalizePersian(x.text));

  if (SERIOUS.test(n) || recent.slice(-3).some((x) => SERIOUS.test(x))) {
    return { mood: "calm", roastLevel: 1, banter: false };
  }

  const activeBanter = BANTER.test(n) || recent.some((x) => BANTER.test(x));
  const mainActive = recentHistory(chatId, 6).filter((x) => ["مهندس", "خانوم دکتر"].includes(x.speaker)).length >= 3;

  if (activeBanter && mainActive) return { mood: "roast", roastLevel: Math.random() < 0.4 ? 3 : 2, banter: true };
  if (activeBanter) return { mood: "playful", roastLevel: 2, banter: true };
  if (/[؟?]/.test(n)) return { mood: "smart", roastLevel: 1, banter: false };
  return { mood: "playful", roastLevel: 1, banter: false };
}

export function chooseSide() {
  return Math.random() < DOCTOR_BIAS ? "doctor" : "engineer";
}

const LOW_CONTENT =
  /^(باشه|اوکی|اوکیه|ok|okay|آره|اره|نه|مرسی|ممنون|مرسی مرسی|خب|خوب|اها|آها|اهان|هوم|اوهوم|عه|جدی|چشم|سلام|بای|شب بخیر|صبح بخیر)[.!؟?]*$/;

export function interventionProbability(ctx, text) {
  const chatId = ctx.chat.id;
  const n = normalizePersian(text);
  if (n.length < 4 || LOW_CONTENT.test(n)) return 0;

  const history = recentHistory(chatId, 10);
  const previous = history.slice(0, -1); // پیام فعلی از قبل ذخیره شده
  const now = Date.now();

  // اگه پیام، ریپلای به یه آدم دیگه‌ست، روی سر اون دو نفر نپر
  const repliesToHuman = Boolean(ctx.message?.reply_to_message) && !ctx.message.reply_to_message.from?.is_bot;

  // ادامه گفتگو با خود نرگس: تازه حرف زده و این پیام احتمالاً جوابشه
  const botJustSpoke = previous
    .slice(-3)
    .some((x) => x.speaker === BOT_SPEAKER && now - x.created_at < 3 * 60 * 1000);
  if (botJustSpoke && !repliesToHuman) return 0.4;

  if ((now - lastBotAt(chatId)) / 1000 < AUTO_COOLDOWN_SECONDS) return 0;

  let p = 0.01;
  if (roleFromUser(ctx.from)) p += 0.03;
  if (/[؟?]/.test(n)) p += 0.07;
  if (/مهندس|خانوم دکتر|خانم دکتر/.test(n)) p += 0.12;
  if (BANTER.test(n)) p += 0.15;
  if (/(حوصلم|حوصله|عصبانی|خسته|باحال|عجیبه|جدی میگی|نظرت|به نظرتون)/.test(n)) p += 0.07;
  if (n.length > 90) p += 0.03;
  if (repliesToHuman) p *= 0.5;

  const recentMain = previous.slice(-6).filter((x) => ["مهندس", "خانوم دکتر"].includes(x.speaker));
  const bothActive =
    recentMain.some((x) => x.speaker === "مهندس") && recentMain.some((x) => x.speaker === "خانوم دکتر");
  if (bothActive) p += 0.1;

  const alternating =
    recentMain.length >= 4 && recentMain.slice(-4).every((x, i, arr) => i === 0 || x.speaker !== arr[i - 1].speaker);
  if (alternating) p += 0.08;

  return Math.min(AUTO_MAX_PROB, p);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// فقط وقتی صدا زدن و AI در دسترس نیست استفاده می‌شه
export function fixedFallback({ quotaExhausted = false } = {}) {
  if (quotaExhausted) {
    return pick([
      "امروز انقدر حرف زدم مغزم هنگ کرده 😵‍💫 فردا مفصل جوابتو می‌دم",
      "باتری مغزم برای امروز تموم شده؛ فردا با انرژی کامل برمی‌گردم 😌",
    ]);
  }
  return pick([
    "جانم؟ یه لحظه حواسم پرت شد، دوباره بگو 😅",
    "هستم، ولی الان ذهنم یه کم قفله؛ چند دقیقه دیگه دوباره صدام کن",
    "ببخشید، یه لحظه قاطی کردم؛ دوباره بپرس 🙈",
  ]);
}
