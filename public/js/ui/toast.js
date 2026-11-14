// Toasts: short notes for things that are not otherwise visible (a task finished or failed, a new hire,
// an error, a confirmation). Announced politely.
// Their lane is the bottom-right corner of the office view, just above the bottom box (chrome.css positions
// #toasts from the live insets): it covers a strip of floor, never the top bar, the room banners, the
// roster or the transcript. Newest at the bottom; at most TWO at a time (the needs-you call-out included).
import { h, setText, setHidden, setClass } from './dom.js';

let host = null;
const LANE_MAX = 2;

export function initToasts(hostEl) {
  host = hostEl;
}

/** Never a pile: the oldest plain note makes room first, then a line, a card only when there is nothing else. */
function trim(keep) {
  if (!host) return;
  while (host.children.length > LANE_MAX) {
    const kids = [...host.children].filter((c) => c !== keep);
    const old = kids.find((c) => !c.classList.contains('toast-card') && !c.classList.contains('toast-line') && !c.classList.contains('toast-needs'))
      || kids.find((c) => !c.classList.contains('toast-card') && !c.classList.contains('toast-needs'))
      || kids.find((c) => !c.classList.contains('toast-needs'))
      || kids[0];
    if (!old) break;
    old.remove();
  }
}

/**
 * toast('NEW HIRE!', { kind: 'pow' | 'info' | 'error', detail, ms, onClick })
 *   With onClick the whole toast is a real button (and goes away when pressed).
 * toast('ZED', { kind: 'error', line: true, detail: 'FAILED', title, actions: [{ label, onClick, primary }] })
 *   One line with its buttons in it: a name, a word, what to do. It waits while hovered or focused.
 * toast('KNOCKED OUT!', { kind: 'error', detail, lines: [...], note: Node|string, actions: [...], compact })
 *   A card: output lines in monospace, buttons underneath, a close button; it waits while hovered or focused.
 *   compact: a small card (a title, a line, a button) instead of the full-width one.
 * Returns { el, close() }.
 */
export function toast(text, { kind = 'info', detail = '', ms, onClick, lines, note, actions, compact = false, line = false, title = '' } = {}) {
  if (!host) return null;
  const card = !line && (!!(actions && actions.length) || !!(lines && lines.length) || !!note);
  let el;
  let timer = 0;
  const close = () => { clearTimeout(timer); el.remove(); };
  const xBtn = () => h('button', { class: 'btn btn-x btn-x-mini toast-x', type: 'button', title: 'Dismiss', attrs: { 'aria-label': 'Dismiss' }, on: { click: close } },
    h('span', { class: 'ico ico-x', attrs: { 'aria-hidden': 'true' } }));
  const actionBtns = () => (actions || []).map((a) => h('button', {
    class: `btn btn-mini${a.primary ? ' toast-primary' : ''}`, type: 'button', text: a.label,
    on: { click: () => { close(); a.onClick(); } },
  }));
  if (line) {
    el = h('div', { class: `toast toast-${kind} toast-line`, title: title || null, attrs: { role: 'status' } },
      h('span', { class: 'toast-text', text }),
      detail ? h('span', { class: 'toast-detail', text: detail }) : null,
      h('span', { class: 'toast-actions' }, actionBtns()),
      xBtn());
  } else if (card) {
    el = h('div', { class: `toast toast-${kind} toast-card${compact ? ' is-compact' : ''}`, attrs: { role: 'status' } },
      h('div', { class: 'toast-head' }, h('span', { class: 'toast-text', text }), xBtn()),
      detail ? h('span', { class: 'toast-detail', text: detail, title: detail }) : null,
      lines && lines.length ? h('pre', { class: 'toast-lines', text: lines.join('\n') }) : null,
      note ? h('div', { class: 'toast-note' }, note) : null,
      actions && actions.length ? h('div', { class: 'toast-actions' }, actionBtns()) : null);
  } else {
    const kids = [h('span', { class: 'toast-text', text }), detail ? h('span', { class: 'toast-detail', text: detail }) : null];
    el = onClick
      ? h('button', { class: `toast toast-${kind} toast-btn`, type: 'button', on: { click: () => { close(); onClick(); } } }, kids)
      : h('div', { class: `toast toast-${kind}`, attrs: { role: 'status' } }, kids);
  }
  host.appendChild(el);
  trim(el);

  const waits = card || line;
  const life = ms || (card ? 20000 : line ? 15000 : kind === 'error' ? 6000 : 2800);
  const leave = () => {
    if (waits && (el.matches(':hover') || el.contains(document.activeElement))) { timer = setTimeout(leave, 2500); return; }
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  timer = setTimeout(leave, life);
  return { el, close };
}

/**
 * The one "needs you" call-out. There is never more than one: it is updated in place and counts.
 *   createNeedToast({ onNext() }) -> { show(names: string[], { ms, quiet, where }), update(names), clear(), isShown() }
 * show() with one name reads "HANK needs you" + FIND; with more, "3 agents need you" + NEXT. It always leaves by
 * itself after `ms` (it waits while hovered or focused).
 *   quiet: a dark single line (somebody is off screen) instead of the yellow summary.
 * Its words change at most once every TEXT_MIN_MS: a burst of arrivals is one update, not a ticker.
 */
const TEXT_MIN_MS = 10_000;

export function createNeedToast({ onNext }) {
  const text = h('span', { class: 'toast-text' });
  const detail = h('span', { class: 'toast-detail' });
  const go = h('button', { class: 'btn btn-mini toast-go', type: 'button', on: { click: () => { clear(); onNext(); } } });
  const x = h('button', { class: 'btn btn-x btn-x-mini toast-x', type: 'button', title: 'Dismiss', attrs: { 'aria-label': 'Dismiss' }, on: { click: () => clear() } },
    h('span', { class: 'ico ico-x', attrs: { 'aria-hidden': 'true' } }));
  const el = h('div', { class: 'toast toast-needs', attrs: { role: 'status' } }, h('span', { class: 'toast-bang', text: '!', attrs: { 'aria-hidden': 'true' } }), text, detail, go, x);
  let timer = 0;
  let textTimer = 0;
  let shown = false;
  let paintedAt = 0;
  let paintedKey = '';
  let next = null; // the words waiting for their turn

  function clear() {
    clearTimeout(timer);
    clearTimeout(textTimer);
    timer = 0;
    textTimer = 0;
    next = null;
    shown = false;
    el.remove();
  }

  function paint({ names, where }) {
    const one = names.length === 1;
    setText(text, one ? `${names[0]} needs you` : `${names.length} agents need you`);
    setText(detail, where || '');
    setHidden(detail, !where);
    setText(go, one ? `FIND ${names[0]}` : 'NEXT');
    paintedAt = Date.now();
    paintedKey = `${names.join(',')}|${where || ''}`;
  }

  /** New words for a call-out that is already up: at once if it has kept still long enough, else when it has. */
  function setWords(words) {
    const key = `${words.names.join(',')}|${words.where || ''}`;
    if (key === paintedKey) { next = null; clearTimeout(textTimer); textTimer = 0; return; }
    const wait = paintedAt + TEXT_MIN_MS - Date.now();
    if (wait <= 0) { next = null; paint(words); return; }
    next = words;
    if (!textTimer) textTimer = setTimeout(() => { textTimer = 0; if (shown && next) { const w = next; next = null; paint(w); } }, wait);
  }

  function show(names, { ms = 6000, quiet = false, where = '' } = {}) {
    if (!host || !names.length) { clear(); return; }
    setClass(el, 'is-quiet', quiet);
    if (shown && el.isConnected) setWords({ names, where });
    else { clearTimeout(textTimer); textTimer = 0; next = null; paint({ names, where }); }
    if (!el.isConnected) { host.appendChild(el); trim(el); }
    shown = true;
    clearTimeout(timer);
    const leave = () => {
      if (el.matches(':hover') || el.contains(document.activeElement)) { timer = setTimeout(leave, 2000); return; }
      clear();
    };
    timer = setTimeout(leave, ms);
  }

  /** Keep the count honest without restarting its clock. */
  function update(names, { where = '' } = {}) {
    if (!shown) return;
    if (!names.length) { clear(); return; }
    setWords({ names, where });
  }

  return { show, update, clear, isShown: () => shown };
}
