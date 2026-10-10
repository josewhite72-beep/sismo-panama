// POST   /api/suscribir  { subscription, lat, lng, radio, magMin } → activa o actualiza los avisos
// DELETE /api/suscribir  { endpoint }                              → desactiva los avisos
const { redis } = require('./_redis');
const { CLAVES, idDe, leerCuerpo } = require('./_avisos');

const RADIOS = [50, 100, 200, 300];
const MAGNITUDES = [3.5, 4.0, 4.5, 5.0];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const cuerpo = leerCuerpo(req);

    if (req.method === 'DELETE') {
      if (!cuerpo.endpoint) return res.status(400).json({ ok: false, error: 'Falta endpoint' });
      await redis('HDEL', CLAVES.subs, idDe(cuerpo.endpoint));
      return res.status(200).json({ ok: true });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });

    const { subscription: sub } = cuerpo;
    const lat = Number(cuerpo.lat);
    const lng = Number(cuerpo.lng);
    const radio = Number(cuerpo.radio);
    const magMin = Number(cuerpo.magMin);

    if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys) {
      return res.status(400).json({ ok: false, error: 'Suscripción no válida' });
    }
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) {
      return res.status(400).json({ ok: false, error: 'Ubicación no válida' });
    }
    if (!RADIOS.includes(radio) || !MAGNITUDES.includes(magMin)) {
      return res.status(400).json({ ok: false, error: 'Radio o magnitud no válidos' });
    }

    const registro = {
      sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      // Se redondea a ~1 km: suficiente para calcular distancias, sin guardar la dirección exacta
      lat: Math.round(lat * 100) / 100,
      lng: Math.round(lng * 100) / 100,
      radio,
      magMin,
      actualizado: Date.now()
    };
    await redis('HSET', CLAVES.subs, idDe(sub.endpoint), JSON.stringify(registro));
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
