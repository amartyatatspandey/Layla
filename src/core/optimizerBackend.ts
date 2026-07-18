// Explicit optimizer backend interface + uniform promotion-gate list.
//
// Placement backends (anneal / oscillator) only produce CandidateLayout.
// Every candidate — regardless of how it was proposed — is judged by the
// same ordered gate list (canonical score always; EMI when --emi is on).

import { anneal, seedPlacement } from "./place";
import { oscillatorPlace } from "./osc";
import { routeCritical } from "./route";
import { scoreLayout, DEFAULT_WEIGHTS } from "./score";
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
        routeCritical(req.design, refined, new RNG(req.seed + i + 31));
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
 * seed selection — routeCritical is idempotent enough to re-run (clears and
 * re-routes critical nets).
 */
export function materializeCandidate(
  backend: OptimizerBackend,
  req: PlaceRequest,
): MaterializedCandidate {
  const candidate = backend.place(req);
  // Anneal has not routed yet. Oscillator already routed each seed during
  // place() with seed-tied RNGs — do not re-route here (would change copper).
  if (backend.kind === "anneal") {
    routeCritical(req.design, candidate.layout, req.rng);
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
  bestEmi?: EmiReport;
  emiOn: boolean;
  emiValidator: (design: Design, layout: Layout) => EmiReport;
}

export interface PromotionGate {
  name: string;
  /** Whether this gate is active for the current run. */
  active: (ctx: GateContext) => boolean;
  /** Returns ok + optional EMI report produced while checking. */
  check: (ctx: GateContext) => { ok: boolean; emi?: EmiReport };
}

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
 * Active when --emi is on. Applies to EVERY candidate (rule or substrate).
 * EMI risk is a property of layout geometry, not of proposal mechanism.
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

/** Ordered gate list — append future gates (e.g. in-loop DRC) here only. */
export const DEFAULT_PROMOTION_GATES: PromotionGate[] = [
  SCORE_IMPROVEMENT_GATE,
  EMI_NON_REGRESSION_GATE,
];

export interface GateResult {
  ok: boolean;
  failedGate?: string;
  emi?: EmiReport;
}

/**
 * Run every active gate in order. First failure rejects; EMI report from a
 * passing EMI gate is returned for the caller to attach to best state.
 */
export function evaluatePromotionGates(
  ctx: GateContext,
  gates: PromotionGate[] = DEFAULT_PROMOTION_GATES,
): GateResult {
  let emi: EmiReport | undefined;
  for (const gate of gates) {
    if (!gate.active(ctx)) continue;
    const r = gate.check(ctx);
    if (r.emi) emi = r.emi;
    if (!r.ok) return { ok: false, failedGate: gate.name, emi };
  }
  return { ok: true, emi };
}
