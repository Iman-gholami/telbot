import {
  ENGINEER_ID,
  DOCTOR_ID,
} from "./config.js";
import { saveLongTermMemory as saveDbMemory } from "./db.js";

export function normalizePersian(text = "") {
  return text
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\u200f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMemory(text = "") {
  return normalizePersian(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

export function roleFromUser(user) {
  if (!user) return null;
  if (ENGINEER_ID && user.id === ENGINEER_ID) return "engineer";
  if (DOCTOR_ID && user.id === DOCTOR_ID) return "doctor";
  return null;
}

export function roleLabel(role) {
  return role === "doctor" ? "خانوم دکتر" : "مهندس";
}

export function displayName(user) {
  const role = roleFromUser(user);
  if (role) return roleLabel(role);
  return user?.first_name || user?.username || "یکی از بچه‌ها";
}

export function looksSensitive(text) {
  const n = normalizePersian(text);
  return [
    /رمز/,
    /پسورد/,
    /password/,
    /api\s*key/,
    /توکن/,
    /token/,
    /cvv/,
    /شماره\s*کارت/,
    /شماره\s*حساب/,
    /شماره\s*شبا/,
    /کد\s*ملی/,
    /آدرس\s*دقیق/,
  ].some((re) => re.test(n));
}

export function saveLongTermMemory(subject, content, options = {}) {
  const clean = String(content || "").trim();
  if (looksSensitive(clean)) return false;
  return saveDbMemory(subject, clean, normalizeMemory(clean), options);
}

export function inferMemorySubjects(text, speakerRole) {
  const n = normalizePersian(text);
  const subjects = [];

  if (/خانوم دکتر|خانم دکتر|\bدکتر\b/.test(n)) subjects.push("doctor");
  if (/مهندس/.test(n)) subjects.push("engineer");

  if (!subjects.length && speakerRole) subjects.push(speakerRole);
  return [...new Set(subjects)];
}

export function extractManualMemory(text, speakerRole) {
  const normalized = normalizePersian(text);
  const match = normalized.match(
    /(?:نرگس(?: کوچولو)?\s*)?(?:یادت باشه|یادت بمونه|یادت بماند|این(?:و|رو) یادت باشه|این(?:و|رو) یادت بمونه)(?: که)?\s+(.+)/i
  );

  if (!match?.[1]) return null;

  const originalMatch = String(text).match(
    /(?:نرگس(?: کوچولو)?\s*)?(?:یادت\s*باشه|یادت\s*بمونه|یادت\s*بماند|اینو\s*یادت\s*باشه|اینرو\s*یادت\s*باشه|این\s*رو\s*یادت\s*باشه|اینو\s*یادت\s*بمونه|این\s*رو\s*یادت\s*بمونه)(?:\s*که)?\s+(.+)/i
  );

  const content = (originalMatch?.[1] || match[1]).trim();
  const subjects = inferMemorySubjects(content, speakerRole);

  if (!content || !subjects.length) return null;
  return { content, subjects };
}

export function maybeStoreHighSignalFact(user, text) {
  const role = roleFromUser(user);
  if (!role) return false;

  const n = normalizePersian(text);
  if (looksSensitive(n) || n.length > 260) return false;

  const highSignal = [
    /(?:من|منم).*(?:دوست دارم|عاشق|بدم میاد|متنفرم|علاقه دارم)/,
    /(?:غذای|رنگ|فیلم|سریال|بازی|آهنگ|ورزش|شغل|کار|رشته).*(?:مورد علاقه|دوست دارم|من)/,
    /(?:من|منم).*(?:کارم|شغلم|رشتم|رشته‌م|اهل|معمولاً|همیشه)/,
  ].some((re) => re.test(n));

  if (!highSignal) return false;

  return saveLongTermMemory(
    role,
    `${roleLabel(role)} گفته: ${String(text).trim()}`,
    { importance: 2, source: "auto-signal" }
  );
}
