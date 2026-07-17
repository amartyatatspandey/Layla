# ===----------------------------------------------------------------------=== #
# layla_kernels
#
# Mojo GPU kernels that accelerate the layla coupled-oscillator PCB
# placement optimizer. This package is an OPTIONAL backend: the project's
# working reference implementation is the TypeScript module
# `src/core/osc.ts`, and layla runs fully without Mojo installed.
#
# The kernels here mirror the reference dynamics 1:1 so that large boards and
# large random-seed batches can be integrated on a GPU. They are intended to be
# registered as MAX custom ops and invoked from the existing pipeline.
#
# Modules:
#   kuramoto_place  - batched, sparse (CSR) Kuramoto integration:
#                       * kuramoto_place_gpu    (one thread per batch/oscillator)
#                       * kuramoto_place_launch (host time loop + double buffer)
#                       * kuramoto_place_cpu    (parity fallback)
#                       * decode_coord          (optional fused readout)
# ===----------------------------------------------------------------------=== #

# ILLUSTRATIVE API: re-export the public entry points so callers can write
#   from layla_kernels import kuramoto_place_launch, kuramoto_place_cpu
from .kuramoto_place import (
    kuramoto_place_gpu,
    kuramoto_place_launch,
    kuramoto_place_cpu,
    decode_coord,
    step_oscillator,
)
