# Net cutover tooling (plan §8 Phase 5 — the build before the op)

Date: 2026-07-08. Branch `net-cutover` (from main `084488f`, the first
net-path prod deploy `1822b220`). The net path is live as the PARALLEL
surface with a fresh empty namespace; this plan builds the tooling the
ratified §8 cutover protocol needs. The CUTOVER ITSELF (maintenance
window, freeze, route switch) remains an owner-run operation — nothing
here moves traffic.

Protocol source: notes/2026-07-04-simplest-system-plan.md "Phase 5 —
Deploy, prove, delete" (owner-approved 2026-07-05).

## D — named "not installed" verdict (rough edge from the deploy)

An authenticated /net-api request against the unseeded catalog scope
today surfaces as `500 E_INTERNAL` wrapping the scope's named
`E_MISSING_STATE has_meta:false`. Clients (and the cutover's own
verification probes) need a legible verdict: a named "world not
installed" refusal with a 503 shape. Smallest honest change in
`catalogIdentity`'s pull-failure path.

## A — install/seed pipeline (`scripts/net-install.ts`)

Install the world from catalogs into the net namespace — the same path
any environment uses (dev lane first, prod at cutover):

1. Build the world in-process: `createWorld()` (bundled catalogs via the
   boot snapshot) + `installLocalCatalogs(world, parseAutoInstallCatalogs)`
   to match the deployed catalog set.
2. Optional identity injection (item B's import) BEFORE export, so the
   carried actors/api_keys partition and seed like any other world state
   — no second seed pass, no ref rewriting.
3. `cellsFromSerialized(world.exportWorld())` → `partitionCells` (CO15)
   → one signed `/net/seed` per scope through the `/net-smoke/scope/...`
   doorway (H1b: internal-signed, works against wrangler dev AND the
   deployed worker; the doorway name is historical — it is the generic
   signed net-DO conduit).
4. Catalog epoch: one epoch stamp for the whole install (the M9 seed
   guard makes re-seeding at the same epoch a no-op-shaped success —
   idempotent per the migration rule; a DIFFERENT epoch refuses).
5. Post-install verification (abort on failure, per the import rule):
   every seeded scope answers `/net/head` at the install epoch; when an
   identity import rode along, a carried apikey MUST mint a session
   through the real `/net-api/session` surface.

Provable on the dev lane (`wrangler dev` via wrangler.smoke.toml) as a
vitest/smoke addition; the prod run is step 2 of the cutover op.

## B — identity export/import

Export schema (`identity-export.json`, exactly the §8-approved shape):
- `api_keys`: the `$system.api_keys` map verbatim (hashed records).
- `actors`: the reachable identity actor graph — every `$account`
  instance and every `$actor` descendant referenced by an apikey record
  or an account binding. Per object: original id (preserved), parent
  CLASS NAME (resolved against fresh catalogs at import), owner, flags,
  and a CLOSED allow-list of identity properties (name, account,
  created_via, profile_id, password/verifier props, last_seen_at).
- Bearer tokens dropped by design (60-min TTL).

Export source: a new internal-signed v2 route (`/__internal/identity-export`)
— rides the SAME v2-side deploy as item C's freeze (one pre-cutover v2
deploy, per the protocol's "final identity-export from FROZEN old prod").
Import: `importIdentity(world, export)` re-creates actors with preserved
ids against the freshly installed catalogs, then writes api_keys;
verification: every `api_keys[*].actor` resolves to a live `$actor`
descendant and every account binding resolves — dangling refs ABORT.
Idempotent; vitest coverage (export→fresh-install→import→verify→
authenticate round-trip, in-process).

## C — write-freeze

Flag-gated (env var read per-request, settable via `wrangler secret` /
vars without code change — no redeploy to freeze/unfreeze beyond the
flag flip): mutating turns and identity operations (mint/rotate/register)
refuse with a named maintenance error; reads continue. Same v2 deploy as
the export route.

## Order

D (small, unblocks legible verification) → A (dev-lane proven) →
B (in-process proven; the export route + C ride one v2 change) →
then the OWNER's cutover op: freeze → export → install+import to prod
net namespace → §8 steps 3-7 (prove, route switch, postflight, bake,
rollback rule, deletions).
