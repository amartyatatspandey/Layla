# layla — Mojo GPU kernels

This directory holds the **optional GPU acceleration path** for layla's
coupled-oscillator placement optimizer.

> **Read this first.** The working reference implementation is the TypeScript
> module [`src/core/osc.ts`](../src/core/osc.ts), with the promotable substrate
> contract in [`src/core/oscTypes.ts`](../src/core/oscTypes.ts). layla
> runs **fully without Mojo** — placement, routing, scoring, the EMI field
> check, and the RSI loop all execute in TypeScript today. Mojo is an *optional*
> GPU backend that accelerates one hot inner loop (the Kuramoto integration)
> and is expected to produce the **same layouts** as the TS path for the same
> seeds. If Mojo / the Modular toolchain is not installed, nothing here is used.

## What the kernel does

[`layla_kernels/kuramoto_place.mojo`](layla_kernels/kuramoto_place.mojo)
integrates a **batched, sparse Kuramoto system**. For every random initial-phase
seed `b` in a batch and every phase oscillator `i`:

```
force = omega[i] + drive[b,i]
      + Σ_{j ∈ neighbors(i)}  K_ij · sin(theta[b,j] − theta[b,i])

first-order  (inertia == 0):  theta += dt · force
second-order (inertia  > 0):  v = (1 − damping·dt)·v + dt·force·inertia
                              theta += dt · v

theta ← wrap to [−π, π]      # every step
```

After `steps` iterations the phases are returned. The caller decodes board
coordinates with the substrate readout (identical to `osc.ts`):

```
coord = boardSize · sigmoid(a · sin(theta) + b · cos(theta))
```

Each component owns several oscillators (`θx`, `θy`, `θrot`); decoding `θx`/`θy`
gives its placement and `θrot` its orientation. The batch is the **seed race**:
every seed decodes to a candidate layout, each layout is routed + scored, and
the best is kept. Putting the whole batch on the GPU is the point — hundreds of
seeds advance in parallel, one thread per `(seed, oscillator)`.

The file provides three forms that share one `step_oscillator` so they cannot
drift apart:

- `kuramoto_place_gpu` — the device kernel (one thread per `(batch, oscillator)`).
- `kuramoto_place_launch` — the host time loop; double-buffers phases and puts a
  grid-wide barrier between steps so neighbors are read from a consistent
  previous snapshot (Jacobi semantics, matching `osc.ts`).
- `kuramoto_place_cpu` — a plain CPU fallback for GPU-less machines and for
  parity tests against the TypeScript reference.

## Why coupled oscillators fit placement

The netlist *is* a coupling graph, so synchronization *is* clustering:

| Netlist fact                                   | Coupling `K_ij` | Phase outcome      | Spatial meaning        |
|------------------------------------------------|-----------------|--------------------|------------------------|
| Components share a net                         | `> 0` (attract) | phases synchronize | place **near**         |
| Intra-cluster (buck, USB, …)                   | `> 0` (stronger)| tight sync         | compact cluster        |
| Noisy net ↔ sensitive net                      | `< 0` (repel)   | anti-phase         | keep **apart**         |
| Global spacing                                 | `< 0` (weak)    | spread             | no collapse / overlap  |

The **conditioning block** (board archetype + thermal hotspots + human
feedback) enters as the per-seed `drive[b,i]` term — an external bias that
steers the main oscillator population toward an intent (antenna to edge, buck
tight, noisy away, decaps near, USB balanced) without hand-placing anything.
This is the same role the class-conditioning block plays in Un‑0 (see the
architecture doc), repurposed from image synthesis to an optimizer substrate.

## Data layout (CSR)

Netlist adjacency is sparse, so coupling is a signed **CSR** matrix:

```
row_ptr : [n_osc + 1]  Int32     prefix offsets into col_idx / kvals
col_idx : [n_edges]    Int32     neighbor oscillator index j
kvals   : [n_edges]    Float32   signed coupling K_ij  (>0 attract, <0 repel)
```

Batched phase/drive tensors are row-major `[batch, n_osc]`. Each batch row is
one seed. `omega` is `[n_osc]`; the scalars `dt, steps, inertia, damping` come
straight from the `OscSubstrate`.

## Building / running with Modular MAX (high level)

This is the *intended* wiring; exact API signatures are marked
`ILLUSTRATIVE API` in the source and are not pinned to a specific Modular
release.

1. Install the toolchain (e.g. via `magic` / the Modular CLI) and add the MAX +
   GPU packages to the environment.
2. Register `kuramoto_place` as a **MAX custom op** (`@compiler.register(...)`)
   and build a small MAX graph whose inputs are the substrate tensors
   (`theta0, omega, row_ptr, col_idx, kvals, drive`) plus the scalar params; the
   graph calls the op and returns `theta_out`.
3. Serve / load that graph (`max` tooling) and call it from the existing
   pipeline. `src/core/osc.ts` hands over the exact substrate it would have
   integrated on CPU, then decodes the returned phases with the identical
   readout. **Parity is the contract.**

To check parity without a GPU, run `kuramoto_place_cpu` against the same seeds
and substrate as the TypeScript reference and compare decoded coordinates.

## Honest status

- Mojo is **not installed** in this checkout, so these files are *documented
  intent*, not a built artifact. They are written for readable, correct
  dynamics; the Modular-specific decorators and tensor handles are sketched and
  commented rather than compiled.
- The project does **not** depend on any of this. Removing the `mojo/` directory
  changes nothing about how layla runs today.
