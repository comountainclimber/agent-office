// Deterministic nicknames for sessions and their subagents.
//
//   nameFor(id)            -> the name an id hashes to (no uniqueness guarantee)
//   createNamer()          -> { assign(sessions) } with its own memory
//   assignNames(sessions)  -> same, using a shared default namer
//
// `assign` mutates and returns the array: every session gets `name`, every subagent gets `name`.
// A session keeps its name for as long as it stays in the office. When two ids hash to the same
// name, the one that was there first keeps it and the newcomer takes the next free name in list
// order (newcomers are processed in startedAt/id order, so the outcome does not depend on the
// order adapters happened to return them in).

export const NAMES = Object.freeze([
  'ABBY', 'ALFIE', 'ARCHIE', 'ARI', 'ASH', 'AXEL', 'BABS', 'BAXTER', 'BEA', 'BENJI',
  'BINGO', 'BIRDIE', 'BLITZ', 'BODIE', 'BONNIE', 'BOOTS', 'BRIAR', 'BRUNO', 'BUCK', 'BUDDY',
  'CALLA', 'CHIP', 'CLEO', 'COCO', 'COMET', 'COSMO', 'DAISY', 'DASH', 'DEX', 'DOTTIE',
  'DOZER', 'DUKE', 'EDDIE', 'ELLIE', 'EMBER', 'ENZO', 'ESME', 'FARO', 'FELIX', 'FERN',
  'FINN', 'FIZZ', 'FLINT', 'FLO', 'FRITZ', 'GIGI', 'GOLDIE', 'GRETA', 'GUS', 'HANK',
  'HAZEL', 'HOLLY', 'HUGO', 'IGGY', 'INDY', 'IRIS', 'JAX', 'JETT', 'JINX', 'JOJO',
  'JUNE', 'JUNO', 'KAI', 'KIKI', 'KIP', 'KODA', 'LARK', 'LENNY', 'LEO', 'LIBBY',
  'LOLA', 'LOTTIE', 'LUNA', 'MABEL', 'MACK', 'MAGPIE', 'MARLO', 'MAVIS', 'MIKO', 'MIMI',
  'MINNOW', 'MISO', 'MOCHI', 'MONTY', 'MOSS', 'MOXIE', 'MUNCH', 'NACHO', 'NELL', 'NIKO',
  'NORI', 'NOVA', 'OLIVE', 'OLLIE', 'ONYX', 'OPAL', 'ORBIT', 'OSCAR', 'OTTO', 'OZZY',
  'PADDY', 'PASHA', 'PEACH', 'PEARL', 'PEBBLE', 'PENNY', 'PEPPER', 'PERCY', 'PIPER', 'PIXIE',
  'PLUM', 'POPPY', 'QUILL', 'QUINN', 'RAFA', 'RALPH', 'REMI', 'RHEA', 'RIKO', 'RILEY',
  'ROCCO', 'ROMY', 'ROOK', 'ROSIE', 'RUBY', 'RUFUS', 'RUNE', 'SABLE', 'SADIE', 'SAGE',
  'SCOUT', 'SID', 'SKYE', 'SOL', 'SPARK', 'SPROUT', 'SUKI', 'SUNNY', 'TALLY', 'TANGO',
  'TASHA', 'TEDDY', 'TEX', 'THEO', 'TILLY', 'TOBY', 'TOFU', 'TUCK', 'TULIP', 'UMA',
  'VERA', 'VIOLET', 'WALDO', 'WALLY', 'WILLOW', 'WINK', 'WREN', 'YARA', 'YUKI', 'ZED',
  'ZEKE', 'ZIGGY', 'ZIPPY', 'ZOLA', 'ZUZU',
]);

export const SUB_NAMES = Object.freeze([
  'ACE', 'BEE', 'BOLT', 'BUD', 'COG', 'DAB', 'DOC', 'DOT', 'ELF', 'FAY',
  'FOX', 'GEM', 'GIL', 'HAL', 'HOP', 'INK', 'IVY', 'JAY', 'JIB', 'JOT',
  'KAT', 'KEY', 'KIT', 'LEX', 'LOU', 'MOE', 'NED', 'NIB', 'NUB', 'OLA',
  'OWL', 'PAZ', 'PEG', 'PIP', 'RAY', 'REX', 'SUE', 'TAB', 'TAD', 'TAJ',
  'TOT', 'UNA', 'VAL', 'WES', 'YAZ', 'ZAP', 'ZIP', 'ZOE',
]);

/** FNV-1a, 32 bit. Stable across runs and platforms. */
export function hash(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // one extra avalanche step: ids that differ only in the last character should not land side by side
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return h >>> 0;
}

export function nameFor(id) {
  return NAMES[hash(id) % NAMES.length];
}

export function subNameFor(sessionId, subagentId) {
  return SUB_NAMES[hash(`${sessionId}#${subagentId}`) % SUB_NAMES.length];
}

/** First name at or after the hashed slot that is not taken; numbered names once the list is exhausted. */
function pick(list, key, taken) {
  const start = hash(key) % list.length;
  for (let k = 0; k < list.length; k++) {
    const candidate = list[(start + k) % list.length];
    if (!taken.has(candidate)) return candidate;
  }
  for (let round = 2; ; round++) {
    for (let k = 0; k < list.length; k++) {
      const candidate = `${list[(start + k) % list.length]}${round}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}

function byArrival(a, b) {
  return (a.startedAt || 0) - (b.startedAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function createNamer() {
  /** @type {Map<string, string>} session id -> name, for sessions currently in the office */
  const sessionNames = new Map();
  /** @type {Map<string, Map<string, string>>} session id -> (subagent id -> name) */
  const subNames = new Map();

  function assign(sessions) {
    const present = new Set(sessions.map((s) => s.id));
    for (const id of sessionNames.keys()) if (!present.has(id)) sessionNames.delete(id);
    for (const id of subNames.keys()) if (!present.has(id)) subNames.delete(id);

    const taken = new Set(sessionNames.values());
    const newcomers = sessions.filter((s) => !sessionNames.has(s.id)).sort(byArrival);
    for (const s of newcomers) {
      if (sessionNames.has(s.id)) continue; // duplicate id in the input
      const name = pick(NAMES, s.id, taken);
      sessionNames.set(s.id, name);
      taken.add(name);
    }

    for (const s of sessions) {
      s.name = sessionNames.get(s.id);
      const subs = Array.isArray(s.subagents) ? s.subagents : [];
      if (!subs.length) {
        subNames.delete(s.id);
        continue;
      }
      let room = subNames.get(s.id);
      if (!room) subNames.set(s.id, (room = new Map()));
      const here = new Set(subs.map((x) => x.id));
      for (const id of room.keys()) if (!here.has(id)) room.delete(id);
      const roomTaken = new Set(room.values());
      const fresh = subs.filter((x) => !room.has(x.id)).sort(byArrival);
      for (const x of fresh) {
        if (room.has(x.id)) continue;
        const name = pick(SUB_NAMES, `${s.id}#${x.id}`, roomTaken);
        room.set(x.id, name);
        roomTaken.add(name);
      }
      for (const x of subs) x.name = room.get(x.id);
    }
    return sessions;
  }

  return { assign };
}

const defaultNamer = createNamer();

/** Name every session (and its subagents) in place. Uses one process-wide memory. */
export function assignNames(sessions) {
  return defaultNamer.assign(sessions);
}
