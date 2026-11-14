// Small shared helpers for the canvas world. No DOM access at import time.

export function hash(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0);
  c.height = Math.max(1, h | 0);
  return c;
}

export function ctx2d(canvas) {
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  return g;
}

/** fillRect shorthand: R(g, colour, x, y, w, h). */
export function R(g, c, x, y, w = 1, h = 1) {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

/** Filled box with a 1px inner border. */
export function box(g, x, y, w, h, fill, line) {
  g.fillStyle = line;
  g.fillRect(x, y, w, h);
  g.fillStyle = fill;
  g.fillRect(x + 1, y + 1, w - 2, h - 2);
}

/**
 * Draw rows of characters as pixels. `pal` maps a character to a colour; '.' and ' ' are transparent.
 */
export function bmp(g, x, y, rows, pal) {
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j];
    for (let i = 0; i < row.length; i++) {
      const c = pal[row[i]];
      if (c) {
        g.fillStyle = c;
        g.fillRect(x + i, y + j, 1, 1);
      }
    }
  }
}

/**
 * Add a 1px outline (4-neighbour) around everything opaque on the canvas.
 * `diag` also fills the diagonal neighbours (used for the selection glow).
 */
export function outline(canvas, colour, diag = false) {
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = d[i * 4 + 3] > 0 ? 1 : 0;
  const [cr, cg, cb] = hexToRgb(colour);
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (solid[y * w + x]) continue;
      let hit = at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1);
      if (!hit && diag) hit = at(x - 1, y - 1) || at(x + 1, y - 1) || at(x - 1, y + 1) || at(x + 1, y + 1);
      if (hit) {
        const o = (y * w + x) * 4;
        d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
}

/** A canvas holding only a 1px ring around the opaque pixels of `src` (ring canvas is 2px larger). */
export function ringOf(src, colour) {
  const w = src.width + 2;
  const h = src.height + 2;
  const out = makeCanvas(w, h);
  const g = ctx2d(out);
  g.drawImage(src, 1, 1);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = d[i * 4 + 3] > 0 ? 1 : 0;
  const [cr, cg, cb] = hexToRgb(colour);
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (solid[y * w + x]) { d[o + 3] = 0; continue; }
      if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) {
        d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Sprite factory: draw on a fresh canvas, then (optionally) outline it. */
export function sprite(w, h, draw, line) {
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  draw(g);
  if (line) outline(c, line);
  return c;
}

export function flipX(src) {
  const c = makeCanvas(src.width, src.height);
  const g = ctx2d(c);
  g.translate(src.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  return c;
}
