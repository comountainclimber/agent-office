// Characters. Every sprite is painted procedurally (rects on a 24x32 cell), then outlined.
// Original chunky super-deformed office workers: big heads, stubby bodies, thick dark outlines.
import { K, WHITE, SKIN, HAIR, PANTS, toolOf } from './palette.js';
import { hash, makeCanvas, ctx2d, R, outline, ringOf, flipX } from './util.js';
import { drawText, SMALL } from './font.js';

export const SW = 24;
export const SH = 32;
export const FOOT = 29; // sprite row that sits on the character's ground line

/**
 * Deterministic appearance for a session or subagent.
 * role: 'session' | 'boss' (an orchestrating session) | 'sub'
 */
export function makeLook(id, tool, role = 'session') {
  const h = hash(String(id) + '|face');
  const h2 = hash(String(id) + '|kit');
  const t = toolOf(tool) === toolOf('claude') && tool !== 'claude' ? 'claude' : tool;
  const look = {
    tool: t,
    role,
    skin: h % SKIN.length,
    hair: (h >>> 4) % HAIR.length,
    style: (h >>> 9) % 9,
    glasses: (h >>> 14) % 5 === 0,
    blush: (h >>> 17) % 3 === 0,
    pants: h2 % PANTS.length,
    shoe: (h2 >>> 3) % 3 === 0 ? '#e8e8f0' : '#241c30',
  };
  look.sig = [look.tool, role, look.skin, look.hair, look.style, look.glasses ? 1 : 0, look.blush ? 1 : 0, look.pants, look.shoe].join(',');
  return look;
}

function colours(L) {
  const T = toolOf(L.tool);
  const sub = L.role === 'sub';
  return {
    skin: SKIN[L.skin][0],
    skinS: SKIN[L.skin][1],
    hair: HAIR[L.hair][0],
    hairL: HAIR[L.hair][1],
    // helpers wear the pale version of their boss's colour
    uni: sub ? T.light : T.base,
    uniS: sub ? T.base : T.shade,
    ink: sub ? T.shade : T.ink,
    tool: T,
    pants: PANTS[L.pants][0],
    pantsS: PANTS[L.pants][1],
    shoe: L.shoe,
  };
}

const rects = (g, c, list, dx = 0, dy = 0) => {
  g.fillStyle = c;
  for (const [x, y, w, h] of list) g.fillRect(x + dx, y + dy, w, h);
};

// ---------------------------------------------------------------- hair (x, y, w, h on the 24x32 cell)

const POMP_F = [[8, 6, 10, 1], [6, 7, 13, 1], [5, 8, 14, 3], [5, 11, 1, 2], [18, 11, 1, 2]];
const HAIR_F = [
  { b: POMP_F, l: [[9, 7, 4, 1]] },
  { b: [[7, 5, 1, 1], [11, 5, 1, 1], [15, 5, 1, 1], [6, 6, 3, 1], [10, 6, 3, 1], [14, 6, 3, 1], [5, 7, 14, 3], [5, 10, 3, 1], [9, 10, 2, 1], [12, 10, 2, 1], [15, 10, 4, 1], [5, 11, 1, 1], [18, 11, 1, 1]], l: [[7, 7, 2, 1], [11, 7, 2, 1]] },
  { b: [[7, 6, 10, 1], [5, 7, 14, 1], [4, 8, 16, 3], [4, 11, 4, 1], [16, 11, 4, 1], [4, 12, 2, 7], [18, 12, 2, 7]], l: [[8, 8, 5, 1]] },
  { b: [[7, 8, 10, 1], [6, 9, 12, 1], [5, 10, 2, 2], [17, 10, 2, 2]], l: [] },
  { b: [...POMP_F, [10, 4, 4, 2], [11, 3, 2, 1]], l: [[9, 7, 4, 1], [11, 4, 1, 1]] },
  { b: [[8, 3, 8, 1], [6, 4, 12, 1], [4, 5, 16, 1], [3, 6, 18, 5], [3, 11, 3, 3], [18, 11, 3, 3]], l: [[7, 5, 3, 1], [5, 6, 2, 2]] },
  { b: [[11, 3, 2, 1], [10, 4, 4, 7]], l: [[11, 4, 1, 5]] },
  { b: [[6, 6, 10, 1], [5, 7, 14, 1], [5, 8, 14, 2], [5, 10, 10, 1], [18, 10, 1, 2], [5, 11, 6, 1], [5, 12, 2, 1]], l: [[8, 7, 5, 1]] },
  { b: [...POMP_F, [2, 11, 3, 5], [19, 11, 3, 5], [3, 16, 1, 1], [20, 16, 1, 1]], l: [[9, 7, 4, 1]] },
];

const BASE_S = [[8, 6, 9, 1], [6, 7, 12, 1], [5, 8, 14, 2], [5, 10, 8, 2], [5, 12, 5, 3], [6, 15, 3, 2]];
const HAIR_S = [
  { b: [...BASE_S, [15, 6, 4, 2], [17, 8, 3, 1]], l: [[9, 7, 5, 1]] },
  { b: [...BASE_S, [7, 5, 1, 1], [11, 5, 1, 1], [15, 5, 1, 1], [4, 9, 1, 1], [4, 12, 1, 1], [14, 10, 2, 1]], l: [[8, 7, 2, 1], [12, 7, 2, 1]] },
  { b: [[7, 6, 10, 1], [5, 7, 13, 1], [4, 8, 15, 2], [4, 10, 9, 2], [4, 12, 7, 7], [13, 10, 6, 1]], l: [[8, 8, 5, 1]] },
  { b: [[8, 8, 9, 1], [6, 9, 12, 1], [5, 10, 4, 3]], l: [] },
  { b: [...BASE_S, [2, 7, 4, 4], [3, 6, 2, 1]], l: [[9, 7, 5, 1], [3, 8, 1, 1]] },
  { b: [[8, 3, 8, 1], [5, 4, 13, 1], [3, 5, 17, 5], [3, 10, 10, 2], [3, 12, 6, 3], [4, 15, 4, 1]], l: [[7, 5, 3, 1], [5, 6, 2, 2]] },
  { b: [[10, 3, 1, 1], [13, 3, 1, 1], [9, 4, 7, 1], [8, 5, 9, 2], [7, 7, 10, 1], [6, 8, 3, 3]], l: [[10, 5, 5, 1]] },
  { b: [...BASE_S, [14, 9, 6, 2], [19, 11, 1, 1]], l: [[9, 7, 5, 1]] },
  { b: [...BASE_S, [2, 10, 3, 7], [3, 17, 1, 1]], l: [[9, 7, 5, 1]] },
];

const CAP_B = [[8, 6, 8, 1], [6, 7, 12, 1], [5, 8, 14, 8], [6, 16, 12, 1], [7, 17, 10, 1]];
const HAIR_B = [
  { b: CAP_B, l: [[8, 8, 4, 1]] },
  { b: [...CAP_B, [7, 5, 1, 1], [11, 5, 1, 1], [15, 5, 1, 1], [4, 10, 1, 1], [19, 10, 1, 1], [4, 13, 1, 1], [19, 13, 1, 1]], l: [[8, 8, 3, 1]] },
  { b: [[7, 6, 10, 1], [5, 7, 14, 1], [4, 8, 16, 11], [5, 19, 14, 1]], l: [[7, 9, 5, 1]] },
  { b: [[7, 8, 10, 1], [6, 9, 12, 1], [5, 10, 14, 4], [6, 14, 12, 1]], l: [] },
  { b: [...CAP_B, [10, 4, 4, 2], [11, 3, 2, 1]], l: [[8, 8, 4, 1], [11, 4, 1, 1]] },
  { b: [[8, 3, 8, 1], [6, 4, 12, 1], [4, 5, 16, 1], [3, 6, 18, 8], [4, 14, 16, 2], [6, 16, 12, 1]], l: [[7, 5, 3, 1], [5, 6, 2, 2]] },
  { b: [[11, 3, 2, 1], [10, 4, 4, 10]], l: [[11, 4, 1, 8]] },
  { b: CAP_B, l: [[8, 8, 6, 1]] },
  { b: [...CAP_B, [2, 11, 3, 5], [19, 11, 3, 5]], l: [[8, 8, 4, 1]] },
];

// ---------------------------------------------------------------- heads

function headSkin(g, C, dir, hx, hy) {
  if (dir === 'S') {
    rects(g, C.skin, [[8, 8, 9, 1], [7, 9, 11, 1], [6, 10, 13, 7], [7, 17, 11, 1], [8, 18, 8, 1], [19, 14, 1, 1]], hx, hy);
    rects(g, C.skinS, [[6, 16, 3, 1], [7, 17, 4, 1], [8, 18, 8, 1], [11, 13, 1, 2]], hx, hy);
  } else {
    rects(g, C.skin, [[7, 8, 10, 1], [6, 9, 12, 1], [5, 10, 14, 7], [6, 17, 12, 1], [7, 18, 10, 1], [4, 13, 1, 2], [19, 13, 1, 2]], hx, hy);
    rects(g, C.skinS, [[18, 11, 1, 6], [7, 18, 10, 1], [19, 13, 1, 2], [16, 17, 2, 1]], hx, hy);
  }
}

function accessory(g, C, L, dir, hx, hy, f) {
  const T = C.tool;
  if (L.tool === 'claude') {
    // headband with knotted tails
    const band = WHITE;
    const tail = T.light;
    if (dir === 'F') {
      rects(g, band, [[5, 10, 14, 1]], hx, hy);
      rects(g, band, [[19, 10, 2, 1]], hx, hy);
      rects(g, tail, f % 2 ? [[20, 11, 2, 1], [21, 12, 1, 2]] : [[20, 11, 1, 2], [21, 12, 1, 2]], hx, hy);
    } else if (dir === 'S') {
      rects(g, band, [[5, 10, 14, 1]], hx, hy);
      rects(g, band, [[3, 10, 2, 1]], hx, hy);
      rects(g, tail, f % 2 ? [[1, 10, 2, 1], [2, 11, 2, 1]] : [[2, 11, 2, 1], [1, 12, 2, 1]], hx, hy);
    } else {
      rects(g, band, [[5, 10, 14, 1], [11, 10, 2, 2]], hx, hy);
      rects(g, tail, [[10, 12, 1, 3], [13, 12, 1, 3]], hx, hy);
    }
  } else if (L.tool === 'codex') {
    // green eyeshade: band plus a wide brim
    const band = '#0c5c44';
    if (dir === 'F') {
      rects(g, band, [[5, 10, 14, 1]], hx, hy);
      rects(g, T.shade, [[3, 11, 18, 1]], hx, hy);
      rects(g, T.light, [[5, 11, 5, 1]], hx, hy);
    } else if (dir === 'S') {
      rects(g, band, [[5, 10, 14, 1]], hx, hy);
      rects(g, T.shade, [[14, 11, 8, 1], [18, 10, 4, 1]], hx, hy);
      rects(g, T.light, [[16, 11, 3, 1]], hx, hy);
    } else {
      rects(g, band, [[5, 10, 14, 1]], hx, hy);
      rects(g, T.light, [[11, 10, 2, 1]], hx, hy);
    }
  } else {
    // headset: big ear cups and a boom mic
    const dark = '#2c2068';
    if (dir === 'S') {
      rects(g, dark, [[11, 5, 2, 5], [10, 10, 3, 1], [9, 11, 5, 4], [10, 15, 3, 1]], hx, hy);
      rects(g, T.light, [[11, 12, 1, 2]], hx, hy);
      rects(g, K, [[14, 15, 1, 1], [15, 16, 2, 1]], hx, hy);
    } else {
      rects(g, dark, [[8, 5, 8, 1], [6, 6, 2, 1], [16, 6, 2, 1], [5, 7, 1, 2], [18, 7, 1, 2], [4, 9, 1, 2], [19, 9, 1, 2], [3, 11, 2, 5], [19, 11, 2, 5]], hx, hy);
      rects(g, T.light, [[3, 12, 1, 3], [20, 12, 1, 3]], hx, hy);
      if (dir === 'F') rects(g, K, [[5, 16, 1, 1], [6, 17, 2, 1]], hx, hy);
    }
  }
}

function faceFront(g, C, L, expr, hx, hy, f) {
  const P = (list, c = K) => rects(g, c, list, hx, hy);
  const red = '#c82c2c';
  const eyesOpen = () => {
    P([[7, 12, 1, 2], [16, 12, 1, 2]], WHITE);
    P([[8, 12, 2, 2], [14, 12, 2, 2]]);
  };
  switch (expr) {
    case 'focus':
      eyesOpen();
      P([[7, 10, 2, 1], [9, 11, 1, 1], [15, 10, 2, 1], [14, 11, 1, 1]]);
      P([[11, 16, 2, 1]]);
      break;
    case 'talk':
      eyesOpen();
      if (f % 2) { P([[11, 15, 2, 1]]); P([[11, 16, 2, 1]], red); } else P([[10, 16, 4, 1]]);
      break;
    case 'happy':
      P([[7, 13, 1, 1], [8, 12, 1, 1], [9, 13, 1, 1], [14, 13, 1, 1], [15, 12, 1, 1], [16, 13, 1, 1]]);
      P([[10, 15, 4, 1]]);
      P([[11, 16, 2, 1]], red);
      break;
    case 'alert':
      P([[7, 11, 3, 3], [14, 11, 3, 3]], WHITE);
      P([[8, 12, 2, 2], [14, 12, 2, 2]]);
      P([[11, 15, 2, 1]]);
      P([[11, 16, 2, 1]], red);
      break;
    case 'sleep':
      P([[7, 13, 3, 1], [14, 13, 3, 1]]);
      P([[11, 16, 2, 1]]);
      break;
    case 'dead':
      P([[7, 11, 1, 1], [9, 11, 1, 1], [8, 12, 1, 1], [7, 13, 1, 1], [9, 13, 1, 1]]);
      P([[14, 11, 1, 1], [16, 11, 1, 1], [15, 12, 1, 1], [14, 13, 1, 1], [16, 13, 1, 1]]);
      P([[10, 16, 1, 1], [11, 15, 1, 1], [12, 16, 1, 1], [13, 15, 1, 1]]);
      break;
    case 'content':
      P([[7, 12, 1, 1], [8, 13, 1, 1], [9, 12, 1, 1], [14, 12, 1, 1], [15, 13, 1, 1], [16, 12, 1, 1]]);
      P([[11, 16, 2, 1]]);
      break;
    case 'blink':
      P([[7, 13, 3, 1], [14, 13, 3, 1]]);
      P([[11, 16, 2, 1]]);
      break;
    default:
      eyesOpen();
      P([[11, 16, 2, 1]]);
  }
  if (L.blush && expr !== 'dead') P([[6, 15, 2, 1], [16, 15, 2, 1]], '#f08c84');
  if (L.glasses && expr !== 'dead') {
    P([[6, 11, 5, 1], [6, 14, 5, 1], [6, 11, 1, 4], [10, 11, 1, 4], [13, 11, 5, 1], [13, 14, 5, 1], [13, 11, 1, 4], [17, 11, 1, 4], [11, 12, 2, 1]]);
  }
}

function faceSide(g, C, L, expr, hx, hy, f) {
  const P = (list, c = K) => rects(g, c, list, hx, hy);
  const red = '#c82c2c';
  switch (expr) {
    case 'focus':
      P([[14, 12, 1, 2]], WHITE);
      P([[15, 12, 2, 2]]);
      P([[14, 10, 2, 1], [16, 11, 2, 1]]);
      P([[16, 16, 2, 1]]);
      break;
    case 'talk':
      P([[14, 12, 1, 2]], WHITE);
      P([[15, 12, 2, 2]]);
      if (f % 2) { P([[16, 15, 2, 1]]); P([[16, 16, 2, 1]], red); } else P([[15, 16, 3, 1]]);
      break;
    case 'happy':
    case 'content':
      P([[14, 13, 1, 1], [15, 12, 1, 1], [16, 13, 1, 1]]);
      P([[15, 16, 3, 1]]);
      break;
    case 'sleep':
    case 'blink':
      P([[14, 13, 3, 1]]);
      P([[16, 16, 2, 1]]);
      break;
    case 'alert':
      P([[14, 11, 3, 3]], WHITE);
      P([[15, 12, 2, 2]]);
      P([[16, 15, 2, 2]]);
      break;
    default:
      P([[14, 12, 1, 2]], WHITE);
      P([[15, 12, 2, 2]]);
      P([[16, 16, 2, 1]]);
  }
  if (L.blush) P([[13, 15, 2, 1]], '#f08c84');
  if (L.glasses) P([[13, 11, 5, 1], [13, 14, 5, 1], [13, 11, 1, 4], [17, 11, 1, 4], [9, 12, 4, 1]]);
}

function head(g, C, L, dir, expr, hx, hy, f) {
  headSkin(g, C, dir, hx, hy);
  const set = dir === 'F' ? HAIR_F : dir === 'S' ? HAIR_S : HAIR_B;
  const hs = set[L.style];
  if (dir === 'B' && L.style === 6) {
    // shaved sides: skin shows, the crest runs down the middle
  }
  rects(g, C.hair, hs.b, hx, hy);
  rects(g, C.hairL, hs.l, hx, hy);
  if (dir === 'B' && L.style !== 6) rects(g, C.skin, [[9, 18, 6, 1]], hx, hy);
  if (dir === 'F') faceFront(g, C, L, expr, hx, hy, f);
  else if (dir === 'S') faceSide(g, C, L, expr, hx, hy, f);
  accessory(g, C, L, dir, hx, hy, f);
}

// ---------------------------------------------------------------- bodies

const SITTING = new Set(['sit', 'type', 'raiseSit', 'relax', 'slump', 'doze', 'sipSit']);

function paintFrontBack(g, C, L, dir, pose, f, expr) {
  const boss = L.role === 'boss';
  const up = boss ? -2 : 0;
  const ty = 19 + up;
  const th = 6 - up;
  let hx = 0;
  let hy = up;
  if (pose === 'slump') hy += 3;
  if (pose === 'doze') { hy += 2; hx = 1; }
  const sit = SITTING.has(pose);
  const back = dir === 'B';

  // legs
  if (sit) {
    R(g, C.pants, 7, 25, 10, 2);
    R(g, C.pantsS, 11, 26, 2, 1);
    R(g, C.shoe, 6, 27, 5, 1);
    R(g, C.shoe, 13, 27, 5, 1);
  } else {
    const l = pose === 'walk' && f === 1;
    const r = pose === 'walk' && f === 3;
    R(g, C.pants, 7, 25, 10, 1);
    R(g, C.pants, 7, 26, 4, l ? 1 : 2);
    R(g, C.shoe, 6, l ? 27 : 28, 5, 1);
    R(g, C.pants, 13, 26, 4, r ? 1 : 2);
    R(g, C.shoe, 13, r ? 27 : 28, 5, 1);
  }

  // torso
  R(g, C.uni, 7, ty, 10, th);
  R(g, C.uniS, 16, ty, 1, th);
  R(g, C.uniS, 7, ty + th - 1, 10, 1);
  if (boss && !back) {
    // the boss look: white shirt front, tie, gold epaulettes
    R(g, WHITE, 10, ty, 4, 3);
    R(g, '#c82c2c', 11, ty, 2, 5);
    R(g, '#8c1c1c', 11, ty + 5, 2, 1);
  } else {
    drawText(g, C.tool.badge, 8, ty + (boss ? 2 : 0), C.ink, SMALL);
  }
  if (boss) {
    R(g, '#e8e8f0', 6, ty, 3, 1);
    R(g, '#e8e8f0', 15, ty, 3, 1);
  }

  const armDown = (x, lift = 0, len = 4) => {
    R(g, C.uni, x, ty, 2, len - lift);
    R(g, C.uniS, x === 5 ? 6 : 17, ty, 1, len - lift);
    R(g, C.skin, x, ty + len - lift, 2, 2);
  };

  let front = null; // things drawn over the head
  switch (pose) {
    case 'walk':
      armDown(5, f === 3 ? 1 : 0);
      armDown(17, f === 1 ? 1 : 0);
      break;
    case 'type': {
      const a = f % 2;
      R(g, C.uni, 5, ty, 2, 3);
      R(g, C.uni, 17, ty, 2, 3);
      if (!back) {
        R(g, C.skin, 7, ty + 3 + a, 2, 2);
        R(g, C.skin, 15, ty + 4 - a, 2, 2);
      } else {
        R(g, C.uniS, a ? 5 : 6, ty + 3, 1, 1);
        R(g, C.uniS, a ? 18 : 17, ty + 3, 1, 1);
      }
      break;
    }
    case 'raise':
    case 'raiseSit':
      armDown(5);
      R(g, C.uni, 17, ty, 3, 2);
      front = () => {
        R(g, C.uni, 19, ty - 8, 2, 9);
        R(g, C.uniS, 19, ty - 8, 1, 9);
        R(g, C.skin, 19 + (f % 2), ty - 12, 3, 4);
        R(g, C.skinS, 19 + (f % 2), ty - 9, 3, 1);
      };
      break;
    case 'relax':
      // hands behind the head, elbows out
      R(g, C.uni, 4, ty - 4, 2, 5);
      R(g, C.uni, 18, ty - 4, 2, 5);
      R(g, C.uni, 3, ty - 8, 2, 5);
      R(g, C.uni, 19, ty - 8, 2, 5);
      R(g, C.uniS, 3, ty - 4, 2, 1);
      R(g, C.uniS, 19, ty - 4, 2, 1);
      break;
    case 'slump':
      armDown(5, 0, 5);
      armDown(17, 0, 5);
      break;
    case 'sip':
    case 'sipSit':
      armDown(5);
      if (back) { armDown(17); break; }
      if (f % 2) {
        R(g, C.uni, 17, ty - 1, 2, 3);
        front = () => {
          R(g, C.uni, 15, ty - 2, 3, 2);
          R(g, WHITE, 11, ty - 5, 3, 3);
          R(g, '#b8b8c8', 11, ty - 3, 3, 1);
          R(g, C.skin, 14, ty - 4, 2, 2);
        };
      } else {
        R(g, C.uni, 17, ty, 2, 3);
        front = () => {
          R(g, WHITE, 13, ty + 1, 3, 3);
          R(g, '#b8b8c8', 13, ty + 3, 3, 1);
          R(g, C.skin, 16, ty + 2, 2, 2);
        };
      }
      break;
    case 'present':
      // pointer raised toward the board (viewer's left)
      armDown(17);
      R(g, C.uni, 5, ty, 2, 2);
      front = () => {
        R(g, C.uni, 3, ty - 3, 2, 4);
        R(g, C.uniS, 4, ty - 3, 1, 4);
        R(g, C.skin, 2, ty - 5, 2, 2);
        const t = f % 2;
        R(g, '#f8f0d8', 1, ty - 9 - t, 1, 4);
        R(g, '#e02c20', 1, ty - 10 - t, 1, 1);
      };
      break;
    default:
      armDown(5);
      armDown(17);
  }

  head(g, C, L, dir, expr, hx, hy, f);
  if (front) front();
}

function paintSide(g, C, L, pose, f, expr) {
  const boss = L.role === 'boss';
  const up = boss ? -2 : 0;
  const ty = 19 + up;
  const th = 6 - up;
  const sit = pose === 'type' || pose === 'sit' || pose === 'think';

  // legs
  if (sit) {
    R(g, C.pants, 9, 25, 9, 2);
    R(g, C.pantsS, 9, 26, 6, 1);
    R(g, C.pants, 15, 27, 3, 1);
    R(g, C.shoe, 15, 28, 5, 1);
  } else if (pose === 'walk' && (f === 0 || f === 2)) {
    const near = f === 0; // near leg forward
    const fwd = near ? C.pants : C.pantsS;
    const bk = near ? C.pantsS : C.pants;
    R(g, C.pants, 9, 25, 6, 1);
    R(g, bk, 9, 26, 3, 1); R(g, bk, 8, 27, 3, 1); R(g, C.shoe, 6, 27, 3, 1);
    R(g, fwd, 12, 26, 3, 1); R(g, fwd, 13, 27, 3, 1); R(g, C.shoe, 13, 28, 5, 1);
  } else {
    R(g, C.pants, 9, 25, 6, 3);
    R(g, C.pantsS, 9, 26, 2, 2);
    R(g, C.shoe, 9, 28, 7, 1);
  }

  // torso
  R(g, C.uni, 8, ty, 8, th);
  R(g, C.uniS, 8, ty, 1, th);
  R(g, C.uniS, 8, ty + th - 1, 8, 1);
  if (boss) { R(g, '#e8e8f0', 10, ty, 4, 1); R(g, '#c82c2c', 15, ty + 1, 1, 4); }

  let front = null;
  const arm = (list, hand) => { rects(g, C.uniS, list); rects(g, C.skin, [hand]); };
  switch (pose) {
    case 'walk':
      if (f === 0) arm([[11, ty, 2, 2], [10, ty + 2, 2, 1], [9, ty + 3, 2, 1]], [8, ty + 4, 2, 1]);
      else if (f === 2) arm([[11, ty, 2, 2], [12, ty + 2, 2, 1], [13, ty + 3, 2, 1]], [14, ty + 4, 2, 1]);
      else arm([[11, ty, 2, 4]], [11, ty + 4, 2, 2]);
      break;
    case 'type': {
      const a = f % 2;
      arm([[11, ty, 3, 2], [13, ty + 1, 6, 2]], [19, ty + 1 - a, 2, 2]);
      break;
    }
    case 'think':
      // chin in hand
      rects(g, C.uniS, [[11, ty, 2, 2], [13, ty + 1, 3, 2]]);
      front = () => { rects(g, C.uniS, [[16, ty - 1, 2, 3]]); rects(g, C.skin, [[16, ty - 2, 3, 2]]); };
      break;
    case 'sip':
      if (f % 2) {
        rects(g, C.uniS, [[11, ty, 2, 2], [13, ty, 3, 2]]);
        front = () => { rects(g, C.uniS, [[15, ty - 2, 2, 3]]); R(g, C.skin, 16, ty - 4, 2, 2); R(g, WHITE, 18, ty - 5, 3, 3); R(g, '#b8b8c8', 18, ty - 3, 3, 1); };
      } else {
        arm([[11, ty, 2, 2], [13, ty + 2, 3, 2]], [16, ty + 2, 2, 2]);
        front = () => { R(g, WHITE, 18, ty + 1, 3, 3); R(g, '#b8b8c8', 18, ty + 3, 3, 1); };
      }
      break;
    default:
      arm([[11, ty, 2, 4]], [11, ty + 4, 2, 2]);
  }

  head(g, C, L, 'S', expr, 0, up, f);
  if (front) front();
}

// ---------------------------------------------------------------- cache + public API

const cache = new Map();
const rings = new Map();

/**
 * @param {object} look  from makeLook()
 * @param {'F'|'B'|'R'|'L'} dir
 * @param {string} pose
 * @param {number} frame
 * @param {string} expr
 * @returns {HTMLCanvasElement} 24x32 sprite; the feet rest on row FOOT, the centre line is x = 12
 */
export function getSprite(look, dir, pose, frame, expr) {
  const key = `${look.sig}|${dir}|${pose}|${frame}|${expr}`;
  let c = cache.get(key);
  if (c) return c;
  if (cache.size > 6000) { cache.clear(); rings.clear(); }
  if (dir === 'L') {
    c = flipX(getSprite(look, 'R', pose, frame, expr));
  } else {
    c = makeCanvas(SW, SH);
    const g = ctx2d(c);
    const col = colours(look);
    if (dir === 'R') paintSide(g, col, look, pose, frame, expr);
    else paintFrontBack(g, col, look, dir, pose, frame, expr);
    outline(c, K);
  }
  c._key = key;
  cache.set(key, c);
  return c;
}

/** 26x34 ring that hugs a sprite (draw it at x-1, y-1). */
export function getRing(spr, colour) {
  const key = spr._key + '|' + colour;
  let r = rings.get(key);
  if (!r) {
    r = ringOf(spr, colour);
    rings.set(key, r);
  }
  return r;
}

/** 28x36 ring, 2px thick, around a sprite (draw it at x-2, y-2): the pointer is on it / it is selected. */
export function getHalo(spr, colour) {
  const key = spr._key + '|halo|' + colour;
  let r = rings.get(key);
  if (!r) {
    const inner = ringOf(spr, colour);
    const both = makeCanvas(inner.width, inner.height);
    const g = ctx2d(both);
    g.drawImage(spr, 1, 1);
    g.drawImage(inner, 0, 0);
    r = ringOf(both, colour);
    ctx2d(r).drawImage(inner, 1, 1);
    rings.set(key, r);
  }
  return r;
}

/** Pose + expression that sums up a status, used by the portrait. */
function portraitPose(session, subagent) {
  if (subagent) {
    if (subagent.status === 'done') return ['relax', 'happy'];
    if (subagent.status === 'failed') return ['slump', 'dead'];
    return ['stand', 'focus'];
  }
  if (session.status === 'waiting') return ['raise', 'alert'];
  if (session.status === 'idle') return ['stand', 'sleep'];
  return ['stand', session.mode === 'orchestrator' ? 'talk' : 'focus'];
}

/**
 * Face/bust close-up for the dialogue box. Uses the canvas at whatever backing size it already has
 * (96x96 is what the shell creates); a canvas still at the 300x150 default is set to 96x96.
 */
export function drawPortrait(canvas, session, subagent) {
  if (!canvas || !session) return;
  if (canvas.width === 300 && canvas.height === 150) { canvas.width = 96; canvas.height = 96; }
  const g = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const T = toolOf(session.tool);
  g.imageSmoothingEnabled = false;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);

  const role = subagent ? 'sub' : session.mode === 'orchestrator' ? 'boss' : 'session';
  const id = subagent ? `${session.id}#${subagent.id}` : session.id;
  const look = makeLook(id, session.tool, role);
  const [pose, expr] = portraitPose(session, subagent);
  const spr = getSprite(look, 'F', pose, 0, expr);

  const crop = 20;
  const s = Math.max(1, Math.floor(Math.min(w, h) / crop));
  const ox = Math.floor((w - crop * s) / 2);
  const oy = Math.floor((h - crop * s) / 2);

  // backdrop: flat tool shade with chunky diagonal stripes
  g.fillStyle = T.deep;
  g.fillRect(0, 0, w, h);
  g.fillStyle = T.shade;
  for (let i = -h; i < w; i += s * 6) {
    for (let j = 0; j < h; j += s) g.fillRect(i + j, h - j - s, s * 2, s);
  }
  const waiting = !subagent && session.status === 'waiting';
  const sy = (role === 'boss' ? 2 : 4) + (pose === 'slump' ? 2 : 0);
  // a raised hand reaches the sprite's right edge and above the head: slide the crop window to keep all of it
  const sx = pose === 'raise' ? 4 : 2;
  g.drawImage(spr, sx, pose === 'raise' ? Math.max(0, sy - 2) : sy, crop, crop, ox, oy, crop * s, crop * s);
  // status pip, bottom-right
  const pip = subagent
    ? subagent.status === 'done' ? '#38b428' : subagent.status === 'failed' ? '#e02c20' : T.light
    : waiting ? '#fcd820' : session.status === 'idle' ? '#8c88a0' : T.light;
  g.fillStyle = K;
  g.fillRect(w - s * 4, h - s * 4, s * 3, s * 3);
  g.fillStyle = pip;
  g.fillRect(w - s * 4 + s / 2, h - s * 4 + s / 2, s * 2, s * 2);
}
