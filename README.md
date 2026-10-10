# Sismo Panamá

PWA en Vanilla JS para ver los sismos recientes en Panamá y sus alrededores, con mapa (Leaflet + OpenStreetMap) y lista de los últimos eventos.

## Funciones

- Mapa con los sismos de **M 2.5+ de los últimos 7 días** en la región de Panamá (lat 6 a 10.5, lon -84 a -76).
- Lista de los 10 sismos más recientes.
- Actualización automática cada 60 segundos.
- Modo offline: muestra la última información guardada si no hay conexión.
- Botón para registrar la intensidad sentida. **Por ahora el reporte se guarda solo en el dispositivo** (`localStorage`).
- Accesos directos a emergencias: 911 y SINAPROC (103).

## Estructura

```
sismo-panama/
├── index.html
├── manifest.json
├── sw.js          (Service Worker)
├── style.css
├── app.js
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

## Fuente de datos

USGS Earthquake Catalog (FDSN Event Web Service):
`https://earthquake.usgs.gov/fdsnws/event/1/query`

Para cambiar la región, los días o la magnitud mínima, edita `REGION`, `DIAS_ATRAS` y `MAG_MINIMA` al inicio de `app.js`.

## Deploy (Vercel)

No requiere build. Sube la carpeta al repositorio y Vercel la sirve como sitio estático.

**Importante:** en cada actualización sube la versión de `CACHE_NAME` en `sw.js` (`sismo-pa-v2` → `sismo-pa-v3`, etc.).

## Pendientes

- Backend (p. ej. Supabase) para compartir los reportes de intensidad entre usuarios.
- Notificaciones push.
- Ícono `maskable` para Android.
