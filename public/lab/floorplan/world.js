// Floor Plan concept — the canvas world: static floor, props, actors, movement, hit-testing.
//
//   const world = createWorld(canvas, { onSelect(id|null), onHover(target|null, x, y), onReception() }, { calmMs?, overMs? });
//   world.setState(officeState)   // full snapshot, diffed by id; seats are stable
//
// Planning: the floor is drawn at the largest scale whose capacity covers the agents present plus some headroom.
// At a given scale the geometry is fixed, so growth first builds another desk row (nobody moves); only when the
// scale's capacity is exhausted does the camera pull back to a smaller scale, and desks keep their row/column.
// After a calm spell with fewer agents the camera pushes back in.
//   world.select(id|null)         // session id or `${sessionId}#${subagentId}`
//   world.resize(); world.destroy();

import { C, toolOf, mk, drawText, textSprite, textW, norm, wrap, drawIcon, charSprite, makeLook, drawCrown, SPR_H, SUB_H } from './gfx.js';
import { planLayout, measure, findPath, WALL, TOPF, COR, DESK_W, DESK_H } from './layout.js';

const fill = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
const box = (g, x, y, w, h, c, o = C.ink) => { g.fillStyle = o; g.fillRect(x, y, w, h); g.fillStyle = c; g.fillRect(x + 1, y + 1, w - 2, h - 2); };
const frame = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, 1); g.fillRect(x, y + h - 1, w, 1); g.fillRect(x, y + 1, 1, h - 2); g.fillRect(x + w - 1, y + 1, 1, h - 2); };
const corners = (g, x, y, w, h, c, n = 3) => {
  g.fillStyle = c;
  for (const [cx, sx] of [[x, 1], [x + w - 1, -1]]) for (const [cy, sy] of [[y, 1], [y + h - 1, -1]]) {
    g.fillRect(sx > 0 ? cx : cx - n + 1, cy, n, 1);
    g.fillRect(cx, sy > 0 ? cy : cy - n + 1, 1, n);
  }
};

/* ------------------------------------------------------------ prop sprites */
const PROPS = {
  vending: { w: 12, h: 24, oy: -17, draw(g) {
    box(g, 0, 0, 12, 24, '#c0392b'); fill(g, 1, 1, 10, 1, '#e86a5a');
    box(g, 1, 3, 8, 13, C.screenOff);
    const cols = ['#ffd23f', '#35d6a0', '#f4f4f4', '#7a6cff', '#e8704a'];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) fill(g, 2 + c * 2, 4 + r * 3, 1, 2, cols[(r * 2 + c) % 5]);
    fill(g, 2, 18, 6, 3, C.ink); fill(g, 9, 5, 2, 5, '#f4f4f4'); fill(g, 9, 12, 2, 2, C.gold);
  } },
  coffee: { w: 26, h: 22, oy: -14, draw(g) {
    box(g, 0, 13, 26, 9, '#6b7394'); box(g, 0, 10, 26, 5, C.wall); fill(g, 1, 20, 24, 1, C.faceLo);
    box(g, 2, 0, 10, 11, C.metal); fill(g, 3, 1, 8, 1, C.metalHi); fill(g, 4, 3, 6, 3, C.screenOff); fill(g, 9, 3, 1, 1, C.red); fill(g, 6, 7, 2, 3, C.ink);
    box(g, 14, 6, 4, 5, C.white); box(g, 19, 6, 4, 5, C.white); fill(g, 15, 7, 2, 1, '#8f563b');
  } },
  couchBack: { w: 38, h: 18, oy: 0, draw(g) {
    box(g, 0, 0, 38, 9, C.couchD); fill(g, 1, 1, 36, 2, C.couch);
    box(g, 2, 7, 34, 10, C.couch); fill(g, 3, 8, 32, 2, C.couchHi);
    fill(g, 13, 8, 1, 8, C.couchD); fill(g, 24, 8, 1, 8, C.couchD);
  } },
  couchFront: { w: 38, h: 18, oy: 0, draw(g) {
    box(g, 3, 13, 32, 5, C.couchD); fill(g, 4, 14, 30, 1, C.couch);
    box(g, 0, 5, 5, 13, C.couch); box(g, 33, 5, 5, 13, C.couch); fill(g, 1, 6, 3, 2, C.couchHi); fill(g, 34, 6, 3, 2, C.couchHi);
  } },
  roundTable: { w: 12, h: 10, oy: 0, draw(g) {
    fill(g, 5, 6, 2, 4, C.ink); box(g, 0, 0, 12, 7, C.desk); fill(g, 1, 1, 10, 1, C.deskHi);
    fill(g, 0, 0, 1, 1, 'rgba(0,0,0,0)'); box(g, 7, 1, 3, 3, C.white);
  } },
  reception: { w: 40, h: 26, oy: -10, draw(g) {
    box(g, 0, 10, 40, 7, C.desk); fill(g, 1, 11, 38, 1, C.deskHi);
    box(g, 0, 16, 40, 10, C.deskFront); fill(g, 1, 24, 38, 1, C.deskDark);
    box(g, 4, 1, 11, 9, C.metal); fill(g, 5, 2, 9, 6, '#dff3ff'); fill(g, 6, 3, 5, 1, C.metalHi); fill(g, 6, 5, 7, 1, C.metalHi); fill(g, 8, 10, 3, 2, C.ink);
    fill(g, 28, 8, 6, 3, C.ink); fill(g, 29, 8, 4, 2, C.gold); fill(g, 30, 7, 2, 1, C.gold); fill(g, 30, 6, 2, 1, C.ink);
    drawText(g, 'FRONT', 2, 18, '#f0c48f'); drawText(g, 'DESK', 24, 18, '#f0c48f'); // a 3 px word gap, so the label clears both edges
  } },
  bench: { w: 30, h: 12, oy: 0, draw(g) {
    fill(g, 2, 7, 2, 5, C.ink); fill(g, 26, 7, 2, 5, C.ink);
    box(g, 0, 0, 30, 8, '#8f563b'); fill(g, 1, 1, 28, 2, '#b97a4f'); fill(g, 1, 4, 28, 1, C.deskDark);
  } },
  plant: { w: 10, h: 15, oy: -15, draw(g) {
    fill(g, 2, 2, 6, 8, C.ink); fill(g, 0, 4, 10, 4, C.ink); fill(g, 4, 0, 3, 3, C.ink);
    fill(g, 3, 3, 4, 6, C.plant); fill(g, 1, 5, 8, 2, C.plant); fill(g, 5, 1, 1, 2, C.plant); fill(g, 3, 4, 2, 2, '#6fd07a'); fill(g, 6, 6, 2, 2, C.plantD);
    box(g, 2, 9, 6, 6, C.pot); fill(g, 3, 10, 4, 1, '#d97a4f');
  } },
  copier: { w: 16, h: 14, oy: 0, draw(g) {
    box(g, 0, 2, 16, 12, '#d8dcea'); box(g, 1, 0, 14, 4, '#f4f4f4'); fill(g, 2, 7, 12, 1, C.faceLo); fill(g, 11, 5, 3, 1, C.green); fill(g, 3, 10, 10, 2, C.metal);
  } },
  cooler: { w: 8, h: 16, oy: 0, draw(g) {
    box(g, 1, 0, 6, 8, '#9fd8f0'); fill(g, 2, 1, 1, 3, '#ffffff'); box(g, 0, 7, 8, 9, '#e9ecf5'); fill(g, 3, 10, 2, 1, '#4a7fc0'); fill(g, 1, 14, 6, 1, C.faceLo);
  } },
};
const propCache = new Map();
function propSprite(type) {
  let c = propCache.get(type);
  if (c) return c;
  const p = PROPS[type];
  c = mk(p.w, p.h);
  p.draw(c.getContext('2d'));
  propCache.set(type, c);
  return c;
}

let deskBackSpr = null;
const deskFrontSpr = [];
function deskSprites() {
  if (deskBackSpr) return;
  deskBackSpr = mk(DESK_W, 17);
  let g = deskBackSpr.getContext('2d');
  box(g, 0, 0, DESK_W, 9, C.part); fill(g, 1, 1, DESK_W - 2, 2, C.partHi); fill(g, 1, 6, DESK_W - 2, 1, '#4a5378');
  box(g, 13, 6, 12, 11, C.chair); fill(g, 14, 7, 10, 2, C.chairHi);
  for (let v = 0; v < 4; v++) {
    const c = mk(DESK_W, 26); // rows cell.y+5 .. cell.y+30
    g = c.getContext('2d');
    box(g, 1, 9, 32, 7, C.desk); fill(g, 2, 10, 30, 1, C.deskHi);
    box(g, 1, 15, 32, 10, C.deskFront); fill(g, 2, 23, 30, 1, C.deskDark);
    box(g, 2, 0, 10, 9, C.metal); fill(g, 3, 1, 8, 7, C.screenOff);
    fill(g, 6, 9, 2, 2, C.ink); fill(g, 4, 11, 6, 1, C.ink);
    fill(g, 15, 11, 9, 2, C.chair); fill(g, 15, 11, 9, 1, C.metalHi);
    if (v === 0) { box(g, 27, 9, 4, 4, C.white); fill(g, 31, 10, 1, 2, C.ink); }
    else if (v === 1) { fill(g, 27, 5, 4, 5, C.ink); fill(g, 28, 6, 2, 3, C.plant); fill(g, 27, 7, 1, 1, C.plant); fill(g, 30, 6, 1, 1, C.plant); box(g, 27, 9, 4, 4, C.pot); }
    else if (v === 2) { box(g, 26, 10, 6, 4, C.white); fill(g, 27, 11, 3, 1, C.metalHi); }
    else { fill(g, 28, 6, 1, 4, C.ink); fill(g, 26, 5, 5, 2, C.ink); fill(g, 27, 5, 3, 1, C.gold); fill(g, 27, 10, 3, 1, C.ink); }
    deskFrontSpr.push(c);
  }
}

const BANG = ['..KKKKKK..', '.KWWWWWWK.', 'KWWWRRWWWK', 'KWWWRRWWWK', 'KWWWRRWWWK', 'KWWWRRWWWK', 'KWWWWWWWWK', 'KWWWRRWWWK', '.KWWWWWWK.', '..KKWWKK..', '....KWK...', '.....K....'];
let bangSpr = null;
function bangSprites() {
  if (bangSpr) return bangSpr;
  bangSpr = [[C.white, C.red], [C.hot, C.ink]].map(([W, R]) => {
    const c = mk(10, 12), g = c.getContext('2d');
    BANG.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const ch = row[x]; if (ch === '.') continue; g.fillStyle = ch === 'K' ? C.ink : ch === 'W' ? W : R; g.fillRect(x, y, 1, 1); } });
    return c;
  });
  return bangSpr;
}

/* ------------------------------------------------------------ static layer */
function renderStatic(L) {
  const cv = mk(L.W, L.H), g = cv.getContext('2d');
  const { W, H, x0, Xr, Ys, Yc, Yb } = L;
  fill(g, 0, 0, W, H, C.ink);
  // corridor
  fill(g, WALL, Yc, W - 2 * WALL, COR, C.corridor);
  for (let x = WALL + 8; x < W - WALL; x += 16) fill(g, x, Yc, 1, COR, C.corridor2);
  fill(g, WALL, Yc, W - 2 * WALL, 1, C.corridorInk);
  for (const d of L.decals) {
    drawIcon(g, d.icon, d.x, d.y, C.corridorInk);
    drawText(g, d.text, d.x + 7, d.y, C.corridorInk);
  }
  // lobby
  const lb = L.lobby;
  fill(g, lb.x, lb.y, lb.w, lb.h, C.stone);
  for (let y = lb.y, j = 0; y < lb.y + lb.h; y += 12, j++) for (let x = lb.x, i = 0; x < lb.x + lb.w; x += 12, i++) {
    if ((i + j) % 2) fill(g, x, y, Math.min(12, lb.x + lb.w - x), Math.min(12, lb.y + lb.h - y), C.stone2);
  }
  const e = L.entrance;
  fill(g, e.x - 2, lb.y, e.w + 4, lb.h + WALL, C.rug);
  fill(g, e.x - 2, lb.y, 1, lb.h + WALL, C.rug2); fill(g, e.x + e.w + 1, lb.y, 1, lb.h + WALL, C.rug2);
  fill(g, e.x, lb.y, 1, lb.h + WALL, C.gold); fill(g, e.x + e.w - 1, lb.y, 1, lb.h + WALL, C.gold);
  for (let y = lb.y + lb.h - 14; y > lb.y + 6; y -= 18) drawIcon(g, 'up', e.x + (e.w >> 1) - 2, y, C.rug2);
  // bullpen carpet
  const bp = L.bullpen;
  fill(g, bp.x, bp.y, bp.w, bp.h, C.carpet);
  g.fillStyle = C.carpet2;
  for (let y = bp.y + 1; y < bp.y + bp.h; y += 4) for (let x = bp.x + (((y - bp.y) >> 2) & 1 ? 1 : 3); x < bp.x + bp.w; x += 4) g.fillRect(x, y, 1, 1);
  // desk rugs: a lighter pad under every desk pair so the pairs read as islands
  for (const d of L.desks) if (d.col % 2 === 0) fill(g, d.x - 1, d.y + 8, DESK_W * 2 + 2, DESK_H - 7, '#3d4574');
  // conference rooms
  for (const r of L.rooms) {
    fill(g, r.x, r.y, r.w, r.h, C.wood);
    for (let y = r.y + 5, j = 0; y < r.y + r.h; y += 6, j++) {
      fill(g, r.x, y, r.w, 1, C.wood2);
      for (let x = r.x + (j % 2 ? 9 : 21); x < r.x + r.w; x += 24) fill(g, x, y - 5, 1, 5, C.wood2);
    }
    // boss mat + chairs
    box(g, r.boss.x - 10, r.y + 6, 20, 12, C.rug, C.rug2);
    fill(g, r.boss.x - 8, r.y + 8, 16, 1, C.gold);
    for (let i = 0; i < r.tableSeats; i++) { const s = r.seats[i]; box(g, s.x - 4, s.y - 7, 8, 8, C.chair); fill(g, s.x - 3, s.y - 6, 6, 1, C.chairHi); }
    // north face + whiteboard
    fill(g, r.x, WALL, r.w, TOPF - WALL, C.face); fill(g, r.x, TOPF - 2, r.w, 2, C.faceLo);
    box(g, r.board.x, r.board.y, r.board.w, r.board.h, C.white, C.metal);
    fill(g, r.board.x + 2, r.board.y + r.board.h, r.board.w - 4, 1, C.ink);
    fill(g, r.board.x + r.board.w - 8, r.board.y + r.board.h - 1, 3, 1, C.red); fill(g, r.board.x + r.board.w - 12, r.board.y + r.board.h - 1, 3, 1, '#4a7fc0');
  }
  // break room
  const br = L.breakRoom;
  for (let y = br.y, j = 0; y < br.y + br.h; y += 8, j++) for (let x = br.x, i = 0; x < br.x + br.w; x += 8, i++) {
    fill(g, x, y, Math.min(8, br.x + br.w - x), Math.min(8, br.y + br.h - y), (i + j) % 2 ? C.tile2 : C.tile);
  }
  fill(g, br.x, WALL, br.w, TOPF - WALL, '#c98f5a'); fill(g, br.x, TOPF - 2, br.w, 2, C.deskFront);
  // sign on the break room wall (right of the machines, above the couch)
  box(g, br.x + br.w - 46, 9, 44, 9, C.void, C.white);
  drawText(g, 'BREAK ROOM', br.x + br.w - 43, 11, C.white);
  box(g, br.x + 30, 6, 9, 9, C.white); fill(g, br.x + 34, 8, 1, 3, C.ink); fill(g, br.x + 34, 10, 3, 1, C.ink);
  // rug in the break room
  const rugY = br.y + br.h - 28 - 14;
  if (rugY > br.y + 22) { box(g, br.x + 46, rugY + 2, 36, 10, '#58b0a0', '#3d8a7c'); fill(g, br.x + 48, rugY + 4, 32, 1, '#8fd9c9'); }
  // walls from the grid mask
  const { cols, rows, wall } = L.grid;
  const at = (cx, cy) => cx < 0 || cy < 0 || cx >= cols || cy >= rows || wall[cy * cols + cx];
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    if (!wall[cy * cols + cx]) continue;
    const x = cx * 4, y = cy * 4;
    fill(g, x, y, 4, 4, C.wall);
    if (!at(cx, cy + 1)) { fill(g, x, y + 2, 4, 1, C.wallShade); fill(g, x, y + 3, 4, 1, C.ink); }
    if (!at(cx, cy - 1)) fill(g, x, y, 4, 1, C.ink);
    if (!at(cx - 1, cy)) fill(g, x, y, 1, 4, C.ink);
    if (!at(cx + 1, cy)) fill(g, x + 3, y, 1, 4, C.ink);
  }
  // glass fronts of the conference rooms
  for (const r of L.rooms) {
    g.globalAlpha = 0.22; fill(g, r.x, Ys - 7, r.w, 7, C.glass); g.globalAlpha = 0.5;
    for (let x = r.x + 5; x < r.x + r.w - 6; x += 13) { fill(g, x, Ys - 3, 1, 2, '#ffffff'); fill(g, x + 1, Ys - 5, 1, 2, '#ffffff'); fill(g, x + 2, Ys - 7, 1, 2, '#ffffff'); }
    g.globalAlpha = 1;
    fill(g, r.x, Ys, r.w, WALL, C.ink); fill(g, r.x, Ys + 1, r.w, 2, C.glass); fill(g, r.x, Ys + 2, r.w, 1, C.glass2);
    for (let x = r.x + 7; x < r.x + r.w; x += 8) fill(g, x, Ys, 1, WALL, C.ink);
    fill(g, r.door.x, Ys, r.door.w, WALL, C.wood); fill(g, r.door.x, Ys + 3, r.door.w, 1, C.corridorInk);
    fill(g, r.door.x - 1, Ys - 1, 1, WALL + 2, C.ink); fill(g, r.door.x + r.door.w, Ys - 1, 1, WALL + 2, C.ink);
  }
  // other doorways
  for (const d of L.doors) {
    if (d.kind === 'wall') { fill(g, d.x, d.y, d.w, WALL, C.tile2); fill(g, d.x, d.y + 3, d.w, 1, C.corridorInk); }
    if (d.kind === 'entrance') {
      fill(g, d.x, d.y, d.w, WALL, C.rug);
      fill(g, d.x - 2, d.y - 8, 2, 8, C.ink); fill(g, d.x + d.w, d.y - 8, 2, 8, C.ink);
      fill(g, d.x - 1, d.y - 7, 1, 7, C.glass); fill(g, d.x + d.w, d.y - 7, 1, 7, C.glass);
      box(g, d.x - 3, d.y - 16, d.w + 6, 7, C.rug2); drawText(g, 'WELCOME', d.x - 3 + ((d.w + 6 - textW('WELCOME')) >> 1), d.y - 15, C.gold);
    }
  }
  // bullpen railing
  let rx = x0;
  const gaps = [...L.railGaps].sort((a, b) => a.x - b.x);
  const seg = (a, b) => { if (b - a < 3) return; box(g, a, Yb, b - a, WALL, C.metalHi); fill(g, a, Yb, 2, WALL, C.ink); fill(g, b - 2, Yb, 2, WALL, C.ink); };
  for (const gp of gaps) { seg(rx, gp.x); rx = gp.x + gp.w; }
  seg(rx, Xr);
  return cv;
}

/* ---------------------------------------------------------------- captions */
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const VERB = /^(?:[A-Z][A-Z ]{1,13}:\s*|(?:EDIT|MULTIEDIT|READ|WRITE|GREP|GLOB|FETCH|RUN)\s+)/; // "Bash: ", "Computer use: ", "Edit " ...
const actCache = new Map();
/** The object of an activity label ("Edit src/totals.ts" -> "TOTALS.TS"); the verb is already shown as an icon. */
function shortAct(label) {
  let v = actCache.get(label);
  if (v != null) return v;
  const full = norm(label || '').trim();
  let s = full.replace(VERB, '').replace(/^HTTPS?:\/\//, '').replace(/^["']+|["']+$/g, '') || full;
  const sp = s.indexOf(' '), first = sp < 0 ? s : s.slice(0, sp);
  if (first.includes('/')) {
    const parts = first.split('/').filter(Boolean);
    const url = !/^[./~]/.test(first) && /^[A-Z0-9-]+(\.[A-Z0-9-]+)+$/.test(parts[0] || '');
    s = ((url ? parts[0] : parts[parts.length - 1]) || first) + (sp < 0 ? '' : s.slice(sp));
  }
  if (actCache.size > 600) actCache.clear();
  actCache.set(label, (v = s));
  return v;
}
const CAP_COLS = 7; // caption width in characters: leaves a clear gap to the neighbour's caption in a desk pair
const fit = (s, n) => ([...s].length <= n ? s : [...s].slice(0, Math.max(1, n - 1)).join('').trimEnd() + '…');
const noExt = (w) => { const i = w.lastIndexOf('.'); return i > 0 && w.length - i <= 6 ? w.slice(0, i) : w; };
const capCache = new Map();
/** Fit a caption into n lines of CAP_COLS: a file name loses its extension before it loses letters, and breaks at . - _ / */
function capLines(text, n) {
  const key = n + '|' + text;
  let v = capCache.get(key);
  if (v) return v;
  const words = text.split(' ').filter(Boolean), one = words.length === 1;
  if ([...text].length <= CAP_COLS) v = [text];
  else if (n < 2) v = [fit(one ? noExt(text) : text, CAP_COLS)];
  else if (one) {
    let cut = CAP_COLS;
    for (let i = Math.min(CAP_COLS, text.length - 1); i >= 3; i--) if ('._-/'.includes(text[i - 1])) { cut = i; break; }
    const b = text.slice(cut);
    v = [text.slice(0, cut), b.length <= CAP_COLS ? b : fit(noExt(b), CAP_COLS)];
  } else v = wrap(text, CAP_COLS, 2);
  if (capCache.size > 800) capCache.clear();
  capCache.set(key, v);
  return v;
}
const headroom = (n) => Math.max(2, Math.ceil(n / 8));
const ROOMS_GUARANTEED = 4; // every orchestrator gets a room up to this many; beyond it they run their crew from their desk

/* ------------------------------------------------------------------- world */
export function createWorld(canvas, cb = {}, opts = {}) {
  const CALM_MS = opts.calmMs ?? 45_000; // fewer agents for this long -> zoom back in
  const SLOW = opts.slow || 1; // dev: stretch the camera tween
  const OVER_MS = opts.overMs ?? 10_000; // more orchestrators / breaks than rooms / couches for this long -> grow
  const ctx = canvas.getContext('2d');
  let buf = mk(4, 4), g = buf.getContext('2d'), bg = null;
  let L = null, k = 2, offX = 0, offY = 0, cw = 1, ch = 1, dpr = 1;
  let plan = null; // { k, breaks, tight } the plan L was built from
  let tw = null; // camera tween between two plans
  let demand = { desks: 0, rooms: 0, breaks: 0 };
  let hasState = false, overSince = 0, calmSince = 0, replans = 0;
  let sessions = new Map();
  const actors = new Map();
  const deskOf = new Map(), roomOf = new Map(), breakOf = new Map(), subSlots = new Map(), subOver = new Map();
  let deskOwner = [], roomOwner = [], breakOwner = [];
  let first = true, selected = null, hover = null, hoverRec = false, selAt = -9;
  const t0 = performance.now();
  let last = t0, raf = 0, dead = false, frameMs = 0, frames = 0;
  deskSprites();

  const lowestFree = (arr, cap) => { for (let i = 0; i < cap; i++) if (!arr[i]) return i; return -1; };

  function newActor(id, kind, look) {
    return { id, kind, look, x: 0, y: 0, dir: 'down', route: [], near: null, seat: null, seatKind: null, data: null, alpha: 1, leaving: false, walk: 0, moving: false, phase: (look.key.length * 7 + id.length * 13) % 10, speed: kind === 'sub' ? 58 : 50 };
  }
  function seatFor(a) {
    if (!L) return null;
    switch (a.seatKind) {
      case 'desk': return L.desks[deskOf.get(a.id)]?.seat || null;
      case 'boss': return L.rooms[roomOf.get(a.id)]?.boss || null;
      case 'break': return L.breakSpots[breakOf.get(a.id)] || null;
      case 'sub': return L.rooms[a.room]?.seats[a.slot] || null;
      case 'exit': return L.exit;
      case 'subexit': return L.rooms[a.room]?.doorSeat || null;
      default: return null;
    }
  }
  function place(a, seat) {
    a.x = seat.x; a.y = seat.y; a.route = []; a.near = seat; a.seat = seat; a.dir = seat.facing || 'down'; a.moving = false; a.entering = false;
    if (a.kind !== 'sub') a.alpha = 1;
  }
  function routeTo(a, seat, remove = false) {
    const pts = [];
    let start = { x: a.x, y: a.y };
    if (a.near) { pts.push({ x: a.near.approach.x, y: a.near.approach.y, near: null }); start = a.near.approach; }
    const goal = seat.approach;
    for (const p of findPath(L.grid, start, goal)) pts.push(p);
    pts.push({ x: goal.x, y: goal.y, near: seat });
    pts.push({ x: seat.x, y: seat.y, remove });
    a.route = pts; a.seat = seat;
  }

  function release(map, owners, id) {
    if (!map.has(id)) return;
    const i = map.get(id);
    if (owners[i] === id) owners[i] = null;
    map.delete(id);
  }
  function leaveSub(b) {
    if (b.leaving) return;
    b.leaving = true; b.seatKind = 'subexit';
    const seat = seatFor(b);
    if (seat) routeTo(b, seat, true); else actors.delete(b.id);
  }
  function dismissSubs(sid) {
    subOver.delete(sid);
    const slots = subSlots.get(sid);
    if (!slots) return;
    for (const subId of slots.keys()) { const b = actors.get(sid + '#' + subId); if (b) leaveSub(b); }
    subSlots.delete(sid);
  }

  function sync(list) {
    for (const s of list) {
      let a = actors.get(s.id);
      if (!a) {
        const di = lowestFree(deskOwner, L.desks.length);
        if (di < 0) continue;
        deskOwner[di] = s.id; deskOf.set(s.id, di);
        a = newActor(s.id, 'agent', makeLook(s.id, s.tool));
        actors.set(s.id, a);
        a.fresh = true;
        if (!first) { a.x = L.exit.x; a.y = L.exit.y; a.near = L.exit; a.dir = 'up'; a.entering = true; }
      } else if (!deskOf.has(s.id)) {
        const di = lowestFree(deskOwner, L.desks.length);
        if (di >= 0) { deskOwner[di] = s.id; deskOf.set(s.id, di); a.fresh = true; }
      }
      a.data = s;
      const orch = s.mode === 'orchestrator' && s.status !== 'idle';
      let kind = s.status === 'idle' ? 'break' : orch ? 'boss' : 'desk';
      if (kind === 'boss' && !roomOf.has(s.id)) {
        const ri = lowestFree(roomOwner, L.rooms.length);
        if (ri < 0) kind = 'desk'; else { roomOwner[ri] = s.id; roomOf.set(s.id, ri); }
      }
      if (kind !== 'boss') release(roomOf, roomOwner, s.id);
      if (kind === 'break' && !breakOf.has(s.id)) {
        const bi = lowestFree(breakOwner, L.breakSpots.length);
        if (bi < 0) kind = 'desk'; else { breakOwner[bi] = s.id; breakOf.set(s.id, bi); }
      }
      if (kind !== 'break') release(breakOf, breakOwner, s.id);
      a.deskBoss = orch && kind === 'desk'; // no free room: runs the crew from the desk, and says so
      if (a.seatKind !== kind || a.leaving || a.fresh) {
        a.seatKind = kind; a.leaving = false;
        const seat = seatFor(a);
        if (seat) { if (first) place(a, seat); else routeTo(a, seat); }
        a.fresh = false;
      }
      if (kind === 'boss') syncSubs(s); else dismissSubs(s.id);
    }
    for (const [id, a] of actors) {
      if (a.kind !== 'agent' || a.leaving || sessions.has(id)) continue;
      a.leaving = true; a.seatKind = 'exit'; a.deskBoss = false;
      dismissSubs(id);
      release(roomOf, roomOwner, id); release(breakOf, breakOwner, id);
      routeTo(a, L.exit, true);
    }
  }
  function syncSubs(s) {
    const ri = roomOf.get(s.id), room = L.rooms[ri];
    if (!room) return;
    let slots = subSlots.get(s.id);
    if (!slots) subSlots.set(s.id, (slots = new Map()));
    const cap = room.seats.length, subs = s.subagents || [];
    const live = new Map(subs.map((u) => [u.id, u]));
    const unseat = (subId) => { slots.delete(subId); const b = actors.get(s.id + '#' + subId); if (b) leaveSub(b); };
    for (const subId of [...slots.keys()]) if (!live.has(subId) || slots.get(subId) >= cap) unseat(subId);
    const freeSlot = () => { const used = new Set(slots.values()); for (let i = 0; i < cap; i++) if (!used.has(i)) return i; return -1; };
    let over = 0;
    for (const sub of subs) {
      if (!slots.has(sub.id)) {
        let f = freeSlot();
        if (f < 0 && sub.status === 'working') {
          // the room is full: somebody who has finished gives up their chair to somebody still working
          let out = null;
          for (const id of slots.keys()) { const u = live.get(id); if (u && u.status !== 'working' && (!out || (u.endedAt || 0) < (out.endedAt || 0))) out = u; }
          if (out) { f = slots.get(out.id); unseat(out.id); over++; }
        }
        if (f < 0) { over++; continue; }
        slots.set(sub.id, f);
      }
      const slot = slots.get(sub.id);
      const id = s.id + '#' + sub.id;
      let b = actors.get(id);
      if (!b) {
        b = newActor(id, 'sub', makeLook(id, s.tool, 'sub'));
        b.parentId = s.id; b.room = ri; b.slot = slot; b.seatKind = 'sub';
        actors.set(id, b);
        if (first) place(b, room.seats[slot]);
        else { b.x = room.doorSeat.x; b.y = room.doorSeat.y; b.near = null; b.alpha = 0; routeTo(b, room.seats[slot]); }
      } else if (b.leaving || b.room !== ri || b.slot !== slot) {
        b.leaving = false; b.room = ri; b.slot = slot; b.seatKind = 'sub';
        routeTo(b, room.seats[slot]);
      }
      b.data = sub; b.tool = s.tool;
    }
    subOver.set(s.id, over);
  }

  function setState(s) {
    const list = s.sessions || [];
    sessions = new Map(list.map((x) => [x.id, x]));
    demand = {
      desks: list.length,
      rooms: list.filter((x) => x.mode === 'orchestrator' && x.status !== 'idle').length,
      breaks: list.filter((x) => x.status === 'idle').length,
    };
    hasState = true;
    if (!L) { sizeCanvas(); replan(false); } else maintain(performance.now());
    if (!L) return;
    sync(list);
    first = false;
  }

  /* ---- planning */
  function sizeCanvas() {
    const host = canvas.parentElement; // layout size, so CSS transforms on an ancestor do not matter
    dpr = window.devicePixelRatio || 1;
    const w = Math.max(8, Math.round(host.clientWidth * dpr)), h = Math.max(8, Math.round(host.clientHeight * dpr));
    const changed = w !== cw || h !== ch;
    cw = w; ch = h;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    canvas.style.width = cw / dpr + 'px'; canvas.style.height = ch / dpr + 'px';
    return changed;
  }
  /** Largest scale (device px per logical px) whose floor holds the demand. */
  function choose(nd) {
    const kMax = Math.max(1, Math.floor(6 * dpr)), kMin = Math.max(1, Math.round(dpr));
    const rooms = Math.min(nd.rooms, ROOMS_GUARANTEED);
    // at each scale try the regular floor first, then the one with shallower meeting rooms and one more desk row
    for (const hr of [headroom(nd.desks), 0]) {
      for (let s = kMax; s >= kMin; s--) for (const tight of [false, true]) {
        const m = measure(Math.floor(cw / s), Math.floor(ch / s), nd.breaks, tight);
        if (m && m.cap.desks >= nd.desks + hr && m.cap.rooms >= rooms) return { k: s, m, tight };
      }
    }
    for (let s = kMin; s <= kMax; s++) for (const tight of [false, true]) { const m = measure(Math.floor(cw / s), Math.floor(ch / s), nd.breaks, tight); if (m) return { k: s, m, tight }; }
    return null;
  }
  const rowsWanted = (m, n) => clampN(Math.ceil((n + headroom(n)) / m.perRow), 1, m.maxRows);
  function occupiedRows() {
    let r = 0;
    if (L) for (let i = 0; i < deskOwner.length; i++) if (deskOwner[i] && L.desks[i]) r = Math.max(r, L.desks[i].row + 1);
    return r;
  }
  function center() {
    offX = Math.floor((cw - L.W * k) / 2); offY = Math.floor((ch - L.H * k) / 2);
  }
  function replan(animate) {
    const c = choose(demand);
    if (!c) { L = null; plan = null; bg = null; return false; }
    const rows = clampN(Math.max(rowsWanted(c.m, demand.desks), occupiedRows()), 1, c.m.maxRows);
    const pitchRows = Math.min(c.m.maxRows, rows + 1); // spacing leaves room for one more row before anything has to close up
    if (L && plan && c.k === plan.k && c.tight === plan.tight && c.m.W === L.W && c.m.H === L.H && rows === L.rows && pitchRows === L.pitchRows && c.m.rightW === L.rightW) { center(); return false; }
    return build(c.k, rows, demand.breaks, animate, pitchRows, c.tight);
  }
  /** Same scale, different number of desk rows. The spacing only changes when the rows no longer fit it. */
  function setRows(rows) {
    return build(k, rows, plan.breaks, true, rows > L.pitchRows || rows < L.rows ? Math.min(L.maxRows, rows + 1) : L.pitchRows, plan.tight);
  }
  function build(kk, rows, breaks, animate, pitchRows, tight = false) {
    const nl = planLayout(Math.floor(cw / kk), Math.floor(ch / kk), { rows, pitchRows, breaks, tight });
    if (!nl) return false;
    const old = L;
    const sameGeom = !!old && kk === k && old.W === nl.W && old.H === nl.H && old.rightW === nl.rightW && old.pitch === nl.pitch && old.confH === nl.confH;
    if (animate && old && bg) {
      const snap = mk(old.W, old.H);
      snap.getContext('2d').drawImage(buf, 0, 0);
      tw = { t0: performance.now(), dur: (sameGeom ? 380 : 800) * SLOW, fk: k, fx: offX, fy: offY, snap, oax: old.desks[0].x, oay: old.desks[0].y, ax: nl.desks[0].x, ay: nl.desks[0].y };
    } else tw = null;
    // whoever was on the way out is gone by the time the camera has moved
    if (!sameGeom) for (const a of [...actors.values()]) if (a.leaving) removeActor(a);
    // desks keep their row and column; whoever no longer fits takes the first free desk
    const keep = [], moved = [];
    for (const [id, i] of deskOf) {
      const d = old?.desks[i];
      if (d && d.row < nl.rows && d.col < nl.perRow) keep.push([id, d.row * nl.perRow + d.col]); else moved.push(id);
    }
    deskOf.clear(); deskOwner = [];
    for (const [id, i] of keep) { deskOf.set(id, i); deskOwner[i] = id; }
    for (const id of moved) { const i = lowestFree(deskOwner, nl.desks.length); if (i >= 0) { deskOf.set(id, i); deskOwner[i] = id; } }
    const refit = (map, cap) => { const owners = []; for (const [id, i] of [...map]) { if (i < cap) owners[i] = id; else map.delete(id); } return owners; };
    roomOwner = refit(roomOf, nl.rooms.length);
    breakOwner = refit(breakOf, nl.breakSpots.length);
    L = nl; k = kk; plan = { k: kk, breaks, tight };
    center();
    buf = mk(L.W, L.H); g = buf.getContext('2d');
    bg = renderStatic(L);
    if (old) replans++;
    for (const a of [...actors.values()]) {
      if (a.leaving) { if (sameGeom && a.kind === 'agent') routeTo(a, L.exit, true); else removeActor(a); continue; }
      if (a.kind === 'sub') { a.room = roomOf.get(a.parentId); if (a.room == null) { actors.delete(a.id); subSlots.delete(a.parentId); subOver.delete(a.parentId); continue; } }
      const seat = seatFor(a);
      if (!seat) { if (a.kind === 'sub') actors.delete(a.id); else { a.seatKind = null; a.fresh = true; } continue; }
      if (sameGeom && a.moving) routeTo(a, seat); // nothing moved: keep walking, around the new furniture
      else if (a.entering) { a.x = L.exit.x; a.y = L.exit.y; a.near = L.exit; a.dir = 'up'; routeTo(a, seat); }
      else place(a, seat);
    }
    return true;
  }
  /** Called on every state: grow when the plan is outgrown, build a row, or zoom back in after a calm spell. */
  function maintain(now) {
    let grow = demand.desks > L.cap.desks;
    if (Math.min(demand.rooms, ROOMS_GUARANTEED) > L.cap.rooms || demand.breaks > L.cap.breaks) {
      overSince = overSince || now;
      if (now - overSince > OVER_MS) { grow = true; overSince = now; }
    } else overSince = 0;
    if (grow) { calmSince = 0; if (replan(true)) return; }
    const want = Math.max(rowsWanted(L, demand.desks), Math.ceil(demand.desks / L.perRow));
    if (want > L.rows) { setRows(Math.min(want, L.maxRows)); return; }
    const ideal = choose(demand);
    const zoomIn = ideal && (ideal.k > k || (ideal.k === k && plan.tight && !ideal.tight)), trimTo = Math.max(want, occupiedRows(), 1);
    if (zoomIn || trimTo < L.rows) {
      calmSince = calmSince || now;
      if (now - calmSince > CALM_MS) { calmSince = 0; if (zoomIn) replan(true); else setRows(trimTo); }
    } else calmSince = 0;
  }
  function onResize() {
    const changed = sizeCanvas();
    if (!hasState) return;
    if (!changed && L) return;
    tw = null;
    replan(false);
  }
  function removeActor(a) {
    actors.delete(a.id);
    if (a.kind === 'agent') { release(deskOf, deskOwner, a.id); release(roomOf, roomOwner, a.id); release(breakOf, breakOwner, a.id); }
  }

  /* ---- simulation */
  function step(a, dt) {
    if (!a.route.length) { a.moving = false; return; }
    let remain = a.speed * dt;
    a.walk += dt;
    while (remain > 0 && a.route.length) {
      const p = a.route[0];
      const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0.01) a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      if (d <= remain) {
        a.x = p.x; a.y = p.y; remain -= d; a.route.shift();
        if ('near' in p) a.near = p.near;
        if (p.remove) { a.gone = true; return; }
      } else { a.x += (dx / d) * remain; a.y += (dy / d) * remain; remain = 0; }
    }
    a.moving = a.route.length > 0;
    if (!a.moving) { a.entering = false; if (a.seat) a.dir = a.seat.facing || 'down'; }
  }
  function update(dt) {
    for (const a of [...actors.values()]) {
      step(a, dt);
      if (a.kind === 'sub') {
        if (a.leaving) a.alpha = Math.max(0, a.alpha - dt * (a.route.length <= 1 ? 4 : 0.6));
        else a.alpha = Math.min(1, a.alpha + dt * 3);
      }
      if (a.gone) removeActor(a);
    }
  }

  /* ---- drawing */
  const deskAt = (a) => (!a.moving && a.seatKind === 'desk' ? L.desks[deskOf.get(a.id)] : null);
  const roomAt = (a) => (!a.moving && a.seatKind === 'boss' ? L.rooms[roomOf.get(a.id)] : null);
  /** Lines of caption that fit under this desk before the next row (or the wall) starts. */
  function captionLines(d) {
    const room = d.row < L.rows - 1 ? L.pitch - DESK_H : L.H - WALL - (d.y + DESK_H);
    return room >= 12 ? 2 : room >= 6 ? 1 : 0;
  }
  function caption(d, text, color) {
    const n = captionLines(d);
    if (!n || !text) return;
    capLines(text, n).forEach((ln, i) => g.drawImage(textSprite(ln, color), d.x + 2, d.y + DESK_H + 1 + i * 6));
  }
  /** One pip per crew member: done, failed, still working. Same strip on a room's plaque and under a boss's desk. */
  function pips(subs, x, y, w, tool, t) {
    const n = subs.length, on = Math.floor(t * 3) % 2;
    for (let i = 0; i < n; i++) {
      const a0 = Math.round((i * w) / n), a1 = Math.round(((i + 1) * w) / n);
      fill(g, x + a0, y, Math.max(1, a1 - a0 - (n > 1 && w / n >= 3 ? 1 : 0)), 2, subs[i].status === 'done' ? C.green : subs[i].status === 'failed' ? C.red : on ? C.white : C.metal);
    }
  }
  /** A boss without a room runs the crew from the desk: star, done/total and the pips where the caption would be. */
  function crewCaption(d, s, tool, t) {
    if (!captionLines(d)) return;
    const subs = s.subagents || [], [done, total] = crewCount(s);
    const x = d.x + 2, y = d.y + DESK_H + 1;
    drawIcon(g, 'star', x, y, C.gold);
    if (!total) { g.drawImage(textSprite('BOSS', C.gold), x + 7, y); return; }
    const cnt = done + '/' + total;
    g.drawImage(textSprite(cnt, done === total ? C.green : C.gold), x + 7, y);
    const px = x + 7 + textW(cnt) + 2, pw = d.x + DESK_W - 3 - px;
    if (pw >= total) pips(subs, px, y + 2, pw, tool, t);
  }
  const crewCount = (s) => { const subs = s.subagents || []; return [subs.filter((u) => u.status !== 'working').length, subs.length]; };

  function drawDeskFront(d, t) {
    const x = d.x, y = d.y;
    g.drawImage(deskFrontSpr[d.i % 4], x, y + 5);
    const owner = deskOwner[d.i], a = owner && actors.get(owner), s = a && a.data;
    if (!s) return;
    const tool = toolOf(s.tool);
    const here = a.seatKind === 'desk' && !a.moving;
    const gone = a.leaving;
    const tick = Math.floor(t * 6 + a.phase);
    const waiting = here && s.status === 'waiting';
    if (here && s.status === 'working') {
      g.globalAlpha = 0.3; fill(g, x + 1, y + 4, 12, 11, tool.base); fill(g, x + 2, y + 16, 11, 3, tool.base); g.globalAlpha = 1;
      // the monitor shows what they are doing: the activity icon on the tool colour
      box(g, x + 2, y + 5, 10, 9, tool.base, C.ink);
      const kind = s.activity?.kind || 'thinking';
      if (kind === 'thinking') { const n = Math.floor(t * 3 + a.phase) % 3; for (let i = 0; i < 3; i++) fill(g, x + 4 + i * 2, y + 9, 1, 1, i === n ? C.ink : tool.dark); }
      else drawIcon(g, kind, x + 4, y + 7, C.ink);
      fill(g, x + 16 + (tick & 1), y + 15, 2, 1, a.look.skin); fill(g, x + 21 - (tick & 1), y + 15, 2, 1, a.look.skin);
    } else if (waiting) {
      box(g, x + 2, y + 5, 10, 9, C.hot, C.ink);
      fill(g, x + 6, y + 7, 2, 3, C.ink); fill(g, x + 6, y + 11, 2, 1, C.ink);
    } else if (!here && !gone) {
      fill(g, x + 5 + (Math.floor(t * 2 + a.phase) % 4), y + 9, 1, 1, C.metalHi); // screensaver dot
    }
    // nameplate: a dark plate across the desk front, tool badge + name
    const flash = waiting && Math.floor(t * 3) % 2 === 0;
    fill(g, x + 2, y + 21, 30, 7, flash ? C.hot : C.void);
    fill(g, x + 2, y + 21, 10, 7, flash ? C.ink : gone ? C.metal : tool.base);
    g.drawImage(textSprite(tool.badge, flash ? C.hot : C.ink), x + 4, y + 22);
    const nm = norm(s.name || '?').slice(0, 5);
    g.drawImage(textSprite(nm, flash ? C.ink : here ? C.white : gone ? C.metalHi : '#b9bdd0'), x + 13, y + 22);
    // caption under the desk: what they are doing, or where they are
    if (gone) return;
    if (here && a.deskBoss) crewCaption(d, s, tool, t);
    else if (waiting) { if (Math.floor(t * 3) % 4) caption(d, 'WAITING', C.hot); }
    else if (here && s.status === 'working') {
      const kind = s.activity?.kind;
      caption(d, kind === 'thinking' ? 'HMM' + '...'.slice(0, 1 + (Math.floor(t * 2 + a.phase) % 3)) : kind === 'delegating' ? 'CREW' : shortAct(s.activity?.label || ''), tool.light);
    } else if (here && s.status === 'idle') caption(d, 'IDLE', C.dim);
    else if (a.seatKind === 'boss' && roomOf.has(a.id)) {
      if (captionLines(d)) { drawIcon(g, 'up', x + 2, y + DESK_H + 1, C.gold); g.drawImage(textSprite('ROOM ' + (roomOf.get(a.id) + 1), C.gold), x + 9, y + DESK_H + 1); }
    } else if (a.seatKind === 'break' && !a.moving) caption(d, 'BREAK', C.metalHi);
  }

  function drawTable(r, t) {
    const tb = r.table, owner = roomOwner[r.i];
    box(g, tb.x, tb.y, tb.w, tb.h, owner ? '#7a5540' : '#4d3a33');
    fill(g, tb.x + 1, tb.y + 1, tb.w - 2, 1, owner ? '#9c7257' : '#5e4a42');
    fill(g, tb.x + 1, tb.y + tb.h - 3, tb.w - 2, 2, '#4d3327');
    if (!owner) return;
    const s = sessions.get(owner);
    if (!s) return;
    const tool = toolOf(s.tool);
    for (const sub of s.subagents || []) {
      const b = actors.get(owner + '#' + sub.id);
      if (!b || b.moving || b.leaving || b.slot >= r.tableSeats) continue;
      const left = b.slot % 2 === 0, lx = left ? tb.x + 1 : tb.x + tb.w - 6, ly = Math.round(b.y) - 9;
      const on = sub.status === 'working';
      box(g, lx, ly, 5, 4, on ? (Math.floor(t * 5 + b.phase) % 3 ? tool.base : tool.light) : C.screenOff);
    }
  }

  function drawActor(a, t) {
    const sub = a.kind === 'sub', s = a.data || {};
    let fr = 0, bob = 0;
    const seated = !a.moving;
    if (a.moving) { const ph = Math.floor(a.walk * 9) % 4; fr = ph === 0 ? 1 : ph === 2 ? 2 : 0; bob = ph % 2 ? 0 : -1; }
    else if (s.status === 'working') bob = Math.floor(t * (sub ? 3 : 4) + a.phase) % 2 ? 0 : 1;
    const dir = a.moving ? a.dir : a.seat?.facing || 'down';
    const spr = charSprite(a.look, dir, fr);
    const w = spr.width, h = spr.height;
    const x = Math.round(a.x) - (w >> 1), y = Math.round(a.y) - h + bob;
    const dimmed = sub && seated && s.status && s.status !== 'working'; // finished crew fade into the background
    if (a.alpha < 1 || dimmed) g.globalAlpha = a.alpha * (dimmed ? 0.7 : 1);
    if (a.moving || a.seatKind === 'boss' || a.seat?.kind === 'sip' || a.seat?.kind === 'snack') { g.fillStyle = 'rgba(8,8,18,.35)'; g.fillRect(x + 1, Math.round(a.y) - 1, w - 2, 2); }
    g.drawImage(spr, x, y);
    if (!sub && dir === 'down') {
      const doze = seated && s.status === 'idle' && a.seat?.kind === 'doze';
      const blink = (t * 1.3 + a.phase * 0.37) % 4 < 0.12;
      if ((doze || blink) && a.look.acc !== 'shades') { fill(g, x + 4, y + 6, 1, 1, a.look.skin); fill(g, x + 7, y + 6, 1, 1, a.look.skin); }
      if (seated && s.status === 'idle' && a.seat?.kind === 'sip') { box(g, x + 9, y + 11, 4, 4, C.white); if (Math.floor(t * 2 + a.phase) % 2) fill(g, x + 10, y + 9, 1, 1, C.white); else fill(g, x + 11, y + 8, 1, 1, C.white); }
      if (s.status === 'waiting' && seated) { // raised hand
        const up = Math.floor(t * 4) % 2;
        fill(g, x + 10, y + 5 - up, 3, 5, C.ink); fill(g, x + 11, y + 6 - up, 1, 4, a.look.shirt); fill(g, x + 11, y + 6 - up, 1, 2, a.look.skin);
      }
      if (seated && a.seatKind === 'boss' && s.status === 'working') { // pointer at the whiteboard
        const up = Math.floor(t * 2 + a.phase) % 2;
        g.fillStyle = C.ink; for (let i = 0; i < 5; i++) g.fillRect(x + 11 + i, y + 10 - i - up * (i > 2 ? 1 : 0), 1, 1);
      }
    }
    if (!sub && !a.leaving && (a.seatKind === 'boss' || a.deskBoss)) drawCrown(g, x, y);
    g.globalAlpha = 1;
  }

  function drawPlaque(r, t) {
    const owner = roomOwner[r.i], s = owner && sessions.get(owner);
    const px = r.plaque.x, py = r.plaque.y, pw = r.plaque.w;
    if (!s) {
      const label = 'ROOM ' + (r.i + 1);
      box(g, px, py + 1, textW(label) + 4, 9, C.void, C.metal);
      g.drawImage(textSprite(label, C.metalHi), px + 2, py + 3);
      return;
    }
    const tool = toolOf(s.tool), subs = s.subagents || [];
    const [done, total] = crewCount(s);
    const allDone = total > 0 && done === total;
    const wait = s.status === 'waiting' && Math.floor(t * 3) % 2 === 0;
    const cnt = total ? done + '/' + total : '';
    const cntW = cnt ? textW(cnt) + 3 : 0;
    box(g, px, py, pw, 11, wait ? C.hot : C.void, wait ? C.ink : tool.base);
    drawIcon(g, 'star', px + 2, py + 2, wait ? C.ink : C.gold);
    const room = Math.max(1, Math.floor((pw - 8 - 1 - cntW + 1) / 4));
    g.drawImage(textSprite(norm(s.name || '?').slice(0, room), wait ? C.ink : C.white), px + 8, py + 2);
    if (cnt) { // the count sits on its own tool-coloured tab so it never runs into the name
      fill(g, px + pw - cntW, py + 1, cntW - 1, 7, wait ? C.ink : allDone ? C.green : C.white);
      g.drawImage(textSprite(cnt, wait ? C.hot : C.ink), px + pw - cntW + 1, py + 2);
    }
    if (total) pips(subs, px + 2, py + 8, pw - 4, tool, t);
  }

  function draw(t, now) {
    if (!L || !bg) { ctx.fillStyle = C.ink; ctx.fillRect(0, 0, cw, ch); return; }
    g.drawImage(bg, 0, 0);
    // -- pass A: floor-level dynamics
    for (const r of L.rooms) {
      const owner = roomOwner[r.i], s = owner && sessions.get(owner);
      if (s) {
        const colsN = Math.floor((r.board.w - 4) / 4);
        const lines = wrap(norm(s.title || ''), colsN, 3);
        lines.forEach((ln, i) => g.drawImage(textSprite(ln, C.ink), r.board.x + 3, r.board.y + 2 + i * 6));
        fill(g, r.board.x + 1, r.board.y + 1, 1, r.board.h - 2, toolOf(s.tool).base);
      } else {
        g.globalAlpha = 0.5; fill(g, r.x, WALL, r.w, r.h + TOPF - WALL, C.void); g.globalAlpha = 1;
      }
    }
    const waiting = [];
    for (const a of actors.values()) if (a.kind === 'agent' && !a.leaving && a.data?.status === 'waiting') waiting.push(a);
    const pulse = 0.5 + 0.5 * Math.sin(t * 7);
    // a waiting desk lights its own cell only (its neighbour in the pair stays clean); a waiting boss lights the room
    for (const a of waiting) {
      const d = deskAt(a), r = roomAt(a);
      g.globalAlpha = 0.24 + 0.2 * pulse;
      if (d) fill(g, d.x, d.y, DESK_W, DESK_H + 1, C.hot);
      else if (r) fill(g, r.x, r.y, r.w, r.h, C.hot);
      else fill(g, Math.round(a.x) - 10, Math.round(a.y) - 21, 20, 24, C.hot);
      g.globalAlpha = 1;
    }
    if (hoverRec) { const rc = L.reception; g.globalAlpha = 0.3; fill(g, rc.x - 2, rc.y - 2, rc.w + 4, rc.h + 6, C.white); g.globalAlpha = 1; }

    // -- pass B: y-sorted props and actors
    const items = [];
    for (const d of L.desks) { items.push({ y: d.y + 9, k: 0, d }); items.push({ y: d.y + DESK_H, k: 1, d }); }
    for (const p of L.props) items.push({ y: p.base, k: 2, p });
    for (const r of L.rooms) items.push({ y: r.table.y + r.table.h, k: 3, r });
    for (const a of actors.values()) items.push({ y: a.y + 0.5, k: 4, a });
    items.sort((p, q) => p.y - q.y || p.k - q.k);
    for (const it of items) {
      if (it.k === 0) g.drawImage(deskBackSpr, it.d.x, it.d.y);
      else if (it.k === 1) drawDeskFront(it.d, t);
      else if (it.k === 2) { const sp = propSprite(it.p.type); g.drawImage(sp, it.p.x, it.p.y + PROPS[it.p.type].oy); }
      else if (it.k === 3) drawTable(it.r, t);
      else drawActor(it.a, t);
    }

    // -- pass C: overlays (always on top)
    for (const r of L.rooms) {
      drawPlaque(r, t);
      const owner = roomOwner[r.i], over = owner && subOver.get(owner);
      if (over) { // crew that did not get a chair
        const label = '+' + over, w = textW(label) + 4;
        box(g, r.x + r.w - w - 1, TOPF + 1, w, 9, C.void, toolOf(sessions.get(owner)?.tool).base);
        g.drawImage(textSprite(label, C.white), r.x + r.w - w + 1, TOPF + 3);
      }
    }
    // reception sign
    {
      const rc = L.reception, lit = hoverRec || Math.floor(t * 1.5) % 2 === 0;
      const sw = textW('NEW TASK') + 13, sx = rc.x + ((rc.w - sw) >> 1), sy = rc.y - 23;
      box(g, sx, sy, sw, 11, hoverRec ? C.hot : C.void, hoverRec ? C.ink : C.white);
      fill(g, sx + (sw >> 1) - 1, sy + 11, 2, 3, C.white);
      drawIcon(g, 'plus', sx + 3, sy + 3, hoverRec ? C.ink : lit ? C.hot : C.white);
      g.drawImage(textSprite('NEW TASK', hoverRec ? C.ink : C.white), sx + 10, sy + 3);
    }
    // waiting frames + pings
    for (const a of waiting) {
      const d = deskAt(a), r = roomAt(a);
      const ph = (t * 0.9 + a.phase * 0.13) % 1;
      if (d) {
        // a desk keeps its alarm inside its own cell: the frame beats, nothing spills onto the pair partner or the row above
        const x = d.x, y = d.y, w = DESK_W, h = DESK_H + 1;
        g.globalAlpha = 0.55 + 0.45 * pulse; frame(g, x, y, w, h, C.hot);
        if (ph < 0.5) { g.globalAlpha = 1 - ph * 2; frame(g, x + 1, y + 1, w - 2, h - 2, C.hot); }
        g.globalAlpha = 1;
        continue;
      }
      const [x, y, w, h] = r ? [r.x, r.y, r.w, r.h] : [Math.round(a.x) - 9, Math.round(a.y) - 20, 18, 23];
      g.globalAlpha = 0.55 + 0.45 * pulse; frame(g, x - 1, y - 1, w + 2, h + 2, C.hot); g.globalAlpha = 1;
      const e = 2 + Math.floor(ph * 8);
      g.globalAlpha = (1 - ph) * 0.9; frame(g, x - e, y - e, w + 2 * e, h + 2 * e, C.hot); g.globalAlpha = 1;
    }
    const bang = bangSprites();
    for (const a of actors.values()) {
      const sub = a.kind === 'sub', s = a.data || {};
      const ax = Math.round(a.x), top = Math.round(a.y) - (sub ? SUB_H : SPR_H);
      if (a.alpha < 0.5) continue;
      if (sub) {
        if (a.moving) continue;
        // result badge on the corner of the helmet
        if (s.status === 'done') { box(g, ax, top - 2, 7, 7, C.green); drawIcon(g, 'check', ax + 1, top - 1, C.ink); }
        else if (s.status === 'failed') { box(g, ax, top - 2, 7, 7, C.red); drawIcon(g, 'cross', ax + 1, top - 1, C.white); }
        continue;
      }
      if (a.leaving) continue;
      const tool = toolOf(s.tool);
      const d = a.seatKind === 'desk' && !a.moving ? L.desks[deskOf.get(a.id)] : null;
      if (s.status === 'waiting') {
        const fl = Math.floor(t * 4) % 2, bobY = Math.floor(t * 4) % 4 === 0 ? -1 : 0;
        // at a desk the sign is held up beside the head, inside the desk's own cell (it must not cover the caption of the row above)
        if (d) g.drawImage(bang[fl], d.x + 23, d.y - 1 + bobY);
        else g.drawImage(bang[fl], ax - 5, top - 13 + bobY - (a.seatKind === 'boss' ? 4 : 0));
      } else if (s.status === 'idle' && !a.moving && (a.seat?.kind === 'doze' || d)) {
        const ph = (t * 0.7 + a.phase * 0.21) % 1;
        g.globalAlpha = 1 - ph; g.drawImage(textSprite('Z', C.white), ax + 3 + Math.round(ph * 3), top - 3 - Math.round(ph * 7));
        const p2 = (ph + 0.5) % 1;
        g.globalAlpha = 1 - p2; g.drawImage(textSprite('Z', C.dim), ax + 3 + Math.round(p2 * 3), top - 3 - Math.round(p2 * 7));
        g.globalAlpha = 1;
      } else if (s.status === 'working' && !a.moving && !d) { // at a desk the monitor carries the icon
        const cx = ax + 8, cy = top + 1;
        box(g, cx, cy, 9, 9, C.ink, tool.base);
        const kind = s.activity?.kind || 'thinking';
        if (kind === 'thinking') { const n = Math.floor(t * 3 + a.phase) % 3; for (let i = 0; i < 3; i++) fill(g, cx + 2 + i * 2, cy + 4, 1, 1, i === n ? C.white : C.metal); }
        else drawIcon(g, kind, cx + 2, cy + 2, C.white);
      }
    }
    // hover + selection markers
    const mark = (id, col, arrow) => {
      const a = actors.get(id);
      if (!a) return;
      const sub = a.kind === 'sub', hh = sub ? SUB_H : SPR_H, ax = Math.round(a.x), ay = Math.round(a.y);
      if (arrow && a.kind === 'agent' && !a.moving && a.seatKind === 'desk') { const d = L.desks[deskOf.get(a.id)]; frame(g, d.x - 2, d.y - 2, DESK_W + 4, DESK_H + 4, C.ink); frame(g, d.x - 1, d.y - 1, DESK_W + 2, DESK_H + 2, col); }
      else corners(g, ax - 8, ay - hh - 2, 16, hh + 4, col, 4);
      if (arrow) {
        const atDesk = a.seatKind === 'desk' && !a.moving;
        const by = ay - hh - 9 - (Math.floor(t * 4) % 2) - (a.data?.status === 'waiting' && !atDesk ? 13 : 0) - (a.seatKind === 'boss' || a.deskBoss ? 4 : 0);
        fill(g, ax - 4, by - 1, 8, 3, C.ink); fill(g, ax - 3, by + 2, 6, 2, C.ink); fill(g, ax - 2, by + 4, 4, 2, C.ink); fill(g, ax - 1, by + 5, 2, 2, C.ink);
        fill(g, ax - 3, by, 6, 2, col); fill(g, ax - 2, by + 2, 4, 2, col); fill(g, ax - 1, by + 4, 2, 2, col);
      }
    };
    if (hover && hover !== selected) mark(hover, C.dim, false);
    if (selected) {
      mark(selected, C.white, true);
      const a = actors.get(selected), age = t - selAt;
      if (a && age < 0.7) { // "here!" ring so the eye finds a selection made from the list
        const e = 4 + Math.floor(age * 40), ax = Math.round(a.x), ay = Math.round(a.y) - 8;
        g.globalAlpha = 1 - age / 0.7; frame(g, ax - e, ay - e, 2 * e, 2 * e, C.white); frame(g, ax - e - 1, ay - e - 1, 2 * e + 2, 2 * e + 2, C.white); g.globalAlpha = 1;
      }
    }

    // -- blit (through the camera tween while one plan hands over to the next)
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = C.ink;
    ctx.fillRect(0, 0, cw, ch);
    const p = tw ? Math.min(1, (now - tw.t0) / tw.dur) : 1;
    if (p >= 1) { tw = null; ctx.drawImage(buf, 0, 0, L.W, L.H, offX, offY, L.W * k, L.H * k); return; }
    const e = p * p * (3 - 2 * p), kk = tw.fk + (k - tw.fk) * e;
    // both plans are pinned to their first desk, so the desks that keep their place also keep it on screen
    const sx = tw.fx + tw.oax * tw.fk + (offX + tw.ax * k - tw.fx - tw.oax * tw.fk) * e;
    const sy = tw.fy + tw.oay * tw.fk + (offY + tw.ay * k - tw.fy - tw.oay * tw.fk) * e;
    ctx.drawImage(buf, 0, 0, L.W, L.H, sx - tw.ax * kk, sy - tw.ay * kk, L.W * kk, L.H * kk);
    ctx.globalAlpha = 1 - Math.min(1, e * 1.6);
    ctx.drawImage(tw.snap, 0, 0, tw.snap.width, tw.snap.height, sx - tw.oax * kk, sy - tw.oay * kk, tw.snap.width * kk, tw.snap.height * kk);
    ctx.globalAlpha = 1;
  }

  function loop(now) {
    if (dead) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    try {
      const a = performance.now();
      update(dt); draw((now - t0) / 1000, performance.now());
      frameMs += (performance.now() - a - frameMs) * 0.05; frames++;
    } catch (err) { console.error('[floorplan] frame error', err); }
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  /* ---- interaction */
  function pick(lx, ly) {
    if (!L) return null;
    const rc = L.reception;
    if (lx >= rc.x - 4 && lx <= rc.x + rc.w + 4 && ly >= rc.y - 24 && ly <= rc.y + rc.h + 4) return { type: 'reception' };
    let best = null;
    for (const a of actors.values()) {
      if (a.leaving) continue;
      const sub = a.kind === 'sub', hw = sub ? 6 : 7, hh = (sub ? SUB_H : SPR_H) + 2;
      if (lx >= a.x - hw && lx <= a.x + hw && ly >= a.y - hh && ly <= a.y + 2 && (!best || a.y > best.y)) best = a;
    }
    if (best) return { type: 'actor', id: best.id };
    const mine = (id) => id && sessions.has(id);
    for (const d of L.desks) if (mine(deskOwner[d.i]) && lx >= d.x && lx < d.x + DESK_W && ly >= d.y - 2 && ly < d.y + DESK_H + 6) return { type: 'actor', id: deskOwner[d.i] };
    for (const r of L.rooms) if (mine(roomOwner[r.i]) && lx >= r.x && lx < r.x + r.w && ly >= WALL && ly < r.y + r.h + WALL + 6) return { type: 'actor', id: roomOwner[r.i] };
    return null;
  }
  const toLogical = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sx = cw / (rect.width || 1), sy = ch / (rect.height || 1);
    return [((ev.clientX - rect.left) * sx - offX) / k, ((ev.clientY - rect.top) * sy - offY) / k, ((ev.clientX - rect.left) * sx) / dpr, ((ev.clientY - rect.top) * sy) / dpr];
  };
  function onMove(ev) {
    const [lx, ly, x, y] = toLogical(ev);
    const hit = pick(lx, ly);
    hover = hit?.type === 'actor' ? hit.id : null;
    hoverRec = hit?.type === 'reception';
    canvas.style.cursor = hit ? 'pointer' : 'default';
    cb.onHover?.(hit, x, y);
  }
  function onLeave() { hover = null; hoverRec = false; cb.onHover?.(null, 0, 0); }
  function onClick(ev) {
    const [lx, ly] = toLogical(ev);
    const hit = pick(lx, ly);
    if (hit?.type === 'reception') cb.onReception?.();
    else cb.onSelect?.(hit ? hit.id : null);
  }
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('click', onClick);

  let rz = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (!dead) onResize(); }); });
  ro.observe(canvas.parentElement);

  return {
    setState,
    select(id) { if ((id || null) !== selected) selAt = (performance.now() - t0) / 1000; selected = id || null; },
    resize: onResize,
    info() { return L ? { scale: k / dpr, W: L.W, H: L.H, cap: L.cap, built: L.built, rows: L.rows, maxRows: L.maxRows, pitchRows: L.pitchRows, perRow: L.perRow, pitch: L.pitch, confH: L.confH, replans, tween: !!tw, actors: actors.size, frameMs: Math.round(frameMs * 100) / 100, frames } : null; },
    debug() { return [...actors.values()].map((a) => ({ id: a.id, x: Math.round(a.x), y: Math.round(a.y), kind: a.seatKind, desk: deskOf.get(a.id), room: a.kind === 'sub' ? a.room : roomOf.get(a.id), moving: a.moving, leaving: a.leaving, route: a.route.length, alpha: a.alpha })); },
    /** Logical -> CSS px inside the map, for tests. */
    toScreen(x, y) { return [(offX + x * k) / dpr, (offY + y * k) / dpr]; },
    layout() { return L; },
    destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); canvas.removeEventListener('click', onClick); },
  };
}
