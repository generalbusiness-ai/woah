# Observation Model: System Text Belongs to the Client

Date: 2026-06-10
Branch: `main`
Status: design note; implementation pending

## Summary

woo's stated model is structured observations: catalog code emits a typed
map (`{type, ...fields}`), and the client renders the line. The catalogs do
not follow this consistently. Two vestiges of the LambdaMOO text model
remain:

1. **Exit objects carry English `*_msg` properties** — `leave_msg`,
   `oleave_msg`, `arrive_msg`, `oarrive_msg`, `nogo_msg`, `onogo_msg`
   (`catalogs/chat/manifest.json:495-519`). This is the LambdaMOO
   customizable-message convention, which only works because LambdaMOO has
   `$string_utils:pronoun_sub` to interpolate the actor/object into the
   stored template.

2. **Verb bodies construct rendered English and ship it as `text:`** on
   otherwise-structured observations — e.g. `actor.name + " steps up to " +
   this.name` in the dubspace/pinboard/outliner enter/out verbs, and
   `tell(actor, "You drop " + title + ".")` plus a `text:` field on the
   `dropped`/`taken`/`given` observations in `chat`.

There is **no `pronoun_sub` anywhere** in the catalogs, spec, or bootstrap.
So the `*_msg` convention is half-adopted: woo took LambdaMOO's exit-message
property names without the substitution engine that makes them customizable,
and everywhere else it bakes English into bytecode.

This note resolves the inconsistency by committing fully to the observation
model: **the substrate and catalogs emit structure; the client owns all
system-chrome text.** No pronoun/substitution engine is built at this time;
the consequence of that decision is followed through below.

## Principle: chrome vs content

Draw one line and hold it:

- **System chrome** — "X entered", "X left", "you drop Y", "you can't go
  that way", roster/transition lines. This is *rendered from the event by
  the renderer*. It is never authored as English in a verb body or stored
  as an English property. The observation carries the participants as
  fields (`actor`, `item`, `dest`, `title`, ...); the client template turns
  those into a localized, styled line.

- **User content** — `say`/`emote` utterances, note `.text`, object
  `.description`. This is opaque payload authored by a user, carried
  verbatim in the observation, and displayed as-is. It is not chrome and is
  not templated.

The current code mixes the two: chrome text is being authored server-side
(in `*_msg` props and in verb bodies) as if it were content.

## Implication of "no pronoun engine now"

The thing `*_msg` + `pronoun_sub` bought LambdaMOO was *per-object custom
chrome with the actor's name substituted in* ("%N squeezes through the
gap"). Without a substitution facility there are exactly three options for
chrome, and only one is consistent with the observation model:

- **(rejected) Keep building the string server-side.** Requires the
  substrate to know names, grammar, and eventually locale. This is the
  thing the observation model exists to avoid.
- **(rejected) Keep `*_msg` as stored templates.** Dead without
  `pronoun_sub`; a stored `"%N leaves"` cannot be expanded, and a stored
  `"Fred leaves"` is wrong for everyone not named Fred.
- **(chosen) Client renders chrome from a fixed per-`type` template,
  interpolating the structured fields it receives.** The "%N" lives in the
  client renderer, not in catalog data. There is no per-object override of
  the template for now.

The honest cost of (chosen), recorded here so it is a decision and not a
surprise: **builder-authored custom transition flavor is not available
until a substitution facility exists.** An exit cannot currently say "%N
squeezes through the gap" instead of the default "X leaves." When/if that
capability is wanted, it is a separate, explicit feature — either a real
`pronoun_sub` in the substrate, or shipping a template + fields to the
client to interpolate there — not a reason to keep English in `*_msg`
today.

### The one nuance: static, participant-free strings

A refusal like `nogo_msg` ("The gate is barred.") references no runtime
participant. That string is closer to **content** than chrome — it is
builder-authored flavor with nothing to substitute. It MAY be carried as an
opaque string field in the refusal observation (e.g. `reason:`), displayed
verbatim, with the client supplying a default when absent. Keep this narrow:
it applies only to strings that interpolate nothing. The moment a message
needs the actor/object/destination name, it is chrome and the client
renders it. `leave_msg`/`arrive_msg` and their `o*` pairs interpolate the
actor and are therefore chrome — removed, not migrated.

## Current Code To Change

Catalog / substrate:

- `catalogs/chat/manifest.json` — remove `leave_msg`, `oleave_msg`,
  `arrive_msg`, `oarrive_msg` from the exit class (`:495-519` region);
  the exit `:move`/`:invoke` emits `{type, actor, exit, source, dest}` and
  the client renders departure/arrival. Decide `nogo_msg`/`onogo_msg`:
  either drop them for a client default, or demote to an opaque `reason:`
  string on the refusal observation (participant-free only).
- `catalogs/chat/manifest.json` — `take`/`drop`/`give`: stop building
  `text:` and stop `tell(actor, "You drop ...")`. Emit
  `{type: "dropped"|"taken"|"given", actor, item, title, room}`; the client
  renders both the actor's first-person line and the room's third-person
  line from the type + fields. (`title` is the object's name — a field, not
  a sentence.)
- `catalogs/dubspace`, `catalogs/pinboard`, `catalogs/outliner` — remove
  the `text:` construction (`actor.name + " ..."`) from the enter/out/activity
  observations; keep the structured fields (`actor`, `space`/`board`,
  `origin`, `mount_room`). These verbs are also being relocated to movement
  hooks per the tool-space movement note; the text removal applies wherever
  the observation ends up emitted.

Client:

- `src/client/main.ts` `isChatObservation` (~2989) and `chatSystemText`
  (~3367): every system observation type whose `text:` is being removed
  must have a renderer here, so the chat line is produced from fields, not
  from a server-supplied string. Per the codebase map, `chatSystemText`
  already renders known types when `text:` is absent — the work is to make
  sure each affected type is known and field-complete, then to stop the
  catalog from supplying `text:` so the client path is the only path.
- `src/client/framework.ts` `registerCoreObservationHandlers`: state
  reduction already keys off structured fields; confirm none of it depends
  on the `text:` string being present.

Docs/spec:

- Document the chrome/content line in the events/observations spec: system
  events carry fields and are rendered by the renderer; `text:` is reserved
  for user-authored content (say/emote/note). Note that per-object custom
  chrome is deferred pending a substitution facility.
- `docs/reference/tool-ui.md` and catalog `DESIGN.md` files that show
  server-built transition strings.

## Validation Gates

- A guard (extending the catalog guards) asserts that bundled catalog
  *system* observations do not include a `text:` field, with an explicit
  allow-list for content-bearing types (`say`, `emote`, note read, etc.).
  This is the regression backstop that keeps English out of the substrate.
- For each affected type, a client-render test: given the structured
  observation with no `text:`, the rendered chat line is correct (both the
  actor's view and the room's view for take/drop/give).
- A test that exits with the `*_msg` properties removed still produce
  correct departure/arrival lines via the client renderer.
- Removing `*_msg` does not break the exit `:move` path (destinations and
  refusals still work; only the rendered strings move client-side).

```sh
npm run test:files -- tests/catalogs.test.ts tests/observation-render.test.ts
npm test
```

## Non-Goals

- Do not implement `pronoun_sub` or any server-side substitution now. This
  note assumes its absence and routes around it.
- Do not add per-object custom chrome templates. That is a future feature
  gated on a substitution facility, not part of this cleanup.
- Do not move user content (say/note/description text) into the renderer;
  only system chrome moves.
- Do not keep any `*_msg` property that interpolates a participant as a
  compatibility shim.
