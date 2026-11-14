// The office itself: the cached static layer (walls, floors, wall furniture), the y-sorted floor
// furniture, and the small animated bits that live on the wall.
import { K, WHITE, C, toolOf } from './palette.js';
import { R, box, makeCanvas, ctx2d, hash, hexToRgb } from './util.js';
import { props, drawWindow, drawPoster, drawSign } from './props.js';
import { drawText, textSprite, textWidth, clipText, norm, SMALL, BIG } from './font.js';
import { G, ROOMS_X, LOUNGE_X, seatPos, tableRect } from './layout.js';
import { FOOT } from './sprites.js';

/** 16x16 floor tile used both inside the world and for the endless floor around it. */
export function floorTile() {
  const c = makeCanvas(16, 16);
  const g = ctx2d(c);
  R(g, C.floor, 0, 0, 16, 16);
  R(g, C.floorLine, 0, 15, 16, 1);
  R(g, C.floorLine, 15, 0, 1, 16);
  R(g, C.floorDot, 4, 5, 1, 1);
  R(g, C.floorDot, 11, 10, 1, 1);
  return c;
}

function wallBase(g, x, w, kind) {
  const wall = kind === 'room' ? C.wallRoom : kind === 'break' ? C.wallBreak : C.wall;
  const shade = kind === 'room' ? C.wallRoomShade : kind === 'break' ? C.wallBreakShade : C.wallShade;
  R(g, wall, x, 0, w, G.WALL);
  R(g, C.baseboard, x, 0, w, 2);
  R(g, shade, x, 2, w, 1);
  if (kind === 'break') {
    // tiled splashback
    R(g, WHITE, x, 37, w, 9);
    for (let i = x; i < x + w; i += 6) R(g, '#c8c8d8', i, 37, 1, 9);
    R(g, '#c8c8d8', x, 41, w, 1);
    R(g, K, x, 36, w, 1);
  } else {
    R(g, shade, x, 37, w, 1);
    R(g, kind === 'room' ? C.wallRoomShade : C.wainscot, x, 38, w, 8);
    if (kind !== 'room') for (let i = x + 5; i < x + w; i += 12) R(g, C.wainscotShade, i, 39, 1, 6);
  }
  R(g, C.baseboard, x, 46, w, 3);
  R(g, K, x, 49, w, 1);
}

/** Wall strip that repeats outside the world (192px wide). */
export function outerWallTile(sky) {
  const c = makeCanvas(192, G.WALL);
  const g = ctx2d(c);
  wallBase(g, 0, 192, 'plain');
  drawWindow(g, 14, 10, 34, 22, sky, 1);
  drawPoster(g, 66, 7, 0);
  drawWindow(g, 110, 10, 34, 22, sky, 3);
  drawPoster(g, 160, 7, 2);
  return c;
}

function checker(g, x, y, w, h, a, b, s) {
  R(g, a, x, y, w, h);
  g.fillStyle = b;
  for (let j = 0; j * s < h; j++) {
    for (let i = (j % 2); i * s < w; i += 2) {
      g.fillRect(x + i * s, y + j * s, Math.min(s, w - i * s), Math.min(s, h - j * s));
    }
  }
}

function tileFill(g, tile, x, y, w, h) {
  g.save();
  g.fillStyle = g.createPattern(tile, 'repeat');
  g.fillRect(x, y, w, h);
  g.restore();
}

/**
 * Everything that never changes for a given layout + sky.
 * @returns {HTMLCanvasElement} opaque canvas, L.W x L.H, at world origin
 */
export function renderStatic(L, sky, tile) {
  const p = props();
  const c = makeCanvas(L.W, L.H);
  const g = ctx2d(c);
  const fy = G.WALL;

  // ---- floors
  tileFill(g, tile, 0, fy, L.W, L.H - fy);
  // (no carpet here: every pod lies on its own rug, exactly as big as its desks: see buildProps)
  // walkway
  R(g, C.walk, 0, G.BAND, L.W, G.BULL - G.BAND);
  R(g, C.walkLine, 0, G.BAND, L.W, 1);
  R(g, C.walkLine, 0, G.BULL - 1, L.W, 1);
  for (let x = 6; x < L.W; x += 24) R(g, C.walkLine, x, G.WALK - 1, 10, 1);
  // lobby
  checker(g, 0, fy, G.LOBBY, G.BAND - fy, C.lobbyA, C.lobbyB, 8);
  box(g, 5, fy + 2, 24, 9, C.mat, C.matShade);
  R(g, C.matShade, 8, fy + 6, 18, 1);
  // lounge: warm tiles under the lobby, a rug under the couch
  const lg = L.lounge;
  checker(g, lg.x, lg.y + 1, lg.w - 4, lg.h - 2, C.tileA, C.tileB, 8);
  R(g, K, lg.x + lg.w - 4, lg.y + 1, 1, lg.h - 2);
  R(g, K, lg.x, lg.y, lg.w - 3, 1);
  R(g, K, lg.x, lg.y + lg.h - 1, lg.w - 3, 1);
  // rooms
  for (const r of L.rooms) {
    R(g, C.carpet, r.x, fy, G.ROOM, G.BAND - fy);
    g.fillStyle = C.carpetDot;
    for (let y = fy + 3; y < G.BAND - 1; y += 5) {
      for (let x = r.x + 4 + (((y - fy) / 5) % 2 | 0) * 3; x < r.x + G.ROOM - 3; x += 6) g.fillRect(x, y, 1, 1);
    }
    // door mat on the walkway side
    R(g, C.walkLine, r.x + 95, G.BAND, 11, 2);
  }

  // ---- walls
  wallBase(g, 0, G.LOBBY, 'plain');
  for (const r of L.rooms) wallBase(g, r.x, G.ROOM, 'room');
  const topEnd = L.roomsRight;
  if (L.W > topEnd) {
    wallBase(g, topEnd, L.W - topEnd, 'plain');
    let i = 0;
    for (let x = topEnd + (L.util ? G.UTIL : 10); x + 36 < L.W; x += 48, i++) {
      if (i % 2 === 0) drawWindow(g, x, 10, 34, 22, sky, i + 2);
      else drawPoster(g, x + 2, 7, i + 2);
    }
  }
  R(g, K, ROOMS_X, 0, 1, G.WALL);

  // lobby wall
  drawSign(g, 5, 0, 'LOBBY', '#1c7018', WHITE);

  // rooms: whiteboard, glass side walls
  for (const r of L.rooms) {
    g.drawImage(p.whiteboard, r.x + 4, 20);
    for (const x of [r.x, r.x + G.ROOM - 2]) {
      R(g, C.wallRoomShade, x, 2, 2, 46);
      R(g, C.glassDark, x, fy, 2, G.BAND - fy);
      R(g, C.glassFrame, x, fy, 1, G.BAND - fy);
      R(g, K, x, G.BAND - 1, 2, 1);
    }
  }
  return c;
}

// ---------------------------------------------------------------- animated wall bits

function drawScreen(g, x, y, w, h, mode, T, t, seed, still) {
  if (mode === 'on') {
    R(g, T.light, x, y, w, h);
    const scroll = still ? 0 : Math.floor(t * 3 + seed);
    g.fillStyle = T.shade;
    for (let r = 0; r * 2 + 1 < h; r++) {
      const hh = hash(`${seed}/${r + scroll}`);
      const ind = (hh % 3) * 2;
      const len = 3 + ((hh >>> 4) % (w - 7));
      g.fillRect(x + 1 + ind, y + 1 + r * 2, Math.min(len, w - 2 - ind), 1);
    }
    if (still || Math.floor(t * 2) % 2) R(g, K, x + w - 3, y + h - 2, 2, 1);
  } else if (mode === 'wait') {
    R(g, WHITE, x, y, w, h);
    R(g, T.base, x, y, w, 1);
    R(g, T.base, x, y + h - 1, w, 1);
    drawText(g, '>', x + 2, y + 3, K, SMALL);
    if (still || Math.floor(t * 2.5) % 2) R(g, K, x + 7, y + 7, 4, 1);
  } else if (mode === 'away') {
    R(g, T.shade, x, y, w, h);
    const tt = still ? 3 : t * 5 + seed;
    const bx = Math.abs(((tt % (2 * (w - 3))) | 0) - (w - 3));
    const by = Math.abs((((tt * 0.7) % (2 * (h - 3))) | 0) - (h - 3));
    R(g, T.light, x + bx, y + by, 2, 2);
  }
}

/**
 * Draw the things on the wall that change: door, clock hands, arcade screen, banners, whiteboards.
 * env: { t, still, doorOpen, room(i) -> info|null }
 */
export function drawWallLife(g, L, env) {
  const p = props();
  g.drawImage(env.doorOpen ? p.doorOpen : p.doorClosed, 4, 9);
  // a wall clock above the printer, showing the real time (it moves once a minute: alive, never busy)
  if (L.util && !(env.cover > L.util.x + 26)) {
    const cx = L.util.x + 32;
    const cy = 8;
    g.drawImage(p.clock, cx, cy);
    const now = env.date || new Date();
    const hand = (turn, len, col) => {
      const a = turn * Math.PI * 2;
      for (let k = 1; k <= len; k++) R(g, col, cx + 6 + Math.round(Math.sin(a) * k), cy + 6 - Math.round(Math.cos(a) * k), 1, 1);
    };
    hand((now.getHours() % 12) / 12 + now.getMinutes() / 720, 2, K);
    hand(now.getMinutes() / 60, 4, '#3c4658');
    R(g, K, cx + 6, cy + 6, 1, 1);
  }

  for (const r of L.rooms) {
    const info = env.room(r.i);
    // a room that is closing ranks slides to its new place: everything in it is drawn that far off
    const rx = r.x + Math.round(env.off(`room:${r.i}`).x);
    // banner: two lines across the whole room, "NAME  done/total DONE" over the job title
    const bx = rx + 3;
    const bw = G.ROOM - 6;
    if (info) {
      // tool badge, star, name and how many helpers are done, over the task name: the banner is the boss's
      // name tag. Needs you = the whole plate turns yellow (dark text), like every other name tag.
      const T = toolOf(info.tool);
      const lit = info.waiting;
      const ink = lit ? C.alertInk : WHITE;
      box(g, bx, 1, bw, 18, lit ? (env.flash ? C.alert : C.alertDim) : K, info.sel || info.hot ? WHITE : lit ? K : T.base);
      R(g, T.base, bx + 1, 2, 9, 9);
      drawText(g, T.badge, bx + 2, 4, T.ink, SMALL);
      R(g, K, bx + 10, 2, 1, 9);
      g.drawImage(lit ? p.starInk : p.star, bx + 11, 2);
      let right = bx + bw - 2;
      if (info.total) {
        const count = `${info.done}/${info.total} DONE`;
        right -= textWidth(count, SMALL);
        g.drawImage(textSprite(count, lit ? C.alertInk : info.done === info.total ? '#8ce878' : info.done ? WHITE : C.tagDim, SMALL), right, 4);
        right -= 3;
      }
      if (info.quiet) {
        right -= 7;
        g.drawImage(p.quiet, right, 2);
        right -= 2;
      }
      const name = clipText(info.name, right - (bx + 21), BIG);
      g.drawImage(textSprite(name, lit ? C.alertInk : T.light, BIG), bx + 21, 3);
      let tw = bw - 6;
      if (info.group) {
        // the group's colours run along the bottom edge, like on every name tag, and its name sits on a chip
        // at the end of the second line (inside the banner, so it never crowds the helpers' name tags)
        const gc = info.group;
        const label = clipText(info.groupName || '', 34, SMALL);
        if (label) {
          const cw = textWidth(label, SMALL) + 4;
          const cx = bx + bw - 1 - cw;
          // (dark chip, light text: a group's colour is never a bright filled plate; the stripe below carries it)
          R(g, K, cx - 1, 11, 1, 7);
          R(g, gc.dark, cx, 11, cw, 7);
          drawText(g, label, cx + 2, 12, gc.tint, SMALL);
          tw -= cw + 2;
        }
        R(g, gc.base, bx + 1, 18, bw - 2, 2);
        R(g, K, bx, 18, 1, 3);
        R(g, K, bx + bw - 1, 18, 1, 3);
        R(g, K, bx, 20, bw, 1);
      }
      g.drawImage(textSprite(clipText(info.title, tw, SMALL), ink, SMALL), bx + 3, 12);
      if (info.sel) brackets(g, bx, 1, bw, info.group ? 20 : 18);
    } else {
      box(g, bx, 1, bw, 11, '#2c2840', '#4c4868');
      g.drawImage(textSprite(`ROOM ${r.i + 1} · FREE`, '#8c88a8', SMALL), bx + 4, 4);
    }
    // whiteboard = status board, one cell per helper
    const wx = rx + 6;
    const wy = 22;
    if (info) {
      const T = toolOf(info.tool);
      R(g, T.base, wx + 2, wy + 1, 14, 1);
      R(g, '#b8b8c8', wx + 18, wy + 1, 8, 1);
      for (let k = 0; k < G.SEATS; k++) {
        const s = info.seats[k];
        if (!s) continue;
        const x = wx + 2 + (k % 4) * 7;
        const y = wy + 4 + (k < 4 ? 0 : 7);
        const col = s.status === 'done' ? C.ok : s.status === 'failed' ? C.bad : T.base;
        box(g, x, y, 6, 6, col, K);
        if (s.status === 'working') {
          const on = env.still || Math.floor(env.t * 2 + k) % 2;
          R(g, on ? WHITE : T.light, x + 2, y + 2, 2, 2);
        } else R(g, WHITE, x + 2, y + 3, 2, 1);
      }
    } else {
      R(g, '#d8d8e0', wx + 3, wy + 4, 12, 1);
      R(g, '#d8d8e0', wx + 3, wy + 8, 20, 1);
      R(g, '#d8d8e0', wx + 3, wy + 12, 9, 1);
    }
  }
}

/**
 * Selection brackets: white corners just outside a box, each backed in dark so they show on any floor,
 * wall or plate colour.
 */
export function brackets(g, x, y, w, h, n = 4) {
  const x0 = x - 2;
  const y0 = y - 2;
  const x1 = x + w + 1;
  const y1 = y + h + 1;
  const corners = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]];
  for (const [cx, cy, sx, sy] of corners) {
    R(g, K, Math.min(cx, cx + sx * n) - 1, cy - 1, n + 3, 3);
    R(g, K, cx - 1, Math.min(cy, cy + sy * n) - 1, 3, n + 3);
  }
  for (const [cx, cy, sx, sy] of corners) {
    R(g, WHITE, Math.min(cx, cx + sx * n), cy, n + 1, 1);
    R(g, WHITE, cx, Math.min(cy, cy + sy * n), 1, n + 1);
  }
}

// ---------------------------------------------------------------- y-sorted floor furniture

const DESK_ITEMS = ['mug', 'duck', 'sprout', 'papers', null];
const LOUNGE_SIGN = { base: '#b47848', dark: '#5c3418', tint: '#fcecc8', ink: '#fcecc8' };
export const LOUNGE_SIGN_X = 25;

const PLATE_W = 36; // text width of the name plate on a desk front (the desk is 38 wide)
const PLATE_INK = '#3c2c14';
const plateCache = new Map();

/**
 * Where a name may be broken: after a space, dash, underscore, dot, slash or colon, and between the words
 * of a camelCase name (looked for in the text as written, before it is upper-cased for the font).
 */
function breakPoints(raw) {
  const cuts = [];
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const c = raw[i];
    if (' -_./:'.includes(a) && !' -_./:'.includes(c)) cuts.push(i);
    else if (/[a-z0-9]/.test(a) && /[A-Z]/.test(c)) cuts.push(i);
    else if (/[A-Za-z]/.test(a) && /[0-9]/.test(c)) cuts.push(i);
  }
  return cuts;
}

/**
 * Text for the name plate on the desk front: the task's own name when the user gave it one, else the
 * project. One line when it fits (9 characters or so). Else two lines, broken at a word boundary (space,
 * dash, underscore, dot, camelCase) so that the first line fits; a second line that is still too long ends
 * in "…". A name with no such boundary near enough its start is never split in the middle of a word: it
 * stays on one line and ends in "…" (the tooltip has the whole name).
 * @returns {string[]} 0, 1 or 2 lines
 */
export function plaqueLines(text) {
  const key = String(text || '');
  let lines = plateCache.get(key);
  if (lines) return lines;
  if (plateCache.size > 400) plateCache.clear();
  const raw = key.trim().replace(/\s+/g, ' ');
  const name = norm(raw);
  if (!name) lines = [];
  else if (textWidth(name, SMALL) <= PLATE_W) lines = [name];
  else {
    let cut = -1;
    if (name.length === raw.length) {
      for (const i of breakPoints(raw)) {
        if (textWidth(name.slice(0, i).trimEnd(), SMALL) > PLATE_W) break;
        cut = i;
      }
    }
    if (cut < 2) lines = [clipText(name, PLATE_W, SMALL)];
    else lines = [name.slice(0, cut).trimEnd(), clipText(name.slice(cut).trimStart(), PLATE_W, SMALL)];
  }
  plateCache.set(key, lines);
  return lines;
}
/** Kept for callers of the old one-line plaque: the first line of the plate. */
export function plaqueText(text) {
  return plaqueLines(text)[0] || '';
}

// ---------------------------------------------------------------- group pods: rug + standing sign

const CARPET_GREY = '#a4a0b4';
/** Blend two #rrggbb colours: k = 0 gives a, 1 gives b. */
function mix(a, b, k) {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('');
}
const rugCache = new Map();
/** A pod's floor rug: the group's light tint, edged in its dark shade. */
export function rugSprite(col, w, h) {
  const key = `${col.tint}|${col.dark}|${w}|${h}`;
  let c = rugCache.get(key);
  if (c) return c;
  if (rugCache.size > 60) rugCache.clear();
  c = makeCanvas(w, h);
  const g = ctx2d(c);
  R(g, col.dark, 0, 0, w, h);
  R(g, col.base, 1, 1, w - 2, h - 2);
  // the tint is taken a third of the way to carpet grey: a tinted carpet, not a pastel plate (no rug is
  // anywhere near the "needs you" yellow or a tool's badge colour)
  R(g, mix(col.tint, CARPET_GREY, 0.3), 2, 2, w - 4, h - 4);
  // a woven look: sparse stitches in the base colour
  g.fillStyle = col.base;
  for (let y = 5; y < h - 4; y += 6) {
    for (let x = 5 + ((y / 6) & 1) * 4; x < w - 5; x += 8) g.fillRect(x, y, 2, 1);
  }
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) g.clearRect(x, y, 1, 1);
  rugCache.set(key, c);
  return c;
}

const signCache = new Map();
/**
 * A low standing sign: NAME plus a member count. The plate is dark (the group's dark shade) with the name in
 * the group's light tint and a thin stripe of the group colour along the foot: a group's colour is never a
 * bright filled plate, so no sign can be taken for "needs you" or for a tool badge. The name is set in the
 * big font when it fits in `maxW` (a sign may be wider than its pod: the office passes how far it can
 * overhang), else in the small font, and only a name too long for that ends in "…" (`.clipped` is then
 * true, and the office shows the whole name while the pointer is on the sign).
 */
export function signSprite(name, count, col, maxW, hot = false) {
  const key = `${name}|${count}|${col.base}|${maxW}|${hot ? 1 : 0}`;
  let c = signCache.get(key);
  if (c) return c;
  if (signCache.size > 200) signCache.clear();
  const n = count == null ? '' : String(count);
  const cw = n ? textWidth(n, BIG) + 4 : 0;
  const room = Math.max(8, maxW - 7 - cw);
  const whole = norm(name);
  const font = textWidth(whole, BIG) <= room ? BIG : SMALL;
  const label = clipText(whole, room, font);
  const w = 3 + textWidth(label, font) + 3 + cw + 1;
  const ph = BIG.h + 4;
  c = makeCanvas(w, ph + 1);
  const g = ctx2d(c);
  box(g, 0, 0, w, ph, col.dark, hot ? WHITE : K);
  R(g, col.base, 1, ph - 3, w - 2, 2);
  drawText(g, label, 3, font === BIG ? 2 : 3, col.tint, font);
  if (n) {
    R(g, K, w - 1 - cw, 1, cw, ph - 2);
    drawText(g, n, w - cw + 1, 2, WHITE, BIG);
  }
  R(g, K, 3, ph, 2, 1);
  R(g, K, w - 5, ph, 2, 1);
  c.clipped = label !== whole;
  signCache.set(key, c);
  return c;
}

/** Where a pod's rug goes (world px, before any slide offset): from under its sign to the end of its floor. */
export function podRect(L, pod) {
  return { x: pod.x - 3, y: pod.y + 2, w: pod.uw + 4, h: pod.bottom - (pod.y + 2) };
}
/** Bottom edge of a pod's sign: it stands on the strip of floor above the pod's first desk row. */
export const signBottom = (pod) => pod.y + 5;
export const SIGN_H = BIG.h + 5;
export const SIGN_BOTTOM = G.BULL + 5;
export const LOUNGE_SIGN_W = 70;

const ZERO = { x: 0, y: 0 };

/**
 * @returns {{y:number, draw:(g:CanvasRenderingContext2D, env:object)=>void}[]} y-sorted furniture; its
 *   `.floor` property lists the things painted on the floor first (rugs).
 * env: { t, still,
 *        desk(d) -> {tool, text, seed, mode:'on'|'wait'|'away'}|null   (null = nobody's desk),
 *        off(id) -> {x,y}        how far a desk ('pod/i'), a pod ('pod:key') or a room ('room:i') still is from its place,
 *        flash                   the shared "needs you" phase (true = bright), cover = x up to which sliding rooms hide the hallway,
 *        pod(key) -> {name, count, col, rug:boolean, hot}|null         (null = no sign, no rug),
 *        loungeOff               same for the couch,
 *        room(i) -> info|null }
 */
export function buildProps(L) {
  const p = props();
  const list = [];
  const floor = [];
  list.floor = floor;

  for (const pod of L.pods) {
    const r = podRect(L, pod);
    floor.push({
      draw: (g, env) => {
        const info = env.pod(pod.key);
        if (!info || !info.rug) return;
        const o = env.off(`pod:${pod.key}`) || ZERO;
        if (o.hide) return; // a new pod: laid out once its neighbours have slid aside
        g.drawImage(rugSprite(info.rugCol || info.col, r.w, r.h), r.x + Math.round(o.x), r.y + Math.round(o.y));
      },
    });
    list.push({
      y: signBottom(pod) - 0.5,
      draw: (g, env) => {
        const info = env.pod(pod.key);
        if (!info || !info.sign) return;
        const o = env.off(`pod:${pod.key}`) || ZERO;
        if (o.hide) return;
        const spr = signSprite(info.name, info.count, info.col, pod.signMax, info.hot);
        g.drawImage(spr, pod.x - 2 + Math.round(o.x), signBottom(pod) - spr.height + Math.round(o.y));
      },
    });
  }

  for (const d of L.desks) {
    list.push({
      y: d.seat.y - 0.5,
      draw: (g, env) => {
        const o = env.off(d.id) || ZERO;
        if (o.hide) return;
        const info = env.desk(d);
        // nobody sitting here: the chair is pushed in under the desk
        const tucked = !info || info.mode === 'away';
        g.drawImage(p.chair, d.seat.x - 12 + (tucked ? 7 : 0) + Math.round(o.x), d.seat.y - FOOT + Math.round(o.y));
      },
    });
    list.push({
      y: d.seat.y + 0.5,
      draw: (g, env) => {
        const o = env.off(d.id) || ZERO;
        if (o.hide) return;
        const x = d.fx + Math.round(o.x);
        const y = d.cy + Math.round(o.y);
        g.drawImage(p.desk, x + 20, y + 15);
        const info = env.desk(d);
        if (!info) return;
        const T = toolOf(info.tool);
        if (info.mode === 'away') {
          // the owner is in a meeting or on a break: screen off, standby light, a note on the glass
          g.drawImage(p.sticky, x + 37, y + 19);
          R(g, T.shade, x + 49, y + 29, 1, 1);
        } else {
          drawScreen(g, x + 34, y + 18, 16, 10, info.mode, T, env.t, info.seed % 97, env.still);
        }
        // the name plate: blank while the owner is away (the card on the desk says whose it is), one line
        // when the name fits, else the whole desk front in two lines
        const lines = info.mode === 'away' ? [] : plaqueLines(info.text);
        const px = x + 21;
        const py = y + 15;
        if (lines.length === 2) {
          R(g, C.brass, px, py + 20, 38, 12);
          for (let k = 0; k < 2; k++) {
            const ts = textSprite(lines[k], PLATE_INK, SMALL);
            g.drawImage(ts, px + 1 + ((PLATE_W - ts.width) >> 1), py + 20 + k * 6);
          }
        } else {
          box(g, px, py + 22, 38, 7, C.brass, C.brassShade);
          if (lines.length) {
            const ts = textSprite(lines[0], PLATE_INK, SMALL);
            g.drawImage(ts, px + 1 + ((PLATE_W - ts.width) >> 1), py + 23);
          }
        }
        const item = DESK_ITEMS[info.seed % DESK_ITEMS.length];
        if (item) {
          const sp = p[item];
          g.drawImage(sp, x + 53, y + 34 - sp.height);
        }
      },
    });
  }

  for (const r of L.rooms) {
    const roomX = (env) => r.x + Math.round(env.off(`room:${r.i}`).x);
    list.push({ y: 86.5, draw: (g, env) => g.drawImage(p.riser, roomX(env) + 3, 83) });
    list.push({
      y: 86,
      draw: (g, env) => {
        const info = env.room(r.i);
        const ox = roomX(env) - r.x;
        const tr = tableRect(r);
        g.drawImage(p.table(tr.w), tr.x + ox, tr.y);
        if (!info) return;
        const T = toolOf(info.tool);
        for (let k = 0; k < G.SEATS; k++) {
          const s = info.seats[k];
          if (!s || !s.seated) continue;
          const sp = seatPos(r, k);
          sp.x += ox;
          if (sp.top) {
            g.drawImage(p.laptopBack, sp.x - 6, 66);
            R(g, s.status === 'failed' ? C.bad : s.status === 'done' ? C.ok : T.base, sp.x - 1, 68, 2, 2);
          } else {
            g.drawImage(p.laptopFront, sp.x - 6, 70);
            if (s.status === 'working') drawScreen(g, sp.x - 4, 72, 8, 4, 'on', T, env.t, k * 13 + r.i, env.still);
            else R(g, s.status === 'done' ? C.ok : C.screenOff, sp.x - 4, 72, 8, 4);
          }
        }
      },
    });
    list.push({
      y: 111.5,
      draw: (g, env) => {
        const info = env.room(r.i);
        const rx = roomX(env);
        const x = rx + 2;
        if (!info) {
          g.fillStyle = 'rgba(22,16,40,0.42)';
          g.fillRect(x, 13, G.ROOM - 4, G.BAND - 13);
        }
        // glass front with a door gap on the right
        g.fillStyle = 'rgba(184,236,252,0.20)';
        g.fillRect(x, 97, 91, 15);
        g.fillStyle = 'rgba(252,252,252,0.30)';
        for (let i = 0; i < 4; i++) {
          const sx = x + 7 + i * 23;
          for (let j = 0; j < 9; j++) g.fillRect(sx + 9 - j, 99 + j, 2, 1);
        }
        R(g, C.glassFrame, x, 96, 91, 1);
        R(g, C.glassDark, x, 111, 91, 1);
        R(g, C.steelLight, x + 91, 94, 1, 18);
        R(g, K, x + 92, 94, 1, 18);
        R(g, C.steelLight, rx + G.ROOM - 3, 94, 1, 18);
        if (info && info.overflow > 0) {
          // more helpers than chairs: a plain count under the banner (not a signal colour)
          const label = `+${info.overflow}`;
          const w = textWidth(label, BIG) + 4;
          const lx = rx + G.ROOM - 3 - w;
          const ly = info.group ? 22 : 20;
          box(g, lx, ly, w, 11, C.tagBg, toolOf(info.tool).base);
          g.drawImage(textSprite(label, WHITE, BIG), lx + 2, ly + 2);
        }
      },
    });
  }

  // lounge: machines along the walkway side, the couch below them
  const lg = L.lounge;
  const lz = L.lg;
  const by = lz.backY;
  list.push({ y: by, draw: (g) => g.drawImage(p.vending, lg.x + LOUNGE_X.vending, by - 40) });
  list.push({
    y: by,
    draw: (g, env) => {
      const x = lg.x + LOUNGE_X.cooler;
      g.drawImage(p.cooler, x, by - 28);
      if (!env.still && Math.floor(env.t * 1.5) % 4 === 0) R(g, WHITE, x + 5, by - 22 - (Math.floor(env.t * 6) % 4), 1, 1);
    },
  });
  list.push({
    y: by,
    draw: (g, env) => {
      const x = lg.x + LOUNGE_X.counter;
      g.drawImage(p.counter, x, by - 30);
      // the coffee machine is always on: a slow wisp of steam
      if (!env.still) {
        const f = Math.floor(env.t / 0.9) % 4;
        if (f < 3) {
          R(g, WHITE, x + 8 + (f === 1 ? 1 : 0), by - 31 - f, 1, 1);
          if (f > 0) R(g, '#e4e4ec', x + 9 - (f === 2 ? 1 : 0), by - 30 - f, 1, 1);
        }
      }
    },
  });
  list.push({
    y: by,
    draw: (g, env) => {
      const x = lg.x + LOUNGE_X.arcade;
      g.drawImage(p.arcade, x, by - 38);
      // attract mode
      const ax = x + 4;
      const ay = by - 28;
      const f = env.still ? 0 : Math.floor(env.t * 4);
      const cols = [WHITE, '#fc6c18', '#58a8f8', '#38b428'];
      for (let i = 0; i < 5; i++) {
        const hh = hash(`a${i}/${Math.floor((f + i) / 3)}`);
        R(g, cols[i % 4], ax + (hh % 11), ay + ((hh >>> 5) % 8), 2, 1);
      }
      R(g, WHITE, ax + 5 + (f % 3) - 1, ay + 7, 3, 1);
    },
  });
  floor.push({
    draw: (g, env) => {
      const cy = lz.couchY + Math.round(env.loungeOff || 0);
      const rugY = cy + 14;
      const rugH = Math.min(lg.y + lg.h - 3, cy + 44) - rugY;
      if (rugH < 8) return;
      box(g, lg.x + 2, rugY, 80, rugH, C.rug, C.matShade);
      R(g, C.rugLine, lg.x + 5, rugY + 3, 74, 1);
      R(g, C.rugLine, lg.x + 5, rugY + rugH - 4, 74, 1);
    },
  });
  list.push({ y: lz.seatY - 1, draw: (g, env) => g.drawImage(p.couch, lg.x + LOUNGE_X.couch, lz.couchY + Math.round(env.loungeOff || 0)) });
  list.push({ y: lz.seatY + 1.5, draw: (g, env) => g.drawImage(p.plantB, lg.x + LOUNGE_X.plant, lz.couchY - 10 + Math.round(env.loungeOff || 0)) });
  if (lg.h >= 170) list.push({ y: lz.couchY + 42, draw: (g, env) => g.drawImage(p.coffeeTable, lg.x + 26, lz.couchY + 30 + Math.round(env.loungeOff || 0)) });
  // the same words the roster uses for this corner
  {
    const spr = signSprite('BREAK ROOM', null, LOUNGE_SIGN, LOUNGE_SIGN_W);
    list.push({ y: SIGN_BOTTOM - 0.5, draw: (g) => g.drawImage(spr, lg.x + LOUNGE_SIGN_X, SIGN_BOTTOM - spr.height) });
  }

  // utility corner against the back wall: server rack, printer, a plant
  const u = L.util;
  if (u) {
    const base = G.WALL + 9;
    list.push({
      y: base,
      draw: (g, env) => {
        const x = u.x;
        const y = base - 44;
        if (env.cover > x) return; // a room is still sliding out of this stretch of wall
        g.drawImage(p.rack, x, y);
        const f = env.still ? 1 : Math.floor(env.t * 5);
        for (let i = 0; i < 7; i++) {
          for (let j = 0; j < 4; j++) {
            const hh = hash(`${i}/${j}/${Math.floor((f + i * 3 + j) / (2 + ((i + j) % 3)))}`);
            const on = hh % 3 !== 0;
            R(g, on ? (j === 3 ? C.amber : '#48e848') : '#1c4020', x + 5 + j * 3, y + 6 + i * 5, 1, 1);
          }
        }
      },
    });
    list.push({
      y: base + 1,
      draw: (g, env) => {
        const x = u.x + 26;
        const y = base - 23;
        if (env.cover > x) return;
        g.drawImage(p.printer, x, y);
        if (!env.still) {
          const ph = env.t % 14;
          if (ph < 2) R(g, WHITE, x + 7, y + 11, 12, 1 + Math.floor(ph * 2));
          if (Math.floor(env.t * 2) % 2) R(g, '#a8f8a8', x + 21, y + 8, 1, 1);
        }
      },
    });
  }
  // The floor right of the last pod is where the pods grow. Until they do it is lived in: a rec corner
  // against the right-hand wall (a plant, a whiteboard on a stand, a ping-pong table, a bench). Everything
  // is hung from the right-hand edge, so nothing here ever shifts when a desk is added: a piece simply goes
  // when the desks reach it.
  {
    const x1 = L.W - 5;
    const fw = x1 - (L.bullRight + 10);
    const fh = L.H - G.BULL;
    if (fw >= 20) list.push({ y: G.BULL + 40, draw: (g) => g.drawImage(p.plantA, x1 - 19, G.BULL + 14) });
    if (fw >= 56 && fh >= 90) list.push({ y: G.BULL + 44, draw: (g) => g.drawImage(p.easel, x1 - 54, G.BULL + 12) });
    if (fw >= 56 && fh >= 90) list.push({ y: G.BULL + 86, draw: (g) => g.drawImage(p.pingpong, x1 - 50, G.BULL + 58) });
    if (fw >= 56 && fh >= 134) list.push({ y: G.BULL + 126, draw: (g) => g.drawImage(p.bench, x1 - 45, G.BULL + 114) });
    if (fw >= 84 && fh >= 90) list.push({ y: G.BULL + 86, draw: (g) => g.drawImage(p.plantB, x1 - 72, G.BULL + 52) });
  }
  // the stretch of hallway that is not a conference room: a bench under each window, a plant under each poster
  {
    let i = 0;
    for (let x = L.roomsRight + (u ? G.UTIL : 10); x + 36 < L.W; x += 48, i++) {
      const bx = x;
      if (i % 2 === 0) list.push({ y: G.WALL + 12, draw: (g, env) => { if (!(env.cover > bx)) g.drawImage(p.bench, bx - 1, G.WALL); } });
      else list.push({ y: G.WALL + 12, draw: (g, env) => { if (!(env.cover > bx)) g.drawImage(p.plantA, bx + 8, G.WALL - 13); } });
    }
  }

  // the cleaning robot shuttles along the walkway
  const bot = {
    y: G.WALK - 5,
    draw: (g, env) => {
      const span = Math.max(1, L.W - 60);
      const tt = env.still ? span * 0.35 : (env.t * 7) % (span * 2);
      const x = 30 + Math.round(tt < span ? tt : span * 2 - tt);
      g.drawImage(p.bot, x - 5, G.WALK - 10);
      R(g, !env.still && Math.floor(env.t * 2) % 2 ? '#48e848' : '#1c7018', x, G.WALK - 9, 1, 1);
    },
  };
  list.push(bot);

  return list;
}

export { drawScreen };
