import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function adminAuthorized(req, token) {
  if (!token) return false;
  const actual = createHash('sha256').update(req.headers.authorization ?? '').digest();
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return timingSafeEqual(actual, expected);
}

export async function serveAdmin(res) {
  const html = await readFile(new URL('admin.html', import.meta.url));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(html);
}
