# Demoworld Demo

The first-light demo's seed-only catalog: no foundational primitives,
just the populated room layout that the bundled client and the other
demo apps refer to.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$cockatoo` | `$thing` | Talkative bird. Squawks random phrases, can be taught new ones, can be gagged. Demo-flavoured class with no other catalog dependents. |

## Why it exists

`chat`, `dubspace`, `pinboard`, and `tasks` are catalogs of *types*.
A world that installs them gets the classes and features but no opinion
about what specific rooms or instances should exist. demoworld is the
catalog of *opinions*: it picks the names, locations, exits, props, and
mount-points that make the first-light demo a coherent place.

Splitting the seed work out lets an operator install foundational
catalogs without inheriting the bundled demo. It also keeps the cross-
catalog "dubspace mounts in the Living Room" wiring in one place that
already depends on every demo it references.

## Room layout

```
+---------------+        +---------------+        +---------------+
|  the_chatroom |--SE--> |   the_deck    |--E---> | the_hot_tub   |
|  (Living Rm)  | <--W-- |               | <--W-- |               |
+---------------+        +---------------+        +---------------+
       |                       |                          
       |                       +-- the_pinboard (pinboard catalog)
       |                       |
       |                       S (steps)
       |                       v
       |                  +---------------+
       |                  |  the_garden   |
       |                  +---------------+
       |                       |
       |                       S (gravelled path)
       |                       v
       |                  the_taskboard (tasks catalog — "Santa's workshop")
       |
       +-- the_dubspace (dubspace catalog)
       +-- the_couch ($furniture), the_lamp ($portable),
           the_mug ($portable), the_cockatoo ($cockatoo)

the_deck also holds:
  the_towel ($portable)
```

All bundled demo instances — `the_dubspace` and its controls,
`the_pinboard`, `the_outline`, `the_weather`, `the_horoscope` — are
seeded by **demoworld itself**, not by their class catalogs. Demoworld
depends on `chat`, `tasks`, `outliner`, `pinboard`, `dubspace`,
`weather`, and `horoscope`; nothing depends on demoworld. The
dependency direction is enforced by
[`scripts/guard-catalog-layering.mjs`](../../scripts/guard-catalog-layering.mjs).

This inversion lets operators install the class libraries without the
demo geography: a world that wants `$pinboard`/`$outliner` classes but
its own room layout installs `pinboard` and `outliner` directly and
skips `demoworld`. The class catalogs ship with no demoworld coupling
in their manifests.

## Cockatoo

Cheap imitation of the LambdaMOO cockatoo (#1479) — squawks random
phrases, can be taught new ones, gagged when too noisy. Self-driven
timer chatter is deferred until the DSL exposes `fork`; for now
squawking is actor-driven.

## What demoworld is not

- Not a replacement for the `chat` catalog. `chat` defines `$room`,
  `$exit`, `$conversational`, `$chatroom`, `$portable`, `$furniture`,
  `$match` — the building blocks. demoworld only assembles them.
- Not a foundation for third-party catalogs. A world that installs
  `chat` + a community-published room set should not need demoworld.

## What goes here

New bundled demo placements belong in demoworld's `seed_hooks`. To
ship a new demo:

1. Build the class catalog (with classes/verbs and no demoworld
   coupling). It must not declare `@local:demoworld` in its `depends`.
2. Add `@local:<new-catalog>` to demoworld's `depends`.
3. Append a `create_instance` (and any `attach_feature` /
   `set_property`) entry to demoworld's `seed_hooks` referencing
   demoworld-local objects (e.g. `the_chatroom`, `the_deck`) for
   `location` / `mount_room`.

The reverse direction — a class catalog seeding into demoworld's
rooms — is blocked by the layering guard.
