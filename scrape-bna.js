const fs = require('fs');

const API = 'https://mashogaresconbna.com.ar/api/propiedades';
const PROVINCIA = 'Córdoba';
// La API rechaza el fetch sin tipo (HTTP 500), así que hacemos un GET por cada tipo
// que cubrimos. Casa + Depto + PH son los tres con stock real en Córdoba; los demás
// (Lote, Quinta, Local…) devuelven listas vacías.
const TIPOS = ['Casa', 'Departamento', 'PH'];
const TIPO_OPERACION = 'Venta';

async function fetchTipo(tipo) {
  const url = `${API}?limit=30000&page=1&tipo=${encodeURIComponent(tipo)}&tipoOperacion=${encodeURIComponent(TIPO_OPERACION)}`;
  console.log(`GET ${url}`);
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'bna-hogares-map-bot/1.0 (+https://github.com/ingfrancoluna/bna-hogares-map)',
      'Accept-Language': 'es-AR,es;q=0.9'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (tipo=${tipo})`);
  const json = await res.json();
  if (json.internalStatus !== 'SUCCESS') throw new Error(`internalStatus=${json.internalStatus} (tipo=${tipo})`);
  return json.response.data;
}

async function fetchAll() {
  const all = [];
  for (const t of TIPOS) {
    const arr = await fetchTipo(t);
    console.log(`  tipo=${t}: ${arr.length}`);
    all.push(...arr);
  }
  return all;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapItem(p) {
  const lat = parseNum(p.latitud);
  const lng = parseNum(p.longitud);
  if (lat == null || lng == null) return null;

  const cleanArr = (a) => Array.isArray(a) ? a.filter(x => x != null && x !== '') : [];
  const comodidades = Array.from(new Set([
    ...cleanArr(p.serviciosInmueble),
    ...cleanArr(p.caracteristicas),
    ...cleanArr(p.caractGenerales)
  ]));

  return {
    id: p.id,
    titulo: p.titulo || '',
    lat,
    lng,
    precio: parseNum(p.precio),
    moneda: p.moneda || 'USD',
    localidad: p.localidad || '',
    provincia: p.provincia || '',
    direccion: p.direccionDescripcion || '',
    dormitorios: parseNum(p.dormitorios),
    banos: parseNum(p.banos),
    cocheras: parseNum(p.cocheras),
    superficieCubierta: parseNum(p.superficieCubierta),
    superficieTotal: parseNum(p.superficieTotal),
    estado: p.estadoPropiedad || '',
    disposicion: p.disposicion || '',
    servicios: cleanArr(p.servicios),
    comodidades,
    imagen: Array.isArray(p.imagenes) && p.imagenes.length ? p.imagenes[0] : null,
    fechaCreacion: p.fechaCreacion || null,
    tipo: p.tipo || '',
    fuente: 'bna'
  };
}

(async () => {
  const all = await fetchAll();
  console.log(`Recibidas: ${all.length} propiedades (todo el país, tipos: ${TIPOS.join('+')}, op: ${TIPO_OPERACION})`);

  const filtered = all.filter(p =>
    p.provincia === PROVINCIA &&
    p.publicado === true &&
    p.bloqueado === false &&
    p.eliminado === false
  );
  console.log(`Filtradas a ${PROVINCIA}, publicadas y no bloqueadas: ${filtered.length}`);

  const mapped = filtered.map(mapItem).filter(Boolean);
  console.log(`Con lat/lng válida: ${mapped.length}`);

  // más recientes primero (las sin fecha al final)
  mapped.sort((a, b) => {
    const ta = a.fechaCreacion ? Date.parse(a.fechaCreacion) : 0;
    const tb = b.fechaCreacion ? Date.parse(b.fechaCreacion) : 0;
    return tb - ta;
  });

  fs.writeFileSync('data-bna.json', JSON.stringify(mapped));
  console.log(`data.json: ${(fs.statSync('data-bna.json').size / 1024).toFixed(1)} KB`);

  if (mapped.length === 0) {
    console.error('Cero propiedades tras filtros. Algo cambió en la API.');
    process.exit(1);
  }
})().catch(e => {
  console.error('FAIL:', e);
  process.exit(1);
});
