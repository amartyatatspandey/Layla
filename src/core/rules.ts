// The learning layer: synthesize layout rules from hotspots and human feedback,
// and gate them by whether they actually improve the score (the ratchet).

import { DEFAULT_WEIGHTS } from "./score";
import { defaultSubstrate } from "./osc";
import { Design, Hotspot, Role, Rule, Ruleset } from "./types";

export function defaultRuleset(): Ruleset {
  return { rules: [], weights: { ...DEFAULT_WEIGHTS }, version: 1, substrate: defaultSubstrate() };
}

export function cloneRuleset(rs: Ruleset): Ruleset {
  return {
    rules: rs.rules.map((r) => ({ ...r, params: { ...r.params }, weightDeltas: r.weightDeltas ? { ...r.weightDeltas } : undefined })),
    weights: { ...rs.weights },
    version: rs.version,
    substrate: rs.substrate ? JSON.parse(JSON.stringify(rs.substrate)) : undefined,
  };
}

export function applyWeightDeltas(rs: Ruleset, deltas?: Record<string, number>): void {
  if (!deltas) return;
  for (const k of Object.keys(deltas)) {
    rs.weights[k] = (rs.weights[k] ?? 1) * (1 + deltas[k]);
  }
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
          weightDeltas: { switchLoop: 0.6 },
          status: "candidate", origin: "auto:switch_loop", createdIter: iter,
        });
        break;
      case "noisy_sensitive_coupling":
        out.push({
          id: mkId("push_away"), name: "noisy_away_from_sensitive", kind: "push_away",
          trigger: { roles: ["regulator", "inductor", "motor_driver"] as Role[] },
          params: { aRoles: ["regulator", "inductor", "motor_driver", "mosfet"], bRoles: ["imu", "adc", "sensor", "crystal"], min: 12 },
          weightDeltas: { noisySensitive: 0.5 },
          status: "candidate", origin: "auto:noisy_sensitive_coupling", createdIter: iter,
        });
        break;
      case "decap_far":
        out.push({
          id: mkId("weight"), name: "tighten_decoupling", kind: "weight",
          trigger: {}, params: {}, weightDeltas: { decap: 0.8 },
          status: "candidate", origin: "auto:decap_far", createdIter: iter,
        });
        break;
      case "antenna_not_edge":
        out.push({
          id: mkId("anchor_edge"), name: "antenna_to_edge", kind: "anchor_edge",
          trigger: { roles: ["antenna", "rf"] as Role[] }, params: { edge: "right" },
          weightDeltas: { antenna: 0.5 },
          status: "candidate", origin: "auto:antenna_not_edge", createdIter: iter,
        });
        break;
      case "antenna_keepout":
        out.push({
          id: mkId("weight"), name: "antenna_keepout_strength", kind: "weight",
          trigger: {}, params: {}, weightDeltas: { antenna: 0.6 },
          status: "candidate", origin: "auto:antenna_keepout", createdIter: iter,
        });
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
      weightDeltas: { switchLoop: 1.0 }, status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  if (/(away|far|separate|isolate|noise|noisy).*(imu|adc|sensor|analog|sensitive)/.test(t) ||
      /(imu|adc|sensor|analog|sensitive).*(away|far|noise|switch|buck)/.test(t)) {
    out.push({
      id: mkId("push_away"), name: "noisy_away_from_sensitive", kind: "push_away",
      trigger: { roles: ["regulator", "inductor", "motor_driver"] as Role[] },
      params: { aRoles: ["regulator", "inductor", "motor_driver", "mosfet"], bRoles: ["imu", "adc", "sensor", "crystal"], min: 14 },
      weightDeltas: { noisySensitive: 1.0 }, status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  if (/(usb).*(away|not.*(under|near)|switch|inductor)/.test(t)) {
    out.push({
      id: mkId("push_away"), name: "usb_away_from_switching", kind: "push_away",
      trigger: { roles: ["usb"] as Role[] },
      params: { aRoles: ["usb"], bRoles: ["inductor", "regulator"], min: 10 },
      weightDeltas: { usbPair: 0.6 }, status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  if (/(antenna|rf).*(edge|keepout|clear|copper)/.test(t)) {
    out.push({
      id: mkId("anchor_edge"), name: "antenna_to_edge", kind: "anchor_edge",
      trigger: { roles: ["antenna", "rf"] as Role[] }, params: { edge: "right" },
      weightDeltas: { antenna: 1.0 }, status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  if (/(decoup|decap|bypass).*(close|near|tight)/.test(t)) {
    out.push({
      id: mkId("weight"), name: "tighten_decoupling", kind: "weight",
      trigger: {}, params: {}, weightDeltas: { decap: 1.0 }, status: "candidate",
      origin: `feedback:${text.slice(0, 60)}`, createdIter: iter,
    });
  }
  return out;
}

// Add a promoted rule to a ruleset (applies its weight deltas once).
export function promoteRule(rs: Ruleset, rule: Rule): Ruleset {
  if (hasSimilarRule(rs, rule)) return rs;
  const next = cloneRuleset(rs);
  const promoted: Rule = { ...rule, status: "promoted" };
  next.rules.push(promoted);
  applyWeightDeltas(next, promoted.weightDeltas);
  next.version++;
  return next;
}

export { hasSimilarRule };
