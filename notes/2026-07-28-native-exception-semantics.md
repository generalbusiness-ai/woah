# Native exception semantics: audit findings and remediation

Date: 2026-07-28

Status: implemented and locally validated on isolated branch
`worktree-native-exception-integration`; not merged to main and not deployed

Audited base: main `fb8bfe85`

Implementation base: main `6cbeb490`

Current merge target included: main `2749da4b` (retry-lease and MCP
argument-validation successor)

Deployed worker reported during the audit: `02bbc479`

## Implementation disposition

The audit's five findings are implemented in the isolated integration branch.
The phased text below is retained as the design and rollout rationale; this
table records the actual disposition.

| Finding | Disposition |
|---|---|
| F1 — failed transcript retains behavior effects | Recorder behavior scopes now commit or abort with the behavior journal. Fresh execution and deterministic replay stamp hash-covered `failureEffectsGeneration: 1`; generic/imported recordings remain unmarked. Both Net authorities observe legacy/unknown generations and terminally reject an invalid complete generation-1 shape. |
| F2 — direct rollback is incomplete | Direct and sequenced behavior use the same lazy inverse-operation journal. Authoritative objects, nested values, sessions, logs, tombstones, guest allocation, snapshots, counters, presence bookkeeping, and persistence-dirty state restore together. Repository acceptance runs while the outer journal is still live. |
| F3 — programmer transition validates after mutation | Feature-list shape and surface composition are preflighted. A shared object-flag plan computes the lineage, features, counters, and audit result before applying them. |
| F4 — programmer-agent creation allocates too early | Prospective inherited surface composition is validated before allocation. Create, registration, counters, and credentials then run in one behavior transaction. |
| F5 — session callback rewrites accepted success | Session-ended delivery is a typed post-accept effect. Synchronous throws and promise rejections become bounded metrics and cannot change the accepted domain result. |

### Adversarial re-review disposition

Successive adversarial implementation reviews found a P1 proof defect, its
inheritance-derived remnant, a shadow-lineage parity defect, and the following
P2/defense-in-depth gaps. They are fixed on this branch:

| Review finding | Disposition |
|---|---|
| Post-write read-backs survive abort | Recorder abort now invalidates proofs in execution order by semantic dependency, not only by the cell that stores the proof. Property and verb resolution record every consulted lineage/definition namespace, so rolled-back `chparent`, verb replacement, alias dispatch, descendant dispatch, recycle, and create invalidate the derived proof even when its receiver cell was not directly written. A pre-mutation proof remains. Invalidating an untracked native dispatch preserves proof-free incompleteness evidence instead of laundering the failed transcript into a complete one. |
| Authority reason-priority divergence | Completeness is the terminal step-4 envelope gate in both authorities and precedes generation-specific failed-effect admission. A transcript violating both rules returns `incomplete_transcript` from both. |
| Failed-transcript grammar can drift | Exhaustive core and Net field maps assign every authority-visible transcript field to envelope, proof, effect, outcome, or integrity semantics. Runtime admission consumes those maps; core effect/outcome inspectors are derived from the classification, and an unknown or classified-but-unimplemented field fails closed with the bounded `unclassified_fields` reason. Compile-time and runtime drift tests cover both layers. |
| Native contract guard is incomplete and outside the fast gate | All 50 built-in handlers register as `read_only`, `authoritative`, or `live_only`. The fast AST guard rejects direct unclassified registration and cross-checks every non-read-only handler against the complete failure-contract registry, including handlers deliberately untracked for Net admission. |
| Proof-only transfer checks only the inner savepoint | Terminal command transfer sums mutations, staged acceptance, and disallowed recorder events over the complete active behavior-scope stack. An outer write hidden behind `$programmer:eval` now refuses `E_SCOPE_SPLIT` without sequence allocation. |
| Programmer transition duplicates the flag planner | `setProgrammerAgentState`, `set_actor_flag`, and generic flag mutation now share `prepareObjectFlagPlan`/`applyObjectFlagPlan`; account quota/counter and profile audit wrap that one flag/surface plan. Surface-repair audit is derived from the observed membership change for the exact preflighted published surface, so an unpublished surface cannot fabricate `attached: true`. |
| Catalog update claims rollback | `catalog_registry_update` declares `durable_progress`/`idempotent_progress`, matching its bounded migration-state recovery rather than promising rollback of already completed migration steps. |
| AP11 ledger can undo an explicit demotion | `wizard = true` with `programmer = false` is treated as in-band evidence that AP11 completed and a later demotion preserved the wizard bit. For an already registered actor, the fully stripped state is likewise indistinguishable from an interruption before AP11's first flag write and therefore conflicts instead of guessing toward privilege restoration. An unregistered actor with mutual account/actor ledger evidence remains distinguishable as interrupted provisioning and is repairable. Reversible deactivation is newer operator intent. Local and Net paths share the planner. |
| Local repair can race a live SQLite server | Every file-backed local repository holds a cooperative shared lifetime lease. The repair CLI requires the exclusive lease even for dry-run, then holds `BEGIN IMMEDIATE` across load/plan/apply. It refuses while a live server owns the world, closing the in-memory stale-flush race that a SQL transaction alone cannot see. |
| Staged acceptance can be silently discarded | An outer behavior savepoint refuses if persistence deferral would pop it with unexecuted durable acceptance. Accepted-in-memory/absent-in-storage is not representable. |
| Abort is not exception-safe | Abort attempts every inverse in LIFO order and preserves the original behavior error. Any restore failure latches `E_WORLD_POISONED`; later behavior and mutation refuse. Shadow execution hosts inspect the explicit reload signal after normal error frames and immediately discard a poisoned cache so the next request rebuilds from committed authority state. |
| Shadow authority cannot validate lineage turns | The shadow reader, versioner, validator, and applier now share one exact lifecycle value, `{parent, owner, name, anchor, flags}`. Existing-object `op:"set"` writes validate per-frame authority, apply the full semantic replacement, and re-derive parent/children projections; create remains a typed create plus lifecycle echo and recycle remains typed `TranscriptRecycle`. Successful `chparent`, rename, and flag turns are covered across twin authority, accepted-frame receiver, and cold reconstruction. |
| Test-matrix gaps | Tests now cover failed-call `meSnapshot` restore metadata, a real second refusal for promote/demote/revoke, failed-turn deterministic replay, exact producer-to-authority proof acceptance, and automated 100-versus-5,000-object savepoint scaling in `npm test` without a contention-sensitive absolute microsecond threshold. |

The bounded historical repair is implemented for local SQLite and Net account
authorities. It walks only account-owned evidence, supports dry-run, refuses
ambiguous or oversized candidates, runs apply in a real savepoint, never
rewrites coherence versions for appearance, and converges to `empty` on retry.
Conflict-free dry-run returns a digest of the complete unredacted plan; apply
requires that review token and refuses if recomputation differs, closing the
operator review-to-apply race without exposing credential values.

The principled close is implemented at the mutation boundary:

- authoritative containers are guarded proxies and can mutate only under an
  explicit mutation permit;
- the first mutation records an inverse operation in the current nested
  behavior scope, so cost scales with touched state rather than world size;
- the recorder has matching nested behavior scopes, retaining proof/envelope
  events while discarding every aborted domain effect;
- persistence acceptance and nested sequenced-log acceptance occur before the
  outer journal is released, so storage refusal restores memory and storage;
- public values, cached outcomes, bytecode, seeds, and replies cross detached,
  immutable boundaries rather than retaining aliases into authority;
- classified built-in native registrations require every authoritative or
  live-only primitive—tracked or deliberately untracked—to name its rollback,
  durable-progress, saga, or live-only failure discipline.

Authority validation remains the independent trust-boundary backstop. This is
important even with the by-construction producer close: stale, imported, or
defective producers must not be trusted merely because they claim generation
1.

### Findings widened during implementation

Adversarial tests exposed and closed additional members of the same class:

- shrinking an array by assigning `length` must journal every truncated
  element, not only the length field;
- deep-freeze branding must happen only after the whole graph succeeds, and
  cyclic or hostile `Proxy` inputs must fail without poisoning later checks;
- `ErrorValue` and reply/cache boundaries must detach nested aliases;
- JSON-folder persistence must write an immutable generation and publish it
  with one atomic manifest rename, leaving prior generations readable by
  concurrent readers after a partial save;
- presence `Set`/`Map` views must not escape as mutable authority aliases;
- subscriber-scrub throttling is rollback state, and scrub decisions must read
  the durable subscriber projection rather than a stale helper view;
- synchronous repository refusal during savepoint commit must abort the
  behavior journal once and preserve the original error rather than masking it
  with a second abort;
- terminal command transfer needs one top-level turn, an unforgeable
  proof-only control signal, and retry binding at the original direct ingress.
  Exact retries return the retained target outcome before rerunning the
  wrapper; a different request under the same live session/actor/frame id is
  refused before wrapper dispatch or sequence allocation.
- a failed scope may retain durable pre-state proofs, but it cannot retain
  a read or state probe whose semantic resolution depends on rolled-back state.
  Property/version, location/contents, lifecycle/recycle, created-object,
  lineage ancestry, verb definition, alias, and descendant-dispatch
  dependencies are invalidated in execution order across merged nested scopes.
  Keeping such transient proofs either creates an
  authority-specific retry loop or records a value/version that never existed
  durably;
- lifecycle parity exposed a distinct builder capability boundary:
  `builder_create_object` and `builder_chparent` deliberately lower a
  wizard-owned surface frame to a non-programmer actor. Their transcript
  annotation selects the builder rule but does not grant it; shadow admission
  independently proves the lowered principal, authenticated actor, recorded
  definer, carried surface, and ordinary owner/fertile object policy;
- restore itself is a safety boundary: every inverse is attempted, an inverse
  failure cannot mask the behavior error, and an instance whose restore failed
  becomes poisoned rather than serving partially restored state;
- staged durable acceptance cannot cross persistence deferral silently. The
  composition refuses while the outer journal is live instead of returning an
  accepted in-memory result with no storage record;
- the first post-fix legibility failure was not another rollback defect:
  cross-log Acts genuinely cross incompatible semantic spaces. The Acts
  catalog now reports the specific `E_SCOPE_SPLIT` refusal rather than
  misclassifying it as `E_INVARG`;
- detached public world views made several fixture mutations into silent
  no-ops. Fixtures now use the supported flag/verb-metadata seams, and the
  shared workerd fixture asserts the serialized partition cell that the
  authority actually receives;
- fake-DO fixture teardown is part of the correctness boundary. Deferred
  tasks are drained to quiescence before SQLite closes, and deferred rejection
  is propagated into the test result rather than printed after a green run;
- the later MCP argument-validation fixture repeated the old teardown defect:
  raw `waitUntil` promises, a single queue pass, synchronous close, and
  unawaited `finally` calls produced a late `database is not open` error during
  target integration. It now uses the same bounded quiescence and
  deferred-failure discipline;
- the data-path analyzer now classifies all native-atomicity and post-accept
  metric kinds. Its test derives the current `MetricEvent` vocabulary so a new
  unclassified smoke-tail event fails the reporting gate.

### Measured bridge cost

The rejected eager full-world snapshot grew with untouched state and was
measured at roughly 16.8 times the warm-world baseline. The implemented lazy
journal removed that scaling:

- at 100, 1,000, and 5,000 objects, median no-op direct calls were about
  `0.011 ms`, writes `0.015–0.016 ms`, and post-write failures
  `0.027–0.029 ms`;
- a 100-row accept/abort measured `0.353/0.382 ms` with exactly 100 undo
  categories;
- a compound abort measured `2.182 ms`, and SQLite abort `0.303 ms`;
- on the exact 5,000-object comparison base, candidate no-op/write/failure
  measured `0.010/0.014/0.026 ms` versus the former eager path's
  `1.792/1.665/2.159 ms`.

These microbenchmarks establish the local algorithmic boundary. The load and
workerd lanes below are also green. Deployed NC8/Analytics Engine evidence
still requires separate deployment authorization.

### Local validation evidence

The final isolated branch passed the complete local ladder:

| Lane | Result |
|---|---|
| Adversarial remediation focus (11 files) | 248/248 |
| `npm run typecheck` | passed |
| `npm test` | 88 files, 1,063/1,063 |
| `npm run test:worker` | 49 files, 393/393 |
| `npm run test:full` | 169 files, 2,124/2,124 |
| `npm run load:net-dev` | 3/3 |
| `npm run load:net-skew` | 6/6 |
| `npm run smoke:net-dev` | 44/44 |
| `npm run smoke:net-mcp` | 17/17 |

Adversarial reversion proved the late integration tests are causal:

- restoring permissive proof retention leaves the transient
  `{ counter: 2, version: 2 }` read in the failed transcript and fails the
  authority-acceptance test;
- reverting semantic dependency invalidation retains inherited property and
  aliased/descendant dispatch proofs after a rolled-back lineage or definition
  change, while dropping the independent incompleteness marker launders an
  invalidated native dispatch; each focused probe fails on its corresponding
  reversion;
- restoring the shadow lifecycle presence sentinel/no-op applier rejects the
  successful `chparent` control turn with lifecycle value mismatches and
  `permission_denied` instead of materializing the accepted lineage;
- before authenticated task-permission lowering, a genuine installed
  `$builder:create` is rejected as `writer frame not recorded`; with only that
  fix it is still rejected as `no recorded authority can create`. The complete
  surface proof accepts real non-programmer create/reparent turns, while the
  forged-marker control remains terminally refused;
- bypassing runtime consumption of the field classification admits a
  classified effect with no inspector, while omitting the Net extension
  classification rejects a legitimate Net transcript; the respective grammar
  tests fail;
- restoring unconditional programmer-surface audit emission fabricates
  `{attached:true}` on repeated grants when no surface is published and fails
  the audit test;
- checking only the innermost behavior scope lets the outer-write command
  transfer evade `E_SCOPE_SPLIT` and fails the nested-transfer test;
- omitting a native classification or its failure contract fails the
  registry-exhaustiveness guard;
- removing the AP11 explicit-demotion conflict re-promotes the deliberately
  demoted agent, while removing the registered fully-stripped ambiguity check
  guesses toward privilege restoration; the corresponding local and Net
  repair tests fail;
- bypassing the dry-run review token lets a changed local or Net repair plan
  apply without renewed operator review, and issuing a fresh token in a stale
  Net conflict makes the unreviewed replacement transferable; each pinning
  test fails;
- raising the bounded Net repair member limit reaches the catalog authority
  instead of refusing either an oversized source container or an oversized
  de-duplicated union, failing the pre-RPC tests;
- removing the exclusive repair lease lets a repair overlap a live local
  repository and fails the live-server refusal test;
- allowing deferred staged acceptance to fall out of scope makes the
  persistence-deferral test return instead of throwing;
- restoring fail-fast inverse replay lets `E_TEST_UNDO` mask
  `E_TEST_ORIGINAL` and fails the poisoned-rollback test;
- retaining a poisoned shadow world in the execution cache fails the host-level
  reload test after the accepted error frame;
- reinstating the detached public-view metadata write makes the serialized
  workerd-fixture test fail; and
- reverting created-object proof pruning exposes reads and dispatch proof for
  an identity erased by rollback and fails the native rollback suite.

`npm run load:net-canary`, `npm run metrics:net-ae`, and the deployed
walkthrough were not run: they require deployment/external acceptance state,
and this task did not authorize a deployment. Therefore the local branch is
implementation-complete, while production rollout and the deployed NC8 gate
remain open release steps.

## Executive decision

Woo should not adopt "writes before a throw commit" as a general native
primitive rule.

The intended rule is:

> A behavior failure commits no behavior-domain effects inside one authority.
> A sequenced failure commits only its sequencer allocation, durable failed
> outcome, and one canonical `$error` observation. Effects already accepted by
> another authority are outside that rollback boundary and require an explicit,
> idempotent saga.

This is already the rule for sequenced calls in
[`spec/semantics/space.md`](../spec/semantics/space.md) §S2–S3 and
[`spec/semantics/failures.md`](../spec/semantics/failures.md) §F6. Direct calls
attempt the same rule, but their snapshot is incomplete. Net planning records
effects that the local behavior savepoint subsequently rolls back, so a failed
turn can still submit those effects for authoritative commit.

The atomicity paragraph added to
[`spec/identity/provisioning.md`](../spec/identity/provisioning.md) §AP11.3
accurately describes the implementation observed during the production repair,
but it should be corrected rather than generalized. AP11 should still preflight
every knowable precondition and remain idempotent: rollback protects ordinary
behavior failure, while preflight improves diagnostics and idempotency protects
crash/retry and cross-authority boundaries.

The principled close is one transactional behavior-effect journal. Committed
journal entries become the sole source for local materialization, persistence,
and Net effect transcripts. Aborted journal entries cannot reach an authority.
Until that construction replaces the current layered snapshots, authority-side
transcript validation must make partial failed turns uncommittable.

## Scope and method

The audit followed every native primitive that can mutate tracked state and
looked for a reachable throw or rejected promise after the first mutation.
Findings were confirmed with source-local probes, including in-memory and
SQLite restart checks where persistence mattered. Existing focused tests were
also run:

```
npm run test:files -- \
  tests/programmer-surface.test.ts \
  tests/operator-wizard-provision.test.ts \
  tests/moveto.test.ts \
  tests/programmer-eval.test.ts
```

All 62 tests passed. They do not exercise the failure boundaries below.

No destructive negative probe was run against production. The production
walkthrough established that the repaired wizard is healthy, but it cannot
establish that other authorities contain no historical partial state.

## Findings

| Priority | Finding | Proven consequence |
|---|---|---|
| P1 | Failed sequenced turns retain rolled-back effects in their transcript | Net can commit state that the planning world rolled back |
| P1 | Direct calls use an incomplete rollback snapshot | Failure can leave lineage, versions, objects, sessions, and other state changed; SQLite can later persist it |
| P1 | Programmer transitions validate `features` after mutating state | Promote, demote, and revoke can return `E_TYPE` with hybrid state that retry does not repair |
| P2 | Programmer-agent creation checks surface composition after allocation | A surface collision can leak an unregistered, credential-less actor |
| P2 | Session cleanup callbacks participate in the semantic transaction | A callback rejection reports failure after closing sessions, while other state is rolled back |

### F1. A failed sequenced turn can submit behavior writes

`World.applyCall` reserves `next_seq` before opening the behavior savepoint.
That is intentional: a behavior failure consumes a sequence and becomes a
durable applied error. The verb body then runs under `withBehaviorSavepoint`,
and its local mutations are restored if dispatch throws.

Turn recording is outside that behavior savepoint. In
[`src/core/effect-transcript.ts`](../src/core/effect-transcript.ts), writes,
creates, moves, session-scope transitions, and observations are accumulated
before `turn_finish`. Only recycles, schedules, cancellations, and projection
writes are currently conditional on `turnFinishedOk`. Consequently the
transcript can carry both `error` and behavior-domain effects.

A probe wrote `delay_1.feedback = 77` and then raised `E_AUDIT_FAIL`.

- The local planning world correctly restored `feedback` to `0.35`.
- The applied frame contained only `$error`.
- The transcript still contained the intended
  `the_dubspace.next_seq: 1 -> 2` allocation.
- It also contained the rolled-back
  `delay_1.feedback: 1 -> 2, value 77` write.
- `transcript.error` was set.

Both Net authority implementations consume the transcript's effects and error
outcome: [`src/net/scope.ts`](../src/net/scope.ts) and
[`src/core/shadow-commit-scope.ts`](../src/core/shadow-commit-scope.ts).
Neither currently rejects this invalid combination.

This is more serious than a local rollback defect: the planner and authority
disagree about which effects exist, and the authority can make the discarded
effects durable.

### F2. Direct rollback is a hybrid, profile-dependent transaction

The direct route snapshots property values and placement around dispatch. It
does not use the full behavior snapshot.

The snapshot omits at least:

- property versions;
- lineage and object flags;
- object creation and deletion;
- session mutations;
- tombstones and projections;
- counters and other non-property structures;
- persistence dirty state.

This asymmetry was known and locally tolerated rather than wholly
undocumented. The `programmerEval` comment already says that
`directCallNow` restores only property writes and placement, which is why eval
adds the full behavior savepoint around code that may create, recycle, or
change sessions. The audit establishes that the same exposure is reachable
through ordinary native handlers, persists differently by profile, and can no
longer remain a special-case burden on individual callers.

An in-memory probe invoked programmer promotion with malformed `features`.
The call returned `E_TYPE`, but the actor remained programmer-flagged.
The account counter value was restored to `0`, while its value version advanced
from `1` to `2`.

The SQLite version of the probe later flushed dirty state and restarted with:

- `programmer = true`;
- programmer count value `0`;
- programmer count value version `2`;
- malformed `features` still present.

Net planning exposed the other side of the divergence: its transcript retained
both the lifecycle flag write and the account counter write. The same failing
operation therefore has three possible appearances: partially restored memory,
persisted hybrid SQLite state, or a complete set of pre-throw writes submitted
to Net.

### F3. Programmer lifecycle transitions throw after mutation

`setProgrammerAgentState` already calls `assertSurfaceComposable` to preflight
programmer-surface composition before mutation. The remaining ordering defect
is narrower: it does not validate the existing `features` value that surface
reconciliation will read. It currently:

1. changes lineage;
2. updates the account programmer counter;
3. reads and validates `features`.

`featureList` raises `E_TYPE` for a non-list or invalid element. The first such
read occurs during reconciliation after the flag and counter writes. That
creates a reachable residual throw after mutation in promotion, demotion, and
revocation despite the existing surface-collision preflight.

Confirmed results with malformed `features` were:

- promote: `E_TYPE`, `programmer = true`, programmer count `0`;
- demote: `E_TYPE`, `programmer = false`, programmer count `1`;
- revoke: `E_TYPE`, `programmer = false`, programmer count `1`, agent count
  `1`, no deactivation or retirement marker, and the API key still active.

Retry does not converge. The malformed property remains, and the next attempt
can observe that the flag transition has already happened before encountering
the same validation error.

`setObjectFlags` has the same ordering shape: it changes lineage and only then
reconciles features. A malformed feature list produced `E_TYPE` while leaving
the wizard flag set. `set_actor_flag` also adjusts its counter separately from
the lineage/feature transition, increasing the opportunity for drift.

### F4. Programmer-agent creation can leak an actor

`createAgentForHuman` allocates an actor and sets its flags before calling
`attachProgrammerSurface`.

A probe added an `eval` verb to `$agent` that conflicts with the programmer
surface. Creating a programmer agent returned `E_INVARG`, but left `agent_3`
with:

- parent `$agent`;
- the human as owner;
- `programmer = true`;
- empty features;
- no API-key identifier;
- no entry in `account.actors`;
- unchanged account agent and programmer counters.

The surface collision is knowable before allocation. The inherited `$agent`
shape, the selected feature surface, and its verb composition should be
validated as a creation plan before an object ID is consumed.

### F5. Session cleanup callbacks can turn success into reported failure

`revoke_api_key` and `deactivate_actor` mutate domain state, close sessions, and
then await `onSessionsEnded`. A rejected callback is treated as primitive
failure.

Confirmed results with a rejecting callback were:

- key revocation returned `E_INTERNAL`; the key was restored as active, but its
  session remained closed;
- actor deactivation returned `E_INTERNAL`; `deactivated_at` was restored, but
  its session remained closed.

No current production caller passing this callback was found, so this is a
latent API-level defect rather than a demonstrated production incident.
Transport notification or connection closure is a post-accept, best-effort
effect. It must not decide whether the authoritative mutation succeeded.

## What was examined and not filed separately

The following paths do not currently establish another native exception defect:

- movement admission errors occur before the physical move;
- ordinary `exitfunc` and `enterfunc` failures are deliberately swallowed by
  the documented movement semantics;
- sparse-state `E_NEED_*` signals are caught during plan repair before commit;
- guest reset is idempotent forward progress across its item moves;
- read-only primitives and primitives with a single final write have no
  reachable post-mutation throw;
- the AP11 operator repair is deliberately rerunnable.

Key rotation has a possible later failure only if an anchor invariant is
already corrupt. It belongs in the failure matrix and should gain preflight,
but the audit did not prove an independent normal-state finding.

Catalog installation and update inherit F1 if they throw after a recorded
mutation. The audit did not prove a distinct normally reachable catalog throw,
so the systemic transcript correction should cover them rather than adding a
handler-specific patch.

## Normative failure model

The route and phase must determine what may survive:

| Route / failure point | Sequence or request outcome | Domain effects | Observations |
|---|---|---|---|
| Direct, before behavior acceptance | No accepted turn | None | Direct error only |
| Direct, behavior throws | Failed call | None | Error response; no pre-error domain observations |
| Sequenced, before sequence allocation | No sequence | None | Rejection, no applied frame |
| Sequenced, behavior throws after allocation | Sequence and failed log outcome commit | None | Exactly one canonical `$error` |
| Either route, final authority/storage commit fails | No accepted commit | None | Storage rejection |
| Cross-authority child operation was already accepted | Child authority keeps its accepted effect | No false local rollback claim | Parent records failure and resumes an explicit saga |
| Post-accept live delivery fails | Authoritative result remains accepted | Committed effects remain | Retry/metric; never convert to behavior failure |

"Domain effects" includes property values and versions, lineage, lifecycle,
placement, session state, tombstones, projections, schedules, cancellations,
and domain observations. The sequenced `next_seq` allocation and failed log
outcome are envelope effects, not behavior-domain effects.

The spec should use the same language for direct and sequenced calls:
single-authority behavior is atomic; cross-authority work is not implicitly
atomic; post-accept live work is not part of the semantic transaction.

## Remediation strategy

### Phase 0: align the specification before implementation

1. Correct §AP11.3's partial-commit statement. Preserve its requirements to
   preflight knowable conditions and make the repair rerunnable.
2. State direct-call behavior failure semantics explicitly alongside the
   sequenced rule.
3. Define the envelope/behavior/post-accept phases and the allowed failed
   transcript shape.
4. Define the contract for any future cross-authority mutation: either refuse
   before mutation, as programmer provisioning currently does with
   `assertProgrammerProvisioningColocated`, or explicitly opt into a saga with
   durable step state, stable operation IDs, and convergence rules.

This is a semantic correction, not a catalog behavior change.

### Phase 1: characterize the failed-transcript grammar in observe mode

Do not enable terminal rejection against the current planner. Today a normal
sequenced behavior that writes and then raises produces exactly the invalid
error-plus-effects shape. Enforcing the target grammar before recorder rollback
lands would turn every such applied error into a terminally uncommittable turn.
That is an availability regression, not containment.

First add the same validator to both authoritative transcript consumers in
**observe/log-only mode**. It must never change the submit verdict. Emit only
bounded, non-sensitive shape data:

- route and transcript schema/generation;
- whether this scope owns the sequencer allocation;
- error code and outcome category;
- counts or booleans for reads, writes, creates, moves, recycles, schedules,
  cancellations, session transitions, projections, observations, logical
  inputs, state probes, and untracked effects;
- the proposed validation result and reason.

Do not log values, arguments, observation bodies, credentials, or other user
data. Establish a corpus from focused unit tests, `test:worker`, both workerd
smokes, and—only with separate deployment authorization—a canary observation
window. Include at least: resolution failure before dispatch, write then throw,
observe then throw, movement/session-scope mutation then throw, scheduler
failure, and catalog/native failure.

Use that corpus to ratify the grammar. The expected distinction is:

- **Envelope and proof data may remain:** call identity, route, scope, sequence,
  `error`, reads (including dispatch proofs), state probes, and deterministic
  logical inputs needed to validate the failed outcome. Whether `complete`,
  `incompleteReasons`, or `untrackedEffects` can be accepted must be decided
  from their actual trust meaning and observed shapes, not assumed.
- **Sequencer-owner envelope effect may remain:** the exact `next_seq`
  allocation for the declared space and sequence, plus the failed durable log
  outcome and exactly one canonical `$error` observation. A scope that does not
  own the sequencer must not invent that allocation.
- **Behavior-domain effects may not remain:** property or lifecycle writes,
  creates, moves, recycles, session transitions, projections, schedules,
  cancellations, deferred host effects, or pre-error domain observations.
- **Response restoration metadata remains legal but is not a transcript
  effect:** for example, `meSnapshot` can return the `active_scope` overlay with
  `restore: true` when session scope differs from physical location
  (`world.ts:5985-5987`). Response assembly must preserve that recovery context;
  authority admission must neither mistake it for a committed session
  transition nor include it in the effect grammar.

The existing sequenced-allocation validation in both scope implementations is
the natural basis for the envelope check. Hand-built transcript tests must
prove both observe and enforcement modes independently of the planner.

### Phase 2: land producer correction and authority enforcement safely

Recorder rollback and terminal enforcement are one correctness change, not two
independently deployable phases. They may land in one branch and release, or
enforcement must remain observe-only until corrected producers are live.

As an immediate correctness bridge:

- give turn recording a behavior checkpoint;
- abort recorder effects when the behavior savepoint aborts;
- append the sequencer allocation and canonical error outcome outside that
  checkpoint;
- replace the direct route's partial rollback with a savepoint that covers
  every authoritative state category;
- deliver deferred host effects only after semantic acceptance.

The direct bridge must be selected by measurement. The current
`withBehaviorSavepoint` clones the full object and session tables, snapshots,
tombstones, counters, guest pool, and persistence-dirty state. `directCallNow`
is on the hot path for direct tools and command planning. Unconditionally
wrapping it in that full snapshot can make turn cost scale with unrelated
authority state and reopen the NC8 latency envelope.

Before choosing the bridge, benchmark the current partial snapshot, the full
savepoint, and a copy-on-first-write alternative on loaded authorities across
at least:

- increasing total object/session counts with a constant one-object mutation;
- increasing touched-object counts with constant total authority size;
- success and post-first-mutation failure;
- create/recycle, lineage, placement, session, tombstone, schedule, and
  persistence-dirty mutations;
- wall time, CPU time, allocation/heap pressure, and p50/p95 distribution after
  warmup.

Prefer a copy-on-first-write savepoint when the full snapshot grows with
untouched state or materially consumes NC8 headroom. This is not the forbidden
effect-kind allow-list: it captures the prior value of each state container at
the mutation seam on first write, then restores those captured deltas on abort.
It must cover all authoritative mutation seams, with a test per state category.
If neither bridge meets the correctness and latency gates, stop rather than
shipping the full snapshot as an unmeasured temporary regression.

Run each local load shape repeatedly to establish baseline variance. Passing
the absolute 750 ms NC8 ceiling is necessary but not sufficient: if the
candidate's p95 regression exceeds the baseline's observed run-to-run range,
stop for redesign or an explicit operator latency decision. Do not silently
spend nearly all remaining headroom because the point estimate is still below
the ceiling.

Operational rollout must account for stale Durable Object isolates:

1. Deploy or run authority validation in observe-only mode.
2. Deploy corrected recorder/direct producers with a versioned transcript
   capability or generation marker covered by the transcript hash; keep
   enforcement observe-only for unmarked producers. The marker selects rollout
   policy, not trust: the authority still validates every claimed-clean shape.
3. Re-probe after DO cycling and require the canary corpus to show no unexpected
   failed shapes from marked producers.
4. Enable terminal `invalid_error_effects` rejection for the marked generation.
5. Enforce it for all producers only after the prior generation is retired.

The final invalid shape is terminal and non-retryable: replanning the same
buggy behavior is not progress. The staged mode prevents that rule from
becoming a deployment-order outage.

Do not close F1 by adding more `turnFinishedOk &&` conditions field by field.
That is an effect-type allow-list: the next recorded effect kind can silently
reopen the defect.

### Phase 3: fix the proven native orderings

Preflight is defense in depth even after rollback becomes complete.

For programmer state:

1. Read and validate the existing feature list before mutation.
2. Retain the existing programmer-surface composability preflight.
3. Compute the next lineage, feature list, counter delta, and audit result
   without mutation.
4. Apply the validated plan inside the behavior transaction.
5. Share this transition planner with `setObjectFlags` and `set_actor_flag` so
   their ordering cannot drift.

The implemented planner is now genuinely shared: `setProgrammerAgentState`
calls `prepareObjectFlagPlan` and `applyObjectFlagPlan`, computes the account
counter before apply, and suppresses only the raw wizard audit so it can emit
the profile-aware transition audit afterward. `$system:set_actor_flag` routes
account-bound programmer changes through that same method; the generic
`setObjectFlags` path uses the same plan/apply pair without quota accounting.
Malformed-feature promote, demote, and revoke tests invoke each operation twice
under distinct request ids and prove the complete serialized state, including
cell versions, is identical after both refusals.

For programmer-agent creation:

1. Validate the requested name, quotas, credential inputs, inherited `$agent`
   shape, default feature shape, and programmer-surface composition.
2. Allocate only after the plan is complete.
3. Create, register, count, and credential the actor in one behavior
   transaction.

For key rotation, validate replacement-key and anchor invariants before
revoking the old key, then commit both sides together within the authority.

For session cleanup, return the accepted semantic result before invoking the
notification/transport callback. Execute the callback post-accept,
best-effort, with a metric and bounded retry where useful. A callback failure
must not rewrite the accepted domain result.

### Phase 4: close the class by construction

Introduce one `TurnEffectJournal` (name illustrative) with explicit behavior
transactions:

```
envelope.begin()
behavior.begin()
try:
    run behavior
    behavior.commit()
except:
    behavior.abort()
    envelope.recordCanonicalError()
authority.commit(envelope + behavior.committedEffects())
postAccept.runBestEffort()
```

The journal records the before/after information required for:

- property values and property versions;
- lineage and feature composition;
- object creation, recycling, and tombstones;
- placement and contents;
- sessions and active scope;
- account and system counters;
- schedules and cancellations;
- projection writes;
- observations and deferred host effects.

Its committed entries are the sole source for:

1. applying or undoing in-memory state;
2. materializing SQLite/local persistence;
3. constructing the Net effect transcript.

There must not be one structure that decides local rollback and another that
decides remote commit. The corpus-ratified envelope and proof fields—potentially
including reads, dispatch proofs, state probes, and logical inputs—may remain in
an error transcript when required for authority validation, but an aborted
behavior contributes no effects. Response-only recovery metadata such as a
session-scope restore overlay remains outside this journal and transcript
grammar.

This construction provides the primary guarantee. Authority admission remains
as a trust-boundary backstop against stale or defective planners.

### Phase 5: make native failure discipline declarative

Keep transcript eligibility separate from a complete built-in native failure
registry. Every built-in registration declares `read_only`, `authoritative`, or
`live_only`; every non-read-only handler declares its failure boundary. A
representative shape is:

```ts
failure: {
  mutation_scope:
    | "single_authority"
    | "durable_progress"
    | "cross_authority_saga"
    | "live_only";
  on_error: "rollback" | "idempotent_progress" | "best_effort";
  post_commit?: string[];
}
```

Contract rules:

- `single_authority` mutations use `rollback`;
- `durable_progress` retains only bounded, idempotent progress with a
  re-derivable retry plan. Catalog update uses this class: completed migration
  steps and `migration_state` survive a later step refusal while the published
  version remains held back;
- `cross_authority_saga` documents durable progress markers, stable operation
  identity, retry behavior, and terminal repair;
- `live_only` and `post_commit` work cannot create authoritative domain writes
  or turn accepted behavior into an error;
- every tracked mutating native has a negative test that throws or rejects
  after its first possible mutation;
- the fast guard derives the handler vocabulary and mutation class from
  `registerBuiltinNativeHandler` call sites, rejects direct unclassified
  registrations, and fails when any authoritative or live-only handler omits a
  declaration. An untracked handler remains refused on Net even though its
  local failure semantics are explicit.

Critical handlers should use a shared prepare/apply form: prepare may read and
raise but cannot write; apply consumes a validated plan and should contain no
ordinary validation throws; external live work is returned as a post-accept
effect.

This remediation does not build a general saga runner. No proven finding in
this audit requires one, and programmer transitions currently refuse
non-colocation before mutation. The declarative contract reserves the category
and prevents an implicit cross-authority mutation from being mistaken for an
atomic one. The first operation that genuinely needs a saga must specify and
test its concrete runner separately.

## Historical-state audit and repair

No catalog-version migration is required merely to change runtime failure
semantics. A global scan would violate Big-World discipline and is neither
necessary nor acceptable.

Historical partial state is nevertheless possible. Provide a bounded,
idempotent diagnostic and repair operation per owning authority/account. It
should support dry-run before mutation and check:

- actors owned by the account versus `account.actors`;
- `agent_count` and programmer count versus live and retired actors;
- programmer/wizard flags versus feature-surface shape;
- current credential pointers versus revoked credentials;
- deactivation and retirement markers;
- unregistered actors matching the failed-create shape.

Repair only facts whose intended state is unambiguous. An orphan created by a
failed operation can be retired/recycled only with evidence tying it to that
operation. A malformed feature list may require an operator decision; report
the exact object and conflict rather than inventing user intent. The AP11
provisioning ledger is historical evidence, not a perpetual capability grant:
a wizard agent whose programmer flag is now false, or whose reversible
deactivation marker is set, is a conflict rather than a repair candidate.

For Net, expose the operation through an authenticated, signed operator route
and constrain it to the addressed authority/account. For SQLite, require an
offline exclusive world lease before reading even in dry-run mode, then run the
repair inside a real transaction/savepoint and test it on a local database.
Repeated runs must report no further changes.

Pure property-version drift is monotonic coherence bookkeeping. Once the value
is correct, do not rewrite versions merely to make them look as though the
failed attempt never occurred.

The successfully repaired production wizard and recycled walkthrough widget
show no known residue from the reported operation. They do not justify assuming
that unrelated worlds are clean.

## Required test matrix

Add focused negative tests before changing behavior. Each must first reproduce
the defect and then fail when the corresponding remediation is reverted.

| Case | Required assertion |
|---|---|
| Direct property write then throw | Value and property version are unchanged |
| Direct lineage and counter write then throw | Flag, features, counter value, and versions are unchanged |
| Direct create then throw | No object, registration, credential, or counter residue |
| Direct session/tombstone/recycle mutation then throw | All authoritative state is unchanged |
| Sequenced write and observe then throw | Transcript and cold replay retain only sequence allocation plus one `$error` |
| Invalid hand-built error transcript, observe mode | Both Net scope implementations emit the same bounded reason without changing the verdict |
| Invalid hand-built error transcript, enforcement mode | Both Net scope implementations reject it terminally |
| Valid failed-transcript proof metadata | Reads, dispatch proofs, state probes, and ratified logical inputs remain accepted without becoming domain effects |
| Failed call followed by `meSnapshot` | The legitimate `active_scope` restore overlay is returned as response metadata and is absent from transcript effects |
| Rejecting post-accept callback | Accepted mutation remains accepted; callback failure is measured |
| Malformed-feature promote/demote/revoke | Each rejects before mutation and retry is a no-op |
| Programmer-surface collision on create | No object ID or account state is consumed |
| SQLite delayed flush and restart | Restarted state matches the pre-call state |
| Fake-DO cold reconstruction | Authority state matches the failed transcript contract |
| Cross-authority programmer transition | Colocation refusal happens before mutation |
| Savepoint cost versus authority size | Candidate p95 stays within repeated-baseline variance and all NC8 absolute gates while touched state remains constant |
| Mixed producer/authority generations | Old producers remain observe-only; marked corrected producers enforce without retry loops |

The negative tests must cover the journal and the authority independently.
Otherwise a planner fix can mask a missing trust-boundary check, or vice versa.

Run the validation ladder in increasing fidelity:

1. targeted files, including new native-exception, recorder, scope, programmer
   lifecycle, operator provisioning, SQLite, and savepoint-cost tests;
2. `npm run typecheck`;
3. `npm test`;
4. `npm run test:worker`;
5. `npm run test:full`;
6. `npm run load:net-dev`;
7. `npm run load:net-skew`;
8. `npm run smoke:net-dev`;
9. `npm run smoke:net-mcp`.

Cloudflare deployment and the deployed walkthrough require separate explicit
authorization. If deployment is authorized, baseline and candidate runs must
also include `npm run load:net-canary` and `npm run metrics:net-ae`. The NC8
acceptance remains p95 wall time at or below 750 ms, wall p99 at or below the
5,000 ms RPC-timeout ceiling, queue p99 at or below one second, and zero
timeouts, refusals, or integrity gaps; a functional smoke cannot substitute for
that evidence. Compare the candidate window to a same-shape baseline and its
observed variance so a technically passing but materially regressed p95 is
refused rather than merely made visible.

After deployment, re-probe after Durable Objects have cycled before treating a
negative capability result as evidence. Enforcement remains generation-gated
until the corrected producer is demonstrated live and the observe corpus has
no unexplained shape.

## Completion criteria

The class is closed only when all of the following are true:

- the direct and sequenced specs state one intra-authority rollback rule;
- §AP11 no longer presents partial native commit as intended semantics;
- failed direct behavior restores every authoritative effect category;
- failed sequenced behavior cannot contribute domain effects to a transcript;
- a real failed-transcript corpus defines the accepted envelope/proof grammar
  without logging user payloads;
- both authorities observe the same invalid shapes before either is allowed to
  reject them;
- corrected producers and terminal authority enforcement are rolled out without
  a generation window that makes ordinary failed turns uncommittable;
- both authorities reject an invalid error/effect combination once its producer
  generation is enforceable;
- local state, SQLite restart state, planned transcript, and cold authority
  reconstruction agree for the same failure;
- direct rollback cost is measured on loaded authorities and does not violate
  NC8 or scale unacceptably with untouched state;
- the five proven handler cases reject before mutation or defer failure-prone
  live work until after acceptance;
- every mutating native declares and tests its failure discipline;
- the bounded historical diagnostic and repair is idempotent;
- all relevant test, load, and workerd lanes pass; when deployed validation is
  authorized, the canary load and Analytics Engine gates also pass.

The endpoint is not "all known handlers were reordered." It is that an aborted
behavior has no representable path to authoritative commit.
