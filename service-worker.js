const CACHE_NAME = 'hydration-reminder-v6';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/water-drop.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './idol-original.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/gallery') || url.pathname.startsWith('/media/')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && !response.redirected) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});

self.addEventListener('push', (event) => {
  const fallback = { title: '喝水~', body: '休息一下，喝口水吧 ♡', url: './?from=push' };
  let message = fallback;
  try { message = { ...fallback, ...event.data.json() }; } catch {}

  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    icon: 'icons/water-drop.svg',
    badge: 'icons/water-drop.svg',
    tag: 'hydration-reminder',
    renotify: false,
    data: { url: message.url }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.href).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const opened = clients.find((client) => client.url.startsWith(self.registration.scope));
      return opened ? opened.focus() : self.clients.openWindow(target);
    })
  );
});
