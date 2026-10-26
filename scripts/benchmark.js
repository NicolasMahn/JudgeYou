#!/usr/bin/env node
// Run with Node 22+. All traffic stays on loopback; API calls always use the local fake app.
import { Agent, request } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, availableParallelism, platform, release } from 'node:os';
import { dirname, resolve, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setMaxListeners } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createJournal } from '../server/journal.js';
import { openStore } from '../server/store.js';
import { unseal } from '../server/seal.js';
import { buildRequest } from '../js/questions.js';

const HELP = `Usage: node scripts/benchmark.js [options]
  --app PATH                 createApp module (also APP_MODULE; default server/server.js)
  --public-dir PATH          built public directory (also PUBLIC_DIR; default source root)
  --target-url URL           separate loopback static server; page/assets scenarios only
  --duration SECONDS         admission window per scenario/level (default 2; 0.05–60)
  --warmup SECONDS           unmeasured warmup per scenario/level (default 0.25; 0–10)
  --levels 1,10,32,100,300    client levels (each 1–2000; defaults unchanged)
  --scenarios page,ready,assets,model,screenshots
  --model-latency MS         deterministic fake model/transcriber delay (default 100; 0–10000)
  --decisions-cap N          injected maxConcurrent (default 32; 1–512)
  --screenshots-cap N        injected maxConcurrent (default 4; 1–64)
  --journal off|metadata|sealed   isolated temporary SQLite (default off)
  --subjects N               synthetic judged participants (default 2; 2–8)
  --body-bytes N             target decision JSON bytes (default ~64KiB for 2, ~80KiB for 8)
  --timeout MS               absolute workflow timeout (default 15000; 1000–30000)
  --max-iterations N         workflow budget per measured case (default 10000; 1–100000)
  --max-sockets N            HTTP Agent maxSockets per origin (default 1800; 1–12000)
  --iterations-per-client N  workflows/client/phase (default 0 = unlimited; 0–10000)
  --ramp SECONDS             spread first starts over [0, SECONDS) (default 0; 0–60)
  --timing true|false        bounded HTTP timing distributions (default false)
  --journal-rows N           total model workflow budget including warmup (default 5000; 10–20000)
  --help

APP_MODULE/--app loads another checkout's unchanged server, using this same harness.
Example: APP_MODULE=/tmp/baseline/server/server.js node scripts/benchmark.js --journal sealed
Output is JSON Lines. No production listener, settings, database, or key is used.
Page = HTML then its static module/CSS/declared-font graph and 12 runtime mascots,
six parallel assets/client. Dynamically selected locales, service-worker registration,
other JavaScript-created images and lazy imports are excluded.
Ready = HTML, startup scripts and styles only; no fonts/images. This measures
critical-resource delivery, not browser rendering or JavaScript execution.
Assets = conditional GETs after priming; page = fresh-browser GETs on a warm server.
This is HTTP load in one process, not a browser engine or a count of human users.
Clients repeat sequential workflows unless --iterations-per-client limits them.
Ramp starts client i at phase start + i/clients * ramp; it applies independently to
warmup and measurement. Admission stops at the shared deadline or workflow budget;
already admitted workflows drain with their original absolute timeout. A workflow
can issue further page assets during drain. No new workflow starts after deadline.
One arrival per client: --levels 1000 --duration 60 --warmup 0 --ramp 60
  --iterations-per-client 1 --scenarios page --timing true
This schedules 1000 arrivals across 60s, not 1000 simultaneous active people.
Workflow counts include failures; peakActive counts admitted workflows still running.
HTTP/workflow rates retain elapsed time including ramp and drain. Client-limited
phases finish early when all clients finish; admissionWindowMs is the allowed window.
--max-sockets is per origin, shared across clients (six page assets/client at once);
the Agent can queue excess HTTP requests. Defaults retain historical workload/metrics.
--timing adds 0.1ms histograms plus overflow at timeout + 0.1ms, with exact maxima:
agentQueue = request creation to socket assignment; tcpConnect = assignment to TCP
connect for connecting sockets (includes DNS if localhost); newSocketTtfb and
reusedSocketTtfb = request creation to response headers, including Agent queue/connect;
bodyRead = response headers to end of body. TTFB is headers arrival, not first data byte.
Only observed events contribute; failed requests can have queue/connect but no
headers/body samples. Connections count socket assignments by new/reused physical
socket, including reuse from preflight/warmup; they are not concurrent socket counts.
Timing is absent and its histograms/listeners are disabled unless explicitly enabled.
Screenshots use one tiny synthetic JPEG data URL; this does not measure max-size image capacity.
Older createApp implementations may ignore injected capacity settings; inspect 503 rates.
Decision fixtures use real typed questions and answers. State must fit 64KiB,
questions <=64, and HTTP JSON <=256KiB; incompatible --body-bytes fails before load.
`;

export function options(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!match) throw new Error(`Invalid argument: ${args[i]}`);
    if (match[1] === 'help') return null;
    const value = match[2] ?? args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${match[1]}`);
    values[match[1]] = value;
  }
  const known = ['app', 'public-dir', 'target-url', 'duration', 'warmup', 'levels', 'scenarios', 'model-latency', 'decisions-cap', 'screenshots-cap', 'journal', 'subjects', 'body-bytes', 'timeout', 'max-iterations', 'journal-rows', 'max-sockets', 'iterations-per-client', 'ramp', 'timing'];
  for (const name of Object.keys(values)) if (!known.includes(name)) throw new Error(`Unknown option: --${name}`);
  const number = (name, fallback, min, max, integer = false) => {
    const value = Number(values[name] ?? fallback);
    if (values[name]?.trim() === '' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
    }
    return value;
  };
  const levels = (values.levels ?? '1,10,32,100,300').split(',').map(Number);
  if (!levels.length || levels.length > 10 || levels.some((level) => !Number.isInteger(level) || level < 1 || level > 2000)) throw new Error('Use 1–10 client levels, each from 1 to 2000');
  const scenarios = (values.scenarios ?? 'page,assets,model,screenshots').split(',');
  if (!scenarios.length || scenarios.length > 5 || scenarios.some((name) => !['page', 'ready', 'assets', 'model', 'screenshots'].includes(name))) throw new Error('Unknown or excessive scenarios');
  const journal = values.journal ?? 'off';
  if (!['off', 'metadata', 'sealed'].includes(journal)) throw new Error('--journal must be off, metadata, or sealed');
  const timing = values.timing ?? 'false';
  if (!['true', 'false'].includes(timing)) throw new Error('--timing must be true or false');
  const app = values.app ?? process.env.APP_MODULE ?? fileURLToPath(new URL('../server/server.js', import.meta.url));
  const appURL = app.startsWith('file:') ? new URL(app) : pathToFileURL(resolve(app));
  if (appURL.protocol !== 'file:') throw new Error('--app must be a local file');
  const subjects = number('subjects', 2, 2, 8, true);
  const target = values['target-url'] ? new URL(values['target-url']) : null;
  if (target && (target.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash
    || scenarios.some((scenario) => !['page', 'ready', 'assets'].includes(scenario)))) {
    throw new Error('--target-url must be a loopback HTTP origin, with page/ready/assets scenarios only');
  }
  return {
    app: fileURLToPath(appURL), publicDir: values['public-dir'] ?? process.env.PUBLIC_DIR ?? null, targetUrl: target?.href ?? null, levels: [...new Set(levels)], scenarios: [...new Set(scenarios)], journal,
    duration: number('duration', 2, 0.05, 60), warmup: number('warmup', 0.25, 0, 10),
    modelLatencyMs: number('model-latency', 100, 0, 10000, true),
    decisionsCap: number('decisions-cap', 32, 1, 512, true), screenshotsCap: number('screenshots-cap', 4, 1, 64, true),
    subjects, bodyBytes: number('body-bytes', 65536 + (subjects - 2) * 2700, 1024, 204800, true), timeoutMs: number('timeout', 15000, 1000, 30000, true),
    maxIterations: number('max-iterations', 10000, 1, 100000, true), journalRows: number('journal-rows', 5000, 10, 20000, true),
    maxSockets: number('max-sockets', 1800, 1, 12000, true), iterationsPerClient: number('iterations-per-client', 0, 0, 10000, true),
    ramp: number('ramp', 0, 0, 60), timing: timing === 'true',
  };
}

const round = (value) => Math.round(value * 100) / 100;
const output = (value) => console.log(JSON.stringify(value));

// Fixed-size histograms bound memory regardless of throughput; resolution is 0.1 ms.
function distribution(timeoutMs) {
  const buckets = new Uint32Array(timeoutMs * 10 + 2);
  let count = 0;
  let max = 0;
  return {
    add(ms) {
      count++;
      max = Math.max(max, ms);
      buckets[Math.min(buckets.length - 1, Math.ceil(ms * 10))]++;
    },
    summary() {
      const percentile = (fraction) => {
        let seen = 0;
        for (let i = 0; i < buckets.length; i++) {
          seen += buckets[i];
          if (seen >= Math.ceil(count * fraction)) return round(i / 10);
        }
        return null;
      };
      return { count, p50Ms: count ? percentile(0.5) : null, p95Ms: count ? percentile(0.95) : null, maxMs: round(max) };
    },
  };
}

async function assetGraph(root) {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'build-manifest.json'), 'utf8'));
    if (!Array.isArray(manifest.initialAssets) || !manifest.initialAssets.every((path) => typeof path === 'string' && path.startsWith('/assets/') || ['/favicon.ico', '/img/favicon-96.png', '/img/apple-touch-icon.png', '/manifest.webmanifest'].includes(path))) {
      throw new Error('Invalid built asset manifest');
    }
    return ['/', ...manifest.initialAssets];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const paths = new Set(['/']);
  const queue = ['/'];
  const local = (reference, parent) => {
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return;
    const path = posix.resolve(posix.dirname(parent), reference.split(/[?#]/)[0]);
    if (paths.has(path)) return;
    if (paths.size >= 128) throw new Error('Page graph exceeds 128 assets');
    paths.add(path);
    queue.push(path);
  };
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    if (path !== '/' && !/\.(?:html|js|css)$/.test(path)) continue;
    const text = await readFile(join(root, path === '/' ? 'index.html' : path.slice(1)), 'utf8');
    if (path === '/' || path.endsWith('.html')) {
      for (const match of text.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
        const ref = /\b(?:src|href)=["']([^"']+)["']/i.exec(match[0])?.[1];
        if (/<script\b/i.test(match[0]) || /\brel=["'](?:stylesheet|icon|apple-touch-icon|manifest)["']/i.test(match[0])) local(ref, path);
      }
    } else if (path.endsWith('.css')) {
      for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/g)) local(match[1] ?? match[2] ?? match[3], path);
    } else {
      for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g)) local(match[1], path);
    }
  }
  // The landing page creates these images in JavaScript instead of HTML/CSS.
  const mascots = await readdir(join(root, 'img/types')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const file of mascots.filter((name) => name.endsWith('.webp'))) local(`/img/types/${file}`, '/');
  return [...paths].sort();
}

function decisionFixture(config) {
  const subjects = ['Ada', 'Ben', 'Cara', 'Dan', 'Eva', 'Finn', 'Gia', 'Hugo'].slice(0, config.subjects);
  const messages = Array.from({ length: 24 }, (_, i) => ({ author: subjects[i % subjects.length], text: `Synthetic benchmark message ${i}.` }));
  const { body: request } = buildRequest(messages, subjects);
  const body = { request, keep: config.journal === 'sealed', context: { source: 'paste', lang: 'en', totalMessages: messages.length } };
  const padding = config.bodyBytes - Buffer.byteLength(JSON.stringify(body));
  if (padding < 0) throw new Error(`--body-bytes is smaller than the ${Buffer.byteLength(JSON.stringify(body))}-byte question/message fixture`);
  request.state.messages[0].text += ' Synthetic benchmark conversation.'.repeat(Math.ceil(padding / 34)).slice(0, padding);
  const stateBytes = Buffer.byteLength(JSON.stringify(request.state));
  if (stateBytes > 65536) throw new Error(`Fixture state is ${stateBytes} bytes; limit is 65536. Reduce --body-bytes; HTTP body limit is 262144 bytes, with at most 64 questions.`);
  const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
    if (question.type === 'noul') return [key, { type: 'noul', noul: 0.5 }];
    const criteria = Object.entries(question.criteria);
    const choice = key === 'culprit' ? subjects[1] : criteria[0][0];
    const probabilities = Object.fromEntries(criteria.map(([name]) => [name, name === choice ? 0.76 : Number((0.24 / (criteria.length - 1)).toFixed(4))]));
    return [key, question.type === 'score'
      ? { type: 'score', score: criteria.reduce((sum, [name]) => sum + Number(name) * probabilities[name], 0), legend: Object.fromEntries(criteria), probabilities, confidence: 0.76 }
      : { type: 'choice', choice, probabilities, confidence: 0.76 }];
  }));
  const response = JSON.stringify({ model: 'benchmark/fake', answers, usage: { cost: 0 } });
  return { body: JSON.stringify(body), response, stateBytes, questionCount: Object.keys(request.questions).length };
}

async function run(config) {
  const fixture = decisionFixture(config);
  const appRoot = config.publicDir ? resolve(config.publicDir) : resolve(dirname(config.app), '..');
  const assets = (await assetGraph(appRoot)).filter((path) => path !== '/');
  if (!assets.length) throw new Error('No browser assets found');
  const previousFetch = globalThis.fetch;
  const previousPublicDir = process.env.PUBLIC_DIR;
  if (config.publicDir) process.env.PUBLIC_DIR = appRoot;
  globalThis.fetch = () => { throw new Error('External fetch is disabled in the local capacity benchmark'); };
  let server;
  let store;
  let directory;
  let agent;
  let privateKey;
  let publicKey;
  let journalWrites = 0;
  let stop = false;
  let pendingAdmissions;
  const interrupt = () => { stop = true; pendingAdmissions?.abort(); server?.closeAllConnections(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const { createApp, LISTEN_BACKLOG = 511 } = await import(pathToFileURL(config.app));
    let journal = null;
    if (config.journal !== 'off') {
      ({ publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
      directory = await mkdtemp(join(tmpdir(), 'judgeyou-capacity-'));
      store = openStore(join(directory, 'benchmark.db'));
      journal = createJournal({ store, publicKey });
      const write = journal.write;
      journal.write = (entry) => { journalWrites++; return write(entry); };
    }
    const injectedSettings = {
      decisions: { perIpPerHour: 100000, perDay: 1000000, maxConcurrent: config.decisionsCap },
      screenshots: { perIpPerHour: 100000, perDay: 1000000, maxConcurrent: config.screenshotsCap },
      timeoutMs: config.timeoutMs,
    };
    const fakeDelay = (signal) => config.modelLatencyMs ? sleep(config.modelLatencyMs, undefined, { signal }) : Promise.resolve();
    let upstreamCalls = 0;
    let transcriberCalls = 0;
    server = createApp({
      key: 'benchmark-placeholder', adminToken: '', origins: ['http://benchmark.local'],
      settings: { get: () => structuredClone(injectedSettings) },
      limiter: { take: () => null }, screenshotLimiter: { take: () => null }, journal,
      judgeModel: 'benchmark/fake',
      upstream: async (_body, { signal } = {}) => {
        upstreamCalls++;
        await fakeDelay(signal);
        return new Response(fixture.response, { status: 200 });
      },
      transcribe: async (_message, { signal } = {}) => {
        transcriberCalls++;
        await fakeDelay(signal);
        return { text: '2026-10-25, 12:00 - Synthetic: benchmark' };
      },
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen({ port: 0, host: '127.0.0.1', backlog: LISTEN_BACKLOG }, done); });
    const port = server.address().port;
    const target = config.targetUrl ? new URL(config.targetUrl) : null;
    agent = new Agent({ keepAlive: true, maxSockets: config.maxSockets, maxFreeSockets: 300 });
    const seenSockets = config.timing ? new WeakSet() : null;
    const etags = new Map();
    const body = fixture.body;
    const screenshot = JSON.stringify({ images: ['data:image/jpeg;base64,YmVuY2htYXJr'], today: '2026-10-25' });
    const issue = (path, signal, stats, conditional = false, payload) => new Promise((done) => {
      const started = performance.now();
      const headers = { 'Accept-Encoding': 'br, gzip' };
      if (conditional && etags.has(path)) headers['If-None-Match'] = etags.get(path);
      if (payload) Object.assign(headers, { Origin: 'http://benchmark.local', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      let settled = false;
      const timing = stats?.timing;
      let reusedSocket = false;
      const finish = (status, bytes = 0, responseHeaders = {}) => {
        if (settled) return;
        settled = true;
        const ok = status >= 200 && status < 400;
        if (stats) {
          stats.http.add(performance.now() - started);
          (ok ? stats.success : stats.failure).add(performance.now() - started);
          if (status === 503) stats.unavailable.add(performance.now() - started);
          stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
          stats.bytes += bytes;
          if (!ok) stats.httpErrors++;
        }
        done({ ok, status, headers: responseHeaders });
      };
      const req = request({ hostname: !payload && target ? target.hostname.replace(/^\[|\]$/g, '') : '127.0.0.1', port: !payload && target ? Number(target.port || 80) : port, path, method: payload ? 'POST' : 'GET', headers, agent, signal }, (res) => {
        const headersAt = timing ? performance.now() : 0;
        if (timing) (reusedSocket ? timing.reusedSocketTtfb : timing.newSocketTtfb).add(headersAt - started);
        let bytes = 0;
        res.on('data', (chunk) => { bytes += chunk.length; });
        res.once('error', () => finish('transport-error'));
        res.once('end', () => {
          if (timing) timing.bodyRead.add(performance.now() - headersAt);
          finish(res.statusCode, bytes, res.headers);
        });
      });
      if (seenSockets) req.once('socket', (socket) => {
        reusedSocket = seenSockets.has(socket);
        seenSockets.add(socket);
        if (!timing) return;
        const assignedAt = performance.now();
        timing.agentQueue.add(assignedAt - started);
        timing.connections[reusedSocket ? 'reused' : 'new']++;
        if (socket.connecting) {
          const connected = () => {
            socket.removeListener('close', closed);
            timing.tcpConnect.add(performance.now() - assignedAt);
          };
          const closed = () => socket.removeListener('connect', connected);
          socket.once('connect', connected);
          // A failed connection has no connect sample and must not retain phase stats.
          socket.once('close', closed);
        }
      });
      req.once('error', () => finish('transport-error'));
      req.end(payload);
    });
    // Prime and validate every asset before timing, using the selected checkout.
    for (const path of ['/', ...assets]) {
      const response = await issue(path, AbortSignal.timeout(config.timeoutMs));
      if (!response.ok) throw new Error(`Asset preflight failed: ${path} (${response.status})`);
      if (response.headers.etag) etags.set(path, response.headers.etag);
    }
    const modelPreflight = await issue('/api/decisions', AbortSignal.timeout(config.timeoutMs), null, false, body);
    if (modelPreflight.status !== 200 || (journal && !modelPreflight.headers['x-result-id']) || (config.journal === 'sealed' && !modelPreflight.headers['x-deletion-code'])) {
      throw new Error(`Model/journal preflight failed (${modelPreflight.status}); consent-enabled runs require a sealed journal row`);
    }
    output({ type: 'environment', at: new Date().toISOString(), config, injectedSettings,
      node: process.version, platform: platform(), release: release(), arch: process.arch, cpus: cpus().length,
      listenBacklog: LISTEN_BACKLOG,
      availableParallelism: availableParallelism(), cpuModel: cpus()[0]?.model, memoryBytes: totalmem(), uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? 'Node default',
      network: 'Ephemeral 127.0.0.1 only; fake upstream/transcriber; external fetch disabled',
      measurement: `${config.iterationsPerClient === 1 ? 'One workflow per scheduled client, not users.' : 'Closed-loop clients, not users.'} ${target ? 'Static target runs separately; process metrics cover the generator only. Apply the same combined container resource budget.' : 'Server and HTTP load generator share this process.'} RPS includes failures and drain time. Page graph includes all declared CSS fonts and runtime mascots; other JavaScript-created images and lazy imports excluded. No JavaScript execution. Static assets primed before timing. Screenshots use one tiny synthetic JPEG data URL, not max-size images.`,
      workload: `Each client repeats sequential workflows, up to iterationsPerClient (0 = unlimited). First starts are scheduled at phase start + clientIndex/clients * ramp, independently in warmup and measurement. No workflow admission after the shared phase deadline or iteration budget; admitted workflows drain. Client-limited phases may finish before admissionWindowMs. Rates include ramp and drain. maxSockets is per origin, shared by all clients.`,
      ...(config.timing ? { timingDefinitions: {
        agentQueue: 'Request creation to socket assignment; includes Agent queue and scheduling delay.',
        tcpConnect: 'Socket assignment to connect event for connecting TCP sockets; includes DNS when using localhost. Failed connections have no sample.',
        newSocketTtfb: 'Request creation to response headers on a newly observed physical socket; includes queue/connect, not first body byte.',
        reusedSocketTtfb: 'Request creation to response headers on a previously observed physical socket, including preflight/warmup sockets; includes queue.',
        bodyRead: 'Response headers to complete response body; only responses reaching end have samples.',
        connections: 'Measured request socket assignments, split by new/reused physical socket; not concurrent connections. Requests aborted before assignment are excluded.',
        histograms: 'Counts of observed events; 0.1ms buckets plus overflow at timeoutMs + 0.1ms, exact maxMs. Errors may lack later events. No timing histograms/listeners when timing=false.',
      } } : {}),
      capacity: 'Injected settings; older apps may ignore them. Quota limiters bypassed. 503 is reported separately.',
      journalStorage: config.journal === 'off' ? 'disabled' : 'temporary SQLite WAL; generated RSA-2048 key; deleted on exit',
      decisionBytes: Buffer.byteLength(body), stateBytes: fixture.stateBytes, questionCount: fixture.questionCount, responseBytes: Buffer.byteLength(fixture.response), assetsPerPage: assets.length, assets,
    });
    const modelCases = config.scenarios.includes('model') ? config.levels.length : 0;
    const journalBudgetPerPhase = Math.floor((config.journalRows - 1) / Math.max(1, modelCases * (config.warmup ? 2 : 1)));
    for (const scenario of config.scenarios) for (const clients of config.levels) {
      if (stop) break;
      async function phase(seconds, measured) {
        const stats = { http: distribution(config.timeoutMs), success: distribution(config.timeoutMs), failure: distribution(config.timeoutMs), unavailable: distribution(config.timeoutMs), workflows: distribution(config.timeoutMs), statuses: {}, bytes: 0, httpErrors: 0, workflowErrors: 0 };
        if (measured && config.timing) stats.timing = {
          ...Object.fromEntries(['agentQueue', 'tcpConnect', 'newSocketTtfb', 'reusedSocketTtfb', 'bodyRead'].map((name) => [name, distribution(config.timeoutMs)])),
          connections: { new: 0, reused: 0 },
        };
        const eventLoop = monitorEventLoopDelay({ resolution: 10 });
        if (measured) eventLoop.enable();
        const cpu = process.cpuUsage();
        const started = performance.now();
        const deadline = started + seconds * 1000;
        const cap = scenario === 'model' && journal ? Math.min(config.maxIterations, journalBudgetPerPhase) : config.maxIterations;
        let admitted = 0;
        let completed = 0;
        let active = 0;
        let peakActive = 0;
        const admissions = config.ramp ? new AbortController() : null;
        // At most one bounded ramp wait per client shares this cancellation signal.
        if (admissions) setMaxListeners(clients + 1, admissions.signal);
        pendingAdmissions = admissions;
        await Promise.all(Array.from({ length: clients }, async (_, client) => {
          let iteration = 0;
          if (admissions) {
            const firstStart = Math.min(deadline, started + client / clients * config.ramp * 1000);
            while (!stop && !admissions.signal.aborted && performance.now() < firstStart) {
              await sleep(Math.ceil(firstStart - performance.now()), undefined, { signal: admissions.signal }).catch((error) => {
                if (error.name !== 'AbortError') throw error;
              });
            }
          }
          while (!stop && performance.now() < deadline && admitted < cap && (!config.iterationsPerClient || iteration < config.iterationsPerClient)) {
            admitted++;
            active++;
            peakActive = Math.max(peakActive, active);
            if (admitted >= cap) admissions?.abort();
            const begun = performance.now();
            const signal = AbortSignal.timeout(config.timeoutMs);
            const measuredStats = measured ? stats : null;
            let ok = true;
            if (scenario === 'page' || scenario === 'ready') {
              ok = (await issue('/', signal, measuredStats)).ok;
              const pageAssets = scenario === 'ready' ? assets.filter((path) => /\.(?:js|css)$/.test(path)) : assets;
              for (let i = 0; i < pageAssets.length && !signal.aborted && !stop; i += 6) {
                const responses = await Promise.all(pageAssets.slice(i, i + 6).map((path) => issue(path, signal, measuredStats)));
                ok = responses.every((response) => response.ok) && ok;
              }
              if (signal.aborted) ok = false;
            } else if (scenario === 'assets') {
              ok = (await issue(assets[(client + iteration) % assets.length], signal, measuredStats, true)).ok;
            } else {
              ok = (await issue(scenario === 'model' ? '/api/decisions' : '/api/screenshots', signal, measuredStats, false, scenario === 'model' ? body : screenshot)).ok;
            }
            iteration++;
            completed++;
            active--;
            if (measured) {
              stats.workflows.add(performance.now() - begun);
              if (!ok) stats.workflowErrors++;
            }
          }
        }));
        pendingAdmissions = null;
        const elapsedMs = performance.now() - started;
        eventLoop.disable();
        if (!measured) return;
        const http = stats.http.summary();
        const workflows = stats.workflows.summary();
        const used = process.cpuUsage(cpu);
        output({ type: 'result', scenario, clients, closedLoop: config.iterationsPerClient !== 1, admissionWindowMs: seconds * 1000, elapsedMs: round(elapsedMs),
          stopped: stop ? 'signal' : admitted >= cap ? 'iteration-budget' : config.iterationsPerClient && completed === clients * config.iterationsPerClient ? 'client-iterations' : 'duration', iterationBudget: cap,
          http: { ...http, success: stats.success.summary(), failure: stats.failure.summary(), unavailable503: stats.unavailable.summary(), rps: round(http.count / (elapsedMs / 1000)), successfulRps: round(stats.success.summary().count / (elapsedMs / 1000)), errorRate: http.count ? stats.httpErrors / http.count : 0, statuses: stats.statuses,
            statusRates: Object.fromEntries(Object.entries(stats.statuses).map(([status, count]) => [status, count / http.count])),
            unavailable503Rate: (stats.statuses[503] ?? 0) / (http.count || 1), bytes: stats.bytes },
          workflows: { ...workflows, admitted, completed, peakActive, perSecond: round(workflows.count / (elapsedMs / 1000)), errorRate: workflows.count ? stats.workflowErrors / workflows.count : 0 },
          ...(stats.timing ? { timing: Object.fromEntries(Object.entries(stats.timing).map(([name, value]) => [name, name === 'connections' ? value : value.summary()])) } : {}),
          process: { cpuUserMs: round(used.user / 1000), cpuSystemMs: round(used.system / 1000), rssBytes: process.memoryUsage().rss, peakRssKiB: process.resourceUsage().maxRSS },
          eventLoop: { sampleIntervalMs: 10, samples: eventLoop.count, p50Ms: eventLoop.count ? round(eventLoop.percentile(50) / 1e6) : null, p95Ms: eventLoop.count ? round(eventLoop.percentile(95) / 1e6) : null, maxMs: round(eventLoop.max / 1e6) },
        });
      }
      if (config.warmup) await phase(config.warmup, false);
      await phase(config.duration, true);
    }
    let journalEvidence = null;
    if (store) {
      const db = new DatabaseSync(join(directory, 'benchmark.db'), { readOnly: true });
      try {
        const counts = db.prepare('SELECT COUNT(*) AS rows, COUNT(chat) AS sealedRows FROM judgments').get();
        if (counts.rows !== journalWrites || (config.journal === 'sealed' && counts.sealedRows !== counts.rows)) throw new Error('Journal did not store every successful fake decision');
        let verifiedSealing = false;
        if (config.journal === 'sealed') {
          const row = db.prepare('SELECT chat FROM judgments WHERE chat IS NOT NULL LIMIT 1').get();
          const decoded = JSON.parse(unseal(Buffer.from(row.chat), privateKey));
          if (decoded.state.messages[0].from !== 'Person 1') throw new Error('Sealed sample did not round-trip with scrubbed names');
          verifiedSealing = true;
        }
        journalEvidence = { ...counts, verifiedSealing, consent: config.journal === 'sealed' };
      } finally { db.close(); }
    }
    output({ type: 'complete', at: new Date().toISOString(), interrupted: stop, upstreamCalls, transcriberCalls, journal: journalEvidence });
    if (stop) process.exitCode = 130;
  } finally {
    agent?.destroy();
    if (server?.listening) await new Promise((done) => { server.closeAllConnections(); server.close(done); });
    store?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    globalThis.fetch = previousFetch;
    if (previousPublicDir === undefined) delete process.env.PUBLIC_DIR;
    else process.env.PUBLIC_DIR = previousPublicDir;
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = options(process.argv.slice(2));
    if (config) await run(config);
    else console.log(HELP);
  } catch (error) {
    console.error(`Benchmark failed: ${error.message}`);
    process.exitCode = 1;
  }
}
