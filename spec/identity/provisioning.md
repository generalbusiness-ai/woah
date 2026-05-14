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
deferred, called out in AP8.

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
`$system:issue_signup_invite(quantity, expires_at)`. Useful for
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
| `$system:deactivate_actor(actor, reason)` | Reap sessions, refuse new auth. | Yes — `actor_deactivated` |
| `$system:reactivate_actor(actor)` | Reverse deactivate. | Yes — `actor_reactivated` |
| `$system:rotate_api_key(actor)` | Mint new key, invalidate old. | Yes — `api_key_rotated`, no key material |
| `$system:revoke_api_key(actor, reason)` | Invalidate current key without rotating. | Yes — `api_key_revoked` |
| `$system:recycle_actor(actor)` | Hard-recycle. Not used in normal lifecycle; reserved for incident response. | Yes — `actor_recycled` |
| `$system:issue_signup_invite(quantity, expires_at)` | Mint redeemable signup codes. | Yes — `signup_invite_issued` |
| `$system:gc_pending_credentials()` | Sweep expired bearers, verification tokens, provision-state nonces, expired unused invites, and old used invite records. | Yes — `gc_pending_credentials` |
| `$system:set_actor_flag(actor, flag, value)` | Flip a runtime-blessed flag (`programmer`, `wizard`). Quota-checked for `programmer` on `$agent` per AP6; unrestricted for wizard-on-`$human`. | Yes — `actor_flag_changed` with `flag`, `old`, `new` |
| `$system:set_quota(account, kind, value)` | Adjust `agent_quota` or `programmer_grant_quota` per account. | Yes — `account_quota_changed` |

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
