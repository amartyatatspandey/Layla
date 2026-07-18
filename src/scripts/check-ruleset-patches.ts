// Gate: Ruleset promotion uses owned-field patches (no whole-object clobber).
import * as fs from "fs";
import * as path from "path";
import {
  compileDesign, improve, defaultSubstrate, defaultRuleset,
  applyRulePatch, applySubstratePatch, applyPromotionPatch,
  RulePatch, SubstratePatch,
} from "../core";
import { Rule } from "../core/types";

const ROOT = path.join(__dirname, "..", "..");
const EX = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "build", "gate-ruleset-patches");
const SRC = path.join(ROOT, "src");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}

function loadBuck() {
  const sch = fs.readFileSync(path.join(EX, "buck_imu/buck_imu.kicad_sch"), "utf8");
  const cfg = JSON.parse(fs.readFileSync(path.join(EX, "buck_imu/layla.json"), "utf8"));
  return compileDesign(sch, {
    name: "buck_imu",
    width: cfg.board.width,
    height: cfg.board.height,
    diffPairs: cfg.board.diffPairs || [],
  }, OUT).design;
}

function noWholeObjectAssign(): void {
  console.log("\n=== no whole-Ruleset candidate assignment in improve() ===");
  const synth = fs.readFileSync(path.join(SRC, "core/synth.ts"), "utf8");
  assert(!/ruleset\s*=\s*pc\.ruleset/.test(synth), "no `ruleset = pc.ruleset`");
  assert(/applyPromotionPatch\s*\(/.test(synth), "acceptance uses applyPromotionPatch");
  assert(/owns:\s*"substrate"/.test(synth) || /SubstratePatch/.test(synth), "substrate candidates are SubstratePatch");
  assert(/owns:\s*"rules"/.test(synth) || /RulePatch/.test(synth), "rule candidates are RulePatch");

  const patches = fs.readFileSync(path.join(SRC, "core/rulesetPatches.ts"), "utf8");
  assert(/function applyRulePatch/.test(patches), "applyRulePatch defined");
  assert(/function applySubstratePatch/.test(patches), "applySubstratePatch defined");
  assert(/owns:\s*"rules"/.test(patches), "RulePatch owns rules");
  assert(/owns:\s*"substrate"/.test(patches), "SubstratePatch owns substrate");
}

function orderIndependence(): void {
  console.log("\n=== patch order-independence (rule ⊕ substrate) ===");
  const base = defaultRuleset();
  base.rules = [];
  base.substrate = defaultSubstrate();

  const rule: Rule = {
    id: "t_push",
    name: "noisy_away_from_sensitive",
    kind: "push_away",
    trigger: { roles: ["regulator"] },
    params: { minDist: 8 },
    status: "candidate",
    origin: "gate:order",
    createdIter: 0,
  };
  const sub = defaultSubstrate();
  sub.version = 2;
  sub.attractScale = 2.25;
  sub.condition.noisyAway = 1.9;

  const rulePatch: RulePatch = { owns: "rules", rule, label: rule.name };
  const subPatch: SubstratePatch = { owns: "substrate", substrate: sub, label: "substrate v2" };

  const ab = applySubstratePatch(applyRulePatch(base, rulePatch), subPatch);
  const ba = applyRulePatch(applySubstratePatch(base, subPatch), rulePatch);

  assert(ab.substrate!.version === 2 && ba.substrate!.version === 2, "both orders keep substrate v2");
  assert(ab.substrate!.attractScale === 2.25 && ba.substrate!.attractScale === 2.25, "both orders keep attractScale");
  assert(
    ab.rules.some((r) => r.name === rule.name && r.status === "promoted") &&
    ba.rules.some((r) => r.name === rule.name && r.status === "promoted"),
    "both orders keep promoted rule",
  );
  // Canonicalize for deep compare: rule ids from promoteRule may differ if
  // mkId advances — compare owned fields structurally.
  assert(
    JSON.stringify(ab.substrate) === JSON.stringify(ba.substrate),
    "substrate field identical either order",
  );
  assert(
    ab.rules.filter((r) => r.status === "promoted").map((r) => r.name).sort().join() ===
    ba.rules.filter((r) => r.status === "promoted").map((r) => r.name).sort().join(),
    "promoted rule names identical either order",
  );

  // Dispatch helper matches typed applies
  const viaDispatch = applyPromotionPatch(applyPromotionPatch(base, rulePatch), subPatch);
  assert(viaDispatch.substrate!.version === 2, "applyPromotionPatch preserves substrate");
  assert(viaDispatch.rules.some((r) => r.name === rule.name), "applyPromotionPatch preserves rule");
}

function clobberCaseFixed(): void {
  console.log("\n=== clobber case: buck_imu evolve keeps BOTH rule and substrate ===");
  const design = loadBuck();
  const feedback = "keep the buck hot loop tight and away from the imu";
  const res = improve(design, {
    iterations: 7,
    optimizer: "oscillator",
    feedback,
    // seed default 1337 — same as findings.md failure case
  });

  const dual = res.history.find(
    (h) => h.promoted.some((p) => p.startsWith("substrate")) &&
      h.promoted.some((p) => !p.startsWith("substrate")),
  );
  assert(!!dual, `found an iteration that promoted both types (got ${JSON.stringify(res.history.map((h) => h.promoted))})`);

  const sub = res.ruleset.substrate;
  const def = defaultSubstrate();
  assert(!!sub, "returned ruleset has a substrate");
  assert(sub!.version >= 2, `substrate version advanced (got v${sub!.version})`);
  assert(JSON.stringify(sub) !== JSON.stringify(def), "substrate is not deep-equal to defaultSubstrate()");
  assert(
    res.ruleset.rules.some((r) => r.status === "promoted"),
    "returned ruleset still has promoted symbolic rule(s)",
  );
  if (dual) {
    const subLabel = dual.promoted.find((p) => p.startsWith("substrate"))!;
    const ver = parseInt(subLabel.replace(/.*v/, ""), 10);
    assert(sub!.version >= ver, `final substrate version ≥ promoted ${subLabel} (got v${sub!.version})`);
  }
}

function ownershipNoCrossTouch(): void {
  console.log("\n=== apply* only touches owned fields ===");
  const base = defaultRuleset();
  base.rules = [{
    id: "keep", name: "existing", kind: "keepout", trigger: {}, params: {},
    status: "promoted", origin: "gate", createdIter: 0,
  }];
  const origRules = JSON.stringify(base.rules);
  const origSub = JSON.stringify(base.substrate);

  const sub = defaultSubstrate();
  sub.version = 5;
  sub.steps = 120;
  const afterSub = applySubstratePatch(base, { owns: "substrate", substrate: sub, label: "s" });
  assert(JSON.stringify(afterSub.rules) === origRules, "applySubstratePatch leaves rules[] unchanged");
  assert(afterSub.version === base.version, "applySubstratePatch leaves ruleset.version unchanged");
  assert(afterSub.substrate!.steps === 120, "applySubstratePatch sets substrate");

  const rule: Rule = {
    id: "n", name: "new_rule", kind: "cluster_tight", trigger: {}, params: {},
    status: "candidate", origin: "gate", createdIter: 1,
  };
  const afterRule = applyRulePatch(base, { owns: "rules", rule, label: rule.name });
  assert(JSON.stringify(afterRule.substrate) === origSub, "applyRulePatch leaves substrate unchanged");
  assert(afterRule.rules.some((r) => r.name === "new_rule"), "applyRulePatch adds rule");
  assert(afterRule.rules.some((r) => r.name === "existing"), "applyRulePatch keeps prior rules");
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  noWholeObjectAssign();
  ownershipNoCrossTouch();
  orderIndependence();
  clobberCaseFixed();
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\nPASS: ruleset owned-field patches");
}

main();
