// Tasks tray: runs started from the office. It lives at the foot of the roster column (never over the
// office) and is ONE LINE most of the time:
//   collapsed   "TASKS 2 · 1 FAILED ▸"            the default whenever nothing is running
//   open        one line per task: status glyph · what · who · elapsed · [stop | dismiss]
// It opens by itself while a task is running, and stays the way you last set it once you touch the header
// (until the list is empty again). Rows never expand: a click opens the task in the OUTPUT panel
// (ui/taskout.js), which has the reason it failed, the whole output, RETRY, STOP and FIND.
// CLEAR FINISHED dismisses every finished row (client-side: the ids are remembered in localStorage).
import { h, setText, setAttr, setClass, setHidden, reconcile, statusGlyph, fmtElapsed, oneLine, store, TOOL_INFO } from './dom.js';
import { lastLines, looksSignedOut } from './failure.js';

export { lastLines, looksSignedOut }; // older callers import these from here

const STATUS_TEXT = { starting: 'STARTING', running: 'RUNNING', done: 'DONE', failed: 'FAILED', stopped: 'STOPPED' };
const GLYPH = { starting: 'working', running: 'working', done: 'done', failed: 'failed', stopped: 'stopped' };
const isLive = (t) => t.status === 'starting' || t.status === 'running';
const STOP_ARM_MS = 2500;
const PREF_KEY = 'ao.tasks'; // '1' = you opened it, '0' = you collapsed it, anything else = by itself

export function createTasks(ctx) {
  const K = ctx.storePrefix || 'ao.';
  let pref = store.get(PREF_KEY, 'auto');
  if (pref !== '1' && pref !== '0') pref = 'auto';
  let open = false;
  let all = [];
  let tasks = []; // what is listed: everything except dismissed finished rows
  const stopping = new Set();
  const armed = new Map(); // task id -> timer: STOP was pressed once
  // Dismissed rows are remembered as id@startedAt: a later run of the server (or of the demo) may hand out the
  // same id again, and that new task must not be born dismissed.
  const dKey = (t) => `${t.id}@${t.startedAt}`;
  let dismissed = new Set();
  try { dismissed = new Set(JSON.parse(store.get(`${K}tasksDismissed`, '[]'))); } catch { /* ignore */ }

  const count = h('span', { class: 'tasks-count num' });
  const summary = h('span', { class: 'tasks-summary num' });
  const failBadge = h('span', { class: 'tasks-failn num', hidden: true });
  const chev = h('span', { class: 'ico ico-down tasks-chev', attrs: { 'aria-hidden': 'true' } });
  const toggle = h('button', { class: 'tasks-toggle', type: 'button', attrs: { 'aria-expanded': 'false', 'aria-controls': 'tasks-list' }, on: { click: () => setOpen(!open) } },
    h('span', { class: 'panel-title', text: 'TASKS' }), count, summary, failBadge, chev);
  const clearBtn = h('button', { class: 'btn btn-mini tasks-clear', type: 'button', text: 'CLEAR FINISHED', title: 'Take every finished task off this list', hidden: true, on: { click: () => clearFinished() } });
  const list = h('ul', { class: 'tasks-list', id: 'tasks-list' });
  const el = h('section', { id: 'tasks', hidden: true, attrs: { 'aria-label': 'Tasks started from the office' } }, toggle, list, clearBtn);

  const listed = (source) => source.filter((t) => isLive(t) || !dismissed.has(dKey(t)));
  const openFor = (rows) => pref === '1' || (pref !== '0' && rows.some(isLive));

  function setOpen(v) {
    pref = v ? '1' : '0';
    store.set(PREF_KEY, pref);
    render();
  }

  function saveDismissed() {
    store.set(`${K}tasksDismissed`, JSON.stringify([...dismissed].slice(-300)));
  }
  function dismiss(task) {
    dismissed.add(dKey(task));
    saveDismissed();
    render();
    if (document.activeElement === document.body) (list.querySelector('.task-head') || toggle).focus({ preventScroll: true });
  }
  function clearFinished() {
    for (const t of all) if (!isLive(t)) dismissed.add(dKey(t));
    saveDismissed();
    render();
    if (!el.hidden) toggle.focus({ preventScroll: true });
  }

  function create(task) {
    const glyph = statusGlyph(GLYPH[task.status] || '');
    const gist = h('span', { class: 'task-gist' });
    const who = h('span', { class: 'task-who' });
    const time = h('span', { class: 'task-time num' });
    const head = h('button', { class: 'task-head', type: 'button', on: { click: () => ctx.openOutput && ctx.openOutput(li.__task.id) } }, glyph, gist, who, time);
    const act = h('button', { class: 'btn btn-x btn-x-mini task-x', type: 'button', on: { click: () => { const t = li.__task; if (isLive(t)) pressStop(t); else dismiss(t); } } },
      h('span', { class: 'ico ico-x task-x-ico', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'task-stop-ico', attrs: { 'aria-hidden': 'true' } }));
    const li = h('li', { class: 'task', data: { tool: task.tool } }, head, act);
    li.__parts = { glyph, gist, who, time, head, act };
    return li;
  }

  function update1(li, task) {
    li.__task = task;
    const p = li.__parts;
    const live = isLive(task);
    const target = ctx.sessionForTask(task);
    const isArmed = armed.has(task.id);
    const busy = stopping.has(task.id);
    const status = STATUS_TEXT[task.status] || String(task.status).toUpperCase();
    setAttr(li, 'data-status', task.status);
    setClass(li, 'is-finished', !live);
    setClass(li, 'is-armed', isArmed || busy);
    setAttr(p.glyph, 'data-status', GLYPH[task.status] || '');
    // who it is for: "→ HANK" for a follow-up, the new hire's name once it has one, its tool until then
    const whoFull = task.resumeOf ? `REPLY → ${target ? target.name : 'AGENT'}` : target ? target.name : TOOL_INFO[task.tool]?.label || '';
    setText(p.who, task.resumeOf ? `→ ${target ? target.name : 'AGENT'}` : whoFull);
    const what = task.label || oneLine(task.prompt, 400);
    setText(p.gist, busy ? 'Stopping…' : isArmed ? 'Press again to stop' : what);
    setAttr(p.head, 'title', `${status}${whoFull ? ` · ${whoFull}` : ''}\n${oneLine(task.prompt, 300)}\nClick for the output${task.status === 'failed' ? ', the reason and RETRY' : ''}`);
    setAttr(p.head, 'aria-label', `${status}, ${whoFull}, ${oneLine(what, 120)}. Open the output.`);
    p.act.disabled = busy;
    setClass(p.act, 'is-stop', live);
    setAttr(p.act, 'title', live ? (isArmed ? 'Press again to stop this task' : 'Stop this task (asks once more)') : 'Dismiss: take this finished task off the list');
    setAttr(p.act, 'aria-label', live ? (isArmed ? 'Press again to stop this task' : 'Stop this task') : 'Dismiss this finished task');
  }

  /** STOP is two presses: the first one arms it for a moment. */
  function pressStop(task) {
    if (!task || stopping.has(task.id)) return;
    if (!armed.has(task.id)) {
      armed.set(task.id, setTimeout(() => { armed.delete(task.id); render(); }, STOP_ARM_MS));
      render();
      return;
    }
    clearTimeout(armed.get(task.id));
    armed.delete(task.id);
    doStop(task);
  }

  async function doStop(task) {
    stopping.add(task.id);
    render();
    try { await ctx.stopTask(task.id); } finally { stopping.delete(task.id); render(); }
  }

  function render() {
    tasks = listed(all);
    if (tasks.length === 0 && pref !== 'auto') { pref = 'auto'; store.set(PREF_KEY, pref); } // an empty tray forgets how it was left
    open = tasks.length > 0 && openFor(tasks);
    setHidden(el, tasks.length === 0);
    setHidden(list, !open);
    setClass(el, 'is-collapsed', !open);
    setAttr(toggle, 'aria-expanded', open ? 'true' : 'false');
    const live = tasks.filter(isLive).length;
    const failedN = tasks.filter((t) => t.status === 'failed').length;
    const finished = tasks.length - live;
    setText(count, tasks.length);
    setText(summary, live ? `· ${live} RUNNING` : failedN ? `· ${failedN} FAILED` : finished ? '· DONE' : '');
    setClass(summary, 'is-live', live > 0);
    setClass(summary, 'is-failed', !live && failedN > 0);
    // something is running AND something failed: the failures get a small red tag next to the count
    setText(failBadge, `!${failedN}`);
    setAttr(failBadge, 'title', `${failedN} failed`);
    setHidden(failBadge, !(live > 0 && failedN > 0));
    const say = `${tasks.length} task${tasks.length === 1 ? '' : 's'}${live ? `, ${live} running` : ''}${failedN ? `, ${failedN} failed` : ''}`;
    setAttr(toggle, 'title', open ? `${say}. Click to fold the list to this line.` : `${say}. Click to show the list.`);
    setAttr(toggle, 'aria-label', `Tasks: ${say}`);
    setHidden(clearBtn, !open || finished === 0);
    setText(clearBtn, finished > 1 ? `CLEAR ${finished} FINISHED` : 'CLEAR FINISHED');
    reconcile(list, tasks, (t) => t.id, create, update1);
    if (ctx.onCount) ctx.onCount(live, tasks.length, failedN);
  }

  function update(state) {
    all = state && Array.isArray(state.tasks) ? state.tasks : [];
    render();
  }

  function tick(now) {
    if (!list.__keyed) return;
    for (const li of list.__keyed.values()) {
      const t = li.__task;
      if (!t) continue;
      const end = isLive(t) ? now : (t.endedAt || now);
      setText(li.__parts.time, fmtElapsed(end - t.startedAt));
    }
  }

  render();
  return {
    el, update, tick,
    isOpen: () => open,
    /** A task was just started or answered: bring the newest row into view — if the tray is open. */
    open() { if (open) list.scrollTop = 0; },
    show() { if (open) list.scrollTop = 0; },
    /**
     * Will this task's row be on show once `state` is painted (tray open, roster open, near the top)?
     * A failure that is already in front of you needs no toast.
     */
    rowVisible(id, state) {
      if (ctx.rosterOpen && !ctx.rosterOpen()) return false;
      const rows = listed(state && Array.isArray(state.tasks) ? state.tasks : all);
      if (!openFor(rows)) return false;
      const i = rows.findIndex((t) => t.id === id);
      return i >= 0 && i < 4;
    },
  };
}
