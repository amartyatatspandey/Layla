// Parse a .kicad_sch and derive a netlist entirely offline (no kicad-cli).
//
// Connectivity is recovered by union-find over: wire endpoints, symbol pin
// connection points (coincident positions merge), and label names (same label
// text merges, matching KiCad single-sheet behaviour). Power symbols contribute
// a global label equal to their value.

import {
  parse, child, childrenOf, head, fieldNum, fieldStr, strOf, numOf, isList,
  SList, SNode,
} from "./sexpr";
import { Pt, rotate } from "./geometry";

export interface RawPin { num: string; name: string; world: Pt; }
export interface RawComponent {
  ref: string;
  value: string;
  libId: string;
  footprint: string;
  pins: RawPin[];
}
export interface RawNet { name: string; pins: { ref: string; pad: string }[]; }
export interface RawNetlist { components: RawComponent[]; nets: RawNet[]; }

const QUANT = 1000; // 0.001mm grid for coincidence

function key(p: Pt): string {
  return `${Math.round(p.x * QUANT)},${Math.round(p.y * QUANT)}`;
}

// Shared symbol pin transform used by BOTH parser and example generator.
export function symPinWorld(at: { x: number; y: number; rot: number }, mirror: string, local: Pt): Pt {
  let lx = local.x, ly = local.y;
  if (mirror === "x") ly = -ly;
  else if (mirror === "y") lx = -lx;
  const r = rotate({ x: lx, y: ly }, at.rot);
  return { x: at.x + r.x, y: at.y + r.y };
}

interface LibPin { num: string; name: string; local: Pt; }

function parseLibSymbols(root: SList): Map<string, LibPin[]> {
  const m = new Map<string, LibPin[]>();
  const ln = child(root, "lib_symbols");
  if (!ln) return m;
  for (const s of childrenOf(ln, "symbol")) {
    const id = strOf(s.items[1]);
    const pins: LibPin[] = [];
    const collectPins = (sub: SList) => {
      for (const p of childrenOf(sub, "pin")) {
        const at = child(p, "at");
        const local: Pt = at ? { x: numOf(at.items[1]), y: numOf(at.items[2]) } : { x: 0, y: 0 };
        const num = fieldStr(p, "number");
        const name = fieldStr(p, "name");
        pins.push({ num, name, local });
      }
    };
    collectPins(s);
    for (const sub of childrenOf(s, "symbol")) collectPins(sub);
    m.set(id, pins);
  }
  return m;
}

// Union-Find
class UF {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = x;
    while (this.parent.get(c) !== c) { const n = this.parent.get(c)!; this.parent.set(c, r); c = n; }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function parseSchematic(text: string): RawNetlist {
  const root = parse(text);
  if (head(root) !== "kicad_sch") throw new Error("not a .kicad_sch file");
  const libPins = parseLibSymbols(root);

  const components: RawComponent[] = [];
  const uf = new UF();
  // point -> node id (we attach by coincident position)
  const posNode = new Map<string, string>();
  const nodePos = (p: Pt): string => {
    const k = key(p);
    if (!posNode.has(k)) posNode.set(k, "pos:" + k);
    return posNode.get(k)!;
  };
  // label-name -> list of node ids
  const labelGroups = new Map<string, string[]>();
  const pinNetNode = new Map<string, string>(); // "REF:pad" -> node id
  const nameVotes = new Map<string, { power: Set<string>; local: Set<string> }>();

  // 1. symbols (components + power)
  for (const s of childrenOf(root, "symbol")) {
    const libId = fieldStr(s, "lib_id");
    const at = child(s, "at");
    const pose = at ? { x: numOf(at.items[1]), y: numOf(at.items[2]), rot: numOf(at.items[3], 0) } : { x: 0, y: 0, rot: 0 };
    const mirror = fieldStr(s, "mirror");
    let ref = "", value = "", footprint = "";
    for (const prop of childrenOf(s, "property")) {
      const pname = strOf(prop.items[1]);
      const pval = strOf(prop.items[2]);
      if (pname === "Reference") ref = pval;
      else if (pname === "Value") value = pval;
      else if (pname === "Footprint") footprint = pval;
    }
    const pins = libPins.get(libId) || [];
    const isPower = libId.startsWith("power:") || ref.startsWith("#PWR") || ref.startsWith("#");
    if (isPower) {
      // power symbol: its single pin is a global label named by value
      for (const lp of pins) {
        const w = symPinWorld(pose, mirror, lp.local);
        const nd = nodePos(w);
        addLabel(labelGroups, value || ref, nd);
        voteName(nameVotes, value || ref, nd, "power");
      }
      continue;
    }
    if (!ref) continue;
    const rc: RawComponent = { ref, value, libId, footprint, pins: [] };
    for (const lp of pins) {
      const w = symPinWorld(pose, mirror, lp.local);
      const nd = nodePos(w);
      const pinKey = `${ref}:${lp.num}`;
      pinNetNode.set(pinKey, nd);
      rc.pins.push({ num: lp.num, name: lp.name, world: w });
    }
    components.push(rc);
  }

  // 2. wires (union coincident endpoints / segments)
  for (const w of childrenOf(root, "wire")) {
    const pts = readPts(w);
    for (let i = 0; i + 1 < pts.length; i++) {
      uf.union(nodePos(pts[i]), nodePos(pts[i + 1]));
    }
  }
  // buses ignored for connectivity in this lightweight netlister

  // 3. labels (local + global + hierarchical)
  const labelTags = ["label", "global_label", "hierarchical_label"];
  for (const tag of labelTags) {
    for (const l of childrenOf(root, tag)) {
      const name = strOf(l.items[1]);
      const at = child(l, "at");
      if (!at) continue;
      const p: Pt = { x: numOf(at.items[1]), y: numOf(at.items[2]) };
      const nd = nodePos(p);
      addLabel(labelGroups, name, nd);
      voteName(nameVotes, name, nd, tag === "label" ? "local" : "power");
    }
  }

  // 4. merge all nodes sharing a label name
  for (const [, nodes] of labelGroups) {
    for (let i = 1; i < nodes.length; i++) uf.union(nodes[0], nodes[i]);
  }

  // 5. build nets from pin nodes
  const rootToPins = new Map<string, { ref: string; pad: string }[]>();
  for (const [pinKey, nd] of pinNetNode) {
    const r = uf.find(nd);
    const [ref, pad] = pinKey.split(":");
    if (!rootToPins.has(r)) rootToPins.set(r, []);
    rootToPins.get(r)!.push({ ref, pad });
  }
  // Determine each net's name from the labels in its union root.
  const rootLabelPower = new Map<string, string>();
  const rootLabelLocal = new Map<string, string>();
  for (const [name, nodes] of labelGroups) {
    const r = uf.find(nodes[0]);
    const v = nameVotes.get(name);
    const isPower = v && v.power.size > 0;
    if (isPower) { if (!rootLabelPower.has(r)) rootLabelPower.set(r, name); }
    else { if (!rootLabelLocal.has(r)) rootLabelLocal.set(r, name); }
  }

  const nets: RawNet[] = [];
  let auto = 1;
  for (const [r, pins] of rootToPins) {
    let name = rootLabelPower.get(r) || rootLabelLocal.get(r);
    if (!name) name = `Net-${auto++}`;
    nets.push({ name, pins });
  }
  // merge nets that ended up with the same name (defensive)
  const byName = new Map<string, RawNet>();
  for (const n of nets) {
    if (!byName.has(n.name)) byName.set(n.name, { name: n.name, pins: [] });
    byName.get(n.name)!.pins.push(...n.pins);
  }
  return { components, nets: [...byName.values()] };
}

function readPts(n: SNode): Pt[] {
  const c = child(n, "pts");
  if (!c) return [];
  const out: Pt[] = [];
  for (const it of c.items) {
    if (isList(it) && (head(it) === "xy" || head(it) === "pt")) {
      out.push({ x: numOf((it as SList).items[1]), y: numOf((it as SList).items[2]) });
    }
  }
  return out;
}
function addLabel(m: Map<string, string[]>, name: string, node: string) {
  if (!m.has(name)) m.set(name, []);
  m.get(name)!.push(node);
}
function voteName(m: Map<string, { power: Set<string>; local: Set<string> }>, name: string, node: string, kind: "power" | "local") {
  if (!m.has(name)) m.set(name, { power: new Set(), local: new Set() });
  m.get(name)![kind].add(node);
}
