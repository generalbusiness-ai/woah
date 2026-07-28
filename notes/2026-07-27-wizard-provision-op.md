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

**F3 (fixed) — `$human:revoke_agent` was unusable on Net,** same catalog audit
write. Found by probing the AP11.7 retirement story rather than assuming it:
the first probe returned `E_CATALOG_MUTATION` on
`property_cell:$system:wizard_actions`, so *no account owner on the deployed
world could retire an agent at all*. Fix is the same three pieces as set_quota
(AU1 sink, tracked contract, authority prefetch matching promote/demote).
Re-probed: accepted, touching `object_lineage:<agent>`, `agent_count`,
`programmer_agent_count`, `deactivated_at`, `features`, `features_version`.
The same probe confirmed `$system:revoke_api_key` already worked over Net
(it converges after one E_READ_VERSION repair round — it has no prefetch,
because its argument is a key id, not an object the grammar can resolve).

**F4 (not fixed, deliberate) — `setObjectFlags` still calls
`recordWizardAction`.** Its only caller, `$system:set_actor_flag`, is untracked
and is refused over Net before that line runs. Moving its audit to the sink
would be inert while implying Net support that does not exist. Wizard authority
on Net is granted by AP11.

## Review round 1 — three defects, all probe-confirmed by the reviewer

**R1 (P1) — repeated revocation corrupted quota accounting.** `revoke_agent`
unconditionally stamped `deactivated_at` and decremented `agent_count`. Revoke
one agent twice with two live and the counter reaches 0 while one is still
active, so the next create/provision under-counts and the account mints past
quota. Fixed: the tombstone is read before any mutation and decides whether the
call is the one that returns the slot. Programmer-stripping and key revocation
still run on the repeat (both idempotent), which makes a repeat a *repair* for
an actor tombstoned by `$system:deactivate_actor`, which never revokes.
`setProgrammerAgentState` was checked for the same shape and is already
correct — it moves flag and counter only on a real transition — and now has a
regression test rather than an assumption.

**R2a (P1) — any non-empty `api_key_id` was stored.** Retirement follows that
pointer and nothing else, so a misbound pointer meant the agent's REAL
credential survived retirement. Now validated fail-closed on four axes (parses
as routed, bound to this agent, authority root equals the anchor root, and a
live verifier record exists on the agent with a matching actor). Note the
reviewer's "record must exist in `$system.api_keys`" is the legacy global map:
routed ids live in the ACTOR-owned `api_keys` property, which is where the
check reads. The unit test that accepted `n1_x_y_z` was the bug's own alibi and
is replaced with the valid case plus one refusal per axis.

**R2b (P1) — a live session outlived retirement.** `assertActorEligible` runs
only at session mint, and a bearer presents a session id, never its key. Added
a view-only tombstone check to `authorizedActorForSessionBearer`, the single
choke point for MCP, WS, and bearer paths. Conservative by design: no warm/fetch
on the hot path, and an absent cell is not a refusal (a cold gateway cannot
distinguish "not deactivated" from "not pulled"). Propagation is eventual —
seconds, via the fanout the serving gateway is already subscribed to. Verified
by negative test: disabling the one line makes the new MCP case fail. The case
is built so the api-key check cannot mask it — the agent carries no `api_key_id`
pointer, so revocation tombstones without revoking a key.

**R2b widened: the APIKEY class had the same hole, and it was worse.** The
finding was scoped to session bearers; probing the sibling branch showed a
retired wizard authenticating with a long-lived key plus an already-minted
session id and committing a wizard-only `set_quota` turn — 200 accepted, the
account cell written. The enabling fact is that `revoke_agent` revokes only the
key `agent.api_key_id` names, so any SECOND credential on that actor (exactly
the AP11 state between runbook steps 2 and 3, or after any manual
credential-ensure) survives retirement. The gate now runs on both credential
classes at actor resolution. Probe transcript is in the test comment; the test
asserts 403 and that the wizard-only write did not land.

**R4 (P2) — `provision_id` collided with `Object.prototype`.** `constructor`
resolved `function Object()` through inherited-member access and was
dereferenced as an agent id. Fixed with a null-prototype ledger map, own-key
reads (`Object.hasOwn`) in both the primitive and the gateway prefetch, and the
object-literal computed-key form for the write (`obj[k] = v` would hit the
`__proto__` setter; `{...m, [k]: v}` defines an own property). Added a 1..128
bound on `provision_id` in the primitive — the wire grammar stays stricter at
the route.

**R4 uncovered a substrate bug.** `__proto__` still did not round-trip after
the ledger fix. Root cause was NOT in AP11: `clonePlainData`
(`src/core/types.ts`) copied with `copy[key] = value`, which for that one key
name invokes the accessor inherited from `Object.prototype`. Two wrong
outcomes, both reachable from ordinary woo map data (a tag, a help topic, a
user-chosen key): a primitive value is silently DROPPED — every clone loses the
entry — and an **object value becomes the clone's prototype**, i.e. a
prototype-pollution primitive expressible in plain data. Fixed with
`Object.defineProperty` for that key only (one string comparison per key on a
path whose reason for existing is that it is cheap). Regression tests added to
`tests/clone-plain-data.test.ts`. This affects every map property in the
system, not just AP11's ledger.

Auditing the sibling sites (`out[k] = v` over untrusted keys, plus inherited
`in`/index reads) found three more real ones, all fixed with tests:

- **`sortKeys` in `src/net/cells.ts`** — the CANONICAL cell encoder behind
  `cellVersion`. A dropped key means two materially different cell values hash
  identically: a version collision, not merely lost text. Safe to change
  because no stored world can hold such a value — the clone path destroyed it
  before it could be persisted.
- **`scrubTombstoneRefs` in `world.ts`** — a `__proto__` entry vanished from any
  map that survived a tombstone scrub, turning a GC pass into silent data loss.
- **`mergeSeedMapProperty`** — wrong in BOTH directions: `key in merged` is an
  inherited test (`"constructor" in {}` is true), so a manifest key named after
  a prototype member read as already-present and never seeded, and the write
  dropped `__proto__`. The `supersedes?.[key]` lookup was inherited too, which
  could license a replacement from a fingerprint that was never declared.

Checked and already correct: the VM's `INDEX_SET` uses the safe
object-literal computed-key form, so woocode `m["__proto__"] = v` cannot
pollute.

Honest scoping note: the gateway half of R4 (own-key prefetch read) is
**defence in depth**, not a reproducible failure — an inherited lookup there
yields a function, `typeof === "string"` rejects it, and the prefetch is merely
skipped. The world half is the one that produced the reviewer's E_OBJNF. The
fake-DO test seeds the ledger first so the gateway path is at least exercised
in the ordering where it matters.

## Review round 3 — the mirror-image accounting bug

**R3-4 (P2) — `deactivate_actor` then revoke leaked the quota slot.** My round-2
fix read `deactivated_at` as "the slot was already returned" and exited early.
But `$system:deactivate_actor` sets that tombstone and decrements NOTHING, so
the reviewer's sequence left `agent_count` at 1 → 1 → 1, returned success, and
recorded no `agent_revoked` audit at all. Round 2 closed the double-return and
opened the leak — the same conflation, read from the other side.

Root cause: `deactivated_at` was doing double duty. It answers "may this
identity authenticate?" (REVERSIBLE — `reactivate_actor` clears it) and was
being read as "has the quota slot come back?" (PERMANENT). Two facts, one
marker.

**The marker: `$agent.retired_at`, a timestamp.**

- *Named for the lifecycle state, not the bookkeeping.* `agent_slot_returned_at`
  would name one consequence of retirement; the slot return is one of several
  things retirement does (key revocation, programmer strip, tombstone). Naming
  the marker after the accounting side invites the same conflation in reverse.
- *A timestamp, not a boolean*, matching `deactivated_at` / `revoked_at`
  elsewhere, and it records WHEN the slot returned — which the audit trail
  wants and which is a genuinely different instant from when the identity
  stopped authenticating.
- *On the agent*, so it is cluster-resident with everything else revoke writes
  and needs no extra prefetch.

`deactivated_at` is now purely an auth fact. The round-2 session-tombstone gate
reads it as an auth fact, which is correct, and is unchanged.

**Symmetry: reactivation of a retired agent is now refused.** Without this the
new marker creates the inverse bypass — a live identity whose slot has already
been returned, i.e. N live agents against a count of N-1. Plain deactivation
stays fully reversible because it never returned a slot. This was not in the
finding; it is the hole the fix would otherwise have opened.

**Aged data.** A world revoked before `retired_at` existed carries the old shape
and would be double-returned on the next revoke. `agentSlotReturnedAt` therefore
infers retirement from a conjunction `deactivate_actor` cannot produce — auth
tombstone set AND the agent's current key already revoked — and backfills the
marker so no later call needs the inference. The residual false positive is an
operator who deactivated and hand-revoked the key; that errs toward leaving the
slot counted, which is the safe direction. Tested with a hand-built pre-marker
world.

**Neighbour audit for the same conflation.** Every other `deactivated_at` reader
is an AUTH check and correctly left alone: `actorCanAuthenticate`, the account
gates in `createAgentForHuman` / `provisionOperatorWizardAgent`, and the round-2
session gate. Two surfaces were updated because they are user-facing rather than
accounting: `list_agents` now reports `retired_at` alongside `deactivated_at`,
and the AP11 provision-reuse refusal names which of the two states it hit (only
one of them can be undone). `programmer_agent_count` needed no change —
`setProgrammerAgentState` moves flag and counter only on a real transition — but
it is now asserted across every ordering instead of assumed.

**Negative-test matrix.** Each variant breaks a different case, which is what
tells them apart:

| Variant | Case that fails |
|---|---|
| round-2 guard (`deactivated_at` as accounting) | ordering (2), deactivate → revoke: the leak |
| no guard at all (always decrement) | ordering (3) repeat revoke, and the aged-data case: the double-return |
| reactivate guard removed | the inverse-bypass case |

Orderings (1) and (4) pass under every variant — they are the unambiguous cases
and serve as regression anchors, not discriminators. Stated plainly so the
matrix is not read as stronger than it is.

## Deploy round — the two blockers the ladder promised

Main deployed (`691cc882`, worker `e8b835c9`), and the runbook was
**unexecutable**. Both blockers were deploy-only in the honest sense: no
fake-DO test had ever modelled a *freshly cut-over* world, which is the one
shape that has neither of the things AP11 needs.

### Blocker A — a new bootstrap verb could not reach an aged world

`repair-definitions` refused `$human:provision_wizard_agent` with
`E_INVARG ... accepts unique bootstrap definition pages only`. Root cause in
`scope-do.ts`: `validVerb` carried `&& seq.store.has(key)`, making verb pages
**replace-only**. `validProperty` has no such clause and the CLI header already
documents installing a property definition an aged world predates, so the
asymmetry was unintended. Since a runtime never rewrites durable cells and this
is the only door, a genuinely NEW bootstrap verb could reach a deployed world
by *no mechanism at all*.

Fixed by dropping the clause — and, because that clause was also the server's
independent guard, by replacing it with a **stronger** one rather than nothing:

**The authority now owns the verb ordinal.** A bundled page carries the `slot` a
FRESH install would assign, which has no reason to match an aged world's
numbering. Writing it verbatim could move a live verb onto a sibling's ordinal —
the exact duplicate-slot corruption CO4.7's repair exists to undo, and which the
ordinary commit path refuses as `verb_slot_moved`. So: REPLACE keeps the stored
ordinal; ADD allocates above every ordinal the object already holds, the same
floor the ordinary commit path demands of a new page. Two adds for one object in
one batch each get their own. This was a latent defect in the pre-existing
replace path too, not just in the new add path.

**Marginal authority of the ADD.** An internal-signed operator can now choose a
NEW verb name on an installed bootstrap class. That is strictly weaker than the
authority they already held: replacing `$root:look` with arbitrary bytecode —
including the `perms`/`owner`/`direct_callable`/`tool_exposed` metadata that
ride the page — changes behaviour for every existing caller immediately, whereas
an added name is invoked by nobody until something calls it. The add cannot
reach a class the world does not hold, cannot leave the `$` namespace, cannot
displace an existing ordinal, and is still capped at 32 changes in the catalog
scope. Removals are untouched.

### Blocker B — there was no human to anchor to, and no way to make one

Confirmed offline against the real install plan rather than by probing prod:
**a fresh install seeds zero `$human` and zero `$account` instances** in any
partition. They come from signup, and the net stack exposes no signup route. So
the deployed world had nothing for AP11 to anchor to.

Two things were wrong, and they are separate defects:

1. **The refusal was ambiguous.** `callVerbPage` resolves through the target's
   lineage chain, so an absent human and an absent verb page both returned
   null → both reported `E_VERBNF`. That sent the operator hunting for a
   missing definition when the real answer was a missing identity — opposite
   remedies. Now: human absent → `E_OBJNF` carrying the anchor remedy;
   primitive absent → `E_VERBNF` carrying the exact `repair:net-definitions`
   command. Plus `{probe: true}`, a **non-mutating** report of
   `human_present` / `human_class` / `primitive_installed` / `recorded_agent`
   and a `next` field naming the command to run. That is the answer to "is
   there a human on this world?" — `/net-api/cell` cannot answer it, being
   presence-scoped and refusing identically for present and absent objects.

2. **The anchor had to be creatable.** Decision: a **separate signed operator
   op**, `POST /net-operator/identity/anchor`, not a flag on the provisioning
   verb. The coordinator listed "extend AP11 to mint the human when a flag says
   so" as an option, and it is not implementable: `provision_wizard_agent` is
   defined on the human class and TARGETS the human, so it cannot run before
   the human exists. More fundamentally, creating a never-before-seen authority
   cluster is not a turn at all — a turn needs a target whose scope has a head.
   It is a GENESIS SUBMIT, and the proven precedent is elastic guest
   provisioning: one transcript against `{seq: 0, hash: cellVersion(["genesis",
   scope])}`, handed to the new cluster's own sequencer. `src/net/identity-anchor.ts`
   is that construction, deliberately parameterised on the class names the same
   way `guest.ts` takes its parent from installed template data.

**Why this does not weaken the identity model.** The minted account carries no
`password_hash`, no `password_salt`, and no `oauth_identities`, so
`/net-api/login` cannot produce a session for it — *nothing can authenticate as
the anchor*. No api key and no session are minted. Credentials only ever reach
the AGENT, through the existing credential-ensure route, from a tuple generated
on the operator machine. The result is exactly the credential-less
manual-provisioning shape AP10 already sanctions, previously reachable only
in-process. `programmer_grant_quota` starts at 0. Ids derive from the operator's
token (`human_op_<hex>`), so there is no counter to coordinate in a genesis
cluster and a lost reply replays byte-identically.

### Evidence

`tests/worker/net-operator-anchor.test.ts` builds the deployed shape — catalog
partition with the AP11 page removed, no human anywhere, scope DOs created on
demand so a genesis submit has somewhere to land — and drives the whole runbook
through the real signed routes. Negative-tested: restoring the replace-only
clause fails 3 cases; removing the slot normalization fails the replace case;
removing the human-absence branch fails the probe case.

## Prod round 2 — what shipped worked, and the aged-world gap it exposed

Deployed (`54e66d4c`, main `8da19ed7`). The verb-ADD path, the anchor genesis
submit, provisioning, and the credential all worked first try in production, and
the `unplannable_scope` brick is gone: the provisioned agent authenticates over
MCP and commits turns. Three defects remained.

### Defect 1 — authority without tools. ROOT CAUSE CONFIRMED, not inferred.

The coordinator's hypothesis was right, and I verified it by construction rather
than accepting it: with `$system.programmer_surface` unset,
`programmerSurface()` returns null, `attachProgrammerSurface` no-ops, and the
shared transition still sets the flag. Reproduced locally —

    RESULT promoted = true flagged = true
    agent flags = {"programmer":true,"wizard":true}
    agent features = []

which is exactly prod's symptom (10 tools, no `eval`/`create`/`install_verb`,
`property_cell:agent_1:features` → null). A fresh world has
`programmer_surface = "$programmer"` and the class exists; the deployed world
was installed 2026-07-13, the publishing seed hook landed 2026-07-23
(`8f8f548d`), so the world predates the scalar while having the class — which is
also why the coordinator's `repair:net-definitions '$programmer:edit_verb'`
succeeded.

Fix: AP11 now REFUSES with `E_MISSING_STATE` naming the remedy. Core's general
promote is unchanged — flag-only remains correct for a world that never
installed an authoring catalog (AP6) — but AP11's contract is a *usable* wizard,
so for this op a toolless outcome is a failed provisioning reported as success.

**A finding worth more than the fix.** Placing that check next to the promote it
guards was not enough: the refusal left `account.agent_count` incremented.
**A native that throws part way through still commits the writes it already
made.** My own AP11.3 claimed "a failure at any step commits nothing" — that was
FALSE, and is now corrected in the spec. The check moved to the top, ahead of
the first write, and the correction generalises: any precondition this family
can check must be checked before the first write, or expressed as idempotent
re-runnable state.

### Defect 2 — no operator op carried a scalar seed value

`repair-definitions` carries definition pages; `repair-seed-properties` mined
only `merge_map`. A `mode: "set"` scalar was covered by neither, so an aged
world could never learn a scalar a later catalog began publishing. Extended the
existing op rather than adding a sibling — it is the same trust model, the same
mining discipline, and CT14.7 already frames it as the seeded-value lane.

Overwrite rule (the scalar analogue of `supersedes`): absent → deliver;
equal → no-op; present-and-different → refuse UNLESS the manifest lists the
stored value in `supersedes`. Operator edits survive, as in the map path.

Mining had to be narrowed while widening the mode: `set` hooks also target
INSTANCES (`tasks:the_taskboard.exits`), whose cells are in no partition and
which the server's `$` guard would refuse anyway. Restricted to catalog-owned
`$` objects, which is exactly the CT14.7 boundary (instance rewrites have no
operator op). Mined set is now `$help.topics` (merge_map),
`$system.programmer_surface`, `$weather_block.summary_props`.

### Defect 3 — probe threw instead of reporting. NOT REPRODUCED; say so.

I could not reproduce it, and I am not going to claim a root cause I do not
have. Evidence against every hypothesis I formed: both my commits were ancestors
of the deployed main; the merged source has the probe branch ahead of BOTH
refusals; and a new test that drives the REAL driver against the REAL routes
across all four (anchor present/absent × primitive present/absent) combinations
passes. The reported 409 is unexplained by the source I can read.

So I fixed the class of failure instead of guessing at the instance:

- the server's probe branch moved ahead of the authority prefetch, the only
  throwing step that preceded it (that prefetch is deliberately HARD for a real
  run, but a diagnostic must never fail closed);
- the CLI now treats a refusal as DATA on any probe hop and still prints the
  plan, so no probe can end in a stack trace whatever the worker says.

The probe also gained `authoring_surface`, which closes the coordinator's
separate complaint that catalog-scope state is unreadable from outside
(`/net-api/cell` is presence-scoped and refuses `$system.programmer_surface`
even for a wizard). Without it the operator would pass a clean probe and only
then hit the new provisioning refusal — a probe must predict every refusal the
real run can produce, so `next` now lists the seed-property repair too.

The blind spot that let this ship: the existing CLI test stubbed `fetch` with an
always-200 fake, so it could not have caught a refusal. That test now has a
sibling wired to a real gateway.

## Named residuals (not verified, not claimed)

- **Other `recordWizardAction` call sites on cluster-local primitives** —
  `actor_deactivated`, `actor_reactivated`, `actor_recycled`,
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
  actor cannot authenticate, so the residual flag grants nothing. Both halves
  are now proved end to end over the client doorway.
- **Defect 3's prod root cause is unknown.** The observable failure is closed
  by construction, but I cannot explain the reported 409 from the deployed
  source, and I did not have network access to probe it. If it recurs, the
  refusal will now print as data rather than throw, which should capture the
  actual status and body.
- **Nothing in THIS round has been run against the deployed world.** The fake-DO lane
  models the aged/fresh-cutover shape faithfully in structure, but it is still
  one process with fast RPC. The operator commands below are the first real
  exercise.
- **`repair-definitions` still overwrites a verb page's `version`** with the
  bundle's, which could move an authoring optimistic lock backwards. Observed
  while working on slots, out of scope for this round, not probed.
- **The deactivate → revoke ordering is local-profile only over Net.**
  `$system:deactivate_actor` is an untracked native, so it cannot run over
  `/net-api/turn` at all; ordering (2) is therefore proved against an in-memory
  world, not the Net path. The Net path exercises orderings (1) and (3).
- **Session-tombstone propagation is eventual, and unmeasured under real
  fanout latency.** The fake-DO lane settles fanout synchronously, so the
  window between a committed revocation and the serving gateway refusing an
  open session is not characterized here. The api-key gate covers the window
  whenever the retired actor carries an `api_key_id` pointer; an actor without
  one relies solely on the tombstone.
- **`revoke_api_key` has no authority prefetch.** Its argument is a key id, not
  an object the prefetch grammar can resolve, so the actor's `api_keys` cell is
  read cold and the turn pays one E_READ_VERSION repair round. It converges
  (probe-confirmed) and is correct, but it is a round slower than it needs to
  be. Not changed here.
- **Fresh installs still seed no usable wizard.** Considered and deliberately
  not done: seeding an operator wizard at install time means seeding a
  credential at install time, and there is no human account to anchor it to
  until signup runs. The install-time equivalent would be a seeded `$human`
  with a seeded credential, which is a bigger identity decision than this
  change should make. The runbook step below is the sanctioned path for every
  world, fresh or aged.
- **Remaining V6 sites are unaudited.** `catalog-installer.ts` (exits map),
  `bootstrap.ts` verb-metadata copy, and two `out[...]` builders in
  `gateway-do.ts` use the same `obj[key] = value` shape. Their keys are object
  ids, scope names, or a fixed metadata vocabulary rather than user text, so
  the exposure is much lower — but they were reasoned about, not probed, and
  are not claimed correct.
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
