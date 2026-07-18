# Footprint Hard-Fail Design

**Date:** 2026-07-18  
**Status:** Locked for implementation

## Problem

Unmapped package strings previously fell through to a 2-pad `C_0603` footprint (and later soft placeholders). Pins beyond `"1"`/`"2"` silently lost world pad positions; routing/scoring still reported clean completion.

## Decision

Unmapped, ambiguous, or pad-mismatched packages **hard-fail** at design compile. No silent geometry fallback.

## Resolution modes

| Family | Mode |
|---|---|
| LQFP, TSSOP, SSOP | Parametric by parsed pin count N via IPC/JEDEC nominal allowlist. Success logs an assumption disclosure. Competing standard pitches → `ambiguous_pitch`. |
| HTSSOP | Fixed entry only: `HTSSOP-28`. Any other N → `unmapped_package`. |
| LGA | Fixed entry only: `LGA-8`. Any other N → `unmapped_package`. |
| Else | Existing `TABLE` / `canonicalKey`. No match → `unmapped_package`. |

### Removed (no replacement, no re-enable flag)

- `C_0603` terminal fallback in `canonicalKey`
- `genericPlaceholder`
- `dynamicPackageGeom`
- `ensurePadCoverage` silent pad inventing

### Failure reasons (identical hard-fail path)

1. `unmapped_package`
2. `ambiguous_pitch`
3. `pad_count_mismatch` — template pads do not cover schematic pin numbers

Failures accumulate across the component loop in `buildDesign`; one `UnresolvedFootprintError` is thrown covering every failing component.

## Compile choke + report

- `designFromSchematic` is the sole compile choke (does not catch the error).
- Every call site wraps compile:
  - `UnresolvedFootprintError` → write `<name>.footprint-report.json` with `{ status: "rejected", entries }`, non-zero / IPC error, no `.kicad_pcb` / scoring `report.json`.
  - Other compile errors → write `{ status: "rejected", reason: "internal_error", message }`, then rethrow/log.
  - Success → write `{ status: "ok", assumptions: [...] }` (`assumptions` always present, possibly `[]`).
- `Design.footprintAssumptions` always present.

## Out of scope

No changes to `score.ts`, `osc.ts`, or `route.ts`.

## Technical debt

Documented in repo-root `technical_debt.md`: HTSSOP and LGA remain fixed-entry-only until a second distinct pin count appears in a real board.
