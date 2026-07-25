# Repository workspaces: content, changes, and connector backends

*Origin: 2026-07-22. Discussion draft, not a spec or implementation
commitment. Companion to
[`2026-07-21-acts-projection-model.md`](2026-07-21-acts-projection-model.md),
[`2026-07-21-acts-composition-vision.md`](2026-07-21-acts-composition-vision.md),
and [`2026-05-05-block-and-plug.md`](2026-05-05-block-and-plug.md). This
note explores repository-backed task work, using GitHub as the first external
system and Cloudflare as the default global deployment profile. Cloudflare is
optional: local development and non-Cloudflare deployments are first-class
constraints on the design.*

---

## 1. Decision under discussion

A repository-connected task surface is not only a board synchronized with
issues and pull requests. The agents and humans doing those tasks need to
browse, modify, test, review, and publish the repository's content. The GitHub
workspace should therefore expose two connected graphs:

1. the **coordination graph** — tasks, claims, dependencies, reviews, checks,
   decisions, and publication intent; and
2. the **Git graph** — commits, trees, blobs, refs, and diffs.

They meet through immutable references. Repository bodies do not become
projection rows, and file edits do not become acts.

The proposed product object is a repository workspace room:

```text
$github_workspace < $room
  + $acts
  + repository-content feature
  + task/review/publishing features

  contains or references:
    $github_connector < $block       authenticated plug principal
    $task artifacts                  work orders
    $code_workspace handles          durable working copies
    $change_set artifacts            immutable proposed results
    projections                      board, correlation, review, outbox
```

The workspace is what people and agents enter. The companion block represents
the external connector principal, configuration, and current health. This is
one user-facing appliance/workshop even though the runtime keeps place and
credentialed principal as two objects: `$room` descends from `$space`, while
`$block` descends from `$actor`, and woo has single inheritance.

This is intentionally larger than the current Tasks `source_ref`, which is an
opaque provenance pointer. A URL can say where a task came from; it cannot
represent a base revision, durable working copy, proposed head, test evidence,
or publication lifecycle.

---

## 2. Goals and anti-goals

### Goals

- Make repository content naturally available in the room where repository
  work is coordinated.
- Give an agent a durable working copy whose lifetime follows the task or
  change, not the process or agent session.
- Preserve a clean authority boundary between GitHub, workspace storage,
  execution sandboxes, and woo coordination state.
- Make handoff real: another authorized actor can continue from the same
  committed workspace without inheriting a process or secret.
- Permit Cloudflare-native scale in the default global deployment without
  requiring Cloudflare for local development or self-hosting.
- Use ordinary Git clients and object identities wherever possible.
- Keep large trees, file bodies, diffs, logs, and high-rate edit activity out
  of the woo object graph and sequenced log.
- Expose one semantic interaction surface even when a deployment uses a
  hard-wired local implementation instead of a dynamically pluggable backend.

### Anti-goals

- One woo object per repository file or directory.
- Copying complete diffs, file contents, or test logs into acts or projections.
- Treating a mutable branch name as the identity of submitted work.
- Giving ordinary agents a long-lived GitHub write credential.
- Making Cloudflare Artifacts, Sandbox, Queues, R2, or Durable Objects part of
  the substrate's repository semantics.
- Forcing every provider into a lowest-common-denominator implementation.
- Transparent failover between unrelated Git stores. A workspace is pinned to
  one store; moving it is an explicit, evidenced operation.
- Running untrusted repository code in the woo VM or connector Worker.

---

## 3. Three planes, three authorities

| Plane | Authority | Holds | Does not hold |
|---|---|---|---|
| **Coordination** | woo room log + projections | tasks, leases, waits, review decisions, workspace lifecycle, publication intent | file bodies, mutable checkouts, secrets |
| **Content** | canonical Git remote and durable workspace store | commits, trees, blobs, refs, task forks | task policy, approval authority |
| **Execution** | authorized sandbox/process | mutable checkout, dependencies, builds, tests, temporary output | durable coordination truth |

The common global profile is:

```text
GitHub repository (canonical upstream)
        ^
        | publish/fetch through GitHub connector
        v
Cloudflare Artifacts baseline
        |
        | fork at an exact base revision
        v
per-task Artifacts repository
        |
        | short-lived repo-scoped capability
        v
Cloudflare Sandbox checkout

woo repository room
  - records semantic milestones as acts
  - projects task/review/publish state
  - references immutable base/head revisions and evidence
```

The local profile substitutes a local bare repository plus local worktree or
clone and a local process/container executor. The semantic contracts and act
vocabulary stay the same.

### 3.1 Source-of-truth rules

- **GitHub is authoritative** for its repository refs, issues, pull requests,
  reviews, and merge result.
- **The selected workspace store is authoritative** for unpublished task
  commits. In the default global profile this is Cloudflare Artifacts; in
  local development it is local Git storage.
- **Woo is authoritative** for task ownership, local obligations, approval,
  the association between a task and its workspaces/change sets, and the
  request to publish.
- **A sandbox checkout is a cache plus active work area.** Uncommitted files
  disappear with the sandbox unless the execution provider explicitly offers
  a snapshot mechanism. Durable handoff begins at a pushed checkpoint.
- **A projection never mirrors Git content.** It stores object references,
  bounded identifiers, status codes, and sequence watermarks.

---

## 4. Stable reference model

The provider-neutral contract needs a few small identities. Names below are
conceptual; the final catalog/schema spelling is deferred.

```text
RepositoryRef {
  provider: bounded code,
  repository_id: opaque stable id
}

RevisionRef {
  repository: RepositoryRef,
  oid: immutable Git object id
}

SourceLocation {
  revision: RevisionRef,
  path: normalized repository-relative path,
  start_line?: positive integer,
  end_line?: positive integer
}

WorkspaceRef {
  workspace_id: opaque stable id,
  store: bounded provider code
}
```

All consequential operations pin revisions by object ID. A branch or tag may
ride beside the ID as a display label or resolution request, but the result of
resolution is an immutable `RevisionRef`.

### 4.1 `$code_workspace`

A code workspace is the durable workbench associated with a task or change:

```text
$code_workspace
  task                    object reference
  repository              RepositoryRef
  base_revision           RevisionRef
  storage_ref             opaque WorkspaceRef
```

The object's stable identity and external storage reference are artifact-like.
Mutable coordination state — opened, checkpointed, submitted, abandoned — is
projection-owned and folded from acts. Secrets and authenticated remote URLs
are never properties.

The default is **one durable workspace per task/change**, not per agent
session. Task ownership can move while the workbench remains. If two actors
need truly independent experiments, the domain verb creates two named
workspaces or a child task; sharing one mutable checkout implicitly is refused.

### 4.2 `$change_set`

Submission freezes an immutable proposed result:

```text
$change_set
  repository
  base_revision
  head_revision
  workspace
  diff_summary_ref?
  evidence_refs[]
  github_pull_request_ref?
```

Review and approval name the change set, not "whatever is currently on the
branch." A new head after review produces a new change set or an explicit
superseding version and invalidates approvals according to policy.

### 4.3 Promoted source artifacts

Repository files remain virtual resources. A file, range, diff, test report,
or build log becomes a woo artifact only when someone deliberately pins it as
evidence, a finding, or a deliverable. The artifact carries its immutable
source reference and provenance; it does not silently track a moving branch.

---

## 5. Interaction surface

Repository interaction has two different latency and durability classes. They
must not be forced through one mechanism.

### 5.1 Bounded content reads

These are direct, read-only resource operations. They do not emit acts:

```text
repo_tree(revision, path, cursor, limit)
repo_read(revision, path, byte_or_line_range)
repo_search(revision, query, path_filter, cursor, limit)
repo_diff(base_revision, head_revision, path_filter, cursor, limit)
repo_commit(revision)
repo_blame(revision, path, range)
```

Required behavior:

- every list/search/diff is paged and capped;
- every file response has byte and line limits plus an explicit truncation
  marker;
- paths are normalized repository-relative paths; absolute paths and `..`
  escape are refused;
- a requested symbolic ref is resolved once and the response includes its
  immutable object ID;
- binary and oversized objects return metadata plus a separate bounded fetch
  path rather than being embedded in a tool result;
- reads carry provenance and trust labels: checked-in text is external input,
  not automatically executable instruction.

The browser can use these operations for a lazy source tree, file viewer,
history, and diff panel. Agents need the same semantic resources. There is no
recursive materialization into woo objects and no world-wide repository scan.

### 5.2 Workspace and publication operations

These change coordination state and enter through typed room verbs:

```text
:open_code_workspace(task, base_revision)
:checkpoint_workspace(workspace, head_revision)
:submit_change(task, workspace, head_revision)
:record_verification(change_set, report_artifact)
:request_publish(change_set)
:abandon_workspace(workspace, reason_code)
```

The verb authorizes the actor, validates state, performs or queues the external
operation, and emits its fixed internal act. The plug never emits raw acts.
Long external work uses the Acts-era dispenser pattern: a command projection
owns the outbox; the connector drains it and calls typed success/failure verbs.

### 5.3 Execution handoff

Opening a workspace may return a non-secret capability handle. An authorized
execution broker exchanges that handle for a short-lived, least-privilege Git
credential and injects it into the sandbox. Prefer injection over returning a
secret through model-visible text. If a deployment cannot inject credentials,
it may return a one-time direct credential response, but that response is live,
redacted from logs, and never an act or durable object property.

Once provisioned, the agent uses ordinary filesystem, Git, build, and test
tools. Woo is not a remote shell and does not proxy every edit.

---

## 6. Lifecycle: issue to merged change

One representative path:

1. A GitHub webhook is verified, queued, deduplicated, and normalized by the
   connector. A typed workspace verb associates or creates the task.
2. An actor claims the task. The task lease remains woo's physical-location
   fact.
3. `:open_code_workspace` resolves the canonical upstream base to an exact
   commit and provisions an isolated durable workspace from that base.
4. An authorized sandbox receives a short-lived workspace credential, clones
   or mounts it, and performs edits/tests.
5. Intermediate local edits remain execution state. Pushed commits are Git
   state. An explicit checkpoint may update the room's bounded workspace view.
6. `:submit_change` verifies that `head_revision` exists in the named workspace
   and is descended from the declared base under the current policy, then mints
   a `$change_set` and emits `code.change_submitted`.
7. Review and verification attach evidence to that immutable change set.
8. `:request_publish` emits `code.publish_requested`; an outbox projection
   creates a durable command.
9. The connector fetches the submitted head, applies publication policy, pushes
   a GitHub branch, and creates or updates the pull request.
10. GitHub webhooks confirm the PR, checks, review, merge, or conflict. The
    corresponding typed verbs emit semantic acts and projections converge.
11. Retention policy archives or deletes the task workspace only after its
    referenced evidence has a durable home. A reference must not be left
    pointing at a deleted unpublished repository.

An upstream base moving does not silently mutate an open workspace. The board
can project `behind`, `conflicted`, or `rebase_required`. Rebase/merge produces
a new immutable head and invalidates prior review according to room policy.

---

## 7. Acts boundary

Candidate semantic acts:

```text
code.workspace_opened
code.workspace_checkpointed
code.change_submitted
code.verification_recorded
code.publish_requested
code.publish_succeeded
code.publish_failed
code.workspace_abandoned
github.pull_request_linked
github.pull_request_merged
```

Not acts:

- individual file writes or saves;
- shell commands;
- clones, fetches, and ordinary reads;
- every exploratory commit or push;
- full patches, file bodies, build logs, or test logs;
- mutable connector freshness/health ticks.

Git is already the detailed immutable history of the content plane. Acts record
what selected Git states mean to the work. Act payloads carry bounded codes,
object refs, and object IDs. Large or untrusted material is a referenced
artifact, following the Acts provenance contract.

Cloudflare Artifacts and other Git services may emit a notification for every
push. Those notifications are connector wakeups/current-state inputs. They are
coalesced into a bounded checkpoint or consumed when a domain verb explicitly
submits a head; they are not copied mechanically into the room log.

---

## 8. Provider contracts, not a Cloudflare dependency

The connector is a composition of five roles, not one monolithic "GitHub
backend":

| Port | Responsibility | Required minimum |
|---|---|---|
| `RepositoryReader` | Resolve refs; read commits, trees, blobs, and bounded diffs | immutable ref resolution + bounded tree/blob read |
| `WorkspaceStore` | Create isolated durable work from a base; report/fetch a head; retire it | create/open, resolve head, export/fetch head |
| `ExecutionProvider` | Supply a mutable filesystem and run tools under quotas | optional; external-agent handoff is valid |
| `Publisher` | Publish an approved change to the canonical upstream | optional for read-only/offline profiles |
| `RepositoryEventSource` | Notify about upstream/store changes | optional; bounded polling/manual refresh is valid |

These are semantic ports. They need not imply a runtime plugin framework in
the first implementation. A deployment profile may select hard-wired adapter
classes at build/configuration time. The value of the ports is that the room
verbs, act vocabulary, reference shapes, and tests do not change when the
implementation does.

Provider capabilities are explicit rather than guessed:

```text
can_fork
can_search
can_diff
can_execute
can_subscribe_push
can_publish
supports_private_upstream_import
```

A missing optional capability produces a smaller honest surface. It must not
silently change durability or authorization semantics. For example, a store
without cheap forks may clone a baseline into a new bare repo, but it still
returns an isolated `WorkspaceRef`; a deployment without an executor may allow
browse/review and hand an authenticated remote to an external agent.

Each workspace records its provider identity. There is no automatic mid-flight
fallback from Artifacts to local Git or from one remote to another. Migration
is an explicit copy with old/new heads verified and a semantic act recording
the replacement.

---

## 9. Deployment profiles

### 9.1 Default global: Cloudflare + GitHub

| Port | Default adapter |
|---|---|
| `RepositoryReader` | Artifacts baseline for Git-object reads; GitHub API/remote for canonical reconciliation |
| `WorkspaceStore` | Cloudflare Artifacts repository per task/change |
| `ExecutionProvider` | Cloudflare Sandbox/Container per authorized work session |
| `Publisher` | GitHub App connector with installation-scoped authority |
| `RepositoryEventSource` | GitHub webhooks + Artifacts event subscriptions/Queues |

Expected topology:

- Import or mirror a repository baseline at an exact GitHub commit.
- Keep the baseline read-only from ordinary task agents.
- Fork one Artifacts repository per task/change lifecycle. Cloudflare's own
  guidance recommends a repo per agent/session/task when isolation, cleanup,
  and access control differ.
- Mint short-lived repo-scoped read or write tokens only after woo authorizes
  the operation.
- Pair a task workspace with a Sandbox checkout for execution. The sandbox is
  replaceable; pushed Git state is the handoff boundary.
- Subscribe to `pushed` as a wakeup/checkpoint input when useful; ignore
  clone/fetch noise for coordination.
- Let only the GitHub connector hold upstream publication authority.

Cloudflare-specific API types, token formats, remote URLs, Queue events, and
Sandbox identifiers live in the external adapter. They do not enter acts,
catalog schemas, or `src/core`.

Cloudflare Artifacts is currently a beta service. This profile must be gated by
deployment configuration and conformance tests, not assumed available because
the main production host is Cloudflare.

### 9.2 Local development: local Git + local executor

Local development must work with no Cloudflare account, GitHub App, network,
or managed queue.

Recommended hard-wired local adapter:

```text
RepositoryReader   system Git against a local fixture/upstream repository
WorkspaceStore     local bare baseline + isolated per-task bare repo/worktree
ExecutionProvider local process or configured container, rooted in its worktree
Publisher         local target bare repo, or disabled
EventSource       explicit refresh plus optional filesystem/ref polling
```

Properties:

- Store all repositories/worktrees under one explicit configured data root;
  never infer a writable location from `$HOME`.
- Use stable workspace IDs as directory names after strict validation; keep
  display names out of filesystem paths.
- Invoke Git with an argument vector, never a shell-built command string.
- Disable submodule recursion, credential helpers, and repository-controlled
  hooks by default. Opt-in behavior belongs in a trusted execution image.
- Use one bare fixture as canonical upstream in tests. Tests create isolated
  temporary stores and never require network access.
- Local capability handles authorize operations before paths are resolved.
  Same-process access does not erase the domain authorization boundary merely
  because no remote token is necessary.
- A local worktree is disposable execution state; the local bare task repo is
  the durable workspace authority. Restarting the dev server must not lose a
  pushed checkpoint.

The implementation may simply use the installed `git` CLI. Requiring a fully
portable JavaScript Git implementation for localdev would add complexity
without improving the semantic contract. An in-process implementation remains
useful for constrained runtimes, but is a separate adapter.

### 9.3 Portable/self-hosted: generic Git service + container/process

A non-Cloudflare deployment may use GitHub, GitLab, Gitea, Forgejo, a managed
bare-repository service, or an operator-owned smart-HTTP/SSH Git server.

The expected shape is:

- canonical upstream chosen by the installation;
- a workspace namespace or repository prefix controlled by the connector;
- one isolated repo or protected branch namespace per task/change;
- short-lived or narrowly scoped credentials where the provider supports them;
- an OCI container, Kubernetes job, VM, or external agent runtime for
  execution;
- provider webhooks when available, otherwise bounded polling with explicit
  freshness.

This profile may initially be a small number of explicitly supported adapters,
not arbitrary user-supplied code. The conformance suite is more important than
dynamic loading.

### 9.4 Minimal/degraded: canonical remote only

A useful repository room can exist without a workspace store or executor:

- browse an immutable GitHub/local revision;
- attach source locations to tasks;
- review an externally produced commit or PR;
- correlate webhook state;
- accept an externally supplied `head_revision` after verifying it exists.

Creating an isolated workspace, running tests, or publishing may be unavailable
and should be absent/disabled with a reason. This is preferable to pretending
that a process-local checkout is durable.

### 9.5 Offline/local-only

For an offline project, a local bare repository is both canonical upstream and
workspace source. GitHub vocabulary and webhook behavior are not mounted. The
same task, change-set, review, and verification acts still apply; publication
means updating an authorized local ref or exporting a bundle/patch.

---

## 10. Security and trust boundaries

Repository access combines untrusted content, powerful tools, and write
credentials. The baseline must include:

1. **Secrets never enter the world.** GitHub installation tokens, Artifacts
   tokens, SSH keys, and authenticated remote URLs are not props, acts,
   observations, test evidence, or model-visible logs.
2. **Least privilege per workbench.** A task agent gets write access to its
   isolated workspace, read access to the permitted baseline, and no upstream
   write access. Publication is a connector operation after policy approval.
3. **Short lifetime.** Workspace credentials are minted per authorized session
   and expire. Handoff mints a new credential; it does not transfer the old
   actor's secret.
4. **Repository content is tainted input.** Source, comments, generated files,
   `AGENTS.md`, build scripts, and test output carry provenance. Merely naming a
   file like an instruction or policy document gives it no woo authority.
   Mounting code/practice into the world is a separate reviewed operation.
5. **Execution isolation.** Repository code runs only in the selected execution
   provider with CPU, memory, duration, network, filesystem, and secret limits.
6. **Safe Git invocation.** Validate ref/path shapes, use argv APIs, bound
   object/diff sizes, disable hooks and automatic submodule fetch by default,
   and treat symlinks and worktree escapes as hostile at file APIs.
7. **Immutable review target.** Approval names `(repository, base_oid,
   head_oid)`. Publishing verifies the same head; branch movement cannot reuse
   an old approval.
8. **No ambient credential helpers.** Local and hosted sandboxes use explicit
   injected credentials and scrub them on release.

---

## 11. Consistency and failure behavior

- **GitHub unavailable:** local/task work may continue and checkpoint; publish
  remains pending with visible connector health. No success act is invented.
- **Workspace store unavailable:** reads from another available reader may
  continue, but opening/checkpointing work refuses. A process-local checkout is
  not silently promoted to durable authority.
- **Executor unavailable:** browse, review, and publication of already-created
  change sets may continue. Build/test actions are absent or fail with a named
  capability error.
- **Webhook/event loss:** reconcile current refs/PR state by stable external ID.
  Delivery/event IDs deduplicate transport, not domain identity.
- **Duplicate command:** `command_id` is stable. Provision, checkpoint, and
  publish callbacks are idempotent; a retried publish first reconciles the
  target branch/PR.
- **Concurrent head movement:** checkpoint/submit uses compare-and-set against
  the expected workspace head or returns a named conflict.
- **Partial publish:** pushing a branch and creating a PR are not atomic. Record
  the branch result, retry PR creation idempotently, and let reconciliation
  converge or compensate.
- **Workspace deletion:** refuse deletion while live change sets depend on the
  workspace unless their head is proven durable elsewhere.
- **Provider loss:** references remain honest even when temporarily
  undereferenceable. They do not resolve to content from a different backend
  merely because its branch name matches.

Cross-system atomicity is not claimed. The invariant is that every woo
coordination transition is atomic within its room, while external operations
converge through idempotent commands, observations, and compensation acts.

---

## 12. MCP and client implications

The existing woo MCP surface exposes contextual bytecode verbs through
`tools/list` and `tools/call`. MCP resources are currently deferred. Repository
content is the first strong concrete requirement for a resource plane:

- resources/templates for immutable trees, blobs, commits, and diffs;
- tools for search, workspace provisioning, checkpoint, submit, verify, and
  publish;
- location-scoped discovery from the active repository room;
- identical authorization for listing and invocation/read;
- no recursive world enumeration.

Until that generic resource surface exists, the first agent path should be
capability handoff to a Git checkout: a woo verb authorizes and provisions the
task workspace; the execution environment uses ordinary Git and filesystem
tools; woo receives only semantic milestones and evidence.

The browser may initially call a connector content endpoint using a short-lived
woo-authorized capability. That is a transport implementation of the same
bounded resource contract, not a second repository model. The eventual MCP and
browser surfaces should share response shapes and authorization tests.

The repository-room UI should remain compositional:

- task/board surface;
- lazy source tree and file viewer;
- task-specific "workbench" summary (base, last durable head, actor, freshness);
- change-set diff and evidence;
- review/check/publish state;
- connector health and named degraded capabilities.

No panel treats sandbox dirty state as durable unless the executor explicitly
reports it as live, expiring current state. The durable UI resumes from the
last pushed checkpoint.

---

## 13. Big-World and resource discipline

- Repository lookup is by stable configured identity, never enumeration of all
  rooms or repositories.
- Tree/search/diff reads are paged and bounded; clients request narrower paths
  rather than hydrating a repository.
- One hot repository room must not receive machine-rate acts for file changes,
  pushes, clones, fetches, or check logs. Connectors coalesce current state and
  emit coordination-rate facts only.
- A task workspace is isolated so one agent's large write load does not make a
  shared Git repo the mutation hot spot. Backends may optimize storage through
  copy-on-write/forks without changing identity.
- Retention is explicit: open workspaces, submitted-but-unpublished changes,
  merged changes, abandoned work, and test artifacts can have different
  policies. Every durable reference declares the lifetime it relies on.
- Provider quotas and costs are surfaced through connector health/config, not
  hidden behind infinite-looking verbs.

---

## 14. Conformance gates

Every supported profile should pass the same behavioral suite with provider
fixtures:

1. Resolve a symbolic ref and return a pinned immutable revision.
2. Page a tree and bounded file read without path escape.
3. Create two isolated workspaces from one base; a change in one is absent from
   the other.
4. Restart/replace the executor and recover the last pushed workspace head.
5. Hand a task to another actor; the new actor receives a fresh capability and
   the old credential no longer grants access after expiry/revocation.
6. Submit an exact head; advance the workspace afterward; verify review still
   names the submitted head.
7. Refuse or name upstream divergence according to policy; never silently
   force-push.
8. Retry provisioning/checkpoint/publish callbacks and produce one semantic
   effect.
9. Lose an event/webhook and recover by reconciliation.
10. Simulate provider/executor outage and preserve honest degraded behavior.
11. Verify no secret appears in log replay, observations, Acts rows, audit
    records, or rendered errors.
12. Rebuild every projection from recorded acts without reading Git content.
13. Run the local fixture suite with networking disabled and no Cloudflare or
    GitHub credentials present.

Provider-specific gates add fidelity without weakening this baseline. The
Cloudflare lane covers Artifacts fork/token/event behavior and Sandbox restart;
the local lane covers filesystem isolation, process cleanup, and safe Git argv
construction.

---

## 15. Relationship to the current Acts/Tasks sequence

This note does not move repository support ahead of the current Acts adoption
order. Outliner and the Net replay/workerd gate close first; Dispenser proves
the plug-backed queue pattern; Tasks then migrates its coordination fields and
client board. Repository work builds on those contracts:

- typed room verbs emit acts internally;
- command queues and task/change indexes are projections;
- artifact content and task leases are joined, not mirrored;
- external bodies and logs are referenced artifacts;
- GitHub/Artifacts events enter through connector reconciliation;
- publication uses the same dropped-reply/idempotency discipline as other
  plug-backed effects.

The repository design should influence the Tasks migration now, however. Tasks
must leave room for typed source locations, multiple workspaces/change sets,
and evidence refs rather than fossilizing `source_ref` as the integration
boundary.

---

## 16. Open decisions for discussion

1. **Workspace cardinality.** One workspace per task by default
   (recommended), with explicit additional experiments, or one per claim/agent?
   The former makes handoff natural; the latter maximizes isolation but makes
   work consolidation a routine burden.
2. **Baseline refresh.** Immutable baseline snapshots per observed GitHub head
   (recommended) versus one moving mirror. Immutable snapshots simplify
   reproducibility; a moving mirror is cheaper to name but easier to misuse.
3. **Checkpoint semantics.** Only explicit `:checkpoint_workspace`, or every
   pushed head coalesced into a checkpoint? Explicit checkpoints keep the Acts
   log semantic; push events can still update live connector freshness.
4. **Change-set versioning.** Mint a new `$change_set` per submitted head
   (recommended for immutable review) versus one object with superseding
   revisions projected beneath it.
5. **MCP resource plane.** Add standard MCP resources/templates, or expose
   bounded repository reads as tools first? Resources better express immutable
   content; tools are closer to today's implementation.
6. **Local executor boundary.** Direct host process for speed versus container
   by default for safety. A trusted developer-owned repository may use direct
   execution; untrusted or multi-tenant content requires isolation.
7. **Private upstream import.** Which adapter owns authenticated mirroring when
   the workspace store cannot import a private Git remote directly? Keep it in
   the connector/execution plane; do not leak upstream credentials into the
   store or world.
8. **Retention.** When may an unpublished abandoned workspace be deleted, and
   what durable artifact preserves a useful result? This must be decided before
   references to task-store-only commits ship.
9. **Provider configuration home.** Deployment config selects available
   adapters; room config selects among allowed profiles. The room must never be
   able to name arbitrary executable adapter code.

---

## 17. External references

- [Cloudflare Artifacts beta announcement](https://developers.cloudflare.com/changelog/post/2026-04-16-artifacts-now-in-beta/)
- [Cloudflare Artifacts repositories and units of work](https://developers.cloudflare.com/artifacts/concepts/repositories/)
- [Cloudflare Artifacts best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/)
- [Cloudflare Artifacts Git protocol and repo-scoped tokens](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- [Cloudflare Artifacts repository import](https://developers.cloudflare.com/artifacts/guides/import-repositories/)
- [Cloudflare Artifacts event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)
- [Cloudflare Sandbox](https://developers.cloudflare.com/agents/tools/sandbox/)
- [Cloudflare Sandbox + Artifacts example](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/)
