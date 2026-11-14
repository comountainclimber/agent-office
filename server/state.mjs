// The aggregator: polls the adapters, turns what they return into the OfficeState the browser sees.
//
//   const office = createOfficeState({ getTasks });   office.start();
//   office.getState()            -> OfficeState
//   office.subscribe(fn)         -> unsubscribe; fn(state) on every real change + a 5 s heartbeat
//   office.getTranscript(id, n)  -> Message[] | null (null = no such session id / tool)
//   office.findSession(id)       -> Session | undefined
//   office.refresh()             -> recompose now (the launcher calls this when a task changes)
//
// Names and groups come from a meta store (meta.mjs): every Session gets its `label` and resolved
// `groupId`, the state gets `groups`, and a change in the store is pushed to subscribers at once.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, IDLE_MAX_MS, MID_TURN_MAX_MS, SUBAGENT_LINGER_MS, deriveStatus, clipText, oneLine } from './contract.mjs';
import { createNamer } from './names.mjs';
import { BIN, childEnv, defaultExtraDirs } from './launcher.mjs';
import { resolveGroup } from './meta.mjs';

export const POLL_MS = 1800;
export const ADAPTER_TIMEOUT_MS = 1500;
export const HEARTBEAT_MS = 5000;
export const ADAPTER_RELOAD_CHECK_MS = 10_000;
export const MAX_RECENT_DIRS = 20;

const ACTIVITY_KINDS = new Set(['thinking', 'reading', 'editing', 'running', 'searching', 'browsing', 'delegating', 'writing', 'waiting', 'idle']);
const TURN_STATES = new Set(['mid', 'ended', 'unknown']);
const SOURCES = new Set(['cli', 'desktop', 'ide', 'cloud', 'unknown']);

// --- pure mapping -----------------------------------------------------------

/**
 * Short project label for a working directory.
 *   ~/projects/shop/graph                      -> "graph"
 *   ~/projects/shop/.worktrees/tier-meter      -> "shop/tier-meter"
 *   ~/projects/shop/.claude/worktrees/fix-x    -> "shop/fix-x"
 *   ~/.cursor/worktrees/shop/fix-x             -> "shop/fix-x"
 *   home directory                             -> "~"
 */
export function projectLabel(cwd, home = os.homedir()) {
  const raw = String(cwd || '').trim();
  if (!raw) return 'unknown';
  const clean = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  if (!clean) return '/';
  if (home && clean === home.replace(/\/+$/, '')) return '~';
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length) return '/';
  const w = parts.lastIndexOf('worktrees');
  const dotW = parts.lastIndexOf('.worktrees');
  // <repo>/.worktrees/<name>[/...]
  if (dotW > 0 && parts[dotW + 1]) return `${parts[dotW - 1]}/${parts[dotW + 1]}`;
  if (w > 0 && parts[w + 1]) {
    const holder = parts[w - 1];
    // <repo>/.claude/worktrees/<name>[/...]  (also .git/worktrees and friends)
    if (holder.startsWith('.') && w > 1 && parts[w - 2] && !isHome(parts.slice(0, w - 1), home)) return `${parts[w - 2]}/${parts[w + 1]}`;
    // ~/.codex/worktrees/<id>/<repo>[/...]  (tool-level store keyed by an opaque id)
    if (holder === '.codex' && parts[w + 2]) return parts[w + 2];
    // ~/.cursor/worktrees/<repo>/<name>[/...]  (tool-level store keyed by repo)
    if (holder.startsWith('.') && parts[w + 2]) return `${parts[w + 1]}/${parts[w + 2]}`;
  }
  return parts[parts.length - 1];
}

function isHome(parts, home) {
  return Boolean(home) && `/${parts.join('/')}` === home.replace(/\/+$/, '');
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanActivity(a, fallbackKind = 'thinking', fallbackLabel = 'Thinking') {
  const kind = a && ACTIVITY_KINDS.has(a.kind) ? a.kind : fallbackKind;
  const label = oneLine(a && typeof a.label === 'string' && a.label.trim() ? a.label : fallbackLabel, 60);
  return { kind, label };
}

function byStart(a, b) {
  return a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** One adapter subagent -> a clean Subagent, or null when it should no longer be in the room. */
function cleanSubagent(s, now) {
  if (!s || typeof s !== 'object' || s.id === undefined || s.id === null || s.id === '') return null;
  const lastActivityAt = num(s.lastActivityAt, num(s.startedAt, now));
  const startedAt = num(s.startedAt, lastActivityAt);
  const endedAtRaw = num(s.endedAt, NaN);
  let status = s.status === 'done' || s.status === 'failed' || s.status === 'working' ? s.status : Number.isFinite(endedAtRaw) ? 'done' : 'working';
  if (status === 'working') {
    // Still "working" with no sign of life for longer than a mid-turn session is given: the parent
    // was interrupted or the log ended. It is no longer in the room.
    if (now - lastActivityAt > MID_TURN_MAX_MS) return null;
  } else {
    const endedAt = Number.isFinite(endedAtRaw) ? endedAtRaw : lastActivityAt;
    if (now - endedAt > SUBAGENT_LINGER_MS) return null;
  }
  const out = {
    id: String(s.id),
    label: oneLine(s.label || 'Subagent', 80),
    ...(s.agentType ? { agentType: oneLine(s.agentType, 40) } : {}),
    status,
    activity: status === 'working' ? cleanActivity(s.activity) : { kind: 'idle', label: status === 'failed' ? 'Failed' : 'Done' },
    startedAt,
    lastActivityAt,
  };
  if (status !== 'working') out.endedAt = Number.isFinite(endedAtRaw) ? endedAtRaw : lastActivityAt;
  return out;
}

/**
 * AdapterSession[] -> Session[] (sorted, named, statuses derived, stale ones dropped).
 *
 * @param {any[]} adapterSessions
 * @param {object} o
 * @param {number} o.now
 * @param {{assign: (s: any[]) => any[]}} o.namer
 * @param {Map<string, string>} [o.taskBySession]  session id -> task id, for runs launched from the UI
 * @param {string} [o.home]
 */
export function toSessions(adapterSessions, { now, namer, taskBySession = new Map(), home = os.homedir() }) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const a of adapterSessions || []) {
    if (!a || typeof a !== 'object' || !TOOLS.includes(a.tool)) continue;
    const nativeId = a.nativeId === undefined || a.nativeId === null ? '' : String(a.nativeId);
    if (!nativeId) continue;
    const lastActivityAt = num(a.lastActivityAt, NaN);
    if (!Number.isFinite(lastActivityAt)) continue;
    let turnState = TURN_STATES.has(a.turnState) ? a.turnState : 'unknown';
    let status = deriveStatus(turnState, lastActivityAt, now);
    if (!status) continue;

    const subagents = (Array.isArray(a.subagents) ? a.subagents : []).map((s) => cleanSubagent(s, now)).filter(Boolean);
    const seenSubs = new Set();
    const uniqueSubs = subagents.filter((s) => (seenSubs.has(s.id) ? false : seenSubs.add(s.id))).sort(byStart);
    const workingSubs = uniqueSubs.filter((s) => s.status === 'working').length;
    if (workingSubs) {
      status = 'working';
      turnState = 'mid';
    }

    let activity;
    if (status === 'working') {
      activity = cleanActivity(a.activity);
      if (activity.kind === 'waiting' || activity.kind === 'idle') {
        activity = workingSubs ? { kind: 'delegating', label: `Running ${workingSubs} agent${workingSubs === 1 ? '' : 's'}` } : { kind: 'thinking', label: 'Thinking' };
      }
    } else if (status === 'waiting') activity = { kind: 'waiting', label: 'Waiting for you' };
    else activity = { kind: 'idle', label: 'Idle' };

    const id = `${a.tool}:${nativeId}`;
    const cwd = typeof a.cwd === 'string' ? a.cwd : '';
    const session = {
      id,
      tool: a.tool,
      nativeId,
      name: '',
      title: oneLine(a.title || '', 120) || 'Untitled session',
      cwd,
      project: projectLabel(cwd, home),
      ...(a.branch ? { branch: oneLine(a.branch, 80) } : {}),
      ...(a.model ? { model: oneLine(a.model, 80) } : {}),
      source: SOURCES.has(a.source) ? a.source : 'unknown',
      turnState,
      status,
      mode: uniqueSubs.length ? 'orchestrator' : 'solo',
      startedAt: num(a.startedAt, lastActivityAt),
      lastActivityAt,
      activity,
      ...(typeof a.lastMessage === 'string' && a.lastMessage.trim() ? { lastMessage: clipText(a.lastMessage) } : {}),
      ...(Number.isFinite(Number(a.tokens)) && a.tokens !== null && a.tokens !== undefined ? { tokens: Number(a.tokens) } : {}),
      subagents: uniqueSubs,
      ...(taskBySession.has(id) ? { taskId: taskBySession.get(id) } : {}),
    };
    // Two records for one id (an adapter seeing the same session twice): keep the livelier one.
    const prev = byId.get(id);
    if (!prev || prev.lastActivityAt < session.lastActivityAt) byId.set(id, session);
  }
  const sessions = [...byId.values()].sort(byStart);
  namer.assign(sessions);
  return sessions;
}

/**
 * Session[] -> Session[] with the user's `label` and the resolved `groupId` (explicit choice, 'none' pin,
 * else the first group by order with an autoDir that holds the session's cwd).
 *
 * @param {any[]} sessions
 * @param {{groups: () => any[], getSessionMeta: (id: string) => {label?: string, groupId?: string}}|null} meta
 * @param {any[]} [groups]  meta.groups(), when the caller already has it
 */
export function withMeta(sessions, meta, groups = meta ? meta.groups() : []) {
  if (!meta) return sessions;
  return sessions.map((s) => {
    const m = meta.getSessionMeta(s.id) || {};
    const groupId = resolveGroup(m.groupId, groups, s.cwd);
    return { ...s, ...(m.label ? { label: m.label } : {}), ...(groupId ? { groupId } : {}) };
  });
}

// --- tool detection ---------------------------------------------------------

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find `name` on PATH, then in the usual install locations. */
export function resolveBinary(name, { env = process.env, home = os.homedir(), execPath = process.execPath } = {}) {
  const dirs = [
    ...String(env.PATH || '').split(path.delimiter).filter(Boolean),
    path.join(home, '.local', 'bin'),
    path.dirname(execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of new Set(dirs)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function versionOf(bin, env, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, ['--version'], { timeout: timeoutMs, env, maxBuffer: 256 * 1024 }, (err, stdout) => {
        if (err) return resolve(undefined);
        const m = String(stdout || '').match(/\d+(?:\.\d+)+[\w.\-]*/);
        resolve(m ? m[0] : oneLine(stdout, 40) || undefined);
      });
      child.stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Which agent CLIs are installed (file lookups only, so this is instant).
 * @returns {Record<'claude'|'codex'|'cursor', {available: boolean, path?: string, version?: string}>}
 */
export function resolveTools({ env = process.env, home = os.homedir(), execPath = process.execPath } = {}) {
  /** @type {any} */
  const found = {};
  for (const tool of TOOLS) {
    const p = resolveBinary(BIN[tool], { env, home, execPath });
    found[tool] = p ? { available: true, path: p } : { available: false };
  }
  return found;
}

/** Ask each installed CLI for its version and note it on `found`. Never throws; a silent CLI just has no version. */
export async function probeVersions(found, { env = process.env, timeoutMs = 4000 } = {}) {
  const probeEnv = childEnv(env, defaultExtraDirs(found));
  await Promise.all(
    TOOLS.map(async (tool) => {
      if (!found[tool]?.path) return;
      const version = await versionOf(found[tool].path, probeEnv, timeoutMs);
      if (version) found[tool].version = version;
    }),
  );
  return found;
}

function run(bin, args, env, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, args, { timeout: timeoutMs, env, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: `${stdout || ''}\n${stderr || ''}` });
      });
      child.stdin?.end();
    } catch {
      resolve({ ok: false, out: '' });
    }
  });
}

/**
 * Is each CLI signed in? Sets `signedIn` to true/false, or leaves it unset when it cannot be told cheaply.
 * (The office reads other apps' session logs, so a tool can have sessions on the floor while its CLI is
 * signed out - launching from the office would then fail.) cursor-agent has no status command that is safe
 * to run unattended (it can start a sign-in flow), so it stays unknown.
 */
export async function probeAuth(found, { env = process.env, timeoutMs = 5000 } = {}) {
  const probeEnv = childEnv(env, defaultExtraDirs(found));
  await Promise.all([
    (async () => {
      if (!found.claude?.path) return;
      const { out } = await run(found.claude.path, ['auth', 'status'], probeEnv, timeoutMs);
      const m = out.match(/"loggedIn"\s*:\s*(true|false)/);
      if (m) found.claude.signedIn = m[1] === 'true';
      else delete found.claude.signedIn;
    })(),
    (async () => {
      if (!found.codex?.path) return;
      const { ok, out } = await run(found.codex.path, ['login', 'status'], probeEnv, timeoutMs);
      if (/not logged in/i.test(out)) found.codex.signedIn = false;
      else if (ok && /logged in/i.test(out)) found.codex.signedIn = true;
      else delete found.codex.signedIn;
    })(),
  ]);
  return found;
}

/** Both steps. Done once at start. */
export async function detectTools({ env = process.env, home = os.homedir(), execPath = process.execPath, timeoutMs = 4000 } = {}) {
  return probeVersions(resolveTools({ env, home, execPath }), { env, timeoutMs });
}

function publicTools(tools) {
  /** @type {any} */
  const out = {};
  for (const tool of TOOLS) {
    const t = tools?.[tool];
    out[tool] = {
      available: Boolean(t?.available),
      ...(t?.version ? { version: t.version } : {}),
      ...(typeof t?.signedIn === 'boolean' ? { signedIn: t.signedIn } : {}),
    };
  }
  return out;
}

// --- the aggregator ---------------------------------------------------------

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  return Promise.race([promise.then(() => true, () => true), timeout]).finally(() => clearTimeout(timer));
}

function stableKey(state) {
  const { now: _now, ...rest } = state;
  return JSON.stringify(rest);
}

/**
 * @param {object} [o]
 * @param {Record<string, any>|any[]} [o.adapters]  injected adapters (tests); default: load ./adapters/<tool>.mjs
 * @param {URL|string} [o.adapterDir]
 * @param {() => any[]} [o.getTasks]                tasks, newest first (the launcher's list)
 * @param {Record<string, any>} [o.tools]           result of detectTools()
 * @param {object} [o.mock]                         a createMock() instance: use it instead of adapters
 * @param {object} [o.meta]                         names and groups (createMetaStore / createMockMeta). With a
 *                                                  mock source the generator supplies them itself; the store is
 *                                                  then only listened to, so a change shows up at once.
 * @param {() => number} [o.now]
 */
export function createOfficeState({
  adapters,
  adapterDir = new URL('./adapters/', import.meta.url),
  getTasks = () => [],
  tools = {},
  mock = null,
  meta = null,
  now: clock = Date.now,
  home = os.homedir(),
  pollMs = mock ? 1000 : POLL_MS,
  adapterTimeoutMs = ADAPTER_TIMEOUT_MS,
  heartbeatMs = HEARTBEAT_MS,
  reloadCheckMs = ADAPTER_RELOAD_CHECK_MS,
  log = () => {},
} = {}) {
  const namer = createNamer();
  /** @type {Map<string, {adapter: any, inFlight: Promise<any>|null, sessions: any[], error: string|null, loadedKey: string, nextLoadAt: number, attempts: number}>} */
  const slots = new Map(TOOLS.map((tool) => [tool, { adapter: null, inFlight: null, sessions: [], error: null, loadedKey: '', nextLoadAt: 0, attempts: 0 }]));
  const injected = Boolean(adapters);
  if (injected) {
    const list = Array.isArray(adapters) ? adapters : Object.entries(adapters).map(([tool, a]) => ({ tool, ...a, listSessions: a.listSessions, getTranscript: a.getTranscript }));
    for (const a of list) if (a && slots.has(a.tool)) slots.get(a.tool).adapter = a;
  }

  let toolInfo = tools;
  const listeners = new Set();
  let lastKey = '';
  let lastEmitAt = 0;
  let current = null;
  let pollTimer = null;
  let beatTimer = null;
  let refreshTimer = null;
  let polling = null;
  let running = false;
  /** @type {Map<string, {ok: boolean, at: number}>} */
  const dirCache = new Map();

  function dirExists(dir, t) {
    const hit = dirCache.get(dir);
    if (hit && t - hit.at < 30_000) return hit.ok;
    let ok = false;
    try {
      ok = fs.statSync(dir).isDirectory();
    } catch {
      ok = false;
    }
    if (dirCache.size > 500) dirCache.clear();
    dirCache.set(dir, { ok, at: t });
    return ok;
  }

  function recentDirs(sessions, tasks, t) {
    const seen = [];
    for (const s of sessions) if (s.cwd) seen.push([s.cwd, s.lastActivityAt]);
    for (const task of tasks) if (task.cwd) seen.push([task.cwd, task.startedAt || 0]);
    seen.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const out = [];
    for (const [dir] of seen) {
      if (out.includes(dir) || !path.isAbsolute(dir) || !dirExists(dir, t)) continue;
      out.push(dir);
      if (out.length >= MAX_RECENT_DIRS) break;
    }
    return out;
  }

  function compose(t = clock()) {
    const tasks = getTasks() || [];
    if (mock) {
      const state = mock.next(t);
      return { ...state, now: t, tasks, groups: Array.isArray(state.groups) ? state.groups : [], mock: true };
    }
    const taskBySession = new Map();
    for (const task of tasks) if (task.sessionId && !taskBySession.has(task.sessionId)) taskBySession.set(task.sessionId, task.id);
    const raw = [];
    for (const tool of TOOLS) for (const s of slots.get(tool).sessions) raw.push(s && typeof s === 'object' ? { ...s, tool } : s);
    const groups = meta ? meta.groups() : [];
    const sessions = withMeta(toSessions(raw, { now: t, namer, taskBySession, home }), meta, groups);
    // Being on the floor keeps a session's name and group from being pruned.
    meta?.touch?.(sessions.map((s) => s.id), t);
    return { now: t, sessions, tasks, tools: publicTools(toolInfo), recentDirs: recentDirs(sessions, tasks, t), groups };
  }

  function emit(state) {
    lastEmitAt = clock();
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch {
        /* one bad listener must not starve the rest */
      }
    }
  }

  /** Recompose and tell subscribers if anything other than `now` changed. */
  function refresh() {
    const state = compose();
    const key = stableKey(state);
    current = state;
    if (key !== lastKey) {
      lastKey = key;
      emit(state);
      return true;
    }
    return false;
  }

  // A name or a group changed: subscribers hear about it now, not at the next poll.
  const offMeta = meta?.subscribe ? meta.subscribe(() => refresh()) : null;

  /** Coalesced refresh for bursts (a task streaming output). */
  function requestRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 150);
    refreshTimer.unref?.();
  }

  async function loadAdapter(tool, slot) {
    const t = clock();
    if (t < slot.nextLoadAt) return;
    slot.nextLoadAt = t + reloadCheckMs;
    const url = new URL(`${tool}.mjs`, adapterDir);
    let st;
    try {
      st = await fs.promises.stat(url);
    } catch {
      return; // not written yet: this tool simply has no sessions for now
    }
    const key = `${st.mtimeMs}:${st.size}`;
    if (slot.adapter && slot.loadedKey === key) return;
    try {
      slot.attempts += 1;
      // The query string makes a changed file (or a retry after a failed import) a fresh module.
      const mod = await import(`${url.href}?v=${encodeURIComponent(key)}&n=${slot.attempts}`);
      if (typeof mod.listSessions !== 'function') throw new Error('adapter does not export listSessions()');
      slot.adapter = { tool, listSessions: mod.listSessions, getTranscript: mod.getTranscript };
      slot.loadedKey = key;
      if (slot.error) log(`adapter ${tool}: loaded`); // only worth a line when it had been failing
      slot.error = null;
    } catch (err) {
      const msg = String(err?.message || err);
      if (slot.error !== msg) log(`adapter ${tool}: not usable yet (${oneLine(msg, 160)})`);
      slot.error = msg;
    }
  }

  async function pollAdapter(tool, t) {
    const slot = slots.get(tool);
    if (!injected) await loadAdapter(tool, slot);
    if (!slot.adapter) return;
    if (!slot.inFlight) {
      const adapter = slot.adapter;
      // A call that outlives the timeout keeps running; its result is used by the next poll, and no
      // second call is started on top of it.
      slot.inFlight = Promise.resolve()
        .then(() => adapter.listSessions({ now: t, maxAgeMs: IDLE_MAX_MS }))
        .then(
          (list) => {
            if (Array.isArray(list)) {
              slot.sessions = list;
              slot.error = null;
            }
          },
          (err) => {
            slot.error = String(err?.message || err); // previous result stays
          },
        )
        .finally(() => {
          slot.inFlight = null;
        });
    }
    await withTimeout(slot.inFlight, adapterTimeoutMs);
  }

  /** One full poll. Calls made while one is running join it instead of starting another. */
  function pollOnce() {
    if (polling) return polling;
    polling = (async () => {
      if (!mock) {
        const t = clock();
        await Promise.all(TOOLS.map((tool) => pollAdapter(tool, t).catch(() => {})));
      }
      refresh();
    })().finally(() => {
      polling = null;
    });
    return polling;
  }

  function schedule() {
    if (!running) return;
    pollTimer = setTimeout(async () => {
      try {
        await pollOnce();
      } finally {
        schedule();
      }
    }, pollMs);
    pollTimer.unref?.();
  }

  function start() {
    if (running) return pollOnce();
    running = true;
    beatTimer = setInterval(() => {
      if (!listeners.size || clock() - lastEmitAt < heartbeatMs) return;
      current = compose();
      lastKey = stableKey(current);
      emit(current);
    }, Math.max(250, Math.min(1000, heartbeatMs / 4)));
    beatTimer.unref?.();
    const first = pollOnce();
    schedule();
    return first;
  }

  function stop() {
    running = false;
    clearTimeout(pollTimer);
    clearInterval(beatTimer);
    clearTimeout(refreshTimer);
    refreshTimer = null;
    listeners.clear();
    offMeta?.();
  }

  function getState() {
    current = compose();
    return current;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function parseId(id) {
    const s = String(id || '').split('#')[0];
    const cut = s.indexOf(':');
    if (cut <= 0) return null;
    const tool = s.slice(0, cut);
    const nativeId = s.slice(cut + 1);
    if (!TOOLS.includes(tool) || !nativeId) return null;
    return { tool, nativeId, id: s };
  }

  function findSession(id) {
    const ref = parseId(id);
    if (!ref) return undefined;
    return (current || getState()).sessions.find((s) => s.id === ref.id);
  }

  /** @returns {Promise<any[]|null>} null when the id does not name a session of a known tool */
  async function getTranscript(id, limit = 60) {
    const ref = parseId(id);
    if (!ref) return null;
    const n = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 60));
    if (mock) return mock.transcript(ref.id, n).slice(-n);
    const adapter = slots.get(ref.tool).adapter;
    if (!adapter || typeof adapter.getTranscript !== 'function') return [];
    let result = [];
    const call = Promise.resolve()
      .then(() => {
        // `${sessionId}#${subagentId}` asks for a subagent's own transcript. Claude and Cursor take
        // `<parent>#<sub>`; a Codex subagent is its own thread, addressed by its thread id alone.
        const hash = String(id).indexOf('#');
        const sub = hash > 0 ? String(id).slice(hash + 1) : '';
        const target = !sub ? ref.nativeId : ref.tool === 'codex' ? sub : `${ref.nativeId}#${sub}`;
        return adapter.getTranscript(target, { limit: n });
      })
      .then((list) => {
        result = Array.isArray(list) ? list : [];
      });
    await withTimeout(call, 5000);
    return result
      .filter((m) => m && typeof m === 'object' && typeof m.text === 'string')
      .slice(-n)
      .map((m) => ({
        role: m.role === 'user' || m.role === 'tool' || m.role === 'system' ? m.role : 'assistant',
        text: m.text.length > 2000 ? m.text.slice(0, 1999) + '…' : m.text,
        ts: num(m.ts, 0),
        ...(m.toolName ? { toolName: String(m.toolName) } : {}),
      }));
  }

  function setTools(next) {
    toolInfo = next || {};
    if (running) refresh();
  }

  function adapterStatus() {
    /** @type {any} */
    const out = {};
    for (const [tool, slot] of slots) out[tool] = { loaded: Boolean(slot.adapter), sessions: slot.sessions.length, ...(slot.error ? { error: oneLine(slot.error, 200) } : {}) };
    return out;
  }

  return { start, stop, getState, subscribe, getTranscript, findSession, refresh, requestRefresh, pollOnce, setTools, adapterStatus };
}
