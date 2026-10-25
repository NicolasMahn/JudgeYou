// Kept chats are for benchmarking, which needs who-said-what but not who
// anyone is. This is best effort: it catches the names Jev was given and
// anything shaped like a phone number or email, not every way a message can
// identify someone.

const PHONE = /\+?\d[\d ()/.-]{7,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const MIN_PHONE_DIGITS = 9; // fewer would also catch dates like 25.10.2026
const MIN_ALIAS_LENGTH = 3;

/** Every name in a Jev request: the judged people, participants and authors. */
export function namesIn(request) {
  const names = [
    ...Object.keys(request.questions?.culprit?.criteria ?? {}),
    ...(Array.isArray(request.state?.participants) ? request.state.participants : []),
    ...(Array.isArray(request.state?.messages) ? request.state.messages.map((m) => m?.from) : []),
  ];
  return [...new Set(names.filter((name) => typeof name === 'string' && name.trim()))];
}

/**
 * Returns a function that replaces the given names with "Person 1", "Person
 * 2"… in every string and object key of a value. A first name on its own
 * ("Tobi" for "Tobi Berg") counts too, unless two people share it.
 */
export function createScrubber(names) {
  const pseudonyms = new Map(names.map((name, i) => [name, `Person ${i + 1}`]));
  const firstNames = new Map();
  for (const name of names) {
    const first = name.trim().split(/\s+/)[0];
    if (first === name || first.length < MIN_ALIAS_LENGTH || pseudonyms.has(first)) continue;
    firstNames.set(first, firstNames.has(first) ? null : pseudonyms.get(name));
  }
  for (const [first, pseudonym] of firstNames) if (pseudonym) pseudonyms.set(first, pseudonym);

  // Longest first, so "Tobi Berg" is replaced before "Tobi" can split it.
  const ordered = [...pseudonyms.keys()].sort((a, b) => b.length - a.length);
  const pattern = ordered.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${ordered.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu')
    : null;

  const text = (value) =>
    (pattern ? value.replace(pattern, (name) => pseudonyms.get(name)) : value)
      .replace(EMAIL, '[email]')
      .replace(PHONE, (match) => (match.replace(/\D/g, '').length >= MIN_PHONE_DIGITS ? '[phone]' : match));

  const scrub = (value) => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [text(key), scrub(inner)]));
    }
    return value;
  };
  return scrub;
}

const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
