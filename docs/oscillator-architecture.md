# Oscillator architecture

How layla turns a PCB netlist into a coupled-oscillator optimization
problem, decodes synchronized phases into a board layout, and lets the RSI loop
recursively improve the **substrate** that produces those layouts.

Reference implementation: [`src/core/osc.ts`](../src/core/osc.ts) (dynamics +
decode + seed racing) and [`src/core/oscTypes.ts`](../src/core/oscTypes.ts)
(the promotable `OscSubstrate`). The optional GPU backend is in
[`../mojo/`](../mojo/README.md).

---

## 1. PCB topology → oscillator graph

Each component is given a small bank of **phase oscillators** — `θx`, `θy`
(position) and `θrot` (orientation). The compiled graph (`OscGraph` in
`oscTypes.ts`) is built from four kinds of source signal:

- **Component oscillators** — the placeable degrees of freedom (`θx`, `θy`,
  `θrot`) per component. These are what get decoded into coordinates.
- **Net edges** — every shared net becomes **positive (attractive)** coupling
  between its members' oscillators: synchronize ⇒ place near. High-current /
  noisy nets get a heavier weight.
- **Rule / constraint edges** — built-in topology (cluster cohesion, noisy↔sensitive
  repulsion) shapes `K`. Symbolic anneal rules (`push_away` / `cluster_tight` /
  `anchor_edge` from `--feedback`) are **not** injected into this graph; they are
  constraints for the deterministic anneal optimizer only.
- **Condition oscillators** — the conditioning block (board archetype +
  thermal hotspots) does **not** add edges; it injects a
  per-node **drive** (`driveX`, `driveY`, `driveStrength`, scaled by the
  `condition.*` gains) that biases anchored nodes toward target board positions
  (antenna→edge, USB/connector→edge, …). Human `--feedback` text under oscillator
  is a visible scope notice, not a drive injection.

The signed coupling matrix `K` is therefore the netlist adjacency matrix,
scaled by the substrate's gain knobs (`attractScale`, `clusterAttract`,
`repelScale`, `noisySensitiveRepel`, …). It is stored sparse (CSR) because real
boards couple each component to only a handful of others.

```
component pins ─┐
shared nets    ─┼─▶  signed coupling K  (CSR: row_ptr, col_idx, kvals)
topology       ─┘        K_ij > 0  synchronize → place near
                         K_ij < 0  anti-phase  → keep apart

archetype  ┐
hotspots   ┼─▶  conditioning block  ─▶  per-node drive[b,i]  (steers, no edges)
           ┘
```

---

## Deterministic vs learned optimizers (decision)

| Channel | Role |
| --- | --- |
| **Deterministic (`anneal`)** | Explicit human-guided **symbolic rules** (`--feedback` → `push_away` / `cluster_tight` / `anchor_edge`) constrain the search. |
| **Learned (`oscillator`; future GNN/RL)** | Optimization driven by **learned representations** (substrate mutation today). Symbolic rule injection is intentionally not this optimizer's learning channel. |

Passing `--feedback` with `optimizer=oscillator` does not block the run; it emits
an explicit notice (CLI + `report.json.feedbackScopeNotice`) that symbolic rules
apply to anneal only. Cross-board transfer under oscillator carries the
**evolved substrate**, not a set of symbolic rules.

## 2. Un‑0 inspiration

The substrate is directly inspired by **Un‑0**, which generates images by
running a population of **coupled oscillators** steered by a **class-conditioning
block** that drives the main oscillator block.

- Blog: <https://unconv.ai/blog/introducing-un-0-generating-images-with-coupled-oscillators/>
- Code: <https://github.com/unconv-ai/Un-0>

layla borrows the *mechanism*, not the application. Un‑0 uses the
coupled-oscillator + conditioning structure to synthesize images; layla
uses the **same structure as an optimizer substrate** for placement: the main
oscillator population carries the layout degrees of freedom, and the
conditioning block injects board "intent" as drive. We are explicitly **not**
doing image generation — the oscillators encode component coordinates, and the
"image" is a routed, scored PCB layout.

## 3. Readout (phase → coordinate)

After integration, phases are decoded with a bounded, periodic readout
(`OscSubstrate.readout`):

```
coord = boardSize · sigmoid(a · sin(θ) + b · cos(θ))
```

Applying it to `θx`/`θy` gives an on-board `(x, y)`; `θrot` decodes to one of
the discrete rotations. `sigmoid` keeps every decoded point inside the board;
`(a, b)` rotate/scale how phase maps to space and are themselves part of the
mutable substrate.

## 4. Second-order (inertial) Kuramoto option

The integrator (`src/core/osc.ts`, mirrored in
[`../mojo/layla_kernels/kuramoto_place.mojo`](../mojo/layla_kernels/kuramoto_place.mojo))
supports two regimes, selected by the substrate:

```
force = ω_i + drive_i + Σ_j K_ij · sin(θ_j − θ_i)

inertia == 0 :  θ_i        += dt · force          # first-order, overdamped
inertia  > 0 :  v_i = (1 − damping·dt)·v_i + dt·force·inertia
                θ_i        += dt · v_i             # second-order, inertial
```

First-order is overdamped gradient flow that snaps to the nearest synchronized
basin. The **inertial** form gives the phases momentum so the population can
roll through *frustrated* coupling (mixed attract/repel) instead of locking into
the first local minimum; `damping` bleeds energy so it still converges. Which
regime (and the exact `inertia`/`damping`/`dt`/`steps`) wins is decided
empirically by the RSI loop, not assumed.

## 5. The substrate is the object the RSI loop improves

The promotable artifact is the **`OscSubstrate`** (`oscTypes.ts`): coupling
scales, natural frequencies `ω`, conditioning drives, integrator params
(`dt`, `steps`, `inertia`, `damping`), and the readout `(a, b)`. It is a small,
GPU-friendly vector of scalars. The RSI loop:

1. **Mutates** the substrate (perturb a coupling scale, a drive gain, `dt`,
   `steps`, the readout, …).
2. **Races a batch** of random initial-phase seeds through the integrator with
   the mutated substrate; decodes, routes, and scores each layout; keeps the
   best.
3. **Promotes** the mutation only if it passes the **shared gate list**
   applied to every `CandidateLayout` (not just substrate mutations):
   - the **canonical score improves** (same yardstick the optimizer targets), **and**
   - **exact copper clearance does not regress** (`drc_clearance_non_regression`,
     always on — reject only if exact `violations.length` exceeds the current
     best; broad-phase AABB counts feed `score.drcErrors` separately), **and**
   - the **EMI field check does not regress** (independent validator, §6), when
     EMI validation is enabled (`--emi` / `emiValidate`).

A mutation that lowers score but regresses exact clearance or field risk is
rejected. This is what makes the ratchet a ratchet: the substrate only moves in
directions that improve the canonical objective without making legality or the
field worse.

> **Transfer is verified separately, not inside the gate.** The promotion gate
> above runs on the *current* board only. Generality is demonstrated by carrying
> an evolved substrate to a brand-new board (`npm run demo` / `--rules`). On
> detected cross-board provenance mismatch, layla **races cold-start vs
> warm-start** and keeps the canonically better full state — transfer is
> non-harmful by construction (`npm run check-transfer-race`). Do not cite
> historical "~24% better" transfer numbers; they predate the routing/DRC
> fixes and the race.

> **One gate list, separate learning channels.** Symbolic rule promotion
> (hotspot-derived or `--feedback` `push_away` / `cluster_tight` / `anchor_edge`)
> is the **anneal** optimizer's constraint channel; substrate mutation is the
> **oscillator** learning channel. Those proposal mechanisms stay separate, but
> every resulting `CandidateLayout` enters the **same** ordered gate list in
> `optimizerBackend.ts` (`canonical_score` → `drc_clearance_non_regression` →
> conditional `emi_non_regression`). There is no carve-out that exempts rule
> candidates from EMI non-regression or from exact DRC non-regression.
## 6. Separation of concerns: propose vs. validate

Two independent subsystems, deliberately not conflated:

- **Oscillator dynamics — PROPOSES layouts.** It searches placement space by
  synchronization. It is fast, batched, and is what the substrate tunes.
- **Progressive voxel damped-wave ODE — VALIDATES field risk.** A separate
  2.5‑D progressive damped-wave field solver (`EmiReport` in `oscTypes.ts`,
  `model: "progressive_damped_wave_2p5d"`) estimates near-field coupling on a
  refined voxel grid and reports an aggregate **field risk**, peak `|u|`, and
  per-probe energy.

The validator never proposes placements and the optimizer never scores its own
field safety. The EMI pass is a **field-risk check used as a promotion gate**.
Canonical scope (`EMI_SCOPE_CLAIM` / `EmiReport.scope`): flags relative near-field
coupling risk between two placements for ranking purposes only — a unitless
comparative estimate, **never** absolute field strength (dB / V/m) or EMC
compliance. `emiRisk()` compares the finest-level blended scalar; `converged`
means refinement stability / ranking confidence across cell sizes, not
compliance, and does **not** alter `emi_non_regression` gate eligibility when
false. Not a substitute for certified testing.

## 7. The loop (ASCII)

```
                ┌────────────────────────────────────────────────────────┐
                │                     RSI LOOP                            │
                │                                                         │
   netlist ─────┼─▶ compile ─▶ OscGraph (CSR K + drives)                  │
                │                  │                                      │
                │                  ▼                                      │
                │      ┌────────────────────────┐                        │
   substrate ───┼────▶ │  Kuramoto integrate     │  batch of phase seeds  │
   (mutated) ◀──┼──┐   │  (1st / inertial)       │  raced in parallel     │
                │  │   └────────────────────────┘                        │
                │  │                  │ phases                            │
                │  │                  ▼ readout: boardSize·sigmoid(...)   │
                │  │        decode ─▶ route ─▶ canonical SCORE  ──┐       │
                │  │                                              │       │
                │  │        ┌─────────────────────────────────┐  │       │
                │  │        │ progressive damped-wave ODE PASS │  │       │
                │  │        │ (independent EMI field check)    │  │       │
                │  │        └─────────────────────────────────┘  │       │
                │  │                          │ field risk        │       │
                │  │                          ▼                   ▼       │
                │  │             PROMOTION GATE LIST (all candidates):       │
                │  │               score improves                            │
                │  └──── promote ◀── AND field risk no-regress (if --emi)   │
                │         if pass                                          │
                └────────────────────────────────────────────────────────┘
   transfer is verified separately: carry the evolved substrate to a new board.
```

`PROPOSE` (oscillators / anneal / rules) and `VALIDATE` (damped-wave field pass)
are separate; the gate list sits between them and ratchets any candidate forward
only when score (and field risk, when `--emi`) agree. Cross-board generality is
then demonstrated by the transfer race (cold vs warm on provenance mismatch;
see `npm run check-transfer-race`).