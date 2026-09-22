import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChat, participantsOf } from '../js/parse.js';

test('reads iOS-style WhatsApp exports', () => {
  const chat = '[2026-09-18, 19:02:11] Mara: hi all\n[2026-09-18, 19:03:40] Jonas: 👍';
  assert.deepEqual(parseChat(chat), [
    { author: 'Mara', text: 'hi all' },
    { author: 'Jonas', text: '👍' },
  ]);
});

test('reads Android-style exports with 12-hour times', () => {
  const chat = '9/18/26, 7:02 PM - Mara Schulz: hi all\n9/18/26, 7:03 PM - Jonas: yo';
  assert.deepEqual(
    parseChat(chat).map((m) => m.author),
    ['Mara Schulz', 'Jonas'],
  );
});

test('joins multi-line messages, even when a line looks like a speaker', () => {
  const chat = '[2026-09-18, 19:02:11] Mara: plan:\nNote: bring cash\nsee you';
  assert.deepEqual(parseChat(chat), [{ author: 'Mara', text: 'plan:\nNote: bring cash\nsee you' }]);
});

test('skips WhatsApp system notices and media placeholders', () => {
  const chat = [
    '[2026-09-18, 19:00:00] Leo’s Birthday: ‎Messages and calls are end-to-end encrypted.',
    '[2026-09-18, 19:02:11] Mara: hi',
    '[2026-09-18, 19:02:30] Tobi: ‎image omitted',
  ].join('\n');
  assert.deepEqual(parseChat(chat), [{ author: 'Mara', text: 'hi' }]);
});

test('reads plain "Name: message" chats but ignores sentences with colons', () => {
  const chat = 'Ana: are you coming?\nHere is the thing about tonight: no\nBen: k';
  assert.deepEqual(parseChat(chat), [
    { author: 'Ana', text: 'are you coming?\nHere is the thing about tonight: no' },
    { author: 'Ben', text: 'k' },
  ]);
});

test('ranks participants by message count', () => {
  const messages = parseChat('A: 1\nB: 2\nB: 3');
  assert.deepEqual(participantsOf(messages), [
    { name: 'B', messageCount: 2 },
    { name: 'A', messageCount: 1 },
  ]);
});
