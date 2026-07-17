// Author valid .kicad_sch files programmatically (used to build the bundled
// examples). Connectivity is expressed with a net label placed exactly at each
// pin's world position, which the offline netlister in schematic.ts recovers.

import { node, sym, str, atom, list, serialize, SList, SNode } from "./sexpr";
import { Pt } from "./geometry";
import { symPinWorld } from "./schematic";

export interface PartPin { name: string; net: string; }
export interface PartSpec {
  ref: string;
  value: string;
  symName: string;       // template name (Device-like)
  footprint: string;     // drives procedural footprint geometry
  at: { x: number; y: number; rot?: number };
  mirror?: string;
  pins: Record<string, PartPin>; // pad number -> {name, net}
}
export interface SchSpec {
  name: string;
  title?: string;
  parts: PartSpec[];
}

// Local pin layout for a symbol template, derived from its pin numbers.
// Pins are laid in two vertical columns around a body box — positions only
// need to be distinct & stable; they have no electrical meaning beyond labels.
function pinLocals(pinNums: string[]): Map<string, Pt> {
  const m = new Map<string, Pt>();
  const n = pinNums.length;
  const left = pinNums.slice(0, Math.ceil(n / 2));
  const right = pinNums.slice(Math.ceil(n / 2));
  const pitch = 2.54;
  const startY = -((Math.max(left.length, right.length) - 1) * pitch) / 2;
  left.forEach((p, i) => m.set(p, { x: -7.62, y: startY + i * pitch }));
  right.forEach((p, i) => m.set(p, { x: 7.62, y: startY + i * pitch }));
  return m;
}

function libSymbol(symName: string, pinNums: string[]): SList {
  const locals = pinLocals(pinNums);
  const body = node("symbol", str(symName + "_0_1"));
  const half = 6.35;
  const topY = -((Math.max(1, Math.ceil(pinNums.length / 2)) - 1) * 2.54) / 2 - 2.54;
  const botY = -topY;
  body.items.push(node("rectangle",
    node("start", atom(-half), atom(topY)),
    node("end", atom(half), atom(botY)),
    node("stroke", node("width", atom(0.254)), node("type", sym("default"))),
    node("fill", node("type", sym("background"))),
  ));
  const pinsUnit = node("symbol", str(symName + "_1_1"));
  for (const num of pinNums) {
    const loc = locals.get(num)!;
    const dir = loc.x < 0 ? 0 : 180; // point inward
    pinsUnit.items.push(node("pin", sym("passive"), sym("line"),
      node("at", atom(loc.x), atom(loc.y), atom(dir)),
      node("length", atom(2.54)),
      node("name", str(num), node("effects", node("font", node("size", atom(1.27), atom(1.27))))),
      node("number", str(num), node("effects", node("font", node("size", atom(1.27), atom(1.27))))),
    ));
  }
  return node("symbol", str(symName),
    node("pin_numbers", sym("hide")),
    node("pin_names", node("offset", atom(0.254))),
    node("in_bom", sym("yes")), node("on_board", sym("yes")),
    body, pinsUnit,
  );
}

let uuidCounter = 1;
function uuid(): string {
  const n = (uuidCounter++).toString(16).padStart(12, "0");
  return `00000000-0000-0000-0000-${n}`;
}

export function genSchematic(spec: SchSpec): string {
  // collect unique symbol templates (by symName) with their pin number set
  const templates = new Map<string, string[]>();
  for (const p of spec.parts) {
    if (!templates.has(p.symName)) templates.set(p.symName, Object.keys(p.pins));
  }
  const libSymbols = node("lib_symbols");
  for (const [symName, pinNums] of templates) libSymbols.items.push(libSymbol(symName, pinNums));

  const root = node("kicad_sch",
    node("version", atom(20230121)),
    node("generator", sym("layla")),
    node("uuid", str(uuid())),
    node("paper", str("A4")),
    node("title_block", node("title", str(spec.title || spec.name))),
    libSymbols,
  );

  for (const p of spec.parts) {
    const rot = p.at.rot ?? 0;
    const symInst = node("symbol",
      node("lib_id", str(p.symName)),
      node("at", atom(p.at.x), atom(p.at.y), atom(rot)),
      node("unit", atom(1)),
      node("in_bom", sym("yes")), node("on_board", sym("yes")),
      node("uuid", str(uuid())),
      node("property", str("Reference"), str(p.ref),
        node("at", atom(p.at.x), atom(p.at.y - 8), atom(0)),
        node("effects", node("font", node("size", atom(1.27), atom(1.27))))),
      node("property", str("Value"), str(p.value),
        node("at", atom(p.at.x), atom(p.at.y + 8), atom(0)),
        node("effects", node("font", node("size", atom(1.27), atom(1.27))))),
      node("property", str("Footprint"), str(p.footprint),
        node("at", atom(p.at.x), atom(p.at.y), atom(0)),
        node("effects", node("font", node("size", atom(1.27), atom(1.27)), sym("hide")))),
    );
    root.items.push(symInst);

    // emit a net label at each pin's world position
    const locals = pinLocals(Object.keys(p.pins));
    for (const [num, pin] of Object.entries(p.pins)) {
      const loc = locals.get(num)!;
      const w = symPinWorld({ x: p.at.x, y: p.at.y, rot }, p.mirror || "", loc);
      root.items.push(node("label", str(pin.net),
        node("at", atom(round3(w.x)), atom(round3(w.y)), atom(0)),
        node("effects", node("font", node("size", atom(1.27), atom(1.27))), node("justify", sym("left"))),
        node("uuid", str(uuid())),
      ));
    }
  }

  root.items.push(node("sheet_instances", node("path", str("/"), node("page", str("1")))));
  return serialize(root);
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }
