// Gate: EMI relative-ranking scope (Item 6).
//
// Checks:
//   1. EMI_SCOPE_CLAIM is stable and present on every EmiReport.
//   2. Scope propagates into SVG legend text.
//   3. Deterministic risk ordering on controlled layouts (worse geometry → higher risk).
//   4. emi_non_regression remains uniform (no provenance carve-out) and ignores converged.
//   5. Docs/README carry the approved relative-ranking statement.
import * as fs from "fs";
import * as path from "path";
import {
  compileDesign, defaultRuleset, seedPlacement, RNG,
  validateEmiProgressive, EMI_SCOPE_CLAIM, emiRisk,
  evaluatePromotionGates, EMI_NON_REGRESSION_GATE, DEFAULT_PROMOTION_GATES,
  renderEmiFieldSVG, scoreLayout, DEFAULT_WEIGHTS, checkClearance,
  Design, Layout, EmiReport,
} from "../core";

const ROOT = path.join(__dirname, "..", "..");
const EX = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "build", "gate-emi-scope");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}

function loadBuck(): Design {
  const sch = path.join(EX, "buck_imu", "buck_imu.kicad_sch");
  const cfg = JSON.parse(fs.readFileSync(path.join(EX, "buck_imu", "layla.json"), "utf8"));
  const b = cfg.board || cfg;
  return compileDesign(fs.readFileSync(sch, "utf8"), {
    name: "buck_imu",
    width: b.width,
    height: b.height,
    diffPairs: b.diffPairs || [],
  }, OUT).design;
}

function place(design: Design, seed: number): Layout {
  return seedPlacement(design, defaultRuleset(), new RNG(seed));
}

function partScopeConstant(): void {
  console.log("\n=== Part A: EMI_SCOPE_CLAIM + report.scope ===");
  assert(EMI_SCOPE_CLAIM.includes("relative"), "claim mentions relative");
  assert(EMI_SCOPE_CLAIM.includes("ranking"), "claim mentions ranking");
  assert(!/compliance threshold|certified EMC/i.test(EMI_SCOPE_CLAIM) || /never.*compliance|never.*compliance/i.test(EMI_SCOPE_CLAIM),
    "claim denies compliance / absolute field");
  assert(/unitless|comparative/i.test(EMI_SCOPE_CLAIM), "claim says unitless/comparative");

  const design = loadBuck();
  const layout = place(design, 7);
  const emi = validateEmiProgressive(design, layout);
  assert(emi.scope === EMI_SCOPE_CLAIM, "EmiReport.scope === EMI_SCOPE_CLAIM");
  assert(typeof emi.converged === "boolean", "converged present (ranking confidence)");
}

function partSvgPropagation(): void {
  console.log("\n=== Part B: SVG carries scope ===");
  const design = loadBuck();
  const layout = place(design, 7);
  const emi = validateEmiProgressive(design, layout);
  const svg = renderEmiFieldSVG(design, layout, emi);
  assert(/relative near-field ranking|relative near-field coupling/i.test(svg), "SVG title/legend mentions relative ranking");
  // Scope text is long — check a distinctive fragment survives escaping.
  const fragment = "unitless comparative";
  assert(svg.includes(fragment) || svg.includes(EMI_SCOPE_CLAIM.slice(0, 40)), "SVG embeds scope claim text");
}

function partRiskOrdering(): void {
  console.log("\n=== Part C: deterministic risk ordering ===");
  const design = loadBuck();
  const base = place(design, 42);
  const W = design.board.width;
  const H = design.board.height;

  const clone = (layout: Layout): Layout => ({
    placements: Object.fromEntries(
      Object.entries(layout.placements).map(([k, p]) => [k, { ...p }]),
    ),
    routes: layout.routes.map((r) => ({ ...r, a: { ...r.a }, b: { ...r.b } })),
    vias: layout.vias.map((v) => ({ ...v, at: { ...v.at } })),
    keepouts: layout.keepouts.map((k) => ({ ...k })),
  });
  const put = (layout: Layout, ref: string, x: number, y: number): void => {
    const p = layout.placements[ref] || base.placements[ref];
    if (!p) return;
    layout.placements[ref] = { ...p, x, y };
  };

  // Near: aggressors (U2/L1) stacked on victims (U3/Y1).
  const near = clone(base);
  put(near, "U3", W * 0.5, H * 0.5);
  put(near, "Y1", W * 0.52, H * 0.52);
  put(near, "U2", W * 0.5, H * 0.5);
  put(near, "L1", W * 0.48, H * 0.48);

  // Far: aggressors vs victims in opposite corners.
  const far = clone(base);
  put(far, "U2", 8, 8);
  put(far, "L1", 12, 8);
  put(far, "U3", W - 10, H - 10);
  put(far, "Y1", W - 14, H - 10);

  const rNear = emiRisk(validateEmiProgressive(design, near));
  const rFar = emiRisk(validateEmiProgressive(design, far));
  assert(Number.isFinite(rNear) && Number.isFinite(rFar), "emiRisk finite for controlled layouts");
  assert(rNear > rFar, `near risk (${rNear.toFixed(4)}) > far risk (${rFar.toFixed(4)})`);
  // Determinism: same layout twice → identical risk.
  const again = emiRisk(validateEmiProgressive(design, near));
  assert(Math.abs(again - rNear) < 1e-9, "same layout → identical emiRisk");
}

function partUniformGate(): void {
  console.log("\n=== Part D: uniform emi_non_regression (ignores converged) ===");
  assert(DEFAULT_PROMOTION_GATES.includes(EMI_NON_REGRESSION_GATE), "EMI gate in default list");
  assert(EMI_NON_REGRESSION_GATE.name === "emi_non_regression", "gate named");

  const design = loadBuck();
  const layout = place(design, 5);
  const score = scoreLayout(design, layout, DEFAULT_WEIGHTS);
  const bestEmi: EmiReport = {
    model: "progressive_damped_wave_2p5d",
    scope: EMI_SCOPE_CLAIM,
    levels: [{ cellMm: 1, risk: 1, peak: 1, probeEnergy: 1 }],
    converged: true,
    convergenceDeltaPct: 0,
    sensitiveProbeMax: "X",
    verdict: "ok",
    field: { cellMm: 1, w: 1, h: 1, data: [0] },
    riskByProbe: [],
  };
  // Unconverged candidate with low risk must still be eligible (converged unused).
  const lowUnconv: EmiReport = {
    ...bestEmi,
    converged: false,
    levels: [{ cellMm: 1, risk: 0.5, peak: 0.5, probeEnergy: 0.5 }],
  };
  const gate = evaluatePromotionGates({
    design,
    layout,
    score: { ...score, total: score.total - 10 },
    bestScore: score.total,
    bestEmi,
    bestDrc: checkClearance(design, layout),
    emiOn: true,
    emiValidator: () => lowUnconv,
  });
  assert(gate.ok, "unconverged low-risk candidate still passes EMI gate");
  assert(gate.emi?.converged === false, "gate returns unconverged EMI report");
}

function partDocs(): void {
  console.log("\n=== Part E: docs carry approved statement ===");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const arch = fs.readFileSync(path.join(ROOT, "docs", "oscillator-architecture.md"), "utf8");
  const master = fs.readFileSync(path.join(ROOT, "docs", "Layla_implementation_master.md"), "utf8");
  assert(/EMI_SCOPE_CLAIM|relative near-field coupling risk/i.test(readme), "README states relative-ranking scope");
  assert(/EMI_SCOPE_CLAIM|relative near-field coupling risk/i.test(arch), "architecture doc states scope");
  assert(/Item 6.*CLOSED|EMI_SCOPE_CLAIM/i.test(master), "master plan marks Item 6 closed");
  const audit = fs.readFileSync(path.join(ROOT, "LAYLA_AUDIT.md"), "utf8");
  assert(/Item 6: EMI relative-ranking scope/i.test(audit), "audit has Item 6 resolution");
}

fs.mkdirSync(OUT, { recursive: true });
partScopeConstant();
partSvgPropagation();
partRiskOrdering();
partUniformGate();
partDocs();

if (failures > 0) {
  console.error(`\nFAIL: emi-scope gate — ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: emi-scope gate (scope claim + SVG + ordering + uniform gate + docs).");
