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
const mapa = L.map('mapa').setView([8.5379, -80.7821], 6); // Centro en Panamá

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap',
  maxZoom: 18
}).addTo(mapa);

// Capa propia para los sismos (más fácil de limpiar en cada refresco)
const capaSismos = L.layerGroup().addTo(mapa);

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
  const response = await fetch(url);
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
      fuente: 'EMSC'
    };
  });
}

// Une ambas listas sin repetir el mismo sismo (mismo minuto y a menos de ~50 km)
function unirSismos(usgs, emsc) {
  const resultado = [...usgs];
  emsc.forEach(e => {
    const repetido = usgs.some(u =>
      Math.abs(u.time - e.time) < 90 * 1000 &&
      Math.abs(u.lat - e.lat) < 0.5 &&
      Math.abs(u.lng - e.lng) < 0.5
    );
    if (!repetido) resultado.push(e);
  });
  return resultado.sort((a, b) => b.time - a.time);
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

async function cargarSismos() {
  const estado = document.getElementById('ultima-actualizacion');
  try {
    // Se piden las dos fuentes a la vez; si una falla, se usa la otra
    const [rUSGS, rEMSC] = await Promise.allSettled([
      pedirJSON(urlUSGS()),
      pedirJSON(urlEMSC())
    ]);
    if (rUSGS.status === 'rejected' && rEMSC.status === 'rejected') {
      throw new Error('Ninguna fuente respondió');
    }
    if (rUSGS.status === 'rejected') console.warn('USGS falló:', rUSGS.reason);
    if (rEMSC.status === 'rejected') console.warn('EMSC falló:', rEMSC.reason);

    const sismos = unirSismos(
      rUSGS.status === 'fulfilled' ? normalizarUSGS(rUSGS.value) : [],
      rEMSC.status === 'fulfilled' ? normalizarEMSC(rEMSC.value) : []
    );

    capaSismos.clearLayers();

    // Se dibujan del más viejo al más nuevo para que el más reciente quede encima
    [...sismos].reverse().forEach(s => {
      L.circleMarker([s.lat, s.lng], {
        radius: Math.max(s.mag, 1) * 2.5,
        fillColor: obtenerColor(s.mag),
        color: '#000',
        weight: 1,
        fillOpacity: 0.6
      })
      .bindPopup(`
        <strong>M ${s.mag.toFixed(1)}</strong><br>
        ${escaparHTML(describirUbicacion(s.lat, s.lng))}<br>
        Profundidad: ${s.depth.toFixed(1)} km<br>
        ${new Date(s.time).toLocaleString('es-PA')} (${haceCuanto(s.time)})<br>
        <small>Fuente: ${s.fuente}${s.lugarOriginal ? ' · ' + escaparHTML(s.lugarOriginal) : ''}</small>
      `)
      .addTo(capaSismos);
    });

    renderizarLista(sismos.slice(0, 15));

    const fuentes = [
      rUSGS.status === 'fulfilled' ? 'USGS' : null,
      rEMSC.status === 'fulfilled' ? 'EMSC' : null
    ].filter(Boolean).join(' + ');
    estado.textContent = `Actualizado: ${new Date().toLocaleTimeString('es-PA')} · ${fuentes}`;
  } catch (error) {
    console.error('Error cargando sismos:', error);
    estado.textContent = '⚠️ Sin conexión. Mostrando datos en caché si existen.';
  }
}

function obtenerColor(magnitud) {
  if (magnitud >= 6) return '#dc2626';  // Rojo
  if (magnitud >= 5) return '#ea580c';  // Naranja
  if (magnitud >= 4) return '#ca8a04';  // Amarillo oscuro
  return '#65a30d';                      // Verde
}

function renderizarLista(sismos) {
  const lista = document.getElementById('sismos-lista');

  if (sismos.length === 0) {
    lista.innerHTML = `<li class="sismo-item">Sin sismos de M ${MAG_MINIMA}+ en Panamá en los últimos ${DIAS_ATRAS} días.</li>`;
    return;
  }

  lista.innerHTML = sismos.map(s => `
      <li class="sismo-item">
        <span class="magnitud" style="background:${obtenerColor(s.mag)}">M ${s.mag.toFixed(1)}</span>
        <div class="info">
          <strong>${escaparHTML(describirUbicacion(s.lat, s.lng))}</strong>
          <small>${haceCuanto(s.time)} · ${new Date(s.time).toLocaleString('es-PA')} · ${s.depth.toFixed(0)} km prof. · ${s.fuente}</small>
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
// INICIO
// ============================================
cargarSismos();
setInterval(cargarSismos, 60000); // Refrescar cada 60 segundos
