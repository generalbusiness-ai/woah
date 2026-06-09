# Localdev browser state-transfer instrumentation

Date: 2026-06-08
Branch: `localdev-state-transfer-instrument`
Base: `cf-local-authority-fast`

## What changed

Added browser-worker attribution to `browser_activity` `state_transfer_request`
metrics. Each repair transfer now reports:

- request shape: request/envelope bytes, request-body bytes, known-page hash
  count/bytes, key atom/preimage counts, missing atom counts;
- missing atom categories: verb reads, property reads, contents reads,
  lifecycle reads, writes, other;
- reply shape: reply bytes, metadata bytes, page-ref bytes, inline-page bytes,
  preimage/hash bytes, page-ref/inline/omitted page counts;
- repaired command path and route, so transfer cost can be grouped by the verb
  that triggered repair.

The dev-server and Worker metric ingestion paths pass these fields through as an
allow-listed numeric set. The browser e2e architecture test now guards that any
state-transfer repair metrics carry the attribution fields and remain bounded.

## Measurement run

Command:

```bash
PORT=5277 VITE_HMR_PORT=15277 WOO_DB=.woo/e2e-state-transfer-instrument-3.sqlite WOO_METRICS=on npm run dev
WOO_E2E_BASE_URL=http://localhost:5277 npx playwright test e2e/smoke.spec.ts -g "two browser agents execute locally"
```

Result: 1/1 passed, Playwright duration 21.7s.

Metric stream: 1,507 `woo.metric` events, 1,349 `browser_activity` events.

## Browser phase profile

Top browser phases by summed `ms`:

| phase | count | ms sum |
|---|---:|---:|
| command | 13 | 4,008 |
| turn_intent | 9 | 4,003 |
| idb_tx | 902 | 2,659 |
| local_turn_repair | 10 | 2,553 |
| state_transfer_request | 10 | 2,539 |
| connect_ready_wait | 4 | 2,400 |
| turn_connect_wait | 13 | 1,240 |
| execution_cache_build | 77 | 1,012 |
| local_turn_plan | 22 | 900 |
| local_turn_execution_cache | 22 | 799 |

## State-transfer attribution

Across 10 repair transfers:

| field | sum |
|---|---:|
| request bytes | 396,967 |
| request body bytes | 393,317 |
| known-page hash bytes | 270,020 |
| known-page hashes | 4,030 |
| missing atoms | 123 |
| missing read verbs | 86 |
| missing read props | 34 |
| missing contents reads | 2 |
| missing lifecycle reads | 1 |
| reply bytes | 192,071 |
| reply metadata bytes | 88,397 |
| reply inline-page bytes | 103,694 |
| reply page refs | 336 |
| reply inline pages | 144 |
| reply omitted pages | 192 |

By repaired command:

| repaired path/scope | count | ms | request bytes | known-hash bytes | missing atoms | reply bytes |
|---|---:|---:|---:|---:|---:|---:|
| `command_plan` / `the_chatroom` | 6 | 1,560 | 234,721 | 148,009 | 112 | 154,071 |
| `drop` / `the_deck` | 2 | 502 | 75,322 | 60,905 | 9 | 17,031 |
| `command_plan` / `the_deck` | 2 | 477 | 86,924 | 61,106 | 2 | 20,969 |

The first `command_plan` repair for each actor is the biggest fixed pattern:
51 missing atoms each, mostly verb reads (38) and property reads (12).

## Findings

1. The remaining state-transfer wall is a repair-round problem first. `command_plan`
   accounts for 8/10 repair transfers and 2.04s of the 2.54s transfer wall. A
   clean improvement should make command planning executable from the open seed
   or otherwise warm its declared closure before the first free-form command.

2. The largest byte waste in the transfer protocol is request-side known-page hash
   echo. The browser sent 270KB of known-page hashes to receive 192KB of replies.
   The known-page echo does useful work (192 omitted pages avoided re-send), but
   sending the whole held hash set on every repair is now the clearest protocol
   overhead.

3. Reply payload is split roughly evenly between metadata and inline pages. There
   is no single giant inline-page resend left; page-content dedupe is working.

4. IDB is still visible but is no longer a single obvious storm. The largest read
   costs are `pending`, `transcript_tail`, `applied_frames`,
   `execution_transfers`, and `state_pages`. These are probably amplified by the
   repair loop; reducing repairs should be measured before another IDB-specific
   pass.

## Recommended next improvements

1. **Warm command-planning closure cleanly.** Use existing metadata/dependency
   declarations, not command-word hardcoding, to ensure the open executable seed
   includes the stable `command_plan` verb/property closure needed by first
   free-form commands. Target: remove the 51/4/1 `command_plan` repair sequence
   per actor.

2. **Replace full known-page hash echo with a compact cache identity.** A clean
   protocol would let the browser advertise a digest/epoch for its held state-page
   set, then fall back to explicit hashes only when the server cannot use that
   identity. Target: keep omitted-page behavior while avoiding ~24-31KB request
   overhead on every repair.

3. **Only after those two, remeasure IDB.** Current IDB cost is real, but the
   state-transfer/repair loop still drives repeated cache rebuilds and reads.
   Optimizing IDB before reducing the repair count risks shaving symptoms.

## Follow-up: command-plan open-seed closure

Implemented the first recommendation on this branch.

What changed:

- `plan_command` now parses object phrases against the bounded command surface:
  ids, `name`, `aliases`, and local `:match_names()` contributions. It no
  longer dispatches presentation `:title()` while deciding command syntax.
  Generic `$match:match_object` keeps the richer title-aware behavior for
  compatibility.
- The browser open executable seed now includes the declared command-surface
  cells for the visible object set: scope, actor, scope contents, actor
  inventory, and linked tool-room refs.
- `plan_command.open_seed` records the object property and verb-lookup contract
  (`name`/`description`/`aliases`, plus `match_names`) so this stays metadata
  driven rather than catalog-word driven.
- The spec now states the command-planner boundary explicitly.

Measurement:

```bash
PORT=5278 VITE_HMR_PORT=15278 WOO_DB=.woo/e2e-command-plan-open-seed.sqlite WOO_METRICS=on npm run dev
WOO_E2E_BASE_URL=http://localhost:5278 npx playwright test e2e/smoke.spec.ts -g "two browser agents execute locally"
```

Result: 1/1 passed, Playwright duration 18.4s.

Before vs after:

| metric | baseline | command-surface seed |
|---|---:|---:|
| state-transfer repairs | 10 | 5 |
| `command_plan` repairs | 8 | 1 |
| state-transfer request bytes | 396,967 | 191,752 |
| known-page hash bytes | 270,020 | 140,437 |
| reply bytes | 192,071 | 35,896 |
| first chatroom open seed bytes | 411,511 | 420,658 |

The main 51-atom `command_plan` repair is gone for cold command text. The
remaining repairs are now mostly direct `take`/`drop` execution and one smaller
six-verb `command_plan` repair after a scope/state transition.

Rejected experiment:

- Seeding finite alias lookup atoms for selected dispatch verbs was tried and
  measured separately in `.woo/e2e-command-plan-alias-seed.log`.
- It increased first chatroom open seed bytes to 440,250 and repair count to 8,
  so it was not kept.

Next actionable hotspot:

The protocol still sends a full known-page hash echo on every repair. Even after
repair reduction, known-page hashes were 140KB of 192KB request bytes in the
accepted run. The cache-identity/digest protocol remains the clean next byte
win, while direct `take`/`drop` repair preimages are the next semantic closure
to inspect.

## 2026-06-09 compact known-page echo

Implemented a relay-issued `woo.known_page_hash_set.v1` identity for the
browser's held executable state-page set. Each state transfer response registers
the post-install held set, and later repair requests send the compact identity
instead of echoing every page hash. When the worker has no confirmed identity it
now omits the known-page hint entirely rather than sending the full
`known_page_hashes` list; local measurements showed the repair closures are
small enough that inlining them is cheaper than echoing hundreds of cached
hashes. The relay still accepts explicit `known_page_hashes` for non-browser
senders and regression tests, but the browser worker no longer emits that field
on repair requests. A relay miss also falls back to treating all pages as
unknown, producing a larger but correct transfer.

Final localdev two-agent e2e measurement:

| metric | command-seed baseline | compact echo |
| --- | ---: | ---: |
| state-transfer repairs | 5 | 8 |
| request bytes | 191,752 | 94,223 |
| known-page hash bytes | 140,437 | 16 |
| compact-token requests | 0 | 5 |
| reply bytes | 35,896 | 90,447 |
| total transfer bytes | 227,648 | 184,670 |

The byte win is on the intended axis: explicit known-page hash echo is removed
from the browser repair hot path, request bytes fall by about 51%, and total
state-transfer bytes still fall by about 19% despite more inline reply pages in
this sample. A scope-preserving token variant was tried and rejected: it reduced
request bytes further in some runs, but new scope relays missed the token and
inlined enough pages to make total transfer bytes worse. The worker therefore
clears the compact identity on scope/socket authority changes and registers a
fresh token on the next repair.
