import assert from 'node:assert/strict';
import test from 'node:test';
import { NAMES, SUB_NAMES, nameFor, subNameFor, createNamer, assignNames } from './names.mjs';

const session = (id, startedAt = 0, subagents = []) => ({ id, startedAt, subagents });
const sub = (id, startedAt = 0) => ({ id, startedAt });

function collidingIds() {
  const seen = new Map();
  for (let i = 0; ; i++) {
    const id = `claude:collide-${i}`;
    const name = nameFor(id);
    if (seen.has(name)) return [seen.get(name), id, name];
    seen.set(name, id);
  }
}

test('name lists are well formed', () => {
  assert.ok(NAMES.length >= 140 && NAMES.length <= 180, `have ${NAMES.length} names`);
  assert.equal(new Set(NAMES).size, NAMES.length, 'no duplicate names');
  for (const n of NAMES) assert.match(n, /^[A-Z]{3,6}$/);
  assert.ok(SUB_NAMES.length >= 30);
  assert.equal(new Set(SUB_NAMES).size, SUB_NAMES.length, 'no duplicate subagent names');
  for (const n of SUB_NAMES) assert.match(n, /^[A-Z]{3,4}$/);
  assert.equal(NAMES.filter((n) => SUB_NAMES.includes(n)).length, 0, 'the two lists do not overlap');
});

test('nameFor is deterministic and spreads over the list', () => {
  assert.equal(nameFor('claude:abc'), nameFor('claude:abc'));
  assert.ok(NAMES.includes(nameFor('codex:0199-aaaa')));
  assert.ok(SUB_NAMES.includes(subNameFor('claude:abc', 'sub-1')));
  const used = new Set();
  for (let i = 0; i < 2000; i++) used.add(nameFor(`claude:${i}`));
  assert.ok(used.size > NAMES.length * 0.9, `only ${used.size} of ${NAMES.length} names reachable`);
});

test('a session keeps its name across polls, whatever order it arrives in', () => {
  const namer = createNamer();
  const ids = Array.from({ length: 40 }, (_, i) => `claude:s-${i}`);
  const first = new Map(namer.assign(ids.map((id, i) => session(id, i))).map((s) => [s.id, s.name]));
  for (let round = 0; round < 5; round++) {
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    for (const s of namer.assign(shuffled.map((id) => session(id, ids.indexOf(id))))) assert.equal(s.name, first.get(s.id));
  }
});

test('names are unique among the sessions in the office', () => {
  const namer = createNamer();
  const sessions = namer.assign(Array.from({ length: 120 }, (_, i) => session(`codex:u-${i}`, i)));
  assert.equal(new Set(sessions.map((s) => s.name)).size, 120);
  for (const s of sessions) assert.ok(NAMES.includes(s.name));
});

test('a collision goes to the next free name, the same way every time', () => {
  const [a, b, shared] = collidingIds();
  const run = (order) => {
    const namer = createNamer();
    const out = namer.assign(order.map((id) => session(id, id === a ? 1 : 2)));
    return Object.fromEntries(out.map((s) => [s.id, s.name]));
  };
  const one = run([a, b]);
  const two = run([b, a]);
  assert.deepEqual(one, two, 'input order does not matter');
  assert.equal(one[a], shared, 'the earlier session keeps the hashed name');
  assert.notEqual(one[b], shared);
  assert.equal(one[b], NAMES[(NAMES.indexOf(shared) + 1) % NAMES.length]);
});

test('a name is not taken from a session that already has it, and is not changed when a rival leaves', () => {
  const [a, b, shared] = collidingIds();
  const namer = createNamer();
  // b is in the office first, so it owns the hashed name even though a "started" earlier.
  assert.equal(namer.assign([session(b, 5)])[0].name, shared);
  const both = namer.assign([session(a, 1), session(b, 5)]);
  assert.equal(both.find((s) => s.id === b).name, shared);
  const aName = both.find((s) => s.id === a).name;
  assert.notEqual(aName, shared);
  // b leaves: a keeps the name it has been showing.
  assert.equal(namer.assign([session(a, 1)])[0].name, aName);
  // b comes back while a is still there: it gets its hashed name again, it is free.
  assert.equal(namer.assign([session(a, 1), session(b, 5)]).find((s) => s.id === b).name, shared);
});

test('more sessions than names still get unique names', () => {
  const namer = createNamer();
  const sessions = namer.assign(Array.from({ length: NAMES.length + 25 }, (_, i) => session(`cursor:many-${i}`, i)));
  assert.equal(new Set(sessions.map((s) => s.name)).size, sessions.length);
  assert.ok(sessions.some((s) => /\d$/.test(s.name)));
});

test('subagents are named, uniquely within their room, and stably', () => {
  const namer = createNamer();
  const subs = () => Array.from({ length: 30 }, (_, i) => sub(`agent-${i}`, i));
  const [room, other] = namer.assign([session('claude:room', 1, subs()), session('claude:other', 2, [sub('agent-0')])]);
  assert.equal(new Set(room.subagents.map((s) => s.name)).size, 30);
  for (const s of room.subagents) assert.ok(SUB_NAMES.includes(s.name));
  assert.ok(SUB_NAMES.includes(other.subagents[0].name));
  const before = Object.fromEntries(room.subagents.map((s) => [s.id, s.name]));
  // Half of them finish and disappear; the rest keep their names.
  const [again] = namer.assign([session('claude:room', 1, subs().filter((_, i) => i % 2 === 0).reverse())]);
  for (const s of again.subagents) assert.equal(s.name, before[s.id]);
});

test('assignNames names in place with the shared namer', () => {
  const list = [session('claude:shared-1', 1), session('codex:shared-2', 2)];
  assert.equal(assignNames(list), list);
  assert.ok(list.every((s) => NAMES.includes(s.name)));
  assert.notEqual(list[0].name, list[1].name);
});
