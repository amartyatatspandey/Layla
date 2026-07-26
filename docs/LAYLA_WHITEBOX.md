# Layla — Whitebox Guide

A plain-language, code-accurate walkthrough of what Layla is, how the repo is organized, how a schematic becomes a board, and what the system can (and cannot) do today.

This document explains the **implementation** in `layla/`. For deeper oscillator math see [`oscillator-architecture.md`](./oscillator-architecture.md). For the living roadmap see [`Layla_implementation_master.md`](./Layla_implementation_master.md). For historical bug findings see [`../LAYLA_AUDIT.md`](../LAYLA_AUDIT.md) (append-only; some early findings are fixed).

---

## 1. What Layla is (in one breath)

**Layla is an offline PCB layout engine:** you give it a KiCad schematic (`.kicad_sch`), and it produces a placed and (tiered) routed KiCad board (`.kicad_pcb`), plus SVGs and a JSON report.

The unusual part is the **recursively self-improving (RSI) loop**. Placement is driven by a **coupled-oscillator (Kuramoto) substrate** whose parameters are mutated across iterations. A candidate layout is promoted only when it beats a fixed geometric/field-risk score (and, optionally, does not regress an independent EMI check). So the best score is **monotonically non-increasing** — the design can get better or stay flat, never silently worse on the canonical objective.

It ships as:

| Surface | Role |
| --- | --- |
| **CLI** (`src/cli.ts`) | Batch / scripting: `inspect`, `synth`, `learn`, `batch`, `demo`, `bench` |
| **Electron app** (`app/` + `src/electron/`) | Desktop UI over the same core |
| **OpenForge UI glue** (sibling repo) | Workspace / demo artifacts under `/layla` — thin wrapper, not a second engine |

Fully offline: no `kicad-cli`, no network, no API keys. TypeScript is the reference engine; optional Mojo GPU kernels exist but are not required.

---

## 2. Mental model: propose → judge → ratchet

Think of Layla as three layers that must stay separate:

```
┌─────────────────────────────────────────────────────────────┐
│  PROPOSE (optimizer backends)                               │
│  anneal: symbolic rules constrain SA search                 │
│  oscillator: Kuramoto substrate → phases → coordinates      │
└──────────────────────────┬──────────────────────────────────┘
                           │ CandidateLayout { layout } only
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  JUDGE (uniform gates — never branch on provenance)         │
│  1. canonical_score          always                         │
│  2. drc_clearance_non_regression  always (exact clearance)  │
│  3. emi_non_regression       when --emi                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ promote scoped patch only if all pass
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  LEARN / PERSIST                                            │
│  anneal → promoted symbolic rules in Ruleset.rules          │
│  oscillator → mutated OscSubstrate in Ruleset.substrate     │
│  + provenance hash for cross-board transfer racing          │
└─────────────────────────────────────────────────────────────┘
```

Key architectural rules locked in the codebase:

1. **One canonical objective** — `scoreLayout(..., DEFAULT_WEIGHTS)`. No per-optimizer weight retuning.
2. **No branching on provenance** — gates see `{ layout }`, not “this came from a rule.”
3. **Deterministic vs learned channels** — symbolic `--feedback` rules are for `anneal`; oscillator learns via **substrate mutation**.
4. **Hard-fail over silent fallback** — unmapped footprints abort with a rejection report instead of inventing pads.

---

## 3. Repository map

```
layla/
├── src/
│   ├── cli.ts                 # command-line front end
│   ├── core/                  # the entire layout engine
│   ├── electron/              # Electron main + preload IPC
│   └── scripts/               # gate tests + gen-examples
├── app/                       # renderer UI (HTML/CSS/JS)
├── examples/                  # five bundled boards + index.json
├── docs/                      # architecture + this whitebox
├── mojo/                      # optional GPU Kuramoto kernels
├── build/                     # generated outputs (gitignored-ish)
├── dist/                      # tsc output
├── README.md                  # user-facing overview + CLI
├── LAYLA_AUDIT.md             # historical capability audit
└── technical_debt.md          # append-only known gaps
```

### `src/core/` — module cheat sheet

| File | ~lines | What it does |
| --- | ---: | --- |
| `sexpr.ts` | 230 | Parse/serialize KiCad S-expressions |
| `schematic.ts` | 220 | `.kicad_sch` → raw components + **offline union-find netlist** |
| `classify.ts` | 195 | Roles, net classes, clusters → `Design` IR + footprint resolve |
| `footprints.ts` | 500 | Procedural pad geometry (no KiCad lib required) |
| `footprintReport.ts` | 90 | Always-written footprint ok/rejected report |
| `geometry.ts` | 120 | 2D primitives |
| `layoututil.ts` | 95 | World pad/courtyard helpers |
| `types.ts` | 250 | Shared IR: `Design`, `Layout`, `Score`, `Ruleset`, … |
| `oscTypes.ts` | 130 | `OscSubstrate`, `OscGraph`, EMI report contracts |
| `osc.ts` | 500 | Flat Kuramoto place: compile graph, integrate, decode, mutate |
| `oscHierarchy.ts` | 710 | Hierarchical sparse coupling for large boards |
| `place.ts` | 310 | Simulated annealing (baseline + legalization polish) |
| `route.ts` | 1160 | Grid A\* + tiered coverage + negotiated congestion |
| `score.ts` | 290 | Canonical objective + hotspots |
| `emi.ts` | 410 | Progressive 2.5D damped-wave field validator |
| `rules.ts` | 135 | Symbolic rule synthesis (anneal channel) |
| `rulesetPatches.ts` | 70 | Scoped promotion patches (no whole-object overwrite) |
| `optimizerBackend.ts` | 280 | Backend interface + ordered promotion gates |
| `synth.ts` | 305 | Orchestrator: `designFromSchematic`, `synthOnce`, `improve` |
| `provenance.ts` | 65 | Schematic content-hash stamping |
| `transferRace.ts` | 120 | Cold vs warm improve race on cross-board transfer |
| `board.ts` | 260 | Emit `.kicad_pcb` |
| `lvs.ts` | 100 | Re-parse emitted board vs schematic connectivity |
| `drc.ts` | 400 | Broad (in-score) + exact (gate/report) clearance |
| `svg.ts` | 800 | Board / heatmap / curve / oscillator / EMI SVGs |
| `schemgen.ts` | 140 | Author example `.kicad_sch` files |
| `rng.ts` | 30 | Seeded deterministic RNG |

---

## 4. End-to-end pipeline (what happens on `synth`)

When you run:

```bash
node dist/cli.js synth examples/buck_imu/buck_imu.kicad_sch --iterations 8
```

the flow is:

### Step A — Compile schematic → `Design`

1. **`parseSchematic`** (`schematic.ts`) reads the S-expr tree: symbols, wires, labels, power symbols.
2. **Offline netlister** (union-find) connects wire endpoints, coincident pin positions, and shared label names. Power symbols contribute a global label equal to their value. Matches single-sheet KiCad behavior without calling KiCad.
3. **`buildDesign`** (`classify.ts`):
   - Assigns each part a **role** (`mcu`, `regulator`, `imu`, `antenna`, `decap`, …) from ref prefix, value, footprint, and net names.
   - Classifies each **net** (`ground`, `power`, `noisy`, `sensitive`, `usb`, `clock`, …) and sets routing **priority**.
   - Groups parts into **clusters** (`buck_converter`, `usb`, `rf`, `sensor`, `motor`, …).
   - Resolves **footprints** procedurally. Failures throw `UnresolvedFootprintError` and write `<name>.footprint-report.json` — no silent 2-pad fallback.
4. Board size comes from `layla.json` beside the schematic, or is auto-sized from part count. Default mounting holes are added if missing.

### Step B — RSI `improve()` loop (`synth.ts`)

For each iteration (default 8):

1. **Explore** — `synthOnce` via `OptimizerBackend` produces one layout + score. If better than current best on score alone, it becomes the reference best (and exact DRC / optional EMI are cached on `BestState`).
2. **Propose patches** (from a shared ruleset snapshot):
   - Oscillator: `mutateSubstrate` → `SubstratePatch`
   - Both paths may also synthesize symbolic rules from **hotspots** → `RulePatch` (rules only meaningfully constrain anneal)
3. **Materialize** each trial ruleset → place → route → score.
4. **`evaluatePromotionGates`** — reject unless score improves **and** exact clearance does not regress **and** (if `--emi`) EMI risk does not regress beyond ×1.08.
5. **Scoped accept** — `applyPromotionPatch` updates only the owned field (`rules[]` or `substrate`), never a stale whole-object replace.

### Step C — Emit + verify (`cli.ts` → `writeOutputs`)

Writes:

| Artifact | Contents |
| --- | --- |
| `<name>.kicad_pcb` | Real KiCad 7/8-style board |
| `<name>.board.svg` | Copper / courtyards view |
| `<name>.heatmap.svg` | Geometric field-risk proxy + hotspots |
| `<name>.curve.svg` | Score vs iteration |
| `<name>.oscillator.svg` | Phase field, couplings, sync order `R(t)` (osc runs) |
| `<name>.emi.svg` | Voxel field heatmap |
| `<name>.report.json` | Full score, history, EMI, LVS, DRC, routing, substrate |
| `<name>.rules.json` | Ruleset (rules + substrate + provenance + topologyMode) |

Then runs **assistive** checks (warn in console; do not fail exit code by themselves):

- **LVS** (`lvs.ts`) — re-parse emitted PCB text vs schematic pin↔net bindings
- **Exact DRC** (`drc.ts`) — copper clearance between different nets
- **Routing summary** — tier, completion ratio, unrouted failure reasons

---

## 5. Placement: the two optimizers

### 5.1 Oscillator (default) — `osc.ts` + `oscHierarchy.ts`

Inspired by [Un‑0](https://unconv.ai/blog/introducing-un-0-generating-images-with-coupled-oscillators/), but used as a **placement optimizer**, not image generation.

**Graph compilation**

- Each component → oscillators for `θx`, `θy`, `θrot`
- Shared nets → **attractive** coupling (sync ⇒ place near)
- Clusters → extra attraction
- Noisy ↔ sensitive → **anti-phase / repulsive** coupling
- Conditioning block → per-node **drive** (USB/connector→edge, antenna→edge, etc.) — steer without adding edges

**Integration & decode**

- Many random initial-phase **seeds** race in a batch (default ~16)
- Phases integrate (first- or second-order Kuramoto depending on `inertia`)
- Decode: `coord = boardSize · sigmoid(a·sinθ + b·cosθ)`
- Light anneal **polish** + route + score pick the winning seed inside the backend

**What the RSI mutates** — the `OscSubstrate` knobs (`attractScale`, `noisySensitiveRepel`, readout `ax/bx/…`, condition gains, integrator params). Promoting a mutation means “this is a better optimizer settings vector for boards like this,” not just “this board looks nicer.”

**Hierarchy** — when `components ≥ 64` or flat edges `> 400`, coupling switches to hierarchical sparse mode (cluster partitions, hub-to-hub inter-partition repulsion, coarse-to-fine). Mode stamped as `topologyMode: "flat" | "hierarchical"` on the ruleset.

### 5.2 Anneal (baseline) — `place.ts`

Classic simulated annealing over placements, with symbolic rules as search constraints:

| Rule kind | Intent |
| --- | --- |
| `push_away` | Separate role/net groups |
| `cluster_tight` | Pull a functional cluster together |
| `anchor_edge` | Pin connectors/antenna to an edge |
| `place_near` / `keepout` / `route_critical` | Additional guidance |

`--feedback "keep buck away from imu"` compiles into these under **anneal only**. Under oscillator, the same flag prints `FEEDBACK_SCOPE_NOTICE` and continues — learning stays on the substrate.

---

## 6. Routing — `route.ts`

Two-layer (F.Cu / B.Cu) **grid A\*** with via costs.

**Hard inter-net block** — a cell owned by another net cannot be soft-crossed. Congestion history and rip-up exist, but shorts are not “cheaper detours.”

**Negotiated congestion** — failed routes may rip up ≤2 lower-priority victims and retry ≤3 deterministic passes.

**Tiered coverage** (honest expectations):

| Tier | Typical boards | Demand nets | Target completion |
| --- | --- | --- | --- |
| `small` | buck_imu, motor_driver, rf_sensor | all non-ground | **100%** |
| `medium` | robot_soc | all non-ground | **≥98%** |
| `stress` | mainboard | critical/capped only | **≥5%** |

Unrouted nets are listed in `report.json.routing` with reason tags (e.g. `blocked_by_protected_copper`). Do not assume universal autorouting on large boards.

---

## 7. Scoring — what “better” means (`score.ts`)

Lower `Score.total` is better. Fixed weights (`DEFAULT_WEIGHTS`):

| Term | Penalizes |
| --- | --- |
| `ratsnest` | MST length of unrouted connectivity |
| `crossings` | Ratsnest edge crossings |
| `courtyard` | Component courtyard overlaps |
| `offboard` | Geometry outside outline |
| `decap` | Decaps far from their IC |
| `switchLoop` | Buck Cin→reg→L hot-loop area |
| `noisySensitive` | Noisy/high-current near sensitive nets |
| `usbPair` | USB differential length/skew |
| `antenna` | Keepout violations / antenna off edge |
| `highCurrent` | Length × current |
| `thermal` | Heat-source density |
| `returnPath` | Sensitive nets across noisy clusters |
| `drc` | Courtyard/offboard **plus** broad-phase copper pair count |

Also emits ranked **hotspots** with suggested actions (feeds rule synthesis).

**In-loop vs exact DRC**

- Score `drc` uses cheap **broad-phase** AABB pairs (optimizer signal).
- Promotion gate + `report.json.drc` use **exact** narrow-phase clearance (`checkClearance`).

---

## 8. EMI validation — `emi.ts` (optional `--emi`)

A **separate** progressive 2.5D damped-wave voxel solver. Three z-layers: F.Cu signal, dielectric, B.Cu ground (energy sink). Refines cell sizes 4→2→1 mm.

Approved scope (`EMI_SCOPE_CLAIM`): relative near-field **coupling-risk ranking** between two layouts — **not** absolute V/m, **not** EMC compliance. `converged` means refinement stability, not pass/fail compliance.

When `--emi` is on, every promotion candidate must satisfy:

`emiRisk(candidate) ≤ emiRisk(best) × 1.08`

---

## 9. Learning, transfer, and the cold/warm race

### Same-board continuation

Load `--rules previous.rules.json` whose provenance hash matches the schematic → single `improve()` pass continues evolving that substrate/rules.

### Cross-board transfer (`transferRace.ts`)

If hashes **mismatch**, Layla automatically races:

1. **COLD** — default substrate / fresh start  
2. **WARM** — transferred evolved substrate  

Same seed/budget policy; keep the **wholesale winner** by final `Score.total`. Transfer is therefore **non-harmful by construction**.

Legacy rulesets without provenance: explicit notice, treated as continuation (never guessed).

The demo (`npm run demo`) evolves on `buck_imu` then transfers to `motor_driver` — that is the headline “optimizer improves itself” story.

---

## 10. What Layla can currently do

### Capabilities that work today

| Capability | Status |
| --- | --- |
| Parse single-sheet KiCad schematics offline | ✅ |
| Role / net / cluster classification | ✅ |
| Procedural footprints with hard-fail on unknown packages | ✅ |
| Oscillator placement (default) + hierarchical sparse on large boards | ✅ |
| Annealing baseline + polish | ✅ |
| Tiered A\* routing with hard foreign-net block | ✅ |
| Canonical multi-term scoring + hotspots | ✅ |
| RSI loop with monotonic best-score ratchet | ✅ |
| Uniform promotion gates (score → exact DRC → optional EMI) | ✅ |
| Emit real `.kicad_pcb` + diagnostic SVGs + report JSON | ✅ |
| LVS-equivalent post-emit connectivity check | ✅ |
| Exact copper clearance DRC (report + promotion gate) | ✅ |
| Cross-board substrate transfer with cold/warm race | ✅ |
| Head-to-head `bench` (oscillator vs anneal) | ✅ |
| Electron desktop UI over the same core | ✅ |
| Deterministic seeded runs | ✅ |
| Gate-test suite (`npm run check-*`) | ✅ |

### Bundled example boards

| Board | Character | Routing tier |
| --- | --- | --- |
| `buck_imu` | ESP32 + buck + IMU — classic noisy↔sensitive tension | small |
| `motor_driver` | STM32 + DRV8313 + current sense | small |
| `rf_sensor` | nRF52840 + antenna keepout + BME280 | small |
| `robot_soc` | H7 + BLDC stage + radio + sensors | medium |
| `mainboard` | ~200-part autonomy stress board | stress |

On a fixed seed, oscillator typically beats anneal substantially on these boards (see README `bench` table; numbers move when routing/DRC behavior changes — re-run `bench` rather than treating any old % as gospel).

### CLI commands you can use

```text
layla inspect <board.kicad_sch>     # topology only
layla synth   <board.kicad_sch>     # full RSI → board + artifacts
layla learn   <board.kicad_sch>     # feedback → anneal rules JSON
layla batch   <dir|file>            # many boards
layla demo                          # all examples + transfer demo
layla bench                         # oscillator vs anneal table
```

Useful flags: `--optimizer oscillator|anneal`, `--emi`, `--iterations N`, `--rules`, `--feedback`, `--seed`, `--config`, `--out`.

### Electron app can

- Pick a bundled example or load a `.kicad_sch`
- Set iterations / optimizer / EMI
- Run the live improve loop
- View board / heatmap / oscillator / EMI / learning-curve tabs
- Save `.kicad_pcb` and rules JSON

---

## 11. What it deliberately is not

Be honest with yourself (and users):

| Not this | Reality |
| --- | --- |
| Certified EMC tool | Geometric proxies + optional relative EMI ranking |
| Full fab-rule DRC | Clearance only — no annular ring, no current-vs-width deck |
| Universal autorouter | Tiered completion; stress boards leave most nets as ratsnest |
| Fab-ready finishing tool | Excellent **first-pass** starting point for review in KiCad |
| Multi-sheet hierarchical schematic netlister | Single-sheet oriented |
| RL / GNN placement (yet) | Milestone 4 explicitly out of scope in the master plan; substrate mutation is today’s learned channel |

Known coverage gaps (see `technical_debt.md`): HTSSOP/LGA need fixed table entries (no parametric generator); placement does not yet optimize low-priority net locality, which can leave 1–2 medium-tier nets blocked by protected copper.

---

## 12. How the pieces talk (call graph sketch)

```
cli.ts / electron/main.ts
    │
    ├─ compileDesign / designFromSchematic
    │     parseSchematic → buildDesign → resolveFootprint
    │
    └─ improveWithLoadedRuleset  (provenance / transfer race)
          └─ improve
                ├─ createBackend(oscillator|anneal)
                ├─ synthOnce → materializeCandidate
                │     ├─ backend.place
                │     │     oscillator: oscillatorPlace → polish anneal → route → score (seed race)
                │     │     anneal:     seedPlacement → anneal
                │     ├─ routeLayout (anneal path)
                │     └─ scoreLayout(DEFAULT_WEIGHTS)
                ├─ mutateSubstrate / synthesizeFromHotspots → patches
                ├─ evaluatePromotionGates
                │     canonical_score → checkClearance → validateEmiProgressive?
                └─ applyPromotionPatch
    │
    └─ writeBoard → verifyLvs → checkClearance → SVGs → report.json
```

---

## 13. Verification & quality gates

Gate scripts (not a Jest suite) under `src/scripts/` — exit non-zero on failure:

| npm script | Guards |
| --- | --- |
| `check-footprints` / `check-footprint-pads` | Pad coverage / resolve |
| `check-lvs` | Connectivity report clean on bundled boards |
| `check-drc` | Clearance + router hard-block |
| `check-inloop-drc` | Broad score signal + exact gate fixtures |
| `check-routing-completeness` | Tier targets, determinism, rip-up |
| `check-rules-scope` | Feedback/anneal vs oscillator notice |
| `check-optimizer-backend` | Backend + uniform gates |
| `check-osc-hierarchy` | Hierarchical coupling |
| `check-emi-scope` | Relative-ranking claim + gate |
| `check-transfer-race` | Cold/warm race behavior |
| `check-ruleset-patches` | Scoped promotion patches |
| `check-milestone3-integration` | End-to-end milestone cohesion |

Typical local loop:

```bash
cd layla
npm install
npm run build
npm run gen-examples
npm run demo          # or: npm run app
```

---

## 14. OpenForge relationship

In the PCB ecosystem thesis:

- **OpenForge** — knowledge / retrieval / design-assistant product surface  
- **Layla** — optimization substrate (this repo)  
- **GroundTruth** — independent verification (sibling concern)

OpenForge’s UI can list Layla runs and serve demo artifacts (`open_forge` `/layla` routes). That is **integration glue**, not a reimplementation of the TypeScript core. When developing layout behavior, edit `layla/src/core/*`.

---

## 15. Quick “where do I look?” index

| I want to understand… | Start here |
| --- | --- |
| Overall product story | `README.md` |
| This whitebox (you are here) | `docs/LAYLA_WHITEBOX.md` |
| Oscillator math & Un‑0 mapping | `docs/oscillator-architecture.md` |
| What to build next / locked decisions | `docs/Layla_implementation_master.md` |
| Historical bugs & fixes | `LAYLA_AUDIT.md` |
| Known intentional gaps | `technical_debt.md` |
| IR types | `src/core/types.ts`, `oscTypes.ts` |
| The ratchet | `src/core/synth.ts` |
| Gates | `src/core/optimizerBackend.ts` |
| Transfer racing | `src/core/transferRace.ts` |
| Router policy | `src/core/route.ts` |
| CLI surface | `src/cli.ts` |
| Desktop UI | `app/renderer.js`, `src/electron/main.ts` |

---

## 16. One-paragraph summary

Layla takes a KiCad schematic, builds a classified design IR with procedural footprints, places parts with a coupled-oscillator substrate (or annealing), routes on a two-layer grid with honest tiered coverage, scores layouts on a fixed multi-term objective, and ratchets the best score down by promoting only gate-passing substrate mutations or (under anneal) symbolic rules. It emits a real board file plus diagnostics, verifies connectivity and clearance after emit, can optionally EMI-gate promotions, and can transfer a learned substrate to a new board under a cold/warm race so transfer never hurts by construction. It is a strong offline first-pass mixed-signal layout engine with a measurable self-improvement loop — not a fab DRC suite, not certified EMC, and not a finished autorouter for 200-part boards.
