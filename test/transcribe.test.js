import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriber, datedTranscript } from '../server/transcribe.js';
import { parseChat } from '../js/parse.js';

test('a time earlier than the one before starts a new day, counted back from today', () => {
  const text = ['20:44 - Jannik: Hab morgen Vorlesung', '23:12 - Emanuel: ?', '13:23 - Jannik: Wann heute?', '00:17 - Jannik: P85PND', '12:55 - Jannik: Jetzt?'].join('\n');
  assert.deepEqual(datedTranscript(text, '2026-10-25').split('\n'), [
    '2026-10-23, 20:44 - Jannik: Hab morgen Vorlesung',
    '2026-10-23, 23:12 - Emanuel: ?',
    '2026-10-24, 13:23 - Jannik: Wann heute?',
    '2026-10-25, 00:17 - Jannik: P85PND',
    '2026-10-25, 12:55 - Jannik: Jetzt?',
  ]);
});

test('messages copied without a usable time share the previous one, and the page parses them all', () => {
  const text = '```\n13:08 - Emanuel: Bin jetzt Mittagessen mit oma\n4m - Emanuel: Jetzt?\nNow - Jannik: B4AD7J\n```';
  const dated = datedTranscript(text, '2026-10-25');
  assert.equal(dated, ['2026-10-25, 13:08 - Emanuel: Bin jetzt Mittagessen mit oma', '2026-10-25, 13:08 - Emanuel: Jetzt?', '2026-10-25, 13:08 - Jannik: B4AD7J'].join('\n'));
  assert.deepEqual(parseChat(dated).map((m) => m.author), ['Emanuel', 'Emanuel', 'Jannik']);
});

test('an answer cut off at the token limit is refused, not passed on half-read', async () => {
  const transcribe = createTranscriber({
    key: 'k',
    model: 'm',
    post: async () => ({ choices: [{ finish_reason: 'length', message: { content: '13:00 - Ana: hi\n'.repeat(500) } }] }),
  });
  await assert.rejects(transcribe({ images: ['data:image/png;base64,AA=='], today: '2026-10-25' }), { status: 502 });
});
