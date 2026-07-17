// Emit a KiCad 7/8-style `.kicad_pcb` file from the design IR + a concrete layout.
//
// The board text is built as an SList tree using the builders from sexpr.ts and
// serialized once at the end. Footprints are placed by their placement pose and
// pads keep their LOCAL coordinates — KiCad applies the footprint `(at x y rot)`
// transform itself, so padWorld is not needed here.

import { Design, Layout } from "./types";
import { PadGeom } from "./footprints";
import { list, node, sym, str, atom, serialize, SNode, SList } from "./sexpr";

// Round to 4 decimals (kill -0 and float fuzz).
function r4(n: number): number {
  const v = Math.round(n * 1e4) / 1e4;
  return Object.is(v, -0) ? 0 : v;
}

// Canonical KiCad 2-layer stackup layer table.
const LAYER_TABLE: Array<[number, string, string, string?]> = [
  [0, "F.Cu", "signal"],
  [31, "B.Cu", "signal"],
  [32, "B.Adhes", "user", "B.Adhesive"],
  [33, "F.Adhes", "user", "F.Adhesive"],
  [34, "B.Paste", "user"],
  [35, "F.Paste", "user"],
  [36, "B.SilkS", "user", "B.Silkscreen"],
  [37, "F.SilkS", "user", "F.Silkscreen"],
  [38, "B.Mask", "user"],
  [39, "F.Mask", "user"],
  [40, "Dwgs.User", "user", "User.Drawings"],
  [41, "Cmts.User", "user", "User.Comments"],
  [42, "Eco1.User", "user", "User.Eco1"],
  [43, "Eco2.User", "user", "User.Eco2"],
  [44, "Edge.Cuts", "user"],
  [45, "Margin", "user"],
  [46, "B.CrtYd", "user", "B.Courtyard"],
  [47, "F.CrtYd", "user", "F.Courtyard"],
  [48, "B.Fab", "user"],
  [49, "F.Fab", "user"],
];

function atP(x: number, y: number, rot?: number): SList {
  const items: SNode[] = [sym("at"), atom(r4(x)), atom(r4(y))];
  if (rot !== undefined && rot !== 0) items.push(atom(r4(rot)));
  return list(...items);
}

function strokeSolid(width: number): SList {
  return node("stroke", node("width", atom(width)), node("type", sym("solid")));
}

export function writeBoard(design: Design, layout: Layout): string {
  const board = design.board;

  // net name -> code map (and ensure deterministic ordering for emission).
  const netCode = new Map<string, number>();
  for (const n of design.nets) netCode.set(n.name, n.code);
  const codeOf = (name: string | undefined): number => {
    if (!name) return 0;
    const c = netCode.get(name);
    return c === undefined ? 0 : c;
  };

  const items: SNode[] = [
    sym("kicad_pcb"),
    node("version", atom(20221018)),
    node("generator", str("layla")),
    node("general", node("thickness", atom(1.6))),
    node("paper", str("A4")),
  ];

  // ---- layers ----
  const layerItems: SNode[] = [sym("layers")];
  for (const [idx, name, type, user] of LAYER_TABLE) {
    const li: SNode[] = [atom(idx), str(name), sym(type)];
    if (user !== undefined) li.push(str(user));
    layerItems.push(list(...li));
  }
  items.push(list(...layerItems));

  // ---- setup ----
  items.push(node("setup", node("pad_to_mask_clearance", atom(0))));

  // ---- nets ----
  items.push(node("net", atom(0), str("")));
  for (const n of design.nets) {
    items.push(node("net", atom(n.code), str(n.name)));
  }

  // ---- footprints (components) ----
  for (const comp of design.components) {
    const pl = layout.placements[comp.ref];
    if (!pl) continue;
    const fp = design.footprints[comp.ref];

    // pin num -> net name for this component
    const pinNet = new Map<string, string>();
    for (const pin of comp.pins) pinNet.set(pin.num, pin.net);

    const layer = pl.side === "back" ? "B.Cu" : "F.Cu";
    const fpItems: SNode[] = [
      sym("footprint"),
      str(comp.libId || "Generic"),
      node("layer", str(layer)),
      atP(pl.x, pl.y, pl.rot),
      list(sym("property"), str("Reference"), str(comp.ref), node("layer", str(pl.side === "back" ? "B.SilkS" : "F.SilkS"))),
      list(sym("property"), str("Value"), str(comp.value), node("layer", str(pl.side === "back" ? "B.Fab" : "F.Fab"))),
    ];

    const pads: PadGeom[] = fp ? fp.pads : [];
    for (const pad of pads) {
      fpItems.push(emitPad(pad, codeOf(pinNet.get(pad.num)), pinNet.get(pad.num) ?? ""));
    }
    items.push(list(...fpItems));
  }

  // ---- Edge.Cuts outline (closed rectangle) ----
  const W = r4(board.width), H = r4(board.height);
  const corners: Array<[number, number, number, number]> = [
    [0, 0, W, 0],
    [W, 0, W, H],
    [W, H, 0, H],
    [0, H, 0, 0],
  ];
  for (const [ax, ay, bx, by] of corners) {
    items.push(
      node(
        "gr_line",
        node("start", atom(r4(ax)), atom(r4(ay))),
        node("end", atom(r4(bx)), atom(r4(by))),
        strokeSolid(0.1),
        node("layer", str("Edge.Cuts"))
      )
    );
  }

  // ---- mounting holes ----
  for (const mh of board.mountingHoles) {
    const ring = r4(mh.drill + 1.5);
    items.push(
      list(
        sym("footprint"),
        str("MountingHole"),
        atP(mh.x, mh.y),
        node("layer", str("F.Cu")),
        list(
          sym("pad"),
          str(""),
          sym("thru_hole"),
          sym("circle"),
          atP(0, 0),
          node("size", atom(ring), atom(ring)),
          node("drill", atom(r4(mh.drill))),
          node("layers", str("*.Cu"), str("*.Mask")),
          node("net", atom(0), str(""))
        )
      )
    );
  }

  // ---- routes (segments) ----
  for (const seg of layout.routes) {
    items.push(
      node(
        "segment",
        node("start", atom(r4(seg.a.x)), atom(r4(seg.a.y))),
        node("end", atom(r4(seg.b.x)), atom(r4(seg.b.y))),
        node("width", atom(r4(seg.width))),
        node("layer", str(seg.layer)),
        node("net", atom(codeOf(seg.net)))
      )
    );
  }

  // ---- vias ----
  for (const via of layout.vias) {
    items.push(
      node(
        "via",
        atP(via.at.x, via.at.y),
        node("size", atom(r4(board.viaDia))),
        node("drill", atom(r4(board.viaDrill))),
        node("layers", str("F.Cu"), str("B.Cu")),
        node("net", atom(codeOf(via.net)))
      )
    );
  }

  // ---- optional ground pour on B.Cu ----
  const gnd = design.nets.find((n) => /^gnd/i.test(n.name));
  if (gnd) {
    items.push(
      list(
        sym("zone"),
        node("net", atom(gnd.code)),
        node("net_name", str(gnd.name)),
        node("layer", str("B.Cu")),
        list(sym("hatch"), sym("edge"), atom(0.5)),
        node("filled_areas_thickness", sym("no")),
        node(
          "polygon",
          node(
            "pts",
            list(sym("xy"), atom(0), atom(0)),
            list(sym("xy"), atom(W), atom(0)),
            list(sym("xy"), atom(W), atom(H)),
            list(sym("xy"), atom(0), atom(H))
          )
        )
      )
    );
  }

  const root = list(...items);
  return serialize(root);
}

function emitPad(pad: PadGeom, netCode: number, netName: string): SList {
  const padType = pad.type === "thru" ? "thru_hole" : "smd";
  const padItems: SNode[] = [
    sym("pad"),
    str(pad.num),
    sym(padType),
  ];

  // shape mapping
  if (pad.shape === "roundrect") {
    padItems.push(sym("roundrect"));
  } else if (pad.shape === "oval") {
    padItems.push(sym("oval"));
  } else if (pad.shape === "circle") {
    padItems.push(sym("circle"));
  } else {
    padItems.push(sym("rect"));
  }

  padItems.push(atP(pad.x, pad.y));
  padItems.push(node("size", atom(r4(pad.w)), atom(r4(pad.h))));

  if (pad.type === "thru") {
    padItems.push(node("drill", atom(r4(pad.drill ?? 0.6))));
    padItems.push(node("layers", str("*.Cu"), str("*.Mask")));
  } else {
    padItems.push(node("layers", str("F.Cu"), str("F.Mask")));
  }

  if (pad.shape === "roundrect") {
    padItems.push(node("roundrect_rratio", atom(0.25)));
  }

  // net binding: mounting/empty pads default to (net 0 "")
  if (pad.num === "" || netCode === 0) {
    padItems.push(node("net", atom(0), str("")));
  } else {
    padItems.push(node("net", atom(netCode), str(netName)));
  }

  return list(...padItems);
}
