import { lstat, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER = '.retention.json';
// Only flat, generated public assets and their prepared encodings are cache-owned.
const assetName = (name) => /^[A-Za-z0-9_-]+-[A-Za-z0-9]{8,}\.(?:js|css|woff2|svg)(?:\.(?:br|gz))?$/.test(name);
const inspect = (path) => lstat(path).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function directory(path) {
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
    throw new Error(`Asset directory must not contain symlinks: ${path}`);
  }
}

async function regularFile(path, required = false) {
  const info = await inspect(path);
  if (info ? !info.isFile() : required) throw new Error(`Expected a regular asset file: ${path}`);
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Run before listening, with one writer per volume. A failed sync stops startup. */
export async function prepareAssets({ builtDir, assetsDir, now = new Date() }) {
  builtDir = resolve(builtDir);
  assetsDir = resolve(assetsDir);
  if (builtDir === assetsDir) throw new Error('Built assets must be separate from the public asset cache.');
  const timestamp = now.toISOString();
  await directory(builtDir);
  await directory(assetsDir);

  const ledgerPath = join(assetsDir, LEDGER);
  await regularFile(ledgerPath);
  let ledger = { version: 1, assets: {} };
  if (await inspect(ledgerPath)) ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  if (ledger?.version !== 1 || !ledger.assets || typeof ledger.assets !== 'object' || Array.isArray(ledger.assets)) {
    throw new Error('Invalid asset retention ledger.');
  }
  for (const [name, retiredAt] of Object.entries(ledger.assets)) {
    if (!assetName(name) || (retiredAt !== null &&
      (typeof retiredAt !== 'string' || !Number.isFinite(Date.parse(retiredAt)) || new Date(retiredAt).toISOString() !== retiredAt))) {
      throw new Error('Invalid asset retention entry.');
    }
    await regularFile(join(assetsDir, name));
  }

  const current = await readdir(builtDir);
  if (!current.length) throw new Error('Built assets are empty.');
  // Validate the entire input before publishing anything or scheduling deletion.
  for (const name of current) {
    if (!assetName(name)) throw new Error(`Unexpected built asset: ${name}`);
    await regularFile(join(builtDir, name), true);
    await regularFile(join(assetsDir, name));
  }
  for (const name of current) await atomicWrite(join(assetsDir, name), await readFile(join(builtDir, name)));

  // Retirement starts when a file leaves the current build, even after months
  // without a restart. Reusing a hash makes it current again (including rollback).
  for (const name of Object.keys(ledger.assets)) ledger.assets[name] ??= timestamp;
  for (const name of current) ledger.assets[name] = null;
  const save = () => atomicWrite(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  // Save ownership first: interrupted pruning can safely retry at the next start.
  await save();
  let pruned = false;
  for (const [name, retiredAt] of Object.entries(ledger.assets)) {
    if (retiredAt === null || now.getTime() - Date.parse(retiredAt) < RETENTION_MS) continue;
    const path = join(assetsDir, name);
    await regularFile(path);
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    delete ledger.assets[name];
    pruned = true;
  }
  if (pruned) await save();
}
