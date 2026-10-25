import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettings } from '../server/settings.js';
import { createApp } from '../server/server.js';

const ORIGIN = 'https://judge-you.de';
const TOKEN = 'a'.repeat(32);
const DEFAULTS = {
  decisions: { perIpPerHour: 20, perDay: 1000, maxConcurrent: 32 },
  screenshots: { perIpPerHour: 20, perDay: 1000, maxConcurrent: 4 },
  timeoutMs: 30_000,
};

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'judgeyou-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function start(t, options = {}) {
  const settings = createSettings({ env: {} });
  const app = createApp({ key: 'test-key', origins: [ORIGIN], settings, adminToken: TOKEN, ...options });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    app.closeAllConnections();
    app.close(resolve);
  }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const admin = ({ method = 'GET', token = TOKEN, origin, body } = {}) => fetch(`${base}/api/admin/settings`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(origin === undefined ? {} : { Origin: origin }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { base, settings, admin };
}

test('settings have bounded concurrency defaults and return independent snapshots', async () => {
  const settings = createSettings({ env: {} });
  assert.deepEqual(settings.get(), DEFAULTS);
  const snapshot = settings.get();
  snapshot.decisions.maxConcurrent = 1;
  assert.deepEqual(settings.get(), DEFAULTS);

  const next = structuredClone(DEFAULTS);
  next.decisions.perIpPerHour = 0;
  next.screenshots.perDay = 0;
  next.timeoutMs = 1000;
  await settings.update(next);
  const expected = structuredClone(next);
  next.decisions.perIpPerHour = 100;
  assert.deepEqual(settings.get(), expected);
});

test('environment settings configure both models, with screenshot-specific overrides', () => {
  const env = {
    LIMIT_PER_IP_PER_HOUR: '7', LIMIT_PER_DAY: '81', MAX_CONCURRENT_DECISIONS: '5',
    MAX_CONCURRENT_SCREENSHOTS: '2', UPSTREAM_TIMEOUT_MS: '1000',
  };
  assert.deepEqual(createSettings({ env }).get(), {
    decisions: { perIpPerHour: 7, perDay: 81, maxConcurrent: 5 },
    screenshots: { perIpPerHour: 7, perDay: 81, maxConcurrent: 2 }, timeoutMs: 1000,
  });
  const overridden = createSettings({ env: { ...env, SCREENSHOT_LIMIT_PER_IP_PER_HOUR: '0', SCREENSHOT_LIMIT_PER_DAY: '13' } }).get();
  assert.deepEqual(overridden.screenshots, { perIpPerHour: 0, perDay: 13, maxConcurrent: 2 });
});

test('invalid environment values stop startup instead of disabling protection', () => {
  for (const name of [
    'LIMIT_PER_IP_PER_HOUR', 'LIMIT_PER_DAY', 'SCREENSHOT_LIMIT_PER_IP_PER_HOUR',
    'SCREENSHOT_LIMIT_PER_DAY', 'MAX_CONCURRENT_DECISIONS', 'MAX_CONCURRENT_SCREENSHOTS', 'UPSTREAM_TIMEOUT_MS',
  ]) {
    for (const value of ['', ' ', 'no', '1.5', '-1', 'Infinity']) {
      assert.throws(() => createSettings({ env: { [name]: value } }), `${name}=${JSON.stringify(value)}`);
    }
  }
  assert.throws(() => createSettings({ env: { MAX_CONCURRENT_DECISIONS: '0' } }));
  assert.throws(() => createSettings({ env: { UPSTREAM_TIMEOUT_MS: '999' } }));
});

test('updates require complete settings with only known integer fields', async () => {
  const settings = createSettings({ env: {} });
  const invalid = [null, [], {}, { ...DEFAULTS, unknown: 1 }, { ...DEFAULTS, timeoutMs: 999 }];
  const missingTimeout = structuredClone(DEFAULTS);
  delete missingTimeout.timeoutMs;
  invalid.push(missingTimeout);
  for (const timeoutMs of ['1000', 1000.5, null, Number.NaN, Number.POSITIVE_INFINITY]) {
    invalid.push({ ...DEFAULTS, timeoutMs });
  }
  for (const group of ['decisions', 'screenshots']) {
    invalid.push({ ...DEFAULTS, [group]: [] }, { ...DEFAULTS, [group]: { ...DEFAULTS[group], unknown: 1 } });
    for (const field of Object.keys(DEFAULTS[group])) {
      const missing = structuredClone(DEFAULTS);
      delete missing[group][field];
      invalid.push(missing);
      for (const value of ['2', 1.5, -1, null, Number.NaN, Number.POSITIVE_INFINITY]) {
        invalid.push({ ...DEFAULTS, [group]: { ...DEFAULTS[group], [field]: value } });
      }
    }
    invalid.push({ ...DEFAULTS, [group]: { ...DEFAULTS[group], maxConcurrent: 0 } });
  }
  for (const value of invalid) {
    await assert.rejects(settings.update(value));
    assert.deepEqual(settings.get(), DEFAULTS);
  }
});

test('saved settings replace the file atomically and survive a restart', async (t) => {
  const file = join(await temporaryDirectory(t), 'settings.json');
  const settings = createSettings({ file, env: {} });
  await settings.update(DEFAULTS);
  const previousFile = await open(file, 'r');
  t.after(() => previousFile.close());
  const next = { ...DEFAULTS, timeoutMs: 1000 };
  await settings.update(next);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), next);
  // An open reader retains the complete old file across the replacement.
  assert.deepEqual(JSON.parse(await previousFile.readFile('utf8')), DEFAULTS);
  assert.deepEqual(createSettings({ file, env: { LIMIT_PER_DAY: '4' } }).get(), next);
});

test('a failed save leaves disk and live settings intact, and a later save recovers', async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, 'live');
  const savedDirectory = join(root, 'saved');
  await mkdir(directory);
  const file = join(directory, 'settings.json');
  const settings = createSettings({ file, env: {} });
  await settings.update(DEFAULTS);
  await rename(directory, savedDirectory);
  await writeFile(directory, 'blocks writes to the settings directory');
  const next = { ...DEFAULTS, timeoutMs: 1000 };
  await assert.rejects(settings.update(next));
  assert.deepEqual(settings.get(), DEFAULTS);
  assert.deepEqual(JSON.parse(await readFile(join(savedDirectory, 'settings.json'), 'utf8')), DEFAULTS);
  await rm(directory);
  await rename(savedDirectory, directory);
  await settings.update(next);
  assert.deepEqual(settings.get(), next);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), next);
});

test('concurrent saves keep the last requested settings on disk and in memory', async (t) => {
  const file = join(await temporaryDirectory(t), 'settings.json');
  const settings = createSettings({ file, env: {} });
  const first = { ...DEFAULTS, timeoutMs: 1000 };
  const last = { ...DEFAULTS, timeoutMs: 2000 };
  await Promise.all([settings.update(first), settings.update(last)]);
  assert.deepEqual(settings.get(), last);
  assert.deepEqual(createSettings({ file, env: {} }).get(), last);
});

test('invalid persisted settings fail startup rather than silently resetting limits', async (t) => {
  const file = join(await temporaryDirectory(t), 'settings.json');
  for (const content of ['{', JSON.stringify({ ...DEFAULTS, timeoutMs: 0 })]) {
    await writeFile(file, content);
    assert.throws(() => createSettings({ file, env: {} }));
  }
});

test('admin routes are hidden without a token and short tokens stop startup', async (t) => {
  assert.throws(() => createApp({ key: 'test-key', adminToken: 'x'.repeat(31) }));
  const { base, admin } = await start(t, { adminToken: null });
  assert.equal((await fetch(`${base}/admin`)).status, 404);
  assert.equal((await admin()).status, 404);
  assert.equal((await admin({ method: 'PUT', origin: ORIGIN, body: DEFAULTS })).status, 404);
});

test('admin settings require bearer authentication and writes require an allowed Origin', async (t) => {
  const { base, admin, settings } = await start(t);
  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.ok(!(await page.text()).includes(TOKEN));

  for (const token of [null, 'wrong-token']) {
    const response = await admin({ token });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await admin({ method: 'PUT', token, origin: ORIGIN, body: DEFAULTS })).status, 401);
  }
  for (const origin of [undefined, 'https://example.com']) {
    const response = await admin({ method: 'PUT', origin, body: { ...DEFAULTS, timeoutMs: 1000 } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(settings.get(), DEFAULTS);
});

test('admin reads and saves full settings and usage without caching', async (t) => {
  const { admin, settings } = await start(t);
  const read = await admin();
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  const initial = await read.json();
  assert.deepEqual(initial.settings, DEFAULTS);
  for (const group of ['decisions', 'screenshots']) {
    const { resetsAt, ...usage } = initial.usage[group];
    assert.deepEqual(usage, { ...DEFAULTS[group], active: 0, refused: 0, usedToday: 0 });
    assert.equal(new Date(resetsAt).toISOString(), resetsAt);
    assert.ok(Date.parse(resetsAt) > Date.now());
  }
  const next = structuredClone(DEFAULTS);
  next.decisions.perDay = 0;
  next.screenshots.maxConcurrent = 2;
  const saved = await admin({ method: 'PUT', origin: ORIGIN, body: next });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  const result = await saved.json();
  assert.deepEqual(result.settings, next);
  assert.equal(result.usage.decisions.perDay, 0);
  assert.equal(result.usage.screenshots.maxConcurrent, 2);
  assert.deepEqual(settings.get(), next);
  for (const body of ['{', {}, { ...next, extra: true }, { ...next, timeoutMs: 1.5 }]) {
    const invalid = await admin({ method: 'PUT', origin: ORIGIN, body });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('cache-control'), 'no-store');
    assert.deepEqual(settings.get(), next);
  }
});
