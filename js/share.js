// Share links reopen a verdict: judge-you.de/v/<id>#Ana,Ben. The server keeps
// the verdict with names replaced by "Person 1, 2…"; the names travel only
// after the "#", which browsers never send, and are put back in the page.
import { parseChat } from './parse.js';
import { SAMPLES } from './sample.js';
import { SAMPLE_ANSWERS } from './sample-answers.js';
import { chatStats } from './stats.js';

const SAMPLE_PREFIX = 'sample-';

/** The link for a verdict: a stored result's ID, or one of our samples' IDs. */
export function shareLink({ resultId, sampleId }, names) {
  const id = resultId ?? (sampleId && `${SAMPLE_PREFIX}${sampleId}`);
  if (!id) return location.origin;
  // Samples carry their own names; a link to one needs no fragment.
  const fragment = resultId ? `#${names.map(encodeURIComponent).join(',')}` : '';
  return `${location.origin}/v/${id}${fragment}`;
}

/** The ID in the current address when it is a share link, otherwise null. */
export function sharedId(path = location.pathname) {
  return /^\/v\/([\w-]{1,40})$/.exec(path)?.[1] ?? null;
}

/**
 * Loads a shared verdict as `{ subjects, answers, stats }`, with names back in
 * place: from the link's fragment, or "Person 1, 2…" when it has none.
 * `stats` is a Map like chatStats returns, or null. A sample also brings its
 * `chat` and `sampleId`.
 */
export async function loadShared(id, fragment = location.hash) {
  if (id.startsWith(SAMPLE_PREFIX)) {
    const sampleId = id.slice(SAMPLE_PREFIX.length);
    const sample = SAMPLES.find((candidate) => candidate.id === sampleId);
    const stored = SAMPLE_ANSWERS[sampleId];
    if (!sample || !stored) return null;
    return { sampleId, chat: sample.chat, ...stored, stats: chatStats(parseChat(sample.chat)) };
  }
  const response = await fetch(`/api/results/${id}`);
  if (!response.ok) return null;
  const { people, answers, stats } = await response.json();
  const given = fragment.replace(/^#/, '').split(',').filter(Boolean).map(decodeURIComponent);
  const subjects = Array.from({ length: people }, (_, i) => given[i]?.trim() || `Person ${i + 1}`);
  const named = (key) => /^Person \d+$/.test(key) ? (subjects[Number(key.slice(7)) - 1] ?? key) : key;
  const culprit = answers.culprit && {
    ...answers.culprit,
    choice: named(answers.culprit.choice),
    probabilities: Object.fromEntries(Object.entries(answers.culprit.probabilities ?? {}).map(([key, p]) => [named(key), p])),
  };
  return {
    subjects,
    answers: { ...answers, culprit },
    stats: stats && new Map(subjects.flatMap((name, i) => (stats[i] ? [[name, stats[i]]] : []))),
  };
}
