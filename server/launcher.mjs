// Starts and stops agent runs (Claude Code, Codex, Cursor) for the office UI.
//
// Every run is a detached process whose stdout/stderr go to a per-task log file under
// ~/.agent-office/tasks/. The launcher tails that file, so a run outlives the server and a
// restarted server can pick a still-running task back up from index.json.
//
// Flags were checked against: claude 2.1.321, codex-cli 0.157.0, cursor-agent 2025.09.18 (the one
// on PATH here) and 2026.11.11 (the newer build, for the --mode/--sandbox/--trust capabilities).

import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, oneLine } from './contract.mjs';
import { MetaError, normalizeSessionPatch } from './meta.mjs';

export const PERMISSIONS = /** @type {const} */ (['read', 'edit', 'full']);
export const DEFAULT_PERMISSION = 'edit';
export const MAX_RUNNING = 6;
export const MAX_PROMPT_CHARS = 20_000;
export const TAIL_CHARS = 4000;
export const KILL_GRACE_MS = 5000;
export const BIN = Object.freeze({ claude: 'claude', codex: 'codex', cursor: 'cursor-agent' });
export const DEFAULT_TASK_DIR = path.join(os.homedir(), '.agent-office', 'tasks');

const SIGN_IN_RE = /press any key to sign in|not (logged|signed) in|failed to authenticate|oauth session expired|please run \/login|authentication_failed/i;
const LOGIN_HINT = Object.freeze({ claude: 'claude auth login', codex: 'codex login', cursor: 'cursor-agent login' });

/** Prepended to the prompt only where a tool cannot enforce read-only itself (see cursorNotes). */
export const READ_ONLY_PREAMBLE =
  '[Read-only task: do not create, modify or delete any files and do not run commands that change anything. Answer in text only.]\n\n';

const CURSOR_NOTES_MODERN = Object.freeze({
  read: 'Plan mode (--mode plan): read-only, proposes instead of editing.',
  edit: 'Runs without --force, with the sandbox enabled when the CLI supports it: file edits are allowed, shell commands that are not on your Cursor allowlist are refused rather than waited on.',
  full: '--force (yolo): runs every command unless your Cursor config explicitly denies it.',
});

const CURSOR_NOTES_LEGACY = Object.freeze({
  read: 'This cursor-agent version has no read-only mode. The run goes without --force and with a "do not modify anything" instruction in front of your prompt. That is a request, not a guarantee. Update cursor-agent to get an enforced plan mode.',
  edit: 'This cursor-agent version has no "edits only" setting. Runs without --force, the safer side: shell commands that are not on your Cursor allowlist are refused, and file edits may be proposed rather than applied. Use Full if the task has to run commands.',
  full: '--force: runs every command unless your Cursor config explicitly denies it.',
});

/**
 * What each permission level really means per tool. Shown by the UI next to the picker.
 * `cursor` describes current cursor-agent builds; `cursorLegacy` applies when the installed build
 * predates --mode (the launcher detects this and /api/meta reports the set that is in effect).
 */
export const PERMISSION_NOTES = Object.freeze({
  claude: Object.freeze({
    read: 'Plan mode (--permission-mode plan): reads and searches, proposes a plan, changes nothing.',
    edit: 'Accept-edits mode (--permission-mode acceptEdits): edits files in the folder without asking. Anything else that would need a prompt (most shell commands, unless your Claude settings allow them) is denied, since nobody is there to answer.',
    full: 'All permission checks skipped (--dangerously-skip-permissions).',
  }),
  codex: Object.freeze({
    read: 'Read-only sandbox, never asks for approval: commands can read but not write or use the network.',
    edit: 'Workspace-write sandbox, never asks for approval: may edit files and run commands inside the folder; writes elsewhere and network access fail instead of prompting. Broader than "no shell", but confined by the sandbox.',
    full: 'No sandbox and no approvals (--dangerously-bypass-approvals-and-sandbox).',
  }),
  cursor: CURSOR_NOTES_MODERN,
  cursorLegacy: CURSOR_NOTES_LEGACY,
});

/** @typedef {{mode?: boolean, sandbox?: boolean, trust?: boolean}} CursorCaps */

/** @param {CursorCaps} [caps] */
export function cursorNotes(caps) {
  return caps?.mode ? CURSOR_NOTES_MODERN : CURSOR_NOTES_LEGACY;
}

/** Read the optional flags a cursor-agent build supports out of its --help text. */
export function parseCursorCaps(helpText) {
  const t = String(helpText || '');
  return { mode: /--mode\b/.test(t), sandbox: /--sandbox\b/.test(t), trust: /--trust\b/.test(t) };
}

export class LauncherError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.name = 'LauncherError';
    this.status = status;
  }
}

// --- validation -------------------------------------------------------------

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-\/@\[\]=,]{0,119}$/;
const NATIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,199}$/;

export function validatePrompt(prompt) {
  if (typeof prompt !== 'string') throw new LauncherError('prompt must be a string');
  if (prompt.includes('\0')) throw new LauncherError('prompt must not contain NUL characters');
  const n = prompt.trim().length;
  if (n < 1) throw new LauncherError('prompt must not be empty');
  if (prompt.length > MAX_PROMPT_CHARS) throw new LauncherError(`prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
  return prompt;
}

export function validateTool(tool) {
  if (!TOOLS.includes(tool)) throw new LauncherError(`tool must be one of: ${TOOLS.join(', ')}`);
  return tool;
}

export function validatePermission(permission, fallback = DEFAULT_PERMISSION) {
  if (permission === undefined || permission === null || permission === '') return fallback;
  if (!PERMISSIONS.includes(permission)) throw new LauncherError(`permission must be one of: ${PERMISSIONS.join(', ')}`);
  return permission;
}

export function validateModel(model) {
  if (model === undefined || model === null || model === '') return undefined;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new LauncherError('model is not a valid model name');
  return model;
}

/** @param {{mustExist?: boolean}} [opts] */
export function validateCwd(cwd, { mustExist = true } = {}) {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new LauncherError('cwd must be an absolute directory path');
  if (!path.isAbsolute(cwd)) throw new LauncherError('cwd must be an absolute directory path');
  const resolved = path.resolve(cwd);
  if (mustExist) {
    let st;
    try {
      st = fs.statSync(resolved);
    } catch {
      throw new LauncherError(`cwd does not exist: ${resolved}`);
    }
    if (!st.isDirectory()) throw new LauncherError(`cwd is not a directory: ${resolved}`);
  }
  return resolved;
}

// --- command lines ----------------------------------------------------------

/**
 * Pure: the argv (without the binary) for one run.
 *
 * @param {object} o
 * @param {'claude'|'codex'|'cursor'} o.tool
 * @param {string} o.prompt
 * @param {'read'|'edit'|'full'} [o.permission]
 * @param {string} [o.model]
 * @param {string} [o.sessionUuid]  claude only: pre-assigned session id for a new run
 * @param {string} [o.resume]       native session id to continue instead of starting a new session
 * @param {CursorCaps} [o.cursorCaps]
 * @returns {string[]}
 */
export function buildArgs({ tool, prompt, permission = DEFAULT_PERMISSION, model, sessionUuid, resume, cursorCaps }) {
  validateTool(tool);
  permission = validatePermission(permission);
  validatePrompt(prompt);
  model = validateModel(model);
  if (resume !== undefined && !NATIVE_ID_RE.test(String(resume))) throw new LauncherError('invalid session id');

  // The prompt always goes last, after `--`, so a prompt that starts with a dash is never read as a flag.
  if (tool === 'claude') {
    const perm = {
      read: ['--permission-mode', 'plan'],
      edit: ['--permission-mode', 'acceptEdits'],
      full: ['--dangerously-skip-permissions'],
    }[permission];
    const session = resume ? ['--resume', resume] : sessionUuid ? ['--session-id', sessionUuid] : [];
    return ['-p', '--output-format', 'stream-json', '--verbose', ...session, ...perm, ...(model ? ['--model', model] : []), '--', prompt];
  }

  if (tool === 'codex') {
    const never = ['-c', 'approval_policy="never"'];
    if (resume) {
      // `codex exec resume` has no -s/--sandbox flag; the config override is the documented equivalent.
      const perm = {
        read: ['-c', 'sandbox_mode="read-only"', ...never],
        edit: ['-c', 'sandbox_mode="workspace-write"', ...never],
        full: ['--dangerously-bypass-approvals-and-sandbox'],
      }[permission];
      return ['exec', 'resume', '--json', '--skip-git-repo-check', ...perm, ...(model ? ['-m', model] : []), '--', resume, prompt];
    }
    const perm = {
      read: ['-s', 'read-only', ...never],
      edit: ['-s', 'workspace-write', ...never],
      full: ['--dangerously-bypass-approvals-and-sandbox'],
    }[permission];
    return ['exec', '--json', '--skip-git-repo-check', ...perm, ...(model ? ['-m', model] : []), '--', prompt];
  }

  // cursor
  const caps = cursorCaps || {};
  let perm;
  let text = prompt;
  if (permission === 'full') perm = ['--force'];
  else if (permission === 'read') {
    if (caps.mode) perm = ['--mode', 'plan'];
    else {
      perm = [];
      text = READ_ONLY_PREAMBLE + prompt;
    }
  } else perm = caps.sandbox ? ['--sandbox', 'enabled'] : [];
  return [
    '-p',
    '--output-format',
    'stream-json',
    ...(caps.trust ? ['--trust'] : []),
    ...(resume ? ['--resume', resume] : []),
    ...perm,
    ...(model ? ['--model', model] : []),
    '--',
    text,
  ];
}

// --- environment ------------------------------------------------------------

// Variables an agent CLI (or the app hosting it) sets for its own children. Inherited by a new run
// they make it believe it is nested inside that session: wrong entrypoint, a host that is not
// there, minimal mode, another session's id. Auth, provider and user configuration are left alone
// (ANTHROPIC_*, OPENAI_*, CURSOR_API_KEY, CODEX_HOME, CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_*, ...).
const SCRUB_EXACT = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_CODE_DISABLE_CRON',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_STARTUP_FAILURE_RESULTS',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CURSOR_AGENT',
  'CURSOR_TRACE_ID',
  'CURSOR_CLI',
]);
const SCRUB_PREFIX = [
  'CLAUDE_AGENT_SDK_',
  'CLAUDE_CODE_HOST_',
  'CLAUDE_CODE_MESSAGING_',
  'CLAUDE_CODE_DESKTOP_',
  'CLAUDE_CODE_EMIT_',
  'CLAUDE_CODE_REMOTE',
];

export function isNestingVar(name) {
  return SCRUB_EXACT.has(name) || SCRUB_PREFIX.some((p) => name.startsWith(p));
}

/**
 * Environment for a child run or a `--version` probe: the parent's, minus the nesting markers,
 * with PATH extended (never reordered) by the directories the CLIs and node live in.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string[]} [extraDirs]
 */
export function childEnv(env = process.env, extraDirs = []) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isNestingVar(k)) continue;
    out[k] = v;
  }
  const have = String(out.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(have);
  for (const dir of extraDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    have.push(dir);
  }
  out.PATH = have.join(path.delimiter);
  return out;
}

export function defaultExtraDirs(tools = {}) {
  const dirs = [];
  for (const t of Object.values(tools)) if (t?.path) dirs.push(path.dirname(t.path));
  dirs.push(path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  return [...new Set(dirs)];
}

// --- output parsing ---------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

function baseName(p) {
  const s = String(p || '');
  return s.split('/').filter(Boolean).pop() || s;
}

function firstString(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const v of Object.values(obj)) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

/** "→ ToolName summary" for a tool call, from the tool's name and input object. */
export function describeTool(name, input) {
  const n = String(name || 'Tool');
  const i = input && typeof input === 'object' ? input : {};
  const key = n.toLowerCase();
  let detail = '';
  if (i.command) detail = Array.isArray(i.command) ? i.command.join(' ') : String(i.command);
  else if (i.file_path || i.path || i.notebook_path) detail = baseName(i.file_path || i.path || i.notebook_path);
  else if (i.pattern) detail = `"${i.pattern}"`;
  else if (i.query) detail = `"${i.query}"`;
  else if (i.url) detail = String(i.url);
  else if (i.description) detail = String(i.description);
  else if (i.prompt) detail = String(i.prompt);
  else if (i.skill) detail = String(i.skill);
  else if (key === 'todowrite' || key === 'update_plan') detail = 'update plan';
  else detail = firstString(i);
  return oneLine(`→ ${n}${detail ? ` ${detail}` : ''}`, 120);
}

function errorText(e, depth = 0) {
  if (!e) return '';
  if (typeof e === 'string') {
    // Some CLIs pass an API error along as a JSON string; the message inside is the readable part.
    const t = e.trim();
    if (depth < 3 && t.startsWith('{')) {
      try {
        const inner = errorText(JSON.parse(t), depth + 1);
        if (inner) return inner;
      } catch {
        /* not JSON after all */
      }
    }
    return e;
  }
  if (typeof e !== 'object') return String(e);
  const picked = e.message ?? e.error ?? e.result ?? firstString(e);
  return typeof picked === 'string' ? errorText(picked, depth + 1) : errorText(picked, depth + 1) || '';
}

/**
 * Turns one tool's machine-readable stream into readable lines.
 * `feed(line)` returns `{ out, sessionId?, result? }` where `out` is a list of `{text, inline?}`
 * chunks (inline = continue the current line, used for streamed deltas) and `result` is
 * `{ok, error?}` once the run has reported its outcome.
 *
 * @param {'claude'|'codex'|'cursor'} tool
 */
export function createParser(tool) {
  let lastText = '';
  let streaming = false; // cursor: inside a run of assistant deltas
  let streamed = '';
  let allText = ''; // cursor: everything the assistant has said in this run
  let lastError = ''; // codex: the same failure arrives as an error event and again as turn.failed

  const say = (out, text) => {
    const t = String(text || '').trim();
    if (!t) return;
    lastText = t;
    out.push({ text: t });
  };

  function claude(e, out, r) {
    if (e.session_id && typeof e.session_id === 'string') r.sessionId = e.session_id;
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      const nested = Boolean(e.parent_tool_use_id);
      for (const b of e.message.content) {
        if (b?.type === 'text' && !nested) say(out, b.text);
        else if (b?.type === 'tool_use') out.push({ text: (nested ? '  ' : '') + describeTool(b.name, b.input) });
      }
    } else if (e.type === 'result') {
      const ok = e.subtype === 'success' && !e.is_error;
      if (ok) {
        const text = typeof e.result === 'string' ? e.result.trim() : '';
        if (text && text !== lastText) say(out, text);
        out.push({ text: '✓ Done' });
        r.result = { ok: true };
      } else {
        const msg = errorText(typeof e.result === 'string' && e.result ? e.result : Array.isArray(e.errors) ? e.errors.join('; ') : e.subtype) || 'failed';
        out.push({ text: `✗ ${oneLine(msg, 400)}` });
        r.result = { ok: false, error: msg };
      }
    }
  }

  function codex(e, out, r) {
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') r.sessionId = e.thread_id;
    else if (e.type === 'session.created' && typeof e.session_id === 'string') r.sessionId = e.session_id;
    else if ((e.type === 'item.started' || e.type === 'item.completed') && e.item) {
      const it = e.item;
      const kind = it.type || it.item_type;
      const done = e.type === 'item.completed';
      if (kind === 'agent_message' || kind === 'assistant_message') {
        if (done) say(out, it.text);
      } else if (kind === 'command_execution') {
        if (!done) out.push({ text: describeTool('Shell', { command: it.command }) });
        else if (typeof it.exit_code === 'number' && it.exit_code !== 0) out.push({ text: `  exit ${it.exit_code}` });
      } else if (kind === 'file_change') {
        if (done) {
          const files = (Array.isArray(it.changes) ? it.changes : []).map((c) => baseName(c.path)).filter(Boolean);
          out.push({ text: oneLine(`→ Edit ${files.join(', ') || 'files'}`, 120) });
        }
      } else if (kind === 'mcp_tool_call') {
        if (!done) out.push({ text: oneLine(`→ ${[it.server, it.tool].filter(Boolean).join('.') || 'MCP tool'}`, 120) });
      } else if (kind === 'web_search') {
        if (done || it.query) out.push({ text: describeTool('WebSearch', { query: it.query }) });
      } else if (kind === 'error') {
        // An error *item* is a notice (unknown model metadata, a setting that was dropped); the run goes on.
        if (done) out.push({ text: `! ${oneLine(errorText(it), 400)}` });
      }
    } else if (e.type === 'turn.completed') {
      out.push({ text: '✓ Done' });
      r.result = { ok: true };
    } else if (e.type === 'turn.failed') {
      const msg = errorText(e.error) || 'turn failed';
      const line = `✗ ${oneLine(msg, 400)}`;
      if (line !== lastError) out.push({ text: line });
      lastError = line;
      r.result = { ok: false, error: msg };
    } else if (e.type === 'error') {
      // Also used for retry notices ("Reconnecting... 2/5"), so it is shown but does not decide the outcome.
      const line = `✗ ${oneLine(errorText(e), 400)}`;
      if (line !== lastError) out.push({ text: line });
      lastError = line;
    }
  }

  function cursor(e, out, r) {
    const sid = e.session_id || e.chat_id || e.chatId;
    if (typeof sid === 'string' && sid) r.sessionId = sid;
    if (e.type === 'assistant') {
      const parts = Array.isArray(e.message?.content) ? e.message.content : [];
      const text = parts.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
      if (!text) return;
      // cursor-agent streams an answer as a run of small assistant events; keep them on one paragraph.
      out.push({ text, inline: streaming });
      streamed = streaming ? streamed + text : text;
      allText += text;
      streaming = true;
      lastText = streamed.trim();
      return;
    }
    if (e.type === 'thinking' || e.type === 'user') return;
    streaming = false;
    if (e.type === 'tool_call') {
      if (e.subtype && e.subtype !== 'started') return;
      const tc = e.tool_call && typeof e.tool_call === 'object' ? e.tool_call : {};
      const key = Object.keys(tc)[0] || 'tool';
      const body = tc[key] && typeof tc[key] === 'object' ? tc[key] : {};
      let name = key.replace(/ToolCall$/, '');
      let args = body.args;
      if (key === 'function') {
        name = body.name || 'tool';
        try {
          args = typeof body.arguments === 'string' ? JSON.parse(body.arguments) : body.arguments;
        } catch {
          args = {};
        }
      }
      name = name.charAt(0).toUpperCase() + name.slice(1);
      out.push({ text: describeTool(name, args) });
    } else if (e.type === 'result') {
      if (e.is_error || (e.subtype && e.subtype !== 'success')) {
        const msg = errorText(typeof e.result === 'string' && e.result ? e.result : e.error || e.subtype) || 'failed';
        out.push({ text: `✗ ${oneLine(msg, 400)}` });
        r.result = { ok: false, error: msg };
      } else {
        // `result` repeats what was streamed (all of it, or the last message); show it only if it is news.
        const squash = (v) => String(v).replace(/\s+/g, '');
        const text = typeof e.result === 'string' ? e.result.trim() : '';
        if (text && !squash(allText).endsWith(squash(text))) say(out, text);
        out.push({ text: '✓ Done' });
        r.result = { ok: true };
      }
    }
  }

  const handlers = { claude, codex, cursor };

  return {
    /** @param {string} line */
    feed(line) {
      /** @type {{out: {text: string, inline?: boolean}[], sessionId?: string, result?: {ok: boolean, error?: string}}} */
      const r = { out: [] };
      const raw = String(line).replace(/\r$/, '');
      if (!raw.trim()) return r;
      let e = null;
      if (raw.trimStart().startsWith('{')) {
        try {
          e = JSON.parse(raw);
        } catch {
          e = null;
        }
      }
      if (e && typeof e === 'object') {
        try {
          handlers[tool](e, r.out, r);
        } catch {
          /* an event of an unexpected shape is skipped, never fatal */
        }
      } else {
        // Plain text: usually stderr (auth problems, usage errors). Worth showing as it is.
        streaming = false;
        const t = raw.replace(ANSI_RE, '').trim();
        // codex announces that it looked at stdin (which is closed); that is not news.
        if (t && !/^Reading (additional input|prompt) from stdin/.test(t)) r.out.push({ text: t.length > 500 ? t.slice(0, 499) + '…' : t });
      }
      return r;
    },
  };
}

/** Rolling text buffer that keeps the last `max` characters. */
export function createTail(max = TAIL_CHARS) {
  let text = '';
  return {
    /** @param {{text: string, inline?: boolean}} chunk */
    push(chunk) {
      if (!chunk?.text) return;
      // Lines are joined by a newline; an inline chunk continues the last line.
      text += chunk.inline || !text ? chunk.text : `\n${chunk.text}`;
      if (text.length > max) text = text.slice(-max);
    },
    get value() {
      return text;
    },
    set value(v) {
      text = String(v || '').slice(-max);
    },
  };
}

// --- the launcher -----------------------------------------------------------

function newTaskId() {
  return `task-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function pidStartSync(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const MOCK_SCRIPT = [
  [1200, 'Session started. Looking around the project first.'],
  [3600, '→ Read README.md'],
  [6000, '→ Grep "TODO"'],
  [8500, 'I see what this needs. Working through it now.'],
  [11000, '→ Bash npm test'],
  [14000, null], // permission-dependent line, filled in below
  [17000, 'All checks pass. Short summary: the change is small, covered by the existing tests, and ready for you to look at.'],
];

/**
 * @param {object} [opts]
 * @param {Record<string, {available?: boolean, path?: string}>} [opts.tools]  resolved CLI paths (from state.detectTools)
 * @param {object} [opts.mock]        a createMock() instance: nothing is ever spawned
 * @param {string} [opts.dir]         where logs and index.json live
 * @param {() => void} [opts.onChange] called whenever any task changes
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {number} [opts.pollMs]      how often log files are tailed
 * @param {number} [opts.killGraceMs]
 * @param {boolean} [opts.adopt]      re-attach to runs a previous server left behind (default true)
 * @param {object} [opts.meta]        names and groups (meta.mjs): a task's `label` / `groupId` are checked
 *                                    against it and written to it once the task's session id is known
 */
export function createLauncher({ tools = {}, mock = null, dir = DEFAULT_TASK_DIR, onChange = () => {}, env = process.env, pollMs = 300, killGraceMs = KILL_GRACE_MS, adopt = true, meta = null } = {}) {
  /** @type {Map<string, any>} id -> record {task, tail, parser, ...} */
  const records = new Map();
  const indexPath = path.join(dir, 'index.json');
  /** @type {CursorCaps|null} */
  let cursorCaps = null;
  let cursorCapsProbe = null;
  let timer = null;
  let closed = false;

  const changed = () => {
    try {
      onChange();
    } catch {
      /* a listener must not break a run */
    }
  };
  const isActive = (task) => task.status === 'starting' || task.status === 'running';
  const snapshot = (rec) => ({ ...rec.task, outputTail: rec.tail.value });

  function list() {
    return [...records.values()].sort((a, b) => b.task.startedAt - a.task.startedAt || (a.task.id < b.task.id ? 1 : -1)).map(snapshot);
  }

  function get(id) {
    const rec = records.get(id);
    return rec ? snapshot(rec) : null;
  }

  function trim() {
    if (records.size <= 60) return;
    const finished = [...records.values()].filter((r) => !isActive(r.task)).sort((a, b) => a.task.startedAt - b.task.startedAt);
    while (records.size > 50 && finished.length) records.delete(finished.shift().task.id);
  }

  function assertCapacity() {
    const running = [...records.values()].filter((r) => isActive(r.task)).length;
    if (running >= MAX_RUNNING) throw new LauncherError(`already running ${MAX_RUNNING} tasks; stop one or wait for one to finish`, 429);
  }

  // ---- names and groups ----

  /** The `label` / `groupId` of a request: validated, `{}` when neither was given. */
  function prepareMeta(o) {
    if (o.label === undefined && o.groupId === undefined) return {};
    try {
      const given = { label: o.label, groupId: o.groupId };
      return meta ? meta.checkSessionPatch(given) : normalizeSessionPatch(given, null);
    } catch (err) {
      if (err instanceof MetaError) throw new LauncherError(err.message, err.status);
      throw err;
    }
  }

  /** What the Task echoes: only a name or a group that was actually set (not a "clear"). */
  const metaEcho = (m) => ({ ...(typeof m?.label === 'string' ? { label: m.label } : {}), ...(typeof m?.groupId === 'string' ? { groupId: m.groupId } : {}) });

  /** Give the task's session its name and group. Called whenever the task's session id becomes known. */
  function applyMeta(rec) {
    const patch = rec.meta;
    const sid = rec.task.sessionId;
    if (!meta || !sid || !patch || !Object.keys(patch).length) return;
    try {
      meta.setSessionMeta(sid, patch);
    } catch {
      // The group was deleted while the run was starting, or the tool reported an id of an unexpected
      // shape. The run matters more than its name; keep the name if that much can be kept.
      try {
        if (patch.label !== undefined) meta.setSessionMeta(sid, { label: patch.label });
      } catch {
        /* nothing to apply */
      }
    }
  }

  // ---- mock runs ----

  function startMock(spec, resumeOf) {
    const id = newTaskId();
    const task = {
      id,
      tool: spec.tool,
      prompt: spec.prompt,
      cwd: spec.cwd,
      permission: spec.permission,
      ...(spec.model ? { model: spec.model } : {}),
      status: 'starting',
      startedAt: Date.now(),
      outputTail: '',
      ...metaEcho(spec.meta),
      ...(resumeOf ? { resumeOf, sessionId: resumeOf } : {}),
    };
    const rec = { task, tail: createTail(), timers: [], meta: spec.meta };
    records.set(id, rec);
    // A new character gets its name and group from the generator itself; a follow-up goes through the store.
    if (!resumeOf) task.sessionId = mock.add({ tool: spec.tool, prompt: spec.prompt, cwd: spec.cwd, taskId: id, ...metaEcho(spec.meta) });
    else applyMeta(rec);
    const at = (ms, fn) => {
      const t = setTimeout(() => {
        if (!isActive(task)) return;
        fn();
        changed();
      }, ms);
      t.unref?.();
      rec.timers.push(t);
    };
    for (const [ms, line] of MOCK_SCRIPT) {
      at(ms, () => {
        task.status = 'running';
        rec.tail.push({ text: line ?? (spec.permission === 'read' ? '→ Read src/index.js' : '→ Edit src/index.js') });
      });
    }
    at(20_000, () => {
      rec.tail.push({ text: '✓ Done' });
      task.status = 'done';
      task.endedAt = Date.now();
      task.exitCode = 0;
    });
    trim();
    changed();
    return snapshot(rec);
  }

  // ---- real runs ----

  function saveIndex() {
    if (mock) return;
    try {
      const rows = [...records.values()].filter((r) => r.logPath).map((r) => ({ ...r.task, outputTail: undefined, pid: r.pid, pidStart: r.pidStart, logPath: r.logPath }));
      const tmp = `${indexPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: rows }), { mode: 0o600 });
      fs.renameSync(tmp, indexPath);
    } catch {
      /* the index is a convenience; losing it only costs re-adoption after a restart */
    }
  }

  function drain(rec) {
    let fd;
    try {
      fd = fs.openSync(rec.logPath, 'r');
    } catch {
      return false;
    }
    let any = false;
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, rec.pos);
        if (n <= 0) break;
        rec.pos += n;
        rec.partial += rec.decoder.write(buf.subarray(0, n));
        let nl;
        while ((nl = rec.partial.indexOf('\n')) >= 0) {
          const line = rec.partial.slice(0, nl);
          rec.partial = rec.partial.slice(nl + 1);
          if (consume(rec, line)) any = true;
        }
        // A single line with no end in sight (a huge tool result): do not hold megabytes for it.
        if (rec.partial.length > 4 * 1024 * 1024) rec.partial = '';
      }
    } catch {
      /* try again on the next tick */
    } finally {
      fs.closeSync(fd);
    }
    return any;
  }

  function consume(rec, line) {
    const r = rec.parser.feed(line);
    let any = false;
    for (const chunk of r.out) {
      rec.tail.push(chunk);
      any = true;
    }
    if (r.sessionId) {
      const sid = `${rec.task.tool}:${r.sessionId}`;
      if (rec.task.sessionId !== sid) {
        rec.task.sessionId = sid;
        rec.dirty = true;
        any = true;
        applyMeta(rec); // codex and cursor name their session only once they are running
      }
    }
    if (r.result) rec.result = r.result;
    if (rec.task.status === 'starting' && (r.out.length || r.sessionId)) {
      rec.task.status = 'running';
      rec.dirty = true;
      any = true;
    }
    return any;
  }

  function finish(rec, code, signal) {
    if (rec.finished) return;
    rec.finished = true;
    drain(rec);
    if (rec.partial.trim()) consume(rec, rec.partial);
    rec.partial = '';
    if (rec.killTimer) clearTimeout(rec.killTimer);
    const task = rec.task;
    task.exitCode = typeof code === 'number' ? code : null;
    if (!task.endedAt) task.endedAt = Date.now();
    if (task.status !== 'stopped') {
      // With an exit code, the code decides (and a reported error overrides a zero). Without one
      // (a run adopted from an earlier server), the outcome the tool itself reported decides.
      const ok = typeof code === 'number' ? code === 0 && rec.result?.ok !== false : rec.result?.ok === true;
      task.status = ok ? 'done' : 'failed';
      if (!ok && !rec.result) rec.tail.push({ text: signal ? `✗ Ended by ${signal}` : typeof code === 'number' ? `✗ Exited with code ${code}` : '✗ Ended without reporting a result' });
      if (!ok && SIGN_IN_RE.test(rec.tail.value)) rec.tail.push({ text: `✗ ${BIN[task.tool]} is not signed in. Run \`${LOGIN_HINT[task.tool]}\` in a terminal, then try again.` });
    }
    saveIndex();
    changed();
  }

  function tick() {
    let any = false;
    let active = 0;
    for (const rec of records.values()) {
      if (!rec.logPath || rec.finished) continue;
      active += 1;
      if (drain(rec)) any = true;
      if (rec.dirty) {
        rec.dirty = false;
        saveIndex();
      }
      // Adopted runs have no child handle: notice their end by the pid going away.
      if (!rec.child && !pidAlive(rec.pid)) finish(rec, null, null);
    }
    if (any) changed();
    if (!active && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function ensureTimer() {
    if (timer || closed) return;
    timer = setInterval(tick, pollMs);
    timer.unref?.();
  }

  async function probeCursorCaps() {
    if (cursorCaps) return cursorCaps;
    const bin = tools.cursor?.path;
    if (!bin) return {}; // not cached: detection may still be under way
    cursorCapsProbe ||= new Promise((resolve) => {
      execFile(bin, ['--help'], { timeout: 8000, env: childEnv(env, defaultExtraDirs(tools)), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve(parseCursorCaps(`${stdout || ''}\n${stderr || ''}`));
      }).stdin?.end();
    });
    cursorCaps = await cursorCapsProbe;
    return cursorCaps;
  }

  async function startReal(spec, resumeNativeId, resumeOf) {
    const bin = tools[spec.tool]?.path;
    if (!bin) throw new LauncherError(`${BIN[spec.tool]} is not installed (not found on PATH)`, 503);
    const caps = spec.tool === 'cursor' ? await probeCursorCaps() : undefined;
    assertCapacity();

    const id = newTaskId();
    const sessionUuid = spec.tool === 'claude' && !resumeNativeId ? crypto.randomUUID() : undefined;
    const args = buildArgs({ ...spec, sessionUuid, resume: resumeNativeId, cursorCaps: caps });

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const logPath = path.join(dir, `${id}.log`);
    const fd = fs.openSync(logPath, 'a', 0o600);
    const task = {
      id,
      tool: spec.tool,
      prompt: spec.prompt,
      cwd: spec.cwd,
      permission: spec.permission,
      ...(spec.model ? { model: spec.model } : {}),
      status: 'starting',
      startedAt: Date.now(),
      outputTail: '',
      ...metaEcho(spec.meta),
      ...(resumeOf ? { resumeOf, sessionId: resumeOf } : sessionUuid ? { sessionId: `claude:${sessionUuid}` } : {}),
    };
    const rec = { task, tail: createTail(), parser: createParser(spec.tool), logPath, pos: 0, partial: '', decoder: makeDecoder(), child: null, pid: 0, pidStart: '', result: null, finished: false, dirty: false, killTimer: null, meta: spec.meta };

    let child;
    try {
      // No shell, nothing on stdin, own process group, output straight to the log file.
      child = spawn(bin, args, { cwd: spec.cwd, env: childEnv(env, defaultExtraDirs(tools)), detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    } catch (err) {
      fs.closeSync(fd);
      throw new LauncherError(`could not start ${BIN[spec.tool]}: ${err?.message || err}`, 500);
    }
    fs.closeSync(fd);
    rec.child = child;
    rec.pid = child.pid || 0;
    records.set(id, rec);
    applyMeta(rec); // claude runs and follow-ups know their session id up front

    child.once('error', (err) => {
      rec.tail.push({ text: `✗ Could not start ${BIN[spec.tool]}: ${err?.message || err}` });
      rec.result = { ok: false, error: String(err?.message || err) };
      finish(rec, null, null);
    });
    child.once('exit', (code, signal) => finish(rec, code, signal));
    child.unref();

    if (rec.pid) {
      execFile('ps', ['-o', 'lstart=', '-p', String(rec.pid)], { timeout: 2000 }, (err, stdout) => {
        if (err) return;
        rec.pidStart = String(stdout || '').trim();
        saveIndex();
      });
    }
    trim();
    saveIndex();
    ensureTimer();
    changed();
    return snapshot(rec);
  }

  function adoptExisting() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch {
      return;
    }
    for (const row of Array.isArray(data?.tasks) ? data.tasks : []) {
      if (!row || !TOOLS.includes(row.tool) || typeof row.id !== 'string' || !/^task-[a-z0-9-]+$/.test(row.id)) continue;
      if (row.status !== 'starting' && row.status !== 'running') continue;
      const logPath = path.join(dir, `${row.id}.log`);
      if (!fs.existsSync(logPath)) continue;
      const { pid, pidStart, logPath: _ignored, ...task } = row;
      // `meta`: a run adopted before it named its session still gets its name and group when it does.
      const rec = { task: { ...task, outputTail: '' }, tail: createTail(), parser: createParser(row.tool), logPath, pos: 0, partial: '', decoder: makeDecoder(), child: null, pid: 0, pidStart: '', result: null, finished: false, dirty: false, killTimer: null, meta: metaEcho(task) };
      // Only trust the pid if it is still the same process (pids get reused).
      const same = Number.isInteger(pid) && pid > 1 && pidAlive(pid) && pidStart && pidStartSync(pid) === pidStart;
      rec.pid = same ? pid : 0;
      rec.pidStart = same ? pidStart : '';
      records.set(row.id, rec);
      drain(rec);
      if (!same) finish(rec, null, null);
    }
    if ([...records.values()].some((r) => !r.finished)) ensureTimer();
    saveIndex();
  }

  function prepare(input, { cwdMustExist }) {
    const o = input && typeof input === 'object' ? input : {};
    return {
      tool: validateTool(o.tool),
      prompt: validatePrompt(o.prompt),
      cwd: validateCwd(o.cwd, { mustExist: cwdMustExist }),
      permission: validatePermission(o.permission),
      model: validateModel(o.model),
      meta: prepareMeta(o),
    };
  }

  /** Start a new run. @returns {Promise<object>} the Task */
  async function start(input) {
    if (closed) throw new LauncherError('server is shutting down', 503);
    const spec = prepare(input, { cwdMustExist: !mock });
    assertCapacity();
    return mock ? startMock(spec, null) : startReal(spec, null, null);
  }

  /**
   * Send a follow-up prompt to an existing session by resuming it.
   * @param {string} sessionId `${tool}:${nativeId}`
   * @param {{prompt: string, permission?: string, model?: string, label?: string|null, groupId?: string|null}} input
   * @param {{cwd?: string}} [session] the live Session, when the office knows it
   */
  async function followUp(sessionId, input, session) {
    if (closed) throw new LauncherError('server is shutting down', 503);
    const sid = String(sessionId || '');
    const cut = sid.indexOf(':');
    const tool = cut > 0 ? sid.slice(0, cut) : '';
    const nativeId = cut > 0 ? sid.slice(cut + 1) : '';
    if (!TOOLS.includes(tool) || !NATIVE_ID_RE.test(nativeId)) throw new LauncherError('unknown session', 404);
    const previous = [...records.values()].filter((r) => r.task.sessionId === sid).sort((a, b) => b.task.startedAt - a.task.startedAt);
    if (previous.some((r) => isActive(r.task))) throw new LauncherError('a task is already running in this session', 409);
    const cwd = session?.cwd || previous[0]?.task.cwd;
    if (!cwd) throw new LauncherError('unknown session', 404);
    const o = input && typeof input === 'object' ? input : {};
    const spec = {
      tool,
      prompt: validatePrompt(o.prompt),
      cwd: validateCwd(cwd, { mustExist: !mock }),
      // Unless told otherwise, a follow-up runs the way the previous run in this session did.
      permission: validatePermission(o.permission, previous[0]?.task.permission || DEFAULT_PERMISSION),
      model: validateModel(o.model) ?? previous[0]?.task.model,
      meta: prepareMeta(o),
    };
    assertCapacity();
    return mock ? startMock(spec, sid) : startReal(spec, nativeId, sid);
  }

  function signalGroup(rec, signal) {
    if (!rec.pid) return;
    try {
      process.kill(-rec.pid, signal); // the whole process group (the run is its leader)
    } catch {
      try {
        process.kill(rec.pid, signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** Stop a run: SIGTERM to its process group, SIGKILL after the grace period. */
  function stop(id) {
    const rec = records.get(id);
    if (!rec) throw new LauncherError('unknown task', 404);
    const task = rec.task;
    if (!isActive(task)) return snapshot(rec);
    task.status = 'stopped';
    task.endedAt = Date.now();
    rec.tail.push({ text: '■ Stopped' });
    if (rec.timers) {
      for (const t of rec.timers) clearTimeout(t);
    } else {
      signalGroup(rec, 'SIGTERM');
      rec.killTimer = setTimeout(() => {
        if (pidAlive(rec.pid)) signalGroup(rec, 'SIGKILL');
        if (!rec.child) finish(rec, null, 'SIGKILL');
      }, killGraceMs);
      // Deliberately not unref'd: a stop that was asked for is followed through even during shutdown.
      saveIndex();
    }
    changed();
    return snapshot(rec);
  }

  /** Stop watching. Runs are left alone: they are detached and keep writing to their logs. */
  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const rec of records.values()) for (const t of rec.timers || []) clearTimeout(t);
    saveIndex();
  }

  function permissionNotes() {
    const { cursorLegacy, ...rest } = PERMISSION_NOTES;
    return { ...rest, cursor: mock || !tools.cursor?.path ? PERMISSION_NOTES.cursor : cursorNotes(cursorCaps || {}) };
  }

  /** Logs of runs that ended long ago are removed; nothing else ever deletes them. */
  function pruneLogs(maxAgeMs = 14 * 24 * 3600_000) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^task-[a-z0-9-]+\.log$/.test(name) || records.has(name.slice(0, -4))) continue;
      const file = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file);
      } catch {
        /* someone else removed it */
      }
    }
  }

  if (!mock) {
    if (adopt) adoptExisting();
    pruneLogs();
    if (tools.cursor?.path) probeCursorCaps().then(changed, () => {});
  }

  return { start, followUp, stop, list, get, close, permissionNotes, ready: () => (mock ? Promise.resolve({}) : probeCursorCaps()) };
}

/** Streaming UTF-8 decoder that survives a multi-byte character split across two reads. */
function makeDecoder() {
  const d = new TextDecoder('utf-8');
  return { write: (buf) => d.decode(buf, { stream: true }) };
}
