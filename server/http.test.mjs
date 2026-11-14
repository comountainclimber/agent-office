import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createApp, injectToken, listDirs, parseArgs } from './index.mjs';

/** @type {Awaited<ReturnType<typeof createApp>>} */
let app;
let root;
let publicDir;
let outside;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-http-')));
  publicDir = path.join(root, 'public');
  fs.mkdirSync(path.join(publicDir, 'js', 'world'), { recursive: true });
  fs.mkdirSync(path.join(publicDir, 'fonts'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html>\n<html>\n  <head>\n    <title>Office</title>\n  </head>\n  <body>hi</body>\n</html>\n');
  fs.writeFileSync(path.join(publicDir, 'js', 'app.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(publicDir, 'js', 'world', 'index.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(publicDir, 'style.css'), 'body{}\n');
  fs.writeFileSync(path.join(publicDir, 'fonts', 'pixel.woff2'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(publicDir, 'sprite.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(publicDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(publicDir, '.env'), 'SECRET=1\n');
  outside = path.join(root, 'secret.txt');
  fs.writeFileSync(outside, 'TOP SECRET\n');
  fs.symlinkSync(outside, path.join(publicDir, 'leak.txt'));
  app = await createApp({ port: 0, mock: true, publicDir });
  await app.listen();
});

after(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Raw request: the path is sent exactly as given and any header (Host included) can be set. */
function request(reqPath, { method = 'GET', headers = {}, body, port = app.port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
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

const post = (reqPath, payload, headers = {}) =>
  request(reqPath, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': app.token, ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });

test('Host header: only 127.0.0.1:<port> and localhost:<port> are answered', async () => {
  for (const host of ['evil.example', `evil.example:${app.port}`, '127.0.0.1', `127.0.0.1:${app.port + 1}`, `127.0.0.1.evil.example:${app.port}`, `[::1]:${app.port}`]) {
    for (const p of ['/api/state', '/', '/js/app.js']) {
      const res = await request(p, { headers: { Host: host } });
      assert.equal(res.status, 403, `${host} ${p}`);
      assert.match(res.json.error, /forbidden/);
      assert.ok(!res.text.includes('sessions') && !res.text.includes('office-token'));
    }
  }
  assert.equal((await request('/api/state', { headers: { Host: `localhost:${app.port}` } })).status, 200);
  assert.equal((await request('/api/state', { headers: { Host: `LOCALHOST:${app.port}` } })).status, 200);
  assert.equal((await request('/api/state')).status, 200);

  // No Host header at all (HTTP/1.0 allows that).
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(app.port, '127.0.0.1', () => socket.end('GET /api/state HTTP/1.0\r\n\r\n'));
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (c) => (text += c));
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.[01] 403 /);
  assert.ok(!raw.includes('sessions'));
});

test('POST needs the token', async () => {
  const payload = JSON.stringify({ tool: 'claude', prompt: 'hi', cwd: '/tmp', permission: 'read' });
  const json = { 'Content-Type': 'application/json' };
  for (const [name, headers] of [
    ['missing', json],
    ['wrong', { ...json, 'X-Office-Token': 'x'.repeat(app.token.length) }],
    ['short', { ...json, 'X-Office-Token': app.token.slice(0, -1) }],
    ['empty', { ...json, 'X-Office-Token': '' }],
  ]) {
    for (const p of ['/api/tasks', '/api/tasks/task-1/stop', '/api/sessions/claude%3Amock-01/message']) {
      const res = await request(p, { method: 'POST', headers, body: payload });
      assert.equal(res.status, 403, `${name} ${p}`);
      assert.match(res.json.error, /X-Office-Token/);
    }
  }
  assert.equal((await request('/api/state')).json.tasks.length, 0, 'nothing was started');
});

test('POST must be JSON, same-origin, and small', async () => {
  const good = { tool: 'claude', prompt: 'hi', cwd: '/tmp', permission: 'read' };
  assert.equal((await post('/api/tasks', good, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/tasks', good, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post('/api/tasks', good, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/tasks', good, { Origin: `http://127.0.0.1:${app.port + 1}` })).status, 403);
  assert.equal((await post('/api/tasks', good, { Origin: 'null' })).status, 403);
  assert.equal((await post('/api/tasks', good, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/tasks', good, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await request('/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403, 'cross-origin reads of the API are refused too');
  assert.equal((await post('/api/tasks', '{not json')).status, 400);
  assert.equal((await post('/api/tasks', '[1,2]')).status, 400);

  const big = await post('/api/tasks', { ...good, prompt: 'x'.repeat(70_000) });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /too large/);
  assert.equal((await request('/api/state')).json.tasks.length, 0, 'nothing was started');
});

test('static files cannot be used to read outside public/', async () => {
  const attempts = [
    '/../secret.txt',
    '/../../../../../../etc/passwd',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%2fsecret.txt',
    '/js/../../secret.txt',
    '/js/..%2f..%2fsecret.txt',
    '/js/%2e%2e/%2e%2e/secret.txt',
    '/..%5csecret.txt',
    '//secret.txt',
    `/${encodeURIComponent(outside)}`,
    '/leak.txt', // symlink that points out of public/
    '/.env',
    '/js/%00/app.js',
    '/%zz',
  ];
  for (const p of attempts) {
    const res = await request(p);
    assert.ok([400, 403, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.ok(!res.text.includes('TOP SECRET') && !res.text.includes('SECRET=1') && !res.text.includes('root:'), p);
    assert.ok(res.json?.error, `${p} answers with a JSON error`);
  }
});

test('static files: MIME types, no-store, and the token in index.html', async () => {
  const types = {
    '/js/app.js': 'text/javascript; charset=utf-8',
    '/js/world/index.mjs': 'text/javascript; charset=utf-8',
    '/style.css': 'text/css; charset=utf-8',
    '/fonts/pixel.woff2': 'font/woff2',
    '/sprite.png': 'image/png',
    '/icon.svg': 'image/svg+xml',
  };
  for (const [p, type] of Object.entries(types)) {
    const res = await request(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers['content-type'], type, p);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal((await request('/js/app.js?v=3')).status, 200, 'a query string is ignored');
  assert.equal((await request('/nope.js')).status, 404);
  assert.equal((await request('/js/app.js', { method: 'DELETE' })).status, 405);
  const head = await request('/js/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');

  for (const p of ['/', '/index.html']) {
    const res = await request(p);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(res.text.includes(`<head>\n    <meta name="office-token" content="${app.token}">`), 'token is injected into <head>');
    assert.ok(res.text.includes('<body>hi</body>'));
  }
  assert.match(app.token, /^[0-9a-f]{48}$/);
});

test('injectToken copes with odd documents', () => {
  assert.equal(injectToken('<HTML><HEAD lang="en"><title>x</title></HEAD></HTML>', 't'), '<HTML><HEAD lang="en">\n    <meta name="office-token" content="t"><title>x</title></HEAD></HTML>');
  assert.equal(injectToken('<html><body></body></html>', 't'), '<html><head><meta name="office-token" content="t"></head><body></body></html>');
  assert.equal(injectToken('hello', 't'), '<meta name="office-token" content="t">hello');
  assert.ok(injectToken('<header>not head</header>', 't').startsWith('<meta'));
});

test('a placeholder page is served while public/index.html does not exist', async () => {
  const empty = fs.mkdtempSync(path.join(root, 'empty-public-'));
  const bare = await createApp({ port: 0, mock: true, publicDir: empty });
  await bare.listen();
  const res = await request('/', { port: bare.port });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(`<meta name="office-token" content="${bare.token}">`));
  assert.ok(res.text.includes('/api/events'));
  assert.notEqual(bare.token, app.token, 'each server has its own token');
  await bare.close();
});

test('GET /api/state and /api/meta', async () => {
  const state = (await request('/api/state')).json;
  assert.equal(state.mock, true);
  assert.ok(Array.isArray(state.sessions) && state.sessions.length > 5);
  assert.deepEqual(Object.keys(state.tools).sort(), ['claude', 'codex', 'cursor']);
  assert.ok(Array.isArray(state.tasks) && Array.isArray(state.recentDirs));
  assert.ok(Math.abs(state.now - Date.now()) < 5000);

  const meta = (await request('/api/meta')).json;
  assert.equal(meta.port, app.port);
  assert.equal(meta.mock, true);
  assert.deepEqual(Object.keys(meta.permissionNotes).sort(), ['claude', 'codex', 'cursor']);
  for (const tool of Object.values(meta.permissionNotes)) assert.deepEqual(Object.keys(tool).sort(), ['edit', 'full', 'read']);
});

test('GET /api/sessions/:id/transcript', async () => {
  const res = await request('/api/sessions/claude%3Amock-01/transcript?limit=5');
  assert.equal(res.status, 200);
  assert.ok(res.json.messages.length > 0 && res.json.messages.length <= 5);
  for (const m of res.json.messages) assert.ok(['user', 'assistant', 'tool'].includes(m.role) && typeof m.text === 'string' && typeof m.ts === 'number');
  assert.equal((await request('/api/sessions/claude:mock-01/transcript')).status, 200, 'an unencoded colon works too');
  assert.equal((await request('/api/sessions/emacs%3A1/transcript')).status, 404);
  assert.equal((await request('/api/sessions/claude%3Amock-01/transcript?limit=0')).status, 400);
  assert.equal((await request('/api/sessions/claude%3Amock-01/transcript?limit=abc')).status, 400);
  assert.equal((await request('/api/sessions/claude%3Amock-01/transcript', { method: 'POST' })).status, 405);
});

test('GET /api/dirs lists sub-directories only', async () => {
  const dir = path.join(root, 'tree');
  for (const d of ['beta', 'Alpha', 'gamma10', 'gamma9', '.hidden', '.git']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  fs.symlinkSync(path.join(dir, 'beta'), path.join(dir, 'link-to-beta'));
  fs.symlinkSync(path.join(dir, 'file.txt'), path.join(dir, 'link-to-file'));
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling'));

  const res = await request(`/api/dirs?path=${encodeURIComponent(dir)}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.path, dir);
  assert.equal(res.json.parent, root);
  assert.deepEqual(res.json.dirs, ['Alpha', 'beta', 'gamma9', 'gamma10', 'link-to-beta', '.git', '.hidden']);

  const home = (await request('/api/dirs')).json;
  assert.equal(home.path, os.homedir());
  assert.equal(home.parent, path.dirname(os.homedir()));
  assert.ok(Array.isArray(home.dirs));
  const top = (await request('/api/dirs?path=/')).json;
  assert.equal(top.path, '/');
  assert.equal(top.parent, null);
  assert.equal((await request(`/api/dirs?path=${encodeURIComponent(dir + '/beta/..')}`)).json.path, dir, 'the path is normalised');

  assert.equal((await request('/api/dirs?path=relative/dir')).status, 400);
  assert.equal((await request(`/api/dirs?path=${encodeURIComponent(path.join(dir, 'nope'))}`)).status, 404);
  assert.equal((await request(`/api/dirs?path=${encodeURIComponent(path.join(dir, 'file.txt'))}`)).status, 400);

  const many = path.join(root, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 520; i++) fs.mkdirSync(path.join(many, `d${i}`));
  const capped = await listDirs(many);
  assert.equal(capped.dirs.length, 500);
  assert.equal(capped.truncated, true);
});

test('GET /api/events streams the state: at once, then again as it changes', async () => {
  const events = [];
  let headers;
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: app.port, path: '/api/events' }, (res) => {
      headers = res.headers;
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
        if (events.length >= 3) {
          req.destroy();
          resolve();
        }
      });
    });
    req.on('error', (err) => (events.length >= 3 ? resolve() : reject(err)));
    setTimeout(() => reject(new Error(`only ${events.length} events in 8 s`)), 8000).unref();
  });
  assert.equal(headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(headers['cache-control'], 'no-store');
  assert.ok(events[0].state.sessions.length > 5, 'the first event is the current state');
  assert.ok(events[2].state.now > events[0].state.now);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await request('/api/events', { headers: { Host: 'evil.example' } })).status, 403);
});

test('tasks: launch, follow up, stop (mock)', async () => {
  const bad = await post('/api/tasks', { tool: 'vim', prompt: 'hi', cwd: '/tmp' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /tool must be/);
  assert.equal((await post('/api/tasks', { tool: 'claude', prompt: '', cwd: '/tmp' })).status, 400);
  assert.equal((await post('/api/tasks', { tool: 'claude', prompt: 'hi', cwd: 'not/absolute' })).status, 400);
  assert.equal((await post('/api/tasks', { tool: 'claude', prompt: 'hi', cwd: '/tmp', permission: 'god' })).status, 400);

  const before = (await request('/api/state')).json.sessions.length;
  const res = await post('/api/tasks', { tool: 'codex', prompt: 'Tidy the README', cwd: '/Users/dev/projects/shop' });
  assert.equal(res.status, 201);
  const task = res.json.task;
  assert.equal(task.status, 'starting');
  assert.equal(task.permission, 'edit', 'edit is the default permission');
  assert.equal(task.tool, 'codex');
  assert.match(task.sessionId, /^codex:/);

  const state = (await request('/api/state')).json;
  assert.equal(state.tasks[0].id, task.id);
  assert.equal(state.sessions.length, before + 1, 'a new character walked in');
  const character = state.sessions.find((s) => s.id === task.sessionId);
  assert.equal(character.taskId, task.id);
  assert.equal(character.title, 'Tidy the README');

  const follow = await post(`/api/sessions/${encodeURIComponent('claude:mock-01')}/message`, { prompt: 'And then?' });
  assert.equal(follow.status, 201);
  assert.equal(follow.json.task.resumeOf, 'claude:mock-01');
  assert.equal(follow.json.task.sessionId, 'claude:mock-01');
  assert.equal((await post('/api/sessions/claude%3Amock-01/message', { prompt: 'Again?' })).status, 409, 'one run per session at a time');
  assert.equal((await post('/api/sessions/emacs%3A1/message', { prompt: 'hi' })).status, 404);
  assert.equal((await post('/api/sessions/claude%3Amock-02/message', {})).status, 400);

  const stopped = await post(`/api/tasks/${task.id}/stop`, {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.task.status, 'stopped');
  assert.equal((await post(`/api/tasks/${task.id}/stop`, '')).json.task.status, 'stopped', 'an empty body is fine');
  assert.equal((await post(`/api/tasks/${follow.json.task.id}/stop`, {})).json.task.status, 'stopped');
  assert.equal((await post('/api/tasks/task-nope/stop', {})).status, 404);
  assert.deepEqual((await request('/api/state')).json.tasks.map((t) => t.status), ['stopped', 'stopped']);
});

test('unknown routes and wrong methods', async () => {
  assert.equal((await request('/api/nope')).status, 404);
  assert.equal((await request('/api')).status, 404);
  assert.equal((await request('/api/tasks')).status, 405);
  assert.equal((await request('/api/tasks')).headers.allow, 'POST');
  assert.equal((await request('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': app.token }, body: '{}' })).status, 405);
  assert.equal((await request('/api/sessions/%zz/transcript')).status, 400);
  for (const p of ['/api/nope', '/api/tasks', '/nope']) assert.ok((await request(p)).json.error);
});

test('a busy port is reported, not fought over', async () => {
  const second = await createApp({ port: app.port, mock: true, publicDir });
  await assert.rejects(second.listen(), (err) => err.code === 'EADDRINUSE');
  second.office.stop();
  second.launcher.close();
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs([], {}), { mock: false, port: 4477 });
  assert.deepEqual(parseArgs(['--mock'], { PORT: '4491' }), { mock: true, port: 4491 });
  assert.deepEqual(parseArgs(['--port', '5000'], { PORT: '4491' }), { mock: false, port: 5000 });
  assert.deepEqual(parseArgs(['--port=5001', '--mock'], {}), { mock: true, port: 5001 });
  assert.throws(() => parseArgs(['--port', 'abc'], {}), /invalid port/);
  assert.throws(() => parseArgs(['--port', '70000'], {}), /invalid port/);
  assert.throws(() => parseArgs(['--frobnicate'], {}), /unknown argument/);
});
