# Findings: substrate-transfer pathway (post–Prompt-5 / H1 follow-up)

Read-only diagnosis. No source changes. Date: 2026-07-18.

## Verdict (short)

1. **The OptimizerBackend adapter does receive and use the passed-in
   `ruleset.substrate`.** `materializeCandidate` does not substitute a default.
2. **`compileOscillatorGraph` still reads substrate knobs** (coupling scales,
   condition gains, etc.); integrator/`runOne` still reads `sub.dt`,
   `sub.steps`, `sub.inertia`, `sub.damping`, `sub.readout`.
3. **H1’s bit-identical COLD/WARM scores are explained by the transferred
   substrate being deep-equal to `defaultSubstrate()`**, not by a dead
   placement path. When a deliberately different substrate is forced through
   the same WARM path, scores diverge.
4. **That “evolved == default” outcome is a Prompt-5 regression** in
   `improve()`’s promotion loop: substrate promotion can be recorded and then
   **clobbered** by a later same-iteration rule promotion whose candidate
   ruleset was snapshotted *before* the substrate update. Pre–Prompt-5
   (committed `HEAD` / `fb9ffb5`) applied substrate then rules sequentially,
   so `promoteRule` carried the new substrate forward.

---

## 1. End-to-end substrate flow (cmdDemo / H1 WARM → placement)

```
cmdDemo / H1 WARM
  improve(motor, { ruleset: { rules: [], substrate: evolved, … }, optimizer: "oscillator", seed })
    → ruleset = cloneRuleset(opts.ruleset)          // synth.ts
    → if oscillator && !ruleset.substrate → defaultSubstrate()  // only if missing
    → createBackend("oscillator")
    → synthOnce(design, ruleset, …)
         → materializeCandidate(backend, placeRequest(… ruleset …))
              → backend.place(req)
                   createOscillatorBackend.place:
                     sub = req.ruleset.substrate     // ← used as-is; throw if absent
                     oscillatorPlace(design, req.ruleset, sub, { batch, seed })
                       → compileOscillatorGraph(design, ruleset, sub)
                       → runOne(…, sub, …) per batch seed
```

### Does the adapter silently substitute a default?

**No.** Relevant sites:

| Location | Behavior |
| --- | --- |
| `optimizerBackend.ts` `createOscillatorBackend().place` | `const sub = req.ruleset.substrate`; throws if missing; passes `sub` into `oscillatorPlace` |
| `materializeCandidate` | Calls `backend.place(req)` then scores; **does not** touch `ruleset.substrate` |
| `improve()` init | Assigns `defaultSubstrate()` **only when** `optimizer === "oscillator" && !ruleset.substrate` |

So if WARM passes a substrate object, that object is what `oscillatorPlace` receives.

### Empirical check (same seed, forced-different substrate)

Through the live post–Prompt-5 path (`improve` / `materializeCandidate`):

| Condition | Score.total (motor_driver, seed 7, 2 iters) |
| --- | ---: |
| COLD (default substrate) | 892.657 |
| WARM with forced non-default knobs (`attractScale=2.5`, `steps=150`, …) | 711.281 |

Scores **differ**. The placement path is substrate-sensitive when the objects differ.

`materializeCandidate(createBackend("oscillator"), …)` with two different
substrates at the same seed also differs (1128.358 vs 785.473 at batch 4 /
polish 20).

---

## 2. `compileOscillatorGraph` — does it read `sub`?

**Yes.** `ruleset` is still unused for graph edges (audit Finding F); **`sub` is used**.

From `osc.ts` `compileOscillatorGraph(design, ruleset, sub)`:

- `sub.attractScale` — net attraction weights  
- `sub.clusterAttract` (+ `sub.condition.buckTight` / `usbBalance`) — cluster edges  
- `sub.noisySensitiveRepel` (+ `sub.condition.noisyAway`) — repulsion edges  
- `sub.clusterAttract * cond.decapNear` — decap→IC edges  
- `sub.driveScale` (+ `cond.antennaEdge`) — conditioning drive strength  

`runOne` / integrator (same file) also uses `sub.readout`, `sub.dt`,
`sub.steps`, `sub.inertia`, `sub.damping`, `sub.driveScale`.

This is unchanged in role from the audit-era check (which targeted
`ruleset.rules`, not substrate).

---

## 3. Why H1 COLD ≡ WARM (and cmdDemo 892.7 / 892.7)

H1 froze the buck_imu “evolved” substrate after the cmdDemo-shaped evolve
step. That artifact was:

- `version: 1`
- **`JSON.stringify` deep-equal to `defaultSubstrate()`**

So WARM and COLD ran the **same** substrate parameters → bit-identical
`Score.total` on every seed is expected.

Yet the evolve run’s iteration history claimed a promotion:

```text
iter 0 promoted: [ 'substrate v2', 'noisy_away_from_sensitive' ]
…
final substrate version: 1
equals default: true
```

So a `substrate v2` promotion was **logged**, then **lost** from
`ruleset.substrate` before return / transfer.

### Root cause: Prompt-5 unified `promoCands` snapshot clobber

**Working tree** (`src/core/synth.ts` `improve` loop):

1. Build **all** promotion candidates up front from the **same** base `ruleset`:
   - substrate cand: clone + `mutateSubstrate` → v2  
   - rule cand: `promoteRule(ruleset, rule)` → still has **v1 / base** substrate  
2. Evaluate in order; on accept: `ruleset = pc.ruleset`.

If both pass the gate in one iteration:

1. Substrate cand accepted → `ruleset` has v2.  
2. Rule cand accepted → `ruleset` replaced by the **pre-built** rule ruleset
   that still carries the **old** substrate → **v2 discarded**.

History still pushes both labels (`substrate v2`, then the rule name).

**Committed pre–Prompt-5** (`git show HEAD:src/core/synth.ts`, commit
`fb9ffb5`):

1. (b) Mutate/gate substrate; on accept, `ruleset = trialRs` (v2).  
2. (c) `promoteRule(ruleset, cand)` on the **updated** ruleset → rule cand
   **retains** v2 substrate.

Snapshot proof (same `promoteRule` helper):

| Construction order | Rule-cand substrate version | attractScale |
| --- | ---: | ---: |
| Prompt-5 style: `promoteRule(base, rule)` before substrate apply | 1 | 1.0 |
| HEAD style: `promoteRule(afterSub, rule)` after substrate apply | 2 | 2.0 |

### Is this Prompt-5 or pre-existing?

| Question | Answer |
| --- | --- |
| Adapter / `materializeCandidate` drop substrate? | **No** — not the H1 failure mode |
| `compileOscillatorGraph` ignore substrate? | **No** |
| Clobber of promoted substrate by same-iter rule promo? | **Yes — introduced by Prompt-5’s up-front `promoCands` batch** (uncommitted `synth.ts` + `optimizerBackend.ts` vs `HEAD`) |
| Audit / README 702.3 ↔ 657.0 distinct transfer scores? | Consistent with an era when the transferred substrate **actually differed** from default (pre–this clobber). Those numbers are **not** reproducible on the current working tree’s cmdDemo path (now 892.7 / 892.7). |

Note: Prompt-5’s `OptimizerBackend` wiring itself is **not** what zeroes
transfer; the **promotion bookkeeping reorder** in `improve()` is.

---

## 4. What would need to change (descriptive only — no fix applied)

For a transferred / post-evolve substrate to remain what WARM uses:

- **Carry forward accepted ruleset state** when building or applying later
  candidates in the same iteration (restore HEAD’s sequential dependency:
  rule candidates must be based on the ruleset *after* any accepted
  substrate mutation), **or**
- When accepting a rule candidate, **preserve the current
  `ruleset.substrate`** (rules are anneal-only under oscillator anyway),
  **or**
- Stop promoting inert symbolic rules into the oscillator run’s returned
  ruleset if they can overwrite substrate state.

Separately (not required for H1 identity, but relevant to transfer demos):
ensure the evolve stage’s **returned** `ruleset.substrate` is the last
**accepted** mutation, then pass that object unchanged into motor_driver WARM
(cmdDemo already intends this; it fails today only because evolve returns
default-equivalent substrate after the clobber).

---

## Code anchors

- Adapter uses passed substrate: `src/core/optimizerBackend.ts`
  `createOscillatorBackend` (~lines 75–82)  
- No substitute in materialize: `materializeCandidate` (~135–147)  
- Clobber site: `src/core/synth.ts` `improve` promoCand build +
  `ruleset = pc.ruleset` loop  
- Pre–Prompt-5 sequential (b)/(c): `git show HEAD:src/core/synth.ts`  
- Substrate→graph: `src/core/osc.ts` `compileOscillatorGraph`, `runOne`,
  `oscillatorPlace`
