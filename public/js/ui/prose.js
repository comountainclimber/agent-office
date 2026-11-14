// Agent prose, made readable: paragraphs, bullet lines, headings, fenced code, **bold** and `code`.
// Deliberately small (not a Markdown engine) and safe: every piece of text goes in through textContent.
// renderProse() updates in place, block by block, so a message that only grew keeps the nodes (and the
// scroll position, and any selection) of everything that did not change.
import { h } from './dom.js';

const INLINE = /(\*\*[^*\n]+?\*\*|`[^`\n]+?`)/g;
const LIST = /^(\s*)([-*•]|\d{1,3}[.)])\s+(.*)$/;

/** The text as it reads once the inline markers are gone (what the typewriter types). */
export function plainInline(text) {
  return String(text || '').replace(INLINE, (tok) => (tok[0] === '`' ? tok.slice(1, -1) : tok.slice(2, -2)));
}

function fillInline(el, text) {
  el.replaceChildren();
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const tok = m[0];
    el.append(tok[0] === '`' ? h('code', { class: 'prose-code', text: tok.slice(1, -1) }) : h('strong', { class: 'prose-strong', text: tok.slice(2, -2) }));
    last = m.index + tok.length;
  }
  if (last < text.length) el.append(text.slice(last));
}

/** -> [{ type: 'p'|'h'|'li'|'code'|'hr', text, mark?, depth? }] */
export function parseBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = null;
  let code = null;
  let li = null;
  const flush = () => {
    if (para) blocks.push({ type: 'p', text: para.join('\n') });
    para = null;
    li = null;
  };
  for (const raw of lines) {
    if (code) {
      if (/^\s*```/.test(raw)) { blocks.push({ type: 'code', text: code.join('\n') }); code = null; } else code.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) { flush(); code = []; continue; }
    if (!raw.trim()) { flush(); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) { flush(); blocks.push({ type: 'hr', text: '' }); continue; }
    let m = /^#{1,6}\s+(.*)$/.exec(raw);
    if (m) { flush(); blocks.push({ type: 'h', text: m[1] }); continue; }
    m = LIST.exec(raw);
    if (m) {
      flush();
      li = { type: 'li', mark: /\d/.test(m[2]) ? m[2] : '•', depth: Math.min(3, Math.floor(m[1].length / 2)), text: m[3] };
      blocks.push(li);
      continue;
    }
    if (li && /^\s{2,}\S/.test(raw)) { li.text += '\n' + raw.trim(); continue; }
    li = null;
    (para || (para = [])).push(raw);
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n') }); // a fence the message was cut inside
  flush();
  return blocks;
}

function make(b) {
  let el;
  if (b.type === 'code') el = h('pre', { class: 'prose-pre' });
  else if (b.type === 'hr') el = h('hr', { class: 'prose-hr' });
  else if (b.type === 'li') {
    const mark = h('span', { class: 'prose-mark', attrs: { 'aria-hidden': 'true' } });
    const body = h('span', { class: 'prose-body' });
    el = h('div', { class: 'prose-li' }, mark, body);
    el.__mark = mark;
    el.__body = body;
  } else el = h('p', { class: b.type === 'h' ? 'prose-h' : 'prose-p' });
  el.__type = b.type;
  return el;
}

function paint(el, b) {
  if (b.type === 'code') el.textContent = b.text;
  else if (b.type === 'li') {
    el.dataset.depth = String(b.depth || 0);
    el.__mark.textContent = b.mark;
    fillInline(el.__body, b.text);
  } else if (b.type !== 'hr') fillInline(el, b.text);
}

/** Render `text` into `host`, reusing the blocks that are already there. Returns the parsed blocks. */
export function renderProse(host, text) {
  const blocks = parseBlocks(text);
  let i = 0;
  for (const b of blocks) {
    const sig = `${b.mark || ''}|${b.depth || 0}|${b.text}`;
    let el = host.children[i];
    if (!el || el.__type !== b.type) {
      const fresh = make(b);
      if (el) host.replaceChild(fresh, el); else host.appendChild(fresh);
      el = fresh;
    }
    if (el.__sig !== sig) { paint(el, b); el.__sig = sig; }
    i += 1;
  }
  while (host.children.length > blocks.length) host.lastChild.remove();
  return blocks;
}

/** One short paragraph (about two lines): the only kind of message the typewriter is allowed to play with. */
export function isShortProse(text, max = 170) {
  const t = String(text || '').trim();
  return !!t && t.length <= max && !t.includes('\n');
}
