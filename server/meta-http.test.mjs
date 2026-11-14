// The naming and grouping routes, against a real (non-mock) app with injected adapters and a temp
// meta file, and against a --mock app.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createApp, parseArgs } from './index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

let root;
let publicDir;
let metaFile;
let taskDir;
let work;
let fakeClaude;
/** @type {Awaited<ReturnType<typeof createApp>>} */
let app;
/** @type {Awaited<ReturnType<typeof createApp>>} */
let mockApp;
let mockMetaFile;

function liveSessions() {
  const t = Date.now();
  const base = { tool: 'claude', turnState: 'ended', activity: { kind: 'waiting', label: 'Waiting' }, subagents: [] };
  return [
    { ...base, nativeId: 'aaaa-1111', title: 'Port cart totals', cwd: path.join(work, 'shop', 'graph'), startedAt: t - 60_000, lastActivityAt: t - 1000 },
    { ...base, nativeId: 'bbbb-2222', title: 'Fix flaky test', cwd: path.join(work, 'shop'), startedAt: t - 50_000, lastActivityAt: t - 1000 },
    { ...base, nativeId: 'cccc-3333', title: 'Something else', cwd: path.join(work, 'shopping'), startedAt: t - 40_000, lastActivityAt: t - 1000 },
  ];
}

function startApp() {
  return createApp({
    port: 0,
    publicDir,
    metaFile,
    taskDir,
    adapters: [{ tool: 'claude', listSessions: async () => liveSessions(), getTranscript: async () => [] }],
    tools: { claude: { available: true, path: fakeClaude } },
  });
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-meta-http-')));
  publicDir = path.join(root, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  work = path.join(root, 'work');
  for (const d of ['shop/graph', 'shopping']) fs.mkdirSync(path.join(work, d), { recursive: true });
  metaFile = path.join(root, 'office', 'meta.json');
  mockMetaFile = path.join(root, 'mock-office', 'meta.json');
  taskDir = path.join(root, 'tasks');
  fakeClaude = path.join(root, 'fake-claude');
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sid = flag('--session-id') || flag('--resume');
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: sid });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: sid });
`,
    { mode: 0o755 },
  );
  app = await startApp();
  await app.listen();
  await app.office.pollOnce();
  mockApp = await createApp({ port: 0, mock: true, publicDir, metaFile: mockMetaFile });
  await mockApp.listen();
});

after(async () => {
  await app.close();
  await mockApp.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function request(reqPath, { method = 'GET', headers = {}, body, on = app } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: on.port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const post = (reqPath, payload, { headers = {}, on = app } = {}) =>
  request(reqPath, { method: 'POST', on, headers: { 'Content-Type': 'application/json', 'X-Office-Token': on.token, ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const state = async (on = app) => (await request('/api/state', { on })).json;
const sessionOf = async (id, on = app) => (await state(on)).sessions.find((s) => s.id === id);
const sid = (id) => `/api/sessions/${encodeURIComponent(id)}/meta`;
const onDisk = () => {
  app.meta.flush();
  return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
};

const ROUTES = ['/api/groups', '/api/groups/g-any', '/api/groups/g-any/delete', '/api/sessions/claude%3Aaaaa-1111/meta'];

test('the new routes have the same protections as every other POST', async () => {
  const payload = JSON.stringify({ name: 'Sneaky', label: 'Sneaky', groupId: 'none' });
  const json = { 'Content-Type': 'application/json' };
  for (const p of ROUTES) {
    // Token.
    for (const [name, headers] of [
      ['missing', json],
      ['wrong', { ...json, 'X-Office-Token': 'x'.repeat(app.token.length) }],
      ['another server\'s', { ...json, 'X-Office-Token': mockApp.token }],
    ]) {
      const res = await request(p, { method: 'POST', headers, body: payload });
      assert.equal(res.status, 403, `${name} token ${p}`);
      assert.match(res.json.error, /X-Office-Token/);
    }
    // Host.
    const host = await request(p, { method: 'POST', headers: { ...json, 'X-Office-Token': app.token, Host: 'evil.example' }, body: payload });
    assert.equal(host.status, 403, `host ${p}`);
    assert.match(host.json.error, /forbidden/);
    // Origin.
    assert.equal((await post(p, payload, { headers: { Origin: 'http://evil.example' } })).status, 403, `origin ${p}`);
    assert.equal((await post(p, payload, { headers: { Origin: `http://127.0.0.1:${app.port + 1}` } })).status, 403, `other port ${p}`);
    assert.equal((await post(p, payload, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, `sec-fetch-site ${p}`);
    // Content type, JSON, size.
    assert.equal((await post(p, payload, { headers: { 'Content-Type': 'text/plain' } })).status, 415, `content type ${p}`);
    assert.equal((await post(p, payload, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415, `form ${p}`);
    assert.equal((await post(p, '{nope')).status, 400, `bad json ${p}`);
    assert.equal((await post(p, '[1]')).status, 400, `not an object ${p}`);
    assert.equal((await post(p, JSON.stringify({ name: 'x'.repeat(70 * 1024) }))).status, 413, `too large ${p}`);
    // Method.
    const get = await request(p);
    assert.equal(get.status, 405, `GET ${p}`);
    assert.equal(get.headers.allow, 'POST');
    assert.ok(get.json.error);
  }
  const s = await state();
  assert.deepEqual(s.groups, [], 'none of that created anything');
  assert.ok(s.sessions.every((x) => !('label' in x) && !('groupId' in x)));
  assert.ok(!fs.existsSync(metaFile), 'and nothing was written');
});

test('groups: create, rename, recolour, folders, order, delete', async () => {
  const created = await post('/api/groups', { name: '  Checkout  ' });
  assert.equal(created.status, 201);
  const g = created.json.group;
  assert.match(g.id, /^g-[0-9a-f]{8}$/);
  assert.deepEqual(g, { id: g.id, name: 'Checkout', color: 'gold', autoDirs: [], order: 1 });
  const second = (await post('/api/groups', { name: 'iOS app', color: 'sky', autoDirs: [`${work}/shop/`] })).json.group;
  assert.deepEqual(second, { id: second.id, name: 'iOS app', color: 'sky', autoDirs: [path.join(work, 'shop')], order: 2 });
  assert.equal((await post('/api/groups', { name: 'Third' })).json.group.color, 'rose', 'the least used colour');
  assert.deepEqual((await state()).groups.map((x) => x.name), ['Checkout', 'iOS app', 'Third']);

  // 400s and the 409 for a taken name, each with a message.
  for (const [body, status, re] of [
    [{}, 400, /name is required/],
    [{ name: '' }, 400, /1 to 24 characters/],
    [{ name: 5 }, 400, /name is required/],
    [{ name: 'checkout' }, 409, /already a group called "checkout"/],
    [{ name: 'New', color: 'coral' }, 400, /color must be one of/],
    [{ name: 'New', autoDirs: 'nope' }, 400, /autoDirs must be an array/],
    [{ name: 'New', autoDirs: ['relative/path'] }, 400, /absolute folder paths/],
    [{ name: 'New', autoDirs: Array.from({ length: 21 }, (_, i) => `/d/${i}`) }, 400, /at most 20 folders/],
  ]) {
    const res = await post('/api/groups', body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match(res.json.error, re);
  }
  assert.equal((await state()).groups.length, 3);

  const renamed = await post(`/api/groups/${g.id}`, { name: 'Checkout flow', color: 'plum', order: 10 });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.json.group, { id: g.id, name: 'Checkout flow', color: 'plum', autoDirs: [], order: 10 });
  assert.deepEqual((await state()).groups.map((x) => x.name), ['iOS app', 'Third', 'Checkout flow'], 'state lists groups by order');
  assert.equal((await post(`/api/groups/${g.id}`, {})).json.group.name, 'Checkout flow', 'an empty patch is a no-op');
  assert.equal((await post(`/api/groups/${g.id}`, { name: 'IOS APP' })).status, 409);
  assert.equal((await post(`/api/groups/${g.id}`, { order: 'first' })).status, 400);
  assert.equal((await post(`/api/groups/${g.id}`, { name: '  ' })).status, 400);
  const missing = await post('/api/groups/g-nope', { name: 'X' });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /unknown group/);
  assert.equal((await post('/api/groups/g-nope/delete', {})).status, 404);

  const third = (await state()).groups.find((x) => x.name === 'Third');
  const gone = await post(`/api/groups/${third.id}/delete`, '');
  assert.equal(gone.status, 200, 'an empty body is fine');
  assert.deepEqual(gone.json, { ok: true });
  assert.equal((await post(`/api/groups/${third.id}/delete`, {})).status, 404, 'it is gone');
  assert.deepEqual(onDisk().groups.map((x) => x.name), ['Checkout flow', 'iOS app']);
});

test('sessions: name, group, pin to none; ids that are not on the floor work too', async () => {
  const groups = (await state()).groups;
  const flow = groups.find((x) => x.name === 'Checkout flow');
  const ios = groups.find((x) => x.name === 'iOS app'); // autoDirs: <work>/shop

  // The folder rule alone: sessions in or under <work>/shop, and not the one in <work>/shopping.
  assert.deepEqual((await state()).sessions.map((s) => [s.id, s.groupId]), [
    ['claude:aaaa-1111', ios.id],
    ['claude:bbbb-2222', ios.id],
    ['claude:cccc-3333', undefined],
  ]);

  const named = await post(sid('claude:aaaa-1111'), { label: '  Cart totals\n port ', groupId: flow.id });
  assert.equal(named.status, 200);
  assert.deepEqual(named.json, { id: 'claude:aaaa-1111', label: 'Cart totals port', groupId: flow.id });
  let s = await sessionOf('claude:aaaa-1111');
  assert.deepEqual([s.label, s.groupId, s.title], ['Cart totals port', flow.id, 'Port cart totals']);

  assert.deepEqual((await post(sid('claude:bbbb-2222'), { groupId: 'none' })).json, { id: 'claude:bbbb-2222', groupId: 'none' });
  assert.equal((await sessionOf('claude:bbbb-2222')).groupId, undefined, 'pinned to no group although its folder matches');
  assert.deepEqual((await post(sid('claude:bbbb-2222'), { groupId: null })).json, { id: 'claude:bbbb-2222' });
  assert.equal((await sessionOf('claude:bbbb-2222')).groupId, ios.id, 'back under the folder rule');

  assert.deepEqual((await post(sid('claude:aaaa-1111'), { label: 'y'.repeat(90) })).json.label, 'y'.repeat(60), 'clipped to 60');
  assert.deepEqual((await post(sid('claude:aaaa-1111'), { label: '' })).json, { id: 'claude:aaaa-1111', groupId: flow.id });
  assert.deepEqual((await post(sid('claude:aaaa-1111'), { label: 'Again' })).json, { id: 'claude:aaaa-1111', label: 'Again', groupId: flow.id });
  assert.deepEqual((await post(sid('claude:aaaa-1111'), { label: null })).json, { id: 'claude:aaaa-1111', groupId: flow.id });
  assert.deepEqual((await post(sid('claude:aaaa-1111'), {})).json, { id: 'claude:aaaa-1111', groupId: flow.id }, 'an empty patch reads back what is stored');
  assert.ok(!('label' in (await sessionOf('claude:aaaa-1111'))));

  // Not on the floor right now (or ever): accepted for every tool.
  for (const id of ['claude:0f0f0f0f-1111-4222-8333-444444444444', 'codex:019a2b3c-thread', 'cursor:chat_42.v2']) {
    const res = await post(sid(id), { label: 'For later', groupId: flow.id });
    assert.equal(res.status, 200, id);
    assert.deepEqual(res.json, { id, label: 'For later', groupId: flow.id });
  }
  assert.equal(Object.keys(onDisk().sessions).length, 4);

  for (const [id, body, status, re] of [
    ['emacs:1', { label: 'x' }, 404, /unknown session/],
    ['nocolon', { label: 'x' }, 404, /unknown session/],
    ['claude:a b', { label: 'x' }, 400, /invalid session id/],
    ['claude:aaaa-1111#sub-1', { label: 'x' }, 400, /invalid session id/],
    [`claude:${'a'.repeat(300)}`, { label: 'x' }, 400, /invalid session id/],
    ['claude:aaaa-1111', { label: 5 }, 400, /label must be a string or null/],
    ['claude:aaaa-1111', { groupId: 'g-nope' }, 400, /no such group: g-nope/],
    ['claude:aaaa-1111', { groupId: 7 }, 400, /groupId must be a string or null/],
  ]) {
    const res = await post(sid(id), body);
    assert.equal(res.status, status, `${id} ${JSON.stringify(body)}`);
    assert.match(res.json.error, re);
  }
  assert.equal((await request('/api/sessions/%zz/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': app.token }, body: '{}' })).status, 400);

  // Deleting a group ungroups the sessions that were put in it by hand.
  await post(sid('claude:cccc-3333'), { label: 'Keeps its name', groupId: flow.id });
  assert.equal((await post(`/api/groups/${flow.id}/delete`, {})).status, 200);
  s = await state();
  assert.deepEqual(s.groups.map((x) => x.id), [ios.id]);
  assert.deepEqual(s.sessions.map((x) => [x.id, x.label, x.groupId]), [
    ['claude:aaaa-1111', undefined, ios.id],
    ['claude:bbbb-2222', undefined, ios.id],
    ['claude:cccc-3333', 'Keeps its name', undefined],
  ]);
  assert.equal((await post(sid('claude:cccc-3333'), { groupId: flow.id })).status, 400, 'the deleted group can no longer be assigned');
});

test('SSE clients see a name or group change at once', async () => {
  const events = [];
  let req;
  await new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port: app.port, path: '/api/events' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('data: ')) events.push({ at: Date.now(), state: JSON.parse(block.slice(6)) });
        }
        if (events.length === 1) resolve();
      });
    });
    req.on('error', (err) => (events.length ? undefined : reject(err)));
  });
  assert.ok(Array.isArray(events[0].state.groups), 'the first event already carries groups');

  const sentAt = Date.now();
  const g = (await post('/api/groups', { name: 'Live', color: 'lime' })).json.group;
  const withGroup = await until(() => events.find((e) => e.state.groups.some((x) => x.id === g.id)));
  assert.ok(withGroup.at - sentAt < 1000, `pushed right away (${withGroup.at - sentAt} ms), not at the next 5 s heartbeat`);

  await post(sid('claude:cccc-3333'), { label: 'Seen live', groupId: g.id });
  const withLabel = await until(() => events.find((e) => e.state.sessions.some((x) => x.id === 'claude:cccc-3333' && x.label === 'Seen live' && x.groupId === g.id)));
  assert.ok(withLabel);

  await post(`/api/groups/${g.id}`, { autoDirs: [path.join(work, 'shop', 'graph')], order: -1 });
  await until(() => events.find((e) => e.state.groups[0]?.id === g.id && e.state.sessions.find((x) => x.id === 'claude:aaaa-1111')?.groupId === g.id));

  await post(`/api/groups/${g.id}/delete`, {});
  const afterDelete = await until(() => events.find((e) => e.at >= withLabel.at && !e.state.groups.some((x) => x.id === g.id) && e !== events[0]));
  assert.equal(afterDelete.state.sessions.find((x) => x.id === 'claude:cccc-3333').groupId, undefined);
  assert.equal(afterDelete.state.sessions.find((x) => x.id === 'claude:cccc-3333').label, 'Seen live');
  req.destroy();
});

test('a task launched with a label and a group: echoed on the Task and applied to its session', async () => {
  const ios = (await state()).groups[0];
  const refused = await post('/api/tasks', { tool: 'claude', prompt: 'hi', cwd: work, groupId: 'g-nope' });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /no such group/);
  assert.equal((await post('/api/tasks', { tool: 'claude', prompt: 'hi', cwd: work, label: { no: 1 } })).status, 400);
  assert.equal((await state()).tasks.length, 0, 'nothing was started');

  const res = await post('/api/tasks', { tool: 'claude', prompt: 'Reply OK', cwd: work, permission: 'read', label: ' Launched\tfrom the office ', groupId: ios.id });
  assert.equal(res.status, 201);
  const task = res.json.task;
  assert.deepEqual([task.label, task.groupId], ['Launched from the office', ios.id]);
  assert.match(task.sessionId, /^claude:[0-9a-f-]{36}$/);
  assert.deepEqual(app.meta.getSessionMeta(task.sessionId), { label: 'Launched from the office', groupId: ios.id }, 'applied before the run has said a word');
  await until(async () => (await state()).tasks.find((t) => t.id === task.id)?.status === 'done');
  assert.deepEqual((await state()).tasks[0].label, 'Launched from the office');
  assert.equal(onDisk().sessions[task.sessionId].label, 'Launched from the office');

  // A follow-up to a session on the floor renames it; `label: null` clears.
  const follow = await post(`/api/sessions/${encodeURIComponent('claude:bbbb-2222')}/message`, { prompt: 'And then?', label: 'Follow-up name', groupId: 'none' });
  assert.equal(follow.status, 201);
  assert.deepEqual([follow.json.task.label, follow.json.task.groupId, follow.json.task.resumeOf], ['Follow-up name', 'none', 'claude:bbbb-2222']);
  const s = await sessionOf('claude:bbbb-2222');
  assert.deepEqual([s.label, s.groupId, s.taskId], ['Follow-up name', undefined, follow.json.task.id]);
  await until(async () => (await state()).tasks.find((t) => t.id === follow.json.task.id)?.status === 'done');
  assert.equal((await post(`/api/sessions/${encodeURIComponent('claude:bbbb-2222')}/message`, { prompt: 'Again', groupId: 'g-nope' })).status, 400);
  const cleared = await post(`/api/sessions/${encodeURIComponent('claude:bbbb-2222')}/message`, { prompt: 'Again', label: null, groupId: null });
  assert.equal(cleared.status, 201);
  assert.ok(!('label' in cleared.json.task) && !('groupId' in cleared.json.task));
  assert.deepEqual(app.meta.getSessionMeta('claude:bbbb-2222'), {});
  await until(async () => (await state()).tasks.find((t) => t.id === cleared.json.task.id)?.status === 'done');
});

test('names and groups survive a server restart', async () => {
  const before = await state();
  assert.ok(before.groups.length >= 1 && before.sessions.some((s) => s.label));
  const pick = (s) => ({ groups: s.groups, sessions: s.sessions.map((x) => [x.id, x.label, x.groupId]) });
  await app.close();
  const file = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  assert.equal(file.version, 1);
  assert.deepEqual(file.groups, before.groups);
  assert.equal(fs.statSync(metaFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(metaFile)), ['meta.json']);

  const oldToken = app.token;
  app = await startApp();
  await app.listen();
  await app.office.pollOnce();
  const afterRestart = await state();
  assert.deepEqual(pick(afterRestart), pick(before));
  assert.equal((await request(ROUTES[0], { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': oldToken }, body: '{"name":"Old token"}' })).status, 403);
  assert.equal((await post('/api/groups', { name: 'After restart' })).json.group.order, Math.max(...before.groups.map((g) => g.order)) + 1);
});

test('--mock: the routes drive the mock generator and nothing is written to disk', async () => {
  const on = mockApp;
  const first = await state(on);
  assert.deepEqual(first.groups.map((g) => g.id), ['g-checkout', 'g-ios', 'g-cleanup']);
  assert.equal(first.sessions.find((s) => s.id === 'claude:mock-01').label, 'Cart totals port');

  const created = await post('/api/groups', { name: 'Research', autoDirs: ['/Users/dev/projects/shop/auth'] }, { on });
  assert.equal(created.status, 201);
  const g = created.json.group;
  assert.deepEqual([g.name, g.color, g.order], ['Research', 'lime', 4]);
  assert.equal((await sessionOf('claude:mock-08', on)).groupId, g.id, 'GUS works in that folder');
  assert.equal((await post('/api/groups', { name: 'RESEARCH' }, { on })).status, 409);
  assert.equal((await post('/api/groups', { name: 'X', color: 'coral' }, { on })).status, 400);
  assert.equal((await post('/api/groups/g-nope', { name: 'X' }, { on })).status, 404);
  assert.equal((await post('/api/groups/g-nope/delete', {}, { on })).status, 404);

  assert.deepEqual((await post(`/api/groups/${g.id}`, { name: 'Analytics', color: 'plum', order: 0 }, { on })).json.group, { id: g.id, name: 'Analytics', color: 'plum', autoDirs: ['/Users/dev/projects/shop/auth'], order: 0 });
  assert.equal((await state(on)).groups[0].name, 'Analytics');

  assert.deepEqual((await post(sid('claude:mock-02'), { label: 'Flaky e2e', groupId: g.id }, { on })).json, { id: 'claude:mock-02', label: 'Flaky e2e', groupId: g.id });
  let benji = await sessionOf('claude:mock-02', on);
  assert.deepEqual([benji.label, benji.groupId], ['Flaky e2e', g.id]);
  assert.deepEqual((await post(sid('claude:mock-08'), { groupId: 'none' }, { on })).json, { id: 'claude:mock-08', groupId: 'none' });
  assert.equal((await sessionOf('claude:mock-08', on)).groupId, undefined);
  assert.equal((await post(sid('claude:mock-02'), { groupId: 'g-nope' }, { on })).status, 400);
  assert.equal((await post(sid('emacs:1'), { label: 'x' }, { on })).status, 404);
  assert.equal((await post(sid('claude:not-on-the-floor'), { label: 'Later' }, { on })).status, 200);

  const launched = await post('/api/tasks', { tool: 'codex', prompt: 'Tidy the README', cwd: '/Users/dev/projects/shop', label: 'Tidy up', groupId: 'g-cleanup' }, { on });
  assert.equal(launched.status, 201);
  assert.deepEqual([launched.json.task.label, launched.json.task.groupId], ['Tidy up', 'g-cleanup']);
  const character = await sessionOf(launched.json.task.sessionId, on);
  assert.deepEqual([character.label, character.groupId, character.title], ['Tidy up', 'g-cleanup', 'Tidy the README']);
  await post(`/api/tasks/${launched.json.task.id}/stop`, {}, { on });

  assert.deepEqual((await post(`/api/groups/${g.id}/delete`, {}, { on })).json, { ok: true });
  benji = await sessionOf('claude:mock-02', on);
  assert.deepEqual([benji.label, benji.groupId], ['Flaky e2e', undefined]);
  assert.ok(!(await state(on)).groups.some((x) => x.id === g.id));

  mockApp.meta.flush();
  await sleep(400); // longer than the file store's debounce
  assert.ok(!fs.existsSync(path.dirname(mockMetaFile)), 'mock mode never touches the meta file');
});

test('parseArgs: where the meta file lives', () => {
  assert.deepEqual(parseArgs([], { AGENT_OFFICE_META_FILE: '/tmp/x/meta.json' }), { mock: false, port: 4477, metaFile: '/tmp/x/meta.json' });
  assert.deepEqual(parseArgs(['--meta-file', '/tmp/y/../y/meta.json'], { AGENT_OFFICE_META_FILE: '/tmp/x/meta.json' }), { mock: false, port: 4477, metaFile: '/tmp/y/meta.json' });
  assert.deepEqual(parseArgs(['--meta-file=rel/meta.json', '--mock'], {}), { mock: true, port: 4477, metaFile: path.resolve('rel/meta.json') });
  assert.deepEqual(parseArgs([], { AGENT_OFFICE_META_FILE: '' }), { mock: false, port: 4477 });
  assert.throws(() => parseArgs(['--meta-file'], {}), /needs a file path/);
  assert.throws(() => parseArgs(['--meta-file='], { AGENT_OFFICE_META_FILE: '/tmp/x/meta.json' }), /needs a file path/);
});
