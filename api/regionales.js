// Función Vercel: sismos del Instituto de Geociencias de la Universidad de Panamá (IGC-UP)
// Lee https://sismosgeociencias.up.ac.pa/ (tabla HTML, últimos 7 días) y la devuelve como JSON.
//   /api/regionales          → lista de sismos
//   /api/regionales?debug=1  → además muestra filas de ejemplo para revisar el formato

const URL_IGC = 'https://sismosgeociencias.up.ac.pa/';
const OFFSET_PANAMA_MS = 5 * 60 * 60 * 1000; // Panamá = UTC-5 todo el año

async function leer(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (SismoPanama PWA)' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function limpiar(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
    .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\s+/g, ' ')
    .trim();
}

const num = (s) => {
  const m = String(s ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};

// Fecha (YYYY-MM-DD o DD/MM/YYYY) + hora local (12 h con AM/PM o 24 h) → milisegundos UTC
function aTimestamp(fecha, hora) {
  let a, mes, d;
  let m = fecha.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { [, a, mes, d] = m; }
  else {
    m = fecha.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return NaN;
    [, d, mes, a] = m;
  }
  const h = hora.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s*[Mm]\.?)?/);
  if (!h) return NaN;
  let hh = parseInt(h[1], 10);
  const ampm = (h[4] || '').toLowerCase().replace(/[.\s]/g, '');
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  return Date.UTC(+a, +mes - 1, +d, hh, +h[2], +(h[3] || 0)) + OFFSET_PANAMA_MS;
}

// "Localizado en Panamá a 18km al norte de Tonosí" → "18 km al norte de Tonosí"
// "Localizado en Costa Rica a 24km al oeste de Río Sereno" → "24 km al oeste de Río Sereno (Costa Rica)"
function limpiarLugar(texto) {
  const t = String(texto || '').replace(/^Localizado en\s*/i, '').trim();
  const m = t.match(/^(.*?)\s*\ba\s+(\d+(?:[.,]\d+)?)\s*km\s+(.+)$/i);
  if (!m) return t;
  const region = m[1].trim();
  const base = `${m[2]} km ${m[3].trim()}`;
  return region && region !== 'Panamá' ? `${base} (${region})` : base;
}

function extraerSismos(html) {
  const sismos = [];
  const vistos = new Set();
  const filas = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const fila of filas) {
    const celdas = (fila.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(limpiar);
    // Columnas esperadas: Estado | Fecha | Hora Local | Latitud | Longitud | Profundidad | Magnitud | Región | Mapa
    if (celdas.length < 8) continue;
    const estado = celdas.findIndex(c => /^(PRELIMINAR|REVISADO)/i.test(c));
    if (estado === -1) continue;
    const [est, fecha, hora, lat, lon, prof, mag, region] = celdas.slice(estado, estado + 8);

    const s = {
      lat: num(lat),
      lng: num(lon),
      depth: num(prof),
      mag: num(mag),
      time: aTimestamp(fecha, hora),
      lugar: limpiarLugar(region),
      estado: est.toUpperCase().startsWith('REV') ? 'Revisado' : 'Preliminar',
      fuente: 'IGC-UP'
    };
    if ([s.lat, s.lng, s.mag, s.time].some(Number.isNaN)) continue;
    if (Number.isNaN(s.depth)) s.depth = 0;

    // La página repite cada sismo (vista de escritorio y de celular)
    const clave = `${s.time}|${s.lat}|${s.lng}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    sismos.push(s);
  }
  return sismos.sort((a, b) => b.time - a.time);
}

module.exports = async (req, res) => {
  const debug = req.query && req.query.debug;
  const resultado = { generado: new Date().toISOString(), fuentes: {}, sismos: [] };

  try {
    const html = await leer(URL_IGC);
    const sismos = extraerSismos(html);
    resultado.sismos.push(...sismos);
    resultado.fuentes.igc = { ok: true, cantidad: sismos.length };
    if (debug) {
      const filas = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
      resultado.debug = {
        filasEncontradas: filas.length,
        ejemplos: filas.slice(0, 4).map(f => f.slice(0, 1200))
      };
    }
  } catch (e) {
    resultado.fuentes.igc = { ok: false, error: String(e.message || e) };
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Vercel guarda la respuesta 20 s: la app recibe datos frescos sin saturar al IGC
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=40');
  res.status(200).send(JSON.stringify(resultado, null, debug ? 2 : 0));
};
