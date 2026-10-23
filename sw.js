// Service Worker for Sparti PWA
// v7: purge all sparti-* caches on activate; skip script/style/document caching on localhost.
const CACHE_NAME = 'sparti-v7';
const STATIC_CACHE = 'sparti-static-v7';

/** Cache/network fallbacks must return a Response; undefined breaks respondWith (TypeError in console). */
function responseOrGatewayTimeout(maybe) {
  return maybe instanceof Response
    ? maybe
    : new Response('', { status: 504, statusText: 'Gateway Timeout' });
}

function isLocalDevHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

// Install event - skip waiting to activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll([
        '/manifest.json',
        '/brand/sparti/mark.png'
      ]).catch(err => {
        console.log('Cache addAll error:', err);
      });
    })
  );
});

// Activate event - claim clients and clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName.startsWith('sparti-')) {
              console.log('Deleting cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
    ])
  );
});

// Fetch event - network first for HTML/JS, cache first for images
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Never intercept API routes — they're proxied by Vite (dev) or hit the
  // OpenClaw wrapper directly (prod). Caching them as HTML breaks chat/SSE.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sparti/')) {
    return;
  }

  // Hashed build chunks: never intercept — use browser/CDN cache only (immutable filenames).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(fetch(request));
    return;
  }

  const skipDevCaching = isLocalDevHost(url.hostname);

  // Network-first strategy for HTML and JavaScript files
  if (request.destination === 'document' || 
      request.destination === 'script' ||
      request.destination === 'style' ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.html')) {
    if (skipDevCaching) {
      event.respondWith(fetch(request).then(responseOrGatewayTimeout));
      return;
    }
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => caches.match(request))
        .then(responseOrGatewayTimeout)
    );
    return;
  }

  // Cache-first strategy for images and static assets
  if (request.destination === 'image' || url.pathname.includes('/brand/sparti/') || url.pathname.includes('/lovable-uploads/')) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const responseToCache = response.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        });
      }).catch(() => responseOrGatewayTimeout(null))
    );
    return;
  }

  // Default: network-first for everything else
  event.respondWith(
    fetch(request)
      .catch(() => caches.match(request))
      .then(responseOrGatewayTimeout)
  );
});
