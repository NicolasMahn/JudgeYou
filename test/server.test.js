import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';
import { createLimiter } from '../server/limits.js';

const ORIGIN = 'https://judge-you.de';
const JUDGE = 'test/judge';
const REQUEST = { state: { messages: [] }, questions: {} };
const SCREENSHOT = `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;
const DECISION = JSON.stringify({ request: REQUEST, keep: false, context: {} });

/**
 * Starts the app on a free port; `forwarded` collects decisions and `read`
 * screenshot requests that reached "OpenRouter".
 */
async function start(t, options = {}) {
  const forwarded = [];
  const read = [];
  const app = createApp({
    key: 'sk-or-test',
    origins: [ORIGIN],
    judgeModel: JUDGE,
    upstream: async (body) => {
      forwarded.push(body);
      return new Response('{"answers":{}}', { status: 200 });
    },
    transcribe: async (request) => {
      read.push(request);
      return { text: '2026-10-25, 13:08 - Ana: hi' };
    },
    ...options,
  });
  await new Promise((resolve) => app.listen(0, resolve));
  t.after(() => app.close());
  const base = `http://localhost:${app.address().port}`;
  const decide = (body = DECISION, origin = ORIGIN) =>
    fetch(`${base}/api/decisions`, { method: 'POST', headers: { Origin: origin }, body });
  const screenshots = (body, origin = ORIGIN) =>
    fetch(`${base}/api/screenshots`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) });
  return { base, decide, screenshots, forwarded, read };
}

test('forwards a decision from the page to the server’s judge model', async (t) => {
  const { decide, forwarded } = await start(t);
  const response = await decide();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answers: {} });
  // keep and context are ours; only the request itself goes on.
  assert.deepEqual(forwarded.map((body) => JSON.parse(body)), [{ ...REQUEST, model: JUDGE }]);
});

test('a page can’t choose a pricier model with our key', async (t) => {
  const { decide, forwarded } = await start(t);
  await decide(JSON.stringify({ request: { ...REQUEST, model: 'openai/gpt-6-astra' } }));
  assert.equal(JSON.parse(forwarded[0]).model, JUDGE);
});

test('refuses other origins and malformed requests before spending anything', async (t) => {
  const { decide, forwarded } = await start(t);
  assert.equal((await decide(DECISION, 'https://example.com')).status, 403);
  assert.equal((await decide(JSON.stringify({ request: { state: 'chat', questions: {} } }))).status, 400);
  assert.equal((await decide('x'.repeat(300 * 1024))).status, 413);
  assert.equal(forwarded.length, 0);
});

test('reads screenshots and returns only the transcript', async (t) => {
  const { screenshots, read } = await start(t);
  const response = await screenshots({ images: [SCREENSHOT], today: '2026-10-25' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: '2026-10-25, 13:08 - Ana: hi' });
  assert.deepEqual(read, [{ images: [SCREENSHOT], today: '2026-10-25' }]);
});

test('refuses screenshots that aren’t images, too many, or from elsewhere', async (t) => {
  const { screenshots, read } = await start(t);
  const today = '2026-10-25';
  assert.equal((await screenshots({ images: [SCREENSHOT], today }, 'https://example.com')).status, 403);
  assert.equal((await screenshots({ images: ['data:text/html;base64,PGI+'], today })).status, 400);
  assert.equal((await screenshots({ images: Array(11).fill(SCREENSHOT), today })).status, 400);
  assert.equal((await screenshots({ images: [], today })).status, 400);
  assert.equal(read.length, 0);
});

test('screenshots have their own hourly allowance', async (t) => {
  const { screenshots, decide, read } = await start(t, { screenshotLimiter: createLimiter({ perIpPerHour: 1, perDay: 100 }) });
  const body = { images: [SCREENSHOT], today: '2026-10-25' };
  assert.equal((await screenshots(body)).status, 200);
  assert.equal((await screenshots(body)).status, 429);
  assert.equal((await decide()).status, 200);
  assert.equal(read.length, 1);
});

test('stops a visitor after their hourly allowance', async (t) => {
  const { decide, forwarded } = await start(t, { limiter: createLimiter({ perIpPerHour: 2, perDay: 100 }) });
  await decide();
  await decide();
  const refused = await decide();
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal(forwarded.length, 2);
});

test('the daily cap holds across visitors and resets the next day', () => {
  let time = 0;
  const limiter = createLimiter({ perIpPerHour: 10, perDay: 2, now: () => time });
  assert.equal(limiter.take('a'), null);
  assert.equal(limiter.take('b'), null);
  assert.ok(limiter.take('c'));
  time += 24 * 60 * 60 * 1000;
  assert.equal(limiter.take('c'), null);
});

test('serves the page but never key.js or files outside it', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/js/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  for (const path of ['/js/key.js', '/package.json', '/server/server.js', '/js/%2e%2e/package.json']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).headers.get('content-type'), 'application/manifest+json');
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  assert.equal((await fetch(`${base}/impressum.html`)).status, 200);
});

test('a share that arrives before the service worker runs lands on the page', async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/share`, { method: 'POST', body: new FormData(), redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
});
