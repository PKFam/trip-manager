// sw.js — tiny service worker: "network-first, cache as fallback".
//
// Goal 1: kill the update lag. Every load fetches the freshest files from the
//   network (bypassing the browser's 10-minute HTTP cache), so a new deploy
//   shows up the next time the app is opened — no ?query tricks.
// Goal 2: work offline. If the network is unreachable (mountain, plane, no
//   signal), serve the last-known-good copy from the cache instead of failing.

const CACHE = 'tripbudget-v1';
const CORE = [
  './',
  './index.html',
  './css/styles.css',
  './js/store.js',
  './js/currency.js',
  './js/app.js',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  self.skipWaiting(); // take over as soon as we're ready, don't wait for old tabs to close
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // drop any older cache buckets
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim(); // control already-open pages immediately
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only manage our own GET requests. Cross-origin calls (e.g. the weather API)
  // pass straight through untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      // cache:'reload' forces a real network hit, skipping the HTTP cache — this
      // is what defeats the 10-minute GitHub Pages cache.
      const fresh = await fetch(url.href, { cache: 'reload' });
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      // offline: fall back to the last good copy, or the app shell.
      const cached = await caches.match(req);
      return cached || (await caches.match('./index.html'));
    }
  })());
});
