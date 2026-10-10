// POST /api/prueba { endpoint } → envía una notificación de prueba a ese teléfono
const { getJSON, redis } = require('./_redis');
const { CLAVES, idDe, enviar, origenDe, leerCuerpo } = require('./_avisos');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });
  try {
    const { endpoint } = leerCuerpo(req);
    const crudo = endpoint && await redis('HGET', CLAVES.subs, idDe(endpoint));
    if (!crudo) return res.status(404).json({ ok: false, error: 'Este teléfono no tiene los avisos activados' });
    const registro = JSON.parse(crudo);
    await enviar(registro.sub, {
      title: '✅ Avisos de Sismo Panamá activos',
      body: `Te avisaremos de sismos de M ${registro.magMin.toFixed(1)} o más a menos de ${registro.radio} km.`,
      tag: 'prueba',
      url: '/'
    }, origenDe(req));
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.body || e.message });
  }
};
