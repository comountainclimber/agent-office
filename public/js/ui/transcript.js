// Transcript slide-over: the recent conversation of one session, refreshed while open.
//   - what you and the agent SAID is the content: the last CONV_MAX of those messages, prose with paragraphs
//   - what the agent DID in between is folded: a run of tool calls is one line ("9 tool calls · Bash ×6, Edit"),
//     opened on demand
//   - what the HARNESS wrote (role 'system': crew reports, task updates, reminders) is neither: a muted
//     one-liner with its own small label, never "YOU"; several in a row fold into "6 crew reports"
//   - a refresh never moves what you are reading: the view only follows the tail while you are at the bottom
//   - the reply field sits at the foot (the same one as in the dialogue: one draft, either place)
import { h, setText, setAttr, setClass, setHidden, reconcile, toolBadge, fmtClockShort } from './dom.js';
import { taskName } from '../groups.js';
import { createComposer } from './composer.js';
import { renderProse } from './prose.js';

const REFRESH_MS = 3000;
const FETCH_LIMIT = 500; // the server's own cap; most of a busy session's records are tool calls
const CONV_MAX = 30; // user + assistant messages shown (plus the tool runs between them)
const LONG_USER = 700; // a pasted wall of text from the human folds to a few lines
const SYS_LINE = 240; // a harness note is one line; this much of it is kept for the tooltip and the opened row

// Harness messages some tools still log under the human's role: recognised by how they start.
const SYS_PREFIX = [
  [/^<agent-message\b/i, 'crew'],
  [/^\[Subagent hand-back\]/i, 'crew'],
  [/^Another Claude session sent a message/i, 'crew'],
  [/^\[Background task\b/i, 'task'],
  [/^<task-notification>/i, 'task'],
  [/^<system-reminder>/i, 'system'],
];
const SYS_KIND = {
  crew: { label: 'CREW', one: 'crew report', many: 'crew reports' },
  task: { label: 'TASK', one: 'task update', many: 'task updates' },
  system: { label: 'SYSTEM', one: 'system note', many: 'system notes' },
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** null for something a person or the agent said; else { kind: 'crew'|'task'|'system', text } for a harness note. */
export function systemNote(m) {
  const raw = String(m.text || '');
  const head = raw.trimStart();
  let kind = null;
  if (m.role === 'system') kind = /^crew report\b/i.test(head) ? 'crew' : /^task update\b/i.test(head) ? 'task' : 'system';
  else if (m.role === 'user') { const hit = SYS_PREFIX.find(([re]) => re.test(head)); if (hit) kind = hit[1]; }
  if (!kind) return null;
  // the label says what it is: drop the prefix that repeats it, and any raw tags, and keep it to one line
  let text = head.replace(/^(crew report|task update)\s*:\s*/i, '').replace(/^\[(Subagent hand-back|Background task[^\]]*)\]\s*:?\s*/i, '')
    .replace(/<\/?[a-z][\w-]*(\s[^<>]*)?>/gi, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > SYS_LINE) text = `${text.slice(0, SYS_LINE - 1).trimEnd()}…`;
  return { kind, text: text || '(no text)' };
}

/** "mcp__Some_Server__do_thing" + "do_thing: x" -> { name: 'do_thing', body: 'x' }: the name is said once. */
export function toolParts(m) {
  const full = String(m.toolName || '');
  const short = full.split('__').pop() || '';
  let body = String(m.text || '');
  for (const n of [full, short]) {
    if (!n || !body.toLowerCase().startsWith(n.toLowerCase())) continue;
    const rest = body.slice(n.length);
    if (!rest || /^[:\s]/.test(rest)) { body = rest.replace(/^[:\s]+/, ''); break; }
  }
  return { name: short || 'tool', full, body };
}

/**
 * Messages -> rows: conversation messages as they are, each run of consecutive tool calls as one row,
 * each run of consecutive harness notes as one row.
 */
export function groupMessages(messages) {
  const counts = new Map();
  const items = [];
  let run = null;
  let sys = null;
  for (const m of messages) {
    // messages carry no id; ts+role+text is stable, a counter splits exact duplicates
    const base = `${m.ts}|${m.role}|${m.text}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    const key = `${base}|${n}`;
    const note = m.role === 'tool' ? null : systemNote(m);
    if (m.role === 'tool') {
      sys = null;
      if (!run) { run = { kind: 'run', key: `run|${key}`, tools: [] }; items.push(run); }
      run.tools.push({ key, m });
    } else if (note) {
      run = null;
      if (!sys) { sys = { kind: 'sys', key: `sys|${key}`, notes: [] }; items.push(sys); }
      sys.notes.push({ key, m, note });
    } else {
      run = null;
      sys = null;
      items.push({ kind: 'msg', key, m });
    }
  }
  return items;
}

/** The last `max` messages a person or the agent wrote, with every tool call and harness note after the first of them. */
export function recentWindow(messages, max = CONV_MAX) {
  let conv = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' || systemNote(m)) continue;
    conv += 1;
    if (conv === max) return { messages: messages.slice(i), cut: i > 0 };
  }
  return { messages, cut: false };
}

/** "5 crew reports · 1 task update" */
function sysSummary(notes) {
  const order = [];
  const count = new Map();
  for (const { note } of notes) {
    if (!count.has(note.kind)) order.push(note.kind);
    count.set(note.kind, (count.get(note.kind) || 0) + 1);
  }
  return order.map((k) => plural(count.get(k), SYS_KIND[k].one, SYS_KIND[k].many)).join(' · ');
}

function runSummary(tools) {
  const order = [];
  const count = new Map();
  for (const { m } of tools) {
    const { name } = toolParts(m);
    if (!count.has(name)) order.push(name);
    count.set(name, (count.get(name) || 0) + 1);
  }
  const shown = order.slice(0, 4).map((n) => (count.get(n) > 1 ? `${n} ×${count.get(n)}` : n));
  if (order.length > 4) shown.push(`+${order.length - 4} more`);
  return shown.join(' · ');
}

export function createTranscript(ctx) {
  let sessionId = null;
  let timer = 0;
  let loadSeq = 0;
  let loadedFor = null;
  let returnFocus = null;
  const openRuns = new Set(); // run keys the reader unfolded (tool runs and runs of harness notes)
  const openLong = new Set(); // long user messages, and single harness notes, the reader unfolded

  const who = h('span', { class: 'tr-who' });
  const badgeSlot = h('span');
  const sub = h('p', { class: 'tr-sub' });
  const closeBtn = h('button', { class: 'btn btn-x', type: 'button', title: 'Close the transcript (Esc)', attrs: { 'aria-label': 'Close the transcript' }, on: { click: () => close() } },
    h('span', { class: 'ico ico-x', attrs: { 'aria-hidden': 'true' } }));
  const status = h('p', { class: 'tr-status', attrs: { role: 'status' } });
  const earlier = h('p', { class: 'tx-earlier', hidden: true, text: 'Earlier conversation is not shown.' });
  const list = h('ol', { class: 'tr-list' });
  const scroll = h('div', { class: 'tr-scroll', tabIndex: 0, attrs: { role: 'group', 'aria-label': 'Transcript messages' } }, status, earlier, list);

  const composer = createComposer({
    api: ctx.api,
    getSession: ctx.sessionById,
    loadMeta: ctx.loadMeta,
    onSent: (task, session) => { scroll.scrollTop = scroll.scrollHeight; if (ctx.onSent) ctx.onSent(task, session); },
    onEscape: () => scroll.focus({ preventScroll: true }),
    scrollTarget: () => scroll,
    waitingOthers: ctx.waitingOthers,
    nextWaiting: ctx.nextWaiting,
  }, { variant: 'tx' });
  const foot = h('div', { class: 'tx-foot' }, composer.el);

  const el = h('aside', { id: 'transcript', class: 'panel', hidden: true, attrs: { 'aria-label': 'Transcript' } },
    h('header', { class: 'tr-head' },
      h('div', { class: 'tr-headline' }, h('h2', { class: 'panel-title', text: 'TRANSCRIPT' }), badgeSlot, who),
      closeBtn),
    sub, scroll, foot);

  // ------------------------------------------------------------------ rows
  function toolRow() {
    const name = h('span', { class: 'tx-tool-name' });
    const text = h('span', { class: 'tx-tool-text' });
    const li = h('li', { class: 'tx-tool' }, name, text);
    li.__parts = { name, text };
    return li;
  }
  function paintTool(li, { m }) {
    const p = li.__parts;
    const t = toolParts(m);
    setText(p.name, t.name);
    setAttr(p.name, 'title', t.full && t.full !== t.name ? t.full : null);
    setText(p.text, t.body);
    setAttr(p.text, 'title', t.body || null);
  }

  // a harness note: [CREW] one line of it … 14:02. Click (or Enter) opens the line in full.
  function noteRow() {
    const label = h('span', { class: 'tx-sys-label' });
    const text = h('span', { class: 'tx-sys-text' });
    const time = h('time', { class: 'tr-time num' });
    const btn = h('button', { class: 'tx-sys-btn', type: 'button', attrs: { 'aria-expanded': 'false' }, on: { click: () => {
      const k = li.__key;
      if (openLong.has(k)) openLong.delete(k); else openLong.add(k);
      paintNote(li, li.__note);
    } } }, label, text, time);
    const li = h('li', { class: 'tx-sys-note' }, btn);
    li.__parts = { label, text, time, btn };
    return li;
  }
  function paintNote(li, entry) {
    li.__note = entry;
    li.__key = entry.key;
    const p = li.__parts;
    const kind = SYS_KIND[entry.note.kind];
    const open = openLong.has(entry.key);
    setText(p.label, kind.label);
    setText(p.text, entry.note.text);
    setText(p.time, entry.m.ts ? fmtClockShort(entry.m.ts) : '');
    setAttr(li, 'data-kind', entry.note.kind);
    setClass(li, 'is-open', open);
    setAttr(p.btn, 'aria-expanded', open ? 'true' : 'false');
    setAttr(p.btn, 'title', open ? null : entry.note.text);
    setAttr(p.btn, 'aria-label', `${kind.one}, written by the agent's tools, not by you: ${entry.note.text}`);
  }

  function createRow(item) {
    if (item.kind === 'sys') {
      const count = h('span', { class: 'tx-run-count' });
      const time = h('time', { class: 'tr-time num' });
      const btn = h('button', { class: 'tx-run-btn tx-sys-fold', type: 'button', attrs: { 'aria-expanded': 'false' }, on: { click: () => {
        const k = li.__key;
        if (openRuns.has(k)) openRuns.delete(k); else openRuns.add(k);
        paintRow(li, li.__item);
      } } }, h('span', { class: 'ico ico-right tx-run-chev', attrs: { 'aria-hidden': 'true' } }), count, h('span', { class: 'tx-run-names' }), time);
      const notes = h('ol', { class: 'tx-sys-list' });
      const li = h('li', { class: 'tx-sys' }, btn, notes);
      li.__parts = { count, time, btn, notes };
      return li;
    }
    if (item.kind === 'run') {
      const count = h('span', { class: 'tx-run-count' });
      const names = h('span', { class: 'tx-run-names' });
      const time = h('time', { class: 'tr-time num' });
      const btn = h('button', { class: 'tx-run-btn', type: 'button', attrs: { 'aria-expanded': 'false' }, on: { click: () => {
        const k = li.__key;
        if (openRuns.has(k)) openRuns.delete(k); else openRuns.add(k);
        paintRow(li, li.__item);
      } } }, h('span', { class: 'ico ico-right tx-run-chev', attrs: { 'aria-hidden': 'true' } }), count, names, time);
      const tools = h('ol', { class: 'tx-run-list' });
      const li = h('li', { class: 'tx-run' }, btn, tools);
      li.__parts = { count, names, time, btn, tools };
      return li;
    }
    const role = h('span', { class: 'tr-role' });
    const time = h('time', { class: 'tr-time num' });
    const text = h('div', { class: 'tr-text' });
    const moreLabel = h('span');
    const more = h('button', { class: 'tx-more', type: 'button', hidden: true, on: { click: () => {
      const k = li.__key;
      if (openLong.has(k)) openLong.delete(k); else openLong.add(k);
      paintRow(li, li.__item);
    } } }, moreLabel);
    const li = h('li', { class: 'tr-msg', data: { role: item.m.role } }, h('div', { class: 'tr-meta' }, role, time), text, more);
    li.__parts = { role, time, text, more, moreLabel };
    return li;
  }

  function paintRow(li, item) {
    li.__item = item;
    li.__key = item.key;
    const p = li.__parts;
    if (item.kind === 'sys') {
      const n = item.notes.length;
      const single = n === 1;
      const open = single || openRuns.has(item.key);
      setClass(li, 'is-single', single);
      setClass(li, 'is-open', open);
      setHidden(p.btn, single);
      setHidden(p.notes, !open);
      setAttr(p.btn, 'aria-expanded', open ? 'true' : 'false');
      const summary = sysSummary(item.notes);
      setText(p.count, summary);
      setAttr(p.btn, 'title', open ? 'Fold these away' : `Show the ${n} notes the agent's tools wrote here`);
      setAttr(p.btn, 'aria-label', `${summary.replace(/ · /g, ', ')}, written by the agent's tools, not by you`);
      const last = item.notes[n - 1].m.ts;
      setText(p.time, last ? fmtClockShort(last) : '');
      reconcile(p.notes, open ? item.notes : [], (x) => x.key, noteRow, paintNote);
      return;
    }
    if (item.kind === 'run') {
      const n = item.tools.length;
      const single = n === 1;
      const open = single || openRuns.has(item.key);
      setClass(li, 'is-single', single);
      setClass(li, 'is-open', open);
      setHidden(p.btn, single);
      setHidden(p.tools, !open);
      setAttr(p.btn, 'aria-expanded', open ? 'true' : 'false');
      const calls = plural(n, 'tool call', 'tool calls');
      setText(p.count, calls);
      const summary = runSummary(item.tools);
      setText(p.names, summary);
      setAttr(p.btn, 'title', open ? 'Fold these tool calls away' : `Show the ${calls}`);
      setAttr(p.btn, 'aria-label', `${calls}: ${summary.replace(/ · /g, ', ')}`);
      const last = item.tools[n - 1].m.ts;
      setText(p.time, last ? fmtClockShort(last) : '');
      // closed runs keep no rows: a long session is mostly tool calls
      reconcile(p.tools, open ? item.tools : [], (x) => x.key, toolRow, paintTool);
      return;
    }
    const { m } = item;
    const session = sessionId ? ctx.sessionById(sessionId) : null;
    setText(p.role, m.role === 'user' ? 'YOU' : session ? session.name : 'AGENT');
    setText(p.time, m.ts ? fmtClockShort(m.ts) : '');
    const body = m.text || '';
    if (m.role === 'assistant') {
      if (p.text.__src !== body) { renderProse(p.text, body); p.text.__src = body; }
      setClass(p.text, 'prose', true);
      setHidden(p.more, true);
    } else {
      setText(p.text, body);
      const long = body.length > LONG_USER || body.split('\n').length > 12;
      const open = openLong.has(item.key);
      setClass(li, 'is-folded', long && !open);
      setHidden(p.more, !long);
      setText(p.moreLabel, open ? 'SHOW LESS' : 'SHOW ALL');
      setAttr(p.more, 'aria-expanded', long ? (open ? 'true' : 'false') : null);
    }
  }

  function renderMessages(messages) {
    const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    // not at the bottom: hold on to the first row in view, and put it back where it was afterwards
    let anchor = null;
    let anchorTop = 0;
    if (!pinned) {
      const top = scroll.getBoundingClientRect().top;
      for (const li of list.children) {
        const r = li.getBoundingClientRect();
        if (r.bottom > top + 1) { anchor = li; anchorTop = r.top; break; }
      }
    }
    reconcile(list, groupMessages(messages), (x) => x.key, createRow, paintRow);
    if (pinned) scroll.scrollTop = scroll.scrollHeight;
    else if (anchor && anchor.isConnected) scroll.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }

  async function load() {
    if (!sessionId) return;
    const id = sessionId;
    const seq = ++loadSeq;
    const first = loadedFor !== id;
    if (first) {
      setText(status, 'FETCHING…');
      setHidden(status, false);
      setClass(status, 'is-error', false);
    }
    try {
      const all = await ctx.api.getTranscript(id, FETCH_LIMIT);
      if (seq !== loadSeq || sessionId !== id) return;
      const { messages, cut } = recentWindow(all);
      if (first) { list.replaceChildren(); list.__keyed = new Map(); openRuns.clear(); openLong.clear(); }
      setHidden(earlier, !(cut || all.length >= FETCH_LIMIT) || !messages.length);
      renderMessages(messages);
      loadedFor = id;
      setClass(status, 'is-error', false);
      setHidden(status, messages.length > 0);
      if (!messages.length) setText(status, 'No messages yet.');
      if (first) scroll.scrollTop = scroll.scrollHeight;
    } catch (e) {
      if (seq !== loadSeq || sessionId !== id) return;
      setText(status, `Couldn't load the transcript: ${e && e.message ? e.message : e}`);
      setClass(status, 'is-error', true);
      setHidden(status, false);
    }
  }

  let badgeTool = null;
  function paintHead() {
    const s = sessionId ? ctx.sessionById(sessionId) : null;
    setAttr(el, 'data-tool', s ? s.tool : null);
    setText(who, s ? s.name : 'GONE');
    const tool = s ? s.tool : null;
    if (tool !== badgeTool) { badgeSlot.replaceChildren(s ? toolBadge(s.tool) : ''); badgeTool = tool; }
    setText(sub, s ? taskName(s) : 'This agent has left the office. The transcript below is the last one loaded.');
    setAttr(sub, 'title', s ? s.title : null);
    setAttr(el, 'aria-label', s ? `Transcript of ${s.name}` : 'Transcript');
    composer.update(s, { failed: s && ctx.isFailed ? ctx.isFailed(s) : false });
    setHidden(foot, !s);
  }

  /** Open for a session, or switch to another one. Switching (following the selection) never moves the focus. */
  function open(id) {
    if (!id) return;
    const wasOpen = !el.hidden;
    if (sessionId === id && wasOpen) return;
    if (!wasOpen) returnFocus = document.activeElement;
    sessionId = id;
    setHidden(el, false);
    paintHead();
    clearInterval(timer);
    load();
    timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    ctx.onLayout();
    if (!wasOpen) scroll.focus({ preventScroll: true }); // reading keys work at once
  }

  function close() {
    if (el.hidden) return;
    const hadFocus = el.contains(document.activeElement);
    clearInterval(timer);
    timer = 0;
    sessionId = null;
    loadSeq += 1;
    setHidden(el, true);
    ctx.onLayout();
    if (hadFocus || document.activeElement === document.body) {
      if (returnFocus && document.contains(returnFocus) && !returnFocus.closest('[hidden]')) {
        try { returnFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    }
    returnFocus = null;
  }

  return {
    el, open, close,
    isOpen: () => !el.hidden,
    current: () => sessionId,
    update() { if (!el.hidden) paintHead(); },
    /** M with the transcript open: the caret goes to the reply field down here. */
    focusComposer() { return !el.hidden && !foot.hidden && composer.focus(); },
    hasFocus: () => !el.hidden && el.contains(document.activeElement),
  };
}
