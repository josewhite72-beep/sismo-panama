// Función de diagnóstico (temporal) — Vercel
// Abre: https://TU-APP.vercel.app/api/diagnostico
// Muestra el contenido de los archivos de datos de INETER para saber su formato.
// Se puede borrar cuando ya tengamos la función definitiva.

const { leerConCadenaCompleta } = require('./_https-completo');

const BASE = 'https://webserver2.ineter.gob.ni/sis/events/';
const ARCHIVOS = ['sismos.php', 'ca.txt', 'cabig.txt', 'nicaragua.txt'];

module.exports = async (req, res) => {
  const informe = [];

  for (const nombre of ARCHIVOS) {
    const url = BASE + nombre;
    try {
      const r = await leerConCadenaCompleta(url, 12000, 'latin1');
      // Para HTML: quitar estilos/scripts para que se vea el contenido útil
      const sinRuido = r.texto
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '');
      const inicioDatos = Math.max(0, sinRuido.search(/<table|<pre|\d{4}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]\d{2,4}/i));
      informe.push({
        archivo: url,
        status: r.status,
        tipo: r.tipo,
        tamano: r.texto.length,
        inicio: r.texto.slice(0, 1200),
        zonaDeDatos: sinRuido.slice(inicioDatos, inicioDatos + 3500)
      });
    } catch (e) {
      informe.push({ archivo: url, status: 0, error: `${e.message}${e.code ? ' · ' + e.code : ''}` });
    }
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify({ generado: new Date().toISOString(), informe }, null, 2));
};
