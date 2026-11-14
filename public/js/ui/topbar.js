// Top bar. Left to right:
//   title · NEEDS YOU (a button that cycles) + OLDER · WORKING · IDLE · per-tool counts · group chips · … · clock · connection · sound · NEW TASK · ?
//
// Two rules keep it still:
//   1. Every number sits in a fixed-width slot (two digits), and every badge that can come and go keeps its
//      slot while it is away. So a changing count never moves anything. Spotlighting a group does not either:
//      the chip's count slot becomes its edit button, same width.
//   2. What is shown is decided by fit(), from measured widths, only when something that has a width changes
//      (the window, the set of groups, the connection label) — never because a number changed.
//
// OVERFLOW PRIORITY — what the bar keeps longest comes first:
//   NEEDS YOU · NEW TASK · status counts · tool counts · sound · group chips · clock · title text
// So when the window is narrow, things go in this order:
//   SOFT (given up for group chips): the demo blurb, key hints + roomy gaps, the title text, the clock (which is
//        only ever shown from 1440 px up, as HH:MM), the sound button's label (the button and its speaker, whose
//        shape says the level, stay);
//   then group chips fold into the "+n" GROUPS menu, as many as have to;
//   HARD (taken only when the bar still overflows with every chip folded): the connection label, the tool
//        badges (the coloured numbers stay), and last of all the tool counts (the GROUPS menu lists them).
// fit() first finds how many chips the bar can hold with every SOFT step taken, then hands back whatever those
// chips do not need, most wanted first: (tool counts, tool badges, connection label,) the clock, the sound label,
// the title, the roomier gaps and key hints, the blurb.
// NEEDS YOU, NEW TASK and the WORKING / IDLE labels are never dropped. A chip that was on show stays on show
// when a group is added, and a folded chip needs a little spare room to come back (no flapping on a boundary).
import { h, setText, setAttr, setClass, setHidden, reconcile, fmtClockShort, statusGlyph, toolBadge, effStatus, needRank, TOOL_ORDER, TOOL_INFO } from './dom.js';
import { groupFlag, setFlag } from './groupui.js';
import { SOUND_LEVEL_LABEL } from './sound.js';
import { openSoundMenu, SOUND_OPTIONS } from './soundmenu.js';

const CONN_LABEL = { connecting: 'CONNECTING', live: 'LIVE', reconnecting: 'RECONNECTING', demo: 'DEMO' };
const SOUND_SHORT = Object.fromEntries(SOUND_OPTIONS.map((o) => [o.value, o.short]));
const GROW_SLACK = 14; // px of spare room needed before a chip comes back (so the set does not flap on a boundary)

// what the bar gives up, in order; each is a class on #topbar (styled in chrome.css)
const SOFT = ['tf-blurb', 'tf-title', 'tf-clock', 'tf-tight', 'tf-snd']; // before any chip is folded
const HARD = ['tf-conn', 'tf-tools', 'tf-notools']; // only when the bar overflows with every chip folded
const STEPS = [...SOFT, ...HARD];
// what comes back first when there is room to spare (the HARD ones before anything soft)
const GIVE_BACK = ['tf-notools', 'tf-tools', 'tf-conn', 'tf-clock', 'tf-snd', 'tf-title', 'tf-tight', 'tf-blurb'];

const two = (n) => (n > 99 ? '99' : String(n));

export function createTopbar(ctx) {
  // ---- counts ---------------------------------------------------------------------------------
  const toolEls = {};
  const tools = h('div', { class: 'tb-group tb-tools', attrs: { role: 'group', 'aria-label': 'Agents by tool' } });
  for (const tool of TOOL_ORDER) {
    const count = h('span', { class: 'tb-count num', text: '0' });
    const wrap = h('span', { class: 'tb-tool', data: { tool } }, toolBadge(tool), count);
    toolEls[tool] = { wrap, count };
    tools.appendChild(wrap);
  }

  const workingCount = h('span', { class: 'tb-count num', text: '0' });
  const idleCount = h('span', { class: 'tb-count num', text: '0' });
  const needCount = h('span', { class: 'tb-count num', text: '0' });
  const working = h('span', { class: 'tb-stat', data: { status: 'working' } }, statusGlyph('working'), h('span', { class: 'tb-stat-label', text: 'WORKING' }), workingCount);
  // the quieter part: agents whose turn ended a while ago and that you have not looked at since. It is a tag on
  // the button's lower edge (like a legend on a frame), so it takes no room and moves nothing when it comes or goes.
  const olderCount = h('span', { class: 'tb-older-n num', text: '+0' });
  const older = h('span', { class: 'tb-older is-none' }, olderCount, h('span', { class: 'tb-older-label', text: 'OLDER' }));
  const need = h('button', {
    class: 'tb-stat tb-need', type: 'button', data: { status: 'waiting' },
    on: { click: () => ctx.cycleNeedsYou() },
  }, statusGlyph('waiting'), h('span', { class: 'tb-stat-label', text: 'NEEDS YOU' }), needCount, h('kbd', { text: 'Y' }), older);
  const idle = h('span', { class: 'tb-stat', data: { status: 'idle' } }, statusGlyph('idle'), h('span', { class: 'tb-stat-label', text: 'IDLE' }), idleCount);
  const stats = h('div', { class: 'tb-group tb-stats', attrs: { role: 'group', 'aria-label': 'Agents by status' } }, need, working, idle);

  // ---- group chips ------------------------------------------------------------------------------
  const chipList = h('div', { class: 'tb-chiplist' });
  const moreLabel = h('span', { class: 'tb-more-label' });
  const moreBtn = h('button', {
    class: 'btn btn-mini tb-more', type: 'button', attrs: { 'aria-haspopup': 'dialog' },
    on: { click: () => ctx.openGroupsMenu(moreBtn, collapsedInfo()) },
  }, moreLabel, h('span', { class: 'ico ico-down', attrs: { 'aria-hidden': 'true' } }));
  const chips = h('div', { class: 'tb-group tb-chips', attrs: { role: 'group', 'aria-label': 'Groups' } }, chipList, moreBtn);

  function makeChip() {
    const flag = groupFlag(null);
    const name = h('span', { class: 'gchip-name' });
    const count = h('span', { class: 'gchip-count num' });
    const needN = h('span', { class: 'gchip-need num' }); // always there: an empty slot when nobody is waiting
    const btn = h('button', {
      class: 'gchip', type: 'button',
      on: {
        click: () => ctx.toggleGroup(wrap.__id),
        contextmenu: (e) => { e.preventDefault(); ctx.editGroup(wrap.__id); },
        keydown: (e) => { if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); ctx.editGroup(wrap.__id); } },
      },
    }, flag, name, count, needN);
    const edit = h('button', { class: 'gchip-edit', type: 'button', hidden: true, on: { click: () => ctx.editGroup(wrap.__id) } },
      h('span', { class: 'ico ico-pencil', attrs: { 'aria-hidden': 'true' } }));
    const wrap = h('span', { class: 'gchip-wrap' }, btn, edit);
    wrap.__parts = { flag, name, count, needN, btn, edit };
    return wrap;
  }
  function paintChip(wrap, item) {
    const p = wrap.__parts;
    const g = item.group;
    wrap.__id = g.id;
    setFlag(p.flag, g.color);
    setText(p.name, g.name);
    setText(p.count, two(item.count));
    const n = item.need || item.older;
    setText(p.needN, n ? `!${n > 9 ? '+' : n}` : '');
    setAttr(p.needN, 'data-kind', item.need ? 'fresh' : item.older ? 'older' : 'none');
    const on = item.active;
    setAttr(p.btn, 'aria-pressed', on ? 'true' : 'false');
    const waitText = `${item.need ? `, ${item.need} need${item.need === 1 ? 's' : ''} you` : ''}${item.older ? `, ${item.older} since earlier` : ''}`;
    setAttr(p.btn, 'title', on
      ? `Showing only ${g.name} (${item.count} agent${item.count === 1 ? '' : 's'}${waitText}). Click to show everyone again. The pencil, right-click or E edits the group.`
      : `${g.name}: ${item.count} agent${item.count === 1 ? '' : 's'}${waitText}. Click to spotlight them. Right-click or E to edit the group.`);
    setAttr(p.btn, 'aria-label', `Group ${g.name}: ${item.count} agent${item.count === 1 ? '' : 's'}${waitText}`);
    // spotlighted: the count's slot holds the edit button instead (same width, so no chip moves)
    setHidden(p.count, on);
    setHidden(p.edit, !on);
    setAttr(p.edit, 'title', `Edit the group “${g.name}”`);
    setAttr(p.edit, 'aria-label', `Edit the group ${g.name}`);
    setHidden(wrap, !item.shown);
  }

  // ---- right side -------------------------------------------------------------------------------
  const clock = h('time', { class: 'tb-clock num', text: '--:--', title: 'Local time' });
  const connLabel = h('span', { class: 'tb-conn-label', text: 'CONNECTING' });
  const conn = h('span', { class: 'tb-conn', data: { conn: 'connecting' }, attrs: { role: 'status' } }, h('span', { class: 'tb-conn-dot', attrs: { 'aria-hidden': 'true' } }), connLabel);
  // demo marker: lives in the bar, not on the office wall; it stands in for the connection light
  const demo = h('span', { class: 'ribbon', hidden: true, title: 'Demo mode: mock agents. Nothing here is real.' },
    h('span', { class: 'ribbon-tag', text: 'DEMO' }), h('span', { class: 'ribbon-text', text: 'Mock agents. Nothing here is real.' }));

  // sound: one button that says the level and opens the menu; the same width in every state
  const soundIco = h('span', { class: 'ico-snd', data: { level: 'critical' }, attrs: { 'aria-hidden': 'true' } });
  const soundText = h('span', { class: 'tb-sound-text' }, h('span', { text: 'SND:' }), h('span', { class: 'tb-sound-level' }));
  const soundLevel = soundText.lastChild;
  let soundMenu = null;
  const soundBtn = h('button', {
    class: 'btn tb-sound', type: 'button', attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    on: { click: () => { if (soundMenu && soundMenu.isOpen()) soundMenu.close(); else soundMenu = openSoundMenu({ anchor: soundBtn, sound: ctx.sound, onClose: () => setAttr(soundBtn, 'aria-expanded', 'false') }); setAttr(soundBtn, 'aria-expanded', soundMenu && soundMenu.isOpen() ? 'true' : 'false'); } },
  }, soundIco, soundText);
  const paintSound = ({ level, volume }) => {
    setAttr(soundIco, 'data-level', level);
    setAttr(soundBtn, 'data-level', level);
    setText(soundLevel, SOUND_SHORT[level] || level);
    setAttr(soundBtn, 'title', `Sound cues: ${SOUND_LEVEL_LABEL[level]}${level === 'off' ? '' : `, volume ${volume} of 4`}. Click to change (S mutes).`);
    setAttr(soundBtn, 'aria-label', `Sound cues: ${SOUND_LEVEL_LABEL[level]}${level === 'off' ? '' : `, volume ${volume} of 4`}. Open the sound menu.`);
  };

  const newBtn = h('button', { class: 'btn btn-primary tb-new', type: 'button', title: 'Start a new agent task (N)', on: { click: () => ctx.openNewTask() } },
    h('span', { text: 'NEW TASK' }), h('kbd', { text: 'N' }));
  const helpBtn = h('button', { class: 'btn tb-help', type: 'button', title: 'How to play: keys and legend (?)', attrs: { 'aria-label': 'Help: keyboard shortcuts and legend' }, on: { click: () => ctx.openHelp() } }, '?');

  const titleText = h('span', { class: 'tb-title-text', text: 'AGENT OFFICE' });
  const spacer = h('div', { class: 'tb-spacer' });
  const el = h('header', { id: 'topbar', class: 'bar', data: { fit: '0' } },
    h('h1', { class: 'tb-title', title: 'Agent Office' }, h('span', { class: 'tb-logo', attrs: { 'aria-hidden': 'true' } }), titleText),
    stats, tools, chips,
    spacer,
    clock, demo, conn, soundBtn, newBtn, helpBtn);

  // ---- fitting ----------------------------------------------------------------------------------
  /** @type {{group:any,count:number,need:number,older:number,active:boolean,shown:boolean}[]} */
  let chipItems = [];
  let groupsTotal = 0;
  let shownIds = new Set(); // which chips the last fit decided to show
  let fitSig = '';
  let chipSig = '';
  let fitRaf = 0;
  let lastCounts = { byTool: { claude: 0, codex: 0, cursor: 0 } };

  /** Apply a set of steps (class names from STEPS). */
  function setSteps(set) {
    setAttr(el, 'data-fit', String(set.size));
    for (const cls of STEPS) setClass(el, cls, set.has(cls));
  }
  const stepsUpTo = (level) => new Set(STEPS.slice(0, level));

  /** Repaint the chips with the current decision (numbers, spotlight state); never measures. */
  function paintChips() {
    let hidden = 0;
    for (const item of chipItems) {
      item.shown = shownIds.has(item.group.id);
      if (!item.shown) hidden += 1;
    }
    reconcile(chipList, chipItems, (x) => x.group.id, makeChip, paintChip);
    paintMore(hidden);
  }

  function paintMore(hidden) {
    const none = groupsTotal === 0;
    setText(moreLabel, none ? '+ GROUP' : hidden ? `+${hidden}` : chipItems.length ? '' : 'GROUPS');
    setHidden(moreLabel, !none && !hidden && chipItems.length > 0);
    setAttr(moreBtn, 'title', none ? 'Make a group to keep similar tasks together' : hidden ? `All groups (${hidden} did not fit in the bar): spotlight one, make a new one, edit` : 'All groups: spotlight one, make a new one, edit');
    setAttr(moreBtn, 'aria-label', none ? 'Make a group' : `All groups${hidden ? ` (${hidden} more)` : ''}`);
  }

  /** Decide the level and which chips are shown, from real measured widths. */
  function fit() {
    if (fitRaf) { cancelAnimationFrame(fitRaf); fitRaf = 0; }
    if (!el.isConnected || !el.clientWidth) return;
    const n = chipItems.length;
    const prevShown = shownIds;
    const sameChips = chipSig === chipItems.map((c) => c.group.id).join(',');
    chipSig = chipItems.map((c) => c.group.id).join(',');

    // 1. every chip's own width (they do not depend on the numbers: the slots are fixed), loose and tight
    for (const item of chipItems) item.shown = true;
    reconcile(chipList, chipItems, (x) => x.group.id, makeChip, paintChip);
    const measure = (set) => {
      setSteps(set);
      const w = new Map();
      for (const item of chipItems) w.set(item.group.id, chipList.__keyed.get(item.group.id).offsetWidth);
      return { w, gap: parseFloat(getComputedStyle(chipList).columnGap) || 6 };
    };
    const loose = measure(new Set());
    const tight = measure(new Set(['tf-tight']));
    const sizes = (set) => (set.has('tf-tight') ? tight : loose);

    // 2. the room left for chips at a level, with no chip shown and the "+n" button at its widest
    for (const item of chipItems) setHidden(chipList.__keyed.get(item.group.id), true);
    // who keeps a place first: the spotlighted chip, then the chips that were on show, then the rest (in group order)
    const rank = (c) => (c.active ? 0 : prevShown.has(c.group.id) ? 1 : 2);
    const keepOrder = [...chipItems].sort((x, y) => rank(x) - rank(y));
    const freeWith = (set, folded = n) => {
      setSteps(set);
      paintMore(folded);
      return spacer.offsetWidth - Math.max(0, el.scrollWidth - el.clientWidth);
    };
    const usedBy = (list, set) => { const z = sizes(set); return list.reduce((sum, c, i) => sum + z.w.get(c.group.id) + (i ? z.gap : 0), 0); };
    const countFor = (room, set) => {
      const z = sizes(set);
      let used = 0;
      let k = 0;
      for (const item of keepOrder) {
        const w = z.w.get(item.group.id) + (k ? z.gap : 0);
        // a chip that was folded last time needs a little spare room to come back
        const slack = sameChips && !prevShown.has(item.group.id) ? GROW_SLACK : 0;
        if (used + w + slack > room) break;
        used += w;
        k += 1;
      }
      return k;
    };

    // How many chips fit with every SOFT step taken (that is the most the bar can show) …
    let level = SOFT.length;
    let room = freeWith(stepsUpTo(level));
    let k = room >= 0 ? countFor(room, stepsUpTo(level)) : -1;
    // … or, when the bar is too long even with every chip folded, the HARD steps, one at a time, until it fits.
    if (k < 0) {
      level = STEPS.length;
      for (let lv = SOFT.length + 1; lv <= STEPS.length; lv++) {
        room = freeWith(stepsUpTo(lv));
        if (room >= 0) { level = lv; k = countFor(room, stepsUpTo(lv)); break; }
      }
    }
    // Then hand back every step those chips do not need, most wanted first (GIVE_BACK): on a wide window that is
    // all of them; on a narrow one the clock comes back before the sound label, the title last.
    let steps = stepsUpTo(level);
    const shown = keepOrder.slice(0, Math.max(0, k));
    if (k >= 0) {
      for (const cls of GIVE_BACK) {
        if (!steps.has(cls)) continue;
        const trial = new Set(steps);
        trial.delete(cls);
        if (freeWith(trial, n - shown.length) >= usedBy(shown, trial)) steps = trial; // "+n" as it will really read
      }
    }
    setSteps(steps);
    shownIds = new Set(shown.map((c) => c.group.id));
    paintChips();
  }

  function queueFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(() => { fitRaf = 0; fitSig = ''; if (lastArgs) update(lastArgs[0], lastArgs[1]); else fit(); });
  }

  /** What the GROUPS menu should show because the bar had no room for it. */
  function collapsedInfo() {
    const lines = [];
    if (el.classList.contains('tf-notools')) lines.push(TOOL_ORDER.map((t) => `${TOOL_INFO[t].label} ${lastCounts.byTool[t]}`).join(' · '));
    return lines;
  }

  let lastArgs = null;
  let lastFresh = 0;
  let newTimer = 0;

  function update(state, { groupFilter = null } = {}) {
    lastArgs = [state, { groupFilter }];
    const sessions = state ? state.sessions : [];
    const groups = (state && state.groups) || [];
    const byTool = { claude: 0, codex: 0, cursor: 0 };
    const byStatus = { working: 0, waiting: 0, idle: 0 };
    let olderN = 0;
    const perGroup = new Map();
    for (const s of sessions) {
      const status = effStatus(s); // someone you just replied to no longer counts as waiting
      const rank = needRank(s);
      if (byTool[s.tool] != null) byTool[s.tool] += 1;
      if (byStatus[status] != null) byStatus[status] += 1;
      if (rank === 1) olderN += 1;
      if (s.groupId) {
        const c = perGroup.get(s.groupId) || { count: 0, need: 0, older: 0 };
        c.count += 1;
        if (rank === 0) c.need += 1;
        else if (rank === 1) c.older += 1;
        perGroup.set(s.groupId, c);
      }
    }
    lastCounts = { byTool };
    for (const tool of TOOL_ORDER) {
      setText(toolEls[tool].count, two(byTool[tool]));
      setClass(toolEls[tool].wrap, 'is-zero', byTool[tool] === 0);
      setAttr(toolEls[tool].wrap, 'title', `${byTool[tool]} ${TOOL_INFO[tool].label} session${byTool[tool] === 1 ? '' : 's'}`);
    }
    const fresh = byStatus.waiting;
    setText(workingCount, two(byStatus.working));
    setText(idleCount, two(byStatus.idle));
    setText(needCount, two(fresh));
    setClass(working, 'is-zero', byStatus.working === 0);
    setClass(idle, 'is-zero', byStatus.idle === 0);
    setAttr(working, 'title', `${byStatus.working} working right now`);
    setAttr(idle, 'title', `${byStatus.idle} idle (in the break room)${olderN ? `, ${olderN} of them still need${olderN === 1 ? 's' : ''} you` : ''}`);
    setClass(need, 'is-zero', fresh === 0);
    setClass(need, 'is-hot', fresh > 0);
    need.disabled = fresh === 0 && olderN === 0;
    const olderText = olderN ? `${olderN} more finished a while ago and still need${olderN === 1 ? 's' : ''} you (now in the break room)` : '';
    setAttr(need, 'title', fresh ? `${fresh} need${fresh === 1 ? 's' : ''} you — click to visit each in turn (Y)${olderN ? `\n+ ${olderText}: they come after the new ones` : ''}` : olderN ? `Nobody new, but ${olderText} — click to visit (Y)` : 'Nobody needs you');
    setAttr(need, 'aria-label', `Needs you: ${fresh}${olderN ? `, plus ${olderN} since earlier` : ''}. Jump to the next one.`);
    // a short flash when the count goes up, then it just stays yellow
    if (fresh > lastFresh) {
      setClass(need, 'is-new', true);
      clearTimeout(newTimer);
      newTimer = setTimeout(() => setClass(need, 'is-new', false), 6000);
    } else if (fresh === 0) setClass(need, 'is-new', false);
    lastFresh = fresh;
    setText(olderCount, `+${two(olderN)}`);
    setClass(older, 'is-none', olderN === 0);

    // chips: groups with somebody in them (the spotlighted one always), in group order
    groupsTotal = groups.length;
    chipItems = groups
      .filter((g) => perGroup.has(g.id) || g.id === groupFilter)
      .map((g) => ({ group: g, count: perGroup.get(g.id)?.count || 0, need: perGroup.get(g.id)?.need || 0, older: perGroup.get(g.id)?.older || 0, active: g.id === groupFilter, shown: true }));

    // only things that have a width: never a number
    const sig = [window.innerWidth, groupsTotal ? 1 : 0, groupFilter || '', chipItems.map((c) => `${c.group.id}:${c.group.name}`).join(','), demo.hidden ? 0 : 1, conn.hidden ? '' : connLabel.textContent].join('|');
    if (sig !== fitSig) {
      fitSig = sig;
      fit();
    } else {
      paintChips(); // same widths: repaint in place, keep what the last fit decided
    }
  }

  function setConn({ status }) {
    setAttr(conn, 'data-conn', status);
    setText(connLabel, CONN_LABEL[status] || String(status).toUpperCase());
    setAttr(conn, 'title', status === 'live' ? 'Connected to the office server' : CONN_LABEL[status] || status);
    setHidden(conn, status === 'demo' && !demo.hidden);
    queueFit();
  }

  function tick(now) {
    setText(clock, fmtClockShort(now));
  }

  ctx.sound.onChange(paintSound);

  return {
    el, update, setConn, tick, newBtn,
    refit: () => { fitSig = ''; queueFit(); },
    /** G with nobody selected: the GROUPS menu. */
    openGroups: () => ctx.openGroupsMenu(moreBtn, collapsedInfo()),
    setDemo(on) {
      if (demo.hidden === !on) return;
      demo.hidden = !on;
      setHidden(conn, on && conn.dataset.conn === 'demo');
      queueFit();
    },
  };
}
