const fs = require('fs');
const { chromium } = require('playwright');

const BASE = 'https://inmuebles.mercadolibre.com.ar';
const FUENTE = 'meli';
const PROVINCIA = 'Córdoba';
const OUT_FILE = 'data-meli.json';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT_MS = 60000;
const LISTING_WAIT_MS = 15000;
const PAGE_THROTTLE_MS = 4000; // ML rate-limita agresivamente; ir despacio es la diferencia entre exit 0 y bloqueo

const CARDS_PER_PAGE = 100;       // ML lista hasta 100 por página
const MAX_PAGES_PER_BBOX = 10;    // 10 páginas = 1000 items. Más allá, subdividimos.
const MAX_SUBDIVISION_DEPTH = 4;  // capital se subdivide hasta 4 niveles si hace falta
// ML rechaza bboxes muy grandes (devuelve 0 cards). Cualquier bbox con área > este
// umbral que devuelva 0 lo subdividimos igual — recién aceptamos "vacío" si es chico.
const MIN_AREA_TO_TRUST_ZERO = 0.015; // ≈ 0.12° × 0.12°, ≈ 13km × 13km

const MAX_BBOXES = parseInt(process.env.MAX_BBOXES || '0', 10); // 0 = sin límite

// Grilla inicial: capital + alrededores. Cada bbox aprox 10-15km de lado.
const SEED_BBOXES = [
  // Capital de Córdoba, cuadrantes
  { name: 'cap-NO', latLo: -31.43, latHi: -31.30, lonLo: -64.30, lonHi: -64.20 },
  { name: 'cap-NE', latLo: -31.43, latHi: -31.30, lonLo: -64.20, lonHi: -64.10 },
  { name: 'cap-SO', latLo: -31.55, latHi: -31.43, lonLo: -64.30, lonHi: -64.20 },
  { name: 'cap-SE', latLo: -31.55, latHi: -31.43, lonLo: -64.20, lonHi: -64.10 },
  // Sierras Chicas (Villa Allende, Mendiolaza, Unquillo, Río Ceballos)
  { name: 'sierras-chicas', latLo: -31.30, latHi: -31.13, lonLo: -64.40, lonHi: -64.25 },
  // La Calera, Saldán, Argüello
  { name: 'la-calera',      latLo: -31.40, latHi: -31.30, lonLo: -64.45, lonHi: -64.30 },
  // Villa Carlos Paz + Punilla cercano
  { name: 'carlos-paz',     latLo: -31.50, latHi: -31.35, lonLo: -64.60, lonHi: -64.45 },
  // Sur capital extendido (Malagueño, Alta Gracia)
  { name: 'sur-extendido',  latLo: -31.75, latHi: -31.55, lonLo: -64.45, lonHi: -64.20 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildUrl(bbox, offset = 1) {
  // ML usa `_DisplayType_M_item*location_lat:LO*HI,lon:LO*HI`
  // Paginación: `..._Desde_{offset}` (page 2 → _Desde_101, page 3 → _Desde_201)
  const path = `/casas/venta/_DisplayType_M_item*location_lat:${bbox.latLo}*${bbox.latHi},lon:${bbox.lonLo}*${bbox.lonHi}`;
  const pag = offset > 1 ? `_Desde_${offset}` : '';
  return `${BASE}${path}${pag}`;
}

class BlockedError extends Error {
  constructor(landedAt) { super(`ML bloqueó la sesión (redirect a ${landedAt})`); this.landedAt = landedAt; }
}

async function fetchPageItems(page, bbox, offset) {
  const url = buildUrl(bbox, offset);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const landed = page.url();
  // Si ML nos mete redirect a account-verification / login, está pidiendo auth.
  // No tiene sentido seguir; abortamos sin sobrescribir el archivo bueno.
  if (/account-verification|\/login|\/registration/.test(landed)) {
    throw new BlockedError(landed);
  }
  try {
    await page.waitForSelector('.ui-search-layout__item', { timeout: LISTING_WAIT_MS });
  } catch {
    return { items: [] };
  }
  await sleep(400);
  // El SSR de ML mete el state en `<script id="__NORDIC_RENDERING_CTX__">` como
  // `_n.ctx.r = {...}`. La forma robusta es leer la global directamente: el script
  // ya corrió, así que `window._n.ctx.r` es el objeto ya parseado.
  const ctx = await page.evaluate(() => {
    try { return (window._n && window._n.ctx && window._n.ctx.r) || null; } catch (e) { return null; }
  });
  if (!ctx) return { items: [] };

  // Path al array de items: state.pageState.initialState.results (aprox).
  // El walk recursivo busca el PRIMER array cuyos elementos sean
  // { id: "POLYCARD", polycard: {...} }. ML referencia el mismo array desde varios
  // sub-objetos del state, así que paramos al primer hit para no duplicar trabajo.
  const items = [];
  const seen = new WeakSet();
  function walk(node) {
    if (items.length) return true; // early exit
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object' && node[0].id === 'POLYCARD' && node[0].polycard) {
        for (const it of node) if (it && it.polycard) items.push(it.polycard);
        return true;
      }
      for (const v of node) if (walk(v)) return true;
      return false;
    }
    for (const k of Object.keys(node)) if (walk(node[k])) return true;
    return false;
  }
  walk(ctx);
  return { items };
}

function numFromAttr(text) {
  if (!text) return null;
  const m = String(text).match(/(\d[\d.,]*)/);
  if (!m) return null;
  return parseInt(m[1].replace(/[.,]/g, ''), 10);
}

function mapItem(p) {
  const meta = p.metadata || {};
  const lat = parseFloat(meta.latitude);
  const lng = parseFloat(meta.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -55 || lat > -21 || lng < -73 || lng > -53) return null;

  // url y id
  const id = meta.id ? meta.id.replace(/^MLA/, '') : null;
  if (!id) return null;
  let url = meta.url || '';
  if (url && !/^https?:/.test(url)) url = 'https://' + url;

  // components: title, price, attributes_list, location
  let titulo = '', precio = null, moneda = 'USD';
  let direccion = '', localidad = '';
  let dormitorios = null, banos = null, superficieCubierta = null, superficieTotal = null;
  for (const c of (p.components || [])) {
    if (c.type === 'title' && c.title) titulo = c.title.text || titulo;
    else if (c.type === 'price' && c.price && c.price.current_price) {
      precio = Number.isFinite(c.price.current_price.value) ? c.price.current_price.value : null;
      moneda = c.price.current_price.currency || moneda;
    }
    else if (c.type === 'attributes_list' && c.attributes_list && Array.isArray(c.attributes_list.texts)) {
      for (const t of c.attributes_list.texts) {
        if (/dormitorio/i.test(t)) dormitorios = numFromAttr(t);
        else if (/baño/i.test(t)) banos = numFromAttr(t);
        else if (/m².*(cubier|cub\.)/i.test(t)) superficieCubierta = numFromAttr(t);
        else if (/m².*(tota|terr)/i.test(t)) superficieTotal = numFromAttr(t);
        else if (/^\d+\s*m²/i.test(t) && superficieCubierta == null) superficieCubierta = numFromAttr(t);
      }
    }
    else if (c.type === 'location' && c.location) direccion = c.location.text || direccion;
  }
  // Fallback localidad: si direccion tiene ", X, Córdoba" o similar
  if (direccion) {
    const parts = direccion.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) localidad = parts[parts.length - 2] || parts[0];
    else localidad = parts[0] || '';
  }

  // imagen
  let imagen = null;
  const pics = p.pictures && p.pictures.pictures;
  if (pics && pics[0] && pics[0].id) {
    // ML imágenes: `https://http2.mlstatic.com/D_NQ_NP_{id}-O.webp` u otras variantes.
    // El formato `${id}-O.webp` (original) suele funcionar; alternativo `${id}-V.webp` (vertical).
    imagen = `https://http2.mlstatic.com/D_NQ_NP_${pics[0].id}-O.webp`;
  }

  return {
    id: parseInt(id, 10) || id,
    url,
    titulo,
    lat,
    lng,
    precio,
    moneda,
    localidad,
    provincia: PROVINCIA,
    direccion,
    dormitorios,
    banos,
    cocheras: null,
    superficieCubierta,
    superficieTotal,
    estado: '',
    disposicion: '',
    servicios: [],
    comodidades: [],
    imagen,
    fechaCreacion: null,
    fuente: FUENTE
  };
}

function subdivide(bbox) {
  const latMid = (bbox.latLo + bbox.latHi) / 2;
  const lonMid = (bbox.lonLo + bbox.lonHi) / 2;
  return [
    { name: `${bbox.name}-1`, latLo: bbox.latLo,  latHi: latMid,     lonLo: bbox.lonLo, lonHi: lonMid     },
    { name: `${bbox.name}-2`, latLo: bbox.latLo,  latHi: latMid,     lonLo: lonMid,     lonHi: bbox.lonHi },
    { name: `${bbox.name}-3`, latLo: latMid,      latHi: bbox.latHi, lonLo: bbox.lonLo, lonHi: lonMid     },
    { name: `${bbox.name}-4`, latLo: latMid,      latHi: bbox.latHi, lonLo: lonMid,     lonHi: bbox.lonHi },
  ];
}

(async () => {
  console.log('Lanzando Chromium headless...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'es-AR',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8' }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-AR', 'es', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();

  // BFS sobre bboxes: cada uno se exhauste por paginación. Si llega al cap, subdividimos.
  const queue = SEED_BBOXES.map(b => ({ ...b, depth: 0 }));
  const byId = new Map();
  let bboxCount = 0;
  let blocked = false;

  outer: while (queue.length) {
    const bbox = queue.shift();
    bboxCount++;
    if (MAX_BBOXES > 0 && bboxCount > MAX_BBOXES) {
      console.log(`Alcanzado MAX_BBOXES=${MAX_BBOXES}, corto.`);
      break;
    }
    console.log(`\n[bbox ${bboxCount}] ${bbox.name} (depth=${bbox.depth}) lat=${bbox.latLo}..${bbox.latHi} lon=${bbox.lonLo}..${bbox.lonHi}`);

    let pageNum = 1;
    let saturated = false;
    let firstPageEmpty = false;
    while (pageNum <= MAX_PAGES_PER_BBOX) {
      const offset = (pageNum - 1) * CARDS_PER_PAGE + 1;
      let items;
      try {
        ({ items } = await fetchPageItems(page, bbox, offset));
      } catch (e) {
        if (e instanceof BlockedError) {
          console.error(`  ${e.message}`);
          blocked = true;
          break outer;
        }
        throw e;
      }
      const beforeSize = byId.size;
      let mapped = 0;
      for (const it of items) {
        const r = mapItem(it);
        if (r) { byId.set(r.id, r); mapped++; }
      }
      const newOnes = byId.size - beforeSize;
      console.log(`  page ${pageNum} (offset=${offset}): cards=${items.length} mapped=${mapped} new=${newOnes} totalUnicos=${byId.size}`);
      if (items.length === 0) {
        if (pageNum === 1) firstPageEmpty = true;
        break;
      }
      if (items.length < CARDS_PER_PAGE) break;
      // Saturado en la última página permitida
      if (pageNum === MAX_PAGES_PER_BBOX && items.length >= CARDS_PER_PAGE) saturated = true;
      pageNum++;
      await sleep(PAGE_THROTTLE_MS);
    }

    const area = (bbox.latHi - bbox.latLo) * (bbox.lonHi - bbox.lonLo);
    const tooBigForZero = firstPageEmpty && area > MIN_AREA_TO_TRUST_ZERO;
    if ((saturated || tooBigForZero) && bbox.depth < MAX_SUBDIVISION_DEPTH) {
      const subs = subdivide(bbox).map(b => ({ ...b, depth: bbox.depth + 1 }));
      const reason = saturated ? 'SATURADO' : `VACÍO con bbox grande (área ${area.toFixed(3)})`;
      console.log(`  → ${reason}, subdivido en 4 (${subs.map(s => s.name).join(', ')})`);
      queue.unshift(...subs);
    }
  }

  await browser.close();

  const items = [...byId.values()];
  console.log(`\nFinal:`);
  console.log(`  Bboxes recorridos: ${bboxCount}`);
  console.log(`  Items únicos con coords: ${items.length}`);
  console.log(`  Bloqueado por ML: ${blocked}`);

  // Si nos bloquearon (o juntamos poquito) NO sobrescribimos el archivo bueno
  // anterior. El cron del workflow tiene continue-on-error: hoy fallamos, mañana
  // hay otra chance, y mientras tanto el frontend sigue mostrando el último válido.
  const MIN_ITEMS_TO_WRITE = 100;
  if (items.length < MIN_ITEMS_TO_WRITE) {
    console.error(`Solo ${items.length} items (< ${MIN_ITEMS_TO_WRITE}). No sobrescribo ${OUT_FILE}.`);
    process.exit(1);
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(items));
  console.log(`  ${OUT_FILE}: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
