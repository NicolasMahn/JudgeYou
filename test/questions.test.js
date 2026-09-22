import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, readVerdicts, STATE_TOKEN_BUDGET } from '../js/questions.js';

// Measured: one Jev token is ~2.06 UTF-8 bytes of state in any language.
const stateTokens = (body) => new TextEncoder().encode(JSON.stringify(body.state)).length / 2.06;

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

test('long chats in any script are cut to fit Jev’s token limit, newest kept', () => {
  for (const text of ['ok sounds good 👍', 'Ich find das echt unfair 🙄🎉', '今夜誰が来る？ポテトチップス持っていくよ']) {
    const messages = Array.from({ length: 20_000 }, (_, i) => ({ author: i % 2 ? 'Ana' : 'Ben', text: `${i} ${text}` }));
    const { body, truncated } = buildRequest(messages, ['Ana', 'Ben']);

    assert.ok(truncated);
    assert.ok(stateTokens(body) <= STATE_TOKEN_BUDGET, `${text}: ${stateTokens(body)} tokens`);
    assert.ok(stateTokens(body) > STATE_TOKEN_BUDGET * 0.9, 'budget should be used, not wasted');
    assert.equal(body.state.messages.at(-1).text, `19999 ${text}`);
  }
});

test('unrecognised formats are sent as raw text with the named participants', () => {
  const raw = '今夜誰が来る？'.repeat(20_000) + 'the end';
  const { body, judgedCount, truncated } = buildRequest(raw, ['Ana', 'Ben']);

  assert.equal(judgedCount, null);
  assert.ok(truncated);
  assert.deepEqual(body.state.participants, ['Ana', 'Ben']);
  assert.ok(body.state.transcript.endsWith('the end'));
  assert.ok(stateTokens(body) <= STATE_TOKEN_BUDGET);
});
