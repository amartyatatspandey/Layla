// Gate: cluster-derived hierarchical sparse oscillator coupling.
import * as fs from "fs";
import * as path from "path";
import {
  compileDesign, compileOscillatorGraph, compileHierarchicalGraph,
  compileActiveOscillatorGraph, derivePartitions, decideOscillatorTopology,
  defaultSubstrate, defaultRuleset, oscillatorPlace, createOscillatorBackend,
  improve, improveWithLoadedRuleset, LEGACY_FLAT_TOPOLOGY_NOTICE,
  HIERARCHY_COMPONENT_THRESHOLD, HIERARCHY_FLAT_EDGE_THRESHOLD,
  RNG,
} from "../core";
import { Ruleset } from "../core/types";

const ROOT = path.join(__dirname, "..", "..");
const EX = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "build", "gate-osc-hierarchy");

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

function partitionCoverage(): void {
  console.log("\n=== partition coverage + cluster fidelity ===");
  for (const name of ["buck_imu", "robot_soc", "mainboard"]) {
    const { design } = loadDesign(name);
    const h = derivePartitions(design);
    const seen = new Set<string>();
    for (const p of h.partitions) {
      for (const r of p.refs) {
        assert(!seen.has(r), `${name}: ref ${r} unique across partitions`);
        seen.add(r);
      }
    }
    assert(seen.size === design.components.length, `${name}: every component in exactly one partition`);
    // Cluster fidelity: every component with clusterId lands in that cluster's partition.
    for (const c of design.components) {
      if (!c.clusterId) continue;
      const part = h.partitions.find((p) => p.id === c.clusterId);
      assert(!!part && part.refs.includes(c.ref), `${name}: ${c.ref} in cluster partition ${c.clusterId}`);
    }
    assert(h.clusteredCount + h.attachedCount + h.singletonCount === design.components.length,
      `${name}: clustered+attached+singleton counts cover all comps`);
  }
}

function deterministicAttachment(): void {
  console.log("\n=== deterministic unclustered attachment ===");
  const { design } = loadDesign("mainboard");
  const a = derivePartitions(design);
  const b = derivePartitions(design);
  assert(JSON.stringify(a) === JSON.stringify(b), "derivePartitions is deterministic");
  assert(a.attachedCount > 0 || a.singletonCount > 0, "mainboard has attached or singleton partitions");
}

function hierarchyThreshold(): void {
  console.log("\n=== hierarchy threshold behavior ===");
  const sub = defaultSubstrate();
  const rs = defaultRuleset();

  const buck = loadDesign("buck_imu").design;
  const buckDec = decideOscillatorTopology(buck, rs, sub);
  assert(buck.components.length < HIERARCHY_COMPONENT_THRESHOLD, "buck_imu below component threshold");
  assert(buckDec.flatEdgeCount <= HIERARCHY_FLAT_EDGE_THRESHOLD, "buck_imu flat edges ≤ 400");
  assert(buckDec.mode === "flat", "buck_imu stays flat");

  const main = loadDesign("mainboard").design;
  const mainDec = decideOscillatorTopology(main, rs, sub);
  assert(
    main.components.length >= HIERARCHY_COMPONENT_THRESHOLD || mainDec.flatEdgeCount > HIERARCHY_FLAT_EDGE_THRESHOLD,
    "mainboard qualifies for hierarchy",
  );
  assert(mainDec.mode === "hierarchical", "mainboard fresh ruleset → hierarchical");

  const robot = loadDesign("robot_soc").design;
  const robotDec = decideOscillatorTopology(robot, rs, sub);
  assert(robotDec.mode === "hierarchical", "robot_soc (≥64 comps) → hierarchical");
}

function legacyFlatCompatNotice(): void {
  console.log("\n=== explicit legacy flat compatibility notice ===");
  const { design, sch } = loadDesign("mainboard");
  const legacy: Ruleset = {
    rules: [],
    version: 1,
    substrate: defaultSubstrate(),
    // no topologyMode, no provenance
  };
  const res = improveWithLoadedRuleset(design, {
    schematicText: sch,
    boardLabel: "mainboard",
    loadedRuleset: legacy,
    iterations: 1,
    optimizer: "oscillator",
    seed: 3,
    batch: 2,
    polish: 0,
  });
  assert(res.topologyModeNotice === LEGACY_FLAT_TOPOLOGY_NOTICE, "legacy flat-compat notice emitted");
  assert(res.ruleset.topologyMode === "flat", "legacy run stamps topologyMode=flat");
  const placed = oscillatorPlace(design, legacy, legacy.substrate!, {
    batch: 1, seed: 1, legacyTopologyAbsent: true,
  });
  assert(placed.topologyDecision.mode === "flat", "legacy place uses flat mode");
  assert(placed.topologyDecision.legacyFlatCompat === true, "legacyFlatCompat flag set");
}

function hubPairRepulsion(): void {
  console.log("\n=== hub-pair noisy/sensitive repulsion ===");
  const { design } = loadDesign("mainboard");
  const sub = defaultSubstrate();
  const flat = compileOscillatorGraph(design, defaultRuleset(), sub);
  const flatNs = flat.edges.filter((e) => e.kind === "noisy_sensitive").length;
  assert(flat.edges.length === 1769, `flat baseline total edges=1769 (got ${flat.edges.length})`);
  assert(flatNs === 1397, `flat baseline noisy_sensitive=1397 (got ${flatNs})`);

  const h = derivePartitions(design);
  const hier = compileHierarchicalGraph(design, h, sub);
  const hierNs = hier.edges.filter((e) => e.kind === "noisy_sensitive");
  // Exactly one edge per noisy/sensitive partition pair (undirected unique).
  const hubPairs = new Set<string>();
  for (const e of hierNs) {
    const a = design.components[e.i].ref, b = design.components[e.j].ref;
    hubPairs.add([a, b].sort().join("|"));
  }
  assert(hubPairs.size === hierNs.length, "each NS edge is a unique hub pair");
  assert(hierNs.length < flatNs, `hub-pair NS ${hierNs.length} << flat ${flatNs}`);
  assert(hierNs.length < 400, `hub-pair NS count bounded (got ${hierNs.length})`);

  // No all-pairs member repulsion: every NS endpoint is a partition hub.
  const hubs = new Set(h.partitions.map((p) => p.hubRef));
  for (const e of hierNs) {
    const a = design.components[e.i].ref, b = design.components[e.j].ref;
    assert(hubs.has(a) && hubs.has(b), `NS endpoints are hubs (${a}, ${b})`);
  }
}

function mainboardEdgeReduction(): void {
  console.log("\n=== mainboard sparse edge reduction ===");
  const { design } = loadDesign("mainboard");
  const sub = defaultSubstrate();
  const rs = defaultRuleset();
  const { graph, decision, stats } = compileActiveOscillatorGraph(design, rs, sub);
  assert(decision.mode === "hierarchical", "active graph is hierarchical");
  assert(graph.edges.length === stats.totalSparseEdges, "stats.totalSparseEdges matches");
  assert(stats.totalSparseEdges < 1769 * 0.5, `sparse edges < 50% of 1769 (got ${stats.totalSparseEdges})`);
  assert(stats.totalSparseEdges < 900, `sparse edges budget (got ${stats.totalSparseEdges})`);
  assert(stats.bridgeEdges > 0, `bridge edges present (got ${stats.bridgeEdges})`);
  assert(stats.intraPartitionEdges > 0, "intra-partition edges present");
  assert(stats.interPartitionEdges > 0, "inter-partition edges present");
  assert(stats.topologyMode === "hierarchical", "stats report hierarchical mode");
  console.log(`  info: mainboard sparse=${stats.totalSparseEdges} bridge=${stats.bridgeEdges} ` +
    `intra=${stats.intraPartitionEdges} inter=${stats.interPartitionEdges} ` +
    `parts=${stats.partitionCount} clustered=${stats.clusteredCount} ` +
    `attached=${stats.attachedCount} singleton=${stats.singletonCount}`);
}

function stableSameSeed(): void {
  console.log("\n=== stable same-seed output ===");
  const { design } = loadDesign("mainboard");
  const rs = defaultRuleset();
  const sub = defaultSubstrate();
  const a = oscillatorPlace(design, rs, sub, { batch: 2, seed: 42 });
  const b = oscillatorPlace(design, rs, sub, { batch: 2, seed: 42 });
  assert(a.topologyDecision.mode === "hierarchical", "mainboard hierarchical place");
  for (let i = 0; i < a.layouts.length; i++) {
    const pa = a.layouts[i].placements, pb = b.layouts[i].placements;
    for (const ref of Object.keys(pa)) {
      assert(
        Math.abs(pa[ref].x - pb[ref].x) < 1e-9 && Math.abs(pa[ref].y - pb[ref].y) < 1e-9,
        `seed 42 layout[${i}] ${ref} identical`,
      );
    }
  }
}

function smallBoardFlatParity(): void {
  console.log("\n=== small-board flat parity ===");
  const { design } = loadDesign("buck_imu");
  const rs = defaultRuleset();
  const sub = defaultSubstrate();
  const flat = compileOscillatorGraph(design, rs, sub);
  const active = compileActiveOscillatorGraph(design, rs, sub);
  assert(active.decision.mode === "flat", "buck_imu active mode flat");
  assert(active.graph.edges.length === flat.edges.length, "flat edge count parity with compileOscillatorGraph");
  // Same seed → identical placements (flat path unchanged).
  const a = oscillatorPlace(design, rs, sub, { batch: 1, seed: 7 });
  const b = oscillatorPlace(design, rs, sub, { batch: 1, seed: 7 });
  const pa = a.layouts[0].placements, pb = b.layouts[0].placements;
  for (const ref of Object.keys(pa)) {
    assert(
      Math.abs(pa[ref].x - pb[ref].x) < 1e-9 && Math.abs(pa[ref].y - pb[ref].y) < 1e-9,
      `buck_imu seed 7 ${ref} stable`,
    );
  }
}

function backendContract(): void {
  console.log("\n=== createOscillatorBackend().place() returns { layout } only ===");
  const { design } = loadDesign("buck_imu");
  const rs = defaultRuleset();
  rs.substrate = defaultSubstrate();
  const backend = createOscillatorBackend();
  const cand = backend.place({
    design,
    ruleset: rs,
    rng: new RNG(1),
    seed: 1,
    batch: 2,
    polish: 0,
  });
  const keys = Object.keys(cand).sort();
  assert(keys.length === 1 && keys[0] === "layout", `CandidateLayout keys=[${keys.join(",")}]`);
}

function stampOnWrite(): void {
  console.log("\n=== topologyMode stamped on ruleset write ===");
  const { design } = loadDesign("robot_soc");
  const res = improve(design, {
    iterations: 1,
    optimizer: "oscillator",
    seed: 11,
    batch: 2,
    polish: 0,
  });
  assert(res.ruleset.topologyMode === "hierarchical", "fresh robot_soc stamps hierarchical");
  assert(!res.topologyModeNotice, "no legacy notice on fresh run");
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  partitionCoverage();
  deterministicAttachment();
  hierarchyThreshold();
  legacyFlatCompatNotice();
  hubPairRepulsion();
  mainboardEdgeReduction();
  stableSameSeed();
  smallBoardFlatParity();
  backendContract();
  stampOnWrite();

  if (failures) {
    console.error(`\nFAIL: ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\nPASS: osc hierarchy");
}

main();
