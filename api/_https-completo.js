// Ayudante: descargar páginas de servidores con la cadena de certificados incompleta
// (como INETER), SIN desactivar la verificación de seguridad.
//
// Hace lo mismo que un navegador: lee en el certificado del sitio la dirección
// "CA Issuers" (AIA), descarga el certificado intermedio que falta y verifica
// la conexión con él más las autoridades raíz normales.
// El guion bajo en el nombre evita que Vercel lo publique como función.

const tls = require('tls');
const https = require('https');

const intermedios = new Map(); // host → PEM (se reutiliza mientras la función siga activa)

function aPEM(buffer) {
  const texto = buffer.toString('latin1');
  if (texto.includes('-----BEGIN CERTIFICATE-----')) return texto;
  const b64 = buffer.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// Solo lee el certificado del sitio (no se envía ni recibe ningún dato con esta conexión)
function leerCertificado(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate(true);
      socket.end();
      resolve(cert);
    });
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('Tiempo agotado leyendo certificado')); });
    socket.on('error', reject);
  });
}

async function obtenerIntermedio(host, port) {
  if (intermedios.has(host)) return intermedios.get(host);
  const cert = await leerCertificado(host, port);
  const aia = cert.infoAccess && cert.infoAccess['CA Issuers - URI'];
  if (!aia || !aia.length) throw new Error('El certificado no indica dónde descargar el intermedio (AIA)');
  const r = await fetch(aia[0]);
  if (!r.ok) throw new Error(`No se pudo descargar el intermedio: HTTP ${r.status}`);
  const pem = aPEM(Buffer.from(await r.arrayBuffer()));
  intermedios.set(host, { pem, origen: aia[0] });
  return intermedios.get(host);
}

function pedir(url, ca, timeoutMs, codificacion = 'utf8') {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      ca,
      headers: { 'User-Agent': 'Mozilla/5.0 (SismoPanama PWA)' },
      timeout: timeoutMs
    }, (res) => {
      // Seguir redirecciones dentro del mismo sitio
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(pedir(new URL(res.headers.location, url).href, ca, timeoutMs, codificacion));
      }
      const partes = [];
      res.on('data', d => partes.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        tipo: res.headers['content-type'] || '',
        texto: Buffer.concat(partes).toString(codificacion)
      }));
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo agotado')));
    req.on('error', reject);
  });
}

// Descarga una URL https verificando el certificado con la cadena completada
// codificacion: 'latin1' para páginas en iso-8859-1 (como INETER), 'utf8' por defecto
async function leerConCadenaCompleta(url, timeoutMs = 12000, codificacion = 'utf8') {
  const u = new URL(url);
  const inter = await obtenerIntermedio(u.hostname, Number(u.port) || 443);
  const resultado = await pedir(url, [...tls.rootCertificates, inter.pem], timeoutMs, codificacion);
  return { ...resultado, intermedio: inter.origen };
}

module.exports = { leerConCadenaCompleta };
