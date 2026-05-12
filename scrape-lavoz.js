const fs = require('fs');

const BASE = 'https://clasificados.lavoz.com.ar';
const ENDPOINT = '/inmuebles/casa?map=true&operacion=venta&provincia=cordoba';
const PROVINCIA = 'Córdoba';
const FUENTE = 'lavoz';
const OUT_FILE = 'data-lavoz.json';

const UA = 'Mozilla/5.0 Chrome/127';
const ROWS = 70;
const PAGE_LIMIT = ROWS; // si una bbox devuelve este número, la subdividimos
const THROTTLE_MS = 400;
const MIN_SPAN = 0.01; // ~1.1 km — no subdividir por debajo de esto

// Bbox inicial: Córdoba Capital + Gran Córdoba (~150 km de lado)
const INITIAL = { n: -30.95, s: -31.85, e: -63.45, w: -64.85 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBbox(bbox) {
  const url = `${BASE}${ENDPOINT}&getByProximity=true` +
    `&northEastLatitude=${bbox.n}&northEastLongitude=${bbox.e}` +
    `&southWestLatitude=${bbox.s}&southWestLongitude=${bbox.w}` +
    `&rows=${ROWS}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = Object.keys(data)
    .filter(k => /^\d+$/.test(k))
    .map(k => data[k])
    .filter(Boolean);
  return items;
}

function parsePrice(s) {
  if (s == null || s === '') return null;
  // La Voz: "85.000" o "1.250.000" (punto = miles). A veces "150.000,00".
  const clean = String(s).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : null;
}

function parseCurrency(s) {
  if (!s) return 'USD';
  return /U\$S|USD|u\$s/i.test(s) ? 'USD' : 'ARS';
}

function parseInt1(s) {
  if (s == null || s === '') return null;
  const m = String(s).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseDate(s) {
  if (!s) return null;
  // "11.05.2026" → "2026-05-11"
  const m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function mapItem(it) {
  const lat = parseFloat(it.latitude);
  const lng = parseFloat(it.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const imagen = Array.isArray(it.filepath_list) && it.filepath_list[0]
    ? it.filepath_list[0]
    : (it.filepath_thumbnail || it.filepath || null);

  let url = it.url_amigable || it.url_nid || null;
  if (url && !/^https?:/.test(url)) url = BASE + url;

  return {
    id: it.nid,
    url,
    titulo: it.title || '',
    lat, lng,
    precio: parsePrice(it.field_aviso_precio_value),
    moneda: parseCurrency(it.field_aviso_moneda_value),
    localidad: it.field_aviso_barrio || it.field_aviso_ciudad || '',
    provincia: PROVINCIA,
    direccion: '',
    dormitorios: parseInt1(it.dormitorios),
    banos: parseInt1(it.banios),
    cocheras: null,
    superficieCubierta: null,
    superficieTotal: typeof it.field_aviso_superficie_total === 'number'
      ? it.field_aviso_superficie_total
      : parseInt1(it.field_aviso_superficie_total),
    estado: '',
    disposicion: '',
    servicios: [],
    comodidades: [],
    imagen,
    fechaCreacion: parseDate(it.field_aviso_publicacion),
    fuente: FUENTE
  };
}

(async () => {
  const byId = new Map();
  let queue = [INITIAL];
  let bboxCount = 0;
  let totalFetched = 0;
  let casasCount = 0;

  console.log(`Cubriendo bbox inicial N=${INITIAL.n} S=${INITIAL.s} E=${INITIAL.e} W=${INITIAL.w}`);

  while (queue.length) {
    const bbox = queue.shift();
    bboxCount++;
    await sleep(THROTTLE_MS);

    let items;
    try {
      items = await fetchBbox(bbox);
    } catch (e) {
      console.error(`  bbox ${bboxCount} ERROR: ${e.message} → reintento omitido`);
      continue;
    }
    totalFetched += items.length;

    for (const it of items) {
      if (it.type !== 'Casas') continue;
      const mapped = mapItem(it);
      if (mapped && !byId.has(String(mapped.id))) {
        byId.set(String(mapped.id), mapped);
        casasCount++;
      }
    }

    // Si la bbox vino topada, subdividir
    const dLat = bbox.n - bbox.s;
    const dLng = bbox.e - bbox.w;
    if (items.length >= PAGE_LIMIT && dLat > MIN_SPAN && dLng > MIN_SPAN) {
      const midLat = (bbox.n + bbox.s) / 2;
      const midLng = (bbox.e + bbox.w) / 2;
      queue.push(
        { n: bbox.n, s: midLat, e: midLng, w: bbox.w }, // NW
        { n: bbox.n, s: midLat, e: bbox.e, w: midLng }, // NE
        { n: midLat, s: bbox.s, e: midLng, w: bbox.w }, // SW
        { n: midLat, s: bbox.s, e: bbox.e, w: midLng }  // SE
      );
    }

    if (bboxCount % 20 === 0) {
      console.log(`  bboxes=${bboxCount} pendientes=${queue.length} fetched=${totalFetched} casas únicas=${byId.size}`);
    }
  }

  const items = [...byId.values()];
  items.sort((a, b) => {
    const ta = a.fechaCreacion ? Date.parse(a.fechaCreacion) : 0;
    const tb = b.fechaCreacion ? Date.parse(b.fechaCreacion) : 0;
    return tb - ta;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(items));
  console.log(`\nFinal:`);
  console.log(`  Bboxes procesadas: ${bboxCount}`);
  console.log(`  Items fetched (todos los tipos): ${totalFetched}`);
  console.log(`  Casas únicas con coords: ${items.length}`);
  console.log(`  ${OUT_FILE}: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);

  if (items.length === 0) {
    console.error('Cero casas. Algo falla.');
    process.exit(1);
  }
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
