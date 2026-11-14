// Floor Plan concept — generates the office floor for a given logical size.
// measure() says what fits at a size (the world picks the largest scale whose floor holds everybody, with headroom);
// planLayout() builds that floor with as many desk rows as are wanted. Everything is aligned to a 4 px grid, which is
// also the path-finding grid.
//
//   +--------+--------+--------+--------+-----------+
//   | CONF 1 | CONF 2 | CONF 3 | CONF 4 |  BREAK    |   top band (north wall has a visible face)
//   +--gl-ss-+--gl-ss-+--gl-ss-+--gl-ss-+------  ---+
//   |                 corridor                      |
//   +--  ----  ----  ----  ----  -------+           |
//   | BULLPEN: rows of desk pairs       |  LOBBY    |   bottom band
//   +-----------------------------------+---[door]--+

export const CELL = 4;
export const WALL = 4, TOPF = 28, COR = 20;
export const DESK_W = 34, DESK_H = 30, PAIR_W = 68, GAP = 8, ROW_PITCH = 36, BULL_TOP = 12;
const CONF_MIN = 68, CONF_H_MIN = 64, CONF_H_TIGHT = 52, RIGHT_MIN = 96, BREAK_BASE = 11, MAX_ROOMS = 8;
const FOOT = 6; // clear floor under the last desk row (room for its caption)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const f4 = (v) => Math.floor(v / 4) * 4;

/**
 * What fits on a floor of this logical size. Everything here depends on the size alone (plus the width of the
 * break room and the `tight` flag), never on how many agents are present, so seats do not move while the scale
 * stays the same: the bullpen just builds more of its rows.
 * @returns geometry + capacity, or null when not even one desk pair fits
 */
export function measure(Wpx, Hpx, breaks = 0, tight = false) {
  const W = f4(Wpx), H = f4(Hpx);
  const breakExtra = Math.max(0, Math.ceil((breaks - BREAK_BASE) / 6));
  const rightW = RIGHT_MIN + breakExtra * 40;
  const mainW = W - rightW - WALL;
  const pairs = Math.floor((mainW - GAP) / (PAIR_W + GAP));
  if (pairs < 1) return null;
  const fixedV = TOPF + WALL + COR + BULL_TOP + WALL;
  const rowsAt = (confH) => Math.floor((H - fixedV - confH - FOOT + 6) / ROW_PITCH);
  // tight = shallower meeting rooms (two chairs deep instead of three), which can buy the bullpen one more desk row
  const confMin = tight ? CONF_H_TIGHT : CONF_H_MIN, maxRows = rowsAt(confMin);
  if (maxRows < 1) return null;
  // meeting rooms take a share of whatever height the full bullpen does not need
  const slack = H - fixedV - confMin - FOOT - (maxRows * ROW_PITCH - 6);
  const confH = confMin + clamp(f4(slack / 2), 0, 16);
  const deskSpan = H - fixedV - confH - FOOT; // from the top of the first desk row to the bottom of the last
  const nRooms = clamp(Math.floor(mainW / CONF_MIN), 1, MAX_ROOMS);
  return {
    W, H, rightW, mainW, pairs, perRow: pairs * 2, maxRows, deskSpan, confH, nRooms, breakExtra,
    cap: { desks: pairs * 2 * maxRows, rooms: nRooms, breaks: BREAK_BASE + breakExtra * 6 },
  };
}

/**
 * @param {number} Wpx logical width  @param {number} Hpx logical height
 * @param {{rows?:number, pitchRows?:number, breaks?:number, tight?:boolean}} o  rows = desk rows to build (1..maxRows);
 *   pitchRows = how many rows the row spacing is planned for (>= rows): while the bullpen is not full the rows are
 *   spread out, and they only close up once more than pitchRows are needed; breaks = break spots wanted
 * @returns layout or null when the floor is too small
 */
export function planLayout(Wpx, Hpx, o = {}) {
  const m = measure(Wpx, Hpx, o.breaks || 0, !!o.tight);
  if (!m) return null;
  const { W, H, rightW, mainW, pairs, perRow, maxRows, deskSpan, confH, nRooms, breakExtra } = m;
  const rows = clamp(o.rows || maxRows, 1, maxRows);
  const pitchRows = clamp(o.pitchRows || rows, rows, maxRows);
  const pitch = ROW_PITCH + (pitchRows > 1 ? clamp(f4((deskSpan - (pitchRows * ROW_PITCH - 6)) / (pitchRows - 1)), 0, 12) : 0);
  const x0 = WALL, Xr = W - rightW;
  const Ys = TOPF + confH, Yc = Ys + WALL, Yb = Yc + COR;
  const bullH = H - WALL - Yb;
  const bx = x0 + f4((mainW - GAP - pairs * (PAIR_W + GAP)) / 2);

  const cols = W / CELL, grows = H / CELL;
  const blocked = new Uint8Array(cols * grows), wall = new Uint8Array(cols * grows);
  const mark = (arr, x, y, w, h, v = 1) => {
    const cx0 = Math.max(0, Math.floor(x / CELL)), cy0 = Math.max(0, Math.floor(y / CELL));
    const cx1 = Math.min(cols, Math.ceil((x + w) / CELL)), cy1 = Math.min(grows, Math.ceil((y + h) / CELL));
    for (let cy = cy0; cy < cy1; cy++) for (let cx = cx0; cx < cx1; cx++) arr[cy * cols + cx] = v;
  };
  /** Furniture: block the cells whose centre is inside the rect. */
  const blockC = (x, y, w, h) => {
    for (let cy = Math.max(0, Math.floor(y / CELL)); cy < grows && cy * CELL < y + h; cy++)
      for (let cx = Math.max(0, Math.floor(x / CELL)); cx < cols && cx * CELL < x + w; cx++) {
        const px = cx * CELL + 2, py = cy * CELL + 2;
        if (px >= x && px < x + w && py >= y && py < y + h) blocked[cy * cols + cx] = 1;
      }
  };
  const addWall = (x, y, w, h) => { mark(wall, x, y, w, h); mark(blocked, x, y, w, h); };
  const cut = (x, y, w, h) => { mark(wall, x, y, w, h, 0); mark(blocked, x, y, w, h, 0); };
  const snap = (p) => ({ x: Math.floor(p.x / CELL) * CELL + 2, y: Math.floor(p.y / CELL) * CELL + 2 });
  const seat = (x, y, facing = 'down', approach = null) => ({ x, y, facing, approach: approach || snap({ x, y }) });

  const L = {
    W, H, x0, Xr, Ys, Yc, Yb, confH, rightW, mainW, pitch, bx, pairs, perRow, rows, maxRows, pitchRows,
    grid: { cols, rows: grows, blocked, wall },
    rooms: [], desks: [], breakSpots: [], props: [], doors: [], railGaps: [], decals: [],
  };

  // ---- shell
  addWall(0, 0, W, WALL);
  mark(blocked, 0, WALL, W, TOPF - WALL);
  addWall(0, 0, WALL, H);
  addWall(W - WALL, 0, WALL, H);
  addWall(0, H - WALL, W, WALL);

  // ---- conference rooms
  const pw = f4(mainW / nRooms);
  for (let i = 0; i < nRooms; i++) {
    const x = x0 + i * pw;
    const w = (i === nRooms - 1 ? Xr : x + pw) - x - (i === nRooms - 1 ? 0 : WALL);
    const r = { i, x, y: TOPF, w, h: confH };
    const cx = x + (w >> 1);
    const rowsN = confH >= 76 ? 4 : confH >= 64 ? 3 : 2;
    const table = { x: cx - 7, y: TOPF + 20, w: 14, h: rowsN * 12 + 2 };
    r.table = table;
    r.boss = seat(cx, TOPF + 16);
    r.board = { x: x + 3, y: 5, w: w - 6, h: 21 };
    r.seats = [];
    // seat columns, nearest the table first: at the table, then (wide rooms) a middle column, then along the walls
    const colsX = [[table.x - 7, table.x + table.w + 7]];
    if (w >= 84) colsX.push([x + 18, x + w - 18]);
    if (w >= 64) colsX.push([x + 7, x + w - 7]);
    for (const [xl, xr] of colsX) for (let j = 0; j < rowsN; j++) {
      const sy = table.y + 11 + j * 12;
      r.seats.push(seat(xl, sy), seat(xr, sy));
    }
    r.tableSeats = rowsN * 2;
    r.door = { x: x + 4, y: Ys, w: 16 };
    r.doorSeat = seat(x + 14, Yc + 6);
    r.plaque = { x: x + 21, y: Ys - 3, w: w - 22 };
    blockC(table.x, table.y, table.w, table.h);
    L.rooms.push(r);
    if (i < nRooms - 1) addWall(x + w, 0, WALL, Ys + WALL);
  }
  // glass south wall of the conference band (blocked, but not a solid "wall top")
  mark(blocked, x0, Ys, mainW, WALL);
  for (const r of L.rooms) { mark(blocked, r.door.x, Ys, r.door.w, WALL, 0); L.doors.push({ x: r.door.x, y: Ys, w: r.door.w, kind: 'glass' }); }

  // ---- break room (top right)
  const bx0 = Xr + WALL, bw = rightW - 2 * WALL;
  addWall(Xr, 0, WALL, Ys + WALL);
  addWall(Xr, Ys, rightW, WALL);
  const bdoor = { x: bx0 + 64, y: Ys, w: 16 };
  cut(bdoor.x, Ys, bdoor.w, WALL);
  L.doors.push({ ...bdoor, kind: 'wall' });
  L.breakRoom = { x: bx0, y: TOPF, w: bw, h: confH };
  const vend = { type: 'vending', x: bx0 + 2, y: TOPF, base: TOPF + 7 };
  const coffee = { type: 'coffee', x: bx0 + 16, y: TOPF, base: TOPF + 8 };
  L.props.push(vend, coffee);
  blockC(vend.x, TOPF, 12, 8);
  blockC(coffee.x, TOPF, 26, 8);
  const couches = [];
  const addCouch = (x, y) => {
    couches.push({ x, y });
    L.props.push({ type: 'couchBack', x, y, base: y + 8 }, { type: 'couchFront', x, y, base: y + 18 });
    blockC(x, y, 38, 18);
  };
  const row2 = TOPF + confH - 28;
  addCouch(bx0 + 46, TOPF);
  addCouch(bx0 + 4, row2);
  for (let j = 0; j < breakExtra; j++) { addCouch(bx0 + 88 + j * 40, TOPF); addCouch(bx0 + 88 + j * 40, row2); }
  const tb = { type: 'roundTable', x: bx0 + 60, y: row2 + 6, base: row2 + 15 };
  L.props.push(tb);
  blockC(tb.x, tb.y, 12, 8);
  const couchSeats = (c) => [8, 19, 30].map((dx) => seat(c.x + dx, c.y + 16, 'down', snap({ x: c.x + dx, y: c.y + 22 })));
  const cs = couches.map(couchSeats);
  const spot = (s, kind) => Object.assign(s, { kind });
  // assignment order: first couch, coffee, second couch, vending, stools, then the rest
  cs[0].forEach((s) => L.breakSpots.push(spot(s, 'doze')));
  L.breakSpots.push(spot(seat(coffee.x + 8, TOPF + 13), 'sip'));
  cs[1].forEach((s) => L.breakSpots.push(spot(s, 'doze')));
  L.breakSpots.push(spot(seat(vend.x + 6, TOPF + 13, 'up'), 'snack'));
  L.breakSpots.push(spot(seat(tb.x - 5, tb.y + 9), 'sip'), spot(seat(tb.x + 17, tb.y + 9), 'sip'));
  L.breakSpots.push(spot(seat(coffee.x + 20, TOPF + 13), 'sip'));
  for (let j = 2; j < cs.length; j++) cs[j].forEach((s) => L.breakSpots.push(spot(s, 'doze')));

  // ---- lobby (bottom right) + entrance
  const lx0 = Xr + WALL, lw = bw, lh = H - WALL - Yb;
  addWall(Xr, Yb, WALL, H - Yb);
  L.lobby = { x: lx0, y: Yb, w: lw, h: lh };
  const ent = { x: lx0 + lw - 32, y: H - WALL, w: 20 };
  cut(ent.x, ent.y, ent.w, WALL);
  L.entrance = ent;
  L.doors.push({ ...ent, kind: 'entrance' });
  const ex = snap({ x: ent.x + 10, y: H - 10 });
  L.exit = { x: ex.x, y: H + 16, facing: 'down', approach: ex };
  const rdY = Yb + clamp(f4(lh * 0.3), 24, 64);
  L.reception = { x: lx0 + 4, y: rdY, w: 40, h: 16 };
  L.props.push({ type: 'reception', x: L.reception.x, y: rdY, base: rdY + 16 });
  blockC(L.reception.x, rdY, 40, 16);
  blockC(L.reception.x - 4, rdY - 24, 48, 24); // nobody walks under the floating NEW TASK sign above the desk
  if (lh > rdY - Yb + 16 + 36) {
    const by = f4(Yb + lh - 30);
    L.props.push({ type: 'bench', x: lx0 + 2, y: by, base: by + 12 });
    blockC(lx0 + 2, by, 30, 12);
  }
  L.props.push({ type: 'plant', x: lx0 + lw - 9, y: H - WALL - 3, base: H - WALL - 2 });
  L.props.push({ type: 'plant', x: lx0 + 46, y: rdY + 16, base: rdY + 15 });
  blockC(lx0 + 44, rdY + 4, 12, 12);
  blockC(lx0 + lw - 10, H - WALL - 8, 10, 8);

  // ---- bullpen
  L.bullpen = { x: x0, y: Yb, w: mainW, h: bullH };
  mark(blocked, x0, Yb, mainW, WALL);
  for (let p = 0; p <= pairs; p++) {
    const gx = bx + p * (PAIR_W + GAP);
    const g0 = Math.max(x0, gx - 4), g1 = Math.min(Xr, gx + GAP + 4);
    mark(blocked, g0, Yb, g1 - g0, WALL, 0);
    L.railGaps.push({ x: g0, w: g1 - g0 });
  }
  const rowY0 = Yb + BULL_TOP;
  for (let r = 0; r < rows; r++) {
    const y = rowY0 + r * pitch;
    for (let p = 0; p < pairs; p++) {
      const px = bx + GAP + p * (PAIR_W + GAP);
      blockC(px, y, PAIR_W, DESK_H);
      for (let c = 0; c < 2; c++) {
        const x = px + c * DESK_W;
        const ay = snap({ x: 0, y: y + 19 }).y;
        const ax = c === 0 ? px - 2 : px + PAIR_W + 2;
        L.desks.push({ i: L.desks.length, x, y, row: r, col: p * 2 + c, seat: seat(x + 19, y + 19, 'down', { x: ax, y: ay }) });
      }
    }
  }
  const deskBottom = rowY0 + (rows - 1) * pitch + DESK_H;
  const free = H - WALL - deskBottom;
  if (free >= 22) {
    L.props.push({ type: 'plant', x: x0 + 3, y: H - WALL - 3, base: H - WALL - 2 });
    blockC(x0, H - WALL - 8, 10, 8);
    L.props.push({ type: 'copier', x: Xr - 20, y: H - WALL - 14, base: H - WALL - 1 });
    blockC(Xr - 20, H - WALL - 12, 16, 12);
    L.props.push({ type: 'cooler', x: Xr - 32, y: H - WALL - 16, base: H - WALL - 1 });
    blockC(Xr - 32, H - WALL - 8, 8, 8);
  }

  // ---- wayfinding decals on the corridor floor
  L.decals.push({ text: 'MEETING ROOMS', icon: 'up', x: x0 + 6, y: Yc + 4 });
  L.decals.push({ text: 'BULLPEN', icon: 'down', x: x0 + 6, y: Yc + COR - 9 });
  L.decals.push({ text: 'BREAK', icon: 'up', x: bx0 + 26, y: Yc + 4 });
  L.decals.push({ text: 'LOBBY', icon: 'down', x: bx0 + 26, y: Yc + COR - 9 });

  L.cap = { desks: perRow * maxRows, rooms: L.rooms.length, breaks: L.breakSpots.length };
  L.built = L.desks.length;
  L.snap = snap;
  return L;
}

/* ------------------------------------------------------------ path finding */
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const ORDER = [3, 1, 0, 2]; // when several moves are equally short, go vertical first (keeps walkers on the runner and in the aisles)

function nearestFree(grid, cx, cy) {
  const { cols, rows, blocked } = grid;
  cx = clamp(cx, 0, cols - 1); cy = clamp(cy, 0, rows - 1);
  if (!blocked[cy * cols + cx]) return [cx, cy];
  for (let r = 1; r < 12; r++) {
    let best = null, bd = 1e9;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows || blocked[y * cols + x]) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    if (best) return best;
  }
  return [cx, cy];
}

/** 4-directional route between two logical points; returns corner points (cell centres), start excluded. */
export function findPath(grid, from, to) {
  const { cols, rows, blocked } = grid;
  const [sx, sy] = nearestFree(grid, Math.floor(from.x / CELL), Math.floor(from.y / CELL));
  const [tx, ty] = nearestFree(grid, Math.floor(to.x / CELL), Math.floor(to.y / CELL));
  const dist = new Int32Array(cols * rows).fill(-1);
  const q = new Int32Array(cols * rows);
  let qh = 0, qt = 0;
  dist[ty * cols + tx] = 0;
  q[qt++] = ty * cols + tx;
  const start = sy * cols + sx;
  while (qh < qt) {
    const i = q[qh++];
    if (i === start) break;
    const x = i % cols, y = (i / cols) | 0, d = dist[i] + 1;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = ny * cols + nx;
      if (blocked[j] || dist[j] >= 0) continue;
      dist[j] = d;
      q[qt++] = j;
    }
  }
  const pts = [];
  if (dist[start] < 0) return pts;
  let x = sx, y = sy, dir = -1;
  pts.push({ x: x * CELL + 2, y: y * CELL + 2 });
  while (dist[y * cols + x] > 0) {
    const d = dist[y * cols + x];
    let pick = -1;
    if (dir >= 0) {
      const nx = x + DX[dir], ny = y + DY[dir];
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && dist[ny * cols + nx] === d - 1) pick = dir;
    }
    if (pick < 0) for (const k of ORDER) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && dist[ny * cols + nx] === d - 1) { pick = k; break; }
    }
    if (pick < 0) break;
    if (pick !== dir && dir >= 0) pts.push({ x: x * CELL + 2, y: y * CELL + 2 });
    dir = pick;
    x += DX[pick]; y += DY[pick];
  }
  pts.push({ x: x * CELL + 2, y: y * CELL + 2 });
  return pts;
}
