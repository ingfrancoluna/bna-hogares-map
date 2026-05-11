const fs = require('fs');

const BASE = 'https://www.zonaprop.com.ar';
const PROVINCIA = 'Córdoba';
const FUENTE = 'zonaprop';
const OUT_FILE = 'data-zonaprop.json';

const UA = 'Mozilla/5.0 Chrome/127';
const PAGE_THROTTLE_MS = 600;
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pageUrl(n) {
  return n === 1
    ? `${BASE}/casas-venta-cordoba.html?vista=mapa`
    : `${BASE}/casas-venta-cordoba-pagina-${n}.html?vista=mapa`;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.text();
}

function extractState(html) {
  const m = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*window\./);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapPost(post) {
  const geo = post.postingLocation?.postingGeolocation?.geolocation;
  if (!geo || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) return null;

  const op = (post.priceOperationTypes || [])[0];
  const priceObj = op && op.prices && op.prices[0];
  const precio = priceObj ? num(priceObj.amount) : null;
  const moneda = priceObj ? priceObj.currency : 'USD';

  const loc = post.postingLocation?.location;
  // location es la zona/barrio; parent suele ser la ciudad
  const localidad = (loc && loc.parent && loc.parent.name) || (loc && loc.name) || '';

  const direccion = (post.postingLocation?.address?.name) || '';

  const mf = post.mainFeatures || {};
  const dormitorios = num(mf.CFT2?.value);
  const banos = num(mf.CFT3?.value);
  const cocheras = num(mf.CFT7?.value);
  const superficieCubierta = num(mf.CFT101?.value);
  const superficieTotal = num(mf.CFT100?.value);

  const pic = post.visiblePictures?.pictures?.[0];
  const imagen = pic ? (pic.url360x266 || pic.url730x532 || null) : null;

  let url = post.url || null;
  if (url && !/^https?:/.test(url)) url = BASE + url;

  return {
    id: num(post.postingId) || post.postingId,
    url,
    titulo: post.title || '',
    lat: geo.latitude,
    lng: geo.longitude,
    precio,
    moneda,
    localidad,
    provincia: PROVINCIA,
    direccion,
    dormitorios,
    banos,
    cocheras,
    superficieCubierta,
    superficieTotal,
    estado: '',
    disposicion: '',
    servicios: [],
    comodidades: [],
    imagen,
    fechaCreacion: post.modified_date || null,
    fuente: FUENTE
  };
}

(async () => {
  console.log('Bajando página 1...');
  const firstHtml = await fetchHtml(pageUrl(1));
  const firstState = extractState(firstHtml);
  if (!firstState) throw new Error('No pude extraer PRELOADED_STATE de la página 1');

  let totalPages = firstState.listStore?.paging?.totalPages || 1;
  const totalPosts = firstState.listStore?.paging?.total || 0;
  if (MAX_PAGES > 0) totalPages = Math.min(totalPages, MAX_PAGES);
  console.log(`Total: ${totalPosts} casas, ${firstState.listStore?.paging?.totalPages} páginas. Voy por ${totalPages}.`);

  const byId = new Map();
  let geoOk = 0, geoSkip = 0;

  function processPosts(posts) {
    for (const post of (posts || [])) {
      const mapped = mapPost(post);
      if (mapped) { byId.set(String(mapped.id), mapped); geoOk++; }
      else geoSkip++;
    }
  }

  processPosts(firstState.listStore.listPostings);

  for (let p = 2; p <= totalPages; p++) {
    await sleep(PAGE_THROTTLE_MS);
    try {
      const html = await fetchHtml(pageUrl(p));
      const state = extractState(html);
      if (!state) { console.error(`  page ${p}: sin state`); continue; }
      processPosts(state.listStore.listPostings);
      if (p % 20 === 0 || p === totalPages) {
        console.log(`  page ${p}/${totalPages} → únicos ${byId.size} (ok=${geoOk}, skip=${geoSkip})`);
      }
    } catch (e) {
      console.error(`  page ${p} ERROR:`, e.message);
    }
  }

  const items = [...byId.values()];
  // más recientes primero
  items.sort((a, b) => {
    const ta = a.fechaCreacion ? Date.parse(a.fechaCreacion) : 0;
    const tb = b.fechaCreacion ? Date.parse(b.fechaCreacion) : 0;
    return tb - ta;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(items));
  console.log(`\nFinal:`);
  console.log(`  Posts con coords: ${geoOk}`);
  console.log(`  Posts sin coords (descartados): ${geoSkip}`);
  console.log(`  Únicos por id: ${items.length}`);
  console.log(`  ${OUT_FILE}: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);

  if (items.length === 0) {
    console.error('Cero items. Algo falla.');
    process.exit(1);
  }
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
