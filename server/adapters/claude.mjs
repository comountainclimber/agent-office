// Claude Code adapter for Agent Office.
//
// Reads Claude Code's own on-disk state (never the network):
//
//   <home>/projects/<cwd-slug>/<sessionId>.jsonl                      session transcript (CLI and desktop app)
//   <home>/projects/<cwd-slug>/<sessionId>/custom-title.json           {"customTitle": "..."}
//   <home>/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.jsonl  one transcript per Agent-tool subagent
//   <home>/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.meta.json   {agentType, description, toolUseId, finished?}
//   <home>/projects/<cwd-slug>/<sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl (+ .meta.json)  Workflow-tool agents
//   <home>/sessions/<pid>.json                                         live process registry {pid, sessionId, cwd, status, ...}
//
// <home> is ~/.claude unless overridden (AGENT_OFFICE_CLAUDE_HOME, CLAUDE_CONFIG_DIR, or setRoots()).
//
// Everything is stat-first and cached by (mtime, size); only bounded heads/tails of files are ever read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clipText, oneLine, IDLE_MAX_MS, SUBAGENT_LINGER_MS } from '../contract.mjs';

export const tool = 'claude';

// --- Tunables ---------------------------------------------------------------
const HEAD_BYTES = 64 * 1024; // head read: start time, first prompt, original cwd
const TAIL_BYTES = 512 * 1024; // tail read of a session transcript
const TAIL_MAX_BYTES = 8 * 1024 * 1024; // only reached when the tail is one giant line
const AGENT_HEAD_BYTES = 16 * 1024;
const AGENT_TAIL_BYTES = 128 * 1024;
const AGENT_TAIL_MAX_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const TRANSCRIPT_TAIL_MAX_BYTES = 8 * 1024 * 1024;

const SUB_SCAN_GRACE_MS = 6 * 60 * 60_000; // look for live subagents under sessions whose own log is this much older than maxAge
const WF_DEAD_MS = 12 * 60 * 60_000; // workflow run dirs with no new agent for this long are ignored
const HOT_MS = 15 * 60_000; // subagent files written this recently are re-statted every poll
const COLD_RESTAT_MS = 10_000; // everything else is re-statted this often
const DIR_RELIST_MS = 30_000; // safety net for directory-mtime based listing caches
const SUB_RECENT_MS = 30 * 60_000; // "recent" when the start of the current turn is not in the tail window
const SUB_STALE_MS = 30 * 60_000; // a "working" subagent silent for this long is treated as dead
const SUB_STALE_BUSY_MS = 2 * 60 * 60_000; // ...unless its parent process says it is busy
const BUSY_SETTLE_MS = 3_000; // how long after a final reply a still-"busy" process registry entry is believed
const RESULT_LINGER_MS = 15_000; // keep showing a finished tool call this long before switching to "Thinking"
const MAX_SUB_PARSE = 80;
export const MAX_SUBAGENTS = 40;

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TERMINAL_TOOLS = new Set(['SubagentHandback', 'StructuredOutput']);
const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Bookkeeping record types that never matter here. Many are huge (request blobs), so they are skipped
// without JSON.parse. All of them are written with "type" as the first key.
const NOISE_TYPES = new Set([
  'api-request', 'api-request-blob', 'api-request-shape', 'queue-operation', 'file-history-snapshot',
  'file-history-delta', 'last-prompt', 'atis-latch', 'tools-used', 'pr-link', 'mode', 'permission-mode',
  'cost-state', 'frame-link', 'worktree-state', 'artifact-autoreact-ledger', 'artifact-comment-monitor',
  'session-owner', 'attachment', 'fork-context-ref',
]);
const RE_ATTACHMENT = /^\{"parentUuid":(?:null|"[^"]*"),"isSidechain":(?:true|false),(?:"agentId":"[^"]*",)?"attachment":/;
// A JSON key can only be preceded by an unescaped quote, so this never matches inside string content.
const RE_TS = /(?<!\\)"timestamp":"(\d{4}-\d\d-\d\dT[^"\\]{8,32})"/;

// --- Roots --------------------------------------------------------------------
let PROJECTS_ROOT = '';
let SESSIONS_DIR = /** @type {string|null} */ (null);

/**
 * Point the adapter at a different Claude home (tests) or individual directories.
 * `setRoots({ home })` uses <home>/projects and <home>/sessions.
 * `setRoots({ projectsRoot })` alone disables the pid registry so nothing outside that root is read.
 */
export function setRoots({ home, projectsRoot, sessionsDir } = {}) {
  if (home) {
    PROJECTS_ROOT = path.join(home, 'projects');
    SESSIONS_DIR = path.join(home, 'sessions');
  }
  if (projectsRoot) {
    PROJECTS_ROOT = projectsRoot;
    if (!home) SESSIONS_DIR = null;
  }
  if (sessionsDir !== undefined) SESSIONS_DIR = sessionsDir;
  resetCaches();
}
export function getRoots() {
  return { projectsRoot: PROJECTS_ROOT, sessionsDir: SESSIONS_DIR };
}

// --- Caches -------------------------------------------------------------------
const slugCache = new Map(); // slugDir -> { mtimeMs, listedAt, files: Map<name, FileEntry> }
const mainCache = new Map(); // transcript path -> { mtimeMs, size, a, head }
const agentCache = new Map(); // agent transcript path -> { mtimeMs, size, a, startedAt, firstPrompt, usedAt }
const metaCache = new Map(); // meta path -> { mtimeMs, data, usedAt }
const titleFileCache = new Map(); // custom-title.json path -> { mtimeMs, title }
const subScanCache = new Map(); // sessionDir -> scan state
const pidCache = new Map(); // pid file -> { mtimeMs, size, info }
const sessionIndex = new Map(); // sessionId -> { file, dir }
let lastPrune = 0;

function resetCaches() {
  slugCache.clear();
  mainCache.clear();
  agentCache.clear();
  metaCache.clear();
  titleFileCache.clear();
  subScanCache.clear();
  pidCache.clear();
  sessionIndex.clear();
}

{
  const home = process.env.AGENT_OFFICE_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  PROJECTS_ROOT = process.env.AGENT_OFFICE_CLAUDE_PROJECTS || path.join(home, 'projects');
  SESSIONS_DIR = process.env.AGENT_OFFICE_CLAUDE_PROJECTS && !process.env.AGENT_OFFICE_CLAUDE_HOME ? null : path.join(home, 'sessions');
}

// --- Small helpers --------------------------------------------------------------
const STAT_OPTS = { throwIfNoEntry: false };
function statOrNull(p) {
  try {
    return fs.statSync(p, STAT_OPTS) || null;
  } catch {
    return null;
  }
}
function parseTs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
function slugify(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}
function base(p) {
  if (typeof p !== 'string' || !p) return '';
  const b = path.basename(p.replace(/[\\/]+$/, ''));
  return b || p;
}
function hostOf(u) {
  try {
    return new URL(String(u)).host || String(u);
  } catch {
    return String(u ?? '');
  }
}
const yieldTick = () => new Promise((r) => setImmediate(r));

function readRange(file, start, length) {
  if (length <= 0) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.toString('utf8', 0, got);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** Last `bytes` of the file as lines. The first (partial) line is dropped unless the read starts at byte 0. */
function readTailLines(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  let text = readRange(file, start, size - start);
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return { lines: text.split('\n'), fromStart: start === 0 };
}

/** First `bytes` of the file as complete lines (a trailing partial line is dropped). */
function readHead(file, size, bytes) {
  const len = Math.min(size, bytes);
  let text = readRange(file, 0, len);
  if (len < size) {
    const nl = text.lastIndexOf('\n');
    text = nl >= 0 ? text.slice(0, nl) : '';
  }
  return text;
}

// --- Prompt / label text -----------------------------------------------------------
function notificationText(t) {
  const status = (t.match(/<status>([^<]*)<\/status>/) || [])[1];
  const summary = (t.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1];
  return `[Background task ${status || 'update'}] ${summary || ''}`.trim();
}

/** Strip harness wrapper tags from a user prompt. Keeps newlines. */
export function cleanPrompt(text) {
  let t = String(text ?? '');
  if (t.includes('<task-notification>')) return notificationText(t);
  t = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(ide_opened_file|ide_selection|ide_diagnostics|local-command-caveat|user-prompt-submit-hook|fork-boilerplate)>[\s\S]*?<\/\1>/g, '');
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  const sched = t.match(/^\s*<scheduled-task name="([^"]+)"/);
  if (sched) return `Scheduled task: ${sched[1]}`;
  t = t.replace(/<\/?(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|command-message|command-contents)>/g, ' ');
  return t.trim();
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
const act = (kind, label) => ({ kind, label: oneLine(label, 60) || kind });

/** First 40 chars of a shell command, without a leading `cd <dir> &&` (which is only ever a full path). */
function bashLabel(command) {
  const c = oneLine(command, 4000);
  const rest = c.replace(/^\(?\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '');
  return (rest || c).slice(0, 40);
}

/** Map a tool call to an Activity. Basenames only, never full paths. */
export function toolActivity(name, input) {
  const n = String(name || '');
  const i = input && typeof input === 'object' ? input : {};
  switch (n) {
    case 'Read':
    case 'NotebookRead':
      return act('reading', `Read ${base(i.file_path || i.notebook_path || i.path)}`);
    case 'Glob':
      return act('reading', `Glob ${i.pattern ?? ''}`);
    case 'LS':
      return act('reading', `List ${base(i.path)}`);
    case 'Skill':
      return act('reading', `Skill: ${i.skill ?? ''}`);
    case 'Edit':
    case 'MultiEdit':
      return act('editing', `Edit ${base(i.file_path)}`);
    case 'Write':
      return act('editing', `Write ${base(i.file_path)}`);
    case 'NotebookEdit':
      return act('editing', `Edit ${base(i.notebook_path || i.file_path)}`);
    case 'Bash':
      return act('running', `Bash: ${bashLabel(i.command)}`);
    case 'BashOutput':
    case 'TaskOutput':
      return act('running', 'Checking background output');
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return act('running', 'Stopping a background task');
    case 'Monitor':
      return act('running', `Monitor: ${oneLine(i.description || i.command, 200)}`);
    case 'Grep':
      return act('searching', `Grep ${i.pattern ?? ''}`);
    case 'WebSearch':
      return act('searching', `Search: ${i.query ?? ''}`);
    case 'ToolSearch':
      return act('searching', `Tool search: ${i.query ?? ''}`);
    case 'WebFetch':
      return act('browsing', `Fetch ${hostOf(i.url)}`);
    case 'Agent':
    case 'Task':
      return act('delegating', `Agent: ${i.description || i.subagent_type || 'subagent'}`);
    case 'Workflow':
      return act('delegating', `Workflow: ${i.description || base(i.scriptPath) || 'script'}`);
    case 'SendMessage':
      return act('delegating', `Message to ${i.to || i.recipient || 'agent'}`);
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
      return act('thinking', 'Updating the plan');
    case 'AskUserQuestion':
      return act('waiting', 'Asking you a question');
    case 'ExitPlanMode':
      return act('waiting', 'Plan ready for review');
    case 'SubagentHandback':
    case 'StructuredOutput':
      return act('writing', 'Reporting back');
    case 'Artifact':
      return act('writing', `Artifact: ${base(i.file_path) || i.action || 'publish'}`);
    default:
  }
  const mcp = n.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    const [, server, fn] = mcp;
    const srv = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(server) ? '' : server.replace(/^(plugin_|claude_ai_)/i, '');
    const label = srv ? `${srv}: ${fn}` : fn;
    if (/browser|chrome|playwright|puppeteer|simulator|computer/i.test(server) || /^(navigate|screenshot|computer|click|read_page)$/i.test(fn)) {
      return act('browsing', `Browser: ${fn}`);
    }
    if (/update_plan|wrap_up|mark_chapter/i.test(fn)) return act('thinking', 'Updating the plan');
    if (/search|find|query|list|get|read|fetch|view|describe/i.test(fn)) return act('searching', label);
    return act('running', label);
  }
  return act('running', n || 'Tool');
}

/** "ToolName: short input summary" for transcripts. */
function toolSummary(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  let s = '';
  if (typeof i.command === 'string') s = i.command;
  else if (typeof i.file_path === 'string') s = base(i.file_path);
  else if (typeof i.notebook_path === 'string') s = base(i.notebook_path);
  else if (typeof i.pattern === 'string') s = i.pattern;
  else if (typeof i.query === 'string') s = i.query;
  else if (typeof i.url === 'string') s = i.url;
  else if (typeof i.description === 'string') s = i.description;
  else if (typeof i.skill === 'string') s = i.skill;
  else if (typeof i.path === 'string') s = base(i.path);
  else {
    for (const v of Object.values(i)) {
      if (typeof v === 'string' && v) {
        s = v;
        break;
      }
    }
  }
  const short = String(name || 'Tool').replace(/^mcp__.+?__/, '');
  return s ? `${short}: ${oneLine(s, 300)}` : short;
}

// --- Record analysis ---------------------------------------------------------------
/**
 * @typedef {{kind:'prompt'|'tool_result'|'interrupted'|'local'|'assistant', ts:number, block?:string, stop?:string|null,
 *            toolName?:string, apiError?:boolean}} LastRecord
 */

function classifyUserText(text, o) {
  const t = text.trimStart();
  if (t.startsWith('[Request interrupted')) return 'interrupted';
  if (/^<(local-command-(stdout|stderr|caveat)|bash-(input|stdout|stderr))>/.test(t)) return 'local';
  const origin = o.origin && typeof o.origin === 'object' ? o.origin.kind : undefined;
  if (origin === 'task-notification' || t.startsWith('<task-notification>')) return 'notification';
  if (o.isCompactSummary) return 'skip';
  if (o.isMeta && !origin) return 'skip';
  return 'prompt';
}

/**
 * One pass over transcript lines. Tolerates malformed lines and unknown record types.
 * @param {string[]} lines
 * @param {boolean} sidechainFile true when the file itself is a subagent transcript
 */
function analyze(lines, sidechainFile) {
  const a = {
    firstTs: 0, lastTs: 0, /** @type {LastRecord|null} */ last: null, conv: 0,
    turnStartTs: 0, firstPrompt: '', firstAny: '', lastText: '', lastToolActivity: null, lastToolTs: 0,
    customTitle: '', agentName: '', summary: '', relocatedCwd: '',
    firstCwd: '', cwd: '', branch: '', entrypoint: '', model: '', tokens: 0,
    agentCalls: new Map(), results: new Map(), notes: new Map(), toolNames: new Map(),
  };
  const seeTs = (ts) => {
    if (!ts) return;
    if (!a.firstTs) a.firstTs = ts;
    if (ts > a.lastTs) a.lastTs = ts;
  };
  const env = (o) => {
    if (typeof o.cwd === 'string' && o.cwd) {
      a.cwd = o.cwd;
      if (!a.firstCwd) a.firstCwd = o.cwd;
    }
    if (typeof o.gitBranch === 'string') a.branch = o.gitBranch;
    if (typeof o.entrypoint === 'string') a.entrypoint = o.entrypoint;
  };

  for (const line of lines) {
    if (line.length < 2) continue;
    if (line.startsWith('{"type":"')) {
      const end = line.indexOf('"', 9);
      if (end > 9 && NOISE_TYPES.has(line.slice(9, end))) {
        const m = RE_TS.exec(line.length > 600 ? line.slice(0, 600) : line);
        if (m) seeTs(parseTs(m[1]));
        continue;
      }
    } else if (RE_ATTACHMENT.test(line)) continue;

    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // truncated or malformed line
    }
    if (!o || typeof o !== 'object') continue;
    const ts = parseTs(o.timestamp);
    seeTs(ts);

    switch (o.type) {
      case 'custom-title':
        if (typeof o.customTitle === 'string') a.customTitle = o.customTitle;
        break;
      case 'ai-title':
        if (typeof o.aiTitle === 'string' && !a.customTitle) a.customTitle = o.aiTitle;
        break;
      case 'agent-name':
        if (typeof o.agentName === 'string') a.agentName = o.agentName;
        break;
      case 'summary':
        if (typeof o.summary === 'string') a.summary = o.summary;
        break;
      case 'relocated':
        if (typeof o.relocatedCwd === 'string') a.relocatedCwd = o.relocatedCwd;
        break;
      case 'user': {
        if (!sidechainFile && o.isSidechain) break;
        env(o);
        const c = o.message?.content;
        let text = '';
        let resultTool;
        let hasResult = false;
        let hasImage = false;
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          for (const b of c) {
            if (!b || typeof b !== 'object') continue;
            if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
            else if (b.type === 'image' || b.type === 'document') hasImage = true;
            else if (b.type === 'tool_result') {
              hasResult = true;
              const tur = o.toolUseResult && typeof o.toolUseResult === 'object' && !Array.isArray(o.toolUseResult) ? o.toolUseResult : null;
              resultTool = a.toolNames.get(b.tool_use_id);
              a.results.set(b.tool_use_id, {
                ts,
                isError: b.is_error === true,
                status: typeof tur?.status === 'string' ? tur.status : undefined,
                agentId: typeof tur?.agentId === 'string' ? tur.agentId : undefined,
              });
            }
          }
        }
        if (hasResult) {
          a.conv++;
          a.last = { kind: 'tool_result', ts, toolName: resultTool };
        }
        if (!text.trim()) {
          if (hasImage && !hasResult) {
            a.conv++;
            a.last = { kind: 'prompt', ts };
            if (!o.isMeta) a.turnStartTs = ts;
          }
          break;
        }
        const kind = classifyUserText(text, o);
        if (kind === 'skip') break;
        a.conv++;
        if (kind === 'interrupted' || kind === 'local') {
          a.last = { kind, ts };
          break;
        }
        a.last = { kind: 'prompt', ts };
        if (!a.firstAny) a.firstAny = clip(cleanPrompt(text), 600); // scheduled / peer-started sessions have no human prompt
        if (kind === 'notification') {
          const status = (text.match(/<status>([^<]*)<\/status>/) || [])[1];
          if (status) {
            const note = { status: status.trim(), ts };
            const taskId = (text.match(/<task-id>([^<]*)<\/task-id>/) || [])[1];
            const toolUseId = (text.match(/<tool-use-id>([^<]*)<\/tool-use-id>/) || [])[1];
            if (taskId) a.notes.set(taskId.trim(), note);
            if (toolUseId) a.notes.set(toolUseId.trim(), note);
          }
          break;
        }
        const originKind = o.origin && typeof o.origin === 'object' ? o.origin.kind : undefined;
        if (!o.isMeta && (originKind === undefined || originKind === 'human')) {
          a.turnStartTs = ts;
          if (!a.firstPrompt) a.firstPrompt = clip(cleanPrompt(text), 600);
        }
        break;
      }
      case 'assistant': {
        if (!sidechainFile && o.isSidechain) break;
        env(o);
        const m = o.message && typeof o.message === 'object' ? o.message : {};
        if (typeof m.model === 'string' && m.model && m.model !== '<synthetic>') a.model = m.model;
        const u = m.usage;
        if (u && typeof u === 'object') {
          const sum = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
          if (sum > 0) a.tokens = sum;
        }
        const blocks = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
        let lastBlock = null;
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text') {
            if (typeof b.text !== 'string' || !b.text.trim()) continue;
            if (!o.isApiErrorMessage) a.lastText = clip(b.text, 2000);
            lastBlock = b;
          } else if (b.type === 'tool_use') {
            const name = String(b.name || '');
            a.toolNames.set(b.id, name);
            a.lastToolActivity = toolActivity(name, b.input);
            a.lastToolTs = ts;
            if (AGENT_TOOLS.has(name)) {
              const inp = b.input && typeof b.input === 'object' ? b.input : {};
              a.agentCalls.set(b.id, {
                ts,
                description: typeof inp.description === 'string' ? inp.description : '',
                agentType: typeof inp.subagent_type === 'string' ? inp.subagent_type : undefined,
              });
            }
            lastBlock = b;
          } else if (b.type === 'thinking' || b.type === 'redacted_thinking') lastBlock = b;
        }
        if (!lastBlock) break;
        a.conv++;
        a.last = {
          kind: 'assistant',
          ts,
          block: lastBlock.type === 'redacted_thinking' ? 'thinking' : lastBlock.type,
          stop: typeof m.stop_reason === 'string' ? m.stop_reason : null,
          toolName: lastBlock.type === 'tool_use' ? String(lastBlock.name || '') : undefined,
          apiError: o.isApiErrorMessage === true,
        };
        break;
      }
      default: // system, attachment, and anything new: ignored
    }
  }
  return a;
}

const isFinalStop = (stop) => !!stop && stop !== 'tool_use' && stop !== 'pause_turn';

/** Turn state of one transcript taken on its own (ignores subagents and the pid registry). */
function ownTurn(a) {
  const l = a.last;
  if (!l) return { state: 'unknown', why: 'empty' };
  switch (l.kind) {
    case 'interrupted':
      return { state: 'ended', why: 'interrupted' };
    case 'local':
      return { state: 'ended', why: 'local' };
    case 'prompt':
      return { state: 'mid', why: 'prompt' };
    case 'tool_result':
      return { state: 'mid', why: 'tool_result' };
    default:
  }
  if (l.apiError) return { state: 'ended', why: 'error' };
  if (l.block === 'tool_use') return WAIT_TOOLS.has(l.toolName || '') ? { state: 'ended', why: 'asking' } : { state: 'mid', why: 'tool_use' };
  if (isFinalStop(l.stop)) return { state: 'ended', why: 'done' };
  return { state: 'mid', why: l.block || 'text' };
}

function workingActivity(a, turn, now) {
  switch (turn.why) {
    case 'tool_use':
      return a.lastToolActivity || act('running', 'Running a tool');
    case 'tool_result':
      // The tool has returned; shortly after that the model is composing its next step.
      if (a.last && now - a.last.ts > RESULT_LINGER_MS) return act('thinking', 'Thinking');
      return a.lastToolActivity || act('thinking', 'Thinking');
    case 'text':
      return act('writing', 'Writing');
    default:
      return act('thinking', 'Thinking');
  }
}

// --- Parsed-file caches ----------------------------------------------------------------
function loadMain(f) {
  const prev = mainCache.get(f.path);
  if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) return { entry: prev, parsed: false };

  let bytes = TAIL_BYTES;
  let a;
  let fromStart;
  for (;;) {
    const t = readTailLines(f.path, f.size, bytes);
    a = analyze(t.lines, false);
    fromStart = t.fromStart;
    if (a.last || fromStart || bytes >= TAIL_MAX_BYTES) break;
    bytes *= 4;
  }
  let head = prev?.head;
  if (!head || !head.frozen) {
    if (fromStart) {
      head = { startedAt: a.firstTs, firstPrompt: a.firstPrompt || a.firstAny, cwd: a.firstCwd, customTitle: a.customTitle, frozen: false };
    } else {
      const text = readHead(f.path, f.size, HEAD_BYTES);
      const h = analyze(text.split('\n'), false);
      const m = RE_TS.exec(text);
      head = { startedAt: h.firstTs || (m ? parseTs(m[1]) : 0), firstPrompt: h.firstPrompt || h.firstAny, cwd: h.firstCwd, customTitle: h.customTitle, frozen: true };
    }
  }
  const entry = { mtimeMs: f.mtimeMs, size: f.size, a, head };
  mainCache.set(f.path, entry);
  return { entry, parsed: true };
}

function loadAgent(f, wall) {
  const prev = agentCache.get(f.path);
  if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) {
    prev.usedAt = wall;
    return { entry: prev, parsed: false };
  }
  let bytes = AGENT_TAIL_BYTES;
  let a;
  let fromStart;
  for (;;) {
    const t = readTailLines(f.path, f.size, bytes);
    a = analyze(t.lines, true);
    fromStart = t.fromStart;
    const blind = !a.last || (a.last.kind === 'tool_result' && !a.last.toolName);
    if (!blind || fromStart || bytes >= AGENT_TAIL_MAX_BYTES) break;
    bytes *= 4;
  }
  let startedAt = prev?.startedAt || 0;
  let firstPrompt = prev?.firstPrompt || '';
  if (!startedAt) {
    if (fromStart) {
      startedAt = a.firstTs;
      firstPrompt = a.firstPrompt || a.firstAny;
    } else {
      const text = readHead(f.path, f.size, AGENT_HEAD_BYTES);
      const m = RE_TS.exec(text) || RE_TS.exec(readRange(f.path, 0, Math.min(f.size, AGENT_HEAD_BYTES)));
      startedAt = m ? parseTs(m[1]) : 0;
      if (text) {
        const h = analyze(text.split('\n'), true);
        firstPrompt = h.firstPrompt || h.firstAny;
      }
    }
  }
  const entry = { mtimeMs: f.mtimeMs, size: f.size, a, startedAt, firstPrompt, usedAt: wall };
  agentCache.set(f.path, entry);
  return { entry, parsed: true };
}

function loadMeta(metaPath, wall) {
  const st = statOrNull(metaPath);
  if (!st) return null;
  const prev = metaCache.get(metaPath);
  if (prev && prev.mtimeMs === st.mtimeMs) {
    prev.usedAt = wall;
    return prev;
  }
  let data = null;
  try {
    const o = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (o && typeof o === 'object') data = o;
  } catch {}
  const entry = { mtimeMs: st.mtimeMs, data, usedAt: wall };
  metaCache.set(metaPath, entry);
  return entry;
}

function loadTitleFile(sessionDir) {
  const p = path.join(sessionDir, 'custom-title.json');
  const st = statOrNull(p);
  if (!st) return '';
  const prev = titleFileCache.get(p);
  if (prev && prev.mtimeMs === st.mtimeMs) return prev.title;
  let title = '';
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (o && typeof o.customTitle === 'string') title = o.customTitle;
  } catch {}
  titleFileCache.set(p, { mtimeMs: st.mtimeMs, title });
  return title;
}

// --- Directory scans ---------------------------------------------------------------------
/** Transcripts whose own mtime is >= cutoff. Cold files are only re-statted every COLD_RESTAT_MS. */
function scanRoot(wall, cutoff, forceSids) {
  const out = [];
  let ents;
  try {
    ents = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = path.join(PROJECTS_ROOT, e.name);
    const dst = statOrNull(dir);
    if (!dst || !dst.isDirectory()) continue;
    let sc = slugCache.get(dir);
    if (!sc || sc.mtimeMs !== dst.mtimeMs || wall - sc.listedAt > DIR_RELIST_MS) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const files = new Map();
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const sid = n.slice(0, -6);
        files.set(n, sc?.files.get(n) || { sid, slug: e.name, path: path.join(dir, n), dir: path.join(dir, sid), mtimeMs: 0, size: 0, birth: 0, statAt: 0 });
      }
      sc = { mtimeMs: dst.mtimeMs, listedAt: wall, files };
      slugCache.set(dir, sc);
    }
    for (const f of sc.files.values()) {
      const cold = f.statAt > 0 && f.mtimeMs < cutoff;
      if (!cold || wall - f.statAt >= COLD_RESTAT_MS || forceSids.has(f.sid)) {
        const st = statOrNull(f.path);
        f.statAt = wall;
        if (!st) {
          f.mtimeMs = 0;
          continue;
        }
        f.mtimeMs = st.mtimeMs;
        f.size = st.size;
        f.birth = st.birthtimeMs;
      }
      if (f.mtimeMs <= 0) continue;
      sessionIndex.set(f.sid, { file: f.path, dir: f.dir });
      if (f.mtimeMs >= cutoff) out.push(f);
    }
  }
  return out;
}

const NO_FILES = [];
function listAgentFiles(dir, wfRun, prev) {
  const files = new Map();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { files, names: [] };
  }
  for (const n of names) {
    if (!n.startsWith('agent-') || !n.endsWith('.jsonl')) continue;
    const p = path.join(dir, n);
    files.set(p, prev?.get(p) || { path: p, id: n.slice(6, -6), metaPath: p.slice(0, -6) + '.meta.json', wfRun, mtimeMs: 0, size: 0, birth: 0, statAt: 0 });
  }
  return { files, names };
}

/** All subagent transcript files of a session (Agent-tool and Workflow-tool), with fresh-enough stats. */
function scanSubagents(sessionDir, wall) {
  const subDir = path.join(sessionDir, 'subagents');
  const st = statOrNull(subDir);
  if (!st) {
    subScanCache.delete(sessionDir);
    return NO_FILES;
  }
  let s = subScanCache.get(sessionDir);
  if (!s) {
    s = { mtimeMs: -1, listedAt: 0, plain: new Map(), hasWf: false, wfMtimeMs: -1, wf: new Map() };
    subScanCache.set(sessionDir, s);
  }
  const relist = wall - s.listedAt > DIR_RELIST_MS;
  if (relist || st.mtimeMs !== s.mtimeMs) {
    const r = listAgentFiles(subDir, undefined, s.plain);
    s.plain = r.files;
    s.hasWf = r.names.includes('workflows');
    s.mtimeMs = st.mtimeMs;
  }
  if (s.hasWf) {
    const wfRoot = path.join(subDir, 'workflows');
    const wst = statOrNull(wfRoot);
    if (wst && (relist || wst.mtimeMs !== s.wfMtimeMs)) {
      s.wfMtimeMs = wst.mtimeMs;
      let names = [];
      try {
        names = fs.readdirSync(wfRoot);
      } catch {}
      const next = new Map();
      for (const n of names) {
        const d = path.join(wfRoot, n);
        next.set(d, s.wf.get(d) || { run: n, mtimeMs: -1, statAt: 0, files: new Map() });
      }
      s.wf = next;
    }
    for (const [d, w] of s.wf) {
      // A run directory's mtime moves whenever an agent is added to it.
      const quiet = w.statAt > 0 && wall - w.mtimeMs > HOT_MS * 4;
      if (quiet && !relist) continue;
      const dstat = statOrNull(d);
      w.statAt = wall;
      if (!dstat || !dstat.isDirectory()) {
        w.files = new Map();
        continue;
      }
      if (dstat.mtimeMs !== w.mtimeMs) {
        w.mtimeMs = dstat.mtimeMs;
        w.files = wall - dstat.mtimeMs > WF_DEAD_MS ? new Map() : listAgentFiles(d, w.run, w.files).files;
      }
    }
  }
  if (relist) s.listedAt = wall;

  const out = [];
  const visit = (f) => {
    const cold = f.statAt > 0 && wall - f.mtimeMs > HOT_MS;
    if (!cold || relist) {
      const fst = statOrNull(f.path);
      f.statAt = wall;
      if (!fst) {
        f.mtimeMs = 0;
        return;
      }
      f.mtimeMs = fst.mtimeMs;
      f.size = fst.size;
      f.birth = fst.birthtimeMs;
    }
    if (f.mtimeMs > 0) out.push(f);
  };
  for (const f of s.plain.values()) visit(f);
  for (const w of s.wf.values()) for (const f of w.files.values()) visit(f);
  return out;
}

// --- Live process registry (<home>/sessions/<pid>.json) -----------------------------------------
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function scanPids() {
  const byId = new Map();
  const changed = new Set();
  if (!SESSIONS_DIR) return { byId, changed };
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return { byId, changed };
  }
  const seen = new Set();
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const p = path.join(SESSIONS_DIR, n);
    const st = statOrNull(p);
    if (!st) continue;
    seen.add(p);
    let c = pidCache.get(p);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      let info = null;
      try {
        const o = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (o && typeof o.sessionId === 'string' && o.spare !== true) {
          info = {
            pid: Number(o.pid),
            sessionId: o.sessionId,
            cwd: typeof o.cwd === 'string' ? o.cwd : '',
            entrypoint: typeof o.entrypoint === 'string' ? o.entrypoint : '',
            status: typeof o.status === 'string' ? o.status : '',
            waitingFor: typeof o.waitingFor === 'string' ? o.waitingFor : '',
            statusUpdatedAt: parseTs(o.statusUpdatedAt),
            updatedAt: parseTs(o.updatedAt),
            name: typeof o.name === 'string' && o.nameSource !== 'derived' ? o.name : '',
          };
        }
      } catch {}
      c = { mtimeMs: st.mtimeMs, size: st.size, info };
      pidCache.set(p, c);
      if (info) changed.add(info.sessionId);
    }
    if (!c.info) continue;
    const info = { ...c.info, alive: isAlive(c.info.pid) };
    const prev = byId.get(info.sessionId);
    if (!prev || (info.alive && !prev.alive) || (info.alive === prev.alive && info.updatedAt > prev.updatedAt)) byId.set(info.sessionId, info);
  }
  if (pidCache.size > seen.size) for (const k of pidCache.keys()) if (!seen.has(k)) pidCache.delete(k);
  return { byId, changed };
}

function sourceOf(entrypoint) {
  const e = String(entrypoint || '').toLowerCase();
  if (!e) return 'unknown';
  if (e.includes('desktop')) return 'desktop';
  if (/vscode|jetbrains|ide|cursor|zed/.test(e)) return 'ide';
  if (/remote|cloud|web|github-action|slack|teams/.test(e)) return 'cloud';
  if (/cli|sdk|local-agent/.test(e)) return 'cli';
  return 'unknown';
}

// --- Subagents -------------------------------------------------------------------------------
function subagentStatus(a, lastAct, meta, f, note, pid, now) {
  if (meta?.data?.finished === true && meta.mtimeMs >= f.mtimeMs - 2000) return { status: 'done' };
  const l = a.last;
  if (l) {
    if (l.kind === 'assistant') {
      if (l.apiError) return { status: 'failed', label: 'Failed (API error)' };
      if (l.block === 'tool_use' && TERMINAL_TOOLS.has(l.toolName || '')) return { status: 'done' };
      if (l.block !== 'tool_use' && isFinalStop(l.stop)) return { status: 'done' };
    } else if (l.kind === 'tool_result' && TERMINAL_TOOLS.has(l.toolName || '')) return { status: 'done' };
    else if (l.kind === 'interrupted') return { status: 'failed', label: 'Stopped' };
  }
  if (note && note.ts >= lastAct - 2000) {
    return note.status === 'completed' ? { status: 'done' } : { status: 'failed', label: note.status === 'failed' ? 'Failed' : 'Stopped' };
  }
  if (pid) {
    if (!pid.alive) return { status: 'failed', label: 'Stopped (session exited)' };
    if (pid.status === 'idle' && pid.statusUpdatedAt > lastAct + 1000) return { status: 'failed', label: 'Stopped' };
  }
  const stale = pid?.alive && pid.status === 'busy' ? SUB_STALE_BUSY_MS : SUB_STALE_MS;
  if (now - lastAct > stale) return { status: 'failed', label: 'Stalled' };
  return { status: 'working' };
}

/**
 * @returns {{subs: import('../contract.mjs').Subagent[], lastAct: number, parses: number}}
 */
function collectSubagents(files, main, pid, now, wall) {
  const turnStart = main.turnStartTs || 0;
  let lastAct = 0;
  let parses = 0;
  /** @type {import('../contract.mjs').Subagent[]} */
  const subs = [];
  const coveredToolUses = new Set();
  const coveredAgents = new Set();

  if (files.length) {
    const recentFrom = now - SUB_RECENT_MS;
    const from = turnStart ? Math.min(turnStart - 5000, recentFrom) : recentFrom;
    let picked = files.filter((f) => f.mtimeMs >= from || agentCache.get(f.path)?.working);
    if (picked.length > MAX_SUB_PARSE) picked = picked.sort((x, y) => y.mtimeMs - x.mtimeMs).slice(0, MAX_SUB_PARSE);

    for (const f of picked) {
      const { entry, parsed } = loadAgent(f, wall);
      if (parsed) parses++;
      const a = entry.a;
      const meta = loadMeta(f.metaPath, wall);
      const md = meta?.data || null;
      const fileAct = a.lastTs || f.mtimeMs;
      if (fileAct > lastAct) lastAct = fileAct;
      const toolUseId = typeof md?.toolUseId === 'string' ? md.toolUseId : '';
      if (toolUseId) coveredToolUses.add(toolUseId);
      coveredAgents.add(f.id);

      const note = main.notes.get(f.id) || (toolUseId ? main.notes.get(toolUseId) : undefined);
      const st = subagentStatus(a, fileAct, meta, f, note, pid, now);
      entry.working = st.status === 'working';
      const startedAt = entry.startedAt || f.birth || a.firstTs || fileAct;
      const endedAt = st.status === 'working' ? undefined : fileAct;

      let include = st.status === 'working';
      if (!include && turnStart) include = startedAt >= turnStart - 5000 || endedAt >= now - SUBAGENT_LINGER_MS;
      if (!include && !turnStart) include = endedAt >= recentFrom;
      if (!include) continue;

      const call = toolUseId ? main.agentCalls.get(toolUseId) : undefined;
      const label = oneLine(md?.description || call?.description || entry.firstPrompt || 'Subagent', 80);
      const agentType = typeof md?.agentType === 'string' ? md.agentType : call?.agentType;
      /** @type {import('../contract.mjs').Subagent} */
      const sub = {
        id: f.id,
        label,
        status: st.status,
        activity: st.status === 'working' ? workingActivity(a, ownTurn(a), now) : act('idle', st.label || 'Done'),
        startedAt,
        lastActivityAt: fileAct,
      };
      if (agentType) sub.agentType = agentType;
      if (endedAt !== undefined) sub.endedAt = endedAt;
      subs.push(sub);
    }
  }

  // Fallback: Agent/Task calls in the parent that have no transcript file of their own
  // (older Claude Code versions, or a file that has not appeared yet). Uses tool_use/tool_result pairing.
  for (const [id, call] of main.agentCalls) {
    if (coveredToolUses.has(id)) continue;
    if (turnStart ? call.ts < turnStart - 5000 : call.ts < now - SUB_RECENT_MS) continue;
    const res = main.results.get(id);
    if (res?.agentId && coveredAgents.has(res.agentId)) continue;
    const note = main.notes.get(id) || (res?.agentId ? main.notes.get(res.agentId) : undefined);
    let status = 'working';
    let endTs = 0;
    if (note) {
      status = note.status === 'completed' ? 'done' : 'failed';
      endTs = note.ts;
    } else if (res) {
      if (res.isError) status = 'failed';
      else if (res.status !== 'async_launched') status = 'done';
      if (status !== 'working') endTs = res.ts;
    }
    const lastTs = endTs || res?.ts || call.ts;
    if (status === 'working') {
      if (pid && !pid.alive) status = 'failed';
      else if (now - Math.max(lastTs, main.lastTs) > SUB_STALE_MS) status = 'failed';
      if (status !== 'working') endTs = lastTs;
    }
    /** @type {import('../contract.mjs').Subagent} */
    const sub = {
      id,
      label: oneLine(call.description || 'Subagent', 80),
      status: /** @type {'working'|'done'|'failed'} */ (status),
      activity: status === 'working' ? act('thinking', 'Working') : act('idle', status === 'done' ? 'Done' : 'Failed'),
      startedAt: call.ts,
      lastActivityAt: lastTs,
    };
    if (call.agentType) sub.agentType = call.agentType;
    if (status !== 'working') sub.endedAt = endTs || lastTs;
    subs.push(sub);
  }

  let out = subs;
  if (out.length > MAX_SUBAGENTS) {
    out = out
      .sort((x, y) => (x.status === 'working' ? 0 : 1) - (y.status === 'working' ? 0 : 1) || y.lastActivityAt - x.lastActivityAt)
      .slice(0, MAX_SUBAGENTS);
  }
  out.sort((x, y) => x.startedAt - y.startedAt || (x.id < y.id ? -1 : 1));
  return { subs: out, lastAct, parses };
}

// --- Session assembly --------------------------------------------------------------------------
function buildSession(f, entry, subInfo, pid, now) {
  const { a, head } = entry;
  const subs = subInfo.subs;
  const working = subs.reduce((n, s) => n + (s.status === 'working' ? 1 : 0), 0);
  const mainAct = a.lastTs || f.mtimeMs;
  const lastActivityAt = Math.max(mainAct, subInfo.lastAct);

  let turn = ownTurn(a);
  let waitingFor = '';
  if (pid) {
    const current = pid.statusUpdatedAt >= mainAct - 250;
    if (!pid.alive) {
      if (turn.state === 'mid') turn = { state: 'unknown', why: 'exited' };
    } else if (current && pid.status === 'waiting') {
      waitingFor = pid.waitingFor || 'input needed';
      turn = { state: 'ended', why: 'blocked' };
    } else if (current && pid.status === 'idle' && turn.state === 'mid') {
      turn = { state: 'ended', why: 'done' };
    } else if (pid.status === 'busy' && turn.why === 'done' && now - mainAct > BUSY_SETTLE_MS) {
      // The process still reports itself busy well after its last reply: background work it delegated
      // (agents or workflows that may not have a transcript yet) has not come back.
      turn = { state: 'mid', why: 'background' };
    }
  }

  /** @type {import('../contract.mjs').TurnState} */
  let turnState = /** @type {any} */ (turn.state);
  /** @type {import('../contract.mjs').Activity} */
  let activity;
  if (turn.why === 'blocked') activity = act('waiting', `Needs you: ${waitingFor}`);
  else if (turn.why === 'background' || (turn.state !== 'mid' && working > 0)) {
    activity = act('delegating', working > 0 ? `Waiting on ${working} subagent${working === 1 ? '' : 's'}` : 'Waiting on background work');
  } else if (turn.state === 'mid') activity = workingActivity(a, turn, now);
  else if (turn.why === 'asking') activity = a.lastToolActivity || act('waiting', 'Asking you a question');
  else if (turn.why === 'interrupted') activity = act('waiting', 'Interrupted');
  else if (turn.why === 'error') activity = act('waiting', 'Stopped on an API error');
  else if (turn.state === 'unknown') activity = act('idle', turn.why === 'exited' ? 'Session exited' : 'Idle');
  else activity = act('waiting', 'Waiting for you');
  if (working > 0) turnState = 'mid'; // background agents still owe output

  // The title record is re-appended every turn, so the tail nearly always has it; the side file is the fallback.
  const named = a.customTitle || loadTitleFile(f.dir) || head.customTitle || pid?.name || a.summary;
  const title = oneLine(named || head.firstPrompt || a.firstPrompt || a.firstAny || a.agentName || 'Claude session', 120);

  const cwdCands = [a.relocatedCwd, pid?.cwd, head.cwd, a.cwd];
  const cwd = cwdCands.find((c) => c && slugify(c) === f.slug) || cwdCands.find(Boolean) || '';

  /** @type {import('../contract.mjs').AdapterSession} */
  const s = {
    tool: 'claude',
    nativeId: f.sid,
    title,
    cwd,
    source: /** @type {any} */ (sourceOf(a.entrypoint || pid?.entrypoint)),
    turnState,
    startedAt: head.startedAt || a.firstTs || f.birth || f.mtimeMs,
    lastActivityAt,
    activity,
    subagents: subs,
  };
  if (a.branch && a.branch !== 'HEAD') s.branch = a.branch;
  if (a.model) s.model = a.model;
  if (a.lastText) s.lastMessage = clipText(a.lastText);
  if (a.tokens) s.tokens = a.tokens;
  return s;
}

function prune(wall) {
  if (wall - lastPrune < 60_000) return;
  lastPrune = wall;
  for (const [k, v] of agentCache) if (wall - v.usedAt > 30 * 60_000 && !v.working) agentCache.delete(k);
  for (const [k, v] of metaCache) if (wall - v.usedAt > 30 * 60_000) metaCache.delete(k);
  for (const k of mainCache.keys()) if (!statOrNull(k)) mainCache.delete(k);
}

/**
 * @param {{now?: number, maxAgeMs?: number}} [opts]
 * @returns {Promise<import('../contract.mjs').AdapterSession[]>}
 */
export async function listSessions({ now, maxAgeMs } = {}) {
  /** @type {import('../contract.mjs').AdapterSession[]} */
  const out = [];
  if (!Number.isFinite(now)) now = Date.now();
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) maxAgeMs = IDLE_MAX_MS;
  try {
    const wall = Date.now();
    const minTs = now - maxAgeMs;
    const { byId: pids, changed } = scanPids();
    const files = scanRoot(wall, minTs - SUB_SCAN_GRACE_MS, changed);
    const seen = new Map();
    let parses = 0;
    for (const f of files) {
      try {
        const subFiles = scanSubagents(f.dir, wall);
        if (f.mtimeMs < minTs && !subFiles.some((x) => x.mtimeMs >= minTs)) continue;
        const { entry, parsed } = loadMain(f);
        if (parsed) parses++;
        const pid = pids.get(f.sid);
        const subInfo = collectSubagents(subFiles, entry.a, pid, now, wall);
        parses += subInfo.parses;
        if (parses >= 6) {
          parses = 0;
          await yieldTick(); // keep the event loop breathing during a cold start
        }
        if (!entry.a.conv && !entry.head.firstPrompt && !subInfo.subs.length) continue; // nothing was ever said
        const s = buildSession(f, entry, subInfo, pid, now);
        if (s.lastActivityAt < minTs) continue;
        const dup = seen.get(s.nativeId);
        if (dup !== undefined) {
          if (out[dup].lastActivityAt >= s.lastActivityAt) continue;
          out[dup] = s;
        } else {
          seen.set(s.nativeId, out.length);
          out.push(s);
        }
      } catch {
        // one bad session never breaks the list
      }
    }
    prune(wall);
  } catch {
    // never throw
  }
  out.sort((x, y) => y.lastActivityAt - x.lastActivityAt);
  return out;
}

// --- Transcript -------------------------------------------------------------------------------
function findSessionFile(sid) {
  const hit = sessionIndex.get(sid);
  if (hit && statOrNull(hit.file)) return hit;
  if (!/^[\w.-]+$/.test(sid)) return null;
  let ents;
  try {
    ents = fs.readdirSync(PROJECTS_ROOT);
  } catch {
    return null;
  }
  let best = null;
  let bestM = -1;
  for (const slug of ents) {
    const file = path.join(PROJECTS_ROOT, slug, `${sid}.jsonl`);
    const st = statOrNull(file);
    if (st && st.mtimeMs > bestM) {
      bestM = st.mtimeMs;
      best = { file, dir: path.join(PROJECTS_ROOT, slug, sid) };
    }
  }
  if (best) sessionIndex.set(sid, best);
  return best;
}

function findAgentFile(sessionDir, agentId) {
  if (!/^[\w.-]+$/.test(agentId)) return null;
  const name = `agent-${agentId}.jsonl`;
  const direct = path.join(sessionDir, 'subagents', name);
  if (statOrNull(direct)) return direct;
  const wfRoot = path.join(sessionDir, 'subagents', 'workflows');
  let runs = [];
  try {
    runs = fs.readdirSync(wfRoot);
  } catch {}
  for (const r of runs) {
    const p = path.join(wfRoot, r, name);
    if (statOrNull(p)) return p;
  }
  return null;
}

const RE_HARNESS_TEXT = /^(Another Claude session sent a message|<agent-message\b|\[Subagent hand-back\]|\[SYSTEM NOTIFICATION|<task-notification>|<system-reminder>\s*\[SYSTEM NOTIFICATION)/;

/** One short line for a harness-written record: "Crew report: …", "Task update: …". */
function harnessSummary(text) {
  const t = String(text || '');
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t);
  if (summary) return `Task update: ${oneLine(summary[1], 160)}`;
  if (/<agent-message\b|Subagent hand-back|Another Claude session sent a message/.test(t)) {
    const body = t
      .replace(/^[\s\S]*?The report follows:\s*/, '')
      .replace(/<\/?agent-message[^>]*>/g, ' ')
      .replace(/\[harness:[^\]]*\]/g, ' ');
    return `Crew report: ${oneLine(body, 220)}`;
  }
  return oneLine(cleanPrompt(t) || t.replace(/<[^>]+>/g, ' '), 200);
}

function toMessages(lines, sidechainFile) {
  /** @type {import('../contract.mjs').Message[]} */
  const msgs = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    if (line.startsWith('{"type":"')) {
      const end = line.indexOf('"', 9);
      if (end > 9 && NOISE_TYPES.has(line.slice(9, end))) continue;
    } else if (RE_ATTACHMENT.test(line)) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object' || (o.type !== 'user' && o.type !== 'assistant')) continue;
    if (!sidechainFile && o.isSidechain) continue;
    const ts = parseTs(o.timestamp);
    const c = o.message?.content;
    if (o.type === 'user') {
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
      if (!text.trim()) continue;
      const kind = classifyUserText(text, o);
      if (kind === 'skip' || kind === 'local') continue;
      // Records the harness writes into the user slot (subagent reports, background-task notices, messages
      // from other sessions) are not something the human said: pass them on as short 'system' lines.
      const originKind = o.origin && typeof o.origin === 'object' ? o.origin.kind : undefined;
      if (kind === 'notification' || (originKind && originKind !== 'human') || RE_HARNESS_TEXT.test(text.trimStart())) {
        const line = harnessSummary(text);
        if (line) msgs.push({ role: 'system', text: line, ts });
        continue;
      }
      const clean = kind === 'interrupted' ? '[Interrupted]' : cleanPrompt(text);
      if (clean) msgs.push({ role: 'user', text: clip(clean, 2000), ts });
    } else {
      if (o.isApiErrorMessage) continue;
      const blocks = Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          msgs.push({ role: 'assistant', text: clip(b.text.trim(), 2000), ts });
        } else if (b.type === 'tool_use') {
          const name = String(b.name || 'Tool');
          msgs.push({ role: 'tool', text: clip(toolSummary(name, b.input), 2000), ts, toolName: name });
        }
      }
    }
  }
  return msgs;
}

/**
 * Most recent `limit` messages, oldest first. `nativeId` may be `<sessionId>#<subagentId>` for a subagent's own log.
 * @param {string} nativeId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<import('../contract.mjs').Message[]>}
 */
export async function getTranscript(nativeId, { limit = 60 } = {}) {
  try {
    const n = Math.max(1, Math.min(1000, Number(limit) || 60));
    const [sid, agentId] = String(nativeId ?? '').split('#');
    const loc = findSessionFile(sid);
    let file = loc?.file;
    if (agentId) file = loc ? findAgentFile(loc.dir, agentId) : null;
    if (!file) return [];
    const st = statOrNull(file);
    if (!st) return [];
    let bytes = TRANSCRIPT_TAIL_BYTES;
    for (;;) {
      const t = readTailLines(file, st.size, bytes);
      const msgs = toMessages(t.lines, !!agentId);
      if (msgs.length >= n || t.fromStart || bytes >= TRANSCRIPT_TAIL_MAX_BYTES) return msgs.slice(-n);
      bytes *= 2;
      await yieldTick();
    }
  } catch {
    return [];
  }
}

// --- node server/adapters/claude.mjs ----------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? Number(process.argv[i + 1]) : dflt;
  };
  const maxAgeMs = arg('--max-age-min', IDLE_MAX_MS / 60_000) * 60_000;
  const ms = (t) => `${t.toFixed(1)}ms`;
  const t0 = performance.now();
  const cold = await listSessions({ now: Date.now(), maxAgeMs });
  const t1 = performance.now();
  const warmTimes = [];
  let sessions = cold;
  for (let k = 0; k < 5; k++) {
    const w0 = performance.now();
    sessions = await listSessions({ now: Date.now(), maxAgeMs });
    warmTimes.push(performance.now() - w0);
  }
  const now = Date.now();
  const ago = (t) => {
    const s = Math.max(0, Math.round((now - t) / 1000));
    return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
  };
  console.log(`claude adapter  root=${PROJECTS_ROOT}`);
  console.log(`${sessions.length} session(s) within ${Math.round(maxAgeMs / 60_000)} min   cold ${ms(t1 - t0)}   warm ${warmTimes.map(ms).join(' ')}`);
  for (const s of sessions) {
    const counts = {};
    for (const a of s.subagents) counts[a.status] = (counts[a.status] || 0) + 1;
    const subTxt = s.subagents.length ? `${s.subagents.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})` : '0';
    console.log(
      `\n${s.nativeId.slice(0, 8)}  ${s.turnState.padEnd(7)} ${String(s.source).padEnd(7)} last ${ago(s.lastActivityAt).padStart(5)} ago  ${JSON.stringify(oneLine(s.title, 60))}` +
        `\n          ${s.activity.kind}: ${s.activity.label}   subagents: ${subTxt}   cwd: ${base(s.cwd)}${s.branch ? '@' + s.branch : ''}   model: ${s.model || '-'}   tokens: ${s.tokens ?? '-'}`,
    );
    for (const a of s.subagents) {
      console.log(`            - ${a.id.slice(0, 9)} ${a.status.padEnd(7)} ${String(a.agentType || '').padEnd(16)} ${JSON.stringify(a.label)}  [${a.activity.kind}: ${a.activity.label}] last ${ago(a.lastActivityAt)} ago`);
    }
  }
  if (sessions[0]) {
    const g0 = performance.now();
    const msgs = await getTranscript(sessions[0].nativeId, { limit: 60 });
    const roles = {};
    for (const m of msgs) roles[m.role] = (roles[m.role] || 0) + 1;
    console.log(`\ngetTranscript(${sessions[0].nativeId.slice(0, 8)}, 60): ${msgs.length} messages ${JSON.stringify(roles)} in ${ms(performance.now() - g0)}`);
  }
}
