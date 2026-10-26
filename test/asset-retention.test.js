import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, gzipSync } from 'node:zlib';
import { prepareAssets } from '../server/assets.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-10-01T00:00:00.000Z');
const OLD = 'chunk-AAAAAAAA.js';
const CURRENT = 'chunk-BBBBBBBB.js';
const LEDGER = '.retention.json';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'judgeyou-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builtDir = join(root, 'built-assets');
  const publicDir = join(root, 'dist');
  const assetsDir = join(publicDir, 'assets');
  await mkdir(builtDir);
  await mkdir(assetsDir, { recursive: true });
  const sync = (days = 0) => prepareAssets({ builtDir, assetsDir, now: new Date(START + days * DAY) });
  const publish = async (files) => {
    for (const name of await readdir(builtDir)) await rm(join(builtDir, name));
    for (const [name, content] of Object.entries(files)) await writeFile(join(builtDir, name), content);
  };
  return { root, builtDir, publicDir, assetsDir, sync, publish };
}

const missing = async (path) => assert.rejects(lstat(path), { code: 'ENOENT' });
const ledgerAt = (assetsDir) => readFile(join(assetsDir, LEDGER), 'utf8').then(JSON.parse);

test('retains old hashes and encodings for seven days after removal, regardless of file age', async (t) => {
  const { assetsDir, sync, publish } = await fixture(t);
  const oldFiles = { [OLD]: 'old lazy module', [`${OLD}.br`]: brotliCompressSync('old lazy module'), [`${OLD}.gz`]: gzipSync('old lazy module') };
  await publish({ ...oldFiles, 'shared-CCCCCCCC.woff2': 'font' });
  await sync();
  for (const name of Object.keys(oldFiles)) await utimes(join(assetsDir, name), new Date(0), new Date(0));
  await publish({ [CURRENT]: 'new lazy module', 'shared-CCCCCCCC.woff2': 'font' });
  await sync(100);
  assert.equal((await ledgerAt(assetsDir)).assets[OLD], '2027-01-09T00:00:00.000Z');
  await sync(106.999);
  for (const [name, content] of Object.entries(oldFiles)) {
    assert.deepEqual(await readFile(join(assetsDir, name)), Buffer.from(content));
  }
  await sync(107);
  for (const name of Object.keys(oldFiles)) await missing(join(assetsDir, name));
  assert.equal(await readFile(join(assetsDir, CURRENT), 'utf8'), 'new lazy module');
  assert.equal(await readFile(join(assetsDir, 'shared-CCCCCCCC.woff2'), 'utf8'), 'font');
  assert.deepEqual((await ledgerAt(assetsDir)).assets, { [CURRENT]: null, 'shared-CCCCCCCC.woff2': null });
});

test('rollback rescues an expired hash and starts a fresh window when it leaves again', async (t) => {
  const { assetsDir, sync, publish } = await fixture(t);
  await publish({ [OLD]: 'old' });
  await sync();
  await publish({ [CURRENT]: 'current' });
  await sync(1);
  await publish({ [OLD]: 'old' });
  await sync(20);
  assert.equal((await ledgerAt(assetsDir)).assets[OLD], null);
  await publish({ [CURRENT]: 'current' });
  await sync(21);
  await sync(27);
  assert.equal(await readFile(join(assetsDir, OLD), 'utf8'), 'old');
  await sync(28);
  await missing(join(assetsDir, OLD));
});

test('prunes only ledger-owned files, leaving unknown files and symlinks untouched', async (t) => {
  const { root, assetsDir, sync, publish } = await fixture(t);
  await publish({ [OLD]: 'old' });
  await sync();
  await publish({ [CURRENT]: 'current' });
  await sync(1);
  const unknown = 'chunk-DDDDDDDD.js';
  await writeFile(join(assetsDir, unknown), 'unowned');
  await writeFile(join(root, 'private'), 'private');
  await symlink(join(root, 'private'), join(assetsDir, 'chunk-EEEEEEEE.js'));
  await mkdir(join(assetsDir, 'unowned-directory'));
  await writeFile(join(assetsDir, 'unowned-directory', 'keep'), 'keep');
  await sync(8);
  await missing(join(assetsDir, OLD));
  assert.equal(await readFile(join(assetsDir, unknown), 'utf8'), 'unowned');
  assert.ok((await lstat(join(assetsDir, 'chunk-EEEEEEEE.js'))).isSymbolicLink());
  assert.equal(await readFile(join(assetsDir, 'unowned-directory', 'keep'), 'utf8'), 'keep');
  assert.equal(await readFile(join(root, 'private'), 'utf8'), 'private');
});

test('invalid ledgers fail closed before copying or pruning', async (t) => {
  const { root, assetsDir, sync, publish } = await fixture(t);
  await publish({ [CURRENT]: 'current' });
  await writeFile(join(root, 'private'), 'private');
  for (const assets of [
    { '../private': '2026-01-01T00:00:00.000Z' },
    { '/tmp/private': null },
    { 'nested/chunk-AAAAAAAA.js': null },
    { 'chunk-AAAAAAAA.js\\private': null },
    { 'key.js': null },
    { [OLD]: 0 },
    { [OLD]: 'invalid' },
  ]) {
    await writeFile(join(assetsDir, LEDGER), JSON.stringify({ version: 1, assets }));
    await assert.rejects(sync(), /Invalid asset retention/);
    await missing(join(assetsDir, CURRENT));
  }
  for (const content of ['{', 'null', '{"version":2,"assets":{}}']) {
    await writeFile(join(assetsDir, LEDGER), content);
    await assert.rejects(sync());
  }
  assert.equal(await readFile(join(root, 'private'), 'utf8'), 'private');
});

test('rejects source symlinks and unexpected private files before modifying retained assets', async (t) => {
  const { root, builtDir, assetsDir, sync, publish } = await fixture(t);
  await publish({ [OLD]: 'old' });
  await sync();
  await publish({ [CURRENT]: 'current' });
  await sync(1);
  await writeFile(join(root, 'private'), 'private');
  await symlink(join(root, 'private'), join(builtDir, 'chunk-CCCCCCCC.js'));
  await assert.rejects(sync(20), /regular asset file/);
  await rm(join(builtDir, 'chunk-CCCCCCCC.js'));
  for (const name of ['key.js', '.env', 'chunk-CCCCCCCC.js.map']) {
    await writeFile(join(builtDir, name), 'private');
    await assert.rejects(sync(20), /Unexpected built asset/);
    await rm(join(builtDir, name));
  }
  await publish({});
  await assert.rejects(sync(20), /empty/);
  assert.equal(await readFile(join(assetsDir, OLD), 'utf8'), 'old');
});

test('rejects symlinks or directories at owned destinations and ledger paths', async (t) => {
  const { root, assetsDir, sync, publish } = await fixture(t);
  await publish({ [OLD]: 'old' });
  await sync();
  await publish({ [CURRENT]: 'current' });
  await sync(1);
  await writeFile(join(root, 'private'), 'private');
  await rm(join(assetsDir, OLD));
  await symlink(join(root, 'private'), join(assetsDir, OLD));
  await assert.rejects(sync(8), /regular asset file/);
  assert.ok((await lstat(join(assetsDir, OLD))).isSymbolicLink());
  await rm(join(assetsDir, OLD));
  await mkdir(join(assetsDir, OLD));
  await writeFile(join(assetsDir, OLD, 'keep'), 'keep');
  await assert.rejects(sync(8), /regular asset file/);
  assert.equal(await readFile(join(assetsDir, OLD, 'keep'), 'utf8'), 'keep');
  await rm(join(assetsDir, OLD), { recursive: true });
  await rm(join(assetsDir, LEDGER));
  await symlink(join(root, 'private'), join(assetsDir, LEDGER));
  await assert.rejects(sync(8), /regular asset file/);
  assert.equal(await readFile(join(root, 'private'), 'utf8'), 'private');
});

test('rejects symlinked cache roots, source roots, and current destinations', async (t) => {
  const { root, builtDir, assetsDir, sync, publish } = await fixture(t);
  await publish({ [CURRENT]: 'current' });
  await writeFile(join(root, 'private'), 'private');
  await symlink(join(root, 'private'), join(assetsDir, CURRENT));
  await assert.rejects(sync(), /regular asset file/);
  await rm(join(assetsDir, CURRENT));
  await symlink(assetsDir, join(root, 'linked-cache'));
  await assert.rejects(prepareAssets({ builtDir, assetsDir: join(root, 'linked-cache') }), /symlinks/);
  await symlink(builtDir, join(root, 'linked-build'));
  await assert.rejects(prepareAssets({ builtDir: join(root, 'linked-build'), assetsDir }), /symlinks/);
  await symlink(root, join(root, 'linked-parent'));
  await assert.rejects(prepareAssets({ builtDir, assetsDir: join(root, 'linked-parent', 'missing-cache') }));
  await missing(join(root, 'missing-cache'));
  await assert.rejects(prepareAssets({ builtDir, assetsDir: builtDir }), /separate/);
  assert.equal(await readFile(join(root, 'private'), 'utf8'), 'private');
});

test('retries interrupted pruning when an owned file is already missing', async (t) => {
  const { assetsDir, sync, publish } = await fixture(t);
  await publish({ [OLD]: 'old' });
  await sync();
  await publish({ [CURRENT]: 'current' });
  await sync(1);
  await rm(join(assetsDir, OLD));
  await sync(8);
  assert.deepEqual((await ledgerAt(assetsDir)).assets, { [CURRENT]: null });
  assert.deepEqual((await readdir(assetsDir)).sort(), [LEDGER, CURRENT].sort());
});

test('serves old and current assets after sync but never the ledger or hidden directories', async (t) => {
  const { publicDir, assetsDir, sync, publish } = await fixture(t);
  await publish({ [OLD]: 'old', [`${OLD}.br`]: brotliCompressSync('old') });
  await sync();
  await publish({ [CURRENT]: 'current' });
  await sync(1);
  await mkdir(join(publicDir, 'server'));
  await copyFile(new URL('../server/static.js', import.meta.url), join(publicDir, 'server/static.mjs'));
  await mkdir(join(assetsDir, '.hidden'));
  await writeFile(join(assetsDir, '.hidden', 'visible.js'), 'private');
  const previous = { public: process.env.PUBLIC_DIR, mode: process.env.NODE_ENV };
  let serveFile;
  try {
    process.env.PUBLIC_DIR = publicDir;
    process.env.NODE_ENV = 'production';
    ({ serveFile } = await import(pathToFileURL(join(publicDir, 'server/static.mjs'))));
  } finally {
    if (previous.public === undefined) delete process.env.PUBLIC_DIR;
    else process.env.PUBLIC_DIR = previous.public;
    if (previous.mode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.mode;
  }
  const server = createServer((req, res) => serveFile(req, res, req.url));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
  // fetch decodes the prepared encoding, proving the old compressed sibling works.
  const old = await get(`/assets/${OLD}`, { 'Accept-Encoding': 'br' });
  assert.equal(old.status, 200);
  assert.equal(old.headers.get('content-encoding'), 'br');
  assert.equal(await old.text(), 'old');
  assert.equal(await (await get(`/assets/${CURRENT}`)).text(), 'current');
  for (const path of ['/assets/.retention.json', '/assets/%2eretention.json', '/assets/.hidden/visible.js']) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.deepEqual(brotliDecompressSync(await readFile(join(assetsDir, `${OLD}.br`))), Buffer.from('old'));
});

test('startup fails before creating journal data when asset preparation fails', async (t) => {
  const { root, builtDir, publicDir, assetsDir } = await fixture(t);
  await writeFile(join(assetsDir, LEDGER), 'invalid ledger');
  const dataDir = join(root, 'journal-must-not-be-created');
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BUILT_ASSETS_DIR: builtDir, PUBLIC_DIR: publicDir, DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /JSON/);
  await missing(dataDir);
});
