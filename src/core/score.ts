// Objective function + field-risk proxy + hotspot detection.
// Lower total score is better. This is the signal the self-improvement loop ratchets on.

import {
  Box, Pt, dist, polyArea, segIntersect, boxOverlap, centroid,
} from "./geometry";
import {
  courtyardWorld, mstEdges, netPads, padWorld,
} from "./layoututil";
import { Component, Design, FieldScores, Hotspot, Layout, Net, Score } from "./types";
import { checkClearanceBroad } from "./drc";

export const DEFAULT_WEIGHTS: Record<string, number> = {
  ratsnest: 1.0,
  crossings: 2.0,
  courtyard: 8.0,
  offboard: 12.0,
  decap: 6.0,
  switchLoop: 9.0,
  noisySensitive: 7.0,
  usbPair: 5.0,
  antenna: 8.0,
  highCurrent: 5.0,
  thermal: 3.0,
  returnPath: 4.0,
  drc: 20.0, // locked — do not change without an explicit roadmap decision
};

function compByRef(design: Design): Map<string, Component> {
  return new Map(design.components.map((c) => [c.ref, c]));
}

function netCentroid(design: Design, layout: Layout, net: Net): Pt | null {
  const pads = netPads(design, layout, net);
  if (!pads.length) return null;
  return centroid(pads);
}

export function scoreLayout(design: Design, layout: Layout, weights = DEFAULT_WEIGHTS): Score {
  const comps = design.components;
  const byRef = compByRef(design);
  const placedRefs = comps.filter((c) => layout.placements[c.ref]);

  // ---- ratsnest length + crossings ----
  let ratsnest = 0;
  const allEdges: { net: string; a: Pt; b: Pt }[] = [];
  const routedNets = new Set(layout.routes.map((r) => r.net));
  let demandNets = 0, satisfiedNets = 0;
  for (const net of design.nets) {
    if (net.classes.includes("ground")) continue; // ground handled by pour
    const pads = netPads(design, layout, net);
    if (pads.length < 2) continue;
    demandNets++;
    const edges = mstEdges(pads);
    let len = 0;
    for (const [a, b] of edges) { len += dist(a, b); allEdges.push({ net: net.name, a, b }); }
    if (routedNets.has(net.name)) { satisfiedNets++; len *= 0.15; } // routed nets cost little
    ratsnest += len;
  }
  // crossings between edges of different nets
  let crossings = 0;
  for (let i = 0; i < allEdges.length; i++) {
    for (let j = i + 1; j < allEdges.length; j++) {
      if (allEdges[i].net === allEdges[j].net) continue;
      if (segIntersect(allEdges[i].a, allEdges[i].b, allEdges[j].a, allEdges[j].b)) crossings++;
    }
  }
  const routeCompletion = demandNets ? satisfiedNets / demandNets : 1;
  // routeCompletion is the canonical routing-coverage signal (also mirrored by
  // RoutingReport.completionRatio from route.ts). Do not reweight here.

  // ---- courtyard overlaps + off-board ----
  let courtyardOverlaps = 0;
  let offboard = 0;
  const boxes = new Map<string, Box>();
  for (const c of placedRefs) boxes.set(c.ref, courtyardWorld(design, layout.placements[c.ref]));
  const refList = [...boxes.keys()];
  for (let i = 0; i < refList.length; i++) {
    for (let j = i + 1; j < refList.length; j++) {
      courtyardOverlaps += boxOverlap(boxes.get(refList[i])!, boxes.get(refList[j])!);
    }
  }
  for (const ref of refList) {
    const b = boxes.get(ref)!;
    const ox = Math.max(0, -b.minX) + Math.max(0, b.maxX - design.board.width);
    const oy = Math.max(0, -b.minY) + Math.max(0, b.maxY - design.board.height);
    offboard += ox + oy;
  }

  // ---- decap distance ----
  let decap = 0;
  const hotspots: Hotspot[] = [];
  for (const c of comps) {
    if (!["decap", "input_cap", "output_cap"].includes(c.role)) continue;
    if (!layout.placements[c.ref]) continue;
    // find nearest IC sharing a power/ground net
    const myNets = new Set(c.pins.map((p) => p.net));
    let nearest = Infinity, nearestRef = "";
    for (const ic of comps) {
      if (!["mcu", "regulator", "imu", "adc", "ic", "motor_driver", "rf", "sensor"].includes(ic.role)) continue;
      if (!ic.pins.some((p) => myNets.has(p.net))) continue;
      if (!layout.placements[ic.ref]) continue;
      const d = dist(layout.placements[c.ref], layout.placements[ic.ref]);
      if (d < nearest) { nearest = d; nearestRef = ic.ref; }
    }
    if (nearestRef && nearest > 2.5) {
      const over = nearest - 2.5;
      decap += over;
      if (over > 4) hotspots.push({
        kind: "decap_far", severity: over > 8 ? "high" : "medium",
        at: layout.placements[c.ref], refs: [c.ref, nearestRef],
        message: `${c.ref} decoupling cap is ${nearest.toFixed(1)}mm from ${nearestRef}`,
        suggestedAction: `place ${c.ref} within 2mm of ${nearestRef} power pin`,
      });
    }
  }

  // ---- switching loop area (buck clusters) ----
  let switchLoopArea = 0;
  for (const cl of design.clusters) {
    if (cl.kind !== "buck_converter") continue;
    const reg = cl.refs.map((r) => byRef.get(r)).find((c) => c?.role === "regulator");
    const ind = cl.refs.map((r) => byRef.get(r)).find((c) => c?.role === "inductor");
    const cin = cl.refs.map((r) => byRef.get(r)).find((c) => c?.role === "input_cap");
    const pts: Pt[] = [];
    for (const c of [cin, reg, ind]) if (c && layout.placements[c.ref]) pts.push(layout.placements[c.ref]);
    if (pts.length === 3) {
      const area = polyArea(pts);
      switchLoopArea += area;
      if (area > 60) hotspots.push({
        kind: "switch_loop", severity: area > 120 ? "high" : "medium",
        at: centroid(pts), refs: pts.length ? cl.refs : [],
        message: `buck hot loop area ${area.toFixed(0)}mm² (${cl.refs.join(",")})`,
        suggestedAction: "cluster input cap, regulator and inductor tightly to shrink the switch loop",
      });
    }
  }

  // ---- noisy vs sensitive coupling ----
  let noisySensitive = 0;
  const noisyNets = design.nets.filter((n) => n.classes.includes("noisy") || n.classes.includes("high_current"));
  const sensNets = design.nets.filter((n) => n.classes.includes("sensitive"));
  for (const nn of noisyNets) {
    const cN = netCentroid(design, layout, nn);
    if (!cN) continue;
    for (const sn of sensNets) {
      const cS = netCentroid(design, layout, sn);
      if (!cS) continue;
      const d = dist(cN, cS);
      const contrib = 40 / (d * d + 1);
      noisySensitive += contrib;
      if (d < 6) hotspots.push({
        kind: "noisy_sensitive_coupling", severity: d < 3 ? "high" : "medium",
        at: { x: (cN.x + cS.x) / 2, y: (cN.y + cS.y) / 2 }, nets: [nn.name, sn.name],
        message: `${nn.name} within ${d.toFixed(1)}mm of sensitive ${sn.name}`,
        suggestedAction: `increase spacing between ${nn.name} and ${sn.name}`,
      });
    }
  }

  // ---- usb pair length / skew ----
  let usbPair = 0;
  for (const dp of design.board.diffPairs) {
    const np = design.nets.find((n) => n.name === dp.p);
    const nn = design.nets.find((n) => n.name === dp.n);
    if (!np || !nn) continue;
    const lp = pairLen(design, layout, np);
    const ln = pairLen(design, layout, nn);
    usbPair += (lp + ln) * 0.1 + Math.abs(lp - ln);
  }

  // ---- antenna keepout ----
  let antenna = 0;
  for (const c of comps) {
    if (c.role !== "antenna" && c.role !== "rf") continue;
    const pl = layout.placements[c.ref];
    if (!pl) continue;
    const fp = design.footprints[c.ref];
    const ko = fp?.keepout ?? 8;
    // penalty: other components inside keepout radius
    for (const other of comps) {
      if (other.ref === c.ref) continue;
      const op = layout.placements[other.ref];
      if (!op) continue;
      const d = dist(pl, op);
      if (d < ko) antenna += (ko - d) * 1.5;
    }
    // penalty if antenna not near a board edge
    const edgeDist = Math.min(pl.x, pl.y, design.board.width - pl.x, design.board.height - pl.y);
    if (edgeDist > 6) {
      antenna += (edgeDist - 6) * 2;
      hotspots.push({
        kind: "antenna_not_edge", severity: "medium", at: pl, refs: [c.ref],
        message: `antenna ${c.ref} is ${edgeDist.toFixed(1)}mm from nearest edge`,
        suggestedAction: `move ${c.ref} to a board edge and keep copper clear`,
      });
    }
  }

  // ---- high current path ----
  let highCurrent = 0;
  for (const net of design.nets) {
    if (!net.classes.includes("high_current")) continue;
    const pads = netPads(design, layout, net);
    let len = 0;
    for (const [a, b] of mstEdges(pads)) len += dist(a, b);
    highCurrent += (len * (net.currentA ?? 1)) / design.board.highCurrentTraceW;
  }

  // ---- thermal density ----
  let thermal = 0;
  const heatRefs = comps.filter((c) => ["regulator", "motor_driver", "mosfet"].includes(c.role) && layout.placements[c.ref]);
  for (let i = 0; i < heatRefs.length; i++) {
    for (let j = i + 1; j < heatRefs.length; j++) {
      const d = dist(layout.placements[heatRefs[i].ref], layout.placements[heatRefs[j].ref]);
      if (d < 8) thermal += (8 - d) * 1.2;
    }
  }

  // ---- return path (sensitive nets crossing noisy clusters) ----
  let returnPath = 0;
  for (const sn of sensNets) {
    const pads = netPads(design, layout, sn);
    for (const [a, b] of mstEdges(pads)) {
      for (const nn of noisyNets) {
        const cN = netCentroid(design, layout, nn);
        if (!cN) continue;
        // does the sensitive edge pass near a noisy centroid?
        const dmid = dist({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cN);
        if (dmid < 4) returnPath += (4 - dmid) * 0.5;
      }
    }
  }

  // ---- DRC: courtyard/offboard proxy + broad-phase copper clearance ----
  // Broad count is pad-AABB / coarse primitive AABB pairs within clearance
  // (checkClearanceBroad) — not exact narrow-phase. Exact clearance is the
  // promotion gate + report.json path (checkClearance), not this term.
  const broad = checkClearanceBroad(design, layout);
  const proxyErrors =
    Math.round(courtyardOverlaps > 0.1 ? courtyardOverlaps * 2 : 0) +
    (offboard > 0.1 ? Math.ceil(offboard) : 0);
  const drcErrors = proxyErrors + broad.violationCount;
  const drcWarnings = Math.round(crossings / 4);

  const terms: Record<string, number> = {
    ratsnest: ratsnest * weights.ratsnest,
    crossings: crossings * weights.crossings,
    courtyard: courtyardOverlaps * weights.courtyard,
    offboard: offboard * weights.offboard,
    decap: decap * weights.decap,
    switchLoop: switchLoopArea * 0.05 * weights.switchLoop,
    noisySensitive: noisySensitive * weights.noisySensitive,
    usbPair: usbPair * weights.usbPair,
    antenna: antenna * weights.antenna,
    highCurrent: highCurrent * weights.highCurrent,
    thermal: thermal * weights.thermal,
    returnPath: returnPath * weights.returnPath,
    drc: drcErrors * weights.drc,
  };
  const total = Object.values(terms).reduce((a, b) => a + b, 0);

  const field: FieldScores = {
    coupling: clamp01(noisySensitive / 40),
    returnPath: clamp01(returnPath / 20),
    switching: clamp01(switchLoopArea / 200),
    antenna: clamp01(antenna / 40),
    thermal: clamp01(thermal / 30),
  };

  hotspots.sort((a, b) => sev(b.severity) - sev(a.severity));

  return {
    total, terms, drcErrors, drcWarnings,
    ratsnestLen: ratsnest, ratsnestCrossings: crossings, courtyardOverlaps,
    routeCompletion, switchLoopArea, field, hotspots: hotspots.slice(0, 12),
  };
}

function pairLen(design: Design, layout: Layout, net: Net): number {
  const pads = netPads(design, layout, net);
  let len = 0;
  for (const [a, b] of mstEdges(pads)) len += dist(a, b);
  return len;
}
function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
function sev(s: string): number { return s === "high" ? 3 : s === "medium" ? 2 : 1; }
