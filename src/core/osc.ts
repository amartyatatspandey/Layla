// Coupled-oscillator (Kuramoto) placement optimizer — the RSI substrate.
//
// PCB topology is compiled into a network of phase oscillators: components are
// nodes; shared nets become positive (attractive / synchronizing) couplings —
// synchronized phase => nearby board position — while noisy<->sensitive pairs
// become negative (anti-phase / repelling) couplings. A conditioning block
// (board intent + hotspots + feedback, via the substrate's `condition` gains)
// modulates those couplings, the Un-0 "class drive" idea applied to layout.
//
// The dynamics are integrated (optionally inertial / second-order) for N steps
// over a BATCH of random initial phase seeds; each synchronized phase field is
// decoded to coordinates, lightly legalized (de-overlap), and returned as a
// candidate Layout. The caller routes + scores the batch and keeps the best.
//
// The SUBSTRATE (coupling scales, drives, dt, steps, readout) is the object the
// outer ratchet loop mutates and promotes — i.e. the optimizer improves itself.

import { Pt, dist, boxOverlap } from "./geometry";
import { courtyardWorld, clampToBoard } from "./layoututil";
import { RNG } from "./rng";
import { Component, Design, Layout, Placement, Role, Ruleset } from "./types";
import { OscEdge, OscGraph, OscSubstrate, OscViz, OscVizEdge } from "./oscTypes";

export function defaultSubstrate(): OscSubstrate {
  return {
    version: 1,
    attractScale: 1.0,
    clusterAttract: 0.9,
    repelScale: 0.45,
    repelRadius: 12,
    noisySensitiveRepel: 0.8,
    driveScale: 1.0,
    inertia: 0.6,
    damping: 0.85,
    dt: 0.08,
    steps: 90,
    readout: { ax: 1.7, bx: 0.7, ay: 1.7, by: 0.7 },
    condition: { antennaEdge: 1.0, buckTight: 1.0, noisyAway: 1.0, decapNear: 1.0, usbBalance: 1.0 },
  };
}

export function mutateSubstrate(s: OscSubstrate, rng: RNG): OscSubstrate {
  const n: OscSubstrate = JSON.parse(JSON.stringify(s));
  n.version = s.version + 1;
  const jitter = (v: number, amt: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v * (1 + rng.range(-amt, amt))));
  // perturb a random subset of the substrate (the optimizer's own parameters)
  const knobs: (() => void)[] = [
    () => { n.attractScale = jitter(n.attractScale, 0.3, 0.2, 3); },
    () => { n.clusterAttract = jitter(n.clusterAttract, 0.4, 0, 3); },
    () => { n.repelScale = jitter(n.repelScale, 0.4, 0.05, 2); },
    () => { n.repelRadius = jitter(n.repelRadius, 0.3, 4, 30); },
    () => { n.noisySensitiveRepel = jitter(n.noisySensitiveRepel, 0.4, 0, 3); },
    () => { n.inertia = jitter(n.inertia, 0.3, 0, 0.95); },
    () => { n.damping = jitter(n.damping, 0.15, 0.4, 0.98); },
    () => { n.dt = jitter(n.dt, 0.25, 0.02, 0.18); },
    () => { n.steps = Math.round(jitter(n.steps, 0.3, 40, 220)); },
    () => { n.readout.ax = jitter(n.readout.ax, 0.2, 0.6, 3); n.readout.ay = jitter(n.readout.ay, 0.2, 0.6, 3); },
    () => { n.readout.bx = jitter(n.readout.bx, 0.3, 0, 2); n.readout.by = jitter(n.readout.by, 0.3, 0, 2); },
    () => { n.condition.buckTight = jitter(n.condition.buckTight, 0.4, 0, 3); },
    () => { n.condition.noisyAway = jitter(n.condition.noisyAway, 0.4, 0, 3); },
    () => { n.condition.decapNear = jitter(n.condition.decapNear, 0.4, 0, 3); },
    () => { n.condition.antennaEdge = jitter(n.condition.antennaEdge, 0.4, 0, 3); },
    () => { n.condition.usbBalance = jitter(n.condition.usbBalance, 0.4, 0, 3); },
  ];
  const k = rng.int(1, 3);
  for (let i = 0; i < k; i++) rng.pick(knobs)();
  return n;
}

// ---- which components are edge-anchored (snapped to a board edge) ----
function edgeFor(role: Role): "left" | "right" | "top" | "bottom" | null {
  if (role === "usb" || role === "connector") return "left";
  if (role === "antenna" || role === "rf") return "right";
  return null;
}

// ---- compile the oscillator graph from the design + substrate ----
export function compileOscillatorGraph(design: Design, ruleset: Ruleset, sub: OscSubstrate): OscGraph {
  const comps = design.components;
  const idx = new Map<string, number>();
  comps.forEach((c, i) => idx.set(c.ref, i));
  const cond = sub.condition;

  const nodes = comps.map((c) => ({
    ref: c.ref, role: c.role, fixed: edgeFor(c.role) !== null,
  }));

  // accumulate signed couplings into a map keyed by i<j
  const acc = new Map<string, { k: number; kind: OscEdge["kind"] }>();
  const addEdge = (a: number, b: number, k: number, kind: OscEdge["kind"]) => {
    if (a === b) return;
    const i = Math.min(a, b), j = Math.max(a, b);
    const key = `${i},${j}`;
    const cur = acc.get(key);
    if (!cur) acc.set(key, { k, kind });
    else { cur.k += k; if (Math.abs(k) > Math.abs(cur.k - k)) cur.kind = kind; }
  };

  // 1. net adjacency -> attraction (chain the net's components to stay linear)
  for (const net of design.nets) {
    if (net.classes.includes("ground")) continue; // pour, not a placement constraint
    const refs = [...new Set(net.pins.map((p) => p.ref))].filter((r) => idx.has(r));
    if (refs.length < 2) continue;
    const w = sub.attractScale / Math.sqrt(refs.length);
    for (let i = 0; i + 1 < refs.length; i++) addEdge(idx.get(refs[i])!, idx.get(refs[i + 1])!, w, "net");
  }

  // 2. cluster cohesion (buck/usb/sensor/motor) -> extra attraction
  for (const cl of design.clusters) {
    const refs = cl.refs.filter((r) => idx.has(r));
    let gain = sub.clusterAttract;
    if (cl.kind === "buck_converter") gain *= cond.buckTight;
    if (cl.kind === "usb_section") gain *= cond.usbBalance;
    for (let i = 0; i + 1 < refs.length; i++) addEdge(idx.get(refs[i])!, idx.get(refs[i + 1])!, gain, "cluster");
  }

  // 3. noisy <-> sensitive -> anti-phase repulsion (the EE separation intent)
  const netsOf = (c: Component) => new Set(c.pins.map((p) => p.net));
  const noisyComps = comps.filter((c) => [...netsOf(c)].some((n) => isClass(design, n, "noisy") || isClass(design, n, "high_current")));
  const sensComps = comps.filter((c) => [...netsOf(c)].some((n) => isClass(design, n, "sensitive")));
  for (const a of noisyComps) for (const b of sensComps) {
    if (a.ref === b.ref) continue;
    addEdge(idx.get(a.ref)!, idx.get(b.ref)!, -sub.noisySensitiveRepel * cond.noisyAway, "noisy_sensitive");
  }

  // 4. decap -> owning IC attraction
  for (const c of comps) {
    if (!["decap", "input_cap", "output_cap"].includes(c.role)) continue;
    const myNets = netsOf(c);
    let best = -1, bestShare = 0;
    for (const ic of comps) {
      if (!["mcu", "regulator", "imu", "adc", "ic", "motor_driver", "rf", "sensor"].includes(ic.role)) continue;
      const share = ic.pins.filter((p) => myNets.has(p.net)).length;
      if (share > bestShare) { bestShare = share; best = idx.get(ic.ref)!; }
    }
    if (best >= 0) addEdge(idx.get(c.ref)!, best, sub.clusterAttract * 0.8 * cond.decapNear, "cluster");
  }

  const edges: OscEdge[] = [];
  for (const [key, v] of acc) {
    const [i, j] = key.split(",").map(Number);
    edges.push({ i, j, k: v.k, kind: v.kind });
  }

  // conditioning drive: edge-anchored components are driven toward their edge.
  const N = comps.length;
  const driveX = new Float64Array(N), driveY = new Float64Array(N), driveStrength = new Float64Array(N);
  const W = design.board.width, H = design.board.height;
  for (let i = 0; i < N; i++) {
    const e = edgeFor(comps[i].role);
    if (!e) continue;
    const isAnt = comps[i].role === "antenna" || comps[i].role === "rf";
    const strength = sub.driveScale * (isAnt ? cond.antennaEdge : 1) * 1.0;
    driveStrength[i] = strength;
    if (e === "left") { driveX[i] = 0.08; driveY[i] = 0.5; }
    else if (e === "right") { driveX[i] = 0.92; driveY[i] = 0.5; }
    else if (e === "top") { driveX[i] = 0.5; driveY[i] = 0.08; }
    else { driveX[i] = 0.5; driveY[i] = 0.92; }
  }

  return { nodes, edges, driveX, driveY, driveStrength };
}

function isClass(design: Design, netName: string, cls: string): boolean {
  const n = design.nets.find((x) => x.name === netName);
  return !!n && (n.classes as string[]).includes(cls);
}

// ---- phase -> [0,1] coordinate readout ----
function decode01(theta: number, a: number, b: number): number {
  const u = a * Math.sin(theta) + b * Math.cos(theta);
  return 1 / (1 + Math.exp(-u)); // sigmoid
}
// target phase whose decode is closest to a desired [0,1] coordinate
function targetPhase(coord01: number, a: number, b: number): number {
  let bestT = 0, bestErr = Infinity;
  for (let s = 0; s < 24; s++) {
    const t = -Math.PI + (s / 24) * 2 * Math.PI;
    const err = Math.abs(decode01(t, a, b) - coord01);
    if (err < bestErr) { bestErr = err; bestT = t; }
  }
  return bestT;
}

// ---- integrate one batch member and decode to a Layout ----
interface OscRun { layout: Layout; phasesX: Float64Array; phasesY: Float64Array; order: number[]; orderX: number[]; }

function runOne(design: Design, graph: OscGraph, sub: OscSubstrate, rng: RNG, captureOrder: boolean): OscRun {
  const N = graph.nodes.length;
  const px = new Float64Array(N), py = new Float64Array(N), pr = new Float64Array(N);
  const vx = new Float64Array(N), vy = new Float64Array(N);
  // precompute drive target phases for anchored nodes
  const tx = new Float64Array(N), ty = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    px[i] = rng.range(-Math.PI, Math.PI);
    py[i] = rng.range(-Math.PI, Math.PI);
    pr[i] = rng.range(-Math.PI, Math.PI);
    if (graph.driveStrength[i] > 0) {
      tx[i] = targetPhase(graph.driveX[i], sub.readout.ax, sub.readout.bx);
      ty[i] = targetPhase(graph.driveY[i], sub.readout.ay, sub.readout.by);
    }
  }
  const E = graph.edges;
  const fx = new Float64Array(N), fy = new Float64Array(N);
  const order: number[] = [], orderX: number[] = [];
  const dt = sub.dt, inertia = sub.inertia, damp = sub.damping;

  for (let step = 0; step < sub.steps; step++) {
    fx.fill(0); fy.fill(0);
    for (let e = 0; e < E.length; e++) {
      const { i, j, k } = E[e];
      const sxe = Math.sin(px[j] - px[i]);
      const sye = Math.sin(py[j] - py[i]);
      fx[i] += k * sxe; fx[j] -= k * sxe;
      fy[i] += k * sye; fy[j] -= k * sye;
    }
    for (let i = 0; i < N; i++) {
      // conditioning drive pulls anchored nodes toward their edge phase
      const ds = graph.driveStrength[i];
      if (ds > 0) {
        fx[i] += ds * 2.5 * Math.sin(tx[i] - px[i]);
        fy[i] += ds * 2.5 * Math.sin(ty[i] - py[i]);
      }
      if (inertia > 0) {
        vx[i] = (1 - damp * dt) * vx[i] + dt * fx[i];
        vy[i] = (1 - damp * dt) * vy[i] + dt * fy[i];
        px[i] = wrap(px[i] + dt * (inertia * vx[i] + (1 - inertia) * fx[i]));
        py[i] = wrap(py[i] + dt * (inertia * vy[i] + (1 - inertia) * fy[i]));
      } else {
        px[i] = wrap(px[i] + dt * fx[i]);
        py[i] = wrap(py[i] + dt * fy[i]);
      }
    }
    if (captureOrder) { order.push(kuramotoR(px, py)); orderX.push(kuramotoR1(px)); }
  }

  // decode -> raw placements
  const W = design.board.width, H = design.board.height;
  const placements: Record<string, Placement> = {};
  for (let i = 0; i < N; i++) {
    const c = design.components[i];
    let x = W * decode01(px[i], sub.readout.ax, sub.readout.bx);
    let y = H * decode01(py[i], sub.readout.ay, sub.readout.by);
    const rot = [0, 90, 180, 270][Math.floor(((pr[i] + Math.PI) / (2 * Math.PI)) * 4) % 4];
    placements[c.ref] = clampToBoard(design, { ref: c.ref, x, y, rot, side: "front" });
  }
  // snap edge-anchored components to their nearest board edge (keep along-edge order)
  for (let i = 0; i < N; i++) {
    if (graph.driveStrength[i] <= 0) continue;
    const c = design.components[i];
    const e = edgeFor(c.role)!;
    const p = placements[c.ref];
    if (e === "left") placements[c.ref] = clampToBoard(design, { ...p, x: 5, rot: 0 });
    else if (e === "right") placements[c.ref] = clampToBoard(design, { ...p, x: W - 5, rot: 180 });
    else if (e === "top") placements[c.ref] = clampToBoard(design, { ...p, y: 5, rot: 270 });
    else placements[c.ref] = clampToBoard(design, { ...p, y: H - 5, rot: 90 });
  }
  const layout: Layout = { placements, routes: [], vias: [], keepouts: [] };
  legalize(design, layout, sub);
  return { layout, phasesX: px, phasesY: py, order, orderX };
}

// ---- light de-overlap legalization in coordinate space ----
function legalize(design: Design, layout: Layout, sub: OscSubstrate): void {
  const refs = design.components.map((c) => c.ref).filter((r) => layout.placements[r]);
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        const a = layout.placements[refs[i]], b = layout.placements[refs[j]];
        const ba = courtyardWorld(design, a), bb = courtyardWorld(design, b);
        const ov = boxOverlap(ba, bb);
        if (ov <= 0) continue;
        moved = true;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1e-3;
        dx /= d; dy /= d;
        const push = 0.6 + Math.sqrt(ov) * 0.25;
        layout.placements[refs[i]] = clampToBoard(design, { ...a, x: a.x - dx * push, y: a.y - dy * push });
        layout.placements[refs[j]] = clampToBoard(design, { ...b, x: b.x + dx * push, y: b.y + dy * push });
      }
    }
    if (!moved) break;
  }
}

function wrap(t: number): number {
  let x = t;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}
// global 2D sync order parameter (mean phasor magnitude over both axes)
function kuramotoR(px: Float64Array, py: Float64Array): number {
  return (kuramotoR1(px) + kuramotoR1(py)) / 2;
}
function kuramotoR1(p: Float64Array): number {
  let cr = 0, ci = 0;
  for (let i = 0; i < p.length; i++) { cr += Math.cos(p[i]); ci += Math.sin(p[i]); }
  return Math.hypot(cr, ci) / Math.max(1, p.length);
}

// ---- public API: produce a batch of candidate layouts + their viz ----
export interface OscPlaceResult { layouts: Layout[]; vizes: OscViz[]; }
export function oscillatorPlace(design: Design, ruleset: Ruleset, sub: OscSubstrate, opts: { batch: number; seed: number }): OscPlaceResult {
  const graph = compileOscillatorGraph(design, ruleset, sub);
  const layouts: Layout[] = [];
  const vizes: OscViz[] = [];
  const vizEdges: OscVizEdge[] = graph.edges.map((e) => ({ i: e.i, j: e.j, k: e.k, kind: e.kind }));
  for (let b = 0; b < opts.batch; b++) {
    const rng = new RNG(opts.seed + b * 7919 + 1);
    const run = runOne(design, graph, sub, rng, true);
    layouts.push(run.layout);
    vizes.push({
      nodes: design.components.map((c, i) => ({
        ref: c.ref, role: c.role,
        thetaX: run.phasesX[i], thetaY: run.phasesY[i],
        x: run.layout.placements[c.ref]?.x ?? 0, y: run.layout.placements[c.ref]?.y ?? 0,
      })),
      edges: vizEdges,
      order: run.order, orderX: run.orderX, steps: sub.steps,
      substrateVersion: sub.version, batch: opts.batch,
    });
  }
  return { layouts, vizes };
}
