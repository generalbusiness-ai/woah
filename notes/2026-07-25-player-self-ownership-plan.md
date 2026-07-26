# Player self-ownership implementation plan

Date: 2026-07-25  
Status: implementation plan; not normative and not implemented.

This note turns the self-ownership decision in
[`2026-07-24-mcp-agent-legibility.md`](2026-07-24-mcp-agent-legibility.md)
§7 into an implementation boundary. It complements the programmer-environment
work in
[`2026-07-23-programmer-environment-mcp-remediation-plan.md`](2026-07-23-programmer-environment-mcp-remediation-plan.md).
The normative specs under `spec/` remain the source of truth and must be made
explicit before implementation begins.

## 1. Decision

The full self-ownership slice is cleanly implementable now, with one ordering
constraint: build it on top of, or immediately after, the
programmer-environment work. That work supplies the Net-safe lineage mutation
seam and the account-family placement needed for the complete cold-reconnect
proof.

The invariant is:

> Every concrete, provisioned `$player` principal owns itself.

This includes concrete `$guest`, `$human`, and `$agent` instances, including
infrastructure agents. `$wiz` already satisfies the invariant. It does not
include the `$guest`, `$human`, `$agent`, or `$player` class objects, which
remain seed objects owned by `$wiz`.

It also does not apply to every `$actor` descendant. `$block` deliberately
inherits from `$actor` and is externally owned: its creator administers its
configuration and plug credentials. Rewriting all actor descendants to
self-ownership would break that contract.

The existing source-authoring check is the intended one and does not change:

```ts
actor.flags.wizard === true ||
  (actor.flags.programmer === true && target.owner === actor)
```

Self-ownership therefore gives a programmer principal the ability to author
its own body. It does not grant the programmer flag, wizard authority, a
feature, an account, a credential, or control of any other object.

## 2. Scope

This slice is complete when:

1. every newly provisioned concrete player principal is self-owned;
2. existing player principals are brought forward safely and idempotently;
3. human administration of agents follows an explicit account binding rather
   than the object-owner edge;
4. account quota, deactivation, audit, identity transfer, and agent-key
   lifecycle continue to work;
5. a self-owned principal cannot exploit generic owner credential operations;
6. guests still reset under trusted maintenance authority;
7. Net performs bounded repair without global enumeration; and
8. a freshly provisioned programmer agent can install and invoke a verb on
   itself over MCP, survive a cold gateway, and lose authoring access when
   demoted.

Feature self-service and the Feature Warehouse proposed by the legibility note
are separate work. They compose with this invariant but are not required to
make direct self-authoring correct.

## 3. Current state and contradictions

The repository currently has several different ownership conventions:

| Path | Current object owner | Target |
|---|---|---|
| `$wiz` seed | `$wiz` | unchanged |
| pre-seeded guests | `$wiz` | the concrete guest |
| dynamically allocated local guest | `$wiz` | the concrete guest |
| fresh signup human | `$wiz` | the concrete human |
| guest promoted to human | the actor itself | unchanged |
| human-created agent | the human | the concrete agent |
| `$wiz`-created infrastructure agent | `$wiz` | the concrete agent |
| `$block` instance | its creator | unchanged |

The promoted-human path already demonstrates that a self-owned human is
compatible with the object model. The inconsistency is in fresh provisioning
and in the responsibilities currently overloaded onto `agent.owner`.

The normative contradiction is concentrated in
`spec/identity/provisioning.md`:

- AP4.2 says an agent is owned by a human or `$wiz`;
- quota, accountability, cascade deactivation, and administration are defined
  through that edge;
- `$system:provision_actor(class, owner, attrs)` exposes that convention in its
  public signature; and
- `$human:create_agent` is specified as passing the human as `owner`.

The implementation mirrors that specification in `provisionActorInternal`,
`assertOwnedAgent`, agent key rotation, and attribution derivation. Those uses
must move together; changing only `createObject({owner: ...})` would be
incorrect.

## 4. Separate the authority axes

Self-ownership works cleanly only if the system stops asking `owner` to answer
unrelated questions.

| Question | Authoritative representation |
|---|---|
| Who may administer or author this object? | `object.owner`; self for concrete player principals |
| Which customer/account administers this principal? | `actor.account` and bounded `account.actors` |
| May this actor compile or install source? | `actor.flags.programmer` |
| Which authoring verbs are visible? | attached `features` |
| Where does the principal's authority state live? | immutable `anchor` / authority family |
| Which customer receives audit and usage attribution? | reserved `customer_of` relation |
| Who may perform guest reset maintenance? | `guest_template.maintenance_principal` |

These axes are intentionally independent:

- a self-owned non-programmer cannot author source;
- a self-owned programmer may author only objects it owns;
- an account administrator may rotate or revoke a bound agent's credential
  without owning the agent object;
- an infrastructure agent may be self-owned and accountless while remaining
  wizard-administered;
- a block may remain externally owned without becoming an account-bound player
  principal; and
- `customer_of` remains reserved identity-pipeline state, not ordinary
  authorable object data.

No new general-purpose `controller` or `administrator` relation is needed.
The existing direct `account` property and canonical bounded
`account.actors` roster express the human administration case. `$wiz` supplies
the infrastructure administration case. For player principals, `account` is
also reserved identity-pipeline state: ordinary self-authoring must not be able
to bind the actor to another customer's account. `created_via = "infra"` is
descriptive provenance, not an authorization or attribution fact.

## 5. Security boundary: owner credentials

This is the most important coupled change.

The generic owner-scoped API-key helpers currently authorize a non-wizard when
`target.owner === actor`:

- `createApiKeyForOwner`;
- `listApiKeysForOwner`; and
- the owner branch in `revokeApiKey`.

That policy is safe for an externally owned actor-shaped object such as a
`$block`. It is unsafe for a self-owned player principal. If the ownership
rewrite landed alone, a guest could mint a durable API key for itself and
escape the ephemeral guest-session lifecycle. A human or agent could also
bypass the account-administered rotation and deactivation surface.

The direct account binding is equally sensitive. A self-owned programmer must
not be able to write `this.account` and become administratively or financially
associated with another customer. All ordinary property mutation paths must
reject changes to a principal's `account`; only provisioning, identity import,
and the explicit migration/administration pipeline may change it. The
`account.actors` cross-check is defense in depth, not permission to leave
`actor.account` authorable.

The same slice must therefore make the generic owner credential policy mean
**external owner**:

```text
wizard
OR
(target.owner == caller AND target.owner != target)
```

Apply that policy consistently to generic mint, list, and revoke operations.
Do not fix only mint: list and revoke are part of the same authority contract
and otherwise leave a partially privileged self-owned actor.

Human agent management must use a dedicated path:

1. authenticate the calling human;
2. resolve the human's account;
3. require the target agent's direct `account` to equal it and require the
   target to be present in the bounded `account.actors` roster;
4. enforce account state and the requested lifecycle policy; and
5. call the private credential-record primitive inside the authorized
   transaction.

The public `$system:create_api_key` surface remains wizard-only.
`$block:mint_apikey`, `:list_apikeys`, and `:revoke_apikey` must retain their
current behavior, proving that the external-owner rule was preserved rather
than removed.

The implementation should centralize the external-owner predicate and comment
why self-owned principals are excluded. Duplicated mint/list/revoke predicates
are likely to drift.

## 6. Normative specification changes

Specification work precedes source changes. At minimum, align these documents:

### 6.1 `spec/identity/provisioning.md`

- Define the concrete-player self-ownership invariant.
- Change `$agent.account` from an implied owner-chain fact to an explicit,
  immutable account binding for customer agents.
- Define principal `.account` as reserved identity state, writable only by
  provisioning, identity import, and explicit administrative migration.
- Make `account.actors` the bounded administrative roster and specify its
  consistency rule with `actor.account`.
- Rewrite quota, list, promote, demote, revoke, rotate, deactivation, orphan,
  and account-recycle rules in terms of the account binding.
- Define accountless infrastructure agents as self-owned,
  `created_via = "infra"`, and wizard-administered.
- Replace `assertOwnedAgent` terminology with account-bound administration.
- Revise `$system:provision_actor(class, owner, attrs)` so its second argument
  cannot be mistaken for the final object owner. Prefer an explicit
  administration/binding input or an options record over retaining a
  misleading parameter name.
- State that fresh provisioning writes the final self-owner lineage and
  account binding atomically.
- Specify the legacy dual-read and normalization rules in §8 below.

### 6.2 `spec/identity/auth.md`

- Resolve account deactivation from the authenticated actor's direct account
  binding, with the bounded legacy fallback only during migration.
- State that guest credentials remain session-scoped and a self-owned guest
  cannot use generic owner-key operations.
- Specify that customer-agent key rotation/revocation is account-administered,
  not object-owner-administered.

### 6.3 `spec/semantics/permissions.md`

- Preserve `canAuthorObject` as programmer-plus-owner, with wizard bypass.
- Explain that player self-ownership is object authority only and cannot grant
  its own programmer flag or attach a protected feature.
- Require ordinary authoring/property mutation to reject principal account
  binding changes.
- Document the external-owner credential rule as distinct from ordinary
  object control.

### 6.4 `spec/semantics/recycle.md`

- Confirm that the existing `$builder:@recycle` self-refusal remains.
- Confirm that live actors remain protected by RC6 even though they own
  themselves.
- State the account/wizard incident-response route for actor retirement and
  force recycle. It must not depend on the old human-owner edge.
- Add regression requirements for self-owned actors, including direct builtin
  behavior and wrapper behavior.

### 6.5 `spec/semantics/identity.md`

- Separate a guest actor's owner from reset maintenance authority.
- Remove or redefine `guest_template.owner`; a new elastic guest's final owner
  is its own allocated actor id.
- Keep `reset_definer`, `reset_verb`, and `maintenance_principal` as the
  explicit reset contract.
- Correct any stale statement that reset executes with `progr = this.owner`;
  Net already dispatches with the template's maintenance principal.

### 6.6 `spec/operations/audit.md`

- Derive customer attribution from the direct account binding first.
- Retain a bounded legacy owner-chain rule only for migration compatibility.
- Preserve `customer_of` as a reserved, materialized relation and never
  rewrite it through ordinary authoring.
- Attribute a fresh infrastructure agent to the operator only because the
  trusted wizard provisioning path materializes that reserved relation. Never
  infer operator attribution from self-authorable `created_via`.
- Update audit field descriptions so `owner` means object owner, not customer
  administrator.

### 6.7 `spec/protocol/coherence.md` and identity cutover docs

- Specify the actor-local lineage/account normalization transaction.
- Specify repair on credential admission and bounded family repair.
- Update identity export/import closure and verification rules for explicit
  account binding and self-owned imported principals.
- Make clear that owner normalization does not change an actor's immutable
  anchor.

## 7. Implementation plan

### 7.1 Introduce account-binding helpers

Add one substrate-level vocabulary for principal administration:

- `actorAccount(actor) -> account | null`, direct property first;
- a migration-only legacy fallback for an agent whose non-self owner is a
  human with an account;
- `assertAccountAdministersActor(human, actor)`;
- bounded roster validation/update against `account.actors`; and
- an explicit wizard path for accountless infrastructure agents.

The substrate must expose a narrow internal setter for principal account
binding, analogous to the reserved `customer_of` path. Catalog verbs, direct
property tools, installed bytecode, and generic authoring helpers cannot call
it.

Normal runtime code must not globally scan all actors to discover an account's
agents. Human and Hermes list/reconnect operations use `account.actors`.
Malformed, dangling, duplicated, or cross-account roster entries fail closed
or are repaired only by the specified migration path.

The direct property is authoritative after normalization. The roster is the
bounded administrative index. Updates that create, bind, unbind, or retire a
principal update both in one transaction.

### 7.2 Fresh player provisioning

Allocate the final actor id before creation, then create the concrete player
with `owner: id`. `createObject` already accepts an explicit id and does not
require the owner object to pre-exist, so no placeholder owner or second
lineage write is needed.

Provisioning must receive the account or administrative binding separately
from final object ownership. In outline:

```text
id = allocate_actor_id(kind)
account = validate_requested_binding(caller, kind, options)
anchor = derive_authority_family(account, human, kind)
create(id, parent=kind, owner=id, anchor=anchor)
write actor.account when applicable
append id to account.actors when applicable
write quota counters and initial actor properties
mint any initial credential through the dedicated authorized primitive
materialize customer_of
commit
```

The following fresh paths must use this invariant:

- seeded concrete guest pool;
- dynamically allocated local guests;
- elastic Net guests;
- fresh signup humans;
- guest-to-human promotion, preserving the already self-owned id;
- human- and Hermes-created agents;
- wizard-created customer agents; and
- wizard-created infrastructure agents.

Seed class objects stay `$wiz`-owned. `$block` creation stays creator-owned.

### 7.3 Account and human administration

Refactor agent create/list/promote/demote/revoke/rotate and reconnect lookup to
use direct account equality plus `account.actors`, never `agent.owner ==
human`.

Each operation must:

- accept an explicit target;
- remain bounded to one account roster;
- reject a target bound to another account even if a stale roster mentions it;
- reject a roster entry whose direct binding disagrees;
- preserve quota counters atomically with programmer-flag and feature changes;
- leave self-ownership unchanged during promotion/demotion; and
- allow `$wiz` to manage accountless infrastructure agents through the
  separate operator path.

Account deactivation must deny new authentication for every directly bound
actor and reap the specified sessions. Reactivation and account recycle follow
the revised provisioning contract without transferring object ownership.

### 7.4 Credential lifecycle

Split credential authorization from record mutation:

- private record mint/revoke primitives perform storage and session effects;
- generic owner surfaces apply the external-owner predicate;
- account-agent surfaces apply account administration;
- wizard surfaces apply wizard authority; and
- guest surfaces have no persistent-key route.

Keep credential records actor-local and non-enumerable across authorities.
Do not introduce a global key or actor scan to compensate for removing the
owner chain.

### 7.5 Guest creation and reset

For local guests, create each concrete guest with `owner = id`.

For Net elastic guests, `provisionGuestSubmit` must put `input.actor`, not
`template.owner`, in the created `object_lineage.owner`. Keep reset execution
under `template.maintenance_principal`.

Normalize existing guest-template rows conservatively:

- v2 rows retain reset definer, verb, and maintenance principal;
- the owner field is removed in a new version or treated only as legacy reset
  maintenance input, never as the new actor's final owner;
- malformed templates fail guest admission closed; and
- the bounded guest pool is normalized as part of bootstrap/claim repair.

The monolithic local `resetGuestOnDisconnect` directly resets guest state and
does not need owner authority. Verify it remains so.

### 7.6 Authoring, features, and recycling

Do not weaken `canAuthorObject`. The end-to-end self-authoring path requires
all of:

```text
actor == target.owner
actor.flags.programmer == true
the authoring surface is present and callable
normal verb/property version and permission checks pass
```

A self-owned ordinary guest, human, or agent still fails source installation.
A programmer agent can install on itself but not on another self-owned
principal.

A self-owned programmer also cannot change its reserved account binding
through source, generic property tools, or catalog wrappers.

Feature attachment remains separately policy-gated. Self-ownership must not
allow an actor to attach `$programmer`, because that feature is `$wiz`-owned
and its `can_be_attached_by` policy remains authoritative.

Keep the `$builder:@recycle` self-refusal. Exercise the substrate's live-actor
guard and the wizard incident-response path so self-ownership does not create
an accidental self-destruction surface. Deliberate raw-builtin semantics remain
whatever the updated recycle spec says; do not silently change RC2 while
landing this feature.

### 7.7 Audit attribution and identity transfer

Change attribution derivation order to:

1. direct `actor.account`;
2. migration-only legacy agent-owner-to-human-account;
3. a trusted provisioning/imported reserved operator binding; and
4. existing guest and other closed rules.

Materialize `customer_of` through the existing reserved identity pipeline.
Self-ownership must not create a `property_cell:<actor>:owner`; owner remains
part of `object_lineage`.

An accountless infrastructure agent cannot be re-derived as operator-owned
from `owner` after the rewrite, and `created_via` is not safe to trust as an
authority claim. Fresh wizard provisioning must materialize
`customer_of = operator` while it still holds the trusted administrative
context. Identity transfer must carry and verify that reserved attribution (or
an equally protected operator binding) so import does not lose it.

Identity export must carry the explicit account binding and include the
referenced account and bounded identity closure. It must no longer depend on a
human owner chain to discover an agent's account. Identity import must:

- accept and normalize the documented legacy shape;
- create imported player principals self-owned;
- verify account references and roster agreement;
- reject malformed or dangling bindings;
- remain idempotent; and
- materialize `customer_of` from the normalized binding.

### 7.8 Net lineage and placement

The programmer-environment work adds `mutateLineage`, which records a CAS read
and one deterministic `object_lineage` replacement. Net transcript apply
preserves Net-only lineage metadata while replacing parent, owner, name,
anchor, and flags. Use that seam for runtime owner normalization.

The same work places new human-owned agents in the human/account authority
family. Self-ownership does not imply self-hosting and must not change that
placement:

- `owner` answers object authority;
- `account` answers administration;
- `anchor` answers authority placement.

Changing an existing actor's owner from human or `$wiz` to itself does not
require re-anchoring. This is important: self-ownership can migrate independently
of the separate deferred problem of relocating already deployed legacy
authority families. Anchors remain immutable.

## 8. Migration and rolling cutover

### 8.1 Canonical and legacy shapes

Canonical customer agent:

```text
agent.owner = agent
agent.account = account
agent in account.actors
```

Canonical infrastructure agent:

```text
agent.owner = agent
agent.account absent
agent.created_via = "infra"
agent.customer_of = operator  # reserved identity-pipeline relation
wizard-administered
```

Legacy customer agent:

```text
agent.owner = human
human.account = account
agent.account absent or incomplete
```

During the rolling window, reads use the direct account first. Only when that
property is absent and the agent has a non-self human owner may the
migration-specific fallback derive `human.account`. New writes always produce
the canonical shape.

### 8.2 Local, in-memory, and SQLite

Add an idempotent bootstrap local-boot migration recorded in
`$system.applied_migrations`.

For each known concrete player principal in the local world:

1. classify the object as a provisioned player instance, not a seed class and
   not an arbitrary `$actor` descendant;
2. derive/validate the account binding from current explicit data or the
   legacy human owner;
3. repair `account.actors` and counters according to the specified consistency
   policy;
4. write the direct account binding where applicable;
5. rewrite the lineage owner to self; and
6. preserve `customer_of`, anchor, parent, name, flags, credentials, and all
   authored data.

Classification must use authoritative identity evidence, not a guess based
only on ancestry. Evidence includes the reserved seed id, the guest pool,
direct `actor.account` and bounded `account.actors` bindings, a credential or
session naming the exact actor, and the legacy built-in agent provisioning
shape. A historical custom `$player` descendant with no such evidence is
ambiguous: leave it unchanged and require an explicit operator repair record.
New provisioning always creates the canonical shape, so this ambiguity is
limited to legacy data.

Run the migration twice in tests and against a persisted local SQLite world.
The second run must produce no semantic changes.

### 8.3 Net

Net cannot enumerate millions of actors. Use three bounded repair points:

1. **Credential admission.** Before accepting a session for a legacy player
   principal, normalize that actor's direct account binding and lineage in its
   authority scope. Fail admission closed if repair cannot commit or validate.
2. **Account-family administration.** When a human/Hermes/admin operation
   loads `account.actors`, repair that bounded family before applying the
   requested operation.
3. **Guest claim.** Normalize a claimed pooled guest, and create new elastic
   guests canonically. Guest-pool traversal is bounded by the configured pool.

Legacy parked actors may remain dual-readable while unused, but no actor may
perform its next accepted action under an unvalidated ambiguous binding.

The owner lineage rewrite and direct account write must be one accepted
actor-scope transaction. A conflict replans against the latest lineage/account
version. Partial state such as `owner = self` with no resolvable customer
binding must not be served.

### 8.4 Failure and recovery rules

- Every repair is idempotent.
- A malformed or ambiguous binding fails closed with actionable diagnostics.
- No repair guesses across accounts.
- No global enumeration is introduced.
- A crash before commit leaves the old readable shape.
- A crash after commit leaves the canonical shape.
- Replaying the same repair is a no-op.
- Existing credentials remain bound to the same actor id.
- Existing `customer_of` is preserved unless the identity pipeline proves the
  canonical value differs under an explicit migration rule.
- Owner normalization never rewrites anchor.

## 9. Expected code areas

The implementation is likely to touch:

- `src/core/world.ts`
  - provisioning, account-agent authorization, key lifecycle, guest
    allocation, authoring/recycle tests, and lineage mutation;
- `src/core/bootstrap.ts`
  - concrete guest seeds, native contract comments, and local-boot migration;
- `src/core/attribution.ts`
  - direct-account-first derivation with bounded legacy fallback;
- `src/net/guest.ts`
  - elastic guest self-owner lineage;
- `src/net/identity.ts`
  - export/import closure, normalization, and verification;
- `src/net/sessions.ts` and `src/worker/net/gateway-do.ts`
  - pre-admission and bounded family normalization;
- the provisioning/auth/prog catalog surfaces that currently say "owned
  agent";
- relevant catalog design/user documentation; and
- the normative specs listed in §6.

Comments are required at the new account/owner boundary, the external-owner
credential predicate, and each bounded Net repair point. Those are places
where an apparently simpler owner check would reintroduce the bug.

## 10. Test plan

### 10.1 Fresh-state unit and integration tests

- Seeded and dynamic guests are self-owned.
- Fresh signup humans are self-owned and account-bound.
- Guest-to-human promotion remains self-owned.
- Human/Hermes-created agents are self-owned, directly account-bound, listed
  in `account.actors`, and anchored in the expected authority family.
- Infrastructure agents are self-owned, accountless, and wizard-administered.
- Infrastructure agents retain reserved operator attribution across identity
  export/import without trusting `created_via`.
- `$block` instances remain externally owned.

### 10.2 Authoring and capability tests

- A fresh programmer agent installs a property and verb directly on itself.
- It invokes the installed verb through the real MCP tool route.
- It repeats discovery and invocation after a cold gateway reconstruction.
- `dry_run`, `expected_version`, conflict, and no-mutation-on-failure behavior
  remain intact.
- A self-owned non-programmer cannot author itself.
- A programmer cannot author another self-owned principal.
- Demotion removes authoring access and triggers the expected stale-tool /
  `tools/list_changed` behavior.
- Existing installed verb persistence after demotion is specified and tested;
  demotion removes authoring authority, not historical object state.
- A self-owned principal cannot attach the protected `$programmer` feature
  merely because it owns itself.

### 10.3 Credential security tests

- A self-owned guest cannot mint, list, revoke, or rotate a persistent key.
- A self-owned human or agent cannot bypass the account-administered key path.
- The correct account human can create, list, rotate, force-rotate, and revoke
  its agent keys.
- Another account cannot do so, including with a stale forged roster entry.
- A deactivated account rejects agent authentication and reaps sessions as
  specified.
- A wizard can manage an accountless infrastructure agent.
- A `$block` owner can still mint, list, and revoke plug credentials; the plug
  authenticates as the block.
- Credential records remain actor-local and secrets remain one-time output.

### 10.4 Guest and recycle tests

- Guest disconnect reset clears the documented state and returns the seat to
  the pool despite self-ownership.
- Net reset runs as `maintenance_principal`, not as the guest or its owner.
- Malformed guest templates fail closed.
- A live self-owned actor cannot be recycled through the ordinary user
  surface.
- `$builder:@recycle` still refuses self.
- Wizard force-recycle/incident response retains the documented behavior.

### 10.5 Migration tests

- Old `$wiz`-owned guest and human rows normalize correctly.
- Old human-owned agents gain direct account binding and self-owner lineage.
- Existing explicit account binding wins over legacy inference.
- Cross-account, dangling, duplicate, and ambiguous shapes fail closed.
- Migration preserves anchor, parent, name, flags, verbs, properties,
  credentials, location, and `customer_of`.
- Owner is written in `object_lineage`; no phantom
  `property_cell:<actor>:owner` appears.
- Local-boot migration is idempotent in memory and in persisted SQLite.
- Actor-scope Net repair is atomic, retries on lineage conflict, and is
  idempotent.
- Account-family and guest-pool repairs are bounded and make no global scan.
- Old- and new-shape identity exports import correctly; malformed and dangling
  exports are rejected.

### 10.6 Validation ladder

Run targeted files first, then:

1. `npm test`;
2. `npm run typecheck`;
3. `npm run test:worker` for the Worker/DO and MCP shapes;
4. `npm run smoke:net-dev`;
5. `npm run smoke:net-mcp`; and
6. `npm run test:full` before a broad merge if targeted coverage does not
   already exercise the affected corpus.

The shared MCP walkthrough should contain the fresh provisioned
self-authoring scenario; do not create a lane-specific copy. Cloudflare
deployment smoke remains a separate, explicitly authorized step and is not
part of this plan's local implementation handoff.

## 11. Delivery sequence

1. Make the §6 specs explicit and mutually consistent.
2. Land or rebase onto the programmer-environment lineage and placement work.
3. Add account-binding helpers and the external-owner credential predicate
   with security tests.
4. Change fresh provisioning and guest creation to canonical self-ownership.
5. Refactor account/Hermes/admin lifecycle operations away from `agent.owner`.
6. Update attribution and identity export/import.
7. Add local-boot, Net admission, bounded family, and guest-pool normalization.
8. Add the full self-authoring, cold-reconnect, demotion, credential, block,
   guest-reset, recycle, migration, and failure-atomicity proofs.
9. Align catalog design docs, operator docs, and user docs.
10. Run the validation ladder and review for security, performance,
    consistency, and correctness.

Each major implementation task belongs in the isolated worktree and should be
committed there with motivation and behavioral effects. Do not merge to main
or deploy without explicit instruction.

## 12. Exit criteria

The slice is ready only when all of the following are true:

- the specs define self-ownership and no longer assign account administration
  to `agent.owner`;
- every fresh concrete player principal owns itself;
- every accepted legacy principal is canonical or has been atomically
  normalized;
- no unbounded actor discovery is used;
- owner-based plug credentials still work while self-owned principals cannot
  mint durable credentials through that path;
- account quota, lifecycle, deactivation, audit, and identity transfer are
  correct under the new shape;
- `canAuthorObject` is unchanged and a fresh programmer agent authors and
  invokes a verb on itself over MCP after cold reconstruction;
- demotion and feature policy remain independent of ownership;
- guest reset and actor recycle protections remain correct;
- migration is idempotent in local SQLite and Net-shaped tests; and
- the prescribed local and real-workerd gates are green.

## 13. Explicitly out of scope

- the Feature Warehouse or another capability-discovery catalog;
- general self-service feature attachment;
- the L1.1 MCP instruction rewrite, which should land after this invariant is
  true;
- a blanket rewrite of arbitrary `$actor` descendants;
- anchor relocation of already deployed authority families;
- a new global controller relation or actor registry;
- unrelated account or billing redesign; and
- deployment.

There is no remaining architectural blocker inside this boundary. The work is
not a one-line owner change, but the existing object model, account roster,
reserved attribution relation, identity pipeline, guest maintenance
principal, and programmer-worktree lineage seam are sufficient to implement it
without a new distributed primitive.
