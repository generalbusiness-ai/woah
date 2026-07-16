import { describe, expect, it } from "vitest";
import { definitionRepairInputs } from "../../scripts/net-repair-definitions";

describe("signed net definition repair inputs", () => {
  it("mines replacement definitions and retired removals from the bundled catalogs", async () => {
    const result = await definitionRepairInputs(
      ["$outliner:list_items", "prop:$outline_item:__ordered_edge"],
      ["$outline_item:set_parent", "$outliner:_siblings_ordered", "prop:$outline_item:parent"]
    );
    expect(result.cells).toEqual([
      expect.objectContaining({ kind: "verb_bytecode", object: "$outliner", name: "list_items", value: expect.any(Object) }),
      expect.objectContaining({ kind: "property_cell", object: "$outline_item", name: "__ordered_edge", value: expect.any(Object) })
    ]);
    expect(result.remove).toEqual([
      { kind: "verb_bytecode", object: "$outline_item", name: "set_parent" },
      { kind: "verb_bytecode", object: "$outliner", name: "_siblings_ordered" },
      { kind: "property_cell", object: "$outline_item", name: "parent" }
    ]);
  });

  it("refuses unknown replacements, arbitrary removals, and removal of current definitions", async () => {
    await expect(definitionRepairInputs(["$outliner:not_real"], [])).rejects.toThrow("not bundled bootstrap definition pages");
    await expect(definitionRepairInputs([], ["$outliner:not_real"])).rejects.toThrow("not retired bundled bootstrap definition pages");
    await expect(definitionRepairInputs([], ["$outliner:list_items"])).rejects.toThrow("not retired bundled bootstrap definition pages");
    await expect(definitionRepairInputs([], ["prop:$outline_item:__ordered_edge"])).rejects.toThrow(
      "not retired bundled bootstrap definition pages"
    );
  });
});
