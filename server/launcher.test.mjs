import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildArgs,
  childEnv,
  createLauncher,
  createParser,
  createTail,
  cursorNotes,
  describeTool,
  isNestingVar,
  LauncherError,
  MAX_RUNNING,
  parseCursorCaps,
  PERMISSION_NOTES,
  READ_ONLY_PREAMBLE,
  validateCwd,
} from './launcher.mjs';
import { createMetaStore, createMockMeta } from './meta.mjs';

const P = 'Reply with the single word OK and nothing else.';
const UUID = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- command lines ----------------------------------------------------------

test('claude: new run per permission', () => {
  const base = ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', UUID];
  assert.deepEqual(buildArgs({ tool: 'claude', prompt: P, permission: 'read', sessionUuid: UUID }), [...base, '--permission-mode', 'plan', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'claude', prompt: P, permission: 'edit', sessionUuid: UUID }), [...base, '--permission-mode', 'acceptEdits', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'claude', prompt: P, permission: 'full', sessionUuid: UUID }), [...base, '--dangerously-skip-permissions', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'claude', prompt: P, sessionUuid: UUID }), [...base, '--permission-mode', 'acceptEdits', '--', P], 'edit is the default');
  assert.deepEqual(buildArgs({ tool: 'claude', prompt: P, permission: 'read', sessionUuid: UUID, model: 'sonnet' }), [...base, '--permission-mode', 'plan', '--model', 'sonnet', '--', P]);
});

test('claude: follow-up resumes by session id', () => {
  const base = ['-p', '--output-format', 'stream-json', '--verbose', '--resume', UUID];
  assert.deepEqual(buildArgs({ tool: 'claude', prompt: P, permission: 'read', resume: UUID }), [...base, '--permission-mode', 'plan', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'claude', prompt: P, permission: 'edit', resume: UUID }), [...base, '--permission-mode', 'acceptEdits', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'claude', prompt: P, permission: 'full', resume: UUID }), [...base, '--dangerously-skip-permissions', '--', P]);
});

test('codex: new run per permission', () => {
  const never = ['-c', 'approval_policy="never"'];
  const base = ['exec', '--json', '--skip-git-repo-check'];
  assert.deepEqual(buildArgs({ tool: 'codex', prompt: P, permission: 'read' }), [...base, '-s', 'read-only', ...never, '--', P]);
  assert.deepEqual(buildArgs({ tool: 'codex', prompt: P, permission: 'edit' }), [...base, '-s', 'workspace-write', ...never, '--', P]);
  assert.deepEqual(buildArgs({ tool: 'codex', prompt: P, permission: 'full' }), [...base, '--dangerously-bypass-approvals-and-sandbox', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'codex', prompt: P, permission: 'edit', model: 'gpt-5.2-codex' }), [...base, '-s', 'workspace-write', ...never, '-m', 'gpt-5.2-codex', '--', P]);
});

test('codex: follow-up uses exec resume with config overrides (it has no -s flag)', () => {
  const never = ['-c', 'approval_policy="never"'];
  const base = ['exec', 'resume', '--json', '--skip-git-repo-check'];
  assert.deepEqual(buildArgs({ tool: 'codex', prompt: P, permission: 'read', resume: UUID }), [...base, '-c', 'sandbox_mode="read-only"', ...never, '--', UUID, P]);
  assert.deepEqual(buildArgs({ tool: 'codex', prompt: P, permission: 'edit', resume: UUID }), [...base, '-c', 'sandbox_mode="workspace-write"', ...never, '--', UUID, P]);
  assert.deepEqual(buildArgs({ tool: 'codex', prompt: P, permission: 'full', resume: UUID }), [...base, '--dangerously-bypass-approvals-and-sandbox', '--', UUID, P]);
});

test('cursor (build without --mode): no read-only flag exists, so read and edit stay without --force', () => {
  const base = ['-p', '--output-format', 'stream-json'];
  const caps = parseCursorCaps('  -p, --print\n  --output-format <format>\n  --resume [chatId]\n  --model <model>\n  -f, --force');
  assert.deepEqual(caps, { mode: false, sandbox: false, trust: false });
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'read', cursorCaps: caps }), [...base, '--', READ_ONLY_PREAMBLE + P]);
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'edit', cursorCaps: caps }), [...base, '--', P]);
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'full', cursorCaps: caps }), [...base, '--force', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'read' }), [...base, '--', READ_ONLY_PREAMBLE + P], 'unknown capabilities are treated as the old build');
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'edit', resume: 'chat-123', model: 'gpt-5', cursorCaps: caps }), [...base, '--resume', 'chat-123', '--model', 'gpt-5', '--', P]);
  assert.equal(cursorNotes(caps), PERMISSION_NOTES.cursorLegacy);
});

test('cursor (current build): plan mode, sandbox, trust', () => {
  const caps = parseCursorCaps('--mode <mode>  Start in the given execution mode\n--sandbox <mode>\n--trust  Trust the current workspace\n-f, --force');
  assert.deepEqual(caps, { mode: true, sandbox: true, trust: true });
  const base = ['-p', '--output-format', 'stream-json', '--trust'];
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'read', cursorCaps: caps }), [...base, '--mode', 'plan', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'edit', cursorCaps: caps }), [...base, '--sandbox', 'enabled', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'full', cursorCaps: caps }), [...base, '--force', '--', P]);
  assert.deepEqual(buildArgs({ tool: 'cursor', prompt: P, permission: 'read', resume: 'chat-123', cursorCaps: caps }), [...base, '--resume', 'chat-123', '--mode', 'plan', '--', P]);
  assert.equal(cursorNotes(caps), PERMISSION_NOTES.cursor);
});

test('the prompt is always the last argument, after --, untouched', () => {
  const nasty = '--dangerously-skip-permissions; rm -rf ~ $(whoami) `id` "quoted"\nsecond line';
  for (const tool of ['claude', 'codex', 'cursor']) {
    for (const permission of ['edit', 'full']) {
      for (const resume of [undefined, UUID]) {
        const args = buildArgs({ tool, prompt: nasty, permission, resume, sessionUuid: UUID, cursorCaps: { mode: true } });
        assert.equal(args.at(-1), nasty);
        assert.equal(args.indexOf('--'), args.length - (tool === 'codex' && resume ? 3 : 2));
        assert.equal(args.filter((a) => a === nasty).length, 1);
      }
    }
  }
});

test('every tool has a note for every permission level', () => {
  for (const key of ['claude', 'codex', 'cursor', 'cursorLegacy']) {
    for (const level of ['read', 'edit', 'full']) assert.ok(PERMISSION_NOTES[key][level].length > 10, `${key}.${level}`);
  }
});

test('bad input is refused', () => {
  const bad = (o, re) => assert.throws(() => buildArgs({ tool: 'claude', prompt: P, ...o }), (e) => e instanceof LauncherError && e.status === 400 && re.test(e.message));
  bad({ tool: 'bash' }, /tool must be/);
  bad({ permission: 'root' }, /permission must be/);
  bad({ prompt: '' }, /empty/);
  bad({ prompt: '   \n ' }, /empty/);
  bad({ prompt: 'x'.repeat(20_001) }, /too long/);
  bad({ prompt: 42 }, /string/);
  bad({ prompt: 'a\0b' }, /NUL/);
  bad({ model: '--dangerously-skip-permissions' }, /model/);
  bad({ model: 'a b' }, /model/);
  bad({ resume: '--last' }, /session id/);
  bad({ resume: 'a b' }, /session id/);
  assert.equal(buildArgs({ tool: 'claude', prompt: 'x'.repeat(20_000), sessionUuid: UUID }).at(-1).length, 20_000);

  assert.throws(() => validateCwd('relative/path'), /absolute/);
  assert.throws(() => validateCwd(''), /absolute/);
  assert.throws(() => validateCwd(path.join(os.tmpdir(), 'ao-no-such-dir-xyz')), /does not exist/);
  assert.throws(() => validateCwd(new URL(import.meta.url).pathname), /not a directory/);
  assert.equal(validateCwd(os.tmpdir() + path.sep), path.resolve(os.tmpdir()));
});

// --- environment ------------------------------------------------------------

test('childEnv drops the markers of an enclosing agent session and keeps auth, config and PATH', () => {
  const env = childEnv(
    {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '1234',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_HOST_SESSION_ID: 'x',
      CLAUDE_CODE_MESSAGING_TOKEN: 'x',
      CLAUDE_CODE_DESKTOP_APP_VERSION: 'x',
      CLAUDE_AGENT_SDK_VERSION: 'x',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
      CODEX_SANDBOX: 'seatbelt',
      CODEX_THREAD_ID: 'x',
      CURSOR_AGENT: '1',
      CURSOR_TRACE_ID: 'x',
      ANTHROPIC_API_KEY: 'keep',
      ANTHROPIC_BASE_URL: 'keep',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep',
      CLAUDE_CODE_USE_BEDROCK: 'keep',
      CLAUDE_CONFIG_DIR: 'keep',
      OPENAI_API_KEY: 'keep',
      CODEX_HOME: 'keep',
      CURSOR_API_KEY: 'keep',
      UNDEFINED_ONE: undefined,
    },
    ['/opt/tools/bin', '/usr/bin', '/node/bin'],
  );
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CURSOR_API_KEY', 'HOME', 'OPENAI_API_KEY', 'PATH']);
  assert.equal(env.PATH, '/usr/bin:/bin:/opt/tools/bin:/node/bin', 'PATH is extended, never reordered');
  assert.ok(isNestingVar('CLAUDECODE') && !isNestingVar('PATH') && !isNestingVar('CLAUDE_CODE_MAX_OUTPUT_TOKENS'));
});

// --- parsing ----------------------------------------------------------------

function run(tool, events) {
  const parser = createParser(tool);
  const tail = createTail();
  let sessionId;
  let result;
  for (const e of events) {
    const r = parser.feed(typeof e === 'string' ? e : JSON.stringify(e));
    for (const chunk of r.out) tail.push(chunk);
    if (r.sessionId) sessionId = r.sessionId;
    if (r.result) result = r.result;
  }
  return { text: tail.value, sessionId, result };
}

test('claude stream-json becomes readable lines', () => {
  const { text, sessionId, result } = run('claude', [
    { type: 'system', subtype: 'init', session_id: UUID, model: 'x', tools: [] },
    { type: 'assistant', session_id: UUID, message: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Let me look.' }] } },
    { type: 'assistant', session_id: UUID, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'run tests' } }] } },
    { type: 'user', session_id: UUID, message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', session_id: UUID, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/launcher.mjs' } }] } },
    { type: 'assistant', session_id: UUID, parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'subagent chatter' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }] } },
    { type: 'assistant', session_id: UUID, message: { content: [{ type: 'text', text: 'All good.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'All good.', session_id: UUID },
  ]);
  assert.equal(sessionId, UUID);
  assert.deepEqual(result, { ok: true });
  assert.equal(text, 'Let me look.\n→ Bash npm test\n→ Read launcher.mjs\n  → Grep "TODO"\nAll good.\n✓ Done');
});

test('claude errors are reported as the outcome', () => {
  const failed = run('claude', [{ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: UUID, errors: ['No conversation found'] }]);
  assert.deepEqual(failed.result, { ok: false, error: 'No conversation found' });
  assert.match(failed.text, /^✗ No conversation found/);
  const apiError = run('claude', [{ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key', session_id: UUID }]);
  assert.equal(apiError.result.ok, false);
  assert.match(apiError.text, /✗ Invalid API key/);
});

test('codex --json becomes readable lines', () => {
  const { text, sessionId, result } = run('codex', [
    { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', exit_code: 2, status: 'failed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/w/src/a.ts', kind: 'update' }, { path: '/w/b.ts', kind: 'add' }] } },
    { type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call', server: 'docs', tool: 'search' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'OK' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  assert.equal(sessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.deepEqual(result, { ok: true });
  assert.equal(text, '→ Shell bash -lc ls\n  exit 2\n→ Edit a.ts, b.ts\n→ docs.search\nOK\n✓ Done');
  const failed = run('codex', [{ type: 'error', message: 'Reconnecting... 1/5' }, { type: 'turn.failed', error: { message: 'unauthorized' } }]);
  assert.deepEqual(failed.result, { ok: false, error: 'unauthorized' });
  assert.equal(failed.text, '✗ Reconnecting... 1/5\n✗ unauthorized');

  // As seen from codex-cli 0.157.0 when the configured model is not available to the account.
  const api = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'x' model is not supported.", code: 'model_not_found' } });
  const rejected = run('codex', [
    'Reading additional input from stdin...',
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found.' } },
    { type: 'turn.started' },
    { type: 'error', message: api },
    { type: 'turn.failed', error: { message: api } },
  ]);
  assert.equal(rejected.sessionId, 't-1');
  assert.deepEqual(rejected.result, { ok: false, error: "The 'x' model is not supported." });
  assert.equal(rejected.text, "! Model metadata for `x` not found.\n✗ The 'x' model is not supported.");
});

test('cursor stream-json: streamed pieces join into one paragraph', () => {
  const sid = 'c0ffee00-1111-4222-8333-444444444444';
  const { text, sessionId, result } = run('cursor', [
    { type: 'system', subtype: 'init', session_id: sid, model: 'auto', cwd: '/w' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, session_id: sid },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at ' }] }, session_id: sid },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the file.' }] }, session_id: sid },
    { type: 'tool_call', subtype: 'started', call_id: '1', tool_call: { readToolCall: { args: { path: '/w/src/index.js' } } }, session_id: sid },
    { type: 'tool_call', subtype: 'completed', call_id: '1', tool_call: { readToolCall: { args: { path: '/w/src/index.js' }, result: {} } }, session_id: sid },
    { type: 'tool_call', subtype: 'started', call_id: '2', tool_call: { function: { name: 'run_terminal_cmd', arguments: '{"command":"ls -la"}' } }, session_id: sid },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] }, session_id: sid },
    { type: 'result', subtype: 'success', is_error: false, result: 'Looking at the file.OK', session_id: sid },
  ]);
  assert.equal(sessionId, sid);
  assert.deepEqual(result, { ok: true });
  assert.equal(text, 'Looking at the file.\n→ Read index.js\n→ Run_terminal_cmd ls -la\nOK\n✓ Done');
});

test('plain text lines (stderr) are shown as they are; junk never throws', () => {
  const { text, result } = run('codex', ['\u001b[31mError: not logged in\u001b[0m', '', '{not json', '{"type":"item.completed","item":null}', '[1,2]']);
  assert.equal(text, 'Error: not logged in\n{not json\n[1,2]');
  assert.equal(result, undefined);
});

test('describeTool picks the telling argument', () => {
  assert.equal(describeTool('Edit', { file_path: '/x/y/z.ts', old_string: 'a' }), '→ Edit z.ts');
  assert.equal(describeTool('WebFetch', { url: 'https://example.com/a' }), '→ WebFetch https://example.com/a');
  assert.equal(describeTool('Task', { description: 'Map call sites', prompt: 'long' }), '→ Task Map call sites');
  assert.equal(describeTool('Mystery', {}), '→ Mystery');
  assert.ok(describeTool('Bash', { command: 'x'.repeat(500) }).length <= 120);
});

test('the tail keeps the last 4000 characters', () => {
  const tail = createTail();
  for (let i = 0; i < 500; i++) tail.push({ text: `line ${i} ${'x'.repeat(40)}` });
  assert.equal(tail.value.length, 4000);
  assert.ok(tail.value.endsWith(`line 499 ${'x'.repeat(40)}`));
});

// --- real processes, with a stand-in CLI --------------------------------------

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-launch-'));
  const bin = path.join(root, 'fake-agent');
  // Behaves like `claude -p --output-format stream-json`: echoes the session id it was given,
  // says something, and either finishes or (prompt "hang") sits there with a child of its own.
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sid = flag('--session-id') || flag('--resume');
const prompt = args.at(-1);
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: sid, nested: process.env.CLAUDECODE || null, stdinIsTTY: Boolean(process.stdin.isTTY) });
if (prompt === 'hang') {
  const { spawn } = await import('node:child_process');
  const kid = spawn('sleep', ['300'], { stdio: 'ignore' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'kid ' + kid.pid }] } });
  if (args.includes('--dangerously-skip-permissions')) process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (prompt === 'fail') {
  console.error('Error: not logged in');
  process.exit(3);
} else {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'cwd ' + process.cwd() }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: sid });
}
`,
    { mode: 0o755 },
  );
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'work-')));
  const dir = path.join(root, 'tasks');
  const make = (extra = {}) => createLauncher({ tools: { claude: { available: true, path: bin } }, dir, pollMs: 25, killGraceMs: 400, env: { ...process.env, CLAUDECODE: '1' }, ...extra });
  return { root, bin, cwd, dir, make, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a run goes starting → done, links its session, and leaves a log behind', async () => {
  const f = fixture();
  let changes = 0;
  const launcher = f.make({ onChange: () => changes++ });
  const task = await launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, permission: 'read' });
  assert.equal(task.status, 'starting');
  assert.match(task.sessionId, /^claude:[0-9a-f-]{36}$/, 'claude session id is assigned before the process says anything');
  assert.equal(task.permission, 'read');
  assert.equal(task.cwd, f.cwd);
  assert.equal(task.outputTail, '');

  const done = await until(() => (launcher.get(task.id).status === 'done' ? launcher.get(task.id) : null));
  assert.equal(done.exitCode, 0);
  assert.ok(done.endedAt >= done.startedAt);
  assert.equal(done.sessionId, task.sessionId);
  assert.equal(done.outputTail, `cwd ${f.cwd}\nOK\n✓ Done`);
  assert.ok(changes >= 2);
  assert.deepEqual(launcher.list().map((t) => t.id), [task.id]);

  const log = fs.readFileSync(path.join(f.dir, `${task.id}.log`), 'utf8');
  const init = JSON.parse(log.split('\n')[0]);
  assert.equal(init.nested, null, 'the child does not see CLAUDECODE');
  assert.equal(init.stdinIsTTY, false);
  assert.equal(fs.statSync(path.join(f.dir, `${task.id}.log`)).mode & 0o077, 0, 'log is private to the user');
  launcher.close();
  f.cleanup();
});

test('a run that exits non-zero is failed and shows why', async () => {
  const f = fixture();
  const launcher = f.make();
  const task = await launcher.start({ tool: 'claude', prompt: 'fail', cwd: f.cwd });
  const failed = await until(() => (launcher.get(task.id).status === 'failed' ? launcher.get(task.id) : null));
  assert.equal(failed.exitCode, 3);
  assert.match(failed.outputTail, /Error: not logged in\n✗ Exited with code 3\n✗ claude is not signed in\. Run `claude auth login` in a terminal, then try again\.$/);
  launcher.close();
  f.cleanup();
});

test('stop: SIGTERM takes down the whole process group', async () => {
  const f = fixture();
  const launcher = f.make();
  const task = await launcher.start({ tool: 'claude', prompt: 'hang', cwd: f.cwd });
  const running = await until(() => (/kid \d+/.test(launcher.get(task.id).outputTail) ? launcher.get(task.id) : null));
  assert.equal(running.status, 'running');
  const kid = Number(/kid (\d+)/.exec(running.outputTail)[1]);
  assert.ok(alive(kid));

  const stopped = launcher.stop(task.id);
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.endedAt);
  await until(() => !alive(kid));
  assert.equal(launcher.get(task.id).status, 'stopped');
  assert.equal(launcher.stop(task.id).status, 'stopped', 'stopping twice is harmless');
  assert.throws(() => launcher.stop('task-nope'), (e) => e.status === 404);
  launcher.close();
  f.cleanup();
});

test('stop: a run that ignores SIGTERM is killed after the grace period', async () => {
  const f = fixture();
  const launcher = f.make();
  const task = await launcher.start({ tool: 'claude', prompt: 'hang', cwd: f.cwd, permission: 'full' });
  const running = await until(() => (/kid \d+/.test(launcher.get(task.id).outputTail) ? launcher.get(task.id) : null));
  const log = fs.readFileSync(path.join(f.dir, `${task.id}.log`), 'utf8');
  assert.ok(log.length > 0);
  const started = Date.now();
  launcher.stop(task.id);
  await until(() => typeof launcher.get(task.id).exitCode !== 'undefined', 5000);
  assert.ok(Date.now() - started >= 300, 'it was given the grace period first');
  assert.equal(launcher.get(task.id).status, 'stopped');
  assert.equal(running.status, 'running');
  launcher.close();
  f.cleanup();
});

test('at most six runs at a time', async () => {
  const f = fixture();
  const launcher = f.make();
  const tasks = [];
  for (let i = 0; i < MAX_RUNNING; i++) tasks.push(await launcher.start({ tool: 'claude', prompt: 'hang', cwd: f.cwd }));
  await assert.rejects(launcher.start({ tool: 'claude', prompt: 'hang', cwd: f.cwd }), (e) => e instanceof LauncherError && e.status === 429);
  launcher.stop(tasks[0].id);
  const extra = await launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd });
  await until(() => launcher.get(extra.id).status === 'done');
  for (const t of tasks) launcher.stop(t.id);
  await until(() => tasks.every((t) => typeof launcher.get(t.id).exitCode !== 'undefined'));
  assert.equal(launcher.list()[0].id, extra.id, 'newest first');
  launcher.close();
  f.cleanup();
});

test('start refuses what it cannot run', async () => {
  const f = fixture();
  const launcher = f.make();
  await assert.rejects(launcher.start({ tool: 'codex', prompt: P, cwd: f.cwd }), (e) => e.status === 503 && /codex is not installed/.test(e.message));
  await assert.rejects(launcher.start({ tool: 'claude', prompt: P, cwd: 'relative' }), (e) => e.status === 400);
  await assert.rejects(launcher.start({ tool: 'claude', prompt: P, cwd: path.join(f.root, 'missing') }), (e) => e.status === 400);
  await assert.rejects(launcher.start({ tool: 'claude', prompt: '', cwd: f.cwd }), (e) => e.status === 400);
  await assert.rejects(launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, permission: 'sudo' }), (e) => e.status === 400);
  await assert.rejects(launcher.start(null), (e) => e.status === 400);
  assert.deepEqual(launcher.list(), []);
  launcher.close();
  f.cleanup();
});

test('follow-up resumes the session in its directory and is linked with resumeOf', async () => {
  const f = fixture();
  const launcher = f.make();
  const sid = `claude:${UUID}`;
  await assert.rejects(launcher.followUp(sid, { prompt: P }), (e) => e.status === 404, 'a session nobody knows the directory of');
  await assert.rejects(launcher.followUp('emacs:1', { prompt: P }, { cwd: f.cwd }), (e) => e.status === 404);

  const task = await launcher.followUp(sid, { prompt: P, permission: 'read' }, { cwd: f.cwd });
  assert.equal(task.resumeOf, sid);
  assert.equal(task.sessionId, sid);
  await assert.rejects(launcher.followUp(sid, { prompt: P }, { cwd: f.cwd }), (e) => e.status === 409, 'one run per session at a time');
  const done = await until(() => (launcher.get(task.id).status === 'done' ? launcher.get(task.id) : null));
  assert.equal(done.sessionId, sid);

  // Later follow-ups remember the directory and the permission of the previous run.
  const again = await launcher.followUp(sid, { prompt: P });
  assert.equal(again.cwd, f.cwd);
  assert.equal(again.permission, 'read');
  await until(() => launcher.get(again.id).status === 'done');
  launcher.close();
  f.cleanup();
});

test('a run survives the launcher and is picked up again by the next one', async () => {
  const f = fixture();
  const first = f.make();
  const task = await first.start({ tool: 'claude', prompt: 'hang', cwd: f.cwd });
  const running = await until(() => (/kid \d+/.test(first.get(task.id).outputTail) ? first.get(task.id) : null));
  const kid = Number(/kid (\d+)/.exec(running.outputTail)[1]);
  await until(() => JSON.parse(fs.readFileSync(path.join(f.dir, 'index.json'), 'utf8')).tasks[0]?.pidStart);
  first.close();
  await sleep(100);
  assert.ok(alive(kid), 'closing the launcher does not stop the run');

  const second = f.make();
  const adopted = second.get(task.id);
  assert.equal(adopted.status, 'running');
  assert.equal(adopted.sessionId, task.sessionId);
  assert.match(adopted.outputTail, /kid \d+/);
  assert.equal(second.stop(task.id).status, 'stopped');
  await until(() => !alive(kid));
  second.close();

  // A third start finds nothing left running to adopt.
  const third = f.make();
  assert.deepEqual(third.list(), []);
  third.close();
  f.cleanup();
});

test('mock mode never spawns: a scripted task and a new character in the office', async () => {
  const added = [];
  const mock = { add: (o) => (added.push(o), `${o.tool}:mock-new-1`) };
  let changes = 0;
  const launcher = createLauncher({ mock, tools: {}, onChange: () => changes++ });
  const task = await launcher.start({ tool: 'codex', prompt: 'Tidy the README', cwd: '/Users/dev/projects/shop', permission: 'read' });
  assert.equal(task.status, 'starting');
  assert.equal(task.sessionId, 'codex:mock-new-1');
  assert.deepEqual(added, [{ tool: 'codex', prompt: 'Tidy the README', cwd: '/Users/dev/projects/shop', taskId: task.id }]);
  await until(() => launcher.get(task.id).status === 'running', 3000);
  assert.ok(launcher.get(task.id).outputTail.length > 0);

  const follow = await launcher.followUp('claude:mock-01', { prompt: 'And then?' }, { cwd: '/Users/dev/projects/shop/graph' });
  assert.equal(follow.resumeOf, 'claude:mock-01');
  assert.equal(added.length, 1, 'a follow-up does not add a character');

  assert.equal(launcher.stop(task.id).status, 'stopped');
  await sleep(50);
  assert.equal(launcher.get(task.id).status, 'stopped');
  assert.match(launcher.get(task.id).outputTail, /■ Stopped$/);
  await assert.rejects(launcher.start({ tool: 'codex', prompt: '', cwd: '/x' }), (e) => e.status === 400);
  assert.equal(launcher.permissionNotes().cursor, PERMISSION_NOTES.cursor);
  assert.ok(changes >= 3);
  launcher.close();
});

// --- names and groups at launch ---------------------------------------------

/** fixture() plus a meta store and a stand-in for `codex exec --json`, which names its session only in its output. */
function metaFixture() {
  const f = fixture();
  const codexBin = path.join(f.root, 'fake-codex');
  // Prompt "gate=<file> id=<thread>": says nothing (so no session id is known) until <file> exists.
  fs.writeFileSync(
    codexBin,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const prompt = args.at(-1);
const out = (o) => console.log(JSON.stringify(o));
const gate = /gate=(\\S+)/.exec(prompt)?.[1];
const id = /id=(\\S+)/.exec(prompt)?.[1] || 'thread-0001';
while (gate && !fs.existsSync(gate)) await new Promise((r) => setTimeout(r, 20));
out({ type: 'thread.started', thread_id: args[1] === 'resume' ? args.at(-2) : id });
out({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } });
out({ type: 'turn.completed' });
`,
    { mode: 0o755 },
  );
  const file = path.join(f.root, 'office', 'meta.json');
  const store = createMetaStore({ file });
  const tools = { claude: { available: true, path: f.bin }, codex: { available: true, path: codexBin } };
  return { ...f, file, store, gate: path.join(f.root, 'gate'), make: (extra = {}) => f.make({ tools, meta: store, ...extra }) };
}

test('a task can be named and grouped at launch (claude: the session id is known before the run says anything)', async () => {
  const f = metaFixture();
  const group = f.store.createGroup({ name: 'Checkout' });
  const launcher = f.make();

  const task = await launcher.start({ tool: 'claude', prompt: 'hang', cwd: f.cwd, label: '  Cart\n totals port ', groupId: group.id });
  assert.equal(task.label, 'Cart totals port', 'echoed on the Task, cleaned');
  assert.equal(task.groupId, group.id);
  assert.equal(task.status, 'starting');
  assert.deepEqual(f.store.getSessionMeta(task.sessionId), { label: 'Cart totals port', groupId: group.id }, 'applied at once');
  assert.deepEqual(launcher.list()[0].label, 'Cart totals port');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'index.json'), 'utf8')).tasks[0].label, 'Cart totals port', 'and remembered with the task');
  launcher.stop(task.id);

  const pinned = await launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, groupId: 'none' });
  assert.equal(pinned.groupId, 'none');
  assert.ok(!('label' in pinned));
  assert.deepEqual(f.store.getSessionMeta(pinned.sessionId), { groupId: 'none' });

  // Nothing to apply: no keys on the Task, no entry in the store.
  const size = f.store.size;
  for (const extra of [{}, { label: '', groupId: null }, { label: '   ', groupId: '' }, { label: null }]) {
    const plain = await launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, ...extra });
    assert.ok(!('label' in plain) && !('groupId' in plain), JSON.stringify(extra));
    assert.deepEqual(f.store.getSessionMeta(plain.sessionId), {});
    await until(() => launcher.get(plain.id).status === 'done');
  }
  assert.equal(f.store.size, size);

  // Bad input is refused before anything is started.
  const count = launcher.list().length;
  await assert.rejects(launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, label: 5 }), (e) => e instanceof LauncherError && e.status === 400 && /label must be a string/.test(e.message));
  await assert.rejects(launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, groupId: 'g-nope' }), (e) => e instanceof LauncherError && e.status === 400 && /no such group: g-nope/.test(e.message));
  await assert.rejects(launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, groupId: {} }), (e) => e.status === 400);
  assert.equal(launcher.list().length, count);

  await until(() => launcher.list().every((t) => t.status !== 'starting' && t.status !== 'running' && typeof t.exitCode !== 'undefined'));
  launcher.close();
  f.store.close();
  f.cleanup();
});

test('codex names its session in its output: the label and group are applied when it does', async () => {
  const f = metaFixture();
  const group = f.store.createGroup({ name: 'Cleanup' });
  const doomed = f.store.createGroup({ name: 'Doomed' });
  const launcher = f.make();

  const task = await launcher.start({ tool: 'codex', prompt: `gate=${f.gate} id=thread-0001`, cwd: f.cwd, label: 'Token log leak', groupId: group.id });
  const other = await launcher.start({ tool: 'codex', prompt: `gate=${f.gate} id=thread-0002`, cwd: f.cwd, label: 'Outlives its group', groupId: doomed.id });
  assert.equal(task.sessionId, undefined, 'nothing is known about the session yet');
  assert.deepEqual([task.label, task.groupId], ['Token log leak', group.id]);
  await sleep(150);
  assert.equal(f.store.size, 0, 'so nothing is applied yet');
  f.store.deleteGroup(doomed.id);

  fs.writeFileSync(f.gate, '');
  const done = await until(() => (launcher.get(task.id).status === 'done' ? launcher.get(task.id) : null));
  assert.equal(done.sessionId, 'codex:thread-0001');
  assert.deepEqual(f.store.getSessionMeta('codex:thread-0001'), { label: 'Token log leak', groupId: group.id });
  await until(() => launcher.get(other.id).status === 'done');
  assert.deepEqual(f.store.getSessionMeta('codex:thread-0002'), { label: 'Outlives its group' }, 'its group was deleted meanwhile: the name is still applied');
  assert.equal(launcher.get(other.id).groupId, doomed.id, 'the Task keeps saying what was asked for');
  launcher.close();
  f.store.close();
  f.cleanup();
});

test('a follow-up message can rename and regroup the session it resumes', async () => {
  const f = metaFixture();
  const a = f.store.createGroup({ name: 'A' });
  const b = f.store.createGroup({ name: 'B' });
  const launcher = f.make();
  const sid = `claude:${UUID}`;
  f.store.setSessionMeta(sid, { label: 'Before', groupId: a.id });

  const plain = await launcher.followUp(sid, { prompt: P }, { cwd: f.cwd });
  assert.ok(!('label' in plain) && !('groupId' in plain));
  assert.deepEqual(f.store.getSessionMeta(sid), { label: 'Before', groupId: a.id }, 'a follow-up that names nothing changes nothing');
  await until(() => launcher.get(plain.id).status === 'done');

  await assert.rejects(launcher.followUp(sid, { prompt: P, groupId: 'g-nope' }), (e) => e instanceof LauncherError && e.status === 400);
  await assert.rejects(launcher.followUp(sid, { prompt: P, label: ['x'] }), (e) => e.status === 400);
  assert.equal(launcher.list().length, 1);

  const renamed = await launcher.followUp(sid, { prompt: P, label: 'After', groupId: b.id });
  assert.deepEqual([renamed.label, renamed.groupId, renamed.resumeOf, renamed.sessionId], ['After', b.id, sid, sid]);
  assert.deepEqual(f.store.getSessionMeta(sid), { label: 'After', groupId: b.id }, 'the session id is known up front, so it is applied at once');
  await until(() => launcher.get(renamed.id).status === 'done');
  assert.deepEqual(f.store.getSessionMeta(sid), { label: 'After', groupId: b.id }, 'the run reporting the same session id again changes nothing');

  const cleared = await launcher.followUp(sid, { prompt: P, label: null, groupId: 'none' });
  assert.ok(!('label' in cleared));
  assert.equal(cleared.groupId, 'none');
  assert.deepEqual(f.store.getSessionMeta(sid), { groupId: 'none' });
  await until(() => launcher.get(cleared.id).status === 'done');

  // A codex follow-up: the id is known up front there too.
  const codex = await launcher.followUp('codex:thread-0009', { prompt: P, label: 'Codex follow-up' }, { cwd: f.cwd });
  assert.deepEqual(f.store.getSessionMeta('codex:thread-0009'), { label: 'Codex follow-up' });
  await until(() => launcher.get(codex.id).status === 'done');
  assert.equal(launcher.get(codex.id).sessionId, 'codex:thread-0009');
  launcher.close();
  f.store.close();
  f.cleanup();
});

test('a run adopted by the next server before it named its session still gets its label and group', async () => {
  const f = metaFixture();
  const group = f.store.createGroup({ name: 'Slow starters' });
  const first = f.make();
  const task = await first.start({ tool: 'codex', prompt: `gate=${f.gate} id=thread-0042`, cwd: f.cwd, label: 'Adopted', groupId: group.id });
  await until(() => JSON.parse(fs.readFileSync(path.join(f.dir, 'index.json'), 'utf8')).tasks[0]?.pidStart);
  first.close();
  assert.equal(f.store.size, 0);

  const second = f.make();
  const adopted = second.get(task.id);
  assert.equal(adopted.status, 'starting');
  assert.deepEqual([adopted.label, adopted.groupId, adopted.sessionId], ['Adopted', group.id, undefined]);
  fs.writeFileSync(f.gate, '');
  // The exit code of an adopted run is not known, but codex reported its own outcome.
  const done = await until(() => (second.get(task.id).status === 'done' ? second.get(task.id) : null));
  assert.equal(done.sessionId, 'codex:thread-0042');
  assert.deepEqual(f.store.getSessionMeta('codex:thread-0042'), { label: 'Adopted', groupId: group.id });
  second.close();
  f.store.close();
  f.cleanup();
});

test('mock mode: label and group go to the generator with the new character; a follow-up goes through the store', async () => {
  const { createMock } = await import('../public/js/mock-state.js');
  const mock = createMock();
  const meta = createMockMeta(mock);
  const added = [];
  const add = mock.add.bind(mock);
  mock.add = (o) => (added.push(o), add(o));
  const launcher = createLauncher({ mock, meta, tools: {} });

  const task = await launcher.start({ tool: 'codex', prompt: 'Tidy the README', cwd: '/Users/dev/projects/shop', label: ' Tidy\tup ', groupId: 'g-cleanup' });
  assert.deepEqual(added, [{ tool: 'codex', prompt: 'Tidy the README', cwd: '/Users/dev/projects/shop', taskId: task.id, label: 'Tidy up', groupId: 'g-cleanup' }]);
  assert.deepEqual([task.label, task.groupId], ['Tidy up', 'g-cleanup']);
  const character = mock.next().sessions.find((s) => s.id === task.sessionId);
  assert.deepEqual([character.label, character.groupId, character.taskId], ['Tidy up', 'g-cleanup', task.id]);

  await assert.rejects(launcher.start({ tool: 'codex', prompt: 'x', cwd: '/x', groupId: 'g-nope' }), (e) => e.status === 400 && /no such group/.test(e.message));
  await assert.rejects(launcher.start({ tool: 'codex', prompt: 'x', cwd: '/x', label: 7 }), (e) => e.status === 400);
  assert.equal(added.length, 1);

  const follow = await launcher.followUp('claude:mock-02', { prompt: 'And then?', label: 'Flaky e2e', groupId: 'none' }, { cwd: '/Users/dev/projects/shop/big-tests' });
  assert.deepEqual([follow.label, follow.groupId], ['Flaky e2e', 'none']);
  const benji = mock.next().sessions.find((s) => s.id === 'claude:mock-02');
  assert.deepEqual([benji.label, benji.groupId], ['Flaky e2e', undefined]);
  assert.equal(added.length, 1);
  launcher.close();
});

test('without a meta store a label and group are still checked for shape and echoed', async () => {
  const f = fixture();
  const launcher = f.make();
  const task = await launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, label: 'x'.repeat(100), groupId: 'g-whatever' });
  assert.equal(task.label.length, 60);
  assert.equal(task.groupId, 'g-whatever');
  await assert.rejects(launcher.start({ tool: 'claude', prompt: P, cwd: f.cwd, groupId: 'not a group id!' }), (e) => e.status === 400);
  await until(() => launcher.get(task.id).status === 'done');
  launcher.close();
  f.cleanup();
});
