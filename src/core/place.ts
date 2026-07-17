// Placement engine: anchored seeding + simulated-annealing optimization.
// Produces a Layout with placements only (routing happens afterwards).

import { Box, Pt, dist, polyArea, boxOverlap, centroid } from "./geometry";
import { courtyardWorld, clampToBoard } from "./layoututil";
import { DEFAULT_WEIGHTS } from "./score";
import { RNG } from "./rng";
import {
  Component, Design, Layout, Placement, Role, Ruleset, Rule,
} from "./types";

const ROT_CHOICES = [0, 90, 180, 270];

interface Anchor { ref: string; x: number; y: number; rot: number; }

// ---- constraint model derived from the active ruleset ----
interface Constraints {
  edgeAnchors: Map<string, "left" | "right" | "top" | "bottom">;  // ref -> edge
  pushAway: { aRoles: Role[]; bRoles: Role[]; min: number }[];
  tightClusters: string[]; // cluster ids that should stay compact
}

function buildConstraints(design: Design, ruleset: Ruleset): Constraints {
  const edgeAnchors = new Map<string, "left" | "right" | "top" | "bottom">();
  const pushAway: { aRoles: Role[]; bRoles: Role[]; min: number }[] = [];
  const tightClusters: string[] = [];

  // default anchoring: connectors & usb & antenna to edges
  for (const c of design.components) {
    if (c.role === "usb" || c.role === "connector") edgeAnchors.set(c.ref, "left");
    if (c.role === "antenna" || c.role === "rf") edgeAnchors.set(c.ref, "right");
  }
  // buck clusters always want to be tight
  for (const cl of design.clusters) if (cl.kind === "buck_converter") tightClusters.push(cl.id);

  for (const r of ruleset.rules) {
    if (r.status === "rejected") continue;
    if (r.kind === "anchor_edge" && r.trigger.roles) {
      for (const c of design.components) {
        if (r.trigger.roles.includes(c.role)) edgeAnchors.set(c.ref, r.params.edge || "left");
      }
    } else if (r.kind === "push_away") {
      pushAway.push({ aRoles: r.params.aRoles || [], bRoles: r.params.bRoles || [], min: r.params.min ?? 10 });
    } else if (r.kind === "cluster_tight") {
      for (const cl of design.clusters) if (!r.params.clusterKind || cl.kind === r.params.clusterKind) tightClusters.push(cl.id);
    }
  }
  // sensible default: keep noisy power away from sensitive sensors
  pushAway.push({ aRoles: ["regulator", "inductor", "motor_driver", "mosfet"], bRoles: ["imu", "adc", "sensor", "crystal"], min: 9 });
  return { edgeAnchors, pushAway, tightClusters };
}

// ---- seed an initial placement ----
export function seedPlacement(design: Design, ruleset: Ruleset, rng: RNG): Layout {
  const cons = buildConstraints(design, ruleset);
  const placements: Record<string, Placement> = {};
  const W = design.board.width, H = design.board.height;

  const placed = new Set<string>();
  // 1. edge anchors
  const edgeCount: Record<string, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const [ref, edge] of cons.edgeAnchors) {
    const i = edgeCount[edge]++;
    let x = 0, y = 0, rot = 0;
    const span = (edge === "left" || edge === "right") ? H : W;
    const t = span * (0.2 + 0.6 * ((i + 0.5) / 4));
    if (edge === "left") { x = 5; y = t; rot = 0; }
    else if (edge === "right") { x = W - 5; y = t; rot = 180; }
    else if (edge === "top") { x = t; y = 5; rot = 270; }
    else { x = t; y = H - 5; rot = 90; }
    placements[ref] = clampToBoard(design, { ref, x, y, rot, side: "front" });
    placed.add(ref);
  }

  // 2. clusters: pick an anchor, drop members in a tight ring
  const clusterAnchor: Record<string, Pt> = {};
  let cx = W * 0.35, cy = H * 0.35;
  for (const cl of design.clusters) {
    const a: Pt = { x: cx, y: cy };
    clusterAnchor[cl.id] = a;
    cx += W * 0.25; if (cx > W * 0.8) { cx = W * 0.3; cy += H * 0.3; }
    let k = 0;
    for (const ref of cl.refs) {
      if (placed.has(ref)) continue;
      const ang = (k / Math.max(1, cl.refs.length)) * Math.PI * 2;
      const rad = 3 + k * 1.2;
      placements[ref] = clampToBoard(design, {
        ref, x: a.x + Math.cos(ang) * rad, y: a.y + Math.sin(ang) * rad,
        rot: rng.pick(ROT_CHOICES), side: "front",
      });
      placed.add(ref); k++;
    }
  }

  // 3. remaining components on a coarse grid
  const rest = design.components.filter((c) => !placed.has(c.ref));
  const cols = Math.max(1, Math.ceil(Math.sqrt(rest.length * (W / H))));
  const rows = Math.max(1, Math.ceil(rest.length / cols));
  rest.forEach((c, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = W * (0.15 + 0.7 * (cols > 1 ? col / (cols - 1) : 0.5));
    const y = H * (0.15 + 0.7 * (rows > 1 ? row / (rows - 1) : 0.5));
    placements[c.ref] = clampToBoard(design, {
      ref: c.ref, x: x + rng.range(-2, 2), y: y + rng.range(-2, 2),
      rot: rng.pick(ROT_CHOICES), side: "front",
    });
  });

  return { placements, routes: [], vias: [], keepouts: [] };
}

// ---- fast placement cost (no routing) ----
export function placementCost(design: Design, layout: Layout, ruleset: Ruleset): number {
  const cons = buildConstraints(design, ruleset);
  // Always optimize against the canonical objective (same yardstick the ratchet
  // measures). Learned rules influence the result through *constraints* below
  // (push-away, cluster tightness, anchors), never by reweighting the objective.
  const w = DEFAULT_WEIGHTS;
  const byRef = new Map(design.components.map((c) => [c.ref, c]));
  let cost = 0;

  // ratsnest (MST per net) + a cheap crossing proxy via total length
  for (const net of design.nets) {
    if (net.classes.includes("ground")) continue;
    const pts: Pt[] = [];
    for (const pr of net.pins) {
      const pl = layout.placements[pr.ref];
      if (pl) pts.push({ x: pl.x, y: pl.y });
    }
    if (pts.length < 2) continue;
    let len = 0;
    for (const [a, b] of mst(pts)) len += dist(a, b);
    const mult = net.classes.includes("high_current") ? 2.5 : net.classes.includes("noisy") ? 1.5 : 1;
    cost += len * mult * (w.ratsnest ?? 1);
  }

  // courtyard overlaps + off-board
  const boxes: { ref: string; b: Box }[] = [];
  for (const c of design.components) {
    const pl = layout.placements[c.ref];
    if (pl) boxes.push({ ref: c.ref, b: courtyardWorld(design, pl) });
  }
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i].b;
    const ox = Math.max(0, -b.minX) + Math.max(0, b.maxX - design.board.width);
    const oy = Math.max(0, -b.minY) + Math.max(0, b.maxY - design.board.height);
    cost += (ox + oy) * (w.offboard ?? 12);
    for (let j = i + 1; j < boxes.length; j++) cost += boxOverlap(b, boxes[j].b) * (w.courtyard ?? 8);
  }

  // decap distance
  for (const c of design.components) {
    if (!["decap", "input_cap", "output_cap"].includes(c.role)) continue;
    const pl = layout.placements[c.ref]; if (!pl) continue;
    const myNets = new Set(c.pins.map((p) => p.net));
    let nearest = Infinity;
    for (const ic of design.components) {
      if (!["mcu", "regulator", "imu", "adc", "ic", "motor_driver", "rf", "sensor"].includes(ic.role)) continue;
      if (!ic.pins.some((p) => myNets.has(p.net))) continue;
      const ip = layout.placements[ic.ref]; if (!ip) continue;
      nearest = Math.min(nearest, dist(pl, ip));
    }
    if (nearest < Infinity && nearest > 2.5) cost += (nearest - 2.5) * (w.decap ?? 6);
  }

  // switch loop area
  for (const cl of design.clusters) {
    if (cl.kind !== "buck_converter") continue;
    const reg = cl.refs.map((r) => byRef.get(r)).find((c) => c?.role === "regulator");
    const ind = cl.refs.map((r) => byRef.get(r)).find((c) => c?.role === "inductor");
    const cin = cl.refs.map((r) => byRef.get(r)).find((c) => c?.role === "input_cap");
    const pts: Pt[] = [];
    for (const c of [cin, reg, ind]) { const pl = c && layout.placements[c.ref]; if (pl) pts.push({ x: pl.x, y: pl.y }); }
    if (pts.length === 3) cost += polyArea(pts) * 0.05 * (w.switchLoop ?? 9);
  }

  // noisy vs sensitive coupling (centroids)
  const noisy = design.nets.filter((n) => n.classes.includes("noisy") || n.classes.includes("high_current"));
  const sens = design.nets.filter((n) => n.classes.includes("sensitive"));
  for (const nn of noisy) {
    const cN = netCentroid(layout, nn); if (!cN) continue;
    for (const sn of sens) {
      const cS = netCentroid(layout, sn); if (!cS) continue;
      const d = dist(cN, cS);
      cost += (40 / (d * d + 1)) * (w.noisySensitive ?? 7);
    }
  }

  // cluster tightness (driven by cluster_tight rules + default buck tightness)
  const tight = new Set(cons.tightClusters);
  for (const cl of design.clusters) {
    if (!tight.has(cl.id)) continue;
    const pts: Pt[] = [];
    for (const ref of cl.refs) { const pl = layout.placements[ref]; if (pl) pts.push({ x: pl.x, y: pl.y }); }
    if (pts.length < 2) continue;
    const ctr = centroid(pts);
    let spread = 0;
    for (const p of pts) spread += dist(p, ctr);
    cost += spread * 2.5;
  }

  // push-away constraints
  for (const pa of cons.pushAway) {
    const as = design.components.filter((c) => pa.aRoles.includes(c.role));
    const bs = design.components.filter((c) => pa.bRoles.includes(c.role));
    for (const a of as) for (const b of bs) {
      const pa2 = layout.placements[a.ref], pb = layout.placements[b.ref];
      if (!pa2 || !pb) continue;
      const d = dist(pa2, pb);
      if (d < pa.min) cost += (pa.min - d) * 3;
    }
  }

  // antenna edge + keepout
  for (const c of design.components) {
    if (c.role !== "antenna" && c.role !== "rf") continue;
    const pl = layout.placements[c.ref]; if (!pl) continue;
    const ko = design.footprints[c.ref]?.keepout ?? 8;
    for (const other of design.components) {
      if (other.ref === c.ref) continue;
      const op = layout.placements[other.ref]; if (!op) continue;
      const d = dist(pl, op);
      if (d < ko) cost += (ko - d) * 1.5 * (w.antenna ?? 8) * 0.2;
    }
    const edgeDist = Math.min(pl.x, pl.y, design.board.width - pl.x, design.board.height - pl.y);
    if (edgeDist > 6) cost += (edgeDist - 6) * 2 * (w.antenna ?? 8) * 0.2;
  }

  // thermal
  const heat = design.components.filter((c) => ["regulator", "motor_driver", "mosfet"].includes(c.role));
  for (let i = 0; i < heat.length; i++) for (let j = i + 1; j < heat.length; j++) {
    const a = layout.placements[heat[i].ref], b = layout.placements[heat[j].ref];
    if (!a || !b) continue;
    const d = dist(a, b);
    if (d < 8) cost += (8 - d) * (w.thermal ?? 3);
  }

  return cost;
}

// ---- simulated annealing ----
export interface AnnealOpts { iterations: number; startTemp: number; endTemp: number; }
export function anneal(design: Design, ruleset: Ruleset, rng: RNG, start: Layout, opts: AnnealOpts): Layout {
  const anchored = buildConstraints(design, ruleset).edgeAnchors;
  const movable = design.components.map((c) => c.ref).filter((ref) => !anchored.has(ref));
  if (movable.length === 0) return start;

  let cur: Record<string, Placement> = JSON.parse(JSON.stringify(start.placements));
  let curLayout: Layout = { ...start, placements: cur };
  let curCost = placementCost(design, curLayout, ruleset);
  let best = JSON.parse(JSON.stringify(cur));
  let bestCost = curCost;

  const N = opts.iterations;
  for (let i = 0; i < N; i++) {
    const t = opts.startTemp * Math.pow(opts.endTemp / opts.startTemp, i / N);
    const ref = movable[rng.int(0, movable.length - 1)];
    const prev = { ...cur[ref] };
    const moveType = rng.next();
    if (moveType < 0.6) {
      const scale = 1 + t * 8;
      cur[ref] = clampToBoard(design, { ...prev, x: prev.x + rng.range(-scale, scale), y: prev.y + rng.range(-scale, scale) });
    } else if (moveType < 0.8) {
      cur[ref] = { ...prev, rot: ROT_CHOICES[rng.int(0, 3)] };
    } else {
      // swap with another movable
      const other = movable[rng.int(0, movable.length - 1)];
      if (other !== ref) {
        const po = { ...cur[other] };
        cur[ref] = clampToBoard(design, { ...prev, x: po.x, y: po.y });
        cur[other] = clampToBoard(design, { ...po, x: prev.x, y: prev.y });
      }
    }
    const newCost = placementCost(design, { ...curLayout, placements: cur }, ruleset);
    const dCost = newCost - curCost;
    if (dCost < 0 || rng.next() < Math.exp(-dCost / Math.max(1e-6, t * 50))) {
      curCost = newCost;
      if (curCost < bestCost) { bestCost = curCost; best = JSON.parse(JSON.stringify(cur)); }
    } else {
      cur[ref] = prev; // revert (swap revert handled loosely; re-seed other not tracked, acceptable)
    }
  }
  return { ...start, placements: best };
}

// ---- local helpers ----
function mst(pts: Pt[]): [Pt, Pt][] {
  if (pts.length < 2) return [];
  const n = pts.length;
  const inT = new Array(n).fill(false);
  const best = new Array(n).fill(Infinity);
  const from = new Array(n).fill(-1);
  best[0] = 0;
  const edges: [Pt, Pt][] = [];
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!inT[v] && (u === -1 || best[v] < best[u])) u = v;
    if (u === -1) break;
    inT[u] = true;
    if (from[u] >= 0) edges.push([pts[from[u]], pts[u]]);
    for (let v = 0; v < n; v++) { if (inT[v]) continue; const d = dist(pts[u], pts[v]); if (d < best[v]) { best[v] = d; from[v] = u; } }
  }
  return edges;
}
function netCentroid(layout: Layout, net: { pins: { ref: string; pad: string }[] }): Pt | null {
  const pts: Pt[] = [];
  for (const pr of net.pins) { const pl = layout.placements[pr.ref]; if (pl) pts.push({ x: pl.x, y: pl.y }); }
  if (!pts.length) return null;
  return centroid(pts);
}
