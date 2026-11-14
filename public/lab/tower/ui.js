// DOM chrome for the tower: HUD, elevator-panel floor index, tool legend, RPG dialogue box, transcript, new-task form.
// Every data-derived string goes in through textContent.

import { toolOf } from './art.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const STATUS = { working: 'WORKING', waiting: 'NEEDS YOU', idle: 'ON BREAK', done: 'DONE', failed: 'FAILED' };
const MARK = { working: '..', waiting: '!', idle: 'zz', done: 'OK', failed: 'XX' };
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || '~';

export function createUI({ world, getFeed }) {
  let state = null;
  let selId = null;
  let pending = null;
  let needIdx = 0;
  let typed = { key: '', text: '', n: 0, timer: 0 };
  const rows = new Map();

  // ---------------------------------------------------------------- lookups
  const session = (id) => state?.sessions.find((s) => s.id === id) || null;
  function resolve(id) {
    if (!id || !state) return null;
    if (id.startsWith('floor:')) { const f = world.floor(id.slice(6)); return f ? { kind: 'floor', floor: f } : null; }
    const [sid, subId] = id.split('#');
    const s = session(sid);
    if (!s) return null;
    if (subId) { const sub = (s.subagents || []).find((x) => x.id === subId); return sub ? { kind: 'sub', s, sub } : null; }
    return { kind: 'session', s };
  }

  // ---------------------------------------------------------------- selection + dialogue
  function select(id, opts) {
    if (id && !resolve(id)) id = null;
    selId = id;
    world.select(id, opts);
    $('d-send').hidden = true;
    $('d-note').textContent = '';
    renderDialogue(true);
    renderIndex();
    if (state) renderHUD();
  }

  function typeOut(key, text) {
    const box = $('d-msg');
    if (typed.key === key && typed.text === text) return;
    clearInterval(typed.timer);
    typed = { key, text, n: 0, timer: 0 };
    box.textContent = '';
    box.classList.toggle('done', !text);
    if (!text) return;
    typed.timer = setInterval(() => {
      typed.n = Math.min(text.length, typed.n + 2);
      box.textContent = text.slice(0, typed.n);
      box.scrollTop = box.scrollHeight;
      if (typed.n >= text.length) { clearInterval(typed.timer); box.classList.add('done'); }
    }, 22);
  }

  function chip(label, status, onClick, what) {
    const b = el('button', 'chip ' + status);
    b.type = 'button';
    b.append(el('span', 'st', MARK[status] || '·'), el('span', '', label));
    if (what) { b.append(el('span', 'what', what)); b.title = what; }
    b.addEventListener('click', onClick);
    return b;
  }

  function renderDialogue(fresh) {
    const dlg = $('dlg');
    const r = resolve(selId);
    if (!r) {
      if (selId && !fresh) { selId = null; world.select(null); }
      if (!dlg.hidden) { dlg.hidden = true; setDlgPad(0); }
      return;
    }
    const crew = $('d-crew');
    crew.replaceChildren();
    const badge = $('d-badge'), status = $('d-status');
    const portrait = $('portrait');
    $('d-here').hidden = r.kind !== 'floor';
    $('d-tr').hidden = r.kind === 'floor';
    $('d-msgbtn').hidden = r.kind === 'floor';
    $('d-tr').disabled = false;
    $('d-msgbtn').disabled = r.kind === 'sub';
    $('d-title').hidden = false;
    if (r.kind === 'session') {
      const s = r.s, t = toolOf(s.tool), f = world.floorOf(s.id);
      world.portrait(portrait, s.id);
      $('d-name').textContent = s.name || '?';
      badge.className = 'badge ' + s.tool; badge.textContent = t.badge + ' ' + t.label;
      status.className = 'status ' + s.status; status.textContent = STATUS[s.status] || s.status;
      $('d-where').textContent = `${f ? 'FL' + String(f.num).padStart(2, '0') + ' ' : ''}${s.project || base(s.cwd)} · ${s.branch || 'no branch'}`;
      $('d-act').textContent = '> ' + (s.activity?.label || '');
      $('d-title').textContent = s.title || '';
      typeOut(s.id, s.lastMessage || '');
      if (s.mode === 'orchestrator' && (s.subagents || []).length) {
        crew.append(el('span', 'lab', `CREW ${s.subagents.length}`));
        for (const sub of s.subagents) crew.append(chip(sub.name || sub.agentType || sub.id, sub.status, () => select(s.id + '#' + sub.id), s.subagents.length <= 4 ? sub.label : ''));
      }
    } else if (r.kind === 'sub') {
      const { s, sub } = r, t = toolOf(s.tool);
      world.portrait(portrait, selId);
      $('d-name').textContent = sub.name || sub.agentType || 'SUBAGENT';
      badge.className = 'badge ' + s.tool; badge.textContent = t.badge + ' CREW';
      status.className = 'status ' + sub.status; status.textContent = STATUS[sub.status] || sub.status;
      $('d-where').textContent = `${sub.agentType || 'subagent'} · works for ${s.name}`;
      $('d-act').textContent = '> ' + (sub.activity?.label || '');
      $('d-title').textContent = sub.label || '';
      typeOut(selId, '');
      crew.append(el('span', 'lab', 'BOSS'), chip(s.name || '?', s.status, () => select(s.id)));
      const others = (s.subagents || []).filter((x) => x.id !== sub.id);
      if (others.length) crew.append(el('span', 'lab', ' CREW'));
      for (const o of others) crew.append(chip(o.name || o.agentType || o.id, o.status, () => select(s.id + '#' + o.id)));
    } else {
      const f = r.floor;
      const g = portrait.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, 80, 80);
      g.fillStyle = '#f4f4f4'; g.fillRect(6, 6, 68, 68);
      g.fillStyle = '#000'; g.font = '36px "PS2P", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(f.num).padStart(2, '0'), 41, 46);
      g.font = '10px "PS2P", monospace'; g.fillText('FLOOR', 41, 18);
      $('d-name').textContent = f.name;
      badge.className = 'badge floor'; badge.textContent = 'PROJECT';
      status.className = 'status ' + (f.waiting ? 'waiting' : f.working ? 'working' : 'idle');
      status.textContent = `${f.sessions.length} AGENT${f.sessions.length === 1 ? '' : 'S'}`;
      $('d-where').textContent = f.cwd || '';
      const parts = [];
      if (f.waiting) parts.push(`${f.waiting} need${f.waiting === 1 ? 's' : ''} you`);
      if (f.working) parts.push(`${f.working} working`);
      if (f.idle) parts.push(`${f.idle} in the lounge`);
      $('d-act').textContent = '> ' + (parts.join(' · ') || 'empty');
      $('d-title').hidden = true;
      typeOut(selId, '');
      crew.append(el('span', 'lab', 'ON THIS FLOOR'));
      for (const s of f.sessions) crew.append(chip(`${toolOf(s.tool).badge} ${s.name}`, s.status, () => select(s.id)));
    }
    dlg.hidden = false;
    setDlgPad(dlg.offsetHeight + 20);
  }
  function setDlgPad(px) {
    document.body.classList.toggle('dlg-open', px > 0);
    document.body.style.setProperty('--dlg', px + 'px');
    world.setPads({ dlg: px });
  }

  $('d-close').addEventListener('click', () => select(null));
  $('d-msgbtn').addEventListener('click', () => {
    const f = $('d-send');
    f.hidden = !f.hidden;
    if (!f.hidden) $('d-input').focus();
    setDlgPad($('dlg').offsetHeight + 20);
  });
  $('d-send').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('d-input').value.trim();
    const r = resolve(selId);
    if (!text || !r || r.kind !== 'session') return;
    $('d-note').textContent = 'SENDING…';
    const res = await getFeed().message(r.s.id, text);
    $('d-note').textContent = res.ok ? 'SENT OK - ' + (r.s.name || '') + ' HAS YOUR MESSAGE' : 'FAILED: ' + (res.error || 'unknown error');
    if (res.ok) { $('d-input').value = ''; $('d-send').hidden = true; }
  });
  $('d-here').addEventListener('click', () => { const r = resolve(selId); openNewTask(r?.kind === 'floor' ? r.floor.cwd : ''); });

  // ---------------------------------------------------------------- transcript
  async function openTranscript() {
    const r = resolve(selId);
    if (!r || r.kind === 'floor') return;
    const s = r.s;
    $('tr-title').textContent = `TRANSCRIPT · ${s.name || ''}`;
    const list = $('tr-list');
    list.replaceChildren(el('div', 'msg tool', 'Loading…'));
    showModal('transcript');
    const msgs = await getFeed().transcript(s.id, 60);
    list.replaceChildren();
    if (!msgs.length) list.append(el('div', 'msg tool', 'No transcript available.'));
    for (const m of msgs) {
      const row = el('div', 'msg ' + m.role);
      row.append(el('span', 'who', m.role === 'user' ? 'YOU' : m.role === 'assistant' ? (s.name || 'AGENT') : 'TOOL'), el('span', 'txt', m.text || ''));
      list.append(row);
    }
    list.parentElement.scrollTop = list.parentElement.scrollHeight;
  }
  $('d-tr').addEventListener('click', openTranscript);
  $('tr-close').addEventListener('click', closeModal);

  // ---------------------------------------------------------------- modals
  function showModal(which) {
    $('scrim').hidden = false;
    $('transcript').hidden = which !== 'transcript';
    $('newtask').hidden = which !== 'newtask';
  }
  function closeModal() {
    $('scrim').hidden = true;
    $('transcript').hidden = true;
    $('newtask').hidden = true;
  }
  $('scrim').addEventListener('pointerdown', (ev) => { if (ev.target === $('scrim')) closeModal(); });

  // ---------------------------------------------------------------- new task
  // "Which floor?": every project that already has a floor, then recent folders that would open a new one,
  // then a typed path. The value of the checked radio is the folder (or NEW).
  const NEW = '__new';
  let dirSig = '';
  function dirChoices() {
    const out = [], seen = new Set();
    const floors = world.floors();
    const add = (dir) => {
      if (!dir || seen.has(dir)) return;
      seen.add(dir);
      const f = floors.find((x) => x.cwd === dir) || floors.find((x) => x.key === base(dir));
      out.push({ dir, name: f ? f.name : base(dir), floor: f || null });
    };
    for (const d of state?.recentDirs || []) add(d);
    for (const f of floors) if (f.cwd && !out.some((o) => o.floor === f)) add(f.cwd);
    // floors first (lowest number first, like the lift buttons), then the vacant ones in most-recent order
    return [...out.filter((o) => o.floor).sort((a, b) => a.floor.num - b.floor.num), ...out.filter((o) => !o.floor)];
  }
  function fillDirs(prefer) {
    const box = $('nt-floors');
    const list = dirChoices();
    const sig = list.map((o) => `${o.dir}|${o.floor ? o.floor.num + ':' + o.floor.sessions.map((x) => x.tool + x.status).join(',') : ''}`).join('\n');
    const cur = prefer || chosenValue();
    if (sig !== dirSig || !box.firstChild) {
      dirSig = sig;
      box.replaceChildren();
      const option = (value, cls, num, name, path, here) => {
        const lab = el('label', cls);
        const inp = el('input');
        inp.type = 'radio'; inp.name = 'dir'; inp.value = value;
        const inner = el('span', 'in');
        const mid = el('span');
        mid.append(el('div', 'fname', name), el('div', 'fpath', path));
        inner.append(el('span', 'fnum', num), mid, here);
        lab.title = path;
        lab.append(inp, inner);
        box.append(lab);
      };
      for (const o of list) {
        const here = el('span', 'fhere');
        if (o.floor) here.append(...o.floor.sessions.slice(0, 6).map((x) => el('i', `pip ${x.tool} ${x.status}`)));
        // bidi mark keeps the leading slash on the left while the path is clipped from its start
        option(o.dir, o.floor ? 'floor' : 'vacant', o.floor ? String(o.floor.num).padStart(2, '0') : '+', o.name, '‎' + o.dir, here);
      }
    }
    const radios = [...document.querySelectorAll('input[name="dir"]')];
    let pickd = radios.find((r) => r.value === cur);
    if (!pickd && prefer && prefer !== NEW) { pickd = radios.find((r) => r.value === NEW); $('nt-path').value = prefer; }
    (pickd || radios[0]).checked = true;
    syncForm();
  }
  const chosenValue = () => document.querySelector('input[name="dir"]:checked')?.value || '';
  function chosenDir() {
    const v = chosenValue();
    return v === NEW ? $('nt-path').value.trim() : v;
  }
  function syncForm() {
    const isNew = chosenValue() === NEW;
    $('nt-path').hidden = !isNew;
    const dir = chosenDir();
    const f = dir ? world.floors().find((x) => x.cwd === dir) || world.floor(base(dir)) : null;
    const n = f ? f.sessions.length : 0;
    $('nt-floor').textContent = !dir ? (isNew ? '>> TYPE THE FOLDER FOR THE NEW FLOOR' : '')
      : f ? `>> RIDES UP TO FL${String(f.num).padStart(2, '0')} ${f.name.toUpperCase()} · ${n} AGENT${n === 1 ? '' : 'S'} THERE NOW`
        : `>> OPENS A NEW FLOOR: ${base(dir).toUpperCase()}`;
    $('nt-warn').hidden = document.querySelector('input[name="perm"]:checked')?.value !== 'full';
    for (const inp of document.querySelectorAll('input[name="tool"]')) {
      const t = state?.tools?.[inp.value];
      const ok = t?.available !== false;
      inp.disabled = !ok;
      if (!ok && inp.checked) inp.checked = false;
      const signedOut = ok && t?.signedIn === false;
      inp.closest('label').classList.toggle('warn', !ok || signedOut);
      const v = String(t?.version || '').split(/[\s-]/)[0];
      $('tv-' + inp.value).textContent = !ok ? 'not installed' : signedOut ? 'signed out' : v ? (/^\d/.test(v) ? 'v' + v : v) : 'ready';
      inp.closest('label').title = !ok ? 'This CLI was not found on this machine.' : signedOut ? 'This CLI looks signed out; a task started here will probably fail.' : '';
    }
    if (!document.querySelector('input[name="tool"]:checked')) {
      const first = document.querySelector('input[name="tool"]:not(:disabled)');
      if (first) first.checked = true;
    }
  }
  function openNewTask(dir) {
    $('nt-err').textContent = '';
    fillDirs(dir === 'new' ? NEW : dir || '');
    showModal('newtask');
    world.panToLobby();
    setTimeout(() => (chosenValue() === NEW && !$('nt-path').value ? $('nt-path') : $('nt-prompt')).focus(), 30);
  }
  $('newtask').addEventListener('change', (ev) => {
    syncForm();
    if (ev.target.name === 'dir' && ev.target.value === NEW) $('nt-path').focus();
  });
  $('nt-path').addEventListener('input', syncForm);
  $('nt-close').addEventListener('click', closeModal);
  $('nt-cancel').addEventListener('click', closeModal);
  $('newtask').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const tool = document.querySelector('input[name="tool"]:checked')?.value;
    const permission = document.querySelector('input[name="perm"]:checked')?.value || 'edit';
    const prompt = $('nt-prompt').value.trim();
    const cwd = chosenDir();
    if (!tool) { $('nt-err').textContent = 'NO TOOL AVAILABLE'; return; }
    if (!cwd) { $('nt-err').textContent = chosenValue() === NEW ? 'TYPE A FOLDER PATH' : 'PICK A FLOOR'; if (chosenValue() === NEW) $('nt-path').focus(); return; }
    if (!prompt) { $('nt-err').textContent = 'WRITE THE TASK FIRST'; $('nt-prompt').focus(); return; }
    $('nt-start').disabled = true;
    $('nt-err').textContent = '';
    const res = await getFeed().launch({ tool, prompt, cwd, permission });
    $('nt-start').disabled = false;
    if (!res.ok) { $('nt-err').textContent = String(res.error || 'FAILED').slice(0, 80); return; }
    pending = { taskId: res.task?.id, sessionId: res.task?.sessionId, at: Date.now() };
    $('nt-prompt').value = '';
    closeModal();
    select(null);
    world.panToLobby();
    checkPending();
  });
  $('new').addEventListener('click', () => openNewTask(''));

  function checkPending() {
    if (!pending || !state) return;
    const task = state.tasks?.find((t) => t.id === pending.taskId);
    const sid = pending.sessionId || task?.sessionId;
    const s = state.sessions.find((x) => (sid && x.id === sid) || (pending.taskId && x.taskId === pending.taskId));
    if (s) { pending = null; select(s.id, { follow: true }); } else if (Date.now() - pending.at > 120000) pending = null;
  }

  // ---------------------------------------------------------------- HUD + index
  const waitingNow = () => (state?.sessions || []).filter((s) => s.status === 'waiting');
  function renderHUD() {
    const ss = state.sessions;
    const need = waitingNow();
    $('s-all').textContent = ss.length;
    $('s-work').textContent = ss.filter((s) => s.status === 'working').length;
    $('s-idle').textContent = ss.filter((s) => s.status === 'idle').length;
    for (const t of ['claude', 'codex', 'cursor']) $('l-' + t).textContent = ss.filter((s) => s.tool === t).length;
    const b = $('need');
    const at = need.findIndex((s) => s.id === selId);
    b.textContent = !need.length ? 'NOBODY NEEDS YOU' : `! ${need.length} NEED${need.length === 1 ? 'S' : ''} YOU${at >= 0 && need.length > 1 ? ` ${at + 1}/${need.length}` : ''} >`;
    b.classList.toggle('none', !need.length);
  }
  /** Walk through everyone who is waiting; the camera follows each one. */
  function nextNeed() {
    const need = waitingNow();
    if (!need.length) return;
    const cur = need.findIndex((s) => s.id === selId);
    needIdx = cur >= 0 ? (cur + 1) % need.length : needIdx % need.length;
    select(need[needIdx].id, { follow: true });
    renderHUD();
  }
  $('need').addEventListener('click', nextNeed);

  function syncPads() {
    const r = $('index').getBoundingClientRect();
    world.setPads({ panel: Math.ceil(innerWidth - r.left) + 8, panelBottom: Math.ceil(r.bottom), hud: $('hud').offsetHeight + 16 });
  }

  function renderIndex() {
    const list = world.floors();
    const ol = $('floors');
    const vis = world.visible();
    const carKey = world.carFloor();
    const keep = new Set();
    let prev = null;
    for (const f of list) {
      keep.add(f.key);
      let row = rows.get(f.key);
      if (!row) {
        const b = el('button', 'frow');
        b.type = 'button';
        const num = el('span', 'num');
        const mid = el('span');
        const nm = el('span', 'nm');
        const pips = el('span', 'pips');
        mid.append(nm, pips);
        const cnt = el('span', 'cnt');
        b.append(num, mid, cnt);
        b.addEventListener('click', () => select('floor:' + f.key));
        const li = el('li');
        li.append(b);
        row = { li, b, num, nm, pips, cnt };
        rows.set(f.key, row);
      }
      const n = f.sessions.length;
      row.num.textContent = String(f.num).padStart(2, '0');
      row.nm.textContent = f.name;
      row.cnt.textContent = f.waiting ? '!' : String(n);
      row.b.title = `${f.name} - ${n} agent${n === 1 ? '' : 's'}${f.waiting ? `, ${f.waiting} waiting for you` : ''}`;
      row.b.classList.toggle('alert', f.waiting > 0);
      row.b.classList.toggle('off', f.working + f.waiting === 0);
      row.b.classList.toggle('sel', selId === 'floor:' + f.key || (!!selId && world.floorOf(selId.split('#')[0])?.key === f.key));
      row.b.classList.toggle('vis', vis.has(f.key));
      row.b.classList.toggle('car', carKey === f.key);
      const sig = f.sessions.map((s) => s.tool + s.status).join('|');
      if (row.sig !== sig) {
        row.sig = sig;
        row.pips.replaceChildren(...f.sessions.map((s) => el('i', `pip ${s.tool} ${s.status}`)));
      }
      if (prev ? prev.nextSibling !== row.li : ol.firstChild !== row.li) ol.insertBefore(row.li, prev ? prev.nextSibling : ol.firstChild);
      prev = row.li;
    }
    for (const [k, row] of rows) if (!keep.has(k)) { row.li.remove(); rows.delete(k); }
    let empty = $('index').querySelector('.empty');
    if (!list.length && !empty) { empty = el('div', 'empty', 'NOBODY IN YET'); $('index').append(empty); }
    if (list.length && empty) empty.remove();
    $('f-count').textContent = String(list.length);
    // floors scrolled out of sight
    const off = world.offscreen();
    const up = $('more-up'), down = $('more-down');
    up.hidden = !off.above; down.hidden = !off.below && !off.lobby;
    up.textContent = `^ ${off.above} MORE FLOOR${off.above === 1 ? '' : 'S'}${off.aboveAlert ? ' !' : ''}`;
    down.textContent = off.below ? `v ${off.below} MORE FLOOR${off.below === 1 ? '' : 'S'}${off.belowAlert ? ' !' : ''}` : 'v LOBBY';
    up.classList.toggle('alert', off.aboveAlert); down.classList.toggle('alert', off.belowAlert);
    // sit inside the status bar beside the HUD when there is room, otherwise just under it
    const hr = $('hud').getBoundingClientRect(), ir = $('index').getBoundingClientRect();
    const beside = hr.right + 14 + up.offsetWidth < ir.left - 14;
    up.style.left = (beside ? hr.right + 12 : 10) + 'px';
    up.style.top = (beside ? hr.top + Math.round((hr.height - up.offsetHeight) / 2) : hr.bottom + 12) + 'px';
    down.style.left = $('zoom').getBoundingClientRect().right + 12 + 'px';
    syncPads();
  }
  $('more-up').addEventListener('click', () => world.scrollBy(-1));
  $('more-down').addEventListener('click', () => world.scrollBy(1));

  // ---------------------------------------------------------------- keys + zoom
  addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!$('scrim').hidden) closeModal(); else if (selId) select(null);
      return;
    }
    if (ev.target.closest('input, textarea, select') || !$('scrim').hidden) return;
    if (ev.key === 'n' || ev.key === 'N') { ev.preventDefault(); openNewTask(''); }
    else if (ev.key === '+' || ev.key === '=') world.zoomBy(1);
    else if (ev.key === '-') world.zoomBy(-1);
    else if (ev.key === '0') world.zoomBy(0);
    else if (ev.key === '!' || ev.key === 'Tab') { ev.preventDefault(); nextNeed(); }
  });
  $('z-in').addEventListener('click', () => world.zoomBy(1));
  $('z-out').addEventListener('click', () => world.zoomBy(-1));
  $('z-lab').addEventListener('click', () => world.zoomBy(0));
  setInterval(() => { if (state) renderIndex(); }, 400);

  return {
    setState(st) {
      state = st;
      renderHUD();
      renderIndex();
      checkPending();
      renderDialogue(false);
      if (!$('newtask').hidden) fillDirs('');
    },
    setMode(m) {
      const n = $('mode');
      n.textContent = m === 'live' ? 'LIVE' : m === 'mock' ? 'DEMO DATA' : m.toUpperCase();
      n.className = m === 'live' ? 'live' : '';
    },
    setLayout({ scale, dpr, zoom }) {
      $('z-lab').textContent = zoom ? `${Math.round((scale / dpr) * 100) / 100}X` : 'FIT';
      syncPads();
    },
    select,
    openNewTask,
    refreshIndex: () => { if (state) renderIndex(); },
  };
}
