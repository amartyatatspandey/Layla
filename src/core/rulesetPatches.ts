// Explicit owned-field patches for Ruleset promotion.
//
// Ownership (enumerable by reading the apply* functions below — no generic merge):
//   RulePatch       → may only change `rules` (and `version` as promoteRule does)
//   SubstratePatch  → may only change `substrate`
//
// Adding a future candidate type (e.g. RL/GNN weights) means: define a new
// Patch type, one apply* function that touches only its owned field(s), and
// call it from the acceptance arm — do not change how unrelated patches apply.

import { cloneRuleset, promoteRule } from "./rules";
import { OscSubstrate } from "./oscTypes";
import { Rule, Ruleset } from "./types";

/** Symbolic-rule promotion: owns `rules[]` only. */
export interface RulePatch {
  readonly owns: "rules";
  rule: Rule;
  label: string;
}

/** Oscillator-substrate promotion: owns `substrate` only. */
export interface SubstratePatch {
  readonly owns: "substrate";
  substrate: OscSubstrate;
  label: string;
}

export type PromotionPatch = RulePatch | SubstratePatch;

/**
 * Apply a rule promotion to the *current* best Ruleset.
 * Carries `substrate` (and any future non-rules fields) forward unchanged.
 */
export function applyRulePatch(best: Ruleset, patch: RulePatch): Ruleset {
  // promoteRule clones `best` then appends the rule — substrate is preserved
  // from `best`, never from a stale candidate snapshot.
  return promoteRule(best, patch.rule);
}

/**
 * Apply a substrate mutation to the *current* best Ruleset.
 * Carries `rules` (and `version`) forward unchanged from `best`.
 */
export function applySubstratePatch(best: Ruleset, patch: SubstratePatch): Ruleset {
  const next = cloneRuleset(best);
  next.substrate = JSON.parse(JSON.stringify(patch.substrate));
  // Explicit non-touch: next.rules and next.version left as cloned from best.
  return next;
}

/** Dispatch by ownership tag — acceptance loop stays type-agnostic. */
export function applyPromotionPatch(best: Ruleset, patch: PromotionPatch): Ruleset {
  if (patch.owns === "rules") return applyRulePatch(best, patch);
  if (patch.owns === "substrate") return applySubstratePatch(best, patch);
  // Exhaustiveness: a new owns-tag must add a branch + apply* function.
  const _never: never = patch;
  return _never;
}

/**
 * Build a trial Ruleset for *evaluation* (score the proposed change) from a
 * generation snapshot + scoped patch. Does not mutate `base`.
 */
export function trialRulesetFromPatch(base: Ruleset, patch: PromotionPatch): Ruleset {
  return applyPromotionPatch(base, patch);
}
