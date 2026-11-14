// Data layer. Two interchangeable back ends behind one interface:
//   live — the local server (SSE /api/events with reconnect + backoff, JSON fetches, X-Office-Token on POSTs)
//   mock — public/js/mock-state.js running in the browser (index.html?mock=1); nothing touches the network
//
// createApi({ mock }) -> {
//   mode: 'live'|'mock',
//   start(onState, onConn)        onConn({ status: 'connecting'|'live'|'reconnecting'|'demo', retryAt?, error? })
//   retryNow()
//   getMeta() -> { permissionNotes, port, mock }
//   getTranscript(sessionId, limit) -> Message[]
//   getDirs(path) -> { path, parent, dirs }
//   startTask({ tool, prompt, cwd, permission, model?, label?, groupId? }) -> Task
//   sendMessage(sessionId, { prompt, permission, label?, groupId? }) -> Task
//   stopTask(taskId) -> Task
//   setSessionMeta(sessionId, { label?, groupId? }) -> { id, label?, groupId? }     naming and grouping
//   createGroup({ name, color?, autoDirs? }) -> Group
//   updateGroup(groupId, { name?, color?, autoDirs?, order? }) -> Group
//   deleteGroup(groupId) -> { ok: true }
//   debug                          mock only: { drop(), restore(), empty(bool), signOut(tool, bool) }
// }
// A server that predates naming and grouping answers those four with 404: the error carries
// `status: 404` and `unsupported: true` so the UI can say so in place instead of breaking.

export function createApi({ mock = false } = {}) {
  return mock ? createMockApi() : createLiveApi();
}

// ---------------------------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------------------------

function readToken() {
  // The server injects the token; tolerate a duplicate tag or an unreplaced placeholder.
  const metas = document.querySelectorAll('meta[name="office-token"]');
  for (const m of metas) {
    const v = (m.getAttribute('content') || '').trim();
    if (v && !/^(\{\{.*\}\}|__.*__|%.*%)$/.test(v)) return v;
  }
  return '';
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  let msg = '';
  if (text) {
    try {
      const j = JSON.parse(text);
      const m = j && (j.error?.message || j.error || j.message);
      if (m) msg = String(m);
    } catch { /* not json */ }
    if (!msg && text.length < 300 && !/^\s*</.test(text)) msg = text.trim();
  }
  const err = new Error(msg || `${res.status} ${res.statusText || 'request failed'}`.trim());
  err.status = res.status;
  return err;
}

function createLiveApi() {
  const BACKOFF = [1000, 2000, 4000, 8000, 15000];
  const STALE_MS = 20000; // server promises an event at least every 5s
  let onState = () => {};
  let onConn = () => {};
  let es = null;
  let attempt = 0;
  let retryTimer = 0;
  let staleTimer = 0;
  let stopped = false;

  async function getJSON(url) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch {
      throw new Error("Can't reach the office server.");
    }
    if (!res.ok) throw await readError(res);
    return res.json();
  }

  async function postJSON(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Office-Token': readToken() },
        body: JSON.stringify(body || {}),
      });
    } catch {
      throw new Error("Can't reach the office server.");
    }
    if (!res.ok) throw await readError(res);
    return res.json();
  }

  function armStale() {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => fail('No updates from the server.'), STALE_MS);
  }

  function gotState(state) {
    if (!state || !Array.isArray(state.sessions)) return;
    attempt = 0;
    armStale();
    onConn({ status: 'live' });
    onState(state);
  }

  function fail(error) {
    if (stopped) return;
    clearTimeout(staleTimer);
    clearTimeout(retryTimer);
    if (es) { es.close(); es = null; }
    const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt += 1;
    onConn({ status: 'reconnecting', retryAt: Date.now() + delay, error });
    retryTimer = setTimeout(connect, delay);
  }

  async function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    if (es) { es.close(); es = null; }
    // A plain fetch first: it fails fast and gives a readable error, EventSource does neither.
    try {
      gotState(await getJSON('/api/state'));
    } catch (e) {
      fail(e.status ? `Something is answering here, but not like the office server (${e.message}).` : e.message);
      return;
    }
    if (stopped) return;
    try {
      es = new EventSource('/api/events');
    } catch {
      fail('Live updates are not available.');
      return;
    }
    es.onmessage = (ev) => {
      try { gotState(JSON.parse(ev.data)); } catch { /* skip a malformed frame */ }
    };
    es.onerror = () => fail('Lost the connection to the office server.');
  }

  return {
    mode: 'live',
    start(stateCb, connCb) {
      onState = stateCb;
      onConn = connCb;
      onConn({ status: 'connecting' });
      connect();
    },
    retryNow() {
      attempt = 0;
      onConn({ status: 'connecting' });
      connect();
    },
    async getMeta() {
      try { return await getJSON('/api/meta'); } catch { return {}; }
    },
    async getTranscript(sessionId, limit = 60) {
      const j = await getJSON(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?limit=${limit}`);
      return Array.isArray(j.messages) ? j.messages : [];
    },
    async getDirs(path) {
      const j = await getJSON(path ? `/api/dirs?path=${encodeURIComponent(path)}` : '/api/dirs');
      return { path: j.path || path || '', parent: j.parent ?? null, dirs: Array.isArray(j.dirs) ? j.dirs : [], truncated: !!j.truncated };
    },
    async startTask(body) {
      return (await postJSON('/api/tasks', body)).task;
    },
    async sendMessage(sessionId, body) {
      return (await postJSON(`/api/sessions/${encodeURIComponent(sessionId)}/message`, body)).task;
    },
    async stopTask(taskId) {
      return (await postJSON(`/api/tasks/${encodeURIComponent(taskId)}/stop`, {})).task;
    },
    async setSessionMeta(sessionId, patch) {
      return metaCall(() => postJSON(`/api/sessions/${encodeURIComponent(sessionId)}/meta`, patch));
    },
    async createGroup(body) {
      return (await metaCall(() => postJSON('/api/groups', body))).group;
    },
    async updateGroup(groupId, patch) {
      return (await metaCall(() => postJSON(`/api/groups/${encodeURIComponent(groupId)}`, patch))).group;
    },
    async deleteGroup(groupId) {
      return metaCall(() => postJSON(`/api/groups/${encodeURIComponent(groupId)}/delete`, {}));
    },
  };
}

/** Naming and grouping routes: turn "this server has no such route" into one readable sentence. */
async function metaCall(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && (e.status === 404 || e.status === 405)) {
      const err = new Error('This office server does not know about names and groups yet. Restart it to pick up the update.');
      err.status = e.status;
      err.unsupported = true;
      throw err;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// mock (demo mode)
// ---------------------------------------------------------------------------------------------

const MOCK_NOTES = {
  claude: {
    read: 'Runs with --permission-mode plan: it can read and propose, not change.',
    edit: 'Runs with --permission-mode acceptEdits: edits files in the folder, asks nothing else.',
    full: 'Runs with --dangerously-skip-permissions.',
  },
  codex: {
    read: 'Runs in the read-only sandbox.',
    edit: 'Runs in the workspace-write sandbox, no network.',
    full: 'Runs with the sandbox and approvals switched off.',
  },
  cursor: {
    read: 'Runs in ask mode.',
    edit: 'Runs the agent with file edits allowed.',
    full: 'Runs with --force: every command is auto-approved.',
  },
};

const LOGIN_HINT = { claude: 'claude auth login', codex: 'codex login', cursor: 'cursor-agent login' };

const MOCK_OUTPUT = [
  'Reading the project layout…',
  'Read package.json',
  'Read README.md',
  'Grep "TODO" (14 matches in 6 files)',
  'Thinking about the smallest change that works.',
  'Edit src/index.ts (+12 −3)',
  'Bash: npm test',
  '  ✓ 48 passed, 0 failed (6.2s)',
  'Edit src/index.test.ts (+21 −0)',
  'Bash: npm run lint',
  '  no problems',
  'Writing a summary of the change.',
];

const MOCK_EXTRA_DIRS = [
  '/Users/dev/Desktop',
  '/Users/dev/Documents/notes',
  '/Users/dev/Downloads',
  '/Users/dev/projects/dotfiles',
  '/Users/dev/projects/sandbox/hello-world',
  '/Users/dev/projects/sandbox/scratch',
  '/Users/dev/projects/shop/customer-ui/src/components',
  '/Users/dev/projects/shop/customer-ui/src/pages',
  '/Users/dev/projects/shop/graph/src/resolvers',
  '/Users/dev/projects/shop/graph/test',
  '/Users/dev/projects/a-folder-with-a-really-long-name-to-prove-that-paths-truncate-nicely/nested/deeper',
];

function createMockApi() {
  let mock = null;
  let onState = () => {};
  let onConn = () => {};
  let timer = 0;
  let dropped = false;
  let empty = false;
  let seq = 0;
  const signedOut = new Set(); // debug.signOut('claude'): that CLI reports signedIn: false and its launches fail
  /** @type {any[]} */
  const tasks = [];
  const timers = new Set();
  const transcripts = new Map();

  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ended = (t) => t.status === 'done' || t.status === 'failed' || t.status === 'stopped';

  // The mock generator derives an idle session's lastActivityAt from "now", so it creeps forward every tick.
  // A real session's does not move while nothing is written: keep the first value for as long as it stays idle
  // (the shell's "unanswered" bookkeeping compares against it).
  const idleSince = new Map();

  function snapshot() {
    const s = mock.next(Date.now());
    if (empty) s.sessions = [];
    for (const x of s.sessions) {
      if (x.status !== 'idle') { idleSince.delete(x.id); continue; }
      if (!idleSince.has(x.id)) idleSince.set(x.id, x.lastActivityAt);
      x.lastActivityAt = idleSince.get(x.id);
    }
    s.tasks = tasks.map((t) => ({ ...t }));
    for (const tool of Object.keys(s.tools)) s.tools[tool] = { ...s.tools[tool], signedIn: !signedOut.has(tool) };
    return s;
  }

  function emit() {
    if (dropped) return;
    onState(snapshot());
  }

  function dirTree() {
    const set = new Set(['/']);
    const all = [...mock.next(Date.now()).recentDirs, ...MOCK_EXTRA_DIRS];
    for (const p of all) {
      const parts = p.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) set.add('/' + parts.slice(0, i).join('/'));
    }
    return set;
  }

  function runTask(task, { lines = MOCK_OUTPUT, sessionFor } = {}) {
    tasks.unshift(task);
    emit();
    later(() => {
      if (ended(task)) return;
      task.status = 'running';
      const launchFails = signedOut.has(task.tool) || (task.model && /^(bogus|nope)/i.test(task.model));
      if (sessionFor && !launchFails) task.sessionId = sessionFor(); // a launch that dies at the door never walks in
      task.outputTail = `$ ${task.tool} — ${task.permission} — ${task.cwd}\n`;
      emit();
      let i = 0;
      const crash = /^\/crash\b/.test(task.prompt);
      const die = (line) => {
        task.outputTail += line + '\n';
        task.status = 'failed';
        task.exitCode = 1;
        task.endedAt = Date.now();
        emit();
      };
      // the two launch failures worth rehearsing: a signed-out CLI and a model it does not know
      if (signedOut.has(task.tool)) return void later(() => die(`Not logged in. Run \`${LOGIN_HINT[task.tool] || 'login'}\` in a terminal, then try again.`), 700);
      if (task.model && /^(bogus|nope)/i.test(task.model)) return void later(() => die(`error: unsupported model "${task.model}" (demo: model names starting with "bogus" are rejected)`), 700);
      const step = () => {
        if (ended(task)) return;
        if (crash && i === 3) {
          task.outputTail += 'error: the agent exited unexpectedly (demo: prompts starting with /crash fail)\n';
          task.status = 'failed';
          task.exitCode = 1;
          task.endedAt = Date.now();
          emit();
          return;
        }
        if (i >= lines.length) {
          task.outputTail += 'Done.\n';
          task.status = 'done';
          task.exitCode = 0;
          task.endedAt = Date.now();
          emit();
          return;
        }
        task.outputTail = (task.outputTail + lines[i] + '\n').slice(-4000);
        i += 1;
        later(step, 1800 + Math.random() * 1600);
      };
      later(step, 900);
    }, 1400);
  }

  function validate({ prompt }) {
    if (!String(prompt || '').trim()) throw new Error('prompt is required');
    if (/^\/fail\b/.test(prompt)) throw new Error('spawn failed: agent CLI not found on PATH (demo: prompts starting with /fail are rejected)');
  }

  return {
    mode: 'mock',
    async start(stateCb, connCb) {
      onState = stateCb;
      onConn = connCb;
      onConn({ status: 'connecting' });
      try {
        const mod = await import('./mock-state.js');
        mock = mod.createMock();
      } catch (e) {
        onConn({ status: 'reconnecting', error: 'Demo data failed to load: ' + (e && e.message ? e.message : e) });
        return;
      }
      onConn({ status: 'demo' });
      emit();
      timer = setInterval(emit, 1000);
    },
    retryNow() {
      if (dropped) this.debug.restore();
    },
    async getMeta() {
      return { permissionNotes: MOCK_NOTES, port: 0, mock: true };
    },
    async getTranscript(sessionId, limit = 60) {
      await wait(180);
      // The mock regenerates timestamps on every call; keep one copy per session so the list is
      // stable, and append a line now and then so auto-refresh has something to show.
      let entry = transcripts.get(sessionId);
      if (!entry) {
        entry = { messages: mock.transcript(sessionId, limit), last: Date.now() };
        transcripts.set(sessionId, entry);
      } else if (Date.now() - entry.last > 8000) {
        entry.last = Date.now();
        const s = snapshot().sessions.find((x) => x.id === sessionId);
        if (s && s.status === 'working' && s.activity) {
          const label = s.activity.label || 'Thinking';
          entry.messages.push(s.activity.kind === 'thinking' || s.activity.kind === 'writing'
            ? { role: 'assistant', text: s.lastMessage || label, ts: Date.now() }
            : { role: 'tool', text: label, ts: Date.now(), toolName: label.split(/[ :]/)[0] });
        }
      }
      return entry.messages.slice(-limit).map((m) => ({ ...m }));
    },
    async getDirs(path) {
      await wait(120);
      const tree = dirTree();
      let p = String(path || '/Users/dev').replace(/\/+$/, '') || '/';
      if (p === '~') p = '/Users/dev';
      if (!tree.has(p)) throw new Error(`ENOENT: no such directory: ${p}`);
      const prefix = p === '/' ? '/' : p + '/';
      const dirs = [...tree]
        .filter((d) => d !== p && d.startsWith(prefix) && !d.slice(prefix.length).includes('/'))
        .map((d) => d.slice(prefix.length))
        .sort((a, b) => a.localeCompare(b));
      const parent = p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/';
      return { path: p, parent, dirs };
    },
    async startTask({ tool, prompt, cwd, permission, model, label, groupId }) {
      await wait(450);
      validate({ prompt });
      seq += 1;
      const task = {
        id: `mock-task-${seq}`, tool, prompt, cwd, permission, status: 'starting', startedAt: Date.now(), exitCode: null, outputTail: '',
        ...(model ? { model } : {}), ...(label ? { label } : {}), ...(groupId ? { groupId } : {}),
      };
      runTask(task, { sessionFor: () => mock.add({ tool, prompt, cwd, taskId: task.id, label, groupId }) });
      return { ...task };
    },
    async setSessionMeta(sessionId, patch) {
      await wait(90);
      const out = mock.setMeta(sessionId, patch || {});
      emit();
      return out;
    },
    async createGroup(body) {
      await wait(90);
      const group = mock.createGroup(body || {});
      emit();
      return group;
    },
    async updateGroup(groupId, patch) {
      await wait(90);
      const group = mock.updateGroup(groupId, patch || {});
      if (!group) throw new Error('unknown group: ' + groupId);
      emit();
      return group;
    },
    async deleteGroup(groupId) {
      await wait(90);
      mock.deleteGroup(groupId);
      emit();
      return { ok: true };
    },
    async sendMessage(sessionId, { prompt, permission = 'edit', force = false, label, groupId }) {
      await wait(450);
      validate({ prompt });
      const s = snapshot().sessions.find((x) => x.id === sessionId);
      if (!s) throw new Error('unknown session: ' + sessionId);
      if (s.status === 'working' && force !== true) {
        // same rule as the real server: never two writers on one conversation unless asked
        const err = new Error('this session is in the middle of a turn; wait for it to finish (or send "force": true)');
        err.status = 409;
        throw err;
      }
      seq += 1;
      const task = { id: `mock-task-${seq}`, tool: s.tool, prompt, cwd: s.cwd, permission, status: 'starting', startedAt: Date.now(), exitCode: null, outputTail: '', resumeOf: sessionId, sessionId };
      if (label !== undefined || groupId !== undefined) mock.setMeta(sessionId, { label, groupId });
      runTask(task, { lines: ['Resuming the session…', ...MOCK_OUTPUT.slice(4)] });
      return { ...task };
    },
    async stopTask(taskId) {
      await wait(200);
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new Error('unknown task: ' + taskId);
      if (!ended(task)) {
        task.status = 'stopped';
        task.endedAt = Date.now();
        task.exitCode = null;
        task.outputTail += '^C stopped from the office\n';
        emit();
      }
      return { ...task };
    },
    // Development helpers, reachable as window.agentOffice.api.debug in demo mode.
    debug: {
      drop() {
        dropped = true;
        onConn({ status: 'reconnecting', retryAt: Date.now() + 8000, error: 'Lost the connection to the office server. (simulated)' });
      },
      restore() {
        dropped = false;
        onConn({ status: 'demo' });
        emit();
      },
      empty(on = true) {
        empty = !!on;
        emit();
      },
      /** debug.signOut('claude') / debug.signOut('claude', false) */
      signOut(tool, on = true) {
        if (on) signedOut.add(tool); else signedOut.delete(tool);
        emit();
      },
      stop() {
        clearInterval(timer);
        for (const t of timers) clearTimeout(t);
      },
    },
  };
}
