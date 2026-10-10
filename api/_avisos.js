// Utilidades compartidas de los avisos (no es una función pública).

const crypto = require('crypto');
const webpush = require('web-push');
const { redis, getJSON } = require('./_redis');

const CLAVES = {
  vapid: 'sismo:vapid',             // llaves para firmar las notificaciones (se crean solas)
  subs: 'sismo:subs',               // hash: id → { sub, lat, lng, radio, magMin, ... }
  avisados: 'sismo:avisados',       // sismos ya avisados (para no repetir)
  candado: 'sismo:candado',         // evita dos revisiones al mismo tiempo
  ultima: 'sismo:ultima-revision'   // resumen de la última revisión
};

const idDe = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 32);

// Llaves VAPID: se generan la primera vez y quedan guardadas en Redis
async function obtenerVapid() {
  let v = await getJSON(CLAVES.vapid);
  if (v && v.publicKey && v.privateKey) return v;
  const nuevas = webpush.generateVAPIDKeys();
  // NX: si otra llamada las creó al mismo tiempo, se conserva la primera
  await redis('SET', CLAVES.vapid, JSON.stringify(nuevas), 'NX');
  return getJSON(CLAVES.vapid);
}

async function enviar(sub, datos, origen) {
  const vapid = await obtenerVapid();
  return webpush.sendNotification(sub, JSON.stringify(datos), {
    TTL: 3600,                 // si el teléfono está apagado, el aviso espera hasta 1 hora
    urgency: 'high',
    vapidDetails: {
      subject: origen || 'https://sismo-panama.vercel.app',
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey
    }
  });
}

function distanciaKm(lat1, lng1, lat2, lng2) {
  const rad = g => g * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function origenDe(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `https://${host}` : undefined;
}

function leerCuerpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

module.exports = { CLAVES, idDe, obtenerVapid, enviar, distanciaKm, origenDe, leerCuerpo };
