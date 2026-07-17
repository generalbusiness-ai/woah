# Net cutover receipt — 2026-07-13

NC7 installation receipt for the production cutover of `woah`
(woah1.generalbusiness.ai) from the v2 stack to the net (coherence) stack.

## Decision context

Operator (hughpyle) authorized a **fresh** cutover: the long-nonfunctional
prod v2 world is disposable, so **no identity export/import, no v2
write-freeze, and no rehearsal**. The NC2 (write-freeze), NC3 (export
watermark), and NC4 carried-credential steps were therefore skipped by
design — they exist only to preserve an old world's state/identities.

## Source / target

- Predecessor prod version (net OFF): `a3a9874f-afa7-4c01-95fa-df90cfa5365f`
  (main `27b705d`, the net-cutover hardening code deploy).
- Cutover version (net ON): **`5554d6ce-a9e8-409b-9e5b-5993d59a1837`**
  (main `3782bc7`).
- Install epoch: **`cat-1926a87fb31f4ea4`** (full bundled catalog set,
  `DEFAULT_LOCAL_CATALOGS`).

## Secret rotation

The operator-held `WOO_INTERNAL_SECRET` did not match the deployed worker
(signed `--probe-only` returned `E_PERM` in both whitespace forms). With
operator approval the secret was **rotated**: a fresh 64-char base64url value
was generated, uploaded via `wrangler secret put WOO_INTERNAL_SECRET` (stdin,
never argv), rolling a new worker version. The signed probe then passed.

## Install + activation (NC1 / NC4 / NC5)

- 20 scopes seeded and verified at the install epoch: `catalog` +
  10 clusters (`guest_1..8`, `the_horoscope`, `the_weather`) +
  9 rooms (`the_chatroom`, `the_deck`, `the_dubspace`, `the_garden`,
  `the_hot_tub`, `the_outline`, `the_pinboard`, `the_taskboard`,
  `the_verb_editor`). All heads `seq:0` at `cat-1926a87fb31f4ea4`.
- Catalog authority published the active epoch → namespace **ACTIVE**.

## Verification (NC4 / NC5)

- Signed install probe: secret reached edge + catalog scope.
- Pre-switch prove (`net-canary-load --actors 4 --rounds 1`): 4/4 guest
  mints, 0 server errors, cross-shard roster **complete** (4 guests across
  3 shards, `partial:false`, `min_seen:4`, `unreachable:0`).
- Post-switch prove (same driver, public path): 4/4, 0 errors,
  `partial:false` across 2 shards.

## Public selection (NC6)

`WOO_NET_DEFAULT = "on"` added to `wrangler.toml [vars]` (commit `0edc911`)
and deployed. Confirmed at the edge:

- `GET /client-config` → `{"net":true}`.
- Public `POST /mcp` → `/net-api/mcp` (`401` unauthenticated = worker-first
  invariant intact).
- Deploy postflight self-probe: `selected stack: net`.

The v2 `/v2/*`, `/connect`, and REST contracts are **not** compatibility-
mapped; they remain frozen old-world endpoints serving the disposable v2
world. No freeze flag was set (operator decision).

Guard follow-up: `WOO_NET_DEFAULT` marked prod-only in
`scripts/guard-smoke-wrangler.mjs` (commit `3782bc7`) — the smoke/cf-e2e
lanes run the v2 walkthrough and must not default to net.

## Point of no return

Passed. Public selection is live; real user net writes now land. Per NC6
there is no reverse replication — returning to v2 would discard net-era
writes. Accepted under the fresh-world decision.

## NC8 bake — outstanding

`metrics:net-ae --watch` (the AE acceptance gate) requires
`CF_ANALYTICS_TOKEN`, which is not available in this session; the bake is
`wrangler tail` diagnostic-only until the token is provided. The
geographically-separated / cold-start / sustained-rate envelope remains the
open post-cutover acceptance item.
