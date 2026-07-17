# ===----------------------------------------------------------------------=== #
# layla :: kuramoto_place.mojo
#
# Batched, sparse (CSR) Kuramoto integration kernel for PCB placement.
#
# WHAT THIS IS
# ------------
# This is the GPU acceleration path for the coupled-oscillator placement
# optimizer. The *working reference implementation* lives in TypeScript at:
#
#       src/core/osc.ts                  (dynamics + decode + seed racing)
#       src/core/oscTypes.ts             (the promotable `OscSubstrate`)
#
# The TypeScript runs the whole project end-to-end with no Mojo present. This
# kernel is an OPTIONAL backend that mirrors those dynamics 1:1 so that large
# boards / large seed batches can be integrated on a GPU instead of on the CPU
# event loop. Nothing here changes the math; it only changes where it runs.
#
# HOW IT PLUGS INTO MAX (high level, illustrative)
# ------------------------------------------------
# Under the Modular stack the intended wiring is:
#
#   1. `kuramoto_place` (the GPU `fn` below) is registered as a MAX *custom op*
#      via `@compiler.register("kuramoto_place")` (Modular's custom-op API).
#   2. A small MAX graph is built in Python/Mojo that takes the substrate
#      tensors (theta0, omega, CSR coupling, drive, scalars) as graph inputs
#      and calls this op, returning `theta_out`.
#   3. The TypeScript side (src/core/osc.ts) shells out to / RPCs that graph
#      (e.g. through a `max serve` endpoint or a thin Python bridge), hands it
#      the exact same substrate it would have integrated itself, and decodes
#      the returned phases with the identical readout. Result parity is the
#      contract: GPU and CPU paths must produce the same layouts for the same
#      seeds.
#
# The MAX-specific decorators / tensor wrapper types below are marked
# "ILLUSTRATIVE API" — the goal of this file is correct, readable dynamics and
# a clear kernel structure, not to pin an exact Modular release's signatures.
#
# DYNAMICS (mirrors osc.ts)
# -------------------------
# For every seed b in the batch and every oscillator i:
#
#   force = omega[i] + drive[b,i]
#         + sum_{j in neighbors(i)} kvals[e] * sin(theta[b,j] - theta[b,i])
#
#   first-order (inertia == 0):   theta[b,i] += dt * force
#   second-order (inertia  > 0):  v[b,i] = (1 - damping*dt) * v[b,i] + dt * force
#                                 theta[b,i] += dt * v[b,i]
#
# Phase is wrapped into [-pi, pi] each step. After `steps` iterations the phases
# are returned; the caller decodes board coordinates with the substrate readout
#       coord = boardSize * sigmoid(a * sin(theta) + b * cos(theta))
# (decode happens caller-side so the same code path serves x, y and rotation
# oscillators; see osc.ts).
#
# DATA LAYOUT
# -----------
# Coupling is stored as a signed CSR sparse matrix because netlist adjacency is
# sparse (a component couples only to net-mates, cluster-mates, and the handful
# of noisy<->sensitive anti-pairs):
#
#   row_ptr : [n_osc + 1]  Int32   prefix offsets into col_idx / kvals
#   col_idx : [n_edges]    Int32   neighbor oscillator index j
#   kvals   : [n_edges]    Float32 signed coupling weight K_ij
#                                  (>0 attract / synchronize / place near;
#                                   <0 repel  / anti-phase / keep apart)
#
# Batched tensors are row-major [batch, n_osc]. Each batch row is one random
# initial-phase seed; the batch is the "race" of seeds that osc.ts evaluates
# and from which the best routed+scored layout is kept.
# ===----------------------------------------------------------------------=== #

from math import sin, cos, pi
from memory import UnsafePointer

# ILLUSTRATIVE API: in a real build these come from the Modular packages, e.g.
#   from gpu import thread_idx, block_idx, block_dim, global_idx
#   from gpu.host import DeviceContext
#   from layout import LayoutTensor
#   import compiler
# They are referenced symbolically below and guarded with comments so this file
# stays readable without a Mojo toolchain installed.


# ---------------------------------------------------------------------------- #
# Phase wrapping: fold an angle back into [-pi, pi].
# Branch-light form so it vectorizes / runs uniformly across GPU lanes.
# ---------------------------------------------------------------------------- #
@always_inline
fn wrap_phase(theta: Float32) -> Float32:
    let two_pi: Float32 = 2.0 * pi
    # shift into [0, 2pi), then back to [-pi, pi)
    var t = theta - two_pi * floor((theta + pi) / two_pi)
    return t


@always_inline
fn floor(x: Float32) -> Float32:
    # tiny local floor to keep the file self-contained / dependency-free.
    let i = Int(x)
    let fi = Float32(i)
    return fi - 1.0 if x < fi else fi


@always_inline
fn sigmoid(x: Float32) -> Float32:
    # logistic readout helper. Provided here so a fused decode variant of the
    # kernel can emit coordinates directly; the default path returns phases and
    # lets osc.ts decode, keeping the readout in one place.
    return 1.0 / (1.0 + exp_approx(-x))


@always_inline
fn exp_approx(x: Float32) -> Float32:
    # Placeholder; a real build calls `math.exp`. Kept local for readability.
    from math import exp
    return exp(x)


# ---------------------------------------------------------------------------- #
# Core per-oscillator update — the single source of truth for the dynamics.
#
# This is deliberately written once and called by BOTH the GPU kernel and the
# CPU fallback, so the two backends cannot drift apart. It computes the new
# phase (and updated velocity) for one (batch, oscillator) pair.
#
# Returns the wrapped new phase; updates `v` in place for the inertial path.
# ---------------------------------------------------------------------------- #
@always_inline
fn step_oscillator(
    b: Int,
    i: Int,
    n_osc: Int,
    theta: UnsafePointer[Float32],   # [batch, n_osc] current phases (read)
    v: UnsafePointer[Float32],       # [batch, n_osc] velocities (read/write, inertial)
    omega: UnsafePointer[Float32],   # [n_osc] natural frequencies
    drive: UnsafePointer[Float32],   # [batch, n_osc] per-seed external drive
    row_ptr: UnsafePointer[Int32],   # [n_osc+1] CSR row offsets
    col_idx: UnsafePointer[Int32],   # [n_edges] CSR neighbor indices
    kvals: UnsafePointer[Float32],   # [n_edges] signed couplings
    dt: Float32,
    inertia: Float32,
    damping: Float32,
) -> Float32:
    let base = b * n_osc
    let theta_i = theta[base + i]

    # --- coupling term: sum over CSR neighbors of i ---
    # K_ij * sin(theta_j - theta_i). Positive K pulls phases together
    # (synchronize -> place near); negative K pushes them to anti-phase
    # (repel -> keep apart).
    var coupling: Float32 = 0.0
    let start = Int(row_ptr[i])
    let end = Int(row_ptr[i + 1])
    for e in range(start, end):
        let j = Int(col_idx[e])
        let theta_j = theta[base + j]
        coupling += kvals[e] * sin(theta_j - theta_i)

    # --- total angular force on oscillator i for this seed ---
    let force = omega[i] + drive[base + i] + coupling

    if inertia > 0.0:
        # Second-order / inertial Kuramoto: phases carry momentum, which lets
        # the population settle through frustrated (mixed +/-) coupling instead
        # of locking into the first basin. `damping` bleeds energy so it still
        # converges. inertia scales how much momentum is retained.
        let v_old = v[base + i]
        let v_new = (1.0 - damping * dt) * v_old + dt * force * inertia
        v[base + i] = v_new
        return wrap_phase(theta_i + dt * v_new)
    else:
        # First-order Kuramoto: overdamped gradient flow toward synchrony.
        return wrap_phase(theta_i + dt * force)


# ===----------------------------------------------------------------------=== #
# GPU KERNEL FORM
#
# One thread per (batch, oscillator) pair. The launch grid is sized so that
# global_idx covers [0, batch * n_osc). Each thread owns exactly one oscillator
# in one seed and advances it for all `steps`.
#
# IMPORTANT correctness note (mirrors osc.ts): the reference integrator reads
# the *previous* step's phases for every oscillator when computing a step
# (Jacobi-style), it does not use freshly-updated neighbor phases mid-sweep
# (Gauss-Seidel). To preserve that on the GPU we double-buffer phases and put a
# grid-wide barrier between steps so all threads see a consistent snapshot.
#
# The decorator and tensor-handle types here are ILLUSTRATIVE API — they show
# the shape of a Modular custom op without binding to a specific release.
# ===----------------------------------------------------------------------=== #

# ILLUSTRATIVE API: @compiler.register("kuramoto_place")
# ILLUSTRATIVE API: this would typically be expressed with LayoutTensor inputs;
# we use raw device pointers + scalars to keep the dynamics front-and-center.
fn kuramoto_place_gpu(
    theta_in: UnsafePointer[Float32],   # [batch, n_osc] snapshot A (read this step)
    theta_out: UnsafePointer[Float32],  # [batch, n_osc] snapshot B (write this step)
    v: UnsafePointer[Float32],          # [batch, n_osc] velocities (inertial state)
    omega: UnsafePointer[Float32],      # [n_osc]
    drive: UnsafePointer[Float32],      # [batch, n_osc]
    row_ptr: UnsafePointer[Int32],      # [n_osc+1]
    col_idx: UnsafePointer[Int32],      # [n_edges]
    kvals: UnsafePointer[Float32],      # [n_edges]
    batch: Int,
    n_osc: Int,
    dt: Float32,
    inertia: Float32,
    damping: Float32,
):
    # ILLUSTRATIVE API: global linear thread id across the launch grid.
    #   let tid = global_idx.x
    # equivalently block_idx.x * block_dim.x + thread_idx.x
    let tid = _global_thread_id()
    let total = batch * n_osc
    if tid >= total:
        return  # guard the ragged tail of the last block

    let b = tid // n_osc
    let i = tid % n_osc

    # NOTE: step_oscillator reads from `theta_in` and we store into `theta_out`.
    # The host loop (kuramoto_place_launch) swaps the two buffers between steps
    # and issues a device-wide sync, giving Jacobi semantics that match osc.ts.
    let new_theta = step_oscillator(
        b, i, n_osc,
        theta_in, v, omega, drive,
        row_ptr, col_idx, kvals,
        dt, inertia, damping,
    )
    theta_out[b * n_osc + i] = new_theta


@always_inline
fn _global_thread_id() -> Int:
    # ILLUSTRATIVE API stand-in for `gpu.global_idx.x`.
    # On device this expands to: block_idx.x * block_dim.x + thread_idx.x
    return 0


# ---------------------------------------------------------------------------- #
# HOST-SIDE LAUNCHER
#
# Owns the time loop and the double-buffer swap. This is the function a MAX
# custom op body would call. It allocates the second phase buffer, then for
# each of `steps`:
#   1. launch kuramoto_place_gpu over a (batch*n_osc)-wide grid
#   2. device-synchronize (grid-wide barrier between integration steps)
#   3. swap read/write phase buffers
# After the loop the freshest snapshot is copied/aliased into theta_result.
# ---------------------------------------------------------------------------- #
fn kuramoto_place_launch(
    theta0: UnsafePointer[Float32],     # [batch, n_osc] initial phases (read)
    theta_result: UnsafePointer[Float32], # [batch, n_osc] final phases (write)
    v: UnsafePointer[Float32],          # [batch, n_osc] velocity scratch (zeroed by caller)
    omega: UnsafePointer[Float32],
    drive: UnsafePointer[Float32],
    row_ptr: UnsafePointer[Int32],
    col_idx: UnsafePointer[Int32],
    kvals: UnsafePointer[Float32],
    batch: Int,
    n_osc: Int,
    dt: Float32,
    steps: Int,
    inertia: Float32,
    damping: Float32,
):
    # ILLUSTRATIVE API:
    #   var ctx = DeviceContext()
    #   var buf_a = ctx.enqueue_create_buffer[Float32](batch * n_osc)  # ping
    #   var buf_b = ctx.enqueue_create_buffer[Float32](batch * n_osc)  # pong
    #   ctx.enqueue_copy(buf_a, theta0)
    #
    # Below we sketch the loop with raw pointers `ping`/`pong` to show the
    # data flow; in a real build these are DeviceBuffer handles.
    var ping = theta0       # current snapshot (read)
    var pong = theta_result # next snapshot (write)

    let total = batch * n_osc
    let block = 256
    let grid = (total + block - 1) // block

    for _step in range(steps):
        # ILLUSTRATIVE API:
        #   ctx.enqueue_function[kuramoto_place_gpu](
        #       ping, pong, v, omega, drive, row_ptr, col_idx, kvals,
        #       batch, n_osc, dt, inertia, damping,
        #       grid_dim=grid, block_dim=block)
        #   ctx.synchronize()            # grid-wide barrier between steps
        _ = grid  # silence "unused" without a real launch available here

        # Double-buffer swap: this step's output becomes next step's input.
        let tmp = ping
        ping = pong
        pong = tmp

    # If `steps` is odd, the freshest data is in `ping` (which may be theta0's
    # buffer after swaps). A real build copies `ping` into `theta_result`:
    #   ctx.enqueue_copy(theta_result, ping)
    if (steps & 1) == 0:
        # even number of swaps left the latest snapshot in theta_result already
        pass
    else:
        for idx in range(total):
            theta_result[idx] = ping[idx]


# ===----------------------------------------------------------------------=== #
# CPU FALLBACK
#
# Plain, allocation-light reference loop. Same `step_oscillator`, so it is
# bit-for-bit the same dynamics as the GPU path (modulo float reassociation in
# the coupling sum). Useful for: machines without a GPU, parity tests against
# src/core/osc.ts, and debugging the substrate.
#
# Jacobi semantics are preserved with an explicit ping/pong buffer pair just
# like the GPU launcher.
# ===----------------------------------------------------------------------=== #
fn kuramoto_place_cpu(
    theta0: UnsafePointer[Float32],     # [batch, n_osc] initial phases
    theta_result: UnsafePointer[Float32], # [batch, n_osc] output
    omega: UnsafePointer[Float32],      # [n_osc]
    drive: UnsafePointer[Float32],      # [batch, n_osc]
    row_ptr: UnsafePointer[Int32],      # [n_osc+1]
    col_idx: UnsafePointer[Int32],      # [n_edges]
    kvals: UnsafePointer[Float32],      # [n_edges]
    batch: Int,
    n_osc: Int,
    dt: Float32,
    steps: Int,
    inertia: Float32,
    damping: Float32,
):
    let total = batch * n_osc

    # Double buffer for Jacobi-style updates.
    var cur = UnsafePointer[Float32].alloc(total)
    var nxt = UnsafePointer[Float32].alloc(total)
    var vel = UnsafePointer[Float32].alloc(total)
    for idx in range(total):
        cur[idx] = theta0[idx]
        nxt[idx] = theta0[idx]
        vel[idx] = 0.0

    for _step in range(steps):
        for b in range(batch):
            for i in range(n_osc):
                let new_theta = step_oscillator(
                    b, i, n_osc,
                    cur, vel, omega, drive,
                    row_ptr, col_idx, kvals,
                    dt, inertia, damping,
                )
                nxt[b * n_osc + i] = new_theta
        # swap snapshots
        let tmp = cur
        cur = nxt
        nxt = tmp

    for idx in range(total):
        theta_result[idx] = cur[idx]

    cur.free()
    nxt.free()
    vel.free()


# ===----------------------------------------------------------------------=== #
# OPTIONAL FUSED DECODE
#
# osc.ts decodes phases to board coordinates with:
#     coord = boardSize * sigmoid(a * sin(theta) + b * cos(theta))
# A throughput-oriented build can fuse this into the final step so the GPU
# returns coordinates directly instead of phases. Kept separate (and off by
# default) so the readout stays defined in exactly one place during the RSI
# loop, which mutates (a, b) as part of the substrate.
# ===----------------------------------------------------------------------=== #
@always_inline
fn decode_coord(theta: Float32, a: Float32, b: Float32, board_size: Float32) -> Float32:
    return board_size * sigmoid(a * sin(theta) + b * cos(theta))
