// OpenAI Codex adapter for Agent Office.
//
// Reads the "rollout" JSONL logs Codex (CLI, `codex exec`, and the Codex desktop app-server) writes under
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local timestamp>-<thread uuid>.jsonl
// plus $CODEX_HOME/session_index.jsonl (thread names). Strictly read-only; no sqlite is opened.
//
// On-disk facts this relies on (Codex 0.157 - 0.167):
//   * every line is {timestamp: ISO, ordinal: n, type, payload}; key order is stable, so a regex on the first
//     few hundred chars tells us the record type without JSON.parse-ing multi-megabyte lines.
//   * line 0 is `session_meta`: {id, session_id (root thread), cwd, originator, source, thread_source, git:{branch},
//     timestamp, parent_thread_id?, forked_from_id?, subagent_history_start_ordinal?, agent_path?, agent_nickname?}.
//     `source` is "vscode" | "exec" | "cli" for user threads (the desktop app also says "vscode", so `originator`
//     decides cli/desktop/ide), and an object for spawned threads:
//       {"subagent":{"thread_spawn":{parent_thread_id, depth, agent_path, agent_nickname, agent_role}}}  <- a real subagent
//       {"subagent":{"other":"guardian"}}                                                              <- auto-review helper, hidden
//   * a spawned child is its own rollout file. When forked it starts with a COPY of the parent's history
//     (ordinals < subagent_history_start_ordinal, including the parent's session_meta on line 1) - ignored here.
//   * turn lifecycle: event_msg/task_started ... event_msg/task_complete | event_msg/turn_aborted.
//     Late `item_completed` records can trail a task_complete, so only lifecycle events decide turnState.
//   * work items: event_msg/item_completed {item:{type: UserMessage|AgentMessage|Reasoning|CommandExecution|
//     FileChange|McpToolCall|Extension|SubAgentActivity|CollabAgentToolCall|ImageView|...}} and the raw
//     response_item/{message,reasoning,function_call,custom_tool_call,*_output}. The model drives tools through one
//     custom tool `exec` whose input is JS calling tools.exec_command / tools.apply_patch / tools.mcp__* / ...
//   * tokens: event_msg/token_count {info:{total_token_usage:{total_tokens}}}; model: turn_context.model.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MID_TURN_MAX_MS, clipText, oneLine } from '../contract.mjs';

export const tool = 'codex';

// --- tunables ---------------------------------------------------------------
const META_BYTES = 64 * 1024; // first read for the session_meta line (~20 KB in practice)
const META_BYTES_MAX = 1024 * 1024;
const HEAD_CHUNK = 256 * 1024; // one-time scan for the first user prompt + model
const HEAD_SCAN_MAX = 2 * 1024 * 1024;
const TAIL_BYTES = 384 * 1024; // cold read of a file's tail
const TAIL_BYTES_MAX = 8 * 1024 * 1024; // only grown when the tail holds no complete line (huge compaction records)
const MAX_INCREMENT = 1024 * 1024; // appended more than this since the last poll -> jump to the tail
const PARSE_LINE_MAX = 512 * 1024; // never JSON.parse a line longer than this
const TRANSCRIPT_BYTES = 1024 * 1024;
const TRANSCRIPT_BYTES_MAX = 4 * 1024 * 1024;
const FULL_SCAN_MS = 10_000; // re-stat every rollout in the scan window this often (catches resumed old sessions)
const SCAN_DAYS = 60; // day folders older than this are never looked at
const DAY_MS = 86_400_000;

// --- state ------------------------------------------------------------------
let codexHome = process.env.AGENT_OFFICE_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/** @type {Map<string, any>} path -> file entry */
let files = new Map();
/** @type {Map<string, any>} thread id -> file entry */
let byId = new Map();
let lastFullScan = -Infinity;
let nameIndex = { key: '', offset: 0, names: new Map() };

/** Point the adapter at a different Codex home (tests). Clears every cache. */
export function setCodexHome(dir) {
  codexHome = dir;
  resetCache();
}
export function getCodexHome() {
  return codexHome;
}
export function resetCache() {
  files = new Map();
  byId = new Map();
  lastFullScan = -Infinity;
  nameIndex = { key: '', offset: 0, names: new Map() };
}

// --- small helpers ----------------------------------------------------------
const ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SNIFF_RE = /^\{"timestamp":"([^"]+)"(?:,"ordinal":(\d+))?,"type":"([a-z_]+)"(?:,"payload":\{(?:"type":"([a-z_]+)")?)?/;
const ROLE_RE = /"role":"([a-z]+)"/;
const SKIP_TYPES = new Set(['session_meta', 'compacted', 'world_state', 'token_usage_record', 'inter_agent_communication_metadata']);
const WRAPPER_RE = /^\s*(?:<[a-zA-Z_][\w-]*[\s>]|# AGENTS\.md instructions|#+ Codex desktop context|# Files (?:mentioned|pasted) by the user|# Context from my IDE)/;
const REQUEST_RE = /^## My request[^\n]*\n/m; // desktop/IDE prompts with attachments: "<context>... ## My request for Codex:\n<prompt>"

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
function statSafe(p) {
  try {
    return fs.statSync(p, { throwIfNoEntry: false }) || null;
  } catch {
    return null;
  }
}
function readAt(fd, start, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}
const pad2 = (n) => String(n).padStart(2, '0');
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`; // folders use local time
}
function baseName(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
function humanize(agentPath) {
  const rel = String(agentPath ?? '').replace(/^\/?root\/?/, '');
  return rel.replace(/[_-]+/g, ' ').replace(/\//g, ' / ').trim();
}
function act(kind, label) {
  return { kind, label: oneLine(label, 60) };
}
const THINKING = act('thinking', 'Thinking');
const WRITING = act('writing', 'Writing');

/** The human's own words out of a message content array / string: wrapper blocks (environment, AGENTS.md, ...) dropped. */
function realText(content) {
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content : [];
  for (const part of parts) {
    let t = typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '';
    const req = REQUEST_RE.exec(t);
    if (req) t = t.slice(req.index + req[0].length);
    else if (WRAPPER_RE.test(t)) continue;
    t = t.replace(/^(?:&#x20;|\s)+/, '').trim();
    if (t) return t;
  }
  return '';
}
/** Transcript flavour of realText: a prompt that is only attachments still shows up. */
function userText(content) {
  const t = realText(content);
  if (t || !Array.isArray(content)) return t;
  const attached = content.some((part) => part && typeof part === 'object' && (/image|file/i.test(String(part.type ?? '')) || REQUEST_RE.test(String(part.text ?? ''))));
  return attached ? '(attachment)' : '';
}
function allText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Collapse a shell command to something short with basenames instead of full paths. */
function shortCmd(cmd, n = 40) {
  let c = String(cmd ?? '').replace(/\s+/g, ' ').trim();
  c = c.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  c = c.replace(/(?<=^|[\s"'=(])(?:~|\.{1,2})?(?:\/[\w.@%+=-]+){2,}\/?/g, (p) => baseName(p));
  return c.length > n ? c.slice(0, n) : c;
}
function shellCommandOf(command) {
  if (Array.isArray(command)) {
    const i = command.findIndex((a) => a === '-lc' || a === '-c');
    return String(i >= 0 && command[i + 1] != null ? command[i + 1] : command.join(' '));
  }
  return String(command ?? '');
}
function classifyShell(cmd) {
  const c = String(cmd ?? '').replace(/\s+/g, ' ').trim().replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  const first = baseName(c.split(' ')[0] || '');
  if (!/&&|;|\|\|/.test(c)) {
    if (/^(?:rg|grep|ag|ack|fd|find)$/.test(first)) return act('searching', `Search: ${shortCmd(c)}`);
    if (/^(?:cat|head|tail|nl|bat|less|more)$/.test(first) || (first === 'sed' && / -n /.test(c))) {
      const target = c
        .split('|')[0]
        .split(' ')
        .slice(1)
        .filter((a) => a && !a.startsWith('-') && /[\w.]/.test(a) && !/^['"]?\d+(?:,\d+)?p?['"]?$/.test(a))
        .pop();
      if (target) return act('reading', `Read ${baseName(target.replace(/['"]/g, ''))}`);
    }
  }
  return act('running', `Bash: ${shortCmd(c)}`);
}
function editLabel(paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return act('editing', 'Editing files');
  return act('editing', `Edit ${baseName(list[0])}${list.length > 1 ? ` +${list.length - 1}` : ''}`);
}
function patchPaths(text) {
  const out = [];
  const re = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\"'`]+)/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) && out.length < 20) out.push(m[1].trim());
  return out;
}
function mcpActivity(server, toolName, readOnly) {
  const srv = String(server ?? 'mcp');
  if (/cua|browser|playwright|chrome|computer/i.test(srv)) return act('browsing', `Computer use: ${toolName ?? ''}`);
  return act(readOnly ? 'reading' : 'running', `${srv}: ${toolName ?? ''}`);
}
function jsString(lit) {
  if (!lit) return '';
  if (lit[0] === '"') {
    try {
      return JSON.parse(lit);
    } catch {
      /* fall through */
    }
  }
  return lit.slice(1, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
}

/** Activity for the code-mode `exec` custom tool: its input is JS calling tools.<name>(...). */
function execActivity(input) {
  const src = String(input ?? '');
  if (src.includes('tools.apply_patch') || src.includes('*** Begin Patch')) return editLabel(patchPaths(src));
  const cmd = /tools\.exec_command\(\s*\{[^}]{0,120}?\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(src);
  if (cmd) return classifyShell(jsString(cmd[1]));
  if (src.includes('tools.exec_command')) return act('running', 'Bash: script');
  if (src.includes('tools.web__run')) {
    const q = /\bq\s*:\s*("(?:[^"\\]|\\.)*")/.exec(src);
    return act('searching', q ? `Web: ${oneLine(jsString(q[1]), 40)}` : 'Web search');
  }
  const mcp = /tools\.mcp__([A-Za-z0-9-]+?)__([A-Za-z0-9_]+)\s*\(/.exec(src);
  if (mcp) return mcpActivity(mcp[1], mcp[2], false);
  if (src.includes('tools.view_image')) return act('reading', 'View image');
  if (src.includes('tools.request_permissions')) return act('waiting', 'Requesting permission');
  if (src.includes('tools.write_stdin')) return act('running', 'Bash: (interactive)');
  return act('running', 'Running script');
}

/** Activity for a response_item function_call / custom_tool_call / local_shell_call. null = keep the current one. */
function callActivity(p, isChild) {
  const name = String(p.name ?? '');
  const ns = String(p.namespace ?? '');
  if (p.type === 'custom_tool_call') {
    if (name === 'apply_patch') return editLabel(patchPaths(p.input));
    return execActivity(p.input);
  }
  if (p.type === 'local_shell_call') return classifyShell(shellCommandOf(p.action?.command));
  if (p.type === 'web_search_call') return act('searching', p.action?.query ? `Web: ${oneLine(p.action.query, 40)}` : 'Web search');
  let args = {};
  if (typeof p.arguments === 'string' && p.arguments.length < 200_000) {
    try {
      args = JSON.parse(p.arguments) ?? {};
    } catch {
      args = {};
    }
  }
  if (ns === 'collaboration' || /^(?:spawn_agent|send_input|send_message|followup_task|wait_agent|close_agent|resume_agent|list_agents)$/.test(name)) {
    if (name === 'spawn_agent') return act('delegating', `Spawn agent: ${humanize(args.task_name ?? args.agent_type ?? '') || 'subagent'}`);
    if (name === 'wait_agent') return act('delegating', 'Waiting on agents');
    if (name === 'send_message' || name === 'followup_task' || name === 'send_input') {
      const target = String(args.target ?? args.id ?? '');
      if (isChild && (target === '/root' || target === 'root')) return act('writing', 'Reporting to lead');
      return act('delegating', `Message ${humanize(baseName(target)) || 'agent'}`);
    }
    return act('delegating', 'Coordinating agents');
  }
  if (name === 'wait' && args && ('cell_id' in args || !Object.keys(args).length)) return null; // still waiting on a running exec cell
  if (name === 'wait') return act('delegating', 'Waiting on agents');
  if (ns === 'clock' || name === 'sleep') return act('running', args.duration_ms ? `Sleep ${Math.round(args.duration_ms / 1000)}s` : 'Sleeping');
  if (name === 'request_user_input_async' || name === 'request_user_input') return act('waiting', 'Asking a question');
  if (name === 'request_permissions') return act('waiting', 'Requesting permission');
  if (ns.startsWith('mcp__')) {
    const server = ns.slice(5);
    if (typeof args.title === 'string' && args.title) return act(/cua|browser|computer/i.test(server) ? 'browsing' : 'running', `${/cua/i.test(server) ? 'Computer use' : server}: ${args.title}`);
    return mcpActivity(server, name, false);
  }
  if (name.startsWith('mcp__')) {
    const [, server, t] = name.split('__');
    return mcpActivity(server, t, false);
  }
  if (/^(?:shell|shell_command|exec_command|local_shell|container\.exec|unified_exec)$/.test(name)) {
    return classifyShell(shellCommandOf(args.command ?? args.cmd));
  }
  if (name === 'write_stdin') return act('running', 'Bash: (interactive)');
  if (name === 'apply_patch') return editLabel(patchPaths(args.input ?? args.patch ?? p.arguments));
  if (name === 'update_plan') return act('thinking', 'Updating plan');
  if (name === 'view_image') return act('reading', `View image ${baseName(args.path ?? '')}`);
  if (/web_search|web__run/.test(name)) return act('searching', 'Web search');
  return act('running', name || 'Tool call');
}

/** Activity for an event_msg/item_completed item. null = no change. */
function itemActivity(item, isChild) {
  switch (item?.type) {
    case 'Reasoning':
      return THINKING;
    case 'AgentMessage':
      return Array.isArray(item.questions) && item.questions.length ? act('waiting', 'Asking a question') : WRITING;
    case 'UserMessage':
      return THINKING;
    case 'CommandExecution': {
      const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
      const first = parsed[0];
      if (first && parsed.every((c) => c && c.type !== 'unknown')) {
        if (first.type === 'read') return act('reading', `Read ${first.name || baseName(first.path)}${parsed.length > 1 ? ` +${parsed.length - 1}` : ''}`);
        if (first.type === 'search') return act('searching', `Search ${oneLine(first.query ?? baseName(first.path) ?? '', 40)}`);
        if (first.type === 'list_files') return act('reading', `List ${baseName(first.path) || 'files'}`);
      }
      return act('running', `Bash: ${shortCmd(first?.cmd ?? shellCommandOf(item.command))}`);
    }
    case 'FileChange':
      return editLabel(Object.keys(item.changes ?? {}));
    case 'McpToolCall': {
      const t = String(item.tool ?? '');
      if (item.appName) return act(item.readOnlyHint ? 'reading' : 'running', `${item.appName}: ${t.includes('.') ? t.slice(t.indexOf('.') + 1) : t}`);
      return mcpActivity(item.server, t, item.readOnlyHint);
    }
    case 'Extension': {
      const kind = String(item.kind ?? '');
      if (kind === 'web.search') {
        const a = item.action ?? {};
        if (a.type === 'search') return act('searching', `Web: ${oneLine(a.query ?? a.queries?.[0] ?? 'search', 40)}`);
        let host = '';
        try {
          host = a.url ? new URL(a.url).hostname : '';
        } catch {
          host = '';
        }
        return act('browsing', host ? `Open ${host}` : 'Browsing the web');
      }
      if (kind === 'clock.sleep') return act('running', item.durationMs ? `Sleep ${Math.round(item.durationMs / 1000)}s` : 'Sleeping');
      return act('running', kind || 'Extension');
    }
    case 'SubAgentActivity': {
      const target = String(item.agent_path ?? '');
      if (isChild && target === '/root') return act('writing', 'Reporting to lead');
      const who = humanize(baseName(target)) || 'agent';
      if (item.kind === 'started') return act('delegating', `Agent started: ${who}`);
      if (item.kind === 'completed') return act('delegating', `Agent finished: ${who}`);
      return act('delegating', `Message ${who}`);
    }
    case 'CollabAgentToolCall':
      return act('delegating', item.tool === 'wait' ? 'Waiting on agents' : 'Coordinating agents');
    case 'ImageView':
      return act('reading', `View image ${baseName(item.path ?? '')}`);
    case 'ContextCompaction':
      return act('thinking', 'Compacting context');
    default:
      return null;
  }
}

function mapSource(originator, source) {
  const o = String(originator ?? '').toLowerCase();
  if (o.includes('desktop')) return 'desktop';
  if (/vscode|cursor|windsurf|jetbrains|xcode|zed|\bide\b/.test(o)) return 'ide';
  if (/tui|cli|exec/.test(o)) return 'cli';
  if (/cloud|web/.test(o)) return 'cloud';
  const s = typeof source === 'string' ? source.toLowerCase() : '';
  if (s === 'cli' || s === 'exec') return 'cli';
  if (s === 'vscode') return 'ide';
  if (s === 'cloud') return 'cloud';
  return 'unknown';
}

// --- directory scan ---------------------------------------------------------
function newEntry(p, name) {
  const m = ID_RE.exec(name);
  return {
    path: p,
    id: m ? m[1].toLowerCase() : name,
    mtimeMs: 0,
    size: 0,
    key: '', // mtime:size at the last parse
    meta: null,
    head: { done: false, offset: 0, skipPartial: false, title: '', model: '' },
    tail: { offset: -1, s: newTailState() },
  };
}
function newTailState() {
  return {
    turnState: 'unknown',
    turnStartTs: 0,
    firstTs: 0, // first record seen in the cold tail window (the turn in progress started at or before this)
    endedAt: 0,
    failed: false,
    aborted: false,
    activity: null,
    lastMessage: '',
    lastUser: '',
    tokens: 0,
    model: '',
    lastTs: 0,
  };
}
function dropEntry(p, e) {
  files.delete(p);
  if (byId.get(e.id) === e) byId.delete(e.id);
  if (e.meta && byId.get(e.meta.id) === e) byId.delete(e.meta.id);
}
function scanDir(dir, seen, statKnown) {
  for (const name of readdirSafe(dir)) {
    if (!name.endsWith('.jsonl') || !name.startsWith('rollout-')) continue;
    const p = path.join(dir, name);
    let e = files.get(p);
    if (e && !statKnown) continue;
    const st = statSafe(p);
    if (!st || !st.isFile()) continue;
    if (!e) {
      e = newEntry(p, name);
      files.set(p, e);
      byId.set(e.id, e);
    }
    e.mtimeMs = st.mtimeMs;
    e.size = st.size;
    if (seen) seen.add(p);
  }
}
function fullScan(wall) {
  const root = path.join(codexHome, 'sessions');
  const min = dayKey(wall - SCAN_DAYS * DAY_MS);
  const seen = new Set();
  for (const y of readdirSafe(root)) {
    if (!/^\d{4}$/.test(y) || y < min.slice(0, 4)) continue;
    for (const m of readdirSafe(path.join(root, y))) {
      if (!/^\d{2}$/.test(m) || `${y}/${m}` < min.slice(0, 7)) continue;
      for (const d of readdirSafe(path.join(root, y, m))) {
        if (!/^\d{2}$/.test(d) || `${y}/${m}/${d}` < min) continue;
        scanDir(path.join(root, y, m, d), seen, true);
      }
    }
  }
  for (const [p, e] of files) if (!seen.has(p)) dropEntry(p, e);
  lastFullScan = wall;
}
/** Between full scans: new + resumed files in the current day folders, and a re-stat of everything recently active. */
function quickScan(wall, cutoff) {
  const root = path.join(codexHome, 'sessions');
  const seen = new Set();
  for (const off of [-1, 0, 1]) scanDir(path.join(root, dayKey(wall + off * DAY_MS)), seen, true);
  for (const [p, e] of files) {
    if (e.mtimeMs < cutoff - 60_000 || seen.has(p)) continue;
    const st = statSafe(p);
    if (!st) {
      dropEntry(p, e);
      continue;
    }
    e.mtimeMs = st.mtimeMs;
    e.size = st.size;
  }
}
function scan(cutoff) {
  const wall = Date.now();
  if (wall - lastFullScan >= FULL_SCAN_MS) fullScan(wall);
  else quickScan(wall, cutoff);
}

// --- session_index.jsonl (thread names) -------------------------------------
function loadNames() {
  const p = path.join(codexHome, 'session_index.jsonl');
  const st = statSafe(p);
  if (!st) return nameIndex.names;
  const key = `${st.mtimeMs}:${st.size}`;
  if (key === nameIndex.key) return nameIndex.names;
  try {
    let start = nameIndex.offset;
    if (st.size < start) {
      start = 0;
      nameIndex.names = new Map();
    }
    const fd = fs.openSync(p, 'r');
    let buf;
    try {
      buf = readAt(fd, start, Math.min(st.size - start, 16 * 1024 * 1024));
    } finally {
      fs.closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(10);
    if (lastNl >= 0) {
      for (const line of buf.toString('utf8', 0, lastNl).split('\n')) {
        if (line.length < 10) continue;
        try {
          const r = JSON.parse(line);
          if (r && typeof r.id === 'string' && typeof r.thread_name === 'string') nameIndex.names.set(r.id, r.thread_name);
        } catch {
          /* skip malformed line */
        }
      }
      nameIndex.offset = start + lastNl + 1;
    }
  } catch {
    /* unreadable index: keep what we have */
  }
  nameIndex.key = key;
  return nameIndex.names;
}

// --- per-file parsing -------------------------------------------------------
function readMeta(fd, e) {
  let buf = readAt(fd, 0, Math.min(META_BYTES, e.size));
  let nl = buf.indexOf(10);
  if (nl < 0 && e.size > META_BYTES) {
    buf = readAt(fd, 0, Math.min(META_BYTES_MAX, e.size));
    nl = buf.indexOf(10);
  }
  if (nl < 0) nl = buf.length; // maybe a single line without newline yet
  let rec;
  try {
    rec = JSON.parse(buf.toString('utf8', 0, nl));
  } catch {
    return;
  }
  const p = rec && rec.type === 'session_meta' ? rec.payload : rec && typeof rec.id === 'string' && rec.cwd !== undefined ? rec : null;
  if (!p || typeof p !== 'object') return;
  const src = p.source;
  const sub = src && typeof src === 'object' ? src.subagent : null;
  const spawn = sub && typeof sub === 'object' && sub.thread_spawn && typeof sub.thread_spawn === 'object' ? sub.thread_spawn : null;
  const kind = spawn ? 'spawn' : sub || p.thread_source === 'guardian_review' ? 'internal' : 'user';
  const id = typeof p.id === 'string' ? p.id : e.id;
  e.meta = {
    id,
    kind,
    rootId: typeof p.session_id === 'string' ? p.session_id : '',
    parentId: (spawn && spawn.parent_thread_id) || p.parent_thread_id || (kind !== 'user' ? p.forked_from_id : '') || '',
    cwd: typeof p.cwd === 'string' ? p.cwd : '',
    branch: p.git && typeof p.git.branch === 'string' ? p.git.branch : '',
    source: mapSource(p.originator, src),
    startedAt: Date.parse(p.timestamp ?? rec.timestamp ?? '') || 0,
    startOrdinal: Number.isFinite(p.subagent_history_start_ordinal) ? p.subagent_history_start_ordinal : 0,
    agentPath: (spawn && spawn.agent_path) || p.agent_path || '',
    agentRole: (spawn && spawn.agent_role) || p.agent_role || '',
  };
  if (id !== e.id && !byId.has(id)) byId.set(id, e);
}

function headLine(e, line) {
  const h = e.head;
  if (line.length < 2) return;
  const m = SNIFF_RE.exec(line.length > 400 ? line.slice(0, 400) : line);
  if (!m || line.length > PARSE_LINE_MAX) return;
  const type = m[3];
  const pt = m[4];
  let want = false;
  if (type === 'turn_context') want = !h.model;
  else if (type === 'event_msg') want = (pt === 'item_completed' && line.includes('"UserMessage"')) || pt === 'user_message';
  else if (type === 'response_item' && pt === 'message') want = ROLE_RE.exec(line.slice(0, 400))?.[1] === 'user';
  if (!want) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  const p = rec.payload ?? {};
  if (type === 'turn_context') {
    if (typeof p.model === 'string') h.model = p.model;
  } else if (pt === 'item_completed') {
    if (p.item?.type === 'UserMessage') h.title = realText(p.item.content);
  } else if (pt === 'user_message') {
    h.title = realText(p.message);
  } else {
    h.title = realText(p.content);
  }
}
/** One-time bounded scan from the start of the file for the first real user prompt and the model. */
function headScan(fd, e) {
  const h = e.head;
  while (!h.done) {
    if (h.offset >= HEAD_SCAN_MAX) {
      h.done = true;
      break;
    }
    const want = Math.min(HEAD_CHUNK, HEAD_SCAN_MAX - h.offset, e.size - h.offset);
    if (want <= 0) break; // nothing more yet; retried when the file grows
    const buf = readAt(fd, h.offset, want);
    const lastNl = buf.lastIndexOf(10);
    if (lastNl < 0) {
      if (h.offset + buf.length >= HEAD_SCAN_MAX) h.done = true; // ran into the bound inside one huge line
      if (h.done || h.offset + buf.length >= e.size) break; // or: partial last line, wait for more
      h.offset += buf.length; // a line longer than the chunk: step over it
      h.skipPartial = true;
      continue;
    }
    const lines = buf.toString('utf8', 0, lastNl).split('\n');
    if (h.skipPartial) {
      lines.shift();
      h.skipPartial = false;
    }
    for (const line of lines) {
      headLine(e, line);
      if (h.title) break;
    }
    h.offset += lastNl + 1;
    if (h.title) h.done = true;
  }
}

function live(s) {
  if (s.turnState === 'ended') return false;
  if (s.turnState === 'unknown') s.turnState = 'mid'; // activity seen, but the task_started is before our window
  return true;
}
function applyRecord(s, rec, meta) {
  if (!rec || typeof rec !== 'object') return;
  if (meta.startOrdinal && typeof rec.ordinal === 'number' && rec.ordinal < meta.startOrdinal) return;
  const ts = Date.parse(rec.timestamp ?? '') || 0;
  if (ts > s.lastTs) s.lastTs = ts;
  if (!s.firstTs) s.firstTs = ts;
  const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
  const isChild = meta.kind === 'spawn';
  if (rec.type === 'turn_context') {
    if (typeof p.model === 'string') s.model = p.model;
    return;
  }
  if (rec.type === 'event_msg') {
    switch (p.type) {
      case 'task_started':
      case 'turn_started':
        s.turnState = 'mid';
        s.turnStartTs = ts;
        s.endedAt = 0;
        s.failed = false;
        s.aborted = false;
        s.activity = THINKING;
        return;
      case 'task_complete':
      case 'turn_complete':
        s.turnState = 'ended';
        s.endedAt = ts;
        s.failed = !!p.error;
        s.aborted = false;
        if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) s.lastMessage = p.last_agent_message;
        return;
      case 'turn_aborted':
        s.turnState = 'ended';
        s.endedAt = ts;
        s.aborted = true;
        return;
      case 'token_count': {
        const total = p.info?.total_token_usage?.total_tokens;
        if (typeof total === 'number' && total > 0) s.tokens = total;
        return;
      }
      case 'thread_settings_applied':
        if (typeof p.thread_settings?.model === 'string') s.model = p.thread_settings.model;
        return;
      case 'item_completed':
      case 'item_started': {
        const item = p.item;
        if (!item || typeof item !== 'object') return;
        if (item.type === 'AgentMessage') {
          const t = allText(item.content).trim();
          if (t) s.lastMessage = t;
        } else if (item.type === 'UserMessage') {
          const t = realText(item.content);
          if (t) s.lastUser = t;
        }
        if (!live(s)) return;
        const a = itemActivity(item, isChild);
        if (a) s.activity = a;
        return;
      }
      // older Codex event names
      case 'user_message': {
        const t = realText(p.message);
        if (t) s.lastUser = t;
        if (live(s)) s.activity = THINKING;
        return;
      }
      case 'agent_message':
        if (typeof p.message === 'string' && p.message.trim()) s.lastMessage = p.message;
        if (live(s)) s.activity = WRITING;
        return;
      case 'agent_reasoning':
      case 'agent_reasoning_raw_content':
        if (live(s)) s.activity = THINKING;
        return;
      case 'exec_command_begin':
        if (live(s)) s.activity = classifyShell(shellCommandOf(p.command));
        return;
      case 'patch_apply_begin':
        if (live(s)) s.activity = editLabel(Object.keys(p.changes ?? {}));
        return;
      case 'web_search_begin':
      case 'web_search_end':
        if (live(s)) s.activity = act('searching', p.query ? `Web: ${oneLine(p.query, 40)}` : 'Web search');
        return;
      case 'mcp_tool_call_begin':
        if (live(s)) s.activity = mcpActivity(p.invocation?.server, p.invocation?.tool, false);
        return;
      default:
        return;
    }
  }
  if (rec.type === 'response_item') {
    switch (p.type) {
      case 'message': {
        if (p.role === 'assistant') {
          const t = allText(p.content).trim();
          if (t) s.lastMessage = t;
          if (live(s)) s.activity = WRITING;
        } else if (p.role === 'user') {
          const t = realText(p.content);
          if (t) {
            s.lastUser = t;
            if (live(s)) s.activity = THINKING;
          }
        }
        return;
      }
      case 'reasoning':
        if (live(s)) s.activity = THINKING;
        return;
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'web_search_call': {
        if (!live(s)) return;
        const a = callActivity(p, isChild);
        if (a) s.activity = a;
        else if (!s.activity) s.activity = act('running', 'Bash: (waiting on command)');
        return;
      }
      default:
        if (typeof p.type === 'string' && p.type.endsWith('_output')) live(s);
        return;
    }
  }
}
/** Sniff the line's type from its prefix; only JSON.parse the ones that matter and are not huge. */
function applyLine(s, line, meta) {
  if (line.length < 2) return;
  const m = SNIFF_RE.exec(line.length > 400 ? line.slice(0, 400) : line);
  if (m) {
    if (meta.startOrdinal && m[2] !== undefined && Number(m[2]) < meta.startOrdinal) return;
    const type = m[3];
    const pt = m[4];
    if (SKIP_TYPES.has(type)) return;
    let cheap = false;
    if (type === 'response_item') {
      if (pt === 'reasoning') {
        if (live(s)) s.activity = THINKING;
        cheap = true;
      } else if (pt === 'additional_tools' || pt === 'compaction' || (pt && pt.endsWith('_output'))) {
        if (pt.endsWith('_output')) live(s);
        cheap = true;
      } else if (pt === 'message') {
        const role = ROLE_RE.exec(line.slice(0, 400))?.[1];
        if (role === 'developer' || role === 'system') return;
      }
    }
    if (cheap || line.length > PARSE_LINE_MAX) {
      const ts = Date.parse(m[1]) || 0;
      if (ts > s.lastTs) s.lastTs = ts;
      if (!s.firstTs) s.firstTs = ts;
      return;
    }
  } else if (line.length > PARSE_LINE_MAX) {
    return;
  }
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  applyRecord(s, rec, meta);
}

/**
 * Bounded slice of complete lines from [start, size). When `dropPartial`, the read begins one byte early so a
 * slice that starts exactly on a line boundary keeps its first line and one that starts mid-line drops it.
 * Returns {lines, end} where `end` is the byte offset just past the last complete line, or null if none.
 */
function readLines(fd, start, size, dropPartial) {
  const from = dropPartial && start > 0 ? start - 1 : start;
  const buf = readAt(fd, from, size - from);
  let first = 0;
  if (dropPartial && start > 0) {
    const nl = buf.indexOf(10);
    if (nl < 0) return null;
    first = nl + 1;
  }
  const lastNl = buf.lastIndexOf(10);
  let lines = [];
  let end = from + first;
  if (lastNl >= first) {
    lines = buf.toString('utf8', first, lastNl).split('\n');
    end = from + lastNl + 1;
  }
  // A final line with no newline yet: use it only if it is already complete JSON, else leave it for next time.
  const restLen = buf.length - (end - from);
  let rest = null;
  if (restLen > 1 && restLen <= PARSE_LINE_MAX && buf[buf.length - 1] === 0x7d) {
    const text = buf.toString('utf8', end - from);
    try {
      JSON.parse(text);
      rest = text;
    } catch {
      rest = null;
    }
  }
  if (rest !== null) {
    lines.push(rest);
    end = from + buf.length;
  }
  if (!lines.length) return null;
  return { lines, end };
}
function readTail(fd, e) {
  const t = e.tail;
  let start = t.offset;
  let jump = false;
  if (start < 0 || e.size < start) {
    t.s = newTailState();
    start = Math.max(0, e.size - TAIL_BYTES);
    jump = true;
  } else if (e.size - start > MAX_INCREMENT) {
    start = e.size - TAIL_BYTES;
    jump = true;
  }
  if (e.size <= start) return;
  let span = e.size - start;
  for (;;) {
    const got = readLines(fd, start, e.size, jump);
    if (got) {
      for (const line of got.lines) applyLine(t.s, line, e.meta);
      t.offset = got.end;
      return;
    }
    if (!jump) return; // incremental read: only a partial line so far
    if (start === 0 || span >= TAIL_BYTES_MAX) {
      t.offset = start === 0 ? 0 : e.size; // nothing usable; resume from here
      return;
    }
    span = Math.min(span * 4, TAIL_BYTES_MAX);
    start = Math.max(0, e.size - span);
  }
}

function refresh(e) {
  const key = `${e.mtimeMs}:${e.size}`;
  if (e.key === key) return;
  try {
    const fd = fs.openSync(e.path, 'r');
    try {
      if (!e.meta) readMeta(fd, e);
      if (e.meta && e.meta.kind !== 'internal') {
        if (e.meta.kind === 'user' && !e.head.done) headScan(fd, e);
        readTail(fd, e);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* unreadable right now: try again when it changes */
  }
  e.key = key;
}

// --- assembly ---------------------------------------------------------------
/** The top-level (user) thread a spawned thread ultimately belongs to, or null when it cannot be found. */
function findRoot(e) {
  let cur = e;
  for (let i = 0; i < 8; i++) {
    if (!cur.meta) return null;
    if (cur.meta.kind === 'user') return cur;
    const pid = cur.meta.parentId || (i === 0 ? cur.meta.rootId : '');
    if (!pid || pid === cur.meta.id) return null;
    const parent = byId.get(pid);
    if (!parent) return null;
    refresh(parent);
    cur = parent;
  }
  return null;
}

function buildSubagent(c, now) {
  const s = c.tail.s;
  const m = c.meta;
  const last = c.mtimeMs;
  let status = 'done';
  if (s.turnState === 'mid' && now - last <= MID_TURN_MAX_MS) status = 'working';
  else if (s.turnState === 'unknown' && now - last <= 60_000) status = 'working'; // just spawned, nothing logged yet
  else if (s.turnState === 'ended' && s.failed) status = 'failed';
  const sub = {
    id: m.id,
    label: oneLine(humanize(m.agentPath) || 'Subagent', 80),
    status,
    activity: status === 'working' ? (s.activity ?? THINKING) : act('idle', status === 'failed' ? 'Failed' : s.aborted ? 'Stopped' : 'Done'),
    startedAt: m.startedAt || Math.round(last),
    lastActivityAt: Math.round(last),
  };
  if (m.agentRole) sub.agentType = String(m.agentRole);
  if (status !== 'working') sub.endedAt = s.turnState === 'ended' && s.endedAt ? s.endedAt : Math.round(last);
  return sub;
}

function buildSession(top, now, cutoff, names) {
  const e = top.e;
  const m = e.meta;
  const s = e.tail.s;
  let last = e.mtimeMs;
  const subagents = [];
  // "current / most recent turn": children active since that turn began (or since our tail window began, when
  // the task_started record is further back than we read).
  const since = Math.max(cutoff, (s.turnStartTs || s.firstTs || 0) - 1000);
  for (const c of top.children) {
    if (c.mtimeMs > last) last = c.mtimeMs;
    const sub = buildSubagent(c, now);
    if (sub.status === 'working' || sub.lastActivityAt >= since) subagents.push(sub);
  }
  subagents.sort((a, b) => a.startedAt - b.startedAt);
  const working = subagents.filter((x) => x.status === 'working').length;

  let turnState = s.turnState;
  let activity;
  if (turnState === 'ended') {
    if (working) {
      turnState = 'mid'; // a running subagent will wake this thread up again
      activity = act('delegating', `Waiting on ${working} agent${working > 1 ? 's' : ''}`);
    } else {
      activity = act('waiting', s.aborted ? 'Interrupted' : s.failed ? 'Stopped: error' : 'Waiting for input');
    }
  } else if (turnState === 'mid') {
    activity = s.activity ?? THINKING;
    if (top.bump > last) last = top.bump; // hidden auto-review helper is writing while this turn is blocked on it
  } else {
    activity = s.activity ?? act('idle', 'Idle');
  }

  const title =
    (m.kind === 'spawn' ? humanize(m.agentPath) : names.get(m.id) || e.head.title) ||
    s.lastUser ||
    (m.cwd ? `Codex in ${baseName(m.cwd)}` : 'Codex session');
  const out = {
    tool,
    nativeId: m.id,
    title: oneLine(title, 120),
    cwd: m.cwd,
    source: m.source,
    turnState,
    startedAt: m.startedAt || Math.round(e.mtimeMs),
    lastActivityAt: Math.round(last),
    activity,
    subagents,
  };
  if (m.branch) out.branch = m.branch;
  const model = s.model || e.head.model;
  if (model) out.model = model;
  if (s.lastMessage) out.lastMessage = clipText(s.lastMessage);
  if (s.tokens) out.tokens = s.tokens;
  return out;
}

function listSync(now, maxAgeMs) {
  const cutoff = now - maxAgeMs;
  scan(cutoff);
  const names = loadNames();
  const tops = new Map();
  const ensureTop = (e) => {
    let t = tops.get(e);
    if (!t) tops.set(e, (t = { e, children: [], bump: 0 }));
    return t;
  };
  const internal = [];
  for (const e of files.values()) {
    if (e.mtimeMs < cutoff) continue;
    refresh(e);
    if (!e.meta) continue;
    if (e.meta.kind === 'user') ensureTop(e);
    else if (e.meta.kind === 'internal') internal.push(e);
    else {
      const root = findRoot(e);
      if (root && root !== e) ensureTop(root).children.push(e);
      else ensureTop(e); // parent log is gone: show the subagent on its own
    }
  }
  for (const g of internal) {
    const parent = byId.get(g.meta.parentId);
    const root = parent && parent.meta ? findRoot(parent) : null;
    const t = root && tops.get(root);
    if (t && g.mtimeMs > t.bump) t.bump = g.mtimeMs;
  }
  const out = [];
  for (const t of tops.values()) {
    try {
      const sess = buildSession(t, now, cutoff, names);
      if (sess.lastActivityAt >= cutoff) out.push(sess);
    } catch {
      /* skip a session we cannot assemble */
    }
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return out;
}

/**
 * @param {{now?: number, maxAgeMs?: number}} [opts]
 * @returns {Promise<import('../contract.mjs').AdapterSession[]>}
 */
export async function listSessions({ now = Date.now(), maxAgeMs = 60 * 60_000 } = {}) {
  try {
    return listSync(now, maxAgeMs);
  } catch {
    return [];
  }
}

// --- transcript -------------------------------------------------------------
function clip(text, n = 2000) {
  const t = String(text ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function findEntry(nativeId) {
  const id = String(nativeId ?? '').toLowerCase();
  if (!/^[0-9a-z-]{6,64}$/.test(id)) return null;
  let e = byId.get(id);
  if (e) return e;
  fullScan(Date.now());
  e = byId.get(id);
  if (e) return e;
  // older than the scan window: look through every day folder by file name
  const root = path.join(codexHome, 'sessions');
  for (const y of readdirSafe(root).sort().reverse()) {
    for (const m of readdirSafe(path.join(root, y)).sort().reverse()) {
      for (const d of readdirSafe(path.join(root, y, m)).sort().reverse()) {
        const dir = path.join(root, y, m, d);
        for (const name of readdirSafe(dir)) {
          if (!name.endsWith(`${id}.jsonl`)) continue;
          const st = statSafe(path.join(dir, name));
          if (!st) continue;
          e = newEntry(path.join(dir, name), name);
          e.mtimeMs = st.mtimeMs;
          e.size = st.size;
          return e;
        }
      }
    }
  }
  return null;
}
function toolMsg(ts, toolName, summary) {
  return { role: 'tool', text: clip(`${toolName}: ${oneLine(summary, 300)}`), ts, toolName };
}
function transcriptMessages(records, modern) {
  /** @type {import('../contract.mjs').Message[]} */
  const out = [];
  const lastOf = { user: '', assistant: '' };
  const push = (role, text, ts) => {
    const t = clip(text);
    if (!t) return;
    const norm = t.slice(0, 200);
    if (lastOf[role] === norm && t !== '(attachment)') return; // response_item + item_completed carry the same message
    lastOf[role] = norm;
    out.push({ role, text: t, ts });
  };
  for (const rec of records) {
    const ts = Date.parse(rec.timestamp ?? '') || 0;
    const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
    if (rec.type === 'event_msg') {
      if (p.type === 'user_message') push('user', realText(p.message), ts);
      else if (p.type === 'agent_message') push('assistant', p.message, ts);
      else if (p.type === 'item_completed' && p.item && typeof p.item === 'object') {
        const it = p.item;
        switch (it.type) {
          case 'UserMessage':
            push('user', userText(it.content), ts);
            break;
          case 'AgentMessage':
            push('assistant', allText(it.content), ts);
            break;
          case 'CommandExecution':
            out.push(toolMsg(ts, 'Bash', shortCmd(it.parsed_cmd?.[0]?.cmd ?? shellCommandOf(it.command), 200)));
            break;
          case 'FileChange':
            out.push(toolMsg(ts, 'Edit', Object.keys(it.changes ?? {}).map(baseName).join(', ') || 'files'));
            break;
          case 'McpToolCall':
            out.push(toolMsg(ts, it.appName || it.server || 'MCP', String(it.tool ?? '')));
            break;
          case 'Extension':
            if (it.kind === 'web.search') out.push(toolMsg(ts, 'WebSearch', it.action?.query ?? it.action?.queries?.[0] ?? it.action?.url ?? it.action?.type ?? ''));
            break;
          case 'SubAgentActivity':
            out.push(toolMsg(ts, 'Agent', `${humanize(it.agent_path) || 'root'} ${it.kind ?? ''}`));
            break;
          case 'ImageView':
            out.push(toolMsg(ts, 'ViewImage', baseName(it.path ?? '')));
            break;
          default:
            break;
        }
      }
    } else if (rec.type === 'response_item') {
      if (p.type === 'message') {
        if (p.role === 'assistant') push('assistant', allText(p.content), ts);
        else if (p.role === 'user') push('user', realText(p.content), ts);
      } else if (!modern && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call' || p.type === 'web_search_call')) {
        const a = callActivity(p, false);
        if (a) {
          const i = a.label.indexOf(': ');
          out.push(i > 0 ? toolMsg(ts, a.label.slice(0, i), a.label.slice(i + 2)) : toolMsg(ts, p.name || 'Tool', a.label));
        }
      }
    }
  }
  return out;
}
function transcriptSync(nativeId, limit) {
  const e = findEntry(nativeId);
  if (!e) return [];
  const st = statSafe(e.path);
  if (!st) return [];
  const size = st.size;
  const fd = fs.openSync(e.path, 'r');
  try {
    if (!e.meta) {
      e.size = e.size || size;
      readMeta(fd, e);
    }
    const minOrd = e.meta ? e.meta.startOrdinal : 0;
    let span = Math.min(size, TRANSCRIPT_BYTES);
    for (;;) {
      const start = size - span;
      const got = readLines(fd, start, size, start > 0);
      const records = [];
      let modern = false;
      for (const line of got ? got.lines : []) {
        if (line.length < 2 || line.length > PARSE_LINE_MAX) continue;
        const m = SNIFF_RE.exec(line.length > 400 ? line.slice(0, 400) : line);
        if (m) {
          if (minOrd && m[2] !== undefined && Number(m[2]) < minOrd) continue;
          const type = m[3];
          const pt = m[4];
          if (type !== 'event_msg' && type !== 'response_item') continue;
          if (type === 'event_msg' && pt !== 'item_completed' && pt !== 'user_message' && pt !== 'agent_message') continue;
          if (type === 'response_item') {
            if (pt === 'reasoning' || pt === 'additional_tools' || pt === 'compaction' || (pt && pt.endsWith('_output'))) continue;
            if (pt === 'message') {
              const role = ROLE_RE.exec(line.slice(0, 400))?.[1];
              if (role === 'developer' || role === 'system') continue;
            }
          }
        }
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!rec || typeof rec !== 'object') continue;
        if (minOrd && typeof rec.ordinal === 'number' && rec.ordinal < minOrd) continue;
        if (rec.type === 'event_msg' && rec.payload?.type === 'item_completed') modern = true;
        records.push(rec);
      }
      const messages = transcriptMessages(records, modern);
      if (messages.length >= limit || start === 0 || span >= TRANSCRIPT_BYTES_MAX) return messages.slice(-limit);
      span = Math.min(size, span * 4, TRANSCRIPT_BYTES_MAX);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} nativeId  Codex thread id (a subagent's thread id works too)
 * @param {{limit?: number}} [opts]
 * @returns {Promise<import('../contract.mjs').Message[]>}
 */
export async function getTranscript(nativeId, { limit = 60 } = {}) {
  try {
    return transcriptSync(nativeId, Math.max(1, Number(limit) || 60));
  } catch {
    return [];
  }
}

// --- eyeball it: `node server/adapters/codex.mjs [--hours N]` ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hoursArg = process.argv.indexOf('--hours');
  const hours = hoursArg > 0 ? Number(process.argv[hoursArg + 1]) || 1 : 1;
  const maxAgeMs = hours * 60 * 60_000;
  const t0 = performance.now();
  const sessions = await listSessions({ now: Date.now(), maxAgeMs });
  const cold = performance.now() - t0;
  const N = 20;
  const t1 = performance.now();
  for (let i = 0; i < N; i++) await listSessions({ now: Date.now(), maxAgeMs });
  const warm = (performance.now() - t1) / N;
  lastFullScan = -Infinity;
  const t2 = performance.now();
  await listSessions({ now: Date.now(), maxAgeMs });
  const warmFull = performance.now() - t2;

  const ago = (ms) => {
    const s = Math.round((Date.now() - ms) / 1000);
    return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
  };
  console.log(`codex home: ${codexHome}`);
  console.log(`${sessions.length} session(s) active in the last ${hours}h   (${files.size} rollout files indexed)`);
  for (const s of sessions) {
    console.log(
      `\n${s.nativeId.slice(0, 8)}  ${s.source.padEnd(7)} ${s.turnState.padEnd(7)} ${ago(s.lastActivityAt).padStart(5)} ago  ${s.model ?? '-'}  ${s.tokens ?? '-'} tok  [${baseName(s.cwd)}${s.branch ? `@${s.branch}` : ''}]`,
    );
    console.log(`  title:    ${oneLine(s.title, 80)}`);
    console.log(`  activity: ${s.activity.kind} - ${s.activity.label}`);
    for (const a of s.subagents) {
      console.log(`  subagent: ${a.id.slice(0, 8)} ${a.status.padEnd(7)} ${a.label} - ${a.activity.kind}: ${a.activity.label} (${ago(a.lastActivityAt)} ago)`);
    }
  }
  if (sessions[0]) {
    const t3 = performance.now();
    const msgs = await getTranscript(sessions[0].nativeId, { limit: 60 });
    const roles = msgs.reduce((acc, m) => ((acc[m.role] = (acc[m.role] ?? 0) + 1), acc), {});
    console.log(`\ntranscript of ${sessions[0].nativeId.slice(0, 8)}: ${msgs.length} messages ${JSON.stringify(roles)} in ${(performance.now() - t3).toFixed(1)} ms`);
  }
  console.log(`\ncold ${cold.toFixed(1)} ms | warm ${warm.toFixed(2)} ms avg over ${N} | warm incl. full re-stat ${warmFull.toFixed(1)} ms`);
}
