// Lectura de las agencias sísmicas (módulo compartido, no es una función pública).
// Lo usan /api/regionales (para la app) y /api/revisar (para los avisos).
//   - IGC-UP (Instituto de Geociencias, Universidad de Panamá): tabla HTML, últimos 7 días
//   - INETER (Nicaragua): lista en sismos.php (hora de Nicaragua, UTC-6)
//   - EMSC: catálogo europeo (solo para los avisos, como respaldo)

const URL_IGC = 'https://sismosgeociencias.up.ac.pa/';
const URL_INETER = 'https://webserver2.ineter.gob.ni/sis/events/sismos.php';
const OFFSET_NICARAGUA_MS = 6 * 60 * 60 * 1000; // Nicaragua = UTC-6 todo el año

// Zona de interés para INETER (su lista trae toda Centroamérica)
const ZONA = { minLat: 5.5, maxLat: 11, minLng: -84.5, maxLng: -76 };

// INETER tiene la cadena de certificados incompleta: se completa como lo hace el navegador
const { leerConCadenaCompleta } = require('./_https-completo');
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

// Convierte los textos de una fila del IGC en un sismo (o null si no es válida)
function aSismoIGC([est, fecha, hora, lat, lon, prof, mag, region]) {
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
  if ([s.lat, s.lng, s.mag, s.time].some(Number.isNaN)) return null;
  if (Number.isNaN(s.depth)) s.depth = 0;
  return s;
}

// Método 1: recorre la tabla. No exige </tr> ni </td>, porque el HTML permite omitirlos.
function extraerDeTabla(html) {
  const sismos = [];
  const filas = html.split(/<tr\b/i).slice(1);
  for (const fila of filas) {
    const celdas = fila.split(/<t[dh]\b/i).slice(1)
      .map(c => limpiar(c.slice(c.indexOf('>') + 1).split(/<\/t[dh]>|<\/tr>|<\/table>/i)[0]));
    // Columnas esperadas: Estado | Fecha | Hora Local | Latitud | Longitud | Profundidad | Magnitud | Región | Mapa
    const i = celdas.findIndex(c => /^(PRELIMINAR|REVISADO)/i.test(c));
    if (i === -1 || celdas.length - i < 8) continue;
    const s = aSismoIGC(celdas.slice(i, i + 8));
    if (s) sismos.push(s);
  }
  return sismos;
}

// Método 2 (respaldo): lee el texto plano de la página, sin importar las etiquetas.
// PRELIMINAR 2026-10-14 1:25:30PM 7.48477 -80.26070 7km 3.5 Localizado en Panamá a 21km al noreste de Tonosí Ver
const FILA_TEXTO = /(PRELIMINAR|REVISADO)\s+(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[AaPp]\.?\s*[Mm]\.?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*km\s+(\d+(?:\.\d+)?)\s+(Localizado.*?)(?=\s+Ver\b|\s+(?:PRELIMINAR|REVISADO)\s+\d{4}-|$)/gi;

function extraerDeTexto(html) {
  const texto = limpiar(html);
  const sismos = [];
  for (const m of texto.matchAll(FILA_TEXTO)) {
    const s = aSismoIGC(m.slice(1, 9));
    if (s) sismos.push(s);
  }
  return sismos;
}

function extraerSismos(html) {
  let lista = extraerDeTabla(html);
  if (lista.length === 0) lista = extraerDeTexto(html);

  // Quita repetidos (antes la página repetía cada sismo para escritorio y celular)
  const vistos = new Set();
  const sismos = lista.filter(s => {
    const clave = `${s.time}|${s.lat}|${s.lng}`;
    if (vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
  return sismos.sort((a, b) => b.time - a.time);
}

// Si no se reconoce ningún sismo, describe lo que llegó, para saber por qué
function diagnosticoIGC(html) {
  const titulo = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  return {
    bytes: html.length,
    titulo: titulo ? limpiar(titulo).slice(0, 80) : null,
    filasTr: (html.match(/<tr\b/gi) || []).length,
    marcasEstado: (html.match(/PRELIMINAR|REVISADO/gi) || []).length,
    inicio: limpiar(html).slice(0, 160)
  };
}

// Línea de INETER (dentro de <PRE>):
// 26/10/10 14:36:19  7.545 -80.411  10 4.4 <span>C</span>  16 Km al norte de Tonosí, Panamá
const LINEA_INETER = /(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+\S*\s*(.*)$/;

function extraerIneter(html) {
  const sismos = [];
  const bloques = html.match(/<PRE>[\s\S]*?<\/PRE>/gi) || [];
  for (const b of bloques) {
    const linea = limpiar(b);
    const m = linea.match(LINEA_INETER);
    if (!m) continue;
    const [, aa, mm, dd, hh, mi, ss, lat, lon, prof, mag, lugar] = m;
    const s = {
      lat: parseFloat(lat),
      lng: parseFloat(lon),
      depth: parseFloat(prof),
      mag: parseFloat(mag),
      time: Date.UTC(2000 + +aa, +mm - 1, +dd, +hh, +mi, +ss) + OFFSET_NICARAGUA_MS,
      lugar: lugar.trim().replace(/(\d+)\s*Km\b/, '$1 km'),
      fuente: 'INETER'
    };
    if (s.lat < ZONA.minLat || s.lat > ZONA.maxLat || s.lng < ZONA.minLng || s.lng > ZONA.maxLng) continue;
    sismos.push(s);
  }
  return sismos.sort((a, b) => b.time - a.time);
}

// IGC-UP + INETER, en ese orden de prioridad
async function obtenerRegionales() {
  const resultado = { fuentes: {}, sismos: [] };
  const [rIGC, rINETER] = await Promise.allSettled([
    leer(URL_IGC),
    leerConCadenaCompleta(URL_INETER, 12000, 'utf8')
  ]);

  if (rIGC.status === 'fulfilled') {
    const sismos = extraerSismos(rIGC.value);
    resultado.sismos.push(...sismos);
    resultado.fuentes.igc = { ok: sismos.length > 0, cantidad: sismos.length };
    if (sismos.length === 0) resultado.fuentes.igc.diagnostico = diagnosticoIGC(rIGC.value);
  } else {
    resultado.fuentes.igc = { ok: false, error: String(rIGC.reason?.message || rIGC.reason) };
  }

  if (rINETER.status === 'fulfilled' && rINETER.value.status === 200) {
    const sismos = extraerIneter(rINETER.value.texto);
    resultado.sismos.push(...sismos);
    resultado.fuentes.ineter = { ok: sismos.length > 0, cantidad: sismos.length };
  } else {
    const motivo = rINETER.status === 'fulfilled' ? `HTTP ${rINETER.value.status}` : (rINETER.reason?.message || rINETER.reason);
    resultado.fuentes.ineter = { ok: false, error: String(motivo) };
  }
  return resultado;
}

// EMSC: sismos de las últimas horas en la zona de Panamá
async function obtenerEMSC(horas = 2) {
  const inicio = new Date(Date.now() - horas * 3600 * 1000).toISOString().slice(0, 19);
  const params = new URLSearchParams({
    format: 'json', minlatitude: 6, maxlatitude: 10.5, minlongitude: -84, maxlongitude: -76,
    starttime: inicio, orderby: 'time', limit: 200
  });
  const r = await fetch(`https://www.seismicportal.eu/fdsnws/event/1/query?${params}`);
  if (r.status === 204) return [];
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return (data.features || []).map(f => ({
    lat: f.properties.lat,
    lng: f.properties.lon,
    depth: f.properties.depth ?? 0,
    mag: f.properties.mag ?? 0,
    time: new Date(f.properties.time).getTime(),
    lugar: '',
    fuente: 'EMSC'
  }));
}

// Une listas sin repetir el mismo sismo (±90 s y a menos de ~50 km); gana la primera lista
function unirSismos(...listas) {
  const resultado = [];
  for (const lista of listas) {
    for (const e of lista) {
      const repetido = resultado.some(u =>
        Math.abs(u.time - e.time) < 90 * 1000 &&
        Math.abs(u.lat - e.lat) < 0.5 &&
        Math.abs(u.lng - e.lng) < 0.5
      );
      if (!repetido) resultado.push(e);
    }
  }
  return resultado.sort((a, b) => b.time - a.time);
}

module.exports = {
  obtenerRegionales, obtenerEMSC, unirSismos,
  // expuestas para pruebas
  extraerSismos, extraerIneter, limpiarLugar
};
