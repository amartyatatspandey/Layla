// Footprint compile report writer + designFromSchematic wrapper.
// Always writes <name>.footprint-report.json so unresolved packages cannot
// silently become a completed run.

import * as fs from "fs";
import * as path from "path";
import {
  FootprintAssumption,
  UnresolvedFootprintEntry,
  UnresolvedFootprintError,
} from "./footprints";
import { designFromSchematic } from "./synth";
import { BoardSpec, Design } from "./types";

export type FootprintReport =
  | {
      status: "ok";
      assumptions: FootprintAssumption[];
    }
  | {
      status: "rejected";
      entries: UnresolvedFootprintEntry[];
    }
  | {
      status: "rejected";
      reason: "internal_error";
      message: string;
    };

export function footprintReportPath(outDir: string, name: string): string {
  return path.join(outDir, `${name}.footprint-report.json`);
}

export function writeFootprintReport(outDir: string, name: string, report: FootprintReport): string {
  fs.mkdirSync(outDir, { recursive: true });
  const p = footprintReportPath(outDir, name);
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  return p;
}

export interface CompileDesignResult {
  design: Design;
  reportPath: string;
}

/**
 * Sole call-site wrapper around designFromSchematic: always writes
 * <name>.footprint-report.json before returning or aborting.
 */
export function compileDesign(
  schText: string,
  board: Partial<BoardSpec> | undefined,
  outDir: string,
): CompileDesignResult {
  const name = board?.name || "board";
  try {
    const design = designFromSchematic(schText, board);
    const reportPath = writeFootprintReport(outDir, name, {
      status: "ok",
      assumptions: design.footprintAssumptions ?? [],
    });
    return { design, reportPath };
  } catch (e) {
    if (e instanceof UnresolvedFootprintError) {
      const reportPath = writeFootprintReport(outDir, name, {
        status: "rejected",
        entries: e.entries,
      });
      e.reportPath = reportPath;
      throw e;
    }
    const message = e instanceof Error ? e.message : String(e);
    writeFootprintReport(outDir, name, {
      status: "rejected",
      reason: "internal_error",
      message,
    });
    throw e;
  }
}

export function isUnresolvedFootprintError(e: unknown): e is UnresolvedFootprintError {
  return e instanceof UnresolvedFootprintError;
}

// Re-export error types so callers can import from footprintReport or footprints.
export { UnresolvedFootprintError, UnresolvedFootprintEntry };
export type { FootprintFailReason } from "./footprints";
