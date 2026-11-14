// The reply field. It lives where you read: in the dialogue, and at the foot of the transcript.
// Every instance shares one draft, one send state and one permission level per session, so what you
// typed follows you from one surface to the other and survives selecting someone else for a moment.
//
//   createComposer(ctx, { variant }) -> { el, update(session|null, { failed? }), focus(), isFocused(), seed({ prompt, permission }), disarm() }
//   ctx: { api, getSession(id), loadMeta?(), onSent?(task, session), onEscape?(), scrollTarget?(),
//          waitingOthers?(sessionId) -> number, nextWaiting?(dir) }
//
// ONE state machine says where a reply stands (replyState() below); the dialogue's status chip, the
// field's label and the note under it are all read off it, so they cannot disagree:
//
//   waiting / idle -> REPLY              the agent's turn is over: say what happens next
//   working        -> MESSAGE · MID-TURN sending now starts a second run: asks once more
//   armed          -> SEND ANYWAY?       stays armed until the text changes, Esc, the caret leaves, or ARM_MS
//   sending        -> SENDING…
//   sent/answered  -> SENT, then REPLIED until the session writes again (it no longer "needs you")
//   failed         -> the reply or task failed (the box above says why): RETRY
//
// A successful send dispatches `ao:replied` on window: { detail: { sessionId, at } } — treat that session as
// answered until its lastActivityAt moves past `at` (at = 0 takes it back: the run it started failed).
import { h, setText, setAttr, setClass, setHidden, store, STATUS_LABEL } from './dom.js';
import { openPopover } from './modal.js';
import { PERMISSIONS, permissionNote } from './newtask.js';

const ARM_MS = 15_000; // how long SEND ANYWAY stays armed (counted down on screen)
const SENT_MS = 6000; // how long "SENT" stays on the line
const MAX_FIELD_PX = 112; // about five lines, then the field scrolls
const REPLIED_MS = 30_000; // "you answered" stands this long at most if the session never writes again (the same in app.js)
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
export const NEXT_CHORD = IS_MAC ? '⌥Y' : 'ALT+Y';

/** @type {Map<string, {draft: string, posting: boolean, armedUntil: number, conflict: boolean, failed: false|'reply'|'task', note: null|{kind: string, text: string, until?: number}}>} */
const perSession = new Map();
const instances = new Set();
/** session id -> when the user's last reply went out (ms). */
const replied = new Map();
const listeners = new Set();
let seq = 0;

function stateFor(id) {
  let s = perSession.get(id);
  if (!s) {
    if (perSession.size > 300) for (const [k, v] of perSession) { if (!v.draft && !v.posting) perSession.delete(k); }
    s = { draft: '', posting: false, armedUntil: 0, conflict: false, failed: false, note: null };
    perSession.set(id, s);
  }
  return s;
}

const syncAll = (force = false) => {
  for (const c of instances) c.sync(force);
  for (const fn of listeners) { try { fn(); } catch { /* a listener must not break the field */ } }
};

/** Be told whenever a reply's state changed (sent, armed, failed…). Returns the way to stop listening. */
export function onReplyState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Record (at > 0) or take back (at = 0) "the user answered this session", and tell the rest of the shell. */
export function markReplied(sessionId, at) {
  if (!sessionId) return;
  if (at > 0) replied.set(sessionId, at);
  else if (!replied.delete(sessionId)) return;
  try { window.dispatchEvent(new CustomEvent('ao:replied', { detail: { sessionId, at: at > 0 ? at : 0 } })); } catch { /* ignore */ }
}

/** When the last reply to this session went out (0 = none on record). A failure older than that is history. */
export const repliedAt = (sessionId) => replied.get(sessionId) || 0;

/** When the user's reply to this session went out, while it still stands (nothing written since); else 0. */
export function answeredAt(session) {
  if (!session) return 0;
  const at = replied.get(session.id) || 0;
  if (!at) return 0;
  if ((session.lastActivityAt || 0) > at || Date.now() - at > REPLIED_MS) { replied.delete(session.id); return 0; }
  return at;
}

let armTimer = 0;
function watchArmed() {
  const any = [...perSession.values()].some((s) => s.armedUntil > Date.now());
  if (any && !armTimer) armTimer = setInterval(() => { syncAll(); watchArmed(); }, 1000);
  else if (!any && armTimer) { clearInterval(armTimer); armTimer = 0; }
}

function disarmState(s) {
  if (!s || !s.armedUntil) return false;
  s.armedUntil = 0;
  return true;
}

/**
 * Where a reply to `session` stands. Whether its newest office task failed ('reply' | 'task') is told to the
 * field through update(session, { failed }) (see failedTaskFor in dialogue.js) and remembered per session.
 * -> { phase, failed, needsYou, answeredAt, chip: { status, label } }
 */
export function replyState(session, { now = Date.now() } = {}) {
  const s = stateFor(session.id);
  const failed = s.failed;
  const answered = failed ? 0 : (answeredAt(session) || (session.answered ? 1 : 0));
  const sentNote = !failed && s.note && s.note.kind === 'sent' && (!s.note.until || s.note.until > now);
  let phase;
  if (s.posting) phase = 'sending';
  else if (s.armedUntil > now) phase = 'armed';
  else if (failed) phase = 'failed';
  else if (sentNote) phase = 'sent';
  else if (session.status === 'working') phase = 'working';
  else if (answered) phase = 'answered';
  else if (session.status === 'waiting') phase = 'waiting';
  else phase = 'idle';

  const base = { status: session.status, label: STATUS_LABEL[session.status] || String(session.status || '').toUpperCase() };
  let chip = base;
  if (phase === 'failed') chip = { status: 'failed', label: failed === 'reply' ? 'REPLY FAILED' : 'TASK FAILED' };
  else if (phase === 'sending') chip = { status: 'working', label: 'SENDING…' };
  else if (phase === 'armed') chip = { status: 'working', label: STATUS_LABEL.working }; // mid-turn, whatever the last snapshot said
  else if ((phase === 'sent' || phase === 'answered') && session.status !== 'working') chip = { status: 'working', label: 'REPLIED' };
  return { phase, failed, needsYou: phase === 'waiting', answeredAt: answered, chip };
}

export function createComposer(ctx, { variant = 'dlg' } = {}) {
  const K = ctx.api && ctx.api.mode === 'mock' ? 'ao.demo.' : 'ao.';
  const uid = `cmp-${++seq}`;
  let session = null;
  let notes = null;
  let timer = 0;
  let explaining = false; // the first-time note is on screen (from the first focus until the caret leaves or the first send)

  const perm = () => {
    const v = store.get(`${K}reply.perm`, 'edit');
    return PERMISSIONS.some((p) => p.value === v) ? v : 'edit';
  };
  const explained = () => store.get(`${K}reply.explained`, '0') === '1';

  // ------------------------------------------------------------------ parts
  const tagMain = h('span', { class: 'cmp-tag-main' });
  const tagSub = h('span', { class: 'cmp-tag-sub', hidden: true, text: 'MID-TURN' });
  const tag = h('label', { class: 'cmp-tag', attrs: { for: `${uid}-field` } }, tagMain, tagSub);
  const field = h('textarea', {
    class: 'input cmp-field', id: `${uid}-field`, rows: 1, spellcheck: true, autocomplete: 'off',
    attrs: { 'aria-describedby': `${uid}-say`, enterkeyhint: 'send' },
    on: {
      input: () => onInput(),
      keydown: (e) => onKey(e),
    },
  });

  // the note under the field: only there when there is something to say
  const footTag = h('span', { class: 'cmp-foot-tag', hidden: true });
  const footText = h('span', { class: 'cmp-foot-text' });
  const footCount = h('span', { class: 'cmp-foot-count num', hidden: true, attrs: { 'aria-hidden': 'true' } });
  const foot = h('p', { class: 'cmp-foot', hidden: true }, footTag, footText, footCount);
  // the same words for a screen reader, without the ticking countdown
  const say = h('p', { class: 'sr-only', id: `${uid}-say`, attrs: { role: 'status', 'aria-live': 'polite' } });

  // "EDIT FILES": the second word gives way where the field needs the room (a small window with the roster open)
  const permWord = h('span');
  const permRest = h('span', { class: 'cmp-perm-rest' });
  const permLabel = h('span', { class: 'cmp-perm-label' }, permWord, permRest);
  const permBtn = h('button', { class: 'cmp-perm', type: 'button', attrs: { 'aria-haspopup': 'dialog' }, on: { click: () => openPerm() } },
    permLabel, h('span', { class: 'ico ico-down', attrs: { 'aria-hidden': 'true' } }));

  const sendLabel = h('span', { class: 'cmp-send-label', text: 'SEND' });
  const sendBtn = h('button', { class: 'btn cmp-send', type: 'button', on: { click: () => submit() } }, sendLabel, h('kbd', { class: 'sym', text: '↵', attrs: { 'aria-hidden': 'true' } }));
  // pressing the button must not take the caret out of the field (leaving the field stands SEND ANYWAY down)
  sendBtn.addEventListener('pointerdown', (e) => { if (document.activeElement === field) e.preventDefault(); });

  const nextBtn = h('button', { class: 'btn cmp-next', type: 'button', hidden: true, attrs: { 'aria-keyshortcuts': 'Alt+Y' }, on: { click: () => ctx.nextWaiting && ctx.nextWaiting(1) } },
    h('span', { text: 'NEXT' }), h('span', { class: 'ico ico-right', attrs: { 'aria-hidden': 'true' } }), h('kbd', { text: NEXT_CHORD, attrs: { 'aria-hidden': 'true' } }));
  const go = h('div', { class: 'cmp-go' }, sendBtn, nextBtn);

  const el = h('div', { class: `cmp cmp-${variant}`, hidden: true, attrs: { role: 'group' } },
    h('div', { class: 'cmp-row' }, tag, field), permBtn, go, foot, say);

  // the caret left the reply field altogether: an armed SEND ANYWAY stands down, the first-time note has been shown
  el.addEventListener('focusout', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    let changed = false;
    if (session && disarmState(stateFor(session.id))) changed = true;
    if (explaining) { explaining = false; store.set(`${K}reply.explained`, '1'); changed = true; }
    if (changed) syncAll();
  });
  field.addEventListener('focus', () => {
    if (!explaining && !explained()) { explaining = true; sync(); }
  });

  // ------------------------------------------------------------------ behaviour
  let grownFor = null; // the text the field was last sized for (null = never measured while visible)
  function grow() {
    if (!field.offsetParent) { field.style.height = ''; grownFor = null; return; } // not laid out: measure later
    if (!field.value) { field.style.height = ''; field.style.overflowY = 'hidden'; grownFor = ''; return; } // empty: one line, whatever the placeholder does
    field.style.height = 'auto';
    const want = Math.min(MAX_FIELD_PX, field.scrollHeight + 4);
    field.style.overflowY = field.scrollHeight + 4 > MAX_FIELD_PX ? 'auto' : 'hidden';
    field.style.height = `${want}px`;
    grownFor = field.value;
  }

  function later(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => syncAll(), ms + 30);
  }

  function onInput() {
    if (!session) return;
    const s = stateFor(session.id);
    s.draft = field.value;
    if (s.note && s.note.kind !== 'sent') s.note = null;
    if (s.note && s.note.kind === 'sent' && field.value) s.note = null;
    s.armedUntil = 0; // the words changed: ask again
    grow();
    syncAll();
  }

  function onKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const s = session ? stateFor(session.id) : null;
      if (s && s.armedUntil > Date.now()) { s.armedUntil = 0; syncAll(); return; }
      if (ctx.onEscape) ctx.onEscape(); else field.blur();
    } else if ((e.key === 'PageUp' || e.key === 'PageDown') && ctx.scrollTarget) {
      // the field is one line most of the time: let the paging keys read the message above it
      const t = ctx.scrollTarget();
      if (t && field.scrollHeight <= field.clientHeight + 2) {
        e.preventDefault();
        t.scrollBy({ top: (e.key === 'PageDown' ? 1 : -1) * Math.max(40, t.clientHeight - 40) });
      }
    }
    if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') e.stopPropagation();
  }

  const isWorking = (s) => !!s && s.status === 'working';

  function arm(s) {
    s.armedUntil = Date.now() + ARM_MS;
    s.note = null;
    watchArmed();
  }

  async function submit() {
    if (!session) return;
    const target = session;
    const s = stateFor(target.id);
    if (s.posting) return;
    const text = field.value.trim();
    if (!text) {
      s.note = { kind: 'empty', text: 'Write the message first.' };
      syncAll();
      field.focus();
      return;
    }
    const live = (ctx.getSession && ctx.getSession(target.id)) || target;
    const armed = s.armedUntil > Date.now();
    if (!armed && ((isWorking(live) && !s.failed) || s.conflict)) {
      arm(s);
      syncAll();
      return;
    }
    s.posting = true;
    s.armedUntil = 0;
    s.note = null;
    syncAll();
    try {
      const task = await ctx.api.sendMessage(target.id, { prompt: text, permission: perm(), ...(armed ? { force: true } : {}) });
      s.posting = false;
      s.conflict = false;
      s.failed = false; // whatever failed before, this is a new run
      s.draft = '';
      s.note = { kind: 'sent', text: `${target.name} has it. Follow the run in TASKS.`, until: Date.now() + SENT_MS };
      store.set(`${K}reply.explained`, '1');
      explaining = false;
      // it no longer needs you: say so now, not when the next snapshot gets round to it
      const now = Date.now();
      markReplied(target.id, Math.max(now, ((ctx.getSession && ctx.getSession(target.id)) || target).lastActivityAt || 0));
      later(SENT_MS);
      syncAll(true);
      if (ctx.onSent) ctx.onSent(task, target);
    } catch (e) {
      s.posting = false;
      if (e && e.status === 409) {
        // the server says it is mid-turn (it knows better than our last snapshot): same guard, one more press
        s.conflict = true;
        arm(s);
      } else {
        s.note = { kind: 'error', text: e && e.message ? e.message : String(e) };
      }
      syncAll();
    }
  }

  // ------------------------------------------------------------------ permission menu
  function openPerm() {
    if (!session) return;
    const tool = session.tool;
    const pop = openPopover({ anchor: permBtn, className: 'pop-perm', label: 'How much this reply may do', align: 'end' });
    const items = [];
    const list = h('ul', { class: 'menu', attrs: { role: 'menu' } });
    for (const p of PERMISSIONS) {
      const note = permissionNote(notes, tool, p.value);
      const btn = h('button', {
        class: 'menu-item cmp-perm-opt', type: 'button', data: { perm: p.value },
        attrs: { role: 'menuitemradio', 'aria-checked': p.value === perm() ? 'true' : 'false' },
        on: { click: () => { store.set(`${K}reply.perm`, p.value); pop.close(); syncAll(); } },
      },
        h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'cmp-perm-opt-main' },
          h('span', { class: 'cmp-perm-opt-label', text: p.label }),
          h('span', { class: 'cmp-perm-opt-blurb', text: p.blurb }),
          note ? h('span', { class: 'cmp-perm-opt-note', text: note }) : null));
      items.push(btn);
      list.append(h('li', { attrs: { role: 'none' } }, btn));
    }
    pop.el.append(h('p', { class: 'pop-title', text: 'HOW MUCH ROPE FOR A REPLY' }), list, h('p', { class: 'pop-hint', text: 'Remembered for your next replies.' }));
    pop.el.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + dir + items.length) % items.length].focus();
    });
    pop.place();
    (items.find((b) => b.dataset.perm === perm()) || items[0]).focus();
  }

  // ------------------------------------------------------------------ paint: everything is read off replyState()
  const TAGS = { waiting: 'REPLY', idle: 'REPLY', working: 'MESSAGE', armed: 'MESSAGE', sending: 'SENDING', sent: 'SENT', answered: 'MESSAGE', failed: 'RETRY' };

  function sync(force = false) {
    if (!session) return;
    const s = stateFor(session.id);
    const now = Date.now();
    const name = session.name || 'the agent';
    const failed = s.failed;
    const st = replyState(session, { now });
    const phase = st.phase;
    const midTurn = phase === 'working' || phase === 'armed';
    const headless = `It runs headless: ${name}'s own window won't show it. Follow the run in TASKS and the transcript.`;
    setAttr(el, 'data-phase', phase);
    setAttr(el, 'data-tool', session.tool);
    setAttr(el, 'aria-label', `${phase === 'waiting' || phase === 'idle' ? 'Reply to' : 'Message'} ${name}`);

    setText(tagMain, TAGS[phase] || 'MESSAGE');
    setHidden(tagSub, !midTurn);
    setAttr(tag, 'title',
      midTurn ? `${name} is mid-turn: a message now starts a second run on the same conversation, and the two can trip over each other. Safer to wait until ${name} needs you. Sending asks once more.`
        : phase === 'waiting' ? `${name} needs you: reply here (M puts the caret here). ${headless}`
          : phase === 'failed' ? `The last ${failed === 'reply' ? 'reply' : 'task'} failed: send it again or say it differently. ${headless}`
            : phase === 'sent' || phase === 'answered' ? `Your reply went out. You can send another. ${headless}`
              : `Pick up ${name}'s session with a follow-up (M puts the caret here). ${headless}`);

    const sentNote = phase === 'sent' && s.note ? s.note.text : '';
    const ph = sentNote || (midTurn ? `Message ${name} (mid-turn: starts a second run)…`
      : phase === 'failed' ? 'Send it again, or say it differently…'
        : phase === 'waiting' || phase === 'idle' ? `Reply to ${name}…` : `Message ${name}…`);
    if (field.placeholder !== ph) field.placeholder = ph;
    setAttr(field, 'aria-label', `${phase === 'waiting' || phase === 'idle' ? 'Reply to' : 'Message for'} ${name}. Enter sends, Shift+Enter starts a new line.`);
    setAttr(field, 'title', field.value ? null : `↵ send · ⇧↵ new line\n${headless}`);

    if (field.value !== s.draft && (force || document.activeElement !== field)) field.value = s.draft;
    if (grownFor !== field.value) grow();
    field.readOnly = s.posting;
    setClass(el, 'is-posting', s.posting);

    const armed = phase === 'armed';
    sendBtn.disabled = s.posting;
    setText(sendLabel, s.posting ? 'SENDING…' : armed ? 'SEND ANYWAY' : 'SEND');
    setClass(sendBtn, 'btn-primary', phase === 'waiting');
    setClass(sendBtn, 'is-armed', armed);
    setAttr(sendBtn, 'aria-label', armed ? `Send anyway: start a second run while ${name} is mid-turn` : `Send to ${name}`);
    setAttr(sendBtn, 'title', armed ? 'Send it now, as a second run (↵)' : midTurn ? `${name} is mid-turn: this asks once more before it sends (↵)` : 'Send (↵). ⇧↵ starts a new line.');

    // who else needs you: one press (or the chord, from inside the field too) and the caret is in their reply field
    const others = !armed && !s.posting && ctx.waitingOthers ? ctx.waitingOthers(session.id) || 0 : 0;
    setHidden(nextBtn, !others || !ctx.nextWaiting);
    if (others) {
      const words = `${others === 1 ? '1 more agent needs you' : `${others} more agents need you`}`;
      setAttr(nextBtn, 'title', `${words}: go to the next one (${NEXT_CHORD}; with Shift, the one before)`);
      setAttr(nextBtn, 'aria-label', `Next agent that needs you (${words})`);
    }

    const p = PERMISSIONS.find((x) => x.value === perm()) || PERMISSIONS[1];
    const cut = p.label.indexOf(' ');
    setText(permWord, cut > 0 ? p.label.slice(0, cut) : p.label);
    setText(permRest, cut > 0 ? p.label.slice(cut) : '');
    setAttr(permBtn, 'data-perm', p.value);
    setAttr(permBtn, 'title', `${p.label}: ${p.blurb}\nClick to change what a reply may do.`);
    setAttr(permBtn, 'aria-label', `Permission for this reply: ${p.label}. Change.`);

    // the note: one line, and only when there is something to say
    const note = s.note && (!s.note.until || s.note.until > now) ? s.note : null;
    let kind = '';
    let label = '';
    let text = '';
    let count = '';
    if (armed) {
      kind = 'armed';
      label = 'MID-TURN';
      text = `${name} is still working. ↵ again (or SEND ANYWAY) starts a second run; Esc cancels.`;
      count = `${Math.max(1, Math.ceil((s.armedUntil - now) / 1000))}s`;
    } else if (note && note.kind === 'error') {
      kind = 'error';
      label = 'NOT SENT';
      text = note.text;
    } else if (note && note.kind === 'empty') {
      kind = 'empty';
      text = note.text;
    } else if (explaining && !explained() && phase !== 'sending' && phase !== 'sent') {
      kind = 'explain';
      label = 'HEADS UP';
      text = `A reply runs headless: ${name}'s own window won't show it. Follow it in TASKS.`;
    }
    setHidden(foot, !kind);
    setAttr(foot, 'data-kind', kind || null);
    setText(footTag, label);
    setHidden(footTag, !label);
    setText(footText, text);
    setAttr(footText, 'title', text || null);
    setText(footCount, count);
    setHidden(footCount, !count);
    setText(say, sentNote ? `Sent. ${sentNote}` : kind ? `${label ? `${label}: ` : ''}${text}` : '');
  }

  function update(next, opts = {}) {
    const changed = !next || !session || next.id !== session.id;
    if (changed && session) disarmState(stateFor(session.id)); // SEND ANYWAY was for the agent you were looking at
    session = next || null;
    setHidden(el, !session);
    if (!session) return;
    const s = stateFor(session.id);
    const failedNow = opts.failed === 'reply' || opts.failed === 'task' ? opts.failed : opts.failed ? 'task' : false;
    if (failedNow && !s.failed) {
      // the run a reply started has just failed: nothing about it is pending any more (the box above says why)
      s.armedUntil = 0;
      s.conflict = false;
      if (s.note && s.note.kind === 'sent') s.note = null;
      if (replied.has(session.id)) markReplied(session.id, 0);
    }
    s.failed = failedNow;
    if (changed) field.value = stateFor(session.id).draft;
    sync(changed);
  }

  if (ctx.loadMeta) ctx.loadMeta().then((m) => { if (m) notes = m.permissionNotes || null; }).catch(() => {});

  const api = {
    el, update, sync,
    focus() {
      if (!session || el.hidden) return false;
      field.focus({ preventScroll: true });
      const n = field.value.length;
      try { field.setSelectionRange(n, n); } catch { /* ignore */ }
      return document.activeElement === field;
    },
    isFocused: () => document.activeElement === field,
    /** Esc from outside the field: an armed SEND ANYWAY stands down. True when there was one. */
    disarm() {
      if (!session || !disarmState(stateFor(session.id))) return false;
      syncAll();
      return true;
    },
    /** Put a prompt in the field for the current session (TRY AGAIN on a reply that failed). */
    seed({ prompt, permission } = {}) {
      if (!session) return;
      if (typeof prompt === 'string') stateFor(session.id).draft = prompt;
      if (permission && PERMISSIONS.some((p) => p.value === permission)) store.set(`${K}reply.perm`, permission);
      syncAll(true);
    },
    field,
  };
  instances.add(api);
  return api;
}
