# Layla — Implementation Master Plan

Status: living document. Milestone 1 (bug fixes) and Milestone 2 items 1–2 are
CLOSED and summarized here for context only — do not re-derive or re-litigate
them. Milestone 4 (RL engine) is explicitly OUT OF SCOPE for this document.

This doc exists so implementation can proceed with less human-reviewed
round-tripping than Milestones 1–2 item 2 required, while keeping the same
standard: architecture is decided before code is written, and no silent
fallback or undocumented behavior change ships.

---

## Part 1 — Locked principles (apply to every item below)

1. **Dead-weight axiom.** No field, parameter, or mechanism ships without a
   named downstream consumer. If something is computed and never read, that
   is a bug, not a stylistic issue (see: `ruleset.weights` removal).
2. **Hard-fail over silent fallback.** When the system hits data or a case it
   cannot resolve correctly, it fails loud (explicit error + report artifact)
   rather than guessing or silently substituting a plausible-looking default.
   This applies to new code paths by default — silent fallback requires an
   explicit, separately-justified exception.
3. **No branching on provenance.** Evaluation, scoring, and promotion gates
   must not know or care which mechanism produced a candidate. A candidate is
   judged by what it is, not where it came from. (See: unified promotion
   gate, `CandidateLayout` as `{ layout }` only.)
4. **Deterministic optimizer = explicit human-guided constraints. Learned
   optimizers = learned representations.** This is an architectural split,
   not a temporary gap. Symbolic rules (`push_away`/`cluster_tight`/
   `anchor_edge`) apply under `anneal` only. Oscillator (and any future
   learned backend) carries information forward via its own learned state
   (substrate; later, model weights), never via symbolic rule injection.
5. **Append-only tracking docs.** `LAYLA_AUDIT.md` and `technical_debt.md`
   are never edited or overwritten for past entries — only appended to,
   dated. This is how the project avoids the exact doc/code drift that the
   router-obstacle-handling check caught (README had silently gone stale
   relative to code once already).
6. **Trust code over docs.** When a doc's claim about current behavior can be
   checked against source, check it before relying on it. Six previously
   confirmed instances of documented-but-absent behavior exist in this
   project's history (see audit); assume docs can drift, verify before
   building on a claim.
7. **Architecture before code.** Any change with more than one technically
   valid approach and different long-term implications is a decision to make
   explicitly, not an implementation detail to resolve inline. See Part 3 for
   what counts.
8. **One canonical objective.** `scoreLayout` against `DEFAULT_WEIGHTS` is the
   single source of truth for "better." Every optimizer, every candidate,
   every board is graded on it identically. Nothing bypasses it, weights it
   differently per-optimizer, or adds a parallel scoring path.

---

## Part 2 — Decision log (Milestones 1 and 2, items 1–2 — CLOSED)

Reference only. Do not reopen without a new, explicit reason.

### Milestone 1 (bugs) — closed
- Unmapped footprint packages: **hard-fail**, not soft fallback. Routes to a
  rejection report (human review surface), not a partial/silent build.
- Footprint TABLE resolution modes:
  - LQFP / TSSOP / SSOP: **parametric by pin count (N)**, IPC-7351-nominal
    generator, assumption disclosed in the report on success; genuinely
    ambiguous competing pitches → hard-fail (`ambiguous_pitch`), never guess.
  - HTSSOP / LGA: **fixed-entry only**, no generator (exposed-pad / land
    pattern geometry not derivable from N). Deferred generator complexity is
    logged in `technical_debt.md` with an explicit trigger (a second real
    instance of that package family) — this is the one deliberate exception
    to "no debt forward," and it is documented as such, not silent.
  - `ensurePadCoverage`'s silent pad-invention: **removed entirely**. New
    first-class failure reason `pad_count_mismatch` added alongside
    `unresolved_package` / `ambiguous_pitch`. A template that can't cover its
    claimed pad count is a template bug, never auto-patched.
  - Wiring: typed throw (`UnresolvedFootprintError`) at the design-compile
    choke point (`designFromSchematic`) is the **only** path. Report artifact
    (`<name>.footprint-report.json`) is always written — `status: "ok"` +
    explicit `assumptions: []` (never omitted) on success, `status:
    "rejected"` with entries on failure, including a fallback
    `internal_error` shape for any *other* thrown error, so "always written"
    is actually unconditional.
- `ruleset.weights`: removed entirely (dead under both optimizers).
- Rule/substrate scope: **architectural decision**, framed as deterministic
  (rules) vs. learned (substrate) optimization, not a gap. `learn` forces
  `optimizer: anneal`. Oscillator + `--feedback` emits an explicit
  `FEEDBACK_SCOPE_NOTICE` (CLI + report), never a silent no-op.
- Router obstacle handling: confirmed already correct (hard block via
  `netOwner`, `route.ts:220-222`) — audit text was stale, not the code or
  README. Resolution logged, no fix needed.

### Milestone 2, item 1 (optimizer-agnostic evaluation pipeline) — closed
- Backend contract is **episodic**: a backend receives Design + Ruleset (+
  its own internal state) and returns one complete `CandidateLayout`. No
  step-wise/mid-layout reward path exists or is planned in the shared
  contract — any step-wise reward shaping a future backend wants is internal
  to that backend, never exposed to the shared evaluation layer.
- `OptimizerBackend` interface introduced; `anneal` and `oscillatorPlace`
  both implement it. `CandidateLayout` is `{ layout }` only — no
  backend-identity or provenance field, by design.
- Promotion gates **unified and reversed a prior exemption on purpose**: EMI
  non-regression (`--emi`) now applies to every candidate type identically,
  including rule-derived candidates (previously exempt "by design," which
  was actually an artifact of two separate code paths, not a real electrical
  judgment). Gates are an ordered, named list (`canonical_score` always
  active; `emi_non_regression` conditionally active) specifically so a
  future gate (real in-loop DRC — item 3 below) can be added to the list
  without touching dispatch or backend code.

### Milestone 2, item 2 (transfer-learning regression) — CLOSED
Confirmed 2026-07-18 via `npm run check-transfer-race` (seed 42 → COLD 624.1
over WARM 837.3; same-board no-race; legacy provenance notice; content-hash
detection). Historical narrative below is retained for context.
- Original ~7% regression claim (pre-fix) was **itself an artifact of a
  Prompt-5-introduced regression**: `improve()`'s promotion loop built every
  candidate from the same pre-update `Ruleset` snapshot, then applied
  accepted candidates via whole-object assignment in sequence — a
  later-accepted rule candidate's stale snapshot silently overwrote an
  earlier-accepted substrate mutation within the same iteration. The
  "transferred" substrate in the original demo was measurably deep-equal to
  default the whole time.
- Fix: **scoped patch-based promotion**. Each candidate type owns a specific
  subset of `Ruleset` fields (rule candidates → `rules[]`; substrate
  mutation → `substrate`) via explicit patch functions
  (`applyRulePatch`/`applySubstratePatch`/`applyPromotionPatch`), never a
  whole-object replace. No generic deep-merge utility — ownership is
  explicit and enumerable. This is structurally order-independent and
  generalizes to future candidate types without new special-casing.
- With the bug fixed, corrected H1 data (10 seeds) showed **no clear
  systematic regression** — mean delta +2.69%, stddev 11.57% (noise
  dominates signal), 6/10 worse vs 4/10 better, and excluding one outlier
  seed (42, +34.15%) the remaining 9 average **-0.80%** (slightly favorable
  to warm). Conclusion: the crown-jewel "cross-board learning" idea was
  never actually falsified by real evidence — it was falsified by a bug.
- Seed-42 mechanism (investigated per explicit request, reproducible, not a
  one-off bifurcation): single-pass WARM is actually **better** than COLD
  (910 vs 984) — the transferred substrate isn't electrically worse. The
  34% gap is **8-iteration search-path dependence**: COLD's mutation
  trajectory got lucky and found a much better basin (v5, score 624) at
  iteration 4; WARM's trajectory, biased by two transferred parameters
  (`readout.ax` 1.7→1.95, `condition.noisyAway` 1.0→0.96, non-additive
  interaction), stayed near its transferred starting region (v3, score 837)
  and never found that basin. Final degradation showed in `drc` (+140) and
  `ratsnest` (+96) terms specifically.
- Fix direction locked: **race cold-start vs. warm-start as two independent
  candidate lineages** on detected cross-board transfer, keep whichever the
  ratchet converges to as canonically better — same principle as the
  existing multi-seed phase race, applied one level up to substrate
  initialization. This makes transfer strictly non-harmful by construction,
  without requiring the mechanism to be understood for every possible
  parameter/topology interaction.
  - Provenance: `Ruleset` gains a content-hash of the source schematic +
    human-readable board label, populated on every new write.
  - Detection: hash match → continuation, no race. Hash mismatch → transfer,
    race triggers **automatically, no flag required**. Provenance absent
    (legacy `.rules.json`) → explicit notice, treated as continuation (never
    guessed), recommends re-running `learn` to populate provenance.
  - Mechanism: two complete, independent `improve()` passes, same budget/
    seed policy, no interleaving or partial merge of the two runs' state —
    compare final canonical `Score.total` only, keep the winner's full state
    wholesale.
  - Cost: doubling iteration compute on a detected race is an accepted,
    deliberate default (not opt-in) — a race only fires on genuine
    cross-board transfer, not on every run.
  - Reporting: both scores, winner, delta — surfaced same as `bench`'s
    existing head-to-head table.

**Closed:** Prompt 11 gate suite (`check-transfer-race`) passed; item 2 is
closed. No further confirmation required before Items 3–6.

---

## Part 3 — Remaining roadmap (Milestone 2 items 3–6, then Milestone 3)

Execute in this order. Do not reorder without flagging why (Part 4 rubric).

### Item 3 — Real in-loop DRC
Current state: proxy DRC (courtyard overlap + off-board only) is part of the
canonical score today; real copper-clearance DRC is checked once, post-hoc,
at board emission — not part of what the optimizer's search actually
minimizes against.
Goal: legality (real clearance) becomes part of the optimization objective,
not just a final gate.
Known open questions (do not resolve silently — see Part 4):
- Performance cost of real clearance checks inside a hot loop that races
  many phase seeds per iteration — this may require a cheaper approximate
  in-loop check plus the existing post-hoc exact check, rather than the
  exact check running every candidate every iteration. Which approximation
  (if any) is acceptable is a locked-decision question, not an
  implementation detail.
- How real in-loop DRC becomes a named gate in the Part-2 gate-list
  mechanism (it should — that mechanism was built for exactly this).
- Whether promoting a candidate that improves canonical score but regresses
  real in-loop DRC should be blocked the same way EMI regression blocks
  promotion today (recommend: yes, for consistency — confirm before
  building).

### Item 4 — Router completeness / congestion handling
Current state: critical-nets-first grid A* router; most nets on large boards
(e.g. `mainboard`, ~200 components) are left as unrouted ratsnest at default
iteration budget. Obstacle-handling correctness (hard block on foreign-net
copper) is already confirmed correct — this item is about coverage and
congestion, not correctness.
Known open questions:
- What "complete" means as a target — 100% of nets routed at default budget,
  or a documented, board-size-dependent expectation with the ratsnest
  penalty in scoring doing its job as designed for the remainder?
- Congestion handling strategy (rip-up-and-reroute, net ordering heuristics,
  multi-pass) — multiple valid approaches, needs an explicit choice before
  implementation, not a default picked mid-prompt.

### Item 5 — Oscillator scalability (hierarchical/sparse coupling)
Current state: flat, effectively all-pairs coupling. Motivated by the same
`mainboard`-scale evidence as item 4 — this is likely the deeper cause of
routing/placement quality degrading at ~200 components, not solely a router
issue.
Known open questions:
- Decomposition boundary: subsystem detection could come from existing
  netlist/cluster structure already in the schematic, or require new
  classification work. Which is in scope here matters for how large this
  item actually is.
- Whether hierarchy changes the `OptimizerBackend` contract (Part 2) at all
  — recommend it should not (a hierarchical oscillator backend still
  produces one `CandidateLayout` episodically), but confirm before building,
  since this interface was just locked and any change to it needs the same
  scrutiny it originally got.

### Item 6 — EMI validator scope definition
Current state: already honestly documented as non-EMC-fidelity, zero
validation data anywhere, unconverged on the hardest board. This is a
refinement of documentation and confidence claims, not an attempt at full
electromagnetic simulation — that boundary itself was already decided
earlier in this project and is not being revisited here.
Known open questions:
- What concrete confidence statement the validator should be able to make
  (e.g., "flags relative near-field coupling risk between two placements
  for ranking purposes, not absolute field strength") — needs to be written
  down explicitly, likely in README/docs, so its role in the EMI
  non-regression gate (Part 2) is honestly scoped.

### Milestone 3 — merge into one cohesive system
Not yet scoped in detail. At minimum, by the end of this milestone:
- Every optimizer backend (anneal, oscillator, and whatever items 3–5
  produce) operates against the same evaluation contract from Part 2, with
  items 3–4's new gates folded into the same named gate-list mechanism.
- `LAYLA_AUDIT.md` and `technical_debt.md` reflect current, accurate state
  — a final pass to confirm no doc/code drift has crept back in across
  items 3–6, same posture as the router-obstacle-handling check.
- A single coherent architecture doc (README + `docs/oscillator-architecture.md`)
  describes the merged system without any of the "unified gate" language
  that was previously found to be inaccurate — verify this specifically,
  since that inaccuracy already happened once.

Milestone 4 (RL engine) is intentionally not scoped here — separate document
when this phase closes.

---

## Part 4 — Decision-escalation rubric

Autonomous execution is authorized for: mechanical implementation of an
already-locked decision, writing gate tests, following the patterns in Part
1–2 to a new case that clearly matches an existing precedent, and producing
findings for a read-only investigation.

**STOP and produce a written question (2–4 concrete options + a
recommendation) instead of resolving autonomously, whenever a plan or
implementation step matches any of the following categories, and no
explicit decision already exists in Part 2 covering it:**

1. **Fallback/failure-mode behavior for previously-unhandled data or cases.**
   (e.g., what happens when something doesn't match an expected shape —
   default answer under Part 1 principle 2 is hard-fail, but confirm rather
   than assume for each new case.)
2. **Scope-now vs. defer-with-documented-debt.** Any call about what's
   "good enough" for this pass vs. genuinely needs solving now.
3. **Reversing or materially changing previously-locked behavior** —
   including anything in Part 2. If new evidence suggests a Part 2 decision
   was wrong, that's a real finding, but it stops for explicit re-confirmation
   rather than being silently overridden.
4. **Compute/performance cost trade-offs**, especially anything affecting a
   hot loop (in-loop DRC is the obvious upcoming case) or default resource
   cost of a feature (racing already set a precedent — new cost trade-offs
   still need their own confirmation, precedent is not blanket permission).
5. **Backward-compatibility handling for pre-existing data/files** (e.g.,
   legacy artifacts predating a schema or behavior change).
6. **Any design fork with more than one technically valid approach and
   different long-term implications** — even if one option looks obviously
   better, if a reasonable engineer could disagree, it stops.
7. **Any change to documented, public-facing claims** about system behavior
   (README, `docs/oscillator-architecture.md`) — content is fine to draft,
   but the underlying behavioral claim being documented needs to already be
   locked, not decided via doc-writing.
8. **Anything touching the canonical scoring objective** — `scoreLayout`,
   `DEFAULT_WEIGHTS`, or the composition/weighting of score terms. This
   affects every optimizer and every board simultaneously; treat as
   maximally sensitive.

When none of the above apply, proceed and document what was done in the
same style as prior prompts in this project (structure, gate tests, exit
criteria) — a plan or PR description should make it easy to verify against
Part 1's principles without re-explaining them.

**Suggested first step under this doc:** produce a PLAN ONLY (no
implementation) for items 3–6 and Milestone 3, explicitly flagging every
point where the plan hits one of the eight categories above rather than
resolving it inline. That plan gets one human review pass; execution then
proceeds against the locked plan, stopping only when Part 4 is triggered by
something not already resolved in that review.