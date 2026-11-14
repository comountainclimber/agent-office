// Floor Plan concept — palette, bitmap font, icons, character sprites and portraits.
// All art is original and generated from the data in this file (no image assets).

export const C = {
  void: '#0b0b12', ink: '#14121f', white: '#f4f4f4', hot: '#ffd23f', red: '#ff4a4a', green: '#62e26a', dim: '#9aa0b4',
  wall: '#eef0f8', wallShade: '#b4bbd4', face: '#7f8ab3', faceLo: '#566089',
  carpet: '#2c3256', carpet2: '#353c66',
  corridor: '#7a84a6', corridor2: '#8a94b5', corridorInk: '#4c5579',
  wood: '#a9703f', wood2: '#93603a', woodHi: '#c08a55',
  tile: '#e6d7b3', tile2: '#d3bf92',
  stone: '#b4bace', stone2: '#a3aac2',
  rug: '#b03a48', rug2: '#8c2a3a',
  desk: '#d9a066', deskHi: '#f0c48f', deskFront: '#8f563b', deskDark: '#663931',
  metal: '#555b78', metalHi: '#8089ad', screenOff: '#1d2138',
  plant: '#3fa34d', plantD: '#2a6e3a', pot: '#b5562f',
  gold: '#ffd23f', goldD: '#c98a1a',
  glass: '#bfeaf5', glass2: '#7cc2da',
  part: '#5d678f', partHi: '#aab3d6', chair: '#3a3f5c', chairHi: '#555b82',
  couch: '#4a7fc0', couchHi: '#6fa3e0', couchD: '#335a8c',
};

export const TOOLS = {
  claude: { id: 'claude', badge: 'CL', label: 'CLAUDE', base: '#e8704a', light: '#ffb690', dark: '#9c3f26' },
  codex: { id: 'codex', badge: 'CX', label: 'CODEX', base: '#35d6a0', light: '#a9f7dc', dark: '#157a5a' },
  cursor: { id: 'cursor', badge: 'CU', label: 'CURSOR', base: '#7a6cff', light: '#bdb6ff', dark: '#3b2fbf' },
};
export const toolOf = (t) => TOOLS[t] || TOOLS.claude;

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = ch(n >> 16), g = ch((n >> 8) & 255), b = ch(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/* ---------------------------------------------------------------- 3x5 font */
// Each glyph: five octal digits, one per row, 3 bits per row (4 = left pixel).
const F = {
  A: '25755', B: '65656', C: '34443', D: '65556', E: '74647', F: '74644', G: '34553', H: '55755', I: '72227',
  J: '11152', K: '55655', L: '44447', M: '57555', N: '65555', O: '75557', P: '65644', Q: '75571', R: '65655',
  S: '34216', T: '72222', U: '55557', V: '55552', W: '55775', X: '55255', Y: '55222', Z: '71247',
  0: '25552', 1: '26227', 2: '61247', 3: '61216', 4: '55711', 5: '74616', 6: '34757', 7: '71222', 8: '75757', 9: '75716',
  ' ': '00000', '.': '00002', ',': '00024', '!': '22202', '?': '61202', ':': '02020', ';': '02024', '-': '00700',
  '+': '02720', '/': '11244', '\\': '44211', "'": '22000', '"': '55000', '(': '24442', ')': '21112', '_': '00007',
  '=': '07070', '*': '05250', '#': '57575', '%': '51245', '<': '12421', '>': '42124', '[': '64446', ']': '31113',
  '·': '00200', '…': '00005', '&': '25256', '@': '75747', '|': '22222', '~': '03600', '$': '37676', '^': '25000',
};
const GLYPH = new Map();
for (const ch of Object.keys(F)) {
  const pts = [];
  for (let r = 0; r < 5; r++) {
    const v = Number(F[ch][r]);
    for (let c = 0; c < 3; c++) if (v & (4 >> c)) pts.push(c, r);
  }
  GLYPH.set(ch, pts);
}
const UNKNOWN = GLYPH.get('?');

export function norm(s) {
  return String(s ?? '').replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').toUpperCase();
}
export function textW(s, scale = 1) {
  const n = [...s].length;
  return n ? (n * 4 - 1) * scale : 0;
}
export function drawText(g, s, x, y, color, scale = 1) {
  g.fillStyle = color;
  let cx = x;
  for (const ch of s) {
    const pts = GLYPH.get(ch) || UNKNOWN;
    for (let i = 0; i < pts.length; i += 2) g.fillRect(cx + pts[i] * scale, y + pts[i + 1] * scale, scale, scale);
    cx += 4 * scale;
  }
}
const textCache = new Map();
/** Cached text sprite (already normalised to the font's charset). */
export function textSprite(s, color, scale = 1) {
  const key = color + '|' + scale + '|' + s;
  let c = textCache.get(key);
  if (c) return c;
  if (textCache.size > 800) textCache.clear();
  c = mk(Math.max(1, textW(s, scale)), 5 * scale);
  drawText(c.getContext('2d'), s, 0, 0, color, scale);
  textCache.set(key, c);
  return c;
}
/** Word-wrap normalised text into at most `lines` lines of `cols` chars, ellipsising the overflow. */
export function wrap(s, cols, lines = 2) {
  const words = s.split(' ').filter(Boolean);
  const out = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    const next = cur ? cur + ' ' + w : w;
    if ([...next].length <= cols) { cur = next; continue; }
    if (out.length === lines - 1) {
      // last line: squeeze what fits and add an ellipsis
      let last = next;
      const arr = [...last];
      last = arr.slice(0, Math.max(0, cols - 1)).join('').trimEnd() + '…';
      out.push(last);
      return out;
    }
    if (cur) out.push(cur);
    while ([...w].length > cols) { out.push([...w].slice(0, cols).join('')); w = [...w].slice(cols).join(''); if (out.length === lines) return out; }
    cur = w;
  }
  if (cur && out.length < lines) out.push(cur);
  return out;
}

/* ------------------------------------------------------------------- icons */
export const ICONS = {
  thinking: ['.....', '.....', '#.#.#', '.....', '.....'],
  reading: ['#...#', '##.##', '#.#.#', '#.#.#', '#####'],
  editing: ['...##', '..###', '.###.', '###..', '##...'],
  running: ['#....', '.#...', '#....', '.....', '..###'],
  searching: ['.##..', '#..#.', '#..#.', '.###.', '....#'],
  browsing: ['.###.', '#.#.#', '#####', '#.#.#', '.###.'],
  delegating: ['..#..', '..#..', '#####', '#.#.#', '#.#.#'],
  writing: ['####.', '.....', '#####', '.....', '###..'],
  waiting: ['..#..', '..#..', '..#..', '.....', '..#..'],
  idle: ['####.', '...#.', '..#..', '.#...', '####.'],
  check: ['.....', '....#', '#..#.', '.##..', '.....'],
  cross: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  star: ['..#..', '#####', '.###.', '.###.', '#...#'],
  plus: ['..#..', '..#..', '#####', '..#..', '..#..'],
  down: ['.....', '#####', '.###.', '..#..', '.....'],
  up: ['.....', '..#..', '.###.', '#####', '.....'],
};
export function drawIcon(g, name, x, y, color) {
  const rows = ICONS[name] || ICONS.thinking;
  g.fillStyle = color;
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) if (rows[r][c] === '#') g.fillRect(x + c, y + r, 1, 1);
}

/* ------------------------------------------------------- character sprites */
const SKINS = ['#ffd9b0', '#f5bd8e', '#dc9a68', '#a86a40', '#70452a'];
const HAIRS = ['#221f33', '#5b3a1e', '#b5542a', '#f1cf4d', '#e6e6f2', '#e05594'];
const PANTS = ['#27305e', '#3b3b48', '#5b4630', '#1f4a52'];
const CAPS = ['#f4f4f4', '#ffd23f', '#d94a4a'];
const STYLES = ['flat', 'pomp', 'spiky', 'long', 'bald', 'cap', 'bun', 'afro', 'mohawk'];

const TOP = {
  flat: ['............', '...KKKKKK...', '..KHHHHHHK..', '.KHHHHHHHHK.', '.KHHSSSSHHK.', '.KHSSSSSSHK.'],
  pomp: ['....KKKKKK..', '..KKHHHHHHK.', '.KHHHHHHHHK.', '.KHHHHHHHHK.', '.KHSSSSHHHK.', '.KSSSSSSSHK.'],
  spiky: ['..KK.KK.KK..', '.KHHKHHKHHK.', '.KHHHHHHHHK.', '.KHHHHHHHHK.', '.KHSHSSHSHK.', '.KSSSSSSSSK.'],
  long: ['............', '...KKKKKK...', '..KHHHHHHK..', '.KHHHHHHHHK.', '.KHHSSSSHHK.', '.KHSSSSSSHK.'],
  bald: ['............', '...KKKKKK...', '..KSSSSSSK..', '.KSSWSSSSSK.', '.KSSSSSSSSK.', '.KSSSSSSSSK.'],
  cap: ['............', '...KKKKKK...', '..KCCCCCCK..', '.KCCWCCCCCK.', 'KDDDDDDDDDDK', '.KHSSSSSSHK.'],
  bun: ['....KHHK....', '...KKHHKK...', '..KHHHHHHK..', '.KHHHHHHHHK.', '.KHSSSSSSHK.', '.KSSSSSSSSK.'],
  afro: ['..KKKKKKKK..', '.KHHHHHHHHK.', 'KHHHHHHHHHHK', 'KHHHHHHHHHHK', 'KHHHSSSSHHHK', 'KHHSSSSSSHHK'],
  mohawk: ['.....KK.....', '...KKHHKK...', '..KSSHHSSK..', '.KSSSHHSSSK.', '.KSSSSSSSSK.', '.KSSSSSSSSK.'],
};
const LOW = ['.KSSESSESSK.', '.KSSESSESSK.', '.KSSSSSSSSK.', '..KSSSSSSK..'];
const LOW_LONG = ['.KHSESSESHK.', '.KHSESSESHK.', '.KHSSSSSSHK.', '.KHKSSSSKHK.'];
const LOW_BALD = ['.KSSESSESSK.', '.KSSESSESSK.', '.KSHHHHHHSK.', '..KHHHHHHK..'];
const BODY = ['..KKTTTTKK..', '.KTTTTTTTTK.', '.KTKTTTTKTK.', '.KSKDDDDKSK.'];
const LEGS = [
  ['..KKPPPPKK..', '..KPPKKPPK..', '..KBBKKBBK..'],
  ['..KKPPPPKK..', '..KPPKKPPK..', '..KBBK.KK...'],
  ['..KKPPPPKK..', '..KPPKKPPK..', '...KK.KBBK..'],
];
const SIDE_FACE = ['.KHHHHSSSSK.', '.KHHHSSSSSK.', '.KHHSSSSESK.', '.KHHSSSSESK.', '.KHSSSSSSSK.', '..KSSSSSSK..'];
// side view: the near arm swings with the stride (frame 0 hangs, 1 forward, 2 back)
const SIDE_BODY = [
  ['...KTTTTK...', '..KTTTTTTK..', '..KTTdTTTK..', '..KddSdddK..'],
  ['...KTTTTK...', '..KTTTTTTK..', '..KTTTddTK..', '..KddddSSK..'],
  ['...KTTTTK...', '..KTTTTTTK..', '..KTddTTTK..', '..KSSddddK..'],
];
const SIDE_LEGS = [
  ['...KPPPPK...', '...KPPPPK...', '...KBBBBK...'],
  ['...KPPPPK...', '..KppKKPPK..', '.KBBK..KBBK.'],
  ['...KPPPPK...', '..KPPKKppK..', '.KBBK..KBBK.'],
];
// back view: collar, a tool-coloured patch between the shoulders, elbows out
const BACK_BODY = ['..KKddddKK..', '.KTTTLLTTTK.', '.KTKTLLTKTK.', '.KSKddddKSK.'];
const SUB = ['..KKKKKK..', '.KCCWCCCK.', 'KCCCCCCCCK', 'KDDDDDDDDK', 'KSSESSESSK', 'KSSSSSSSSK', '.KKSSSSKK.', '.KTTTTTTK.', 'KSTTTTTTSK', '.KKPPPPKK.'];
const SUB_LEGS = [
  ['..KPKKPK..', '..KK..KK..'],
  ['..KPKKPK..', '..KK......'],
  ['..KPKKPK..', '......KK..'],
];

export const SPR_W = 12, SPR_H = 17, SUB_W = 10, SUB_H = 12;

export function makeLook(id, tool, kind = 'agent') {
  const h = hash(String(id));
  const t = toolOf(tool);
  const sub = kind === 'sub';
  const accN = (h >>> 13) % 6;
  const cap = sub ? t.base : CAPS[(h >>> 20) % CAPS.length];
  return {
    key: kind + '|' + t.id + '|' + h,
    kind, tool: t.id,
    skin: SKINS[h % SKINS.length],
    hair: HAIRS[(h >>> 8) % HAIRS.length],
    style: sub ? 'helmet' : STYLES[(h >>> 4) % STYLES.length],
    acc: sub ? null : accN === 0 ? 'shades' : accN === 1 ? 'band' : null,
    pants: sub ? t.dark : PANTS[(h >>> 17) % PANTS.length],
    shirt: sub ? '#e9e9f2' : t.base,
    shirtD: sub ? '#b4bbd4' : t.dark,
    shirtL: sub ? '#ffffff' : t.light,
    cap, capD: sub ? t.dark : shade(cap, 0.7),
  };
}

function palOf(look) {
  return {
    K: C.ink, H: look.hair, S: look.skin, E: '#14121f', W: '#ffffff', T: look.shirt, D: look.style === 'cap' || look.style === 'helmet' ? look.capD : look.shirtD,
    d: look.shirtD, L: look.shirtL, P: look.pants, p: shade(look.pants, 0.7), B: '#e9e9f2', C: look.cap, R: '#e04848',
  };
}

function rowsFor(look, dir, frame) {
  const st = look.style;
  const hairy = st !== 'bald' && st !== 'mohawk';
  const top = TOP[st] || TOP.flat;
  let low = st === 'long' ? LOW_LONG : st === 'bald' ? LOW_BALD : LOW;
  // body rows use lowercase d for the shirt shadow so cap/helmet "D" stays the cap colour
  let body = BODY.map((r) => r.replace(/D/g, 'd'));
  if (st === 'long') body = ['.KHKTTTTKHK.', ...body.slice(1)];
  let rows;
  if (dir === 'right') {
    let face = SIDE_FACE.slice();
    if (!hairy) face = face.map((r) => r.replace(/H/g, 'S'));
    if (st === 'cap') face[0] = '.KDDDDDDDDDK';
    if (st === 'long') { face[4] = '.KHHSSSSSSK.'; face[5] = '.KHHKSSSSK..'; }
    if (look.acc === 'shades') { face[2] = face[2].slice(0, 6) + 'KKKK' + face[2].slice(10); face[3] = face[3].replace(/E/g, 'S'); }
    const f = frame % 3;
    rows = [...top.slice(0, 4), ...face, ...SIDE_BODY[f], ...SIDE_LEGS[f]];
  } else {
    let head = [...top, ...low];
    if (dir === 'up') {
      head = head.map((r, i) => {
        if (i < 4) return r;
        if (hairy) return st === 'cap' && i === 4 ? '.KDDDDDDDDK.' : r.replace(/[SEW]/g, 'H');
        return r.replace(/E/g, 'S').replace(/H/g, i >= 6 ? 'S' : 'H');
      });
      // the arms of a pair of shades still show from behind
      if (look.acc === 'shades') head[6] = head[6].slice(0, 2) + 'K' + head[6].slice(3, 9) + 'K' + head[6].slice(10);
      body = BACK_BODY.slice();
      if (st === 'long') { body[0] = '.KHHHHHHHHK.'; body[1] = '.KTHHHHHHTK.'; }
    } else if (look.acc === 'shades') {
      head[6] = head[6].slice(0, 3) + 'KKKKKK' + head[6].slice(9);
      head[7] = head[7].replace(/E/g, 'S');
    }
    rows = [...head, ...body, ...LEGS[frame % 3]];
  }
  if (look.acc === 'band' && ['flat', 'spiky', 'long', 'bald', 'mohawk'].includes(st)) {
    rows[4] = rows[4].slice(0, 2) + rows[4].slice(2, 10).replace(/[HSE]/g, 'R') + rows[4].slice(10);
  }
  return rows;
}

function paint(rows, pal) {
  const c = mk(rows[0].length, rows.length);
  const g = c.getContext('2d');
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y];
    for (let x = 0; x < r.length; x++) {
      const col = pal[r[x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

const sprCache = new Map();
/** dir: 'down' | 'up' | 'left' | 'right'; frame: 0 stand, 1 / 2 steps. */
export function charSprite(look, dir = 'down', frame = 0) {
  if (look.kind === 'sub') dir = 'down';
  const key = look.key + '|' + dir + '|' + frame;
  let c = sprCache.get(key);
  if (c) return c;
  if (sprCache.size > 2000) sprCache.clear();
  if (look.kind === 'sub') c = paint([...SUB, ...SUB_LEGS[frame % 3]], palOf(look));
  else if (dir === 'left') {
    const r = charSprite(look, 'right', frame);
    c = mk(r.width, r.height);
    const g = c.getContext('2d');
    g.translate(r.width, 0);
    g.scale(-1, 1);
    g.drawImage(r, 0, 0);
  } else c = paint(rowsFor(look, dir, frame), palOf(look));
  sprCache.set(key, c);
  return c;
}

/* ---------------------------------------------------------------- portrait */
/** 24x24 pixel close-up of the same character. Scale it up with CSS (image-rendering: pixelated). */
export function drawPortrait(cv, look, o = {}) {
  const N = 24;
  if (cv.width !== N || cv.height !== N) { cv.width = N; cv.height = N; }
  const g = cv.getContext('2d');
  const t = toolOf(look.tool);
  const px = Array.from({ length: N }, () => Array(N).fill(null));
  const set = (x, y, w, h, col) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && i < N && j >= 0 && j < N) px[j][i] = col;
  };
  const S = look.skin, SD = shade(look.skin, 0.82), H = look.hair, HD = shade(look.hair, 0.75), INK = C.ink;
  const st = look.style;
  // shoulders + neck
  set(3, 20, 18, 4, look.shirt);
  set(5, 19, 14, 1, look.shirt);
  set(3, 23, 18, 1, look.shirtD);
  set(3, 20, 1, 1, null); set(20, 20, 1, 1, null);
  set(10, 17, 4, 3, SD);
  set(11, 20, 2, 1, S);
  // head
  set(6, 5, 12, 12, S);
  set(7, 16, 10, 1, SD);
  set(5, 10, 1, 2, S); set(18, 10, 1, 2, S);
  // hair
  const burns = () => { set(6, 8, 1, 2, H); set(17, 8, 1, 2, H); };
  if (st === 'flat') { set(6, 4, 12, 4, H); set(7, 3, 10, 1, H); set(6, 7, 12, 1, HD); burns(); }
  else if (st === 'pomp') { set(6, 4, 12, 4, H); set(8, 1, 11, 3, H); set(17, 2, 3, 4, H); set(9, 3, 8, 1, HD); set(6, 7, 12, 1, HD); burns(); }
  else if (st === 'spiky') { set(6, 5, 12, 3, H); set(6, 3, 2, 2, H); set(9, 2, 2, 3, H); set(12, 1, 2, 4, H); set(15, 2, 2, 3, H); set(17, 4, 1, 1, H); set(6, 7, 12, 1, HD); burns(); }
  else if (st === 'long') { set(6, 3, 12, 4, H); set(7, 2, 10, 1, H); set(5, 5, 2, 15, H); set(17, 5, 2, 15, H); set(7, 7, 10, 1, HD); }
  else if (st === 'bald') { set(8, 6, 3, 1, '#ffffff'); set(6, 13, 12, 4, H); set(6, 12, 2, 1, H); set(16, 12, 2, 1, H); }
  else if (st === 'cap') { set(6, 3, 12, 5, look.cap); set(7, 2, 10, 1, look.cap); set(4, 8, 16, 1, look.capD); set(11, 4, 2, 2, look.capD); set(6, 9, 1, 2, H); set(17, 9, 1, 2, H); }
  else if (st === 'bun') { set(6, 4, 12, 4, H); set(7, 3, 10, 1, H); set(10, 0, 4, 3, H); set(6, 7, 12, 1, HD); burns(); }
  else if (st === 'afro') { set(4, 2, 16, 7, H); set(5, 1, 14, 1, H); set(4, 9, 2, 3, H); set(18, 9, 2, 3, H); set(4, 2, 1, 1, null); set(19, 2, 1, 1, null); set(7, 8, 10, 1, HD); }
  else if (st === 'mohawk') { set(10, 1, 4, 7, H); set(11, 1, 1, 7, HD); }
  else if (st === 'helmet') { set(5, 3, 14, 5, look.cap); set(7, 2, 10, 1, look.cap); set(4, 8, 16, 1, look.capD); set(8, 4, 2, 2, '#ffffff'); }
  // round the head corners (after hair so beards/long hair get rounded too)
  set(6, 16, 1, 1, null); set(17, 16, 1, 1, null);
  if (st === 'bald' || st === 'mohawk') { set(6, 5, 1, 1, null); set(17, 5, 1, 1, null); }
  if (look.acc === 'band' && ['flat', 'spiky', 'long', 'bald', 'mohawk'].includes(st)) set(6, 7, 12, 1, '#e04848');
  // face
  const closed = o.blink || o.status === 'idle';
  if (look.acc === 'shades') { set(7, 10, 10, 2, INK); set(8, 10, 1, 1, '#ffffff'); set(14, 10, 1, 1, '#ffffff'); }
  else if (closed) { set(8, 11, 2, 1, INK); set(14, 11, 2, 1, INK); }
  else { set(8, 10, 2, 2, '#ffffff'); set(14, 10, 2, 2, '#ffffff'); set(9, 10, 1, 2, INK); set(15, 10, 1, 2, INK); }
  if (st !== 'cap' && st !== 'helmet' && st !== 'afro') { set(8, 9 - (o.status === 'waiting' ? 1 : 0), 2, 1, HD === '#000000' ? INK : shade(look.hair, 0.6)); set(14, 9 - (o.status === 'waiting' ? 1 : 0), 2, 1, shade(look.hair, 0.6)); }
  set(11, 12, 2, 1, SD);
  if (o.status === 'waiting') { set(10, 13, 4, 3, INK); set(11, 14, 2, 1, '#e0484a'); }
  else if (o.status === 'idle') set(11, 14, 2, 1, INK);
  else set(10, 14, 4, 1, INK);
  if (o.boss) { set(7, 2, 10, 2, C.gold); set(7, 1, 2, 1, C.gold); set(11, 0, 2, 2, C.gold); set(15, 1, 2, 1, C.gold); set(7, 3, 10, 1, C.goldD); set(11, 2, 2, 1, C.red); }
  // background
  g.fillStyle = t.dark;
  g.fillRect(0, 0, N, N);
  g.fillStyle = shade(t.base, 0.8);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x - y + 48) % 6 < 2) g.fillRect(x, y, 1, 1);
  // auto outline + paint
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let col = px[y][x];
    if (!col) {
      const near = (y > 0 && px[y - 1][x]) || (y < N - 1 && px[y + 1][x]) || (x > 0 && px[y][x - 1]) || (x < N - 1 && px[y][x + 1]);
      if (!near) continue;
      col = INK;
    }
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
  }
}

/** Head-and-shoulders crop of the map sprite, for lists. */
export function drawMini(cv, look, boss = false) {
  const spr = charSprite(look, 'down', 0);
  const w = look.kind === 'sub' ? SUB_W : SPR_W, h = look.kind === 'sub' ? 10 : 12;
  cv.width = 12; cv.height = 16;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 12, 16);
  g.drawImage(spr, 0, 0, w, h, (12 - w) >> 1, 16 - h, w, h);
  if (boss) drawCrown(g, 0, 4);
}

/** Boss crown, 10 x 6, drawn so that (x, y) is the top-left of the 12-px-wide head it sits on. */
const CROWN = ['.K..KK..K.', 'KGK.GG.KGK', 'KGGKGGKGGK', 'KGGGGGGGGK', 'KGRGGGGRGK', 'KKKKKKKKKK'];
export function drawCrown(g, x, y) {
  for (let r = 0; r < CROWN.length; r++) for (let c = 0; c < 10; c++) {
    const ch = CROWN[r][c];
    if (ch === '.') continue;
    g.fillStyle = ch === 'K' ? C.ink : ch === 'G' ? (r < 2 ? '#fff0a8' : C.gold) : C.red;
    g.fillRect(x + 1 + c, y - 4 + r, 1, 1);
  }
}
