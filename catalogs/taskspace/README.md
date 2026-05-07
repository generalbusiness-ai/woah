---
name: taskspace
version: 0.3.0
spec_version: v1
license: MIT
description: Hierarchical task coordination demo. Tasks are $note descendants — name is the listing identity, text is the markdown description.
depends:
  - @local:chat
  - @local:note
keywords:
  - tasks
  - agents
  - demo
---

# Taskspace

Source catalog for the first-light task coordination demo.

Defines a taskspace class, note-descendant task class, and seeded
`the_taskspace` instance. The catalog depends on `@local:chat` so the taskspace
can attach the `$conversational` feature and support embedded live chat, and on
`@local:note` so `$task` can inherit note/card behavior.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.
