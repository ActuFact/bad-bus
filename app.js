/* Bad Bus Dashcam — records phone video with a burned-in overlay of time, GPS
 * position, speed and bus details, takes stamped photos (plate, driver ID…),
 * logs incidents and builds a complaint report. Everything is grouped into
 * Reports (one per bus ride) that are saved on the phone as they are recorded. */
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
const AUDIO_BPS = 128_000;
const VIDEO_BPS = { '720': 3_000_000, '1080': 6_000_000 };
const STOP_WHEN_MINUTES_LEFT = 1;   // auto-stop recording before storage is completely full

const INCIDENTS = [
  { id: 'speeding',  en: 'Speeding',            he: 'מהירות מופרזת' },
  { id: 'dangerous', en: 'Dangerous driving',   he: 'נהיגה מסוכנת' },
  { id: 'phone',     en: 'Phone while driving', he: 'שימוש בטלפון בזמן נהיגה' },
  { id: 'abusive',   en: 'Abusive behaviour',   he: 'התנהגות פוגענית' },
];
const AUTO_OVERSPEED = { id: 'over_limit', en: 'Over speed limit (auto)', he: 'חריגה ממהירות מותרת (אוטומטי)' };
// Older reports may contain types that were removed from the buttons.
const LEGACY_INCIDENTS = [
  { id: 'red_light', en: 'Red light', he: 'מעבר באור אדום' },
  { id: 'other', en: 'Other', he: 'אחר' },
];
const INCIDENT_BY_ID = Object.fromEntries([...INCIDENTS, AUTO_OVERSPEED, ...LEGACY_INCIDENTS].map((t) => [t.id, t]));
const incidentType = (id) => INCIDENT_BY_ID[id] || { id, en: id, he: id };

const PHOTO_TYPES = {
  plate:      { en: 'Number plate',          he: 'לוחית רישוי' },
  bus_number: { en: 'Bus fleet no. / sign',  he: 'מספר אוטובוס / שילוט קו' },
  driver_id:  { en: 'Driver ID card',        he: 'תעודת נהג' },
  driver:     { en: 'Driver',                he: 'נהג' },
  scene:      { en: 'Scene / traffic light', he: 'זירה / רמזור' },
  other:      { en: 'Other',                 he: 'אחר' },
};

const DETAIL_FIELDS = ['line', 'operator', 'plate', 'fleet', 'direction', 'driver', 'boarded', 'notes'];
const SETTING_FIELDS = ['speedlimit', 'audio', 'quality'];

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

  // GPS (live, not per report)
  watchId: null,
  fix: null,
  speedKmh: null,
  speedHistory: [],
  gpsError: null,

  // speed limit
  limit: null,          // {kmh, name, at: {lat, lon}, t}
  limitPending: false,
  overspeed: null,

  // recording
  recorder: null,
  writer: null,
  recItem: null,
  recStart: null,
  recMime: '',

  // reports
  reports: [],
  report: null,         // the current report
  banner: null,
  wakeLock: null,
  space: null,          // {free, minutes, rate}

  settings: loadSettings(),
};

function loadSettings() {
  const defaults = { speedlimit: true, audio: true, quality: '1080' };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('badbus.settings') || '{}') }; }
  catch { return defaults; }
}
function saveSettings() {
  try { localStorage.setItem('badbus.settings', JSON.stringify(state.settings)); } catch { /* private mode */ }
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
function isoDay(t) { const p = parts(t); return `${p.year}-${p.month}-${p.day}`; }
function hms(t) { const p = parts(t); return `${p.hour}${p.minute}${p.second}`; }
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtBytes(b) {
  if (b == null) return '';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
function fmtMinutes(min) {
  if (min == null) return '—';
  if (min >= 600) return `${Math.floor(min / 60)} h`;
  if (min >= 90) return `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;
  return `${Math.max(0, Math.floor(min))} min`;
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
const pad = (n, w = 3) => String(n).padStart(w, '0');

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

// ---------------------------------------------------------------- reports
function reportTitle(r) {
  return `Report #${r.number}${r.details.line ? ` · Line ${r.details.line}` : ''}`;
}
function reportFolderName(r) {
  const line = r.details.line ? `_Line-${r.details.line.replace(/[^\w-]+/g, '')}` : '';
  return `BadBus-Report-${pad(r.number)}_${isoDay(r.createdAt)}${line}`;
}
function reportCounts(r) {
  const videos = r.items.filter((i) => i.kind === 'video').length;
  const photos = r.items.filter((i) => i.kind === 'photo').length;
  const size = r.items.reduce((n, i) => n + (i.size || 0), 0);
  return { videos, photos, incidents: r.incidents.length, size };
}
function countsText(r) {
  const c = reportCounts(r);
  const bits = [];
  bits.push(`${c.videos} video${c.videos === 1 ? '' : 's'}`);
  bits.push(`${c.photos} photo${c.photos === 1 ? '' : 's'}`);
  bits.push(`${c.incidents} incident${c.incidents === 1 ? '' : 's'}`);
  if (c.size) bits.push(fmtBytes(c.size));
  return bits.join(' · ');
}

async function createReport() {
  const number = Math.max(0, ...state.reports.map((r) => r.number)) + 1;
  const r = {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    number, createdAt: Date.now(), updatedAt: Date.now(),
    details: Object.fromEntries(DETAIL_FIELDS.map((k) => [k, ''])),
    incidents: [], items: [], track: [], maxSpeed: null,
  };
  state.reports.push(r);
  await setCurrentReport(r);
  await persist(r, true);
  return r;
}

async function setCurrentReport(r) {
  state.report = r;
  state.overspeed = null;
  state.speedHistory = [];
  await Store.kvSet('currentReport', r.id);
  updateReportChip();
}

const persistTimers = new Map();
function persist(r, now = false) {
  r.updatedAt = Date.now();
  clearTimeout(persistTimers.get(r.id));
  const save = () => { persistTimers.delete(r.id); return Store.putReport(r).catch((e) => console.error('save failed', e)); };
  if (now) return save();
  persistTimers.set(r.id, setTimeout(save, 3000));
  return Promise.resolve();
}

async function loadReports() {
  state.reports = (await Store.listReports().catch(() => [])) || [];
  // A recording that was cut off (app closed / crashed) — keep what was written.
  for (const r of state.reports) {
    let changed = false;
    for (const item of r.items) {
      if (item.status === 'recording') {
        const f = await Store.getFile(r.id, item.name);
        if (f && f.size) {
          item.status = 'recovered';
          item.size = f.size;
          item.end = item.end || item.t + 1000;
        } else {
          item.status = 'missing';
        }
        changed = true;
      }
    }
    if (changed) await persist(r, true);
  }
  const currentId = await Store.kvGet('currentReport');
  const current = state.reports.find((r) => r.id === currentId) ||
                  [...state.reports].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (current) await setCurrentReport(current);
  else await createReport();
}

function updateReportChip() {
  const r = state.report;
  if (!r) return;
  const c = reportCounts(r);
  $('#report-chip-title').textContent = `Report #${r.number}`;
  $('#report-chip-count').textContent = c.videos + c.photos + c.incidents;
  $('#start-report').textContent = `Current: ${reportTitle(r)} — ${countsText(r)}`;
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
  const r = state.report;
  if (r) {
    r.track.push(fix);
    persist(r);
  }
  if (fix.speedKmh != null) {
    state.speedKmh = fix.speedKmh;
    state.speedHistory.push({ t: fix.t, kmh: fix.speedKmh });
    const cutoff = fix.t - SPEED_HISTORY_SECONDS * 1000;
    while (state.speedHistory.length && state.speedHistory[0].t < cutoff) state.speedHistory.shift();
    // Ignore poor-accuracy fixes for the "max speed" record so it stays credible.
    if (r && fix.acc <= 30 && (!r.maxSpeed || fix.speedKmh > r.maxSpeed.kmh)) {
      r.maxSpeed = { kmh: fix.speedKmh, fix };
    }
  }
  checkOverspeed(fix);
  maybeLookupLimit(fix);
  if (!state.recorder) setStatus(`GPS ±${Math.round(fix.acc)} m — ready`);
}

// ---------------------------------------------------------------- speed limit (OpenStreetMap)
function maybeLookupLimit(fix) {
  if (!state.settings.speedlimit || state.limitPending || !navigator.onLine) return;
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
      if (state.report) persist(state.report);
    }
  } else {
    state.overspeed = null;
  }
}

// ---------------------------------------------------------------- camera
async function startCamera() {
  stopVideoStream();
  const tall = state.settings.quality === '1080';
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
  if (!state.settings.audio || state.audioStream) return;
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
  const d = state.report ? state.report.details : {};
  const bits = [];
  if (state.report) bits.push(`REPORT #${state.report.number}`);
  if (d.line) bits.push(`LINE ${d.line}`);
  if (d.operator) bits.push(d.operator);
  if (d.plate) bits.push(`PLATE ${d.plate}`);
  if (d.fleet) bits.push(`BUS #${d.fleet}`);
  return bits.join('  ·  ');
}

function drawHud(g, w, h, now, opts = {}) {
  const s = Math.min(w, h) / 720;           // scale: 1.0 at 720p
  const padPx = Math.round(14 * s);
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
  text(fmtDateTime(now), padPx, padPx, 26);
  const bus = busLine();
  if (bus) text(bus, padPx, padPx + 32 * s, 20, '#ffcc00');

  if (opts.photoLabel) {
    text(`PHOTO: ${opts.photoLabel.toUpperCase()}`, w - padPx, padPx, 24, '#ffcc00', 700, 'right');
  } else if (state.recorder) {
    const blink = Math.floor(now / 500) % 2 === 0;
    const t = `REC ${fmtDuration(now - state.recStart)}`;
    const tw = text(t, w - padPx, padPx, 26, '#fff', 700, 'right');
    if (blink) {
      g.fillStyle = '#ff3b30';
      g.beginPath();
      g.arc(w - padPx - tw - 16 * s, padPx + 13 * s, 9 * s, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    text('LIVE', w - padPx, padPx, 22, '#a3a6ad', 700, 'right');
  }
  const dir = state.report && state.report.details.direction;
  if (dir && !opts.photoLabel) text(`→ ${dir}`, w - padPx, padPx + 32 * s, 18, '#fff', 500, 'right');

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
  const sw = text(speedStr, padPx, by + padPx - 4 * s, 72, speedColor, 800);
  text('km/h', padPx + sw + 8 * s, by + padPx + 36 * s, 22, speedColor, 700);

  const maxSpeed = state.report && state.report.maxSpeed;
  const limitStr = limit != null ? `LIMIT ${Math.round(limit)}` : (state.settings.speedlimit ? 'LIMIT ?' : '');
  const maxStr = maxSpeed ? `MAX ${Math.round(maxSpeed.kmh)}` : 'MAX --';
  text(`${maxStr}   ${limitStr}`, padPx, by + padPx + 80 * s, 20, '#fff', 600);
  if (state.limit && state.limit.name && limit != null) {
    text(truncate(state.limit.name, 22), padPx, by + padPx + 106 * s, 16, '#a3a6ad', 500);
  }

  // position block
  const px = Math.round(w * (w > h ? 0.30 : 0.42));
  const lineGap = 28 * s;
  if (fix) {
    text(fmtCoord(fix), px, by + padPx, 22);
    const head = fix.heading != null && !Number.isNaN(fix.heading) ? `HDG ${Math.round(fix.heading)}° ${compass(fix.heading)}` : 'HDG --';
    const alt = fix.alt != null ? `ALT ${Math.round(fix.alt)} m` : '';
    text(`±${Math.round(fix.acc)} m   ${head}   ${alt}`, px, by + padPx + lineGap, 18, '#ddd', 500);
    const age = Math.round((now - fix.t) / 1000);
    text(stale ? `GPS FIX ${age}s OLD` : `GPS ${fmtTime(fix.t)}  (${fix.src === 'gps' ? 'doppler' : 'computed'})`,
      px, by + padPx + lineGap * 2, 16, stale ? '#ffcc00' : '#a3a6ad', 500);
  } else {
    text(state.gpsError || 'WAITING FOR GPS…', px, by + padPx, 22, '#ffcc00');
  }

  if (w > h) drawSpeedGraph(g, w - padPx - 260 * s, by + padPx, 260 * s, botH - padPx * 2, s, now, limit);

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

// ---------------------------------------------------------------- storage space
function nominalBytesPerSec() {
  return ((VIDEO_BPS[state.settings.quality] || VIDEO_BPS['1080']) + (state.settings.audio ? AUDIO_BPS : 0)) / 8;
}

async function updateSpace() {
  const est = await Store.estimate();
  let rate = nominalBytesPerSec();
  // Once a recording has run a little while, use its real data rate instead.
  if (state.recorder && state.writer) {
    const secs = (Date.now() - state.recStart) / 1000;
    if (secs >= 10 && state.writer.bytes > 0) rate = state.writer.bytes / secs;
  }
  if (!est) { state.space = null; renderSpaceChip(); return; }
  let free = est.free;
  if (Store.usingMemory) free = Math.min(free, 1.5 * 1024 ** 3); // memory fallback: be conservative
  state.space = { free, rate, minutes: free / rate / 60 };
  renderSpaceChip();
  if (state.recorder && state.space.minutes < STOP_WHEN_MINUTES_LEFT) {
    stopRecording();
    setStatus('Storage almost full — recording stopped. Save and delete old reports to free space.', 'err');
  }
}

function renderSpaceChip() {
  const chip = $('#space-chip');
  if (!state.space) { chip.hidden = true; return; }
  const m = state.space.minutes;
  chip.hidden = false;
  chip.className = m < 10 ? 'chip err' : m < 30 ? 'chip warn' : 'chip';
  chip.textContent = `💾 ${fmtMinutes(m)} left at ${state.settings.quality}p`;
  chip.title = `About ${fmtBytes(state.space.free)} available to the app, recording ≈ ${fmtBytes(state.space.rate * 60)}/min`;
}

// ---------------------------------------------------------------- recording
function pickMime() {
  const types = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  if (!window.MediaRecorder) return null;
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (state.recorder) return;
  const mime = pickMime();
  if (mime === null) { setStatus('This browser cannot record video (no MediaRecorder).', 'err'); return; }
  if (state.space && state.space.minutes < STOP_WHEN_MINUTES_LEFT + 1) {
    setStatus('Not enough storage left to record. Save and delete old reports first.', 'err');
    return;
  }
  hidePostRecord();
  const btn = $('#btn-record');
  btn.disabled = true;
  try {
    await startAudio();
    const out = canvas.captureStream(30);
    if (state.audioStream) state.audioStream.getAudioTracks().forEach((t) => out.addTrack(t));
    const bps = VIDEO_BPS[state.settings.quality] || VIDEO_BPS['1080'];
    let rec;
    try {
      rec = new MediaRecorder(out, mime ? { mimeType: mime, videoBitsPerSecond: bps, audioBitsPerSecond: AUDIO_BPS } : { videoBitsPerSecond: bps });
    } catch {
      rec = new MediaRecorder(out);
    }
    const r = state.report;
    const start = Date.now();
    const recMime = rec.mimeType || mime || 'video/webm';
    const ext = recMime.includes('mp4') ? 'mp4' : 'webm';
    const n = r.items.filter((i) => i.kind === 'video').length + 1;
    const item = {
      kind: 'video', name: `video-${pad(n, 2)}_${hms(start)}.${ext}`, mime: recMime.split(';')[0],
      t: start, end: null, size: 0, status: 'recording',
    };
    const writer = await Store.openWriter(r.id, item.name);
    item.storage = writer.kind;
    r.items.push(item);
    await persist(r, true);

    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      item.size += e.data.size;
      writer.write(e.data).then(() => {
        if (writer.failed && state.recorder === rec) {
          stopRecording();
          setStatus(`Could not save video: ${writer.failed.message}. Storage may be full.`, 'err');
        }
      });
    };
    rec.onstop = () => finishRecording(r, item, writer);
    rec.start(1000);   // a chunk every second, written straight to storage

    Object.assign(state, { recorder: rec, writer, recItem: item, recStart: start, recMime });
    btn.classList.add('on');
    setStatus(writer.kind === 'opfs'
      ? 'Recording — saving to phone as it records. Keep this screen open.'
      : 'Recording — this browser can only keep it in memory; save it right after.', 'warn');
    updateReportChip();
    requestWakeLock();
    updateSpace();
  } catch (e) {
    setStatus(`Could not start recording: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

async function finishRecording(r, item, writer) {
  state.recorder = null;
  state.writer = null;
  state.recItem = null;
  $('#btn-record').classList.remove('on');
  item.end = Date.now();
  try {
    await writer.close();
    item.status = 'done';
  } catch (e) {
    item.status = 'recovered';
    setStatus(`Video saved only partly: ${e.message}`, 'err');
  }
  const f = await Store.getFile(r.id, item.name);
  if (f) item.size = f.size;
  await persist(r, true);
  updateReportChip();
  updateSpace();
  if (item.status === 'done') {
    setStatus(`Video saved in ${reportTitle(r)}`);
    showPostRecord(r, item);
  }
}

// After each recording: a quick way to throw it away if nothing happened.
let postRecordTimer = null;
function showPostRecord(r, item) {
  const bar = $('#post-record');
  const marked = r.incidents.filter((i) => i.recording === item.name).length;
  $('#post-record-text').textContent =
    `Saved ${fmtDuration(item.end - item.t)} video (${fmtBytes(item.size)})` + (marked ? ` · ${marked} incident${marked > 1 ? 's' : ''} marked` : '');
  bar.hidden = false;
  bar.dataset.report = r.id;
  bar.dataset.item = item.name;
  clearTimeout(postRecordTimer);
  postRecordTimer = setTimeout(hidePostRecord, 20000);
}
function hidePostRecord() {
  clearTimeout(postRecordTimer);
  $('#post-record').hidden = true;
}

// ---------------------------------------------------------------- incidents
function addIncident(type, extra = {}) {
  const r = state.report;
  const t = extra.at || Date.now();
  const rec = state.recItem;
  const inc = {
    type: type.id, t, fix: state.fix, speedKmh: state.speedKmh, limitKmh: currentLimit(),
    recording: rec ? rec.name : null, offsetMs: rec ? t - rec.t : null,
    auto: !!extra.auto, detail: extra.detail || '',
  };
  r.incidents.push(inc);
  persist(r, true);
  state.banner = { text: `! ${type.en.toUpperCase()}  ${fmtTime(t)}`, until: Date.now() + BANNER_MS };
  if (navigator.vibrate) navigator.vibrate(80);
  if (!rec && !extra.auto) setStatus(`Logged "${type.en}" — tip: start recording so the video shows it`, 'warn');
  updateReportChip();
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
  const r = state.report;
  const item = {
    kind: 'photo', name: `photo_${kind}_${hms(now)}.jpg`, mime: 'image/jpeg',
    t: now, size: blob.size, photoType: kind, fix: state.fix, status: 'done',
  };
  try {
    item.storage = await Store.writeFile(r.id, item.name, blob);
  } catch (e) {
    setStatus(`Could not save photo: ${e.message}`, 'err');
    return;
  }
  r.items.push(item);
  await persist(r, true);
  updateReportChip();
  updateSpace();

  const f = $('#flash');
  f.hidden = false;
  f.style.animation = 'none'; void f.offsetWidth; f.style.animation = '';
  setTimeout(() => { f.hidden = true; }, 300);
  setStatus(`Photo saved in ${reportTitle(r)}: ${meta.en}`);
}

// ---------------------------------------------------------------- deleting (always confirmed)
function confirmDialog({ title, message, ok = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    const d = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-msg').textContent = message;
    const b = $('#confirm-ok');
    b.textContent = ok;
    b.className = danger ? 'danger' : 'primary';
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.showModal();
  });
}

async function deleteItem(r, item) {
  if (state.recItem === item) { setStatus('Stop recording first', 'warn'); return false; }
  const linked = r.incidents.filter((i) => i.recording === item.name).length;
  const what = item.kind === 'video'
    ? `the ${fmtDuration((item.end || item.t) - item.t)} video recorded at ${fmtTime(item.t)} (${fmtBytes(item.size)})`
    : `the ${(PHOTO_TYPES[item.photoType] || PHOTO_TYPES.other).en.toLowerCase()} photo taken at ${fmtTime(item.t)}`;
  const ok = await confirmDialog({
    title: item.kind === 'video' ? 'Delete this video?' : 'Delete this photo?',
    message: `This permanently deletes ${what} from your phone. It can't be undone.` +
      (linked ? `\n\n${linked} incident${linked > 1 ? 's were' : ' was'} marked during this video. They stay in the report, without the video.` : ''),
  });
  if (!ok) return false;
  await Store.deleteFile(r.id, item.name);
  r.items = r.items.filter((i) => i !== item);
  for (const inc of r.incidents) if (inc.recording === item.name) inc.recordingDeleted = true;
  await persist(r, true);
  updateReportChip();
  updateSpace();
  setStatus(`${item.kind === 'video' ? 'Video' : 'Photo'} deleted`);
  return true;
}

async function deleteIncident(r, inc) {
  const ok = await confirmDialog({
    title: 'Remove this incident?',
    message: `${incidentType(inc.type).en} at ${fmtTime(inc.t)} will be removed from the report. Videos and photos are not affected.`,
    ok: 'Remove',
  });
  if (!ok) return false;
  r.incidents = r.incidents.filter((i) => i !== inc);
  await persist(r, true);
  updateReportChip();
  return true;
}

async function deleteReport(r) {
  if (state.recorder && state.report === r) { setStatus('Stop recording first', 'warn'); return false; }
  const ok = await confirmDialog({
    title: `Delete ${reportTitle(r)}?`,
    message: `This permanently deletes everything in it from your phone: ${countsText(r)}.\n\n` +
      'Make sure you have used "Save to phone" first if you want to keep it. This can\'t be undone.',
    ok: 'Delete report',
  });
  if (!ok) return false;
  await Store.deleteReport(r.id);
  state.reports = state.reports.filter((x) => x !== r);
  if (state.report === r) {
    const next = [...state.reports].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (next) await setCurrentReport(next); else await createReport();
  }
  updateSpace();
  return true;
}

// ---------------------------------------------------------------- report text + data files
function buildReport(r = state.report) {
  const d = r.details;
  const L = [];
  const day = r.items[0]?.t || r.incidents[0]?.t || r.track[0]?.t || r.createdAt;

  L.push('תלונה על נהיגה מסוכנת של נהג אוטובוס');
  L.push('Complaint: dangerous driving by a bus driver');
  L.push(`Bad Bus report #${r.number} — folder ${reportFolderName(r)}`);
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
  if (!r.incidents.length) L.push('  (none logged)');
  [...r.incidents].sort((a, b) => a.t - b.t).forEach((i, n) => {
    const type = incidentType(i.type);
    const bits = [`${n + 1}. ${fmtTime(i.t)} — ${type.he} / ${type.en}`];
    if (i.detail) bits.push(i.detail);
    else if (i.speedKmh != null) bits.push(`speed ${Math.round(i.speedKmh)} km/h${i.limitKmh != null ? ` (limit ${Math.round(i.limitKmh)})` : ''}`);
    if (i.fix) bits.push(`${i.fix.lat.toFixed(5)}, ${i.fix.lon.toFixed(5)} (±${Math.round(i.fix.acc)} m) ${mapsLink(i.fix)}`);
    if (i.recording && !i.recordingDeleted) {
      bits.push(i.offsetMs < 0 ? `video ${i.recording} from the start (began before recording)` : `video ${i.recording} at ${fmtDuration(i.offsetMs)}`);
    }
    L.push('  ' + bits.join(' — '));
  });
  L.push('');

  if (r.maxSpeed) {
    const m = r.maxSpeed;
    L.push(`מהירות מרבית שנמדדה / Max measured speed: ${Math.round(m.kmh)} km/h at ${fmtTime(m.fix.t)} — ${mapsLink(m.fix)}`);
    L.push('');
  }

  const videos = r.items.filter((i) => i.kind === 'video');
  if (videos.length) {
    L.push('הקלטות וידאו / Video recordings:');
    for (const v of videos) {
      L.push(`  ${v.name} — ${fmtTime(v.t)}–${fmtTime(v.end || v.t)} (${fmtDuration((v.end || v.t) - v.t)})${v.status === 'recovered' ? ' [recovered after interruption]' : ''}`);
    }
    L.push('');
  }
  const photos = r.items.filter((i) => i.kind === 'photo');
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

function buildGpx(r = state.report) {
  const esc = (s) => String(s).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
  const pts = r.track.map((p) =>
    `      <trkpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time>` +
    `<extensions><speed>${p.speedKmh != null ? (p.speedKmh / MS_TO_KMH).toFixed(2) : ''}</speed><hacc>${Math.round(p.acc)}</hacc></extensions></trkpt>`).join('\n');
  const wpts = r.incidents.filter((i) => i.fix).map((i) =>
    `  <wpt lat="${i.fix.lat}" lon="${i.fix.lon}"><time>${new Date(i.t).toISOString()}</time><name>${esc(incidentType(i.type).en)}</name>` +
    `<desc>${esc(`${i.speedKmh != null ? Math.round(i.speedKmh) + ' km/h' : ''} ${i.detail}`)}</desc></wpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bad Bus Dashcam" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
  <trk><name>${esc(reportTitle(r))}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}

function buildJson(r = state.report) {
  return JSON.stringify({
    app: 'Bad Bus Dashcam', exported: new Date().toISOString(), timezone: TZ,
    report: { number: r.number, folder: reportFolderName(r), created: new Date(r.createdAt).toISOString() },
    bus: r.details,
    files: r.items.map((i) => ({ file: i.name, kind: i.kind, type: i.photoType, status: i.status, size: i.size,
      start: new Date(i.t).toISOString(), end: i.end ? new Date(i.end).toISOString() : null, fix: i.fix })),
    incidents: r.incidents.map((i) => ({ type: i.type, label: incidentType(i.type).en, time: new Date(i.t).toISOString(),
      speedKmh: i.speedKmh, limitKmh: i.limitKmh, fix: i.fix, recording: i.recordingDeleted ? null : i.recording,
      offsetSeconds: i.offsetMs != null ? i.offsetMs / 1000 : null, auto: i.auto, detail: i.detail })),
    maxSpeed: r.maxSpeed,
    track: r.track,
  }, null, 2);
}

/** All files of a report, ready to save: videos, photos, report.txt, track.gpx, data.json. */
async function reportEntries(r, { textOnly = false } = {}) {
  const entries = [];
  if (!textOnly) {
    for (const item of r.items) {
      const blob = await Store.getFile(r.id, item.name);
      if (blob) entries.push({ name: item.name, blob, t: item.t });
    }
  }
  const now = Date.now();
  entries.push({ name: 'report.txt', blob: new Blob([buildReport(r)], { type: 'text/plain' }), t: now });
  entries.push({ name: 'track.gpx', blob: new Blob([buildGpx(r)], { type: 'application/gpx+xml' }), t: now });
  entries.push({ name: 'data.json', blob: new Blob([buildJson(r)], { type: 'application/json' }), t: now });
  return entries;
}

// ---------------------------------------------------------------- saving to the phone
function download(blob, name) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function saveToPhone(r) {
  const out = $('#save-result');
  out.textContent = 'Preparing…';
  try {
    const entries = await reportEntries(r);
    const folder = reportFolderName(r);
    if (Store.canPickFolder) {
      const path = await Store.exportToFolder(folder, entries);
      r.savedAt = Date.now();
      await persist(r, true);
      out.textContent = `Saved ${entries.length} files to the folder "${path}".`;
      return;
    }
    // iPhone / Android without folder access: the share sheet. "Save to Files" puts them all in one folder.
    const files = entries
      .filter((e) => !/\.(gpx|json)$/.test(e.name))  // share sheets reject these types; they're in the .zip
      .map((e) => new File([e.blob], e.name, { type: e.blob.type }));
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: folder });
      r.savedAt = Date.now();
      await persist(r, true);
      out.textContent = 'Shared. On iPhone choose "Save to Files" and create a folder named after the report.';
      return;
    }
    await saveZip(r);
  } catch (e) {
    out.textContent = e.name === 'AbortError' ? 'Cancelled.' : `Could not save: ${e.message}. Try "Download .zip".`;
  }
}

async function saveZip(r) {
  const out = $('#save-result');
  try {
    const entries = await reportEntries(r);
    const zip = await Store.makeZip(reportFolderName(r), entries, (i, n, name) => {
      out.textContent = `Building .zip ${i + 1}/${n}: ${name}…`;
    });
    download(zip, `${reportFolderName(r)}.zip`);
    r.savedAt = Date.now();
    await persist(r, true);
    out.textContent = `Downloaded ${reportFolderName(r)}.zip (${fmtBytes(zip.size)}). Open it in Files to get the report folder.`;
  } catch (e) {
    out.textContent = `Could not build .zip: ${e.message}`;
  }
}

async function saveOne(r, item) {
  const blob = await Store.getFile(r.id, item.name);
  if (!blob) { setStatus('File not found', 'err'); return; }
  const file = new File([blob], item.name, { type: blob.type || item.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, item.name);
}

// ---------------------------------------------------------------- report dialog
const openUrls = [];
function trackUrl(url) { openUrls.push(url); return url; }
function releaseUrls() { while (openUrls.length) URL.revokeObjectURL(openUrls.pop()); }

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') e.addEventListener('click', v);
    else if (k === 'class') e.className = v;
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

async function renderReportDialog(r) {
  releaseUrls();
  $('#report-title').textContent = reportTitle(r);
  const d = r.details;
  $('#report-sub').textContent = [fmtDate(r.createdAt), d.operator, d.plate && `plate ${d.plate}`, d.direction].filter(Boolean).join(' · ') +
    (r.savedAt ? ` · last saved to phone ${fmtTime(r.savedAt)}` : ' · not saved to phone yet');
  $('#report-current-note').hidden = r === state.report;
  $('#btn-make-current').hidden = r === state.report;

  const list = $('#report-items');
  list.innerHTML = '';
  if (!r.items.length) list.append(el('p', { class: 'empty' }, 'No videos or photos yet.'));
  for (const item of [...r.items].sort((a, b) => b.t - a.t)) {
    const blob = item.status === 'recording' ? null : await Store.getFile(r.id, item.name);
    const url = blob ? trackUrl(URL.createObjectURL(blob)) : null;
    let thumb;
    if (item.kind === 'photo') thumb = el('img', { src: url, alt: '' });
    else {
      thumb = el('video', { src: url ? `${url}#t=0.5` : null, muted: '', playsinline: '', preload: 'metadata' });
      thumb.muted = true;
    }
    const label = item.kind === 'video'
      ? `🎥 Video ${fmtDuration((item.end || Date.now()) - item.t)}`
      : `📷 ${(PHOTO_TYPES[item.photoType] || PHOTO_TYPES.other).en}`;
    const statusNote = item.status === 'recording' ? ' · recording…' : item.status === 'recovered' ? ' · recovered' :
                       item.status === 'missing' ? ' · file missing' : '';
    const row = el('div', { class: 'ev' },
      thumb,
      el('div', { class: 'meta' }, el('b', {}, label), el('span', {}, `${fmtTime(item.t)} · ${fmtBytes(item.size)}${statusNote}`)),
      el('div', { class: 'actions' },
        url ? el('button', { type: 'button', onclick: () => openViewer(item, url) }, item.kind === 'video' ? '▶ Play' : 'View') : null,
        url ? el('button', { type: 'button', onclick: () => saveOne(r, item) }, 'Save') : null,
        item.status !== 'recording' ? el('button', { type: 'button', class: 'danger-outline', onclick: async () => {
          if (await deleteItem(r, item)) renderReportDialog(r);
        } }, 'Delete…') : null),
    );
    list.append(row);
  }

  const incs = $('#report-incidents');
  incs.innerHTML = '';
  if (!r.incidents.length) incs.append(el('p', { class: 'empty' }, 'No incidents marked.'));
  for (const inc of [...r.incidents].sort((a, b) => a.t - b.t)) {
    const speed = inc.speedKmh != null ? ` · ${Math.round(inc.speedKmh)} km/h` : '';
    incs.append(el('div', { class: 'ev' },
      el('div', { class: 'meta' }, el('b', {}, `⚠ ${incidentType(inc.type).en}`),
        el('span', {}, `${fmtTime(inc.t)}${speed}${inc.recording && !inc.recordingDeleted ? ` · in ${inc.recording} at ${fmtDuration(Math.max(0, inc.offsetMs))}` : ''}`)),
      el('button', { type: 'button', class: 'danger-outline', onclick: async () => {
        if (await deleteIncident(r, inc)) renderReportDialog(r);
      } }, 'Remove…'),
    ));
  }

  $('#report-text').value = buildReport(r);
  $('#save-result').textContent = Store.canPickFolder
    ? `"Save to phone" copies everything into a folder named ${reportFolderName(r)}.`
    : `"Save to phone" opens the share sheet — on iPhone pick "Save to Files" and make a folder called ${reportFolderName(r)}. Or use "Download .zip".`;
  $('#dlg-report').dataset.report = r.id;
}

function openReport(r) {
  renderReportDialog(r);
  if (!$('#dlg-report').open) $('#dlg-report').showModal();
}

function openViewer(item, url) {
  const box = $('#viewer-box');
  box.innerHTML = '';
  if (item.kind === 'video') {
    const v = el('video', { src: url, controls: '', playsinline: '', autoplay: '' });
    box.append(v);
  } else {
    box.append(el('img', { src: url, alt: item.name }));
  }
  $('#viewer-name').textContent = item.name;
  $('#dlg-viewer').showModal();
}

function renderReportsList() {
  const list = $('#reports-list');
  list.innerHTML = '';
  const sorted = [...state.reports].sort((a, b) => b.createdAt - a.createdAt);
  for (const r of sorted) {
    const current = r === state.report;
    list.append(el('div', { class: 'ev' + (current ? ' current' : '') },
      el('div', { class: 'meta' },
        el('b', {}, `${reportTitle(r)}${current ? ' (current)' : ''}`),
        el('span', {}, `${fmtDate(r.createdAt)} · ${countsText(r)}${r.savedAt ? ' · saved ✓' : ''}`)),
      el('div', { class: 'actions' },
        el('button', { type: 'button', onclick: () => { $('#dlg-reports').close(); openReport(r); } }, 'Open'),
        el('button', { type: 'button', class: 'danger-outline', onclick: async () => {
          if (await deleteReport(r)) renderReportsList();
        } }, 'Delete…')),
    ));
  }
  Store.estimate().then((est) => {
    const used = state.reports.reduce((n, r) => n + reportCounts(r).size, 0);
    $('#reports-space').textContent = `Reports use ${fmtBytes(used)} on this phone` +
      (est ? ` · about ${fmtBytes(est.free)} free for the app` : '') +
      (state.space ? ` (≈ ${fmtMinutes(state.space.minutes)} of ${state.settings.quality}p video)` : '');
  });
}

async function newReportFlow() {
  if (state.recorder) {
    const ok = await confirmDialog({ title: 'Stop recording?', message: 'Recording will stop and be saved in the current report before the new report starts.', ok: 'Stop & continue', danger: false });
    if (!ok) return;
    stopRecording();
    await new Promise((res) => setTimeout(res, 500));
  }
  await createReport();
  hidePostRecord();
  if ($('#dlg-reports').open) $('#dlg-reports').close();
  if ($('#dlg-report').open) $('#dlg-report').close();
  setStatus(`Started ${reportTitle(state.report)}`);
  openDetails();
}

// ---------------------------------------------------------------- details & settings
function openDetails() {
  const f = $('#details-form');
  const r = state.report;
  $('#details-title').textContent = `Bus details — Report #${r.number}`;
  for (const el2 of f.elements) {
    if (!el2.name) continue;
    if (DETAIL_FIELDS.includes(el2.name)) el2.value = r.details[el2.name] || '';
    else if (SETTING_FIELDS.includes(el2.name)) {
      if (el2.type === 'checkbox') el2.checked = !!state.settings[el2.name];
      else el2.value = state.settings[el2.name];
    }
  }
  $('#dlg-details').showModal();
}

$('#dlg-details').addEventListener('close', async () => {
  if ($('#dlg-details').returnValue !== 'save') return;
  const f = $('#details-form');
  const r = state.report;
  const prevQuality = state.settings.quality;
  for (const el2 of f.elements) {
    if (!el2.name) continue;
    if (DETAIL_FIELDS.includes(el2.name)) r.details[el2.name] = el2.value.trim();
    else if (SETTING_FIELDS.includes(el2.name)) state.settings[el2.name] = el2.type === 'checkbox' ? el2.checked : el2.value;
  }
  saveSettings();
  await persist(r, true);
  updateReportChip();
  if (!state.settings.audio && state.audioStream && !state.recorder) {
    state.audioStream.getTracks().forEach((t) => t.stop());
    state.audioStream = null;
  }
  if (state.settings.quality !== prevQuality && state.running) {
    try { await startCamera(); } catch (e) { setStatus(`Camera: ${e.message}`, 'err'); }
  }
  updateSpace();
});

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
  updateSpace();
  setInterval(updateSpace, 5000);
}

$('#btn-start').addEventListener('click', start);
$('#btn-start-reports').addEventListener('click', () => { renderReportsList(); $('#dlg-reports').showModal(); });
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
$('#btn-report').addEventListener('click', () => openReport(state.report));
$('#btn-reports').addEventListener('click', () => { renderReportsList(); $('#dlg-reports').showModal(); });
$('#btn-new-report').addEventListener('click', newReportFlow);
$('#btn-new-report-2').addEventListener('click', newReportFlow);

const dialogReport = () => state.reports.find((r) => r.id === $('#dlg-report').dataset.report) || state.report;
$('#btn-save-phone').addEventListener('click', () => saveToPhone(dialogReport()));
$('#btn-save-zip').addEventListener('click', () => saveZip(dialogReport()));
$('#btn-edit-details').addEventListener('click', () => {
  if (dialogReport() !== state.report) return;
  $('#dlg-report').close();
  openDetails();
});
$('#btn-make-current').addEventListener('click', async () => {
  if (state.recorder) { setStatus('Stop recording first', 'warn'); return; }
  await setCurrentReport(dialogReport());
  renderReportDialog(state.report);
  setStatus(`Now adding to ${reportTitle(state.report)}`);
});
$('#btn-copy-report').addEventListener('click', async () => {
  const ta = $('#report-text');
  try { await navigator.clipboard.writeText(ta.value); }
  catch { ta.select(); document.execCommand('copy'); }
  $('#btn-copy-report').textContent = 'Copied ✓';
  setTimeout(() => { $('#btn-copy-report').textContent = 'Copy text'; }, 1500);
});
$('#dlg-report').addEventListener('close', releaseUrls);
$('#dlg-viewer').addEventListener('close', () => { $('#viewer-box').innerHTML = ''; });

$('#btn-post-keep').addEventListener('click', hidePostRecord);
$('#btn-post-delete').addEventListener('click', async () => {
  const bar = $('#post-record');
  const r = state.reports.find((x) => x.id === bar.dataset.report);
  const item = r && r.items.find((i) => i.name === bar.dataset.item);
  clearTimeout(postRecordTimer);
  if (!item) { hidePostRecord(); return; }
  if (await deleteItem(r, item)) hidePostRecord();
  else postRecordTimer = setTimeout(hidePostRecord, 20000);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.running) requestWakeLock();
  } else {
    if (state.report) persist(state.report, true);
    if (state.recorder) setStatus('App was in the background — the video may have frozen during that time', 'warn');
  }
});
window.addEventListener('beforeunload', (e) => {
  if (state.report) Store.putReport(state.report);
  if (state.recorder) { e.preventDefault(); e.returnValue = ''; }
});

buildIncidentButtons();
Store.persist();   // ask the browser not to clear our storage when the phone is low on space
loadReports().then(updateReportChip).catch((e) => setStatus(`Storage error: ${e.message}`, 'err'));
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for testing in the browser console.
window.__badbus = { state, buildReport, buildGpx, buildJson, onPosition, Store, reportEntries, deleteItem, createReport };
