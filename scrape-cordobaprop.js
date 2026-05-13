const fs = require('fs');

const BASE = 'https://cordobaprop.com';
const LIST_PATH = '/propiedades/?operaciones=1&tipos=1&localidades=1&order=relevancia&order_type=DESC&viewtype=list';
const PROVINCIA = 'Córdoba';
const FUENTE = 'cordobaprop';

const UA = 'Mozilla/5.0 Chrome/127';
const PAGE_SIZE = 20; // observed
const LIST_THROTTLE_MS = 350;
const DETAIL_THROTTLE_MS = 600;

const OUT_FILE = 'data-cordobaprop.json';
const COORDS_CACHE = 'cordobaprop-coords-cache.json';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);
const MAX_DETAIL = parseInt(process.env.MAX_DETAIL || '0', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-AR,es;q=0.9' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function decode(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function parsePrice(s) {
  if (!s) return null;
  // "Us$  97,000" → coma como miles
  const clean = String(s).replace(/[^0-9.,]/g, '').replace(/,/g, '');
  // si después de quitar comas hay puntos, asumirlos también miles si <=3 dígitos después
  const parts = clean.split('.');
  let n;
  if (parts.length > 1 && parts[parts.length-1].length === 3) {
    n = parseFloat(parts.join(''));
  } else {
    n = parseFloat(clean.replace(/\./g, ''));
  }
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDateLatam(s) {
  // "13-02-2026" → "2026-02-13"
  if (!s) return null;
  const m = String(s).match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseListPage(html) {
  // Cada card empieza con un <a> a "propiedad-id-XXXX-titulo-..." y termina antes del siguiente
  // Estrategia: dividir por marcador de id y para cada bloque extraer campos.
  const cardRegex = /<a href="(https?:\/\/cordobaprop\.com\/propiedad-id-(\d+)-titulo-[^"]+\.html)"[\s\S]*?Publicada el (\d{2}-\d{2}-\d{4})/g;
  const items = [];
  let m;
  while ((m = cardRegex.exec(html)) !== null) {
    const url = m[1];
    const id = parseInt(m[2], 10);
    const fecha = parseDateLatam(m[3]);
    const block = m[0];

    const tituloM = block.match(/<span class="" style="color:#333[^>]*>([^<]+)<\/span>/);
    const titulo = tituloM ? decode(tituloM[1]) : '';

    const subLocM = block.match(/fa-map-marker"><\/i>\s*([^<]+?)\s*-\s*([^<]+?)<\/span>/);
    const localidad = subLocM ? decode(subLocM[1]) : '';
    const ciudad = subLocM ? decode(subLocM[2]) : '';

    const dorBanM = block.match(/fa-bed"[^>]*><\/i>\s*(\d+)\s*\|\s*<i class="fa fa-shower"[^>]*><\/i>\s*(\d+)/);
    const dormitorios = dorBanM ? parseInt(dorBanM[1], 10) : null;
    const banos = dorBanM ? parseInt(dorBanM[2], 10) : null;

    const priceM = block.match(/<span style="font-size:20px[^>]*>\s*(U?s?\$|U\$S|\$)\s*([0-9., ]+)/i);
    const moneda = priceM && /U/i.test(priceM[1]) ? 'USD' : (priceM ? 'ARS' : 'USD');
    const precio = priceM ? parsePrice(priceM[2]) : null;

    const imgM = block.match(/data-src="(https:\/\/cordobaprop\.com\/content\/images\/[^"]+)"/);
    const imagen = imgM ? imgM[1] : null;

    items.push({
      id, url, titulo, localidad, ciudad,
      dormitorios, banos, precio, moneda,
      imagen, fechaCreacion: fecha
    });
  }
  return items;
}

async function fetchCoords(id) {
  const url = `${BASE}/propiedad-id-${id}-titulo-x.html`;
  let html;
  try { html = await fetchText(url); }
  catch (e) {
    // Algunos detail pages no aceptan slug arbitrario. Reintentamos sin titulo redirect.
    return null;
  }
  // Extraer del iframe: q=-31.3993,-64.1502
  const m = html.match(/maps\/embed\/v1\/place\?[^"]*q=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Validar dentro de Argentina-ish
  if (lat < -55 || lat > -21 || lng < -73 || lng > -53) return null;
  return { lat, lng };
}

function loadCache() {
  if (!fs.existsSync(COORDS_CACHE)) return {};
  try { return JSON.parse(fs.readFileSync(COORDS_CACHE, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(COORDS_CACHE, JSON.stringify(c)); } catch (e) { console.error('cache save fail:', e.message); }
}

(async () => {
  console.log('Bajando list view, paginado...');
  const cache = loadCache();
  console.log(`Cache coords: ${Object.keys(cache).length} ids`);

  const byId = new Map();
  let offset = 0;
  let pageNum = 0;
  let totalReported = null;

  while (true) {
    pageNum++;
    if (MAX_PAGES > 0 && pageNum > MAX_PAGES) break;

    const url = `${BASE}${LIST_PATH}&offset=${offset}`;
    let html;
    try { html = await fetchText(url); }
    catch (e) { console.error(`  pag ${pageNum} (offset=${offset}) ERROR: ${e.message}`); break; }

    if (totalReported == null) {
      const tm = html.match(/(\d+)\s+resultados/);
      if (tm) totalReported = parseInt(tm[1], 10);
    }

    const items = parseListPage(html);
    if (items.length === 0) break;

    const sizeBefore = byId.size;
    items.forEach(it => { if (!byId.has(String(it.id))) byId.set(String(it.id), it); });
    const added = byId.size - sizeBefore;

    if (pageNum % 10 === 0 || added === 0) {
      console.log(`  pag ${pageNum} (off=${offset}) items=${items.length} nuevos=${added} → únicos ${byId.size}${totalReported ? '/'+totalReported : ''}`);
    }

    // Terminar cuando no hay items nuevos (paginamos por offset; si ya rebotamos del fin, recibimos los mismos)
    if (added === 0) break;
    // O si ya cubrimos el total reportado
    if (totalReported && byId.size >= totalReported) break;

    offset += PAGE_SIZE;
    await sleep(LIST_THROTTLE_MS);
  }

  const all = [...byId.values()];
  console.log(`\nTotal cards: ${all.length}`);

  // Resolver coords (cache + fetch de detail page para los nuevos)
  const need = all.filter(it => !cache[it.id]);
  console.log(`Coords ya en cache: ${all.length - need.length}, a fetchear: ${need.length}`);
  if (MAX_DETAIL > 0 && need.length > MAX_DETAIL) {
    console.log(`  (MAX_DETAIL=${MAX_DETAIL} aplicado)`);
    need.length = MAX_DETAIL;
  }

  let hits = 0, misses = 0;
  for (let i = 0; i < need.length; i++) {
    const it = need[i];
    await sleep(DETAIL_THROTTLE_MS);
    let coords = null;
    try { coords = await fetchCoords(it.id); } catch {}
    if (coords) { cache[it.id] = coords; hits++; }
    else { cache[it.id] = null; misses++; }
    if ((i + 1) % 50 === 0) {
      console.log(`  detail ${i+1}/${need.length}: hits=${hits} misses=${misses}`);
      saveCache(cache);
    }
  }
  saveCache(cache);

  // Build final dataset (descartando los sin coords)
  const result = [];
  for (const it of all) {
    const c = cache[it.id];
    if (!c) continue;
    result.push({
      id: it.id,
      url: it.url,
      titulo: it.titulo,
      lat: c.lat,
      lng: c.lng,
      precio: it.precio,
      moneda: it.moneda,
      localidad: it.localidad || '',
      provincia: PROVINCIA,
      direccion: '',
      dormitorios: it.dormitorios,
      banos: it.banos,
      cocheras: null,
      superficieCubierta: null,
      superficieTotal: null,
      estado: '',
      disposicion: '',
      servicios: [],
      comodidades: [],
      imagen: it.imagen,
      fechaCreacion: it.fechaCreacion,
      fuente: FUENTE
    });
  }

  result.sort((a, b) => {
    const ta = a.fechaCreacion ? Date.parse(a.fechaCreacion) : 0;
    const tb = b.fechaCreacion ? Date.parse(b.fechaCreacion) : 0;
    return tb - ta;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(result));
  console.log(`\nFinal:`);
  console.log(`  Cards: ${all.length}`);
  console.log(`  Con coords: ${result.length}`);
  console.log(`  Sin coords (descartadas): ${all.length - result.length}`);
  console.log(`  ${OUT_FILE}: ${(fs.statSync(OUT_FILE).size/1024).toFixed(1)} KB`);
  console.log(`  ${COORDS_CACHE}: ${Object.keys(cache).length} entradas`);

  if (result.length === 0) {
    console.error('Cero items con coords. Algo falla.');
    process.exit(1);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
