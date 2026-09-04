const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const STALE_MS = 12000;
const RSSI_FLOOR = -100;
const GAP_AFTER_MS = 6000;
const TRACE_MS = 250;
const TRACE_WINDOW_MS = 90000;
const GPS_MAX_ACCURACY_M = 80;
const TRAIL_MIN_MOVE_M = 6;
const TRAIL_MIN_INTERVAL_MS = 2000;
const ESTIMATE_MIN_POINTS = 8;
// Bump this and docs/sw.js CACHE together on every website upload.
const WEB_VERSION = 18;

const els = {
  status: document.getElementById('status'),
  connectBtn: document.getElementById('connectBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  rssiValue: document.getElementById('rssiValue'),
  lossValue: document.getElementById('lossValue'),
  rxValue: document.getElementById('rxValue'),
  dropValue: document.getElementById('dropValue'),
  seqValue: document.getElementById('seqValue'),
  staleWarn: document.getElementById('staleWarn'),
  noteInput: document.getElementById('noteInput'),
  markBtn: document.getElementById('markBtn'),
  exportBtn: document.getElementById('exportBtn'),
  exportGeoBtn: document.getElementById('exportGeoBtn'),
  clearBtn: document.getElementById('clearBtn'),
  rssiChart: document.getElementById('rssiChart'),
  lossChart: document.getElementById('lossChart'),
  stripChart: document.getElementById('stripChart'),
  brandMark: document.querySelector('.brand-mark'),
  fwValue: document.getElementById('fwValue'),
  webValue: document.getElementById('webValue'),
  bleDebug: document.getElementById('bleDebug'),
  modeRange: document.getElementById('modeRange'),
  modeFoxhunt: document.getElementById('modeFoxhunt'),
  rangeStats: document.getElementById('rangeStats'),
  foxPanel: document.getElementById('foxPanel'),
  trendValue: document.getElementById('trendValue'),
  bandValue: document.getElementById('bandValue'),
  bearingValue: document.getElementById('bearingValue'),
  estDistValue: document.getElementById('estDistValue'),
  trailCountValue: document.getElementById('trailCountValue'),
  foxSeqValue: document.getElementById('foxSeqValue'),
  huntBar: document.getElementById('huntBar'),
  huntBtn: document.getElementById('huntBtn'),
  foundBtn: document.getElementById('foundBtn'),
  huntStatus: document.getElementById('huntStatus'),
  mapWrap: document.getElementById('mapWrap'),
  mapHint: document.getElementById('mapHint'),
  chartsSection: document.getElementById('chartsSection'),
  stripSection: document.getElementById('stripSection'),
  hero: document.getElementById('hero'),
};

const samples = [];
const markers = [];
const traces = [];
const bleBreaks = [];
const rfBreaks = [];
const trail = [];
let groundTruth = null;
let estimate = null;

let device = null;
let server = null;
let txChar = null;
let rxBuffer = '';
let lastPacketAt = 0;
let connectedAt = 0;
let disconnectedAt = 0;
let rfGapFrom = 0;
let lastCounter = null;
let lastNotifyAt = 0;
let pollTimer = null;
let gattBusy = false;
let sessionLive = false;
let wakeLock = null;
let appMode = 'range';
let huntActive = false;
let lastFoxRssi = null;
let lastTrendDelta = null;
let watchId = null;
let latestGeo = null;
let map = null;
let trailLayer = null;
let estimateLayer = null;
let truthLayer = null;
let youLayer = null;
let youMarker = null;
let youAccuracy = null;
let mapReady = false;
let mapCentered = false;
let mapInitTimer = null;
let demoMode = false;

function lossPct(sample) {
  const expected = sample.rx + sample.drop;
  if (!expected) return 0;
  return (100 * sample.drop) / expected;
}

function parseLine(line) {
  if (line == null) return null;
  const text = String(line).replace(/\0/g, '').trim();
  if (!text || text === 'waiting for packets') return null;

  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const obj = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      if (obj.hello && obj.fw) {
        return { hello: true, fw: obj.fw };
      }
      if (typeof obj.c !== 'number') return null;
      const rssi = typeof obj.rssi === 'number' ? obj.rssi : Number(obj.rssi);
      if (!Number.isFinite(rssi)) return null;
      return {
        counter: obj.c,
        rssi,
        nodeMs: obj.t ?? 0,
        rx: obj.rx ?? 0,
        drop: obj.drop ?? 0,
        fw: obj.fw ?? '',
      };
    } catch {
      return null;
    }
  }

  const match = text.match(/^#(-?\d+)\s+RSSI\s+(-?\d+)\s+dBm\s+@\s+(\d+)\s+ms/i);
  if (!match) return null;
  return {
    counter: Number(match[1]),
    rssi: Number(match[2]),
    nodeMs: Number(match[3]),
    rx: samples.length + 1,
    drop: 0,
    fw: '',
  };
}

function setFirmware(fw) {
  if (!fw) return;
  els.fwValue.textContent = `firmware ${fw}`;
}

function ingest(parsed) {
  if (!parsed) return;
  if (parsed.fw) setFirmware(parsed.fw);
  if (parsed.hello) {
    setStatus(`Linked · ${parsed.fw}`, 'live');
    return;
  }
  if (lastCounter !== null && parsed.counter === lastCounter) return;
  lastCounter = parsed.counter;
  applySample(parsed);
}

function rssiClass(rssi) {
  if (rssi <= -85) return 'cliff';
  if (rssi <= -75) return 'bad';
  if (rssi <= -65) return 'mid';
  return 'strong';
}

function bandLabel(rssi) {
  if (rssi <= -85) return 'cliff (~lost)';
  if (rssi <= -75) return 'weak';
  if (rssi <= -65) return 'mid';
  return 'strong';
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.brandMark.className = `brand-mark ${kind}`;
}

function setMode(mode) {
  appMode = mode === 'foxhunt' ? 'foxhunt' : 'range';
  els.modeRange.classList.toggle('active', appMode === 'range');
  els.modeFoxhunt.classList.toggle('active', appMode === 'foxhunt');
  document.body.classList.toggle('mode-foxhunt', appMode === 'foxhunt');
  els.rangeStats.classList.toggle('hidden', appMode === 'foxhunt');
  els.foxPanel.classList.toggle('hidden', appMode !== 'foxhunt');
  els.huntBar.classList.toggle('hidden', appMode !== 'foxhunt');
  els.mapWrap.classList.toggle('hidden', appMode !== 'foxhunt');
  els.chartsSection.classList.toggle('hidden', appMode === 'foxhunt');
  els.stripSection.classList.toggle('hidden', appMode === 'foxhunt');
  els.exportGeoBtn.classList.toggle('hidden', appMode !== 'foxhunt');
  if (appMode === 'foxhunt') {
    startGeoWatch();
    ensureMap();
    updateFoxHud();
    redrawMap();
  } else {
    stopGeoWatch();
    redraw();
  }
}

function invalidateMapSoon() {
  if (!map) return;
  const run = () => {
    try { map.invalidateSize(); } catch { /* map not ready */ }
  };
  requestAnimationFrame(() => {
    run();
    setTimeout(run, 80);
    setTimeout(run, 400);
  });
}

function ensureMap() {
  if (appMode !== 'foxhunt') return;
  if (typeof L === 'undefined') {
    if (els.mapHint) {
      els.mapHint.textContent = 'Map library failed to load — reload over HTTPS.';
    }
    return;
  }
  const el = document.getElementById('map');
  if (!el || els.mapWrap?.classList.contains('hidden') || el.clientHeight < 8) {
    if (mapInitTimer) clearTimeout(mapInitTimer);
    mapInitTimer = setTimeout(ensureMap, 80);
    return;
  }
  if (mapReady) {
    invalidateMapSoon();
    updateYouMarker();
    return;
  }
  map = L.map('map', { zoomControl: true });
  if (latestGeo) {
    map.setView([latestGeo.lat, latestGeo.lon], 17);
    mapCentered = true;
  } else {
    map.setView([20, 0], 2);
  }
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  trailLayer = L.layerGroup().addTo(map);
  estimateLayer = L.layerGroup().addTo(map);
  truthLayer = L.layerGroup().addTo(map);
  youLayer = L.layerGroup().addTo(map);
  mapReady = true;
  invalidateMapSoon();
  updateYouMarker();
  redrawMap();
}

function trailColor(rssi) {
  if (rssi <= -85) return '#ff6b3d';
  if (rssi <= -75) return '#ff9a4d';
  if (rssi <= -65) return '#ffcc4d';
  return '#b6ff4a';
}

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDeg(from, to) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function compassLabel(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function pathLossRssi(p0, n, distM) {
  const d = Math.max(distM, 1);
  return p0 - 10 * n * Math.log10(d);
}

function estimateBeacon() {
  if (trail.length < ESTIMATE_MIN_POINTS) {
    estimate = null;
    return;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  trail.forEach((p) => {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  });

  const padLat = Math.max((maxLat - minLat) * 0.35, 0.00025);
  const padLon = Math.max((maxLon - minLon) * 0.35, 0.00035);
  minLat -= padLat;
  maxLat += padLat;
  minLon -= padLon;
  maxLon += padLon;

  const steps = 28;
  let best = null;
  const p0Candidates = [-40, -45, -50];
  const nCandidates = [2.0, 2.5, 3.0, 3.5];

  for (const p0 of p0Candidates) {
    for (const n of nCandidates) {
      for (let i = 0; i <= steps; i += 1) {
        for (let j = 0; j <= steps; j += 1) {
          const lat = minLat + ((maxLat - minLat) * i) / steps;
          const lon = minLon + ((maxLon - minLon) * j) / steps;
          let err = 0;
          let wsum = 0;
          for (const p of trail) {
            const dist = haversineM({ lat, lon }, p);
            const pred = pathLossRssi(p0, n, dist);
            const w = p.weight || 1;
            err += w * (pred - p.rssi) ** 2;
            wsum += w;
          }
          const score = err / Math.max(wsum, 1);
          if (!best || score < best.score) {
            best = { lat, lon, p0, n, score };
          }
        }
      }
    }
  }

  if (!best) {
    estimate = null;
    return;
  }

  // Uncertainty: RMS residual mapped to meters (rough, visual only).
  const rms = Math.sqrt(best.score);
  const radiusM = Math.min(80, Math.max(8, rms * 4));
  estimate = { ...best, radiusM };
}

function gpsHint() {
  if (!latestGeo) {
    return huntActive
      ? 'Waiting for a GPS fix… keep the phone outdoors with location on.'
      : 'Allow location, then Start hunt. The blue dot is you.';
  }
  const acc = `GPS ±${latestGeo.accuracy.toFixed(0)} m`;
  if (latestGeo.accuracy > GPS_MAX_ACCURACY_M) {
    return `${acc} — waiting for a tighter fix before dropping crumbs.`;
  }
  if (!huntActive) return `${acc} — Start hunt to record the trail.`;
  if (trail.length === 0) return `${acc} — walk; crumbs drop as you move.`;
  return estimate
    ? `${acc} · ${trail.length} points · estimate ~±${estimate.radiusM.toFixed(0)} m`
    : `${acc} · ${trail.length} trail points · need ${ESTIMATE_MIN_POINTS} for estimate`;
}

function updateYouMarker() {
  if (!mapReady || !latestGeo || typeof L === 'undefined' || !youLayer) return;
  const latlng = [latestGeo.lat, latestGeo.lon];
  const radius = Math.max(latestGeo.accuracy, 4);
  if (!youMarker) {
    youAccuracy = L.circle(latlng, {
      radius,
      color: '#7ec8ff',
      weight: 1,
      fillColor: '#7ec8ff',
      fillOpacity: 0.14,
    }).addTo(youLayer);
    youMarker = L.circleMarker(latlng, {
      radius: 8,
      color: '#10110e',
      weight: 2,
      fillColor: '#7ec8ff',
      fillOpacity: 1,
    }).bindPopup('You').addTo(youLayer);
  } else {
    youAccuracy.setLatLng(latlng).setRadius(radius);
    youMarker.setLatLng(latlng);
  }
  if (!mapCentered) {
    map.setView(latlng, 17);
    mapCentered = true;
  } else if (trail.length === 0) {
    map.panTo(latlng, { animate: false });
  }
}

function redrawMap() {
  if (!mapReady) return;
  trailLayer.clearLayers();
  estimateLayer.clearLayers();
  truthLayer.clearLayers();
  updateYouMarker();
  els.mapHint.textContent = gpsHint();

  if (trail.length === 0) return;

  const latlngs = trail.map((p) => [p.lat, p.lon]);
  for (let i = 1; i < trail.length; i += 1) {
    L.polyline([latlngs[i - 1], latlngs[i]], {
      color: trailColor(trail[i].rssi),
      weight: 5,
      opacity: 0.9,
    }).addTo(trailLayer);
  }
  trail.forEach((p) => {
    L.circleMarker([p.lat, p.lon], {
      radius: 5,
      color: '#10110e',
      weight: 1,
      fillColor: trailColor(p.rssi),
      fillOpacity: 0.95,
    }).bindPopup(`#${p.counter}<br>${p.rssi} dBm<br>±${p.accuracy.toFixed(0)} m`)
      .addTo(trailLayer);
  });

  if (estimate) {
    L.circle([estimate.lat, estimate.lon], {
      radius: estimate.radiusM,
      color: '#7ec8ff',
      weight: 2,
      fillColor: '#7ec8ff',
      fillOpacity: 0.15,
    }).addTo(estimateLayer);
    L.circleMarker([estimate.lat, estimate.lon], {
      radius: 8,
      color: '#10110e',
      weight: 2,
      fillColor: '#7ec8ff',
      fillOpacity: 1,
    }).bindPopup(
      `Estimate<br>p0=${estimate.p0} n=${estimate.n}<br>~±${estimate.radiusM.toFixed(0)} m`,
    ).addTo(estimateLayer);
  }

  if (groundTruth) {
    L.circleMarker([groundTruth.lat, groundTruth.lon], {
      radius: 8,
      color: '#10110e',
      weight: 2,
      fillColor: '#ff6b3d',
      fillOpacity: 1,
    }).bindPopup('Found it (ground truth)').addTo(truthLayer);
  }

  const bounds = L.latLngBounds(latlngs);
  if (estimate) bounds.extend([estimate.lat, estimate.lon]);
  if (groundTruth) bounds.extend([groundTruth.lat, groundTruth.lon]);
  if (latestGeo) bounds.extend([latestGeo.lat, latestGeo.lon]);
  map.fitBounds(bounds.pad(0.25), { maxZoom: 18, animate: false });
  els.mapHint.textContent = gpsHint();
}

function updateFoxHud(trendDelta) {
  const last = samples.length ? samples[samples.length - 1] : null;
  if (els.trailCountValue) els.trailCountValue.textContent = String(trail.length);
  if (els.foxSeqValue) {
    els.foxSeqValue.textContent = last ? `#${last.counter}` : '—';
  }

  if (!last) {
    els.trendValue.textContent = '—';
    els.trendValue.className = 'trend';
    els.bandValue.textContent = 'band —';
    els.bearingValue.textContent = '—';
    els.estDistValue.textContent = '—';
    return;
  }

  els.bandValue.textContent = `band ${bandLabel(last.rssi)}`;

  const delta = trendDelta !== undefined ? trendDelta : lastTrendDelta;
  if (delta == null) {
    els.trendValue.textContent = 'Hunting…';
    els.trendValue.className = 'trend';
  } else {
    const signed = delta > 0 ? `+${delta}` : `${delta}`;
    if (delta >= 2) {
      els.trendValue.textContent = `Warmer · ${signed} dB`;
      els.trendValue.className = 'trend warmer';
    } else if (delta <= -2) {
      els.trendValue.textContent = `Colder · ${signed} dB`;
      els.trendValue.className = 'trend colder';
    } else {
      els.trendValue.textContent = `Same · ${signed} dB`;
      els.trendValue.className = 'trend same';
    }
  }

  if (estimate && latestGeo) {
    const here = { lat: latestGeo.lat, lon: latestGeo.lon };
    const brg = bearingDeg(here, estimate);
    const dist = haversineM(here, estimate);
    els.bearingValue.textContent = `${brg.toFixed(0)}° ${compassLabel(brg)}`;
    els.estDistValue.textContent = dist < 1000
      ? `${dist.toFixed(0)} m`
      : `${(dist / 1000).toFixed(2)} km`;
  } else {
    els.bearingValue.textContent = estimate ? 'need GPS' : '—';
    els.estDistValue.textContent = estimate ? '—' : '—';
  }
}

function vibrateWarmer() {
  try {
    if (navigator.vibrate) navigator.vibrate(40);
  } catch {
    // ignore
  }
}

function onGeo(position) {
  latestGeo = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: position.coords.accuracy || 999,
    t: Date.now(),
  };
  if (els.huntStatus) els.huntStatus.textContent = gpsHint();
  updateYouMarker();
  if (huntActive && lastFoxRssi != null) {
    maybeCommitTrail(lastFoxRssi, lastCounter);
  }
}

function geoError(err) {
  const denied = err && err.code === 1;
  if (!els.huntStatus) return;
  if (denied) {
    els.huntStatus.textContent = 'Location permission denied — enable it for this site.';
    return;
  }
  if (!latestGeo) {
    els.huntStatus.textContent = `Waiting for GPS… ${err?.message || ''}`.trim();
  }
}

function startGeoWatch() {
  if (!navigator.geolocation) {
    if (els.huntStatus) els.huntStatus.textContent = 'Geolocation unavailable in this browser';
    return;
  }
  if (watchId != null) return;
  if (els.huntStatus && !latestGeo) {
    els.huntStatus.textContent = 'Waiting for GPS fix…';
  }
  const opts = { enableHighAccuracy: true, maximumAge: 1000 };
  navigator.geolocation.getCurrentPosition(onGeo, geoError, opts);
  watchId = navigator.geolocation.watchPosition(onGeo, geoError, opts);
}

function stopGeoWatch() {
  if (watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
}

function maybeCommitTrail(rssi, counter) {
  if (!huntActive || appMode !== 'foxhunt' || !latestGeo) return;
  if (latestGeo.accuracy > GPS_MAX_ACCURACY_M) {
    if (els.huntStatus) els.huntStatus.textContent = gpsHint();
    return;
  }
  const now = Date.now();
  const last = trail.length ? trail[trail.length - 1] : null;
  const moved = last ? haversineM(last, latestGeo) : Infinity;
  const age = last ? now - last.t : Infinity;
  if (last && moved < 2) return;
  if (last && moved < TRAIL_MIN_MOVE_M && age < TRAIL_MIN_INTERVAL_MS) return;

  commitTrailPoint({
    t: now,
    lat: latestGeo.lat,
    lon: latestGeo.lon,
    accuracy: latestGeo.accuracy,
    rssi,
    counter,
    weight: 1 / (1 + latestGeo.accuracy / 10),
    variance: 0,
  });
}

function commitTrailPoint(point) {
  trail.push(point);
  estimateBeacon();
  updateFoxHud();
  redrawMap();
  if (els.huntStatus) els.huntStatus.textContent = gpsHint();
}

function considerTrailSample(sample) {
  maybeCommitTrail(sample.rssi, sample.counter);
}

function setHuntUi() {
  if (!els.huntBtn) return;
  els.huntBtn.textContent = huntActive ? 'Stop hunt' : 'Start hunt';
  els.foundBtn.disabled = !huntActive && trail.length === 0 && !latestGeo;
  if (!huntActive && trail.length === 0 && els.huntStatus) {
    els.huntStatus.textContent = gpsHint();
  }
}

function toggleHunt() {
  if (huntActive) {
    huntActive = false;
    els.huntStatus.textContent = `Hunt paused · ${trail.length} points saved`;
    setHuntUi();
    return;
  }
  if (!navigator.geolocation) {
    els.huntStatus.textContent = 'Geolocation unavailable in this browser';
    return;
  }
  huntActive = true;
  startGeoWatch();
  els.huntStatus.textContent = gpsHint();
  setHuntUi();
  ensureMap();
}

function markFound() {
  if (!latestGeo) {
    startGeoWatch();
    els.huntStatus.textContent = 'Waiting for GPS to mark ground truth…';
    const wait = setInterval(() => {
      if (!latestGeo) return;
      clearInterval(wait);
      groundTruth = { lat: latestGeo.lat, lon: latestGeo.lon, t: Date.now() };
      els.huntStatus.textContent = 'Ground truth marked';
      redrawMap();
    }, 500);
    setTimeout(() => clearInterval(wait), 15000);
    return;
  }
  groundTruth = { lat: latestGeo.lat, lon: latestGeo.lon, t: Date.now() };
  els.huntStatus.textContent = 'Ground truth marked';
  redrawMap();
}

function resizeCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = height || 160;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height: h };
}

function drawTimedChart(canvas, getY, color, yMin, yMax, height) {
  const { ctx, width, height: h } = resizeCanvas(canvas, height);
  ctx.clearRect(0, 0, width, h);
  ctx.fillStyle = '#14150f';
  ctx.fillRect(0, 0, width, h);

  const padL = 36;
  const padR = 8;
  const padT = 10;
  const padB = 18;
  const plotW = width - padL - padR;
  const plotH = h - padT - padB;
  const now = Date.now();
  const t0 = now - TRACE_WINDOW_MS;
  const span = yMax - yMin || 1;

  ctx.strokeStyle = '#2c2f24';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  ctx.fillStyle = '#8c8a78';
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.fillText(String(yMax), 4, padT + 8);
  ctx.fillText(String(yMin), 4, padT + plotH);

  const xOf = (t) => padL + (plotW * (t - t0)) / TRACE_WINDOW_MS;
  const yOf = (v) => padT + plotH * (1 - (v - yMin) / span);

  const paintBreaks = (gaps, fill, label) => {
    gaps.forEach((gap) => {
      const from = Math.max(gap.from, t0);
      const to = Math.min(gap.to ?? now, now);
      if (to <= from) return;
      const x1 = xOf(from);
      const x2 = xOf(to);
      ctx.fillStyle = fill;
      ctx.fillRect(x1, padT, Math.max(x2 - x1, 2), plotH);
      ctx.fillStyle = label;
      ctx.font = '11px ui-monospace, Consolas, monospace';
      ctx.fillText(gap.tag, x1 + 4, padT + 12);
    });
  };

  const openRf = rfGapFrom
    ? rfBreaks.concat([{ from: rfGapFrom, to: now, tag: 'RF gap' }])
    : rfBreaks;
  const openBle = disconnectedAt
    ? bleBreaks.concat([{ from: disconnectedAt, to: now, tag: 'BLE gap' }])
    : bleBreaks;
  paintBreaks(openRf, '#ffcc4d28', '#ffcc4d');
  paintBreaks(openBle, '#ff6b3d28', '#ff6b3d');

  const visible = traces.filter((p) => p.t >= t0);
  if (visible.length === 0) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  visible.forEach((p, i) => {
    const x = xOf(p.t);
    const y = yOf(getY(p));
    const prev = visible[i - 1];
    const broken = !prev || p.t - prev.t > TRACE_MS * 4;
    if (i === 0 || broken) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  markers.forEach((marker) => {
    const sample = samples[marker.index];
    if (!sample || sample.phoneMs < t0) return;
    const x = xOf(sample.phoneMs);
    ctx.strokeStyle = '#ffcc4d88';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffcc4d';
    ctx.fillText(marker.note, x + 4, padT + 12);
  });
}

function drawStrip(canvas) {
  const { ctx, width, height } = resizeCanvas(canvas, 40);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14150f';
  ctx.fillRect(0, 0, width, height);
  if (samples.length === 0) return;

  const maxTicks = Math.max(samples[samples.length - 1].counter - samples[0].counter + 1, 1);
  const received = new Set(samples.map((s) => s.counter));
  const first = samples[0].counter;
  const tickW = Math.max(2, (width - 8) / maxTicks);

  for (let i = 0; i < maxTicks; i += 1) {
    ctx.fillStyle = received.has(first + i) ? '#b6ff4a' : '#ff6b3d';
    ctx.fillRect(4 + i * tickW, 10, Math.max(tickW - 1, 1), 20);
  }
}

function redraw() {
  if (appMode === 'foxhunt') return;
  const rssiMin = RSSI_FLOOR;
  const rssiMax = -20;
  drawTimedChart(els.rssiChart, (p) => p.rssi, '#b6ff4a', rssiMin, rssiMax, 168);
  const lossMax = Math.max(10, ...traces.map((p) => p.loss), 0);
  drawTimedChart(els.lossChart, (p) => p.loss, '#ff6b3d', 0, lossMax, 168);
  drawStrip(els.stripChart);
}

function pruneTraces(now) {
  const cutoff = now - TRACE_WINDOW_MS;
  while (traces.length && traces[0].t < cutoff) traces.shift();
}

function pushTrace(rssi, loss, gap) {
  const now = Date.now();
  traces.push({ t: now, rssi, loss, gap });
  pruneTraces(now);
}

function setRssiBlank() {
  els.rssiValue.textContent = '—';
  els.rssiValue.className = 'rssi';
}

function closeRfGap() {
  if (!rfGapFrom) return;
  rfBreaks.push({ from: rfGapFrom, to: Date.now(), tag: 'RF gap' });
  rfGapFrom = 0;
}

function tickTrace() {
  if (!sessionLive) return;
  const now = Date.now();
  if (!device?.gatt?.connected) {
    if (traces.length || bleBreaks.length || rfBreaks.length || disconnectedAt) {
      pruneTraces(now);
      redraw();
    }
    return;
  }
  const last = samples.length ? samples[samples.length - 1] : null;
  if (!last || !lastPacketAt) {
    redraw();
    return;
  }
  if (now - lastPacketAt >= GAP_AFTER_MS) {
    if (!rfGapFrom) {
      rfGapFrom = lastPacketAt;
      setRssiBlank();
    }
    pruneTraces(now);
    redraw();
    return;
  }
  closeRfGap();
  pushTrace(last.rssi, lossPct(last), false);
  redraw();
}

function applySample(sample) {
  if (!sample.fw && samples.length > 0) {
    const prev = samples[samples.length - 1];
    const gap = sample.counter - prev.counter - 1;
    sample.drop = prev.drop + Math.max(gap, 0);
    sample.rx = prev.rx + 1;
  }

  const row = {
    ...sample,
    phoneMs: Date.now(),
    note: '',
    lat: latestGeo?.lat,
    lon: latestGeo?.lon,
    gpsAccuracy: latestGeo?.accuracy,
  };
  samples.push(row);
  lastPacketAt = row.phoneMs;
  closeRfGap();

  const prevFox = lastFoxRssi;
  els.rssiValue.textContent = String(sample.rssi);
  els.rssiValue.className = `rssi ${rssiClass(sample.rssi)}`;
  els.lossValue.textContent = `${lossPct(sample).toFixed(1)}%`;
  els.rxValue.textContent = String(sample.rx);
  els.dropValue.textContent = String(sample.drop);
  els.seqValue.textContent = `#${sample.counter}`;
  setStatus(sample.fw ? `Live · ${sample.fw}` : 'Live', 'live');
  els.staleWarn.classList.add('hidden');
  pushTrace(sample.rssi, lossPct(sample), false);

  if (appMode === 'foxhunt') {
    const trendDelta = prevFox == null ? null : sample.rssi - prevFox;
    if (trendDelta != null && trendDelta >= 2) vibrateWarmer();
    lastFoxRssi = sample.rssi;
    lastTrendDelta = trendDelta;
    updateFoxHud(trendDelta);
    if (!demoMode) considerTrailSample(sample);
  } else {
    lastFoxRssi = sample.rssi;
    redraw();
  }
}

function onValueChanged(event) {
  lastNotifyAt = Date.now();
  const value = new TextDecoder().decode(event.target.value);
  rxBuffer += value;
  const parts = rxBuffer.split('\n');
  rxBuffer = parts.pop() ?? '';
  for (const part of parts) {
    ingest(parseLine(part));
  }
  if (rxBuffer.startsWith('{') && rxBuffer.trim().endsWith('}')) {
    ingest(parseLine(rxBuffer));
    rxBuffer = '';
  }
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function setPauseUi() {
  if (!els.pauseBtn) return;
  const connected = !!device?.gatt?.connected;
  els.pauseBtn.disabled = !connected;
  els.pauseBtn.textContent = connected && !sessionLive ? 'Resume' : 'Pause';
}

async function startLive() {
  sessionLive = true;
  stopPolling();
  pollTimer = setInterval(pollCharacteristic, 1000);
  await pollCharacteristic();
  setPauseUi();
}

function stopLive() {
  sessionLive = false;
  stopPolling();
  setPauseUi();
}

async function togglePause() {
  if (!device?.gatt?.connected) return;
  if (sessionLive) {
    stopLive();
    setStatus('Paused', 'off');
    return;
  }
  await startLive();
  setStatus(`Live · ${device.name || 'RF-Link-B'}`, 'live');
}

function setBleDebug(text) {
  if (els.bleDebug) els.bleDebug.textContent = text;
}

async function pollCharacteristic() {
  if (!sessionLive || gattBusy || !txChar || !device?.gatt?.connected) return;
  gattBusy = true;
  try {
    const raw = new TextDecoder().decode(await txChar.readValue()).replace(/\0/g, '');
    setBleDebug(raw.trim().slice(0, 140) || '(empty read)');
    ingest(parseLine(raw));
  } catch (err) {
    setBleDebug(`read error: ${err.message || err}`);
  } finally {
    gattBusy = false;
  }
}

async function holdWakeLock() {
  try {
    if (navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    // Browser or OS can refuse wake lock; charts still work.
  }
}

function onGattDisconnected() {
  stopLive();
  disconnectedAt = Date.now();
  setRssiBlank();
  setStatus('Disconnected', 'off');
  els.connectBtn.disabled = false;
  els.connectBtn.textContent = 'Connect';
}

async function connect() {
  if (!navigator.bluetooth) {
    setStatus('Web Bluetooth unavailable', 'off');
    els.status.textContent = 'Need Chrome (Android) or Bluefy (iPhone)';
    return;
  }

  els.connectBtn.disabled = true;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'RF-Link-B' }, { namePrefix: 'RF-Link' }],
      optionalServices: [NUS_SERVICE],
    });
    device.removeEventListener('gattserverdisconnected', onGattDisconnected);
    device.addEventListener('gattserverdisconnected', onGattDisconnected);
    setStatus('Connecting…', 'off');
    if (disconnectedAt) {
      bleBreaks.push({ from: disconnectedAt, to: Date.now(), tag: 'BLE gap' });
      disconnectedAt = 0;
    }
    connectedAt = Date.now();
    rxBuffer = '';
    els.staleWarn.classList.add('hidden');
    server = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    // Keep a global reference. Chrome drops notifications if this is GC'd.
    txChar = await service.getCharacteristic(NUS_TX);
    // Notifications die after the first ESP-NOW ack on this chip. Read the
    // characteristic instead — firmware already setValue()s every packet.
    await startLive();
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = 'Disconnect';
    setStatus(`Linked · ${device.name || 'RF-Link-B'}`, 'live');
    await holdWakeLock();
  } catch (err) {
    stopLive();
    setStatus(err.message || 'Connect failed', 'off');
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = 'Connect';
  }
}

async function toggleConnection() {
  if (device?.gatt?.connected) {
    stopLive();
    if (els.pauseBtn) {
      els.pauseBtn.disabled = true;
      els.pauseBtn.textContent = 'Pause';
    }
    device.gatt.disconnect();
    return;
  }
  await connect();
}

function exportCsv() {
  if (samples.length === 0 && trail.length === 0) return;
  const header = 'phone_iso,counter,rssi_dbm,node_ms,rx,drop,loss_pct,lat,lon,gps_accuracy_m,note';
  const lines = samples.map((s) => [
    new Date(s.phoneMs).toISOString(),
    s.counter,
    s.rssi,
    s.nodeMs,
    s.rx,
    s.drop,
    lossPct(s).toFixed(2),
    s.lat ?? '',
    s.lon ?? '',
    s.gpsAccuracy ?? '',
    `"${(s.note || '').replaceAll('"', '""')}"`,
  ].join(','));
  const blob = new Blob([`${header}\n${lines.join('\n')}\n`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rf-link-range-${new Date().toISOString().replaceAll(':', '')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportGeoJson() {
  if (trail.length === 0 && !estimate && !groundTruth) return;
  const features = trail.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: {
      rssi: p.rssi,
      counter: p.counter,
      accuracy: p.accuracy,
      weight: p.weight,
      t: p.t,
    },
  }));
  if (estimate) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [estimate.lon, estimate.lat] },
      properties: {
        kind: 'estimate',
        radiusM: estimate.radiusM,
        p0: estimate.p0,
        n: estimate.n,
        score: estimate.score,
      },
    });
  }
  if (groundTruth) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [groundTruth.lon, groundTruth.lat] },
      properties: { kind: 'ground_truth', t: groundTruth.t },
    });
  }
  const fc = { type: 'FeatureCollection', features };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rf-link-foxhunt-${new Date().toISOString().replaceAll(':', '')}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearSession() {
  samples.length = 0;
  markers.length = 0;
  traces.length = 0;
  bleBreaks.length = 0;
  rfBreaks.length = 0;
  trail.length = 0;
  estimate = null;
  groundTruth = null;
  lastPacketAt = 0;
  lastCounter = null;
  lastFoxRssi = null;
  lastTrendDelta = null;
  disconnectedAt = 0;
  rfGapFrom = 0;
  mapCentered = false;
  if (youLayer) youLayer.clearLayers();
  youMarker = null;
  youAccuracy = null;
  setRssiBlank();
  els.lossValue.textContent = '—';
  els.rxValue.textContent = '0';
  els.dropValue.textContent = '0';
  els.seqValue.textContent = '—';
  updateFoxHud();
  redraw();
  redrawMap();
  setHuntUi();
}

els.connectBtn.addEventListener('click', toggleConnection);
els.pauseBtn.addEventListener('click', togglePause);
els.modeRange.addEventListener('click', () => setMode('range'));
els.modeFoxhunt.addEventListener('click', () => setMode('foxhunt'));
els.huntBtn.addEventListener('click', toggleHunt);
els.foundBtn.addEventListener('click', markFound);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && device?.gatt?.connected) {
    holdWakeLock();
  }
});
els.markBtn.addEventListener('click', () => {
  const note = els.noteInput.value.trim();
  if (!note || samples.length === 0) return;
  const index = samples.length - 1;
  samples[index].note = note;
  markers.push({ index, note });
  els.noteInput.value = '';
  redraw();
});
els.noteInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') els.markBtn.click();
});
els.exportBtn.addEventListener('click', exportCsv);
els.exportGeoBtn.addEventListener('click', exportGeoJson);
els.clearBtn.addEventListener('click', clearSession);

window.addEventListener('resize', () => {
  redraw();
  if (mapReady) {
    map.invalidateSize();
    redrawMap();
  }
});
setInterval(tickTrace, TRACE_MS);
setInterval(() => {
  if (device && !device.gatt?.connected) {
    setStatus('Disconnected', 'off');
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = 'Connect';
    connectedAt = 0;
  }
  if (!sessionLive || !device?.gatt?.connected) return;
  const reference = lastPacketAt || connectedAt;
  if (!reference) return;
  const stale = Date.now() - reference > STALE_MS;
  els.staleWarn.classList.toggle('hidden', !stale);
  if (stale) setStatus('Stale link', 'stale');
}, 1000);

setMode('range');
setHuntUi();
redraw();
if (els.webValue) els.webValue.textContent = `web ${WEB_VERSION}`;

if (new URLSearchParams(location.search).has('demo')) {
  demoMode = true;
  let counter = 0;
  let rx = 0;
  let drop = 0;
  // Fake a Vancouver-ish walk spiraling toward a beacon.
  const beacon = { lat: 49.2827, lon: -123.1207 };
  let angle = 0;
  setStatus('Demo data', 'live');
  setMode('foxhunt');
  huntActive = true;
  setHuntUi();
  els.huntStatus.textContent = 'Demo hunt — synthetic GPS trail';
  ensureMap();
  setInterval(() => {
    const missed = Math.random() < 0.12;
    if (missed) drop += 1;
    else rx += 1;
    counter += 1;
    angle += 0.35;
    const radius = Math.max(0.00015, 0.0012 - counter * 0.000015);
    const lat = beacon.lat + Math.cos(angle) * radius;
    const lon = beacon.lon + Math.sin(angle) * radius;
    const dist = haversineM(beacon, { lat, lon });
    const rssi = Math.round(-40 - 10 * 2.7 * Math.log10(Math.max(dist, 1)) + (Math.random() * 4 - 2));
    latestGeo = { lat, lon, accuracy: 6 + Math.random() * 4, t: Date.now() };
    applySample({
      counter,
      rssi,
      nodeMs: counter * 1000,
      rx,
      drop,
      fw: 'demo',
    });
    // Force trail crumbs faster in demo (bypass long dwell).
    if (counter % 2 === 0) {
      commitTrailPoint({
        t: Date.now(),
        lat,
        lon,
        accuracy: latestGeo.accuracy,
        rssi,
        counter,
        weight: 1,
        variance: 1,
      });
    }
  }, 400);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js');
}
