// Office log: derives human events by diffing successive OfficeState snapshots.
// The dialogue box renders `log.events` (newest first).
//
//   log.events        what to show: STATE CHANGES only by default (needs you, finished, failed, walked in, left,
//                     meetings, tasks started from the office). Tool-call starts and "back at work / on a break"
//                     are recorded too, but only listed while `log.showAll` is on.
//   log.all           every recorded event
//   log.showAll / log.setShowAll(bool)   the ALL ACTIVITY filter (remembered); bumps `log.version`
//   log.onFilter(fn)  called after the filter changed
//   createLogFilterToggle(log) -> <button>   the toggle itself, for whoever lays out the log panel
import { h, setText, setAttr, oneLine, store, needRank, crewCount, crewWords, TOOL_INFO } from './dom.js';
import { taskName } from '../groups.js';

const QUIET_KINDS = new Set(['thinking', 'delegating', 'waiting', 'idle']);
const ACTIVITY_GAP_MS = 12_000; // at most one "started X" line per agent in this window

/** Kinds that are chatter rather than a change of state: hidden unless ALL ACTIVITY is on. */
const CHATTER = new Set(['act', 'work', 'idle']);

export function createEventLog(max = 40) {
  /** @type {{id:string, ts:number, tool?:string, name?:string, text:string, kind:string, selectId?:string}[]} */
  const events = [];
  let showAll = store.get('ao.logAll', '0') === '1';
  let shown = events;
  let shownVersion = -1;
  const filterFns = new Set();
  const lastActivityEvent = new Map();
  const meetings = new Map(); // sessionId -> { id, count }
  let seq = 0;
  let version = 0;

  function push(ev) {
    seq += 1;
    events.unshift({ id: ev.id || `ev-${seq}`, ...ev });
    if (events.length > max) {
      // chatter goes first, so a busy afternoon of tool calls never pushes the state changes out
      let drop = -1;
      let chatter = 0;
      for (let i = events.length - 1; i >= 0; i--) {
        if (!CHATTER.has(events[i].kind)) continue;
        chatter += 1;
        if (drop === -1) drop = i;
      }
      if (drop !== -1 && chatter > max / 2) events.splice(drop, 1);
      else events.length = max;
    }
    version += 1;
  }

  function patch(id, changes) {
    const ev = events.find((e) => e.id === id);
    if (!ev) return false;
    Object.assign(ev, changes);
    version += 1;
    return true;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const who = (s) => ({ tool: s.tool, name: s.name || '???', selectId: s.id });

  function ingest(prev, next) {
    const ts = next.now || Date.now();
    if (!prev) {
      const n = next.sessions.length;
      const need = next.sessions.filter((s) => needRank(s) === 0).length;
      const older = next.sessions.filter((s) => needRank(s) === 1).length;
      const s1 = (k) => (k === 1 ? 's' : '');
      const waitText = need && older ? `, ${need} need${s1(need)} you and ${older} more from earlier` : need ? `, ${need} need${s1(need)} you` : older ? `, ${older} still need${s1(older)} you from earlier` : '';
      push({
        ts, kind: need || older ? 'need' : 'info',
        text: n === 0 ? 'The office is open. Nobody is in yet.' : `${plural(n, 'agent')} in the office${waitText}.`,
      });
      for (const s of next.sessions) {
        const working = (s.subagents || []).filter((x) => x.status === 'working').length;
        if (working) meetings.set(s.id, { id: `meet-${s.id}-0`, count: (s.subagents || []).length });
      }
      return;
    }

    const prevById = new Map(prev.sessions.map((s) => [s.id, s]));
    const nextIds = new Set();

    for (const s of next.sessions) {
      nextIds.add(s.id);
      const p = prevById.get(s.id);
      const subs = s.subagents || [];
      const working = subs.filter((x) => x.status === 'working').length;

      if (!p) {
        push({ ts, kind: 'join', ...who(s), text: `walked in: ${oneLine(taskName(s), 70)}` });
        if (s.status === 'waiting') push({ ts, kind: 'need', ...who(s), text: 'needs you' });
        if (working) {
          const id = `meet-${s.id}-${ts}`;
          meetings.set(s.id, { id, count: subs.length });
          push({ id, ts, kind: 'meet', ...who(s), text: `called a meeting with ${crewCount(subs.length)}` });
        }
        continue;
      }

      if (p.status !== s.status) {
        if (s.status === 'waiting') push({ ts, kind: 'need', ...who(s), text: 'needs you' });
        else if (s.status === 'idle') push({ ts, kind: 'idle', ...who(s), text: 'went on a break' });
        else if (s.status === 'working') push({ ts, kind: 'work', ...who(s), text: 'is back at work' });
      }

      // meetings (orchestrator + subagents)
      const m = meetings.get(s.id);
      if (working > 0 && !m) {
        const id = `meet-${s.id}-${ts}`;
        meetings.set(s.id, { id, count: subs.length });
        push({ id, ts, kind: 'meet', ...who(s), text: `called a meeting with ${crewCount(subs.length)}` });
      } else if (m && subs.length > m.count) {
        m.count = subs.length;
        patch(m.id, { text: `called a meeting with ${crewCount(subs.length)}` });
      }
      if (m && subs.length === 0) {
        meetings.delete(s.id);
        push({ ts, kind: 'info', ...who(s), text: 'wrapped up the meeting' });
      }

      const prevSubs = new Map((p.subagents || []).map((x) => [x.id, x]));
      for (const sub of subs) {
        const ps = prevSubs.get(sub.id);
        if (ps && ps.status === 'working' && sub.status !== 'working') {
          push({
            ts, kind: sub.status === 'failed' ? 'fail' : 'done', tool: s.tool, name: sub.name || 'A crew member', selectId: `${s.id}#${sub.id}`,
            text: `${sub.status === 'failed' ? 'failed' : 'finished'}: ${oneLine(sub.label, 60)}`,
          });
        }
      }

      // activity changes, throttled so a busy office stays readable
      if (
        s.status === 'working' && p.status === 'working' && s.activity && p.activity &&
        s.activity.label !== p.activity.label && !QUIET_KINDS.has(s.activity.kind) &&
        ts - (lastActivityEvent.get(s.id) || 0) >= ACTIVITY_GAP_MS
      ) {
        lastActivityEvent.set(s.id, ts);
        push({ ts, kind: 'act', ...who(s), text: `started ${oneLine(crewWords(s.activity.label, s.activity.kind), 60)}` });
      }
    }

    for (const p of prev.sessions) {
      if (!nextIds.has(p.id)) {
        meetings.delete(p.id);
        lastActivityEvent.delete(p.id);
        push({ ts, kind: 'leave', tool: p.tool, name: p.name || '???', text: 'left the office' });
      }
    }

    // tasks started from the office
    const prevTasks = new Map((prev.tasks || []).map((t) => [t.id, t]));
    for (const t of next.tasks || []) {
      const pt = prevTasks.get(t.id);
      const label = TOOL_INFO[t.tool]?.label || 'AGENT';
      const snip = `“${oneLine(t.label || t.prompt, 48)}”`;
      if (!pt) {
        push({ ts, kind: 'task', tool: t.tool, name: label, text: t.resumeOf ? `follow-up sent: ${snip}` : `hiring for: ${snip}`, selectId: t.sessionId || t.resumeOf });
      } else if (pt.status !== t.status) {
        if (t.status === 'done') push({ ts, kind: 'done', tool: t.tool, name: label, text: `task finished: ${snip}`, selectId: t.sessionId });
        else if (t.status === 'failed') push({ ts, kind: 'fail', tool: t.tool, name: label, text: `task failed: ${snip}`, selectId: t.sessionId });
        else if (t.status === 'stopped') push({ ts, kind: 'info', tool: t.tool, name: label, text: `task stopped: ${snip}`, selectId: t.sessionId });
      }
    }
  }

  return {
    /** What the log shows right now (newest first). */
    get events() {
      if (shownVersion !== version) {
        shownVersion = version;
        shown = showAll ? events : events.filter((e) => !CHATTER.has(e.kind));
      }
      return shown;
    },
    /** Everything recorded, chatter included. */
    all: events,
    ingest,
    note(text, kind = 'info') { push({ ts: Date.now(), kind, text }); },
    get version() { return version; },
    get showAll() { return showAll; },
    setShowAll(v) {
      v = !!v;
      if (v === showAll) return;
      showAll = v;
      store.set('ao.logAll', v ? '1' : '0');
      version += 1;
      for (const fn of filterFns) fn(showAll);
    },
    onFilter(fn) { filterFns.add(fn); return () => filterFns.delete(fn); },
  };
}

/** The ALL ACTIVITY toggle for the log panel: off = state changes only. */
export function createLogFilterToggle(log) {
  const label = h('span', { class: 'log-filter-label', text: 'ALL ACTIVITY' });
  const box = h('span', { class: 'log-filter-box', attrs: { 'aria-hidden': 'true' } });
  const btn = h('button', { class: 'btn btn-mini log-filter', type: 'button', attrs: { role: 'switch', 'aria-checked': 'false' }, on: { click: () => log.setShowAll(!log.showAll) } }, box, label);
  const paint = () => {
    setAttr(btn, 'aria-checked', log.showAll ? 'true' : 'false');
    setAttr(btn, 'title', log.showAll
      ? 'Showing everything, tool calls included. Click to show state changes only.'
      : 'Showing state changes only: needs you, finished, failed, arrivals, meetings, tasks. Click to also show every tool call.');
    setText(label, 'ALL ACTIVITY');
  };
  log.onFilter(paint);
  paint();
  return btn;
}
