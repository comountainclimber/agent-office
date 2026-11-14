// Groups in the shell: the little flag, the pick-a-group menu and the one-panel group editor.
// Group colour is only ever a small flag or stripe — tool colour and the yellow "needs you" keep their jobs.
import { h, setText, setAttr, setHidden, setClass, reconcile, shortPath } from './dom.js';
import { openModal, openPopover, radioGroup } from './modal.js';
import { GROUP_COLOR_KEYS, GROUP_COLOR_NAMES, groupColor } from '../groups.js';

export const GROUP_NAME_MAX = 24;

/** Point an element's --g / --g-dark at a group colour (or the neutral grey for "no group"). */
export function paintFlag(el, colorKey) {
  const c = groupColor(colorKey);
  if (el.__g === c.base) return;
  el.__g = c.base;
  el.style.setProperty('--g', c.base);
  el.style.setProperty('--g-dark', c.dark);
}

/** A tiny swallow-tail flag in the group's colour. Decorative: always pair it with the group's name. */
export function groupFlag(colorKey, cls = '') {
  const el = h('span', { class: `gflag ${cls}`, attrs: { 'aria-hidden': 'true' } });
  if (colorKey) paintFlag(el, colorKey); else el.classList.add('is-none');
  return el;
}

export function setFlag(el, colorKey) {
  setClass(el, 'is-none', !colorKey);
  if (colorKey) paintFlag(el, colorKey);
}

const errText = (e) => (e && e.message ? e.message : String(e));

/** Does one of the group's auto-folders cover this working directory? */
export function dirMatches(group, cwd) {
  if (!group || !cwd) return false;
  return (group.autoDirs || []).some((d) => cwd === d || cwd.startsWith(String(d).replace(/\/$/, '') + '/'));
}

/** The first group (by order) whose auto-folders cover `cwd`. */
export function autoGroupFor(groups, cwd) {
  return [...(groups || [])].sort((a, b) => a.order - b.order).find((g) => dirMatches(g, cwd)) || null;
}

// ------------------------------------------------------------------------------------------------
// pick-a-group menu
// ------------------------------------------------------------------------------------------------

/**
 * openGroupMenu({
 *   anchor, heading, groups, counts?: Map<groupId, n>, align?,
 *   currentId?                                  marks the current choice (null = NO GROUP); leave undefined for none
 *   onPick(groupId | null) -> Promise|void      null = NO GROUP
 *   onCreate(name) -> Promise|void              create a group called `name` and do the same with it
 *   suggestion?: { label, run() -> Promise|void }
 *   onEdit?(group)                              shows a small EDIT button per row
 *   noneLabel?, allowNone?
 * })
 * Keys: 1-9 pick a group, 0 = no group, arrows move, just start typing to name a new group, Enter creates it.
 */
export function openGroupMenu(opts) {
  const { anchor, heading = 'GROUP', groups = [], counts, currentId, onPick, onCreate, suggestion, onEdit, noneLabel = 'NO GROUP', allowNone = true, align, hint, infoLines } = opts;
  const pop = openPopover({ anchor, className: 'pop-groups', label: heading, align });
  let busy = false;

  const error = h('p', { class: 'field-error', hidden: true, attrs: { role: 'alert' } });
  const list = h('ul', { class: 'menu gm-list' });
  const empty = h('p', { class: 'gm-empty', text: 'No groups yet. Name the first one below.', hidden: groups.length > 0 });
  const input = h('input', {
    class: 'input gm-input', type: 'text', maxLength: GROUP_NAME_MAX, placeholder: 'New group: type a name', spellcheck: false, autocomplete: 'off',
    attrs: { 'aria-label': 'Name for a new group' },
    on: { input: () => { setHidden(error, true); paint(); } },
  });
  const createLabel = h('span', { class: 'menu-label' });
  const createBtn = h('button', { class: 'menu-item gm-create', type: 'button', hidden: true, on: { click: () => create() } },
    h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }), createLabel, h('kbd', { class: 'sym', text: '↵' }));

  const items = groups.slice(0, 40).map((g, i) => ({ key: g.id, group: g, n: i + 1 }));
  if (allowNone) items.push({ key: '__none', group: null, n: 0 });

  const makeItem = (it) => {
    const g = it.group;
    const num = h('kbd', { class: 'gm-num', text: g ? (it.n <= 9 ? String(it.n) : '') : '0' });
    if (g && it.n > 9) num.style.visibility = 'hidden';
    const count = counts && g ? counts.get(g.id) || 0 : null;
    const btn = h('button', { class: 'menu-item gm-item', type: 'button', attrs: { 'aria-current': currentId !== undefined && (g ? g.id === currentId : currentId === null) ? 'true' : null }, on: { click: () => pick(g ? g.id : null) } },
      h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }),
      num,
      groupFlag(g ? g.color : null),
      h('span', { class: 'menu-label', text: g ? g.name : noneLabel }),
      count != null ? h('span', { class: 'gm-count num', text: String(count) }) : null);
    const edit = g && onEdit ? h('button', { class: 'btn btn-mini gm-edit', type: 'button', text: 'EDIT', title: `Rename, recolour, auto-folders: ${g.name}`, on: { click: () => { pop.close(); onEdit(g); } } }) : null;
    const li = h('li', { class: 'gm-row' }, btn, edit);
    li.__btn = btn;
    li.__it = it;
    return li;
  };
  const rows = items.map(makeItem);
  list.append(...rows);

  let suggestBtn = null;
  if (suggestion) {
    suggestBtn = h('button', { class: 'menu-item gm-suggest', type: 'button', on: { click: () => run(() => suggestion.run()) } },
      h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'menu-label', text: suggestion.label }));
  }

  pop.el.append(...[
    h('h3', { class: 'pop-title', text: heading }),
    list, empty,
    h('div', { class: 'gm-new' }, input, createBtn),
    suggestBtn ? h('div', { class: 'gm-suggest-wrap' }, suggestBtn) : null,
    error,
    h('p', { class: 'pop-hint', text: hint || (groups.length ? '1-9 pick · 0 none · type to add a new one' : 'Type a name, then press Enter') }),
    infoLines && infoLines.length ? h('div', { class: 'pop-info' }, infoLines.map((t) => h('p', { text: t }))) : null,
  ].filter(Boolean));

  const query = () => input.value.replace(/\s+/g, ' ').trim();
  const exact = () => groups.find((g) => g.name.toLowerCase() === query().toLowerCase()) || null;

  function paint() {
    const q = query().toLowerCase();
    for (const li of rows) {
      const g = li.__it.group;
      setHidden(li, !!q && !(g && g.name.toLowerCase().includes(q)));
    }
    const hit = exact();
    setHidden(createBtn, !q);
    if (q) setText(createLabel, hit ? `USE “${hit.name}”` : `CREATE “${query()}”`);
    pop.place();
  }

  function visibleButtons() {
    const out = rows.filter((li) => !li.hidden).map((li) => li.__btn);
    return out;
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    setHidden(error, true);
    pop.el.classList.add('is-busy');
    try {
      await fn();
      pop.close();
    } catch (e) {
      busy = false;
      pop.el.classList.remove('is-busy');
      setText(error, errText(e));
      setHidden(error, false);
      pop.place();
    }
  }

  function pick(id) {
    if (!onPick) return;
    run(() => onPick(id));
  }

  function create() {
    const name = query();
    if (!name) { input.focus(); return; }
    const hit = exact();
    if (hit) pick(hit.id);
    else if (onCreate) run(() => onCreate(name.slice(0, GROUP_NAME_MAX)));
  }

  pop.el.addEventListener('keydown', (e) => {
    if (busy || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const btns = visibleButtons();
    const inInput = e.target === input;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const ring = [...btns, input, ...(suggestBtn ? [suggestBtn] : [])];
      let i = ring.indexOf(document.activeElement);
      i = i === -1 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + ring.length) % ring.length;
      ring[i].focus();
      return;
    }
    if (inInput) {
      if (e.key === 'Enter') { e.preventDefault(); create(); }
      return;
    }
    if (/^[0-9]$/.test(e.key)) {
      const it = items.find((x) => x.n === Number(e.key) && (e.key === '0' ? !x.group : !!x.group));
      if (it) { e.preventDefault(); pick(it.group ? it.group.id : null); }
      return;
    }
    if (e.key.length === 1 && e.key !== ' ') {
      // just start typing: the letters land in the new-group field
      e.preventDefault();
      input.focus();
      input.value += e.key;
      paint();
    } else if (e.key === 'Backspace') {
      input.focus();
    }
  });

  paint();
  const cur = rows.find((li) => li.__btn.getAttribute('aria-current'));
  if (!groups.length) input.focus();
  else (cur || rows[0]).__btn.focus();
  return pop;
}

// ------------------------------------------------------------------------------------------------
// group editor (one compact panel)
// ------------------------------------------------------------------------------------------------

/**
 * openGroupEditor({ groupId, getState, actions: { update(id, patch), remove(id), reorder(id, dir) } })
 *   -> { refresh(), isOpen(), close() }
 * Every change is saved as it is made; refresh() repaints from the latest state.
 */
export function openGroupEditor({ groupId, getState, actions }) {
  const modal = openModal({ title: 'EDIT GROUP', className: 'modal-group' });
  let busy = false;
  let adding = false;
  let confirming = false;

  const find = () => {
    const s = getState();
    const groups = (s && s.groups) || [];
    return { state: s, groups, group: groups.find((g) => g.id === groupId) || null };
  };

  const error = h('p', { class: 'field-error', hidden: true, attrs: { role: 'alert' } });
  const titleFlag = groupFlag(null, 'gflag-big');
  modal.titleEl.before(titleFlag);

  // name ---------------------------------------------------------------------------------------
  const nameInput = h('input', {
    class: 'input', type: 'text', maxLength: GROUP_NAME_MAX, spellcheck: false, autocomplete: 'off', attrs: { 'aria-label': 'Group name' },
    on: {
      keydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitName(); }
        if (e.key === 'Escape' && nameInput.value !== (find().group?.name || '')) { e.stopPropagation(); nameInput.value = find().group?.name || ''; }
      },
      blur: () => commitName(),
    },
  });
  function commitName() {
    const { group } = find();
    if (!group) return;
    const v = nameInput.value.replace(/\s+/g, ' ').trim();
    if (!v) { nameInput.value = group.name; return; }
    if (v !== group.name) run(() => actions.update(groupId, { name: v }));
  }

  // colour --------------------------------------------------------------------------------------
  const colors = radioGroup({
    label: 'Group colour',
    className: 'swatches',
    value: find().group?.color,
    options: GROUP_COLOR_KEYS.map((key) => ({
      value: key,
      render(btn) {
        btn.classList.add('swatch');
        const colorName = GROUP_COLOR_NAMES[key] || key.toUpperCase();
        btn.title = colorName;
        btn.setAttribute('aria-label', colorName.toLowerCase());
        paintFlag(btn, key);
        btn.append(h('span', { class: 'swatch-chip', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'swatch-name', text: colorName }));
      },
    })),
    onChange: (v) => run(() => actions.update(groupId, { color: v })),
  });

  // order ---------------------------------------------------------------------------------------
  const orderText = h('span', { class: 'ge-order-text num' });
  const orderNote = h('p', { class: 'ge-help ge-order-note', hidden: true });
  const earlier = h('button', { class: 'btn btn-mini', type: 'button', title: 'Show this group earlier', on: { click: () => run(() => actions.reorder(groupId, -1)) } },
    h('span', { class: 'ico ico-left', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'EARLIER' }));
  const later = h('button', { class: 'btn btn-mini', type: 'button', title: 'Show this group later', on: { click: () => run(() => actions.reorder(groupId, 1)) } },
    h('span', { text: 'LATER' }), h('span', { class: 'ico ico-right', attrs: { 'aria-hidden': 'true' } }));

  // auto-folders --------------------------------------------------------------------------------
  const dirList = h('ul', { class: 'ge-dirs' });
  const dirEmpty = h('p', { class: 'ge-empty', text: 'None. Agents join this group only when you put them in it.' });
  const candList = h('ul', { class: 'menu ge-cands' });
  const candEmpty = h('p', { class: 'ge-empty', text: 'No other recent folders. Type a path below.' });
  const pathInput = h('input', {
    class: 'input ge-path', type: 'text', placeholder: '/absolute/path/to/folder', spellcheck: false, autocomplete: 'off', attrs: { 'aria-label': 'Folder path to add' },
    on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } } },
  });
  const pathAdd = h('button', { class: 'btn btn-mini', type: 'button', text: 'ADD', on: { click: () => addTyped() } });
  const addPanel = h('div', { class: 'ge-add', hidden: true }, candList, candEmpty, h('div', { class: 'ge-add-row' }, pathInput, pathAdd));
  const addBtn = h('button', { class: 'btn btn-mini', type: 'button', attrs: { 'aria-expanded': 'false' }, on: { click: () => { adding = !adding; refresh(); if (adding) (candList.querySelector('button') || pathInput).focus(); } } },
    h('span', { text: '+ ADD FOLDER' }));

  function addDir(dir) {
    const { group } = find();
    if (!group) return;
    const d = String(dir || '').trim().replace(/(.)\/+$/, '$1');
    if (!d.startsWith('/')) { setText(error, 'Use an absolute path, like /Users/you/project.'); setHidden(error, false); return; }
    if ((group.autoDirs || []).includes(d)) return;
    adding = false;
    pathInput.value = '';
    run(() => actions.update(groupId, { autoDirs: [...(group.autoDirs || []), d] }));
  }
  function addTyped() { if (pathInput.value.trim()) addDir(pathInput.value); else pathInput.focus(); }
  function removeDir(dir) {
    const { group } = find();
    if (!group) return;
    run(() => actions.update(groupId, { autoDirs: (group.autoDirs || []).filter((x) => x !== dir) }));
  }

  // delete --------------------------------------------------------------------------------------
  const delBtn = h('button', { class: 'btn btn-danger', type: 'button', text: 'DELETE GROUP', on: { click: () => { confirming = true; refresh(); delYes.focus(); } } });
  const delText = h('span', { class: 'ge-confirm-text' });
  const delYes = h('button', { class: 'btn btn-danger', type: 'button', text: 'YES, DELETE', on: { click: () => run(async () => { await actions.remove(groupId); modal.close(true); }) } });
  const delNo = h('button', { class: 'btn', type: 'button', text: 'KEEP IT', on: { click: () => { confirming = false; refresh(); delBtn.focus(); } } });
  const confirmRow = h('div', { class: 'ge-confirm', hidden: true, attrs: { role: 'alertdialog', 'aria-label': 'Delete this group?' } }, delText, delYes, delNo);
  const done = h('button', { class: 'btn btn-primary', type: 'button', text: 'DONE', on: { click: () => modal.close() } });

  const members = h('p', { class: 'ge-members' });
  const row = (label, ...kids) => h('div', { class: 'ge-row' }, h('h3', { class: 'ge-label', text: label }), h('div', { class: 'ge-field' }, kids));
  modal.body.append(
    row('NAME', nameInput),
    row('COLOUR', colors.el),
    row('ORDER', h('div', { class: 'ge-order' }, earlier, orderText, later), orderNote),
    row('AUTO-FOLDERS', h('p', { class: 'ge-help', text: 'Agents working in or under one of these join the group by themselves.' }), dirList, dirEmpty, addBtn, addPanel),
    members, error);
  modal.foot.append(delBtn, confirmRow, h('div', { class: 'modal-actions' }, done));

  async function run(fn) {
    if (busy) return;
    busy = true;
    setHidden(error, true);
    modal.el.classList.add('is-saving');
    try {
      await fn();
    } catch (e) {
      setText(error, errText(e));
      setHidden(error, false);
    } finally {
      busy = false;
      modal.el.classList.remove('is-saving');
      if (modal.isOpen()) refresh();
    }
  }

  function refresh() {
    if (!modal.isOpen()) return;
    const { state, groups, group } = find();
    if (!group) { if (!busy) modal.close(true); return; }
    setText(modal.titleEl, 'EDIT GROUP');
    setFlag(titleFlag, group.color);
    if (document.activeElement !== nameInput && nameInput.value !== group.name) nameInput.value = group.name;
    if (colors.value !== group.color) colors.set(group.color, { silent: true });

    const idx = groups.findIndex((g) => g.id === groupId);
    setText(orderText, `${idx + 1} OF ${groups.length}`);
    earlier.disabled = idx <= 0;
    later.disabled = idx >= groups.length - 1;
    // the count includes groups nobody is in right now: those have no chip in the bar and no pod in the office
    const populated = new Set(((state && state.sessions) || []).map((x) => x.groupId).filter(Boolean));
    const emptyOnes = groups.filter((g) => !populated.has(g.id));
    setHidden(orderNote, emptyOnes.length === 0);
    if (emptyOnes.length) {
      const names = emptyOnes.slice(0, 3).map((g) => g.name).join(', ') + (emptyOnes.length > 3 ? '…' : '');
      setText(orderNote, `Counts all ${groups.length} groups. ${names} ${emptyOnes.length === 1 ? 'has' : 'have'} nobody in ${emptyOnes.length === 1 ? 'it' : 'them'} right now: no chip, no pod, but still in the GROUPS menu.`);
    }

    const dirs = group.autoDirs || [];
    setHidden(dirEmpty, dirs.length > 0);
    reconcile(dirList, dirs, (d) => d, (d) => h('li', { class: 'ge-dir' },
      h('span', { class: 'ico ico-folder', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'ge-dir-path', text: shortPath(d), title: d }),
      h('button', { class: 'btn btn-x btn-x-mini', type: 'button', title: `Stop auto-adding ${d}`, attrs: { 'aria-label': `Remove ${d}` }, on: { click: () => removeDir(d) } },
        h('span', { class: 'ico ico-x', attrs: { 'aria-hidden': 'true' } }))));

    setHidden(addPanel, !adding);
    setAttr(addBtn, 'aria-expanded', adding ? 'true' : 'false');
    if (adding) {
      const sessions = (state && state.sessions) || [];
      const cands = [...new Set([...sessions.map((s) => s.cwd), ...((state && state.recentDirs) || [])])].filter((d) => d && d.startsWith('/') && !dirs.includes(d)).slice(0, 12);
      setHidden(candEmpty, cands.length > 0);
      setHidden(candList, cands.length === 0);
      reconcile(candList, cands, (d) => d, (d) => {
        const parts = d.split('/').filter(Boolean);
        return h('li', null, h('button', { class: 'menu-item nt-recent', type: 'button', title: d, on: { click: () => addDir(d) } },
          h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'nt-recent-name', text: parts[parts.length - 1] || '/' }),
          h('span', { class: 'nt-recent-path', text: shortPath(parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/') })));
      });
    }

    const n = ((state && state.sessions) || []).filter((s) => s.groupId === groupId).length;
    setText(members, n ? `${n} agent${n === 1 ? '' : 's'} in this group right now.` : 'Nobody is in this group right now.');
    setHidden(delBtn, confirming);
    setHidden(confirmRow, !confirming);
    if (confirming) setText(delText, n ? `Delete “${group.name}”? Its ${n} agent${n === 1 ? '' : 's'} stay, ungrouped.` : `Delete “${group.name}”?`);
  }

  refresh();
  nameInput.focus();
  nameInput.select();
  return { refresh, isOpen: () => modal.isOpen(), close: () => modal.close(true) };
}
