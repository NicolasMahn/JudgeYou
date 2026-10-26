import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createTelemetry } from '../server/telemetry.js';
import { createApp } from '../server/server.js';
import { createSettings } from '../server/settings.js';
import { TranscribeError } from '../server/transcribe.js';

const ORIGIN = 'https://judge-you.de';
const TOKEN = 'private-admin-token-with-32-characters';
const ROUTES = ['page', 'assets', 'decisions', 'screenshots', 'forget', 'results', 'admin', 'other'];
const BODIES = {
  decisions: JSON.stringify({ request: { state: { messages: ['private-chat'] }, questions: {} } }),
  screenshots: JSON.stringify({ images: ['data:image/jpeg;base64,anBlZw=='], today: '2026-10-26' }),
};

function fixture() {
  const clock = { wall: Date.parse('2026-10-26T12:00:00Z'), elapsed: 0 };
  const telemetry = createTelemetry({
    now: () => clock.wall,
    monotonicNow: () => clock.elapsed,
    uptime: () => 123,
    memoryUsage: () => ({ rss: 1000, heapUsed: 200, external: 'private-memory-detail' }),
  });
  return { clock, telemetry };
}

function observed(telemetry, url = '/api/decisions', statusCode = 200) {
  const req = new EventEmitter();
  req.url = url;
  // Telemetry must not even inspect or consume any of these.
  for (const name of ['headers', 'body', 'socket']) Object.defineProperty(req, name, { get() { throw new Error(`Read ${name}`); } });
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.writableFinished = false;
  telemetry.observe(req, res);
  assert.equal(req.listenerCount('data'), 0);
  return { req, res, finish() { res.writableFinished = true; res.emit('finish'); res.emit('close'); } };
}

test('version 1 exposes stable process identity and only aggregate process data', () => {
  const { telemetry } = fixture();
  const first = telemetry.snapshot();
  const second = telemetry.snapshot();
  assert.deepEqual(first, second);
  assert.equal(first.version, 1);
  assert.match(first.bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.bootId, fixture().telemetry.snapshot().bootId);
  assert.deepEqual(first.process, {
    startedAt: '2026-10-26T11:57:57.000Z', uptimeSec: 123, memory: { rssBytes: 1000, heapUsedBytes: 200 },
  });
  assert.deepEqual(Object.keys(first.window.routes), ROUTES);
  assert.deepEqual(first.window.totals.successfulApiLatency, { sampleCount: 0, p95Ms: null });
});

test('classification has fixed route and status categories, excluding all admin traffic', () => {
  const { telemetry } = fixture();
  const requests = [
    ['/', 200, 'page'], ['/v/private-verdict?names=private-name', 304, 'page'],
    ['/assets/private-file.js?private-query', 404, 'assets'], ['/css/style.css', 200, 'assets'],
    ['/api/decisions?chat=private-chat', 503, 'decisions'], ['/api/screenshots', 504, 'screenshots'],
    ['/api/forget', 429, 'forget'], ['/api/results/private-result-id', 200, 'results'],
    ['/private-path?secret=private-query', 400, 'other'], ['http://[invalid', 500, 'other'],
  ];
  for (const [path, status] of requests) observed(telemetry, path, status).finish();
  for (const path of ['/admin', '/admin/', '/api/admin/settings', '/api/admin/health?private-probe', '/api/admin/unknown']) {
    observed(telemetry, path, 401).finish();
  }
  const { totals, routes } = telemetry.snapshot().window;
  assert.equal(totals.totalRequests, requests.length);
  assert.equal(totals.completedResponses, requests.length);
  assert.equal(totals.abortedRequests, 0);
  assert.equal(totals.errors5xx, 3);
  assert.deepEqual(totals.statusClasses, { '1xx': 0, '2xx': 3, '3xx': 1, '4xx': 3, '5xx': 3 });
  for (const name of ROUTES) assert.equal(routes[name].totalRequests, requests.filter((request) => request[2] === name).length);
  assert.equal(totals.busy503, 0, 'An arbitrary 503 must not imply local overload');
  assert.equal(totals.timeouts504, 0, 'An arbitrary 504 must not imply a local deadline');
  assert.equal(totals.quota429, 0, 'An arbitrary 429 must not imply local quota refusal');
  assert.equal(totals.successfulApiLatency.sampleCount, 1);
  assert.doesNotMatch(JSON.stringify(telemetry.snapshot()), /private-|secret|chat=|names=/);
});

test('completion and premature disconnect are mutually exclusive and do not retain listeners', () => {
  const { telemetry } = fixture();
  const complete = observed(telemetry);
  assert.equal(telemetry.snapshot().window.totals.totalRequests, 0, 'In-flight calls are not terminal outcomes');
  complete.finish();
  const bodyAbort = observed(telemetry, '/api/screenshots');
  bodyAbort.req.emit('aborted');
  bodyAbort.res.emit('close');
  bodyAbort.res.emit('finish');
  const responseAbort = observed(telemetry, '/api/decisions', 502);
  telemetry.mark(responseAbort.res, 'upstreamFailures');
  responseAbort.res.emit('close');
  responseAbort.req.emit('aborted');
  responseAbort.res.emit('finish');
  for (const { req, res } of [complete, bodyAbort, responseAbort]) {
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('finish'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
  const totals = telemetry.snapshot().window.totals;
  assert.equal(totals.totalRequests, 3);
  assert.equal(totals.completedResponses, 1);
  assert.equal(totals.abortedRequests, 2);
  assert.equal(totals.statusClasses['2xx'], 1);
  assert.equal(totals.statusClasses['5xx'], 0);
  assert.equal(totals.errors5xx, 0);
  assert.equal(totals.upstreamFailures, 0);
  assert.equal(totals.successfulApiLatency.sampleCount, 1);
});

test('latency measures arrival to finish with a bounded histogram and ignores unsuccessful calls', () => {
  const { clock, telemetry } = fixture();
  for (let i = 0; i < 20; i++) {
    const call = observed(telemetry);
    clock.elapsed += i === 19 ? 900 : 80;
    call.finish();
  }
  for (const [path, status] of [['/api/decisions', 429], ['/api/screenshots', 502], ['/', 200]]) {
    const call = observed(telemetry, path, status);
    clock.elapsed += 10000;
    call.finish();
  }
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot.window.totals.successfulApiLatency, { sampleCount: 20, p95Ms: 100 });
  assert.deepEqual(snapshot.window.routes.decisions.successfulApiLatency, { sampleCount: 20, p95Ms: 100 });
  snapshot.window.routes.decisions.totalRequests = 999;
  snapshot.window.totals.statusClasses['2xx'] = 999;
  assert.equal(telemetry.snapshot().window.routes.decisions.totalRequests, 21, 'Snapshots cannot mutate stored counters');
  assert.equal(telemetry.snapshot().window.totals.statusClasses['2xx'], 21);
});

test('five-minute buckets expire without traffic, wrap after long gaps, and never grow route keys', () => {
  const { clock, telemetry } = fixture();
  const initial = clock.wall;
  const old = observed(telemetry);
  clock.elapsed = 400;
  telemetry.mark(old.res, 'private-error-text');
  old.finish();
  clock.wall = initial + 299_999;
  assert.equal(telemetry.snapshot().window.totals.totalRequests, 1);
  clock.wall = initial + 300_000;
  assert.equal(telemetry.snapshot().window.totals.totalRequests, 0);
  assert.deepEqual(telemetry.snapshot().window.totals.successfulApiLatency, { sampleCount: 0, p95Ms: null });
  for (let second = 0; second < 610; second++) {
    clock.wall = initial + (1000 + second) * 1000;
    for (let i = 0; i < 10; i++) observed(telemetry, `/private-unique-${second}-${i}?chat=private-chat`, 404).finish();
  }
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.window.totals.totalRequests, 3000);
  assert.deepEqual(Object.keys(snapshot.window.routes), ROUTES);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-/);
  assert.ok(JSON.stringify(snapshot).length < 5000);
  clock.wall += 86_400_000;
  assert.equal(telemetry.snapshot().window.totals.totalRequests, 0);
  observed(telemetry, '/assets/another-private-unique-file', 404).finish();
  assert.equal(telemetry.snapshot().window.totals.totalRequests, 1);
});

async function start(t, options = {}) {
  const { clock, telemetry } = fixture();
  const settings = createSettings({ env: {} });
  const app = createApp({
    key: 'private-key', origins: [ORIGIN], adminToken: TOKEN, settings, telemetry,
    upstream: async () => new Response('{"answers":{}}'), transcribe: async () => ({ text: 'private-chat' }),
    ...options,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const get = (path, options = {}) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000), ...options });
  const health = async (options = {}) => {
    const response = await get('/api/admin/health', { headers: { Authorization: `Bearer ${TOKEN}` }, ...options });
    assert.equal(response.status, 200);
    return response.json();
  };
  const send = (kind, options = {}) => get(`/api/${kind}`, {
    method: 'POST', headers: { Origin: ORIGIN }, body: BODIES[kind], ...options,
  });
  return { app, base, get, health, send, settings, clock, telemetry };
}

function privateResponse(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
}

test('health has the settings endpoint authentication policy, private headers, and GET only', async (t) => {
  const { get, health } = await start(t);
  for (const authorization of [undefined, 'Bearer wrong-token', TOKEN, `bearer ${TOKEN}`]) {
    privateResponse(await get('/api/admin/health', { headers: authorization ? { Authorization: authorization } : {} }), 401);
  }
  const headers = { Authorization: `Bearer ${TOKEN}` };
  privateResponse(await get('/api/admin/health', { headers }), 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await get('/api/admin/health', { method, headers });
    privateResponse(response, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  }
  const settingsResponse = await get('/api/admin/settings', { headers });
  const settings = await settingsResponse.json();
  assert.deepEqual(Object.keys(settings), ['settings', 'usage']);
  const first = await health();
  assert.deepEqual(first.usage, settings.usage);
  assert.equal(first.usage.decisions.maxConcurrent, 32);
  assert.equal(first.usage.screenshots.maxConcurrent, 4);
  assert.equal((await health()).bootId, first.bootId);
  assert.equal((await health()).window.totals.totalRequests, 0, 'Health probes and auth failures never count as user traffic');

  const disabled = await start(t, { adminToken: null });
  for (const method of ['GET', 'PUT', 'HEAD']) privateResponse(await disabled.get('/api/admin/health', { method, headers }), 404);
});

test('health reports local quota separately from errors and contains no private request or provider data', async (t) => {
  let calls = 0;
  const { send, get, health, settings, clock } = await start(t, {
    upstream: async () => {
      calls++;
      if (calls === 1) throw new Error('private-provider-error');
      if (calls === 2) return new Response('private-provider-body', { status: 503 });
      if (calls === 3) return new Response('private-provider-quota', { status: 429 });
      clock.elapsed += 75;
      return new Response('{"answers":{}}');
    },
    transcribe: async () => { throw new TranscribeError(502, 'private-transcript-error'); },
  });
  assert.equal((await send('decisions')).status, 502);
  assert.equal((await send('decisions')).status, 503);
  assert.equal((await send('decisions')).status, 429);
  assert.equal((await send('decisions')).status, 200);
  assert.equal((await send('screenshots')).status, 502);
  const next = settings.get();
  next.decisions.perDay = 4;
  await settings.update(next);
  assert.equal((await send('decisions', { headers: { Origin: ORIGIN, 'X-Forwarded-For': '203.0.113.99' } })).status, 429);
  assert.equal((await get('/api/results/private-result?private-query')).status, 404);
  const snapshot = await health();
  const { totals, routes } = snapshot.window;
  assert.equal(totals.totalRequests, 7);
  assert.equal(totals.errors5xx, 3);
  assert.equal(totals.upstreamFailures, 4);
  assert.equal(totals.upstream5xx, 2);
  assert.equal(totals.busy503, 0);
  assert.equal(totals.timeouts504, 0);
  assert.equal(totals.quota429, 1);
  assert.deepEqual(routes.decisions.successfulApiLatency, { sampleCount: 1, p95Ms: 100 });
  assert.equal(routes.screenshots.errors5xx, 1);
  assert.equal(snapshot.usage.decisions.usedToday, 4);
  assert.equal(snapshot.usage.decisions.active, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|203\.0\.113|Authorization|Bearer|messages/);
});

test('busy refusals report live capacity without spending quota or counting provider errors', async (t) => {
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  const { send, health, settings } = await start(t, {
    upstream: () => { entered.resolve(); return answer.promise; },
  });
  const next = settings.get();
  next.decisions.maxConcurrent = 1;
  await settings.update(next);
  const pending = send('decisions');
  await entered.promise;
  assert.equal((await send('decisions')).status, 503);
  const busy = await health();
  assert.equal(busy.usage.decisions.active, 1);
  assert.equal(busy.usage.decisions.refused, 1);
  assert.equal(busy.usage.decisions.usedToday, 1);
  assert.equal(busy.window.totals.busy503, 1);
  assert.equal(busy.window.totals.errors5xx, 1);
  assert.equal(busy.window.totals.upstreamFailures, 0);
  answer.resolve(new Response('{"answers":{}}'));
  assert.equal((await pending).status, 200);
  assert.equal((await health()).usage.decisions.active, 0);
});

for (const kind of ['decisions', 'screenshots']) {
  test(`${kind} disconnect after model admission counts an abort rather than a response`, async (t) => {
    const entered = Promise.withResolvers();
    let modelSignal;
    const { app, base, health } = await start(t, {
      [kind === 'decisions' ? 'upstream' : 'transcribe']: (_body, { signal }) => {
        modelSignal = signal;
        entered.resolve();
        return new Promise(() => {});
      },
    });
    const arrived = once(app, 'request');
    const request = httpRequest(`${base}/api/${kind}`, { method: 'POST', headers: { Origin: ORIGIN } });
    request.on('error', () => {});
    t.after(() => request.destroy());
    request.end(BODIES[kind]);
    const [, response] = await arrived;
    await entered.promise;
    const closed = once(response, 'close');
    request.destroy();
    await closed;
    const snapshot = await health();
    assert.ok(modelSignal.aborted);
    assert.equal(snapshot.usage[kind].active, 0);
    assert.equal(snapshot.usage[kind].usedToday, 1);
    assert.equal(snapshot.window.routes[kind].abortedRequests, 1);
    assert.equal(snapshot.window.totals.totalRequests, 1);
    assert.equal(snapshot.window.totals.completedResponses, 0);
    assert.equal(snapshot.window.totals.errors5xx, 0);
    assert.equal(snapshot.window.totals.successfulApiLatency.sampleCount, 0);
  });

  test(`${kind} deadlines count local 504 once with a fake timer`, async (t) => {
    const entered = Promise.withResolvers();
    let modelSignal;
    const { send, health, settings } = await start(t, {
      [kind === 'decisions' ? 'upstream' : 'transcribe']: (_body, { signal }) => {
        modelSignal = signal;
        entered.resolve();
        return new Promise(() => {});
      },
    });
    await settings.update({ ...settings.get(), timeoutMs: 1000 });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = send(kind);
    await entered.promise;
    t.mock.timers.tick(1000);
    assert.equal((await pending).status, 504);
    t.mock.timers.reset();
    const snapshot = await health();
    assert.ok(modelSignal.aborted);
    assert.equal(snapshot.usage[kind].active, 0);
    assert.equal(snapshot.window.routes[kind].timeouts504, 1);
    assert.equal(snapshot.window.totals.completedResponses, 1);
    assert.equal(snapshot.window.totals.errors5xx, 1);
    assert.equal(snapshot.window.totals.upstreamFailures, 0);
    assert.equal(snapshot.window.totals.abortedRequests, 0);
  });

  test(`${kind} unfinished body disconnect counts an abort and releases capacity`, async (t) => {
    let calls = 0;
    const { app, base, health } = await start(t, {
      [kind === 'decisions' ? 'upstream' : 'transcribe']: async () => { calls++; throw new Error('Model must not run'); },
    });
    const arrived = once(app, 'request');
    const request = httpRequest(`${base}/api/${kind}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Length': 100000 },
    });
    request.on('error', () => {});
    t.after(() => request.destroy());
    request.write('{');
    const [, response] = await arrived;
    assert.equal((await health()).usage[kind].active, 1);
    const closed = once(response, 'close');
    request.destroy();
    await closed;
    const snapshot = await health();
    assert.equal(calls, 0);
    assert.equal(snapshot.usage[kind].active, 0);
    assert.equal(snapshot.window.totals.totalRequests, 1);
    assert.equal(snapshot.window.totals.abortedRequests, 1);
    assert.equal(snapshot.window.totals.completedResponses, 0);
    assert.equal(snapshot.window.totals.statusClasses['2xx'], 0);
    assert.equal(snapshot.window.totals.errors5xx, 0);
  });
}
