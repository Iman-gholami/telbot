import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, HISTORY_SIZE, DB_HISTORY_LIMIT } from "./config.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, "narges.sqlite");
export const BOT_SPEAKER = "نرگس کوچولو";
export const MEMORY_SUBJECTS = ["engineer", "doctor", "group"];

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ---------- Schema & migrations ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    speaker TEXT NOT NULL,
    user_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id_id ON messages(chat_id, id DESC);

  CREATE TABLE IF NOT EXISTS chat_state (
    chat_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL DEFAULT '',
    digested_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ai_usage (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    exhausted INTEGER NOT NULL DEFAULT 0
  );
`);

function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
ensureColumn("messages", "message_id", "INTEGER");
ensureColumn("messages", "reply_to_speaker", "TEXT");
ensureColumn("messages", "reply_to_text", "TEXT");

const CREATE_MEMORIES = `
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL CHECK(subject IN ('engineer', 'doctor', 'group')),
    content TEXT NOT NULL,
    normalized TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 2,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(subject, normalized)
  )`;

const memoriesSql = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
  .get()?.sql;

if (!memoriesSql) {
  db.exec(CREATE_MEMORIES);
} else if (!memoriesSql.includes("'group'")) {
  // نسخه قبلی فقط engineer/doctor را قبول می‌کرد
  db.transaction(() => {
    db.exec("ALTER TABLE memories RENAME TO memories_old");
    db.exec(CREATE_MEMORIES);
    db.exec(`
      INSERT INTO memories (id, subject, content, normalized, importance, source, created_at, updated_at)
      SELECT id, subject, content, normalized, importance, source, created_at, updated_at FROM memories_old
    `);
    db.exec("DROP TABLE memories_old");
  })();
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_subject_updated
  ON memories(subject, importance DESC, updated_at DESC)`);

// ---------- Messages ----------

const insertMessage = db.prepare(`
  INSERT INTO messages (chat_id, message_id, speaker, user_id, text, reply_to_speaker, reply_to_text, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getHistory = db.prepare(`
  SELECT id, speaker, user_id, text, reply_to_speaker, reply_to_text, created_at
  FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
`);

const getAfter = db.prepare(`
  SELECT id, speaker, user_id, text, reply_to_speaker, reply_to_text, created_at
  FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC LIMIT ?
`);

const countAfter = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND id > ?`);

const pruneHistory = db.prepare(`
  DELETE FROM messages
  WHERE chat_id = ? AND id NOT IN (
    SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
  )
`);

const getLastBotAt = db.prepare(`
  SELECT created_at FROM messages WHERE chat_id = ? AND speaker = ? ORDER BY id DESC LIMIT 1
`);

let insertsSincePrune = 0;

export function rememberMessage({
  chatId,
  messageId = null,
  speaker,
  userId = null,
  text,
  replyToSpeaker = null,
  replyToText = null,
}) {
  const clean = String(text || "").trim().slice(0, 2500);
  if (!clean) return null;

  const info = insertMessage.run(
    String(chatId),
    messageId,
    speaker,
    userId ? String(userId) : null,
    clean,
    replyToSpeaker,
    replyToText ? String(replyToText).slice(0, 300) : null,
    Date.now()
  );

  if (++insertsSincePrune >= 20) {
    insertsSincePrune = 0;
    pruneHistory.run(String(chatId), String(chatId), DB_HISTORY_LIMIT);
  }
  return Number(info.lastInsertRowid);
}

export function recentHistory(chatId, limit = HISTORY_SIZE) {
  return getHistory.all(String(chatId), limit).reverse();
}

export function messagesAfter(chatId, rowId, limit = 150) {
  return getAfter.all(String(chatId), rowId, limit);
}

export function countMessagesAfter(chatId, rowId) {
  return countAfter.get(String(chatId), rowId).n;
}

export function lastBotAt(chatId) {
  return getLastBotAt.get(String(chatId), BOT_SPEAKER)?.created_at || 0;
}

function humanGap(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} دقیقه`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} ساعت`;
  return `${Math.round(h / 24)} روز`;
}

function short(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const GAP_MS = 45 * 60 * 1000;

// تاریخچه را طوری می‌نویسد که مدل ریپلای‌ها و وقفه‌های زمانی را ببیند
export function formatMessages(rows, { selfLabel = "نرگس (خودت)" } = {}) {
  const lines = [];
  let prev = null;
  for (const r of rows) {
    if (prev && r.created_at - prev > GAP_MS) {
      lines.push(`--- ${humanGap(r.created_at - prev)} بعد ---`);
    }
    prev = r.created_at;
    const who = r.speaker === BOT_SPEAKER ? selfLabel : r.speaker;
    const replyTo = r.reply_to_text
      ? ` [در جواب ${r.reply_to_speaker === BOT_SPEAKER ? "نرگس" : r.reply_to_speaker || "کسی"}: «${short(r.reply_to_text, 90)}»]`
      : "";
    lines.push(`${who}${replyTo}: ${r.text}`);
  }
  return lines.join("\n");
}

export function historyAsText(chatId, limit = HISTORY_SIZE) {
  return formatMessages(recentHistory(chatId, limit));
}

// ---------- Chat state (rolling summary) ----------

const getState = db.prepare(`SELECT summary, digested_until, updated_at FROM chat_state WHERE chat_id = ?`);
const upsertState = db.prepare(`
  INSERT INTO chat_state (chat_id, summary, digested_until, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    summary = excluded.summary,
    digested_until = excluded.digested_until,
    updated_at = excluded.updated_at
`);

export function getChatState(chatId) {
  return getState.get(String(chatId)) || { summary: "", digested_until: 0, updated_at: 0 };
}

export function setChatState(chatId, { summary, digestedUntil }) {
  upsertState.run(String(chatId), summary || "", digestedUntil, Date.now());
}

// ---------- AI usage budget ----------

const getUsageStmt = db.prepare(`SELECT count, exhausted FROM ai_usage WHERE day = ?`);
const incUsageStmt = db.prepare(`
  INSERT INTO ai_usage (day, count, exhausted) VALUES (?, 1, 0)
  ON CONFLICT(day) DO UPDATE SET count = count + 1
`);
const exhaustStmt = db.prepare(`
  INSERT INTO ai_usage (day, count, exhausted) VALUES (?, 0, 1)
  ON CONFLICT(day) DO UPDATE SET exhausted = 1
`);

export function getUsage(day) {
  return getUsageStmt.get(day) || { count: 0, exhausted: 0 };
}
export function incrementUsage(day) {
  incUsageStmt.run(day);
}
export function markExhausted(day) {
  exhaustStmt.run(day);
}

// ---------- Long-term memory ----------

const upsertMemory = db.prepare(`
  INSERT INTO memories (subject, content, normalized, importance, source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(subject, normalized) DO UPDATE SET
    content = excluded.content,
    importance = MAX(memories.importance, excluded.importance),
    source = CASE WHEN memories.source LIKE 'manual%' THEN memories.source ELSE excluded.source END,
    updated_at = excluded.updated_at
`);

const getMemories = db.prepare(`
  SELECT id, subject, content, importance, source, updated_at
  FROM memories WHERE subject = ? ORDER BY importance DESC, updated_at DESC LIMIT ?
`);

const deleteMemoryLike = db.prepare(`
  DELETE FROM memories WHERE subject = ? AND normalized LIKE ? ESCAPE '\\'
`);

const updateAutoMemory = db.prepare(`
  UPDATE memories SET content = ?, normalized = ?, updated_at = ?
  WHERE id = ? AND source NOT LIKE 'manual%'
`);

const deleteAutoMemory = db.prepare(`
  DELETE FROM memories WHERE id = ? AND source NOT LIKE 'manual%'
`);

export function saveLongTermMemory(subject, content, normalized, { importance = 2, source = "auto" } = {}) {
  if (!MEMORY_SUBJECTS.includes(subject)) return false;
  const clean = String(content || "").trim().replace(/\s+/g, " ").slice(0, 320);
  if (clean.length < 4 || String(normalized || "").length < 4) return false;

  const now = Date.now();
  upsertMemory.run(subject, clean, normalized, Math.max(1, Math.min(3, Number(importance) || 2)), source, now, now);
  return true;
}

export function updateMemory(id, content, normalized) {
  try {
    return updateAutoMemory.run(String(content).slice(0, 320), normalized, Date.now(), id).changes > 0;
  } catch {
    return false; // مثلاً تکراری شدن با حافظه دیگر
  }
}

export function deleteMemory(id) {
  return deleteAutoMemory.run(id).changes > 0;
}

export function getLongTermMemories(subject, limit = 12) {
  return getMemories.all(subject, limit);
}

export function deleteLongTermMemoryLike(subject, normalizedNeedle) {
  const needle = String(normalizedNeedle || "").trim();
  if (needle.length < 3) return 0; // جلوگیری از پاک شدن کل حافظه
  const escaped = needle.replace(/[\\%_]/g, "\\$&");
  return deleteMemoryLike.run(subject, `%${escaped}%`).changes;
}

const SUBJECT_LABELS = { engineer: "مهندس", doctor: "خانوم دکتر", group: "کل گروه و شوخی‌های داخلی" };

export function memoriesAsText({ withIds = false, limit = 12 } = {}) {
  return MEMORY_SUBJECTS.map((subject) => {
    const rows = getLongTermMemories(subject, limit);
    const label = SUBJECT_LABELS[subject];
    if (!rows.length) return `${label}: هنوز چیزی ثبت نشده.`;
    return `${label}:\n${rows.map((x) => `- ${withIds ? `[${x.id}] ` : ""}${x.content}`).join("\n")}`;
  }).join("\n\n");
}

export function closeDb() {
  db.close();
}
