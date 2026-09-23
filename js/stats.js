// Hard numbers, counted in the browser from the parsed chat. Nothing here
// asks Jev, so it costs nothing and sends nothing.

// A silence this long ends a conversation: whoever writes next starts a new
// one rather than giving a very slow reply. Six hours covers a night's sleep.
export const SILENCE_MS = 6 * 60 * 60 * 1000;

// Fewer observations than this, and a median says more about luck than habit.
export const MIN_SAMPLE = 3;

/**
 * Per-person counts, keyed by name. Consecutive messages from one person form
 * a block; a reply is the gap between the end of one block and the start of
 * the next block by someone else. In a group that is "time to jump in", not a
 * reply to one particular person.
 */
export function chatStats(messages) {
  const people = new Map();
  const personOf = (name) => {
    if (!people.has(name)) people.set(name, { messages: 0, words: [], replies: [], starts: 0 });
    return people.get(name);
  };

  for (const { author, text } of messages) {
    const person = personOf(author);
    person.messages++;
    person.words.push(text.split(/\s+/).filter(Boolean).length);
  }

  const timed = messages.some((m) => m.at !== null);
  const blocks = blocksOf(messages);
  let conversations = 0;
  blocks.forEach((block, i) => {
    const previous = blocks[i - 1];
    const gap = previous && block.start !== null && previous.end !== null ? block.start - previous.end : null;
    if (!previous || gap >= SILENCE_MS) {
      personOf(block.author).starts++;
      conversations++;
    } else if (gap !== null && gap >= 0) {
      personOf(block.author).replies.push(gap);
    }
  });

  return new Map(
    [...people].map(([name, p]) => [
      name,
      {
        messages: p.messages,
        medianWords: median(p.words),
        reply: timed && p.replies.length >= MIN_SAMPLE ? { median: median(p.replies), n: p.replies.length } : null,
        starts: timed ? { count: p.starts, of: conversations } : null,
      },
    ]),
  );
}

function blocksOf(messages) {
  const blocks = [];
  for (const { author, at } of messages) {
    const last = blocks.at(-1);
    const continues = last?.author === author && !(at !== null && last.end !== null && at - last.end >= SILENCE_MS);
    if (continues) last.end = at ?? last.end;
    else blocks.push({ author, start: at, end: at });
  }
  return blocks;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const RECORDS = {
  slowest: { measure: (s) => s.reply?.median, pick: 'max' },
  fastest: { measure: (s) => s.reply?.median, pick: 'min' },
  wordiest: { measure: (s) => (s.messages >= MIN_SAMPLE ? s.medianWords : undefined), pick: 'max' },
  starter: { measure: (s) => (s.starts?.of >= MIN_SAMPLE ? s.starts.count : undefined), pick: 'max' },
};

/**
 * Who holds each record among `names`. A record needs at least two people
 * with a value and a clear winner; a tie crowns nobody.
 */
export function recordsOf(stats, names) {
  return Object.entries(RECORDS).flatMap(([key, { measure, pick }]) => {
    const entries = names
      .map((name) => ({ name, value: stats.get(name) && measure(stats.get(name)) }))
      .filter(({ value }) => value !== undefined && value !== null);
    if (entries.length < 2) return [];
    entries.sort((a, b) => (pick === 'max' ? b.value - a.value : a.value - b.value));
    if (entries[0].value === entries[1].value) return [];
    return [{ key, name: entries[0].name, stats: stats.get(entries[0].name) }];
  });
}
