// Serves the page and forwards its requests to OpenRouter, so the OpenRouter
// key stays on the server and the server alone decides which models run.
// Every judgment is journaled; the chat itself only when the visitor lets us
// keep it (see journal.js). Screenshots are read and forgotten.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournal } from './journal.js';
import { createCapacity, createLimiter } from './limits.js';
import { createSettings } from './settings.js';
import { createTelemetry } from './telemetry.js';
import { adminAuthorized, serveAdmin } from './admin.js';
import { serveFile } from './static.js';
import { prepareAssets } from './assets.js';
import { DECISIONS_URL, JUDGE_MODEL, SCREENSHOT_MODEL } from './models.js';
import { openStore } from './store.js';
import { MAX_SCREENSHOTS, MAX_SCREENSHOT_BYTES, TranscribeError, createTranscriber, invalidScreenshots } from './transcribe.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// A full request is ~64 KB (see STATE_TOKEN_BUDGET); this leaves headroom.
const MAX_BODY_BYTES = 256 * 1024;
// Base64 makes images a third bigger.
const MAX_SCREENSHOTS_BODY_BYTES = Math.ceil((MAX_SCREENSHOTS * MAX_SCREENSHOT_BYTES * 4) / 3) + 1024;
// Keep connection bursts in the kernel queue while the event loop serves assets.
export const LISTEN_BACKLOG = 4096;
export function createApp({
  key = process.env.OPENROUTER_KEY,
  origins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  settings = createSettings(),
  adminToken = process.env.ADMIN_TOKEN,
  telemetry = createTelemetry(),
  limiter = createLimiter({ limits: () => settings.get().decisions }),
  screenshotLimiter = createLimiter({ limits: () => settings.get().screenshots }),
  journal = null,
  judgeModel = JUDGE_MODEL,
  transcribe = createTranscriber({ key, model: SCREENSHOT_MODEL }),
  upstream = (body, { signal }) =>
    fetch(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'JudgeYou' },
      body,
      signal,
    }),
} = {}) {
  if (!key) throw new Error('OPENROUTER_KEY is not set');
  if (adminToken && adminToken.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters.');
  const capacity = {
    decisions: createCapacity(() => settings.get().decisions.maxConcurrent),
    screenshots: createCapacity(() => settings.get().screenshots.maxConcurrent),
  };
  const forgetLimiter = createLimiter({ perIpPerHour: 100, perDay: 1_000_000 });

  async function withCapacity(req, res, kind, operation) {
    const release = capacity[kind].acquire();
    if (!release) {
      telemetry.mark(res, 'busy503');
      req.resume();
      res.setHeader('Retry-After', '2');
      return fail(res, 503, 'JudgeYou is busy. Please try again shortly.');
    }
    const controller = new AbortController();
    let timedOut = false;
    const disconnected = () => controller.abort();
    res.once('close', disconnected);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.get().timeoutMs);
    try {
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
      await Promise.race([operation(controller.signal), aborted]);
    } catch (error) {
      if (timedOut) {
        telemetry.mark(res, 'timeouts504');
        req.resume();
        fail(res, 504, 'The model took too long. Please try again.');
      } else if (!controller.signal.aborted) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
      res.removeListener('close', disconnected);
      release();
    }
  }

  async function decide(req, res, signal) {
    // Browsers always send Origin on a POST. This keeps other websites out;
    // scripts can fake it, which is what the limits are for.
    if (!origins.includes(req.headers.origin)) return fail(res, 403, 'Requests must come from the JudgeYou page.');

    const message = await readJson(req, res, MAX_BODY_BYTES, signal);
    if (!message) return;
    const { keep = false, context = {} } = message;
    if (!isObject(message.request) || !isObject(message.request.state) || !isObject(message.request.questions) || !isObject(context)) {
      return fail(res, 400, 'Only decisions are forwarded.');
    }
    if (Object.keys(message.request.questions).length > 64 || Buffer.byteLength(JSON.stringify(message.request.state)) > 64 * 1024) {
      return fail(res, 400, 'The judgment is too large. Send a shorter chat with fewer questions.');
    }
    const request = { state: message.request.state, questions: message.request.questions, model: judgeModel };
    if (!withinLimit(limiter, req, res)) return;

    const started = performance.now();
    let status;
    let text;
    try {
      const answer = await upstream(JSON.stringify(request), { signal });
      status = answer.status;
      text = await answer.text();
    } catch {
      signal.throwIfAborted();
      telemetry.mark(res, 'upstreamFailures');
      return fail(res, 502, 'OpenRouter could not be reached.');
    }
    signal.throwIfAborted();

    if (status >= 400) telemetry.mark(res, 'upstreamFailures');
    if (status >= 500 && status < 600) telemetry.mark(res, 'upstream5xx');

    const written = journal?.write({
      ip: clientIp(req),
      request,
      context,
      keep: keep === true,
      status,
      ms: Math.round(performance.now() - started),
      payload: parseOrNull(text),
    });
    const headers = { 'Content-Type': 'application/json' };
    if (written?.deletionCode) headers['X-Deletion-Code'] = written.deletionCode;
    if (written?.resultId) headers['X-Result-Id'] = written.resultId;
    res.writeHead(status, headers);
    res.end(text);
  }

  async function forget(req, res) {
    if (!origins.includes(req.headers.origin)) return fail(res, 403, 'Requests must come from the JudgeYou page.');
    const message = await readJson(req, res);
    if (!message) return;
    if (typeof message.code !== 'string') return fail(res, 400, 'Send the deletion code.');
    if (!withinLimit(forgetLimiter, req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ forgotten: Boolean(journal?.forget(message.code)) }));
  }

  async function screenshots(req, res, signal) {
    if (!origins.includes(req.headers.origin)) return fail(res, 403, 'Requests must come from the JudgeYou page.');
    const message = await readJson(req, res, MAX_SCREENSHOTS_BODY_BYTES, signal);
    if (!message) return;
    const invalid = invalidScreenshots(message);
    if (invalid) return fail(res, 400, invalid);
    if (!withinLimit(screenshotLimiter, req, res)) return;
    try {
      const { text } = await transcribe(message, { signal });
      signal.throwIfAborted();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (error) {
      signal.throwIfAborted();
      telemetry.mark(res, 'upstreamFailures');
      if ((error.status ?? 502) >= 500) telemetry.mark(res, 'upstream5xx');
      if (!(error instanceof TranscribeError)) console.error('Could not read screenshots:', error);
      fail(res, error.status ?? 502, error instanceof TranscribeError ? error.message : 'OpenRouter could not be reached.');
    }
  }

  // Anyone with a share link may read its verdict: names were replaced
  // before it was stored, and the link carries them only after the "#",
  // which browsers never send.
  function result(id, res) {
    const found = /^[a-z2-9]{10}$/.test(id) ? journal?.result(id) : null;
    if (!found) return fail(res, 404, 'No verdict with that link.');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
    res.end(JSON.stringify(found));
  }

  function withinLimit(limiter, req, res) {
    const refusal = limiter.take(clientIp(req));
    if (!refusal) return true;
    telemetry.mark(res, 'quota429');
    res.setHeader('Retry-After', String(refusal.retryAfter));
    fail(res, 429, refusal.reason);
    return false;
  }

  const usage = () => ({
    decisions: { ...limiter.snapshot(), ...capacity.decisions.snapshot() },
    screenshots: { ...screenshotLimiter.snapshot(), ...capacity.screenshots.snapshot() },
  });

  async function admin(req, res, health = false) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!adminToken) return fail(res, 404, 'Not found.');
    if (!adminAuthorized(req, adminToken)) return fail(res, 401, 'Admin token required.');
    if (health) {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return fail(res, 405, 'Use GET.');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...telemetry.snapshot(), usage: usage() }));
    }
    if (req.method === 'PUT') {
      if (!origins.includes(req.headers.origin)) return fail(res, 403, 'Requests must come from the JudgeYou page.');
      const value = await readJson(req, res, 4096);
      if (!value) return;
      try {
        await settings.update(value);
      } catch (error) {
        if (error.code) throw error;
        return fail(res, 400, error.message);
      }
    } else if (req.method !== 'GET') {
      return fail(res, 405, 'Use GET or PUT.');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      settings: settings.get(),
      usage: usage(),
    }));
  }

  return createServer(async (req, res) => {
    telemetry.observe(req, res);
    // A disconnect can emit an error after a timed-out body reader detaches.
    req.on('error', () => {});
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/api/admin/health') return await admin(req, res, true);
      if (path === '/api/admin/settings') return await admin(req, res);
      if (path === '/admin' || path === '/admin/') {
        if (!adminToken) return fail(res, 404, 'Not found.');
        return req.method === 'GET' ? await serveAdmin(res) : fail(res, 405, 'Use GET.');
      }
      if (path === '/api/decisions' || path === '/api/screenshots') {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST.');
        if (!origins.includes(req.headers.origin)) {
          req.resume();
          return fail(res, 403, 'Requests must come from the JudgeYou page.');
        }
        const kind = path === '/api/decisions' ? 'decisions' : 'screenshots';
        const handler = kind === 'decisions' ? decide : screenshots;
        return await withCapacity(req, res, kind, (signal) => handler(req, res, signal));
      }
      if (path === '/api/forget') return req.method === 'POST' ? await forget(req, res) : fail(res, 405, 'Use POST.');
      // Shares land in the service worker (sw.js). One that reaches us came
      // before it was running; the page is the most useful answer.
      if (path === '/share' && req.method === 'POST') {
        req.resume();
        res.writeHead(303, { Location: '/' });
        return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Use GET.');
      if (path.startsWith('/api/results/')) return result(path.slice('/api/results/'.length), res);
      // Share links open the page, which then loads the verdict itself. They
      // are between friends, so search engines must not list them.
      if (path.startsWith('/v/')) {
        res.setHeader('X-Robots-Tag', 'noindex');
        return await serveFile(req, res, '/');
      }
      return await serveFile(req, res, path);
    } catch (error) {
      if (req.aborted || res.destroyed) return;
      console.error('Request failed:', error);
      fail(res, 500, 'The request could not be completed.');
    }
  });
}

// Caddy sets X-Forwarded-For to the address it saw and does not pass on a
// client's own value, so the header is only trustworthy behind it.
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',').at(-1).trim() || req.socket.remoteAddress;
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The parsed body, or null after answering with the reason it was refused. */
async function readJson(req, res, limit = MAX_BODY_BYTES, signal) {
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    fail(res, 413, 'That is too big.');
    return null;
  }
  const body = await readBody(req, limit, signal);
  signal?.throwIfAborted();
  if (body === null) {
    fail(res, 413, 'That is too big.');
    return null;
  }
  const value = parseOrNull(body);
  if (!isObject(value)) fail(res, 400, 'The request is not a JSON object.');
  return isObject(value) ? value : null;
}

async function readBody(req, limit, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const finish = (value, error) => {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', failed);
      signal?.removeEventListener('abort', aborted);
      chunks = [];
      if (error) reject(error);
      else resolve(value);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(null);
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => finish(Buffer.concat(chunks).toString('utf8'));
    const failed = (error) => finish(null, error);
    const aborted = () => {
      finish(null, signal.reason);
      req.resume();
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

// Same shape as OpenRouter's errors, so the page reads both the same way.
function fail(res, status, message) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.BUILT_ASSETS_DIR) {
    if (!process.env.PUBLIC_DIR) throw new Error('PUBLIC_DIR is required with BUILT_ASSETS_DIR.');
    await prepareAssets({ builtDir: process.env.BUILT_ASSETS_DIR, assetsDir: join(process.env.PUBLIC_DIR, 'assets') });
  }
  const port = Number(process.env.PORT ?? 8000);
  const origins = process.env.ALLOWED_ORIGINS ? undefined : [`http://localhost:${port}`];
  const dataDir = process.env.DATA_DIR ?? join(ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = openStore(join(dataDir, 'judgeyou.db'));
  const publicKey = readFileSync(new URL('chats-public.pem', import.meta.url));
  const journal = createJournal({ store, publicKey });
  const settings = createSettings({ file: join(dataDir, 'settings.json') });
  const app = createApp({ origins, journal, settings });
  app.headersTimeout = 10_000;
  app.requestTimeout = 125_000;
  app.listen({ port, backlog: LISTEN_BACKLOG }, () => console.log(`JudgeYou on http://localhost:${port}`));
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => {
    app.close(() => store.close());
    app.closeIdleConnections();
    setTimeout(() => app.closeAllConnections(), 10_000).unref();
  });
}
