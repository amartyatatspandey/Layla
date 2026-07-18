// Gate: two-tier in-loop DRC (broad in score + exact promotion non-regression).
//
// Fixtures are synthetic / deterministic — no reliance on anneal luck.
import * as fs from "fs";
import * as path from "path";
import {
  checkClearance, checkClearanceBroad, scoreLayout, DEFAULT_WEIGHTS,
  evaluatePromotionGates, DEFAULT_PROMOTION_GATES,
  SCORE_IMPROVEMENT_GATE, DRC_CLEARANCE_NON_REGRESSION_GATE, EMI_NON_REGRESSION_GATE,
  compileDesign, Design, Layout, Score, DrcClearanceReport, DEFAULT_BOARD,
} from "../core";

const ROOT = path.join(__dirname, "..", "..");
const EX = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "build", "gate-inloop-drc");
const SRC = path.join(ROOT, "src");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}

function fakeScore(total: number, drcErrors = 0): Score {
  return {
    total,
    terms: { drc: drcErrors * DEFAULT_WEIGHTS.drc },
    hotspots: [],
    drcErrors,
    drcWarnings: 0,
    ratsnestLen: 0,
    ratsnestCrossings: 0,
    courtyardOverlaps: 0,
    switchLoopArea: 0,
    field: { coupling: 0, returnPath: 0, switching: 0, antenna: 0, thermal: 0 },
    routeCompletion: 1,
  };
}

function emptyLayout(): Layout {
  return { placements: {}, routes: [], vias: [], keepouts: [] };
}

/** Two parallel traces with edge gap well under board.clearance (0.2mm). */
function crampedTraceLayout(gapMm: number): Layout {
  const halfW = 0.1;
  return {
    placements: {},
    routes: [
      { net: "NET_A", layer: "F.Cu", width: halfW * 2, a: { x: 10, y: 10 }, b: { x: 20, y: 10 } },
      {
        net: "NET_B", layer: "F.Cu", width: halfW * 2,
        a: { x: 10, y: 10 + halfW * 2 + gapMm },
        b: { x: 20, y: 10 + halfW * 2 + gapMm },
      },
    ],
    vias: [],
    keepouts: [],
  };
}

function emptyDesign(): Design {
  return {
    name: "synthetic",
    components: [],
    nets: [],
    clusters: [],
    board: { name: "synthetic", ...DEFAULT_BOARD },
    footprints: {},
    footprintAssumptions: [],
  };
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

function weightsLocked(): void {
  console.log("\n=== DEFAULT_WEIGHTS.drc stays 20.0 ===");
  assert(DEFAULT_WEIGHTS.drc === 20.0, `DEFAULT_WEIGHTS.drc === 20.0 (got ${DEFAULT_WEIGHTS.drc})`);
}

function gateOrder(): void {
  console.log("\n=== gate order: score → DRC → EMI ===");
  assert(DEFAULT_PROMOTION_GATES[0] === SCORE_IMPROVEMENT_GATE, "canonical_score first");
  assert(DEFAULT_PROMOTION_GATES[1] === DRC_CLEARANCE_NON_REGRESSION_GATE, "drc_clearance_non_regression second");
  assert(DEFAULT_PROMOTION_GATES[2] === EMI_NON_REGRESSION_GATE, "emi_non_regression third");
  assert(DRC_CLEARANCE_NON_REGRESSION_GATE.name === "drc_clearance_non_regression", "DRC gate name");
}

function broadFindsCramped(): void {
  console.log("\n=== 1. Broad-phase finds coarse violations on cramped layout ===");
  const design = emptyDesign();
  const layout = crampedTraceLayout(0.05);
  const broad = checkClearanceBroad(design, layout);
  assert(broad.violationCount >= 1, `broad violationCount ≥ 1 (got ${broad.violationCount})`);
  assert(broad.requiredClearanceMm === design.board.clearance, "broad uses board.clearance");

  // Exact also flags the same synthetic short (report path still works).
  const exact = checkClearance(design, layout);
  assert(!exact.clean && exact.violations.length >= 1, "exact also flags cramped traces");

  // Score folds broad count into drcErrors (alongside proxy; here proxy is 0).
  const score = scoreLayout(design, layout, DEFAULT_WEIGHTS);
  assert(
    score.drcErrors >= broad.violationCount,
    `score.drcErrors (${score.drcErrors}) includes broad count (${broad.violationCount})`,
  );
  assert(
    Math.abs(score.terms.drc - score.drcErrors * DEFAULT_WEIGHTS.drc) < 1e-9,
    "drc term = drcErrors × DEFAULT_WEIGHTS.drc",
  );
}

function exactGateRejectsRegression(): void {
  console.log("\n=== 2. Exact gate rejects clearance regression despite better score ===");
  const design = emptyDesign();
  const clean = emptyLayout();
  const cramped = crampedTraceLayout(0.05);
  const bestDrc = checkClearance(design, clean);
  assert(bestDrc.violations.length === 0, "best has 0 exact violations");

  const reject = evaluatePromotionGates({
    design,
    layout: cramped,
    score: fakeScore(10), // better than bestScore 100
    bestScore: 100,
    bestDrc,
    emiOn: false,
    emiValidator: () => { throw new Error("EMI should not run"); },
  });
  assert(!reject.ok, "score↑ + exact DRC regress → REJECTED");
  assert(
    reject.failedGate === "drc_clearance_non_regression",
    `failed DRC gate (got ${reject.failedGate})`,
  );
  assert(!!reject.drc && reject.drc.violations.length > 0, "gate returns candidate exact report");
}

function equalOrBetterAllowsPromotion(): void {
  console.log("\n=== 3. Equal/better exact DRC allows promotion when score improves ===");
  const design = emptyDesign();
  const clean = emptyLayout();
  const bestDrc = checkClearance(design, clean);

  const pass = evaluatePromotionGates({
    design,
    layout: clean,
    score: fakeScore(10),
    bestScore: 100,
    bestDrc,
    emiOn: false,
    emiValidator: () => { throw new Error("EMI should not run"); },
  });
  assert(pass.ok, "score↑ + equal exact DRC (0→0) → accepted");
  assert(!!pass.drc && pass.drc.violations.length === 0, "gate returns clean exact report");

  // Better DRC: best has a violation, candidate is clean.
  const cramped = crampedTraceLayout(0.05);
  const worseBest: DrcClearanceReport = checkClearance(design, cramped);
  assert(worseBest.violations.length >= 1, "worse best has ≥1 exact violation");
  const improveDrc = evaluatePromotionGates({
    design,
    layout: clean,
    score: fakeScore(10),
    bestScore: 100,
    bestDrc: worseBest,
    emiOn: false,
    emiValidator: () => { throw new Error("EMI should not run"); },
  });
  assert(improveDrc.ok, "score↑ + better exact DRC → accepted");
}

function emittedBoardClearanceStillWorks(): void {
  console.log("\n=== 4. Emitted-board checkClearance still works (no check-drc regression) ===");
  // Same synthetic negative case as check-drc Part B.
  const design = emptyDesign();
  const layout = crampedTraceLayout(0.05);
  const report = checkClearance(design, layout);
  assert(report.clean === false, "synthetic near-short must be flagged");
  const hit = report.violations.find(
    (v) => (v.netA === "NET_A" && v.netB === "NET_B") || (v.netA === "NET_B" && v.netB === "NET_A"),
  );
  assert(!!hit, "violation names NET_A / NET_B");
  if (hit) {
    assert(hit.measuredMm < hit.requiredMm, "measured < required");
    assert(Math.abs(hit.measuredMm - 0.05) < 0.01, `measured ≈ 0.05 (got ${hit.measuredMm})`);
  }

  // Clean empty layout still clean.
  const clean = checkClearance(design, emptyLayout());
  assert(clean.clean && clean.violations.length === 0, "empty layout is clean");
}

function candidateLayoutUntouched(): void {
  console.log("\n=== CandidateLayout stays { layout } only; bestDrc lives on BestState ===");
  const synthSrc = fs.readFileSync(path.join(SRC, "core/synth.ts"), "utf8");
  const backendSrc = fs.readFileSync(path.join(SRC, "core/optimizerBackend.ts"), "utf8");
  assert(/bestDrc/.test(synthSrc), "synth.ts tracks bestDrc on BestState");
  const candBlock = backendSrc.match(
    /export interface CandidateLayout\s*\{[^}]*\}/,
  );
  assert(!!candBlock, "CandidateLayout interface found");
  if (candBlock) {
    assert(
      /^\s*layout:\s*Layout;\s*$/m.test(candBlock[0]) &&
        !/\bdrc\b/i.test(candBlock[0]),
      "CandidateLayout body is only `layout` (no drc field)",
    );
  }
}

function softMicrobench(): void {
  console.log("\n=== 5. Soft micro-benchmark: broad+exact on buck_imu seed layout ===");
  const design = loadBuck();
  // Minimal placed layout: empty routes — still exercises pad primitives.
  const layout: Layout = { placements: {}, routes: [], vias: [], keepouts: [] };
  let i = 0;
  for (const c of design.components) {
    layout.placements[c.ref] = {
      ref: c.ref,
      x: 10 + (i % 8) * 4,
      y: 10 + Math.floor(i / 8) * 4,
      rot: 0,
      side: "front",
    };
    i++;
  }
  const t0 = Date.now();
  const rounds = 20;
  for (let i = 0; i < rounds; i++) {
    checkClearanceBroad(design, layout);
    checkClearance(design, layout);
  }
  const ms = Date.now() - t0;
  const per = ms / rounds;
  console.log(`  note: ${rounds}×(broad+exact) on buck_imu pads = ${ms}ms (${per.toFixed(1)}ms/round)`);
  // Soft ceiling: a few seconds total is fine; egregious would be tens of seconds.
  if (ms > 15_000) {
    failures++;
    console.error(`  FAIL/STOP: in-loop DRC microbench took ${ms}ms — too slow; do not weaken checks`);
  } else {
    console.log(`  ok: within soft budget (<15s for ${rounds} rounds)`);
  }
}

function docsMentionTwoTier(): void {
  console.log("\n=== docs mention two-tier DRC ===");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const osc = fs.readFileSync(path.join(ROOT, "docs/oscillator-architecture.md"), "utf8");
  assert(/broad/i.test(readme) && /drc_clearance_non_regression|exact.*promot/i.test(readme), "README mentions two-tier / exact promotion DRC");
  assert(/drc_clearance_non_regression|exact.*DRC|two-tier/i.test(osc), "architecture doc mentions exact DRC gate / two-tier");
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  weightsLocked();
  gateOrder();
  broadFindsCramped();
  exactGateRejectsRegression();
  equalOrBetterAllowsPromotion();
  emittedBoardClearanceStillWorks();
  candidateLayoutUntouched();
  softMicrobench();
  docsMentionTwoTier();
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\nPASS: two-tier in-loop DRC + exact promotion gate");
}

main();
