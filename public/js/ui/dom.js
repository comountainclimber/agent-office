// Tiny DOM helpers shared by the UI modules.
// Rule of the house: text that comes from data only ever goes through textContent.

/**
 * h('button', { class: 'btn', text: 'GO', title: 'x', attrs: {'aria-label': 'Go'}, on: { click } }, child, 'text')
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'attrs') for (const a of Object.keys(v)) { if (v[a] != null && v[a] !== false) el.setAttribute(a, v[a] === true ? '' : String(v[a])); }
      else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
      else if (k === 'data') for (const d of Object.keys(v)) el.dataset[d] = v[d];
      else el[k] = v;
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

/** Set textContent only when it changed (keeps selection / avoids needless layout). */
export function setText(el, text) {
  const t = text == null ? '' : String(text);
  if (el.textContent !== t) el.textContent = t;
}

/** Text + matching title attribute, for anything that truncates with an ellipsis. */
export function setTextTitle(el, text) {
  setText(el, text);
  setAttr(el, 'title', text || null);
}

export function setAttr(el, name, value) {
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else {
    const v = value === true ? '' : String(value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }
}

export function setClass(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

export function setHidden(el, hidden) {
  if (el.hidden !== !!hidden) el.hidden = !!hidden;
}

/** Put `el` at index `i` of `parent`, moving it only if needed and keeping focus if it had it. */
export function placeAt(parent, el, i) {
  const cur = parent.children[i];
  if (cur === el) return;
  const hadFocus = el.contains(document.activeElement) ? document.activeElement : null;
  parent.insertBefore(el, cur || null);
  if (hadFocus && document.activeElement !== hadFocus) {
    try { hadFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
}

/**
 * Keyed in-place list update. Elements are created once per key, updated on every call and
 * only moved when their position is wrong, so hover, focus and scroll survive a state tick.
 */
export function reconcile(parent, items, keyOf, create, update) {
  let map = parent.__keyed;
  if (!map) map = parent.__keyed = new Map();
  const seen = new Set();
  let i = 0;
  for (const item of items) {
    const key = keyOf(item, i);
    if (seen.has(key)) continue; // defensive: duplicate keys would thrash
    seen.add(key);
    let el = map.get(key);
    if (!el) {
      el = create(item, key);
      map.set(key, el);
    }
    if (update) update(el, item, i);
    placeAt(parent, el, i);
    i += 1;
  }
  if (map.size !== seen.size) {
    for (const [key, el] of map) {
      if (!seen.has(key)) {
        if (el.parentNode === parent) parent.removeChild(el);
        map.delete(key);
      }
    }
  }
}

// --- formatting ---------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** "5s", "3m 04s", "1h 02m" — compact age. */
export function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad2(s % 60)}s`;
  const hr = Math.floor(m / 60);
  return `${hr}h ${pad2(m % 60)}m`;
}

/** "0:42", "12:05", "1:02:10" — stopwatch. */
export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${pad2(s % 60)}`;
  return `${Math.floor(m / 60)}:${pad2(m % 60)}:${pad2(s % 60)}`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtClockShort(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1000) return `${Math.round(n / 1000)}k tok`;
  return `${n} tok`;
}

/** /Users/name/x -> ~/x (display only). */
export function shortPath(p) {
  if (!p) return '';
  return String(p).replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');
}

export function oneLine(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export const TOOL_INFO = {
  claude: { label: 'CLAUDE', badge: 'CL' },
  codex: { label: 'CODEX', badge: 'CX' },
  cursor: { label: 'CURSOR', badge: 'CU' },
};
export const TOOL_ORDER = ['claude', 'codex', 'cursor'];

export function toolBadge(tool) {
  const info = TOOL_INFO[tool] || { badge: '??', label: String(tool || '?').toUpperCase() };
  return h('span', { class: 'badge', data: { tool: tool || '' }, text: info.badge, title: info.label, attrs: { 'aria-label': info.label } });
}

export const STATUS_LABEL = { working: 'WORKING', waiting: 'NEEDS YOU', idle: 'IDLE', done: 'DONE', failed: 'FAILED' };

/**
 * The status the shell counts and shows. `session.answered` is set by app.js for a moment after the user
 * replied (the `ao:replied` event): the agent no longer needs them, even while the server still says 'waiting'.
 */
export function effStatus(s) {
  if (!s) return '';
  return s.answered && s.status === 'waiting' ? 'working' : s.status;
}

/** 0 = needs you right now, 1 = finished a while ago and not looked at since ("older"), 2 = everyone else. */
export function needRank(s) {
  return effStatus(s) === 'waiting' ? 0 : s.unanswered && !s.answered ? 1 : 2;
}

// ---- one noun each: "crew" for an orchestrator's subagents ---------------------------------------
/** "1 crew member", "3 crew". */
export function crewCount(n) {
  return n === 1 ? '1 crew member' : `${n} crew`;
}

const CREW_NUM = /\b(\d+)\s+(?:sub-?agents?|agents?|helpers?|workers?)\b/gi;
const CREW_LEAD = /^(running|waiting (on|for)|briefing|delegating( to)?|spawn(ed|ing)|launch(ed|ing)|coordinating|managing)\b/i;

/** An activity line as the office words it: "Running 1 agents" -> "Running 1 crew member", "Waiting on 2 subagents" -> "Waiting on 2 crew". */
export function crewWords(label, kind) {
  const t = String(label ?? '');
  if (!t || !(kind === 'delegating' || CREW_LEAD.test(t))) return t;
  return t.replace(CREW_NUM, (_, n) => crewCount(Number(n))).replace(/\bsub-?agents?\b/gi, 'crew');
}

/** "<1m", "12m", "1h 05m": how long someone has been waiting, to the minute (it changes once a minute). */
export function fmtWait(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Scratch folders are never a default place to start work in. */
export function isTempPath(p) {
  return /^\/(private\/)?(tmp|var\/folders)(\/|$)/.test(String(p || ''));
}

/** Small pixel glyph for a status. Purely decorative; pair with a text label for a11y. */
export function statusGlyph(status) {
  return h('span', { class: 'glyph', data: { status: status || '' }, attrs: { 'aria-hidden': 'true' } });
}

export function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* private mode etc. */ }
  },
};
