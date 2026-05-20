# Browser and v2 open instrumentation

Origin: 2026-05-20 performance follow-up for reports that opening outliner can
take minutes while server-side `/v2/open` aggregates look small.

The instrumentation is intentionally activity-wide rather than limited to the
currently suspected expensive paths. The browser worker now emits
`browser_activity` for command handling, WebSocket connect/readiness/send,
frame decode/process, every cache mutation kind, every IndexedDB transaction,
execution-cache reconstruction, local turn planning, repair state-transfer
requests, and outbound frames. The main thread adds projection-apply and render
activity. The main thread batches these to `/api/browser-metrics`; the server
authenticates with the normal session header, overwrites actor with the
session actor, applies a per-session sampling window for burst protection, and
logs the resulting metric under host key `browser`. The client also bounds the
metric queue and sends at most one browser-metric batch per second, so
diagnostics cannot turn a browser-side event flood into a gateway POST flood.

Server-side `/v2/open` now has `v2_open_step` phase records. CommitScopeDO
records verify/read/relay/session/browser/open/full-save/response phases, while
the gateway WebSocket path records authority construction, CommitScopeDO open
RPC, and frame encoding/sends for hello, display transfer, executable transfer,
and ads. `openShadowBrowserScope` also records executable-seed internals:
catalog preseed selection/install, catch-up transfer build/apply, cache-hit
marker build, full seed build, digest, install, JSON byte sizing, ads, and
total.

This should let production traces separate browser cache work, main-thread
rendering, network/gateway transport, CommitScopeDO seed work, and full-save
cost without guessing.
