import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { FRESH_MS, IDLE_MAX_MS, MID_TURN_MAX_MS, SUBAGENT_LINGER_MS, WAITING_MAX_MS } from './contract.mjs';
import { createNamer, NAMES, SUB_NAMES } from './names.mjs';
import { createMetaStore, createMockMeta, SEEN_TOUCH_MS } from './meta.mjs';
import { createOfficeState, detectTools, projectLabel, resolveBinary, toSessions, withMeta } from './state.mjs';

const NOW = 1_800_000_000_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function raw(over = {}) {
  return {
    tool: 'claude',
    nativeId: 'n1',
    title: 'Fix the flaky test',
    cwd: '/work/shop/graph',
    turnState: 'mid',
    startedAt: NOW - 60_000,
    lastActivityAt: NOW - 1000,
    activity: { kind: 'editing', label: 'Edit totals.ts' },
    subagents: [],
    ...over,
  };
}

function sub(over = {}) {
  return { id: 'a1', label: 'Map call sites', status: 'working', activity: { kind: 'reading', label: 'Read a.ts' }, startedAt: NOW - 30_000, lastActivityAt: NOW - 2000, ...over };
}

const map = (list, extra = {}) => toSessions(list, { now: NOW, namer: createNamer(), home: '/Users/me', ...extra });

test('projectLabel', () => {
  const home = '/Users/me';
  assert.equal(projectLabel('/Users/me/projects/shop/graph', home), 'graph');
  assert.equal(projectLabel('/Users/me/projects/shop/graph/', home), 'graph');
  assert.equal(projectLabel('/Users/me', home), '~');
  assert.equal(projectLabel('/Users/me/', home), '~');
  assert.equal(projectLabel('/Users/me/projects/shop/.worktrees/tier-meter', home), 'shop/tier-meter');
  assert.equal(projectLabel('/Users/me/projects/shop/.worktrees/tier-meter/packages/ui', home), 'shop/tier-meter');
  assert.equal(projectLabel('/Users/me/projects/shop/.claude/worktrees/fix-x', home), 'shop/fix-x');
  assert.equal(projectLabel('/Users/me/.cursor/worktrees/shop/fix-x', home), 'shop/fix-x');
  assert.equal(projectLabel('/Users/me/.codex/worktrees/ab12/shop', home), 'shop');
  assert.equal(projectLabel('/Users/me/.claude/worktrees/solo', home), 'solo');
  assert.equal(projectLabel('/srv/worktrees', home), 'worktrees');
  assert.equal(projectLabel('/', home), '/');
  assert.equal(projectLabel('', home), 'unknown');
});

test('maps an adapter session to a Session', () => {
  const [s] = map([raw({ branch: 'main', model: 'm', source: 'cli', lastMessage: 'hello', tokens: 1234 })], { taskBySession: new Map([['claude:n1', 'task-1']]) });
  assert.equal(s.id, 'claude:n1');
  assert.equal(s.tool, 'claude');
  assert.equal(s.nativeId, 'n1');
  assert.equal(s.project, 'graph');
  assert.equal(s.status, 'working');
  assert.equal(s.mode, 'solo');
  assert.equal(s.turnState, 'mid');
  assert.equal(s.taskId, 'task-1');
  assert.equal(s.branch, 'main');
  assert.equal(s.tokens, 1234);
  assert.equal(s.lastMessage, 'hello');
  assert.deepEqual(s.activity, { kind: 'editing', label: 'Edit totals.ts' });
  assert.deepEqual(s.subagents, []);
  assert.ok(NAMES.includes(s.name));
  assert.equal(map([raw()])[0].taskId, undefined);
});

test('status follows deriveStatus and sessions that are too old are dropped', () => {
  const cases = [
    [{ turnState: 'ended', lastActivityAt: NOW - 1000 }, 'waiting'],
    [{ turnState: 'mid', lastActivityAt: NOW - FRESH_MS - 1000 }, 'working'],
    [{ turnState: 'mid', lastActivityAt: NOW - MID_TURN_MAX_MS - 1000 }, 'idle'],
    [{ turnState: 'ended', lastActivityAt: NOW - WAITING_MAX_MS - 1000 }, 'idle'],
    [{ turnState: 'unknown', lastActivityAt: NOW - 1000 }, 'working'],
    [{ turnState: 'bogus', lastActivityAt: NOW - FRESH_MS - 1000 }, 'waiting'],
  ];
  for (const [over, status] of cases) assert.equal(map([raw(over)])[0].status, status, JSON.stringify(over));
  assert.equal(map([raw({ lastActivityAt: NOW - IDLE_MAX_MS - 1 })]).length, 0);
  assert.equal(map([raw({ lastActivityAt: 'yesterday' })]).length, 0);
  assert.equal(map([raw({ nativeId: '' }), null, 'junk', raw({ tool: 'emacs' })]).length, 0);
});

test('activity matches the status', () => {
  assert.deepEqual(map([raw({ turnState: 'ended' })])[0].activity, { kind: 'waiting', label: 'Waiting for you' });
  assert.deepEqual(map([raw({ turnState: 'ended', lastActivityAt: NOW - WAITING_MAX_MS - 1 })])[0].activity, { kind: 'idle', label: 'Idle' });
  assert.deepEqual(map([raw({ activity: { kind: 'idle', label: 'Idle' } })])[0].activity, { kind: 'thinking', label: 'Thinking' });
  assert.deepEqual(map([raw({ activity: null })])[0].activity, { kind: 'thinking', label: 'Thinking' });
  assert.equal(map([raw({ activity: { kind: 'running', label: 'x'.repeat(200) } })])[0].activity.label.length, 60);
});

test('subagents: finished ones linger, then leave; working ones make an orchestrator', () => {
  const lingering = sub({ id: 'done-recent', status: 'done', endedAt: NOW - SUBAGENT_LINGER_MS + 5000 });
  const gone = sub({ id: 'done-old', status: 'done', endedAt: NOW - SUBAGENT_LINGER_MS - 5000 });
  const failed = sub({ id: 'failed-recent', status: 'failed', endedAt: NOW - 1000 });
  const stalled = sub({ id: 'zombie', status: 'working', lastActivityAt: NOW - MID_TURN_MAX_MS - 1000 });

  const [solo] = map([raw({ subagents: [gone, stalled] })]);
  assert.equal(solo.mode, 'solo');
  assert.deepEqual(solo.subagents, []);

  const [lingerOnly] = map([raw({ turnState: 'ended', lastActivityAt: NOW - 60_000, subagents: [lingering, failed, gone] })]);
  assert.equal(lingerOnly.mode, 'orchestrator');
  assert.equal(lingerOnly.status, 'waiting', 'lingering subagents do not make the parent busy');
  assert.deepEqual(lingerOnly.subagents.map((s) => s.id).sort(), ['done-recent', 'failed-recent']);
  assert.deepEqual(lingerOnly.subagents.find((s) => s.id === 'failed-recent').activity, { kind: 'idle', label: 'Failed' });
  assert.ok(lingerOnly.subagents.every((s) => SUB_NAMES.includes(s.name)));

  // Parent looks idle on its own, but a subagent is still at it.
  const [busy] = map([raw({ turnState: 'ended', lastActivityAt: NOW - WAITING_MAX_MS - 1000, activity: { kind: 'idle', label: 'Idle' }, subagents: [sub(), lingering] })]);
  assert.equal(busy.status, 'working');
  assert.equal(busy.turnState, 'mid');
  assert.equal(busy.mode, 'orchestrator');
  assert.deepEqual(busy.activity, { kind: 'delegating', label: 'Running 1 agent' });
  assert.equal(busy.subagents.length, 2);
});

test('sessions are sorted by start time, then id', () => {
  const out = map([
    raw({ nativeId: 'c', startedAt: 300 + NOW - 99999 }),
    raw({ tool: 'codex', nativeId: 'b', startedAt: 100 + NOW - 99999 }),
    raw({ nativeId: 'a', startedAt: 100 + NOW - 99999 }),
    raw({ tool: 'cursor', nativeId: 'z', startedAt: 50 + NOW - 99999 }),
  ]);
  assert.deepEqual(out.map((s) => s.id), ['cursor:z', 'claude:a', 'codex:b', 'claude:c']);
});

function fakeAdapter(tool, sessions) {
  const a = { tool, calls: 0, sessions, listSessions: async () => (a.calls++, a.sessions), getTranscript: async (id, { limit }) => [{ role: 'user', text: `hi ${id} ${limit}`, ts: 1 }] };
  return a;
}

test('aggregates adapters; one that throws or is missing does not stop the others', async () => {
  const t = Date.now();
  const claude = fakeAdapter('claude', [raw({ startedAt: t - 5000, lastActivityAt: t - 500 })]);
  const codex = { tool: 'codex', listSessions: async () => { throw new Error('boom'); } };
  const office = createOfficeState({ adapters: [claude, codex], getTasks: () => [{ id: 'task-9', sessionId: 'claude:n1', cwd: os.tmpdir(), startedAt: t }] });
  await office.pollOnce();
  const state = office.getState();
  assert.deepEqual(state.sessions.map((s) => s.id), ['claude:n1']);
  assert.equal(state.sessions[0].taskId, 'task-9');
  assert.equal(state.tasks.length, 1);
  assert.deepEqual(state.tools, { claude: { available: false }, codex: { available: false }, cursor: { available: false } });
  assert.ok(Math.abs(state.now - Date.now()) < 2000);
  assert.equal(office.adapterStatus().codex.error, 'boom');
  assert.equal(office.findSession('claude:n1').id, 'claude:n1');
  assert.equal(office.findSession('claude:nope'), undefined);
});

test('recentDirs: existing directories only, most recent first, no duplicates, capped', async () => {
  const t = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-dirs-'));
  const many = Array.from({ length: 30 }, (_, i) => {
    const d = path.join(dir, `d${i}`);
    fs.mkdirSync(d);
    return raw({ nativeId: `m${i}`, cwd: d, lastActivityAt: t - 10_000 - i * 1000 });
  });
  const claude = fakeAdapter('claude', [
    raw({ nativeId: 'gone', cwd: path.join(dir, 'does-not-exist'), lastActivityAt: t }),
    raw({ nativeId: 'dup', cwd: path.join(dir, 'd3'), lastActivityAt: t - 100 }),
    raw({ nativeId: 'nocwd', cwd: '', lastActivityAt: t }),
    ...many,
  ]);
  const taskDir = path.join(dir, 'from-task');
  fs.mkdirSync(taskDir);
  const office = createOfficeState({ adapters: [claude], getTasks: () => [{ id: 'task-1', cwd: taskDir, startedAt: t + 1000 }] });
  await office.pollOnce();
  const { recentDirs } = office.getState();
  assert.equal(recentDirs.length, 20);
  assert.equal(recentDirs[0], taskDir);
  assert.equal(recentDirs[1], path.join(dir, 'd3'));
  assert.equal(recentDirs[2], path.join(dir, 'd0'));
  assert.equal(new Set(recentDirs).size, 20);
  assert.ok(!recentDirs.includes(path.join(dir, 'does-not-exist')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a slow adapter times out without stalling the rest, keeps its last result, and is never called twice at once', async () => {
  const t = Date.now();
  let release;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const slow = {
    tool: 'codex',
    listSessions: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls > 1) await new Promise((r) => (release = r));
      active -= 1;
      return [raw({ tool: 'codex', nativeId: `v${calls}`, lastActivityAt: t })];
    },
  };
  const fast = fakeAdapter('claude', [raw({ lastActivityAt: t })]);
  const office = createOfficeState({ adapters: [slow, fast], adapterTimeoutMs: 80 });
  await office.pollOnce();
  assert.deepEqual(office.getState().sessions.map((s) => s.id).sort(), ['claude:n1', 'codex:v1']);

  const started = Date.now();
  await office.pollOnce(); // codex hangs
  assert.ok(Date.now() - started < 1000, 'the poll returned at the timeout');
  assert.deepEqual(office.getState().sessions.map((s) => s.id).sort(), ['claude:n1', 'codex:v1'], 'previous codex result kept');
  await office.pollOnce(); // still hanging: no second call on top
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.equal(fast.calls, 3);

  release();
  await sleep(20);
  await office.pollOnce();
  assert.ok(office.getState().sessions.some((s) => s.id === 'codex:v2'), 'the late result is used');
  assert.equal(maxActive, 1);
});

test('overlapping pollOnce calls share one poll', async () => {
  const a = fakeAdapter('claude', []);
  const office = createOfficeState({ adapters: [a] });
  await Promise.all([office.pollOnce(), office.pollOnce(), office.pollOnce()]);
  assert.equal(a.calls, 1);
});

test('subscribe fires only on a real change, plus a heartbeat', async () => {
  const t = Date.now();
  const a = fakeAdapter('claude', [raw({ startedAt: t - 5000, lastActivityAt: t - 500 })]);
  const office = createOfficeState({ adapters: [a], pollMs: 20, heartbeatMs: 400 });
  const seen = [];
  const unsubscribe = office.subscribe((s) => seen.push(s));
  await office.start();
  assert.equal(seen.length, 1, 'first state is announced');
  await sleep(150); // several polls, nothing changed
  assert.equal(seen.length, 1, 'no change, no call');
  a.sessions = [raw({ startedAt: t - 5000, lastActivityAt: t - 100, title: 'New title' })];
  await sleep(100);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].sessions[0].title, 'New title');
  await sleep(700);
  assert.ok(seen.length >= 3, 'heartbeat re-sends the state');
  assert.ok(seen.at(-1).now > seen[1].now);
  const count = seen.length;
  unsubscribe();
  a.sessions = [];
  await sleep(100);
  assert.equal(seen.length, count);
  office.stop();
});

test('refresh picks up task changes without waiting for a poll', async () => {
  let tasks = [];
  const office = createOfficeState({ adapters: [fakeAdapter('claude', [])], getTasks: () => tasks });
  await office.pollOnce();
  const seen = [];
  office.subscribe((s) => seen.push(s));
  assert.equal(office.refresh(), false);
  tasks = [{ id: 'task-1', status: 'running', cwd: '', startedAt: 1, outputTail: 'x' }];
  assert.equal(office.refresh(), true);
  assert.equal(seen.at(-1).tasks[0].id, 'task-1');
});

test('getTranscript routes by tool and rejects ids it cannot place', async () => {
  const office = createOfficeState({ adapters: [fakeAdapter('claude', [])] });
  assert.deepEqual(await office.getTranscript('claude:abc', 7), [{ role: 'user', text: 'hi abc 7', ts: 1 }]);
  // A subagent id asks the adapter for that subagent's own transcript.
  assert.deepEqual(await office.getTranscript('claude:abc#sub-1', 7), [{ role: 'user', text: 'hi abc#sub-1 7', ts: 1 }]);
  assert.deepEqual(await office.getTranscript('codex:abc', 7), [], 'adapter not there yet');
  assert.equal(await office.getTranscript('emacs:abc'), null);
  assert.equal(await office.getTranscript('nonsense'), null);
});

test('adapter files are imported when they appear, and a broken one is retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-adapters-'));
  const t = Date.now();
  const lines = [];
  const office = createOfficeState({ adapterDir: pathToFileURL(dir + path.sep), reloadCheckMs: 0, log: (l) => lines.push(l) });
  await office.pollOnce();
  assert.deepEqual(office.getState().sessions, []);
  assert.deepEqual(office.adapterStatus().claude, { loaded: false, sessions: 0 });

  fs.writeFileSync(path.join(dir, 'claude.mjs'), 'export const tool = "claude"; export async function listSessions( { broken');
  await office.pollOnce();
  assert.equal(office.adapterStatus().claude.loaded, false);
  assert.ok(office.adapterStatus().claude.error);

  const good = (id) => `export const tool = 'claude';
export async function listSessions({ now }) { return [{ tool: 'claude', nativeId: '${id}', title: 't', cwd: '', turnState: 'mid', startedAt: ${t}, lastActivityAt: now, activity: { kind: 'thinking', label: 'Thinking' }, subagents: [] }]; }
export async function getTranscript() { return []; }
`;
  fs.writeFileSync(path.join(dir, 'claude.mjs'), good('first'));
  await office.pollOnce();
  assert.deepEqual(office.getState().sessions.map((s) => s.id), ['claude:first']);

  // A new version of the file replaces the loaded adapter.
  await sleep(15);
  fs.writeFileSync(path.join(dir, 'claude.mjs'), good('second-version'));
  await office.pollOnce();
  assert.deepEqual(office.getState().sessions.map((s) => s.id), ['claude:second-version']);
  assert.ok(lines.some((l) => l.includes('not usable yet')) && lines.some((l) => l.includes('loaded')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mock source: state comes from the generator, tasks from the launcher', async () => {
  const { createMock } = await import('../public/js/mock-state.js');
  const mock = createMock();
  const office = createOfficeState({ mock, getTasks: () => [{ id: 'task-m', status: 'running' }] });
  const state = office.getState();
  assert.equal(state.mock, true);
  assert.ok(state.sessions.length >= 8);
  assert.equal(state.tasks[0].id, 'task-m');
  assert.ok((await office.getTranscript('claude:mock-01', 5)).length > 0);
});

test('detectTools finds CLIs on PATH and in ~/.local/bin and reads their version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tools-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const script = (out) => `#!/bin/sh\necho "${out}"\n`;
  fs.writeFileSync(path.join(bin, 'claude'), script('9.8.7 (Claude Code)'), { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'cursor-agent'), script('2026.01.02-abc123'), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), 'not executable', { mode: 0o644 });
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const opts = { env, home, execPath: path.join(root, 'node-bin', 'node') };

  assert.equal(resolveBinary('claude', opts), path.join(bin, 'claude'));
  assert.equal(resolveBinary('codex', opts), null);
  const tools = await detectTools(opts);
  assert.deepEqual(tools.claude, { available: true, path: path.join(bin, 'claude'), version: '9.8.7' });
  assert.deepEqual(tools.cursor, { available: true, path: path.join(home, '.local', 'bin', 'cursor-agent'), version: '2026.01.02-abc123' });
  assert.deepEqual(tools.codex, { available: false });

  const office = createOfficeState({ adapters: [], tools });
  assert.deepEqual(office.getState().tools, { claude: { available: true, version: '9.8.7' }, codex: { available: false }, cursor: { available: true, version: '2026.01.02-abc123' } });
  fs.rmSync(root, { recursive: true, force: true });
});

// --- names and groups ---------------------------------------------------------

function metaFixture(opts = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-state-meta-')));
  const file = path.join(root, 'meta.json');
  return { root, file, store: createMetaStore({ file, ...opts }), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('withMeta attaches the label and the resolved group; without a store sessions are left alone', () => {
  const f = metaFixture();
  const shop = f.store.createGroup({ name: 'Shop', autoDirs: ['/work/shop'] });
  const side = f.store.createGroup({ name: 'Side' });
  f.store.setSessionMeta('claude:named', { label: 'Port totals' });
  f.store.setSessionMeta('claude:moved', { label: 'Moved', groupId: side.id });
  f.store.setSessionMeta('claude:pinned', { groupId: 'none' });
  const sessions = map([
    raw({ nativeId: 'named', cwd: '/work/shop/graph', startedAt: NOW - 5000 }),
    raw({ nativeId: 'moved', cwd: '/work/shop/graph', startedAt: NOW - 4000 }),
    raw({ nativeId: 'pinned', cwd: '/work/shop', startedAt: NOW - 3000 }),
    raw({ nativeId: 'auto', cwd: '/work/shop', startedAt: NOW - 2000 }),
    raw({ nativeId: 'near-miss', cwd: '/work/shopping', startedAt: NOW - 1000 }),
    raw({ nativeId: 'no-cwd', cwd: '', startedAt: NOW - 500 }),
  ]);
  const out = withMeta(sessions, f.store);
  const pick = (s) => ({ id: s.id, label: s.label, groupId: s.groupId, hasLabel: 'label' in s, hasGroup: 'groupId' in s });
  assert.deepEqual(out.map(pick), [
    { id: 'claude:named', label: 'Port totals', groupId: shop.id, hasLabel: true, hasGroup: true },
    { id: 'claude:moved', label: 'Moved', groupId: side.id, hasLabel: true, hasGroup: true },
    { id: 'claude:pinned', label: undefined, groupId: undefined, hasLabel: false, hasGroup: false },
    { id: 'claude:auto', label: undefined, groupId: shop.id, hasLabel: false, hasGroup: true },
    { id: 'claude:near-miss', label: undefined, groupId: undefined, hasLabel: false, hasGroup: false },
    { id: 'claude:no-cwd', label: undefined, groupId: undefined, hasLabel: false, hasGroup: false },
  ]);
  assert.equal(out[0].title, 'Fix the flaky test', 'the tool title stays available next to the label');
  assert.equal(out[0].name, sessions[0].name);
  assert.ok(!('label' in sessions[0]), 'the input is not modified');
  assert.equal(withMeta(sessions, null), sessions);
  f.store.close();
  f.cleanup();
});

test('state carries groups (sorted by order) and each session its label and group', async () => {
  const f = metaFixture();
  const t = Date.now();
  const adapter = fakeAdapter('claude', [raw({ nativeId: 'a', cwd: '/work/shop/graph', startedAt: t - 5000, lastActivityAt: t - 500 }), raw({ nativeId: 'b', cwd: '/elsewhere', startedAt: t - 4000, lastActivityAt: t - 400 })]);
  const office = createOfficeState({ adapters: [adapter], meta: f.store });
  await office.pollOnce();
  assert.deepEqual(office.getState().groups, []);
  assert.ok(!('label' in office.getState().sessions[0]) && !('groupId' in office.getState().sessions[0]));

  const second = f.store.createGroup({ name: 'Second', autoDirs: ['/work/shop'] });
  const first = f.store.createGroup({ name: 'First', color: 'plum', autoDirs: ['/work'] });
  f.store.updateGroup(first.id, { order: 0 });
  f.store.setSessionMeta('claude:b', { label: 'Elsewhere', groupId: second.id });
  const state = office.getState();
  assert.deepEqual(state.groups, [
    { id: first.id, name: 'First', color: 'plum', autoDirs: ['/work'], order: 0 },
    { id: second.id, name: 'Second', color: 'gold', autoDirs: ['/work/shop'], order: 1 },
  ]);
  assert.deepEqual(state.sessions.map((s) => [s.id, s.label, s.groupId]), [
    ['claude:a', undefined, first.id],
    ['claude:b', 'Elsewhere', second.id],
  ]);
  assert.equal(office.findSession('claude:b').label, 'Elsewhere');

  f.store.deleteGroup(first.id);
  assert.deepEqual(office.getState().sessions.map((s) => s.groupId), [second.id, second.id]);
  f.store.setSessionMeta('claude:a', { groupId: 'none' });
  f.store.deleteGroup(second.id);
  const after = office.getState();
  assert.deepEqual(after.groups, []);
  assert.deepEqual(after.sessions.map((s) => [s.label, s.groupId]), [[undefined, undefined], ['Elsewhere', undefined]]);
  // JSON is what the browser gets: no `label: undefined` keys in it either way.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(after.sessions[0]))).filter((k) => k === 'label' || k === 'groupId'), []);

  // No store at all: the contract still promises `groups`.
  const bare = createOfficeState({ adapters: [adapter] });
  await bare.pollOnce();
  assert.deepEqual(bare.getState().groups, []);
  f.store.close();
  f.cleanup();
});

test('a name or group change reaches subscribers at once, without a poll', async () => {
  const f = metaFixture();
  const t = Date.now();
  const adapter = fakeAdapter('claude', [raw({ nativeId: 'a', cwd: '/work/shop', startedAt: t - 5000, lastActivityAt: t - 500 })]);
  const office = createOfficeState({ adapters: [adapter], meta: f.store }); // never started: no poll timer, no heartbeat
  await office.pollOnce();
  const seen = [];
  office.subscribe((s) => seen.push(s));

  const g = f.store.createGroup({ name: 'Shop' });
  assert.equal(seen.length, 1, 'told synchronously');
  assert.deepEqual(seen[0].groups.map((x) => x.name), ['Shop']);
  f.store.setSessionMeta('claude:a', { label: 'Named', groupId: g.id });
  assert.equal(seen.length, 2);
  assert.deepEqual([seen[1].sessions[0].label, seen[1].sessions[0].groupId], ['Named', g.id]);
  f.store.updateGroup(g.id, { autoDirs: ['/work/shop'], color: 'sky' });
  assert.equal(seen.length, 3);
  f.store.setSessionMeta('claude:a', { groupId: null });
  assert.equal(seen.length, 3, 'no explicit choice any more, but the folder rule gives the same group: nothing to announce');
  assert.equal(office.getState().sessions[0].groupId, g.id);
  f.store.setSessionMeta('claude:a', { groupId: 'none' });
  assert.equal(seen.at(-1).sessions[0].groupId, undefined);
  f.store.deleteGroup(g.id);
  assert.deepEqual(seen.at(-1).groups, []);
  const count = seen.length;

  // Meta for a session that is not on the floor changes nothing anyone can see: nobody is woken up.
  f.store.setSessionMeta('codex:not-here', { label: 'For later' });
  assert.equal(seen.length, count);

  office.stop();
  f.store.setSessionMeta('claude:a', { label: 'After stop' });
  assert.equal(seen.length, count, 'a stopped office no longer listens to the store');
  f.store.close();
  f.cleanup();
});

test('composing the state marks named sessions as seen (hourly at most)', async () => {
  let clock = 1_800_000_000_000;
  const start = clock;
  const f = metaFixture({ now: () => clock });
  f.store.setSessionMeta('claude:a', { label: 'On the floor' });
  f.store.setSessionMeta('claude:away', { label: 'Not on the floor' });
  const adapter = fakeAdapter('claude', [raw({ nativeId: 'a', startedAt: start - 5000, lastActivityAt: start - 500 })]);
  const office = createOfficeState({ adapters: [adapter], meta: f.store, now: () => clock });
  await office.pollOnce();
  const seenAt = (id) => {
    f.store.flush();
    return JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions[id].seenAt;
  };
  clock = start + 60_000;
  office.getState();
  assert.equal(seenAt('claude:a'), start, 'a minute later: not rewritten');
  clock = start + SEEN_TOUCH_MS + 1;
  adapter.sessions = [raw({ nativeId: 'a', startedAt: start - 5000, lastActivityAt: clock - 500 })];
  await office.pollOnce();
  assert.equal(seenAt('claude:a'), clock);
  assert.equal(seenAt('claude:away'), start);
  f.store.close();
  f.cleanup();
});

test('mock source: names and groups come from the generator and the file store is not involved', async () => {
  const { createMock } = await import('../public/js/mock-state.js');
  const mock = createMock();
  const meta = createMockMeta(mock);
  const office = createOfficeState({ mock, meta });
  const state = office.getState();
  assert.deepEqual(state.groups.map((g) => g.id), ['g-checkout', 'g-ios', 'g-cleanup']);
  const riko = state.sessions.find((s) => s.id === 'claude:mock-01');
  assert.deepEqual([riko.label, riko.groupId], ['Cart totals port', 'g-checkout']);
  assert.equal(state.sessions.find((s) => s.id === 'codex:mock-03').groupId, 'g-ios', 'by folder');

  const seen = [];
  office.subscribe((s) => seen.push(s));
  const g = meta.createGroup({ name: 'Research' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].groups.at(-1).name, 'Research');
  meta.setSessionMeta('claude:mock-01', { label: 'Renamed', groupId: g.id });
  const again = seen.at(-1).sessions.find((s) => s.id === 'claude:mock-01');
  assert.deepEqual([again.label, again.groupId], ['Renamed', g.id]);
  meta.setSessionMeta('codex:mock-03', { groupId: 'none' });
  assert.equal(seen.at(-1).sessions.find((s) => s.id === 'codex:mock-03').groupId, undefined);
  meta.deleteGroup(g.id);
  assert.equal(office.getState().sessions.find((s) => s.id === 'claude:mock-01').groupId, undefined);
  office.stop();
});
