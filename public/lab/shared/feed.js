// Shared data feed for lab concept pages.
// Live when served by the Agent Office server (SSE at /api/events); otherwise, or with ?mock=1, an in-browser mock.
//
//   const feed = connectFeed({ onState(state) {}, onMode(mode) {} });   // mode: 'connecting' | 'live' | 'mock' | 'reconnecting'
//   feed.mode
//   await feed.launch({ tool, prompt, cwd, permission })   -> { ok: true, task } | { ok: false, error }
//   await feed.message(sessionId, prompt, permission?)     -> { ok: true, task } | { ok: false, error }
//   await feed.transcript(sessionId, limit?)               -> Message[]
//   await feed.stop(taskId)                                -> { ok } | { ok: false, error }
//   feed.close()
//
// State shape: OfficeState from server/contract.mjs.

import { createMock } from '../../js/mock-state.js';

export function connectFeed({ onState = () => {}, onMode = () => {} } = {}) {
  const params = new URLSearchParams(location.search);
  const forceMock = params.has('mock');
  const token = document.querySelector('meta[name="office-token"]')?.content || '';

  let mode = 'connecting';
  let es = null;
  let mock = null;
  let mockTimer = null;
  let mockTasks = [];
  let gotLive = false;
  let closed = false;

  const setMode = (m) => {
    if (mode === m) return;
    mode = m;
    api.mode = m;
    try {
      onMode(m);
    } catch {}
  };

  function startMock() {
    if (mock) return;
    mock = createMock();
    setMode('mock');
    const tick = () => {
      const now = Date.now();
      const state = mock.next(now);
      mockTasks = mockTasks.map((t) => {
        const age = now - t.startedAt;
        if (t.status === 'stopped') return t;
        if (age > 20_000) return { ...t, status: 'done', endedAt: t.startedAt + 20_000, exitCode: 0, outputTail: t.outputTail.includes('Done.') ? t.outputTail : t.outputTail + '\nDone.' };
        if (age > 2_000) return { ...t, status: 'running', outputTail: 'Starting…\n→ Read README.md\n→ Bash: git status' };
        return t;
      });
      state.tasks = mockTasks;
      onState(state);
    };
    tick();
    mockTimer = setInterval(tick, 1000);
  }

  function startLive() {
    es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      try {
        const state = JSON.parse(ev.data);
        gotLive = true;
        setMode('live');
        onState(state);
      } catch {}
    };
    es.onerror = () => {
      if (closed) return;
      if (!gotLive) {
        // Not being served by the office server (e.g. a plain static server): fall back to the mock.
        es.close();
        es = null;
        startMock();
      } else {
        setMode('reconnecting');
      }
    };
  }

  async function post(path, body) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: json.error || `HTTP ${res.status}` };
      return { ok: true, ...json };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  const api = {
    mode,
    async launch({ tool, prompt, cwd, permission = 'edit' }) {
      if (!prompt || !String(prompt).trim()) return { ok: false, error: 'Write a prompt first.' };
      if (mock) {
        const id = `mock-task-${mockTasks.length + 1}`;
        const sessionId = mock.add({ tool, prompt, cwd, taskId: id });
        const task = { id, tool, prompt, cwd: cwd || '', permission, status: 'starting', startedAt: Date.now(), sessionId, outputTail: 'Starting…' };
        mockTasks = [task, ...mockTasks];
        return { ok: true, task };
      }
      return post('/api/tasks', { tool, prompt, cwd, permission });
    },
    async message(sessionId, prompt, permission = 'edit') {
      if (mock) return { ok: true, task: { id: 'mock-msg', status: 'starting', resumeOf: sessionId } };
      return post(`/api/sessions/${encodeURIComponent(sessionId)}/message`, { prompt, permission });
    },
    async transcript(sessionId, limit = 60) {
      if (mock) return mock.transcript(sessionId, limit);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?limit=${limit}`);
        const json = await res.json();
        return json.messages || [];
      } catch {
        return [];
      }
    },
    async stop(taskId) {
      if (mock) {
        mockTasks = mockTasks.map((t) => (t.id === taskId ? { ...t, status: 'stopped', endedAt: Date.now() } : t));
        return { ok: true };
      }
      return post(`/api/tasks/${encodeURIComponent(taskId)}/stop`);
    },
    close() {
      closed = true;
      es?.close();
      clearInterval(mockTimer);
    },
  };

  if (forceMock) startMock();
  else startLive();
  return api;
}
