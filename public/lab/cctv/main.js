// CCTV WALL — one camera feed per agent session.
import { connectFeed } from '../shared/feed.js';
import * as art from './art.js';

const TOOLS = ['claude', 'codex', 'cursor'];
const WALK_MS = 1500;
const NOSIGNAL_MS = 1500;
const GAP = 8;
const WIDE_LINGER_MS = 5 * 60_000; // an orchestrator keeps its conference room this long after the crew has gone
const MOVE_MS = 600; // one coordinated re-flow: fade out (0-25%), slide (25-75%), fade in (75-100%)
const MOVE_REST_MS = 2400; // quiet time between two animated re-flows; changes that arrive meanwhile are batched
const SPARE_CELLS = 1; // free monitors a freshly chosen grid keeps in hand
const GROW_SETTLE_MS = 20_000; // the wall only re-sizes to bigger tiles once the roster has been smaller for this long

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function setText(node, t) {
  t = t == null ? '' : String(t);
  if (node.textContent !== t) node.textContent = t;
}
const pad2 = (n) => String(n).padStart(2, '0');
const clockStr = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s < 600 ? `${m}m ${pad2(s % 60)}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}
function fmtShort(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
const toolInfo = (t) => art.TOOL[t] || art.TOOL.claude;
const whereOf = (s) => (s.branch ? `${s.project || '~'} · ${s.branch}` : s.project || s.cwd || '~');

const mq = matchMedia('(prefers-reduced-motion: reduce)');
const forceReduce = new URLSearchParams(location.search).has('reduce'); // ?reduce=1 exercises the reduced-motion paths
let reduce = mq.matches || forceReduce;
mq.addEventListener?.('change', (e) => { reduce = e.matches || forceReduce; });

/* ------------------------------------------------------------------ state */
const tiles = new Map();
const slots = new Map(); // standby monitors, keyed by grid cell "row:col"
let state = null;
let skew = 0; // server clock minus local clock
let firstState = true;
let camSeq = 0;
let selected = null;
let selSub = null;
let cursorId = null;
let tick = 0;
let geo = null; // the geometry currently on the wall
let layoutSig = '';
let lastBox = '';
let restUntil = 0; // no new animated re-flow before this time
let layoutTimer = 0;
let gridMem = null; // { box, cols, cw, th, betterSince } — the grid in use, kept while it still fits
let regridAt = 0;
let pendingTask = null; // { id, sessionId, until }
let bigSwitchAt = 0;
let needIdx = -1;
const perf = { ms: 0, last: 0, feeds: 0 }; // draw cost of the last tick / smoothed

const wall = $('wall');
const grid = $('grid');
const serverNow = () => Date.now() + skew;

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const t = e.target.__tile || e.target.__slot;
    if (t) t.visible = e.isIntersecting;
  }
}, { root: wall, rootMargin: '80px' });

// Which sessions were recently orchestrators survives a reload, so the wall comes back in the same shape.
const wideMem = (() => { try { return JSON.parse(sessionStorage.getItem('cctv.wide') || '{}') || {}; } catch { return {}; } })();
let wideSavedAt = 0;
function saveWide() {
  const now = Date.now();
  if (now - wideSavedAt < 10_000) return;
  wideSavedAt = now;
  const o = {};
  for (const t of tiles.values()) if (t.wideUntil > now) o[t.id] = t.wideUntil;
  try { sessionStorage.setItem('cctv.wide', JSON.stringify(o)); } catch { /* private mode */ }
}

/* ------------------------------------------------------------------ tiles */
function createTile(s) {
  const root = el('div', 'tile unplaced');
  root.tabIndex = -1;
  root.setAttribute('role', 'button');
  const pic = el('div', 'pic');
  const canvas = el('canvas');
  const tl = el('div', 'ov tl');
  const nm = el('span', 'nm'), badge = el('span', 'badge'), bcode = el('span', 'b-code'), bfull = el('span', 'b-full');
  badge.append(bcode, bfull);
  tl.append(nm, badge);
  const tr = el('div', 'ov tr');
  const cam = el('span', 'cam');
  tr.append(cam, el('span', 'rec', 'REC'));
  const bot = el('div', 'ov bot');
  const where = el('span', 'where'), pj = el('b', 'pj'), brn = el('span', 'brn'), age = el('span', 'age');
  where.append(pj, brn);
  bot.append(where, age);
  const stamp = el('div', 'stamp', 'NEEDS YOU'), onmain = el('div', 'onmain', 'ON MAIN');
  for (const d of [tl, tr, bot, stamp, onmain]) d.setAttribute('aria-hidden', 'true');
  pic.append(canvas, el('div', 'crt'), tl, tr, bot, stamp, onmain);
  const cap = el('div', 'cap');
  const capic = el('canvas', 'capic');
  capic.width = 7; capic.height = 7;
  const captext = el('span', 'captext'), crew = el('span', 'crew'), crewL = el('span', 'cl', 'CREW '), crewV = el('span', 'cv'), crewD = el('span', 'cd');
  crew.append(crewL, crewV, crewD);
  cap.append(capic, captext, crew);
  root.append(pic, cap);
  const t = {
    id: s.id, root, pic, canvas, g: canvas.getContext('2d'), cam, nm, bcode, bfull, pj, brn, age, capic, captext, crew, crewV, crewD,
    session: s, kind: null, view: null, camNo: 0, bootAt: 0, bootDelay: 0, walkIn: false, leaveAt: 0, dead: false, switchAt: 0, attnUntil: 0,
    wideUntil: wideMem[s.id] || 0, layer: {}, anim: null, moving: false, bootStatic: 380,
    visible: true, lw: 0, lh: 0, rect: null, placed: false, iconKind: null,
  };
  root.__tile = t;
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    setCursor(t.id);
    if (selected === t.id) select(null); else select(t.id);
  });
  grid.append(root);
  io.observe(root);
  return t;
}

function applyClass(t) {
  const s = t.session;
  const now = performance.now();
  let c = `tile ${s.tool} ${t.leaveAt ? 'leaving' : s.status} k-${t.view || t.kind}`;
  if (t.id === selected) c += ' sel';
  if (t.id === cursorId) c += ' kcur';
  if (t.attnUntil > now && !reduce) c += ' attn';
  if (t.moving) c += ' moving';
  if (!t.placed) c += ' unplaced';
  if (t.root.className !== c) t.root.className = c;
}

function captionOf(s, tight) {
  if (s.status === 'waiting') return tight ? 'NEEDS YOU' : 'WAITING FOR YOU';
  return s.activity?.label || (s.status === 'idle' ? 'Idle' : 'Working');
}
function crewTally(s) {
  const subs = s.subagents || [];
  let done = 0, failed = 0;
  for (const x of subs) { if (x.status === 'done') done++; else if (x.status === 'failed') failed++; }
  return { n: subs.length, done, failed, working: subs.length - done - failed };
}

// What room a session is shown in. A session that has run a crew keeps the conference room (and its
// two-column tile) for WIDE_LINGER_MS after the last subagent is gone, so the wall does not re-flow
// every time a crew comes and goes.
function kindOf(t, s) {
  if (s.status === 'idle') { t.wideUntil = 0; return 'break'; }
  const orch = s.mode === 'orchestrator' && (s.subagents || []).length > 0;
  if (orch) t.wideUntil = Date.now() + WIDE_LINGER_MS;
  return orch || t.wideUntil > Date.now() ? 'conf' : 'desk';
}

function updateTile(t, s, now) {
  const prev = t.session;
  const known = !!t.kind;
  t.session = s;
  t.kind = kindOf(t, s);
  if (s.status === 'waiting' && prev && prev.status !== 'waiting' && known) {
    t.attnUntil = now + 1150;
    setTimeout(() => applyClass(t), 1200);
  }
  if (s.status === 'waiting' && (!prev || prev.status !== 'waiting' || !known)) t.root.style.setProperty('--ad', `${-(Date.now() % 800)}ms`);
  paintTile(t);
}

// Everything on a tile that is text or state (the picture is drawn by drawTile).
function paintTile(t) {
  const s = t.session;
  const info = toolInfo(s.tool);
  setText(t.cam, `CAM ${pad2(t.camNo)}`);
  setText(t.nm, s.name || '???');
  setText(t.bcode, info.code);
  setText(t.bfull, info.label);
  setText(t.pj, s.project || s.cwd || '~');
  setText(t.brn, s.branch ? ` · ${s.branch}` : '');
  const tight = !!geo && geo.sz === 'xs';
  setText(t.captext, t.leaveAt ? (tight ? 'LEFT' : 'LEFT THE BUILDING') : captionOf(s, tight));
  const title = `${s.name} (${info.label}) — ${s.title || 'untitled'}\n${whereOf(s)}`;
  if (t.root.title !== title) t.root.title = title;
  let crew = '', crewMore = '', crewCls = 'crew';
  if ((t.view || t.kind) === 'conf' && !t.leaveAt) {
    const c = crewTally(s);
    if (!c.n) { crew = 'DISMISSED'; crewCls = 'crew off'; }
    else { crew = `${c.done}/${c.n}`; crewMore = ' DONE'; if (c.failed) { crewMore += ` · ${c.failed} FAILED`; crewCls = 'crew bad'; } else if (c.done === c.n) crewCls = 'crew ok'; }
  }
  setText(t.crewV, crew);
  setText(t.crewD, crewMore);
  if (t.crew.className !== crewCls) t.crew.className = crewCls;
  t.crew.hidden = !crew;
  const ik = s.status === 'waiting' ? 'waiting' : s.activity?.kind || 'thinking';
  if (ik !== t.iconKind) { t.iconKind = ik; art.drawIconCanvas(t.capic, ik, s.status === 'waiting' ? '#fff' : '#dfe2ee'); }
  const c = crewTally(s);
  const aria = `Camera ${t.camNo}, ${s.name}, ${info.label}, ${s.status === 'waiting' ? 'needs you' : s.status}, ${captionOf(s)}${c.n ? `, crew ${c.done} of ${c.n} done` : ''}`;
  if (t.aria !== aria) { t.aria = aria; t.root.setAttribute('aria-label', aria); }
  applyClass(t);
}

function ageText(s, short) {
  const age = serverNow() - s.lastActivityAt;
  if (short) return fmtShort(age);
  if (s.status === 'working') return fmtAge(age);
  if (s.status === 'waiting') return `WAIT ${fmtAge(age)}`;
  return `${fmtAge(age)} AGO`;
}

/* ------------------------------------------------------------------ feed */
// Demo-only knobs. ?mock=1&n=40 (or n=0, n=1) resizes the mock roster so the wall can be judged at any head
// count; clones keep their id for the whole run, so the only arrivals and departures are the mock's own.
// window.__cctv.drop('NAME') / .undrop('NAME') make one demo agent leave / come back.
const forceN = new URLSearchParams(location.search).has('n') ? Math.max(0, Number(new URLSearchParams(location.search).get('n')) | 0) : null;
const EXTRA_NAMES = ['ABE', 'BEA', 'CAL', 'DEE', 'ELI', 'FAY', 'GIL', 'HAL', 'IDA', 'JAX', 'KAI', 'LEO', 'MAE', 'NED', 'ORA', 'PAZ', 'QUIN', 'RAE', 'SAM', 'TESS', 'UMA', 'VAL', 'WES', 'XAN', 'YUL', 'ZOE'];
const roster = []; // [{ base, k, name }] — entries are never reshuffled
const dropped = new Set();
let mutate = null; // demo only: window.__cctv.mutate = (session) => session, to stage edge cases (long names, big crews)
function resizeRoster(st) {
  if (!st.mock || (forceN == null && !dropped.size && !mutate)) return st;
  const base = st.sessions || [];
  let out = base;
  if (forceN != null) {
    const byId = new Map(base.map((s) => [s.id, s]));
    const live = roster.filter((e) => byId.has(e.base));
    for (const s of base) {
      if (live.length >= forceN) break;
      if (!roster.some((e) => e.base === s.id)) { const e = { base: s.id, k: 0 }; roster.push(e); live.push(e); }
    }
    for (let guard = 0; live.length < forceN && base.length && guard < 500; guard++) {
      let best = null, bestN = Infinity;
      for (const s of base) { const n = roster.filter((e) => e.base === s.id).length; if (n < bestN) { bestN = n; best = s; } }
      const e = { base: best.id, k: bestN, name: EXTRA_NAMES[roster.filter((x) => x.k > 0).length % EXTRA_NAMES.length] };
      roster.push(e); live.push(e);
    }
    out = live.slice(0, forceN).map((e) => {
      const b = byId.get(e.base);
      return e.k === 0 ? b : { ...b, id: `${b.id}~${e.k}`, nativeId: `${b.nativeId}~${e.k}`, name: e.name, startedAt: b.startedAt + e.k * 1000 };
    });
  }
  if (dropped.size) out = out.filter((s) => !dropped.has(s.name));
  if (mutate) out = out.map((s) => mutate({ ...s, subagents: [...(s.subagents || [])] }) || s);
  return { ...st, sessions: out };
}

function onState(st) {
  const now = performance.now();
  st = resizeRoster(st);
  state = st;
  skew = (st.now || Date.now()) - Date.now();
  const seen = new Set();
  const sessions = [...(st.sessions || [])].sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : 1));
  let i = 0;
  for (const s of sessions) {
    seen.add(s.id);
    let t = tiles.get(s.id);
    if (!t) {
      t = createTile(s);
      t.camNo = ++camSeq;
      // First load: every feed is simply there, powering on in a quick ripple. Later arrivals walk in.
      t.bootDelay = firstState ? 80 + Math.min(i * 40, 520) : 0;
      t.walkIn = !firstState;
      tiles.set(s.id, t);
    } else if (t.leaveAt) {
      t.leaveAt = 0; t.dead = false; t.bootAt = now; t.bootStatic = 380; t.walkIn = true;
    }
    updateTile(t, s, now);
    i++;
  }
  for (const t of tiles.values()) {
    if (!seen.has(t.id) && !t.leaveAt) { t.leaveAt = now; paintTile(t); }
  }
  firstState = false;
  updateHeader();
  relayout();
  updateAges();
  saveWide();
  if (selected) updateConsole();
  checkPending();
}

function onMode(m) {
  const node = $('mode');
  node.className = `mode ${m}`;
  setText(node, m === 'live' ? 'LIVE' : m === 'mock' ? 'DEMO' : m === 'reconnecting' ? 'RECONNECTING' : 'CONNECTING');
}

/* ---------------------------------------------------------------- header */
const toolCountEls = {};
(function buildToolCounts() {
  const box = $('toolcounts');
  for (const tool of TOOLS) {
    const c = el('span', `cnt ${tool}`);
    c.title = toolInfo(tool).label;
    const b = el('b', null, '0');
    c.append(el('i'), el('span', 't-full', toolInfo(tool).label), el('span', 't-code', toolInfo(tool).code), b);
    box.append(c);
    toolCountEls[tool] = { box: c, n: b };
  }
})();

function liveSessions() {
  return state ? state.sessions || [] : [];
}
// Wall order is arrival order (the CAM number) and never changes with status: a feed keeps its place for as
// long as it is on the wall, a newcomer takes the next free monitor, and nobody has to move for it.
function orderedTiles() {
  return [...tiles.values()].sort((a, b) => a.camNo - b.camNo);
}
function waitingTiles() {
  return orderedTiles().filter((t) => !t.leaveAt && t.session.status === 'waiting');
}

function updateHeader() {
  const ss = liveSessions();
  setText($('n-total'), ss.length);
  setText($('l-total'), ss.length === 1 ? 'AGENT' : 'AGENTS');
  for (const tool of TOOLS) {
    const n = ss.filter((s) => s.tool === tool).length;
    setText(toolCountEls[tool].n, n);
    toolCountEls[tool].box.classList.toggle('zero', n === 0);
  }
  const n = (st) => ss.filter((s) => s.status === st).length;
  setText($('n-working'), n('working'));
  setText($('n-idle'), n('idle'));
  const w = n('waiting');
  setText($('n-waiting'), w);
  $('needs').classList.toggle('on', w > 0);
  let crew = 0;
  for (const s of ss) for (const x of s.subagents || []) if (x.status === 'working') crew++;
  setText($('n-crew'), crew);
  $('crewcount').hidden = crew === 0;
  document.title = w > 0 ? `(${w}) NEEDS YOU — CCTV Wall` : 'Agent Office — CCTV Wall';
  $('empty').hidden = tiles.size > 0;
}

function updateAges() {
  setText($('clock'), clockStr(new Date()));
  const short = geo && (geo.sz === 'sm' || geo.sz === 'xs');
  for (const t of tiles.values()) if (!t.leaveAt) setText(t.age, ageText(t.session, short));
  if (selected) {
    const t = tiles.get(selected);
    if (t) { setText($('big-age'), t.leaveAt ? 'SIGNAL LOST' : `${clockStr(new Date())} · ${t.session.status === 'working' ? 'ACTIVE ' : ''}${ageText(t.session)}`); setText($('c-age'), t.leaveAt ? 'gone' : `${fmtAge(serverNow() - t.session.lastActivityAt)} ago`); }
  }
}
setInterval(updateAges, 1000);

/* ---------------------------------------------------------------- layout */
function pack(items, cols) {
  const occ = []; // rows of booleans
  const pos = new Map();
  const free = (r, c) => !(occ[r] && occ[r][c]);
  for (const it of items) {
    const span = Math.min(it.span, cols);
    let placed = false;
    for (let r = 0; !placed; r++) {
      for (let c = 0; c + span <= cols; c++) {
        let ok = true;
        for (let k = 0; k < span; k++) if (!free(r, c + k)) ok = false;
        if (!ok) continue;
        occ[r] = occ[r] || [];
        for (let k = 0; k < span; k++) occ[r][c + k] = true;
        pos.set(it.id, { r, c, span });
        placed = true;
        break;
      }
    }
  }
  return { pos, rows: occ.length, occ };
}

// What a tile shows is decided by its column width:
//   xl >=340  name, full tool name, CAM no, REC, project · branch, full age, caption (chrome x1.5; x2 from 460)
//   lg >=236  the same at x1
//   md >=180  name, tool code, REC, project, full age, caption
//   sm >=140  name, tool code, project, short age, caption
//   xs  <140  name, tool code, caption
// The needs-you alarm (red caption, flashing frame, NEEDS YOU stamp) is shown at every size.
const sizeTier = (cw) => (cw >= 340 ? 'xl' : cw >= 236 ? 'lg' : cw >= 180 ? 'md' : cw >= 140 ? 'sm' : 'xs');
const chromeScale = (cw) => (cw >= 460 ? 2 : cw >= 340 ? 1.5 : 1);
const capH = (cw) => (cw < 140 ? 17 : Math.round(20 * chromeScale(cw)));

function computeLayout(items, W, H, strip) {
  const minCol = strip ? 88 : 118; // smallest tile we accept before the wall starts to scroll
  const comfyCol = strip ? 96 : W < 520 ? 150 : 164; // tile size used once it has to scroll anyway
  // A feed never grows past a comfortable size: a handful of sessions is shown as a centred bank of
  // monitors (the spare ones on standby), not as two or three giant tiles.
  const maxCol = strip ? 240 : W < 700 ? W : Math.max(320, Math.min(560, Math.round(W / 3.5)));
  const tileH = (cw) => Math.ceil(((cw - 4) * 62) / 86) + 1 + capH(cw) + 4; // picture keeps the diorama's 86:62 so the pixel scale is set by width
  const maxCols = Math.max(1, Math.floor((W + GAP) / (minCol + GAP)));
  let best = null, fallback = null;
  let fits = [];
  let used = 0;
  for (const it of items) used += it.span;
  for (let cols = 1; cols <= Math.min(maxCols, 14); cols++) {
    const cwW = Math.min(maxCol, Math.floor((W - GAP * (cols - 1)) / cols));
    const p = pack(items, cols);
    const rows = Math.max(1, p.rows);
    // widest column whose rows still fit the height (the grid is then centred with side margins)
    const maxTh = Math.floor((H - (rows - 1) * GAP) / rows);
    let cwH = Math.min(maxCol, Math.floor(((maxTh - 26) * 86) / 62) + 6);
    while (cwH > 40 && tileH(cwH) > maxTh) cwH--;
    const cw = Math.min(cwW, cwH);
    const over = { cols, cw: cwW, th: tileH(cwW), ...p };
    if (!fallback || cwW >= comfyCol) fallback = over; // most columns at a comfortable size = least scrolling
    if (cw >= minCol) {
      const th = tileH(cw);
      fits.push({ cols, cw, th, spare: cols * Math.max(rows, Math.floor((H + GAP) / (th + GAP))) - used, ...p });
    }
  }
  // A grid is picked with a monitor to spare, so the very next arrival does not immediately force every
  // tile to change size (and there is always a free monitor to click for DISPATCH).
  const roomy = fits.filter((c) => c.spare >= SPARE_CELLS);
  if (roomy.length) fits = roomy;
  // biggest tiles win; among near-ties (within 6%) take the most columns so the wall fills its width
  const maxCw = Math.max(0, ...fits.map((c) => c.cw));
  for (const c of fits) if (c.cw >= maxCw * 0.94 && (!best || c.cols > best.cols)) best = c;
  return best || fallback;
}

function sizeCanvas(canvas, cssW, cssH, kind) {
  const dpr = window.devicePixelRatio || 1;
  const [mw, mh] = art.MIN_VIEW[kind] || art.MIN_VIEW.desk;
  const fit = Math.min((cssW * dpr) / mw, (cssH * dpr) / mh);
  let css;
  if (fit >= 1) css = Math.floor(fit) / dpr; else css = fit / dpr;
  if (dpr === 1 && fit >= 1.5 && fit < 2) css = 1.5;
  const lw = Math.max(8, Math.ceil(cssW / css)), lh = Math.max(8, Math.ceil(cssH / css));
  if (canvas.width !== lw) canvas.width = lw;
  if (canvas.height !== lh) canvas.height = lh;
  canvas.style.width = `${lw * css}px`;
  canvas.style.height = `${lh * css}px`;
  canvas.style.left = `${Math.round((cssW - lw * css) / 2)}px`;
  canvas.style.top = `${cssH - lh * css}px`;
  return [lw, lh, css];
}

function layoutInput() {
  const W = wall.clientWidth - 16, H = wall.clientHeight - 16;
  const ordered = orderedTiles().filter((t) => !t.dead);
  const items = ordered.map((t) => ({ id: t.id, span: t.kind === 'conf' ? 2 : 1, kind: t.kind }));
  const strip = !!selected;
  const box = `${W}x${H}|${strip}|${window.devicePixelRatio}`;
  const sig = `${box}|${items.map((i) => `${i.id}:${i.kind}`).join(',')}`;
  return { W, H, ordered, items, strip, box, sig };
}

// The grid (columns, tile size) is sticky: it is kept for as long as everybody still fits in it, because
// changing it resizes every tile on the wall. It shrinks the moment it must, and grows back only after the
// roster has been comfortably smaller for GROW_SETTLE_MS.
function chooseGrid(items, W, H, strip, box) {
  const ideal = computeLayout(items, W, H, strip);
  // rows that fit at the base height share the wall's height (up to +16%), so adding a row later changes nothing
  const R = Math.max(ideal.rows, Math.floor((H + GAP) / (ideal.th + GAP)), 1);
  let th = ideal.th;
  if (R * (ideal.th + GAP) - GAP <= H) th = Math.min(Math.floor((H - (R - 1) * GAP) / R), Math.round(ideal.th * 1.16));
  let g = { cols: ideal.cols, cw: ideal.cw, th }, p = ideal;
  const m = gridMem;
  regridAt = 0;
  if (m && m.box === box) {
    const pk = pack(items, m.cols);
    if (Math.max(1, pk.rows) * (m.th + GAP) - GAP <= H) {
      const now = performance.now();
      const better = g.cw > m.cw * 1.25;
      if (!better) m.betterSince = 0; else if (!m.betterSince) m.betterSince = now;
      if (!better || now - m.betterSince < GROW_SETTLE_MS) { g = m; p = pk; if (better) regridAt = m.betterSince + GROW_SETTLE_MS; }
    }
  }
  if (g !== m) gridMem = { box, cols: g.cols, cw: g.cw, th: g.th, betterSince: 0 };
  return { cols: g.cols, cw: g.cw, th: g.th, pos: p.pos, occ: p.occ, rows: p.rows };
}

// Pure geometry for the current roster: a rect per tile and the list of spare cells.
function buildPlan({ W, H, items, strip, box }) {
  const L = chooseGrid(items, W, H, strip, box);
  const { cols, cw, th } = L;
  const usedW = cols * cw + (cols - 1) * GAP;
  const offX = Math.max(0, Math.floor((W - usedW) / 2));
  const rowsVisible = Math.max(L.rows, Math.floor((H + GAP) / (th + GAP)), 1);
  const totalH = rowsVisible * th + (rowsVisible - 1) * GAP;
  const offY = L.rows * (th + GAP) - GAP <= H ? Math.max(0, Math.floor((H - totalH) / 2)) : 0;
  const rects = new Map();
  for (const it of items) {
    const p = L.pos.get(it.id);
    if (p) rects.set(it.id, { x: offX + p.c * (cw + GAP), y: offY + p.r * (th + GAP), w: p.span * cw + (p.span - 1) * GAP, h: th });
  }
  const free = [];
  for (let r = 0; r < rowsVisible; r++) {
    for (let c = 0; c < cols; c++) {
      if (!(L.occ[r] && L.occ[r][c])) free.push({ key: `${r}:${c}`, r, c, x: offX + c * (cw + GAP), y: offY + r * (th + GAP) });
    }
  }
  return { cols, cw, th, rects, free, freeKeys: new Set(free.map((f) => f.key)), gridH: Math.max(totalH + offY, 0), f: chromeScale(cw), capPx: capH(cw), sz: sizeTier(cw) };
}

const sameRect = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

// The single entry point for "the wall may need to change". It never animates a container resize or the
// first layout, applies pure additions/removals at once, and batches everything that makes tiles move.
function relayout() {
  const inp = layoutInput();
  if (inp.W <= 0 || inp.H <= 0) return;
  const now = performance.now();
  const boxChanged = inp.box !== lastBox;
  if (!boxChanged && inp.sig === layoutSig && !(regridAt && now >= regridAt)) return;
  const prevMem = gridMem;
  const plan = buildPlan(inp);
  if (reduce || boxChanged || !layoutSig) { commit(plan, inp, 'instant'); return; }
  const regrid = !!geo && (plan.cw !== geo.cw || plan.th !== geo.th || plan.cols !== geo.cols);
  const moves = regrid || inp.ordered.some((t) => t.placed && !sameRect(t.rect, plan.rects.get(t.id)));
  if (!moves) { commit(plan, inp, 'instant'); return; }
  // Tiles have to move. Wait out the rest period, and any walk-out still playing, so that several changes
  // close together (a crew forming while somebody leaves) land as one coordinated move.
  let wait = Math.max(0, restUntil - now);
  for (const t of tiles.values()) if (t.leaveAt && !t.dead) wait = Math.max(wait, t.leaveAt + WALK_MS + NOSIGNAL_MS + 60 - now);
  clearTimeout(layoutTimer);
  if (wait > 0) { gridMem = prevMem; layoutTimer = setTimeout(relayout, Math.min(wait, 4000)); return; }
  commit(plan, inp, regrid ? 'resync' : 'move');
}

// Sliding tiles must not pass over anything. Any slide whose path would touch another tile becomes a
// hop (fade out, reappear in place) instead.
function settleSlides(jobs) {
  const at = (j, p) => ({ x: j.from.x + (j.to.x - j.from.x) * p + 1, y: j.from.y + (j.to.y - j.from.y) * p + 1, w: j.to.w - 2, h: j.to.h - 2 });
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let again = true; again;) {
    again = false;
    const sliders = jobs.filter((j) => j.mode === 'slide'), still = jobs.filter((j) => j.mode === 'stay');
    for (const j of sliders) {
      let bad = false;
      for (let k = 1; k < 8 && !bad; k++) {
        const a = at(j, k / 8);
        bad = still.some((o) => hit(a, at(o, 1))) || sliders.some((o) => o !== j && o.mode === 'slide' && hit(a, at(o, k / 8)));
      }
      if (bad) { j.mode = 'hop'; again = true; }
    }
  }
}

function fitCanvas(t, plan) {
  const picW = t.rect.w - 4, picH = t.rect.h - 4 - plan.capPx;
  const key = `${picW}x${picH}:${t.view}:${window.devicePixelRatio}:${plan.sz}`;
  if (t.sizeKey === key) return;
  t.sizeKey = key;
  let css;
  [t.lw, t.lh, css] = sizeCanvas(t.canvas, picW, picH, t.view);
  t.safeBottom = plan.sz === 'xs' ? 0 : Math.ceil((20 * plan.f) / css); // logical rows hidden behind the bottom overlay text
  drawTile(t, performance.now());
}

function commit(plan, inp, mode0) {
  const now = performance.now();
  const animate = mode0 === 'move';
  clearTimeout(layoutTimer);
  layoutTimer = 0;
  geo = plan;
  layoutSig = inp.sig;
  lastBox = inp.box;
  grid.style.height = `${plan.gridH}px`;
  if (grid.dataset.sz !== plan.sz) { grid.dataset.sz = plan.sz; for (const t of tiles.values()) paintTile(t); }
  grid.style.setProperty('--f', plan.f);

  // tiles whose agent has left and whose NO SIGNAL has played out are taken off the wall here
  for (const t of [...tiles.values()]) {
    if (!t.dead) continue;
    tiles.delete(t.id);
    io.unobserve(t.root);
    if (cursorId === t.id) cursorId = null;
    t.anim?.cancel();
    if (reduce) { t.root.remove(); continue; }
    const a = t.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MOVE_MS * 0.25, fill: 'forwards' });
    a.onfinish = () => t.root.remove();
    setTimeout(() => t.root.remove(), 2000);
  }

  const jobs = [];
  for (const t of inp.ordered) {
    const to = plan.rects.get(t.id);
    if (!to) continue;
    const from = t.placed ? t.rect : null;
    let mode = 'stay';
    if (!from) mode = 'new';
    else if (from.w !== to.w || from.h !== to.h) mode = 'hop';
    else if (from.x !== to.x || from.y !== to.y) mode = from.y === to.y && Math.abs(from.x - to.x) <= 2 * (plan.cw + GAP) + 1 ? 'slide' : 'hop';
    jobs.push({ t, from: from || to, to, mode });
  }
  if (animate) settleSlides(jobs);

  let moved = false;
  for (const { t, from, to, mode } of jobs) {
    if (t.anim) { t.anim.cancel(); t.anim = null; }
    if (t.moving) t.moving = false;
    const r = t.rect;
    if (!r || r.w !== to.w || r.h !== to.h) { t.root.style.width = `${to.w}px`; t.root.style.height = `${to.h}px`; }
    // placed with the `translate` property (not `transform`) so the needs-you wiggle scales about the tile's own centre
    if (!r || r.x !== to.x || r.y !== to.y) t.root.style.translate = `${to.x}px ${to.y}px`;
    t.rect = to;
    t.placed = true;
    if (mode === 'new') { t.bootAt = now + (animate ? MOVE_MS * 0.75 : t.bootDelay); t.bootDelay = 0; t.bootStatic = 380; }
    // The whole grid changed size: no travel at all, every monitor re-syncs in place in a quick ripple.
    else if (mode0 === 'resync') { t.bootAt = now + 30 + Math.min(jobs.findIndex((j) => j.t === t) * 22, 330); t.bootStatic = 0; }
    if (t.view !== t.kind) {
      if (t.view && now - t.bootAt > 800) t.switchAt = now; // a burst of static covers the change of room
      t.view = t.kind;
      paintTile(t);
    }
    fitCanvas(t, plan);
    if (animate && mode !== 'stay') {
      const T0 = `${from.x}px ${from.y}px`, T1 = `${to.x}px ${to.y}px`;
      let frames;
      if (mode === 'new') frames = [{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }];
      else if (mode === 'slide') frames = [{ translate: T0 }, { translate: T0, offset: 0.25, easing: 'cubic-bezier(.4, 0, .2, 1)' }, { translate: T1, offset: 0.75 }, { translate: T1 }];
      else {
        const S0 = { translate: T0, width: `${from.w}px`, height: `${from.h}px` }, S1 = { translate: T1, width: `${to.w}px`, height: `${to.h}px` };
        frames = [{ ...S0, opacity: 1 }, { ...S0, opacity: 0, offset: 0.25, easing: 'step-end' }, { ...S1, opacity: 0, offset: 0.75 }, { ...S1, opacity: 1 }];
      }
      if (mode !== 'new') { moved = true; t.moving = mode === 'slide'; }
      const a = t.root.animate(frames, { duration: MOVE_MS });
      t.anim = a;
      a.onfinish = a.oncancel = () => { if (t.anim === a) { t.anim = null; t.moving = false; applyClass(t); } };
    }
    applyClass(t);
  }
  if (moved || mode0 === 'resync') restUntil = now + MOVE_MS + MOVE_REST_MS;

  placeSlots(plan, animate);
  updateAges();
}

/* -------------------------------------------------------- standby monitors */
// Every grid cell without an agent is a monitor on standby: a camera on an empty room, a test card, a spare
// input. They are dimmed, carry no name badge, and clicking one opens DISPATCH.
function createSlot(key) {
  const root = el('div', 'slot');
  root.setAttribute('role', 'button');
  root.tabIndex = -1;
  const pic = el('div', 'pic');
  const canvas = el('canvas');
  const hint = el('div', 'slot-hint', '+ DISPATCH AGENT');
  hint.setAttribute('aria-hidden', 'true');
  pic.append(canvas, el('div', 'crt'), hint);
  const cap = el('div', 'cap');
  const label = el('span', 'captext');
  cap.append(label, el('span', 'free', 'FREE'));
  root.append(pic, cap);
  const sl = { key, root, canvas, g: canvas.getContext('2d'), label, layer: {}, kind: '', seed: art.hash(key), lw: 0, lh: 0, sizeKey: '', visible: true, on: false };
  root.__slot = sl;
  grid.prepend(root);
  io.observe(root);
  slots.set(key, sl);
  return sl;
}

function placeSlots(plan, animate) {
  for (const f of plan.free) {
    const sl = slots.get(f.key) || createSlot(f.key);
    const kind = art.STANDBY[(f.c + f.r * 3) % art.STANDBY.length];
    if (sl.kind !== kind) {
      sl.kind = kind;
      sl.root.className = `slot v-${kind}`;
      setText(sl.label, art.STANDBY_LABEL[kind] || 'STANDBY');
      sl.root.setAttribute('aria-label', `Free monitor (${(art.STANDBY_LABEL[kind] || 'standby').toLowerCase()}). Dispatch an agent.`);
    }
    sl.root.style.translate = `${f.x}px ${f.y}px`;
    sl.root.style.width = `${plan.cw}px`;
    sl.root.style.height = `${plan.th}px`;
    const picW = plan.cw - 4, picH = plan.th - 4 - plan.capPx;
    const key = `${picW}x${picH}:${window.devicePixelRatio}`;
    if (sl.sizeKey !== key) { sl.sizeKey = key; [sl.lw, sl.lh] = sizeCanvas(sl.canvas, picW, picH, 'standby'); sl.layer.shown = null; }
    sl.on = true;
    sl.root.hidden = false;
    drawSlot(sl);
  }
  for (const sl of slots.values()) {
    if (plan.freeKeys.has(sl.key) || !sl.on) continue;
    sl.on = false;
    // during a re-flow the monitor underneath stays lit until the arriving tile has faded in over it
    if (animate) setTimeout(() => { if (!sl.on) sl.root.hidden = true; }, MOVE_MS);
    else sl.root.hidden = true;
  }
}

function drawSlot(sl) {
  if (!sl.lw) return;
  art.renderStandby(sl.g, sl.lw, sl.lh, { kind: sl.kind, seed: sl.seed, tick, time: Date.now(), reduce }, sl.layer);
}

new ResizeObserver(() => { relayout(); sizeBig(); }).observe(wall);
addEventListener('resize', () => { relayout(); sizeBig(); });

/* ---------------------------------------------------------------- render */
function viewFor(t, now) {
  const v = { session: t.session, kind: t.view, tick, reduce, safeBottom: t.safeBottom };
  const b = now - t.bootAt;
  if (!reduce) {
    if (b < 0) v.fx = 'off';
    else if (b < 260) { v.fx = 'on'; v.fxp = b / 260; }
    else if (b < 260 + t.bootStatic) { v.fx = 'static'; v.fxp = 1 - (b - 260) / t.bootStatic; }
  }
  if (t.walkIn) {
    const p = (b - 520) / WALK_MS;
    if (p < 1) v.walk = { dir: 'in', p: Math.max(0, p) }; else t.walkIn = false;
  }
  if (t.leaveAt) {
    const p = (now - t.leaveAt) / WALK_MS;
    if (p < 1) v.walk = { dir: 'out', p }; else v.fx = 'nosignal';
  } else if (t.switchAt && now - t.switchAt < 340) {
    v.fx = 'static'; v.fxp = 1 - ((now - t.switchAt) / 340) * 0.7;
  }
  return v;
}

function drawTile(t, now) {
  if (!t.lw) return;
  art.renderFeed(t.g, t.lw, t.lh, viewFor(t, now), t.layer);
}

const big = { canvas: $('bigcanvas'), g: $('bigcanvas').getContext('2d'), lw: 0, lh: 0, key: '', hits: [], css: 1, layer: {} };
function sizeBig() {
  if (!selected) return;
  const t = tiles.get(selected);
  if (!t) return;
  const pic = $('bigpic');
  const stage = $('stage');
  const w = stage.clientWidth - 12;
  if (w <= 0) return;
  // The monitor takes the diorama's own aspect (wide for a conference room), capped so the console keeps its room.
  const kind = t.view || t.kind;
  const [mw, mh] = art.MIN_VIEW[kind] || art.MIN_VIEW.desk;
  // on a short stage the monitor takes half, so identity + transmission + actions (and the intercom) still fit
  const sh = stage.clientHeight;
  const maxH = Math.max(120, Math.round(sh * (sh < 760 ? 0.5 : 0.6)) - (sh < 760 ? 30 : 40));
  const h = Math.min(maxH, Math.ceil((w * mh) / mw) + (kind === 'conf' ? 16 : 2));
  const key = `${w}x${h}:${kind}:${window.devicePixelRatio}`;
  if (key === big.key) return;
  big.key = key;
  pic.style.height = `${h}px`;
  [big.lw, big.lh, big.css] = sizeCanvas(big.canvas, w, h, kind);
  big.safeBottom = Math.ceil(34 / big.css);
}
function drawBig(now) {
  const t = tiles.get(selected);
  if (!t) return;
  sizeBig();
  if (!big.lw) return;
  const v = viewFor(t, now);
  v.kind = t.view || t.kind;
  v.hiSub = selSub;
  v.safeBottom = big.safeBottom;
  v.hits = big.hits = [];
  if (!v.fx && now - bigSwitchAt < 300 && !reduce) { v.fx = 'static'; v.fxp = 1 - (now - bigSwitchAt) / 300; }
  art.renderFeed(big.g, big.lw, big.lh, v, big.layer);
  if ((tick & 3) === 0) {
    art.drawPortrait($('portrait'), t.session, null, tick >> 2);
    const su = selSub && (t.session.subagents || []).find((x) => x.id === selSub);
    if (su) art.drawPortrait($('subportrait'), t.session, su, tick >> 2);
  }
}

let lastTick = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (ts - lastTick < 82) return;
  lastTick = ts;
  tick++;
  const now = performance.now();
  let died = false, drawn = 0;
  for (const t of tiles.values()) {
    if (t.leaveAt && !t.dead && now - t.leaveAt > WALK_MS + NOSIGNAL_MS) { t.dead = true; died = true; }
    if (!t.visible || !t.placed) continue; // off-screen feeds are not drawn at all
    // a sleeper in the break room only needs every other frame
    if ((tick & 1) && t.view === 'break' && !t.leaveAt && !t.walkIn && now - t.bootAt > 700 && now - t.switchAt > 400) continue;
    drawTile(t, now);
    drawn++;
  }
  if ((tick & 1) === 0) for (const sl of slots.values()) if (sl.on && sl.visible) { drawSlot(sl); drawn++; }
  if (selected) drawBig(now);
  typeStep();
  perf.last = performance.now() - now;
  perf.ms = perf.ms ? perf.ms * 0.92 + perf.last * 0.08 : perf.last;
  perf.feeds = drawn;
  if (died) {
    if (selected && tiles.get(selected)?.dead) select(null); else relayout();
  }
}
requestAnimationFrame(frame);

window.__cctv = {
  tiles, slots, perf,
  get geo() { return geo; },
  drop(name) { dropped.add(String(name).toUpperCase()); },
  undrop(name) { dropped.delete(String(name).toUpperCase()); },
  set mutate(fn) { mutate = typeof fn === 'function' ? fn : null; },
  // demo only: walk a few more mock agents in (never touches a real session)
  mockAdd(n = 1) { if (feed.mode !== 'mock') return 'demo mode only'; for (let i = 0; i < n; i++) feed.launch({ tool: TOOLS[i % 3], prompt: `Stress agent ${i + 1}`, cwd: '' }); return n; },
};

/* ------------------------------------------------------------- selection */
function setCursor(id) {
  if (cursorId === id) return;
  const old = tiles.get(cursorId);
  cursorId = id;
  if (old) applyClass(old);
  const t = tiles.get(id);
  if (t) { applyClass(t); scrollToTile(t); }
}
function scrollToTile(t) {
  if (!t.rect) return;
  const top = t.rect.y, bottom = t.rect.y + t.rect.h + 16;
  if (top < wall.scrollTop) wall.scrollTo({ top: Math.max(0, top - 8), behavior: reduce ? 'auto' : 'smooth' });
  else if (bottom > wall.scrollTop + wall.clientHeight) wall.scrollTo({ top: bottom - wall.clientHeight + 8, behavior: reduce ? 'auto' : 'smooth' });
}

function select(id) {
  if (id && !tiles.has(id)) id = null;
  const old = tiles.get(selected);
  selected = id;
  selSub = null;
  closePage();
  document.body.classList.toggle('has-sel', !!id);
  if (old) applyClass(old);
  typed.full = null;
  big.key = '';
  bigSwitchAt = performance.now();
  if (id) {
    const t = tiles.get(id);
    cursorId = id;
    for (const x of tiles.values()) applyClass(x);
    updateConsole();
    updateAges();
  }
  relayout();
  if (id) { sizeBig(); requestAnimationFrame(() => { const t = tiles.get(id); if (t) scrollToTile(t); }); }
}

/* --------------------------------------------------------------- console */
const typed = { full: null, n: 0 };
function typeStep() {
  if (typed.full == null) return;
  const node = $('c-msg');
  if (typed.n >= typed.full.length) { node.classList.remove('typing'); return; }
  typed.n = reduce ? typed.full.length : Math.min(typed.full.length, typed.n + 3);
  node.textContent = typed.full.slice(0, typed.n);
  node.classList.toggle('typing', typed.n < typed.full.length);
}

function updateConsole() {
  const t = tiles.get(selected);
  if (!t) return;
  const s = t.session;
  const info = toolInfo(s.tool);
  const stage = $('stage');
  stage.className = s.tool;
  const gone = !!t.leaveAt;
  $('bigmon').className = `bigmon ${gone ? 'leaving' : s.status}`;
  setText($('big-cam'), `CAM ${pad2(t.camNo)}`);
  setText($('big-name'), s.name);
  setText($('big-badge'), info.code);
  setText($('big-where'), whereOf(s));
  setText($('big-cap'), gone ? 'LEFT THE BUILDING' : captionOf(s));
  art.drawIconCanvas($('big-ic'), s.status === 'waiting' ? 'waiting' : s.activity?.kind || 'thinking', '#fff');

  setText($('c-name'), s.name);
  setText($('c-badge'), `${info.code} ${info.label}`);
  const chip = $('c-status');
  chip.className = `chip ${gone ? 'gone' : s.status}`;
  const tally = crewTally(s);
  setText(chip, gone ? 'SIGNAL LOST' : s.status === 'waiting' ? 'NEEDS YOU' : s.status === 'working' ? (tally.working ? 'RUNNING CREW' : 'WORKING') : 'ON BREAK');
  setText($('c-where'), whereOf(s));
  $('c-where').title = s.cwd || '';
  setText($('c-model'), [s.model, s.source && s.source !== 'unknown' ? s.source : '', s.tokens ? `${Math.round(s.tokens / 1000)}k tok` : ''].filter(Boolean).join(' · ') || '—');
  setText($('c-act'), s.activity?.label || '—');
  setText($('c-title'), s.title || '(untitled)');
  $('c-title').title = s.title || '';
  const msg = s.lastMessage || '(nothing said yet)';
  if (typed.full !== msg) { typed.full = msg; typed.n = 0; $('c-msg').textContent = ''; }

  const subs = s.subagents || [];
  $('c-crewbox').hidden = !subs.length;
  if (selSub && !subs.find((x) => x.id === selSub)) selSub = null;
  setText($('c-crewcount'), subs.length ? `${tally.done}/${tally.n} DONE${tally.failed ? ` · ${tally.failed} FAILED` : ''}` : '');
  const list = $('c-crew');
  const have = new Map([...list.children].map((li) => [li.dataset.sub, li]));
  subs.forEach((su, i) => {
    let li = have.get(su.id);
    if (li) have.delete(su.id);
    else {
      li = el('li');
      li.dataset.sub = su.id;
      const b = el('button');
      b.type = 'button';
      b.append(el('span', 's'), el('span', 'n'), el('span', 'l'));
      b.addEventListener('click', () => { selSub = selSub === su.id ? null : su.id; updateConsole(); });
      li.append(b);
    }
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    const b = li.firstChild;
    if (b.className !== su.status) b.className = su.status;
    b.setAttribute('aria-pressed', String(selSub === su.id));
    const mark = b.children[0];
    mark.className = `s ${su.status}`;
    setText(mark, su.status === 'done' ? '✓' : su.status === 'failed' ? '✗' : '');
    setText(b.children[1], su.name || `A${i + 1}`);
    setText(b.children[2], su.label || su.agentType || '');
    b.title = su.label || '';
  });
  for (const li of have.values()) li.remove();
  const det = $('c-subdetail');
  const su = subs.find((x) => x.id === selSub);
  det.classList.toggle('on', !!su);
  if (su) {
    $('c-subtext').replaceChildren(
      el('div', 't', `${su.name || 'Agent'} — ${su.label || ''}`),
      el('div', 'm', `${su.agentType || 'subagent'} · ${su.status === 'working' ? `working ${fmtAge(serverNow() - su.startedAt)}` : su.status === 'done' ? `done, took ${fmtAge((su.endedAt || su.lastActivityAt) - su.startedAt)}` : 'failed'}`),
      el('div', 'm', su.status === 'working' ? `Now: ${su.activity?.label || '—'}` : su.activity?.label || ''),
    );
  } else if (subs.length) {
    $('c-subtext').replaceChildren(el('div', 'm', 'Pick a crew member here or on the monitor to inspect them.'));
  }
  const task = s.taskId && (state?.tasks || []).find((x) => x.id === s.taskId);
  $('b-stop').hidden = !(task && (task.status === 'running' || task.status === 'starting'));
  $('b-stop').dataset.task = task ? task.id : '';
  $('b-page').disabled = gone;
  setText($('page-to'), s.name);
}

$('bigpic').addEventListener('click', (e) => {
  const r = big.canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / big.css, y = (e.clientY - r.top) / big.css;
  const hit = big.hits.find((h) => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
  if (hit) { selSub = selSub === hit.id ? null : hit.id; updateConsole(); }
});

$('b-close').addEventListener('click', () => select(null));
$('b-stop').addEventListener('click', async () => {
  const id = $('b-stop').dataset.task;
  if (!id) return;
  const res = await feed.stop(id);
  toast(res.ok ? 'STOP ORDER SENT' : `STOP FAILED: ${res.error || 'unknown error'}`);
});

/* ------------------------------------------------------- page (intercom) */
function openPage() {
  if (!selected) return;
  $('pageform').hidden = false;
  setText($('page-note'), '');
  $('page-note').className = 'note';
  $('page-text').focus();
}
function closePage() {
  $('pageform').hidden = true;
}
$('b-page').addEventListener('click', () => ($('pageform').hidden ? openPage() : closePage()));
$('page-cancel').addEventListener('click', closePage);
$('page-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('pageform').requestSubmit(); }
});
$('pageform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('page-text').value.trim();
  const note = $('page-note');
  if (!text) { note.className = 'note err'; setText(note, 'Say something first.'); return; }
  const id = selected;
  const name = tiles.get(id)?.session.name || 'agent';
  $('page-send').disabled = true;
  note.className = 'note'; setText(note, 'Transmitting…');
  const res = await feed.message(id, text);
  $('page-send').disabled = false;
  if (res.ok) {
    $('page-text').value = '';
    closePage();
    toast(`PAGE DELIVERED TO ${name}`);
  } else {
    note.className = 'note err';
    setText(note, res.error || 'Could not deliver the page.');
  }
});

/* ------------------------------------------------------------ transcript */
let trToken = 0;
async function openTranscript() {
  const t = tiles.get(selected);
  if (!t) return;
  const s = t.session;
  const ov = $('ov-transcript');
  ov.hidden = false;
  ov.className = `overlay ${s.tool}`;
  setText($('tr-title'), `TRANSCRIPT — ${s.name}`);
  setText($('tr-sub'), s.title || '');
  const list = $('tr-list');
  list.replaceChildren(el('div', 'tr-empty', 'Rewinding the tape…'));
  const token = ++trToken;
  const msgs = await feed.transcript(s.id, 60);
  if (token !== trToken || ov.hidden) return;
  list.replaceChildren();
  if (!msgs || !msgs.length) { list.append(el('div', 'tr-empty', 'Nothing on tape for this agent yet.')); return; }
  for (const m of msgs) {
    const row = el('div', `tr-msg ${m.role}`);
    const who = el('div', 'who', m.role === 'user' ? 'YOU' : m.role === 'assistant' ? s.name : 'TOOL');
    const tm = el('time', null, m.ts ? clockStr(new Date(m.ts)) : '');
    who.append(tm);
    row.append(who, el('div', 'txt', m.text || ''));
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
  list.focus();
}
function closeTranscript() { $('ov-transcript').hidden = true; trToken++; }
$('b-transcript').addEventListener('click', openTranscript);
$('tr-close').addEventListener('click', closeTranscript);
$('ov-transcript').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeTranscript(); });

/* -------------------------------------------------------------- dispatch */
const dp = { tool: 'claude', perm: 'edit' };
function segSelect(box, value) {
  for (const b of box.children) b.setAttribute('aria-checked', String(b.dataset.v === value));
}
function openDispatch() {
  const ov = $('ov-dispatch');
  if (!ov.hidden) return;
  const box = $('dp-tools');
  box.replaceChildren();
  const avail = (tool) => !state || !state.tools || !state.tools[tool] || state.tools[tool].available !== false;
  if (!avail(dp.tool)) dp.tool = TOOLS.find(avail) || dp.tool;
  for (const tool of TOOLS) {
    const b = el('button', tool);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.v = tool;
    b.append(el('i'), el('span', null, toolInfo(tool).label));
    if (!avail(tool)) { b.disabled = true; b.title = `${toolInfo(tool).label} is not installed`; }
    b.addEventListener('click', () => { dp.tool = tool; segSelect(box, tool); });
    box.append(b);
  }
  segSelect(box, dp.tool);
  segSelect($('dp-perm'), dp.perm);
  $('dp-warn').hidden = dp.perm !== 'full';
  const dirs = $('dp-dirs');
  dirs.replaceChildren();
  const recent = (state?.recentDirs || []).slice(0, 12);
  const cwdIn = $('dp-cwd');
  const selCwd = tiles.get(selected)?.session.cwd;
  if (!cwdIn.value) cwdIn.value = selCwd || recent[0] || '';
  for (const d of recent) {
    const parts = d.split('/').filter(Boolean);
    const b = el('button', null, parts.slice(-2).join('/') || d);
    b.type = 'button';
    b.title = d;
    b.addEventListener('click', () => { cwdIn.value = d; });
    dirs.append(b);
  }
  setText($('dp-note'), '');
  $('dp-note').className = 'note';
  ov.hidden = false;
  $('dp-prompt').focus();
}
function closeDispatch() { $('ov-dispatch').hidden = true; }
for (const b of $('dp-perm').children) {
  b.addEventListener('click', () => { dp.perm = b.dataset.v; segSelect($('dp-perm'), dp.perm); $('dp-warn').hidden = dp.perm !== 'full'; });
}
$('dispatch').addEventListener('click', openDispatch);
$('empty-dispatch').addEventListener('click', openDispatch);
$('dp-close').addEventListener('click', closeDispatch);
$('ov-dispatch').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDispatch(); });
$('dp-prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('dispatch-form').requestSubmit(); }
});
$('dispatch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('dp-note');
  const prompt = $('dp-prompt').value.trim();
  const cwd = $('dp-cwd').value.trim();
  if (!prompt) { note.className = 'note err'; setText(note, 'Write the orders first.'); $('dp-prompt').focus(); return; }
  $('dp-start').disabled = true;
  note.className = 'note'; setText(note, 'Dispatching…');
  const res = await feed.launch({ tool: dp.tool, prompt, cwd, permission: dp.perm });
  $('dp-start').disabled = false;
  if (!res.ok) { note.className = 'note err'; setText(note, res.error || 'Launch failed.'); return; }
  $('dp-prompt').value = '';
  closeDispatch();
  pendingTask = { id: res.task?.id, sessionId: res.task?.sessionId, until: Date.now() + 90_000 };
  toast(`${toolInfo(dp.tool).label} UNIT DISPATCHED — FEED COMING ONLINE`);
  checkPending();
});

function checkPending() {
  if (!pendingTask) return;
  if (Date.now() > pendingTask.until) { pendingTask = null; return; }
  let sid = pendingTask.sessionId;
  if (!sid || !tiles.has(sid)) {
    const task = (state?.tasks || []).find((x) => x.id === pendingTask.id);
    if (task?.sessionId) sid = task.sessionId;
    if (!sid || !tiles.has(sid)) {
      const s = liveSessions().find((x) => x.taskId && x.taskId === pendingTask.id);
      if (s) sid = s.id;
    }
  }
  if (sid && tiles.has(sid)) {
    pendingTask = null;
    select(sid);
  }
}

let toastTimer = 0;
function toast(text) {
  const node = $('toast');
  setText(node, text);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

/* ------------------------------------------------------------ needs you */
$('needs').addEventListener('click', cycleNeeds);
function cycleNeeds() {
  const w = waitingTiles();
  if (!w.length) { toast('NOBODY NEEDS YOU RIGHT NOW'); return; }
  let i = w.findIndex((t) => t.id === selected);
  i = i >= 0 ? (i + 1) % w.length : (needIdx + 1) % w.length;
  needIdx = i;
  setCursor(w[i].id);
  select(w[i].id);
}

/* -------------------------------------------------------------- keyboard */
function moveCursor(dx, dy) {
  const list = orderedTiles().filter((t) => t.rect);
  if (!list.length) return;
  const cur = tiles.get(cursorId);
  if (!cur || !cur.rect) { setCursor(list[0].id); return; }
  const cxp = cur.rect.x + cur.rect.w / 2, cyp = cur.rect.y + cur.rect.h / 2;
  let best = null, bestScore = Infinity;
  for (const t of list) {
    if (t === cur) continue;
    const r = t.rect;
    let ddx, ddy;
    if (dx) {
      // compare against the nearest point of the candidate on the cross axis so wide tiles are reachable
      ddx = (r.x + r.w / 2) - cxp;
      ddy = cyp < r.y ? r.y - cyp : cyp > r.y + r.h ? cyp - (r.y + r.h) : 0;
      if (Math.sign(ddx) !== dx || Math.abs(ddx) < 4) continue;
      const score = Math.abs(ddx) + ddy * 4;
      if (score < bestScore) { bestScore = score; best = t; }
    } else {
      ddy = (r.y + r.h / 2) - cyp;
      ddx = cxp < r.x ? r.x - cxp : cxp > r.x + r.w ? cxp - (r.x + r.w) : 0;
      if (Math.sign(ddy) !== dy || Math.abs(ddy) < 4) continue;
      const score = Math.abs(ddy) + ddx * 4;
      if (score < bestScore) { bestScore = score; best = t; }
    }
  }
  if (best) {
    setCursor(best.id);
    if (selected) select(best.id);
  }
}

addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select');
  if (e.key === 'Escape') {
    if (!$('ov-dispatch').hidden) closeDispatch();
    else if (!$('ov-transcript').hidden) closeTranscript();
    else if (!$('pageform').hidden) { closePage(); $('b-page').focus(); }
    else if (selected) select(null);
    else return;
    e.preventDefault();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('ov-dispatch').hidden || !$('ov-transcript').hidden) return;
  const k = e.key;
  if (k.startsWith('Arrow') && e.target instanceof HTMLElement && e.target.closest('#c-scroll')) return; // let the console scroll
  if (k === 'ArrowLeft') moveCursor(-1, 0);
  else if (k === 'ArrowRight') moveCursor(1, 0);
  else if (k === 'ArrowUp') moveCursor(0, -1);
  else if (k === 'ArrowDown') moveCursor(0, 1);
  else if (k === 'Enter' || k === ' ') {
    if (e.target instanceof HTMLElement && e.target.closest('button')) return;
    if (cursorId && tiles.has(cursorId)) select(selected === cursorId ? null : cursorId);
  } else if (k === 'n' || k === 'N') openDispatch();
  else if ((k === 't' || k === 'T') && selected) openTranscript();
  else if ((k === 'p' || k === 'P') && selected) openPage();
  else if (k === '!' || k === 'w' || k === 'W') cycleNeeds();
  else return;
  e.preventDefault();
});

wall.addEventListener('click', (e) => {
  const slot = e.target.closest?.('.slot');
  if (selected) { if (slot || e.target === wall || e.target === grid) select(null); }
  else if (slot) openDispatch(); // a free monitor is an invitation
});

/* ------------------------------------------------------------------ boot */
const feed = connectFeed({ onState, onMode });
onMode(feed.mode);
updateAges();
relayout();
