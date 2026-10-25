import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Production deploys replace the container, so a process sees one asset version.
const IMMUTABLE = process.env.NODE_ENV === 'production';
const FILES = ['index.html', 'privacy.html', 'impressum.html', 'manifest.webmanifest', 'sw.js', 'favicon.ico', 'robots.txt', 'sitemap.xml'];
const DIRECTORIES = ['css', 'js', 'img', 'fonts'];
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
const TEXT = new Set(['.html', '.css', '.js', '.svg', '.webmanifest', '.txt', '.xml']);
const compress = {
  gzip: promisify(gzip),
  br: (content) => promisify(brotliCompress)(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
};
let inventory;

// Only files present in the public tree at startup can acquire cache entries.
// Misses cannot grow the cache, and a new deployment starts a new inventory.
async function publicFiles() {
  const files = new Map(FILES.map((file) => [file, {}]));
  async function visit(directory) {
    const entries = await fs.readdir(join(ROOT, directory), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    await Promise.all(entries.map(async (entry) => {
      const file = `${directory}/${entry.name}`;
      if (file === 'js/key.js') return;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.set(file, {});
    }));
  }
  await Promise.all(DIRECTORIES.map(visit));
  return files;
}

const version = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const representation = (content) => ({ content, etag: `"${createHash('sha256').update(content).digest('base64url')}"` });

async function load(file, slot) {
  if (IMMUTABLE && slot.asset) return slot.asset;
  if (slot.pending) return slot.pending;
  slot.pending = (async () => {
    const path = join(ROOT, file);
    // Do not let a symlink inside a public directory publish private files.
    if (await fs.realpath(path) !== path) throw new Error('Not a public file');
    for (let attempt = 0; attempt < 3; attempt++) {
      const stat = await fs.stat(path, { bigint: true });
      if (!stat.isFile()) throw new Error('Not a file');
      const current = version(stat);
      if (slot.asset?.version === current) return slot.asset;
      const content = await fs.readFile(path);
      // A deployment may replace a file while it is being read.
      if (version(await fs.stat(path, { bigint: true })) !== current || await fs.realpath(path) !== path) continue;
      slot.asset = { version: current, variants: new Map([['identity', Promise.resolve(representation(content))]]) };
      return slot.asset;
    }
    throw new Error('File is changing');
  })();
  try {
    return await slot.pending;
  } catch (error) {
    slot.asset = null;
    throw error;
  } finally {
    slot.pending = null;
  }
}

function encoding(header, text) {
  if (!header?.trim()) return 'identity';
  const qualities = new Map();
  for (const item of header.toLowerCase().split(',')) {
    const [name, ...parameters] = item.trim().split(';');
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(.*?)\s*$/.exec(parameter);
      if (match) quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(match[1]) ? Number(match[1]) : 0;
    }
    qualities.set(name.trim(), Math.min(quality, qualities.get(name.trim()) ?? 1));
  }
  const quality = (name) => qualities.get(name) ?? (name === 'identity' ? (qualities.get('*') === 0 ? 0 : 1) : qualities.get('*') ?? 0);
  return (text ? ['br', 'gzip', 'identity'] : ['identity'])
    .map((name) => ({ name, q: quality(name) }))
    .filter(({ q }) => q > 0)
    .sort((a, b) => b.q - a.q)[0]?.name;
}

function matches(header, etag) {
  // GET/HEAD use weak comparison, even though each representation has a strong tag.
  return (header?.match(/(?:W\/)?"[^"]*"|\*/g) ?? []).some((tag) => tag === '*' || tag.replace(/^W\//, '') === etag);
}

function fail(req, res, status, message) {
  const body = JSON.stringify({ error: { message } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Serve a public pathname. Share routes pass '/' to serve the page. */
export async function serveFile(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return fail(req, res, 405, 'Use GET or HEAD.');
  }
  let file;
  try {
    const decoded = decodeURIComponent(path);
    if (!decoded.startsWith('/') || /[\\\0]/.test(decoded)) return fail(req, res, 404, 'Not found.');
    file = posix.normalize(decoded).slice(1);
    if (!file) file = 'index.html';
  } catch {
    return fail(req, res, 404, 'Not found.');
  }
  let asset;
  try {
    const files = await (inventory ??= publicFiles());
    const slot = files.get(file);
    if (!slot) return fail(req, res, 404, 'Not found.');
    asset = await load(file, slot);
  } catch {
    return fail(req, res, 404, 'Not found.');
  }
  const extension = extname(file);
  const text = TEXT.has(extension);
  if (text) res.setHeader('Vary', 'Accept-Encoding');
  const selected = encoding(req.headers['accept-encoding'], text);
  if (!selected) return fail(req, res, 406, 'No acceptable content encoding.');
  try {
    if (!asset.variants.has(selected)) {
      const pending = asset.variants.get('identity').then(({ content }) => compress[selected](content)).then(representation);
      asset.variants.set(selected, pending);
      // Retry transient compression failures on a later request.
      pending.catch(() => asset.variants.delete(selected));
    }
    const { content, etag } = await asset.variants.get(selected);
    res.setHeader('Content-Type', TYPES[extension] ?? 'application/octet-stream');
    // Asset names are not fingerprinted: even binary assets must eventually revalidate.
    res.setHeader('Cache-Control', text ? 'public, max-age=0, must-revalidate' : 'public, max-age=86400');
    res.setHeader('ETag', etag);
    if (selected !== 'identity') res.setHeader('Content-Encoding', selected);
    if (matches(req.headers['if-none-match'], etag)) {
      res.writeHead(304);
      return res.end();
    }
    res.setHeader('Content-Length', content.length);
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    fail(req, res, 500, 'Could not serve file.');
  }
}
