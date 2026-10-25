// Sample chats are judged once ahead of time (scripts/sample-verdicts.js).
// When a chat is exactly a sample, judged with its default people, the page
// replays the stored answers: nothing is sent, so no consent or cost.
import { participantsOf } from './parse.js';
import { MAX_SUBJECTS } from './questions.js';
import { SAMPLES } from './sample.js';

/** Who the page judges when nobody is spared. */
export const defaultSubjects = (messages) => participantsOf(messages).map((p) => p.name).slice(0, MAX_SUBJECTS);

/**
 * Loads the stored answers and sample ID when `chat` and `subjects` are
 * exactly a sample's, otherwise resolves to null.
 */
export async function storedAnswers(chat, subjects) {
  const sample = SAMPLES.find((candidate) => candidate.chat === chat);
  if (!sample) return null;
  const { SAMPLE_ANSWERS } = await import('./sample-answers.js');
  const stored = SAMPLE_ANSWERS[sample.id];
  if (!stored || stored.subjects.join('\n') !== subjects.join('\n')) return null;
  return { sampleId: sample.id, answers: stored.answers };
}
