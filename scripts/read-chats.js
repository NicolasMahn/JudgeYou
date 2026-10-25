// Prints the kept chats of a database copy as JSON lines, one Jev request
// each, ready to replay against a new approach:
//
//   node scripts/read-chats.js judgeyou.db > chats.jsonl
//
// Needs the private key, which only exists on the operator's machine.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unseal } from '../server/seal.js';

const [dbPath] = process.argv.slice(2);
if (!dbPath) {
  console.error('Usage: node scripts/read-chats.js <judgeyou.db>');
  process.exit(1);
}
const keyPath = process.env.CHATS_PRIVATE_KEY ?? join(homedir(), '.config/judgeyou/chats-private.pem');
const privateKey = readFileSync(keyPath);

const db = new DatabaseSync(dbPath, { readOnly: true });
for (const row of db.prepare('SELECT id, at, answers, chat FROM judgments WHERE chat IS NOT NULL ORDER BY id').iterate()) {
  const request = JSON.parse(unseal(Buffer.from(row.chat), privateKey));
  console.log(JSON.stringify({ id: row.id, at: row.at, request, answers: JSON.parse(row.answers) }));
}
