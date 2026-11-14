// Stand-in face portraits, used only until (or unless) the world module supplies drawPortrait().
// Deterministic per character; an original 16x16 doodle scaled up with hard pixels.

function hash(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

const SKIN = ['#f8c8a0', '#e8a878', '#c08050', '#8c5830', '#fcd8b8', '#a86838'];
const HAIR = ['#201810', '#583018', '#a86020', '#e8c040', '#c03020', '#d8d8d8', '#3848a8', '#208858', '#e860a8'];

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

export function drawFallbackPortrait(canvas, session, sub) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !session) return;
  const G = 16;
  const u = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / G));
  const ox = Math.floor((canvas.width - u * G) / 2);
  const oy = Math.floor((canvas.height - u * G) / 2);
  const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(ox + x * u, oy + y * u, w * u, h * u); };

  const seed = hash(`${session.id}|${session.name || ''}|${sub ? sub.id + (sub.name || '') : ''}`);
  const tool = cssVar(`--${session.tool}`, '#fcfcfc');
  const deep = cssVar(`--${session.tool}-deep`, '#303030');
  const skin = SKIN[seed % SKIN.length];
  const hair = HAIR[(seed >>> 4) % HAIR.length];
  const style = (seed >>> 9) % 4;
  const status = sub ? sub.status : session.status;

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = deep;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // backdrop stripes
  for (let y = 0; y < G; y += 4) px(0, y, G, 1, 'rgba(0,0,0,0.25)');

  // shoulders + neck
  px(2, 13, 12, 3, tool);
  px(3, 12, 10, 1, tool);
  px(7, 11, 2, 2, skin);
  px(7, 13, 2, 1, '#fcfcfc');
  // head
  px(4, 4, 8, 7, skin);
  px(5, 11, 6, 1, skin);
  px(3, 6, 1, 3, skin);
  px(12, 6, 1, 3, skin);
  // hair
  if (style === 0) { px(4, 2, 8, 2, hair); px(3, 3, 1, 3, hair); px(12, 3, 1, 3, hair); px(4, 4, 2, 1, hair); }
  else if (style === 1) { px(4, 2, 8, 3, hair); px(3, 3, 1, 6, hair); px(12, 3, 1, 6, hair); px(4, 5, 1, 1, hair); px(11, 5, 1, 1, hair); }
  else if (style === 2) { px(5, 1, 6, 1, hair); px(4, 2, 8, 2, hair); px(9, 4, 3, 1, hair); }
  else { px(4, 3, 8, 1, hair); px(4, 2, 2, 1, hair); px(7, 2, 2, 1, hair); px(10, 2, 2, 1, hair); }
  if (sub) { px(3, 2, 10, 2, tool); px(3, 4, 11, 1, deep); } // helpers wear a cap

  // eyes: closed when idle, wide when waiting
  if (status === 'idle' || status === 'done') { px(5, 7, 2, 1, '#000'); px(9, 7, 2, 1, '#000'); }
  else if (status === 'waiting') { px(5, 6, 2, 2, '#fcfcfc'); px(9, 6, 2, 2, '#fcfcfc'); px(6, 7, 1, 1, '#000'); px(10, 7, 1, 1, '#000'); }
  else { px(6, 6, 1, 2, '#000'); px(10, 6, 1, 2, '#000'); }
  // mouth
  if (status === 'waiting') px(7, 9, 2, 2, '#601010');
  else if (status === 'failed') px(6, 10, 4, 1, '#601010');
  else px(7, 9, 3, 1, '#601010');
  // glasses for some
  if ((seed >>> 13) % 3 === 0 && status !== 'waiting') { px(5, 6, 3, 1, '#000'); px(9, 6, 3, 1, '#000'); px(8, 7, 1, 1, '#000'); }
}
