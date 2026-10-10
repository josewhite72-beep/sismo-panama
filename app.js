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
    place: f.properties.place || 'Panamá',
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
      place: p.flynn_region || 'Panamá',
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
        ${escaparHTML(s.place)}<br>
        Profundidad: ${s.depth.toFixed(1)} km<br>
        ${new Date(s.time).toLocaleString('es-PA')} (${haceCuanto(s.time)})<br>
        <small>Fuente: ${s.fuente}</small>
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
          <strong>${escaparHTML(s.place)}</strong>
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
