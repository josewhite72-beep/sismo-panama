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

function construirUrl() {
  const inicio = new Date(Date.now() - DIAS_ATRAS * 24 * 60 * 60 * 1000);
  // Redondear a la hora para que la URL se repita y el SW pueda usar la caché offline
  inicio.setUTCMinutes(0, 0, 0);
  const params = new URLSearchParams({
    format: 'geojson',
    ...REGION,
    minmagnitude: MAG_MINIMA,
    starttime: inicio.toISOString().slice(0, 19),
    orderby: 'time'
  });
  return `https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`;
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
    const response = await fetch(construirUrl());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const sismos = data.features || [];

    capaSismos.clearLayers();

    sismos.forEach(earthquake => {
      const [lng, lat, depth] = earthquake.geometry.coordinates;
      const { place, time } = earthquake.properties;
      const mag = earthquake.properties.mag ?? 0;

      L.circleMarker([lat, lng], {
        radius: Math.max(mag, 1) * 4,
        fillColor: obtenerColor(mag),
        color: '#000',
        weight: 1,
        fillOpacity: 0.6
      })
      .bindPopup(`
        <strong>M ${mag.toFixed(1)}</strong><br>
        ${escaparHTML(place)}<br>
        Profundidad: ${(depth ?? 0).toFixed(1)} km<br>
        ${new Date(time).toLocaleString('es-PA')}
      `)
      .addTo(capaSismos);
    });

    renderizarLista(sismos.slice(0, 10));

    estado.textContent = `Actualizado: ${new Date().toLocaleTimeString('es-PA')}`;
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

  lista.innerHTML = sismos.map(eq => {
    const { place, time } = eq.properties;
    const mag = eq.properties.mag ?? 0;
    const depth = eq.geometry.coordinates[2] ?? 0;
    return `
      <li class="sismo-item">
        <span class="magnitud" style="background:${obtenerColor(mag)}">M ${mag.toFixed(1)}</span>
        <div class="info">
          <strong>${escaparHTML(place)}</strong>
          <small>${new Date(time).toLocaleString('es-PA')} · ${depth.toFixed(0)} km prof.</small>
        </div>
      </li>
    `;
  }).join('');
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
