// Sube este número en cada deploy para que los usuarios reciban la versión nueva
const CACHE_NAME = 'sismo-pa-v12';

// Archivos propios: obligatorios
const URLsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/badge-96.png',
  '/data/placas.json',
  '/data/fallas.json'
];

// Externos: opcionales (si unpkg falla, el service worker se instala igual
// y los avisos siguen funcionando; el mapa los descargará después)
const URLsExternas = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Instalación: cachea recursos estáticos y activa de inmediato
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.all([
      cache.addAll(URLsToCache),
      ...URLsExternas.map(u => cache.add(u).catch(() => console.warn('No se pudo guardar', u)))
    ]))
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

// ============================================
// AVISOS (notificaciones push)
// ============================================
self.addEventListener('push', event => {
  let datos = {};
  try { datos = event.data ? event.data.json() : {}; } catch (e) {
    datos = { title: 'Sismo Panamá', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(datos.title || 'Sismo Panamá', {
      body: datos.body || 'Nuevo sismo cerca de ti',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',   // icono pequeño de la barra: blanco sobre transparente
      tag: datos.tag || 'sismo',
      renotify: true,
      vibrate: [300, 100, 300, 100, 300],
      data: { url: datos.url || '/' }
    })
  );
});

// Al tocar la notificación: abrir la app (o traerla al frente si ya está abierta)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destino = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ventanas => {
      for (const v of ventanas) {
        if (v.url.startsWith(self.location.origin) && 'focus' in v) {
          v.postMessage({ tipo: 'aviso-abierto' });
          return v.focus();
        }
      }
      return self.clients.openWindow(destino);
    })
  );
});
