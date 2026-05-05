const { chromium } = require('playwright');
const fs = require('fs');

const ENTRY_URLS = [
  'https://mashogaresconbna.com.ar/list',
  'https://mashogaresconbna.com.ar/'
];

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function looksLikeProperty(o) {
  return o && typeof o === 'object'
    && (typeof o.lat === 'number' || typeof o.latitud === 'number')
    && (typeof o.lng === 'number' || typeof o.longitud === 'number' || typeof o.lon === 'number');
}

function findArraysWithProperties(node, out = []) {
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every(looksLikeProperty)) {
      out.push(node);
      return out;
    }
    for (const v of node) findArraysWithProperties(v, out);
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) findArraysWithProperties(node[k], out);
  }
  return out;
}

function tryParseJSON(text) {
  try { return JSON.parse(text); } catch {}
  // Server Actions de Next a veces devuelven multipart con líneas JSON
  const lines = text.split('\n').filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const idx = line.indexOf(':');
    const candidate = idx >= 0 ? line.slice(idx + 1).trim() : line.trim();
    try { parsed.push(JSON.parse(candidate)); } catch {}
  }
  return parsed.length ? parsed : null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'es-AR',
    viewport: { width: 1366, height: 900 }
  });
  const page = await ctx.newPage();

  const captured = [];
  const seenUrls = new Set();

  page.on('response', async (resp) => {
    const url = resp.url();
    const status = resp.status();
    if (status >= 400) return;
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json') && !ct.includes('text') && !ct.includes('javascript')) return;
    let text;
    try { text = await resp.text(); } catch { return; }
    if (text.length < 50) return;
    if (!/"lat"|"latitud"/.test(text)) return;
    if (!/"lng"|"longitud"|"lon"/.test(text)) return;
    captured.push({ url, status, ct, length: text.length, text });
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      console.log(`[capture] ${status} ${ct} ${text.length}b ${url}`);
    }
  });

  for (const entry of ENTRY_URLS) {
    console.log(`\n=== Visitando ${entry} ===`);
    try {
      await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.log(`navigation error: ${e.message}`);
      continue;
    }
    try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}

    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(3000);
  }

  await browser.close();

  console.log(`\nResponses capturadas: ${captured.length}`);

  const allProps = new Map();
  const debug = [];

  for (const c of captured) {
    const parsed = tryParseJSON(c.text);
    if (!parsed) {
      debug.push({ url: c.url, length: c.length, parsed: false, sample: c.text.slice(0, 300) });
      continue;
    }
    const arrays = findArraysWithProperties(parsed);
    debug.push({
      url: c.url,
      length: c.length,
      parsed: true,
      arraysFound: arrays.length,
      arraySizes: arrays.map(a => a.length),
      firstItemSample: arrays[0]?.[0] ? Object.keys(arrays[0][0]).slice(0, 30) : null
    });
    for (const arr of arrays) {
      for (const p of arr) {
        const id = p.id ?? p._id ?? p.codigo ?? `${p.lat ?? p.latitud},${p.lng ?? p.longitud ?? p.lon}`;
        allProps.set(String(id), p);
      }
    }
  }

  const merged = Array.from(allProps.values());
  console.log(`Propiedades únicas consolidadas: ${merged.length}`);

  fs.writeFileSync('data.json', JSON.stringify(merged, null, 2));
  fs.writeFileSync('debug-capture.json', JSON.stringify(debug, null, 2));

  if (captured.length > 0) {
    fs.writeFileSync('debug-raw-sample.json', captured[0].text.slice(0, 100000));
  }

  if (merged.length === 0) {
    console.error('No se capturaron propiedades. Revisar artifact debug-capture.json.');
    process.exit(1);
  }
})();
