const fs = require('fs');

const BASE = 'https://www.remax.com.ar';
const LISTING_PATH = '/listings/buy';
const IMG_CDN = 'https://d1acdg20u0pmxj.cloudfront.net';
const PROVINCIA = 'Córdoba';
const FUENTE = 'remax';
const TYPE_ID_CASA = 9;
const OPERATION_VENTA = 1;
const LOCATION_CORDOBA = 'in:CB@Córdoba::::::';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OUT_FILE = 'data-remax.json';

const PAGE_SIZE = 24;
const PAGE_THROTTLE_MS = 400;
const FETCH_TIMEOUT_MS = 30000;
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildUrl(page) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    sort: '-createdAt',
    'in:operationId': String(OPERATION_VENTA),
    'in:typeId': String(TYPE_ID_CASA),
    locations: LOCATION_CORDOBA,
    landingPath: 'comprar-propiedades',
    filterCount: '0',
    viewMode: 'listViewMode'
  });
  return `${BASE}${LISTING_PATH}?${params.toString()}`;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Remax embebe el state Angular SSR en <script id="ng-state" type="application/json">{...}</script>
// El JSON está envuelto en una key hash dinámica, así que extraemos el bloque entero y caminamos
// recursivamente buscando arrays cuyos elementos tengan el shape de un listing.
function extractListings(html) {
  const m = html.match(/<script\s+id="ng-state"\s+type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  let state;
  try { state = JSON.parse(m[1]); } catch { return []; }

  const found = [];
  const seen = new WeakSet();
  function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && isListing(node[0])) {
        for (const it of node) if (isListing(it)) found.push(it);
        return;
      }
      for (const v of node) walk(v);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  }
  walk(state);
  return found;
}

function isListing(o) {
  return o && typeof o === 'object'
    && typeof o.id === 'number'
    && typeof o.entityId === 'string'
    && o.location && Array.isArray(o.location.coordinates)
    && o.operation && o.currency && o.type;
}

function parseLocalidad(geoLabel) {
  if (!geoLabel) return '';
  const parts = String(geoLabel).split(',').map(s => s.trim()).filter(Boolean);
  return parts[0] || '';
}

function buildImage(listing) {
  const raw = listing.photos && listing.photos[0] && listing.photos[0].rawValue;
  if (!raw) return null;
  return `${IMG_CDN}/${raw}.jpg`;
}

function buildUrlListing(listing) {
  const slug = listing.slug || `${listing.type.value || 'propiedad'}-${listing.id}`;
  return `${BASE}/listings/${slug}-${listing.id}`;
}

function normalize(listing) {
  const coords = listing.location.coordinates;
  const lng = coords[0], lat = coords[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -55 || lat > -21 || lng < -73 || lng > -53) return null;

  const moneda = listing.currency && listing.currency.value === 'USD' ? 'USD'
              : listing.currency && listing.currency.value === 'ARS' ? 'ARS'
              : 'USD';
  const precio = listing.priceExposure === false ? null : listing.price;
  const dim = (k) => Number.isFinite(listing[k]) && listing[k] > 0 ? listing[k] : null;
  const superficieCubierta = dim('dimensionCovered');
  // dimensionTotalBuilt: superficie cubierta total (incl. semicubiertos). dimensionLand: terreno.
  // Para "superficie total" preferimos terreno cuando hay; si no, total construido.
  const superficieTotal = dim('dimensionLand') || dim('dimensionTotalBuilt');

  return {
    id: listing.id,
    url: buildUrlListing(listing),
    titulo: listing.title || '',
    lat,
    lng,
    precio,
    moneda,
    localidad: parseLocalidad(listing.geoLabel),
    provincia: PROVINCIA,
    direccion: listing.displayAddress || '',
    dormitorios: Number.isFinite(listing.bedrooms) ? listing.bedrooms : null,
    banos: Number.isFinite(listing.bathrooms) ? listing.bathrooms : null,
    cocheras: null,
    superficieCubierta,
    superficieTotal,
    estado: '',
    disposicion: '',
    servicios: [],
    comodidades: [],
    imagen: buildImage(listing),
    fechaCreacion: null,
    fuente: FUENTE
  };
}

(async () => {
  const byId = new Map();
  let page = 0;
  const hardLimit = MAX_PAGES > 0 ? MAX_PAGES : 200; // safety cap

  while (page < hardLimit) {
    const url = buildUrl(page);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.error(`  page ${page} ERROR: ${e.message}`);
      break;
    }
    const listings = extractListings(html);
    const beforeSize = byId.size;
    for (const l of listings) byId.set(l.id, l);
    const newOnes = byId.size - beforeSize;
    console.log(`  page ${page}: listings=${listings.length} new=${newOnes} totalUnicos=${byId.size} htmlBytes=${html.length}`);

    if (listings.length === 0) break;
    if (listings.length < PAGE_SIZE) { page++; break; }
    if (newOnes === 0) break; // safety: no agregamos nada, evitamos loop infinito

    page++;
    await sleep(PAGE_THROTTLE_MS);
  }

  const items = [...byId.values()];
  console.log(`\nListings únicos: ${items.length}`);

  const result = [];
  let geoOk = 0, geoBad = 0;
  for (const l of items) {
    const r = normalize(l);
    if (r) { result.push(r); geoOk++; }
    else geoBad++;
  }
  console.log(`  con coords válidas: ${geoOk}`);
  console.log(`  descartados (sin coords): ${geoBad}`);

  fs.writeFileSync(OUT_FILE, JSON.stringify(result));
  console.log(`${OUT_FILE}: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);

  if (result.length === 0) {
    console.error('Cero propiedades. Algo falla.');
    process.exit(1);
  }
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
