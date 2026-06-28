'use strict';

const CHICAGO     = { lat: 41.85, lon: -87.65 };
const CHI_311     = 'https://data.cityofchicago.org/resource/v6vf-nfxy.json';
const CHI_GEO     = 'https://data.cityofchicago.org/resource/igwz-8jzy.geojson';
const CHI_BOUNDS  = L.latLngBounds([41.63, -87.95], [42.05, -87.38]);

const HEAT_LOCS = [
  { name: 'Loop',         lat: 41.882, lon: -87.628, icon: '🏙' },
  { name: 'Lincoln Park', lat: 41.925, lon: -87.644, icon: '🌳' },
  { name: 'Oak Park',     lat: 41.885, lon: -87.784, icon: '🏘' },
  { name: 'Naperville',   lat: 41.786, lon: -88.147, icon: '🏡' },
  { name: 'Kankakee',     lat: 41.120, lon: -87.860, icon: '🌾' },
];

const TIER_COLOR = { high: '#ef4444', medium: '#f97316', low: '#eab308', none: '#22c55e' };
const TIER_LABEL = { high: 'Critical', medium: 'Elevated', low: 'Routine', none: 'Clear' };

let map, choroplethLayer, dotLayer, rankLayer, tempLayer;
let droughtData, areaScores, geoData, allComplaints, vulnData;
let selectedKey = null;
let keyToLayer  = {};
let sortMode    = 'urgency';
let zoneFilter  = '';
let mapMode     = 'pressure';   // 'pressure' | 'vuln'

const VULN_COLOR = '#a855f7';
const canvas = L.canvas({ padding: 0.5 });

// ── INIT ──────────────────────────────────────────
async function init() {
  step(1, 'active');
  let complaints, geo, drought;
  try {
    complaints = await loadComplaints();
    step(1, 'done', `${complaints.length.toLocaleString()} requests`);
  } catch (e) { return fatal('311 data: ' + e.message); }

  step(2, 'active');
  try {
    geo = await loadGeo();
    step(2, 'done', '77 community areas');
  } catch (e) { return fatal('Boundaries: ' + e.message); }

  step(3, 'active');
  try {
    drought = await loadDrought();
    step(3, 'done', `${drought.precipMM}mm / 30 days`);
  } catch {
    drought = { factor: 0.3, precipMM: '--', expectedMM: 75, label: 'Moderate' };
    step(3, 'done', 'estimated');
  }

  step(4, 'active');
  let vuln = {};
  try { vuln = await loadVulnerability(); } catch {}
  allComplaints = complaints;
  geoData       = geo;
  droughtData   = drought;
  vulnData      = vuln;
  areaScores    = scoreAreas(complaints, drought.factor, vuln);

  // Load 50+ years of maintenance history in the background (non-blocking)
  loadHistorical().then(hist => {
    const now = Date.now();
    for (const [key, h] of Object.entries(hist)) {
      if (!areaScores[key]) continue;
      areaScores[key].oldestKnown = h.oldest;
      areaScores[key].histCount   = h.histCount;
      const curLast = areaScores[key].complaints
        .filter(c => c.closed_date && (c.status||'').toLowerCase() !== 'open')
        .map(c => new Date(c.closed_date)).filter(d => !isNaN(d))
        .reduce((best, d) => (!best || d > best ? d : best), null);
      const candidates = [h.lastHistService, curLast].filter(Boolean);
      areaScores[key].lastService  = candidates.length ? new Date(Math.max(...candidates.map(d => +d))) : null;
      areaScores[key].yearsKnown   = h.oldest ? Math.round((now - h.oldest) / (365.25 * 86400000)) : null;
      // Service gap for neglect sort
      const ls = areaScores[key].lastService;
      areaScores[key].serviceGapDays = ls ? Math.round((now - ls) / 86400000) : null;
      // Recompute CSI with neglect factor
      const sGap = areaScores[key].serviceGapDays;
      if (sGap != null) {
        const a = areaScores[key];
        const neglectFac = Math.min(1, sGap / 1825); // 5 years = full neglect
        const trendUp    = a.trendPct != null ? Math.max(0, a.trendPct / 100) : 0;
        const vulnFac    = a.hardship != null ? Math.min(1, a.hardship / 100) : 0;
        a.csi = Math.min(100, Math.round(
          (a.score * 0.42 + trendUp * 0.13 + (a.openRate || 0) / 100 * 0.08 + droughtData.factor * 0.04 + neglectFac * 0.15 + vulnFac * 0.18) * 100
        ));
      }
    }
    renderPanel();
  }).catch(() => {});

  step(4, 'done', Object.keys(areaScores).length + ' areas scored');

  setTimeout(() => {
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    maybeOnboard();
    buildMap();
    setTimeout(() => {
      map.invalidateSize();
      drawChoropleth();
      drawRanks();
      drawDots(complaints);
      renderPanel();
      fetchTemps();
    }, 100);
  }, 250);
}

// ── LOADING ───────────────────────────────────────
function step(n, state, note) {
  const el = document.getElementById(`step-${n}`); if (!el) return;
  const icon = el.querySelector('.step-icon'), txt = el.querySelector('.step-text');
  if (state === 'active') {
    el.classList.remove('pending'); icon.textContent = '⟳'; icon.classList.add('spin');
  } else {
    el.classList.add('done'); icon.textContent = '✓'; icon.classList.remove('spin');
    if (note) txt.textContent = txt.textContent.split('…')[0] + ' — ' + note;
    const nxt = document.getElementById(`step-${n + 1}`);
    if (nxt?.classList.contains('pending')) nxt.classList.remove('pending');
  }
}
function fatal(msg) {
  const el = document.getElementById('ls-error'); el.textContent = msg; el.classList.remove('hidden');
}

// ── DATA FETCH ────────────────────────────────────
async function loadComplaints() {
  const since = new Date(Date.now() - 60 * 86400000).toISOString().split('.')[0];
  const where = encodeURIComponent(`sr_type like 'Tree%' AND created_date >= '${since}'`);
  const sel   = 'sr_number,sr_type,status,created_date,closed_date,community_area,latitude,longitude,street_address';
  const r = await fetch(`${CHI_311}?$where=${where}&$select=${sel}&$limit=50000&$order=created_date+DESC`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function loadGeo() {
  const r = await fetch(CHI_GEO); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
}

async function loadHistorical() {
  const agg = '$select=community_area,min(creation_date)+as+oldest,max(completion_date)+as+last_service,count(*)+as+hist_count&$where=community_area+IS+NOT+NULL&$group=community_area&$limit=100';
  const [trim, debris] = await Promise.all([
    fetch(`https://data.cityofchicago.org/resource/uxic-zsuj.json?${agg}`).then(r => r.ok ? r.json() : []),
    fetch(`https://data.cityofchicago.org/resource/mab8-y9h3.json?${agg}`).then(r => r.ok ? r.json() : []),
  ]);
  const map = {};
  const parse = d => {
    const key = String(parseInt(d.community_area || '0', 10));
    if (key === '0') return;
    if (!map[key]) map[key] = { oldest: null, lastHistService: null, histCount: 0 };
    const oldest = d.oldest ? new Date(d.oldest) : null;
    const svc    = d.last_service ? new Date(d.last_service) : null;
    if (oldest && (!map[key].oldest || oldest < map[key].oldest)) map[key].oldest = oldest;
    if (svc    && (!map[key].lastHistService || svc > map[key].lastHistService)) map[key].lastHistService = svc;
    map[key].histCount += parseInt(d.hist_count || 0, 10);
  };
  trim.forEach(parse); debris.forEach(parse);
  return map;
}

async function loadDrought() {
  const now = new Date(), end = now.toISOString().split('T')[0];
  const from = new Date(+now - 30 * 86400000).toISOString().split('T')[0];
  const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${CHICAGO.lat}&longitude=${CHICAGO.lon}&start_date=${from}&end_date=${end}&daily=precipitation_sum&timezone=America%2FChicago`);
  if (!r.ok) throw new Error('meteo');
  const d   = await r.json();
  const mm  = Math.round((d.daily?.precipitation_sum || []).reduce((s, v) => s + (v || 0), 0));
  const exp = 75;
  const fac = Math.max(0, Math.min(1, (exp - mm) / exp));
  const label = fac >= 0.6 ? 'Severe' : fac >= 0.35 ? 'High' : fac >= 0.15 ? 'Moderate' : 'Low';
  return { precipMM: mm, expectedMM: exp, factor: fac, label };
}

async function loadVulnerability() {
  const r = await fetch('https://data.cityofchicago.org/resource/kn9c-c2s2.json?$limit=100');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const rows = await r.json();
  const map = {};
  for (const d of rows) {
    const key = String(parseInt(d.ca || '0', 10));
    if (!d.ca || key === '0') continue;
    const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    map[key] = {
      hardship:     num(d.hardship_index),
      poverty:      num(d.percent_households_below_poverty),
      income:       num(d.per_capita_income_),
      unemployment: num(d.percent_aged_16_unemployed),
      noDiploma:    num(d.percent_aged_25_without_high_school_diploma),
    };
  }
  return map;
}

async function fetchTemps() {
  const rows = document.getElementById('heat-rows');
  try {
    const results = await Promise.all(HEAT_LOCS.map(loc =>
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m&temperature_unit=fahrenheit`)
        .then(r => r.json()).then(d => ({ ...loc, temp: d.current?.temperature_2m ?? null }))));
    const temps = results.map(r => r.temp).filter(t => t != null);
    if (!temps.length) throw new Error('no data');
    const maxT = Math.max(...temps), minT = Math.min(...temps);
    const rural = results[results.length - 1].temp;
    drawTempMarkers(results, minT, maxT, rural);
    rows.innerHTML = results.filter(r => r.temp != null).map(r => {
      const delta = rural != null ? (r.temp - rural) : null;
      const isHot = r.temp === maxT, isCool = r.temp === minT;
      const col   = isHot ? '#ef4444' : isCool ? '#4ade80' : '#94a3b8';
      const pct   = maxT === minT ? 50 : Math.round(((r.temp - minT) / (maxT - minT)) * 100);
      return `<div class="hr">
        <span class="hr-name ${isHot ? 'hot' : isCool ? 'cool' : ''}">${r.icon} ${r.name}</span>
        <div class="hr-bar-w"><div class="hr-bar" style="width:${pct}%;background:${col}"></div></div>
        <span class="hr-tmp" style="color:${col}">${Math.round(r.temp)}°</span>
        <span class="hr-dlt" style="color:${delta > 0 ? '#f87171' : '#4ade80'}">${delta != null ? (delta >= 0 ? '+' : '') + Math.round(delta) + '°' : ''}</span>
      </div>`;
    }).join('');
  } catch { rows.innerHTML = '<span class="muted-sm">Temperatures unavailable</span>'; }
}

// ── SCORING ───────────────────────────────────────
function typeCategory(srType) {
  const t = (srType || '').toLowerCase();
  if (t.includes('emergen') || t.includes('urgent') || t.includes('fallen'))   return 'Emergency';
  if (t.includes('removal') || t.includes('remov'))                            return 'Removal';
  if (t.includes('trim') || t.includes('prune'))                               return 'Trimming';
  if (t.includes('planting') || t.includes('plant'))                           return 'Planting';
  if (t.includes('debris') || t.includes('clean') || t.includes('branch'))     return 'Debris';
  if (t.includes('stump'))                                                      return 'Stump';
  if (t.includes('inspect'))                                                    return 'Inspection';
  return 'General Service';
}

function scoreAreas(complaints, droughtFactor, vuln) {
  vuln = vuln || {};
  const now = Date.now(), ms30 = 30 * 86400000, ms60 = 60 * 86400000;
  const areas = {};

  for (const c of complaints) {
    const raw = String(c.community_area || '').trim();
    if (!raw || raw === '0') continue;
    const key = String(parseInt(raw, 10));
    if (!areas[key]) areas[key] = { total: 0, open: 0, recent: 0, prev30: 0, complaints: [], closedTimes: [], typeCounts: {}, addrMap: {} };
    const a = areas[key];
    a.total++; a.complaints.push(c);
    const ts     = new Date(c.created_date).getTime();
    const isOpen = (c.status || '').toLowerCase() === 'open';
    if (isOpen) a.open++;
    if (!isNaN(ts)) {
      const age = now - ts;
      if (age < ms30)       a.recent++;
      else if (age < ms60)  a.prev30++;
    }
    const cat = typeCategory(c.sr_type);
    a.typeCounts[cat] = (a.typeCounts[cat] || 0) + 1;
    if (!isOpen && c.closed_date && !isNaN(ts)) {
      const ct = new Date(c.closed_date).getTime();
      if (!isNaN(ct) && ct > ts) a.closedTimes.push((ct - ts) / 86400000);
    }
    const addr = (c.street_address || '').trim().toUpperCase();
    if (addr) {
      if (!a.addrMap[addr]) a.addrMap[addr] = { count: 0, openCount: 0, lastClosed: null };
      const e = a.addrMap[addr]; e.count++;
      if (isOpen) e.openCount++;
      if (!isOpen && c.closed_date && (!e.lastClosed || new Date(c.closed_date) > new Date(e.lastClosed)))
        e.lastClosed = c.closed_date;
    }
  }

  for (const a of Object.values(areas)) {
    a.trendPct = a.prev30 > 0 ? Math.round(((a.recent - a.prev30) / a.prev30) * 100) : null;
    a.avgResponseDays = a.closedTimes.length >= 3
      ? Math.round(a.closedTimes.reduce((s, v) => s + v, 0) / a.closedTimes.length) : null;
    a.problems = Object.entries(a.addrMap)
      .filter(([, v]) => v.count >= 3).sort((x, y) => y[1].count - x[1].count).slice(0, 8)
      .map(([addr, v]) => ({ addr, ...v }));
  }

  const raws = {};
  for (const [k, a] of Object.entries(areas))
    raws[k] = (a.open * 2 + a.recent * 3 + a.total * 0.5) * (1 + droughtFactor * 0.8);
  const maxRaw = Math.max(...Object.values(raws), 1);
  const scores = {};
  for (const [k, raw] of Object.entries(raws)) {
    const s           = raw / maxRaw;
    const a           = areas[k];
    const v           = vuln[k] || {};
    const openRate    = a.total > 0 ? Math.round(a.open / a.total * 100) : 0;
    const emergencyShare = a.total > 0 ? Math.round((a.typeCounts.Emergency || 0) / a.total * 100) : 0;
    const trendUp     = a.trendPct != null ? Math.max(0, a.trendPct / 100) : 0;
    const vulnFac     = v.hardship != null ? Math.min(1, v.hardship / 100) : 0;
    const csi         = Math.min(100, Math.round((s * 0.55 + trendUp * 0.15 + openRate / 100 * 0.08 + droughtFactor * 0.04 + vulnFac * 0.18) * 100));
    scores[k] = {
      ...a, score: s, tier: s >= 0.6 ? 'high' : s >= 0.3 ? 'medium' : s >= 0.08 ? 'low' : 'none',
      openRate, emergencyShare, csi,
      hardship: v.hardship ?? null, poverty: v.poverty ?? null, income: v.income ?? null,
      unemployment: v.unemployment ?? null, noDiploma: v.noDiploma ?? null,
    };
  }
  return scores;
}

// ── MAP ───────────────────────────────────────────
function buildMap() {
  map = L.map('map', { zoomControl: false, minZoom: 10, maxBounds: CHI_BOUNDS, maxBoundsViscosity: 0.85 })
         .setView([41.855, -87.67], 11);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO', maxZoom: 19,
  }).addTo(map);

  const ctrl = L.control({ position: 'topleft' });
  ctrl.onAdd = () => {
    const d = L.DomUtil.create('div', 'info-card');
    d.innerHTML = '<p class="ic-hint">Hover a neighborhood</p>';
    L.DomEvent.disableClickPropagation(d);
    L.DomEvent.disableScrollPropagation(d);
    return d;
  };
  ctrl.addTo(map);

  const view = L.control({ position: 'topright' });
  view.onAdd = () => {
    const d = L.DomUtil.create('div', 'view-toggle');
    d.innerHTML = `
      <div class="vt-hdr">Map view</div>
      <button class="vt-btn active" data-mode="pressure" aria-label="View service pressure map">🌳 Service pressure</button>
      <button class="vt-btn" data-mode="vuln" aria-label="View social vulnerability map">⚖ Social vulnerability</button>`;
    L.DomEvent.disableClickPropagation(d);
    L.DomEvent.disableScrollPropagation(d);
    d.querySelectorAll('.vt-btn').forEach(b => b.addEventListener('click', () => setMapMode(b.dataset.mode)));
    return d;
  };
  view.addTo(map);

  const leg = L.control({ position: 'bottomleft' });
  leg.onAdd = () => L.DomUtil.create('div', 'map-legend');
  leg.addTo(map);
  updateLegend();
  map.on('zoomend', onZoom);
}

function updateLegend() {
  const el = document.querySelector('.map-legend'); if (!el) return;
  if (mapMode === 'vuln') {
    el.innerHTML =
      '<div class="leg-title">Social vulnerability</div>' +
      '<div class="leg-grad"></div>' +
      '<div class="leg-ends"><span>More vulnerable</span><span>Less</span></div>' +
      '<div class="leg-note">Chicago Hardship Index · ACS</div>';
  } else {
    el.innerHTML = [['high','Critical'],['medium','Elevated'],['low','Routine'],['none','Clear']].map(([t,l]) =>
      `<div class="leg-row"><div class="leg-dot" style="background:${TIER_COLOR[t]}"></div>${l}</div>`
    ).join('') + '<div class="leg-note">Zoom in to see open complaint pins</div>';
  }
}

function setMapMode(mode) {
  if (mode === mapMode) return;
  mapMode = mode;
  document.querySelectorAll('.vt-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  Object.keys(keyToLayer).forEach(applyStyle);
  drawRanks();
  updateLegend();
}

function onZoom() {
  const z = map.getZoom();
  if (dotLayer) z >= 13 ? (!map.hasLayer(dotLayer) && map.addLayer(dotLayer))
                        : (map.hasLayer(dotLayer) && map.removeLayer(dotLayer));
  map.getContainer().classList.toggle('labels-on', z >= 12);
}

function areaKey(props) {
  return String(parseInt(String(props.area_numbe || props.area_num_1 || props.area || '0'), 10));
}
function areaName(key) {
  if (!geoData) return `Area ${key}`;
  for (const f of geoData.features)
    if (areaKey(f.properties) === key)
      return titleCase(f.properties.community || `Area ${key}`);
  return `Area ${key}`;
}

function vulnFill(k) { const h = areaScores?.[k]?.hardship; return h != null ? 0.18 + Math.min(1, h / 100) * 0.62 : 0.05; }
function baseStyle(k)  {
  const s = areaScores?.[k];
  if (mapMode === 'vuln') return { fillColor: VULN_COLOR, fillOpacity: vulnFill(k), color: '#120a1f', weight: 0.7, opacity: 0.9 };
  return { fillColor: TIER_COLOR[s?.tier||'none'], fillOpacity: s ? 0.28+s.score*0.55 : 0.1, color: '#0a1a0a', weight: 0.7, opacity: 0.9 };
}
function hoverStyle(k) {
  const s = areaScores?.[k];
  if (mapMode === 'vuln') return { fillColor: '#c084fc', fillOpacity: Math.min(0.9, vulnFill(k)+0.16), color: '#ffffff', weight: 2.5, opacity: 1 };
  return { fillColor: TIER_COLOR[s?.tier||'none'], fillOpacity: s ? Math.min(0.88, 0.42+s.score*0.46) : 0.3, color: '#ffffff', weight: 2.5, opacity: 1 };
}
function selStyle(k)   {
  const s = areaScores?.[k];
  if (mapMode === 'vuln') return { fillColor: '#c084fc', fillOpacity: Math.min(0.92, vulnFill(k)+0.12), color: '#22d3ee', weight: 3, opacity: 1 };
  return { fillColor: TIER_COLOR[s?.tier||'none'], fillOpacity: s ? Math.min(0.9, 0.5+s.score*0.4) : 0.35, color: '#4ade80', weight: 3, opacity: 1 };
}

function applyStyle(key) {
  const layer = keyToLayer[key]; if (!layer) return;
  layer.setStyle(key === selectedKey ? selStyle(key) : baseStyle(key));
}

function setInfoCard(key, name, s) {
  const el = document.querySelector('.info-card'); if (!el) return;
  if (!name) { el.innerHTML = '<p class="ic-hint">Hover a neighborhood</p>'; return; }
  const tier = s?.tier || 'none', col = TIER_COLOR[tier];
  el.innerHTML = `
    <div class="ic-top">
      <div class="ic-name">${name}</div>
      <span class="ic-tier" style="background:${col}20;color:${col}">${TIER_LABEL[tier]}</span>
    </div>
    <div class="ic-row">
      <div class="ic-stat"><span class="ic-n" style="color:#ef4444">${s?.open||0}</span><span class="ic-l">open</span></div>
      <div class="ic-stat"><span class="ic-n">${s?.total||0}</span><span class="ic-l">total</span></div>
      <div class="ic-stat"><span class="ic-n" style="color:var(--green)">${s?.csi ?? Math.round((s?.score||0)*100)}</span><span class="ic-l">CSI</span></div>
    </div>
    ${s?.trendPct !== null && s?.trendPct !== undefined ? `<div class="ic-trend ${s.trendPct > 15 ? 'up' : s.trendPct < -15 ? 'dn' : 'fl'}">${s.trendPct > 15 ? '↑' : s.trendPct < -15 ? '↓' : '→'} ${s.trendPct > 0 ? '+' : ''}${s.trendPct}% vs last 30d</div>` : ''}
    ${s?.hardship != null ? `<div class="ic-vuln">⚖ Hardship ${Math.round(s.hardship)}/100${s.poverty != null ? ` · ${Math.round(s.poverty)}% poverty` : ''}</div>` : ''}
    ${key ? `<button class="ic-btn" onclick="openDispatch('${key}')">Get Dispatch Brief ▸</button>` : ''}`;
}

function drawChoropleth() {
  if (choroplethLayer) map.removeLayer(choroplethLayer);
  keyToLayer = {};
  choroplethLayer = L.geoJSON(geoData, {
    style: f => baseStyle(areaKey(f.properties)),
    onEachFeature: (f, layer) => {
      const k = areaKey(f.properties), name = areaName(k), s = areaScores[k];
      keyToLayer[k] = layer;
      layer.bindTooltip(name, { permanent: true, direction: 'center', className: 'area-label', opacity: 1 });
      layer.on('mouseover', () => {
        if (k !== selectedKey) layer.setStyle(hoverStyle(k));
        setInfoCard(k, name, s);
      });
      layer.on('mouseout', () => {
        applyStyle(k);
        if (selectedKey) setInfoCard(selectedKey, areaName(selectedKey), areaScores[selectedKey]);
        else setInfoCard(null, null, null);
      });
      layer.on('click', e => {
        L.DomEvent.stopPropagation(e);
        const prev = selectedKey;
        selectedKey = k; applyStyle(k);
        if (prev && prev !== k) applyStyle(prev);
        setInfoCard(k, name, s);
        highlightZone(k);
        map.panTo(layer.getBounds().getCenter(), { animate: true, duration: 0.4 });
      });
    },
  }).addTo(map);
  map.getContainer().classList.toggle('labels-on', map.getZoom() >= 12);
}

function drawRanks() {
  if (rankLayer) map.removeLayer(rankLayer);
  const entries = Object.entries(areaScores);
  const top = (mapMode === 'vuln'
    ? entries.filter(([, s]) => s.hardship != null).sort((a, b) => b[1].hardship - a[1].hardship)
    : entries.sort((a, b) => b[1].score - a[1].score)).slice(0, 15);
  rankLayer = L.layerGroup(top.map(([key, s], i) => {
    const layer = keyToLayer[key]; if (!layer) return null;
    const col = mapMode === 'vuln' ? VULN_COLOR : TIER_COLOR[s.tier];
    return L.marker(layer.getBounds().getCenter(), {
      interactive: false, zIndexOffset: 100,
      icon: L.divIcon({
        className: '',
        html: `<div class="rank-dot" style="background:${col}">${i+1}</div>`,
        iconSize: [22,22], iconAnchor: [11,11],
      }),
    });
  }).filter(Boolean));
  map.addLayer(rankLayer);
}

function drawTempMarkers(results, minT, maxT, rural) {
  if (tempLayer) map.removeLayer(tempLayer);
  const mkrs = results.filter(r => r.temp != null && CHI_BOUNDS.contains([r.lat, r.lon])).map(r => {
    const isHot = r.temp === maxT, isCool = r.temp === minT;
    const col   = isHot ? '#ef4444' : isCool ? '#4ade80' : '#f59e0b';
    const delta = rural != null ? r.temp - rural : null;
    return L.marker([r.lat, r.lon], {
      interactive: false, zIndexOffset: 200,
      icon: L.divIcon({
        className: '',
        html: `<div class="temp-pin" style="border-color:${col}60">
          <span class="tp-icon">${r.icon}</span>
          <div><div class="tp-name">${r.name}</div>
          <div class="tp-val" style="color:${col}">${Math.round(r.temp)}°${delta != null ? ` (${delta>=0?'+':''}${Math.round(delta)}°)` : ''}</div></div>
        </div>`,
        iconSize: [110,36], iconAnchor: [55,18],
      }),
    });
  });
  tempLayer = L.layerGroup(mkrs);
  map.addLayer(tempLayer);
}

function drawDots(complaints) {
  const open = complaints.filter(c => c.latitude && c.longitude && (c.status||'').toLowerCase() === 'open');
  dotLayer = L.layerGroup(open.map(c => {
    const m = L.circleMarker([+c.latitude, +c.longitude], {
      renderer: canvas, radius: 5,
      fillColor: '#ef4444', color: '#7f1d1d', weight: 1.5, fillOpacity: 0.85,
    });
    m.bindPopup(`<div class="dot-popup"><div class="dp-type">${c.sr_type||'Tree Request'}</div>
      <div class="dp-addr">${c.street_address||''}</div>
      <div class="dp-date">${c.created_date ? new Date(c.created_date).toLocaleDateString() : ''}</div>
      <div class="dp-open">⚠ Open — needs attention</div></div>`, { maxWidth: 200 });
    return m;
  }));
  if (map.getZoom() >= 13) map.addLayer(dotLayer);
}

// ── PANEL ─────────────────────────────────────────
function renderPanel() {
  const allEntries = Object.entries(areaScores);
  const counts = { high: 0, medium: 0, low: 0, none: 0 };
  allEntries.forEach(([, s]) => counts[s.tier]++);
  const n = allEntries.length || 1;

  ['high','medium','low','none'].forEach(t => {
    const el = document.getElementById('pb-' + t); if (el) el.style.width = (counts[t]/n*100)+'%';
  });
  document.getElementById('pl-high').textContent       = counts.high;
  document.getElementById('pl-med').textContent        = counts.medium;
  document.getElementById('pl-low').textContent        = counts.low;
  document.getElementById('stat-reqs').textContent     = allComplaints.length.toLocaleString();
  document.getElementById('stat-high-hdr').textContent = counts.high;

  const d = droughtData;
  const hydr = 1 - d.factor;
  const fill = document.getElementById('drought-fill');
  const dcol = d.factor >= 0.5 ? '#ef4444' : d.factor >= 0.3 ? '#f97316' : d.factor >= 0.15 ? '#eab308' : '#22c55e';
  fill.style.background = `linear-gradient(90deg, #22c55e ${Math.round(hydr*100-20)}%, ${dcol})`;
  document.getElementById('drought-status').style.color = dcol;
  document.getElementById('drought-status').textContent = d.label + ' drought stress';
  document.getElementById('drought-detail').textContent = `${d.precipMM}mm received vs ${d.expectedMM}mm avg`;

  // City intelligence stats
  const cityOpen = allEntries.reduce((s, [, a]) => s + a.open, 0);
  const surging  = allEntries.filter(([, a]) => a.trendPct != null && a.trendPct > 20).length;
  const gapVals  = allEntries.map(([, a]) => a.serviceGapDays).filter(v => v != null && v > 0);
  const avgGap   = gapVals.length ? Math.round(gapVals.reduce((s, v) => s + v, 0) / gapVals.length) : null;
  const elOpen = document.getElementById('intel-open');
  const elUp   = document.getElementById('intel-up');
  const elGap  = document.getElementById('intel-gap');
  if (elOpen) elOpen.textContent = cityOpen.toLocaleString();
  if (elUp)   elUp.textContent   = surging;
  if (elGap)  elGap.textContent  = avgGap ? (avgGap > 365 ? Math.round(avgGap/365) + 'yr' : avgGap + 'd') : '—';

  // Sort by active mode
  let sorted = [...allEntries];
  if (sortMode === 'neglect')
    sorted.sort((a, b) => (b[1].serviceGapDays || 0) - (a[1].serviceGapDays || 0));
  else if (sortMode === 'trend')
    sorted.sort((a, b) => (b[1].trendPct ?? -999) - (a[1].trendPct ?? -999));
  else
    sorted.sort((a, b) => (b[1].csi ?? 0) - (a[1].csi ?? 0));

  // Filter by neighborhood search
  const q = zoneFilter.trim().toLowerCase();
  if (q) sorted = sorted.filter(([k]) => areaName(k).toLowerCase().includes(q));

  const listEl = document.getElementById('zone-list');
  if (!sorted.length) {
    listEl.innerHTML = `<div class="zone-empty">No neighborhood matches “${zoneFilter}”.</div>`;
    return;
  }

  listEl.innerHTML = sorted.slice(0, q ? 77 : 20).map(([k, s], i) => {
    const name   = areaName(k), col = TIER_COLOR[s.tier];
    const csiVal = s.csi ?? Math.round(s.score * 100);
    const sGap   = s.serviceGapDays;
    const sGapStr = sGap != null
      ? (sGap > 730 ? `${Math.round(sGap/365)}yr` : sGap > 60 ? `${Math.round(sGap/30)}mo` : `${sGap}d`)
      : null;
    const trend = s.trendPct !== null
      ? `<span class="zt ${s.trendPct > 15 ? 'zt-up' : s.trendPct < -15 ? 'zt-dn' : 'zt-fl'}">${s.trendPct > 15 ? '↑' : s.trendPct < -15 ? '↓' : '→'}${Math.abs(s.trendPct)}%</span>`
      : '';
    return `<div class="zi" data-key="${k}" onclick="clickZone('${k}')">
      <div class="zi-rank" style="color:${col}">${i+1}</div>
      <div class="zi-body">
        <div class="zi-top">
          <span class="zi-name">${name}</span>
          ${trend}
          <span class="zi-tier" style="background:${col}18;color:${col};border-color:${col}30">${TIER_LABEL[s.tier]}</span>
        </div>
        <div class="zi-nums">
          <span class="zi-open">${s.open} open</span>
          <span class="sep">·</span>
          <span class="zi-tot">${s.total} total</span>
          ${s.problems?.length ? `<span class="sep">·</span><span class="zi-prb">⚠ ${s.problems.length} repeat</span>` : ''}
          ${s.avgResponseDays ? `<span class="sep">·</span><span class="zi-avg">${s.avgResponseDays}d avg</span>` : ''}
        </div>
        <div class="zi-meta">
          <span class="zm zm-csi">CSI ${csiVal}</span>
          ${(s.hardship ?? 0) >= 50 ? `<span class="zm zm-vuln">⚖ ${Math.round(s.hardship)}</span>` : ''}
          ${(s.openRate ?? 0) >= 55 ? `<span class="zm zm-or">${s.openRate}% open</span>` : ''}
          ${(s.emergencyShare ?? 0) > 10 ? `<span class="zm zm-emrg">🚨 ${s.emergencyShare}%</span>` : ''}
          ${sGapStr ? `<span class="zm zm-gap">${sGapStr} since svc</span>` : (s.yearsKnown ? `<span class="zm zm-age">🌳 ${s.yearsKnown}yr</span>` : '')}
        </div>
        <div class="zi-bar"><div class="zi-fill" style="width:${csiVal}%;background:${col}"></div></div>
      </div>
      <button class="zi-btn" onclick="event.stopPropagation();openDispatch('${k}')" aria-label="Get dispatch brief for ${name}">Brief ▸</button>
    </div>`;
  }).join('');
}

function highlightZone(key) {
  document.querySelectorAll('.zi').forEach(el => el.classList.remove('sel'));
  const el = document.querySelector(`.zi[data-key="${key}"]`);
  if (el) { el.classList.add('sel'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

// ── SORT ──────────────────────────────────────────
function setSortMode(mode) {
  sortMode = mode;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
  const subs = {
    urgency: 'Ranked by open requests + drought stress',
    neglect: 'Ranked by days since last recorded service',
    trend:   'Ranked by fastest-growing complaint rate',
  };
  const subEl = document.getElementById('zones-sub');
  if (subEl) subEl.textContent = (subs[mode] || '') + ' · click to navigate';
  renderPanel();
}

// ── ZONE CLICK ────────────────────────────────────
function clickZone(key) {
  const prev = selectedKey;
  selectedKey = key; applyStyle(key);
  if (prev && prev !== key) applyStyle(prev);
  highlightZone(key);
  setInfoCard(key, areaName(key), areaScores[key]);
  const layer = keyToLayer[key];
  if (layer) map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 13, animate: true });
}

// ── DISPATCH MODAL ────────────────────────────────
const TYPE_COLOR = { Emergency:'#ef4444', Removal:'#f97316', Trimming:'#eab308', Debris:'#94a3b8', Planting:'#4ade80', Stump:'#a78bfa', Inspection:'#38bdf8', 'General Service':'#64748b' };

function openDispatch(key) {
  const name = areaName(key), s = areaScores[key]; if (!s) return;
  const col  = TIER_COLOR[s.tier];
  document.getElementById('modal-title').textContent  = name;
  const tierEl = document.getElementById('modal-tier');
  tierEl.textContent = TIER_LABEL[s.tier];
  tierEl.style.cssText = `background:${col}20;color:${col};border-color:${col}40`;
  document.getElementById('modal-overlay').classList.remove('hidden');

  const body = document.getElementById('modal-body');

  const recent      = s.complaints.filter(c => { const ts = new Date(c.created_date).getTime(); return !isNaN(ts) && Date.now()-ts < 30*86400000; });
  const openC       = s.complaints.filter(c => (c.status||'').toLowerCase() === 'open');
  const typeEntries = Object.entries(s.typeCounts).sort((a,b) => b[1]-a[1]);
  const maxType     = typeEntries[0]?.[1] || 1;
  const topTrees    = openC.slice(0, 5).map(c => ({ type: c.sr_type||'Tree Request', status: c.status||'Open', address: c.street_address||'' }));

  // 6 × 10-day buckets, bucket[0] = 0-10d ago (most recent)
  const rawBuckets = Array(6).fill(0);
  for (const c of s.complaints) {
    const ts = new Date(c.created_date).getTime();
    if (isNaN(ts)) continue;
    const daysAgo = (Date.now() - ts) / 86400000;
    if (daysAgo < 0 || daysAgo >= 60) continue;
    rawBuckets[Math.min(5, Math.floor(daysAgo / 10))]++;
  }
  const bDisplay = [...rawBuckets].reverse(); // oldest → newest for display
  const bMax     = Math.max(...bDisplay, 1);
  const bLabels  = ['60d','50d','40d','30d','20d','Now'];
  const accel    = bDisplay[5] > bDisplay[3] * 1.4;

  const csiVal    = s.csi ?? Math.round(s.score * 100);
  const tPct      = s.trendPct;
  const trendDir  = tPct === null ? null : tPct > 15 ? 'up' : tPct < -15 ? 'dn' : 'fl';
  const trendText = trendDir === 'up' ? `↑ ${tPct}% more complaints than last month — situation worsening`
                  : trendDir === 'dn' ? `↓ ${Math.abs(tPct)}% fewer than last month — improving`
                  : trendDir === 'fl' ? `→ Volume stable vs last month` : null;

  // Render immediately; AI briefing fills in async
  body.innerHTML = `
    <div class="brief-box">
      <div class="brief-label">AI Field Briefing</div>
      <div id="brief-content" class="brief-body" style="color:var(--muted);font-style:italic">✦ Generating field briefing…</div>
    </div>

    <div class="stat-row">
      <div class="sr-cell"><div class="sr-n" style="color:#ef4444">${s.open}</div><div class="sr-l">Open</div></div>
      <div class="sr-cell"><div class="sr-n">${s.openRate ?? 0}%</div><div class="sr-l">Unresolved</div></div>
      <div class="sr-cell"><div class="sr-n">${recent.length}</div><div class="sr-l">Last 30d</div></div>
      <div class="sr-cell"><div class="sr-n" style="color:var(--green)">${csiVal}</div><div class="sr-l">CSI</div></div>
    </div>

    <div class="week-chart">
      <div class="wc-label">Complaint volume — 10-day windows (oldest → most recent)</div>
      <div class="wc-bars">
        ${bDisplay.map((v, i) => {
          const barH   = Math.max(3, Math.round(v / bMax * 48));
          const opacity = (0.35 + i * 0.13).toFixed(2);
          const barCol  = i === 5 && accel ? '#ef4444' : '#4ade80';
          return `<div class="wc-col">
            <div class="wc-spacer"></div>
            <div class="wc-bar" style="height:${barH}px;background:${barCol};opacity:${opacity}"></div>
            <div class="wc-val">${v}</div>
            <div class="wc-lbl">${bLabels[i]}</div>
          </div>`;
        }).join('')}
      </div>
      ${accel ? '<div class="wc-warn">↑ Complaint rate accelerating — recent 20 days outpacing prior period</div>' : ''}
    </div>

    ${trendText ? `<div class="trend-bar trend-${trendDir}">${trendText}</div>` : ''}

    ${s.hardship != null ? `
    <div class="m-section-hdr">Community Vulnerability <span class="sh-sub">Chicago Hardship Index · ACS</span></div>
    <div class="vuln-row">
      <div class="vuln-cell"><div class="vuln-n">${Math.round(s.hardship)}<span class="vuln-d">/100</span></div><div class="vuln-l">Hardship index</div></div>
      ${s.poverty != null ? `<div class="vuln-cell"><div class="vuln-n">${Math.round(s.poverty)}%</div><div class="vuln-l">Below poverty</div></div>` : ''}
      ${s.income != null ? `<div class="vuln-cell"><div class="vuln-n">$${(s.income/1000).toFixed(1)}k</div><div class="vuln-l">Per-capita income</div></div>` : ''}
      ${s.unemployment != null ? `<div class="vuln-cell"><div class="vuln-n">${Math.round(s.unemployment)}%</div><div class="vuln-l">Unemployment</div></div>` : ''}
    </div>
    <div class="vuln-note">Higher-hardship communities tend to have less canopy and fewer resources to maintain it — prioritizing them advances tree-equity. This score contributes 18% of CSI.</div>` : ''}

    ${(s.yearsKnown || s.lastService || s.histCount) ? `
    <div class="hist-row">
      ${s.yearsKnown ? `<div class="hist-cell">
        <div class="hist-n">~${s.yearsKnown} yrs</div>
        <div class="hist-l">Min. canopy age</div>
        ${s.oldestKnown ? `<div class="hist-sub">First 311 complaint ${s.oldestKnown.getFullYear()}</div>` : ''}
      </div>` : ''}
      ${s.lastService ? `<div class="hist-cell">
        <div class="hist-n">${Math.round((Date.now() - s.lastService) / 86400000)}d ago</div>
        <div class="hist-l">Last serviced</div>
        <div class="hist-sub">${s.lastService.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})}</div>
      </div>` : ''}
      ${s.histCount ? `<div class="hist-cell">
        <div class="hist-n">${(s.histCount + s.total).toLocaleString()}</div>
        <div class="hist-l">Lifetime calls</div>
        <div class="hist-sub">Since ${s.oldestKnown ? s.oldestKnown.getFullYear() : '~2000'}</div>
      </div>` : ''}
    </div>` : ''}

    <div class="m-section-hdr">Work Types</div>
    <div class="type-list">
      ${typeEntries.map(([cat, cnt]) => `
        <div class="type-row">
          <span class="type-nm">${cat}</span>
          <div class="type-bar-w"><div class="type-bar-fill" style="width:${Math.round(cnt/maxType*100)}%;background:${TYPE_COLOR[cat]||'#64748b'}55;border-left:3px solid ${TYPE_COLOR[cat]||'#64748b'}"></div></div>
          <span class="type-ct">${cnt}</span>
        </div>`).join('')}
    </div>

    ${s.problems?.length ? `
    <div class="m-section-hdr">Repeat Problem Locations <span class="sh-sub">(${s.problems.length} addresses, 3+ calls each)</span></div>
    <div class="prob-list">
      ${s.problems.map(p => `
        <div class="prob-row">
          <div class="prob-addr">${p.addr}</div>
          <div class="prob-meta">
            <span class="prob-n">${p.count} calls</span>
            ${p.openCount > 0 ? `<span class="prob-open">${p.openCount} open</span>` : ''}
            <span class="prob-date">${p.lastClosed ? new Date(p.lastClosed).toLocaleDateString() : 'Never closed'}</span>
          </div>
        </div>`).join('')}
    </div>` : ''}

    ${topTrees.length ? `
    <div class="m-section-hdr">Top Priority Addresses</div>
    <div class="addr-list">
      ${topTrees.map(t => `<div class="addr-row">
        <span class="addr-type">${t.type}</span>
        <span class="addr-st ${t.status.toLowerCase()==='open' ? 'open' : 'cl'}">${t.status}</span>
        <span class="addr-loc">${t.address}</span>
      </div>`).join('')}
    </div>` : ''}

    <div class="m-section-hdr">Canopy Intelligence <span class="sh-sub">OpenStreetMap · iNaturalist · live</span></div>
    <div id="tree-intel" class="tree-intel"><span class="muted-sm">Loading canopy data…</span></div>

    <button class="print-btn" onclick="window.print()">Print Field Brief</button>`;

  // Fetch AI briefing and update in-place
  fetch('/api/dispatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      zone: name, totalTrees: s.total, criticalCount: s.open, atRiskCount: recent.length,
      avgRisk: Math.round(s.score * 100), drought: droughtData,
      hardshipIndex: s.hardship, povertyPct: s.poverty,
      topSpecies: typeEntries.slice(0,3).map(([t])=>t).join(', '),
      topTrees: topTrees.map(t => ({ ...t, risk: Math.round(s.score*100), species: t.type, health: t.status })),
      isServiceRequests: true,
    }),
  }).then(r => r.json()).then(d => {
    const el = document.getElementById('brief-content');
    if (el) { el.textContent = d.briefing || 'No briefing generated.'; el.removeAttribute('style'); }
  }).catch(e => {
    const el = document.getElementById('brief-content');
    if (el) { el.textContent = 'Briefing unavailable: ' + e.message; el.style.color = '#f87171'; el.style.fontStyle = 'normal'; }
  });

  // Canopy intelligence: OSM mapped trees + iNaturalist species diversity
  fetchAreaTrees(key).then(td => {
    const el = document.getElementById('tree-intel'); if (!el) return;
    if (!td) { el.innerHTML = '<span class="muted-sm">No canopy data found for this area</span>'; return; }
    const hasData = td.osmCount > 0 || td.inatTotal > 0;
    if (!hasData) { el.innerHTML = '<span class="muted-sm">No mapped trees or plant observations found in OpenStreetMap / iNaturalist for this area yet</span>'; return; }
    el.innerHTML = `
      <div class="ti-stats">
        ${td.osmCount > 0 ? `<div class="ti-stat">
          <div class="ti-n">${td.osmCount.toLocaleString()}</div>
          <div class="ti-l">Mapped trees</div>
          <div class="ti-sub">OpenStreetMap</div>
        </div>` : ''}
        ${td.avgAge ? `<div class="ti-stat">
          <div class="ti-n">~${td.avgAge} yr</div>
          <div class="ti-l">Est. avg tree age</div>
          <div class="ti-sub">${td.ageCount} diameter samples</div>
        </div>` : ''}
        ${td.inatTotal > 0 ? `<div class="ti-stat">
          <div class="ti-n">${td.inatTotal}</div>
          <div class="ti-l">Plant species</div>
          <div class="ti-sub">iNaturalist obs.</div>
        </div>` : ''}
      </div>
      ${td.osmSpecies.length ? `
      <div class="ti-label">Species tagged in OpenStreetMap</div>
      <div class="ti-chips">${td.osmSpecies.map(sp => `<span class="ti-chip">${sp.name}<span class="ti-cn">${sp.count}</span></span>`).join('')}</div>` : ''}
      ${td.inatSpecies.length ? `
      <div class="ti-label" style="margin-top:0.5rem">Research-grade plant observations</div>
      <div class="ti-chips">${td.inatSpecies.map(sp => `<span class="ti-chip">${sp.name}<span class="ti-cn">${sp.count}</span></span>`).join('')}</div>` : ''}
    `;
  }).catch(() => {
    const el = document.getElementById('tree-intel');
    if (el) el.innerHTML = '<span class="muted-sm">Canopy data fetch failed</span>';
  });
}

document.getElementById('modal-close').addEventListener('click', () =>
  document.getElementById('modal-overlay').classList.add('hidden'));
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay'))
    document.getElementById('modal-overlay').classList.add('hidden');
});

// ── ZONE SEARCH ───────────────────────────────────
const searchInput = document.getElementById('zone-search');
const searchClear  = document.getElementById('zs-clear');
if (searchInput) {
  searchInput.addEventListener('input', () => {
    zoneFilter = searchInput.value;
    searchClear.classList.toggle('hidden', !zoneFilter);
    renderPanel();
  });
  searchClear.addEventListener('click', () => {
    zoneFilter = ''; searchInput.value = '';
    searchClear.classList.add('hidden');
    searchInput.focus(); renderPanel();
  });
}

// ── HELP / ONBOARDING ─────────────────────────────
function showHelp()  { document.getElementById('help-overlay').classList.remove('hidden'); }
function hideHelp()  {
  document.getElementById('help-overlay').classList.add('hidden');
  try { localStorage.setItem('canopy-onboarded', '1'); } catch {}
}
function maybeOnboard() {
  let seen = false;
  try { seen = localStorage.getItem('canopy-onboarded') === '1'; } catch {}
  if (!seen) showHelp();
}
document.getElementById('help-btn').addEventListener('click', showHelp);
const heatBtn = document.getElementById('heat-btn');
const heatDropdown = document.getElementById('heat-dropdown');
heatBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = !heatDropdown.classList.contains('hidden');
  heatDropdown.classList.toggle('hidden', open);
  heatBtn.classList.toggle('active', !open);
});
document.addEventListener('click', () => {
  heatDropdown.classList.add('hidden');
  heatBtn.classList.remove('active');
});
document.getElementById('help-close').addEventListener('click', hideHelp);
document.getElementById('help-got').addEventListener('click', hideHelp);
document.getElementById('help-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('help-overlay')) hideHelp();
});

// ── KEYBOARD ──────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const help  = document.getElementById('help-overlay');
  const modal = document.getElementById('modal-overlay');
  if (!help.classList.contains('hidden')) hideHelp();
  else if (!modal.classList.contains('hidden')) modal.classList.add('hidden');
  else if (selectedKey && document.activeElement !== searchInput) {
    const prev = selectedKey; selectedKey = null; applyStyle(prev);
    document.querySelectorAll('.zi').forEach(el => el.classList.remove('sel'));
    setInfoCard(null, null, null);
  }
});

function titleCase(s) { return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }

// ── CANOPY INTELLIGENCE ───────────────────────────
const treeCache = {};

async function fetchAreaTrees(key) {
  if (treeCache[key] !== undefined) return treeCache[key];
  treeCache[key] = null;
  const layer = keyToLayer[key]; if (!layer) return null;
  const b = layer.getBounds();
  const s = b.getSouth().toFixed(4), w = b.getWest().toFixed(4);
  const n = b.getNorth().toFixed(4), e = b.getEast().toFixed(4);
  const [osm, inat] = await Promise.all([
    fetchOSMTrees(s, w, n, e).catch(() => []),
    fetchINatPlants(s, w, n, e).catch(() => null),
  ]);
  // Estimate age from trunk circumference (m): DBH = circ/π, ~1.5 cm DBH/year urban average
  const ages = osm
    .filter(t => t.tags?.circumference)
    .map(t => { const c = parseFloat(t.tags.circumference); return isNaN(c) || c <= 0 ? null : Math.round(c * 100 / (Math.PI * 1.5)); })
    .filter(a => a != null && a > 1 && a < 300);
  const specMap = {};
  osm.forEach(t => {
    const sp = t.tags?.['species:en'] || t.tags?.species || t.tags?.taxon;
    if (sp) specMap[sp] = (specMap[sp] || 0) + 1;
  });
  const result = {
    osmCount:    osm.length,
    avgAge:      ages.length >= 3 ? Math.round(ages.reduce((a, v) => a + v, 0) / ages.length) : null,
    ageCount:    ages.length,
    osmSpecies:  Object.entries(specMap).sort((a, b) => b[1]-a[1]).slice(0, 6).map(([name, count]) => ({ name, count })),
    inatTotal:   inat?.total_results || 0,
    inatSpecies: (inat?.results || []).slice(0, 6).map(r => ({
      name:  r.taxon?.preferred_common_name || r.taxon?.name || '?',
      count: r.count,
    })),
  };
  treeCache[key] = result;
  return result;
}

async function fetchOSMTrees(s, w, n, e) {
  const q = `[out:json][timeout:12];node["natural"="tree"](${s},${w},${n},${e});out body 1200;`;
  const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('Overpass ' + r.status);
  return (await r.json()).elements || [];
}

async function fetchINatPlants(s, w, n, e) {
  const url = `https://api.inaturalist.org/v1/observations/species_counts?iconic_taxon_name=Plantae&quality_grade=research&swlat=${s}&swlng=${w}&nelat=${n}&nelng=${e}&per_page=50`;
  const r = await fetch(url); if (!r.ok) throw new Error('iNat ' + r.status);
  return r.json();
}

window.clickZone    = clickZone;
window.openDispatch = openDispatch;
window.setSortMode  = setSortMode;
window.setMapMode   = setMapMode;

init();
