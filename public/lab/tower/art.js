// Original pixel art for the tower concept: chunky super-deformed characters built from
// templates + procedural limbs, bubbles, icons. Nothing is loaded from disk.

export const INK = '#0c0c18';
export const WHITE = '#f8f8f8';

export const TOOL = {
  claude: { c: '#e06a48', d: '#a03c20', l: '#f8b090', badge: 'CL', label: 'CLAUDE' },
  codex: { c: '#28c898', d: '#0c7858', l: '#a8f4d8', badge: 'CX', label: 'CODEX' },
  cursor: { c: '#6c5cf8', d: '#3424b0', l: '#b8b0f8', badge: 'CU', label: 'CURSOR' },
};
const UNKNOWN_TOOL = { c: '#a0a0b0', d: '#606070', l: '#d8d8e0', badge: '??', label: 'AGENT' };
export const toolOf = (t) => TOOL[t] || UNKNOWN_TOOL;

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return h >>> 0;
}

export function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Paint a char-grid template. map: char -> colour. */
export function stamp(g, rows, x, y, map) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const col = map[row[c]];
      if (col) {
        g.fillStyle = col;
        g.fillRect(x + c, y + r, 1, 1);
      }
    }
  }
}

export function tplCanvas(rows, map) {
  const c = mk(rows[0].length, rows.length);
  stamp(c.getContext('2d'), rows, 0, 0, map);
  return c;
}

// ---------------------------------------------------------------- characters

const SKINS = [['#f8c8a0', '#d89868'], ['#f0b080', '#c88050'], ['#c88450', '#9a5a30'], ['#8a5430', '#603818']];
const HAIRS = [['#20203c', '#101020'], ['#6a3410', '#401c00'], ['#f8d038', '#c89810'], ['#e04818', '#a02800'],
  ['#e8e8f0', '#a8a8c0'], ['#3878f8', '#1838b8'], ['#f868b0', '#b83078'], ['#58c848', '#187818'], ['#a058e8', '#6028a8']];
const PANTS = ['#283878', '#484858', '#6a4020', '#d8d0c0', '#183830'];
const SHOES = ['#181820', '#f8f8f8', '#a02818'];
const ACCENTS = ['#f8d038', '#f83858', '#38d8f8', '#f8f8f8', '#f89838'];

const SW = 20, SH = 24, OX = 2;

const FRONT_HEAD = [
  '................',
  '................',
  '....oooooooo....',
  '...osssssssso...',
  '..osssssssssso..',
  '..osssssssssso..',
  '..osssssssssso..',
  '..ossEWssEWsso..',
  '..ossEEssEEsso..',
  '..oSssssssssSo..',
  '...osssmmssso...',
  '....oooooooo....',
];
const SIDE_HEAD = [
  '................',
  '................',
  '....oooooooo....',
  '...osssssssso...',
  '..osssssssssso..',
  '..osssssssssso..',
  '..osssssssssso..',
  '..ossssssEWsso..',
  '..ossssssEEssso.',
  '..osssssssssso..',
  '...ossssssmmo...',
  '....oooooooo....',
];
const FACES = {
  blink: { 7: '..osssssssssso..', 8: '..ossEEssEEsso..' },
  happy: { 7: '..ossEssssEsso..', 8: '..osEsEssEsEso..' },
  sad: { 7: '..ossEEssEEsso..', 8: '..osssssssssso..', 10: '...osssoossso...' },
  talk: { 10: '...osssoossso...' },
  sleep: { 7: '..osssssssssso..', 8: '..ossEEssEEsso..', 10: '...ossssoosso...' },
};
const SIDE_FACES = { blink: { 7: '..osssssssssso..', 8: '..ossssssEEssso.' } };

const HAIR_F = [
  // 0 short
  ['................', '....oooooooo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhH....Hhho..', '..oh........ho..'],
  // 1 spiky
  ['....o..oo..o....', '...ohoohhooho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohh.hh.hh.ho..'],
  // 2 quiff
  ['.....ooooooo....', '....ohhhhhhhoo..', '...ohhhhhhhhhho.', '..ohhhhhhhhhhho.', '..ohhhhhhhhhhho.', '..ohH......hho..', '..oh........ho..'],
  // 3 long
  ['................', '....oooooooo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '.ohhhhhhhhhhhho.', '.ohhhH....Hhhho.', '.ohh........hho.', '.ohh........hho.', '.ohh........hho.', '.ohh........hho.', '.ohho......ohho.', '.ohho......ohho.', '..oo........oo..'],
  // 4 bob
  ['................', '....oooooooo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohH......Hho..', '..oh........ho..', '..oh........ho..', '..oh........ho..'],
  // 5 mohawk
  ['......oooo......', '......ohho......', '......ohho......', '......hhhh......', '......hHHh......'],
  // 6 cap
  ['................', '....oooooooo....', '...oaaaaaaaao...', '..oaaaaaaaaaao..', '..oaaaaaaaaaao..', '.oooooooooooooo.', '..oh........ho..'],
  // 7 top-knot
  ['......oooo......', '.....ohhhho.....', '...oohhhhhhoo...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhH....Hhho..', '..oh........ho..'],
];
const HAIR_S = [
  ['................', '....oooooooo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhH......', '..ohhhhH........', '..ohhh..........', '..ohh...........', '..oh............'],
  ['....o..oo..o....', '...ohoohhooho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhh.hh....', '..ohhhh.........', '..ohhh..........', '..ohh...........'],
  ['......oooooooo..', '....oohhhhhhhho.', '...ohhhhhhhhhhho', '..ohhhhhhhhhhhho', '..ohhhhhhhhhhoo.', '..ohhhhhH.......', '..ohhhh.........', '..ohhh..........', '..ohh...........'],
  ['................', '....oooooooo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '.ohhhhhhhhhhho..', '.ohhhhhhhH......', '.ohhhhhH........', '.ohhhhh.........', '.ohhhhh.........', '.ohhhhh.........', '.ohhhho.........', '.ohhhho.........', '.ohhho..........', '..ooo...........'],
  ['................', '....oooooooo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhhH....', '..ohhhhhH.......', '..ohhhhh........', '..ohhhhh........', '..ohhhhh........', '...ohhh.........'],
  ['....oooooooo....', '...ohhhhhhhho...', '....hHHHHHHh....'],
  ['................', '....oooooooo....', '...oaaaaaaaao...', '..oaaaaaaaaaao..', '..oaaaaaaaaaaooo', '..oooooooooooooo', '..ohh...........', '..oh............'],
  ['....oooo........', '...ohhhho.......', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhH......', '..ohhhhH........', '..ohhh..........', '..ohh...........'],
];
const ACC_F = {
  1: { 7: '...ooWoooWooo...', 8: '....ooo..ooo....' }, // shades
  2: { 1: '....aaaaaaaa....', 5: '.oo..........oo.', 6: '.oa..........ao.', 7: '.oa..........ao.', 8: '.oa..........ao.', 9: '.oo..........oo.' }, // headphones
  3: { 7: '...oo..oo..oo...', 8: '....o..oo..o....' }, // glasses
};
const ACC_S = {
  1: { 7: '......ooooooo...', 8: '.........ooo....' },
  2: { 1: '......aa........', 2: '......aa........', 3: '......aa........', 4: '.....oaao.......', 5: '....oaaaao......', 6: '....oaaaao......', 7: '....oaaaao......', 8: '.....oooo.......' },
  3: { 7: '.......oo..oo...', 8: '........o..o....' },
};

const LEG_FRONT = ['....oppooppo....', '....oppooppo....', '....oppooppo....', '....oppooppo....', '....offooffo....', '....oooooooo....'];
const LEG_PASS = ['.....oppppo.....', '.....oppppo.....', '.....oppppo.....', '.....oppppo.....', '.....offffo.....', '.....oooooo.....'];
const LEG_STRIDE = ['....opppppppo...', '....oppppppo....', '...oppooooppo...', '..oppo....oppo..', '..offo....offfo.', '..oooo....ooooo.'];
const LEG_SIT = ['....ooooooooo...', '....opppppppo...', '....opppppppo...', '....oooooppo....', '........offfo...', '........ooooo...'];

for (const [n, t] of Object.entries({ FRONT_HEAD, SIDE_HEAD, LEG_FRONT, LEG_PASS, LEG_STRIDE, LEG_SIT })) {
  t.forEach((r, i) => { if (r.length !== 16) console.warn('tower art: bad row', n, i, r.length); });
}
[HAIR_F, HAIR_S].forEach((set, k) => set.forEach((t, s) => t.forEach((r, i) => { if (r.length !== 16) console.warn('tower art: bad hair row', k, s, i, r.length); })));

export function lookFor(id, tool, sub = false) {
  const h = hash(id);
  const t = toolOf(tool);
  return {
    key: id + '|' + tool + '|' + (sub ? 1 : 0),
    skin: SKINS[h % 4],
    hair: HAIRS[(h >>> 3) % 9],
    style: (h >>> 7) % 8,
    pants: PANTS[(h >>> 11) % 5],
    shoes: SHOES[(h >>> 14) % 3],
    acc: [0, 0, 0, 1, 2, 2, 3, 0][(h >>> 17) % 8],
    accent: ACCENTS[(h >>> 20) % 5],
    shirt: sub ? t.l : t.c,
    shirtD: sub ? t.c : t.d,
  };
}

function cmap(L) {
  return { o: INK, s: L.skin[0], S: L.skin[1], W: WHITE, E: INK, m: '#a03020', h: L.hair[0], H: L.hair[1], a: L.accent, c: L.shirt, C: L.shirtD, p: L.pants, f: L.shoes };
}

function rowsWith(base, patch) {
  if (!patch) return base;
  return base.map((r, i) => patch[i] || r);
}

function overlay(g, patch, M) {
  for (const [row, str] of Object.entries(patch)) stamp(g, [str], OX, Number(row), M);
}

function build(L, pose, frame, face) {
  const cv = mk(SW, SH);
  const g = cv.getContext('2d');
  const M = cmap(L);
  const b = (x, y, w, h, k) => { g.fillStyle = M[k] || k; g.fillRect(x + OX, y, w, h); };
  const side = pose === 'walk' || pose === 'type' || pose === 'play';

  if (side) {
    stamp(g, pose === 'type' ? LEG_SIT : pose === 'walk' && frame % 2 === 0 ? LEG_STRIDE : LEG_PASS, OX, 18, M);
    b(5, 12, 7, 7, 'o'); b(6, 12, 5, 6, 'c'); b(6, 13, 1, 5, 'C');
    if (pose === 'walk') {
      const sw = [2, 0, -2, 0][frame % 4];
      b(7 + sw, 13, 3, 6, 'o'); b(8 + sw, 13, 1, 3, 'C'); b(8 + sw, 16, 1, 2, 's');
    } else {
      const dy = frame % 2;
      b(8, 12 + dy, 7, 3, 'o'); b(9, 13 + dy, 3, 1, 'C'); b(12, 13 + dy, 2, 1, 's');
    }
    stamp(g, rowsWith(SIDE_HEAD, SIDE_FACES[face]), OX, 0, M);
    stamp(g, HAIR_S[L.style], OX, 0, M);
    if (ACC_S[L.acc]) overlay(g, ACC_S[L.acc], M);
    return cv;
  }

  // front / back
  stamp(g, LEG_FRONT, OX, 18, M);
  b(4, 12, 8, 7, 'o'); b(5, 12, 6, 6, 'c'); b(10, 13, 1, 5, 'C'); b(5, 17, 6, 1, 'C');
  // left arm (viewer's left)
  if (pose === 'present') {
    const dy = frame % 2;
    b(-1, 12 + dy, 6, 3, 'o'); b(2, 13 + dy, 2, 1, 'c'); b(0, 13 + dy, 2, 1, 's');
  } else {
    b(2, 12, 3, 7, 'o'); b(3, 13, 1, 3, 'c'); b(3, 16, 1, 2, 's');
  }
  // right arm
  if (pose === 'wave') {
    const dx = frame % 2;
    b(11, 12, 3, 3, 'o'); b(12, 13, 1, 1, 'c');
    b(13, 5, 3, 9, 'o'); b(14, 9, 1, 4, 'c'); b(14, 6, 1, 3, 's');
    b(13 + dx, 2, 4, 4, 'o'); b(14 + dx, 3, 2, 2, 's');
  } else if (pose === 'drink') {
    if (frame % 2) {
      b(11, 12, 3, 4, 'o'); b(12, 13, 1, 2, 'c');
      b(9, 9, 4, 4, 'o'); b(10, 10, 2, 2, WHITE); b(12, 11, 2, 3, 'o'); b(12, 12, 1, 1, 's');
    } else {
      b(11, 12, 3, 5, 'o'); b(12, 13, 1, 2, 'c'); b(12, 15, 1, 1, 's');
      b(12, 14, 4, 4, 'o'); b(13, 15, 2, 2, WHITE);
    }
  } else {
    b(11, 12, 3, 7, 'o'); b(12, 13, 1, 3, 'c'); b(12, 16, 1, 2, 's');
  }

  if (pose === 'back') {
    const MB = { ...M, W: M.s, E: M.s, m: M.s, S: M.s };
    stamp(g, FRONT_HEAD, OX, 0, MB);
    if (L.style === 5) b(7, 3, 2, 6, 'h');
    else { b(4, 3, 8, 1, 'h'); b(3, 4, 10, 5, 'h'); b(4, 8, 8, 1, 'H'); }
    stamp(g, HAIR_F[L.style].map((r) => r.replace(/H/g, 'h')), OX, 0, M);
    if (L.acc === 2) overlay(g, ACC_F[2], M);
    return cv;
  }
  stamp(g, rowsWith(FRONT_HEAD, FACES[face]), OX, 0, M);
  stamp(g, HAIR_F[L.style], OX, 0, M);
  if (ACC_F[L.acc] && !(L.acc === 1 && (face === 'happy' || face === 'sad'))) overlay(g, ACC_F[L.acc], M);
  return cv;
}

function mirror(c) {
  const m = mk(c.width, c.height);
  const g = m.getContext('2d');
  g.translate(c.width, 0);
  g.scale(-1, 1);
  g.drawImage(c, 0, 0);
  return m;
}

const sprites = new Map();
/** 20x24 sprite; the character's feet centre is at (10, 24). */
export function sprite(look, pose, frame = 0, flip = false, face = '') {
  const key = look.key + '|' + pose + '|' + frame + '|' + (flip ? 1 : 0) + '|' + face;
  let c = sprites.get(key);
  if (!c) {
    if (sprites.size > 4000) sprites.clear();
    c = build(look, pose, frame, face);
    if (flip) c = mirror(c);
    sprites.set(key, c);
  }
  return c;
}

/** Big face close-up for the dialogue box. */
export function drawPortrait(canvas, look, tool, face = '') {
  const g = canvas.getContext('2d');
  const t = toolOf(tool);
  const w = canvas.width, h = canvas.height;
  g.imageSmoothingEnabled = false;
  g.fillStyle = t.d;
  g.fillRect(0, 0, w, h);
  g.fillStyle = t.c;
  const u = w / 20;
  for (let y = 0; y < 20; y += 2) g.fillRect(0, y * u, w, u);
  g.fillStyle = INK;
  g.fillRect(0, h - u * 2, w, u * 2);
  const s = sprite(look, 'stand', 0, false, face);
  g.drawImage(s, 0, 0, 20, 19, 0, u, w, (w / 20) * 19);
}

// ---------------------------------------------------------------- props

export const CROWN = tplCanvas([
  '.o...o...o.',
  'oyo.oyo.oyo',
  'oyyoyyyoyyo',
  'oyyyyyyyyyo',
  'oyRyyByyRyo',
  'oYYYYYYYYYo',
  'ooooooooooo',
], { o: INK, y: '#f8d038', Y: '#c89810', R: '#f83858', B: '#38c8f8' });

const BANG_ROWS = [
  '..ooooooo..',
  '.oyyyyyyyo.',
  'oyyyrrryyyo',
  'oyyyrrryyyo',
  'oyyyrrryyyo',
  'oyyyrrryyyo',
  'oyyyyryyyyo',
  'oyyyyyyyyyo',
  'oyyyrrryyyo',
  'oyyyrrryyyo',
  '.oyyyyyyyo.',
  '..ooyyooo..',
  '....oo.....',
];
export const BANG = [
  tplCanvas(BANG_ROWS, { o: INK, y: '#f8d830', r: '#e01818' }),
  tplCanvas(BANG_ROWS, { o: INK, y: WHITE, r: '#e01818' }),
];

const ICONS = {
  thinking: ['.......', '.......', '.......', '##.#.##', '##.#.##', '.......', '.......'],
  reading: ['.......', '###.###', '#..#..#', '#..#..#', '#..#..#', '###.###', '.......'],
  editing: ['.....##', '....###', '...###.', '..###..', '.###...', '##.....', '#......'],
  running: ['.......', '#......', '.#.....', '..#....', '.#.....', '#..####', '.......'],
  searching: ['.###...', '#...#..', '#...#..', '#...#..', '.###...', '....##.', '.....##'],
  browsing: ['..###..', '.#.#.#.', '#..#..#', '#######', '#..#..#', '.#.#.#.', '..###..'],
  delegating: ['..###..', '..###..', '...#...', '.#####.', '.#...#.', '###.###', '###.###'],
  writing: ['#####..', '#...##.', '#.#..#.', '#....#.', '#.##.#.', '#....#.', '######.'],
  waiting: ['..###..', '..###..', '..###..', '..###..', '.......', '..###..', '..###..'],
  idle: ['.......', '.#####.', '....#..', '...#...', '..#....', '.#####.', '.......'],
};
const ICON_COL = { thinking: '#6858c8', reading: '#2868c8', editing: '#d86818', running: '#188848', searching: '#a03890', browsing: '#1888a8', delegating: '#c89010', writing: '#484860', waiting: '#e01818', idle: '#787888' };

const bubbles = new Map();
/** 11x12 speech bubble with a 7x7 activity icon. */
export function bubble(kind) {
  const k = ICONS[kind] ? kind : 'thinking';
  let c = bubbles.get(k);
  if (c) return c;
  c = mk(11, 12);
  const g = c.getContext('2d');
  g.fillStyle = INK;
  g.fillRect(1, 0, 9, 11); g.fillRect(0, 1, 11, 9); g.fillRect(2, 10, 3, 1); g.fillRect(2, 11, 2, 1);
  g.fillStyle = WHITE;
  g.fillRect(1, 1, 9, 9); g.fillRect(3, 10, 1, 1);
  stamp(g, ICONS[k], 2, 2, { '#': ICON_COL[k] });
  bubbles.set(k, c);
  return c;
}
/** 7x7 bare icon in a given colour (for the dialogue box / legends). */
export function icon(kind, color) {
  return tplCanvas(ICONS[ICONS[kind] ? kind : 'thinking'], { '#': color });
}
export const iconRows = (kind) => ICONS[ICONS[kind] ? kind : 'thinking'];

const CHIP = {
  done: tplCanvas(['.ooooo.', 'ogggggo', 'oggggwo', 'ogggwgo', 'owgwggo', 'oggwggo', '.ooooo.'], { o: INK, g: '#20b858', w: WHITE }),
  failed: tplCanvas(['.ooooo.', 'orrrrro', 'orwrwro', 'orrwrro', 'orwrwro', 'orrrrro', '.ooooo.'], { o: INK, r: '#e02828', w: WHITE }),
  busy: [0, 1, 2].map((f) => tplCanvas(['.ooooo.', 'onnnnno', 'onnnnno', 'o' + [0, 1, 2].map((i) => (i === f ? 'w' : 'd')).join('n') + 'o', 'onnnnno', 'onnnnno', '.ooooo.'], { o: INK, n: WHITE, w: INK, d: '#b0b0c8' })),
};
export function chip(status, frame = 0) {
  if (status === 'done') return CHIP.done;
  if (status === 'failed') return CHIP.failed;
  return CHIP.busy[frame % 3];
}

export const PUFF = [
  tplCanvas(['.....', '..w..', '.www.', '..w..', '.....'], { w: WHITE }),
  tplCanvas(['.w.w.', 'wwwww', '.www.', 'wwwww', '.w.w.'], { w: WHITE }),
  tplCanvas(['w.w.w', '.....', 'w...w', '.....', 'w.w.w'], { w: WHITE }),
];

export const CLOUD = [
  '......wwww..........',
  '....wwwwwwww..www...',
  '..wwwwwwwwwwwwwwww..',
  '.wwwwwwwwwwwwwwwwww.',
  'wwwwwwwwwwwwwwwwwwww',
  '.sssssssssssssssss..',
];

export function lerpHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + ((((pb >> 16) & 255) - ((pa >> 16) & 255)) * t));
  const g = Math.round(((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t));
  const bl = Math.round((pa & 255) + (((pb & 255) - (pa & 255)) * t));
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}
