// Public map page. Data comes from window.SITE (inlined by wvc/site_build.py) and three JSON files:
// data/segments.json (first paint), data/details.json (after first paint), data/crashes.json (first time zoomed in).
'use strict';
const S = window.SITE;
const $ = q => document.querySelector(q);
const CRASH_MINZOOM = 9;

// ---------------- small helpers ----------------
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
function readHash() {
  const o = {};
  location.hash.slice(1).split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
  return o;
}
const HASH = readHash();
let busyN = 0;
function busy(d) { busyN = Math.max(0, busyN + d); document.body.classList.toggle('busy', busyN > 0); }
async function getJSON(url) {
  busy(1);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return await r.json();
  } finally { busy(-1); }
}
const fmtInt = v => Math.round(v).toLocaleString('en-US');
const fmtX = v => v >= 10 ? Math.round(v) + '×' : v >= 1 ? v.toFixed(1) + '×' : v.toFixed(2) + '×';
const isPhone = () => window.matchMedia('(max-width: 700px)').matches;
// The spot of a road line nearest `near` ([lng, lat]), else its middle, and the road's compass heading there.
function nearestOnLine(coords, near) {
  const k = Math.cos(coords[0][1] * Math.PI / 180);   // degrees of longitude are shorter than of latitude
  let best = { d: Infinity, p: coords[Math.floor(coords.length / 2)], j: Math.max(0, Math.floor(coords.length / 2) - 1) };
  if (near) for (let j = 0; j + 1 < coords.length; j++) {
    const [a, b] = [coords[j], coords[j + 1]], dx = (b[0] - a[0]) * k, dy = b[1] - a[1];
    const u = Math.max(0, Math.min(1, ((near[0] - a[0]) * k * dx + (near[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const p = [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])], d = ((p[0] - near[0]) * k) ** 2 + (p[1] - near[1]) ** 2;
    if (d < best.d) best = { d, p, j };
  }
  const [a, b] = [coords[best.j], coords[Math.min(best.j + 1, coords.length - 1)]];
  return { p: best.p, d: best.d, heading: Math.round((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180 / Math.PI + 360) % 360) };
}
// Google Maps URL (no key needed): opens Google's street-level photo nearest to the point, looking along `heading` if given.
const panoURL = (p, heading) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p[1].toFixed(6)},${p[0].toFixed(6)}` +
  (heading == null ? '' : `&heading=${heading}`);
// The point is the spot of the stretch nearest `near` (where the viewer clicked), else its middle.
function streetViewURL(coords, near) { const r = nearestOnLine(coords, near); return panoURL(r.p, r.heading); }
const svLink = (coords, near) => `<a class="btn sv" href="${streetViewURL(coords, near)}" target="_blank" rel="noopener">See it in Google Street View ↗</a>
  <div class="muted fineprint">Opens Google's nearest street-level photo, which may be a few years old.</div>`;

// ---------------- basemaps (same set as the Peg Hunt Map) ----------------
const OFM = 'https://tiles.openfreemap.org/styles/';
// USGS The National Map orthoimagery (USDA NAIP, public domain; no key).
const USGS_TILES = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
const BASEMAPS = {
  light:     { label: 'Light',     style: OFM + 'positron' },
  streets:   { label: 'Streets',   style: OFM + 'liberty' },
  dark:      { label: 'Dark',      style: OFM + 'dark', dark: true },
  satellite: { label: 'Satellite', style: OFM + 'liberty', dark: true, imagery: true },
};
async function basemapStyle(key) {
  const b = BASEMAPS[key];
  if (!b.imagery) return b.style;
  const r = await fetch(b.style);
  if (!r.ok) throw new Error(`label style answered ${r.status}`);
  const s = await r.json();
  s.sources.usgs = { type: 'raster', tiles: [USGS_TILES], tileSize: 256, maxzoom: 16,
    attribution: 'Imagery <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank">USGS The National Map</a> (USDA NAIP)' };
  const labels = s.layers.filter(l => l.type === 'symbol' && !/poi/.test(l.id))
    .map(l => ({ ...l, paint: { ...(l.paint || {}), 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.4 } }));
  s.layers = [{ id: 'usgs-imagery', type: 'raster', source: 'usgs' }, ...labels];
  return s;
}

// ---------------- state ----------------
const state = {
  basemap: BASEMAPS[HASH.bm] ? HASH.bm : (BASEMAPS[lsGet('wvc.basemap')] ? lsGet('wvc.basemap') : 'light'),
  sel: HASH.s !== undefined && HASH.s !== '' ? +HASH.s : null,
  segGeo: null, details: null, crashGeo: null, crashReq: null, view: 'map',
  mcty: S.counties[HASH.mc] ? HASH.mc : '',   // county index of the month overview, '' = all of California
};
function saveHash() {
  const c = map.getCenter();
  const p = [`map=${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`, `bm=${state.basemap}`];
  if (state.sel !== null) p.push(`s=${state.sel}`);
  if (state.mcty !== '') p.push(`mc=${state.mcty}`);
  if ($('#showBarriers').checked) p.push('bl=1');
  if (state.view === 'rank') {
    p.push('v=rank');
    if (R.unit === 'route') p.push('u=route');
    if (R.unit === 'route' && R.route !== null) p.push(`rt=${R.route}`);
    if (R.q) p.push(`q=${encodeURIComponent(R.q)}`);
    if (R.county !== '' && R.unit === 'seg') p.push(`cty=${R.county}`);
    if (R.long && R.unit === 'route') p.push('long=1');
    if (R.bar && R.unit === 'seg') p.push(`cl=${R.bar}`);
  }
  history.replaceState(null, '', '#' + p.join('&'));
}

// ---------------- map ----------------
const view = (HASH.map || '').split('/').map(Number);
const map = new maplibregl.Map({
  container: 'map', style: BASEMAPS[state.basemap].style, hash: false, attributionControl: false,
  ...(view.length === 3 && view.every(v => !isNaN(v))
    ? { zoom: view[0], center: [view[2], view[1]] }
    : { bounds: [[-124.5, 32.5], [-114.1, 42.0]], fitBoundsOptions: { padding: 20 } }),
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.AttributionControl({ compact: true,
  customAttribution: 'Crashes: CHP CCRS · Traffic: Caltrans Traffic Census (estimates; no endorsement) · Barriers: CDFW BIOS ds2867 (CC BY 4.0)' }), 'bottom-right');
map.on('moveend', saveHash);
// the compact credits box starts open; keep it folded on phones so it does not cover the map
map.once('load', () => { if (isPhone()) document.querySelectorAll('.maplibregl-ctrl-attrib').forEach(e => e.classList.remove('maplibregl-compact-show')); });

const tierColor = ['match', ['get', 't'], ...S.tiers.flatMap((t, i) => [i, t.color]), '#999'];
function addLayers() {
  if (!state.segGeo || map.getSource('seg')) return;
  const dark = !!BASEMAPS[state.basemap].dark;
  const before = (map.getStyle().layers.find(l => l.type === 'symbol') || {}).id;
  if (state.barGeo) addBarrierLayer(before);
  map.addSource('seg', { type: 'geojson', data: state.segGeo });
  map.addLayer({ id: 'seg-case', type: 'line', source: 'seg', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#000' : '#fff', 'line-opacity': 0.8,
             'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 10, 7, 14, 12] } }, before);
  map.addLayer({ id: 'seg', type: 'line', source: 'seg', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': tierColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 10, 4.5, 14, 9] } }, before);
  map.addLayer({ id: 'seg-sel', type: 'line', source: 'seg', filter: ['==', ['id'], state.sel ?? -1],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': dark ? '#fff' : '#111', 'line-gap-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 14, 9], 'line-width': 2.5 } });
  if (state.crashGeo) addCrashLayer();
}
// CDFW barrier list: a wide band under the risk colors, so both stay readable; darker = higher CDFW priority
const BAR_COLOR = ['#cfcfe6', '#b9b7dc', '#8c86c4', '#54278f'];   // Remediated, Barrier, Priority, Top priority
const BAR_LABEL = ['Remediated', 'Listed', 'Priority', 'Top priority'];
function addBarrierLayer(before) {
  if (map.getSource('bar')) return;
  before = before || (map.getLayer('seg-case') ? 'seg-case' : (map.getStyle().layers.find(l => l.type === 'symbol') || {}).id);
  map.addSource('bar', { type: 'geojson', data: state.barGeo });
  map.addLayer({ id: 'bar', type: 'line', source: 'bar', layout: { 'line-cap': 'round', 'line-join': 'round',
      visibility: $('#showBarriers').checked ? 'visible' : 'none' },
    paint: { 'line-color': ['match', ['get', 'p'], ...BAR_COLOR.flatMap((c, i) => [i, c]), '#999'], 'line-opacity': 0.85,
             'line-width': ['interpolate', ['linear'], ['zoom'], 5, 7, 10, 15, 14, 24] } }, before);
}
async function loadBarriers() {
  if (state.barReq) return state.barReq;
  state.barReq = getJSON(`data/barriers.json?v=${S.build}`).then(js => {
    const dec = flat => { const c = []; let x = 0, y = 0; for (let j = 0; j < flat.length; j += 2) { x += flat[j]; y += flat[j + 1]; c.push([x / 1e5, y / 1e5]); } return c; };
    state.barGeo = { type: 'FeatureCollection', features: js.g.map((parts, i) => ({ type: 'Feature', properties: { p: js.p[i] },
      geometry: { type: 'MultiLineString', coordinates: parts.map(dec) } })) };
    if (styleReady && map.getSource('seg')) addBarrierLayer();
  }).catch(e => { state.barReq = null; console.error(e); });
  return state.barReq;
}
function barrierRow(bi) {   // the CDFW listing of a stretch, for both detail boxes
  const b = state.details.barriers;
  if (bi < 0) return '<tr><td>On CDFW wildlife barrier list</td><td class="num">no</td></tr>';
  return `<tr><td colspan="2" class="barrow"><span class="barsw" style="background:${BAR_COLOR[b.p[bi]]}"></span>On CDFW's wildlife <b>barrier</b> list` +
    ` (${BAR_LABEL[b.p[bi]].toLowerCase()}): ${esc(b.nm[bi])}${b.sp[bi] ? ` · for ${esc(b.sp[bi])}` : ''}` +
    `${b.u[bi] ? ` · <a href="${esc(b.u[bi])}" target="_blank" rel="noopener">CDFW summary</a>` : ''}` +
    `<div class="muted">A list of roads animals struggle to cross, not of crash sites.</div></td></tr>`;
}
// By-month chart for a stretch or a whole highway. codes: one per crash, month * 5 + animal class (wvc/site_build.py).
// Counts only: traffic counts are yearly averages, so this cannot be put per mile driven month by month.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_MIN = 10;   // fewer crashes than this: say the pattern is too thin to read
// busiest two months in a row (Dec–Jan counts): [first month index, crashes in the two]
const busiest2 = tot => MONTHS.map((_, j) => [j, tot[j] + tot[(j + 1) % 12]]).sort((a, b) => b[1] - a[1])[0];
// Overview in the map panel while no road is picked: crashes by month, one small chart per animal type, each on its own
// scale so the flat ones show their shape. All of California from the page's own numbers; a county from details.json.
function overviewCounts() {
  if (state.mcty === '') return S.month_by_class;
  const d = state.details, K = S.classes.length, m = S.classes.map(() => MONTHS.map(() => 0));
  if (!d) return null;
  d.c.forEach((c, i) => { if (c === +state.mcty) d.mo[i].forEach(code => m[code % K][Math.floor(code / K)]++); });
  return m;
}
function renderOverview() {
  const el = $('#overview'); if (!el) return;
  const counts = overviewCounts(), W = 180, top = 6, base = 62, bw = W / 12;
  if (!counts) { el.querySelector('.minis').innerHTML = 'Loading…'; return; }
  const all = counts.flat().reduce((a, b) => a + b, 0);
  el.querySelector('.minis').innerHTML = S.classes.map((c, k) => {
    const tot = counts[k], n = tot.reduce((a, b) => a + b, 0), ymax = Math.max(...tot, 1);
    if (!n) return `<div class="mini"><div class="mh">${c.label} <span class="muted">0</span></div></div>`;
    const y = v => base - v / ymax * (base - top), two = busiest2(tot), j = two[0];
    const bars = tot.map((v, i) => `<g><title>${MONTHS[i]}: ${fmtInt(v)} ${c.label.toLowerCase()} crashes</title>` +
      `<rect x="${i * bw + 1.5}" y="${y(v)}" width="${bw - 3}" height="${base - y(v)}" fill="${c.color}"/>` +
      `<rect x="${i * bw}" y="${top}" width="${bw}" height="${base - top}" fill="transparent"/>` +
      `<text x="${(i + .5) * bw}" y="${base + 10}">${i + 1}</text></g>`).join('');
    return `<div class="mini"><div class="mh">${c.label} <span class="muted">${fmtInt(n)}</span></div>
      <svg viewBox="0 0 ${W} ${base + 13}" role="img" aria-label="${c.label} crashes by month">${bars}
        <line x1="0" x2="${W}" y1="${y(n / 12)}" y2="${y(n / 12)}" class="even"/>
        <line x1="0" x2="${W}" y1="${base + .5}" y2="${base + .5}" class="axis"/></svg>
      <div class="muted">${n < MONTH_MIN ? 'Too few to read' : `Busiest: ${MONTHS[j]}–${MONTHS[(j + 1) % 12]}, ${fmtPct(two[1], n)}`}</div></div>`;
  }).join('');
  el.querySelector('.tot').textContent = `${fmtInt(all)} reported crashes, ${S.years}`;
}
function overviewHTML() {
  const opts = S.counties.map((n, i) => `<option value="${i}"${String(i) === state.mcty ? ' selected' : ''}>${esc(n)} County</option>`).join('');
  return `<div id="overview"><div class="oh">Crashes by month in <select id="mCounty" aria-label="Area">
      <option value="">all of California</option>${opts}</select></div>
    <div class="muted tot"></div><div class="minis"></div>
    <div class="muted">One chart per animal type, each on its own scale. Dashed line: the same crashes spread evenly over the
      year. "Busiest": the two months in a row with the most crashes (an even spread would give 17%). Counts only: traffic
      also changes with the season.</div></div>`;
}
function monthChart(codes) {
  const n = codes.length, K = S.classes.length;
  if (!n) return '';
  const m = MONTHS.map(() => S.classes.map(() => 0));
  codes.forEach(c => m[Math.floor(c / K)][c % K]++);
  const tot = m.map(r => r.reduce((a, b) => a + b, 0)), exp = S.month_share.map(p => p * n);
  const W = 300, top = 12, base = 80, bw = W / 12, ymax = Math.max(...tot, ...exp, 1);
  const y = v => base - v / ymax * (base - top);
  const bars = m.map((r, j) => {
    let h0 = 0;
    const segs = r.map((v, k) => { if (!v) return ''; const y1 = y(h0 + v), y0 = y(h0); h0 += v;
      return `<rect x="${j * bw + 2}" y="${y1}" width="${bw - 4}" height="${y0 - y1}" fill="${S.classes[k].color}"/>`; }).join('');
    const what = r.map((v, k) => v ? `${S.classes[k].label} ${v}` : '').filter(Boolean).join(' · ');
    return `<g><title>${MONTHS[j]}: ${tot[j]}${what ? ` (${what})` : ''}</title>${segs}` +
      `<rect x="${j * bw}" y="${top}" width="${bw}" height="${base - top}" fill="transparent"/>` +
      (tot[j] ? `<text x="${(j + .5) * bw}" y="${y(tot[j]) - 2}" class="v">${tot[j]}</text>` : '') +
      `<text x="${(j + .5) * bw}" y="${base + 11}">${j + 1}</text></g>`;   // full names do not fit under the bars
  }).join('');
  const line = `<polyline points="${exp.map((v, j) => `${(j + .5) * bw},${y(v)}`).join(' ')}" class="state"/>`;
  let note;
  if (n < MONTH_MIN) note = 'Too few crashes here to read a seasonal pattern.';
  else {   // busiest two months in a row (Dec–Jan counts), against the state's share of the same two months
    const two = busiest2(tot), j = two[0];
    const st = S.month_share[j] + S.month_share[(j + 1) % 12];
    note = `Busiest two months: <b>${MONTHS[j]}–${MONTHS[(j + 1) % 12]}</b>, ${two[1]} of ${n} (${fmtPct(two[1], n)}; statewide ${Math.round(st * 100)}%).`;
  }
  return `<div class="months"><div class="mh">Reported crashes by month, ${S.years}</div>
    <svg viewBox="0 0 ${W} ${base + 14}" role="img" aria-label="Crashes by month">${bars}${line}<line x1="0" x2="${W}" y1="${base + .5}" y2="${base + .5}" class="axis"/></svg>
    <div class="muted">${note} Grey line: the statewide pattern at this total. Counts only: traffic also changes with the season.</div></div>`;
}
function addCrashLayer() {
  if (map.getSource('crash')) return;
  map.addSource('crash', { type: 'geojson', data: state.crashGeo });
  map.addLayer({ id: 'crash', type: 'circle', source: 'crash', minzoom: CRASH_MINZOOM,
    layout: { visibility: $('#showCrashes').checked ? 'visible' : 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.2, 14, 5],
             'circle-color': BASEMAPS[state.basemap].dark ? '#fff' : '#222',  // one neutral color: tier colors stay readable
             'circle-stroke-color': BASEMAPS[state.basemap].dark ? '#000' : '#fff', 'circle-stroke-width': 0.8 } });
}
// style.load can fire before or after the segment data arrives; whichever comes second adds the layers
let styleReady = false;
map.on('style.load', () => { styleReady = true; addLayers(); });

let basemapReq = 0;
async function setBasemap(key) {
  const id = ++basemapReq;
  let style;
  try { style = await basemapStyle(key); } catch (e) { $('#detail').textContent = `Could not load that basemap (${e.message}).`; return; }
  if (id !== basemapReq) return;
  state.basemap = key; lsSet('wvc.basemap', key); saveHash();
  document.querySelectorAll('#basemap .btn').forEach(b => b.classList.toggle('on', b.dataset.k === key));
  styleReady = false;
  map.setStyle(style, { diff: false });
}
$('#basemap').innerHTML = Object.entries(BASEMAPS).map(([k, b]) => `<button class="btn${k === state.basemap ? ' on' : ''}" data-k="${k}">${b.label}</button>`).join('');
document.querySelectorAll('#basemap .btn').forEach(b => b.addEventListener('click', () => setBasemap(b.dataset.k)));
if (BASEMAPS[state.basemap].imagery) map.once('load', () => setBasemap(state.basemap));

// ---------------- data ----------------
function decodeSegments(js) {
  const features = js.g.map((flat, i) => {
    const coords = []; let x = 0, y = 0;
    for (let j = 0; j < flat.length; j += 2) { x += flat[j]; y += flat[j + 1]; coords.push([x / 1e5, y / 1e5]); }
    return { type: 'Feature', id: i, properties: { t: js.t[i] }, geometry: { type: 'LineString', coordinates: coords } };
  });
  return { type: 'FeatureCollection', features };
}
async function loadCrashes() {
  if (state.crashReq) return state.crashReq;
  state.crashReq = getJSON(`data/crashes.json?v=${S.build}`).then(js => {
    state.crashGeo = { type: 'FeatureCollection', features: js.x.map((x, i) => ({ type: 'Feature',
      properties: { k: js.k[i] }, geometry: { type: 'Point', coordinates: [x / 1e5, js.y[i] / 1e5] } })) };
    if (styleReady && map.getSource('seg')) addCrashLayer();
  }).catch(e => { state.crashReq = null; console.error(e); });
  return state.crashReq;
}
function maybeCrashes() { if (map.getZoom() >= CRASH_MINZOOM - 0.5 && $('#showCrashes').checked) loadCrashes(); }
map.on('zoomend', maybeCrashes);
$('#showBarriers').checked = HASH.bl === '1';
$('#showBarriers').addEventListener('change', e => {
  if (map.getLayer('bar')) map.setLayoutProperty('bar', 'visibility', e.target.checked ? 'visible' : 'none');
  if (e.target.checked) loadBarriers();
  legend(); saveHash();
});
if ($('#showBarriers').checked) loadBarriers();
$('#showCrashes').addEventListener('change', e => {
  if (map.getLayer('crash')) map.setLayoutProperty('crash', 'visibility', e.target.checked ? 'visible' : 'none');
  maybeCrashes();
});

// ---------------- legend and detail ----------------
function legend() {
  $('#legend').innerHTML = `<div class="legcap">Reported crashes per mile driven, as a multiple of the state average, at least:</div>` +
    S.tiers.slice().reverse().map(t => `<div class="leg"><span class="sw" style="background:${t.color}"></span>${t.label}<span class="mi">${fmtInt(t.miles)} mi</span></div>`).join('') +
    ($('#showBarriers').checked ? `<div class="legcap" style="margin-top:6px">Wide band: on CDFW's wildlife barrier list (roads animals struggle to cross)</div>` +
      [3, 2, 1].map(p => `<div class="leg"><span class="sw wide" style="background:${BAR_COLOR[p]}"></span>${BAR_LABEL[p]}</div>`).join('') : '');
}
function select(i, fly) {
  if (i !== state.sel && fly !== 'click') state.clickLL = null;
  state.sel = i;
  if (map.getLayer('seg-sel')) map.setFilter('seg-sel', ['==', ['id'], i ?? -1]);
  saveHash();
  renderDetail();
  if (fly === true && i !== null && state.segGeo) {
    const c = state.segGeo.features[i].geometry.coordinates, b = new maplibregl.LngLatBounds(c[0], c[0]);
    c.forEach(p => b.extend(p));
    map.fitBounds(b, { padding: isPhone() ? { top: 40, bottom: window.innerHeight * 0.45, left: 30, right: 30 } : { top: 60, bottom: 60, left: 380, right: 60 }, maxZoom: 11 });
  }
}
function renderDetail() {
  const i = state.sel, d = state.details;
  if (i === null) {
    $('#detail').innerHTML = 'Tap a road to see its numbers.' + overviewHTML();
    $('#mCounty').addEventListener('change', e => { state.mcty = e.target.value; saveHash(); renderOverview(); });
    renderOverview();
    return;
  }
  if (!d) { $('#detail').innerHTML = 'Loading…'; return; }
  // Big number = m, the best estimate ("about N x"). Color chip and "likely between" = lo..hi, the 80% range
  // (wvc/risk.py q10, q90). On a quiet road with no crash, m is mostly its traffic group's typical rate, so a grey
  // stretch can show a large m: the color, not m, says whether the stretch itself is known to be high.
  const t = S.tiers[state.segGeo.features[i].properties.t];
  const k = d.k[i], kinds = S.classes.map((c, j) => k[j] ? `${c.label} ${k[j]}` : '').filter(Boolean).join(' · ');
  $('#detail').innerHTML = `<h3>${d.r[i]} · ${d.p[i]}</h3>
    <div><span class="chip" style="background:${t.color};color:${t.dark ? '#fff' : '#222'}">${t.label}</span></div>
    <div class="big">${fmtX(d.m[i])}</div>
    <div class="muted">the state average per mile driven (likely between ${fmtX(d.lo[i])} and ${fmtX(d.hi[i])})</div>
    <table>
      <tr><td>Reported animal crashes, ${S.years}</td><td class="num">${d.n[i]}</td></tr>
      ${d.n[i] ? `<tr><td colspan="2" class="muted">${kinds}${d.dk[i] ? ` · ${d.dk[i]} in the dark` : ''}</td></tr>` : ''}
      <tr><td>Vehicles per day (average)</td><td class="num">${fmtInt(d.a[i])}</td></tr>
      <tr><td>Length</td><td class="num">${d.l[i].toFixed(1)} mi</td></tr>
      ${barrierRow(d.b[i])}
    </table>
    ${monthChart(d.mo[i])}
    <div style="margin-top:8px">${svLink(state.segGeo.features[i].geometry.coordinates, state.clickLL)}</div>`;
}
map.on('click', e => {
  if (!map.getLayer('seg')) return;
  const r = isPhone() ? 12 : 6;
  const f = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['seg'] });
  state.clickLL = f.length ? [e.lngLat.lng, e.lngLat.lat] : null;
  select(f.length ? f[0].id : null, 'click');
  if (f.length && isPhone()) $('#panel').classList.remove('full');
});
map.on('mouseenter', 'seg', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'seg', () => { map.getCanvas().style.cursor = ''; });

// ---------------- Street View figure ----------------
// Drag the yellow figure from the map's corner and drop it: Google Maps opens a new tab at the nearest street-level photo.
// A drop within SNAP_PX of a highway on the map lands on that road, looking along it; anywhere else opens at the drop point.
const SNAP_PX = 24;
const PEG_SVG = `<svg viewBox="0 0 20 32" aria-hidden="true"><g fill="#f6b900" stroke="#8a6500" stroke-width="1.2" stroke-linejoin="round">
  <circle cx="10" cy="5.5" r="4.3"/><path d="M4.5 12.5a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3V20h-2.2v10.5H6.7V20H4.5z"/></g></svg>`;
class PegControl {
  onAdd() {
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    box.innerHTML = `<button type="button" id="peg" title="Drag onto a road to see it in Google Street View" aria-label="Street View: drag onto a road">${PEG_SVG}</button>`;
    return box;
  }
  onRemove() {}
}
map.addControl(new PegControl(), 'top-right');
document.body.insertAdjacentHTML('beforeend',
  `<div id="pegGhost">${PEG_SVG}</div><div id="pegDot"></div><div id="pegHint"></div><div id="pegTip"></div>`);

function pegSnap(pt) {   // pt: pixel on the map; the nearest highway spot within SNAP_PX, or null
  if (!map.getLayer('seg')) return null;
  const f = map.queryRenderedFeatures([[pt.x - SNAP_PX, pt.y - SNAP_PX], [pt.x + SNAP_PX, pt.y + SNAP_PX]], { layers: ['seg'] });
  const ll = map.unproject(pt), near = [ll.lng, ll.lat];
  let best = null;
  for (const id of new Set(f.map(x => x.id))) {
    const r = nearestOnLine(state.segGeo.features[id].geometry.coordinates, near);
    if (!best || r.d < best.d) best = r;
  }
  if (!best) return null;
  const q = map.project(best.p);
  return Math.hypot(q.x - pt.x, q.y - pt.y) <= SNAP_PX ? best : null;
}
function pegTip(html, x, y) {   // small bubble at a screen point; closes on the next click elsewhere
  const t = $('#pegTip');
  t.innerHTML = html;
  t.style.left = Math.max(8, Math.min(x, window.innerWidth - 228)) + 'px';
  t.style.top = Math.max(8, y) + 'px';
  t.classList.add('on');
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#pegTip, #peg')) $('#pegTip').classList.remove('on'); });

function pegHowTo() {
  const b = $('#peg').getBoundingClientRect();
  pegTip('Drag me onto a road to see it in Google Street View.', b.left - 224, b.bottom + 6);
}
const peg = { on: false };
function pegMove(e) {
  if (!peg.on) return;
  if (!peg.moved && Math.hypot(e.clientX - peg.x0, e.clientY - peg.y0) < 4) return;
  peg.moved = true;
  document.body.classList.add('pegdrag');
  $('#pegTip').classList.remove('on');
  const x = e.clientX, y = e.clientY - (e.pointerType === 'touch' ? 44 : 0);   // on phones the drop spot sits above the finger
  $('#pegGhost').style.transform = `translate(${x}px, ${y}px)`;
  const el = document.elementFromPoint(x, y), r = map.getContainer().getBoundingClientRect();
  const pt = new maplibregl.Point(x - r.left, y - r.top);
  if (!el || !map.getCanvasContainer().contains(el)) peg.at = null;   // over the panel, a control or off the map
  else { const ll = map.unproject(pt); peg.at = pegSnap(pt) || { p: [ll.lng, ll.lat], heading: null, free: true }; }
  const dot = $('#pegDot');
  dot.classList.toggle('on', !!peg.at && !peg.at.free);
  if (peg.at && !peg.at.free) { const q = map.project(peg.at.p); dot.style.transform = `translate(${r.left + q.x}px, ${r.top + q.y}px)`; }
  document.body.classList.toggle('pegout', !peg.at);
  $('#pegHint').textContent = !peg.at ? 'Release here to cancel' : peg.at.free ? 'Drop on a highway to land on the road · Esc to cancel'
    : 'Release to open Google Street View · Esc to cancel';
}
function pegEnd(e, drop) {
  if (!peg.on) return;
  peg.on = false;
  document.body.classList.remove('pegdrag', 'pegout');
  $('#pegDot').classList.remove('on');
  if (!peg.moved) { if (drop) pegHowTo(); return; }
  if (!drop || !peg.at) return;
  const url = panoURL(peg.at.p, peg.at.heading), w = window.open(url, '_blank');
  if (w) { w.opener = null; return; }
  // the browser blocked the new tab (e.g. a very long drag): offer the link where the figure was dropped
  pegTip(`<a href="${url}" target="_blank" rel="noopener">Open Google Street View here ↗</a>`, e.clientX - 100, e.clientY + 8);
}
const pegBtn = $('#peg');
pegBtn.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  pegBtn.setPointerCapture(e.pointerId);
  Object.assign(peg, { on: true, moved: false, x0: e.clientX, y0: e.clientY, at: null });
});
pegBtn.addEventListener('pointermove', pegMove);
pegBtn.addEventListener('pointerup', e => pegEnd(e, true));
pegBtn.addEventListener('pointercancel', e => pegEnd(e, false));
pegBtn.addEventListener('lostpointercapture', e => pegEnd(e, false));
pegBtn.addEventListener('click', e => { if (e.detail === 0) pegHowTo(); });   // keyboard press: explain how it works
document.addEventListener('keydown', e => { if (e.key === 'Escape' && peg.on) { peg.at = null; pegEnd(e, false); } });

// ---------------- rankings page (layout from the Peg Hunt Map city dashboard) ----------------
// Ranked by the "at least" multiple (lo), the number that colors the map; # is the statewide rank and stays fixed under filters.
const PAGE = 100;
const R = { unit: HASH.u === 'route' ? 'route' : 'seg', county: HASH.cty ?? '', q: HASH.q || '', long: HASH.long === '1',
            bar: ['on', 'off'].includes(HASH.cl) ? HASH.cl : '',
            route: HASH.rt !== undefined && HASH.rt !== '' ? +HASH.rt : null, sort: { k: 'rank', dir: 1 }, shown: PAGE, rows: null };
const fmtPct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// same rule as the build (wvc/site_build.py tier_codes): 0 below = hi < 1; 1 unclear = range straddles 1x; 2-5 = lo >= 1, 3, 10, 30
const tierOf = (lo, hi) => hi < 1 ? 0 : lo >= 30 ? 5 : lo >= 10 ? 4 : lo >= 3 ? 3 : lo >= 1 ? 2 : 1;
function rankOf(lo) {
  const r = new Array(lo.length);
  lo.map((_, i) => i).sort((a, b) => lo[b] - lo[a]).forEach((i, k) => { r[i] = k + 1; });
  return r;
}
function buildRows() {
  const d = state.details, rt = d.routes, sr = rankOf(d.lo), rr = rankOf(rt.lo);
  const seg = d.r.map((name, i) => { const [code, pm] = d.p[i].split(' ');
    return { i, rank: sr[i], name, county: S.counties[d.c[i]], c: d.c[i], code, pm, l: d.l[i], lo: d.lo[i], m: d.m[i], hi: d.hi[i],
             n: d.n[i], deer: d.k[i][0], dk: d.dk[i], a: d.a[i], t: state.segGeo.features[i].properties.t,
             b: d.b[i], bp: d.b[i] < 0 ? -1 : d.barriers.p[d.b[i]] }; });
  const route = rt.r.map((name, i) => ({ i, rank: rr[i], name, l: rt.l[i], lo: rt.lo[i], m: rt.m[i], hi: rt.hi[i], n: rt.n[i],
    deer: rt.deer[i], dk: rt.dk[i], a: rt.a[i], n10: rt.n10[i], t: tierOf(rt.lo[i], rt.hi[i]),
    segs: seg.filter(s => s.name === name).length }));
  R.rows = { seg, route };
}
const norm = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
function nameMatch(name, q) {   // "299" finds SR-299 only, not SR-99; "us395" finds US-395
  const n = norm(q);
  return !n || (/^\d+[A-Z]?$/.test(n) ? name.split('-')[1] === n : norm(name) === n);
}
function rankList() {
  if (R.unit === 'route') return R.rows.route.filter(r => nameMatch(r.name, R.q) && (!R.long || r.l >= 50));
  return R.rows.seg.filter(r => nameMatch(r.name, R.q) && (R.county === '' || r.c === +R.county) &&
    (!R.bar || (R.bar === 'on') === (r.b >= 0)));
}
const share = (a, b) => b ? a / b : -1;
const COLS = {
  seg: [
    { k: 'rank', t: '#', num: 1, get: r => r.rank, show: r => r.rank },
    { k: 'name', t: 'Highway', get: r => r.name, show: r => `<span class="sw" style="background:${S.tiers[r.t].color}"></span>${r.name}` },
    { k: 'where', t: 'Where', get: r => r.county + r.pm, show: r => `${esc(r.county)} <span class="muted">${r.pm}</span>` },
    { k: 'lo', t: 'At least', num: 1, get: r => r.lo, show: r => `<b>${fmtX(r.lo)}</b>` },
    { k: 'm', t: 'Most likely', num: 1, wide: 1, get: r => r.m, show: r => fmtX(r.m) },
    { k: 'n', t: 'Crashes', num: 1, get: r => r.n, show: r => r.n },
    { k: 'deer', t: 'Deer', num: 1, get: r => share(r.deer, r.n), show: r => fmtPct(r.deer, r.n) },
    { k: 'dk', t: 'In the dark', num: 1, wide: 1, get: r => share(r.dk, r.n), show: r => fmtPct(r.dk, r.n) },
    { k: 'a', t: 'Vehicles/day', num: 1, wide: 1, get: r => r.a, show: r => fmtInt(r.a) },
    { k: 'bp', t: 'CDFW barrier list', wide: 1, num: 1, get: r => r.bp, show: r => r.bp < 0 ? '' : `<span class="barsw" style="background:${BAR_COLOR[r.bp]}"></span>${BAR_LABEL[r.bp]}` },
  ],
  route: [
    { k: 'rank', t: '#', num: 1, get: r => r.rank, show: r => r.rank },
    { k: 'name', t: 'Highway', get: r => r.name, show: r => `<span class="sw" style="background:${S.tiers[r.t].color}"></span>${r.name}` },
    { k: 'l', t: 'Miles', num: 1, get: r => r.l, show: r => fmtInt(r.l) },
    { k: 'lo', t: 'At least', num: 1, get: r => r.lo, show: r => `<b>${fmtX(r.lo)}</b>` },
    { k: 'm', t: 'Most likely', num: 1, wide: 1, get: r => r.m, show: r => fmtX(r.m) },
    { k: 'n', t: 'Crashes', num: 1, get: r => r.n, show: r => fmtInt(r.n) },
    { k: 'deer', t: 'Deer', num: 1, get: r => share(r.deer, r.n), show: r => fmtPct(r.deer, r.n) },
    { k: 'dk', t: 'In the dark', num: 1, wide: 1, get: r => share(r.dk, r.n), show: r => fmtPct(r.dk, r.n) },
    { k: 'a', t: 'Vehicles/day', num: 1, wide: 1, get: r => r.a, show: r => fmtInt(r.a) },
    { k: 'n10', t: `Stretches at 10×+`, num: 1, wide: 1, get: r => r.n10, show: r => r.n10 ? `${r.n10} <span class="muted">of ${r.segs}</span>` : '' },
  ],
};
const curSel = () => R.unit === 'route' ? R.route : state.sel;
function renderRank() {
  if (!R.rows) { $('#rLead').textContent = 'Loading…'; return; }
  document.querySelectorAll('#rUnit .btn').forEach(b => b.classList.toggle('on', b.dataset.u === R.unit));
  $('#rCountyL').classList.toggle('hide', R.unit === 'route');
  $('#rBarL').classList.toggle('hide', R.unit === 'route'); $('#rBar').value = R.bar;
  $('#rLongL').classList.toggle('hide', R.unit !== 'route');
  $('#rSearch').value = R.q; $('#rCounty').value = R.county; $('#rLong').checked = R.long;
  const all = R.rows[R.unit].length;
  $('#rLead').innerHTML = R.unit === 'seg'
    ? `<h2>Riskiest ${S.seg_mi}-mile stretches</h2><div class="muted">All ${fmtInt(all)} stretches of California state highway, ranked by the
       multiple of the state average they reach <b>at least</b> (reported animal crashes per mile driven, ${S.years}). The same number colors the map.
       <a class="linkish" data-how="1">How the numbers are made</a></div>`
    : `<h2>Riskiest highways</h2><div class="muted">All ${all} state highways, each taken as a whole: its reported animal crashes over all the miles
       driven on it, ${S.years}. A long highway averages its quiet and busy parts, so its riskiest stretches are higher than its whole.
       <a class="linkish" data-how="1">How the numbers are made</a></div>`;
  $('#rLead').querySelector('[data-how]').addEventListener('click', ev => { ev.preventDefault(); openModal('#how'); });
  const list = rankList();
  renderScatter(list);
  renderRankDetail(list);
  renderTable(list);
  saveHash();
}
// scatter: traffic against risk, on fixed axes so a filtered view stays comparable with the whole state
function renderScatter(list) {
  const box = $('#rScatter'), W = Math.max(300, box.clientWidth || 800), H = isPhone() ? 260 : 340, m = { l: 44, r: 12, t: 10, b: 38 };
  const rows = R.rows[R.unit], seg = R.unit === 'seg';
  const xs = rows.map(r => Math.max(r.a, 10)), ys = rows.map(r => Math.max(r.m, 0.01));
  const lx0 = Math.log10(Math.min(...xs)), lx1 = Math.log10(Math.max(...xs)), ly0 = Math.log10(Math.min(...ys)), ly1 = Math.log10(Math.max(...ys));
  const X = v => m.l + (Math.log10(Math.max(v, 10)) - lx0) / (lx1 - lx0) * (W - m.l - m.r);
  const Y = v => H - m.b - (Math.log10(Math.max(v, 0.01)) - ly0) / (ly1 - ly0) * (H - m.t - m.b);
  const rad = r => seg ? 2.4 : 2.5 + Math.sqrt(r.l) / 3;
  let g = '';
  for (const t of [10, 100, 1e3, 1e4, 1e5, 1e6]) if (Math.log10(t) >= lx0 && Math.log10(t) <= lx1)
    g += `<line x1="${X(t)}" x2="${X(t)}" y1="${m.t}" y2="${H - m.b}" stroke="#eee"/><text x="${X(t)}" y="${H - m.b + 14}" font-size="11" text-anchor="middle" fill="#666">${t >= 1e3 ? t / 1e3 + 'k' : t}</text>`;
  for (const t of [0.01, 0.1, 1, 10, 100]) if (Math.log10(t) >= ly0 && Math.log10(t) <= ly1)
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="${t === 1 ? '#999' : '#eee'}"${t === 1 ? ' stroke-dasharray="4 3"' : ''}/>` +
         `<text x="${m.l - 6}" y="${Y(t) + 4}" font-size="11" text-anchor="end" fill="#666">${t}×</text>`;
  g += `<text x="${(m.l + W - m.r) / 2}" y="${H - 6}" font-size="12" text-anchor="middle" fill="#333">vehicles per day (log) → busier</text>`;
  const narrow = W < 560;
  g += `<text transform="translate(12 ${(m.t + H - m.b) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="#333">${narrow ? 'per mile driven' : 'crashes per mile driven, most likely (log)'} → riskier</text>`;
  const on = new Set(list.map(r => r.i)), sel = curSel(), filtered = list.length < rows.length;
  if (filtered) for (const r of rows) if (!on.has(r.i)) g += `<circle cx="${X(r.a)}" cy="${Y(r.m)}" r="${rad(r)}" fill="#bbb" fill-opacity=".25"/>`;
  for (const r of list.slice().sort((a, b) => b.rank - a.rank))   // top-ranked drawn last, on top
    g += `<circle class="pt" data-i="${r.i}" cx="${X(r.a)}" cy="${Y(r.m)}" r="${rad(r)}" fill="${S.tiers[r.t].color}" fill-opacity=".85" stroke="#fff" stroke-width=".6"/>`;
  // labels go on top of the dots with a white halo; each takes the first free spot (right, left, above, below) or is dropped
  const placed = [], LH = 14, ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
  const free = b => b.x0 >= m.l && b.x1 <= W - m.r && b.y0 >= 0 && b.y1 <= H - m.b &&
    !placed.some(p => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
  const put = (text, x, y, o, force) => {
    const w = ctx.measureText(text).width + 6;   // + the white halo
    for (const [ax, bx, by] of [['start', x + o, y + 4], ['end', x - o, y + 4], ['middle', x, y - o - 2], ['middle', x, y + o + 11]]) {
      const x0 = ax === 'start' ? bx : ax === 'end' ? bx - w : bx - w / 2, b = { x0, x1: x0 + w, y0: by - LH + 3, y1: by + 3 };
      if (force || free(b)) { placed.push(b); g += `<text class="lab" x="${bx}" y="${by}" text-anchor="${ax}">${esc(text)}</text>`; return; }
    }
  };
  const label = r => seg ? `${r.name} ${r.code}` : r.name;
  const s = sel !== null ? rows[sel] : null;
  if (s) put(label(s), X(s.a), Y(s.m), rad(s) + 4, true);
  put('state average', m.l + 4, Y(1) - 9, 0, true);   // just above the 1× line, at its empty low-traffic end
  const seen = new Set(s ? [label(s)] : []);   // one label per name, or US-395 Mono piles up
  list.slice().sort((a, b) => a.rank - b.rank).filter(r => !seen.has(label(r)) && seen.add(label(r))).slice(0, narrow ? 6 : 12)
    .forEach(r => put(label(r), X(r.a), Y(r.m), rad(r) + 3));
  if (s) g += `<circle cx="${X(s.a)}" cy="${Y(s.m)}" r="${rad(s) + 3}" fill="none" stroke="#000" stroke-width="2"/>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}</svg>`;
  box.querySelectorAll('.pt').forEach(c => c.addEventListener('click', () => pickRank(+c.dataset.i)));
  $('#rScatterNote').innerHTML = `Each dot is ${seg ? 'a stretch' : 'a highway, sized by its length'}, colored as on the map. Quiet roads sit higher:
    the animals are there whether or not the traffic is, so each car meets more of them. Click a dot for details.`;
}
function renderRankDetail(list) {
  const el = $('#rDetail'), i = curSel(), rows = R.rows[R.unit];
  if (i === null || !rows[i]) {
    const top = list.slice().sort((a, b) => a.rank - b.rank).slice(0, 5);
    el.innerHTML = `<h3>Top ${top.length}${list.length < rows.length ? ' in this view' : ''}</h3>` + (top.length
      ? `<ol>${top.map(r => `<li><a data-i="${r.i}">${r.name}${r.county ? ' · ' + esc(r.county) : ''}</a>${r.pm ? ` <span class="muted">${r.pm}</span>` : ''} <b>${fmtX(r.lo)}</b></li>`).join('')}</ol>`
      : '<div class="muted">Nothing matches.</div>') +
      `<div class="muted">"At least" values: the level we are 90% sure each one reaches. Click a row or a dot for details.</div>`;
    el.querySelectorAll('a[data-i]').forEach(a => a.addEventListener('click', () => pickRank(+a.dataset.i)));
    return;
  }
  const r = rows[i], t = S.tiers[r.t];
  const chip = `<span class="chip" style="background:${t.color};color:${t.dark ? '#fff' : '#222'}">${t.label}</span>`;
  const head = `<div class="big">${fmtX(r.m)}</div><div class="muted">the state average per mile driven (likely between ${fmtX(r.lo)} and ${fmtX(r.hi)})</div>`;
  const common = `<tr><td>Reported animal crashes, ${S.years}</td><td class="num">${fmtInt(r.n)}</td></tr>
      <tr><td>deer</td><td class="num">${fmtPct(r.deer, r.n)}</td></tr><tr><td>in the dark</td><td class="num">${fmtPct(r.dk, r.n)}</td></tr>
      <tr><td>Vehicles per day (average)</td><td class="num">${fmtInt(r.a)}</td></tr>`;
  if (R.unit === 'seg') {
    el.innerHTML = `<h3>${r.name} · ${esc(r.county)} County</h3><div class="muted">postmile ${r.pm} · ${r.l.toFixed(1)} mi</div>
      <div style="margin-top:6px">${chip} <b>#${fmtInt(r.rank)}</b> of ${fmtInt(rows.length)} stretches</div>${head}
      <table>${common}${barrierRow(r.b)}</table>${monthChart(state.details.mo[r.i])}
      <div style="margin-top:10px"><button class="btn" id="rOnMap">Show on the map</button> <a id="rClear">back to the list</a></div>
      <div style="margin-top:8px">${svLink(state.segGeo.features[r.i].geometry.coordinates, null)}</div>`;
    $('#rOnMap').addEventListener('click', () => { setView('map'); select(r.i, true); });
  } else {
    el.innerHTML = `<h3>${r.name}</h3><div class="muted">${fmtInt(r.l)} miles of state highway, taken as a whole</div>
      <div style="margin-top:6px">${chip} <b>#${r.rank}</b> of ${rows.length} highways</div>${head}
      <table>${common}<tr><td>Stretches at 10× or more</td><td class="num">${r.n10} of ${r.segs}</td></tr></table>
      ${monthChart(R.rows.seg.filter(s => s.name === r.name).flatMap(s => state.details.mo[s.i]))}
      <div style="margin-top:10px"><button class="btn" id="rStretches">List its stretches</button> <button class="btn" id="rOnMap">Show on the map</button>
        <a id="rClear">back to the list</a></div>`;
    $('#rStretches').addEventListener('click', () => { R.unit = 'seg'; R.q = r.name; R.county = ''; R.shown = PAGE; R.sort = { k: 'rank', dir: 1 }; renderRank(); });
    $('#rOnMap').addEventListener('click', () => {
      const b = new maplibregl.LngLatBounds();
      R.rows.seg.forEach(s => { if (s.name === r.name) state.segGeo.features[s.i].geometry.coordinates.forEach(p => b.extend(p)); });
      setView('map');
      map.fitBounds(b, { padding: isPhone() ? { top: 40, bottom: window.innerHeight * 0.45, left: 30, right: 30 } : { top: 60, bottom: 60, left: 380, right: 60 } });
    });
  }
  $('#rClear').addEventListener('click', () => pickRank(null));
}
function renderTable(list) {
  const cols = COLS[R.unit], col = cols.find(c => c.k === R.sort.k) || cols[0];
  const sorted = list.slice().sort((a, b) => { const va = col.get(a), vb = col.get(b); return (va < vb ? -1 : va > vb ? 1 : 0) * R.sort.dir || a.rank - b.rank; });
  const shown = sorted.slice(0, R.shown), sel = curSel();
  const cls = c => [c.num ? 'num' : '', c.wide ? 'wide' : ''].join(' ');
  const head = cols.map(c => `<th data-k="${c.k}" class="${cls(c)}${c.k === col.k ? ' sorted' : ''}">${c.t}${c.k === col.k ? (R.sort.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  const body = shown.map(r => `<tr class="row${r.i === sel ? ' cur' : ''}" data-i="${r.i}">${cols.map(c => `<td class="${cls(c)}">${c.show(r)}</td>`).join('')}</tr>`).join('');
  $('#rTable').innerHTML = `<table><tr>${head}</tr>${body}</table>` + (list.length ? '' : '<div class="muted">Nothing matches.</div>');
  $('#rTable').querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    const c = cols.find(c => c.k === th.dataset.k);
    R.sort = R.sort.k === c.k ? { k: c.k, dir: -R.sort.dir } : { k: c.k, dir: c.k === 'rank' || !c.num ? 1 : -1 };
    renderTable(rankList());
  }));
  $('#rTable').querySelectorAll('tr.row').forEach(tr => tr.addEventListener('click', () => pickRank(+tr.dataset.i)));
  const rest = sorted.length - shown.length;
  $('#rMore').classList.toggle('hide', rest <= 0);
  $('#rMore').textContent = `Show ${Math.min(PAGE, rest)} more (${fmtInt(rest)} left)`;
}
function pickRank(i) {
  if (R.unit === 'route') R.route = i; else select(i, false);
  renderRank();
  if (i !== null && window.matchMedia('(max-width: 900px)').matches) $('#rDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function setView(v) {
  state.view = v;
  document.body.classList.toggle('rank', v === 'rank');
  if (v === 'rank') renderRank(); else saveHash();
}
document.querySelectorAll('#tabs [data-v], #rTabs [data-v]').forEach(b => b.addEventListener('click', () => setView(b.dataset.v)));
document.querySelectorAll('#rUnit .btn').forEach(b => b.addEventListener('click', () => { R.unit = b.dataset.u; R.shown = PAGE; R.sort = { k: 'rank', dir: 1 }; renderRank(); }));
$('#rCounty').innerHTML = '<option value="">All counties</option>' +
  S.counties.map((n, i) => [n, i]).sort().map(([n, i]) => `<option value="${i}">${esc(n)}</option>`).join('');
$('#rCounty').addEventListener('change', e => { R.county = e.target.value; R.shown = PAGE; renderRank(); });
$('#rBar').addEventListener('change', e => { R.bar = e.target.value; R.shown = PAGE; renderRank(); });
$('#rSearch').addEventListener('input', e => { R.q = e.target.value.trim(); R.shown = PAGE; renderRank(); });
$('#rLong').addEventListener('change', e => { R.long = e.target.checked; R.shown = PAGE; renderRank(); });
$('#rMore').addEventListener('click', () => { R.shown += PAGE; renderTable(rankList()); });
window.addEventListener('resize', () => { if (state.view === 'rank' && R.rows) renderScatter(rankList()); });

// ---------------- welcome clip ----------------
// The near miss that started this project: a 6 s dashcam clip (loaded only when the welcome card opens), my car's
// logged speed under it, then a still with both deer circled, and a button to the stretch it happened on.
const CLIP = S.clip;
const vid = $('#wVideo');
let speedW = 0, headReq = 0;
function speedLine() {   // drawn at the box's real pixel width so the labels stay readable on phones
  const W = speedW = $('#wSpeed').clientWidth || 560, top = 10, bot = 52, lo = 26, hi = 52;
  const x = t => t / CLIP.dur * W, y = v => bot - (v - lo) / (hi - lo) * (bot - top);
  let bands = '';
  for (let i = 0; i < CLIP.t.length; i++) {
    if (!CLIP.brake[i]) continue;
    let j = i;
    while (j + 1 < CLIP.t.length && CLIP.brake[j + 1]) j++;
    bands += `<rect x="${x(CLIP.t[i])}" y="${top}" width="${x(CLIP.t[j]) - x(CLIP.t[i])}" height="${bot - top}" fill="#f6b900" opacity=".3"/>`;
    i = j;
  }
  const path = CLIP.t.map((t, k) => `${k ? 'L' : 'M'}${x(t).toFixed(1)},${y(CLIP.mph[k]).toFixed(1)}`).join('');
  const b0 = CLIP.brake.indexOf(1), kMin = CLIP.mph.indexOf(Math.min(...CLIP.mph));
  const label = k => `<text x="${x(CLIP.t[k])}" y="${y(CLIP.mph[k]) - 6}" text-anchor="middle">${Math.round(CLIP.mph[k])} mph</text>`;
  const tick = (t, txt) => `<line x1="${x(t)}" x2="${x(t)}" y1="${bot}" y2="${bot + 4}" stroke="#777"/>` +
    `<text class="tick" x="${x(t)}" y="${bot + 15}" text-anchor="middle">${txt}</text>`;
  $('#wSpeed').setAttribute('viewBox', `0 0 ${W} 70`);
  $('#wSpeed').innerHTML = bands + `<line x1="0" x2="${W}" y1="${bot}" y2="${bot}" stroke="#ccc"/>` +
    `<path d="${path}" fill="none" stroke="#1e3cc8" stroke-width="2"/>` + label(b0) + label(kMin) +
    tick(CLIP.seen, 'deer on camera') + tick(CLIP.in_lane, 'in my lane') +
    `<line id="wHead" x1="0" x2="0" y1="${top - 4}" y2="${bot}" stroke="#222" stroke-width="1.5"/>`;
}
function headAt(t) { const h = $('#wHead'); if (h) { const X = Math.min(t, CLIP.dur) / CLIP.dur * speedW; h.setAttribute('x1', X); h.setAttribute('x2', X); } }
function follow() { headAt(vid.currentTime); if (!vid.paused && !vid.ended) headReq = requestAnimationFrame(follow); }
function showStill(label) { cancelAnimationFrame(headReq); $('#wClip .freeze').hidden = false; $('#wReplay').textContent = label; headAt(CLIP.still); }
function playClip() {
  $('#wClip .freeze').hidden = true;
  if (!vid.getAttribute('src')) vid.src = `media/clip.mp4?v=${S.build}`;
  vid.currentTime = 0;
  Promise.resolve(vid.play()).then(() => { cancelAnimationFrame(headReq); follow(); })
    .catch(() => showStill('▶ Play'));   // autoplay refused (e.g. iPhone low-power mode): still + button
}
function startClip() {
  speedLine();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) showStill('▶ Play'); else playClip();
}
if (CLIP) {
  $('#wClip').hidden = $('#wWhere').hidden = false;
  $('#welcome .card').classList.add('clip');
  $('#wStill').src = `media/still.jpg?v=${S.build}`;
  $('#wClip .freeze').insertAdjacentHTML('beforeend', CLIP.deer.map(([x, y, r]) =>
    `<div class="ring" style="left:${x}%;top:${y}%;width:${2 * r}%"></div>`).join(''));
  const b0 = CLIP.brake.indexOf(1), vMin = Math.min(...CLIP.mph);
  // Speed goes public (PI, 2026-11-01).
  // Facts in the story (time, place, "missed it", 2.3 s) confirmed by PI 2026-11-01.
  $('#wStory').innerHTML = `<b>Oct 24, 2026, 10:35 pm, CA-299 in Trinity County.</b> A deer stepped into my lane
    ${(CLIP.in_lane - CLIP.seen).toFixed(1)} seconds after it first showed up on my car's camera, and a second one stood
    on the shoulder. I braked from
    ${Math.round(CLIP.mph[b0])} to ${Math.round(vMin)} mph and missed it. That ${S.seg_mi}-mile stretch has ${CLIP.n} police-reported
    animal crashes from ${S.years}, at least ${CLIP.lo}× the state average per mile driven.`;
  vid.addEventListener('ended', () => showStill('↻ Replay'));
  $('#wReplay').addEventListener('click', playClip);
  $('#wWhere').addEventListener('click', () => {
    closeModals();
    if (state.view === 'rank') setView('map');
    if (state.segGeo) select(CLIP.seg, true); else state.sel = CLIP.seg;   // not loaded yet: the start-up code flies there
  });
  window.addEventListener('resize', () => { if ($('#welcome').classList.contains('on')) speedLine(); });
  // where the deer was in my lane (my car's GPS, ~10 m); tapping it plays the clip again
  const pin = document.createElement('button');
  pin.id = 'nearMiss'; pin.title = 'My near miss, Oct 24, 2026: tap to watch';
  pin.setAttribute('aria-label', pin.title);
  pin.addEventListener('click', ev => { ev.stopPropagation(); openModal('#welcome'); });
  new maplibregl.Marker({ element: pin }).setLngLat(CLIP.where).addTo(map);
}

// ---------------- modals ----------------
function openModal(id) {
  document.querySelectorAll('.modal').forEach(m => m.classList.toggle('on', '#' + m.id === id));
  if (id === '#welcome' && CLIP) startClip();
}
function closeModals() {
  document.querySelectorAll('.modal.on').forEach(m => m.classList.remove('on')); lsSet(WELCOMED, '1');
  if (CLIP) { vid.pause(); cancelAnimationFrame(headReq); }
}
document.querySelectorAll('[data-how]').forEach(a => a.addEventListener('click', ev => { ev.preventDefault(); openModal('#how'); }));
document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', ev => { if (ev.target === m) closeModals(); }));
document.querySelectorAll('.modal .x').forEach(b => b.addEventListener('click', closeModals));
$('#wGo').addEventListener('click', closeModals);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });
$('#grab').addEventListener('click', () => $('#panel').classList.toggle('full'));
// new key when the card gains something returning visitors should see once (2026-11-01: the dashcam clip)
const WELCOMED = 'wvc.welcomed.clip';
if (lsGet(WELCOMED) !== '1' && HASH.intro !== '0') openModal('#welcome');

// ---------------- start ----------------
legend();
(async () => {
  try {
    state.segGeo = decodeSegments(await getJSON(`data/segments.json?v=${S.build}`));
  } catch (e) { $('#detail').textContent = `Could not load the map data (${e.message}).`; return; }
  if (styleReady) addLayers();
  renderDetail();
  maybeCrashes();
  state.details = await getJSON(`data/details.json?v=${S.build}`).catch(e => { console.error(e); return null; });
  if (state.sel !== null && state.sel < state.segGeo.features.length) select(state.sel, !HASH.map); else state.sel = null;
  renderDetail();
  if (!state.details) return;
  buildRows();
  if (R.route !== null && !R.rows.route[R.route]) R.route = null;
  if (state.view === 'rank') renderRank();
})();
if (HASH.v === 'rank') setView('rank');
