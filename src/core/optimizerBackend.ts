// Explicit optimizer backend interface + uniform promotion-gate list.
//
// Placement backends (anneal / oscillator) only produce CandidateLayout.
// Every candidate — regardless of how it was proposed — is judged by the
// same ordered gate list (canonical score always; exact DRC non-regression
// always; EMI when --emi is on). Gates stay backend/provenance agnostic.

import { anneal, seedPlacement } from "./place";
import { oscillatorPlace } from "./osc";
import { routeLayout } from "./route";
import { scoreLayout, DEFAULT_WEIGHTS } from "./score";
import { checkClearance, DrcClearanceReport } from "./drc";
import { RNG } from "./rng";
import { OscViz, EmiReport } from "./oscTypes";
import { Design, Layout, Ruleset, Score } from "./types";

/** Single layout artifact the evaluation layer consumes. No provenance fields. */
export interface CandidateLayout {
  layout: Layout;
}

export type OptimizerKind = "anneal" | "oscillator";

export interface PlaceRequest {
  design: Design;
  ruleset: Ruleset;
  rng: RNG;
  seed: number;
  batch?: number;
  polish?: number;
  annealIters?: number;
  startFrom?: Layout;
  /** Loaded ruleset lacked topologyMode — retain flat on hierarchy-eligible boards. */
  legacyTopologyAbsent?: boolean;
}

/**
 * Backend contract: Design + Ruleset (+ internal state on the ruleset, e.g.
 * OscSubstrate) → one CandidateLayout. Internals may race seeds / anneal;
 * the evaluator never sees how the layout was proposed.
 */
export interface OptimizerBackend {
  readonly kind: OptimizerKind;
  place(req: PlaceRequest): CandidateLayout;
  /** Optional display extras from the last place(); ignored by gates. */
  takeDisplayExtras?(): { viz?: OscViz };
}

// ---- anneal backend (wraps place.ts; no algorithm change) ----

export function createAnnealBackend(): OptimizerBackend {
  return {
    kind: "anneal",
    place(req: PlaceRequest): CandidateLayout {
      const seed = req.startFrom
        ? {
            placements: JSON.parse(JSON.stringify(req.startFrom.placements)),
            routes: [],
            vias: [],
            keepouts: [],
          } as Layout
        : seedPlacement(req.design, req.ruleset, req.rng);
      const layout = anneal(req.design, req.ruleset, req.rng, seed, {
        iterations: req.annealIters ?? 1500,
        startTemp: 1.0,
        endTemp: 0.02,
      });
      return { layout };
    },
  };
}

// ---- oscillator backend (wraps osc.ts; batch race stays internal) ----

export function createOscillatorBackend(): OptimizerBackend {
  let lastViz: OscViz | undefined;
  return {
    kind: "oscillator",
    place(req: PlaceRequest): CandidateLayout {
      const sub = req.ruleset.substrate;
      if (!sub) throw new Error("oscillator backend requires ruleset.substrate");
      const batch = req.batch ?? 24;
      const { layouts, vizes } = oscillatorPlace(req.design, req.ruleset, sub, {
        batch,
        seed: req.seed,
        legacyTopologyAbsent: req.legacyTopologyAbsent,
      });
      // Race seeds: polish + route + canonical score to pick one layout.
      // This selection is internal to producing a single CandidateLayout;
      // the promotion gate still re-evaluates that candidate uniformly.
      let bestLayout: Layout | null = null;
      let bestScore = Infinity;
      let bestIdx = 0;
      layouts.forEach((layout, i) => {
        const refined =
          req.polish && req.polish > 0
            ? anneal(req.design, req.ruleset, new RNG(req.seed + i + 11), layout, {
                iterations: req.polish,
                startTemp: 0.25,
                endTemp: 0.01,
              })
            : layout;
        routeLayout(req.design, refined, new RNG(req.seed + i + 31));
        const score = scoreLayout(req.design, refined, DEFAULT_WEIGHTS);
        if (score.total < bestScore) {
          bestScore = score.total;
          bestLayout = refined;
          bestIdx = i;
        }
      });
      lastViz = vizes[bestIdx];
      return { layout: bestLayout! };
    },
    takeDisplayExtras() {
      const viz = lastViz;
      lastViz = undefined;
      return { viz };
    },
  };
}

export function createBackend(kind: OptimizerKind): OptimizerBackend {
  return kind === "oscillator" ? createOscillatorBackend() : createAnnealBackend();
}

// ---- materialize: place → (route if needed) → score ----

export interface MaterializedCandidate {
  candidate: CandidateLayout;
  score: Score;
  viz?: OscViz;
}

/**
 * Shared place→route→score path used by every explore/promotion attempt.
 * Anneal layouts still need routing; oscillator backend already routes during
 * seed selection — routeLayout clears and rebuilds copper ownership, so a
 * second call would replace copper (anneal only routes here).
 */
export function materializeCandidate(
  backend: OptimizerBackend,
  req: PlaceRequest,
): MaterializedCandidate {
  const candidate = backend.place(req);
  // Anneal has not routed yet. Oscillator already routed each seed during
  // place() with seed-tied RNGs — do not re-route here (would change copper).
  if (backend.kind === "anneal") {
    routeLayout(req.design, candidate.layout, req.rng);
  }
  const score = scoreLayout(req.design, candidate.layout, DEFAULT_WEIGHTS);
  const extras = backend.takeDisplayExtras?.();
  return { candidate, score, viz: extras?.viz };
}

// ---- uniform promotion gate list ----

export interface GateContext {
  design: Design;
  layout: Layout;
  score: Score;
  bestScore: number;
  /** Exact clearance report for the current best (from checkClearance). */
  bestDrc?: DrcClearanceReport;
  /** Optional cached exact report for this candidate (avoids a second run). */
  candidateDrc?: DrcClearanceReport;
  bestEmi?: EmiReport;
  emiOn: boolean;
  emiValidator: (design: Design, layout: Layout) => EmiReport;
}

export interface GateCheckResult {
  ok: boolean;
  emi?: EmiReport;
  drc?: DrcClearanceReport;
}

export interface PromotionGate {
  name: string;
  /** Whether this gate is active for the current run. */
  active: (ctx: GateContext) => boolean;
  /** Returns ok + optional reports produced while checking. */
  check: (ctx: GateContext) => GateCheckResult;
}

/**
 * Finest-level blended scalar for layout-vs-layout comparison.
 * Not dB, V/m, or a compliance threshold — see EMI_SCOPE_CLAIM.
 * Gate eligibility does not depend on `converged` (refinement confidence only).
 */
export function emiRisk(e?: EmiReport): number {
  return e && e.levels.length ? e.levels[e.levels.length - 1].risk : 0;
}

/** Always active: candidate must beat current best canonical score. */
export const SCORE_IMPROVEMENT_GATE: PromotionGate = {
  name: "canonical_score",
  active: () => true,
  check: (ctx) => ({ ok: ctx.score.total < ctx.bestScore - 1e-6 }),
};

/**
 * Always active: exact copper-clearance non-regression.
 * Rejects ONLY when candidate exact violations.length exceeds the current
 * best's exact count. Equal or better exact DRC may promote (if score also
 * better). Uses checkClearance (narrow-phase), not the broad score signal.
 */
export const DRC_CLEARANCE_NON_REGRESSION_GATE: PromotionGate = {
  name: "drc_clearance_non_regression",
  active: () => true,
  check: (ctx) => {
    let drc: DrcClearanceReport;
    try {
      drc = ctx.candidateDrc ?? checkClearance(ctx.design, ctx.layout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`exact clearance DRC failed during promotion gate: ${msg}`);
    }
    if (
      typeof drc.clean !== "boolean" ||
      !Array.isArray(drc.violations) ||
      !Number.isFinite(drc.requiredClearanceMm)
    ) {
      throw new Error("exact clearance DRC failed to produce a usable report");
    }
    // First best is established outside the gate list (explore path sets
    // bestDrc). For promotion: missing bestDrc → treat prior count as 0
    // (strict); equal or fewer violations may promote.
    const bestCount = ctx.bestDrc?.violations.length ?? 0;
    const ok = drc.violations.length <= bestCount;
    return { ok, drc };
  },
};

/**
 * Active when --emi is on. Applies to EVERY candidate (rule or substrate).
 * EMI risk is a property of layout geometry, not of proposal mechanism.
 * Compares finest-level blended scalars (emiRisk), not absolute field units;
 * does not skip or soften when the report's `converged` flag is false.
 */
export const EMI_NON_REGRESSION_GATE: PromotionGate = {
  name: "emi_non_regression",
  active: (ctx) => ctx.emiOn,
  check: (ctx) => {
    const emi = ctx.emiValidator(ctx.design, ctx.layout);
    const ok = emiRisk(emi) <= emiRisk(ctx.bestEmi) * 1.08 + 1e-6;
    return { ok, emi };
  },
};

/** Ordered gate list — score → exact DRC → conditional EMI. */
export const DEFAULT_PROMOTION_GATES: PromotionGate[] = [
  SCORE_IMPROVEMENT_GATE,
  DRC_CLEARANCE_NON_REGRESSION_GATE,
  EMI_NON_REGRESSION_GATE,
];

export interface GateResult {
  ok: boolean;
  failedGate?: string;
  emi?: EmiReport;
  drc?: DrcClearanceReport;
}

/**
 * Run every active gate in order. First failure rejects; exact DRC / EMI
 * reports from passing gates are returned for the caller to attach to best.
 */
export function evaluatePromotionGates(
  ctx: GateContext,
  gates: PromotionGate[] = DEFAULT_PROMOTION_GATES,
): GateResult {
  let emi: EmiReport | undefined;
  let drc: DrcClearanceReport | undefined;
  for (const gate of gates) {
    if (!gate.active(ctx)) continue;
    const r = gate.check(ctx);
    if (r.emi) emi = r.emi;
    if (r.drc) drc = r.drc;
    if (!r.ok) return { ok: false, failedGate: gate.name, emi, drc };
  }
  return { ok: true, emi, drc };
}
