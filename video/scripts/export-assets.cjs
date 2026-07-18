/* Export REAL engine artifacts for the Remotion video.
   Everything here is repo-derived: it runs the actual layla core,
   then dumps geometry / phase data / EMI fields / score history as JSON,
   plus a consistent set of layer SVGs for the montage. No invented data. */
const fs = require("fs");
const path = require("path");
const core = require("../../dist/core");

const ROOT = path.join(__dirname, "..", "..");
const EX = path.join(ROOT, "examples");
const OUT_DATA = path.join(__dirname, "..", "public", "data");
const OUT_SVG = path.join(__dirname, "..", "public", "svg");
fs.mkdirSync(OUT_DATA, { recursive: true });
fs.mkdirSync(OUT_SVG, { recursive: true });

function designForExample(name) {
  const idx = JSON.parse(fs.readFileSync(path.join(EX, "index.json"), "utf8"));
  const ex = idx.find((e) => e.name === name);
  const cfg = JSON.parse(fs.readFileSync(path.join(EX, ex.config), "utf8"));
  const sch = fs.readFileSync(path.join(EX, ex.schematic), "utf8");
  const outDir = path.join(ROOT, "build");
  try {
    const { design, reportPath } = core.compileDesign(sch, {
      name,
      width: cfg.board.width,
      height: cfg.board.height,
      diffPairs: cfg.board.diffPairs || [],
    }, outDir);
    console.log(`  footprint report → ${reportPath}`);
    return design;
  } catch (e) {
    if (core.isUnresolvedFootprintError && core.isUnresolvedFootprintError(e)) {
      console.error(`Unresolved footprint(s) — aborting. Report: ${e.reportPath}`);
      process.exit(1);
    }
    console.error(`Design compile failed — see ${path.join(outDir, name + ".footprint-report.json")}`);
    throw e;
  }
}

function exportBoard(name, iterations) {
  console.log(`\n=== ${name} ===`);
  const design = designForExample(name);
  const res = core.improve(design, { iterations, optimizer: "oscillator", emiValidate: true });
  const best = res.best;

  // ---- layer SVGs (consistent framing from renderBoardSVG) ----
  const write = (suffix, svg) => fs.writeFileSync(path.join(OUT_SVG, `${name}.${suffix}.svg`), svg);
  write("pads", core.renderBoardSVG(design, best.layout, { showRatsnest: false, showRoutes: false }));
  write("rats", core.renderBoardSVG(design, best.layout, { showRatsnest: true, showRoutes: false }));
  write("routes", core.renderBoardSVG(design, best.layout, { showRatsnest: false, showRoutes: true }));
  write("board", core.renderBoardSVG(design, best.layout, { showRatsnest: true, showRoutes: true, title: name }));
  write("heatmap", core.renderHeatmapSVG(design, best.layout, best.score));
  write("curve", core.renderLearningCurveSVG(res.history));
  if (best.viz) write("oscillator", core.renderOscillatorSVG(best.viz));

  // ---- EMI: multi-scale descent — full board at 4mm/1mm, then ZOOM into the
  //      hottest region down to 10µm (real windowed damped-wave sims) ----
  const bW = design.board.width, bH = design.board.height;
  // locate hotspot from a full 1mm field (argmax)
  const probe = core.validateEmiProgressive(design, best.layout, { levels: [1] });
  const pf = probe.field;
  let pk = 0, pkc = 0;
  for (let i = 0; i < pf.data.length; i++) if (pf.data[i] > pk) { pk = pf.data[i]; pkc = i; }
  const hcx = ((pkc % pf.w) + 0.5) * pf.cellMm;
  const hcy = (Math.floor(pkc / pf.w) + 0.5) * pf.cellMm;
  const clampWin = (cx, cy, w, h) => ({
    x: Math.max(0, Math.min(bW - w, cx - w / 2)),
    y: Math.max(0, Math.min(bH - h, cy - h / 2)), w, h,
  });
  // descent: [cellMm, window|null]
  const descent = [
    [4, null], [1, null],
    [0.25, clampWin(hcx, hcy, 8, 8)],
    [0.05, clampWin(hcx, hcy, 2, 2)],
    [0.01, clampWin(hcx, hcy, 0.5, 0.5)],
  ];
  const emiLevels = [];
  for (const [cell, win] of descent) {
    const r = core.validateEmiProgressive(design, best.layout, win ? { levels: [cell], window: win } : { levels: [cell] });
    const f = r.field;
    emiLevels.push({
      cellMm: f.cellMm, w: f.w, h: f.h, data: f.data,
      risk: r.levels[0] ? r.levels[0].risk : 0,
      peak: r.levels[0] ? r.levels[0].peak : 0,
      win: win || null,
    });
  }
  const hotspot = { x: hcx, y: hcy };
  // full progressive run for the verdict + convergence + ranking
  const emiFull = core.validateEmiProgressive(design, best.layout);
  const emiSVG = core.renderEmiFieldSVG(design, best.layout, emiFull);
  write("emi", emiSVG);

  // ---- coupling graph + phase data (the oscillator substrate) ----
  const viz = best.viz;
  const graph = viz ? {
    substrateVersion: viz.substrateVersion,
    batch: viz.batch,
    steps: viz.steps,
    order: viz.order,
    orderX: viz.orderX,
    nodes: viz.nodes.map((n) => ({ ref: n.ref, role: n.role, thetaX: n.thetaX, thetaY: n.thetaY, x: n.x, y: n.y })),
    edges: viz.edges.map((e) => ({ i: e.i, j: e.j, k: e.k, kind: e.kind })),
  } : null;

  // ---- net classes (for the netlist-graph annotations) ----
  const nets = design.nets.map((n) => ({ name: n.name, classes: n.classes || [] }));

  const payload = {
    name,
    board: { width: design.board.width, height: design.board.height },
    components: design.components.length,
    nets: nets.length,
    netList: nets,
    clusters: design.clusters.map((c) => ({ kind: c.kind, refs: c.refs })),
    optimizer: "oscillator",
    substrateVersion: best.viz ? best.viz.substrateVersion : null,
    initialScore: res.history[0] ? res.history[0].rawScore : best.score.total,
    finalScore: best.score.total,
    improvementPct: Math.round((1 - best.score.total / (res.history[0] ? res.history[0].rawScore : best.score.total)) * 100),
    score: {
      total: best.score.total,
      drcErrors: best.score.drcErrors,
      switchLoopArea: best.score.switchLoopArea,
      routeCompletion: best.score.routeCompletion,
      field: best.score.field,
      hotspots: best.score.hotspots,
    },
    history: res.history.map((h) => ({
      iter: h.iter, rawScore: h.rawScore, bestScore: h.bestScore,
      drcErrors: h.drcErrors, switchLoopArea: h.switchLoopArea,
      coupling: h.coupling, note: h.note, promoted: h.promoted || [],
    })),
    graph,
    emi: {
      model: emiFull.model,
      converged: emiFull.converged,
      convergenceDeltaPct: emiFull.convergenceDeltaPct,
      verdict: emiFull.verdict,
      sensitiveProbeMax: emiFull.sensitiveProbeMax,
      riskByProbe: emiFull.riskByProbe,
      levels: emiLevels,
      hotspot,
      board: { width: bW, height: bH },
    },
    rules: res.ruleset.rules.map((r) => ({ name: r.name, kind: r.kind, origin: r.origin, status: r.status })),
  };
  fs.writeFileSync(path.join(OUT_DATA, `${name}.json`), JSON.stringify(payload));
  console.log(`  wrote ${name}.json  (${payload.components} comps, ${payload.nets} nets, ` +
    `graph ${graph ? graph.nodes.length + " nodes/" + graph.edges.length + " edges" : "none"}, ` +
    `emi levels ${emiLevels.map((l) => l.cellMm + "mm").join("/")}, ` +
    `${res.history.length} iters, ${payload.initialScore.toFixed(0)}→${payload.finalScore.toFixed(0)})`);
  return payload;
}

const main = exportBoard("mainboard", 5);
const robot = exportBoard("robot_soc", 12);
const buck = exportBoard("buck_imu", 8);
const motor = exportBoard("motor_driver", 8);
const rf = exportBoard("rf_sensor", 8);

// transfer demo numbers (buck-evolved substrate applied to motor board)
fs.writeFileSync(path.join(OUT_DATA, "summary.json"), JSON.stringify({
  boards: [
    { name: "buck_imu", title: "buck + IMU", initial: buck.initialScore, final: buck.finalScore, pct: buck.improvementPct, substrate: buck.substrateVersion },
    { name: "motor_driver", title: "BLDC motor driver", initial: motor.initialScore, final: motor.finalScore, pct: motor.improvementPct, substrate: motor.substrateVersion },
    { name: "rf_sensor", title: "BLE RF sensor", initial: rf.initialScore, final: rf.finalScore, pct: rf.improvementPct, substrate: rf.substrateVersion },
  ],
}));
console.log("\nwrote summary.json");
