# Gateway Session Presence Worktree Verdict

Date: 2026-06-16
Worktree: `.claude/worktrees/gateway-session-presence`
Base: `a873063`
Status: abandoned as a fix candidate

## Decision

Do not merge or continue the dirty `gateway-session-presence` patch in place.
Remove the worktree after preserving this note. A fresh session-presence fix
must start from a failing-on-main reproduction that proves the missing session
path is not already covered by the current MCP session-open authority merge.

## Why the patch is not safe

The patch adds diagnostic detail to `E_NOSESSION` in `src/core/world.ts`,
including `present_session_ids`. MCP preserves error `value` through
`src/mcp/host.ts` and returns it in `src/mcp/server.ts` structured content,
so this leaks live session identifiers to clients on tool errors.

The added e2e test strips sessions from the mocked `authorityPayload`, but the
normal `ensureV2ScopeSessionOpen` path wraps the payload with
`withMcpSessionAuthority` and then merges it into the scope client before
planning. That means a session-less seed alone does not prove the bug. The new
test can pass even if the extra injection helper is removed.

The patch also adds a new `mcp_calling_session_injected` metric without adding
it to `scripts/analyze-data-path-costs.mjs`; the metric-classification test is
therefore red.

## Salvage

Useful ideas to preserve:

- A sanitized `E_NOSESSION` reason can be useful, but it must not include
  session ids or other client-visible inventory. Counts and enum reasons are
  enough for public error values; richer detail belongs in metrics/tails.
- A session-presence metric may be useful if a fresh repro proves an actual
  injection path. If added, classify it in the data-path analyzer at the same
  time.
- The next test must fail on `main`. Acceptable shapes include:
  - `openedSessions` says a session is open while the relay serialized world
    lacks that session.
  - A replay/minimized harness for the deployed `E_NOSESSION` tail reproduces
    the local planning failure.
  - A post-open merge/prune path removes the session because an actor row is
    missing, proving the fix must address actor/session consistency rather
    than blindly adding a session row.

## Next Work

Do not combine this with another blind gateway injection. First land the named
divergence taxonomy from the state-epoch plan, then add an aged-world lane that
can reproduce stale gateway/commit-scope relationships before another deployed
state-path fix.
