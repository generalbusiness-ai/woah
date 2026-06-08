# CF-local authority fast path

Date: 2026-06-08
Branch: `cf-local-authority-fast`
Base: `main` at `c98f947`

## Result

The branch targets the two actionable CF-local smoke costs from
`notes/2026-06-08-cf-local-smoke-metrics.md`:

1. sparse-planning repair rounds on deterministic movement/tool-leave turns;
2. repeated authority-slice fetches caused by those repair rounds.

The useful change is owner-authority prefetch for movement destinations that can
be proven from local declarative state before the VM runs. Direction verbs use
`exits[verb].dest`. Mounted tool return verbs use the existing mounted-space
state contract (`mount_room`, then actor `home`). Dynamic movement remains
guarded by the VM movement-boundary check and `missing_state_repair`.

Raw ignored artifacts:

- `.woo/cf-local-authority-fast-baseline.metrics.json`
- `.woo/cf-local-authority-fast-baseline-with-metrics.log`
- `.woo/cf-local-authority-fast-after.metrics.json`
- `.woo/cf-local-authority-fast-after.log`
- `.woo/cf-local-authority-fast-after-seedfold.metrics.json`
- `.woo/cf-local-authority-fast-after-seedfold.log`

## Measurements

All runs used `WOO_CF_LOCAL_METRICS_OUT=... npm run smoke:cf-local`.

| Metric | Baseline | After prefetch | After seed-fold | Change vs baseline |
|---|---:|---:|---:|---:|
| Smoke result | 4/4 pass | 4/4 pass | 4/4 pass | stable |
| `turn_repair_attempt` | 14 | 0 | 0 | eliminated |
| Max attempts | 3 | 1 | 1 | eliminated retries |
| Multi-attempt turns | 12 | 0 | 0 | eliminated retries |
| Summed turn wall | 25,818 ms | 24,434 ms | 22,964 ms | -2,854 ms |
| Max turn wall | 2,323 ms | 2,192 ms | 1,919 ms | -404 ms |
| Turn authority ms | 10,406 ms | 6,098 ms | 5,874 ms | -4,532 ms |
| Turn authority calls | 46 | 32 | 32 | -14 |
| Authority-slice RPCs | 58 | 40 | 38 | -20 |
| Authority-slice RPC wall | 5,023 ms | 3,385 ms | 3,336 ms | -1,687 ms |
| Authority reconstructions | 116 | 96 | 90 | -26 |

The first prefetch cut removed all retries but added a visible sequential
`planning.owner_prefetch_authority` cost. Folding the owner-prefetch ids into
the initial cold planning seed reduced that overhead:

- `planning.owner_prefetch_authority`: 2,988 ms -> 1,809 ms.
- total ensure-client wall: 9,273 ms -> 8,267 ms.
- max turn wall: 2,192 ms -> 1,919 ms.

## Remaining Cost

The slowest local turns are now single-attempt movement turns. Their remaining
cost is mostly initial planning open + seed authority, not retry repair:

- `the_deck:west`: 1,919 ms and 1,871 ms.
- `the_chatroom:southeast`: 1,518 ms and 1,488 ms.
- `the_garden:south`: 978 ms and 898 ms.

This branch achieves the requested 1/2 work: deterministic sparse-planning
repairs are gone in the prod-shaped local smoke, and repeated authority-slice
fetches are reduced rather than shifted into a hidden failure path. Further
work should target the remaining cold planning seed/open cost.
