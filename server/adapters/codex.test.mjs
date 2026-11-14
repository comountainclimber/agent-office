// node --test server/adapters/codex.test.mjs
// Synthetic rollout fixtures in a temp dir; the real ~/.codex is never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getTranscript, listSessions, setCodexHome, tool } from './codex.mjs';

const HOUR = 60 * 60_000;
const P_ID = '01a1d000-0000-7000-8000-00000000000a';
const C_ID = '01a1d000-0000-7000-8000-00000000000b';
const G_ID = '01a1d000-0000-7000-8000-00000000000c';
const X_ID = '01a1d000-0000-7000-8000-00000000000d';

const homes = [];
function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-codex-'));
  homes.push(home);
  setCodexHome(home);
  return home;
}
test.after(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

const pad = (n) => String(n).padStart(2, '0');
function dayDir(home, ms = Date.now()) {
  const d = new Date(ms);
  const dir = path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A rollout file being written the way Codex writes it: {timestamp, ordinal, type, payload} per line. */
class Rollout {
  constructor(home, id, { startOrdinal = 0, baseTs = Date.now() - 60_000 } = {}) {
    this.id = id;
    this.file = path.join(dayDir(home), `rollout-2026-11-13T10-00-00-${id}.jsonl`);
    this.ordinal = startOrdinal;
    this.ts = baseTs;
    fs.writeFileSync(this.file, '');
  }
  line(type, payload, ordinal) {
    this.ts += 250;
    return JSON.stringify({ timestamp: new Date(this.ts).toISOString(), ordinal: ordinal ?? this.ordinal++, type, payload });
  }
  add(type, payload, ordinal) {
    fs.appendFileSync(this.file, `${this.line(type, payload, ordinal)}\n`);
    return this;
  }
  raw(text) {
    fs.appendFileSync(this.file, text);
    return this;
  }
  touch(ms) {
    fs.utimesSync(this.file, ms / 1000, ms / 1000);
    return this;
  }
  meta(extra = {}) {
    return this.add('session_meta', {
      session_id: this.id,
      id: this.id,
      timestamp: new Date(this.ts).toISOString(),
      cwd: '/Users/dev/projects/shop',
      originator: 'Codex Desktop',
      cli_version: '0.167.0',
      source: 'vscode',
      thread_source: 'user',
      model_provider: 'openai',
      base_instructions: { text: 'You are Codex.' },
      history_mode: 'paginated',
      git: { commit_hash: 'abc123', branch: 'feature/login' },
      ...extra,
    });
  }
  taskStarted() {
    return this.add('event_msg', { type: 'task_started', turn_id: 't1', started_at: Math.floor(this.ts / 1000) });
  }
  preamble(model = 'gpt-test-1') {
    this.add('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex, an agent.' }] });
    this.add('response_item', {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '# AGENTS.md instructions for /Users/dev/projects/shop\n\nBe nice.' },
        { type: 'input_text', text: '<environment_context>\n  <cwd>/Users/dev/projects/shop</cwd>\n</environment_context>' },
      ],
    });
    return this.add('turn_context', { turn_id: 't1', cwd: '/Users/dev/projects/shop', model });
  }
  user(text) {
    this.add('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    return this.add('event_msg', { type: 'item_completed', thread_id: this.id, turn_id: 't1', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } });
  }
  agent(text, phase = 'final_answer') {
    this.add('event_msg', { type: 'item_completed', thread_id: this.id, turn_id: 't1', item: { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text }], phase } });
    return this.add('response_item', { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text }], status: 'completed', phase });
  }
  reasoning() {
    return this.add('response_item', { type: 'reasoning', id: 'r', summary: [], encrypted_content: 'gAAAA' });
  }
  exec(input) {
    return this.add('response_item', { type: 'custom_tool_call', id: 'c', status: 'completed', call_id: 'call_1', name: 'exec', input });
  }
  execOutput(text = 'Script completed') {
    return this.add('response_item', { type: 'custom_tool_call_output', id: 'o', call_id: 'call_1', output: [{ type: 'input_text', text }] });
  }
  command(cmd, parsed = [{ type: 'unknown', cmd }]) {
    return this.add('event_msg', {
      type: 'item_completed',
      thread_id: this.id,
      turn_id: 't1',
      item: { type: 'CommandExecution', id: 'x', command: ['/bin/zsh', '-lc', cmd], cwd: '/Users/dev/projects/shop', parsed_cmd: parsed, status: 'completed', exit_code: 0, aggregated_output: 'ok' },
    });
  }
  tokens(total) {
    return this.add('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total }, model_context_window: 400000 }, rate_limits: null });
  }
  taskComplete(lastAgentMessage = null, extra = {}) {
    return this.add('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: lastAgentMessage, completed_at: Math.floor(this.ts / 1000), duration_ms: 1000, ...extra });
  }
}

const list = (maxAgeMs = HOUR) => listSessions({ now: Date.now(), maxAgeMs });

test('exports the codex tool id', () => {
  assert.equal(tool, 'codex');
});

test('missing or empty Codex home yields no sessions and never throws', async () => {
  setCodexHome(path.join(os.tmpdir(), 'agent-office-codex-does-not-exist'));
  assert.deepEqual(await list(), []);
  assert.deepEqual(await getTranscript(X_ID, { limit: 10 }), []);
  mkHome();
  assert.deepEqual(await list(), []);
});

test('mid-turn session: title from first real prompt, source, model, tokens, live activity', async () => {
  const home = mkHome();
  const r = new Rollout(home, X_ID);
  r.meta({ originator: 'codex_exec', source: 'exec' }).taskStarted().preamble('gpt-test-1');
  r.user('Fix the flaky login test\nand tell me why it failed').reasoning();
  r.exec('text(await tools.exec_command({cmd:"cd /Users/dev/projects/shop && npm test -- --run",workdir:"/Users/dev/projects/shop"}))');
  r.tokens(12345);

  let [s, ...rest] = await list();
  assert.equal(rest.length, 0);
  assert.equal(s.tool, 'codex');
  assert.equal(s.nativeId, X_ID);
  assert.equal(s.title, 'Fix the flaky login test and tell me why it failed');
  assert.equal(s.cwd, '/Users/dev/projects/shop');
  assert.equal(s.branch, 'feature/login');
  assert.equal(s.model, 'gpt-test-1');
  assert.equal(s.source, 'cli');
  assert.equal(s.turnState, 'mid');
  assert.deepEqual(s.activity, { kind: 'running', label: 'Bash: npm test -- --run' });
  assert.equal(s.tokens, 12345);
  assert.deepEqual(s.subagents, []);
  assert.equal(s.lastMessage, undefined);
  assert.ok(Math.abs(s.lastActivityAt - fs.statSync(r.file).mtimeMs) < 2);
  assert.ok(s.startedAt > 0 && s.startedAt <= s.lastActivityAt);

  // the call's output arrives, then the agent reads, searches and patches files: incremental re-read only
  r.execOutput().command('cat /Users/dev/projects/shop/src/auth/login.js', [{ type: 'read', cmd: 'cat src/auth/login.js', name: 'login.js', path: '/Users/dev/projects/shop/src/auth/login.js' }]);
  [s] = await list();
  assert.deepEqual(s.activity, { kind: 'reading', label: 'Read login.js' });

  r.exec('text(await tools.exec_command({cmd:"rg -n \\"retry\\" /Users/dev/projects/shop/src"}))');
  [s] = await list();
  assert.equal(s.activity.kind, 'searching');
  assert.ok(!s.activity.label.includes('/Users/'), 'labels use basenames');

  r.exec('text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /Users/dev/projects/shop/src/auth/login.test.js\\n@@\\n-a\\n+b\\n*** Add File: /Users/dev/projects/shop/notes.md\\n+hi\\n*** End Patch"))');
  [s] = await list();
  assert.deepEqual(s.activity, { kind: 'editing', label: 'Edit login.test.js +1' });
  assert.equal(s.turnState, 'mid');

  r.agent('Looking at the retry logic now.', 'commentary');
  [s] = await list();
  assert.equal(s.activity.kind, 'writing');
  assert.equal(s.lastMessage, 'Looking at the retry logic now.');
});

test('completed turn: ended, title from session_index.jsonl, lastMessage clipped, desktop source', async () => {
  const home = mkHome();
  fs.writeFileSync(
    path.join(home, 'session_index.jsonl'),
    `${JSON.stringify({ id: X_ID, thread_name: 'Old name', updated_at: '2026-11-13T00:00:00Z' })}\nnot json\n${JSON.stringify({ id: X_ID, thread_name: 'Fix login flake', updated_at: '2026-11-13T00:01:00Z' })}\n`,
  );
  const long = `Done. ${'The retry helper swallowed the timeout. '.repeat(100)}`;
  const r = new Rollout(home, X_ID);
  r.meta().taskStarted().preamble('gpt-test-2').user('Fix the flaky login test').reasoning();
  r.exec('text(await tools.exec_command({cmd:"npm test"}))').command('npm test').execOutput();
  r.agent(long).tokens(999).taskComplete(long);

  let [s, ...rest] = await list();
  assert.equal(rest.length, 0);
  assert.equal(s.title, 'Fix login flake');
  assert.equal(s.source, 'desktop'); // originator wins over source:"vscode"
  assert.equal(s.turnState, 'ended');
  assert.equal(s.activity.kind, 'waiting');
  assert.equal(s.lastMessage.length, 2400);
  assert.ok(s.lastMessage.startsWith('Done. The retry helper'));
  assert.equal(s.tokens, 999);
  assert.equal(s.model, 'gpt-test-2');

  // a background command finishing after task_complete must not reopen the turn
  r.command('sleep 5');
  [s] = await list();
  assert.equal(s.turnState, 'ended');

  // interrupted turn
  r.taskStarted().user('one more thing').add('event_msg', { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' });
  [s] = await list();
  assert.equal(s.turnState, 'ended');
  assert.deepEqual(s.activity, { kind: 'waiting', label: 'Interrupted' });
});

test('malformed and truncated lines are tolerated; a half-written last line is picked up once complete', async () => {
  const home = mkHome();
  const r = new Rollout(home, X_ID);
  r.meta().taskStarted().preamble().user('Refactor the cart module');
  r.raw('this is not json at all\n{"timestamp":"2026-11-13T00:00:00.000Z","ordinal":99,"type":"event_msg","payload":{"type":"mystery_event","x":1}}\n[1,2,3]\nnull\n');
  r.exec('text(await tools.exec_command({cmd:"make build"}))');
  const done = r.line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'All done.' });
  r.raw(done.slice(0, 70)); // truncated mid-record, no newline

  let [s] = await list();
  assert.equal(s.turnState, 'mid');
  assert.deepEqual(s.activity, { kind: 'running', label: 'Bash: make build' });
  assert.equal(s.title, 'Refactor the cart module');

  r.raw(`${done.slice(70)}\n`);
  [s] = await list();
  assert.equal(s.turnState, 'ended');
  assert.equal(s.lastMessage, 'All done.');

  // a file that is nothing but garbage is skipped, not fatal
  fs.writeFileSync(path.join(dayDir(home), `rollout-2026-11-13T11-00-00-${G_ID}.jsonl`), '{"timestamp":"2026-11-13T00:0');
  fs.writeFileSync(path.join(dayDir(home), 'rollout-garbage.jsonl'), '\u0000\u0001 nope\n');
  const all = await list();
  assert.equal(all.length, 1);
  assert.equal(all[0].nativeId, X_ID);
});

test('bounded tail: huge logs and oversized lines; turn start outside the window is inferred as mid', async () => {
  const home = mkHome();
  const r = new Rollout(home, X_ID);
  r.meta().taskStarted().preamble('gpt-test-3').user('Migrate the database');
  const blob = 'x'.repeat(60_000);
  for (let i = 0; i < 12; i++) r.exec('text(await tools.exec_command({cmd:"echo chunk"}))').execOutput(blob); // ~720 KB
  r.add('compacted', { message: 'y'.repeat(700_000), replacement_history: [] }); // one line bigger than the tail window
  r.exec('text(await tools.exec_command({cmd:"psql -f migrate.sql"}))');
  assert.ok(fs.statSync(r.file).size > 1_400_000);

  let [s] = await list();
  assert.equal(s.title, 'Migrate the database'); // from the bounded head scan
  assert.equal(s.model, 'gpt-test-3');
  assert.equal(s.turnState, 'mid'); // task_started is far outside the tail window
  assert.deepEqual(s.activity, { kind: 'running', label: 'Bash: psql -f migrate.sql' });

  // file ends inside a giant line with no newline in the tail window at all
  r.raw(`{"timestamp":"${new Date().toISOString()}","ordinal":9999,"type":"compacted","payload":{"message":"${'z'.repeat(900_000)}`);
  [s] = await list();
  assert.equal(s.turnState, 'mid');
  assert.equal(s.activity.label, 'Bash: psql -f migrate.sql');

  r.raw('"}}\n');
  r.agent('Migration applied.').taskComplete('Migration applied.');
  [s] = await list();
  assert.equal(s.turnState, 'ended');
  assert.equal(s.lastMessage, 'Migration applied.');
});

test('spawned child threads become subagents of the parent; guardian helpers stay hidden', async () => {
  const home = mkHome();
  const now = Date.now();
  const parent = new Rollout(home, P_ID);
  parent.meta().taskStarted().preamble().user('Review the API change with a second pair of eyes').reasoning();
  parent.add('response_item', { type: 'function_call', status: 'completed', id: 'f', namespace: 'collaboration', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'api_review', message: 'gAAAAencrypted' }), call_id: 'call_s' });
  parent.add('response_item', { type: 'function_call_output', id: 'fo', call_id: 'call_s', output: '{"task_name":"/root/api_review"}' });
  parent.touch(now - 30_000);

  // forked child: own session_meta first, then a copy of the parent's history (ordinals < start), then its own turn
  const child = new Rollout(home, C_ID, { startOrdinal: 0 });
  child.meta({
    session_id: P_ID,
    forked_from_id: P_ID,
    parent_thread_id: P_ID,
    source: { subagent: { thread_spawn: { parent_thread_id: P_ID, depth: 1, agent_path: '/root/api_review', agent_nickname: 'Zeno', agent_role: null } } },
    thread_source: 'subagent',
    subagent_history_start_ordinal: 8,
    agent_path: '/root/api_review',
    agent_nickname: 'Zeno',
  });
  child.add('session_meta', { session_id: P_ID, id: P_ID, timestamp: new Date(now).toISOString(), cwd: '/Users/dev/projects/shop', originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' });
  child.taskStarted().user('Review the API change with a second pair of eyes').agent('copied parent answer').taskComplete('copied parent answer'); // inherited history: ordinals 2..7
  assert.equal(child.ordinal, 8);
  child.taskStarted();
  child.add('response_item', { type: 'agent_message', id: 'am', author: '/root', recipient: '/root/api_review', content: [{ type: 'input_text', text: 'Message from /root' }, { type: 'encrypted_content', encrypted_content: 'gAAAA' }] });
  child.exec('text(await tools.exec_command({cmd:"rg -n TODO src"}))');
  child.touch(now - 5_000);

  // guardian (auto-review) helper thread of the same parent
  const guardian = new Rollout(home, G_ID);
  guardian.meta({ session_id: P_ID, parent_thread_id: P_ID, source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' });
  guardian.taskStarted().user('review this command').agent('{"outcome":"allow"}').taskComplete('{"outcome":"allow"}');
  guardian.touch(now - 20_000);

  let sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(sessions.length, 1, 'child and guardian are not top-level sessions');
  let [p] = sessions;
  assert.equal(p.nativeId, P_ID);
  assert.equal(p.turnState, 'mid');
  assert.deepEqual(p.activity, { kind: 'delegating', label: 'Spawn agent: api review' });
  assert.equal(p.subagents.length, 1);
  let [sub] = p.subagents;
  assert.equal(sub.id, C_ID);
  assert.equal(sub.label, 'api review');
  assert.equal(sub.status, 'working'); // the copied task_complete (ordinal < start) is ignored
  assert.equal(sub.activity.kind, 'searching');
  assert.equal(sub.endedAt, undefined);
  assert.ok(Math.abs(sub.lastActivityAt - (now - 5_000)) < 1500);
  assert.ok(Math.abs(p.lastActivityAt - (now - 5_000)) < 1500, 'parent lastActivityAt covers its subagents');

  // parent finishes its own turn while the child is still running -> it still owes output
  parent.taskComplete('Waiting on the reviewer.').touch(now - 4_000);
  [p] = await listSessions({ now, maxAgeMs: HOUR });
  assert.equal(p.turnState, 'mid');
  assert.deepEqual(p.activity, { kind: 'delegating', label: 'Waiting on 1 agent' });

  // child finishes
  child.agent('No blocking issues found.').taskComplete('No blocking issues found.').touch(now - 2_000);
  [p] = await listSessions({ now, maxAgeMs: HOUR });
  [sub] = p.subagents;
  assert.equal(sub.status, 'done');
  assert.equal(sub.activity.kind, 'idle');
  assert.ok(sub.endedAt > 0);
  assert.equal(p.turnState, 'ended');
  assert.equal(p.title, 'Review the API change with a second pair of eyes');

  // a new parent turn starts later: last turn's finished subagents are no longer reported
  parent.ts = now + 60_000;
  parent.taskStarted().user('thanks, now ship it').touch(now + 61_000);
  [p] = await listSessions({ now: now + 62_000, maxAgeMs: HOUR });
  assert.equal(p.turnState, 'mid');
  assert.deepEqual(p.subagents, []);

  // the child's transcript is its own work only, not the forked parent history
  const msgs = await getTranscript(C_ID, { limit: 50 });
  assert.ok(msgs.length > 0);
  assert.ok(!msgs.some((m) => m.text.includes('copied parent answer')));
  assert.equal(msgs.at(-1).text, 'No blocking issues found.');

  // a failed child turn
  child.ts = now + 70_000;
  child.taskStarted().taskComplete(null, { error: { message: 'boom', codex_error_info: 'other' } }).touch(now + 71_000);
  parent.touch(now + 61_000);
  [p] = await listSessions({ now: now + 72_000, maxAgeMs: HOUR });
  assert.equal(p.subagents.length, 1);
  assert.equal(p.subagents[0].status, 'failed');
});

test('a subagent whose parent log is gone is shown on its own', async () => {
  const home = mkHome();
  const child = new Rollout(home, C_ID);
  child.meta({ session_id: P_ID, parent_thread_id: P_ID, source: { subagent: { thread_spawn: { parent_thread_id: P_ID, depth: 1, agent_path: '/root/lonely_audit', agent_nickname: 'Hume', agent_role: 'reviewer' } } }, thread_source: 'subagent' });
  child.taskStarted().exec('text(await tools.exec_command({cmd:"ls"}))');
  const [s, ...rest] = await list();
  assert.equal(rest.length, 0);
  assert.equal(s.nativeId, C_ID);
  assert.equal(s.title, 'lonely audit');
  assert.equal(s.turnState, 'mid');
});

test('only sessions active within maxAgeMs are returned; old files that are appended to come back', async () => {
  const home = mkHome();
  const now = Date.now();
  const old = new Rollout(home, X_ID);
  old.meta().taskStarted().preamble().user('Old question').agent('Old answer').taskComplete('Old answer').touch(now - 2 * HOUR);
  const fresh = new Rollout(home, P_ID);
  fresh.meta({ originator: 'codex-tui', source: 'cli' }).taskStarted().preamble().user('New question').touch(now - 60_000);

  let sessions = await listSessions({ now, maxAgeMs: HOUR });
  assert.deepEqual(sessions.map((s) => s.nativeId), [P_ID]);
  assert.equal(sessions[0].source, 'cli');
  sessions = await listSessions({ now, maxAgeMs: 3 * HOUR });
  assert.deepEqual(sessions.map((s) => s.nativeId), [P_ID, X_ID]); // most recent first
  assert.ok(sessions.every((s) => s.lastActivityAt >= now - 3 * HOUR));

  // the old session is resumed: it is back on the very next poll
  old.taskStarted().user('Follow-up question');
  sessions = await listSessions({ now: Date.now(), maxAgeMs: HOUR });
  assert.deepEqual(sessions.map((s) => s.nativeId), [X_ID, P_ID]);
  assert.equal(sessions[0].turnState, 'mid');

  // warm polls are cheap and stable
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) await listSessions({ now, maxAgeMs: 3 * HOUR });
  assert.ok((performance.now() - t0) / 50 < 50, 'warm call under 50 ms');
});

test('getTranscript: ordered, de-duplicated, limited, clipped', async () => {
  const home = mkHome();
  const r = new Rollout(home, X_ID);
  r.meta().taskStarted().preamble().user('Fix the flaky login test').reasoning();
  r.agent('I will run the tests first.', 'commentary');
  r.exec('text(await tools.exec_command({cmd:"npm test"}))').command('npm test').execOutput();
  r.add('event_msg', { type: 'item_completed', thread_id: X_ID, turn_id: 't1', item: { type: 'FileChange', id: 'fc', changes: { '/Users/dev/projects/shop/src/auth/login.js': { type: 'update', unified_diff: '@@' } }, status: 'completed' } });
  r.add('event_msg', { type: 'item_completed', thread_id: X_ID, turn_id: 't1', item: { type: 'Extension', id: 'e', kind: 'web.search', action: { type: 'search', query: 'jest fake timers', queries: null }, results: [] } });
  r.agent(`Fixed. ${'z'.repeat(3000)}`).taskComplete('Fixed.');

  const msgs = await getTranscript(X_ID, { limit: 60 });
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['user', 'assistant', 'tool', 'tool', 'tool', 'assistant'],
  );
  assert.equal(msgs[0].text, 'Fix the flaky login test');
  assert.equal(msgs[1].text, 'I will run the tests first.');
  assert.deepEqual([msgs[2].text, msgs[2].toolName], ['Bash: npm test', 'Bash']);
  assert.deepEqual([msgs[3].text, msgs[3].toolName], ['Edit: login.js', 'Edit']);
  assert.equal(msgs[4].text, 'WebSearch: jest fake timers');
  assert.equal(msgs[5].text.length, 2000);
  for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i].ts >= msgs[i - 1].ts);
  assert.ok(msgs.every((m) => typeof m.ts === 'number' && m.ts > 0 && m.text.length <= 2000));

  const last2 = await getTranscript(X_ID, { limit: 2 });
  assert.deepEqual(last2.map((m) => m.role), ['tool', 'assistant']);
  assert.deepEqual(await getTranscript('01a1d000-0000-7000-8000-ffffffffffff', { limit: 5 }), []);
  assert.deepEqual(await getTranscript('../../etc/passwd', { limit: 5 }), []);
});

test('older Codex record names (event user_message/agent_message, shell function_call) still work', async () => {
  const home = mkHome();
  const r = new Rollout(home, X_ID);
  // no ordinal, legacy key set
  const legacy = (type, payload) => r.raw(`${JSON.stringify({ timestamp: new Date((r.ts += 250)).toISOString(), type, payload })}\n`);
  legacy('session_meta', { id: X_ID, timestamp: new Date(r.ts).toISOString(), cwd: '/tmp/legacy', originator: 'codex_cli_rs', cli_version: '0.40.0', source: 'cli', git: { branch: 'main' } });
  legacy('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/tmp/legacy</cwd>\n</environment_context>' }] });
  legacy('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files' }] });
  legacy('event_msg', { type: 'user_message', message: 'List the files', kind: 'plain' });
  legacy('turn_context', { cwd: '/tmp/legacy', model: 'gpt-old' });
  legacy('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'] }), call_id: 'c1' });

  let [s] = await list();
  assert.equal(s.title, 'List the files');
  assert.equal(s.source, 'cli');
  assert.equal(s.model, 'gpt-old');
  assert.equal(s.turnState, 'mid');
  assert.deepEqual(s.activity, { kind: 'running', label: 'Bash: ls -la' });

  legacy('response_item', { type: 'function_call_output', call_id: 'c1', output: 'a\nb' });
  legacy('event_msg', { type: 'agent_message', message: 'Two files: a and b.' });
  legacy('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Two files: a and b.' }] });
  legacy('event_msg', { type: 'task_complete', last_agent_message: 'Two files: a and b.' });
  [s] = await list();
  assert.equal(s.turnState, 'ended');
  assert.equal(s.lastMessage, 'Two files: a and b.');

  const msgs = await getTranscript(X_ID, { limit: 10 });
  assert.deepEqual(msgs.map((m) => `${m.role}:${m.text}`), ['user:List the files', 'tool:Bash: ls -la', 'assistant:Two files: a and b.']);
});
