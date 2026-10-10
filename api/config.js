// GET /api/config → llave pública para suscribirse a los avisos + estado de la última revisión
const { configurado, getJSON, redis } = require('./_redis');
const { CLAVES, obtenerVapid } = require('./_avisos');

// /api/config?diag=1 → diagnóstico de la conexión con Upstash (solo nombres, nunca valores)
async function diagnostico() {
  const nombres = Object.keys(process.env).filter(k => /KV|REDIS|UPSTASH|STORAGE|REST_API/i.test(k)).sort();
  const info = { variablesEncontradas: nombres, configurado: configurado() };
  try {
    const clave = 'sismo:diag';
    info.set = await redis('SET', clave, JSON.stringify({ hola: Date.now() }), 'EX', '60');
    const leido = await redis('GET', clave);
    info.getTipo = typeof leido;
    info.getInicio = typeof leido === 'string' ? leido.slice(0, 30) : leido;
    const vapid = await redis('GET', CLAVES.vapid);
    info.vapidGuardadoTipo = typeof vapid;
    info.vapidGuardadoInicio = typeof vapid === 'string' ? vapid.slice(0, 25) : vapid;
  } catch (e) {
    info.error = e.message;
  }
  return info;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.query && req.query.diag) return res.status(200).json(await diagnostico());
  if (!configurado()) {
    return res.status(503).json({ ok: false, error: 'Avisos no disponibles: falta conectar Upstash Redis en Vercel.' });
  }
  try {
    const [vapid, ultima, suscritos] = await Promise.all([
      obtenerVapid(),
      getJSON(CLAVES.ultima),
      redis('HLEN', CLAVES.subs)
    ]);
    res.status(200).json({ ok: true, vapidPublicKey: vapid.publicKey, ultimaRevision: ultima, suscritos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
