#!/usr/bin/env node
// layla CLI — schematic in, placed & routed board out, improving each iteration.
import * as fs from "fs";
import * as path from "path";
import {
  improve, synthOnce, defaultRuleset, scoreLayout,
  writeBoard, renderBoardSVG, renderHeatmapSVG, renderLearningCurveSVG,
  renderOscillatorSVG, renderEmiFieldSVG, validateEmiProgressive, verifyLvs, checkClearance,
  parseSchematic, RNG, Ruleset, BoardSpec, Design, ImproveResult, Optimizer,
  compileDesign, isUnresolvedFootprintError,
  improveWithLoadedRuleset,
} from "./core";

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const nx = argv[i + 1];
      if (nx && !nx.startsWith("--")) { flags[key] = nx; i++; }
      else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function loadConfig(schPath: string, configFlag?: string): Partial<BoardSpec> & { description?: string } {
  let cfgPath = configFlag;
  if (!cfgPath) {
    const guess = path.join(path.dirname(schPath), "layla.json");
    if (fs.existsSync(guess)) cfgPath = guess;
  }
  if (cfgPath && fs.existsSync(String(cfgPath))) {
    const raw = JSON.parse(fs.readFileSync(String(cfgPath), "utf8"));
    const b = raw.board || raw;
    return { name: raw.name, width: b.width, height: b.height, diffPairs: b.diffPairs || [], description: raw.description };
  }
  return {};
}

function designFor(schPath: string, configFlag?: string, outDir?: string): Design {
  const text = fs.readFileSync(schPath, "utf8");
  const cfg = loadConfig(schPath, configFlag);
  const name = cfg.name || path.basename(schPath).replace(/\.kicad_sch$/, "");
  const dir = outDir || path.join(process.cwd(), "build");
  try {
    const { design, reportPath } = compileDesign(text, { ...cfg, name }, dir);
    console.log(C.dim(`  footprint report → ${reportPath}`));
    return design;
  } catch (e) {
    if (isUnresolvedFootprintError(e)) {
      const rp = e.reportPath || path.join(dir, `${name}.footprint-report.json`);
      console.error(C.red(`\nUnresolved footprint(s) — aborting before place/route.`));
      console.error(C.red(`  rejection report → ${rp}`));
      for (const ent of e.entries) {
        console.error(C.red(`  • ${ent.ref}  ${ent.package}  ${ent.reason}${ent.detail ? " — " + ent.detail : ""}`));
        if (ent.nets.length) console.error(C.dim(`      nets: ${ent.nets.join(", ")}`));
      }
      process.exit(1);
    }
    const rp = path.join(dir, `${name}.footprint-report.json`);
    console.error(C.red(`Design compile failed — see ${rp}`));
    throw e;
  }
}

function cmdInspect(schPath: string) {
  const text = fs.readFileSync(schPath, "utf8");
  const raw = parseSchematic(text);
  console.log(C.bold(`\nSchematic: ${schPath}`));
  console.log(`  components: ${raw.components.length}   nets: ${raw.nets.length}`);
  const design = designFor(schPath);
  console.log(C.bold("\n  Components:"));
  for (const c of design.components) {
    console.log(`    ${c.ref.padEnd(5)} ${C.dim((c.value || "").padEnd(12))} ${C.cyan(c.role.padEnd(14))} ${c.libId}`);
  }
  console.log(C.bold("\n  Clusters (detected topology):"));
  for (const cl of design.clusters) {
    console.log(`    ${C.yellow(cl.kind.padEnd(16))} ${cl.refs.join(", ")}`);
  }
  console.log(C.bold("\n  Nets:"));
  for (const n of design.nets.slice(0, 40)) {
    console.log(`    ${n.name.padEnd(12)} ${C.dim(n.classes.join(","))}  ${n.pins.length} pins`);
  }
}

function scoreTable(label: string, s: ReturnType<typeof scoreLayout>): string {
  const f = s.field;
  return [
    `  ${C.bold(label)}`,
    `    total score        ${s.total.toFixed(1)}`,
    `    drc errors         ${s.drcErrors}`,
    `    ratsnest length    ${s.ratsnestLen.toFixed(0)} mm`,
    `    route completion   ${(s.routeCompletion * 100).toFixed(0)} %`,
    `    switch loop area   ${s.switchLoopArea.toFixed(0)} mm²`,
    `    coupling risk      ${f.coupling.toFixed(2)}`,
    `    antenna risk       ${f.antenna.toFixed(2)}`,
    `    thermal risk       ${f.thermal.toFixed(2)}`,
  ].join("\n");
}

function writeOutputs(outDir: string, name: string, design: Design, res: ImproveResult) {
  fs.mkdirSync(outDir, { recursive: true });
  const best: any = res.best;
  const board = writeBoard(design, res.best.layout);
  fs.writeFileSync(path.join(outDir, `${name}.kicad_pcb`), board);
  fs.writeFileSync(path.join(outDir, `${name}.board.svg`), renderBoardSVG(design, res.best.layout, { title: name }));
  fs.writeFileSync(path.join(outDir, `${name}.heatmap.svg`), renderHeatmapSVG(design, res.best.layout, res.best.score));
  fs.writeFileSync(path.join(outDir, `${name}.curve.svg`), renderLearningCurveSVG(res.history));
  fs.writeFileSync(path.join(outDir, `${name}.rules.json`), JSON.stringify(res.ruleset, null, 2));
  if (best.viz) fs.writeFileSync(path.join(outDir, `${name}.oscillator.svg`), renderOscillatorSVG(best.viz));
  // independent EMI validation pass on the final layout
  const emi = best.emi ?? validateEmiProgressive(design, res.best.layout);
  fs.writeFileSync(path.join(outDir, `${name}.emi.svg`), renderEmiFieldSVG(design, res.best.layout, emi));
  // LVS-equivalent connectivity check: re-derives connectivity from the
  // *emitted* board text (not from Design/Layout) and diffs it against the
  // schematic. Assistive signal only — does not affect CLI exit code; a
  // human/automated review gate downstream (OpenForge's review queue) reads
  // report.json.lvs.clean. See src/core/lvs.ts for the report shape.
  const lvs = verifyLvs(design, board);
  if (!lvs.clean) {
    console.log(C.red(`  LVS: connectivity mismatch — missing=${lvs.missing.length} extra=${lvs.extra.length} netMismatch=${lvs.netMismatch.length} (see ${name}.report.json.lvs)`));
  }
  // Copper clearance DRC: exact minimum-spacing check between different-net
  // pads/segments/vias (see src/core/drc.ts). Final report path — same
  // checkClearance used by the in-loop promotion gate. Score.drcErrors also
  // includes a cheaper broad-phase AABB count (plus courtyard/offboard).
  // Assistive for CLI exit code: does not fail the process on violations.
  const drc = checkClearance(design, res.best.layout);
  if (!drc.clean) {
    console.log(C.red(`  DRC: ${drc.violations.length} clearance violation(s) below ${drc.requiredClearanceMm}mm (see ${name}.report.json.drc)`));
  }
  const report: Record<string, unknown> = {
    name, components: design.components.length, nets: design.nets.length,
    iterations: res.history.length,
    optimizer: res.ruleset.substrate ? "oscillator" : "anneal",
    substrateVersion: res.ruleset.substrate?.version,
    initialScore: res.history[0]?.rawScore, finalScore: res.best.score.total,
    improvementPct: res.history[0] ? Math.round((1 - res.best.score.total / res.history[0].rawScore) * 100) : 0,
    score: res.best.score, history: res.history,
    emi: { model: emi.model, converged: emi.converged, convergenceDeltaPct: emi.convergenceDeltaPct, levels: emi.levels, sensitiveProbeMax: emi.sensitiveProbeMax, verdict: emi.verdict, riskByProbe: emi.riskByProbe },
    lvs,
    drc,
    substrate: res.ruleset.substrate,
    learnedRules: res.ruleset.rules.filter((r) => r.status === "promoted").map((r) => r.name),
  };
  if (res.feedbackScopeNotice) {
    report.feedbackScopeNotice = res.feedbackScopeNotice;
  }
  if (res.provenanceNotice) {
    report.provenanceNotice = res.provenanceNotice;
  }
  if (res.transferRace) {
    report.transferRace = res.transferRace;
  }
  if (res.ruleset.provenance) {
    report.provenance = res.ruleset.provenance;
  }
  fs.writeFileSync(path.join(outDir, `${name}.report.json`), JSON.stringify(report, null, 2));
  return report;
}

function printTransferRace(res: ImproveResult): void {
  const tr = res.transferRace;
  if (!tr) return;
  if (res.provenanceNotice) {
    console.log(C.yellow(`\n  ${res.provenanceNotice}`));
  }
  if (!tr.triggered) {
    if (tr.reason === "same_board") {
      console.log(C.dim(`  provenance: same board as ruleset (${tr.sourceBoardLabel}) — continuation, no transfer race`));
    }
    return;
  }
  console.log(C.bold("\n  transfer race (cross-board provenance mismatch)"));
  console.log(C.dim(`  source: ${tr.sourceBoardLabel} → target: ${tr.targetBoardLabel}`));
  console.log(`  cold (default substrate):  ${tr.coldScore!.toFixed(1)}`);
  console.log(`  warm (transferred):        ${tr.warmScore!.toFixed(1)}`);
  console.log(
    `  winner: ${C.cyan(tr.winner!)}  ` +
    `(Δ ${tr.delta! <= 0 ? C.green(tr.delta!.toFixed(1)) : C.red("+" + tr.delta!.toFixed(1))} vs loser)`,
  );
}

function optimizerFlags(flags: Record<string, string | boolean>): { optimizer: Optimizer; emiValidate: boolean } {
  const optimizer: Optimizer = (flags.optimizer === "anneal") ? "anneal" : "oscillator";
  return { optimizer, emiValidate: flags.emi === true || flags.emi === "true" };
}

function printImprovement(res: ImproveResult) {
  console.log(C.bold("\n  iter   raw     best    drc  switchLoop  coupling  notes"));
  for (const h of res.history) {
    const note = h.promoted.length ? C.green(h.note) : C.dim(h.note);
    console.log(
      `   ${String(h.iter).padStart(2)}   ${String(h.rawScore).padStart(6)}  ${C.cyan(String(h.bestScore).padStart(6))}` +
      `   ${String(h.drcErrors).padStart(2)}    ${String(h.switchLoopArea).padStart(7)}    ${String(h.coupling).padStart(5)}   ${note}`,
    );
  }
}

function cmdSynth(schPath: string, flags: Record<string, string | boolean>) {
  const schText = fs.readFileSync(schPath, "utf8");
  const design = designFor(schPath, flags.config as string);
  const name = design.name;
  console.log(C.bold(`\nlayla synth: ${name}`));
  console.log(`  ${design.components.length} components, ${design.nets.length} nets, ${design.clusters.length} clusters detected`);

  let loadedRuleset: Ruleset | undefined;
  if (flags.rules && fs.existsSync(String(flags.rules))) {
    loadedRuleset = JSON.parse(fs.readFileSync(String(flags.rules), "utf8"));
    if (loadedRuleset && "weights" in loadedRuleset) delete (loadedRuleset as any).weights;
    const nRules = loadedRuleset!.rules?.length ?? 0;
    const hasSub = !!loadedRuleset!.substrate;
    console.log(C.dim(
      hasSub && nRules
        ? `  loaded ruleset from ${flags.rules} (${nRules} symbolic rule(s) for anneal; substrate v${loadedRuleset!.substrate?.version} for oscillator)`
        : hasSub
          ? `  loaded oscillator substrate v${loadedRuleset!.substrate?.version} from ${flags.rules}`
          : `  loaded ${nRules} symbolic rule(s) from ${flags.rules} (anneal constraints)`,
    ));
  }
  const iterations = flags.iterations ? parseInt(String(flags.iterations)) : 8;
  const { optimizer, emiValidate } = optimizerFlags(flags);
  console.log(C.dim(`  optimizer: ${optimizer === "oscillator" ? "coupled-oscillator (Kuramoto) substrate" : "simulated annealing"}${emiValidate ? " + EMI-gated" : ""}`));
  const res = improveWithLoadedRuleset(design, {
    schematicText: schText,
    boardLabel: name,
    loadedRuleset,
    iterations,
    optimizer,
    emiValidate,
    feedback: flags.feedback ? String(flags.feedback) : undefined,
    seed: flags.seed ? parseInt(String(flags.seed)) : 1337,
  });
  if (res.feedbackScopeNotice) {
    console.log(C.yellow(`\n  ${res.feedbackScopeNotice}`));
  }
  printTransferRace(res);
  printImprovement(res);
  console.log("\n" + scoreTable("final", res.best.score));
  if (res.best.score.hotspots.length) {
    console.log(C.bold("\n  remaining hotspots:"));
    for (const h of res.best.score.hotspots.slice(0, 5)) {
      console.log(`    ${C.red("•")} ${h.message}  ${C.dim("→ " + h.suggestedAction)}`);
    }
  }
  const outDir = flags.out ? path.dirname(String(flags.out)) : path.join(process.cwd(), "build");
  const report = writeOutputs(outDir, name, design, res);
  if (flags.out) {
    fs.writeFileSync(String(flags.out), writeBoard(design, res.best.layout));
  }
  console.log(C.green(`\n  improved ${report.improvementPct}%  (${report.initialScore} → ${(report.finalScore as number).toFixed(1)})`));
  if (report.substrateVersion) console.log(C.cyan(`  oscillator substrate evolved to v${report.substrateVersion}`));
  console.log(C.dim(`  EMI validation: ${(report.emi as any).verdict} (${(report.emi as any).convergenceDeltaPct.toFixed(1)}% Δ across refinement; hottest victim ${(report.emi as any).sensitiveProbeMax || "n/a"})`));
  console.log(C.dim(`  outputs → ${outDir}/${name}.{kicad_pcb,board.svg,heatmap.svg,oscillator.svg,emi.svg,curve.svg,report.json,rules.json}`));
  const learned = report.learnedRules as string[];
  if (learned.length && !res.feedbackScopeNotice) {
    console.log(C.green(`  learned rules (anneal constraints): ${learned.join(", ")}`));
  }
}

function cmdDemo(flags: Record<string, string | boolean>) {
  const exDir = path.join(__dirname, "..", "examples");
  const indexPath = path.join(exDir, "index.json");
  if (!fs.existsSync(indexPath)) {
    console.log(C.red("No examples found. Run `npm run gen-examples` first."));
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const outDir = path.join(process.cwd(), "build");
  console.log(C.bold("\n=== layla demo: self-improving PCB layout ===\n"));
  for (const ex of index) {
    const schPath = path.join(exDir, ex.schematic);
    const schText = fs.readFileSync(schPath, "utf8");
    const design = designFor(schPath, path.join(exDir, ex.config));
    console.log(C.bold(`\n▶ ${ex.title}  (${ex.name})`));
    const res = improveWithLoadedRuleset(design, {
      schematicText: schText,
      boardLabel: ex.name,
      iterations: flags.iterations ? parseInt(String(flags.iterations)) : 7,
      optimizer: "oscillator",
      emiValidate: true,
    });
    printImprovement(res);
    const report = writeOutputs(outDir, ex.name, design, res);
    console.log(C.green(`  ${report.initialScore} → ${(report.finalScore as number).toFixed(1)}  (improved ${report.improvementPct}%)`) +
      C.cyan(`  [oscillator substrate v${report.substrateVersion}]`));
  }
  // transfer demo: evolve substrate on buck_imu, then auto-race cold vs warm
  // on motor_driver via provenance mismatch (no extra flag).
  console.log(C.bold("\n▶ transfer: the oscillator substrate evolved on buck_imu → motor_driver (auto cold/warm race)"));
  const buckSchPath = path.join(exDir, "buck_imu/buck_imu.kicad_sch");
  const motorSchPath = path.join(exDir, "motor_driver/motor_driver.kicad_sch");
  const buckSch = fs.readFileSync(buckSchPath, "utf8");
  const motorSch = fs.readFileSync(motorSchPath, "utf8");
  const buck = designFor(buckSchPath, path.join(exDir, "buck_imu/layla.json"));
  const buckRes = improveWithLoadedRuleset(buck, {
    schematicText: buckSch,
    boardLabel: "buck_imu",
    iterations: 7,
    optimizer: "oscillator",
    feedback: "keep the buck hot loop tight and away from the imu",
  });
  if (buckRes.feedbackScopeNotice) {
    console.log(C.yellow(`  ${buckRes.feedbackScopeNotice}`));
  }
  const motor = designFor(motorSchPath, path.join(exDir, "motor_driver/layla.json"));
  const budget = 2; // small budget for the demo stage
  // Substrate only — keep buck provenance so motor load detects cross-board transfer.
  const transferred: Ruleset = {
    rules: [],
    version: buckRes.ruleset.version,
    substrate: buckRes.ruleset.substrate,
    provenance: buckRes.ruleset.provenance,
  };
  const raced = improveWithLoadedRuleset(motor, {
    schematicText: motorSch,
    boardLabel: "motor_driver",
    loadedRuleset: transferred,
    iterations: budget,
    optimizer: "oscillator",
    seed: 7,
  });
  console.log(C.dim(`  (carried: oscillator substrate v${buckRes.ruleset.substrate?.version} — symbolic rules are anneal-only and are not part of this transfer)`));
  printTransferRace(raced);
  if (raced.transferRace?.triggered) {
    const tr = raced.transferRace;
    console.log(`  kept ${tr.winner} lineage @ ${raced.best.score.total.toFixed(1)} (substrate v${raced.ruleset.substrate?.version})`);
  }
  writeOutputs(outDir, "transfer_motor_driver", motor, raced);
  console.log(C.dim(`\n  all outputs in ${outDir}/`));
}

function cmdBatch(target: string, flags: Record<string, string | boolean>) {
  const files: string[] = [];
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (stat?.isDirectory()) {
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d)) {
        const p = path.join(d, e);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".kicad_sch")) files.push(p);
      }
    };
    walk(target);
  } else if (target.endsWith(".kicad_sch")) files.push(target);
  if (!files.length) { console.log(C.red("no .kicad_sch files found")); process.exit(1); }
  console.log(C.bold(`\nlayla batch: ${files.length} schematic(s)`));
  const outRoot = flags.out ? String(flags.out) : path.join(process.cwd(), "build");
  const summary: any[] = [];
  for (const f of files) {
    const schText = fs.readFileSync(f, "utf8");
    const design = designFor(f);
    const { optimizer, emiValidate } = optimizerFlags(flags);
    const res = improveWithLoadedRuleset(design, {
      schematicText: schText,
      boardLabel: design.name,
      iterations: flags.iterations ? parseInt(String(flags.iterations)) : 8,
      seed: flags.seed ? parseInt(String(flags.seed)) : 1337,
      optimizer, emiValidate,
    });
    const report = writeOutputs(outRoot, design.name, design, res);
    summary.push({ name: design.name, initial: report.initialScore, final: report.finalScore, improved: report.improvementPct });
    console.log(`  ${design.name.padEnd(18)} ${String(report.initialScore).padStart(7)} → ${C.cyan(String((report.finalScore as number).toFixed(1)).padStart(7))}  (${C.green(report.improvementPct + "%")})`);
  }
  fs.writeFileSync(path.join(outRoot, "batch-summary.json"), JSON.stringify(summary, null, 2));
  console.log(C.dim(`\n  summary → ${outRoot}/batch-summary.json`));
}

function cmdLearn(schPath: string, flags: Record<string, string | boolean>) {
  const schText = fs.readFileSync(schPath, "utf8");
  const design = designFor(schPath, flags.config as string);
  const feedback = String(flags.feedback || "");
  if (!feedback) { console.log(C.red("--feedback \"...\" required")); process.exit(1); }
  let loadedRuleset: Ruleset | undefined;
  if (flags.rules && fs.existsSync(String(flags.rules))) {
    loadedRuleset = JSON.parse(fs.readFileSync(String(flags.rules), "utf8"));
    if (loadedRuleset && "weights" in loadedRuleset) delete (loadedRuleset as any).weights;
  }
  // Symbolic --feedback is an anneal search-space channel.
  const res = improveWithLoadedRuleset(design, {
    schematicText: schText,
    boardLabel: design.name,
    loadedRuleset,
    iterations: 4,
    feedback,
    optimizer: "anneal",
  });
  if (res.provenanceNotice) console.log(C.yellow(`  ${res.provenanceNotice}`));
  printTransferRace(res);
  const outRules = String(flags.out || flags.rules || "rules.json");
  fs.writeFileSync(outRules, JSON.stringify(res.ruleset, null, 2));
  console.log(C.green(`\n  feedback compiled into ${res.ruleset.rules.length} anneal rule(s) → ${outRules}`));
  for (const r of res.ruleset.rules) console.log(`    ${C.cyan(r.name)}  ${C.dim(r.origin)}`);
}

function cmdBench(flags: Record<string, string | boolean>) {
  const exDir = path.join(__dirname, "..", "examples");
  const index = JSON.parse(fs.readFileSync(path.join(exDir, "index.json"), "utf8"));
  const iters = flags.iterations ? parseInt(String(flags.iterations)) : 8;
  console.log(C.bold("\n=== layla bench: coupled-oscillator substrate vs simulated annealing ===\n"));
  console.log(C.bold("  board              anneal     oscillator   Δ      substrate"));
  for (const ex of index) {
    const design = designFor(path.join(exDir, ex.schematic), path.join(exDir, ex.config));
    const t0 = Date.now();
    const ann = improve(design, { iterations: iters, optimizer: "anneal" });
    const t1 = Date.now();
    const osc = improve(design, { iterations: iters, optimizer: "oscillator" });
    const t2 = Date.now();
    const a = ann.best.score.total, o = osc.best.score.total;
    const delta = Math.round((1 - o / a) * 100);
    console.log(
      `  ${ex.name.padEnd(18)} ${a.toFixed(1).padStart(7)}    ${C.cyan(o.toFixed(1).padStart(7))}   ` +
      `${(delta >= 0 ? C.green : C.red)((delta >= 0 ? "-" : "+") + Math.abs(delta) + "%").padStart(5)}   v${osc.ruleset.substrate?.version}  ` +
      C.dim(`(${t1 - t0}ms / ${t2 - t1}ms)`),
    );
  }
  console.log(C.dim("\n  lower score = better. the oscillator substrate compiles netlist adjacency into\n  synchronizing couplings; the synchronized phase field decodes to a placement."));
}

function help() {
  console.log(`
${C.bold("layla")} — a self-improving PCB layout compiler (schematic → board)

${C.bold("Usage:")}
  layla inspect <board.kicad_sch>
  layla synth   <board.kicad_sch> [--optimizer oscillator|anneal] [--emi]
                                          [--out out.kicad_pcb] [--iterations N] [--seed N]
                                          [--rules rules.json] [--feedback "..."] [--config cfg.json]
  layla learn   <board.kicad_sch> --feedback "keep buck away from imu" [--out rules.json]
  layla batch   <dir|file>        [--optimizer oscillator|anneal] [--emi]
                                          [--iterations N] [--seed N] [--out build/]
  layla demo                       [--iterations N]
  layla bench                      [--iterations N]   # oscillator vs annealing

${C.bold("Flags:")}
  --optimizer oscillator|anneal   default: oscillator (coupled-oscillator Kuramoto substrate)
  --emi                           run the progressive voxel damped-wave EMI validation + gate on it
  --iterations N                  self-improvement iterations (default 8)
  --seed N                        deterministic RNG seed (default 1337)
  --rules f.json                  load/reuse a ruleset; cross-board provenance mismatch auto-races cold vs warm
  --feedback "..."                natural-language EE guidance → symbolic anneal rules (notice-only under oscillator)
  --config f.json                 board outline / diff-pairs config (else <sch-dir>/layla.json)

${C.dim("Outputs per board: .kicad_pcb, .board.svg, .heatmap.svg, .oscillator.svg, .emi.svg, .curve.svg, .report.json, .footprint-report.json, .rules.json")}
`);
}

function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  try {
    switch (cmd) {
      case "inspect": cmdInspect(_[1]); break;
      case "synth": cmdSynth(_[1], flags); break;
      case "learn": cmdLearn(_[1], flags); break;
      case "batch": cmdBatch(_[1], flags); break;
      case "demo": cmdDemo(flags); break;
      case "bench": cmdBench(flags); break;
      case undefined: case "help": case "--help": help(); break;
      default: console.log(C.red(`unknown command: ${cmd}`)); help(); process.exit(1);
    }
  } catch (e: any) {
    console.error(C.red("error: " + (e?.message || e)));
    if (flags.debug) console.error(e?.stack);
    process.exit(1);
  }
}

main();
