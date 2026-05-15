---
date: 2026-04-29
status: partial
---

# Conformance

> Part of the [woo specification](../../SPEC.md). Layer: **tooling**.

The behavioral test corpus that any woo runtime implementation must pass. The contract is "given this seed, this call sequence, and this configuration, the implementation produces these applied frames and these final state values." Multiple implementations of the spec — alternate runtimes, custom hosts, embedded variants — verify themselves against the same suite.

---

## CF1. Why a conformance suite

Specs alone don't catch divergence. Two implementations following the same prose can land on subtly different behavior — a failed call advancing seq when it shouldn't, an observation arriving in the wrong order, a value comparison succeeding when it should fail. A behavioral test corpus is what makes "spec-compliant" a *checkable* claim.

The first beneficiary is the reference implementation itself: every spec change comes with conformance test additions; the reference impl runs them in CI. The second is alternate implementations: a port, a fork, an embedded variant can verify itself.

---

## CF2. Test format

A conformance test is a structured manifest:

```yaml
id:          "F03-behavior-failure-rolls-back-mutations"
description: "A verb body that raises preserves the seq but rolls back mutations"
category:    "failures"

seed:
  objects:
    - id: "$test_space"
      parent: "$space"
      verbs:
        - name: "throw_after_mutate"
          source: |
            verb $space:throw_after_mutate(value) {
              this.last = value;
              raise(E_INVARG);
            }

setup:
  state:
    - obj: "$test_space"
      prop: "last"
      value: null

calls:
  - id: "c1"
    space: "$test_space"
    message:
      actor:  "$wiz"
      target: "$test_space"
      verb:   "throw_after_mutate"
      args:   [42]

expect:
  applied:
    - id: "c1"
      seq: 1
      observations:
        - type: "$error"
          code: "E_INVARG"
  final_state:
    - obj: "$test_space"
      prop: "last"
      value: null    # rolled back
```

Tests are values per [values.md §V2](../semantics/values.md#v2-canonical-json-encoding). They're authored as YAML for readability, normalize to canonical JSON for hashing.

---

## CF3. Required categories

The suite covers every normative section of the spec. Categories:

| Category | Coverage |
|---|---|
| **Values** | V1 type tags, V2 encoding round-trip, V3 equality, V8 replay-canonical |
| **Objects** | Inheritance lookup, anchor placement, location vs parent, identity |
| **Space** | S2 lifecycle, S3 failure rules (all six), S7 snapshots |
| **Identity** | I3 auth flows, I4 reconnect, I5 multi-attach, I6 disconnect |
| **VM (T0)** | All T0 opcodes, T0 fixtures from tiny-vm.md, tick metering, memory metering |
| **Wire** | All op types, idempotent retry, gap recovery via replay |
| **REST** | Runtime HTTP endpoints, body-level `space` sequencing, `direct_callable` gate, `$me` resolution, log paging, and retired object-stream rejection |
| **Permissions** | Verb perms, property perms, wizard bypass, progr discipline |
| **Failures** | Every row of failures.md §F2 |
| **Persistence** | Anchor cluster scoping, message log integrity, snapshot reconstruction |
| **Worktrees** | Patch capture, sandbox isolation, atomic promote, conflict detection |
| **Migrations** | Bytecode version skew, schema migrations, idempotent re-runs |
| **Auth** | Token vocabulary, scope claims, refresh flow |

Each category has a section of named tests; total target ~500 tests for v1 launch.

---

## CF4. Storage target categories

The conformance runner distinguishes **live storage backends** from
**archive/import-export targets**.

Live storage backends must satisfy the full runtime contract: sequenced calls,
rollback, replay, restart reconstruction, scheduler wakeups, parked tasks,
storage-failure behavior, and concurrent-write semantics. The reference live
targets are in-memory, SQLite, and future host storage adapters.

The JSON folder format is not a live storage backend. It is a human-readable
world dump/import format. The suite covers it as an archive target:

- Full world dump/load round trip.
- Manifest and per-object file shape.
- Inclusion of logs, snapshots, sessions, and parked tasks in complete dumps.
- Partial object dumps are inspectable but not loadable as complete worlds.
- Deterministic ordering for files and manifest entries where specified.

Archive targets do not claim live-call atomicity, scheduler semantics,
failure-injection behavior, or incremental write guarantees. A smoke test may
load a full JSON folder repository and run a small call to catch accidental
breakage, but that is not a promotion of JSON folder storage to the live backend
contract.

---

## CF5. The runner

```
woo-conformance run [--category=NAME] [--implementation=PATH]
```

Test runner provides:

1. A standardized seed-loading mechanism.
2. A standardized call-driving mechanism (over the wire protocol).
3. A standardized state-inspection mechanism (using `:describe()` and `space:replay`).
4. Pass/fail per test, with structured diff on failure.

The runner is implementation-agnostic. It speaks the wire protocol; any implementation that exposes the wire is testable. (Embedded implementations may expose an in-process driver; the runner abstracts over both.)

---

## CF6. Self-conformance (the reference impl)

The reference implementation runs the full conformance suite as part of CI. Every spec change must be accompanied by:

- Updated tests if the change affects observable behavior.
- New tests if the change introduces new behavior.
- Removed tests if the change deprecates behavior (with explicit removal-rationale recorded).

Test diffs are reviewed alongside spec diffs. A spec change without a conformance test diff is a code smell.

---

## CF7. Independent implementations

A second implementation runs the same suite. Differences surface as failing tests with structured diffs. The expected workflow:

- New implementation runs the suite: 80% pass on first run is realistic.
- Failures are categorized: spec-bug (the spec is ambiguous), reference-bug (the reference impl is wrong), or impl-bug (the new impl misimplements).
- Spec-bugs lead to spec clarifications + new disambiguating tests.
- Reference-bugs lead to fixes.
- Impl-bugs lead to fixes in the new implementation.

This is the long-term value of the suite: it makes spec ambiguities surface as test failures across implementations.

---

## CF8. Versioning

The suite is versioned alongside the spec. Test version `vX.Y` matches spec version `vX.Y`. Old implementations may run old test versions; new implementations should run the latest.

Test additions are non-breaking (an old impl that didn't fail v1.0 may fail v1.1 if the new tests cover behavior the old impl handles wrong; but it still passes v1.0). Test changes (semantic, not just clarification) bump the test version.

---

## CF9. Performance benchmarks (separate)

Performance benchmarks are *not* part of conformance. The same harness can run benchmarks (e.g., "1000 sequential `$space:call` finish in under N seconds"), but those don't gate spec compliance — they're operator-relevant signals.

---

## CF10. What's deferred

- **Live-system probing.** A "is this running deployment spec-compliant?" check that runs against a live world. Possible via the suite if you have a wizard-credentialed test actor; deferred.
- **Cross-world conformance.** When federation v1 lands, the suite extends to cover multi-world scenarios. v2.
- **UI conformance.** Whether the IDE / dubspace client / tasks client behave correctly is *application* conformance, not runtime. Belongs to a separate UI test suite.
- **Property-based tests / fuzzing.** Useful complement but separate work; the conformance suite is hand-curated against the spec.
