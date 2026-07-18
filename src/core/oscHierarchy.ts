// Cluster-derived hierarchical sparse oscillator coupling.
//
// Large boards compile a coarse partition graph (meta-nodes) plus dense
// intra-partition graphs, instead of flat all-pairs noisy↔sensitive repulsion.
// Small boards stay on the flat path for parity with legacy substrates.

import { Component, Design, Ruleset } from "./types";
import {
  OscEdge,
  OscGraph,
  OscGraphStats,
  OscHierarchy,
  OscPartition,
  OscSubstrate,
} from "./oscTypes";
import { TopologyMode } from "./types";

/** Components / flat-edge thresholds that force hierarchical mode. */
export const HIERARCHY_COMPONENT_THRESHOLD = 64;
export const HIERARCHY_FLAT_EDGE_THRESHOLD = 400;

/**
 * Legacy oscillator artifact (no topologyMode) on a hierarchy-eligible board:
 * retain flat coupling for this run; next ruleset write stamps topologyMode.
 */
export const LEGACY_FLAT_TOPOLOGY_NOTICE =
  "Ruleset has no topologyMode field (legacy oscillator artifact). " +
  "Board qualifies for hierarchical sparse coupling; retaining flat-compatibility " +
  "mode for this run. Next ruleset write will stamp topologyMode.";

export interface TopologyDecision {
  mode: TopologyMode;
  preferred: TopologyMode;
  flatEdgeCount: number;
  /** Set when legacy artifact forced flat despite preferred hierarchical. */
  legacyFlatCompat: boolean;
  notice?: string;
}

function netsOf(c: Component): Set<string> {
  return new Set(c.pins.map((p) => p.net).filter(Boolean));
}

function isClass(design: Design, netName: string, cls: string): boolean {
  const n = design.nets.find((x) => x.name === netName);
  return !!n && (n.classes as string[]).includes(cls);
}

function sharedNetCount(a: Component, members: Component[]): number {
  const an = netsOf(a);
  let share = 0;
  for (const m of members) {
    for (const n of netsOf(m)) if (an.has(n)) share++;
  }
  return share;
}

/** Highest pin/net degree within refs; lexicographically smaller ref wins ties. */
export function pickHubRef(design: Design, refs: string[]): string {
  const byRef = new Map(design.components.map((c) => [c.ref, c]));
  let best = refs.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]!;
  let bestDeg = -1;
  for (const r of refs) {
    const c = byRef.get(r);
    if (!c) continue;
    const deg = netsOf(c).size;
    if (deg > bestDeg || (deg === bestDeg && r < best)) {
      bestDeg = deg;
      best = r;
    }
  }
  return best;
}

/**
 * Derive exclusive partitions from design.clusters.
 * Overlapping cluster refs: first cluster in design order wins (matches clusterId).
 * Unclustered refs attach to the cluster partition with greatest shared-net count
 * (stable partition-id tie-break); singleton only when no cluster shares a net.
 */
export function derivePartitions(design: Design): OscHierarchy {
  const byRef = new Map(design.components.map((c) => [c.ref, c]));
  const assigned = new Map<string, string>(); // ref → partition id
  const partitions: OscPartition[] = [];

  for (const cl of design.clusters) {
    const exclusive = cl.refs.filter((r) => byRef.has(r) && !assigned.has(r));
    if (exclusive.length === 0) continue;
    exclusive.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const r of exclusive) assigned.set(r, cl.id);
    partitions.push({
      id: cl.id,
      kind: cl.kind,
      refs: exclusive,
      source: "cluster",
      clusterId: cl.id,
      hubRef: pickHubRef(design, exclusive),
    });
  }

  const clusteredCount = [...assigned.keys()].length;

  const unclustered = design.components
    .map((c) => c.ref)
    .filter((r) => !assigned.has(r))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let attachedCount = 0;
  let singletonCount = 0;

  for (const ref of unclustered) {
    const comp = byRef.get(ref)!;
    let bestPart: OscPartition | null = null;
    let bestShare = 0;
    for (const part of partitions) {
      if (part.source === "singleton") continue;
      const members = part.refs.map((r) => byRef.get(r)!).filter(Boolean);
      const share = sharedNetCount(comp, members);
      if (share > bestShare || (share > 0 && share === bestShare && (!bestPart || part.id < bestPart.id))) {
        bestShare = share;
        bestPart = part;
      }
    }

    if (bestPart && bestShare > 0) {
      bestPart.refs.push(ref);
      bestPart.refs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      bestPart.hubRef = pickHubRef(design, bestPart.refs);
      assigned.set(ref, bestPart.id);
      attachedCount++;
    } else {
      const id = `singleton_${ref}`;
      partitions.push({
        id,
        kind: "singleton",
        refs: [ref],
        source: "singleton",
        hubRef: ref,
      });
      assigned.set(ref, id);
      singletonCount++;
    }
  }

  // Coverage assert: every component in exactly one partition.
  const seen = new Set<string>();
  for (const part of partitions) {
    for (const r of part.refs) {
      if (seen.has(r)) {
        throw new Error(`derivePartitions: ref ${r} appears in multiple partitions`);
      }
      seen.add(r);
    }
  }
  for (const c of design.components) {
    if (!seen.has(c.ref)) {
      throw new Error(`derivePartitions: component ${c.ref} not assigned to any partition`);
    }
  }

  partitions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    partitions,
    clusteredCount,
    attachedCount,
    singletonCount,
  };
}

/** Flat all-pairs edge count (same construction as compileOscillatorGraph). */
export function countFlatEdges(design: Design, sub: OscSubstrate): number {
  return compileFlatEdgeStats(design, sub).total;
}

function compileFlatEdgeStats(design: Design, sub: OscSubstrate): {
  total: number;
  noisySensitive: number;
} {
  const comps = design.components;
  const idx = new Map<string, number>();
  comps.forEach((c, i) => idx.set(c.ref, i));
  const cond = sub.condition;
  const acc = new Map<string, number>();
  const add = (a: number, b: number) => {
    if (a === b) return;
    const i = Math.min(a, b), j = Math.max(a, b);
    acc.set(`${i},${j}`, (acc.get(`${i},${j}`) || 0) + 1);
  };

  for (const net of design.nets) {
    if (net.classes.includes("ground")) continue;
    const refs = [...new Set(net.pins.map((p) => p.ref))].filter((r) => idx.has(r));
    if (refs.length < 2) continue;
    for (let i = 0; i + 1 < refs.length; i++) add(idx.get(refs[i])!, idx.get(refs[i + 1])!);
  }
  for (const cl of design.clusters) {
    const refs = cl.refs.filter((r) => idx.has(r));
    for (let i = 0; i + 1 < refs.length; i++) add(idx.get(refs[i])!, idx.get(refs[i + 1])!);
  }
  const noisyComps = comps.filter((c) =>
    [...netsOf(c)].some((n) => isClass(design, n, "noisy") || isClass(design, n, "high_current")));
  const sensComps = comps.filter((c) =>
    [...netsOf(c)].some((n) => isClass(design, n, "sensitive")));
  let ns = 0;
  const nsKeys = new Set<string>();
  for (const a of noisyComps) for (const b of sensComps) {
    if (a.ref === b.ref) continue;
    const i = idx.get(a.ref)!, j = idx.get(b.ref)!;
    const lo = Math.min(i, j), hi = Math.max(i, j);
    const key = `${lo},${hi}`;
    if (!nsKeys.has(key)) { nsKeys.add(key); ns++; }
    add(i, j);
  }
  for (const c of comps) {
    if (!["decap", "input_cap", "output_cap"].includes(c.role)) continue;
    const myNets = netsOf(c);
    let best = -1, bestShare = 0;
    for (const ic of comps) {
      if (!["mcu", "regulator", "imu", "adc", "ic", "motor_driver", "rf", "sensor"].includes(ic.role)) continue;
      const share = ic.pins.filter((p) => myNets.has(p.net)).length;
      if (share > bestShare) { bestShare = share; best = idx.get(ic.ref)!; }
    }
    if (best >= 0) add(idx.get(c.ref)!, best);
  }
  void cond;
  return { total: acc.size, noisySensitive: ns };
}

export function boardPrefersHierarchy(design: Design, flatEdgeCount: number): boolean {
  return design.components.length >= HIERARCHY_COMPONENT_THRESHOLD
    || flatEdgeCount > HIERARCHY_FLAT_EDGE_THRESHOLD;
}

/**
 * Resolve active topology mode.
 * @param legacyAbsent when true, ruleset was loaded without topologyMode (legacy).
 */
export function resolveTopologyMode(
  design: Design,
  ruleset: Ruleset,
  sub: OscSubstrate,
  opts: { legacyAbsent?: boolean } = {},
): TopologyDecision {
  const flatEdgeCount = countFlatEdges(design, sub);
  const prefers = boardPrefersHierarchy(design, flatEdgeCount);
  const preferred: TopologyMode = prefers ? "hierarchical" : "flat";

  if (!prefers) {
    return { mode: "flat", preferred, flatEdgeCount, legacyFlatCompat: false };
  }

  // Explicit flat-compat stamped on ruleset.
  if (ruleset.topologyMode === "flat") {
    return { mode: "flat", preferred, flatEdgeCount, legacyFlatCompat: false };
  }

  // Legacy artifact lacking topologyMode → retain flat, emit notice.
  if (opts.legacyAbsent) {
    return {
      mode: "flat",
      preferred,
      flatEdgeCount,
      legacyFlatCompat: true,
      notice: LEGACY_FLAT_TOPOLOGY_NOTICE,
    };
  }

  // Fresh / hierarchical ruleset on an eligible board.
  return { mode: "hierarchical", preferred, flatEdgeCount, legacyFlatCompat: false };
}

function edgeFor(role: Component["role"]): "left" | "right" | "top" | "bottom" | null {
  if (role === "usb" || role === "connector") return "left";
  if (role === "antenna" || role === "rf") return "right";
  return null;
}

function partitionIsNoisy(design: Design, part: OscPartition): boolean {
  const byRef = new Map(design.components.map((c) => [c.ref, c]));
  return part.refs.some((r) => {
    const c = byRef.get(r);
    if (!c) return false;
    return [...netsOf(c)].some((n) => isClass(design, n, "noisy") || isClass(design, n, "high_current"));
  });
}

function partitionIsSensitive(design: Design, part: OscPartition): boolean {
  const byRef = new Map(design.components.map((c) => [c.ref, c]));
  return part.refs.some((r) => {
    const c = byRef.get(r);
    if (!c) return false;
    return [...netsOf(c)].some((n) => isClass(design, n, "sensitive"));
  });
}

/**
 * Compile the sparse hierarchical coupling graph used for viz/stats and as the
 * fine-level edge set (intra + bridge + hub NS + inter-partition repel).
 */
export function compileHierarchicalGraph(
  design: Design,
  hierarchy: OscHierarchy,
  sub: OscSubstrate,
): OscGraph & { stats: OscGraphStats } {
  const comps = design.components;
  const idx = new Map<string, number>();
  comps.forEach((c, i) => idx.set(c.ref, i));
  const cond = sub.condition;
  const partOf = new Map<string, OscPartition>();
  for (const p of hierarchy.partitions) for (const r of p.refs) partOf.set(r, p);

  const acc = new Map<string, { k: number; kind: OscEdge["kind"] }>();
  const addEdge = (a: number, b: number, k: number, kind: OscEdge["kind"]) => {
    if (a === b) return;
    const i = Math.min(a, b), j = Math.max(a, b);
    const key = `${i},${j}`;
    const cur = acc.get(key);
    if (!cur) acc.set(key, { k, kind });
    else { cur.k += k; if (Math.abs(k) > Math.abs(cur.k - k)) cur.kind = kind; }
  };

  let intraCount = 0;
  let bridgeCount = 0;
  let interCount = 0;

  const samePart = (ra: string, rb: string) => partOf.get(ra)?.id === partOf.get(rb)?.id;

  // 1. Intra-partition net chains + cluster cohesion + decap (dense local).
  for (const net of design.nets) {
    if (net.classes.includes("ground")) continue;
    const refs = [...new Set(net.pins.map((p) => p.ref))].filter((r) => idx.has(r));
    if (refs.length < 2) continue;
    const w = sub.attractScale / Math.sqrt(refs.length);
    // Group by partition; chain within each, bridge hubs across partitions.
    const byPart = new Map<string, string[]>();
    for (const r of refs) {
      const pid = partOf.get(r)?.id;
      if (!pid) continue;
      if (!byPart.has(pid)) byPart.set(pid, []);
      byPart.get(pid)!.push(r);
    }
    for (const group of byPart.values()) {
      for (let i = 0; i + 1 < group.length; i++) {
        addEdge(idx.get(group[i])!, idx.get(group[i + 1])!, w, "net");
        intraCount++;
      }
    }
    if (byPart.size >= 2) {
      // Sparse bridge: connect partition hubs that touch this net.
      const hubs: string[] = [];
      for (const [pid, group] of byPart) {
        const part = hierarchy.partitions.find((p) => p.id === pid)!;
        const hub = group.includes(part.hubRef) ? part.hubRef : group.slice().sort()[0]!;
        hubs.push(hub);
      }
      hubs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (let i = 0; i + 1 < hubs.length; i++) {
        addEdge(idx.get(hubs[i])!, idx.get(hubs[i + 1])!, w, "net");
        bridgeCount++;
      }
    }
  }

  for (const cl of design.clusters) {
    const refs = cl.refs.filter((r) => idx.has(r));
    let gain = sub.clusterAttract;
    if (cl.kind === "buck_converter") gain *= cond.buckTight;
    if (cl.kind === "usb_section") gain *= cond.usbBalance;
    // Only intra-partition cluster edges (exclusive members already in one part).
    for (let i = 0; i + 1 < refs.length; i++) {
      if (!samePart(refs[i], refs[i + 1])) continue;
      addEdge(idx.get(refs[i])!, idx.get(refs[i + 1])!, gain, "cluster");
      intraCount++;
    }
  }

  // 2. Hub-to-hub noisy/sensitive: ONE edge per noisy/sensitive partition pair.
  const noisyParts = hierarchy.partitions.filter((p) => partitionIsNoisy(design, p));
  const sensParts = hierarchy.partitions.filter((p) => partitionIsSensitive(design, p));
  for (const np of noisyParts) {
    for (const sp of sensParts) {
      if (np.id === sp.id) continue;
      const ia = idx.get(np.hubRef)!, ib = idx.get(sp.hubRef)!;
      addEdge(ia, ib, -sub.noisySensitiveRepel * cond.noisyAway, "noisy_sensitive");
      interCount++;
    }
  }

  // 3. Inter-partition spacing via repelScale / repelRadius (named consumer).
  // Coupling weight grows with repelScale; radius (mm) scales strength vs board diagonal.
  const boardDiag = Math.hypot(design.board.width, design.board.height) || 1;
  const radiusNorm = Math.min(1, Math.max(0.05, sub.repelRadius / boardDiag));
  const repelK = -sub.repelScale * radiusNorm;
  for (let i = 0; i < hierarchy.partitions.length; i++) {
    for (let j = i + 1; j < hierarchy.partitions.length; j++) {
      const a = hierarchy.partitions[i], b = hierarchy.partitions[j];
      addEdge(idx.get(a.hubRef)!, idx.get(b.hubRef)!, repelK, "repel");
      interCount++;
    }
  }

  // 4. Decap → owning IC (intra-partition preferred; else hub of IC's partition).
  for (const c of comps) {
    if (!["decap", "input_cap", "output_cap"].includes(c.role)) continue;
    const myNets = netsOf(c);
    let best = -1, bestShare = 0;
    for (const ic of comps) {
      if (!["mcu", "regulator", "imu", "adc", "ic", "motor_driver", "rf", "sensor"].includes(ic.role)) continue;
      const share = ic.pins.filter((p) => myNets.has(p.net)).length;
      if (share > bestShare) { bestShare = share; best = idx.get(ic.ref)!; }
    }
    if (best >= 0) {
      addEdge(idx.get(c.ref)!, best, sub.clusterAttract * 0.8 * cond.decapNear, "cluster");
      if (samePart(c.ref, comps[best].ref)) intraCount++;
      else { bridgeCount++; }
    }
  }

  const edges: OscEdge[] = [];
  for (const [key, v] of acc) {
    const [i, j] = key.split(",").map(Number);
    edges.push({ i, j, k: v.k, kind: v.kind });
  }

  const N = comps.length;
  const driveX = new Float64Array(N), driveY = new Float64Array(N), driveStrength = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const e = edgeFor(comps[i].role);
    if (!e) continue;
    const isAnt = comps[i].role === "antenna" || comps[i].role === "rf";
    const strength = sub.driveScale * (isAnt ? cond.antennaEdge : 1) * 1.0;
    driveStrength[i] = strength;
    if (e === "left") { driveX[i] = 0.08; driveY[i] = 0.5; }
    else if (e === "right") { driveX[i] = 0.92; driveY[i] = 0.5; }
    else if (e === "top") { driveX[i] = 0.5; driveY[i] = 0.08; }
    else { driveX[i] = 0.5; driveY[i] = 0.92; }
  }

  const nodes = comps.map((c) => ({
    ref: c.ref, role: c.role, fixed: edgeFor(c.role) !== null,
  }));

  // Recount kinds from final edges for accurate stats.
  let bridgeEdges = 0, intraEdges = 0, interEdges = 0;
  for (const e of edges) {
    const ra = comps[e.i].ref, rb = comps[e.j].ref;
    if (samePart(ra, rb)) intraEdges++;
    else if (e.kind === "net") bridgeEdges++;
    else interEdges++;
  }
  void intraCount; void bridgeCount; void interCount;

  const stats: OscGraphStats = {
    componentCount: N,
    partitionCount: hierarchy.partitions.length,
    clusteredCount: hierarchy.clusteredCount,
    attachedCount: hierarchy.attachedCount,
    singletonCount: hierarchy.singletonCount,
    bridgeEdges,
    intraPartitionEdges: intraEdges,
    interPartitionEdges: interEdges,
    totalSparseEdges: edges.length,
    topologyMode: "hierarchical",
  };

  return { nodes, edges, driveX, driveY, driveStrength, stats };
}

/** Coarse meta-graph: one node per partition (hubs). */
export function compileCoarseGraph(
  design: Design,
  hierarchy: OscHierarchy,
  sub: OscSubstrate,
): OscGraph {
  const parts = hierarchy.partitions;
  const P = parts.length;
  const hubIdx = new Map<string, number>();
  parts.forEach((p, i) => hubIdx.set(p.id, i));
  const byRef = new Map(design.components.map((c) => [c.ref, c]));
  const cond = sub.condition;

  const nodes = parts.map((p) => {
    const hub = byRef.get(p.hubRef)!;
    return { ref: p.hubRef, role: hub.role, fixed: edgeFor(hub.role) !== null };
  });

  const acc = new Map<string, { k: number; kind: OscEdge["kind"] }>();
  const addEdge = (a: number, b: number, k: number, kind: OscEdge["kind"]) => {
    if (a === b) return;
    const i = Math.min(a, b), j = Math.max(a, b);
    const key = `${i},${j}`;
    const cur = acc.get(key);
    if (!cur) acc.set(key, { k, kind });
    else { cur.k += k; if (Math.abs(k) > Math.abs(cur.k - k)) cur.kind = kind; }
  };

  const partOf = new Map<string, string>();
  for (const p of parts) for (const r of p.refs) partOf.set(r, p.id);

  // Bridge nets → coarse attract between partitions.
  for (const net of design.nets) {
    if (net.classes.includes("ground")) continue;
    const pids = new Set<string>();
    for (const pin of net.pins) {
      const pid = partOf.get(pin.ref);
      if (pid) pids.add(pid);
    }
    if (pids.size < 2) continue;
    const list = [...pids].sort();
    const w = sub.attractScale / Math.sqrt(list.length);
    for (let i = 0; i + 1 < list.length; i++) {
      addEdge(hubIdx.get(list[i])!, hubIdx.get(list[i + 1])!, w, "net");
    }
  }

  // Hub noisy/sensitive.
  const noisyParts = parts.filter((p) => partitionIsNoisy(design, p));
  const sensParts = parts.filter((p) => partitionIsSensitive(design, p));
  for (const np of noisyParts) for (const sp of sensParts) {
    if (np.id === sp.id) continue;
    addEdge(hubIdx.get(np.id)!, hubIdx.get(sp.id)!, -sub.noisySensitiveRepel * cond.noisyAway, "noisy_sensitive");
  }

  // Inter-partition spacing (repelScale × repelRadius).
  const boardDiag = Math.hypot(design.board.width, design.board.height) || 1;
  const radiusNorm = Math.min(1, Math.max(0.05, sub.repelRadius / boardDiag));
  const repelK = -sub.repelScale * radiusNorm;
  for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) {
    addEdge(i, j, repelK, "repel");
  }

  const edges: OscEdge[] = [];
  for (const [key, v] of acc) {
    const [i, j] = key.split(",").map(Number);
    edges.push({ i, j, k: v.k, kind: v.kind });
  }

  const driveX = new Float64Array(P), driveY = new Float64Array(P), driveStrength = new Float64Array(P);
  for (let i = 0; i < P; i++) {
    const hub = byRef.get(parts[i].hubRef)!;
    const e = edgeFor(hub.role);
    if (!e) continue;
    const isAnt = hub.role === "antenna" || hub.role === "rf";
    driveStrength[i] = sub.driveScale * (isAnt ? cond.antennaEdge : 1);
    if (e === "left") { driveX[i] = 0.08; driveY[i] = 0.5; }
    else if (e === "right") { driveX[i] = 0.92; driveY[i] = 0.5; }
    else if (e === "top") { driveX[i] = 0.5; driveY[i] = 0.08; }
    else { driveX[i] = 0.5; driveY[i] = 0.92; }
  }

  return { nodes, edges, driveX, driveY, driveStrength };
}

/**
 * Build the fine (component) graph for hierarchical integration: dense intra
 * edges only, plus soft drives toward coarse partition centers.
 */
export function compileFineGraphWithRegionDrives(
  design: Design,
  hierarchy: OscHierarchy,
  sub: OscSubstrate,
  centers01: { x: number; y: number }[],
): OscGraph {
  const comps = design.components;
  const idx = new Map<string, number>();
  comps.forEach((c, i) => idx.set(c.ref, i));
  const cond = sub.condition;
  const partIndex = new Map<string, number>();
  hierarchy.partitions.forEach((p, i) => {
    for (const r of p.refs) partIndex.set(r, i);
  });

  const acc = new Map<string, { k: number; kind: OscEdge["kind"] }>();
  const addEdge = (a: number, b: number, k: number, kind: OscEdge["kind"]) => {
    if (a === b) return;
    const i = Math.min(a, b), j = Math.max(a, b);
    const key = `${i},${j}`;
    const cur = acc.get(key);
    if (!cur) acc.set(key, { k, kind });
    else { cur.k += k; if (Math.abs(k) > Math.abs(cur.k - k)) cur.kind = kind; }
  };

  const samePart = (ra: string, rb: string) => partIndex.get(ra) === partIndex.get(rb);

  for (const net of design.nets) {
    if (net.classes.includes("ground")) continue;
    const refs = [...new Set(net.pins.map((p) => p.ref))].filter((r) => idx.has(r));
    if (refs.length < 2) continue;
    const w = sub.attractScale / Math.sqrt(refs.length);
    for (let i = 0; i + 1 < refs.length; i++) {
      if (!samePart(refs[i], refs[i + 1])) continue;
      addEdge(idx.get(refs[i])!, idx.get(refs[i + 1])!, w, "net");
    }
  }

  for (const cl of design.clusters) {
    const refs = cl.refs.filter((r) => idx.has(r));
    let gain = sub.clusterAttract;
    if (cl.kind === "buck_converter") gain *= cond.buckTight;
    if (cl.kind === "usb_section") gain *= cond.usbBalance;
    for (let i = 0; i + 1 < refs.length; i++) {
      if (!samePart(refs[i], refs[i + 1])) continue;
      addEdge(idx.get(refs[i])!, idx.get(refs[i + 1])!, gain, "cluster");
    }
  }

  // Intra-partition noisy/sensitive (keep local EE separation).
  for (const part of hierarchy.partitions) {
    const members = part.refs.map((r) => comps[idx.get(r)!]);
    const noisy = members.filter((c) =>
      [...netsOf(c)].some((n) => isClass(design, n, "noisy") || isClass(design, n, "high_current")));
    const sens = members.filter((c) =>
      [...netsOf(c)].some((n) => isClass(design, n, "sensitive")));
    for (const a of noisy) for (const b of sens) {
      if (a.ref === b.ref) continue;
      addEdge(idx.get(a.ref)!, idx.get(b.ref)!, -sub.noisySensitiveRepel * cond.noisyAway, "noisy_sensitive");
    }
  }

  for (const c of comps) {
    if (!["decap", "input_cap", "output_cap"].includes(c.role)) continue;
    const myNets = netsOf(c);
    let best = -1, bestShare = 0;
    for (const ic of comps) {
      if (!["mcu", "regulator", "imu", "adc", "ic", "motor_driver", "rf", "sensor"].includes(ic.role)) continue;
      if (!samePart(c.ref, ic.ref)) continue;
      const share = ic.pins.filter((p) => myNets.has(p.net)).length;
      if (share > bestShare) { bestShare = share; best = idx.get(ic.ref)!; }
    }
    if (best >= 0) addEdge(idx.get(c.ref)!, best, sub.clusterAttract * 0.8 * cond.decapNear, "cluster");
  }

  const edges: OscEdge[] = [];
  for (const [key, v] of acc) {
    const [i, j] = key.split(",").map(Number);
    edges.push({ i, j, k: v.k, kind: v.kind });
  }

  const N = comps.length;
  const driveX = new Float64Array(N), driveY = new Float64Array(N), driveStrength = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const e = edgeFor(comps[i].role);
    if (e) {
      const isAnt = comps[i].role === "antenna" || comps[i].role === "rf";
      driveStrength[i] = sub.driveScale * (isAnt ? cond.antennaEdge : 1);
      if (e === "left") { driveX[i] = 0.08; driveY[i] = 0.5; }
      else if (e === "right") { driveX[i] = 0.92; driveY[i] = 0.5; }
      else if (e === "top") { driveX[i] = 0.5; driveY[i] = 0.08; }
      else { driveX[i] = 0.5; driveY[i] = 0.92; }
      continue;
    }
    // Soft drive toward coarse partition region.
    const pi = partIndex.get(comps[i].ref);
    if (pi === undefined) continue;
    const c = centers01[pi];
    driveX[i] = c.x;
    driveY[i] = c.y;
    driveStrength[i] = 0.55 * sub.driveScale;
  }

  const nodes = comps.map((c) => ({
    ref: c.ref, role: c.role, fixed: edgeFor(c.role) !== null,
  }));

  return { nodes, edges, driveX, driveY, driveStrength };
}

/** Push partition centers apart when closer than repelRadius (uses repelScale). */
export function separateCenters(
  centers: { x: number; y: number }[],
  boardW: number,
  boardH: number,
  repelRadiusMm: number,
  repelScale: number,
): void {
  const minDist = Math.max(1, repelRadiusMm);
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        let dx = centers[j].x - centers[i].x;
        let dy = centers[j].y - centers[i].y;
        // centers are in mm here
        const d = Math.hypot(dx, dy) || 1e-6;
        if (d >= minDist) continue;
        moved = true;
        const push = ((minDist - d) / 2) * (0.35 + 0.65 * Math.min(2, repelScale));
        dx /= d; dy /= d;
        centers[i].x = Math.min(boardW - 2, Math.max(2, centers[i].x - dx * push));
        centers[i].y = Math.min(boardH - 2, Math.max(2, centers[i].y - dy * push));
        centers[j].x = Math.min(boardW - 2, Math.max(2, centers[j].x + dx * push));
        centers[j].y = Math.min(boardH - 2, Math.max(2, centers[j].y + dy * push));
      }
    }
    if (!moved) break;
  }
}

export function flatGraphStats(design: Design, edgeCount: number): OscGraphStats {
  return {
    componentCount: design.components.length,
    partitionCount: 1,
    clusteredCount: design.components.filter((c) => c.clusterId).length,
    attachedCount: 0,
    singletonCount: 0,
    bridgeEdges: 0,
    intraPartitionEdges: edgeCount,
    interPartitionEdges: 0,
    totalSparseEdges: edgeCount,
    topologyMode: "flat",
    flatEdgeCount: edgeCount,
  };
}
