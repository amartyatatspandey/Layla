// Gate: footprint hard-fail + assumption disclosure.
// Catches silent C_0603 / placeholder / pad-invention fallbacks.
import * as fs from "fs";
import * as path from "path";
import {
  compileDesign,
  isUnresolvedFootprintError,
  UnresolvedFootprintError,
  genSchematic,
  footprintReportPath,
} from "../core";
import * as footprints from "../core/footprints";

const ROOT = path.join(__dirname, "..", "..");
const EX_DIR = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "build", "gate-footprint");
const DEBT = path.join(ROOT, "technical_debt.md");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}

function wipeOut(): void {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
}

function schWithPackage(name: string, footprint: string, pins: Record<string, string>): string {
  return genSchematic({
    name,
    parts: [{
      ref: "U1",
      value: "TEST",
      symName: "IC",
      footprint,
      at: { x: 30, y: 30 },
      pins: Object.fromEntries(
        Object.entries(pins).map(([num, net]) => [num, { name: net, net }]),
      ),
    }],
  });
}

function readReport(name: string): any {
  const p = footprintReportPath(OUT, name);
  assert(fs.existsSync(p), `report exists: ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function noPcb(name: string): void {
  const pcb = path.join(OUT, `${name}.kicad_pcb`);
  assert(!fs.existsSync(pcb), `no .kicad_pcb emitted for ${name}`);
}

// ---- unit-level resolveFootprint checks ----
function unitResolve(): void {
  console.log("\n=== resolveFootprint unit cases ===");
  const resolveFootprint = footprints.resolveFootprint;

  const ok48 = resolveFootprint("Package_QFP:LQFP-48", "", ["1", "2", "3"], "U1");
  assert(ok48.ok === true, "LQFP-48 resolves");
  if (ok48.ok) {
    assert(!!ok48.assumption, "LQFP-48 has assumption disclosure");
    assert(ok48.geom.pads.length === 48, "LQFP-48 has 48 pads");
  }

  const amb = resolveFootprint("Package_QFP:LQFP-64", "", ["1", "2"], "U1");
  assert(amb.ok === false && amb.reason === "ambiguous_pitch", "LQFP-64 → ambiguous_pitch");

  const fake = resolveFootprint("Package_FAKE:NOPE-99", "", ["1", "2", "3"], "U1");
  assert(fake.ok === false && fake.reason === "unmapped_package", "fake package → unmapped_package");

  const htOk = resolveFootprint("Package_QFP:HTSSOP-28", "", ["1", "2", "7"], "U2");
  assert(htOk.ok === true, "HTSSOP-28 fixed entry resolves");

  const htBad = resolveFootprint("Package_QFP:HTSSOP-16", "", ["1", "2"], "U2");
  assert(htBad.ok === false && htBad.reason === "unmapped_package", "HTSSOP-16 → unmapped (no generator)");

  const lgaOk = resolveFootprint("Package_LGA:LGA-8", "", ["1", "2", "3", "4"], "U3");
  assert(lgaOk.ok === true, "LGA-8 fixed entry resolves");

  const lgaBad = resolveFootprint("Package_LGA:LGA-14", "", ["1", "2"], "U3");
  assert(lgaBad.ok === false && lgaBad.reason === "unmapped_package", "LGA-14 → unmapped (no generator)");

  const tssopOk = resolveFootprint("Package_SO:TSSOP-16", "", ["1", "2", "8"], "U4");
  assert(tssopOk.ok === true, "TSSOP-16 parametric resolves");

  const tssopAmb = resolveFootprint("Package_SO:TSSOP-28", "", ["1", "2"], "U4");
  assert(tssopAmb.ok === false && tssopAmb.reason === "ambiguous_pitch", "TSSOP-28 → ambiguous_pitch");

  // pad_count_mismatch: force a TABLE template that can't cover pin "99"
  const mismatch = resolveFootprint("Package_TO_SOT_SMD:SOT-23", "", ["1", "2", "3", "99"], "Q1");
  assert(mismatch.ok === false && mismatch.reason === "pad_count_mismatch", "extra pin → pad_count_mismatch");
}

// ---- compileDesign + report shape ----
function compileReports(): void {
  console.log("\n=== compileDesign report shapes ===");
  wipeOut();

  // Clean passive-only board → ok + empty assumptions array
  const cleanName = "gate_clean_passive";
  const cleanSch = genSchematic({
    name: cleanName,
    parts: [{
      ref: "R1", value: "10k", symName: "R", footprint: "Resistor_SMD:R_0603",
      at: { x: 30, y: 30 },
      pins: { "1": { name: "A", net: "NET_A" }, "2": { name: "B", net: "NET_B" } },
    }],
  });
  const clean = compileDesign(cleanSch, { name: cleanName, width: 40, height: 30 }, OUT);
  const cleanRep = readReport(cleanName);
  assert(cleanRep.status === "ok", "clean board status ok");
  assert(Array.isArray(cleanRep.assumptions), "assumptions is explicit array");
  assert(cleanRep.assumptions.length === 0, "passive board assumptions empty array (not omitted)");
  assert(!!clean.design.footprintAssumptions, "Design.footprintAssumptions present");

  // LQFP-48 success with assumption logged
  const lqfpName = "gate_lqfp48";
  const lqfpSch = schWithPackage(lqfpName, "Package_QFP:LQFP-48", {
    "1": "3V3", "2": "GND", "3": "PWM",
  });
  compileDesign(lqfpSch, { name: lqfpName, width: 40, height: 30 }, OUT);
  const lqfpRep = readReport(lqfpName);
  assert(lqfpRep.status === "ok", "LQFP-48 compile ok");
  assert(lqfpRep.assumptions.length >= 1, "LQFP-48 assumption logged");
  assert(/0\.5mm pitch/.test(lqfpRep.assumptions[0].message), "assumption names pitch");

  // Ambiguous pitch hard-fail
  const ambName = "gate_lqfp64_amb";
  const ambSch = schWithPackage(ambName, "Package_QFP:LQFP-64", { "1": "A", "2": "B" });
  let ambThrew = false;
  try {
    compileDesign(ambSch, { name: ambName, width: 40, height: 30 }, OUT);
  } catch (e) {
    ambThrew = isUnresolvedFootprintError(e);
  }
  assert(ambThrew, "LQFP-64 throws UnresolvedFootprintError");
  const ambRep = readReport(ambName);
  assert(ambRep.status === "rejected", "LQFP-64 report rejected");
  assert(ambRep.entries?.[0]?.reason === "ambiguous_pitch", "LQFP-64 entry reason ambiguous_pitch");
  noPcb(ambName);

  // Fake package hard-fail
  const fakeName = "gate_fake_pkg";
  const fakeSch = schWithPackage(fakeName, "Package_FAKE:ZZZ-11", { "1": "A", "2": "B", "3": "C" });
  let fakeThrew = false;
  try {
    compileDesign(fakeSch, { name: fakeName, width: 40, height: 30 }, OUT);
  } catch (e) {
    fakeThrew = isUnresolvedFootprintError(e);
  }
  assert(fakeThrew, "fake package throws");
  const fakeRep = readReport(fakeName);
  assert(fakeRep.entries?.[0]?.reason === "unmapped_package", "fake → unmapped_package");
  noPcb(fakeName);

  // HTSSOP-16 / LGA-14 hard-fail (no generator fallthrough)
  for (const [nm, fp, reason] of [
    ["gate_htssop16", "Package_QFP:HTSSOP-16", "unmapped_package"],
    ["gate_lga14", "Package_LGA:LGA-14", "unmapped_package"],
  ] as const) {
    try { compileDesign(schWithPackage(nm, fp, { "1": "A", "2": "B" }), { name: nm, width: 40, height: 30 }, OUT); }
    catch (e) { assert(isUnresolvedFootprintError(e), `${nm} throws UnresolvedFootprintError`); }
    const r = readReport(nm);
    assert(r.entries?.[0]?.reason === reason, `${nm} → ${reason}`);
  }

  // internal_error path: malformed schematic
  const badName = "gate_internal_error";
  let otherThrew = false;
  try {
    compileDesign("not a kicad schematic", { name: badName }, OUT);
  } catch (e) {
    otherThrew = !(e instanceof UnresolvedFootprintError);
  }
  assert(otherThrew, "malformed schem throws non-Unresolved error");
  const badRep = readReport(badName);
  assert(badRep.status === "rejected" && badRep.reason === "internal_error", "internal_error report written");
}

// ---- all 5 example boards ----
function exampleBoards(): void {
  console.log("\n=== bundled example boards (compile-only) ===");
  const index: { name: string; schematic: string; config: string }[] =
    JSON.parse(fs.readFileSync(path.join(EX_DIR, "index.json"), "utf8"));
  const padMismatchHits: string[] = [];

  for (const ex of index) {
    const schPath = path.join(EX_DIR, ex.schematic);
    const text = fs.readFileSync(schPath, "utf8");
    const cfgPath = path.join(path.dirname(schPath), "layla.json");
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const b = raw.board || raw;
    const board = {
      name: ex.name,
      width: b.width,
      height: b.height,
      diffPairs: b.diffPairs || [],
    };
    try {
      const { design, reportPath } = compileDesign(text, board, OUT);
      const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      assert(rep.status === "ok", `${ex.name}: footprint-report status ok`);
      assert(Array.isArray(rep.assumptions), `${ex.name}: assumptions array present`);
      // pad coverage
      let mism = 0;
      for (const c of design.components) {
        const fp = design.footprints[c.ref];
        const have = new Set((fp?.pads ?? []).map((p) => p.num));
        const missing = c.pins.map((p) => p.num).filter((n) => n !== "" && !have.has(n));
        if (missing.length) mism++;
      }
      assert(mism === 0, `${ex.name}: all schematic pins have pads (${design.components.length} comps)`);
      console.log(`  ${ex.name.padEnd(14)} OK  assumptions=${rep.assumptions.length}`);
    } catch (e) {
      if (isUnresolvedFootprintError(e)) {
        const reasons = e.entries.map((x) => x.reason);
        console.error(`  ${ex.name}: REJECTED — ${e.entries.map((x) => `${x.ref}/${x.package}/${x.reason}`).join("; ")}`);
        if (reasons.includes("pad_count_mismatch")) {
          for (const ent of e.entries.filter((x) => x.reason === "pad_count_mismatch")) {
            padMismatchHits.push(`${ex.name}:${ent.ref} (${ent.package}) nets=[${ent.nets.join(",")}] ${ent.detail || ""}`);
          }
        }
        // Hard-fail is allowed only if we report it; boards that still fail need human review.
        assert(false, `${ex.name}: expected clean compile after mapping expansion (got rejection)`);
      } else {
        assert(false, `${ex.name}: unexpected compile error: ${(e as Error).message}`);
      }
    }
  }

  if (padMismatchHits.length) {
    console.error("\n*** pad_count_mismatch hits (do NOT restore ensurePadCoverage — expand templates):");
    for (const h of padMismatchHits) console.error("  ", h);
  }
}

// ---- technical_debt.md idempotency ----
function debtFile(): void {
  console.log("\n=== technical_debt.md ===");
  assert(fs.existsSync(DEBT), "technical_debt.md exists");
  const text = fs.readFileSync(DEBT, "utf8");
  assert(/HTSSOP fixed-entry only/.test(text), "contains HTSSOP debt entry");
  assert(/LGA fixed-entry only/.test(text), "contains LGA debt entry");
  const htCount = (text.match(/HTSSOP fixed-entry only/g) || []).length;
  const lgaCount = (text.match(/LGA fixed-entry only/g) || []).length;
  assert(htCount === 1, "HTSSOP entry not duplicated");
  assert(lgaCount === 1, "LGA entry not duplicated");
}

// ---- stub-swap proofs ----
function stubSwapProofs(): void {
  console.log("\n=== stub-swap proofs (temporary; must leave resolveFootprint intact) ===");

  const orig = footprints.resolveFootprint;

  // Swap: unknown packages return a 2-pad chip (old bug class)
  (footprints as any).resolveFootprint = (libId: string, value = "", pinNums: string[] = [], ref = "?") => {
    const r = orig(libId, value, pinNums, ref);
    if (!r.ok && r.reason === "unmapped_package") {
      return {
        ok: true,
        geom: {
          id: "C_0603_SILENT",
          pads: [
            { num: "1", x: -0.75, y: 0, w: 0.8, h: 0.85, shape: "roundrect", type: "smd" },
            { num: "2", x: 0.75, y: 0, w: 0.8, h: 0.85, shape: "roundrect", type: "smd" },
          ],
          courtyard: { minX: -1.5, minY: -0.7, maxX: 1.5, maxY: 0.7 },
          bodyW: 1.6, bodyH: 0.8,
        },
      };
    }
    return r;
  };

  const sneaky = footprints.resolveFootprint("Package_FAKE:ZZZ-11", "", ["1", "2", "3"], "U1");
  assert(sneaky.ok === true, "stub silent-fallback would break unmapped_package gate (proof)");
  (footprints as any).resolveFootprint = orig;

  // Silent pad invention must break pad_count_mismatch detection
  (footprints as any).resolveFootprint = (libId: string, value = "", pinNums: string[] = [], ref = "?") => {
    const r = orig(libId, value, pinNums, ref);
    if (!r.ok && r.reason === "pad_count_mismatch") {
      const base = orig(libId, value, pinNums.filter((n) => n !== "99"), ref);
      if (base.ok) {
        const pads = [
          ...base.geom.pads,
          ...pinNums.filter((n) => !base.geom.pads.some((p) => p.num === n)).map((num, i) => ({
            num, x: i, y: 5, w: 0.5, h: 0.5, shape: "roundrect" as const, type: "smd" as const,
          })),
        ];
        return { ok: true, geom: { ...base.geom, pads } };
      }
    }
    return r;
  };
  const invented = footprints.resolveFootprint("Package_TO_SOT_SMD:SOT-23", "", ["1", "2", "3", "99"], "Q1");
  assert(invented.ok === true, "stub pad-invention would break pad_count_mismatch gate (proof)");
  (footprints as any).resolveFootprint = orig;

  // Confirm real behavior restored
  const restored = footprints.resolveFootprint("Package_FAKE:ZZZ-11", "", ["1", "2", "3"], "U1");
  assert(restored.ok === false && restored.reason === "unmapped_package", "after revert: fake still unmapped");
  const restoredMismatch = footprints.resolveFootprint("Package_TO_SOT_SMD:SOT-23", "", ["1", "2", "3", "99"], "Q1");
  assert(restoredMismatch.ok === false && restoredMismatch.reason === "pad_count_mismatch", "after revert: pad_count_mismatch still hard-fails");
}

function main(): void {
  wipeOut();
  unitResolve();
  compileReports();
  exampleBoards();
  debtFile();
  stubSwapProofs();

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: footprint hard-fail / disclosure gates");
}

main();
