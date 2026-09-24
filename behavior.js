import { DOCTOR_BIAS, AUTO_COOLDOWN_SECONDS, AUTO_MAX_PROB, ROAST_LEVEL } from "./config.js";
import { recentHistory, lastBotAt, BOT_SPEAKER, getSetting } from "./db.js";
import { normalizePersian, roleFromUser } from "./memory.js";

const CALL_NAMES = ["نرگس کوچولو", "خانوم نرگس", "خانم نرگس", "نرگسی", "نرگس", "narges"];

function numSetting(key, fallback, min, max) {
  const n = Number(getSetting(key, fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

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

export function isBareCall(ctx, text) {
  if (ctx.chat?.type === "private" || isReplyToBot(ctx)) return false;
  let n = normalizePersian(text);
  const username = ctx.botInfo?.username?.toLowerCase();
  if (username) n = n.replaceAll(`@${username}`, " ");
  for (const name of CALL_NAMES) n = n.replaceAll(name, " ");
  const filler = new Set(["جان", "جون", "جونم", "کجایی", "هستی", "هی", "اهای", "آهای", "بیا", "عزیزم"]);
  const rest = n.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !filler.has(w));
  return rest.length === 0;
}

const SERIOUS = /(ناراحت|غمگین|حالم بده|حالم خوب نیست|استرس|نگران|دعوا جدی|مشکل جدی|خسته شدم|گریه|افسرده|بیمارستان|تسلیت|فوت|درد شدید|اورژانس)/;
const BANTER = /(😂|🤣|خخخ|ههه|کل.?کل|باز شروع|چی میگی|نه بابا|گیر دادی|برو بابا|زر نزن|اسکل|خل|دیوونه|مسخره|گوه|چرت|احمق|مغزت|عقل نداری)/;
const FACTUAL = /(چطور|چجوری|چیست|چیه|کیه|کجاست|چند|قیمت|خبر|امروز|الان|آخرین|جدیدترین|آپدیت|نسخه|ارور|خطا|کد|برنامه نویسی|پزشکی|دارو|تاریخ|ساعت|هوا|سرچ|جستجو|لینک|منبع)/;
const SOCIAL_QUESTION = /(چرا\s+(?:اینقد|انقد|باید\s+تو)|مغزت|عقل نداری|خوبی|چطوری|کجایی|دوستم داری|دوستش دارم|چی میگی|داری چیکار میکنی|داری چیکار می‌کنی)/;

export function isFactualIntent(text) {
  const n = normalizePersian(text);
  if (BANTER.test(n) || SOCIAL_QUESTION.test(n)) return false;
  return FACTUAL.test(n);
}

export function detectConversationMode(text, chatId) {
  const n = normalizePersian(text);
  const recent = recentHistory(chatId, 6).map((x) => normalizePersian(x.text));
  if (SERIOUS.test(n) || recent.slice(-3).some((x) => SERIOUS.test(x))) {
    return { mood: "calm", roastLevel: 1, banter: false, factual: false };
  }
  if (isFactualIntent(n)) return { mood: "smart", roastLevel: 1, banter: false, factual: true };

  const activeBanter = BANTER.test(n) || recent.some((x) => BANTER.test(x));
  const mainActive = recentHistory(chatId, 6).filter((x) => ["مهندس", "خانوم دکتر"].includes(x.speaker)).length >= 3;
  const configuredRoast = Math.round(numSetting("roast_level", ROAST_LEVEL, 1, 3));

  if (activeBanter && mainActive) return { mood: "roast", roastLevel: configuredRoast, banter: true, factual: false };
  if (activeBanter) return { mood: "playful", roastLevel: Math.min(configuredRoast, 2), banter: true, factual: false };
  return { mood: "playful", roastLevel: 1, banter: false, factual: false };
}

export function chooseSide() {
  const bias = numSetting("doctor_bias", DOCTOR_BIAS, 0, 1);
  return Math.random() < bias ? "doctor" : "engineer";
}

const LOW_CONTENT = /^(باشه|اوکی|اوکیه|ok|okay|آره|اره|نه|مرسی|ممنون|خب|خوب|اها|آها|اهان|هوم|اوهوم|عه|جدی|چشم|سلام|بای|شب بخیر|صبح بخیر)[.!؟?]*$/;

export function interventionProbability(ctx, text) {
  const chatId = ctx.chat.id;
  const n = normalizePersian(text);
  if (n.length < 4 || LOW_CONTENT.test(n)) return 0;

  const history = recentHistory(chatId, 10);
  const previous = history.slice(0, -1);
  const now = Date.now();
  const repliesToHuman = Boolean(ctx.message?.reply_to_message) && !ctx.message.reply_to_message.from?.is_bot;

  const botJustSpoke = previous.slice(-3).some((x) => x.speaker === BOT_SPEAKER && now - x.created_at < 3 * 60 * 1000);
  if (botJustSpoke && !repliesToHuman) return 0.36;
  if ((now - lastBotAt(chatId)) / 1000 < AUTO_COOLDOWN_SECONDS) return 0;

  let p = 0.015;
  if (roleFromUser(ctx.from)) p += 0.035;
  if (/[؟?]/.test(n)) p += 0.06;
  if (/مهندس|خانوم دکتر|خانم دکتر/.test(n)) p += 0.11;
  if (BANTER.test(n)) p += 0.14;
  if (/(حوصلم|حوصله|عصبانی|خسته|باحال|عجیبه|جدی میگی|نظرت|به نظرتون)/.test(n)) p += 0.06;
  if (n.length > 90) p += 0.025;
  if (repliesToHuman) p *= 0.45;

  const recentMain = previous.slice(-6).filter((x) => ["مهندس", "خانوم دکتر"].includes(x.speaker));
  const bothActive = recentMain.some((x) => x.speaker === "مهندس") && recentMain.some((x) => x.speaker === "خانوم دکتر");
  if (bothActive) p += 0.09;
  const alternating = recentMain.length >= 4 && recentMain.slice(-4).every((x, i, arr) => i === 0 || x.speaker !== arr[i - 1].speaker);
  if (alternating) p += 0.07;

  const maxProb = numSetting("auto_max_prob", AUTO_MAX_PROB, 0.02, 1);
  return Math.min(maxProb, p);
}

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

export function fixedFallback() {
  return pick([
    "این یکی از دستم در رفت، یه کم بعد دوباره بگو 😅",
    "یه لحظه هنگ کردم، دوباره بگو چی گفتی 😌",
    "این یکی خوب نرسید بهم؛ یه بار دیگه بگو.",
    "الان جواب باحال ازم درنمیاد، بعداً دوباره گیر بده 😂",
  ]);
}
