## Authority Versioned Cells

This slice implements the authority/snapshot substrate work called out in
`notes/2026-05-17-performance-architecture.md`: stop sending whole object rows
as the v2 authority refresh format and move authority to versioned state cells.

The new authority shape carries live sessions plus content-addressed page refs
and inline page values for object lineage, live-object cells, property cells,
and verb bytecode cells. CommitScopeDO, MCP, REST, Worker WS, and the dev relay
can materialize or refresh planning state from those cells without a full
`exportWorld()` payload on the normal open/envelope path.

Important compatibility rules:

- `serialized` on `/v2/open` remains a fallback for older or empty commit
  authorities that reject authority-only opens with `E_SNAPSHOT_REQUIRED`.
- `session_objects` remains a legacy request field only for callers that do not
  send an `authority` slice. Authority-bearing requests keep it empty so object
  rows are not duplicated beside `authority`.
- Object-row authority slices are still accepted by merge/materialization code
  for migration compatibility, but new gateway exports use cell slices.

One correctness trap found during review: local planning relays seeded from a
narrow authority slice must include object refs carried in call args and request
body values. Direct native helpers such as `$system:create_api_key_for_owner`
can look up an object only named as an argument; omitting those strings from the
authority roots produces `E_OBJNF` even though the wire format itself is
working.

Another cache trap: state-page merge identity must match the page-ref identity.
Object-lineage pages contain an object display `name`, but lineage page refs do
not key by `name`. Treating that display name as part of identity makes an
unchanged authority refresh appear changed and clears the open executable seed
cache.
