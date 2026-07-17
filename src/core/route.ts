// Grid A* router for critical nets.
//
// Routes the highest-priority (non-ground) nets over a coarse two-layer
// occupancy grid, mutating layout.routes / layout.vias in place. This is a
// *critical-net* router: it deliberately routes only the top handful of nets
// and leaves everything else as ratsnest for the scorer to penalize.

import { Pt, dist } from "./geometry";
import { Design, Layout, Net, RouteSegment, Via } from "./types";
import { courtyardWorld, netPads } from "./layoututil";
import { RNG } from "./rng";

const CELL = 0.5; // grid cell size in mm
const F_CU = 0;
const B_CU = 1;
const OBSTACLE_PENALTY = 8; // extra cost (mm-equivalent) to cross a component-courtyard cell (soft — unchanged)
const VIA_COST = 4; // cost of a layer change (board via)
const MAX_EXPANSIONS = 20000;
const MAX_NETS = 14;
const NO_OWNER = -1; // netOwner sentinel: cell not yet claimed by any routed net this pass

// LAYLA_AUDIT.md finding B: a cell already carrying a *different*
// net's copper used to only cost OBSTACLE_PENALTY extra to cross, so two
// different nets could legally route through/over the same cell (an
// electrical short) if that was cheaper than detouring. netOwner below
// tracks which net (by Net.code, a small positive integer — 0 is never a
// valid code, see classify.ts) currently claims each cell; a different net
// trying to enter an owned cell is now a hard block (the cell is simply
// never added to the A* open set for that net), while the owning net can
// still re-enter its own cells (legitimate for pad-to-pad fan-out within one
// net's route). Component-courtyard obstacles are unchanged: still a soft
// OBSTACLE_PENALTY, not a hard block — that's a separate, out-of-scope
// question from this prompt (preventing inter-net shorts specifically).

// ---------------------------------------------------------------------------
// Minimal binary heap keyed by f-score.
// ---------------------------------------------------------------------------
class MinHeap {
  private fs: number[] = [];
  private ids: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, f: number): void {
    this.fs.push(f);
    this.ids.push(id);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.fs[p] <= this.fs[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const n = this.ids.length;
    const topId = this.ids[0];
    const lastId = this.ids[n - 1];
    const lastF = this.fs[n - 1];
    this.ids.pop();
    this.fs.pop();
    if (n > 1) {
      this.ids[0] = lastId;
      this.fs[0] = lastF;
      this.down(0);
    }
    return topId;
  }
  private down(i: number): void {
    const n = this.ids.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.fs[l] < this.fs[m]) m = l;
      if (r < n && this.fs[r] < this.fs[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
  private swap(a: number, b: number): void {
    const tf = this.fs[a];
    this.fs[a] = this.fs[b];
    this.fs[b] = tf;
    const ti = this.ids[a];
    this.ids[a] = this.ids[b];
    this.ids[b] = ti;
  }
}

// ---------------------------------------------------------------------------
// Occupancy grid.
// ---------------------------------------------------------------------------
interface Grid {
  cols: number;
  rows: number;
  // courtyardObstacle[layer] indexed by gy*cols+gx (1 = inside a component
  // courtyard — soft penalty, unchanged from before this prompt).
  courtyardObstacle: [Uint8Array, Uint8Array];
  // netOwner[layer] indexed by gy*cols+gx: NO_OWNER (free) or the Net.code
  // that has already routed copper through this cell — hard block for any
  // other net (see NO_OWNER comment above).
  netOwner: [Int32Array, Int32Array];
}

function layerName(layer: number): "F.Cu" | "B.Cu" {
  return layer === B_CU ? "B.Cu" : "F.Cu";
}

function toGX(x: number, cols: number): number {
  return clamp(Math.round(x / CELL), 0, cols - 1);
}
function toGY(y: number, rows: number): number {
  return clamp(Math.round(y / CELL), 0, rows - 1);
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function cellWorld(g: number): number {
  return g * CELL;
}

function widthForNet(design: Design, net: Net): number {
  const b = design.board;
  if (net.classes.includes("high_current")) return b.highCurrentTraceW;
  if (net.classes.includes("power")) return b.powerTraceW;
  return b.defaultTraceW;
}

// Nearest-neighbour tour over pad points (starting from index 0).
function nnTour(pts: Pt[]): Pt[] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const used = new Array<boolean>(n).fill(false);
  const order: Pt[] = [];
  let cur = 0;
  used[0] = true;
  order.push(pts[0]);
  for (let step = 1; step < n; step++) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const d = dist(pts[cur], pts[j]);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) break;
    used[best] = true;
    order.push(pts[best]);
    cur = best;
  }
  return order;
}

interface Cell {
  gx: number;
  gy: number;
  layer: number;
}

// A* between two grid cells. Returns the cell path (inclusive of both ends),
// or null if no path is found within the expansion cap. `netCode` is the
// Net.code of the net currently being routed — cells owned by a different
// net are hard-blocked; cells owned by netCode itself (or unowned) remain
// passable.
function astar(grid: Grid, start: Cell, goal: Cell, netCode: number): Cell[] | null {
  const { cols, rows } = grid;
  const planeSize = cols * rows;

  const stateId = (gx: number, gy: number, layer: number): number =>
    layer * planeSize + gy * cols + gx;

  const startId = stateId(start.gx, start.gy, start.layer);
  const goalId = stateId(goal.gx, goal.gy, goal.layer);

  const heuristic = (gx: number, gy: number): number =>
    (Math.abs(gx - goal.gx) + Math.abs(gy - goal.gy)) * CELL;

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const open = new MinHeap();

  gScore.set(startId, 0);
  open.push(startId, heuristic(start.gx, start.gy));

  const closed = new Set<number>();
  let expansions = 0;

  while (open.size > 0) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    if (cur === goalId) {
      return reconstruct(cameFrom, cur, planeSize, cols);
    }
    closed.add(cur);
    if (++expansions > MAX_EXPANSIONS) return null;

    const layer = Math.floor(cur / planeSize);
    const rem = cur - layer * planeSize;
    const gy = Math.floor(rem / cols);
    const gx = rem - gy * cols;
    const baseG = gScore.get(cur) ?? Infinity;

    // 4-neighbour moves on the same layer.
    const nbrs = [
      [gx + 1, gy],
      [gx - 1, gy],
      [gx, gy + 1],
      [gx, gy - 1],
    ];
    for (const [nx, ny] of nbrs) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nid = stateId(nx, ny, layer);
      if (closed.has(nid)) continue;
      const nIdx = ny * cols + nx;
      const owner = grid.netOwner[layer][nIdx];
      if (owner !== NO_OWNER && owner !== netCode) continue; // hard block: another net's copper
      const penalty = grid.courtyardObstacle[layer][nIdx] ? OBSTACLE_PENALTY : 0;
      const tentative = baseG + CELL + penalty;
      if (tentative < (gScore.get(nid) ?? Infinity)) {
        gScore.set(nid, tentative);
        cameFrom.set(nid, cur);
        open.push(nid, tentative + heuristic(nx, ny));
      }
    }

    // Via move: switch to the other layer at the same (gx, gy). A via barrel
    // spans both layers at this (gx, gy), so it's blocked the same way if
    // the *other* layer's cell is already claimed by a different net.
    const other = layer === F_CU ? B_CU : F_CU;
    const vid = stateId(gx, gy, other);
    const cellIdx = gy * cols + gx;
    const otherOwner = grid.netOwner[other][cellIdx];
    if (!closed.has(vid) && (otherOwner === NO_OWNER || otherOwner === netCode)) {
      const tentative = baseG + VIA_COST;
      if (tentative < (gScore.get(vid) ?? Infinity)) {
        gScore.set(vid, tentative);
        cameFrom.set(vid, cur);
        open.push(vid, tentative + heuristic(gx, gy));
      }
    }
  }
  return null;
}

function reconstruct(
  cameFrom: Map<number, number>,
  endId: number,
  planeSize: number,
  cols: number,
): Cell[] {
  const path: Cell[] = [];
  let cur: number | undefined = endId;
  while (cur !== undefined) {
    const layer = Math.floor(cur / planeSize);
    const rem = cur - layer * planeSize;
    const gy = Math.floor(rem / cols);
    const gx = rem - gy * cols;
    path.push({ gx, gy, layer });
    cur = cameFrom.get(cur);
  }
  path.reverse();
  return path;
}

// Convert a same-layer run of cells into a simplified world polyline.
function runPolyline(run: Cell[]): Pt[] {
  const pts = run.map((c) => ({ x: cellWorld(c.gx), y: cellWorld(c.gy) }));
  if (pts.length <= 2) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    // Drop b if a-b-c are collinear (cross product ~ 0).
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Rasterize a world-space segment onto the grid at CELL resolution and claim
// every cell it passes through for netCode. Used to mark ownership from
// actual emitted geometry (including pad-snapped, analog endpoints) rather
// than from abstract grid-aligned path coordinates — see the comment in
// emitPath() for why those two are not interchangeable.
function markSegmentCells(grid: Grid, layer: number, a: Pt, b: Pt, netCode: number): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / CELL));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gx = clamp(Math.round((a.x + (b.x - a.x) * t) / CELL), 0, grid.cols - 1);
    const gy = clamp(Math.round((a.y + (b.y - a.y) * t) / CELL), 0, grid.rows - 1);
    grid.netOwner[layer][gy * grid.cols + gx] = netCode;
  }
}
function markPolylineCells(grid: Grid, layer: number, poly: Pt[], netCode: number): void {
  for (let i = 0; i + 1 < poly.length; i++) markSegmentCells(grid, layer, poly[i], poly[i + 1], netCode);
  if (poly.length === 1) markSegmentCells(grid, layer, poly[0], poly[0], netCode);
}
// True if any cell the segment a->b rasterizes to is already owned by a net
// other than netCode.
function segmentBlockedByOtherNet(grid: Grid, layer: number, a: Pt, b: Pt, netCode: number): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / CELL));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gx = clamp(Math.round((a.x + (b.x - a.x) * t) / CELL), 0, grid.cols - 1);
    const gy = clamp(Math.round((a.y + (b.y - a.y) * t) / CELL), 0, grid.rows - 1);
    const owner = grid.netOwner[layer][gy * grid.cols + gx];
    if (owner !== NO_OWNER && owner !== netCode) return true;
  }
  return false;
}

// Emit RouteSegments + Vias for a found cell path, snapping the global
// endpoints to the exact pad positions. Also records used cells on the grid.
// Returns false (emitting nothing) if the actual geometry — after the
// pad-snap — would cross a cell owned by a different net: A*'s hard-block
// only validated the abstract grid-aligned path; snapping the first/last
// polyline point to the exact (analog) pad position can shift the rendered
// segment into a cell A* never checked, since that shift happens after
// pathfinding. Validating the real geometry here, before committing
// anything, is what makes "no two nets share a cell" hold for what's
// actually written rather than just for the path search.
function emitPath(
  grid: Grid,
  path: Cell[],
  netName: string,
  netCode: number,
  width: number,
  startPad: Pt,
  goalPad: Pt,
  routes: RouteSegment[],
  vias: Via[],
): boolean {
  // Split into per-layer runs (a via sits between two runs).
  const runs: Cell[][] = [];
  let cur: Cell[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    if (path[i].layer !== path[i - 1].layer) {
      runs.push(cur);
      cur = [path[i]];
    } else {
      cur.push(path[i]);
    }
  }
  runs.push(cur);

  // Build per-run polylines, then snap global first/last endpoints to the
  // exact pad positions (analog, not grid-quantized).
  const polylines = runs.map(runPolyline);
  if (polylines[0].length > 0) polylines[0][0] = { x: startPad.x, y: startPad.y };
  const lastPoly = polylines[polylines.length - 1];
  if (lastPoly.length > 0) lastPoly[lastPoly.length - 1] = { x: goalPad.x, y: goalPad.y };

  // Validate every segment of the actual (post-snap) geometry against
  // other-net ownership before touching `routes`/`vias`/`grid` at all.
  for (let r = 0; r < runs.length; r++) {
    const layer = runs[r][0].layer;
    const poly = polylines[r];
    for (let i = 0; i + 1 < poly.length; i++) {
      if (segmentBlockedByOtherNet(grid, layer, poly[i], poly[i + 1], netCode)) return false;
    }
  }

  // Claim cells for this net from the actual emitted geometry (not the
  // abstract A* path cells — see the function comment above).
  for (let r = 0; r < runs.length; r++) {
    markPolylineCells(grid, runs[r][0].layer, polylines[r], netCode);
  }
  // A via barrel spans both layers at each junction cell, so claim the other
  // layer there too (consistent with the hard-block check on via moves).
  for (let r = 0; r + 1 < runs.length; r++) {
    const j = runs[r + 1][0];
    grid.netOwner[j.layer === F_CU ? B_CU : F_CU][j.gy * grid.cols + j.gx] = netCode;
  }

  for (let r = 0; r < runs.length; r++) {
    const layer = layerName(runs[r][0].layer);
    const poly = polylines[r];
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i];
      const b = poly[i + 1];
      if (a.x === b.x && a.y === b.y) continue;
      routes.push({ net: netName, layer, width, a, b });
    }
    // A via lives at the junction between run r and run r+1.
    if (r + 1 < runs.length) {
      const junction = runs[r + 1][0];
      vias.push({ at: { x: cellWorld(junction.gx), y: cellWorld(junction.gy) }, net: netName });
    }
  }
  return true;
}

export function routeCritical(design: Design, layout: Layout, _rng: RNG): void {
  const board = design.board;
  const cols = Math.max(1, Math.ceil(board.width / CELL));
  const rows = Math.max(1, Math.ceil(board.height / CELL));
  const grid: Grid = {
    cols,
    rows,
    courtyardObstacle: [new Uint8Array(cols * rows), new Uint8Array(cols * rows)],
    netOwner: [new Int32Array(cols * rows).fill(NO_OWNER), new Int32Array(cols * rows).fill(NO_OWNER)],
  };

  // 1. Mark component courtyards as penalized cells on both layers.
  for (const ref of Object.keys(layout.placements)) {
    const pl = layout.placements[ref];
    const box = courtyardWorld(design, pl);
    const gx0 = toGX(box.minX, cols);
    const gx1 = toGX(box.maxX, cols);
    const gy0 = toGY(box.minY, rows);
    const gy1 = toGY(box.maxY, rows);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const idx = gy * cols + gx;
        grid.courtyardObstacle[F_CU][idx] = 1;
        grid.courtyardObstacle[B_CU][idx] = 1;
      }
    }
  }

  // 2. Select critical nets: skip ground, require >=2 pads, sort by priority.
  const candidates = design.nets
    .filter((n) => !n.classes.includes("ground"))
    .map((n) => ({ net: n, pads: netPads(design, layout, n) }))
    .filter((c) => c.pads.length >= 2)
    .sort((a, b) => b.net.priority - a.net.priority)
    .slice(0, MAX_NETS);

  // 3-6. Route each selected net as a nearest-neighbour chain.
  for (const { net, pads } of candidates) {
    const width = widthForNet(design, net);
    const tour = nnTour(pads);

    for (let i = 0; i + 1 < tour.length; i++) {
      const a = tour[i];
      const b = tour[i + 1];
      const start: Cell = { gx: toGX(a.x, cols), gy: toGY(a.y, rows), layer: F_CU };
      const goal: Cell = { gx: toGX(b.x, cols), gy: toGY(b.y, rows), layer: F_CU };

      // Endpoints share a cell: emit a direct segment so the pads connect —
      // but only if none of the cells that segment actually rasterizes to
      // are already claimed by a *different* net (a hard-block here mirrors
      // the astar check below; otherwise this shortcut path could still
      // draw an overlapping segment straight through another net's copper
      // without ever touching astar). Checked against the real a->b
      // geometry, not just the shared nominal cell, for the same reason
      // emitPath() marks ownership from rasterized polylines rather than
      // abstract path cells — analog pad positions don't always round to
      // the cell their nominal grid coordinate suggests.
      if (start.gx === goal.gx && start.gy === goal.gy) {
        if (a.x !== b.x || a.y !== b.y) {
          if (segmentBlockedByOtherNet(grid, F_CU, a, b, net.code)) continue; // leave as ratsnest
          layout.routes.push({
            net: net.name,
            layer: "F.Cu",
            width,
            a: { x: a.x, y: a.y },
            b: { x: b.x, y: b.y },
          });
          markSegmentCells(grid, F_CU, a, b, net.code);
        }
        continue;
      }

      // A*'s start state is never run through the neighbor-expansion
      // hard-block (only cells *entered while searching* are checked), so a
      // net whose own pad quantizes into a cell a different net already
      // claimed — common for adjacent pins on a fine-pitch package, where
      // two different nets' pads can legitimately sit within one 0.5mm
      // cell of each other — could start (or, symmetrically, finish)
      // routing from inside that other net's territory undetected. Reject
      // the leg outright in that case rather than let it through unchecked.
      const sIdx = start.gy * cols + start.gx;
      const gIdx = goal.gy * cols + goal.gx;
      const startOwner = grid.netOwner[F_CU][sIdx];
      const goalOwner = grid.netOwner[F_CU][gIdx];
      if ((startOwner !== NO_OWNER && startOwner !== net.code) || (goalOwner !== NO_OWNER && goalOwner !== net.code)) {
        continue; // leave as ratsnest
      }

      // Allow the endpoint cells to be entered even if covered by courtyard.
      const sF = grid.courtyardObstacle[F_CU][sIdx];
      const gF = grid.courtyardObstacle[F_CU][gIdx];
      grid.courtyardObstacle[F_CU][sIdx] = 0;
      grid.courtyardObstacle[F_CU][gIdx] = 0;

      const path = astar(grid, start, goal, net.code);

      // Restore endpoint obstacle flags before emitting (emitPath re-marks).
      grid.courtyardObstacle[F_CU][sIdx] = sF;
      grid.courtyardObstacle[F_CU][gIdx] = gF;

      if (!path) continue; // leave as ratsnest
      // emitPath() returns false (nothing committed) if the pad-snapped
      // geometry collides with another net's already-claimed cells even
      // though the abstract A* path was clear — also left as ratsnest.
      emitPath(grid, path, net.name, net.code, width, a, b, layout.routes, layout.vias);
    }
  }
}
