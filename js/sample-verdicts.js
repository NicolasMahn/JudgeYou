// Sample chats are judged once ahead of time (scripts/sample-verdicts.js).
// When a chat is exactly a sample, judged with its default people, the page
// replays the stored answers: nothing is sent, so no consent or cost.
import { participantsOf } from './parse.js';
import { MAX_SUBJECTS } from './questions.js';
import { SAMPLES } from './sample.js';
import { SAMPLE_ANSWERS } from './sample-answers.js';

/** Who the page judges when nobody is spared. */
export const defaultSubjects = (messages) => participantsOf(messages).map((p) => p.name).slice(0, MAX_SUBJECTS);

/**
 * The stored answers and the sample's ID when `chat` and `subjects` are
 * exactly a sample's, otherwise null.
 */
export function storedAnswers(chat, subjects) {
  const sample = SAMPLES.find((candidate) => candidate.chat === chat);
  const stored = sample && SAMPLE_ANSWERS[sample.id];
  if (!stored || stored.subjects.join('\n') !== subjects.join('\n')) return null;
  return { sampleId: sample.id, answers: stored.answers };
}

/**
 * A replayed verdict should feel as considered as a real one: usually 2.5–5 s,
 * now and then a quicker 1.4–2.3 s.
 */
export function believableDelay(random = Math.random) {
  return random() < 0.25 ? 1400 + random() * 900 : 2500 + random() * 2500;
}
