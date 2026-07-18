// One-off data collection (not part of src/). Evolves buck_imu substrate once
// exactly as cmdDemo's transfer stage does, freezes it, then sweeps motor_driver
// cold vs warm across fixed seeds.
"use strict";

const fs = require("fs");
const path = require("path");
const {
  compileDesign, improve, defaultSubstrate, cloneRuleset,
} = require("./dist/core");

const ROOT = __dirname;
const EX = path.join(ROOT, "examples");
const OUT_JSON = path.join(ROOT, "transfer-regression-h1.json");
const OUT_MD = path.join(ROOT, "transfer-regression-h1.md");

const SEEDS = [7, 11, 23, 42, 101, 256, 512, 777, 1337, 2026];
const MOTOR_ITERS = 8; // default improve() iterations
const BUCK_EVOLVE_ITERS = 7; // cmdDemo transfer evolve step
const BUCK_FEEDBACK = "keep the buck hot loop tight and away from the imu";

function loadDesign(name) {
  const sch = fs.readFileSync(path.join(EX, name, `${name}.kicad_sch`), "utf8");
  const cfg = JSON.parse(fs.readFileSync(path.join(EX, name, "layla.json"), "utf8"));
  const out = path.join(ROOT, "build", "transfer-regression-h1");
  fs.mkdirSync(out, { recursive: true });
  return compileDesign(sch, {
    name,
    width: cfg.board.width,
    height: cfg.board.height,
    diffPairs: cfg.board.diffPairs || [],
  }, out).design;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs) {
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length; // population
  return Math.sqrt(v);
}

function main() {
  console.log("=== transfer-regression-h1 data collection ===\n");
  console.log(`seeds: ${SEEDS.join(", ")}`);
  console.log(`motor_driver iterations: ${MOTOR_ITERS} (default)`);
  console.log(`optimizer: oscillator; emi: off`);
  console.log(`buck evolve: iterations=${BUCK_EVOLVE_ITERS}, seed=default(1337), feedback as cmdDemo\n`);

  const buck = loadDesign("buck_imu");
  const motor = loadDesign("motor_driver");

  console.log("Evolving buck_imu substrate once (cmdDemo transfer artifact)...");
  const buckRes = improve(buck, {
    iterations: BUCK_EVOLVE_ITERS,
    optimizer: "oscillator",
    feedback: BUCK_FEEDBACK,
    // seed omitted → improve() default 1337, same as cmdDemo
  });
  const evolvedSubstrate = JSON.parse(JSON.stringify(buckRes.ruleset.substrate));
  console.log(`  frozen substrate version: v${evolvedSubstrate.version}`);
  console.log(`  buck best score: ${buckRes.best.score.total.toFixed(3)}`);
  const { defaultSubstrate } = require("./dist/core");
  const isPhantom = JSON.stringify(evolvedSubstrate) === JSON.stringify(defaultSubstrate());
  console.log(`  deep-equal to defaultSubstrate: ${isPhantom}`);
  if (isPhantom) {
    console.error("FATAL: evolved substrate still phantom (=== default); aborting H1");
    process.exit(1);
  }
  console.log("");

  // Reference: cmdDemo transfer pair (seed 7, budget 2) for number confirmation
  console.log("Reference cmdDemo transfer pair (seed=7, iterations=2)...");
  const demoCold = improve(motor, { iterations: 2, optimizer: "oscillator", seed: 7 });
  const demoWarm = improve(motor, {
    iterations: 2,
    optimizer: "oscillator",
    seed: 7,
    ruleset: { rules: [], version: buckRes.ruleset.version, substrate: evolvedSubstrate },
  });
  console.log(`  demo-style cold: ${demoCold.best.score.total.toFixed(1)}`);
  console.log(`  demo-style warm: ${demoWarm.best.score.total.toFixed(1)}\n`);

  const rows = [];
  for (const seed of SEEDS) {
    process.stdout.write(`seed ${seed}: cold... `);
    const cold = improve(motor, {
      iterations: MOTOR_ITERS,
      optimizer: "oscillator",
      seed,
      // fresh default substrate each cold run
    });
    const coldScore = cold.best.score.total;
    process.stdout.write(`warm... `);
    const warm = improve(motor, {
      iterations: MOTOR_ITERS,
      optimizer: "oscillator",
      seed,
      ruleset: {
        rules: [],
        version: buckRes.ruleset.version,
        substrate: JSON.parse(JSON.stringify(evolvedSubstrate)), // identical object, deep copy
      },
    });
    const warmScore = warm.best.score.total;
    const delta = warmScore - coldScore;
    const deltaPct = (delta / coldScore) * 100;
    rows.push({ seed, cold_score: coldScore, warm_score: warmScore, delta, delta_pct: deltaPct });
    console.log(
      `cold=${coldScore.toFixed(3)} warm=${warmScore.toFixed(3)} Δ=${delta.toFixed(3)} (${deltaPct.toFixed(2)}%)`,
    );
  }

  const deltaPcts = rows.map((r) => r.delta_pct);
  const warmWorse = rows.filter((r) => r.warm_score > r.cold_score).length;
  const warmBetter = rows.filter((r) => r.warm_score < r.cold_score).length;
  const warmEqual = rows.filter((r) => r.warm_score === r.cold_score).length;

  const summary = {
    mean_delta_pct: mean(deltaPcts),
    stddev_delta_pct: stddev(deltaPcts),
    warm_worse_count: warmWorse,
    warm_better_count: warmBetter,
    warm_equal_count: warmEqual,
    n_seeds: SEEDS.length,
  };

  const payload = {
    protocol: {
      description:
        "Reuse one buck_imu-evolved substrate (cmdDemo transfer artifact); vary placement seed only on motor_driver.",
      seeds: SEEDS,
      motor_iterations: MOTOR_ITERS,
      optimizer: "oscillator",
      emi: false,
      buck_evolve: {
        iterations: BUCK_EVOLVE_ITERS,
        seed: 1337,
        feedback: BUCK_FEEDBACK,
        substrate_version: evolvedSubstrate.version,
        buck_best_score: buckRes.best.score.total,
      },
      cmdDemo_reference_pair: {
        note: "cmdDemo uses seed=7 and iterations=2 for cold/warm (not 1337/8)",
        seed: 7,
        iterations: 2,
        cold_score: demoCold.best.score.total,
        warm_score: demoWarm.best.score.total,
      },
      frozen_substrate: evolvedSubstrate,
    },
    rows,
    summary,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));

  const md = [];
  md.push("# transfer-regression-h1");
  md.push("");
  md.push("**Supersedes** the Prompt-7 phantom-substrate run (all deltas zero because");
  md.push("evolved === default). This run uses the post–owned-field-patch evolve artifact.");
  md.push("");
  md.push("Fixed buck_imu-evolved substrate (cmdDemo transfer artifact); motor_driver oscillator, no EMI, 8 iterations.");
  md.push("");
  md.push(`Seeds: \`${SEEDS.join(", ")}\``);
  md.push(`Frozen substrate version: \`v${evolvedSubstrate.version}\``);
  md.push(`Frozen ≠ defaultSubstrate: \`${!isPhantom}\``);
  md.push("");
  md.push("## cmdDemo reference pair (seed 7, 2 iters)");
  md.push("");
  md.push(`| cold | warm |`);
  md.push(`| --- | --- |`);
  md.push(`| ${demoCold.best.score.total.toFixed(1)} | ${demoWarm.best.score.total.toFixed(1)} |`);
  md.push("");
  md.push("## Seed sweep (8 iters)");
  md.push("");
  md.push("| seed | cold_score | warm_score | delta (warm − cold) | delta_pct |");
  md.push("| --- | ---: | ---: | ---: | ---: |");
  for (const r of rows) {
    md.push(
      `| ${r.seed} | ${r.cold_score.toFixed(3)} | ${r.warm_score.toFixed(3)} | ${r.delta.toFixed(3)} | ${r.delta_pct.toFixed(3)} |`,
    );
  }
  md.push("");
  md.push("## Summary");
  md.push("");
  md.push(`- mean_delta_pct: ${summary.mean_delta_pct.toFixed(6)}`);
  md.push(`- stddev_delta_pct: ${summary.stddev_delta_pct.toFixed(6)}`);
  md.push(`- warm_worse_count: ${summary.warm_worse_count}`);
  md.push(`- warm_better_count: ${summary.warm_better_count}`);
  if (warmEqual) md.push(`- warm_equal_count: ${warmEqual}`);
  md.push("");
  fs.writeFileSync(OUT_MD, md.join("\n"));

  console.log("\n=== table ===");
  console.log("seed\tcold_score\twarm_score\tdelta\tdelta_pct");
  for (const r of rows) {
    console.log(
      `${r.seed}\t${r.cold_score.toFixed(3)}\t${r.warm_score.toFixed(3)}\t${r.delta.toFixed(3)}\t${r.delta_pct.toFixed(3)}`,
    );
  }
  console.log("\n=== summary ===");
  console.log(`mean_delta_pct: ${summary.mean_delta_pct.toFixed(6)}`);
  console.log(`stddev_delta_pct: ${summary.stddev_delta_pct.toFixed(6)}`);
  console.log(`warm_worse_count: ${summary.warm_worse_count}`);
  console.log(`warm_better_count: ${summary.warm_better_count}`);
  if (warmEqual) console.log(`warm_equal_count: ${warmEqual}`);
  console.log(`\nwrote ${OUT_JSON}`);
  console.log(`wrote ${OUT_MD}`);
}

main();
