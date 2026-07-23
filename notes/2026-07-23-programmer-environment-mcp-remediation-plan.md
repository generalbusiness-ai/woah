# Fit-for-purpose programmer environment and MCP remediation plan

Date: 2026-07-23
Status: design note for discussion; not normative and not implemented

Companion documents:

- [`../spec/authoring/minimal-ide.md`](../spec/authoring/minimal-ide.md)
- [`../spec/authoring/editor-rooms.md`](../spec/authoring/editor-rooms.md)
- [`../spec/protocol/mcp.md`](../spec/protocol/mcp.md)
- [`../spec/identity/provisioning.md`](../spec/identity/provisioning.md)
- [`../docs/designing/builder-and-programmer.md`](../docs/designing/builder-and-programmer.md)
- [`2026-07-23-programmer-block-factory-deploy-plan.md`](2026-07-23-programmer-block-factory-deploy-plan.md)
- [`2026-07-22-repository-workspaces-and-content-connectors.md`](2026-07-22-repository-workspaces-and-content-connectors.md)

---

## 1. Executive decision

Woo has a substantial in-world authoring kernel, but the supported programmer
agent path is not yet usable:

- normal `$agent` provisioning can set `programmer: true`, but does not give the
  agent the `$programmer` interaction surface;
- the current surface is exposed to MCP with argument names but almost no usable
  input schema;
- several lifecycle operations are missing, misleading, or not consistently
  versioned;
- the direct-authoring contract in the minimal IDE draft and the sequenced
  routing used by current Net MCP tools are not reconciled; and
- no acceptance test performs a complete programmer workflow through MCP.

The remediation should preserve three separate concepts:

1. **identity kind** — `$human`, `$agent`, or another actor class;
2. **hard authority** — the `programmer` or `wizard` flag and ordinary
   ownership/permission checks; and
3. **interaction surface** — the builder/programmer verbs that dispatch on the
   actor and appear in MCP discovery.

Identity remains in the actor's single-inheritance chain. Hard authority remains
the security fact. The interaction surface becomes a feature/role attachment
that can coexist with any actor kind.

Initially, the existing `$builder` and `$programmer` objects can serve both as
legacy player classes and attachable role surfaces. Dispatch and Net MCP already
walk feature chains, and `$programmer` already inherits `$builder`. A later
catalog cleanup may split pure `$builder_surface` / `$programmer_surface`
objects if the inherited `$player` chain proves confusing, but duplicating every
verb into new objects is not required to repair the first path.

Promotion and demotion must synchronize the authority fact and surface
attachment atomically. The substrate must remain catalog-agnostic: the mapping
from an authority fact to one or more feature objects is declared as world data,
not a branch on `$programmer` in TypeScript.

The programmer's primary agent interface is a typed, structured MCP lifecycle.
`eval` remains an expert escape hatch, and the editor room remains an optional
stateful/collaborative environment rather than the only credible editing path.

---

## 2. Scope

### 2.1 Required outcome

A human or agent with a valid programmer grant must be able to:

1. authenticate normally;
2. discover a stable, accurately authorized programmer surface through MCP;
3. inspect an object, its inheritance/features, property definitions, readable
   source, schemas, versions, and editability;
4. create a programmer-owned object or select an editable object from bounded
   context;
5. compile source without mutation;
6. define, replace, rename, and delete verbs with optimistic concurrency;
7. define, update, value-set, clear, and delete properties with the appropriate
   definition/value versions;
8. call the resulting behavior and receive structured observations and runtime
   errors;
9. group related edits into an atomic, single-host changeset;
10. recover cleanly from stale versions, compile errors, permission failures,
    retries, and transport interruption; and
11. perform the same workflow in memory, local SQLite, workerd, Cloudflare, and
    private non-Cloudflare deployments.

### 2.2 Not required for the first fit-for-purpose release

- real-time shared text/CRDT editing;
- global source or object enumeration;
- cross-host atomic changesets;
- a package manager or Git implementation inside the world;
- graphical programming;
- breakpoints, stepping, or a full debugger;
- unrestricted schema migrations of arbitrary live instance populations; or
- making deployed/self-hosted `$block` instances mutable programming surfaces.

Repository workspaces, language servers, collaborative documents, and block
deployment should consume this environment, not redefine its authority or wire
contracts.

---

## 3. Evidence and current failure modes

### 3.1 LambdaCore's two-part programmer model

LambdaCore deliberately separates programmer affordance from programmer
authority:

```text
$player ... -> $builder -> $prog -> $wiz
```

`$player_class` currently names `$builder`, so a new character inherits builder
commands. `$wiz_utils:set_programmer` sets `victim.programmer = 1`, adjusts
quota, and reparents the player to `$prog` if necessary. Programmer verbs such
as `@verb`, `@property`, and `eval` also check the programmer bit. Deprogramming
clears the bit but leaves the `$prog` command surface in the ancestry.

The intent is:

- ancestry supplies the user interface; and
- the bit supplies authority.

LambdaCore's remotely controlled characters remain ordinary player objects. It
does not have a persistent sibling `$agent` kind that must survive programmer
promotion.

One LambdaCore defect should not be copied: `set_programmer` sets the bit before
attempting `chparent`, and reports a failed reparent without rolling the bit
back. Woo should make the transition atomic.

Reference source: `~/play/LambdaCore/LambdaCore-latest.db`
(`$wiz_utils:set_programmer`, `$wiz_utils:unset_programmer`, and
`$wiz_utils:make_player`). This is a local comparison corpus, not a repository
dependency.

### 3.2 Woo copied the gates but not the transition

Woo's seed identity hierarchy is:

```text
$player
  +-- $human
  +-- $agent
  +-- $builder
        +-- $programmer
```

`create_agent(..., programmer: true)` creates under `$agent` and only sets the
flag. `promote_agent_to_programmer` likewise changes only the flag. Every
programmer wrapper checks for wizard authority or both:

- `$programmer` ancestry; and
- the `programmer` flag.

A normally provisioned programmer agent therefore cannot resolve
`install_verb`; it fails with `E_VERBNF` before the authority gate runs. It also
does not receive the tools in MCP discovery because the gateway walks its
instance, parent chain, and attached feature chains.

Reparenting is not an acceptable fix. Agent rotation, revocation, quota
accounting, and ownership validation require `$agent` ancestry. Human
provisioning similarly depends on `$human` ancestry. Single inheritance cannot
represent both identity kind and authoring role.

The mismatch affects builder affordances too. LambdaCore creates ordinary
characters under `$builder`; Woo's `$human` and `$agent` actors are siblings of
`$builder`.

### 3.3 The MCP contract is not self-describing

The programmer verbs declare `arg_spec.args`, but no useful types. The gateway
therefore emits fields such as:

```json
{
  "id": {},
  "descriptor": {},
  "source": {},
  "opts": {}
}
```

An agent cannot discover:

- object-reference and descriptor shapes;
- `define | set_code | upsert | delete` modes;
- nested option maps;
- `dry_run`, `expected_version`, and pagination controls;
- search scopes and channels;
- result envelopes;
- authority requirements; or
- whether the tool is direct, sequenced, mutating, or deferred.

The current gateway description is derived from the first source-comment
paragraph. That is useful as a fallback, not a stable tool contract.

Dynamic self tools are also named with the concrete actor id
(`<actor-id>__install_verb`). This is deterministic but needlessly unstable and
opaque for agent prompts.

### 3.4 Confirmed lifecycle defects

The current catalog has specific correctness problems:

- `set_verb_info(..., {dry_run: true})` returns the unchanged `before` map as
  `after`, so it does not preview the requested edit;
- `set_property_info` parses `opts.default` but silently ignores it when
  updating an existing definition;
- property-definition update and deletion do not support
  `expected_version`, contrary to the minimal IDE draft;
- structured property deletion is hidden behind a mode while structured verb
  deletion is absent;
- `trace` is tool-exposed but always raises `E_NOT_IMPLEMENTED`;
- `force_recycle` is visible to ordinary programmers although its body is
  wizard-only; and
- programmer documentation says metadata edits do not change `progr`, although
  changing verb owner changes the authority used by future dispatch.

### 3.5 Test coverage stops at the boundary between components

The direct world-call authoring tests cover a manually reparented programmer.
The Net MCP tests cover generic guest discovery and invocation. No test composes
normal programmer-agent provisioning with MCP discovery and a complete
authoring lifecycle.

---

## 4. Target authority and surface model

### 4.1 Invariants

The repaired system must enforce:

**PE1 — Identity stability.** Granting or revoking an authoring role does not
change `$human`, `$agent`, ownership, account, credential, attribution, or
lifecycle ancestry.

**PE2 — Authority is not presentation.** Attaching a programmer surface never
grants programmer authority. The `programmer` flag and normal object/verb/
property permissions remain authoritative.

**PE3 — Presentation follows authority.** A successful grant makes the
corresponding surface resolvable and discoverable before it returns. A
successful revoke removes it before returning.

**PE4 — One atomic transition.** Flag, feature list, quota counters, audit
record, and any role-version marker commit or roll back together.

**PE5 — Catalog-neutral substrate.** TypeScript knows only a generic mapping
from authority facts to attached surfaces. It never branches on `$programmer`,
`$builder`, or the `prog` catalog.

**PE6 — Fail closed when unavailable.** A request for `programmer: true` fails
with a named error if the declared surface is not installed or cannot be
attached. It must not mint a bit-only identity.

**PE7 — Lazy big-world repair.** Existing actors reconcile on their own host
during authentication/load or explicit flag mutation. No migration enumerates
all actors.

**PE8 — Legacy compatibility.** During migration, an actor has the programmer
surface when it either inherits from `$programmer` or carries the declared
programmer feature. The flag remains required in both cases.

### 4.2 Declarative capability-to-surface binding

The recommended generic world data is conceptually:

```woo
$system.authority_surface_bindings = {
  programmer: {
    version: 1,
    features: [$programmer]
  }
}
```

Names and exact storage may change during specification, but the semantics
should not:

- the `prog` catalog registers the binding as catalog data;
- generic flag mutation reads the binding;
- enabling the fact attaches the listed features;
- disabling it removes the listed features; and
- missing, recycled, or invalid surface objects make enablement fail.

`programmer` remains the substrate authority flag because VM/builtin checks need
it independently of catalog availability. The binding is presentation and
dispatch composition.

The generic synchronizer must be used by every flag-mutation path:

- `create_agent(..., programmer: true)`;
- `promote_agent_to_programmer`;
- `demote_agent_from_programmer`;
- wizard `set_actor_flag` / `set_object_flags`;
- bootstrap and catalog repair; and
- future administrative APIs.

Direct writes to the flag that bypass synchronization should be removed or made
private to the synchronizer.

### 4.3 Surface checks in woocode

The repeated inline gates should become catalog helpers with one contract:

```woo
$builder:surface_available_to(actor)
$programmer:surface_available_to(actor)
$programmer:assert_authorized(actor)
```

During compatibility:

```text
builder surface =
  wizard OR isa(actor, $builder)
         OR any attached feature satisfies isa(feature, $builder)

programmer surface =
  wizard OR isa(actor, $programmer)
         OR any attached feature satisfies isa(feature, $programmer)

programmer authority =
  wizard OR (programmer surface AND programmer flag)
```

The exact helper can live on a catalog utility object if dispatching directly to
the role object creates confusing `this` semantics. It must remain woocode or a
generic builtin; the core must not gain a bundled-catalog name.

The current `has_feature(actor, feature)` check is exact, so it is not by itself
sufficient for the first rule: an attached `$programmer` contributes
`$builder` behavior through its parent chain without literally attaching
`$builder`. Either the catalog helper must walk the actor's bounded feature
list and apply generic `isa(feature, surface)`, or the substrate may expose an
equally generic feature-ancestry predicate. Do not attach both role objects
merely to work around an exact-membership helper.

### 4.4 Reuse before splitting

The first implementation should attach the existing `$programmer` object:

- its parent chain already includes `$builder`;
- normal dispatch already walks feature parent chains;
- Net MCP discovery already walks feature parent chains; and
- legacy descendants remain compatible.

Before committing this representation, test collision behavior for verbs
inherited through both the actor's `$player` chain and the feature's `$player`
chain. Dispatch order already prefers the actor chain and de-duplicates names,
so the expected result is benign redundancy.

Create separate `$builder_surface` / `$programmer_surface` objects only if that
test exposes ambiguity or if catalog maintainability clearly improves. If split,
move definitions rather than leaving two long-lived copies.

---

## 5. Fit-for-purpose programmer tool contract

### 5.1 Stable lifecycle

The agent-facing surface should converge on these operations:

| Area | Operation | Required behavior |
|---|---|---|
| Discover | `look()` | Versioned surface summary and capability state. |
| Inspect | `inspect(id, opts?)` | Structure, definitions, features, schemas, versions, host/editability. |
| Inspect | `resolve_verb(id, descriptor)` | Ordered resolution walk and definer. |
| Inspect | `list_verb(id, descriptor, opts?)` | Read-filtered source and metadata. |
| Search | `search(query, opts?)` | Bounded, paged, scoped source/object search. |
| Compile | `compile_verb(id, descriptor, source, opts?)` | Pure validation, diagnostics, projected metadata. |
| Verb | `install_verb(id, descriptor, source, opts?)` | Define/upsert/set-code with expected version. |
| Verb | `set_verb_info(id, descriptor, opts)` | Truthful metadata projection and update. |
| Verb | `delete_verb(id, descriptor, opts)` | Dry-run and expected-version deletion. |
| Property | `define_property(id, name, default, opts?)` | Definition creation with absent-version precondition. |
| Property | `set_property_info(id, name, opts)` | Definition metadata/default update with expected version. |
| Property | `set_property(id, name, value, opts?)` | Value update with value-version precondition. |
| Property | `clear_property(id, name, opts?)` | Clear local value override with value-version precondition. |
| Property | `delete_property(id, name, opts)` | Definition deletion with expected version. |
| Object | `create(parent, opts?)` | Owned object creation with explicit placement. |
| Object | `move(id, location, opts?)` | Direct authored move; distinct from domain `moveto`. |
| Object | `chparent(id, parent, opts?)` | Cycle/fertility/actor-kind-safe reparent. |
| Object | `recycle(id, opts?)` | Dry-run, impact, expected structural version where available. |
| Batch | `apply_changeset(changes, opts?)` | Atomic single-host set with dry-run and per-cell preconditions. |
| Test | ordinary dynamic verb call | Sequenced behavior call and structured observations. |
| Expert | `eval(source, opts?)` | Explicit high-authority escape hatch. |

The chat-oriented `@` commands may remain. They should call the same catalog
helpers or generic primitives, but they are not substitutes for structured MCP
operations.

### 5.2 Consistent result envelope

Mutating authoring tools should share a predictable shape:

```json
{
  "ok": true,
  "operation": "set_verb_info",
  "dry_run": false,
  "target": "obj_...",
  "before": {},
  "after": {},
  "version": 4,
  "diagnostics": [],
  "effects": []
}
```

Rules:

- validation/compile failures that execute nothing return `ok: false` with
  diagnostics;
- permission, missing-object, routing, and version conflicts remain normal
  named errors;
- dry-run performs every permission, routing, type, mode, and version check
  that a real call can perform without mutation;
- `after` is the actual projected post-state, not an alias of `before`;
- delete operations return a tombstone projection or explicit `after: null`;
- versions name whether they are definition, value, structural, or changeset
  versions; and
- no result contains bytecode unless an explicit expert/debug option permits it.

### 5.3 Changesets

Agents routinely need to define properties and install several related verbs.
Using `eval` for this is opaque and hard to review. Add a typed changeset:

```json
{
  "changes": [
    {
      "op": "define_property",
      "id": "obj_x",
      "name": "count",
      "default": 0,
      "expected_version": null
    },
    {
      "op": "install_verb",
      "id": "obj_x",
      "descriptor": "increment",
      "source": "verb :increment() rx { ... }",
      "expected_version": null
    }
  ],
  "dry_run": true
}
```

Changesets are atomic only when every affected definition belongs to one
authority host. Mixed-host input fails before mutation with a structured list
of target hosts. Each change retains its own optimistic precondition. Results
preserve input order and include per-change projections/diagnostics.

---

## 6. MCP surface

### 6.1 Transport-neutral call schemas

`arg_spec.types` cannot express the current option maps. Extend verb metadata
with a transport-neutral schema contract, using the supported JSON Schema
subset:

```json
{
  "args": ["id", "descriptor", "source", "opts?"],
  "input_schema": {
    "type": "object",
    "properties": {
      "id": {"type": "string"},
      "descriptor": {
        "oneOf": [{"type": "string"}, {"type": "integer", "minimum": 1}]
      },
      "source": {"type": "string"},
      "opts": {
        "type": "object",
        "properties": {
          "mode": {"enum": ["define", "set_code", "upsert"]},
          "dry_run": {"type": "boolean"},
          "expected_version": {"type": ["integer", "null"]}
        },
        "additionalProperties": false
      }
    },
    "required": ["id", "descriptor", "source"],
    "additionalProperties": false
  },
  "output_schema": {
    "$ref": "woo://schemas/authoring/install-result"
  }
}
```

The schema belongs to the callable verb, not MCP. MCP emits it as
`inputSchema`/`outputSchema`; a future IDE or REST authoring carrier reuses it.

Required implementation:

- catalog install validates supported schema keywords;
- gateway named-argument invocation validates input before submitting a turn;
- the authoritative call still validates types and permissions;
- result-schema mismatches are instrumentation/errors, never a reason to guess
  capabilities from returned strings; and
- schemas are included in tool-list digests so changes trigger
  `notifications/tools/list_changed`.

### 6.2 Explicit tool metadata

Add stable metadata instead of extracting the full contract from source:

```json
{
  "tool_exposed": true,
  "tool": {
    "title": "Install verb",
    "description": "Compile and atomically define or replace readable woocode.",
    "effects": "authoring_write",
    "authority": "programmer",
    "availability": "implemented"
  }
}
```

Source comments remain developer documentation and a fallback. Tool metadata
must not grant authority; it improves presentation and generic prefiltering.

`availability: "deferred"` tools are not advertised. Remove `trace` from the
surface until it works. Move `force_recycle` to a wizard-only surface or declare
an enforceable wizard requirement so normal programmers never see it.

### 6.3 Stable self names

For tools contributed by the session actor, generate:

```text
self__inspect
self__compile_verb
self__install_verb
```

The descriptor still carries the concrete actor object and canonical verb. This
is a generic MCP rule for the session actor, not a programmer special case.
`woo_call` continues to accept the concrete object id.

### 6.4 Discovery and returned references

Programmer tools remain attached to the actor, so they are always in structural
context for an authorized programmer. Objects returned by `create` or selected
for testing do not silently broaden context:

- `create(..., {location: actor})` intentionally places the object in inventory;
- a workspace/room may intentionally contain editable artifacts;
- returned object refs remain data until ordinary structural placement makes
  them reachable; and
- a future typed returned-reference extension must remain bounded and explicit.

### 6.5 Tool-list changes

Promotion, demotion, feature repair, editor entry/exit, and structural movement
must update the tool-list digest and emit one coalesced
`notifications/tools/list_changed`. The next `tools/list` must agree exactly
with invocation authorization.

---

## 7. Direct authoring and distributed routing

### 7.1 Separate definition changes from domain behavior

The minimal IDE draft is correct: definition edits are administrative writes to
an object's authority host, not acts in the actor's current room log.

Use:

- **direct authoring** for compile/install/schema/object-definition mutations;
- **sequenced calls** for testing domain behavior and observing its acts/events;
- **live/direct calls** only for explicitly live, non-durable interactions.

Current MCP routing defaults mutation tools without command metadata to
`sequenced`. That is safe as a generic fallback but wrong as the final
authoring model. A programmer editing an object must not consume or depend on
the active room's sequence.

### 7.2 Target-host authoring primitive

The current self-surface wrapper receives the edited object as an argument. A
normal direct call to the actor's host is therefore insufficient for remote
objects. Add a generic target-host authoring path:

```text
actor surface tool
  -> authoring operation {actor, progr, target, op, args, idempotency_key}
  -> target authority host
  -> permission/version/schema checks
  -> one local transaction
  -> authoring result + audit record
```

This may be implemented as a generic builtin/RPC used by woocode wrappers or as
an authoring route understood from call metadata. It must not know catalog
classes or operation names beyond the generic definition primitives.

Requirements:

- preserve authenticated `actor`, effective `progr`, customer attribution, and
  trace context;
- route by the target object's immutable authority scope;
- use idempotency keys so transport retries cannot double-apply;
- commit one host-local transaction;
- enforce expected versions on the authority host;
- produce a separately typed authoring audit record;
- return `E_CROSS_HOST_WRITE` only for a genuinely multi-host atomic request,
  not merely because the caller and target differ; and
- never append the edit to an unrelated room sequence.

### 7.3 Co-resident fast path

Programmer-owned blueprints and workspace artifacts should normally be
co-resident with their owning actor or workspace. The generic route may execute
locally without RPC when target authority is already present. This is an
optimization, not a separate semantic path.

### 7.4 Search and big-world discipline

Remove authoring search modes that enumerate `world.objects`. Supported scopes
should be bounded:

- `context` — actor, inventory, active room, direct room contents, features;
- `owned` — an owner-maintained, paged index on the actor/workspace host;
- `object` — one explicit object and bounded parent/child traversal;
- `workspace` — one room/block/repository workspace and its declared artifacts.

Every response includes `limit`, `next_cursor`, `truncated`, and the scope or
authority stamp from which it was read. There is no global `all`.

---

## 8. Inspection, diagnostics, and editing ergonomics

### 8.1 Inspection contract

`inspect` should add the fields the minimal IDE needs:

- anchor and authority/host scope;
- modified and structural versions;
- event/observation schema summaries;
- paged children, contents, instances, and attached consumers;
- definition version and value version for properties;
- readability/editability with named refusal reasons;
- whether an entry is local, inherited, feature-contributed, or projected;
- source and line map only when readable; and
- bounded links to recent authoring audit entries and relevant runtime errors.

Do not report `editable: true` solely from a cached generic permission check.
The authority host remains final.

### 8.2 Diagnostics

Compile and runtime diagnostics share source coordinates:

```json
{
  "severity": "error",
  "code": "E_COMPILE",
  "message": "...",
  "span": {
    "line": 4,
    "column": 8,
    "end_line": 4,
    "end_column": 14
  }
}
```

Runtime `$error.trace` already carries useful line-mapped frames. Make that the
first debugging surface. Do not advertise a next-N `trace` tool until its
capture, retention, permission filtering, and distributed cost are specified
and implemented.

### 8.3 Editor room

The verb editor remains useful for:

- a durable/pauseable buffer;
- human editing;
- future async shared-document collaboration;
- language-server diagnostics; and
- discussion alongside code.

It is not required for a basic agent edit. Agents should be able to use
`list_verb`, `compile_verb`, and `install_verb` without changing rooms.

Before calling the editor collaborative, replace per-actor isolated buffers
with a specified shared-document/review model. Real-time co-editing remains a
separate layer.

### 8.4 Language-server boundary

The language server consumes source snapshots and returns diagnostics,
completion, navigation, and reference information. It does not own world
authority and does not install code. Installation always returns through the
versioned authoring operation.

For repository workspaces, language-server file views and in-world verb source
may coexist, but their versions are distinct. A change record must say whether
it proposes a Git artifact, a world verb definition, or both.

---

## 9. Security and audit

### 9.1 Authority

- The programmer flag never follows from feature attachment.
- Non-wizards may create/modify executable definitions only where ordinary
  authoring ownership permits.
- A non-wizard cannot create or chown a verb/property to another principal.
- Changing verb owner changes future `progr`; documentation and audit must say
  so explicitly.
- `eval` runs as the invoking programmer and is exposed only on the programmer
  surface.
- Wizard-only repair tools belong on a wizard-only surface.

### 9.2 Audit

Each successful authoring mutation records:

- actor and effective programmer;
- customer attribution;
- target and authority host;
- operation;
- before/after version or hashes;
- source hash, never secrets;
- idempotency key and trace id;
- changeset id when present; and
- timestamp/outcome.

Source bodies may require separate retention/access policy; the audit record can
carry hashes and object/version references rather than duplicating source.

Rejected permission, owner-change, cross-host, schema, and version-conflict
attempts feed the security audit/metric stream with bounded detail.

### 9.3 Feature attachment policy

The programmer surface is system-managed presentation. An actor attaching it
manually still gains no authority, but self-attachment would create misleading
tools. Its `can_be_attached_by` policy should therefore refuse ordinary manual
attachment; only the generic authority-surface synchronizer or a wizard repair
path may manage it.

---

## 10. Migration and compatibility

### 10.1 State kinds

The likely changes cross several migration categories:

| Change | Migration treatment |
|---|---|
| New/changed `prog` catalog verbs and metadata | Catalog release; use a major migration if definitions are moved/deleted. |
| New `$system` binding registry property | Worktree schema/data migration for installed worlds. |
| Seeded `$wiz`/role attachments | Bootstrap local-boot repair, idempotent. |
| Existing actor feature reconciliation | Lazy actor-host repair; no global scan. |
| Gateway support for richer schemas/self aliases | Runtime/protocol compatibility; spec and tests, likely no state rewrite. |
| New DO class | Not expected; if introduced, normal Cloudflare DO migration discipline applies. |

The `prog` catalog is currently `0.4.0`. If the release removes/moves verb
definitions or establishes a stable v1 contract, promote to `1.0.0` and ship
`catalogs/prog/migration-v0-to-v1.json`. If it only adds compatible metadata and
helpers while reusing `$builder`/`$programmer`, a minor release may suffice, but
the live binding property still needs an idempotent data migration.

### 10.2 Lazy reconciliation

At actor authentication/load:

1. read authority flags;
2. read installed authority-surface bindings;
3. compare the exact feature attachments;
4. add missing required surfaces and remove managed surfaces whose authority is
   absent;
5. persist only when changed; and
6. refresh the gateway/tool-list projection.

This is actor-local and idempotent. It repairs aged programmer agents without
enumerating every account or actor.

The binding needs a version so a later catalog upgrade can cause another local
reconciliation. The version stamp may live in generic actor capability state if
that shape is specified; otherwise a cheap exact feature check on authentication
is acceptable initially.

### 10.3 Rollout order

1. Land protocol/spec changes and red acceptance tests.
2. Land generic runtime support for bindings, atomic synchronization, schemas,
   and target-host authoring while old catalog behavior still works.
3. Publish the compatible `prog` catalog metadata/helpers.
4. Activate binding registration and lazy reconciliation.
5. Verify programmer agents through in-memory, SQLite, and workerd MCP.
6. Canary with a newly provisioned agent and one aged bit-only agent.
7. Observe reconciliation, authoring failure, conflict, and tool-list metrics.
8. Only then update the default deployment catalog selection.

Rollback removes the binding registration/tool exposure while leaving the hard
programmer flag unchanged. Runtime compatibility must tolerate both ancestry
and feature surfaces during the rollback window.

---

## 11. Implementation phases

### Phase 0 — Make the contracts explicit

- Update `spec/identity/provisioning.md` with identity/authority/surface
  invariants and atomic grant semantics.
- Update `spec/authoring/minimal-ide.md` with the MCP-equivalent lifecycle,
  target-host direct authoring, changesets, and result envelopes.
- Update `spec/protocol/mcp.md` with explicit input/output schemas, self aliases,
  tool availability/authority metadata, and authoring routing.
- Correct `progr`/owner documentation.
- Add failing tests for the current programmer-agent `E_VERBNF`.

Exit: the specifications constrain implementation and the essential acceptance
test fails for the intended reason.

### Phase 1 — Repair role reachability

- Add the generic authority-surface binding representation.
- Route all programmer-flag mutations through one atomic synchronizer.
- Register `$programmer` as the programmer surface in the `prog` catalog.
- Add catalog helpers for legacy-ancestry-or-feature surface checks.
- Add lazy actor reconciliation and tool-list invalidation.
- Remove direct unsynchronized flag mutations.

Exit: a newly created and an aged programmer agent both discover and execute
the programmer surface while remaining `$agent`; demotion removes it.

### Phase 2 — Close lifecycle correctness

- Fix truthful `set_verb_info` dry-run.
- Correct property-default updates.
- Add definition-version preconditions to all property metadata/delete paths.
- Add structured `compile_verb`, `delete_verb`, `define_property`,
  `clear_property`, and `delete_property`.
- Standardize result envelopes.
- Correct owner/`progr` docs and audit.

Exit: create/read/update/delete is symmetric and conflict-safe for objects,
verbs, definitions, and values.

### Phase 3 — Make MCP genuinely self-describing

- Specify and implement verb input/output schemas.
- Add rich tool metadata and schema validation.
- Add `self__*` aliases.
- Hide deferred and authority-inapplicable tools.
- Add pagination/cursors to inspection and search.
- Remove global authoring search.

Exit: a capable agent can construct every call from `tools/list` without
repository documentation.

### Phase 4 — Correct distributed authoring

- Implement target-host direct authoring with preserved actor/progr/audit/trace.
- Add idempotency and authoritative expected-version checks.
- Add single-host `apply_changeset`.
- Keep behavior testing sequenced.
- Add workerd cross-host and failure-injection tests.

Exit: editing a remote-authority object does not require co-location or append
to the active room log, and retries cannot double-apply.

### Phase 5 — Complete the environment

- Expand inspection with schemas, editability, authority scope, and audit/error
  references.
- Define the language-server snapshot/diagnostic boundary.
- Improve editor-room async collaboration separately from the core agent loop.
- Connect block blueprints and repository workspaces to the stable lifecycle.

Exit: IDE, MCP agents, editor rooms, and repository/block workflows share one
authoring backend and version model.

---

## 12. Test plan

### 12.1 Identity and authority

- `create_agent(..., programmer: true)` preserves `$agent` ancestry and attaches
  the surface.
- Promotion of an existing `$agent` is atomic across feature, flag, quota, and
  audit.
- Demotion removes surface and flag and frees quota.
- A `$human` can receive a surface without losing `$human` ancestry.
- A feature-only actor has no programmer authority.
- A flag-only aged actor is repaired at authentication.
- An invalid/missing surface makes grant fail without changing flag or quota.
- Legacy `$programmer` descendants remain usable during migration.
- Non-wizards cannot attach the managed surface manually.

### 12.2 Lifecycle correctness

- Every dry-run returns the actual projected post-state and performs all
  non-mutating checks.
- Verb/property definition and value versions reject stale writers.
- Property default updates change inherited reads.
- Define/update/delete operations are symmetric and idempotent under retry.
- Failed compilation and changesets leave no partial objects/definitions.
- Owner changes are wizard-only and change future `progr` exactly as documented.

### 12.3 MCP acceptance

One test must execute this complete path through `/net-api/mcp`:

1. provision a programmer agent and API key;
2. initialize MCP;
3. list tools and find `self__inspect`, `self__compile_verb`, and
   `self__install_verb`;
4. assert exact nested input and output schemas;
5. create an object in inventory;
6. define a property;
7. compile and install a verb;
8. call the new verb through its dynamic object tool;
9. receive its observation through the call result/`woo_wait`;
10. inspect the changed value;
11. provoke and recognize a stale-version conflict;
12. delete the verb, property, and object; and
13. demote the agent and verify the programmer tools disappear after one
    `tools/list_changed`.

The same test asserts that `trace` and `force_recycle` are absent for the
ordinary programmer.

### 12.4 Distributed lanes

- In-memory targeted authoring tests.
- Local SQLite restart/reconciliation test.
- `npm run smoke:cf-local` through the shared scenario where applicable.
- Real workerd target-host authoring, version conflict, retry, and changeset
  tests.
- Worker/MCP suite.
- Full test suite before broad merge.
- Deployed canary only after prior lanes pass, using a dedicated programmer
  agent and disposable owned artifacts.

### 12.5 Security and load

- Cross-principal verb/property edit and chown refusals.
- Malformed/oversized schema and source limits.
- Eval remains absent for non-programmers.
- Forged tool metadata does not grant authority.
- Idempotent replay yields one write/audit record.
- Search/inspect caps and cursors prevent global or unbounded scans.
- Tool-list and schema hydration remain bounded for cold actor/feature scopes.
- Authoring audit redacts credentials and source where policy requires.

---

## 13. Observability

Add metrics sufficient to distinguish configuration, authority, routing, and
code failures:

- `programmer_surface_reconcile{status,reason}`;
- `programmer_grant{status,source}`;
- `authoring_call{op,status,local|remote}`;
- `authoring_conflict{op}`;
- `authoring_changeset{status,count}`;
- `authoring_schema_validation{status,tool}`;
- `mcp_tool_list_changed{reason=authority_surface}`;
- target-host authoring RPC latency/retry; and
- bounded source/diagnostic byte sizes.

Do not put object ids, source, credentials, or free-form error bodies in metric
dimensions.

Canary acceptance should report:

- no bit-only programmer actors after authentication reconciliation;
- no repeated reconciliation writes after the first successful repair;
- zero partial authoring changes on injected failures;
- zero duplicate writes/audit entries under retry;
- exact MCP schema/tool presence; and
- no active-room sequence increments from direct definition edits.

---

## 14. Documentation changes required

When implementation lands:

- rewrite `docs/designing/builder-and-programmer.md` around identity, authority,
  and attached surfaces rather than reparenting;
- document normal programmer-agent provisioning and MCP initialization;
- make `docs/designing/programming-verbs.md` match owner/`progr`, versions,
  deletion, changesets, and schemas;
- update `docs/designing/creating-objects.md` with placement and authority-host
  behavior;
- describe editor rooms as optional stateful/collaborative views;
- link block blueprints and repository workspaces to the shared authoring
  lifecycle; and
- remove all claims for deferred tools.

The user documentation should include one copy-pastable MCP workflow and one
human chat/editor workflow, both producing the same installed definition.

---

## 15. Conditions of satisfaction

The programmer environment is fit for purpose only when all of the following
are true:

1. A normally provisioned `$agent` with a programmer grant retains `$agent`
   identity and discovers the programmer MCP tools immediately.
2. A normal `$human` can receive the same role without losing account/lifecycle
   identity.
3. Revocation immediately removes authority and discoverability.
4. No catalog-specific class or object name is hard-coded into the substrate.
5. MCP input and output schemas fully describe nested options, enums, versions,
   and results.
6. Deferred or inapplicable tools are not advertised.
7. Verb and property definition lifecycles are symmetric, truthful under
   dry-run, and optimistic-concurrency safe.
8. Direct authoring routes to the target authority host and does not append to
   the active room's sequence.
9. Single-host changesets are atomic and retry-idempotent; mixed-host requests
   fail before mutation.
10. Search and inspection are bounded and paged without global enumeration.
11. Runtime errors and compile diagnostics are structured and source-mapped.
12. One automated MCP test proves the full provision-to-cleanup workflow.
13. The same semantic tests pass in memory, SQLite, fake DO, and real workerd.
14. Specs and user documentation describe the actual behavior.

Until these hold, the current programmer catalog is a useful implementation
prototype, not yet a dependable environment for autonomous coding agents.
