import { ENGINEER_ID } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import { normalizePersian } from "./memory.js";

const KEY = "custom_local_rules_v1";
const MAX_RULES = 60;

function loadRules() {
  try {
    const parsed = JSON.parse(getSetting(KEY, "[]"));
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.trigger === "string" && typeof x.reply === "string") : [];
  } catch {
    return [];
  }
}

function saveRules(rules) {
  setSetting(KEY, JSON.stringify(rules.slice(-MAX_RULES)));
}

function normalizeTrigger(text) {
  return normalizePersian(text)
    .replace(/([\p{L}])\1{2,}/gu, "$1")
    .replace(/^(?:نرگس کوچولو|خانوم نرگس|خانم نرگس|نرگسی|نرگس|narges)\s*[،,:؛;.!؟?]*\s+/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTeacher(userId) {
  return Boolean(ENGINEER_ID && Number(userId) === Number(ENGINEER_ID));
}

function parseTeach(text) {
  const original = String(text || "").trim();
  let m = original.match(/(?:^|\s)یاد\s*بگیر\s*[:：]?\s*(.+?)\s*(?:=>|->|→)\s*(.+)$/i);
  if (m) return { trigger: m[1].trim(), reply: m[2].trim() };

  m = original.match(/(?:^|\s)یاد\s*بگیر(?:\s+که)?\s+(?:وقتی|هر\s*وقت)\s+(?:گفتم|گفتیم)\s*[«"']?(.+?)[»"']?\s+(?:بگو|جواب\s*بده)\s*[«"']?(.+?)[»"']?$/i);
  if (m) return { trigger: m[1].trim(), reply: m[2].trim() };
  return null;
}

function parseForget(text) {
  const original = String(text || "").trim();
  const m = original.match(/(?:فراموش\s*کن|یاد\s*نگیر)(?:\s+محلی)?\s*[:：]?\s*(.+)$/i);
  return m?.[1]?.trim() || null;
}

export function customLocalReply({ text, userId }) {
  const raw = String(text || "").trim();
  const teacher = isTeacher(userId);

  if (teacher) {
    if (/^(?:نرگس\s+)?(?:چی\s+یادت\s+دادم|جوابای\s+محلی\s+چیان|قانونای\s+محلی\s+چیان)[؟?]?$/i.test(normalizePersian(raw))) {
      const rules = loadRules();
      if (!rules.length) return "هنوز چیزی دستی یادم ندادی 😌";
      const shown = rules.slice(-12).map((x, i) => `${i + 1}) «${x.label || x.trigger}»`).join("\n");
      return `اینارو دستی یادم دادی:\n${shown}`;
    }

    const taught = parseTeach(raw);
    if (taught) {
      const trigger = normalizeTrigger(taught.trigger);
      const reply = taught.reply.replace(/^['"«]+|['"»]+$/g, "").trim().slice(0, 320);
      if (trigger.length < 2 || reply.length < 1) return "فرمتش رو این‌جوری بگو: یاد بگیر: عبارت => جواب";

      const rules = loadRules();
      const next = rules.filter((x) => x.trigger !== trigger);
      next.push({ trigger, label: taught.trigger.slice(0, 100), reply, updatedAt: Date.now() });
      saveRules(next);
      return `یاد گرفتم 😌 از این به بعد «${taught.trigger.slice(0, 80)}» رو محلی جواب می‌دم.`;
    }

    const forgotten = parseForget(raw);
    if (forgotten) {
      const trigger = normalizeTrigger(forgotten);
      const rules = loadRules();
      const next = rules.filter((x) => x.trigger !== trigger);
      if (next.length === rules.length) return "همچین جواب محلی‌ای یادم نیست 😅";
      saveRules(next);
      return "پاکش کردم از جواب‌های محلی 😌";
    }
  }

  const key = normalizeTrigger(raw);
  if (!key) return null;
  const match = loadRules().find((x) => x.trigger === key);
  return match?.reply || null;
}
