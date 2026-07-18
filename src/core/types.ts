// Central intermediate representation (IR) shared across the whole pipeline.
import { Box, Pt } from "./geometry";
import { FootprintAssumption, FootprintGeom } from "./footprints";
export type { FootprintAssumption };

// ---------- roles & net classes ----------
export type Role =
  | "mcu" | "regulator" | "inductor" | "input_cap" | "output_cap" | "decap"
  | "resistor" | "diode" | "led" | "mosfet" | "connector" | "usb" | "crystal"
  | "imu" | "adc" | "sensor" | "rf" | "antenna" | "motor_driver" | "testpoint"
  | "mounting" | "fuse" | "passive" | "ic" | "unknown";

export type NetClass = "ground" | "power" | "high_current" | "noisy" | "sensitive"
  | "usb" | "clock" | "rf" | "signal";

// ---------- schematic-derived structures ----------
export interface PinRef {
  ref: string;   // component reference, e.g. "U1"
  pad: string;   // pad/pin number, e.g. "3"
}
export interface Net {
  name: string;
  code: number;
  pins: PinRef[];
  classes: NetClass[];
  priority: number;       // routing priority (higher = routed earlier)
  currentA?: number;
}
export interface CompPin {
  num: string;
  name: string;
  net: string;
}
export interface Component {
  ref: string;
  value: string;
  libId: string;          // footprint identifier
  pins: CompPin[];
  role: Role;
  clusterId?: string;
  fixed?: boolean;        // pose chosen by an anchor rule, not optimized
}
export interface Cluster {
  id: string;
  kind: string;           // "buck_converter" | "usb_section" | "rf_section" | ...
  refs: string[];
  criticalNets: string[];
  objective?: string;
}

// ---------- board / config ----------
export interface MountingHole { x: number; y: number; drill: number; keepout: number; }
export interface DiffPair { p: string; n: string; spacing: number; }
export interface BoardSpec {
  name: string;
  width: number;
  height: number;
  layers: number;
  mountingHoles: MountingHole[];
  defaultTraceW: number;
  clearance: number;
  powerTraceW: number;
  highCurrentTraceW: number;
  viaDrill: number;
  viaDia: number;
  diffPairs: DiffPair[];
}

// ---------- full design IR ----------
export interface Design {
  name: string;
  components: Component[];
  nets: Net[];
  clusters: Cluster[];
  board: BoardSpec;
  footprints: Record<string, FootprintGeom>; // keyed by ref
  /** Always present; empty array when no parametric assumptions were made. */
  footprintAssumptions: FootprintAssumption[];
}

// ---------- layout (placement + routing) ----------
export type Side = "front" | "back";
export interface Placement {
  ref: string;
  x: number;
  y: number;
  rot: number;
  side: Side;
}
export interface RouteSegment {
  net: string;
  layer: "F.Cu" | "B.Cu";
  width: number;
  a: Pt;
  b: Pt;
}
export interface Via { at: Pt; net: string; }
export interface Layout {
  placements: Record<string, Placement>;
  routes: RouteSegment[];
  vias: Via[];
  keepouts: Keepout[];
}
export interface Keepout {
  name: string;
  box: Box;
  reason: string;
}

// ---------- scoring ----------
export interface Hotspot {
  kind: string;
  severity: "low" | "medium" | "high";
  at: Pt;
  message: string;
  suggestedAction: string;
  refs?: string[];
  nets?: string[];
}
export interface FieldScores {
  coupling: number;
  returnPath: number;
  switching: number;
  antenna: number;
  thermal: number;
}
export interface Score {
  total: number;
  terms: Record<string, number>;
  drcErrors: number;
  drcWarnings: number;
  ratsnestLen: number;
  ratsnestCrossings: number;
  courtyardOverlaps: number;
  routeCompletion: number;
  switchLoopArea: number;
  field: FieldScores;
  hotspots: Hotspot[];
}

// ---------- learned rules ----------
export type RuleKind =
  | "anchor_edge"
  | "cluster_tight"
  | "place_near"
  | "push_away"
  | "keepout"
  | "route_critical";

export interface Rule {
  id: string;
  name: string;
  kind: RuleKind;
  trigger: {
    roles?: Role[];
    netClasses?: NetClass[];
    clusterKinds?: string[];
  };
  params: Record<string, any>;
  status: "candidate" | "promoted" | "rejected";
  origin: string;        // human feedback text or "auto:<hotspot kind>"
  createdIter: number;
}

export interface Ruleset {
  rules: Rule[];
  version: number;
  // The coupled-oscillator optimizer substrate — the parameters the RSI loop
  // recursively improves. Typed as `any` here to avoid a cyclic import with
  // oscTypes; the concrete shape is OscSubstrate.
  substrate?: any;
  /**
   * Board this ruleset/substrate was evolved against. Content-hash of the
   * schematic text (not filename) so renames/copies don't break detection.
   * Absent on legacy *.rules.json → loaders must not guess transfer vs continue.
   */
  provenance?: RulesetProvenance;
}

/** Provenance recorded on every new ruleset write (learn / synth with promotion). */
export interface RulesetProvenance {
  /** sha256 hex of the schematic file contents used for evolution. */
  schematicHash: string;
  /** Human-readable board label for CLI/report (e.g. design name). */
  boardLabel: string;
}

// ---------- iteration / improvement history ----------
export interface IterationRecord {
  iter: number;
  rawScore: number;
  bestScore: number;
  terms: Record<string, number>;
  drcErrors: number;
  switchLoopArea: number;
  coupling: number;
  routeCompletion: number;
  rulesActive: number;
  promoted: string[];     // rule ids/names promoted this iteration
  note: string;
}
export interface ImproveResult {
  design: Design;
  best: { layout: Layout; score: Score };
  history: IterationRecord[];
  ruleset: Ruleset;
  /**
   * Set when --feedback was passed under optimizer=oscillator: symbolic rules
   * are anneal-only; this run's learning channel is substrate mutation.
   */
  feedbackScopeNotice?: string;
  /**
   * Set when a loaded ruleset triggered (or explicitly skipped) cross-board
   * cold/warm racing — see transferRace.ts.
   */
  transferRace?: TransferRaceReport;
  /** Legacy ruleset lacked provenance — auto-detection skipped (continuation). */
  provenanceNotice?: string;
}

/** Head-to-head cold vs warm transfer race (cross-board only). */
export interface TransferRaceReport {
  triggered: boolean;
  reason: "same_board" | "cross_board" | "legacy_no_provenance" | "no_loaded_ruleset";
  sourceBoardLabel?: string;
  targetBoardLabel?: string;
  coldScore?: number;
  warmScore?: number;
  winner?: "cold" | "warm";
  /** winner.score - loser.score (negative means winner is better / lower). */
  delta?: number;
  notice?: string;
}
