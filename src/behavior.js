import {
  DOCTOR_BIAS,
  AUTO_COOLDOWN_SECONDS,
  AUTO_MAX_PROB,
} from "./config.js";
import {
  recentHistory,
  lastBotAt,
} from "./db.js";
import {
  normalizePersian,
  roleFromUser,
} from "./memory.js";

export function isDirectlyAddressed(ctx, text) {
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

export function detectConversationMode(text, chatId) {
  const n = normalizePersian(text);
  const recent = recentHistory(chatId, 8)
    .map((x) => normalizePersian(x.text))
    .join(" ");

  const serious =
    /(ناراحت|غمگین|حالم بده|استرس|نگران|دعوا جدی|مشکل جدی|خسته شدم|گریه|حوصله ندارم)/;
  const banter =
    /(😂|🤣|خخ|ههه|کل.?کل|باز شروع|چی میگی|نه بابا|گیر دادی|برو بابا|زر نزن|اسکل|خل|دیوونه)/;

  if (serious.test(`${n} ${recent}`)) {
    return { mood: "calm", roastLevel: 1 };
  }

  const activeBanter = banter.test(n) || banter.test(recent);
  const mainPeopleActive =
    recentHistory(chatId, 6).filter((x) =>
      ["مهندس", "خانوم دکتر"].includes(x.speaker)
    ).length >= 3;

  if (activeBanter && mainPeopleActive) {
    return {
      mood: "roast",
      roastLevel: Math.random() < 0.45 ? 3 : 2,
    };
  }

  if (activeBanter) {
    return { mood: "playful", roastLevel: 2 };
  }

  if (/[؟?]/.test(n)) {
    return { mood: "smart", roastLevel: 1 };
  }

  return {
    mood: Math.random() < 0.35 ? "calm" : "playful",
    roastLevel: Math.random() < 0.7 ? 1 : 2,
  };
}

export function chooseSide() {
  return Math.random() < DOCTOR_BIAS ? "doctor" : "engineer";
}

export function interventionProbability(ctx, text) {
  const chatId = ctx.chat.id;
  const n = normalizePersian(text);
  const role = roleFromUser(ctx.from);
  const history = recentHistory(chatId, 8);

  const secondsSinceBot = (Date.now() - lastBotAt(chatId)) / 1000;
  if (secondsSinceBot < AUTO_COOLDOWN_SECONDS) return 0;

  let p = 0.015;

  if (role) p += 0.04;
  if (/[؟?]/.test(n)) p += 0.07;
  if (/مهندس|خانوم دکتر|خانم دکتر/.test(n)) p += 0.13;
  if (/(😂|🤣|خخ|ههه|شوخی|کل.?کل|باز شروع|چی میگی|نه بابا|گیر دادی|برو بابا)/.test(n)) {
    p += 0.17;
  }
  if (/(حوصلم|حوصله|ناراحت|عصبانی|خسته|باحال|عجیبه|جدی میگی)/.test(n)) {
    p += 0.07;
  }
  if (n.length > 90) p += 0.03;

  const recentMain = history
    .slice(-6)
    .filter((x) => ["مهندس", "خانوم دکتر"].includes(x.speaker));

  const bothActive =
    recentMain.some((x) => x.speaker === "مهندس") &&
    recentMain.some((x) => x.speaker === "خانوم دکتر");

  if (bothActive) p += 0.12;

  const alternating =
    recentMain.length >= 4 &&
    recentMain
      .slice(-4)
      .every((x, i, arr) => i === 0 || x.speaker !== arr[i - 1].speaker);

  if (alternating) p += 0.10;

  return Math.min(AUTO_MAX_PROB, p);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function fixedFallback(side, direct, text) {
  const snippet = String(text || "").trim().slice(0, 70);

  if (direct) {
    return pick([
      "جانم؟ بگو، گوشم با شماست 😌",
      "هستم؛ بگو ببینم این دفعه قصه چیه 😂",
      "بگو، من آماده‌ام؛ فقط اگه بحث مهندس و خانوم دکتره از الان معلومه بی‌طرف نیستم 😌",
      "نرگس حاضر و ناظر؛ ادامه بده ببینم چی شده 😂",
    ]);
  }

  if (side === "doctor") {
    return pick([
      `خانوم دکتر من چیزی نمی‌گم، ولی «${snippet || "این حرکت"}» برای مهندس خیلی گرون تموم شد 😂`,
      "مهندس جان، اعتمادبه‌نفس خوبه؛ مدرک هم کنارش بد نیست 😭",
      "خانوم دکتر فعلاً فقط نگاه کنید، مهندس خودش داره ادامه ماجرا رو می‌نویسه 😂",
      "من سمت خانوم دکترم، ولی مهندس هم آزادانه حق داره بیشتر خودش رو تو دردسر بندازه 😌",
    ]);
  }

  return pick([
    "باشه این یه راند کوچیک برای مهندس؛ خانوم دکتر لطفاً تاریخش رو ثبت کنید، زیاد تکرار نمی‌شه 😂",
    "مهندس این یکی بد نبود، خودمم یه لحظه شک کردم نکنه آپدیت شدی 😭",
    "خانوم دکتر برای رعایت عدالت، این دفعه نصف امتیاز رو بدیم به مهندس 😌",
  ]);
}
