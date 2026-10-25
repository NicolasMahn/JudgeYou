import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChat } from '../js/parse.js';
import { NOBODY, readVerdicts } from '../js/questions.js';
import { SAMPLES } from '../js/sample.js';
import { defaultSubjects, storedAnswers } from '../js/sample-verdicts.js';

// Fails when a sample or the questions change without rerunning
// scripts/sample-verdicts.js, which would otherwise replay a stale verdict.
test('every sample has a stored verdict that answers every question', async () => {
  for (const { id, chat } of SAMPLES) {
    const subjects = defaultSubjects(parseChat(chat));
    const { answers, sampleId } = (await storedAnswers(chat, subjects)) ?? {};
    assert.ok(answers, `${id} has no stored verdict for ${subjects.join(', ')}`);
    assert.equal(sampleId, id);
    const { culprit, people } = readVerdicts(answers, subjects);
    assert.ok([...subjects, NOBODY].includes(culprit.choice), id);
    for (const person of people) {
      for (const [key, answer] of Object.entries(person.answers)) assert.ok(answer, `${id}: ${person.name} ${key}`);
    }
  }
});

test('an edited sample or a spared person is judged for real', async () => {
  const { chat } = SAMPLES[0];
  const subjects = defaultSubjects(parseChat(chat));
  assert.equal(await storedAnswers(`${chat}\nMara: one more thing`, subjects), null);
  assert.equal(await storedAnswers(chat, subjects.slice(1)), null);
});
