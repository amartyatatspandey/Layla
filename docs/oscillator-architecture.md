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
- **Rule / constraint edges** — learned or default rules add coupling:
  `cluster_tight` ⇒ extra intra-cluster attraction; `push_away` and the
  built-in *noisy ↔ sensitive* relation ⇒ **negative (anti-phase)** coupling:
  repel ⇒ keep apart.
- **Condition oscillators** — the conditioning block (board archetype +
  thermal hotspots + human feedback) does **not** add edges; it injects a
  per-node **drive** (`driveX`, `driveY`, `driveStrength`, scaled by the
  `condition.*` gains) that biases anchored nodes toward target board positions
  (antenna→edge, USB/connector→edge, …).

The signed coupling matrix `K` is therefore the netlist adjacency matrix,
scaled by the substrate's gain knobs (`attractScale`, `clusterAttract`,
`repelScale`, `noisySensitiveRepel`, …). It is stored sparse (CSR) because real
boards couple each component to only a handful of others.

```
component pins ─┐
shared nets    ─┼─▶  signed coupling K  (CSR: row_ptr, col_idx, kvals)
rules          ─┘        K_ij > 0  synchronize → place near
                         K_ij < 0  anti-phase  → keep apart

archetype  ┐
hotspots   ┼─▶  conditioning block  ─▶  per-node drive[b,i]  (steers, no edges)
feedback   ┘
```

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
3. **Promotes** the mutation only if it passes the gate:
   - the **canonical score improves** (same yardstick the optimizer targets), **and**
   - the **EMI field check does not regress** (independent validator, §6), when
     EMI validation is enabled (`--emi` / `emiValidate`).

A mutation that lowers score but regresses field risk is rejected. This is what
makes the ratchet a ratchet: the substrate only moves in directions that improve
the canonical objective without making the field worse.

> **Transfer is verified separately, not inside the gate.** The promotion gate
> above runs on the *current* board only. Generality is demonstrated by the
> transfer step in `npm run demo` (and `--rules`): a substrate evolved on one
> board is carried to a brand-new board as a warm start and measured there. In
> practice the evolved substrate is a ~24% better optimizer on the new board.

> **Symbolic rule promotion** (hotspot-derived `push_away` / `cluster_tight` /
> `anchor_edge` rules) uses the same *score* gate but is **not** EMI-gated in the
> current implementation — only substrate mutations are checked against EMI
> non-regression.

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
field safety. The EMI pass is a **field-risk check used as a promotion gate** —
it is a relative, model-based estimate, **not an EMC-compliance claim** and not a
substitute for certified testing.

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
                │  │             PROMOTION GATE:  score improves            │
                │  └──── promote ◀── AND field risk no-regress (if --emi)   │
                │         if pass                                          │
                └────────────────────────────────────────────────────────┘
   transfer is verified separately: carry the evolved substrate to a new board.
```

`PROPOSE` (oscillators) and `VALIDATE` (damped-wave field pass) are the two
halves; the gate sits between them and only ratchets the substrate forward when
score and field risk agree. Cross-board generality is then demonstrated by the
transfer step (warm-starting a new board with the evolved substrate).
