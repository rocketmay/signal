const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const STALE_MS = 12000;
// Bump this and docs/sw.js CACHE together on every website upload.
const WEB_VERSION = 5;

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
};

const samples = [];
const markers = [];
let device = null;
let server = null;
let txChar = null;
let rxBuffer = '';
let lastPacketAt = 0;
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
  const text = line.trim();
  if (!text || text === 'waiting for packets') return null;

  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (obj.hello && obj.fw) {
        return { hello: true, fw: obj.fw };
      }
      if (typeof obj.rssi !== 'number' || typeof obj.c !== 'number') return null;
      return {
        counter: obj.c,
        rssi: obj.rssi,
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

function drawLineChart(canvas, values, color, yMin, yMax, height) {
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

  if (values.length === 0) return;

  const span = Math.max(values.length - 1, 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, i) => {
    const x = padL + (plotW * i) / span;
    const y = padT + plotH * (1 - (value - yMin) / (yMax - yMin));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  markers.forEach((marker) => {
    const x = padL + (plotW * marker.index) / span;
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
  const rssiValues = samples.map((s) => s.rssi);
  const lossValues = samples.map((s) => lossPct(s));
  const rssiMin = Math.min(-100, ...rssiValues);
  const rssiMax = Math.max(-20, ...rssiValues);
  drawLineChart(els.rssiChart, rssiValues, '#b6ff4a', rssiMin, rssiMax, 168);
  drawLineChart(els.lossChart, lossValues, '#ff6b3d', 0, Math.max(10, ...lossValues, 0), 168);
  drawStrip(els.stripChart);
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

  els.rssiValue.textContent = String(sample.rssi);
  els.rssiValue.className = `rssi ${rssiClass(sample.rssi)}`;
  els.lossValue.textContent = `${lossPct(sample).toFixed(1)}%`;
  els.rxValue.textContent = String(sample.rx);
  els.dropValue.textContent = String(sample.drop);
  els.seqValue.textContent = `#${sample.counter}`;
  setStatus(sample.fw ? `Live · ${sample.fw}` : 'Live', 'live');
  els.staleWarn.classList.add('hidden');
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

async function pollCharacteristic() {
  if (gattBusy || !txChar || !device?.gatt?.connected) return;
  if (lastNotifyAt && Date.now() - lastNotifyAt < 2500) return;
  gattBusy = true;
  try {
    const raw = new TextDecoder().decode(await txChar.readValue());
    ingest(parseLine(raw));
  } catch {
    // GATT busy or disconnected; the next tick retries.
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
    device.addEventListener('gattserverdisconnected', () => {
      stopPolling();
      setStatus('Disconnected', 'off');
      els.connectBtn.disabled = false;
      els.connectBtn.textContent = 'Connect';
    });
    setStatus('Connecting…', 'off');
    lastPacketAt = 0;
    lastCounter = null;
    lastNotifyAt = 0;
    rxBuffer = '';
    els.staleWarn.classList.add('hidden');
    server = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    // Keep a global reference. Chrome drops notifications if this is GC'd.
    txChar = await service.getCharacteristic(NUS_TX);
    await txChar.startNotifications();
    txChar.addEventListener('characteristicvaluechanged', onValueChanged);
    try {
      ingest(parseLine(new TextDecoder().decode(await txChar.readValue())));
    } catch {
      // Read is optional; polling still picks up firmware and packets.
    }
    stopPolling();
    pollTimer = setInterval(pollCharacteristic, 1000);
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
  els.rssiValue.textContent = '—';
  els.rssiValue.className = 'rssi';
  els.lossValue.textContent = '—';
  els.rxValue.textContent = '0';
  els.dropValue.textContent = '0';
  els.seqValue.textContent = '—';
  redraw();
});

window.addEventListener('resize', redraw);
setInterval(() => {
  if (device && !device.gatt?.connected) {
    setStatus('Disconnected', 'off');
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = 'Connect';
  }
  if (!lastPacketAt) return;
  const stale = Date.now() - lastPacketAt > STALE_MS;
  els.staleWarn.classList.toggle('hidden', !stale);
  if (stale && device?.gatt?.connected) setStatus('Stale link', 'stale');
}, 1000);

redraw();
els.webValue.textContent = `web ${WEB_VERSION}`;

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
