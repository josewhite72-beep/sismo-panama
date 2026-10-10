// GET /api/config → llave pública para suscribirse a los avisos + estado de la última revisión
const { configurado, getJSON, redis } = require('./_redis');
const { CLAVES, obtenerVapid } = require('./_avisos');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
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
