# REST Implementation Gaps

Status: known follow-up items after the first runtime REST slice.

- Permission-filtered describe/property reads are implemented on the local server and Worker object routes. The remaining caveat is `/api/state`: it is an authenticated demo aggregate, not the production REST surface, and should not be treated as permission-complete.
- SSE retention bounds are not enforced yet. `Last-Event-ID` replay works while logs are complete; once log truncation or snapshot-driven compaction lands, old cursors must return `410 E_SSE_TOO_OLD` and direct clients to `/log`.
- Transient refs (`~...`) are not resolved by REST yet. This can wait until browser-host transient objects participate in runtime calls.
- Static corename lookup is backed by seeded Directory routes on Cloudflare and object-id lookup locally. Runtime-added corename maps still need an explicit `$system`/Directory registration path.
