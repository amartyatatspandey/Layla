// Central intermediate representation (IR) shared across the whole pipeline.
import { Box, Pt } from "./geometry";
import { FootprintGeom } from "./footprints";

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
  | "weight"
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
  weightDeltas?: Record<string, number>; // adjustments to objective weights
  status: "candidate" | "promoted" | "rejected";
  origin: string;        // human feedback text or "auto:<hotspot kind>"
  createdIter: number;
}

export interface Ruleset {
  rules: Rule[];
  weights: Record<string, number>;  // objective term weights (tuned over time)
  version: number;
  // The coupled-oscillator optimizer substrate — the parameters the RSI loop
  // recursively improves. Typed as `any` here to avoid a cyclic import with
  // oscTypes; the concrete shape is OscSubstrate.
  substrate?: any;
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
}
