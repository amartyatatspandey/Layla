// Gate: ruleset.weights removed; anneal feedback still constrains; oscillator
// + --feedback emits an explicit scope notice (CLI path via improve() + report).
import * as fs from "fs";
import * as path from "path";
import {
  compileDesign, improve, defaultRuleset, FEEDBACK_SCOPE_NOTICE,
  synthesizeFromFeedback,
} from "../core";

const ROOT = path.join(__dirname, "..", "..");
const EX = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "build", "gate-rules-scope");
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

function deadWeightGone(): void {
  console.log("\n=== dead weight-delta code gone ===");
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      if (fs.statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|md|json)$/.test(e) && !e.includes("gate-") && !p.includes("node_modules") && !p.includes("build/")) out.push(p);
    }
    return out;
  };
  const files = walk(SRC).filter((f) => !f.includes("check-rules-scope")).concat([
    path.join(ROOT, "README.md"),
    path.join(ROOT, "docs/oscillator-architecture.md"),
  ]);
  let hitApply = 0, hitWeightsField = 0;
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    if (/function applyWeightDeltas|export function applyWeightDeltas/.test(t)) {
      hitApply++;
      console.error(`  found applyWeightDeltas definition in ${f}`);
    }
    if (/weights:\s*\{\s*\.\.\.DEFAULT_WEIGHTS/.test(t)) {
      hitWeightsField++;
      console.error(`  found ruleset.weights initialization in ${f}`);
    }
  }
  assert(hitApply === 0, "applyWeightDeltas definition absent from src");
  assert(hitWeightsField === 0, "no ruleset.weights initialization remains");

  const rs = defaultRuleset();
  assert(!("weights" in rs), "defaultRuleset() has no weights field");
  const json = JSON.stringify(rs);
  assert(!/"weights"\s*:/.test(json), "serialized ruleset has no weights key");
}

function annealFeedback(): void {
  console.log("\n=== anneal + --feedback: symbolic rules still promote ===");
  const design = loadBuck();
  const feedback = "keep the buck hot loop tight and away from the imu";
  const res = improve(design, {
    iterations: 3, optimizer: "anneal", feedback, seed: 42,
  });
  assert(!res.feedbackScopeNotice, "anneal run has no oscillator feedback notice");
  const promoted = res.ruleset.rules.filter((r) => r.status === "promoted");
  assert(promoted.length >= 1, `anneal+feedback promoted ≥1 rule (got ${promoted.length})`);
  assert(
    promoted.some((r) => r.kind === "cluster_tight" || r.kind === "push_away"),
    "promoted rules include cluster_tight and/or push_away",
  );
  // Direct compile still works
  const synthesized = synthesizeFromFeedback(feedback, design, 0);
  assert(synthesized.length >= 1, "synthesizeFromFeedback still returns rules");
}

function oscillatorFeedbackNotice(): void {
  console.log("\n=== oscillator + --feedback: notice, no silent claim ===");
  fs.mkdirSync(OUT, { recursive: true });
  const design = loadBuck();
  const feedback = "keep the buck hot loop tight and away from the imu";
  const res = improve(design, {
    iterations: 2, optimizer: "oscillator", feedback, seed: 7, batch: 4, polish: 20,
  });
  assert(!!res.feedbackScopeNotice, "improve() sets feedbackScopeNotice");
  assert(
    res.feedbackScopeNotice === FEEDBACK_SCOPE_NOTICE,
    "notice matches FEEDBACK_SCOPE_NOTICE constant",
  );
  assert(
    /anneal/.test(res.feedbackScopeNotice!) && /substrate mutation/.test(res.feedbackScopeNotice!),
    "notice names anneal-only rules and substrate mutation",
  );
  // Feedback must not have been injected as promoted rules from the feedback origin
  const fromFeedback = res.ruleset.rules.filter((r) => r.origin.startsWith("feedback:"));
  assert(fromFeedback.length === 0, "no feedback-origin rules promoted under oscillator");

  // Simulate report artifact write (same field CLI uses)
  const report = {
    optimizer: "oscillator",
    feedbackScopeNotice: res.feedbackScopeNotice,
    learnedRules: res.ruleset.rules.filter((r) => r.status === "promoted").map((r) => r.name),
  };
  const reportPath = path.join(OUT, "osc_feedback.report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const loaded = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert(typeof loaded.feedbackScopeNotice === "string", "report artifact includes feedbackScopeNotice");
  assert(!/"weights"\s*:/.test(JSON.stringify(res.ruleset)), "ruleset JSON has no weights");
}

function docsFraming(): void {
  console.log("\n=== docs: deterministic vs learned framing ===");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const oscDoc = fs.readFileSync(path.join(ROOT, "docs/oscillator-architecture.md"), "utf8");
  assert(/Deterministic vs learned optimizers/.test(readme), "README has dedicated section");
  assert(/Deterministic vs learned optimizers/.test(oscDoc), "oscillator-architecture.md has dedicated section");
  assert(/architectural \*\*decision\*\*/.test(readme) || /architectural decision/.test(readme.toLowerCase()), "README frames as decision");
  assert(
    /not one unified rule\+substrate gate/i.test(readme) || /separate channels/i.test(readme),
    "README rejects unified rule+substrate gate (states separate channels)",
  );
  assert(!/same gate(?!.*separate)/i.test(oscDoc) || /not.*unified rule\+substrate gate/i.test(oscDoc),
    "osc doc rejects unified rule+substrate reading");
  // Transfer language should not imply K learned rules under oscillator
  assert(!/\+ promoted rules/.test(readme), "README transfer no longer says + promoted rules");
  assert(!/weights \+ evolved/.test(readme), "README rules.json line no longer mentions weights");
}

function transferDemoLanguage(): void {
  console.log("\n=== CLI transfer-demo language ===");
  const cli = fs.readFileSync(path.join(SRC, "cli.ts"), "utf8");
  assert(!/\+ \$\{.*learned rules/.test(cli), "cmdDemo does not interpolate '+ K learned rules'");
  assert(/symbolic rules are anneal-only/.test(cli), "cmdDemo states anneal-only for symbolic rules");
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  deadWeightGone();
  annealFeedback();
  oscillatorFeedbackNotice();
  docsFraming();
  transferDemoLanguage();
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\nPASS: rules scope / weights-removal gate");
}

main();
