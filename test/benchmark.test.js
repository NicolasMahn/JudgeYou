import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { options } from '../scripts/benchmark.js';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/benchmark.js', import.meta.url));

async function fixture(t, { headerMs = 5, bodyMs = 5, failModel = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'judgeyou-benchmark-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'build-manifest.json'), JSON.stringify({ initialAssets: ['/assets/app.js', '/assets/site.css'] }));
  const app = join(directory, 'app.mjs');
  await writeFile(app, `
    import { createServer } from 'node:http';
    import { setTimeout as sleep } from 'node:timers/promises';
    export function createApp({ key, upstream, transcribe }) {
      if (key !== 'benchmark-placeholder') throw new Error('Unexpected benchmark key');
      return createServer(async (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          if (${failModel}) { res.writeHead(500).end(); return; }
          const response = req.url === '/api/decisions'
            ? await upstream(body)
            : new Response(JSON.stringify(await transcribe(JSON.parse(body))));
          res.writeHead(response.status).end(await response.text());
          return;
        }
        await sleep(${headerMs});
        if (req.headers['if-none-match'] === '"fixture"') {
          res.writeHead(304, { ETag: '"fixture"' }).end();
          return;
        }
        res.writeHead(200, { ETag: '"fixture"' });
        res.flushHeaders();
        await sleep(${bodyMs});
        res.end('isolated benchmark fixture');
      });
    }
  `);
  return ['--app', app, '--public-dir', directory, '--warmup', '0', '--duration', '1', '--model-latency', '0'];
}

async function benchmark(t, args, fixtureOptions) {
  const base = await fixture(t, fixtureOptions);
  const { stdout, stderr } = await execute(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...base, ...args], { timeout: 10000 });
  assert.equal(stderr, '');
  const rows = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows[0].type, 'environment');
  assert.equal(rows.at(-1).type, 'complete');
  return { environment: rows[0], results: rows.filter((row) => row.type === 'result'), complete: rows.at(-1) };
}

test('benchmark parsing preserves historical defaults and accepts bounded diagnostic settings', () => {
  const defaults = options([]);
  assert.deepEqual(defaults.levels, [1, 10, 32, 100, 300]);
  assert.equal(defaults.duration, 2);
  assert.equal(defaults.warmup, 0.25);
  assert.equal(defaults.maxSockets, 1800);
  assert.equal(defaults.iterationsPerClient, 0);
  assert.equal(defaults.ramp, 0);
  assert.equal(defaults.timing, false);
  const configured = options(['--levels=1000,2000', '--max-sockets', '12000', '--iterations-per-client', '10000', '--ramp', '60', '--timing=true']);
  assert.deepEqual(configured.levels, [1000, 2000]);
  assert.equal(configured.maxSockets, 12000);
  assert.equal(configured.iterationsPerClient, 10000);
  assert.equal(configured.ramp, 60);
  assert.equal(configured.timing, true);
  assert.equal(options(['--max-sockets', '1', '--iterations-per-client', '1', '--ramp', '0.05', '--timing', 'false']).maxSockets, 1);
});

test('benchmark CLI rejects invalid bounds, types, and unsafe static targets', async () => {
  for (const [name, invalid] of [
    ['max-sockets', ['0', '12001', '1.5', 'NaN', '']],
    ['iterations-per-client', ['-1', '10001', '0.5', 'Infinity', '']],
    ['ramp', ['-0.1', '60.1', 'NaN', '']],
    ['timing', ['1', 'TRUE', 'yes', '']],
    ['levels', ['0', '2001', '1.5', '1,']],
  ]) {
    for (const value of invalid) assert.throws(() => options([`--${name}=${value}`]), undefined, `${name}=${value}`);
  }
  assert.throws(() => options(['--max-sockets']), /Missing value/);
  assert.throws(() => options(['--unknown', '1']), /Unknown option/);
  for (const target of ['http://example.com', 'https://localhost', 'http://localhost/path', 'http://user@localhost']) {
    assert.throws(() => options(['--scenarios', 'page', '--target-url', target]), /loopback HTTP origin/);
  }
  assert.throws(() => options(['--scenarios', 'model', '--target-url', 'http://127.0.0.1:8500']), /page\/ready\/assets/);
  assert.equal(options(['--scenarios', 'page', '--target-url', 'http://127.0.0.1:8500']).targetUrl, 'http://127.0.0.1:8500/');
  await assert.rejects(execute(process.execPath, [script, '--max-sockets', '0']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /--max-sockets must be an integer/);
    assert.equal(error.stdout, '');
    return true;
  });
});

test('benchmark help documents diagnostic definitions without starting a server', async () => {
  const { stdout } = await execute(process.execPath, [script, '--help']);
  assert.match(stdout, /--iterations-per-client/);
  assert.match(stdout, /--max-sockets/);
  assert.match(stdout, /agentQueue = request creation to socket assignment/);
  assert.match(stdout, /not 1000 simultaneous active people/);
  assert.doesNotMatch(stdout, /"type":"environment"/);
});

test('one-shot pages finish once per client and Agent limits produce observable queueing', async (t) => {
  const { environment, results: [result], complete } = await benchmark(t, [
    '--scenarios', 'page', '--levels', '4', '--iterations-per-client', '1', '--max-sockets', '1', '--timing', 'true',
  ], { headerMs: 15, bodyMs: 10 });
  assert.equal(environment.config.maxSockets, 1);
  assert.match(environment.timingDefinitions.agentQueue, /socket assignment/);
  assert.equal(complete.upstreamCalls, 1, 'fake API preflight still runs for static-only cases');
  assert.equal(result.stopped, 'client-iterations');
  assert.equal(result.closedLoop, false);
  assert.equal(result.workflows.admitted, 4);
  assert.equal(result.workflows.completed, 4);
  assert.equal(result.workflows.count, 4);
  assert.equal(result.workflows.peakActive, 4);
  assert.equal(result.http.count, 12, 'each page loads HTML and two declared assets');
  assert.equal(result.http.errorRate, 0);
  assert.equal(result.timing.agentQueue.count, 12);
  assert.ok(result.timing.agentQueue.p95Ms >= 15, 'one socket must queue concurrent workflows');
  assert.deepEqual(result.timing.connections, { new: 0, reused: 12 }, 'queued assignments reuse the primed physical socket');
  assert.equal(result.timing.newSocketTtfb.count, 0);
  assert.equal(result.timing.newSocketTtfb.p50Ms, null);
  assert.equal(result.timing.tcpConnect.count, 0);
  assert.equal(result.timing.reusedSocketTtfb.count, 12);
  assert.equal(result.timing.bodyRead.count, 12);
  assert.ok(result.timing.bodyRead.p50Ms >= 5, 'streamed bodies have a distinct read interval');
});

test('timing distinguishes new TCP connections from reused socket requests', async (t) => {
  const { results: [result] } = await benchmark(t, [
    '--scenarios', 'page', '--levels', '3', '--iterations-per-client', '1', '--max-sockets', '3', '--timing', 'true',
  ]);
  assert.equal(result.http.count, 9);
  assert.deepEqual(result.timing.connections, { new: 2, reused: 7 });
  assert.equal(result.timing.tcpConnect.count, 2);
  assert.equal(result.timing.newSocketTtfb.count, 2);
  assert.equal(result.timing.reusedSocketTtfb.count, 7);
  for (const name of ['agentQueue', 'tcpConnect', 'newSocketTtfb', 'reusedSocketTtfb', 'bodyRead']) {
    const stats = result.timing[name];
    assert.ok(stats.count > 0);
    assert.ok(stats.p50Ms >= 0);
    assert.ok(stats.p95Ms >= stats.p50Ms);
    assert.ok(stats.maxMs + 0.1 >= stats.p95Ms, 'bucket ceiling may exceed exact maximum by 0.1ms');
  }
});

test('finite model iterations reset for measurement after warmup and omit opt-in timing', async (t) => {
  const { environment, results: [result], complete } = await benchmark(t, [
    '--scenarios', 'model', '--levels', '3', '--warmup', '0.2', '--iterations-per-client', '2', '--model-latency', '5',
  ]);
  assert.equal(complete.upstreamCalls, 13, 'one preflight plus six warmup and six measured fake calls');
  assert.equal(result.workflows.admitted, 6);
  assert.equal(result.workflows.completed, 6);
  assert.equal(result.http.count, 6);
  assert.equal(result.closedLoop, true);
  assert.equal('timing' in result, false);
  assert.equal('timingDefinitions' in environment, false);
});

test('ramp spreads first arrivals and never admits clients scheduled beyond the global deadline', async (t) => {
  const { results: [result] } = await benchmark(t, [
    '--scenarios', 'assets', '--levels', '4', '--iterations-per-client', '1', '--ramp', '0.6', '--duration', '0.22',
  ]);
  assert.equal(result.workflows.admitted, 2, 'starts at 0 and 150ms; 300 and 450ms exceed 220ms deadline');
  assert.equal(result.workflows.completed, 2);
  assert.equal(result.http.count, 2);
  assert.equal(result.workflows.peakActive, 1);
  assert.equal(result.stopped, 'duration');
  assert.ok(result.elapsedMs >= 210, 'pending starts wait for the global deadline');
});

test('ramp keeps the iteration budget global and cancels pending starts once it is exhausted', async (t) => {
  const { results: [result] } = await benchmark(t, [
    '--scenarios', 'assets', '--levels', '4', '--iterations-per-client', '1', '--ramp', '2', '--duration', '2', '--max-iterations', '1',
  ]);
  assert.equal(result.iterationBudget, 1);
  assert.equal(result.workflows.admitted, 1);
  assert.equal(result.workflows.completed, 1);
  assert.equal(result.stopped, 'iteration-budget');
  assert.ok(result.elapsedMs < 1000, 'later arrivals must not keep a completed budget waiting through the ramp');
});

test('static-only workloads still fail closed when the local fake API preflight fails', async (t) => {
  const args = await fixture(t, { failModel: true });
  await assert.rejects(execute(process.execPath, [script, ...args, '--scenarios', 'page', '--levels', '1']), (error) => {
    assert.match(error.stderr, /Model\/journal preflight failed \(500\)/);
    assert.equal(error.stdout, '');
    return true;
  });
});
