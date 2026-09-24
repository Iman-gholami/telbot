import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DATA_DIR,
  HISTORY_SIZE,
  DB_HISTORY_LIMIT,
} from "./config.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, "narges.sqlite");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    speaker TEXT NOT NULL,
    user_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_id_id
    ON messages(chat_id, id DESC);

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL CHECK(subject IN ('engineer', 'doctor')),
    content TEXT NOT NULL,
    normalized TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 2,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(subject, normalized)
  );

  CREATE INDEX IF NOT EXISTS idx_memories_subject_updated
    ON memories(subject, importance DESC, updated_at DESC);
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (chat_id, speaker, user_id, text, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

const getHistory = db.prepare(`
  SELECT speaker, user_id, text, created_at
  FROM messages
  WHERE chat_id = ?
  ORDER BY id DESC
  LIMIT ?
`);

const pruneHistory = db.prepare(`
  DELETE FROM messages
  WHERE chat_id = ?
    AND id NOT IN (
      SELECT id
      FROM messages
      WHERE chat_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
`);

const getLastBotAt = db.prepare(`
  SELECT created_at
  FROM messages
  WHERE chat_id = ? AND speaker = 'نرگس کوچولو'
  ORDER BY id DESC
  LIMIT 1
`);

const upsertMemory = db.prepare(`
  INSERT INTO memories (
    subject, content, normalized, importance, source, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(subject, normalized) DO UPDATE SET
    content = excluded.content,
    importance = MAX(memories.importance, excluded.importance),
    source = excluded.source,
    updated_at = excluded.updated_at
`);

const getMemories = db.prepare(`
  SELECT subject, content, importance, source, updated_at
  FROM memories
  WHERE subject = ?
  ORDER BY importance DESC, updated_at DESC
  LIMIT ?
`);

const deleteMemoryLike = db.prepare(`
  DELETE FROM memories
  WHERE subject = ?
    AND normalized LIKE ?
`);

export function rememberMessage(chatId, speaker, text, userId = null) {
  const clean = String(text || "").trim().slice(0, 2500);
  if (!clean) return;

  insertMessage.run(
    String(chatId),
    speaker,
    userId ? String(userId) : null,
    clean,
    Date.now()
  );

  pruneHistory.run(String(chatId), String(chatId), DB_HISTORY_LIMIT);
}

export function recentHistory(chatId, limit = HISTORY_SIZE) {
  return getHistory
    .all(String(chatId), limit)
    .reverse();
}

export function historyAsText(chatId) {
  return recentHistory(chatId)
    .map((item) => `${item.speaker}: ${item.text}`)
    .join("\n");
}

export function lastBotAt(chatId) {
  return getLastBotAt.get(String(chatId))?.created_at || 0;
}

export function saveLongTermMemory(
  subject,
  content,
  normalized,
  { importance = 2, source = "auto" } = {}
) {
  if (!["engineer", "doctor"].includes(subject)) return false;

  const clean = String(content || "").trim().replace(/\s+/g, " ").slice(0, 320);
  if (clean.length < 4 || normalized.length < 4) return false;

  const now = Date.now();
  upsertMemory.run(
    subject,
    clean,
    normalized,
    Math.max(1, Math.min(3, Number(importance) || 2)),
    source,
    now,
    now
  );
  return true;
}

export function getLongTermMemories(subject, limit = 12) {
  return getMemories.all(subject, limit);
}

export function deleteLongTermMemoryLike(subject, normalizedNeedle) {
  return deleteMemoryLike.run(subject, `%${normalizedNeedle}%`).changes;
}

export function memoriesAsText() {
  const engineer = getLongTermMemories("engineer", 10);
  const doctor = getLongTermMemories("doctor", 10);

  const section = (label, rows) => {
    if (!rows.length) return `${label}: هنوز چیز مهمی ذخیره نشده.`;
    return `${label}:\n${rows.map((x) => `- ${x.content}`).join("\n")}`;
  };

  return [
    section("مهندس", engineer),
    section("خانوم دکتر", doctor),
  ].join("\n\n");
}

export function closeDb() {
  db.close();
}
