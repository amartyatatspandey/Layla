# transfer-regression-h1

**Supersedes** the Prompt-7 phantom-substrate run (all deltas zero because
evolved === default). This run uses the post–owned-field-patch evolve artifact.

Fixed buck_imu-evolved substrate (cmdDemo transfer artifact); motor_driver oscillator, no EMI, 8 iterations.

Seeds: `7, 11, 23, 42, 101, 256, 512, 777, 1337, 2026`
Frozen substrate version: `v2`
Frozen ≠ defaultSubstrate: `true`

## cmdDemo reference pair (seed 7, 2 iters)

| cold | warm |
| --- | --- |
| 892.7 | 903.9 |

## Seed sweep (8 iters)

| seed | cold_score | warm_score | delta (warm − cold) | delta_pct |
| --- | ---: | ---: | ---: | ---: |
| 7 | 788.066 | 717.279 | -70.788 | -8.982 |
| 11 | 879.328 | 786.577 | -92.752 | -10.548 |
| 23 | 769.605 | 767.785 | -1.820 | -0.237 |
| 42 | 624.148 | 837.319 | 213.171 | 34.154 |
| 101 | 811.389 | 832.210 | 20.821 | 2.566 |
| 256 | 794.187 | 830.631 | 36.444 | 4.589 |
| 512 | 866.542 | 869.734 | 3.192 | 0.368 |
| 777 | 800.469 | 822.339 | 21.870 | 2.732 |
| 1337 | 680.476 | 669.201 | -11.275 | -1.657 |
| 2026 | 656.286 | 682.096 | 25.811 | 3.933 |

## Summary

- mean_delta_pct: 2.691821
- stddev_delta_pct: 11.573628
- warm_worse_count: 6
- warm_better_count: 4
