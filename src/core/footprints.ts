// Procedural footprint geometry library.
//
// kicad-cli / KiCad footprint libraries are not assumed present, so we synthesize
// real pad geometry from a footprint id. Pad numbers match schematic pin numbers
// so nets bind correctly in the generated .kicad_pcb.
//
// Unmapped / ambiguous / pad-mismatched packages hard-fail — no silent placeholder.

import { Box, emptyBox, extend } from "./geometry";

/** Pitch/body disclosure from parametric LQFP/TSSOP/SSOP generation. */
export interface FootprintAssumption {
  ref: string;
  package: string;
  message: string;
}

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

export type FootprintFailReason =
  | "unmapped_package"
  | "ambiguous_pitch"
  | "pad_count_mismatch";

export interface UnresolvedFootprintEntry {
  ref: string;
  package: string;
  nets: string[];
  reason: FootprintFailReason;
  detail?: string;
}

export class UnresolvedFootprintError extends Error {
  readonly entries: UnresolvedFootprintEntry[];
  reportPath?: string;
  constructor(entries: UnresolvedFootprintEntry[]) {
    const summary = entries
      .map((e) => `${e.ref} (${e.package}): ${e.reason}`)
      .join("; ");
    super(`Unresolved footprint(s): ${summary}`);
    this.name = "UnresolvedFootprintError";
    this.entries = entries;
  }
}

export interface FootprintResolveOk {
  ok: true;
  geom: FootprintGeom;
  assumption?: FootprintAssumption;
}

export interface FootprintResolveFail {
  ok: false;
  reason: FootprintFailReason;
  package: string;
  detail?: string;
}

export type FootprintResolveResult = FootprintResolveOk | FootprintResolveFail;

function courtyardOf(pads: PadGeom[], bodyW: number, bodyH: number): Box {
  const b = emptyBox();
  for (const p of pads) {
    extend(b, { x: p.x - p.w / 2, y: p.y - p.h / 2 });
    extend(b, { x: p.x + p.w / 2, y: p.y + p.h / 2 });
  }
  extend(b, { x: -bodyW / 2, y: -bodyH / 2 });
  extend(b, { x: bodyW / 2, y: bodyH / 2 });
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
  const pads: PadGeom[] = [
    { num: "1", x: -0.95, y: 0.95, w: 0.6, h: 0.7, shape: "roundrect", type: "smd" },
    { num: "2", x: 0.95, y: 0.95, w: 0.6, h: 0.7, shape: "roundrect", type: "smd" },
    { num: "3", x: 0, y: -0.95, w: 0.6, h: 0.7, shape: "roundrect", type: "smd" },
  ];
  return { id, pads, courtyard: courtyardOf(pads, 2.9, 2.8), bodyW: 2.9, bodyH: 2.8 };
}

function dualRow(id: string, n: number, pitch: number, rowGap: number, padW: number, padH: number, bodyW: number, bodyH: number): FootprintGeom {
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

function qfn(id: string, n: number, pitch: number, body: number, padW = 0.85, padH = 0.3): FootprintGeom {
  const perSide = Math.round(n / 4);
  const pads: PadGeom[] = [];
  const half = body / 2 + 0.15;
  const span = (perSide - 1) * pitch;
  let num = 1;
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(num++), x: -half, y: -span / 2 + i * pitch, w: padW, h: padH, shape: "roundrect", type: "smd" });
  }
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(num++), x: -span / 2 + i * pitch, y: half, w: padH, h: padW, shape: "roundrect", type: "smd" });
  }
  for (let i = 0; i < perSide; i++) {
    pads.push({ num: String(num++), x: half, y: span / 2 - i * pitch, w: padW, h: padH, shape: "roundrect", type: "smd" });
  }
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
  const pads: PadGeom[] = [];
  const sig = ["GND", "VBUS", "CC1", "DP", "DM", "SBU1", "VBUS2", "GND2"];
  const x0 = -((sig.length - 1) * 0.5) / 2;
  for (let i = 0; i < sig.length; i++) {
    pads.push({ num: String(i + 1), x: x0 + i * 0.5, y: 1.6, w: 0.3, h: 1.3, shape: "roundrect", type: "smd" });
  }
  pads.push({ num: "9", x: -4.3, y: -1.2, w: 1.2, h: 1.8, shape: "rect", type: "thru", drill: 0.8 });
  pads.push({ num: "10", x: 4.3, y: -1.2, w: 1.2, h: 1.8, shape: "rect", type: "thru", drill: 0.8 });
  return { id, pads, courtyard: courtyardOf(pads, 9, 7.5), bodyW: 9, bodyH: 7.5 };
}

function antenna(id: string): FootprintGeom {
  const pads: PadGeom[] = [{ num: "1", x: 0, y: 0, w: 1.2, h: 1.2, shape: "roundrect", type: "smd" }];
  return { id, pads, courtyard: courtyardOf(pads, 12, 6), bodyW: 12, bodyH: 6, keepout: 8 };
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

/** BME280 / BMP390 8-pad LGA land pattern (2×4 grid, ~1.27 mm pitch). */
function lga8(id: string): FootprintGeom {
  const pitch = 1.27;
  const pads: PadGeom[] = [];
  const left = [1, 2, 3, 4];
  const right = [8, 7, 6, 5];
  left.forEach((num, i) => {
    pads.push({
      num: String(num), x: -pitch / 2, y: -((left.length - 1) * pitch) / 2 + i * pitch,
      w: 0.55, h: 0.55, shape: "roundrect", type: "smd",
    });
  });
  right.forEach((num, i) => {
    pads.push({
      num: String(num), x: pitch / 2, y: -((right.length - 1) * pitch) / 2 + i * pitch,
      w: 0.55, h: 0.55, shape: "roundrect", type: "smd",
    });
  });
  return { id, pads, courtyard: courtyardOf(pads, 3.0, 5.5), bodyW: 3.0, bodyH: 5.5 };
}

/** DRV8313-class HTSSOP-28: dual-row 0.65 mm pitch + exposed thermal pad as pad 29. */
function htssop28(id: string): FootprintGeom {
  const g = dualRow(id, 28, 0.65, 5.4, 1.2, 0.4, 9.7, 6.4);
  g.pads.push({ num: "29", x: 0, y: 0, w: 3.0, h: 4.5, shape: "rect", type: "smd" });
  g.courtyard = courtyardOf(g.pads, g.bodyW, g.bodyH);
  return g;
}

interface NominalSpec {
  pitchMm: number;
  bodyMm: number;
  bodyWMm?: number;
  standard: string;
}

// JEDEC MS-026: only pin counts with a single unambiguous standard pitch/body.
const LQFP_NOMINAL: Record<number, NominalSpec> = {
  32: { pitchMm: 0.8, bodyMm: 7.0, standard: "JEDEC MS-026" },
  48: { pitchMm: 0.5, bodyMm: 7.0, standard: "JEDEC MS-026" },
};
const LQFP_AMBIGUOUS: Record<number, string[]> = {
  64: ["0.4mm/7x7", "0.5mm/10x10", "0.8mm/14x14"],
  80: ["0.5mm/12x12", "0.5mm/14x14", "0.65mm/14x14"],
  100: ["0.4mm/14x14", "0.5mm/14x14", "0.65mm/14x20"],
};

// JEDEC MO-153 TSSOP. TSSOP-28 also ships fine-pitch 0.50 mm — ambiguous.
const TSSOP_NOMINAL: Record<number, NominalSpec> = {
  8: { pitchMm: 0.65, bodyMm: 3.0, bodyWMm: 4.4, standard: "JEDEC MO-153" },
  14: { pitchMm: 0.65, bodyMm: 5.0, bodyWMm: 4.4, standard: "JEDEC MO-153" },
  16: { pitchMm: 0.65, bodyMm: 5.0, bodyWMm: 4.4, standard: "JEDEC MO-153" },
  20: { pitchMm: 0.65, bodyMm: 6.5, bodyWMm: 4.4, standard: "JEDEC MO-153" },
  24: { pitchMm: 0.65, bodyMm: 7.8, bodyWMm: 4.4, standard: "JEDEC MO-153" },
};
const TSSOP_AMBIGUOUS: Record<number, string[]> = {
  28: ["0.50mm fine-pitch", "0.65mm MO-153"],
};

// JEDEC MO-150 SSOP.
const SSOP_NOMINAL: Record<number, NominalSpec> = {
  8: { pitchMm: 0.65, bodyMm: 3.0, bodyWMm: 5.3, standard: "JEDEC MO-150" },
  14: { pitchMm: 0.65, bodyMm: 6.2, bodyWMm: 5.3, standard: "JEDEC MO-150" },
  16: { pitchMm: 0.65, bodyMm: 6.2, bodyWMm: 5.3, standard: "JEDEC MO-150" },
  20: { pitchMm: 0.65, bodyMm: 7.2, bodyWMm: 5.3, standard: "JEDEC MO-150" },
  24: { pitchMm: 0.65, bodyMm: 8.2, bodyWMm: 5.3, standard: "JEDEC MO-150" },
  28: { pitchMm: 0.65, bodyMm: 10.2, bodyWMm: 5.3, standard: "JEDEC MO-150" },
};
const SSOP_AMBIGUOUS: Record<number, string[]> = {
  48: ["0.635mm", "0.80mm"],
};

function parsePinCount(libId: string): number | null {
  const m = (libId || "").match(/(?:lqfp|htssop|tssop|ssop|lga)[_-]?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function missingPads(geom: FootprintGeom, pinNums: string[]): string[] {
  const have = new Set(geom.pads.map((p) => p.num));
  return pinNums.filter((n) => n !== "" && !have.has(n));
}

function genLqfp(n: number, spec: NominalSpec): FootprintGeom {
  const padW = Math.min(0.9, spec.pitchMm * 1.6);
  const padH = Math.min(0.35, spec.pitchMm * 0.55);
  return qfn(`LQFP-${n}`, n, spec.pitchMm, spec.bodyMm, padW, padH);
}

function genDualFamily(id: string, n: number, spec: NominalSpec): FootprintGeom {
  const bodyH = spec.bodyMm;
  const bodyW = spec.bodyWMm ?? 4.4;
  const rowGap = bodyW + 1.0;
  const padW = 1.0;
  const padH = Math.min(0.45, spec.pitchMm * 0.6);
  return dualRow(id, n, spec.pitchMm, rowGap, padW, padH, bodyH, bodyW);
}

function resolveParametricFamily(
  family: "LQFP" | "TSSOP" | "SSOP",
  libId: string,
  n: number | null,
  ref: string,
): FootprintResolveResult {
  const pkg = libId || family;
  if (n == null) {
    return { ok: false, reason: "unmapped_package", package: pkg, detail: `${family}: could not parse pin count` };
  }
  const nominal = family === "LQFP" ? LQFP_NOMINAL : family === "TSSOP" ? TSSOP_NOMINAL : SSOP_NOMINAL;
  const ambiguous = family === "LQFP" ? LQFP_AMBIGUOUS : family === "TSSOP" ? TSSOP_AMBIGUOUS : SSOP_AMBIGUOUS;
  if (ambiguous[n]) {
    return {
      ok: false,
      reason: "ambiguous_pitch",
      package: pkg,
      detail: `${family}-${n}: competing standard pitches [${ambiguous[n].join(", ")}] — refusing to guess`,
    };
  }
  const spec = nominal[n];
  if (!spec) {
    return {
      ok: false,
      reason: "unmapped_package",
      package: pkg,
      detail: `${family}-${n}: no unambiguous nominal mapping in allowlist`,
    };
  }
  const geom = family === "LQFP"
    ? genLqfp(n, spec)
    : genDualFamily(`${family}-${n}`, n, spec);
  return {
    ok: true,
    geom,
    assumption: {
      ref,
      package: pkg,
      message: `${family}-${n}: generated at nominal ${spec.pitchMm}mm pitch, ${spec.standard}, not vendor-verified`,
    },
  };
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
  "SOIC-8": () => dualRow("SOIC-8", 8, 1.27, 5.4, 1.5, 0.6, 3.9, 4.9),
  "SOIC-14": () => dualRow("SOIC-14", 14, 1.27, 5.4, 1.5, 0.6, 8.65, 6.0),
  "QFN-24": () => qfn("QFN-24", 24, 0.5, 4.0),
  "QFN-32": () => qfn("QFN-32", 32, 0.5, 5.0),
  "QFN-48": () => qfn("QFN-48", 48, 0.5, 7.0),
  "QFN-56": () => qfn("QFN-56", 56, 0.4, 7.0, 0.85, 0.18),
  "TQFP-64": () => qfn("TQFP-64", 64, 0.5, 10.0),
  "HTSSOP-28": () => htssop28("HTSSOP-28"),
  "LGA-8": () => lga8("LGA-8"),
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

export function debugFootprintTemplates(): Record<string, FootprintGeom> {
  return Object.fromEntries(Object.entries(TABLE).map(([id, make]) => [id, make()]));
}

function canonicalKey(libId: string, _value: string): string | null {
  const s = (libId || "").toLowerCase();
  const find = (frag: string) => s.includes(frag);
  // Fixed-entry families first (must not fall through to parametric or soft paths).
  if (find("htssop")) {
    const n = parsePinCount(libId);
    return n === 28 ? "HTSSOP-28" : null;
  }
  if (find("lga")) {
    const n = parsePinCount(libId);
    return n === 8 ? "LGA-8" : null;
  }
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
  if (find("screwterminal") || find("screw")) {
    // KiCad names use ScrewTerminal_1x02 / 1x03 — match optional zero.
    if (/1x0?3/.test(s)) return "ScrewTerminal_1x3";
    return "ScrewTerminal_1x2";
  }
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
  // No terminal C_0603 fallback — null means unmapped_package at the caller.
  return null;
}

function withPadCheck(
  result: FootprintResolveResult,
  pinNums: string[],
): FootprintResolveResult {
  if (!result.ok) return result;
  const missing = missingPads(result.geom, pinNums);
  if (!missing.length) return result;
  return {
    ok: false,
    reason: "pad_count_mismatch",
    package: result.geom.id,
    detail: `template has ${result.geom.pads.length} pad(s); schematic pins missing from footprint: [${missing.join(",")}]`,
  };
}

/**
 * Resolve a package string to geometry or an explicit failure reason.
 * Never invents placeholder pads. Never returns C_0603 for an unknown package.
 */
export function resolveFootprint(
  libId: string,
  value = "",
  pinNums: string[] = [],
  ref = "?",
): FootprintResolveResult {
  const s = (libId || "").toLowerCase();
  const n = parsePinCount(libId);

  // HTSSOP / LGA: fixed-entry only (handled via canonicalKey → TABLE).
  if (s.includes("htssop")) {
    const key = canonicalKey(libId, value);
    if (!key) {
      return {
        ok: false,
        reason: "unmapped_package",
        package: libId || "HTSSOP",
        detail: `HTSSOP-${n ?? "?"}: only HTSSOP-28 is a fixed TABLE entry; no parametric generator`,
      };
    }
    return withPadCheck({ ok: true, geom: TABLE[key]() }, pinNums);
  }
  if (s.includes("lga")) {
    const key = canonicalKey(libId, value);
    if (!key) {
      return {
        ok: false,
        reason: "unmapped_package",
        package: libId || "LGA",
        detail: `LGA-${n ?? "?"}: only LGA-8 is a fixed TABLE entry; no parametric generator`,
      };
    }
    return withPadCheck({ ok: true, geom: TABLE[key]() }, pinNums);
  }

  // Parametric families (order: LQFP, then TSSOP excluding HTSSOP, then SSOP excluding *TSSOP*).
  if (s.includes("lqfp")) {
    return withPadCheck(resolveParametricFamily("LQFP", libId, n, ref), pinNums);
  }
  if (s.includes("tssop")) {
    return withPadCheck(resolveParametricFamily("TSSOP", libId, n, ref), pinNums);
  }
  if (s.includes("ssop")) {
    return withPadCheck(resolveParametricFamily("SSOP", libId, n, ref), pinNums);
  }

  const key = canonicalKey(libId, value);
  if (key) {
    return withPadCheck({ ok: true, geom: TABLE[key]() }, pinNums);
  }

  return {
    ok: false,
    reason: "unmapped_package",
    package: libId || "(empty)",
    detail: `no TABLE or parametric mapping for package "${libId}" (value="${value}")`,
  };
}

/**
 * @deprecated Prefer resolveFootprint(). Throws if unresolved — kept for
 * call sites that still expect FootprintGeom synchronously during migration.
 */
export function footprintGeom(libId: string, value = "", pinNums: string[] = [], ref = "?"): FootprintGeom {
  const r = resolveFootprint(libId, value, pinNums, ref);
  if (!r.ok) {
    throw new Error(`Unresolved footprint ${ref} (${libId}): ${r.reason}${r.detail ? " — " + r.detail : ""}`);
  }
  return r.geom;
}
