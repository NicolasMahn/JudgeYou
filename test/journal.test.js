import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../server/journal.js';
import { createScrubber } from '../server/scrub.js';
import { unseal } from '../server/seal.js';
import { openStore } from '../server/store.js';
import { buildRequest } from '../js/questions.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const chat = [
  { author: 'Tobi Berg', text: 'Mara, call me on +49 151 2345 6789 or tobi@example.com' },
  { author: 'Mara', text: 'Tobi, we said 25.10.2026, not today' },
];
const request = buildRequest(chat, ['Tobi Berg', 'Mara']).body;
const payload = { model: 'jev', usage: { cost: 0.0001 }, answers: { culprit: { choice: 'Mara' } } };

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'judgeyou-')), 'test.db');
  const store = openStore(path);
  const journal = createJournal({ store, publicKey, visitorId: () => 'visitor' });
  const rows = () => new DatabaseSync(path).prepare('SELECT * FROM judgments').all();
  return { journal, rows };
}

const write = (journal, overrides = {}) =>
  journal.write({ ip: '1.2.3.4', request, context: { source: 'paste', lang: 'de' }, keep: true, status: 200, ms: 5, payload, ...overrides });

test('a kept chat is unreadable without the private key and has no names or numbers', () => {
  const { journal, rows } = setup();
  assert.match(write(journal), /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const [row] = rows();
  const stored = Buffer.from(row.chat).toString('latin1') + row.answers;
  for (const secret of ['Tobi', 'Mara', '2345', 'example.com']) assert.ok(!stored.includes(secret), secret);

  const kept = unseal(Buffer.from(row.chat), privateKey);
  for (const secret of ['Tobi', 'Mara', '2345', 'example.com']) assert.ok(!kept.includes(secret), secret);
  assert.deepEqual(JSON.parse(kept).state.messages[0], {
    from: 'Person 1',
    text: 'Person 2, call me on [phone] or [email]',
  });
  assert.equal(JSON.parse(row.answers).culprit.choice, 'Person 2');
});

test('the deletion code removes the chat but keeps the nameless row', () => {
  const { journal, rows } = setup();
  const code = write(journal);
  assert.equal(journal.forget('XXXX-XXXX-XXXX'), false);
  assert.equal(journal.forget(code.toLowerCase()), true);
  assert.equal(rows()[0].chat, null);
  assert.equal(rows()[0].status, 200);
  assert.equal(journal.forget(code), false);
});

test('without consent, for the sample, or on failure only metadata is written', () => {
  const { journal, rows } = setup();
  assert.equal(write(journal, { keep: false }), null);
  assert.equal(write(journal, { context: { source: 'sample' } }), null);
  assert.equal(write(journal, { status: 500, payload: null }), null);
  assert.deepEqual(rows().map((r) => [r.chat, r.people, r.messages_sent]), [
    [null, 2, 2],
    [null, 2, 2],
    [null, 2, 2],
  ]);
});

test('scrubbing keeps dates and short numbers, and leaves a first name two people share alone', () => {
  const scrub = createScrubber(['Anna Lee', 'Anna Smith', 'Bo']);
  assert.equal(scrub('Anna Lee told Anna and Bo: 25.10.2026, 3 pm, room 12'), 'Person 1 told Anna and Person 3: 25.10.2026, 3 pm, room 12');
  assert.equal(scrub('Bob is not Bo'), 'Bob is not Person 3');
});
