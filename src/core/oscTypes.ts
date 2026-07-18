// Shared contracts for the coupled-oscillator optimizer and the EMI validator.
//
// The oscillator SUBSTRATE (couplings, frequencies, drives, integrator params)
// is the object the RSI loop recursively improves. Layouts are decoded from the
// synchronized phase field; the substrate is what gets mutated and promoted.

import { Role, TopologyMode } from "./types";

// ---------- the promotable substrate ----------
// Low-dimensional, GPU-friendly parameterization of the oscillator dynamics.
// Mutating these scalars changes how topology synchronizes into placements.
export interface OscSubstrate {
  version: number;
  // coupling gains (Kuramoto K is built from the netlist; these scale it)
  attractScale: number;        // net-edge attraction (synchronize -> place together)
  clusterAttract: number;      // extra intra-cluster attraction (buck/usb/...)
  /** Inter-partition spacing gain (hierarchical coarse/fine + center separation). */
  repelScale: number;
  /** Spatial range (mm) for inter-partition center separation. */
  repelRadius: number;
  noisySensitiveRepel: number; // anti-coupling between noisy and sensitive nets
  driveScale: number;          // anchor/edge drive gain (omega bias terms)
  // integrator
  inertia: number;             // 0 = first-order Kuramoto, >0 = second-order (inertial)
  damping: number;             // velocity damping for the inertial term
  dt: number;
  steps: number;
  // phase -> coordinate readout: coord = sigmoid(a*sin θ + b*cos θ)
  readout: { ax: number; bx: number; ay: number; by: number };
  // conditioning block: condition oscillators drive the main population.
  // these gains scale how strongly each board "intent" steers the field.
  condition: {
    antennaEdge: number;
    buckTight: number;
    noisyAway: number;
    decapNear: number;
    usbBalance: number;
  };
}

// ---------- hierarchy (cluster-derived partitions) ----------
export interface OscPartition {
  id: string;
  kind: string;
  refs: string[];
  source: "cluster" | "attached" | "singleton";
  clusterId?: string;
  hubRef: string;
}
export interface OscHierarchy {
  partitions: OscPartition[];
  clusteredCount: number;
  attachedCount: number;
  singletonCount: number;
}
export interface OscGraphStats {
  componentCount: number;
  partitionCount: number;
  clusteredCount: number;
  attachedCount: number;
  singletonCount: number;
  bridgeEdges: number;
  intraPartitionEdges: number;
  interPartitionEdges: number;
  totalSparseEdges: number;
  topologyMode: TopologyMode;
  flatEdgeCount?: number;
}

// ---------- compiled oscillator graph ----------
export interface OscNode {
  ref: string;       // owning component
  role: Role;
  fixed: boolean;    // anchored (edge) -> phase driven hard
  anchor?: { x: number; y: number }; // target board coords for driven nodes
}
export interface OscEdge {
  i: number;         // node index
  j: number;
  k: number;         // coupling weight (>0 attract / sync, <0 repel / anti-phase)
  kind: "net" | "cluster" | "repel" | "noisy_sensitive";
}
export interface OscGraph {
  nodes: OscNode[];
  edges: OscEdge[];
  // per-node drive toward an anchored board position (0..1 strength), from the
  // conditioning block (edges, antenna, connectors, ...).
  driveX: Float64Array;
  driveY: Float64Array;
  driveStrength: Float64Array;
  stats?: OscGraphStats;
}

// ---------- visualization payload (for renderOscillatorSVG) ----------
export interface OscVizNode { ref: string; role: string; thetaX: number; thetaY: number; x: number; y: number; }
export interface OscVizEdge { i: number; j: number; k: number; kind: string; }
export interface OscViz {
  nodes: OscVizNode[];
  edges: OscVizEdge[];
  order: number[];         // Kuramoto order parameter R(t) per step (global sync)
  orderX: number[];        // sync of x-phases over time
  steps: number;
  substrateVersion: number;
  batch: number;           // how many phase seeds were raced
  hierarchy?: OscGraphStats;
}

// ---------- EMI validation report ----------
export interface EmiLevel {
  cellMm: number;
  risk: number;        // aggregate field risk at this resolution
  peak: number;        // peak |u| anywhere
  probeEnergy: number; // energy integrated at sensitive probes
}
export interface EmiField {
  cellMm: number;
  w: number;           // grid columns
  h: number;           // grid rows
  data: number[];      // row-major max|u| over time, normalized 0..1
}
export interface EmiReport {
  model: "progressive_damped_wave_2p5d";
  /** Always EMI_SCOPE_CLAIM — relative ranking, not absolute field / compliance. */
  scope: string;
  levels: EmiLevel[];
  /** Refinement stability / ranking confidence across cell sizes — not EMC compliance. */
  converged: boolean;
  convergenceDeltaPct: number;
  sensitiveProbeMax: string;  // net name receiving the most field energy
  verdict: string;
  field: EmiField;            // finest-level field, for the heatmap tab
  riskByProbe: { net: string; energy: number }[];
}
