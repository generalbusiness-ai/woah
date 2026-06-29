# Functional Baseline Candidate

Date: 2026-06-29
Branch: `main`
Base commit: `7264d93` (`Repair anchored host seed snapshots`)
Status: local/workerd green candidate; deployed classification pending explicit approval

## Summary

Plan 001 has a local/workerd green candidate. The remaining full-baseline
classification is not technical evidence yet; it is the explicit approval
boundary for committing and deploying.

The candidate fixes two stale sparse-authority paths found by repeated workerd
measurement:

- Slim MCP authority carries the current session row plus the bounded
  session-actor object row, so warm CommitScopeDO snapshots can validate actors
  allocated or moved after the snapshot was taken.
- CommitScopeDO treats no-authority requests with `session_objects` as fresh
  gateway session authority for the caller, replacing stale `activeScope` rows
  instead of preserving scope-local stale placement.

The spec alignment is recorded in `spec/reference/cloudflare.md`: warm MCP slim
envelopes/head-session opens must carry the caller session row and actor row,
and CommitScopeDO may use that pair to replace stale activeScope and persist the
actor row at the open boundary.

## Validation Evidence

Final post-fix validation:

- `git diff --check`: pass
- `npm run typecheck`: pass
- `npm test`: pass, 43 files / 592 tests
- `npm run test:worker`: pass, 20 files / 300 tests
- `npm run smoke:cf-dev -- --measure --passes=3`: pass

Measured workerd summary:

| Metric | cold | warm | warm2 |
| --- | ---: | ---: | ---: |
| smoke steps | 13/13 | 13/13 | 13/13 |
| turns | 43 | 43 | 43 |
| total_ms | 17098 | 16127 | 16153 |
| ensure_client_ms | 8979 | 8219 | 8251 |
| authority_ms | 1309 | 1322 | 1314 |
| submit_ms | 3098 | 2916 | 2927 |
| vm_ms | 379 | 389 | 409 |
| authority_calls | 43 | 43 | 43 |
| repair turns (`attempts != 1`) | 0 | 0 | 0 |
| first-touch turns (`ensure > 0`) | 43 | 43 | 43 |
| warm-repeat turns (`ensure == 0`) | 0 | 0 | 0 |
| slice reconstructions | 63 | 63 | 63 |
| envelope request bytes sum | 8690155 | 7575571 | 7584248 |
| envelope request bytes max | 628402 | 630470 | 630541 |

Interpretation:

- Local/workerd functional status is green.
- Local/workerd performance status is acceptable for the current plan: zero
  repair turns, stable authority calls/reconstruction counts, and no unexpected
  workerd smoke failures.
- Full green versus functional-but-slow cannot be claimed until deployed
  walkthrough and tail metrics are captured. Plan 001 requires deployed warm
  latency evidence and state-path divergence counts.

## Approval-Gated Next Steps

Do not commit, push, or deploy without explicit approval.

If commit is approved:

```sh
git add spec/reference/cloudflare.md plans/ notes/ src tests vite.config.ts
git commit
```

The commit body should include:

- Why active stateless session renewal exists.
- Why stale relay/session rows were the failure mode.
- Why slim MCP envelopes must retain bounded actor support rows.
- Which tests protect the behavior.
- The measured workerd summary above.

After commit, if deploy is separately approved:

```sh
npm run deploy
npm run smoke:walkthrough:tail
```

Then classify according to Plan 001:

- Green baseline: deployed functional and performance definitions both pass.
- Functional but not performant: deployed smoke passes, but latency misses the
  thresholds.
- Not functional: any enforced smoke step fails, session expiry recurs, or
  unbounded state-path divergence appears.
- Inconclusive: deployed tail/metric evidence is missing or insufficient.
