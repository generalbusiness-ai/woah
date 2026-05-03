# Local Catalogs

Bundled first-party catalogs for the reference woo demos.

These files are the source/catalog data consumed by the local catalog installer.
`src/core/bootstrap.ts` seeds the universal model and then installs these
manifests through `@local:<catalog>`; demo classes and instances are not seeded
directly in bootstrap.

The manifests carry DSL source as the catalog contract. Some verbs also carry a
v0.5 `implementation` hint that points at a native handler or bytecode fixture
while the DSL/runtime grows enough to express the full behavior directly.

Each catalog owns its app-level design in `DESIGN.md`; platform-wide contracts
stay under `spec/`. Roles (foundational utility vs demo application) are
documented in [spec/discovery/catalogs.md §CT15](../spec/discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo).

Install order for the full demo world:

1. `@local:help`
2. `@local:chat`
3. `@local:note`
4. `@local:prog`
5. `@local:demoworld`
6. `@local:dubspace`
7. `@local:pinboard`
8. `@local:taskspace`

Class libraries (`chat`, `note`, `prog`) install foundational primitives without
seeding instances; `demoworld` seeds the bundled Living Room set; the demo apps
(`dubspace`, `pinboard`, `taskspace`) bring their own seeds. A world that wants
foundational classes without any demo content installs steps 1-4 only.

## Class diagram

Every class shipped by the bundled catalogs, grouped by catalog. Parents
referenced from outside any catalog (`$thing`, `$space`, `$root`, `$player`)
come from the core seed graph and appear outside the boxes.

```mermaid
classDiagram
    direction LR
    namespace help {
        class `$generic_help_db`
    }
    namespace chat {
        class `$match`
        class `$failed_match`
        class `$ambiguous_match`
        class `$room`
        class `$exit`
        class `$chatroom`
        class `$portable`
        class `$furniture`
    }
    namespace demoworld {
        class `$cockatoo`
    }
    namespace note {
        class `$note`
    }
    namespace prog {
        class `$builder`
        class `$programmer`
        class `$generic_editor`
        class `$verb_editor`
    }
    namespace dubspace {
        class `$control`
        class `$loop_slot`
        class `$channel`
        class `$filter`
        class `$delay`
        class `$drum_loop`
        class `$scene`
        class `$dubspace`
    }
    namespace taskspace {
        class `$taskspace`
        class `$task`
    }
    namespace pinboard {
        class `$pin`
        class `$pinboard`
    }
    `$thing` <|-- `$generic_help_db`
    `$thing` <|-- `$match`
    `$thing` <|-- `$failed_match`
    `$thing` <|-- `$ambiguous_match`
    `$space` <|-- `$room`
    `$thing` <|-- `$exit`
    `$room` <|-- `$chatroom`
    `$thing` <|-- `$portable`
    `$thing` <|-- `$furniture`
    `$thing` <|-- `$cockatoo`
    `$portable` <|-- `$note`
    `$player` <|-- `$builder`
    `$builder` <|-- `$programmer`
    `$space` <|-- `$generic_editor`
    `$generic_editor` <|-- `$verb_editor`
    `$root` <|-- `$control`
    `$control` <|-- `$loop_slot`
    `$control` <|-- `$channel`
    `$control` <|-- `$filter`
    `$control` <|-- `$delay`
    `$control` <|-- `$drum_loop`
    `$root` <|-- `$scene`
    `$space` <|-- `$dubspace`
    `$space` <|-- `$taskspace`
    `$root` <|-- `$task`
    `$note` <|-- `$pin`
    `$space` <|-- `$pinboard`
```
