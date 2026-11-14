// Bottom dialogue box: the place where you READ what an agent said and ANSWER it. Three states:
//   ticker (nothing selected)  -> a slim bar: the latest office events + key hints. The office gets the height.
//   char   (someone selected)  -> opens up, never taller than about 40% of the window, and the MESSAGE gets
//                                 every pixel the fixed rows do not need:
//                                   identity   portrait, name, tool, status, group + task name (click or E to
//                                              rename), what it is doing, project · branch, time since
//                                              (one line in a short window, two in a tall one)
//                                   message    the whole last message at rest, from the top, scrolling inside
//                                              (a failed office task shows why it failed here instead)
//                                   composer   reply in place (see composer.js); a crew member shows BACK TO <boss>
//                                   crew       an orchestrator's crew: one line of chips above the actions; a
//                                              column of its own only for a big crew in a tall window
//                                   actions    one row of fixed slots: TRANSCRIPT · RENAME · GROUP … STOP TASK | CLOSE
//   log    (asked for)         -> opens up: the whole office log, scrollable
// The slim bar's height is the only thing the office is fitted around; the open box slides over the floor and
// reports its height through ctx.onLayout() whenever it changes (debounced), so the camera can keep up.
import { h, setText, setTextTitle, setAttr, setClass, setHidden, reconcile, statusGlyph, toolBadge, fmtAgo, fmtClockShort, fmtTokens, reducedMotion, isTypingTarget, STATUS_LABEL, TOOL_INFO } from './dom.js';
import { groupFlag, setFlag } from './groupui.js';
import { taskName } from '../groups.js';
import { createComposer, replyState, onReplyState, repliedAt } from './composer.js';
import { renderProse, plainInline, isShortProse } from './prose.js';
import { failureReason } from './failure.js';
import { loginHint } from './newtask.js';
import { modalOpen } from './modal.js';

const LABEL_MAX = 60;
const LABEL_WARN = 48; // from here on the rename field counts the characters
const LINE_PX = 20; // one line of the message
const CREW_STRIP_MAX = 3; // a crew this small never earns a column
const SHORT_VH = 800; // under this the window is laptop-short: one-line identity, crew as a strip

/** "Running 2 subagents" -> "Running 2 crew": one noun for an orchestrator's helpers (the server writes its own). */
const crewWords = (t) => String(t || '')
  .replace(/\b1\s+(?:sub-?agents?|agents?|helpers?|workers?)\b/gi, '1 crew member')
  .replace(/\b(\d+)\s+(?:sub-?agents?|agents?|helpers?|workers?)\b/gi, '$1 crew')
  .replace(/\bsub-?agents?\b/gi, 'crew');

// Failures the user dismissed (DISMISS in the box): the dialogue and the transcript agree on it.
const dismissedFails = new Set();

const TYPE_INTERVAL_MS = 24;
const TYPE_CHARS_PER_TICK = 3;
const STOP_ARM_MS = 2500;
const LAYOUT_DEBOUNCE_MS = 80;
const CUT_AT = 2380; // the server clips lastMessage at 2400 characters and ends it with an ellipsis
const FAIL_STALE_MS = 60_000; // a session that kept writing this long after its task failed has moved on

/** The newest office task tied to this session, when it failed and nothing has happened since. */
export function failedTaskFor(session, state, dismissed = dismissedFails) {
  if (!session || !state || !Array.isArray(state.tasks)) return null;
  const t = state.tasks.find((x) => (session.taskId && x.id === session.taskId) || x.sessionId === session.id || x.resumeOf === session.id);
  if (!t || t.status !== 'failed') return null;
  if (dismissed && dismissed.has(t.id)) return null;
  if (t.endedAt && session.lastActivityAt > t.endedAt + FAIL_STALE_MS) return null;
  if (t.endedAt && repliedAt(session.id) > t.endedAt) return null; // answered since: that failure is history
  return t;
}

export function createDialogue(ctx) {
  // ---------------------------------------------------------------- identity
  const canvas = h('canvas', { class: 'dlg-face', width: 96, height: 96, attrs: { 'aria-hidden': 'true' } });
  const portrait = h('div', { class: 'dlg-portrait' }, canvas);

  const name = h('span', { class: 'dlg-name' });
  const badgeSlot = h('span', { class: 'dlg-badge-slot' });
  const chipGlyph = statusGlyph('working');
  const chipLabel = h('span', { text: '' });
  const chip = h('span', { class: 'chip dlg-chip', data: { status: '' } }, chipGlyph, chipLabel);
  const doingLabel = h('span', { class: 'dlg-doing-label' });
  const doing = h('span', { class: 'dlg-doing' }, h('span', { class: 'ico ico-cursor', attrs: { 'aria-hidden': 'true' } }), doingLabel);
  const meta = h('span', { class: 'dlg-meta' });
  const agoWord = h('span', { class: 'dlg-ago-word' });
  const agoValue = h('span');
  const ago = h('span', { class: 'dlg-ago num' }, agoWord, agoValue);
  // the chip sits in a slot as wide as its widest everyday label, so a status flip moves nothing after it
  const head = h('div', { class: 'dlg-head' }, name, badgeSlot, h('span', { class: 'dlg-chip-slot' }, chip), doing, meta, ago);

  // task line: [group] [task name — click to rename] (the tool's own title, when you have named it) … project · branch
  const groupFlagEl = groupFlag(null);
  const groupName = h('span', { class: 'dlg-group-name' });
  const groupBtn = h('button', { class: 'dlg-group', type: 'button', on: { click: () => current && !current.sub && ctx.openGroupMenu(current.session, groupBtn) } },
    groupFlagEl, groupName);
  const titleText = h('span', { class: 'dlg-title-text' });
  const titleBtn = h('button', { class: 'dlg-title-btn', type: 'button', on: { click: () => startRename() } },
    titleText, h('span', { class: 'ico ico-pencil', attrs: { 'aria-hidden': 'true' } }));
  const titleStatic = h('span', { class: 'dlg-title-text dlg-title-static', hidden: true });
  const orig = h('span', { class: 'dlg-orig', hidden: true });
  const titleInput = h('input', {
    class: 'input dlg-title-input', type: 'text', maxLength: LABEL_MAX, spellcheck: false, autocomplete: 'off', hidden: true,
    placeholder: 'Name this task (empty = the original title)',
    attrs: { 'aria-label': 'Name for this task. Enter saves, Escape cancels, empty goes back to the original title.' },
    on: {
      keydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(true); }
      },
      input: () => paintRenameCount(),
      blur: () => { if (renaming && !renameBusy) commitRename({ fromBlur: true }); },
    },
  });
  // the name stops at LABEL_MAX characters: say so before it does
  const titleCount = h('span', { class: 'dlg-title-count num', hidden: true, attrs: { 'aria-hidden': 'true' } });
  const titleHint = h('span', { class: 'dlg-title-hint', hidden: true }, titleCount, h('kbd', { class: 'sym', text: '↵' }), h('span', { text: 'save' }), h('kbd', { text: 'ESC' }), h('span', { text: 'cancel' }));
  const titleError = h('span', { class: 'dlg-title-error', hidden: true, attrs: { role: 'alert' } });
  const where = h('span', { class: 'dlg-where' });
  const title = h('div', { class: 'dlg-title' }, groupBtn, titleBtn, titleStatic, titleInput, titleHint, orig, titleError, where);
  const ident = h('div', { class: 'dlg-ident' }, head, title);

  // ---------------------------------------------------------------- why a task failed
  const failTag = h('span', { class: 'dlg-fail-tag', text: 'WHY IT FAILED' });
  const failNote = h('span', { class: 'dlg-fail-note' });
  const failRetry = h('button', { class: 'btn btn-mini dlg-fail-retry', type: 'button', text: 'RETRY', title: 'Try again: reopen the menu with the same choices', on: { click: () => failTask && ctx.retryTask && ctx.retryTask(failTask) } });
  const failFull = h('button', { class: 'btn btn-mini', type: 'button', text: 'FULL OUTPUT', title: 'Open everything the task printed',
    on: { click: () => failTask && window.dispatchEvent(new CustomEvent('ao:open-task-output', { detail: { taskId: failTask.id } })) } });
  const failDismiss = h('button', { class: 'btn btn-mini', type: 'button', text: 'DISMISS', title: 'Hide this and show the agent as usual', on: { click: () => { if (failTask) { dismissedFails.add(failTask.id); rerender(); park(); } } } });
  const failOut = h('pre', { class: 'dlg-fail-out', tabIndex: 0, attrs: { 'aria-label': 'Why it failed: the lines of the task output that say so' } });
  const failSignin = h('p', { class: 'dlg-fail-signin', hidden: true });
  const fail = h('section', { class: 'dlg-fail', hidden: true, attrs: { 'aria-label': 'This task failed' } },
    h('div', { class: 'dlg-fail-head' }, failTag, failNote, h('span', { class: 'dlg-fail-btns' }, failRetry, failFull, failDismiss)), failOut, failSignin);
  let failSigninFor = null;

  // ---------------------------------------------------------------- the message
  const prose = h('div', { class: 'dlg-prose prose' });
  const typedSpan = h('span');
  const typeCaret = h('span', { class: 'dlg-caret', attrs: { 'aria-hidden': 'true' } });
  const ghostSpan = h('span', { class: 'dlg-ghost', attrs: { 'aria-hidden': 'true' } });
  const typeP = h('p', { class: 'prose-p' }, typedSpan, typeCaret, ghostSpan);
  const moreBtn = h('button', { class: 'dlg-more', type: 'button', hidden: true, on: { click: () => current && ctx.openTranscript(current.session.id) } },
    h('span', { text: '… continues in transcript' }), h('span', { class: 'ico ico-right', attrs: { 'aria-hidden': 'true' } }));
  const sayScroll = h('div', { class: 'dlg-say-scroll', attrs: { role: 'group', 'aria-label': 'Last message' }, on: { scroll: () => paintFade(), click: () => finishTyping() } }, prose, moreBtn);
  // more below: said in so many lines, and one click (or PageDown, or the wheel) reads on. The keyboard's way
  // in is the message itself (it is a Tab stop whenever it scrolls), so this pointer shortcut stays out of the Tab order.
  const sayMoreText = h('span');
  const sayMore = h('button', { class: 'dlg-say-more', type: 'button', tabIndex: -1, hidden: true, attrs: { 'aria-hidden': 'true' }, on: { click: () => pageMessage(1) } },
    sayMoreText, h('span', { class: 'ico ico-down' }));
  sayMore.addEventListener('pointerdown', (e) => e.preventDefault()); // a pointer shortcut: it never takes the keyboard
  const say = h('div', { class: 'dlg-say' }, sayScroll, sayMore);
  const pageMessage = (dir) => sayScroll.scrollBy({ top: dir * Math.max(2 * LINE_PX, sayScroll.clientHeight - 2 * LINE_PX) });
  sayScroll.addEventListener('keydown', (e) => {
    // reading keys stay in the message: they must not pan the office behind it
    if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End' || e.key === ' ') e.stopPropagation();
  });

  // ---------------------------------------------------------------- answer in place
  const composer = createComposer({
    api: ctx.api,
    getSession: ctx.getSession,
    loadMeta: ctx.loadMeta,
    onSent: ctx.onSent,
    onEscape: () => park(),
    scrollTarget: () => sayScroll,
    waitingOthers: ctx.waitingOthers,
    nextWaiting: ctx.nextWaiting,
  }, { variant: 'dlg' });

  // a crew member has no line of its own: you talk to the agent it works for
  const bossText = h('span', { class: 'dlg-boss-text' });
  const bossLabel = h('span');
  // (the button goes away with the crew member's view: the keyboard stays in the box, on the boss)
  const bossBtn = h('button', { class: 'btn dlg-boss-btn', type: 'button', on: { click: () => { if (!current) return; ctx.select(current.session.id); park(); } } },
    h('span', { class: 'ico ico-left', attrs: { 'aria-hidden': 'true' } }), bossLabel);
  const boss = h('div', { class: 'dlg-boss', hidden: true }, bossBtn, bossText);

  const main = h('div', { class: 'dlg-main' }, ident, fail, say, composer.el, boss);

  // ---------------------------------------------------------------- crew (orchestrator)
  // One line of chips above the actions; a column beside the message only when a big crew in a tall window earns it.
  const crewCount = h('span', { class: 'dlg-crew-count num' });
  const crewList = h('ul', { class: 'dlg-crew-list' });
  const crew = h('aside', { class: 'dlg-crew', hidden: true, data: { layout: 'strip' }, attrs: { 'aria-label': 'Crew working for this agent' } },
    h('div', { class: 'dlg-crew-in' }, h('h3', { class: 'dlg-crew-head' }, h('span', { text: 'CREW' }), crewCount), crewList));

  // ---------------------------------------------------------------- actions: every one keeps its slot
  const mkBtn = (label, key, onClick, cls = '') => {
    const lab = h('span', { class: 'dlg-btn-label', text: label });
    const btn = h('button', { class: `dlg-btn ${cls}`, type: 'button', attrs: { 'aria-keyshortcuts': key ? (key === 'ESC' ? 'Escape' : key) : null }, on: { click: onClick } },
      lab, key ? h('kbd', { text: key, attrs: { 'aria-hidden': 'true' } }) : null);
    return { btn, lab };
  };
  const aTranscript = mkBtn('TRANSCRIPT', 'T', () => current && ctx.toggleTranscript(current.session.id));
  const aRename = mkBtn('RENAME', 'E', () => startRename());
  const aGroup = mkBtn('GROUP', 'G', () => current && !current.sub && ctx.openGroupMenu(current.session, groupAnchor()));
  // the menu hangs from the group chip on the identity line; a short window leaves an ungrouped task without one, so from the action then
  const groupAnchor = () => (groupBtn.offsetParent ? groupBtn : aGroup.btn);
  const aStop = mkBtn('STOP TASK', '', () => pressStop(), 'dlg-btn-stop');
  const aClose = mkBtn('CLOSE', 'ESC', () => ctx.select(null));
  aStop.btn.addEventListener('blur', () => disarmStop());
  const actions = h('nav', { class: 'dlg-btns', attrs: { 'aria-label': 'Actions for the selected agent' } },
    aTranscript.btn, aRename.btn, aGroup.btn, h('span', { class: 'dlg-btns-gap' }), aStop.btn, h('span', { class: 'dlg-btns-sep', attrs: { 'aria-hidden': 'true' } }), aClose.btn);

  const srStatus = h('p', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
  const top = h('div', { class: 'dlg-top' }, portrait, main);
  const charView = h('div', { class: 'dlg-char', hidden: true, tabIndex: -1 }, top, crew, actions, srStatus);
  // paging keys read the message from anywhere in the box (the reply field and the message handle their own)
  charView.addEventListener('keydown', (e) => {
    if ((e.key !== 'PageUp' && e.key !== 'PageDown') || e.defaultPrevented || say.hidden || compact) return;
    const t = e.target;
    if (isTypingTarget(t) || (t.closest && t.closest('.dlg-say-scroll, .dlg-fail-out, .dlg-crew-list'))) return;
    e.preventDefault();
    e.stopPropagation();
    pageMessage(e.key === 'PageDown' ? 1 : -1);
  });

  // ---------------------------------------------------------------- ticker (the slim idle bar)
  const tickList = h('ol', { class: 'tick-list', attrs: { 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Latest office events' } });
  const tickEmpty = h('p', { class: 'tick-empty', text: 'Quiet so far.' });
  const mkHints = () => {
    const hint = h('p', { class: 'dlg-hint' });
    // most useful first: the ones that do not fit are dropped whole, never cut in half
    const hints = [['CLICK', 'someone to talk'], ['Y', 'who needs you'], ['N', 'new task'], ['?', 'all keys'], ['[ ]', 'next / previous']];
    hints.forEach(([k, label]) => hint.append(h('span', { class: 'hint-item' }, h('kbd', { text: k }), h('span', { text: label }))));
    return hint;
  };
  const logBtn = h('button', { class: 'btn btn-mini tick-log', type: 'button', title: 'Open the office log (L)', attrs: { 'aria-expanded': 'false' }, on: { click: () => setLogOpen(true) } },
    h('span', { text: 'LOG' }), h('kbd', { text: 'L' }), h('span', { class: 'ico ico-up', attrs: { 'aria-hidden': 'true' } }));
  const tickView = h('div', { class: 'dlg-tick' }, logBtn, h('div', { class: 'tick-main' }, tickList, tickEmpty), mkHints());

  // ---------------------------------------------------------------- log view (opened, scrollable)
  const logList = h('ol', { class: 'dlg-log-list', tabIndex: 0, attrs: { 'aria-label': 'Office log, newest first' } });
  const logEmpty = h('p', { class: 'dlg-log-empty', text: 'Quiet so far.' });
  const logCount = h('span', { class: 'dlg-log-count num' });
  const logClose = h('button', { class: 'btn btn-mini', type: 'button', title: 'Close the log (L or Esc)', on: { click: () => setLogOpen(false) } },
    h('span', { text: 'CLOSE' }), h('span', { class: 'ico ico-down', attrs: { 'aria-hidden': 'true' } }));
  const logView = h('div', { class: 'dlg-log', hidden: true },
    h('div', { class: 'dlg-log-side' }, h('h2', { class: 'panel-title', text: 'OFFICE LOG' }), logCount, logClose),
    h('div', { class: 'dlg-log-main' }, logList, logEmpty));

  const el = h('footer', { id: 'dialogue', class: 'panel', data: { mode: 'ticker' }, attrs: { 'aria-label': 'Dialogue' } }, charView, logView, tickView);
  let logOpen = false;
  let mode = 'ticker';

  function setLogOpen(v) {
    v = !!v;
    if (v === logOpen) return;
    logOpen = v;
    if (v && current) { ctx.select(null); return; } // clearing the selection re-renders with the log open
    applyMode();
    (v ? logList : logBtn).focus({ preventScroll: true });
  }

  function applyMode() {
    const next = current ? 'char' : logOpen ? 'log' : 'ticker';
    setHidden(charView, next !== 'char');
    setHidden(logView, next !== 'log');
    setHidden(tickView, next !== 'ticker');
    setAttr(logBtn, 'aria-expanded', next === 'log' ? 'true' : 'false');
    if (next === mode) return;
    mode = next;
    el.dataset.mode = mode;
    setClass(el, 'is-open', mode !== 'ticker');
    lastLogVersion = -1;
    renderLog();
    if (mode === 'log') logList.scrollTop = 0;
    ctx.onMode && ctx.onMode(mode);
  }

  // ---------------------------------------------------------------- the message: whole, at rest, from the top
  // Typing is a flourish for a short line only, and only for new words: the same message is never typed twice
  // for the same speaker, a message that grew just grows, and nothing ever scrolls by itself.
  let saySpeaker = null;
  let sayNorm = null;
  let sayText = '';
  let typeTimer = 0;
  let typePlain = '';
  let typeShown = 0;
  const lastSaid = new Map(); // session id -> last non-empty message
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  // A message that misses the cap by no more than a line gets that line: "1 MORE LINE" is never worth a scroll.
  // Read off things the slack itself does not change (what the message needs, what the fixed rows take).
  let slack = 0;
  function fitCap() {
    let want = 0;
    if (current && !say.hidden && !compact && !charView.hidden) {
      const capNow = parseFloat(getComputedStyle(el).maxHeight);
      if (Number.isFinite(capNow)) {
        const fixed = el.offsetHeight - sayScroll.clientHeight;
        const over = sayScroll.scrollHeight - (capNow - slack - fixed);
        if (over > 0 && over <= LINE_PX) want = Math.ceil(over);
      }
    }
    if (want === slack) return;
    slack = want;
    el.style.setProperty('--dlg-slack', `${slack}px`);
  }

  function paintFade() {
    fitCap();
    const room = sayScroll.scrollHeight - sayScroll.clientHeight;
    const below = room - sayScroll.scrollTop;
    say.style.setProperty('--say-fade', `${Math.max(0, Math.min(30, Math.round(below)))}px`); // never darker than what it hides
    setClass(say, 'has-more', below > 6);
    setClass(say, 'has-less', sayScroll.scrollTop > 6);
    setHidden(sayMore, !(below > 6));
    if (below > 6) {
      const lines = Math.max(1, Math.round(below / LINE_PX));
      setText(sayMoreText, `${lines} MORE LINE${lines === 1 ? '' : 'S'}`);
      setAttr(sayMore, 'title', 'Read on (PageDown or the wheel, too)');
    }
    // only a message that actually scrolls is a stop on the Tab key's way to the reply field
    const want = room > 1 ? 0 : -1;
    if (sayScroll.tabIndex !== want) sayScroll.tabIndex = want;
    setClass(crew, 'is-over', crewList.scrollWidth > crewList.clientWidth + 1);
    setClass(doing, 'is-stub', !doing.hidden && doing.clientWidth < 72 && doingLabel.scrollWidth > doingLabel.clientWidth + 1);
  }

  function paintTyped() {
    typedSpan.textContent = typePlain.slice(0, typeShown);
    ghostSpan.textContent = typePlain.slice(typeShown);
  }

  function finishTyping() {
    if (!typeTimer) return;
    clearInterval(typeTimer);
    typeTimer = 0;
    setClass(say, 'is-typing', false);
    renderProse(prose, sayText);
  }

  function startTyping() {
    typePlain = plainInline(sayText);
    typeShown = 0;
    prose.replaceChildren(typeP);
    paintTyped();
    setClass(say, 'is-typing', true);
    // paced by the clock, not by the tick count: a throttled timer (background tab) catches up instead of crawling
    const t0 = performance.now();
    typeTimer = setInterval(() => {
      typeShown = Math.min(typePlain.length, Math.ceil(((performance.now() - t0) / TYPE_INTERVAL_MS) * TYPE_CHARS_PER_TICK));
      paintTyped();
      if (typeShown >= typePlain.length) finishTyping();
    }, TYPE_INTERVAL_MS);
  }

  function speak(speaker, text, { quiet = false, cut = false } = {}) {
    const n = norm(text);
    setClass(say, 'is-quiet', quiet);
    setHidden(moreBtn, !cut);
    if (speaker === saySpeaker && n === sayNorm) return;
    const grew = speaker === saySpeaker && !!sayNorm && n.startsWith(sayNorm);
    saySpeaker = speaker;
    sayNorm = n;
    sayText = text;
    if (typeTimer) { clearInterval(typeTimer); typeTimer = 0; setClass(say, 'is-typing', false); }
    if (!grew) sayScroll.scrollTop = 0;
    if (!grew && !quiet && isShortProse(text) && !reducedMotion()) startTyping();
    else renderProse(prose, text);
    paintFade();
  }

  // ---------------------------------------------------------------- rename (click the task name, or E)
  let renaming = false;
  let renameBusy = false;
  let renameFor = null; // session id being renamed
  let renameSeed = '';

  function paintRenameCount() {
    const n = titleInput.value.length;
    const show = renaming && n >= LABEL_WARN;
    setHidden(titleCount, !show);
    if (!show) return;
    setText(titleCount, `${n}/${LABEL_MAX}`);
    setClass(titleCount, 'is-full', n >= LABEL_MAX);
    setAttr(titleCount, 'title', n >= LABEL_MAX ? `A task name stops at ${LABEL_MAX} characters` : `${LABEL_MAX - n} characters left`);
    // said aloud twice only: when the counting starts, and at the limit
    if (n === LABEL_WARN) setText(srStatus, `${LABEL_MAX - n} characters left for the name.`);
    else if (n >= LABEL_MAX) setText(srStatus, `The name is at its limit of ${LABEL_MAX} characters.`);
  }

  function paintRename() {
    const sub = !!(current && current.sub);
    setHidden(titleBtn, renaming || sub);
    setHidden(titleStatic, !sub);
    setHidden(titleInput, !renaming);
    setHidden(titleHint, !renaming);
    setHidden(groupBtn, sub);
    setClass(title, 'is-renaming', renaming);
    setClass(ident, 'is-renaming', renaming);
    if (renaming) setHidden(orig, true);
    paintRenameCount();
  }

  function startRename() {
    if (!current || current.sub || renaming) return false;
    const s = current.session;
    renaming = true;
    renameBusy = false;
    renameFor = s.id;
    renameSeed = (s.label || '').slice(0, LABEL_MAX);
    titleInput.value = renameSeed || String(s.title || '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
    titleInput.disabled = false;
    setHidden(titleError, true);
    paintRename();
    titleInput.focus();
    titleInput.select();
    return true;
  }

  function cancelRename(refocus = false) {
    if (!renaming) return;
    renaming = false;
    renameBusy = false;
    renameFor = null;
    setHidden(titleError, true);
    paintRename();
    if (current) paintTask(current);
    if (refocus) titleBtn.focus({ preventScroll: true });
  }

  async function commitRename({ fromBlur = false } = {}) {
    if (!renaming || renameBusy || !current) return;
    const s = current.session;
    const value = titleInput.value.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
    const autoTitle = String(s.title || '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
    // nothing typed over the pre-filled text: nothing to save
    if (value === renameSeed || (!renameSeed && value === autoTitle)) { cancelRename(!fromBlur); return; }
    renameBusy = true;
    titleInput.disabled = true;
    setHidden(titleError, true);
    try {
      await ctx.rename(s.id, value);
      const refocus = !fromBlur && document.activeElement === document.body;
      cancelRename(false);
      if (refocus || (!fromBlur && document.activeElement === titleInput)) titleBtn.focus({ preventScroll: true });
    } catch (e) {
      renameBusy = false;
      if (!renaming) return;
      titleInput.disabled = false;
      setTextTitle(titleError, e && e.message ? e.message : String(e));
      setHidden(titleError, false);
      if (!fromBlur) titleInput.focus();
      else cancelRenameKeepError();
    }
  }

  // a save that failed after the field lost focus: close the field but leave the reason readable
  function cancelRenameKeepError() {
    renaming = false;
    renameFor = null;
    paintRename();
    if (current) paintTask(current);
    setHidden(titleError, false);
  }

  /** Group button + task name + original title. */
  function paintTask(sel) {
    const { session, sub } = sel;
    if (sub) {
      setTextTitle(titleStatic, sub.label || sub.agentType || 'Crew member');
      setHidden(orig, true);
      return;
    }
    const g = session.groupId ? ctx.groupById(session.groupId) : null;
    setFlag(groupFlagEl, g ? g.color : null);
    setText(groupName, g ? g.name : '+ GROUP');
    setClass(groupBtn, 'is-none', !g);
    setAttr(groupBtn, 'title', g ? `In the group “${g.name}”. Click to move it or take it out (G)` : 'Put this task in a group (G)');
    setAttr(groupBtn, 'aria-label', g ? `Group: ${g.name}. Change group.` : 'Put this task in a group');
    const shown = taskName(session) || '(untitled session)';
    setText(titleText, shown);
    setAttr(titleBtn, 'title', `${shown}\nClick to rename this task (E)`);
    setAttr(titleBtn, 'aria-label', `Task: ${shown}. Rename.`);
    const showOrig = !!session.label && !!session.title && session.title !== session.label && !renaming;
    setHidden(orig, !showOrig);
    if (showOrig) setTextTitle(orig, session.title);
  }

  // ---------------------------------------------------------------- STOP TASK: two presses
  let stopArmedUntil = 0;
  let stopTimer = 0;
  let stopBusy = false;
  const stopArmed = () => stopArmedUntil > Date.now();

  function paintStop() {
    const off = !currentTask;
    setClass(aStop.btn, 'is-off', off); // not applicable: it keeps its slot, out of sight and out of reach
    // the task ended by itself while the button had the keyboard: the keyboard stays in the box
    if (off && !aStop.btn.disabled && document.activeElement === aStop.btn) park();
    aStop.btn.disabled = off || stopBusy;
    const armed = !off && stopArmed();
    setClass(aStop.btn, 'is-armed', armed);
    setText(aStop.lab, stopBusy ? 'STOPPING…' : armed ? 'SURE? STOP' : 'STOP TASK');
    const who = current ? current.session.name : 'this agent';
    setAttr(aStop.btn, 'title', off ? null : armed ? `Press again to stop ${who}'s task` : `Stop the task ${who} is running for you (asks once more)`);
    setAttr(aStop.btn, 'aria-label', off ? 'Stop task (nothing to stop)' : armed ? `Sure? Press again to stop ${who}'s task` : `Stop ${who}'s task`);
  }

  function disarmStop() {
    clearTimeout(stopTimer);
    if (!stopArmedUntil) return false;
    stopArmedUntil = 0;
    paintStop();
    return true;
  }

  async function pressStop() {
    if (!currentTask || stopBusy || !current) return;
    if (!stopArmed()) {
      stopArmedUntil = Date.now() + STOP_ARM_MS;
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => { if (disarmStop()) setText(srStatus, 'Stop cancelled.'); }, STOP_ARM_MS);
      paintStop();
      setText(srStatus, 'Press again within two seconds to stop the task. Escape cancels.');
      return;
    }
    disarmStop();
    const taskId = currentTask;
    const who = current.session.name;
    const hadFocus = document.activeElement === aStop.btn;
    stopBusy = true;
    paintStop();
    let ok = false;
    try { ok = (await ctx.stopTask(taskId)) !== false; } catch { ok = false; }
    stopBusy = false;
    paintStop();
    // the button just switched itself off: do not let the keyboard fall out of the box with it
    if (hadFocus && (document.activeElement === document.body || document.activeElement === aStop.btn)) { if (aStop.btn.disabled) park(); }
    setText(srStatus, ok ? `${who}'s task was stopped.` : `Could not stop ${who}'s task.`);
  }

  // ---------------------------------------------------------------- render
  let current = null; // { id, session, sub }
  let lastState = null;
  let titleErrorFor = null;
  let currentTask = null;
  let failTask = null;
  let badgeTool = null;
  let lastLogVersion = -1;
  let lastPortraitKey = '';
  let compact = false; // the transcript is open: it is the reading surface, this box keeps to identity + actions
  let txFor = null;
  let reply = null; // where a reply to the selected session stands (composer.js: replyState)

  const rerender = () => { if (current) { renderChar(current, lastState); } };

  /** Strip (one line above the actions) or column (beside the message): move the list, keep the keyboard where it was. */
  function placeCrew(layout) {
    if (crew.dataset.layout === layout && crew.parentNode === (layout === 'column' ? top : charView)) return;
    const ae = document.activeElement;
    const had = ae && crew.contains(ae) ? ae : null;
    crew.dataset.layout = layout;
    if (layout === 'column') top.append(crew); else charView.insertBefore(crew, actions);
    if (had) { try { had.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  function renderCrew(session, selectedId) {
    const subs = session.subagents || [];
    setHidden(crew, subs.length === 0);
    setAttr(el, 'data-crew', !subs.length ? null : subs.length <= CREW_STRIP_MAX || window.innerHeight < SHORT_VH || compact ? 'strip' : 'column');
    if (!subs.length) return;
    placeCrew(el.dataset.crew);
    // in the strip a brief is only shown while there is honest room for it: a small crew. A big one is names (the brief is the tooltip)
    setAttr(crew, 'data-labels', el.dataset.crew === 'column' || subs.length <= CREW_STRIP_MAX ? 'true' : null);
    const done = subs.filter((x) => x.status === 'done').length;
    const failedN = subs.filter((x) => x.status === 'failed').length;
    const workingN = subs.length - done - failedN;
    setText(crewCount, `${done}/${subs.length} DONE${failedN ? ` · ${failedN} FAILED` : ''}`);
    setClass(crewCount, 'is-failed', failedN > 0);
    setClass(crewCount, 'is-all', done === subs.length);
    setAttr(crewCount, 'title', `${done} of ${subs.length} done, ${workingN} still working${failedN ? `, ${failedN} failed` : ''}`);
    setAttr(crew, 'aria-label', `Crew working for ${session.name}: ${subs.length === 1 ? '1 crew member' : `${subs.length} crew`}, ${done} done${failedN ? `, ${failedN} failed` : ''}`);
    reconcile(crewList, subs, (x) => x.id, () => {
      const nm = h('span', { class: 'crew-name' });
      const lb = h('span', { class: 'crew-label' });
      const gl = statusGlyph('working');
      const btn = h('button', { class: 'crew-item', type: 'button', on: { click: () => { const id = li.__id; if (current && id) ctx.select(`${current.session.id}#${id}`); } } }, gl, nm, lb);
      const li = h('li', null, btn);
      li.__parts = { nm, lb, gl, btn };
      return li;
    }, (li, sub, i) => {
      li.__id = sub.id;
      const p = li.__parts;
      const shown = sub.name || `#${i + 1}`;
      setText(p.nm, shown);
      const min = `${shown.length * 10 + 40}px`; // glyph + name (10px a letter) + padding: what a chip keeps when its brief has given way
      if (li.__min !== min) { li.style.setProperty('--crew-min', min); li.__min = min; }
      const label = sub.label || sub.agentType || '';
      setText(p.lb, label);
      setAttr(p.gl, 'data-status', sub.status);
      setAttr(p.btn, 'data-status', sub.status);
      setAttr(p.btn, 'aria-current', selectedId === `${session.id}#${sub.id}` ? 'true' : null);
      setAttr(p.btn, 'title', `${label}${sub.agentType && sub.label ? ` (${sub.agentType})` : ''}\n${STATUS_LABEL[sub.status] || sub.status}${sub.activity && sub.status === 'working' && sub.activity.label ? `: ${sub.activity.label}` : ''}`);
      setAttr(p.btn, 'aria-label', `${sub.name || 'Crew member'}: ${label}. ${STATUS_LABEL[sub.status] || sub.status}.`);
    });
  }

  function renderChar(sel, state) {
    const { session, sub, id } = sel;
    const tool = session.tool;
    failTask = sub ? null : failedTaskFor(session, state);
    // answer in place: a session gets the reply field, a crew member gets the way back to its boss. The field
    // is told first, because the chip up here, its label and its note are all read off one reply state.
    composer.update(sub ? null : session, { failed: failTask ? (failTask.resumeOf ? 'reply' : 'task') : false });
    reply = sub ? null : replyState(session);
    const chipIs = sub ? { status: sub.status, label: STATUS_LABEL[sub.status] || String(sub.status).toUpperCase() } : reply.chip;
    const replied = !!reply && (reply.phase === 'sent' || reply.phase === 'answered') && session.status !== 'working';
    // the box's own status: yellow only while this agent really needs you (not once you have answered it)
    const status = sub ? sub.status : replied ? 'replied' : reply.phase === 'failed' ? 'failed' : chipIs.status;
    setAttr(el, 'data-tool', tool);
    setAttr(el, 'data-status', status);
    setAttr(el, 'data-sub', sub ? 'true' : null);

    setText(name, sub ? sub.name || 'CREW' : session.name);
    setAttr(name, 'title', sub ? null : [[session.project, session.branch].filter(Boolean).join(' · '), [session.model, session.source && session.source !== 'unknown' ? session.source : '', fmtTokens(session.tokens)].filter(Boolean).join(' · ')].filter(Boolean).join('\n') || null);
    if (badgeTool !== tool) { badgeSlot.replaceChildren(toolBadge(tool)); badgeTool = tool; }
    setAttr(chip, 'data-status', chipIs.status);
    setAttr(chipGlyph, 'data-status', chipIs.status);
    setText(chipLabel, chipIs.label);
    setAttr(chip, 'title', replied ? `You replied: ${session.name} no longer needs you. It shows as working once the run starts.` : null);

    // what it is doing right now (only while it is doing something), then the quiet facts
    const act = (sub ? sub.activity : session.activity) || { label: '' };
    const busy = chipIs.status === 'working' && !replied && (sub ? sub.status : session.status) === 'working' && !!act.label;
    setHidden(doing, !busy);
    if (busy) setTextTitle(doingLabel, crewWords(act.label));

    if (renaming && (sub || renameFor !== session.id)) cancelRename(); // the selection moved on
    if (!renaming) setHidden(titleError, titleError.hidden || titleErrorFor !== id);
    titleErrorFor = id;
    paintRename();
    paintTask(sel);

    if (sub) {
      setTextTitle(meta, session.project || '');
      setTextTitle(where, [sub.agentType ? `${sub.agentType} crew` : 'crew', `working for ${session.name}`].join(' · '));
      setHidden(fail, true);
      // Its brief IS its title: said once. Only a brief the title line had to cut short is repeated in full below.
      const brief = sub.label || sub.agentType || '';
      const cutShort = !!brief && titleStatic.scrollWidth > titleStatic.clientWidth + 1;
      setHidden(say, !cutShort);
      speak(id, brief || 'No brief.', { quiet: !brief });
    } else {
      setTextTitle(meta, [session.model, session.source && session.source !== 'unknown' ? session.source : '', fmtTokens(session.tokens)].filter(Boolean).join(' · '));
      setText(where, [session.project, session.branch].filter(Boolean).join(' · '));
      setAttr(where, 'title', session.cwd || null);
      if (session.lastMessage) {
        if (lastSaid.size > 300) lastSaid.clear();
        lastSaid.set(session.id, session.lastMessage);
      }
      let text = session.lastMessage || lastSaid.get(session.id) || '';
      const cut = text.length >= CUT_AT && text.endsWith('…');
      if (cut) text = text.slice(0, -1).trimEnd();

      // a failed office task says why, where the message would be
      setHidden(fail, !failTask);
      if (failTask) {
        const why = failureReason(failTask, { max: 6 }); // the lines that read like the real error, not the warnings before it
        setText(failOut, why.text);
        // a signed-out CLI: the fix is one command in a terminal, so hand it over
        const signinKey = why.signedOut ? session.tool : null;
        if (signinKey !== failSigninFor) {
          failSigninFor = signinKey;
          failSignin.replaceChildren(...(signinKey ? [h('span', { text: `${TOOL_INFO[session.tool]?.label || 'The'} CLI looks signed out:` }), loginHint(session.tool)] : []));
        }
        setHidden(failSignin, !signinKey);
        setText(failTag, failTask.resumeOf ? 'WHY THE REPLY FAILED' : 'WHY IT FAILED');
        setText(failNote, failTask.exitCode != null ? `exit ${failTask.exitCode}` : '');
        setAttr(failRetry, 'aria-label', `Retry: reopen ${failTask.resumeOf ? 'the reply' : 'the new-task menu'} with the same choices`);
      }
      // a message that only repeats the task's name says nothing new: the name is already on the line above
      const echo = !!text && (norm(text) === norm(taskName(session)) || norm(text) === norm(session.title));
      setHidden(say, (!!failTask && !text) || echo);
      speak(id, text || 'Nothing said yet.', { quiet: !text, cut });
    }

    renderCrew(session, id);

    setHidden(boss, !sub);
    if (sub) {
      const job = taskName(session);
      setText(bossLabel, `BACK TO ${session.name}`);
      setTextTitle(bossText, `${sub.name || 'This crew member'} is crew on ${session.name}'s task${job ? `: ${job}` : ''}. To say something, talk to ${session.name}.`);
      setAttr(bossBtn, 'aria-label', `Back to ${session.name}, the agent ${sub.name || 'this crew member'} works for`);
    }

    // actions: fixed slots, switched off in place when they do not apply
    const nextTask = sub ? null : ctx.runningTaskFor(session, state);
    if (nextTask !== currentTask) { currentTask = nextTask; disarmStop(); }
    paintStop();
    aRename.btn.disabled = !!sub;
    aGroup.btn.disabled = !!sub;
    setAttr(aRename.btn, 'title', sub ? `Crew carry the name of ${session.name}'s task` : 'Name this task (E)');
    setAttr(aGroup.btn, 'title', sub ? `Crew follow ${session.name}'s group` : 'Put this task in a group (G)');
    const txOpen = txFor === session.id;
    setAttr(aTranscript.btn, 'aria-pressed', txOpen ? 'true' : 'false');
    setAttr(aTranscript.btn, 'title', txOpen ? 'Close the transcript (T)' : sub ? `Open ${session.name}'s transcript (T)` : 'Read the whole conversation (T)');
    setAttr(aClose.btn, 'title', 'Close this box and clear the selection (Esc)');

    // portrait: redraw when the face could have changed
    const pKey = `${id}|${sub ? sub.status : session.status}|${session.mode}|${ctx.portraitSource()}`;
    if (pKey !== lastPortraitKey) {
      lastPortraitKey = pKey;
      ctx.drawPortrait(canvas, session, sub || undefined);
    }
  }

  function logRow(ev) {
    const time = h('time', { class: 'log-time num' });
    const who = h('span', { class: 'log-who' });
    const text = h('span', { class: 'log-text' });
    const btn = h('button', { class: 'log-row', type: 'button', on: { click: () => { const e2 = li.__ev; if (e2 && e2.selectId) ctx.selectIfPresent(e2.selectId); } } }, time, who, text);
    const li = h('li', null, btn);
    li.__parts = { time, who, text, btn };
    return li;
  }
  function paintRow(li, ev) {
    li.__ev = ev;
    const p = li.__parts;
    setText(p.time, fmtClockShort(ev.ts));
    setText(p.who, ev.name || '');
    setHidden(p.who, !ev.name);
    setTextTitle(p.text, ev.text);
    setAttr(p.btn, 'data-tool', ev.tool || null);
    setAttr(p.btn, 'data-kind', ev.kind);
    p.btn.tabIndex = ev.selectId ? 0 : -1;
    setClass(p.btn, 'is-static', !ev.selectId);
  }

  function renderLog() {
    const log = ctx.log;
    if (log.version === lastLogVersion) return;
    lastLogVersion = log.version;
    if (mode === 'ticker') {
      const items = log.events.slice(0, 2);
      setHidden(tickEmpty, items.length > 0);
      reconcile(tickList, items, (e) => e.id, logRow, paintRow);
    } else if (mode === 'log') {
      setHidden(logEmpty, log.events.length > 0);
      setText(logCount, `${log.events.length} event${log.events.length === 1 ? '' : 's'}`);
      // reading back through the log: new lines must not yank the list
      const away = logList.scrollTop > 4 ? logList.scrollHeight - logList.scrollTop : -1;
      reconcile(logList, log.events, (e) => e.id, logRow, paintRow);
      if (away >= 0) logList.scrollTop = logList.scrollHeight - away;
    }
  }

  // ---------------------------------------------------------------- focus: where it came from, where it rests
  let returnFocus = null;
  const usable = (n) => !!n && document.contains(n) && typeof n.focus === 'function' && !n.closest('[hidden]');

  /** Leave a field without leaving the box: the keys work again, Tab carries on from here. */
  function park() {
    if (!current) return;
    charView.focus({ preventScroll: true });
  }

  function restoreFocus() {
    const ae = document.activeElement;
    if (ae && ae !== document.body && !el.contains(ae)) return; // the user is already somewhere else
    if (usable(returnFocus)) { try { returnFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
    else if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
    returnFocus = null;
  }

  function update(state, sel) {
    const was = current;
    const ae = document.activeElement;
    if (sel && (!was || was.id !== sel.id)) {
      if (!ae || ae === document.body) { if (!was) returnFocus = null; }
      else if (!el.contains(ae) && !ae.closest('#modals')) returnFocus = ae;
    }
    current = sel;
    lastState = state;
    if (sel) {
      logOpen = false;
      if (!was || was.id !== sel.id) { disarmStop(); setText(srStatus, ''); }
      setHidden(charView, false); // laid out before it is filled: what is measured in there is real
      setHidden(tickView, true);
      setHidden(logView, true);
      renderChar(sel, state);
    } else {
      setAttr(el, 'data-tool', null);
      setAttr(el, 'data-status', null);
      setAttr(el, 'data-crew', null);
      setAttr(el, 'data-sub', null);
      if (renaming) cancelRename();
      setHidden(titleError, true);
      if (typeTimer) { clearInterval(typeTimer); typeTimer = 0; }
      saySpeaker = null;
      sayNorm = null;
      lastPortraitKey = '';
      currentTask = null;
      failTask = null;
      reply = null;
      disarmStop();
      composer.update(null);
    }
    applyMode();
    renderLog();
    if (was && !sel) restoreFocus();
    if (sel) paintFade();
  }

  let lastTick = 0;
  const lastNow = () => lastTick || Date.now();
  function tick(now) {
    lastTick = now;
    if (!current) return;
    const { session, sub } = current;
    // [word][value]: where the line is tight the word goes and the time stays
    let word = '';
    let value = '';
    if (sub) {
      const ts = sub.endedAt || sub.lastActivityAt;
      if (ts) { word = sub.status === 'working' ? 'active ' : 'finished '; value = `${fmtAgo(now - ts)} ago`; }
    } else if (failTask && failTask.endedAt && reply && reply.phase === 'failed') {
      word = 'failed ';
      value = `${fmtAgo(now - failTask.endedAt)} ago`;
    } else if (reply && (reply.phase === 'sent' || reply.phase === 'answered') && session.status !== 'working') {
      word = 'replied ';
      value = reply.answeredAt > 1 ? `${fmtAgo(Date.now() - reply.answeredAt)} ago` : 'just now';
    } else if (session.lastActivityAt) {
      const d = fmtAgo(now - session.lastActivityAt);
      if (session.status === 'waiting') { word = 'needs you '; value = d; }
      else if (session.status === 'idle') { word = session.turnState === 'ended' ? 'turn ended ' : 'quiet for '; value = session.turnState === 'ended' ? `${d} ago` : d; }
      else { word = 'active '; value = `${d} ago`; }
    }
    setText(agoWord, word);
    setText(agoValue, value);
    setAttr(ago, 'title', value ? `Last activity: ${word}${value}` : null);
  }

  // the box grows and shrinks with what it holds: say so (debounced), so the office can move its camera
  let layoutTimer = 0;
  let lastH = -1;
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      paintFade();
      const hNow = el.offsetHeight;
      if (hNow === lastH) return;
      lastH = hNow;
      clearTimeout(layoutTimer);
      layoutTimer = setTimeout(() => { if (ctx.onLayout) ctx.onLayout(); }, LAYOUT_DEBOUNCE_MS);
    }).observe(el);
    new ResizeObserver(() => paintFade()).observe(prose);
  }
  // a reply was sent, armed, failed…: the chip up here follows at once, not at the next snapshot
  onReplyState(() => { if (current && !current.sub) { renderChar(current, lastState); tick(lastNow()); } });
  // a taller or shorter window can turn the crew column into a strip (and back)
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { rerender(); paintFade(); });
  });
  // PageUp / PageDown read the message while nothing else has the keyboard (the page, the office)
  window.addEventListener('keydown', (e) => {
    if ((e.key !== 'PageUp' && e.key !== 'PageDown') || e.defaultPrevented || !current || compact || say.hidden) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.tagName !== 'CANVAS') return;
    if (modalOpen()) return;
    e.preventDefault();
    pageMessage(e.key === 'PageDown' ? 1 : -1);
  });

  return {
    el, update, tick,
    redrawPortrait() { lastPortraitKey = ''; },
    mode: () => mode,
    isLogOpen: () => mode === 'log',
    toggleLog() { setLogOpen(mode !== 'log'); },
    closeLog() { setLogOpen(false); },
    focusActions() { (current && !current.sub ? aTranscript.btn : bossBtn).focus(); },
    /** M (and Y): put the caret in the reply field. A crew member has none: its way back to the boss gets the focus. */
    focusComposer() {
      if (!current) return false;
      if (current.sub) { bossBtn.focus({ preventScroll: true }); return true; }
      return composer.focus();
    },
    /** TRY AGAIN on a reply that failed: the same words, back in the field. */
    compose(seed) {
      if (!current || current.sub) return false;
      composer.seed(seed || {});
      return composer.focus();
    },
    /** Esc, innermost first: an armed STOP stands down before anything closes. */
    handleEscape() {
      if (disarmStop()) { setText(srStatus, 'Stop cancelled.'); return true; }
      if (current && !current.sub && composer.disarm()) return true; // SEND ANYWAY stands down too
      return false;
    },
    /** The transcript opened or closed: while it is open it is the reading surface and carries the reply field. */
    setTranscript(openFor) {
      const next = openFor || null;
      if (next === txFor && compact === !!next) return;
      txFor = next;
      compact = !!next;
      setAttr(el, 'data-compact', compact ? 'true' : null);
      rerender();
    },
    /** E: rename the selected task in place. False when there is nothing to rename. */
    startRename,
    isRenaming: () => renaming,
    /** G: open the group menu for the selected agent. */
    openGroup() {
      if (!current || current.sub) return false;
      ctx.openGroupMenu(current.session, groupAnchor());
      return true;
    },
  };
}

export { TOOL_INFO };
