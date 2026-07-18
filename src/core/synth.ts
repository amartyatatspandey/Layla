// Orchestrator: schematic -> design -> (place, route, score), and the
// recursively self-improving loop that ratchets the score down across iterations.
//
// Placement goes through OptimizerBackend → CandidateLayout. Every promotion
// candidate (substrate mutation or symbolic rule) is judged by the same
// ordered gate list — never by branching on how the candidate was proposed.

import { parseSchematic } from "./schematic";
import { buildDesign } from "./classify";
import { RNG } from "./rng";
import {
  cloneRuleset, defaultRuleset, promoteRule, synthesizeFromFeedback,
  synthesizeFromHotspots, hasSimilarRule, FEEDBACK_SCOPE_NOTICE,
} from "./rules";
import { defaultSubstrate, mutateSubstrate } from "./osc";
import { validateEmiProgressive } from "./emi";
import { OscViz, OscSubstrate, EmiReport } from "./oscTypes";
import {
  BoardSpec, Design, ImproveResult, IterationRecord, Layout, Ruleset, Score,
} from "./types";
import {
  createBackend,
  materializeCandidate,
  evaluatePromotionGates,
  OptimizerBackend,
  OptimizerKind,
  PlaceRequest,
} from "./optimizerBackend";
import {
  applyPromotionPatch,
  trialRulesetFromPatch,
  PromotionPatch,
  RulePatch,
  SubstratePatch,
} from "./rulesetPatches";

export type Optimizer = OptimizerKind;

export const DEFAULT_BOARD: Omit<BoardSpec, "name"> = {
  width: 50, height: 40, layers: 2, mountingHoles: [],
  defaultTraceW: 0.25, clearance: 0.2, powerTraceW: 0.8, highCurrentTraceW: 1.5,
  viaDrill: 0.3, viaDia: 0.6, diffPairs: [],
};

export function designFromSchematic(schText: string, board?: Partial<BoardSpec>): Design {
  const raw = parseSchematic(schText);
  const spec: BoardSpec = {
    name: board?.name || "board",
    ...DEFAULT_BOARD,
    ...board,
  };
  if (!board?.width || !board?.height) {
    const n = raw.components.length;
    const area = Math.max(900, n * 45);
    const w = Math.round(Math.sqrt(area * 1.4) / 5) * 5;
    const h = Math.round((area / w) / 5) * 5;
    spec.width = board?.width || Math.max(35, w);
    spec.height = board?.height || Math.max(28, h);
  }
  if (!spec.mountingHoles.length) {
    const m = 3.5;
    spec.mountingHoles = [
      { x: m, y: m, drill: 3.2, keepout: 4 },
      { x: spec.width - m, y: m, drill: 3.2, keepout: 4 },
      { x: m, y: spec.height - m, drill: 3.2, keepout: 4 },
      { x: spec.width - m, y: spec.height - m, drill: 3.2, keepout: 4 },
    ];
  }
  return buildDesign(raw, spec);
}

export interface SynthOpts {
  optimizer?: Optimizer;
  annealIters?: number;
  startFrom?: Layout;
  batch?: number;
  seed?: number;
  polish?: number;
  /** Optional pre-built backend; otherwise created from optimizer kind. */
  backend?: OptimizerBackend;
}
export interface SynthResult { layout: Layout; score: Score; viz?: OscViz; }

function placeRequest(
  design: Design,
  ruleset: Ruleset,
  rng: RNG,
  opts: SynthOpts,
): PlaceRequest {
  return {
    design,
    ruleset,
    rng,
    seed: opts.seed ?? 1,
    batch: opts.batch,
    polish: opts.polish,
    annealIters: opts.annealIters,
    startFrom: opts.startFrom,
  };
}

/** One synthesis pass through OptimizerBackend → CandidateLayout → score. */
export function synthOnce(design: Design, ruleset: Ruleset, rng: RNG, opts: SynthOpts = {}): SynthResult {
  const kind: Optimizer = opts.optimizer ?? (ruleset.substrate ? "oscillator" : "anneal");
  const backend = opts.backend ?? createBackend(kind);
  const { candidate, score, viz } = materializeCandidate(backend, placeRequest(design, ruleset, rng, opts));
  return { layout: candidate.layout, score, viz };
}

export interface ImproveOpts {
  iterations?: number;
  seed?: number;
  ruleset?: Ruleset;
  feedback?: string;
  optimizer?: Optimizer;
  batch?: number;
  polish?: number;
  emiValidate?: boolean;
  onIteration?: (rec: IterationRecord, best: BestState) => void;
  /** Test seam: override EMI validator used by the gate list. */
  emiValidator?: (design: Design, layout: Layout) => EmiReport;
}
export interface BestState { layout: Layout; score: Score; viz?: OscViz; emi?: EmiReport; }

/**
 * Recursively self-improving loop.
 *
 * Candidate *generation* may still be backend-specific (substrate mutation vs
 * symbolic rule synthesis). Candidate *evaluation* is not: every CandidateLayout
 * passes through the same gate list (score always; EMI when --emi is on).
 */
export function improve(design: Design, opts: ImproveOpts = {}): ImproveResult {
  const iterations = opts.iterations ?? 8;
  const baseSeed = opts.seed ?? 1337;
  const optimizer: Optimizer = opts.optimizer ?? "oscillator";
  const batch = opts.batch ?? (optimizer === "oscillator" ? 16 : 1);
  const emiOn = opts.emiValidate ?? false;
  const emiValidator = opts.emiValidator ?? validateEmiProgressive;
  const backend = createBackend(optimizer);

  let ruleset = opts.ruleset ? cloneRuleset(opts.ruleset) : defaultRuleset();
  if (optimizer === "oscillator" && !ruleset.substrate) ruleset.substrate = defaultSubstrate();
  if (optimizer === "anneal") ruleset.substrate = undefined;

  let feedbackScopeNotice: string | undefined;
  if (opts.feedback) {
    if (optimizer === "oscillator") {
      feedbackScopeNotice = FEEDBACK_SCOPE_NOTICE;
    } else {
      for (const r of synthesizeFromFeedback(opts.feedback, design, 0)) {
        if (!hasSimilarRule(ruleset, r)) ruleset = promoteRule(ruleset, r);
      }
    }
  }

  const synthOptsFor = (seed: number, extraEffort: number): SynthOpts => ({
    optimizer,
    backend,
    batch,
    seed,
    polish: opts.polish ?? (optimizer === "oscillator" ? 120 : 0),
    annealIters: 600 + extraEffort,
  });

  const history: IterationRecord[] = [];
  let best: BestState | null = null;

  for (let iter = 0; iter < iterations; iter++) {
    const promoted: string[] = [];

    // (a) Explore: materialize one candidate; accept as best on score alone
    // (establishes the reference layout). Promotion attempts below use gates.
    const trial = synthOnce(design, ruleset, new RNG(baseSeed + iter * 101), synthOptsFor(baseSeed + iter * 977, iter * 350));
    if (!best || trial.score.total < best.score.total) {
      best = { ...trial };
      if (emiOn) best.emi = emiValidator(design, best.layout);
    }

    // (b)/(c) Generate promotion patches against a shared snapshot (parallel
    // generation is fine). Acceptance applies each scoped patch to the
    // *current* best Ruleset — never whole-object replacement from a stale
    // candidate snapshot.
    type PromoCand = {
      patch: PromotionPatch;
      /** Trial ruleset for evaluation only (snapshot ⊕ patch). */
      trialRuleset: Ruleset;
      rngOff: number;
      seedOff: number;
    };
    const snapshot = cloneRuleset(ruleset);
    const promoCands: PromoCand[] = [];

    if (optimizer === "oscillator" && snapshot.substrate) {
      const mutated = mutateSubstrate(snapshot.substrate as OscSubstrate, new RNG(baseSeed + iter * 101 + 17));
      const patch: SubstratePatch = {
        owns: "substrate",
        substrate: mutated,
        label: `substrate v${mutated.version}`,
      };
      promoCands.push({
        patch,
        trialRuleset: trialRulesetFromPatch(snapshot, patch),
        rngOff: 41,
        seedOff: baseSeed + iter * 631 + 5,
      });
    }

    for (const rule of synthesizeFromHotspots(best.score.hotspots, design, iter)) {
      if (hasSimilarRule(snapshot, rule)) continue;
      const patch: RulePatch = { owns: "rules", rule, label: rule.name };
      promoCands.push({
        patch,
        trialRuleset: trialRulesetFromPatch(snapshot, patch),
        rngOff: 53,
        seedOff: baseSeed + iter * 733 + 9,
      });
    }

    for (const pc of promoCands) {
      const test = synthOnce(
        design,
        pc.trialRuleset,
        new RNG(baseSeed + iter * 101 + pc.rngOff),
        synthOptsFor(pc.seedOff, iter * 350),
      );
      const gate = evaluatePromotionGates({
        design,
        layout: test.layout,
        score: test.score,
        bestScore: best.score.total,
        bestEmi: best.emi,
        emiOn,
        emiValidator,
      });
      if (!gate.ok) continue;
      // Scoped accept: only the patch's owned field changes on current best.
      ruleset = applyPromotionPatch(ruleset, pc.patch);
      best = {
        layout: test.layout,
        score: test.score,
        viz: test.viz,
        emi: emiOn ? (gate.emi ?? emiValidator(design, test.layout)) : best.emi,
      };
      promoted.push(pc.patch.label);
    }

    const rec: IterationRecord = {
      iter,
      rawScore: round2(trial.score.total),
      bestScore: round2(best.score.total),
      terms: best.score.terms,
      drcErrors: best.score.drcErrors,
      switchLoopArea: round2(best.score.switchLoopArea),
      coupling: round2(best.score.field.coupling),
      routeCompletion: round2(best.score.routeCompletion),
      rulesActive: ruleset.rules.filter((r) => r.status === "promoted").length,
      promoted,
      note: promoted.length ? `promoted: ${promoted.join(", ")}` : "explored phase seeds",
    };
    history.push(rec);
    opts.onIteration?.(rec, best);
  }

  return { design, best: best!, history, ruleset, feedbackScopeNotice };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
