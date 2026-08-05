# Client surface — the operation owner behind every client dialect (CS1–CS9)

> Status: CS1–CS6 are **draft — the S1 contract** for the client-surface
> extraction (plan: `notes/2026-08-05-client-surface-and-feed-plan.md`,
> WS-A). They constrain phases A1–A3 and become adopted when that
> extraction merges. CS7–CS9 are **reserved** for the durable observation
> feed (S2/WS-B) and carry only their section titles here.
>
> Scope: the boundary between client dialects (REST `/net-api/*`, MCP
> `/net-api/mcp`, WebSocket) and the gateway's client operations. The
> internal cross-node seam is [transport.md](transport.md); commit
> authority and session semantics are [coherence.md](coherence.md)
> (CO6, CO14); the MCP wire profile is [mcp.md](mcp.md).

## CS1. One owner, three projections

All client-facing policy — authentication, admission, rate limiting,
session validation and lifecycle, turn submission, authorized reads, and
(CS7) observation delivery — is implemented exactly once, in one module
(`src/worker/net/client-surface.ts`), composed by the gateway DO. A
dialect handler MAY parse its wire format, call surface operations, and
render results; it MUST NOT decide policy.

Normative consequence: adding a client dialect is a parser and a renderer;
it introduces no new policy code. Fixing a policy defect fixes it for
every dialect at once.

Non-goals, stated to bound the seam: the MCP tool projection (canonical
naming is an [mcp.md §M2.3](mcp.md) protocol guarantee) remains
MCP-specific and is not a surface operation; the planner/commit chain
below `submitTurn` is out of scope; nothing here alters
[transport.md](transport.md) TR rules.

## CS2. The operation inventory

### CS2.1 Admission is per-door

Admission operations establish or create a principal; they are distinct
operations and MUST NOT be normalized into one parameterized door,
because their pre-authentication controls differ and are load-bearing:

- `admitLogin(email, password, opts)` — owns the PBKDF2 global
  concurrency cap and rolling-window budget, the timing-equalized dummy
  verification for unknown/deactivated accounts, byte-limits applied
  before the email becomes a limiter key, and the pre-auth per-email
  amplifier rate key.
- `admitGuest(claim, opts)` — owns guest-pool allocation and its own
  amplifier rate key.
- `resumeOrOpenSession(principal, opts)` — the api-key-authenticated
  doors (REST `/net-api/session`, MCP initialize), operating on an
  already-authenticated principal.

All three compose one private session mint (today's `sessionOpen`). The
mint is not reachable from dialect code (CS6).

### CS2.2 Authenticated operations

- `authenticate(credential) → Principal` — credential parsing
  (`apikey:` / `Bearer session:` classes), routed authority-record
  verification, retirement/eligibility/namespace checks. The composition
  point for `client-auth.ts`; CO14's "gateways authenticate" lives here.
- `rateGate(key, class)` — the single post-authentication rate-limit
  implementation and its refusal semantics. Pre-auth keys are owned by
  the admission doors (CS2.1); no other call site may exist (CS6).
- `resolveSession(principal, sessionId) → SessionInfo` — the one
  session-validation implementation (existence, expiry, actor binding).
- `closeSession(principal, sessionId) → CloseReceipt`.
- `submitTurn(principal, session, TurnRequest) → TurnResult` — wraps the
  existing plan→attest→submit→replan chain without modifying it; the
  surface owns argument-shape validation and session/actor consistency,
  the chain owns everything below.
- `readCell` / `readRelation` — wrap the presence-scoped read
  authorizers; no global reads; protected-cell and session-stripping
  projections apply identically for every dialect.
- `enrollFeed` / `readFeed` / `waitFeed` / `cancelWait` — reserved, CS7.

### CS2.3 Operations do not render

Every operation returns typed values or throws `SurfaceFault` (CS3).
Operations MUST NOT construct wire bodies, HTTP statuses, JSON-RPC
envelopes, or WS frames.

## CS3. Fault taxonomy and rendering

### CS3.1 SurfaceFault

`SurfaceFault` carries `{code, message, detail?, retryable?}`. `code` is
drawn from a closed vocabulary: the CO6 divergence taxonomy, plus the
auth/session verdicts (`expired`, `missing`, `actor_mismatch`,
`session_required`, credential and eligibility refusals), plus the rate
and capacity refusals. The vocabulary is enumerated in one TypeScript
union; a code not in the union is a type error, not a runtime surprise.

### CS3.2 Renderers are pure

`surface-render.ts` provides exactly three renderers over one mapping
table:

| Dialect | Rendering |
|---|---|
| REST | HTTP status + `{error: {code, message, detail}}` body |
| MCP | JSON-RPC error or tool-envelope `isError` per [mcp.md](mcp.md) refusal rules |
| WS | error frame; the rate-refusal frame keeps its deliberately distinct shape |

Renderers are pure functions of `(fault, dialect context)`. They MUST NOT
perform I/O, mutate state, or emit audit/metrics. A dialect-specific
rendering difference (the WS rate-refusal shape) is expressed in the
renderer, never by detecting the condition separately in the dialect.

### CS3.3 Wire compatibility

The extraction is wire-preserving: for every fault reachable today, the
rendered body under CS3.2 is byte-identical to the current dialect
behavior. Conformance is a fixture suite snapshotting current bodies
BEFORE extraction (plan A1); the suite is the definition of "preserved".

## CS4. Audit is a surface effect

AU1.2 edge-audit emission is owned by surface operations — recorded
before a fault propagates — never by renderers or dialect handlers.
Because wire fixtures cannot prove a side effect survived refactoring,
the A1 gate includes explicit audit-row assertions per fault path.

## CS5. Session identifiers are credentials

Surface operations MUST NOT place session identifiers (or values derived
from them reversibly) in any client-visible projection other than the
bearer channel that already carries them. This restates the standing
gateway rule at the seam where future operations (CS7 cursors) are most
tempted to violate it.

## CS6. Conformance and the guard

- `guard:client-surface` (wired into `npm test`): dialect regions of
  `gateway-do.ts` MUST NOT reference the rate limiter, the session mint,
  session SQL, or error-body construction; only `ClientSurface` and
  `surface-render` exports.
- The fixture suite (CS3.3) and audit assertions (CS4) run in the
  curated `npm test` lane.
- The PBKDF2 admission thresholds (CS2.1) carry a regression test: the
  same refusal codes at the same thresholds after extraction.

## CS7. The observation feed — reserved for S2

Per-presence durable delivery: enrollment, feed identity and incarnation,
authenticated cursors and their verdict taxonomy, prefix-stable reads,
gap responses, the delivery-clock append, origin provenance, and
discontinuity epochs. Specified by S2 before B2 begins; the plan §2 is
the working draft.

## CS8. Feed storage and lifecycle — reserved for S2

Schema, atomic append transaction, audience join maintenance on both
mirror writer paths, retention mechanics, alarm composition, and the
gateway derived-schema ladder steps (v3→v4, v4→v5).

## CS9. Feed validation — reserved for S2

The evidence lanes (feed load lane, canary storage gate) and the required
test inventory.
