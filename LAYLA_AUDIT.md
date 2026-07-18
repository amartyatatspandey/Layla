# layla — capability audit

Read-only investigation. No source files modified. Repo root:
`/Users/trickyoutlaw/Documents/Coding/PROJECTS/DRDO/layla`
(`main`, working tree clean, built with `npm install && npm run build`, node v26.4.0).

Method: read README.md, docs/oscillator-architecture.md, src/cli.ts, all of
src/core/**, mojo/layla_kernels/**, then ran `layla synth`
against all 5 bundled example boards (the repo ships 5, not the "3" the
README's gallery table claims and not the 4 assumed by this audit's
brief — see finding C.0) and inspected the emitted `.kicad_pcb` /
`.report.json` output directly, plus small Node scripts against the built
`dist/core` module to cross-check the scorer's internal state against the
raw schematic.

---

## A. Promotion gate / ratchet

**What's implemented.** The ratchet optimizes a single scalar,
`Score.total`, a weighted sum of 13 terms computed in
[`src/core/score.ts:38-268`](src/core/score.ts) against a **fixed** canonical
weight table `DEFAULT_WEIGHTS` ([`score.ts:12-26`](src/core/score.ts#L12-L26)):
`ratsnest, crossings, courtyard, offboard, decap, switchLoop, noisySensitive,
usbPair, antenna, highCurrent, thermal, returnPath, drc` (the last a proxy,
see B). There is no `cost` term (README doesn't claim one either — consistent).

Every candidate (fresh phase seed, mutated substrate, or synthesized rule) is
re-scored against this same fixed table — [`src/core/synth.ts:85`](src/core/synth.ts#L85)
and [`synth.ts:101`](src/core/synth.ts#L101) both call
`scoreLayout(design, layout, DEFAULT_WEIGHTS)` explicitly, never
`ruleset.weights`. A mutation/rule is promoted only if
`test.score.total < best.score.total` ([`synth.ts:164`](src/core/synth.ts#L164),
[`synth.ts:182`](src/core/synth.ts#L182)), so `best.score.total` is
monotonically non-increasing across iterations — the ratchet claim is real
and verified empirically (see per-board tables below: `bestScore` never
increases across the 8-iteration `iter` column).

**Does a "better" candidate get checked against anything the score doesn't
measure?** Only partially, and only when `--emi` is passed:

- With `--emi`: a substrate mutation is promoted only if it *also* passes
  `emiRisk(emiCand) <= emiRisk(best.emi) * 1.08 + 1e-6`
  ([`synth.ts:168`](src/core/synth.ts#L168)) — an independent field-risk
  non-regression check (see D).
- **Symbolic rule promotion (`push_away`/`cluster_tight`/`anchor_edge`/
  `weight`, from `synthesizeFromHotspots`, `synth.ts:177-187`) is never
  EMI-gated**, `--emi` or not — confirmed in code (no `emiRisk` call on that
  path) and explicitly stated in
  [`docs/oscillator-architecture.md:130-133`](docs/oscillator-architecture.md#L130-L133).
- Without `--emi` (the flag defaults off — `optimizerFlags`,
  [`cli.ts:121-124`](src/cli.ts#L121-L124)), **nothing** cross-checks a
  promoted candidate against anything outside `Score.total`. Since `total` is
  one weighted sum, a candidate can legitimately lower `total` while making a
  sub-term worse. This is directly observable in the empirical run below:
  `robot_soc` iteration 0→3 lowers `bestScore` 5237.51→4722.92 while
  `drcErrors` **rises** 6→12 (courtyard/off-board proxy violations roughly
  double) — the promotion gate accepted a layout with measurably worse DRC
  because other terms (thermal/coupling) improved enough to win on the sum.
  Nothing flags this trade-off to the caller; it's visible only by reading
  the per-iteration table.

**Severity: PARTIAL.** The gate does exactly what it claims for the score it
tracks (true ratchet, verified monotonic). But "doesn't silently break
something the score doesn't measure" is only true for substrate mutations
under `--emi`; rule promotion is never checked, `--emi` is opt-in, and even
under `--emi` a promoted candidate can regress an individual proxy term
(DRC, courtyard) as long as the weighted sum improves.

---

## B. Correctness

**LVS-equivalent connectivity check: not implemented.** There is no pass
anywhere in the pipeline that re-derives connectivity from the emitted
`.kicad_pcb` copper/pads and diffs it against the input schematic netlist.
`writeBoard` ([`src/core/board.ts:52-216`](src/core/board.ts)) emits pads and
net codes straight from the `Design` IR that was built once from the
schematic ([`src/core/classify.ts:68-98`](src/core/classify.ts#L68-L98)) —
it trusts that IR unconditionally; nothing downstream verifies it.

This blind trust is not academic — it hides a real, empirically-confirmed
connectivity bug (traced during this audit, not previously documented):
**footprint pad synthesis silently drops pins whose schematic pin number
exceeds the synthesized footprint's pad count.**
`padWorld` ([`src/core/layoututil.ts:14-20`](src/core/layoututil.ts#L14-L20))
looks up a pad by exact string match on `pad.num` against the *procedurally
generated* footprint (`src/core/footprints.ts`); if no pad with that number
exists, it returns `null` and the caller (`netPads`,
[`layoututil.ts:45-52`](src/core/layoututil.ts#L45-L52)) silently omits that
pin from the net. `canonicalKey`
([`src/core/footprints.ts:188-219`](src/core/footprints.ts#L188-L219)) has no
match arm for `LQFP`, `HTSSOP`, `TSSOP`, `SSOP`, or `LGA` package strings, and
its terminal fallback (`footprints.ts:218`) is the *2-pad* `C_0603` chip
footprint — the same shape used for a resistor. A 48-pin MCU or an 8-pad
sensor package that isn't one of the ~15 hand-mapped strings in `TABLE`
silently becomes a 2-pad footprint with pads numbered `"1"`/`"2"` only.

Measured impact (script: instantiate `Design` for each example, compare
`fp.pads` numbers against `component.pins` numbers):

| Board | components affected | pin-connections silently dropped |
|---|---|---|
| buck_imu | 0 | 0 |
| motor_driver | 2 (U1 `LQFP-48` STM32G0, U2 `HTSSOP-28` DRV8313) | 14 |
| rf_sensor | 1 (U3 `LGA-8` BME280) | 2 |
| robot_soc | 3 (U5 SOT-23, J5 screw terminal, U11 `LGA-8` BMP390) | 6 |
| mainboard | 11 (2× QFN-56, QFN-32 PHY, 4× LGA-8 sensors, …) | 85 |

For `motor_driver` this is not cosmetic: U1's real pins 3, 4, 8, 9 (`PWM_A`,
`PWM_B`, `USB_DP`, `USB_DM`) and U2's real pins 6, 7 (`MOTOR_B`, `GATE`)
never get a world pad position. `netPads()` for those nets returns 0-1 point,
which is below the `>= 2` threshold every scoring/routing/EMI path requires
(`score.ts:51`, `route.ts` candidate filter at `route.ts:341`, `emi.ts`
source/probe cell builders) — so these 6 nets are **not counted as demand,
not scored, not routed, not flagged as ratsnest, not simulated for EMI, and
the emitted `.kicad_pcb` footprint for U1/U2 has no pad numbered 3/4/6/7/8/9
at all**, i.e. the board file itself is missing physical connections that
exist in the schematic. Yet `layla synth` reports `route completion
100%` and `drc errors 0` for this board (see empirical table below) — a
materially misleading result caused directly by the missing correctness
check.

**DRC against real fab rules: not implemented, proxy only.** `drcErrors` in
`scoreLayout` ([`score.ts:233`](src/core/score.ts#L233)) is
`courtyardOverlaps + offboard` — component-footprint bounding-box overlap and
board-outline overflow. There is no clearance check between copper of
different nets, no annular-ring check, and no trace-width-vs-current-capacity
check against any real fab/IPC rule set. Worse: the A* router's obstacle
model is a **soft cost**, not a hard constraint —
[`route.ts:16`](src/core/route.ts#L16) `OBSTACLE_PENALTY = 8` is added to the
A* cost when crossing a cell already used by a prior net
([`route.ts:197`](src/core/route.ts#L197)), but the path is never blocked, so
two different nets' traces can legally occupy/cross the same 0.5 mm grid
cell (an electrical short) if that's cheaper than routing around, and no
downstream check catches it — `drcErrors` never inspects trace geometry, only
component courtyards.

**Severity: BLOCKING.** No LVS-equivalent verification exists, and the
footprint-fallback bug it would have caught is real, silent, and present in
4 of 5 bundled boards. The DRC proxy is honestly a proxy, but the router's
obstacle model doesn't even enforce its own internal heuristic as a hard
rule, and neither trace clearance nor fab-rule DRC exists at all.

---

## C. Completeness

**On an unroutable net: silent, no signal to caller — and there are two
independent failure modes, not one.**

1. *Router gives up.* `routeCritical` ([`src/core/route.ts:311-389`](src/core/route.ts#L311-L389))
   caps at `MAX_NETS = 14` nets by priority (`route.ts:19`,
   `route.ts:339-344`) and per-net A* at `MAX_EXPANSIONS = 20000`
   (`route.ts:18`). If A* returns `null`, the code does
   `if (!path) continue; // leave as ratsnest` (`route.ts:385`) — no log, no
   exception, no hotspot. The net silently falls back to being penalized only
   via the `ratsnest` score term. This is the "documented" partial-failure
   mode and is at least visible in `routeCompletion`.
2. *Net never reaches the router at all* (undocumented, found during this
   audit): as detailed in B, a net whose pads can't be resolved via
   `padWorld` drops below the `pads.length >= 2` threshold in `netPads` and
   is excluded from `demandNets` in `scoreLayout` (`score.ts:48-58`) *before*
   `routeCritical` even sees it. This is worse than "left as ratsnest" — it
   contributes **nothing** to the score, doesn't lower `routeCompletion`, and
   produces no hotspot. A repo-wide `grep` for `console.warn`/`throw` across
   `src/core/*.ts` turns up exactly two throws (both for malformed input
   files, in `sexpr.ts`/`schematic.ts`) and zero warnings — there is no
   warning-emission infrastructure in the pipeline at all for either failure
   mode.

**Empirical unrouted-net count** (built the project, ran
`layla synth <board> --iterations 8` on all 5 bundled examples,
default oscillator optimizer + `--emi` for the two most complex boards; net
counts cross-checked with a script against `dist/core`'s `netPads` /
`design.nets`, not just the printed `routeCompletion` %, because that % is
computed over `visibleDemand`, which — per finding B — can already exclude
nets the footprint bug hid):

| Board | raw demand (schematic truth, ≥2 pins, non-ground) | visible demand (what the scorer sees) | routed | unrouted-but-visible | **invisible (dropped by footprint bug)** | reported routeCompletion | final score |
|---|---:|---:|---:|---:|---:|---:|---:|
| buck_imu | 11 | 11 | 11 | 0 | 0 | 100% | 385.0 |
| motor_driver | 11 | 5 | 5 | 0 | **6** | 100% | 414.0 |
| rf_sensor | 8 | 8 | 8 | 0 | 0 | 100% | 131.4 |
| robot_soc | 54 | 54 | 13 | **41** | 0 | 24% | 4722.9 |
| mainboard | 141 | 139 | 10 | **129** | 2 | 7% | 19613.7 |

`motor_driver` reports a clean "100% routed, 0 DRC errors" while 6 real
schematic nets are physically absent from the emitted board. `robot_soc` and
`mainboard` are honest about being mostly unrouted (24% / 7%) — the
`MAX_NETS = 14` router cap plus a router that only routes "critical" nets by
priority means anything past the top ~14 nets by priority is always left as
ratsnest by design on any board with more than ~14 demand nets, which is
disclosed in the README ("routes the top handful... deliberately leaves the
rest as ratsnest") but is a hard cap, not a scaling parameter exposed via any
flag.

**C.0 — example-count discrepancy.** This audit's brief says "4 bundled
examples"; the README's prose says "Three mixed-signal boards are bundled"
([`README.md:315`](README.md#L315)) and only documents `buck_imu`,
`motor_driver`, `rf_sensor` in its example table. `examples/index.json`
actually lists **5**: `mainboard`, `robot_soc`, `buck_imu`, `motor_driver`,
`rf_sensor`. `mainboard` and `robot_soc` are also absent from `cmdDemo`'s
per-board loop scope in intent (it iterates `index.json` so it does include
them) but are never mentioned in README prose, and they are the two boards
where the tool's actual routing coverage (7%, 24%) is worst — i.e. the two
un-discussed boards are exactly the ones that make the "critical-nets-first"
limitation most visible.

**Severity: BLOCKING** for the invisible-net failure mode (undocumented,
silent, corrupts the emitted board file with no signal); **FINE** for the
documented "leave as ratsnest" behavior (real limitation, honestly disclosed
in README, at least visible in the score).

---

## D. `--emi` flag

**What it computes.** A **progressive 2.5-D damped scalar-wave finite-difference
solver** on a 3-z-layer voxel grid (`cols × rows × 3`), refined through
`[4, 2, 1] mm` cell sizes — `validateEmiProgressive`,
[`src/core/emi.ts:310-400`](src/core/emi.ts#L310-L400). Per-cell leapfrog
update at [`emi.ts:211-266`](src/core/emi.ts#L211-L266):
`u_next = (2 − damping − ω²)u − (1 − damping)u_prev + c²·∇²u + drive`, with
sinusoidal drive injected at noisy/high-current net copper cells and energy
accumulated at sensitive-net probe cells. This is **not** a full-wave
Maxwell/openEMS-style field solve (no permittivity/permeability tensors, no
S-parameters, no real trace impedance) — it is a simplified, hand-tuned
analytical-heuristic model with empirically chosen constants (`C2 = 0.18`,
`DAMP_SIGNAL = 0.04`, `VIA_LEAK = 0.25`, etc., [`emi.ts:26-40`](src/core/emi.ts#L26-L40))
whose blended `risk` metric is `normProbe·1.0 + peak·0.4 + normGrad·0.6`
([`emi.ts:288-289`](src/core/emi.ts#L288-L289)) — no physical units, not
calibrated to volts/amps/dB.

**Validation against a real solver: none exists in this repo.** Grepped the
whole tree for `openEMS`, comparison/validation data files, benchmark CSVs —
the only hit is the README's own caveat text
([`README.md:417`](README.md#L417)) saying openEMS would be the real
comparison point. There is no recorded correlation, no benchmark dataset, no
regression test comparing this solver's `risk` output to any independent
field solver or measurement. The repo's own docs are honest about this:
"not certified EMC... not a substitute for a real field solver"
([`README.md:184-189`](README.md#L184-L189)) — the code matches that
disclaimer, it just means there is currently zero evidence, inside or
outside the repo, of how far this proxy is from reality.

**Gate behavior confirmed empirically.** Ran `rf_sensor` and `robot_soc` with
`--emi`:
- `rf_sensor --emi`: 8 iterations, 6s wall time, converged
  (`convergenceDeltaPct` 8.1% < the 12% threshold in
  [`emi.ts:371`](src/core/emi.ts#L371)), substrate reached v3, no errors.
- `robot_soc --emi`: 8 iterations, 52s wall time, **not converged**
  (20.4% Δ across refinement — the field-risk metric is still moving between
  the 2mm and 1mm passes, meaning the "hottest victim net" call itself is not
  trustworthy at this board's complexity), substrate only reached **v1**
  (vs. v3 without `--emi` on an earlier run) — i.e. the EMI gate visibly
  rejected substrate mutations here that the un-gated run accepted, which is
  the gate working as designed, but on an unconverged/unstable metric.

**Severity: PARTIAL.** Implementation matches its own documentation exactly
(honest naming: `progressive_damped_wave_2p5d`, explicit non-EMC disclaimer).
The gap is that there is no validation data anywhere confirming the proxy
tracks real near-field coupling, and on the more complex bundled board it
demonstrably fails its own convergence bar, meaning the EMI gate can reject
or accept mutations based on a signal the tool's own convergence check says
isn't stable yet.

---

## E. Robustness

Ran `synth --iterations 8` (default) on `rf_sensor` and `robot_soc`, the two
most topologically complex bundled boards (`robot_soc`: 72 components, 85
nets, 9 clusters — 3-phase BLDC + radio + 3-buck power tree; `mainboard` is
larger still at 187 components / 450 nets but wasn't singled out by the
brief).

| Board | completed | iterations | final score | substrate version reached | wall time (`--emi`) | errors/warnings |
|---|---|---|---|---|---|---|
| rf_sensor | yes | 8/8 | 131.4 (from 268.99, −51%) | v3 | 6s | none |
| robot_soc | yes | 8/8 | 4722.9 (from 5237.51, −10% under `--emi`; −10% w/o) | v1 (`--emi`) / v3 (no `--emi`) | 52s | none |

No exceptions, no NaN/Infinity leaks (the EMI solver explicitly guards this
with `clampU`, [`emi.ts:43-48`](src/core/emi.ts#L43-L48)), no crash on either
board. `robot_soc` ends at 12 DRC errors and 24% route completion — it
"completes" in the sense of not crashing, but the output is a mostly-unrouted
board with real courtyard collisions per the proxy metric (see B/C).

**Does the code path differ for RF/high-frequency nets vs generic digital
nets?** **No — routing and placement are topology-agnostic.** The only
RF-aware logic anywhere in the pipeline:
- `classify.ts:61`: net name matching `/(rf|ant)/` gets `NetClass`
  `["rf","sensitive"]` and `priority = 7` — same priority bucket as USB
  (`classify.ts:59`, also priority 7).
- `osc.ts:73` (`edgeFor`): components with `role === "antenna" || role ===
  "rf"` get driven toward the right board edge — a placement bias, not a
  routing behavior.
- `score.ts:169-195`: an `antenna` penalty term for keepout-radius violations
  and edge distance.

Nothing in `route.ts` distinguishes RF/high-frequency nets from any other
signal: same 0.5 mm grid, same 2-layer F.Cu/B.Cu A*, same `VIA_COST = 4`, no
controlled-impedance width calculation, no length-matching beyond the
`usbPair` diff-pair term in `score.ts` (which is USB-specific, keyed off
`design.board.diffPairs`, not general RF differential pairs), no ground-via
stitching near RF traces. RF nets are routed with the exact same
generic-net-priority A* as an I2C or SPI signal; the only differentiation is
in placement bias and a proximity/keepout scoring term, not in the router or
the trace model itself.

**Severity: FINE** for robustness (no crashes, bounded, deterministic,
graceful degradation on hard boards); **PARTIAL** for the RF-differentiation
question — the substrate/placement layer has real RF-aware bias, but routing
is generic and unaware of frequency-sensitive geometry (trace impedance,
via stitching, RF isolation), which the README's "It isn't a full autorouter"
disclaimer covers but doesn't fully convey.

---

## F. Learn / feedback

**What `learn --feedback` persists.** `cmdLearn`
([`src/cli.ts:249-260`](src/cli.ts#L249-L260)) runs `improve(design, {
iterations: 4, feedback, ruleset })`, then writes the resulting
`res.ruleset` (whole `Ruleset`: `rules[]`, `weights{}`, `version`, and — if
the run used the oscillator optimizer — the evolved `substrate`) to a JSON
file (default `rules.json`). `synthesizeFromFeedback`
([`src/core/rules.ts:89-135`](src/core/rules.ts#L89-L135)) pattern-matches
the feedback string against a small fixed set of regexes (hot-loop, away/
sensitive, USB, antenna/edge, decoupling) and emits candidate `Rule` objects
with `weightDeltas`; these only get promoted into the saved ruleset if they
lower `Score.total` inside the 4-iteration learn run
(`promoteRule`/`hasSimilarRule` gate, same canonical-score gate as A). This
part works and is genuinely gated.

**Does fed-back data change future runs measurably — this is the most
important finding of the audit, and the answer is: it depends entirely on
which optimizer is selected, and the *default* optimizer ignores it.**

- `ruleset.rules` (the actual symbolic output of `--feedback`, e.g.
  `push_away`/`cluster_tight`/`anchor_edge`) is read by
  `buildConstraints` in the **`anneal` baseline optimizer only**
  ([`src/core/place.ts:23-51`](src/core/place.ts#L23-L51),
  used by `seedPlacement`/`placementCost`/`anneal`). For the annealing path,
  learned rules genuinely change placement: edge anchors, push-away minimum
  distances, and cluster-tightness targets are all derived from
  `ruleset.rules` there.
- **The default and recommended optimizer is `oscillator`**
  (`optimizerFlags`, [`cli.ts:122`](src/cli.ts#L122): `flags.optimizer ===
  "anneal" ? "anneal" : "oscillator"`). Its graph compiler,
  `compileOscillatorGraph(design, ruleset, sub)`
  ([`src/core/osc.ts:79-163`](src/core/osc.ts#L79-L163)), takes `ruleset` as
  a parameter but **never reads it** — confirmed by grepping the file: the
  only two occurrences of the identifier `ruleset` in `osc.ts` are the
  function signature at line 79 and the call site at line 307. Every net
  edge, cluster edge, noisy/sensitive repulsion edge, decap attraction, and
  edge-anchor drive is derived purely from `design` and the substrate `sub`
  — never from `ruleset.rules`. So under the default optimizer, **learned
  symbolic rules (`push_away`, `cluster_tight`, `anchor_edge`) have zero
  effect on placement.** Only the evolved `ruleset.substrate` (mutated
  coupling gains, `condition.*` drive multipliers, integrator params)
  carries forward — and that's a different mechanism (substrate mutation,
  gated per iteration by score/EMI, §A) from the feedback-compiled rules.
- `ruleset.weights` (mutated by `applyWeightDeltas`,
  [`rules.ts:21-26`](src/core/rules.ts#L21-L26), and persisted in the same
  JSON) is **dead data** end-to-end: `scoreLayout` is always called with the
  literal `DEFAULT_WEIGHTS` constant, never `ruleset.weights`
  ([`synth.ts:85`](src/core/synth.ts#L85), [`synth.ts:101`](src/core/synth.ts#L101));
  `placementCost` in the annealing path does the same —
  `const w = DEFAULT_WEIGHTS;` with an explicit comment,
  [`place.ts:118`](src/core/place.ts#L118): *"Always optimize against the
  canonical objective... Learned rules influence the result through
  constraints... never by reweighting the objective."* So `weightDeltas` on
  every learned rule, and the entire `ruleset.weights` field written to every
  `*.rules.json`, has **no effect on any run, ever**, under either
  optimizer. It's computed, mutated, serialized, and then never read back.

**Net effect on the flagship "transfer" demo.** `cmdDemo`'s transfer stage
([`cli.ts:199-212`](src/cli.ts#L199-L212)) runs entirely under
`optimizer: "oscillator"`. Given the above, what actually transfers
board-to-board is the evolved `OscSubstrate` (coupling scales, drive gains,
integrator params) — a real, gated, measurable transfer mechanism — **not**
the symbolic rules the `--feedback` text nominally compiled into (those are
carried in the same `Ruleset` object but are inert on this code path). The
README's language ("carried: oscillator substrate v_N + K learned rules",
[`cli.ts:206`](src/cli.ts#L206)) is technically accurate about what's in the
object but creates the impression that the "K learned rules" are doing
something on the oscillator path; per the code, they are not.

**Severity: BLOCKING.** `ruleset.weights` is fully inert (dead code, never
read for scoring, under either optimizer). Symbolic `--feedback`-derived
rules are fully inert under the default and recommended `oscillator`
optimizer — only the substrate carries information forward there. This is
not documented anywhere in README.md or docs/oscillator-architecture.md;
both describe rule promotion and substrate evolution as running under one
unified gate without flagging that rules are optimizer-conditional in their
actual effect.

---

## Summary table

| # | Question | Verdict |
|---|---|---|
| A | Ratchet optimizes fixed canonical `Score.total`; monotonic, verified | PARTIAL — no cross-check outside `--emi`+substrate-mutation case; rule promotion never cross-checked |
| B | LVS-equivalent check | BLOCKING — none exists; masks a real silent pin-drop bug in 4/5 boards |
| B | Real fab-rule DRC | BLOCKING — proxy only (courtyard+offboard); router obstacle model is a soft cost, not enforced |
| C | Unroutable-net handling | BLOCKING (invisible-drop path) / FINE (documented ratsnest fallback) |
| D | `--emi` model fidelity | PARTIAL — honestly documented as non-EMC; zero validation data anywhere; unconverged on the hardest board |
| E | Robustness on complex boards | FINE — no crashes; RF-awareness limited to placement bias, routing is topology-agnostic |
| F | `learn --feedback` persistence/effect | BLOCKING — `ruleset.weights` fully dead code; symbolic rules inert under the default `oscillator` optimizer |

---

## Resolution log

Append-only. The findings above remain as written at audit time; closures are
recorded here without rewriting prior entries.

### 2026-07-18 — Finding A / #4: symbolic rule promotion never EMI-gated

**Original finding:** Under Finding A (Promotion gate / ratchet), symbolic rule
promotion (`push_away` / `cluster_tight` / `anchor_edge`, from
`synthesizeFromHotspots`) was never EMI-gated — `--emi` or not. Only
substrate-mutation candidates ran the
`emiRisk(cand) ≤ emiRisk(best) × 1.08` non-regression check; rule candidates
promoted on canonical score alone. (Documented at audit time as intentional;
see Finding A bullets under “Does a ‘better’ candidate get checked…”, and the
summary-table note that rule promotion was never cross-checked.)

**Resolution:** Promotion evaluation is now a single ordered gate list on
`CandidateLayout` (`src/core/optimizerBackend.ts`): `canonical_score` always;
`emi_non_regression` when `--emi` / `emiValidate` is set. Every promotion
candidate — rule-derived or substrate-derived — enters the same list via
`evaluatePromotionGates` in `improve()`; evaluation does not branch on
candidate provenance. Placement goes through `OptimizerBackend` →
`CandidateLayout` (anneal / oscillator adapters); learning channels remain
optimizer-specific, but the gate list does not.

**Note:** This was closed as part of the same refactor that introduced the
`OptimizerBackend` / `CandidateLayout` interface and unified synth dispatch —
not a standalone EMI-on-rules patch.

### 2026-07-18 — Milestone 2 / Item 2: transfer-learning regression + cold/warm race

**Original finding / follow-on:** Cross-board substrate transfer appeared to
regress (or, after clobber fixes, showed seed-dependent search-path harm).
H1 seed 42: COLD `improve(8)` reached substrate v5 @ ~624 while WARM stayed
near transferred v3 @ ~837 — warm-start could miss basins a cold start found.

**Resolution:** Cross-board transfer is detected via `Ruleset.provenance`
(schematic content hash + board label). Hash mismatch auto-triggers two
independent `improve()` lineages (COLD default substrate vs WARM transferred);
final `Score.total` decides; winner state kept wholesale. Same-board
continuation does not race. Legacy rulesets without provenance emit
`LEGACY_PROVENANCE_NOTICE` and continue without racing.

**Gate evidence:** `npm run check-transfer-race` PASS — same-board no race;
cross-board race reports both scores; seed 42 selects COLD (624.1) over WARM
(837.3); legacy notice; content-hash (not filename) detection.

### 2026-07-19 — Milestone 2 / Item 6: EMI relative-ranking scope

**Finding / open question:** EMI validator was honestly non-EMC but lacked one
canonical confidence statement shared across report surfaces; `converged` could
be misread as compliance; transfer docs still carried stale ~24% / open-~7%
narratives in places.

**Resolution:** Exported `EMI_SCOPE_CLAIM` from `core/emi.ts` and threaded it
through `EmiReport.scope`, CLI/`report.json`, Electron IPC payload, and EMI SVG
title/legend. Approved statement:

> Flags relative near-field coupling risk between two placements for ranking
> purposes only; risk is a unitless comparative near-field coupling-risk
> estimate, never absolute field strength (dB/V/m) or EMC compliance.

`emiRisk()` / `emi_non_regression` semantics unchanged (finest-level blended
scalar, 1.08× tolerance, uniform across rule/substrate candidates). `converged`
documented as refinement stability / ranking confidence — gate eligibility
intentionally unchanged when false (no debt entry; intentional limitation).
Transfer docs corrected to cold/warm race + `check-transfer-race` evidence
where gate support exists; stale ~24% architecture claim removed.

**Gate evidence:** `npm run build`, `npm run check-emi-scope`,
`npm run check-optimizer-backend` PASS.

### 2026-07-19 — Milestone 3 doc-drift inventory (Item 6 checkpoint)

Append-only inventory at Item 6 close (full Milestone 3 cohesion audit is Task 6).
Checked against source / gate evidence; corrections applied only where supported:

| Claim / surface | Status at Item 6 close |
| --- | --- |
| EMI absolute field / EMC compliance language | Corrected → `EMI_SCOPE_CLAIM` on all EMI surfaces |
| `emiRisk` as dB/V/m or compliance threshold | Documented as finest-level blended scalar only |
| `converged` as compliance | Documented as ranking confidence; gate unchanged |
| Rule candidates exempt from EMI gate | Still absent (uniform gate list); reconfirmed by `check-optimizer-backend` |
| Architecture "~24% better" transfer | Removed; replaced with cold/warm race + gate evidence |
| README "~7% worse / open question" transfer | Replaced with race-guarded non-harmful transfer narrative |
| Router soft-cross / obstacle cost | Already closed earlier; not reopened |
| `ruleset.weights` | Still absent; not reintroduced |
| `CandidateLayout` provenance fields | Still `{ layout }` only (Task 4 hierarchy does not add provenance) |
| In-loop exact DRC as score term | Broad feeds score; exact is promotion gate — docs match |
| Universal 100% routing on all boards | Tiered expectations already documented; unchanged here |
| Milestone 3 full matrix / artifact consistency | Deferred to Task 6 |

### 2026-07-18 — Milestone 2 / Item 6: EMI relative-ranking scope

**Original finding:** EMI validator honestly non-EMC but lacked a single
canonical claim threaded through all report surfaces; confidence language
around `converged` was easy to over-read as compliance.

**Resolution:** `EMI_SCOPE_CLAIM` exported from `emi.ts` and carried on every
`EmiReport.scope`, CLI/`report.json`, Electron IPC, and EMI SVG title/legend.
Approved statement: relative near-field coupling-risk ranking only — unitless
comparative estimate, never absolute field strength or EMC compliance.
`emi_non_regression` unchanged (finest-level blended scalar; uniform across
candidates). `converged` = ranking confidence only; gate eligibility unchanged
when false.

**Gate evidence:** `npm run check-emi-scope` PASS.

### 2026-07-18 — Milestone 3 doc-drift inventory (pre-integration)

Surfaces checked against Items 3–6 implementation (append-only; corrections
land in Task 6 cohesion commit if needed):

| Claim area | Status |
|---|---|
| Two-tier DRC (broad in score, exact promotion gate) | Documented in README + architecture |
| Tiered routing (small 100%, medium ≥98% reason-tagged, stress ≥5%) | Documented; placement locality in technical_debt |
| Oscillator hierarchy + topologyMode / legacy flat notice | Documented via Task 4 |
| EMI relative-ranking scope | Closed above |
| Transfer race / unified gates / CandidateLayout provenance-free | Closed earlier; re-verify in Milestone 3 integration gate |
