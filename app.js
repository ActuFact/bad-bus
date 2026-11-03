/* Bad Bus Dashcam — records phone video with a burned-in overlay of time, GPS
 * position, speed and bus details, takes stamped photos (plate, driver ID…),
 * logs incidents and builds a complaint report. Runs entirely in the browser. */
'use strict';

// ---------------------------------------------------------------- constants
const TZ = 'Asia/Jerusalem';
const MS_TO_KMH = 3.6;
const OVERSPEED_MARGIN_KMH = 5;     // tolerance before auto-flagging over the limit
const OVERSPEED_MIN_SECONDS = 5;    // must be over the limit this long to auto-log
const SPEED_HISTORY_SECONDS = 120;
const LIMIT_LOOKUP_INTERVAL_MS = 20000;
const LIMIT_LOOKUP_MIN_MOVE_M = 150;
const BANNER_MS = 6000;

const INCIDENTS = [
  { id: 'speeding',     en: 'Speeding',                he: 'מהירות מופרזת' },
  { id: 'red_light',    en: 'Red light',               he: 'מעבר באור אדום' },
  { id: 'phone',        en: 'Phone while driving',     he: 'שימוש בטלפון בזמן נהיגה' },
  { id: 'lane',         en: 'Dangerous overtake/lane', he: 'עקיפה או החלפת נתיב מסוכנת' },
  { id: 'braking',      en: 'Harsh brake/accel',       he: 'בלימה או האצה חדה' },
  { id: 'skipped_stop', en: 'Skipped stop',            he: 'לא עצר בתחנה' },
  { id: 'doors',        en: 'Doors open moving',       he: 'נסיעה עם דלתות פתוחות' },
  { id: 'behaviour',    en: 'Rude / unsafe conduct',   he: 'התנהגות לא נאותה' },
  { id: 'other',        en: 'Other',                   he: 'אחר' },
];
const AUTO_OVERSPEED = { id: 'over_limit', en: 'Over speed limit (auto)', he: 'חריגה ממהירות מותרת (אוטומטי)' };

const PHOTO_TYPES = {
  plate:      { en: 'Number plate',          he: 'לוחית רישוי' },
  bus_number: { en: 'Bus fleet no. / sign',  he: 'מספר אוטובוס / שילוט קו' },
  driver_id:  { en: 'Driver ID card',        he: 'תעודת נהג' },
  driver:     { en: 'Driver',                he: 'נהג' },
  scene:      { en: 'Scene / traffic light', he: 'זירה / רמזור' },
  other:      { en: 'Other',                 he: 'אחר' },
};

// ---------------------------------------------------------------- state
const $ = (sel) => document.querySelector(sel);
const video = $('#video');
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

const state = {
  videoStream: null,
  audioStream: null,
  facingMode: 'environment',
  running: false,

  // GPS
  watchId: null,
  track: [],            // every fix: {t, lat, lon, acc, speedKmh, heading, alt, src}
  fix: null,            // latest fix
  speedKmh: null,
  maxSpeed: null,       // {kmh, fix}
  speedHistory: [],     // [{t, kmh}]
  gpsError: null,

  // speed limit
  limit: null,          // {kmh, name, at: {lat, lon}, t}
  limitPending: false,
  overspeed: null,      // {start, maxKmh, fix}

  // recording
  recorder: null,
  recChunks: [],
  recStart: null,
  recMime: '',
  currentRecording: null,

  // evidence & incidents
  incidents: [],        // {type, t, fix, speedKmh, limitKmh, recording, offsetMs, auto, detail}
  evidence: [],         // {id, kind, name, blob, url, t, label, info}
  recordings: [],       // {name, start, end, mime}
  banner: null,         // {text, until}
  wakeLock: null,

  details: loadDetails(),
};

function loadDetails() {
  const defaults = { line: '', operator: '', plate: '', fleet: '', direction: '', driver: '',
    boarded: '', notes: '', speedlimit: true, audio: true, quality: '1080' };
  try {
    const saved = JSON.parse(localStorage.getItem('badbus.details') || '{}');
    return { ...defaults, ...saved };
  } catch { return defaults; }
}
function saveDetails() {
  try { localStorage.setItem('badbus.details', JSON.stringify(state.details)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- formatting
const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short',
});
function parts(t) {
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(t))) p[type] = value;
  if (p.hour === '24') p.hour = '00';
  return p;
}
function fmtDateTime(t) { const p = parts(t); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`; }
function fmtTime(t) { const p = parts(t); return `${p.hour}:${p.minute}:${p.second}`; }
function fmtDate(t) { const p = parts(t); return `${p.day}/${p.month}/${p.year}`; }
function fileStamp(t) { const p = parts(t); return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`; }
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtCoord(fix) {
  if (!fix) return 'no GPS fix';
  const lat = `${Math.abs(fix.lat).toFixed(6)}°${fix.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(fix.lon).toFixed(6)}°${fix.lon >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}
function compass(deg) {
  if (deg == null || Number.isNaN(deg)) return '';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}
function mapsLink(fix) { return fix ? `https://maps.google.com/?q=${fix.lat.toFixed(6)},${fix.lon.toFixed(6)}` : ''; }
function round(n) { return n == null ? '—' : Math.round(n); }

function setStatus(msg, cls = '') {
  const el = $('#status');
  el.textContent = msg;
  el.className = 'small ' + cls;
}

// ---------------------------------------------------------------- geo helpers
function haversine(a, b) {
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const toRad = (d) => d * Math.PI / 180, toDeg = (r) => r * 180 / Math.PI;
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
            Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ---------------------------------------------------------------- GPS
function startGps() {
  if (!('geolocation' in navigator)) { state.gpsError = 'Geolocation not supported'; return; }
  state.watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
    state.gpsError = err.code === 1 ? 'Location permission denied' : `GPS: ${err.message}`;
    setStatus(state.gpsError, 'err');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

function onPosition(pos) {
  const c = pos.coords;
  const fix = {
    t: pos.timestamp || Date.now(),
    lat: c.latitude, lon: c.longitude, acc: c.accuracy,
    alt: c.altitude, heading: c.heading, speedKmh: null, src: 'gps',
  };
  const prev = state.fix;

  // Prefer the GPS chip's Doppler speed; otherwise derive it from consecutive fixes.
  if (c.speed != null && !Number.isNaN(c.speed)) {
    fix.speedKmh = c.speed * MS_TO_KMH;
  } else if (prev) {
    const dt = (fix.t - prev.t) / 1000;
    const d = haversine(prev, fix);
    if (dt >= 0.5 && d > Math.max(fix.acc, prev.acc) * 0.5) {
      fix.speedKmh = (d / dt) * MS_TO_KMH;
      fix.src = 'calc';
    } else if (dt >= 0.5) {
      fix.speedKmh = 0;
      fix.src = 'calc';
    }
  }
  if ((fix.heading == null || Number.isNaN(fix.heading)) && prev && haversine(prev, fix) > 5) {
    fix.heading = bearing(prev, fix);
  }

  state.gpsError = null;
  state.fix = fix;
  state.track.push(fix);
  if (fix.speedKmh != null) {
    state.speedKmh = fix.speedKmh;
    state.speedHistory.push({ t: fix.t, kmh: fix.speedKmh });
    const cutoff = fix.t - SPEED_HISTORY_SECONDS * 1000;
    while (state.speedHistory.length && state.speedHistory[0].t < cutoff) state.speedHistory.shift();
    // Ignore poor-accuracy fixes for the "max speed" record so it stays credible.
    if (fix.acc <= 30 && (!state.maxSpeed || fix.speedKmh > state.maxSpeed.kmh)) {
      state.maxSpeed = { kmh: fix.speedKmh, fix };
    }
  }
  checkOverspeed(fix);
  maybeLookupLimit(fix);
  if (!state.recorder) setStatus(`GPS ±${Math.round(fix.acc)} m — ready`);
}

// ---------------------------------------------------------------- speed limit (OpenStreetMap)
function maybeLookupLimit(fix) {
  if (!state.details.speedlimit || state.limitPending || !navigator.onLine) return;
  const l = state.limit;
  if (l && Date.now() - l.t < LIMIT_LOOKUP_INTERVAL_MS && haversine(l.at, fix) < LIMIT_LOOKUP_MIN_MOVE_M) return;
  if (l && haversine(l.at, fix) < 30 && Date.now() - l.t < 120000) return;
  lookupLimit(fix);
}

async function lookupLimit(fix) {
  state.limitPending = true;
  const radius = Math.min(40, Math.max(15, fix.acc || 20));
  const q = `[out:json][timeout:8];way(around:${radius},${fix.lat},${fix.lon})[highway][maxspeed];out tags center 5;`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    let best = null;
    for (const el of data.elements || []) {
      const kmh = parseMaxspeed(el.tags.maxspeed);
      if (kmh == null) continue;
      const d = el.center ? haversine(fix, { lat: el.center.lat, lon: el.center.lon }) : 1e9;
      if (!best || d < best.d) best = { kmh, d, name: el.tags['name:en'] || el.tags.name || el.tags.ref || '' };
    }
    state.limit = best ? { kmh: best.kmh, name: best.name, at: { lat: fix.lat, lon: fix.lon }, t: Date.now() }
                       : { kmh: null, name: '', at: { lat: fix.lat, lon: fix.lon }, t: Date.now() };
  } catch {
    // Offline or Overpass busy — keep the last value, try again later.
    if (state.limit) state.limit.t = Date.now();
  } finally {
    state.limitPending = false;
  }
}

function parseMaxspeed(v) {
  if (!v) return null;
  const m = String(v).match(/(\d+(?:\.\d+)?)\s*(mph)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] ? n * 1.609 : n;
}

function currentLimit() {
  return state.limit && state.limit.kmh != null ? state.limit.kmh : null;
}

function checkOverspeed(fix) {
  const limit = currentLimit();
  const over = limit != null && fix.speedKmh != null && fix.acc <= 30 &&
               fix.speedKmh > limit + OVERSPEED_MARGIN_KMH;
  if (over) {
    if (!state.overspeed) state.overspeed = { start: fix.t, maxKmh: fix.speedKmh, fix, limit, logged: false };
    const o = state.overspeed;
    if (fix.speedKmh > o.maxKmh) { o.maxKmh = fix.speedKmh; o.fix = fix; }
    if (!o.logged && fix.t - o.start >= OVERSPEED_MIN_SECONDS * 1000) {
      o.logged = true;
      o.incident = addIncident(AUTO_OVERSPEED, { auto: true, at: o.start });
    }
    if (o.incident) {
      o.incident.speedKmh = o.maxKmh;
      o.incident.fix = o.fix;
      o.incident.detail = `${Math.round(o.maxKmh)} km/h in a ${Math.round(o.limit)} zone for ${Math.round((fix.t - o.start) / 1000)} s`;
    }
  } else {
    state.overspeed = null;
  }
}

// ---------------------------------------------------------------- camera
async function startCamera() {
  stopVideoStream();
  const tall = state.details.quality === '1080';
  state.videoStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: state.facingMode },
      width: { ideal: tall ? 1920 : 1280 }, height: { ideal: tall ? 1080 : 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  video.srcObject = state.videoStream;
  await video.play().catch(() => {});
}

async function startAudio() {
  if (!state.details.audio || state.audioStream) return;
  try {
    state.audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch {
    setStatus('Microphone not available — recording without audio', 'warn');
  }
}

function stopVideoStream() {
  if (state.videoStream) state.videoStream.getTracks().forEach((t) => t.stop());
  state.videoStream = null;
}

// ---------------------------------------------------------------- overlay drawing
function render() {
  if (!state.running) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (vw && vh) {
    if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }
    ctx.drawImage(video, 0, 0, vw, vh);
    drawHud(ctx, vw, vh, Date.now());
  }
  requestAnimationFrame(render);
}

function busLine() {
  const d = state.details;
  const bits = [];
  if (d.line) bits.push(`LINE ${d.line}`);
  if (d.operator) bits.push(d.operator);
  if (d.plate) bits.push(`PLATE ${d.plate}`);
  if (d.fleet) bits.push(`BUS #${d.fleet}`);
  return bits.join('  ·  ');
}

function drawHud(g, w, h, now, opts = {}) {
  const s = Math.min(w, h) / 720;           // scale: 1.0 at 720p
  const pad = Math.round(14 * s);
  const font = (px, weight = 600) => `${weight} ${Math.round(px * s)}px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace`;
  g.save();
  g.textBaseline = 'top';
  g.lineJoin = 'round';

  const text = (str, x, y, size, color = '#fff', weight = 600, align = 'left') => {
    g.font = font(size, weight);
    g.textAlign = align;
    g.lineWidth = Math.max(2, 4 * s);
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(str, x, y);
    g.fillStyle = color;
    g.fillText(str, x, y);
    return g.measureText(str).width;
  };

  // --- top band: date/time, recording state, bus details
  const topH = Math.round(76 * s);
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, 0, w, topH);
  text(fmtDateTime(now), pad, pad, 26);
  const bus = busLine();
  if (bus) text(bus, pad, pad + 32 * s, 20, '#ffcc00');

  if (opts.photoLabel) {
    text(`PHOTO: ${opts.photoLabel.toUpperCase()}`, w - pad, pad, 24, '#ffcc00', 700, 'right');
  } else if (state.recorder) {
    const blink = Math.floor(now / 500) % 2 === 0;
    const t = `REC ${fmtDuration(now - state.recStart)}`;
    const tw = text(t, w - pad, pad, 26, '#fff', 700, 'right');
    if (blink) {
      g.fillStyle = '#ff3b30';
      g.beginPath();
      g.arc(w - pad - tw - 16 * s, pad + 13 * s, 9 * s, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    text('LIVE', w - pad, pad, 22, '#a3a6ad', 700, 'right');
  }
  if (state.details.direction && !opts.photoLabel) {
    text(`→ ${state.details.direction}`, w - pad, pad + 32 * s, 18, '#fff', 500, 'right');
  }

  // --- bottom band: speed, position, speed graph
  const botH = Math.round(150 * s);
  const by = h - botH;
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(0, by, w, botH);

  const fix = state.fix;
  const stale = !fix || now - fix.t > 5000;
  const limit = currentLimit();
  const speed = state.speedKmh;
  let speedColor = '#fff';
  if (stale || speed == null) speedColor = '#ffcc00';
  else if (limit != null && speed > limit + OVERSPEED_MARGIN_KMH) speedColor = '#ff3b30';

  const speedStr = speed == null ? '--' : String(Math.round(speed));
  const sw = text(speedStr, pad, by + pad - 4 * s, 72, speedColor, 800);
  text('km/h', pad + sw + 8 * s, by + pad + 36 * s, 22, speedColor, 700);

  const limitStr = limit != null ? `LIMIT ${Math.round(limit)}` : (state.details.speedlimit ? 'LIMIT ?' : '');
  const maxStr = state.maxSpeed ? `MAX ${Math.round(state.maxSpeed.kmh)}` : 'MAX --';
  text(`${maxStr}   ${limitStr}`, pad, by + pad + 80 * s, 20, '#fff', 600);
  if (state.limit && state.limit.name && limit != null) {
    text(truncate(state.limit.name, 22), pad, by + pad + 106 * s, 16, '#a3a6ad', 500);
  }

  // position block
  const px = Math.round(w * (w > h ? 0.30 : 0.42));
  const lineGap = 28 * s;
  if (fix) {
    text(fmtCoord(fix), px, by + pad, 22);
    const head = fix.heading != null && !Number.isNaN(fix.heading) ? `HDG ${Math.round(fix.heading)}° ${compass(fix.heading)}` : 'HDG --';
    const alt = fix.alt != null ? `ALT ${Math.round(fix.alt)} m` : '';
    text(`±${Math.round(fix.acc)} m   ${head}   ${alt}`, px, by + pad + lineGap, 18, '#ddd', 500);
    const age = Math.round((now - fix.t) / 1000);
    text(stale ? `GPS FIX ${age}s OLD` : `GPS ${fmtTime(fix.t)}  (${fix.src === 'gps' ? 'doppler' : 'computed'})`,
      px, by + pad + lineGap * 2, 16, stale ? '#ffcc00' : '#a3a6ad', 500);
  } else {
    text(state.gpsError || 'WAITING FOR GPS…', px, by + pad, 22, '#ffcc00');
  }

  // speed graph (landscape / wide enough only)
  if (w > h) drawSpeedGraph(g, w - pad - 260 * s, by + pad, 260 * s, botH - pad * 2, s, now, limit);

  // --- incident banner
  if (state.banner && now < state.banner.until && !opts.photoLabel) {
    const msg = state.banner.text;
    g.font = font(30, 800);
    const bw = g.measureText(msg).width + 40 * s;
    const bx = (w - bw) / 2, bty = topH + 16 * s;
    g.fillStyle = 'rgba(255,59,48,0.9)';
    roundRect(g, bx, bty, bw, 48 * s, 10 * s);
    g.fill();
    g.textAlign = 'center';
    g.fillStyle = '#fff';
    g.fillText(msg, w / 2, bty + 9 * s);
  }
  g.restore();
}

function drawSpeedGraph(g, x, y, w, h, s, now, limit) {
  const hist = state.speedHistory;
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 1;
  g.strokeRect(x, y, w, h);
  const maxV = Math.max(60, limit || 0, ...hist.map((p) => p.kmh)) * 1.1;
  const xs = (t) => x + w - ((now - t) / (SPEED_HISTORY_SECONDS * 1000)) * w;
  const ys = (v) => y + h - (v / maxV) * h;
  if (limit != null) {
    g.strokeStyle = 'rgba(255,59,48,0.8)';
    g.setLineDash([6 * s, 4 * s]);
    g.beginPath(); g.moveTo(x, ys(limit)); g.lineTo(x + w, ys(limit)); g.stroke();
    g.setLineDash([]);
  }
  if (hist.length > 1) {
    g.strokeStyle = '#ffcc00';
    g.lineWidth = 2.5 * s;
    g.beginPath();
    hist.forEach((p, i) => { const X = Math.max(x, xs(p.t)); i ? g.lineTo(X, ys(p.kmh)) : g.moveTo(X, ys(p.kmh)); });
    g.stroke();
  }
  g.font = `500 ${Math.round(13 * s)}px ui-monospace, monospace`;
  g.fillStyle = '#a3a6ad';
  g.textAlign = 'left';
  g.fillText(`SPEED ${SPEED_HISTORY_SECONDS / 60} MIN`, x + 4 * s, y + 4 * s);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------------------------------------------------------------- recording
function pickMime() {
  const types = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  if (!window.MediaRecorder) return null;
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  const mime = pickMime();
  if (mime === null) { setStatus('This browser cannot record video (no MediaRecorder).', 'err'); return; }
  await startAudio();
  const out = canvas.captureStream(30);
  if (state.audioStream) state.audioStream.getAudioTracks().forEach((t) => out.addTrack(t));
  const bps = state.details.quality === '1080' ? 6_000_000 : 3_000_000;
  let rec;
  try {
    rec = new MediaRecorder(out, mime ? { mimeType: mime, videoBitsPerSecond: bps } : { videoBitsPerSecond: bps });
  } catch {
    rec = new MediaRecorder(out);
  }
  state.recChunks = [];
  state.recMime = rec.mimeType || mime || 'video/webm';
  state.recStart = Date.now();
  const ext = state.recMime.includes('mp4') ? 'mp4' : 'webm';
  state.currentRecording = { name: `bad-bus_${fileStamp(state.recStart)}.${ext}`, start: state.recStart, end: null, mime: state.recMime };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) state.recChunks.push(e.data); };
  rec.onstop = finishRecording;
  rec.start(1000);
  state.recorder = rec;
  $('#btn-record').classList.add('on');
  setStatus('Recording — keep this screen open', 'warn');
  requestWakeLock();
}

function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

function finishRecording() {
  const r = state.currentRecording;
  r.end = Date.now();
  const blob = new Blob(state.recChunks, { type: state.recMime.split(';')[0] });
  state.recordings.push(r);
  addEvidence({ kind: 'video', name: r.name, blob, t: r.start,
    label: 'Video', info: `${fmtTime(r.start)}–${fmtTime(r.end)} · ${fmtDuration(r.end - r.start)} · ${mb(blob.size)}` });
  state.recorder = null;
  state.recChunks = [];
  state.currentRecording = null;
  $('#btn-record').classList.remove('on');
  setStatus(`Saved to Evidence: ${r.name} — remember to share/save it`, 'warn');
}

function mb(bytes) { return `${(bytes / 1048576).toFixed(1)} MB`; }

// ---------------------------------------------------------------- incidents
function addIncident(type, extra = {}) {
  const t = extra.at || Date.now();
  const rec = state.currentRecording;
  const inc = {
    type, t, fix: state.fix, speedKmh: state.speedKmh, limitKmh: currentLimit(),
    recording: rec ? rec.name : null, offsetMs: rec ? t - rec.start : null,
    auto: !!extra.auto, detail: extra.detail || '',
  };
  state.incidents.push(inc);
  state.banner = { text: `! ${type.en.toUpperCase()}  ${fmtTime(t)}`, until: Date.now() + BANNER_MS };
  if (navigator.vibrate) navigator.vibrate(80);
  if (!rec && !extra.auto) setStatus(`Logged "${type.en}" — tip: start recording so the video shows it`, 'warn');
  updateEvidenceCount();
  return inc;
}

function buildIncidentButtons() {
  const wrap = $('#incident-buttons');
  for (const type of INCIDENTS) {
    const b = document.createElement('button');
    b.className = 'incident';
    b.type = 'button';
    b.textContent = type.en;
    b.addEventListener('click', () => {
      addIncident(type);
      b.classList.add('hit');
      setTimeout(() => b.classList.remove('hit'), 400);
    });
    wrap.appendChild(b);
  }
}

// ---------------------------------------------------------------- photos
async function takePhoto(kind) {
  const meta = PHOTO_TYPES[kind] || PHOTO_TYPES.other;
  const now = Date.now();
  let source = video, sw = video.videoWidth, sh = video.videoHeight;

  // On Android Chrome, ImageCapture can grab a full-resolution still (much sharper plates).
  if ($('#photo-fullres').checked && 'ImageCapture' in window && state.videoStream) {
    try {
      const track = state.videoStream.getVideoTracks()[0];
      const blob = await new ImageCapture(track).takePhoto();
      const bmp = await createImageBitmap(blob);
      source = bmp; sw = bmp.width; sh = bmp.height;
    } catch { /* fall back to the video frame */ }
  }
  if (!sw || !sh) { setStatus('Camera not ready', 'err'); return; }

  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const g = c.getContext('2d');
  g.drawImage(source, 0, 0, sw, sh);
  drawHud(g, sw, sh, now, { photoLabel: meta.en });
  if (source.close) source.close();

  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
  const name = `bad-bus_${fileStamp(now)}_${kind}.jpg`;
  addEvidence({ kind: 'photo', name, blob, t: now, label: meta.en, photoType: kind, fix: state.fix,
    info: `${fmtTime(now)} · ${fmtCoord(state.fix)}` });

  const f = $('#flash');
  f.hidden = false;
  f.style.animation = 'none'; void f.offsetWidth; f.style.animation = '';
  setTimeout(() => { f.hidden = true; }, 300);
  setStatus(`Photo saved to Evidence: ${meta.en}`);
}

// ---------------------------------------------------------------- evidence store
let evId = 0;
function addEvidence(item) {
  item.id = ++evId;
  item.url = URL.createObjectURL(item.blob);
  state.evidence.push(item);
  updateEvidenceCount();
}
function updateEvidenceCount() {
  $('#evidence-count').textContent = state.evidence.length + state.incidents.length;
}

function renderEvidence() {
  const list = $('#evidence-list');
  list.innerHTML = '';
  if (!state.evidence.length && !state.incidents.length) {
    list.innerHTML = '<p class="empty">Nothing yet. Record a video, take photos, or tap an incident button.</p>';
    return;
  }
  for (const item of [...state.evidence].reverse()) {
    const row = document.createElement('div');
    row.className = 'ev';
    const thumb = item.kind === 'photo' ? document.createElement('img') : document.createElement('video');
    thumb.src = item.url;
    if (item.kind === 'video') { thumb.muted = true; thumb.playsInline = true; thumb.preload = 'metadata'; }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b></b><span></span>`;
    meta.querySelector('b').textContent = item.label;
    meta.querySelector('span').textContent = item.info;
    const open = button('Open', () => window.open(item.url, '_blank'));
    const save = button('Save', () => shareOrDownload([item]));
    row.append(thumb, meta, open, save);
    list.appendChild(row);
  }
  if (state.incidents.length) {
    const row = document.createElement('div');
    row.className = 'ev';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<b></b><span></span>';
    meta.querySelector('b').textContent = `${state.incidents.length} incident(s) logged`;
    meta.querySelector('span').textContent = state.incidents.map((i) => `${fmtTime(i.t)} ${i.type.en}`).join(' · ');
    row.append(meta);
    list.appendChild(row);
  }
}
function button(label, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.addEventListener('click', fn);
  return b;
}

async function shareOrDownload(items) {
  const files = items.map((i) => new File([i.blob], i.name, { type: i.blob.type }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title: 'Bus incident evidence' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  for (const i of items) {
    const a = document.createElement('a');
    a.href = i.url || URL.createObjectURL(i.blob);
    a.download = i.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------------------------------------------------------------- report + data exports
function buildReport() {
  const d = state.details;
  const L = [];
  const first = state.track[0] || state.fix;
  const day = state.recordings[0]?.start || state.incidents[0]?.t || first?.t || Date.now();

  L.push('תלונה על נהיגה מסוכנת של נהג אוטובוס');
  L.push('Complaint: dangerous driving by a bus driver');
  L.push('');
  L.push(`תאריך / Date: ${fmtDate(day)}`);
  if (d.line) L.push(`קו / Line: ${d.line}`);
  if (d.operator) L.push(`מפעיל / Operator: ${d.operator}`);
  if (d.plate) L.push(`מספר רישוי / Plate: ${d.plate}`);
  if (d.fleet) L.push(`מספר אוטובוס / Fleet no.: ${d.fleet}`);
  if (d.direction) L.push(`כיוון / Direction: ${d.direction}`);
  if (d.driver) L.push(`נהג / Driver: ${d.driver}`);
  if (d.boarded) L.push(`תחנת עלייה / Boarded at: ${d.boarded}`);
  L.push('');

  L.push('אירועים / Incidents:');
  if (!state.incidents.length) L.push('  (none logged)');
  [...state.incidents].sort((a, b) => a.t - b.t).forEach((i, n) => {
    const bits = [`${n + 1}. ${fmtTime(i.t)} — ${i.type.he} / ${i.type.en}`];
    if (i.detail) bits.push(i.detail);
    else if (i.speedKmh != null) bits.push(`speed ${Math.round(i.speedKmh)} km/h${i.limitKmh != null ? ` (limit ${Math.round(i.limitKmh)})` : ''}`);
    if (i.fix) bits.push(`${i.fix.lat.toFixed(5)}, ${i.fix.lon.toFixed(5)} (±${Math.round(i.fix.acc)} m) ${mapsLink(i.fix)}`);
    if (i.recording) bits.push(i.offsetMs < 0 ? `video ${i.recording} from the start (began before recording)` : `video ${i.recording} at ${fmtDuration(i.offsetMs)}`);
    L.push('  ' + bits.join(' — '));
  });
  L.push('');

  if (state.maxSpeed) {
    const m = state.maxSpeed;
    L.push(`מהירות מרבית שנמדדה / Max measured speed: ${Math.round(m.kmh)} km/h at ${fmtTime(m.fix.t)} — ${mapsLink(m.fix)}`);
    L.push('');
  }

  if (state.recordings.length) {
    L.push('הקלטות וידאו / Video recordings:');
    for (const r of state.recordings) L.push(`  ${r.name} — ${fmtTime(r.start)}–${fmtTime(r.end)} (${fmtDuration(r.end - r.start)})`);
    L.push('');
  }
  const photos = state.evidence.filter((e) => e.kind === 'photo');
  if (photos.length) {
    L.push('תמונות / Photos:');
    for (const p of photos) {
      const t = PHOTO_TYPES[p.photoType] || PHOTO_TYPES.other;
      L.push(`  ${t.he} / ${t.en} — ${p.name} — ${fmtTime(p.t)}`);
    }
    L.push('');
  }
  if (d.notes) { L.push('הערות / Notes:'); L.push(d.notes); L.push(''); }

  L.push('(The gov.il form also asks for your full name, ID number, address and mobile number.)');
  L.push('');
  L.push('---');
  L.push('Recorded with Bad Bus Dashcam. Time is Israel time from the phone clock. Position and speed are from the');
  L.push("phone's GPS (accuracy shown as ±m); speed limits, where shown, are from OpenStreetMap and should be verified.");
  L.push('The overlay on the video and photos is burned in at the moment of capture.');
  return L.join('\n');
}

function buildGpx() {
  const esc = (s) => String(s).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
  const pts = state.track.map((p) =>
    `      <trkpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time>` +
    `<extensions><speed>${p.speedKmh != null ? (p.speedKmh / MS_TO_KMH).toFixed(2) : ''}</speed><hacc>${Math.round(p.acc)}</hacc></extensions></trkpt>`).join('\n');
  const wpts = state.incidents.filter((i) => i.fix).map((i) =>
    `  <wpt lat="${i.fix.lat}" lon="${i.fix.lon}"><time>${new Date(i.t).toISOString()}</time><name>${esc(i.type.en)}</name>` +
    `<desc>${esc(`${i.speedKmh != null ? Math.round(i.speedKmh) + ' km/h' : ''} ${i.detail}`)}</desc></wpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bad Bus Dashcam" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
  <trk><name>${esc(busLine() || 'Bus ride')}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}

function buildJson() {
  return JSON.stringify({
    app: 'Bad Bus Dashcam', exported: new Date().toISOString(), timezone: TZ,
    bus: state.details,
    recordings: state.recordings.map((r) => ({ ...r, startISO: new Date(r.start).toISOString(), endISO: new Date(r.end).toISOString() })),
    photos: state.evidence.filter((e) => e.kind === 'photo').map((p) => ({ file: p.name, type: p.photoType, time: new Date(p.t).toISOString(), fix: p.fix })),
    incidents: state.incidents.map((i) => ({ type: i.type.id, label: i.type.en, time: new Date(i.t).toISOString(),
      speedKmh: i.speedKmh, limitKmh: i.limitKmh, fix: i.fix, recording: i.recording, offsetSeconds: i.offsetMs != null ? i.offsetMs / 1000 : null, auto: i.auto, detail: i.detail })),
    maxSpeed: state.maxSpeed,
    track: state.track,
  }, null, 2);
}

function reportFiles() {
  const stamp = fileStamp(Date.now());
  return [
    { name: `bad-bus_${stamp}_report.txt`, blob: new Blob([buildReport()], { type: 'text/plain;charset=utf-8' }) },
    { name: `bad-bus_${stamp}_track.gpx`, blob: new Blob([buildGpx()], { type: 'application/gpx+xml' }) },
    { name: `bad-bus_${stamp}_data.json`, blob: new Blob([buildJson()], { type: 'application/json' }) },
  ];
}

// ---------------------------------------------------------------- misc
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}

// ---------------------------------------------------------------- UI wiring
async function start() {
  const btn = $('#btn-start');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  if (!window.isSecureContext) {
    alert('The camera only works over HTTPS (or localhost). Open the app from its https:// address.');
  }
  try {
    await startCamera();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Start camera & GPS';
    alert(`Could not open the camera: ${e.message || e.name}`);
    return;
  }
  startGps();
  startAudio();      // ask for the mic up front so recording starts instantly
  requestWakeLock();
  state.running = true;
  $('#start-screen').hidden = true;
  $('#controls').hidden = false;
  setStatus('Waiting for GPS…', 'warn');
  requestAnimationFrame(render);
}

function openDetails() {
  const f = $('#details-form');
  for (const el of f.elements) {
    if (!el.name || !(el.name in state.details)) continue;
    if (el.type === 'checkbox') el.checked = !!state.details[el.name];
    else el.value = state.details[el.name];
  }
  $('#dlg-details').showModal();
}

$('#dlg-details').addEventListener('close', async () => {
  if ($('#dlg-details').returnValue !== 'save') return;
  const f = $('#details-form');
  const prevQuality = state.details.quality;
  for (const el of f.elements) {
    if (!el.name || !(el.name in state.details)) continue;
    state.details[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  saveDetails();
  if (!state.details.audio && state.audioStream && !state.recorder) {
    state.audioStream.getTracks().forEach((t) => t.stop());
    state.audioStream = null;
  }
  if (state.details.quality !== prevQuality && state.running) {
    try { await startCamera(); } catch (e) { setStatus(`Camera: ${e.message}`, 'err'); }
  }
});

$('#btn-start').addEventListener('click', start);
$('#btn-details').addEventListener('click', openDetails);
$('#btn-record').addEventListener('click', () => (state.recorder ? stopRecording() : startRecording()));
$('#btn-photo').addEventListener('click', () => $('#dlg-photo').showModal());
$('#dlg-photo').addEventListener('close', () => {
  const v = $('#dlg-photo').returnValue;
  if (v && v !== 'cancel') takePhoto(v);
});
$('#btn-camera-switch').addEventListener('click', async () => {
  state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
  try { await startCamera(); } catch (e) { setStatus(`Camera: ${e.message}`, 'err'); }
});
$('#btn-evidence').addEventListener('click', () => { renderEvidence(); $('#dlg-evidence').showModal(); });
$('#btn-share-all').addEventListener('click', () => shareOrDownload([...state.evidence, ...reportFiles()]));
$('#btn-report').addEventListener('click', () => {
  $('#report-text').value = buildReport();
  $('#dlg-report').showModal();
});
$('#btn-copy-report').addEventListener('click', async () => {
  const ta = $('#report-text');
  try { await navigator.clipboard.writeText(ta.value); }
  catch { ta.select(); document.execCommand('copy'); }
  $('#btn-copy-report').textContent = 'Copied ✓';
  setTimeout(() => { $('#btn-copy-report').textContent = 'Copy'; }, 1500);
});
$('#btn-download-report').addEventListener('click', () => shareOrDownload(reportFiles()));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.running) requestWakeLock();
  } else if (state.recorder) {
    // Browsers pause canvas drawing in the background, so the video would freeze.
    setStatus('App was in the background — the video may have frozen during that time', 'warn');
  }
});
window.addEventListener('beforeunload', (e) => {
  if (state.recorder || state.evidence.length) { e.preventDefault(); e.returnValue = ''; }
});

buildIncidentButtons();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for testing in the browser console.
window.__badbus = { state, buildReport, buildGpx, buildJson, onPosition };
