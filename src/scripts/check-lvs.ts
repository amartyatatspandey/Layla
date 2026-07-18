// Gate test for the LVS-equivalent connectivity check (src/core/lvs.ts).
//
// Part 1 (positive): every bundled example, run through the same pipeline
// the CLI uses, must come out lvs.clean === true (no connectivity loss).
// Part 2 (negative, the real test of this gate): deliberately corrupt one
// component's footprint — drop pads for pins it actually has, the exact
// failure mode LAYLA_AUDIT.md finding B described and prompt 1
// fixed — and assert the LVS pass sets clean: false and reports exactly the
// dropped (ref, pin) pairs as `missing`. A gate that only exercises part 1
// proves nothing on its own (a stub that always returns clean: true would
// pass it trivially); part 2 is what proves this module actually detects
// the bug class it exists to catch.
import * as fs from "fs";
import * as path from "path";
import { compileDesign, improve, writeBoard, verifyLvs, Design } from "../core";

const EX_DIR = path.join(__dirname, "..", "..", "examples");
const OUT = path.join(__dirname, "..", "..", "build", "gate-lvs");

function loadConfig(schPath: string): Record<string, unknown> {
  const cfgPath = path.join(path.dirname(schPath), "layla.json");
  if (!fs.existsSync(cfgPath)) return {};
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const b = raw.board || raw;
  return { name: raw.name, width: b.width, height: b.height, diffPairs: b.diffPairs || [] };
}

function loadDesign(name: string, schematic: string): Design {
  const schPath = path.join(EX_DIR, schematic);
  const text = fs.readFileSync(schPath, "utf8");
  const cfg = loadConfig(schPath) as any;
  return compileDesign(text, { ...cfg, name: cfg.name || name }, OUT).design;
}

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}

function positiveCase(): void {
  console.log("\n=== positive case: bundled examples must be lvs.clean ===");
  const index: { name: string; schematic: string; config: string }[] =
    JSON.parse(fs.readFileSync(path.join(EX_DIR, "index.json"), "utf8"));
  for (const ex of index) {
    const design = loadDesign(ex.name, ex.schematic);
    const res = improve(design, { iterations: 4, optimizer: "oscillator" });
    const pcbText = writeBoard(design, res.best.layout);
    const lvs = verifyLvs(design, pcbText);
    assert(
      lvs.clean,
      `${ex.name}: lvs.clean === true (missing=${lvs.missing.length} extra=${lvs.extra.length} netMismatch=${lvs.netMismatch.length})`,
    );
    if (!lvs.clean) {
      console.error("   ", JSON.stringify({ missing: lvs.missing, extra: lvs.extra, netMismatch: lvs.netMismatch }, null, 2));
    }
  }
}

function negativeCase(): void {
  console.log("\n=== negative case: manufactured regression must be caught ===");
  const design = loadDesign("motor_driver", "motor_driver/motor_driver.kicad_sch");

  // Simulate exactly the class of bug prompt 1 fixed: corrupt a component's
  // footprint down to 2 pads regardless of how many pins the schematic
  // actually declares for it (the pre-fix LQFP-48 fallback behavior).
  const victim = "U1";
  const before = design.footprints[victim].pads.length;
  const declaredPins = design.components.find((c) => c.ref === victim)!.pins.map((p) => p.num);
  const removedPins = declaredPins.filter((n) => !["1", "2"].includes(n));
  design.footprints[victim] = {
    ...design.footprints[victim],
    pads: design.footprints[victim].pads.filter((p) => ["1", "2"].includes(p.num)),
  };
  console.log(`  corrupted ${victim}: ${before} pads -> ${design.footprints[victim].pads.length} pads (dropped pins [${removedPins.join(",")}])`);

  const res = improve(design, { iterations: 4, optimizer: "oscillator" });
  const pcbText = writeBoard(design, res.best.layout);
  const lvs = verifyLvs(design, pcbText);

  assert(lvs.clean === false, "corrupted board must NOT report lvs.clean === true");
  const missingKeys = new Set(lvs.missing.filter((m) => m.ref === victim).map((m) => m.pin));
  const expectedKeys = new Set(removedPins);
  const matches = expectedKeys.size === missingKeys.size && [...expectedKeys].every((k) => missingKeys.has(k));
  assert(
    matches,
    `lvs.missing reports exactly the dropped pins for ${victim}: expected [${[...expectedKeys].join(",")}], got [${[...missingKeys].join(",")}]`,
  );
}

positiveCase();
negativeCase();

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: LVS gate (positive + negative) verified.");
