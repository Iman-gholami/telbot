import { ENGINEER_ID, DOCTOR_ID } from "./config.js";
import { saveLongTermMemory as saveDbMemory } from "./db.js";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function normalizePersian(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[\u200c\u200e\u200f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMemory(text = "") {
  return normalizePersian(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function roleFromUser(user) {
  if (!user) return null;
  if (ENGINEER_ID && user.id === ENGINEER_ID) return "engineer";
  if (DOCTOR_ID && user.id === DOCTOR_ID) return "doctor";
  return null;
}

export function roleLabel(role) {
  if (role === "doctor") return "خانوم دکتر";
  if (role === "engineer") return "مهندس";
  return "یکی از بچه‌ها";
}

export function displayName(user) {
  const role = roleFromUser(user);
  if (role) return roleLabel(role);
  return user?.first_name || user?.username || "یکی از بچه‌ها";
}

export function looksSensitive(text) {
  const n = normalizePersian(text);
  return [
    /رمز/, /پسورد/, /password/, /api\s*key/, /توکن/, /token/, /cvv/,
    /شماره\s*کارت/, /شماره\s*حساب/, /شبا/, /کد\s*ملی/, /آدرس\s*دقیق/,
    /\b09\d{9}\b/, /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,
  ].some((re) => re.test(n));
}

export function saveLongTermMemory(subject, content, options = {}) {
  const clean = String(content || "").trim();
  if (looksSensitive(clean)) return false;
  return saveDbMemory(subject, clean, normalizeMemory(clean), options);
}

const DOCTOR_RE = /خانوم دکتر|خانم دکتر|(?:^|[^\p{L}])دکتر/u;
const ENGINEER_RE = /مهندس/u;

export function inferMemorySubjects(text, speakerRole) {
  const n = normalizePersian(text);
  const subjects = [];
  if (DOCTOR_RE.test(n)) subjects.push("doctor");
  if (ENGINEER_RE.test(n)) subjects.push("engineer");
  if (!subjects.length && speakerRole) subjects.push(speakerRole);
  return [...new Set(subjects)];
}

const MANUAL_TRIGGER = /یادت[\s\u200c]*(?:باشه|بمونه|بماند|نره)(?:[\s\u200c]+که)?[\s\u200c:،,]+([\s\S]+)/u;

export function extractManualMemory(text, speakerRole) {
  const fixed = String(text).replace(/[يى]/g, "ی").replace(/ك/g, "ک");
  const match = fixed.match(MANUAL_TRIGGER);
  const content = match?.[1]?.trim();
  if (!content || content.length < 4) return null;
  const subjects = inferMemorySubjects(content, speakerRole);
  if (!subjects.length) return null;
  return { content, subjects };
}
