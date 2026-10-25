// Serves the page and forwards its requests to OpenRouter, so the OpenRouter
// key stays on the server and the server alone decides which models run.
// Every judgment is journaled; the chat itself only when the visitor lets us
// keep it (see journal.js). Screenshots are read and forgotten.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournal } from './journal.js';
import { createLimiter } from './limits.js';
import { DECISIONS_URL, JUDGE_MODEL, SCREENSHOT_MODEL } from './models.js';
import { openStore } from './store.js';
import { MAX_SCREENSHOTS, MAX_SCREENSHOT_BYTES, TranscribeError, createTranscriber, invalidScreenshots } from './transcribe.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The service worker and manifest must sit at the root to cover the whole site.
const PUBLIC = ['index.html', 'privacy.html', 'impressum.html', 'manifest.webmanifest', 'sw.js', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'css/', 'js/', 'img/', 'fonts/'];
// A full request is ~64 KB (see STATE_TOKEN_BUDGET); this leaves headroom.
const MAX_BODY_BYTES = 256 * 1024;
// Base64 makes images a third bigger.
const MAX_SCREENSHOTS_BODY_BYTES = Math.ceil((MAX_SCREENSHOTS * MAX_SCREENSHOT_BYTES * 4) / 3) + 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

export function createApp({
  key = process.env.OPENROUTER_KEY,
  origins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  limiter = createLimiter(),
  screenshotLimiter = createLimiter(),
  journal = null,
  judgeModel = JUDGE_MODEL,
  transcribe = createTranscriber({ key, model: SCREENSHOT_MODEL }),
  upstream = (body) =>
    fetch(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'JudgeYou' },
      body,
    }),
} = {}) {
  if (!key) throw new Error('OPENROUTER_KEY is not set');

  async function decide(req, res) {
    // Browsers always send Origin on a POST. This keeps other websites out;
    // scripts can fake it, which is what the limits are for.
    if (!origins.includes(req.headers.origin)) return fail(res, 403, 'Requests must come from the JudgeYou page.');

    const message = await readJson(req, res);
    if (!message) return;
    const { keep = false, context = {} } = message;
    if (!isObject(message.request) || !isObject(message.request.state) || !isObject(message.request.questions) || !isObject(context)) {
      return fail(res, 400, 'Only decisions are forwarded.');
    }
    const request = { ...message.request, model: judgeModel };
    if (!withinLimit(limiter, req, res)) return;

    const started = performance.now();
    let status;
    let text;
    try {
      const answer = await upstream(JSON.stringify(request));
      status = answer.status;
      text = await answer.text();
    } catch {
      return fail(res, 502, 'OpenRouter could not be reached.');
    }

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
    if (!withinLimit(limiter, req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ forgotten: Boolean(journal?.forget(message.code)) }));
  }

  async function screenshots(req, res) {
    if (!origins.includes(req.headers.origin)) return fail(res, 403, 'Requests must come from the JudgeYou page.');
    const message = await readJson(req, res, MAX_SCREENSHOTS_BODY_BYTES);
    if (!message) return;
    const invalid = invalidScreenshots(message);
    if (invalid) return fail(res, 400, invalid);
    if (!withinLimit(screenshotLimiter, req, res)) return;
    try {
      const { text } = await transcribe(message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (error) {
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
    res.setHeader('Retry-After', String(refusal.retryAfter));
    fail(res, 429, refusal.reason);
    return false;
  }

  return createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const api = { '/api/decisions': decide, '/api/forget': forget, '/api/screenshots': screenshots }[path];
    if (api) return req.method === 'POST' ? api(req, res) : fail(res, 405, 'Use POST.');
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
      return serveFile('/', res);
    }
    return serveFile(path, res);
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
async function readJson(req, res, limit = MAX_BODY_BYTES) {
  const body = await readBody(req, limit);
  if (body === null) {
    fail(res, 413, 'That is too big.');
    return null;
  }
  const value = parseOrNull(body);
  if (!isObject(value)) fail(res, 400, 'The request is not a JSON object.');
  return isObject(value) ? value : null;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveFile(path, res) {
  const file = normalize(path === '/' ? 'index.html' : path.slice(1));
  const allowed = PUBLIC.some((prefix) => file === prefix || file.startsWith(prefix));
  // A key.js left over from the old bring-your-own-key setup holds a real key.
  if (!allowed || file === 'js/key.js') return fail(res, 404, 'Not found.');
  try {
    const content = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    fail(res, 404, 'Not found.');
  }
}

// Same shape as OpenRouter's errors, so the page reads both the same way.
function fail(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8000);
  const origins = process.env.ALLOWED_ORIGINS ? undefined : [`http://localhost:${port}`];
  const dataDir = process.env.DATA_DIR ?? join(ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = openStore(join(dataDir, 'judgeyou.db'));
  const publicKey = readFileSync(new URL('chats-public.pem', import.meta.url));
  const journal = createJournal({ store, publicKey });
  createApp({ origins, journal }).listen(port, () => console.log(`JudgeYou on http://localhost:${port}`));
}
