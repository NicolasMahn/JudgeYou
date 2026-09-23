import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatStats, recordsOf } from '../js/stats.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const say = (author, minute, text = 'ok') => ({ author, text, at: minute === null ? null : minute * MIN });

test('a reply is timed from the end of the other person’s block to the start of the next', () => {
  const stats = chatStats([
    say('Ana', 0), say('Ana', 5), say('Ben', 7), // Ben: 2 min after Ana's last message
    say('Ana', 8), say('Ben', 18), // 10 min
    say('Ana', 20), say('Ben', 24), // 4 min
  ]);
  assert.deepEqual(stats.get('Ben').reply, { median: 4 * MIN, n: 3 });
  assert.equal(stats.get('Ana').reply, null, 'two replies are too few for a median');
});

test('a night’s silence starts a new conversation instead of counting as a slow reply', () => {
  const stats = chatStats([say('Ana', 0), say('Ben', 1), say('Ben', 9 * 60), say('Ana', 9 * 60 + 1)]);
  assert.deepEqual(stats.get('Ben').starts, { count: 1, of: 2 });
  assert.deepEqual(stats.get('Ana').starts, { count: 1, of: 2 });
  assert.ok(!chatStats([say('Ana', 0), say('Ben', 7 * 60)]).get('Ben').reply);
});

test('without timestamps only counts are known, never times', () => {
  const stats = chatStats([say('Ana', null, 'one two three'), say('Ben', null), say('Ana', null, 'x')]);
  assert.deepEqual(stats.get('Ana'), { messages: 2, medianWords: 2, reply: null, starts: null });
});

test('records need two contenders and a clear winner', () => {
  const chat = [];
  // One conversation, so nobody can hold the starter record.
  // Each round: Ana replies to Cy after 4 min, Ben to Ana after 1, Cy to Ben after 10.
  for (let i = 0; i < 4; i++) chat.push(say('Ana', i * 15, 'a b c d'), say('Ben', i * 15 + 1, 'a b'), say('Cy', i * 15 + 11, 'a b'));
  const stats = chatStats(chat);
  const holders = (names) => Object.fromEntries(recordsOf(stats, names).map((r) => [r.key, r.name]));

  assert.deepEqual(holders(['Ana', 'Ben', 'Cy']), { slowest: 'Cy', fastest: 'Ben', wordiest: 'Ana' });
  assert.ok(!('wordiest' in holders(['Ben', 'Cy'])), 'Ben and Cy tie, so neither is wordier');
  assert.deepEqual(holders(['Ana']), {});
});
