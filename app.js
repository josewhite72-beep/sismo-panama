// ============================================
// REGISTRO DEL SERVICE WORKER
// ============================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(() => console.log('SW registrado'))
    .catch(err => console.error('SW error:', err));
}

// ============================================
// CONFIGURACIÓN DEL MAPA (Leaflet)
// ============================================
// Si Leaflet no cargó (sin internet la primera vez, o unpkg caído),
// la app sigue funcionando sin mapa: lista, actualización y avisos.
const hayMapa = typeof L !== 'undefined';
let mapa = null;
let capaSismos = { clearLayers() {} };

if (hayMapa) {
  mapa = L.map('mapa').setView([8.5379, -80.7821], 6); // Centro en Panamá
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 18
  }).addTo(mapa);
  // Capa propia para los sismos (más fácil de limpiar en cada refresco)
  capaSismos = L.layerGroup().addTo(mapa);
} else {
  const div = document.getElementById('mapa');
  if (div) {
    div.style.height = 'auto';
    div.innerHTML = '<p style="padding:1rem;text-align:center">🗺️ El mapa no pudo cargar (sin conexión). La lista sigue actualizándose.</p>';
  }
}

// ============================================
// CONSUMIR API DE USGS (solo región de Panamá)
// ============================================
// Los feeds "summary" ignoran filtros geográficos, por eso se usa
// el endpoint de consulta FDSN con un rectángulo alrededor de Panamá.
const REGION = {
  minlatitude: 6,
  maxlatitude: 10.5,
  minlongitude: -84,
  maxlongitude: -76
};
const DIAS_ATRAS = 7;
const MAG_MINIMA = 2.5;

function fechaInicio() {
  const inicio = new Date(Date.now() - DIAS_ATRAS * 24 * 60 * 60 * 1000);
  // Redondear a la hora para que la URL se repita y el SW pueda usar la caché offline
  inicio.setUTCMinutes(0, 0, 0);
  return inicio.toISOString().slice(0, 19);
}

// USGS: buena información, pero fuera de EE. UU. suele publicar solo M4+ y con retraso
function urlUSGS() {
  const params = new URLSearchParams({
    format: 'geojson',
    ...REGION,
    minmagnitude: MAG_MINIMA,
    starttime: fechaInicio(),
    orderby: 'time'
  });
  return `https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`;
}

// EMSC (Centro Sismológico Euro-Mediterráneo): recoge agencias regionales,
// publica sismos más pequeños y mucho más rápido para Centroamérica
function urlEMSC() {
  const params = new URLSearchParams({
    format: 'json',
    ...REGION,
    minmagnitude: MAG_MINIMA,
    starttime: fechaInicio(),
    orderby: 'time',
    limit: 500
  });
  return `https://www.seismicportal.eu/fdsnws/event/1/query?${params}`;
}

async function pedirJSON(url) {
  // no-store: nunca usar una respuesta vieja guardada por el navegador
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Convierte cada fuente a un formato común
function normalizarUSGS(data) {
  return (data.features || []).map(f => ({
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    depth: f.geometry.coordinates[2] ?? 0,
    mag: f.properties.mag ?? 0,
    lugarOriginal: f.properties.place || '',
    time: f.properties.time,
    fuente: 'USGS'
  }));
}

function normalizarEMSC(data) {
  return (data.features || []).map(f => {
    const p = f.properties;
    return {
      lat: p.lat,
      lng: p.lon,
      depth: p.depth ?? 0,
      mag: p.mag ?? 0,
      lugarOriginal: p.flynn_region || '',
      time: new Date(p.time).getTime(),
      fuente: 'EMSC',
      id: p.unid
    };
  });
}

// IGC-UP (Panamá) e INETER (Nicaragua) vía nuestra función en Vercel
const URL_REGIONALES = '/api/regionales';

function normalizarRegionales(data) {
  return (data.sismos || []).map(s => ({ ...s, lugarOriginal: '' }));
}

// Une las listas sin repetir el mismo sismo (±90 s y a menos de ~50 km).
// Las listas van en orden de prioridad: si un sismo está en varias, gana la primera.
function unirSismos(...listas) {
  const resultado = [];
  listas.forEach(lista => {
    lista.forEach(e => {
      const repetido = resultado.some(u =>
        Math.abs(u.time - e.time) < 90 * 1000 &&
        Math.abs(u.lat - e.lat) < 0.5 &&
        Math.abs(u.lng - e.lng) < 0.5
      );
      if (!repetido) resultado.push(e);
    });
  });
  return resultado.sort((a, b) => b.time - a.time);
}

// El IGC trae su propia descripción en español; para las demás se calcula
function ubicacionDe(s) {
  return s.lugar || describirUbicacion(s.lat, s.lng);
}

function etiquetaFuente(s) {
  return s.estado ? `${s.fuente} (${s.estado.toLowerCase()})` : s.fuente;
}

// ============================================
// UBICACIÓN LEGIBLE: "12 km al SO de Tebario, Veraguas"
// ============================================
// Poblados de referencia [nombre, provincia/país, lat, lng].
// Coordenadas aproximadas; se pueden agregar más poblados aquí.
const POBLADOS = [
  // Panamá y Panamá Oeste
  ['Ciudad de Panamá', 'Panamá', 8.983, -79.517],
  ['San Miguelito', 'Panamá', 9.033, -79.500],
  ['Chepo', 'Panamá', 9.170, -79.100],
  ['Isla Contadora', 'Panamá', 8.627, -79.035],
  ['San Miguel (Isla del Rey)', 'Panamá', 8.455, -78.935],
  ['La Chorrera', 'Panamá Oeste', 8.880, -79.783],
  ['Arraiján', 'Panamá Oeste', 8.950, -79.650],
  ['Chame', 'Panamá Oeste', 8.583, -79.883],
  // Colón y Guna Yala
  ['Colón', 'Colón', 9.359, -79.901],
  ['Portobelo', 'Colón', 9.551, -79.651],
  ['Nombre de Dios', 'Colón', 9.583, -79.475],
  ['El Porvenir', 'Guna Yala', 9.558, -78.950],
  ['Puerto Obaldía', 'Guna Yala', 8.666, -77.420],
  // Darién
  ['La Palma', 'Darién', 8.400, -78.150],
  ['Metetí', 'Darién', 8.500, -77.983],
  ['Yaviza', 'Darién', 8.157, -77.692],
  ['El Real de Santa María', 'Darién', 8.130, -77.720],
  ['Garachiné', 'Darién', 8.067, -78.367],
  ['Jaqué', 'Darién', 7.519, -78.166],
  // Coclé
  ['Penonomé', 'Coclé', 8.519, -80.357],
  ['Aguadulce', 'Coclé', 8.241, -80.546],
  ['Antón', 'Coclé', 8.398, -80.262],
  // Herrera
  ['Chitré', 'Herrera', 7.961, -80.430],
  ['Parita', 'Herrera', 8.000, -80.517],
  ['Pesé', 'Herrera', 7.906, -80.617],
  ['Ocú', 'Herrera', 7.950, -80.783],
  ['Las Minas', 'Herrera', 7.800, -80.700],
  // Los Santos
  ['La Villa de Los Santos', 'Los Santos', 7.933, -80.415],
  ['Las Tablas', 'Los Santos', 7.766, -80.274],
  ['Macaracas', 'Los Santos', 7.733, -80.550],
  ['Pedasí', 'Los Santos', 7.530, -80.025],
  ['Tonosí', 'Los Santos', 7.400, -80.450],
  ['Cambutal', 'Los Santos', 7.270, -80.480],
  // Veraguas
  ['Santiago', 'Veraguas', 8.100, -80.983],
  ['Atalaya', 'Veraguas', 8.044, -80.926],
  ['Montijo', 'Veraguas', 7.990, -81.060],
  ['Río de Jesús', 'Veraguas', 7.983, -81.167],
  ['Soná', 'Veraguas', 8.008, -81.320],
  ['Calobre', 'Veraguas', 8.318, -80.841],
  ['Santa Fe', 'Veraguas', 8.509, -81.078],
  ['Mariato', 'Veraguas', 7.660, -80.990],
  ['Isla de Coiba', 'Veraguas', 7.450, -81.750],
  // Chiriquí y Comarca Ngäbe-Buglé
  ['David', 'Chiriquí', 8.427, -82.430],
  ['Boquete', 'Chiriquí', 8.778, -82.441],
  ['Volcán', 'Chiriquí', 8.770, -82.640],
  ['Puerto Armuelles', 'Chiriquí', 8.283, -82.867],
  ['Boca Chica', 'Chiriquí', 8.217, -82.217],
  ['Tolé', 'Chiriquí', 8.240, -81.680],
  ['San Félix', 'Chiriquí', 8.283, -81.870],
  // Bocas del Toro
  ['Bocas del Toro', 'Bocas del Toro', 9.340, -82.242],
  ['Changuinola', 'Bocas del Toro', 9.430, -82.517],
  ['Almirante', 'Bocas del Toro', 9.300, -82.400],
  ['Chiriquí Grande', 'Bocas del Toro', 8.950, -82.120],
  // Costa Rica (zona fronteriza)
  ['San José', 'Costa Rica', 9.933, -84.083],
  ['Quepos', 'Costa Rica', 9.430, -84.160],
  ['Dominical', 'Costa Rica', 9.250, -83.860],
  ['San Isidro de El General', 'Costa Rica', 9.373, -83.700],
  ['Palmar Norte', 'Costa Rica', 8.958, -83.461],
  ['Golfito', 'Costa Rica', 8.640, -83.183],
  ['Puerto Jiménez', 'Costa Rica', 8.533, -83.300],
  ['Ciudad Neily', 'Costa Rica', 8.650, -82.933],
  ['San Vito', 'Costa Rica', 8.820, -82.970],
  ['Limón', 'Costa Rica', 9.990, -83.030],
  ['Sixaola', 'Costa Rica', 9.522, -82.620],
  // Colombia (zona fronteriza)
  ['Acandí', 'Colombia', 8.512, -77.278],
  ['Juradó', 'Colombia', 7.105, -77.763],
  ['Bahía Solano', 'Colombia', 6.223, -77.408],
  ['Turbo', 'Colombia', 8.093, -76.728]
];

const RUMBOS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

const rad = g => g * Math.PI / 180;

function distanciaKm(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Rumbo desde el poblado hacia el sismo
function rumbo(lat1, lng1, lat2, lng2) {
  const y = Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
            Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
  const grados = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return RUMBOS[Math.round(grados / 22.5) % 16];
}

function describirUbicacion(lat, lng) {
  let cercano = null;
  let minKm = Infinity;
  POBLADOS.forEach(p => {
    const d = distanciaKm(p[2], p[3], lat, lng);
    if (d < minKm) { minKm = d; cercano = p; }
  });
  if (!cercano) return 'Panamá';
  const [nombre, zona] = cercano;
  if (minKm < 3) return `Cerca de ${nombre}, ${zona}`;
  return `${Math.round(minKm)} km al ${rumbo(cercano[2], cercano[3], lat, lng)} de ${nombre}, ${zona}`;
}

function haceCuanto(time) {
  const min = Math.round((Date.now() - time) / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return `hace ${d} día${d > 1 ? 's' : ''}`;
}

// Evita que textos de la API se interpreten como HTML
function escaparHTML(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Sismos recibidos en vivo por EMSC que quizá aún no salen en la consulta normal
const sismosEnVivo = new Map();
let cargando = false;
let ultimaCarga = 0;

// ============================================
// VISTA: cuántos sismos mostrar en mapa y lista
// ============================================
let ultimosSismos = [];
const CLAVE_CANTIDAD = 'cantidad-visible';

function cantidadElegida() {
  let v = null;
  try { v = localStorage.getItem(CLAVE_CANTIDAD); } catch (e) {}
  return v || '10';
}

// encuadrar = true solo cuando el usuario cambia el selector (no en cada refresco)
function pintarSismos(encuadrar) {
  const elegida = cantidadElegida();
  const visibles = elegida === 'todos' ? ultimosSismos : ultimosSismos.slice(0, Number(elegida));

  capaSismos.clearLayers();
  if (hayMapa) {
    // Del más viejo al más nuevo para que el más reciente quede encima
    [...visibles].reverse().forEach((s, i, arr) => {
      const esUltimo = i === arr.length - 1;
      const popup = `
        <strong>M ${s.mag.toFixed(1)}</strong><br>
        ${escaparHTML(ubicacionDe(s))}<br>
        Profundidad: ${s.depth.toFixed(1)} km<br>
        ${new Date(s.time).toLocaleString('es-PA')} (${haceCuanto(s.time)})<br>
        <small>Fuente: ${escaparHTML(etiquetaFuente(s))}${s.lugarOriginal ? ' · ' + escaparHTML(s.lugarOriginal) : ''}</small>
      `;
      if (esUltimo) {
        // Anillo que marca el sismo más reciente
        L.circleMarker([s.lat, s.lng], {
          radius: Math.max(s.mag, 1) * 2.5 + 7, color: '#dc2626', weight: 3, fill: false, className: 'anillo-reciente'
        }).bindPopup(popup).addTo(capaSismos);
      }
      L.circleMarker([s.lat, s.lng], {
        radius: Math.max(s.mag, 1) * 2.5,
        fillColor: obtenerColor(s.mag),
        color: '#000',
        weight: 1,
        fillOpacity: visibles.length > 25 ? 0.5 : 0.75
      }).bindPopup(popup).addTo(capaSismos);
    });

    if (encuadrar && visibles.length) {
      const limites = L.latLngBounds(visibles.map(s => [s.lat, s.lng]));
      mapa.fitBounds(limites, { padding: [30, 30], maxZoom: 9 });
    }
  }

  renderizarLista(visibles, ultimosSismos.length);

  document.querySelectorAll('.selector-cantidad button').forEach(b => {
    b.classList.toggle('activo', b.dataset.cantidad === elegida);
    b.setAttribute('aria-pressed', b.dataset.cantidad === elegida);
  });
}

document.querySelectorAll('.selector-cantidad button').forEach(b => {
  b.addEventListener('click', () => {
    try { localStorage.setItem(CLAVE_CANTIDAD, b.dataset.cantidad); } catch (e) {}
    pintarSismos(true);
  });
});

async function cargarSismos() {
  if (cargando) return;            // evita dos cargas al mismo tiempo
  cargando = true;
  const estado = document.getElementById('ultima-actualizacion');
  const boton = document.getElementById('btn-actualizar');
  boton?.classList.add('girando');
  if (boton) boton.disabled = true;
  try {
    // Se piden las dos fuentes a la vez; si una falla, se usa la otra
    const [rIGC, rUSGS, rEMSC] = await Promise.allSettled([
      pedirJSON(URL_REGIONALES),
      pedirJSON(urlUSGS()),
      pedirJSON(urlEMSC())
    ]);
    // La función responde aunque una agencia falle; se revisa cuál trajo datos
    const fuentesReg = rIGC.status === 'fulfilled' ? (rIGC.value.fuentes || {}) : {};
    const igcOk = !!fuentesReg.igc?.ok;
    const ineterOk = !!fuentesReg.ineter?.ok;
    const regionalOk = igcOk || ineterOk;
    if (!regionalOk && rUSGS.status === 'rejected' && rEMSC.status === 'rejected') {
      throw new Error('Ninguna fuente respondió');
    }
    if (!igcOk) console.warn('IGC-UP falló:', rIGC.reason || fuentesReg.igc);
    if (!ineterOk) console.warn('INETER falló:', rIGC.reason || fuentesReg.ineter);
    if (rUSGS.status === 'rejected') console.warn('USGS falló:', rUSGS.reason);
    if (rEMSC.status === 'rejected') console.warn('EMSC falló:', rEMSC.reason);

    const listaEMSC = rEMSC.status === 'fulfilled' ? normalizarEMSC(rEMSC.value) : [];
    const idsEMSC = new Set(listaEMSC.map(s => s.id));
    sismosEnVivo.forEach((s, id) => {
      if (idsEMSC.has(id)) sismosEnVivo.delete(id);   // ya llegó por la consulta normal
      else listaEMSC.push(s);
    });

    // Viene en orden de prioridad: IGC-UP primero, luego INETER
    const listaIGC = regionalOk
      ? normalizarRegionales(rIGC.value).filter(s => s.mag >= MAG_MINIMA)
      : [];

    const sismos = unirSismos(
      listaIGC,
      rUSGS.status === 'fulfilled' ? normalizarUSGS(rUSGS.value) : [],
      listaEMSC
    );

    ultimosSismos = sismos;
    pintarSismos(false);

    const fuentes = [
      igcOk ? 'IGC-UP' : null,
      ineterOk ? 'INETER' : null,
      rUSGS.status === 'fulfilled' ? 'USGS' : null,
      rEMSC.status === 'fulfilled' ? 'EMSC' : null
    ].filter(Boolean).join(' + ');
    ultimaCarga = Date.now();
    const enVivo = wsConectado ? ' · 🟢 en vivo' : '';
    estado.textContent = `Actualizado: ${new Date().toLocaleTimeString('es-PA')} · ${fuentes}${enVivo}`;
  } catch (error) {
    console.error('Error cargando sismos:', error);
    estado.textContent = '⚠️ Sin conexión. Mostrando datos en caché si existen.';
  } finally {
    cargando = false;
    boton?.classList.remove('girando');
    if (boton) boton.disabled = false;
  }
}

// ============================================
// AVISOS EN VIVO (WebSocket de EMSC)
// ============================================
// EMSC envía cada sismo nuevo apenas lo registra, sin esperar al siguiente refresco.
let wsConectado = false;
let ws = null;

function conectarEnVivo() {
  if (!('WebSocket' in window)) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket('wss://www.seismicportal.eu/standing_order/websocket');
  } catch (e) {
    return;
  }

  ws.onopen = () => { wsConectado = true; };

  ws.onmessage = (evento) => {
    try {
      const msg = JSON.parse(evento.data);
      const p = msg.data && msg.data.properties;
      if (!p) return;
      const dentro = p.lat >= REGION.minlatitude && p.lat <= REGION.maxlatitude &&
                     p.lon >= REGION.minlongitude && p.lon <= REGION.maxlongitude;
      if (!dentro || (p.mag ?? 0) < MAG_MINIMA) return;

      sismosEnVivo.set(p.unid, normalizarEMSC({ features: [msg.data] })[0]);
      cargarSismos();
    } catch (e) {
      console.warn('Mensaje en vivo no válido', e);
    }
  };

  ws.onclose = () => {
    wsConectado = false;
    ws = null;
    // Reintentar en 30 s si la app está visible
    setTimeout(() => { if (!document.hidden) conectarEnVivo(); }, 30000);
  };

  ws.onerror = () => ws && ws.close();
}

function obtenerColor(magnitud) {
  if (magnitud >= 6) return '#dc2626';  // Rojo
  if (magnitud >= 5) return '#ea580c';  // Naranja
  if (magnitud >= 4) return '#ca8a04';  // Amarillo oscuro
  return '#65a30d';                      // Verde
}

function renderizarLista(sismos, total = sismos.length) {
  const resumen = document.getElementById('resumen-lista');
  if (resumen) resumen.textContent = total
    ? `Mostrando ${sismos.length} de ${total} sismos de los últimos ${DIAS_ATRAS} días`
    : '';
  const lista = document.getElementById('sismos-lista');

  if (sismos.length === 0) {
    lista.innerHTML = `<li class="sismo-item">Sin sismos de M ${MAG_MINIMA}+ en Panamá en los últimos ${DIAS_ATRAS} días.</li>`;
    return;
  }

  lista.innerHTML = sismos.map(s => `
      <li class="sismo-item">
        <span class="magnitud" style="background:${obtenerColor(s.mag)}">M ${s.mag.toFixed(1)}</span>
        <div class="info">
          <strong>${escaparHTML(ubicacionDe(s))}</strong>
          <small>${haceCuanto(s.time)} · ${new Date(s.time).toLocaleString('es-PA')} · ${s.depth.toFixed(0)} km prof. · ${escaparHTML(etiquetaFuente(s))}</small>
        </div>
      </li>
    `).join('');
}

// ============================================
// REPORTE DE INTENSIDAD (guardado solo en este dispositivo)
// ============================================
document.getElementById('btn-reportar').addEventListener('click', () => {
  if (!navigator.geolocation) {
    alert('Tu navegador no soporta geolocalización');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const respuesta = prompt('Del 1 al 5, ¿qué tan fuerte lo sentiste?\n1: No lo sentí\n5: Muy fuerte, objetos cayeron');
      if (respuesta === null) return;

      const intensidad = parseInt(respuesta, 10);
      if (!Number.isInteger(intensidad) || intensidad < 1 || intensidad > 5) {
        alert('Escribe un número del 1 al 5.');
        return;
      }

      const reporte = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        intensidad,
        timestamp: Date.now()
      };

      // Por ahora se guarda solo en este teléfono (más adelante: Supabase / backend)
      let reportes = [];
      try { reportes = JSON.parse(localStorage.getItem('reportes') || '[]'); } catch (e) {}
      reportes.push(reporte);
      localStorage.setItem('reportes', JSON.stringify(reportes));

      alert('¡Gracias! Tu reporte quedó guardado en este dispositivo.');
    },
    (err) => {
      alert('No se pudo obtener tu ubicación: ' + err.message);
    },
    { enableHighAccuracy: false, timeout: 15000 }
  );
});

// ============================================
// AVISOS DE SISMOS CERCANOS (notificaciones push)
// ============================================
const Avisos = (() => {
  const CLAVE = 'avisos-config';
  const $ = (id) => document.getElementById(id);
  const soportado = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function leerConfig() {
    try { return JSON.parse(localStorage.getItem(CLAVE)) || {}; } catch (e) { return {}; }
  }
  function guardarConfig(c) {
    try { localStorage.setItem(CLAVE, JSON.stringify(c)); } catch (e) {}
  }

  function mostrar(texto, error = false) {
    const p = $('avisos-estado');
    if (!p) return;
    p.textContent = texto;
    p.classList.toggle('error', error);
  }

  function pintar(activo) {
    const b = $('btn-avisos');
    if (!b) return;
    b.textContent = activo ? 'Desactivar avisos' : 'Activar avisos';
    b.classList.toggle('activo', activo);
    $('acciones-avisos').hidden = !activo;
  }

  // Llave pública VAPID (base64url) → bytes
  function aBytes(base64) {
    const relleno = '='.repeat((4 - base64.length % 4) % 4);
    const b64 = (base64 + relleno).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  const mismaLlave = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  function ubicacion() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Tu navegador no permite obtener la ubicación'));
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        e => reject(new Error(e.code === 1 ? 'Permiso de ubicación denegado' : 'No se pudo obtener tu ubicación')),
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 10 * 60 * 1000 }
      );
    });
  }

  async function api(ruta, metodo = 'GET', cuerpo) {
    const r = await fetch(ruta, {
      method: metodo,
      cache: 'no-store',
      headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }

  const ajustes = () => ({
    radio: Number($('aviso-radio').value),
    magMin: Number($('aviso-mag').value)
  });

  // Espera al service worker, pero no para siempre (si no se instaló, avisa)
  function swListo(ms = 10000) {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error(
        'La app aún no terminó de instalarse. Recarga la página con internet y vuelve a intentar.')), ms))
    ]);
  }

  async function suscripcionActual() {
    const reg = await swListo();
    return reg.pushManager.getSubscription();
  }

  async function registrar(sub, pos) {
    await api('/api/suscribir', 'POST', { subscription: sub.toJSON(), lat: pos.lat, lng: pos.lng, ...ajustes() });
    guardarConfig({ activo: true, ...ajustes(), lat: pos.lat, lng: pos.lng });
  }

  function textoActivo(extra = '') {
    const { radio, magMin } = ajustes();
    return `✅ Avisos activos: sismos de M ${magMin.toFixed(1)} o más a menos de ${radio} km de ti.${extra}`;
  }

  async function activar() {
    const b = $('btn-avisos');
    b.disabled = true;
    try {
      mostrar('Pidiendo permiso para notificaciones…');
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        throw new Error('No diste permiso para notificaciones. Actívalo en los ajustes de Chrome para este sitio.');
      }

      mostrar('Obteniendo tu ubicación…');
      const pos = await ubicacion();

      mostrar('Conectando con el servidor de avisos…');
      const { vapidPublicKey } = await api('/api/config');
      const reg = await swListo();
      const llave = aBytes(vapidPublicKey);
      let sub = await reg.pushManager.getSubscription();
      // Si había una suscripción hecha con otra llave, se renueva
      const llaveVieja = sub?.options?.applicationServerKey;
      if (sub && llaveVieja && !mismaLlave(new Uint8Array(llaveVieja), llave)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: llave });

      await registrar(sub, pos);
      pintar(true);
      mostrar(textoActivo(' Toca "Enviar prueba" para comprobarlo.'));
    } catch (e) {
      console.error(e);
      mostrar('⚠️ ' + e.message, true);
    } finally {
      b.disabled = false;
    }
  }

  async function desactivar() {
    const b = $('btn-avisos');
    b.disabled = true;
    try {
      const sub = await suscripcionActual();
      if (sub) {
        await api('/api/suscribir', 'DELETE', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      guardarConfig({ ...leerConfig(), activo: false });
      pintar(false);
      mostrar('Avisos desactivados.');
    } catch (e) {
      mostrar('⚠️ ' + e.message, true);
    } finally {
      b.disabled = false;
    }
  }

  // Cambiar radio o magnitud con los avisos activos: se actualiza en el servidor
  async function cambiarAjustes() {
    const c = leerConfig();
    guardarConfig({ ...c, ...ajustes() });
    if (!c.activo) return;
    try {
      const sub = await suscripcionActual();
      if (!sub) return;
      await registrar(sub, { lat: c.lat, lng: c.lng });
      mostrar(textoActivo());
    } catch (e) {
      mostrar('⚠️ No se pudieron guardar los cambios: ' + e.message, true);
    }
  }

  async function actualizarUbicacion(silencioso = false) {
    try {
      const sub = await suscripcionActual();
      if (!sub) return;
      if (!silencioso) mostrar('Obteniendo tu ubicación…');
      const pos = await ubicacion();
      await registrar(sub, pos);
      if (!silencioso) mostrar(textoActivo(' Ubicación actualizada.'));
    } catch (e) {
      if (!silencioso) mostrar('⚠️ ' + e.message, true);
    }
  }

  async function enviarPrueba() {
    try {
      const sub = await suscripcionActual();
      if (!sub) throw new Error('Los avisos no están activos en este teléfono');
      mostrar('Enviando notificación de prueba…');
      await api('/api/prueba', 'POST', { endpoint: sub.endpoint });
      mostrar(textoActivo(' Prueba enviada: debería llegarte en unos segundos.'));
    } catch (e) {
      mostrar('⚠️ ' + e.message, true);
    }
  }

  // Muestra si el revisor del servidor está funcionando
  async function revisarServidor() {
    try {
      const { ultimaRevision } = await api('/api/config');
      if (!ultimaRevision) return mostrar(textoActivo(' ⚠️ El revisor del servidor aún no ha corrido.'), true);
      const min = Math.round((Date.now() - new Date(ultimaRevision.hora).getTime()) / 60000);
      if (min > 5) mostrar(textoActivo(` ⚠️ El servidor no revisa desde hace ${min} min.`), true);
      else mostrar(textoActivo(` Servidor revisando (última vez: hace ${min < 1 ? 'menos de 1' : min} min).`));
    } catch (e) {
      mostrar(textoActivo(' ⚠️ ' + e.message), true);
    }
  }

  async function iniciar() {
    if (!$('btn-avisos')) return;
    if (!soportado) {
      $('btn-avisos').disabled = true;
      mostrar('Este navegador no permite notificaciones. Usa Chrome en Android con la app instalada.', true);
      return;
    }

    const c = leerConfig();
    if (c.radio) $('aviso-radio').value = String(c.radio);
    if (c.magMin) $('aviso-mag').value = String(c.magMin);

    $('btn-avisos').addEventListener('click', async () => {
      const sub = await suscripcionActual().catch(() => null);
      (sub && leerConfig().activo) ? desactivar() : activar();
    });
    // (si el service worker no está listo, activar() lo informa en pantalla)
    $('aviso-radio').addEventListener('change', cambiarAjustes);
    $('aviso-mag').addEventListener('change', cambiarAjustes);
    $('btn-aviso-prueba').addEventListener('click', enviarPrueba);
    $('btn-aviso-ubicacion').addEventListener('click', () => actualizarUbicacion(false));

    // ¿Siguen activos? (el permiso pudo haberse quitado desde los ajustes del teléfono)
    const sub = await suscripcionActual().catch(() => null);
    const activo = Boolean(sub && c.activo && Notification.permission === 'granted');
    pintar(activo);
    if (!activo) {
      if (c.activo) mostrar('Los avisos se desactivaron (se quitó el permiso). Vuelve a activarlos.', true);
      return;
    }
    revisarServidor();

    // Ubicación: se actualiza sola al abrir la app, solo si el permiso ya está concedido
    try {
      const permiso = await navigator.permissions?.query({ name: 'geolocation' });
      if (permiso && permiso.state === 'granted') actualizarUbicacion(true);
    } catch (e) {}
  }

  return { iniciar };
})();

// ============================================
// INICIO
// ============================================
// ?. evita que la app se detenga si el botón no existe en el HTML
document.getElementById('btn-actualizar')?.addEventListener('click', cargarSismos);

cargarSismos();
conectarEnVivo();
Avisos.iniciar();

// Refrescar cada 30 s mientras la app está en pantalla
setInterval(() => { if (!document.hidden) cargarSismos(); }, 30000);

// Al volver a abrir la app (Android pausa los temporizadores en segundo plano)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (Date.now() - ultimaCarga > 10000) cargarSismos();
  conectarEnVivo();
});

// Al tocar un aviso con la app abierta: actualizar de inmediato
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data && e.data.tipo === 'aviso-abierto') cargarSismos();
});

// Al recuperar la conexión a internet
window.addEventListener('online', () => {
  cargarSismos();
  conectarEnVivo();
});
