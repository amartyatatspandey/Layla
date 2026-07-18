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

## 2026-07-18 — Placement does not protect low-priority net locality

**Why:** Anneal/oscillator placement scoring has no term that keeps
low-priority signal nets' pads close together. On `robot_soc`, `LED_R`
(priority 2) can be placed with pads ~80mm+ apart, forcing a ~115mm route
tour through corridors already claimed by protected-tier copper
(`3V3`/`3V3A`/`5V`/`MOSI`/`ISENSE_*` at priority 4+). Negotiated congestion
correctly refuses to rip those nets (≤2 lower-priority-only victims, ≤3
passes, hard inter-net block). Medium-tier completion therefore floors at
≥98% (61/62) with reason-tagged `blocked_by_protected_copper` shortfalls —
not a router defect.

**Revisit when:** Task 4/5 hierarchical sparse oscillator placement lands.
Check whether cluster-derived hierarchy incidentally improves low-priority
locality; if not, add an explicit priority-aware placement locality
objective term (do not weaken router correctness to chase the remaining net).

**Risk if not fixed:** Medium boards keep a documented 1–2 net shortfall
ceiling under current placement; regressions that fail for *different*
reasons remain visible via `RoutingReport.unroutedFailures` reason tags.
