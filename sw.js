// Receives chats shared to the installed app (see share_target in
// manifest.webmanifest), for example from WhatsApp's "Export chat". The files
// stay in this browser: they are parked in a cache for the page to pick up
// after the redirect, and the page deletes them once read. Nothing else is
// intercepted or cached.

const SHARED = 'judgeyou-shared';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share') event.respondWith(receive(event.request));
});

async function receive(request) {
  const form = await request.formData();
  await caches.delete(SHARED);
  const cache = await caches.open(SHARED);
  const files = form.getAll('files').filter((file) => file instanceof File);
  const text = form.get('text');
  // Some apps share a chat as text instead of a file.
  if (typeof text === 'string' && text.trim()) files.push(new File([text], 'shared.txt', { type: 'text/plain' }));
  await Promise.all(
    files.map((file, i) =>
      cache.put(
        `/shared/${i}`,
        new Response(file, { headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) } }),
      ),
    ),
  );
  return Response.redirect('/?shared', 303);
}
