// MHD Prešov – proxy živých polôh (mhdpo.sk WebSocket) + cestovný poriadok z GTFS mesta Prešov
// GET /api/bus/13              -> živé polohy vozidiel linky
// GET /api/line/13             -> trasy (podľa smeru) a zastávky linky z aktuálneho GTFS
// GET /api/departures?name=X   -> najbližšie odchody zo zastávky X (všetky linky)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const WebSocket = require('ws');
const AdmZip = require('adm-zip');
const VERSION = require('./package.json').version;

const PORT = process.env.PORT || 3000;
const TZ = 'Europe/Bratislava';
const WS_URL = 'wss://wss.mhdpo.sk:2173/?heartbeatInterval=60000&heartbeatLatency=10000';
const GTFS_URL = 'https://www.arcgis.com/sharing/rest/content/items/f1033ca6c2f4461d9aba285e1c7cb079/data';
const LINES = [...new Set(['1', '13', '21', '28', '37', 'N2', ...(process.env.LINES || '').split(',').map(x => x.trim()).filter(Boolean)])];

// ---------- živé polohy ----------
const cache = {};
const seen = {};          // posledná známa poloha každého vozidla (aj keď ho feed na chvíľu vynechá)
const KEEP_MS = 5 * 60 * 1000;
function watch(line, direction) {
  const key = `${line}:${direction}`;
  const ws = new WebSocket(WS_URL, { headers: { Origin: 'https://mhdpo.sk' } });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'setSendBusses', number: line, direction, includeTechnical: false })));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'msg-ping') ws.send(JSON.stringify({ type: 'msg-pong' }));
    if (m.type === 'links') {
      const now = Date.now();
      cache[key] = { at: now, data: m.data || [] };
      for (const b of m.data || []) seen[`${line}:${b.vehicle}`] = { at: now, b };
      try { for (const b of m.data || []) vote(line, direction, b); } catch {}
    }
  });
  ws.on('close', () => setTimeout(() => watch(line, direction), 5000));
  ws.on('error', e => console.log('WS', key, e.message));
}
const watched = new Set();
function ensureWatch(l) { if (watched.has(l) || watched.size >= 20 || !/^[A-Z]?\d{1,3}$/.test(l)) return; watched.add(l); [0, 1].forEach(d => watch(l, d)); }
LINES.forEach(ensureWatch);

// ---------- GTFS ----------
let lineCache = {};
let G = null; // { stops, trips, routes, byStop, cal, calDates, shapes }
function get(url, n = 0) {
  return new Promise((res, rej) => https.get(url, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 5) return res(get(r.headers.location, n + 1));
    if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode));
    const b = []; r.on('data', c => b.push(c)); r.on('end', () => res(Buffer.concat(b)));
  }).on('error', rej));
}
function csv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  const h = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(h.map((k, i) => [k.trim(), (r[i] || '').trim()])));
}
const sec = t => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

async function loadGtfs() {
  try {
    const zip = new AdmZip(process.env.GTFS_FILE ? fs.readFileSync(process.env.GTFS_FILE) : await get(GTFS_URL));
    const rd = n => { const e = zip.getEntry(n); return e ? csv(e.getData().toString('utf8')) : []; };
    const stops = {}; rd('stops.txt').forEach(s => stops[s.stop_id] = { id: s.stop_id, name: s.stop_name.replace(/\*/g, '').replace(/\s+/g, ' ').trim(), lat: +s.stop_lat, lon: +s.stop_lon });
    const routes = {}; rd('routes.txt').forEach(r => routes[r.route_id] = r.route_short_name || r.route_id);
    const trips = {}; rd('trips.txt').forEach(t => trips[t.trip_id] = { route: routes[t.route_id] || t.route_id, service: t.service_id, head: t.trip_headsign, dir: t.direction_id, shape: t.shape_id });
    const byStop = {}, tripStops = {};
    rd('stop_times.txt').forEach(st => {
      const tr = trips[st.trip_id]; if (!tr) return;
      (byStop[st.stop_id] ||= []).push({ t: sec(st.departure_time || st.arrival_time), trip: st.trip_id });
      (tripStops[st.trip_id] ||= []).push({ seq: +st.stop_sequence, stop: st.stop_id });
    });
    const shapes = {}; rd('shapes.txt').forEach(p => (shapes[p.shape_id] ||= []).push([+p.shape_pt_sequence, +p.shape_pt_lat, +p.shape_pt_lon]));
    for (const k in shapes) shapes[k] = shapes[k].sort((a, b) => a[0] - b[0]).map(p => [p[1], p[2]]);
    const cal = rd('calendar.txt'), calDates = rd('calendar_dates.txt');
    G = { stops, trips, routes, byStop, tripStops, shapes, cal, calDates, at: new Date().toISOString() };
    lineCache = {};
    console.log('verzia', VERSION, '| GTFS načítané:', Object.keys(stops).length, 'zastávok,', Object.keys(trips).length, 'spojov');
  } catch (e) { console.log('GTFS chyba:', e.message); }
}
loadGtfs(); setInterval(loadGtfs, 6 * 3600 * 1000);

function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { ymd: process.env.TEST_YMD || (p.year + p.month + p.day), wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), s: (+p.hour % 24) * 3600 + +p.minute * 60 + +p.second };
}
function servicesOn(ymd, wd) {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const on = new Set();
  G.cal.forEach(c => { if (c.start_date <= ymd && ymd <= c.end_date && c[days[wd]] === '1') on.add(c.service_id); });
  G.calDates.forEach(c => { if (c.date === ymd) { if (c.exception_type === '1') on.add(c.service_id); else on.delete(c.service_id); } });
  return on;
}
// Ak dnešok vo feede nie je (feed vypršal), vezmi najtypickejšiu sadu spojov pre rovnaký deň v týždni.
function activeServices(ymd, wd) {
  const on = servicesOn(ymd, wd);
  if (on.size) return { on, approx: null };
  const dates = [...new Set(G.calDates.map(c => c.date))].filter(d => new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)).getDay() === (wd + 1) % 7);
  const freq = {};
  dates.forEach(d => { const k = [...servicesOn(d, wd)].sort().join('|'); if (k) (freq[k] ||= []).push(d); });
  const best = Object.entries(freq).sort((a, b) => b[1].length - a[1].length || (b[1].at(-1) > a[1].at(-1) ? 1 : -1))[0];
  if (!best) return { on, approx: null };
  const ref = best[1].sort().at(-1);
  return { on: new Set(best[0].split('|')), approx: ref.slice(6, 8) + '.' + ref.slice(4, 6) + '.' + ref.slice(0, 4) };
}

// trasa linky: pre každý smer najčastejšie plné varianty (bez krátkych odbočiek)
const dist = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 73000);
function simplify(p, tol = 5) { const o = [p[0]]; for (const q of p.slice(1)) if (dist(q, o[o.length - 1]) > tol) o.push(q); if (o[o.length - 1] !== p[p.length - 1]) o.push(p[p.length - 1]); return o.map(q => [+q[0].toFixed(5), +q[1].toFixed(5)]); }
// trasy a zastávky podľa GTFS smeru (0/1)
function lineRaw(line) {
  if (lineCache[line]) return lineCache[line];
  const byDir = {};
  for (const id in G.trips) { const t = G.trips[id]; if (t.route !== line || !t.shape) continue; ((byDir[t.dir] ||= {})[t.shape] ||= 0); byDir[t.dir][t.shape]++; }
  const out = { shapes: {}, stops: [], dest: {}, gtfs: G.at };
  const stopIds = new Set(), stopDirs = {};
  for (const d in byDir) {
    const cand = Object.entries(byDir[d]).map(([s, n]) => { const p = G.shapes[s] || []; let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return { s, n, L }; });
    const maxL = Math.max(...cand.map(c => c.L));
    const keep = cand.filter(c => c.L >= 0.8 * maxL).sort((a, b) => b.n - a.n).slice(0, 2);
    out.shapes[d] = keep.map(c => simplify(G.shapes[c.s]));
    const keepSet = new Set(keep.map(c => c.s)), heads = {};
    for (const id in G.trips) { const t = G.trips[id]; if (t.route === line && t.dir === d) { heads[t.head] = (heads[t.head] || 0) + 1; if (keepSet.has(t.shape)) (G.tripStops[id] || []).forEach(x => { stopIds.add(x.stop); (stopDirs[x.stop] ||= new Set()).add(d); }); } }
    out.dest[d] = (Object.entries(heads).sort((a, b) => b[1] - a[1])[0] || [''])[0];
  }
  const byName = {};
  stopIds.forEach(id => { const s = G.stops[id]; if (s) (byName[s.name] ||= []).push(s); });
  out.stops = Object.entries(byName).flatMap(([name, arr]) => arr.map(s => ({ id: s.id, name, lat: s.lat, lon: s.lon, gdirs: [...(stopDirs[s.id] || [])] })));
  return lineCache[line] = out;
}
// Ktorý smer mhdpo (0/1) zodpovedá ktorému smeru GTFS? Líši sa podľa linky (13 a 1: mhdpo 1 = GTFS 0, 21 naopak),
// preto to zisťujeme zo živých polôh: v ktorom GTFS smere sa autobus po trase posúva dopredu.
const votes = {}, lastPos = {};
function proj(shape, lat, lng) {
  let best = 1e18, s = 0, acc = 0;
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1], b = shape[i], bx = (b[1] - a[1]) * 73000, by = (b[0] - a[0]) * 111320, px = (lng - a[1]) * 73000, py = (lat - a[0]) * 111320;
    const L2 = bx * bx + by * by || 1e-9, t = Math.max(0, Math.min(1, (px * bx + py * by) / L2)), d = Math.hypot(px - bx * t, py - by * t), seg = Math.sqrt(L2);
    if (d < best) { best = d; s = acc + t * seg; } acc += seg;
  }
  return { s, d: best };
}
function vote(line, mdir, b) {
  if (!G || !b || b.lat == null) return;
  const key = `${line}:${b.vehicle}`, prev = lastPos[key], cur = { lat: +b.lat, lng: +b.lng, mdir };
  if (!prev || prev.mdir !== mdir) { lastPos[key] = cur; return; }
  if (Math.hypot((cur.lat - prev.lat) * 111320, (cur.lng - prev.lng) * 73000) < 40) return; // čakáme na pohyb
  lastPos[key] = cur;
  const raw = lineRaw(line); const v = (votes[line] ||= { '0': { '0': 0, '1': 0 }, '1': { '0': 0, '1': 0 } });
  for (const g of ['0', '1']) {
    const sh = (raw.shapes[g] || [])[0]; if (!sh) continue;
    const p0 = proj(sh, prev.lat, prev.lng), p1 = proj(sh, cur.lat, cur.lng);
    if (p0.d > 60 || p1.d > 60) continue;
    const ds = p1.s - p0.s; if (Math.abs(ds) < 20 || Math.abs(ds) > 3000) continue;
    v[mdir][g] += ds > 0 ? 1 : -1;
  }
}
// true = mhdpo 1 ↔ GTFS 0 (ako pri linke 13)
function flipped(line) { const v = votes[line]; if (!v) return true; return v['1']['0'] + v['0']['1'] >= v['1']['1'] + v['0']['0']; }
const mdirOf = (line, g) => flipped(line) ? (g === '0' ? 1 : 0) : +g;
function lineInfo(line) {
  const raw = lineRaw(line), out = { shapes: {}, stops: [], dest: {}, gtfs: raw.gtfs, flipped: flipped(line) };
  for (const g in raw.shapes) { out.shapes[mdirOf(line, g)] = raw.shapes[g]; out.dest[mdirOf(line, g)] = raw.dest[g]; }
  out.stops = raw.stops.map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, dirs: s.gdirs.map(g => mdirOf(line, g)) }));
  return out;
}
function departures(name, limit = 14, stopId = '') {
  const { ymd, wd, s } = localNow();
  const { on, approx } = activeServices(ymd, wd);
  const ids = stopId && G.stops[stopId] ? [stopId] : Object.values(G.stops).filter(x => x.name === name).map(x => x.id);
  const list = [];
  ids.forEach(id => (G.byStop[id] || []).forEach(d => {
    const t = G.trips[d.trip]; if (!t || !on.has(t.service) || d.t < s - 60) return;
    const seq = G.tripStops[d.trip]; const last = seq && seq.reduce((a, b) => b.seq > a.seq ? b : a, seq[0]);
    if (last && last.stop === id) return; // konečná – neodchádza
    list.push({ line: t.route, head: t.head, dir: mdirOf(t.route, t.dir), t: d.t, time: `${String(Math.floor(d.t / 3600) % 24).padStart(2, '0')}:${String(Math.floor(d.t % 3600 / 60)).padStart(2, '0')}`, inMin: Math.round((d.t - s) / 60) });
  }));
  list.sort((a, b) => a.t - b.t);
  return { name, stopId: stopId || null, now: s, approx, items: list.slice(0, limit) };
}

// ---------- HTTP ----------
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
const SSL_CERT = process.env.SSL_CERT, SSL_KEY = process.env.SSL_KEY;
const useTLS = SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);
const handler = (req, res) => {
  const u = new URL(req.url, 'http://x');
  let m;
  if ((m = u.pathname.match(/^\/api\/bus\/(\w+)/))) {
    ensureWatch(m[1]);
    const out = [], now = Date.now();
    for (const k in seen) {
      const v = seen[k];
      if (now - v.at > KEEP_MS) { delete seen[k]; continue; }
      if (k.split(':')[0] !== m[1]) continue;
      out.push({ ...v.b, delayMin: Math.round(-v.b.delay / 6) / 10, ageS: Math.round((now - v.at) / 1000) });
    }
    return json(res, out);
  }
  if ((m = u.pathname.match(/^\/api\/line\/(\w+)/))) return G ? json(res, lineInfo(m[1])) : json(res, { error: 'GTFS sa ešte načítava' }, 503);
  if (u.pathname === '/api/dirmap') return json(res, Object.fromEntries([...watched].map(l => [l, { flipped: flipped(l), votes: votes[l] || null }])));
  if (u.pathname === '/api/version') return json(res, { version: VERSION });
  if (u.pathname === '/api/departures') return G ? json(res, departures(u.searchParams.get('name') || '', 14, u.searchParams.get('id') || '')) : json(res, { error: 'GTFS sa ešte načítava' }, 503);
  const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.basename(u.pathname));
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); res.end(b); });
};
(useTLS ? https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, handler) : http.createServer(handler))
  .listen(PORT, () => console.log('MHD ' + (useTLS ? 'HTTPS' : 'HTTP') + ' na porte', PORT, 'linky', LINES.join(',')));
