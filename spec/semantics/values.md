---
date: 2026-04-29
status: implemented
---

# Values

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

The canonical contract for runtime values: types, equality, serialization, and the rules that wire frames and persistent storage must agree on.

The DSL surface and operator semantics live in [language.md §6–§7](language.md). The VM's value handling lives in [vm.md §8](vm.md). This document is the foundation those layers share with the wire (protocol) and storage (reference) layers.

---

## V1. Type tags

Every value carries a runtime type tag. The set is closed for v1:

| Tag | Type | Notes |
|---|---|---|
| `int` | 53-bit signed integer | The safe-integer range of IEEE 754 doubles: `[-(2^53 - 1), 2^53 - 1]`. Out-of-range arithmetic raises `E_INVARG`. |
| `float` | IEEE 754 double | NaN and ±Inf are representable in-memory but not transmissible (V2). |
| `str` | UTF-8 string | NFC-normalized at every wire/storage boundary; lengths are in code points. |
| `bool` | true / false | Distinct from int 0/1. |
| `null` | null | Distinct from all other types and from "missing." |
| `obj` | persistent objref | ULID string with `#` sigil; see [objects.md §5.1](objects.md#51-persistent-refs). |
| `tref` | transient objref | qualified `~id@host` form. |
| `list` | ordered, heterogeneous | Empty list `[]` is distinct from `null`. |
| `map` | string-keyed, heterogeneous | Keys are strings only. Insertion order preserved. Distinct from `null`. |
| `err` | tagged error map | `{code, message?, value?}`. See V7. |

A value is exactly one of these. There is no "any" or "object" union beyond the tagged set.

---

## V2. Canonical JSON encoding

woo values serialize to JSON via the rules below. The encoding is the same on the v2/REST wire and in persistent storage (`property_value.value`, sequenced message body, etc.).

| Value | JSON form |
|---|---|
| `int n` | `n` (no decimal point) |
| `float x` | `x` (must include `.` or `e` to disambiguate from int) |
| `str s` | `"s"` |
| `bool b` | `true` / `false` |
| `null` | `null` |
| `obj #o` | `"#01HXYZAB...26-char-ulid"` (sigil included; equal to source-form) |
| `tref ~t@#h` | `"~3@#01HXYZAB..."` |
| `list xs` | `[x1, x2, ...]` |
| `map m` | `{"k1": v1, "k2": v2, ...}` |
| `err e` | `{"$err": {"code": "E_PROPNF", "message": "...", "value": ...}}` |

### Numbers

JSON has only one numeric type. woo distinguishes int from float by **decimal-point presence**: `42` round-trips as `int`, `42.0` as `float`. Implementations that lose this distinction (e.g., a JSON parser that yields `Number` for both) must consult schema context or use a tagged form. For canonical output, ints have no decimal point; floats always include one (`42` → int, `42.0` → float).

NaN and ±Inf are not representable in JSON. The runtime emits `null` for these on serialization and raises `E_FLOAT` if a non-finite float would otherwise need to cross a wire/storage boundary. User code is expected not to produce them.

### Strings

UTF-8. Non-BMP code points use JSON's standard `\uXXXX\uXXXX` surrogate-pair escape. Strings are NFC-normalized at every wire/storage boundary; in-memory representation may differ but equality (V3) is by NFC.

### Map keys

Insertion order is preserved on serialization. Replay-canonical form (V8) sorts keys; everyday wire form does not. Both are valid; they serve different purposes.

### Reserved key prefix

Map keys beginning with `$` are reserved for runtime envelopes (`$err`, future framing). User code may read but should not write `$`-prefixed top-level keys.

---

## V3. Equality

`a == b` (the `EQ` opcode in vm.md):

- **Different tags:** never equal. `int 1 == float 1.0` is `false`. `null == false` is `false`. `null == 0` is `false`. (Breaks JS habits, matches MOO, removes a class of subtle bugs.)
- **`int`, `bool`, `null`:** by value.
- **`float`:** by value, with IEEE rules. `NaN == NaN` is `false`. `+0 == -0` is `true`.
- **`str`:** by NFC code-point sequence.
- **`obj`, `tref`:** by canonical id string.
- **`list`:** structural; same length and element-wise `==`.
- **`map`:** structural; same key set, value-wise `==` per key. Insertion order does *not* affect equality.
- **`err`:** by `code` only. `message` and `value` don't affect equality.

`!=` is the negation. There is no separate identity-vs-equality distinction.

---

## V4. Mutability

Values are **immutable**. Operations that look like mutations return new values:

- `LIST_SET`, `LIST_APPEND`, `LIST_DELETE` (builtin) return new lists.
- `MAP_SET`, `MAP_DELETE` (builtin) return new maps.
- `STR_CONCAT` returns a new string.

Property writes (`SET_PROP`) mutate an *object's* state, not the value previously held in that slot. Implementations may share substructure for efficiency; the contract is that observers of a value cannot see it change.

---

## V5. Object references

A persistent objref is `#` + 26-char Crockford base32 (the ULID). Crockford base32 is case-insensitive on input; canonical form is uppercase.

A transient objref is `~` + local-id + `@` + host-objref. The host part is itself a persistent objref. (See [objects.md §5.2](objects.md#52-transient-refs).)

Refs do not encode current host placement. Routing is computed at use time from the ref via the anchor chain (see [objects.md §4.1](objects.md#41-anchor-and-atomicity-scope)) and the runtime's `idFromName` mapping.

The reserved refs `#-1` (NOTHING) and `#0` (`$system`) appear in their short forms in source code and wire frames; internally they map to specific reserved ULIDs.

---

## V6. Map keys

Keys are UTF-8 strings only. Constraints:

- **Allowed:** any UTF-8 string up to 256 bytes.
- **Not allowed:** non-string keys (no int, obj, etc.).
- **Empty string is a valid key.**
- **`$`-prefixed keys are reserved** (V2).

Why string-only: JSON-compatible serialization, simple equality, dominant ergonomic. Anyone who wants object-keyed maps can use a list of pairs.

---

## V7. Error values

```
{ code: str, message?: str, value?: any }
```

- `code`: short identifier from the catalog in [builtins.md §20](builtins.md#20-errors). Format: uppercase letters/digits/underscores; max 32 chars.
- `message`: optional human-readable text. May be omitted; default is the catalog entry's description.
- `value`: optional contextual data. Any value type. May be omitted; default null.

`raise()` accepts a code string (`raise("E_PERM")`) or a fully-formed err map. The runtime fills missing fields with defaults.

Handler dispatch matches by `code` only; `message` and `value` are payload, not selectors. Two errs with the same code match the same handler regardless of other fields.

---

## V8. Replay-canonical form

For deterministic replay (history snapshots, log-based reconstruction, content-addressable identity), values have a *canonical* serialization distinct from everyday wire form:

- **Map keys:** lexicographic Unicode code-point order, regardless of insertion order.
- **Floats:** shortest decimal representation that round-trips to the same IEEE 754 value (RFC 8259 / ECMA-404 conformant dtoa).
- **Strings:** NFC-normalized.
- **No insignificant whitespace.**
- **No trailing zeros** beyond what's required for round-trip.

Two values that are `==` (V3) produce identical replay-canonical bytes. This is the basis for content-hashing snapshot identity.

The everyday wire form preserves insertion order for `map` (better for pretty-printing and debugging) and uses no specific number formatting. Wire frames are *not* expected to be content-addressable; replay-canonical form is.

---

## V9. Size limits

| Bound | Default | Notes |
|---|---|---|
| Single value (serialized) | 256 KiB | At construction or storage time, larger raises `E_INVARG`. |
| Map entries | 4096 | At `MAP_SET`/`MAKE_MAP`, larger raises `E_INVARG`. |
| List length | 65536 | At `LIST_APPEND`/`MAKE_LIST`, larger raises `E_INVARG`. |
| String length | 256 KiB UTF-8 bytes | At `STR_CONCAT`, larger raises `E_INVARG`. |

Tunable per-world via `$server_options.value_*_limit`.

---

## V10. Message and sequenced-message serialization

A **message** is a `map` with the canonical shape:

```
{
  actor:  obj,    // who is making the call
  target: obj,    // which object the message is directed at
  verb:   str,    // verb name on the target
  args:   list,   // positional arguments
  body?:  map     // optional structured payload
}
```

(Per [core.md §C3](core.md#c3-messages-and-calls).)

Required fields: `actor`, `target`, `verb`, `args`. `body` is optional. Missing required fields cause `E_INVARG` at validation time, *before* sequencing — so a malformed call does not advance any space's `seq`.

A **sequenced message**, returned from `$space:call`, wraps a message:

```
{
  space:   obj,
  seq:     int,
  message: map
}
```

Same V2 serialization rules apply to both.

---

## V11. Boundaries

This contract is normative at three boundaries:

- **Wire**: every value that crosses a WebSocket frame is V2-encoded. ([protocol/wire.md](../protocol/wire.md))
- **Storage**: every value persisted to durable state (property values, sequenced messages, snapshots) is V2-encoded. ([reference/persistence.md](../reference/persistence.md))
- **Replay**: every value produced for replay-canonical hashing or deterministic reconstruction is V8-encoded.

In-memory representation is implementation-defined; the contract holds at the boundaries.
