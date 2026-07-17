// LVS-equivalent connectivity verification.
//
// LAYLA_AUDIT.md finding B: nothing in the pipeline re-derived
// connectivity from the emitted .kicad_pcb and diffed it against the input
// schematic netlist — writeBoard() trusted the Design IR unconditionally.
// Prompt 1 fixed the specific footprint bug that made that dangerous; this
// module is the general-purpose check, so any *future* connectivity-losing
// bug (footprint, routing, or board-emission itself) gets caught
// automatically instead of requiring another manual audit.
//
// This is a pure function over TEXT, not over the in-memory Design/Layout
// that produced it: verifyLvs() re-parses the actual emitted .kicad_pcb
// string with the S-expression parser and rebuilds board-side connectivity
// from scratch. Re-deriving from the artifact (rather than re-running the
// same in-memory structures writeBoard() used) is what makes this
// LVS-equivalent — a bug in writeBoard()'s emission logic itself would be
// invisible to a check that only inspected Design/Layout.

import { parse, childrenOf, child, atomVal, SList } from "./sexpr";
import { Design } from "./types";

export interface LvsPin { ref: string; pin: string; net: string; }
export interface LvsNetMismatch { ref: string; pin: string; schematicNet: string; boardNet: string; }

// Stable, documented shape for report.json's `lvs` field — consumed
// downstream by a human/automated review gate, not just printed.
//   clean          — true iff missing/extra/netMismatch are all empty
//   missing        — schematic (ref, pin) pairs with no matching pad+net
//                     anywhere in the emitted board (the exact failure mode
//                     of the footprint bug prompt 1 fixed)
//   extra          — board pads bound to a real net (net code != 0) whose
//                     (ref, pin) the schematic never declared at all
//                     (unconnected/mechanical pads — net code 0 — are not
//                     flagged; they carry no connectivity claim to diff)
//   netMismatch    — same (ref, pin) present in both, but bound to a
//                     different net name in the schematic vs. the board
export interface LvsReport {
  clean: boolean;
  missing: LvsPin[];
  extra: LvsPin[];
  netMismatch: LvsNetMismatch[];
}

interface BoardPad { ref: string; pin: string; netCode: number; netName: string; }

// Re-derive (ref, pad) -> (netCode, netName) purely from the emitted
// .kicad_pcb text — does not touch Design/Layout.
function parseBoardConnectivity(pcbText: string): BoardPad[] {
  const root = parse(pcbText);
  const out: BoardPad[] = [];
  for (const fp of childrenOf(root, "footprint")) {
    const refProp = childrenOf(fp, "property").find((p) => atomVal(p.items[1]) === "Reference");
    const ref = refProp ? atomVal(refProp.items[2]) : undefined;
    if (!ref) continue; // e.g. MountingHole footprints carry no Reference — not a schematic component
    for (const pad of childrenOf(fp, "pad")) {
      const pin = atomVal(pad.items[1]) ?? "";
      if (pin === "") continue; // unnumbered pads (mounting holes, ...) aren't schematic pins
      const netNode: SList | undefined = child(pad, "net");
      const netCode = netNode ? Number(atomVal(netNode.items[1]) ?? "0") : 0;
      const netName = netNode ? (atomVal(netNode.items[2]) ?? "") : "";
      out.push({ ref, pin, netCode, netName });
    }
  }
  return out;
}

export function verifyLvs(design: Design, pcbText: string): LvsReport {
  // Truth A: schematic-derived connectivity — for every net, its declared
  // (ref, pin) members, straight from the Design IR classify.ts built from
  // the parsed schematic (pre-layout, pre-routing).
  const schematicByKey = new Map<string, string>(); // "ref:pin" -> net name
  for (const net of design.nets) {
    for (const pr of net.pins) schematicByKey.set(`${pr.ref}:${pr.pad}`, net.name);
  }

  // Truth B: re-derived from the emitted board artifact.
  const boardByKey = new Map<string, BoardPad>();
  for (const bp of parseBoardConnectivity(pcbText)) boardByKey.set(`${bp.ref}:${bp.pin}`, bp);

  const missing: LvsPin[] = [];
  const extra: LvsPin[] = [];
  const netMismatch: LvsNetMismatch[] = [];

  for (const [key, netName] of schematicByKey) {
    const [ref, pin] = key.split(":");
    const bp = boardByKey.get(key);
    if (!bp) { missing.push({ ref, pin, net: netName }); continue; }
    if (bp.netName !== netName) netMismatch.push({ ref, pin, schematicNet: netName, boardNet: bp.netName });
  }
  for (const [key, bp] of boardByKey) {
    if (bp.netCode === 0) continue; // unconnected/mechanical pad — no connectivity claim to diff
    if (!schematicByKey.has(key)) extra.push({ ref: bp.ref, pin: bp.pin, net: bp.netName });
  }

  return {
    clean: missing.length === 0 && extra.length === 0 && netMismatch.length === 0,
    missing, extra, netMismatch,
  };
}
