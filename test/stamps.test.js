import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChat } from '../js/parse.js';

const at = (raw) => parseChat(raw).map((m) => (m.at === null ? null : new Date(m.at).toISOString().slice(0, 16)));

test('German and US WhatsApp stamps across midnight', () => {
  const german = ['19.09.26, 23:59 - Mara: still up?', '20.09.26, 00:01 - Tobi: no'].join('\n');
  assert.deepEqual(at(german), ['2026-09-19T23:59', '2026-09-20T00:01']);

  const us = ['[9/19/26, 11:59:00 PM] Mara: still up?', '[9/20/26, 12:01:00 AM] Tobi: no', '[9/20/26, 12:30:00 PM] Mara: morning'].join('\n');
  assert.deepEqual(at(us), ['2026-09-19T23:59', '2026-09-20T00:01', '2026-09-20T12:30']);
});

test('ambiguous dates are read in the order the rest of the chat proves', () => {
  const dayFirst = ['03/04/2026, 10:00 - Mara: a', '05/04/2026, 10:00 - Tobi: b'].join('\n');
  assert.deepEqual(at(dayFirst), ['2026-04-03T10:00', '2026-04-05T10:00']);

  const monthFirst = ['03/04/2026, 10:00 - Mara: a', '03/13/2026, 10:00 - Tobi: b'].join('\n');
  assert.deepEqual(at(monthFirst), ['2026-03-04T10:00', '2026-03-13T10:00']);
});

test('media placeholders are dropped without shifting the stamps of real messages', () => {
  const chat = [
    '[19.09.26, 21:02:11] Mara: look',
    '[19.09.26, 21:03:40] Tobi: ‎image omitted',
    '[19.09.26, 21:05:00] Tobi: nice',
  ].join('\n');
  assert.deepEqual(at(chat), ['2026-09-19T21:02', '2026-09-19T21:05']);
});

test('time without a date stays unknown instead of guessing the day', () => {
  assert.deepEqual(at('[21:14] <Mara> hi\n[21:15] <Tobi> no'), [null, null]);
  assert.deepEqual(at('Ana: meet at 19.09.26 21:00?\nBen: ok\nAna: fine'), [null, null, null]);
});

test('structured exports keep their stamps', () => {
  const telegram = JSON.stringify({ messages: [{ type: 'message', from: 'Mara', date: '2026-09-19T21:14:03', text: 'hi' }] });
  assert.deepEqual(at(telegram), ['2026-09-19T21:14']);

  const messenger = JSON.stringify({ messages: [{ sender_name: 'Mara', timestamp_ms: Date.UTC(2026, 8, 19, 21, 14), content: 'hi' }] });
  assert.deepEqual(at(messenger), ['2026-09-19T21:14']);

  const csv = 'date,time,sender,message\n2026-09-19,21:14,Mara,hi';
  assert.deepEqual(at(csv), ['2026-09-19T21:14']);
});
