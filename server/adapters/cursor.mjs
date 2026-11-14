// Cursor adapter for Agent Office.
//
// Two data sources, merged and de-duplicated on the conversation id (Cursor's composerId):
//
//  1. Agent transcripts (the cheap, primary source, polled on every call)
//       ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
//       ~/.cursor/projects/<slug>/agent-transcripts/<id>/subagents/<subId>.jsonl
//     One JSON object per line:
//       {"role":"user","message":{"content":[{"type":"text","text":"<timestamp>..</timestamp><user_query>..</user_query>"}]}}
//       {"role":"assistant","message":{"content":[{"type":"text","text":".."},{"type":"tool_use","name":"Shell","input":{..}}]}}
//       {"type":"turn_ended","status":"success"|"error"|"aborted","error"?:".."}
//     There are no per-record timestamps, tool results or tool-call ids, so file mtimes are the clock.
//
//  2. The Cursor IDE store (enrichment only, read on a slow cadence in a worker thread)
//       <Cursor user dir>/globalStorage/state.vscdb   (sqlite, can be many GB, written by the running app)
//         table composerHeaders(composerId PK, createdAt, lastUpdatedAt, checkpointAt, isArchived, isSubagent,
//                               recency, subagentTypeName, value JSON)   index (recency, composerId)
//         table cursorDiskKV(key UNIQUE, value)   keys composerData:<id>, bubbleId:<id>:<bubbleId>
//     Opened strictly read-only, only indexed range scans / point lookups, never on the polling thread.
//
// The module never throws from its public functions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { clipText, oneLine, FRESH_MS, MID_TURN_MAX_MS, IDLE_MAX_MS } from '../contract.mjs';

export const tool = 'cursor';

// --- Configuration ----------------------------------------------------------

function defaultStateDb() {
  const home = os.homedir();
  const userDir =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User');
  return path.join(userDir, 'globalStorage', 'state.vscdb');
}

function defaultConfig() {
  const envDb = process.env.AGENT_OFFICE_CURSOR_STATE_DB;
  return {
    /** Folder holding <slug>/agent-transcripts/... */
    projectsDir: process.env.AGENT_OFFICE_CURSOR_PROJECTS || path.join(os.homedir(), '.cursor', 'projects'),
    /** Global IDE sqlite store. '' / 'off' / 'none' disables the IDE layer. */
    stateDb: envDb === undefined ? defaultStateDb() : /^(|off|none|0)$/i.test(envDb) ? '' : envDb,
    tailBytes: 128 * 1024, // normal bounded tail read
    tailBytesMax: 1024 * 1024, // retry size when the tail holds no complete record
    headBytes: 64 * 1024,
    discoverMs: 4_000, // how often directory listings are re-checked for new sessions
    warmStatMs: 10_000, // re-stat cadence for transcripts touched in the last week
    coldStatMs: 60_000, // re-stat cadence for older transcripts
    statBudget: 100, // at most this many re-stats of non-hot transcripts per call
    ideRefreshMs: 10_000, // sqlite refresh cadence
    ideBudgetMs: 1_500, // hard budget for one sqlite refresh (worker is killed past it)
    ideQueryBudgetMs: 400, // soft budget inside the worker (stops issuing further lookups)
    ideColdWaitMs: 400, // the very first listSessions() waits at most this long for IDE data
  };
}

let cfg = defaultConfig();

/** Override data roots / cadences (tests, unusual installs). Resets every cache. */
export function configure(overrides = {}) {
  cfg = { ...defaultConfig(), ...overrides };
  resetState();
  return { ...cfg };
}

const WARM_AGE_MS = 7 * 24 * 3600_000;
const SUB_GRACE_MS = 2 * 3600_000; // a parent can be quiet this long while a subagent is still writing
const LEGACY_QUIET_MS = 120_000; // pre-"turn_ended" transcripts: text + this much silence = turn over
const MAX_SUBS = 24;

// --- Small helpers ----------------------------------------------------------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "Friday, Nov 13, 2026, 7:43 PM (UTC-7)" -> ms epoch (0 if unparseable). */
export function parseCursorTimestamp(s) {
  try {
    const m =
      /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*(?:\(?(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?\)?)?/.exec(
        String(s ?? ''),
      );
    if (!m) {
      const d = Date.parse(String(s ?? ''));
      return Number.isFinite(d) ? d : 0;
    }
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon === undefined) return 0;
    let hour = Number(m[4]);
    const ap = m[7]?.toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    if (m[8]) {
      const off = (Number(m[9]) * 60 + Number(m[10] || 0)) * (m[8] === '-' ? -1 : 1);
      return Date.UTC(Number(m[3]), mon, Number(m[2]), hour, Number(m[5]), Number(m[6] || 0)) - off * 60_000;
    }
    return new Date(Number(m[3]), mon, Number(m[2]), hour, Number(m[5]), Number(m[6] || 0)).getTime();
  } catch {
    return 0;
  }
}

/** The human's own words out of a Cursor user record (wrapper tags stripped). '' when there are none. */
export function userText(raw) {
  const s = String(raw ?? '');
  const m = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/.exec(s);
  if (m) return m[1].trim();
  let t = s;
  for (let i = 0; i < 16; i++) {
    const w = /^\s*<([a-z][a-z0-9_]*)>[\s\S]*?<\/\1>/.exec(t);
    if (!w) break;
    t = t.slice(w[0].length);
  }
  return t.trim();
}

function userTimestamp(raw) {
  const m = /<timestamp>([^<]{0,80})<\/timestamp>/.exec(String(raw ?? ''));
  return m ? parseCursorTimestamp(m[1]) : 0;
}

function contentItems(rec) {
  const c = rec?.message?.content ?? rec?.content;
  if (Array.isArray(c)) return c.filter((x) => x && typeof x === 'object');
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return [];
}

function recText(rec) {
  return contentItems(rec)
    .filter((it) => it.type === 'text' && typeof it.text === 'string')
    .map((it) => it.text)
    .join('\n');
}

const isToolUse = (it) => it?.type === 'tool_use' || it?.type === 'tool_call';
const promptKey = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
const base = (p) => (p ? path.basename(String(p).replace(/[\\/]+$/, '')) : '');
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? '' : String(v));

function hostOf(u) {
  try {
    return new URL(String(u)).host;
  } catch {
    return oneLine(u, 40);
  }
}

/**
 * Map one Cursor tool call to an Activity (+ a short input summary for transcripts).
 * @returns {{kind: import('../contract.mjs').ActivityKind, label: string, summary: string, ask?: boolean, task?: boolean}}
 */
export function describeTool(name, input) {
  const raw = String(name ?? 'tool').trim() || 'tool';
  const n = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const i = input && typeof input === 'object' ? input : {};
  const file = base(i.path ?? i.target_file ?? i.file_path ?? i.relative_workspace_path ?? i.target_notebook ?? i.filePath);
  const mk = (kind, label, summary = label, extra = {}) => ({ kind, label: oneLine(label, 60), summary: oneLine(summary, 200), ...extra });

  if (/^(read|readfile|read_file(_v\d+)?|view_file|read_notebook)$/.test(n)) return mk('reading', `Read ${file || 'file'}`, file || 'file');
  if (/^(readlints|read_lints)$/.test(n)) return mk('reading', 'Read lints', 'lints');
  if (/^(delete|delete_file|deletefile)$/.test(n)) return mk('editing', `Delete ${file || 'file'}`, file || 'file');
  if (/^(strreplace|str_replace|write|writefile|write_file|multiedit|multi_edit|edit|edit_file(_v\d+)?|search_replace|editnotebook|edit_notebook|reapply)$/.test(n))
    return mk('editing', `Edit ${file || 'file'}`, file || 'file');
  if (/^(applypatch|apply_patch)$/.test(n)) {
    const patch = str(i.patch ?? i.input ?? i.diff ?? i.content);
    const pm = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patch);
    const f = file || base(pm?.[1]) || 'patch';
    return mk('editing', `Edit ${f}`, f);
  }
  if (/^(shell|bash|terminal|run_terminal_cmd|run_terminal_command(_v\d+)?)$/.test(n)) {
    const cmd = str(i.command ?? i.cmd) || 'command';
    return mk('running', `Bash: ${oneLine(cmd, 40)}`, cmd);
  }
  if (/^(awaitshell|await_shell|await)$/.test(n)) return mk('running', 'Waiting on shell', 'waiting on a running command');
  if (/^(grep|rg|ripgrep(_raw)?_search|grep_search)$/.test(n)) return mk('searching', `Grep ${oneLine(str(i.pattern ?? i.query), 40)}`, str(i.pattern ?? i.query));
  if (/^(glob|glob_file_search|file_search|list_dir|ls|listdir)$/.test(n)) {
    const g = str(i.glob_pattern ?? i.pattern ?? i.query ?? i.target_directory ?? i.path);
    return mk('searching', `Glob ${oneLine(g, 40)}`, g);
  }
  if (/^(semanticsearch|semantic_search|codebase_search|searchconversations|search_conversations)$/.test(n)) {
    const q = str(i.query ?? i.search_term ?? i.pattern);
    return mk('searching', `Search: ${oneLine(q, 40)}`, q);
  }
  if (/^(websearch|web_search)$/.test(n)) {
    const q = str(i.search_term ?? i.query);
    return mk('searching', `Web: ${oneLine(q, 40)}`, q);
  }
  if (/^(webfetch|web_fetch|fetch|fetch_url)$/.test(n)) return mk('browsing', `Fetch ${hostOf(i.url)}`, str(i.url));
  if (n.includes('browser')) {
    const action = raw.replace(/^.*browser[-_]/i, '').replace(/[-_]+/g, ' ') || 'browser';
    return mk('browsing', `Browser: ${action}`, str(i.url) || action);
  }
  if (/^(task|subagent|spawn_agent|background_agent)$/.test(n)) {
    const d = str(i.description) || str(i.prompt) || 'subagent';
    return mk('delegating', `Task: ${oneLine(d, 50)}`, d, { task: true });
  }
  if (/^(askquestion|ask_question|ask_followup_question)$/.test(n)) return mk('waiting', 'Asking a question', str(i.title) || 'question', { ask: true });
  if (/^(todowrite|todo_write)$/.test(n)) return mk('thinking', 'Updating todos', 'todos');
  if (/^(updatecurrentstep|update_current_step)$/.test(n)) {
    const s = str(i.current_step);
    return mk('thinking', s ? oneLine(s, 58) : 'Planning', s || 'next step');
  }
  if (/^(createplan|create_plan)$/.test(n)) return mk('thinking', 'Writing plan', str(i.name) || 'plan');
  if (/^(switchmode|switch_mode)$/.test(n)) return mk('thinking', 'Switching mode', str(i.target_mode_id ?? i.mode) || 'mode');
  if (/^(setactivebranch|set_active_branch)$/.test(n)) return mk('running', 'Switch branch', str(i.branch ?? i.branch_name) || 'branch');
  if (/^(generateimage|generate_image)$/.test(n)) return mk('writing', 'Generate image', 'image');
  if (/^(getmcptools|get_mcp_tools|getdynamictools|get_dynamic_tools|listmcpresources|list_mcp_resources|fetchmcpresource|fetch_mcp_resource)$/.test(n))
    return mk('searching', 'Looking up tools', str(i.toolName ?? i.pattern ?? i.namespace ?? i.server) || 'tools');
  const viaMeta = /^(callmcptool|call_mcp_tool|calldynamictool|call_dynamic_tool)$/.test(n);
  if (viaMeta || n.startsWith('mcp_') || raw.includes('-')) {
    const tn = (viaMeta && str(i.toolName ?? i.tool_name ?? i.name)) || raw.replace(/^mcp[-_]/i, '');
    const kind = /browser|navigate|screenshot/i.test(tn) ? 'browsing' : /search|find|query|list|get_|read/i.test(tn) ? 'searching' : 'running';
    return mk(kind, `MCP: ${oneLine(tn, 50)}`, [str(i.namespace ?? i.server), tn].filter(Boolean).join(' '));
  }
  return mk('running', raw, raw);
}

// --- Bounded file reads -----------------------------------------------------

function readSlice(file, start, length) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
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

function parseLines(text, dropFirst) {
  const out = [];
  const lines = text.split('\n');
  for (let i = dropFirst ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 2) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') out.push(o);
    } catch {
      /* truncated or malformed line - skip */
    }
  }
  return out;
}

function readTailRecords(file, size, bytes) {
  const want = Math.min(size, bytes);
  if (want <= 0) return [];
  const start = size - want;
  let recs = parseLines(readSlice(file, start, want), start > 0);
  if (recs.length === 0 && start > 0 && cfg.tailBytesMax > bytes) {
    const want2 = Math.min(size, cfg.tailBytesMax);
    recs = parseLines(readSlice(file, size - want2, want2), size - want2 > 0);
  }
  return recs;
}

// --- Transcript analysis ----------------------------------------------------

/**
 * Digest the tail of a transcript.
 * turnState here is purely what the log says; staleness rules are applied by the caller.
 */
export function analyseRecords(recs) {
  const a = {
    turnState: /** @type {import('../contract.mjs').TurnState} */ ('unknown'),
    endStatus: /** @type {string|null} */ (null),
    activity: { kind: 'thinking', label: 'Thinking' },
    lastMessage: '',
    lastUserTs: 0,
    hasTurnEnded: false,
    lastKind: /** @type {'user'|'text'|'tool'|'ended'|null} */ (null),
    ask: false,
    tasks: /** @type {any[]} */ ([]),
  };
  let lastUserIdx = -1;
  let lastKnownIdx = -1;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.type === 'turn_ended') {
      a.hasTurnEnded = true;
      lastKnownIdx = i;
    } else if (r.role === 'user') {
      lastKnownIdx = i;
      const raw = recText(r);
      if (userText(raw)) {
        lastUserIdx = i;
        a.lastUserTs = userTimestamp(raw) || a.lastUserTs;
      }
    } else if (r.role === 'assistant') {
      lastKnownIdx = i;
    }
  }
  if (lastKnownIdx < 0) return a;

  for (let i = recs.length - 1; i >= 0 && !a.lastMessage; i--) {
    if (recs[i].role !== 'assistant') continue;
    const items = contentItems(recs[i]);
    for (let j = items.length - 1; j >= 0; j--) {
      if (items[j].type === 'text' && typeof items[j].text === 'string' && items[j].text.trim()) {
        a.lastMessage = clipText(items[j].text);
        break;
      }
    }
  }

  for (let i = lastUserIdx + 1; i < recs.length; i++) {
    if (recs[i].role !== 'assistant') continue;
    for (const it of contentItems(recs[i])) {
      if (!isToolUse(it)) continue;
      const d = describeTool(it.name, it.input);
      if (!d.task) continue;
      const inp = it.input && typeof it.input === 'object' ? it.input : {};
      a.tasks.push({
        description: str(inp.description),
        promptKey: promptKey(inp.prompt),
        agentType: str(inp.subagent_type) || undefined,
        resume: str(inp.resume) || undefined,
        background: inp.run_in_background === true,
        trailing: i === lastKnownIdx,
      });
    }
  }

  const last = recs[lastKnownIdx];
  if (last.type === 'turn_ended') {
    a.turnState = 'ended';
    a.endStatus = str(last.status) || 'success';
    a.lastKind = 'ended';
    a.activity =
      a.endStatus === 'error'
        ? { kind: 'waiting', label: 'Stopped: error' }
        : a.endStatus === 'aborted'
          ? { kind: 'waiting', label: 'Stopped' }
          : { kind: 'waiting', label: 'Waiting for you' };
    return a;
  }
  a.turnState = 'mid';
  if (last.role === 'user') {
    a.lastKind = 'user';
    a.activity = { kind: 'thinking', label: 'Thinking' };
    return a;
  }
  const items = contentItems(last);
  const tail = items[items.length - 1];
  if (isToolUse(tail)) {
    const d = describeTool(tail.name, tail.input);
    a.lastKind = 'tool';
    a.activity = { kind: d.kind, label: d.label };
    if (d.ask) {
      // Blocked on the human: that is an ended turn as far as the office is concerned.
      a.ask = true;
      a.turnState = 'ended';
    }
  } else if (tail?.type === 'thinking' || tail?.type === 'reasoning') {
    a.lastKind = 'text';
    a.activity = { kind: 'thinking', label: 'Thinking' };
  } else {
    a.lastKind = 'text';
    a.activity = { kind: 'writing', label: 'Writing reply' };
  }
  return a;
}

function analyseHead(file, size) {
  const h = { firstPrompt: '', promptKey: '', firstTs: 0 };
  const want = Math.min(size, cfg.headBytes);
  if (want <= 0) return h;
  const text = readSlice(file, 0, want);
  const recs = parseLines(text, false);
  for (const r of recs) {
    if (r.role !== 'user') continue;
    const raw = recText(r);
    if (!h.firstTs) h.firstTs = userTimestamp(raw);
    const t = userText(raw);
    if (t) {
      h.firstPrompt = oneLine(t, 200);
      h.promptKey = promptKey(t);
      break;
    }
  }
  if (!h.firstPrompt && recs.length === 0 && text) {
    // First line longer than the head window (huge pasted prompt): salvage from the raw JSON text.
    const m = /<user_query>((?:[^"\\<]|\\.){1,600})/.exec(text) || /"text":"((?:[^"\\]|\\.){1,600})/.exec(text);
    if (m) {
      let t = m[1];
      try {
        t = JSON.parse(`"${m[1].replace(/\\$/, '')}"`);
      } catch {
        t = m[1].replace(/\\[nrt]/g, ' ').replace(/\\(.)/g, '$1');
      }
      h.firstPrompt = oneLine(userText(t) || t, 200);
      h.promptKey = promptKey(userText(t) || t);
    }
    h.firstTs = userTimestamp(text.slice(0, 2000).replace(/\\n/g, ' '));
  }
  return h;
}

// --- File index (stat first, parse only what changed) -----------------------

/**
 * @typedef {Object} Entry
 * @property {string} id
 * @property {string} slug
 * @property {string} dir
 * @property {string} file
 * @property {number} mtimeMs   0 = main file missing
 * @property {number} size
 * @property {number} birthMs
 * @property {number} statAt
 * @property {boolean} [flat]   transcript sits directly in agent-transcripts/ (no subagents folder)
 * @property {number} [newAt]
 * @property {any} [tail]
 * @property {string} [tailKey]
 * @property {any} [head]
 * @property {boolean} [sawTurnEnded]
 * @property {{dirMtime:number, map:Map<string,Entry>}|null} [subs]
 */

let state;
function resetState() {
  if (state?.ide?.worker) {
    try {
      state.ide.worker.terminate();
    } catch {}
  }
  state = {
    rootMtime: -1,
    slugs: /** @type {string[]} */ ([]),
    projects: /** @type {Map<string, {mtime:number, ids:Set<string>}>} */ (new Map()),
    files: /** @type {Map<string, Entry>} */ (new Map()),
    subIndex: /** @type {Map<string, Entry>} */ (new Map()),
    discoveredAt: -Infinity,
    scanned: false,
    cwdBySlug: /** @type {Map<string, {cwd:string, at:number}>} */ (new Map()),
    ide: {
      worker: /** @type {Worker|null} */ (null),
      seq: 0,
      pending: /** @type {Promise<void>|null} */ (null),
      currentWorker: /** @type {Worker|null} */ (null),
      finishCurrent: /** @type {((msg: any) => void)|null} */ (null),
      snap: /** @type {any} */ (null),
      lastStartAt: -Infinity,
      failures: 0,
      dbOk: /** @type {boolean|null} */ (null),
      dbCheckedAt: -Infinity,
      lastMs: 0,
      lastError: '',
    },
  };
}
resetState();

const statOrNull = (p) => {
  try {
    return fs.statSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
};

function discover(real) {
  state.discoveredAt = real;
  const root = cfg.projectsDir;
  const rst = statOrNull(root);
  if (!rst) {
    state.rootMtime = -1;
    state.slugs = [];
    state.projects.clear();
    state.files.clear();
    return;
  }
  if (rst.mtimeMs !== state.rootMtime) {
    try {
      state.slugs = fs.readdirSync(root).filter((n) => !n.startsWith('.'));
      state.rootMtime = rst.mtimeMs;
    } catch {
      state.slugs = [];
    }
    const live = new Set(state.slugs);
    for (const slug of state.projects.keys()) if (!live.has(slug)) dropProject(slug);
  }
  for (const slug of state.slugs) {
    const tdir = path.join(root, slug, 'agent-transcripts');
    const st = statOrNull(tdir);
    const known = state.projects.get(slug);
    if (!st || !st.isDirectory()) {
      if (known) dropProject(slug);
      continue;
    }
    if (known && known.mtime === st.mtimeMs) continue;
    let names;
    try {
      names = fs.readdirSync(tdir);
    } catch {
      continue;
    }
    const ids = new Set();
    for (const name of names) {
      if (name.startsWith('.')) continue;
      // Layout A: <id>/<id>.jsonl   Layout B (flat): <id>.jsonl
      const flat = name.endsWith('.jsonl');
      const id = flat ? name.slice(0, -6) : name;
      if (!id || ids.has(id)) continue;
      ids.add(id);
      // The same conversation id can exist under two project slugs (chat moved between workspaces),
      // so the index is keyed by slug + id and de-duplicated on id (newest write wins) when scanning.
      const fkey = `${slug}\0${id}`;
      if (state.files.has(fkey)) continue;
      const dir = flat ? tdir : path.join(tdir, id);
      state.files.set(fkey, {
        id,
        slug,
        dir,
        flat,
        file: flat ? path.join(tdir, name) : path.join(dir, `${id}.jsonl`),
        mtimeMs: 0,
        size: 0,
        birthMs: 0,
        statAt: 0,
        newAt: known ? real : 0, // appeared after the first listing: its .jsonl may land a moment later
        subs: null,
      });
    }
    if (known) for (const id of known.ids) if (!ids.has(id)) state.files.delete(`${slug}\0${id}`);
    state.projects.set(slug, { mtime: st.mtimeMs, ids });
  }
}

function dropProject(slug) {
  const known = state.projects.get(slug);
  if (!known) return;
  for (const id of known.ids) state.files.delete(`${slug}\0${id}`);
  state.projects.delete(slug);
}

function statEntry(e, real) {
  const st = statOrNull(e.file);
  e.statAt = real;
  if (!st || !st.isFile()) {
    e.mtimeMs = 0;
    e.size = 0;
    return;
  }
  e.mtimeMs = st.mtimeMs;
  e.size = st.size;
  e.birthMs = st.birthtimeMs > 0 && st.birthtimeMs <= st.mtimeMs ? st.birthtimeMs : st.mtimeMs;
}

function dueForStat(e, real, hotCut, now) {
  if (!e.statAt) return true;
  if (e.mtimeMs >= hotCut) return true;
  if (!e.mtimeMs && e.newAt && real - e.newAt < 5 * 60_000) return true;
  const every = e.mtimeMs >= now - WARM_AGE_MS ? cfg.warmStatMs : cfg.coldStatMs;
  return real - e.statAt >= every;
}

/** @returns {Entry[]} transcripts that might be in the office */
function scan(now, maxAgeMs) {
  const real = Date.now();
  if (real - state.discoveredAt >= cfg.discoverMs) discover(real);
  const hotCut = now - maxAgeMs - SUB_GRACE_MS;
  const out = new Map();
  let budget = state.scanned ? cfg.statBudget : Infinity; // spread re-stats of old files across polls
  state.scanned = true;
  for (const e of state.files.values()) {
    if (dueForStat(e, real, hotCut, now)) {
      const hot = e.statAt && e.mtimeMs >= hotCut;
      if (hot || !e.statAt || budget-- > 0) statEntry(e, real);
    }
    if (!e.mtimeMs || e.mtimeMs < hotCut) continue;
    const dup = out.get(e.id);
    if (!dup || dup.mtimeMs < e.mtimeMs) out.set(e.id, e);
  }
  return [...out.values()];
}

/** Newest transcript with this conversation id (any age), or null. */
function entryById(id) {
  let best = null;
  for (const e of state.files.values()) {
    if (e.id !== id) continue;
    if (!e.statAt) statEntry(e, Date.now());
    if (e.mtimeMs && (!best || best.mtimeMs < e.mtimeMs)) best = e;
  }
  return best;
}

function ensureParsed(e) {
  const key = `${e.mtimeMs}:${e.size}`;
  if (e.tailKey !== key) {
    e.tail = analyseRecords(readTailRecords(e.file, e.size, cfg.tailBytes));
    e.tailKey = key;
    if (e.tail.hasTurnEnded) e.sawTurnEnded = true;
  }
  if (!e.head || (!e.head.firstPrompt && e.headKey !== key)) {
    e.head = analyseHead(e.file, e.size);
    e.headKey = key;
  }
}

/** @returns {Entry[]} subagent transcripts of a parent, newest first */
function loadSubs(e, now, maxAgeMs) {
  if (e.flat) return [];
  const sdir = path.join(e.dir, 'subagents');
  const st = statOrNull(sdir);
  if (!st || !st.isDirectory()) {
    if (e.subs) for (const id of e.subs.map.keys()) state.subIndex.delete(id);
    e.subs = null;
    return [];
  }
  const real = Date.now();
  if (!e.subs || e.subs.dirMtime !== st.mtimeMs) {
    const map = new Map();
    let names = [];
    try {
      names = fs.readdirSync(sdir);
    } catch {}
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -6);
      const prev = e.subs?.map.get(id);
      const se = prev || { id, slug: e.slug, dir: sdir, file: path.join(sdir, name), mtimeMs: 0, size: 0, birthMs: 0, statAt: 0, subs: null };
      map.set(id, se);
      state.subIndex.set(id, se);
    }
    if (e.subs) for (const id of e.subs.map.keys()) if (!map.has(id)) state.subIndex.delete(id);
    e.subs = { dirMtime: st.mtimeMs, map };
  }
  const hotCut = now - maxAgeMs - SUB_GRACE_MS;
  const list = [];
  for (const se of e.subs.map.values()) {
    if (dueForStat(se, real, hotCut, now)) statEntry(se, real);
    if (se.mtimeMs) list.push(se);
  }
  list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return list;
}

// --- cwd from the project slug (fallback when the IDE store has no workspace uri) ---

function cwdFromSlug(slug) {
  const hit = state.cwdBySlug.get(slug);
  const real = Date.now();
  if (hit && (hit.cwd || real - hit.at < 5 * 60_000)) return hit.cwd;
  let cwd = '';
  if (slug && slug !== 'empty-window' && !/^\d+$/.test(slug)) {
    let budget = 80;
    const walk = (dir, rest, depth) => {
      if (depth > 14 || budget-- <= 0) return '';
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return '';
      }
      const cands = [];
      for (const ent of ents) {
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const norm = ent.name.replace(/[^A-Za-z0-9]/g, '-');
        if (rest === norm) return path.join(dir, ent.name);
        if (rest.startsWith(norm + '-')) cands.push([ent.name, norm.length]);
      }
      cands.sort((a, b) => b[1] - a[1]); // prefer the longest directory-name match
      for (const [name, len] of cands) {
        const r = walk(path.join(dir, name), rest.slice(len + 1), depth + 1);
        if (r) return r;
      }
      return '';
    };
    try {
      cwd = walk(path.parse(os.homedir()).root || '/', slug, 0);
    } catch {
      cwd = '';
    }
  }
  state.cwdBySlug.set(slug, { cwd, at: real });
  return cwd;
}

// --- IDE store (sqlite) -----------------------------------------------------
// All sqlite work happens in a worker thread so a slow or locked database can never stall a poll.

function ideEnabled() {
  if (!cfg.stateDb) return false;
  const real = Date.now();
  const ide = state.ide;
  if (ide.dbOk === null || real - ide.dbCheckedAt > 30_000) {
    ide.dbOk = !!statOrNull(cfg.stateDb)?.isFile();
    ide.dbCheckedAt = real;
  }
  return ide.dbOk;
}

function ideIntervalMs() {
  return Math.min(120_000, cfg.ideRefreshMs * 2 ** Math.min(state.ide.failures, 4));
}

function startIdeRefresh(now, maxAgeMs, ids, subIds) {
  const ide = state.ide;
  const mine = state;
  ide.lastStartAt = Date.now();
  let done = false;
  const promise = new Promise((resolve) => {
    let timer;
    const finish = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (mine === state) {
        ide.pending = null;
        try {
          ide.worker?.unref();
        } catch {}
        if (msg && msg.ok) {
          ide.failures = 0;
          ide.lastMs = msg.ms;
          ide.lastError = msg.partial ? 'partial (query budget reached)' : '';
          ide.snap = {
            at: Date.now(),
            headers: new Map(msg.headers),
            data: new Map(msg.data),
            asked: new Set([...ids, ...subIds]),
            recent: msg.recent,
          };
        } else {
          ide.failures++;
          ide.lastError = msg?.error || 'timeout';
        }
      }
      resolve();
    };
    try {
      if (!ide.worker) {
        const w = new Worker(fileURLToPath(import.meta.url), { workerData: { agentOfficeCursorIde: true } });
        const gone = (error) => {
          if (ide.worker === w) ide.worker = null;
          if (ide.currentWorker === w) ide.finishCurrent?.({ ok: false, error });
        };
        w.on('error', (err) => gone(`worker error: ${err?.message || err}`));
        w.on('exit', () => gone('worker exited'));
        ide.worker = w;
      }
      const w = ide.worker;
      const seq = ++ide.seq;
      const onMsg = (msg) => {
        if (msg?.seq !== seq) return;
        w.off('message', onMsg);
        finish(msg);
      };
      ide.currentWorker = w;
      ide.finishCurrent = (msg) => {
        w.off('message', onMsg);
        finish(msg);
      };
      w.on('message', onMsg);
      w.ref();
      timer = setTimeout(() => {
        // Hard budget: kill the worker (and with it the read transaction) and back off.
        try {
          w.terminate();
        } catch {}
        if (ide.worker === w) ide.worker = null;
        w.off('message', onMsg);
        finish({ ok: false, error: `sqlite refresh exceeded ${cfg.ideBudgetMs} ms` });
      }, cfg.ideBudgetMs);
      w.postMessage({ seq, dbPath: cfg.stateDb, since: now - maxAgeMs, ids, subIds, budgetMs: cfg.ideQueryBudgetMs });
    } catch (err) {
      finish({ ok: false, error: String(err?.message || err) });
    }
  });
  ide.pending = done ? null : promise; // `done` already = it failed synchronously
  return promise;
}

/** Kick a refresh when due. Returns the in-flight promise (or null). */
function maybeRefreshIde(now, maxAgeMs, ids, subIds) {
  if (!ideEnabled()) return null;
  const ide = state.ide;
  if (ide.pending) return ide.pending;
  const since = Date.now() - ide.lastStartAt;
  const ask = ids.slice(0, 60);
  const unknown = ide.snap ? ask.some((id) => !ide.snap.asked.has(id)) : true;
  if (since >= ideIntervalMs() || (unknown && ide.failures === 0 && since >= 1_000)) return startIdeRefresh(now, maxAgeMs, ask, subIds.slice(0, 200));
  return null;
}

function slimHeader(row) {
  let v = {};
  try {
    v = JSON.parse(row.value) || {};
  } catch {}
  const loc = v.agentLocation && typeof v.agentLocation === 'object' ? v.agentLocation : null;
  const uriPath = (u) => (u && typeof u === 'object' ? u.fsPath || u.path || '' : '');
  let cwd = '';
  if (loc?.type === 'worktree' && typeof loc.worktreePath === 'string') cwd = loc.worktreePath;
  if (!cwd) cwd = uriPath(loc?.environment?.uri) || uriPath(v.workspaceIdentifier?.uri) || '';
  let branch = '';
  let best = -1;
  for (const repo of Array.isArray(v.trackedGitRepos) ? v.trackedGitRepos : []) {
    for (const b of Array.isArray(repo?.branches) ? repo.branches : []) {
      const at = Number(b?.lastInteractionAt) || 0;
      if (typeof b?.branchName === 'string' && at > best) {
        best = at;
        branch = b.branchName;
      }
    }
  }
  const si = v.subagentInfo && typeof v.subagentInfo === 'object' ? v.subagentInfo : null;
  return {
    createdAt: Number(row.createdAt ?? v.createdAt) || 0,
    lastUpdatedAt: Number(row.lastUpdatedAt ?? v.lastUpdatedAt) || 0,
    checkpointAt: Number(row.checkpointAt ?? v.conversationCheckpointLastUpdatedAt) || 0,
    archived: !!(row.isArchived ?? v.isArchived),
    isSub: !!(row.isSubagent || si),
    subType: row.subagentTypeName || si?.subagentTypeName || '',
    parentId: si?.parentComposerId || '',
    name: typeof v.name === 'string' ? v.name : '',
    draft: !!v.isDraft,
    pending: !!v.hasBlockingPendingActions,
    mode: typeof v.unifiedMode === 'string' ? v.unifiedMode : '',
    cwd,
    branch,
  };
}

async function ideWorkerMain() {
  let sqlite = null;
  try {
    sqlite = await import('node:sqlite');
  } catch {}
  parentPort.on('message', (req) => {
    const t0 = performance.now();
    const out = { seq: req.seq, ok: false, headers: [], data: [], recent: [], partial: false, ms: 0, error: '' };
    let db;
    try {
      if (!sqlite?.DatabaseSync) throw new Error('node:sqlite unavailable');
      db = new sqlite.DatabaseSync(req.dbPath, { readOnly: true, timeout: 200 });
      const over = () => performance.now() - t0 > req.budgetMs;
      const headers = new Map();
      const cols = 'composerId, createdAt, lastUpdatedAt, checkpointAt, isArchived, isSubagent, subagentTypeName, value';
      let byId = null;
      try {
        // Index range scan on idx(recency, composerId): the composers touched inside the window.
        const rows = db.prepare(`select ${cols} from composerHeaders where recency >= ? order by recency desc limit 200`).all(req.since);
        for (const r of rows) {
          headers.set(r.composerId, slimHeader(r));
          out.recent.push(r.composerId);
        }
        byId = db.prepare(`select ${cols} from composerHeaders where composerId = ?`);
      } catch {
        /* older Cursor without the composerHeaders table: fall back to composerData below */
      }
      if (byId) {
        for (const id of [...req.ids, ...req.subIds]) {
          if (headers.has(id)) continue;
          if (over()) {
            out.partial = true;
            break;
          }
          try {
            const r = byId.get(id);
            if (r) headers.set(id, slimHeader(r));
          } catch {}
        }
      }
      // Point lookups on the unique key index; json_extract keeps the (100 KB+) blobs inside sqlite.
      const dataQ = db.prepare(
        `select json_extract(value,'$.status') as status,
                json_extract(value,'$.modelConfig.modelName') as model,
                json_extract(value,'$.contextTokensUsed') as tokens,
                json_array_length(value,'$.fullConversationHeadersOnly') as bubbles,
                json_array_length(value,'$.generatingBubbleIds') as generating,
                json_extract(value,'$.lastUpdatedAt') as lastUpdatedAt,
                json_extract(value,'$.createdAt') as createdAt,
                json_extract(value,'$.name') as name,
                json_extract(value,'$.fullConversationHeadersOnly[0].bubbleId') as firstBubble
           from cursorDiskKV where key = ?`,
      );
      const bubbleQ = db.prepare(`select json_extract(value,'$.text') as text from cursorDiskKV where key = ?`);
      const known = new Set(req.ids);
      const extra = out.recent.filter((id) => {
        const h = headers.get(id);
        return !known.has(id) && h && !h.isSub && !h.draft && !h.archived;
      });
      for (const id of [...req.ids, ...extra.slice(0, 20)]) {
        if (over()) {
          out.partial = true;
          break;
        }
        try {
          const r = dataQ.get(`composerData:${id}`);
          if (!r) continue;
          const d = {
            status: typeof r.status === 'string' ? r.status : '',
            model: typeof r.model === 'string' ? r.model : '',
            tokens: Number(r.tokens) || 0,
            bubbles: Number(r.bubbles) || 0,
            generating: Number(r.generating) || 0,
            lastUpdatedAt: Number(r.lastUpdatedAt) || 0,
            firstText: '',
          };
          if (!headers.has(id)) {
            headers.set(id, { ...slimHeader({ value: '{}' }), createdAt: Number(r.createdAt) || 0, lastUpdatedAt: d.lastUpdatedAt, name: typeof r.name === 'string' ? r.name : '' });
          }
          if (!known.has(id) && d.bubbles > 0 && typeof r.firstBubble === 'string') {
            try {
              const b = bubbleQ.get(`bubbleId:${id}:${r.firstBubble}`);
              if (typeof b?.text === 'string') d.firstText = b.text.slice(0, 600);
            } catch {}
          }
          out.data.push([id, d]);
        } catch {
          /* malformed JSON blob - skip this composer */
        }
      }
      out.headers = [...headers];
      out.ok = true;
    } catch (err) {
      out.error = String(err?.message || err);
    } finally {
      try {
        db?.close();
      } catch {}
    }
    out.ms = performance.now() - t0;
    parentPort.postMessage(out);
  });
}

// --- Assembly ---------------------------------------------------------------

function subagentsFor(e, subs, now, snap, parentEnded) {
  const t = e.tail;
  /** @type {import('../contract.mjs').Subagent[]} */
  const out = [];
  if (!subs.length && !t.tasks.length) return out;
  const turnStart = t.lastUserTs && t.lastUserTs <= e.mtimeMs + 60_000 ? t.lastUserTs : 0;
  const cut = turnStart ? turnStart - 60_000 : e.mtimeMs - 30 * 60_000;
  const byResume = new Map();
  const byPrompt = new Map();
  for (const task of t.tasks) {
    task.matched = false;
    if (task.resume) byResume.set(task.resume, task);
    else if (task.promptKey && !byPrompt.has(task.promptKey)) byPrompt.set(task.promptKey, task);
  }
  const built = [];
  for (const s of subs) {
    const age = now - s.mtimeMs;
    if (s.mtimeMs < cut && age > FRESH_MS) continue;
    if (built.length >= MAX_SUBS) break;
    ensureParsed(s);
    const hh = snap?.headers.get(s.id);
    const task = byResume.get(s.id) || byPrompt.get(s.head.promptKey) || null;
    if (task) {
      task.matched = true;
      if (!task.resume) byPrompt.delete(s.head.promptKey);
    }
    built.push({ s, hh, task, age, startedAt: hh?.createdAt || s.birthMs || s.mtimeMs });
  }
  // Task calls that could not be paired by prompt: pair with a child that appeared around the same time.
  const loose = t.tasks.filter((task) => !task.matched && task.trailing && !task.resume);
  for (const task of loose) {
    const b = built.find((x) => !x.task && x.startedAt >= e.mtimeMs - 120_000);
    if (b) {
      b.task = task;
      task.matched = true;
    }
  }
  for (const { s, hh, task, age, startedAt } of built) {
    const st = s.tail;
    let status = /** @type {'working'|'done'|'failed'} */ ('working');
    if (st.endStatus) status = st.endStatus === 'error' ? 'failed' : 'done';
    else if (age > FRESH_MS) {
      const parentMovedOn = parentEnded && e.mtimeMs >= s.mtimeMs && !task?.background;
      const legacyDone = !s.sawTurnEnded && st.lastKind === 'text' && age > LEGACY_QUIET_MS;
      if (age > MID_TURN_MAX_MS || parentMovedOn || legacyDone) status = 'done';
    }
    const sub = {
      id: s.id,
      label: oneLine(task?.description || hh?.name || s.head.firstPrompt || 'Subagent', 80),
      status,
      activity: status === 'working' ? (st.turnState === 'unknown' ? { kind: 'thinking', label: 'Starting' } : st.activity) : { kind: 'idle', label: status === 'failed' ? 'Failed' : 'Done' },
      startedAt: Math.min(startedAt, s.mtimeMs),
      lastActivityAt: s.mtimeMs,
    };
    const agentType = task?.agentType || hh?.subType;
    if (agentType) sub.agentType = agentType;
    if (status !== 'working') sub.endedAt = s.mtimeMs;
    out.push(sub);
  }
  // A Task call at the very end of the log with no child transcript yet: it has just been spawned.
  if (!parentEnded && now - e.mtimeMs <= MID_TURN_MAX_MS) {
    let n = 0;
    for (const task of t.tasks) {
      n++;
      if (task.matched || !task.trailing || task.resume) continue;
      const sub = {
        id: `task-${n}`,
        label: oneLine(task.description || task.promptKey || 'Subagent', 80),
        status: /** @type {'working'} */ ('working'),
        activity: { kind: 'thinking', label: 'Starting' },
        startedAt: e.mtimeMs,
        lastActivityAt: e.mtimeMs,
      };
      if (task.agentType) sub.agentType = task.agentType;
      out.push(sub);
    }
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

function sourceFor(id, header, snap) {
  if (header) return 'ide'; // the IDE store knows this conversation
  if (!cfg.stateDb || state.ide.dbOk === false) return 'cli'; // no IDE store on this machine at all
  return snap?.asked.has(id) ? 'cli' : 'unknown'; // looked up and absent = written by cursor-agent
}

function buildSession(e, subs, now, snap) {
  ensureParsed(e);
  const t = e.tail;
  const h = snap?.headers.get(e.id);
  const d = snap?.data.get(e.id);
  let turnState = t.turnState;
  let activity = t.activity;
  let lastActivityAt = e.mtimeMs;

  // Nothing readable in the file and nothing known about it elsewhere: not a session we can show.
  if (t.turnState === 'unknown' && !e.head.firstPrompt && !h) return null;

  const ideGenerating = !!d && (d.status === 'generating' || d.generating > 0);
  if (turnState === 'mid' && t.lastKind === 'text' && !e.sawTurnEnded && !ideGenerating && now - e.mtimeMs > LEGACY_QUIET_MS) {
    // Transcript from a Cursor build that never wrote turn_ended markers.
    turnState = 'ended';
    activity = { kind: 'waiting', label: 'Waiting for you' };
  }
  if (turnState === 'unknown' && d) turnState = ideGenerating ? 'mid' : d.status === 'completed' || d.status === 'aborted' ? 'ended' : 'unknown';
  if (ideGenerating && turnState === 'ended' && !t.ask) {
    // A follow-up prompt was submitted but the transcript has not been checkpointed yet.
    const ideAt = Math.max(h?.lastUpdatedAt || 0, h?.checkpointAt || 0, d.lastUpdatedAt || 0);
    if (ideAt > e.mtimeMs + 2_000) {
      turnState = 'mid';
      activity = { kind: 'thinking', label: 'Thinking' };
      lastActivityAt = Math.max(lastActivityAt, Math.min(ideAt, now));
    }
  }
  if (h?.pending && turnState === 'mid' && snap.at >= e.mtimeMs) {
    // Cursor is showing an approval / question prompt (and the log has not moved since we looked):
    // the agent is blocked on the human.
    turnState = 'ended';
    activity = { kind: 'waiting', label: 'Waiting for approval' };
  }

  for (const s of subs) if (s.mtimeMs > lastActivityAt) lastActivityAt = s.mtimeMs;
  const subagents = subagentsFor(e, subs, now, snap, turnState === 'ended');
  const working = subagents.filter((s) => s.status === 'working').length;
  if (turnState === 'mid' && activity.kind === 'delegating' && working > 1) activity = { kind: 'delegating', label: `Running ${working} agents` };

  /** @type {import('../contract.mjs').AdapterSession} */
  const s = {
    tool: 'cursor',
    nativeId: e.id,
    title: oneLine(h?.name || e.head.firstPrompt || 'Cursor chat', 120),
    cwd: h?.cwd || cwdFromSlug(e.slug),
    source: sourceFor(e.id, h, snap),
    turnState,
    startedAt: Math.min(h?.createdAt || e.head.firstTs || e.birthMs || e.mtimeMs, lastActivityAt),
    lastActivityAt,
    activity: { kind: activity.kind, label: oneLine(activity.label, 60) },
    subagents,
  };
  if (h?.branch) s.branch = h.branch;
  if (d?.model) s.model = d.model;
  if (d?.tokens) s.tokens = d.tokens;
  if (t.lastMessage) s.lastMessage = t.lastMessage;
  return s;
}

/** Composers the IDE knows about that have no transcript file yet (first seconds of a new chat). */
function ideOnlySessions(now, maxAgeMs, snap, haveIds) {
  const out = [];
  if (!snap) return out;
  for (const id of snap.recent || []) {
    if (haveIds.has(id)) continue;
    const h = snap.headers.get(id);
    const d = snap.data.get(id);
    if (!h || !d || h.isSub || h.draft || h.archived) continue;
    const generating = d.status === 'generating' || d.generating > 0;
    if (!generating && d.bubbles === 0) continue;
    if (entryById(id)) continue; // it has a transcript (of any age): the transcript path owns it
    const lastActivityAt = Math.min(now, Math.max(h.lastUpdatedAt, h.checkpointAt, d.lastUpdatedAt, h.createdAt));
    if (!lastActivityAt || lastActivityAt < now - maxAgeMs) continue;
    const turnState = generating ? 'mid' : d.status === 'completed' || d.status === 'aborted' ? 'ended' : 'unknown';
    /** @type {import('../contract.mjs').AdapterSession} */
    const s = {
      tool: 'cursor',
      nativeId: id,
      title: oneLine(h.name || userText(d.firstText) || 'Cursor chat', 120),
      cwd: h.cwd || '',
      source: 'ide',
      turnState,
      startedAt: Math.min(h.createdAt || lastActivityAt, lastActivityAt),
      lastActivityAt,
      activity: turnState === 'mid' ? { kind: 'thinking', label: 'Thinking' } : { kind: 'waiting', label: 'Waiting for you' },
      subagents: [],
    };
    if (h.branch) s.branch = h.branch;
    if (d.model) s.model = d.model;
    if (d.tokens) s.tokens = d.tokens;
    out.push(s);
  }
  return out;
}

/** Resolve when `p` settles or after `ms`, whichever is first (leaves no timer behind). */
const settleWithin = (p, ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(() => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * @param {{now?: number, maxAgeMs?: number}} [opts]
 * @returns {Promise<import('../contract.mjs').AdapterSession[]>}
 */
export async function listSessions({ now = Date.now(), maxAgeMs = IDLE_MAX_MS } = {}) {
  try {
    const cands = scan(now, maxAgeMs);
    const ids = cands
      .slice()
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((e) => e.id);
    const subIds = [];
    const subsOf = new Map();
    for (const e of cands) {
      const subs = loadSubs(e, now, maxAgeMs);
      subsOf.set(e, subs);
      for (const se of subs) if (se.mtimeMs >= now - maxAgeMs - SUB_GRACE_MS) subIds.push(se.id);
    }
    const pending = maybeRefreshIde(now, maxAgeMs, ids, subIds);
    if (pending && !state.ide.snap && state.ide.failures === 0 && cfg.ideColdWaitMs > 0) await settleWithin(pending, cfg.ideColdWaitMs);
    const snap = state.ide.snap;

    const out = [];
    const have = new Set();
    for (const e of cands) {
      try {
        const s = buildSession(e, subsOf.get(e) || [], now, snap);
        have.add(e.id);
        if (s && s.lastActivityAt >= now - maxAgeMs) out.push(s);
      } catch {
        /* one bad transcript must not hide the others */
      }
    }
    try {
      out.push(...ideOnlySessions(now, maxAgeMs, snap, have));
    } catch {}
    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return out;
  } catch {
    return [];
  }
}

// --- Transcript -------------------------------------------------------------

function findEntry(nativeId) {
  let id = String(nativeId ?? '');
  if (!id || /[\\/]/.test(id)) return null;
  let subId = '';
  if (id.includes('#')) [id, subId] = id.split('#');
  let e = entryById(id);
  if (!e) {
    discover(Date.now());
    e = entryById(id);
  }
  if (subId) {
    if (!e) return state.subIndex.get(subId) || null;
    const f = path.join(e.dir, 'subagents', `${subId}.jsonl`);
    return { id: subId, slug: e.slug, dir: path.dirname(f), file: f, mtimeMs: 0, size: 0, birthMs: 0, statAt: 0 };
  }
  return e || state.subIndex.get(id) || null;
}

/**
 * @param {string} nativeId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<import('../contract.mjs').Message[]>}
 */
export async function getTranscript(nativeId, { limit = 60 } = {}) {
  try {
    const e = findEntry(nativeId);
    if (!e) return [];
    const st = statOrNull(e.file);
    if (!st || !st.isFile()) return [];
    const max = Math.max(1, Math.min(500, Number(limit) || 60));
    const birth = st.birthtimeMs > 0 && st.birthtimeMs <= st.mtimeMs ? st.birthtimeMs : st.mtimeMs;
    const recs = readTailRecords(e.file, st.size, Math.max(cfg.tailBytes, 512 * 1024));
    /** @type {import('../contract.mjs').Message[]} */
    const msgs = [];
    let clock = 0;
    for (const r of recs) {
      if (r.role === 'user') {
        const raw = recText(r);
        const ts = userTimestamp(raw);
        if (ts > clock) clock = ts;
        const text = userText(raw);
        if (text) msgs.push({ role: 'user', text: text.slice(0, 2000), ts: clock || birth });
      } else if (r.role === 'assistant') {
        for (const it of contentItems(r)) {
          if (it.type === 'text' && typeof it.text === 'string' && it.text.trim()) {
            msgs.push({ role: 'assistant', text: it.text.trim().slice(0, 2000), ts: clock || birth });
          } else if (isToolUse(it)) {
            const d = describeTool(it.name, it.input);
            const name = String(it.name || 'tool');
            msgs.push({ role: 'tool', text: `${name}: ${d.summary}`.slice(0, 2000), ts: clock || birth, toolName: name });
          }
        }
      }
    }
    const out = msgs.slice(-max);
    // No per-record clock in the log: the newest message is as old as the file's last write.
    if (out.length) out[out.length - 1].ts = Math.max(out[out.length - 1].ts, Math.min(st.mtimeMs, Date.now()));
    for (let i = out.length - 2; i >= 0; i--) if (out[i].ts > out[i + 1].ts) out[i].ts = out[i + 1].ts;
    return out;
  } catch {
    return [];
  }
}

/** Diagnostics for the main block and tests. */
export function _debug() {
  const ide = state.ide;
  return {
    config: { ...cfg },
    transcripts: state.files.size,
    projects: state.projects.size,
    ide: { enabled: ideEnabled(), hasSnapshot: !!ide.snap, lastMs: ide.lastMs, failures: ide.failures, lastError: ide.lastError, headers: ide.snap?.headers.size ?? 0, pending: !!ide.pending },
  };
}

/** Wait for an in-flight IDE refresh (tests / main block). */
export async function _settle() {
  if (state.ide.pending) await state.ide.pending;
}

// --- Entry points -----------------------------------------------------------

if (!isMainThread && workerData?.agentOfficeCursorIde) {
  ideWorkerMain();
} else if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const maxAgeMs = Number(process.argv[2]) > 0 ? Number(process.argv[2]) * 60_000 : IDLE_MAX_MS;
  const fmt = (ms) => `${ms.toFixed(1)} ms`;
  const t0 = performance.now();
  let sessions = await listSessions({ now: Date.now(), maxAgeMs });
  const cold = performance.now() - t0;
  await _settle();
  const warm = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    sessions = await listSessions({ now: Date.now(), maxAgeMs });
    warm.push(performance.now() - t);
  }
  warm.sort((a, b) => a - b);
  const dbg = _debug();
  let dbSize = 0;
  try {
    dbSize = fs.statSync(cfg.stateDb).size;
  } catch {}
  console.log(`cursor: ${sessions.length} session(s) in the last ${Math.round(maxAgeMs / 60_000)} min  (${dbg.transcripts} transcripts indexed in ${dbg.projects} projects)`);
  for (const s of sessions) {
    const age = Math.round((Date.now() - s.lastActivityAt) / 1000);
    console.log(
      `  ${s.nativeId.slice(0, 8)}  ${String(s.source).padEnd(4)} ${s.turnState.padEnd(7)} ${String(age).padStart(5)}s ago  [${s.activity.kind}] ${s.activity.label}  | ${oneLine(s.title, 50)}  | ${s.cwd || '-'}${s.branch ? ` @${s.branch}` : ''}${s.model ? `  (${s.model})` : ''}`,
    );
    for (const a of s.subagents) console.log(`      - ${a.id.slice(0, 8)} ${a.status.padEnd(7)} ${a.agentType || '?'}: ${oneLine(a.label, 50)}  [${a.activity.kind}] ${a.activity.label}`);
  }
  console.log(`timings: cold ${fmt(cold)}; warm p50 ${fmt(warm[warm.length >> 1])}, max ${fmt(warm[warm.length - 1])} (n=${warm.length})`);
  console.log(
    `ide store: ${dbg.ide.enabled ? `${(dbSize / 2 ** 30).toFixed(2)} GiB, last refresh ${fmt(dbg.ide.lastMs)} in worker, ${dbg.ide.headers} headers, failures ${dbg.ide.failures}${dbg.ide.lastError ? `, ${dbg.ide.lastError}` : ''}` : 'not available'}`,
  );
  if (sessions[0]) {
    const t = performance.now();
    const msgs = await getTranscript(sessions[0].nativeId, { limit: 60 });
    console.log(`transcript(${sessions[0].nativeId.slice(0, 8)}): ${msgs.length} messages in ${fmt(performance.now() - t)} (${msgs.filter((m) => m.role === 'tool').length} tool, ${msgs.filter((m) => m.role === 'user').length} user)`);
  }
  process.exit(0);
}
