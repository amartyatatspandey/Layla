// Copper clearance DRC — verifies minimum spacing between different-net
// copper (pads, routed trace segments, vias).
//
// Two tiers (intentional distinction — do not conflate):
//
//   Broad (`checkClearanceBroad`) — pad-AABB / coarse primitive bounding-box
//   overlap candidates. Uses the same gatherPrimitives + spatial buckets as
//   exact, but counts pairs whose *axis-aligned bounding boxes* are closer
//   than clearance. Cheap signal for scoreLayout()'s `drcErrors` (alongside
//   courtyard/offboard). Over-counts vs exact for capsules/circles because
//   AABB is a conservative enclosure — that is by design for in-loop scoring.
//
//   Exact (`checkClearance`) — full narrow-phase geometry (pad AABB, via
//   circles, trace capsules via gapBetween). Used as the named promotion
//   gate `drc_clearance_non_regression` and for final report.json `drc`.
//
// LAYLA_AUDIT.md finding B: scoreLayout()'s `drcErrors` was only
// courtyardOverlaps + offboard (component-BODY-level proxies) — nothing
// checked actual copper-to-copper spacing. Separately, route.ts's A*
// obstacle model used to only *penalize* crossing a cell another net had
// already routed through, not block it, so two different nets could
// legally share a cell (a short) if that was cheaper than detouring. This
// module is the general-purpose spacing check: it runs over the *emitted*
// layout (pads from every placed component, plus whatever routeCritical()
// actually routed) and flags any different-net copper closer together than
// the board's declared minimum clearance — catching both a routing-model
// short (now hard-blocked in route.ts, but this check doesn't assume that
// fix stays correct forever) and a placement-driven pad-to-pad violation
// that routing has no say over at all.
//
// Required clearance is `design.board.clearance` (mm) — a field that
// existed in BoardSpec/DEFAULT_BOARD before this module but was never read
// anywhere in the pipeline (default 0.2mm, see synth.ts DEFAULT_BOARD).
//
// Scope: this prompt is about preventing shorts specifically. Annular-ring
// and trace-width-vs-current-capacity checks are explicitly out of scope
// here (follow-up prompt) — this module only checks minimum spacing.
//
// Approximation notes (first-pass, not full-fidelity DRC):
//   - Pads are modeled as their world-space AXIS-ALIGNED BOUNDING BOX
//     (accounting for 0/90/180/270 footprint rotation and back-side
//     mirroring, same convention as courtyardWorld/padWorld in
//     layoututil.ts). Rectangles, not a circumscribing circle: fine-pitch
//     footprints (e.g. the QFN/LQFP generators in footprints.ts) legitimately
//     pack adjacent same-component pads to within ~(pitch - pad size) of
//     each other, and a circle around a long, thin pad would flag that
//     correct, intentional spacing as a false violation.
//   - Trace segments are modeled as capsules: centerline segment + half the
//     trace width.
//   - Vias are modeled as circles of radius board.viaDia / 2.
//   - Two copper features are only compared if they belong to DIFFERENT
//     nets. Two pads that are both individually unconnected (net name "")
//     are still treated as different from each other for this purpose —
//     sharing an empty net name doesn't make them electrically the same
//     net, they're still two physically distinct copper features that need
//     their own spacing.
//   - A coarse spatial bucket index keeps this roughly linear instead of
//     full O(n^2); bucket size is generous relative to the clearance
//     distance being checked, so no true violation can span more than one
//     bucket boundary and be missed.

import {
  Box, Pt, dist, emptyBox, extend, place as placeLocal, pointSegDist, segIntersect,
  boxGap, pointBoxDist, pointInBox,
} from "./geometry";
import { Design, Layout } from "./types";

export interface DrcViolation {
  netA: string;
  netB: string;
  refA?: string;
  pinA?: string;
  refB?: string;
  pinB?: string;
  kindA: "pad" | "segment" | "via";
  kindB: "pad" | "segment" | "via";
  at: Pt;
  requiredMm: number;
  measuredMm: number; // actual edge-to-edge gap; negative means overlapping copper
}

// Stable, documented shape for report.json's `drc` field (same pattern as
// `lvs` — see src/core/lvs.ts). Additive alongside the existing
// courtyard/offboard contribution in `score.drcErrors`; broad-phase copper
// counts also feed that field (see checkClearanceBroad / InLoopDrcSummary).
//   clean             — true iff violations is empty
//   requiredClearanceMm — the board.clearance value violations were checked against
//   violations        — every different-net copper pair closer than required
export interface DrcClearanceReport {
  clean: boolean;
  requiredClearanceMm: number;
  violations: DrcViolation[];
}

/**
 * Broad-phase in-loop summary: deterministic candidate-safe counts only.
 * `violationCount` is the number of different-net primitive pairs whose
 * coarse AABBs are within clearance (not narrow-phase geometry).
 */
export interface DrcBroadReport {
  requiredClearanceMm: number;
  violationCount: number;
}

/** Candidate-safe summary used when folding broad DRC into score.drcErrors. */
export interface InLoopDrcSummary {
  broadViolationCount: number;
  requiredClearanceMm: number;
}

type Prim =
  | { kind: "pad"; net: string; ref: string; pin: string; box: Box }
  | { kind: "via"; net: string; center: Pt; radius: number }
  | { kind: "segment"; net: string; a: Pt; b: Pt; halfWidth: number };

function primAt(p: Prim): Pt {
  if (p.kind === "pad") return { x: (p.box.minX + p.box.maxX) / 2, y: (p.box.minY + p.box.maxY) / 2 };
  if (p.kind === "via") return p.center;
  return { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
}

/** Axis-aligned enclosure of a copper primitive (shared by broad + exact). */
function primAabb(p: Prim): Box {
  if (p.kind === "pad") return p.box;
  if (p.kind === "via") {
    return {
      minX: p.center.x - p.radius, minY: p.center.y - p.radius,
      maxX: p.center.x + p.radius, maxY: p.center.y + p.radius,
    };
  }
  return {
    minX: Math.min(p.a.x, p.b.x) - p.halfWidth,
    minY: Math.min(p.a.y, p.b.y) - p.halfWidth,
    maxX: Math.max(p.a.x, p.b.x) + p.halfWidth,
    maxY: Math.max(p.a.y, p.b.y) + p.halfWidth,
  };
}

// World-space AABB of a single pad, honoring footprint rotation (0/90/180/270
// only, same as the rest of the pipeline) and back-side mirroring — mirrors
// the per-corner transform courtyardWorld() uses for the whole footprint,
// applied to one pad's local rect instead.
function padWorldBox(design: Design, ref: string, padNum: string, pl: { x: number; y: number; rot: number; side: "front" | "back" }): Box | null {
  const fp = design.footprints[ref];
  const pad = fp?.pads.find((p) => p.num === padNum);
  if (!pad) return null;
  const b = emptyBox();
  const corners: Pt[] = [
    { x: pad.x - pad.w / 2, y: pad.y - pad.h / 2 },
    { x: pad.x + pad.w / 2, y: pad.y - pad.h / 2 },
    { x: pad.x + pad.w / 2, y: pad.y + pad.h / 2 },
    { x: pad.x - pad.w / 2, y: pad.y + pad.h / 2 },
  ];
  for (const c of corners) {
    const m = pl.side === "back" ? { x: -c.x, y: c.y } : c;
    extend(b, placeLocal(m, { x: pl.x, y: pl.y }, pl.rot));
  }
  return b;
}

function gatherPrimitives(design: Design, layout: Layout): Prim[] {
  const out: Prim[] = [];

  // Pads: every placed component's every synthesized pad, netted via the
  // schematic's own pin->net map (comp.pins), regardless of whether the net
  // was routed — pad-to-pad spacing is a placement concern, not a routing
  // one.
  for (const c of design.components) {
    const pl = layout.placements[c.ref];
    if (!pl) continue;
    const fp = design.footprints[c.ref];
    if (!fp) continue;
    const netByPin = new Map(c.pins.map((p) => [p.num, p.net]));
    for (const pad of fp.pads) {
      if (pad.num === "") continue; // unnumbered (e.g. mounting hole) pads carry no net
      const box = padWorldBox(design, c.ref, pad.num, pl);
      if (!box) continue;
      out.push({ kind: "pad", net: netByPin.get(pad.num) ?? "", ref: c.ref, pin: pad.num, box });
    }
  }

  // Routed trace segments.
  for (const seg of layout.routes) {
    out.push({ kind: "segment", net: seg.net, a: seg.a, b: seg.b, halfWidth: seg.width / 2 });
  }

  // Vias.
  const viaRadius = design.board.viaDia / 2;
  for (const via of layout.vias) {
    out.push({ kind: "via", net: via.net, center: via.at, radius: viaRadius });
  }

  return out;
}

interface SpatialIndex {
  buckets: Map<string, number[]>;
  primBuckets: [number, number][][];
}

function bucketKey(bx: number, by: number): string {
  return `${bx},${by}`;
}

/**
 * Shared spatial bucket construction for broad and exact clearance checks.
 * Keeping one builder prevents broad/exact drift on which pairs are considered.
 */
function buildSpatialBuckets(prims: Prim[], required: number): SpatialIndex {
  // Bucket size generous relative to `required` plus the largest plausible
  // primitive extent, so any pair close enough to violate clearance is
  // guaranteed to share a bucket (or be in an immediately adjacent one).
  const BUCKET = Math.max(4, required * 4);
  const buckets = new Map<string, number[]>();
  const bucketsOf = (p: Prim): [number, number][] => {
    const box = primAabb(p);
    const bx0 = Math.floor(box.minX / BUCKET), bx1 = Math.floor(box.maxX / BUCKET);
    const by0 = Math.floor(box.minY / BUCKET), by1 = Math.floor(box.maxY / BUCKET);
    const out: [number, number][] = [];
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) out.push([bx, by]);
    return out;
  };
  const primBuckets: [number, number][][] = prims.map((p) => bucketsOf(p));
  prims.forEach((_, i) => {
    for (const [bx, by] of primBuckets[i]) {
      const key = bucketKey(bx, by);
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(i);
    }
  });
  return { buckets, primBuckets };
}

/** Neighbor indices j > i that share a bucket neighborhood with primitive i. */
function neighborIndices(
  i: number,
  primBuckets: [number, number][][],
  buckets: Map<string, number[]>,
): Set<number> {
  const neighborIdx = new Set<number>();
  for (const [bx, by] of primBuckets[i]) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const arr = buckets.get(bucketKey(bx + dx, by + dy));
      if (arr) for (const j of arr) if (j > i) neighborIdx.add(j);
    }
  }
  return neighborIdx;
}

// Distance from a line segment to an axis-aligned box (0 if they touch/cross/overlap).
function segBoxDist(a: Pt, b: Pt, box: Box): number {
  if (pointInBox(a, box) || pointInBox(b, box)) return 0;
  const corners: Pt[] = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY },
  ];
  for (let i = 0; i < 4; i++) {
    if (segIntersect(a, b, corners[i], corners[(i + 1) % 4])) return 0;
  }
  let d = Math.min(pointBoxDist(a, box), pointBoxDist(b, box));
  for (const c of corners) d = Math.min(d, pointSegDist(c, a, b));
  return d;
}

// Capsule-to-capsule distance between two segments (0 if they cross).
function segSegDist(a1: Pt, b1: Pt, a2: Pt, b2: Pt): number {
  if (segIntersect(a1, b1, a2, b2)) return 0;
  return Math.min(
    pointSegDist(a1, a2, b2), pointSegDist(b1, a2, b2),
    pointSegDist(a2, a1, b1), pointSegDist(b2, a1, b1),
  );
}

// Edge-to-edge gap between two copper primitives (negative = overlapping).
function gapBetween(x: Prim, y: Prim): number {
  if (x.kind === "pad" && y.kind === "pad") return boxGap(x.box, y.box);
  if (x.kind === "via" && y.kind === "via") return dist(x.center, y.center) - x.radius - y.radius;
  if (x.kind === "segment" && y.kind === "segment") return segSegDist(x.a, x.b, y.a, y.b) - x.halfWidth - y.halfWidth;
  if (x.kind === "pad" && y.kind === "via") return pointBoxDist(y.center, x.box) - y.radius;
  if (x.kind === "via" && y.kind === "pad") return pointBoxDist(x.center, y.box) - x.radius;
  if (x.kind === "pad" && y.kind === "segment") return segBoxDist(y.a, y.b, x.box) - y.halfWidth;
  if (x.kind === "segment" && y.kind === "pad") return segBoxDist(x.a, x.b, y.box) - x.halfWidth;
  if (x.kind === "via" && y.kind === "segment") return pointSegDist(x.center, y.a, y.b) - x.radius - y.halfWidth;
  if (x.kind === "segment" && y.kind === "via") return pointSegDist(y.center, x.a, x.b) - y.radius - x.halfWidth;
  throw new Error(`unreachable: unhandled primitive pair (${x.kind}, ${y.kind})`);
}

// Some footprint generators in footprints.ts (e.g. fine-pitch QFN pads) are
// dimensioned so that adjacent same-component, different-net pads sit at
// *exactly* pitch-minus-pad-size apart, which for the default 0.2mm
// board.clearance works out to exactly the required clearance — an
// intentional "meets the minimum, not below it" design, not a violation.
// Chained rotation/translation floating-point arithmetic (place()/rotate(),
// used to compute every world-space pad box) lands a hair on either side of
// that exact value by ~1e-13mm, nowhere near a real geometric difference.
// Without tolerance, roughly half of those boundary-exact pairs would flip
// to "violation" purely from FP noise, burying genuine findings under
// hundreds of false positives (observed: ~450 of ~970 reported violations
// on the mainboard example before this tolerance was added). 1e-6mm (1nm)
// is ~7 orders of magnitude above the observed FP noise and ~3 orders below
// the coarsest realistic fab tolerance (~1 micron) — nowhere close to
// masking an actual clearance problem.
const GEOMETRY_EPSILON_MM = 1e-6;

function assertExactReport(report: DrcClearanceReport): DrcClearanceReport {
  if (
    !report ||
    typeof report.clean !== "boolean" ||
    typeof report.requiredClearanceMm !== "number" ||
    !Number.isFinite(report.requiredClearanceMm) ||
    !Array.isArray(report.violations)
  ) {
    throw new Error("exact clearance DRC failed to produce a usable report");
  }
  return report;
}

/**
 * Broad-phase clearance count for in-loop scoring.
 *
 * Same gatherPrimitives + spatial buckets as checkClearance, but counts
 * different-net pairs whose coarse AABBs are within clearance — NOT full
 * gapBetween / capsule-circle narrow-phase. See module header for the
 * intentional broad-vs-exact distinction.
 */
export function checkClearanceBroad(design: Design, layout: Layout): DrcBroadReport {
  const required = design.board.clearance;
  if (!Number.isFinite(required)) {
    throw new Error("board.clearance is not a finite number; cannot run broad DRC");
  }
  const prims = gatherPrimitives(design, layout);
  const { buckets, primBuckets } = buildSpatialBuckets(prims, required);

  let violationCount = 0;
  const seenPairs = new Set<string>();
  for (let i = 0; i < prims.length; i++) {
    for (const j of neighborIndices(i, primBuckets, buckets)) {
      const x = prims[i], y = prims[j];
      if (x.net === y.net && x.net !== "") continue;
      const pairKey = `${i},${j}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      // Coarse: AABB gap only (pad box / via box / segment AABB enclosure).
      const gap = boxGap(primAabb(x), primAabb(y));
      if (gap < required - GEOMETRY_EPSILON_MM) violationCount++;
    }
  }

  return { requiredClearanceMm: required, violationCount };
}

/** Fold broad report into the candidate-safe in-loop summary shape. */
export function inLoopDrcSummary(design: Design, layout: Layout): InLoopDrcSummary {
  const broad = checkClearanceBroad(design, layout);
  return {
    broadViolationCount: broad.violationCount,
    requiredClearanceMm: broad.requiredClearanceMm,
  };
}

export function checkClearance(design: Design, layout: Layout): DrcClearanceReport {
  const required = design.board.clearance;
  if (!Number.isFinite(required)) {
    throw new Error("board.clearance is not a finite number; cannot run exact DRC");
  }
  const prims = gatherPrimitives(design, layout);
  const { buckets, primBuckets } = buildSpatialBuckets(prims, required);

  const violations: DrcViolation[] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < prims.length; i++) {
    for (const j of neighborIndices(i, primBuckets, buckets)) {
      const x = prims[i], y = prims[j];
      if (x.net === y.net && x.net !== "") continue; // same real net: not a short
      const pairKey = `${i},${j}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const gap = gapBetween(x, y);
      if (gap < required - GEOMETRY_EPSILON_MM) {
        violations.push({
          netA: x.net, netB: y.net,
          refA: x.kind === "pad" ? x.ref : undefined, pinA: x.kind === "pad" ? x.pin : undefined,
          refB: y.kind === "pad" ? y.ref : undefined, pinB: y.kind === "pad" ? y.pin : undefined,
          kindA: x.kind, kindB: y.kind,
          at: primAt(x),
          requiredMm: required, measuredMm: Math.round(gap * 1000) / 1000,
        });
      }
    }
  }

  return assertExactReport({
    clean: violations.length === 0,
    requiredClearanceMm: required,
    violations,
  });
}
