// TOWER world: model (floors, desks, meeting rooms, elevator, characters), simulation and canvas rendering.
// One floor per project. All positions are in "logical pixels"; at rest the canvas is an integer number of
// device pixels per logical pixel, so every glyph of the bitmap fonts lands on whole pixels.
//
// Sizing rules, in order:
//   - the building's width comes from the data (longest sign, busiest floor), never from the zoom, so desks stay put;
//   - the scale is the largest integer that shows the settled building, but never below 2 CSS px per logical px
//     (below that the small font stops being readable); a taller tower scrolls instead, with the floor index as its map;
//   - fewer than three projects are padded with unlit FOR LEASE floors so it still reads as a tower.

import { drawText, textWidth, textCanvas, fitLabel, minChars } from './font.js';
import { INK, WHITE, toolOf, hash, mk, stamp, lookFor, sprite, drawPortrait, CROWN, BANG, bubble, chip, CLOUD, lerpHex } from './art.js';

const PITCH = 36, SLAB = 4, ROOM = 32, MINI = 14;
const LOBBY = 40, LROOM = 36;
const WALL = 5, BAY = 46, CONF_W = 152, LAND = 10, SHAFT = 34;
const GROUND = 18, ROOF_H = 34, SKY_PAD = 4;
const WALK = 66, SEATS = 6, CAR_CAP = 4;
const MIN_IW = 360;      // narrowest interior the lobby furniture fits in
const MIN_STOREYS = 3;   // floors above the lobby; unlit FOR LEASE floors make up the difference
const MARGIN = 4;        // logical px kept clear either side of the building
const LIFT_ROOM = 17;    // height of the lift machine room on the roof
const FLAT_ROOF = 7;     // roof height once the rooftop clutter has been folded away to make every floor fit
const YELLOW = '#f8d830';

const WALLS = [
  ['#2c3c78', '#1c2858', '#4458a0'], ['#1e5c50', '#124038', '#2e8070'], ['#4c3074', '#341e54', '#6c4c9c'], ['#6c4428', '#4c2c18', '#906038'],
  ['#3c4860', '#283040', '#586880'], ['#6c2c40', '#4c1c2c', '#903c58'], ['#2c5c2c', '#1c401c', '#3c803c'], ['#5c5428', '#403818', '#807838'],
];

const SPOTS = [
  { x: 105, pose: 'couch' }, { x: 121, pose: 'couch' }, { x: 137, pose: 'couch' }, { x: 263, pose: 'play' }, { x: 247, pose: 'drink' },
  { x: 309, pose: 'couch' }, { x: 325, pose: 'couch' }, { x: 194, pose: 'vend' }, { x: 362, pose: 'stand' }, { x: 378, pose: 'stand' },
];

const SKY = [
  [0, ['#080820', '#0c0c2c', '#101038', '#181848', '#202058'], 1],
  [5, ['#080820', '#0c0c2c', '#101038', '#181848', '#202058'], 1],
  [6.5, ['#283070', '#584088', '#b05880', '#f08860', '#f8c078'], 0.3],
  [8, ['#3070d8', '#4488e8', '#60a0f0', '#80b8f8', '#a8d4f8'], 0],
  [16.5, ['#3070d8', '#4488e8', '#60a0f0', '#80b8f8', '#a8d4f8'], 0],
  [18.2, ['#283078', '#683890', '#c04870', '#f07848', '#f8b050'], 0.3],
  [19.6, ['#0c0c2c', '#141440', '#201c50', '#30245c', '#402c60'], 0.9],
  [21, ['#080820', '#0c0c2c', '#101038', '#181848', '#202058'], 1],
  [24, ['#080820', '#0c0c2c', '#101038', '#181848', '#202058'], 1],
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createWorld(canvas, hooks = {}) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const qs = new URLSearchParams(location.search);
  const forcedHour = qs.has('hour') ? Number(qs.get('hour')) : null;
  const forcedDpr = Number(qs.get('dpr')) || 0; // dev aid: pretend to be a 1x display

  // view: CW/CH canvas device px, S target scale (integer device px per logical px), Z the scale being drawn (eases to S)
  let dpr = 1, CW = 0, CH = 0, S = 4, Z = 4, VW = 800, VH = 500, viewTx = 0, viewTy = 0;
  // building: sign width follows the longest project name, SPAN the busiest floor (desks + meeting rooms)
  let SIGN_W = 96, signN = 11, SPAN = MIN_IW - LAND - 96, IW = 0, BW = 0, bx = 1, bxF = NaN, availPx = 0;
  let zoom = 0, fitS = 0, upCand = 0, upAt = 0, shrinkAt = 0, lastFit = 0;
  let panelCss = 0, panelBottomCss = 0, dlgCss = 0, hudCss = 46;
  let loaded = false, roofY = -LOBBY, leaseBase = -LOBBY, lastNow = performance.now();
  const lease = { h: 0 }; // total height of the FOR LEASE floors stacked above the real ones
  let sel = null, hover = null, follow = false, drag = null;
  let doorOpen = 0, sky = null, skyAt = 0, errors = 0, barA = 0;
  let flat = false, roofLift = 1; // flat: no room for the rooftop sign and tank; roofLift eases 1 -> 0 as they sink away
  const cam = { x: 0, tx: 0, b: GROUND, tb: GROUND, lo: GROUND, hi: GROUND, xhi: 0 };
  const lobby = { key: '@lobby', name: 'LOBBY', lobby: true, y: 0, h: LOBBY, state: 'open', back: null, front: null, cacheKey: '' };
  const floors = [];
  const floorByKey = new Map();
  const ents = new Map();
  const spots = [];
  const hits = [];
  const car = { y: 0, floor: lobby, target: null, state: 'idle', t: 0, riders: [], moveT: 0, spin: 0 };
  let leaseArt = null, leaseKey = '';

  // ------------------------------------------------------------ layout

  const roomX = (j) => SIGN_W + SPAN - (j + 1) * CONF_W;
  const seatX = (j, seat) => roomX(j) + 62 + seat * 14;
  const lobbyX = (x) => (x <= 84 ? x : Math.round(84 + (x - 84) * ((IW - 110) / (396 - 110))));
  const camTop = () => cam.b - VH;
  const roofVis = () => FLAT_ROOF + (ROOF_H - FLAT_ROOF) * roofLift;

  const softMin = () => Math.max(2, Math.ceil(2 * dpr - 0.01));   // 2 CSS px per logical px: 5px font = 10 CSS px
  const hardMin = () => Math.max(2, Math.ceil(1.5 * dpr - 0.01)); // only when the window is too narrow for softMin
  const maxScale = () => Math.max(softMin(), Math.round(5 * dpr));

  /** Settled height of everything from the street to the top of the roof, in logical px. */
  function contentH(extra = 0) {
    let h = GROUND + LOBBY + (flat ? FLAT_ROOF : ROOF_H) + SKY_PAD + extra, n = 0;
    for (const f of floors) {
      if (f.state === 'closing' || f.state === 'dark') continue;
      h += f.want;
      n++;
    }
    return h + Math.max(0, MIN_STOREYS - n) * PITCH;
  }

  /** Width the building may use at scale s: the whole window when its roof stays below the floor index, else what is left of it. */
  function widthAt(s, Hc) {
    const panel = panelCss * dpr;
    if (BW * s <= CW - 2 * panel) return CW; // centred, it never reaches the index
    // only the lift machine room stands at that end of the roof (the tall things are further left)
    const roofRight = CH - (Hc - (flat ? FLAT_ROOF : ROOF_H) - SKY_PAD + LIFT_ROOM + 3) * s;
    return roofRight >= (panelBottomCss + 4) * dpr ? CW : CW - panel;
  }

  /** Largest integer scale at which the settled building (plus `extra` logical px of headroom) fits the window. */
  function pickScale(extra) {
    const Hc = contentH(extra), lo = softMin();
    // comfortable margins when there is scale to spare; down at the legible minimum a 1px margin will do
    const wide = (t) => (BW + (t > lo ? MARGIN * 2 : 2)) * t <= widthAt(t, Hc);
    let s = lo;
    for (let t = maxScale(); t >= lo; t--) if (wide(t) && Hc * t <= CH - hudCss * dpr) { s = t; break; }
    while (s > hardMin() && !wide(s)) s--;
    return s;
  }

  function selRect() {
    if (!sel) return null;
    if (sel.startsWith('floor:')) { const f = floorByKey.get(sel.slice(6)); return f ? { top: f.y - f.h - 2, bottom: f.y + 2 } : null; }
    const e = ents.get(sel.split('#')[0]);
    if (!e) return null;
    const y = entY(e);
    return { top: y - PITCH - 4, bottom: y + 2 };
  }

  /** With the dialogue open, step the scale down just far enough that the selection clears it without the roof sliding under the HUD. */
  function focusScale(base) {
    const r = dlgCss ? selRect() : null;
    if (!r) return base;
    const Hc = contentH(), hud = hudCss * dpr, dlg = dlgCss * dpr;
    if (Hc * base > CH - hud) return base; // taller than the window: it scrolls anyway
    for (let s = base; s >= softMin(); s--) {
      const shift = Math.max(0, dlg - (GROUND - r.bottom - 3) * s);
      if (CH - Hc * s - shift >= hud) return s;
    }
    return base;
  }

  function applyScale() {
    const was = S;
    S = zoom ? clamp(zoom, hardMin(), maxScale()) : focusScale(fitS);
    availPx = zoom ? CW - panelCss * dpr : widthAt(fitS, contentH());
    if (S !== was || applyScale.zoom !== zoom) { applyScale.zoom = zoom; hooks.onLayout?.({ scale: S, dpr, zoom }); }
  }

  /** Follow the content height: shrink at once when it stops fitting, grow only when it fits with room to spare for a while. */
  function refit(now, force) {
    // one notch before scrolling: fold the rooftop sign and tank away if that is what it takes to show every floor
    const room = (CH - hudCss * dpr) / softMin(), full = contentH() + (flat ? ROOF_H - FLAT_ROOF : 0);
    if (full > room) flat = full - ROOF_H + FLAT_ROOF <= room;
    else if (flat && (force || full + PITCH - MINI <= room)) flat = false;
    const need = pickScale(0);
    if (force || !fitS || need < fitS) { fitS = need; upCand = 0; }
    else {
      const up = pickScale(PITCH - MINI);
      if (up > fitS) {
        if (upCand !== up) { upCand = up; upAt = now + 1500; }
        else if (now >= upAt && !sel && !drag) { fitS = up; upCand = 0; }
      } else upCand = 0;
    }
    applyScale();
  }

  /** Building width follows the data (never the zoom): grows at once, shrinks only after it has been too wide for a while. */
  function measure(now, force) {
    let span = 0, n = 8;
    for (const f of floors) {
      if (f.state === 'closing') continue;
      span = Math.max(span, f.desks.length * BAY + f.rooms.length * CONF_W);
      n = Math.max(n, f.minN);
    }
    const room = (CW - panelCss * dpr) / softMin() - 2;
    const total = (k) => WALL * 2 + (k * 6 + 30) + Math.max(span, MIN_IW - LAND - (k * 6 + 30)) + LAND + SHAFT;
    while (n > 8 && total(n) > room) n--;
    const sign = n * 6 + 30;
    span = Math.max(span, MIN_IW - LAND - sign);
    const grow = span > SPAN || sign > SIGN_W, shrink = span < SPAN || sign < SIGN_W;
    if (!force && !grow) {
      if (!shrink) { shrinkAt = 0; return; }
      if (!shrinkAt) shrinkAt = now + 12000;
      if (now < shrinkAt || sel) return;
    }
    shrinkAt = 0;
    SIGN_W = sign; signN = n; SPAN = span;
    IW = SIGN_W + SPAN + LAND;
    BW = WALL * 2 + IW + SHAFT;
    for (const e of ents.values()) {
      e.goal = goalOf(e);
      if (e.state === 'at') e.x = e.goal.x;
    }
    refit(now, true);
  }

  function relayout() {
    dpr = forcedDpr || window.devicePixelRatio || 1;
    CW = Math.max(320, Math.round(window.innerWidth * dpr));
    CH = Math.max(240, Math.round(window.innerHeight * dpr));
    if (canvas.width !== CW) canvas.width = CW;
    if (canvas.height !== CH) canvas.height = CH;
    canvas.style.width = CW / dpr + 'px';
    canvas.style.height = CH / dpr + 'px';
    measure(performance.now(), true);
  }

  function seat(f, id) {
    if (f.desks.includes(id)) return;
    const i = f.desks.indexOf(null);
    if (i >= 0) f.desks[i] = id; else f.desks.push(id);
  }
  function unseat(f, id) {
    const i = f.desks.indexOf(id);
    if (i < 0) return;
    f.desks[i] = null; // everyone else keeps their desk
    while (f.desks.length && f.desks[f.desks.length - 1] == null) f.desks.pop();
  }
  const roomOf = (f, id) => f.rooms.findIndex((r) => r.owner === id);

  // ------------------------------------------------------------ model

  function makeFloor(key, s, instant) {
    const prev = floors[floors.length - 1];
    let wall = hash(key) % WALLS.length;
    if (prev && prev.wall === wall) wall = (wall + 3) % WALLS.length;
    const f = {
      key, name: key, cwd: s.cwd || '', y: 0, h: instant ? PITCH : 0, want: PITCH, state: 'open', t: 0, quiet: 0, litAt: 0, instant,
      desks: [], rooms: [], wall, minN: minChars(key), cut: false,
      back: null, front: null, mini: null, plaque: null, plaqueAlert: null, cacheKey: '', waiting: false, active: false, num: 0, count: 0,
    };
    floors.push(f);
    floorByKey.set(key, f);
    return f;
  }

  function spotPos(i) {
    if (i < 0) i = 0;
    if (i < SPOTS.length) return { x: Math.min(lobbyX(SPOTS[i].x), IW - 22 - (SPOTS.length - 1 - i) * 3), pose: SPOTS[i].pose };
    return { x: clamp(lobbyX(150) + (i - SPOTS.length) * 13, 90, IW - 24), pose: 'stand' };
  }

  function goalOf(e) {
    if (e.gone) return { floor: lobby, x: -(bx + WALL + 16), kind: 'exit' };
    const f = e.home;
    if (e.sess.status === 'idle') {
      const sp = spotPos(e.spot);
      return { floor: lobby, x: sp.x, kind: 'lounge', pose: sp.pose };
    }
    const j = roomOf(f, e.id);
    if (j >= 0) return { floor: f, x: roomX(j) + 34, kind: 'boss' };
    if (!f.desks.includes(e.id)) seat(f, e.id);
    return { floor: f, x: SIGN_W + f.desks.indexOf(e.id) * BAY + 14, kind: 'desk' };
  }

  function release(e) {
    const f = e.home;
    unseat(f, e.id);
    const j = roomOf(f, e.id);
    if (j >= 0) f.rooms[j].owner = null;
  }

  function setState(st) {
    const first = !loaded;
    const now = performance.now();
    const seen = new Set();
    const keyOf = (s) => s.project || (s.cwd || '').split('/').filter(Boolean).pop() || '~';
    if (first) {
      // busiest projects nearest the lobby, so they are on screen even when the tower has to scroll
      const groups = new Map();
      for (const s of st.sessions) {
        const k = keyOf(s);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
      }
      const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
      for (const [k, list] of order) makeFloor(k, list[0], true);
    }
    for (const s of st.sessions) {
      seen.add(s.id);
      const key = keyOf(s);
      let f = floorByKey.get(key);
      if (!f) f = makeFloor(key, s, false);
      if (f.state === 'dark' || f.state === 'closing') f.state = 'open';
      if (s.cwd && (!f.cwd || s.cwd.length < f.cwd.length)) f.cwd = s.cwd;
      let e = ents.get(s.id);
      if (!e) {
        e = {
          id: s.id, sess: s, look: lookFor(s.id, s.tool), home: f, floor: lobby, x: -(bx + WALL + 14), state: 'walk', dir: 1,
          ph: (hash(s.id) % 1000) / 100, goal: null, gone: false, spot: -1, slot: 0, born: now,
        };
        ents.set(s.id, e);
      } else if (e.gone) e.gone = false;
      e.sess = s;
      if (e.home !== f) { release(e); e.home = f; }
    }
    for (const e of ents.values()) {
      if (!seen.has(e.id) && !e.gone) {
        e.gone = true;
        release(e);
        if (e.spot >= 0) { spots[e.spot] = null; e.spot = -1; }
      }
    }
    const boss = (e) => e.sess.mode === 'orchestrator' && e.sess.status !== 'idle';
    for (const f of floors) {
      const live = [...ents.values()].filter((e) => e.home === f && !e.gone);
      for (const r of f.rooms) {
        const o = r.owner && ents.get(r.owner);
        if (!o || o.gone || o.home !== f || !boss(o)) r.owner = null;
      }
      // every orchestrator gets a glass room of its own; everybody else keeps a desk
      for (const e of live) {
        if (!boss(e)) { seat(f, e.id); continue; }
        if (roomOf(f, e.id) < 0) {
          let r = f.rooms.find((q) => !q.owner && q.subs.size === 0);
          if (!r) { r = { owner: null, subs: new Map(), extra: 0 }; f.rooms.push(r); }
          r.owner = e.id;
        }
        unseat(f, e.id);
      }
      f.rooms.forEach((r, j) => syncSubs(r, j, now, first));
      while (f.rooms.length && !f.rooms[f.rooms.length - 1].owner && f.rooms[f.rooms.length - 1].subs.size === 0) f.rooms.pop();
      f.waiting = live.some((e) => e.sess.status === 'waiting');
      f.active = live.some((e) => e.sess.status !== 'idle');
      f.count = live.length;
      if (f.instant) { f.instant = false; if (!f.active) { f.want = MINI; f.h = MINI; f.quiet = 99; } }
    }
    for (const e of ents.values()) {
      if (e.gone) continue;
      if (e.sess.status === 'idle') {
        if (e.spot < 0) {
          let i = 0;
          while (spots[i]) i++;
          spots[i] = e.id;
          e.spot = i;
        }
      } else if (e.spot >= 0) { spots[e.spot] = null; e.spot = -1; }
    }
    floors.forEach((f, i) => { f.num = i + 2; });
    loaded = true;
    measure(now, first);
    for (const e of ents.values()) {
      e.goal = goalOf(e);
      if (first) { e.floor = e.goal.floor; e.x = e.goal.x; e.state = 'at'; }
    }
    if (first) {
      stepFloors(0, true);
      refit(now, true);
      Z = S; bxF = NaN;
      stepView(0);
      cam.b = cam.tb = GROUND;
    }
  }

  /** Crew of one meeting room. Records walk in from the lift landing, sit, and walk back out when their subagent is gone. */
  function syncSubs(r, j, now, instant) {
    const owner = r.owner && ents.get(r.owner);
    const list = owner ? owner.sess.subagents || [] : [];
    const ids = new Set(list.map((s) => s.id));
    for (const [id, rec] of r.subs) {
      if (ids.has(id) || rec.state === 'out') continue;
      if (rec.seat < 0 || instant) r.subs.delete(id);
      else { rec.state = 'out'; if (rec.x == null) rec.x = seatX(j, rec.seat); }
    }
    const taken = () => new Set([...r.subs.values()].filter((q) => q.state !== 'out' && q.seat >= 0).map((q) => q.seat));
    const freeSeat = () => { const used = taken(); for (let k = 0; k < SEATS; k++) if (!used.has(k)) return k; return -1; };
    for (const s of list) {
      let rec = r.subs.get(s.id);
      if (!rec || rec.state === 'out') {
        r.subs.delete(s.id);
        rec = { seat: freeSeat(), sub: s, look: lookFor(owner.id + '#' + s.id, owner.sess.tool, true), state: instant ? 'sit' : 'in', x: instant ? null : IW - 5, sit: instant ? 1 : 0, dir: -1, sx: null, sy: 0 };
        r.subs.set(s.id, rec);
      }
      rec.sub = s;
    }
    for (const rec of r.subs.values()) {
      if (rec.seat >= 0 || rec.state === 'out') continue;
      const k = freeSeat();
      if (k < 0) break;
      rec.seat = k; rec.state = 'in'; rec.x = IW - 5; rec.sit = 0;
    }
    r.extra = [...r.subs.values()].filter((q) => q.seat < 0).length;
  }

  // ------------------------------------------------------------ simulation

  const entY = (e) => (e.state === 'ride' ? car.y : e.floor.y);

  /** Ease h toward want; returns true when it lands. */
  function easeTo(o, key, want, dt) {
    const d = want - o[key];
    if (!d) return false;
    const step = Math.max(dt * 20, Math.abs(d) * (1 - Math.exp(-dt * 9)));
    if (step >= Math.abs(d)) { o[key] = want; return true; }
    o[key] += Math.sign(d) * step;
    return false;
  }

  function renumber() {
    floors.forEach((ff, k) => { ff.num = k + 2; });
  }

  function stepFloors(dt, snap) {
    let y = -LOBBY, open = 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (f.state === 'dark') {
        if (!sel) f.t += dt; // nothing closes while you are reading a dialogue
        if (f.t > 1.4) f.state = 'closing';
      } else if (f.state === 'closing') {
        if (easeTo(f, 'h', 0, dt)) {
          floors.splice(i, 1);
          floorByKey.delete(f.key);
          if (sel === 'floor:' + f.key) hooks.onSelect?.(null);
          i--;
          renumber();
          hooks.onFloors?.();
          continue;
        }
      } else if (loaded) {
        let used = car.target === f || (car.floor === f && car.state !== 'idle');
        let present = used;
        for (const e of ents.values()) {
          if ((e.home === f && !e.gone) || e.goal?.floor === f) used = true;
          if (e.floor === f && e.state !== 'ride') { used = true; present = true; }
        }
        if (!used) { f.state = 'dark'; f.t = 0; }
        const busy = f.active || present;
        f.quiet = busy ? 0 : f.quiet + dt;
        if (busy) f.want = PITCH;
        else if (f.quiet > 1.2 && !sel) f.want = MINI;
        if (snap) f.h = f.want;
        else if (easeTo(f, 'h', f.want, dt) && f.want === PITCH) f.litAt = performance.now();
      }
      if (f.state === 'open') open++;
      f.y = y;
      y -= f.h;
    }
    const lw = Math.max(0, MIN_STOREYS - open) * PITCH;
    if (snap || !loaded) lease.h = lw; else easeTo(lease, 'h', lw, dt);
    leaseBase = y;
    roofY = y - lease.h;
  }

  function stepEntity(e, dt) {
    const g = e.goal;
    if (!g || e.state === 'ride') return;
    if (e.state === 'board') {
      const tx = IW + 11 + e.slot * 5;
      if (car.floor !== e.floor || car.state !== 'open') { e.state = 'walk'; return; }
      const d = tx - e.x;
      if (Math.abs(d) < 1) { e.x = tx; e.state = 'ride'; car.riders.push(e); } else { e.dir = Math.sign(d); e.x += e.dir * Math.min(Math.abs(d), WALK * dt); }
      return;
    }
    let tx;
    if (e.floor === g.floor) tx = g.x;
    else tx = IW - 7 - (hash(e.id) % 3) * 5;
    const d = tx - e.x;
    if (Math.abs(d) < 0.75) {
      e.x = tx;
      if (e.floor === g.floor) {
        if (g.kind === 'exit') { ents.delete(e.id); if (sel === e.id) hooks.onSelect?.(null); return; }
        e.state = 'at';
      } else e.state = 'wait';
    } else {
      e.state = 'walk';
      e.dir = Math.sign(d);
      e.x += e.dir * Math.min(Math.abs(d), WALK * dt);
    }
  }

  function stepCrew(dt) {
    for (const f of floors) {
      for (let j = 0; j < f.rooms.length; j++) {
        const r = f.rooms[j];
        for (const [id, rec] of r.subs) {
          if (rec.seat < 0) continue;
          if (rec.state === 'sit') { rec.sit = Math.min(1, rec.sit + dt * 8); continue; }
          const tx = rec.state === 'in' ? seatX(j, rec.seat) : IW - 5;
          if (rec.state === 'out' && rec.sit > 0) { rec.sit = Math.max(0, rec.sit - dt * 8); continue; }
          const d = tx - rec.x;
          if (Math.abs(d) < 1) {
            if (rec.state === 'in') { rec.state = 'sit'; rec.x = null; } else r.subs.delete(id);
          } else { rec.dir = Math.sign(d); rec.x += rec.dir * Math.min(Math.abs(d), WALK * dt); }
        }
      }
    }
  }

  function stepCar(dt) {
    const waitersAt = (f) => { const out = []; for (const e of ents.values()) if (e.state === 'wait' && e.floor === f) out.push(e); return out; };
    if (car.state === 'idle') {
      if (car.floor) {
        car.y = car.floor.y;
        const drop = car.riders.some((r) => r.goal.floor === car.floor);
        const pick = car.riders.length < CAR_CAP && waitersAt(car.floor).length > 0;
        if (drop || pick) { car.state = 'open'; car.t = 0; return; }
      }
      let tgt = null, best = 1e9;
      const consider = (f) => { const dist = Math.abs(f.y - car.y); if (dist < best) { best = dist; tgt = f; } };
      if (car.riders.length) for (const r of car.riders) consider(r.goal.floor);
      if (car.riders.length < CAR_CAP) for (const e of ents.values()) if (e.state === 'wait') consider(e.floor);
      if (tgt && tgt !== car.floor) { car.target = tgt; car.state = 'move'; car.floor = null; car.moveT = 0; }
    } else if (car.state === 'move') {
      const t = car.target;
      if (!t || (t !== lobby && !floorByKey.has(t.key))) { car.target = lobby; return; }
      car.moveT += dt;
      const d = t.y - car.y;
      const v = Math.min(230, Math.max(30, Math.abs(d) * 6)) * Math.min(1, 0.3 + car.moveT * 3.5);
      car.spin += v * dt * Math.sign(d);
      if (Math.abs(d) <= v * dt) { car.y = t.y; car.floor = t; car.target = null; car.state = 'open'; car.t = 0; } else car.y += Math.sign(d) * v * dt;
    } else if (car.state === 'open') {
      car.t += dt;
      car.y = car.floor.y;
      for (let i = car.riders.length - 1; i >= 0; i--) {
        const r = car.riders[i];
        if (r.goal.floor === car.floor) { car.riders.splice(i, 1); r.floor = car.floor; r.state = 'walk'; }
      }
      let boarding = 0;
      for (const e of ents.values()) if (e.state === 'board' && e.floor === car.floor) boarding++;
      for (const e of waitersAt(car.floor)) {
        if (car.riders.length + boarding >= CAR_CAP) break;
        const taken = new Set([...car.riders.map((r) => r.slot), ...[...ents.values()].filter((x) => x.state === 'board').map((x) => x.slot)]);
        let sl = 0;
        while (taken.has(sl)) sl++;
        e.slot = sl; e.state = 'board'; boarding++;
      }
      if (!boarding && car.t > 0.3) car.state = 'idle';
    }
  }

  function reveal(r, hud, dlg) {
    if (r.bottom + 3 > cam.tb - dlg) cam.tb = r.bottom + 3 + dlg;
    if (r.top < cam.tb - VH + hud) cam.tb = r.top - hud + VH;
  }

  function stepView(dt) {
    if (Z !== S) {
      Z += (S - Z) * Math.min(1, dt * 9);
      if (Math.abs(S - Z) < 0.02 || !dt) Z = S;
    }
    VW = CW / Z;
    VH = CH / Z;
    const t = Math.max(1, Math.floor((availPx / Z - BW) / 2));
    if (Number.isNaN(bxF) || !dt) bxF = t;
    else { bxF += (t - bxF) * Math.min(1, dt * 9); if (Math.abs(t - bxF) < 0.3) bxF = t; }
    bx = Math.round(bxF);
  }

  function stepCam(dt) {
    const hud = (hudCss * dpr) / Z, dlg = (dlgCss * dpr) / Z;
    const top = roofY - roofVis() - SKY_PAD;
    const fits = VH >= GROUND - top + hud - 0.01;
    cam.lo = fits ? GROUND : top - hud + VH;
    cam.hi = GROUND + dlg;
    cam.xhi = Math.max(0, bx + BW + 1 - availPx / Z);
    if (!drag) {
      // everything fits: stay parked on the street, and move only as far as the dialogue forces us to
      if (fits && (!dlgCss || follow)) cam.tb = GROUND;
      if (follow && sel) { const r = selRect(); if (r) reveal(r, hud, dlg); }
    }
    cam.tb = clamp(cam.tb, cam.lo, cam.hi);
    cam.tx = clamp(cam.tx, 0, cam.xhi);
    const k = Math.min(1, dt * 12);
    cam.b += (cam.tb - cam.b) * k;
    cam.x += (cam.tx - cam.x) * k;
    if (Math.abs(cam.tb - cam.b) < 0.02 || !dt) cam.b = cam.tb;
    if (Math.abs(cam.tx - cam.x) < 0.02 || !dt) cam.x = cam.tx;
  }

  function update(dt, now) {
    stepFloors(dt);
    for (const e of ents.values()) stepEntity(e, dt);
    stepCar(dt);
    stepCrew(dt);
    let near = false;
    for (const e of ents.values()) if (e.floor === lobby && e.state !== 'ride' && Math.abs(e.x + 2) < 16) near = true;
    doorOpen = clamp(doorOpen + (near ? dt : -dt) * 5, 0, 1);
    roofLift = clamp(roofLift + (flat ? -dt : dt) * 3, 0, 1);
    if (now - lastFit > 160) { lastFit = now; measure(now, false); refit(now, false); }
    stepView(dt);
    stepCam(dt);
    if (now - skyAt > 30000 || !sky) { computeSky(); skyAt = now; }
  }

  // ------------------------------------------------------------ static art (cached per floor)

  function shell(g, h, roomH, wallCols) {
    // slab
    g.fillStyle = '#c8c8d8'; g.fillRect(0, 0, BW, 1);
    g.fillStyle = '#9090a8'; g.fillRect(0, 1, BW, 2);
    g.fillStyle = '#50506a'; g.fillRect(0, 3, BW, 1);
    // exterior walls (brick)
    for (const x of [0, BW - WALL]) {
      g.fillStyle = '#8c3c2c'; g.fillRect(x, SLAB, WALL, roomH);
      g.fillStyle = '#5c2018';
      for (let y = SLAB + 2; y < SLAB + roomH; y += 3) g.fillRect(x, y, WALL, 1);
      g.fillStyle = INK; g.fillRect(x === 0 ? 0 : BW - 1, 0, 1, h);
    }
    // shaft
    const sx = WALL + IW;
    g.fillStyle = '#12121e'; g.fillRect(sx, 0, SHAFT, h);
    g.fillStyle = '#26263a'; g.fillRect(sx + 1, 0, 1, h); g.fillRect(sx + SHAFT - 2, 0, 1, h);
    g.fillStyle = '#3a3a52'; g.fillRect(sx, 0, SHAFT, 1);
    g.fillStyle = INK; g.fillRect(sx - 1, SLAB, 1, roomH);
    // room
    g.fillStyle = wallCols[0]; g.fillRect(WALL, SLAB, IW, roomH);
    g.fillStyle = wallCols[1]; g.fillRect(WALL, SLAB + roomH - 10, IW, 10);
    g.fillStyle = wallCols[2]; g.fillRect(WALL, SLAB + roomH - 11, IW, 1);
    g.fillStyle = '#18181f'; g.fillRect(WALL, SLAB + roomH - 1, IW, 1);
  }

  function box(g, x, y, w, h, fill, line = INK) {
    g.fillStyle = line; g.fillRect(x, y, w, h);
    g.fillStyle = fill; g.fillRect(x + 1, y + 1, w - 2, h - 2);
  }

  /** Floor sign: number plate + project name in the big font, two lines at most, cut with an ellipsis when it is longer. */
  function drawPlaque(f, alert) {
    const PW = SIGN_W - 8;
    const c = mk(PW, 26);
    const g = c.getContext('2d');
    const bg = alert ? YELLOW : INK, fg = alert ? INK : WHITE;
    g.fillStyle = fg; g.fillRect(0, 0, PW, 26);
    g.fillStyle = bg; g.fillRect(1, 1, PW - 2, 24);
    g.fillStyle = fg; g.fillRect(2, 2, 15, 22);
    drawText(g, 'FL', 6, 4, bg, 5);
    drawText(g, String(f.num).padStart(2, '0'), 4, 12, bg, 7);
    const w = fitLabel(f.name, signN, 2);
    f.cut = !w.fits;
    const y0 = w.lines.length === 1 ? 6 : 2;
    w.lines.forEach((l, i) => drawText(g, l, 19, y0 + i * 8, fg, 7));
    return c;
  }

  function decor(g, x0, kind, wc) {
    if (kind === 0 || kind === 5) {
      // window on the back wall showing the sky
      box(g, x0 + 11, 5, 24, 16, sky.bands[2], '#d8d8e8');
      g.fillStyle = sky.bands[3]; g.fillRect(x0 + 12, 13, 22, 7);
      if (sky.night > 0.5) { g.fillStyle = '#f8f0b0'; g.fillRect(x0 + 16, 8, 1, 1); g.fillRect(x0 + 29, 10, 1, 1); g.fillRect(x0 + 24, 7, 1, 1); }
      else { g.fillStyle = WHITE; g.fillRect(x0 + 15, 9, 6, 2); g.fillRect(x0 + 17, 8, 3, 1); }
      g.fillStyle = sky.far; g.fillRect(x0 + 14, 16, 4, 4); g.fillRect(x0 + 20, 14, 5, 6); g.fillRect(x0 + 28, 17, 4, 3);
      g.fillStyle = '#d8d8e8'; g.fillRect(x0 + 22, 5, 1, 16); g.fillRect(x0 + 10, 21, 26, 1);
      g.fillStyle = INK; g.fillRect(x0 + 10, 22, 26, 1);
    } else if (kind === 1) {
      box(g, x0 + 18, 25, 9, 7, '#c06030'); g.fillStyle = INK; g.fillRect(x0 + 15, 12, 15, 13); g.fillRect(x0 + 18, 10, 9, 3);
      g.fillStyle = '#38a048'; g.fillRect(x0 + 16, 13, 13, 11); g.fillRect(x0 + 19, 11, 7, 3);
      g.fillStyle = '#58c868'; g.fillRect(x0 + 18, 14, 4, 4); g.fillRect(x0 + 24, 18, 3, 3);
    } else if (kind === 2) {
      box(g, x0 + 14, 14, 16, 18, '#8890a8'); g.fillStyle = INK; g.fillRect(x0 + 15, 20, 14, 1); g.fillRect(x0 + 15, 26, 14, 1);
      g.fillStyle = '#d8d8e8'; g.fillRect(x0 + 20, 17, 4, 1); g.fillRect(x0 + 20, 23, 4, 1); g.fillRect(x0 + 20, 29, 4, 1);
      box(g, x0 + 16, 4, 12, 8, '#f0e8d0', wc[2]); g.fillStyle = '#e06a48'; g.fillRect(x0 + 18, 8, 3, 2); g.fillStyle = '#28c898'; g.fillRect(x0 + 22, 6, 4, 4);
    } else if (kind === 3) {
      box(g, x0 + 17, 18, 10, 14, '#e0e0e8'); box(g, x0 + 18, 8, 8, 11, '#78d0f0'); g.fillStyle = WHITE; g.fillRect(x0 + 19, 9, 1, 5);
      g.fillStyle = '#e02828'; g.fillRect(x0 + 19, 22, 2, 2); g.fillStyle = '#2868c8'; g.fillRect(x0 + 23, 22, 2, 2);
    } else if (kind === 4) {
      box(g, x0 + 9, 7, 26, 25, '#8a5a30'); g.fillStyle = '#4c2c18'; g.fillRect(x0 + 10, 8, 24, 23);
      const cols = ['#e06a48', '#28c898', '#6c5cf8', '#f8d038', '#d8d8e8', '#f868b0'];
      for (let r = 0; r < 3; r++) {
        g.fillStyle = '#8a5a30'; g.fillRect(x0 + 10, 15 + r * 8, 24, 1);
        for (let c = 0; c < 7; c++) { const hh = 4 + ((x0 + r * 3 + c * 5) % 3); g.fillStyle = cols[(c + r * 2 + x0) % cols.length]; g.fillRect(x0 + 11 + c * 3 + (c > 3 ? 2 : 0), 15 + r * 8 - hh, 2, hh); }
      }
    }
  }

  function roomArt(g, h, cx, wc) {
    g.fillStyle = wc[2]; g.fillRect(cx, 0, CONF_W, ROOM - 10);
    g.fillStyle = wc[0]; g.fillRect(cx, ROOM - 10, CONF_W, 9);
    g.fillStyle = '#34344c'; g.fillRect(cx, ROOM - 1, CONF_W, 1);
    box(g, cx + 4, 7, 20, 16, '#f0f0f0', '#787890'); g.fillStyle = '#787890'; g.fillRect(cx + 5, 23, 18, 1);
    for (let i = 0; i < SEATS; i++) box(g, cx + 57 + i * 14, 18, 10, 10, '#404058');
    box(g, cx + 143, 22, 6, 9, '#c06030'); g.fillStyle = '#38a048'; g.fillRect(cx + 142, 15, 8, 7); g.fillStyle = '#58c868'; g.fillRect(cx + 144, 13, 4, 4);
    // table, glass (front)
    box(h, cx + 55, 28, 3, 4, '#6a4020'); box(h, cx + 138, 28, 3, 4, '#6a4020');
    box(h, cx + 50, 26, 94, 3, '#d8a060'); h.fillStyle = '#f0c888'; h.fillRect(cx + 51, 27, 92, 1);
    box(h, cx + 52, 28, 90, 4, '#8a5a30'); h.fillStyle = '#6a4020'; h.fillRect(cx + 53, 31, 88, 1);
    h.fillStyle = '#b8f0f8'; h.fillRect(cx, 0, 2, ROOM); h.fillRect(cx + CONF_W - 2, 0, 2, ROOM); h.fillRect(cx, 0, 48, 1);
    h.fillStyle = INK; h.fillRect(cx + 2, 0, 1, ROOM - 1); h.fillRect(cx + CONF_W - 3, 0, 1, ROOM - 1);
    h.fillStyle = '#d8f8f8';
    for (const sx of [30, 96, 132]) for (let k = 0; k < 6; k++) h.fillRect(cx + sx - k, 11 + k, 1, 1);
    for (const sx of [34, 100]) for (let k = 0; k < 3; k++) h.fillRect(cx + sx - k, 12 + k, 1, 1);
    // banner housing
    box(h, cx + 47, 0, CONF_W - 49, 8, INK, '#585870');
  }

  function landing(h, y0, roomH) {
    h.fillStyle = '#c8c8d8'; h.fillRect(IW - 2, y0, 2, roomH - y0); h.fillRect(IW - 9, y0, 9, 1);
    h.fillStyle = INK; h.fillRect(IW - 3, y0 + 1, 1, roomH - y0 - 2); h.fillRect(IW - 9, y0 + 1, 7, 1);
  }

  function buildFloor(f) {
    const back = mk(BW, PITCH), front = mk(BW, PITCH);
    const g = back.getContext('2d'), h = front.getContext('2d');
    const wc = WALLS[f.wall];
    shell(g, PITCH, ROOM, wc);
    // exterior windows (edge-on)
    g.fillStyle = '#78d0f0'; g.fillRect(1, SLAB + 7, 3, 13); g.fillRect(BW - 4, SLAB + 7, 3, 13);
    g.fillStyle = WHITE; g.fillRect(2, SLAB + 8, 1, 4); g.fillRect(BW - 3, SLAB + 8, 1, 4);
    g.translate(WALL, SLAB); h.translate(WALL, SLAB);
    f.plaque = drawPlaque(f, false);
    f.plaqueAlert = drawPlaque(f, true);
    // desk bays, then plain office filling whatever is left before the meeting rooms
    const nb = f.desks.length;
    const filler = Math.max(0, Math.floor((SPAN - nb * BAY - f.rooms.length * CONF_W) / BAY));
    for (let i = 0; i < nb + filler; i++) {
      const x0 = SIGN_W + i * BAY;
      const e = i < nb && f.desks[i] ? ents.get(f.desks[i]) : null;
      // ceiling lamp
      g.fillStyle = '#505068'; g.fillRect(x0 + 24, 0, 1, 1);
      g.fillStyle = '#f8e8a0'; g.fillRect(x0 + 22, 1, 5, 1);
      if (!e) {
        decor(g, x0, hash(f.key + ':' + i) % 7, wc);
        g.globalAlpha = 0.45; g.fillStyle = wc[1]; g.fillRect(x0, 2, BAY, ROOM - 3); g.globalAlpha = 1;
        continue;
      }
      // partition
      box(g, x0 + 43, 11, 3, 21, wc[2]);
      // chair
      box(g, x0 + 6, 18, 4, 12, '#404058'); box(g, x0 + 6, 28, 12, 3, '#404058');
      g.fillStyle = INK; g.fillRect(x0 + 11, 31, 2, 1);
      // nameplate in the tool's colour
      {
        const nm = String(e.sess.name || '?').toUpperCase().slice(0, 6);
        const tw = textWidth(nm, 5);
        const px = x0 + 42 - (tw + 4);
        g.fillStyle = toolOf(e.sess.tool).c; g.fillRect(px - 1, 2, tw + 6, 9);
        g.fillStyle = INK; g.fillRect(px, 3, tw + 4, 7);
        drawText(g, nm, px + 2, 4, WHITE, 5);
      }
      // desk + monitor (front layer)
      box(h, x0 + 21, 26, 3, 6, '#8a5a30'); box(h, x0 + 32, 25, 11, 7, '#a06838');
      h.fillStyle = '#6a4020'; h.fillRect(x0 + 34, 28, 7, 1);
      box(h, x0 + 20, 24, 24, 3, '#d8a060');
      h.fillStyle = '#f0c888'; h.fillRect(x0 + 21, 25, 22, 1);
      box(h, x0 + 29, 12, 13, 11, '#d0c8b0'); h.fillStyle = '#a09880'; h.fillRect(x0 + 30, 21, 11, 1);
      h.fillStyle = INK; h.fillRect(x0 + 33, 23, 5, 1); h.fillRect(x0 + 31, 14, 9, 7);
      h.fillStyle = '#d8d8e0'; h.fillRect(x0 + 21, 23, 6, 1);
    }
    for (let j = 0; j < f.rooms.length; j++) roomArt(g, h, roomX(j), wc);
    landing(h, 2, ROOM);
    f.back = back; f.front = front;
    // shuttered strip, used while everyone from this floor is on a break
    const mini = mk(BW, MINI), m = mini.getContext('2d');
    m.fillStyle = '#c8c8d8'; m.fillRect(0, 0, BW, 1);
    m.fillStyle = '#9090a8'; m.fillRect(0, 1, BW, 2);
    m.fillStyle = '#50506a'; m.fillRect(0, 3, BW, 1);
    for (const x of [0, BW - WALL]) {
      m.fillStyle = '#8c3c2c'; m.fillRect(x, SLAB, WALL, MINI - SLAB);
      m.fillStyle = '#5c2018'; for (let y = SLAB + 2; y < MINI; y += 3) m.fillRect(x, y, WALL, 1);
      m.fillStyle = INK; m.fillRect(x === 0 ? 0 : BW - 1, 0, 1, MINI);
    }
    m.fillStyle = '#12121e'; m.fillRect(WALL + IW, 0, SHAFT, MINI);
    m.fillStyle = '#26263a'; m.fillRect(WALL + IW + 1, 0, 1, MINI); m.fillRect(WALL + IW + SHAFT - 2, 0, 1, MINI);
    m.fillStyle = '#3a3a52'; m.fillRect(WALL + IW, 0, SHAFT, 1);
    m.fillStyle = '#181822'; m.fillRect(WALL, SLAB, IW, MINI - SLAB);
    m.fillStyle = '#20202c'; for (let y = SLAB + 1; y < MINI; y += 2) m.fillRect(WALL, y, IW, 1);
    m.fillStyle = INK; m.fillRect(WALL + IW - 1, SLAB, 1, MINI - SLAB);
    m.fillStyle = '#8088a8'; m.fillRect(WALL + 4, SLAB, 15, 9);
    drawText(m, String(f.num).padStart(2, '0'), WALL + 6, SLAB + 1, INK, 7);
    const nm = fitLabel(f.name, Math.max(8, Math.floor((IW - 110) / 6)), 1).lines[0] || '';
    f.miniW = drawText(m, nm, WALL + 23, SLAB + 1, '#a8b0d8', 7);
    f.mini = mini;
  }

  /** Unlit spare floor: keeps the building a tower when only a project or two is open. */
  function buildLease() {
    const key = BW + '|' + SIGN_W + '|' + SPAN;
    if (leaseKey === key && leaseArt) return;
    leaseKey = key;
    leaseArt = [0, 1].map((v) => {
      const c = mk(BW, PITCH), g = c.getContext('2d');
      shell(g, PITCH, ROOM, ['#2e2e40', '#242432', '#3c3c54']);
      g.fillStyle = '#28384c'; g.fillRect(1, SLAB + 7, 3, 13); g.fillRect(BW - 4, SLAB + 7, 3, 13);
      g.translate(WALL, SLAB);
      const n = Math.floor(SPAN / BAY);
      for (let i = 0; i < n; i++) {
        const x0 = SIGN_W + i * BAY + Math.floor((SPAN - n * BAY) / 2);
        g.fillStyle = '#505068'; g.fillRect(x0 + 24, 0, 1, 4); g.fillStyle = '#787890'; g.fillRect(x0 + 23, 4, 3, 2);
        const kind = hash('lease' + v + ':' + i) % 5;
        if (kind === 0) { box(g, x0 + 9, 20, 13, 12, '#6a5438'); box(g, x0 + 20, 24, 11, 8, '#5a4830'); box(g, x0 + 12, 12, 9, 9, '#5a4830'); g.fillStyle = '#3c3020'; g.fillRect(x0 + 14, 16, 5, 1); g.fillRect(x0 + 12, 25, 7, 1); }
        else if (kind === 1) { g.fillStyle = INK; g.fillRect(x0 + 8, 17, 30, 15); g.fillStyle = '#9898ac'; g.fillRect(x0 + 9, 18, 28, 14); g.fillStyle = '#787890'; for (let k = 0; k < 4; k++) g.fillRect(x0 + 13 + k * 6, 20, 1, 12); g.fillStyle = '#b8b8c8'; g.fillRect(x0 + 9, 18, 28, 1); }
        else if (kind === 2) { g.fillStyle = '#8a6a40'; g.fillRect(x0 + 14, 6, 2, 26); g.fillRect(x0 + 24, 6, 2, 26); for (let k = 0; k < 5; k++) g.fillRect(x0 + 14, 9 + k * 5, 12, 1); box(g, x0 + 31, 26, 7, 6, '#c8c8d8'); g.fillStyle = '#e06a48'; g.fillRect(x0 + 32, 27, 5, 1); }
        else if (kind === 3) { box(g, x0 + 11, 5, 24, 16, '#1c2434', '#585870'); g.fillStyle = '#585870'; g.fillRect(x0 + 22, 5, 1, 16); g.fillRect(x0 + 10, 21, 26, 1); }
      }
      g.fillStyle = 'rgba(6,6,20,0.5)'; g.fillRect(SIGN_W, 0, SPAN + LAND, ROOM - 1);
      // the sign hangs where a project name would be
      const PW = SIGN_W - 8;
      box(g, 4, 2, PW, 26, '#14141e', '#686880');
      g.fillStyle = '#14141e'; for (let x = 8; x < PW; x += 8) { g.fillRect(4 + x, 2, 3, 1); g.fillRect(4 + x, 27, 3, 1); }
      drawText(g, 'FOR', 4 + Math.round((PW - textWidth('FOR', 7)) / 2), 6, '#8890b8', 7);
      drawText(g, 'LEASE', 4 + Math.round((PW - textWidth('LEASE', 7)) / 2), 16, '#8890b8', 7);
      landing(g, 2, ROOM);
      g.fillStyle = 'rgba(6,6,20,0.35)'; g.fillRect(IW - 10, 0, 10, ROOM - 1);
      return c;
    });
  }

  function buildLobby() {
    const back = mk(BW, LOBBY), front = mk(BW, LOBBY);
    const g = back.getContext('2d'), h = front.getContext('2d');
    shell(g, LOBBY, LROOM, ['#50406c', '#3a2c50', '#7860a0']);
    // doorway in the left wall
    g.fillStyle = '#50406c'; g.fillRect(0, SLAB + 8, WALL, LROOM - 8);
    g.fillStyle = INK; g.fillRect(0, SLAB + 7, WALL, 1);
    g.translate(WALL, SLAB); h.translate(WALL, SLAB);
    const FL = LROOM;
    // checker floor + pillars
    for (let x = 0; x < IW; x += 4) { g.fillStyle = (x / 4) % 2 ? '#d8d0c0' : '#8a8298'; g.fillRect(x, FL - 1, 4, 1); }
    g.fillStyle = '#a02838'; g.fillRect(2, FL - 1, 14, 1);
    // NEW TASK sign hanging over reception
    g.fillStyle = '#787890'; g.fillRect(24, 0, 1, 3); g.fillRect(68, 0, 1, 3);
    box(g, 14, 2, 66, 13, INK, WHITE);
    box(g, 17, 4, 9, 9, '#f8d830'); drawText(g, '+', 19, 5, INK, 7);
    drawText(g, 'NEW TASK', 29, 5, WHITE, 7);
    // receptionist robot
    g.fillStyle = '#787890'; g.fillRect(45, 15, 1, 3); g.fillStyle = '#f83858'; g.fillRect(44, 14, 3, 2);
    box(g, 39, 17, 13, 10, '#c8c8d8'); g.fillStyle = INK; g.fillRect(41, 19, 9, 5);
    box(g, 41, 26, 9, 8, '#9090a8');
    // rug
    g.fillStyle = '#b84848'; g.fillRect(lobbyX(92), FL - 1, lobbyX(150) - lobbyX(92), 1);
    // wall clock
    const kx = lobbyX(84);
    box(g, kx + 1, 4, 9, 11, WHITE); g.fillStyle = INK; g.fillRect(kx, 5, 1, 9); g.fillRect(kx + 10, 5, 1, 9); g.fillStyle = WHITE; g.fillRect(kx + 1, 5, 9, 9);
    // couches
    const couch = (x, w, col, colD) => {
      box(g, x, 19, w, 13, col); g.fillStyle = colD; g.fillRect(x + 1, 28, w - 2, 3);
      box(h, x - 2, 25, 5, 10, col); box(h, x + w - 3, 25, 5, 10, col);
      box(h, x + 2, 29, w - 4, 6, col); h.fillStyle = colD; h.fillRect(x + 3, 33, w - 6, 1);
      h.fillStyle = INK; h.fillRect(x, 35, 2, 1); h.fillRect(x + w - 2, 35, 2, 1);
    };
    couch(lobbyX(105) - 11, 54, '#c84848', '#8c2c34');
    couch(lobbyX(309) - 11, 38, '#3890a8', '#205c74');
    // side table + lamp
    let x = lobbyX(156);
    box(g, x - 3, 29, 9, 7, '#8a5a30'); g.fillStyle = '#787890'; g.fillRect(x + 1, 22, 1, 7); box(g, x - 2, 17, 7, 6, '#f8e8a0');
    // vending machine
    x = lobbyX(175) - 9;
    box(g, x, 6, 19, 30, '#d03848'); box(g, x + 2, 8, 11, 17, '#181828');
    const cans = ['#f8d830', '#38c8f8', '#58c848', '#f89838', '#f868b0', WHITE];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) { g.fillStyle = cans[(r * 3 + c * 2) % cans.length]; g.fillRect(x + 3 + c * 3, 9 + r * 4, 2, 3); }
    g.fillStyle = WHITE; g.fillRect(x + 14, 9, 3, 2); g.fillStyle = '#f8d830'; g.fillRect(x + 14, 13, 3, 1); g.fillRect(x + 14, 15, 3, 1);
    g.fillStyle = INK; g.fillRect(x + 3, 28, 11, 4);
    // coffee counter
    x = lobbyX(222) - 16;
    box(g, x, 24, 32, 12, '#a06838'); g.fillStyle = '#d8d0c0'; g.fillRect(x, 24, 32, 2); g.fillStyle = INK; g.fillRect(x, 26, 32, 1); g.fillRect(x + 15, 27, 1, 8);
    box(g, x + 3, 11, 14, 13, '#404058'); g.fillStyle = '#f83858'; g.fillRect(x + 5, 13, 2, 2); g.fillStyle = '#c8c8d8'; g.fillRect(x + 9, 13, 6, 3);
    g.fillStyle = INK; g.fillRect(x + 7, 18, 6, 5); g.fillStyle = WHITE; g.fillRect(x + 8, 20, 4, 3);
    g.fillStyle = WHITE; g.fillRect(x + 21, 21, 3, 3); g.fillRect(x + 26, 21, 3, 3); g.fillStyle = '#9090a8'; g.fillRect(x + 21, 23, 3, 1); g.fillRect(x + 26, 23, 3, 1);
    // arcade cabinet
    x = lobbyX(279) - 9;
    box(g, x, 5, 19, 31, '#3828a0'); box(g, x + 1, 5, 17, 6, '#f8d830'); g.fillStyle = '#e01818'; for (let k = 0; k < 4; k++) g.fillRect(x + 3 + k * 4, 7, 2, 2);
    box(g, x + 2, 11, 15, 11, INK, '#181828');
    box(g, x - 1, 22, 21, 4, '#5848c8'); g.fillStyle = '#f83858'; g.fillRect(x + 4, 20, 2, 3); g.fillStyle = WHITE; g.fillRect(x + 10, 23, 2, 1); g.fillRect(x + 14, 23, 2, 1);
    g.fillStyle = '#f8d830'; g.fillRect(x + 6, 29, 7, 4); g.fillStyle = INK; g.fillRect(x + 8, 30, 3, 2);
    // plant
    x = lobbyX(347);
    if (x < IW - 26) { box(g, x - 3, 29, 7, 7, '#c06030'); g.fillStyle = '#38a048'; g.fillRect(x - 5, 19, 11, 10); g.fillStyle = '#58c868'; g.fillRect(x - 3, 16, 7, 6); g.fillStyle = '#1c7030'; g.fillRect(x - 5, 26, 11, 3); }
    // reception counter (front)
    box(h, 22, 23, 50, 13, '#a06838'); h.fillStyle = '#f0c888'; h.fillRect(22, 23, 50, 2); h.fillStyle = INK; h.fillRect(22, 25, 50, 1);
    h.fillStyle = '#6a4020'; h.fillRect(26, 28, 42, 5);
    drawText(h, 'RECEPTION', 30, 28, '#f0c888', 5);
    h.fillStyle = '#f8d830'; h.fillRect(62, 20, 5, 3); h.fillStyle = INK; h.fillRect(64, 19, 1, 1);
    // lift landing
    h.fillStyle = '#c8c8d8'; h.fillRect(IW - 2, 6, 2, LROOM - 6); h.fillRect(IW - 9, 6, 9, 1);
    h.fillStyle = INK; h.fillRect(IW - 3, 7, 1, LROOM - 8); h.fillRect(IW - 9, 7, 7, 1);
    lobby.back = back; lobby.front = front;
  }

  function ensureCache(f) {
    if (f.lobby) {
      const key = BW + '|' + SPAN;
      if (f.cacheKey !== key) { buildLobby(); f.cacheKey = key; }
      return;
    }
    const key = [BW, SIGN_W, signN, SPAN, Math.round(sky.hr * 2), f.num, f.name, f.rooms.length, f.desks.map((id) => (id ? id + (ents.get(id)?.sess.name || '') : '')).join(',')].join('|');
    if (f.cacheKey !== key) { buildFloor(f); f.cacheKey = key; }
  }

  // ------------------------------------------------------------ rendering

  function computeSky() {
    const d = new Date();
    const hr = forcedHour != null && !Number.isNaN(forcedHour) ? forcedHour : d.getHours() + d.getMinutes() / 60;
    let i = 0;
    while (i < SKY.length - 2 && hr >= SKY[i + 1][0]) i++;
    const a = SKY[i], b = SKY[i + 1];
    const t = clamp((hr - a[0]) / Math.max(0.001, b[0] - a[0]), 0, 1);
    sky = { bands: a[1].map((c, k) => lerpHex(c, b[1][k], t)), night: a[2] + (b[2] - a[2]) * t, hr };
    sky.far = lerpHex(sky.bands[4], '#000010', 0.55);
    sky.far2 = lerpHex(sky.bands[4], '#000010', 0.35);
  }

  function drawSky(now) {
    const bh = Math.ceil(VH / 5);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = sky.bands[i];
      ctx.fillRect(0, i * bh, Math.ceil(VW), bh + 1);
      if (i < 4) {
        ctx.fillStyle = sky.bands[i + 1];
        const y = (i + 1) * bh - 2;
        for (let x = (i % 2); x < VW; x += 2) ctx.fillRect(x, y, 1, 1);
        for (let x = ((i + 1) % 2); x < VW; x += 4) ctx.fillRect(x, y - 2, 1, 1);
      }
    }
    if (sky.night > 0.25) {
      for (let i = 0; i < 70; i++) {
        const hx = hash('star' + i);
        const x = hx % Math.max(1, Math.floor(VW)), y = (hx >>> 9) % Math.max(1, Math.floor(VH * 0.7));
        const tw = Math.sin(now / 700 + i * 1.7) > 0.86;
        if (tw) continue;
        ctx.fillStyle = i % 7 === 0 ? '#f8f0b0' : i % 3 === 0 ? '#8890c8' : '#d8d8f8';
        ctx.fillRect(x, y, 1, 1);
        if (i % 11 === 0) { ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3); }
      }
    }
    // sun or moon
    const hr = sky.hr;
    const day = hr >= 6 && hr < 19;
    const p = day ? (hr - 6) / 13 : ((hr + 24 - 19) % 24) / 11;
    const sx = Math.round(VW * (0.08 + 0.74 * p)), sy = Math.round(VH * (0.42 - 0.3 * Math.sin(p * Math.PI)));
    if (day) {
      ctx.fillStyle = '#f8e870'; ctx.fillRect(sx - 5, sy - 7, 10, 14); ctx.fillRect(sx - 7, sy - 5, 14, 10);
      ctx.fillStyle = '#f8f8c0'; ctx.fillRect(sx - 4, sy - 5, 6, 6);
    } else {
      ctx.fillStyle = '#e8e8d0'; ctx.fillRect(sx - 4, sy - 6, 8, 12); ctx.fillRect(sx - 6, sy - 4, 12, 8);
      ctx.fillStyle = sky.bands[1]; ctx.fillRect(sx - 1, sy - 6, 5, 9); ctx.fillRect(sx + 1, sy - 4, 5, 6);
      ctx.fillStyle = '#b8b8a8'; ctx.fillRect(sx - 4, sy + 1, 2, 2);
    }
    // clouds
    const cc = lerpHex('#f8f8f8', '#303058', clamp(sky.night, 0, 1)), cs = lerpHex('#c0d8f0', '#202040', clamp(sky.night, 0, 1));
    for (let i = 0; i < 5; i++) {
      const span = VW + 80;
      const x = Math.round(((hash('cl' + i) % 1000) / 1000 * span + (now / 1000) * (1.2 + i * 0.5)) % span) - 40;
      const y = 14 + ((hash('cy' + i) % 100) / 100) * VH * 0.4;
      stamp(ctx, CLOUD, x, Math.round(y), { w: cc, s: cs });
    }
  }

  function drawStreet(now) {
    const W = Math.ceil(VW + cam.x + 2);
    // far skyline
    for (let layer = 0; layer < 2; layer++) {
      ctx.fillStyle = layer ? sky.far : sky.far2;
      let x = -6;
      let i = 0;
      while (x < W) {
        const hx = hash('sk' + layer + ':' + i++);
        const w = 14 + (hx % 18), hh = (layer ? 26 : 50) + ((hx >>> 5) % (layer ? 60 : 130));
        ctx.fillRect(x, -hh, w, hh);
        if (hx % 3 === 0) ctx.fillRect(x + 3, -hh - 5, 2, 5);
        if (layer && sky.night > 0.4) {
          for (let k = 0; k < 6; k++) {
            const hk = hash('w' + i + ':' + k);
            if (hk % 3) continue;
            ctx.fillStyle = hk % 5 ? '#f8d868' : '#78d0f0';
            ctx.fillRect(x + 2 + (hk >>> 4) % Math.max(1, w - 4), -hh + 4 + ((hk >>> 9) % Math.max(1, hh - 8)), 1, 2);
          }
          ctx.fillStyle = sky.far;
        }
        x += w + (hx >>> 12) % 5;
      }
    }
    // sidewalk + street
    ctx.fillStyle = '#b0b0c0'; ctx.fillRect(0, 0, W, 4);
    ctx.fillStyle = '#787890';
    for (let x = 3; x < W; x += 9) ctx.fillRect(x, 1, 1, 3);
    ctx.fillStyle = '#e0e0e8'; ctx.fillRect(0, 0, W, 1);
    ctx.fillStyle = '#50506a'; ctx.fillRect(0, 4, W, 2);
    ctx.fillStyle = '#26262f'; ctx.fillRect(0, 6, W, GROUND + 400);
    ctx.fillStyle = '#d8c050';
    for (let x = 4; x < W; x += 22) ctx.fillRect(x, 11, 10, 1);
    // street lamp (only when there is pavement to stand it on)
    if (bx >= 44) {
      const lx = bx - 34;
      ctx.fillStyle = INK; ctx.fillRect(lx, -34, 3, 34); ctx.fillRect(lx - 1, -2, 5, 2); ctx.fillRect(lx, -36, 10, 3);
      ctx.fillStyle = '#585870'; ctx.fillRect(lx + 1, -33, 1, 32);
      ctx.fillStyle = sky.night > 0.4 ? '#f8e8a0' : '#c8c8d8'; ctx.fillRect(lx + 6, -33, 4, 2);
      if (sky.night > 0.4) { ctx.fillStyle = '#f8e8a0'; for (let k = 0; k < 5; k++) for (let x = lx + 4 - k + (k % 2); x < lx + 12 + k; x += 2) ctx.fillRect(x, -30 + k * 2, 1, 1); }
    }
    // hydrant
    if (bx > 60) {
      const hx = bx - 52;
      ctx.fillStyle = INK; ctx.fillRect(hx, -7, 5, 7); ctx.fillRect(hx - 1, -5, 7, 2);
      ctx.fillStyle = '#e03838'; ctx.fillRect(hx + 1, -6, 3, 6); ctx.fillStyle = '#f8a0a0'; ctx.fillRect(hx + 1, -6, 1, 2);
    }
    const tx = Math.round(bx + BW + 16);
    if (tx < W - 20) {
      ctx.fillStyle = '#4c2c18'; ctx.fillRect(tx + 6, -14, 3, 14);
      ctx.fillStyle = INK; ctx.fillRect(tx - 1, -31, 17, 19); ctx.fillRect(tx + 1, -33, 13, 23);
      ctx.fillStyle = '#2c7c3c'; ctx.fillRect(tx, -30, 15, 17); ctx.fillRect(tx + 2, -32, 11, 21);
      ctx.fillStyle = '#48a858'; ctx.fillRect(tx + 2, -30, 7, 6); ctx.fillRect(tx + 9, -24, 4, 4);
    }
    // awning over the front door
    for (let k = 0; k < 14; k++) { ctx.fillStyle = k % 4 < 2 ? '#e03838' : WHITE; ctx.fillRect(bx - 14 + k, -34 + Math.floor(k / 5), 1, 4); }
    ctx.fillStyle = INK; ctx.fillRect(bx - 14, -35, 14, 1);
  }

  function drawLease(now) {
    if (lease.h < 1) return;
    buildLease();
    const base = Math.round(leaseBase), top = Math.round(roofY);
    ctx.save(); ctx.beginPath(); ctx.rect(bx - 2, top, BW + 4, base - top); ctx.clip();
    for (let k = 0; k * PITCH < lease.h; k++) {
      const y = base - (k + 1) * PITCH;
      ctx.drawImage(leaseArt[k % 2], bx, y);
      const hot = hover === 'lease:' + k;
      if (hot) { ctx.fillStyle = YELLOW; const x = bx + WALL + 4, w = SIGN_W - 8, yy = y + SLAB + 2; ctx.fillRect(x, yy, w, 1); ctx.fillRect(x, yy + 25, w, 1); ctx.fillRect(x, yy, 1, 26); ctx.fillRect(x + w - 1, yy, 1, 26); }
      hits.push({ x: bx + WALL + 4, y: y + SLAB + 2, w: SIGN_W - 8, h: 26, id: 'lease:' + k });
    }
    ctx.restore();
  }

  function drawRoof(now) {
    const X = bx, base = Math.round(roofY);
    if (roofLift > 0) {
      // rooftop clutter; it sinks behind the parapet when the tower needs every pixel of height
      ctx.save(); ctx.beginPath(); ctx.rect(X - 12, base - 60, BW + 24, 55); ctx.clip();
      roofStuff(now, base + Math.round((1 - roofLift) * (ROOF_H + 2)));
      ctx.restore();
    }
    // parapet
    ctx.fillStyle = INK; ctx.fillRect(X - 2, base - 5, BW + 4, 5);
    ctx.fillStyle = '#c8c8d8'; ctx.fillRect(X - 1, base - 4, BW + 2, 1);
    ctx.fillStyle = '#9090a8'; ctx.fillRect(X - 1, base - 3, BW + 2, 3);
  }

  function roofStuff(now, y) {
    const X = bx;
    // water tank
    ctx.fillStyle = INK; ctx.fillRect(X + 22, -12 + y, 2, 9); ctx.fillRect(X + 40, -12 + y, 2, 9); ctx.fillRect(X + 18, y - 26, 28, 15);
    ctx.fillStyle = '#a06838'; ctx.fillRect(X + 19, y - 25, 26, 13);
    ctx.fillStyle = '#6a4020'; ctx.fillRect(X + 19, y - 21, 26, 1); ctx.fillRect(X + 19, y - 16, 26, 1);
    ctx.fillStyle = '#c88850'; ctx.fillRect(X + 20, y - 25, 2, 13);
    ctx.fillStyle = INK; ctx.fillRect(X + 20, y - 28, 24, 2); ctx.fillRect(X + 25, y - 30, 14, 2);
    // AC unit with a fan
    ctx.fillStyle = INK; ctx.fillRect(X + 56, y - 15, 24, 12);
    ctx.fillStyle = '#9090a8'; ctx.fillRect(X + 57, y - 14, 22, 10);
    ctx.fillStyle = INK; ctx.fillRect(X + 59, y - 12, 8, 7);
    ctx.fillStyle = '#d8d8e0';
    if (Math.floor(now / 90) % 2) { ctx.fillRect(X + 60, y - 9, 6, 1); ctx.fillRect(X + 63, y - 11, 1, 5); } else { ctx.fillRect(X + 61, y - 11, 1, 1); ctx.fillRect(X + 65, y - 11, 1, 1); ctx.fillRect(X + 61, y - 7, 1, 1); ctx.fillRect(X + 65, y - 7, 1, 1); ctx.fillRect(X + 63, y - 9, 1, 1); }
    ctx.fillStyle = '#50506a'; for (let k = 0; k < 3; k++) ctx.fillRect(X + 70, y - 12 + k * 3, 7, 1);
    // neon sign
    const label = 'AGENT OFFICE';
    const tw = textWidth(label, 7, 2);
    const nx = X + WALL + Math.round((IW - tw) / 2) + 6, ny = y - 27;
    ctx.fillStyle = INK; ctx.fillRect(nx + 10, ny + 18, 2, 6); ctx.fillRect(nx + tw - 12, ny + 18, 2, 6); ctx.fillRect(nx - 4, ny - 3, tw + 8, 21);
    ctx.fillStyle = '#20183c'; ctx.fillRect(nx - 3, ny - 2, tw + 6, 19);
    const flick = Math.sin(now / 130) > -0.96 || Math.floor(now / 2000) % 5 !== 0;
    const lit = sky.night > 0.3;
    drawText(ctx, label, nx + 1, ny + 2, lit ? '#802050' : '#58486c', 7, 2);
    drawText(ctx, 'AGENT', nx, ny + 1, lit ? (flick ? '#f868b0' : '#a03870') : '#e8e0f0', 7, 2);
    drawText(ctx, 'OFFICE', nx + textWidth('AGENT ', 7, 2) + 2, ny + 1, lit ? '#58e8f8' : '#e8e0f0', 7, 2);
    // lift machine room
    const mx = X + WALL + IW - 3;
    ctx.fillStyle = INK; ctx.fillRect(mx, y - LIFT_ROOM, SHAFT + 6, 14);
    ctx.fillStyle = '#787890'; ctx.fillRect(mx + 1, y - 16, SHAFT + 4, 12);
    ctx.fillStyle = '#50506a'; ctx.fillRect(mx + 1, y - 7, SHAFT + 4, 3);
    ctx.fillStyle = INK; ctx.fillRect(mx + 14, y - 14, 10, 8);
    ctx.fillStyle = '#c8c8d8';
    const sp = Math.floor(Math.abs(car.spin) / 4) % 2;
    if (sp) { ctx.fillRect(mx + 15, y - 11, 8, 2); ctx.fillRect(mx + 18, y - 13, 2, 6); } else { ctx.fillRect(mx + 15, y - 13, 2, 2); ctx.fillRect(mx + 21, y - 13, 2, 2); ctx.fillRect(mx + 15, y - 9, 2, 2); ctx.fillRect(mx + 21, y - 9, 2, 2); ctx.fillRect(mx + 18, y - 11, 2, 2); }
    // antenna with a beacon, at the far end from the floor index
    ctx.fillStyle = INK; ctx.fillRect(X + 8, y - 32, 2, 29); ctx.fillRect(X + 5, y - 26, 8, 1); ctx.fillRect(X + 6, y - 22, 6, 1);
    ctx.fillStyle = Math.floor(now / 600) % 2 ? '#f83838' : '#601818'; ctx.fillRect(X + 8, y - 34, 2, 2);
    // pigeons
    for (const [px, ph] of [[X + 86, 0], [X + 94, 1.3]]) {
      const bob = Math.sin(now / 400 + ph) > 0.7 ? 1 : 0;
      ctx.fillStyle = INK; ctx.fillRect(px, y - 8, 5, 4); ctx.fillRect(px + 3, y - 10 + bob, 3, 3);
      ctx.fillStyle = '#a8a8c0'; ctx.fillRect(px + 1, y - 7, 3, 2); ctx.fillRect(px + 4, y - 9 + bob, 1, 1);
      ctx.fillStyle = '#f89838'; ctx.fillRect(px + 6, y - 9 + bob, 1, 1);
    }
  }

  function poseOf(e, now) {
    const t = now / 1000 + e.ph;
    const st = e.sess.status;
    const blink = (t % 3.7) < 0.14 ? 'blink' : '';
    if (e.state === 'walk' || e.state === 'board') return { pose: 'walk', frame: Math.floor(t * 9) % 4, flip: e.dir < 0, face: '', yo: 0 };
    if (e.state === 'wait' || e.state === 'ride') return { pose: 'stand', frame: 0, flip: false, face: blink, yo: 0 };
    const k = e.goal.kind;
    if (st === 'waiting' && k !== 'lounge') return { pose: 'wave', frame: Math.floor(t * 5) % 2, flip: false, face: blink, yo: Math.floor(t * 2.5) % 2 ? -1 : 0 };
    if (k === 'desk') {
      const a = e.sess.activity?.kind;
      const still = a === 'thinking' || a === 'reading';
      return { pose: 'type', frame: still ? (Math.floor(t * 1.2) % 4 === 0 ? 1 : 0) : Math.floor(t * 7) % 2, flip: false, face: blink, yo: 0 };
    }
    if (k === 'boss') return { pose: 'present', frame: Math.floor(t * 2) % 2, flip: false, face: Math.floor(t * 4) % 2 ? 'talk' : blink, yo: 0 };
    if (k === 'lounge') {
      const p = e.goal.pose;
      if (p === 'couch') return { pose: 'stand', frame: 0, flip: false, face: 'sleep', yo: 2, couch: true };
      if (p === 'play') return { pose: 'play', frame: Math.floor(t * 6) % 2, flip: false, face: '', yo: 0 };
      if (p === 'vend') return { pose: 'play', frame: Math.floor(t * 1.5) % 2, flip: true, face: '', yo: 0 };
      if (p === 'drink') return { pose: 'drink', frame: Math.floor(t * 0.6) % 2, flip: false, face: blink, yo: 0 };
    }
    return { pose: 'stand', frame: 0, flip: false, face: blink, yo: 0 };
  }

  function drawEnt(e, now) {
    const p = poseOf(e, now);
    const wx = bx + WALL + Math.round(e.x), wy = Math.round(entY(e)) + p.yo;
    const spr = sprite(e.look, p.pose, p.frame, p.flip, p.face);
    if (p.couch) ctx.drawImage(spr, 0, 0, 20, 20, wx - 10, wy - 24, 20, 20); else ctx.drawImage(spr, wx - 10, wy - 24);
    e.sx = wx; e.sy = wy; e.pose = p;
    hits.push({ x: wx - 8, y: wy - 24, w: 16, h: p.couch ? 14 : 24, id: e.id });
  }

  function tag(text, cx, y, fg = WHITE, bg = INK, max = 14) {
    const tc = textCanvas(String(text).toUpperCase().slice(0, max), fg, 5);
    const w = tc.width + 4;
    const x = Math.round(clamp(cx - w / 2, cam.x + 2, Math.max(cam.x + 2, cam.x + VW - w - 2)));
    ctx.fillStyle = fg; ctx.fillRect(x - 1, y - 1, w + 2, 9);
    ctx.fillStyle = bg; ctx.fillRect(x, y, w, 7);
    ctx.drawImage(tc, x + 2, y + 1);
  }

  function brackets(x, y, w, h, col) {
    ctx.fillStyle = col;
    for (const [px, py, dx, dy] of [[x, y, 1, 1], [x + w - 1, y, -1, 1], [x, y + h - 1, 1, -1], [x + w - 1, y + h - 1, -1, -1]]) {
      ctx.fillRect(Math.min(px, px + dx * 3), py, 4, 1);
      ctx.fillRect(px, Math.min(py, py + dy * 3), 1, 4);
    }
  }
  function outline(x, y, w, h, col) {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x, y, 1, h); ctx.fillRect(x + w - 1, y, 1, h);
  }

  const sessionsOn = (f) => {
    const out = [];
    for (const r of f.rooms) { const e = r.owner && ents.get(r.owner); if (e && !e.gone) out.push(e); }
    for (const id of f.desks) { const e = id && ents.get(id); if (e && !e.gone) out.push(e); }
    return out;
  };

  /** One square per agent on the floor: tool colour, hollow when on a break, flashing when it needs you. */
  function pips(f, x, y, now, max, onYellow) {
    const list = sessionsOn(f);
    const show = list.length > max ? max - 1 : list.length;
    for (let i = 0; i < show; i++) {
      const e = list[i], t = toolOf(e.sess.tool), st = e.sess.status;
      const px = x + i * 7;
      if (onYellow) { ctx.fillStyle = INK; ctx.fillRect(px - 1, y - 1, 7, 7); }
      if (st === 'idle') { ctx.fillStyle = t.d; ctx.fillRect(px, y, 5, 5); ctx.fillStyle = onYellow ? INK : '#14141e'; ctx.fillRect(px + 1, y + 1, 3, 3); }
      else if (st === 'waiting') { ctx.fillStyle = Math.floor(now / 190) % 2 ? '#e01818' : WHITE; ctx.fillRect(px, y, 5, 5); }
      else { ctx.fillStyle = t.c; ctx.fillRect(px, y, 5, 5); }
    }
    if (show < list.length) drawText(ctx, '+' + (list.length - show), x + show * 7, y, onYellow ? INK : WHITE, 5);
    return x + Math.min(list.length, max) * 7;
  }

  function drawUnit(f, now) {
    const full = f.lobby ? LOBBY : PITCH;
    const top = Math.round(f.y - f.h), X = bx;
    if (top > cam.b + 4 || top + full < camTop() - 14) return;
    ensureCache(f);
    if (!f.lobby && f.want === MINI && f.h <= MINI + 0.5 && f.state === 'open') { drawMini(f, top, now); return; }
    const clip = f.h < full - 0.01;
    if (clip) {
      if (f.h < 1) return;
      ctx.save(); ctx.beginPath(); ctx.rect(X - 20, top, BW + 40, Math.ceil(f.h)); ctx.clip();
    }
    const ox = X + WALL, oy = top + SLAB;
    ctx.drawImage(f.back, X, top);
    if (f.lobby) lobbyBack(ox, oy, now); else floorBack(f, ox, oy, now);
    for (const e of ents.values()) if (e.floor === f && e.state === 'at') drawEnt(e, now);
    ctx.drawImage(f.front, X, top);
    if (f.lobby) lobbyFront(ox, oy, now); else floorFront(f, ox, oy, top, now);
    if (clip) ctx.restore();
  }

  function drawMini(f, top, now) {
    ctx.drawImage(f.mini, bx, top);
    const ox = bx + WALL;
    hits.push({ x: ox, y: top, w: IW, h: MINI, id: 'floor:' + f.key });
    const px = pips(f, ox + 29 + f.miniW, top + SLAB + 2, now, 10, false);
    const z = Math.floor(now / 700) % 3;
    drawText(ctx, 'ZZZ'.slice(0, z + 1), px + 4, top + SLAB + 2, '#7078b0', 5);
    if (sel === 'floor:' + f.key || hover === 'floor:' + f.key) outline(bx, top, BW, MINI + 1, sel === 'floor:' + f.key ? YELLOW : WHITE);
  }

  function floorBack(f, ox, oy, now) {
    const alert = f.waiting && Math.floor(now / 380) % 2 === 0;
    const PW = SIGN_W - 8;
    ctx.drawImage(alert ? f.plaqueAlert : f.plaque, ox + 4, oy + 2);
    hits.push({ x: ox + 4, y: oy + 2, w: PW, h: 26, id: 'floor:' + f.key });
    pips(f, ox + 4 + 19, oy + 2 + 19, now, Math.floor((PW - 21) / 7), alert);
    // meeting rooms: whiteboard + crew
    for (let j = 0; j < f.rooms.length; j++) {
      const r = f.rooms[j], cx = ox + roomX(j);
      const owner = r.owner && ents.get(r.owner);
      if (owner) {
        const t = toolOf(owner.sess.tool);
        let i = 0;
        for (const rec of r.subs.values()) {
          if (rec.state === 'out') continue;
          const bxp = cx + 6 + (i % 3) * 6, byp = oy + 9 + Math.floor(i / 3) * 5;
          if (byp < oy + 20) {
            ctx.fillStyle = rec.sub.status === 'done' ? '#20b858' : rec.sub.status === 'failed' ? '#e02828' : (Math.floor(now / 300 + i) % 2 ? t.c : t.l);
            ctx.fillRect(bxp, byp, 5, 4);
          }
          i++;
        }
      }
      for (const rec of r.subs.values()) {
        rec.sx = null;
        if (rec.seat < 0) continue;
        if (rec.state !== 'sit' && rec.sit <= 0) {
          // walking between the lift landing and a chair, behind the table
          const wx = ox + Math.round(rec.x);
          ctx.drawImage(sprite(rec.look, 'walk', Math.floor(now / 110) % 4, rec.dir < 0, ''), wx - 10, oy + ROOM - 24);
          continue;
        }
        const sxp = cx + 62 + rec.seat * 14;
        const st = rec.sub.status;
        const seated = rec.state === 'sit' && rec.sit >= 1;
        const face = st === 'done' ? 'happy' : st === 'failed' ? 'sad' : ((now / 1000 + rec.seat) % 3.1 < 0.15 ? 'blink' : '');
        const yo = !seated ? 0 : st === 'working' ? (Math.floor(now / 260 + rec.seat * 1.7) % 2) : st === 'failed' ? 2 : 0;
        const ty = oy + ROOM - 24 + Math.round(5 * rec.sit) + yo;
        ctx.drawImage(sprite(rec.look, 'stand', 0, false, face), 0, 0, 20, oy + ROOM - 3 - ty, sxp - 10, ty, 20, oy + ROOM - 3 - ty);
        if (!seated) continue;
        rec.sx = sxp; rec.sy = oy + 13 + yo; rec.cy = oy + 8;
        if (owner) hits.push({ x: sxp - 6, y: oy + 8, w: 12, h: 18, id: owner.id + '#' + rec.sub.id });
      }
    }
  }

  function floorFront(f, ox, oy, top, now) {
    // monitors
    for (let i = 0; i < f.desks.length; i++) {
      const id = f.desks[i];
      const e = id && ents.get(id);
      if (!e) continue;
      const x = ox + SIGN_W + i * BAY + 31, y = oy + 14;
      const here = e.state === 'at' && e.floor === f && e.goal.kind === 'desk';
      if (here && e.sess.status === 'working') {
        const t = toolOf(e.sess.tool);
        ctx.fillStyle = t.c; ctx.fillRect(x, y, 9, 7);
        ctx.fillStyle = t.l;
        const ph = Math.floor(now / 220 + e.ph * 3);
        for (let k = 0; k < 3; k++) { const r = (ph + k * 2) % 7; ctx.fillRect(x + 1, y + r, 2 + ((hash(id) >>> (k * 3)) + ph + k) % 6, 1); }
        ctx.fillStyle = WHITE; ctx.fillRect(x + 8, y, 1, 1);
      } else if (here && e.sess.status === 'waiting') {
        ctx.fillStyle = '#28283c'; ctx.fillRect(x, y, 9, 7);
        if (Math.floor(now / 400) % 2) { ctx.fillStyle = YELLOW; ctx.fillRect(x + 1, y + 5, 3, 1); }
        ctx.fillStyle = YELLOW; ctx.fillRect(x + 4, y + 1, 1, 3); ctx.fillRect(x + 4, y + 5, 1, 1);
      } else {
        ctx.fillStyle = '#1c1c2a'; ctx.fillRect(x, y, 9, 7);
        ctx.fillStyle = '#303044'; ctx.fillRect(x + 1, y + 1, 2, 1);
      }
    }
    // meeting-room banners (LED ticker): who runs the room, and on what
    for (let j = 0; j < f.rooms.length; j++) {
      const r = f.rooms[j], cx = ox + roomX(j);
      const owner = r.owner && ents.get(r.owner);
      if (owner) {
        const t = toolOf(owner.sess.tool);
        const lab = textCanvas('★ ' + String(owner.sess.name || '').toUpperCase().slice(0, 8), INK, 5);
        const lw = lab.width + 5;
        ctx.fillStyle = t.c; ctx.fillRect(cx + 48, oy + 1, lw, 6);
        ctx.drawImage(lab, cx + 50, oy + 1);
        const tx = cx + 48 + lw + 2, tw = CONF_W - 49 - 1 - lw - 3;
        const txt = textCanvas(String(owner.sess.title || '').toUpperCase().slice(0, 120), YELLOW, 5);
        ctx.save(); ctx.beginPath(); ctx.rect(tx, oy + 1, tw, 6); ctx.clip();
        if (txt.width <= tw) ctx.drawImage(txt, tx, oy + 1);
        else {
          const period = txt.width + 24;
          const off = Math.floor(now / 45) % period;
          ctx.drawImage(txt, tx - off, oy + 1);
          ctx.drawImage(txt, tx - off + period, oy + 1);
        }
        ctx.restore();
        if (r.extra > 0) tag('+' + r.extra, cx + 141, oy + 11, INK, YELLOW);
      } else {
        ctx.fillStyle = 'rgba(6,6,20,0.6)'; ctx.fillRect(cx + 3, oy + 8, CONF_W - 6, ROOM - 9); ctx.fillRect(cx + 3, oy + 1, 44, 7);
        ctx.drawImage(textCanvas('MEETING OVER', '#686880', 5), cx + 51, oy + 2);
      }
    }
    // lift indicator
    ctx.fillStyle = car.floor === f ? '#58e868' : car.target === f ? YELLOW : '#3a3a52';
    ctx.fillRect(ox + IW - 6, oy + 1, 3, 1);
    // lights: dim when nobody is active here; flicker when a floor has just opened
    const flick = f.litAt && now - f.litAt < 500 && Math.floor((now - f.litAt) / 70) % 2 === 0;
    if (f.state === 'dark' || f.state === 'closing' || f.h < PITCH || flick) { ctx.fillStyle = 'rgba(6,6,20,0.82)'; ctx.fillRect(ox, oy, IW, ROOM); }
    else if (!f.active) { ctx.fillStyle = 'rgba(6,6,20,0.5)'; ctx.fillRect(ox, oy, IW, ROOM - 1); }
    // needs-you: the room itself glows and gets a warning frame, so it cannot be mistaken for the floor above
    if (f.waiting && f.h >= PITCH) {
      const on = Math.floor(now / 380) % 2 === 0;
      ctx.fillStyle = on ? 'rgba(248,216,48,0.17)' : 'rgba(248,216,48,0.07)'; ctx.fillRect(ox, oy, IW, ROOM);
      outline(ox, oy, IW, ROOM, on ? YELLOW : '#a88c18');
      ctx.fillStyle = on ? YELLOW : '#a88c18'; ctx.fillRect(bx + 1, oy + 7, 3, 13); ctx.fillRect(bx + BW - 4, oy + 7, 3, 13);
    }
  }

  function lobbyBack(ox, oy, now) {
    // clock hands
    const kx = ox + lobbyX(84) + 5, ky = oy + 9;
    const d = new Date();
    const hand = (ang, len, col) => { ctx.fillStyle = col; for (let k = 0; k <= len; k++) ctx.fillRect(kx + Math.round(Math.sin(ang) * k), ky - Math.round(Math.cos(ang) * k), 1, 1); };
    hand(((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2, 2, INK);
    hand(d.getMinutes() / 60 * Math.PI * 2, 3, '#e02828');
    // robot face
    ctx.fillStyle = (now % 3100) < 130 ? INK : '#58e8f8';
    ctx.fillRect(ox + 42, oy + 20, 2, 2); ctx.fillRect(ox + 47, oy + 20, 2, 2);
    ctx.fillStyle = '#58e8f8'; ctx.fillRect(ox + 43, oy + 23, 5, 1);
    // NEW TASK sign pulse
    const hot = hover === 'reception';
    if (hot || Math.floor(now / 500) % 2) { ctx.fillStyle = hot ? '#f8d830' : '#f8d830'; ctx.fillRect(ox + 14, oy + 2, 66, 1); ctx.fillRect(ox + 14, oy + 14, 66, 1); ctx.fillRect(ox + 14, oy + 2, 1, 13); ctx.fillRect(ox + 79, oy + 2, 1, 13); }
    hits.push({ x: ox + 14, y: oy + 2, w: 66, h: LROOM - 2, id: 'reception' });
    // arcade screen
    const ax = ox + lobbyX(279) - 9 + 3, ay = oy + 12;
    const playing = spots[3] && ents.get(spots[3])?.state === 'at';
    const fr = Math.floor(now / (playing ? 120 : 600));
    ctx.fillStyle = '#101830'; ctx.fillRect(ax, ay, 13, 9);
    ctx.fillStyle = '#58e868'; ctx.fillRect(ax + 1 + (fr * 3) % 10, ay + 6, 3, 2);
    ctx.fillStyle = '#f83858'; ctx.fillRect(ax + 2 + (fr * 5) % 9, ay + 1 + (fr % 3), 2, 2);
    ctx.fillStyle = '#f8d830'; ctx.fillRect(ax + 9 - (fr * 2) % 8, ay + 3, 1, 1);
    // coffee steam
    const cxp = ox + lobbyX(222) - 16 + 9;
    ctx.fillStyle = '#d8d8e8';
    const sp = Math.floor(now / 260) % 4;
    ctx.fillRect(cxp + (sp % 2), oy + 16 - sp, 1, 1); ctx.fillRect(cxp + 2 - (sp % 2), oy + 14 - sp, 1, 1);
    // vending glow
    const vx = ox + lobbyX(175) - 9;
    ctx.fillStyle = Math.floor(now / 900) % 2 ? '#f8d830' : '#f89838'; ctx.fillRect(vx + 14, oy + 18, 3, 2);
  }

  function lobbyFront(ox, oy, now) {
    // sliding glass door in the left wall
    const hgt = Math.round((LROOM - 8) * (1 - doorOpen));
    if (hgt > 0) {
      ctx.fillStyle = '#78d0f0'; ctx.fillRect(bx + 1, oy + 8, 3, hgt);
      ctx.fillStyle = WHITE; ctx.fillRect(bx + 2, oy + 9, 1, Math.max(0, Math.min(6, hgt - 2)));
      ctx.fillStyle = INK; ctx.fillRect(bx + 1, oy + 8 + hgt - 1, 3, 1);
    }
    ctx.fillStyle = car.floor === lobby ? '#58e868' : car.target === lobby ? YELLOW : '#3a3a52';
    ctx.fillRect(ox + IW - 6, oy + 5, 3, 1);
    // lounge overflow
    const idle = spots.filter(Boolean).length;
    if (idle > SPOTS.length) tag('+' + (idle - SPOTS.length), ox + IW - 30, oy + 8, INK, YELLOW);
  }

  function drawShaft(now) {
    const sx = bx + WALL + IW;
    const cy = Math.round(car.y);
    // cable + counterweight
    ctx.fillStyle = '#585870'; ctx.fillRect(sx + 16, Math.round(roofY), 1, Math.max(0, cy - 30 - Math.round(roofY)));
    const ry = Math.round(roofY);
    const frac = clamp(car.y / Math.min(-1, roofY + PITCH), 0, 1);
    const wy = Math.round(ry + 6 + (-(ry + 6) - 16) * frac);
    ctx.fillStyle = '#3a3a52'; ctx.fillRect(sx + SHAFT - 5, ry, 1, Math.max(0, wy - ry));
    ctx.fillStyle = INK; ctx.fillRect(sx + SHAFT - 8, wy, 6, 9);
    ctx.fillStyle = '#50506a'; ctx.fillRect(sx + SHAFT - 7, wy + 1, 4, 7);
    // car
    ctx.fillStyle = INK; ctx.fillRect(sx + 3, cy - 30, 28, 30);
    ctx.fillStyle = '#a0a0b8'; ctx.fillRect(sx + 4, cy - 29, 26, 28);
    ctx.fillStyle = '#e8dcb8'; ctx.fillRect(sx + 6, cy - 26, 22, 24);
    ctx.fillStyle = '#c8b890'; ctx.fillRect(sx + 6, cy - 11, 22, 1); ctx.fillRect(sx + 6, cy - 26, 22, 2);
    ctx.fillStyle = '#f8f4c8'; ctx.fillRect(sx + 12, cy - 26, 10, 1);
    ctx.fillStyle = '#787890'; ctx.fillRect(sx + 6, cy - 2, 22, 1);
    ctx.fillStyle = car.state === 'move' ? '#f8d830' : '#58e868'; ctx.fillRect(sx + 15, cy - 29, 4, 2);
    for (const e of car.riders) { e.x = IW + 11 + e.slot * 5; drawEnt(e, now); }
    if (car.state === 'move') {
      // folding gate while moving: riders stay visible behind it
      ctx.fillStyle = '#303044';
      for (let x = sx + 8; x < sx + 28; x += 5) ctx.fillRect(x, cy - 24, 1, 22);
      ctx.fillRect(sx + 6, cy - 14, 22, 1);
    } else if (car.state === 'idle' && !car.riders.length) {
      // parked: steel doors closed
      ctx.fillStyle = '#b8b8cc'; ctx.fillRect(sx + 6, cy - 26, 22, 24);
      ctx.fillStyle = '#d8d8e8'; ctx.fillRect(sx + 6, cy - 26, 1, 24); ctx.fillRect(sx + 17, cy - 26, 1, 24);
      ctx.fillStyle = INK; ctx.fillRect(sx + 16, cy - 26, 1, 24);
      ctx.fillStyle = '#78d0f0'; ctx.fillRect(sx + 9, cy - 22, 5, 7); ctx.fillRect(sx + 20, cy - 22, 5, 7);
      ctx.fillStyle = WHITE; ctx.fillRect(sx + 10, cy - 21, 1, 3); ctx.fillRect(sx + 21, cy - 21, 1, 3);
    }
  }

  function drawOverlays(now) {
    const t = now / 1000;
    // floor-level markers outside the walls
    for (const f of floors) {
      if (f.h < PITCH) continue;
      const top = Math.round(f.y - f.h);
      ctx.fillStyle = INK; ctx.fillRect(bx - 4, top + 14, 4, 5);
      if (f.waiting) {
        // hazard posts hug both outer walls for exactly this floor's height
        const ph = Math.floor(now / 90);
        for (let yy = 0; yy < ROOM; yy++) {
          ctx.fillStyle = ((yy + ph) >> 2) % 2 ? YELLOW : INK;
          ctx.fillRect(bx - 4, top + SLAB + yy, 3, 1); ctx.fillRect(bx + BW + 1, top + SLAB + yy, 3, 1);
        }
        const on = Math.floor(now / 380) % 2 === 0;
        const bounce = Math.round(Math.abs(Math.sin(t * 5)) * 3);
        if (bx >= 20) ctx.drawImage(BANG[on ? 0 : 1], bx - 17, top + SLAB + 11 - bounce);
        if (VW + cam.x - (bx + BW) >= 20) ctx.drawImage(BANG[on ? 0 : 1], bx + BW + 6, top + SLAB + 11 - bounce);
      } else { ctx.fillStyle = '#50506a'; ctx.fillRect(bx - 3, top + 15, 2, 3); }
      const id = 'floor:' + f.key;
      if (sel === id) outline(bx, top, BW, PITCH + 1, Math.floor(now / 250) % 2 ? YELLOW : WHITE);
      if (hover === id && sel !== id) {
        outline(bx + WALL + 4, top + SLAB + 2, SIGN_W - 8, 26, YELLOW);
        tag(`${f.name} - ${f.count} AGENT${f.count === 1 ? '' : 'S'}`, bx + WALL + SIGN_W / 2, top + SLAB + 30, INK, YELLOW, 48);
      }
    }
    for (const e of ents.values()) {
      if (e.sx == null) continue;
      const st = e.sess.status, k = e.goal.kind;
      const top = e.sy - 24;
      const isSel = sel === e.id, isHover = hover === e.id;
      let labelY = top - 9;
      if (e.state === 'at') {
        if (st === 'waiting' && k !== 'lounge') {
          const b = Math.round(Math.abs(Math.sin(t * 5 + e.ph)) * 4);
          // at a desk the marker sits left of the head so it never covers the nameplate
          ctx.drawImage(BANG[Math.floor(now / 190) % 2], e.sx - (k === 'desk' ? 10 : 6), top - 11 - b);
          if (k === 'boss') ctx.drawImage(CROWN, e.sx - 18, top - 3);
          labelY = top - 21;
        } else if (k === 'desk') {
          const b = Math.floor(t * 2 + e.ph) % 2;
          ctx.drawImage(bubble(e.sess.activity?.kind), e.sx - 10, top - 9 - b);
          labelY = top - 18;
        } else if (k === 'boss') {
          ctx.drawImage(CROWN, e.sx - 6, top - 5 - (Math.floor(t * 2) % 2));
          // pointer
          ctx.fillStyle = INK;
          const hy = e.sy - 11 + (e.pose?.frame || 0);
          for (let i = 0; i < 6; i++) ctx.fillRect(e.sx - 10 - i, hy - i, 1, 1);
          labelY = top - 14;
        } else if (k === 'lounge' && e.goal.pose === 'couch') {
          const zf = Math.floor(t * 1.5 + e.ph) % 3;
          drawText(ctx, 'Z', e.sx + 6 + zf, top + 2 - zf * 3, '#b8b8f8', 5);
        }
      } else if (e.state !== 'ride' || isSel) {
        tag(e.sess.name || '?', e.sx, top - 8, WHITE, toolOf(e.sess.tool).d);
        labelY = top - 17;
      }
      if (isSel || isHover) {
        if (e.state === 'at') {
          const lab = isHover && !isSel && e.sess.activity?.label ? `${e.sess.name}: ${e.sess.activity.label}` : e.sess.name || '?';
          tag(lab, e.sx, labelY, isSel ? INK : WHITE, isSel ? YELLOW : INK, 34);
        }
        brackets(e.sx - 10, top - 1, 20, 26, isSel ? YELLOW : WHITE);
        if (isSel) { const b = Math.floor(t * 4) % 2; ctx.fillStyle = YELLOW; for (let i = 0; i < 3; i++) ctx.fillRect(e.sx - 2 + i, labelY - 5 + i + b, 5 - i * 2, 1); }
      }
    }
    // crew status chips + selection
    for (const f of floors) {
      if (f.h < PITCH) continue;
      for (const r of f.rooms) {
        const owner = r.owner && ents.get(r.owner);
        for (const rec of r.subs.values()) {
          if (rec.sx == null) continue;
          ctx.drawImage(chip(rec.sub.status, Math.floor(now / 220 + rec.seat)), rec.sx - 3, rec.cy);
          if (!owner) continue;
          const id = owner.id + '#' + rec.sub.id;
          if (sel === id || hover === id) {
            brackets(rec.sx - 8, rec.cy - 1, 16, 20, sel === id ? YELLOW : WHITE);
            const nm = rec.sub.name || rec.sub.agentType || 'CREW';
            tag(hover === id && sel !== id && rec.sub.label ? `${nm}: ${rec.sub.label}` : nm, rec.sx, rec.cy - 10, sel === id ? INK : WHITE, sel === id ? YELLOW : INK, 40);
          }
        }
      }
    }
    if (hover === 'reception') { const b = Math.floor(t * 4) % 2; ctx.fillStyle = YELLOW; for (let i = 0; i < 4; i++) ctx.fillRect(bx + WALL + 43 + i, -LROOM + 16 + i + b, 9 - i * 2, 1); }
    if (hover && hover.startsWith('lease:')) {
      const k = Number(hover.slice(6));
      tag('+ OPEN A NEW FLOOR', bx + WALL + SIGN_W / 2, Math.round(leaseBase) - (k + 1) * PITCH + SLAB + 30, INK, YELLOW, 24);
    }
  }

  function render(now) {
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(Z, 0, 0, Z, 0, 0);
    drawSky(now);
    viewTx = -Math.round(cam.x * Z);
    viewTy = CH - Math.round(cam.b * Z);
    ctx.setTransform(Z, 0, 0, Z, viewTx, viewTy);
    hits.length = 0;
    for (const e of ents.values()) e.sx = null;
    drawStreet(now);
    drawRoof(now);
    // foundation
    ctx.fillStyle = INK; ctx.fillRect(bx - 1, 0, BW + 2, 2);
    drawUnit(lobby, now);
    for (const f of floors) drawUnit(f, now);
    drawLease(now);
    drawShaft(now);
    for (const e of ents.values()) if (e.state !== 'at' && e.state !== 'ride') drawEnt(e, now);
    drawOverlays(now);
    // When the tower is taller than the window, the HUD row becomes a solid status bar, so floors scroll
    // out behind a clean edge instead of sliding underneath the floating panels.
    const over = (roofY - roofVis()) * Z + viewTy < hudCss * dpr - 2 * dpr;
    barA = clamp(barA + (over ? 0.12 : -0.12), 0, 1);
    if (barA > 0) {
      const bh = Math.round((hudCss - 2) * dpr), line = Math.max(2, Math.round(3 * dpr));
      ctx.setTransform(1, 0, 0, 1, 0, Math.round((barA - 1) * bh));
      ctx.fillStyle = '#0b0b12'; ctx.fillRect(0, 0, CW, bh);
      ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, bh - line, CW, line);
    }
  }

  /** After a long pause (hidden tab) nobody was watching: put everyone where they belong instead of replaying it. */
  function settle() {
    for (const e of [...ents.values()]) {
      if (e.gone) { ents.delete(e.id); if (sel === e.id) hooks.onSelect?.(null); continue; }
      e.goal = goalOf(e);
      e.floor = e.goal.floor; e.x = e.goal.x; e.state = 'at';
    }
    car.riders.length = 0; car.state = 'idle'; car.floor = lobby; car.target = null; car.y = 0;
    for (let i = floors.length - 1; i >= 0; i--) {
      const f = floors[i];
      const used = [...ents.values()].some((e) => e.home === f);
      if (!used) { floors.splice(i, 1); floorByKey.delete(f.key); if (sel === 'floor:' + f.key) hooks.onSelect?.(null); continue; }
      f.state = 'open'; f.want = f.active ? PITCH : MINI; f.h = f.want; f.quiet = f.active ? 0 : 99;
      for (const r of f.rooms) {
        for (const [id, rec] of r.subs) {
          if (rec.state === 'out') r.subs.delete(id);
          else if (rec.seat >= 0) { rec.state = 'sit'; rec.sit = 1; rec.x = null; }
        }
      }
    }
    renumber();
    stepFloors(0, true);
    hooks.onFloors?.();
  }

  /** Advance the simulation to `now` in small fixed steps, so it keeps real time even when frames are throttled. */
  function advance(now) {
    let elapsed = (now - lastNow) / 1000;
    lastNow = now;
    if (elapsed <= 0) return;
    if (elapsed > 8) { settle(); elapsed = 0.016; }
    while (elapsed > 0.0005) {
      const dt = Math.min(0.05, elapsed);
      update(dt, now);
      elapsed -= dt;
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!IW) return;
    try {
      advance(now);
      if (sky) render(now);
    } catch (err) {
      errors++;
      if (!frame.warned) { frame.warned = true; console.error('tower frame failed', err); }
      ctx.restore();
    }
  }
  // rAF stops in hidden tabs/iframes; keep the model moving so nothing has to catch up later.
  const ticker = setInterval(() => {
    if (!IW) return;
    const now = performance.now();
    if (now - lastNow > 300) { try { advance(now); } catch { errors++; } }
  }, 250);

  // ------------------------------------------------------------ input

  const toWorld = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) * dpr - viewTx) / Z, y: ((ev.clientY - r.top) * dpr - viewTy) / Z };
  };
  function pick(ev) {
    const p = toWorld(ev);
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (h.id && p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h) return h.id;
    }
    return null;
  }
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      const dy = ((ev.clientY - drag.y) * dpr) / Z, dx = ((ev.clientX - drag.x) * dpr) / Z;
      if (Math.abs(ev.clientY - drag.y) + Math.abs(ev.clientX - drag.x) > 4) drag.moved = true;
      if (drag.moved) { cam.tb = cam.b = clamp(drag.cam - dy, cam.lo, cam.hi); cam.tx = cam.x = clamp(drag.camx - dx, 0, cam.xhi); follow = false; canvas.style.cursor = 'grabbing'; }
      return;
    }
    hover = pick(ev);
    canvas.style.cursor = hover ? 'pointer' : 'default';
  });
  canvas.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, cam: cam.tb, camx: cam.tx, moved: false }; canvas.setPointerCapture?.(ev.pointerId); });
  canvas.addEventListener('pointerup', (ev) => {
    const d = drag;
    drag = null;
    if (d && d.moved) return;
    const id = pick(ev);
    if (id === 'reception') hooks.onNewTask?.('');
    else if (id && id.startsWith('lease:')) hooks.onNewTask?.('new');
    else hooks.onSelect?.(id);
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('pointerleave', () => { hover = null; });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    cam.tb += (ev.deltaY * dpr) / Z;
    cam.tx += (ev.deltaX * dpr) / Z;
    follow = false;
  }, { passive: false });
  window.addEventListener('resize', relayout);

  let raf = requestAnimationFrame(frame);
  relayout();
  computeSky();

  // ------------------------------------------------------------ public API

  function floorInfo(f) {
    const sessions = sessionsOn(f).map((e) => e.sess);
    return {
      key: f.key, name: f.name, num: f.num, cwd: f.cwd, sessions,
      waiting: sessions.filter((s) => s.status === 'waiting').length, working: sessions.filter((s) => s.status === 'working').length, idle: sessions.filter((s) => s.status === 'idle').length,
      closing: f.state === 'dark' || f.state === 'closing',
    };
  }
  const band = () => ({ top: camTop() + (hudCss * dpr) / Z, bottom: cam.b - (dlgCss * dpr) / Z });

  return {
    setState,
    resize: relayout,
    select(id, opts = {}) {
      sel = id;
      follow = !!id && opts.follow !== false;
      applyScale();
    },
    floors: () => floors.slice().reverse().map(floorInfo),
    floor: (key) => { const f = floorByKey.get(key); return f ? floorInfo(f) : null; },
    floorOf: (sessionId) => { const e = ents.get(sessionId); return e ? floorInfo(e.home) : null; },
    carFloor: () => (car.floor ? car.floor.key : null),
    visible: () => { const b = band(), out = new Set(); for (const f of floors) if (f.y - f.h >= b.top - 2 && f.y <= b.bottom + 2) out.add(f.key); return out; },
    /** Floors scrolled out of view, for the "more floors" buttons. */
    offscreen() {
      const b = band(), out = { above: 0, below: 0, aboveAlert: false, belowAlert: false, lobby: b.bottom < -6 };
      for (const f of floors) {
        if (f.y - f.h < b.top - 3) { out.above++; if (f.waiting) out.aboveAlert = true; } else if (f.y > b.bottom + 3) { out.below++; if (f.waiting) out.belowAlert = true; }
      }
      return out;
    },
    scrollBy(pages) { follow = false; cam.tb = clamp(cam.tb + pages * VH * 0.6, cam.lo, cam.hi); },
    panToLobby() { follow = false; cam.tb = cam.hi; },
    setPads({ dlg, hud, panel, panelBottom }) {
      let geo = false;
      if (hud != null && hud !== hudCss) { hudCss = hud; geo = true; }
      if (panel != null && panel !== panelCss) { panelCss = panel; geo = true; }
      if (panelBottom != null && Math.abs(panelBottom - panelBottomCss) > 1) { panelBottomCss = panelBottom; geo = true; }
      if (dlg != null && dlg !== dlgCss) { dlgCss = dlg; if (sel) follow = true; }
      if (!IW) return;
      if (geo) measure(performance.now(), true); else applyScale();
    },
    zoomBy(d) {
      zoom = d === 0 ? 0 : clamp((zoom || S) + d, hardMin(), maxScale());
      if (zoom && zoom === fitS && !dlgCss) zoom = 0;
      if (!zoom) { cam.tx = 0; follow = !!sel; refit(performance.now(), true); } else applyScale();
    },
    portrait(cv, id) {
      const [sid, sub] = String(id).split('#');
      const e = ents.get(sid);
      if (!e) return;
      if (sub) {
        let rec = null;
        for (const r of e.home.rooms) rec = rec || r.subs.get(sub);
        drawPortrait(cv, rec ? rec.look : lookFor(id, e.sess.tool, true), e.sess.tool, rec && rec.sub.status === 'done' ? 'happy' : rec && rec.sub.status === 'failed' ? 'sad' : '');
      } else drawPortrait(cv, e.look, e.sess.tool);
    },
    /** Numbers for ?debug and for tests; nothing in the UI reads this. */
    info: () => ({ S, Z, fitS, dpr, css: S / dpr, VW, VH, BW, SIGN_W, signN, SPAN, bx, floors: floors.length, lease: Math.round(lease.h / PITCH), ents: ents.size, camB: cam.b, camX: cam.x, lo: cam.lo, hi: cam.hi, car: car.state, zoom, errors, contentH: contentH(), roofY }),
    destroy() { cancelAnimationFrame(raf); clearInterval(ticker); window.removeEventListener('resize', relayout); },
  };
}
