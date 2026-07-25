# Programmer-authored block factory and deploy plan

Date: 2026-07-23
Status: design note for discussion; not normative and not implemented

## 1. Summary

Normal in-world programmers should be able to:

1. create an editable description of a block,
2. define its properties, verbs, and plug/owner write policy,
3. validate it without allocating infrastructure,
4. deploy an instance into a room under an explicit host-resource grant,
5. mint a block-bound credential, and
6. run the plug from Cloudflare, a private service, a laptop, or any other
   network-reachable runtime.

The recommended model separates the editable artifact from the allocated
runtime object:

- A **`$block_blueprint`** is an ordinary co-resident, programmer-owned
  object. It is safe to edit with the existing builder/programmer tools.
- Each blueprint inherits a **self-factory `:deploy` verb**. There is no
  global factory singleton.
- Deployment validates and snapshots the blueprint into a new self-hosted
  `$block` instance. The deployed object is no longer an editing surface.
- Self-host allocation is checked against the original `actor`, not the
  effective `progr`, and is separately granted and quota-bounded.
- Initial placement is part of deployment. A self-hosted root has
  `anchor = null` even when its `location` is a room.
- Credential minting remains a separate owner operation so plaintext
  secrets never enter deployment acts, receipts, or prototype state.

This retains the useful MOO distinction between programming an object and
operating an installed object, while making the infrastructure boundary
explicit.

## 2. Why the current shape is insufficient

The existing catalog path successfully creates bundled blocks, but it does
not generalize to ordinary in-world programmers.

### 2.1 `$block` is not an authoring parent

`$block` is non-fertile. A normal builder cannot create a direct child and
turn it into a reusable class. Making `$block` fertile alone would be
unsafe: every child inherits `instances_self_host = true`, so ordinary
`create` would allocate a host before the programmer had defined the
object's properties or verbs.

### 2.2 Tier lists are manifest data

`writable_owner` and `writable_self` are inherited read-only properties.
Catalog installation can set subclass defaults, but an ordinary
programmer cannot replace an inherited property definition or mutate its
wizard-owned read-only value. The current “subclassing” convention is
therefore a catalog-authoring convention, not a live-object workflow.

### 2.3 Authoring after allocation is the wrong order

A self-hosted instance routes away from the programmer's current host.
Property-definition changes explicitly refuse remote targets because the
mutation is not atomic. Some verb-editing paths also assume local object
authority. Even if every remote editor operation were implemented,
allocating a production host before the type is coherent would be an
unhelpful lifecycle.

### 2.4 Initial placement is neither anchoring nor ordinary movement

Builder creation derives `anchor` from a space-valued initial location.
Self-hosted objects cannot be anchored. Creating the block unplaced and
then calling its normal movement path also fails because `$block:moveto`
intentionally denies non-wizard relocation.

The desired invariant is valid but needs a distinct operation:

```
host_placement = "self"
anchor = null
location = requested_room
```

“Fixed after installation” must not mean “an owner cannot perform the
initial installation.”

### 2.5 The resource grant promised by the spec does not exist

`spec/semantics/objects.md` says self-hosting creation requires wizard
authority or an explicit programmer capability. Current creation checks
do not test self-hosting, while `spec/semantics/permissions.md` says the
v1 privilege gradient has no fine-grained capability tokens.

This produces both failures at once:

- there is no supported delegated deployment authority, and
- a fertile self-hosting concrete class can let a builder reserve hosts
  without the gate the spec promises.

### 2.6 Catalog installation is intentionally broader

A catalog installs shared classes, schemas, UI, and executable code into a
world. Keeping runtime install/update wizard-only is a reasonable global
trust boundary. Requiring catalog installation for every personal or
room-local integration is not.

The blueprint path must coexist with catalogs, not weaken catalog install
authority.

## 3. Goals

- Let an ordinary actor with builder and programmer authority author a
  block blueprint using normal in-world tools.
- Let a separately authorized actor deploy a bounded number of
  self-hosted instances without wizard intervention per instance.
- Keep the substrate catalog-agnostic and client-agnostic.
- Preserve the current `$block` actor/apikey model.
- Preserve programmer attribution: user code must execute under its
  programmer owner, never under the factory's or `$wiz` authority.
- Work in in-memory, local SQLite, workerd, and global Cloudflare profiles.
- Avoid global enumeration and a global deployment singleton.
- Make retry, crash recovery, revocation, recycle, and quota accounting
  explicit.
- Keep externally authoritative current values separate from Woo-owned
  acts and projections.
- Leave existing catalog-defined block classes and instances working.

## 4. Non-goals

- Allowing non-wizards to install arbitrary global catalogs.
- Hosting the external plug inside Woo.
- Requiring Cloudflare for block deployment.
- Real-time collaborative source editing.
- Transparently changing running instances whenever a blueprint is edited.
- Turning raw external events or every property push into acts.
- A general package registry or marketplace for blueprints in the first
  implementation.
- Cross-world deployment or federation.

## 5. Terminology and lifecycle

### 5.1 Blueprint

A `$block_blueprint` is an ordinary object used as editable source. It is:

- owned by its programmer,
- co-resident on the host where it was created,
- not a `$block` and not an actor,
- not self-hosted,
- not placed in a public room by default,
- safe to modify through `$programmer`, and
- explicit about which of its own definitions are exported.

Suggested states:

```
draft -> valid
  ^       |
  |       v
  +---- dirty
```

Any exported property/verb or policy change increments
`blueprint_revision` and returns the blueprint to `dirty`. `:validate`
records the validated revision and content hash but does not allocate a
host.

### 5.2 Deployment

A deployment is an immutable snapshot of one validated blueprint revision
materialized as one self-hosted block instance.

Suggested states:

```
requested -> provisioning -> active -> retired
                    |
                    v
                  failed
```

The active block records:

- `blueprint`
- `blueprint_revision`
- `blueprint_hash`
- `deployed_by`
- `deployed_at`
- `deployment_id`

Blueprint edits affect future deployments only. Upgrade is an explicit
operation with its own validation and migration policy.

### 5.3 Plug

The plug is still an external authenticated client. Its location and
runtime are not part of the deployment record. The only Woo-side binding
is the apikey's actor, which is the deployed block.

## 6. Proposed object surface

### 6.1 `$block_blueprint`

The initial catalog class should descend from an ordinary authorable class,
not `$block`. `$thing` is sufficient unless a smaller programming-only base
is introduced.

Proposed intrinsic properties:

| Property | Purpose |
|---|---|
| `deployment_parent` | Allowed `$block`-derived runtime parent; defaults to `$block`. |
| `exported_properties` | Explicit ordered list of own property names copied to a deployment. |
| `exported_verbs` | Explicit ordered list of own verb slots/names copied to a deployment. |
| `field_policy` | Map from exported property name to `owner`, `plug`, or `restricted`. |
| `blueprint_revision` | Monotonic edit revision. |
| `validated_revision` | Revision most recently validated, or null. |
| `validated_hash` | Canonical hash of the validated export bundle. |
| `deployment_records` | Bounded recent receipt refs/ids; not a global instance index. |

These intrinsic properties are managed through owner-checked verbs rather
than direct writable inherited slots.

Proposed verbs:

| Verb | Purpose |
|---|---|
| `:declare_field(name, default, info, tier)` | Add an owned property definition and export policy together. |
| `:export_property(name, tier)` | Export an existing own property definition. |
| `:export_verb(descriptor)` | Mark an existing own programmer-owned verb for copying. |
| `:unexport(name_or_descriptor)` | Remove from the export bundle without deleting source. |
| `:validate()` | Pure/dry-run validation and canonical bundle hash. |
| `:deployment_plan(room, options)` | Explain placement, resource, authority, and size consequences without mutation. |
| `:deploy(room, options)` | Resource-gated self-factory operation. |
| `:recent_deployments(limit?)` | Bounded owner-visible receipts. |

The ordinary programmer surface remains available for source editing.
Blueprint verbs only define the export boundary and deployment metadata.

### 6.2 Explicit exports

The factory must not copy “everything on the object.” Explicit export sets
prevent accidental leakage of:

- authoring helpers,
- private scratch properties,
- deployment metadata,
- inherited tool verbs,
- readable but foreign-owned code, and
- future intrinsic properties added by the blueprint catalog.

Validation resolves each export to an own definition and refuses inherited
or missing slots.

### 6.3 Runtime write policy

For compatibility, the deployed object may materialize
`writable_owner`/`writable_self` local values from `field_policy`.
Longer-term, `$block:is_writable_by_property` should consult a single
canonical `block_field_policy` map and use the legacy lists as a catalog
compatibility projection.

The first implementation should avoid maintaining three independent
authorities. Pick one canonical representation and derive the others.

Recommended canonical entry:

```json
{
  "query": {"writer": "owner", "type": "str"},
  "result": {"writer": "plug", "type": "any"},
  "internal_cursor": {"writer": "restricted", "type": "int"}
}
```

## 7. Deployment contract

Proposed call:

```text
blueprint:deploy(room, {
  idempotency_key,
  name?,
  description?,
  aliases?
})
```

The caller does not choose:

- object owner (always the deploying actor),
- verb owners,
- `host_placement`,
- anchor,
- arbitrary runtime parent, or
- an apikey secret.

Successful result:

```json
{
  "ok": true,
  "deployment_id": "dep_...",
  "block": "obj_...",
  "blueprint": "obj_...",
  "blueprint_revision": 7,
  "blueprint_hash": "sha256:...",
  "owner": "obj_actor_...",
  "location": "the_room",
  "host_placement": "self",
  "anchor": null,
  "state": "active"
}
```

No credential is returned. The owner calls
`block:mint_apikey(label)` after activation.

### 7.1 Validation order

Deployment must fail before resource allocation unless every precondition
passes:

1. Caller owns the blueprint or is wizard.
2. Caller has programmer authority for exported executable code.
3. Blueprint revision equals `validated_revision`.
4. Canonical bundle still hashes to `validated_hash`.
5. Runtime parent is `$block`-derived and on the allowlist.
6. Every property export is an own definition owned by the caller.
7. Every verb export is bytecode, is owned by the caller, compiles, and has
   accepted metadata.
8. Reserved runtime property/verb names are absent.
9. Count and byte-size limits pass.
10. Target room exists, is reachable, and permits initial installation.
11. Actor has self-host deployment authority and remaining quota.
12. `idempotency_key` is present and either new or matches the same plan.

The returned dry-run plan should identify the failed step and remediation.

### 7.2 Snapshot authority

Copied property definitions retain their declared programmer owner.
Copied verbs retain their original programmer owner and therefore their
future `progr`.

The materializer must reject:

- a non-wizard copying a verb owned by someone else,
- native verb definitions,
- a claimed `$wiz` owner,
- a source/bytecode mismatch,
- hidden direct-call exposure not present in the validated bundle, and
- any definition changed after validation.

A wizard-owned factory body may perform the mechanical write only as a
deliberate capability. It must not become the owner of copied code.

## 8. Resource authority and quota

### 8.1 Immediate spec correction

Before exposing deployment, align implementation and spec:

- all generic creation paths must recognize resolved
  `instances_self_host = true`,
- they must gate host allocation on the original `actor`,
- effective `progr` must not launder the privilege through a public
  wizard-owned verb, and
- ordinary fertile-parent authority must remain insufficient.

### 8.2 Proposed first grant

The smallest useful v1 grant is an administrative actor flag plus bounded
actor-local quota:

- `host_deployer` flag
- `self_host_limit`
- bounded `self_host_deployments` receipt map/projection

This is less expressive than general capability tokens but makes the
promised privilege concrete. It is generic host-allocation authority, not
block-specific substrate knowledge.

The deployment request should execute from the actor/blueprint host so
quota reservation and the idempotency receipt are one local transaction.
Activation of the new host follows as a recoverable effect.

Future capability objects may add scoped grants by class root, room,
expiry, or issuer without changing the deployment API.

### 8.3 Big-world accounting

Do not count deployments by enumerating all objects or all block hosts.
The actor-local receipt projection is the bounded authority:

- reserve a slot before allocating,
- bind it to `deployment_id`,
- mark it active after placement,
- mark it released after retirement,
- reconcile stuck `provisioning` records by id,
- compact retired receipts while retaining audit facts elsewhere.

Recycle notification is asynchronous. A missing release cannot grant
extra quota; at worst it temporarily consumes quota until reconciliation.

## 9. Generic substrate and catalog layering

The substrate must not gain `$block` knowledge.

The catalog owns:

- blueprint verbs and validation policy,
- field-tier vocabulary,
- allowed block parents,
- block deployment observations/acts,
- user-facing errors and tools.

The substrate/host layer may provide generic primitives for:

- detecting self-host placement resolved from a parent,
- checking generic self-host allocation authority,
- allocating an object id and logical host,
- materializing a validated owned-object snapshot,
- publishing an immutable Directory route,
- initial location and container-cache effects,
- idempotent activation and cleanup.

A likely generic operation is conceptually:

```text
materialize_hosted_object({
  actor,
  parent,
  owner,
  initial_location,
  anchor: null,
  property_definitions,
  verb_definitions,
  initial_values,
  idempotency_key,
  provenance
})
```

Its name and wire shape are implementation questions. It must validate
generic ownership and placement invariants; `$block_blueprint:deploy`
constructs the snapshot and interprets its result.

## 10. Initial placement and activation

Deployment spans at least three authorities:

1. actor/blueprint host for quota and receipt,
2. new block host for the authoritative object row, and
3. room host for the derived `contents` cache.

The block's own `location` is authoritative. Room `contents` is a cache.
Activation should therefore proceed:

1. reserve quota and deployment id,
2. initialize the new self-host with `location = requested_room`,
   `anchor = null`, and state `provisioning`,
3. publish the immutable Directory route,
4. update the room's contents cache through the existing cross-host move
   effect,
5. mark the block and receipt `active`,
6. emit the deployment fact/observation.

If step 4 fails, the block remains discoverable by id in `provisioning`;
retry repairs the room cache and completes the same deployment. It must not
allocate another block.

The target room's acceptance/installation policy still runs. Deployment
gets a distinct initial-placement path; it does not silently bypass room
policy or reuse the block's post-installation `:moveto` denial.

## 11. Idempotency and failure recovery

`idempotency_key` is mandatory. The stable domain key is scoped to actor
plus blueprint, not merely to one transport session.

The receipt stores:

- request hash,
- deployment id,
- reserved object id,
- blueprint hash,
- target room,
- lifecycle state,
- last error,
- timestamps.

Retries behave as follows:

| Existing receipt | Retry result |
|---|---|
| Same key, same request, active | Return the original block and receipt. |
| Same key, same request, provisioning | Resume repair/activation. |
| Same key, same request, failed-retryable | Resume from the recorded phase. |
| Same key, different request hash | `E_IDEMPOTENCY_CONFLICT`. |
| No receipt | Validate and reserve a new deployment. |

Do not include an apikey secret in the receipt. Net replay can safely
return the deployment result because it contains no secret.

## 12. Acts and projections

The deployment lifecycle is Woo-owned coordination state and is suitable
for typed acts:

- `block.deployment_requested`
- `block.deployment_activated`
- `block.deployment_failed`
- `block.deployment_retired`

These facts identify blueprint, revision, block, room, actor, and error
class. They never contain:

- apikey secrets,
- external API secrets,
- arbitrary source text,
- high-frequency property payloads.

The actor-local quota/receipt view is a bounded single-writer projection.
Externally authoritative block values continue to live as block
properties. Domain catalogs such as GitHub, Jira, or dispenser integrations
emit their own fixed acts only when a typed verb changes Woo-owned workflow
state.

## 13. Credentials

Credential lifecycle remains on the deployed block:

1. deploy returns an active block id,
2. owner invokes `:mint_apikey(label)`,
3. secret is shown once and stored in the plug's private secret manager,
4. plug validates it through `/net-api/session`,
5. owner lists metadata, rotates, or revokes through block verbs.

Keeping this separate avoids:

- plaintext in blueprint properties,
- plaintext in deployment acts or receipts,
- ambiguous retry semantics after a lost deploy response,
- coupling host allocation to a specific external runtime.

The UI may present deploy-then-mint as a guided workflow, but they remain
two authority operations.

## 14. Private and local infrastructure

Nothing in the blueprint or deployment contract names Cloudflare.

### In-memory

Each deployed block has a distinct logical host id, even if all objects
remain in one process. Tests must preserve routing and authority semantics
rather than collapsing the distinction in assertions.

### Local SQLite

The implementation may co-locate logical hosts in one process/database or
use separate files, but host identity, routing, idempotency receipts, and
recovery semantics must match the distributed profile.

### Workerd and Cloudflare

The logical host maps to a Durable Object. Deployment initializes the DO
before publishing/activating its route. Workerd-local is the required
distributed validation lane before a paid canary.

### External plug

The plug needs only a reachable Woo base URL and the block-bound apikey.
The weather catalog's Node runner is the first non-Cloudflare reference.
A generic SDK/template should extract its Net client and retry behavior so
private services do not begin from Worker-specific scaffolding.

## 15. Upgrade and retirement

### 15.1 Blueprint edits

Editing increments the revision and invalidates the validation hash.
Running blocks do not change.

### 15.2 Upgrade

The first release should support “deploy replacement” rather than in-place
code mutation:

1. validate the new revision,
2. deploy a new block,
3. copy only explicitly migratable owner configuration,
4. start and validate the new plug credential,
5. switch external references,
6. revoke the old key and retire the old block.

In-place upgrade should wait for a migration contract that can prove
property/verb compatibility on the block's own host.

### 15.3 Retirement

Retirement:

- revokes all block apikeys,
- prevents new calls,
- removes the room contents cache entry,
- recycles the self-hosted root through its owner host,
- releases the quota receipt asynchronously and idempotently,
- records a retirement fact.

Duplicate resolution or consolidation belongs to the domain objects
connected through the block, not to deployment identity. Two connector
blocks may be retired or redirected without rewriting the history of Jira
cases, GitHub issues, or other artifacts they synchronized.

## 16. Security review checklist

- Self-host allocation checks `actor`, never only `progr`.
- Public wizard-owned factory code cannot launder deployment authority.
- Owner is fixed to the deploying actor.
- Runtime parent is constrained to an approved `$block` lineage.
- Exported code retains programmer ownership.
- Native and foreign-owned verbs cannot be copied.
- Export size, count, source length, and compile cost are bounded.
- Reserved properties (`owner`, placement, route, credential internals)
  cannot be exported.
- Initial room placement applies room policy.
- Idempotency conflict detection includes the validated blueprint hash.
- Deployment receipts and acts contain no secrets or unbounded source.
- Apikeys remain one-block credentials and are revocable.
- Quota reservation precedes host allocation.
- Failed provisioning is visible and recoverable by id.
- No global scan is needed for quota, repair, or listing.

## 17. Implementation sequence

### Phase 0 — align the contract

1. Correct `spec/semantics/objects.md` and
   `spec/semantics/permissions.md` so self-host authority has one
   implementable meaning.
2. Add failing tests showing every create path denies ungranted
   self-host allocation, including fertile concrete parents.
3. Decide and specify the first `host_deployer` grant and quota cells.
4. Specify initial self-host placement separately from anchoring.

No user-facing blueprint work should land before this phase constrains the
resource boundary.

### Phase 1 — blueprint catalog

1. Add `$block_blueprint` as a fertile, non-self-hosting authoring class.
2. Implement explicit property/verb export metadata.
3. Implement field policy and revision invalidation.
4. Implement `:validate` and `:deployment_plan` without allocation.
5. Add programmer-facing docs and examples.

This phase can be exercised entirely in-memory.

### Phase 2 — generic materialization

1. Define the transport-neutral hosted-object snapshot.
2. Add generic ownership, source, size, and placement validation.
3. Implement idempotent object-id reservation and host initialization.
4. Publish Directory routes only after the new host is initialized.
5. Implement recoverable initial room-cache update.
6. Record deployment provenance on the object.

Keep block vocabulary in the catalog; core accepts generic snapshot data.

### Phase 3 — deploy and quota

1. Add actor-local quota reservation and receipt projection.
2. Implement `$block_blueprint:deploy`.
3. Emit fixed deployment acts/observations.
4. Implement retry/resume and idempotency conflict handling.
5. Implement owner retirement and quota release.

### Phase 4 — private plug developer experience

1. Extract a small protocol-neutral Net client from the weather plug.
2. Ship Node scheduled-service and one-shot examples.
3. Add a Python skeleton matching the documented contract.
4. Document private TLS/networking and secret-manager expectations.
5. Add a local end-to-end blueprint → deploy → mint → plug smoke.

### Phase 5 — upgrade

1. Add replacement-deploy assistance and explicit config transfer.
2. Define compatibility reports.
3. Add migration-aware in-place upgrade only if real workloads require it.

## 18. Required tests

### Authority

- Builder without programmer authority may create a blueprint but cannot
  add executable exports.
- Programmer can edit only owned blueprints.
- Programmer without `host_deployer` cannot deploy.
- Public wizard-owned wrapper cannot deploy for an ungranted actor.
- Granted actor cannot exceed quota.
- Wizard bypass is explicit and audited.

### Snapshot integrity

- Only explicit own properties and verbs are copied.
- Foreign/wizard-owned verbs are rejected.
- Copied verb `progr` remains the programmer.
- Blueprint mutation after validation refuses deploy.
- Same source bundle produces a stable canonical hash.

### Placement and routing

- Deployed block has `host_placement = "self"`.
- Deployed block has `anchor = null`.
- Deployed block's authoritative `location` is the requested room.
- Room contents eventually includes the block.
- Normal owner `:moveto` remains denied after activation.
- Local, fake-DO, and workerd lanes agree on the logical route.

### Retry and recovery

- Lost response plus same idempotency key returns one block.
- Conflicting retry returns `E_IDEMPOTENCY_CONFLICT`.
- Failure before allocation consumes no quota.
- Failure after reservation resumes or releases deterministically.
- Room-cache failure repairs without allocating another host.
- Retirement and duplicate retirement release at most one quota slot.

### Credential and plug

- Owner mints a key after deployment.
- Key authenticates as the deployed block, not owner or blueprint.
- Plug can write only `plug` fields.
- Owner can write only `owner` fields through the block policy.
- Revocation closes sessions and stops further writes.
- Plain Node runner completes one local push without Cloudflare.

### Acts

- Deployment acts carry fixed bounded payloads.
- No source or secret appears in acts, logs, or receipts.
- External property pushes do not become deployment acts.

## 19. Documentation and specification changes

When implementation begins, update together:

- `spec/semantics/objects.md` — class-vs-instance placement and
  self-host allocation.
- `spec/semantics/permissions.md` — grant and actor-vs-progr rule.
- `spec/protocol/hosts.md` — hosted-object initialization and route
  publication.
- `spec/reference/cloudflare.md` — DO initialization/recovery mapping.
- `spec/discovery/catalogs.md` — `$block_blueprint` catalog entry if
  bundled.
- `docs/designing/creating-objects.md` — blueprint and deploy distinction.
- `docs/blocks-and-plugs/writing-a-block.md` — replace planned wording
  with the actual command/tool surface.
- `docs/blocks-and-plugs/writing-a-plug.md` — link the generic client
  package.
- `catalogs/block/DESIGN.md` — canonical field-policy representation.

Determine migrations from the state changed, not merely from the feature:

- a new bundled catalog class is normally additive,
- new bootstrap actor flags/properties may need a local-boot migration,
- changing installed `$block` policy properties may require catalog
  version migration,
- adding or renaming a Durable Object binding requires a Cloudflare DO
  migration,
- existing block instances must not silently acquire blueprint provenance.

## 20. Acceptance criteria

The first release is complete when:

1. A non-wizard programmer creates and validates a blueprint in-world.
2. An administrator grants that actor bounded host-deployment authority.
3. The programmer deploys one block into their current room without
   catalog installation or wizard action on that instance.
4. The instance is self-hosted, unanchored, room-visible, owner-controlled,
   and immutable through ordinary programmer definition operations.
5. The programmer mints a block-bound key and a plain Node process pushes
   data through the documented Net API.
6. Retry cannot allocate a duplicate block.
7. The same scenario passes in-memory, local SQLite, fake-DO, and workerd
   lanes.
8. Tests prove no privilege laundering, foreign-code ownership, secret
   persistence, global enumeration, or quota bypass.
9. Existing catalog-defined weather and horoscope blocks remain
   behaviorally unchanged.

## 21. Open decisions

1. Is the first grant a `host_deployer` flag plus quota, or should general
   scoped capability objects land first?
2. Should blueprint deployment allow any `$block`-derived parent or only a
   small allowlist?
3. Is the canonical field policy a map, with legacy tier lists derived, or
   should catalog classes migrate fully to the map?
4. Which host owns the deployment act log: actor, blueprint, target room,
   or a dedicated actor-local deployment space?
5. Does target-room acceptance need a new `:acceptable_installation`
   hook, or can a generic initial-placement hook serve other self-hosted
   appliances?
6. How much of hosted-object initialization already fits the current Net
   create transcript and deferred host-effect machinery?
7. Should a blueprint be exportable to a catalog manifest, and if so, how
   is programmer authority represented when another world installs it?

The first four decisions must be explicit in the normative spec before
implementation. The remaining questions can be resolved by a narrow
in-memory/workerd spike, but the spike must not become an undocumented
production path.
