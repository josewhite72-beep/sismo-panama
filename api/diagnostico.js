// Función de diagnóstico (temporal) — Vercel
// Abre: https://TU-APP.vercel.app/api/diagnostico
// Revisa las páginas de INETER e IGC-UP y muestra de dónde cargan sus datos.
// Se puede borrar cuando ya tengamos la función definitiva.

// INETER tiene la cadena de certificados incompleta: se completa como lo hace el navegador
const { leerConCadenaCompleta } = require('./_https-completo');

const PAGINAS = [
  'https://webserver2.ineter.gob.ni/sis/monitor.html',
  'https://web-geofisica.ineter.gob.ni/sis/monitor.html'
];

const PATRON_DATOS = /["'`(]([^"'`()\s]+\.(?:json|geojson|xml|php|txt|csv|js)(?:\?[^"'`()\s]*)?)["'`)]/gi;

async function leer(url) {
  try {
    const r = await leerConCadenaCompleta(url);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, tipo: r.tipo, texto: r.texto, intermedio: r.intermedio };
  } catch (e) {
    const causa = e.code ? ` · ${e.code}` : '';
    return { ok: false, status: 0, error: `${e.message}${causa}`, texto: '' };
  }
}

async function leerNormal(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (SismoPanama PWA)' }
    });
    const texto = await r.text();
    return { ok: r.ok, status: r.status, tipo: r.headers.get('content-type'), texto };
  } catch (e) {
    // La causa real (DNS, certificado, conexión rechazada, tiempo agotado...)
    const causa = e.cause ? `${e.cause.code || ''} ${e.cause.message || ''}`.trim() : '';
    return { ok: false, status: 0, error: `${e.name}: ${e.message}${causa ? ' · ' + causa : ''}`, texto: '' };
  } finally {
    clearTimeout(t);
  }
}

function buscarReferencias(texto, base) {
  const encontrados = new Set();
  let m;
  PATRON_DATOS.lastIndex = 0;
  while ((m = PATRON_DATOS.exec(texto)) !== null) {
    try { encontrados.add(new URL(m[1], base).href); } catch (e) {}
  }
  return [...encontrados];
}

module.exports = async (req, res) => {
  const informe = [];

  for (const url of PAGINAS) {
    const pag = await leer(url);
    const entrada = {
      pagina: url,
      status: pag.status,
      tipo: pag.tipo,
      error: pag.error,
      intermedio: pag.intermedio,
      tamano: pag.texto.length,
      referencias: buscarReferencias(pag.texto, url),
      scriptsInternos: [],
      inicio: pag.texto.slice(0, 1500)
    };

    // Revisar los .js propios del sitio (no librerías externas) en busca de archivos de datos
    const propios = entrada.referencias.filter(r =>
      r.endsWith('.js') && new URL(r).hostname === new URL(url).hostname
    ).slice(0, 8);

    for (const js of propios) {
      const s = await leer(js);
      entrada.scriptsInternos.push({
        script: js,
        status: s.status,
        referencias: buscarReferencias(s.texto, js).filter(r => !r.endsWith('.js'))
      });
    }

    // Fragmentos donde aparece fetch/ajax/XMLHttpRequest en el HTML
    entrada.cargasDeDatos = (pag.texto.match(/.{0,120}(fetch\(|\$\.(?:get|ajax|getJSON)\(|XMLHttpRequest|\.open\().{0,160}/g) || []).slice(0, 10);

    informe.push(entrada);
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify({
    generado: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'desconocida',
    informe
  }, null, 2));
};
