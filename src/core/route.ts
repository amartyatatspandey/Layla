// Grid A* router with tiered coverage and negotiated-congestion rip-up.
//
// Foreign-net occupancy is always a hard A* block (never a soft cost that
// could permit shorts). Negotiation works by ripping up at most two
// lower-priority victim nets, applying congestion history costs, and
// retrying for at most three deterministic passes.
//
// Tier policy (bundled boards):
//   small  — buck_imu, motor_driver, rf_sensor: all demand nets, target 100%
//   medium — robot_soc: all demand nets, target ≥98% (placement-locality ceiling)
//   stress — mainboard: critical/capped (MAX_NETS) only, target ≥5%

import { Pt, dist } from "./geometry";
import { Design, Layout, Net, RouteSegment, Via } from "./types";
import { courtyardWorld, netPads, padWorld } from "./layoututil";
import { RNG } from "./rng";

const CELL = 0.5; // grid cell size in mm
const F_CU = 0;
const B_CU = 1;
const OBSTACLE_PENALTY = 8; // soft courtyard cost (mm-equivalent)
const VIA_COST = 2; // prefer layer changes to escape pad congestion
const MAX_EXPANSIONS = 100000;
const MAX_NETS_CRITICAL = 14;
const NO_OWNER = -1;
const MAX_PASSES = 3;
const MAX_VICTIMS = 2;
/** Soft cost used only in blocker-diagnostic search (never during real routing). */
const DIAGNOSTIC_FOREIGN_COST = 500;
/** Per-rip-up / diagnostic congestion history increment. */
const CONGESTION_HISTORY = 40;

// LAYLA_AUDIT.md finding B: a cell already carrying a *different*
// net's copper used to only cost OBSTACLE_PENALTY extra to cross, so two
// different nets could legally route through/over the same cell (an
// electrical short). netOwner tracks which net (by Net.code) claims each
// cell; a different net trying to enter an owned cell is a hard block.
// Component-courtyard obstacles remain a soft OBSTACLE_PENALTY.

// ---------------------------------------------------------------------------
// Public routing types
// ---------------------------------------------------------------------------
export type RoutingTier = "small" | "medium" | "stress";

export interface RouteOpts {
  /** Override auto-detected tier from design.name / size. */
  tier?: RoutingTier;
  /**
   * `all` — every demand net (small/medium default).
   * `critical` — priority-capped (stress default / routeCritical wrapper).
   */
  mode?: "all" | "critical";
  /** Cap when mode is critical (default 14). */
  maxNets?: number;
  /** Negotiated-congestion pass budget (default 3). */
  maxPasses?: number;
  /** Max lower-priority victims ripped per failed net (default 2). */
  maxVictimsPerFailure?: number;
  /** Enable rip-up + congestion history (default true). */
  negotiatedCongestion?: boolean;
}

/**
 * Why a demand net remains without copper after routing.
 * Distinguishes expected placement-ceiling shortfalls from new regressions.
 */
export type UnroutedReason =
  /** Path blocked only by copper ineligible to rip (higher priority, or same-pri earlier). */
  | "blocked_by_protected_copper"
  /** Eligible victims existed but pass budget / rip-up budget was exhausted. */
  | "exceeded_pass_budget"
  /** Stress/critical mode never selected this demand net. */
  | "not_attempted"
  /** Attempted; A* found no path and diagnose saw no foreign owners (geometry/budget). */
  | "no_path"
  /** Catch-all — must not be silently treated as an expected shortfall. */
  | "unexplained";

export interface UnroutedNetFailure {
  net: string;
  reason: UnroutedReason;
  /** Foreign net names on the diagnostic path (if any), deterministic sort. */
  blockerNets: string[];
}

export interface RoutingReport {
  tier: RoutingTier;
  mode: "all" | "critical";
  attemptOrder: string[];
  routedNets: string[];
  unroutedNets: string[];
  /** Parallel detail for every entry in unroutedNets (same order). */
  unroutedFailures: UnroutedNetFailure[];
  congestionEvents: number;
  ripUps: number;
  passes: number;
  demandNetCount: number;
  /** satisfied / demand — same definition as Score.routeCompletion. */
  completionRatio: number;
}

export interface RouteResult {
  report: RoutingReport;
}

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
export interface RouteGrid {
  cols: number;
  rows: number;
  courtyardObstacle: [Uint8Array, Uint8Array];
  netOwner: [Int32Array, Int32Array];
  /** Soft congestion history — never overrides foreign-net hard blocks. */
  congestion: [Float32Array, Float32Array];
  /**
   * Pad-access exception: cell index → net codes that have a pad in this cell.
   * Those nets may enter the cell even if another net already claimed it
   * (fine-pitch pads can share a 0.5mm cell). Nets without a pad here still
   * see a hard block — this never lets arbitrary copper cross foreign nets.
   */
  padNets: [Map<number, Set<number>>, Map<number, Set<number>>];
}
type Grid = RouteGrid;

function hasPadAccess(grid: Grid, layer: number, cellIdx: number, netCode: number): boolean {
  const s = grid.padNets[layer].get(cellIdx);
  return !!s && s.has(netCode);
}

/** Foreign copper hard-block, with pad-access exception for the routing net. */
function foreignHardBlocked(grid: Grid, layer: number, cellIdx: number, netCode: number): boolean {
  const owner = grid.netOwner[layer][cellIdx];
  if (owner === NO_OWNER || owner === netCode) return false;
  if (hasPadAccess(grid, layer, cellIdx, netCode)) return false;
  return true;
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

type AstMode = "route" | "diagnose";

/**
 * A* between two grid cells.
 * `route` mode: foreign-net cells are hard-blocked.
 * `diagnose` mode: foreign-net cells cost DIAGNOSTIC_FOREIGN_COST (soft) so
 * we can recover which lower-priority owners sit on a wanted path — used
 * only for rip-up selection, never to emit copper.
 */
function astar(
  grid: Grid,
  start: Cell,
  goal: Cell,
  netCode: number,
  mode: AstMode = "route",
): Cell[] | null {
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
      if (owner !== NO_OWNER && owner !== netCode) {
        if (mode === "route" && foreignHardBlocked(grid, layer, nIdx, netCode)) continue;
      }
      const foreign =
        owner !== NO_OWNER && owner !== netCode && !hasPadAccess(grid, layer, nIdx, netCode)
          ? DIAGNOSTIC_FOREIGN_COST
          : 0;
      const penalty = grid.courtyardObstacle[layer][nIdx] ? OBSTACLE_PENALTY : 0;
      const cong = grid.congestion[layer][nIdx];
      const tentative = baseG + CELL + penalty + cong + foreign;
      if (tentative < (gScore.get(nid) ?? Infinity)) {
        gScore.set(nid, tentative);
        cameFrom.set(nid, cur);
        open.push(nid, tentative + heuristic(nx, ny));
      }
    }

    const other = layer === F_CU ? B_CU : F_CU;
    const vid = stateId(gx, gy, other);
    const cellIdx = gy * cols + gx;
    const otherOwner = grid.netOwner[other][cellIdx];
    const viaBlocked =
      otherOwner !== NO_OWNER &&
      otherOwner !== netCode &&
      mode === "route" &&
      foreignHardBlocked(grid, other, cellIdx, netCode);
    if (!closed.has(vid) && !viaBlocked) {
      const foreign =
        otherOwner !== NO_OWNER &&
        otherOwner !== netCode &&
        !hasPadAccess(grid, other, cellIdx, netCode)
          ? DIAGNOSTIC_FOREIGN_COST
          : 0;
      const tentative = baseG + VIA_COST + grid.congestion[other][cellIdx] + foreign;
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

function runPolyline(run: Cell[]): Pt[] {
  const pts = run.map((c) => ({ x: cellWorld(c.gx), y: cellWorld(c.gy) }));
  if (pts.length <= 2) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

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
function segmentBlockedByOtherNet(grid: Grid, layer: number, a: Pt, b: Pt, netCode: number): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / CELL));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gx = clamp(Math.round((a.x + (b.x - a.x) * t) / CELL), 0, grid.cols - 1);
    const gy = clamp(Math.round((a.y + (b.y - a.y) * t) / CELL), 0, grid.rows - 1);
    const idx = gy * grid.cols + gx;
    if (foreignHardBlocked(grid, layer, idx, netCode)) return true;
  }
  return false;
}

function bumpCongestionAlongPath(grid: Grid, path: Cell[]): void {
  for (const c of path) {
    grid.congestion[c.layer][c.gy * grid.cols + c.gx] += CONGESTION_HISTORY;
  }
}

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

  const polylines = runs.map(runPolyline);
  if (polylines[0].length > 0) polylines[0][0] = { x: startPad.x, y: startPad.y };
  const lastPoly = polylines[polylines.length - 1];
  if (lastPoly.length > 0) lastPoly[lastPoly.length - 1] = { x: goalPad.x, y: goalPad.y };

  for (let r = 0; r < runs.length; r++) {
    const layer = runs[r][0].layer;
    const poly = polylines[r];
    for (let i = 0; i + 1 < poly.length; i++) {
      if (segmentBlockedByOtherNet(grid, layer, poly[i], poly[i + 1], netCode)) return false;
    }
  }

  for (let r = 0; r < runs.length; r++) {
    markPolylineCells(grid, runs[r][0].layer, polylines[r], netCode);
  }
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
    if (r + 1 < runs.length) {
      const junction = runs[r + 1][0];
      vias.push({ at: { x: cellWorld(junction.gx), y: cellWorld(junction.gy) }, net: netName });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tier / candidate selection
// ---------------------------------------------------------------------------

const SMALL_BOARDS = new Set(["buck_imu", "motor_driver", "rf_sensor"]);
const MEDIUM_BOARDS = new Set(["robot_soc"]);
const STRESS_BOARDS = new Set(["mainboard"]);

/** Resolve routing tier from opts or bundled-board / size heuristics. */
export function resolveRoutingTier(design: Design, opts?: RouteOpts): RoutingTier {
  if (opts?.tier) return opts.tier;
  const name = design.name;
  if (STRESS_BOARDS.has(name)) return "stress";
  if (MEDIUM_BOARDS.has(name)) return "medium";
  if (SMALL_BOARDS.has(name)) return "small";
  // Unknown boards: size heuristic (component count).
  if (design.components.length >= 100) return "stress";
  if (design.components.length >= 40) return "medium";
  return "small";
}

/**
 * Tier completion floors (honest ceilings under current placement + locked
 * rip-up rules). Medium is ≥98% (61/62 on robot_soc) — not 100% — because
 * low-priority long-span nets can be placement-unroutable without ripping
 * protected-tier copper. See technical_debt.md placement-locality entry.
 */
export function tierCompletionTarget(tier: RoutingTier): number {
  if (tier === "stress") return 0.05;
  if (tier === "medium") return 0.98;
  return 1.0; // small
}

interface DemandNet {
  net: Net;
  pads: Pt[];
}

function demandNets(design: Design, layout: Layout): DemandNet[] {
  return design.nets
    .filter((n) => !n.classes.includes("ground"))
    .map((n) => ({ net: n, pads: netPads(design, layout, n) }))
    .filter((c) => c.pads.length >= 2)
    .sort((a, b) => {
      if (b.net.priority !== a.net.priority) return b.net.priority - a.net.priority;
      // Within a priority band, shorter spans first (less congestion).
      const spanA = netSpan(a.pads);
      const spanB = netSpan(b.pads);
      if (spanA !== spanB) return spanA - spanB;
      return a.net.code - b.net.code;
    });
}

function netSpan(pads: Pt[]): number {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const p of pads) {
    if (p.x < minx) minx = p.x;
    if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.y > maxy) maxy = p.y;
  }
  return (maxx - minx) + (maxy - miny);
}

function selectCandidates(
  all: DemandNet[],
  mode: "all" | "critical",
  maxNets: number,
): DemandNet[] {
  if (mode === "critical") return all.slice(0, maxNets);
  return all;
}

// ---------------------------------------------------------------------------
// Ownership release (rip-up) — only the owning net's cells / geometry
// ---------------------------------------------------------------------------

function releaseNetOwnership(grid: Grid, netCode: number): number {
  let cleared = 0;
  const n = grid.cols * grid.rows;
  for (const layer of [F_CU, B_CU] as const) {
    const plane = grid.netOwner[layer];
    for (let i = 0; i < n; i++) {
      if (plane[i] === netCode) {
        plane[i] = NO_OWNER;
        cleared++;
      }
    }
  }
  return cleared;
}

function removeNetGeometry(layout: Layout, netName: string): void {
  layout.routes = layout.routes.filter((r) => r.net !== netName);
  layout.vias = layout.vias.filter((v) => v.net !== netName);
}

/** Rip up one net: drop its copper and release only its netOwner cells. */
export function ripUpNet(grid: Grid, layout: Layout, net: Net): number {
  removeNetGeometry(layout, net.name);
  const cleared = releaseNetOwnership(grid, net.code);
  // Restore exclusive pad pre-claims so other nets cannot plow through pins.
  for (const layer of [F_CU, B_CU] as const) {
    for (const [idx, nets] of grid.padNets[layer]) {
      if (nets.size === 1 && nets.has(net.code)) {
        grid.netOwner[layer][idx] = net.code;
      }
    }
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Per-net routing + blocker diagnosis
// ---------------------------------------------------------------------------

function tryRouteLeg(
  grid: Grid,
  design: Design,
  layout: Layout,
  net: Net,
  a: Pt,
  b: Pt,
  preferLayer: number = F_CU,
): boolean {
  const cols = grid.cols;
  const rows = grid.rows;
  const width = widthForNet(design, net);
  const start: Cell = { gx: toGX(a.x, cols), gy: toGY(a.y, rows), layer: preferLayer };
  const goal: Cell = { gx: toGX(b.x, cols), gy: toGY(b.y, rows), layer: preferLayer };

  if (start.gx === goal.gx && start.gy === goal.gy) {
    if (a.x !== b.x || a.y !== b.y) {
      if (segmentBlockedByOtherNet(grid, preferLayer, a, b, net.code)) return false;
      layout.routes.push({
        net: net.name,
        layer: layerName(preferLayer),
        width,
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
      });
      markSegmentCells(grid, preferLayer, a, b, net.code);
    }
    return true;
  }

  const sIdx = start.gy * cols + start.gx;
  const gIdx = goal.gy * cols + goal.gx;
  // Pad-access exception: start/goal may sit in a fine-pitch cell already
  // claimed by another net that shares the cell with our pad.
  if (foreignHardBlocked(grid, preferLayer, sIdx, net.code) || foreignHardBlocked(grid, preferLayer, gIdx, net.code)) {
    return false;
  }

  const sF = grid.courtyardObstacle[preferLayer][sIdx];
  const gF = grid.courtyardObstacle[preferLayer][gIdx];
  grid.courtyardObstacle[preferLayer][sIdx] = 0;
  grid.courtyardObstacle[preferLayer][gIdx] = 0;

  const path = astar(grid, start, goal, net.code, "route");

  grid.courtyardObstacle[preferLayer][sIdx] = sF;
  grid.courtyardObstacle[preferLayer][gIdx] = gF;

  if (!path) return false;
  return emitPath(grid, path, net.name, net.code, width, a, b, layout.routes, layout.vias);
}

/**
 * Route a net's NN-tour legs. Keeps successful legs (same as historical
 * critical router) so multi-pin nets can partially satisfy score.routeCompletion.
 * Returns whether every leg succeeded (used for negotiated retry).
 */
function tryRouteNet(grid: Grid, design: Design, layout: Layout, net: Net, pads: Pt[]): boolean {
  ripUpNet(grid, layout, net);
  const tour = nnTour(pads);
  let complete = true;
  for (let i = 0; i + 1 < tour.length; i++) {
    const a = tour[i];
    const b = tour[i + 1];
    let ok = tryRouteLeg(grid, design, layout, net, a, b, F_CU);
    if (!ok) ok = tryRouteLeg(grid, design, layout, net, a, b, B_CU);
    if (!ok) complete = false;
  }
  return complete;
}

/**
 * Diagnostic path that soft-costs foreign copper to identify blocker owners
 * on a path the failing net "wants". Real routing never uses this mode.
 * Returns only *eligible* rip-up victims (lower priority / equal-later).
 */
function diagnoseBlockers(
  grid: Grid,
  net: Net,
  pads: Pt[],
  codeToNet: Map<number, Net>,
): Net[] {
  return eligibleVictimsFromOwners(net, diagnoseAllForeignOwners(grid, net, pads, codeToNet), codeToNet);
}

/** All foreign net owners on a soft diagnostic path (no eligibility filter). */
function diagnoseAllForeignOwners(
  grid: Grid,
  net: Net,
  pads: Pt[],
  codeToNet: Map<number, Net>,
): Net[] {
  const cols = grid.cols;
  const rows = grid.rows;
  const owners = new Set<number>();
  const tour = nnTour(pads);

  for (let i = 0; i + 1 < tour.length; i++) {
    const a = tour[i];
    const b = tour[i + 1];
    const start: Cell = { gx: toGX(a.x, cols), gy: toGY(a.y, rows), layer: F_CU };
    const goal: Cell = { gx: toGX(b.x, cols), gy: toGY(b.y, rows), layer: F_CU };

    for (const cell of [start, goal]) {
      const idx = cell.gy * cols + cell.gx;
      const owner = grid.netOwner[F_CU][idx];
      if (owner !== NO_OWNER && owner !== net.code && !hasPadAccess(grid, F_CU, idx, net.code)) {
        owners.add(owner);
      }
    }

    if (start.gx === goal.gx && start.gy === goal.gy) continue;

    const sIdx = start.gy * cols + start.gx;
    const gIdx = goal.gy * cols + goal.gx;
    const sF = grid.courtyardObstacle[F_CU][sIdx];
    const gF = grid.courtyardObstacle[F_CU][gIdx];
    grid.courtyardObstacle[F_CU][sIdx] = 0;
    grid.courtyardObstacle[F_CU][gIdx] = 0;
    const path = astar(grid, start, goal, net.code, "diagnose");
    grid.courtyardObstacle[F_CU][sIdx] = sF;
    grid.courtyardObstacle[F_CU][gIdx] = gF;

    if (!path) continue;
    for (const c of path) {
      const owner = grid.netOwner[c.layer][c.gy * cols + c.gx];
      if (owner !== NO_OWNER && owner !== net.code) owners.add(owner);
    }
  }

  const nets: Net[] = [];
  for (const code of owners) {
    const other = codeToNet.get(code);
    if (other) nets.push(other);
  }
  nets.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.code - b.code;
  });
  return nets;
}

function eligibleVictimsFromOwners(
  net: Net,
  foreign: Net[],
  _codeToNet: Map<number, Net>,
): Net[] {
  // Eligible victims: lower priority than the failing net, or equal priority
  // with a higher code (later in the deterministic attempt order). Higher-
  // priority blockers stay. Sort: priority ascending, then code ascending.
  const victims: Net[] = [];
  for (const other of foreign) {
    const lowerPri = other.priority < net.priority;
    const equalLater = other.priority === net.priority && other.code > net.code;
    if (!lowerPri && !equalLater) continue;
    victims.push(other);
  }
  victims.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.code - b.code;
  });
  return victims;
}

function classifyUnroutedFailure(
  foreign: Net[],
  eligible: Net[],
  opts: { negotiated: boolean; lastPass: boolean; notAttempted: boolean },
): UnroutedReason {
  if (opts.notAttempted) return "not_attempted";
  if (foreign.length > 0 && eligible.length === 0) return "blocked_by_protected_copper";
  if (opts.negotiated && opts.lastPass && eligible.length > 0) return "exceeded_pass_budget";
  if (foreign.length === 0) return "no_path";
  return "unexplained";
}

/** Bump congestion along a soft-cost diagnostic path (history cost for later passes). */
function bumpDiagnosticCongestion(grid: Grid, net: Net, pads: Pt[]): void {
  const cols = grid.cols;
  const rows = grid.rows;
  const tour = nnTour(pads);
  for (let i = 0; i + 1 < tour.length; i++) {
    const a = tour[i];
    const b = tour[i + 1];
    const start: Cell = { gx: toGX(a.x, cols), gy: toGY(a.y, rows), layer: F_CU };
    const goal: Cell = { gx: toGX(b.x, cols), gy: toGY(b.y, rows), layer: F_CU };
    if (start.gx === goal.gx && start.gy === goal.gy) {
      grid.congestion[F_CU][start.gy * cols + start.gx] += CONGESTION_HISTORY;
      continue;
    }
    const sIdx = start.gy * cols + start.gx;
    const gIdx = goal.gy * cols + goal.gx;
    const sF = grid.courtyardObstacle[F_CU][sIdx];
    const gF = grid.courtyardObstacle[F_CU][gIdx];
    grid.courtyardObstacle[F_CU][sIdx] = 0;
    grid.courtyardObstacle[F_CU][gIdx] = 0;
    const path = astar(grid, start, goal, net.code, "diagnose");
    grid.courtyardObstacle[F_CU][sIdx] = sF;
    grid.courtyardObstacle[F_CU][gIdx] = gF;
    if (path) bumpCongestionAlongPath(grid, path);
  }
}

function buildCourtyards(design: Design, layout: Layout, grid: Grid): void {
  const { cols, rows } = grid;
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
}

function emptyGrid(cols: number, rows: number): Grid {
  const n = cols * rows;
  return {
    cols,
    rows,
    courtyardObstacle: [new Uint8Array(n), new Uint8Array(n)],
    netOwner: [new Int32Array(n).fill(NO_OWNER), new Int32Array(n).fill(NO_OWNER)],
    congestion: [new Float32Array(n), new Float32Array(n)],
    padNets: [new Map(), new Map()],
  };
}

function registerPadAccess(design: Design, layout: Layout, grid: Grid): void {
  const { cols, rows } = grid;
  // Record pad access + exclusive pre-claim on the component's copper layer
  // only. The opposite layer stays free so routes can pass under pads via a
  // layer change — pre-claiming both layers was sealing the board.
  for (const net of design.nets) {
    for (const pr of net.pins) {
      const pl = layout.placements[pr.ref];
      if (!pl) continue;
      const w = padWorld(design, layout, pr.ref, pr.pad);
      if (!w) continue;
      const layer = pl.side === "back" ? B_CU : F_CU;
      const gx = toGX(w.x, cols);
      const gy = toGY(w.y, rows);
      const idx = gy * cols + gx;
      let s = grid.padNets[layer].get(idx);
      if (!s) {
        s = new Set();
        grid.padNets[layer].set(idx, s);
      }
      s.add(net.code);
    }
  }
  for (const layer of [F_CU, B_CU] as const) {
    for (const [idx, nets] of grid.padNets[layer]) {
      if (nets.size === 1) {
        grid.netOwner[layer][idx] = nets.values().next().value as number;
      }
    }
  }
}

/**
 * Primary router entry: clears route/via ownership, then routes demand nets
 * under the resolved tier policy with optional negotiated congestion.
 */
export function routeLayout(
  design: Design,
  layout: Layout,
  _rng: RNG,
  opts: RouteOpts = {},
): RouteResult {
  // Explicit clear + rebuild — never append onto stale copper.
  layout.routes = [];
  layout.vias = [];

  const board = design.board;
  const cols = Math.max(1, Math.ceil(board.width / CELL));
  const rows = Math.max(1, Math.ceil(board.height / CELL));
  const grid = emptyGrid(cols, rows);
  buildCourtyards(design, layout, grid);
  registerPadAccess(design, layout, grid);

  const tier = resolveRoutingTier(design, opts);
  const mode: "all" | "critical" =
    opts.mode ?? (tier === "stress" ? "critical" : "all");
  const maxNets = opts.maxNets ?? MAX_NETS_CRITICAL;
  const maxPasses = opts.maxPasses ?? MAX_PASSES;
  const maxVictims = opts.maxVictimsPerFailure ?? MAX_VICTIMS;
  const negotiated = opts.negotiatedCongestion ?? true;

  const allDemand = demandNets(design, layout);
  const candidates = selectCandidates(allDemand, mode, maxNets);
  const attemptOrder = candidates.map((c) => c.net.name);
  const codeToNet = new Map(design.nets.map((n) => [n.code, n]));
  const byName = new Map(candidates.map((c) => [c.net.name, c]));

  // Completeness is measured against *demand* nets (same as score.ts), not
  // against the critical subset alone — stress tier reports honest ratios.
  const demandNames = new Set(allDemand.map((c) => c.net.name));
  const demandNetCount = allDemand.length;

  const routed = new Set<string>();
  let ripUps = 0;
  let congestionEvents = 0;
  let passesUsed = 0;
  /** Last observed failure detail per attempted net (overwritten each fail). */
  const failureDetail = new Map<string, UnroutedNetFailure>();

  for (let pass = 0; pass < maxPasses; pass++) {
    passesUsed = pass + 1;
    const lastPass = pass >= maxPasses - 1;

    // Each negotiated pass rebuilds copper from scratch while keeping
    // congestion history, so higher-priority nets can vacate corridors that
    // failed lower-priority nets need (PathFinder-style), without ever
    // soft-crossing foreign copper.
    if (pass > 0 && negotiated) {
      layout.routes = [];
      layout.vias = [];
      for (const layer of [F_CU, B_CU] as const) {
        grid.netOwner[layer].fill(NO_OWNER);
        // Re-apply exclusive pad pre-claims after clearing copper.
        for (const [idx, nets] of grid.padNets[layer]) {
          if (nets.size === 1) {
            grid.netOwner[layer][idx] = nets.values().next().value as number;
          }
        }
      }
      routed.clear();
    }

    const nextFailed: string[] = [];

    for (const name of attemptOrder) {
      const cand = byName.get(name);
      if (!cand) continue;

      if (tryRouteNet(grid, design, layout, cand.net, cand.pads)) {
        routed.add(name);
        failureDetail.delete(name);
        continue;
      }

      // Incomplete / failed — diagnose blockers and apply congestion history.
      const foreign = diagnoseAllForeignOwners(grid, cand.net, cand.pads, codeToNet);
      const blockers = eligibleVictimsFromOwners(cand.net, foreign, codeToNet);
      bumpDiagnosticCongestion(grid, cand.net, cand.pads);

      const recordFail = () => {
        failureDetail.set(name, {
          net: name,
          reason: classifyUnroutedFailure(foreign, blockers, {
            negotiated,
            lastPass: lastPass || !negotiated,
            notAttempted: false,
          }),
          blockerNets: foreign.map((n) => n.name),
        });
        if (layout.routes.some((r) => r.net === name)) routed.add(name);
        else nextFailed.push(name);
      };

      if (!negotiated || lastPass) {
        recordFail();
        continue;
      }

      const victims = blockers.slice(0, maxVictims);
      if (victims.length === 0) {
        congestionEvents++;
        recordFail();
        continue;
      }

      congestionEvents++;
      for (const v of victims) {
        const ncells = cols * rows;
        for (const layer of [F_CU, B_CU] as const) {
          for (let i = 0; i < ncells; i++) {
            if (grid.netOwner[layer][i] === v.code) {
              grid.congestion[layer][i] += CONGESTION_HISTORY;
            }
          }
        }
        ripUpNet(grid, layout, v);
        ripUps++;
        routed.delete(v.name);
      }

      if (tryRouteNet(grid, design, layout, cand.net, cand.pads)) {
        routed.add(name);
        failureDetail.delete(name);
      } else {
        // Re-diagnose after rip-up for accurate final reason tags.
        const foreign2 = diagnoseAllForeignOwners(grid, cand.net, cand.pads, codeToNet);
        const blockers2 = eligibleVictimsFromOwners(cand.net, foreign2, codeToNet);
        failureDetail.set(name, {
          net: name,
          reason: classifyUnroutedFailure(foreign2, blockers2, {
            negotiated,
            lastPass: false,
            notAttempted: false,
          }),
          blockerNets: foreign2.map((n) => n.name),
        });
        if (layout.routes.some((r) => r.net === name)) routed.add(name);
        else nextFailed.push(name);
      }
    }

    if (nextFailed.length === 0) break;
  }

  // Final routed set from actual geometry (honest — not just the Set).
  const routedFromGeom = new Set(layout.routes.map((r) => r.net));
  const routedNets = attemptOrder.filter((n) => routedFromGeom.has(n));
  const unroutedAttempted = attemptOrder.filter((n) => !routedFromGeom.has(n));
  const unroutedNotAttempted = [...demandNames].filter(
    (n) => !attemptOrder.includes(n) && !routedFromGeom.has(n),
  );
  const unroutedNets = [...unroutedAttempted, ...unroutedNotAttempted];

  const unroutedFailures: UnroutedNetFailure[] = unroutedNets.map((n) => {
    if (unroutedNotAttempted.includes(n)) {
      return { net: n, reason: "not_attempted" as const, blockerNets: [] };
    }
    const detail = failureDetail.get(n);
    if (detail) return detail;
    return { net: n, reason: "unexplained" as const, blockerNets: [] };
  });

  // Same definition as score.ts: demand nets with any copper / demand count.
  let satisfied = 0;
  for (const n of demandNames) if (routedFromGeom.has(n)) satisfied++;
  const completionRatio = demandNetCount ? satisfied / demandNetCount : 1;

  return {
    report: {
      tier,
      mode,
      attemptOrder,
      routedNets,
      unroutedNets,
      unroutedFailures,
      congestionEvents,
      ripUps,
      passes: passesUsed,
      demandNetCount,
      completionRatio,
    },
  };
}

/**
 * Compatibility wrapper: critical/capped routing (stress-tier behaviour).
 * Callers that need the old capped mode should use this; prefer routeLayout
 * for tier-aware full-demand routing.
 */
export function routeCritical(
  design: Design,
  layout: Layout,
  rng: RNG,
  opts: RouteOpts = {},
): RouteResult {
  return routeLayout(design, layout, rng, { ...opts, mode: "critical" });
}

/** Expose grid cell size for independent occupancy scans in gate tests. */
export const ROUTE_GRID_CELL_MM = CELL;
export const ROUTE_NO_OWNER = NO_OWNER;

/**
 * Build a fresh ownership grid matching an existing layout's copper — used by
 * gate tests to verify rip-up releases only the owning net's cells.
 */
export function ownershipGridFromLayout(design: Design, layout: Layout): Grid {
  const cols = Math.max(1, Math.ceil(design.board.width / CELL));
  const rows = Math.max(1, Math.ceil(design.board.height / CELL));
  const grid = emptyGrid(cols, rows);
  registerPadAccess(design, layout, grid);
  const nameToCode = new Map(design.nets.map((n) => [n.name, n.code]));
  for (const seg of layout.routes) {
    const code = nameToCode.get(seg.net);
    if (code === undefined) continue;
    const layer = seg.layer === "B.Cu" ? B_CU : F_CU;
    markSegmentCells(grid, layer, seg.a, seg.b, code);
  }
  for (const via of layout.vias) {
    const code = nameToCode.get(via.net);
    if (code === undefined) continue;
    const gx = toGX(via.at.x, cols);
    const gy = toGY(via.at.y, rows);
    grid.netOwner[F_CU][gy * cols + gx] = code;
    grid.netOwner[B_CU][gy * cols + gx] = code;
  }
  return grid;
}

/**
 * Cells where two or more nets have pads (fine-pitch co-occupancy). Shared
 * route copper in these cells is footprint-forced pad access, not a router short.
 */
export function multiPadCellKeys(design: Design, layout: Layout): Set<string> {
  const cols = Math.max(1, Math.ceil(design.board.width / CELL));
  const counts = new Map<string, Set<string>>();
  for (const net of design.nets) {
    for (const pr of net.pins) {
      const pl = layout.placements[pr.ref];
      if (!pl) continue;
      const w = padWorld(design, layout, pr.ref, pr.pad);
      if (!w) continue;
      const layer = pl.side === "back" ? "B.Cu" : "F.Cu";
      const gx = toGX(w.x, cols);
      const gy = toGY(w.y, Math.max(1, Math.ceil(design.board.height / CELL)));
      const key = `${layer}:${gx}:${gy}`;
      let s = counts.get(key);
      if (!s) { s = new Set(); counts.set(key, s); }
      s.add(net.name);
    }
  }
  const out = new Set<string>();
  for (const [key, nets] of counts) if (nets.size > 1) out.add(key);
  return out;
}

/**
 * Post-hoc routing summary from an existing layout (does not mutate copper).
 * completionRatio matches Score.routeCompletion (demand nets with any copper).
 * Reason tags are unavailable without a live routeLayout pass — unrouted nets
 * are tagged `unexplained` so callers know this is not a live diagnosis.
 */
export function summarizeRoutingFromLayout(design: Design, layout: Layout): {
  tier: RoutingTier;
  demandNetCount: number;
  routedNets: string[];
  unroutedNets: string[];
  unroutedFailures: UnroutedNetFailure[];
  completionRatio: number;
} {
  const tier = resolveRoutingTier(design);
  const all = demandNets(design, layout);
  const routedGeom = new Set(layout.routes.map((r) => r.net));
  const routedNets = all.filter((c) => routedGeom.has(c.net.name)).map((c) => c.net.name);
  const unroutedNets = all.filter((c) => !routedGeom.has(c.net.name)).map((c) => c.net.name);
  const demandNetCount = all.length;
  const completionRatio = demandNetCount ? routedNets.length / demandNetCount : 1;
  const unroutedFailures: UnroutedNetFailure[] = unroutedNets.map((n) => ({
    net: n,
    reason: "unexplained",
    blockerNets: [],
  }));
  return { tier, demandNetCount, routedNets, unroutedNets, unroutedFailures, completionRatio };
}
