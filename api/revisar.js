// GET /api/revisar → busca sismos nuevos y avisa a quienes estén cerca.
// Lo llama cron-job.org cada minuto. Es seguro llamarlo de más:
// un candado evita revisiones simultáneas y cada sismo se avisa una sola vez.

const { redis, getJSON, setJSON, hgetallJSON } = require('./_redis');
const { obtenerRegionales, obtenerEMSC, unirSismos } = require('./_fuentes');
const { CLAVES, enviar, distanciaKm, origenDe } = require('./_avisos');

const VENTANA_MIN = 30;          // solo se avisan sismos de los últimos 30 minutos
const GUARDAR_AVISADOS_H = 24;   // memoria de sismos ya avisados
const MAX_AVISADOS = 400;

const horaPanama = (t) => new Date(t).toLocaleTimeString('es-PA', {
  timeZone: 'America/Panama', hour: 'numeric', minute: '2-digit'
});

// ¿Este sismo ya fue avisado? (las agencias publican el mismo sismo con datos un poco distintos)
const yaAvisado = (s, avisados) => avisados.some(a =>
  Math.abs(a.time - s.time) < 120 * 1000 &&
  Math.abs(a.lat - s.lat) < 0.5 &&
  Math.abs(a.lng - s.lng) < 0.5
);

function armarMensaje(cercanos, sus) {
  // El más fuerte primero; si empatan, el más cercano
  const [s, ...otros] = [...cercanos].sort((a, b) => b.mag - a.mag || a.dist - b.dist);
  const donde = s.lugar ? `${s.lugar} · ` : '';
  let body = `${donde}a ${Math.round(s.dist)} km de ti · ${horaPanama(s.time)}`;
  if (otros.length) body += ` (+${otros.length} sismo${otros.length > 1 ? 's' : ''} más)`;
  return {
    title: `⚠️ Sismo M ${s.mag.toFixed(1)} cerca de ti`,
    body,
    tag: `sismo-${s.time}`,
    url: '/'
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const inicio = Date.now();

  try {
    // Candado de 45 s: si otra revisión está en curso, esta se omite
    const tomado = await redis('SET', CLAVES.candado, String(inicio), 'NX', 'EX', '45');
    if (tomado !== 'OK') return res.status(200).json({ ok: true, omitido: 'revisión en curso' });

    // 1. Sismos de todas las fuentes (prioridad: IGC-UP, INETER, EMSC)
    const [rReg, rEMSC] = await Promise.allSettled([obtenerRegionales(), obtenerEMSC(2)]);
    const regionales = rReg.status === 'fulfilled' ? rReg.value : { fuentes: {}, sismos: [] };
    const emsc = rEMSC.status === 'fulfilled' ? rEMSC.value : [];
    const fuentes = {
      igc: !!regionales.fuentes.igc?.ok,
      ineter: !!regionales.fuentes.ineter?.ok,
      emsc: rEMSC.status === 'fulfilled'
    };
    const todos = unirSismos(regionales.sismos, emsc);

    // 2. Solo los recientes que no se hayan avisado
    const limite = inicio - VENTANA_MIN * 60 * 1000;
    const recientes = todos.filter(s => s.time >= limite && s.time <= inicio + 5 * 60 * 1000);
    const avisados = (await getJSON(CLAVES.avisados, []))
      .filter(a => a.time > inicio - GUARDAR_AVISADOS_H * 3600 * 1000);
    const nuevos = recientes.filter(s => !yaAvisado(s, avisados));

    let enviados = 0, eliminados = 0, fallidos = 0;

    if (nuevos.length) {
      // Se marcan como avisados ANTES de enviar, para no repetir si algo falla a medias
      const actualizados = [...nuevos.map(({ time, lat, lng }) => ({ time, lat, lng })), ...avisados]
        .slice(0, MAX_AVISADOS);
      await setJSON(CLAVES.avisados, actualizados);

      // 3. Para cada suscriptor, los sismos nuevos dentro de su radio y magnitud
      const subs = await hgetallJSON(CLAVES.subs);
      const origen = origenDe(req);
      const tareas = [];

      for (const [id, sus] of Object.entries(subs)) {
        const cercanos = nuevos
          .filter(s => s.mag >= sus.magMin)
          .map(s => ({ ...s, dist: distanciaKm(sus.lat, sus.lng, s.lat, s.lng) }))
          .filter(s => s.dist <= sus.radio);
        if (!cercanos.length) continue;

        tareas.push(
          enviar(sus.sub, armarMensaje(cercanos, sus), origen)
            .then(() => { enviados++; })
            .catch(async (e) => {
              // 404/410: el teléfono ya no acepta avisos (desinstaló o revocó el permiso)
              if (e.statusCode === 404 || e.statusCode === 410) {
                eliminados++;
                await redis('HDEL', CLAVES.subs, id).catch(() => {});
              } else {
                fallidos++;
              }
            })
        );
      }
      await Promise.all(tareas);
    }

    const resumen = {
      hora: new Date(inicio).toISOString(),
      fuentes,
      sismosRecientes: recientes.length,
      nuevos: nuevos.length,
      enviados, eliminados, fallidos,
      duracionMs: Date.now() - inicio
    };
    await setJSON(CLAVES.ultima, resumen);
    await redis('DEL', CLAVES.candado);
    res.status(200).json({ ok: true, ...resumen });
  } catch (e) {
    await redis('DEL', CLAVES.candado).catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  }
};
