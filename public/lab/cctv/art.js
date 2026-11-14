// CCTV WALL — pixel art: bitmap font, character generator, room dioramas, CRT effects.
// Everything is drawn from code (fillRect + cached, auto-outlined sprites). No image assets.

export const C = {
  K: '#11101c', white: '#fcfcfc', ink: '#f4f4f4',
  g1: '#c8ccd8', g2: '#8a8fa3', g3: '#565a70', g4: '#33364a', g5: '#1c1e2e',
  red: '#f83800', redD: '#a01800', yellow: '#ffd23f', yellowD: '#c8900c', orange: '#fc9838',
  green: '#58d854', greenD: '#108c3c', cyan: '#3cbcfc', blue: '#2468f8', purple: '#9878f8', pink: '#f878b8',
  wood: '#b86a30', woodL: '#e09050', woodD: '#7a3e1a',
};

export const TOOL = {
  claude: { base: '#e8683f', light: '#ffb690', dark: '#9c3a1e', code: 'CL', label: 'CLAUDE' },
  codex: { base: '#2fd39a', light: '#b0f8dc', dark: '#0e7f5c', code: 'CX', label: 'CODEX' },
  cursor: { base: '#6d5cff', light: '#beb6ff', dark: '#3524b8', code: 'CU', label: 'CURSOR' },
};
const toolOf = (t) => TOOL[t] || TOOL.claude;

const SKINS = [['#fcd8a8', '#e0a070'], ['#f0b888', '#c88450'], ['#c68a58', '#9a5a30'], ['#8e5c38', '#683c20']];
const HAIRS = [['#2c2840', '#55507c'], ['#7a4420', '#a86a38'], ['#f0b830', '#fce080'], ['#d8401c', '#f87848'], ['#c8ccd8', '#f4f4f4'], ['#f058a0', '#fca0c8'], ['#38a8d8', '#90daf0'], ['#5a3a88', '#8a68c0']];
const PANTS = ['#2c3c80', '#4a3a30', '#3c4058', '#5c2c5c'];
const SHOES = ['#2c2840', '#f4f4f4', '#a81810'];
const CAPS = [['#f4f4f4', '#a8acc0'], ['#ffd23f', '#c8900c'], ['#f83800', '#a01800']];

export function hash(s) {
  let h = 2166136261;
  s = String(s);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function R(g, c, x, y, w = 1, h = 1) {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

/* ---------------------------------------------------------------- font -- */
// 3x5 bitmap glyphs, rows top to bottom.
const F = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '111101101101111',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111',
  0: '010101101101010', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110', 4: '101101111001001',
  5: '111100110001110', 6: '011100110101010', 7: '111001010010010', 8: '010101010101010', 9: '010101011001110',
  '!': '010010010000010', '?': '110001010000010', '.': '000000000000010', ',': '000000000010100',
  ':': '000010000010000', '-': '000000111000000', '+': '000010111010000', '/': '001001010100100',
  '#': '101111101111101', '*': '000101010101000', "'": '010010000000000', '(': '001010010010001',
  ')': '100010010010100', _: '000000000000111', '>': '100010001010100', '<': '001010100010001',
  '=': '000111000111000', z: '000000111010111', '%': '101001010100101',
};

export function textW(str, sc = 1) {
  return Math.max(0, String(str).length * 4 - 1) * sc;
}

export function drawText(g, str, x, y, col, sc = 1) {
  g.fillStyle = col;
  str = String(str);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const gl = F[ch] || F[ch.toUpperCase()];
    if (gl) {
      for (let b = 0; b < 15; b++) {
        if (gl[b] === '1') g.fillRect(x + (i * 4 + (b % 3)) * sc, y + ((b / 3) | 0) * sc, sc, sc);
      }
    }
  }
  return textW(str, sc);
}

/* ------------------------------------------------------------- sprites -- */
const cache = new Map();

// A plain cached bitmap (no outline pass).
function cached(key, w, h, draw) {
  let c = cache.get(key);
  if (!c) {
    c = makeCanvas(Math.max(1, w), Math.max(1, h));
    draw(c.getContext('2d'));
    cache.set(key, c);
  }
  return c;
}

// Text is one fillRect per lit pixel, so every string is rasterised once and blitted afterwards.
const textCache = new Map();
export function putText(g, str, x, y, col, sc = 1) {
  str = String(str);
  const key = `${str}|${col}|${sc}`;
  let c = textCache.get(key);
  if (!c) {
    if (textCache.size > 800) textCache.clear();
    c = makeCanvas(Math.max(1, textW(str, sc)), 5 * sc);
    drawText(c.getContext('2d'), str, 0, 0, col, sc);
    textCache.set(key, c);
  }
  g.drawImage(c, x, y);
  return textW(str, sc);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Draws into a w*h box with a 1px margin, then wraps every opaque shape in a dark outline.
function sprite(key, w, h, draw, outline = C.K) {
  let c = cache.get(key);
  if (c) return c;
  c = makeCanvas(w + 2, h + 2);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.translate(1, 1);
  draw(g);
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (outline) {
    const W = c.width, H = c.height;
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const solid = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) solid[i] = d[i * 4 + 3] > 0 ? 1 : 0;
    const r = parseInt(outline.slice(1, 3), 16), gg = parseInt(outline.slice(3, 5), 16), b = parseInt(outline.slice(5, 7), 16);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (solid[i]) continue;
        if ((x > 0 && solid[i - 1]) || (x < W - 1 && solid[i + 1]) || (y > 0 && solid[i - W]) || (y < H - 1 && solid[i + W])) {
          d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
        }
      }
    }
    g.putImageData(img, 0, 0);
  }
  cache.set(key, c);
  return c;
}

function put(g, spr, x, y, flip = false) {
  if (!flip) g.drawImage(spr, x - 1, y - 1);
  else {
    g.save();
    g.translate(x - 1 + spr.width, y - 1);
    g.scale(-1, 1);
    g.drawImage(spr, 0, 0);
    g.restore();
  }
}

/* ---------------------------------------------------------- characters -- */
const specs = new Map();
export function charSpec(id, tool) {
  const key = id + '|' + tool;
  let sp = specs.get(key);
  if (sp) return sp;
  const h = hash(id);
  const h2 = hash(id + '~office');
  sp = {
    key, tool,
    skin: SKINS[h % 4],
    hair: HAIRS[(h >>> 3) % HAIRS.length],
    style: (h2 >>> 2) % 8,
    acc: (h >>> 11) % 6, // 1 glasses, 2 headphones, 4 blush
    detail: (h >>> 14) % 5,
    pants: PANTS[(h >>> 17) % 4],
    shoe: SHOES[(h >>> 20) % 3],
    cap: CAPS[(h >>> 22) % 3],
    seed: h, seed2: h2,
  };
  specs.set(key, sp);
  return sp;
}

const SK = [[3, 12], [1, 14], [0, 15], [0, 15], [0, 15], [0, 15], [0, 15], [0, 15], [0, 15], [0, 15], [0, 15], [1, 14], [3, 12]];
function skullRows(g, col, hx, hy, r0, r1) {
  for (let r = r0; r <= r1; r++) {
    const [a, b] = SK[r];
    R(g, col, hx + a, hy + r, b - a + 1, 1);
  }
}

const EXPR = {
  work: { eyes: 'open', brows: 'focus', mouth: 'neutral' },
  blink: { eyes: 'blink', brows: 'focus', mouth: 'neutral' },
  calm: { eyes: 'open', mouth: 'neutral' },
  smile: { eyes: 'open', mouth: 'smile' },
  talk: { eyes: 'open', brows: 'focus', mouth: 'open' },
  alert: { eyes: 'wide', brows: 'raised', mouth: 'open' },
  sleep: { eyes: 'closed', mouth: 'o' },
  happy: { eyes: 'happy', mouth: 'smile' },
  dead: { eyes: 'dead', mouth: 'frown' },
  down: { eyes: 'down', mouth: 'neutral' },
  sip: { eyes: 'closed', mouth: 'none' },
  think: { eyes: 'up', mouth: 'flat' },
};

function eye(g, kind, e, ey) {
  const K = C.K;
  switch (kind) {
    case 'open': R(g, K, e, ey, 2, 3); R(g, '#fff', e, ey, 1, 1); break;
    case 'up': R(g, '#fff', e, ey + 1, 2, 2); R(g, K, e, ey, 2, 2); break;
    case 'blink': R(g, K, e, ey + 2, 2, 1); break;
    case 'closed': R(g, K, e - 1, ey + 1); R(g, K, e, ey + 2, 2, 1); R(g, K, e + 2, ey + 1); break;
    case 'happy': R(g, K, e - 1, ey + 2); R(g, K, e, ey + 1, 2, 1); R(g, K, e + 2, ey + 2); break;
    case 'dead': R(g, K, e - 1, ey); R(g, K, e + 1, ey); R(g, K, e, ey + 1); R(g, K, e - 1, ey + 2); R(g, K, e + 1, ey + 2); break;
    case 'wide': R(g, '#fff', e - 1, ey - 1, 4, 4); R(g, K, e, ey, 2, 2); break;
    case 'down': R(g, K, e, ey + 1, 2, 2); break;
  }
}

function drawHead(g, sp, hx, hy, view, exName) {
  const ex = EXPR[exName] || EXPR.calm;
  const [sk, skS] = sp.skin;
  const [hr, hrH] = sp.hair;
  const side = view === 'side';
  const st = sp.style;

  // hair behind the skull
  if (st === 3) { if (side) R(g, hr, hx - 1, hy + 3, 7, 12); else R(g, hr, hx - 1, hy + 4, 18, 10); }
  if (st === 6) {
    const o = side ? -1 : 0;
    R(g, hr, hx - 2 + o, hy - 1, 20, 9); R(g, hr, hx - 1 + o, hy - 2, 18, 1); R(g, hr, hx + 1 + o, hy - 3, 14, 1);
  }
  if (st === 4) { if (side) { R(g, hr, hx - 2, hy - 2, 6, 5); R(g, hrH, hx - 1, hy - 1, 2, 1); } else { R(g, hr, hx + 5, hy - 4, 6, 4); R(g, hrH, hx + 6, hy - 3, 2, 1); } }

  skullRows(g, sk, hx, hy, 0, 12);
  R(g, skS, hx + 3, hy + 12, 10, 1); R(g, skS, hx + 1, hy + 11, 2, 1); R(g, skS, hx + 13, hy + 11, 2, 1);
  if (side) { R(g, sk, hx + 16, hy + 8, 1, 2); R(g, skS, hx + 4, hy + 6, 2, 3); }

  const e1 = hx + (side ? 8 : 4), e2 = hx + (side ? 13 : 10), ey = hy + 6;
  const mx = hx + (side ? 10 : 7), my = hy + 10;
  if (sp.acc === 4) { R(g, C.pink, e1 - 1, ey + 3, 2, 1); R(g, C.pink, e2 + 1, ey + 3, 2, 1); }
  if (sp.acc === 1) {
    R(g, '#d8f0ff', e1 - 1, ey - 1, 4, 5); R(g, '#d8f0ff', e2 - 1, ey - 1, side ? 3 : 4, 5);
  }
  eye(g, ex.eyes, e1, ey); eye(g, ex.eyes, e2, ey);
  if (sp.acc === 1) {
    R(g, C.K, e1 - 2, ey - 2, (side ? e2 + 2 : e2 + 4) - (e1 - 2), 1);
    R(g, C.K, e1 + 3, ey, e2 - e1 - 4, 1);
  } else if (ex.brows === 'focus') {
    R(g, C.K, e1 - 1, ey - 2, 3, 1); R(g, C.K, e2, ey - 2, 3, 1);
  } else if (ex.brows === 'raised') {
    R(g, C.K, e1 - 1, ey - 3, 3, 1); R(g, C.K, e2, ey - 3, 3, 1);
  }
  switch (ex.mouth) {
    case 'neutral': R(g, C.K, mx, my, 2, 1); break;
    case 'flat': R(g, C.K, mx - 1, my, 3, 1); break;
    case 'open': R(g, C.K, mx, my - 1, 2, 3); R(g, C.red, mx, my + 1, 2, 1); break;
    case 'smile': R(g, C.K, mx - 1, my, 4, 1); R(g, C.K, mx - 2, my - 1); R(g, C.K, mx + 3, my - 1); break;
    case 'frown': R(g, C.K, mx - 1, my, 4, 1); R(g, C.K, mx - 2, my + 1); R(g, C.K, mx + 3, my + 1); break;
    case 'o': R(g, C.K, mx, my, 2, 2); break;
  }

  // hair in front
  const cap = st === 5;
  if (st !== 7 && !cap) {
    skullRows(g, hr, hx, hy, 0, 3);
    R(g, hrH, hx + (side ? 7 : 4), hy + 1, 4, 1);
    if (side) R(g, hr, hx, hy + 4, 4, 5);
    else { R(g, hr, hx, hy + 4, 2, 2); R(g, hr, hx + 14, hy + 4, 2, 2); }
  }
  switch (st) {
    case 0:
      if (side) R(g, hr, hx + 4, hy + 4, 4, 1); else R(g, hr, hx + 2, hy + 4, 5, 1);
      break;
    case 1:
      for (let i = 0; i < 4; i++) { const bx = hx + 1 + i * 4 + (side ? 1 : 0); R(g, hr, bx, hy - 1, 3, 1); R(g, hr, bx + 1, hy - 2, 2, 1); R(g, hr, bx + 2, hy - 3, 1, 1); }
      R(g, hr, hx + 3, hy + 4, 2, 1); R(g, hr, hx + 8, hy + 4, 2, 1); if (!side) R(g, hr, hx + 12, hy + 4, 2, 1);
      break;
    case 2:
      if (side) { R(g, hr, hx + 6, hy - 3, 10, 4); R(g, hr, hx + 8, hy - 4, 7, 1); R(g, hr, hx + 15, hy - 2, 2, 5); R(g, hrH, hx + 9, hy - 2, 5, 1); }
      else { R(g, hr, hx + 3, hy - 3, 10, 3); R(g, hr, hx + 2, hy - 2, 12, 3); R(g, hrH, hx + 5, hy - 2, 5, 1); R(g, hr, hx + 4, hy + 4, 8, 1); }
      break;
    case 3:
      if (side) { R(g, hr, hx + 4, hy + 4, 12, 1); R(g, hr, hx, hy + 4, 5, 9); }
      else { R(g, hr, hx, hy + 4, 16, 1); R(g, hr, hx, hy + 5, 2, 7); R(g, hr, hx + 14, hy + 5, 2, 7); }
      break;
    case 4:
      if (side) R(g, hr, hx + 4, hy + 4, 3, 1); else { R(g, hr, hx + 2, hy + 4, 3, 1); R(g, hr, hx + 11, hy + 4, 3, 1); }
      break;
    case 5: {
      const [cp, cpD] = sp.cap;
      skullRows(g, cp, hx, hy, 0, 3); R(g, cpD, hx, hy + 3, 16, 1); R(g, cpD, hx + 7, hy - 1, 2, 1);
      if (side) { R(g, cpD, hx + 4, hy + 4, 15, 1); R(g, hr, hx, hy + 4, 3, 4); }
      else { R(g, cpD, hx + 1, hy + 4, 14, 1); R(g, hr, hx, hy + 5, 1, 3); R(g, hr, hx + 15, hy + 5, 1, 3); }
      break;
    }
    case 6:
      R(g, hr, hx + 2, hy + 4, 12, 1);
      R(g, hrH, hx + 3, hy - 1, 4, 1);
      break;
    case 7:
      if (side) { R(g, hr, hx + 2, hy - 3, 12, 4); R(g, hr, hx + 4, hy - 4, 8, 1); R(g, hrH, hx + 5, hy - 2, 6, 1); }
      else { R(g, hr, hx + 6, hy - 4, 4, 6); R(g, hrH, hx + 7, hy - 3, 1, 3); }
      break;
  }
  if (sp.acc === 2) {
    const hc = sp.cap[0] === '#f4f4f4' ? C.red : sp.cap[0];
    if (side) { R(g, hc, hx + 4, hy - 1, 2, 6); R(g, hc, hx + 2, hy + 5, 5, 5); R(g, C.K, hx + 4, hy + 7, 1, 1); }
    else { R(g, hc, hx + 1, hy - 1, 14, 1); R(g, hc, hx - 1, hy + 4, 2, 5); R(g, hc, hx + 15, hy + 4, 2, 5); }
  }
}

const BW = 30, BH = 34, HX = 7, HY = 6;

function torso(g, sp, x = 10, y = 19, w = 10, h = 7, front = true) {
  const t = toolOf(sp.tool);
  R(g, t.base, x, y, w, h);
  R(g, t.dark, x, y + h - 1, w, 1);
  if (!front) return;
  switch (sp.detail) {
    case 1: R(g, '#fff', x + 3, y, 4, 1); R(g, C.K, x + 4, y + 1, 2, 4); break;
    case 2: R(g, t.light, x, y + 2, w, 1); R(g, t.light, x, y + 4, w, 1); break;
    case 3: R(g, t.dark, x + 4, y, 2, 3); R(g, t.dark, x + 2, y + 4, 6, 1); break;
    case 4: R(g, '#fff', x + 6, y + 2, 2, 2); break;
    default: R(g, t.light, x + 3, y, 4, 1);
  }
}

function legsStand(g, sp) {
  R(g, sp.pants, 11, 26, 8, 1); R(g, sp.pants, 11, 27, 3, 2); R(g, sp.pants, 16, 27, 3, 2);
  R(g, sp.shoe, 10, 29, 4, 1); R(g, sp.shoe, 16, 29, 4, 1);
}
function legsSitFront(g, sp) {
  R(g, sp.pants, 10, 26, 10, 3); R(g, sp.pants, 11, 29, 3, 3); R(g, sp.pants, 16, 29, 3, 3);
  R(g, sp.shoe, 10, 32, 4, 1); R(g, sp.shoe, 16, 32, 4, 1);
}
function armDown(g, sp, x) {
  const t = toolOf(sp.tool);
  R(g, t.base, x, 19, 2, 5); R(g, sp.skin[0], x, 24, 2, 2);
}

const POSES = {
  stand(g, sp, f, ex) { legsStand(g, sp); torso(g, sp); armDown(g, sp, 8); armDown(g, sp, 20); drawHead(g, sp, HX, HY, 'front', ex); },
  point(g, sp, f, ex) {
    const t = toolOf(sp.tool);
    legsStand(g, sp); torso(g, sp); armDown(g, sp, 20);
    if (f) { R(g, t.base, 6, 20, 4, 2); R(g, t.base, 4, 19, 3, 2); R(g, sp.skin[0], 2, 18, 3, 2); }
    else { R(g, t.base, 6, 19, 4, 2); R(g, t.base, 4, 17, 3, 3); R(g, sp.skin[0], 2, 15, 3, 3); }
    drawHead(g, sp, HX, HY, 'front', ex);
  },
  wave(g, sp, f, ex) {
    const t = toolOf(sp.tool);
    legsStand(g, sp); torso(g, sp); armDown(g, sp, 8);
    drawHead(g, sp, HX, HY, 'front', ex);
    R(g, t.base, 20, 19, 5, 3); R(g, t.base, 23, 8, 3, 12); R(g, t.dark, 25, 9, 1, 11); R(g, sp.skin[0], 22 + f * 2, 2, 4, 6); R(g, sp.skin[0], 21 + f * 2, 3, 1, 3); R(g, sp.skin[1], 22 + f * 2, 7, 4, 1);
  },
  sitType(g, sp, f, ex, bob = 0) {
    const t = toolOf(sp.tool);
    R(g, t.dark, 14, 21, 7, 2); R(g, sp.skin[1], 21, 21 + (f ? 1 : 0), 2, 2);
    torso(g, sp, 9, 19, 9, 7, false);
    R(g, sp.pants, 10, 26, 11, 3); R(g, sp.pants, 18, 29, 3, 3); R(g, sp.shoe, 18, 32, 5, 1);
    R(g, t.base, 11, 20, 3, 4); R(g, t.base, 12, 23, 8, 2); R(g, t.dark, 12, 24, 8, 1);
    R(g, sp.skin[0], 20, 22 + (f ? 0 : 1), 3, 2);
    drawHead(g, sp, HX, HY + bob, 'side', ex);
  },
  sitChin(g, sp, f, ex) { // thinking / reading: one hand on chin
    const t = toolOf(sp.tool);
    torso(g, sp, 9, 19, 9, 7, false);
    R(g, sp.pants, 10, 26, 11, 3); R(g, sp.pants, 18, 29, 3, 3); R(g, sp.shoe, 18, 32, 5, 1);
    R(g, t.base, 11, 20, 3, 4); R(g, t.base, 12, 23, 8, 2); R(g, t.dark, 12, 24, 8, 1); R(g, sp.skin[0], 20, 23, 3, 2);
    drawHead(g, sp, HX, HY + (f ? 1 : 0), 'side', ex);
    R(g, t.base, 17, 19, 3, 3); R(g, sp.skin[0], 18, 17 + (f ? 1 : 0), 3, 2);
  },
  sitWave(g, sp, f, ex) {
    const t = toolOf(sp.tool);
    legsSitFront(g, sp); torso(g, sp); armDown(g, sp, 8);
    drawHead(g, sp, HX, HY, 'front', ex);
    R(g, t.base, 20, 19, 5, 3); R(g, t.base, 23, 8, 3, 12); R(g, t.dark, 25, 9, 1, 11); R(g, sp.skin[0], 22 + f * 2, 2, 4, 6); R(g, sp.skin[0], 21 + f * 2, 3, 1, 3); R(g, sp.skin[1], 22 + f * 2, 7, 4, 1);
  },
  sitCalm(g, sp, f, ex) { legsSitFront(g, sp); torso(g, sp); armDown(g, sp, 8); armDown(g, sp, 20); drawHead(g, sp, HX, HY + f, 'front', ex); },
  walk(g, sp, f, ex) {
    const t = toolOf(sp.tool);
    const b = f % 2;
    if (b === 0) {
      R(g, sp.pants, 9, 26, 4, 3); R(g, sp.pants, 15, 26, 4, 3); R(g, sp.shoe, 8, 29, 5, 1); R(g, sp.shoe, 15, 29, 6, 1);
    } else {
      R(g, sp.pants, 11, 26, 6, 3); R(g, sp.shoe, 11, 29, 7, 1);
    }
    torso(g, sp, 9, 19 + b, 9, 7 - b, false);
    const ax = f === 0 ? 15 : f === 2 ? 9 : 12;
    R(g, t.dark, ax, 20 + b, 3, 4); R(g, sp.skin[0], ax, 24 + b, 3, 2);
    drawHead(g, sp, HX, HY + b, 'side', ex);
  },
  sip(g, sp, f, ex) {
    const t = toolOf(sp.tool);
    legsStand(g, sp); torso(g, sp); armDown(g, sp, 8);
    drawHead(g, sp, HX, HY, 'front', ex);
    if (f) { R(g, t.base, 20, 19, 2, 2); R(g, t.base, 18, 17, 4, 3); R(g, '#fff', 13, 15, 4, 3); R(g, C.g1, 13, 17, 4, 1); R(g, sp.skin[0], 17, 16, 2, 2); }
    else { R(g, t.base, 20, 19, 2, 4); R(g, t.base, 17, 22, 5, 2); R(g, '#fff', 13, 20, 4, 4); R(g, C.g1, 13, 23, 4, 1); R(g, sp.skin[0], 16, 21, 2, 3); }
  },
  sub(g, sp, f, ex) { torso(g, sp); armDown(g, sp, 8); armDown(g, sp, 20); drawHead(g, sp, HX, HY, 'front', ex); },
  subDone(g, sp, f, ex) {
    const t = toolOf(sp.tool);
    torso(g, sp);
    R(g, t.base, 3, 11, 4, 5); R(g, t.base, 5, 16, 4, 4); R(g, t.base, 23, 11, 4, 5); R(g, t.base, 21, 16, 4, 4);
    drawHead(g, sp, HX, HY, 'front', ex);
  },
};

function charSprite(sp, pose, f = 0, ex = 'calm', extra = 0) {
  return sprite(`${sp.key}|${pose}|${f}|${ex}|${extra}`, BW, BH, (g) => POSES[pose](g, sp, f, ex, extra));
}

function crownSprite() {
  return sprite('crown', 11, 6, (g) => {
    R(g, C.yellow, 0, 3, 11, 3); R(g, C.yellow, 0, 0, 1, 3); R(g, C.yellow, 5, 0, 1, 3); R(g, C.yellow, 10, 0, 1, 3);
    R(g, C.yellow, 1, 2, 1, 1); R(g, C.yellow, 4, 1, 3, 2); R(g, C.yellow, 9, 2, 1, 1);
    R(g, C.yellowD, 0, 5, 11, 1); R(g, C.red, 5, 3, 1, 2); R(g, C.cyan, 2, 4, 1, 1); R(g, C.cyan, 8, 4, 1, 1);
  });
}

/* --------------------------------------------------------------- icons -- */
const ICONS = {
  reading: ['.......', 'XX...XX', 'X.X.X.X', 'X..X..X', 'X..X..X', 'XXXXXXX', '.......'],
  editing: ['.....XX', '....XXX', '...XXX.', '..XXX..', '.XXX...', 'XX.....', 'X......'],
  running: ['.......', 'X......', '.X.....', '..X....', '.X.....', 'X..XXXX', '.......'],
  searching: ['.XXX...', 'X...X..', 'X...X..', 'X...X..', '.XXX...', '....XX.', '.....XX'],
  browsing: ['.XXXXX.', 'X.X.X.X', 'XXXXXXX', 'X.X.X.X', 'XXXXXXX', 'X.X.X.X', '.XXXXX.'],
  delegating: ['..XXX..', '..XXX..', '...X...', '.XXXXX.', '.X...X.', 'XXX.XXX', 'XXX.XXX'],
  writing: ['XXXXXX.', 'X....X.', 'X.XX.X.', 'X....X.', 'X.XXXX.', 'X....X.', 'XXXXXX.'],
  waiting: ['..XXX..', '..XXX..', '..XXX..', '..XXX..', '.......', '..XXX..', '..XXX..'],
  idle: ['XXXXX..', '...X...', '..X....', '.X.....', 'XXXXX..', '.....zz', '.......'],
  done: ['.......', '......X', '.....XX', 'X...XX.', 'XX.XX..', '.XXX...', '..X....'],
  failed: ['XX...XX', '.XX.XX.', '..XXX..', '..XXX..', '.XX.XX.', 'XX...XX', '.......'],
};
const ICON_COL = { reading: C.blue, editing: '#d86010', running: C.greenD, searching: '#7040d8', browsing: '#1890c8', delegating: C.redD, writing: C.g4, waiting: C.red, idle: C.g3, done: C.greenD, failed: C.red };

export function drawIcon(g, kind, x, y, col, tick = 0) {
  if (kind === 'thinking') {
    const n = ((tick >> 2) % 4);
    for (let i = 0; i < 3; i++) if (i < n || n === 3) R(g, col || C.g4, x + i * 3, y + 3 - (n === 3 && ((tick >> 1) % 3) === i ? 1 : 0), 2, 2);
    return;
  }
  const rows = ICONS[kind] || ICONS.writing;
  g.fillStyle = col || ICON_COL[kind] || C.K;
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) if (rows[r][c] !== '.') g.fillRect(x + c, y + r, 1, 1);
}
// Same icon as one cached blit (the animated "thinking" dots stay live).
function putIcon(g, kind, x, y, col, tick = 0) {
  if (kind === 'thinking') { drawIcon(g, kind, x, y, col, tick); return; }
  g.drawImage(cached(`ic|${kind}|${col || ''}`, 7, 7, (c) => drawIcon(c, kind, 0, 0, col)), x, y);
}

function bubble(g, x, y, kind, tick) {
  g.drawImage(cached('bubble', 13, 13, (c) => {
    R(c, C.K, 1, 0, 11, 11); R(c, C.K, 0, 1, 13, 9);
    R(c, '#fff', 1, 1, 11, 9);
    R(c, C.K, 1, 10, 4, 2); R(c, C.K, 0, 12, 3, 1); R(c, '#fff', 2, 10, 2, 1); R(c, '#fff', 1, 11, 2, 1);
  }), x, y);
  putIcon(g, kind, x + 3, y + 2, null, tick);
}

function bangBubble(g, x, y, tick, reduce) {
  const b = reduce ? 0 : [0, -1, -3, -4, -3, -1][tick % 6];
  g.drawImage(cached('bang', 14, 18, (c) => {
    R(c, C.K, 1, 0, 12, 16); R(c, C.K, 0, 1, 14, 14);
    R(c, C.yellow, 1, 1, 12, 14);
    R(c, '#fff', 1, 1, 12, 2);
    R(c, C.K, 1, 15, 5, 2); R(c, C.K, 0, 17, 3, 1); R(c, C.yellow, 2, 15, 3, 1); R(c, C.yellow, 1, 16, 2, 1);
    drawText(c, '!', 4, 3, C.red, 2);
    R(c, C.red, 5, 3, 4, 6); R(c, C.red, 5, 11, 4, 2);
  }), x, y + b);
}

/* ---------------------------------------------------------------- props -- */
function shadow(g, x, y, w) {
  g.fillStyle = 'rgba(0,0,0,.3)';
  g.fillRect(x + 1, y, w - 2, 1); g.fillRect(x, y + 1, w, 1);
}
const isDay = () => { const h = new Date().getHours(); return h >= 7 && h < 18; };

function drawWindow(g, x, y, w, h, tick, seed) {
  R(g, C.K, x - 1, y - 1, w + 2, h + 2); R(g, C.g1, x, y, w, h);
  const day = isDay();
  R(g, day ? '#6cc8fc' : '#141a48', x + 1, y + 1, w - 2, h - 2);
  if (day) {
    const cxp = x + 2 + ((((tick / 16) | 0) + seed) % (w + 6)) - 6;
    g.save(); g.beginPath(); g.rect(x + 1, y + 1, w - 2, h - 2); g.clip();
    R(g, '#fff', cxp, y + 4, 7, 2); R(g, '#fff', cxp + 2, y + 3, 3, 1);
    R(g, '#3a9a58', x + 1, y + h - 4, w - 2, 3);
    g.restore();
  } else {
    R(g, '#fce8a0', x + w - 6, y + 3, 3, 3); R(g, '#141a48', x + w - 5, y + 3, 2, 2);
    for (let i = 0; i < 5; i++) { const sx = x + 2 + ((seed >>> (i * 3)) % (w - 4)), sy = y + 2 + ((seed >>> (i * 5 + 1)) % (h - 8)); if ((tick + i * 7) % 40 > 3) R(g, '#fff', sx, sy); }
    for (let i = 0; i < w - 2; i += 4) { const bh = 2 + ((seed >>> (i % 13)) % 5); R(g, '#0a0c24', x + 1 + i, y + h - 1 - bh, 4, bh); if ((seed >>> i) & 1) R(g, C.yellow, x + 2 + i, y + h - bh, 1, 1); }
  }
  R(g, C.g1, x + (w >> 1), y, 1, h); R(g, C.g2, x, y + h - 1, w, 1);
}
function drawPoster(g, x, y, seed) {
  const cols = [C.red, C.cyan, C.yellow, C.purple, C.green, C.orange];
  const a = cols[seed % 6], b = cols[(seed >>> 3) % 6 === seed % 6 ? (seed + 1) % 6 : (seed >>> 3) % 6];
  R(g, C.K, x - 1, y - 1, 14, 17); R(g, '#f4ecd8', x, y, 12, 15); R(g, a, x + 1, y + 1, 10, 9);
  if (seed & 8) { R(g, b, x + 4, y + 3, 4, 4); R(g, b, x + 3, y + 4, 6, 2); } else { for (let i = 0; i < 5; i++) R(g, b, x + 5 - i, y + 4 + i, 1 + i * 2 > 10 ? 10 : 1 + i * 2, 1); }
  R(g, C.K, x + 2, y + 11, 8, 1); R(g, C.g2, x + 3, y + 13, 6, 1);
}
function drawShelf(g, x, y, seed) {
  R(g, C.K, x - 1, y + 9, 22, 3); R(g, C.woodL, x, y + 10, 20, 1);
  const cols = [C.red, C.cyan, C.yellow, C.purple, C.green, C.orange, C.g1];
  let bx = x + 1;
  for (let i = 0; i < 5; i++) { const bh = 5 + ((seed >>> (i * 2)) % 4), bw = 2 + ((seed >>> (i * 3)) & 1); R(g, C.K, bx - 1, y + 9 - bh, bw + 2, bh + 1); R(g, cols[(seed + i * 3) % 7], bx, y + 10 - bh, bw, bh); bx += bw + 1; }
  R(g, C.K, x + 14, y + 4, 6, 6); R(g, C.yellow, x + 15, y + 5, 4, 3); R(g, C.yellowD, x + 16, y + 8, 2, 2);
}
function drawCork(g, x, y, seed) {
  R(g, C.K, x - 1, y - 1, 22, 15); R(g, '#b88048', x, y, 20, 13); R(g, '#8a5a30', x, y, 20, 1);
  const cols = ['#fff', C.yellow, C.pink, '#a0e8ff', '#c0f8a0'];
  for (let i = 0; i < 5; i++) { const nx = x + 1 + i * 4 - (i & 1), ny = y + 2 + ((seed >>> (i * 2)) % 6); R(g, cols[(seed + i) % 5], nx, ny, 3, 4); R(g, C.red, nx + 1, ny, 1, 1); }
}
function drawClock(g, x, y, tick) {
  R(g, C.K, x + 2, y, 6, 10); R(g, C.K, x, y + 2, 10, 6); R(g, C.K, x + 1, y + 1, 8, 8);
  R(g, '#fff', x + 2, y + 1, 6, 8); R(g, '#fff', x + 1, y + 2, 8, 6);
  R(g, C.K, x + 5, y + 2, 1, 4); R(g, C.K, x + 5, y + 5, 3, 1);
  const s = ((Date.now() / 1000) | 0) % 8;
  const P = [[5, 1], [7, 2], [8, 5], [7, 7], [5, 8], [2, 7], [1, 5], [2, 2]][s];
  R(g, C.red, x + P[0], y + P[1]);
}
function drawBoardMini(g, x, y, t, seed) {
  R(g, C.K, x - 1, y - 1, 22, 15); R(g, C.g1, x, y, 20, 13); R(g, '#fff', x + 1, y + 1, 18, 11);
  for (let i = 0; i < 4; i++) R(g, i === 1 ? t.base : C.g3, x + 2, y + 2 + i * 2 + (i > 1 ? 1 : 0), 4 + ((seed >>> (i * 3)) % 11), 1);
  R(g, C.red, x + 13, y + 7, 4, 3);
}
const DECOR_ANIM = [true, true, false, false, false, false]; // window (clouds / stars), poster + clock
const WALL_DECOR = [
  (g, x, y, v) => drawWindow(g, x, y, 22, 15, v.tick, v.spec.seed),
  (g, x, y, v) => { drawPoster(g, x, y, v.spec.seed >>> 5); drawClock(g, x + 15, y + 2, v.tick); },
  (g, x, y, v) => drawShelf(g, x, y + 2, v.spec.seed >>> 6),
  (g, x, y, v) => drawCork(g, x, y + 1, v.spec.seed >>> 7),
  (g, x, y, v) => drawBoardMini(g, x, y + 1, toolOf(v.session.tool), v.spec.seed >>> 9),
  (g, x, y, v) => { drawPoster(g, x, y, v.spec.seed >>> 4); drawPoster(g, x + 15, y, v.spec.seed >>> 10); },
];

function drawPlant(g, x, by, variant) { // by = floor contact y
  R(g, C.K, x + 1, by - 6, 7, 7); R(g, '#c85828', x + 2, by - 6, 5, 6); R(g, '#f08048', x + 2, by - 6, 5, 1);
  if (variant & 1) {
    R(g, C.K, x + 3, by - 17, 3, 11); R(g, C.greenD, x + 4, by - 16, 1, 10);
    for (let i = 0; i < 4; i++) { const yy = by - 16 + i * 3, l = i & 1; R(g, C.K, x + (l ? 0 : 4), yy - 1, 5, 4); R(g, C.green, x + (l ? 1 : 5), yy, 3, 2); }
  } else {
    R(g, C.K, x - 1, by - 15, 11, 9); R(g, C.K, x + 1, by - 17, 7, 3);
    R(g, C.greenD, x, by - 14, 9, 7); R(g, C.green, x + 2, by - 16, 5, 6); R(g, '#b8f878', x + 3, by - 15, 2, 2); R(g, C.green, x + 1, by - 12, 2, 2);
  }
}
function drawBin(g, x, by) {
  R(g, C.K, x, by - 8, 8, 9); R(g, C.g2, x + 1, by - 7, 6, 7); R(g, C.g3, x + 2, by - 6, 1, 5); R(g, C.g3, x + 4, by - 6, 1, 5);
  R(g, C.K, x + 1, by - 11, 4, 4); R(g, '#fff', x + 2, by - 10, 2, 2); R(g, C.K, x + 4, by - 10, 4, 3); R(g, '#f4ecd8', x + 5, by - 9, 2, 2);
}
function drawBag(g, x, by, col) {
  R(g, C.K, x, by - 9, 9, 10); R(g, col, x + 1, by - 8, 7, 8); R(g, C.K, x + 2, by - 11, 5, 3); R(g, C.g4, x + 3, by - 10, 3, 1);
  R(g, C.K, x + 2, by - 4, 5, 1); R(g, '#fff', x + 4, by - 6, 1, 1);
}
function drawBoxes(g, x, by) {
  R(g, C.K, x, by - 7, 11, 8); R(g, '#c89858', x + 1, by - 6, 9, 6); R(g, '#f0d8a0', x + 4, by - 6, 3, 2);
  R(g, C.K, x + 2, by - 12, 8, 6); R(g, '#a87840', x + 3, by - 11, 6, 4); R(g, '#f0d8a0', x + 5, by - 11, 2, 1);
}
function drawCat(g, x, by, tick, seed) {
  const col = (seed & 1) ? '#f0a040' : '#8a8fa3';
  const tail = (tick >> 3) % 4 === 0 ? -1 : 0;
  R(g, C.K, x, by - 5, 11, 6); R(g, col, x + 1, by - 4, 9, 4);
  R(g, C.K, x + 6, by - 8, 6, 5); R(g, col, x + 7, by - 7, 4, 4); R(g, C.K, x + 7, by - 9, 2, 2); R(g, C.K, x + 10, by - 9, 2, 2); R(g, col, x + 7, by - 8); R(g, col, x + 11, by - 8);
  R(g, C.K, x + 8, by - 5, 1, 1); R(g, C.K, x + 10, by - 5, 1, 1);
  R(g, C.K, x - 2, by - 3 + tail, 3, 3); R(g, col, x - 1, by - 2 + tail, 2, 1);
}
const FLOOR_ANIM = 5; // the cat flicks its tail
const FLOOR_PROPS = [
  (g, x, by, v) => drawPlant(g, x, by, 0),
  (g, x, by, v) => drawPlant(g, x, by, 1),
  (g, x, by, v) => drawBin(g, x, by),
  (g, x, by, v) => drawBag(g, x, by, [C.red, C.blue, C.yellowD, C.purple][(v.spec.seed >>> 9) % 4]),
  (g, x, by, v) => drawBoxes(g, x - 1, by),
  (g, x, by, v) => drawCat(g, x, by, v.tick, v.spec.seed >>> 12),
];

function steam(g, x, y, tick) {
  const p = (tick >> 2) % 4;
  g.fillStyle = 'rgba(255,255,255,.75)';
  g.fillRect(x + (p & 1), y - p, 1, 1);
  g.fillRect(x + 1 - (p & 1), y - 2 - p, 1, 1);
}
const DESK_PROPS = [
  (g, x, y, v) => { R(g, C.K, x, y - 5, 5, 5); R(g, '#fff', x + 1, y - 4, 3, 4); R(g, C.K, x + 5, y - 4, 2, 3); R(g, toolOf(v.session.tool).base, x + 1, y - 3, 3, 1); },
  (g, x, y) => { R(g, C.K, x, y - 4, 6, 4); R(g, '#c85828', x + 1, y - 3, 4, 3); R(g, C.K, x + 1, y - 10, 4, 6); R(g, C.green, x + 2, y - 9, 2, 6); R(g, C.K, x - 1, y - 8, 2, 3); R(g, C.green, x, y - 7, 1, 1); R(g, C.K, x + 5, y - 7, 2, 3); R(g, C.green, x + 5, y - 6, 1, 1); R(g, C.pink, x + 2, y - 10, 2, 1); },
  (g, x, y, v) => { R(g, C.K, x + 1, y - 2, 6, 2); R(g, C.g2, x + 2, y - 1, 4, 1); R(g, C.K, x + 3, y - 9, 2, 8); R(g, C.g2, x + 3, y - 8, 1, 6); R(g, C.K, x - 2, y - 12, 8, 4); R(g, C.yellow, x - 1, y - 11, 6, 2); g.globalAlpha = 0.25; R(g, C.yellow, x - 3, y - 8, 9, 7); g.globalAlpha = 1; },
  (g, x, y, v) => { const s = v.spec.seed; R(g, C.K, x - 1, y - 7, 9, 7); R(g, C.red, x, y - 2, 7, 2); R(g, C.cyan, x + 1, y - 4, 6, 2); R(g, C.yellow, x, y - 6, 6, 2); R(g, '#fff', x + ((s >> 3) & 3), y - 5, 1, 1); },
  (g, x, y) => { R(g, C.K, x, y - 5, 7, 5); R(g, C.yellow, x + 1, y - 4, 5, 3); R(g, C.K, x + 2, y - 8, 5, 4); R(g, C.yellow, x + 3, y - 7, 3, 3); R(g, C.K, x + 5, y - 6); R(g, C.K, x + 6, y - 6, 3, 2); R(g, C.orange, x + 6, y - 5, 2, 1); },
  (g, x, y) => { R(g, C.K, x, y - 7, 4, 7); R(g, C.red, x + 1, y - 6, 2, 6); R(g, C.g1, x + 1, y - 6, 2, 1); R(g, C.K, x + 4, y - 6, 4, 6); R(g, C.cyan, x + 5, y - 5, 2, 5); R(g, C.g1, x + 5, y - 5, 2, 1); },
  (g, x, y) => { R(g, C.K, x + 1, y - 2, 6, 2); R(g, C.yellowD, x + 2, y - 1, 4, 1); R(g, C.K, x + 3, y - 4, 2, 2); R(g, C.K, x, y - 9, 8, 5); R(g, C.yellow, x + 1, y - 8, 6, 3); R(g, C.yellow, x + 2, y - 5, 4, 1); R(g, '#fff', x + 2, y - 8, 1, 2); },
  (g, x, y, v) => { R(g, C.K, x, y - 8, 8, 8); R(g, C.woodL, x + 1, y - 7, 6, 6); R(g, '#a0e0ff', x + 2, y - 6, 4, 4); R(g, C.green, x + 2, y - 3, 4, 1); R(g, v.spec.skin[0], x + 3, y - 5, 2, 2); },
];

const ROOMS = [
  { wall: '#3b4a8a', wall2: '#2e3a70', trim: '#5f70b8', floor: '#23284a', floor2: '#2e345c' },
  { wall: '#2c5a70', wall2: '#22465a', trim: '#4a88a0', floor: '#1e2c3a', floor2: '#28394a' },
  { wall: '#58488c', wall2: '#463a72', trim: '#8070c0', floor: '#272040', floor2: '#322a52' },
  { wall: '#4c5670', wall2: '#3c4459', trim: '#7884a8', floor: '#22252f', floor2: '#2d313e' },
  { wall: '#7a4a58', wall2: '#623a46', trim: '#b07888', floor: '#2c2030', floor2: '#382a3e' },
];

function roomShell(g, w, h, floorY, room, opts = {}) {
  const wallTop = Math.max(0, floorY - (opts.wallH || 50));
  R(g, room.wall, 0, 0, w, floorY);
  R(g, room.wall2, 0, floorY - 12, w, 12);
  R(g, room.trim, 0, floorY - 13, w, 1);
  if (wallTop > 0) {
    R(g, C.g5, 0, 0, w, wallTop); R(g, C.K, 0, wallTop - 1, w, 1);
    if (wallTop >= 10) for (let x = (w >> 1) - 150; x < w; x += 60) { R(g, C.K, x - 1, wallTop - 4, 26, 4); R(g, '#f8f8d8', x, wallTop - 3, 24, 2); }
    g.globalAlpha = 0.06; R(g, '#fff', 0, wallTop, w, 8); g.globalAlpha = 1;
  }
  R(g, C.K, 0, floorY - 2, w, 2);
  R(g, room.floor, 0, floorY, w, h - floorY);
  R(g, room.floor2, 0, floorY, w, 1);
  if (opts.checker) {
    for (let y = floorY + 1, r = 0; y < h; y += 5, r++) for (let x = -((r & 1) * 8) + ((w >> 1) % 16); x < w; x += 16) R(g, room.floor2, x, y, 8, 5);
  } else {
    for (let y = floorY + 5, r = 0; y < h; y += 6, r++) { R(g, room.floor2, 0, y, w, 1); for (let x = ((w >> 1) % 22) + (r & 1) * 11 - 22; x < w; x += 22) R(g, room.floor2, x, y - 5, 1, 5); }
  }
}

function drawDoor(g, x, floorY) {
  R(g, C.K, x - 1, floorY - 33, 20, 33); R(g, '#8a5a30', x, floorY - 32, 18, 31); R(g, '#a87040', x + 2, floorY - 30, 14, 12); R(g, '#a87040', x + 2, floorY - 15, 14, 12);
  R(g, C.yellow, x + 14, floorY - 15, 2, 2);
  R(g, C.K, x + 3, floorY - 40, 12, 6); R(g, C.greenD, x + 4, floorY - 39, 10, 4); putText(g, 'EX', x + 6, floorY - 39, '#c8ffc8');
}
function drawCabinet(g, x, by) {
  R(g, C.K, x, by - 20, 13, 21); R(g, C.g2, x + 1, by - 19, 11, 19);
  for (let i = 0; i < 3; i++) { R(g, C.g3, x + 1, by - 13 + i * 6, 11, 1); R(g, C.g1, x + 4, by - 17 + i * 6, 5, 1); }
  R(g, C.K, x + 2, by - 26, 8, 6); R(g, '#c89858', x + 3, by - 25, 6, 5);
}
function drawCooler(g, x, by) {
  R(g, C.K, x, by - 14, 10, 15); R(g, C.g1, x + 1, by - 13, 8, 13); R(g, C.g2, x + 1, by - 6, 8, 1); R(g, C.red, x + 2, by - 10, 2, 2); R(g, C.blue, x + 6, by - 10, 2, 2);
  R(g, C.K, x + 1, by - 25, 8, 11); R(g, '#70c8fc', x + 2, by - 24, 6, 10); R(g, '#b8e8ff', x + 2, by - 24, 6, 2);
}
function coolerFx(g, x, by, tick) {
  const b = (tick >> 2) % 8; R(g, '#fff', x + 3 + (b & 3), by - 16 - b, 1, 1);
}
function drawChair(g, bx, top, col = '#6a7094', colD = '#444a68') {
  R(g, C.K, bx + 4, top + 15, 5, 15); R(g, col, bx + 5, top + 16, 3, 13);
  R(g, C.K, bx + 5, top + 28, 16, 4); R(g, col, bx + 6, top + 29, 14, 2);
  R(g, C.K, bx + 11, top + 31, 4, 3); R(g, colD, bx + 12, top + 31, 2, 2);
  R(g, C.K, bx + 6, top + 33, 14, 2); R(g, colD, bx + 7, top + 33, 12, 1);
}
function drawDesk(g, dx, dty, dw, by) {
  R(g, C.K, dx - 1, dty - 1, dw + 2, 4); R(g, C.woodL, dx, dty, dw, 1); R(g, C.wood, dx, dty + 1, dw, 1);
  R(g, C.K, dx + 1, dty + 3, 4, by - dty - 2); R(g, C.woodD, dx + 2, dty + 3, 2, by - dty - 3);
  const ux = dx + dw - 15;
  R(g, C.K, ux, dty + 3, 15, by - dty - 2); R(g, C.wood, ux + 1, dty + 3, 13, by - dty - 3);
  R(g, C.woodD, ux + 1, dty + 7, 13, 1); R(g, C.woodL, ux + 5, dty + 5, 5, 1); R(g, C.woodL, ux + 5, dty + 9, 5, 1);
}
function monitorBody(g, mx, dty, t) {
  g.globalAlpha = 0.1; R(g, t.light, mx - 4, dty - 18, 24, 17); R(g, t.light, mx - 3, dty - 19, 22, 19); R(g, t.light, mx - 2, dty - 17, 20, 15); g.globalAlpha = 1;
  R(g, C.K, mx + 5, dty - 4, 6, 4); R(g, C.g2, mx + 6, dty - 3, 4, 2); R(g, C.K, mx + 3, dty - 1, 10, 1);
  R(g, C.K, mx, dty - 16, 16, 13); R(g, C.g3, mx + 1, dty - 15, 14, 11);
  R(g, C.green, mx + 13, dty - 5, 1, 1);
}
function monitorScreen(g, mx, dty, v) {
  const s = v.session, t = toolOf(s.tool), tick = v.tick, seed = v.spec.seed;
  const sx = mx + 2, sy = dty - 14;
  if (s.status === 'waiting') {
    R(g, t.base, sx, sy, 12, 9);
    putText(g, '>', sx + 2, sy + 2, '#fff');
    if ((tick >> 2) & 1) R(g, '#fff', sx + 6, sy + 6, 3, 1);
    return;
  }
  R(g, t.dark, sx, sy, 12, 9);
  for (let i = 0; i < 3; i++) {
    const len = 3 + (((seed >>> i) + i * 5 + (((tick + i * 3) / 6) | 0)) % 7);
    R(g, i === 1 ? '#fff' : t.light, sx + 1 + (i === 1 ? 2 : 0), sy + 1 + i * 2, len, 1);
  }
  const tl = (tick >> 1) % 9;
  R(g, t.light, sx + 1, sy + 7, tl, 1);
  if (tick & 2) R(g, '#fff', sx + 1 + tl, sy + 7, 1, 1);
}

/* --------------------------------------------------------------- scenes -- */
// Every scene is drawn in two passes. Pass 'bg' paints what never moves (room, furniture) into a layer that
// is cached per feed; pass 'fg' paints only what animates (people, screens, bubbles) over that layer each tick.

// Walk helper: returns x for a character walking between off-screen-left and its spot.
function walkX(v, spot, off = -34) {
  if (!v.walk) return null;
  const p = Math.min(1, Math.max(0, v.walk.p));
  return v.walk.dir === 'in' ? Math.round(off + (spot - off) * p) : Math.round(spot + (off - spot) * p);
}
function drawWalker(g, v, x, feet) {
  const f = v.tick % 4;
  const spr = charSprite(v.spec, 'walk', f, 'calm');
  shadow(g, x + 7, feet, 16);
  put(g, spr, x, feet - 30, v.walk.dir === 'out');
}

function sceneDesk(g, w, h, v) {
  const s = v.session, sp = v.spec, tick = v.tick, seed = sp.seed;
  const floorY = h - 20, feet = floorY + 8, cx = (w >> 1) + 1;
  const dA = (seed >>> 4) % WALL_DECOR.length;
  let dB = -1;
  if (w >= 112) { dB = (seed >>> 8) % WALL_DECOR.length; if (dB === dA) dB = (dB + 1) % WALL_DECOR.length; if (dB === 0) dB = 3; }
  const charX = cx - 32, by = feet - 33;
  const dx = cx - 12, dty = floorY + 1, dw = 43, mx = cx + 6;
  const fp = (seed >>> 15) % FLOOR_PROPS.length;
  const fpx = w >= 118 ? cx + 33 : Math.min(w - 10, cx + 33);
  const dp = (seed >>> 18) % DESK_PROPS.length;

  if (v.pass !== 'fg') {
    roomShell(g, w, h, floorY, ROOMS[(seed >>> 6) % ROOMS.length]);
    if (!DECOR_ANIM[dA]) WALL_DECOR[dA](g, cx + 11, floorY - 38, v);
    if (dB >= 0 && !DECOR_ANIM[dB]) WALL_DECOR[dB](g, cx - 52, floorY - 36, v);
    if (w >= 150) drawDoor(g, cx - 76, floorY);
    if (w >= 118) drawCabinet(g, cx + 43, floorY + 1);
    if (w >= 148) drawCooler(g, cx + 60, floorY + 2);
    if (fp !== FLOOR_ANIM) FLOOR_PROPS[fp](g, fpx, feet + 2, v); // floor prop tucked beside the desk
    drawDesk(g, dx, dty, dw, feet + 1);
    monitorBody(g, mx, dty, toolOf(s.tool));
    R(g, C.K, cx - 11, dty - 2, 10, 1); R(g, C.g1, cx - 10, dty - 1, 8, 1);
    DESK_PROPS[dp](g, cx + 24, dty, v);
    shadow(g, charX + 4, feet + 1, 20);
    drawChair(g, charX, by);
  }
  if (v.pass === 'bg') return;

  if (DECOR_ANIM[dA]) WALL_DECOR[dA](g, cx + 11, floorY - 38, v);
  if (dB >= 0 && DECOR_ANIM[dB]) WALL_DECOR[dB](g, cx - 52, floorY - 36, v);
  if (w >= 148) coolerFx(g, cx + 60, floorY + 2, tick);
  if (fp === FLOOR_ANIM) FLOOR_PROPS[fp](g, fpx, feet + 2, v);
  monitorScreen(g, mx, dty, v);
  if (dp === 0 && s.status === 'working') steam(g, cx + 26, dty - 6, tick);

  if (v.walk) {
    drawWalker(g, v, walkX(v, charX - 2), feet + 2);
    return;
  }
  if (s.status === 'waiting') {
    put(g, charSprite(sp, 'sitWave', v.reduce ? 0 : (tick >> 2) & 1, 'alert'), charX, by);
    bangBubble(g, charX + 27, by - 7, tick, v.reduce);
    return;
  }
  const kind = s.activity?.kind || 'thinking';
  const blink = (tick + seed) % 46 < 2;
  if (kind === 'thinking' || kind === 'reading') {
    put(g, charSprite(sp, 'sitChin', (tick >> 3) & 1, kind === 'thinking' ? 'think' : blink ? 'blink' : 'calm'), charX, by);
  } else {
    const slow = kind === 'searching' || kind === 'browsing';
    const f = slow ? (tick >> 2) & 1 : (tick >> 1) & 1;
    const bob = (tick >> 3) % 6 === 0 ? 1 : 0;
    put(g, charSprite(sp, 'sitType', f, blink ? 'blink' : 'work', bob), charX, by);
    if (!slow && f) { R(g, '#fff', cx - 9 + (tick % 5), dty - 3); }
  }
  bubble(g, charX + 25, by - 2, kind, tick);
}

const CONF = { wall: '#2a3458', wall2: '#3e2c50', trim: '#6a5a98', floor: '#5a2440', floor2: '#6c3050' };

// Where everybody sits. Up to `perRow` crew get a chair, a laptop and a name plate in one row. A bigger crew
// (up to 8) is staggered in two rows - seated in front, standing behind - with a status light per member on the
// table apron instead of name plates. Past 8, seven are drawn and the eighth place is a "+N" card.
function confPlan(w, count) {
  const tx0 = 73, tx1 = w - 5, tw = tx1 - tx0 - 4;
  const perRow = Math.max(1, Math.floor(tw / 22));
  const places = Math.min(count, 8);
  const shown = count > 8 ? 7 : count;
  const seats = [];
  if (places <= perRow) {
    const n = Math.max(places, Math.min(3, perRow));
    const pitch = tw / n;
    for (let i = 0; i < n; i++) seats.push({ x: Math.round(tx0 + 2 + pitch * (i + 0.5)), row: 0 });
    return { tx0, tx1, seats, pitch, two: false, shown, extra: count - shown };
  }
  const hp = tw / (places + 1);
  for (let k = 0; k < places; k++) seats.push({ x: Math.round(tx0 + 2 + hp * (k + 1)), row: k & 1 });
  return { tx0, tx1, seats, pitch: hp * 2, two: true, shown, extra: count - shown };
}

function sceneConf(g, w, h, v) {
  const s = v.session, sp = v.spec, tick = v.tick, seed = sp.seed, t = toolOf(s.tool);
  const floorY = h - 18 - Math.min(18, Math.max(11, v.safeBottom || 0)), feet = floorY + 8;
  const subs = s.subagents || [];
  const P = confPlan(w, subs.length);
  const { tx0, tx1, seats, shown } = P;
  const top = floorY + 2;
  const bx = 4, bw = 30, bh = 21, byy = floorY - 30; // presentation screen

  if (v.pass !== 'fg') {
    // a tall feed (one-column walls) gets a taller wall and window instead of a slab of dark ceiling
    const wallH = Math.max(44, Math.min(84, floorY - 6)), ext = Math.max(0, Math.min(26, wallH - 50));
    roomShell(g, w, h, floorY, CONF, { wallH });
    for (let x = 4; x < w; x += 14) R(g, '#4c3862', x, floorY - 10, 10, 6); // wainscot panels
    // skyline window behind the table
    const wx = tx0, ww = tx1 - tx0 - 3;
    if (ww > 30) {
      R(g, C.K, wx - 1, floorY - 36 - ext, ww + 2, 22 + ext); R(g, C.g3, wx, floorY - 35 - ext, ww, 20 + ext);
      const day = isDay();
      R(g, day ? '#5cb0e8' : '#10143c', wx + 1, floorY - 34 - ext, ww - 2, 18 + ext);
      for (let i = 0; i < ww - 2; i += 5) {
        const bh2 = 4 + ((seed >>> (i % 17)) % 9), bw2 = Math.min(5, ww - 2 - i);
        R(g, day ? '#3c78b0' : '#1c2258', wx + 1 + i, floorY - 16 - bh2, bw2, bh2);
        if (!day && ((seed >>> (i % 11)) & 1)) R(g, '#f8e080', wx + 2 + i, floorY - 15 - bh2 + 2 + (i % 3), 1, 1);
      }
      for (let x = wx + 24; x < wx + ww - 4; x += 25) R(g, C.g3, x, floorY - 35 - ext, 1, 20 + ext);
    }
    // presentation screen: glow, frame, stand
    g.globalAlpha = 0.14; R(g, t.light, bx - 3, byy - 3, bw + 6, bh + 6); g.globalAlpha = 1;
    R(g, C.K, bx - 1, byy - 1, bw + 2, bh + 2); R(g, C.g1, bx, byy, bw, bh);
    R(g, C.K, bx + 6, byy + bh + 1, 3, feet - byy - bh); R(g, C.K, bx + bw - 9, byy + bh + 1, 3, feet - byy - bh);
    R(g, C.g3, bx + 7, byy + bh + 1, 1, feet - byy - bh - 1); R(g, C.g3, bx + bw - 8, byy + bh + 1, 1, feet - byy - bh - 1);
    // chairs (single row only; in a two-row crowd the people hide them)
    if (!P.two) for (const st of seats) { R(g, C.K, st.x - 7, top - 13, 14, 14); R(g, '#3a3f60', st.x - 6, top - 12, 12, 12); R(g, '#4a5078', st.x - 6, top - 12, 12, 1); }
    // table legs + shadow
    R(g, C.K, tx0 + 3, top + 16, 4, feet + 2 - top - 16); R(g, C.K, tx1 - 7, top + 16, 4, feet + 2 - top - 16);
    shadow(g, tx0, feet + 2, tx1 - tx0);
  }
  if (v.pass === 'bg') return;

  // screen content: one bar per crew member
  R(g, C.g5, bx + 1, byy + 1, bw - 2, bh - 2);
  R(g, t.base, bx + 2, byy + 2, bw - 4, 3);
  R(g, t.light, bx + 3, byy + 3, 9, 1); R(g, '#fff', bx + 14, byy + 3, 5, 1);
  const baseY = byy + bh - 3;
  R(g, C.g3, bx + 2, baseY, bw - 4, 1);
  for (let i = 0; i < Math.min(subs.length, 8); i++) {
    const su = subs[i];
    let bhh, col;
    if (su.status === 'done') { bhh = 11; col = C.green; }
    else if (su.status === 'failed') { bhh = 3; col = C.red; }
    else { bhh = 3 + ((((tick + i * 5) / 5) | 0) % 7); col = t.light; }
    R(g, col, bx + 3 + i * 3, baseY - bhh, 2, bhh);
  }

  // crew: back row first, then the seated row, then the table in front of both
  const headTopOf = (st) => top - 24 - (st.row ? 10 : 0) + HY;
  for (let row = 1; row >= 0; row--) {
    for (let i = 0; i < shown; i++) {
      const st = seats[i];
      if (st.row !== row) continue;
      const su = subs[i];
      const ssp = charSpec(s.id + '#' + su.id, s.tool);
      const boxX = st.x - 15, boxY = top - 24 - (row ? 10 : 0);
      const pose = row ? 'stand' : su.status === 'done' && P.pitch >= 33 ? 'subDone' : 'sub';
      let ex, dy = 0;
      if (su.status === 'done') ex = 'happy';
      else if (su.status === 'failed') { ex = 'dead'; dy = row ? 3 : 6; }
      else { dy = ((tick + i * 5) >> 2) % 5 === 0 ? 1 : 0; ex = (tick + ssp.seed) % 50 < 2 ? 'blink' : 'down'; }
      put(g, charSprite(ssp, pose, 0, ex), boxX, boxY + dy);
      if (v.hits) v.hits.push({ id: su.id, x: st.x - 9, y: boxY + 2, w: 18, h: row ? 22 : 40 });
    }
  }

  // table top + apron
  R(g, C.K, tx0 - 1, top - 1, tx1 - tx0 + 2, 17);
  R(g, C.woodL, tx0, top, tx1 - tx0, 1); R(g, C.wood, tx0, top + 1, tx1 - tx0, 5);
  R(g, C.woodD, tx0, top + 6, tx1 - tx0, 9); R(g, '#5c2c10', tx0, top + 6, tx1 - tx0, 1);

  for (let i = 0; i < shown; i++) {
    const su = subs[i], st = seats[i], x = st.x;
    const working = su.status === 'working';
    if (!st.row) {
      // laptop (lid facing us when open)
      if (working) {
        R(g, C.K, x - 5, top - 5, 10, 7); R(g, C.g1, x - 4, top - 4, 8, 5); R(g, t.base, x - 1, top - 3, 2, 2);
        R(g, C.K, x - 6, top + 2, 12, 2); R(g, C.g2, x - 5, top + 2, 10, 1);
        if (((tick + i * 3) >> 1) & 1) { g.globalAlpha = 0.5; R(g, t.light, x - 3, top - 7, 6, 1); g.globalAlpha = 1; }
      } else {
        R(g, C.K, x - 6, top + 1, 12, 3); R(g, C.g1, x - 5, top + 2, 10, 1);
      }
    }
    const headTop = headTopOf(st);
    if (P.two) {
      // status light on the apron under each member
      R(g, C.K, x - 5, top + 6, 11, 10);
      if (working) {
        R(g, '#fff', x - 4, top + 7, 9, 8);
        R(g, ((tick >> 2) + i) & 1 ? t.base : t.light, x - 2, top + 9, 5, 4);
      } else {
        R(g, su.status === 'done' ? C.greenD : C.red, x - 4, top + 7, 9, 8);
        putIcon(g, su.status === 'done' ? 'done' : 'failed', x - 3, top + (su.status === 'done' ? 7 : 8), '#fff');
      }
    } else {
      // name plate
      const nm = String(su.name || su.agentType || `A${i + 1}`).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, P.pitch >= 23 ? 4 : 3) || `A${i + 1}`;
      const pw = textW(nm) + 4;
      const px = x - (pw >> 1);
      R(g, C.K, px - 1, top + 7, pw + 2, 9);
      R(g, su.status === 'done' ? '#c8f8c0' : su.status === 'failed' ? '#ffc0b0' : '#fff', px, top + 8, pw, 7);
      putText(g, nm, px + 2, top + 9, C.K);
      // done / failed badge on the corner of the head (a single row always leaves room for it)
      if (su.status === 'done') {
        R(g, C.K, x + 2, headTop - 5, 9, 9); R(g, C.greenD, x + 3, headTop - 4, 7, 7); putIcon(g, 'done', x + 3, headTop - 5, '#fff');
      } else if (su.status === 'failed') {
        R(g, C.K, x + 2, headTop - 3, 9, 9); R(g, C.red, x + 3, headTop - 2, 7, 7); putIcon(g, 'failed', x + 3, headTop - 2, '#fff');
      }
    }
    if (v.hiSub === su.id) {
      const b = v.reduce ? 0 : (tick >> 1) & 1;
      const ay = headTop - 11 + b;
      R(g, C.K, x - 4, ay - 1, 9, 4); R(g, C.K, x - 2, ay + 3, 5, 2); R(g, C.K, x - 1, ay + 5, 3, 1);
      R(g, C.yellow, x - 3, ay, 7, 2); R(g, C.yellow, x - 2, ay + 2, 5, 1); R(g, C.yellow, x - 1, ay + 3, 3, 1); R(g, C.yellow, x, ay + 4, 1, 1);
    }
  }
  if (P.extra > 0 && seats[shown]) {
    const st = seats[shown];
    const label = '+' + P.extra;
    const pw = textW(label, 2) + 4;
    const cy = headTopOf(st) - 1;
    const px = Math.min(w - pw - 2, st.x - (pw >> 1));
    R(g, C.K, px - 1, cy, pw + 2, 16); R(g, C.yellow, px, cy + 1, pw, 14); R(g, '#fff', px, cy + 1, pw, 1);
    putText(g, label, px + 2, cy + 3, C.K, 2);
  }

  // boss at the lectern, left of the table, with a clear column for the activity bubble
  const bossBox = 30, bossTop = feet - 30;
  const lx = bossBox + 5, lw = 21;
  if (v.walk) {
    drawWalker(g, v, walkX(v, bossBox), feet);
  } else {
    let spr;
    if (s.status === 'waiting') spr = charSprite(sp, 'wave', v.reduce ? 0 : (tick >> 2) & 1, 'alert');
    else spr = charSprite(sp, 'point', (tick >> 3) & 1, (tick >> 2) % 3 === 0 ? 'talk' : 'work');
    put(g, spr, bossBox, bossTop);
    // pointer stick to the screen
    if (s.status !== 'waiting') { const py = bossTop + ((tick >> 3) & 1 ? 18 : 15); R(g, C.K, bx + bw - 3, py - 1, bossBox + 3 - (bx + bw - 3), 3); R(g, C.yellow, bx + bw - 2, py, bossBox + 2 - (bx + bw - 2), 1); }
    put(g, crownSprite(), bossBox + HX + 2, bossTop + HY - 6);
  }
  // lectern in front of the boss
  g.drawImage(cached('lectern|' + s.tool, lw + 2, 12, (c) => {
    R(c, C.K, 0, 0, lw + 2, 11); R(c, t.base, 1, 1, lw, 9); R(c, t.light, 1, 1, lw, 1); R(c, t.dark, 1, 9, lw, 1);
    R(c, C.K, 3, 2, 17, 7); drawText(c, 'BOSS', 4, 3, C.yellow);
    c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(1, 10, lw, 1); c.fillRect(0, 11, lw + 2, 1);
  }), lx - 1, feet - 8);
  if (v.walk) return;
  if (s.status === 'waiting') bangBubble(g, 56, bossTop - 9, tick, v.reduce);
  else bubble(g, 56, bossTop - 4, s.activity?.kind || 'delegating', tick);
}

const BREAK = { wall: '#5c4a3c', wall2: '#4a3a30', trim: '#8a7058', floor: '#2a2c3e', floor2: '#34374c' };
const CANS = [C.red, C.green, C.yellow, C.purple, C.orange, C.blue];

function sceneBreak(g, w, h, v) {
  const s = v.session, sp = v.spec, tick = v.tick, seed = sp.seed;
  const floorY = h - 20, feet = floorY + 8, cx = (w >> 1);
  const vx = cx + 16, vt = feet - 38; // vending machine
  const kx = cx - 40, seatTop = floorY + 1; // couch
  const kc = ['#d86838', '#3878c8', '#7858c0', '#3a9870'][(seed >>> 5) % 4], kd = ['#a04420', '#24508c', '#503890', '#226848'][(seed >>> 5) % 4];
  const tbx = cx + 6; // side table
  const glass = (col) => {
    R(g, col, vx + 3, vt + 3, 10, 20);
    for (let r = 0; r < 4; r++) { for (let c = 0; c < 3; c++) R(g, CANS[(r * 3 + c + seed) % 6], vx + 4 + c * 3, vt + 4 + r * 5, 2, 3); R(g, C.g2, vx + 3, vt + 7 + r * 5, 10, 1); }
  };

  if (v.pass !== 'fg') {
    roomShell(g, w, h, floorY, BREAK, { checker: true });
    for (let x = (cx % 8) - 8; x < w; x += 8) R(g, '#665242', x, Math.max(0, floorY - 50), 1, Math.min(floorY, 50) - 13);
    if (w >= 110) { R(g, C.K, cx - 46, floorY - 35, 23, 9); R(g, '#f4ecd8', cx - 45, floorY - 34, 21, 7); putText(g, 'BREAK', cx - 44, floorY - 33, C.redD); }
    if (w >= 132) drawPlant(g, cx - 62, feet + 1, 1);
    if (w >= 150) drawCooler(g, cx + 54, feet);
    g.globalAlpha = 0.12; R(g, '#a0e8ff', vx - 4, vt - 2, 28, 42); g.globalAlpha = 1;
    R(g, C.K, vx - 1, vt - 1, 22, 40); R(g, C.red, vx, vt, 20, 38); R(g, C.redD, vx + 17, vt, 3, 38);
    R(g, C.K, vx + 2, vt + 2, 12, 22); glass('#b8ecff');
    R(g, C.K, vx + 15, vt + 4, 3, 8); R(g, C.green, vx + 16, vt + 5, 1, 1); R(g, C.g1, vx + 16, vt + 8, 1, 3);
    R(g, C.K, vx + 2, vt + 27, 12, 7); R(g, C.g4, vx + 3, vt + 28, 10, 5);
    R(g, '#fff', vx + 2, vt + 25, 12, 1);
    shadow(g, vx - 1, feet + 1, 22);
    R(g, C.K, kx - 1, seatTop - 13, 46, 22); R(g, kd, kx, seatTop - 12, 44, 12); R(g, kc, kx + 1, seatTop - 12, 42, 2);
    R(g, kc, kx, seatTop, 44, 4); R(g, kd, kx, seatTop + 4, 44, 4);
    R(g, C.K, kx - 3, seatTop - 6, 7, 15); R(g, kc, kx - 2, seatTop - 5, 5, 13); R(g, C.K, kx + 40, seatTop - 6, 7, 15); R(g, kc, kx + 41, seatTop - 5, 5, 13);
    R(g, kd, kx + 21, seatTop - 10, 1, 14);
    R(g, C.K, kx - 1, seatTop + 8, 3, 2); R(g, C.K, kx + 42, seatTop + 8, 3, 2);
    shadow(g, kx - 3, feet + 2, 50);
    R(g, C.K, tbx - 1, floorY + 1, 9, 3); R(g, C.woodL, tbx, floorY + 2, 7, 1); R(g, C.K, tbx + 2, floorY + 4, 3, 7); R(g, C.woodD, tbx + 3, floorY + 4, 1, 6);
  }
  if (v.pass === 'bg') return;

  drawClock(g, cx - 6, floorY - 36, tick);
  if (w >= 150) coolerFx(g, cx + 54, feet, tick);
  if (tick % 37 === 0) glass('#70b8d8'); // the vending machine light flickers

  const variant = hash(s.id + ':break') % 5 < 2 ? 1 : 0; // 0 couch nap, 1 coffee by the machine
  const spotX = variant ? cx - 10 : kx + 6;
  if (v.walk) {
    drawWalker(g, v, walkX(v, spotX), feet + 2);
    R(g, C.K, tbx + 1, floorY - 3, 5, 5); R(g, '#fff', tbx + 2, floorY - 2, 3, 3);
    return;
  }
  if (variant) {
    const sipping = (tick + seed) % 60 < 14;
    shadow(g, spotX + 7, feet + 2, 16);
    put(g, charSprite(sp, 'sip', sipping ? 1 : 0, sipping ? 'sip' : 'calm'), spotX, feet + 2 - 30);
    if (!sipping) steam(g, spotX + 14, feet + 2 - 30 + 18, tick);
    R(g, kc, kx + 8, seatTop - 8, 9, 8); R(g, C.K, kx + 7, seatTop - 9, 11, 1); R(g, kd, kx + 8, seatTop - 1, 9, 1);
  } else {
    const breathe = (tick >> 4) & 1;
    put(g, charSprite(sp, 'sitCalm', breathe, 'sleep'), spotX, seatTop - 29 + 1);
    R(g, C.K, tbx + 1, floorY - 3, 5, 5); R(g, '#fff', tbx + 2, floorY - 2, 3, 3); R(g, C.K, tbx + 6, floorY - 2, 1, 2);
    // sleep bubble at the nose + drifting Zs
    const bp = (tick >> 2) % 8, br = bp < 4 ? bp : 7 - bp;
    const nx = spotX + HX + 10, ny = seatTop - 28 + HY + 9 + breathe;
    if (br > 0) { const d = br + 1; R(g, C.K, nx, ny - d, d + 2, d + 2); R(g, '#a8e0ff', nx + 1, ny - d + 1, d, d); R(g, '#fff', nx + 1, ny - d + 1, 1, 1); }
    const zp = (tick >> 2) % 12;
    const zx = spotX + 25, zy = seatTop - 30;
    const zed = (x, y, sc) => { putText(g, 'Z', x + 1, y + 1, C.K, sc); putText(g, 'Z', x, y, '#fff', sc); };
    if (zp >= 1) zed(zx, zy + 8, 1);
    if (zp >= 4) zed(zx + 5, zy + 1, 1);
    if (zp >= 7) zed(zx + 10, zy - 9, 2);
  }
}

/* -------------------------------------------------------------- standby -- */
// What a monitor shows when no agent is on it: empty rooms with a little ambient life (never a person, so a
// standby feed can't be mistaken for an agent), a test card, a spare input hunting for signal, a dark screen.
// v: { kind, seed, tick, time (ms), reduce, pass }
export const STANDBY = ['lobby', 'server', 'bars', 'corridor', 'roof', 'nosignal', 'off'];
export const STANDBY_LABEL = { lobby: 'LOBBY', server: 'SERVER ROOM', bars: 'TEST CARD', corridor: 'CORRIDOR', roof: 'ROOF', nosignal: 'SPARE INPUT', off: 'SPARE MONITOR' };
const STANDBY_STATIC = { bars: true, off: true };

const LOBBY = { wall: '#3c4459', wall2: '#33394c', trim: '#6c7694', floor: '#22252f', floor2: '#2d313e' };
function sbLobby(g, w, h, v) {
  const floorY = h - 20, feet = floorY + 8, cx = w >> 1;
  const rx = cx - 24, rw = 38; // reception counter
  if (v.pass !== 'fg') {
    roomShell(g, w, h, floorY, LOBBY, { checker: true });
    R(g, C.K, cx - 13, floorY - 37, 27, 9); R(g, '#f4ecd8', cx - 12, floorY - 36, 25, 7); putText(g, 'LOBBY', cx - 9, floorY - 35, C.g4);
    drawDoor(g, cx + 22, floorY);
    drawPlant(g, cx - 40, feet + 1, 0);
    R(g, C.K, rx - 1, floorY - 5, rw + 2, 15); R(g, C.woodL, rx, floorY - 4, rw, 1); R(g, C.wood, rx, floorY - 3, rw, 3);
    R(g, C.woodD, rx, floorY, rw, 9); R(g, '#5c2c10', rx, floorY, rw, 1);
    R(g, C.K, rx + 4, floorY - 9, 7, 4); R(g, C.yellow, rx + 5, floorY - 8, 5, 3); R(g, C.K, rx + 7, floorY - 10, 1, 1); // desk bell
    shadow(g, rx - 1, floorY + 10, rw + 2);
  }
  if (v.pass === 'bg') return;
  drawClock(g, cx - 34, floorY - 36, v.tick);
  // the office cat naps on the counter and now and then patrols the floor
  const p = v.reduce ? 20 : (v.time / 1000 + (v.seed % 30)) % 46;
  if (p < 9) drawCat(g, Math.round(-14 + (w + 16) * (p / 9)), feet + 2 - ((v.tick >> 1) & 1), v.tick, v.seed);
  else drawCat(g, rx + 17, floorY - 5, v.reduce ? 1 : v.tick, v.seed);
}

const CORRIDOR = { wall: '#40584c', wall2: '#33483e', trim: '#6c9480', floor: '#20282a', floor2: '#2a3436' };
function sbCorridor(g, w, h, v) {
  const floorY = h - 20, feet = floorY + 8, cx = w >> 1;
  if (v.pass !== 'fg') {
    roomShell(g, w, h, floorY, CORRIDOR);
    for (let i = -2; i <= 2; i++) {
      const x = cx - 10 + i * 30;
      if (x < 0 || x + 20 > w) continue;
      R(g, C.K, x - 1, floorY - 31, 20, 31); R(g, '#58687c', x, floorY - 30, 18, 29); R(g, '#6c7c90', x + 2, floorY - 28, 14, 11); R(g, '#6c7c90', x + 2, floorY - 14, 14, 11);
      R(g, C.yellow, x + 14, floorY - 15, 2, 2);
      R(g, C.K, x + 2, floorY - 39, 15, 7); R(g, '#f4ecd8', x + 3, floorY - 38, 13, 5); putText(g, String(102 + i), x + 4, floorY - 38, C.g4);
    }
    R(g, C.K, cx + 12, floorY - 15, 5, 10); R(g, C.red, cx + 13, floorY - 14, 3, 8); R(g, C.g1, cx + 14, floorY - 17, 1, 2); // extinguisher
  }
  if (v.pass === 'bg') return;
  // a floor robot sweeps back and forth
  const span = Math.max(1, w - 16);
  const ph = v.reduce ? span / 3 : (v.time / 1000 * 5 + (v.seed % 50)) % (span * 2);
  const x = 3 + Math.round(ph < span ? ph : span * 2 - ph);
  shadow(g, x, feet + 3, 11);
  R(g, C.K, x, feet - 2, 11, 5); R(g, C.g1, x + 1, feet - 1, 9, 2); R(g, C.g2, x + 1, feet + 1, 9, 1);
  R(g, (v.tick & 4) ? C.green : C.greenD, x + 5, feet - 1, 1, 1);
  // one ceiling tube flickers every few seconds
  const fl = (v.tick + v.seed) % 110;
  if (!v.reduce && fl < 6 && (fl & 1)) { g.globalAlpha = 0.3; R(g, '#000', 0, 0, w, h); g.globalAlpha = 1; }
}

const SERVER = { wall: '#1c2438', wall2: '#161c2c', trim: '#34406a', floor: '#14161f', floor2: '#1c1f2c' };
function sbServer(g, w, h, v) {
  const floorY = h - 20, feet = floorY + 8;
  const n = Math.max(3, Math.min(6, Math.floor((w - 6) / 20)));
  const x0 = (w - n * 20 + 4) >> 1;
  if (v.pass !== 'fg') {
    roomShell(g, w, h, floorY, SERVER, { checker: true });
    for (let i = 0; i < n; i++) {
      const x = x0 + i * 20;
      R(g, C.K, x - 1, floorY - 34, 18, 43); R(g, '#2a2e44', x, floorY - 33, 16, 41); R(g, '#3a3f5c', x, floorY - 33, 16, 1);
      for (let r = 0; r < 6; r++) R(g, '#10121c', x + 2, floorY - 30 + r * 6, 12, 4);
      shadow(g, x - 1, feet + 2, 18);
    }
    g.globalAlpha = 0.08; R(g, C.cyan, 0, floorY - 36, w, 46); g.globalAlpha = 1;
  }
  if (v.pass === 'bg') return;
  const tk = v.reduce ? 0 : v.tick >> 2;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * 20;
    for (let r = 0; r < 6; r++) {
      const hsh = v.seed + i * 7 + r * 13;
      const y = floorY - 29 + r * 6;
      R(g, (tk + hsh) % (3 + (hsh % 5)) ? C.green : '#0a3a18', x + 3, y, 1, 1);
      if ((tk + hsh * 3) % 9 === 0) R(g, C.orange, x + 5, y, 1, 1);
      R(g, '#1e6a8c', x + 7, y + 1, 1 + ((tk + hsh) % 5), 1);
    }
  }
}

function sbRoof(g, w, h, v) {
  const day = isDay(), roofY = h - 16;
  const ax = 7, mx = w - 20, dxp = (w >> 1) + 6;
  if (v.pass !== 'fg') {
    R(g, day ? '#6cc8fc' : '#0c1030', 0, 0, w, h);
    if (day) R(g, '#fff8c0', w - 40, 7, 6, 6);
    else { R(g, '#fce8a0', w - 40, 7, 5, 5); R(g, '#0c1030', w - 39, 7, 4, 3); for (let i = 0; i < 9; i++) R(g, '#c8ccd8', (v.seed >>> i) % w, 3 + ((v.seed >>> (i + 5)) % Math.max(4, roofY - 26)), 1, 1); }
    for (let x = 0, i = 0; x < w; x += 9, i++) {
      const bh = 6 + ((v.seed >>> (i % 20)) % 13);
      R(g, day ? '#3c78b0' : '#1c2258', x, roofY - bh, 9, bh);
      if (!day && ((v.seed >>> (i % 13)) & 1)) { R(g, '#f8e080', x + 2, roofY - bh + 2, 1, 1); R(g, '#f8e080', x + 5, roofY - bh + 4, 1, 1); }
    }
    R(g, C.K, 0, roofY - 1, w, 1); R(g, '#4c5670', 0, roofY, w, 3); R(g, '#2d313e', 0, roofY + 3, w, h - roofY - 3);
    for (let x = 6; x < w; x += 18) R(g, '#383d4e', x, roofY + 6, 9, 1);
    // air-conditioning unit
    R(g, C.K, ax - 1, roofY - 13, 24, 14); R(g, C.g2, ax, roofY - 12, 22, 12); R(g, C.g3, ax, roofY - 2, 22, 2);
    R(g, C.K, ax + 2, roofY - 10, 9, 8);
    for (let i = 0; i < 3; i++) R(g, C.g3, ax + 14, roofY - 9 + i * 2, 6, 1);
    // dish
    R(g, C.K, dxp + 3, roofY - 5, 3, 5); R(g, C.K, dxp - 2, roofY - 12, 13, 8); R(g, C.g1, dxp - 1, roofY - 11, 11, 5); R(g, C.g2, dxp + 1, roofY - 6, 7, 1); R(g, C.K, dxp + 4, roofY - 14, 1, 5);
    // antenna mast
    R(g, C.K, mx - 1, roofY - 31, 3, 31); R(g, C.g1, mx, roofY - 30, 1, 30); R(g, C.K, mx - 5, roofY - 24, 11, 1); R(g, C.K, mx - 3, roofY - 18, 7, 1);
  }
  if (v.pass === 'bg') return;
  R(g, C.g4, ax + 3, roofY - 9, 7, 6);
  if (v.reduce || (v.tick >> 1) & 1) R(g, C.g1, ax + 6, roofY - 9, 1, 6); else R(g, C.g1, ax + 3, roofY - 6, 7, 1);
  if (v.reduce || (v.tick >> 3) & 1) { R(g, C.red, mx - 1, roofY - 33, 3, 2); g.globalAlpha = 0.25; R(g, C.red, mx - 3, roofY - 35, 7, 6); g.globalAlpha = 1; }
  if (day) {
    const x = Math.round(((v.reduce ? 0 : v.time / 500) + v.seed) % (w + 24)) - 14;
    R(g, '#fff', x, 14, 11, 3); R(g, '#fff', x + 2, 12, 6, 2);
  } else if (!v.reduce && (v.tick >> 2) % 5 === 0) {
    R(g, '#fff', (v.seed >>> 3) % w, 4 + ((v.seed >>> 9) % 8), 1, 1);
  }
}

const BARS = ['#c8c8c8', '#c8c832', '#32c8c8', '#32c832', '#c832c8', '#c83232', '#3232c8'];
function sbBars(g, w, h, v) {
  if (v.pass === 'fg') return;
  const bh = Math.round(h * 0.7), sh = Math.max(3, Math.round(h * 0.08));
  for (let i = 0; i < 7; i++) {
    const x0 = Math.round((i * w) / 7), x1 = Math.round(((i + 1) * w) / 7);
    R(g, BARS[i], x0, 0, x1 - x0, bh);
    R(g, i & 1 ? '#161616' : BARS[6 - i], x0, bh, x1 - x0, sh);
  }
  const ramp = ['#000', '#2c2c2c', '#585858', '#909090', '#f0f0f0', '#000'];
  for (let i = 0; i < 6; i++) { const x0 = Math.round((i * w) / 6), x1 = Math.round(((i + 1) * w) / 6); R(g, ramp[i], x0, bh + sh, x1 - x0, h - bh - sh); }
  const sc = w >= 150 ? 2 : 1, tw = textW('STANDBY', sc);
  const x = (w - tw) >> 1, y = (bh >> 1) - 2 * sc;
  R(g, '#000', x - 4, y - 4, tw + 8, 5 * sc + 8);
  putText(g, 'STANDBY', x, y, '#fff', sc);
}

function sbNoSignal(g, w, h, v) {
  if (v.pass !== 'fg') { R(g, '#05060c', 0, 0, w, h); if (v.pass === 'bg') return; }
  const bw = 41, bh = 11;
  const t = v.reduce ? 0 : v.time / 1000 + (v.seed % 20);
  const sx = Math.max(1, w - bw), sy = Math.max(1, h - bh);
  const tri = (p, span) => { const m = p % (span * 2); return m < span ? m : span * 2 - m; };
  const x = v.reduce ? sx >> 1 : Math.round(tri(t * 9, sx)), y = v.reduce ? sy >> 1 : Math.round(tri(t * 6, sy));
  const col = ['#5a6088', '#4a7a8c', '#6a5a90', '#4c7a64'][(Math.floor((t * 9) / sx) + Math.floor((t * 6) / sy)) % 4]; // dim on purpose: nothing spare may shout
  R(g, col, x, y, bw, bh); R(g, '#05060c', x + 1, y + 1, bw - 2, bh - 2);
  putText(g, 'NO SIGNAL', x + 3, y + 3, col);
}

function sbOff(g, w, h, v) {
  if (v.pass === 'fg') return;
  R(g, '#05060c', 0, 0, w, h);
  g.globalAlpha = 0.05;
  for (let i = 0; i < 10; i++) R(g, '#fff', (w >> 2) + i * 2, 4 + i * 3, w >> 2, 3); // glass reflection
  g.globalAlpha = 1;
}
const SB_SCENES = { lobby: sbLobby, server: sbServer, bars: sbBars, corridor: sbCorridor, roof: sbRoof, nosignal: sbNoSignal, off: sbOff };

// Returns false when the feed is static and already painted (nothing was drawn).
export function renderStandby(g, w, h, v, layer) {
  const scene = SB_SCENES[v.kind] || sbOff;
  const key = `${v.kind}|${w}|${h}|${v.seed}|${isDay() ? 1 : 0}|${v.reduce ? 1 : 0}`;
  const fresh = paintLayer(layer, key, w, h, (lg) => { v.pass = 'bg'; scene(lg, w, h, v); });
  if (!fresh && STANDBY_STATIC[v.kind] && layer.shown === g.canvas) return false;
  layer.shown = g.canvas;
  g.imageSmoothingEnabled = false;
  g.drawImage(layer.canvas, 0, 0);
  v.pass = 'fg';
  scene(g, w, h, v);
  return true;
}

/* ------------------------------------------------------------------- fx -- */
let noise = null;
function noiseFrames() {
  if (noise) return noise;
  noise = [];
  for (let f = 0; f < 4; f++) {
    const c = makeCanvas(96, 64);
    const g = c.getContext('2d');
    const img = g.createImageData(96, 64);
    let s = 1234567 + f * 7919;
    for (let i = 0; i < 96 * 64; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      const vv = (s >>> 16) & 255;
      const lum = vv > 150 ? 220 : vv > 90 ? 120 : 24;
      img.data[i * 4] = lum; img.data[i * 4 + 1] = lum; img.data[i * 4 + 2] = lum + 10; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    noise.push(c);
  }
  return noise;
}
export function fxStatic(g, w, h, tick, alpha = 1) {
  const fr = noiseFrames()[tick % 4];
  g.globalAlpha = alpha;
  const ox = (tick * 37) % 96, oy = (tick * 23) % 64;
  for (let y = -oy; y < h; y += 64) for (let x = -ox; x < w; x += 96) g.drawImage(fr, x, y);
  g.globalAlpha = 1;
}
function fxPowerOn(g, w, h, p) {
  R(g, '#000', 0, 0, w, h);
  const lw = Math.round(w * Math.min(1, p * 2.2));
  const lh = p < 0.45 ? 1 : Math.max(1, Math.round(h * ((p - 0.45) / 0.55)));
  R(g, '#e8f4ff', (w - lw) >> 1, (h - lh) >> 1, lw, lh);
}
function fxNoSignal(g, w, h, tick, reduce) {
  if (reduce) R(g, C.g5, 0, 0, w, h); else fxStatic(g, w, h, tick, 1);
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, w, h);
  const sc = w >= 110 ? 2 : 1;
  const tw = textW('NO SIGNAL', sc);
  const x = (w - tw) >> 1, y = (h >> 1) - 3 * sc;
  R(g, '#000', x - 4, y - 4, tw + 8, 5 * sc + 8); R(g, '#fff', x - 3, y - 3, tw + 6, 1); R(g, '#fff', x - 3, y + 5 * sc + 2, tw + 6, 1);
  if (reduce || (tick >> 2) & 1) putText(g, 'NO SIGNAL', x, y, '#fff', sc);
}

/* ------------------------------------------------------------------ api -- */
export const MIN_VIEW = { desk: [86, 62], break: [86, 62], conf: [174, 62], standby: [86, 62] };
const SCENES = { desk: sceneDesk, conf: sceneConf, break: sceneBreak };

// (Re)paints `layer.canvas` when `key` changes. Returns true if it painted.
function paintLayer(layer, key, w, h, paint) {
  if (layer.key === key && layer.canvas) return false;
  if (!layer.canvas) { layer.canvas = makeCanvas(w, h); layer.g = layer.canvas.getContext('2d'); }
  if (layer.canvas.width !== w || layer.canvas.height !== h) { layer.canvas.width = w; layer.canvas.height = h; }
  layer.g.imageSmoothingEnabled = false;
  layer.g.globalAlpha = 1;
  paint(layer.g);
  layer.key = key;
  return true;
}

// The cached background depends on the room (session), its size, and for a conference room the seating plan.
function bgKey(w, h, v) {
  const s = v.session;
  let k = `${v.kind}|${w}|${h}|${s.id}|${s.tool}|${isDay() ? 1 : 0}`;
  if (v.kind === 'conf') { const P = confPlan(w, (s.subagents || []).length); k += `|${v.safeBottom | 0}|${P.two ? 'two' : P.seats.length}`; }
  return k;
}

// v: { session, kind, tick, walk?: {dir:'in'|'out', p}, fx?: 'off'|'on'|'static'|'nosignal', fxp?, hiSub?, hits?, reduce?, safeBottom? }
// layer: a plain object owned by the caller ({}), one per feed; it holds that feed's cached background.
export function renderFeed(g, w, h, v, layer) {
  g.imageSmoothingEnabled = false;
  if (v.fx === 'off') { R(g, '#000', 0, 0, w, h); return; }
  if (v.fx === 'nosignal') { fxNoSignal(g, w, h, v.tick, v.reduce); return; }
  v.spec = charSpec(v.session.id, v.session.tool);
  const scene = SCENES[v.kind] || sceneDesk;
  if (layer) {
    paintLayer(layer, bgKey(w, h, v), w, h, (lg) => { v.pass = 'bg'; scene(lg, w, h, v); });
    g.drawImage(layer.canvas, 0, 0);
    v.pass = 'fg';
    scene(g, w, h, v);
  } else {
    v.pass = 'all';
    scene(g, w, h, v);
  }
  if (v.fx === 'on') fxPowerOn(g, w, h, v.fxp);
  else if (v.fx === 'static') { if (v.reduce) { g.fillStyle = `rgba(0,0,0,${0.7 * (v.fxp ?? 1)})`; g.fillRect(0, 0, w, h); } else fxStatic(g, w, h, v.tick, v.fxp ?? 1); }
}

export function drawPortrait(canvas, session, sub, tick = 0) {
  const g = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  g.imageSmoothingEnabled = false;
  const t = toolOf(session.tool);
  R(g, t.dark, 0, 0, w, h);
  for (let y = 0; y < h; y += 4) R(g, t.base, 0, y, w, 1);
  g.globalAlpha = 0.25; R(g, '#000', 0, h - 6, w, 6); g.globalAlpha = 1;
  let sp, ex;
  if (sub) {
    sp = charSpec(session.id + '#' + sub.id, session.tool);
    ex = sub.status === 'done' ? 'happy' : sub.status === 'failed' ? 'dead' : (tick % 40 < 2 ? 'blink' : 'work');
  } else {
    sp = charSpec(session.id, session.tool);
    ex = session.status === 'waiting' ? 'alert' : session.status === 'idle' ? 'sleep' : (tick % 40 < 2 ? 'blink' : (tick >> 3) % 5 === 0 ? 'talk' : 'work');
  }
  const spr = charSprite(sp, 'sub', 0, ex);
  put(g, spr, (w - BW) >> 1, h - 26);
  if (!sub && crowned(session)) put(g, crownSprite(), ((w - BW) >> 1) + HX + 2, h - 26 + HY - 6);
}
const crowned = (session) => session.mode === 'orchestrator' && session.status !== 'idle';

export function drawIconCanvas(canvas, kind, col = '#fff') {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (kind === 'thinking') { for (let i = 0; i < 3; i++) R(g, col, i * 3, 3, 2, 2); return; }
  drawIcon(g, kind, 0, 0, col);
}
