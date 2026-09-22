import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, readVerdicts } from '../js/questions.js';

test('answers for each subject come back to the right person', () => {
  const subjects = ['Ana', 'Ben'];
  const { body } = buildRequest([{ author: 'Ana', text: 'hi' }], subjects);

  // Answer every question with its own key, so any mix-up is visible.
  const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key, key]));
  const { culprit, people } = readVerdicts(answers, subjects);

  assert.equal(culprit, 'culprit');
  assert.equal(people[1].name, 'Ben');
  assert.equal(people[1].answers.drama, 'p1_drama');
  assert.match(body.questions.p1_drama.instructions, /Ben/);
});

test('keeps only the newest messages when the chat is too long', () => {
  const longText = 'x'.repeat(10_000);
  const messages = Array.from({ length: 10 }, (_, i) => ({ author: `P${i}`, text: longText }));
  const { body, judgedCount } = buildRequest(messages, ['P8', 'P9']);

  assert.ok(judgedCount < messages.length);
  assert.equal(body.state.messages.at(-1).from, 'P9');
});

test('unrecognised formats are sent as raw text with the named participants', () => {
  const raw = 'x'.repeat(60_000) + 'the end';
  const { body, judgedCount } = buildRequest(raw, ['Ana', 'Ben']);

  assert.equal(judgedCount, null);
  assert.deepEqual(body.state.participants, ['Ana', 'Ben']);
  assert.ok(body.state.transcript.endsWith('the end'));
  assert.ok(body.state.transcript.length <= 50_000);
});
