// Sube este número en cada deploy para que los usuarios reciban la versión nueva
const CACHE_NAME = 'sismo-pa-v7';

const URLsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Instalación: cachea recursos estáticos y activa de inmediato
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(URLsToCache))
  );
  self.skipWaiting();
});

// Activación: limpia caches antiguas y toma control de las pestañas abiertas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Network First: intenta red, guarda copia, y si falla usa la caché
function networkFirst(request) {
  return fetch(request)
    .then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
      }
      return response;
    })
    .catch(() => caches.match(request, { ignoreSearch: false }));
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // APIs (USGS, EMSC) y archivos propios: siempre lo más reciente, caché como respaldo
  if (url.hostname === 'earthquake.usgs.gov' ||
      url.hostname === 'www.seismicportal.eu' || url.origin === self.location.origin) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Leaflet (CDN) y mosaicos del mapa: Cache First
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});
