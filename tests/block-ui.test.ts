// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isBlockShape, WooBlockElement } from "../catalogs/block/ui/block";

describe("woo-block canonical-kind renderer", () => {
  beforeAll(() => {
    if (!customElements.get("woo-block")) customElements.define("woo-block", WooBlockElement);
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function mount(value: unknown): HTMLElement {
    const el = document.createElement("woo-block") as WooBlockElement;
    document.body.appendChild(el);
    el.data = value;
    return el;
  }

  it("recognizes the four canonical kinds via isBlockShape", () => {
    expect(isBlockShape({ kind: "scalar", value: 1 })).toBe(true);
    expect(isBlockShape({ kind: "series", series: [] })).toBe(true);
    expect(isBlockShape({ kind: "table", columns: [], rows: [] })).toBe(true);
    expect(isBlockShape({ kind: "geo", points: [] })).toBe(true);
    expect(isBlockShape({ kind: "unknown", value: 1 })).toBe(false);
    expect(isBlockShape("not a shape")).toBe(false);
    expect(isBlockShape(null)).toBe(false);
  });

  it("renders a scalar shape with value, unit, and label", () => {
    const el = mount({ kind: "scalar", value: 72, unit: "°F", label: "current_temp" });
    expect(el.querySelector(".woo-block-scalar")).not.toBeNull();
    expect(el.querySelector(".woo-block-value")?.textContent).toContain("72");
    expect(el.querySelector(".woo-block-unit")?.textContent).toBe("°F");
    expect(el.querySelector(".woo-block-label")?.textContent).toBe("current_temp");
  });

  it("escapes user-supplied scalar text to defang HTML injection", () => {
    const el = mount({ kind: "scalar", value: "<img src=x onerror=alert(1)>", label: "<b>x</b>" });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".woo-block-value")?.innerHTML).toContain("&lt;img");
    expect(el.querySelector(".woo-block-label")?.innerHTML).toContain("&lt;b&gt;");
  });

  it("renders a series with last-value and point count per entry", () => {
    const el = mount({
      kind: "series",
      series: [
        { name: "temp", unit: "°F", points: [[1, 60], [2, 65], [3, 70]] },
        { name: "humidity", unit: "%", points: [[1, 40], [2, 42]] }
      ]
    });
    const items = el.querySelectorAll(".woo-block-series-item");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("temp");
    expect(items[0].textContent).toContain("70");
    expect(items[0].textContent).toContain("3 pt");
    expect(items[1].textContent).toContain("humidity");
    expect(items[1].textContent).toContain("42");
  });

  it("renders an empty series with a placeholder", () => {
    const el = mount({ kind: "series", series: [] });
    expect(el.querySelector(".woo-block-empty")?.textContent).toBe("no series");
  });

  it("renders a table with columns and rows", () => {
    const el = mount({
      kind: "table",
      columns: [{ name: "hour" }, { name: "temp" }],
      rows: [[1, 60], [2, 62], [3, 65]]
    });
    const headers = el.querySelectorAll("thead th");
    expect(headers.length).toBe(2);
    expect(headers[0].textContent).toBe("hour");
    expect(headers[1].textContent).toBe("temp");
    expect(el.querySelectorAll("tbody tr").length).toBe(3);
  });

  it("renders geo points as a list with lat/lon and props", () => {
    const el = mount({
      kind: "geo",
      points: [
        { lat: 37.4, lon: -122.1, props: { name: "MV" } },
        { lat: 40.7, lon: -74.0 }
      ]
    });
    const items = el.querySelectorAll(".woo-block-geo-point");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("37.4");
    expect(items[0].textContent).toContain("-122.1");
    expect(items[0].textContent).toContain("MV");
  });

  it("falls back to a JSON dump for unknown shapes", () => {
    const el = mount({ kind: "donuts", flavor: "maple" });
    const pre = el.querySelector(".woo-block-unknown pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("donuts");
    expect(pre?.textContent).toContain("maple");
  });

  it("treats null as empty rather than throwing", () => {
    const el = mount(null);
    expect(el.querySelector(".woo-block-empty")?.textContent).toBe("—");
  });

  it("re-renders when data is reassigned", () => {
    const el = mount({ kind: "scalar", value: 1 }) as WooBlockElement;
    expect(el.querySelector(".woo-block-scalar")).not.toBeNull();
    el.data = { kind: "table", columns: [{ name: "x" }], rows: [[1]] };
    expect(el.querySelector(".woo-block-scalar")).toBeNull();
    expect(el.querySelector(".woo-block-table")).not.toBeNull();
  });
});
