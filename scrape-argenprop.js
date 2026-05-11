const fs = require('fs');

const BASE = 'https://www.argenprop.com';
const LISTING_PATH = '/casas/venta/cordoba';
const PROVINCIA = 'Córdoba';
const FUENTE = 'argenprop';

const UA_BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const NOMINATIM_UA = 'bna-hogares-map/0.1 (https://github.com/ingfrancoluna/bna-hogares-map; fluna@pagos360.com)';

const OUT_FILE = 'data-argenprop.json';
const CACHE_FILE = 'geocode-cache.json';

const PAGE_THROTTLE_MS = 500;
const NOMINATIM_THROTTLE_MS = 1100;
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA_BROWSER,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-AR,es;q=0.9'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.text();
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#xA;/g, '\n')
    .replace(/&#xB2;/g, '²')
    .replace(/&#xE9;/g, 'é').replace(/&#xE1;/g, 'á').replace(/&#xED;/g, 'í').replace(/&#xF3;/g, 'ó').replace(/&#xFA;/g, 'ú')
    .replace(/&#xC9;/g, 'É').replace(/&#xC1;/g, 'Á').replace(/&#xCD;/g, 'Í').replace(/&#xD3;/g, 'Ó').replace(/&#xDA;/g, 'Ú')
    .replace(/&#xF1;/g, 'ñ').replace(/&#xD1;/g, 'Ñ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
}

function parseTotalPages(html) {
  const m = html.match(/([\d.,]+)\s+Casas/i);
  if (!m) return 1;
  const total = parseInt(m[1].replace(/[.,]/g, ''), 10);
  return Math.max(1, Math.ceil(total / 20));
}

function parseCards(html) {
  const re = /<div class="listing__item[^"]*"\s+id="(\d+)"[\s\S]*?<\/a>\s*<div data-ignored-card/g;
  const items = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const cardHtml = m[0];
    const item = parseCard(cardHtml, id);
    if (item) items.push(item);
  }
  return items;
}

function parseCard(html, id) {
  const numAttr = (re) => { const m = html.match(re); return m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : null; };
  const monto = numAttr(/montonormalizado="(\d+)"/);
  const monedaId = numAttr(/idmoneda="(\d+)"/);
  const moneda = monedaId === 2 ? 'USD' : monedaId === 1 ? 'ARS' : 'USD';
  const dormiAttr = numAttr(/\bdormitorios="(\d+)"/);

  const street = (() => {
    const m = html.match(/data-card-direccion[^>]*>\s*([^<]+?)\s*<\/p>/);
    return m ? decodeEntities(m[1]) : '';
  })();
  const locTitle = (() => {
    const m = html.match(/card__title--primary"[^>]*>\s*([^<]+)/);
    return m ? decodeEntities(m[1]) : '';
  })();

  const m2cubM = html.match(/(\d+)\s*m&#xB2;\s*cubie/);
  const m2totM = html.match(/(\d+)\s*m&#xB2;\s*tot/);
  const m2terrM = html.match(/(\d+)\s*m&#xB2;\s*terr/);
  const dormM = html.match(/(\d+)\s*dorm\./);
  const banosM = html.match(/(\d+)\s*ba&#xF1;os?/);
  const cochM = html.match(/(\d+)\s*coch/i);

  const tituloM = html.match(/<h2 class="card__title">([\s\S]*?)<\/h2>/);
  const titulo = tituloM ? decodeEntities(tituloM[1]) : '';

  const imgM = html.match(/<img[^>]+(?:src|data-src)="(https:\/\/www\.argenprop\.com\/static-content\/[^"]+)"/);
  let imagen = imgM ? imgM[1] : null;
  if (imagen) imagen = imagen.replace(/_u_small\./, '_u_medium.');

  let localidad = '';
  if (locTitle) {
    // Patrón típico: "Casa en Venta en <LOCALIDAD>, <CIUDAD/PROVINCIA>"
    // Buscar el ÚLTIMO " en " y tomar lo que sigue hasta la primera coma.
    const idx = locTitle.lastIndexOf(' en ');
    if (idx >= 0) {
      const tail = locTitle.slice(idx + 4);
      const m = tail.match(/^([^,]+)/);
      if (m) localidad = m[1].trim();
    }
    if (!localidad) {
      const parts = locTitle.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) localidad = parts[parts.length - 2];
    }
  }

  return {
    id: parseInt(id, 10),
    titulo: titulo || locTitle,
    precio: monto,
    moneda,
    dormitorios: dormM ? parseInt(dormM[1], 10) : dormiAttr,
    banos: banosM ? parseInt(banosM[1], 10) : null,
    cocheras: cochM ? parseInt(cochM[1], 10) : null,
    superficieCubierta: m2cubM ? parseInt(m2cubM[1], 10) : null,
    superficieTotal: m2totM ? parseInt(m2totM[1], 10) : (m2terrM ? parseInt(m2terrM[1], 10) : null),
    direccion: street,
    localidad,
    locTitle,
    imagen
  };
}

function buildQueries(item) {
  const queries = [];
  const street = (item.direccion || '').trim();
  const loc = (item.localidad || '').trim();
  const cleanStreet = street.replace(/\s+(s\/n|sn)$/i, '').replace(/^\s*-\s*/, '').trim();
  if (cleanStreet && loc) queries.push(`${cleanStreet}, ${loc}, Córdoba, Argentina`);
  if (cleanStreet) queries.push(`${cleanStreet}, Córdoba, Argentina`);
  if (loc) queries.push(`${loc}, Córdoba, Argentina`);
  return [...new Set(queries.filter(Boolean))];
}

async function nominatimFetch(query) {
  const url = `${NOMINATIM}/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'es-AR' }
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let arr;
  try { arr = await res.json(); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  const lat = parseFloat(arr[0].lat), lng = parseFloat(arr[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -55 || lat > -21 || lng < -73 || lng > -53) return null;
  return { lat, lng };
}

async function geocode(item, cache) {
  const queries = buildQueries(item);
  if (!queries.length) return null;
  for (const q of queries) {
    if (cache[q] !== undefined) {
      if (cache[q]) return cache[q];
      continue;
    }
    await sleep(NOMINATIM_THROTTLE_MS);
    const result = await nominatimFetch(q);
    cache[q] = result;
    if (result) return result;
  }
  return null;
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (e) { console.error('No pude guardar cache:', e.message); }
}

(async () => {
  const cache = loadCache();
  console.log(`Cache geocoding: ${Object.keys(cache).length} entradas`);

  console.log('Bajando primera página...');
  const firstHtml = await fetchHtml(`${BASE}${LISTING_PATH}?pagina-1`);
  let totalPages = parseTotalPages(firstHtml);
  if (MAX_PAGES > 0) totalPages = Math.min(totalPages, MAX_PAGES);
  console.log(`Páginas a recorrer: ${totalPages}`);

  const byId = new Map();
  parseCards(firstHtml).forEach(c => byId.set(c.id, c));

  for (let p = 2; p <= totalPages; p++) {
    await sleep(PAGE_THROTTLE_MS);
    try {
      const html = await fetchHtml(`${BASE}${LISTING_PATH}?pagina-${p}`);
      const cards = parseCards(html);
      cards.forEach(c => byId.set(c.id, c));
      if (p % 10 === 0 || p === totalPages) console.log(`  page ${p}/${totalPages} → total únicos ${byId.size}`);
    } catch (e) {
      console.error(`  page ${p} ERROR:`, e.message);
    }
  }

  const items = [...byId.values()];
  console.log(`\nCards únicas: ${items.length}`);

  let geoHits = 0, geoMisses = 0;
  const result = [];
  let cacheDirty = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cacheBefore = Object.keys(cache).length;
    const coords = await geocode(item, cache);
    if (Object.keys(cache).length !== cacheBefore) cacheDirty++;

    if (coords) {
      geoHits++;
      result.push({
        id: item.id,
        titulo: item.titulo || item.locTitle || '',
        lat: coords.lat,
        lng: coords.lng,
        precio: item.precio,
        moneda: item.moneda,
        localidad: item.localidad || '',
        provincia: PROVINCIA,
        direccion: item.direccion || '',
        dormitorios: item.dormitorios,
        banos: item.banos,
        cocheras: item.cocheras,
        superficieCubierta: item.superficieCubierta,
        superficieTotal: item.superficieTotal,
        estado: '',
        disposicion: '',
        servicios: [],
        comodidades: [],
        imagen: item.imagen,
        fechaCreacion: null,
        fuente: FUENTE
      });
    } else {
      geoMisses++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${items.length}: hits=${geoHits} misses=${geoMisses} cache=${Object.keys(cache).length}`);
      if (cacheDirty > 0) { saveCache(cache); cacheDirty = 0; }
    }
  }

  saveCache(cache);

  console.log(`\nFinal:`);
  console.log(`  Total cards: ${items.length}`);
  console.log(`  Geocodificadas: ${geoHits}`);
  console.log(`  Sin coords (descartadas): ${geoMisses}`);
  console.log(`  Tasa éxito: ${(geoHits / items.length * 100).toFixed(1)}%`);

  fs.writeFileSync(OUT_FILE, JSON.stringify(result));
  console.log(`${OUT_FILE}: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);
  console.log(`${CACHE_FILE}: ${Object.keys(cache).length} entradas`);

  if (result.length === 0) {
    console.error('Cero propiedades con coords. Algo falla.');
    process.exit(1);
  }
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
