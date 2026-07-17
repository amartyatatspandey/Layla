// Progressive, physics-inspired EMI validation pass.
//
// This is an INDEPENDENT validation pass -- NOT the optimizer's objective. It is
// "physics-inspired progressive validation", NOT certified EMC. The intent is to
// give a cheap, deterministic, refinement-stable signal about how much energy a
// noisy/high-current net is likely to dump onto a sensitive victim net.
//
// MODEL: a 2.5D damped scalar wave (field) solver on a voxel grid. The board is
// discretized into cols x rows cells with 3 z-layers:
//   z=0  F.Cu signal layer (sources + probes live here)
//   z=1  dielectric (couples the two copper layers)
//   z=2  B.Cu / ground pour, run with very high damping so it acts as an energy
//        sink (the return / shield plane).
//
// Per cell the leapfrog damped-wave update is:
//   u_next = (2 - damping - omega2)*u - (1 - damping)*u_prev
//            + c2*laplacian3d(u) + drive
// with c2 chosen small enough for stability (c2 * neighborCount < 1).

import { Design, Layout, Net } from "./types";
import { EmiField, EmiLevel, EmiReport } from "./oscTypes";
import { Pt } from "./geometry";
import { netPads, courtyardWorld, mstEdges } from "./layoututil";

// ---------- solver constants ----------
const C2 = 0.18;            // wave speed^2 -> c2 * 6 neighbors = 1.08 (kept tame by damping)
const OMEGA2 = 0.001;       // tiny restoring term (mild low-pass / keeps bounded)
const DAMP_SIGNAL = 0.04;   // damping on copper signal layers (z=0)
const DAMP_DIELECTRIC = 0.12;
const DAMP_GROUND = 0.5;    // z=2 ground pour: strong sink
const DAMP_COURTYARD = 0.35; // extra damping inside component courtyards on z=0
const VIA_LEAK = 0.25;      // fraction of z=0 energy bled into the ground sink at vias
const U_CLAMP = 1e3;        // hard guard against runaway / NaN

// risk blend weights
const W_PROBE = 1.0;
const W_PEAK = 0.4;
const W_GRAD = 0.6;

const MAX_CELLS_PER_AXIS = 140; // skip a level whose grid would be larger than this

// ---------- small helpers ----------
function clampU(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v > U_CLAMP) return U_CLAMP;
  if (v < -U_CLAMP) return -U_CLAMP;
  return v;
}

function hasClass(net: Net, ...cls: string[]): boolean {
  return net.classes.some((c) => cls.includes(c));
}

// A source net's drive amplitude + oscillation frequency, scaled by its "intent".
interface SourceSpec {
  amp: number;
  freq: number;        // cycles per timestep
  phase: number;       // deterministic per-net phase offset
}

function sourceSpec(net: Net, idx: number): SourceSpec {
  const highCurrent = hasClass(net, "high_current");
  const noisy = hasClass(net, "noisy");
  // high_current nets push more energy; noisy nets oscillate faster (more HF EMI).
  const amp = (highCurrent ? 1.4 : 0.0) + (noisy ? 1.0 : 0.0);
  const freq = noisy ? 0.22 : 0.12;
  // deterministic phase so the run is reproducible (no Math.random).
  const phase = (idx * 0.61803398875) % 1;
  return { amp: Math.max(amp, 0.6), freq, phase };
}

// ---------- grid ----------
// We flatten (col, row, z) -> col + row*cols + z*cols*rows.
interface Grid {
  cell: number;
  cols: number;
  rows: number;
  layer: number;   // cols * rows
  size: number;    // cols * rows * 3
  ox: number;      // world-mm origin x of cell (0,0)  (for windowed/zoomed sims)
  oy: number;      // world-mm origin y of cell (0,0)
}

function makeGrid(W: number, H: number, cell: number, ox = 0, oy = 0): Grid {
  const cols = Math.max(1, Math.ceil(W / cell));
  const rows = Math.max(1, Math.ceil(H / cell));
  const layer = cols * rows;
  return { cell, cols, rows, layer, size: layer * 3, ox, oy };
}

function cellIndex(g: Grid, cx: number, cy: number, z: number): number {
  return cx + cy * g.cols + z * g.layer;
}

// World mm -> clamped (cx, cy) cell coordinate (relative to the grid origin).
function worldToCell(g: Grid, p: Pt): { cx: number; cy: number } {
  let cx = Math.floor((p.x - g.ox) / g.cell);
  let cy = Math.floor((p.y - g.oy) / g.cell);
  if (cx < 0) cx = 0; else if (cx >= g.cols) cx = g.cols - 1;
  if (cy < 0) cy = 0; else if (cy >= g.rows) cy = g.rows - 1;
  return { cx, cy };
}

// Rasterize a segment a->b onto z=0 cells (sample along the line at ~cell res).
function rasterizeSegment(g: Grid, a: Pt, b: Pt, out: Set<number>): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(len / g.cell));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const { cx, cy } = worldToCell(g, { x: a.x + dx * t, y: a.y + dy * t });
    out.add(cy * g.cols + cx);
  }
}

// Copper cells (on the z=0 plane index space, i.e. cx + cy*cols) for a net:
// prefer real routes, else fall back to MST over the net's pads.
function netCells(design: Design, layout: Layout, net: Net, g: Grid): Set<number> {
  const cells = new Set<number>();
  const routes = layout.routes.filter((r) => r.net === net.name);
  if (routes.length > 0) {
    for (const r of routes) rasterizeSegment(g, r.a, r.b, cells);
    return cells;
  }
  // fallback: pads + ratsnest MST
  const pads = netPads(design, layout, net);
  for (const p of pads) {
    const { cx, cy } = worldToCell(g, p);
    cells.add(cy * g.cols + cx);
  }
  for (const [a, b] of mstEdges(pads)) rasterizeSegment(g, a, b, cells);
  return cells;
}

// 3D laplacian with Neumann (reflective) boundaries: missing neighbors mirror the
// center cell so no spurious energy enters/leaves at the edges.
function laplacian3d(u: Float32Array, g: Grid, cx: number, cy: number, z: number): number {
  const c = u[cellIndex(g, cx, cy, z)];
  const xm = cx > 0 ? u[cellIndex(g, cx - 1, cy, z)] : c;
  const xp = cx < g.cols - 1 ? u[cellIndex(g, cx + 1, cy, z)] : c;
  const ym = cy > 0 ? u[cellIndex(g, cx, cy - 1, z)] : c;
  const yp = cy < g.rows - 1 ? u[cellIndex(g, cx, cy + 1, z)] : c;
  const zm = z > 0 ? u[cellIndex(g, cx, cy, z - 1)] : c;
  const zp = z < 2 ? u[cellIndex(g, cx, cy, z + 1)] : c;
  return xm + xp + ym + yp + zm + zp - 6 * c;
}

// ---------- per-level simulation ----------
interface LevelRun {
  level: EmiLevel;
  field: EmiField;
  probeEnergyByNet: Map<string, number>;
}

function simulateLevel(
  design: Design,
  layout: Layout,
  g: Grid,
  steps: number,
  sources: { net: Net; spec: SourceSpec; cells: Set<number> }[],
  probes: { net: Net; cells: Set<number> }[],
): LevelRun {
  const u = new Float32Array(g.size);
  const uPrev = new Float32Array(g.size);
  const uNext = new Float32Array(g.size);

  // per-cell damping field (defaults per layer; courtyards add absorption on z=0).
  const damp = new Float32Array(g.size);
  for (let cy = 0; cy < g.rows; cy++) {
    for (let cx = 0; cx < g.cols; cx++) {
      damp[cellIndex(g, cx, cy, 0)] = DAMP_SIGNAL;
      damp[cellIndex(g, cx, cy, 1)] = DAMP_DIELECTRIC;
      damp[cellIndex(g, cx, cy, 2)] = DAMP_GROUND;
    }
  }
  // Component courtyards act as lossy obstacles on the signal layer.
  for (const ref of Object.keys(layout.placements)) {
    const pl = layout.placements[ref];
    const box = courtyardWorld(design, pl);
    const lo = worldToCell(g, { x: box.minX, y: box.minY });
    const hi = worldToCell(g, { x: box.maxX, y: box.maxY });
    for (let cy = lo.cy; cy <= hi.cy; cy++) {
      for (let cx = lo.cx; cx <= hi.cx; cx++) {
        damp[cellIndex(g, cx, cy, 0)] = DAMP_COURTYARD;
      }
    }
  }

  // Via cells: where we bleed energy from z=0 into the z=2 ground sink each step.
  const viaCells: number[] = [];
  for (const via of layout.vias) {
    const { cx, cy } = worldToCell(g, via.at);
    viaCells.push(cy * g.cols + cx);
  }

  // Probe cell flat indices (on z=0).
  const probeFlat: number[] = [];
  for (const p of probes) for (const c of p.cells) probeFlat.push(c);
  const probeCellCount = Math.max(1, probeFlat.length);

  // accumulators
  const maxAbs = new Float32Array(g.layer); // max|u| over time on z=0 (for field)
  let peak = 0;
  let probeEnergy = 0;
  const probeEnergyByNet = new Map<string, number>();
  for (const p of probes) probeEnergyByNet.set(p.net.name, 0);

  const twoPi = Math.PI * 2;

  for (let t = 0; t < steps; t++) {
    // 1) wave update over the whole volume.
    for (let z = 0; z < 3; z++) {
      for (let cy = 0; cy < g.rows; cy++) {
        for (let cx = 0; cx < g.cols; cx++) {
          const i = cellIndex(g, cx, cy, z);
          const d = damp[i];
          const lap = laplacian3d(u, g, cx, cy, z);
          let next =
            (2 - d - OMEGA2) * u[i] -
            (1 - d) * uPrev[i] +
            C2 * lap;
          uNext[i] = clampU(next);
        }
      }
    }

    // 2) inject oscillating drive at source cells on z=0.
    for (const src of sources) {
      const drive = src.spec.amp * Math.sin(twoPi * (src.spec.freq * t + src.spec.phase));
      for (const flat of src.cells) {
        const i = flat; // z=0 flat index
        uNext[i] = clampU(uNext[i] + drive);
      }
    }

    // 3) vias: leak some signal-layer energy into the ground sink (vertical coupling).
    for (const flat of viaCells) {
      const top = flat;                       // z=0
      const gnd = flat + g.layer * 2;         // z=2
      const transfer = uNext[top] * VIA_LEAK;
      uNext[top] = clampU(uNext[top] - transfer);
      uNext[gnd] = clampU(uNext[gnd] + transfer);
    }

    // 4) rotate buffers.
    uPrev.set(u);
    u.set(uNext);

    // 5) accumulate diagnostics on z=0.
    for (let c = 0; c < g.layer; c++) {
      const a = Math.abs(u[c]);
      if (a > maxAbs[c]) maxAbs[c] = a;
      if (a > peak) peak = a;
    }
    // probe energy (sum u^2 at probe cells), tracked globally and per net.
    for (const p of probes) {
      let e = 0;
      for (const flat of p.cells) {
        const v = u[flat];
        e += v * v;
      }
      probeEnergyByNet.set(p.net.name, (probeEnergyByNet.get(p.net.name) ?? 0) + e);
      probeEnergy += e;
    }
  }

  // gradient energy near probes: how steep the field is around victim cells (a
  // proxy for induced dV across the trace). Sampled on the final field.
  let gradEnergy = 0;
  for (const flat of probeFlat) {
    const cx = flat % g.cols;
    const cy = Math.floor(flat / g.cols);
    const c = maxAbs[flat];
    const xm = cx > 0 ? maxAbs[flat - 1] : c;
    const xp = cx < g.cols - 1 ? maxAbs[flat + 1] : c;
    const ym = cy > 0 ? maxAbs[flat - g.cols] : c;
    const yp = cy < g.rows - 1 ? maxAbs[flat + g.cols] : c;
    const gx = (xp - xm) * 0.5;
    const gy = (yp - ym) * 0.5;
    gradEnergy += gx * gx + gy * gy;
  }

  // normalize so the metrics sit ~O(1) regardless of grid/step counts.
  const normProbe = probeEnergy / (probeCellCount * steps);
  const normGrad = gradEnergy / probeCellCount;

  const risk =
    normProbe * W_PROBE + peak * W_PEAK + normGrad * W_GRAD;

  // build the field payload (normalized 0..1 row-major max|u| over time on z=0).
  let fieldMax = 0;
  for (let c = 0; c < g.layer; c++) if (maxAbs[c] > fieldMax) fieldMax = maxAbs[c];
  const inv = fieldMax > 0 ? 1 / fieldMax : 0;
  const data = new Array<number>(g.layer);
  for (let c = 0; c < g.layer; c++) data[c] = maxAbs[c] * inv;

  const level: EmiLevel = {
    cellMm: g.cell,
    risk: Number.isFinite(risk) ? risk : 0,
    peak: Number.isFinite(peak) ? peak : 0,
    probeEnergy: Number.isFinite(normProbe) ? normProbe : 0,
  };
  const field: EmiField = { cellMm: g.cell, w: g.cols, h: g.rows, data };

  return { level, field, probeEnergyByNet };
}

// ---------- public entry point ----------
export function validateEmiProgressive(
  design: Design,
  layout: Layout,
  opts?: { levels?: number[]; steps?: number; window?: { x: number; y: number; w: number; h: number } },
): EmiReport {
  // optional region-of-interest window (mm) for zoomed/fine simulation (down to µm)
  const win = opts?.window;
  const W = win ? win.w : design.board.width;
  const H = win ? win.h : design.board.height;
  const OX = win ? win.x : 0;
  const OY = win ? win.y : 0;

  const levels = opts?.levels ?? [4, 2, 1];

  // identify source (aggressor) and probe (victim) nets once.
  const sourceNets = design.nets.filter((n) => hasClass(n, "noisy", "high_current"));
  const probeNets = design.nets.filter((n) => hasClass(n, "sensitive"));

  const emiLevels: EmiLevel[] = [];
  let finestField: EmiField = { cellMm: levels[levels.length - 1] ?? 1, w: 1, h: 1, data: [0] };
  let finestProbeEnergy = new Map<string, number>();

  for (let li = 0; li < levels.length; li++) {
    const cell = levels[li];
    if (!(cell > 0)) continue;
    const g = makeGrid(W, H, cell, OX, OY);
    // cap runtime: skip overly fine grids.
    if (g.cols > MAX_CELLS_PER_AXIS || g.rows > MAX_CELLS_PER_AXIS) continue;

    // steps scale with resolution: coarse -> fewer steps, fine -> more.
    // default ~60 at 4mm up to ~120 at 1mm.
    let steps = opts?.steps ?? Math.round(60 + (120 - 60) * (4 - Math.min(4, cell)) / 3);
    if (steps < 1) steps = 1;

    // build per-net copper masks at this resolution.
    const sources = sourceNets.map((net, i) => ({
      net,
      spec: sourceSpec(net, i),
      cells: netCells(design, layout, net, g),
    }));
    const probes = probeNets.map((net) => ({
      net,
      cells: netCells(design, layout, net, g),
    }));

    const run = simulateLevel(design, layout, g, steps, sources, probes);
    emiLevels.push(run.level);

    // keep the finest (last successfully simulated) level's outputs.
    finestField = run.field;
    finestProbeEnergy = run.probeEnergyByNet;
  }

  // ---- convergence across refinement ----
  let convergenceDeltaPct = 0;
  let converged = false;
  if (emiLevels.length >= 2) {
    const finest = emiLevels[emiLevels.length - 1].risk;
    const second = emiLevels[emiLevels.length - 2].risk;
    const maxRisk = Math.max(...emiLevels.map((l) => l.risk), 1e-9);
    convergenceDeltaPct = (Math.abs(finest - second) / maxRisk) * 100;
    converged = convergenceDeltaPct < 12;
  } else if (emiLevels.length === 1) {
    // a single level can't demonstrate refinement stability.
    convergenceDeltaPct = 0;
    converged = false;
  }

  const verdict = converged
    ? "field risk stable across refinement"
    : emiLevels.length >= 2
      ? "field risk still changing under refinement"
      : "insufficient refinement levels to assess stability";

  // ---- worst-hit probe + ranking (from the finest level) ----
  const riskByProbe = Array.from(finestProbeEnergy.entries())
    .map(([net, energy]) => ({ net, energy: Math.round(energy) }))
    .sort((a, b) => b.energy - a.energy);
  const sensitiveProbeMax = riskByProbe.length > 0 ? riskByProbe[0].net : "";

  return {
    model: "progressive_damped_wave_2p5d",
    levels: emiLevels,
    converged,
    convergenceDeltaPct,
    sensitiveProbeMax,
    verdict,
    field: finestField,
    riskByProbe,
  };
}
