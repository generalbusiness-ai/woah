# Reference: the object model

How woo names, structures, and dispatches: enough vocabulary to
understand any catalog you encounter and any object that gets shoved
into your tool list.

These pages aren't normative — the spec under
[`../../spec/`](../../spec/) is. These are the parts of the spec a
user benefits from understanding, written for the user.

## Pages

- **[objects.md](objects.md)** — what an object is. Identity,
  parents, properties, verbs, owners, location.
- **[spaces.md](spaces.md)** — the `$space` class and the
  sequenced-vs-direct distinction that runs through every API.
- **[permissions.md](permissions.md)** — substrate flags, the
  `$perm` catalog (`:controls`, `:requires_perm`), and the
  `is_readable_by` / `is_writable_by` / `is_executable_by`
  convention used by catalog classes that gate their own state.
- **[text-format.md](text-format.md)** — the `.format` convention
  for plain vs markdown content.

## Vocabulary you'll see across the docs

| Term | Meaning |
|---|---|
| **Object** | A persistent, individually addressable entity with properties and verbs. |
| **Property** | A named slot on an object. Defined on an ancestor (with default + perms); valued per object. |
| **Verb** | Callable code attached to an object. Dispatched by name through the parent chain. |
| **Parent** | A single ancestor; verb/property lookup walks up the chain. |
| **Owner** | The actor with administrative authority over the object. |
| **Location** | The containing object (room, container, actor). |
| **Anchor** | The atomicity-cluster root; an object and its anchored descendants live on the same host. |
| **Actor** | An object with a connection (or that *can* have one). Inherits from `$actor`. Players, guests, and bots are all actors. |
| **Space** | A sequencing/log surface. Rooms, taskspaces, dubspaces are all `$space` descendants. |
| **Feature** | An object composed into another to add behavior without inheritance. `$conversational` is composed into `$chatroom` to add speech verbs. |
| **Catalog** | A versioned bundle of classes, features, schemas, and UI shipped together. The unit of distribution. |
| **Block** | A `$block` descendant — anchored actor that bridges woo to an external data source via a "plug." |
| **Wizard** | An actor with the `wizard` flag — elevated authority for administrative operations. |
| **Programmer** | An actor with the `programmer` flag — can edit verbs on objects they own. |

## Sigils

| Sigil | Form | Meaning |
|---|---|---|
| `$` | `$root_object`, `$me`, `$here` | A **corename** — a stable lookup name resolved through `$system.<name>`. The most stable way to refer to a class or system object. |
| `#` | `#01HXY...` | A **persistent object id** — ULID form. URL-encoded as `%23`. |
| `~` | `~3@<host>` | A **transient object id** — bound to a connection's lifetime. Browser renderers and short-lived UI helpers. |

`$me` and `$here` are dynamic corenames — they resolve per-request to
the current actor and current location respectively.

## Where the spec lives

- [`../../spec/semantics/core.md`](../../spec/semantics/core.md) —
  objects, messages, spaces, actors, observations.
- [`../../spec/semantics/objects.md`](../../spec/semantics/objects.md) —
  identity, verb dispatch, properties (sections §4, §5, §9, §10).
- [`../../spec/semantics/space.md`](../../spec/semantics/space.md) —
  `$space` and call lifecycle.
- [`../../spec/semantics/values.md`](../../spec/semantics/values.md) —
  the value contract (what woo can store).
- [`../../spec/semantics/text-format.md`](../../spec/semantics/text-format.md)
  — `.format` rules.
