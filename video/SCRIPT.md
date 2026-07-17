# layla — 90s presentation · voiceover script

**Runtime:** 90.0s · 1920×1080 · 30fps · `video/out/layla.mp4`
**Style:** monochrome / brutalist (grayscale + a single amber accent), terse, static.
The only motion is the EMI voxel-field fluctuation and the real app screen capture.

**Subtitles are burned in as TWO stacked lines per block, timed to the beats below**,
each block held long enough to read. The video reads fully without audio; to add a
voiceover, record against these timecodes — the lines line up 1:1.

Every board, field, graph, and benchmark is **real**, produced by running the actual
layla engine and the live Electron app. No stock, no AI imagery, no mockups.

---

## Beat sheet (timecode · narration — line A / line B)

### 0:00–0:08 — HOOK
*Visual: hard cuts of the 187-part mainboard — ratsnest → routed copper → EMI voxel field — then title.*
> PCB layout is not a drawing problem.
> It is an iterative physical-design problem: place, route, violate, inspect, learn, repeat.

### 0:08–0:20 — THE LOOP, MADE EXECUTABLE
*Visual: static cybernetic loop diagram (SUBSTRATE Δ accented).*
> layla turns that loop into software. / It takes a KiCad schematic, builds a first-pass PCB, and routes the critical nets.
> It scores DRC-style geometry and field risk, / then feeds the failure modes back into the next iteration.

### 0:20–0:34 — LAYERED PHYSICAL EVIDENCE
*Visual: the mainboard, layers cut in (footprints → ratsnest → copper → courtyards → EMI → routed), ×3.6 fine-trace loupe.*
> The board is read as stacked physical layers — / footprints, ratsnest, copper, courtyards, silkscreen, routing constraints.
> Then thermal hotspots, / and a progressive EMI validation pass.

### 0:34–0:54 — THE INTELLECTUAL CORE (coupled oscillators)
*Visual: static 3-panel — 187-node netlist→couplings mesh · two phase wheels (real Kuramoto order) · decode to placement · formula.*
> The core optimizer is a coupled phase-oscillator substrate. / Shared nets become attractive couplings — they synchronize and place together.
> Noisy-to-sensitive pairs become repulsive couplings that push apart. / The synchronized phase field decodes into board placement.
> The RSI loop mutates the substrate itself — / and keeps only the changes that improve the canonical score.

### 0:54–1:07 — INDEPENDENT FIELD VALIDATION (multi-scale EMI → 10µm)
*Visual: damped-wave voxel field descending 4mm → 1mm (full board) → 250µm → 50µm → 10µm (zoomed into the hottest region), with a nested-scale indicator.*
> A damped-wave voxel pass checks the field response. / It refines from millimeters down to ten microns inside the hottest regions.
> It is not certified EMC — / it is a fast validator that catches whether the optimizer makes field risk worse.

### 1:07–1:22 — LIVE PROOF (app + CLI bench)
*Visual: real screen-recorded Electron app (autopilot run + tab tour), then the CLI bench bars.*
> In the app, each iteration explores new phase seeds, / promotes better substrate mutations, and keeps the best layout — the curve only ratchets down.
> In the CLI benchmark, the oscillator beats annealing on every board. / And the evolved substrate transfers to a new board — with zero new feedback.

### 1:22–1:30 — CLOSE
*Visual: routed mainboard + repo URL.*
> layla is a self-improving PCB layout compiler: schematic in, routed board out.
> Every iteration makes the physical-design substrate sharper.

---

## Real numbers shown
- **CLI bench (oscillator vs simulated annealing, lower = better):**
  mainboard 90531 → 19614 (**−78%**, v2) · robot_soc 11237 → 4723 (**−58%**) ·
  buck_imu 615 → 385 (**−37%**) · motor_driver 527 → 414 (**−21%**) · rf_sensor 433 → 131 (**−70%**).
- **mainboard hero:** 187 components · 450 nets · 1685 couplings · 132×100 mm
  (AM62 SoC + RP2040 + ICE40, dual LPDDR4, 6-rail power tree, 4× 3-phase BLDC, 8-chip sensor bus, 2 radios, Ethernet/CAN/RS485/USB).
- **EMI multi-scale:** real windowed damped-wave sims at 4mm / 1mm (full board) → 250µm / 50µm / 10µm (zoomed into the hotspot @ ~75,97 mm).
- **Transfer:** buck-evolved substrate ≈ 24% better optimizer on an unseen motor board, zero new feedback.

## How it was built (all repo-derived)
- `video/scripts/export-assets.cjs` runs the engine, dumps real geometry, phase data,
  multi-scale EMI field grids (incl. 10µm windowed sims), score history and monochrome layer SVGs.
- `src/core/emi.ts` gained a `window` option so the damped-wave solver can simulate a
  region of interest down to µm cells.
- `src/core/svg.ts` recolored to a monochrome PCB palette.
- Live app footage: an env-gated autopilot (`FR_AUTOPILOT`) drives the real Electron app
  on an isolated X display, captured with ffmpeg, then desaturated to match the theme.
- Subtitle blocks: `video/src/components/Subtitles.tsx` (two lines, seconds-based marks).

## Re-render
```bash
cd video && npm i && npx remotion render Main out/layla.mp4
```
