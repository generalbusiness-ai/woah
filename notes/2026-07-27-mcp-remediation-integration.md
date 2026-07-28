# MCP-surface remediation — integration review guide

Date: 2026-07-27. Remediates the findings of
`notes/2026-07-27-mcp-surface-walkthrough.md` across four worktree branches,
plus a prepared (unpushed, unmerged) integration branch proving they compose.
**Nothing is merged to main; nothing is deployed.**

## Branches

| branch | worktree | head | scope |
|---|---|---|---|
| `worktree-wizard-provision` | `.claude/worktrees/wizard-provision` | `d5ee039a` | AP11 signed-operator wizard provisioning (un-bricks prod) |
| `worktree-mcp-gateway-legibility` | `.claude/worktrees/mcp-gateway-legibility` | `f182117f` | woo_call contract, refusal split, gap marker, descriptions, own-turn observations |
| `worktree-help-crash` | `.claude/worktrees/help-crash` | `73e5e4b3` | help unknown-topic E_CATALOG_MUTATION crash; help catalog 0.2.0→1.0.0 + Net repair path |
| `worktree-core-observation-authoring` | `.claude/worktrees/core-observation-authoring` | `a26d6a11` | directed-echo audience fix, eval #objref + lexer dot bug, trace honesty, edit_verb legibility |
| `worktree-integration-trial` | `.claude/worktrees/integration-trial` | `cd968da6` | all four merged (zero conflicts) + one seam-documentation commit |

## Gates on the merged tree (integration-trial, round 2)

typecheck clean (both tsconfigs) · `npm test` 81 files / **999** ·
`npm run test:worker` 42 files / **316** · `npm run test:full` 151 files /
**1874** · `smoke:net-dev` **41/41** · `smoke:net-mcp` **15/15**.
(Round 1 was 988 / 309 / 1854 with the same smokes; every round-2 fix is
negative-tested — reverting the fix fails the new test.) Each branch also
ran its own gates green in isolation. Deployed lane not run (no deploy
authorized); cross-colo / cold-owner behavior remains a deploy-only signal
per the smoke fidelity ladder.

## Round 2 — human review dispositions

Eight findings, all fixed on the owning branch. Four of them turned out to
be bigger than filed:

| # | Finding | Disposition |
|---|---|---|
| 1 (P1) | Repeated revocation corrupted `agent_count` (2→1→0, quota bypass) | Fixed: tombstone read before any mutation decides whether the slot returns. A repeat now also *repairs* an actor tombstoned by `deactivate_actor` (which never revokes keys). `setProgrammerAgentState` audited — was correct, now has a regression test. |
| 2 (P1) | Unvalidated `api_key_id` pointer; session survived retirement | Fixed on four axes (routed parse, actor binding, authority root, live verifier record — which lives in the actor-owned `api_keys` property, not the legacy `$system.api_keys` global). Session-bearer validation gained a view-only tombstone gate. **Widened by probing**: a retired wizard using a SECOND credential (which `revoke_agent` never touches — exactly the AP11 state between runbook steps 2 and 3) paired its live key with an existing session and committed a wizard-only `set_quota` turn: 200 accepted, account cell written. Both classes now gated. |
| 3 (P1) | Help 1.0 had no Net path; SQLite test never ran the migration | **The Net path already existed** and both the earlier report and the review were wrong: `repair:net-definitions` carries a `remove` array, and its CLI admits a drop only when a published bundled migration declares it. Proven end-to-end on an aged fake-DO world. The real structural fact — a Net world never runs the local catalog lifecycle — is now spec'd (CT14.7). **Fixing the SQLite test exposed a substrate defect**: `savepoint()` never maintained `transactionDepth`, so the first step of *every* bundled catalog migration failed on SQLite ("cannot start a transaction within a transaction"), the error was swallowed into `migration_state`, and the version still advanced — a world reporting itself migrated with zero steps applied. Fixed at the repository seam (CT14.3). |
| 4 (P2) | `provision_id` collided with `Object.prototype` | Fixed (null-prototype ledger, own-key reads, 1..128 bound). **Root cause was not AP11**: `clonePlainData` used `copy[key] = value`, hitting the inherited `__proto__` accessor — a scalar entry silently dropped on every clone, an object entry becoming the clone's prototype: a pollution primitive expressible in plain woo data. Three siblings had it, including **`sortKeys` in `src/net/cells.ts`**, the canonical encoder behind `cellVersion` — a dropped key makes two materially different cell values hash identically (version collision). New normative rule: spec/semantics/values.md §V6. |
| 5 (P2) | `woo_call` exact-compared alias patterns | Fixed by extracting the dispatcher's matcher to `src/core/verb-name-match.ts` (shared, not re-implemented). **Precedence mattered as much as matching**: a flat exact-then-alias pass would run an ancestor's exactly-named verb where the world runs a nearer class's aliased one — wrong-verb execution, worse than the E_VERBNF it replaces. Drafts now carry `definer` and matching walks the chain in order. |
| 6 (P2) | `$here` resolved placeless actors to `$nowhere` | Fixed at the single derivation point (`mcpPlacedScope`), which `$here`, the tool projection, the pager's `active_scope` and the E_SCOPE_SPLIT hint all read through. Also closes the walkthrough's `nowhere__look` wart. |
| 7 (P2) | Lexer dot change re-meant existing `#foo.bar` | Closed from both ends: quoted `#"foo.bar"` / `$"foo.bar"` escapes (sharing one scanner with string literals) + `assertMintableObjectId` at the one mint seam, with an explicit `restoring` exemption so identity import can't strand a world. **The unconstrained mint path was catalog install** (a manifest's `local_name`/`seed_hooks.as` map to ids verbatim), not runtime creation. No migration needed *because* the escape keeps existing objects reachable — spec §5.5.1. |
| 8 (P3) | Block comment preferred over earlier `//` docs | Fixed: first documentation comment by source offset wins, whichever style. Real `$builder:create_command` description pinned end-to-end. |

## What each branch does (review order suggested)

1. **wizard-provision** — one new tracked native
   `$human:provision_wizard_agent` doing quota-grant → create → promote →
   wizard-flag in ONE atomic turn; signed edge route
   `POST /net-operator/wizard/provision` → gateway `/net/provision-wizard`,
   which runs the world's own primitive through the planner (the accepted
   transcript is the audit). Idempotency via operator `provision_id` ledger
   with a fail-closed reverse pointer. Composes with
   `/net-operator/credentials/ensure` (provision → ensure → provision again
   with the key pointer). Spec §AP11 in spec/identity/provisioning.md; CLI
   `npm run provision:net-wizard`; design note
   `notes/2026-07-27-wizard-provision-op.md`. **En route it found and fixed
   two more Net-dead verbs**: `$system:set_quota` and `$human:revoke_agent`
   both failed E_CATALOG_MUTATION on the `$system.wizard_actions` audit
   write (the other half of the deadlock); audits moved to the AU1 sink.
2. **mcp-gateway-legibility** — `woo_call` widened to the documented
   contract (reachability + verb existence + executability; `tool_exposed`
   is listing-only; world authority unchanged — tested that `$wiz:eval`
   stays unreachable for guests and E_PERM still fires with trace frames).
   Refusals split into five named conditions with remediations, including
   an E_SCOPE_SPLIT hint naming the space to enter. `woo_wait` now returns
   `{observations, gap}` (spec §M5.1) — conservative continuity marker on
   DO restart / buffer overflow. Tool descriptions take the first
   paragraph (two extraction bugs). Initialize instructions now point at
   help/woo_wait/pager. The walkthrough's 128-vs-142 "mismatch" was
   pagination (unfollowed nextCursor) — pinned as a test identity. Second
   commit (`39ec48e8`): the submitter's own turn observations now ride the
   tool reply (`structuredContent.observations` sibling; spec §M4.1) —
   fixing "an actor never hears its own turn over MCP", found by WS4.
3. **help-crash** — root cause: the catalog-write refusal is a COMMIT-time
   verdict, so the existing in-verb try/except could never catch it.
   `missed_topics` machinery removed end-to-end (nothing read it); unknown
   topic now returns `{ok:false, status:"not_found", topics, lines}` from
   both the DSL and native paths; help catalog 1.0.0 with
   `drop_verb`/`drop_property` migration, per project convention.
4. **core-observation-authoring** — the directed-echo leak was in the
   committed-fanout filter (`to`-only; `text` names its recipient in
   `target`), and the spec caveat claiming no sequenced verb emits
   directed observations was false ($exit:move does). Shared
   `observationReachesActor` predicate now used by gateway fanout and
   core; spec events.md §12.7 states the normative rule; the leaked line
   is pinned verbatim in a test that fails without the fix. Also: lexer
   bug fixed (`#ref.`/`$ref.` swallowed the dot → property reads silently
   compiled to string literals); eval diagnostics gained hint/symbol with
   a world-sharpened "did you mean #<id>?"; `trace` deliberately NOT
   exposed (it is `raise E_NOT_IMPLEMENTED` — exposing it would recreate
   the listed-but-uncallable trap) but its refusal is now legible;
   `edit_verb` raises `E_EDITOR_UNAVAILABLE` naming both aged-world
   remedies instead of the substrate internals dump.

## Reviewer decision points (flagged, not defects)

- **`$me` / `$here` transport aliases in woo_call** (WS2, unrequested):
  makes ~20 existing doc examples true; `$me` was already reserved in the
  layering guard. Revert the hunk and fix the docs instead if unwanted.
- **Two audience expressions on purpose**: `observationReachesActor`
  (fanout: "may I hear this?") vs `mcpOwnTurnObservations` (reply: "what
  did my turn emit?"). Mechanical unification would drop the submitter's
  outbound tell lines (`directedRecipients` gives `text` no from-echo).
  Documented at the reply-seat filter in the integration commit
  `b448654e`; the same comment should ride whichever branch order you
  merge.
- **Layering-guard baseline +4** (WS1): irreducible `$account`/`$agent`/
  `$human` seed declarations; agent minimized first.
- **Help catalog major bump** (WS3): required by the drop convention;
  brings the Net-side definition-drop question below.

## Known residuals (explicitly NOT fixed, all recorded)

Round-2 additions:
- Tombstone propagation latency is uncharacterized (the fake-DO lane
  settles fanout synchronously). The api-key gate covers the window only
  when the retired actor carries an `api_key_id` pointer.
- Remaining §V6 map-key sites unaudited (catalog-installer exits,
  bootstrap verb metadata, two gateway `out[...]` builders) — reasoned
  about, not probed; their key spaces are ids/scope names/fixed vocab.
- Instance-data migration rewrites (`transform_property`/`rename_property`)
  have no Net operator path in v1; `$catalog_registry.installed_catalogs`
  is never advanced by a repair, so a Net world reports its genesis
  catalog version forever. Both pre-existing, both true of every bundled
  major bump already delivered this way; now spec'd rather than silent.
- The SQLite savepoint fix changes behavior for any outermost-savepoint
  caller (three call sites today, all catalog-install/migration).
- No deployed world has been audited for existing dotted object ids; the
  escape syntax makes the answer non-blocking, but certainty needs an
  operator query.
- `direct_callable` / `verb_not_executable` refusal paths remain untested
  (no bundled catalog contains a qualifying verb).

- `trace` remains unimplemented — a programmer still cannot trace verbs.
  Feature work, not remediation.
- `$human:create_agent` is still Net-dead (probe-confirmed
  incomplete_transcript): its catalog audit write was moved, but the
  native is untracked. Other `recordWizardAction` sites
  (actor_deactivated/reactivated/recycled, mint_session_for,
  force_recycle, force_direct) have the same latent problem — not probed.
- Fresh installs still seed no usable wizard; the AP11 runbook is the
  sanctioned path for every world.
- Tool-granularity redesign (compass/speech collapse, mounted-space
  partitioning, presence-vs-working-set focus decoupling) deliberately
  deferred to a design round — see walkthrough note §(b).
- `appliedFrameAudience` is a dead-code candidate (directed-aware for
  spec consistency, no external consumer).
- `revoke_api_key` lacks an authority prefetch (costs one E_READ_VERSION
  repair round; converges).

## Deploy-day checklist accumulating on these branches (when a deploy IS authorized)

1. `npm run provision:net-wizard` once against a real human account
   (provision → credential ensure → provision with key pointer).
2. `repair:net-definitions '$programmer:edit_verb'` (pre-existing item).
3. `repair:net-seed-properties` (pre-existing item).
4. Help catalog 1.0.0 upgrade (settled in round 2 — one signed call
   carries both halves at a single advanced head):
   `npm run repair:net-definitions -- <worker> '$player:help' --drop
   '$generic_help_db:record_miss' 'prop:$generic_help_db:missed_topics'`.
   Order-independent with the deploy: an aged world fails either
   `E_CATALOG_MUTATION` (old runtime) or `incomplete_transcript` (new
   runtime), and the same repair fixes both.
5. Deployed `smoke:walkthrough` after all of the above.

Note the repair ops themselves have only ever been exercised against fake
DOs on these branches — no operator run against a real deployed world.
