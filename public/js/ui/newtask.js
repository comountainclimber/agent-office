// NEW TASK: prompt first. The prompt is the big field with the caret in it; who / where / permissions
// are compact rows that remember what you chose last time, so a returning user presses N, types, Cmd+Enter.
// WHERE starts at the folder you last launched in, else the folder most of the office is working in — never a
// scratch folder (/tmp, /private/tmp, /var/folders): those stay pickable under RECENT, after the real ones.
// Optional extras: a name, a group, and (under ADVANCED) a model.
//
// Nothing in the form moves while you use it: every error has a reserved place (inside the prompt box, on the
// RECENT line, in the footer) and the permission blurb + note keep a fixed height.
//
// Models: a model name is only remembered for a tool once a task using it has really run (app.js calls
// rememberModel() when the task is running with output, or done; forgetModel() when it failed at the door).
// The field offers the models that worked before. A retry after a failure (seed.failure) opens ADVANCED,
// repeats the error under the field and puts the caret there.
import { h, setText, setAttr, setClass, setHidden, reconcile, shortPath, store, isTempPath, TOOL_INFO, TOOL_ORDER } from './dom.js';
import { openModal, openPopover, radioGroup } from './modal.js';
import { openGroupMenu, groupFlag, setFlag, autoGroupFor } from './groupui.js';

/** What to type in a terminal when a CLI is signed out. */
export const LOGIN_COMMAND = { claude: 'claude auth login', codex: 'codex login', cursor: 'cursor-agent login' };

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = h('textarea', { value: text, attrs: { readonly: true, 'aria-hidden': 'true' } });
      ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

/** `run <command> in a terminal` with a COPY button. */
export function loginHint(tool) {
  const cmd = LOGIN_COMMAND[tool] || 'login';
  const code = h('code', { class: 'cmd', text: cmd });
  const btn = h('button', { class: 'btn btn-mini', type: 'button', text: 'COPY', title: `Copy "${cmd}"`, on: { click: async () => {
    const ok = await copyText(cmd);
    setText(btn, ok ? 'COPIED' : 'SELECT IT');
    if (!ok) { const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    setTimeout(() => setText(btn, 'COPY'), 1600);
  } } });
  return h('span', { class: 'login-hint' }, h('span', { text: 'run' }), code, h('span', { text: 'in a terminal' }), btn);
}

// ---- models that worked ---------------------------------------------------------------------------
// prefix: 'ao.' for real launches, 'ao.demo.' for the demo (see storePrefix()).
export const storePrefix = (mock) => (mock ? 'ao.demo.' : 'ao.');

export function knownModels(prefix, tool) {
  try {
    const list = JSON.parse(store.get(`${prefix}models.${tool}`, '[]'));
    return Array.isArray(list) ? list.filter((m) => typeof m === 'string' && m) : [];
  } catch { return []; }
}

/**
 * The model NEW TASK starts with for a tool: the remembered one, but only if it is on the "worked before" list.
 * (Older builds remembered whatever was typed, even when the launch failed; such a leftover is ignored.)
 */
export function defaultModel(prefix, tool) {
  const m = store.get(`${prefix}model.${tool}`, '') || '';
  return m && knownModels(prefix, tool).includes(m) ? m : '';
}

/** A task with this model ran: make it the default for the tool and offer it next time. '' = the CLI's default. */
export function rememberModel(prefix, tool, model) {
  const m = String(model || '').trim();
  store.set(`${prefix}model.${tool}`, m);
  if (!m) return;
  const list = knownModels(prefix, tool).filter((x) => x !== m);
  list.unshift(m);
  store.set(`${prefix}models.${tool}`, JSON.stringify(list.slice(0, 8)));
}

/** A launch with this model failed: never offer it as the default again. */
export function forgetModel(prefix, tool, model) {
  const m = String(model || '').trim();
  if (!m) return;
  if (store.get(`${prefix}model.${tool}`, '') === m) store.set(`${prefix}model.${tool}`, '');
  const list = knownModels(prefix, tool);
  if (list.includes(m)) store.set(`${prefix}models.${tool}`, JSON.stringify(list.filter((x) => x !== m)));
}

export const PERMISSIONS = [
  { value: 'read', label: 'READ ONLY', blurb: 'Looks, plans and answers. Changes nothing.' },
  { value: 'edit', label: 'EDIT FILES', blurb: 'May edit files in the folder. No unrestricted shell.' },
  { value: 'full', label: 'FULL AUTO', blurb: 'No prompts at all: it can run any command on this machine without asking.' },
];

/** Normalise whatever /api/meta sends as permissionNotes into one line for (tool, permission). */
export function permissionNote(notes, tool, permission) {
  if (!notes || !tool) return '';
  const forTool = notes[tool];
  if (!forTool) return '';
  if (typeof forTool === 'string') return forTool;
  const v = forTool[permission];
  if (typeof v === 'string') return v;
  if (typeof forTool.note === 'string') return forTool.note;
  return '';
}

export function permissionPicker({ value = 'edit', getNote }) {
  const blurb = h('p', { class: 'perm-blurb' });
  const note = h('p', { class: 'perm-note', hidden: true });
  const group = radioGroup({
    label: 'Permissions',
    className: 'perm-radios',
    value,
    options: PERMISSIONS.map((p) => ({
      value: p.value,
      render(btn) {
        btn.classList.add('perm');
        btn.dataset.perm = p.value;
        btn.setAttribute('aria-label', `${p.label}: ${p.blurb}`);
        btn.append(h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }), h('span', { text: p.label }));
      },
    })),
    onChange: () => paint(),
  });
  function paint() {
    const p = PERMISSIONS.find((x) => x.value === group.value) || PERMISSIONS[1];
    setText(blurb, p.blurb);
    setClass(blurb, 'is-warning', p.value === 'full');
    const n = getNote ? getNote(p.value) : '';
    setText(note, n);
    setAttr(note, 'title', n || null);
    setClass(note, 'is-empty', !n); // it keeps its two lines either way, so the rows below never move
  }
  note.hidden = false;
  paint();
  const el = h('div', { class: 'perm-picker' }, group.el, h('div', { class: 'perm-text' }, blurb, note));
  return { el, get value() { return group.value; }, refresh: paint };
}

/** The little key hint on submit buttons: ⌘↵ on a Mac, CTRL ↵ elsewhere. */
export function submitHint() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  return h('kbd', { class: 'sym', text: mac ? '⌘↵' : 'Ctrl ↵', title: mac ? 'Command + Enter' : 'Control + Enter' });
}

/** Where NEW TASK starts: the last folder launched in, else the commonest folder in the office. Never a scratch folder. */
function pickDefaultCwd(last, sessions, hint) {
  if (last && !isTempPath(last)) return last;
  const counts = new Map();
  for (const s of sessions || []) {
    if (s.cwd && s.cwd.startsWith('/') && !isTempPath(s.cwd)) counts.set(s.cwd, (counts.get(s.cwd) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [dir, n] of counts) {
    const score = n + (dir === hint ? 0.5 : 0); // the selected agent's folder wins a tie
    if (score > bestN) { best = dir; bestN = score; }
  }
  return best;
}

export function openNewTask(ctx) {
  const state0 = ctx.getState();
  const seed = ctx.seed || {};
  const getTools = () => { const s = ctx.getState(); return (s && s.tools) || {}; };
  const getGroups = () => { const s = ctx.getState(); return (s && s.groups) || []; };
  const tools0 = getTools();
  const recentAll = (state0 && state0.recentDirs) || [];
  const recent = [...recentAll.filter((d) => !isTempPath(d)), ...recentAll.filter((d) => isTempPath(d))]; // project folders first
  const usable = (t) => !tools0[t] || tools0[t].available !== false;
  // what the demo remembers must never become a default for real launches (and the other way round)
  const K = storePrefix(ctx.api && ctx.api.mode === 'mock');
  const modelDraft = new Map(); // tool -> what is typed in MODEL right now (kept while you switch tools, never stored)

  const defaultCwd = () => pickDefaultCwd(store.get(`${K}cwd`, '') || '', state0 && state0.sessions, seed.hintCwd);
  let tool = seed.tool || store.get(`${K}tool`, '');
  if (!TOOL_ORDER.includes(tool) || !usable(tool)) tool = TOOL_ORDER.find(usable) || '';
  let cwd = seed.cwd || defaultCwd(); // seed.cwd: a retry goes back to the folder it was started in, whatever that was
  const permSeed = seed.permission || store.get(`${K}perm`, 'edit');
  let posting = false;
  let notes = ctx.meta ? ctx.meta.permissionNotes : null;
  let browseSeq = 0;
  let browsePath = '';
  let armed = false; // signed-out CLI: START needs a deliberate second press
  let picker = null; // the folder popover, while open
  let timer = 0;
  /** groupPick: undefined = follow the folder's auto-group, null = no group, string = that group */
  let groupPick = seed.groupId !== undefined ? seed.groupId : ctx.defaultGroupId || undefined;
  const madeGroups = new Map(); // groups created from this menu, until the next state carries them

  const modal = openModal({ title: 'NEW TASK', className: 'modal-newtask', onClose: () => { browseSeq += 1; clearInterval(timer); } });

  // ---- WHAT: the main event ------------------------------------------------------------------
  const promptError = h('p', { class: 'field-error nt-prompt-error', hidden: true, attrs: { role: 'alert' } });
  const prompt = h('textarea', {
    class: 'input nt-prompt', rows: 6, placeholder: 'What should they do?', spellcheck: true,
    attrs: { 'aria-label': 'Prompt: what should the agent do?' },
    on: {
      input: () => { setHidden(promptError, true); if (!formError.hidden) { setHidden(formError, true); paintLive(); } },
      keydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } },
    },
  });
  if (seed.prompt) prompt.value = seed.prompt;
  const what = h('section', { class: 'nt-what' }, prompt, promptError);

  // ---- WHO -----------------------------------------------------------------------------------
  const toolError = h('p', { class: 'field-error', hidden: true, attrs: { role: 'alert' } });
  const cardSubs = {};
  const toolGroup = radioGroup({
    label: 'Agent',
    className: 'agent-cards',
    value: tool,
    options: TOOL_ORDER.map((t) => ({
      value: t,
      render(btn) {
        const off = !usable(t);
        btn.classList.add('agent-card');
        btn.dataset.tool = t;
        btn.disabled = off;
        btn.setAttribute('aria-label', TOOL_INFO[t].label);
        cardSubs[t] = h('span', { class: 'agent-card-sub' });
        btn.append(
          h('span', { class: 'agent-card-badge', text: TOOL_INFO[t].badge, attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'agent-card-name', text: TOOL_INFO[t].label }),
          cardSubs[t]);
        if (off) btn.title = `${TOOL_INFO[t].label} was not found on this machine, so the office cannot start it.`;
      },
    })),
    onChange: (v) => {
      modelDraft.set(tool, modelInput.value); // keep what was typed for the tool we are leaving (in this menu only)
      tool = v;
      armed = false;
      modelInput.value = modelDraft.has(tool) ? modelDraft.get(tool) : defaultModel(K, tool);
      setHidden(advError, true);
      paintModels();
      setHidden(toolError, true);
      perm.refresh();
      paintLive();
    },
  });
  const anyTool = TOOL_ORDER.some(usable);

  // ---- WHERE ---------------------------------------------------------------------------------
  const cwdError = h('p', { class: 'field-error nt-cwd-error', hidden: true, attrs: { role: 'alert' } });
  // the folder error takes the RECENT line's place instead of adding a line
  const showCwdError = (text) => { if (text) setText(cwdError, text); setAttr(cwdError, 'title', text || null); setHidden(cwdError, !text); setHidden(quick, !!text); };
  const pathInput = h('input', {
    class: 'input nt-path', type: 'text', value: cwd, placeholder: 'Folder to work in: pick one, or type a path', spellcheck: false, autocomplete: 'off',
    attrs: { 'aria-label': 'Folder to work in' },
    on: {
      input: () => { cwd = pathInput.value.trim(); showCwdError(''); paintLive(); },
      keydown: (e) => {
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); check(pathInput.value.trim()); }
        if (e.key === 'ArrowDown') { e.preventDefault(); openPicker(); }
      },
      change: () => { const v = pathInput.value.trim(); if (v && v !== browsePath) check(v); },
    },
  });
  const browseBtn = h('button', { class: 'btn nt-browse', type: 'button', title: 'Recent folders and a folder browser', attrs: { 'aria-haspopup': 'dialog' }, on: { click: () => openPicker() } },
    h('span', { class: 'ico ico-folder', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'BROWSE' }));
  // one-click recent folders (as many as fit on the line)
  const quick = h('div', { class: 'nt-quick', attrs: { role: 'group', 'aria-label': 'Recent folders' } });
  const quickBtns = recent.slice(0, 8).map((dir) => {
    const parts = String(dir).split('/').filter(Boolean);
    const b = h('button', { class: 'nt-quick-btn', type: 'button', text: parts[parts.length - 1] || '/', title: dir, on: { click: () => choose(dir) } });
    b.__dir = dir;
    return b;
  });
  if (quickBtns.length) quick.append(h('span', { class: 'nt-quick-label', text: 'RECENT' }), ...quickBtns);

  // the folder popover: RECENT + BROWSE (built once, hung up on demand)
  const recentList = h('ul', { class: 'menu nt-recent-list', attrs: { 'aria-label': 'Recent folders' } });
  const recentEmpty = h('p', { class: 'nt-empty', text: 'No recent folders yet.', hidden: recent.length > 0 });
  function paintRecent() {
    reconcile(recentList, recent.slice(0, 12), (d) => d, (dir) => {
      const parts = String(dir).split('/').filter(Boolean);
      const btn = h('button', { class: 'menu-item nt-recent', type: 'button', title: dir, on: { click: () => { choose(dir); closePicker(); } } },
        h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'nt-recent-name', text: parts[parts.length - 1] || '/' }),
        h('span', { class: 'nt-recent-path', text: shortPath(parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/') }));
      const li = h('li', null, btn);
      li.__btn = btn;
      return li;
    }, (li, dir) => setAttr(li.__btn, 'aria-current', dir === cwd ? 'true' : null));
    for (const b of quickBtns) setAttr(b, 'aria-pressed', b.__dir === cwd ? 'true' : 'false');
  }
  const crumbs = h('nav', { class: 'nt-crumbs', attrs: { 'aria-label': 'Current folder' } });
  const dirList = h('ul', { class: 'menu nt-dir-list', attrs: { 'aria-label': 'Sub-folders' } });
  const browseStatus = h('p', { class: 'nt-empty', attrs: { role: 'status' } });
  const useBtn = h('button', { class: 'btn btn-primary', type: 'button', text: 'USE THIS FOLDER', on: { click: () => closePicker() } });
  const pickerBody = h('div', { class: 'nt-picker' },
    h('div', { class: 'nt-box' }, h('h4', { class: 'nt-sub', text: 'RECENT' }), recentList, recentEmpty),
    h('div', { class: 'nt-box' }, h('h4', { class: 'nt-sub', text: 'BROWSE' }), crumbs, dirList, browseStatus, h('div', { class: 'nt-picker-foot' }, useBtn)));

  function openPicker() {
    if (picker && picker.isOpen()) return;
    picker = openPopover({ anchor: pathInput, className: 'pop-folders', label: 'Pick a folder', onClose: () => { picker = null; } });
    picker.el.append(pickerBody);
    paintRecent();
    picker.place();
    browse(cwd || browsePath || '', { initial: !cwd }).then(() => picker && picker.place());
    const cur = recentList.querySelector('[aria-current]') || recentList.querySelector('button') || dirList.querySelector('button') || useBtn;
    cur.focus();
  }
  function closePicker() { if (picker) picker.close(); }

  function choose(dir) {
    cwd = dir;
    pathInput.value = dir;
    showCwdError('');
    paintRecent();
    paintLive();
    if (picker) browse(dir);
  }

  function paintCrumbs(path) {
    const parts = String(path).split('/').filter(Boolean);
    const nodes = [h('button', { class: 'crumb', type: 'button', text: '/', title: '/', on: { click: () => choose('/') } })];
    parts.forEach((part, i) => {
      const full = '/' + parts.slice(0, i + 1).join('/');
      if (i > 0) nodes.push(h('span', { class: 'crumb-sep', text: '/', attrs: { 'aria-hidden': 'true' } }));
      const last = i === parts.length - 1;
      nodes.push(h('button', { class: 'crumb', type: 'button', text: part, title: full, attrs: { 'aria-current': last ? 'location' : null }, on: { click: () => choose(full) } }));
    });
    crumbs.replaceChildren(...nodes);
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  /** A typed path: ask the server whether it is a folder, and say so in place if it is not. */
  async function check(path) {
    if (!path) return;
    const seq = ++browseSeq;
    try {
      const res = await ctx.api.getDirs(path);
      if (seq !== browseSeq || !modal.isOpen()) return;
      browsePath = res.path;
      cwd = res.path;
      pathInput.value = res.path;
      showCwdError('');
      paintRecent();
      paintLive();
    } catch (e) {
      if (seq !== browseSeq || !modal.isOpen()) return;
      showCwdError(`Can't open that folder: ${e && e.message ? e.message : e}`);
    }
  }

  async function browse(path, { initial = false } = {}) {
    const seq = ++browseSeq;
    setText(browseStatus, 'LOOKING…');
    setHidden(browseStatus, false);
    setClass(browseStatus, 'is-error', false);
    try {
      const res = await ctx.api.getDirs(path || '');
      if (seq !== browseSeq || !modal.isOpen()) return;
      browsePath = res.path;
      // The folder you are looking at is the folder that is chosen — except when nothing was chosen
      // yet, where the browser shows the default folder but nothing is picked until you click.
      if (!(initial && !cwd)) { cwd = res.path; pathInput.value = res.path; }
      paintCrumbs(res.path);
      const entries = [];
      if (res.parent != null && res.parent !== res.path) entries.push({ key: '..', name: '..', path: res.parent, up: true });
      for (const d of res.dirs) entries.push({ key: d, name: d, path: (res.path === '/' ? '' : res.path) + '/' + d });
      dirList.replaceChildren();
      dirList.__keyed = new Map();
      reconcile(dirList, entries, (x) => x.key, (x) => h('li', null,
        h('button', { class: `menu-item nt-dir${x.up ? ' nt-dir-up' : ''}`, type: 'button', title: x.up ? `Up to ${x.path}` : x.path, on: { click: () => { choose(x.path); requestAnimationFrame(() => { const b = dirList.querySelector('button'); if (b && picker) b.focus(); }); } } },
          h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: `ico ${x.up ? 'ico-up' : 'ico-folder'}`, attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'nt-dir-name', text: x.up ? 'UP ONE LEVEL' : x.name }))));
      dirList.scrollTop = 0;
      setHidden(browseStatus, res.dirs.length > 0 && !res.truncated);
      if (!res.dirs.length) setText(browseStatus, 'No sub-folders here.');
      else if (res.truncated) setText(browseStatus, `Showing the first ${res.dirs.length} folders. Type a path to go straight to one.`);
      showCwdError('');
      paintRecent();
      paintLive();
    } catch (e) {
      if (seq !== browseSeq || !modal.isOpen()) return;
      setText(browseStatus, `Can't list folders: ${e && e.message ? e.message : e}`);
      setClass(browseStatus, 'is-error', true);
      if (path) browse('', { initial: true }); // that folder is gone: show the default one
    }
  }

  // ---- PERMISSIONS -----------------------------------------------------------------------------
  const perm = permissionPicker({ value: PERMISSIONS.some((p) => p.value === permSeed) ? permSeed : 'edit', getNote: (p) => permissionNote(notes, tool, p) });

  // ---- NAME + GROUP (optional) -----------------------------------------------------------------
  const nameInput = h('input', {
    class: 'input nt-name', type: 'text', maxLength: 60, placeholder: 'optional: a short name for this task', spellcheck: false, autocomplete: 'off',
    attrs: { 'aria-label': 'Name for this task (optional)' },
  });
  if (seed.label) nameInput.value = seed.label;
  const gFlag = groupFlag(null);
  const gName = h('span', { class: 'nt-group-name' });
  const gNote = h('span', { class: 'nt-group-note' });
  const groupBtn = h('button', { class: 'btn nt-group', type: 'button', attrs: { 'aria-haspopup': 'dialog' }, on: { click: () => openGroups() } },
    gFlag, gName, gNote, h('span', { class: 'ico ico-down', attrs: { 'aria-hidden': 'true' } }));
  const groupError = h('p', { class: 'field-error', hidden: true, attrs: { role: 'alert' } });

  const allGroups = () => { const live = getGroups(); return [...live, ...[...madeGroups.values()].filter((g) => !live.some((x) => x.id === g.id))]; };
  const autoGroup = () => autoGroupFor(allGroups(), cwd);
  function effectiveGroup() {
    if (groupPick === null) return null;
    if (groupPick !== undefined) return allGroups().find((g) => g.id === groupPick) || null;
    return autoGroup();
  }
  function openGroups() {
    const eff = effectiveGroup();
    openGroupMenu({
      anchor: groupBtn,
      heading: 'GROUP FOR THIS TASK',
      groups: allGroups(),
      currentId: eff ? eff.id : null,
      onPick: (id) => { groupPick = id; paintLive(); },
      onCreate: async (name) => {
        const g = await ctx.createGroup(name);
        if (g) { madeGroups.set(g.id, g); groupPick = g.id; }
        paintLive();
      },
    });
  }

  // ---- ADVANCED: model -------------------------------------------------------------------------
  const modelInput = h('input', {
    class: 'input nt-model', type: 'text', placeholder: 'default', spellcheck: false, autocomplete: 'off', maxLength: 80,
    attrs: { 'aria-label': 'Model (optional). Leave empty for the default.' },
    on: { input: () => paintLive() },
  });
  modelInput.value = seed.model != null ? seed.model : defaultModel(K, tool);
  modelInput.addEventListener('input', () => setHidden(advError, true));
  // models that worked before for this tool
  const modelList = h('datalist', { id: 'nt-model-list' });
  modelInput.setAttribute('list', 'nt-model-list');
  const advHelp = h('span', { class: 'nt-adv-help' });
  function paintModels() {
    const known = knownModels(K, tool);
    modelList.replaceChildren(...known.map((m) => h('option', { value: m })));
    setText(advHelp, known.length
      ? `Passed to the CLI as its model. Worked before: ${known.slice(0, 3).join(', ')}${known.length > 3 ? '…' : ''}. Empty = the default.`
      : 'Free text, passed to the CLI as its model. Empty = the default. A name is remembered once a task using it has run.');
  }
  // a retry after a failure repeats the reason here, next to the field that most often caused it
  const failure = seed.failure && seed.failure.text ? seed.failure : null;
  let advOpen = !!failure;
  const advError = h('p', { class: 'field-error nt-adv-error', hidden: !failure, attrs: { role: 'alert' } });
  if (failure) { setText(advError, `Last try failed: ${failure.text}`); setAttr(advError, 'title', failure.text); }
  const advSummary = h('span', { class: 'nt-adv-summary' });
  const advBtn = h('button', { class: 'nt-adv-btn', type: 'button', attrs: { 'aria-expanded': 'false', 'aria-controls': 'nt-adv-body' }, on: { click: () => { advOpen = !advOpen; paintLive(); if (advOpen) modelInput.focus(); } } },
    h('span', { class: 'ico ico-right nt-adv-chev', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'ADVANCED' }), advSummary);
  const advBody = h('div', { class: 'nt-adv-body', id: 'nt-adv-body', hidden: true },
    h('label', { class: 'nt-rowlabel', text: 'MODEL', attrs: { for: 'nt-model' } }), modelInput, advHelp, modelList, advError);
  modelInput.id = 'nt-model';
  paintModels();

  // ---- footer ----------------------------------------------------------------------------------
  const signTag = h('span', { class: 'callout-tag', text: 'SIGNED OUT' });
  const signText = h('span', { class: 'signin-text' });
  const signHintSlot = h('span', { class: 'signin-hint' });
  const signin = h('div', { class: 'callout callout-danger nt-signin', hidden: true, attrs: { role: 'alert' } }, signTag, h('div', { class: 'signin-body' }, signText, signHintSlot));
  let signHintFor = null;
  const formError = h('p', { class: 'form-error', hidden: true, attrs: { role: 'alert' } });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'CANCEL', on: { click: () => modal.close() } });
  const startLabel = h('span', { text: 'START' });
  const start = h('button', { class: 'btn btn-primary nt-start', type: 'button', attrs: { 'aria-label': 'Start the task' }, on: { click: () => submit() } }, startLabel, submitHint());
  if (!anyTool) start.disabled = true;

  const row = (label, cls, ...kids) => h('div', { class: `nt-row ${cls}` }, h('h3', { class: 'nt-rowlabel', text: label }), h('div', { class: 'nt-rowbody' }, kids));
  modal.body.append(
    what,
    h('div', { class: 'nt-rows' },
      row('WHO', 'nt-row-who', toolGroup.el,
        anyTool ? null : h('p', { class: 'field-error', text: 'No agent CLI was found on this machine. Install Claude Code, Codex or Cursor Agent, then reload.' }), toolError),
      row('WHERE', 'nt-row-where', h('div', { class: 'nt-pathline' }, pathInput, browseBtn), h('div', { class: 'nt-under' }, quick, cwdError)),
      row('PERMISSIONS', 'nt-row-rope', perm.el),
      row('NAME', 'nt-row-name', h('div', { class: 'nt-nameline' }, nameInput, h('span', { class: 'nt-rowlabel nt-inline-label', text: 'GROUP' }), groupBtn), groupError),
      h('div', { class: 'nt-adv' }, advBtn, advBody)));
  modal.foot.append(h('div', { class: 'nt-footmsg' }, signin, formError), h('div', { class: 'modal-actions' }, cancel, start));
  modal.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target !== prompt) { e.preventDefault(); submit(); }
  });

  /** Everything that depends on the live state or on another field. Cheap; runs on changes and once a second. */
  function paintLive() {
    const tools = getTools();
    for (const t of TOOL_ORDER) {
      const info = tools[t];
      const off = info && info.available === false;
      const out = !off && info && info.signedIn === false;
      setText(cardSubs[t], off ? 'NOT INSTALLED' : out ? 'SIGNED OUT' : info && info.version ? (/^\d/.test(String(info.version)) ? `v${info.version}` : String(info.version)) : 'READY');
      setClass(toolGroup.buttons.get(t), 'is-signedout', !!out);
      if (!off) setAttr(toolGroup.buttons.get(t), 'title', out ? `${TOOL_INFO[t].label} CLI is signed out: run "${LOGIN_COMMAND[t]}" in a terminal first.` : null);
    }
    const out = !!tool && tools[tool] && tools[tool].available !== false && tools[tool].signedIn === false;
    if (!out) armed = false;
    setHidden(signin, !out || !formError.hidden); // one message at a time in the footer: the newest error wins
    if (out) {
      setText(signText, `${TOOL_INFO[tool].label} CLI IS SIGNED OUT —`);
      if (signHintFor !== tool) { signHintFor = tool; signHintSlot.replaceChildren(loginHint(tool)); }
    }
    setClass(signin, 'is-armed', armed);
    if (!posting) setText(startLabel, armed ? 'START ANYWAY' : 'START');
    setAttr(start, 'aria-label', posting ? 'Starting the task' : armed ? 'Start the task anyway' : 'Start the task');

    // group
    const eff = effectiveGroup();
    setFlag(gFlag, eff ? eff.color : null);
    setText(gName, eff ? eff.name : 'NO GROUP');
    const auto = groupPick === undefined && !!eff;
    setText(gNote, auto ? 'BY FOLDER' : '');
    setHidden(gNote, !auto);
    setAttr(groupBtn, 'title', auto ? `This folder belongs to the group “${eff.name}”, so the task joins it by itself. Click to choose another.` : 'Choose a group for this task (optional)');

    // advanced
    const m = modelInput.value.trim();
    setHidden(advBody, !advOpen);
    setAttr(advBtn, 'aria-expanded', advOpen ? 'true' : 'false');
    setClass(advBtn, 'is-open', advOpen);
    setText(advSummary, advOpen ? '' : m ? `model: ${m}` : 'model: default');
    setClass(advSummary, 'is-set', !!m);
    setAttr(advBtn, 'aria-label', `Advanced options: model (${m || 'default'})`);
  }

  function validate() {
    let firstBad = null;
    if (!tool) { setText(toolError, 'Pick who should do it.'); setHidden(toolError, false); firstBad = firstBad || toolGroup.el.querySelector('button:not([disabled])'); }
    cwd = pathInput.value.trim();
    if (!cwd) { showCwdError('Pick a folder for them to work in.'); firstBad = firstBad || pathInput; }
    else if (!cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(cwd) && !cwd.startsWith('~')) { showCwdError('Use an absolute path, like /Users/you/project.'); firstBad = firstBad || pathInput; }
    if (!prompt.value.trim()) { setText(promptError, 'Tell them what to do.'); setHidden(promptError, false); firstBad = prompt; }
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  async function submit() {
    if (posting) return;
    setHidden(formError, true);
    if (picker) closePicker();
    if (!validate()) return;
    const tools = getTools();
    if (tools[tool] && tools[tool].signedIn === false && !armed) {
      // the flag can be a minute stale, so this is a speed bump, not a wall
      armed = true;
      paintLive();
      start.focus();
      return;
    }
    posting = true;
    start.disabled = true;
    cancel.disabled = true;
    setText(startLabel, 'STARTING…');
    modal.setBusy(true);
    const model = modelInput.value.trim();
    const label = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 60);
    const body = { tool, prompt: prompt.value.trim(), cwd, permission: perm.value };
    if (model) body.model = model;
    if (label) body.label = label;
    if (typeof groupPick === 'string') body.groupId = groupPick;
    else if (groupPick === null && autoGroup()) body.groupId = 'none'; // "no group" has to beat the folder rule
    try {
      const task = await ctx.api.startTask(body);
      store.set(`${K}tool`, tool);
      store.set(`${K}cwd`, cwd);
      store.set(`${K}perm`, perm.value);
      // the model is NOT remembered here: only once the task has really run (see rememberModel)
      modal.setBusy(false);
      modal.close(true);
      ctx.onStarted(task, body);
    } catch (e) {
      posting = false;
      modal.setBusy(false);
      start.disabled = false;
      cancel.disabled = false;
      setText(formError, e && e.message ? e.message : String(e));
      setAttr(formError, 'title', formError.textContent);
      setHidden(formError, false);
      paintLive();
      start.focus();
    }
  }

  // late-arriving meta (first open can beat /api/meta)
  if (!notes && ctx.loadMeta) ctx.loadMeta().then((m) => { if (m && modal.isOpen()) { notes = m.permissionNotes; perm.refresh(); } });

  paintRecent();
  paintLive();
  if (cwd) check(cwd); // a remembered folder that has gone away says so now, not after START
  timer = setInterval(() => { if (modal.isOpen()) paintLive(); else clearInterval(timer); }, 1000);
  prompt.focus();
  if (seed.prompt) prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  // retrying a failure that was (or may have been) about the model: the caret goes to the model
  if (failure && (failure.aboutModel || modelInput.value.trim())) { modelInput.focus(); modelInput.select(); }
  return modal;
}
