# Technical debt

## 2026-07-18 — Footprint resolution coverage gaps

### HTSSOP fixed-entry only, no parametric generator

**Why:** Exposed-pad (EP) geometry is not derivable from pin count alone. There is exactly one real HTSSOP instance in the bundled example boards today — HTSSOP-28 (DRV8313 on `motor_driver`).

**Revisit when:** A second distinct HTSSOP pin count appears in a real board.

**Risk if not fixed:** Every new HTSSOP size requires a manual fixed-entry addition before that board can build (hard-fail otherwise). This is a **coverage gap**, not a correctness gap — the pipeline will not silently invent a wrong footprint.

### LGA fixed-entry only, no parametric generator

**Why:** LGA land patterns are part-specific (pad maps, pitches, thermal pads). There is exactly one mapped size today — LGA-8 (BME280 / BMP390 instances).

**Revisit when:** A second LGA pin count or pitch appears in a real board.

**Risk if not fixed:** Same as HTSSOP — coverage gap only; unmapped LGA sizes hard-fail with a rejection report rather than a silent wrong footprint.
