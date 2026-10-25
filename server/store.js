import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS judgments (
    id             INTEGER PRIMARY KEY,
    at             TEXT NOT NULL,  -- ISO 8601, UTC
    visitor        TEXT,           -- see visitorId; links requests within one day only
    lang           TEXT,
    source         TEXT,           -- paste, file, screenshots or sample
    raw            INTEGER,        -- 1 when the format wasn't recognised
    people         INTEGER,
    messages_sent  INTEGER,
    messages_total INTEGER,
    truncated      INTEGER,
    attempt        INTEGER,        -- 2 when the first request was too long for Jev
    status         INTEGER,
    ms             INTEGER,
    model          TEXT,
    cost           REAL,
    answers        TEXT,           -- Jev's answers as JSON, names replaced
    chat           BLOB,           -- the request, names replaced and sealed; only with consent
    deletion_hash  TEXT            -- SHA-256 of the code that lets the visitor delete the chat
  )`;

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  const insert = db.prepare(`
    INSERT INTO judgments (at, visitor, lang, source, raw, people, messages_sent, messages_total,
      truncated, attempt, status, ms, model, cost, answers, chat, deletion_hash)
    VALUES (:at, :visitor, :lang, :source, :raw, :people, :messagesSent, :messagesTotal,
      :truncated, :attempt, :status, :ms, :model, :cost, :answers, :chat, :deletionHash)`);
  const forget = db.prepare('UPDATE judgments SET chat = NULL, deletion_hash = NULL WHERE deletion_hash = ?');

  return {
    record(row) {
      insert.run({ chat: null, deletionHash: null, ...row });
    },
    /** Deletes the kept chat for a code; Jev's nameless answers stay. */
    forget(code) {
      return forget.run(hash(code)).changes > 0;
    },
    close: () => db.close(),
  };
}

/** A code the visitor can use to delete their kept chat, e.g. "K7QM-2XWD-9HFA". */
export function deletionCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = [...randomBytes(12)].map((byte) => alphabet[byte % alphabet.length]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export const hash = (code) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

/**
 * Counts unique visitors per day without storing addresses: the IP is mixed
 * with a random key that is replaced every UTC day and never written down, so
 * yesterday's IDs can't be traced back or linked to today's.
 */
export function createVisitorIds(now = () => new Date()) {
  let day = null;
  let key = null;
  return (ip) => {
    const today = now().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      key = randomBytes(32);
    }
    return createHmac('sha256', key).update(String(ip)).digest('hex').slice(0, 16);
  };
}
