// Floor Plan concept — glue: live feed -> canvas world + inspector panel + dialogs.
// Rule: anything that comes from data goes into the DOM through textContent only.

import { connectFeed } from '../shared/feed.js';
import { createWorld } from './world.js';
import { C, TOOLS, toolOf, makeLook, drawPortrait, drawMini, drawIcon, hash } from './gfx.js';

const $ = (id) => document.getElementById(id);
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'on') for (const ev of Object.keys(v)) e.addEventListener(ev, v[ev]);
    else if (k === 'attrs') for (const a of Object.keys(v)) { if (v[a] != null && v[a] !== false) e.setAttribute(a, String(v[a])); }
    else e[k] = v;
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return e;
}
function iconEl(name, color = C.white, scale = 2) {
  const c = el('canvas', { class: 'ico' });
  c.width = 5; c.height = 5;
  c.style.width = 5 * scale + 'px'; c.style.height = 5 * scale + 'px';
  drawIcon(c.getContext('2d'), name, 0, 0, color);
  return c;
}
function miniEl(look, boss) {
  const c = el('canvas', { class: 'mini' });
  drawMini(c, look, boss);
  return c;
}
const badge = (tool) => el('span', { class: 'badge ' + toolOf(tool).id, text: toolOf(tool).badge });
const ago = (ms) => { if (!Number.isFinite(ms)) return ''; const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 'S' : s < 3600 ? Math.floor(s / 60) + 'M' : Math.floor(s / 3600) + 'H'; };
const STATUS_LABEL = { working: 'WORKING', waiting: 'NEEDS YOU', idle: 'ON BREAK', done: 'DONE', failed: 'FAILED' };
const STATUS_ICON = { working: 'running', waiting: 'waiting', idle: 'idle', done: 'check', failed: 'cross' };

if (document.fonts?.load) document.fonts.load("8px 'PS2P'").then((f) => { if (f.length) document.documentElement.classList.add('pxfont'); }).catch(() => {});

const params = new URLSearchParams(location.search);
const crowdN = Number(params.get('crowd')) || 0;

let state = null;
let selected = null;
let index = new Map(); // id -> { session, sub? }
let pending = null; // task we launched and want to select when it walks in
let portrait = null; // { canvas, look, opts }
const body = $('pbody');
const tip = $('tip');
const modal = $('modal');

// Dev aids: ?calm=5 shortens the calm spell (seconds) before the floor zooms back in; ?over=3 the wait before
// a sustained shortage of meeting rooms makes it grow; ?slow=8 stretches the camera tween.
const secs = (k) => (params.get(k) != null && Number.isFinite(Number(params.get(k))) ? { [k === 'calm' ? 'calmMs' : 'overMs']: Number(params.get(k)) * 1000 } : {});
const world = createWorld($('floor'), {
  onSelect: (id) => select(id),
  onHover: showTip,
  onReception: () => openNewTask(),
}, { ...secs('calm'), ...secs('over'), slow: Number(params.get('slow')) || 1 });
let feed = null;

function onMode(m) {
  const c = $('mode');
  c.textContent = m === 'mock' ? 'DEMO DATA' : m === 'live' ? 'LIVE' : m === 'reconnecting' ? 'RECONNECTING' : 'CONNECTING';
  c.className = 'chip' + (m === 'live' ? ' live' : m === 'reconnecting' ? ' warn' : '');
}

/* Dev aid: ?crowd=40 pads the feed with clones so the layout can be judged at scale. */
const CROWD_NAMES = ['ABBY', 'BRUNO', 'CLEO', 'DEX', 'ELSA', 'FINN', 'GIGI', 'HUGO', 'IRIS', 'JAX', 'KAI', 'LULU', 'MILO', 'NINA', 'OZZY', 'PENNY', 'QUIN', 'RUBY', 'SAM', 'TESS', 'UMA', 'VIC', 'WES', 'XAN', 'YURI', 'ZOE'];
function crowd(s) {
  if (!crowdN || s.sessions.length >= crowdN) return s;
  const base = s.sessions, out = [...base];
  for (let i = 0; out.length < crowdN && base.length; i++) {
    const b = base[i % base.length], gen = Math.floor(i / base.length) + 1;
    const id = b.id + '~' + gen;
    const keep = i % 6 === 0 && b.mode === 'orchestrator';
    const h = hash(id);
    const status = keep ? b.status : b.status === 'waiting' && h % 3 ? 'working' : b.status;
    out.push({
      ...b, id, nativeId: b.nativeId + '~' + gen, name: CROWD_NAMES[i % CROWD_NAMES.length],
      status, mode: keep ? b.mode : 'solo', subagents: keep ? b.subagents : [],
      activity: keep ? b.activity : status === 'working' ? { kind: ['editing', 'reading', 'running', 'searching', 'thinking'][h % 5], label: ['Edit file.ts', 'Read notes.md', 'Bash: npm test', 'Grep "TODO"', 'Thinking'][h % 5] } : status === 'waiting' ? { kind: 'waiting', label: 'Waiting for you' } : { kind: 'idle', label: 'Idle' },
    });
  }
  return { ...s, sessions: out };
}

function onState(s) {
  state = crowd(s);
  index = new Map();
  for (const x of state.sessions) {
    index.set(x.id, { session: x });
    for (const u of x.subagents || []) index.set(x.id + '#' + u.id, { session: x, sub: u });
  }
  world.setState(state);
  if (pending) {
    const sid = pending.sessionId || state.tasks?.find((t) => t.id === pending.taskId)?.sessionId;
    const hit = state.sessions.find((x) => x.id === sid || (x.taskId && x.taskId === pending.taskId));
    if (hit) { pending = null; select(hit.id); toast(hit.name + ' WALKED IN'); }
    else if (Date.now() - pending.at > 90_000) pending = null;
  }
  if (selected && !index.has(selected)) {
    // a subagent that finished: fall back to its boss; a session that left: back to the overview
    const parent = selected.includes('#') ? selected.slice(0, selected.lastIndexOf('#')) : null;
    select(parent && index.has(parent) ? parent : null);
  } else render();
}

function select(id) {
  if (id && !index.has(id)) id = null;
  selected = id;
  world.select(id);
  render();
}

/* ------------------------------------------------------------------ panel */
// The panel is updated in place (keyed elements, textContent only): state arrives every second and
// rebuilding the DOM would swallow clicks that land mid-refresh.
const setText = (e, t) => { t = t == null ? '' : String(t); if (e.textContent !== t) e.textContent = t; };
const setClass = (e, c) => { if (e.className !== c) e.className = c; };
function setIcon(cv, name, color) {
  const key = name + color;
  if (cv.dataset.k === key) return;
  cv.dataset.k = key;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 5, 5);
  drawIcon(g, name, 0, 0, color);
}
function syncKids(parent, kids) {
  const cur = parent.children;
  if (cur.length === kids.length && kids.every((k, i) => cur[i] === k)) return;
  parent.replaceChildren(...kids);
}

function nextWaiting() {
  if (!state) return;
  const w = state.sessions.filter((x) => x.status === 'waiting').sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  if (!w.length) { toast('NOBODY NEEDS YOU RIGHT NOW'); return; }
  const i = w.findIndex((x) => x.id === selected);
  select(w[(i + 1) % w.length].id);
}

function render() {
  if (!state) return;
  const nWait = state.sessions.filter((x) => x.status === 'waiting').length;
  $('alert').hidden = !nWait;
  setText($('alertn'), String(nWait));
  if (selected) renderDetail(); else renderOverview();
}

/* ---- overview */
const rows = new Map(); // session id -> row
/** Crew progress strip: one pip per subagent + done/total. Rebuilt only when a status changes. */
function setPips(box, subs) {
  const sig = subs.map((u) => u.status[0]).join('');
  if (box.dataset.k === sig) return;
  box.dataset.k = sig;
  const done = subs.filter((u) => u.status !== 'working').length;
  box.replaceChildren(el('span', { class: 'bar' }, subs.map((u) => el('i', { class: u.status }))), el('span', { class: 'n' + (done === subs.length ? ' all' : ''), text: done + '/' + subs.length }));
}
function rowFor(s) {
  let r = rows.get(s.id);
  if (!r) {
    r = {};
    r.mini = el('canvas', { class: 'mini' });
    r.nm = el('span', { class: 'nm' });
    r.star = el('span', { class: 'star' });
    r.l2 = el('span', { class: 'l2' });
    r.pips = el('span', { class: 'pips' });
    r.age = el('span', { class: 'age' });
    r.root = el('button', { class: 'row', type: 'button', on: { click: () => select(s.id) } }, r.mini, el('span', { class: 'tx' }, el('span', { class: 'l1' }, r.nm, badge(s.tool), r.star), r.l2, r.pips), r.age);
    rows.set(s.id, r);
  }
  const boss = s.mode === 'orchestrator', subs = s.subagents || [];
  if (r.boss !== boss) { r.boss = boss; drawMini(r.mini, makeLook(s.id, s.tool), boss); }
  const what = s.status === 'waiting' ? s.title : s.status === 'idle' ? s.title : s.activity?.label;
  const l2 = [s.project, what].filter(Boolean).join(' · ');
  setText(r.nm, s.name || '?');
  setText(r.star, boss ? 'BOSS' : '');
  setText(r.l2, l2);
  r.pips.hidden = !(boss && subs.length);
  if (boss && subs.length) setPips(r.pips, subs);
  setText(r.age, s.status === 'working' ? '' : ago(state.now - s.lastActivityAt));
  // the visible lines are clipped with an ellipsis; the tooltip always has the full text
  const tip = [(s.name || '?') + ' · ' + toolOf(s.tool).label + ' · ' + (STATUS_LABEL[s.status] || s.status), s.project, s.title, s.status === 'working' ? s.activity?.label : null, boss && subs.length ? 'Crew: ' + subs.map((u) => (u.name || u.id) + ' ' + u.status).join(', ') : null].filter(Boolean).join('\n');
  if (r.root.title !== tip) r.root.title = tip;
  setClass(r.root, 'row tool-' + toolOf(s.tool).id + (selected === s.id ? ' sel' : ''));
  return r.root;
}

let ov = null;
function buildOverview() {
  const o = { tools: {}, seg: {} };
  o.count = el('b');
  o.crew = el('span', { class: 'crewn' });
  const group = (cls, label) => {
    const n = el('span'), list = el('div');
    const root = el('div', { class: 'group ' + cls }, el('h3', null, el('span', null, cls === 'needs' ? el('span', { class: 'bang', text: '! ' }) : null, label), n), list);
    o[cls] = { n, list, root };
    return root;
  };
  const seg = (cls) => (o.seg[cls] = el('i', { class: cls }));
  o.legend = el('div', { class: 'legend' });
  // order = what you need first: who is waiting on you, then the head count, then everybody else
  o.root = el('div', null,
    group('needs', 'NEEDS YOU'),
    el('div', { class: 'sum' },
      el('div', { class: 'big' }, o.count, el('span', { text: 'AGENTS' }), o.crew),
      el('div', { class: 'tools3' }, Object.values(TOOLS).map((t) => {
        const n = el('span', { class: 'n' });
        o.tools[t.id] = n;
        // doubles as the legend for the map: the two-letter badge on every nameplate, in the tool's colour
        return el('div', { class: 'tool-' + t.id, title: t.label }, el('span', { class: 'top' }, n, badge(t.id)), el('span', { class: 'l', text: t.label }));
      })),
      el('div', { class: 'statbar', attrs: { role: 'img' } }, seg('working'), seg('waiting'), seg('idle')),
      o.legend),
    group('working', 'WORKING'),
    group('idle', 'ON BREAK'));
  o.none = el('div', { class: 'empty', text: 'The office is empty. Start a task at the front desk.' });
  o.root.append(o.none);
  return o;
}
function renderOverview() {
  if (!ov) ov = buildOverview();
  if (body.firstChild !== ov.root) { body.replaceChildren(ov.root); body.scrollTop = 0; portrait = null; detail = null; }
  const ss = state.sessions;
  const by = (st) => ss.filter((x) => x.status === st);
  const lists = { needs: by('waiting').sort((a, b) => a.lastActivityAt - b.lastActivityAt), working: by('working'), idle: by('idle') };
  setText(ov.count, String(ss.length));
  const crewN = ss.reduce((n, x) => n + (x.subagents || []).length, 0);
  setText(ov.crew, crewN ? '+ ' + crewN + ' CREW' : '');
  for (const t of Object.values(TOOLS)) {
    const n = ss.filter((x) => x.tool === t.id).length;
    setText(ov.tools[t.id], String(n));
    ov.tools[t.id].parentElement.classList.toggle('zero', !n);
  }
  for (const [cls, key] of [['working', 'working'], ['waiting', 'needs'], ['idle', 'idle']]) ov.seg[cls].style.flexGrow = String(lists[key].length);
  const legend = [[lists.working.length, 'WORKING', 'working'], [lists.needs.length, lists.needs.length === 1 ? 'NEEDS YOU' : 'NEED YOU', 'waiting'], [lists.idle.length, 'ON BREAK', 'idle']];
  const sig = legend.map((l) => l[0]).join(',');
  if (ov.legend.dataset.k !== sig) { ov.legend.dataset.k = sig; ov.legend.replaceChildren(...legend.map(([n, label, cls]) => el('span', { class: cls + (n ? '' : ' zero') }, el('b', { text: String(n) }), ' ' + label))); }
  ov.legend.parentElement.querySelector('.statbar').setAttribute('aria-label', legend.map((l) => l[0] + ' ' + l[1].toLowerCase()).join(', '));
  // a group with nobody in it takes no room at all (NEEDS YOU in particular must not sit there empty)
  for (const key of ['needs', 'working', 'idle']) {
    ov[key].root.hidden = !lists[key].length;
    setText(ov[key].n, String(lists[key].length));
    syncKids(ov[key].list, lists[key].map(rowFor));
  }
  ov.none.hidden = ss.length > 0;
  for (const id of rows.keys()) if (!index.has(id)) rows.delete(id);
}

/* ---- detail */
function field(label, ...kids) { return el('div', { class: 'field' }, el('span', { class: 'lbl', text: label }), ...kids); }
let detail = null;

function buildDetail(key, s, sub) {
  const d = { key, crew: new Map() };
  const tool = toolOf(s.tool);
  const boss = !sub && s.mode === 'orchestrator';
  const look = sub ? makeLook(selected, s.tool, 'sub') : makeLook(s.id, s.tool);
  const pc = el('canvas');
  portrait = { canvas: pc, look, opts: { status: 'working', boss } };
  d.name = el('div', { class: 'name' });
  d.model = el('div', { class: 'model' });
  d.stIcon = iconEl('running', C.ink, 2);
  d.stText = el('span');
  d.status = el('span', { class: 'status' }, d.stIcon, d.stText);
  d.actIcon = iconEl('thinking');
  d.actText = el('span');
  d.actLbl = el('span', { class: 'lbl' });
  const actField = el('div', { class: 'field' }, d.actLbl, el('div', { class: 'v act' }, d.actIcon, d.actText));
  const kids = [
    el('div', { class: 'dtop' },
      el('button', { class: 'btn small ghost', type: 'button', text: '< OFFICE', on: { click: () => select(null) } }),
      el('span', { class: 'lbl', text: sub ? 'CREW MEMBER' : boss ? 'ORCHESTRATOR' : 'SOLO AGENT' })),
    el('div', { class: 'who tool-' + tool.id },
      el('div', { class: 'pframe' }, pc, boss ? el('span', { class: 'crown', text: 'BOSS' }) : null),
      el('div', null, d.name, el('div', { class: 'tl' }, badge(s.tool), tool.label), d.model, d.status)),
  ];
  if (sub) {
    d.assign = el('div', { class: 'v' });
    d.started = el('div', { class: 'v' });
    d.bossRow = el('div', { class: 'crew' });
    kids.push(field('ASSIGNMENT', d.assign), actField, field('STARTED', d.started), field('REPORTS TO', d.bossRow),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', type: 'button', text: 'TRANSCRIPT', title: 'Transcript of the orchestrating session', on: { click: () => openTranscript(index.get(s.id)?.session || s) } }),
        el('button', { class: 'btn', type: 'button', text: 'GO TO BOSS', on: { click: () => select(s.id) } })));
  } else {
    d.proj = el('b');
    d.branch = el('span');
    d.title = el('div', { class: 'v' });
    d.sayText = el('span', { class: 't' });
    d.say = el('div', { class: 'say', title: '' }, d.sayText);
    d.sayField = field('LAST SAID', d.say);
    d.crewLbl = el('span', { class: 'lbl' });
    d.crewList = el('div', { class: 'crew' });
    d.crewField = el('div', { class: 'field' }, d.crewLbl, d.crewList);
    d.reply = el('button', { class: 'btn', type: 'button', on: { click: () => { d.compose = 'open'; d.composer.hidden = false; d.reply.hidden = true; d.composer.scrollIntoView({ block: 'nearest' }); d.composer.querySelector('textarea').focus(); } } });
    d.stop = el('button', { class: 'btn ghost small', type: 'button', text: 'STOP THIS TASK', hidden: true, on: { click: async () => { if (!d.taskId) return; d.stop.disabled = true; const r = await feed.stop(d.taskId); d.stop.disabled = false; toast(r.ok ? 'STOP SENT' : 'STOP FAILED'); } } });
    // 'auto' = open while the agent is waiting on you (the reply box is the next action), closed otherwise
    d.compose = 'auto';
    d.composer = composer(s.id, () => { d.compose = 'closed'; render(); });
    d.composer.hidden = true;
    d.say.addEventListener('click', () => d.say.classList.toggle('open'));
    d.actions = el('div', { class: 'actions' }, d.reply, el('button', { class: 'btn', type: 'button', text: 'TRANSCRIPT', on: { click: () => openTranscript(index.get(s.id)?.session || s) } }));
    d.sayField.classList.add('f-say'); d.crewField.classList.add('f-crew'); d.composer.classList.add('f-compose');
    kids.push(field('WHERE', el('div', { class: 'v where' }, d.proj, d.branch)), actField, d.taskField = field('TASK', d.title), d.sayField, d.composer, d.actions, d.stop, d.crewField);
    d.taskField.classList.add('f-task');
  }
  d.root = el('div', { class: 'detail' }, kids);
  return d;
}

function crewRow(d, s, u) {
  const id = s.id + '#' + u.id;
  let r = d.crew.get(u.id);
  if (!r) {
    r = { nm: el('span', { class: 'nm' }), l2: el('span', { class: 'l2' }), l3: el('span', { class: 'l2 l3' }), ico: iconEl('running', C.white, 2), st: el('span', { class: 'st' }) };
    r.st.append(r.ico);
    r.root = el('button', { class: 'row', type: 'button', on: { click: () => select(id) } }, miniEl(makeLook(id, s.tool, 'sub')), el('span', { class: 'tx' }, el('span', { class: 'l1' }, r.nm), r.l2, r.l3), r.st);
    d.crew.set(u.id, r);
  }
  setText(r.nm, u.name || u.id);
  // what it was asked to do, and (while it is still at it) what it is doing right now
  setText(r.l2, u.label || u.agentType || '');
  const now = u.status === 'working' ? u.activity?.label || '' : '';
  setText(r.l3, now);
  r.l3.hidden = !now;
  setClass(r.st, 'st ' + u.status);
  const tip = [(u.name || u.id) + ' · ' + (STATUS_LABEL[u.status] || u.status), u.label, u.status === 'working' ? u.activity?.label : null].filter(Boolean).join('\n');
  if (r.root.title !== tip) r.root.title = tip;
  setIcon(r.ico, STATUS_ICON[u.status] || 'running', u.status === 'done' ? C.green : u.status === 'failed' ? C.red : C.white);
  return r.root;
}

function renderDetail() {
  const f = index.get(selected);
  if (!f) return;
  const { session: s, sub } = f;
  const key = selected + '|' + (sub ? 'sub' : s.mode);
  if (!detail || detail.key !== key) detail = buildDetail(key, s, sub);
  const d = detail;
  if (body.firstChild !== d.root) { body.replaceChildren(d.root); body.scrollTop = 0; }
  const st = sub ? sub.status : s.status;
  const act = sub ? sub.activity : s.activity;
  portrait.opts.status = st === 'done' || st === 'failed' ? 'working' : st;
  if (!d.drawn) { d.drawn = true; drawPortrait(portrait.canvas, portrait.look, portrait.opts); } // do not wait for the blink timer
  setText(d.name, (sub ? sub.name || sub.id : s.name) || '?');
  setText(d.model, sub ? sub.agentType || 'subagent' : [s.model, s.source].filter(Boolean).join(' · '));
  setClass(d.status, 'status ' + st);
  setText(d.stText, STATUS_LABEL[st] || st);
  setIcon(d.stIcon, STATUS_ICON[st] || 'running', st === 'failed' ? '#ffffff' : st === 'idle' ? C.dim : C.ink);
  setText(d.actLbl, !sub && st === 'waiting' ? 'WAITING ' + ago(state.now - s.lastActivityAt) : st === 'idle' ? 'IDLE ' + ago(state.now - s.lastActivityAt) : 'DOING NOW');
  setIcon(d.actIcon, act?.kind || 'thinking', st === 'waiting' ? C.hot : C.white);
  setText(d.actText, act?.label || '');
  if (sub) {
    setText(d.assign, sub.label || '');
    setText(d.started, ago(state.now - sub.startedAt) + ' AGO' + (sub.endedAt ? ' · FINISHED ' + ago(state.now - sub.endedAt) + ' AGO' : ''));
    syncKids(d.bossRow, [rowFor(s)]);
    return;
  }
  setText(d.proj, s.project || '~');
  setText(d.branch, s.branch ? '  ·  ' + s.branch : '');
  setText(d.title, s.title || '');
  setText(d.sayText, s.lastMessage || '');
  if (d.say.title !== (s.lastMessage || '')) d.say.title = s.lastMessage || '';
  d.sayField.hidden = !s.lastMessage;
  setText(d.sayField.firstChild, st === 'waiting' ? (s.name || 'AGENT') + ' SAID' : 'LAST SAID');
  const subs = s.subagents || [];
  d.crewField.hidden = !subs.length;
  setText(d.crewLbl, 'CREW  ' + subs.filter((u) => u.status !== 'working').length + '/' + subs.length + ' DONE');
  syncKids(d.crewList, subs.map((u) => crewRow(d, s, u)));
  // waiting: what they said, then the reply box, come straight after the name plate
  setClass(d.root, 'detail' + (st === 'waiting' ? ' is-waiting' : ''));
  const open = d.compose === 'open' || (d.compose === 'auto' && st === 'waiting');
  if (d.composer.hidden === open) d.composer.hidden = !open;
  d.composer.setMode(st === 'waiting');
  d.reply.hidden = open;
  setText(d.reply, st === 'waiting' ? 'REPLY' : 'SEND MESSAGE');
  setClass(d.reply, 'btn' + (st === 'waiting' ? ' primary' : ''));
  setClass(d.actions, 'actions' + (open ? ' one' : ''));
  const task = s.taskId && state.tasks?.find((t) => t.id === s.taskId);
  d.taskId = task && (task.status === 'starting' || task.status === 'running') ? task.id : null;
  d.stop.hidden = !d.taskId;
}

function composer(sessionId, onCancel) {
  const name = () => index.get(sessionId)?.session.name || 'the agent';
  const ta = el('textarea', { rows: 3, placeholder: 'Message ' + name() + '…', attrs: { 'aria-label': 'Message to ' + name() } });
  const note = el('div', { class: 'note', text: 'Resumes this session with your message. Ctrl/Cmd+Enter sends.' });
  const send = el('button', { class: 'btn primary', type: 'button', text: 'SEND' });
  const root = el('div', { class: 'composer' });
  const go = async () => {
    const text = ta.value.trim();
    if (!text) { note.className = 'note err'; note.textContent = 'Write a message first.'; ta.focus(); return; }
    send.disabled = true;
    const r = await feed.message(sessionId, text);
    send.disabled = false;
    if (r.ok) { ta.value = ''; note.className = 'note ok'; note.textContent = 'Sent. ' + name() + ' is picking it up.'; toast('MESSAGE SENT TO ' + name()); }
    else { note.className = 'note err'; note.textContent = r.error || 'Could not send.'; }
  };
  send.addEventListener('click', go);
  ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) go(); });
  root.append(ta, el('div', { class: 'actions' }, el('button', { class: 'btn ghost', type: 'button', text: 'CANCEL', on: { click: () => { root.hidden = true; onCancel?.(); } } }), send), note);
  let mode = null;
  root.setMode = (waiting) => {
    if (mode === waiting) return;
    mode = waiting;
    ta.placeholder = (waiting ? 'Reply to ' : 'Message ') + name() + '…';
    send.textContent = waiting ? 'SEND REPLY' : 'SEND';
  };
  return root;
}

setInterval(() => {
  if (!portrait || !portrait.canvas.isConnected) return;
  drawPortrait(portrait.canvas, portrait.look, { ...portrait.opts, blink: Math.random() < 0.08 });
}, 220);

/* ---------------------------------------------------------------- tooltip */
function showTip(hit, x, y) {
  if (!hit) { tip.hidden = true; return; }
  let n, d;
  if (hit.type === 'reception') { n = [el('span', { text: 'FRONT DESK' })]; d = 'Start a new task'; }
  else {
    const f = index.get(hit.id);
    if (!f) { tip.hidden = true; return; }
    const { session: s, sub } = f;
    if (sub) { n = [el('span', { text: sub.name || sub.id }), el('span', { class: 'lbl', text: 'CREW OF ' + (s.name || '?') })]; d = [sub.label, sub.status === 'working' ? sub.activity?.label : STATUS_LABEL[sub.status]].filter(Boolean).join(' · '); }
    else { n = [el('span', { text: s.name || '?' }), badge(s.tool), s.status === 'waiting' ? el('span', { style: 'color:var(--hot)', text: 'NEEDS YOU' }) : null]; d = [s.project, s.status === 'idle' ? 'On a break' : s.activity?.label].filter(Boolean).join(' · '); }
  }
  tip.replaceChildren(el('div', { class: 'n' }, n), el('div', { class: 'd', text: d }));
  tip.hidden = false;
  const m = $('map').getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(4, Math.min(m.width - w - 4, x + 14)) + 'px';
  tip.style.top = Math.max(4, y - h - 12 < 4 ? y + 18 : y - h - 12) + 'px';
}

let toastT = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ------------------------------------------------------------------ modal */
let lastFocus = null;
function openModal(dlg) {
  lastFocus = document.activeElement;
  modal.replaceChildren(dlg);
  modal.hidden = false;
}
function closeModal() {
  if (modal.hidden) return false;
  modal.hidden = true;
  modal.replaceChildren();
  lastFocus?.focus?.();
  return true;
}
modal.addEventListener('mousedown', (ev) => { if (ev.target === modal) closeModal(); });

async function openTranscript(s) {
  const tool = toolOf(s.tool);
  const list = el('div', { class: 'msgs', text: 'Loading…' });
  const load = async () => {
    const msgs = await feed.transcript(s.id, 60);
    if (!msgs.length) { list.textContent = 'No transcript yet.'; return; }
    list.replaceChildren(...msgs.map((m) => el('div', { class: 'msg ' + m.role + ' tool-' + tool.id },
      el('span', { class: 'r', text: m.role === 'user' ? 'YOU' : m.role === 'assistant' ? s.name || 'AGENT' : '>' }),
      el('span', { class: 'x', text: m.text || '' }))));
    const bodyEl = list.parentElement;
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  };
  const close = el('button', { class: 'btn small', type: 'button', text: 'CLOSE', on: { click: closeModal } });
  openModal(el('div', { class: 'dlg', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Transcript' } },
    el('header', null, el('span', { style: 'display:flex;gap:8px;align-items:center' }, badge(s.tool), el('span', { text: (s.name || 'AGENT') + ' · TRANSCRIPT' })), close),
    el('div', { class: 'body' }, el('div', { class: 'lbl', text: s.title || '' }), list),
    el('footer', null, el('span', { class: 'note', text: 'Last 60 lines' }), el('button', { class: 'btn small ghost', type: 'button', text: 'REFRESH', on: { click: load } }))));
  close.focus();
  await load();
}

function openNewTask() {
  if (!state) return;
  const avail = (t) => state.tools?.[t]?.available !== false;
  const sel = index.get(selected)?.session;
  const form = { tool: Object.keys(TOOLS).find(avail) || 'claude', cwd: sel?.cwd || state.recentDirs?.[0] || '', permission: 'edit' };
  if (sel && avail(sel.tool)) form.tool = sel.tool;

  const toolBtns = Object.values(TOOLS).map((t) => el('button', { type: 'button', class: 'tool-' + t.id, disabled: !avail(t.id), title: avail(t.id) ? t.label : t.label + ' is not installed', on: { click: () => { form.tool = t.id; sync(); } } }, el('span', { text: t.badge }), el('span', { text: t.label })));
  const PERMS = [['read', 'READ ONLY'], ['edit', 'EDIT FILES'], ['full', 'FULL AUTO']];
  const permBtns = PERMS.map(([id, label]) => el('button', { type: 'button', class: id === 'full' ? 'danger' : '', text: label, on: { click: () => { form.permission = id; sync(); } } }));
  const warn = el('div', { class: 'warn', text: 'FULL AUTO runs every command and edit without asking you first. Only use it in a folder you can afford to lose.' });
  const permNote = el('div', { class: 'note' });
  const cwd = el('input', { type: 'text', value: form.cwd, placeholder: '/path/to/project', spellcheck: false, attrs: { autocomplete: 'off' } });
  const dirs = el('div', { class: 'dirs' }, (state.recentDirs || []).slice(0, 8).map((d) => el('button', { type: 'button', title: d, text: d.split('/').filter(Boolean).pop() || d, on: { click: () => { cwd.value = d; } } })));
  const prompt = el('textarea', { rows: 4, placeholder: 'What should the agent do?' });
  const note = el('div', { class: 'note' });
  const start = el('button', { class: 'btn primary', type: 'button', text: 'START >' });
  function sync() {
    toolBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(TOOLS)[i] === form.tool)));
    permBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(PERMS[i][0] === form.permission)));
    warn.hidden = form.permission !== 'full';
    permNote.hidden = form.permission === 'full';
    permNote.textContent = form.permission === 'read' ? 'Can read and plan; changes nothing.' : 'May edit files in the folder; no unrestricted shell.';
  }
  async function go() {
    if (!prompt.value.trim()) { note.className = 'note err'; note.textContent = 'Write a prompt first.'; prompt.focus(); return; }
    start.disabled = true; note.className = 'note'; note.textContent = 'Starting…';
    const r = await feed.launch({ tool: form.tool, prompt: prompt.value.trim(), cwd: cwd.value.trim(), permission: form.permission });
    start.disabled = false;
    if (!r.ok) { note.className = 'note err'; note.textContent = r.error || 'Could not start.'; return; }
    pending = { taskId: r.task?.id, sessionId: r.task?.sessionId, at: Date.now() };
    closeModal();
    toast('TASK STARTED · WATCH THE FRONT DOOR');
  }
  start.addEventListener('click', go);
  prompt.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) go(); });
  sync();
  openModal(el('div', { class: 'dlg', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New task' } },
    el('header', null, el('span', { text: 'FRONT DESK · NEW TASK' }), el('button', { class: 'btn small', type: 'button', text: 'X', attrs: { 'aria-label': 'Close' }, on: { click: closeModal } })),
    el('div', { class: 'body' },
      field('WHO', el('div', { class: 'seg tools' }, toolBtns)),
      field('WHERE', cwd, dirs),
      field('MAY IT CHANGE THINGS?', el('div', { class: 'seg' }, permBtns), permNote, warn),
      field('WHAT', prompt)),
    el('footer', null, note, el('button', { class: 'btn ghost', type: 'button', text: 'CANCEL', on: { click: closeModal } }), start)));
  prompt.focus();
}

$('newtask').addEventListener('click', openNewTask);
$('alert').addEventListener('click', nextWaiting);

addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (closeModal()) return;
    // first Esc leaves a box you are typing in, the next one goes back to the office
    const c = detail?.composer;
    if (c && !c.hidden && c.contains(document.activeElement)) { document.activeElement.blur(); if (detail.compose === 'open') { detail.compose = 'closed'; render(); } }
    else select(null);
    return;
  }
  if (!modal.hidden || ev.target.closest?.('input, textarea') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'n' || ev.key === 'N') { ev.preventDefault(); openNewTask(); }
  else if (ev.key === ' ' && !ev.target.closest?.('button')) { ev.preventDefault(); nextWaiting(); }
});

// When embedded in an iframe that is larger than the part of it you can actually see (a host page that
// overflows its own viewport), keep the app inside the visible part so the inspector is never clipped.
function fitVisible() {
  let w = '', h = '';
  try {
    const fe = window.frameElement;
    if (fe && window.parent !== window) {
      const r = fe.getBoundingClientRect();
      const vw = Math.floor(window.parent.innerWidth - r.left), vh = Math.floor(window.parent.innerHeight - r.top);
      if (vw > 320 && vw < innerWidth) w = vw + 'px';
      if (vh > 240 && vh < innerHeight) h = vh + 'px';
    }
  } catch { /* cross-origin parent: nothing to do */ }
  const app = $('app');
  if (app.style.width !== w) app.style.width = w;
  if (app.style.height !== h) app.style.height = h;
}
fitVisible();
addEventListener('resize', fitVisible);
try { if (window.parent !== window) window.parent.addEventListener('resize', fitVisible); } catch { /* ignore */ }

// Connect last: the mock feed delivers its first state synchronously.
feed = connectFeed({ onState, onMode });
onMode(feed.mode);
// Dev handle for poking at the prototype from the console (e.g. __floorplan.push(state)).
window.__floorplan = { world, feed, push: onState, get state() { return state; } };
