// Self-contained SVG renderers for the layla board/heatmap/learning views.
//
// Every function returns one complete <svg ...>...</svg> string with no external
// CSS or JS so the output is valid both inside the Electron GUI and from the CLI.

import { Design, Layout, Score, IterationRecord, Role, Hotspot } from "./types";
import { Box, Pt } from "./geometry";
import { padWorld, courtyardWorld, netPads, mstEdges } from "./layoututil";
import { OscViz, EmiReport } from "./oscTypes";

// ---------- tiny helpers ----------

/** Escape text for safe inclusion in XML text nodes / attribute values. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Round to ~2 decimals, drop trailing zeros, guard against NaN/Infinity. */
function fmt(n: number): string {
  if (!isFinite(n)) return "0";
  const r = Math.round(n * 100) / 100;
  return String(r);
}

// ---------- role styling ----------

interface RoleStyle {
  body: string;   // body fill
  stroke: string; // body edge
}

function roleStyle(role: Role): RoleStyle {
  switch (role) {
    case "mcu":
    case "ic":
    case "adc":
    case "imu":
    case "motor_driver":
      return { body: "#181a1e", stroke: "#7e828a" }; // blue-ish
    case "regulator":
    case "inductor":
      return { body: "#1f1d18", stroke: "#9a8d63" }; // orange
    case "connector":
    case "usb":
      return { body: "#16191b", stroke: "#6a7074" }; // teal
    case "sensor":
    case "crystal":
      return { body: "#1a181f", stroke: "#74727e" }; // purple
    case "rf":
    case "antenna":
      return { body: "#1d181c", stroke: "#c08a36" }; // magenta
    default:
      return { body: "#1a1a1e", stroke: "#56565c" }; // neutral
  }
}

// ---------- view scaling ----------

interface View {
  W: number;     // board width (mm)
  H: number;     // board height (mm)
  margin: number;
  scale: number; // px per mm
  pxW: number;
  pxH: number;
}

function viewFor(boardW: number, boardH: number, maxPx = 900): View {
  const margin = 3;
  const W = boardW, H = boardH;
  const vw = W + margin * 2;
  const vh = H + margin * 2;
  const scale = Math.max(1, Math.min(maxPx / vw, maxPx / vh));
  return {
    W, H, margin, scale,
    pxW: Math.round(vw * scale),
    pxH: Math.round(vh * scale),
  };
}

function svgOpen(v: View): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v.pxW}" height="${v.pxH}" ` +
    `viewBox="${-v.margin} ${-v.margin} ${fmt(v.W + v.margin * 2)} ${fmt(v.H + v.margin * 2)}" ` +
    `font-family="monospace">`;
}

// ---------- shared board geometry ----------

function boardSubstrate(v: View, dim = false): string {
  const fill = dim ? "#0c0c0e" : "#101013";
  const stroke = dim ? "#2a2a2f" : "#3a3a40";
  return `<rect x="0" y="0" width="${fmt(v.W)}" height="${fmt(v.H)}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="0.3"/>`;
}

function mountingHolesSVG(design: Design): string {
  let out = "";
  for (const m of design.board.mountingHoles) {
    out += `<circle cx="${fmt(m.x)}" cy="${fmt(m.y)}" r="${fmt(m.drill / 2)}" ` +
      `fill="#0a0a0b" stroke="#86868c" stroke-width="0.25"/>`;
    if (m.keepout > 0) {
      out += `<circle cx="${fmt(m.x)}" cy="${fmt(m.y)}" r="${fmt(m.keepout)}" ` +
        `fill="none" stroke="#86868c" stroke-width="0.1" stroke-dasharray="0.6 0.6" opacity="0.4"/>`;
    }
  }
  return out;
}

function boxRect(b: Box, attrs: string): string {
  return `<rect x="${fmt(b.minX)}" y="${fmt(b.minY)}" ` +
    `width="${fmt(b.maxX - b.minX)}" height="${fmt(b.maxY - b.minY)}" ${attrs}/>`;
}

// ---------- 1) board ----------

export function renderBoardSVG(
  design: Design,
  layout: Layout,
  opts?: { showRatsnest?: boolean; showRoutes?: boolean; title?: string },
): string {
  const showRatsnest = opts?.showRatsnest !== false;
  const showRoutes = opts?.showRoutes !== false;
  const v = viewFor(design.board.width, design.board.height);

  let s = svgOpen(v);
  s += `<rect x="${-v.margin}" y="${-v.margin}" width="${fmt(v.W + v.margin * 2)}" ` +
    `height="${fmt(v.H + v.margin * 2)}" fill="#0a0a0b"/>`;
  s += boardSubstrate(v);
  s += mountingHolesSVG(design);

  // ratsnest (under components)
  if (showRatsnest) {
    let rats = "";
    for (const net of design.nets) {
      if (net.classes.includes("ground")) continue;
      const pts = netPads(design, layout, net);
      for (const [a, b] of mstEdges(pts)) {
        rats += `<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" ` +
          `stroke="#ffffff" stroke-width="0.08"/>`;
      }
    }
    if (rats) s += `<g opacity="0.25">${rats}</g>`;
  }

  // components
  for (const comp of design.components) {
    const pl = layout.placements[comp.ref];
    if (!pl) continue;
    const fp = design.footprints[comp.ref];
    const st = roleStyle(comp.role);

    // translucent body, rotated about the placement origin
    if (fp && fp.bodyW > 0 && fp.bodyH > 0) {
      s += `<rect x="${fmt(-fp.bodyW / 2)}" y="${fmt(-fp.bodyH / 2)}" ` +
        `width="${fmt(fp.bodyW)}" height="${fmt(fp.bodyH)}" ` +
        `fill="${st.body}" stroke="${st.stroke}" stroke-width="0.15" opacity="0.65" ` +
        `transform="translate(${fmt(pl.x)} ${fmt(pl.y)}) rotate(${fmt(pl.rot)})"/>`;
    }

    // courtyard outline
    const cw = courtyardWorld(design, pl);
    s += boxRect(cw, `fill="none" stroke="${st.stroke}" stroke-width="0.08" ` +
      `stroke-dasharray="0.5 0.4" opacity="0.45"`);

    // pads
    if (fp) {
      for (const pad of fp.pads) {
        const w = padWorld(design, layout, comp.ref, pad.num);
        if (!w) continue;
        const rotated = (pl.rot % 180) !== 0;
        const pw = rotated ? pad.h : pad.w;
        const ph = rotated ? pad.w : pad.h;
        const fill = pad.type === "smd" ? "#9c9ca0" : "#74747a";
        const rx = pad.shape === "circle" ? Math.min(pw, ph) / 2 :
          pad.shape === "oval" ? Math.min(pw, ph) / 2 :
          pad.shape === "roundrect" ? 0.12 : 0;
        s += `<rect x="${fmt(w.x - pw / 2)}" y="${fmt(w.y - ph / 2)}" ` +
          `width="${fmt(pw)}" height="${fmt(ph)}" rx="${fmt(rx)}" ry="${fmt(rx)}" ` +
          `fill="${fill}"/>`;
        if (pad.type === "thru" && pad.drill && pad.drill > 0) {
          s += `<circle cx="${fmt(w.x)}" cy="${fmt(w.y)}" r="${fmt(pad.drill / 2)}" ` +
            `fill="#0a0a0a"/>`;
        }
      }
    }

    // ref label at center
    s += `<text x="${fmt(pl.x)}" y="${fmt(pl.y)}" font-size="0.9" fill="#c0c0c4" ` +
      `text-anchor="middle" dominant-baseline="central">${esc(comp.ref)}</text>`;
  }

  // routes (above components)
  if (showRoutes) {
    for (const seg of layout.routes) {
      const col = seg.layer === "F.Cu" ? "#c2c2c6" : "#54545a";
      s += `<line x1="${fmt(seg.a.x)}" y1="${fmt(seg.a.y)}" x2="${fmt(seg.b.x)}" y2="${fmt(seg.b.y)}" ` +
        `stroke="${col}" stroke-width="${fmt(seg.width)}" stroke-linecap="round" opacity="0.85"/>`;
    }
    for (const via of layout.vias) {
      const r = Math.max(0.25, design.board.viaDia / 2);
      s += `<circle cx="${fmt(via.at.x)}" cy="${fmt(via.at.y)}" r="${fmt(r)}" ` +
        `fill="#cccccc" stroke="#5e5e64" stroke-width="0.08"/>`;
    }
  }

  // title
  if (opts?.title) {
    s += `<text x="0.5" y="${fmt(-v.margin + 1.6)}" font-size="1.6" fill="#ececed" ` +
      `font-weight="bold">${esc(opts.title)}</text>`;
  }

  s += `</svg>`;
  return s;
}

// ---------- 2) heatmap ----------

function severityRadius(sev: Hotspot["severity"]): number {
  return sev === "high" ? 10 : sev === "medium" ? 6 : 4;
}
function severityGrad(sev: Hotspot["severity"]): string {
  return sev === "high" ? "heatHigh" : sev === "medium" ? "heatMed" : "heatLow";
}

export function renderHeatmapSVG(design: Design, layout: Layout, score: Score): string {
  const v = viewFor(design.board.width, design.board.height);

  let s = svgOpen(v);

  // gradient defs
  s += `<defs>`;
  s += `<radialGradient id="heatHigh">` +
    `<stop offset="0%" stop-color="#c89038" stop-opacity="0.85"/>` +
    `<stop offset="50%" stop-color="#b0832f" stop-opacity="0.45"/>` +
    `<stop offset="100%" stop-color="#b0832f" stop-opacity="0"/></radialGradient>`;
  s += `<radialGradient id="heatMed">` +
    `<stop offset="0%" stop-color="#b0832f" stop-opacity="0.7"/>` +
    `<stop offset="55%" stop-color="#8f7a44" stop-opacity="0.35"/>` +
    `<stop offset="100%" stop-color="#8f7a44" stop-opacity="0"/></radialGradient>`;
  s += `<radialGradient id="heatLow">` +
    `<stop offset="0%" stop-color="#9a8a52" stop-opacity="0.55"/>` +
    `<stop offset="60%" stop-color="#b0a06a" stop-opacity="0.25"/>` +
    `<stop offset="100%" stop-color="#b0a06a" stop-opacity="0"/></radialGradient>`;
  s += `</defs>`;

  s += `<rect x="${-v.margin}" y="${-v.margin}" width="${fmt(v.W + v.margin * 2)}" ` +
    `height="${fmt(v.H + v.margin * 2)}" fill="#0a0a0b"/>`;
  s += boardSubstrate(v, true);
  s += mountingHolesSVG(design);

  // faint courtyards for context
  let ctx = "";
  for (const comp of design.components) {
    const pl = layout.placements[comp.ref];
    if (!pl) continue;
    const cw = courtyardWorld(design, pl);
    ctx += boxRect(cw, `fill="none" stroke="#2e2e34" stroke-width="0.07"`);
    ctx += `<text x="${fmt(pl.x)}" y="${fmt(pl.y)}" font-size="0.8" fill="#50505a" ` +
      `text-anchor="middle" dominant-baseline="central">${esc(comp.ref)}</text>`;
  }
  s += `<g opacity="0.6">${ctx}</g>`;

  // heat blobs
  for (const h of score.hotspots) {
    const r = severityRadius(h.severity);
    s += `<circle cx="${fmt(h.at.x)}" cy="${fmt(h.at.y)}" r="${fmt(r)}" ` +
      `fill="url(#${severityGrad(h.severity)})"/>`;
  }

  // --- overlay panel in screen px units (separate svg layered via foreign coords) ---
  // We draw the legend + field bars in board-mm space at the bottom for self-containment.
  const panelY = v.H - 0.5;
  const lineH = 1.4;
  const top = score.hotspots.slice(0, 5);
  let legend = "";
  legend += `<rect x="0.5" y="${fmt(panelY - top.length * lineH - 5.5)}" ` +
    `width="${fmt(Math.min(v.W - 1, 60))}" height="${fmt(top.length * lineH + 5)}" ` +
    `fill="#0a0a0b" opacity="0.78" stroke="#26262b" stroke-width="0.1"/>`;
  let ty = panelY - top.length * lineH - 4.0;
  legend += `<text x="1.2" y="${fmt(ty)}" font-size="1.2" fill="#ececed" font-weight="bold">` +
    `Risk hotspots (total ${fmt(score.total)})</text>`;
  ty += lineH;
  for (const h of top) {
    const col = h.severity === "high" ? "#c2655f" : h.severity === "medium" ? "#8f7a44" : "#b0a06a";
    legend += `<circle cx="1.6" cy="${fmt(ty - 0.35)}" r="0.45" fill="${col}"/>`;
    legend += `<text x="2.6" y="${fmt(ty)}" font-size="1.0" fill="#c0c0c4">` +
      `${esc(h.kind)}: ${esc(h.message)}</text>`;
    ty += lineH;
  }
  s += legend;

  // field score bars (top-right)
  const fields: Array<[string, number, string]> = [
    ["coupling", score.field.coupling, "#c08a36"],
    ["returnPath", score.field.returnPath, "#7e828a"],
    ["switching", score.field.switching, "#9a8d63"],
    ["antenna", score.field.antenna, "#74727e"],
    ["thermal", score.field.thermal, "#c2655f"],
  ];
  let maxF = 0.0001;
  for (const f of fields) maxF = Math.max(maxF, Math.abs(f[1]));
  const barX = v.W - 18;
  const barMaxW = 14;
  let by = 1.5;
  let bars = `<text x="${fmt(barX)}" y="${fmt(by)}" font-size="1.1" fill="#ececed" ` +
    `font-weight="bold">field scores</text>`;
  by += 1.6;
  for (const [name, val, col] of fields) {
    const w = (Math.abs(val) / maxF) * barMaxW;
    bars += `<rect x="${fmt(barX)}" y="${fmt(by - 1.0)}" width="${fmt(w)}" height="1.0" fill="${col}"/>`;
    bars += `<text x="${fmt(barX)}" y="${fmt(by - 1.3)}" font-size="0.8" fill="#c0c0c4">` +
      `${esc(name)} ${fmt(val)}</text>`;
    by += 2.0;
  }
  s += `<g opacity="0.95">${bars}</g>`;

  s += `</svg>`;
  return s;
}

// ---------- role color for free-form role strings ----------
// OscVizNode.role is a plain string (not the Role union), so route it through
// roleStyle() by casting; the default branch handles anything unrecognized.
function roleColorStr(role: string): string {
  return roleStyle(role as Role).stroke;
}

// ---------- 3) learning curve ----------

export function renderLearningCurveSVG(history: IterationRecord[]): string {
  const PW = 720, PH = 300;
  const mL = 50, mR = 20, mT = 40, mB = 36;
  const plotW = PW - mL - mR;
  const plotH = PH - mT - mB;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" ` +
    `viewBox="0 0 ${PW} ${PH}" font-family="monospace">`;
  s += `<rect x="0" y="0" width="${PW}" height="${PH}" fill="#0a0a0b"/>`;
  s += `<text x="12" y="22" font-size="14" fill="#ececed" font-weight="bold">` +
    `Self-improvement: score per iteration (lower is better)</text>`;

  if (history.length === 0) {
    s += `<text x="${PW / 2}" y="${PH / 2}" font-size="14" fill="#5e5e64" ` +
      `text-anchor="middle">no iterations yet</text></svg>`;
    return s;
  }

  // y-domain over both series
  let yMin = Infinity, yMax = -Infinity;
  for (const r of history) {
    yMin = Math.min(yMin, r.rawScore, r.bestScore);
    yMax = Math.max(yMax, r.rawScore, r.bestScore);
  }
  if (!isFinite(yMin) || !isFinite(yMax)) { yMin = 0; yMax = 1; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad; yMax += pad;

  const xMin = history[0].iter;
  const xMax = history[history.length - 1].iter;
  const xSpan = xMax - xMin || 1;

  const xOf = (it: number) => mL + ((it - xMin) / xSpan) * plotW;
  const yOf = (val: number) => mT + (1 - (val - yMin) / (yMax - yMin)) * plotH;

  // gridlines + y labels
  const nGrid = 4;
  for (let i = 0; i <= nGrid; i++) {
    const yv = yMin + ((yMax - yMin) * i) / nGrid;
    const yy = yOf(yv);
    s += `<line x1="${mL}" y1="${fmt(yy)}" x2="${mL + plotW}" y2="${fmt(yy)}" ` +
      `stroke="#16161a" stroke-width="1"/>`;
    s += `<text x="${mL - 6}" y="${fmt(yy + 3)}" font-size="9" fill="#5e5e64" ` +
      `text-anchor="end">${esc(fmt(yv))}</text>`;
  }

  // axes
  s += `<line x1="${mL}" y1="${mT}" x2="${mL}" y2="${mT + plotH}" stroke="#2e2e34" stroke-width="1"/>`;
  s += `<line x1="${mL}" y1="${mT + plotH}" x2="${mL + plotW}" y2="${mT + plotH}" ` +
    `stroke="#2e2e34" stroke-width="1"/>`;

  // raw score (faint)
  let rawPath = "";
  history.forEach((r, i) => {
    rawPath += (i === 0 ? "M" : "L") + `${fmt(xOf(r.iter))} ${fmt(yOf(r.rawScore))} `;
  });
  s += `<path d="${rawPath.trim()}" fill="none" stroke="#50505a" stroke-width="1.2" opacity="0.55"/>`;

  // best score (bright cyan)
  let bestPath = "";
  history.forEach((r, i) => {
    bestPath += (i === 0 ? "M" : "L") + `${fmt(xOf(r.iter))} ${fmt(yOf(r.bestScore))} `;
  });
  s += `<path d="${bestPath.trim()}" fill="none" stroke="#c6c6ca" stroke-width="2"/>`;

  // promotion markers (triangles)
  for (const r of history) {
    if (r.promoted && r.promoted.length > 0) {
      const cx = xOf(r.iter), cy = yOf(r.bestScore);
      s += `<path d="M${fmt(cx)} ${fmt(cy - 4)} L${fmt(cx - 3.5)} ${fmt(cy + 3)} ` +
        `L${fmt(cx + 3.5)} ${fmt(cy + 3)} Z" fill="#c89a3c" stroke="#0a0a0b" stroke-width="0.5"/>`;
    }
  }

  // x labels: first/last
  s += `<text x="${fmt(xOf(xMin))}" y="${mT + plotH + 14}" font-size="9" fill="#5e5e64" ` +
    `text-anchor="middle">iter ${esc(String(xMin))}</text>`;
  s += `<text x="${fmt(xOf(xMax))}" y="${mT + plotH + 14}" font-size="9" fill="#5e5e64" ` +
    `text-anchor="middle">iter ${esc(String(xMax))}</text>`;

  // min/last value annotations
  const last = history[history.length - 1];
  let bestVal = Infinity, bestIter = xMin;
  for (const r of history) if (r.bestScore < bestVal) { bestVal = r.bestScore; bestIter = r.iter; }
  s += `<text x="${mL + plotW}" y="${mT + plotH + 28}" font-size="10" fill="#c6c6ca" ` +
    `text-anchor="end">best ${esc(fmt(bestVal))} @ iter ${esc(String(bestIter))} | ` +
    `last ${esc(fmt(last.bestScore))}</text>`;

  // legend
  s += `<line x1="${mL}" y1="${mT + plotH + 26}" x2="${mL + 16}" y2="${mT + plotH + 26}" ` +
    `stroke="#c6c6ca" stroke-width="2"/>`;
  s += `<text x="${mL + 20}" y="${mT + plotH + 29}" font-size="9" fill="#c0c0c4">best</text>`;
  s += `<line x1="${mL + 60}" y1="${mT + plotH + 26}" x2="${mL + 76}" y2="${mT + plotH + 26}" ` +
    `stroke="#50505a" stroke-width="1.2"/>`;
  s += `<text x="${mL + 80}" y="${mT + plotH + 29}" font-size="9" fill="#c0c0c4">raw</text>`;

  s += `</svg>`;
  return s;
}

// ---------- 4) coupled-oscillator optimizer ----------

/**
 * Visualize the coupled-oscillator (Kuramoto-style) placement optimizer.
 *
 * Three panels on one dark canvas (~960x560):
 *   LEFT        decoded layout + coupling graph (nodes at decoded mm coords)
 *   RIGHT-TOP   two phase wheels (θx, θy) showing synchronization clumping
 *   RIGHT-BOTTOM  global order parameter R(t) line chart
 *
 * Everything is rendered in screen-pixel coordinates so the panels can be laid
 * out side-by-side; the left panel auto-scales the board-mm node coordinates to
 * fit its region. Guarded against empty node/edge/order inputs.
 */
export function renderOscillatorSVG(viz: OscViz): string {
  const W = 960, H = 560;
  const nodes = viz.nodes || [];
  const edges = viz.edges || [];

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" font-family="monospace">`;
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#0a0a0b"/>`;

  // header
  s += `<text x="14" y="22" font-size="14" fill="#ececed" font-weight="bold">` +
    `coupled-oscillator optimizer</text>`;
  s += `<text x="14" y="40" font-size="11" fill="#c6c6ca">` +
    `substrate v${esc(String(viz.substrateVersion))} · ` +
    `${esc(String(viz.batch))} phase seeds raced</text>`;

  // ---- region geometry ----
  const headerH = 52;
  const leftX = 14, leftY = headerH;
  const leftW = 560, leftH = H - headerH - 14;
  const rightX = leftX + leftW + 14;
  const rightW = W - rightX - 14;
  const wheelsY = headerH;
  const wheelsH = 300;
  const chartY = wheelsY + wheelsH + 16;
  const chartH = H - chartY - 14;

  // ================= (a) LEFT: decoded layout / coupling graph =================
  s += `<rect x="${leftX}" y="${leftY}" width="${leftW}" height="${leftH}" ` +
    `fill="#0c0c0e" stroke="#2a2a2f" stroke-width="1" rx="3"/>`;
  s += `<text x="${leftX + 8}" y="${leftY + 16}" font-size="11" fill="#86868c">` +
    `decoded layout · coupling graph</text>`;

  if (nodes.length > 0) {
    // bounds of decoded node coordinates (mm)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    if (maxX === minX) { maxX = minX + 1; }
    if (maxY === minY) { maxY = minY + 1; }

    // fit-to-region transform (uniform scale, centered, with inner padding)
    const pad = 26;
    const innerW = leftW - pad * 2, innerH = leftH - pad * 2 - 8;
    const sc = Math.min(innerW / (maxX - minX), innerH / (maxY - minY));
    const offX = leftX + pad + (innerW - (maxX - minX) * sc) / 2;
    const offY = leftY + pad + 8 + (innerH - (maxY - minY) * sc) / 2;
    const px = (x: number) => offX + (x - minX) * sc;
    const py = (y: number) => offY + (y - minY) * sc;

    // sample edges if there are too many (keep the SVG light)
    const MAX_EDGES = 400;
    const total = edges.length;
    let drawList = edges;
    if (total > MAX_EDGES) {
      drawList = [];
      const stride = total / MAX_EDGES;
      for (let f = 0; f < total; f += stride) drawList.push(edges[Math.floor(f)]);
    }

    // edges: attractive cyan (opacity ~ |k|), repulsive thin orange dashed
    let attract = "", repel = "";
    for (const e of drawList) {
      const a = nodes[e.i], b = nodes[e.j];
      if (!a || !b) continue;
      const x1 = fmt(px(a.x)), y1 = fmt(py(a.y)), x2 = fmt(px(b.x)), y2 = fmt(py(b.y));
      const isRepel = e.k < 0 || e.kind === "repel" || e.kind === "noisy_sensitive";
      if (isRepel) {
        repel += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
          `stroke="#b0832f" stroke-width="0.7" stroke-dasharray="3 3" opacity="0.35"/>`;
      } else {
        const op = Math.min(0.8, 0.12 + Math.abs(e.k) * 0.6);
        attract += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
          `stroke="#c6c6ca" stroke-width="1" opacity="${fmt(op)}"/>`;
      }
    }
    s += `<g>${repel}</g><g>${attract}</g>`;

    // nodes: small circles colored by role + ref label
    let dots = "";
    for (const n of nodes) {
      const col = roleColorStr(n.role);
      const cx = fmt(px(n.x)), cy = fmt(py(n.y));
      dots += `<circle cx="${cx}" cy="${cy}" r="3.2" fill="${col}" ` +
        `stroke="#0a0a0b" stroke-width="0.6"/>`;
      dots += `<text x="${cx}" y="${fmt(py(n.y) - 5)}" font-size="7" fill="#c0c0c4" ` +
        `text-anchor="middle">${esc(n.ref)}</text>`;
    }
    s += dots;

    // "showing N/M couplings" note
    s += `<text x="${leftX + 8}" y="${leftY + leftH - 8}" font-size="9" fill="#5e5e64">` +
      `showing ${esc(String(drawList.length))}/${esc(String(total))} couplings</text>`;
  } else {
    s += `<text x="${leftX + leftW / 2}" y="${leftY + leftH / 2}" font-size="12" ` +
      `fill="#5e5e64" text-anchor="middle">no nodes</text>`;
  }

  // ================= (b) RIGHT-TOP: phase wheels =================
  s += `<rect x="${rightX}" y="${wheelsY}" width="${rightW}" height="${wheelsH}" ` +
    `fill="#0c0c0f" stroke="#16161a" stroke-width="1" rx="3"/>`;
  s += `<text x="${rightX + 8}" y="${wheelsY + 16}" font-size="11" fill="#86868c">` +
    `phase wheels (Kuramoto sync)</text>`;

  // draw one unit-circle of phases; `pick` selects θx or θy from each node
  const drawWheel = (
    cx: number, cy: number, r: number, label: string,
    pick: (n: { thetaX: number; thetaY: number }) => number,
  ): string => {
    let out = `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="none" ` +
      `stroke="#26262b" stroke-width="1"/>`;
    // cross-hairs
    out += `<line x1="${fmt(cx - r)}" y1="${fmt(cy)}" x2="${fmt(cx + r)}" y2="${fmt(cy)}" ` +
      `stroke="#16161a" stroke-width="0.6"/>`;
    out += `<line x1="${fmt(cx)}" y1="${fmt(cy - r)}" x2="${fmt(cx)}" y2="${fmt(cy + r)}" ` +
      `stroke="#16161a" stroke-width="0.6"/>`;
    for (const n of nodes) {
      const th = pick(n);
      if (!isFinite(th)) continue;
      const dx = cx + Math.cos(th) * r;
      const dy = cy + Math.sin(th) * r;
      out += `<circle cx="${fmt(dx)}" cy="${fmt(dy)}" r="3" fill="${roleColorStr(n.role)}" ` +
        `opacity="0.9"/>`;
    }
    out += `<text x="${fmt(cx)}" y="${fmt(cy + r + 16)}" font-size="12" fill="#ececed" ` +
      `text-anchor="middle">${esc(label)}</text>`;
    return out;
  };

  {
    const wr = Math.min(70, (rightW - 60) / 4);
    const cyW = wheelsY + wheelsH / 2;
    const c1x = rightX + rightW * 0.28;
    const c2x = rightX + rightW * 0.72;
    s += drawWheel(c1x, cyW, wr, "θx", (n) => n.thetaX);
    s += drawWheel(c2x, cyW, wr, "θy", (n) => n.thetaY);
  }

  // ================= (c) RIGHT-BOTTOM: order parameter R(t) =================
  s += `<rect x="${rightX}" y="${chartY}" width="${rightW}" height="${chartH}" ` +
    `fill="#0c0c0f" stroke="#16161a" stroke-width="1" rx="3"/>`;
  s += `<text x="${rightX + 8}" y="${chartY + 16}" font-size="11" fill="#ececed" ` +
    `font-weight="bold">global sync R(t)</text>`;

  {
    const cmL = rightX + 26, cmR = rightX + rightW - 12;
    const cmT = chartY + 24, cmB = chartY + chartH - 16;
    const plotW = cmR - cmL, plotH = cmB - cmT;
    const order = viz.order || [];
    const orderX = viz.orderX || [];
    const steps = Math.max(viz.steps || 0, order.length, orderX.length, 1);
    const xOf = (i: number) => cmL + (steps <= 1 ? 0 : (i / (steps - 1)) * plotW);
    const yOf = (val: number) => cmB - Math.min(1, Math.max(0, val)) * plotH; // 0..1

    // axis: R = 0 and R = 1 marked
    s += `<line x1="${fmt(cmL)}" y1="${fmt(cmB)}" x2="${fmt(cmR)}" y2="${fmt(cmB)}" ` +
      `stroke="#2e2e34" stroke-width="1"/>`;
    s += `<line x1="${fmt(cmL)}" y1="${fmt(cmT)}" x2="${fmt(cmL)}" y2="${fmt(cmB)}" ` +
      `stroke="#2e2e34" stroke-width="1"/>`;
    s += `<line x1="${fmt(cmL)}" y1="${fmt(yOf(1))}" x2="${fmt(cmR)}" y2="${fmt(yOf(1))}" ` +
      `stroke="#16161a" stroke-width="1" stroke-dasharray="3 3"/>`;
    s += `<text x="${fmt(cmL - 5)}" y="${fmt(yOf(1) + 3)}" font-size="9" fill="#5e5e64" ` +
      `text-anchor="end">1</text>`;
    s += `<text x="${fmt(cmL - 5)}" y="${fmt(yOf(0) + 3)}" font-size="9" fill="#5e5e64" ` +
      `text-anchor="end">0</text>`;

    // orderX in a fainter line
    if (orderX.length > 0) {
      let p = "";
      orderX.forEach((val, i) => {
        p += (i === 0 ? "M" : "L") + `${fmt(xOf(i))} ${fmt(yOf(val))} `;
      });
      s += `<path d="${p.trim()}" fill="none" stroke="#50505a" stroke-width="1.2" opacity="0.6"/>`;
    }
    // global order R(t) bright cyan
    if (order.length > 0) {
      let p = "";
      order.forEach((val, i) => {
        p += (i === 0 ? "M" : "L") + `${fmt(xOf(i))} ${fmt(yOf(val))} `;
      });
      s += `<path d="${p.trim()}" fill="none" stroke="#c6c6ca" stroke-width="2"/>`;
      const lastR = order[order.length - 1];
      s += `<text x="${fmt(cmR)}" y="${fmt(cmT + 10)}" font-size="10" fill="#c6c6ca" ` +
        `text-anchor="end">R=${esc(fmt(lastR))}</text>`;
    } else {
      s += `<text x="${fmt(cmL + plotW / 2)}" y="${fmt(cmT + plotH / 2)}" font-size="11" ` +
        `fill="#5e5e64" text-anchor="middle">no sync trace</text>`;
    }
  }

  s += `</svg>`;
  return s;
}

// ---------- 5) progressive damped-wave EMI field ----------

/** Map a normalized value 0..1 to a blue->cyan->yellow->red color. */
function emiColor(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  // four-stop ramp: blue(0) -> cyan(.33) -> yellow(.66) -> red(1)
  const stops: Array<[number, number, number, number]> = [
    [0.0, 0x1e, 0x3a, 0xff], // blue
    [0.33, 0x22, 0xd3, 0xee], // cyan
    [0.66, 0xff, 0xe0, 0x3a], // yellow
    [1.0, 0xff, 0x2a, 0x2a], // red
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (x >= stops[i][0] && x <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const span = hi[0] - lo[0] || 1;
  const f = (x - lo[0]) / span;
  const r = Math.round(lo[1] + (hi[1] - lo[1]) * f);
  const g = Math.round(lo[2] + (hi[2] - lo[2]) * f);
  const b = Math.round(lo[3] + (hi[3] - lo[3]) * f);
  const hx = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/**
 * Render the board with the progressive damped-wave EMI voxel field overlaid as
 * a heatmap. Each grid cell of `emi.field` covers board-mm
 * [cx*cellMm,(cx+1)*cellMm] x [cy*cellMm,(cy+1)*cellMm]; cells are filled with a
 * blue->cyan->yellow->red colormap and opacity proportional to value. Faint
 * component courtyards are drawn over the field so hot regions can be attributed
 * to parts. Guarded against an empty field.
 */
export function renderEmiFieldSVG(design: Design, layout: Layout, emi: EmiReport): string {
  const v = viewFor(design.board.width, design.board.height);

  let s = svgOpen(v);
  s += `<rect x="${-v.margin}" y="${-v.margin}" width="${fmt(v.W + v.margin * 2)}" ` +
    `height="${fmt(v.H + v.margin * 2)}" fill="#0a0a0b"/>`;
  s += boardSubstrate(v, true);
  s += mountingHolesSVG(design);

  // ---- EMI field heatmap ----
  const field = emi.field;
  if (field && field.data && field.data.length > 0 && field.w > 0 && field.h > 0) {
    const cm = field.cellMm;
    let cells = "";
    for (let cy = 0; cy < field.h; cy++) {
      for (let cx = 0; cx < field.w; cx++) {
        const val = field.data[cy * field.w + cx];
        if (!isFinite(val) || val < 0.04) continue; // skip near-zero cells (size)
        const op = Math.min(0.9, 0.1 + val * 0.85);
        cells += `<rect x="${fmt(cx * cm)}" y="${fmt(cy * cm)}" ` +
          `width="${fmt(cm)}" height="${fmt(cm)}" fill="${emiColor(val)}" ` +
          `opacity="${fmt(op)}"/>`;
      }
    }
    s += `<g>${cells}</g>`;
  } else {
    s += `<text x="${fmt(v.W / 2)}" y="${fmt(v.H / 2)}" font-size="2" fill="#5e5e64" ` +
      `text-anchor="middle" dominant-baseline="central">no EMI field</text>`;
  }

  // ---- faint courtyards over the field for attribution ----
  let ctx = "";
  for (const comp of design.components) {
    const pl = layout.placements[comp.ref];
    if (!pl) continue;
    const cw = courtyardWorld(design, pl);
    ctx += boxRect(cw, `fill="none" stroke="#9a9a9e" stroke-width="0.08"`);
    ctx += `<text x="${fmt(pl.x)}" y="${fmt(pl.y)}" font-size="0.8" fill="#c0c0c4" ` +
      `text-anchor="middle" dominant-baseline="central">${esc(comp.ref)}</text>`;
  }
  s += `<g opacity="0.7">${ctx}</g>`;

  // ---- title ----
  s += `<text x="0.5" y="${fmt(-v.margin + 1.6)}" font-size="1.6" fill="#ececed" ` +
    `font-weight="bold">progressive damped-wave EMI field (physics-inspired validation)</text>`;

  // ---- info / legend box (board-mm space, top-right) ----
  const levels = emi.levels || [];
  const boxW = Math.min(v.W - 1, 46);
  const lineH = 1.5;
  const rowsN = levels.length + 4; // model, header, levels..., verdict line(s)
  const boxX = v.W - boxW - 0.5;
  let by = 1.5;
  let info = "";
  info += `<rect x="${fmt(boxX)}" y="${fmt(by - 1.2)}" width="${fmt(boxW)}" ` +
    `height="${fmt(rowsN * lineH + 2)}" fill="#0a0a0b" opacity="0.82" ` +
    `stroke="#26262b" stroke-width="0.1"/>`;
  info += `<text x="${fmt(boxX + 0.6)}" y="${fmt(by)}" font-size="1.1" fill="#ececed" ` +
    `font-weight="bold">${esc(emi.model)}</text>`;
  by += lineH;
  info += `<text x="${fmt(boxX + 0.6)}" y="${fmt(by)}" font-size="0.9" fill="#86868c">` +
    `cellMm   risk    peak</text>`;
  by += lineH;
  for (const lv of levels) {
    info += `<text x="${fmt(boxX + 0.6)}" y="${fmt(by)}" font-size="0.9" fill="#c0c0c4">` +
      `${esc(fmt(lv.cellMm))}     ${esc(fmt(lv.risk))}    ${esc(fmt(lv.peak))}</text>`;
    by += lineH;
  }
  const vcol = emi.converged ? "#c6c6ca" : "#b0832f";
  info += `<text x="${fmt(boxX + 0.6)}" y="${fmt(by)}" font-size="0.9" fill="${vcol}">` +
    `${emi.converged ? "converged" : "not converged"} (Δ ${esc(fmt(emi.convergenceDeltaPct))}%)</text>`;
  by += lineH;
  info += `<text x="${fmt(boxX + 0.6)}" y="${fmt(by)}" font-size="0.9" fill="#c2655f">` +
    `hottest victim: ${esc(emi.sensitiveProbeMax)}</text>`;
  s += info;

  s += `</svg>`;
  return s;
}
