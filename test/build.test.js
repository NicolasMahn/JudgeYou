import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildSite } from '../scripts/build.js';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://build.test';
const fingerprint = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2|svg)$/;

async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesIn(directory, `${path}/`));
    else {
      assert.ok(entry.isFile(), `Unexpected symlink or special file: ${path}`);
      files.push(path);
    }
  }
  return files.sort();
}

async function checksums(directory, files) {
  return Promise.all(files.map(async (file) => [file,
    createHash('sha256').update(await readFile(join(directory, file))).digest('hex'),
  ]));
}

async function sourceVersion() {
  const files = ['scripts/build.js', 'server/admin.html', 'index.html', 'privacy.html', 'impressum.html',
    'manifest.webmanifest', 'sw.js', 'favicon.ico', 'robots.txt', 'sitemap.xml'];
  for (const directory of ['css', 'js', 'fonts', 'img']) {
    files.push(...(await filesIn(join(ROOT, directory))).map((file) => `${directory}/${file}`));
  }
  return JSON.stringify(await checksums(ROOT, files.filter((file) => file !== 'js/key.js').sort()));
}

function localURL(reference, document = '/index.html') {
  const url = new URL(reference, new URL(document, ORIGIN));
  if (url.origin !== ORIGIN) return null;
  return decodeURIComponent(url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname);
}

function tags(html) {
  return [...html.matchAll(/<([a-z][\w:-]*)\b([^<>]*)>/gi)].map(([, name, body]) => ({
    name: name.toLowerCase(),
    attributes: Object.fromEntries([...body.matchAll(/\b([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)]
      .map(([, key, , value]) => [key.toLowerCase(), value])),
  }));
}

function reachable(roots, graph, includeDynamic = false) {
  const seen = new Set();
  function visit(url) {
    if (seen.has(url)) return;
    seen.add(url);
    for (const edge of graph.get(url) ?? []) {
      if (includeDynamic || edge.kind !== 'dynamic-import') visit(edge.url);
    }
  }
  roots.forEach(visit);
  return seen;
}

describe('production build', { timeout: 30_000 }, () => {
  let temporary, outdir, second, manifest, files, documents, graph, sourcesUnchanged;

  after(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  before(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'judgeyou-build-test-'));
    outdir = join(temporary, 'first');
    second = join(temporary, 'second');
    const inputsBefore = await sourceVersion();
    await buildSite({ outdir });
    manifest = JSON.parse(await readFile(join(outdir, 'build-manifest.json'), 'utf8'));
    await buildSite({ outdir: second });
    sourcesUnchanged = inputsBefore === await sourceVersion();
    files = await filesIn(outdir);
    documents = new Map(await Promise.all(files.filter((file) => file.endsWith('.html'))
      .map(async (file) => [`/${file}`, tags(await readFile(join(outdir, file), 'utf8'))])));

    // Parse emitted code with the installed compiler: this follows real browser
    // imports, including re-exports and CSS URLs, rather than trusting the manifest.
    const parsed = await build({
      absWorkingDir: outdir,
      entryPoints: files.filter((file) => /\.(?:js|css)$/.test(file)),
      outdir: join(temporary, 'parsed'),
      bundle: false,
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    graph = new Map(Object.values(parsed.metafile.outputs).map((output) => {
      const source = `/${output.entryPoint}`;
      return [source, output.imports.map((edge) => ({
        kind: edge.kind,
        url: localURL(edge.path, source),
      })).filter((edge) => edge.url)];
    }));
  });

  async function assertFile(url, context) {
    assert.ok(url?.startsWith('/'), `${context}: expected a local asset URL, got ${url}`);
    const path = resolve(outdir, `.${url}`);
    assert.ok(relative(outdir, path) && !relative(outdir, path).startsWith(`..${sep}`), `${context}: escapes output`);
    assert.ok((await stat(path).catch(() => null))?.isFile(), `${context}: missing ${url}`);
  }

  function documentScripts() {
    return [...documents].flatMap(([document, elements]) => elements
      .filter(({ name, attributes }) => name === 'script' && attributes.src)
      .map(({ attributes }) => localURL(attributes.src, document)));
  }

  function initialRoots() {
    return documents.get('/index.html').flatMap(({ name, attributes }) => {
      if (name === 'script' && attributes.src) return [localURL(attributes.src)];
      if (name === 'img' && attributes.src) return [localURL(attributes.src)];
      if (name === 'link' && /^(?:stylesheet|modulepreload|preload|icon|apple-touch-icon|manifest)$/.test(attributes.rel)) {
        return [localURL(attributes.href)];
      }
      return [];
    }).filter(Boolean);
  }

  test('public, legal, and admin HTML reference files in the isolated output', async () => {
    for (const url of manifest.initialAssets) await assertFile(url, 'initialAssets');
    for (const page of ['/index.html', '/privacy.html', '/impressum.html', '/admin.html']) {
      assert.ok(documents.has(page), `Missing generated ${page}`);
    }
    for (const [document, elements] of documents) {
      for (const { attributes } of elements) {
        for (const key of ['src', 'href', 'poster']) {
          if (!attributes[key]) continue;
          const url = localURL(attributes[key], document);
          if (!url) continue;
          assert.doesNotMatch(url, /^\/(?:css|js)\//, `${document} retains a source asset: ${url}`);
          await assertFile(url, document);
        }
      }
    }
  });

  test('every compiled import resolves, and all JavaScript chunks are reachable from HTML', async () => {
    const dynamic = [];
    for (const [source, edges] of graph) {
      for (const edge of edges) {
        await assertFile(edge.url, `${source} (${edge.kind})`);
        if (edge.kind === 'dynamic-import') dynamic.push(edge.url);
      }
    }
    assert.ok(dynamic.length > 0, 'The build must preserve dynamic imports');
    const all = reachable(documentScripts(), graph, true);
    for (const file of files.filter((file) => file.startsWith('assets/') && file.endsWith('.js'))) {
      assert.ok(all.has(`/${file}`), `Unreachable JavaScript output: ${file}`);
    }
  });

  test('translations, sample verdicts, and the share card stay behind dynamic imports', () => {
    const initial = reachable(initialRoots(), graph);
    const all = reachable(documentScripts(), graph, true);
    for (const source of ['js/locales/de.js', 'js/locales/fr.js', 'js/locales/es.js', 'js/sample-answers.js', 'js/card.js']) {
      const url = manifest.entries[source];
      assert.ok(url, `Missing lazy output for ${source}`);
      assert.ok(all.has(url), `${source} cannot be loaded from the generated app`);
      assert.ok(!initial.has(url), `${source} is eagerly imported or preloaded`);
      assert.ok(!manifest.initialAssets.includes(url), `${source} is counted as an initial asset`);
    }
  });

  test('initialAssets measures actual initial imports, styles, fonts, and the app sprite', async () => {
    assert.equal(new Set(manifest.initialAssets).size, manifest.initialAssets.length, 'Initial assets must not be counted twice');
    const initial = reachable(initialRoots(), graph);
    const app = reachable(documents.get('/index.html')
      .filter(({ name, attributes }) => name === 'script' && attributes.src)
      .map(({ attributes }) => localURL(attributes.src)), graph);
    const code = (await Promise.all([...app].filter((url) => url.endsWith('.js'))
      .map((url) => readFile(join(outdir, url.slice(1)), 'utf8')))).join('\n');
    const sprites = new Set([...code.matchAll(/["'`]([^"'`\s]*\/specimens-[^"'`\s]+\.svg)(?:#[^"'`\s]*)?["'`]/g)]
      .map(([, url]) => localURL(url)));
    assert.equal(sprites.size, 1, 'The compiled initial app must reference one fingerprinted specimen sprite');
    for (const sprite of sprites) {
      await assertFile(sprite, 'compiled app sprite');
      initial.add(sprite);
      const svg = await readFile(join(outdir, sprite.slice(1)), 'utf8');
      assert.match(svg, /<svg\b/);
      assert.match(svg, /\bid=["']/);
    }
    assert.deepEqual({
      missing: [...initial].filter((url) => !manifest.initialAssets.includes(url)),
      extra: manifest.initialAssets.filter((url) => !initial.has(url)),
    }, { missing: [], extra: [] },
      'The initial transfer list must match emitted HTML, static imports, CSS URLs, and the compiled sprite reference');
    const fonts = [...initial].filter((url) => url.endsWith('.woff2'));
    assert.ok(fonts.length > 0, 'Initial CSS must resolve to bundled fonts');
    for (const font of fonts) {
      assert.equal((await readFile(join(outdir, font.slice(1)))).subarray(0, 4).toString(), 'wOF2', font);
    }
  });

  test('all initial code, styles, fonts, and sprite filenames are fingerprinted', () => {
    for (const url of manifest.initialAssets) {
      if (url === '/favicon.ico' || url === '/manifest.webmanifest' || url.startsWith('/img/')) continue;
      assert.match(url, fingerprint, `Unfingerprinted initial asset: ${url}`);
      assert.ok(files.includes(url.slice(1)), `Fingerprint names a nonexistent output: ${url}`);
    }
  });

  test('legacy modules, styles, and fonts remain available without entering the startup manifest', async () => {
    for (const [directory, extension] of [['js', '.js'], ['css', '.css'], ['fonts', '.woff2']]) {
      for (const file of (await filesIn(join(ROOT, directory))).filter((file) => file.endsWith(extension) && file !== 'key.js')) {
        const path = `${directory}/${file}`;
        assert.deepEqual(await readFile(join(outdir, path)), await readFile(join(ROOT, path)), path);
        assert.ok(!manifest.initialAssets.includes(`/${path}`), `${path} enters the startup manifest`);
      }
    }
    for (const module of ['/js/card.js', '/js/sample-answers.js', '/js/locales/de.js', '/js/locales/fr.js', '/js/locales/es.js']) {
      const imports = reachable([module], graph, true);
      assert.ok(imports.size > 0);
      for (const url of imports) await assertFile(url, `legacy module ${module}`);
    }
    assert.deepEqual(await readFile(join(outdir, 'img/specimens.svg')), await readFile(join(ROOT, 'img/specimens.svg')));
  });

  test('the public output contains only browser compatibility files and no private files or dependencies', () => {
    for (const file of files) {
      const original = file.replace(/\.(?:br|gz)$/, '');
      assert.doesNotMatch(original, /(?:^|\/)(?:server|scripts|test|node_modules|data|\.git)(?:\/|$)/, file);
      assert.doesNotMatch(original, /(?:^|\/)(?:\.env(?:\..*)?|key\.js|package(?:-lock)?\.json|.*\.(?:pem|key|sqlite(?:3)?|db|map))$/, file);
      assert.ok(original.startsWith('assets/') || original.startsWith('img/') ||
        /^js\/(?!key\.js$)(?:[\w-]+\/)*[\w-]+\.js$/.test(original) ||
        /^css\/[\w-]+\.css$/.test(original) || /^fonts\/[\w-]+\.woff2$/.test(original) ||
        /^(?:index\.html|privacy\.html|impressum\.html|admin\.html|manifest\.webmanifest|sw\.js|favicon\.ico|robots\.txt|sitemap\.xml|build-manifest\.json)$/.test(original),
      `Unexpected published file: ${file}`);
    }
  });

  test('unchanged inputs produce identical asset names and bytes in separate builds', async (t) => {
    if (!sourcesUnchanged) {
      t.skip('Build inputs changed during the two builds; rerun after the other writers finish');
      return;
    }
    assert.deepEqual(await filesIn(second), files, 'Output filenames depend on the output directory or changed between builds');
    const firstHashes = new Map(await checksums(outdir, files));
    const changed = (await checksums(second, files)).filter(([file, hash]) => hash !== firstHashes.get(file)).map(([file]) => file);
    assert.deepEqual(changed, [], 'Output bytes changed for unchanged inputs');
  });

  test('prepared compression decodes to the exact public response bytes', async () => {
    const packed = files.filter((file) => /\.(?:br|gz)$/.test(file));
    assert.ok(packed.length > 0);
    for (const file of packed) {
      const original = file.replace(/\.(?:br|gz)$/, '');
      const bytes = await readFile(join(outdir, file));
      assert.deepEqual(file.endsWith('.br') ? brotliDecompressSync(bytes) : gunzipSync(bytes), await readFile(join(outdir, original)), file);
    }
  });
});
