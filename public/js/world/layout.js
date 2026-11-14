// Office geometry, in logical pixels. Pure functions, no drawing.
//
//   y 0..50     back wall (lobby door, then one glass conference room per orchestrator)
//   y 50..112   floor along the wall: lobby | conference rooms ->
//   y 112..124  walkway (everyone travels along y = 119)
//   y 124..     lounge (break area) on the left, then the bullpen: one "pod" of desk cells per group
//               (in group order), then the default pod for everyone without a group. Every pod stands
//               in a SLOT that it keeps (see below); the floor right of the last pod is where pods grow.
//
// The lounge sits under the lobby instead of beside it, so the wall belongs to the rooms and the
// whole office stays narrow enough to be drawn big.

export const G = {
  WALL: 50,
  BAND: 112, // bottom of the wall-side floor
  WALK: 117, // the walkway line
  BULL: 124, // top of the first desk row
  ROW: 44,
  CELL: 64, // desk cell: a 9px aisle, then chair, sitter and desk
  PAD: 8,
  POD_GAP: 8, // floor between two pods (their rugs keep 4px of it clear)
  HEAD: 12, // strip of floor above a pod that sits under another one: its sign stands there
  FOOT: 4, // floor below the last desk row (a desk front hangs 3px over its cell)
  SIGN_Y: 117, // top of the low standing signs along the walkway (pod names, BREAK ROOM)
  LOBBY: 34,
  LOUNGE: 112,
  ROOM: 108,
  UTIL: 62,
  MIN_COLS: 2,
  RPAD: 6, // floor right of the last desk column
  MIN_ROOMS: 1,
  SEATS: 8, // seats at a conference table (4 a side); more shows "+N"
};

export const ROOMS_X = G.LOBBY;
export const DESKS_X = G.LOUNGE + G.PAD;
const LANE = G.LOUNGE + 2; // the aisle between the lounge and the first desk column
export const AISLE = 2; // where people walk down a desk column, relative to the cell's left edge (clear of whoever sits there)
const FURN = 4; // chair + desk sit this far into their cell, which leaves the aisle clear

/**
 * A pod's SLOT is where it stands and how big its block of desk cells is:
 *   { key, x, y, c0, cols, ph, under, mask? }
 * x, y = top-left of the block; cols x ph cells; c0 = the columns it was first given (see cellOf);
 * under = it stands below another pod (its sign then needs G.HEAD px of floor above it);
 * mask[i] = whether desk i is furnished (a desk nobody ever sat at is just floor).
 * Slots are memory: the office keeps them from one state to the next, grows them in place and only
 * makes new ones when it re-plans (see office.js). Nothing in here moves a slot.
 */

/**
 * Which cell desk `i` of a slot stands in. The numbering never changes while the slot grows in place:
 * a one-column slot is filled downwards (and may get longer: ph + 1); a wider one fills its first c0
 * columns row by row, so a half-empty pod is a few full rows and not a ragged block. Columns added later
 * (cols > c0) are appended on the right and filled downwards.
 */
export function cellOf(slot, i) {
  const base = slot.c0 * slot.ph;
  if (i < base) return slot.c0 > 1 ? { c: i % slot.c0, r: Math.floor(i / slot.c0) } : { c: 0, r: i };
  const j = i - base;
  return { c: slot.c0 + Math.floor(j / slot.ph), r: j % slot.ph };
}

/**
 * Lay fresh slots out, in order, left to right, for `rows` desk rows (+ `extra` px of floor below them).
 * demand: [{ key, cap, min?, shape? }]  cap = desk cells wanted, min = fewest columns, shape = see below.
 * A pod that needs no more cells than there are rows is "short": one column, exactly as tall as its desks.
 * A short pod goes under an earlier short pod when that column has room for it (first fit; each pod after
 * the first in a column needs G.HEAD px for its sign), so a small group usually costs no width at all.
 * @returns {{slots: {key:string,x:number,y:number,c0:number,cols:number,ph:number,under:boolean}[], right:number}}
 */
export function packSlots(rows, extra, demand) {
  const room = rows * G.ROW + extra;
  const slots = [];
  const stacks = []; // columns that hold short pods: { x, used }
  let x = DESKS_X;
  for (const p of demand) {
    const cap = Math.max(1, p.cap || 0);
    let c0 = Math.max(p.min || 1, Math.ceil(cap / rows));
    let cols = c0;
    let short = c0 === 1 && cap <= rows;
    let ph = short ? cap : rows;
    // `shape`: the block this pod stands in now. One that is more than a column wide keeps its row length
    // and its first columns (so cellOf() gives every desk the same cell as before): the pod moves as it is.
    const h = p.shape;
    if (h && h.c0 > 1 && h.ph <= rows) { c0 = h.c0; ph = h.ph; cols = Math.max(c0, Math.ceil(cap / ph)); short = false; }
    const stack = short ? stacks.find((st) => st.used + G.HEAD + cap * G.ROW <= room) : null;
    if (stack) {
      slots.push({ key: p.key, x: stack.x, y: G.BULL + stack.used + G.HEAD, c0: 1, cols: 1, ph: cap, under: true });
      stack.used += G.HEAD + cap * G.ROW;
      continue;
    }
    if (slots.length) x += G.POD_GAP;
    slots.push({ key: p.key, x, y: G.BULL, c0, cols, ph, under: false });
    if (short) stacks.push({ x, used: cap * G.ROW });
    x += cols * G.CELL;
  }
  return { slots, right: x };
}

/** Height of an office with `rows` desk rows. */
export const worldHeight = (rows, extra = 0) => G.BULL + rows * G.ROW + extra + G.FOOT;

/**
 * @param {{rows:number, extra?:number, slots:object[], rooms:number, minW?:number}} p
 *   slots: see above, in display order. rooms = meeting rooms along the wall. minW = the office is at least
 *   this wide (the window's width: the floor and the wall run from edge to edge, so the office's corner
 *   never depends on how many desks there are).
 */
export function computeLayout({ rows, extra = 0, slots = [], rooms, minW = 0 }) {
  const nRooms = Math.max(G.MIN_ROOMS, rooms);
  let right = DESKS_X;
  for (const s of slots) right = Math.max(right, s.x + s.cols * G.CELL);
  const H = worldHeight(rows, extra);
  const roomsRight = ROOMS_X + nRooms * G.ROOM;
  const W = Math.max(Math.ceil(minW), right + G.RPAD, roomsRight);
  const L = { rows, extra, nRooms, W, H, cols: 0 };
  L.pods = [];
  L.podMap = new Map();
  L.desks = [];
  const keys = [];
  for (const s of slots) {
    const pod = { key: s.key, x: s.x, y: s.y, c0: s.c0, cols: s.cols, ph: s.ph, w: s.cols * G.CELL, n: 0, under: !!s.under, uc: 1, ur: 1, desks: [] };
    let bits = '';
    for (let i = 0; i < s.cols * s.ph; i++) {
      const { c, r } = cellOf(s, i);
      const cx = s.x + c * G.CELL;
      const cy = s.y + r * G.ROW;
      const shown = !!(s.mask && s.mask[i]);
      // fx = where the chair-and-desk group starts; the strip left of it (cx .. fx+4) is the aisle
      const d = { pod: s.key, i, id: `${s.key}/${i}`, cx, cy, c, r, fx: cx + FURN, seat: { x: cx + FURN + 13, y: cy + 42 }, shown };
      pod.desks.push(d);
      bits += shown ? '1' : '0';
      if (!shown) continue;
      L.desks.push(d);
      pod.n++;
      if (c + 1 > pod.uc) pod.uc = c + 1;
      if (r + 1 > pod.ur) pod.ur = r + 1;
    }
    // the pod's floor (its rug) is as big as the desks that stand on it, not as the block it may grow into
    pod.uw = pod.uc * G.CELL;
    pod.bottom = s.y + pod.ur * G.ROW + G.FOOT;
    L.pods.push(pod);
    L.podMap.set(s.key, pod);
    if (!s.under) L.cols += s.cols;
    keys.push(`${s.key}:${s.x}:${s.y}:${s.c0}:${s.cols}:${s.ph}:${bits}`);
  }
  // how wide each pod's sign may be: it may overhang its rug as far as the next sign standing on the same line
  for (const pod of L.pods) {
    let lim = W - 3;
    for (const q of L.pods) if (q !== pod && q.x > pod.x && Math.abs(q.y - pod.y) < 14) lim = Math.min(lim, q.x - 6);
    pod.signMax = Math.max(pod.uw + 3, lim - (pod.x - 2));
  }
  L.key = `${rows}/${extra}/${nRooms}/${W}/${keys.join('|')}`;
  L.rooms = [];
  for (let i = 0; i < nRooms; i++) L.rooms.push({ i, x: ROOMS_X + i * G.ROOM, cols: 2 });
  L.roomsRight = roomsRight;
  L.bullRight = right;
  // server rack / printer / plant stand against the back wall wherever it is not a conference room
  L.util = W - L.roomsRight >= G.UTIL ? { x: L.roomsRight + 6 } : null;
  L.door = { x: 17, y: 54 };
  L.lounge = { x: 0, y: G.BULL, w: G.LOUNGE, h: H - G.BULL };
  L.lg = loungeGeom(H - G.BULL);
  return L;
}

/** The desk cell a place {t:'desk', pod, i} points at (null when the pod or the slot is gone). */
export function deskAt(L, place) {
  const pod = L.podMap.get(place.pod || '');
  return (pod && pod.desks[place.i]) || null;
}

// ---------------------------------------------------------------- lounge
// Two depth rows: the machines along the walkway side (people stand in front of them) and the couch
// below. With three or more desk rows the couch moves further down, so name tags get more air.
// `kind` picks the idle animation.
export const LOUNGE_X = { vending: 3, cooler: 29, counter: 50, arcade: 89, couch: 5, plant: 91 };

function loungeGeom(h) {
  const tall = h >= 3 * G.ROW;
  const backY = G.BULL + 40; // base line of the machines
  const standY = G.BULL + 44; // feet of whoever is using one
  const couchY = G.BULL + (tall ? 98 : 60); // top of the couch sprite
  const seatY = couchY + 22;
  const X = LOUNGE_X;
  const slots = [
    { x: X.couch + 16, y: seatY, kind: 'couch' },
    { x: X.arcade + 10, y: standY, kind: 'arcade' },
    { x: X.couch + 56, y: seatY, kind: 'couch' },
    { x: X.vending + 11, y: standY, kind: 'vending' },
    { x: X.counter + 18, y: standY, kind: 'counter' },
    { x: X.couch + 36, y: seatY, kind: 'couch' },
    { x: X.cooler + 15, y: standY + 1, kind: 'cooler' },
  ];
  // (walkers pass 5px in front of whoever stands or sits here: see LANE_BIAS in office.js)
  return { backY, standY, couchY, seatY, mid: standY + 5, front: seatY + 5, tall, slots };
}

export function breakSlot(L, k) {
  const lg = L.lg;
  if (k < lg.slots.length) return lg.slots[k];
  // overflow: loiter in the open strip between the machines and the couch
  const j = k - lg.slots.length;
  const y = lg.tall ? lg.standY + 22 + (j % 2) * 8 : lg.standY + 6 + (j % 2) * 3;
  return { x: 14 + ((j * 27) % (G.LOUNGE - 24)), y, kind: 'stand' };
}

// ---------------------------------------------------------------- conference rooms
/** How many seat columns a table needs for `n` helpers (the far side fills first). */
export function roomCols(n) {
  return n <= 2 ? 2 : n >= 4 ? 4 : 3;
}

const SEAT_PITCH = { 2: 24, 3: 22, 4: 18 };
const SEAT_X0 = { 2: 53, 3: 43, 4: 38 };

/** Table extent for a room with `cols` seat columns. */
export function tableRect(room, cols = room.cols) {
  const x0 = room.x + SEAT_X0[cols] - 11;
  return { x: x0, y: 65, w: SEAT_PITCH[cols] * (cols - 1) + 22 };
}

/** Seat k at a conference table: 0..3 = far side (faces us), 4..7 = near side (back to us). */
export function seatPos(room, k, cols = room.cols) {
  const top = k < 4;
  const col = Math.min(k % 4, cols - 1);
  return { x: room.x + SEAT_X0[cols] + SEAT_PITCH[cols] * col, y: top ? 72 : 103, top, col };
}

export const BOSS = { x: 15, y: 87 };

/**
 * Where a place is and how to walk there from the walkway.
 * place: {t:'desk',pod,i} | {t:'boss',room} | {t:'seat',room,k} | {t:'break',k} | {t:'door'}
 * @returns {{x:number,y:number,approach:{x:number,y:number}[]}|null}
 */
export function geom(L, place) {
  const Y = G.WALK;
  switch (place.t) {
    case 'desk': {
      const d = deskAt(L, place);
      if (!d) return null;
      const ax = d.cx + AISLE; // the aisle behind the chair
      return { x: d.seat.x, y: d.seat.y, approach: [{ x: ax, y: Y }, { x: ax, y: d.seat.y }, { x: d.seat.x, y: d.seat.y }] };
    }
    case 'boss': {
      const r = L.rooms[place.room];
      if (!r) return null;
      const dx = r.x + 102;
      const bx = r.x + BOSS.x;
      return { x: bx, y: BOSS.y, approach: [{ x: dx, y: Y }, { x: dx, y: 108 }, { x: bx, y: 108 }, { x: bx, y: BOSS.y }] };
    }
    case 'seat': {
      const r = L.rooms[place.room];
      if (!r) return null;
      const s = seatPos(r, place.k);
      const dx = r.x + 102;
      // far side: round the table end and along the wall, behind the chairs; near side: along the glass
      const approach = s.top
        ? [{ x: dx, y: Y }, { x: dx, y: 108 }, { x: dx, y: 61 }, { x: s.x, y: 61 }, { x: s.x, y: s.y }]
        : [{ x: dx, y: Y }, { x: dx, y: 108 }, { x: s.x, y: 108 }, { x: s.x, y: s.y }];
      return { x: s.x, y: s.y, approach };
    }
    case 'break': {
      const s = breakSlot(L, place.k);
      const lg = L.lg;
      // down the aisle beside the lounge, then along the clear strip between the machines and the couch
      let approach;
      if (s.kind === 'couch') {
        approach = [{ x: LANE, y: Y }, { x: LANE, y: lg.front }, { x: s.x, y: lg.front }, { x: s.x, y: s.y }];
      } else if (s.y > lg.mid) {
        approach = [{ x: LANE, y: Y }, { x: LANE, y: s.y }, { x: s.x, y: s.y }];
      } else {
        approach = [{ x: LANE, y: Y }, { x: LANE, y: lg.mid }, { x: s.x, y: lg.mid }, { x: s.x, y: s.y }];
      }
      return { x: s.x, y: s.y, approach, kind: s.kind };
    }
    case 'door':
      return { x: L.door.x, y: L.door.y, approach: [{ x: L.door.x, y: Y }, { x: L.door.x, y: L.door.y }] };
    default:
      return null;
  }
}

export function samePlace(a, b) {
  if (!a || !b) return a === b;
  return a.t === b.t && a.i === b.i && a.room === b.room && a.k === b.k && (a.pod || '') === (b.pod || '');
}
