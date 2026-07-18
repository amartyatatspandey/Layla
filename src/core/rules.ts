// The learning layer: synthesize layout rules from hotspots and human feedback,
// and gate them by whether they actually improve the score (the ratchet).
//
// Symbolic rules (push_away / cluster_tight / anchor_edge) are search-space
// constraints for the deterministic anneal optimizer. Learned optimizers
// (oscillator substrate; future GNN/RL) improve via their own representations,
// not by injecting these symbolic rules into the score.

import { defaultSubstrate } from "./osc";
import { Design, Hotspot, Role, Rule, Ruleset } from "./types";

export function defaultRuleset(): Ruleset {
  return { rules: [], version: 1, substrate: defaultSubstrate() };
}

export function cloneRuleset(rs: Ruleset): Ruleset {
  return {
    rules: rs.rules.map((r) => ({ ...r, params: { ...r.params } })),
    version: rs.version,
    substrate: rs.substrate ? JSON.parse(JSON.stringify(rs.substrate)) : undefined,
    provenance: rs.provenance
      ? { schematicHash: rs.provenance.schematicHash, boardLabel: rs.provenance.boardLabel }
      : undefined,
  };
}

function hasSimilarRule(rs: Ruleset, r: Rule): boolean {
  return rs.rules.some((x) => x.kind === r.kind && x.name === r.name && x.status !== "rejected");
}

let ruleSeq = 0;
function mkId(kind: string): string { return `${kind}_${++ruleSeq}`; }

// ---- synthesize candidate rules from detected hotspots ----
export function synthesizeFromHotspots(hotspots: Hotspot[], design: Design, iter: number): Rule[] {
  const out: Rule[] = [];
  const seen = new Set<string>();
  for (const h of hotspots) {
    if (seen.has(h.kind)) continue;
    seen.add(h.kind);
    switch (h.kind) {
      case "switch_loop":
        out.push({
          id: mkId("cluster_tight"), name: "buck_hot_loop_compaction", kind: "cluster_tight",
          trigger: { clusterKinds: ["buck_converter"] },
          params: { clusterKind: "buck_converter" },
          status: "candidate", origin: "auto:switch_loop", createdIter: iter,
        });
        break;
      case "noisy_sensitive_coupling":
        out.push({
          id: mkId("push_away"), name: "noisy_away_from_sensitive", kind: "push_away",
          trigger: { roles: ["regulator", "inductor", "motor_driver"] as Role[] },
          params: { aRoles: ["regulator", "inductor", "motor_driver", "mosfet"], bRoles: ["imu", "adc", "sensor", "crystal"], min: 12 },
          status: "candidate", origin: "auto:noisy_sensitive_coupling", createdIter: iter,
        });
        break;
      case "antenna_not_edge":
        out.push({
          id: mkId("anchor_edge"), name: "antenna_to_edge", kind: "anchor_edge",
          trigger: { roles: ["antenna", "rf"] as Role[] }, params: { edge: "right" },
          status: "candidate", origin: "auto:antenna_not_edge", createdIter: iter,
        });
        break;
      // decap_far / antenna_keepout previously only emitted kind:"weight" rules
      // that mutated the dead ruleset.weights field — no symbolic constraint
      // remains for those hotspot kinds.
      default:
        break;
    }
  }
  return out;
}

// ---- parse human feedback text into rules ----
export function synthesizeFromFeedback(text: string, design: Design, iter: number): Rule[] {
  const t = text.toLowerCase();
  const out: Rule[] = [];
  if (/(buck|regulator|switch|hot loop|inductor).*(tight|compact|close|small|loop)/.test(t) || /hot loop/.test(t)) {
    out.push({
      id: mkId("cluster_tight"), name: "buck_hot_loop_compaction", kind: "cluster_tight",
      trigger: { clusterKinds: ["buck_converter"] }, params: { clusterKind: "buck_converter" },
      status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  if (/(away|far|separate|isolate|noise|noisy).*(imu|adc|sensor|analog|sensitive)/.test(t) ||
      /(imu|adc|sensor|analog|sensitive).*(away|far|noise|switch|buck)/.test(t)) {
    out.push({
      id: mkId("push_away"), name: "noisy_away_from_sensitive", kind: "push_away",
      trigger: { roles: ["regulator", "inductor", "motor_driver"] as Role[] },
      params: { aRoles: ["regulator", "inductor", "motor_driver", "mosfet"], bRoles: ["imu", "adc", "sensor", "crystal"], min: 14 },
      status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  if (/(usb).*(away|not.*(under|near)|switch|inductor)/.test(t)) {
    out.push({
      id: mkId("push_away"), name: "usb_away_from_switching", kind: "push_away",
      trigger: { roles: ["usb"] as Role[] },
      params: { aRoles: ["usb"], bRoles: ["inductor", "regulator"], min: 10 },
      status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  if (/(antenna|rf).*(edge|keepout|clear|copper)/.test(t)) {
    out.push({
      id: mkId("anchor_edge"), name: "antenna_to_edge", kind: "anchor_edge",
      trigger: { roles: ["antenna", "rf"] as Role[] }, params: { edge: "right" },
      status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  // "tighten decoupling" previously only mutated dead ruleset.weights — omitted.
  return out;
}

/** Notice shown when --feedback is paired with a learned optimizer. */
export const FEEDBACK_SCOPE_NOTICE =
  "Notice: --feedback compiles symbolic layout rules (push_away / cluster_tight / anchor_edge) " +
  "for the deterministic anneal optimizer only. This run uses optimizer=oscillator; its learning " +
  "channel is substrate mutation, not symbolic rule injection. The run continues normally.";

// Add a promoted rule to a ruleset (symbolic constraints for anneal).
export function promoteRule(rs: Ruleset, rule: Rule): Ruleset {
  if (hasSimilarRule(rs, rule)) return rs;
  const next = cloneRuleset(rs);
  const promoted: Rule = { ...rule, status: "promoted" };
  next.rules.push(promoted);
  next.version++;
  return next;
}

export { hasSimilarRule };
