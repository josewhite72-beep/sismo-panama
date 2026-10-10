// Acceso mínimo a Upstash Redis por su API REST (sin librerías).
// Vercel crea las variables al conectar Upstash desde el panel (Storage / Marketplace).

const URL_REDIS = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function configurado() {
  return Boolean(URL_REDIS && TOKEN);
}

function exigirConfig() {
  if (!configurado()) {
    throw new Error('Falta conectar Upstash Redis en Vercel (variables KV_REST_API_URL y KV_REST_API_TOKEN).');
  }
}

// Un comando: redis('SET', 'clave', 'valor') → resultado
async function redis(...comando) {
  exigirConfig();
  const r = await fetch(URL_REDIS, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando.map(String))
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(`Redis: ${data.error || r.status}`);
  return data.result;
}

// Leer/guardar JSON
async function getJSON(clave, porDefecto = null) {
  const v = await redis('GET', clave);
  if (v == null) return porDefecto;
  try { return JSON.parse(v); } catch (e) { return porDefecto; }
}

async function setJSON(clave, valor, ...extra) {
  return redis('SET', clave, JSON.stringify(valor), ...extra);
}

// HGETALL devuelve [campo1, valor1, campo2, valor2, ...] → objeto
async function hgetallJSON(clave) {
  const lista = await redis('HGETALL', clave) || [];
  const obj = {};
  for (let i = 0; i < lista.length; i += 2) {
    try { obj[lista[i]] = JSON.parse(lista[i + 1]); } catch (e) {}
  }
  return obj;
}

module.exports = { redis, getJSON, setJSON, hgetallJSON, configurado };
