# Implementation Principles

## Source of Truth

- `spec/semantics/core.md` defines the core model.
- `spec/semantics/bootstrap.md` defines the seed object graph.
- `spec/semantics/introspection.md` defines the discovery surface.
- `catalogs/dubspace/DESIGN.md` defines the first user-visible demo.
- `catalogs/taskspace/DESIGN.md` defines the async coordination demo.
- `spec/authoring/minimal-ide.md` defines the first authoring loop.
- `spec/protocol/wire.md` defines the first-light websocket protocol.
- `spec/reference/` defines the current Cloudflare-oriented reference mapping.

## Keep The First Build Small

The first implementation proves the model. It includes the T0 VM profile, but
does not need the full language, full VM, LambdaCore compatibility, federation,
or full programmable end-user code.

Prefer seeded objects and seeded T0 bytecode for the first slice. Add the full
DSL, host RPC, suspension, and browser-host VM only after the core
message/object/space path is working.

The minimal IDE is a planned small slice, not the full authoring system: object
inspection, T0 source compile/install, structured diagnostics, and test calls.

## Separate Semantic Layers

- **Message:** request payload.
- **Mutation:** durable state change caused by applying a message.
- **Observation:** output sent to clients/renderers.
- **Snapshot:** materialized state used for reload.

Do not blur these into one generic "event" type in code.

## `$space` Must Stay Boring

`$space` accepts messages, assigns local sequence numbers, stores history, and
applies messages in order. Domain behavior belongs to target objects, not the
sequencer itself.

## Determinism Boundary

Within one `$space`, sequence order is authoritative. Outside one `$space`,
there is no implicit total order.

If behavior needs randomness, time, or external input, record the chosen value
in the sequenced message or resulting mutation so replay can be explained.

## Direct Authoring Is Not `$space`

Editing object definitions is an administrative object mutation, not a domain
message. Compile/install operations go directly to the object's host with
`expected_version` checks. Authored behavior can then be tested through
`$space:call`.

## Reference, Not Compatibility

LambdaCore is a reference corpus. Use it to understand object roles and
permission patterns. Do not reproduce its mail/help/editor/builder surface as
part of the first build.
