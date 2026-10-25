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
    deletion_hash  TEXT,           -- SHA-256 of the code that lets the visitor delete the chat
    result_id      TEXT,           -- public ID of a share link; opens the nameless verdict
    stats          TEXT            -- the counted numbers per judged person, in judging order
  )`;

// Added after the first deploy; CREATE TABLE IF NOT EXISTS leaves old tables as they were.
const ADDED_COLUMNS = { result_id: 'TEXT', stats: 'TEXT' };

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  const columns = new Set(db.prepare('PRAGMA table_info(judgments)').all().map((column) => column.name));
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    if (!columns.has(name)) db.exec(`ALTER TABLE judgments ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS judgments_result_id ON judgments (result_id)');
  const insert = db.prepare(`
    INSERT INTO judgments (at, visitor, lang, source, raw, people, messages_sent, messages_total,
      truncated, attempt, status, ms, model, cost, answers, chat, deletion_hash, result_id, stats)
    VALUES (:at, :visitor, :lang, :source, :raw, :people, :messagesSent, :messagesTotal,
      :truncated, :attempt, :status, :ms, :model, :cost, :answers, :chat, :deletionHash, :resultId, :stats)`);
  const result = db.prepare('SELECT people, answers, stats FROM judgments WHERE result_id = ?');
  const forget = db.prepare('UPDATE judgments SET chat = NULL, deletion_hash = NULL WHERE deletion_hash = ?');

  return {
    record(row) {
      insert.run({ chat: null, deletionHash: null, resultId: null, stats: null, ...row });
    },
    /** The nameless verdict behind a share link, or null. */
    result(id) {
      const row = result.get(id);
      return row ? { people: row.people, answers: JSON.parse(row.answers), stats: row.stats ? JSON.parse(row.stats) : null } : null;
    },
    /** Deletes the kept chat for a code; the nameless verdict stays. */
    forget(code) {
      return forget.run(hash(code)).changes > 0;
    },
    close: () => db.close(),
  };
}

/** The public part of a share link, e.g. "k7qm2xwd9h": about 50 bits, too many to guess. */
export function resultId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...randomBytes(10)].map((byte) => alphabet[byte % alphabet.length]).join('');
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
