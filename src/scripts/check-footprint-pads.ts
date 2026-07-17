// Gate test: every component's synthesized footprint must carry one pad per
// declared schematic pin number. Catches the silent pin-drop bug in
// footprintGeom() documented as LAYLA_AUDIT.md finding B — an
// unmapped package string (LQFP/HTSSOP/TSSOP/SSOP/LGA/...) used to fall back
// to a fixed 2-pad chip footprint regardless of the component's real pin
// count, so pins beyond "1"/"2" silently had no world pad position anywhere
// downstream (scoring, routing, EMI, the emitted .kicad_pcb).
import * as fs from "fs";
import * as path from "path";
import { designFromSchematic } from "../core";

const EX_DIR = path.join(__dirname, "..", "..", "examples");

function loadConfig(schPath: string): Record<string, unknown> {
  const cfgPath = path.join(path.dirname(schPath), "layla.json");
  if (!fs.existsSync(cfgPath)) return {};
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const b = raw.board || raw;
  return { name: raw.name, width: b.width, height: b.height, diffPairs: b.diffPairs || [] };
}

function main(): void {
  const index: { name: string; schematic: string; config: string }[] =
    JSON.parse(fs.readFileSync(path.join(EX_DIR, "index.json"), "utf8"));

  let totalMismatched = 0;
  for (const ex of index) {
    const schPath = path.join(EX_DIR, ex.schematic);
    const text = fs.readFileSync(schPath, "utf8");
    const cfg = loadConfig(schPath) as any;
    const design = designFromSchematic(text, { ...cfg, name: cfg.name || ex.name });

    let boardMismatched = 0;
    for (const c of design.components) {
      const fp = design.footprints[c.ref];
      const padNums = new Set((fp?.pads ?? []).map((p) => p.num));
      const declared = c.pins.map((p) => p.num).filter((n) => n !== "");
      const missing = declared.filter((n) => !padNums.has(n));
      if (missing.length > 0) {
        boardMismatched++;
        totalMismatched++;
        console.error(
          `  MISMATCH  ${ex.name}:${c.ref}  (${c.libId}, value="${c.value}")  ` +
          `schematic pins=${declared.length}  footprint pads=${fp?.pads.length ?? 0}  ` +
          `missing pad numbers=[${missing.join(",")}]`,
        );
      }
    }
    console.log(`${ex.name.padEnd(14)} components=${String(design.components.length).padStart(4)}  mismatched=${boardMismatched}`);
  }

  if (totalMismatched > 0) {
    console.error(`\nFAIL: ${totalMismatched} component(s) across bundled examples have a footprint pad count/number mismatch against their schematic pins.`);
    process.exit(1);
  }
  console.log("\nPASS: every component's footprint pads match its schematic pin numbers on all bundled examples.");
}

main();
