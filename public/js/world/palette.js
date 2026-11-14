// The whole office is painted from this one small, NES-flavoured palette:
// flat colours, one shade step, thick near-black outlines.

export const K = '#16101e'; // outline ink
export const WHITE = '#fcfcfc';
export const PAPER = '#f4ecd8';

/** Tool identity. `base` is the uniform, `shade` its one shade step, `light` the monitor glow. */
export const TOOLS = {
  claude: { base: '#f0704c', shade: '#b0402c', light: '#fcb898', deep: '#7c2818', ink: '#fcfcfc', badge: 'CL', label: 'CLAUDE' },
  codex: { base: '#30cc9c', shade: '#1a8868', light: '#a8f8d4', deep: '#0c5840', ink: '#0c3c2c', badge: 'CX', label: 'CODEX' },
  cursor: { base: '#7468fc', shade: '#4034b4', light: '#b8b4fc', deep: '#2c2074', ink: '#fcfcfc', badge: 'CU', label: 'CURSOR' },
};
export const toolOf = (t) => TOOLS[t] || TOOLS.claude;

export const SKIN = [
  ['#fcd4a8', '#dc9c6c'],
  ['#eeb07c', '#bc7848'],
  ['#c48450', '#8c5430'],
  ['#8e5a3a', '#5e3622'],
];

// [base, highlight]. No coral / mint / violet here: those belong to the uniforms.
export const HAIR = [
  ['#241c30', '#4c4464'],
  ['#6c3c18', '#94602c'],
  ['#d8b468', '#ecd498'], // sandy, not yellow: bright yellow is kept for "needs you"
  ['#8c2c18', '#bc4c28'],
  ['#b4b4c0', '#e4e4ec'],
  ['#3c2414', '#644024'],
];

export const PANTS = [
  ['#2c3058', '#1c1c3c'],
  ['#4c3828', '#30241c'],
  ['#50505c', '#34343c'],
  ['#283c34', '#182820'],
];

export const C = {
  // structure
  ceiling: '#241c34',
  ceilingTrim: '#3c3050',
  wall: '#ecdcb0',
  wallShade: '#d4bc88',
  wainscot: '#c49c64',
  wainscotShade: '#a47c48',
  baseboard: '#5c3c24',
  wallRoom: '#c4d0e8',
  wallRoomShade: '#9cacd0',
  wallBreak: '#f4c898',
  wallBreakShade: '#dca470',
  // floors
  floor: '#aca494',
  floorLine: '#989080',
  floorDot: '#b8b0a0',
  walk: '#c8c0ac',
  walkLine: '#b0a894',
  carpet: '#343c70',
  carpetDot: '#444c84',
  carpetVacant: '#2c3054',
  tileA: '#f0d4b4',
  tileB: '#dcb48c',
  lobbyA: '#c8c8d0',
  lobbyB: '#b0b0bc',
  mat: '#4c7c8c', // door mat and lounge rug: dusty teal (red is kept for failures)
  matShade: '#34586c',
  rug: '#4c7c8c',
  rugLine: '#9cc8cc',
  // furniture
  wood: '#c88c4c',
  woodLight: '#e4ac68',
  woodDark: '#986430',
  woodDeep: '#70441c',
  tableTop: '#b06834',
  tableLight: '#d08848',
  tableFront: '#7c4420',
  steel: '#b4bcc8',
  steelDark: '#7c8494',
  steelLight: '#dce0e8',
  chair: '#4c546c',
  chairLight: '#6c7494',
  beige: '#dcd4bc',
  beigeShade: '#aca48c',
  screenOff: '#28303c',
  screenDim: '#3c4658',
  brass: '#e8e0cc', // the name plates: ivory card, so nothing on a desk reads as "needs you"
  brassShade: '#b0a488',
  glass: '#b8ecfc',
  glassFrame: '#e8f8fc',
  glassDark: '#6c9cb4',
  leaf: '#3c9c3c',
  leafLight: '#70cc48',
  leafDark: '#286c34',
  pot: '#c0603c',
  potShade: '#8c3c24',
  couch: '#8c5434',
  couchLight: '#b47448',
  couchDark: '#643820',
  // signals
  ok: '#38b428',
  okDark: '#1c7018',
  bad: '#e02c20',
  badDark: '#901410',
  // One meaning per colour (see "Colour rules" in server/contract.mjs): bright yellow = needs you, and it
  // only ever alternates with its own dimmer step; white + a shape = selected; thin white = hover; red = failed.
  alert: '#fcd820',
  alertDim: '#e6be10', // one small step down: still plainly the same yellow (and well clear of the olive group colour)
  alertInk: '#16101e',
  amber: '#fc9838', // small lights on machines
  select: '#fcfcfc',
  hover: '#fcfcfc',
  tagBg: '#16101e',
  tagText: '#fcfcfc',
  tagDim: '#b8b4c8',
};

/** Sky colours for the windows, by local hour (0-24, fractional). */
export function skyAt(hour) {
  // [from hour, top colour, bottom colour, kind]
  const keys = [
    [0, '#101438', '#1c2458', 'night'],
    [5, '#2c2860', '#70508c', 'night'],
    [6.5, '#6c68c0', '#fca470', 'dawn'],
    [8, '#58a8f8', '#a8dcfc', 'day'],
    [16.5, '#58a8f8', '#bce4fc', 'day'],
    [18, '#7868c8', '#fc9858', 'dusk'],
    [19.5, '#34306c', '#8c507c', 'dusk'],
    [21, '#101438', '#1c2458', 'night'],
    [24, '#101438', '#1c2458', 'night'],
  ];
  let k = keys[0];
  for (const cand of keys) if (hour >= cand[0]) k = cand;
  return { top: k[1], bottom: k[2], kind: k[3], key: `${k[0]}` };
}
