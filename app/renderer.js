/* ============================================================
   layla — renderer.js
   Talks to window.layla (exposed by preload). Renders the
   example list + controls, drives a self-improvement run, streams
   per-iteration frames into the board/heatmap/curve views, and
   renders final topology, rules, hotspots and the improvement
   summary when run() resolves.
   ============================================================ */

(() => {
  "use strict";

  const api = window.layla;

  // ---- element handles -------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const el = {
    examples:    $("examples"),
    openSch:     $("btn-open-sch"),
    loadedFile:  $("loaded-file"),
    optimizer:   $("optimizer"),
    iterations:  $("iterations"),
    iterReadout: $("iter-readout"),
    feedback:    $("feedback"),
    useRules:    $("use-rules"),
    emi:         $("emi"),
    run:         $("btn-run"),
    runLabel:    document.querySelector("#btn-run .btn-run-label"),

    saveBoard:   $("btn-save-board"),
    saveRules:   $("btn-save-rules"),

    runState:    $("run-state"),
    tabs:        Array.from(document.querySelectorAll(".tab")),
    stages: {
      board:      $("view-board"),
      heatmap:    $("view-heatmap"),
      curve:      $("view-curve"),
      oscillator: $("view-oscillator"),
      emi:        $("view-emi"),
    },

    mBest:      $("m-best"),
    mSubstrate: $("m-substrate"),
    mDrc:      $("m-drc"),
    mLoop:     $("m-loop"),
    mRoute:    $("m-route"),
    mCoupling: $("m-coupling"),
    progText:  $("m-progress-text"),
    progBar:   $("progress-bar"),

    summary:       $("summary"),
    topologyPanel: $("topology-panel"),
    clusters:      $("clusters"),
    rulesPanel:    $("rules-panel"),
    rules:         $("rules"),
    hotspots:      $("hotspots"),
    emiPanel:      $("emi-panel"),
    emiBody:       $("emi-body"),
    log:           $("log"),
    toast:         $("toast"),
  };

  // ---- app state -------------------------------------------------------
  const state = {
    examples: [],
    selectedExample: null, // example name
    schPath: null,         // loaded .kicad_sch path (mutually exclusive w/ example)
    running: false,
  };

  // ===================================================================
  // SVG injection — size the injected <svg> to fill its container while
  // preserving aspect ratio (it carries a viewBox). We strip any fixed
  // width/height attrs and let CSS stretch it.
  // ===================================================================
  function injectSVG(stage, svgString) {
    if (!svgString) return;
    stage.innerHTML = svgString;
    const svg = stage.querySelector("svg");
    if (!svg) return;
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    if (!svg.getAttribute("preserveAspectRatio")) {
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
    svg.style.width = "100%";
    svg.style.height = "100%";
  }

  // Show a muted placeholder note inside a stage (e.g. when the
  // oscillator tab has no field because annealing was selected).
  function setStageNote(stage, text) {
    stage.innerHTML = `<div class="svg-note">${escapeHtml(text)}</div>`;
  }

  // Live "substrate vN" cyan chip near the best-score readout.
  function updateSubstrate(version) {
    if (typeof version === "number" && isFinite(version)) {
      el.mSubstrate.textContent = "substrate v" + version;
      el.mSubstrate.hidden = false;
    }
  }

  // ===================================================================
  // Tabs — only toggle visibility; all stages stay populated so
  // switching mid-run shows the current frame for that view.
  // ===================================================================
  function activateTab(name) {
    el.tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
    Object.entries(el.stages).forEach(([key, stage]) => {
      stage.classList.toggle("is-active", key === name);
    });
  }
  el.tabs.forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });

  // ===================================================================
  // Toast
  // ===================================================================
  let toastTimer = null;
  function toast(message, kind = "") {
    el.toast.textContent = message;
    el.toast.className = "toast show" + (kind ? " " + kind : "");
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove("show");
      setTimeout(() => { el.toast.hidden = true; }, 250);
    }, 3200);
  }

  // ===================================================================
  // Examples
  // ===================================================================
  function renderExamples() {
    el.examples.innerHTML = "";
    if (!state.examples.length) {
      el.examples.innerHTML = '<div class="hint">No examples available.</div>';
      return;
    }
    state.examples.forEach((ex) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "example-card";
      card.dataset.name = ex.name;
      if (ex.name === state.selectedExample && !state.schPath) {
        card.classList.add("is-active");
      }
      const title = document.createElement("div");
      title.className = "ex-title";
      title.textContent = ex.title || ex.name;
      const desc = document.createElement("div");
      desc.className = "ex-desc";
      desc.textContent = ex.description || "";
      card.appendChild(title);
      card.appendChild(desc);
      card.addEventListener("click", () => selectExample(ex.name));
      el.examples.appendChild(card);
    });
  }

  function selectExample(name) {
    state.selectedExample = name;
    state.schPath = null;            // selecting an example clears a loaded file
    el.loadedFile.hidden = true;
    el.loadedFile.textContent = "";
    // update active state without full re-render
    el.examples.querySelectorAll(".example-card").forEach((c) => {
      c.classList.toggle("is-active", c.dataset.name === name);
    });
  }

  async function loadExamples() {
    try {
      const list = await api.listExamples();
      state.examples = Array.isArray(list) ? list : [];
      if (state.examples.length) {
        state.selectedExample = state.examples[0].name; // auto-select first
      }
      renderExamples();
    } catch (err) {
      el.examples.innerHTML = '<div class="hint">Failed to load examples.</div>';
      toast("Could not load examples: " + (err && err.message || err), "error");
    }
  }

  // ===================================================================
  // Controls wiring
  // ===================================================================
  el.iterations.addEventListener("input", () => {
    el.iterReadout.textContent = el.iterations.value;
  });

  el.openSch.addEventListener("click", async () => {
    try {
      const path = await api.openSchematic();
      if (!path) return; // cancelled
      state.schPath = path;
      state.selectedExample = null;
      // clear example selection highlight
      el.examples.querySelectorAll(".example-card").forEach((c) =>
        c.classList.remove("is-active")
      );
      const file = path.split(/[\\/]/).pop();
      el.loadedFile.textContent = file;
      el.loadedFile.title = path;
      el.loadedFile.hidden = false;
    } catch (err) {
      toast("Open failed: " + (err && err.message || err), "error");
    }
  });

  // ===================================================================
  // Metrics / log / progress helpers
  // ===================================================================
  const fmt = (n, digits = 0) =>
    (typeof n === "number" && isFinite(n)) ? n.toFixed(digits) : "—";

  function updateMetrics(rec, index, total) {
    el.mBest.textContent     = fmt(rec.bestScore);
    el.mDrc.textContent      = fmt(rec.drcErrors);
    el.mLoop.textContent     = fmt(rec.switchLoopArea, 1);
    el.mRoute.textContent    = (typeof rec.routeCompletion === "number")
      ? Math.round(rec.routeCompletion * (rec.routeCompletion <= 1 ? 100 : 1)) + "%"
      : "—";
    el.mCoupling.textContent = fmt(rec.coupling, 2);

    el.progText.textContent = `${index} / ${total}`;
    const pct = total > 0 ? (index / total) * 100 : 0;
    el.progBar.style.width = pct + "%";
  }

  function appendLog(rec) {
    const promoted = (rec.promoted && rec.promoted.length) ? rec.promoted : [];
    // A promotion that names "substrate vN" means the OPTIMIZER itself
    // improved — flag it cyan, distinct from green symbolic rule promotions.
    const substrate = promoted.find(
      (p) => typeof p === "string" && /^substrate v/i.test(p)
    );
    const line = document.createElement("div");
    line.className =
      "log-line" +
      (substrate ? " substrate" : (promoted.length ? " learned" : ""));
    const iter = String(rec.iter).padStart(2, " ");
    const best = String(Math.round(rec.bestScore)).padStart(4, " ");
    const note = rec.note || "";
    const tag = substrate
      ? `<span class="li-substrate">⟳ ${escapeHtml(substrate)}</span> `
      : (promoted.length ? "▲ " : "Δ ");
    line.innerHTML =
      `<span class="li-iter">#${iter}</span>  best=${best}  ` +
      tag +
      escapeHtml(note);
    el.log.appendChild(line);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function resetRunOutputs() {
    el.log.innerHTML = "";
    el.summary.hidden = true;
    el.summary.innerHTML = "";
    el.progBar.style.width = "0%";
    el.progText.textContent = "0 / 0";
    ["mBest", "mDrc", "mLoop", "mRoute", "mCoupling"].forEach((k) => {
      el[k].textContent = "—";
    });
    el.mSubstrate.hidden = true;
    el.mSubstrate.textContent = "";
    el.emiPanel.hidden = true;
    el.emiBody.innerHTML = "";
  }

  // ===================================================================
  // Final renderers: clusters, rules, hotspots, summary
  // ===================================================================
  function renderClusters(clusters) {
    el.clusters.innerHTML = "";
    if (!clusters || !clusters.length) {
      el.topologyPanel.hidden = true;
      return;
    }
    clusters.forEach((c) => {
      const row = document.createElement("div");
      row.className = "cluster";
      row.innerHTML =
        `<span class="ck">${escapeHtml(c.kind)}</span>` +
        `<span class="cr">${escapeHtml((c.refs || []).join(", "))}</span>`;
      el.clusters.appendChild(row);
    });
    el.topologyPanel.hidden = false;
  }

  function renderRules(rules) {
    el.rules.innerHTML = "";
    if (!rules || !rules.length) {
      el.rulesPanel.hidden = true;
      return;
    }
    rules.forEach((r) => {
      const div = document.createElement("div");
      div.className = "rule " + (r.status || "candidate");
      div.innerHTML =
        `<div class="r-top">` +
          `<span class="r-dot"></span>` +
          `<span class="r-name">${escapeHtml(r.name)}</span>` +
          `<span class="r-status">${escapeHtml(r.status || "")}</span>` +
        `</div>` +
        (r.origin ? `<div class="r-origin">${escapeHtml(r.kind ? r.kind + " · " : "")}${escapeHtml(r.origin)}</div>` : "");
      el.rules.appendChild(div);
    });
    el.rulesPanel.hidden = false;
  }

  function renderHotspots(hotspots) {
    el.hotspots.innerHTML = "";
    if (!hotspots || !hotspots.length) {
      el.hotspots.innerHTML = '<div class="hint">No hotspots flagged. The layout looks clean.</div>';
      return;
    }
    hotspots.forEach((h) => {
      const sev = h.severity || "low";
      const div = document.createElement("div");
      div.className = "hotspot";
      div.innerHTML =
        `<div class="h-top">` +
          `<span class="h-dot sev-${sev}"></span>` +
          `<span class="h-kind">${escapeHtml(h.kind || "")}</span>` +
          `<span class="h-sev sev-${sev}">${escapeHtml(sev)}</span>` +
        `</div>` +
        `<div class="h-msg">${escapeHtml(h.message || "")}</div>` +
        (h.suggestedAction ? `<div class="h-action">→ ${escapeHtml(h.suggestedAction)}</div>` : "");
      el.hotspots.appendChild(div);
    });
  }

  function renderEmi(emi) {
    if (!emi) {
      el.emiPanel.hidden = true;
      el.emiBody.innerHTML = "";
      return;
    }
    const converged = !!emi.converged;
    const deltaStr = (typeof emi.convergenceDeltaPct === "number")
      ? emi.convergenceDeltaPct.toFixed(1) + "%"
      : "—";
    const levels = Array.isArray(emi.levels) ? emi.levels : [];
    const rows = levels.map((lv) =>
      `<tr>` +
        `<td>${escapeHtml(fmt(lv.cellMm, 2))} mm</td>` +
        `<td>${escapeHtml(fmt(lv.risk, 2))}</td>` +
        `<td>${escapeHtml(fmt(lv.peak, 2))}</td>` +
      `</tr>`
    ).join("");

    el.emiBody.innerHTML =
      `<div class="emi-verdict"><span class="e-dot"></span>` +
        `<span>${escapeHtml(emi.verdict || "")}</span></div>` +
      `<div class="emi-meta">` +
        `<span><span class="e-key">model</span> <span class="e-val">${escapeHtml(emi.model || "—")}</span></span>` +
        `<span><span class="e-key">converged</span> ` +
          `<span class="${converged ? "e-ok" : "e-no"}">${converged ? "yes" : "no"}</span></span>` +
        `<span><span class="e-key">Δ ${escapeHtml(deltaStr)}</span> <span class="e-val">across refinement</span></span>` +
      `</div>` +
      (rows
        ? `<table class="emi-table">` +
            `<thead><tr><th>cell</th><th>risk</th><th>peak</th></tr></thead>` +
            `<tbody>${rows}</tbody></table>`
        : "") +
      `<div class="emi-victim">hottest victim: ` +
        `<span class="e-name">${escapeHtml(emi.sensitiveProbeMax || "—")}</span></div>`;
    el.emiPanel.hidden = false;
  }

  function renderSummary(result) {
    const init = Math.round(result.initialScore);
    const fin = Math.round(result.finalScore);
    const pct = result.improvementPct;
    const pctStr = (typeof pct === "number")
      ? (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%"
      : "—";
    const optimizer = result.optimizer || "";
    const sv = result.substrateVersion;
    const substrateStr = optimizer
      ? optimizer + (typeof sv === "number" ? " substrate v" + sv : "")
      : (typeof sv === "number" ? "substrate v" + sv : "");
    el.summary.innerHTML =
      `<span class="s-name">${escapeHtml(result.name || "")}</span>` +
      `<span>${init}</span>` +
      `<span class="arrow">→</span>` +
      `<span>${fin}</span>` +
      `<span class="gain">(improved ${escapeHtml(pctStr)})</span>` +
      (substrateStr ? `<span class="s-substrate">${escapeHtml(substrateStr)}</span>` : "");
    el.summary.hidden = false;
  }

  // ===================================================================
  // Run flow
  // ===================================================================
  function setRunning(on) {
    state.running = on;
    el.run.disabled = on;
    el.run.classList.toggle("is-running", on);
    el.runLabel.textContent = on ? "Running…" : "Run self-improvement";
    el.runState.textContent = on ? "running…" : el.runState.textContent;
    el.runState.className = "run-state" + (on ? " running" : "");
  }

  async function doRun() {
    if (state.running) return;

    // require an input
    if (!state.schPath && !state.selectedExample) {
      toast("Select an example board or load a .kicad_sch first", "error");
      return;
    }

    resetRunOutputs();
    setRunning(true);

    const optimizer = el.optimizer.value || "oscillator";

    // Subscribe to frames BEFORE calling run().
    let unsubscribe = null;
    try {
      unsubscribe = api.onFrame((frame) => {
        if (!frame) return;
        // Update all stages so switching tabs shows the current frame.
        injectSVG(el.stages.board, frame.boardSVG);
        injectSVG(el.stages.heatmap, frame.heatmapSVG);
        injectSVG(el.stages.curve, frame.curveSVG);

        // Oscillator field — annealing produces none, so show a note.
        if (frame.oscillatorSVG) {
          injectSVG(el.stages.oscillator, frame.oscillatorSVG);
        } else if (optimizer === "anneal") {
          setStageNote(el.stages.oscillator,
            "annealing optimizer selected — no oscillator field");
        }
        if (frame.emiSVG) injectSVG(el.stages.emi, frame.emiSVG);

        updateSubstrate(frame.substrateVersion);

        if (frame.rec) {
          updateMetrics(frame.rec, frame.index, frame.total);
          appendLog(frame.rec);
        }
      });
    } catch (err) {
      // onFrame itself failed — continue, run() may still resolve with finals.
      console.error("onFrame subscription failed", err);
      unsubscribe = null;
    }

    const opts = {
      optimizer,
      emi: el.emi.checked,
      iterations: parseInt(el.iterations.value, 10) || 8,
      feedback: el.feedback.value.trim(),
      useRules: el.useRules.checked,
    };
    if (state.schPath) opts.schPath = state.schPath;
    else opts.example = state.selectedExample;

    try {
      const result = await api.run(opts);

      // Paint the final SVGs (in case the last frame lagged the result).
      if (result) {
        injectSVG(el.stages.board, result.boardSVG);
        injectSVG(el.stages.heatmap, result.heatmapSVG);
        injectSVG(el.stages.curve, result.curveSVG);

        if (result.oscillatorSVG) {
          injectSVG(el.stages.oscillator, result.oscillatorSVG);
        } else if ((result.optimizer || optimizer) === "anneal") {
          setStageNote(el.stages.oscillator,
            "annealing optimizer selected — no oscillator field");
        }
        if (result.emiSVG) injectSVG(el.stages.emi, result.emiSVG);

        updateSubstrate(result.substrateVersion);

        renderClusters(result.clusters);
        renderRules(result.rules);
        renderHotspots(result.score && result.score.hotspots);
        renderEmi(result.emi);
        renderSummary(result);

        // final metrics from the score
        if (result.score) {
          el.mBest.textContent  = fmt(result.score.total);
          el.mDrc.textContent   = fmt(result.score.drcErrors);
          el.mLoop.textContent  = fmt(result.score.switchLoopArea, 1);
          const rc = result.score.routeCompletion;
          el.mRoute.textContent = (typeof rc === "number")
            ? Math.round(rc * (rc <= 1 ? 100 : 1)) + "%" : "—";
          if (result.score.field) {
            el.mCoupling.textContent = fmt(result.score.field.coupling, 2);
          }
        }
        el.progBar.style.width = "100%";
      }

      el.runState.textContent = "done";
      el.runState.className = "run-state done";
      toast("Run complete — improved " +
        (typeof result.improvementPct === "number" ? result.improvementPct.toFixed(1) + "%" : ""), "ok");
    } catch (err) {
      el.runState.textContent = "error";
      el.runState.className = "run-state error";
      toast("Run failed: " + (err && err.message || err), "error");
      console.error(err);
    } finally {
      // Always unsubscribe.
      if (typeof unsubscribe === "function") {
        try { unsubscribe(); } catch (_) { /* ignore */ }
      }
      setRunning(false);
    }
  }

  el.run.addEventListener("click", doRun);

  // ===================================================================
  // Save buttons
  // ===================================================================
  el.saveBoard.addEventListener("click", async () => {
    try {
      const res = await api.saveBoard();
      if (res && res.ok) {
        toast("Saved board → " + (res.path || ""), "ok");
      } else {
        toast((res && res.error) || "Nothing to save yet", "error");
      }
    } catch (err) {
      toast("Save failed: " + (err && err.message || err), "error");
    }
  });

  el.saveRules.addEventListener("click", async () => {
    try {
      const res = await api.saveRules();
      if (res && res.ok) {
        toast("Saved rules → " + (res.path || ""), "ok");
      } else {
        toast("Nothing to save yet", "error");
      }
    } catch (err) {
      toast("Save failed: " + (err && err.message || err), "error");
    }
  });

  // ===================================================================
  // Boot
  // ===================================================================
  function boot() {
    if (!api) {
      toast("window.layla not available — preload missing", "error");
      el.examples.innerHTML = '<div class="hint">Preload bridge unavailable.</div>';
      return;
    }
    el.iterReadout.textContent = el.iterations.value;
    activateTab("board");
    loadExamples();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
