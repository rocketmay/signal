const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const STALE_MS = 12000;
const RSSI_FLOOR = -100;
const GAP_AFTER_MS = 6000;
const TRACE_MS = 250;
const TRACE_WINDOW_MS = 90000;
// Bump this and docs/sw.js CACHE together on every website upload.
const WEB_VERSION = 10;

const els = {
  status: document.getElementById('status'),
  connectBtn: document.getElementById('connectBtn'),
  rssiValue: document.getElementById('rssiValue'),
  lossValue: document.getElementById('lossValue'),
  rxValue: document.getElementById('rxValue'),
  dropValue: document.getElementById('dropValue'),
  seqValue: document.getElementById('seqValue'),
  staleWarn: document.getElementById('staleWarn'),
  noteInput: document.getElementById('noteInput'),
  markBtn: document.getElementById('markBtn'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
  rssiChart: document.getElementById('rssiChart'),
  lossChart: document.getElementById('lossChart'),
  stripChart: document.getElementById('stripChart'),
  brandMark: document.querySelector('.brand-mark'),
  fwValue: document.getElementById('fwValue'),
  webValue: document.getElementById('webValue'),
  bleDebug: document.getElementById('bleDebug'),
};

const samples = [];
const markers = [];
const traces = [];
const bleBreaks = [];
const rfBreaks = [];
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
let wakeLock = null;

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
  if (rssi <= -80) return 'bad';
  if (rssi <= -65) return 'mid';
  return '';
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.brandMark.className = `brand-mark ${kind}`;
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
  };
  samples.push(row);
  lastPacketAt = row.phoneMs;
  closeRfGap();

  els.rssiValue.textContent = String(sample.rssi);
  els.rssiValue.className = `rssi ${rssiClass(sample.rssi)}`;
  els.lossValue.textContent = `${lossPct(sample).toFixed(1)}%`;
  els.rxValue.textContent = String(sample.rx);
  els.dropValue.textContent = String(sample.drop);
  els.seqValue.textContent = `#${sample.counter}`;
  setStatus(sample.fw ? `Live · ${sample.fw}` : 'Live', 'live');
  els.staleWarn.classList.add('hidden');
  pushTrace(sample.rssi, lossPct(sample), false);
  redraw();
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

function setBleDebug(text) {
  if (els.bleDebug) els.bleDebug.textContent = text;
}

async function pollCharacteristic() {
  if (gattBusy || !txChar || !device?.gatt?.connected) return;
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
  stopPolling();
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
    stopPolling();
    pollTimer = setInterval(pollCharacteristic, 1000);
    await pollCharacteristic();
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = 'Disconnect';
    setStatus(`Linked · ${device.name || 'RF-Link-B'}`, 'live');
    await holdWakeLock();
  } catch (err) {
    setStatus(err.message || 'Connect failed', 'off');
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = 'Connect';
  }
}

async function toggleConnection() {
  if (device?.gatt?.connected) {
    stopPolling();
    device.gatt.disconnect();
    return;
  }
  await connect();
}

function exportCsv() {
  if (samples.length === 0) return;
  const header = 'phone_iso,counter,rssi_dbm,node_ms,rx,drop,loss_pct,note';
  const lines = samples.map((s) => [
    new Date(s.phoneMs).toISOString(),
    s.counter,
    s.rssi,
    s.nodeMs,
    s.rx,
    s.drop,
    lossPct(s).toFixed(2),
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

els.connectBtn.addEventListener('click', toggleConnection);
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
els.clearBtn.addEventListener('click', () => {
  samples.length = 0;
  markers.length = 0;
  traces.length = 0;
  bleBreaks.length = 0;
  rfBreaks.length = 0;
  lastPacketAt = 0;
  lastCounter = null;
  disconnectedAt = 0;
  rfGapFrom = 0;
  setRssiBlank();
  els.lossValue.textContent = '—';
  els.rxValue.textContent = '0';
  els.dropValue.textContent = '0';
  els.seqValue.textContent = '—';
  redraw();
});

window.addEventListener('resize', redraw);
setInterval(tickTrace, TRACE_MS);
setInterval(() => {
  if (device && !device.gatt?.connected) {
    setStatus('Disconnected', 'off');
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = 'Connect';
    connectedAt = 0;
  }
  if (!device?.gatt?.connected) return;
  const reference = lastPacketAt || connectedAt;
  if (!reference) return;
  const stale = Date.now() - reference > STALE_MS;
  els.staleWarn.classList.toggle('hidden', !stale);
  if (stale) setStatus('Stale link', 'stale');
}, 1000);

redraw();
if (els.webValue) els.webValue.textContent = `web ${WEB_VERSION}`;

if (new URLSearchParams(location.search).has('demo')) {
  let counter = 0;
  let rx = 0;
  let drop = 0;
  setStatus('Demo data', 'live');
  setInterval(() => {
    const missed = Math.random() < 0.12;
    if (missed) drop += 1;
    else rx += 1;
    counter += 1;
    applySample({
      counter,
      rssi: Math.round(-42 - counter * 0.8 - Math.random() * 6),
      nodeMs: counter * 5000,
      rx,
      drop,
      fw: 'demo',
    });
  }, 400);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js');
}
