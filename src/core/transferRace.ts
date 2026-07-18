// Cross-board transfer racing: when a loaded ruleset was evolved on a different
// schematic (provenance hash mismatch), run independent COLD and WARM improve()
// passes and keep the winner wholesale. Same-board continuation never races.
// Legacy rulesets without provenance: explicit notice, no race, no guessing.

import { cloneRuleset } from "./rules";
import {
  compareRulesetProvenance,
  LEGACY_PROVENANCE_NOTICE,
  stampProvenance,
} from "./provenance";
import { improve, ImproveOpts } from "./synth";
import { Design, ImproveResult, Ruleset, TransferRaceReport } from "./types";

export interface ImproveWithRulesOpts extends ImproveOpts {
  /** Raw schematic text for the *target* board (hash provenance + detection). */
  schematicText: string;
  /** Human-readable board label (defaults to design.name). */
  boardLabel?: string;
  /**
   * Ruleset loaded via --rules (may be undefined). When present, provenance
   * decides continuation vs automatic cold/warm race.
   */
  loadedRuleset?: Ruleset;
}

/**
 * Entry point for CLI/synth paths that may load a foreign ruleset.
 * Always stamps target-board provenance on the returned ruleset.
 */
export function improveWithLoadedRuleset(
  design: Design,
  opts: ImproveWithRulesOpts,
): ImproveResult {
  const boardLabel = opts.boardLabel ?? design.name;
  const { schematicText, loadedRuleset, ...improveOpts } = opts;

  const stamp = (res: ImproveResult): ImproveResult => ({
    ...res,
    ruleset: stampProvenance(res.ruleset, schematicText, boardLabel),
  });

  if (!loadedRuleset) {
    const res = stamp(improve(design, improveOpts));
    res.transferRace = {
      triggered: false,
      reason: "no_loaded_ruleset",
      targetBoardLabel: boardLabel,
    };
    return res;
  }

  // Strip legacy weights if somehow still present
  const loaded = cloneRuleset(loadedRuleset);
  if ("weights" in loaded) delete (loaded as any).weights;

  const cmp = compareRulesetProvenance(loaded, schematicText, boardLabel);

  if (cmp.status === "legacy_absent") {
    const res = stamp(improve(design, { ...improveOpts, ruleset: loaded }));
    res.provenanceNotice = LEGACY_PROVENANCE_NOTICE;
    res.transferRace = {
      triggered: false,
      reason: "legacy_no_provenance",
      targetBoardLabel: boardLabel,
      notice: LEGACY_PROVENANCE_NOTICE,
    };
    return res;
  }

  if (cmp.status === "match") {
    // Same board — continuation, single pass, no double compute.
    const res = stamp(improve(design, { ...improveOpts, ruleset: loaded }));
    res.transferRace = {
      triggered: false,
      reason: "same_board",
      sourceBoardLabel: cmp.source.boardLabel,
      targetBoardLabel: boardLabel,
    };
    return res;
  }

  // Cross-board transfer → race COLD vs WARM (two complete independent passes).
  // Do not forward onIteration into either pass — interleaved streaming would
  // mix lineages; callers get the winner's final state only.
  const { onIteration: _ignore, ...shared } = improveOpts;
  void _ignore;
  const cold = improve(design, { ...shared, ruleset: undefined });
  const warm = improve(design, { ...shared, ruleset: loaded });

  const coldScore = cold.best.score.total;
  const warmScore = warm.best.score.total;
  const winner: "cold" | "warm" = coldScore <= warmScore ? "cold" : "warm";
  const winRes = winner === "cold" ? cold : warm;
  const loseScore = winner === "cold" ? warmScore : coldScore;
  const winScore = winner === "cold" ? coldScore : warmScore;

  const race: TransferRaceReport = {
    triggered: true,
    reason: "cross_board",
    sourceBoardLabel: cmp.source.boardLabel,
    targetBoardLabel: boardLabel,
    coldScore,
    warmScore,
    winner,
    delta: winScore - loseScore,
  };

  const out = stamp(winRes);
  // Preserve feedback notice from whichever run we keep (warm may have had one).
  if (winRes.feedbackScopeNotice) out.feedbackScopeNotice = winRes.feedbackScopeNotice;
  else if (warm.feedbackScopeNotice && winner === "warm") {
    out.feedbackScopeNotice = warm.feedbackScopeNotice;
  }
  out.transferRace = race;
  return out;
}
