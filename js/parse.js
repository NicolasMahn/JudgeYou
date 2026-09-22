// WhatsApp exports prefix each message with a timestamp, either
// "[2026-09-19, 21:14:03] Ana: hi" or "19/09/2026, 21:14 - Ana: hi".
const TIMESTAMP = /^\[?\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?\]?\s(?:[-–]\s)?/;
const SPEAKER = /^([^:\n]{1,40}):\s+(.*)$/;

// Without timestamps, only short names count as speakers, so a sentence like
// "Here is the thing: no" inside a multi-line message stays a continuation.
const MAX_UNTIMESTAMPED_NAME_WORDS = 3;

// WhatsApp starts system notices and media placeholders ("image omitted",
// "Messages are end-to-end encrypted") with an invisible left-to-right mark.
const SYSTEM_NOTICE = /^‎/;

function messageStart(line, timestamped) {
  if (timestamped) {
    if (!TIMESTAMP.test(line)) return null;
    return line.replace(TIMESTAMP, '').match(SPEAKER);
  }
  const match = line.match(SPEAKER);
  const words = match?.[1].trim().split(/\s+/).length;
  return words <= MAX_UNTIMESTAMPED_NAME_WORDS ? match : null;
}

export function parseChat(raw) {
  const lines = raw.split(/\r?\n/);
  const timestamped = TIMESTAMP.test(lines.find((line) => line.trim()) ?? '');
  const messages = [];
  let current = null;

  for (const line of lines) {
    const match = messageStart(line, timestamped);
    if (match) {
      const text = match[2].trim();
      current = SYSTEM_NOTICE.test(text) ? null : { author: match[1].trim(), text };
      if (current) messages.push(current);
    } else if (current && line.trim()) {
      current.text += `\n${line.trim()}`;
    }
  }

  return messages;
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
