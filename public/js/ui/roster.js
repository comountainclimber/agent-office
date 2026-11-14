// Roster: who needs you, then who is where.
//   NEEDS YOU   a fixed block above the scrolling list (so its newest row can never end up under a header):
//               agents waiting for you right now, then the ones that finished a while ago and that you have not
//               looked at since (session.unanswered). An agent is listed once: while it needs you it lives here,
//               with a tag saying where it is. Rows keep their order (by when they started needing you; a
//               newcomer joins at the end of the fresh ones) and slide in / out.
//   BY ROOM     CONFERENCE ROOMS (orchestrators + their crew), DESKS, BREAK ROOM
//   BY GROUP    one section per group, NO GROUP last
// A section's header counts ALL its members, like the chips in the top bar and the signs in the office; when
// some of them are listed under NEEDS YOU it says so ("3 · 1 above").
// An orchestrator's crew is one line ("+4 crew · 2/4 DONE") until that orchestrator is selected or the line is
// opened by hand.
// Rows are created once per id and updated in place; they move between sections without being rebuilt.
// A row's activity line changes at most once every few seconds. The lists are ONE tab stop: Up / Down / Home /
// End move between rows and group headers, Enter or Space selects (on a group header: spotlight; E edits the
// group). Rows can be ticked (the box under the badge, X, shift-click for a range, Cmd/Ctrl-click, or SELECT
// mode) and grouped in one go.
import { h, setText, setTextTitle, setAttr, setClass, setHidden, placeAt, reconcile, statusGlyph, toolBadge, store, fmtClockShort, fmtWait, effStatus, needRank, crewWords, reducedMotion, STATUS_LABEL, TOOL_INFO } from './dom.js';
import { groupFlag, setFlag, paintFlag } from './groupui.js';
import { taskName } from '../groups.js';

export { needRank };

const ROOMS = [
  { key: 'rooms', label: 'CONFERENCE ROOMS', empty: 'No meetings right now' },
  { key: 'desks', label: 'DESKS', empty: 'Nobody at a desk' },
  { key: 'break', label: 'BREAK ROOM', empty: 'Nobody on a break' },
];
const ROOM_RANK = { rooms: 0, desks: 1, break: 2 };
const ROOM_TAG = { rooms: 'MEETING', desks: 'DESK', break: 'BREAK' }; // short: they share a line with "waiting 12m"
const ROOM_WHERE = { rooms: 'in a meeting', desks: 'at its desk', break: 'in the break room' };
const ACT_MIN_MS = 3000; // a row's activity text holds still for at least this long
const SLIDE_MS = 170; // a row joining or leaving NEEDS YOU

export function groupOf(s) {
  if (s.mode === 'orchestrator' && s.subagents && s.subagents.length) return 'rooms';
  if (s.status === 'idle') return 'break';
  return 'desks';
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));
const sec = (ts) => Math.floor((ts || 0) / 1000);

/**
 * The order the roster shows sessions in; [ and ] cycle through the same order.
 * `since` (optional): session id -> when it started needing you, as the roster first saw it.
 */
export function rosterOrder(sessions, { by = 'room', groups = [], since = null } = {}) {
  const roomRank = (s) => ROOM_RANK[groupOf(s)];
  const pos = new Map(groups.map((g, i) => [g.id, i]));
  const groupRank = (s) => (by !== 'group' ? 0 : s.groupId && pos.has(s.groupId) ? pos.get(s.groupId) : groups.length);
  const from = (s) => (since && since.has(s.id) ? since.get(s.id) : sec(s.lastActivityAt) * 1000);
  return [...sessions].sort((a, b) => {
    const na = needRank(a);
    const nb = needRank(b);
    if (na !== nb) return na - nb;
    // needs you now: the one that has waited longest first, so a newcomer joins at the end and nothing above it moves
    if (na === 0) return from(a) - from(b) || byName(a, b);
    // older: the most recent first, so one that just aged out lands right under the fresh ones
    if (na === 1) return from(b) - from(a) || byName(a, b);
    return groupRank(a) - groupRank(b) || roomRank(a) - roomRank(b) || byName(a, b);
  });
}

/** The obvious one-click group: the biggest bunch of ungrouped agents sharing a folder. */
export function suggestGroup(state, dismissed = new Set(), onlyDir = null) {
  if (!state) return null;
  const groups = state.groups || [];
  const byDir = new Map();
  for (const s of state.sessions) {
    if (s.groupId || !s.cwd || !s.cwd.startsWith('/')) continue;
    if (!byDir.has(s.cwd)) byDir.set(s.cwd, []);
    byDir.get(s.cwd).push(s);
  }
  let best = null;
  for (const [dir, list] of byDir) {
    if (list.length < 2 || dismissed.has(dir) || (onlyDir && dir !== onlyDir)) continue;
    const name = String(list[0].project || dir.split('/').filter(Boolean).pop() || 'Group').slice(0, 24);
    if (groups.some((g) => g.name.toLowerCase() === name.toLowerCase() || (g.autoDirs || []).includes(dir))) continue;
    if (!best || list.length > best.count) best = { dir, name, count: list.length, ids: list.map((s) => s.id) };
  }
  return best;
}

export function createRoster(ctx) {
  let open = store.get('ao.roster', '1') !== '0';
  let by = store.get('ao.rosterBy', 'room') === 'group' ? 'group' : 'room';
  let filter = '';
  let lastState = null;
  let lastSelected = null;
  let groupFilter = null;
  let selectMode = false;
  let anchorId = null; // where a shift-click range starts
  let focusKey = null; // the row that holds the list's one tab stop
  const checked = new Set();
  let dismissed = new Set();
  try { dismissed = new Set(JSON.parse(store.get('ao.suggestDismissed', '[]'))); } catch { /* ignore */ }
  let suggestion = null;
  let sugBusy = false;
  let visibleOrder = []; // ids in display order, for ranges
  const rows = new Map(); // session id -> row record
  const subRows = new Map(); // `${sid}#${subId}` -> record
  const needSince = new Map(); // session id -> when it started needing you (as seen here)
  const crewOpen = new Map(); // orchestrator id -> its crew line was opened / folded by hand
  let painted = false; // the first picture is not news: nothing slides in

  // ---- head ---------------------------------------------------------------------------------------
  const total = h('span', { class: 'roster-total num', text: '0' });
  const collapseBtn = h('button', { class: 'btn btn-x', type: 'button', title: 'Hide the roster (R)', attrs: { 'aria-label': 'Hide the roster' }, on: { click: () => setOpen(false) } },
    h('span', { class: 'ico ico-left', attrs: { 'aria-hidden': 'true' } }));
  const filterInput = h('input', {
    class: 'input roster-filter', type: 'search', placeholder: 'Filter  ( / )', spellcheck: false, autocomplete: 'off',
    attrs: { 'aria-label': 'Filter the roster by name, task, group, project or activity' },
    on: {
      input: () => { filter = filterInput.value.trim().toLowerCase(); render(); },
      keydown: (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (filterInput.value) { filterInput.value = ''; filter = ''; render(); } else filterInput.blur();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusFirst();
        }
      },
    },
  });

  // tools row: [BY ROOM | BY GROUP] [SELECT]   or, while ticking:   [3 SELECTED] [GROUP…] [x]
  const byRoom = h('button', { class: 'seg', type: 'button', text: 'ROOMS', title: 'Arrange by room: meetings, desks, break room', attrs: { role: 'radio' }, on: { click: () => setBy('room') } });
  const byGroup = h('button', { class: 'seg', type: 'button', text: 'GROUPS', title: 'Arrange by group', attrs: { role: 'radio' }, on: { click: () => setBy('group') } });
  const bySeg = h('div', { class: 'segs', attrs: { role: 'radiogroup', 'aria-label': 'Arrange the roster' } }, byRoom, byGroup);
  bySeg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    setBy(by === 'room' ? 'group' : 'room');
    (by === 'room' ? byRoom : byGroup).focus();
  });
  const selectBtn = h('button', { class: 'btn btn-mini roster-select', type: 'button', text: 'SELECT', title: 'Tick several agents, then group them in one go', on: { click: () => setSelectMode(true) } });
  const normalTools = h('div', { class: 'roster-tools' }, bySeg, selectBtn);

  const bulkCount = h('span', { class: 'bulk-count' });
  const bulkGroup = h('button', { class: 'btn btn-mini bulk-go', type: 'button', title: 'Put the ticked agents in a group (G)', on: { click: () => bulkOpen() } }, h('span', { text: 'GROUP…' }));
  const bulkDone = h('button', { class: 'btn btn-x btn-x-mini', type: 'button', title: 'Stop selecting (Esc)', attrs: { 'aria-label': 'Stop selecting' }, on: { click: () => endSelect() } },
    h('span', { class: 'ico ico-x', attrs: { 'aria-hidden': 'true' } }));
  const bulkTools = h('div', { class: 'roster-tools roster-bulk', hidden: true, attrs: { role: 'toolbar', 'aria-label': 'Selected agents' } }, bulkCount, bulkGroup, bulkDone);

  // group spotlight strip
  const spotFlag = groupFlag(null);
  const spotText = h('span', { class: 'spot-text' });
  const spotClear = h('button', { class: 'btn btn-mini', type: 'button', text: 'SHOW ALL', on: { click: () => ctx.toggleGroup(groupFilter) } });
  const spot = h('div', { class: 'roster-spot', hidden: true }, spotFlag, spotText, spotClear);

  // NEEDS YOU: its own block, outside the scroller
  const needCount = h('span', { class: 'roster-group-count num', text: '0' });
  const needOlder = h('span', { class: 'rg-older num', hidden: true });
  const needList = h('ul', { class: 'roster-list need-list', attrs: { 'aria-label': 'Needs you' } });
  const needBox = h('section', { class: 'roster-group roster-need is-need is-clear', data: { group: 'need' } },
    h('h3', { class: 'roster-group-head' }, h('span', { class: 'rg-name rg-name-static' }, h('span', { class: 'rg-label', text: 'NEEDS YOU' })), needOlder, needCount),
    needList);

  // one-click suggestion: "+ Group customer-ui (2)". One slim line: in the NO GROUP header when arranged by
  // group, at the end of the list when arranged by room. Never a block of its own.
  const sugName = h('span', { class: 'sug-name' });
  const sugCount = h('span', { class: 'sug-count' });
  const sugBtn = h('button', { class: 'sug-go', type: 'button', on: { click: () => runSuggestion() } },
    h('span', { class: 'sug-plus', text: '+', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'sug-word', text: 'Group' }), sugName, sugCount);
  const sugX = h('button', { class: 'sug-x', type: 'button', title: 'No thanks', attrs: { 'aria-label': 'Dismiss this suggestion' }, on: { click: () => dismissSuggestion() } },
    h('span', { class: 'ico ico-x', attrs: { 'aria-hidden': 'true' } }));
  const sugError = h('p', { class: 'field-error sug-error', hidden: true, attrs: { role: 'alert' } });
  const sug = h('div', { class: 'roster-sug', hidden: true }, h('div', { class: 'sug-line' }, sugBtn, sugX), sugError);
  const sugFoot = h('div', { class: 'roster-sug-foot' });

  const sections = h('div', { class: 'roster-sections' });
  const noMatch = h('p', { class: 'roster-nomatch', text: 'NO MATCH', hidden: true });
  const scroll = h('div', { class: 'roster-scroll' }, sections, noMatch, sugFoot);
  const lists = h('div', { class: 'roster-lists', attrs: { role: 'group', 'aria-label': 'Agents. Up and Down move between rows, Enter selects.' } }, needBox, scroll);

  const el = h('aside', { id: 'roster', class: 'panel', data: { by }, attrs: { 'aria-label': 'Roster' } },
    h('header', { class: 'roster-head' }, h('h2', { class: 'panel-title' }, h('span', { text: 'ROSTER' }), total), collapseBtn),
    filterInput, normalTools, bulkTools, spot, lists);

  const tabCount = h('span', { class: 'num', text: '0' });
  const tabTasks = h('span', { class: 'roster-tab-tasks num', hidden: true });
  const tab = h('button', { id: 'roster-tab', class: 'btn', type: 'button', title: 'Show the roster (R)', hidden: true, on: { click: () => setOpen(true) } },
    h('span', { class: 'ico ico-right', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'ROSTER' }), tabCount, tabTasks);

  function setOpen(v, { focus = true } = {}) {
    open = !!v;
    store.set('ao.roster', open ? '1' : '0');
    apply();
    if (focus) (open ? collapseBtn : tab).focus({ preventScroll: true });
    ctx.onLayout();
  }

  function apply() {
    setHidden(el, !open);
    setHidden(tab, open);
  }

  function setBy(next) {
    if (next === by) return;
    by = next;
    store.set('ao.rosterBy', by);
    render();
    if (ctx.onOrder) ctx.onOrder();
  }

  // ---- ticking rows -----------------------------------------------------------------------------
  function setSelectMode(on) {
    selectMode = !!on;
    render();
    if (selectMode) { if (!focusFirst()) bulkDone.focus(); }
  }
  function endSelect() {
    const had = selectMode || checked.size > 0;
    checked.clear();
    selectMode = false;
    anchorId = null;
    render();
    if (had && (document.activeElement === document.body || (document.activeElement && document.activeElement.closest('[hidden]')))) selectBtn.focus();
    return had;
  }
  function toggleCheck(id, { range = false } = {}) {
    if (range && anchorId && anchorId !== id && visibleOrder.includes(anchorId) && visibleOrder.includes(id)) {
      const a = visibleOrder.indexOf(anchorId);
      const b = visibleOrder.indexOf(id);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) checked.add(visibleOrder[i]);
    } else {
      if (checked.has(id)) checked.delete(id); else checked.add(id);
      anchorId = id;
    }
    render();
  }
  function bulkOpen() {
    if (!checked.size) return;
    ctx.bulkGroup(bulkGroup, [...checked], () => endSelect());
  }
  function dismissSuggestion() {
    if (!suggestion) return;
    const hadFocus = sug.contains(document.activeElement);
    dismissed.add(suggestion.dir);
    store.set('ao.suggestDismissed', JSON.stringify([...dismissed].slice(-40)));
    setHidden(sugError, true);
    render();
    if (hadFocus) { if (!focusFirst()) filterInput.focus(); }
  }
  async function runSuggestion() {
    if (!suggestion || sugBusy) return;
    sugBusy = true;
    sugBtn.disabled = true;
    setHidden(sugError, true);
    const first = suggestion.ids && suggestion.ids[0];
    const hadFocus = sug.contains(document.activeElement);
    try {
      await ctx.applySuggestion(suggestion);
      if (hadFocus && first) focusRow(first); // the line is gone: the keyboard goes to the first agent it grouped
    } catch (e) {
      setText(sugError, `Couldn't make the group: ${e && e.message ? e.message : e}`);
      setHidden(sugError, false);
    } finally {
      sugBusy = false;
      sugBtn.disabled = false;
    }
  }

  // ---- the lists are one tab stop -----------------------------------------------------------------
  const ROVING = 'button.row, button.rg-name';
  const allRowButtons = () => [...lists.querySelectorAll(ROVING)];
  const visibleRowButtons = () => allRowButtons().filter((b) => b.offsetParent !== null);
  function paintTabStops() {
    const btns = allRowButtons();
    const shown = (b) => !b.closest('[hidden]');
    let holder = btns.find((b) => b.__key === focusKey && shown(b));
    if (!holder) holder = btns.find((b) => b.__key === lastSelected && shown(b));
    if (!holder) holder = btns.find((b) => b.classList.contains('row') && shown(b));
    if (!holder) holder = btns.find(shown);
    for (const b of btns) b.tabIndex = b === holder ? 0 : -1;
  }
  function focusButton(btn) {
    if (!btn) return false;
    focusKey = btn.__key;
    paintTabStops();
    btn.focus({ preventScroll: true });
    btn.scrollIntoView({ block: 'nearest' });
    return true;
  }
  function focusFirst() {
    return focusButton(visibleRowButtons().find((b) => b.classList.contains('row')) || visibleRowButtons()[0]);
  }
  lists.addEventListener('focusin', (e) => {
    const btn = e.target.closest && e.target.closest(ROVING);
    if (btn && btn.__key !== focusKey) { focusKey = btn.__key; paintTabStops(); }
  });
  lists.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const btn = e.target.closest && e.target.closest(ROVING);
    if (!btn) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const list = visibleRowButtons();
      const i = list.indexOf(btn);
      let to;
      if (e.key === 'ArrowDown') to = list[Math.min(list.length - 1, i + 1)];
      else if (e.key === 'ArrowUp') to = list[Math.max(0, i - 1)];
      else if (e.key === 'Home') to = list[0];
      else to = list[list.length - 1];
      e.preventDefault();
      e.stopPropagation(); // the arrows scroll the office everywhere else
      if (to && to !== btn) focusButton(to);
    }
  });

  // ---- rows -------------------------------------------------------------------------------------
  function makeRow(s) {
    const name = h('span', { class: 'row-name' });
    const flag = groupFlag(null, 'row-flag');
    const proj = h('span', { class: 'row-proj' });
    const glyph = statusGlyph(s.status);
    const act = h('span', { class: 'row-act' });
    const where = h('span', { class: 'row-where', hidden: true });
    const badge = toolBadge(s.tool);
    const btn = h('button', {
      class: 'row', type: 'button', tabIndex: -1, data: { tool: s.tool },
      on: {
        click: (e) => {
          if (e.shiftKey) { e.preventDefault(); toggleCheck(s.id, { range: true }); }
          else if (e.metaKey || e.ctrlKey || selectMode) { e.preventDefault(); toggleCheck(s.id); }
          else ctx.select(s.id);
        },
        keydown: (e) => {
          if ((e.key === 'x' || e.key === 'X') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); toggleCheck(s.id, { range: e.shiftKey }); }
        },
      },
    },
      h('span', { class: 'row-l1' }, badge, name, flag, proj, glyph),
      h('span', { class: 'row-l2' }, act, where));
    btn.__key = s.id;
    // the tick box sits under the badge (in the second line's gutter), so the badge never has to give way
    const check = h('button', {
      class: 'row-check', type: 'button', tabIndex: -1, attrs: { role: 'checkbox', 'aria-checked': 'false' },
      on: { click: (e) => toggleCheck(s.id, { range: e.shiftKey }) },
    }, h('span', { class: 'row-check-box', attrs: { 'aria-hidden': 'true' } }));

    // the crew, folded to one line: "+4 crew · 2/4 DONE"
    const crewText = h('span', { class: 'crew-text' });
    const crewDone = h('span', { class: 'crew-done num' });
    const crewFail = h('span', { class: 'crew-fail num', hidden: true });
    const crewBtn = h('button', {
      class: 'row row-crew', type: 'button', tabIndex: -1, attrs: { 'aria-expanded': 'false' },
      on: {
        click: () => toggleCrew(s.id),
        keydown: (e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const isOpen = crewBtn.getAttribute('aria-expanded') === 'true';
          if ((e.key === 'ArrowRight' && !isOpen) || (e.key === 'ArrowLeft' && isOpen)) { e.preventDefault(); e.stopPropagation(); toggleCrew(s.id); }
        },
      },
    }, h('span', { class: 'ico ico-right crew-chev', attrs: { 'aria-hidden': 'true' } }), crewText, crewDone, crewFail);
    crewBtn.__key = `${s.id}#crew`;
    const crewLi = h('li', { class: 'roster-item' }, crewBtn);
    const subs = h('ul', { class: 'roster-subs', hidden: true }, crewLi);
    const li = h('li', { class: 'roster-item' }, btn, check, subs);
    return { li, btn, check, name, flag, proj, glyph, act, where, subs, crewBtn, crewText, crewDone, crewFail, crewIsOpen: false, actText: null, actAt: 0, actKey: '', inNeed: false };
  }

  function toggleCrew(id) {
    const r = rows.get(id);
    if (!r) return;
    crewOpen.set(id, !r.crewIsOpen);
    render();
  }

  function makeSub(sid, sub) {
    const id = `${sid}#${sub.id}`;
    const name = h('span', { class: 'row-name' });
    const label = h('span', { class: 'row-proj' });
    const glyph = statusGlyph(sub.status);
    const btn = h('button', { class: 'row row-sub', type: 'button', tabIndex: -1, on: { click: () => ctx.select(id) } },
      h('span', { class: 'row-l1' }, name, label, glyph));
    btn.__key = id;
    const li = h('li', { class: 'roster-item' }, btn);
    return { li, btn, name, label, glyph };
  }

  function matches(s, groupName) {
    if (!filter) return true;
    const hay = [s.name, s.label, s.project, s.title, groupName, s.tool, TOOL_INFO[s.tool]?.label, s.branch, s.activity?.label, STATUS_LABEL[effStatus(s)], needRank(s) < 2 ? 'needs you waiting' : '',
      ...(s.subagents || []).flatMap((x) => [x.name, x.label, x.agentType, 'crew'])].filter(Boolean).join(' ').toLowerCase();
    return filter.split(/\s+/).every((word) => hay.includes(word));
  }
  const subMatches = (s) => !!filter && (s.subagents || []).some((x) => filter.split(/\s+/).every((word) => [x.name, x.label, x.agentType].filter(Boolean).join(' ').toLowerCase().includes(word)));

  // ---- NEEDS YOU: rows slide in and out ------------------------------------------------------------
  const canSlide = () => painted && open && !document.hidden && !reducedMotion() && typeof needList.animate === 'function';
  const realKids = () => [...needList.children].filter((c) => !c.__ghost);

  /** Put `li` at index `i` among the real rows of the NEEDS YOU list (rows on their way out do not count). */
  function placeNeed(li, i) {
    const cur = realKids()[i];
    if (cur === li) return;
    const hadFocus = li.contains(document.activeElement) ? document.activeElement : null;
    needList.insertBefore(li, cur || null);
    if (hadFocus && document.activeElement !== hadFocus) { try { hadFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  /** A row is about to leave the block: something of its height stays behind for a moment and folds away. */
  function leaveGhost(li) {
    if (!canSlide() || li.parentNode !== needList) return;
    const height = li.offsetHeight;
    if (!height) return;
    const ghost = h('li', { class: 'need-ghost', attrs: { 'aria-hidden': 'true' } });
    ghost.__ghost = true;
    needList.insertBefore(ghost, li);
    const a = ghost.animate([{ height: `${height}px` }, { height: '0px' }], { duration: SLIDE_MS, easing: 'steps(5, end)' });
    const done = () => ghost.remove();
    a.onfinish = done;
    a.oncancel = done;
    setTimeout(done, SLIDE_MS + 120); // a pane that is not being painted never finishes an animation
  }

  function slideIn(li) {
    if (!canSlide()) return;
    const height = li.offsetHeight;
    if (!height) return;
    li.classList.add('is-sliding');
    const a = li.animate([{ height: '0px' }, { height: `${height}px` }], { duration: SLIDE_MS, easing: 'steps(5, end)' });
    const done = () => { li.classList.remove('is-sliding'); try { a.cancel(); } catch { /* ignore */ } };
    a.onfinish = done;
    setTimeout(done, SLIDE_MS + 120); // see leaveGhost()
  }

  // ---- sections -----------------------------------------------------------------------------------
  function makeSection(sec0) {
    const flag = groupFlag(null);
    const label = h('span', { class: 'rg-label' });
    const count = h('span', { class: 'roster-group-count num', text: '0' });
    const above = h('span', { class: 'rg-above num', hidden: true });
    const nameBtn = h('button', {
      class: 'rg-name', type: 'button', tabIndex: -1,
      on: {
        click: () => section.__sec.group && ctx.toggleGroup(section.__sec.group.id),
        keydown: (e) => {
          if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey && section.__sec.group) { e.preventDefault(); e.stopPropagation(); ctx.editGroup(section.__sec.group.id); }
        },
      },
    }, flag, label);
    nameBtn.__key = `sec:${sec0.key}`;
    const nameStatic = h('span', { class: 'rg-name rg-name-static' }, h('span', { class: 'rg-label' }));
    const edit = h('button', { class: 'rg-edit', type: 'button', tabIndex: -1, hidden: true, on: { click: () => section.__sec.group && ctx.editGroup(section.__sec.group.id) } },
      h('span', { class: 'ico ico-pencil', attrs: { 'aria-hidden': 'true' } }));
    const sugSlot = h('div', { class: 'rg-sug' });
    const list = h('ul', { class: 'roster-list' });
    const empty = h('p', { class: 'roster-group-empty' });
    const section = h('section', { class: 'roster-group' },
      h('h3', { class: 'roster-group-head' }, nameBtn, nameStatic, edit, h('span', { class: 'rg-counts' }, count, above), sugSlot), list, empty);
    section.__parts = { flag, label, staticLabel: nameStatic.firstChild, count, above, nameBtn, nameStatic, edit, sugSlot, list, empty };
    section.__sec = sec0;
    return section;
  }

  function paintSection(section, sec0) {
    section.__sec = sec0;
    const p = section.__parts;
    const g = sec0.group;
    setAttr(section, 'data-group', sec0.key);
    setHidden(p.nameBtn, !g);
    setHidden(p.nameStatic, !!g);
    setHidden(p.edit, !g);
    setAttr(p.list, 'aria-label', sec0.label);
    if (g) {
      setFlag(p.flag, g.color);
      paintFlag(section, g.color);
      setText(p.label, g.name);
      setAttr(p.nameBtn, 'title', groupFilter === g.id ? `Showing only ${g.name}. Enter or click to show everyone. E edits the group.` : `Spotlight ${g.name} in the office (Enter). E edits the group.`);
      setAttr(p.nameBtn, 'aria-pressed', groupFilter === g.id ? 'true' : 'false');
      setAttr(p.edit, 'title', `Edit the group “${g.name}”`);
      setAttr(p.edit, 'aria-label', `Edit the group ${g.name}`);
    } else {
      setText(p.staticLabel, sec0.label);
    }
    setClass(section, 'is-group', !!g);
  }

  const recOf = (id) => (id ? (String(id).includes('#') ? subRows.get(id) : rows.get(id)) : null);

  /** Is this row inside the visible part of the list it lives in? */
  function inView(btn) {
    if (!btn || btn.offsetParent === null) return false;
    const box = btn.closest('.need-list, .roster-scroll');
    if (!box) return false;
    const a = btn.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return a.bottom > b.top + 4 && a.top < b.bottom - 4;
  }

  function render() {
    const state = lastState;
    const sessions = state ? state.sessions : [];
    // the selected row and the row with the keyboard stay on show when rows above them come and go
    const keep = open ? [recOf(lastSelected), [...rows.values(), ...subRows.values()].find((r) => r.btn === document.activeElement)].filter((r) => r && inView(r.btn)) : [];
    const groups = (state && state.groups) || [];
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const selected = lastSelected;
    const nowServer = (state && state.now) || Date.now();
    const nowLocal = Date.now();

    // when each one started needing you: what keeps the NEEDS YOU rows in a steady order
    const ids = new Set(sessions.map((s) => s.id));
    let bump = 0;
    for (const s of sessions) {
      if (needRank(s) === 2) needSince.delete(s.id);
      else if (!needSince.has(s.id)) needSince.set(s.id, painted ? nowServer + (bump++) : s.lastActivityAt || nowServer);
    }
    for (const id of [...needSince.keys()]) if (!ids.has(id)) needSince.delete(id);
    for (const id of [...crewOpen.keys()]) if (!ids.has(id)) crewOpen.delete(id);
    const ordered = rosterOrder(sessions, { by, groups, since: needSince });

    // prune ticks for people who left
    if (checked.size) for (const id of [...checked]) if (!ids.has(id)) checked.delete(id);
    const selecting = selectMode || checked.size > 0;

    // which sections exist right now (a group has one as soon as it has a member, wherever that member is listed)
    const homeKey = (s) => (by === 'group' ? `g:${s.groupId && groupById.has(s.groupId) ? s.groupId : ''}` : groupOf(s));
    let secs = [];
    if (by === 'group') {
      const used = new Set(sessions.map((s) => (s.groupId && groupById.has(s.groupId) ? s.groupId : '')));
      secs.push(...groups.filter((g) => used.has(g.id) || g.id === groupFilter).map((g) => ({ key: `g:${g.id}`, group: g, label: g.name, empty: 'Nobody in this group right now' })));
      if (used.has('')) secs.push({ key: 'g:', group: null, label: 'NO GROUP', empty: '' });
    } else {
      secs.push(...ROOMS.map((r) => ({ key: r.key, group: null, label: r.label, empty: r.empty })));
    }
    if (!sessions.length) secs = []; // nobody is in: one line says so, no empty headers
    reconcile(sections, secs, (x) => x.key, makeSection, paintSection);
    const secEls = sections.__keyed;
    // members = everyone who belongs here; above = those of them listed under NEEDS YOU; index = rows placed here
    const stat = new Map(secs.map((x) => [x.key, { index: 0, members: 0, above: 0, own: 0 }]));

    // rows that are about to leave NEEDS YOU fold away where they were
    const nextNeed = new Set(sessions.filter((s) => needRank(s) < 2).map((s) => s.id));
    for (const [id, r] of rows) if (r.inNeed && !nextNeed.has(id)) leaveGhost(r.li);

    const seen = new Set();
    const seenSubs = new Set();
    const entering = [];
    let anyShown = false;
    let inSpot = 0;
    let needIndex = 0;
    let fresh = 0;
    let older = 0;
    visibleOrder = [];

    for (const s of ordered) {
      seen.add(s.id);
      let r = rows.get(s.id);
      if (!r) { r = makeRow(s); rows.set(s.id, r); }
      const rank = needRank(s);
      const status = effStatus(s);
      const st = stat.get(homeKey(s));
      const g = s.groupId ? groupById.get(s.groupId) : null;
      const inFilter = !groupFilter || s.groupId === groupFilter;
      if (inFilter) inSpot += 1;
      const visible = inFilter && matches(s, g ? g.name : '');
      const task = taskName(s);
      const isChecked = checked.has(s.id);

      // the activity line: what it is doing, or (under NEEDS YOU) how long it has been waiting. Held still for a few seconds.
      let act = crewWords(s.activity?.label || '', s.activity?.kind);
      let actTitle = act;
      if (s.answered) { act = 'Reply sent'; actTitle = 'You just replied: it is picking that up.'; }
      else if (rank < 2) {
        act = `waiting ${fmtWait(nowServer - s.lastActivityAt)}`;
        actTitle = rank === 0
          ? `Finished its turn at ${fmtClockShort(s.lastActivityAt)} and is waiting for you.`
          : `Finished its turn at ${fmtClockShort(s.lastActivityAt)} and has been waiting for you since. Select it to mark it as seen.`;
      }
      const actKey = `${status}|${rank}|${s.answered ? 1 : 0}`;
      if (r.actText == null || r.actKey !== actKey || nowLocal - r.actAt >= ACT_MIN_MS) {
        if (act !== r.actText) { r.actText = act; r.actAt = nowLocal; }
        r.actKey = actKey;
      }
      const statusText = rank === 1 ? 'NEEDS YOU SINCE EARLIER' : STATUS_LABEL[status] || status;

      setText(r.name, s.name);
      setTextTitle(r.proj, s.label || s.project || '');
      setClass(r.proj, 'is-label', !!s.label);
      setFlag(r.flag, g ? g.color : null);
      setHidden(r.flag, !g);
      setAttr(r.glyph, 'data-status', rank === 1 ? 'waiting' : status);
      setAttr(r.glyph, 'data-quiet', rank === 1 ? 'true' : null);
      setText(r.act, r.actText);
      setAttr(r.act, 'title', rank < 2 || s.answered ? actTitle : null);
      // pinned rows say where the agent is: its room, or (arranged by group) its group
      const whereText = rank < 2 ? (by === 'group' ? (g ? g.name : '') : ROOM_TAG[groupOf(s)]) : '';
      setText(r.where, whereText);
      setHidden(r.where, !whereText);
      setAttr(r.btn, 'data-status', status);
      setAttr(r.btn, 'data-need', rank === 0 ? 'fresh' : rank === 1 ? 'older' : null);
      setAttr(r.btn, 'title', [`${s.name} · ${TOOL_INFO[s.tool]?.label || s.tool} · ${statusText}`, task, s.label && s.title && s.title !== s.label ? `(${s.title})` : '',
        [s.project, g ? `group: ${g.name}` : '', ROOM_WHERE[groupOf(s)]].filter(Boolean).join(' · '), rank < 2 ? actTitle : r.actText].filter(Boolean).join('\n'));
      setAttr(r.btn, 'aria-label', `${s.name}, ${TOOL_INFO[s.tool]?.label || s.tool}, ${statusText}, ${task}, ${s.project || ''}${g ? `, group ${g.name}` : ''}, ${r.actText}`);
      setAttr(r.btn, 'aria-current', selected === s.id ? 'true' : null);
      setAttr(r.check, 'aria-checked', isChecked ? 'true' : 'false');
      setAttr(r.check, 'aria-label', `Tick ${s.name}`);
      setAttr(r.check, 'title', isChecked ? 'Untick' : 'Tick to group several at once (Shift-click for a range)');
      setClass(r.li, 'is-checked', isChecked);
      setHidden(r.li, !visible);

      // the crew: an orchestrator keeps it under its row wherever it is listed, folded to one line by default
      const subs = groupOf(s) === 'rooms' ? s.subagents || [] : [];
      if (subs.length) {
        const family = !!selected && (selected === s.id || selected.startsWith(`${s.id}#`));
        const isOpen = crewOpen.has(s.id) ? crewOpen.get(s.id) : family || subMatches(s);
        r.crewIsOpen = isOpen;
        const doneN = subs.filter((x) => x.status !== 'working').length;
        const failedN = subs.filter((x) => x.status === 'failed').length;
        setText(r.crewText, `+${subs.length} crew`);
        setText(r.crewDone, `${doneN}/${subs.length} DONE`);
        setClass(r.crewDone, 'is-all', doneN === subs.length);
        setText(r.crewFail, `${failedN} FAILED`);
        setHidden(r.crewFail, failedN === 0);
        setAttr(r.crewBtn, 'aria-expanded', isOpen ? 'true' : 'false');
        setAttr(r.crewBtn, 'title', `${s.name}'s crew: ${doneN} of ${subs.length} done${failedN ? `, ${failedN} failed` : ''}. ${isOpen ? 'Click to fold' : 'Click to list them'}.`);
        setAttr(r.crewBtn, 'aria-label', `${s.name}'s crew, ${subs.length}: ${doneN} done${failedN ? `, ${failedN} failed` : ''}`);
        let si = 0;
        for (const sub of subs) {
          const k = `${s.id}#${sub.id}`;
          seenSubs.add(k);
          let sr = subRows.get(k);
          if (!sr) { sr = makeSub(s.id, sub); subRows.set(k, sr); }
          setText(sr.name, sub.name || `#${si + 1}`);
          setTextTitle(sr.label, sub.label || sub.agentType || '');
          setAttr(sr.glyph, 'data-status', sub.status);
          setAttr(sr.btn, 'data-status', sub.status);
          setAttr(sr.btn, 'aria-current', selected === k ? 'true' : null);
          setAttr(sr.btn, 'title', `${sub.name || 'Crew member'} · ${STATUS_LABEL[sub.status] || sub.status}\n${sub.label || ''}\n${crewWords(sub.activity?.label || '', sub.activity?.kind)}`);
          setAttr(sr.btn, 'aria-label', `${sub.name || 'Crew member'}, crew of ${s.name}, ${STATUS_LABEL[sub.status] || sub.status}, ${sub.label || ''}`);
          setHidden(sr.li, !isOpen);
          placeAt(r.subs, sr.li, si + 1); // index 0 is the crew line
          si += 1;
        }
      }
      setHidden(r.subs, subs.length === 0);

      // where the row goes: NEEDS YOU (in its steady order) or its own section
      if (rank < 2) {
        const joining = !r.inNeed;
        placeNeed(r.li, needIndex);
        needIndex += 1;
        if (joining && visible) entering.push(r.li);
        r.inNeed = true;
        if (visible) { if (rank === 0) fresh += 1; else older += 1; }
      } else {
        r.inNeed = false;
        if (st) { placeAt(secEls.get(homeKey(s)).__parts.list, r.li, st.index); st.index += 1; }
      }
      if (st && visible) {
        st.members += 1;
        if (rank < 2) st.above += 1; else st.own += 1;
      }
      if (visible) { anyShown = true; visibleOrder.push(s.id); }
    }

    for (const [k, sr] of subRows) {
      if (!seenSubs.has(k)) { sr.li.remove(); subRows.delete(k); }
    }
    for (const [id, r] of rows) {
      if (!seen.has(id)) { r.li.remove(); rows.delete(id); }
    }
    for (const li of entering) slideIn(li);

    // NEEDS YOU head
    setText(needCount, fresh);
    setText(needOlder, `+${older} OLDER`);
    setAttr(needOlder, 'title', `${older} finished a while ago and ${older === 1 ? 'is' : 'are'} still waiting for you`);
    setHidden(needOlder, older === 0);
    setClass(needBox, 'is-clear', fresh + older === 0);
    setHidden(needBox, sessions.length === 0);

    const narrowing = !!filter || !!groupFilter;
    for (const sec0 of secs) {
      const sEl = secEls.get(sec0.key);
      const p = sEl.__parts;
      const st = stat.get(sec0.key);
      // the number is everyone who belongs here (while filtering: everyone who matches), wherever they are listed
      setText(p.count, st.members);
      setText(p.above, `· ${st.above} above`);
      setAttr(p.above, 'title', `${st.above} of them ${st.above === 1 ? 'is' : 'are'} listed under NEEDS YOU, above`);
      setHidden(p.above, st.above === 0);
      const isSpot = !!groupFilter && !!sec0.group && sec0.group.id === groupFilter && !filter; // the spotlighted group keeps its header even when empty
      const emptyText = st.own > 0 ? '' : st.above > 0 ? (st.above === 1 ? 'Under NEEDS YOU, above' : 'All under NEEDS YOU, above') : sec0.empty && (!narrowing || isSpot) ? sec0.empty : '';
      setText(p.empty, emptyText);
      setHidden(p.empty, !emptyText);
      setHidden(sEl, narrowing && !isSpot && (filter ? st.own === 0 : st.members === 0));
    }
    const nobody = sessions.length === 0;
    setHidden(noMatch, !(nobody || (narrowing && !anyShown && !(groupFilter && !filter && by === 'group'))));
    setText(noMatch, nobody ? (state ? "NOBODY'S IN" : 'LOOKING…') : groupFilter && !filter ? 'NOBODY IN THIS GROUP' : 'NO MATCH');
    setText(total, sessions.length);
    setText(tabCount, sessions.length);

    // tools row
    setAttr(el, 'data-by', by);
    setAttr(byRoom, 'aria-checked', by === 'room' ? 'true' : 'false');
    setAttr(byGroup, 'aria-checked', by === 'group' ? 'true' : 'false');
    byRoom.tabIndex = by === 'room' ? 0 : -1;
    byGroup.tabIndex = by === 'group' ? 0 : -1;
    setClass(el, 'is-selecting', selecting);
    setHidden(normalTools, selecting);
    setHidden(bulkTools, !selecting);
    setText(bulkCount, checked.size ? `${checked.size} SELECTED` : 'TICK AGENTS');
    bulkGroup.disabled = checked.size === 0;

    // spotlight strip
    const fg = groupFilter ? groupById.get(groupFilter) : null;
    setHidden(spot, !fg);
    if (fg) {
      setFlag(spotFlag, fg.color);
      setText(spotText, `Only ${fg.name}`);
      setAttr(spot, 'title', `Showing the ${inSpot} of ${sessions.length} agents in ${fg.name}`);
    }

    // suggestion: once offered it stays the same folder for as long as it still makes sense
    const next = selecting || groupFilter || filter ? null : (suggestion && suggestGroup(state, dismissed, suggestion.dir)) || suggestGroup(state, dismissed);
    if (!next || !suggestion || next.dir !== suggestion.dir) setHidden(sugError, true);
    suggestion = next;
    setHidden(sug, !suggestion);
    if (suggestion) {
      const noGroup = by === 'group' ? secEls.get('g:') : null;
      const home = noGroup ? noGroup.__parts.sugSlot : sugFoot;
      if (sug.parentNode !== home) {
        const hadFocus = sug.contains(document.activeElement) ? document.activeElement : null;
        home.append(sug);
        if (hadFocus) { try { hadFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
      }
      setText(sugName, suggestion.name);
      setText(sugCount, `(${suggestion.count})`);
      setAttr(sugBtn, 'title', `Make a group called “${suggestion.name}” for the ${suggestion.count} agents working in ${suggestion.dir}. New agents in that folder join it by themselves.`);
      setAttr(sugBtn, 'aria-label', `Make a group called ${suggestion.name} for the ${suggestion.count} agents working in that folder`);
    }

    paintTabStops();
    for (const r of keep) if (r.btn.isConnected && r.btn.offsetParent !== null && !inView(r.btn)) r.btn.scrollIntoView({ block: 'nearest' });
    if (state) painted = true;
  }

  function update(state, selectedId, opts = {}) {
    // picking an orchestrator (or one of its crew) opens its crew again, even if it was folded by hand before
    if (selectedId !== lastSelected && selectedId) crewOpen.delete(String(selectedId).split('#')[0]);
    lastState = state;
    lastSelected = selectedId;
    groupFilter = opts.groupFilter || null;
    render();
  }

  function reveal(id) {
    if (!open || !id) return;
    const rec = recOf(id);
    if (rec && rec.btn.offsetParent !== null) rec.btn.scrollIntoView({ block: 'nearest' });
  }

  function focusRow(id) {
    if (!open) return false;
    const rec = recOf(id);
    if (!rec || rec.btn.offsetParent === null) return false;
    return focusButton(rec.btn);
  }

  apply();
  return {
    el, tab, update, reveal,
    toggle: () => setOpen(!open),
    open: () => { if (!open) setOpen(true, { focus: false }); },
    /** Shown on the collapsed tab, so running tasks are not forgotten while the column is hidden. */
    setTasks(live, failed = 0) { setText(tabTasks, live ? `· ${live} RUNNING` : failed ? `· ${failed} FAILED` : ''); setClass(tabTasks, 'is-failed', !live && failed > 0); setHidden(tabTasks, !live && !failed); },
    isOpen: () => open,
    focusFilter() { if (!open) setOpen(true, { focus: false }); filterInput.focus(); filterInput.select(); },
    by: () => by,
    order: (sessions, groups) => rosterOrder(sessions, { by, groups, since: needSince }),
    /** Ticked rows, if any (G groups them). */
    checkedIds: () => [...checked],
    openBulk: () => bulkOpen(),
    isSelecting: () => selectMode || checked.size > 0,
    endSelect,
    suggestion: () => suggestion,
    /** Is the keyboard in the roster's lists right now? */
    hasFocus: () => lists.contains(document.activeElement),
    /** Move keyboard focus to that agent's row (false when it is not on show). */
    focusRow,
  };
}
