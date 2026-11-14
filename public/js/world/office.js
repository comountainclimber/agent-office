// The living office: state diffing, actors, walking, camera, rendering, picking.
import { K, WHITE, C, toolOf, skyAt } from './palette.js';
import { hash, clamp, makeCanvas, ctx2d, R, box } from './util.js';
import { textWidth, clipText, drawText, SMALL, BIG } from './font.js';
import { makeLook, getSprite, getRing, getHalo, FOOT } from './sprites.js';
import { props } from './props.js';
import { G, ROOMS_X, DESKS_X, computeLayout, packSlots, worldHeight, geom, deskAt, samePlace, breakSlot, seatPos, roomCols, tableRect } from './layout.js';
import { floorTile, outerWallTile, renderStatic, drawWallLife, buildProps, podRect, signSprite, signBottom, brackets, SIGN_BOTTOM, SIGN_H, LOUNGE_SIGN_X } from './scene.js';
import { groupColor, taskName } from '../groups.js';

const SPEED = 68; // walking speed, logical px per second (door to the far corner of a big office: about 8 s)
const QUIET = 180; // seconds of lower demand before the office closes ranks / is drawn bigger again
const CROWDED = 30; // seconds a meeting may stand outside the window before the office is re-planned to show it
const SCALE_FLOOR = 2; // CSS px per logical px: the readable floor
const SCALE_HALF = 1.5; // ...and the half step below it, taken on displays where it is still whole device pixels
const HALF_OVER = 1.15; // the half step is for an office that is at most this much too wide for the window at the floor scale
const SLACK = 2; // a plan is "roomy" when this many more people can sit down without anything having to move
const MAX_ROWS = 5;
const ZOOM_MS = 300; // glide between two scales
const SLIDE = 9; // how fast furniture slides to a new place (1/s)
const NEW_DESK_MS = 240; // a desk that is new in a re-layout appears after the others have slid aside
const POOF_MS = 260; // one desk that changes places within its pod is carried under a small puff of dust
const LANE_BIAS = 5.5; // someone walking past is drawn behind whoever stands or sits within this many px behind the lane
const SLICE = 1 / 30; // the simulation advances in fixed slices of world time, however far apart the frames are
const CATCH_UP = 2.5; // seconds of missed real time replayed in one frame; after a longer gap everyone is simply put in place
const HIDDEN_BEAT = 1500; // ms between repaints while the page reports itself hidden
const OVERLAY_SETTLE = 150; // ms an open overlay must keep its size before the camera follows a resize of it
const PULSE = 1.25; // seconds of one "needs you" pulse: bright then dim yellow, the "!" hopping once, all in step
const MAX_WALK_INS = 6; // more newcomers than this in one update: the rest are simply found at their desks
const FOLLOW = 18; // px two people walking the same way keep between them
const NO_GROUP = ''; // key of the default pod
const UPPER = 64; // height of the wall drawn above the office
const ZERO = Object.freeze({ x: 0, y: 0 });
const NEUTRAL = groupColor(null); // the default pod's sign
const CARPET = { base: '#9692a6', dark: '#84809a', tint: '#a4a0b4' }; // ...and its rug: plain carpet grey

const normInsets = (i) => ({
  top: Math.max(0, +(i && i.top) || 0),
  right: Math.max(0, +(i && i.right) || 0),
  bottom: Math.max(0, +(i && i.bottom) || 0),
  left: Math.max(0, +(i && i.left) || 0),
});

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{insets?: {top?:number,right?:number,bottom?:number,left?:number}}} [opts] CSS px covered by app chrome
 */
export function createOffice(canvas, opts = {}) {
  const P = props();
  const tile = floorTile();
  const out = canvas.getContext('2d');
  const buf = makeCanvas(2, 2);
  const b = ctx2d(buf);
  canvas.style.imageRendering = 'pixelated';
  canvas.style.touchAction = 'none';

  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let still = !!(mq && mq.matches);
  const onMq = () => { still = !!mq.matches; };
  if (mq && mq.addEventListener) mq.addEventListener('change', onMq);

  // ---------------------------------------------------------------- state
  let insets = normInsets(opts.insets);
  // s = scale on screen, base = the scale the office was fitted at (s is one less while a selection needs the room)
  const view = { dpr: 1, sdpr: 0, s: 2, base: 2, vw: 2, vh: 2, ux: 0, uy: 0, uw: 2, uh: 2, devW: 2, devH: 2, uWd: 2, uHd: 2 };
  const cam = { x: 0, y: 0, tx: 0, ty: 0, init: false, sx: 0, sy: 0, tsx: 0, tsy: 0 };
  // the transform of the frame that is on screen right now (picking and locate() use it)
  const drawn = { ok: false, s: 2, x: 0, y: 0, cx: 0, cy: 0 };
  const zoom = { on: false, from: 2, t0: 0, cx: 0, cy: 0 };
  let lowered = false; // one scale step down so the selected character and the top of its zone both fit
  let loweredFor = null; // ...for this selection; it stays down until the selection or the overlay goes
  let overlay = { right: 0, bottom: 0 }; // CSS px of panels that slide over the office without re-fitting it
  let overlayNext = overlay; // what the shell last asked for (applied once it stops changing)
  let overlayTimer = 0;
  let vpKey = ''; // usable area the office was last planned for
  // The floor plan in force: { s, rows, extra, pan, slots: Map(pod key -> slot) }. It is memory: between two
  // re-plans slots only ever grow in place. `why` says what the last re-plan was for.
  let plan = null;
  const why = { rev: 0, cause: 'boot', at: 0 };
  const quiet = { at: 0, cause: '' }; // a re-plan that is waiting for things to stay calm
  let shoved = false; // growInPlace() had to move pods a column aside
  let roamed = false; // the user has moved the camera (only possible while the office is bigger than the window)
  let peakRooms = 0; // most meeting rooms in use at once so far
  const roomGhost = []; // room index -> what its banner showed, while the crew of a finished meeting is still walking out
  let groupsKey = '';
  const panListeners = new Set();
  let panWas = false;
  const poofs = []; // desks being carried: { x0, y0, x1, y1, t0 }
  const deskFrom = new Map(); // 'pod/i' -> the slot that desk had before its pod closed ranks (until the next layout)
  let anim = 0; // ms of real time the frames have covered so far: the clock of every short transition
  const ptr = { x: 0, y: 0, inside: false };
  let L = computeLayout({ rows: 2, slots: [], rooms: 0 });
  let staticLayer = null;
  let outerTile = null;
  let floorPattern = null;
  let skyKey = '';
  let furniture = [];

  const sessions = new Map(); // id -> record
  const actors = new Map(); // id -> actor (sessions and subagents, including ones walking out)
  const groups = new Map(); // id -> { id, name, col, order }
  const pods = new Map(); // key -> { key, owner: [] }   (key = group id, '' = no group; owner[i] = who has desk i)
  const offs = new Map(); // 'pod/i' or 'pod:key' -> {x, y}: how far a desk / a pod's rug still is from its place
  let loungeOff = 0;
  const roomOwner = [];
  const breakOwner = [];
  let booted = false;
  let t = 0; // world clock, seconds
  let timeScale = 1;
  let spawnClock = 0;
  let selected = null;
  let hover = null;
  let hoverSign = null; // pod key under the pointer
  let hoverEdge = 0; // -1 / 1: the pointer is on the "more this way" tab at that side
  let edgeRects = [];
  let hi = null; // highlighted group: null = none, '' = everyone without a group, else a group id
  const listeners = new Set();
  const groupListeners = new Set();
  let placedTags = [];
  let signRects = [];
  let destroyed = false;
  const stats = { ms: 0, max: 0, frames: 0 };

  // ---------------------------------------------------------------- allocation helpers
  const alloc = (arr, id) => {
    let i = arr.findIndex((v) => v == null);
    if (i < 0) i = arr.length;
    arr[i] = id;
    return i;
  };
  const release = (arr, i) => {
    if (i >= 0) arr[i] = null;
    while (arr.length && arr[arr.length - 1] == null) arr.pop();
  };
  const podOf = (key) => {
    let p = pods.get(key);
    if (!p) { p = { key, owner: [] }; pods.set(key, p); }
    return p;
  };
  podOf(NO_GROUP);
  const deskPlace = (rec) => ({ t: 'desk', pod: rec.pod, i: rec.desk });
  const recOf = (a) => (a.kind === 'session' ? sessions.get(a.id) : a.parent) || null;
  const groupColOf = (rec) => {
    const g = rec && rec.pod ? groups.get(rec.pod) : null;
    return g ? g.col : null;
  };

  function newActor(id, kind, tool) {
    return {
      id, kind,
      look: makeLook(id, tool, kind === 'sub' ? 'sub' : 'session'),
      x: L.door.x, y: L.door.y, face: 'F', rx: L.door.x, ry: L.door.y,
      path: [], trail: [], at: null, dest: null, needPlan: false,
      walk: 0, phase: (hash(id) % 997) / 37, spawn: 0, hidden: false, snap: false, leaving: false, gone: false, lane: 0, pace: 1,
      data: null, parent: null, v: null,
    };
  }

  function spawnAtDoor(a) {
    // far enough apart that name tags do not ride on each other, uneven enough that it is not a parade
    const r = (hash(`${a.id}/${Math.floor(t)}`) % 1000) / 1000;
    spawnClock = Math.max(t, spawnClock) + 0.55 + r * 0.9;
    a.spawn = spawnClock - t;
    a.hidden = true;
    a.x = L.door.x;
    a.y = L.door.y;
    a.at = null;
    a.trail = [];
  }

  function send(a, place) {
    if (samePlace(a.dest, place)) return;
    a.dest = place;
    a.needPlan = true;
  }

  function leave(a) {
    if (a.snap || a.hidden) { actors.delete(a.id); return; }
    a.leaving = true;
    send(a, { t: 'door' });
  }

  function snapTo(a, place) {
    const g = geom(L, place);
    if (!g) return;
    a.x = g.x; a.y = g.y;
    a.at = place; a.dest = place;
    a.path = []; a.trail = [];
    a.needPlan = false; a.snap = false; a.hidden = false; a.spawn = 0;
    wearRole(a);
  }

  /** An orchestrator only looks like the boss once it is standing at its whiteboard. */
  function wearRole(a) {
    if (a.kind !== 'session') return;
    const role = a.at && a.at.t === 'boss' ? 'boss' : 'session';
    if (a.look.role !== role) a.look = makeLook(a.id, a.data ? a.data.tool : a.look.tool, role);
  }

  // ---------------------------------------------------------------- setState
  /** Newcomers walk in from the door, a few at a time; a crowd is simply found in place. */
  function enter(a, arrivals) {
    if (arrivals.instant || arrivals.n >= MAX_WALK_INS) { a.snap = true; return; }
    arrivals.n++;
    spawnAtDoor(a);
  }

  function syncSubs(rec, subs, arrivals) {
    const ids = new Set();
    for (const sub of subs) if (sub && sub.id != null) ids.add(String(sub.id));
    for (const [sid, e] of rec.subs) {
      if (ids.has(sid)) continue;
      rec.seats[e.seat] = null;
      rec.subs.delete(sid);
      leave(e.actor);
    }
    const seen = new Set();
    let overflow = 0;
    for (const sub of subs) {
      if (!sub || sub.id == null) continue;
      const sid = String(sub.id);
      if (seen.has(sid)) continue;
      seen.add(sid);
      let e = rec.subs.get(sid);
      if (!e) {
        const k = rec.seats.indexOf(null);
        if (k < 0) { overflow++; continue; }
        rec.seats[k] = sid;
        const aid = `${rec.id}#${sid}`;
        let a = actors.get(aid);
        if (a) { a.leaving = false; } else {
          a = newActor(aid, 'sub', rec.data.tool);
          actors.set(aid, a);
          enter(a, arrivals);
        }
        a.parent = rec;
        e = { seat: k, actor: a };
        rec.subs.set(sid, e);
        send(a, { t: 'seat', room: rec.room, k });
      }
      e.actor.data = sub;
    }
    rec.overflow = overflow;
    syncRoomCols(rec);
  }

  /** The table is as long as the far side needs; when that changes, whoever is seated shuffles along. */
  function syncRoomCols(rec, quiet = false) {
    const room = rec.room >= 0 ? L.rooms[rec.room] : null;
    if (!room) return;
    let top = -1;
    for (let k = 0; k < rec.seats.length; k++) if (rec.seats[k] != null) top = k;
    const cols = roomCols(Math.min(4, top + 1));
    if (cols === room.cols) return;
    room.cols = cols;
    if (quiet) return; // a fresh layout: whoever is seated is put on the right chair by the caller
    for (const e of rec.subs.values()) {
      const a = e.actor;
      if (a.snap || a.hidden || !a.at || a.at.t !== 'seat' || a.path.length) continue;
      const s = seatPos(room, e.seat);
      a.path = [{ x: s.x, y: s.y }];
    }
  }

  function dismissSubs(rec) {
    for (const e of rec.subs.values()) leave(e.actor);
    rec.subs.clear();
    rec.seats.fill(null);
    rec.overflow = 0;
  }

  /** Take over the group list. Returns true when the groups themselves (which there are, their order) changed. */
  function syncGroups(list) {
    groups.clear();
    if (Array.isArray(list)) list.forEach((g, i) => {
      if (!g || g.id == null || g.id === '') return;
      groups.set(String(g.id), {
        id: String(g.id),
        name: String(g.name || 'GROUP'),
        col: groupColor(g.color),
        order: Number.isFinite(+g.order) ? +g.order : i,
        seq: i,
      });
    });
    const key = [...groups.values()].map((g) => `${g.id}:${g.order}`).join('|');
    const changed = booted && key !== groupsKey;
    groupsKey = key;
    return changed;
  }
  const groupKeyOf = (s) => (s.groupId != null && groups.has(String(s.groupId)) ? String(s.groupId) : NO_GROUP);

  function setState(state) {
    if (destroyed || !state || !Array.isArray(state.sessions)) return;
    const instant = !booted;
    const arrivals = { instant, n: 0 };
    let news = false; // someone came, went, moved or changed status: worth a repaint even in a hidden tab
    let grouped = syncGroups(state.groups); // the user changed something about groups: the one thing that may re-plan freely
    let grew = false; // someone new sat down somewhere
    // departures first, so the desks and rooms they free can be reused by arrivals in the same snapshot
    const ids = new Set();
    for (const s of state.sessions) if (s && s.id) ids.add(s.id);
    for (const [id, rec] of sessions) {
      if (ids.has(id)) continue;
      freeRoom(rec);
      dismissSubs(rec);
      release(podOf(rec.pod).owner, rec.desk);
      if (rec.brk >= 0) release(breakOwner, rec.brk);
      sessions.delete(id);
      leave(rec.actor);
      news = true;
    }
    const seen = new Set();
    for (const s of state.sessions) {
      if (!s || !s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      const gkey = groupKeyOf(s);
      let rec = sessions.get(s.id);
      if (!rec) {
        rec = { id: s.id, data: s, pod: gkey, desk: alloc(podOf(gkey).owner, s.id), zone: null, room: -1, brk: -1, seats: new Array(G.SEATS).fill(null), subs: new Map(), overflow: 0, actor: null, seed: hash(s.id) };
        sessions.set(s.id, rec);
        let a = actors.get(s.id);
        if (a) { a.leaving = false; } else {
          a = newActor(s.id, 'session', s.tool);
          actors.set(s.id, a);
          enter(a, arrivals);
        }
        rec.actor = a;
        news = true;
        grew = true;
      } else if (rec.pod !== gkey) {
        news = true;
        grouped = true;
        // moved to another group: a desk in that pod, and a walk over there (no teleport)
        release(podOf(rec.pod).owner, rec.desk);
        rec.pod = gkey;
        rec.desk = alloc(podOf(gkey).owner, s.id);
        if (rec.zone === 'desk') send(rec.actor, deskPlace(rec));
      }
      if (rec.data.status !== s.status || rec.data.mode !== s.mode || !!rec.data.unanswered !== !!s.unanswered) news = true;
      rec.data = s;
      rec.actor.data = s;
      const zone = s.mode === 'orchestrator' ? 'room' : s.status === 'idle' ? 'break' : 'desk';
      if (zone !== rec.zone) {
        if (rec.zone === 'room') { freeRoom(rec); dismissSubs(rec); }
        if (rec.zone === 'break') { release(breakOwner, rec.brk); rec.brk = -1; }
        rec.zone = zone;
        if (zone === 'room') rec.room = allocRoom(s.id);
        if (zone === 'break') rec.brk = alloc(breakOwner, s.id);
        if (zone !== 'room' && rec.actor.look.role !== 'session') rec.actor.look = makeLook(s.id, s.tool, 'session');
        send(rec.actor, zone === 'room' ? { t: 'boss', room: rec.room } : zone === 'break' ? { t: 'break', k: rec.brk } : deskPlace(rec));
      }
      if (zone === 'room') syncSubs(rec, Array.isArray(s.subagents) ? s.subagents : [], arrivals);
    }
    if (seen.size) booted = true;

    // The floor plan is memory. Arrivals, departures, meetings and status changes only ever use space that
    // is already there (a free desk, the floor below a short pod or right of the last one, a free room).
    // Everything is planned afresh only on the first state, when the user changes groups, when the window
    // changes (fit), when someone cannot be seated otherwise, and after quiet minutes of lower demand.
    const rev = why.rev;
    if (instant || !plan) replan('first');
    else if (grouped) replan('group');
    else if (!growInPlace()) replan('overflow');
    else {
      if (shoved) { why.rev++; why.cause = 'overflow'; why.at = t; }
      relayout();
    }
    if (!instant) tidy(grew);
    const planned = rev !== why.rev;
    for (const rec of sessions.values()) if (rec.zone === 'room') syncRoomCols(rec);

    for (const a of actors.values()) if (a.snap && a.dest) snapTo(a, a.dest);
    // never wait for an animation frame to show a new state: a page that is not in front gets few or none.
    // (A hidden page repaints on news and on its slow heartbeat: nobody can see a walk there.)
    if (instant) tick();
    else if (document.hidden) { if (news || planned) poke(); }
    else if (performance.now() - lastPaint > 120) tick();
    wake();
  }

  /**
   * Close the gaps in a pod: owners keep their order and move up to the first free desks. `deskFrom`
   * remembers where each such desk was, so the next re-layout carries it over (sitter and all) instead of
   * making a new one. Returns true when someone's desk changed.
   */
  function compactPod(p) {
    if (!p.owner.includes(null)) return false;
    let moved = false;
    const ids = p.owner.filter((id) => id != null);
    p.owner.length = 0;
    ids.forEach((id, ni) => {
      p.owner[ni] = id;
      const rec = sessions.get(id);
      if (!rec || rec.desk === ni) return;
      deskFrom.set(`${p.key}/${ni}`, rec.desk);
      rec.desk = ni;
      moved = true;
      const a = rec.actor;
      for (const pl of [a.at, a.dest]) if (pl && pl.t === 'desk' && (pl.pod || '') === p.key) pl.i = ni;
      if (a.path.length) { a.needPlan = true; a.at = null; a.trail = []; a.path = []; }
    });
    return moved;
  }
  function compactPods() {
    let moved = false;
    for (const p of pods.values()) if (compactPod(p)) moved = true;
    return moved;
  }

  /** Whether a transition can be watched at all: otherwise things are simply put where they belong. */
  const animating = () => booted && !still && drawn.ok && !document.hidden;

  // ---------------------------------------------------------------- meeting rooms
  /** A room for a new meeting: a free one whose last crew has left for good, if there is one. */
  function allocRoom(id) {
    let i = roomOwner.findIndex((v, k) => v == null && !roomGhost[k]);
    if (i < 0) i = roomOwner.findIndex((v) => v == null);
    if (i < 0) i = roomOwner.length;
    roomOwner[i] = id;
    roomGhost[i] = null;
    if (roomOwner.length > peakRooms) peakRooms = roomOwner.length;
    return i;
  }
  /**
   * The meeting is over. The room is free for the next one at once, but its banner keeps saying whose it
   * was until the last of the crew has walked out of the door (see roomInfo): a room full of people that
   * says FREE reads as a mistake.
   */
  function freeRoom(rec) {
    const i = rec.room;
    if (i < 0) return;
    const info = animating() ? roomInfo(i) : null;
    if (info) {
      const crew = [rec.actor];
      for (const e of rec.subs.values()) crew.push(e.actor);
      roomGhost[i] = { crew, info: { ...info, seats: info.seats.map((s) => s && { status: s.status, seated: false }), waiting: false, quiet: false, sel: false, hot: false, ghost: true } };
    }
    release(roomOwner, i);
    rec.room = -1;
  }
  /**
   * Rooms along the wall: every meeting that is on, plus the free rooms of earlier ones (the most there were
   * at once this session) as far as the window is wide. Free rooms never make the office wider than the window.
   */
  function roomsShown() {
    const fitR = Math.floor((view.uWd / plan.s + 1 - ROOMS_X) / G.ROOM);
    let n = Math.max(roomOwner.length, Math.min(peakRooms, fitR));
    for (let i = roomGhost.length - 1; i >= n; i--) if (roomGhost[i]) { n = i + 1; break; }
    return n;
  }
  /**
   * Close the gaps left by finished meetings (only ever as part of a re-plan).
   * @returns {{i:number, dx:number}[]|null} the rooms that moved: new index and how far (world px) they came
   */
  function compactRooms() {
    if (!roomOwner.includes(null)) return null;
    const moves = [];
    const ids = roomOwner.filter((id) => id != null);
    roomOwner.length = 0;
    roomGhost.length = 0;
    ids.forEach((id, ni) => {
      roomOwner[ni] = id;
      const rec = sessions.get(id);
      if (!rec || rec.room === ni) return;
      moves.push({ i: ni, dx: (rec.room - ni) * G.ROOM });
      rec.room = ni;
      const move = (a) => {
        for (const pl of [a.at, a.dest]) if (pl && (pl.t === 'boss' || pl.t === 'seat')) pl.room = ni;
        if (a.path.length) { a.needPlan = true; a.at = null; a.trail = []; a.path = []; }
      };
      move(rec.actor);
      for (const e of rec.subs.values()) move(e.actor);
    });
    return moves;
  }

  // ---------------------------------------------------------------- the floor plan
  const members = (p) => { let n = 0; if (p) for (const id of p.owner) if (id != null) n++; return n; };

  /** The pods that have to stand somewhere, in display order: groups by their order, then the default pod. */
  function demand(compact = false) {
    const count = (p) => (compact ? members(p) : p.owner.length);
    const list = [];
    for (const [key, p] of pods) {
      if (key === NO_GROUP || !count(p)) continue;
      const g = groups.get(key);
      list.push({ key, need: count(p), min: 1, order: g ? g.order : 1e9, seq: g ? g.seq : 1e9 });
    }
    list.sort((p, q) => p.order - q.order || p.seq - q.seq || (p.key < q.key ? -1 : 1));
    const d = pods.get(NO_GROUP);
    if (!list.length) list.push({ key: NO_GROUP, need: count(d), min: G.MIN_COLS });
    else if (count(d)) list.push({ key: NO_GROUP, need: count(d), min: 1 });
    // a block that was laid out more than one column wide keeps its rows as they are (packSlots): its desks
    // keep their places among themselves when the pod has to move
    if (plan) for (const it of list) { const sl = plan.slots.get(it.key); if (sl && sl.c0 > 1) it.shape = sl; }
    return list;
  }

  /**
   * How many more people without a group could sit down with nothing having to move: free cells in the
   * default pod's block, the floor below it, and whole columns of floor right of the last pod.
   */
  function slackOf(slots, rows, extra, uw, needOf) {
    let right = DESKS_X;
    for (const sl of slots) right = Math.max(right, sl.x + sl.cols * G.CELL);
    const freeW = uw - 2 - right;
    const d = slots.find((sl) => sl.key === NO_GROUP);
    if (!d) return Math.max(0, Math.floor((freeW - G.POD_GAP) / G.CELL)) * rows;
    let n = d.cols * d.ph - (needOf.get(NO_GROUP) || 0);
    if (d.cols === 1 && d.c0 === 1 && !slots.some((o) => o !== d && o.x === d.x && o.y > d.y)) n += Math.floor((G.BULL + rows * G.ROW + extra - (d.y + d.ph * G.ROW)) / G.ROW);
    if (d.x + d.cols * G.CELL >= right - 0.5) n += Math.max(0, Math.floor(freeW / G.CELL)) * d.ph;
    return n;
  }

  /**
   * Plan the office from scratch for the window as measured: the scale, the number of desk rows and a slot
   * for every pod. Order of preference:
   *   1. the biggest scale (whole device pixels, at most 4 CSS px per art pixel, at least SCALE_FLOOR) at which
   *      some arrangement fits AND is roomy: the next couple of arrivals find a place without anything moving;
   *   2. the half step below the floor, when the office is only a little too wide for the window at the floor;
   *   3. the biggest scale at which anything fits at all (the next arrival will mean a re-plan);
   *   4. the floor scale with the narrowest arrangement, and the office scrolls sideways (`pan`).
   * Among arrangements at one scale: room to grow first, then a spare desk in every pod, then what we have
   * now (same rows, pods keeping their shape), then more rows (the office fills the height of the window and
   * stays narrow, which leaves the floor on the right to grow into).
   */
  function freshPlan(dem, nRooms, hold = 0) {
    const uW = view.uWd;
    const uH = view.uHd;
    const dpr = view.dpr;
    const sMax = Math.max(2, Math.floor(dpr * 4));
    const sFloor = Math.max(1, Math.ceil(dpr * SCALE_FLOOR - 1e-6));
    const sHalf = Math.max(1, Math.ceil(dpr * SCALE_HALF - 1e-6));
    const roomsW = ROOMS_X + Math.max(G.MIN_ROOMS, nRooms) * G.ROOM;
    const hinted = dem.some((d) => d.shape);
    const needOf = new Map(dem.map((d) => [d.key, d.need]));
    const at = (s) => {
      const uw = uW / s;
      const uh = uH / s;
      const out = [];
      for (let rows = 2; rows <= MAX_ROWS; rows++) {
        for (const extra of [0, G.HEAD]) {
          const tall = worldHeight(rows, extra) > uh + 0.01;
          if (tall && (rows > 2 || extra)) continue; // (two rows are the least there is: kept for the scrolling fallback)
          for (const spare of [1, 0]) {
            for (const keep of hinted ? [1, 0] : [0]) {
              const pk = packSlots(rows, extra, dem.map((d) => ({ key: d.key, cap: Math.max(d.need + spare, d.min > 1 ? 2 : 1), min: d.min, shape: keep ? d.shape : null })));
              const W = Math.max(pk.right + G.RPAD, roomsW);
              const fits = !tall && W <= uw + 1;
              const slack = fits ? slackOf(pk.slots, rows, extra, uw, needOf) : 0;
              const same = plan && rows === plan.rows && extra === plan.extra ? 1 : 0;
              out.push({
                s, rows, extra, slots: pk.slots, right: pk.right, W, tall, fits, slack, roomy: fits && slack >= SLACK,
                score: Math.min(slack, 6) * 5 + spare * 8 + same * 10 + keep * 12 + rows * 2 - (extra ? 1 : 0),
              });
            }
          }
        }
      }
      return out;
    };
    const best = (list) => list.reduce((a, c) => (!a || c.score > a.score ? c : a), null);
    let pick = null;
    let top = sMax;
    if (hold) {
      // a re-plan in the middle of things keeps the scale it has as long as anything fits at it, and never
      // takes a bigger one (the office only grows back after quiet minutes: see tidy)
      const here = at(hold);
      pick = best(here.filter((c) => c.roomy)) || best(here.filter((c) => c.fits));
      top = Math.min(sMax, hold - 1);
    }
    for (let s = top; s >= sFloor && !pick; s--) pick = best(at(s).filter((c) => c.roomy));
    if (!pick && sHalf < sFloor) {
      // how much too wide the office is at the floor scale, counting one more column for it to be roomy
      const uw = uW / sFloor;
      let over = Infinity;
      for (const c of at(sFloor)) if (!c.tall) over = Math.min(over, (c.fits ? Math.max(c.right + G.CELL + G.RPAD, roomsW) : c.W) / uw);
      if (over <= HALF_OVER) { const half = at(sHalf); pick = best(half.filter((c) => c.roomy)) || best(half.filter((c) => c.fits)); }
    }
    for (let s = top; s >= sFloor && !pick; s--) pick = best(at(s).filter((c) => c.fits));
    if (pick) return { ...pick, pan: false };
    // too busy to fit at a readable size: stay at the floor scale and scroll sideways, with the narrowest
    // office (but not a different arrangement for the sake of a column or two)
    let s = sFloor;
    while (s > 1 && worldHeight(2) * s > uH) s--;
    let narrow = null;
    for (const c of at(s)) {
      c.cost = c.W - c.score * 8;
      if (!narrow || c.cost < narrow.cost) narrow = c;
    }
    return { ...narrow, pan: true };
  }

  /**
   * Seat today's people in the slots there are: a pod that is gone gives its slot back (nobody else moves),
   * a pod that needs more desks takes the floor below it (one column) or a column to its right, a new pod
   * goes right of the last one or under a short one. Returns false when someone cannot be seated like that.
   */
  function growInPlace() {
    shoved = false;
    const dem = demand();
    const want = new Set(dem.map((d) => d.key));
    for (const key of [...plan.slots.keys()]) if (!want.has(key)) plan.slots.delete(key);
    const floor = G.BULL + plan.rows * G.ROW + plan.extra;
    const limit = plan.pan ? Infinity : view.uWd / plan.s - 2;
    const taken = (self, x0, x1, y0, y1) => {
      for (const o of plan.slots.values()) {
        if (o === self) continue;
        if (x0 < o.x + o.cols * G.CELL + G.POD_GAP && x1 + G.POD_GAP > o.x && y0 < o.y + o.ph * G.ROW && y1 > o.y - (o.under ? G.HEAD : 0)) return true;
      }
      return false;
    };
    const canDown = (sl) => sl.cols === 1 && sl.c0 === 1 && sl.y + (sl.ph + 1) * G.ROW <= floor && !taken(sl, sl.x, sl.x + G.CELL, sl.y + sl.ph * G.ROW, sl.y + (sl.ph + 1) * G.ROW);
    const canRight = (sl) => sl.x + (sl.cols + 1) * G.CELL <= limit && !taken(sl, sl.x + sl.cols * G.CELL, sl.x + (sl.cols + 1) * G.CELL, sl.y, sl.y + sl.ph * G.ROW);
    // no floor beside a pod that needs another column: everything right of it steps one column aside, as it
    // is (the least that can move), if the window is wide enough for that
    const push = (sl) => {
      const edge = sl.x + sl.cols * G.CELL;
      let right = edge;
      for (const o of plan.slots.values()) right = Math.max(right, o.x + o.cols * G.CELL);
      if (right + G.CELL > limit) return false;
      for (const o of plan.slots.values()) if (o !== sl && o.x >= edge) o.x += G.CELL;
      shoved = true;
      return true;
    };
    const place = (d) => {
      let right = DESKS_X - G.POD_GAP;
      for (const o of plan.slots.values()) right = Math.max(right, o.x + o.cols * G.CELL);
      const x = right + G.POD_GAP;
      for (const cap of [d.need + 1, d.need]) {
        const c0 = Math.max(d.min || 1, Math.ceil(cap / plan.rows));
        if (x + c0 * G.CELL <= limit) return { key: d.key, x, y: G.BULL, c0, cols: c0, ph: c0 === 1 && cap <= plan.rows ? cap : plan.rows, under: false };
      }
      if (d.need > plan.rows) return null;
      for (const o of plan.slots.values()) {
        if (o.cols !== 1) continue;
        let bottom = 0;
        for (const q of plan.slots.values()) if (q.x === o.x) bottom = Math.max(bottom, q.y + q.ph * G.ROW);
        const y = bottom + G.HEAD;
        if (y + d.need * G.ROW <= floor && !taken(null, o.x, o.x + G.CELL, bottom + 1, y + d.need * G.ROW)) return { key: d.key, x: o.x, y, c0: 1, cols: 1, ph: d.need, under: true };
      }
      return null;
    };
    for (const d of dem) {
      let sl = plan.slots.get(d.key);
      if (!sl) {
        sl = place(d);
        if (!sl) return false;
        plan.slots.set(d.key, sl);
      }
      while (sl.cols * sl.ph < d.need) {
        if (canDown(sl)) sl.ph++;
        else if (canRight(sl)) sl.cols++;
        else if (push(sl)) sl.cols++;
        else return false;
      }
      // one spare desk where it costs nothing: the floor right below a one-column pod
      if (sl.cols * sl.ph < d.need + 1 && canDown(sl)) sl.ph++;
    }
    return true;
  }

  /**
   * Which desks of a slot are furnished: everybody's own, plus the lowest free ones: one spare normally,
   * two when someone left a gap (the gap and the next new desk). The rest of the block is just floor.
   */
  function maskOf(sl) {
    const p = pods.get(sl.key);
    const own = p ? p.owner : [];
    const cells = sl.cols * sl.ph;
    const mask = new Array(cells).fill(false);
    const free = [];
    let n = 0;
    for (let i = 0; i < cells; i++) {
      if (own[i] != null) { mask[i] = true; n++; } else free.push(i);
    }
    let spares = own.includes(null) ? 2 : 1;
    if (sl.key === NO_GROUP && plan.slots.size === 1) spares = Math.max(spares, 2 - n); // an empty office still has two desks
    for (let k = 0; k < spares && k < free.length; k++) mask[free[k]] = true;
    return mask;
  }

  /**
   * Plan the whole office afresh and go there in one move. cause: 'first' (the first people), 'viewport'
   * (window / chrome / display changed), 'group' (the user changed groups), 'overflow' (someone could not be
   * seated in place, or a meeting stood outside the window for a while), 'quiet' (minutes of lower demand).
   */
  function replan(cause) {
    let roomMoves = null;
    let keep = false;
    const uW = view.uWd;
    const sFloor = Math.max(1, Math.ceil(view.dpr * SCALE_FLOOR - 1e-6));
    const sHalf = Math.max(1, Math.ceil(view.dpr * SCALE_HALF - 1e-6));
    const rightOf = (slots) => { let r = DESKS_X; for (const sl of slots.values()) r = Math.max(r, sl.x + sl.cols * G.CELL); return r; };
    const roomsW = () => ROOMS_X + roomOwner.length * G.ROOM;
    if (cause === 'overflow' && plan && !plan.pan) {
      // Someone cannot be seated (or a meeting stands outside the window) at this scale. Slots are memory:
      // before anything is re-arranged, try the furniture exactly as it stands one scale step smaller, then
      // another, down to the floor (and the half step below it, under the same rule as in freshPlan). When
      // that works only the scale changes: everything keeps its place in the office.
      const was = plan;
      for (let s2 = was.s - 1; s2 >= Math.min(sFloor, sHalf) && !keep; s2--) {
        plan = { ...was, s: s2, slots: new Map([...was.slots].map(([k, sl]) => [k, { ...sl }])) };
        if (!growInPlace() || roomsW() > uW / s2 + 1) continue;
        if (s2 < sFloor && Math.max(rightOf(plan.slots) + G.RPAD, roomsW()) / (uW / sFloor) > HALF_OVER) continue;
        keep = true;
      }
      if (!keep) plan = was;
    }
    if (!keep) {
      // in the middle of things the scale is held (see freshPlan); the first plan, a new window and the quiet
      // tidy-up choose it freely
      const hold = plan && (cause === 'group' || cause === 'overflow') ? plan.s : 0;
      let pick = freshPlan(demand(), roomOwner.length, hold);
      if (roomOwner.includes(null)) {
        // free rooms between busy ones are kept (rooms are memory too) unless closing them up shows more
        const loose = freshPlan(demand(), roomOwner.filter((id) => id != null).length, hold);
        if (loose.s > pick.s || (pick.pan && !loose.pan)) { roomMoves = compactRooms(); pick = loose; }
      }
      if (pick.pan && cause !== 'first' && compactPods()) pick = freshPlan(demand(), roomOwner.length, hold);
      if (cause === 'viewport' && plan && !pick.pan && plan.slots.size) {
        // a new window size: when the furniture can stay exactly as it is at the scale we would pick anyway, it stays
        const uw = uW / pick.s;
        const fits = worldHeight(plan.rows, plan.extra) <= view.uHd / pick.s + 0.01 && Math.max(rightOf(plan.slots) + G.RPAD, roomsW()) <= uw + 1;
        const needOf = new Map([[NO_GROUP, pods.get(NO_GROUP).owner.length]]);
        keep = fits && (!pick.roomy || slackOf([...plan.slots.values()], plan.rows, plan.extra, uw, needOf) >= SLACK);
        if (keep) plan = { ...plan, s: pick.s, pan: false };
      }
      if (!keep) plan = { s: pick.s, rows: pick.rows, extra: pick.extra, pan: pick.pan, slots: new Map(pick.slots.map((sl) => [sl.key, sl])) };
    }
    growInPlace(); // (the spare desks that cost nothing)
    why.rev++;
    why.cause = cause;
    why.at = t;
    quiet.at = 0;
    const scaleChanged = applyScale();
    relayout(roomMoves, scaleChanged);
  }

  /**
   * After a while of lower demand the office closes ranks: desks nobody has any more go, the gaps close, and
   * it is drawn bigger again if it now can be. Only when that has been true, without a break and without
   * anybody new arriving, for QUIET seconds. (A meeting that stands outside the window is the opposite case:
   * if a re-plan would show it, that happens after CROWDED seconds.)
   */
  function tidy(grew) {
    if (grew) quiet.at = 0;
    const f = freshPlan(demand(true), roomOwner.filter((id) => id != null).length);
    const panNow = L.W > view.uWd / plan.s + 2;
    let cause = '';
    if (panNow && !f.pan && f.s <= plan.s) cause = 'overflow';
    else if ((f.s > plan.s && f.roomy) || (panNow && !f.pan) || (!f.pan && f.rows === plan.rows && f.extra === plan.extra && f.right <= L.bullRight - G.CELL)) cause = 'quiet';
    if (!cause) { quiet.at = 0; return; }
    if (!quiet.at || quiet.cause !== cause) { quiet.at = t + (cause === 'overflow' ? CROWDED : QUIET); quiet.cause = cause; return; }
    if (t < quiet.at) return;
    if (cause === 'quiet') compactPods();
    replan(cause);
  }

  // ---------------------------------------------------------------- layout + camera
  function rebuildScene() {
    const now = new Date();
    const sky = skyAt(now.getHours() + now.getMinutes() / 60);
    skyKey = sky.key;
    staticLayer = renderStatic(L, sky, tile);
    outerTile = outerWallTile(sky);
    furniture = buildProps(L);
    floorPattern = b.createPattern(tile, 'repeat');
  }

  function camBounds() {
    const pad = 6;
    const { ux, uy, uw, uh } = view;
    let minX; let maxX; let minY; let maxY;
    // The office runs from one edge of the usable area to the other, so its corner is the corner of that area
    // whatever stands in it. (Only when it is drawn a step smaller for a selection is it narrower: centred then.)
    if (L.W <= uw + 2) minX = maxX = -(ux + Math.max(0, (uw - L.W) / 2));
    else { minX = -ux - pad; maxX = L.W + pad - ux - uw; }
    // spare height goes below the office (more floor), never to a tall dark band above the wall
    if (L.H <= uh) minY = maxY = -(uy + Math.min(30, Math.floor((uh - L.H) * 0.3)));
    else { minY = -uy - pad; maxY = L.H + pad - uy - uh; }
    return { minX, maxX, minY, maxY, panX: maxX > minX + 0.5, panY: maxY > minY + 0.5 };
  }

  function clampCam(hard) {
    const bd = camBounds();
    cam.tx = clamp(cam.tx, bd.minX, bd.maxX);
    cam.ty = clamp(cam.ty, bd.minY, bd.maxY);
    if (hard || !cam.init) { cam.x = cam.tx; cam.y = cam.ty; cam.init = true; }
    else { cam.x = clamp(cam.x, bd.minX - 40, bd.maxX + 40); cam.y = clamp(cam.y, bd.minY - 40, bd.maxY + 40); }
    const pan = bd.panX || bd.panY;
    if (pan !== panWas) {
      panWas = pan;
      for (const fn of panListeners) { try { fn(pan); } catch (err) { console.error('[office] onPanChange listener failed', err); } }
    }
    return bd;
  }

  /**
   * Furniture that keeps its identity across a re-plan glides from where it was to where it now belongs:
   * a pod as one block (rug, sign, desks and whoever sits there), desks that change places within their pod
   * each on their own. When it is a single desk that changes places (someone left a gap and the ranks close)
   * it is carried under a small puff of dust instead of sliding across its neighbours.
   */
  function carryOffsets(old) {
    const next = new Map();
    const now = anim;
    poofs.length = 0;
    const at = (id) => { const o = offs.get(id); return o && !o.hide && !o.hold ? o : ZERO; };
    for (const pod of L.pods) {
      const op = old.podMap.get(pod.key);
      if (!op) {
        // a new pod is laid out once the others have slid aside
        next.set(`pod:${pod.key}`, { x: 0, y: 0, hide: now + NEW_DESK_MS });
        for (const d of pod.desks) if (d.shown) next.set(d.id, { x: 0, y: 0, hide: now + NEW_DESK_MS });
        continue;
      }
      const cur = at(`pod:${pod.key}`);
      const px = op.x + cur.x - pod.x;
      const py = op.y + cur.y - pod.y;
      if (Math.abs(px) > 0.5 || Math.abs(py) > 0.5) next.set(`pod:${pod.key}`, { x: px, y: py });
      const odd = [];
      for (const d of pod.desks) {
        if (!d.shown) continue;
        const od = op.desks[deskFrom.has(d.id) ? deskFrom.get(d.id) : d.i];
        // a desk that was not there before is put down once its neighbours have slid out of the way
        if (!od || !od.shown) { next.set(d.id, { x: 0, y: 0, hide: now + NEW_DESK_MS }); continue; }
        const c = at(od.id);
        const m = { d, x: od.cx + c.x - d.cx, y: od.cy + c.y - d.cy };
        if (Math.abs(m.x) < 0.5 && Math.abs(m.y) < 0.5) continue;
        if (Math.abs(m.x - px) > 0.5 || Math.abs(m.y - py) > 0.5) odd.push(m);
        else next.set(d.id, { x: m.x, y: m.y });
      }
      if (odd.length === 1) {
        const m = odd[0];
        next.set(m.d.id, { x: m.x, y: m.y, hold: now + POOF_MS / 2 });
        poofs.push({ x0: m.d.cx + m.x, y0: m.d.cy + m.y, x1: m.d.cx, y1: m.d.cy, t0: now });
      } else for (const m of odd) next.set(m.d.id, { x: m.x, y: m.y });
    }
    offs.clear();
    for (const [k, v] of next) offs.set(k, v);
    loungeOff += old.lg.couchY - L.lg.couchY;
  }

  /** Measure the canvas and the area the chrome leaves free. `changed`: that area (or the display) is another one. */
  function measure() {
    // layout size, not getBoundingClientRect(): a CSS transform on the canvas must not change the fit
    const cssW = Math.max(1, canvas.clientWidth || 300);
    const cssH = Math.max(1, canvas.clientHeight || 150);
    const dpr = window.devicePixelRatio || 1;
    const devW = Math.max(1, Math.round(cssW * dpr));
    const devH = Math.max(1, Math.round(cssH * dpr));
    let cleared = false;
    if (canvas.width !== devW) { canvas.width = devW; cleared = true; }
    if (canvas.height !== devH) { canvas.height = devH; cleared = true; }
    const uW = Math.max(60, (cssW - insets.left - insets.right) * dpr);
    const uH = Math.max(60, (cssH - insets.top - insets.bottom) * dpr);
    const key = `${uW}|${uH}|${dpr}`;
    const changed = key !== vpKey;
    vpKey = key;
    view.dpr = dpr; view.devW = devW; view.devH = devH; view.uWd = uW; view.uHd = uH;
    return { changed, cleared };
  }

  /** Put the plan's scale (one step less while a selection needs the room) on screen. Returns true when it changed. */
  function applyScale() {
    const dpr = view.dpr;
    const base = plan.s;
    const s = lowered ? Math.max(1, base - 1) : base;
    const scaleChanged = s !== view.s || dpr !== view.sdpr;
    // a new scale is reached in a short glide from whatever is on screen now
    if (scaleChanged && drawn.ok && booted && !still && !document.hidden && dpr === view.sdpr) {
      zoom.on = true; zoom.from = drawn.s; zoom.t0 = anim; zoom.cx = drawn.cx; zoom.cy = drawn.cy;
    } else if (scaleChanged) zoom.on = false;
    view.s = s; view.base = base; view.sdpr = dpr;
    view.vw = Math.ceil(view.devW / s); view.vh = Math.ceil(view.devH / s);
    view.ux = (insets.left * dpr) / s; view.uy = (insets.top * dpr) / s;
    view.uw = view.uWd / s; view.uh = view.uHd / s;
    return scaleChanged;
  }

  /** Build the geometry for the plan as it stands (slots, furnished desks, rooms) and take it over if it differs. */
  function relayout(roomMoves = null, hard = false) {
    const slots = [...plan.slots.values()].sort((p, q) => p.x - q.x || p.y - q.y).map((sl) => ({ ...sl, mask: maskOf(sl) }));
    const nl = computeLayout({ rows: plan.rows, extra: plan.extra, slots, rooms: roomsShown(), minW: plan.pan ? 0 : Math.ceil(view.uWd / plan.s) + 1 });
    const changed = nl.key !== L.key || !staticLayer || deskFrom.size > 0; // (desks that closed ranks need carrying even if nothing else moved)
    if (changed) {
      const old = staticLayer ? L : null;
      L = nl;
      if (old && animating()) carryOffsets(old);
      else { offs.clear(); poofs.length = 0; loungeOff = 0; }
      deskFrom.clear();
      rebuildScene();
      // rooms that closed ranks slide over from where they were (the people in them ride along)
      if (roomMoves && animating()) for (const m of roomMoves) offs.set(`room:${m.i}`, { x: m.dx, y: 0 });
      for (const rec of sessions.values()) if (rec.zone === 'room') syncRoomCols(rec, true);
      for (const a of actors.values()) {
        if (a.snap || a.hidden) continue;
        if (a.at && !a.path.length && !a.needPlan) snapTo(a, a.at); // furniture moved: move with it
        else if (a.dest) { a.needPlan = true; a.trail = []; a.at = null; }
      }
    }
    if (!floorPattern) floorPattern = b.createPattern(tile, 'repeat');
    // Home: the office's corner in the corner of the usable area. The camera is only somewhere else when the
    // office is bigger than the window AND the user has moved it (drag, wheel, keys, a jump to someone).
    const bd = camBounds();
    if (!bd.panX && !bd.panY) roamed = false;
    if (!roamed) {
      cam.tx = bd.panX ? clamp(-view.ux, bd.minX, bd.maxX) : bd.minX;
      cam.ty = bd.panY ? clamp(-view.uy, bd.minY, bd.maxY) : bd.minY;
    }
    clampCam(hard || !cam.init);
    return changed;
  }

  /** The window, the chrome around the office or the display may have changed: measure, and re-plan if so. */
  function fit() {
    const m = measure();
    if (!plan) replan('boot');
    else if (m.changed) replan('viewport');
    // resizing a canvas clears it: paint at once instead of leaving it blank until the next animation frame
    if (m.cleared && staticLayer && !inRender) { aimShift(false); cam.sx = cam.tsx; cam.sy = cam.tsy; render(); }
    poke();
  }

  /**
   * A panel opening or closing is followed at once. While one is open, a change of its size (the dialogue
   * growing with a long message, a panel being dragged) is followed once it has stopped changing: the
   * camera makes one move to the final size instead of chasing every step.
   */
  function setOverlay(o) {
    const right = Math.max(0, +(o && o.right) || 0);
    const bottom = Math.max(0, +(o && o.bottom) || 0);
    if (right === overlayNext.right && bottom === overlayNext.bottom) return;
    overlayNext = { right, bottom };
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = 0; }
    const wasOpen = overlay.right > 0 || overlay.bottom > 0;
    const isOpen = right > 0 || bottom > 0;
    if (wasOpen && isOpen) overlayTimer = setTimeout(applyOverlay, OVERLAY_SETTLE);
    else applyOverlay();
  }
  function applyOverlay() {
    overlayTimer = 0;
    if (destroyed) return;
    overlay = overlayNext;
    poke();
  }

  const selActor = () => (selected ? actors.get(selected) || actors.get(selected.split('#')[0]) || null : null);

  /**
   * What has to stay in view for the selected character: the character itself and the top of the zone
   * it is in (its room's banner, its pod's sign, the BREAK ROOM sign). World px.
   */
  function frameRect(a) {
    const settled = a.at && !a.path.length;
    const r = { x0: a.x - 14, x1: a.x + 14, y0: a.y - 42, y1: a.y + 5 };
    if (!settled) return r;
    if (a.at.t === 'desk') {
      const d = deskAt(L, a.at);
      const pod = L.podMap.get(a.at.pod || '');
      r.y0 = (pod ? pod.y : G.BULL) - 8;
      if (d) { r.x0 = d.cx - 4; r.x1 = d.cx + G.CELL; r.y1 = d.cy + 49; }
    } else if (a.at.t === 'boss' || a.at.t === 'seat') {
      const room = L.rooms[a.at.room];
      r.y0 = 0;
      r.y1 = Math.max(r.y1, a.at.t === 'boss' ? 92 : a.y + 5);
      if (room) { r.x0 = room.x; r.x1 = room.x + G.ROOM; }
    } else if (a.at.t === 'break') {
      r.y0 = G.SIGN_Y - 1;
    }
    return r;
  }

  /**
   * How far to nudge the camera so the selected character and the top of its zone both sit between the
   * app chrome and an overlaid panel: the least movement that does it. When they cannot both fit at
   * this scale, ask for one scale step less (`lowered`) instead of hiding either.
   */
  function aimShift(mayRefit = true) {
    let tsx = 0;
    let tsy = 0;
    let want = false;
    const a = selActor();
    if (a && !a.hidden && (overlay.bottom || overlay.right)) {
      const r = frameRect(a);
      const obd = overlay.bottom * view.dpr;
      const ord = overlay.right * view.dpr;
      const fitsAt = (s) => (r.y1 - r.y0) * s <= view.uHd - obd && (r.x1 - r.x0) * s <= view.uWd - ord;
      want = !fitsAt(view.base) && view.base > 1;
      const ob = obd / view.s;
      const or = ord / view.s;
      const span = (lo, hi, cap0) => {
        // lo = shift needed to bring the far edge in, hi = the most that keeps the near edge in
        if (lo > hi) return clamp(lo, -cap0, cap0); // cannot have both: the character wins
        return clamp(clamp(0, lo, hi), -cap0, cap0);
      };
      if (ob > 0) {
        const top = cam.ty + view.uy;
        tsy = span(Math.ceil(r.y1 - (top + view.uh - ob)), Math.floor(r.y0 - top), Math.ceil(ob));
      }
      if (or > 0) {
        const left = cam.tx + view.ux;
        tsx = span(Math.ceil(r.x1 - (left + view.uw - or)), Math.floor(r.x0 - left), Math.ceil(or));
      }
    }
    cam.tsx = tsx;
    cam.tsy = tsy;
    if (!mayRefit) return;
    // The step down is taken when it is needed and then kept for as long as this selection and the panel
    // last: an overlay that changes height must not make the whole office pump between two scales.
    const open = overlay.bottom > 0 || overlay.right > 0;
    const next = lowered && open && selected && selected === loweredFor ? true : want;
    if (next !== lowered) {
      lowered = next;
      loweredFor = next ? selected : null;
      clampCam(applyScale());
      poke();
      aimShift(false);
    } else if (lowered && want) loweredFor = selected;
  }

  function setInsets(i) {
    const n = normInsets(i);
    if (n.top === insets.top && n.right === insets.right && n.bottom === insets.bottom && n.left === insets.left) return;
    insets = n;
    fit();
  }

  // ---------------------------------------------------------------- walking
  function route(a) {
    a.needPlan = false;
    const dst = a.dest && geom(L, a.dest);
    if (!dst) return;
    const pts = [];
    const from = a.at ? geom(L, a.at) : null;
    if (from) {
      for (let i = from.approach.length - 2; i >= 0; i--) pts.push(from.approach[i]);
    } else if (a.trail.length) {
      for (let i = a.trail.length - 1; i >= 0; i--) pts.push(a.trail[i]);
    } else if (Math.abs(a.y - G.WALK) > 0.5) {
      pts.push({ x: a.x, y: G.WALK });
    }
    for (const q of dst.approach) pts.push(q);
    const path = [];
    let px = a.x; let py = a.y;
    for (const q of pts) {
      if (Math.abs(q.x - px) < 0.01 && Math.abs(q.y - py) < 0.01) continue;
      path.push(q);
      px = q.x; py = q.y;
    }
    a.path = path;
    a.at = null;
    a.trail = [];
    if (!path.length) arrive(a);
  }

  function arrive(a) {
    if (a.dest && a.dest.t === 'door') { a.gone = true; return; }
    const g = a.dest && geom(L, a.dest);
    if (g && (Math.abs(g.x - a.x) > 0.5 || Math.abs(g.y - a.y) > 0.5)) { a.path = [{ x: g.x, y: g.y }]; return; } // the spot moved meanwhile
    a.at = a.dest;
    a.trail = [];
    wearRole(a);
  }

  function step(a, dt) {
    let d = SPEED * dt;
    while (d > 0 && a.path.length) {
      const q = a.path[0];
      const dx = q.x - a.x;
      const dy = q.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) a.face = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'F' : 'B';
      if (dist <= d) {
        a.x = q.x; a.y = q.y;
        d -= dist;
        a.walk += dist;
        a.path.shift();
        if (Math.abs(q.y - G.WALK) < 0.5) a.trail = [q]; else a.trail.push(q);
      } else {
        a.x += (dx / dist) * d;
        a.y += (dy / dist) * d;
        a.walk += d;
        d = 0;
      }
    }
    if (!a.path.length) arrive(a);
  }

  const walkers = [];
  /** Whoever walks close behind someone going the same way eases off, so people do not walk inside each other. */
  function pace() {
    walkers.length = 0;
    for (const a of actors.values()) {
      a.pace = 1;
      if (a.path.length && !a.hidden && a.spawn <= 0) walkers.push(a);
    }
    if (walkers.length < 2) return;
    for (const a of walkers) {
      const horiz = a.face === 'R' || a.face === 'L';
      const sign = a.face === 'R' || a.face === 'F' ? 1 : -1;
      for (const o of walkers) {
        if (o === a || o.face !== a.face) continue;
        if (Math.abs(horiz ? o.y - a.y : o.x - a.x) > 5) continue;
        const gap = (horiz ? o.x - a.x : o.y - a.y) * sign;
        if (gap > 0.01 && gap < FOLLOW) a.pace = Math.min(a.pace, Math.max(0, (gap - 10) / (FOLLOW - 10)));
        else if (Math.abs(gap) <= 0.01 && o.id < a.id) a.pace = Math.min(a.pace, 0.25); // same spot: one goes first
      }
    }
  }

  /** One slice of world time: people walk. (Nothing here depends on how often frames are drawn.) */
  function update(dt) {
    t += dt;
    pace();
    for (const a of actors.values()) {
      if (a.spawn > 0) {
        a.spawn -= dt;
        if (a.spawn > 0) continue;
        a.hidden = false;
      }
      if (a.needPlan) route(a);
      if (a.path.length && a.pace > 0) step(a, dt * a.pace);
      // keep right on the walkway, so two people going opposite ways pass beside each other
      const onWalk = a.path.length && Math.abs(a.y - G.WALK) < 0.5 && (a.face === 'R' || a.face === 'L');
      const lane = onWalk ? (a.face === 'R' ? -3 : 3) : 0;
      a.lane += (lane - a.lane) * Math.min(1, dt * 10);
      if (Math.abs(lane - a.lane) < 0.05) a.lane = lane;
    }
    for (const [id, a] of actors) {
      if (!a.gone) continue;
      actors.delete(id);
      if (hover === id) hover = null;
    }
  }

  /** Once per frame, with the real time that passed: furniture and rooms sliding home, the camera. */
  function ease(dt) {
    anim += dt * 1000;
    if (offs.size || loungeOff) {
      const f = still ? 0 : Math.exp(-dt * SLIDE);
      const now = anim;
      for (const [id, o] of offs) {
        if (o.hold) { if (still || now >= o.hold) offs.delete(id); continue; } // carried under dust: there at half time
        if (o.hide) { if (still || now >= o.hide) offs.delete(id); continue; } // a new desk, not put down yet
        o.x *= f; o.y *= f;
        if (Math.abs(o.x) < 0.5 && Math.abs(o.y) < 0.5) offs.delete(id);
      }
      loungeOff *= f;
      if (Math.abs(loungeOff) < 0.5) loungeOff = 0;
    }
    const k = 1 - Math.exp(-dt * 14);
    cam.x += (cam.tx - cam.x) * k;
    cam.y += (cam.ty - cam.y) * k;
    if (Math.abs(cam.tx - cam.x) < 0.3) cam.x = cam.tx;
    if (Math.abs(cam.ty - cam.y) < 0.3) cam.y = cam.ty;
    aimShift();
    cam.sx += (cam.tsx - cam.sx) * k;
    cam.sy += (cam.tsy - cam.sy) * k;
    if (Math.abs(cam.tsx - cam.sx) < 0.3) cam.sx = cam.tsx;
    if (Math.abs(cam.tsy - cam.sy) < 0.3) cam.sy = cam.tsy;
  }

  /**
   * Put everyone and everything where it is heading: used whenever the frames in between were not seen
   * (a hidden page, a long gap between two frames, the machine waking up).
   */
  function settleAll() {
    for (const [id, a] of actors) {
      if (a.leaving || (a.dest && a.dest.t === 'door')) { actors.delete(id); if (hover === id) hover = null; continue; }
      if (a.dest && (a.snap || a.hidden || a.needPlan || a.path.length || !a.at)) snapTo(a, a.dest);
      a.lane = 0;
    }
    spawnClock = Math.min(spawnClock, t);
    offs.clear();
    poofs.length = 0;
    loungeOff = 0;
    zoom.on = false;
    cam.x = cam.tx; cam.y = cam.ty;
    aimShift();
    cam.sx = cam.tsx; cam.sy = cam.tsy;
  }

  // ---------------------------------------------------------------- how an actor looks right now
  const TYPING = new Set(['editing', 'writing', 'running', 'delegating']);

  function visual(a) {
    const d = a.data || {};
    const tt = t + a.phase;
    const fr = (rate) => (still ? 0 : Math.floor(tt * rate));
    const blink = !still && tt % 3.7 < 0.14;
    const v = { dir: 'F', pose: 'stand', frame: 0, expr: 'neutral', bob: 0, mode: 'walk', zz: false };
    const session = a.kind === 'session';
    const waiting = session && d.status === 'waiting';

    if (!a.at || a.path.length) {
      // until it has arrived a character is a walker and nothing else: no raised hand, no alarm on its face
      v.dir = a.face;
      v.pose = 'walk';
      v.frame = a.pace > 0.05 ? Math.floor(a.walk / 5) % 4 : 0;
      v.bob = !still && v.frame % 2 ? -1 : 0;
      v.expr = !session && d.status === 'done' ? 'happy' : !session && d.status === 'failed' ? 'sleep' : blink ? 'blink' : 'neutral';
      return v;
    }
    const at = a.at;
    v.mode = at.t;
    if (at.t === 'desk') {
      if (waiting) { v.dir = 'F'; v.pose = 'raiseSit'; v.frame = fr(2) % 2; v.expr = 'alert'; }
      else if (d.status === 'idle') { v.dir = 'R'; v.pose = 'sit'; v.expr = 'sleep'; v.zz = true; }
      else {
        const kind = d.activity && d.activity.kind;
        v.dir = 'R';
        if (kind === 'thinking') { v.pose = 'think'; v.expr = blink ? 'blink' : 'neutral'; }
        else { v.pose = 'type'; v.frame = fr(TYPING.has(kind) ? 8 : 2.5) % 2; v.expr = blink ? 'blink' : 'focus'; }
      }
    } else if (at.t === 'boss') {
      if (waiting) { v.pose = 'raise'; v.frame = fr(2) % 2; v.expr = 'alert'; }
      else if (d.status === 'idle') { v.pose = 'stand'; v.expr = 'sleep'; v.zz = true; }
      else { v.pose = 'present'; v.frame = fr(2) % 2; v.expr = 'talk'; }
    } else if (at.t === 'seat') {
      v.dir = at.k < 4 ? 'F' : 'B';
      if (d.status === 'done') { v.pose = 'relax'; v.expr = 'happy'; }
      else if (d.status === 'failed') { v.pose = 'slump'; v.expr = 'dead'; }
      else { v.pose = 'type'; v.frame = fr(7) % 2; v.expr = blink ? 'blink' : 'focus'; }
    } else if (at.t === 'break') {
      const kind = breakSlot(L, at.k).kind;
      const sipping = !still && tt % 5 < 1.2 ? 1 : 0;
      if (kind === 'couch') {
        if (hash(a.id) % 2) { v.pose = 'doze'; v.expr = 'sleep'; v.zz = true; }
        else { v.pose = 'sipSit'; v.frame = sipping; v.expr = 'content'; }
      } else if (kind === 'arcade') { v.dir = 'B'; v.pose = 'type'; v.frame = fr(9) % 2; }
      else if (kind === 'vending') { v.dir = 'B'; v.pose = 'stand'; }
      else if (kind === 'cooler') { v.dir = 'L'; v.pose = 'sip'; v.frame = sipping; v.expr = 'content'; }
      else { v.pose = 'sip'; v.frame = sipping; v.expr = sipping ? 'content' : blink ? 'blink' : 'neutral'; }
    }
    return v;
  }

  // ---------------------------------------------------------------- tags
  const tagCache = new Map();
  const cached = (key, make) => {
    let c = tagCache.get(key);
    if (c) return c;
    if (tagCache.size > 1200) tagCache.clear();
    c = make();
    tagCache.set(key, c);
    return c;
  };
  /** The group's colours along the bottom edge of a tag `h` px tall (the tag is 1px taller for it). */
  const stripe = (g, w, h, col) => {
    R(g, K, 0, h - 2, w, 3);
    R(g, col.base, 1, h - 2, w - 2, 2);
  };

  /**
   * Name tags.
   *   session: 'big' (tool badge + name, big font), 'small' (same, small font), 'mini' (badge only)
   *   helper:  'sub' (activity icon + name), 'subc' (name only, coloured by how it is going)
   * A session in a group carries the group's colour as a stripe under the tag; the tool badge stays
   * the first thing on it. Colours follow the shared rules: a yellow plate with dark text = needs you
   * (`lit`; `flash` picks the bright or the dim yellow), a small steady yellow "!" at the end of the tag =
   * still waiting from earlier (`quiet`), red = a helper that failed. Selection and hover never change the
   * plate: they are drawn around it (brackets / a thin outline).
   */
  function tagSprite(a, variant, lit = false, flash = false, quiet = false) {
    const d = a.data || {};
    const session = a.kind === 'session';
    const tool = session ? d.tool : a.parent && a.parent.data.tool;
    const st = d.status;
    const kind = !session && d.activity ? d.activity.kind : '';
    const gc = session ? groupColOf(sessions.get(a.id)) : null;
    const key = `${variant}|${tool}|${d.name}|${d.agentType || ''}|${st}|${kind}|${lit ? (flash ? 2 : 1) : 0}|${quiet ? 1 : 0}|${gc ? gc.base : ''}`;
    return cached(key, () => {
      const T = toolOf(tool);
      const bg = lit ? (flash ? C.alert : C.alertDim) : C.tagBg;
      const qw = quiet ? 6 : 0; // the steady "!" cell
      const mark = (g, w, h) => {
        if (!quiet) return;
        R(g, C.alert, w - 6, 1, 5, h - 2);
        R(g, K, w - 7, 1, 1, h - 2);
        const my = (h - 7) >> 1;
        R(g, K, w - 4, my + 1, 1, 3);
        R(g, K, w - 4, my + 5, 1, 1);
      };
      let c;
      if (variant === 'big') {
        const name = clipText(d.name || '?', 52, BIG);
        const w = textWidth(name, BIG) + 15 + qw;
        c = makeCanvas(w, gc ? 12 : 11);
        const g = ctx2d(c);
        box(g, 0, 0, w, 11, bg, K);
        R(g, T.base, 1, 1, 9, 9);
        drawText(g, T.badge, 2, 3, T.ink, SMALL);
        R(g, K, 10, 1, 1, 9);
        drawText(g, name, 12, 2, lit ? C.alertInk : st === 'idle' ? C.tagDim : WHITE, BIG);
        mark(g, w, 11);
        if (gc) stripe(g, w, 11, gc);
      } else if (variant === 'small' || variant === 'mini') {
        const name = variant === 'mini' ? '' : clipText(d.name || '?', 36, SMALL);
        const w = (name ? textWidth(name, SMALL) + 13 : 10) + qw;
        c = makeCanvas(w, gc ? 10 : 9);
        const g = ctx2d(c);
        box(g, 0, 0, w, 9, bg, K);
        R(g, T.base, 1, 1, 8, 7);
        drawText(g, T.badge, 2, 2, T.ink, SMALL);
        if (name) drawText(g, name, 11, 2, lit ? C.alertInk : st === 'idle' ? C.tagDim : WHITE, SMALL);
        mark(g, w, 9);
        if (gc) stripe(g, w, 9, gc);
      } else if (variant === 'subc') {
        const name = clipText(d.name || d.agentType || 'SUB', 20, SMALL);
        const w = textWidth(name, SMALL) + 4;
        c = makeCanvas(w, 9);
        const g = ctx2d(c);
        box(g, 0, 0, w, 9, st === 'done' ? C.okDark : st === 'failed' ? C.badDark : C.tagBg, K);
        drawText(g, name, 2, 2, st === 'working' ? T.light : WHITE, SMALL);
      } else {
        const name = clipText(d.name || d.agentType || 'SUB', 24, SMALL);
        const w = textWidth(name, SMALL) + 13;
        c = makeCanvas(w, 9);
        const g = ctx2d(c);
        box(g, 0, 0, w, 9, st === 'done' ? C.okDark : st === 'failed' ? C.badDark : C.tagBg, K);
        if (st === 'done') { R(g, C.ok, 1, 1, 8, 7); g.drawImage(P.iconWhite.done, 1, 1); }
        else if (st === 'failed') { R(g, C.bad, 1, 1, 8, 7); g.drawImage(P.iconWhite.failed, 1, 1); }
        else { R(g, WHITE, 1, 1, 8, 7); g.drawImage(P.icons[kind] || P.icons.thinking, 1, 1); }
        drawText(g, name, 10, 2, WHITE, SMALL);
      }
      return c;
    });
  }

  const AWAY_WORDS = { room: 'IN MEETING', break: 'ON BREAK', desk: 'ARRIVING' };
  /**
   * The card left on an empty desk: whose it is, and where they are (in a meeting, on a break, or on
   * their way to this desk). Muted, so it never reads as someone working.
   */
  function awayCard(rec, hot) {
    const d = rec.data;
    const why = AWAY_WORDS[rec.zone] || '';
    const key = `card|${d.tool}|${d.name}|${why}|${hot ? 1 : 0}`;
    return cached(key, () => {
      const T = toolOf(d.tool);
      const name = clipText(d.name || '?', 40, SMALL);
      const w = Math.max(textWidth(name, SMALL), why ? textWidth(why, SMALL) : 0) + 8;
      const h = why ? 15 : 9;
      const c = makeCanvas(w, h);
      const g = ctx2d(c);
      // a paper tent card, the colour of the furniture: name tags of people who are here are black
      box(g, 0, 0, w, h, C.beige, hot ? WHITE : '#5c5444');
      R(g, C.beigeShade, 1, h - 2, w - 2, 1);
      R(g, T.shade, 1, 1, 2, h - 2);
      drawText(g, name, 5, 2, '#4c4434', SMALL);
      if (why) drawText(g, why, 5, 8, '#8c7c5c', SMALL);
      return c;
    });
  }

  /**
   * The tooltip: a dark box with a white edge and a dark rim (so it stands out on any floor) and up to four
   * lines, [text, colour, big?]: the first line of a character's tip is set in the big font.
   */
  function boxSprite(lines) {
    const key = `tip|${lines.map((l) => l.join('~')).join('|')}`;
    return cached(key, () => {
      const rows = lines.map(([text, col, big]) => { const f = big ? BIG : SMALL; return [clipText(text, 168, f), col, f]; });
      let w = 0;
      let h = 3;
      for (const [text, , f] of rows) { w = Math.max(w, textWidth(text, f)); h += f.h + 2; }
      w += 8;
      h += 1;
      const c = makeCanvas(w + 2, h + 2);
      const g = ctx2d(c);
      R(g, K, 0, 0, w + 2, h + 2);
      box(g, 1, 1, w, h, C.tagBg, WHITE);
      let y = 4;
      for (const [text, col, f] of rows) { drawText(g, text, 5, y, col, f); y += f.h + 2; }
      return c;
    });
  }

  /** What a character is working on, shown while the pointer rests on it. */
  function tipSprite(a) {
    const d = a.data || {};
    const session = a.kind === 'session';
    const line1 = session ? taskName(d) : d.label || d.agentType || '';
    const act = d.activity && d.activity.label ? d.activity.label : '';
    const line2 = session ? [d.project, act].filter(Boolean).join(' · ') : act;
    const lines = [];
    if (line1) lines.push([line1, WHITE, true]);
    if (line2) lines.push([line2, line1 ? C.tagDim : WHITE]);
    if (session) {
      // an orchestrator: how its helpers are doing, in words (the banner only has room for "5/6 DONE")
      const subs = Array.isArray(d.subagents) ? d.subagents : [];
      if (d.mode === 'orchestrator' && subs.length) {
        const n = { working: 0, done: 0, failed: 0 };
        for (const x of subs) if (x && n[x.status] != null) n[x.status]++;
        const parts = [`${n.done} OF ${subs.length} HELPERS DONE`];
        if (n.working) parts.push(`${n.working} WORKING`);
        if (n.failed) parts.push(`${n.failed} FAILED`);
        lines.push([parts.join(' · '), C.tagDim]);
      }
      if (d.status === 'waiting') lines.push(['NEEDS YOU', C.alert]);
      else if (d.unanswered === true) lines.push(['STILL WAITING FOR YOU', C.alert]);
    }
    return lines.length ? boxSprite(lines.slice(0, 4)) : null;
  }

  // ---------------------------------------------------------------- render
  const isMember = (a) => {
    if (hi == null) return true;
    const rec = recOf(a);
    return !!rec && sessions.get(rec.id) === rec && rec.pod === hi;
  };
  const env = {
    t: 0, still: false, doorOpen: false, loungeOff: 0, flash: true, cover: 0,
    off(id) { return offs.get(id) || ZERO; },
    desk(d) {
      const pod = pods.get(d.pod);
      const id = pod && pod.owner[d.i];
      const rec = id && sessions.get(id);
      if (!rec) return null;
      const a = rec.actor;
      const here = a.at && a.at.t === 'desk' && !a.path.length && !a.snap;
      const st = rec.data.status;
      return { tool: rec.data.tool, text: rec.data.label || rec.data.project || '', seed: rec.seed, mode: !here ? 'away' : st === 'waiting' ? 'wait' : st === 'working' ? 'on' : 'away' };
    },
    pod(key) {
      if (podMemo.has(key)) return podMemo.get(key);
      const info = podInfo(key);
      podMemo.set(key, info);
      return info;
    },
    room(i) {
      if (roomMemo.has(i)) return roomMemo.get(i);
      const info = roomInfo(i);
      roomMemo.set(i, info);
      return info;
    },
  };
  const roomMemo = new Map(); // per-frame cache: each room is asked about several times while drawing
  const podMemo = new Map();
  function roomInfo(i) {
    const id = roomOwner[i];
    const rec = id && sessions.get(id);
    if (!rec) {
      // the meeting is over: the banner stays until the last of the crew is out of the door
      const gh = roomGhost[i];
      if (!gh) return null;
      const room = L.rooms[i];
      const inside = !!room && gh.crew.some((a) => actors.get(a.id) === a && !a.gone && !a.hidden && !a.snap && a.y < G.BAND - 0.5 && a.x >= room.x && a.x <= room.x + G.ROOM);
      if (!inside) { roomGhost[i] = null; return null; }
      return gh.info;
    }
    const seats = rec.seats.map((sid) => {
      if (sid == null) return null;
      const e = rec.subs.get(sid);
      if (!e) return null;
      const a = e.actor;
      return { status: (a.data && a.data.status) || 'working', seated: !!(a.at && a.at.t === 'seat' && !a.path.length) };
    });
    let top = -1;
    for (let k = 0; k < seats.length; k++) if (seats[k]) top = k;
    const subs = Array.isArray(rec.data.subagents) ? rec.data.subagents : [];
    let working = 0;
    let done = 0;
    for (const x of subs) { if (x && x.status === 'working') working++; else if (x && x.status === 'done') done++; }
    // the banner turns "needs you" only once the boss stands at the board: until then it is a walker
    const a = rec.actor;
    const here = !!(a.at && a.at.t === 'boss' && !a.path.length && !a.snap && !a.hidden);
    const waiting = here && rec.data.status === 'waiting';
    return {
      tool: rec.data.tool, name: rec.data.name || '?', title: taskName(rec.data), seats, overflow: rec.overflow, hi: top, working, done, total: subs.length,
      group: groupColOf(rec), groupName: rec.pod && groups.get(rec.pod) ? groups.get(rec.pod).name : '',
      waiting, quiet: here && !waiting && rec.data.unanswered === true, sel: selected === id, hot: hover === id,
    };
  }
  /**
   * Sign + rug for a pod. Every pod stands on a rug as big as its desks: a group's in its tint, the default
   * pod's in carpet grey. The default pod only gets a (grey) sign when there are group pods to tell it from.
   */
  function podInfo(key) {
    const p = pods.get(key);
    if (!p) return null;
    const count = members(p);
    if (key === NO_GROUP) return { name: 'BULLPEN', count, col: NEUTRAL, rugCol: CARPET, rug: true, sign: L.pods.length > 1, hot: hoverSign === key };
    const g = groups.get(key);
    if (!g) return { name: '...', count, col: NEUTRAL, rugCol: CARPET, rug: true, sign: true, hot: false };
    return { name: g.name, count, col: g.col, rugCol: g.col, rug: true, sign: true, hot: hoverSign === key };
  }

  const drawList = [];
  let inRender = false;
  let lastPaint = 0;

  function drawActor(it) {
    const v = it.v;
    const spr = getSprite(it.look, v.dir, v.pose, v.frame, v.expr);
    const sx = Math.round(it.rx) - 12;
    const sy = Math.round(it.ry) - FOOT + v.bob;
    const settled = it.at && !it.path.length;
    if (it.id === selected) {
      // selection = white + a shape: a ring on the floor under the feet, a thick outline around the body
      b.drawImage(P.floorRing, sx - 1, Math.round(it.ry) - 6);
      b.drawImage(getHalo(spr, C.select), sx - 2, sy - 2);
    } else if (it.id === hover) b.drawImage(getHalo(spr, C.hover), sx - 2, sy - 2); // the pointer is on it: the same thick white outline, nothing else
    else if (settled && it.kind === 'session' && it.data && it.data.status === 'waiting') b.drawImage(getRing(spr, env.flash ? C.alert : C.alertDim), sx - 1, sy - 1);
    b.drawImage(spr, sx, sy);
  }

  function render() {
    if (!staticLayer) return;
    inRender = true;
    const now = performance.now();
    // the transform: an integer scale and camera, except during the short glide between two scales
    let s = view.s;
    let fx = cam.x + cam.sx;
    let fy = cam.y + cam.sy;
    let gliding = false;
    if (zoom.on) {
      const p = still ? 1 : (anim - zoom.t0) / ZOOM_MS;
      if (p >= 1 || p < 0) zoom.on = false;
      else {
        const e = 1 - (1 - p) ** 3;
        const sd = zoom.from + (view.s - zoom.from) * e;
        const tcx = fx + view.devW / 2 / view.s;
        const tcy = fy + view.devH / 2 / view.s;
        fx = zoom.cx + (tcx - zoom.cx) * e - view.devW / 2 / sd;
        fy = zoom.cy + (tcy - zoom.cy) * e - view.devH / 2 / sd;
        s = sd;
        gliding = true;
      }
    }
    const camX = gliding ? Math.floor(fx) : Math.round(fx);
    const camY = gliding ? Math.floor(fy) : Math.round(fy);
    const vw = Math.ceil(view.devW / s) + (gliding ? 1 : 0);
    const vh = Math.ceil(view.devH / s) + (gliding ? 1 : 0);
    // during a glide the buffer is sized once, for the smaller of the two scales
    const sb = gliding ? Math.min(zoom.from, view.s) : s;
    const bw = gliding ? Math.ceil(view.devW / sb) + 1 : vw;
    const bh = gliding ? Math.ceil(view.devH / sb) + 1 : vh;
    if (gliding ? buf.width < bw || buf.height < bh : buf.width !== bw || buf.height !== bh) {
      buf.width = bw; buf.height = bh;
      b.imageSmoothingEnabled = false;
      floorPattern = b.createPattern(tile, 'repeat');
    }
    drawn.ok = true; drawn.s = s;
    drawn.x = gliding ? fx : camX; drawn.y = gliding ? fy : camY;
    drawn.cx = drawn.x + view.devW / 2 / s; drawn.cy = drawn.y + view.devH / 2 / s;

    env.t = t;
    env.still = still;
    // everyone who needs you pulses in step (one calm beat for the whole office, not a field of twinkles)
    env.pulse = still ? 0 : (t / PULSE) % 1;
    env.flash = env.pulse < 0.5;
    env.doorOpen = false;
    env.loungeOff = loungeOff;
    env.cover = 0;
    env.date = new Date();
    roomMemo.clear();
    podMemo.clear();
    for (const a of actors.values()) {
      if (a.hidden ? a.spawn < 0.35 : Math.abs(a.x - L.door.x) < 12 && a.y < L.door.y + 16) { env.doorOpen = true; break; }
    }

    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalAlpha = 1;
    b.fillStyle = C.ceiling;
    b.fillRect(0, 0, vw, vh);
    b.translate(-camX, -camY);

    // above the wall: tall upper wall with a duct, the ceiling line, pendant lamps
    if (camY < 0) {
      const U = UPPER;
      R(b, C.wallShade, camX, -U, vw, U);
      R(b, C.wall, camX, -2, vw, 2);
      R(b, K, camX, -33, vw, 1);
      R(b, C.steel, camX, -32, vw, 6);
      R(b, C.steelLight, camX, -32, vw, 1);
      R(b, C.steelDark, camX, -27, vw, 1);
      R(b, K, camX, -26, vw, 1);
      R(b, C.baseboard, camX, -U - 4, vw, 4);
      R(b, K, camX, -U - 5, vw, 1);
      R(b, C.ceilingTrim, camX, -U - 8, vw, 3);
      for (let x = Math.floor(camX / 96) * 96; x < camX + vw + 96; x += 96) {
        R(b, K, x + 20, -34, 2, 9);
        R(b, K, x + 48, -U, 1, U - 14);
        R(b, '#585868', x + 44, -15, 9, 3);
        R(b, K, x + 43, -12, 11, 1);
        R(b, '#fcf4c0', x + 45, -11, 7, 2);
      }
    }
    // endless floor + walkway + wall around the world
    b.fillStyle = floorPattern;
    b.fillRect(camX, G.WALL, vw, camY + vh - G.WALL);
    R(b, C.walk, camX, G.BAND, vw, G.BULL - G.BAND);
    R(b, C.walkLine, camX, G.BAND, vw, 1);
    R(b, C.walkLine, camX, G.BULL - 1, vw, 1);
    // the wall outside the office repeats away from both ends of it, so no window is ever cut in half by the office itself
    for (let x = -192; x + 192 > camX; x -= 192) b.drawImage(outerTile, x, 0);
    for (let x = L.W; x < camX + vw; x += 192) b.drawImage(outerTile, x, 0);
    b.drawImage(staticLayer, 0, 0);
    // rooms closing ranks: each one slides over from where it was. Where it is going was an empty room.
    if (offs.size) {
      const sliding = [];
      for (const r of L.rooms) {
        const o = offs.get(`room:${r.i}`);
        const ox = o ? Math.round(o.x) : 0;
        if (ox) sliding.push([r, ox]);
      }
      for (const [r, ox] of sliding) {
        b.fillStyle = 'rgba(22,16,40,0.42)';
        b.fillRect(r.x + 2, 13, Math.min(Math.abs(ox), G.ROOM) - 2, G.BAND - 13);
      }
      for (const [r, ox] of sliding) {
        b.drawImage(staticLayer, r.x, 0, G.ROOM, G.BAND + 2, r.x + ox, 0, G.ROOM, G.BAND + 2);
        env.cover = Math.max(env.cover, r.x + ox + G.ROOM);
      }
    }
    drawWallLife(b, L, env);
    for (const f of furniture.floor) f.draw(b, env);

    // y-sorted furniture + people
    drawList.length = 0;
    for (const f of furniture) drawList.push(f);
    const x0 = camX - 16;
    const x1 = camX + vw + 16;
    const vis = [];
    for (const a of actors.values()) {
      if (a.hidden || a.snap) continue;
      a.v = visual(a);
      // someone seated rides along while their desk (or the couch) slides to a new place
      let ox = 0;
      let oy = 0;
      if (a.at && !a.path.length) {
        if (a.at.t === 'desk' && offs.size) { const o = offs.get(`${a.at.pod}/${a.at.i}`); if (o) { ox = o.x; oy = o.y; } }
        else if ((a.at.t === 'boss' || a.at.t === 'seat') && offs.size) { const o = offs.get(`room:${a.at.room}`); if (o) ox = o.x; }
        else if (a.at.t === 'break' && loungeOff && breakSlot(L, a.at.k).kind === 'couch') oy = loungeOff;
      }
      a.rx = a.x + ox;
      a.ry = a.y + a.lane + oy;
      // Depth: by the feet. Someone on the move is sorted a little further back, so a walker whose lane runs
      // just in front of people who are seated or standing (the near side of a meeting table, the couch, the
      // machines, a desk aisle) passes behind them instead of being drawn across them.
      a.sy = a.ry - (a.path.length || !a.at ? LANE_BIAS : 0);
      if (a.rx < x0 || a.rx > x1) continue;
      vis.push(a);
      drawList.push(a);
    }
    drawList.sort((p, q) => (p.sy != null ? p.sy : p.y) - (q.sy != null ? q.sy : q.y));
    for (const it of drawList) {
      if (it.draw) it.draw(b, env);
      else drawActor(it);
    }

    if (hi != null) drawDim(vis, camX, camY, vw, vh);
    drawOverlays(vis, camX, camY);
    drawEdges(camX, camY);

    out.setTransform(1, 0, 0, 1, 0, 0);
    out.imageSmoothingEnabled = false;
    if (gliding) {
      out.drawImage(buf, 0, 0, vw, vh, Math.round(-(fx - camX) * s), Math.round(-(fy - camY) * s), vw * s, vh * s);
    } else {
      out.drawImage(buf, 0, 0, vw, vh, 0, 0, vw * s, vh * s);
    }
    lastPaint = now;
    inRender = false;
  }

  /** Group highlight: everything outside the group's pod and its meeting rooms goes a step darker. */
  function drawDim(vis, camX, camY, vw, vh) {
    b.save();
    b.beginPath();
    b.rect(camX, camY, vw, vh);
    const holes = [];
    const pod = L.podMap.get(hi);
    if (pod) {
      const r = podRect(L, pod);
      const o = offs.get(`pod:${hi}`) || ZERO;
      // (the sign may be wider than the rug: it stays bright as a whole)
      const sr = signRects.find((q) => q.key === hi);
      holes.push({ x: r.x + Math.round(o.x) - 1, y: pod.y - 9 + Math.round(o.y), w: Math.max(r.w + 2, sr ? sr.w + 2 : 0), h: pod.bottom - pod.y + 11 });
    }
    for (let i = 0; i < roomOwner.length; i++) {
      const rec = roomOwner[i] != null ? sessions.get(roomOwner[i]) : null;
      if (rec && rec.pod === hi && L.rooms[i]) holes.push({ x: L.rooms[i].x, y: 0, w: G.ROOM, h: G.BAND });
    }
    for (const h of holes) b.rect(h.x, h.y, h.w, h.h);
    b.fillStyle = 'rgba(22,16,30,0.42)';
    b.fill('evenodd');
    b.restore();
    // members who are somewhere else (walking, on a break) stay bright too
    for (const a of vis) {
      if (!isMember(a)) continue;
      let inside = false;
      for (const h of holes) if (a.rx >= h.x && a.rx <= h.x + h.w && a.ry >= h.y && a.ry <= h.y + h.h) { inside = true; break; }
      if (!inside) drawActor(a);
    }
  }

  const hits = (o, x, y, w, h, pad = 0) => x < o.x + o.w + pad && x + w + pad > o.x && y < o.y + o.h + pad && y + h + pad > o.y;

  const over = (list, x, y, w, h, pad = 0, skip = null) => {
    for (const o of list) if (o !== skip && hits(o, x, y, w, h, pad)) return true;
    return false;
  };
  const overlap = (o, x, y, w, h) => Math.max(0, Math.min(o.x + o.w, x + w) - Math.max(o.x, x)) * Math.max(0, Math.min(o.y + o.h, y + h) - Math.max(o.y, y));
  const LOUNGE_SIGN_RECT_W = textWidth('BREAK ROOM', BIG) + 7;

  function drawOverlays(vis, camX, camY) {
    const flash = env.flash;
    const items = [];
    const blocks = []; // "needs you" bubbles: no tag may cover one
    const heads = [];
    const wants = []; // tags asking for a place: { it, prio, cands: [{spr, x, y}], dy, walker }
    const helperTags = new Map(); // room -> whether its helpers wear name tags (few enough to fit)

    // Zone signs and room banners: nothing that moves is ever drawn over one of these.
    signRects = [];
    for (const pod of L.pods) {
      const info = env.pod(pod.key);
      if (!info || !info.sign) continue;
      const o = offs.get(`pod:${pod.key}`) || ZERO;
      if (o.hide) continue;
      const spr = signSprite(info.name, info.count, info.col, pod.signMax, info.hot);
      signRects.push({ key: pod.key, x: pod.x - 2 + Math.round(o.x), y: signBottom(pod) - spr.height + Math.round(o.y), w: spr.width, h: spr.height, name: info.name, clipped: !!spr.clipped });
    }
    const zones = signRects.slice();
    zones.push({ x: L.lounge.x + LOUNGE_SIGN_X, y: SIGN_BOTTOM - SIGN_H, w: LOUNGE_SIGN_RECT_W, h: SIGN_H });
    // ...and what a walker's NAME keeps off as well (its badge alone may pass): desk plates, meeting tables
    const soft = [];
    for (const r of L.rooms) {
      const o = offs.get(`room:${r.i}`) || ZERO;
      const ox = Math.round(o.x);
      const busy = !!env.room(r.i);
      zones.push({ x: r.x + 3 + ox, y: 0, w: G.ROOM - 6, h: busy ? 21 : 12 });
      if (busy) { const tr = tableRect(r); soft.push({ x: tr.x + ox, y: tr.y, w: tr.w + 2, h: 23 }); }
    }
    for (const dk of L.desks) {
      const o = offs.get(dk.id) || ZERO;
      soft.push({ x: dk.fx + 21 + Math.round(o.x), y: dk.cy + 35 + Math.round(o.y), w: 38, h: 12 });
    }

    for (const a of vis) {
      const d = a.data || {};
      const session = a.kind === 'session';
      const sel = a.id === selected;
      const hot = a.id === hover;
      const ax = Math.round(a.rx);
      const ay = Math.round(a.ry);
      const settled = !!(a.at && !a.path.length);
      // until it has arrived a character is a walker: no "!", no yellow plate (its desk card says ARRIVING)
      const waiting = session && settled && d.status === 'waiting';
      const quiet = session && settled && !waiting && d.unanswered === true && d.status !== 'waiting';
      const it = { a, ax, ay, session, sel, hot, waiting, quiet, settled, mode: settled ? a.at.t : 'walk', tag: null, alert: null, top: ay - 27, dim: hi != null && !isMember(a) };
      items.push(it);
      // only people who stay put count as faces to keep clear: a passer-by must not push tags around
      if (settled) heads.push({ id: a.id, x: ax - 7, y: ay - 25, w: 14, h: 15 });
      const mode = it.mode;
      if (waiting) {
        // beside the head, clear of the name tag: to the left at a desk, on the board side in a room
        it.alert = mode === 'boss' ? { x: ax + 7, y: ay - 44 } : { x: ax - 21, y: ay - 24 };
        blocks.push({ x: it.alert.x - 1, y: it.alert.y - 2, w: 15, h: 20 });
      }
      const cands = [];
      let prio = sel ? 100 : hot ? 90 : waiting ? 80 : 0;
      let dy = -10;
      let walker = false;
      if (session) {
        const tag = (variant) => tagSprite(a, variant, waiting, flash, quiet);
        if (mode === 'boss') {
          // the room's banner is this character's name tag
        } else if (mode === 'desk') {
          const dk = deskAt(L, a.at);
          const o = dk ? offs.get(dk.id) || ZERO : ZERO;
          const cx = dk ? dk.cx + Math.round(o.x) : ax - 17;
          const cy = dk ? dk.cy + Math.round(o.y) : ay - 42;
          // within its own desk cell, directly above its owner; the small font before it would stick out
          for (const variant of ['big', 'small', 'mini']) {
            const spr = tag(variant);
            if (spr.width > G.CELL - 7 && variant !== 'mini') continue;
            cands.push({ spr, x: clamp(Math.round(ax - spr.width / 2), cx + 1, cx + G.CELL - 6 - spr.width), y: cy + 16 - spr.height });
          }
          prio = prio || 50;
          dy = 0;
        } else if (mode === 'break') {
          const variants = sel || hot ? ['big', 'small', 'mini'] : ['small', 'mini'];
          for (const variant of variants) {
            const spr = tag(variant);
            cands.push({ spr, x: Math.round(ax - spr.width / 2), y: ay - 27 - spr.height });
          }
          prio = prio || (quiet ? 60 : 45);
        } else {
          // on the move: a compact badge only. Tool badge + name in the small font where the floor is
          // clear, the badge alone where the name would lie over a face, a desk plate or a table.
          walker = true;
          for (const variant of ['small', 'mini']) {
            const spr = tag(variant);
            cands.push({ spr, variant, x: Math.round(ax - spr.width / 2), y: ay - 27 - spr.height });
          }
          prio = prio || 40;
          dy = 0;
        }
      } else {
        const seat = mode === 'seat' ? a.at : null;
        const rec = a.parent;
        let wear = false;
        if (seat && rec) {
          if (!helperTags.has(rec.id)) helperTags.set(rec.id, rec.subs.size <= 4);
          wear = helperTags.get(rec.id);
        }
        if (sel || hot) {
          const spr = tagSprite(a, 'sub');
          const below = !!seat && seat.k >= 4;
          cands.push({ spr, x: Math.round(ax - spr.width / 2), y: below ? ay + 2 : ay - 26 - spr.height });
          dy = below ? 10 : -10;
        } else if (wear) {
          // few enough helpers: each wears its name, in two staggered rows so neighbours do not collide
          const spr = tagSprite(a, 'subc');
          const tier = seat.k % 2;
          cands.push({ spr, x: Math.round(ax - spr.width / 2), y: ay - 26 - spr.height - tier * 9 });
          prio = d.status === 'working' ? 20 : 10;
          dy = -9;
        }
        if (cands.length && seat && L.rooms[seat.room]) {
          const rx = L.rooms[seat.room].x + Math.round((offs.get(`room:${seat.room}`) || ZERO).x);
          for (const c of cands) c.x = clamp(c.x, rx + 3, rx + G.ROOM - 3 - c.spr.width);
        }
      }
      if (cands.length) wants.push({ it, prio, cands, dy, walker, zoned: mode !== 'desk' });
    }
    // away desks: a muted card says whose desk it is and where they went (click it to find them)
    for (const dk of L.desks) {
      const pod = pods.get(dk.pod);
      const id = pod && pod.owner[dk.i];
      const rec = id && sessions.get(id);
      if (!rec) continue;
      const a = rec.actor;
      if (a.at && a.at.t === 'desk' && !a.path.length && !a.snap) continue;
      const o = offs.get(dk.id) || ZERO;
      if (o.hide) continue;
      const cx = dk.cx + Math.round(o.x);
      const cy = dk.cy + Math.round(o.y);
      if (cx + G.CELL < camX || cx > camX + view.vw + 40) continue;
      const spr = awayCard(rec, hover === id);
      const it = { a, card: true, ax: dk.seat.x, ay: cy + 42, session: true, sel: false, hot: false, waiting: false, quiet: false, settled: false, mode: 'card', tag: null, alert: null, top: 0, dim: hi != null && rec.pod !== hi };
      wants.push({ it, prio: 30, cands: [{ spr, x: cx + 5, y: cy + 19 - spr.height }], dy: 0, walker: false, zoned: false });
    }

    wants.sort((p, q) => q.prio - p.prio);
    const placed = [];
    const free = (it, x, y, w, h, faces) => {
      for (const o of placed) if (hits(o, x, y, w, h, 1)) return false;
      for (const o of blocks) if (hits(o, x, y, w, h)) return false;
      if (faces) for (const o of heads) if (o.id !== it.a.id && hits(o, x, y, w, h)) return false;
      return true;
    };
    for (const wnt of wants) {
      let got = null;
      if (wnt.walker) {
        const a = wnt.it.a;
        for (const c of wnt.cands) {
          const w = c.spr.width;
          const h = c.spr.height;
          const name = c.variant === 'small';
          let ok = !over(zones, c.x, c.y, w, h, 1) && free(wnt.it, c.x, c.y, w, h, name);
          if (ok && name && over(soft, c.x, c.y, w, h)) ok = false;
          if (name) {
            // once it has shrunk to the badge it stays a badge for a moment: no flicker while weaving past desks
            if (!ok) { a.miniUntil = t + 1.2; continue; }
            if (t < (a.miniUntil || 0)) continue;
          }
          if (ok) { got = { spr: c.spr, x: c.x, y: c.y }; break; }
        }
      } else {
        // first choice: clear of every other tag, every "!" and everybody else's face; then a row further
        // from its owner; then the smaller versions; a tag that still finds no room is left out, never laid
        // over another one (whoever you point at or selected goes first, so that one always shows)
        const rows = wnt.dy ? 3 : 1;
        for (let faces = 1; faces >= 0 && !got; faces--) {
          for (const c of wnt.cands) {
            for (let n = 0; n < rows && !got; n++) {
              const y = c.y + n * wnt.dy;
              if (wnt.zoned && over(zones, c.x, y, c.spr.width, c.spr.height)) continue;
              if (free(wnt.it, c.x, y, c.spr.width, c.spr.height, !!faces)) got = { spr: c.spr, x: c.x, y };
            }
            if (got) break;
          }
        }
        if (!got && wnt.prio >= 90) got = { spr: wnt.cands[0].spr, x: wnt.cands[0].x, y: wnt.cands[0].y };
      }
      if (!got) continue;
      const tg = { a: wnt.it.a, it: wnt.it, spr: got.spr, x: got.x, y: got.y, w: got.spr.width, h: got.spr.height, card: !!wnt.it.card };
      wnt.it.tag = tg;
      if (!wnt.it.card) wnt.it.top = Math.min(wnt.it.top, got.y);
      placed.push(tg);
    }
    placedTags = placed;

    // helpers without a tag still say how they ended
    for (const it of items) {
      if (it.session || it.tag) continue;
      const d = it.a.data || {};
      b.globalAlpha = it.dim ? 0.45 : 1;
      if (d.status === 'done') b.drawImage(P.markDone, it.ax + 2, it.ay - 33);
      else if (d.status === 'failed') b.drawImage(P.markFail, it.ax + 2, it.ay - 31);
    }
    // activity bubbles and zzz (under the tags)
    for (const it of items) {
      const a = it.a;
      const d = a.data || {};
      const v = a.v;
      const { ax, ay } = it;
      b.globalAlpha = it.dim ? 0.45 : 1;
      if (it.session && d.status === 'working' && v.mode !== 'walk') {
        const kind = d.activity && P.bubbles[d.activity.kind] ? d.activity.kind : 'thinking';
        // the bubble hops once when the activity changes and then holds still (motion only with a cause)
        if (a.kindSeen !== kind) { a.kindAt = a.kindSeen == null ? -9 : t; a.kindSeen = kind; }
        const age = t - a.kindAt;
        const bob = still ? 0 : age < 0.25 ? 2 : age < 0.5 ? 1 : 0;
        if (v.mode === 'desk') b.drawImage(P.bubbles[kind][1], ax - 20, ay - 26 - bob);
        else if (v.mode === 'boss') b.drawImage(P.bubbles[kind][0], ax + 5, ay - 40 - bob);
      }
      if (v.zz) {
        const ph = still ? 0.3 : ((t + a.phase) * 0.5) % 1;
        b.drawImage(P.zed, ax + 5 + Math.round(ph * 5), ay - 28 - Math.round(ph * 9));
        const ph2 = (ph + 0.5) % 1;
        if (!still) b.drawImage(P.zed, ax + 5 + Math.round(ph2 * 5), ay - 28 - Math.round(ph2 * 9));
      } else if (!still && v.mode === 'break' && v.dir === 'B' && v.pose === 'type' && Math.floor(t * 2 + a.phase) % 3 === 0) {
        b.drawImage(P.note, ax + 8, ay - 34);
      }
    }
    // tags, least important first; around them the hover outline (thin white) and the selection brackets
    for (let i = placed.length - 1; i >= 0; i--) {
      const tg = placed[i];
      b.globalAlpha = tg.it.dim ? 0.45 : 1;
      b.drawImage(tg.spr, tg.x, tg.y);
      if (tg.card) continue;
      if (tg.it.sel) { b.globalAlpha = 1; brackets(b, tg.x, tg.y, tg.w, tg.h); }
      else if (tg.it.hot) {
        R(b, WHITE, tg.x - 1, tg.y - 1, tg.w + 2, 1);
        R(b, WHITE, tg.x - 1, tg.y + tg.h, tg.w + 2, 1);
        R(b, WHITE, tg.x - 1, tg.y, 1, tg.h);
        R(b, WHITE, tg.x + tg.w, tg.y, 1, tg.h);
      }
    }
    // still waiting from earlier, and no tag to carry the mark (a crowd): the same steady "!" by the head
    for (const it of items) {
      if (!it.quiet || it.tag || it.mode === 'boss') continue;
      b.globalAlpha = it.dim ? 0.7 : 1;
      b.drawImage(P.quiet, it.ax + 4, it.ay - 32);
    }
    b.globalAlpha = 1;
    // desks being carried to another spot: a puff of dust over where each was and where it lands
    if (poofs.length) {
      const now = anim;
      for (let i = poofs.length - 1; i >= 0; i--) {
        const pf = poofs[i];
        const p = (now - pf.t0) / POOF_MS;
        if (p >= 1 || p < 0) { poofs.splice(i, 1); continue; }
        const spr = P.puff[p < 0.2 || p > 0.8 ? 0 : 1]; // (the two small sizes only: it is one desk)
        b.drawImage(spr, Math.round(pf.x0), Math.round(pf.y0) - 1);
        if (pf.x1 !== pf.x0 || pf.y1 !== pf.y0) b.drawImage(spr, Math.round(pf.x1), Math.round(pf.y1) - 1);
      }
    }
    // "needs you" alerts and the selection arrow go on top of everything
    let selIt = null;
    for (const it of items) {
      b.globalAlpha = it.dim ? 0.7 : 1;
      if (it.alert) {
        // a slow hop and a flash between the two yellows: loud enough to find, calm enough to live with
        const hop = still ? 0 : [0, -1, -2, -1][Math.floor(env.pulse * 4) % 4];
        const bx = it.alert.x;
        const by = it.alert.y + hop;
        b.drawImage(P.alert[flash ? 0 : 1], bx, by);
        if (Math.abs(bx + 6 - it.ax) < 10) it.top = Math.min(it.top, by);
      }
      if (it.a.id === selected) selIt = it;
    }
    b.globalAlpha = 1;
    if (selIt) drawArrow(selIt, placed, zones, blocks, soft, camX, camY);

    // pointing at a sign whose name did not fit shows the whole name
    if (hoverSign != null) {
      const sr = signRects.find((r) => r.key === hoverSign);
      if (sr && sr.clipped) {
        const tip = boxSprite([[sr.name, WHITE]]);
        const lo = camX + view.ux + 2;
        const x = clamp(sr.x, lo, Math.max(lo, camX + view.ux + view.uw - 2 - tip.width));
        b.drawImage(tip, x, sr.y - tip.height - 1);
      }
    }
    // pointing at someone says what they are working on
    const ha = hover && hover !== selected ? actors.get(hover) : null;
    if (ha && !ha.hidden && ha.v) {
      const tip = tipSprite(ha);
      const it = items.find((x) => x.a === ha && !x.card);
      if (tip && it) drawTip(tip, it, placed, zones, heads, blocks, soft, camX, camY);
    }
  }

  /** The part of the canvas that is neither under app chrome nor under an open panel, in world px. */
  function clearView(camX, camY) {
    const x0 = camX + view.ux;
    const y0 = camY + view.uy;
    return { x0, y0, x1: x0 + view.uw - (overlay.right * view.dpr) / view.s, y1: y0 + view.uh - (overlay.bottom * view.dpr) / view.s };
  }

  /**
   * The selection arrow: big, white, dark-edged, hopping. It points down at the name tag from above when
   * that spot is free; where a pod sign, a room banner or somebody else's tag is in the way (the top row
   * of desks sits right under the pod signs) it stands beside the tag and points sideways, or under the
   * feet pointing up. It never covers a zone sign.
   */
  function drawArrow(it, placed, zones, blocks, soft, camX, camY) {
    const hop = still ? 0 : [0, 1, 2, 3, 2, 1][Math.floor(t * 7) % 6];
    const tg = it.tag;
    const A = P.arrows;
    const vw = clearView(camX, camY);
    const top = it.top - (tg ? 3 : 0);
    // (a boss has no tag of its own: the arrow stands over its head, a little to the board side, clear of its bubble)
    const cx = tg ? Math.round(tg.x + tg.w / 2) : it.mode === 'boss' ? it.ax - 4 : it.ax;
    const midY = tg ? Math.round(tg.y + tg.h / 2) : it.ay - 17;
    const left = tg ? tg.x - 3 : it.ax - 11;
    const right = tg ? tg.x + tg.w + 3 : it.ax + 11;
    // each: sprite, resting position, hop direction, and the box it sweeps
    const onRight = (y) => ({ spr: A.left, x: right + 1, y, hx: 1, hy: 0, bx: right + 1, by: y, bw: 13, bh: 15 });
    const onLeft = (y) => ({ spr: A.right, x: left - 11, y, hx: -1, hy: 0, bx: left - 14, by: y, bw: 13, bh: 15 });
    const cands = [
      { spr: A.down, x: cx - 7, y: top - 11, hx: 0, hy: -1, bx: cx - 7, by: top - 14, bw: 15, bh: 13 },
      onRight(midY - 7),
      onRight(midY - 4), // a little lower: clear of a sign that stands right above the tag
      onLeft(midY - 7),
      onLeft(midY - 4),
      { spr: A.up, x: it.ax - 7, y: it.ay + 4, hx: 0, hy: 1, bx: it.ax - 7, by: it.ay + 4, bw: 15, bh: 13 },
    ];
    const inside = (c) => c.bx >= vw.x0 && c.by >= vw.y0 && c.bx + c.bw <= vw.x1 && c.by + c.bh <= vw.y1;
    const clean = (c) => !over(zones, c.bx, c.by, c.bw, c.bh, 1);
    const lonely = (c) => !over(placed, c.bx, c.by, c.bw, c.bh, 0, tg) && !over(blocks, c.bx, c.by, c.bw, c.bh);
    // ...nor the name plate of a desk (the row above, the neighbour) or a meeting table, where there is a choice
    const bare = (c) => !over(soft, c.bx, c.by, c.bw, c.bh);
    const pick = cands.find((c) => inside(c) && clean(c) && lonely(c) && bare(c)) || cands.find((c) => inside(c) && clean(c) && lonely(c)) || cands.find((c) => inside(c) && clean(c)) || cands.find(clean) || cands[0];
    b.drawImage(pick.spr, pick.x + pick.hx * hop, pick.y + pick.hy * hop);
  }

  /**
   * The hover tip goes where it hides least: above the character first, then beside it, then below.
   * Every spot is kept inside the visible canvas and scored by what it would cover (zone signs count
   * most, then other people's name tags and "!" bubbles, then faces and desk plates).
   */
  function drawTip(tip, it, placed, zones, heads, blocks, soft, camX, camY) {
    const vw = clearView(camX, camY);
    const w = tip.width;
    const h = tip.height;
    const tg = it.tag;
    const x0 = Math.min(it.ax - 10, tg ? tg.x : it.ax);
    const x1 = Math.max(it.ax + 10, tg ? tg.x + tg.w : it.ax);
    const y0 = Math.min(it.top, it.ay - 27) - (tg && it.hot ? 1 : 0);
    const y1 = it.ay + 3;
    const cxm = Math.round((x0 + x1) / 2);
    const fitX = (x) => clamp(x, vw.x0 + 2, Math.max(vw.x0 + 2, vw.x1 - 2 - w));
    const fitY = (y) => clamp(y, vw.y0 + 2, Math.max(vw.y0 + 2, vw.y1 - 2 - h));
    const spots = [
      { x: fitX(cxm - (w >> 1)), y: y0 - h - 2 },
      { x: x1 + 3, y: fitY(Math.round((y0 + y1) / 2) - (h >> 1)) },
      { x: x0 - 3 - w, y: fitY(Math.round((y0 + y1) / 2) - (h >> 1)) },
      { x: fitX(cxm - (w >> 1)), y: y1 + 3 },
    ];
    let bestSpot = null;
    let bestCost = Infinity;
    spots.forEach((sp, i) => {
      let cost = i * 4; // earlier spots win ties
      if (sp.x < vw.x0 + 1 || sp.x + w > vw.x1 - 1 || sp.y < vw.y0 + 1 || sp.y + h > vw.y1 - 1) cost += 1e6;
      for (const o of zones) cost += overlap(o, sp.x, sp.y, w, h) * 4;
      for (const o of placed) if (o !== tg) cost += overlap(o, sp.x, sp.y, w, h) * (o.card ? 1 : 3);
      for (const o of blocks) cost += overlap(o, sp.x, sp.y, w, h) * 3;
      for (const o of heads) if (o.id !== it.a.id) cost += overlap(o, sp.x, sp.y, w, h) * 2;
      for (const o of soft) cost += overlap(o, sp.x, sp.y, w, h);
      if (cost < bestCost) { bestCost = cost; bestSpot = sp; }
    });
    b.drawImage(tip, fitX(bestSpot.x), fitY(bestSpot.y));
  }

  /**
   * When the office is wider than the window: a tab on each side that has more, half-way up the visible
   * part of the office, with a big chevron. It turns yellow with "!" (and how many) when someone over there
   * needs you: flashing for a fresh one, steady for one still waiting from earlier. The edge itself is
   * shaded so the cut reads as "there is more", not as the end of the office. A click on a tab pans that way.
   */
  function drawEdges(camX, camY) {
    edgeRects = [];
    const bd = camBounds();
    if (!bd.panX) return;
    const cv = clearView(camX, camY);
    let needL = 0;
    let needR = 0;
    let loudL = false;
    let loudR = false;
    for (const a of actors.values()) {
      if (a.kind !== 'session' || a.hidden || !a.data) continue;
      const loud = a.data.status === 'waiting';
      if (!loud && a.data.unanswered !== true) continue;
      if (a.x < cv.x0 + 6) { needL++; loudL = loudL || loud; } else if (a.x > cv.x1 - 6) { needR++; loudR = loudR || loud; }
    }
    const tab = (left, need, loud) => {
      const w = 17;
      const h = need ? 36 : 28;
      const x = Math.round(left ? cv.x0 + 3 : cv.x1 - 3 - w);
      const y = Math.round((cv.y0 + cv.y1) / 2 - h / 2);
      // the edge fades out
      for (let i = 0; i < 4; i++) {
        b.fillStyle = `rgba(22,16,30,${0.32 - i * 0.07})`;
        b.fillRect(left ? cv.x0 + i * 3 : cv.x1 - (i + 1) * 3, cv.y0, 3, cv.y1 - cv.y0);
      }
      const hot = hoverEdge === (left ? -1 : 1);
      // yellow = someone over there needs you; it only flashes for the fresh ones
      R(b, K, x - 1, y - 1, w + 2, h + 2);
      box(b, x, y, w, h, need ? (!loud || env.flash ? C.alert : C.alertDim) : C.tagBg, need ? K : WHITE);
      if (hot) { R(b, WHITE, x - 1, y - 1, w + 2, 1); R(b, WHITE, x - 1, y + h, w + 2, 1); R(b, WHITE, x - 1, y, 1, h); R(b, WHITE, x + w, y, 1, h); }
      const ink = need ? K : WHITE;
      const tip = left ? x + 5 : x + w - 6;
      const my = y + 13;
      for (let i = 0; i < 7; i++) {
        const px = left ? tip + i : tip - i - 1;
        R(b, ink, px, my - i - 1, 2, 2);
        R(b, ink, px, my + i, 2, 2);
      }
      if (need) {
        const label = `!${need > 1 ? need : ''}`;
        drawText(b, label, x + Math.max(2, (w - textWidth(label, BIG)) >> 1), y + h - 10, ink, BIG);
      }
      edgeRects.push({ dir: left ? -1 : 1, x: x - 2, y: y - 2, w: w + 4, h: h + 4 });
    };
    // (a tab only where part of the office really is outside the window, not for the few px of slack at its ends)
    if (cv.x0 > 2 || needL) tab(true, needL, loudL);
    if (cv.x1 < L.W - 2 || needR) tab(false, needR, loudR);
  }

  // ---------------------------------------------------------------- loop
  // The simulation runs on REAL elapsed time (performance.now()), whoever calls tick(): an animation frame,
  // the watchdog, a new state. Frames that come late are caught up in fixed slices; when more than
  // CATCH_UP seconds went by unseen (a throttled pane, a hidden tab, the machine asleep) nobody is shown
  // half-way through a walk that was over long ago: everyone is put where they belong and the first frame
  // is right. A page that reports itself hidden never shows a walk at all: it repaints on news and on a
  // slow heartbeat, always with everyone in place.
  let raf = 0;
  let dog = 0;
  let beat = 0;
  let last = 0;
  function tick() {
    if (destroyed) return;
    const now = performance.now();
    const gap = last ? Math.max(0, (now - last) / 1000) : 0;
    last = now;
    if (document.hidden || gap > CATCH_UP) {
      t += gap * timeScale;
      settleAll();
      advance(0);
    } else advance(gap * timeScale);
    const cost = performance.now() - now;
    stats.ms = stats.ms * 0.95 + cost * 0.05;
    if (cost > stats.max) stats.max = cost;
    stats.frames++;
  }
  function frame() {
    raf = 0;
    tick();
    wake();
  }
  function watchdog() {
    dog = 0;
    if (destroyed) return;
    if (!document.hidden && performance.now() - lastPaint > 240) {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      tick();
    }
    wake();
  }
  function heartbeat() {
    beat = 0;
    if (destroyed) return;
    if (document.hidden && performance.now() - lastPaint > HIDDEN_BEAT - 200) tick();
    wake();
  }
  /** Advance the world by `dt` seconds of world time (in fixed slices) and draw. */
  function advance(dt) {
    // fixed slices; a very long step (the harness fast-forwarding a minute) uses coarser ones, never more than 240
    const slice = Math.max(SLICE, dt / 240);
    let left = dt;
    while (left > 1e-6) {
      const d = Math.min(left, slice);
      update(d);
      left -= d;
    }
    ease(dt / Math.max(1, timeScale));
    const now = new Date();
    if (skyAt(now.getHours() + now.getMinutes() / 60).key !== skyKey) rebuildScene();
    if ((window.devicePixelRatio || 1) !== view.dpr) fit(); // dragged to another display
    rehover();
    render();
  }
  function wake() {
    if (destroyed) return;
    if (document.hidden) {
      if (!beat) beat = setTimeout(heartbeat, HIDDEN_BEAT);
      return;
    }
    if (!raf) raf = requestAnimationFrame(frame);
    if (!dog) dog = setTimeout(watchdog, 300);
  }
  /** Something changed through the API: show it soon even if the page is hidden (no animation frames). */
  let poked = 0;
  function poke() {
    wake();
    if (destroyed || !document.hidden || poked) return;
    poked = setTimeout(() => { poked = 0; if (!destroyed && document.hidden) tick(); }, 60);
  }
  function onVisibility() {
    if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
    // back in view: tick() measures how long it has been and fast-forwards if that was more than a moment
    if (!document.hidden) tick();
    wake();
  }
  document.addEventListener('visibilitychange', onVisibility);

  // ---------------------------------------------------------------- input
  function toWorld(e) {
    const rect = canvas.getBoundingClientRect();
    const kx = canvas.width / Math.max(1, rect.width) / drawn.s;
    const ky = canvas.height / Math.max(1, rect.height) / drawn.s;
    return { x: (e.clientX - rect.left) * kx + drawn.x, y: (e.clientY - rect.top) * ky + drawn.y };
  }
  /** What is under the pointer: { id } for a character (or its tag, its desk card, its room banner), { sign } for a pod sign. */
  function pickAt(e) {
    const w = toWorld(e);
    for (const er of edgeRects) if (w.x >= er.x && w.x < er.x + er.w && w.y >= er.y && w.y < er.y + er.h) return { edge: er.dir };
    for (const tg of placedTags) if (w.x >= tg.x && w.x < tg.x + tg.w && w.y >= tg.y && w.y < tg.y + tg.h) return { id: tg.a.id };
    let best = null;
    let bestY = -1e9;
    for (const a of actors.values()) {
      if (a.hidden || a.snap) continue;
      if (w.x >= a.rx - 9 && w.x <= a.rx + 9 && w.y >= a.ry - 27 && w.y <= a.ry + 1 && a.ry > bestY) { best = a; bestY = a.ry; }
    }
    if (best) return { id: best.id };
    if (w.y >= 1 && w.y < 21) {
      for (const r of L.rooms) {
        const rx = r.x + Math.round((offs.get(`room:${r.i}`) || ZERO).x);
        if (w.x < rx + 3 || w.x >= rx + G.ROOM - 3) continue;
        const id = roomOwner[r.i];
        const a = id != null ? actors.get(id) : null;
        if (a && !a.hidden && !a.snap) return { id };
      }
    }
    for (const sr of signRects) if (w.x >= sr.x && w.x < sr.x + sr.w && w.y >= sr.y && w.y < sr.y + sr.h) return { sign: sr.key };
    return null;
  }
  function setHover(hit) {
    const id = hit && hit.id != null ? hit.id : null;
    const sign = hit && hit.sign != null ? hit.sign : null;
    const edge = hit && hit.edge ? hit.edge : 0;
    canvas.style.cursor = hit ? 'pointer' : '';
    if (id === hover && sign === hoverSign && edge === hoverEdge) return;
    hover = id;
    hoverSign = sign;
    hoverEdge = edge;
    kick();
  }
  /** Show what the pointer just changed at once, also in a pane that delivers few animation frames. */
  let kicked = 0;
  function kick() {
    if (destroyed || kicked) return;
    kicked = setTimeout(() => { kicked = 0; if (!destroyed && performance.now() - lastPaint > 24) tick(); }, 0);
  }
  const drag = { on: false, moved: false, sx: 0, sy: 0, cx: 0, cy: 0, id: -1 };
  function onDown(e) {
    if (e.button != null && e.button !== 0) return;
    drag.on = true; drag.moved = false;
    drag.sx = e.clientX; drag.sy = e.clientY;
    drag.cx = cam.tx; drag.cy = cam.ty;
    drag.id = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  }
  function onMove(e) {
    if (drag.on) {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        const bd = camBounds();
        const k = view.dpr / view.s;
        if (bd.panX) cam.tx = cam.x = clamp(drag.cx - dx * k, bd.minX, bd.maxX);
        if (bd.panY) cam.ty = cam.y = clamp(drag.cy - dy * k, bd.minY, bd.maxY);
        roamed = true;
        canvas.style.cursor = bd.panX || bd.panY ? 'grabbing' : '';
        return;
      }
    }
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.inside = true;
    setHover(pickAt(e));
  }
  /** People walk; the pointer may be standing still. Re-check what is under it every frame. */
  function rehover() {
    if (!ptr.inside || drag.on || !drawn.ok) return;
    const hit = pickAt({ clientX: ptr.x, clientY: ptr.y });
    setHover(hit);
  }
  function emitGroup(key) {
    const gid = key === NO_GROUP ? 'none' : key;
    if (!groupListeners.size) {
      // nobody is listening (the shell has no group filter wired up): the sign toggles the highlight itself
      hi = hi === key ? null : key;
      poke();
      return;
    }
    for (const fn of groupListeners) { try { fn(gid); } catch (err) { console.error('[office] onGroupSelect listener failed', err); } }
  }
  function onUp(e) {
    if (!drag.on) return;
    drag.on = false;
    try { canvas.releasePointerCapture(drag.id); } catch { /* fine */ }
    if (drag.moved) { canvas.style.cursor = ''; return; }
    const hit = pickAt(e);
    if (hit && hit.edge) {
      // the "more this way" tab: most of a window further
      const bd = camBounds();
      cam.tx = clamp(cam.tx + hit.edge * view.uw * 0.6, bd.minX, bd.maxX);
      roamed = true;
      poke();
      return;
    }
    if (hit && hit.sign != null) { emitGroup(hit.sign); return; }
    const id = hit ? hit.id : null;
    selected = id;
    poke();
    for (const fn of listeners) { try { fn(id); } catch (err) { console.error('[office] onSelect listener failed', err); } }
  }
  function onLeave() { ptr.inside = false; if (!drag.on) setHover(null); }
  function onWheel(e) {
    const bd = camBounds();
    if (!bd.panX && !bd.panY) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : 1;
    const k = (view.dpr / view.s) * unit;
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (!bd.panY && Math.abs(dx) < Math.abs(dy)) { dx = dy; dy = 0; } // a plain wheel scrolls the belt sideways
    if (e.shiftKey && !e.deltaX) { dx = e.deltaY; dy = 0; }
    cam.tx = clamp(cam.tx + dx * k, bd.minX, bd.maxX);
    cam.ty = clamp(cam.ty + dy * k, bd.minY, bd.maxY);
    roamed = true;
  }
  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir) return;
    const bd = camBounds();
    if ((dir[0] && !bd.panX) || (dir[1] && !bd.panY)) return;
    e.preventDefault();
    cam.tx = clamp(cam.tx + dir[0] * 48, bd.minX, bd.maxX);
    cam.ty = clamp(cam.ty + dir[1] * 32, bd.minY, bd.maxY);
    roamed = true;
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  if (ro) ro.observe(canvas);
  window.addEventListener('resize', fit);

  // ---------------------------------------------------------------- selection
  function reveal(a) {
    const bd = camBounds();
    if (!bd.panX && !bd.panY) return;
    const m = 20;
    const sx = a.x - cam.tx;
    const sy = a.y - cam.ty;
    const offX = sx < view.ux + m || sx > view.ux + view.uw - m;
    const offY = sy - 30 < view.uy || sy > view.uy + view.uh - 4;
    if (offX) cam.tx = clamp(a.x - view.ux - view.uw / 2, bd.minX, bd.maxX);
    if (offY) cam.ty = clamp(a.y - 14 - view.uy - view.uh / 2, bd.minY, bd.maxY);
    if (offX || offY) roamed = true;
  }
  function select(id) {
    selected = id == null || id === '' ? null : String(id);
    poke();
    if (!selected) return;
    const a = selActor();
    if (a && !a.hidden) reveal(a);
  }

  fit();
  if (staticLayer) render(); // an (empty) office from the very first moment, whatever the tab is doing
  last = performance.now();
  wake();

  return {
    setState,
    select,
    /** Register a click listener; returns a function that removes it. */
    onSelect(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    resize: fit,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (dog) clearTimeout(dog);
      if (beat) clearTimeout(beat);
      if (poked) clearTimeout(poked);
      if (kicked) clearTimeout(kicked);
      if (overlayTimer) clearTimeout(overlayTimer);
      raf = 0; dog = 0; beat = 0; poked = 0; overlayTimer = 0;
      if (ro) ro.disconnect();
      window.removeEventListener('resize', fit);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      listeners.clear();
      groupListeners.clear();
      panListeners.clear();
      actors.clear();
      sessions.clear();
      canvas.style.cursor = '';
    },
    // ---- extras beyond the contract
    setInsets,
    /** Panels that slide over the office ({right, bottom} in CSS px): the scale stays unless the selected character and the top of its zone cannot both be shown. */
    setOverlay,
    /**
     * Dim everything except one group: its pod, its members wherever they are, its meeting rooms.
     * Pass a Group id, 'none' for the sessions without a group, or null to clear.
     */
    highlightGroup(id) {
      hi = id == null || id === '' ? null : String(id) === 'none' ? NO_GROUP : String(id);
      poke();
    },
    /** fn(groupId) when the user clicks a pod's sign ('none' for the default bullpen's). Returns an unsubscribe function. */
    onGroupSelect(fn) {
      if (typeof fn !== 'function') return () => {};
      groupListeners.add(fn);
      return () => groupListeners.delete(fn);
    },
    /** fn(panning) whenever the office starts or stops being bigger than the window. Returns an unsubscribe function. */
    onPanChange(fn) {
      if (typeof fn !== 'function') return () => {};
      panListeners.add(fn);
      return () => panListeners.delete(fn);
    },
    /** Multiply animation/walking speed (the dev harness fast-forwards with this). */
    setTimeScale(n) { timeScale = clamp(+n || 1, 0.1, 64); },
    /** Force reduced motion on/off, or pass null to follow the OS setting again. */
    setReducedMotion(v) { still = v == null ? !!(mq && mq.matches) : !!v; poke(); },
    /** Read-only numbers for tests and the debug overlay. */
    getInfo() {
      const bd = camBounds();
      const k = drawn.s / view.dpr;
      const rk = view.s / view.dpr;
      const max = stats.max;
      stats.max = 0; // worst frame since the last getInfo()
      stats.maxSeen = max;
      return {
        scale: view.s, baseScale: view.base, dpr: view.dpr, cssScale: view.s / view.dpr, zooming: zoom.on, fading: false,
        // clock = world seconds simulated so far; walking = characters on the move; sliding = furniture / rooms still gliding
        clock: +t.toFixed(3), walking: [...actors.values()].filter((a) => !a.hidden && (a.path.length || !a.at)).length, sliding: offs.size + poofs.length,
        world: { w: L.W, h: L.H, rows: L.rows, extra: L.extra, cols: L.cols, rooms: L.nRooms },
        // panning: the office is bigger than the window and can be dragged / scrolled (see onPanChange).
        // layout: the floor plan in force: `rev` counts re-plans, `cause` says what the last one was for
        // ('boot' | 'first' | 'viewport' | 'group' | 'overflow' | 'quiet'), `at` = world clock then.
        panning: bd.panX || bd.panY, layout: { rev: why.rev, cause: why.cause, at: +why.at.toFixed(1), pending: quiet.at ? quiet.cause : null },
        viewport: { w: view.vw, h: view.vh, usableW: Math.floor(view.uw), usableH: Math.floor(view.uh) },
        camera: { x: Math.round(cam.x), y: Math.round(cam.y), panX: bd.panX, panY: bd.panY, shiftX: Math.round(cam.sx), shiftY: Math.round(cam.sy) },
        actors: actors.size, sessions: sessions.size, selected, hover, highlight: hi == null ? null : hi === NO_GROUP ? 'none' : hi,
        // where the furniture stands when nothing is gliding (CSS px on the canvas, camera at rest, no selection
        // shift): `origin` = the office's top-left corner, each pod's `rect` and `seats` (one per desk that is
        // shown: slot, x, y, owner session id or null), and `rooms`. The harness' soak check watches these.
        origin: { x: (0 - cam.tx) * rk, y: (0 - cam.ty) * rk },
        rooms: L.rooms.map((r) => ({ i: r.i, x: (r.x - cam.tx) * rk, y: (0 - cam.ty) * rk, w: G.ROOM * rk, owner: roomOwner[r.i] || null, closing: !roomOwner[r.i] && !!roomGhost[r.i] })),
        // pods in display order; `sign` is where the pod's sign is on the canvas, in CSS px (null = no sign)
        pods: L.pods.map((p) => {
          const info = podInfo(p.key);
          const sr = signRects.find((r) => r.key === p.key);
          const own = (pods.get(p.key) || { owner: [] }).owner;
          return {
            groupId: p.key === NO_GROUP ? 'none' : p.key, name: info && info.sign ? info.name : null, members: info ? info.count : own.filter((x) => x != null).length,
            cols: p.uc, rows: p.ur, desks: p.n, stacked: !!p.under,
            sign: sr ? { x: (sr.x - drawn.x) * k, y: (sr.y - drawn.y) * k, w: sr.w * k, h: sr.h * k } : null,
            rect: { x: (p.x - cam.tx) * rk, y: (p.y - cam.ty) * rk, w: p.w * rk, h: (p.bottom - p.y) * rk },
            seats: p.desks.filter((d) => d.shown).map((d) => ({ i: d.i, x: (d.cx - cam.tx) * rk, y: (d.cy - cam.ty) * rk, owner: own[d.i] || null })),
          };
        }),
        frameMs: +stats.ms.toFixed(2), frameMaxMs: +stats.maxSeen.toFixed(2), frames: stats.frames, lastPaintAgo: Math.round(performance.now() - lastPaint), reducedMotion: still,
      };
    },
    /** Where an actor is on the canvas, in CSS px (null if it is not in the office). */
    locate(id) {
      const a = actors.get(String(id));
      if (!a || a.hidden) return null;
      const k = drawn.s / view.dpr;
      return { x: (a.x - drawn.x) * k, y: (a.y - 14 - drawn.y) * k, walking: !!a.path.length || !a.at };
    },
    /** Advance the simulation by `seconds` and draw, without waiting for animation frames. */
    advance(seconds = 0) { if (!destroyed) { advance(Math.max(0, +seconds || 0)); last = performance.now(); } },
  };
}
