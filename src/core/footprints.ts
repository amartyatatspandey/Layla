// Procedural footprint geometry library.
//
// kicad-cli / KiCad footprint libraries are not assumed present, so we synthesize
// real pad geometry from a footprint id. Pad numbers match schematic pin numbers
// so nets bind correctly in the generated .kicad_pcb.

import { Box, emptyBox, extend, Pt } from "./geometry";

export type PadShape = "rect" | "roundrect" | "oval" | "circle";
export interface PadGeom {
  num: string;
  x: number; // local mm, relative to footprint origin
  y: number;
  w: number;
  h: number;
  shape: PadShape;
  type: "smd" | "thru";
  drill?: number;
}
export interface FootprintGeom {
  id: string;
  pads: PadGeom[];
  courtyard: Box;
  bodyW: number;
  bodyH: number;
  /** keepout radius around the footprint (e.g. antennas) for the field proxy */
  keepout?: number;
}

function courtyardOf(pads: PadGeom[], bodyW: number, bodyH: number): Box {
  const b = emptyBox();
  for (const p of pads) {
    extend(b, { x: p.x - p.w / 2, y: p.y - p.h / 2 });
    extend(b, { x: p.x + p.w / 2, y: p.y + p.h / 2 });
  }
  extend(b, { x: -bodyW / 2, y: -bodyH / 2 });
  extend(b, { x: bodyW / 2, y: bodyH / 2 });
  // small courtyard margin
  return { minX: b.minX - 0.25, minY: b.minY - 0.25, maxX: b.maxX + 0.25, maxY: b.maxY + 0.25 };
}

function chip(id: string, pitch: number, padW: number, padH: number, bodyW: number, bodyH: number): FootprintGeom {
  const pads: PadGeom[] = [
    { num: "1", x: -pitch / 2, y: 0, w: padW, h: padH, shape: "roundrect", type: "smd" },
    { num: "2", x: pitch / 2, y: 0, w: padW, h: padH, shape: "roundrect", type: "smd" },
  ];
  return { id, pads, courtyard: courtyardOf(pads, bodyW, bodyH), bodyW, bodyH };
}

function sot23(id: string): FootprintGeom {
  // 3-pad SOT-23: pins 1,2 bottom (left/right), pin 3 top-center.
  const pads: PadGeom[] = [
    { num: "1", x: -0.95, y: 0.95, w: 0.6, h: 0.7, shape: "roundrect", type: "smd" },
    { num: "2", x: 0.95, y: 0.95, w: 0.6, h: 0.7, shape: "roundrect", type: "smd" },
    { num: "3", x: 0, y: -0.95, w: 0.6, h: 0.7, shape: "roundrect", type: "smd" },
  ];
  return { id, pads, courtyard: courtyardOf(pads, 2.9, 2.8), bodyW: 2.9, bodyH: 2.8 };
}

function dualRow(id: string, n: number, pitch: number, rowGap: number, padW: number, padH: number, bodyW: number, bodyH: number): FootprintGeom {
  // SOIC/SOT style: pins 1..n/2 down left, then up right (KiCad numbering).
  const perSide = n / 2;
  const pads: PadGeom[] = [];
  const y0 = -((perSide - 1) * pitch) / 2;
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(i + 1), x: -rowGap / 2, y: y0 + i * pitch, w: padW, h: padH, shape: "roundrect", type: "smd" });
  }
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(n - i), x: rowGap / 2, y: y0 + i * pitch, w: padW, h: padH, shape: "roundrect", type: "smd" });
  }
  return { id, pads, courtyard: courtyardOf(pads, bodyW, bodyH), bodyW, bodyH };
}

// padW/padH default to the dimensions the original QFN-24/32/48 and TQFP-64
// entries always used (0.5mm pitch); QFN-56 overrides padH explicitly below
// since its 0.4mm pitch doesn't leave clearance for the same pad height —
// see the QFN-56 TABLE entry comment.
function qfn(id: string, n: number, pitch: number, body: number, padW = 0.85, padH = 0.3): FootprintGeom {
  // n total pads, n/4 per side, pin 1 bottom-left going CCW.
  const perSide = Math.round(n / 4);
  const pads: PadGeom[] = [];
  const half = body / 2 + 0.15;
  const span = (perSide - 1) * pitch;
  let num = 1;
  // left side (top->bottom)
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(num++), x: -half, y: -span / 2 + i * pitch, w: padW, h: padH, shape: "roundrect", type: "smd" });
  }
  // bottom (left->right)
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(num++), x: -span / 2 + i * pitch, y: half, w: padH, h: padW, shape: "roundrect", type: "smd" });
  }
  // right (bottom->top)
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(num++), x: half, y: span / 2 - i * pitch, w: padW, h: padH, shape: "roundrect", type: "smd" });
  }
  // top (right->left)
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(num++), x: span / 2 - i * pitch, y: -half, w: padH, h: padW, shape: "roundrect", type: "smd" });
  }
  return { id, pads, courtyard: courtyardOf(pads, body, body), bodyW: body, bodyH: body };
}

function header(id: string, n: number, pitch = 2.54): FootprintGeom {
  const pads: PadGeom[] = [];
  const x0 = -((n - 1) * pitch) / 2;
  for (let i = 0; i < n; i++) {
    pads.push({
      num: String(i + 1), x: x0 + i * pitch, y: 0, w: 1.7, h: 1.7,
      shape: i === 0 ? "rect" : "circle", type: "thru", drill: 1.0,
    });
  }
  return { id, pads, courtyard: courtyardOf(pads, n * pitch, 2.6), bodyW: n * pitch, bodyH: 2.6 };
}

function usbc(id: string): FootprintGeom {
  // Simplified USB-C: shield/mount pads + 8 signal pads on a fine pitch.
  const pads: PadGeom[] = [];
  const sig = ["GND", "VBUS", "CC1", "DP", "DM", "SBU1", "VBUS2", "GND2"];
  const x0 = -((sig.length - 1) * 0.5) / 2;
  for (let i = 0; i < sig.length; i++) {
    pads.push({ num: String(i + 1), x: x0 + i * 0.5, y: 1.6, w: 0.3, h: 1.3, shape: "roundrect", type: "smd" });
  }
  // mounting tabs
  pads.push({ num: "9", x: -4.3, y: -1.2, w: 1.2, h: 1.8, shape: "rect", type: "thru", drill: 0.8 });
  pads.push({ num: "10", x: 4.3, y: -1.2, w: 1.2, h: 1.8, shape: "rect", type: "thru", drill: 0.8 });
  return { id, pads, courtyard: courtyardOf(pads, 9, 7.5), bodyW: 9, bodyH: 7.5 };
}

function antenna(id: string): FootprintGeom {
  const pads: PadGeom[] = [{ num: "1", x: 0, y: 0, w: 1.2, h: 1.2, shape: "roundrect", type: "smd" }];
  const g = { id, pads, courtyard: courtyardOf(pads, 12, 6), bodyW: 12, bodyH: 6, keepout: 8 };
  return g;
}

function inductorPower(id: string): FootprintGeom {
  const pads: PadGeom[] = [
    { num: "1", x: -1.5, y: 0, w: 1.6, h: 3.0, shape: "roundrect", type: "smd" },
    { num: "2", x: 1.5, y: 0, w: 1.6, h: 3.0, shape: "roundrect", type: "smd" },
  ];
  return { id, pads, courtyard: courtyardOf(pads, 5, 5), bodyW: 5, bodyH: 5 };
}

function mountingHole(id: string, drill = 3.2): FootprintGeom {
  const pads: PadGeom[] = [{ num: "", x: 0, y: 0, w: drill + 1.5, h: drill + 1.5, shape: "circle", type: "thru", drill }];
  return { id, pads, courtyard: courtyardOf(pads, drill + 2, drill + 2), bodyW: drill + 2, bodyH: drill + 2, keepout: 1 };
}

// ---------------------------------------------------------------------------
// Pin-count-aware generation for package families that have no fixed
// TABLE entry (previously fell through to a 2-pad chip footprint regardless
// of real pin count — see LAYLA_AUDIT.md finding B: any pin whose
// number wasn't "1"/"2" then had no world pad position anywhere downstream).
// These are deliberately *not* fab-accurate footprints: pitch/body-size are
// parametric guesses. The only correctness bar here is that pad count and
// pad numbering exactly match the schematic's declared pins, so every net
// resolves a pad position through the rest of the pipeline.
// ---------------------------------------------------------------------------

// Generic 4-sided perimeter package (LQFP and, as a best-effort
// approximation, TSSOP/SSOP/HTSSOP). Real TSSOP/SSOP/HTSSOP parts only carry
// leads on two long sides, not all four — but per audit scope the priority
// here is pad-count/number correctness, not silkscreen accuracy, so all four
// families share this one generator. Numbering follows the same
// bottom-left-CCW convention as the fixed qfn() table entries; pad.num is
// taken directly from the component's own declared pin numbers (not
// re-derived), so exact-string net lookups (padWorld) always resolve.
function perimeterQuad(id: string, pinNums: string[], pitch = 0.5): FootprintGeom {
  const n = pinNums.length;
  const perSide = Math.max(1, Math.ceil(n / 4));
  const half = (perSide - 1) * pitch / 2 + 1.5;
  const padW = 0.3, padH = 0.9;
  const positions: { x: number; y: number; w: number; h: number }[] = [];
  const span = (perSide - 1) * pitch;
  for (let i = 0; i < perSide; i++) positions.push({ x: -half, y: -span / 2 + i * pitch, w: padW, h: padH }); // left
  for (let i = 0; i < perSide; i++) positions.push({ x: -span / 2 + i * pitch, y: half, w: padH, h: padW }); // bottom
  for (let i = 0; i < perSide; i++) positions.push({ x: half, y: span / 2 - i * pitch, w: padW, h: padH }); // right
  for (let i = 0; i < perSide; i++) positions.push({ x: span / 2 - i * pitch, y: -half, w: padH, h: padW }); // top
  const pads: PadGeom[] = pinNums.map((num, i) => {
    const p = positions[i % positions.length];
    return { num, x: p.x, y: p.y, w: p.w, h: p.h, shape: "roundrect", type: "smd" };
  });
  const body = half * 2 - 0.3;
  return { id, pads, courtyard: courtyardOf(pads, body, body), bodyW: body, bodyH: body };
}

// Generic grid-array package (LGA and similar). Real LGA pad maps are
// part-specific (ground pads, thermal pads, irregular grids) and vary widely
// by manufacturer — this is a generic row-major grid sized to the declared
// pin count, not a substitute for a real footprint library entry.
function gridArray(id: string, pinNums: string[], pitch = 1.0): FootprintGeom {
  const n = pinNums.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const x0 = -((cols - 1) * pitch) / 2;
  const y0 = -((rows - 1) * pitch) / 2;
  const pads: PadGeom[] = pinNums.map((num, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    return { num, x: x0 + col * pitch, y: y0 + row * pitch, w: 0.6, h: 0.6, shape: "roundrect", type: "smd" };
  });
  const bodyW = cols * pitch + 1, bodyH = rows * pitch + 1;
  return { id, pads, courtyard: courtyardOf(pads, bodyW, bodyH), bodyW, bodyH };
}

// Last-resort layout for a package string that matches nothing known at all
// (not even a dynamic family below). Single row, pad count = declared pin
// count. Emphatically not fab-accurate; see the console.warn at the call
// site in footprintGeom().
function genericPlaceholder(id: string, pinNums: string[]): FootprintGeom {
  const nums = pinNums.length ? pinNums : ["1", "2"];
  const pitch = 1.0;
  const x0 = -((nums.length - 1) * pitch) / 2;
  const pads: PadGeom[] = nums.map((num, i) => ({
    num, x: x0 + i * pitch, y: 0, w: 0.6, h: 0.6, shape: "roundrect", type: "smd",
  }));
  const bodyW = Math.max(1.6, nums.length * pitch), bodyH = 1.2;
  return { id, pads, courtyard: courtyardOf(pads, bodyW, bodyH), bodyW, bodyH };
}

// Package families that need per-instance pin-count-aware generation
// (no single fixed TABLE geometry can cover every pin count for these).
// Checked before the fixed TABLE lookup; returns null to defer to TABLE for
// everything else (including QFN/TQFP, which already have working fixed
// entries for their listed sizes).
function dynamicPackageGeom(libId: string, pinNums: string[]): FootprintGeom | null {
  if (!pinNums.length) return null;
  const s = (libId || "").toLowerCase();
  const find = (frag: string) => s.includes(frag);
  if (find("lqfp")) return perimeterQuad(`LQFP-${pinNums.length}`, pinNums, 0.5);
  if (find("htssop") || find("tssop") || find("ssop")) return perimeterQuad(`SSOP-${pinNums.length}`, pinNums, 0.5);
  if (find("lga")) return gridArray(`LGA-${pinNums.length}`, pinNums, 1.0);
  return null;
}

// Safety net: whatever geometry was resolved above (dynamic generator or a
// fixed TABLE entry), make sure every pin the schematic actually declared on
// this component has a pad. Fixed TABLE entries are sized for one canonical
// part (e.g. "QFN-56" always synthesizes exactly 56 pads); if the schematic
// declares more pins than that template has pads for, the extra pins would
// otherwise silently have no world pad position (the exact failure mode in
// finding B) even though the package *was* recognized. Extends rather than
// regenerates so recognized/fab-plausible packages keep their real geometry
// for the pins they do cover.
function ensurePadCoverage(geom: FootprintGeom, pinNums: string[], libId: string, ref: string): FootprintGeom {
  if (!pinNums.length) return geom;
  const have = new Set(geom.pads.map((p) => p.num));
  const missing = pinNums.filter((n) => n !== "" && !have.has(n));
  if (!missing.length) return geom;
  console.warn(
    `[layla] footprints.ts: ${ref} — footprint "${geom.id}" for package "${libId}" has ${geom.pads.length} pad(s) but the ` +
    `schematic declares ${pinNums.length} pin(s); synthesizing ${missing.length} extra placeholder pad(s) ` +
    `[${missing.join(",")}] so every net still resolves a pad position — not fab-accurate, verify against a real footprint before manufacturing.`,
  );
  const y = geom.courtyard.maxY + 0.6;
  const extra: PadGeom[] = missing.map((num, i) => ({
    num, x: geom.courtyard.minX + 0.6 + i * 0.9, y, w: 0.5, h: 0.5, shape: "roundrect", type: "smd",
  }));
  const pads = [...geom.pads, ...extra];
  return { ...geom, pads, courtyard: courtyardOf(pads, geom.bodyW, geom.bodyH) };
}

const TABLE: Record<string, () => FootprintGeom> = {
  "R_0402": () => chip("R_0402", 0.9, 0.55, 0.55, 1.0, 0.5),
  "C_0402": () => chip("C_0402", 0.9, 0.55, 0.55, 1.0, 0.5),
  "R_0603": () => chip("R_0603", 1.5, 0.8, 0.85, 1.6, 0.8),
  "C_0603": () => chip("C_0603", 1.5, 0.8, 0.85, 1.6, 0.8),
  "R_0805": () => chip("R_0805", 1.9, 1.0, 1.25, 2.0, 1.25),
  "C_0805": () => chip("C_0805", 1.9, 1.0, 1.25, 2.0, 1.25),
  "C_1206": () => chip("C_1206", 2.8, 1.2, 1.8, 3.2, 1.8),
  "D_SOD123": () => chip("D_SOD123", 3.0, 0.9, 1.2, 1.8, 1.2),
  "LED_0603": () => chip("LED_0603", 1.5, 0.8, 0.85, 1.6, 0.8),
  "L_Power_5x5": () => inductorPower("L_Power_5x5"),
  "L_0805": () => chip("L_0805", 1.9, 1.0, 1.25, 2.0, 1.25),
  "SOT23": () => sot23("SOT23"),
  "SOT23-6": () => dualRow("SOT23-6", 6, 0.95, 2.0, 0.55, 0.6, 2.9, 1.6),
  // dualRow()'s pitch/packing axis uses its `padH` argument (see SOT23-6 and
  // Crystal_SMD below, where padH < pitch); these two previously passed
  // (padW=0.6, padH=1.5) against a 1.27mm pitch — padH > pitch meant
  // adjacent pads geometrically overlapped (not just under-clearance;
  // src/core/drc.ts reported measuredMm=0, its floor for "touching or
  // worse"). 0.6mm/1.5mm are real, standard SOIC pad dimensions (IPC-7351
  // nominal for 1.27mm-pitch SOIC) — the values were right, just swapped
  // onto the wrong axis. Swapped here: 0.6mm (narrow) now governs pitch
  // spacing, 1.5mm (long) points outward, matching real SOIC-8/14
  // footprints and leaving 1.27-0.6=0.67mm between adjacent pads.
  "SOIC-8": () => dualRow("SOIC-8", 8, 1.27, 5.4, 1.5, 0.6, 3.9, 4.9),
  "SOIC-14": () => dualRow("SOIC-14", 14, 1.27, 5.4, 1.5, 0.6, 8.65, 6.0),
  "QFN-24": () => qfn("QFN-24", 24, 0.5, 4.0),
  "QFN-32": () => qfn("QFN-32", 32, 0.5, 5.0),
  "QFN-48": () => qfn("QFN-48", 48, 0.5, 7.0),
  // 0.4mm pitch is a real, standard QFN-56 mechanical fact (e.g. 7x7mm
  // QFN-56 parts commonly used for RP2040-class MCUs) — kept as-is per
  // audit guidance to prefer adjusting pad size over pitch. The default
  // padH=0.3mm (shared with the 0.5mm-pitch QFN-24/32/48 above) left only
  // 0.4-0.3=0.1mm between adjacent pads, half of board.clearance (0.2mm).
  // padH=0.18mm — close to IPC-7351 nominal for 0.4mm-pitch QFN pads — gives
  // 0.4-0.18=0.22mm, clearing the requirement with a small real margin
  // rather than sitting exactly on the boundary.
  "QFN-56": () => qfn("QFN-56", 56, 0.4, 7.0, 0.85, 0.18),
  "TQFP-64": () => qfn("TQFP-64", 64, 0.5, 10.0),
  "Crystal_SMD": () => dualRow("Crystal_SMD", 4, 1.6, 2.0, 1.0, 1.0, 3.2, 2.5),
  "USB_C": () => usbc("USB_C"),
  "PinHeader_1x2": () => header("PinHeader_1x2", 2),
  "PinHeader_1x3": () => header("PinHeader_1x3", 3),
  "PinHeader_1x4": () => header("PinHeader_1x4", 4),
  "PinHeader_1x6": () => header("PinHeader_1x6", 6),
  "ScrewTerminal_1x2": () => header("ScrewTerminal_1x2", 2, 5.0),
  "ScrewTerminal_1x3": () => header("ScrewTerminal_1x3", 3, 5.0),
  "Antenna_Chip": () => antenna("Antenna_Chip"),
  "TestPoint": () => header("TestPoint", 1),
  "MountingHole_3.2": () => mountingHole("MountingHole_3.2"),
};

// Test-support export: every fixed TABLE template, instantiated once, keyed
// by its TABLE id. Lets a gate test check each fixed footprint's own
// geometry in isolation (e.g. against src/core/drc.ts's clearance model)
// without depending on canonicalKey's string-matching, and without needing
// a bundled example board that happens to use every template.
export function debugFootprintTemplates(): Record<string, FootprintGeom> {
  return Object.fromEntries(Object.entries(TABLE).map(([id, make]) => [id, make()]));
}

export function footprintGeom(libId: string, value = "", pinNums: string[] = [], ref = "?"): FootprintGeom {
  // Package families where a single fixed TABLE geometry can't cover every
  // instance's pin count (LQFP/TSSOP/SSOP/HTSSOP/LGA) — generate sized to
  // this component's actual declared pins.
  const dyn = dynamicPackageGeom(libId, pinNums);
  if (dyn) return dyn;

  const key = canonicalKey(libId, value);
  if (key) {
    const base = TABLE[key]();
    // Even a recognized package's fixed template can be undersized for this
    // particular instance (e.g. a "QFN-56" TABLE entry is always exactly 56
    // pads, but the schematic may declare more functional pins) — patch
    // rather than silently drop.
    return ensurePadCoverage(base, pinNums, libId, ref);
  }

  // Truly unmapped package string: previously silently returned a 2-pad
  // 0603 footprint regardless of real pin count (LAYLA_AUDIT.md
  // finding B). Generate sized to the declared pins instead and warn loudly
  // so a human knows this part needs a real footprint before fab.
  console.warn(
    `[layla] footprints.ts: ${ref} — no footprint mapping for package "${libId}" (value="${value}"); ` +
    `synthesizing a generic ${pinNums.length || 2}-pad placeholder — verify against a real footprint before manufacturing.`,
  );
  return genericPlaceholder(libId || "Unknown", pinNums);
}

function canonicalKey(libId: string, value: string): string | null {
  const s = (libId || "").toLowerCase();
  const find = (frag: string) => s.includes(frag);
  if (find("qfn-56") || find("qfn_56")) return "QFN-56";
  if (find("qfn-48") || find("qfn_48")) return "QFN-48";
  if (find("qfn-32") || find("qfn_32")) return "QFN-32";
  if (find("qfn-24") || find("qfn_24")) return "QFN-24";
  if (find("tqfp-64") || find("tqfp_64")) return "TQFP-64";
  if (find("soic-14") || find("soic_14")) return "SOIC-14";
  if (find("soic-8") || find("soic_8") || find("soic")) return "SOIC-8";
  if (find("sot-23-6") || find("sot23-6") || find("sot-23-5")) return "SOT23-6";
  if (find("sot-23") || find("sot23")) return "SOT23";
  if (find("usb_c") || find("usb-c") || find("typec") || find("type-c")) return "USB_C";
  if (find("crystal") || find("xtal")) return "Crystal_SMD";
  if (find("antenna") || find("ant")) return "Antenna_Chip";
  if (find("l_power") || find("inductor")) return "L_Power_5x5";
  if (find("screwterminal_1x3") || find("screw_1x3")) return "ScrewTerminal_1x3";
  if (find("screwterminal") || find("screw")) return "ScrewTerminal_1x2";
  if (find("pinheader_1x6") || find("1x6")) return "PinHeader_1x6";
  if (find("pinheader_1x4") || find("1x4")) return "PinHeader_1x4";
  if (find("pinheader_1x3") || find("1x3")) return "PinHeader_1x3";
  if (find("pinheader") || find("1x2") || find("conn")) return "PinHeader_1x2";
  if (find("testpoint") || find("test_point")) return "TestPoint";
  if (find("mountinghole") || find("mounting")) return "MountingHole_3.2";
  if (find("sod123") || find("sod-123") || find("diode")) return "D_SOD123";
  if (find("led")) return "LED_0603";
  if (find("0402")) return libId.startsWith("R") ? "R_0402" : "C_0402";
  if (find("0805")) return "C_0805";
  if (find("1206")) return "C_1206";
  if (find("0603")) return "C_0603";
  // No explicit match: previously defaulted to "C_0603" here, which is what
  // caused every unmapped IC package (LQFP/HTSSOP/LGA/...) to silently
  // become a 2-pad passive footprint (finding B). Returning null routes the
  // caller to dynamicPackageGeom / genericPlaceholder instead.
  return null;
}
