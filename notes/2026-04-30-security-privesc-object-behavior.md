# Object-Behavior Privilege Escalation Review

Date: 2026-04-30

Scope: privilege escalation risks in object behavior: verb dispatch, VM property
ops, feature attachment, catalog-owned code, and authoring surfaces.

Implementation status in this branch:

- `dispatch()` now enforces LambdaMOO-style verb execute permission (`x`, owner,
  or wizard) before entering every verb frame.
- VM property opcodes now use checked world APIs keyed to the current `progr`;
  raw mutators remain for bootstrap, repository hydration, tests, and audited
  system internals.
- `$root:set_prop` and `$root:set_value` are retained as readable bytecode
  fixtures but are no longer executable public inherited verbs.
- Core authority-bearing slots such as `presence_in`, `subscribers`, `features`,
  `features_version`, and sequence bookkeeping are no longer public-writable by
  property metadata.
- Public wizard-owned verbs remain public capabilities by design. Future review
  should focus on whether each one is intentionally capability-shaped, checks
  `actor`/`player`, or needs a LambdaCore-style `set_task_perms()` drop.

## Findings

### High: public inherited setters can mutate privileged objects

`$root:set_prop` and `$root:set_value` are seeded as inherited bytecode verbs with
`rx` perms. They are not direct-callable, but any actor present in any sequenced
space can submit a `$space:call` targeting any object and invoking the inherited
setter.

The current call gate checks only:

- session actor matches message actor,
- actor has presence in the selected sequencing space,
- message shape is valid.

It does not check that the target belongs to that space, and `dispatch()` does not
check verb execute permission. The setter bytecode then executes with `$wiz`
`progr`, and `SET_PROP` calls the raw `world.setProp()` API with no property
permission check.

Probe:

```ts
const world = createWorld();
const s = world.auth("guest:privesc-probe");
world.directCall("enter", s.actor, "the_chatroom", "enter", []);
world.call("p", s.id, "the_chatroom", {
  actor: s.actor,
  target: "$wiz",
  verb: "set_prop",
  args: ["description", "pwned"]
});
// $wiz.description is now "pwned"
```

Impact: arbitrary property mutation on privileged/core objects by any room
participant. This is state-integrity compromise and can become privilege
escalation where properties are authority-bearing (`presence_in`, `features`,
`subscribers`, catalog registry state, workflow roles).

Primary code paths:

- `src/core/bootstrap.ts` seeds `$root:set_prop` / `$root:set_value`.
- `src/core/world.ts` `call()` / `validateMessage()` only validate shape and
  presence in the chosen space.
- `src/core/world.ts` `dispatch()` stamps `progr = verb.owner` but does not
  check `x`.
- `src/core/tiny-vm.ts` `SET_PROP` writes through `world.setProp()` directly.

### High: VM property authority checks are not implemented

The spec says property ops use `progr` permissions:

- `GET_PROP` should check read perms.
- `SET_PROP` should check write perms.
- `DEFINE_PROP` should require `progr == obj.owner` or wizard.
- `UNDEFINE_PROP` should require matching ownership/wizard authority.
- `SET_PROP_INFO` should require owner/wizard and `c` semantics for owner
  changes.

The current VM implementations call raw world mutators or mutate property
metadata directly:

- `GET_PROP` uses `world.getProp()`.
- `SET_PROP` uses `world.setProp()`.
- `DEFINE_PROP` uses `world.defineProperty()` with `owner: current.ctx.progr`.
- `UNDEFINE_PROP` deletes maps directly.
- `SET_PROP_INFO` mutates `def.owner`, `def.perms`, and `def.typeHint` directly.

Impact: any executable bytecode whose author can influence target/name/value can
become a write-anywhere gadget. Combined with wizard-owned catalog code and
public helper verbs, this is exploitable today.

### Medium: verb execute permission is not enforced

The spec says a verb is callable only if:

- `x` is set, or
- caller `progr` owns the verb, or
- caller `progr` is wizard.

`dispatch()` resolves the verb and runs it. Direct calls additionally require
`direct_callable`, but not `x`; sequenced calls do not check either `x` or target
placement relative to the selected sequencer.

Impact: non-`x` helper verbs cannot be used as trust boundaries. This becomes a
privilege escalation when a privileged helper is intended to be internal-only.

### Medium: feature attachment policy can be bypassed by raw property mutation

`add_feature()` correctly gates feature attachment by consumer ownership and the
feature's `:can_be_attached_by` policy. But `features` and `features_version` are
ordinary properties, and raw setters bypass the policy.

Impact: if an actor can write `features` directly, they can attach feature code
without invoking the policy gate. Because feature verbs run with the feature
verb owner's `progr`, this is a dangerous authority transfer.

## Risk Patterns For Future Hunting

### 1. Public privileged mutator verbs

Search pattern:

```sh
rg -n '"perms": "rx"|perms: "rx"|rxd|direct_callable|set_prop|set_value|define_prop|set_verb|install' catalogs src spec
```

Questions:

- Is the verb owned by `$wiz` or installed by a wizard-owned catalog?
- Is it callable by ordinary actors (`x`, `direct_callable`, or route through a
  space)?
- Does it write to a caller-selected object/property/verb?
- Does it validate `actor`, not just rely on `progr`?

### 2. Raw world mutators inside VM/native handlers

Search pattern:

```sh
rg -n 'world\\.setProp|defineProperty\\(|addVerb\\(|propertyDefs\\.delete|propertyVersions\\.delete|def\\.owner|def\\.perms|obj\\.flags' src/core src/server src/worker
```

Questions:

- Is this low-level bootstrap/migration code, or actor-triggered behavior?
- If actor-triggered, where is the permission check?
- Does the check use `ctx.progr` for code authority and `ctx.actor` only for
  user/presence policy?
- Are metadata changes (`owner`, `perms`, `flags`, `features`) audited?

### 3. Authority-bearing ordinary properties

Properties that should not be casually writable:

- `presence_in`
- `subscribers`
- `features`
- `features_version`
- `installed_catalogs`
- `wizard_actions`
- workflow role/status fields where role gates matter

Questions:

- Can a generic setter alter this property?
- Does the system rely on this property for authorization?
- Is there a dedicated verb that enforces the invariant and emits an audit
  observation?

### 4. Confused deputy from `progr`

MOO-style `progr` is powerful: a public wizard-owned verb is a public wizard
capability unless it checks `actor`.

Questions:

- Is the verb intentionally a capability grant?
- Does it restrict target to `this`, `actor`, or a controlled object set?
- Does it accept caller-supplied object refs, property names, verb names, or
  bytecode/source?
- Does it call another verb whose authority is stronger than the caller's?

### 5. Catalog-installed feature code

Catalogs installed by `$wiz` produce wizard-owned verbs. Feature objects are
especially sensitive because attaching a feature exposes those verbs through
other consumers.

Questions:

- Is `:can_be_attached_by` non-trivial?
- Are feature verbs direct-callable?
- Can the feature mutate `this` broadly?
- Can a caller bypass attachment policy by writing `features` directly?

### 6. Authoring endpoints and IDE primitives

Local dev authoring endpoints are intentionally not deployed to CF yet, but the
same pattern will matter when authoring becomes real.

Questions:

- Does every install/edit endpoint authenticate the actor?
- Does it require object/verb/property ownership, programmer status, or wizard?
- Is `expected_version` enforced on every mutable definition?
- Are source and bytecode installs both checked by the same authority path?

## Recommended Hardening Order

1. Add one central `canCallVerb(ctx.progr, verb)` check in `dispatch()`.
2. Split raw mutators from checked mutators:
   - `setPropRaw()` for bootstrap/repository/migration internals.
   - `setPropChecked(progr, obj, name, value)` for VM/native behavior.
   - same for define/undefine/set_prop_info.
3. Change or remove inherited `$root:set_prop` and `$root:set_value`:
   - either make them non-`x` fixtures for tests only,
   - or restrict them to `this.owner == actor` / wizard and checked property
     writes.
4. Add regression tests for:
   - guest cannot mutate `$wiz.description` via `$root:set_prop`;
   - guest cannot set their own `presence_in` through a generic setter;
   - non-`x` helper verb cannot be called by guest through `$space:call`;
   - `features` cannot be changed except through `:add_feature` /
     `:remove_feature`.
5. Document a small "authority-bearing property" list in the permissions spec so
   future catalog authors know which properties must be changed only through
   invariant-preserving verbs.

Items 1, 2, 3, and the core-property part of 5 are implemented. Item 4 has
regression coverage for the `$root:set_prop` exploit, non-`x` dispatch across
routes, and checked VM property mutation. A dedicated feature-bypass regression
should be added when feature authoring becomes user-facing.

## Public Verb Review, 2026-04-30

Review query:

```sh
npx tsx -e 'import { createWorld } from "./src/core/bootstrap.ts"; const w=createWorld(); for (const [id,obj] of w.objects) for (const v of obj.verbs.values()) if (v.perms.includes("x")) console.log(`${id}:${v.name} ${v.perms}`)'
```

High-confidence issues found and fixed:

- `$dubspace:set_control(target, name, value)` was still a generic
  wizard-owned setter. Any actor present in the dubspace could call
  `the_dubspace:set_control($wiz, "description", "pwned")`. The verb now
  requires `target in contents(this)` and an allowlisted control property name.
- `$dubspace:start_loop(slot)` and `:stop_loop(slot)` accepted caller-selected
  object refs and wrote `slot.playing`. They now require `slot in contents(this)`.
- `$player:moveto`, `$player:on_disfunc`, `$guest:on_disfunc`, and
  `$system:return_guest` were public `x` maintenance verbs. They are now
  non-`x`; internal reap still reaches them because the internal frame runs with
  wizard/owner authority.
- `$root:describe` was a public wizard-owned read and used raw description
  access. The native handler now returns `describeForActor()` so unreadable
  descriptions are redacted.
- `$conversational:command` used its own wizard-owned frame when dispatching the
  planned direct verb. It now enters the planned verb with actor authority, so
  `direct_callable` is not enough to bypass missing `x`.

Remaining watchlist:

- Chat `:look` is still bytecode and reads `this.description` /
  `item.description` as the feature owner. This is acceptable for the demo's
  public room objects, but a future private-object model needs an actor-filtered
  describe/title builtin or a native `look`.
- Public taskspace verbs are intentionally open-policy demo verbs. They mutate
  fixed task fields and contain role/status checks where the demo needs them.
  Revisit when workflow gates become user-facing.
- Public wizard-owned verbs remain public capabilities. New catalog review
  should ask whether each public verb accepts caller-selected object refs or
  property/verb names, and whether those inputs are constrained to the app's
  object set.
