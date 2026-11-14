// Shortcuts sheet + legend: keys, statuses, tools, groups, what the little pictures in the office mean,
// and the colour rules.
import { h } from './dom.js';
import { openModal } from './modal.js';

const IS_MAC = /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '');
const ALT_Y = IS_MAC ? '⌥Y' : 'ALT+Y';
const ALT_SHIFT_Y = IS_MAC ? '⌥⇧Y' : 'ALT+⇧Y';

const KEYS = [
  ['Y', 'Next agent that needs you, newest first'],
  [ALT_Y, 'The same from anywhere, even while typing'],
  [ALT_SHIFT_Y, 'Previous agent that needs you'],
  ['N', 'Start a new task'],
  ['[  ]', 'Previous / next agent'],
  ['M', 'Reply to the selected agent'],
  ['T', 'Transcript of the selected agent'],
  ['E', 'Name the selected agent\'s task'],
  ['G', 'Group the selected agent or the ticked rows'],
  ['R', 'Show / hide the roster'],
  ['/', 'Filter the roster'],
  ['↑ ↓', 'Roster rows, headers (Enter picks, X ticks)'],
  ['L', 'Open / close the office log'],
  ['S', 'Mute / unmute (Shift+S: next level)'],
  ['ESC', 'Close the top layer, then deselect'],
  ['ARROWS', 'Look around the office (or drag it)'],
  ['?', 'This sheet'],
];

const LEGEND = [
  ['working', 'WORKING', 'mid-turn right now'],
  ['waiting', 'NEEDS YOU', 'turn finished: your move'],
  ['idle', 'IDLE', 'quiet a while: break room'],
];

// what the speech bubbles over a working agent mean (the sprites are the office's own)
const BUBBLES = [
  ['thinking', 'thinking'],
  ['reading', 'reading files'],
  ['editing', 'editing a file'],
  ['running', 'running a command'],
  ['searching', 'searching'],
  ['browsing', 'on the web'],
  ['writing', 'writing its reply'],
  ['delegating', 'briefing its crew'],
];

const COLOURS = [
  ['need', 'Bright yellow', 'an agent needs you. Nothing else.'],
  ['tools', 'Coral / mint / violet', 'Claude / Codex / Cursor.'],
  ['select', 'White + a shape', 'selected (ring, arrow, white name).'],
  ['group', 'A flag or stripe', 'the group; you pick its colour.'],
  ['focus', 'White outline', 'where the keyboard is.'],
  ['fail', 'Red', 'something failed.'],
];

let openSheet = null;

/** A sprite from the office, drawn crisp at an integer scale. Returns null when the world is not available. */
function spriteCanvas(src, scale = 2) {
  if (!src) return null;
  const c = h('canvas', { class: 'help-sprite', width: src.width * scale, height: src.height * scale, attrs: { 'aria-hidden': 'true' } });
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, src.width * scale, src.height * scale);
  return c;
}

export function toggleHelp() {
  if (openSheet && openSheet.isOpen()) { openSheet.close(); return null; }
  const modal = openModal({ title: 'HOW TO PLAY', className: 'modal-help', onClose: () => { openSheet = null; } });
  const keys = h('dl', { class: 'help-keys' });
  for (const [k, label] of KEYS) keys.append(h('dt', null, h('kbd', { text: k })), h('dd', { text: label }));
  const legend = h('ul', { class: 'help-legend' });
  for (const [status, label, text] of LEGEND) {
    legend.append(h('li', null, h('span', { class: 'chip', data: { status } }, h('span', { class: 'glyph', data: { status }, attrs: { 'aria-hidden': 'true' } }), h('span', { text: label })), h('span', { class: 'help-legend-text', text })));
  }
  legend.append(h('li', null,
    h('span', { class: 'chip help-older' }, h('span', { class: 'glyph', data: { status: 'waiting', quiet: 'true' }, attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'OLDER' })),
    h('span', { class: 'help-legend-text', text: 'needs you since earlier; select it to mark it seen' })));
  const tools = h('ul', { class: 'help-legend help-tools' });
  for (const [tool, badge, label] of [['claude', 'CL', 'Claude Code'], ['codex', 'CX', 'Codex'], ['cursor', 'CU', 'Cursor']]) {
    tools.append(h('li', null, h('span', { class: 'badge', data: { tool }, text: badge }), h('span', { class: 'help-legend-text', text: label })));
  }
  // in the office: bubbles and marks. Filled in once the world's sprites are loaded; text-only if they are not.
  const bubbles = h('ul', { class: 'help-legend help-pics help-bubbles' });
  const bubbleSlots = new Map();
  const pic = (key, text) => {
    const slot = h('span', { class: 'help-pic', attrs: { 'aria-hidden': 'true' } });
    bubbleSlots.set(key, slot);
    return h('li', null, slot, h('span', { class: 'help-legend-text', text }));
  };
  for (const [kind, text] of BUBBLES) bubbles.append(pic(`bubble:${kind}`, text));
  const marks = h('ul', { class: 'help-legend help-pics' });
  marks.append(
    pic('alert', 'needs you; a quiet one is from earlier'),
    pic('star', 'runs a meeting: its crew works for it'),
    pic('done', 'that crew member finished its part'),
    pic('failed', 'that crew member failed'),
    pic('zed', 'idle, on a break'));
  import('../world/props.js').then((mod) => {
    if (!modal.isOpen() || typeof mod.props !== 'function') return;
    const p = mod.props();
    const put = (key, src, scale) => { const slot = bubbleSlots.get(key); const c = spriteCanvas(src, scale); if (slot && c) slot.replaceChildren(c); };
    for (const [kind] of BUBBLES) put(`bubble:${kind}`, p.bubbles && p.bubbles[kind] && p.bubbles[kind][0], 2);
    put('alert', p.alert && p.alert[0], 2);
    put('star', p.star, 2);
    put('done', p.markDone, 2);
    put('failed', p.markFail, 2);
    put('zed', p.zed, 3);
  }).catch(() => { /* no world: the text still says what there is to know */ });

  const colours = h('ul', { class: 'help-legend help-colours' });
  for (const [key, name, text] of COLOURS) {
    colours.append(h('li', null, h('span', { class: 'help-swatch', data: { c: key }, attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'help-legend-text' }, h('b', { text: name }), ` — ${text}`)));
  }

  modal.body.append(
    h('div', { class: 'help-grid' },
      h('section', null, h('h3', { class: 'nt-label', text: 'KEYS' }), keys,
        h('p', { class: 'help-note', text: 'Keys are ignored while you are typing in a field.' })),
      h('section', null, h('h3', { class: 'nt-label', text: 'STATUS' }), legend, h('h3', { class: 'nt-label help-gap', text: 'TOOLS' }), tools,
        h('h3', { class: 'nt-label help-gap', text: 'GROUPS' }),
        h('p', { class: 'help-text' }, h('span', { class: 'gflag help-flag', attrs: { 'aria-hidden': 'true' } }),
          'A flag marks a group. Click its chip in the top bar to spotlight it; the pencil (or E) renames, recolours and sets folders that join by themselves.'),
        h('h3', { class: 'nt-label help-gap', text: 'SOUND' }),
        h('p', { class: 'help-text', text: 'The speaker in the top bar: off, critical only, or all; volume and TEST.' })),
      h('section', null, h('h3', { class: 'nt-label', text: 'IN THE OFFICE' }), bubbles, marks),
      h('section', { class: 'help-wide' }, h('h3', { class: 'nt-label', text: 'COLOURS' }), colours)));
  const ok = h('button', { class: 'btn btn-primary', type: 'button', text: 'GOT IT', on: { click: () => modal.close() } });
  modal.foot.append(h('div', { class: 'modal-actions' }, ok));
  ok.focus();
  openSheet = modal;
  return modal;
}
