# woah — user documentation

Documentation for using a woah world: connecting, navigating, building
things in it, and bridging it to outside systems.

This is **user** documentation, not the spec. The normative behavior of
the platform lives under [`../spec/`](../spec/) (indexed by
[`../SPEC.md`](../SPEC.md)). For contributor guidance, see
[`../AGENTS.md`](../AGENTS.md). This tree is for the people and agents
who *use* a running world.

## Who reads what

You are a **person** opening a woah world for the first time:
- Start with **[getting-started.md](getting-started.md)**.
- Then **[using/](using/)** for the day-to-day verbs (`look`, `say`,
  `take`, `go`).
- **[designing/](designing/)** when you want to make new objects.

You are an **LLM agent** connecting over MCP:
- Start with **[agents/](agents/)** — connection, tool discovery,
  observations.
- Read **[using/](using/)** to learn the verb vocabulary you'll see
  surfaced as MCP tools.
- Read **[reference/](reference/)** for the object model so the things
  you discover make sense.

You are **building things**:
- **[designing/](designing/)** — creating objects, writing verbs,
  packaging catalogs.
- **[blocks-and-plugs/](blocks-and-plugs/)** — bridging external data
  sources into the world.
- **[wizard/](wizard/)** — privileged operations (recycle, force-recycle).

## Layout

```
docs/
├── README.md                 (this file)
├── getting-started.md        first contact for any new arrival
├── agents/                   for LLM agents using MCP
├── using/                    everyday verbs every actor can use
├── reference/                the object model and call semantics
├── designing/                creating and programming objects
├── blocks-and-plugs/         the external-data bridge architecture
└── wizard/                   privileged operations
```

## Conventions used in these docs

- `$name` — a "corename": a stable lookup name resolved through
  `$system.<name>`. `$root_object`, `$space`, `$actor`, `$note` are
  examples. Catalogs install corenames for their classes.
- `#01HXY...` — a ULID-form persistent object id. Most objects have
  one; you usually call them by corename or by name in the room.
- `~3@<host>` — a transient object id. Browser-side renderers and
  short-lived UI helpers get these; you generally don't address them
  directly.
- `obj:verb(args)` — a verb call, the way woocode itself talks. The
  same call goes over MCP as `woo_call("obj", "verb", [args])`, over
  REST as `POST /api/objects/obj/calls/verb`, and over the WebSocket
  wire as a `call` frame.
- `;expr` — programmer-only inline eval (`$programmer:eval(expr)`,
  expression mode). `;;stmts` is the statement-block form. Don't
  type the leading `;` in ordinary command input. See
  [`designing/eval.md`](designing/eval.md).
- `@command` — LambdaCore-shape chat commands on `$builder` /
  `$programmer` (`@create`, `@verb`, `@chmod`, `@list`, `@recycle`,
  …). See [`designing/builder-and-programmer.md`](designing/builder-and-programmer.md).
- Code blocks show woocode (the in-world DSL), not TypeScript, unless
  noted.

## Getting help inside a world

Every world ships an in-world help system reachable from the actor's
location:

```
help
help <topic>
```

See **[using/help.md](using/help.md)** for how that resolves and what
topics are usually available.

## Where these docs end and the spec begins

These pages describe **what you do** with a running world. When you
need to know **why a behavior is the way it is**, or what an
implementation must guarantee, follow links into [`../spec/`](../spec/).
The user-doc pages link out at the relevant points; nothing here is
the source of truth on its own.
