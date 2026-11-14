// Modal layer: one stack, focus trap, focus restore, backdrop click and Esc handled by the app.
import { h } from './dom.js';

const stack = [];
let host = null;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

export function initModals(hostEl) {
  host = hostEl;
}

export function modalOpen() {
  return stack.length > 0;
}

/** Close the top-most modal (unless it is busy). Returns true when there was one. */
export function closeTopModal() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

/**
 * openModal({ title, className, onClose }) -> { el, body, foot, close(), setBusy(bool), isOpen() }
 * The caller fills `body` / `foot` and then calls `focusFirst()` or focuses something itself.
 */
export function openModal({ title, className = '', onClose, labelBadge } = {}) {
  const restore = document.activeElement;
  let busy = false;
  let open = true;

  const titleId = `modal-title-${Date.now().toString(36)}-${stack.length}`;
  const titleEl = h('h2', { class: 'modal-title', id: titleId, text: title || '' });
  const closeBtn = h('button', { class: 'btn btn-x', type: 'button', title: 'Close (Esc)', attrs: { 'aria-label': 'Close' }, on: { click: () => api.close() } },
    h('span', { class: 'ico ico-x', attrs: { 'aria-hidden': 'true' } }));
  const head = h('header', { class: 'modal-head' }, labelBadge || null, titleEl, closeBtn);
  const body = h('div', { class: 'modal-body' });
  const foot = h('footer', { class: 'modal-foot' });
  const dialog = h('div', { class: `modal panel ${className}`, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } }, head, body, foot);
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) api.close();
  });

  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(visible);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !dialog.contains(active))) { e.preventDefault(); first.focus(); }
    }
    // Arrow keys belong to the world everywhere else; inside a modal they stay here.
    if (e.key.startsWith('Arrow') || e.key === ' ') e.stopPropagation();
  });

  // Keep focus inside while open (e.g. a click on the page chrome behind).
  const onFocusIn = (e) => {
    if (!open || stack[stack.length - 1] !== api) return;
    if (!dialog.contains(e.target)) {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(visible);
      (items[0] || dialog).focus();
    }
  };
  document.addEventListener('focusin', onFocusIn);

  const api = {
    el: dialog,
    body,
    foot,
    titleEl,
    isOpen: () => open,
    setBusy(b) {
      busy = !!b;
      dialog.classList.toggle('is-busy', busy);
      closeBtn.disabled = busy;
    },
    focusFirst() {
      const items = [...body.querySelectorAll(FOCUSABLE)].filter(visible);
      (items[0] || closeBtn).focus();
    },
    close(force = false) {
      if (!open || (busy && !force)) return;
      open = false;
      document.removeEventListener('focusin', onFocusIn);
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      backdrop.remove();
      if (onClose) onClose();
      if (restore && document.contains(restore) && typeof restore.focus === 'function') {
        try { restore.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    },
  };

  stack.push(api);
  (host || document.body).appendChild(backdrop);
  return api;
}

/**
 * openPopover({ anchor, className, label, onClose }) -> { el, close(), isOpen(), place() }
 * A small panel hung next to `anchor` (a menu, a picker). It joins the modal stack, so Esc closes it
 * first, the global shortcuts stay quiet while it is up, focus is kept inside and handed back after.
 * Fill `el`, then call place() (again whenever the content changes height).
 */
export function openPopover({ anchor, className = '', label = '', onClose, align = 'start' } = {}) {
  // opened from the keyboard with nothing focused: hand focus to the button the menu hangs from
  const restore = document.activeElement && document.activeElement !== document.body ? document.activeElement : anchor;
  let open = true;
  const el = h('div', { class: `pop panel ${className}`, attrs: { role: 'dialog', 'aria-label': label || null } });
  const layer = h('div', { class: 'pop-layer' }, el);

  layer.addEventListener('mousedown', (e) => { if (e.target === layer) { e.preventDefault(); api.close(); } });
  layer.addEventListener('contextmenu', (e) => { if (e.target === layer) { e.preventDefault(); api.close(); } });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const items = [...el.querySelectorAll(FOCUSABLE)].filter(visible);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !el.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
    }
    if (e.key.startsWith('Arrow') || e.key === ' ') e.stopPropagation();
  });
  const onFocusIn = (e) => {
    if (!open || stack[stack.length - 1] !== api) return;
    if (!el.contains(e.target)) {
      const items = [...el.querySelectorAll(FOCUSABLE)].filter(visible);
      if (items[0]) items[0].focus();
    }
  };
  const onResize = () => api.close();
  document.addEventListener('focusin', onFocusIn);
  window.addEventListener('resize', onResize);

  const api = {
    el,
    isOpen: () => open,
    place() {
      if (!open) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const r = anchor && document.contains(anchor) ? anchor.getBoundingClientRect() : { left: vw / 2, right: vw / 2, top: vh / 3, bottom: vh / 3 };
      el.style.maxHeight = `${vh - 16}px`;
      const w = el.offsetWidth;
      const ht = el.offsetHeight;
      let left = align === 'end' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      let top = r.bottom + 6;
      if (top + ht > vh - 8) top = r.top - ht - 6 >= 8 ? r.top - ht - 6 : Math.max(8, vh - ht - 8);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    },
    close() {
      if (!open) return;
      open = false;
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('resize', onResize);
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      layer.remove();
      if (onClose) onClose();
      if (restore && document.contains(restore) && typeof restore.focus === 'function' && !restore.closest('[hidden]')) {
        try { restore.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    },
  };

  stack.push(api);
  (host || document.body).appendChild(layer);
  return api;
}

/** A row of mutually exclusive choice buttons that behaves like a radio group (arrow keys move). */
export function radioGroup({ label, className = '', options, value, onChange }) {
  const group = h('div', { class: `radios ${className}`, attrs: { role: 'radiogroup', 'aria-label': label } });
  const buttons = new Map();
  let current = value;

  function paint() {
    let tabbable = null;
    for (const [val, btn] of buttons) {
      const on = val === current;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.tabIndex = -1;
      if (on && !btn.disabled) tabbable = btn;
    }
    if (!tabbable) tabbable = [...buttons.values()].find((b) => !b.disabled);
    if (tabbable) tabbable.tabIndex = 0;
  }

  function set(val, { focus = false, silent = false } = {}) {
    const btn = buttons.get(val);
    if (!btn || btn.disabled) return;
    current = val;
    paint();
    if (focus) btn.focus();
    if (!silent && onChange) onChange(val);
  }

  for (const opt of options) {
    const btn = h('button', { class: 'radio', type: 'button', attrs: { role: 'radio', 'aria-checked': 'false' }, data: { value: opt.value }, on: { click: () => set(opt.value) } });
    if (opt.render) opt.render(btn); else btn.textContent = opt.label;
    buttons.set(opt.value, btn);
    group.appendChild(btn);
  }

  group.addEventListener('keydown', (e) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const enabled = [...buttons.entries()].filter(([, b]) => !b.disabled);
    if (!enabled.length) return;
    let i = enabled.findIndex(([v]) => v === current);
    i = (i + dir + enabled.length) % enabled.length;
    set(enabled[i][0], { focus: true });
  });

  paint();
  return {
    el: group,
    buttons,
    get value() { return current; },
    set,
    setDisabled(val, disabled) {
      const btn = buttons.get(val);
      if (btn) btn.disabled = !!disabled;
      paint();
    },
    clear() { current = null; paint(); },
  };
}
