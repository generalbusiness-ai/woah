---
date: 2026-05-13
status: draft
---

# Actor Provisioning

> Part of the [woo specification](../../SPEC.md). Layer: **identity**.

How actors come into existence and how their capabilities are granted,
revoked, and audited. The baseline covers only the trivial cases (guest
pool, wizard-created players); the v1 use case — humans who own
quotas of agent identities, with onboarding optimized for Hermes-style
multi-profile setups — is normative below.

Operator-grade pieces (directory sync, federation, bulk reconcile) stay
deferred, called out in AP8. AP11 covers the one operator surface that is
implemented: signed provisioning of a usable wizard on a deployed world.

---

## AP1. Scope

Normative content covers:

- **Class assignment.** The actor classes a v1 deployment recognises and
  how they relate to credentialed identity (AP4).
- **Self-service signup.** A web flow that turns an unauthenticated
  human into a credentialed `$human` actor, gated by automated-bot
  defenses (AP5).
- **Self-service agent provisioning.** Once signed in, a human mints
  and revokes `$agent` actors against a per-account quota; each agent
  carries one API key (AP6). The Hermes-driven onboarding path is a
  special case of the same flow (AP7).
- **Auditable primitives.** All creation, promotion, deactivation, and
  recycle flows funnel through `$system:provision_actor` and its
  siblings (AP9).

Deferred to a later pass: directory sync (SCIM/OIDC group claims),
federated identity across worlds, bulk reconcile. See AP8.

---

## AP2. What the baseline already covers

- **Guest pool** ([identity.md §I3](../semantics/identity.md#i3-auth-guest-baseline),
  [bootstrap.md §B7](../semantics/bootstrap.md#b7-guest-player-pool)).
  Pre-seeded `$guest` instances allocated on auth, reset on reap.
- **Wizard creation.** A wizard can `create($player, owner=$wiz)`
  ([recycle.md](../semantics/recycle.md),
  [permissions.md](../semantics/permissions.md)) for ad-hoc cases —
  useful in development, insufficient for credentialed deployments.
- **Class-based capability defaults via parent chain + features.** The
  mechanism exists; what changes here is which classes the runtime
  reserves and what verbs they expose.

---

## AP3. The operational gap

The concrete shortfall AP4–AP9 close:

- No way for a logged-in human to mint an agent identity with an API
  key from inside the world. Wizards have to do it by hand today.
- No quota model: nothing bounds how many agents a single human owns,
  which makes the agent class unusable in any open-signup world.
- No accountability edge: agents and humans live as unrelated `$player`
  descendants, so a misbehaving agent's owner is not visible to the
  audit trail.
- No standard signup-with-humanness-gate that doesn't require an
  operator to write custom code per deployment.

Operator-scale provisioning (50 humans from SCIM) stays open in AP8.
None of the v1 design paints federation into a corner.

---

## AP4. Class model (normative)

Every credentialed actor descends from one of these classes:

| Class | Parent | Created by | Authenticates via | Lifetime |
|---|---|---|---|---|
| `$guest` | `$player` | Pool allocator | `guest:<name>` | Reaped on session end |
| `$human` | `$player` | Self-service signup, OIDC, wizard | `bearer:<token>` from password POST or OAuth code | Long-lived; soft-deactivatable |
| `$agent` | `$player` | `$human:create_agent(...)`, Hermes flow, wizard, infra tooling | `apikey:<id>:<secret>` | Long-lived; bound via `owner` (a `$human` or `$wiz`) |
| `$wiz` | `$player` | Bootstrap (pre-seeded with `wizard` + `programmer` flags) | (any of the above) | Long-lived; bootstrap singleton + wizard-promoted descendants |

**Kind via class, capability via flag.** Class hierarchy carves up
*what kind of thing an actor is* — `$guest` for pool slots, `$human`
for credentialed humans, `$agent` for API-key-authed actors with an
owner. Verbs naturally hang off the appropriate class
(`$human:create_agent`, `$guest:on_disfunc`), and `isa()` checks
drive dispatch where shape differs structurally (`$human` has a
`.account` backpointer, `$agent` has an `.owner`).

*Capability* is carried by flags: `wizard` and `programmer` per
[permissions.md §11](../semantics/permissions.md#11-permissions-and-security)
are runtime-blessed bits that can be flipped on any actor regardless
of class. Both axes are orthogonal — a `$human` can be a programmer
or not; an `$agent` can be a programmer or not. This is the
LambdaCore precedent for the privilege axis (the `@programmer` verb
flips a bit, not a class) carried forward into woo with class
hierarchy retained for kind (matching how `$guest` is a class even
when "guest" could have been just a flag — the pool allocator needs
to mint a specific kind).

**Authoring surface via feature, not ancestry.** The builder/programmer
authoring *verbs* live on the prog catalog's `$builder`/`$programmer`
classes, but an actor gains them without leaving its kind: the surface
class is attached as a [feature](../semantics/features.md), and the
dispatcher resolves it through the actor's feature chain. Kind stays in
the actor's own ancestry (`agent_42 isa $agent`), capability stays in the
flag, and the visible surface is a third, independent axis. The single
predicate `has_surface(actor, class)` — true when `class` is on the
actor's parent chain (legacy `$programmer`/`$builder` descendants) or is
reachable through an attached feature — decides surface membership for
both the DSL wrapper guards and the substrate authoring helpers, so the
two promotion shapes resolve identically. An actor must never be
reparented out of its kind class to gain an authoring surface; that
destroys the ancestry that records what kind of principal it is. This
includes `$wiz`: it keeps `$wiz isa $player` and carries the programmer
surface as a feature like any other actor.

Capability defaults additionally follow attached features
([features.md](../semantics/features.md)) and team memberships
([teams.md](teams.md)). The `wizard` and `programmer` flags are the
runtime-blessed escape hatches; everything else composes via
class + features + teams.

**Spec / runtime alignment.** AP4's class model is part of the
universal seed graph. The runtime seeds `$account`, `$human`, and
`$agent` alongside `$player`, `$wiz`, and `$guest`; see
[bootstrap.md §B2](../semantics/bootstrap.md#b2-universal-seed-inventory).
Substrate class additions are not catalog-version-migration shaped;
future changes to this seed graph use bootstrap-local migration
discipline per [migrations.md §M3](../operations/migrations.md).

`$account` is the new credentials-record class. It is **not** in any
actor's parent chain — it is a credentials record referenced by
`$human.account`. Like `$system`, it is a distinguished class whose
instances are not themselves actors and not navigable as locations.

### AP4.1 The `$human` shape

A `$human` is bound to exactly one `$account`
([auth.md §A6](auth.md#a6-multi-character)) — the credentialed identity
record carrying email, a PBKDF2 password verifier, and any OAuth bindings. The
`$human` actor is what walks around the world; the `$account` is what
holds credentials. One-to-one is the v1 norm; the multi-character
mechanism in auth.md A6 leaves room for one account → multiple humans
later without breaking this model.

```
$account
  .email
  .email_verified_at?         # required for $human ops; null until verified
  .password_hash?             # PBKDF2 verifier string; null if OAuth-only
  .oauth_identities[]         # [{provider, sub}, …]
  .actors[]                   # all bound $player descendants (relational
                              # source of truth)
  .primary_actor              # the $human; entry point for UI
  .agent_quota                # int, default 5; raise per account for paid tiers
  .programmer_grant_quota     # int, default 0; how many of this account's
                              # owned $agents may carry programmer=true.
                              # Wizards adjust per account via $system:set_quota.
  .agent_count                # int, denormalised count of owned $agents.
                              # The canonical source for quota checks; the
                              # runtime maintains it on every create/revoke
                              # via $system:provision_actor / recycle_actor.
                              # `account.actors filter isa($agent)` agrees
                              # by construction.
  .programmer_agent_count     # int, denormalised count of owned $agents
                              # with programmer=true. Updated whenever
                              # $system:set_actor_flag flips the flag on
                              # an agent under this account.
  .signup_method              # turnstile_email | invite | oauth | wizard
  .created_at
  .deactivated_at?
```

**Quota defaults rationale.** `programmer_grant_quota` defaults to **0**
— a new self-service account cannot mint a programmer agent without
wizard intervention. This is asymmetric with `agent_quota` (default 5,
which is open) precisely because programmer-ness is the
code-authoring privilege from
[permissions.md §11](../semantics/permissions.md#11-permissions-and-security)
and AP5 allows open signup. Without the 0 default, every verified
email could mint one authoring identity inside their first minute in
the world — a privilege escalation through the agent surface that
the human-side `programmer` flag gate would have refused. Operators
running invite-only or otherwise trusted-cohort worlds may set the
default higher; `$system.default_programmer_grant_quota` is the
deployment-level knob. The Hermes-first onboarding story works
without programmer access (most agent uses are not authoring); the
explicit grant flow exists for the cases where it's needed.

Required `$human` properties (above what every `$player` carries):

- `.account` — backpointer to the owning `$account`. The `$account`
  carries the authoritative `agent_count` and
  `programmer_agent_count`; the `$human` itself does not denormalise
  per-account quota state.

### AP4.2 The `$agent` shape

A `$agent` is owned by exactly one principal. For human-owned agents
the owner is a `$human`; for infrastructure-owned agents (bundled
plugs, operator scripts, deployment-bound identities) the owner is
`$wiz`. The lifecycle bindings, quota checks, and cascade behaviours
all follow from the owner pointer — no separate class is needed.

```
$agent
  .owner             # objref of the owning principal ($human or $wiz);
                     # immutable after create.
  .api_key_id        # current key id (rotatable; one active key at a time)
  .created_via       # "in_world" | "hermes_provision" | "wizard" | "infra"
  .profile_id?       # set when created_via = "hermes_provision"; the
                     # opaque stable id Hermes passes on /connect.
                     # Indexed within ($account, profile_id) for the
                     # reconnect lookup in AP7.2.
  .last_seen_at
  .purpose?          # free-text label; "my coding agent", set by owner
  .scope             # api-key scope claim per auth.md §A8 (read | write | …)
```

The `owner` edge is load-bearing. It carries:

- **Quota enforcement.** `owner.account.agent_count < owner.account.agent_quota` for human-owned agents. `$wiz`-owned agents have no `account` and skip this check entirely — infrastructure mints as many as it needs.
- **Accountability.** Audit logs of agent actions include `agent.owner` so a misbehaving agent traces back either to its human or to the deployment that owns the wizard.
- **Cascade deactivation.** Suspending an `$account` (auth.md §A9) invalidates every API key under it; the owned `$agent` objects remain (audit history, references from other objects) but cannot start new sessions. `$wiz`-owned agents are unaffected by this cascade because `$wiz` is not subject to account deactivation.
- **Owner-deletion semantics.** Deleting an `$account` does NOT cascade-recycle the agents (see AP4.3 below).

**Service-owned agents.** Plug workers (weather, horoscope) and
operator-deployment identities use `$agent` with `owner = $wiz` and
`created_via = "infra"`. They authenticate the same way (API key),
appear the same way in `$system:list_agents()`-style admin views, and
audit the same way; the `created_via` field and the `$wiz`-owner
distinguish them from human-owned agents when dashboards or audit
queries want to filter (e.g., "show me all agents owned by a real
human"). If a future iteration needs structurally divergent behaviour
for these (separate IP allowlists, distinct key-rotation policy,
hardware-bound keys), `$system:promote_actor(agent, $service_account)`
introduces the new class without breaking the unified-create path —
not in scope for v1.

### AP4.3 Lifecycle and deactivation

| State | What changes | Reversible |
|---|---|---|
| `active` | Default. Sessions allowed, API keys live. | — |
| `deactivated` | `account.deactivated_at` set. All sessions reaped. All API keys under the account refuse new auth. Actor objects remain in the world; their owned objects keep their `owner` pointer. | Yes — clear `deactivated_at`; keys re-allow auth. |
| `recycled` | Account record marked deleted. Bound actors recycle (becomes `$nothing`) only if `account.recycle_on_delete = true`; default is to keep actor objects for audit/history and unbind them from the account. | No. |

For an owned `$agent` there is a further, distinct state:

| State | What changes | Reversible |
|---|---|---|
| `retired` | `agent.retired_at` set (and `deactivated_at` with it). Programmer state stripped, api key revoked, and **the account's quota slot returned**. | No. |

**Deactivation is not retirement, and the two facts need two markers.**
`deactivated_at` answers "may this identity authenticate?" — a REVERSIBLE fact
that `$system:deactivate_actor` sets and `$system:reactivate_actor` clears, and
which never touches any counter. `retired_at` answers "has this agent's quota
slot been returned to its account?" — a PERMANENT fact recorded only by
`$human:revoke_agent`.

Conflating them corrupts `account.agent_count` in one direction or the other:
reading the auth tombstone as "slot returned" strands the slot forever whenever
`deactivate_actor` ran first (that path decrements nothing), while reading its
absence as "slot not returned" double-returns a slot on a repeat revoke and lets
the account mint past its quota. Normatively:

- **The quota slot is returned exactly once, by permanent retirement.** Repeat
  revocation is a success no-op for accounting and mints no duplicate audit
  record, while still re-running the idempotent retirement WORK — so a repeat
  repairs an agent that `deactivate_actor` left half-retired.
- **Revoking a merely deactivated agent still returns the slot** and still
  performs the retirement work deactivation skipped.
- **Retirement is not reversible.** `$system:reactivate_actor` refuses an actor
  carrying `retired_at`: restoring a live identity whose slot has already been
  returned is the same quota bypass reached from the other side. Plain
  deactivation stays fully reversible, because it never returned a slot.
- Implementations upgrading a world that predates `retired_at` may infer it
  only from a shape `deactivate_actor` cannot produce (auth tombstone set AND
  the agent's current key already revoked). The inference must fail toward
  leaving the slot counted, never toward returning it twice.

`$guest` actors do not have a lifecycle distinct from session;
session-end reaps them per the existing baseline.

**Orphaned actors after account recycle.** When an `$account` is
recycled with the default `recycle_on_delete = false`, the bound
`$human` and owned `$agent` actors remain in the world with their
`.account` pointer dangling. Their owned objects, audit references,
and verb history are preserved; references from other objects
continue resolving. The actors can never authenticate again — no
credentials route to them — but they remain audit-visible by
objref. **This is intentional**: deleting an account in a long-lived
world without losing the trail of what that account did matters more
than reclaiming actor objrefs. Operators who want the LambdaMOO
@toad-style hard wipe set `recycle_on_delete = true` per-account
before deletion.

---

## AP5. Self-service signup (web)

A fresh visitor reaches `https://<world>/signup` and goes through:

1. **Cloudflare Turnstile** challenge ([Turnstile docs][turnstile]).
   Server verifies the response token against
   `https://challenges.cloudflare.com/turnstile/v0/siteverify` before
   accepting the form.
2. **Email + password** (or **email + OAuth** via auth.md §A5; OAuth
   skips step 3).
3. **Email verification.** Server sends a 24h-valid link
   `https://<world>/verify?token=<one-time>`. Until the link is
   clicked, the `$account` exists with `email_verified_at = null`;
   no `$human` actor is created and no agent verbs accept calls.
4. On verification:
   - If the verification click lands in the **same browser session**
     bound to a `$guest`, promote the guest's objref to `$human` via
     `chparent($guest_id, $human)`, bind it to the account, set
     `email_verified_at`. The actor's history, owned objects, and
	     references survive. The runtime removes the guest objref from
	     the reusable guest pool before `chparent` so the pool slot is
	     released rather than leaking
     (see [bootstrap.md §B7](../semantics/bootstrap.md#b7-guest-player-pool)).
   - Otherwise — including the common case where the user opens the
     verification email in their default browser on a different device
     or session — create a fresh `$human` actor via
     `$system:provision_actor($human, owner=$wiz, account=A)`. The
     guest's owned objects and history are **not** carried over.

**Verification token storage.** Pending tokens live in
`$system.pending_email_verifications = [{token_hash, account_id, expires_at}]`.
The cleartext token appears only in the outbound email; the runtime
stores a SHA-256 token hash and matches on click. Tokens are **single-use**
— a successful click removes the entry. Tokens presented after
`expires_at` are rejected with `E_TOKEN_EXPIRED`; the signup page
exposes a `resend_verification(email)` endpoint that issues a fresh
token (rate-limited per `account_id` to two per hour to bound abuse).
Resending invalidates the previous token.

[turnstile]: https://developers.cloudflare.com/turnstile/

**Invite gating.** When `$system.signup_invite_required = true`, step 2
also accepts an `invite_code` parameter. The runtime maintains a list
of `$system.signup_invites = [{code, expires_at, used_by}]`; redeeming
a code marks it used and proceeds. Expired unused invites and used
records older than the audit-retention window are removed by
`$system:gc_pending_credentials()`. Codes are issued by wizards via
`$system:issue_signup_invite(quantity, expires_at)`. Invite codes are
replayable bearer-like secrets while unused, so the ledger is
gateway-local and redacted from host/shadow seed transfers. Useful for
early-stage waitlists; flip the flag to `false` for open signup.

**What v1 does *not* require.** Phone verification, payment, identity
documents. The Turnstile + email + optional-invite combo is the
explicit v1 humanness gate. Future iterations may add stronger
challenges (proof-of-personhood claims, device attestation) behind the
same `signup_method` field.

---

## AP6. Self-service agent provisioning (in-world)

Five verbs on `$human` form the user-facing surface:

```woo
$human:create_agent(name, purpose?, programmer?) -> {actor_id, api_key, mcp_url}
$human:list_agents()                             -> [{actor_id, name, purpose, created, last_seen, scope, programmer}]
$human:revoke_agent(actor_id, reason?)           -> ok
$human:promote_agent_to_programmer(actor_id)     -> ok
$human:demote_agent_from_programmer(actor_id)    -> ok
```

Each is direct-callable, gated on `caller == this` (so only the human
themselves can mint or revoke their own agents) and on
`this.account.agent_count < this.account.agent_quota` for
`create_agent`.

**Optional `programmer = true`** on `create_agent`, plus the explicit
`promote_agent_to_programmer` verb, both check
`this.account.programmer_agent_count < this.account.programmer_grant_quota`.
A non-programmer human can still mint programmer agents up to that
account quota — the two flags are independent (AP4 kind-vs-capability
principle). Returns `E_QUOTA_EXCEEDED` when the quota is full.

Because `programmer_grant_quota` defaults to 0 (AP4.1), a fresh
self-service account cannot mint a programmer agent until a wizard
raises the quota via `$system:set_quota(account, "programmer_grant_quota", N)`.
This keeps open-signup worlds from leaking authoring capability
through the agent surface. Operator-managed worlds expecting
Hermes-style coding-agent onboarding will typically bump the
deployment default
(`$system.default_programmer_grant_quota = 1`) so signup yields the
expected slot without per-account wizard work.

`demote_agent_from_programmer` is unconditional — owners can always
strip programmer from their own agents. Demoting decrements the
`account.programmer_agent_count` counter and frees a slot for
`promote`/`create_agent` to consume.

**Surface attach/remove is part of the transition.** `create_agent`
(with `programmer = true`), `promote_agent_to_programmer`, and
`demote_agent_from_programmer` mutate three pieces of state together: the
`programmer` flag on the agent, the attached authoring surface (AP4), and
the `account.programmer_agent_count`. The surface class is read from
`$system.programmer_surface`, a reference the prog catalog publishes as
catalog data; core never names the surface class. When that property is
unpublished (prog not installed), provisioning sets the flag and quota
only and the actor simply has no authoring surface. `revoke_agent` also
removes the surface when it clears the flag.

**Audit is profile-materialized, not a separate observation.** The transition
emits one structured provisioning audit event (caller, target agent, account,
desired state, transition-vs-repair) through a profile adapter. The in-memory
and local-SQLite profiles materialize it into `$system.wizard_actions`. The Net
profile materializes NOTHING extra: the canonical Net audit is the durable
commit record minted from the committed transcript (its verb, arguments,
principal, and trace), so writing `$system.wizard_actions` — a catalog cell — is
deliberately suppressed rather than committed as a forbidden catalog mutation.
There is no separate provisioning observation on the wire.

The transition is atomic — all three commit in one authoritative turn or
none do. Because the flag/surface live on the agent and the counter lives
on the `$account`, `promote`/`demote`/`revoke` first assert the agent and
its account are co-resident in one authority scope; when they are not,
the operation refuses with `E_CROSS_HOST_WRITE` rather than half-applying
the transition across a host boundary. A cross-scope promote/demote
protocol is deferred; until it exists the co-resident case is the
supported one. `create_agent` provisions the agent in the calling human's
scope, so it is co-resident by construction.

> **Net status (supported via the turn doorway).** On the Net (Cloudflare)
> profile a live promote/demote path IS supported over `/net-api/turn`. The
> co-resident precondition is constructed: `create_agent` anchors a human-owned
> agent to the human authority root, so the account, its human, and its owned
> agents share one cluster, and the transition commits atomically there. The
> programmer flag commits through the `object_lineage` lineage seam and the
> verbs are tracked native primitives (a transcript-complete turn); the
> committing scope's audit record IS the provisioning audit, so no `$system`
> catalog cell is written. These verbs remain NATIVE, so the Net MCP
> gateway — which advertises only bytecode-backed `tool_exposed` pages — does
> not surface them as MCP tools; drive them through `/net-api/turn` (or the
> account surface), not `tools/call`.
>
> **Supported scope (explicit).** Net promote/demote is supported only for a
> FULLY ANCHORED authority family — one whose `$account` (not just its agents) is
> anchored into the human's cluster, so the account counter and the agent flag
> commit in the SAME scope. That holds for: a fresh signup (`bindHumanToAccount`
> anchors the account to its human), a cutover import (the identity export
> carries each object's `anchor`, §8), and a family the local-boot repair
> migration co-located BEFORE export. The unit of support is the FAMILY, not the
> agent: minting a new agent does not by itself make an unanchored-account family
> supported (see below).
>
> **A new agent under a legacy account is NOT supported.** `create_agent` anchors
> a new human-owned agent to the human authority root (`authorityRootOf` falls
> back to the human when the account is anchorless), so the agent lands in
> `cluster:<human>` — but if the account was provisioned BEFORE anchoring it
> stays catalog-scoped, and the family is still split. Re-provisioning the agent
> therefore CANNOT repair a legacy family; the account must be anchored too.
>
> **Not auto-repaired on Net (deliberate limitation).** A family already deployed
> and partitioned before anchoring is NOT silently migrated on the live Net
> profile. Re-anchoring already-partitioned cells is a recursive
> cross-Durable-Object host migration (a spec-version scope migration,
> [migrations.md M6](../operations/migrations.md#m6-world-level-spec-versioning)),
> which is deferred. Until then a split family's promote/demote **refuses cleanly
> and never half-applies**: the account's `programmer_agent_count` write lands in
> the catalog scope, which an ordinary turn cannot mutate, so the committing
> gateway rejects the whole turn with `E_CATALOG_MUTATION` (HTTP 400) and nothing
> commits. The operator's remedy is to repair the WHOLE family — anchor the
> account and its agents — and re-import through cutover; the local-boot repair
> migration (`2026-07-25-authority-family-colocation`) does this on the source's
> in-memory / local-SQLite (single-host) image before export. Re-provisioning the
> agent alone does not suffice.

**Quota reductions vs. existing flags.** When a wizard lowers
`programmer_grant_quota` below the current count of programmer agents,
existing flags survive — agents keep `programmer = true` until
explicit `demote` (by owner) or `$system:set_actor_flag` (by wizard).
Only new promotes and quota-triggered creates fail. This mirrors how
`agent_quota` works (lowering it doesn't auto-recycle existing agents).

`create_agent` returns the `api_key` value **once and only once** as a
single direct-call result. The runtime persists the key's argon2id
hash; the cleartext value never appears again, in observations or in
audit logs (per
[observability.md §O8](../operations/observability.md#o8-privacy--pii)).
The verb emits a `agent_created` observation to the owner's session
with `{actor_id, name}` only — no key material.

Underlying primitive (wizard-only, audit-logged):

```woo
$system:provision_actor(class, owner, attrs?) -> obj
$system:rotate_api_key(actor) -> {api_key}
$system:revoke_api_key(actor, reason?)
$system:deactivate_actor(actor, reason)
$system:reactivate_actor(actor)
```

`$human:create_agent` invokes `$system:provision_actor($agent, owner=this, attrs={name, purpose})`.
The bypass mechanism is the **wizard-owned-verb pattern** from
[permissions.md §11](../semantics/permissions.md#11-permissions-and-security):
`$system`'s verbs are owned by `$wiz` and carry the `wizard` flag, so
the `progr` of the inner call is `$wiz` regardless of the outer
caller. `$human:create_agent` itself is owned by `$wiz` for the same
reason — a non-wizard caller invoking it gets a wizard `progr` frame
for the duration of that verb, then returns to its own. The bypass is
audit-logged as `actor_provisioned` with `caller = the $human`,
`progr_owner = $wiz`, `surface = "create_agent"` (per AP9).

**Rotating an API key without recycling the agent** is the
`$human:rotate_agent_key(actor_id, force?)` verb. Same one-time
return-value rule for the new key. Continuity policy:

- **Per-session by default.** Existing live sessions on the old key
  remain valid until their natural reap; new sessions presenting the
  old key are rejected with `E_KEY_REVOKED`. The new key is the only
  one that authenticates from this point on. This is the friendliest
  policy for Hermes-style "I redeployed my profile and want a fresh
  credential" cases.
- **`force = true`** reaps existing sessions on the old key
  immediately. Use for incident response — suspected key leak,
  immediate cutover required. This is exposed only on direct
  owner/operator call surfaces such as `POST /api/connect` or
  `$human:rotate_agent_key`; `GET /connect` never accepts `force`
  from the query string.

`rotate_agent_key` does **not** count against the `agent_quota`; the
agent already exists and is already counted. Same for the
Hermes-reconnect rotate path in AP7.2 — only `create_agent` (and
`Hermes provision when no matching agent exists`) checks the quota.

---

## AP7. Hermes onboarding path

The first-target user runs Hermes locally with N profiles and wants
each profile to get a dedicated agent identity in a few clicks. The
spec contract is OAuth-shaped without requiring full OIDC machinery
at v1.

### AP7.1 Flow

```
Hermes profile A                  Worker (woo.example)         $human in-world
─────────────────                 ────────────────────         ────────────────
 [Connect to Woo]
     │
     │ open browser:
     │ /connect?return=hermes://A/woo
     │        &state=<nonce>
     │        &profile_id=<stable_uuid>
     │ ───────────────────────────────►
     │                                  (if logged out)
     │                                  302 /signup?return=/connect...
     │                                  then signup or login per AP5
     │                                       │
     │                                       ▼
     │                                  look up existing $agent for
     │                                  (this $account, profile_id):
     │
     │                                  if NOT found → "Hermes wants
     │                                    to register agent for
     │                                    profile A. Approve?" →
     │                                    $human:create_agent(...)
     │                                    (quota check fires)
     │
     │                                  if found → "Hermes is
     │                                    reconnecting to existing
     │                                    agent 'hermes-A'. Rotate
     │                                    key?" →
     │                                    $human:rotate_agent_key(...)
     │                                    (no quota check)
     │                                       │
     │                                       ▼
     │                                  redirect to
     │                                  hermes://A/woo?
     │                                    state=<nonce>&
     │                                    actor_id=<obj>&
     │                                    api_key=<once>&
     │                                    mcp_url=https://woo.example/mcp
     │ ◄───────────────────────────────
     │
 stores credentials in profile A,
 discards the one-shot URL params,
 first MCP call with apikey:<id>:<secret>
                                                              new session bound
                                                              to the $agent
```

### AP7.2 Contract details

- **`profile_id` parameter** is a stable opaque string Hermes attaches
  to a local profile (a UUID generated once at profile creation).
  Worker uses it to match against existing `$agent` objects where
  `created_via = "hermes_provision"` AND `profile_id` matches AND
  `owner = this $human`. A match means *reconnect, rotate key*; no
  match means *create new agent*. This is the reconnect-without-
  quota-fill policy. Hermes profile reinstalls, machine swaps, and
  credential-loss recoveries reuse the existing identity. **A user who
  loses their `profile_id` (fresh Hermes install with no carryover
  config)** falls back to the create path and consumes a quota slot;
  in that case they should revoke the orphan via
  `$human:list_agents` + `revoke_agent` from the in-world surface.
- **Custom URL scheme `hermes://`** is the v1 transport for handing
  credentials back to the local client. Hermes registers it as a
  system handler. Allowed schemes live in
  `$system.allowed_provision_return_schemes`; the default list is
  exactly `["hermes://"]`. Matching is **exact scheme prefix** —
  `hermes://foo`, `hermes://bar/baz`, and `hermes://A/woo` all pass;
  `hermesx://` does not. The trailing path/query is the operator's
  responsibility to validate downstream once the scheme matched.
  Adding a non-custom scheme (`https://` callback) requires
  deployment-level intent — it exposes the redirect URL, and its
  embedded `api_key`, to network and browser-history surfaces that
  custom schemes do not reach. The v1 spec does not auto-permit
  `localhost` variants for development; operators add them
  explicitly. Unknown schemes are rejected with `E_INVARG`.
- **`state` nonce — client-side AND server-side.** Hermes generates
  the nonce, sends it on the request, verifies the echoed value
  before storing credentials (CSRF defense). The worker **also**
  tracks recently-issued state values in
  `$system.provision_state_nonces = [{state_hash, issued_at}]`,
  marking each consumed on redirect issuance; presenting the same
  state twice within the redirect TTL (5 minutes) is rejected with
  `E_REPLAY`. This is the OAuth single-use-state convention and
  defends against credential capture from logs / extensions /
  screen-recording.
- **GET `/connect` session handling.** If no session is present, the
  Worker redirects to `/signup?return=<encoded /connect URL>` rather
  than issuing a bare 401. The resumed `/connect` URL preserves
  `return`, `state`, and `profile_id`; it deliberately drops `force`
  and any unknown query keys.
- **One-shot delivery.** The redirect URL carries the api_key in its
  query string. This is the one and only time the cleartext appears
  on the network surface; the server discards it from memory after
  redirect issuance and never logs it. Hermes is expected to strip
  the params from history and persist only its own profile config.
- **`mcp_url`** in the redirect is the deployment's standard MCP
  endpoint. v2-vs-v1 authority routing inside the worker is invisible
  to the Hermes client; the same MCP wire contract applies regardless.
  For deployments hosting MCP at a non-standard path, the worker
  configures the value via `$system.mcp_endpoint_url`.

### AP7.3 Why not OIDC at v1

OIDC is the right long-term shape — the verbs underneath are the same
and we keep the `$system:provision_actor` chokepoint. The reason v1
ships the custom-scheme deep-link first:

- No client registration ceremony for Hermes operators (a v1 user
  shouldn't have to register an OAuth client).
- No spec dependency on Hermes shipping an OAuth client implementation.
- The same `/connect` page can later add an `?oauth=true` branch that
  follows the PKCE flow once Hermes supports it; existing custom-scheme
  callers keep working.

---

## AP8. Open / deferred

1. **Multiple humans per account.** Auth.md §A6 allows multi-character
   accounts; v1 assumes one `$human` per `$account`. Lifting this
   requires a "switch character" surface and quota-counting decisions
   (is `agent_quota` per-account or per-human?).
2. **Operator-scale provisioning.** SCIM endpoint or JSON snapshot
   importer for "create 50 `$human`s from this IdP dump." Currently
   manual — wizards loop `$system:provision_actor`. The trigger to
   make this concrete is the first multi-developer deployment.
3. **Directory sync (OIDC group claims).** Bulk class promotion
   (`engineering@example.com` → `programmer: true`) is the obvious
   second step after SCIM lands.
4. **Federation across worlds.** Reserved for v2; AP4's account/actor
   split is already federation-friendly.
5. **Stronger humanness signals.** Proof-of-personhood claims (Worldcoin,
   etc.), device attestation, paid quota tiers. Layered behind the
   same `account.signup_method` field; v1 leaves the door open.
6. **Quota for `$wiz`-owned agents (infra plugs).** `$wiz`-owned
   `$agent`s currently bypass the human-owned `agent_quota` entirely
   (they have no `$account`). Once operator deployments start minting
   many plug-style agents, a per-deployment quota is wanted —
   probably as a `$system.infra_agent_quota` rather than promoting
   `$wiz` to have an account. Out of scope for v1.
7. **Structural divergence for infra agents.** Should `$wiz`-owned
   agents eventually need IP allowlists, hardware-bound keys, or
   a distinct key-rotation policy, the migration is
   `$system:promote_actor(agent, $service_account)` to a new class
   that hangs off `$agent`. The unified-create path stays unchanged;
   only the few places that diverge dispatch on class. AP4 explicitly
   leaves this door open.
8. **`builder` flag.** LambdaCore's middle tier between regular user and programmer. Currently absorbed into per-object `:can_be_attached_by` policy and own-object ownership; if needed as an explicit grantable capability, add a `builder: bool` runtime flag and `$account.builder_grant_quota` mirroring the programmer treatment in AP6 — additive, no class-hierarchy change.
9. **Refresh-token and resend-verification endpoints.** The shipped
   onboarding surface issues bearer tokens from signup verification
   and password auth. Refresh-token rotation and the
   `resend_verification(email)` endpoint described in AP5 remain
   follow-on auth-service work.

---

## AP9. Audit and primitives

Every state transition routes through one of these `$system` verbs:

| Verb | Effect | Logged |
|---|---|---|
| `$system:provision_actor(class, owner, attrs)` | Create a new actor of `class`, owned by `owner`. | Yes — `actor_provisioned` |
| `$system:promote_actor(actor, new_class)` | `chparent`; preserves objref + history. | Yes — `actor_promoted` |
| `$system:deactivate_actor(actor, reason)` | Reap sessions, refuse new auth. Reversible; touches NO quota counter (AP4.3). | Yes — `actor_deactivated` |
| `$system:reactivate_actor(actor)` | Reverse deactivate. Refuses an actor carrying `retired_at`. | Yes — `actor_reactivated` |
| `$system:rotate_api_key(actor)` | Mint new key, invalidate old. | Yes — `api_key_rotated`, no key material |
| `$system:revoke_api_key(actor, reason)` | Invalidate current key without rotating. | Yes — `api_key_revoked` |
| `$system:recycle_actor(actor)` | Hard-recycle. Not used in normal lifecycle; reserved for incident response. | Yes — `actor_recycled` |
| `$system:issue_signup_invite(quantity, expires_at)` | Mint redeemable signup codes. | Yes — `signup_invite_issued` |
| `$system:gc_pending_credentials()` | Sweep expired bearers, verification tokens, provision-state nonces, expired unused invites, and old used invite records. | Yes — `gc_pending_credentials` |
| `$system:set_actor_flag(actor, flag, value)` | Flip a runtime-blessed flag (`programmer`, `wizard`). Quota-checked for `programmer` on `$agent` per AP6; unrestricted for wizard-on-`$human`. | Yes — `actor_flag_changed` with `flag`, `old`, `new` |
| `$system:set_quota(account, kind, value)` | Adjust `agent_quota` or `programmer_grant_quota` per account. Tracked native; on Net the audit is the commit record (AP11.8). | Yes — `account_quota_changed` |
| `$human:provision_wizard_agent(provision_id, options?)` | Signed-operator provisioning of a wizard-flagged, programmer-surfaced agent under this human's account (AP11). Wizard-gated; not `tool_exposed`. | Yes — `account_quota_changed`, `actor_provisioned`, `agent_promoted_to_programmer`, `actor_wizard_flag_set`, `operator_wizard_agent_provisioned` |

Self-service surfaces (`$human:create_agent`, `/signup`, `/connect`)
call these primitives under wizard authority via the perms-bypass
discipline, and that bypass is itself logged per
[identity.md §I7](../semantics/identity.md#i7-baseline-permissions).

All logged events carry: actor objref, owner objref, account id,
reason (free-text where applicable), and `caller` (which surface
invoked it). API key material never appears in any log payload.

---

## AP10. Manual provisioning compatibility

Worlds that do not need self-service signup can still use the same
classes and primitives manually: wizards call `$system:provision_actor`
with `$human` or `$agent`, set quota/account fields as needed, and use
the same API-key rotation and deactivation verbs. The self-service
signup path adds browser-facing credential exchange and guest
promotion, but it does not create a separate actor model.

---

## AP11. Operator wizard provisioning (implemented)

### AP11.1 The lock this breaks

A deployed Net world can reach a state in which **no wizard can act and no
programmer agent can ever be minted**. Two independent facts compose:

1. The seeded `$wiz` is a catalog identity with no placement. A client turn's
   planning anchor falls back to the actor itself when it is located nowhere
   (CO14), a `$`-prefixed anchor classifies to the `catalog` scope, and the
   catalog scope is not client-plannable — so every `$wiz` turn is refused
   `E_INVARG unplannable_scope`, including the ones whose purpose is to fix
   placement.
2. Programmer minting consumes `account.programmer_grant_quota` (AP6), which
   defaults to 0, and only a wizard may raise it.

The world is not broken — it is *unreachable*. Nothing inside it can grant the
first capability, so the repair must arrive from outside, signed.

### AP11.2 The remedy: an anchored, non-catalog wizard

`$human:provision_wizard_agent(provision_id, options?)` mints a **non-`$`
agent anchored under an existing human account** and gives it both authority
and tools. A non-catalog actor anchored to a human authority root plans at
that cluster **even while located nowhere**, so the provisioned actor is usable
over MCP/`/net-api` immediately, with no placement step.

The verb is defined on `$human` and is invoked with the human as the turn
target, so the entire transition plans and commits in the human's authority
cluster — where the account, the new agent, and its api-key record all live. A
`$system`-targeted verb would commit at the catalog scope and could write none
of them.

It is **wizard-gated** and **not `tool_exposed`**: the only intended caller is
the internal-signed operator route (AP11.5).

### AP11.3 Ledger-honest sequence (normative)

One turn performs, in order, the exact effects of the corresponding
self-service primitives — so every counter and audit record afterwards is
indistinguishable from an ordinary provisioning:

1. **Quota headroom** with `$system:set_quota` semantics, granted only in the
   amount the next step consumes and only immediately before it: `agent_quota`
   is raised to `agent_count + 1` only if the mint would exceed it, and
   `programmer_grant_quota` to `programmer_agent_count + 1` only if the promote
   would be a real transition. A converged re-run grants nothing. Each grant
   records `account_quota_changed`. (Because the grants are just-in-time, the
   materialized audit order is `actor_provisioned` before the programmer grant.)
2. **Create** through the shared `provisionActorInternal` path used by
   `$system:provision_actor` and `create_agent`: `$agent` parent, owned by the
   human, anchored at the family authority root, customer attribution derived,
   `actor_provisioned` recorded, `account.actors` appended, `agent_count`
   incremented.
3. **Promote** through the same shared transition as
   `promote_agent_to_programmer`: consumes the grant quota, increments
   `programmer_agent_count`, sets the `programmer` flag through the
   `object_lineage` lineage seam, and attaches the published programmer surface
   (`$system.programmer_surface`).
4. **Wizard flag** through the lineage seam, with the surface reconciled.

Step 3 is **required** before step 4. The two-gate model (AP4) separates
authority from tools: a wizard-flagged actor without the authoring surface has
permission to author and no verbs with which to do it.

**The op REFUSES rather than producing that half-state.** `$system.programmer_surface`
is read as catalog data, and the shared transition tolerates it being absent —
flag-only is the right outcome for a world that never installed an authoring
catalog (AP6). For this op it is not: it reported `promoted: true, flagged: true`
for an actor whose `features` cell was never written, which is a success message
that is not true. A published surface is now a **precondition**, refused with
`E_MISSING_STATE` naming the remedy, and a post-condition re-checks that the
surface actually attached. A world that predates the published reference is
repaired by the scalar seed-property repair (§AP11.12).

**Atomicity.** All four steps are one single-authority behavior transaction.
A turn-level rejection (a scope refusal or read-version mismatch) applies none
of them. A throw after behavior begins likewise rolls back its lineage,
property, creation, credential, counter, audit, and observation effects. On the
sequenced route the assigned sequence and one canonical `$error` outcome still
commit; they are envelope facts, not effects of the failed behavior.

The production observation that a refusal after create left
`account.agent_count` incremented exposed a runtime rollback defect; it was
never a separate AP11 partial-commit rule. AP11 still checks every knowable
precondition before its first write. That makes refusals precise, avoids
allocating identities for invalid requests, and keeps each apply phase free of
ordinary validation errors. Its idempotent ledger remains required for crash
recovery and retries. A future operation that truly crosses authorities must
either refuse before mutation, as AP11's colocation checks do, or define a
named durable saga; it cannot claim this transaction's rollback boundary.

**Audit.** As in AP6, the audit is profile-materialized. On Net the accepted
commit record IS the audit; the `$system.wizard_actions` catalog write is
suppressed by the profile sink (audit.md AU1). Local and SQLite profiles
materialize `account_quota_changed`, `actor_provisioned`,
`agent_promoted_to_programmer`, `actor_wizard_flag_set`, and
`operator_wizard_agent_provisioned` as usual.

### AP11.4 Idempotency

The operator supplies an opaque `provision_id`. The account carries
`operator_provisioned_agents`, a `provision_id -> agent` map, and the agent
carries `provision_id` as the reverse pointer.

- A re-run whose `provision_id` is already in the ledger reuses that agent:
  nothing is created, no counter moves, no quota is granted, and the receipt
  reports `created: false`.
- The reuse path is **fail-closed**. If the recorded id names an object that is
  absent, is not a live agent owned by this human, or does not carry the same
  `provision_id`, the call refuses. A stale or unwarmed read must never become
  a duplicate identity.
- The verb declares an authority prefetch for the account and for every agent
  the ledger names, because a property read of an unwarmed instance silently
  returns the class default rather than an error the repair loop could act on.

Distinct `provision_id`s under one account mint distinct agents, each with its
own unit of quota.

**The ledger is a data map, not an object namespace.** A `provision_id` is
operator-chosen text, so it may name a member of `Object.prototype`
(`constructor`, `toString`, and — outside the wire grammar but reachable by any
wizard calling the verb directly — `__proto__`). Every read of the ledger, in
the primitive and in the gateway's prefetch alike, is an **own-key** read, and
the map is constructed so that storing such a key defines an own property
rather than reaching an inherited accessor. Without this, a lookup for
`constructor` resolves the `Object` constructor and the caller dereferences a
function as an agent id. The primitive additionally bounds `provision_id` to
1..128 characters, since it becomes a durable key on the account cell.

### AP11.5 The signed operator route

`POST /net-operator/wizard/provision`, alongside
`POST /net-operator/credentials/ensure`
([cloudflare.md §R14](../reference/cloudflare.md)). Same trust model as the
rest of the operator surface: the inbound internal HMAC is the gate, the edge
strips the inbound signature and freshly signs the DO hop, and the allow-list
is exact.

Body: `{human, provision_id, name?, purpose?, api_key_id?}`. The route refuses
a missing or `$`-prefixed `human`, a `provision_id` outside
`[A-Za-z0-9._:-]{1,128}`, and a `human` that does not classify to an authority
cluster. It is addressed to a gateway shard (not a scope) because it runs a
turn, keyed by the human so repeated runs reuse one warm view.

The acting principal is the **owner of the resolved `provision_wizard_agent`
verb page**, the same data-driven derivation the guest door uses for
`maintenance_principal`; the runtime never names `$wiz`. A world that does not
install the primitive refuses `E_VERBNF` at the route rather than failing deep
inside planning.

### AP11.6 Credential handling

The primitive **mints no credential**. A routed api-key id embeds the actor it
is bound to, so it cannot exist before the agent does; the operator therefore:

1. provisions (learning the agent id),
2. generates the id/secret/salt locally, writes them to an owner-only file, and
   installs only the salted verifier through
   `POST /net-operator/credentials/ensure`,
3. re-runs provisioning with `api_key_id` so the agent's key pointer names the
   credential the operator holds.

Every step is independently idempotent and the replayable secret never crosses
the wire. `npm run provision:net-wizard` drives all three.

**The pointer is validated fail-closed before it is stored.** Retirement
follows `agent.api_key_id` and nothing else, so a pointer naming a key that is
not this agent's would leave the agent's real credential alive through
retirement — a retired wizard that still authenticates. A supplied
`api_key_id` is accepted only when all of the following hold, and is otherwise
refused `E_INVARG` naming the axis that mismatched:

- it parses as a routed (self-routing) api-key id;
- the id is bound to this agent;
- its immutable authority root equals the agent's anchor root (what
  cold-gateway routing resolves the credential through);
- a verifier record for it exists in the agent's own `api_keys` map — the
  actor-owned store the credential-ensure route writes; routed ids never live
  in the legacy catalog `$system.api_keys` — with `record.actor` equal to the
  agent and `revoked_at` unset.

Requiring the record is safe because step 2 installs it before step 3 runs.

### AP11.7 Revocation

`demote_agent_from_programmer` clears the `programmer` flag and the surface but
**not** the `wizard` flag — demote's meaning is "stop being a programmer", and
clearing an unrelated authority bit would be a surprise. It therefore leaves an
operator-provisioned wizard with authority and no tools, which is not the
retirement anyone wants.

The lever is `$human:revoke_agent(actor_id)`, called by the owning human: it
strips programmer state through the shared transition, marks the actor-owned
api-key record revoked, sets `deactivated_at` and `retired_at`, and returns the
account's quota slot by decrementing `agent_count`.
The `wizard` flag is deliberately left set — a deactivated actor cannot
authenticate at all (`E_PERM identity_deactivated` at session mint), so the
residual bit grants nothing, and the flag's history stays legible in the
lineage cell.

`revoke_agent` is a tracked native with the same authority prefetch as
promote/demote, so it commits over `/net-api/turn` in the human's authority
cluster. Its audit goes through the AU1 sink for the same reason as AP11.8:
before that, `$system.wizard_actions` made every revocation fail
`E_CATALOG_MUTATION`, which left account owners with no way to retire an agent
on a Net world at all.

**Revocation returns the quota slot exactly once (normative).**
`account.agent_count` is a QUOTA counter, not an event count, and the marker
that decides is `retired_at` — never `deactivated_at` (AP4.3). Revoking an
agent that is **already retired** returns success and:

- does **not** decrement `agent_count` again;
- does **not** re-stamp `retired_at`, so the retirement time is stable;
- does **not** mint a duplicate `agent_revoked` record for an event that did
  not happen — though a repeat that actually repaired something (a key that was
  still live) records one marked `repair: true`, so no real retirement work is
  ever unaudited.

Revoking an agent that was merely **deactivated** DOES return the slot, records
`agent_revoked`, and performs the retirement work deactivation skipped. The
earlier `deactivated_at` is preserved rather than re-stamped: that is when the
identity stopped authenticating, which is a different instant from when the
slot came back.

Programmer-state stripping and api-key revocation run on every call, both being
idempotent themselves. The same rule holds for `demote_agent_from_programmer`:
the shared transition moves the flag and `programmer_agent_count` only on a real
transition, so repeats are no-ops and no ordering can double-decrement it.

**Retirement reaches live credentials.** Eligibility is otherwise checked only
when a session is MINTED, and both client credential classes evade that: a
session bearer presents a session id and never re-presents its key, and an
apikey holder pairs a long-lived key with an already-minted session id. Note
`revoke_agent` revokes only the key named by `agent.api_key_id`, so any second
credential on that actor survives retirement — a retired wizard was verified to
commit a wizard-only `set_quota` turn this way. Both classes therefore refuse
`E_PERM identity_deactivated` when the resolved actor's `deactivated_at` cell is
present in the serving gateway's view with a non-null value.

This check is deliberately **view-only and conservative**: it never warms or
fetches (it is on the hot path of every authenticated request), and an absent cell is not a
refusal, because a gateway that has not pulled the actor's cluster cannot
distinguish "not deactivated" from "not pulled". Propagation is therefore
**eventual** — the tombstone commits in the same authority cluster that hosts
the session cell, a scope the serving gateway subscribed to when it minted the
session, so it arrives by ordinary fanout in seconds, not instantly. The
api-key check remains the second, authoritative gate: it reads the verifier
from the owning authority and catches a revoked credential even before the
tombstone lands.

Re-running provisioning against a retired or deactivated agent's `provision_id`
refuses, with a message naming which of the two it is (only one of them can be
undone); a replacement uses a new `provision_id`.

Revoking only the credential (`$system:revoke_api_key(id)`, also tracked and
verified over Net) is the narrower action: it kills the operator's access
without retiring the actor.

### AP11.8 Related fix: `$system:set_quota` on Net

`set_quota` previously appended `$system.wizard_actions`, a catalog cell, so
every call over Net failed `E_CATALOG_MUTATION` — a deployed world could not
grant programmer quota even holding a working wizard, which is half of the lock
in AP11.1. Its audit now goes through the AU1 profile sink and the primitive is
a tracked native with an argument-0 authority prefetch (the turn target
`$system` is catalog-resident, so the account must be prefetched from the
argument).

`$system:set_actor_flag` remains an **untracked** native and is therefore still
refused over Net (`incomplete_transcript`, fail-closed). Granting wizard
authority on a Net world goes through AP11, not through `set_actor_flag`.

### AP11.9 The operator anchor (implemented)

**A fresh net install contains no `$human` and no `$account` instance at all.**
Both are created by signup, and the net stack exposes no signup route
(`verifySignup` is an in-process world method). Verified against the install
plan: zero instances of either class in any partition. So on a freshly
cut-over world AP11 has nothing to anchor to, and the whole runbook is
unexecutable until an anchor exists.

`POST /net-operator/identity/anchor` mints one. Body:
`{anchor_id, label?, agent_quota?}`.

**It is a genesis submit, not a turn.** A turn needs a target object whose
scope already has a head; this operation's purpose is to bring a
never-before-seen authority cluster into existence. The mechanism is the one
elastic guest provisioning already uses: one transcript against
`{seq: 0, hash: cellVersion(["genesis", scope])}`, handed to the new cluster's
own sequencer. That is why it is a separate op rather than a flag on
`provision_wizard_agent` — that verb is defined on `$human` and TARGETS the
human, so it structurally cannot run before the human exists.

**Shape.** The human is anchorless and actor-classed, so it is its own cluster
root; the account is anchored TO the human, exactly as `bindHumanToAccount`
does at signup. Both therefore classify into `cluster:<human>`, which is what
keeps every later promote/demote/revoke turn single-scope and atomic (AP6).

**Identity posture — why this does not weaken the model.** The minted account
carries **no `password_hash`, no `password_salt`, and no `oauth_identities`**,
so `/net-api/login` cannot produce a session for it: nothing can authenticate
AS the anchor. No api key and no session are minted. Credentials only ever
reach the AGENT that AP11 provisions, through the separate signed
credential-ensure route (AP11.6). The result is exactly the credential-less
manual-provisioning shape AP10 already sanctions — previously reachable only
in-process. `programmer_grant_quota` starts at 0; AP11 grants exactly the
headroom it consumes.

**Idempotency.** The object ids are DERIVED from `anchor_id`
(`human_op_<hex>` / `account_op_<hex>`), not allocated from a counter — a
genesis cluster has no counter, and derivation makes a lost reply replayable as
a byte-identical submit. A re-run against an existing anchor reports it
(`created: false`) without attempting a second commit.

### AP11.10 Probing a deployed world

`callVerbPage` resolves through the TARGET'S lineage chain, so an absent human
and an absent verb page both return null. Reporting both as `E_VERBNF` sent an
operator hunting for a missing definition when the real answer was a missing
identity — opposite remedies. The two are now distinguished:

- human absent → `E_OBJNF`, carrying `remedy: POST /net-operator/identity/anchor`;
- primitive absent → `E_VERBNF`, carrying the `repair:net-definitions` command.

`POST /net-operator/wizard/provision` with `{probe: true}` reports the world's
state **without mutating anything**: `human_present`, `human_class` (the
target's parent chain, so an operator can see it really is a `$human`),
`primitive_installed`, `authoring_surface`, `recorded_agent`, and a `next` LIST
naming every remaining step in order. `authoring_surface` reports the published
reference (§AP11.12) — a probe must predict EVERY refusal the real run can
produce, and this is also the only way to read that catalog-scope value from
outside, since `/net-api/cell` is presence-scoped and refuses it even for a
wizard. The primitive's presence is read from the class page
directly rather than from verb resolution, which runs through the target's
lineage chain and so could not answer at all when the human is absent — one
probe therefore reports both facts instead of costing a round trip per missing
thing. The anchor op accepts `{probe: true}` for the same reason, so resolving
a token to its ids never seeds one. This is the sanctioned way to answer "does a human exist on this
world?" — `/net-api/cell` is presence-scoped and refuses identically for
present and absent objects, so absence is not provable there.

### AP11.11 Installing the primitive on an aged world

A world installed before AP11 does not carry the `$human:provision_wizard_agent`
page, and **a runtime never rewrites durable cells**, so the page reaches an
aged world only through `repair-definitions`
([cloudflare.md §R14](../reference/cloudflare.md)). That operation previously
accepted a verb page only when one was already stored, which made a genuinely
NEW bootstrap verb unreachable by any mechanism. Verb pages may now be ADDED,
as property definitions always could.

**Server-side invariants for an add** (the CLI's fresh-plan allow-list is a
client-side check the server cannot see, so these stand alone): the catalog
scope; a `$`-namespace object whose class lineage this scope already holds; a
well-formed page whose `name` matches its cell key; uniqueness within the
batch; at most 32 changes.

**The authority owns the ordinal.** A bundled page carries the `slot` a FRESH
install would assign, which has no reason to match an aged world's numbering,
so the caller's slot is discarded: a REPLACE keeps the ordinal the stored page
holds (moving a live verb is what the ordinary commit path refuses as
`verb_slot_moved`, and a move onto a sibling's ordinal recreates the
duplicate-slot corruption CO4.7 exists to undo), and an ADD allocates above
every ordinal the object already holds — the same floor the ordinary commit
path demands of a new page.

**Marginal authority.** An internal-signed operator can now choose a NEW verb
name on an installed bootstrap class, where before they could only overwrite an
existing one. This is strictly weaker than the authority they already held:
replacing `$root:look` with arbitrary bytecode (including its `perms`, `owner`,
`direct_callable`, and `tool_exposed` metadata, which ride the page) affects
every existing caller immediately, whereas an added name is invoked by nobody
until something calls it. Adding cannot reach a class the world does not hold,
cannot leave the `$` namespace, and cannot displace an existing page's ordinal.

### AP11.12 Delivering a scalar seed value to an aged world (implemented)

`repair-definitions` carries definition PAGES; the seed-property repair
originally mined only `merge_map` hooks, the map-database twin. A plain
`mode: "set"` scalar was covered by neither, so **a world could never learn a
scalar a later catalog version began publishing**. That gap is what produced a
deployed world with no `$system.programmer_surface`, and therefore wizards with
authority and no authoring surface.

The seed-property repair now carries `set` hooks as well. The overwrite rule is
the scalar analogue of `supersedes`, and is deliberately narrower than a plain
`set`:

| Stored value | Action |
|---|---|
| absent | **deliver** — the aged-world case; the world never held a value, so there is no operator intent to destroy |
| equal to the shipped value | no change (idempotent replay) |
| present and different | **refuse**, unless the manifest declares it in `supersedes` — i.e. the catalog attests it was one of its own historical defaults |

For a map hook `supersedes` is keyed per map key; for a scalar it is a flat list
of historical shipped values. An operator edit is never overwritten in either
form, and an operator still cannot name an arbitrary cell: entries are mined
from bundled manifests only.

**Mining is confined to catalog-owned (`$`-prefixed) objects**, matching the
server's own guard and the CT14.7 boundary — instance data rewrites have no
operator op. `set` hooks also target instances (a room's exits, say), whose
cells belong to no install partition; mining one would produce a request the
authority refuses, or an unresolvable scope before it got there.

### AP11.13 Historical account-family diagnostic and repair

Runtime rollback correction does not rewrite an aged world's state. Operators
therefore have one bounded repair per account authority:
`POST /net-operator/account/repair`, driven by
`npm run repair:net-account-state`. Its body contains only
`authority_scope`, `account`, the mutually bound `primary_actor` human,
`dry_run`, and at most 256 candidate object IDs; no caller supplies a cell
value, property version, flag, credential decision, or object disposition.
Candidate IDs expand inspection only and never authorize a change.
The edge requires the internal HMAC and freshly signs one hop to the named
cluster. The authority reads the published programmer surface and lineage
closure from the catalog, requires the addressed objects' ancestry to reach the
canonical substrate `$account`, `$human`, and `$agent` roots, but mutates only
cells it owns. Property-shaped lookalike classes are not identity witnesses.

The operation derives these facts:

- `account.actors` is deduplicated and the mutually attested primary human is
  present;
- an unregistered AP11 agent is added only when the account's
  `provision_id -> agent` entry and the agent's reverse `provision_id` agree;
- `agent_count` is the number of registered, non-retired agents, and
  `programmer_agent_count` is the programmer subset;
- `retired_at` implies the authentication tombstone, a cleared programmer
  state/surface, and revocation of the current pointed credential at the
  durable retirement time;
- a live mutually attested AP11 agent that never completed the wizard step may
  finish its programmer flag, wizard flag, and published programmer surface;
  the ledger is provisioning-time evidence, not current authorization. In
  particular, `wizard = true` with `programmer = false` proves that AP11
  completed and a later explicit demotion preserved the wizard bit (§AP11.7),
  so repair reports a conflict and never re-promotes it. A later reversible
  deactivation/suspension is likewise a conflict rather than permission for
  repair to reactivate. When `wizard`, `programmer`, and the published surface
  are all absent on an actor already present in `account.actors`, an AP11
  interruption before the first flag write is indistinguishable from a later
  full privilege strip. Repair therefore also reports a conflict for that
  ambiguous registered state; the old provisioning ledger never overrides
  possible newer owner intent. An unregistered mutually attested ledger actor
  remains distinguishable as interrupted provisioning residue and may finish.

Every other disagreement is a conflict and suppresses the whole apply. This
includes malformed features, missing registry objects, wrong owners/authority
roots, stale or mismatched current credentials, extra active credentials on a
retired actor, and an ordinary unregistered failed-create actor. In particular,
no object is recycled or registered merely because its shape resembles F4:
without a durable operation identity there is insufficient evidence of whether
creation failed or registration did.

Dry-run and apply execute the same pure plan. A conflict-free dry-run returns
an opaque `review_token`, a canonical digest of the complete value-bearing
plan (including the before/after values redacted from operator output). Both
CLIs default to dry-run and require that token together with explicit
`--apply` on the reviewed second invocation. Apply recomputes the plan under
its authority lock and refuses if the token differs, so changed state cannot
turn a reviewed diagnostic into a different repair. An already-converged
retry remains an `empty` no-op. The internal method requires exactly one mode,
so an omitted boolean can never become an implicit apply. A Net apply is one
ordered owner event and one Durable Object SQLite transaction.

The local SQLite CLI is an **offline operation**, including dry-run. Every live
`LocalSQLiteRepository` holds a cooperative per-world owner lease for its
lifetime; the CLI requires the exclusive lease before it opens the database
and refuses with a stopped-server diagnostic while any owner process remains
alive. This closes the boundary that a SQL lock cannot: a running server may
hold newer state in memory while no transaction is open, then overwrite an
otherwise successful repair on its next flush. PID-stamped shared-owner leases
left by a crashed process are reclaimed only after that process is no longer
alive. The fixed-name exclusive marker is never guessed stale automatically:
after an interrupted repair, an operator verifies its recorded PID is gone and
removes the marker explicitly, avoiding a race in which one repair contender
could delete another's newly acquired marker.
After exclusive ownership is established, the CLI holds `BEGIN IMMEDIATE`
across load/plan/apply and nests mutation in `ObjectRepository.savepoint`.
The same handle verifies an existing current Woo database before migration
code can run. Replays return `empty`. Actual repairs advance ordinary
property/cell versions; the operation never rewrites a version to make a
historical failed attempt disappear.

Inspection is capped at 1,024 source members and at 1,024 distinct members of
the one addressed authority. Neither adapter scans a scope or object table: both
examine only the registry, ledger, primary pointer, and bounded operator-named
orphan candidates. Net captures the owner head and sequencer identity before
awaiting catalog role facts and refuses a stale snapshot if either changed.
When the repair changes an actor's credential map, the authority-private
verifier index is updated in that same owner transaction; authentication MUST
observe the revocation immediately and after cold rehydration.
The authoritative `api_keys` cell still follows normal closure and fanout
coherence; only the derived verifier index is private and non-transferable.
Operator-visible reports name affected cells and reasons but omit property
before/after values, so a credential-map repair cannot disclose verifier
hashes or salts in a terminal, HTTP response, or operations log.

For local SQLite, dry-run is the default:

```bash
npm run repair:local-account-state -- \
  --db /path/to/world.sqlite \
  --account <account-id> \
  [--candidate <suspected-orphan>]
```

After reviewing a conflict-free plan, repeat the same command with `--apply`
and `--review-token <token-from-dry-run>`.
Candidate arguments expand inspection only; they do not authorize recycling or
provide replacement values. Stop every process serving or otherwise holding
the named local world before either command; the lease check refuses instead of
reporting a stale diagnostic or an apply that a live in-memory world could
later overwrite.

The Net form accepts the same repeatable candidate option:

```bash
npm run repair:net-account-state -- \
  --base-url <worker-url> \
  --authority-scope cluster:<primary-human> \
  --account <account-id> \
  --human <primary-human> \
  [--candidate <suspected-orphan>]
```

After review, repeat it with `--apply` and
`--review-token <token-from-dry-run>`. The authority refuses a missing or stale
token before mutation.
