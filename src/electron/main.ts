// Electron main process — bridges the renderer UI to the layla core.
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as fs from "fs";
import * as path from "path";
import {
  improve, scoreLayout, DEFAULT_WEIGHTS,
  writeBoard, renderBoardSVG, renderHeatmapSVG, renderLearningCurveSVG,
  renderOscillatorSVG, renderEmiFieldSVG, validateEmiProgressive,
  compileDesign, isUnresolvedFootprintError,
  Design, Layout, Ruleset, IterationRecord, Score, Optimizer,
} from "../core";

const APP_ROOT = path.join(__dirname, "..", "..");
const EX_DIR = path.join(APP_ROOT, "examples");
const BUILD_DIR = path.join(APP_ROOT, "build");

// remember last run per-window so we can save the board
let lastRun: { design: Design; layout: Layout; score: Score; ruleset: Ruleset; name: string } | null = null;

function createWindow() {
  const auto = !!process.env.FR_AUTOPILOT;
  const win = new BrowserWindow({
    width: auto ? 1920 : 1480,
    height: auto ? 1080 : 940,
    x: auto ? 0 : undefined,
    y: auto ? 0 : undefined,
    frame: !auto,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0b1020",
    title: "layla — self-improving PCB layout",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(APP_ROOT, "app", "index.html"));

  // Demo autopilot (env-gated): drives a real run + tab tour for screen capture.
  if (process.env.FR_AUTOPILOT) {
    win.webContents.on("did-finish-load", () => {
      win.webContents.executeJavaScript(AUTOPILOT).catch(() => {});
    });
  }
  return win;
}

const AUTOPILOT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  for (let i = 0; i < 80 && !q('.example-card'); i++) await sleep(100);
  await sleep(2600); // lead time for window maximize + recorder start
  const card = q('.example-card[data-name="robot_soc"]') || q('.example-card'); if (card) card.click();
  await sleep(700);
  // keep the live run snappy on the dense board: fewer iterations, EMI off here
  // (the EMI field is showcased separately). The complex board still renders live.
  const iters = document.getElementById('iterations');
  if (iters) { iters.value = '5'; iters.dispatchEvent(new Event('input', { bubbles: true })); }
  const emi = document.getElementById('emi'); if (emi && emi.checked) emi.click();
  await sleep(400);
  const run = document.getElementById('btn-run'); if (run) run.click();
  const state = document.getElementById('run-state');
  for (let i = 0; i < 600 && (!state || state.textContent.trim() !== 'done'); i++) await sleep(100);
  await sleep(700);
  const tab = (n) => { const t = q('.tab[data-tab="' + n + '"]'); if (t) t.click(); };
  tab('oscillator'); await sleep(2600);
  tab('curve'); await sleep(2400);
  tab('heatmap'); await sleep(2200);
  tab('board'); await sleep(2000);
})();`;

function loadExamples(): any[] {
  const idx = path.join(EX_DIR, "index.json");
  if (!fs.existsSync(idx)) return [];
  return JSON.parse(fs.readFileSync(idx, "utf8"));
}

function designForExample(name: string): Design {
  const ex = loadExamples().find((e) => e.name === name);
  if (!ex) throw new Error("unknown example: " + name);
  const schPath = path.join(EX_DIR, ex.schematic);
  const cfg = JSON.parse(fs.readFileSync(path.join(EX_DIR, ex.config), "utf8"));
  const { design } = compileDesign(fs.readFileSync(schPath, "utf8"), {
    name, width: cfg.board.width, height: cfg.board.height, diffPairs: cfg.board.diffPairs || [],
  }, BUILD_DIR);
  return design;
}

ipcMain.handle("examples:list", async () => loadExamples());

ipcMain.handle("schematic:open", async () => {
  const r = await dialog.showOpenDialog({ filters: [{ name: "KiCad schematic", extensions: ["kicad_sch"] }], properties: ["openFile"] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

// Run the self-improvement loop, streaming each iteration's render to the UI.
ipcMain.handle("synth:run", async (evt, opts: { example?: string; schPath?: string; iterations?: number; feedback?: string; useRules?: boolean; optimizer?: Optimizer; emi?: boolean }) => {
  const sender = evt.sender;
  let design: Design;
  let name: string;
  try {
    if (opts.example) { design = designForExample(opts.example); name = opts.example; }
    else if (opts.schPath) {
      name = path.basename(opts.schPath).replace(/\.kicad_sch$/, "");
      const { design: d } = compileDesign(fs.readFileSync(opts.schPath, "utf8"), { name }, BUILD_DIR);
      design = d;
    } else throw new Error("no input");
  } catch (e: any) {
    if (isUnresolvedFootprintError(e)) {
      return {
        error: "unresolved_footprint",
        message: e.message,
        reportPath: e.reportPath || path.join(BUILD_DIR, `${opts.example || "board"}.footprint-report.json`),
        entries: e.entries,
      };
    }
    const nm = opts.example || (opts.schPath ? path.basename(opts.schPath).replace(/\.kicad_sch$/, "") : "board");
    return {
      error: "compile_failed",
      message: e?.message || String(e),
      reportPath: path.join(BUILD_DIR, `${nm}.footprint-report.json`),
    };
  }

  // optionally reuse last run's learned rules (transfer)
  const ruleset: Ruleset | undefined = (opts.useRules && lastRun) ? lastRun.ruleset : undefined;

  const optimizer: Optimizer = opts.optimizer ?? "oscillator";
  const emiOn = opts.emi ?? true;

  // Collect render frames during the (synchronous) loop, then animate them.
  const frames: { rec: IterationRecord; boardSVG: string; heatmapSVG: string; oscillatorSVG: string; emiSVG: string; substrateVersion?: number }[] = [];
  const res = improve(design, {
    iterations: opts.iterations ?? 7,
    feedback: opts.feedback,
    ruleset, optimizer, emiValidate: emiOn,
    onIteration: (rec, best: any) => {
      const emi = best.emi ?? (emiOn ? validateEmiProgressive(design, best.layout) : undefined);
      frames.push({
        rec,
        boardSVG: renderBoardSVG(design, best.layout, { title: name }),
        heatmapSVG: renderHeatmapSVG(design, best.layout, best.score),
        oscillatorSVG: best.viz ? renderOscillatorSVG(best.viz) : "",
        emiSVG: emi ? renderEmiFieldSVG(design, best.layout, emi) : "",
        substrateVersion: best.viz?.substrateVersion,
      });
    },
  });

  lastRun = { design, layout: res.best.layout, score: res.best.score, ruleset: res.ruleset, name };

  // stream frames with a small delay for a live "learning" feel
  for (let i = 0; i < frames.length; i++) {
    sender.send("synth:frame", {
      index: i, total: frames.length,
      rec: frames[i].rec,
      boardSVG: frames[i].boardSVG,
      heatmapSVG: frames[i].heatmapSVG,
      oscillatorSVG: frames[i].oscillatorSVG,
      emiSVG: frames[i].emiSVG,
      substrateVersion: frames[i].substrateVersion,
      curveSVG: renderLearningCurveSVG(res.history.slice(0, i + 1)),
    });
    await delay(260);
  }

  const promoted = res.ruleset.rules.filter((r) => r.status === "promoted");
  const initial = res.history[0]?.rawScore ?? res.best.score.total;
  const finalEmi = (res.best as any).emi ?? validateEmiProgressive(design, res.best.layout);
  const sub = res.ruleset.substrate;
  return {
    name,
    components: design.components.length,
    nets: design.nets.length,
    clusters: design.clusters.map((c) => ({ kind: c.kind, refs: c.refs })),
    optimizer,
    substrateVersion: sub?.version,
    initialScore: initial,
    finalScore: res.best.score.total,
    improvementPct: Math.round((1 - res.best.score.total / initial) * 100),
    score: res.best.score,
    history: res.history,
    boardSVG: renderBoardSVG(design, res.best.layout, { title: name }),
    heatmapSVG: renderHeatmapSVG(design, res.best.layout, res.best.score),
    oscillatorSVG: (res.best as any).viz ? renderOscillatorSVG((res.best as any).viz) : "",
    emiSVG: renderEmiFieldSVG(design, res.best.layout, finalEmi),
    curveSVG: renderLearningCurveSVG(res.history),
    emi: { model: finalEmi.model, converged: finalEmi.converged, convergenceDeltaPct: finalEmi.convergenceDeltaPct, levels: finalEmi.levels, sensitiveProbeMax: finalEmi.sensitiveProbeMax, verdict: finalEmi.verdict },
    rules: res.ruleset.rules.map((r) => ({ name: r.name, kind: r.kind, origin: r.origin, status: r.status })),
    learnedRules: promoted.map((r) => r.name),
  };
});

ipcMain.handle("board:save", async () => {
  if (!lastRun) return { ok: false, error: "nothing to save yet" };
  const r = await dialog.showSaveDialog({ defaultPath: `${lastRun.name}.kicad_pcb`, filters: [{ name: "KiCad PCB", extensions: ["kicad_pcb"] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, writeBoard(lastRun.design, lastRun.layout));
  return { ok: true, path: r.filePath };
});

ipcMain.handle("rules:save", async () => {
  if (!lastRun) return { ok: false };
  const r = await dialog.showSaveDialog({ defaultPath: `${lastRun.name}.rules.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, JSON.stringify(lastRun.ruleset, null, 2));
  return { ok: true, path: r.filePath };
});

function delay(ms: number) { return new Promise((res) => setTimeout(res, ms)); }

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
