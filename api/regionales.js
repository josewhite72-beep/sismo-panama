// Función Vercel: sismos de agencias regionales (IGC-UP e INETER) para la app
//   /api/regionales → { generado, fuentes: { igc, ineter }, sismos: [...] }
// La lista viene en orden de prioridad: IGC-UP primero, luego INETER.

const { obtenerRegionales } = require('./_fuentes');

module.exports = async (req, res) => {
  const { fuentes, sismos } = await obtenerRegionales();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Vercel guarda la respuesta 20 s: la app recibe datos frescos sin saturar a las agencias
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=40');
  res.status(200).send(JSON.stringify({ generado: new Date().toISOString(), fuentes, sismos }));
};
