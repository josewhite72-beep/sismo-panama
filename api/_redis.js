// Acceso mínimo a Upstash Redis por su API REST (sin librerías).
// Vercel crea las variables al conectar Upstash desde el panel (Storage / Marketplace).

// Busca las claves con el prefijo estándar (KV_) o con cualquier prefijo personalizado
// (por ejemplo STORAGE_REST_API_URL), por si se eligió otro al conectar Upstash.
function buscarVariable(sufijos) {
  for (const nombre of ['KV', 'UPSTASH_REDIS']) {
    for (const suf of sufijos) if (process.env[`${nombre}_${suf}`]) return process.env[`${nombre}_${suf}`];
  }
  const clave = Object.keys(process.env).find(k => sufijos.some(suf => k.endsWith(`_${suf}`)) && !k.includes('READ_ONLY'));
  return clave ? process.env[clave] : undefined;
}

const URL_REDIS = buscarVariable(['REST_API_URL', 'REST_URL']);
const TOKEN = buscarVariable(['REST_API_TOKEN', 'REST_TOKEN']);

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
