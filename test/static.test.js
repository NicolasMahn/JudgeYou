import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, brotliDecompressSync, gzipSync, brotliCompressSync } from 'node:zlib';
import { createHook } from 'node:async_hooks';

async function start(t, { production = false } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'judgeyou-static-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['server', 'css', 'js', 'img', 'fonts', 'assets']) await fs.mkdir(join(root, directory));
  await fs.copyFile(new URL('../server/static.js', import.meta.url), join(root, 'server/static.mjs'));
  const content = {
    'index.html': '<html>JudgeYou</html>'.repeat(80),
    'privacy.html': '<html>Privacy</html>',
    'impressum.html': '<html>Imprint</html>',
    'css/style.css': 'body { color: var(--ink); }\n'.repeat(80),
    'js/app.js': 'console.log("JudgeYou");\n'.repeat(80),
    'sw.js': 'self.addEventListener("fetch", () => {});',
    'manifest.webmanifest': '{"name":"JudgeYou"}',
    'img/icon.png': Buffer.from([137, 80, 78, 71, 0, 1, 2]),
    'fonts/demo.woff2': Buffer.from([119, 79, 70, 50, 0, 1, 2]),
    'robots.txt': 'User-agent: *',
    'sitemap.xml': '<urlset/>',
    'favicon.ico': Buffer.from([0, 0, 1, 0]),
    'server/secret.txt': 'private server file',
    'js/key.js': 'private key',
    'index.html.backup': 'private backup',
    'assets/app-ABCDEFGH.js': 'console.log("built");'.repeat(100),
    'assets/notes.js': 'console.log("unversioned");',
  };
  content['assets/app-ABCDEFGH.js.br'] = brotliCompressSync(content['assets/app-ABCDEFGH.js']);
  content['assets/app-ABCDEFGH.js.gz'] = gzipSync(content['assets/app-ABCDEFGH.js'], { level: 9 });
  await Promise.all(Object.entries(content).map(([file, body]) => fs.writeFile(join(root, file), body)));
  await fs.symlink('../server/secret.txt', join(root, 'js/leak.js'));
  await fs.symlink('../server', join(root, 'js/private'));
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = production ? 'production' : 'test';
  let serveFile;
  try {
    ({ serveFile } = await import(pathToFileURL(join(root, 'server/static.mjs'))));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  const server = createServer((req, res) => {
    // Exercise the parent's root/share mapping and preservation of its headers.
    if (req.url.startsWith('/v/')) res.setHeader('X-Robots-Tag', 'noindex');
    serveFile(req, res, req.url.startsWith('/v/') ? '/' : req.url).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  return { get, root, content };
}

test('serves the allowlist with existing MIME types and root/share mapping', async (t) => {
  const { get, content } = await start(t);
  for (const [path, type] of [
    ['/', 'text/html; charset=utf-8'], ['/privacy.html', 'text/html; charset=utf-8'],
    ['/css/style.css', 'text/css; charset=utf-8'], ['/js/app.js', 'text/javascript; charset=utf-8'],
    ['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'text/javascript; charset=utf-8'],
    ['/img/icon.png', 'image/png'], ['/fonts/demo.woff2', 'font/woff2'],
    ['/robots.txt', 'text/plain; charset=utf-8'], ['/sitemap.xml', 'application/xml; charset=utf-8'],
    ['/favicon.ico', 'image/x-icon'],
  ]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], type, path);
    assert.equal(Number(response.headers['content-length']), response.body.length);
  }
  const share = await get('/v/abcdefghjk');
  assert.equal(share.body.toString(), content['index.html']);
  assert.equal(share.headers['x-robots-tag'], 'noindex');
});

test('never publishes private paths, prefix lookalikes, traversal, or symlinks', async (t) => {
  const { get } = await start(t);
  for (const path of [
    '/server/secret.txt', '/package.json', '/js/key.js', '/js/%6bey.js', '/js/a/../key.js',
    '/js/%2e%2e/server/secret.txt', '/js%2f..%2fserver%2fsecret.txt', '/js/leak.js',
    '/js/private/secret.txt', '/js/../js/key.js', '/index.html.backup', '/cssnotreally/style.css',
    '/%ZZ', '/js/%00app.js', '/js%5c..%5cserver%5csecret.txt', '/missing', '/js',
  ]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test('HEAD has GET metadata and no body, including errors and conditional responses', async (t) => {
  const { get } = await start(t);
  for (const headers of [{}, { 'Accept-Encoding': 'gzip' }, { 'Accept-Encoding': 'br' }]) {
    const full = await get('/', headers);
    const head = await get('/', headers, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    for (const header of ['content-type', 'content-length', 'content-encoding', 'etag', 'cache-control', 'vary']) {
      assert.equal(head.headers[header], full.headers[header], header);
    }
    const unchanged = await get('/', { ...headers, 'If-None-Match': full.headers.etag }, 'HEAD');
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body.length, 0);
  }
  assert.equal((await get('/missing', {}, 'HEAD')).body.length, 0);
  const refused = await get('/', {}, 'POST');
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.allow, 'GET, HEAD');
});

test('revalidates text, uses representation-specific ETags, and handles weak/list/wildcard validators', async (t) => {
  const { get } = await start(t);
  for (const path of ['/', '/css/style.css', '/js/app.js', '/sw.js', '/manifest.webmanifest']) {
    const initial = await get(path, { 'Accept-Encoding': 'gzip' });
    assert.equal(initial.headers['cache-control'], 'public, max-age=0, must-revalidate');
    assert.equal(initial.headers.vary, 'Accept-Encoding');
    for (const tag of [initial.headers.etag, `W/${initial.headers.etag}`, `"other", W/${initial.headers.etag}`, '*']) {
      const response = await get(path, { 'Accept-Encoding': 'gzip', 'If-None-Match': tag });
      assert.equal(response.status, 304, tag);
      assert.equal(response.body.length, 0);
      assert.equal(response.headers.etag, initial.headers.etag);
      assert.equal(response.headers['cache-control'], initial.headers['cache-control']);
      assert.equal(response.headers.vary, 'Accept-Encoding');
      assert.equal(response.headers['content-encoding'], 'gzip');
    }
    const identity = await get(path, { 'If-None-Match': initial.headers.etag });
    assert.equal(identity.status, 200, 'a compressed validator cannot validate different bytes');
    assert.notEqual(identity.headers.etag, initial.headers.etag);
  }
  const binary = await get('/img/icon.png');
  assert.equal(binary.headers['cache-control'], 'public, max-age=86400');
  assert.equal(binary.headers['content-encoding'], undefined);
  assert.equal((await get('/img/icon.png', { 'If-None-Match': binary.headers.etag })).status, 304);
});

test('negotiates Brotli/gzip by quality and respects explicit and wildcard exclusions', async (t) => {
  const { get, content } = await start(t);
  for (const [accept, expected] of [
    ['gzip, br', 'br'], ['gzip;q=1, br;q=0.5', 'gzip'], ['br;q=0, gzip', 'gzip'],
    ['gzip;q=0, br;q=0', undefined], ['gzip;q=0, *;q=1', 'br'],
    ['br;q=0.5, gzip;q=0.4, identity;q=0', 'br'], ['br;q=0.2, gzip;q=0.3', undefined],
    ['BR; Q=1, gzip;q=0', 'br'], ['gzip;q=0, gzip;q=1', undefined],
    ['br;q=invalid, gzip;q=1.1', undefined], ['deflate', undefined], ['', undefined],
  ]) {
    const response = await get('/', { 'Accept-Encoding': accept });
    assert.equal(response.status, 200, accept);
    assert.equal(response.headers['content-encoding'], expected, accept);
    const body = expected === 'br' ? brotliDecompressSync(response.body) : expected === 'gzip' ? gunzipSync(response.body) : response.body;
    assert.equal(body.toString(), content['index.html'], accept);
  }
  for (const accept of ['*;q=0', 'br;q=0, gzip;q=0, identity;q=0']) {
    const response = await get('/', { 'Accept-Encoding': accept });
    assert.equal(response.status, 406, accept);
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await get('/img/icon.png', { 'Accept-Encoding': 'br, identity;q=0' })).status, 406);
});

test('coalesces concurrent reads, caches representations, and invalidates a changed version', async (t) => {
  const { get, root } = await start(t);
  const original = fs.readFile;
  let reads = 0;
  let compressions = 0;
  const hook = createHook({ init(_id, type) { if (type === 'ZLIB') compressions++; } }).enable();
  t.after(() => hook.disable());
  t.mock.method(fs, 'readFile', async (...args) => {
    if (args[0] === join(root, 'css/style.css')) reads++;
    return original(...args);
  });
  const burst = await Promise.all(Array.from({ length: 32 }, () => get('/css/style.css', { 'Accept-Encoding': 'br' })));
  assert.equal(reads, 1);
  assert.equal(compressions, 1, 'a concurrent Brotli burst compresses once');
  assert.ok(burst.every((response) => response.headers.etag === burst[0].headers.etag));
  const gzip = await get('/css/style.css', { 'Accept-Encoding': 'gzip' });
  await get('/css/style.css');
  assert.equal(reads, 1, 'a second encoding reuses the identity bytes');
  assert.equal(compressions, 2, 'each encoding is compressed once per version');
  await Promise.all(Array.from({ length: 32 }, (_, i) => get(`/css/missing-${i}.css`)));
  assert.equal(reads, 1, 'unknown names cannot create cached read promises');
  const replacement = 'body { color: var(--new-ink); }';
  await fs.writeFile(join(root, 'css/style.css'), replacement);
  const changed = await Promise.all(Array.from({ length: 32 }, () => get('/css/style.css', {
    'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.etag,
  })));
  assert.equal(reads, 2);
  assert.equal(compressions, 3, 'a new asset version is compressed once despite a burst');
  assert.ok(changed.every((response) => response.status === 200 && response.headers.etag !== gzip.headers.etag));
  assert.equal(gunzipSync(changed[0].body).toString(), replacement);
  await fs.unlink(join(root, 'css/style.css'));
  assert.equal((await get('/css/style.css')).status, 404, 'a removed file must not keep serving cached content');
  await fs.symlink('../server/secret.txt', join(root, 'css/style.css'));
  assert.equal((await get('/css/style.css')).status, 404, 'replacing a cached asset with a symlink does not reveal it');
});

test('production reuses asset bytes without filesystem work until the container restarts', async (t) => {
  const { get, content } = await start(t, { production: true });
  await get('/css/style.css');
  for (const method of ['stat', 'realpath', 'readFile']) t.mock.method(fs, method, async () => { throw new Error('Unexpected filesystem access'); });
  const response = await get('/css/style.css', { 'Accept-Encoding': 'br' });
  assert.equal(response.status, 200);
  assert.equal(brotliDecompressSync(response.body).toString(), content['css/style.css']);
  assert.equal((await get('/css/style.css', { 'Accept-Encoding': 'br', 'If-None-Match': response.headers.etag })).status, 304);
});

test('fingerprinted assets use immutable caching and production serves prepared compression', async (t) => {
  const { get, content } = await start(t, { production: true });
  for (const [encoding, extension] of [['br', 'br'], ['gzip', 'gz']]) {
    const response = await get('/assets/app-ABCDEFGH.js', { 'Accept-Encoding': encoding });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(response.headers['content-encoding'], encoding);
    assert.deepEqual(response.body, content[`assets/app-ABCDEFGH.js.${extension}`]);
  }
  assert.equal((await get('/assets/notes.js')).headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal((await get('/')).headers['cache-control'], 'public, max-age=0, must-revalidate');
});


test('production refuses prepared encodings that point outside the public tree', async (t) => {
  const { get, root, content } = await start(t, { production: true });
  for (const [encoding, extension] of [['br', 'br'], ['gzip', 'gz']]) {
    const sidecar = join(root, `assets/app-ABCDEFGH.js.${extension}`);
    await fs.unlink(sidecar);
    await fs.symlink('../server/secret.txt', sidecar);
    const response = await get('/assets/app-ABCDEFGH.js', { 'Accept-Encoding': encoding });
    assert.equal(response.status, 404);
    assert.ok(!response.body.includes(Buffer.from('private server file')));
    await fs.unlink(sidecar);
    await fs.writeFile(sidecar, content[`assets/app-ABCDEFGH.js.${extension}`]);
  }
  assert.equal((await get('/assets/app-ABCDEFGH.js', { 'Accept-Encoding': 'br' })).status, 200);
});
