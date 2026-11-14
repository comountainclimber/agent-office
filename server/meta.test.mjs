import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanText,
  createMetaStore,
  createMockMeta,
  dirMatches,
  GROUP_COLORS,
  leastUsedColor,
  MAX_AUTO_DIRS,
  MAX_GROUPS,
  MAX_SESSION_ENTRIES,
  MetaError,
  normalizeAutoDirs,
  normalizeGroupInput,
  normalizeGroupRef,
  normalizeLabel,
  normalizeSessionPatch,
  parseSessionId,
  resolveGroup,
  SEEN_TOUCH_MS,
  SESSION_TTL_MS,
} from './meta.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600_000;
const SID = 'claude:11111111-2222-4333-8444-555555555555';

function tmp() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-meta-')));
  // The store's directory does not exist yet: creating it is the store's job.
  return { root, file: path.join(root, 'office', 'meta.json'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const bad = (fn, status, re) => assert.throws(fn, (e) => e instanceof MetaError && e.status === status && (!re || re.test(e.message)), `expected ${status} ${re || ''}`);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// --- validation -------------------------------------------------------------

test('labels and names are clipped to one line; types are checked', () => {
  assert.equal(cleanText('  Cart \n totals\tport  ', 60), 'Cart totals port');
  assert.equal(cleanText('a\u0000b\u001b[31mc', 60), 'a b [31mc');
  assert.equal(cleanText('x'.repeat(80), 60).length, 60);
  assert.equal(cleanText('ab cd', 3), 'ab', 'no trailing space after the cut');
  assert.equal(cleanText('ab😀', 3), 'ab', 'no half emoji after the cut');

  assert.equal(normalizeLabel(undefined), undefined);
  assert.equal(normalizeLabel(null), null);
  assert.equal(normalizeLabel(''), null);
  assert.equal(normalizeLabel('  \n '), null);
  assert.equal(normalizeLabel(' Fix\nthe build '), 'Fix the build');
  assert.equal(normalizeLabel('y'.repeat(200)).length, 60);
  for (const v of [5, true, {}, ['a']]) bad(() => normalizeLabel(v), 400, /label must be a string or null/);
});

test('groupId: null clears, "none" pins, anything else must be an existing group', () => {
  const groups = [{ id: 'g-1' }, { id: 'g-2' }];
  assert.equal(normalizeGroupRef(undefined, groups), undefined);
  assert.equal(normalizeGroupRef(null, groups), null);
  assert.equal(normalizeGroupRef('', groups), null);
  assert.equal(normalizeGroupRef('none', groups), 'none');
  assert.equal(normalizeGroupRef('g-2', groups), 'g-2');
  bad(() => normalizeGroupRef('g-3', groups), 400, /no such group: g-3/);
  bad(() => normalizeGroupRef(7, groups), 400, /groupId must be a string or null/);
  assert.equal(normalizeGroupRef('g-anything', null), 'g-anything', 'without a store only the shape is checked');
  bad(() => normalizeGroupRef('../etc', null), 400);

  assert.deepEqual(normalizeSessionPatch({}, groups), {});
  assert.deepEqual(normalizeSessionPatch(null, groups), {});
  assert.deepEqual(normalizeSessionPatch({ label: ' A ', groupId: null, extra: 1 }, groups), { label: 'A', groupId: null });
  assert.deepEqual(normalizeSessionPatch({ label: '' }, groups), { label: null });
});

test('session ids: a known tool prefix and a sane native id, on the floor or not', () => {
  assert.deepEqual(parseSessionId(SID), { tool: 'claude', nativeId: SID.slice(7), id: SID });
  assert.equal(parseSessionId('codex:019a-b.c_d:e').tool, 'codex');
  assert.equal(parseSessionId('cursor:mock-07').nativeId, 'mock-07');
  for (const id of ['emacs:1', 'nocolon', ':abc', '', null, undefined, 5, 'CLAUDE:abc']) bad(() => parseSessionId(id), 404, /unknown session/);
  for (const id of ['claude:', 'claude:a b', 'claude:a/b', 'claude:../x', 'claude:abc#sub-1', 'claude:-abc', `claude:${'a'.repeat(201)}`, 'claude:a\nb', 'claude:é']) {
    bad(() => parseSessionId(id), 400, /invalid session id/);
  }
});

test('autoDirs: absolute, normalised, de-duplicated, at most 20', () => {
  assert.deepEqual(normalizeAutoDirs(['/a/b/', '/a/b', '/a/./c/../d', ' /x ', '/']), ['/a/b', '/a/d', '/x', '/']);
  assert.deepEqual(normalizeAutoDirs([]), []);
  for (const v of [['relative/dir'], ['~/projects'], [''], ['  '], [5], [null], ['/a\0b'], [`/${'x'.repeat(1100)}`]]) bad(() => normalizeAutoDirs(v), 400, /absolute folder paths/);
  for (const v of ['/a', { 0: '/a' }, 5]) bad(() => normalizeAutoDirs(v), 400, /must be an array/);
  const many = Array.from({ length: MAX_AUTO_DIRS + 1 }, (_, i) => `/d/${i}`);
  bad(() => normalizeAutoDirs(many), 400, /at most 20 folders/);
  assert.equal(normalizeAutoDirs(many.slice(1)).length, MAX_AUTO_DIRS);
  assert.equal(normalizeAutoDirs([...many.slice(1), '/d/1/', '/d/2']).length, MAX_AUTO_DIRS, 'duplicates do not count');
});

test('group input: name 1-24 chars and unique whatever the case, colour from the palette, numeric order', () => {
  const groups = [
    { id: 'g-1', name: 'Checkout' },
    { id: 'g-2', name: 'iOS app' },
  ];
  assert.deepEqual(normalizeGroupInput({ name: '  Clean\nup ' }, groups), { name: 'Clean up' });
  assert.equal(normalizeGroupInput({ name: 'n'.repeat(40) }, groups).name.length, 24);
  assert.deepEqual(normalizeGroupInput({ name: 'A', color: 'plum', autoDirs: ['/a/'], order: 9 }, groups), { name: 'A', color: 'plum', autoDirs: ['/a'] }, 'order is not for create');
  bad(() => normalizeGroupInput({}, groups), 400, /name is required/);
  bad(() => normalizeGroupInput(null, groups), 400, /name is required/);
  bad(() => normalizeGroupInput({ name: '   ' }, groups), 400, /1 to 24 characters/);
  bad(() => normalizeGroupInput({ name: 7 }, groups), 400);
  bad(() => normalizeGroupInput({ name: 'CHECKOUT' }, groups), 409, /already a group called "CHECKOUT"/);
  bad(() => normalizeGroupInput({ name: ' ios  APP ' }, groups), 409);
  bad(() => normalizeGroupInput({ name: 'A', color: 'coral' }, groups), 400, /color must be one of: gold, rose, lime, sky, plum, sand/);
  bad(() => normalizeGroupInput({ name: 'A', autoDirs: ['nope'] }, groups), 400);

  // Update: every field optional; a group may keep (or re-case) its own name.
  const self = groups[0];
  assert.deepEqual(normalizeGroupInput({}, groups, self), {});
  assert.deepEqual(normalizeGroupInput({ name: 'checkout' }, groups, self), { name: 'checkout' });
  assert.deepEqual(normalizeGroupInput({ order: 0.5, color: 'sky' }, groups, self), { color: 'sky', order: 0.5 });
  bad(() => normalizeGroupInput({ name: 'ios app' }, groups, self), 409);
  bad(() => normalizeGroupInput({ name: '' }, groups, self), 400, /1 to 24 characters/);
  for (const order of ['2', NaN, Infinity, {}]) bad(() => normalizeGroupInput({ order }, groups, self), 400, /order must be a number/);
});

test('the default colour is the least used one, palette order on a tie', () => {
  assert.equal(leastUsedColor([]), 'gold');
  assert.equal(leastUsedColor([{ color: 'gold' }]), 'rose');
  assert.equal(leastUsedColor([{ color: 'gold' }, { color: 'sky' }, { color: 'rose' }]), 'lime');
  assert.equal(leastUsedColor(GROUP_COLORS.map((color) => ({ color }))), 'gold');
  assert.equal(leastUsedColor([...GROUP_COLORS, 'gold', 'rose'].map((color) => ({ color }))), 'lime');
});

// --- resolution -------------------------------------------------------------

test('autoDirs match the folder itself and anything under it, on path-segment boundaries', () => {
  assert.ok(dirMatches('/a/b', '/a/b'));
  assert.ok(dirMatches('/a/b', '/a/b/c'));
  assert.ok(dirMatches('/a/b', '/a/b/c/d'));
  assert.ok(dirMatches('/a/b', '/a/b/'));
  assert.ok(!dirMatches('/a/b', '/a/bc'), '/a/b must not match /a/bc');
  assert.ok(!dirMatches('/a/b', '/a/b-old/x'));
  assert.ok(!dirMatches('/a/b', '/a'));
  assert.ok(!dirMatches('/a/b', '/x/a/b'));
  assert.ok(!dirMatches('/a/b', ''));
  assert.ok(!dirMatches('/a/b', undefined));
  assert.ok(dirMatches('/', '/anything/at/all'));
  assert.ok(dirMatches('/a/b/', '/a/b/c'), 'a hand-edited trailing slash still works');
  assert.ok(!dirMatches('/a/b/', '/a/bc'));
});

test('resolveGroup: explicit choice, then the first group by order with a matching folder; "none" pins', () => {
  const groups = [
    { id: 'g-shop', autoDirs: ['/w/shop'], order: 1 },
    { id: 'g-graph', autoDirs: ['/w/shop/graph', '/w/other'], order: 2 },
    { id: 'g-empty', autoDirs: [], order: 3 },
  ];
  assert.equal(resolveGroup(undefined, groups, '/w/shop/graph/src'), 'g-shop', 'first by order wins, not the deepest folder');
  assert.equal(resolveGroup(undefined, groups, '/w/other'), 'g-graph');
  assert.equal(resolveGroup(undefined, groups, '/w/shopping'), undefined, '/w/shop does not hold /w/shopping');
  assert.equal(resolveGroup(undefined, groups, ''), undefined);
  assert.equal(resolveGroup('g-empty', groups, '/w/shop'), 'g-empty', 'an explicit choice beats a folder rule');
  assert.equal(resolveGroup('none', groups, '/w/shop'), undefined, 'pinned to no group');
  assert.equal(resolveGroup('g-gone', groups, '/w/shop'), 'g-shop', 'a choice for a group that no longer exists is ignored');
  assert.equal(resolveGroup('g-gone', groups, '/elsewhere'), undefined);
  assert.equal(resolveGroup(undefined, [groups[1], groups[0]].sort((a, b) => a.order - b.order), '/w/shop/graph'), 'g-shop');
});

// --- the store --------------------------------------------------------------

test('round trip: groups and session names survive a restart', () => {
  const t = tmp();
  const a = createMetaStore({ file: t.file, debounceMs: 20 });
  assert.equal(a.file, t.file);
  assert.deepEqual(a.groups(), []);
  assert.ok(!fs.existsSync(path.dirname(t.file)), 'nothing is created until there is something to save');

  const checkout = a.createGroup({ name: ' Checkout ' });
  const ios = a.createGroup({ name: 'iOS app', color: 'sky', autoDirs: ['/w/shop/ios/'] });
  const cleanup = a.createGroup({ name: 'Cleanup' });
  assert.match(checkout.id, /^g-[0-9a-f]{8}$/);
  assert.deepEqual(checkout, { id: checkout.id, name: 'Checkout', color: 'gold', autoDirs: [], order: 1 });
  assert.deepEqual(ios, { id: ios.id, name: 'iOS app', color: 'sky', autoDirs: ['/w/shop/ios'], order: 2 });
  assert.equal(cleanup.color, 'rose', 'gold and sky are taken: rose is the first unused');
  assert.equal(cleanup.order, 3);

  assert.deepEqual(a.setSessionMeta(SID, { label: ' Cart totals\nport ', groupId: checkout.id }), { id: SID, label: 'Cart totals port', groupId: checkout.id });
  assert.deepEqual(a.setSessionMeta('codex:t-1', { groupId: 'none' }), { id: 'codex:t-1', groupId: 'none' });
  assert.deepEqual(a.setSessionMeta('cursor:c-1', { label: 'x'.repeat(100) }), { id: 'cursor:c-1', label: 'x'.repeat(60) });
  assert.deepEqual(a.getSessionMeta(SID), { label: 'Cart totals port', groupId: checkout.id });
  assert.deepEqual(a.getSessionMeta('claude:never-heard-of-it'), {});
  assert.equal(a.resolveGroup(SID, '/w/shop/ios'), checkout.id);
  assert.equal(a.resolveGroup('codex:t-1', '/w/shop/ios'), undefined);
  assert.equal(a.resolveGroup('cursor:c-1', '/w/shop/ios/App'), ios.id);
  assert.equal(a.resolveGroup('claude:someone-new', '/w/shop/ios-old'), undefined);

  assert.equal(a.flush(), true);
  const disk = read(t.file);
  assert.equal(disk.version, 1);
  assert.deepEqual(disk.groups, [checkout, ios, cleanup]);
  assert.deepEqual(Object.keys(disk.sessions).sort(), ['claude:11111111-2222-4333-8444-555555555555', 'codex:t-1', 'cursor:c-1']);
  assert.equal(disk.sessions[SID].label, 'Cart totals port');
  assert.ok(Math.abs(disk.sessions[SID].seenAt - Date.now()) < 5000);
  assert.equal(fs.statSync(t.file).mode & 0o777, 0o600, 'the file is private to the user');
  assert.equal(fs.statSync(path.dirname(t.file)).mode & 0o777, 0o700, 'so is the directory it made');
  assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['meta.json'], 'no temp file is left behind');
  a.close();

  const b = createMetaStore({ file: t.file });
  assert.deepEqual(b.groups(), [checkout, ios, cleanup]);
  assert.deepEqual(b.getSessionMeta(SID), { label: 'Cart totals port', groupId: checkout.id });
  assert.deepEqual(b.getSessionMeta('codex:t-1'), { groupId: 'none' });
  assert.equal(b.resolveGroup('cursor:c-1', '/w/shop/ios'), ios.id);
  assert.equal(b.createGroup({ name: 'Next' }).order, 4, 'order carries on after a restart');
  b.close();
  t.cleanup();
});

test('updating: rename, recolour, folders, order; labels and groups can be cleared again', () => {
  const t = tmp();
  const store = createMetaStore({ file: t.file });
  const a = store.createGroup({ name: 'Alpha' });
  const b = store.createGroup({ name: 'Beta' });
  assert.deepEqual(store.updateGroup(a.id, { name: 'ALPHA', color: 'plum', autoDirs: ['/w/a', '/w/a/'], order: 5 }), { id: a.id, name: 'ALPHA', color: 'plum', autoDirs: ['/w/a'], order: 5 });
  assert.deepEqual(store.groups().map((g) => g.name), ['Beta', 'ALPHA'], 'sorted by order');
  assert.deepEqual(store.updateGroup(b.id, {}), b, 'an empty patch changes nothing');
  bad(() => store.updateGroup(b.id, { name: 'alpha' }), 409);
  bad(() => store.updateGroup(b.id, { color: 'beige' }), 400);
  bad(() => store.updateGroup('g-nope', { name: 'X' }), 404, /unknown group/);
  bad(() => store.deleteGroup('g-nope'), 404, /unknown group/);
  assert.deepEqual(store.groups().find((g) => g.id === b.id), b, 'a refused update changes nothing');

  // The store hands out copies: a caller cannot reach in.
  store.groups()[0].autoDirs.push('/hacked');
  store.groups()[0].name = 'hacked';
  assert.deepEqual(store.groups()[0], b);

  store.setSessionMeta(SID, { label: 'One', groupId: a.id });
  assert.deepEqual(store.setSessionMeta(SID, { label: null }), { id: SID, groupId: a.id });
  assert.deepEqual(store.setSessionMeta(SID, { label: 'Two' }), { id: SID, label: 'Two', groupId: a.id }, 'a patch only touches what it names');
  assert.deepEqual(store.setSessionMeta(SID, { groupId: 'none' }), { id: SID, label: 'Two', groupId: 'none' });
  assert.deepEqual(store.setSessionMeta(SID, { groupId: null }), { id: SID, label: 'Two' });
  assert.equal(store.resolveGroup(SID, '/w/a/sub'), a.id, 'with no explicit choice the folder rule applies again');
  assert.deepEqual(store.setSessionMeta(SID, { label: '' }), { id: SID });
  assert.equal(store.size, 0, 'an entry with nothing in it is not kept');
  bad(() => store.setSessionMeta(SID, { groupId: 'g-nope' }), 400, /no such group/);
  bad(() => store.setSessionMeta(SID, { label: 42 }), 400);
  bad(() => store.setSessionMeta('emacs:1', { label: 'x' }), 404);
  bad(() => store.setSessionMeta('claude:a b', { label: 'x' }), 400);
  assert.equal(store.size, 0);
  store.close();
  t.cleanup();
});

test('deleting a group clears explicit assignments to it and nothing else', () => {
  const t = tmp();
  const store = createMetaStore({ file: t.file });
  const a = store.createGroup({ name: 'A', autoDirs: ['/w/a'] });
  const b = store.createGroup({ name: 'B', autoDirs: ['/w'] });
  store.setSessionMeta('claude:one', { label: 'Named', groupId: a.id });
  store.setSessionMeta('claude:two', { groupId: a.id });
  store.setSessionMeta('claude:three', { groupId: b.id });
  store.setSessionMeta('claude:four', { groupId: 'none' });
  assert.equal(store.deleteGroup(a.id), true);
  assert.deepEqual(store.groups().map((g) => g.id), [b.id]);
  assert.deepEqual(store.getSessionMeta('claude:one'), { label: 'Named' }, 'the name stays');
  assert.deepEqual(store.getSessionMeta('claude:two'), {});
  assert.deepEqual(store.getSessionMeta('claude:three'), { groupId: b.id });
  assert.deepEqual(store.getSessionMeta('claude:four'), { groupId: 'none' });
  assert.equal(store.size, 3);
  assert.equal(store.resolveGroup('claude:one', '/w/a'), b.id, 'ungrouped, so the remaining folder rule can apply');
  assert.equal(store.resolveGroup('claude:two', '/elsewhere'), undefined);
  store.flush();
  assert.equal(JSON.stringify(read(t.file)).includes(a.id), false, 'no trace of the deleted group on disk');
  store.close();
  t.cleanup();
});

test('limits: 24 groups, 5000 named sessions (the one seen longest ago makes room)', () => {
  const t = tmp();
  let clock = 1_800_000_000_000;
  const store = createMetaStore({ file: t.file, now: () => clock });
  for (let i = 0; i < MAX_GROUPS; i++) store.createGroup({ name: `Group ${i}` });
  bad(() => store.createGroup({ name: 'One too many' }), 400, /at most 24 groups/);
  assert.equal(store.groups().length, MAX_GROUPS);
  assert.deepEqual(GROUP_COLORS.map((c) => store.groups().filter((g) => g.color === c).length), [4, 4, 4, 4, 4, 4], 'default colours spread evenly');
  store.deleteGroup(store.groups()[0].id);
  assert.equal(store.createGroup({ name: 'Fits now' }).order, MAX_GROUPS + 1);

  for (let i = 0; i < MAX_SESSION_ENTRIES; i++) {
    clock += 1;
    store.setSessionMeta(`claude:s-${i}`, { label: `L${i}` });
  }
  assert.equal(store.size, MAX_SESSION_ENTRIES);
  clock += 1;
  store.setSessionMeta('claude:s-0', { label: 'renamed' }); // an existing entry needs no room
  assert.equal(store.size, MAX_SESSION_ENTRIES);
  clock += 1;
  store.setSessionMeta('claude:newest', { label: 'new' });
  assert.equal(store.size, MAX_SESSION_ENTRIES);
  assert.deepEqual(store.getSessionMeta('claude:s-1'), {}, 'the least recently seen entry went');
  assert.deepEqual(store.getSessionMeta('claude:s-0'), { label: 'renamed' });
  assert.deepEqual(store.getSessionMeta('claude:newest'), { label: 'new' });
  store.close();
  t.cleanup();
});

test('writes are debounced into one, and replace the file by rename', async () => {
  const t = tmp();
  const store = createMetaStore({ file: t.file, debounceMs: 60 });
  const g = store.createGroup({ name: 'A' });
  store.updateGroup(g.id, { name: 'B' });
  store.setSessionMeta(SID, { label: 'x' });
  assert.ok(!fs.existsSync(t.file), 'not written synchronously');
  await sleep(200);
  const first = fs.statSync(t.file);
  assert.equal(read(t.file).groups[0].name, 'B');
  assert.equal(read(t.file).sessions[SID].label, 'x');

  // Another burst: again one write, and it is a new file moved into place, not the old one rewritten.
  for (let i = 0; i < 20; i++) store.setSessionMeta(SID, { label: `burst ${i}` });
  await sleep(20);
  assert.equal(read(t.file).sessions[SID].label, 'x', 'still inside the debounce window');
  await sleep(200);
  const second = fs.statSync(t.file);
  assert.equal(read(t.file).sessions[SID].label, 'burst 19');
  assert.notEqual(second.ino, first.ino, 'replaced atomically (temp file + rename)');
  assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['meta.json']);

  // Nothing changed: nothing is written.
  store.setSessionMeta(SID, { label: 'burst 19' });
  store.updateGroup(g.id, { name: 'B' });
  await sleep(150);
  assert.equal(fs.statSync(t.file).ino, second.ino);
  assert.equal(store.flush(), true);
  assert.equal(fs.statSync(t.file).ino, second.ino);

  // close() writes what is still pending.
  store.setSessionMeta(SID, { label: 'last words' });
  store.close();
  assert.equal(read(t.file).sessions[SID].label, 'last words');
  t.cleanup();
});

test('a write that fails leaves the previous file intact and is retried', { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, () => {
  const t = tmp();
  const lines = [];
  const store = createMetaStore({ file: t.file, log: (l) => lines.push(l) });
  const g = store.createGroup({ name: 'Kept' });
  assert.equal(store.flush(), true);
  const before = fs.readFileSync(t.file, 'utf8');
  // A temp file a crashed process left behind is neither read nor in the way.
  fs.writeFileSync(`${t.file}.99999.abcdef.tmp`, '{"version":1,"groups":[{"id":"g-x","na');

  const dir = path.dirname(t.file);
  fs.chmodSync(dir, 0o500);
  try {
    store.updateGroup(g.id, { name: 'Changed' });
    assert.equal(store.flush(), false);
    assert.equal(store.flush(), false);
    assert.equal(fs.readFileSync(t.file, 'utf8'), before, 'the old file is untouched, not truncated');
    assert.equal(store.groups()[0].name, 'Changed', 'the change is still held in memory');
    assert.equal(lines.filter((l) => /could not save/.test(l)).length, 1, 'reported once, not on every retry');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.equal(store.flush(), true);
  assert.equal(read(t.file).groups[0].name, 'Changed');
  assert.ok(lines.some((l) => /saved to .* again/.test(l)));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['meta.json', 'meta.json.99999.abcdef.tmp'], 'no temp file of its own is left');
  store.close();
  t.cleanup();
});

test('a corrupt file is set aside as .bak and the store starts empty', () => {
  for (const [name, content] of [
    ['garbage', '{"version":1,"groups":[{"id":"g-1","name":"Che'],
    ['empty', ''],
    ['not an object', '[1,2,3]'],
    ['null', 'null'],
    ['from the future', JSON.stringify({ version: 2, groups: [{ id: 'g-1', name: 'Future', color: 'teal', autoDirs: [], order: 1, icon: 'star' }] })],
  ]) {
    const t = tmp();
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, content);
    const lines = [];
    const store = createMetaStore({ file: t.file, log: (l) => lines.push(l) });
    assert.deepEqual(store.groups(), [], name);
    assert.equal(store.size, 0, name);
    assert.equal(fs.readFileSync(`${t.file}.bak`, 'utf8'), content, `${name}: the original is kept`);
    assert.ok(!fs.existsSync(t.file), `${name}: moved, not copied`);
    assert.equal(lines.length, 1, name);
    assert.match(lines[0], /meta\.json\.bak/);

    // It works normally from there.
    const g = store.createGroup({ name: 'Fresh' });
    store.close();
    assert.deepEqual(read(t.file).groups, [g]);
    assert.equal(fs.readFileSync(`${t.file}.bak`, 'utf8'), content);
    t.cleanup();
  }

  // Not a file at all.
  const t = tmp();
  fs.mkdirSync(t.file, { recursive: true });
  const store = createMetaStore({ file: t.file });
  assert.deepEqual(store.groups(), []);
  assert.ok(fs.statSync(`${t.file}.bak`).isDirectory());
  store.createGroup({ name: 'Fresh' });
  store.close();
  assert.equal(read(t.file).groups.length, 1);
  t.cleanup();
});

test('a file that is only partly usable: the good parts load, the original is kept as .bak', () => {
  const t = tmp();
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  const now = Date.now();
  const content = JSON.stringify({
    version: 1,
    groups: [
      { id: 'g-ok', name: 'Fine', color: 'lime', autoDirs: ['/w/a/', 'relative'], order: 2 },
      { id: 'g-ok', name: 'Same id again', color: 'gold', autoDirs: [], order: 3 },
      { id: 'g-dup', name: 'FINE', color: 'gold', autoDirs: [], order: 4 },
      { id: 'none', name: 'Reserved id', color: 'gold', autoDirs: [], order: 5 },
      { id: '../x', name: 'Bad id', color: 'gold', autoDirs: [], order: 6 },
      { id: 'g-noname', color: 'gold', autoDirs: [], order: 7 },
      { id: 'g-colour', name: 'Odd colour', color: 'beige', autoDirs: [], order: 8 },
      { id: 'g-loose', name: `  A very long name that\nruns past the limit `, autoDirs: 'nope' },
      'junk',
    ],
    sessions: {
      'claude:good': { label: '  Good\none ', groupId: 'g-ok', seenAt: now - 1000 },
      'claude:stale-group': { label: 'Keeps its name', groupId: 'g-gone', seenAt: now },
      'claude:pinned': { groupId: 'none' },
      'claude:only-stale-group': { groupId: 'g-gone', seenAt: now },
      'claude:empty': { seenAt: now },
      'emacs:1': { label: 'unknown tool', seenAt: now },
      'claude:bad id': { label: 'x', seenAt: now },
      'codex:junk': 'nope',
    },
  });
  fs.writeFileSync(t.file, content);
  const lines = [];
  const store = createMetaStore({ file: t.file, log: (l) => lines.push(l) });
  assert.deepEqual(store.groups(), [
    { id: 'g-ok', name: 'Fine', color: 'lime', autoDirs: ['/w/a'], order: 2 },
    { id: 'g-colour', name: 'Odd colour', color: 'gold', autoDirs: [], order: 8 },
    { id: 'g-loose', name: 'A very long name that ru', color: 'rose', autoDirs: [], order: 9 },
  ]);
  assert.deepEqual(store.getSessionMeta('claude:good'), { label: 'Good one', groupId: 'g-ok' });
  assert.deepEqual(store.getSessionMeta('claude:stale-group'), { label: 'Keeps its name' });
  assert.deepEqual(store.getSessionMeta('claude:pinned'), { groupId: 'none' });
  assert.equal(store.size, 3);
  assert.equal(fs.readFileSync(`${t.file}.bak`, 'utf8'), content);
  assert.equal(fs.readFileSync(t.file, 'utf8'), content, 'the file itself is only replaced by the next save');
  assert.ok(lines.some((l) => /unusable entr/.test(l)));
  store.close();
  t.cleanup();
});

test('sessions seen on the floor are kept; ones not seen for 30 days are pruned', () => {
  const t = tmp();
  let clock = 1_800_000_000_000;
  const start = clock;
  let changes = 0;
  const store = createMetaStore({ file: t.file, now: () => clock, onChange: () => changes++ });
  const g = store.createGroup({ name: 'G' });
  store.setSessionMeta('claude:regular', { label: 'Seen every day' });
  store.setSessionMeta('claude:gone', { label: 'Never seen again', groupId: g.id });
  store.flush();
  changes = 0;
  assert.equal(read(t.file).sessions['claude:regular'].seenAt, start);

  // Seen again within the hour: not worth a write.
  clock = start + SEEN_TOUCH_MS - 1;
  store.touch(['claude:regular', 'claude:unnamed-session']);
  assert.equal(store.flush(), true);
  assert.equal(read(t.file).sessions['claude:regular'].seenAt, start);
  assert.equal(store.size, 2, 'a session with no name and no group gets no entry just for being seen');

  // An hour on, it is noted.
  clock = start + SEEN_TOUCH_MS;
  store.touch(['claude:regular'], clock);
  store.flush();
  assert.equal(read(t.file).sessions['claude:regular'].seenAt, clock);
  assert.equal(read(t.file).sessions['claude:gone'].seenAt, start);

  // Thirty days after it was last seen an entry goes; the one still on the floor stays.
  clock = start + SESSION_TTL_MS;
  store.touch(['claude:regular'], clock);
  assert.deepEqual(store.getSessionMeta('claude:gone'), { label: 'Never seen again', groupId: g.id }, 'exactly 30 days is not yet too old');
  clock = start + SESSION_TTL_MS + SEEN_TOUCH_MS;
  store.touch(['claude:regular'], clock);
  assert.deepEqual(store.getSessionMeta('claude:gone'), {});
  assert.deepEqual(store.getSessionMeta('claude:regular'), { label: 'Seen every day' });
  store.flush();
  assert.deepEqual(Object.keys(read(t.file).sessions), ['claude:regular']);
  assert.equal(changes, 0, 'none of this is a change the UI needs to hear about');
  store.close();

  // A store that starts after a long break prunes on load.
  clock += 31 * DAY;
  const later = createMetaStore({ file: t.file, now: () => clock });
  assert.equal(later.size, 0);
  assert.equal(later.groups().length, 1, 'groups are never pruned');
  later.close();
  assert.deepEqual(read(t.file).sessions, {});
  t.cleanup();
});

test('the change callback fires once per visible change and not for no-ops or refusals', () => {
  const t = tmp();
  let calls = 0;
  let viaSubscribe = 0;
  const store = createMetaStore({ file: t.file, onChange: () => calls++ });
  const off = store.subscribe(() => viaSubscribe++);
  store.subscribe(() => {
    throw new Error('a broken listener');
  });
  const g = store.createGroup({ name: 'A' });
  assert.equal(calls, 1);
  store.updateGroup(g.id, { color: 'sky' });
  assert.equal(calls, 2);
  store.updateGroup(g.id, { color: 'sky' });
  store.updateGroup(g.id, {});
  assert.equal(calls, 2, 'nothing changed');
  store.setSessionMeta(SID, { label: 'L' });
  assert.equal(calls, 3);
  store.setSessionMeta(SID, { label: ' L ' });
  store.setSessionMeta(SID, {});
  store.setSessionMeta('claude:other', { label: null, groupId: null });
  assert.equal(calls, 3);
  assert.throws(() => store.setSessionMeta(SID, { groupId: 'g-nope' }));
  assert.throws(() => store.createGroup({ name: 'a' }));
  assert.equal(calls, 3);
  store.deleteGroup(g.id);
  assert.equal(calls, 4);
  assert.equal(viaSubscribe, 4);
  off();
  store.createGroup({ name: 'B' });
  assert.equal(calls, 5);
  assert.equal(viaSubscribe, 4);
  store.close();
  t.cleanup();
});

// --- mock mode --------------------------------------------------------------

test('createMockMeta drives the mock generator with the same validation', async () => {
  const { createMock } = await import('../public/js/mock-state.js');
  const mock = createMock();
  let changes = 0;
  const meta = createMockMeta(mock, { onChange: () => changes++ });
  assert.equal(meta.mock, true);
  assert.deepEqual(meta.groups().map((g) => g.id), ['g-checkout', 'g-ios', 'g-cleanup']);
  assert.deepEqual(meta.getSessionMeta('claude:mock-01'), { label: 'Cart totals port', groupId: 'g-checkout' });
  assert.deepEqual(meta.getSessionMeta('claude:mock-99'), {});
  assert.equal(meta.resolveGroup('codex:mock-03', '/Users/dev/projects/shop/ios'), 'g-ios');

  const g = meta.createGroup({ name: ' Research ', autoDirs: ['/Users/dev/projects/analytics/'] });
  assert.equal(g.name, 'Research');
  assert.equal(g.color, 'lime', 'gold, rose and sky are used once each: lime is the first unused');
  assert.deepEqual(g.autoDirs, ['/Users/dev/projects/analytics']);
  assert.equal(g.order, 4);
  assert.equal(changes, 1);
  assert.deepEqual(mock.next().groups.map((x) => x.name), ['Checkout', 'iOS app', 'Cleanup', 'Research']);
  bad(() => meta.createGroup({ name: 'research' }), 409);
  bad(() => meta.createGroup({}), 400);
  bad(() => meta.createGroup({ name: 'X', color: 'coral' }), 400);
  bad(() => meta.updateGroup('g-nope', { name: 'X' }), 404);
  bad(() => meta.deleteGroup('g-nope'), 404);
  assert.equal(changes, 1);

  assert.equal(meta.updateGroup(g.id, { name: 'Analytics', order: 0 }).order, 0);
  assert.equal(mock.next().groups[0].name, 'Analytics');

  assert.deepEqual(meta.setSessionMeta('claude:mock-02', { label: ' Flaky\ne2e ', groupId: g.id }), { id: 'claude:mock-02', label: 'Flaky e2e', groupId: g.id });
  assert.deepEqual(meta.setSessionMeta('claude:not-on-the-floor', { label: 'Later' }), { id: 'claude:not-on-the-floor', label: 'Later' });
  bad(() => meta.setSessionMeta('claude:mock-02', { groupId: 'g-nope' }), 400);
  bad(() => meta.setSessionMeta('emacs:1', { label: 'x' }), 404);
  const s = mock.next().sessions.find((x) => x.id === 'claude:mock-02');
  assert.equal(s.label, 'Flaky e2e');
  assert.equal(s.groupId, g.id);
  assert.deepEqual(meta.setSessionMeta('claude:mock-02', {}), { id: 'claude:mock-02', label: 'Flaky e2e', groupId: g.id });
  assert.deepEqual(meta.setSessionMeta('claude:mock-02', { label: null, groupId: 'none' }), { id: 'claude:mock-02', groupId: 'none' });

  assert.equal(meta.deleteGroup(g.id), true);
  assert.ok(!mock.next().groups.some((x) => x.id === g.id));
  for (let i = meta.groups().length; i < MAX_GROUPS; i++) meta.createGroup({ name: `Filler ${i}` });
  bad(() => meta.createGroup({ name: 'One too many' }), 400, /at most 24/);
  meta.close();
});
