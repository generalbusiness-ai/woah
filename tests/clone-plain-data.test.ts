import { describe, expect, it } from "vitest";
import { clonePlainData, cloneValue, deepFreezePlainValue } from "../src/core/types";

describe("clonePlainData", () => {
  it("deep-clones nested plain data with full isolation", () => {
    const source = { a: 1, b: { c: [1, 2, { d: "x" }] }, e: [true, null] };
    const clone = clonePlainData(source);
    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
    expect(clone.b).not.toBe(source.b);
    expect(clone.b.c).not.toBe(source.b.c);
    expect(clone.b.c[2]).not.toBe(source.b.c[2]);
    // Mutating the clone never touches the source.
    (clone.b.c[2] as { d: string }).d = "y";
    clone.b.c.push(99 as never);
    expect((source.b.c[2] as { d: string }).d).toBe("x");
    expect(source.b.c).toHaveLength(3);
  });

  it("passes primitives (including undefined) through unchanged", () => {
    expect(clonePlainData(null)).toBe(null);
    expect(clonePlainData(undefined)).toBe(undefined);
    expect(clonePlainData(42)).toBe(42);
    expect(clonePlainData("s")).toBe("s");
    expect(clonePlainData(true)).toBe(true);
    expect(clonePlainData(10n)).toBe(10n);
    // undefined survives as an object value, matching structuredClone.
    expect(clonePlainData({ a: undefined, b: 1 })).toEqual({ a: undefined, b: 1 });
  });

  it("allows null-prototype objects", () => {
    const source = Object.assign(Object.create(null), { a: 1, nested: { b: 2 } });
    const clone = clonePlainData(source);
    expect(clone.a).toBe(1);
    expect(clone.nested).toEqual({ b: 2 });
    expect(clone.nested).not.toBe(source.nested);
  });

  it("rejects cyclic structures instead of looping", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => clonePlainData(cyclic)).toThrow(/cyclic/);
  });

  it("clones a shared (non-cyclic) sub-object reached by two paths", () => {
    const shared = { v: 1 };
    const source = { left: shared, right: shared };
    const clone = clonePlainData(source);
    expect(clone).toEqual({ left: { v: 1 }, right: { v: 1 } });
    // Plain-data semantics: identity is not preserved (acceptable; no woo data
    // relies on shared-ref identity), but it must not be flagged as a cycle.
    expect(clone.left).not.toBe(clone.right);
  });

  it("rejects non-plain objects and uncloneable values", () => {
    expect(() => clonePlainData(new Date())).toThrow(/non-plain object/);
    expect(() => clonePlainData(new Map())).toThrow(/non-plain object/);
    expect(() => clonePlainData(new Set())).toThrow(/non-plain object/);
    expect(() => clonePlainData(/re/)).toThrow(/non-plain object/);
    class Widget { x = 1; }
    expect(() => clonePlainData(new Widget())).toThrow(/non-plain object/);
    expect(() => clonePlainData(() => 0)).toThrow(/cannot clone a function/);
    expect(() => clonePlainData(Symbol("s"))).toThrow(/cannot clone a symbol/);
    // Nested non-plain is also caught.
    expect(() => clonePlainData({ ok: 1, bad: new Date() })).toThrow(/non-plain object/);
  });

  it("returns a freshly mutable copy of deep-frozen input (VM literal push contract)", () => {
    const frozen = deepFreezePlainValue({ list: [1, 2], nested: { k: "v" } });
    expect(Object.isFrozen(frozen)).toBe(true);
    const clone = clonePlainData(frozen);
    expect(clone).toEqual({ list: [1, 2], nested: { k: "v" } });
    expect(Object.isFrozen(clone)).toBe(false);
    expect(Object.isFrozen(clone.list)).toBe(false);
    expect(Object.isFrozen(clone.nested)).toBe(false);
    // Mutating the clone must work and not throw against the frozen source.
    clone.list.push(3);
    clone.nested.k = "changed";
    expect(clone.list).toEqual([1, 2, 3]);
    expect(frozen.list).toEqual([1, 2]);
    expect(frozen.nested.k).toBe("v");
  });

  it("cloneValue delegates to clonePlainData for WooValue", () => {
    const value = { kind: "note", tags: ["a", "b"], meta: { n: 3 } };
    const clone = cloneValue(value);
    expect(clone).toEqual(value);
    expect(clone).not.toBe(value);
    expect(clone.meta).not.toBe(value.meta);
  });
});
