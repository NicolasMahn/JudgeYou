import { fromJson, fromTable, fromTelegramHtml, htmlToText } from './parse-structured.js';

// Building blocks for timestamps as chat apps write them.
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const DATE =
  '(?:\\d{1,4}[./-]\\d{1,2}[./-]\\d{1,4}\\.?' + // 19/09/2026, 2026-09-19, 19.09.26
  '|\\d{4}\\. ?\\d{1,2}\\. ?\\d{1,2}\\.' + // 2026. 9. 19. (KakaoTalk)
  `|\\d{1,2}[ -]${MONTH}[ -]\\d{2,4}` + // 19-Sep-26
  `|${MONTH} \\d{1,2},? \\d{4})`; // Sep 19, 2026
const MERIDIEM = '(?:[AaPp]\\.? ?[Mm]\\.?|오전|오후|午前|午後)';
const TIME = `(?:${MERIDIEM} ?)?\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?(?: ?${MERIDIEM})?`;
const STAMP = `(?:${DATE}(?:,?\\s+|T))?${TIME}`;

/**
 * Line formats. `inline` lines hold author and text; `header` lines hold only
 * the author, with the text on the following lines; `stamp` lines hold only a
 * timestamp, with the author on a neighbouring line. `weak` formats are easy to
 * match by accident, so their authors must be short and speak more than once.
 */
const FORMATS = [
  // WhatsApp (iOS and Android, any locale), KakaoTalk mobile, most exporters.
  { kind: 'inline', stamped: true, re: new RegExp(`^\\[?${STAMP}\\]?(?:\\s*[-–—,]\\s*|\\s+)([^:]{1,50}?)\\s?:\\s(.*)$`) },
  // IRC and Matrix-style logs.
  { kind: 'inline', re: new RegExp(`^(?:\\[?${STAMP}\\]?\\s*)?<[@+%~&]?([^<>]{1,50})>\\s(.*)$`) },
  // KakaoTalk desktop.
  { kind: 'inline', re: new RegExp(`^\\[([^\\]]{1,50})\\]\\s\\[${TIME}\\]\\s(.*)$`) },
  // LINE.
  { kind: 'inline', re: new RegExp(`^${TIME}\\t([^\\t]{1,50})\\t(.*)$`) },
  // Discord copy-paste.
  {
    kind: 'header',
    re: new RegExp(`^(.{1,50}?)\\s(?:[—–]\\s(?:Today|Yesterday|Heute|Gestern|${DATE}|${TIME})|(?:Today|Yesterday) at\\s).*$`),
  },
  // Telegram desktop copy-paste.
  { kind: 'header', re: new RegExp(`^(.{1,50}?),\\s\\[${STAMP}\\]$`) },
  // DiscordChatExporter, Microsoft Teams.
  { kind: 'header', re: new RegExp(`^\\[${STAMP}\\]\\s+([^:]{1,50})$`) },
  // iMessage exporters, Slack (name and time on separate lines).
  { kind: 'stamp', re: new RegExp(`^${STAMP}(?:\\s+\\(.*\\))?$`) },
  // Slack and Teams with name and time on one line.
  { kind: 'header', weak: true, re: new RegExp(`^([^\\d\\s:\\[<>][^:]{0,40}?)\\s{1,3}${TIME}$`) },
  // Plain transcripts, including **Name**: and > Name: quoting.
  { kind: 'inline', weak: true, re: /^(?:>\s*)?(?:\*\*|__)?([^:*_\n]{1,40}?)(?:\*\*|__)?\s?:\s+(.*)$/ },
];

const STAMP_START = new RegExp(`^\\[?${STAMP}`);
const DATE_LINE = new RegExp(`^(?:[A-Za-z]+,?\\s)?${DATE}(?:,?\\s\\(?[A-Za-z]+\\)?)?$`);
const MAX_WEAK_NAME_WORDS = 3;
const SAMPLE_LINES = 3000;

// iOS WhatsApp marks system notices and media with a leading U+200E; other
// apps write placeholders like "<Media omitted>" or "image omitted".
const PLACEHOLDER =
  /^(?:[\u200e\u200f].*|<[^<>]+>|(?:image|video|audio|sticker|GIF|document|photo|Contact card) omitted|This message was deleted\.?|You deleted this message\.?|null)$/is;

export function parseChat(raw) {
  const text = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u202f\u00a0\u2007]/g, ' ');

  const structured = fromJson(text) ?? fromTelegramHtml(text) ?? fromTable(text);
  const looksLikeHtml = !structured && /^\s*</.test(text) && /<\/(?:div|p|body|html)>/i.test(text);
  const messages = structured ?? parseLines(looksLikeHtml ? htmlToText(text) : text);

  return messages
    .filter((m) => m.author.trim() && m.text.trim() && !PLACEHOLDER.test(m.text.trim()))
    .map((m) => ({ author: clean(m.author).replace(/^~\s*/, ''), text: clean(m.text) }));
}

function clean(text) {
  return text.replace(/[\u200e\u200f]/g, '').trim();
}

function parseLines(text) {
  const lines = text.split('\n').map((line) => line.replace(/^[\u200e\u200f]+/, '').trimEnd());
  const format = bestFormat(lines);
  if (!format) return [];

  const isSpeaker = speakerFilter(lines, format);
  const authorAt = format.kind === 'stamp' ? stampAuthors(lines, format) : new Map();
  const authorLines = new Set(authorAt.values());
  const messages = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (authorLines.has(i)) continue;
    const match = format.re.exec(line);

    if (match && format.kind === 'stamp') {
      current = { author: lines[authorAt.get(i)] ?? '', text: '' };
      messages.push(current);
    } else if (match && format.kind !== 'stamp' && isSpeaker(match[1])) {
      current = { author: match[1], text: match[2] ?? '' };
      messages.push(current);
    } else if (format.stamped && STAMP_START.test(line)) {
      // A timestamped line without "Name:" is a system notice, not a continuation.
      current = null;
    } else if (current && line.trim() && !DATE_LINE.test(line.trim())) {
      current.text += current.text ? `\n${line.trim()}` : line.trim();
    }
  }
  return messages;
}

function bestFormat(lines) {
  const sample = lines.slice(0, SAMPLE_LINES);
  let best = null;
  let bestCount = 0;
  for (const format of FORMATS) {
    const count = sample.filter((line) => format.re.test(line)).length;
    if (count > bestCount) {
      best = format;
      bestCount = count;
    }
  }
  return best;
}

// Words that open a line like a speaker would but are labels, not people.
const LABELS =
  /^(?:note|notes|ps|p\.s\.|nb|edit|update|re|subject|reminder|fyi|btw|tl;?dr|important|warning|example|summary|question|answer|todo|link|address|location|time|date|agenda|step \d+)$/i;

/**
 * Weak formats accept short names that recur. A name seen once must look like
 * one (every word capitalised, not a label), so "Note: bring cash" stays text.
 */
function speakerFilter(lines, format) {
  if (!format.weak) return () => true;

  const counts = new Map();
  for (const line of lines) {
    const name = format.re.exec(line)?.[1];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (name) => {
    const words = name.trim().split(/\s+/);
    if (words.length > MAX_WEAK_NAME_WORDS) return false;
    if (counts.get(name) > 1) return true;
    return words.every((word) => /^[\p{Lu}\p{Lo}\d@]/u.test(word)) && !LABELS.test(name.trim());
  };
}

/**
 * Maps each stamp-only line to the line holding its author: just below it
 * (iMessage exporters) or just above it (Slack). Authors repeat, so the side
 * with fewer distinct values is the author side.
 */
function stampAuthors(lines, format) {
  const nearest = (i, step) => {
    for (let j = i + step; j >= 0 && j < lines.length; j += step) if (lines[j].trim()) return j;
    return undefined;
  };
  const stamps = lines.flatMap((line, i) => (format.re.test(line) ? [i] : []));
  const distinct = (step) => new Set(stamps.map((i) => lines[nearest(i, step)]?.trim())).size;
  const step = distinct(-1) < distinct(1) ? -1 : 1;
  return new Map(stamps.map((i) => [i, nearest(i, step)]));
}

export function participantsOf(messages) {
  const counts = new Map();
  for (const { author } of messages) {
    counts.set(author, (counts.get(author) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, messageCount]) => ({ name, messageCount }))
    .sort((a, b) => b.messageCount - a.messageCount);
}
