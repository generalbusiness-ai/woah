# Cap'n Web as a woo substrate — assessment

Origin: 2026-08-05. Investigation prompted by the question: could Cap'n Web RPC
become the default client substrate, could woo's distributed execution be
expressed in its by-reference object passing, and could MCP become a thin
wrapper over a Cap'n Web layer? Sources: capnweb README + Cloudflare protocol
blog post (verified current as of today; still pre-1.0 on npm), plus a full map
of woo's transport/session layer (`src/worker/net/gateway-do.ts`,
`src/net/host.ts`, `spec/protocol/coherence.md`, `spec/protocol/transport.md`,
`spec/protocol/mcp.md`, `notes/2026-07-28-mcp-stateless-migration-scope.md`).

## What Cap'n Web actually is

- Object-capability RPC in ~10kB of JS. No schemas. JSON wire with type
  escapes. Transports: WebSocket, HTTP batch, postMessage, custom.
- **By-reference passing**: `RpcTarget` subclasses and plain functions cross
  the wire as stubs; calls route back to the originator. Bidirectional.
- **Promise pipelining**: the client predicts push IDs and chains dependent
  calls speculatively in one round trip. The protocol is an expression
  language — `["push", ["pipeline", 0, "method", [...]]]` — evaluated against
  per-connection import/export tables. `map()` record-replays a callback into
  that same expression IL.
- **Explicit, stated limitations**: capabilities are connection-scoped and die
  on disconnect (no persistent/sturdy refs — clients must re-authenticate and
  rebuild); **no three-party handoff** (a stub passed onward proxies forever
  through the introducing connection; still "future" a year after release);
  no distributed GC (explicit `Symbol.dispose` discipline); streams die with
  the connection; no runtime type enforcement.

## Why it *feels* like a fit — the resonances are real

1. **MOO objects are capabilities.** A woo object with verbs is exactly the
   thing `RpcTarget` models. `session → actor → location → contents` as a
   traversable stub graph is the natural ocap rendering of the world.
2. **Cap'n Web's expression IL is a plan.** Their pipelining/`map()` protocol
   ships a speculative expression to be evaluated near the data. Woo's net
   path ships a speculatively-executed transcript to be validated near the
   data (`src/net/plan.ts`). Same instinct, and their "recorded instructions
   turn out to be just the RPC protocol itself" is the same discovery as
   woo's plan/transcript duality.
3. **Ocap reachability is what the MCP surface hand-rolls.** `mcpResolveCall`
   refuses any target outside {you, your space, its contents, your inventory}
   — possession-by-reachability enforced as ambient policy. In ocap RPC that
   discipline is structural: your tool surface *is* the stubs you hold.
4. **Bidirectional callbacks model observation push** — pass an observer
   function, the server calls it.

## The verdict up front

Cap'n Web is a **session protocol**; woo's substrate is a **coherence
engine**. The resonances are at the object-model layer, but the substrate's
actual job — sequenced turns, CAS read validation, durable transcripts,
at-least-once ordered fanout, authority routing — is precisely the set of
things Cap'n Web's limitations section disclaims. It cannot be the substrate.
It *can* be a client dialect at the edge, and — more valuably — its **shape**
is the right template for decomposing the gateway.

## Where the impedance mismatch shows up, ranked

### 1. Ephemeral capabilities vs durable identity and resume (worst)

Every Cap'n Web stub dies with the connection. Woo's entire recent transport
history is about surviving disconnection: DO eviction wiping MCP queues, the
continuity-proof-not-a-cursor gap (`mcpContinuityProven` tells you *that* you
missed observations, never *what*), and the stateless-MCP migration's
conclusion that the fix is **one durable, monotonically sequenced feed per
presence** with a real cursor. Cap'n Web's delivery model — callbacks and
streams that terminate with the socket, no resume — is exactly the model woo
already decided to move away from. Reconnection would mean re-traversing from
a root capability to rebuild the whole stub graph, and any observation
delivered via callback while disconnected is simply gone unless you rebuild
the durable cursor underneath — at which point the callback is transport
sugar over the cursor, not a substrate.

Woo object ids are durable names; Cap'n Web refs are ephemeral session
handles. A hybrid (stubs as a session-lifetime cache over durable names) is
coherent, but it concedes the point: the durable name system remains the
identity substrate, and Cap'n Web is a projection of it.

### 2. Two-party topology vs Big-World (disqualifying for the interior)

Cap'n Web has no three-party handoff: a Carol-hosted capability passed to
Alice through Bob proxies through Bob indefinitely. Woo's interior is
authority-routed by design — millions of nodes, no global enumeration, no
synchronous dependency chains; CO2.7 explicitly forbids
`gateway→scope→gateway` request cycles. Expressing host-to-host distributed
execution as by-reference stub passing would bake introducer proxy chains
into the topology — the precise thing Big-World discipline exists to prevent.

The spec already took a position here, deliberately: **TR3** ("no platform
references may cross the seam — not stubs, not streams, not
functions/callbacks, *not capability objects*; a payload that cannot
round-trip through `JSON.parse(JSON.stringify(x))` is non-conforming"), and
TR7.2 rejects per-route typed RPC methods so the route contract can't migrate
into platform stub types. Cap'n Web under `Host.rpc` would require repealing
TR3, and TR3 is right: the internal seam must be satisfiable by any message
transport, single-attempt, ambiguous-on-timeout, with recovery via
idempotency keys above the seam. That is a *different protocol philosophy*
from live capability RPC, chosen on purpose.

At the **edge** (client↔gateway) the two-party limit costs nothing — the
gateway is already the proxy for everything behind it. Star topology is the
one place Cap'n Web's model fits woo exactly.

### 3. The turn is CAS-over-a-transcript, not a method call

A woo turn: run the whole verb optimistically in the gateway against a
derived cache, record every read version and write, ship a signed
`EffectTranscript`, and let the authority accept or reject **atomically,
without re-executing**, with a bounded replan loop on divergence
(CO2.2/CO2.4/CO7). A Cap'n Web pipeline of N verb calls is N independent
turns with interleaving and partial failure in between — while the JS-native
ergonomics (`await api.room.take(thing)`) make it read as one program. Verb
calls also aren't pure functions of their arguments: E_BUDGET, replan,
divergence verdicts (the closed CO6 taxonomy) all have to surface through
promise rejections mid-pipeline, and "half my pipeline committed" is a
foreign concept to woo's turn atomicity.

There is a genuinely interesting research direction hiding here: since
Cap'n Web's pipelined batch is an expression tree and woo's plan is a
speculative transcript, a **batch→single-turn compiler** (one pipelined
expression graph compiled into one plan, one commit) would preserve CO2.2
while giving clients multi-step-one-round-trip ergonomics. But that is a
compiler and a semantics extension, not a wrapper.

### 4. Possession-based authority vs identity-based authority with per-verb perms

Holding a Cap'n Web stub authorizes calling every method on it. Woo verbs on
one object differ per-actor (programmer/owner bits, `x`/`d` perms, wiz-only
verbs on a room any guest can see), and CO14 splits the roles: gateways
authenticate, scopes authorize — per commit, per frame, against the recorded
VM frame. So a stub can never be "the object"; it must be a per-(actor,
object) *facet*. Facets mean per-connection import/export table growth for
every object every wandering guest can reach, with explicit-dispose
discipline and no distributed GC — a resource-management regime the current
protocol avoids entirely by keeping bare names on the wire and zero
per-reference session state.

And the deeper fact, which CO1 admits in plain text: the gateway is inside
the trust boundary; a planner that fabricated provenance could name any
frame. Woo's authorization is identity-based with a trusted planner. Making
authority genuinely capability-shaped would be a semantic change to commit
validation in `src/net/scope.ts` — arguably the more valuable half of the
ocap idea — and it is orthogonal to which wire protocol carries the calls.

### 5. "MCP as a thin wrapper" — the wrapper would not be thin

The expensive parts of woo's MCP surface are exactly the parts a Cap'n Web
layer doesn't supply: the canonical tool-name projection (~900 lines, and
§M2.3 makes canonical naming a *protocol guarantee*), list_changed digest
tracking, the long-poll observation queue, idempotent operation keys, and the
stateless-cursor direction. MCP is JSON-RPC tools with LLM clients on the
other end; those clients will never speak Cap'n Web. Layering woo-MCP over an
internal Cap'n Web session buys marshalling — the cheap part — and leaves
every hard responsibility where it is.

### 6. Maturity and exposure

Still `0.0.x` on npm a year after release; single vendor; no standardization.
Server-side evaluation of client-supplied expression trees is a DoS surface
the README itself flags (rate-limit expensive ops, cap message sizes).
Adopting it as *the* substrate couples woo's protocol evolution to an
early-stage dependency. Adopting it as one dialect couples nothing.

## Does it help decompose the heavyweight parts? Yes — but as a shape, not a dependency

Where the weight actually is: `gateway-do.ts` is 11,867 lines — one class
holding three hand-rolled client dialects (~4,200 lines) *plus* the planner,
replan loop, derived cell mirror, relation mirror, fanout receiver, and MCP
tool projection. The dialect duplication is measurable: error rendering ×3,
session validation ×3, session minting ×4 doors, rate limiting ×3 call
sites, submitter-echo dedupe ×2 mechanisms. None of that duplication is
marshalling — it's the absence of a single client-surface abstraction that
each dialect projects.

Cap'n Web's contribution is the **template**: define the client surface once,
as a small explicit object graph rooted in a session — mint, turn-submit,
reads, observation feed — and make every dialect a thin projection of that
one owner. This is the already-recorded lesson ("hosted invariants should
have one synchronous operation owner shared by every transport") given a
concrete shape. You can take the shape without taking the wire protocol, and
the coherence machinery (which is the actual weight, and which Cap'n Web
explicitly does not do) is untouched either way.

## Recommended posture

1. **Do not** put Cap'n Web under `Host.rpc` or the scope/gateway interior.
   TR3 forbids it and TR3 is correct for a Big-World system.
2. **Do not** reframe MCP as a wrapper over a Cap'n Web layer — the
   dependency points the other way (both are dialects over one surface).
3. **First**, build the durable per-presence observation feed
   (stateless-migration note §4). It is the biggest known correctness gap,
   every dialect needs it, and any future Cap'n Web dialect's reconnect story
   depends on it too.
4. **Second**, extract the single client-surface operation owner from
   `gateway-do.ts` and re-express REST/WS/MCP as projections. This is the
   decomposition win, available immediately, zero new dependencies.
5. **Then, optionally**, add Cap'n Web as a *fourth edge dialect* behind the
   same `clientTurn` entry, replacing the bespoke WS frame vocabulary for
   browser/JS clients — first-class object stubs, pipelining, and callback
   push where a live connection genuinely exists. Bounded, reversible, and it
   inherits the durable feed for resume.
6. **Research track** (no commitment): the pipelined-batch → single-turn-plan
   compiler, and capability-shaped commit validation at the scope. Both take
   the ocap ideas where they'd actually pay, independent of the wire.
