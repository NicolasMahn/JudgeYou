// Writes a consistent copy of the journal to stdout while the server keeps
// running, so it can be pulled over SSH:
//
//   ssh root@judge-you.de docker exec judgeyou node server/export.js > copy.db
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const source = join(process.env.DATA_DIR ?? 'data', 'judgeyou.db');
const copy = join(tmpdir(), `judgeyou-export-${process.pid}.db`);
new DatabaseSync(source, { readOnly: true }).exec(`VACUUM INTO '${copy}'`);
process.stdout.write(readFileSync(copy));
rmSync(copy);
