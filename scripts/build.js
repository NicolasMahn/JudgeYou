import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCUMENTS = ['index.html', 'privacy.html', 'impressum.html'];
const FILES = ['manifest.webmanifest', 'sw.js', 'favicon.ico', 'robots.txt', 'sitemap.xml'];

/** Build an independent public directory; source files stay useful without a build. */
export async function buildSite({ outdir = join(ROOT, 'dist') } = {}) {
  outdir = resolve(outdir);
  if (outdir === ROOT || ROOT.startsWith(`${outdir}/`)) throw new Error('The output directory must not contain the source tree.');
  await rm(outdir, { recursive: true, force: true });
  const assets = join(outdir, 'assets');
  await mkdir(assets, { recursive: true });

  let sprite;
  try {
    const bytes = await readFile(join(ROOT, 'img/specimens.svg'));
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    sprite = `/assets/specimens-${hash}.svg`;
    await writeFile(join(outdir, sprite.slice(1)), bytes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: { app: 'js/app.js', admin: 'js/admin.js', privacy: 'js/privacy.js', site: 'css/site.css', 'admin-site': 'css/admin-site.css' },
    outdir: assets,
    entryNames: '[name]-[hash]',
    chunkNames: 'chunk-[hash]',
    assetNames: '[name]-[hash]',
    publicPath: '/assets',
    bundle: true,
    splitting: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    charset: 'utf8',
    metafile: true,
    loader: { '.woff2': 'file' },
    define: sprite ? { __SPECIMEN_SPRITE__: JSON.stringify(sprite) } : {},
    logLevel: 'warning',
  });
  const outputs = result.metafile.outputs;
  const url = (path) => `/${relative(outdir, resolve(ROOT, path)).split('\\').join('/')}`;
  const entries = Object.fromEntries(Object.entries(outputs).filter(([, info]) => info.entryPoint).map(([path, info]) => [info.entryPoint, path]));
  const entry = (source) => {
    const path = entries[source];
    if (!path) throw new Error(`Missing build entry: ${source}`);
    return url(path);
  };
  const dependencies = (source, seen = new Set()) => {
    if (seen.has(source)) return seen;
    seen.add(source);
    for (const imported of outputs[source]?.imports ?? []) {
      if (!imported.external && imported.kind !== 'dynamic-import') dependencies(imported.path, seen);
    }
    return seen;
  };
  const appDependencies = dependencies(entries['js/app.js']);
  const preload = [...appDependencies].filter((path) => path !== entries['js/app.js'] && path.endsWith('.js'))
    .map((path) => `    <link rel="modulepreload" href="${url(path)}" />`).join('\n');

  const document = (html, admin = false) => html
    .replace(/^\s*<link rel="stylesheet"[^>]+href="\/?css\/[^\"]+"[^>]*>\s*$/gm, '')
    .replace(/src="\/?js\/(app|admin|privacy)\.js"/, (_, name) => `src="${entry(`js/${name}.js`)}"`)
    .replace('</head>', `    <link rel="stylesheet" href="${entry(admin ? 'css/admin-site.css' : 'css/site.css')}" />\n${admin ? '' : preload}\n  </head>`);

  await Promise.all([
    ...DOCUMENTS.map(async (file) => writeFile(join(outdir, file), document(await readFile(join(ROOT, file), 'utf8')))),
    ...FILES.map((file) => cp(join(ROOT, file), join(outdir, file))),
    cp(join(ROOT, 'img'), join(outdir, 'img'), { recursive: true, filter: (path) => path !== join(ROOT, 'img/specimens.svg') }),
    readFile(join(ROOT, 'server/admin.html'), 'utf8').then((html) => writeFile(join(outdir, 'admin.html'), document(html, true))),
  ]);

  // The benchmark reads the actual static import graph, including CSS font URLs.
  // Lazy modules and full-size result mascots are fetched only when used.
  const initial = new Set([...appDependencies, ...dependencies(entries['css/site.css'])].map(url));
  for (const file of ['/favicon.ico', '/img/favicon-96.png', '/img/apple-touch-icon.png', '/manifest.webmanifest']) initial.add(file);
  if (sprite) initial.add(sprite);
  else {
    const { readdir } = await import('node:fs/promises');
    for (const file of await readdir(join(ROOT, 'img/types'))) if (file.endsWith('.webp')) initial.add(`/img/types/${file}`);
  }
  const manifest = { initialAssets: [...initial].sort(), entries: Object.fromEntries(Object.entries(entries).map(([source, path]) => [source, url(path)])) };
  await writeFile(join(outdir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Compression belongs in the build, so the first visitor does no compression work.
  const compressed = [...DOCUMENTS, 'admin.html', 'sw.js', 'manifest.webmanifest', 'robots.txt', 'sitemap.xml',
    ...(await readdir(assets)).filter((file) => /\.(?:js|css|svg)$/.test(file)).map((file) => `assets/${file}`)];
  for (const file of compressed) {
    const bytes = await readFile(join(outdir, file));
    await Promise.all([
      promisify(brotliCompress)(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }).then((bytes) => writeFile(join(outdir, `${file}.br`), bytes)),
      promisify(gzip)(bytes, { level: 9 }).then((bytes) => writeFile(join(outdir, `${file}.gz`), bytes)),
    ]);
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildSite();
  console.log(`Built ${result.initialAssets.length + 1} initial resources in dist/`);
}
