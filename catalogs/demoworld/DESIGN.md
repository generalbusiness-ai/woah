# Demoworld Demo

The first-light demo's seed-only catalog: no foundational primitives,
just the populated room layout that the bundled client and the other
demo apps refer to.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$cockatoo` | `$thing` | Talkative bird. Squawks random phrases, can be taught new ones, can be gagged. Demo-flavoured class with no other catalog dependents. |

## Why it exists

`chat`, `dubspace`, `pinboard`, and `taskspace` are catalogs of *types*.
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
       |
       +-- the_dubspace (dubspace catalog)
       +-- the_couch ($furniture), the_lamp ($portable),
           the_mug ($portable), the_cockatoo ($cockatoo)

the_deck also holds:
  the_towel ($portable)
```

`the_dubspace` and `the_pinboard` are seeded by their own catalogs
(`dubspace`, `pinboard`) which depend on `demoworld` so the
`location` references resolve.

## Cockatoo

Cheap imitation of the LambdaMOO cockatoo (#1479) — squawks random
phrases, can be taught new ones, gagged when too noisy. Self-driven
timer chatter is deferred until the DSL exposes `fork`; for now
squawking is actor-driven.

## What demoworld is not

- Not a replacement for the `chat` catalog. `chat` defines `$room`,
  `$exit`, `$conversational`, `$chatroom`, `$portable`, `$furniture`,
  `$match` — the building blocks. demoworld only assembles them.
- Not a long-term home for new world-content. Each new bundled demo
  should ship its own seed catalog (dubspace / pinboard / taskspace
  pattern) rather than appending to demoworld.
- Not a foundation for third-party catalogs. A world that installs
  `chat` + a community-published room set should not need demoworld.
