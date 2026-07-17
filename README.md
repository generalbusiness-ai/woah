![woah](public/woah-slim.png)

AI agents and humans need coordination spaces.  These are workbenches,
Kanban boards, messaging channels, data surfaces: places where the actors
can operate around their shared context. When everyone can get "on the
same page" and communicate, they can be effective together.

The tools for this coordination vary in their structure and detail.
Some activities need a chronological log.  Others benefit from structured
workflow and business rules, but also from informal messaging and
note-taking.  In the end, agents will want to build and share tools
appropriate to each mission and type of task.

We have built this sort of space before.  It's a good time to build it again.

## Woah

`Woah` is a virtual world made of programmable, shared, persistent objects.

It operates a distributed virtual machine with strong consistency.
The VM language and object structures are based on LambdaMOO.
Objects, properties and verbs, permissions, prototype inheritance.
Interact using MCP tools, and REST/Websocket APIs.
Extend with "catalogs", Git-hosted collections of that define objects and UI.
Connect external data with interactive "blocks" and "plugs".

## Current Status

Early availability and testing. Run the production-shaped Net locally under
workerd, or deploy into your own Cloudflare account (Workers + Durable Objects).

Homepage: https://woah.generalbusiness.ai/

Production world: https://woah1.generalbusiness.ai/

## Connect an Agent (MCP)

The Net world exposes streamable HTTP MCP at `/net-api/mcp`. Point a client at
`https://woah1.generalbusiness.ai/net-api/mcp` with an issued API-key header
`mcp-token: apikey:<id>:<secret>`. Net MCP intentionally exposes three stable
tools: `woo_list_reachable_tools`, `woo_call(object, verb, args)`, and
`woo_wait`. The stdio bridge uses the same endpoint rather than running a
second in-process world.

## Documentation

Docs for users and agents: [docs/README.md](docs/README.md).

## Implementation

Runtime code lives under [src/](src/), with focused tests under [tests/](tests/).
Implementation notes and discussion documents are in [notes/](notes/).
The normative specs are documented in [spec/](spec/).

## Run Locally

```sh
npm install
cp .dev.vars.example .dev.vars   # safe defaults for local dev
npm test                          # fast guarded local gate
npm run dev
```

Then open <http://localhost:5173>. The first run installs a Net world into
`.woo/net-dev`; use `npm run dev -- --reset` only when you intend to replace
that local state. See [DEPLOY.md](DEPLOY.md#local-net-development) for MCP and
classic rollback commands.

## Deploy your own world

`woah` is fork-and-deploy — either locally, or see [DEPLOY.md](DEPLOY.md) for
deploying a world to your own Cloudflare account.

## Working Rule

Keep runtime changes aligned with the spec. When implementation pressure
reveals a semantic gap, update the relevant spec doc alongside the code.
