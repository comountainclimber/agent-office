// Tests for the Cursor adapter. Everything runs against synthetic fixtures in a temp dir:
// the adapter's data roots are overridden with configure(), so the real ~/.cursor is never read.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cursor from './cursor.mjs';
import { deriveStatus } from '../contract.mjs';

const { listSessions, getTranscript, configure, describeTool, userText, parseCursorTimestamp, analyseRecords } = cursor;

const HOUR = 3600_000;
const tmpRoots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-cursor-'));
  tmpRoots.push(root);
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  return root;
}

test.after(() => {
  configure({ projectsDir: path.join(os.tmpdir(), 'agent-office-cursor-none'), stateDb: '' });
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

/** "Friday, Nov 13, 2026, 7:43 PM (UTC+0)" - the format Cursor puts in <timestamp>. */
function stamp(ms) {
  const d = new Date(ms);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h = d.getUTCHours();
  return `${days[d.getUTCDay()]}, ${mons[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} (UTC+0)`;
}

const user = (text, ms) => ({
  role: 'user',
  message: { content: [{ type: 'text', text: `${ms ? `<timestamp>${stamp(ms)}</timestamp>\n` : ''}<user_query>\n${text}\n</user_query>` }] },
});
const say = (text) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
const call = (name, input, text) => ({
  role: 'assistant',
  message: { content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', name, input }] },
});
const ended = (status = 'success') => ({ type: 'turn_ended', status, ...(status === 'error' ? { error: 'boom' } : {}) });

let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** Write a transcript; `ageMs` back-dates its mtime. Returns {id, file}. */
function writeTranscript(root, slug, records, { id = newId(), ageMs = 0, parent = null, raw = null } = {}) {
  const dir = parent ? path.join(path.dirname(parent.file), 'subagents') : path.join(root, 'projects', slug, 'agent-transcripts', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, raw ?? records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
  }
  return { id, file };
}

function use(root, extra = {}) {
  return configure({ projectsDir: path.join(root, 'projects'), stateDb: '', discoverMs: 0, ...extra });
}

const byId = (sessions, id) => sessions.find((s) => s.nativeId === id);

// --- pure helpers -----------------------------------------------------------

test('parseCursorTimestamp handles Cursor formats', () => {
  assert.equal(parseCursorTimestamp('Friday, Nov 13, 2026, 7:43 PM (UTC-7)'), Date.UTC(2026, 10, 14, 2, 43));
  assert.equal(parseCursorTimestamp('Monday, Jan 5, 2026, 12:05 AM (UTC+5:30)'), Date.UTC(2026, 0, 4, 18, 35));
  assert.equal(parseCursorTimestamp('Sunday, Mar 1, 2026, 12:00 PM (UTC+0)'), Date.UTC(2026, 2, 1, 12, 0));
  assert.equal(parseCursorTimestamp('not a date'), 0);
  assert.equal(parseCursorTimestamp(undefined), 0);
});

test('userText strips Cursor wrapper tags', () => {
  assert.equal(userText('<timestamp>x</timestamp>\n<user_query>\nfix the bug\n</user_query>'), 'fix the bug');
  assert.equal(userText('<user_query>unterminated prompt'), 'unterminated prompt');
  assert.equal(userText('<image_files>\n1. a.png\n</image_files>\n<timestamp>t</timestamp>\nplain words'), 'plain words');
  assert.equal(userText('<timestamp>only a wrapper</timestamp>'), '');
  assert.equal(userText('no wrapper at all'), 'no wrapper at all');
});

test('describeTool maps Cursor tools to activity kinds and labels', () => {
  const cases = [
    ['Read', { path: '/a/b/launcher.mjs' }, 'reading', 'Read launcher.mjs'],
    ['read_file_v2', { target_file: 'src/x.ts' }, 'reading', 'Read x.ts'],
    ['StrReplace', { path: '/a/b/c.js', old_string: 'a', new_string: 'b' }, 'editing', 'Edit c.js'],
    ['Write', { path: 'docs/readme.md', contents: 'x' }, 'editing', 'Edit readme.md'],
    ['ApplyPatch', { patch: '*** Begin Patch\n*** Update File: lib/y.py\n@@' }, 'editing', 'Edit y.py'],
    ['Shell', { command: 'npm test', description: 'run tests' }, 'running', 'Bash: npm test'],
    ['Grep', { pattern: 'TODO', path: '.' }, 'searching', 'Grep TODO'],
    ['Glob', { glob_pattern: '**/*.ts' }, 'searching', 'Glob **/*.ts'],
    ['SemanticSearch', { query: 'where is auth' }, 'searching', 'Search: where is auth'],
    ['WebSearch', { search_term: 'node sqlite' }, 'searching', 'Web: node sqlite'],
    ['WebFetch', { url: 'https://example.com/a/b?c=1' }, 'browsing', 'Fetch example.com'],
    ['cursor-ide-browser-browser_click', { ref: 'e1' }, 'browsing', 'Browser: click'],
    ['Task', { description: 'Audit the API', prompt: 'long', subagent_type: 'explore' }, 'delegating', 'Task: Audit the API'],
    ['TodoWrite', { todos: [] }, 'thinking', 'Updating todos'],
    ['AskQuestion', { title: 'Which one?', questions: [] }, 'waiting', 'Asking a question'],
    ['CallMcpTool', { server: 'gh', toolName: 'create_issue', arguments: {} }, 'running', 'MCP: create_issue'],
    ['SomethingNew', {}, 'running', 'SomethingNew'],
  ];
  for (const [name, input, kind, label] of cases) {
    const d = describeTool(name, input);
    assert.equal(d.kind, kind, name);
    assert.equal(d.label, label, name);
  }
  const long = describeTool('Shell', { command: `echo ${'x'.repeat(200)}` });
  assert.ok(long.label.length <= 60);
  assert.ok(long.label.startsWith('Bash: echo x'));
  assert.equal(describeTool(undefined, null).kind, 'running'); // never throws on junk
});

test('analyseRecords tolerates unknown record types and odd shapes', () => {
  const a = analyseRecords([{ foo: 1 }, { role: 'assistant' }, { role: 'assistant', message: { content: 'plain string' } }, { type: 'future_event', x: 1 }]);
  assert.equal(a.turnState, 'mid');
  assert.equal(a.activity.kind, 'writing');
  assert.equal(a.lastMessage, 'plain string');
  assert.equal(analyseRecords([]).turnState, 'unknown');
});

// --- transcripts ------------------------------------------------------------

test('lists a finished session with title, last message and ended turn', async () => {
  const root = makeRoot();
  const now = Date.now();
  const started = now - 30 * 60_000;
  const { id } = writeTranscript(root, 'tmp-demo', [
    user('Fix the   login bug\nplease', started),
    call('Read', { path: '/tmp/demo/auth.js' }, 'Looking at the code.'),
    call('StrReplace', { path: '/tmp/demo/auth.js', old_string: 'a', new_string: 'b' }),
    say('All fixed. ' + 'x'.repeat(600)),
    ended('success'),
  ], { ageMs: 60_000 });
  use(root);
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.tool, 'cursor');
  assert.equal(s.nativeId, id);
  assert.equal(s.title, 'Fix the login bug please');
  assert.equal(s.turnState, 'ended');
  assert.equal(s.activity.kind, 'waiting');
  assert.ok(s.lastMessage.startsWith('All fixed.'));
  assert.ok(s.lastMessage.length <= 2400);
  assert.equal(s.source, 'cli'); // no IDE store configured
  assert.deepEqual(s.subagents, []);
  assert.ok(Math.abs(s.lastActivityAt - (now - 60_000)) < 5_000, 'lastActivityAt is the file mtime');
  assert.ok(Math.abs(s.startedAt - started) < 61_000, 'startedAt comes from the first <timestamp>');
  assert.equal(deriveStatus(s.turnState, s.lastActivityAt, now), 'waiting');
  assert.equal(cursor.tool, 'cursor');
});

test('mid-turn states: after a user prompt, during a tool call, while writing', async () => {
  const root = makeRoot();
  const now = Date.now();
  const a = writeTranscript(root, 'tmp-demo', [user('do a thing', now - 5000)]);
  const b = writeTranscript(root, 'tmp-demo', [user('run tests', now - 5000), call('Shell', { command: 'npm test -- --watch=false' })]);
  const c = writeTranscript(root, 'tmp-demo', [user('explain', now - 5000), ended(), user('more', now - 4000), say('Sure, here is')]);
  const d = writeTranscript(root, 'tmp-demo', [user('pick', now - 5000), call('AskQuestion', { title: 'Which?', questions: [] })]);
  const e = writeTranscript(root, 'tmp-demo', [user('break', now - 5000), call('Read', { path: 'a.js' }), ended('error')]);
  use(root);
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(sessions.length, 5);
  assert.deepEqual([byId(sessions, a.id).turnState, byId(sessions, a.id).activity], ['mid', { kind: 'thinking', label: 'Thinking' }]);
  assert.deepEqual([byId(sessions, b.id).turnState, byId(sessions, b.id).activity], ['mid', { kind: 'running', label: 'Bash: npm test -- --watch=false' }]);
  assert.deepEqual([byId(sessions, c.id).turnState, byId(sessions, c.id).activity.kind, byId(sessions, c.id).lastMessage], ['mid', 'writing', 'Sure, here is']);
  assert.deepEqual([byId(sessions, d.id).turnState, byId(sessions, d.id).activity.label], ['ended', 'Asking a question']);
  assert.deepEqual([byId(sessions, e.id).turnState, byId(sessions, e.id).activity.label], ['ended', 'Stopped: error']);
  assert.equal(deriveStatus(byId(sessions, b.id).turnState, byId(sessions, b.id).lastActivityAt, now), 'working');
});

test('malformed, truncated and empty files never throw and never hide good sessions', async () => {
  const root = makeRoot();
  const now = Date.now();
  const good = writeTranscript(root, 'tmp-demo', [user('good one', now - 1000), say('ok'), ended()]);
  const garbage = writeTranscript(root, 'tmp-demo', [], { raw: '\u0000\u0001 not json at all\n{{{{\n[1,2,3]\n"str"\nnull\n' });
  const empty = writeTranscript(root, 'tmp-demo', [], { raw: '' });
  // Valid records followed by a half-written line (the app was mid-append).
  const truncated = writeTranscript(root, 'tmp-demo', [], {
    raw: [JSON.stringify(user('survive truncation', now - 1000)), JSON.stringify(call('Grep', { pattern: 'needle' })), '{"role":"assistant","message":{"content":[{"type":"te'].join('\n'),
  });
  // A directory with no transcript file in it, and stray files where directories are expected.
  fs.mkdirSync(path.join(root, 'projects', 'tmp-demo', 'agent-transcripts', newId()), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'stray-file'), 'x');
  fs.mkdirSync(path.join(root, 'projects', 'no-transcripts-here', 'mcps'), { recursive: true });
  use(root);
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.deepEqual(sessions.map((s) => s.nativeId).sort(), [good.id, truncated.id].sort());
  const t = byId(sessions, truncated.id);
  assert.equal(t.title, 'survive truncation');
  assert.equal(t.turnState, 'mid');
  assert.deepEqual(t.activity, { kind: 'searching', label: 'Grep needle' });
  assert.deepEqual(await getTranscript(garbage.id, { limit: 10 }), []);
  assert.deepEqual(await getTranscript(empty.id, { limit: 10 }), []);
  assert.deepEqual(await getTranscript('does-not-exist', { limit: 10 }), []);
  assert.deepEqual(await getTranscript('../../etc/passwd', { limit: 10 }), []);
});

test('a missing projects directory yields no sessions', async () => {
  configure({ projectsDir: path.join(os.tmpdir(), 'agent-office-cursor-definitely-missing'), stateDb: '' });
  assert.deepEqual(await listSessions({ now: Date.now(), maxAgeMs: HOUR }), []);
  assert.deepEqual(await listSessions(), []);
});

test('maxAgeMs filters on last write; a fresh subagent keeps an old parent in the office', async () => {
  const root = makeRoot();
  const now = Date.now();
  const old = writeTranscript(root, 'tmp-demo', [user('old', now - 3 * HOUR), say('done'), ended()], { ageMs: 2.5 * HOUR });
  const parentPrompt = 'Survey the repo and report back';
  const parent = writeTranscript(root, 'tmp-demo', [user('orchestrate', now - 100 * 60_000), call('Task', { description: 'Survey repo', prompt: parentPrompt, subagent_type: 'explore', run_in_background: true })], { ageMs: 90 * 60_000 });
  const child = writeTranscript(root, 'tmp-demo', [user(parentPrompt), call('Read', { path: 'README.md' })], { parent, ageMs: 2_000 });
  use(root);
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(byId(sessions, old.id), undefined);
  const p = byId(sessions, parent.id);
  assert.ok(p, 'parent is listed because its subagent wrote recently');
  assert.ok(now - p.lastActivityAt < 10_000);
  assert.equal(p.subagents.length, 1);
  assert.equal(p.subagents[0].id, child.id);
  assert.equal(p.subagents[0].status, 'working');
  assert.equal((await listSessions({ now, maxAgeMs: 4 * HOUR })).length, 2);
});

test('subagents: status from the child log, labels from the Task call, previous turns excluded', async () => {
  const root = makeRoot();
  const now = Date.now();
  const turnStart = now - 10 * 60_000;
  const parent = writeTranscript(root, 'tmp-demo', [
    user('first turn', now - 3 * HOUR),
    call('Task', { description: 'Old task', prompt: 'old prompt', subagent_type: 'explore' }),
    say('first turn done'),
    ended(),
    user('second turn', turnStart),
    call('Task', { description: 'Explore the API surface', prompt: 'prompt A', subagent_type: 'explore' }),
    call('Task', { description: 'Write the tests', prompt: 'prompt B', subagent_type: 'test-engineer' }),
    call('Task', { description: 'Review the diff', prompt: 'prompt C', subagent_type: 'code-reviewer' }),
    call('Task', { description: 'Not started yet', prompt: 'prompt D', subagent_type: 'generalPurpose' }),
  ], { ageMs: 3_000 });
  writeTranscript(root, 'tmp-demo', [user('old prompt'), say('old result'), ended()], { parent, ageMs: 2.9 * HOUR });
  const a = writeTranscript(root, 'tmp-demo', [user('prompt A'), call('Grep', { pattern: 'route' })], { parent, ageMs: 4_000 });
  const b = writeTranscript(root, 'tmp-demo', [user('prompt B'), call('Write', { path: 'x.test.js', contents: '' }), say('tests written'), ended()], { parent, ageMs: 60_000 });
  const c = writeTranscript(root, 'tmp-demo', [user('prompt C'), ended('error')], { parent, ageMs: 120_000 });
  const stray = writeTranscript(root, 'tmp-demo', [user('a prompt nobody asked for in the log'), call('Shell', { command: 'ls' })], { parent, ageMs: 30_000 });
  use(root);
  const [s] = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(s.nativeId, parent.id);
  assert.equal(s.turnState, 'mid');
  assert.equal(s.activity.kind, 'delegating');
  const subs = Object.fromEntries(s.subagents.map((x) => [x.id, x]));
  assert.equal(s.subagents.length, 4, 'the four children of this turn; the first-turn child is gone');

  assert.equal(subs[a.id].status, 'working');
  assert.equal(subs[a.id].label, 'Explore the API surface');
  assert.equal(subs[a.id].agentType, 'explore');
  assert.deepEqual(subs[a.id].activity, { kind: 'searching', label: 'Grep route' });
  assert.equal(subs[a.id].endedAt, undefined);

  assert.equal(subs[b.id].status, 'done');
  assert.equal(subs[b.id].agentType, 'test-engineer');
  assert.ok(Math.abs(subs[b.id].endedAt - (now - 60_000)) < 5_000);
  assert.equal(subs[b.id].activity.kind, 'idle');

  assert.equal(subs[c.id].status, 'failed');
  assert.equal(subs[c.id].label, 'Review the diff');

  // The unmatched child is paired with the Task call that has no transcript of its own.
  assert.equal(subs[stray.id].status, 'working');
  assert.equal(subs[stray.id].label, 'Not started yet');
  assert.equal(subs[stray.id].agentType, 'generalPurpose');

  for (const x of s.subagents) {
    assert.ok(x.label.length <= 80 && x.startedAt <= x.lastActivityAt && typeof x.id === 'string');
  }
});

test('a trailing Task call with no child transcript is reported as a working subagent', async () => {
  const root = makeRoot();
  const now = Date.now();
  const parent = writeTranscript(root, 'tmp-demo', [user('go', now - 60_000), call('Task', { description: 'Spawned just now', prompt: 'p', subagent_type: 'shell' })], { ageMs: 1_000 });
  const finished = writeTranscript(root, 'tmp-demo', [user('go', now - 60_000), call('Task', { description: 'Earlier', prompt: 'p' }), say('all done'), ended()], { ageMs: 1_000 });
  use(root);
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  const p = byId(sessions, parent.id);
  assert.equal(p.subagents.length, 1);
  assert.deepEqual([p.subagents[0].status, p.subagents[0].label, p.subagents[0].agentType], ['working', 'Spawned just now', 'shell']);
  assert.deepEqual(byId(sessions, finished.id).subagents, [], 'a Task followed by more output has finished');
});

test('a child the parent has moved past is done even without an end marker', async () => {
  const root = makeRoot();
  const now = Date.now();
  const parent = writeTranscript(root, 'tmp-demo', [user('go', now - 5 * 60_000), call('Task', { description: 'Quick look', prompt: 'look' }), say('finished'), ended()], { ageMs: 30_000 });
  const child = writeTranscript(root, 'tmp-demo', [user('look'), call('Read', { path: 'a.js' })], { parent, ageMs: 60_000 });
  use(root);
  const [s] = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(s.subagents[0].id, child.id);
  assert.equal(s.subagents[0].status, 'done');
});

test('parses only what changed (cache keyed on mtime + size) and picks up appends', async () => {
  const root = makeRoot();
  const now = Date.now();
  const t = writeTranscript(root, 'tmp-demo', [user('cache me', now - 1000), call('Read', { path: 'one.js' })]);
  const pinned = new Date(Math.floor(now / 1000) * 1000 - 2000); // whole seconds survive utimes exactly
  fs.utimesSync(t.file, pinned, pinned);
  use(root);
  let [s] = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(s.activity.label, 'Read one.js');

  // Same size, same mtime, different bytes: the cached parse must be reused.
  fs.writeFileSync(t.file, fs.readFileSync(t.file, 'utf8').replace('one.js', 'two.js'));
  fs.utimesSync(t.file, pinned, pinned);
  [s] = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(s.activity.label, 'Read one.js');

  fs.appendFileSync(t.file, JSON.stringify(call('Shell', { command: 'make build' })) + '\n');
  [s] = await listSessions({ now: Date.now(), maxAgeMs: HOUR });
  assert.equal(s.activity.label, 'Bash: make build');

  // A brand-new session directory is discovered on a later poll.
  const fresh = writeTranscript(root, 'tmp-demo', [user('newcomer', Date.now())]);
  const again = await listSessions({ now: Date.now(), maxAgeMs: HOUR });
  assert.ok(byId(again, fresh.id));
  assert.equal(again.length, 2);
});

test('reads bounded tails of big files and salvages a title from an oversized first line', async () => {
  const root = makeRoot();
  const now = Date.now();
  const filler = [];
  for (let i = 0; i < 400; i++) filler.push(call('Write', { path: `gen/file${i}.txt`, contents: 'y'.repeat(2000) }));
  const big = writeTranscript(root, 'tmp-demo', [user('big session', now - 60_000), ...filler, call('Shell', { command: 'echo last' })]);
  const huge = writeTranscript(root, 'tmp-demo', [user('huge prompt ' + 'z'.repeat(300_000), now - 60_000), say('got it'), ended()]);
  use(root, { tailBytes: 16 * 1024, headBytes: 8 * 1024 });
  assert.ok(fs.statSync(big.file).size > 800_000);
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(byId(sessions, big.id).title, 'big session');
  assert.equal(byId(sessions, big.id).activity.label, 'Bash: echo last');
  assert.ok(byId(sessions, huge.id).title.startsWith('huge prompt zzz'));
  assert.ok(byId(sessions, huge.id).title.length <= 120);
  assert.equal(byId(sessions, huge.id).turnState, 'ended');
});

test('the same conversation id under two project slugs is listed once (newest write wins)', async () => {
  const root = makeRoot();
  const now = Date.now();
  const id = newId();
  writeTranscript(root, 'tmp-old-home', [user('moved chat', now - HOUR), say('old copy'), ended()], { id, ageMs: 40 * 60_000 });
  writeTranscript(root, 'tmp-new-home', [user('moved chat', now - HOUR), say('old copy'), ended(), user('continue', now - 60_000), say('new copy')], { id, ageMs: 5_000 });
  use(root);
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].lastMessage, 'new copy');
  assert.equal(sessions[0].turnState, 'mid');
});

test('getTranscript normalises messages, newest last, honouring limit', async () => {
  const root = makeRoot();
  const now = Date.now();
  const t0 = now - 20 * 60_000;
  const parent = writeTranscript(root, 'tmp-demo', [
    user('first question', t0),
    call('Shell', { command: 'npm test', description: 'tests' }, 'Running the tests.'),
    say('They pass.'),
    ended(),
    user('second question', t0 + 5 * 60_000),
    call('Read', { path: '/x/y/z.md' }),
    { type: 'some_future_record', payload: 1 },
    say('x'.repeat(5000)),
    ended(),
  ], { ageMs: 60_000 });
  const child = writeTranscript(root, 'tmp-demo', [user('child prompt'), say('child answer'), ended()], { parent });
  use(root);
  const all = await getTranscript(parent.id, { limit: 60 });
  assert.deepEqual(all.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user', 'tool', 'assistant']);
  assert.equal(all[0].text, 'first question');
  assert.deepEqual([all[2].text, all[2].toolName], ['Shell: npm test', 'Shell']);
  assert.equal(all[5].text, 'Read: z.md');
  assert.equal(all[6].text.length, 2000);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].ts <= all[i].ts, 'timestamps never go backwards');
  assert.ok(Math.abs(all[0].ts - t0) < 61_000);
  assert.ok(Math.abs(all[4].ts - (t0 + 5 * 60_000)) < 61_000);
  assert.ok(Math.abs(all[6].ts - (now - 60_000)) < 5_000, 'the newest message carries the file mtime');
  const last3 = await getTranscript(parent.id, { limit: 3 });
  assert.deepEqual(last3.map((m) => m.role), ['user', 'tool', 'assistant']);
  // Subagent transcripts are addressable as "<parent>#<sub>".
  const sub = await getTranscript(`${parent.id}#${child.id}`, { limit: 10 });
  assert.deepEqual(sub.map((m) => m.text), ['child prompt', 'child answer']);
});

// --- IDE store (sqlite) -----------------------------------------------------

let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {}

function makeStateDb(root, { headers = [], kv = [] } = {}) {
  const file = path.join(root, 'state.vscdb');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);
    CREATE INDEX idx_composerHeaders_1 ON composerHeaders (recency, composerId);
  `);
  const insH = db.prepare('insert into composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName) values (?,?,?,?,?,?,?,?,?,?)');
  for (const h of headers) {
    const value = JSON.stringify({ type: 'head', composerId: h.id, createdAt: h.createdAt, lastUpdatedAt: h.lastUpdatedAt, ...h.value });
    insH.run(h.id, 'ws1', h.createdAt, h.lastUpdatedAt ?? null, h.value?.isArchived ? 1 : 0, h.value?.subagentInfo ? 1 : 0, h.lastUpdatedAt ?? h.createdAt, h.checkpointAt ?? null, value, h.value?.subagentInfo?.subagentTypeName ?? null);
  }
  const insK = db.prepare('insert into cursorDiskKV (key, value) values (?, ?)');
  for (const [k, v] of kv) insK.run(k, typeof v === 'string' ? v : JSON.stringify(v));
  db.close();
  return file;
}

const ideTest = (name, fn) => test(name, { skip: sqlite ? false : 'node:sqlite is not available in this Node build' }, fn);

ideTest('IDE store enriches transcripts: name, cwd, branch, model, tokens, source', async () => {
  const root = makeRoot();
  const now = Date.now();
  const ide = writeTranscript(root, 'tmp-demo', [user('raw first prompt', now - 20 * 60_000), say('hello'), ended()], { ageMs: 30_000 });
  const cli = writeTranscript(root, 'tmp-demo', [user('from the terminal', now - 20 * 60_000), say('hi'), ended()], { ageMs: 30_000 });
  const stateDb = makeStateDb(root, {
    headers: [
      {
        id: ide.id,
        createdAt: now - 21 * 60_000,
        lastUpdatedAt: now - 15 * 60_000,
        checkpointAt: now - 30_000,
        value: {
          name: 'Login bug hunt',
          unifiedMode: 'agent',
          hasBlockingPendingActions: false,
          workspaceIdentifier: { id: 'ws1', uri: { scheme: 'file', fsPath: '/work/demo', path: '/work/demo' } },
          trackedGitRepos: [{ repoPath: '/work/demo', branches: [{ branchName: 'main', lastInteractionAt: 5 }, { branchName: 'fix/login', lastInteractionAt: 9 }] }],
        },
      },
    ],
    kv: [
      [`composerData:${ide.id}`, { composerId: ide.id, status: 'completed', modelConfig: { modelName: 'gpt-test-1' }, contextTokensUsed: 12345, fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }], generatingBubbleIds: [] }],
    ],
  });
  use(root, { stateDb });
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  await cursor._settle();
  assert.equal(sessions.length, 2);
  const s = byId(sessions, ide.id);
  assert.equal(s.title, 'Login bug hunt');
  assert.equal(s.cwd, '/work/demo');
  assert.equal(s.branch, 'fix/login');
  assert.equal(s.model, 'gpt-test-1');
  assert.equal(s.tokens, 12345);
  assert.equal(s.source, 'ide');
  assert.equal(s.turnState, 'ended');
  assert.ok(Math.abs(s.startedAt - (now - 21 * 60_000)) < 1000);
  const c = byId(sessions, cli.id);
  assert.equal(c.source, 'cli', 'a transcript the IDE store has never heard of came from cursor-agent');
  assert.equal(c.title, 'from the terminal');
  assert.equal(cursor._debug().ide.failures, 0);
});

ideTest('IDE store: generating follow-up, pending approval, subagent headers, IDE-only chats, drafts', async () => {
  const root = makeRoot();
  const now = Date.now();
  // Transcript says "ended" but the IDE has accepted a new prompt that is not checkpointed yet.
  const follow = writeTranscript(root, 'tmp-demo', [user('one', now - 30 * 60_000), say('done'), ended()], { ageMs: 10 * 60_000 });
  // Transcript says mid-tool-call but the IDE is showing an approval prompt.
  const blocked = writeTranscript(root, 'tmp-demo', [user('deploy', now - 5 * 60_000), call('Shell', { command: 'rm -rf build' })], { ageMs: 20_000 });
  // Parent whose log has no Task call in view: the child's label and type come from its IDE header.
  const parent = writeTranscript(root, 'tmp-demo', [user('delegate', now - 5 * 60_000), say('working on it')], { ageMs: 5_000 });
  const child = writeTranscript(root, 'tmp-demo', [user('a long generated prompt for the child'), call('Glob', { glob_pattern: '*.md' })], { parent, ageMs: 3_000 });
  const ideOnly = newId();
  const draft = newId();
  const idle = newId();
  const head = (extra) => ({ unifiedMode: 'agent', hasBlockingPendingActions: false, workspaceIdentifier: { id: 'ws1', uri: { fsPath: '/work/demo' } }, ...extra });
  const stateDb = makeStateDb(root, {
    headers: [
      { id: follow.id, createdAt: now - 31 * 60_000, lastUpdatedAt: now - 8_000, value: head({ name: 'Follow-up chat' }) },
      { id: blocked.id, createdAt: now - 5 * 60_000, lastUpdatedAt: now - 20_000, value: head({ name: 'Blocked chat', hasBlockingPendingActions: true }) },
      { id: parent.id, createdAt: now - 5 * 60_000, lastUpdatedAt: now - 5_000, value: head({ name: 'Parent chat' }) },
      { id: child.id, createdAt: now - 60_000, value: head({ name: 'Scan the docs', subagentInfo: { parentComposerId: parent.id, subagentTypeName: 'explore' } }) },
      { id: ideOnly, createdAt: now - 4_000, lastUpdatedAt: now - 3_000, value: head({ agentLocation: { type: 'worktree', worktreePath: '/work/trees/abc', environment: { uri: { fsPath: '/work/demo' } } } }) },
      { id: draft, createdAt: now - 2_000, lastUpdatedAt: now - 2_000, value: head({ isDraft: true }) },
      { id: idle, createdAt: now - 2_000, lastUpdatedAt: now - 2_000, value: head({}) },
    ],
    kv: [
      [`composerData:${follow.id}`, { status: 'generating', generatingBubbleIds: ['g1'], lastUpdatedAt: now - 8_000, modelConfig: { modelName: 'm' }, fullConversationHeadersOnly: [{ bubbleId: 'b' }] }],
      [`composerData:${blocked.id}`, { status: 'generating', generatingBubbleIds: [], fullConversationHeadersOnly: [{ bubbleId: 'b' }] }],
      [`composerData:${parent.id}`, 'this is not json'], // malformed blob must not break the refresh
      [`composerData:${ideOnly}`, { status: 'generating', generatingBubbleIds: ['g'], lastUpdatedAt: now - 3_000, modelConfig: { modelName: 'm2' }, fullConversationHeadersOnly: [{ bubbleId: 'first' }, { bubbleId: 'second' }] }],
      [`bubbleId:${ideOnly}:first`, { type: 1, text: '<user_query>\nBrand new chat prompt\n</user_query>' }],
      [`composerData:${draft}`, { status: 'none', fullConversationHeadersOnly: [], generatingBubbleIds: [] }],
      [`composerData:${idle}`, { status: 'none', fullConversationHeadersOnly: [], generatingBubbleIds: [] }],
    ],
  });
  use(root, { stateDb });
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.deepEqual(sessions.map((s) => s.nativeId).sort(), [follow.id, blocked.id, parent.id, ideOnly].sort());

  const f = byId(sessions, follow.id);
  assert.equal(f.turnState, 'mid');
  assert.equal(f.activity.kind, 'thinking');
  assert.ok(Math.abs(f.lastActivityAt - (now - 8_000)) < 1_000, 'IDE lastUpdatedAt moves the clock while generating');

  const b = byId(sessions, blocked.id);
  assert.deepEqual([b.turnState, b.activity], ['ended', { kind: 'waiting', label: 'Waiting for approval' }]);

  const p = byId(sessions, parent.id);
  assert.equal(p.title, 'Parent chat');
  assert.equal(p.subagents.length, 1);
  assert.deepEqual([p.subagents[0].label, p.subagents[0].agentType, p.subagents[0].status], ['Scan the docs', 'explore', 'working']);
  assert.ok(Math.abs(p.subagents[0].startedAt - (now - 60_000)) < 1_000);

  const o = byId(sessions, ideOnly);
  assert.deepEqual([o.source, o.turnState, o.title, o.cwd, o.model], ['ide', 'mid', 'Brand new chat prompt', '/work/trees/abc', 'm2']);
  assert.deepEqual(o.subagents, []);
  assert.deepEqual(await getTranscript(ideOnly, { limit: 5 }), []);
});

ideTest('an unreadable IDE store degrades to transcripts only', async () => {
  const root = makeRoot();
  const now = Date.now();
  const t = writeTranscript(root, 'tmp-demo', [user('still here', now - 60_000), say('yes'), ended()]);
  const stateDb = path.join(root, 'state.vscdb');
  fs.writeFileSync(stateDb, 'this is definitely not a sqlite database'.repeat(200));
  use(root, { stateDb });
  const first = await listSessions({ now, maxAgeMs: HOUR });
  await cursor._settle();
  const second = await listSessions({ now, maxAgeMs: HOUR });
  for (const sessions of [first, second]) {
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].nativeId, t.id);
    assert.equal(sessions[0].title, 'still here');
  }
  assert.equal(second[0].source, 'unknown');
  assert.ok(cursor._debug().ide.failures >= 1);
  assert.ok(cursor._debug().ide.lastError);
});

test('warm polls are cheap', async () => {
  const root = makeRoot();
  const now = Date.now();
  for (let p = 0; p < 20; p++) {
    for (let i = 0; i < 15; i++) {
      writeTranscript(root, `tmp-proj-${p}`, [user(`task ${p}/${i}`, now - HOUR), call('Read', { path: 'a.js' }), say('done'), ended()], { ageMs: i < 2 ? 10_000 : 3 * 24 * HOUR });
    }
  }
  use(root, { discoverMs: 0, warmStatMs: 0, coldStatMs: 0 }); // worst case: re-list and re-stat on every call
  const first = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(first.length, 40);
  const times = [];
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    await listSessions({ now, maxAgeMs: HOUR });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[times.length >> 1] < 50, `median warm poll ${times[times.length >> 1].toFixed(1)} ms`);
});

ideTest('a sqlite refresh that blows its time budget is abandoned and backed off', async () => {
  const root = makeRoot();
  const now = Date.now();
  const t = writeTranscript(root, 'tmp-demo', [user('budget', now - 60_000), say('ok'), ended()]);
  const stateDb = makeStateDb(root, { headers: [{ id: t.id, createdAt: now - 60_000, lastUpdatedAt: now - 60_000, value: { name: 'Never arrives' } }] });
  use(root, { stateDb, ideBudgetMs: 1, ideColdWaitMs: 200 }); // 1 ms: the worker cannot even start in time
  const sessions = await listSessions({ now, maxAgeMs: HOUR });
  await cursor._settle();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'budget');
  const dbg = cursor._debug().ide;
  assert.equal(dbg.hasSnapshot, false);
  assert.equal(dbg.failures, 1);
  assert.match(dbg.lastError, /exceeded/);
  // The next poll does not wait for (or immediately retry) the store.
  const t0 = performance.now();
  await listSessions({ now, maxAgeMs: HOUR });
  assert.ok(performance.now() - t0 < 100);
  assert.equal(cursor._debug().ide.pending, false);
});
