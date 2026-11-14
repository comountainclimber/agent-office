// Agent Office — app shell. Owns everything in the browser except the canvas world.
// State flows one way: api -> onState -> render(); every component updates its DOM in place.
import { createApi } from './api.js';
import { h, setText, setHidden, setClass, isTypingTarget, TOOL_INFO, oneLine, store, needRank, crewWords } from './ui/dom.js';
import { initModals, modalOpen, closeTopModal } from './ui/modal.js';
import { initToasts, toast, createNeedToast } from './ui/toast.js';
import { createEventLog, createLogFilterToggle } from './ui/events.js';
import { createTopbar } from './ui/topbar.js';
import { createRoster, suggestGroup } from './ui/roster.js';
import { createDialogue, failedTaskFor } from './ui/dialogue.js';
import { createTasks } from './ui/tasks.js';
import { createTaskOutput } from './ui/taskout.js';
import { failureReason } from './ui/failure.js';
import { createTranscript } from './ui/transcript.js';
import { openNewTask, loginHint, copyText, rememberModel, forgetModel, storePrefix } from './ui/newtask.js';
import { openSendMessage } from './ui/sendmsg.js';
import { toggleHelp } from './ui/help.js';
import { drawFallbackPortrait } from './ui/portrait.js';
import { createSound, SOUND_LEVEL_LABEL } from './ui/sound.js';
import { openGroupMenu, openGroupEditor, autoGroupFor } from './ui/groupui.js';
import { taskName } from './groups.js';

const params = new URLSearchParams(location.search);
const IS_MOCK = params.has('mock') && params.get('mock') !== '0';

const api = createApi({ mock: IS_MOCK });
const log = createEventLog(200);
const sound = createSound();

const app = {
  /** @type {any} */ state: null,
  conn: { status: 'connecting' },
  selectedId: /** @type {string|null} */ (null),
  world: /** @type {any} */ (null),
  worldMod: /** @type {any} */ (null),
  worldFailed: false,
  offset: 0, // server clock - local clock
  meta: /** @type {any} */ (null),
  metaPromise: /** @type {Promise<any>|null} */ (null),
  pending: /** @type {{taskId:string, until:number}|null} */ (null),
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  newTaskModal: /** @type {any} */ (null),
  sendModal: /** @type {any} */ (null),
  groupFilter: /** @type {string|null} */ (null), // the spotlighted group: chips, roster and office all follow it
  groupEditor: /** @type {any} */ (null),
  sentModels: new Map(), // task id -> model typed in NEW TASK (the Task itself does not carry it)
  modelSeen: new Set(), // task ids whose model has been remembered / forgotten already
};

// what the demo remembers stays apart from what real use remembers
const STORE = storePrefix(IS_MOCK);

const now = () => Date.now() + app.offset;
const safe = (fn) => { try { return fn(); } catch (e) { console.warn('[office] world call failed', e); return undefined; } };
const isLiveTask = (t) => t.status === 'starting' || t.status === 'running';

// ------------------------------------------------------------------------------------------------
// selection
// ------------------------------------------------------------------------------------------------

function resolve(id, state = app.state) {
  if (!id || !state) return null;
  for (const s of state.sessions) {
    if (s.id === id) return { id, session: s, sub: null };
  }
  for (const s of state.sessions) {
    if (id.startsWith(s.id + '#')) {
      const subId = id.slice(s.id.length + 1);
      const sub = (s.subagents || []).find((x) => x.id === subId);
      if (sub) return { id, session: s, sub };
    }
  }
  return null;
}

function parentIdOf(id, state = app.state) {
  if (!id || !state) return null;
  const s = state.sessions.find((x) => id.startsWith(x.id + '#'));
  return s ? s.id : null;
}

// ---- "unanswered": still waiting on you after the server stopped saying so -------------------------
// The server calls an agent 'waiting' for five minutes after its turn ended; after that it is 'idle' and
// walks to the break room. It is still waiting on the human, so the shell marks it `unanswered` (see
// server/contract.mjs) until the user has looked at it: selecting an agent acknowledges it, remembered as
// session id -> the lastActivityAt that was acknowledged. Newer activity makes it count again.
const ACK_KEY = `${STORE}ack`;
/** @type {Map<string, number>} */
let acks = new Map();
try { acks = new Map(Object.entries(JSON.parse(store.get(ACK_KEY, '{}') || '{}')).filter(([, v]) => Number.isFinite(v))); } catch { acks = new Map(); }
const saveAcks = () => store.set(ACK_KEY, JSON.stringify(Object.fromEntries(acks)));
const isUnanswered = (s) => s.status === 'idle' && s.turnState === 'ended' && !((acks.get(s.id) || 0) >= (s.lastActivityAt || 0));

// ---- "answered": you just replied -------------------------------------------------------------------
// The reply field (dialogue / transcript) dispatches `ao:replied` { sessionId, at } after a successful send
// (and once more with `at: 0` if that reply's run fails: the optimistic state is taken back at once).
// Until that session's lastActivityAt moves past `at`, or 30 s have gone by, the chrome treats it as answered:
// `session.answered = true`, which ui/dom.js effStatus() / needRank() turn into "not needs-you, not unanswered"
// for the top bar, the roster, the tab title, the call-out and the sound. The server's own status is untouched.
const REPLIED_MS = 30_000;
/** @type {Map<string, {at:number, until:number}>} */
const replied = new Map();
let repliedTimer = 0;
function markAnswered(state) {
  if (!state || !Array.isArray(state.sessions)) return;
  for (const s of state.sessions) {
    const r = replied.get(s.id);
    const on = !!r && Date.now() < r.until && !((s.lastActivityAt || 0) > r.at);
    if (r && !on) replied.delete(s.id);
    if (on) { s.answered = true; s.unanswered = false; } else if (s.answered) delete s.answered;
  }
}
window.addEventListener('ao:replied', (e) => {
  const d = (e && e.detail) || {};
  if (!d.sessionId) return;
  if (d.at === 0) {
    // "take it back": that reply's run failed, so the agent still needs you
    replied.delete(d.sessionId);
  } else {
    replied.set(d.sessionId, { at: Number.isFinite(d.at) ? d.at : Date.now(), until: Date.now() + REPLIED_MS });
    needPending.delete(d.sessionId);
    needAway.delete(d.sessionId);
  }
  if (app.state) { markUnanswered(app.state); announceNeeds(null, app.state); render(); }
  clearTimeout(repliedTimer); // if nothing else changes, it counts again when the 30 s are up
  repliedTimer = setTimeout(() => { if (app.state) { markUnanswered(app.state); announceNeeds(null, app.state); render(); } }, REPLIED_MS + 50);
});

/**
 * Add the shell's own flags to every session of a fresh snapshot (before the world and the UI see it):
 * `unanswered`, `answered`, and activity lines worded the office's way ("crew" for subagents, everywhere).
 */
function markUnanswered(state) {
  if (!state || !Array.isArray(state.sessions)) return state;
  for (const s of state.sessions) {
    s.unanswered = isUnanswered(s);
    if (s.activity && s.activity.label) s.activity.label = crewWords(s.activity.label, s.activity.kind);
    for (const sub of s.subagents || []) if (sub.activity && sub.activity.label) sub.activity.label = crewWords(sub.activity.label, sub.activity.kind);
  }
  markAnswered(state);
  // forget acknowledgements for sessions that are gone
  if (acks.size) {
    const ids = new Set(state.sessions.map((s) => s.id));
    let pruned = false;
    for (const id of [...acks.keys()]) if (!ids.has(id)) { acks.delete(id); pruned = true; }
    if (pruned) saveAcks();
  }
  return state;
}

/** The user looked at this agent. Returns true when that cleared its `unanswered` flag. */
function acknowledge(session) {
  if (!session) return false;
  const at = session.lastActivityAt || 0;
  if ((acks.get(session.id) || 0) < at) { acks.set(session.id, at); saveAcks(); }
  if (!session.unanswered) return false;
  session.unanswered = false;
  if (app.world && app.state) safe(() => app.world.setState(app.state)); // its quiet "!" goes now, not at the next snapshot
  return true;
}

const freshWaiting = (state = app.state) => (state ? state.sessions.filter((s) => needRank(s) === 0) : []);
const olderWaiting = (state = app.state) => (state ? state.sessions.filter((s) => needRank(s) === 1) : []);

function select(id, { pan = true, reveal = true } = {}) {
  id = id || null;
  if (id && !resolve(id)) return;
  const changed = id !== app.selectedId;
  app.selectedId = id;
  // picking someone outside the spotlighted group ends the spotlight (they would be hidden in the roster)
  const picked = id ? resolve(id) : null;
  if (picked && app.groupFilter && picked.session.groupId !== app.groupFilter) setGroupFilter(null, { silent: true });
  const cleared = picked && !picked.sub ? acknowledge(picked.session) : false;
  if (pan && app.world) safe(() => app.world.select(id));
  if (!changed) { if (cleared) render(); return; }
  if (!id && transcript.isOpen()) transcript.close(); // nobody selected, nothing to read along with
  render();
  if (reveal) roster.reveal(id);
  const sel = resolve(id);
  if (sel && transcript.isOpen() && transcript.current() !== sel.session.id) transcript.open(sel.session.id);
}

function selectedSession() {
  const sel = resolve(app.selectedId);
  return sel ? sel.session : null;
}

function cycle(dir) {
  if (!app.state || !app.state.sessions.length) return;
  const pool = app.groupFilter ? app.state.sessions.filter((s) => s.groupId === app.groupFilter) : app.state.sessions;
  if (!pool.length) return;
  const order = roster.order(pool, app.state.groups || []);
  const cur = selectedSession();
  let i = cur ? order.findIndex((s) => s.id === cur.id) : -1;
  i = i === -1 ? (dir > 0 ? 0 : order.length - 1) : (i + dir + order.length) % order.length;
  const followFocus = focusIsLoose();
  select(order[i].id);
  if (followFocus) focusSelection();
}

/** Is the keyboard nowhere in particular (the page, the office, the roster's list)? Then it may follow the selection. */
function focusIsLoose() {
  const a = document.activeElement;
  return !a || a === document.body || a === canvas || roster.hasFocus() || !!(a.closest && a.closest('[hidden]'));
}

/** Put the keyboard on the selected agent's roster row; on the office when the roster is shut or nobody is selected. */
function focusSelection(id = app.selectedId) {
  if (isTypingTarget(document.activeElement)) return; // a reply field took the caret: leave it there
  if (id && (roster.focusRow(id) || (parentIdOf(id) && roster.focusRow(parentIdOf(id))))) return;
  try { canvas.focus({ preventScroll: true }); } catch { /* ignore */ }
}

// Y (and the NEEDS YOU button): fresh waiting agents first, in roster order, then the older ones. Visiting an
// older one acknowledges it, so it drops out of the list: `needRound` remembers who was visited this lap.
const needRound = new Set();
// dir -1 (Alt+Shift+Y) walks the same list backwards from the selected agent.
function cycleNeedsYou({ olderFirst = false, dir = 1 } = {}) {
  if (!app.state) return;
  const ordered = roster.order(app.state.sessions, app.state.groups || []);
  const fresh = ordered.filter((s) => needRank(s) === 0);
  const older = ordered.filter((s) => needRank(s) === 1);
  const list = olderFirst ? [...older, ...fresh] : [...fresh, ...older];
  if (!list.length) { toast('ALL CLEAR', { detail: 'Nobody is waiting for you.' }); return; }
  const cur = selectedSession();
  let pick;
  if (dir < 0) {
    const i = cur ? list.findIndex((s) => s.id === cur.id) : -1;
    pick = list[(i <= 0 ? list.length : i) - 1];
  } else {
    pick = list.find((s) => !needRound.has(s.id) && !(cur && s.id === cur.id));
    if (!pick) { needRound.clear(); pick = list.find((s) => !(cur && s.id === cur.id)) || list[0]; }
  }
  needRound.add(pick.id);
  needToast.clear();
  const followFocus = focusIsLoose();
  select(pick.id);
  if (!focusReply() && followFocus) focusSelection(); // who needs you -> type -> Enter
}

/** Put the caret in the reply field of the selected agent: in the transcript when that is open, else in the dialogue. */
function focusReply() {
  if (modalOpen()) return false;
  return (transcript.isOpen() && transcript.focusComposer()) || dialogue.focusComposer();
}

// ------------------------------------------------------------------------------------------------
// tasks <-> sessions
// ------------------------------------------------------------------------------------------------

function sessionForTask(task, state = app.state) {
  if (!task || !state) return null;
  return state.sessions.find((s) => s.id === task.sessionId || (s.taskId && s.taskId === task.id) || s.id === task.resumeOf) || null;
}

function runningTaskFor(session, state = app.state) {
  if (!session || !state || !state.tasks) return null;
  const t = state.tasks.find((x) => isLiveTask(x) && (x.id === session.taskId || x.sessionId === session.id || x.resumeOf === session.id));
  return t ? t.id : null;
}

async function stopTask(taskId) {
  try {
    await api.stopTask(taskId);
    toast('STOPPED!', { kind: 'pow' });
    return true;
  } catch (e) {
    toast("COULDN'T STOP IT", { kind: 'error', detail: e && e.message ? e.message : String(e) });
    return false;
  }
}

function loadMeta() {
  if (!app.metaPromise) {
    app.metaPromise = api.getMeta().then((m) => { app.meta = m || {}; return app.meta; }).catch(() => ({}));
  }
  return app.metaPromise;
}

// ------------------------------------------------------------------------------------------------
// names and groups
// ------------------------------------------------------------------------------------------------

/** Show a change at once; the next snapshot from the server confirms (or corrects) it. */
function patchState(fn) {
  if (!app.state) return;
  const next = { ...app.state, sessions: app.state.sessions.map((s) => ({ ...s })), groups: (app.state.groups || []).map((g) => ({ ...g })) };
  fn(next);
  next.groups.sort((a, b) => a.order - b.order);
  app.state = next;
  if (app.world) safe(() => app.world.setState(next));
  render();
}

const groupsNow = () => (app.state && app.state.groups) || [];
const groupById = (id) => groupsNow().find((g) => g.id === id) || null;

const groupOps = {
  /** label '' clears the name (back to the tool's own title). */
  async rename(sessionId, label) {
    await api.setSessionMeta(sessionId, { label: label || null });
    patchState((st) => {
      const s = st.sessions.find((x) => x.id === sessionId);
      if (!s) return;
      if (label) s.label = label; else delete s.label;
    });
  },
  /** groupId: a group id, or null for "no group" (pinned when a folder rule would otherwise pull it back in). */
  async assign(ids, groupId) {
    const sessions = app.state ? app.state.sessions : [];
    await Promise.all(ids.map((id) => {
      const s = sessions.find((x) => x.id === id);
      const value = groupId || (s && autoGroupFor(groupsNow(), s.cwd) ? 'none' : null);
      return api.setSessionMeta(id, { groupId: value });
    }));
    patchState((st) => {
      for (const s of st.sessions) {
        if (!ids.includes(s.id)) continue;
        if (groupId) s.groupId = groupId; else delete s.groupId;
      }
    });
  },
  async create({ name, autoDirs, color } = {}) {
    const group = await api.createGroup({ name, ...(color ? { color } : {}), ...(autoDirs && autoDirs.length ? { autoDirs } : {}) });
    if (!group || !group.id) throw new Error('The server did not return the new group.');
    patchState((st) => {
      if (!st.groups.some((g) => g.id === group.id)) st.groups.push({ ...group });
      for (const s of st.sessions) {
        if (!s.groupId && (group.autoDirs || []).some((d) => s.cwd === d || String(s.cwd).startsWith(d.replace(/\/$/, '') + '/'))) s.groupId = group.id;
      }
    });
    return group;
  },
  async update(id, patch) {
    const group = await api.updateGroup(id, patch);
    patchState((st) => {
      const i = st.groups.findIndex((g) => g.id === id);
      if (i >= 0) st.groups[i] = { ...st.groups[i], ...patch, ...(group || {}) };
    });
    return group;
  },
  async remove(id) {
    await api.deleteGroup(id);
    if (app.groupFilter === id) setGroupFilter(null, { silent: true });
    patchState((st) => {
      st.groups = st.groups.filter((g) => g.id !== id);
      for (const s of st.sessions) if (s.groupId === id) delete s.groupId;
    });
  },
  /** dir: -1 earlier, +1 later. Orders are renumbered 1..n so two groups never share one. */
  async reorder(id, dir) {
    const list = [...groupsNow()];
    const i = list.findIndex((g) => g.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    for (let k = 0; k < list.length; k++) {
      if (list[k].order !== k + 1) await groupOps.update(list[k].id, { order: k + 1 });
    }
  },
};

function setGroupFilter(id, { silent = false } = {}) {
  id = id && groupById(id) ? id : null;
  if (id === app.groupFilter) return;
  app.groupFilter = id;
  if (app.world && typeof app.world.highlightGroup === 'function') safe(() => app.world.highlightGroup(id));
  if (!silent) render();
}

function toggleGroup(id) {
  setGroupFilter(app.groupFilter === id ? null : id);
}

function groupCounts() {
  const counts = new Map();
  for (const s of app.state ? app.state.sessions : []) if (s.groupId) counts.set(s.groupId, (counts.get(s.groupId) || 0) + 1);
  return counts;
}

function openGroupEditorFor(groupId) {
  if (!groupById(groupId)) return;
  if (app.groupEditor && app.groupEditor.isOpen()) app.groupEditor.close();
  app.groupEditor = openGroupEditor({ groupId, getState: () => app.state, actions: { update: groupOps.update, remove: groupOps.remove, reorder: groupOps.reorder } });
}
const editAfterMenu = (g) => setTimeout(() => openGroupEditorFor(g.id), 0); // let the menu close and hand focus back first

/** The roster's one-click suggestion. Rejects on failure: the roster shows the reason right under the button. */
async function applySuggestion(sug) {
  const g = await groupOps.create({ name: sug.name, autoDirs: [sug.dir] });
  toast('GROUPED!', { kind: 'pow', detail: `${sug.count} in ${g.name} · new ones join` });
}

/** G on the selected agent, or a click on its group button. */
function openGroupMenuFor(session, anchor) {
  if (modalOpen() || !session) return;
  const sug = !session.groupId ? suggestGroup(app.state, new Set(), session.cwd) : null;
  openGroupMenu({
    anchor,
    heading: `GROUP FOR ${session.name}`,
    groups: groupsNow(),
    counts: groupCounts(),
    currentId: session.groupId || null,
    onPick: (id) => groupOps.assign([session.id], id),
    onCreate: async (name) => {
      const g = await groupOps.create({ name });
      await groupOps.assign([session.id], g.id);
    },
    onEdit: editAfterMenu,
    suggestion: sug ? { label: `GROUP ALL ${sug.count} IN ${sug.name}`, run: async () => { await groupOps.create({ name: sug.name, autoDirs: [sug.dir] }); } } : null,
  });
}

/** Ticked rows in the roster -> one group. */
function openBulkGroupMenu(anchor, ids, done) {
  if (modalOpen() || !ids.length) return;
  const finish = (g) => {
    done();
    // the menu's button is gone with the selection: the keyboard goes to the first agent that was moved
    setTimeout(() => { if (!modalOpen() && focusIsLoose()) roster.focusRow(ids[0]); }, 0);
    toast('GROUPED!', { kind: 'pow', detail: g ? `${ids.length} agent${ids.length === 1 ? '' : 's'} in ${g.name}.` : `${ids.length} agent${ids.length === 1 ? '' : 's'} taken out of their group.` });
  };
  openGroupMenu({
    anchor,
    heading: `GROUP ${ids.length} AGENT${ids.length === 1 ? '' : 'S'}`,
    groups: groupsNow(),
    counts: groupCounts(),
    onPick: async (id) => { await groupOps.assign(ids, id); finish(id ? groupById(id) : null); },
    onCreate: async (name) => {
      const g = await groupOps.create({ name });
      await groupOps.assign(ids, g.id);
      finish(g);
    },
  });
}

/** The GROUPS menu in the top bar: spotlight one, make one, edit one (plus whatever the bar had no room for). */
function openGroupsMenu(anchor, infoLines = []) {
  if (modalOpen()) return;
  openGroupMenu({
    anchor,
    heading: 'GROUPS',
    groups: groupsNow(),
    counts: groupCounts(),
    currentId: app.groupFilter,
    noneLabel: 'SHOW EVERYONE',
    hint: groupsNow().length ? '1-9 spotlight · 0 everyone · type to add a new group' : 'Type a name, then press Enter',
    onPick: (id) => setGroupFilter(id),
    onCreate: async (name) => { const g = await groupOps.create({ name }); editAfterMenu(g); },
    onEdit: editAfterMenu,
    infoLines,
  });
}

// ------------------------------------------------------------------------------------------------
// components
// ------------------------------------------------------------------------------------------------

const ui = document.getElementById('ui');
const stage = document.getElementById('stage');
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('office'));
initModals(document.getElementById('modals'));
initToasts(document.getElementById('toasts'));
const needToast = createNeedToast({ onNext: () => visitPendingNeed() });
canvas.tabIndex = -1; // focusable from code only: where the keyboard goes when the dialogue closes and the roster is shut

function openNewTaskModal(seed) {
  if (app.newTaskModal && app.newTaskModal.isOpen()) return;
  if (modalOpen()) return;
  const cur = selectedSession();
  app.newTaskModal = openNewTask({
    api,
    meta: app.meta,
    loadMeta,
    getState: () => app.state,
    seed: seed || (cur ? { hintCwd: cur.cwd } : {}), // a hint, not a default: see pickDefaultCwd() in ui/newtask.js
    defaultGroupId: app.groupFilter,
    createGroup: (name) => groupOps.create({ name }),
    onStarted(task, body) {
      toast('NEW HIRE!', { kind: 'pow', detail: `${TOOL_INFO[body.tool]?.label || body.tool} is on the way in.` });
      if (task && task.id) {
        app.sentModels.set(task.id, body.model || ''); // '' = the CLI's default, which is worth remembering too
        app.pending = { taskId: task.id, until: Date.now() + 120_000 };
        tasks.open();
      }
    },
  });
}

/** RETRY on a failed task: the same menu, filled in the same way, with the reason it failed next to the model. */
function retryTask(task) {
  if (!task || modalOpen()) return;
  const s = task.resumeOf && app.state ? app.state.sessions.find((x) => x.id === task.resumeOf) : null;
  if (s) { openSendModal(s.id, { prompt: task.prompt, permission: task.permission }); return; }
  const why = task.status === 'failed' ? failureReason(task, { max: 2 }) : null;
  openNewTaskModal({
    tool: task.tool, cwd: task.cwd, prompt: task.prompt, permission: task.permission,
    model: task.model != null ? task.model : app.sentModels.get(task.id) || '',
    ...(task.label ? { label: task.label } : {}),
    ...(task.groupId ? { groupId: task.groupId } : {}),
    ...(why && !why.signedOut ? { failure: { text: why.lines.join(' '), aboutModel: why.aboutModel } } : {}),
  });
}

const taskById = (id) => (app.state && app.state.tasks ? app.state.tasks.find((t) => t.id === id) || null : null);

/** The full output of a task, in the right-hand slide-over (the transcript's slot: one of the two at a time). */
function openTaskOutput(taskId) {
  if (!taskById(taskId)) return false;
  if (transcript.isOpen()) transcript.close();
  return taskOut.open(taskId);
}

/** A window too small for the dialogue to hold a reply field comfortably falls back to the modal. */
const replyNeedsModal = () => window.innerHeight < 520 || window.innerWidth < 760;

/** Reply to / message a session: select it and put the caret (and any seed text) in its reply field. */
function openSendModal(sessionId, seed) {
  if (modalOpen()) return;
  const s = app.state && app.state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  if (!replyNeedsModal()) {
    if (app.selectedId !== s.id) select(s.id);
    if (seed && (seed.prompt || seed.permission)) dialogue.compose(seed);
    if (focusReply()) return;
  }
  app.sendModal = openSendMessage({
    seed,
    api,
    meta: app.meta,
    loadMeta,
    getSession: (id) => (app.state ? app.state.sessions.find((x) => x.id === id) || null : null),
    onSent(task, session) {
      toast('MESSAGE SENT!', { kind: 'pow', detail: `${session.name} is picking it up. Watch TASKS.` });
      tasks.open();
    },
  }, s);
}

function openTranscriptFor(sessionId) {
  if (!sessionId) return;
  transcript.open(sessionId);
}

function toggleTranscriptFor(sessionId) {
  if (transcript.isOpen() && transcript.current() === sessionId) transcript.close();
  else openTranscriptFor(sessionId);
}

const sessionById = (id) => (app.state ? app.state.sessions.find((s) => s.id === id) || null : null);

/** A reply went out from the dialogue or the transcript: the field itself says SENT, the run shows up in TASKS. */
function onReplySent(task) {
  if (task && task.id && roster.isOpen()) tasks.open(); // only when the tray is already on screen: nothing may move under the reply
}

// What the reply field needs for its NEXT button (and the Alt+Y chord): who else needs you, and the way there.
const replyNav = {
  waitingOthers: (id) => (app.state ? app.state.sessions.filter((s) => s.id !== id && needRank(s) < 2).length : 0),
  nextWaiting: (dir = 1) => cycleNeedsYou({ dir }),
};

const topbar = createTopbar({
  sound,
  cycleNeedsYou,
  openNewTask: () => openNewTaskModal(),
  openHelp: () => toggleHelp(),
  toggleGroup,
  editGroup: openGroupEditorFor,
  openGroupsMenu,
});

const roster = createRoster({
  select: (id) => select(id),
  onLayout: () => layout(),
  toggleGroup,
  editGroup: openGroupEditorFor,
  bulkGroup: openBulkGroupMenu,
  applySuggestion,
});

const dialogue = createDialogue({
  log,
  rename: (id, label) => groupOps.rename(id, label),
  openGroupMenu: openGroupMenuFor,
  groupById,
  onMode: () => layout(),
  select: (id) => select(id),
  selectIfPresent: (id) => {
    if (resolve(id)) select(id);
    else if (parentIdOf(id)) select(parentIdOf(id));
    else toast('GONE HOME', { detail: 'That agent is no longer in the office.' });
  },
  openTranscript: openTranscriptFor,
  toggleTranscript: toggleTranscriptFor,
  api,
  loadMeta,
  getSession: sessionById,
  onSent: onReplySent,
  ...replyNav,
  onLayout: () => layout(),
  retryTask: (task) => retryTask(task),
  stopTask,
  runningTaskFor,
  portraitSource: () => (app.worldMod && typeof app.worldMod.drawPortrait === 'function' ? 'world' : 'fallback'),
  drawPortrait(cv, session, sub) {
    const fn = app.worldMod && app.worldMod.drawPortrait;
    if (typeof fn === 'function') {
      try { fn(cv, session, sub); return; } catch (e) { console.warn('[office] drawPortrait failed, using the stand-in', e); }
    }
    drawFallbackPortrait(cv, session, sub);
  },
});

const tasks = createTasks({
  storePrefix: STORE,
  rosterOpen: () => roster.isOpen(),
  stopTask,
  retry: retryTask,
  openOutput: openTaskOutput,
  onCount: (live, total, failed) => roster.setTasks(live, failed),
  sessionForTask,
  findTask(task) {
    const s = sessionForTask(task);
    if (s) select(s.id);
    else toast('NOT IN YET', { detail: 'That agent has not shown up in the office.' });
  },
});

const transcript = createTranscript({
  api,
  sessionById,
  loadMeta,
  onSent: onReplySent,
  ...replyNav,
  isFailed: (s) => { const t = failedTaskFor(s, app.state); return t ? (t.resumeOf ? 'reply' : 'task') : false; },
  onLayout: () => layout(),
});

// notices: connection banner (the demo marker sits in the top bar) ------------------------------------
// connection lost while we still have a picture: a strip under the top bar, everything else moves down a row
const bannerText = h('span', { class: 'banner-text' });
const bannerRetry = h('button', { class: 'btn btn-mini', type: 'button', text: 'RETRY NOW', on: { click: () => api.retryNow() } });
const banner = h('div', { id: 'banner', hidden: true, attrs: { role: 'alert' } }, h('span', { class: 'banner-tag', text: 'NO SIGNAL' }), bannerText, bannerRetry);

const taskOut = createTaskOutput({
  taskById,
  sessionForTask,
  retry: retryTask,
  stop: stopTask,
  find: (task) => { const s = sessionForTask(task); if (s) select(s.id); },
  copy: copyText,
  onLayout: () => layout(),
});

// Anyone (the dialogue, a toast) can ask for these without importing the shell:
//   ao:retry-task        { taskId }  open NEW TASK (or the reply field) pre-filled from that task
//   ao:open-task-output  { taskId }  open that task's full output in the right-hand slide-over
window.addEventListener('ao:retry-task', (e) => { const t = taskById(e.detail && e.detail.taskId); if (t) retryTask(t); });
window.addEventListener('ao:open-task-output', (e) => { openTaskOutput(e.detail && e.detail.taskId); });

roster.el.append(tasks.el); // the tray lives at the foot of the roster column, never over the office
ui.append(topbar.el, banner, roster.el, roster.tab, transcript.el, dialogue.el);
ui.append(taskOut.el);

// The office log shows state changes only; this switch (hung in the log panel's side column) lets the tool calls in.
{
  const side = dialogue.el.querySelector('.dlg-log-side');
  if (side) {
    const toggle = createLogFilterToggle(log);
    const closeBtn = [...side.querySelectorAll('button')].pop();
    if (closeBtn) closeBtn.before(toggle); else side.append(toggle);
  }
  log.onFilter(() => {
    const list = dialogue.el.querySelector('.dlg-log-list');
    if (list) list.scrollTop = 0; // a different list: start at the newest line
    render();
  });
}

// "DRAG to look around": the first hint in the bottom bar while the world says the office does not fit the window
// and can be panned (world.getInfo().panning, or world.onPanChange(fn) when it has one — both optional).
const panHint = h('span', { class: 'hint-item hint-pan', hidden: true }, h('kbd', { text: 'DRAG' }), h('span', { text: 'to look around' }));
let panOn = false;
function syncPanHint(on) {
  if (typeof on === 'boolean') panOn = on;
  else if (app.world && typeof app.world.getInfo === 'function') { const info = safe(() => app.world.getInfo()); panOn = !!(info && info.panning); }
  else panOn = false;
  const bar = dialogue.el.querySelector('.dlg-hint');
  if (bar && panHint.parentNode !== bar) bar.prepend(panHint);
  setHidden(panHint, !panOn);
}

// stage: loading / empty / unreachable / missing world ----------------------------------------------
const stageTitle = h('h2', { class: 'stage-title' });
const stageText = h('p', { class: 'stage-text' });
const stageHint = h('p', { class: 'stage-hint' });
const stageBtn = h('button', { class: 'btn btn-primary', type: 'button', hidden: true });
const stageCard = h('div', { class: 'stage-card panel', hidden: true }, stageTitle, stageText, stageHint, stageBtn);
stage.append(stageCard);
let stageAction = null;
stageBtn.addEventListener('click', () => stageAction && stageAction());

function renderStage() {
  const s = app.state;
  const conn = app.conn.status;
  let kind = '';
  if (!s && (conn === 'connecting' || conn === 'demo' || conn === 'live')) kind = 'loading';
  else if (!s && conn === 'reconnecting') kind = 'unreachable';
  else if (s && s.sessions.length === 0) kind = 'empty';
  else if (s && app.worldFailed) kind = 'noworld';

  setHidden(stageCard, !kind);
  stageCard.dataset.kind = kind;
  if (!kind) return;
  if (kind === 'loading') {
    setText(stageTitle, 'OPENING THE OFFICE');
    setText(stageText, 'Looking for your agents…');
    setText(stageHint, '');
    setHidden(stageBtn, true);
  } else if (kind === 'unreachable') {
    setText(stageTitle, 'NO SIGNAL');
    setText(stageText, app.conn.error || "Can't reach the office server.");
    const secs = app.conn.retryAt ? Math.max(0, Math.ceil((app.conn.retryAt - Date.now()) / 1000)) : 0;
    setText(stageHint, `${secs ? `Trying again in ${secs}s. ` : 'Trying again… '}Start the server with "npm start" in the agent-office folder, or add ?mock=1 to the address for the demo.`);
    setText(stageBtn, 'RETRY NOW');
    stageAction = () => api.retryNow();
    setHidden(stageBtn, false);
  } else if (kind === 'empty') {
    setText(stageTitle, "NOBODY'S IN");
    setText(stageText, 'Start a task here, or open Claude, Codex or Cursor: they walk in by themselves.');
    setText(stageHint, app.worldFailed ? 'The office view did not load either. Reload to retry.' : '');
    setText(stageBtn, 'NEW TASK');
    stageAction = () => openNewTaskModal();
    setHidden(stageBtn, false);
  } else {
    setText(stageTitle, 'OFFICE VIEW IS OUT');
    setText(stageText, "The map didn't load, but everyone is still here: use the roster, the log and the task tray as usual.");
    setText(stageHint, 'Reload the page to try the office view again.');
    setHidden(stageBtn, true);
  }
}

function renderNotices() {
  const s = app.state;
  const stale = app.conn.status === 'reconnecting' && !!s;
  setHidden(banner, !stale);
  if (stale) {
    const secs = app.conn.retryAt ? Math.max(0, Math.ceil((app.conn.retryAt - Date.now()) / 1000)) : 0;
    setText(bannerText, `Lost the office server. This is the last known office${secs ? ` · retrying in ${secs}s` : ' · retrying…'}`);
  }
  topbar.setDemo(!!(IS_MOCK || (s && s.mock)));
  if (document.body.classList.contains('is-stale') !== stale) {
    setClass(document.body, 'is-stale', stale);
    layout(); // the strip moves the panels down a row
  }
}

// ------------------------------------------------------------------------------------------------
// render
// ------------------------------------------------------------------------------------------------

function render() {
  const s = app.state;
  if (app.groupFilter && !groupById(app.groupFilter)) setGroupFilter(null, { silent: true }); // the group was deleted
  topbar.update(s, { groupFilter: app.groupFilter });
  roster.update(s, app.selectedId, { groupFilter: app.groupFilter });
  dialogue.update(s, resolve(app.selectedId));
  tasks.update(s);
  transcript.update();
  if (taskOut.isOpen() && transcript.isOpen()) taskOut.close({ restore: false }); // the transcript took the slot
  if (app.groupEditor && app.groupEditor.isOpen()) app.groupEditor.refresh();
  renderStage();
  renderNotices();
  tick();
}

function tick() {
  topbar.tick(Date.now());
  const t = now();
  dialogue.tick(t);
  tasks.tick(t);
  if (taskOut.isOpen()) taskOut.update(t); // the output follows while the task runs
  syncPanHint();
}

function onState(state) {
  const prev = app.state;
  markUnanswered(state); // UI-derived flag: set before the world, the log or any component sees the snapshot
  app.state = state;
  if (Number.isFinite(state.now)) app.offset = state.now - Date.now();
  if (Math.abs(app.offset) < 1500) app.offset = 0; // same machine: ignore transport jitter
  setClass(document.body, 'is-loading', false);
  log.ingest(prev, state);
  sound.ingest(prev, state, { selectedId: app.selectedId });
  announceNeeds(prev, state);
  announceTasks(prev, state);
  trackModels(state);

  // keep the selection honest
  if (app.selectedId && !resolve(app.selectedId)) {
    const parent = parentIdOf(app.selectedId);
    app.selectedId = parent || null;
    if (app.world) safe(() => app.world.select(app.selectedId));
  }

  // a task we just started: select its session the moment it walks in
  if (app.pending) {
    const t = (state.tasks || []).find((x) => x.id === app.pending.taskId);
    const s = state.sessions.find((x) => (x.taskId && x.taskId === app.pending.taskId) || (t && t.sessionId && x.id === t.sessionId));
    if (s) {
      app.pending = null;
      // the new hire is selected only when nobody else is: starting a task never takes you away from a conversation
      if (!app.selectedId && !modalOpen()) {
        if (app.world) safe(() => app.world.setState(state));
        select(s.id);
        return void render();
      }
      toast(`${s.name} IS IN`, { detail: oneLine(taskName(s), 60), ms: 9000, compact: true, actions: [{ label: `FIND ${s.name}`, primary: true, onClick: () => select(s.id) }] });
    } else if (Date.now() > app.pending.until || (t && !isLiveTask(t))) app.pending = null;
  }

  if (app.world) safe(() => app.world.setState(state));
  render();
}

// ---- the needs-you call-out ----------------------------------------------------------------------------
// The top bar's NEEDS YOU button, the roster's NEEDS YOU block, the "!" over the agent's head and the sound
// already say that someone needs you. The call-out (one toast, never more) is only for what those cannot do:
//   - the page is VISIBLE (focused or not: a window on a second monitor counts as visible) and the agent is
//     off screen because the office is panned: one quiet line, which leaves by itself;
//   - the page was HIDDEN (another tab, minimised) when agents started needing you: nothing is shown meanwhile;
//     when you come back there is ONE summary ("3 agents need you · NEXT") for about six seconds.
// Its words change at most once every ten seconds (ui/toast.js). The sound plays either way.
const needPending = new Set(); // agents the call-out stands for right now (FIND / NEXT visits them)
const needAway = new Set(); // agents that started needing you while the page was hidden

/** Is this agent in the office but outside what the window shows of it (the office is panned)? */
function agentOffScreen(id) {
  if (!app.world || typeof app.world.locate !== 'function') return false;
  const p = safe(() => app.world.locate(id));
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false; // not placed yet: the roster has it
  const { top, left, bottom } = app.insets;
  return p.x < left + 8 || p.x > window.innerWidth - 8 || p.y < Math.max(0, top) + 8 || p.y > window.innerHeight - bottom - 8;
}

const pendingNames = (state = app.state) => freshWaiting(state).filter((s) => needPending.has(s.id)).map((s) => s.name);

/** FIND / NEXT on the call-out: go to the agent it names (the first one still pending), keep counting the rest. */
function visitPendingNeed() {
  const id = [...needPending].find((x) => resolve(x));
  if (!id) { needPending.clear(); cycleNeedsYou(); return; }
  needPending.delete(id);
  needRound.add(id);
  select(id);
  const rest = pendingNames();
  if (rest.length) needToast.show(rest, { ms: 6000 });
  focusReply();
}

function announceNeeds(prev, state) {
  // the tab title counts the fresh ones only (older ones are in the bar and the roster)
  const waiting = freshWaiting(state);
  const title = waiting.length ? `(${waiting.length}) Agent Office` : 'Agent Office';
  if (document.title !== title) document.title = title;
  const hidden = document.hidden;
  let added = false;
  if (prev) {
    const before = new Map(prev.sessions.map((s) => [s.id, needRank(s)]));
    for (const s of waiting) {
      if (before.get(s.id) === 0 || s.id === app.selectedId) continue;
      if (hidden) { needAway.add(s.id); continue; } // nobody is looking: one summary when they are back
      if (!agentOffScreen(s.id)) continue; // in plain view: the bar, the roster and its own "!" say it
      needPending.add(s.id);
      added = true;
    }
  }
  const stillWaiting = new Set(waiting.map((s) => s.id));
  for (const set of [needPending, needAway]) for (const id of [...set]) if (!stillWaiting.has(id) || id === app.selectedId) set.delete(id);
  if (hidden) return;
  // someone the quiet line stood for has come into view (the office was panned back, the window grew): it is done
  if (needToastWhere) for (const id of [...needPending]) if (!agentOffScreen(id)) needPending.delete(id);
  if (!needPending.size) { if (needToast.isShown()) needToast.clear(); return; }
  const names = pendingNames(state);
  if (added) {
    needToastWhere = 'off screen';
    if (!modalOpen() || needToast.isShown()) needToast.show(names, { ms: 8000, quiet: true, where: needToastWhere });
  } else if (needToast.isShown()) {
    needToast.update(names, { where: needToastWhere }); // keep the count honest; its clock keeps running
  } else {
    needPending.clear(); // it timed out or was dismissed: do not bring it back
  }
}
let needToastWhere = ''; // what the call-out on screen says about where they are

// back from another tab: ONE summary of who started needing you meanwhile, gone again in six seconds
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !app.state) return;
  const names = freshWaiting().filter((s) => needAway.has(s.id) && s.id !== app.selectedId).map((s) => s.name);
  for (const id of needAway) needPending.add(id);
  needAway.clear();
  if (!names.length || modalOpen()) return;
  needToastWhere = '';
  needToast.show(pendingNames(), { ms: 6000 });
});

/** Tasks are things the human started from here, so their endings get a shout. */
function announceTasks(prev, state) {
  if (!prev || !state.tasks || !state.tasks.length) return;
  const before = new Map((prev.tasks || []).map((t) => [t.id, t.status]));
  for (const t of state.tasks) {
    const was = before.get(t.id);
    if (!was || was === t.status || !(was === 'starting' || was === 'running')) continue;
    const s = sessionForTask(t, state);
    const who = s ? s.name : TOOL_INFO[t.tool]?.label || 'The agent';
    const pick = s ? () => select(s.id) : undefined;
    if (t.status === 'done') toast('JOB DONE!', { kind: 'pow', detail: `${who}: ${oneLine(t.label || t.prompt, 50)}`, ms: 3500, onClick: pick });
    else if (t.status === 'failed') {
      tasks.show();
      // Said once: the dialogue shows the failure of the agent you are looking at, the tray shows its row.
      // Only when neither is in front of you does a toast say it: one line; the card with the reason is behind DETAILS.
      const selected = !!s && !!app.selectedId && (app.selectedId === s.id || parentIdOf(app.selectedId) === s.id) && !!failedTaskFor(s, state);
      if (selected || tasks.rowVisible(t.id, state)) continue;
      toast(who, {
        kind: 'error', line: true, detail: 'FAILED',
        title: `${who}'s task failed${t.exitCode != null ? ` (exit ${t.exitCode})` : ''}: ${oneLine(t.label || t.prompt, 120)}`,
        actions: [
          { label: 'RETRY', primary: true, onClick: () => retryTask(taskById(t.id) || t) },
          { label: 'DETAILS', onClick: () => failureCard(t.id) },
        ],
      });
    }
  }
}

/** DETAILS on a failure line: the card that says why (the lines of the output that read like the real error). */
function failureCard(taskId) {
  const t = taskById(taskId);
  if (!t) { toast('GONE', { detail: 'That task is no longer on the list.' }); return; }
  const s = sessionForTask(t);
  const who = s ? s.name : TOOL_INFO[t.tool]?.label || 'The agent';
  const why = failureReason(t, { max: 4 });
  const signedOut = why.signedOut || (app.state && app.state.tools && app.state.tools[t.tool] && app.state.tools[t.tool].signedIn === false);
  toast('KNOCKED OUT!', {
    kind: 'error',
    detail: `${who}'s task failed${t.exitCode != null ? ` (exit ${t.exitCode})` : ''}: ${oneLine(t.label || t.prompt, 60)}`,
    lines: why.lines,
    note: signedOut ? h('span', { class: 'toast-signin' }, h('span', { text: `${TOOL_INFO[t.tool]?.label || 'The'} CLI looks signed out:` }), loginHint(t.tool)) : null,
    actions: [
      { label: 'RETRY', primary: true, onClick: () => retryTask(taskById(t.id) || t) },
      { label: 'FULL OUTPUT', onClick: () => openTaskOutput(t.id) },
      ...(s && app.selectedId !== s.id ? [{ label: `FIND ${s.name}`, onClick: () => select(s.id) }] : []), // no FIND for someone already selected
    ],
  });
}

/**
 * A model name typed in NEW TASK is remembered for its tool only once a task using it has really run
 * (running with output for a while, or done). One that failed at the door is forgotten, so the next task
 * does not inherit it from a collapsed ADVANCED section.
 */
function trackModels(state) {
  if (!app.sentModels.size || !state.tasks) return;
  for (const t of state.tasks) {
    if (!app.sentModels.has(t.id) || app.modelSeen.has(t.id)) continue;
    const model = t.model != null ? t.model : app.sentModels.get(t.id);
    const ranFor = (t.endedAt || now()) - t.startedAt;
    if (t.status === 'done' || (t.status === 'running' && String(t.outputTail || '').trim() && ranFor > 12_000)) {
      app.modelSeen.add(t.id);
      rememberModel(STORE, t.tool, model);
    } else if (t.status === 'failed') {
      app.modelSeen.add(t.id);
      if (ranFor < 30_000) forgetModel(STORE, t.tool, model);
    } else if (t.status === 'stopped') {
      app.modelSeen.add(t.id);
    }
  }
}

function onConn(conn) {
  if (conn.status === 'reconnecting') sound.connLost();
  else if (conn.status === 'live' || conn.status === 'demo') sound.connBack();
  app.conn = conn;
  topbar.setConn(conn);
  renderStage();
  renderNotices();
}

// ------------------------------------------------------------------------------------------------
// layout + world
// ------------------------------------------------------------------------------------------------

function layout({ resized = false } = {}) {
  if (taskOut.isOpen() && transcript.isOpen()) taskOut.close({ restore: false }); // the transcript took the slot (this re-enters once)
  const vw = window.innerWidth;
  // offset* rather than getBoundingClientRect: the transcript slides in with a transform
  const top = Math.max(topbar.el.offsetTop + topbar.el.offsetHeight + 4, banner.hidden ? 0 : banner.offsetTop + banner.offsetHeight);
  // The office is fitted around the slim ticker bar only. The opened dialogue and the transcript are
  // overlays: they slide over the office, which keeps its scale and just moves the camera if the
  // selected character would end up underneath.
  const css = getComputedStyle(document.documentElement);
  const px = (name, fallback) => { const v = parseFloat(css.getPropertyValue(name)); return Number.isFinite(v) ? v : fallback; };
  const gap = px('--gap', 8);
  const tickH = px('--tick-h', 60);
  const open = dialogue.mode() !== 'ticker';
  setClass(document.body, 'dlg-open', open);
  // The opened dialogue is as tall as what it holds (a long message, a reply being typed): measure it.
  // While the transcript is open the dialogue keeps to identity + actions, so tell it first.
  dialogue.setTranscript(transcript.isOpen() ? transcript.current() : null);
  const dlgH = open ? Math.max(tickH, dialogue.el.offsetHeight) : tickH;
  document.body.style.setProperty('--dlg-now', `${dlgH}px`); // the transcript ends above it
  const bottom = tickH + gap;
  const left = roster.isOpen() ? roster.el.offsetLeft + roster.el.offsetWidth : 0;
  setClass(document.body, 'roster-open', roster.isOpen());
  // The collapsed roster leaves a small tab at the top-left; keep the office's wall signs out from under it.
  const tabEl = document.getElementById('roster-tab');
  const tabBottom = !roster.isOpen() && tabEl && !tabEl.hidden ? tabEl.offsetTop + tabEl.offsetHeight + 4 : 0;
  const next = { top: Math.max(top, tabBottom), right: 0, bottom, left };
  const sidePanel = transcript.isOpen() ? transcript.el : taskOut.isOpen() ? taskOut.el : null; // one slot, two tenants
  const over = { right: sidePanel ? vw - sidePanel.offsetLeft : 0, bottom: open ? dlgH - tickH : 0 };
  const changed = ['top', 'right', 'bottom', 'left'].some((k) => next[k] !== app.insets[k]);
  app.insets = next;
  const root = document.documentElement.style;
  root.setProperty('--inset-t', `${top}px`);
  // the stage cards centre themselves in what is actually visible, overlays included
  root.setProperty('--inset-r', `${over.right}px`);
  root.setProperty('--inset-b', `${bottom + over.bottom}px`);
  root.setProperty('--inset-l', `${left}px`);
  if (resized) topbar.refit();
  if (app.world) {
    if (changed && typeof app.world.setInsets === 'function') safe(() => app.world.setInsets({ ...next }));
    // the overlay (opened dialogue, transcript) is reported once per real change: layout() runs for many reasons
    const overKey = `${over.right}|${over.bottom}`;
    if (typeof app.world.setOverlay === 'function' && (resized || changed || app.overlayKey !== overKey || app.overlayWorld !== app.world)) {
      app.overlayKey = overKey;
      app.overlayWorld = app.world;
      safe(() => app.world.setOverlay(over));
    }
    if (resized && typeof app.world.resize === 'function') safe(() => app.world.resize());
  }
}

async function loadWorld() {
  try {
    const mod = await import('./world/index.js');
    if (typeof mod.createOffice !== 'function') throw new Error('world module has no createOffice()');
    app.worldMod = mod;
    const world = mod.createOffice(canvas, { insets: { ...app.insets } });
    if (!world || typeof world.setState !== 'function') throw new Error('createOffice() returned no world');
    app.world = world;
    if (typeof world.onSelect === 'function') world.onSelect((id) => select(id || null, { pan: false }));
    // optional: a click on a group's sign in the office spotlights that group (again clears it)
    if (typeof world.onGroupSelect === 'function') world.onGroupSelect((groupId) => { if (groupId) toggleGroup(groupId); else setGroupFilter(null); });
    if (typeof world.onPanChange === 'function') safe(() => world.onPanChange((on) => syncPanHint(!!on)));
    if (typeof world.setInsets === 'function') safe(() => world.setInsets({ ...app.insets }));
    app.insets = { top: -1, right: 0, bottom: 0, left: 0 }; // force the next layout() to push insets + overlay
    layout();
    if (typeof world.resize === 'function') safe(() => world.resize());
    if (app.state) safe(() => world.setState(app.state));
    if (app.selectedId) safe(() => world.select(app.selectedId));
    if (app.groupFilter && typeof world.highlightGroup === 'function') safe(() => world.highlightGroup(app.groupFilter));
    dialogue.redrawPortrait();
  } catch (e) {
    console.info('[office] the world module is not available; showing the placeholder.', e && e.message ? e.message : e);
    app.worldFailed = true;
    document.body.classList.add('no-world');
  }
  render();
}

// ------------------------------------------------------------------------------------------------
// keyboard
// ------------------------------------------------------------------------------------------------

function handleEscape() {
  if (closeTopModal()) return true;
  if (modalOpen()) return true; // a busy modal swallows Esc
  if (roster.isSelecting()) { roster.endSelect(); return true; }
  if (dialogue.handleEscape()) return true; // an armed STOP stands down first
  if (taskOut.isOpen()) { taskOut.close(); return true; }
  if (transcript.isOpen()) { transcript.close(); return true; }
  if (app.selectedId) {
    // the dialogue closes: the keyboard goes back to that agent's roster row (or the office), never to a hidden button
    const was = app.selectedId;
    select(null);
    const a = document.activeElement;
    if (!a || a === document.body || a === canvas || roster.hasFocus() || (a.closest && a.closest('[hidden]')) || a.offsetParent === null) focusSelection(was);
    return true;
  }
  if (app.groupFilter) { setGroupFilter(null); return true; }
  if (dialogue.isLogOpen()) { dialogue.closeLog(); return true; }
  return false;
}

window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.key === 'Escape') {
    if (handleEscape()) e.preventDefault();
    return;
  }
  // Alt+Y (Option+Y): the next agent that needs you, from anywhere, the reply field included (Y alone would
  // type a "y" there). With Shift: the one before. e.code, because Option+Y is "¥" on a Mac; preventDefault
  // keeps that character out of the field.
  if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyY') {
    const t = e.target;
    if (modalOpen() || (isTypingTarget(t) && !(t.classList && t.classList.contains('cmp-field')))) return;
    e.preventDefault();
    cycleNeedsYou({ dir: e.shiftKey ? -1 : 1 });
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target)) return; // never steal keys from a field
  if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
  if (modalOpen()) return;

  const cur = selectedSession();
  switch (e.key) {
    case 'n': case 'N': e.preventDefault(); openNewTaskModal(); break;
    case 'r': case 'R': e.preventDefault(); roster.toggle(); break;
    case '/': e.preventDefault(); roster.focusFilter(); break;
    case 't': case 'T':
      e.preventDefault();
      if (transcript.isOpen() && (!cur || transcript.current() === cur.id)) transcript.close();
      else if (cur) openTranscriptFor(cur.id);
      else toast('PICK SOMEONE FIRST', { detail: 'Select an agent, then press T.' });
      break;
    case 'm': case 'M':
      e.preventDefault();
      if (!cur) toast('PICK SOMEONE FIRST', { detail: 'Select an agent, then press M.' });
      else if (replyNeedsModal()) openSendModal(cur.id);
      else focusReply();
      break;
    case 'y': case 'Y': e.preventDefault(); cycleNeedsYou(); break;
    case 'e': case 'E':
      e.preventDefault();
      if (!cur) toast('PICK SOMEONE FIRST', { detail: 'Select an agent, then press E to name its task.' });
      else { if (app.selectedId !== cur.id) select(cur.id); dialogue.startRename(); }
      break;
    case 'g': case 'G':
      e.preventDefault();
      if (roster.checkedIds().length) roster.openBulk();
      else if (cur) { if (app.selectedId !== cur.id) select(cur.id); dialogue.openGroup(); }
      else topbar.openGroups();
      break;
    case 's': case 'S':
      e.preventDefault();
      if (e.shiftKey) sound.cycle(); else sound.toggleMute();
      toast(sound.level === 'off' ? 'SOUND OFF' : `SOUND: ${SOUND_LEVEL_LABEL[sound.level]}`, { detail: sound.level === 'critical' ? 'Needs-you, failures, lost connection.' : sound.level === 'all' ? 'Every cue.' : 'S turns it back on.', ms: 1800 });
      break;
    case 'l': case 'L': e.preventDefault(); dialogue.toggleLog(); break;
    case '[': e.preventDefault(); cycle(-1); break;
    case ']': e.preventDefault(); cycle(1); break;
    default:
  }
});

// Arrow keys pan the office — but not while the caret is in one of our fields, or while a
// scrolling pane of ours (transcript, task output) has the focus and wants them for itself.
ui.addEventListener('keydown', (e) => {
  if (!e.key.startsWith('Arrow')) return;
  const t = e.target;
  if (isTypingTarget(t) || (t && t.matches && t.matches('.tr-scroll, .to-out, .dlg-log-list, .dlg-say-scroll, .dlg-fail-out, .dlg-crew-list'))) e.stopPropagation();
});

let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => layout({ resized: true }));
});

// ------------------------------------------------------------------------------------------------
// go
// ------------------------------------------------------------------------------------------------

document.body.classList.toggle('is-demo', IS_MOCK);
render();
layout();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layout(); topbar.refit(); });

setInterval(() => { tick(); if (app.conn.status === 'reconnecting') { renderStage(); renderNotices(); } }, 1000);

loadWorld();
api.start(onState, onConn);
loadMeta();

// Handy in the console (and for demo mode: agentOffice.api.debug.drop() / .restore() / .empty()).
window.agentOffice = { app, api, select, log, oneLine, sound, groupOps, setGroupFilter };
