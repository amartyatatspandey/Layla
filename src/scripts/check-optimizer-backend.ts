// Gate: OptimizerBackend + uniform promotion gates (EMI applies to every candidate).
import * as fs from "fs";
import * as path from "path";
import {
  compileDesign, improve, createBackend, materializeCandidate,
  evaluatePromotionGates, DEFAULT_PROMOTION_GATES, SCORE_IMPROVEMENT_GATE,
  EMI_NON_REGRESSION_GATE, emiRisk, defaultRuleset, defaultSubstrate, RNG,
  CandidateLayout, Design, Layout, Score, EmiReport,
} from "../core";

const ROOT = path.join(__dirname, "..", "..");
const EX = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "build", "gate-optimizer-backend");
const SRC = path.join(ROOT, "src");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}

function loadBuck(): Design {
  const sch = fs.readFileSync(path.join(EX, "buck_imu/buck_imu.kicad_sch"), "utf8");
  const cfg = JSON.parse(fs.readFileSync(path.join(EX, "buck_imu/layla.json"), "utf8"));
  return compileDesign(sch, {
    name: "buck_imu",
    width: cfg.board.width,
    height: cfg.board.height,
    diffPairs: cfg.board.diffPairs || [],
  }, OUT).design;
}

function fakeScore(total: number): Score {
  return {
    total,
    terms: {},
    hotspots: [],
    drcErrors: 0,
    drcWarnings: 0,
    ratsnestLen: 0,
    ratsnestCrossings: 0,
    courtyardOverlaps: 0,
    switchLoopArea: 0,
    field: { coupling: 0, returnPath: 0, switching: 0, antenna: 0, thermal: 0 },
    routeCompletion: 1,
  };
}

function fakeEmi(risk: number): EmiReport {
  return {
    model: "progressive_damped_wave_2p5d",
    levels: [{ cellMm: 1, risk, peak: risk, probeEnergy: risk }],
    converged: true,
    convergenceDeltaPct: 0,
    sensitiveProbeMax: "SENS",
    verdict: "ok",
    field: { cellMm: 1, w: 1, h: 1, data: [0] },
    riskByProbe: [],
  };
}

function candidateShape(): void {
  console.log("\n=== CandidateLayout shape identical across backends ===");
  const design = loadBuck();
  const annealRs = defaultRuleset();
  const oscRs = defaultRuleset();
  oscRs.substrate = defaultSubstrate();

  const a = createBackend("anneal").place({
    design, ruleset: annealRs, rng: new RNG(1), seed: 1, annealIters: 40,
  });
  const o = createBackend("oscillator").place({
    design, ruleset: oscRs, rng: new RNG(1), seed: 1, batch: 2, polish: 0,
  });

  const keysA = Object.keys(a).sort();
  const keysO = Object.keys(o).sort();
  assert(JSON.stringify(keysA) === JSON.stringify(keysO), `same keys: ${keysA} vs ${keysO}`);
  assert(keysA.length === 1 && keysA[0] === "layout", "CandidateLayout has only `layout`");
  assert(!!a.layout && !!o.layout, "both backends return a layout");

  // Type-level: no optional provenance fields on the shared type
  const _check: CandidateLayout = a;
  void _check;
}

function sharedDispatchPath(): void {
  console.log("\n=== synthOnce dispatch has no per-optimizer place branch ===");
  const synthSrc = fs.readFileSync(path.join(SRC, "core/synth.ts"), "utf8");
  // Placement goes through backend / materializeCandidate — not inline anneal/oscillatorPlace.
  assert(!/oscillatorPlace\s*\(/.test(synthSrc), "synth.ts does not call oscillatorPlace directly");
  assert(!/\banneal\s*\(/.test(synthSrc), "synth.ts does not call anneal() directly");
  assert(/materializeCandidate\s*\(/.test(synthSrc), "synth.ts uses materializeCandidate");
  assert(/createBackend\s*\(/.test(synthSrc), "synth.ts creates OptimizerBackend");

  // Promotion evaluation must not branch on rule vs substrate for which checks apply.
  const improveBody = synthSrc.slice(synthSrc.indexOf("export function improve"));
  assert(
    !/if\s*\(\s*emiOn\s*\).*substrate|substrate.*emiOn|isRule|rule.?derived|cand\.kind/i.test(improveBody)
      || /evaluatePromotionGates/.test(improveBody),
    "improve uses evaluatePromotionGates for promotion",
  );
  assert(/evaluatePromotionGates/.test(improveBody), "evaluatePromotionGates called in improve");

  // Gate list is named and extensible
  assert(DEFAULT_PROMOTION_GATES[0] === SCORE_IMPROVEMENT_GATE, "score gate first");
  assert(DEFAULT_PROMOTION_GATES[1] === EMI_NON_REGRESSION_GATE, "EMI gate second");
  assert(SCORE_IMPROVEMENT_GATE.name === "canonical_score", "score gate named");
  assert(EMI_NON_REGRESSION_GATE.name === "emi_non_regression", "EMI gate named");
}

function annealFeedbackNoEmi(): void {
  console.log("\n=== regression: anneal + --feedback (no --emi) ===");
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
}

function ruleEmiCarveoutGone(): void {
  console.log("\n=== NEW: rule candidate rejected when EMI regresses (carve-out gone) ===");
  const design = loadBuck();
  // Construct: better score, EMI risk beyond 1.08× best.
  const bestEmi = fakeEmi(10);
  const candEmi = fakeEmi(10 * 1.08 + 0.1); // clearly over threshold
  assert(emiRisk(candEmi) > emiRisk(bestEmi) * 1.08 + 1e-6, "fixture exceeds EMI threshold");

  const emptyLayout = { placements: {}, routes: [], vias: [], keepouts: [] } as Layout;
  const reject = evaluatePromotionGates({
    design,
    layout: emptyLayout,
    score: fakeScore(50),      // improves vs best 100
    bestScore: 100,
    bestEmi,
    emiOn: true,
    emiValidator: () => candEmi,
  });
  assert(!reject.ok, "score↑ + EMI regress → REJECTED");
  assert(reject.failedGate === "emi_non_regression", `failed EMI gate (got ${reject.failedGate})`);

  // Same candidate without --emi would pass on score alone (old carve-out behavior).
  const passNoEmi = evaluatePromotionGates({
    design,
    layout: emptyLayout,
    score: fakeScore(50),
    bestScore: 100,
    bestEmi,
    emiOn: false,
    emiValidator: () => candEmi,
  });
  assert(passNoEmi.ok, "same candidate accepted when --emi is off (score gate only)");

  // Control: score↑ + EMI within tolerance → accepted
  const okEmi = evaluatePromotionGates({
    design,
    layout: emptyLayout,
    score: fakeScore(50),
    bestScore: 100,
    bestEmi,
    emiOn: true,
    emiValidator: () => fakeEmi(10 * 1.08), // exactly at threshold
  });
  assert(okEmi.ok, "score↑ + EMI within 1.08× → accepted");
}

function oscillatorEmiSubstrateRegression(): void {
  console.log("\n=== regression: oscillator + --emi substrate EMI gate still active ===");
  const design = loadBuck();
  const synthSrc = fs.readFileSync(path.join(SRC, "core/synth.ts"), "utf8");
  // Old carve-out was an inline `if (emiOn) { … emiRisk … }` only around substrate.
  // New code must evaluate every promoCand via the shared gate list.
  assert(
    !/if \(emiOn\) \{\s*const emiCand/.test(synthSrc),
    "no substrate-only inline EMI gate remains in synth.ts",
  );
  assert(
    /for \(const pc of promoCands\)[\s\S]*evaluatePromotionGates/.test(synthSrc),
    "all promotion candidates (substrate + rules) go through evaluatePromotionGates",
  );

  // Live run still wires emiValidate through to the gate list.
  let calls = 0;
  improve(design, {
    iterations: 1,
    optimizer: "oscillator",
    seed: 11,
    batch: 2,
    polish: 5,
    emiValidate: true,
    emiValidator: () => {
      calls++;
      return fakeEmi(1);
    },
  });
  assert(calls >= 1, `EMI validator invoked under oscillator+emi (calls=${calls})`);

  // Direct gate check mirrors substrate path (unchanged threshold semantics).
  const block = evaluatePromotionGates({
    design,
    layout: { placements: {}, routes: [], vias: [], keepouts: [] } as Layout,
    score: fakeScore(1),
    bestScore: 10,
    bestEmi: fakeEmi(1),
    emiOn: true,
    emiValidator: () => fakeEmi(100),
  });
  assert(!block.ok && block.failedGate === "emi_non_regression", "substrate-style EMI reject still works");

  const pass = evaluatePromotionGates({
    design,
    layout: { placements: {}, routes: [], vias: [], keepouts: [] } as Layout,
    score: fakeScore(1),
    bestScore: 10,
    bestEmi: fakeEmi(1),
    emiOn: true,
    emiValidator: () => fakeEmi(1.05), // within 1.08×
  });
  assert(pass.ok, "substrate-style EMI within tolerance still accepted");
}

function materializeBothBackends(): void {
  console.log("\n=== both backends produce CandidateLayout via same call shape ===");
  const design = loadBuck();
  const annealRs = defaultRuleset();
  const oscRs = defaultRuleset();
  oscRs.substrate = defaultSubstrate();
  const reqBase = { design, rng: new RNG(99), seed: 99 };

  const mA = materializeCandidate(createBackend("anneal"), {
    ...reqBase, ruleset: annealRs, annealIters: 30,
  });
  const mO = materializeCandidate(createBackend("oscillator"), {
    ...reqBase, ruleset: oscRs, batch: 2, polish: 0,
  });
  assert(typeof mA.score.total === "number", "anneal materialize scores");
  assert(typeof mO.score.total === "number", "oscillator materialize scores");
  assert(!!mA.candidate.layout && !!mO.candidate.layout, "both return CandidateLayout.layout");
}

function docsMatch(): void {
  console.log("\n=== docs: EMI gating is uniform ===");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const oscDoc = fs.readFileSync(path.join(ROOT, "docs/oscillator-architecture.md"), "utf8");
  assert(/every candidate/i.test(readme) || /gate list/i.test(readme), "README mentions uniform gate list / every candidate");
  assert(!/not EMI-gated/i.test(oscDoc), "architecture doc does not exempt rules from EMI");
  assert(/no carve-out/i.test(oscDoc) || /same.*gate list/i.test(oscDoc), "architecture doc states no rule EMI carve-out");
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  candidateShape();
  sharedDispatchPath();
  materializeBothBackends();
  annealFeedbackNoEmi();
  ruleEmiCarveoutGone();
  oscillatorEmiSubstrateRegression();
  docsMatch();
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\nPASS: optimizer backend / uniform EMI gate");
}

main();
