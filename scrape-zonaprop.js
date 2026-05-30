const fs = require('fs');
const { chromium } = require('playwright');

const BASE = 'https://www.zonaprop.com.ar';
const PROVINCIA = 'Córdoba';
const FUENTE = 'zonaprop';
const OUT_FILE = 'data-zonaprop.json';

// Zonaprop pone Cloudflare Turnstile delante de cualquier nav. La p1 trae el state inline
// en <script>window.__PRELOADED_STATE__ = {...}</script> y se puede extraer del HTML raw,
// pero p2+ dispara un challenge JS que Playwright headless básico no resuelve. Por eso
// solo scrapeamos la p1 (los ~30 listings más recientes) y mergeamos con el archivo
// previo: cada refresh suma los nuevos y refresca los existentes; el histórico se
// preserva entre runs.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT_MS = 60000;

function pageUrl() {
  return `${BASE}/casas-venta-cordoba.html?vista=mapa`;
}

function extractState(html) {
  // El bundle de Next.js consume window.__PRELOADED_STATE__ y lo limpia tras hidratar,
  // por eso NO sirve leerlo via page.evaluate. Lo extraemos del HTML raw inline.
  const m = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*window\./);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function fetchHtmlBrowser(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  return await page.content();
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

function loadPrevious() {
  if (!fs.existsSync(OUT_FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error(`No pude leer ${OUT_FILE}: ${e.message}`);
    return [];
  }
}

async function tryFetchState() {
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
    const origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      window.navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);
    }
  });
  const page = await context.newPage();
  try {
    const html = await fetchHtmlBrowser(page, pageUrl());
    return { state: extractState(html), htmlBytes: html.length };
  } finally {
    await browser.close();
  }
}

(async () => {
  const previous = loadPrevious();
  console.log(`Previo en disco: ${previous.length} items`);

  // Datadome bloquea por IP. En GH Actions los runners rotan IPs entre runs, pero
  // dentro de un mismo run podemos reintentar varias veces: a veces el segundo
  // navegador "fresh" pasa porque Cloudflare ajusta su scoring tras unos segundos.
  const MAX_ATTEMPTS = 4;
  let state = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Bajando página 1... (intento ${attempt}/${MAX_ATTEMPTS})`);
    try {
      const r = await tryFetchState();
      if (r.state) { state = r.state; break; }
      console.log(`  Sin PRELOADED_STATE (htmlBytes=${r.htmlBytes}); probablemente Datadome challenge.`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    if (attempt < MAX_ATTEMPTS) {
      const wait = 5000 + attempt * 5000; // 10s, 15s, 20s
      console.log(`  Esperando ${wait/1000}s antes de reintentar...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  if (!state) throw new Error(`No pude extraer PRELOADED_STATE tras ${MAX_ATTEMPTS} intentos`);

  const totalPosts = state.listStore?.paging?.total || 0;
  const totalPages = state.listStore?.paging?.totalPages || 1;
  console.log(`Total reportado por Zonaprop: ${totalPosts} casas en ${totalPages} páginas (solo bajamos p1).`);

  const fresh = [];
  let geoOk = 0, geoSkip = 0;
  for (const post of (state.listStore.listPostings || [])) {
    const mapped = mapPost(post);
    if (mapped) { fresh.push(mapped); geoOk++; }
    else geoSkip++;
  }
  console.log(`p1: ${geoOk} con coords, ${geoSkip} descartados`);

  // Merge acumulativo: los frescos pisan a los previos con mismo id (precio/datos pueden
  // haber cambiado), los previos que no aparecen quedan tal cual.
  const byId = new Map();
  for (const it of previous) byId.set(String(it.id), it);
  let updated = 0, added = 0;
  for (const it of fresh) {
    const k = String(it.id);
    if (byId.has(k)) updated++; else added++;
    byId.set(k, it);
  }
  const items = [...byId.values()];

  // Orden: más recientes primero.
  items.sort((a, b) => {
    const ta = a.fechaCreacion ? Date.parse(a.fechaCreacion) : 0;
    const tb = b.fechaCreacion ? Date.parse(b.fechaCreacion) : 0;
    return tb - ta;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(items));
  console.log(`\nFinal:`);
  console.log(`  Nuevos en p1: ${added}`);
  console.log(`  Refrescados: ${updated}`);
  console.log(`  Total acumulado: ${items.length}`);
  console.log(`  ${OUT_FILE}: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);

  if (items.length === 0) {
    console.error('Cero items. Algo falla.');
    process.exit(1);
  }
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
