import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/server.js';
import { createSettings } from '../server/settings.js';

const ORIGIN = 'https://judge-you.de';
const TOKEN = 'test-admin-token-with-32-characters';
const BODIES = {
  decisions: JSON.stringify({ request: { state: { messages: [] }, questions: {} } }),
  screenshots: JSON.stringify({ images: [`data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`], today: '2026-10-25' }),
};
const REPLIES = {
  decisions: () => new Response('{"answers":{}}'),
  screenshots: () => ({ text: '2026-10-25, 13:08 - Ana: hi' }),
};

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

function heldModel(t, kind) {
  const calls = [];
  t.after(() => calls.forEach((call) => call.finish()));
  return {
    calls,
    run(_message, { signal } = {}) {
      return new Promise((resolve) => calls.push({ signal, finish: () => resolve(REPLIES[kind]()) }));
    },
  };
}

async function start(t, { values, ...options } = {}) {
  const settings = createSettings({ env: {} });
  const initial = settings.get();
  initial.decisions = { perIpPerHour: 100, perDay: 1000, maxConcurrent: 2, ...values?.decisions };
  initial.screenshots = { perIpPerHour: 100, perDay: 1000, maxConcurrent: 1, ...values?.screenshots };
  if (values?.timeoutMs !== undefined) initial.timeoutMs = values.timeoutMs;
  await settings.update(initial);
  const app = createApp({
    key: 'test-key', origins: [ORIGIN], adminToken: TOKEN, settings,
    upstream: async () => REPLIES.decisions(), transcribe: async () => REPLIES.screenshots(), ...options,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    app.closeAllConnections();
    app.close(resolve);
  }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const send = (kind, { body = BODIES[kind], signal, headers = {} } = {}) => fetch(`${base}/api/${kind}`, {
    method: 'POST', headers: { Origin: ORIGIN, ...headers }, body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  });
  const usage = async () => {
    const response = await fetch(`${base}/api/admin/settings`, {
      headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return (await response.json()).usage;
  };
  return { base, settings, send, usage };
}

// Sending just headers proves that refusal does not wait for a request body.
function unfinishedRequest(t, base, kind, headers = {}) {
  const request = httpRequest(`${base}/api/${kind}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Length': 100_000, ...headers },
  });
  const response = new Promise((resolve, reject) => {
    request.once('response', (incoming) => {
      incoming.resume();
      resolve(incoming);
    });
    request.once('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('Server waited for an unfinished body')));
  });
  // Disconnect tests deliberately destroy the request without receiving headers.
  response.catch(() => {});
  t.after(() => request.destroy());
  request.flushHeaders();
  return { request, response };
}

test('decision and screenshot capacities are independent and refusals do not spend allowance', async (t) => {
  const decisions = heldModel(t, 'decisions');
  const screenshots = heldModel(t, 'screenshots');
  const { send, usage } = await start(t, { upstream: decisions.run, transcribe: screenshots.run });
  const first = send('decisions');
  const second = send('decisions');
  await waitFor(() => decisions.calls.length === 2, 'Both decision slots should be occupied');
  const screenshot = send('screenshots');
  await waitFor(() => screenshots.calls.length === 1, 'Screenshots should have their own slot');
  for (const kind of ['decisions', 'screenshots']) {
    const refused = await send(kind);
    assert.equal(refused.status, 503);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
  }
  const busy = await usage();
  assert.deepEqual([busy.decisions.active, busy.decisions.refused, busy.decisions.usedToday], [2, 1, 2]);
  assert.deepEqual([busy.screenshots.active, busy.screenshots.refused, busy.screenshots.usedToday], [1, 1, 1]);
  decisions.calls.forEach((call) => call.finish());
  screenshots.calls[0].finish();
  for (const response of await Promise.all([first, second, screenshot])) assert.equal(response.status, 200);
  await waitFor(async () => Object.values(await usage()).every((group) => group.active === 0), 'Completed requests should release every slot');
});

test('capacity and origin gates answer before reading a model request body', async (t) => {
  const model = heldModel(t, 'decisions');
  const { base, send, usage } = await start(t, { upstream: model.run, values: { decisions: { maxConcurrent: 1 } } });
  const pending = send('decisions');
  await waitFor(() => model.calls.length === 1, 'The decision slot should be occupied');
  const overflow = unfinishedRequest(t, base, 'decisions');
  assert.equal((await overflow.response).statusCode, 503);
  const foreign = unfinishedRequest(t, base, 'decisions', { Origin: 'https://example.com' });
  assert.equal((await foreign.response).statusCode, 403);
  assert.equal(model.calls.length, 1);
  assert.equal((await usage()).decisions.refused, 1);
  model.calls[0].finish();
  assert.equal((await pending).status, 200);
});

test('lowering capacity keeps existing calls and admits new calls only below the new limit', async (t) => {
  const model = heldModel(t, 'decisions');
  const { send, settings, usage } = await start(t, { upstream: model.run });
  const first = send('decisions');
  await waitFor(() => model.calls.length === 1, 'The first call should already be running');
  const second = send('decisions');
  await waitFor(() => model.calls.length === 2, 'Two calls should already be running');
  const next = settings.get();
  next.decisions.maxConcurrent = 1;
  await settings.update(next);
  assert.equal((await send('decisions')).status, 503);
  assert.deepEqual(model.calls.map((call) => call.signal.aborted), [false, false]);
  const lowered = await usage();
  assert.deepEqual([lowered.decisions.active, lowered.decisions.maxConcurrent], [2, 1]);
  model.calls[0].finish();
  assert.equal((await first).status, 200);
  assert.equal((await send('decisions')).status, 503);
  model.calls[1].finish();
  assert.equal((await second).status, 200);
  const third = send('decisions');
  await waitFor(() => model.calls.length === 3, 'A released slot should be reusable');
  model.calls[2].finish();
  assert.equal((await third).status, 200);
});

test('live hourly and daily allowances return 429 without calling either model', async (t) => {
  const called = { decisions: 0, screenshots: 0 };
  const { send, settings, usage } = await start(t, {
    upstream: async () => { called.decisions++; return REPLIES.decisions(); },
    transcribe: async () => { called.screenshots++; return REPLIES.screenshots(); },
  });
  for (const kind of ['decisions', 'screenshots']) {
    assert.equal((await send(kind)).status, 200);
    const next = settings.get();
    next[kind].perIpPerHour = 1;
    await settings.update(next);
    const hourly = await send(kind);
    assert.equal(hourly.status, 429);
    assert.ok(Number(hourly.headers.get('retry-after')) > 0);
    next[kind].perIpPerHour = 100;
    next[kind].perDay = 1;
    await settings.update(next);
    assert.equal((await send(kind, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 429);
    next[kind].perDay = 0;
    await settings.update(next);
    assert.equal((await send(kind)).status, 429);
  }
  assert.deepEqual(called, { decisions: 1, screenshots: 1 });
  for (const group of Object.values(await usage())) {
    assert.equal(group.active, 0);
    assert.equal(group.usedToday, 1);
  }
});

for (const kind of ['decisions', 'screenshots']) {
  test(`${kind} timeouts abort the model and release its slot even if it ignores cancellation`, async (t) => {
    const model = heldModel(t, kind);
    const option = kind === 'decisions' ? 'upstream' : 'transcribe';
    const { send, usage } = await start(t, { [option]: model.run, values: { timeoutMs: 1000, [kind]: { maxConcurrent: 1 } } });
    const timedOut = await send(kind);
    assert.equal(timedOut.status, 504);
    assert.equal(model.calls.length, 1);
    assert.ok(model.calls[0].signal.aborted);
    assert.equal((await usage())[kind].active, 0);
    const next = send(kind);
    await waitFor(() => model.calls.length === 2, 'The timed-out slot should be reusable');
    model.calls[1].finish();
    assert.equal((await next).status, 200);
    // A late provider result must not disturb the response or the next call.
    model.calls[0].finish();
    await delay(10);
    assert.equal((await usage())[kind].active, 0);
  });

  test(`${kind} client disconnects abort the model and immediately free capacity`, async (t) => {
    const model = heldModel(t, kind);
    const option = kind === 'decisions' ? 'upstream' : 'transcribe';
    const { send, usage } = await start(t, { [option]: model.run, values: { [kind]: { maxConcurrent: 1 } } });
    const controller = new AbortController();
    const disconnected = send(kind, { signal: controller.signal });
    const rejected = assert.rejects(disconnected, { name: 'AbortError' });
    await waitFor(() => model.calls.length === 1, 'The model should receive the request');
    controller.abort();
    await rejected;
    await waitFor(() => model.calls[0].signal.aborted, 'Disconnect should reach the model signal');
    await waitFor(async () => (await usage())[kind].active === 0, 'Disconnect should free its slot');
    const next = send(kind);
    await waitFor(() => model.calls.length === 2, 'A new request should start after disconnect');
    model.calls[1].finish();
    assert.equal((await next).status, 200);
  });

  test(`${kind} body disconnects release capacity without calling the model or rejecting unhandled`, async (t) => {
    let calls = 0;
    const option = kind === 'decisions' ? 'upstream' : 'transcribe';
    const { base, send, usage } = await start(t, {
      [option]: async () => { calls++; return REPLIES[kind](); }, values: { [kind]: { maxConcurrent: 1 } },
    });
    const partial = unfinishedRequest(t, base, kind);
    partial.request.write('{');
    await waitFor(async () => (await usage())[kind].active === 1, 'Reading the body should reserve a slot');
    partial.request.destroy();
    await waitFor(async () => (await usage())[kind].active === 0, 'A body disconnect should release the slot');
    assert.equal(calls, 0);
    assert.equal((await send(kind)).status, 200);
    assert.equal(calls, 1);
  });
}

test('the decision deadline includes reading the upstream response body', async (t) => {
  let signal;
  let body;
  let calls = 0;
  const { send, usage } = await start(t, {
    values: { timeoutMs: 1000, decisions: { maxConcurrent: 1 } },
    upstream: async (_message, options) => {
      signal = options.signal;
      if (++calls > 1) return REPLIES.decisions();
      return new Response(new ReadableStream({ start(controller) { body = controller; } }));
    },
  });
  assert.equal((await send('decisions')).status, 504);
  assert.ok(signal.aborted);
  assert.equal((await usage()).decisions.active, 0);
  assert.equal((await send('decisions')).status, 200);
  body.close();
});

test('validation and provider failures release slots for subsequent requests', async (t) => {
  let calls = 0;
  const { send, usage } = await start(t, {
    values: { decisions: { maxConcurrent: 1 } },
    upstream: async () => {
      if (++calls === 1) throw new Error('mock provider unavailable');
      return REPLIES.decisions();
    },
  });
  assert.equal((await send('decisions', { body: '{' })).status, 400);
  assert.equal((await send('decisions')).status, 502);
  assert.equal((await send('decisions')).status, 200);
  assert.equal((await usage()).decisions.active, 0);
  assert.equal(calls, 2);
});
