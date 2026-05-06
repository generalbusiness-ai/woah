import { escapeHtml } from "../../../src/client/framework";

// Canonical block-data shape vocabulary (per notes/2026-05-05-block-and-plug.md
// §"Data shape vocabulary"). Plugs MUST map their backend's data into one of
// these so any UI can render the value without class-specific code. Add a
// new kind here only with a corresponding renderer below and a note in the
// design doc — the set is closed in v1 so block-class authors can rely on
// the vocabulary as a contract.
export type BlockScalar = {
  kind: "scalar";
  value: number | string | boolean | null;
  unit?: string;
  label?: string;
};

export type BlockSeriesPoint = [number, number | string | null];
export type BlockSeries = {
  kind: "series";
  series: { name: string; unit?: string; points: BlockSeriesPoint[] }[];
};

export type BlockTable = {
  kind: "table";
  columns: { name: string; type?: string }[];
  rows: (string | number | boolean | null)[][];
};

export type BlockGeoPoint = { lat: number; lon: number; props?: Record<string, unknown> };
export type BlockGeo = {
  kind: "geo";
  points: BlockGeoPoint[];
};

export type BlockShape = BlockScalar | BlockSeries | BlockTable | BlockGeo;

const KNOWN_KINDS = new Set<BlockShape["kind"]>(["scalar", "series", "table", "geo"]);

export function isBlockShape(value: unknown): value is BlockShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && KNOWN_KINDS.has(kind as BlockShape["kind"]);
}

// Renders a single canonical block-data value. `<woo-block>` wraps any of
// `scalar | series | table | geo`, falling back to a `<pre>` JSON dump for
// values that don't carry a recognized `kind`. This is the plain-vanilla
// generic component; a class-specific UI (e.g. weather, dispenser) can
// override per-property rendering by registering its own element through
// the catalog framework.
export class WooBlockElement extends HTMLElement {
  private value: unknown = null;

  set data(value: unknown) {
    this.value = value;
    this.render();
  }

  get data(): unknown {
    return this.value;
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    if (!isBlockShape(this.value)) {
      this.innerHTML = renderUnknown(this.value);
      return;
    }
    switch (this.value.kind) {
      case "scalar":
        this.innerHTML = renderScalar(this.value);
        return;
      case "series":
        this.innerHTML = renderSeries(this.value);
        return;
      case "table":
        this.innerHTML = renderTable(this.value);
        return;
      case "geo":
        this.innerHTML = renderGeo(this.value);
        return;
    }
  }
}

function renderScalar(s: BlockScalar): string {
  const valueText = s.value === null || s.value === undefined ? "—" : String(s.value);
  const unit = s.unit ? `<span class="woo-block-unit">${escapeHtml(s.unit)}</span>` : "";
  const label = s.label ? `<div class="woo-block-label">${escapeHtml(s.label)}</div>` : "";
  return `<div class="woo-block woo-block-scalar">${label}<div class="woo-block-value">${escapeHtml(valueText)}${unit}</div></div>`;
}

function renderSeries(s: BlockSeries): string {
  const series = Array.isArray(s.series) ? s.series : [];
  if (series.length === 0) {
    return `<div class="woo-block woo-block-series woo-block-empty">no series</div>`;
  }
  const items = series.map((entry) => {
    const points = Array.isArray(entry.points) ? entry.points : [];
    const last = points.length > 0 ? points[points.length - 1] : null;
    const lastValue = last && last.length >= 2 ? String(last[1] ?? "") : "—";
    const unit = entry.unit ? `<span class="woo-block-unit">${escapeHtml(entry.unit)}</span>` : "";
    return `<li class="woo-block-series-item"><span class="woo-block-series-name">${escapeHtml(entry.name ?? "")}</span><span class="woo-block-series-last">${escapeHtml(lastValue)}${unit}</span><span class="woo-block-series-count">${points.length} pt</span></li>`;
  }).join("");
  return `<div class="woo-block woo-block-series"><ul>${items}</ul></div>`;
}

function renderTable(t: BlockTable): string {
  const cols = Array.isArray(t.columns) ? t.columns : [];
  const rows = Array.isArray(t.rows) ? t.rows : [];
  const head = cols.map((c) => `<th>${escapeHtml(c.name ?? "")}</th>`).join("");
  const body = rows.map((row) => {
    const cells = Array.isArray(row) ? row : [];
    return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell === null || cell === undefined ? "" : String(cell))}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="woo-block woo-block-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderGeo(g: BlockGeo): string {
  const points = Array.isArray(g.points) ? g.points : [];
  if (points.length === 0) {
    return `<div class="woo-block woo-block-geo woo-block-empty">no points</div>`;
  }
  // No map renderer in v1; just list the points so an LLM-driven UI or
  // accessibility layer can still see them. Specialized per-class UIs
  // override this for actual map rendering.
  const items = points.map((p) => {
    const props = p.props && typeof p.props === "object" ? Object.entries(p.props) : [];
    const propText = props.length > 0 ? ` (${props.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`).join(", ")})` : "";
    return `<li class="woo-block-geo-point">${escapeHtml(String(p.lat))}, ${escapeHtml(String(p.lon))}${propText}</li>`;
  }).join("");
  return `<div class="woo-block woo-block-geo"><ul>${items}</ul></div>`;
}

function renderUnknown(value: unknown): string {
  if (value === null || value === undefined) {
    return `<div class="woo-block woo-block-unknown woo-block-empty">—</div>`;
  }
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return `<div class="woo-block woo-block-unknown"><pre>${escapeHtml(text)}</pre></div>`;
}
