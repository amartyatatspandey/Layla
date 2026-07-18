# Seed 42 divergence findings (motor_driver COLD vs WARM)

Diagnosis only — no `src/` changes. Date: 2026-07-18.

Companion raw trajectories / ablations: [`seed42-divergence-data.json`](seed42-divergence-data.json).

---

## Setup

| Item | Value |
| --- | --- |
| Board | `motor_driver` |
| Seed | **42** |
| COLD start | `defaultSubstrate()` (v1) |
| WARM start | H1 frozen buck_imu-evolved substrate **v2** |
| H1 protocol | `improve(..., iterations=8, optimizer=oscillator)` — **this** produced 624.15 cold / 837.32 warm |
| Dynamics probe | Instrumented twin of `runOne` (same equations as `osc.ts`), identical RNG draws → identical initial phases |
| Single-pass probe | `materializeCandidate` with `batch=16`, `polish=120` (one explore, no RSI loop) |

### Substrate diffs at WARM start (v2 vs default) — only three knobs

| parameter | COLD | WARM v2 | notes |
| --- | ---: | ---: | --- |
| `readout.ax` | 1.7 | **1.9519** | +14.8% — global phase→x decode + drive `targetPhase` |
| `readout.ay` | 1.7 | 1.7017 | ~0 — negligible |
| `condition.noisyAway` | 1.0 | **0.9589** | −4.1% — scales every noisy↔sensitive edge `k` |

All other knobs (`attractScale`, `clusterAttract`, `noisySensitiveRepel`, `driveScale`, `dt`, `steps`, `inertia`, `damping`, other `condition.*`) are identical at transfer time.

---

## Important split: two different “divergences”

| Layer | What was compared | Seed-42 result |
| --- | --- | --- |
| **A. First placement dynamics** (same initial phases, v1 vs v2) | Instrumented `runOne` + single `materializeCandidate` | Trajectories separate from step 1; **WARM scores better** on a single materialize (910 vs 984) |
| **B. H1 `improve(8)` finals** (continued substrate mutation) | Full ratchet from each start | **WARM much worse** (837 vs 624) — matches H1 table |

The H1 34% regression is **not** “v2’s first layout is 34% worse with the same phases.” It is path dependence in the RSI loop after transfer. Both layers are reported below.

---

## 1. Where phase trajectories first diverge (layer A)

Initial phases: **bit-identical** for matched `RNG(seed + b·7919 + 1)` draws (verified `initSame` on all 16 batch members).

Graphs differ at compile time: `noisyAway` changes every `noisy_sensitive` coupling (and any merged edge that includes that term). Example: pure-scale effect on a −0.8 edge → warm k ≈ −0.767 (Δk ≈ +0.033). On motor_driver, **24** compiled edges differ in weight.

Forces therefore differ on the **first** inertial update even with identical phases.

| step | cold R(t) | warm R(t) | mean phase Δ | max phase Δ | worst ref |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 0.3758 | 0.3758 | 0 | 0 | — |
| 1 | 0.3832 | 0.3838 | 0.0023 | 0.0069 | U4 |
| 2 | 0.3945 | 0.3956 | 0.0047 | 0.0140 | U4 |
| 5 | 0.4432 | 0.4452 | 0.0125 | 0.0336 | U1 |
| 10 | 0.5011 | 0.5050 | 0.0281 | 0.0891 | U1 |
| 15 | … | … | … | … | U1 |
| **24** | … | … | **> 0.05** | … | (threshold crossing, focus batch b=7) |
| 90 | … | … | 0.1063 | … | final (focus member) |

**First meaningful divergence:** measurable at **step 1**; mean phase distance crosses 0.05 rad at **step 24** on the most-diverging batch member (b=7). Early argmax often **U4** / **U1** (high force-gap from Δk on noisy↔sensitive pairings involving those refs).

`readout.ax` does not change `K`; it changes decode and edge-anchor drive targets, so it also biases the flow from step 1 for driven nodes and remaps xy at readout.

---

## 2. Which parameter is responsible (layer A ablation)

Single `materializeCandidate` @ seed 42, transplanting knobs onto default:

| ablation | Score.total | Δ vs COLD |
| --- | ---: | ---: |
| COLD (default) | 984.314 | 0 |
| `readout.ax` only | 1004.386 | **+20.07** |
| `condition.noisyAway` only | 1002.598 | **+18.28** |
| `readout.ay` only | 984.620 | +0.31 |
| `noisyAway` + `readout.ax` | 909.784 | **−74.53** |
| full WARM v2 | 910.125 | **−74.19** |

**Specific causal claim:**

- Alone, either `readout.ax↑` or `noisyAway↓` **hurts** slightly on this single pass.
- **Together** they reproduce the full v2 effect and **help** (~−74) — strongly non-additive.
- The transferred pair is therefore a **joint** `(readout.ax, condition.noisyAway)` interaction on motor_driver’s noisy/sensitive netlist + decode, not “the substrate is different” in general, and not buckTight / cluster gains (those are unchanged).

`noisyAway` is the knob that directly retunes motor_driver’s noisy↔sensitive anti-phase edges (topology-visible). `readout.ax` is a global decode gain evolved on buck_imu with no board-specific guard.

---

## 3. Score terms — single materialize (layer A)

Warm − cold term deltas (single pass @ seed 42):

| term | Δ (warm − cold) |
| --- | ---: |
| **noisySensitive** | **+119.8** |
| ratsnest | −78.9 |
| highCurrent | −50.4 |
| crossings | −34 |
| decap | −16.9 |
| usbPair | −14.4 |

So the single-pass WARM win is **not** “everything uniformly better”: the **noisySensitive** term is much worse, but geometric terms (ratsnest / highCurrent / crossings) improve enough to win on `Score.total`. That matches a slightly weaker separation coupling (`noisyAway↓`) plus a remapped decode (`ax↑`) trading field-proxy coupling for packing/length.

`switchLoop` is 0 on both (motor_driver has no buck hot-loop cluster in the score sense used here).

---

## 4. What actually creates the H1 34% gap (layer B)

Reproduced `improve(seed=42, iterations=8)`:

| | final Score.total | final substrate |
| --- | ---: | --- |
| COLD | **624.148** | **v5** (heavily mutated from default) |
| WARM | **837.319** | **v3** (only `dt` tweaked from transferred v2) |

### Iteration histories

**COLD** (starts default v1):

| iter | bestScore | promoted |
| ---: | ---: | --- |
| 0 | 910.77 | substrate v2 |
| 1 | 892.67 | substrate v3 |
| 3 | 892.05 | substrate v4 |
| **4** | **624.15** | **substrate v5** ← cliff |
| 5–7 | 624.15 | — |

**WARM** (starts transferred v2):

| iter | bestScore | promoted |
| ---: | ---: | --- |
| 0 | 910.12 | — |
| 2 | 869.07 | substrate v3 |
| 7 | 837.32 | — (explore only) |

COLD’s search, from default, finds a motor_driver-native basin (v5) with **lower** `readout.ax` (1.54), lower damping, fewer steps, higher `usbBalance`, etc. WARM remains near the buck-tuned **high `readout.ax` ≈ 1.95** and never reaches that cliff.

### Final improve score terms (624 vs 837)

| term | cold | warm | Δ |
| --- | ---: | ---: | ---: |
| **drc** | 20 | 160 | **+140** |
| **ratsnest** | 51.5 | 147.7 | **+96.1** |
| courtyard | 2.4 | 31.5 | +29.1 |
| decap | 63.7 | 24.1 | −39.6 |
| highCurrent | 386.9 | 362.2 | −24.7 |
| usbPair | 43.3 | 52.8 | +9.5 |
| crossings | 24 | 32 | +8 |
| noisySensitive | 15.0 | 10.5 | −4.5 |
| switchLoop | 0 | 0 | 0 |

Interpretable failure of the H1 WARM endpoint: **much worse packing / DRC proxy and ratsnest** (overlaps + wirelength), not a blown switch-loop or a uniformly worse noisySensitive term. The transferred high-`ax` lineage never finds the compact layout COLD’s v5 reaches on this seed.

### Final substrate contrast (why “ax” still matters)

| knob | COLD final v5 | WARM final v3 |
| --- | ---: | ---: |
| `readout.ax` | **1.542** | **1.952** (unchanged from transfer) |
| `readout.ay` | 1.467 | 1.702 |
| `damping` | 0.658 | 0.85 |
| `steps` | 78 | 90 |
| `condition.noisyAway` | 1.0 | 0.959 |
| `condition.usbBalance` | 1.339 | 1.0 |

The H1 gap tracks **failure to escape the transferred `readout.ax≈1.95` attractor** under seed 42’s mutation RNG, while COLD independently discovers a lower-ax / retuned-integrator substrate that packs the board.

---

## 5. Reproducible failure mode vs idiosyncratic?

**Layer A (v2 vs default, one materialize):**  
Mechanism is **reproducible and parameter-specific**: the only transferred knobs that matter are `readout.ax` and `condition.noisyAway`, acting on motor_driver’s noisy↔sensitive edge set + global decode. Nearby seeds (40–44) also show WARM better on single-pass materialize; seed 142 flips sign (+10%). So the *direction* of the joint `(ax, noisyAway)` effect is mostly stable nearby; magnitude varies.

**Layer B (H1 improve 34% outlier):**  
**Seed-amplified path dependence**, not “v2 always 34% worse.” Same seed’s mutation sequence from default hits a large improvement (v5); from transferred v2 it does not. Predictable *ingredients*:

1. Transfer carries a **buck-tuned `readout.ax`** with no per-board recalibration.
2. RSI mutations are local; starting far in ax-space can miss basins reachable from default.
3. Severity at seed 42 is large because COLD’s cliff at iter 4 is unusually good (624) while WARM plateaus ~837.

**Classification:** reproducible **parameter/start-state interaction** (`readout.ax` transfer + local substrate search), with **idiosyncratic severity** at seed 42 due to an asymmetric search success (COLD finds v5; WARM does not). It would be expected to recur whenever transfer leaves `readout.ax` elevated and the warm-start mutation budget fails to walk it back — not only for this one phase draw’s first layout.

---

## Short answers (task checklist)

1. **Trajectories:** captured per step (R(t), phases); sample table above; full series in `seed42-divergence-data.json`.
2. **First diverge:** step 1 (forces); mean phase Δ > 0.05 at **step 24** (focus batch).
3. **Responsible params:** **`readout.ax`** (primary transferred decode gain) and **`condition.noisyAway`** (weakens motor_driver noisy↔sensitive edges); jointly non-additive.
4. **Score terms:** single-pass — noisySensitive worse, ratsnest/highCurrent better; **H1 finals** — degradation in **`drc` (+140)** and **`ratsnest` (+96)**, not switchLoop.
5. **Mode:** reproducible ax/noisyAway + warm-start search bias; seed 42’s 34% figure is an amplified search-path outcome, not a one-shot phase bifurcation alone.
