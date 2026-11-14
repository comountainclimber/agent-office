// Furniture, wall art, bubbles and icons. All procedural; built once on first use.
import { K, WHITE, C, TOOLS } from './palette.js';
import { R, box, bmp, sprite, makeCanvas, ctx2d, outline } from './util.js';
import { drawText, textWidth, SMALL, BIG } from './font.js';

let P = null;

/** 7x7 activity icons. '#' ink, 'o' accent. */
const ICONS = {
  reading: ['.......', '###.###', '#oo#oo#', '#oo#oo#', '#oo#oo#', '###.###', '...#...'],
  editing: ['.....##', '....#o#', '...#o#.', '..#o#..', '.#o#...', '##.....', '#......'],
  running: ['.......', '#......', '.#.....', '..#....', '.#.....', '#..oooo', '.......'],
  searching: ['.###...', '#ooo#..', '#ooo#..', '#ooo#..', '.###...', '....##.', '.....##'],
  browsing: ['..###..', '.#o#o#.', '#######', '#o.#.o#', '#######', '.#o#o#.', '..###..'],
  delegating: ['....#..', '..###.o', '####..o', '####.o.', '####..o', '..###.o', '....#..'],
  writing: ['.......', '######.', '.......', '####...', '.......', '######.', '..oo...'],
  thinking: ['.......', '.......', '.......', '#..#..#', '#..#..#', '.......', '.......'],
  waiting: ['..ooo..', '..ooo..', '..ooo..', '..ooo..', '.......', '..ooo..', '..ooo..'],
  idle: ['.......', '.####..', '...#...', '..#....', '.####..', '.......', '.......'],
  done: ['.......', '......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  failed: ['#.....#', '##...##', '.##.##.', '..###..', '.##.##.', '##...##', '#.....#'],
};
const ICON_ACCENT = {
  reading: '#fcfcfc', editing: '#c87830', running: '#38b428', searching: '#b8ecfc', browsing: '#58a8f8',
  delegating: '#fc6c18', writing: '#7468fc', thinking: K, waiting: '#e02c20', idle: K,
};

function icon(kind, ink = K, accent) {
  const rows = ICONS[kind] || ICONS.thinking;
  return sprite(7, 7, (g) => bmp(g, 0, 0, rows, { '#': ink, o: accent || ICON_ACCENT[kind] || ink }));
}

function bubble(kind, tailRight) {
  // 13x12: rounded white box with a little tail at the bottom
  const c = makeCanvas(13, 13);
  const g = ctx2d(c);
  R(g, WHITE, 2, 1, 9, 9);
  R(g, WHITE, 1, 2, 11, 7);
  const tx = tailRight ? 8 : 3;
  R(g, WHITE, tx, 10, 2, 1);
  R(g, WHITE, tailRight ? tx + 1 : tx, 11, 1, 1);
  outline(c, K);
  if (kind) g.drawImage(icon(kind), 3, 2);
  return c;
}

function build() {
  const p = {};

  // ------------------------------------------------------------ workstation
  p.chair = sprite(24, 32, (g) => {
    R(g, C.chair, 5, 16, 3, 11);
    R(g, C.chairLight, 5, 16, 1, 11);
    R(g, C.chair, 6, 27, 10, 1);
    R(g, C.steelDark, 10, 28, 2, 1);
    R(g, C.steelDark, 7, 29, 8, 1);
  }, K);

  // The front of the desk is tall enough for a two-line name plate (scene.js paints the plate itself).
  p.desk = sprite(40, 33, (g) => {
    // chunky CRT
    R(g, C.beige, 12, 1, 20, 15);
    R(g, C.beigeShade, 12, 15, 20, 1);
    R(g, C.beigeShade, 31, 1, 1, 15);
    R(g, K, 13, 2, 18, 12);
    R(g, C.screenOff, 14, 3, 16, 10);
    R(g, C.beigeShade, 18, 16, 8, 2);
    // desk: a thin top, then the front
    R(g, C.woodLight, 1, 18, 38, 2);
    R(g, C.wood, 1, 20, 38, 12);
    R(g, C.woodDark, 1, 31, 38, 1);
    R(g, C.woodDark, 38, 20, 1, 12);
    // keyboard
    R(g, C.steelLight, 2, 18, 8, 2);
    R(g, C.steelDark, 3, 19, 6, 1);
  }, K);

  // a note stuck on a dark monitor: "back soon"
  p.sticky = sprite(10, 8, (g) => {
    R(g, '#f4ecd8', 1, 1, 8, 6);
    R(g, '#d4c8a8', 1, 6, 8, 1);
    R(g, '#d4c8a8', 7, 5, 2, 2);
    R(g, '#8c8468', 2, 2, 5, 1);
    R(g, '#8c8468', 2, 4, 3, 1);
  }, K);
  p.mug = sprite(6, 6, (g) => { R(g, WHITE, 1, 1, 3, 4); R(g, '#b8b8c8', 3, 1, 1, 4); R(g, WHITE, 4, 2, 1, 2); R(g, '#6c3c18', 1, 1, 2, 1); }, K);
  // a white duck: bright yellow is kept for "needs you"
  p.duck = sprite(7, 6, (g) => { R(g, WHITE, 1, 2, 4, 3); R(g, WHITE, 3, 1, 2, 2); R(g, '#d0d0dc', 1, 4, 4, 1); R(g, '#fc6c18', 5, 2, 1, 1); R(g, K, 4, 1, 1, 1); }, K);
  p.sprout = sprite(7, 8, (g) => { R(g, C.pot, 2, 5, 3, 2); R(g, C.leaf, 1, 2, 2, 3); R(g, C.leafLight, 3, 1, 2, 4); R(g, C.leaf, 5, 3, 1, 2); }, K);
  p.papers = sprite(8, 5, (g) => { R(g, WHITE, 1, 1, 6, 3); R(g, '#b8b8c8', 2, 2, 4, 1); R(g, '#d8d8e0', 1, 3, 6, 1); }, K);

  // ------------------------------------------------------------ conference
  // tables are cut to the width the seats need (see layout.tableRect)
  const tableCache = new Map();
  p.table = (w) => {
    let c = tableCache.get(w);
    if (c) return c;
    c = sprite(w + 2, 23, (g) => {
      R(g, C.tableTop, 1, 1, w, 14);
      R(g, C.tableLight, 2, 1, w - 2, 1);
      R(g, C.tableLight, 1, 2, 1, 12);
      R(g, C.tableLight, 5, 6, w - 10, 1);
      R(g, C.tableFront, 1, 15, w, 6);
      R(g, K, 1, 15, w, 1);
      g.clearRect(1, 1, 1, 1);
      g.clearRect(w, 1, 1, 1);
      g.clearRect(1, 20, 1, 1);
      g.clearRect(w, 20, 1, 1);
    }, K);
    tableCache.set(w, c);
    return c;
  };
  p.laptopBack = sprite(12, 8, (g) => {
    R(g, C.steel, 1, 1, 10, 5);
    R(g, C.steelLight, 1, 1, 10, 1);
    R(g, C.steelDark, 1, 6, 10, 1);
  }, K);
  p.laptopFront = sprite(12, 9, (g) => {
    R(g, '#3c4658', 1, 1, 10, 6);
    R(g, C.screenOff, 2, 2, 8, 4);
    R(g, C.steel, 1, 7, 10, 1);
  }, K);
  // the boss's podium: carpeted wood (no red, no gold: those colours mean something here)
  p.riser = sprite(24, 9, (g) => {
    R(g, '#5c64a0', 1, 1, 22, 3);
    R(g, '#7880b8', 1, 1, 22, 1);
    R(g, C.tableFront, 1, 4, 22, 4);
    R(g, C.tableLight, 1, 4, 22, 1);
    R(g, C.woodDeep, 3, 6, 1, 1);
    R(g, C.woodDeep, 20, 6, 1, 1);
  }, K);
  p.whiteboard = sprite(35, 24, (g) => {
    box(g, 1, 1, 33, 20, WHITE, C.steel);
    R(g, C.steelDark, 3, 21, 29, 2);
    R(g, '#e02c20', 6, 21, 3, 1);
    R(g, '#3868c8', 11, 21, 3, 1);
  }, K);

  // ------------------------------------------------------------ break area
  // three-seater: cushions 20px wide so three people sit without touching
  p.couch = sprite(72, 26, (g) => {
    R(g, C.couch, 1, 1, 70, 13);
    R(g, C.couchLight, 2, 1, 68, 2);
    R(g, C.couchDark, 1, 12, 70, 1);
    R(g, C.couchLight, 6, 13, 60, 5);
    R(g, C.couchDark, 25, 13, 1, 5);
    R(g, C.couchDark, 46, 13, 1, 5);
    R(g, C.couch, 6, 18, 60, 6);
    R(g, C.couchDark, 6, 23, 60, 1);
    R(g, C.couch, 1, 9, 5, 15);
    R(g, C.couchLight, 1, 9, 5, 2);
    R(g, C.couch, 66, 9, 5, 15);
    R(g, C.couchLight, 66, 9, 5, 2);
    R(g, K, 5, 11, 1, 13);
    R(g, K, 66, 11, 1, 13);
  }, K);
  p.coffeeTable = sprite(28, 13, (g) => {
    R(g, C.woodLight, 1, 1, 26, 5);
    R(g, C.woodDark, 1, 6, 26, 2);
    R(g, C.woodDark, 2, 8, 2, 3);
    R(g, C.woodDark, 24, 8, 2, 3);
    R(g, '#58a8f8', 5, 2, 7, 3); // magazine
    R(g, WHITE, 6, 3, 3, 1);
    R(g, WHITE, 18, 1, 3, 3); // mug
    R(g, '#6c3c18', 18, 1, 3, 1);
  }, K);
  p.vending = sprite(22, 40, (g) => {
    R(g, '#44607c', 1, 1, 20, 38);
    R(g, '#6484a0', 1, 1, 20, 2);
    R(g, '#2c4058', 19, 3, 2, 36);
    R(g, K, 2, 4, 13, 22);
    R(g, '#f8f0c4', 3, 5, 11, 20);
    const cans = ['#c05078', WHITE, '#38b428', '#fc6c18', '#58a8f8'];
    for (let r = 0; r < 4; r++) {
      R(g, '#8c8468', 3, 9 + r * 5, 11, 1);
      for (let i = 0; i < 4; i++) R(g, cans[(r * 2 + i) % cans.length], 4 + i * 3, 6 + r * 5, 2, 3);
    }
    R(g, '#1c2c40', 16, 5, 3, 12);
    R(g, C.steelLight, 17, 7, 1, 2);
    R(g, '#38b428', 17, 11, 1, 1);
    R(g, '#e02c20', 17, 13, 1, 1);
    R(g, K, 3, 29, 13, 6);
    R(g, '#1c2c40', 4, 30, 11, 4);
    R(g, '#6484a0', 5, 33, 9, 1);
  }, K);
  p.cooler = sprite(12, 28, (g) => {
    R(g, '#78c8f8', 3, 1, 6, 9);
    R(g, '#c8ecfc', 4, 2, 1, 6);
    R(g, '#4c98d8', 8, 2, 1, 8);
    R(g, '#78c8f8', 4, 10, 4, 1);
    R(g, WHITE, 2, 11, 8, 14);
    R(g, '#c8c8d8', 8, 11, 2, 14);
    R(g, '#e02c20', 3, 14, 2, 1);
    R(g, '#3868c8', 6, 14, 2, 1);
    R(g, '#8c8ca0', 3, 16, 5, 2);
    R(g, C.steelDark, 2, 25, 8, 2);
  }, K);
  p.arcade = sprite(20, 38, (g) => {
    R(g, '#2c2c40', 1, 1, 18, 36);
    R(g, '#44445c', 1, 1, 2, 36);
    R(g, '#fc6c18', 3, 26, 1, 10);
    R(g, '#58a8f8', 16, 26, 1, 10);
    // marquee
    box(g, 2, 2, 16, 6, '#3868c8', K);
    drawText(g, 'ZAP!', 4, 3, WHITE, SMALL);
    // screen
    box(g, 3, 9, 14, 11, '#101820', K);
    // control panel
    R(g, K, 1, 21, 18, 1);
    R(g, '#6c6c84', 1, 22, 18, 3);
    R(g, K, 1, 25, 18, 1);
    R(g, '#e02c20', 5, 20, 2, 2);
    R(g, WHITE, 5, 22, 2, 1);
    R(g, WHITE, 10, 23, 2, 1);
    R(g, '#58a8f8', 13, 23, 2, 1);
    // coin door
    box(g, 7, 28, 6, 7, '#1c1c2c', K);
    R(g, C.steelLight, 9, 30, 2, 1);
  }, K);
  p.counter = sprite(32, 30, (g) => {
    // coffee machine
    R(g, '#585868', 3, 1, 11, 12);
    R(g, '#787890', 3, 1, 11, 2);
    R(g, K, 5, 5, 7, 6);
    R(g, '#c8ecfc', 6, 6, 5, 4);
    R(g, '#6c3c18', 6, 8, 5, 2);
    R(g, '#e02c20', 12, 3, 1, 1);
    // mugs
    R(g, WHITE, 17, 10, 3, 3);
    R(g, '#f0704c', 21, 10, 3, 3);
    R(g, '#30cc9c', 25, 10, 3, 3);
    R(g, K, 16, 9, 13, 1);
    // counter
    R(g, C.steelLight, 1, 13, 30, 3);
    R(g, K, 1, 16, 30, 1);
    R(g, WHITE, 1, 17, 30, 11);
    R(g, '#c8c8d8', 1, 27, 30, 1);
    R(g, '#c8c8d8', 11, 17, 1, 10);
    R(g, '#c8c8d8', 21, 17, 1, 10);
    R(g, C.steelDark, 8, 21, 2, 1);
    R(g, C.steelDark, 18, 21, 2, 1);
    R(g, C.steelDark, 28, 21, 2, 1);
  }, K);

  // ------------------------------------------------------------ ambient
  p.plantA = sprite(18, 26, (g) => {
    R(g, C.pot, 5, 18, 8, 6);
    R(g, C.potShade, 5, 18, 8, 1);
    R(g, C.potShade, 11, 19, 2, 5);
    R(g, C.leafDark, 3, 8, 12, 10);
    R(g, C.leaf, 6, 2, 4, 6);
    R(g, C.leaf, 2, 7, 6, 6);
    R(g, C.leaf, 9, 5, 6, 8);
    R(g, C.leaf, 4, 12, 10, 5);
    R(g, C.leafLight, 7, 3, 2, 3);
    R(g, C.leafLight, 3, 8, 2, 3);
    R(g, C.leafLight, 11, 6, 2, 3);
    R(g, C.leafLight, 7, 11, 3, 2);
  }, K);
  p.plantB = sprite(16, 34, (g) => {
    R(g, '#e4e4ec', 4, 26, 8, 6);
    R(g, '#b4b4c0', 10, 26, 2, 6);
    R(g, C.leafDark, 7, 10, 2, 16);
    R(g, C.leaf, 2, 12, 5, 3);
    R(g, C.leaf, 9, 8, 5, 3);
    R(g, C.leaf, 3, 5, 4, 3);
    R(g, C.leaf, 8, 2, 4, 4);
    R(g, C.leaf, 9, 16, 5, 3);
    R(g, C.leaf, 2, 19, 5, 3);
    R(g, C.leafLight, 3, 12, 2, 1);
    R(g, C.leafLight, 10, 8, 2, 1);
    R(g, C.leafLight, 9, 3, 2, 1);
    R(g, C.leafLight, 10, 16, 2, 1);
  }, K);
  // rec corner: a ping-pong table (dusty teal like the mats: no signal colour) and a whiteboard on a stand
  p.pingpong = sprite(46, 29, (g) => {
    R(g, C.mat, 1, 1, 44, 17);
    R(g, WHITE, 1, 1, 44, 1);
    R(g, WHITE, 1, 17, 44, 1);
    R(g, WHITE, 1, 1, 1, 17);
    R(g, WHITE, 44, 1, 1, 17);
    R(g, C.rugLine, 2, 9, 42, 1);
    R(g, C.matShade, 1, 18, 44, 3);
    R(g, C.steelDark, 5, 21, 2, 7);
    R(g, C.steelDark, 39, 21, 2, 7);
    R(g, C.steelDark, 21, 21, 4, 5);
    // the net, and a paddle left on the table
    R(g, WHITE, 22, 0, 2, 18);
    R(g, C.steelDark, 22, 2, 2, 1);
    R(g, C.steelDark, 22, 6, 2, 1);
    R(g, C.steelDark, 22, 10, 2, 1);
    R(g, C.steelDark, 22, 14, 2, 1);
    R(g, C.couch, 32, 5, 5, 4);
    R(g, C.woodLight, 37, 6, 3, 1);
    R(g, WHITE, 11, 12, 2, 2);
  }, K);
  p.easel = sprite(30, 32, (g) => {
    R(g, C.steelDark, 3, 2, 2, 28);
    R(g, C.steelDark, 25, 2, 2, 28);
    R(g, C.steelDark, 1, 29, 6, 1);
    R(g, C.steelDark, 23, 29, 6, 1);
    R(g, C.steel, 1, 2, 28, 19);
    R(g, WHITE, 2, 3, 26, 17);
    R(g, '#58a8f8', 4, 5, 9, 1);
    R(g, '#b8b8c8', 4, 8, 16, 1);
    R(g, '#b8b8c8', 4, 11, 12, 1);
    R(g, '#b8b8c8', 4, 14, 18, 1);
    R(g, C.ok, 22, 5, 3, 3);
    R(g, C.steelDark, 1, 21, 28, 2);
    R(g, K, 8, 21, 4, 1);
  }, K);
  p.bench = sprite(36, 13, (g) => {
    R(g, C.woodLight, 1, 1, 34, 3);
    R(g, C.wood, 1, 4, 34, 3);
    R(g, C.woodDark, 1, 6, 34, 1);
    R(g, C.steelDark, 4, 7, 2, 5);
    R(g, C.steelDark, 30, 7, 2, 5);
  }, K);
  p.printer = sprite(26, 25, (g) => {
    R(g, WHITE, 7, 1, 12, 5);
    R(g, '#d8d8e0', 7, 4, 12, 1);
    R(g, C.beige, 1, 6, 24, 9);
    R(g, C.beigeShade, 1, 13, 24, 2);
    R(g, K, 5, 10, 16, 2);
    R(g, '#38b428', 21, 8, 1, 1);
    R(g, C.steelDark, 3, 15, 20, 8);
    R(g, C.steel, 3, 15, 20, 1);
    R(g, K, 12, 16, 1, 7);
  }, K);
  p.rack = sprite(22, 44, (g) => {
    R(g, '#343848', 1, 1, 20, 42);
    R(g, '#4c5068', 1, 1, 20, 2);
    R(g, '#242838', 19, 3, 2, 40);
    for (let u = 0; u < 7; u++) {
      R(g, K, 3, 4 + u * 5, 15, 4);
      R(g, '#1c2030', 4, 5 + u * 5, 13, 2);
    }
    R(g, '#242838', 3, 39, 15, 3);
  }, K);

  // a little floor-cleaning robot that patrols the walkway
  p.bot = sprite(11, 6, (g) => {
    R(g, '#e4e4ec', 2, 1, 7, 1);
    R(g, '#b4b4c0', 1, 2, 9, 2);
    R(g, '#585868', 1, 4, 9, 1);
  }, K);

  p.doorClosed = sprite(26, 42, (g) => {
    R(g, C.woodDark, 1, 1, 24, 40);
    R(g, '#5c88a8', 3, 3, 20, 38);
    R(g, '#7ca8c4', 3, 3, 20, 1);
    R(g, '#3c6484', 21, 4, 2, 37);
    R(g, K, 12, 3, 2, 38);
    box(g, 5, 6, 6, 12, C.glass, K);
    box(g, 15, 6, 6, 12, C.glass, K);
    R(g, WHITE, 6, 7, 1, 4);
    R(g, WHITE, 16, 7, 1, 4);
    R(g, C.steelLight, 10, 23, 1, 3);
    R(g, C.steelLight, 15, 23, 1, 3);
  }, K);
  p.doorOpen = sprite(26, 42, (g) => {
    R(g, C.woodDark, 1, 1, 24, 40);
    R(g, '#181424', 3, 3, 20, 38);
    R(g, '#2c2840', 6, 30, 14, 11);
    R(g, '#5c88a8', 3, 3, 3, 38);
    R(g, '#7ca8c4', 3, 3, 1, 38);
    R(g, '#5c88a8', 20, 3, 3, 38);
    R(g, '#3c6484', 22, 3, 1, 38);
    R(g, K, 6, 3, 1, 38);
    R(g, K, 19, 3, 1, 38);
  }, K);

  p.clock = sprite(13, 13, (g) => {
    bmp(g, 1, 1, [
      '...#####...',
      '..#wwwww#..',
      '.#wwwwwww#.',
      '#wwwwwwwww#',
      '#wwwwwwwww#',
      '#wwwwwwwww#',
      '#wwwwwwwww#',
      '#wwwwwwwww#',
      '.#wwwwwww#.',
      '..#wwwww#..',
      '...#####...',
    ], { '#': '#3c4658', w: WHITE });
    R(g, K, 6, 2, 1, 1);
    R(g, K, 6, 10, 1, 1);
    R(g, K, 2, 6, 1, 1);
    R(g, K, 10, 6, 1, 1);
  }, K);

  // ------------------------------------------------------------ bubbles, marks
  p.icons = {};
  p.bubbles = {};
  for (const kind of Object.keys(ICONS)) {
    p.icons[kind] = icon(kind);
    p.bubbles[kind] = [bubble(kind, false), bubble(kind, true)];
  }
  p.bubbleBlank = [bubble(null, false), bubble(null, true)];
  p.iconWhite = { done: icon('done', WHITE, WHITE), failed: icon('failed', WHITE, WHITE) };

  // the "needs you" bubble: bright yellow, dark "!"; the second frame is the same yellow one step dimmer
  p.alert = [0, 1].map((f) => sprite(13, 17, (g) => {
    const fill = f ? C.alertDim : C.alert;
    R(g, fill, 2, 1, 9, 12);
    R(g, fill, 1, 2, 11, 10);
    R(g, fill, 5, 13, 3, 1);
    R(g, fill, 6, 14, 1, 1);
    if (!f) { R(g, '#fcf4a0', 3, 2, 7, 1); R(g, '#fcf4a0', 2, 3, 1, 3); }
    R(g, K, 5, 3, 3, 5);
    R(g, K, 5, 9, 3, 2);
  }, K));
  // still waiting from earlier: a small, steady mark (no flash, no bounce)
  p.quiet = sprite(7, 9, (g) => {
    R(g, C.alert, 1, 1, 5, 7);
    R(g, K, 3, 2, 1, 3);
    R(g, K, 3, 6, 1, 1);
  }, K);
  p.markDone = sprite(11, 11, (g) => {
    R(g, C.ok, 2, 1, 7, 9);
    R(g, C.ok, 1, 2, 9, 7);
    g.drawImage(p.iconWhite.done, 2, 2);
  }, K);
  p.markFail = sprite(11, 11, (g) => {
    R(g, C.bad, 2, 1, 7, 9);
    R(g, C.bad, 1, 2, 9, 7);
    g.drawImage(p.iconWhite.failed, 2, 2);
  }, K);
  p.star = sprite(9, 9, (g) => bmp(g, 1, 1, ['...#...', '...#...', '#######', '.#####.', '..###..', '.##.##.', '.#...#.'], { '#': WHITE }), K);
  p.starInk = sprite(9, 9, (g) => bmp(g, 1, 1, ['...#...', '...#...', '#######', '.#####.', '..###..', '.##.##.', '.#...#.'], { '#': K }));
  // the selection arrow: white with a dark edge, big enough to find from across the office.
  // down = above its target, left / right = beside it, up = under it
  const ARROW = ['#############', '#############', '.###########.', '..#########..', '...#######...', '....#####....', '.....###.....', '......#......'];
  const arrowDown = sprite(15, 10, (g) => bmp(g, 1, 1, ARROW, { '#': C.select }), K);
  const turn = (src, quarter) => {
    const c = makeCanvas(quarter % 2 ? src.height : src.width, quarter % 2 ? src.width : src.height);
    const g = ctx2d(c);
    g.translate(c.width / 2, c.height / 2);
    g.rotate((quarter * Math.PI) / 2);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  };
  p.arrow = arrowDown;
  p.arrows = { down: arrowDown, left: turn(arrowDown, 1), up: turn(arrowDown, 2), right: turn(arrowDown, 3) };
  // the ring on the floor under whoever is selected
  p.floorRing = sprite(26, 11, (g) => {
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 24; x++) {
        const dx = (x - 11.5) / 12;
        const dy = (y - 4) / 4.5;
        const dx2 = (x - 11.5) / 10;
        const dy2 = (y - 4) / 2.6;
        if (dx * dx + dy * dy <= 1 && dx2 * dx2 + dy2 * dy2 > 1) R(g, C.select, x + 1, y + 1, 1, 1);
      }
    }
  }, K);
  // a puff of dust: covers a desk (and whoever sits at it) while it is carried to another spot. Three sizes.
  p.puff = [0, 1, 2].map((f) => sprite(66, 52, (g) => {
    const blobs = [[33, 27, 16], [15, 31, 12], [51, 31, 12], [23, 16, 11], [43, 16, 11], [33, 37, 12]];
    const k = [0.4, 0.72, 1][f];
    const disc = (cx, cy, r, col) => {
      g.fillStyle = col;
      for (let y = Math.ceil(cy - r); y <= cy + r; y++) {
        const hw = Math.floor(Math.sqrt(Math.max(0, r * r - (y - cy) * (y - cy))));
        if (hw > 0) g.fillRect(Math.round(cx) - hw, y, hw * 2, 1);
      }
    };
    for (const [cx, cy, r] of blobs) disc(33 + (cx - 33) * k, 27 + (cy - 27) * k, r * k, '#c4c0d0');
    for (const [cx, cy, r] of blobs) disc(33 + (cx - 33) * k, 25 + (cy - 27) * k, Math.max(1, r * k - 2), WHITE);
  }, K));
  p.zed = sprite(5, 5, (g) => bmp(g, 0, 0, ['####.', '...#.', '..#..', '.#...', '####.'], { '#': WHITE }));
  p.note = sprite(5, 7, (g) => bmp(g, 0, 0, ['..##.', '..#.#', '..#..', '..#..', '###..', '###..', '.#...'], { '#': K }));

  return p;
}

export function props() {
  if (!P) P = build();
  return P;
}

/** A window with a sky that follows the hour. */
export function drawWindow(g, x, y, w, h, sky, seed = 0) {
  box(g, x, y, w, h, WHITE, K);
  R(g, sky.top, x + 2, y + 2, w - 4, h - 4);
  R(g, sky.bottom, x + 2, y + 2 + Math.floor((h - 4) * 0.55), w - 4, Math.ceil((h - 4) * 0.45));
  const ix = x + 2;
  const iy = y + 2;
  if (sky.kind === 'night') {
    const stars = [[3, 2], [9, 5], [15, 1], [21, 6], [26, 3], [6, 9], [18, 10]];
    for (const [sx, sy] of stars) if (sx < w - 5 && sy < h - 6) R(g, WHITE, ix + ((sx + seed * 5) % (w - 5)), iy + sy, 1, 1);
    R(g, '#fcf4c0', ix + w - 11, iy + 2, 4, 4);
    R(g, sky.top, ix + w - 9, iy + 2, 2, 2);
  } else {
    const cx = ix + 3 + ((seed * 7) % Math.max(1, w - 16));
    if (sky.kind === 'day') {
      R(g, WHITE, cx, iy + 3, 8, 2);
      R(g, WHITE, cx + 2, iy + 2, 4, 1);
      R(g, WHITE, cx + 9, iy + 8, 6, 2);
    } else {
      R(g, '#fcb488', ix + w - 11, iy + Math.floor((h - 4) * 0.55) - 3, 5, 3);
      R(g, '#fcc4a0', cx, iy + 3, 8, 1);
    }
  }
  // skyline
  const sk = sky.kind === 'night' ? '#0c0c24' : sky.kind === 'day' ? '#7c98b8' : '#4c3c6c';
  const base = y + h - 2;
  const hs = [5, 8, 4, 7, 3, 6, 9, 4];
  for (let i = 0; i * 4 < w - 4; i++) {
    const bh = hs[(i + seed) % hs.length];
    R(g, sk, ix + i * 4, base - bh, Math.min(4, w - 4 - i * 4), bh);
    if (sky.kind !== 'day' && bh > 4 && i * 4 + 2 < w - 4) R(g, '#fce8c0', ix + i * 4 + 1, base - bh + 2, 1, 1);
  }
  // mullions
  R(g, WHITE, x + Math.floor(w / 2), y + 2, 1, h - 4);
  R(g, K, x + 1, y + h, w, 1);
  R(g, '#d8d8e0', x - 1, y + h - 1, w + 2, 1);
}

const POSTERS = [
  // no bright yellow and no signal red on the walls: those colours carry meaning in this office
  { bg: '#48b8b0', ink: K, lines: ['IT WORKS', 'ON MY', 'DESK'] },
  { bg: '#7c5c9c', ink: WHITE, lines: ['99 BUGS', 'FIX ONE', '127 BUGS'] },
  { bg: '#3868c8', ink: WHITE, lines: ['TABS OR', 'SPACES?', 'YES.'] },
  { bg: '#38b428', ink: K, lines: ['DAYS W/O', 'REBASE:', '0'] },
  { bg: '#f4ecd8', ink: '#c03830', lines: ['ASK THE', 'DUCK', 'FIRST'] },
];

export function drawPoster(g, x, y, i) {
  const p = POSTERS[((i % POSTERS.length) + POSTERS.length) % POSTERS.length];
  let w = 0;
  for (const l of p.lines) w = Math.max(w, textWidth(l, SMALL));
  w += 6;
  const h = p.lines.length * 7 + 5;
  box(g, x, y, w, h, p.bg, K);
  R(g, K, x + 1, y + h, w, 1);
  p.lines.forEach((l, j) => {
    const lw = textWidth(l, SMALL);
    drawText(g, l, x + Math.floor((w - lw) / 2), y + 3 + j * 7, p.ink, SMALL);
  });
  return { w, h };
}

/** A plate sign with text (zone names). */
export function drawSign(g, x, y, text, bg = K, ink = WHITE, font = SMALL) {
  const w = textWidth(text, font) + 6;
  box(g, x, y, w, font.h + 4, bg, K);
  drawText(g, text, x + 3, y + 2, ink, font);
  return w;
}

export { TOOLS, BIG };
