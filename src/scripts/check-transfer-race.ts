// Gate: provenance-based cold/warm transfer racing.
import * as fs from "fs";
import * as path from "path";
import {
  compileDesign, improveWithLoadedRuleset, schematicContentHash,
  stampProvenance, defaultSubstrate, LEGACY_PROVENANCE_NOTICE,
  compareRulesetProvenance,
} from "../core";
import { Ruleset } from "../core/types";

const ROOT = path.join(__dirname, "..", "..");
const EX = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "build", "gate-transfer-race");
const H1 = path.join(ROOT, "transfer-regression-h1.json");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}

function loadDesign(name: string) {
  const sch = fs.readFileSync(path.join(EX, name, `${name}.kicad_sch`), "utf8");
  const cfg = JSON.parse(fs.readFileSync(path.join(EX, name, "layla.json"), "utf8"));
  const design = compileDesign(sch, {
    name,
    width: cfg.board.width,
    height: cfg.board.height,
    diffPairs: cfg.board.diffPairs || [],
  }, OUT).design;
  return { design, sch };
}

function hashIsContentNotPath(): void {
  console.log("\n=== provenance hash is content-based (rename-safe) ===");
  const { sch } = loadDesign("buck_imu");
  const h1 = schematicContentHash(sch);
  const h2 = schematicContentHash(sch + ""); // same content
  const renamed = sch; // pretend rename — content identical
  assert(h1 === h2 && h1 === schematicContentHash(renamed), "identical content → identical hash");
  assert(h1 !== schematicContentHash(sch + "\n"), "content change → different hash");
  const motor = loadDesign("motor_driver");
  assert(h1 !== schematicContentHash(motor.sch), "buck_imu hash ≠ motor_driver hash");
}

function sameBoardNoRace(): void {
  console.log("\n=== same-board continuation: no race ===");
  const { design, sch } = loadDesign("motor_driver");
  // Short first pass to produce a provenance-stamped ruleset for this board.
  const first = improveWithLoadedRuleset(design, {
    schematicText: sch,
    boardLabel: "motor_driver",
    iterations: 1,
    optimizer: "oscillator",
    seed: 99,
    batch: 2,
    polish: 5,
  });
  assert(!!first.ruleset.provenance, "first write stamps provenance");
  assert(first.ruleset.provenance!.schematicHash === schematicContentHash(sch), "hash matches schematic");
  assert(first.transferRace?.reason === "no_loaded_ruleset", "no loaded ruleset → no race");

  let improveCalls = 0;
  // Second pass: load own ruleset — must not race (single improve inside).
  const t0 = Date.now();
  const cont = improveWithLoadedRuleset(design, {
    schematicText: sch,
    boardLabel: "motor_driver",
    loadedRuleset: first.ruleset,
    iterations: 1,
    optimizer: "oscillator",
    seed: 99,
    batch: 2,
    polish: 5,
  });
  const elapsed = Date.now() - t0;
  assert(cont.transferRace?.triggered === false, "same-board: race not triggered");
  assert(cont.transferRace?.reason === "same_board", "reason is same_board");
  assert(!cont.provenanceNotice, "no legacy notice on same-board");
  // Sanity: continuation finished (timing alone isn't proof of single pass, but
  // transferRace.triggered===false is the contract; also cold/warm scores absent).
  assert(cont.transferRace?.coldScore === undefined, "no coldScore when not racing");
  assert(cont.transferRace?.warmScore === undefined, "no warmScore when not racing");
  void improveCalls; void elapsed;
}

function legacyNoProvenance(): void {
  console.log("\n=== legacy ruleset: notice, no race ===");
  const { design, sch } = loadDesign("motor_driver");
  const legacy: Ruleset = {
    rules: [],
    version: 1,
    substrate: defaultSubstrate(),
    // no provenance
  };
  const res = improveWithLoadedRuleset(design, {
    schematicText: sch,
    boardLabel: "motor_driver",
    loadedRuleset: legacy,
    iterations: 1,
    optimizer: "oscillator",
    seed: 3,
    batch: 2,
    polish: 5,
  });
  assert(res.transferRace?.triggered === false, "legacy: race not triggered");
  assert(res.transferRace?.reason === "legacy_no_provenance", "reason legacy_no_provenance");
  assert(res.provenanceNotice === LEGACY_PROVENANCE_NOTICE, "CLI/report notice constant");
  assert(!!res.ruleset.provenance, "output ruleset gets target provenance stamped");
}

function crossBoardRaceTriggers(): void {
  console.log("\n=== cross-board transfer: race triggers ===");
  const buck = loadDesign("buck_imu");
  const motor = loadDesign("motor_driver");
  // Use H1 frozen v2 substrate with buck provenance (deterministic, matches investigation).
  const h1 = JSON.parse(fs.readFileSync(H1, "utf8"));
  const transferred: Ruleset = stampProvenance(
    {
      rules: [],
      version: 1,
      substrate: h1.protocol.frozen_substrate,
    },
    buck.sch,
    "buck_imu",
  );
  const cmp = compareRulesetProvenance(transferred, motor.sch, "motor_driver");
  assert(cmp.status === "mismatch", "precondition: provenance mismatch");

  const res = improveWithLoadedRuleset(motor.design, {
    schematicText: motor.sch,
    boardLabel: "motor_driver",
    loadedRuleset: transferred,
    iterations: 2,
    optimizer: "oscillator",
    seed: 7,
    batch: 4,
    polish: 20,
  });
  assert(res.transferRace?.triggered === true, "cross-board: race triggered");
  assert(res.transferRace?.reason === "cross_board", "reason cross_board");
  assert(typeof res.transferRace?.coldScore === "number", "reports coldScore");
  assert(typeof res.transferRace?.warmScore === "number", "reports warmScore");
  assert(res.transferRace?.winner === "cold" || res.transferRace?.winner === "warm", "reports winner");
  assert(typeof res.transferRace?.delta === "number", "reports delta");
  const winScore = res.transferRace!.winner === "cold"
    ? res.transferRace!.coldScore!
    : res.transferRace!.warmScore!;
  assert(Math.abs(winScore - res.best.score.total) < 1e-6, "kept winner's score as best");
  assert(res.ruleset.provenance?.schematicHash === schematicContentHash(motor.sch),
    "winner stamped with target (motor) provenance");
}

function seed42SelectsCold(): void {
  console.log("\n=== seed 42: race selects COLD over WARM (failure-case fix) ===");
  const buck = loadDesign("buck_imu");
  const motor = loadDesign("motor_driver");
  const h1 = JSON.parse(fs.readFileSync(H1, "utf8"));
  const transferred: Ruleset = stampProvenance(
    {
      rules: [],
      version: 1,
      substrate: h1.protocol.frozen_substrate,
    },
    buck.sch,
    "buck_imu",
  );
  const res = improveWithLoadedRuleset(motor.design, {
    schematicText: motor.sch,
    boardLabel: "motor_driver",
    loadedRuleset: transferred,
    iterations: 8,
    optimizer: "oscillator",
    seed: 42,
  });
  assert(res.transferRace?.triggered === true, "seed42: race triggered");
  const tr = res.transferRace!;
  console.log(`  cold=${tr.coldScore?.toFixed(1)} warm=${tr.warmScore?.toFixed(1)} winner=${tr.winner}`);
  assert(tr.winner === "cold", `winner is cold (got ${tr.winner})`);
  assert(tr.coldScore! < tr.warmScore!, "cold score < warm score");
  // Historical pre-inloop-DRC basins were ~624 vs ~837. Absolute totals rose
  // once broad copper clearance entered score.drcErrors (weight 20 unchanged);
  // hierarchy-mode metadata on stamped rulesets can also shift basins slightly.
  // The race invariant is ordering + a clear cold advantage, not those numbers.
  const gap = tr.warmScore! - tr.coldScore!;
  assert(gap > 100, `cold advantage still clear (warm−cold=${gap.toFixed(1)})`);
  assert(Math.abs(res.best.score.total - tr.coldScore!) < 1e-6, "result keeps cold lineage wholesale");
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(H1)) {
    console.error(`Missing ${H1} — run transfer-regression-h1 first`);
    process.exit(1);
  }
  hashIsContentNotPath();
  sameBoardNoRace();
  legacyNoProvenance();
  crossBoardRaceTriggers();
  seed42SelectsCold();
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\nPASS: transfer provenance race");
}

main();
