---
date: 2026-04-29
status: draft
---

# Auth

> Part of the [woo specification](../../SPEC.md). Layer: **identity**.

The contract for actor identity beyond guest tokens. Covers credentialed authentication, account-vs-actor separation, multi-character users, service/agent accounts, and recovery. Builds on [identity.md](../semantics/identity.md) — the actor and session model is unchanged; this document specifies how credentials bind to actors.

The full identity surface here targets Cloudflare mode (see [SPEC.md §1.1](../../SPEC.md)). In-memory and local SQLite modes may run a reduced auth surface when intentionally scoped for development or small private deployments.

---

## A1. Beyond guest

Guest-baseline identity ([identity.md §I3](../semantics/identity.md#i3-auth-guest-baseline)) supports `guest:<random>` and `session:<id>` tokens. The `<id>` is an opaque, unguessable session id with at least 128 bits of entropy. That's enough for a demo where every actor is anonymous and short-lived. It's not enough for:

- A developer who wants to log in as themselves across sessions, days, devices.
- A team where each member's actions are attributable.
- An agent connecting programmatically with a service credential.
- Any flow that requires "I am the same person who was here yesterday."

This document specifies the credentialed-token vocabulary that extends the baseline HTTP/v2 authentication flow to support real identity.

---

## A2. Account vs actor

A clean separation:

- **Account.** A credential-bearing identity. Has a username (or email or external IdP id), credentials, recovery info, and account metadata.
- **Actor.** The runtime principal — an `$actor`-descended object with `progr` authority. Lives in the world graph.

One account → one or more actors. A human with one account may have multiple `$player`-typed actors (multi-character). A team account may have many actors representing automated personas.

This separation lets credential management live alongside the runtime (where it doesn't need to be a programmable woo object) while actors stay first-class woo objects. `$account` is the conventional class (parent: `$root`); it is *not* an actor. It carries `account.{username, contact, recovery_*}` plus a list of bound actors.

---

## A3. Token vocabulary (extended)

Extending [identity.md §I3](../semantics/identity.md#i3-auth-guest-baseline):

- **`bearer:<token>`** — a bearer issued by the world's auth service or a delegated IdP. A Cloudflare production issuer may use a signed JWT with claims `iss`, `sub`, `exp`, `aud`, `actor` (objref), and `scope`, verified against a published JWK set. The local v1 issuer may instead use an opaque unguessable handle whose verifier record is stored in `$system.bearer_tokens` under a token hash, never under the replayable token itself; it must still carry the same effective actor, scope, and expiry semantics and reject expired, revoked, wrong-audience, or unknown tokens.

- **`oauth_code:<provider>:<code>`** — a single-use OAuth/OIDC authorization code from a known external provider. The runtime exchanges with the provider's token endpoint, validates the resulting id_token, looks up the bound account by `(iss, sub)`, creates a session.

- **Password authentication is *not* a wire token.** Passwords never cross the WebSocket wire. A world that hosts its own credential store exposes a separate HTTPS endpoint (e.g., `POST /api/auth/password`) that accepts `{email, password}` over TLS, validates against the account's stored verifier, and returns a `bearer:<token>` plus a session. The client then connects with `auth { token: "bearer:<token>" }` over the WebSocket. This keeps password material out of the wire-level protocol and the observability log/trace payloads.

  Local v1 password verifiers use PBKDF2-HMAC-SHA-256 via WebCrypto with
  at least 600,000 iterations and a per-account random salt, encoded as
  `pbkdf2-sha256:<iterations>:<salt_hex>:<digest_hex>`. Raw salted SHA-256
  is forbidden for password storage.

- **`session:<session_id>`** — unchanged from identity.md. A live-session resume token.

- **`apikey:<id>:<secret>`** — long-lived programmatic credential for service/agent accounts. The id is public routing metadata, not a secret; only the final secret component authenticates. See A8.

- **`recovery:<token>`** — single-use, narrow-scope token from a recovery flow. Lands the user in a session that can change credentials and nothing else.

The token format is server policy; clients receive their next-presentable token in the HTTP/v2 auth response when a credentialed flow lands.

---

## A4. Bearer flow

```
1. Client authenticates via the credentialed exchange (password POST or OAuth code).
2. Server issues a bearer and a session.
3. Client persists the bearer (and refresh token) per its threat model.
4. On HTTP/v2 authentication or v2 session mint, client presents `bearer:<token>`.
5. Server validates signature/claims for JWT-shaped tokens or the opaque-handle record for local tokens, then checks expiry and actor/account lifecycle. If valid, it binds the session to the actor.
```

**Client-side persistence is a threat-model decision, not a normative recommendation.** Browsers offer no fully-secure option for storing bearers in-process: `localStorage` is XSS-exfiltratable; HTTP-only cookies are XSS-resistant but require CSRF mitigations; in-memory only is XSS-safe but loses on refresh. Worlds choose based on their actor population (web, native, agent) and their tolerance for re-authentication. Tokens crossing the wire are subject to the observability redaction rules ([observability.md §O8](../operations/observability.md#o8-privacy--pii)) — bearer values must not appear verbatim in logs, traces, or audit records.

**Bearer lifetime.** Default 1 hour. A separate **refresh token** (JWT or opaque handle with `purpose: refresh`, longer lifetime — default 30 days) can mint new bearers without re-credentialing through a refresh endpoint. Refresh is deferred from the local v1 onboarding surface but remains part of the credentialed-token design.

**Per-claim scopes.** A bearer's `scope` claim lists what the actor may do. v1 scopes: `read`, `write`, `admin`. Worlds may add their own. Scope is **advisory in v1**; the runtime trusts the actor's `progr` discipline as the enforcement primitive. Future versions may pre-filter calls by scope.

---

## A5. OAuth / OIDC

The world acts as an OAuth client of a known provider (Google, GitHub, an enterprise IdP, etc.).

Setup:
- Operator registers the world with the provider; receives client_id and client_secret.
- World stores trusted issuer config (jwks_uri, scopes, account-claim mapping).
- World seeds an `$account` for each user on first login (or matches by `(iss, sub)`).

Flow:
- Client redirects to provider for code (browser-mediated).
- Client receives code and presents `oauth_code:<provider>:<code>` to the credentialed auth endpoint.
- Server exchanges code with provider, validates id_token.
- Server looks up account; creates if first-time. Selects a default actor.
- Server returns session metadata plus a fresh bearer token.

**Identity unification.** A user authenticated via two providers (Google + GitHub) can bind both to the same `$account`. The runtime stores `account.identities = [{provider, sub}, ...]`; matching any of them resolves to the same account. Binding additional identities requires re-authenticating both.

---

## A6. Multi-character

One account, multiple actors. The account's `actors` property is a list of `$player`-descended objects. The session presents a token that selects one of them.

Bearer's `actor` claim names the chosen character. Switching characters means re-authenticating with a different bearer (one per character) or a `op: "switch_actor", target: <objref>` frame after auth.

For the current credentialed-token contract: one bearer = one bound actor. Switching means new bearer issuance. `$account:list_actors()` returns the bound actors; UI exposes a character-select menu.

---

## A7. Recovery

Standard flows:

- **Forgotten password.** `account.recovery_email` receives an emailed token enabling a one-time `auth { token: "recovery:<token>" }`. The session is narrow-scope: change password and nothing else.
- **Lost device.** Refresh tokens are revocable; the account's session list (visible to the owner) shows live sessions; the owner may `revoke_session(id)` from a known-good device.
- **Compromised credentials.** Password change automatically revokes all live sessions and bearers. OAuth identity unbind requires re-authenticating both the OAuth identity and the account password (or another OAuth identity).
- **Account deletion.** Soft-deletes the account (marks inactive); actors stay alive but are no longer bound to a credentialed login. Wizards may rebind.

Recovery flows are the auth service's responsibility; verbs see only the resulting authenticated actor/session.

---

## A8. Agent / service-owned credentials

Long-lived programmatic credentials for non-interactive actors. See
[provisioning.md AP4](provisioning.md#ap4-class-model-normative) for
the class shape and ownership model — this section covers the wire
contract.

- **`apikey:<id>:<secret>`** — equivalent to a refresh token but
  indefinite. Bound to exactly one actor. For human-owned `$agent`s
  the actor's `owner` resolves to a `$human` and that human's
  `$account` carries the deactivation lifecycle (suspending the
  account invalidates the key, per
  [provisioning.md AP4.3](provisioning.md#ap43-lifecycle-and-deactivation)).
  For `$wiz`-owned infra agents (bundled plugs, deployment-bound
  identities) there is no `$account`; the key is bound to the agent
  directly and its lifecycle follows the deployment.
- **Authority and lookup (implemented).** A newly minted key record lives in
  the bound actor's own `api_keys` property, at that actor's immutable anchor
  cluster. The record contains the salted secret hash and metadata; cleartext
  never persists. Its id has the versioned self-routing form
  `n1_<authority-root-hex>_<actor-hex>_<random-hex>`. The two encoded object
  references are public routing hints, not credentials. They let any cold
  gateway name the one bounded authority scope and actor without enumeration.
  Issuance is permitted only when the anchor root is catalog identity or an
  `$actor` descendant—the two cases the id grammar can route without copying
  CO15's classifier. Other anchor shapes refuse `E_LINEAGE`.

  The committing scope derives an authority-private O(1) verifier index from
  the actor property. This index is not a relation: it never enters closure
  transfer, subscriber fanout, gateway mirrors, or the public relation API.
  Authentication asks that exact authority for one indexed record and its
  current mutation-complete head. A gateway may cache that result for at most
  `NET_CREDENTIAL_TTL_MS` (default 1000ms, hard maximum 30s; zero disables
  the cache), which is the explicit revocation-staleness ceiling. Authority
  transport failure is a retryable 503 `E_RPC_TIMEOUT`, never an
  unknown/revoked credential verdict. Private-index rebuild from the actor
  property must reproduce the complete verifier family.
- The historical `$system.api_keys` map is read-only compatibility for carried
  keys. New issuance, rotation, revocation, and liveness metadata must not
  write it. An old key remains usable until rotated or revoked through the
  migration/operator path; importing an old identity image must never
  overwrite a newer actor-owned record or resurrect a revocation. The core
  `ensureApiKey` helper exists only to construct pre-Net compatibility images
  in tests and install rehearsals; it is not an installed-world issuance path.
- Credential inspection is likewise bounded: an owner may list one actor's
  redacted records by passing that actor explicitly, while the wizard-only
  global listing is a compatibility view of the historical registry. Runtime
  code must not infer the target from call-frame topology or enumerate actor
  authorities to synthesize a new global key list.
- Owner issuance and revocation are ordinary actor-cluster turns and therefore
  commit the key record, private index, turn audit, and returned result
  atomically. The actor-owned record's creation/revocation timestamps are the
  durable cross-profile audit and include `created_by`/`created_via` or
  `revoked_by` attribution; Net additionally retains the accepted transcript.
  Deployment bootstrap may instead use the internal-signed
  operator ensure route. Operator tooling generates and durably stores the id
  and secret locally first; the route accepts only the derived salted verifier,
  is idempotent for the exact same actor/id/verifier tuple, rejects collisions,
  and never receives or returns the replayable secret.
- API keys are scoped (`read-only`, `bot:<purpose>`, etc.).
- Revocable independently of bearer tokens.
- May have IP / origin restrictions.

The agent's verbs run under the agent's own `progr`. Capability gates
follow [provisioning.md AP4](provisioning.md#ap4-class-model-normative)'s
kind-vs-capability split: class via `$agent`, authoring privilege via
the `programmer` flag (subject to its own quota — see
[provisioning.md AP6](provisioning.md#ap6-self-service-agent-provisioning-in-world)).

Audit: API key issuance and revocation are authority commits; usage is logged
at session-start (not per-call, to keep the volume bounded). Logs and metrics
may carry the key id but must never carry the secret or full token.

---

## A9. Lifecycle

Account creation:
- **Self-service** (open registration): user provides email + password (or OAuth identity); world creates `$account` and a default `$player` actor.
- **Invite-only**: existing wizard issues an invite token; redeemer creates account.
- **SSO-only**: organization-bound; new accounts auto-create on first SSO landing.

Account suspension:
- Wizard sets `account.active = false`; live sessions are reaped; bearer tokens are rejected.
- Actor objects remain in the world (preserving audit trails) but no one can bind to them.

Account deletion:
- Wizard sets `account.deleted = true`; actor unbinding follows.
- Operationally soft — actor history remains; account record is hidden but auditable for retention.

---

## A10. Permissions

Account-level operations (create, suspend, delete, recover) are wizard-only by default. Per-account self-service ops (change password, list sessions, revoke session, list bound actors) work only on the calling account.

Bearer token issuance is internal to the auth service; user code does not mint bearers directly. (A future capability-token scheme may delegate parts of this; v1 keeps it server-only.)

---

## A11. Initial wizard bootstrap

When a fresh world is first stood up, no account exists yet — there is no wizard to mint other wizards from. The bootstrap exchange establishes the operator as the seeded `$wiz` actor through a single deploy-time secret.

**Token shape.** `wizard:<random-string>`. The secret value is provisioned to the runtime out-of-band by the operator; the runtime never issues it to a client. The provisioning mechanism is mode-specific (see [SPEC.md §1.1](../../SPEC.md)): Cloudflare mode reads it from the `WOO_INITIAL_WIZARD_TOKEN` secret binding ([cloudflare.md §R14.4](../reference/cloudflare.md#r144-operator-identity-bootstrap)); in-memory and local SQLite modes read the same name from `.dev.vars` or the environment.

**Single-use.** `$system.bootstrap_token_used` ([bootstrap.md](../semantics/bootstrap.md)) starts `false`. The first successful presentation:

1. Verifies the presented secret byte-equals the configured value.
2. Binds the connecting session's actor to the seeded `$wiz`.
3. Sets `$system.bootstrap_token_used = true` atomically with binding.

Subsequent presentations of the same token return `E_TOKEN_CONSUMED`. The runtime's secret store still holds the value — a redeploy without changing it does not re-arm the exchange; the consumed flag is the gate.

**Errors.**

- Secret unset at runtime: `E_BOOTSTRAP_TOKEN_MISSING` on every request.
- Secret mismatch: `E_NOSESSION`.
- Already consumed: `E_TOKEN_CONSUMED`.

**Rotation and recovery (v1).** Rotation is operator-driven and two steps:

1. Provision a new secret out-of-band (Cloudflare mode: `wrangler secret put WOO_INITIAL_WIZARD_TOKEN` then redeploy; local modes: edit `.dev.vars` and restart).
2. A wizard with another path to authority resets `$system.bootstrap_token_used = false` via the runtime authoring console. The next presentation of the new secret consumes it normally.

If no other wizard path exists (operator has lost their session and never minted a second wizard), recovery is a fresh deploy of the same world archive into a new deployment. This is why minting at least one secondary wizard immediately after first claim is recommended.

**Net profile: the seeded `$wiz` is not usable from a client at all.** On the Net (Cloudflare) profile the bootstrap wizard is a catalog identity with no placement, so its planning anchor classifies to the `catalog` scope and every client turn it attempts is refused `E_INVARG unplannable_scope`. The secondary wizard is therefore not merely recommended, it is the only usable one, and it is minted by the signed operator operation in [provisioning.md §AP11](provisioning.md#ap11-operator-wizard-provisioning-implemented) rather than by `$system:set_actor_flag` (which is an untracked native and is itself refused over Net). AP11 provisions a non-catalog agent anchored under an existing human account, which plans at that account's authority cluster even while located nowhere.

A single-call `$system:rotate_bootstrap_token(new_token)` verb that combines both steps atomically is **deferred** — see §A12.

**Forbidden alternatives** (must not ship):

- "First connection wins" — race-prone; an attacker connecting between deploy and the operator's first auth gets wizard.
- "Always-open admin endpoint gated by IP" — fragile; client-IP visibility varies by transport.
- "Hardcoded admin credentials" — defeats fork-and-deploy.

---

## A12. What's deferred

- **WebAuthn / passkey** support.
- **Hardware-key 2FA.**
- **Federated accounts across worlds** (different from federated objrefs; concerns *who you are* across deployments).
- **Account-to-account trust delegation.**
- **Fine-grained capability tokens** (currently scope is advisory).
- **Account audit log** (separate from wizard-action audit).
- **`$system:rotate_bootstrap_token(new_token)` verb** combining new-secret provisioning with the consumed-flag reset. Until it lands, rotation is the two-step operator flow in §A11.
