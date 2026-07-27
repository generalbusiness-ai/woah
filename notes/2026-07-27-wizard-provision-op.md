# Operator wizard provisioning (AP11)

Work note for the signed operator op that un-bricks wizard access on a deployed
Net world. Normative text lives in
[spec/identity/provisioning.md §AP11](../spec/identity/provisioning.md) and
[spec/reference/cloudflare.md §R14](../spec/reference/cloudflare.md); this note
records the decisions, the things that were *not* obvious, and the deploy-day
runbook.

Origin: `notes/2026-07-27-mcp-surface-walkthrough.md`, headline finding.

## The problem, restated precisely

Two locks compose into a circularity on the deployed world:

1. `$wiz` is a catalog seed with no placement. `clientAnchorObject` falls back
   to the actor itself for a located-nowhere actor; a `$`-prefixed anchor
   classifies as `catalog`; `clientTurn` refuses a non-`room:`/`cluster:`
   planning scope with `E_INVARG unplannable_scope`. Every wizard tool fails,
   including `home` — the one whose job is to fix placement.
2. `programmer_grant_quota` defaults to 0 and only a wizard can raise it.

So: no wizard can act, and no programmer agent can ever be minted.

## Decisions

**D1 — A turn, not a cell write.** The other four signed operator ops
(`repair-{definitions,contents,relations,seed-properties}`) write cells,
because in each case the correct value is derivable *outside* the world.
Provisioning an actor is not: it consumes quota, advances two counters, appends
to `account.actors`, anchors an object, mints an id from the allocation
counter, and composes the programmer surface. Writing those cells operator-side
would fork the world's accounting into a second implementation that must be
kept in step forever. The op therefore runs the world's own primitive through
the ordinary planner. The accepted transcript is the audit record (AU1), the
same way the human's self-service promote already works.

**D2 — One primitive, not four turns.** The four steps (grant quota, create,
promote, flag) could each have been an existing verb driven by four sequential
internal turns. One turn is atomic: a failure at step 3 leaves nothing behind,
whereas four turns need four separate idempotency stories and can strand a
half-provisioned agent. `$human:provision_wizard_agent` composes the shared
helpers (`provisionActorInternal`, `setProgrammerAgentState`, the lineage seam)
rather than reimplementing them, so the counters and audit actions are the same
ones the self-service surface produces.

**D3 — Defined on `$human`, targeted at the human.** The turn target decides
the committing scope. `$system` is catalog-resident, so a `$system`-targeted
verb could not write the account, the new agent, or the api-key record. With
the human as target the whole write set is one cluster — exactly the topology
`promote_agent_to_programmer` already relies on.

**D4 — Compose with `/net-operator/credentials/ensure`, do not mint.** The
primitive sets `agent.api_key_id` (a pointer) and nothing else. Rationale:
`createApiKeyRecord` would generate the secret *inside the worker* and return
it through the operator channel, whereas the existing credential route lets the
operator generate everything locally and send only `hash`+`salt`. The existing
route is also already tested, replay-stable, and writes the authority-private
verifier index.

**Non-obvious ordering consequence.** A routed api-key id is
`routedApiKeyId(authorityRoot, actor, rand)` — it *embeds the actor*. The
operator cannot pre-generate the credential before the agent exists, so the
"candidate durable before the network call" property of
`net-ensure-credential` cannot cover the first call. The runbook is therefore
three calls (provision → ensure → provision-with-pointer), each independently
idempotent, and the durability guarantee is preserved for the step that holds
the secret.

**D5 — `provision_id` as the idempotency handle, with a fail-closed reverse
pointer.** `account.operator_provisioned_agents` (a `provision_id -> agent`
map) is read from the account the turn already touches: bounded, cluster-local,
no enumeration. `agent.provision_id` is the reverse pointer, and a mismatch
*refuses* rather than minting a second identity — a property read of an
unwarmed instance silently returns the class default, and here that would mean
a duplicate wizard. Both the declared `argSpec.authority.prefetch` and an
explicit gateway-side `pullTargeted` warm the ledger's agents before planning.

**D6 — Turn idempotency key is per-invocation.** A stable key would replay the
first commit's cached reply, which carries no result value — so a retry after a
lost reply could not learn the agent id it needs for the credential step. The
durable handle is `provision_id`, enforced inside the primitive. Two concurrent
runs are safe: the loser fails its read-version check, repairs, replans against
committed state, and reports `created: false`.

**D7 — The gateway never names `$wiz`.** The acting principal is the owner of
the resolved `provision_wizard_agent` verb page, the same data-driven
derivation the guest door uses for `guest_template.maintenance_principal`. A
world without the primitive refuses `E_VERBNF` at the route instead of failing
deep inside planning.

## Defects found while building this

**F1 (fixed) — `$system:set_quota` was unusable on Net.** It appended
`$system.wizard_actions`, a catalog cell, so every call failed
`E_CATALOG_MUTATION`. This is half of the deadlock: even holding a working
wizard, nobody could grant programmer quota. Verified by probe before and after.
Fix: route the audit through the AU1 provisioning sink, declare the tracked
native contract, and add an `{arg: 0}` authority prefetch (the turn target
`$system` is catalog-resident, so the account has to be prefetched from the
argument or the plan writes the new quota over a class-default prior).

**F2 (fixed) — same catalog audit write in `provisionActorInternal` and
`createAgentForHuman`.** Both now use the AU1 seam. Note this does **not** make
`$human:create_agent` work over Net: it is still an untracked native and is
refused `incomplete_transcript` (probe-confirmed). Removing the catalog write is
a precondition for tracking it, not the whole job.

**F3 (not fixed, deliberate) — `setObjectFlags` still calls
`recordWizardAction`.** Its only caller, `$system:set_actor_flag`, is untracked
and is refused over Net before that line runs. Moving its audit to the sink
would be inert while implying Net support that does not exist. Wizard authority
on Net is granted by AP11.

## Named residuals (not verified, not claimed)

- **Other `recordWizardAction` call sites on cluster-local primitives** —
  `agent_revoked`, `actor_deactivated`, `actor_reactivated`, `actor_recycled`,
  `mint_session_for`, `force_recycle`, `force_direct`. Each writes
  `$system.wizard_actions` and would fail `E_CATALOG_MUTATION` if its verb were
  ever tracked and driven over Net. Most are untracked natives today, so they
  fail earlier for a different reason. Not probed; not claimed working.
- **`$human:create_agent` over Net** — probe-confirmed broken
  (`incomplete_transcript`, `native:<human>:create_agent`). AP11 does not depend
  on it. Making it tracked is a separate piece of work with its own
  transcript-contract and prefetch design.
- **`demote_agent_from_programmer` does not clear the wizard flag.** Documented
  in AP11.7 rather than changed: clearing programmer-without-wizard is the
  correct meaning of demote for ordinary agents, and `revoke_agent`
  (deactivation) is the lever for retiring an operator wizard. A deactivated
  actor cannot authenticate, so the residual flag grants nothing.
- **Fresh installs still seed no usable wizard.** Considered and deliberately
  not done: seeding an operator wizard at install time means seeding a
  credential at install time, and there is no human account to anchor it to
  until signup runs. The install-time equivalent would be a seeded `$human`
  with a seeded credential, which is a bigger identity decision than this
  change should make. The runbook step below is the sanctioned path for every
  world, fresh or aged.
- **Dead exports discovered**: `nativePrimitiveOpenSeedVerbLookups`,
  `…ObjectPropertyNames`, `…CatalogPropertyNames`, `…DispatchVerbNames` in
  `src/core/native-primitive-contract.ts` have no callers anywhere (leftovers
  from the retired v2 open-seed path). The `open_seed` *fields* are still
  useful contract documentation and are populated for the new entries; the four
  exported readers are not. Left alone as out of scope, recorded here.

## Verification lanes actually run

- `npm run typecheck` — both tsconfigs, clean.
- `npm test` — 81 files, 987 tests, all passing (was 978 on the branch point).
- `npm run test:worker` — 40 files, 302 tests, all passing.
- `tests/worker/net-provision-wizard.test.ts` — real fake DOs, real signed
  route, real `/net-api/session` + `/net-api/turn`. The wizard-authority claim
  is proved against a CONTROL agent in the same cluster that gets `E_PERM` on
  the identical call, so it cannot pass by accident.
- `tests/operator-wizard-provision.test.ts` — core semantics: quota accounting,
  the local audit sequence, convergence, and the four fail-closed ledger
  branches. Added to the `npm test` curated list.
- `tests/worker/net-only-entry.test.ts` — the edge allow-list and fresh
  signing.
- `tests/net/net-provision-wizard-script.test.ts` — the CLI's three-call
  composition and argument refusals.

**Not run**: workerd (`smoke:net-dev`, `smoke:net-mcp`) and the deployed
walkthrough. The fake-DO lane runs every DO in one process; cold-start and
cross-colo behaviour of this op is unproven. The op does one turn against a
warm-or-cold cluster, so the realistic deploy-time risk is a cold-owner timeout
on the first attempt, which retries.

## Deploy-day runbook

The code landing does not heal the world. After deploying the runtime:

1. Pick the human account to anchor the operator wizard to. It must be a real
   `$human` with an `$account` in its own authority cluster (any signup-created
   human qualifies; a cutover-imported one does if its account is anchored —
   see the AP6 "supported scope" note).
2. Run, with the deployed `WOO_INTERNAL_SECRET` in the environment or in the
   owner-only operations credential file:

   ```bash
   npm run provision:net-wizard -- \
     --base-url https://woah1.generalbusiness.ai \
     --human <human actor id> \
     --provision-id ops-wizard-1 \
     --name OpsWizard \
     --credential-name OPS_WIZARD_WOO_APIKEY
   ```

   It prints the minted agent id and the account counters. The token lands in
   `~/.config/generalbusiness/woo_net_credentials.env`, mode 0600.
3. Verify from outside: open an MCP session with that token and confirm
   `tools/list` returns the programmer surface (`…__install_verb`), then call
   `set_quota` on the account to confirm wizard authority end to end.
4. Re-running the command is a no-op. To mint a second operator wizard use a
   new `--provision-id` and `--credential-name`.

Retiring one: `$human:revoke_agent(<agent>)` from the owning human (AP11.7).

This op belongs to the same family as the other post-deploy operator runs
already on the checklist (`repair:net-definitions '$programmer:edit_verb'`,
`repair:net-seed-properties`).
