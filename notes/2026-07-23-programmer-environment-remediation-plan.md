# Programmer environment and MCP remediation plan

Date: 2026-07-23
Status: design note for review; not normative and not implemented

## 1. Decision

Woo already has most of a credible live-programming environment: structured
builder and programmer verbs, source diagnostics, optimistic version checks,
atomic source installation, eval, an editor room, and generic MCP discovery.
The pieces are not assembled into a correct provisioned-agent experience.

The blocking contradiction is simple:

- actor ancestry defines identity kind (`$human`, `$agent`, `$guest`);
- the current prog catalog also requires authoring actors to descend from
  `$builder` or `$programmer`; and
- Woo has single inheritance.

Reparenting an `$agent` to `$programmer` makes the tools visible by destroying
the ancestry that says it is an agent. This contradicts the provisioning spec,
which deliberately makes kind and programmer authority orthogonal.

The remediation is to use the composition mechanism Woo already has:

1. Keep each actor under its kind class for its entire life.
2. Attach `$builder` or `$programmer` as an actor feature to expose the
   corresponding authoring surface.
3. Keep `programmer` and `wizard` flags as the hard source-authoring authority
   facts.
4. Keep ownership, verb/property permissions, and explicit resource grants as
   independent operation-level checks.
5. Let the existing generic MCP resolver discover the attached feature verbs
   on the actor. Add no programmer vocabulary to the gateway.

`$programmer` already inherits `$builder`, so one `$programmer` attachment
provides both surfaces. The same objects remain usable as legacy player
classes. A class object is a persistent object and the feature contract does
not require a separate feature-only type; dual use avoids a second copy of
every wrapper verb.

The target shape is:

```text
actor kind:       agent_42 isa $agent isa $player
actor features:   [$programmer]
actor flags:      {programmer: true}
actor owner:      human_7

MCP actor tools:  agent_42:inspect
                  agent_42:create
                  agent_42:install_verb
                  agent_42:eval
                  ...
```

This is the smallest design that aligns identity, permissions, features, and
MCP without introducing a second authoring API.

## 2. What “fit for purpose” means

A programmer environment is ready when a freshly provisioned agent can, using
only its MCP connection:

1. discover its authoring tools;
2. inspect a bounded working context;
3. create an ordinary actor-owned object;
4. define data and install a verb from source;
5. compile without mutation, then install with an expected version;
6. invoke the new behavior through its real route;
7. see the result, observations, diagnostics, and authoritative state;
8. reconnect through a cold gateway and continue from durable state; and
9. lose authoring access immediately and completely when demoted.

“Fit for purpose” does not mean that a programmer can edit any object from any
host, install global catalogs, allocate unbounded infrastructure, or execute a
repository checkout inside the Woo VM. Those are separate authority and
resource boundaries.

The first release is agent-first and MCP-complete. The browser IDE should render
the same object, editor-session, and diagnostic contracts; it must not grow a
second authoring backend.

## 3. Four independent axes

The implementation and documentation must stop using “programmer” to mean four
different things.

| Axis | Representation | Question answered |
|---|---|---|
| Identity kind | `$human` / `$agent` / `$guest` ancestry | What kind of principal is this? |
| Visible surface | attached `$builder` / `$programmer` feature | Which authoring verbs compose onto this actor? |
| Dangerous authority | `programmer` / `wizard` flag, ownership, perms | May this actor perform this mutation? |
| Resource grant | explicit quota/capability record | May this actor allocate a host, credential, or other scarce resource? |

No axis implies another:

- a feature without the programmer flag may be visible but source mutations
  refuse;
- a programmer flag without the feature does not create an MCP surface;
- a programmer with both still cannot edit foreign-owned code;
- programmer authority does not grant self-host allocation or catalog install;
- being an `$agent` says nothing about authoring authority.

The separation is useful defense in depth, not ceremony. An official promotion
must commit all of its state or none of it, and a stale MCP descriptor must
still fail at the authoritative operation.

## 4. Surface composition

### 4.1 Reuse the existing surface objects

The compact object graph is:

```text
$player
  └─ $builder
       └─ $programmer

$agent.features = [$programmer]   # composition, not isa()
```

Feature lookup walks `$programmer -> $builder -> $player`. Parent-chain lookup
on the actor still wins, so ordinary `$agent` behavior is not shadowed by a
feature page. Within the feature chain, programmer overrides of `inspect` and
`search` win over their builder definitions exactly as they do for legacy
`$programmer` descendants.

Creating `$builder_tools` and `$programmer_tools` copies would make the naming
more literal but would force duplicated implementations or a new delegation
layer. Gateway projection from flags would be worse: it would make generic
transport code know a bundled catalog. Reusing the current objects is both
legal under the feature contract and smaller.

If implementation proves that a class object cannot participate safely in
catalog lifecycle or feature invalidation, that is the falsifier for this
decision. Only then should dedicated feature objects be introduced.

### 4.2 Invocation is actor-self scoped

An authoring surface verb is invoked on the actor that is doing the work:

```text
agent_42:install_verb(target, descriptor, source, opts)
```

Every public builder/programmer wrapper must establish:

1. `this == actor`; the surface is not a proxy for another principal;
2. the resolved surface is present through ancestry or the actor's feature
   chain;
3. programmer operations require `programmer` or `wizard`;
4. the affected object and member pass the normal owner/perms checks; and
5. before caller-controlled work, effective task permissions are reduced to
   `actor`.

The last step matters because catalog-installed verbs are currently owned by
`$wiz`. A correct actor check followed by execution as `$wiz` leaves every
later primitive one missed check away from escalation. After the surface check,
`set_task_perms(actor)` makes substrate permission checks enforce the same
principal the wrapper claims to represent.

The native helpers that currently accept a `surfaceClass` must recognize a
surface resolved through an attached feature as well as ancestry. That check
must remain generic over the supplied definer/feature chain; core must not gain
`$programmer` or `$builder` special cases.

### 4.3 Attachment is not self-service

Ordinary `:add_feature` must not become a way around programmer quota. The
surface objects remain `$wiz`-owned and retain a restrictive
`:can_be_attached_by` policy. Canonical attachment occurs only inside the
provisioning/authority operation that is already allowed to set the flag.

An owner may still remove an attached surface under the generic feature rules.
That is a safe disable, not a programmer demotion: it removes reachability but
does not clear the flag or free quota. The dedicated demotion verb is the only
normal operation that changes surface, flag, quota counter, and audit
observation together. Provisioning may reattach a deliberately removed surface
only through an explicit promote/repair operation; session startup must not
silently reverse the owner's removal.

## 5. Provisioning and migration

### 5.1 Atomic lifecycle

The provisioning operations become:

```text
create_agent(..., programmer=true):
  create actor under $agent
  attach $programmer
  set programmer flag
  increment programmer_agent_count
  mint credential
  commit all or none

promote_agent_to_programmer(actor):
  verify ownership and quota
  attach $programmer
  set programmer flag
  increment count
  commit all or none

demote_agent_from_programmer(actor):
  remove $programmer
  clear programmer flag
  decrement count
  invalidate authoring discovery
  commit all or none
```

Demotion removes the programmer surface. It does not remove a separately
granted `$builder` feature. If the only builder access came through
`$programmer`'s feature chain, both surfaces disappear together.

The implementation must test failure after each individual mutation. No
official create/promote/demote call may commit a partial transition or an
incorrect quota count. The generic owner-driven feature removal above is the
one intentional flag-without-surface state; it is non-escalating and does not
pretend to free programmer quota.

### 5.2 Existing actors

There must be no global actor scan. New promotions use the correct shape
immediately. Existing programmer actors are repaired per authoritative actor
scope by an idempotent migration:

- preserve `$human` / `$agent` / custom actor kind when it is known;
- attach the matching authoring surface;
- preserve the existing programmer flag;
- reparent only when a recorded, unambiguous prior kind exists; and
- leave ambiguous legacy custom descendants on the compatibility class path
  until an operator chooses their kind.

The live catalog-update pipeline must be able to run this repair in durable
actor scopes. Gateway `E_STALE_EPOCH` healing is insufficient: it repairs
derived closure state, not durable scope state. The migration design therefore
depends on an explicit epoch-transition protocol for authoritative scopes,
including idempotent per-scope work, partial failure, retry, and mixed-epoch
traffic rules.

## 6. MCP contract

No new stable MCP control is required.

The actor is always in structural context. The Net resolver already walks an
object's parent and explicit feature chains, filters `tool_exposed` bytecode
verbs, derives input schemas, and uses the same reachability decision for named
tools and `woo_call`. With `$programmer` attached, a normal list contains tools
such as:

```text
agent_42__inspect
agent_42__create
agent_42__install_verb
agent_42__eval
```

Required behavior:

- `tools/list` and `woo_list_reachable_tools` return the same authoring pages;
- dynamic-name invocation and `woo_call(agent_42, ...)` reach the same verb;
- attaching, removing, promoting, or demoting emits
  `notifications/tools/list_changed` for the affected live MCP session;
- a stale descriptor cannot bypass demotion;
- a cold gateway reconstructs the actor feature chain and descriptors;
- no tool is advertised solely because the programmer flag is present;
- no gateway branch names the prog catalog, `$builder`, or `$programmer`.

The current Net restriction to bytecode-backed dynamic pages is compatible with
this design because the public prog wrappers are woocode. Native provisioning
verbs are a separate account/administration surface; they need not be projected
as programmer tools.

## 7. Authoring workspace boundary

The first supported workspace is the actor's authority-local object graph, not
the entire world.

Builder creation, property-definition mutation, verb installation, and editor
save are atomic only when their target state is co-resident with the executing
authority scope. Cross-host authoring should continue to refuse explicitly
with `E_CROSS_HOST_WRITE` until a domain operation owns a distributed
transaction or migration.

The MCP proof must establish one normal creation path that places programmer
objects in the actor's durable cluster and keeps subsequent edits local.
`inspect` and `search` must be bounded to that structural/owned context; an
`all` option may never imply global enumeration on Net.

Repository content is a different plane. Source trees, diffs, tests, and large
files belong in a repository workspace/connector and execution sandbox. Woo
stores bounded coordination state and immutable references. The programmer
surface may create or update Woo behavior from explicit source input, but it
must not turn the object graph into a Git checkout.

## 8. Security and correctness invariants

The remediation is not complete unless adversarial tests prove:

1. A programmer-flagged `$agent` remains `isa($agent)` and is not
   `isa($programmer)`.
2. The attached surface is sufficient for legitimate builder and programmer
   calls.
3. Surface without flag refuses every source/schema mutation.
4. Flag without surface produces no authoring tool and no callable escape.
5. Direct calls to `$builder` or `$programmer` as target cannot use them as a
   proxy.
6. A participant cannot attach the programmer surface through ordinary
   `add_feature`.
7. Every created object, verb, and property definition is attributed to the
   invoking actor, never `$wiz` or the catalog installer.
8. A crafted wrapper call cannot retain `$wiz` task permissions after the
   actor check.
9. Version conflict, compile failure, runtime failure, and editor-save failure
   leave target state unchanged.
10. Promotion and demotion are atomic across feature, flag, quota, audit, and
    Net cells.
11. Demotion invalidates live discovery and authoritative calls, including a
    call submitted from stale metadata.
12. A cold gateway cannot resurrect a removed authoring feature.

## 9. Fit-for-purpose proof

One workerd scenario should use a fresh account and agent, not a hand-edited
fixture:

1. Provision `agent_42` with programmer authority and an API key.
2. Authenticate a Net MCP session and assert its actor remains an `$agent`.
3. List tools and find the builder/programmer surface on `agent_42`.
4. Create an owned fertile base and a child object.
5. Define one property with a private value.
6. Dry-run a verb install and inspect structured diagnostics.
7. Install the verb with `expected_version`.
8. Invoke it through the intended direct or sequenced route.
9. Observe the result and verify the durable state through `inspect`.
10. Attempt an install with the stale version and prove no mutation.
11. Disconnect, force a cold gateway/scope path, reconnect, and inspect/call
    the same object.
12. Demote the agent, receive `tools/list_changed`, re-list, and prove both
    discovery and stale invocation refuse.

Run the same semantic scenario in-memory and against local SQLite. The workerd
lane is the release proof because it exercises serialized cells, scope routing,
cold closure reconstruction, and MCP discovery. A deployed canary is the final
operational proof, not the first correctness test.

## 10. Implementation sequence

### Phase A — make the contract explicit

- Amend identity/provisioning: kind stays in ancestry; authoring surface is a
  feature; promotion/demotion mutate both atomically.
- Amend features: explicitly permit a persistent class object to serve as a
  feature and document the dual-use pattern.
- Amend permissions: public authoring wrappers reduce task permissions to the
  actor before caller-controlled work.
- Amend MCP: add the provisioned-programmer acceptance case; retain generic
  feature discovery.
- Align the prog catalog design and user docs; remove reparenting as the
  canonical promotion instruction.

Exit: the spec makes the implementation choice unavoidable.

### Phase B — compose the surface

- Make prog wrapper guards accept actor-self invocation resolved through the
  attached surface.
- Extend the generic substrate surface assertion to feature-chain resolution.
- Drop effective permissions to the actor in all public builder/programmer
  wrappers, including chat commands and editor entry.
- Update AP6 create/promote/demote to attach/remove `$programmer` atomically.
- Add in-memory adversarial and rollback tests.

Exit: a feature-composed `$agent` completes the authoring loop without
reparenting and without `$wiz` attribution.

### Phase C — prove Net MCP

- Add a targeted Net MCP programmer test using production session,
  reachability, and sequenced/direct routing.
- Prove feature-cell fanout and `tools/list_changed` on promote/demote.
- Prove cold gateway reconstruction and stale-call refusal.
- Remove or constrain any `scope="all"` implementation that enumerates only a
  misleading local closure.

Exit: the workerd scenario in §9 is green and repeatable.

### Phase D — close operational prerequisites

- Replace the global `$system.api_keys` map with a Big-World credential
  design. The gateway must route a presented random key to an exact
  authoritative record without global enumeration; use a self-routing opaque
  shard hint or a hash-sharded credential directory. Actor/block cluster state
  remains authoritative, and lookup rows are derived.
- Complete the live catalog epoch-transition/migration pipeline before using
  it to update deployed prog actors.
- Provide the explicit resource grant and quota path for programmer-authored
  self-hosted block deployment. Programmer authority alone must not allocate a
  host.

Exit: a normal operator can provision, rotate/revoke, migrate, and audit
programmer agents without editing global maps or bypassing Net authority.

### Phase E — document and bake

- Update agent onboarding with the exact MCP loop and a minimal source example.
- Update human docs to show feature-based promotion and the same editor
  contracts.
- Mark `trace` honestly as unavailable or implement it; do not list it as a
  usable v1 tool while it always returns `E_NOT_IMPLEMENTED`.
- Bake create/edit/call/reconnect/demote under two concurrent programmer
  sessions and record latency, envelope size, and repair behavior.

Exit: the documented path is the tested path.

## 11. Release gates

The programmer environment is not ready to claim until:

- a fresh programmer agent completes §9 on workerd;
- no step reparents the actor out of `$agent`;
- all authoring state is attributed to the agent;
- promotion/demotion atomicity and stale-call refusal are adversarially tested;
- the MCP gateway remains catalog-agnostic;
- cold recovery preserves both tools and authored objects;
- authoring searches and lists are bounded;
- API-key issuance/revocation no longer depends on one global mutable map;
- deployed catalog migration has a durable-scope epoch transition, not only
  gateway cache healing; and
- user documentation contains no class-reparent promotion path as the normal
  workflow.

## 12. Deliberate deferrals

These are useful but do not block the first fit-for-purpose MCP loop:

- source-span tracing across the next N calls;
- real-time shared text buffers;
- arbitrary cross-host object editing;
- repository browsing or execution inside Woo;
- non-wizard global catalog installation;
- a full browser IDE beyond the same inspect/edit/call contracts; and
- generic fine-grained capability tokens.

Deferral is acceptable only when the surface says so plainly. A tool that is
advertised and deterministically returns `E_NOT_IMPLEMENTED` should either be
implemented or removed from the release surface.
