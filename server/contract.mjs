// Shared contract for Agent Office.
// Every adapter, the server, and the browser UI agree on the shapes in this file.
// The JSON the browser receives is exactly `OfficeState`.

export const TOOLS = /** @type {const} */ (['claude', 'codex', 'cursor']);

export const PORT = 4477;

// --- Time thresholds (ms) -------------------------------------------------
export const FRESH_MS = 20_000; // any write this recent counts as working
export const MID_TURN_MAX_MS = 10 * 60_000; // mid-turn with no writes for longer than this = stalled -> idle
export const WAITING_MAX_MS = 5 * 60_000; // turn ended this recently = waiting on the human, still at the desk
export const IDLE_MAX_MS = 60 * 60_000; // older than this = left the office (not returned at all)
export const SUBAGENT_LINGER_MS = 3 * 60_000; // finished subagents stay in the room this long

/**
 * @typedef {'claude'|'codex'|'cursor'} Tool
 *
 * @typedef {'working'|'waiting'|'idle'} Status
 *   working = mid-turn right now (typing at the desk)
 *   waiting = turn finished, waiting for the human (at the desk, hand up)
 *   idle    = nothing for 5-60 minutes (break area)
 *
 * @typedef {'thinking'|'reading'|'editing'|'running'|'searching'|'browsing'|'delegating'|'writing'|'waiting'|'idle'} ActivityKind
 *
 * @typedef {Object} Activity
 * @property {ActivityKind} kind
 * @property {string} label   Short human line, <= 60 chars. e.g. "Edit launcher.mjs", "Bash: npm test", "Thinking"
 *
 * @typedef {Object} Subagent
 * @property {string} id            Unique within the parent session
 * @property {string} label         What it was asked to do (task description), <= 80 chars
 * @property {string} [agentType]   e.g. "Explore", "general-purpose"
 * @property {'working'|'done'|'failed'} status
 * @property {Activity} activity
 * @property {number} startedAt     ms epoch
 * @property {number} lastActivityAt ms epoch
 * @property {number} [endedAt]     ms epoch, when status != working
 * @property {string} [name]        Filled in by the server (state.mjs), not by adapters
 *
 * @typedef {'mid'|'ended'|'unknown'} TurnState
 *   mid   = the agent owes more output (last record is a user prompt, a tool call, a tool result, partial output)
 *   ended = the agent finished its turn and is waiting for the human
 *
 * @typedef {Object} AdapterSession   What an adapter returns from listSessions()
 * @property {Tool} tool
 * @property {string} nativeId        The tool's own session id
 * @property {string} title           First user prompt or the tool's own summary/title, one line, <= 120 chars
 * @property {string} cwd             Absolute working directory ('' if unknown)
 * @property {string} [branch]
 * @property {string} [model]
 * @property {'cli'|'desktop'|'ide'|'cloud'|'unknown'} [source]
 * @property {TurnState} turnState
 * @property {number} startedAt       ms epoch
 * @property {number} lastActivityAt  ms epoch (last write to the session's own log or any of its subagents' logs)
 * @property {Activity} activity      What it is doing right now (or did last)
 * @property {string} [lastMessage]   Latest assistant prose, <= LAST_MESSAGE_MAX chars, paragraph breaks kept (use clipText)
 * @property {number} [tokens]        Rough total tokens used, if cheaply available
 * @property {Subagent[]} subagents   Subagents spawned in the current/most recent turn. [] if none.
 *
 * @typedef {AdapterSession & {
 *   id: string,                      // `${tool}:${nativeId}` - the id the UI uses everywhere
 *   name: string,                    // deterministic nickname, e.g. "RIKO"
 *   project: string,                 // short project label derived from cwd
 *   status: Status,
 *   mode: 'solo'|'orchestrator',     // orchestrator = has a working subagent, or one that ended < SUBAGENT_LINGER_MS ago
 *   taskId?: string                  // set when this session was launched from the office UI
 * }} Session
 *
 * --- Naming and grouping (user-owned metadata, stored by the server in ~/.agent-office/meta.json) ---
 *
 * Every Session additionally carries:
 *   label?: string      A name the user gave this task (<= 60 chars). Where the UI shows a session's title it
 *                       shows `label` instead when present (the original `title` stays available as detail).
 *   groupId?: string    The Group this session belongs to: an explicit assignment, else the first group (by
 *                       `order`) one of whose `autoDirs` is the session's cwd or an ancestor of it.
 *
 * UI-derived (NOT sent by the server; the shell adds it to each session before handing state to the world):
 *   unanswered?: boolean  The agent finished its turn more than WAITING_MAX_MS ago (status 'idle', turnState
 *                         'ended') and the user has not looked at it since. It has left its desk for the break
 *                         room, but it is still waiting on the human: show a quiet, non-flashing "!" and count
 *                         it as "older" needs-you. Cleared when the user selects the agent.
 *
 * Colour rules shared by world and shell: bright yellow means "needs you" and nothing else; selection is
 * white plus a shape (ring / brackets / arrow); keyboard focus is a white ring; tool identity is coral /
 * mint / violet-blue; group colours come from public/js/groups.js; red is failure.
 *
 * @typedef {'gold'|'rose'|'lime'|'sky'|'plum'|'sand'} GroupColor   Hex values live in public/js/groups.js.
 *           Deliberately distinct from the tool colours (coral / mint / violet-blue).
 *
 * @typedef {Object} Group
 * @property {string} id
 * @property {string} name          <= 24 chars, shown uppercase in the office
 * @property {GroupColor} color
 * @property {string[]} autoDirs    Absolute folders; sessions working in or under one join this group automatically
 * @property {number} order         Sort key (ascending). Groups render in this order everywhere.
 *
 * @typedef {Object} Message          Normalised transcript line
 * @property {'user'|'assistant'|'tool'|'system'} role   system = written by the agent harness, not by the human (crew reports, task notices)
 * @property {string} text            Plain text, <= 2000 chars. For role=tool: "ToolName: short input summary"
 * @property {number} ts              ms epoch
 * @property {string} [toolName]
 *
 * @typedef {'read'|'edit'|'full'} Permission
 *   read = read-only / plan, edit = may edit files in cwd but no unrestricted shell, full = no prompts at all
 *
 * @typedef {Object} Task             A run started from the office UI
 * @property {string} id
 * @property {Tool} tool
 * @property {string} prompt
 * @property {string} cwd
 * @property {Permission} permission
 * @property {'starting'|'running'|'done'|'failed'|'stopped'} status
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {number|null} [exitCode]
 * @property {string} [sessionId]     `${tool}:${nativeId}` once known
 * @property {string} outputTail      Last ~4000 chars of human-readable output
 * @property {string} [resumeOf]      session id when this task is a follow-up message to an existing session
 * @property {string} [model]         model override passed at launch, if any
 * @property {string} [label]         name given at launch (applied to the session's meta once its id is known)
 * @property {string} [groupId]       group chosen at launch (likewise)
 *
 * @typedef {Object} OfficeState
 * @property {number} now
 * @property {Session[]} sessions
 * @property {Task[]} tasks           Tasks from this server run, newest first
 * @property {Record<Tool, {available: boolean, version?: string, signedIn?: boolean}>} tools
 *           signedIn: false = the CLI is installed but signed out, so launching from the office will fail
 *           until the user signs in from a terminal; absent = unknown.
 * @property {string[]} recentDirs    Distinct cwds seen recently, most recent first (for the folder picker)
 * @property {Group[]} groups         All groups, sorted by `order` (including ones with no sessions right now)
 * @property {boolean} [mock]
 */

/**
 * Every adapter module (server/adapters/<tool>.mjs) exports:
 *
 *   export const tool = 'claude';
 *   export async function listSessions({ now, maxAgeMs }) -> AdapterSession[]
 *        Only sessions with lastActivityAt >= now - maxAgeMs. Must be cheap: it is called every ~2s.
 *        Stat first, read only files that changed (cache by path+mtime+size), read tails not whole files.
 *        Must never throw for a malformed/missing file - skip it.
 *   export async function getTranscript(nativeId, { limit }) -> Message[]
 *        Most recent `limit` messages, oldest first.
 */

/**
 * @param {TurnState} turnState
 * @param {number} lastActivityAt
 * @param {number} now
 * @returns {Status|null} null = too old, drop the session
 */
export function deriveStatus(turnState, lastActivityAt, now) {
  const age = now - lastActivityAt;
  if (age > IDLE_MAX_MS) return null;
  if (age <= FRESH_MS) return turnState === 'ended' ? 'waiting' : 'working';
  if (turnState === 'ended') return age <= WAITING_MAX_MS ? 'waiting' : 'idle';
  if (turnState === 'mid') return age <= MID_TURN_MAX_MS ? 'working' : 'idle';
  return age <= WAITING_MAX_MS ? 'waiting' : 'idle';
}

/** Longest lastMessage the server passes on. Long enough to read a real reply in the dialogue. */
export const LAST_MESSAGE_MAX = 2400;

/** Clip prose to n chars, keeping paragraph breaks (unlike oneLine). */
export function clipText(s, n = LAST_MESSAGE_MAX) {
  const t = String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** Clip to one line of at most n chars. */
export function oneLine(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/* ---------------------------------------------------------------------------
 * HTTP API (server/index.mjs), all JSON, bound to 127.0.0.1 only
 *
 *   GET  /api/state                         -> OfficeState
 *   GET  /api/events                        -> SSE; `data: <OfficeState JSON>` whenever it changes (and at least every 5s)
 *   GET  /api/sessions/:id/transcript?limit=60 -> { messages: Message[] }
 *   GET  /api/dirs?path=/abs/path           -> { path, parent, dirs: string[] }   (sub-directory names, for the folder picker)
 *   POST /api/tasks      { tool, prompt, cwd, permission, model? }   -> { task: Task }
 *   POST /api/sessions/:id/message { prompt, permission? }           -> { task: Task }   (resume that session with a follow-up)
 *   POST /api/tasks/:id/stop                                         -> { task: Task }
 *   GET  /api/meta                                                   -> { permissionNotes, port, mock }
 *
 *   Naming and grouping:
 *   POST /api/sessions/:id/meta { label?: string|null, groupId?: string|null }  -> { id, label?, groupId? }
 *        label: null or '' clears the name. groupId: a group id assigns explicitly; null removes the explicit
 *        assignment (an autoDirs rule may then apply); the literal 'none' pins the session to "no group" even
 *        when an autoDirs rule matches. Works for any session id, on the floor right now or not.
 *   POST /api/groups            { name, color?, autoDirs? }             -> { group: Group }   (color defaults to the least-used)
 *   POST /api/groups/:id        { name?, color?, autoDirs?, order? }    -> { group: Group }
 *   POST /api/groups/:id/delete                                         -> { ok: true }       (its sessions become ungrouped)
 *   POST /api/tasks and POST /api/sessions/:id/message also accept { label?, groupId? }; they are applied to the
 *        task's session as soon as its id is known, and are echoed on the Task as `label` / `groupId`.
 *
 *   POSTs must carry header `X-Office-Token: <token>`; the server injects the token into index.html as
 *   <meta name="office-token" content="...">. Requests whose Host header is not 127.0.0.1/localhost are rejected.
 *
 * Browser world module (public/js/world/index.js):
 *
 *   export function createOffice(canvas) -> {
 *     setState(state: OfficeState): void     // full snapshot every time; diff by session.id internally
 *     select(id: string|null): void          // highlight + pan to that session (or subagent id `${sessionId}#${subagentId}`)
 *     onSelect(fn: (id: string|null) => void): void   // user clicked a character / empty floor
 *     resize(): void
 *     destroy(): void
 *   }
 *   export function drawPortrait(canvas, session, subagent?): void   // face close-up for the dialogue box
 * ------------------------------------------------------------------------- */
