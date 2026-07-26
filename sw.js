/* R2R Portfolio X-Ray — service worker
   Makes the app installable and fully usable offline.

   Caching strategy:
   - App shell (index.html, icons, manifest): stale-while-revalidate
       -> opens instantly, and picks up a new deploy on the *next* launch.
   - CDN libraries + Google Fonts: cache-first (versioned/immutable URLs).
   - coverage.csv: network-first, falling back to the last cached copy
       -> online = freshest research coverage; offline = last-known coverage.

   To force every client to re-fetch the shell immediately after a deploy,
   bump CACHE_VERSION below (e.g. 'v1' -> 'v2'). Otherwise updates apply on
   the second launch automatically. */

const CACHE_VERSION = 'v1';
const SHELL_CACHE   = 'r2r-xray-shell-' + CACHE_VERSION;
const RUNTIME_CACHE = 'r2r-xray-runtime-' + CACHE_VERSION;
const COVERAGE_KEY  = 'coverage.csv'; // normalized key (ignores the ?v= cache-buster)

// Same-origin files to precache (must all succeed for install).
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

// Cross-origin libraries — best-effort precache (one CDN blip won't break install).
const VENDOR = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500;700&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(CORE);
    // best-effort vendor precache
    await Promise.allSettled(
      VENDOR.map(async (url) => {
        try {
          const res = await fetch(url, { mode: 'cors', cache: 'reload' });
          if (res && (res.ok || res.type === 'opaque')) await shell.put(url, res.clone());
        } catch (_) { /* ignore — runtime cache will catch it later */ }
      })
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isCoverage(url) {
  return url.origin === self.location.origin && url.pathname.replace(/\/+$/,'').endsWith('/coverage.csv');
}
function isVendor(url) {
  return url.hostname === 'cdn.jsdelivr.net' ||
         url.hostname === 'fonts.googleapis.com' ||
         url.hostname === 'fonts.gstatic.com';
}
function isShellNav(req, url) {
  return req.mode === 'navigate' ||
         (url.origin === self.location.origin &&
          (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 1) coverage.csv — network-first, fall back to last cached copy
  if (isCoverage(url)) {
    event.respondWith((async () => {
      const runtime = await caches.open(RUNTIME_CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) runtime.put(COVERAGE_KEY, fresh.clone());
        return fresh;
      } catch (_) {
        const cached = await runtime.match(COVERAGE_KEY);
        if (cached) return cached;
        return new Response('', { status: 504, statusText: 'offline, no cached coverage' });
      }
    })());
    return;
  }

  // 2) App shell / navigations — stale-while-revalidate
  if (isShellNav(req, url)) {
    event.respondWith((async () => {
      const shell = await caches.open(SHELL_CACHE);
      const cached = await shell.match('./index.html') || await shell.match(req);
      const network = fetch(req).then(res => {
        if (res && res.ok) shell.put('./index.html', res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) ||
             new Response('<h1>Offline</h1><p>Open this app once while online to enable offline use.</p>',
                          { headers: { 'Content-Type': 'text/html' } });
    })());
    return;
  }

  // 3) Vendor libs + fonts — cache-first (stale-while-revalidate)
  if (isVendor(url)) {
    event.respondWith((async () => {
      const runtime = await caches.open(RUNTIME_CACHE);
      const cached = await runtime.match(req);
      const network = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) runtime.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) ||
             new Response('', { status: 504, statusText: 'offline vendor asset' });
    })());
    return;
  }

  // 4) Everything else same-origin — cache-first, then network
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const shell = await caches.open(SHELL_CACHE);
      const cached = await shell.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        return res;
      } catch (_) {
        return new Response('', { status: 504 });
      }
    })());
  }
});
