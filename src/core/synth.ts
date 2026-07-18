// Orchestrator: schematic -> design -> (place, route, score), and the
// recursively self-improving loop that ratchets the score down across iterations.

import { parseSchematic } from "./schematic";
import { buildDesign } from "./classify";
import { seedPlacement, anneal } from "./place";
import { routeCritical } from "./route";
import { scoreLayout, DEFAULT_WEIGHTS } from "./score";
import { RNG } from "./rng";
import {
  cloneRuleset, defaultRuleset, promoteRule, synthesizeFromFeedback,
  synthesizeFromHotspots, hasSimilarRule, FEEDBACK_SCOPE_NOTICE,
} from "./rules";
import { oscillatorPlace, defaultSubstrate, mutateSubstrate } from "./osc";
import { validateEmiProgressive } from "./emi";
import { OscViz, OscSubstrate, EmiReport } from "./oscTypes";
import {
  BoardSpec, Design, ImproveResult, IterationRecord, Layout, Rule, Ruleset, Score,
} from "./types";

export type Optimizer = "oscillator" | "anneal";

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
  // auto-size board if not provided
  if (!board?.width || !board?.height) {
    const n = raw.components.length;
    const area = Math.max(900, n * 45);
    const w = Math.round(Math.sqrt(area * 1.4) / 5) * 5;
    const h = Math.round((area / w) / 5) * 5;
    spec.width = board?.width || Math.max(35, w);
    spec.height = board?.height || Math.max(28, h);
  }
  // default mounting holes in the corners
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

// One synthesis pass -> route -> score against the canonical yardstick.
export interface SynthOpts {
  optimizer?: Optimizer;
  annealIters?: number;
  startFrom?: Layout;
  batch?: number;       // oscillator: how many initial-phase seeds to race
  seed?: number;
  polish?: number;      // oscillator: short local refine steps to legalize (0 = none)
}
export interface SynthResult { layout: Layout; score: Score; viz?: OscViz; }

export function synthOnce(design: Design, ruleset: Ruleset, rng: RNG, opts: SynthOpts = {}): SynthResult {
  const optimizer: Optimizer = opts.optimizer ?? (ruleset.substrate ? "oscillator" : "anneal");

  if (optimizer === "oscillator") {
    const sub: OscSubstrate = ruleset.substrate ?? defaultSubstrate();
    const batch = opts.batch ?? 24;
    const { layouts, vizes } = oscillatorPlace(design, ruleset, sub, { batch, seed: opts.seed ?? 1 });
    // route + score every candidate; keep the synchronized layout with lowest risk
    let best: SynthResult | null = null;
    let bestIdx = 0;
    layouts.forEach((layout, i) => {
      // optional short local legalization refine (oscillators propose macro-layout)
      const refined = opts.polish && opts.polish > 0
        ? anneal(design, ruleset, new RNG((opts.seed ?? 1) + i + 11), layout, { iterations: opts.polish, startTemp: 0.25, endTemp: 0.01 })
        : layout;
      routeCritical(design, refined, new RNG((opts.seed ?? 1) + i + 31));
      const score = scoreLayout(design, refined, DEFAULT_WEIGHTS);
      if (!best || score.total < best.score.total) { best = { layout: refined, score }; bestIdx = i; }
    });
    const r = best!;
    r.viz = vizes[bestIdx];
    return r;
  }

  // baseline annealing optimizer
  const seed = opts.startFrom
    ? { placements: JSON.parse(JSON.stringify(opts.startFrom.placements)), routes: [], vias: [], keepouts: [] } as Layout
    : seedPlacement(design, ruleset, rng);
  const placed = anneal(design, ruleset, rng, seed, {
    iterations: opts.annealIters ?? 1500, startTemp: 1.0, endTemp: 0.02,
  });
  routeCritical(design, placed, rng);
  const score = scoreLayout(design, placed, DEFAULT_WEIGHTS);
  return { layout: placed, score };
}

export interface ImproveOpts {
  iterations?: number;
  seed?: number;
  ruleset?: Ruleset;
  feedback?: string;
  optimizer?: Optimizer;        // default "oscillator"
  batch?: number;               // oscillator batch size
  polish?: number;              // oscillator legalization refine steps
  emiValidate?: boolean;        // run the EMI validation pass + gate substrate on it
  onIteration?: (rec: IterationRecord, best: BestState) => void;
}
export interface BestState { layout: Layout; score: Score; viz?: OscViz; emi?: EmiReport; }

// The recursively self-improving loop.
//
// Deterministic optimizer (anneal): symbolic rules from --feedback / hotspots
// are search-space constraints; promotion is score-gated.
// Learned optimizer (oscillator): the RSI loop mutates the OscSubstrate and
// promotes mutations when score (and optional EMI) improve. Symbolic rules are
// not the learning channel here — see FEEDBACK_SCOPE_NOTICE.
export function improve(design: Design, opts: ImproveOpts = {}): ImproveResult {
  const iterations = opts.iterations ?? 8;
  const baseSeed = opts.seed ?? 1337;
  const optimizer: Optimizer = opts.optimizer ?? "oscillator";
  const batch = opts.batch ?? (optimizer === "oscillator" ? 16 : 1);
  const emiOn = opts.emiValidate ?? false;
  let ruleset = opts.ruleset ? cloneRuleset(ruleset0(opts)) : defaultRuleset();
  if (optimizer === "oscillator" && !ruleset.substrate) ruleset.substrate = defaultSubstrate();
  if (optimizer === "anneal") ruleset.substrate = undefined;

  let feedbackScopeNotice: string | undefined;
  if (opts.feedback) {
    if (optimizer === "oscillator") {
      // Do not inject symbolic feedback rules into a learned-optimizer run.
      feedbackScopeNotice = FEEDBACK_SCOPE_NOTICE;
    } else {
      for (const r of synthesizeFromFeedback(opts.feedback, design, 0)) {
        if (!hasSimilarRule(ruleset, r)) ruleset = promoteRule(ruleset, r);
      }
    }
  }

  const synthOpts = (seed: number, extraEffort: number): SynthOpts => ({
    optimizer, batch, seed, polish: opts.polish ?? (optimizer === "oscillator" ? 120 : 0),
    annealIters: 600 + extraEffort,
  });
  const emiRisk = (e?: EmiReport) => e && e.levels.length ? e.levels[e.levels.length - 1].risk : 0;

  const history: IterationRecord[] = [];
  let best: BestState | null = null;

  for (let iter = 0; iter < iterations; iter++) {
    const promoted: string[] = [];

    // (a) explore the current substrate with fresh phase seeds
    const trial = synthOnce(design, ruleset, new RNG(baseSeed + iter * 101), synthOpts(baseSeed + iter * 977, iter * 350));
    if (!best || trial.score.total < best.score.total) {
      best = { ...trial };
      if (emiOn) best.emi = validateEmiProgressive(design, best.layout);
    }

    // (b) SELF-IMPROVE the optimizer: mutate the oscillator substrate, gate it.
    if (optimizer === "oscillator" && ruleset.substrate) {
      const cand = mutateSubstrate(ruleset.substrate as OscSubstrate, new RNG(baseSeed + iter * 101 + 17));
      const trialRs = cloneRuleset(ruleset); trialRs.substrate = cand;
      const test = synthOnce(design, trialRs, new RNG(baseSeed + iter * 101 + 41), synthOpts(baseSeed + iter * 631 + 5, iter * 350));
      if (test.score.total < best.score.total - 1e-6) {
        let ok = true;
        if (emiOn) {
          const emiCand = validateEmiProgressive(design, test.layout);
          ok = emiRisk(emiCand) <= emiRisk(best.emi) * 1.08 + 1e-6; // EMI non-regression gate
          if (ok) { ruleset = trialRs; best = { ...test, emi: emiCand }; promoted.push(`substrate v${cand.version}`); }
        } else {
          ruleset = trialRs; best = { ...test }; promoted.push(`substrate v${cand.version}`);
        }
      }
    }

    // (c) Symbolic layout rules from hotspots — anneal search-space constraints.
    // Under oscillator these are still score-gated into the ruleset for
    // persistence/transfer to anneal runs, but they do not steer the substrate.
    const candidates = synthesizeFromHotspots(best.score.hotspots, design, iter);
    for (const cand of candidates) {
      if (hasSimilarRule(ruleset, cand)) continue;
      const trialRules = promoteRule(ruleset, cand);
      const testR = synthOnce(design, trialRules, new RNG(baseSeed + iter * 101 + 53), synthOpts(baseSeed + iter * 733 + 9, iter * 350));
      if (testR.score.total < best.score.total - 1e-6) {
        ruleset = trialRules;
        best = { ...testR, emi: emiOn ? validateEmiProgressive(design, testR.layout) : best.emi };
        promoted.push(cand.name);
      }
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

function ruleset0(opts: ImproveOpts): Ruleset { return opts.ruleset!; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
