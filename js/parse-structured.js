// Exports that are data rather than text: JSON (Telegram, Messenger, Instagram,
// DiscordChatExporter), Telegram's HTML export and CSV/TSV tables.
// Each reader returns messages, or null when the input isn't its format.

export function fromJson(raw) {
  if (!/^\s*[[{]/.test(raw)) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const list = Array.isArray(data) ? data : data?.messages;
  if (!Array.isArray(list)) return null;

  // Messenger and Instagram list newest first and store UTF-8 bytes as Latin-1.
  const isMeta = list.some((m) => m && 'sender_name' in m);
  const ordered = isMeta ? [...list].sort((a, b) => (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0)) : list;

  return ordered
    .filter((m) => m && m.type !== 'service')
    .map((m) => ({ author: authorOf(m), text: textOf(m), stamp: stampOf(m) }))
    .map((m) => (isMeta ? { ...m, author: fixMojibake(m.author), text: fixMojibake(m.text) } : m));
}

function authorOf(m) {
  const author = m.from ?? m.sender_name ?? m.author ?? m.sender ?? m.user ?? m.username ?? m.name;
  if (author && typeof author === 'object') return author.nickname ?? author.name ?? author.username ?? '';
  return typeof author === 'string' ? author : '';
}

// Messenger counts real milliseconds; the others write date strings.
function stampOf(m) {
  if (typeof m.timestamp_ms === 'number') return m.timestamp_ms;
  const stamp = m.date ?? m.timestamp ?? m.time;
  return typeof stamp === 'string' ? stamp : null;
}

function textOf(m) {
  const text = m.text ?? m.content ?? m.message ?? m.body;
  if (Array.isArray(text)) return text.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return typeof text === 'string' ? text : '';
}

function fixMojibake(text) {
  if (/[^\u0000-ÿ]/.test(text)) return text;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text, (c) => c.charCodeAt(0)));
  } catch {
    return text;
  }
}

export function fromTelegramHtml(raw) {
  if (!raw.includes('class="message default')) return null;

  const messages = [];
  let author = null;
  for (const block of raw.split('<div class="message default').slice(1)) {
    // "Joined" messages omit the name: they continue the previous sender.
    const name = block.match(/<div class="from_name">([\s\S]*?)<\/div>/)?.[1];
    if (name) author = htmlToText(name);
    const text = block.match(/<div class="text">([\s\S]*?)<\/div>/)?.[1];
    const stamp = block.match(/class="pull_right date details" title="([^"]+)"/)?.[1] ?? null;
    if (author && text) messages.push({ author, text: htmlToText(text), stamp });
  }
  return messages;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? entity;
      return String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    })
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

const AUTHOR_COLUMN = /^(?:author|from|sender|sender_?name|name|user|user_?name|speaker|participant)$/;
const TEXT_COLUMN = /^(?:message|text|content|body|msg)$/;
const TIME_COLUMN = /^(?:date|time|timestamp|date_?time|sent|sent_?at|created_?at)$/;

export function fromTable(raw) {
  const header = raw.slice(0, raw.indexOf('\n'));
  const delimiter = ['\t', ';', ','].find((d) => header.includes(d));
  if (!delimiter) return null;

  const [columns, ...rows] = readDelimited(raw, delimiter);
  const names = columns.map((c) => c.trim().toLowerCase().replace(/^"|"$/g, ''));
  const authorAt = names.findIndex((c) => AUTHOR_COLUMN.test(c));
  const textAt = names.findIndex((c) => TEXT_COLUMN.test(c));
  if (authorAt < 0 || textAt < 0) return null;
  // A table may split date and time into two columns.
  const timeAt = names.flatMap((c, i) => (TIME_COLUMN.test(c) ? [i] : []));

  return rows.map((row) => ({
    author: row[authorAt] ?? '',
    text: row[textAt] ?? '',
    stamp: timeAt.map((i) => row[i] ?? '').join(' ') || null,
  }));
}

/** RFC 4180-style reader: quoted fields may contain delimiters, quotes and newlines. */
function readDelimited(raw, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === '"' && raw[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      rows.push([...row, field]);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}
