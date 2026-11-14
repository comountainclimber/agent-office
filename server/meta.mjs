// Names and groups: the metadata the user owns (see "Naming and grouping" in contract.mjs).
//
//   const meta = createMetaStore({ file });          persisted to ~/.agent-office/meta.json
//   const meta = createMockMeta(createMock());       same interface over the mock generator, nothing on disk
//
//   meta.groups()                     -> Group[] sorted by `order`
//   meta.getSessionMeta(id)           -> { label?, groupId? }      what the user set explicitly
//   meta.resolveGroup(id, cwd)        -> group id | undefined      explicit choice, else the first autoDirs match
//   meta.setSessionMeta(id, patch)    -> { id, label?, groupId? }
//   meta.checkSessionPatch(patch)     -> the patch, validated and normalised (throws MetaError)
//   meta.createGroup(input) / updateGroup(id, patch) -> Group      meta.deleteGroup(id) -> true
//   meta.touch(ids, now)              sessions seen on the floor (keeps their entries from being pruned)
//   meta.subscribe(fn)                -> unsubscribe; fn() after every change the UI can see
//   meta.flush() / meta.close()       write pending changes now
//
// Every mutator throws MetaError (status 400 / 404 / 409) with a message fit to show the user.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, oneLine } from './contract.mjs';

export const GROUP_COLORS = /** @type {const} */ (['gold', 'rose', 'lime', 'sky', 'plum', 'sand']);
export const NO_GROUP = 'none'; // groupId that pins a session to "no group", autoDirs or not
export const MAX_LABEL_CHARS = 60;
export const MAX_GROUP_NAME_CHARS = 24;
export const MAX_GROUPS = 24;
export const MAX_AUTO_DIRS = 20;
export const MAX_DIR_CHARS = 1024;
export const MAX_SESSION_ENTRIES = 5000;
export const SEEN_TOUCH_MS = 60 * 60_000; // a session's seenAt is rewritten at most this often
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // entries not seen on the floor for this long are dropped
export const SAVE_DEBOUNCE_MS = 300;
export const SAVE_RETRY_MS = 5000;
export const DEFAULT_META_FILE = path.join(os.homedir(), '.agent-office', 'meta.json');

const NATIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,199}$/;
const GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,63}$/;

export class MetaError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.name = 'MetaError';
    this.status = status;
  }
}

// --- pure validation --------------------------------------------------------

/** One line, no control characters, at most n chars (clipped, never rejected for length). */
export function cleanText(v, n) {
  let t = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > n) {
    t = t.slice(0, n);
    if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1); // do not leave half of a surrogate pair
    t = t.trimEnd();
  }
  return t;
}

/**
 * `${tool}:${nativeId}` -> its parts. The session need not be on the floor.
 * @returns {{tool: string, nativeId: string, id: string}}
 */
export function parseSessionId(id) {
  const s = typeof id === 'string' ? id : '';
  const cut = s.indexOf(':');
  const tool = cut > 0 ? s.slice(0, cut) : '';
  if (!TOOLS.includes(/** @type {any} */ (tool))) throw new MetaError('unknown session', 404);
  const nativeId = s.slice(cut + 1);
  if (!NATIVE_ID_RE.test(nativeId)) throw new MetaError('invalid session id', 400);
  return { tool, nativeId, id: s };
}

/** undefined = not given, null = clear, otherwise the cleaned label. */
export function normalizeLabel(label) {
  if (label === undefined) return undefined;
  if (label === null) return null;
  if (typeof label !== 'string') throw new MetaError('label must be a string or null');
  return cleanText(label, MAX_LABEL_CHARS) || null;
}

/**
 * undefined = not given, null = no explicit choice, 'none' = pinned to no group, otherwise an existing group id.
 * @param {any} groupId
 * @param {{id: string}[]|null} groups  null = existence is not checked
 */
export function normalizeGroupRef(groupId, groups) {
  if (groupId === undefined) return undefined;
  if (groupId === null || groupId === '') return null;
  if (typeof groupId !== 'string') throw new MetaError('groupId must be a string or null');
  if (groupId === NO_GROUP) return NO_GROUP;
  if (groups ? !groups.some((g) => g.id === groupId) : !GROUP_ID_RE.test(groupId)) throw new MetaError(`no such group: ${oneLine(groupId, 64)}`);
  return groupId;
}

/** @returns {{label?: string|null, groupId?: string|null}} only the keys that were given */
export function normalizeSessionPatch(input, groups) {
  const o = input && typeof input === 'object' ? input : {};
  const label = normalizeLabel(o.label);
  const groupId = normalizeGroupRef(o.groupId, groups);
  return { ...(label !== undefined ? { label } : {}), ...(groupId !== undefined ? { groupId } : {}) };
}

/** Absolute, normalised (no trailing slash, no `..`), de-duplicated folders. */
export function normalizeAutoDirs(list) {
  if (!Array.isArray(list)) throw new MetaError('autoDirs must be an array of absolute folder paths');
  const out = [];
  for (const d of list) {
    if (typeof d !== 'string' || !d.trim() || d.includes('\0') || d.length > MAX_DIR_CHARS || !path.isAbsolute(d.trim())) {
      throw new MetaError(`autoDirs must be absolute folder paths (got ${oneLine(JSON.stringify(d) ?? String(d), 80)})`);
    }
    const dir = path.resolve(d.trim());
    if (!out.includes(dir)) out.push(dir);
  }
  if (out.length > MAX_AUTO_DIRS) throw new MetaError(`a group can have at most ${MAX_AUTO_DIRS} folders`);
  return out;
}

const nameKey = (name) => String(name).normalize('NFKC').toLowerCase();

/**
 * Validate the body of a group create (existing = null) or update.
 * @param {any} input
 * @param {{id: string, name: string}[]} groups
 * @param {{id: string}|null} [existing]
 * @returns {{name?: string, color?: string, autoDirs?: string[], order?: number}} only the keys that were given
 */
export function normalizeGroupInput(input, groups, existing = null) {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  /** @type {any} */
  const out = {};
  if (o.name !== undefined || !existing) {
    if (typeof o.name !== 'string') throw new MetaError(existing ? 'name must be a string' : 'name is required');
    const name = cleanText(o.name, MAX_GROUP_NAME_CHARS);
    if (!name) throw new MetaError(`name must be 1 to ${MAX_GROUP_NAME_CHARS} characters`);
    if (groups.some((g) => g.id !== existing?.id && nameKey(g.name) === nameKey(name))) throw new MetaError(`there is already a group called "${name}"`, 409);
    out.name = name;
  }
  if (o.color !== undefined && o.color !== null) {
    if (!GROUP_COLORS.includes(o.color)) throw new MetaError(`color must be one of: ${GROUP_COLORS.join(', ')}`);
    out.color = o.color;
  }
  if (o.autoDirs !== undefined && o.autoDirs !== null) out.autoDirs = normalizeAutoDirs(o.autoDirs);
  if (existing && o.order !== undefined && o.order !== null) {
    if (typeof o.order !== 'number' || !Number.isFinite(o.order)) throw new MetaError('order must be a number');
    out.order = o.order;
  }
  return out;
}

/** The colour the fewest groups use (first in GROUP_COLORS on a tie). */
export function leastUsedColor(groups) {
  const used = (c) => groups.filter((g) => g.color === c).length;
  return [...GROUP_COLORS].sort((a, b) => used(a) - used(b))[0];
}

export function sortGroups(groups) {
  return [...groups].sort((a, b) => a.order - b.order);
}

/** Is `cwd` the folder `dir` or somewhere under it? Whole path segments only: /a/b does not hold /a/bc. */
export function dirMatches(dir, cwd) {
  if (typeof cwd !== 'string' || !cwd || typeof dir !== 'string' || !dir) return false;
  return cwd === dir || cwd.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/**
 * @param {string|undefined} explicit  the session's stored groupId
 * @param {{id: string, autoDirs: string[]}[]} sortedGroups
 * @param {string} cwd
 * @returns {string|undefined}
 */
export function resolveGroup(explicit, sortedGroups, cwd) {
  if (explicit === NO_GROUP) return undefined;
  if (explicit && sortedGroups.some((g) => g.id === explicit)) return explicit;
  return sortedGroups.find((g) => g.autoDirs.some((d) => dirMatches(d, cwd)))?.id;
}

const copyGroup = (g) => ({ id: g.id, name: g.name, color: g.color, autoDirs: [...g.autoDirs], order: g.order });
const publicMeta = (id, m) => ({ id, ...(m?.label ? { label: m.label } : {}), ...(m?.groupId ? { groupId: m.groupId } : {}) });

// --- the file store ---------------------------------------------------------

/**
 * @param {object} [o]
 * @param {string} [o.file]          where it is kept (default ~/.agent-office/meta.json)
 * @param {() => void} [o.onChange]  same as subscribe()
 * @param {() => number} [o.now]
 * @param {number} [o.debounceMs]    changes within this window become one write
 * @param {(line: string) => void} [o.log]
 */
export function createMetaStore({ file = DEFAULT_META_FILE, onChange, now = Date.now, debounceMs = SAVE_DEBOUNCE_MS, log = () => {} } = {}) {
  /** @type {{id: string, name: string, color: string, autoDirs: string[], order: number}[]} */
  let groups = [];
  /** @type {Map<string, {label?: string, groupId?: string, seenAt: number}>} */
  const sessions = new Map();
  const listeners = new Set(onChange ? [onChange] : []);
  let saveTimer = null;
  let dirty = false;
  let lastPruneAt = 0;
  let lastWriteError = '';

  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* a listener must not break a change that has already happened */
      }
    }
  }

  // ---- disk ----

  function setAside(why) {
    try {
      fs.renameSync(file, `${file}.bak`);
      log(`meta: ${file} ${why}; kept it as ${path.basename(file)}.bak and started empty`);
    } catch (err) {
      log(`meta: ${file} ${why} and could not be set aside (${err?.code || err?.message || err}); starting empty`);
    }
  }

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') setAside(`cannot be read (${err?.code || err?.message || err})`);
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return setAside('is not valid JSON');
    if (data.version !== undefined && data.version !== 1) return setAside(`has an unknown version (${oneLine(String(data.version), 20)})`);

    let dropped = 0;
    const rows = Array.isArray(data.groups) ? data.groups : [];
    if (data.groups !== undefined && !Array.isArray(data.groups)) dropped += 1;
    for (const row of rows) {
      try {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !GROUP_ID_RE.test(row.id) || row.id === NO_GROUP) throw new Error('bad id');
        if (groups.length >= MAX_GROUPS || groups.some((g) => g.id === row.id)) throw new Error('extra');
        const { name } = normalizeGroupInput({ name: row.name }, groups);
        // A group with a usable id and name is kept even if the rest of it needs repair.
        const color = GROUP_COLORS.includes(row.color) ? row.color : leastUsedColor(groups);
        const autoDirs = [];
        for (const d of Array.isArray(row.autoDirs) ? row.autoDirs : [null]) {
          try {
            const [dir] = normalizeAutoDirs([d]);
            if (!autoDirs.includes(dir) && autoDirs.length < MAX_AUTO_DIRS) autoDirs.push(dir);
          } catch {
            if (row.autoDirs !== undefined) dropped += 1;
          }
        }
        if (color !== row.color) dropped += 1;
        const order = typeof row.order === 'number' && Number.isFinite(row.order) ? row.order : groups.reduce((n, g) => Math.max(n, g.order), 0) + 1;
        groups.push({ id: row.id, name, color, autoDirs, order });
      } catch {
        dropped += 1;
      }
    }
    const entries = data.sessions && typeof data.sessions === 'object' && !Array.isArray(data.sessions) ? Object.entries(data.sessions) : [];
    if (data.sessions !== undefined && !entries.length && (typeof data.sessions !== 'object' || Array.isArray(data.sessions))) dropped += 1;
    const t = now();
    for (const [id, m] of entries) {
      try {
        parseSessionId(id);
        if (!m || typeof m !== 'object') throw new Error('bad entry');
        const label = typeof m.label === 'string' ? cleanText(m.label, MAX_LABEL_CHARS) : '';
        const groupId = typeof m.groupId === 'string' && (m.groupId === NO_GROUP || groups.some((g) => g.id === m.groupId)) ? m.groupId : '';
        if (!label && !groupId) throw new Error('empty');
        sessions.set(id, { ...(label ? { label } : {}), ...(groupId ? { groupId } : {}), seenAt: typeof m.seenAt === 'number' && Number.isFinite(m.seenAt) ? m.seenAt : t });
      } catch {
        dropped += 1;
      }
    }
    if (dropped) {
      // Something in the file was not usable. The next save would lose it, so keep the original.
      try {
        fs.copyFileSync(file, `${file}.bak`);
        log(`meta: ${dropped} unusable entr${dropped === 1 ? 'y' : 'ies'} in ${file} skipped; the original is kept as ${path.basename(file)}.bak`);
      } catch {
        log(`meta: ${dropped} unusable entr${dropped === 1 ? 'y' : 'ies'} in ${file} skipped`);
      }
    }
    if (prune(t)) schedule();
  }

  function serialise() {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [id, m] of sessions) out[id] = { ...(m.label ? { label: m.label } : {}), ...(m.groupId ? { groupId: m.groupId } : {}), seenAt: m.seenAt };
    return { version: 1, groups: groups.map(copyGroup), sessions: out };
  }

  /** Write now if there is anything to write. Temp file + rename, so a reader never sees half a file. */
  function flush() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty) return true;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    let fd;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const body = `${JSON.stringify(serialise(), null, 2)}\n`;
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, file);
      dirty = false;
      if (lastWriteError) log(`meta: saved to ${file} again`);
      lastWriteError = '';
      return true;
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* nothing more to do */
        }
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* it was never created */
      }
      const msg = String(err?.code || err?.message || err);
      if (msg !== lastWriteError) log(`meta: could not save ${file} (${msg}); names and groups are kept in memory and the save is retried`);
      lastWriteError = msg;
      return false;
    }
  }

  function schedule(delay = debounceMs) {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!flush()) schedule(SAVE_RETRY_MS);
    }, delay);
    saveTimer.unref?.();
  }

  function changed() {
    schedule();
    emit();
  }

  // ---- sessions ----

  function prune(t = now()) {
    lastPruneAt = t;
    let any = false;
    for (const [id, m] of sessions) {
      if (t - m.seenAt > SESSION_TTL_MS) {
        sessions.delete(id);
        any = true;
      }
    }
    return any;
  }

  /** Note that these sessions are on the floor now. Not a visible change, so nobody is told. */
  function touch(ids, t = now()) {
    let any = false;
    for (const id of ids || []) {
      const m = sessions.get(id);
      if (m && t - m.seenAt >= SEEN_TOUCH_MS) {
        m.seenAt = t;
        any = true;
      }
    }
    if (t - lastPruneAt >= SEEN_TOUCH_MS && prune(t)) any = true;
    if (any) schedule();
  }

  function getSessionMeta(id) {
    const m = sessions.get(id);
    return { ...(m?.label ? { label: m.label } : {}), ...(m?.groupId ? { groupId: m.groupId } : {}) };
  }

  function checkSessionPatch(input) {
    return normalizeSessionPatch(input, groups);
  }

  function setSessionMeta(id, input) {
    const ref = parseSessionId(id);
    const patch = checkSessionPatch(input);
    const prev = sessions.get(ref.id);
    const next = { label: prev?.label, groupId: prev?.groupId };
    if (patch.label !== undefined) next.label = patch.label || undefined;
    if (patch.groupId !== undefined) next.groupId = patch.groupId || undefined;
    if (next.label === prev?.label && next.groupId === prev?.groupId) return publicMeta(ref.id, prev);
    if (!next.label && !next.groupId) sessions.delete(ref.id);
    else {
      if (!prev && sessions.size >= MAX_SESSION_ENTRIES) {
        // Full: the entry seen longest ago makes room.
        let oldest = null;
        for (const [sid, m] of sessions) if (!oldest || m.seenAt < oldest[1]) oldest = [sid, m.seenAt];
        if (oldest) sessions.delete(oldest[0]);
      }
      sessions.set(ref.id, { ...(next.label ? { label: next.label } : {}), ...(next.groupId ? { groupId: next.groupId } : {}), seenAt: now() });
    }
    changed();
    return publicMeta(ref.id, sessions.get(ref.id));
  }

  // ---- groups ----

  function findGroup(id) {
    const g = groups.find((x) => x.id === id);
    if (!g) throw new MetaError('unknown group', 404);
    return g;
  }

  function createGroup(input) {
    const clean = normalizeGroupInput(input, groups);
    if (groups.length >= MAX_GROUPS) throw new MetaError(`there can be at most ${MAX_GROUPS} groups; delete one first`);
    let id;
    do id = `g-${crypto.randomBytes(4).toString('hex')}`;
    while (groups.some((g) => g.id === id));
    const group = {
      id,
      name: clean.name,
      color: clean.color || leastUsedColor(groups),
      autoDirs: clean.autoDirs || [],
      order: groups.reduce((n, g) => Math.max(n, g.order), 0) + 1,
    };
    groups = [...groups, group];
    changed();
    return copyGroup(group);
  }

  function updateGroup(id, input) {
    const g = findGroup(id);
    const clean = normalizeGroupInput(input, groups, g);
    const next = { ...g, ...clean };
    if (JSON.stringify(copyGroup(next)) === JSON.stringify(copyGroup(g))) return copyGroup(g);
    groups = groups.map((x) => (x.id === id ? next : x));
    changed();
    return copyGroup(next);
  }

  function deleteGroup(id) {
    findGroup(id);
    groups = groups.filter((g) => g.id !== id);
    for (const [sid, m] of sessions) {
      if (m.groupId !== id) continue;
      if (m.label) sessions.set(sid, { label: m.label, seenAt: m.seenAt });
      else sessions.delete(sid);
    }
    changed();
    return true;
  }

  load();

  return {
    mock: false,
    file,
    groups: () => sortGroups(groups).map(copyGroup),
    getSessionMeta,
    resolveGroup: (id, cwd) => resolveGroup(sessions.get(id)?.groupId, sortGroups(groups), cwd),
    checkSessionPatch,
    setSessionMeta,
    createGroup,
    updateGroup,
    deleteGroup,
    touch,
    prune,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    flush,
    /** Write what is pending and stop the timer. The store stays usable. */
    close() {
      flush();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
    },
    /** For tests: how many session entries are held. */
    get size() {
      return sessions.size;
    },
  };
}

// --- the same interface over the mock generator -----------------------------

/**
 * Names and groups for `--mock`: kept by the mock generator itself (public/js/mock-state.js), so nothing
 * touches the disk. Input is validated exactly as for the file store.
 * @param {any} mock a createMock() instance
 */
export function createMockMeta(mock, { onChange } = {}) {
  const listeners = new Set(onChange ? [onChange] : []);
  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* see the file store */
      }
    }
  };
  const groups = () => sortGroups(mock.next().groups || []).map(copyGroup);
  const explicit = (id) => mock.setMeta(id, {}); // an empty patch changes nothing and returns what is stored
  const checkSessionPatch = (input) => normalizeSessionPatch(input, groups());

  return {
    mock: true,
    groups,
    getSessionMeta: (id) => {
      const { id: _id, ...m } = explicit(id);
      return m;
    },
    resolveGroup: (id, cwd) => resolveGroup(explicit(id).groupId, groups(), cwd),
    checkSessionPatch,
    setSessionMeta(id, input) {
      const ref = parseSessionId(id);
      const patch = checkSessionPatch(input);
      if (!Object.keys(patch).length) return publicMeta(ref.id, explicit(ref.id));
      const out = mock.setMeta(ref.id, patch);
      emit();
      return publicMeta(ref.id, out);
    },
    createGroup(input) {
      const all = groups();
      const clean = normalizeGroupInput(input, all);
      if (all.length >= MAX_GROUPS) throw new MetaError(`there can be at most ${MAX_GROUPS} groups; delete one first`);
      const group = mock.createGroup(clean);
      emit();
      return copyGroup(group);
    },
    updateGroup(id, input) {
      const all = groups();
      const g = all.find((x) => x.id === id);
      if (!g) throw new MetaError('unknown group', 404);
      const group = mock.updateGroup(id, normalizeGroupInput(input, all, g));
      if (!group) throw new MetaError('unknown group', 404);
      emit();
      return copyGroup(group);
    },
    deleteGroup(id) {
      if (!mock.deleteGroup(id)) throw new MetaError('unknown group', 404);
      emit();
      return true;
    },
    touch() {},
    prune: () => false,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    flush: () => true,
    close() {},
  };
}
