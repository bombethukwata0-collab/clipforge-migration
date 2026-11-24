const CACHE_NAME = 'clipforge-shell-v1';
const APP_SCOPE = self.registration.scope;
const APP_SHELL = [
  APP_SCOPE,
  new URL('manifest.json', APP_SCOPE).toString(),
  new URL('clipforge-icon.svg', APP_SCOPE).toString(),
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('clipforge-shell-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  if (['audio', 'video', 'track'].includes(request.destination)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(APP_SCOPE, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request)) || (await caches.match(APP_SCOPE)) || Response.error();
      }
    })());
    return;
  }

  if (['script', 'style', 'worker', 'font', 'image'].includes(request.destination)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      const network = fetch(request).then(async response => {
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      });
      return cached || network;
    })());
  }
});
