// Task output slide-over: the full (last ~4000 characters of) output of one task started from the office.
// It uses the right-hand slot the transcript uses; only one of the two is open at a time (app.js sees to that).
//
// Anyone can open it without importing anything:
//   window.dispatchEvent(new CustomEvent('ao:open-task-output', { detail: { taskId } }))
// It is also where a task's row in the tray leads: the reason it failed, RETRY, STOP (two presses) and FIND.
import { h, setText, setAttr, setClass, setHidden, toolBadge, fmtElapsed, oneLine, shortPath } from './dom.js';
import { failureReason } from './failure.js';

const STATUS_TEXT = { starting: 'STARTING', running: 'RUNNING', done: 'DONE', failed: 'FAILED', stopped: 'STOPPED' };
const isLive = (t) => t && (t.status === 'starting' || t.status === 'running');

/**
 * createTaskOutput({ taskById(id), sessionForTask(task), retry(task), stop(taskId) -> Promise, find(task), onLayout(),
 *                    copy(text) -> Promise<boolean> })
 *   -> { el, open(taskId), close(), isOpen(), current(), update(now) }
 */
export function createTaskOutput(ctx) {
  let taskId = null;
  let returnFocus = null;
  let lastText = null;
  let armTimer = 0; // STOP was pressed once
  let stopping = false;

  const badgeSlot = h('span');
  const who = h('span', { class: 'tr-who' });
  const closeBtn = h('button', { class: 'btn btn-x', type: 'button', title: 'Close the output (Esc)', attrs: { 'aria-label': 'Close the task output' }, on: { click: () => close() } },
    h('span', { class: 'ico ico-x', attrs: { 'aria-hidden': 'true' } }));
  const status = h('span', { class: 'to-status' });
  const time = h('span', { class: 'to-time num' });
  const prompt = h('p', { class: 'to-prompt' });
  const cwdText = h('bdi');
  const cwd = h('p', { class: 'to-cwd clip-start' }, cwdText);
  const why = h('pre', { class: 'task-why to-why', hidden: true, attrs: { 'aria-label': 'Why it failed' } });
  const out = h('pre', { class: 'to-out', tabIndex: 0, attrs: { 'aria-label': 'Task output' } });
  const copyBtn = h('button', { class: 'btn btn-mini', type: 'button', text: 'COPY', title: 'Copy the output', on: { click: async () => {
    const ok = ctx.copy ? await ctx.copy(out.textContent || '') : false;
    setText(copyBtn, ok ? 'COPIED' : "CAN'T COPY");
    setTimeout(() => setText(copyBtn, 'COPY'), 1500);
  } } });
  const stopBtn = h('button', { class: 'btn btn-mini btn-danger task-stop', type: 'button', text: 'STOP', hidden: true, on: { click: () => pressStop() } });
  const findBtn = h('button', { class: 'btn btn-mini', type: 'button', text: 'FIND', hidden: true, on: { click: () => { const t = ctx.taskById(taskId); if (t && ctx.find) ctx.find(t); } } });
  const retryBtn = h('button', { class: 'btn btn-mini task-retry', type: 'button', text: 'RETRY', hidden: true, on: { click: () => { const t = ctx.taskById(taskId); if (t && ctx.retry) ctx.retry(t); } } });
  const note = h('span', { class: 'to-note' });
  const el = h('aside', { id: 'taskout', class: 'panel side-panel', hidden: true, attrs: { 'aria-label': 'Task output' } },
    h('header', { class: 'tr-head' },
      h('div', { class: 'tr-headline' }, h('h2', { class: 'panel-title', text: 'OUTPUT' }), badgeSlot, who),
      closeBtn),
    h('div', { class: 'to-sub' }, h('div', { class: 'to-line' }, status, time), prompt, cwd),
    why, out,
    h('footer', { class: 'to-foot' }, note, h('span', { class: 'to-actions' }, stopBtn, findBtn, retryBtn, copyBtn)));

  let badgeTool = null;

  const disarm = () => { clearTimeout(armTimer); armTimer = 0; };
  /** STOP is two presses: the first one arms it for a moment. */
  async function pressStop() {
    const t = ctx.taskById(taskId);
    if (!t || !isLive(t) || stopping || !ctx.stop) return;
    if (!armTimer) { armTimer = setTimeout(() => { armTimer = 0; paint(); }, 2500); paint(); return; }
    disarm();
    stopping = true;
    paint();
    try { await ctx.stop(t.id); } finally { stopping = false; paint(); }
  }

  function paint(now = Date.now()) {
    if (el.hidden) return;
    const t = ctx.taskById(taskId);
    setClass(el, 'is-gone', !t);
    if (!t) {
      setText(status, 'GONE');
      setText(note, 'This task is no longer on the list. This is the last output that was loaded.');
      setHidden(retryBtn, true);
      setHidden(stopBtn, true);
      setHidden(findBtn, true);
      return;
    }
    const s = ctx.sessionForTask(t);
    setAttr(el, 'data-tool', t.tool);
    setAttr(el, 'data-status', t.status);
    if (badgeTool !== t.tool) { badgeSlot.replaceChildren(toolBadge(t.tool)); badgeTool = t.tool; }
    setText(who, t.resumeOf ? `REPLY → ${s ? s.name : 'AGENT'}` : s ? s.name : '');
    setText(status, STATUS_TEXT[t.status] || String(t.status).toUpperCase());
    setText(time, fmtElapsed((isLive(t) ? now : t.endedAt || now) - t.startedAt));
    setText(prompt, t.label ? `${t.label} — ${oneLine(t.prompt, 300)}` : oneLine(t.prompt, 300));
    setAttr(prompt, 'title', oneLine(t.prompt, 600));
    setText(cwdText, shortPath(t.cwd));
    setAttr(cwd, 'title', t.cwd || null);
    const failed = t.status === 'failed';
    setHidden(why, !failed);
    setHidden(retryBtn, !failed);
    if (failed) setText(why, failureReason(t, { max: 4 }).text);
    const live = isLive(t);
    if (!live) disarm();
    setHidden(stopBtn, !live || !ctx.stop);
    stopBtn.disabled = stopping;
    setText(stopBtn, stopping ? 'STOPPING…' : armTimer ? 'SURE? STOP' : 'STOP');
    setClass(stopBtn, 'is-armed', !!armTimer);
    setAttr(stopBtn, 'title', armTimer ? 'Press again to stop this task' : 'Stop this task (asks once more)');
    setHidden(findBtn, !ctx.find || !s);
    setAttr(findBtn, 'title', s ? `Select ${s.name} in the office` : null);
    const text = t.outputTail || (isLive(t) ? 'Waiting for output…' : 'No output.');
    if (text !== lastText) {
      const pinned = lastText === null || out.scrollHeight - out.scrollTop - out.clientHeight < 32;
      out.textContent = text;
      lastText = text;
      if (pinned) out.scrollTop = out.scrollHeight;
    }
    setText(note, isLive(t) ? 'Follows while it runs · the last 4000 characters' : 'The last 4000 characters of output');
  }

  function open(id) {
    if (!id || !ctx.taskById(id)) return false;
    if (el.hidden) returnFocus = document.activeElement;
    if (taskId !== id) { lastText = null; disarm(); }
    taskId = id;
    setHidden(el, false);
    paint();
    out.scrollTop = out.scrollHeight;
    ctx.onLayout();
    out.focus({ preventScroll: true });
    return true;
  }

  function close({ restore = true } = {}) {
    if (el.hidden) return;
    setHidden(el, true);
    disarm();
    taskId = null;
    lastText = null;
    ctx.onLayout();
    if (restore && returnFocus && document.contains(returnFocus) && !returnFocus.closest('[hidden]')) {
      try { returnFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    returnFocus = null;
  }

  return { el, open, close, isOpen: () => !el.hidden, current: () => taskId, update: paint };
}
