import { randomUUID } from 'node:crypto';

const WINDOW_SEC = 300;
const ROUTES = ['page', 'assets', 'decisions', 'screenshots', 'forget', 'results', 'admin', 'other'];
const API_ROUTES = new Set(['decisions', 'screenshots', 'forget', 'results']);
const COUNTERS = ['totalRequests', 'completedResponses', 'abortedRequests', 'errors5xx', 'busy503', 'timeouts504', 'upstream5xx', 'upstreamFailures', 'quota429'];
const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'];
const LATENCY_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, Number.MAX_SAFE_INTEGER];
const REASONS = new Set(['busy503', 'timeouts504', 'upstream5xx', 'upstreamFailures', 'quota429']);

/** Only this bounded category survives classification; no request data is stored. */
function routeCategory(path) {
  if (path === '/admin' || path.startsWith('/admin/') || path === '/api/admin' || path.startsWith('/api/admin/')) return 'admin';
  if (path === '/api/decisions') return 'decisions';
  if (path === '/api/screenshots') return 'screenshots';
  if (path === '/api/forget') return 'forget';
  if (path.startsWith('/api/results/')) return 'results';
  if (['/', '/index.html', '/privacy.html', '/impressum.html', '/share'].includes(path) || path.startsWith('/v/')) return 'page';
  if (/^\/(?:assets|css|js|img|fonts)\//.test(path) || ['/sw.js', '/favicon.ico', '/manifest.webmanifest', '/robots.txt', '/sitemap.xml'].includes(path)) return 'assets';
  return 'other';
}

function counts() {
  return {
    ...Object.fromEntries(COUNTERS.map((name) => [name, 0])),
    statusClasses: Object.fromEntries(STATUS_CLASSES.map((name) => [name, 0])),
    latency: LATENCY_MS.map(() => 0),
  };
}

function add(target, source) {
  for (const name of COUNTERS) target[name] += source[name];
  for (const name of STATUS_CLASSES) target.statusClasses[name] += source.statusClasses[name];
  for (let i = 0; i < LATENCY_MS.length; i++) target.latency[i] += source.latency[i];
}

function present({ latency, ...values }) {
  const sampleCount = latency.reduce((sum, count) => sum + count, 0);
  let remaining = Math.ceil(sampleCount * 0.95);
  const index = sampleCount ? latency.findIndex((count) => (remaining -= count) <= 0) : -1;
  return { ...values, successfulApiLatency: { sampleCount, p95Ms: index < 0 ? null : LATENCY_MS[index] } };
}

/**
 * GET /api/admin/health contract, version 1 (server.js adds `usage`):
 * { version, bootId, process: { startedAt, uptimeSec, memory: { rssBytes,
 *   heapUsedBytes } }, window: { durationSec, resolutionSec, startedAt,
 *   endedAt, totals, routes: { page, assets, decisions, screenshots, forget,
 *   results, admin, other } }, usage: { decisions, screenshots } }
 *
 * Each totals/routes value contains COUNTERS, statusClasses (1xx..5xx), and
 * successfulApiLatency { sampleCount, p95Ms }. p95Ms is the histogram's upper
 * bound, or null without samples; only completed 2xx API calls are sampled.
 * Durations run from request arrival through response finish, including bodies.
 * totalRequests = completedResponses + abortedRequests; in-flight requests are
 * absent. Status classes and errors5xx count completed responses only. A client
 * disconnect before finish counts once as abortedRequests, never as a 200/5xx.
 *
 * busy503/timeouts504/quota429 identify local capacity/deadline/quota refusals.
 * upstreamFailures counts failed model operations (transport, provider 4xx/5xx, or
 * transcription failures); upstream5xx counts observed decision HTTP 5xx and
 * transcription errors mapped to 5xx. The transcriber hides raw provider codes.
 * Reason counters can overlap errors5xx; they must not be added to it. Provider
 * 429 counts as upstreamFailures, whereas only local allowances count quota429.
 * Admin traffic (including failed auth and health probes) is always excluded.
 *
 * Terminal events enter their wall-clock second's bucket. The window includes
 * the current second and preceding 299 seconds (up to one second of rounding).
 * No per-request samples or arbitrary keys survive: at most 300 buckets, each
 * with eight fixed categories and fixed counters/histograms. All state is
 * volatile; bootId changes on process restart so monitors can reset deltas.
 */
export function createTelemetry({
  now = Date.now,
  monotonicNow = () => performance.now(),
  uptime = () => process.uptime(),
  memoryUsage = () => process.memoryUsage(),
} = {}) {
  const bootId = randomUUID();
  const startedAt = new Date(now() - uptime() * 1000).toISOString();
  const buckets = Array(WINDOW_SEC).fill(null);
  const pending = new WeakMap();

  return {
    observe(req, res) {
      const started = monotonicNow();
      let category = 'other';
      try {
        category = routeCategory(new URL(req.url, 'http://localhost').pathname);
      } catch {
        // Invalid targets still have a bounded category and no retained URL.
      }
      if (category === 'admin') return;
      const reasons = new Set();
      pending.set(res, reasons);
      const finish = () => record(true);
      const abort = () => record(false);
      const close = () => record(res.writableFinished);
      const record = (completed) => {
        req.removeListener('aborted', abort);
        res.removeListener('finish', finish);
        res.removeListener('close', close);
        pending.delete(res);
        const second = Math.floor(now() / 1000);
        const slot = ((second % WINDOW_SEC) + WINDOW_SEC) % WINDOW_SEC;
        if (buckets[slot]?.second !== second) buckets[slot] = { second, routes: {} };
        const value = buckets[slot].routes[category] ??= counts();
        value.totalRequests++;
        if (!completed) {
          value.abortedRequests++;
          return;
        }
        value.completedResponses++;
        const status = Math.floor(res.statusCode / 100);
        if (status >= 1 && status <= 5) value.statusClasses[`${status}xx`]++;
        if (status === 5) value.errors5xx++;
        for (const reason of reasons) value[reason]++;
        if (status === 2 && API_ROUTES.has(category)) {
          const duration = Math.max(0, monotonicNow() - started);
          const index = LATENCY_MS.findIndex((bound) => duration <= bound);
          value.latency[index < 0 ? LATENCY_MS.length - 1 : index]++;
        }
      };
      req.once('aborted', abort);
      res.once('finish', finish);
      res.once('close', close);
    },

    /** Accept fixed reason names only; never accept exception or response text. */
    mark(res, reason) {
      if (REASONS.has(reason)) pending.get(res)?.add(reason);
    },

    snapshot() {
      const time = now();
      const second = Math.floor(time / 1000);
      const routes = Object.fromEntries(ROUTES.map((name) => [name, counts()]));
      for (const bucket of buckets) {
        if (!bucket || bucket.second > second || bucket.second <= second - WINDOW_SEC) continue;
        for (const name of ROUTES) if (bucket.routes[name]) add(routes[name], bucket.routes[name]);
      }
      const totals = counts();
      for (const name of ROUTES) add(totals, routes[name]);
      const memory = memoryUsage();
      return {
        version: 1,
        bootId,
        process: { startedAt, uptimeSec: uptime(), memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed } },
        window: {
          durationSec: WINDOW_SEC,
          resolutionSec: 1,
          startedAt: new Date((second - WINDOW_SEC + 1) * 1000).toISOString(),
          endedAt: new Date(time).toISOString(),
          totals: present(totals),
          routes: Object.fromEntries(ROUTES.map((name) => [name, present(routes[name])])),
        },
      };
    },
  };
}
