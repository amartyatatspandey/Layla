// Schematic content-hash provenance for Ruleset transfer detection.
// Hash is over file contents, never the path — renames/copies of the same
// schematic keep the same hash.

import * as crypto from "crypto";
import { cloneRuleset } from "./rules";
import { Ruleset, RulesetProvenance } from "./types";

export const LEGACY_PROVENANCE_NOTICE =
  "Ruleset has no provenance field (legacy *.rules.json). Auto-detection of " +
  "cross-board transfer cannot run; treating as continuation (no cold/warm race). " +
  "Re-run `layla learn` or `layla synth` to populate provenance for future auto-detection.";

/**
 * Legacy oscillator artifact (no topologyMode) on a hierarchy-eligible board:
 * retain flat coupling for this run; next ruleset write stamps topologyMode.
 * Canonical definition lives in oscHierarchy.ts (avoid duplicating the string).
 */
export { LEGACY_FLAT_TOPOLOGY_NOTICE } from "./oscHierarchy";

/** Stable content hash of schematic text (sha256 hex). */
export function schematicContentHash(schematicText: string): string {
  return crypto.createHash("sha256").update(schematicText, "utf8").digest("hex");
}

export function makeProvenance(schematicText: string, boardLabel: string): RulesetProvenance {
  return {
    schematicHash: schematicContentHash(schematicText),
    boardLabel,
  };
}

/** Stamp / replace provenance on a ruleset (returns a clone). */
export function stampProvenance(
  rs: Ruleset,
  schematicText: string,
  boardLabel: string,
): Ruleset {
  const next = cloneRuleset(rs);
  next.provenance = makeProvenance(schematicText, boardLabel);
  return next;
}

export type ProvenanceCompare =
  | { status: "match"; target: RulesetProvenance; source: RulesetProvenance }
  | { status: "mismatch"; target: RulesetProvenance; source: RulesetProvenance }
  | { status: "legacy_absent"; target: RulesetProvenance };

/**
 * Compare a loaded ruleset's provenance to the target board's schematic hash.
 * Does not guess when provenance is missing.
 */
export function compareRulesetProvenance(
  loaded: Ruleset,
  targetSchematicText: string,
  targetBoardLabel: string,
): ProvenanceCompare {
  const target = makeProvenance(targetSchematicText, targetBoardLabel);
  if (!loaded.provenance || !loaded.provenance.schematicHash) {
    return { status: "legacy_absent", target };
  }
  if (loaded.provenance.schematicHash === target.schematicHash) {
    return { status: "match", target, source: loaded.provenance };
  }
  return { status: "mismatch", target, source: loaded.provenance };
}
