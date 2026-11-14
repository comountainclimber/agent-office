// node --test server/adapters/claude.test.mjs
// Synthetic fixtures only: every test points the adapter at a fresh temp dir and never touches ~/.claude.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tool, listSessions, getTranscript, setRoots, getRoots, toolActivity, cleanPrompt } from './claude.mjs';

const CWD = '/Users/tester/projects/demo';
const SLUG = '-Users-tester-projects-demo';
const tmpDirs = [];
let home;
let seq = 0;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-claude-'));
  tmpDirs.push(home);
  fs.mkdirSync(path.join(home, 'projects', SLUG), { recursive: true });
  setRoots({ home });
});
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// --- fixture builders ---------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString();
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function common(sid, ts, extra = {}) {
  return { parentUuid: null, isSidechain: false, uuid: uuid(), timestamp: iso(ts), sessionId: sid, cwd: CWD, gitBranch: 'main', entrypoint: 'cli', version: '2.1.321', ...extra };
}
const userPrompt = (sid, ts, text, extra = {}) => ({ ...common(sid, ts, extra), type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' } });
const toolResult = (sid, ts, id, { isError = false, toolUseResult, extra = {} } = {}) => ({
  ...common(sid, ts, extra),
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok', ...(isError ? { is_error: true } : {}) }] },
  ...(toolUseResult ? { toolUseResult } : {}),
});
const assistant = (sid, ts, block, stop, extra = {}) => ({
  ...common(sid, ts, extra),
  type: 'assistant',
  message: {
    model: 'claude-test-1', id: 'msg_' + seq, type: 'message', role: 'assistant', content: [block], stop_reason: stop,
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 },
  },
});
const text = (t) => ({ type: 'text', text: t });
const thinking = () => ({ type: 'thinking', thinking: '', signature: 'x' });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

function sessionFile(sid) {
  return path.join(home, 'projects', SLUG, `${sid}.jsonl`);
}
function writeSession(sid, records, { trailing = '' } = {}) {
  fs.writeFileSync(sessionFile(sid), records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n' + trailing);
}
function writeAgent(sid, agentId, records, meta, { wfRun } = {}) {
  const dir = wfRun ? path.join(home, 'projects', SLUG, sid, 'subagents', 'workflows', wfRun) : path.join(home, 'projects', SLUG, sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (meta) fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
}
const side = { isSidechain: true };
const byId = (list, id) => list.find((s) => s.nativeId === id);

// --- tests ------------------------------------------------------------------------------
test('exports the contract surface and honours the root override', () => {
  assert.equal(tool, 'claude');
  assert.equal(getRoots().projectsRoot, path.join(home, 'projects'));
  assert.equal(getRoots().sessionsDir, path.join(home, 'sessions'));
  setRoots({ projectsRoot: path.join(home, 'projects') });
  assert.equal(getRoots().sessionsDir, null, 'projectsRoot alone must not read any pid registry');
});

test('solo session mid-turn: pending tool call', async () => {
  const now = Date.now();
  const t = now - 30_000;
  writeSession('solo-mid', [
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(t), sessionId: 'solo-mid', content: 'x' },
    userPrompt('solo-mid', t, '<system-reminder>\nignore me\n</system-reminder>\nFix the flaky\nlogin test please'),
    assistant('solo-mid', t + 1000, thinking(), 'tool_use'),
    assistant('solo-mid', t + 2000, text('I will run the tests first.'), 'tool_use'),
    assistant('solo-mid', t + 3000, toolUse('toolu_1', 'Bash', { command: 'cd /Users/tester/projects/demo && npm test -- --runInBand', description: 'Run tests' }), 'tool_use'),
  ]);
  const [s, ...rest] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(rest.length, 0);
  assert.equal(s.tool, 'claude');
  assert.equal(s.nativeId, 'solo-mid');
  assert.equal(s.turnState, 'mid');
  assert.deepEqual(s.activity, { kind: 'running', label: 'Bash: npm test -- --runInBand' });
  assert.equal(s.title, 'Fix the flaky login test please');
  assert.equal(s.cwd, CWD);
  assert.equal(s.branch, 'main');
  assert.equal(s.model, 'claude-test-1');
  assert.equal(s.source, 'cli');
  assert.equal(s.startedAt, t);
  assert.equal(s.lastActivityAt, t + 3000);
  assert.equal(s.lastMessage, 'I will run the tests first.');
  assert.equal(s.tokens, 1260);
  assert.deepEqual(s.subagents, []);
});

test('mid-turn variants: fresh prompt, tool result, streaming thinking', async () => {
  const now = Date.now();
  const t = now - 60_000;
  writeSession('v-prompt', [userPrompt('v-prompt', t, 'hello there')]);
  writeSession('v-result', [
    userPrompt('v-result', t, 'read it'),
    assistant('v-result', t + 1000, toolUse('toolu_r', 'Read', { file_path: '/Users/tester/projects/demo/src/launcher.mjs' }), 'tool_use'),
    toolResult('v-result', now - 2000, 'toolu_r'),
  ]);
  writeSession('v-result-old', [
    userPrompt('v-result-old', t, 'read it'),
    assistant('v-result-old', t + 1000, toolUse('toolu_r', 'Read', { file_path: '/Users/tester/projects/demo/src/launcher.mjs' }), 'tool_use'),
    toolResult('v-result-old', t + 2000, 'toolu_r'),
  ]);
  writeSession('v-think', [userPrompt('v-think', t, 'ponder'), assistant('v-think', t + 1000, thinking(), null)]);
  const list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(byId(list, 'v-prompt').turnState, 'mid');
  assert.equal(byId(list, 'v-prompt').activity.kind, 'thinking');
  assert.equal(byId(list, 'v-result').turnState, 'mid');
  assert.deepEqual(byId(list, 'v-result').activity, { kind: 'reading', label: 'Read launcher.mjs' });
  assert.equal(byId(list, 'v-result-old').activity.kind, 'thinking', 'a long-returned tool result means the model is thinking');
  assert.equal(byId(list, 'v-think').turnState, 'mid');
  assert.equal(byId(list, 'v-think').activity.kind, 'thinking');
});

test('ended turn: final assistant text, title from the custom-title record', async () => {
  const now = Date.now();
  const t = now - 120_000;
  const long = 'All done. ' + 'word '.repeat(200);
  writeSession('ended', [
    userPrompt('ended', t, 'Refactor the launcher'),
    { type: 'custom-title', customTitle: 'Launcher\nrefactor', sessionId: 'ended' },
    assistant('ended', t + 1000, toolUse('toolu_e', 'Edit', { file_path: '/a/b/launcher.mjs', old_string: 'a', new_string: 'b' }), 'tool_use'),
    toolResult('ended', t + 2000, 'toolu_e'),
    assistant('ended', t + 3000, thinking(), 'end_turn'),
    assistant('ended', t + 4000, text(long), 'end_turn'),
    { ...common('ended', t + 5000), type: 'system', subtype: 'stop_hook_summary', hookCount: 1 },
    { type: 'cost-state', sessionId: 'ended', totalCostUSD: 1 },
    { type: 'brand-new-record-type', whatever: [1, 2, 3] },
  ]);
  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(s.turnState, 'ended');
  assert.equal(s.title, 'Launcher refactor');
  assert.equal(s.activity.kind, 'waiting');
  assert.ok(s.lastMessage.startsWith('All done. word word'));
  assert.ok(s.lastMessage.length <= 2400);
  assert.equal(s.lastActivityAt, t + 5000);
});

test('ended variants: interrupted, API error, pending question, local command', async () => {
  const now = Date.now();
  const t = now - 60_000;
  writeSession('e-int', [
    userPrompt('e-int', t, 'do a thing'),
    assistant('e-int', t + 1000, toolUse('toolu_i', 'Bash', { command: 'sleep 100' }), 'tool_use'),
    toolResult('e-int', t + 2000, 'toolu_i', { isError: true }),
    { ...common('e-int', t + 2001), type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  ]);
  writeSession('e-err', [
    userPrompt('e-err', t, 'do a thing'),
    { ...assistant('e-err', t + 1000, text('API Error: overloaded'), 'stop_sequence'), isApiErrorMessage: true },
  ]);
  writeSession('e-ask', [
    userPrompt('e-ask', t, 'do a thing'),
    assistant('e-ask', t + 1000, toolUse('toolu_q', 'AskUserQuestion', { questions: [] }), 'tool_use'),
  ]);
  writeSession('e-local', [
    userPrompt('e-local', t, '<command-name>/model</command-name>\n<command-args>opus</command-args>'),
    { ...common('e-local', t + 10), type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } },
  ]);
  const list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(byId(list, 'e-int').turnState, 'ended');
  assert.equal(byId(list, 'e-int').activity.label, 'Interrupted');
  assert.equal(byId(list, 'e-err').turnState, 'ended');
  assert.equal(byId(list, 'e-err').lastMessage, undefined, 'API error text is not assistant prose');
  assert.equal(byId(list, 'e-ask').turnState, 'ended');
  assert.equal(byId(list, 'e-ask').activity.kind, 'waiting');
  assert.equal(byId(list, 'e-local').turnState, 'ended');
  assert.equal(byId(list, 'e-local').title, '/model opus');
});

test('orchestrator: one working and one finished background subagent', async () => {
  const now = Date.now();
  const t = now - 90_000;
  const sid = 'orch';
  const launched = (agentId, description) => ({ isAsync: true, status: 'async_launched', agentId, description });
  writeSession(sid, [
    userPrompt(sid, t, 'Build the thing with two helpers'),
    assistant(sid, t + 1000, toolUse('toolu_a', 'Agent', { description: 'Write the parser', subagent_type: 'general-purpose', prompt: 'p' }), 'tool_use'),
    assistant(sid, t + 1100, toolUse('toolu_b', 'Agent', { description: 'Survey the docs', subagent_type: 'Explore', prompt: 'p' }), 'tool_use'),
    toolResult(sid, t + 1200, 'toolu_a', { toolUseResult: launched('aaaa1111', 'Write the parser') }),
    toolResult(sid, t + 1300, 'toolu_b', { toolUseResult: launched('bbbb2222', 'Survey the docs') }),
    assistant(sid, t + 2000, text('Both helpers are running; I will report back.'), 'end_turn'),
    { ...common(sid, t + 2100), type: 'system', subtype: 'stop_hook_summary' },
  ]);
  // Working: its own log ends on a tool call that has no result yet.
  writeAgent(sid, 'aaaa1111', [
    userPrompt(sid, t + 1200, 'You are writing the parser', side),
    assistant(sid, t + 5000, thinking(), null, side),
    assistant(sid, now - 4000, toolUse('toolu_s1', 'Write', { file_path: '/Users/tester/projects/demo/src/parser.ts', content: 'x' }), null, side),
  ], { agentType: 'general-purpose', description: 'Write the parser', toolUseId: 'toolu_a', spawnDepth: 1, requestShape: 'background' });
  // Done: handed its report back.
  writeAgent(sid, 'bbbb2222', [
    userPrompt(sid, t + 1300, 'You are surveying the docs', side),
    assistant(sid, t + 9000, toolUse('toolu_s2', 'Grep', { pattern: 'TODO' }), 'tool_use', side),
    toolResult(sid, t + 9500, 'toolu_s2', { extra: side }),
    assistant(sid, t + 20_000, toolUse('toolu_s3', 'SubagentHandback', { message: 'report' }), null, side),
    toolResult(sid, t + 20_100, 'toolu_s3', { extra: side }),
  ], { agentType: 'Explore', description: 'Survey the docs', toolUseId: 'toolu_b', spawnDepth: 1, requestShape: 'background' });

  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(s.turnState, 'mid', 'own turn ended, but a background subagent still owes output');
  assert.deepEqual(s.activity, { kind: 'delegating', label: 'Waiting on 1 subagent' });
  assert.equal(s.lastActivityAt, now - 4000, 'subagent writes count as session activity');
  assert.equal(s.subagents.length, 2);
  const [a, b] = s.subagents;
  assert.equal(a.id, 'aaaa1111');
  assert.equal(a.status, 'working');
  assert.equal(a.label, 'Write the parser');
  assert.equal(a.agentType, 'general-purpose');
  assert.deepEqual(a.activity, { kind: 'editing', label: 'Write parser.ts' });
  assert.equal(a.startedAt, t + 1200);
  assert.equal(a.lastActivityAt, now - 4000);
  assert.equal(a.endedAt, undefined);
  assert.equal(b.id, 'bbbb2222');
  assert.equal(b.status, 'done');
  assert.equal(b.agentType, 'Explore');
  assert.equal(b.endedAt, t + 20_100);
  assert.equal(b.activity.kind, 'idle');

  // The working one finishes: final assistant text with end_turn.
  fs.appendFileSync(
    path.join(home, 'projects', SLUG, sid, 'subagents', 'agent-aaaa1111.jsonl'),
    JSON.stringify(toolResult(sid, now - 3000, 'toolu_s1', { extra: side })) + '\n' + JSON.stringify(assistant(sid, now - 2000, text('Parser written.'), 'end_turn', side)) + '\n',
  );
  const [s2] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.deepEqual(s2.subagents.map((x) => x.status), ['done', 'done']);
  assert.equal(s2.turnState, 'ended');
  assert.equal(s2.activity.kind, 'waiting');
});

test('subagent status signals: meta.finished, parent notification, stale log, API error', async () => {
  const now = Date.now();
  const t = now - 100_000;
  const sid = 'signals';
  const pending = (ts) => [userPrompt(sid, ts, 'go', side), assistant(sid, ts + 1000, toolUse('toolu_x' + ts, 'Bash', { command: 'make' }), 'tool_use', side)];
  writeSession(sid, [
    userPrompt(sid, t, 'fan out'),
    assistant(sid, t + 500, text('Launching.'), 'end_turn'),
    { ...common(sid, t + 60_000), type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>note1</task-id>\n<status>stopped</status>\n<summary>Agent stopped</summary>\n</task-notification>' } },
    assistant(sid, t + 61_000, text('One helper was stopped.'), 'end_turn'),
  ]);
  writeAgent(sid, 'fin1', pending(t + 1000), { agentType: 'general-purpose', description: 'finished flag', finished: true });
  writeAgent(sid, 'note1', pending(t + 2000), { agentType: 'general-purpose', description: 'stopped by parent' });
  writeAgent(sid, 'stale1', pending(now - 3 * 3_600_000), { agentType: 'general-purpose', description: 'log is hours old' });
  writeAgent(sid, 'err1', [
    userPrompt(sid, t + 3000, 'go', side),
    { ...assistant(sid, t + 4000, text('API Error'), 'stop_sequence', side), isApiErrorMessage: true },
  ], { agentType: 'general-purpose', description: 'api error' });
  writeAgent(sid, 'live1', pending(t + 5000), { agentType: 'general-purpose', description: 'still going' });

  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  const st = Object.fromEntries(s.subagents.map((x) => [x.id, x.status]));
  assert.deepEqual(st, { fin1: 'done', note1: 'failed', err1: 'failed', live1: 'working' }, 'stale1 predates the turn and is dropped');
  assert.equal(s.turnState, 'mid');
});

test('subagents without their own transcript fall back to tool_use/tool_result pairing', async () => {
  const now = Date.now();
  const t = now - 60_000;
  const sid = 'pairing';
  writeSession(sid, [
    userPrompt(sid, t, 'old style delegation'),
    assistant(sid, t + 1000, toolUse('toolu_p1', 'Task', { description: 'Sync helper, finished', subagent_type: 'Explore', prompt: 'p' }), 'tool_use'),
    assistant(sid, t + 1100, toolUse('toolu_p2', 'Task', { description: 'Sync helper, errored', prompt: 'p' }), 'tool_use'),
    assistant(sid, t + 1200, toolUse('toolu_p3', 'Agent', { description: 'Still running', prompt: 'p' }), 'tool_use'),
    // old inline sidechain records must not affect the parent's own turn state
    { ...assistant(sid, t + 1500, text('sidechain chatter'), 'end_turn'), isSidechain: true },
    toolResult(sid, t + 5000, 'toolu_p1', { toolUseResult: { status: 'completed', agentId: 'zzz' } }),
    toolResult(sid, t + 6000, 'toolu_p2', { isError: true }),
  ]);
  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(s.turnState, 'mid');
  assert.deepEqual(s.subagents.map((x) => [x.id, x.status, x.label]), [
    ['toolu_p1', 'done', 'Sync helper, finished'],
    ['toolu_p2', 'failed', 'Sync helper, errored'],
    ['toolu_p3', 'working', 'Still running'],
  ]);
  assert.equal(s.subagents[0].agentType, 'Explore');
  assert.equal(s.subagents[0].endedAt, t + 5000);
  assert.equal(s.lastMessage, undefined);
});

test('Workflow-tool agents live under subagents/workflows/<runId>/', async () => {
  const now = Date.now();
  const t = now - 60_000;
  const sid = 'wf';
  writeSession(sid, [
    userPrompt(sid, t, 'run the review workflow'),
    assistant(sid, t + 1000, toolUse('toolu_w', 'Workflow', { script: 'export default ...' }), 'tool_use'),
    toolResult(sid, t + 1100, 'toolu_w', { toolUseResult: { status: 'async_launched', runId: 'wf_1234', taskType: 'local_workflow' } }),
    assistant(sid, t + 2000, text('Workflow launched.'), 'end_turn'),
  ]);
  writeAgent(sid, 'w1', [
    userPrompt(sid, t + 1200, '[Workflow harness] map step', side),
    assistant(sid, t + 9000, toolUse('toolu_so', 'StructuredOutput', { result: {} }), 'tool_use', side),
    toolResult(sid, t + 9100, 'toolu_so', { extra: side }),
  ], { agentType: 'workflow-subagent', description: 'map:credits', workflowPhase: 'Map' }, { wfRun: 'wf_1234' });
  writeAgent(sid, 'w2', [
    userPrompt(sid, t + 1300, '[Workflow harness] verify step', side),
    assistant(sid, now - 3000, toolUse('toolu_wg', 'WebFetch', { url: 'https://docs.example.com/a/b', prompt: 'x' }), 'tool_use', side),
  ], { agentType: 'workflow-subagent', description: 'verify:credits', workflowPhase: 'Verify' }, { wfRun: 'wf_1234' });

  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(s.turnState, 'mid');
  assert.deepEqual(s.subagents.map((x) => [x.id, x.label, x.agentType, x.status]), [
    ['w1', 'map:credits', 'workflow-subagent', 'done'],
    ['w2', 'verify:credits', 'workflow-subagent', 'working'],
  ]);
  assert.deepEqual(s.subagents[1].activity, { kind: 'browsing', label: 'Fetch docs.example.com' });
  const msgs = await getTranscript(`${sid}#w2`, { limit: 10 });
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'tool']);
});

test('malformed trailing line, junk lines and unknown records are tolerated', async () => {
  const now = Date.now();
  const t = now - 20_000;
  const full = JSON.stringify(assistant('broken', t + 9000, text('this record was cut off mid-write'), 'end_turn'));
  writeSession('broken', [
    userPrompt('broken', t, 'Do the work'),
    'not json at all',
    '{"type":"user","message":',
    '[1,2,3]',
    'null',
    { type: 'mystery', timestamp: 'not-a-date' },
    assistant('broken', t + 1000, toolUse('toolu_g', 'Grep', { pattern: 'needle', path: '/x/y' }), 'tool_use'),
  ], { trailing: full.slice(0, Math.floor(full.length / 2)) });
  fs.writeFileSync(sessionFile('empty'), '');
  fs.writeFileSync(sessionFile('garbage'), '\u0000\u0001 binary junk \n{{{{\n');
  fs.mkdirSync(path.join(home, 'projects', SLUG, 'not-a-session.jsonl-dir'));
  fs.writeFileSync(path.join(home, 'projects', 'stray-file.txt'), 'x');

  const list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.deepEqual(list.map((s) => s.nativeId), ['broken'], 'empty and garbage files are skipped, not thrown on');
  assert.equal(list[0].turnState, 'mid', 'the truncated final record is ignored');
  assert.deepEqual(list[0].activity, { kind: 'searching', label: 'Grep needle' });
  assert.equal(list[0].lastActivityAt, t + 1000);
});

test('never throws when the roots are missing', async () => {
  setRoots({ home: path.join(home, 'does-not-exist') });
  assert.deepEqual(await listSessions({ now: Date.now(), maxAgeMs: 1000 }), []);
  assert.deepEqual(await listSessions(), []);
  assert.deepEqual(await getTranscript('nope', { limit: 5 }), []);
  assert.deepEqual(await getTranscript('../../etc/passwd', {}), []);
});

test('maxAge filter uses record timestamps, and the cache follows appends', async () => {
  const now = Date.now();
  const old = now - 3 * 3_600_000;
  // File mtime is "now" (just written) but the conversation is three hours old.
  writeSession('old', [userPrompt('old', old, 'ancient'), assistant('old', old + 1000, text('done long ago'), 'end_turn')]);
  writeSession('fresh', [userPrompt('fresh', now - 5000, 'recent')]);
  let list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.deepEqual(list.map((s) => s.nativeId), ['fresh']);
  list = await listSessions({ now, maxAgeMs: 4 * 3_600_000 });
  assert.deepEqual(list.map((s) => s.nativeId), ['fresh', 'old'], 'most recent first');

  assert.equal(byId(list, 'fresh').turnState, 'mid');
  fs.appendFileSync(sessionFile('fresh'), JSON.stringify(assistant('fresh', now - 1000, text('Here you go.'), 'end_turn')) + '\n');
  list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(byId(list, 'fresh').turnState, 'ended');
  assert.equal(byId(list, 'fresh').lastMessage, 'Here you go.');
  assert.equal(byId(list, 'fresh').lastActivityAt, now - 1000);
});

test('large files: only a bounded head and tail are read', async () => {
  const now = Date.now();
  const t = now - 40_000;
  const sid = 'big';
  const blob = (n) => JSON.stringify({ type: 'api-request-blob', sessionId: sid, hash: 'h', message: { role: 'user', content: 'x'.repeat(n) } });
  const lines = [JSON.stringify(userPrompt(sid, t, 'The very first prompt'))];
  // ~3 MB of early conversation that must never be parsed.
  for (let k = 0; k < 30; k++) lines.push(JSON.stringify(assistant(sid, t + 10 + k, text('early ' + 'y'.repeat(100_000)), 'tool_use')));
  lines.push(JSON.stringify({ type: 'custom-title', customTitle: 'Big session', sessionId: sid }));
  lines.push(JSON.stringify(userPrompt(sid, t + 1000, 'Second prompt')));
  lines.push(JSON.stringify(assistant(sid, t + 2000, toolUse('toolu_big', 'Edit', { file_path: '/deep/path/to/app.js', old_string: 'a', new_string: 'b' }), 'tool_use')));
  // The tail window lands inside one giant bookkeeping line: the reader has to widen (bounded) to find real records.
  lines.push(blob(900_000));
  fs.writeFileSync(sessionFile(sid), lines.join('\n') + '\n');
  assert.ok(fs.statSync(sessionFile(sid)).size > 3_500_000);

  const t0 = performance.now();
  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  const coldMs = performance.now() - t0;
  assert.equal(s.title, 'Big session');
  assert.equal(s.turnState, 'mid');
  assert.deepEqual(s.activity, { kind: 'editing', label: 'Edit app.js' });
  assert.equal(s.startedAt, t, 'start time comes from the head read');
  assert.equal(s.lastActivityAt, t + 2000);

  const t1 = performance.now();
  for (let k = 0; k < 20; k++) await listSessions({ now, maxAgeMs: 3_600_000 });
  const warmMs = (performance.now() - t1) / 20;
  assert.ok(warmMs < 10, `warm call should be cheap, was ${warmMs.toFixed(2)}ms (cold ${coldMs.toFixed(1)}ms)`);

  const msgs = await getTranscript(sid, { limit: 3 });
  assert.equal(msgs.length, 3);
  assert.equal(msgs.at(-1).role, 'tool');
  assert.equal(msgs.at(-1).text, 'Edit: app.js');
});

test('getTranscript: normalised, oldest first, limited', async () => {
  const now = Date.now();
  const t = now - 60_000;
  const sid = 'talk';
  writeSession(sid, [
    userPrompt(sid, t, '<system-reminder>hidden</system-reminder>First question'),
    { ...common(sid, t + 5), type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>meta noise</system-reminder>' } },
    assistant(sid, t + 1000, thinking(), 'tool_use'),
    assistant(sid, t + 2000, text('Let me look.'), 'tool_use'),
    assistant(sid, t + 3000, toolUse('toolu_t1', 'Bash', { command: 'ls -la\n  /tmp', description: 'List' }), 'tool_use'),
    toolResult(sid, t + 4000, 'toolu_t1'),
    assistant(sid, t + 5000, text('Answer one. ' + 'z'.repeat(3000)), 'end_turn'),
    userPrompt(sid, t + 6000, 'Second question'),
    assistant(sid, t + 7000, text('Answer two.'), 'end_turn'),
  ]);
  const all = await getTranscript(sid, { limit: 60 });
  assert.deepEqual(all.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
  assert.equal(all[0].text, 'First question');
  assert.equal(all[0].ts, t);
  assert.equal(all[2].toolName, 'Bash');
  assert.equal(all[2].text, 'Bash: ls -la /tmp');
  assert.ok(all[3].text.length <= 2000);
  assert.ok(all.every((m, k) => k === 0 || m.ts >= all[k - 1].ts));
  const last2 = await getTranscript(sid, { limit: 2 });
  assert.deepEqual(last2.map((m) => m.text), ['Second question', 'Answer two.']);
  assert.deepEqual(await getTranscript('missing-session', { limit: 5 }), []);
});

test('pid registry: a session blocked on a permission prompt is waiting on the human', async () => {
  const now = Date.now();
  const t = now - 10_000;
  const sid = 'blocked';
  writeSession(sid, [
    userPrompt(sid, t, 'deploy it', { entrypoint: 'claude-desktop' }),
    assistant(sid, t + 1000, toolUse('toolu_d', 'Bash', { command: 'make deploy' }), 'tool_use', { entrypoint: 'claude-desktop' }),
  ]);
  let list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(list[0].turnState, 'mid');
  assert.equal(list[0].source, 'desktop');

  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const pidFile = path.join(home, 'sessions', `${process.pid}.json`);
  const reg = { pid: process.pid, sessionId: sid, cwd: CWD, entrypoint: 'claude-desktop', kind: 'interactive', name: 'Deploy', status: 'waiting', waitingFor: 'permission prompt', updatedAt: t + 1500, statusUpdatedAt: t + 1500 };
  fs.writeFileSync(pidFile, JSON.stringify(reg));
  list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(list[0].turnState, 'ended');
  assert.deepEqual(list[0].activity, { kind: 'waiting', label: 'Needs you: permission prompt' });

  // Approved: the registry flips back to busy and the transcript rules apply again.
  fs.writeFileSync(pidFile, JSON.stringify({ ...reg, status: 'busy', waitingFor: undefined, statusUpdatedAt: t + 2500, updatedAt: t + 2500 }));
  list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(list[0].turnState, 'mid');
  assert.equal(list[0].activity.label, 'Bash: make deploy');

  // An idle registry entry newer than the last record means the turn is over even without an end marker.
  fs.writeFileSync(pidFile, JSON.stringify({ ...reg, status: 'idle', waitingFor: undefined, statusUpdatedAt: t + 3000, updatedAt: t + 3000 }));
  list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(list[0].turnState, 'ended');

  // Final reply written, yet the process stays busy: delegated background work is still out.
  fs.appendFileSync(sessionFile(sid), JSON.stringify(toolResult(sid, t + 4000, 'toolu_d')) + '\n' + JSON.stringify(assistant(sid, t + 5000, text('Kicked it off.'), 'end_turn')) + '\n');
  list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(list[0].turnState, 'ended', 'idle entry is older than the reply: transcript wins');
  fs.writeFileSync(pidFile, JSON.stringify({ ...reg, status: 'busy', waitingFor: undefined, statusUpdatedAt: t + 3500, updatedAt: t + 3500 }));
  list = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(list[0].turnState, 'mid');
  assert.deepEqual(list[0].activity, { kind: 'delegating', label: 'Waiting on background work' });
});

test('sessions started by a scheduled task still get a title', async () => {
  const now = Date.now();
  const t = now - 5000;
  writeSession('sched', [
    { ...common('sched', t), type: 'user', origin: { kind: 'task-notification', subkind: 'scheduled-trigger' }, message: { role: 'user', content: '<scheduled-task name="nightly-audit" file="/x/SKILL.md">\nThis is an automated run.' } },
    assistant('sched', t + 1000, thinking(), null),
  ]);
  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(s.title, 'Scheduled task: nightly-audit');
  assert.equal(s.turnState, 'mid');
});

test('pid registry: a dead process cannot be mid-turn or have working subagents', async () => {
  const now = Date.now();
  const t = now - 30_000;
  const sid = 'crashed';
  writeSession(sid, [
    userPrompt(sid, t, 'long job'),
    assistant(sid, t + 1000, toolUse('toolu_c', 'Agent', { description: 'Helper', subagent_type: 'general-purpose', prompt: 'p' }), 'tool_use'),
    toolResult(sid, t + 1100, 'toolu_c', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'dead1' } }),
  ]);
  writeAgent(sid, 'dead1', [userPrompt(sid, t + 1100, 'help', side), assistant(sid, t + 2000, toolUse('toolu_h', 'Bash', { command: 'sleep 999' }), 'tool_use', side)],
    { agentType: 'general-purpose', description: 'Helper', toolUseId: 'toolu_c' });
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', `${deadPid}.json`), JSON.stringify({ pid: deadPid, sessionId: sid, cwd: CWD, status: 'busy', updatedAt: t, statusUpdatedAt: t }));
  fs.writeFileSync(path.join(home, 'sessions', 'half-written.json'), '{"pid": 12');

  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(s.turnState, 'unknown');
  assert.deepEqual(s.subagents.map((x) => x.status), ['failed']);
  assert.equal(s.subagents[0].endedAt, t + 2000);
});

test('cwd prefers the directory the session is filed under (needed to resume it)', async () => {
  const now = Date.now();
  const t = now - 5000;
  writeSession('moved', [
    userPrompt('moved', t, 'hi', { cwd: '/Users/tester/.claude/spares/spare-1' }),
    { type: 'relocated', relocatedCwd: CWD, sessionId: 'moved' },
    assistant('moved', t + 1000, text('hello'), 'end_turn', { cwd: CWD + '/packages/deep' }),
  ]);
  const [s] = await listSessions({ now, maxAgeMs: 3_600_000 });
  assert.equal(s.cwd, CWD);
});

test('toolActivity and cleanPrompt', () => {
  assert.deepEqual(toolActivity('Read', { file_path: '/a/b/c/foo.ts' }), { kind: 'reading', label: 'Read foo.ts' });
  assert.deepEqual(toolActivity('Glob', { pattern: 'src/**/*.ts' }), { kind: 'reading', label: 'Glob src/**/*.ts' });
  assert.deepEqual(toolActivity('Edit', { file_path: '/a/b/foo.ts' }), { kind: 'editing', label: 'Edit foo.ts' });
  assert.deepEqual(toolActivity('NotebookEdit', { notebook_path: '/a/nb.ipynb' }), { kind: 'editing', label: 'Edit nb.ipynb' });
  assert.equal(toolActivity('Bash', { command: 'x'.repeat(200) }).label, 'Bash: ' + 'x'.repeat(40));
  assert.equal(toolActivity('Bash', { command: '( cd /abs/dir && git status )' }).label, 'Bash: git status )');
  assert.equal(toolActivity('WebSearch', { query: 'node sqlite' }).kind, 'searching');
  assert.equal(toolActivity('ToolSearch', { query: 'select:Foo' }).kind, 'searching');
  assert.deepEqual(toolActivity('WebFetch', { url: 'https://example.com/x?y=1' }), { kind: 'browsing', label: 'Fetch example.com' });
  assert.equal(toolActivity('mcp__Claude_Browser__navigate', { url: 'http://localhost:4477' }).kind, 'browsing');
  assert.deepEqual(toolActivity('Agent', { description: 'Audit the cart', subagent_type: 'Explore' }), { kind: 'delegating', label: 'Agent: Audit the cart' });
  assert.equal(toolActivity('Workflow', { script: 's' }).kind, 'delegating');
  assert.equal(toolActivity('SomethingNew', undefined).kind, 'running');
  assert.ok(toolActivity('Grep', { pattern: 'p'.repeat(500) }).label.length <= 60);
  assert.equal(toolActivity(undefined, null).label, 'Tool');

  assert.equal(cleanPrompt('<system-reminder>a\nb</system-reminder>\n  Real prompt  '), 'Real prompt');
  assert.equal(cleanPrompt('<command-name>/review</command-name><command-message>review</command-message><command-args>123</command-args>'), '/review 123');
  assert.equal(cleanPrompt('<task-notification><task-id>a1</task-id><status>completed</status><summary>Agent "x" finished</summary></task-notification>'), '[Background task completed] Agent "x" finished');
});
