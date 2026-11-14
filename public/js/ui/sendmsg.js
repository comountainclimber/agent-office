// SEND MESSAGE (modal): resume one session with a follow-up prompt (a new headless run of that session).
// The everyday path is the reply field in the dialogue and the transcript (composer.js). This modal is the
// fallback for a window too small to hold that field (see replyNeedsModal() in app.js).
import { h, setText, setHidden, toolBadge, shortPath, TOOL_INFO } from './dom.js';
import { openModal } from './modal.js';
import { permissionPicker, permissionNote, submitHint } from './newtask.js';
import { taskName } from '../groups.js';
import { markReplied } from './composer.js';

export function openSendMessage(ctx, session) {
  let posting = false;
  let notes = ctx.meta ? ctx.meta.permissionNotes : null;
  const toolLabel = TOOL_INFO[session.tool]?.label || String(session.tool).toUpperCase();

  const modal = openModal({ title: `MESSAGE ${session.name}`, className: 'modal-send', labelBadge: toolBadge(session.tool) });
  modal.el.dataset.tool = session.tool;

  const explain = h('div', { class: 'callout' },
    h('span', { class: 'callout-tag', text: 'HEADS UP' }),
    h('p', { text: `This starts a new headless ${toolLabel} run that resumes ${session.name}'s conversation. The window where ${session.name} is already open will not show it live: follow it here, in TASKS and the transcript.` }));

  const target = h('p', { class: 'send-target' });
  target.append(h('span', { class: 'send-target-title', text: taskName(session) || '(untitled session)', title: session.title || '' }),
    h('span', { class: 'send-target-cwd', text: shortPath(session.cwd), title: session.cwd || '' }));

  const promptError = h('p', { class: 'field-error', hidden: true, attrs: { role: 'alert' } });
  const prompt = h('textarea', {
    class: 'input nt-prompt', rows: 5, placeholder: `What should ${session.name} do next?`,
    attrs: { 'aria-label': 'Follow-up prompt' },
    on: {
      input: () => { setHidden(promptError, true); setHidden(formError, true); },
      keydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } },
    },
  });

  const seed = ctx.seed || {};
  if (seed.prompt) prompt.value = seed.prompt;
  const perm = permissionPicker({ value: seed.permission || 'edit', getNote: (p) => permissionNote(notes, session.tool, p) });

  // The server refuses to resume a session that is mid-turn unless told to: make that a visible choice.
  let sawConflict = false;
  const force = h('input', { type: 'checkbox', class: 'check', on: { change: () => setHidden(formError, true) } });
  const busyText = h('p');
  const busy = h('div', { class: 'callout callout-danger', hidden: true },
    h('span', { class: 'callout-tag', text: 'MID-TURN' }),
    h('div', null, busyText, h('label', { class: 'check-label' }, force, h('span', { text: 'Send anyway' }))));
  const isWorking = () => { const s = ctx.getSession ? ctx.getSession(session.id) : session; return !!s && s.status === 'working'; };
  function paintBusy() {
    const show = sawConflict || isWorking();
    setHidden(busy, !show);
    setText(busyText, `${session.name} is in the middle of a turn. Sending now puts a second run on the same conversation and the two can trip over each other. Safer to wait until it needs you.`);
  }
  paintBusy();
  const busyTimer = setInterval(() => { if (modal.isOpen()) paintBusy(); else clearInterval(busyTimer); }, 1000);

  const formError = h('p', { class: 'form-error', hidden: true, attrs: { role: 'alert' } });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'CANCEL', on: { click: () => modal.close() } });
  const sendLabel = h('span', { text: 'SEND' });
  const send = h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => submit() } }, sendLabel, submitHint());

  modal.body.append(
    target, explain, busy,
    h('section', { class: 'nt-field' }, h('h3', { class: 'nt-label', text: 'YOUR MESSAGE' }), prompt, promptError),
    h('section', { class: 'nt-field' }, h('h3', { class: 'nt-label', text: 'HOW MUCH ROPE' }), perm.el));
  modal.foot.append(formError, h('div', { class: 'modal-actions' }, cancel, send));
  modal.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target !== prompt) { e.preventDefault(); submit(); }
  });

  async function submit() {
    if (posting) return;
    setHidden(formError, true);
    const text = prompt.value.trim();
    if (!text) {
      setText(promptError, 'Write the message first.');
      setHidden(promptError, false);
      prompt.focus();
      return;
    }
    if (!busy.hidden && !force.checked) {
      setText(formError, `${session.name} is mid-turn. Wait for it to finish, or tick "Send anyway".`);
      setHidden(formError, false);
      force.focus();
      return;
    }
    posting = true;
    send.disabled = true;
    cancel.disabled = true;
    setText(sendLabel, 'SENDING…');
    modal.setBusy(true);
    try {
      const task = await ctx.api.sendMessage(session.id, { prompt: text, permission: perm.value, ...(force.checked ? { force: true } : {}) });
      modal.setBusy(false);
      modal.close(true);
      // same rule as the reply field: it no longer needs you from this moment, not from the next snapshot
      const live = ctx.getSession ? ctx.getSession(session.id) : session;
      markReplied(session.id, Math.max(Date.now(), (live && live.lastActivityAt) || 0));
      ctx.onSent(task, session);
    } catch (e) {
      posting = false;
      modal.setBusy(false);
      send.disabled = false;
      cancel.disabled = false;
      setText(sendLabel, 'SEND');
      if (e && e.status === 409) { sawConflict = true; paintBusy(); }
      setText(formError, e && e.message ? e.message : String(e));
      setHidden(formError, false);
      send.focus();
    }
  }

  if (!notes && ctx.loadMeta) ctx.loadMeta().then((m) => { if (m && modal.isOpen()) { notes = m.permissionNotes; perm.refresh(); } });
  prompt.focus();
  return modal;
}
