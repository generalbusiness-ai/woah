// Hand-rolled SVG charting for the weather detail overlay.
//
// Three panels stack inside a <dialog>:
//   1. Daily strip — one card per `daily` entry: date label, weather-code
//      icon, temp range, precip total. Today is highlighted.
//   2. Temperature line graph — temperature, temperature_apparent (feels
//      like), dew_point — three SVG paths over the ±7d hourly grid.
//   3. Precip / percent panel — shaded area for `precip_intensity`,
//      lines for `precip_prob`, `humidity`, `cloud_cover`. Same x-axis.
//
// Time domain is the full ±7d frame anchored at `timeseries.anchor`. A
// vertical "now" guide line lands at the anchor; the past half is tinted
// faintly so a viewer can see "this is observation, that is forecast"
// without reading a legend. Null slots break path segments cleanly so
// gaps render as gaps, not as zero values.
//
// All exported functions are pure: they take data + sizing options and
// return SVG/HTML strings. The custom element below assembles them into
// a <dialog>.

import { escapeHtml, type WooComponentRegistry } from "../../../src/client/framework";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type Timeseries = {
  anchor: number;
  t0: number;
  step: number;
  units?: string;
  fields: Record<string, { unit: string; agg: string; values: Array<number | null> }>;
};

export type DailyEntry = {
  date: string;
  temperature?: { min?: number | null; max?: number | null; mean?: number | null; unit?: string };
  humidity?: { min?: number | null; max?: number | null; mean?: number | null };
  precip_total?: number | null;
  precip_unit?: string;
  weather_code?: number | null;
};

export type CurrentBundle = {
  temperature?: number | null;
  temperature_unit?: string;
  weather_code?: number | null;
  observed_at_text?: string;
};

export type ChartProps = {
  current?: CurrentBundle;
  daily?: DailyEntry[];
  timeseries?: Timeseries;
  place?: string;
  timezone?: string;
};

const PANEL_WIDTH = 880;
const TEMP_PANEL_HEIGHT = 200;
const PRECIP_PANEL_HEIGHT = 180;
const PANEL_PAD_X = 36;
const PANEL_PAD_Y = 16;
// CSS percentage matching PANEL_PAD_X relative to PANEL_WIDTH. Used by
// the daily strip so its data area aligns with the chart panels' data
// area exactly — same indent at both ends, same column width per day.
const PANEL_PAD_X_PCT = (PANEL_PAD_X / PANEL_WIDTH) * 100;

// ----- Window symmetry ------------------------------------------------------

// Build a "today ± max(past, fwd)" daily window. Half-width tracks the
// LARGER of past- and forward-populated, so we always show the full
// available range with the short side rendered as empty placeholder
// cards. Cold start (1 d back, 5 d fwd) → 11 cards: 4 placeholders +
// today-1 .. today+5. After a week of accumulation → still 11 cards,
// fully populated.
export function symmetricDailySlice(daily: DailyEntry[], todayDate: string | null): Array<DailyEntry | { date: string; placeholder: true }> {
  if (!daily || daily.length === 0 || !todayDate) return daily ?? [];
  const todayIdx = daily.findIndex((e) => e.date === todayDate);
  if (todayIdx < 0) return daily;
  const past = todayIdx;
  const fwd = daily.length - 1 - todayIdx;
  const n = Math.max(past, fwd);
  const byDate = new Map(daily.map((e) => [e.date, e]));
  const out: Array<DailyEntry | { date: string; placeholder: true }> = [];
  for (let delta = -n; delta <= n; delta++) {
    const date = addDays(todayDate, delta);
    const hit = byDate.get(date);
    out.push(hit ?? { date, placeholder: true });
  }
  return out;
}

// Symmetric domain in milliseconds, anchored on `ts.anchor`. The half-
// width is max(past-populated, forward-populated) hours so the chart
// shows the full available range; the short side simply renders as
// gaps (path null breaks render correctly). Falls back to the full
// grid if no values are populated yet (cold start).
export function symmetricTimeseriesDomain(ts: Timeseries): [number, number] {
  const length = firstField(ts)?.values.length ?? 0;
  if (length === 0) return [ts.t0, ts.t0 + 1];
  let firstIdx = -1, lastIdx = -1;
  for (let i = 0; i < length; i++) {
    let any = false;
    for (const k of Object.keys(ts.fields)) {
      const v = ts.fields[k].values[i];
      if (v !== null && v !== undefined) { any = true; break; }
    }
    if (any) {
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx < 0) return [ts.t0, ts.t0 + length * ts.step];
  const anchorIdx = Math.round((ts.anchor - ts.t0) / ts.step);
  const pastHours = Math.max(0, anchorIdx - firstIdx);
  const fwdHours = Math.max(0, lastIdx - anchorIdx);
  // 12 h minimum half-width so a freshly-populated chart still has
  // room for a couple of day labels even when both sides are thin.
  const halfHours = Math.max(12, Math.max(pastHours, fwdHours));
  return [ts.anchor - halfHours * ts.step, ts.anchor + halfHours * ts.step];
}

function addDays(date: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// ----- Daily strip ----------------------------------------------------------

export function dailyStripHtml(daily: DailyEntry[], todayDate: string | null): string {
  const slice = symmetricDailySlice(daily, todayDate);
  if (!slice || slice.length === 0) {
    return `<div class="weather-chart-daily-empty">No daily summary available yet.</div>`;
  }
  const cards = slice.map((entry) => {
    const isToday = todayDate !== null && entry.date === todayDate;
    const dayLabel = formatDayLabel(entry.date);
    if ((entry as { placeholder?: boolean }).placeholder) {
      // Slot reserved for symmetry; data will land here as the plug
      // accumulates more past observations.
      return `<div class="weather-chart-day is-empty${isToday ? " is-today" : ""}">`
        + `<div class="weather-chart-day-date">${escapeHtml(dayLabel)}</div>`
        + `<div class="weather-chart-day-icon" aria-hidden="true">·</div>`
        + `<div class="weather-chart-day-condition">no data</div>`
        + `</div>`;
    }
    const real = entry as DailyEntry;
    const code = typeof real.weather_code === "number" ? real.weather_code : null;
    const min = formatRound(real.temperature?.min);
    const max = formatRound(real.temperature?.max);
    const tempUnit = real.temperature?.unit ?? "";
    const precip = formatPrecip(real.precip_total, real.precip_unit);
    return `<div class="weather-chart-day${isToday ? " is-today" : ""}">`
      + `<div class="weather-chart-day-date">${escapeHtml(dayLabel)}</div>`
      + `<div class="weather-chart-day-icon" aria-hidden="true">${escapeHtml(iconForWeatherCode(code))}</div>`
      + `<div class="weather-chart-day-condition">${escapeHtml(conditionForWeatherCode(code))}</div>`
      + `<div class="weather-chart-day-temps"><span class="hi">${escapeHtml(max)}${escapeHtml(tempUnit)}</span> · <span class="lo">${escapeHtml(min)}${escapeHtml(tempUnit)}</span></div>`
      + `<div class="weather-chart-day-precip">${escapeHtml(precip)}</div>`
      + `</div>`;
  }).join("");
  // Lock the strip to N equal columns (one per visible day) with the
  // same left/right indent as the chart panels' data area, so each
  // daily card sits directly above its corresponding column in the
  // temperature/precip charts. Without this the strip uses auto-fit
  // and cards drift wider than chart day-widths, condition text wraps,
  // and the per-card height jumps inconsistently.
  const cols = slice.length;
  const styleAttr = `style="grid-template-columns: repeat(${cols}, minmax(0, 1fr)); padding-left: ${PANEL_PAD_X_PCT}%; padding-right: ${PANEL_PAD_X_PCT}%;"`;
  return `<div class="weather-chart-daily-strip" ${styleAttr}>${cards}</div>`;
}

// ----- Temperature panel ----------------------------------------------------

const TEMP_FIELDS: Array<{ key: string; label: string; cls: string }> = [
  { key: "temperature",          label: "Temperature", cls: "weather-line-temp" },
  { key: "temperature_apparent", label: "Feels Like",  cls: "weather-line-feels" },
  { key: "dew_point",            label: "Dew Point",   cls: "weather-line-dew" }
];

export function temperaturePanelSvg(ts: Timeseries | undefined): string {
  if (!ts || !ts.fields) return emptyPanelSvg(TEMP_PANEL_HEIGHT, "Temperature data unavailable");
  const present = TEMP_FIELDS.filter((f) => ts.fields[f.key]?.values?.some((v) => v !== null));
  if (present.length === 0) return emptyPanelSvg(TEMP_PANEL_HEIGHT, "No temperature samples yet");

  const domain = symmetricTimeseriesDomain(ts);
  // Y-domain: union of populated values within the visible x-window so
  // off-screen extremes don't squash the in-frame lines.
  const valuesUnion: number[] = [];
  for (const f of present) {
    const values = ts.fields[f.key].values;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined) continue;
      const t = ts.t0 + i * ts.step;
      if (t < domain[0] || t > domain[1]) continue;
      valuesUnion.push(v);
    }
  }
  const yDomain = padDomain(domainOf(valuesUnion), 0.08);
  const yScale = linear(yDomain, [TEMP_PANEL_HEIGHT - PANEL_PAD_Y, PANEL_PAD_Y]);
  const xScale = xScaleForTimeseries(ts, domain);

  const lines = present.map((f) => {
    const path = pathFromValues(ts.fields[f.key].values, ts.t0, ts.step, xScale, yScale, domain);
    return `<path class="${escapeHtml(f.cls)}" d="${path}" fill="none" />`;
  }).join("");

  const yAxis = yAxisLabels(yDomain, yScale, "°", PANEL_PAD_X);
  const grid = gridAndAnchor(ts, xScale, TEMP_PANEL_HEIGHT, domain);
  const legend = legendHtml(present.map((f) => ({ label: f.label, cls: f.cls })));

  return `<div class="card card--pre weather-chart-panel">`
    + `<svg viewBox="0 0 ${PANEL_WIDTH} ${TEMP_PANEL_HEIGHT}" preserveAspectRatio="none" class="weather-chart-svg">`
    + grid + yAxis + lines
    + `</svg>${legend}</div>`;
}

// ----- Precip / percent panel -----------------------------------------------

// Right-axis "intensity" is plotted as a shaded area so even tiny rates
// register visually. The percent fields share the left axis [0, 100].
const PERCENT_FIELDS: Array<{ key: string; label: string; cls: string }> = [
  { key: "cloud_cover",          label: "Cloud Cover", cls: "weather-line-cloud"    },
  { key: "humidity",             label: "Humidity",    cls: "weather-line-humidity" },
  { key: "precip_prob",          label: "Precip Prob", cls: "weather-line-precipp"  }
];

export function precipPanelSvg(ts: Timeseries | undefined): string {
  if (!ts || !ts.fields) return emptyPanelSvg(PRECIP_PANEL_HEIGHT, "Precip data unavailable");
  const domain = symmetricTimeseriesDomain(ts);
  const xScale = xScaleForTimeseries(ts, domain);
  const yPercent = linear([0, 100], [PRECIP_PANEL_HEIGHT - PANEL_PAD_Y, PANEL_PAD_Y]);

  const present = PERCENT_FIELDS.filter((f) => ts.fields[f.key]?.values?.some((v) => v !== null));
  const lines = present.map((f) => {
    const path = pathFromValues(ts.fields[f.key].values, ts.t0, ts.step, xScale, yPercent, domain);
    return `<path class="${escapeHtml(f.cls)}" d="${path}" fill="none" />`;
  }).join("");

  // Precip intensity → shaded area scaled to its own observed max, with
  // a sensible floor so a flat-zero day doesn't disappear. We don't show
  // the right axis numerically — the shape is the signal, exact values
  // appear on the daily strip's per-day total.
  let area = "";
  let intensityLegend: Array<{ label: string; cls: string }> = [];
  const intensity = ts.fields["precip_intensity"];
  if (intensity?.values?.some((v) => v !== null)) {
    const maxIntensity = Math.max(0.05, ...intensity.values.filter((v): v is number => v !== null));
    const yIntensity = linear([0, maxIntensity], [PRECIP_PANEL_HEIGHT - PANEL_PAD_Y, PANEL_PAD_Y + 30]);
    area = areaFromValues(intensity.values, ts.t0, ts.step, xScale, yIntensity, PRECIP_PANEL_HEIGHT - PANEL_PAD_Y, domain);
    intensityLegend = [{ label: `Precip (${intensity.unit})`, cls: "weather-area-precip" }];
  }

  const yAxis = yAxisLabels([0, 100], yPercent, "%", PANEL_PAD_X);
  const grid = gridAndAnchor(ts, xScale, PRECIP_PANEL_HEIGHT, domain);
  const legend = legendHtml([...intensityLegend, ...present.map((f) => ({ label: f.label, cls: f.cls }))]);

  return `<div class="card card--pre weather-chart-panel">`
    + `<svg viewBox="0 0 ${PANEL_WIDTH} ${PRECIP_PANEL_HEIGHT}" preserveAspectRatio="none" class="weather-chart-svg">`
    + (area ? `<path class="weather-area-precip" d="${area}" />` : "")
    + grid + yAxis + lines
    + `</svg>${legend}</div>`;
}

// ----- Path generators ------------------------------------------------------

// Walk a regular-grid value array and emit an SVG path string. Null slots
// break the line so gaps render as gaps (not as line-to-zero). Mirrors
// d3.line().defined() but without the d3 dependency — our regular grid
// makes the math trivial.
export function pathFromValues(
  values: ReadonlyArray<number | null>,
  t0: number,
  step: number,
  xScale: (t: number) => number,
  yScale: (v: number) => number,
  domain?: [number, number]
): string {
  const parts: string[] = [];
  let inPath = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const t = t0 + i * step;
    if (domain && (t < domain[0] || t > domain[1])) { inPath = false; continue; }
    if (v === null || v === undefined || !Number.isFinite(v)) { inPath = false; continue; }
    const x = xScale(t).toFixed(1);
    const y = yScale(v).toFixed(1);
    parts.push(inPath ? `L${x},${y}` : `M${x},${y}`);
    inPath = true;
  }
  return parts.join("");
}

// Same walk but closes each contiguous span back to the baseline so the
// shape can be filled. One area path per gap-bounded run keeps fills
// honest across nulls.
export function areaFromValues(
  values: ReadonlyArray<number | null>,
  t0: number,
  step: number,
  xScale: (t: number) => number,
  yScale: (v: number) => number,
  baseline: number,
  domain?: [number, number]
): string {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let cur: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const t = t0 + i * step;
    if (domain && (t < domain[0] || t > domain[1])) {
      if (cur.length > 0) { segments.push(cur); cur = []; }
      continue;
    }
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (cur.length > 0) { segments.push(cur); cur = []; }
      continue;
    }
    cur.push({ x: xScale(t), y: yScale(v) });
  }
  if (cur.length > 0) segments.push(cur);
  return segments
    .filter((seg) => seg.length >= 2)
    .map((seg) => {
      const head = seg[0];
      const tail = seg[seg.length - 1];
      const top = seg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
      return `${top}L${tail.x.toFixed(1)},${baseline.toFixed(1)}L${head.x.toFixed(1)},${baseline.toFixed(1)}Z`;
    })
    .join("");
}

// ----- Scales / domain helpers ----------------------------------------------

function linear(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

function xScaleForTimeseries(ts: Timeseries, domain?: [number, number]): (t: number) => number {
  const [d0, d1] = domain ?? [ts.t0, ts.t0 + (firstField(ts)?.values.length ?? 0) * ts.step];
  return linear([d0, d1], [PANEL_PAD_X, PANEL_WIDTH - PANEL_PAD_X]);
}

function firstField(ts: Timeseries) {
  for (const k of Object.keys(ts.fields)) return ts.fields[k];
  return undefined;
}

function domainOf(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  let lo = values[0], hi = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  return [lo, hi];
}

function padDomain(domain: [number, number], frac: number): [number, number] {
  const [a, b] = domain;
  const span = (b - a) || 1;
  return [a - span * frac, b + span * frac];
}

// ----- Grid + now-line + day boundaries -------------------------------------

function gridAndAnchor(ts: Timeseries, xScale: (t: number) => number, height: number, domain?: [number, number]): string {
  const length = firstField(ts)?.values.length ?? 0;
  if (length === 0) return "";
  const [d0, d1] = domain ?? [ts.t0, ts.t0 + length * ts.step];
  // Past tint covers from the visible domain start up to the anchor.
  const pastEnd = Math.min(ts.anchor, d1);
  const pastStart = Math.max(d0, d0);  // domain start
  const pastWidth = Math.max(0, xScale(pastEnd) - xScale(pastStart));
  const pastTint = pastWidth > 0
    ? `<rect class="weather-chart-past" x="${xScale(pastStart).toFixed(1)}" y="0" width="${pastWidth.toFixed(1)}" height="${height}" />`
    : "";
  const lines: string[] = [];
  // Day boundaries, clipped to the visible domain.
  let t = Math.ceil(d0 / DAY_MS) * DAY_MS;
  while (t <= d1) {
    const x = xScale(t).toFixed(1);
    lines.push(`<line class="weather-chart-day-grid" x1="${x}" y1="0" x2="${x}" y2="${height}" />`);
    t += DAY_MS;
  }
  // Now-line (only if the anchor is in the visible window).
  if (ts.anchor >= d0 && ts.anchor <= d1) {
    const nowX = xScale(ts.anchor).toFixed(1);
    lines.push(`<line class="weather-chart-now" x1="${nowX}" y1="0" x2="${nowX}" y2="${height}" />`);
  }
  return pastTint + lines.join("");
}

function yAxisLabels(domain: [number, number], yScale: (v: number) => number, unit: string, padX: number): string {
  const ticks = niceTicks(domain[0], domain[1], 4);
  return ticks.map((t) => {
    const y = yScale(t).toFixed(1);
    return `<text class="weather-chart-ytick" x="${padX - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(formatRound(t))}${escapeHtml(unit)}</text>`;
  }).join("");
}

function niceTicks(a: number, b: number, count: number): number[] {
  if (a === b) return [a];
  const step = niceStep((b - a) / Math.max(1, count));
  const start = Math.ceil(a / step) * step;
  const out: number[] = [];
  for (let v = start; v <= b + 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(Math.abs(raw) || 1));
  const base = Math.pow(10, exp);
  const norm = raw / base;
  const niced = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return niced * base;
}

// ----- Legend / formatting --------------------------------------------------

function legendHtml(entries: Array<{ label: string; cls: string }>): string {
  if (entries.length === 0) return "";
  return `<div class="weather-chart-legend">`
    + entries.map((e) => `<span class="weather-chart-legend-item"><span class="weather-chart-legend-swatch ${escapeHtml(e.cls)}"></span>${escapeHtml(e.label)}</span>`).join("")
    + `</div>`;
}

function emptyPanelSvg(height: number, message: string): string {
  return `<div class="card card--pre weather-chart-panel weather-chart-panel-empty">`
    + `<svg viewBox="0 0 ${PANEL_WIDTH} ${height}" class="weather-chart-svg" preserveAspectRatio="none">`
    + `<text class="weather-chart-empty" x="${PANEL_WIDTH / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(message)}</text>`
    + `</svg></div>`;
}

function formatRound(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toString();
}

function formatPrecip(value: unknown, unit: unknown): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return `0 ${typeof unit === "string" ? unit : ""}`.trim();
  return `${n.toFixed(2)} ${typeof unit === "string" ? unit : ""}`.trim();
}

function formatDayLabel(date: string): string {
  // YYYY-MM-DD → "Sat 5/9". Keeps things compact in the strip.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parsed = new Date(`${date}T12:00:00Z`);   // mid-day UTC avoids DST flips
  const weekday = parsed.toLocaleDateString("en-US", { weekday: "short" });
  const month = parsed.getUTCMonth() + 1;
  const day = parsed.getUTCDate();
  return `${weekday} ${month}/${day}`;
}

// ----- Icons / conditions (mirrors weather-badge.ts vocabulary) -------------

function iconForWeatherCode(code: number | null): string {
  if (code === 1000) return "☀";
  if (code === 1100 || code === 1101 || code === 1102) return "◐";
  if (code === 1001) return "☁";
  if (code === 4000 || code === 4001 || code === 4200 || code === 4201) return "☂";
  if (code === 5000 || code === 5001 || code === 5100 || code === 5101) return "❄";
  if (code === 2000 || code === 2100) return "≋";
  if (code === 8000) return "⚡";
  return "·";
}

function conditionForWeatherCode(code: number | null): string {
  if (code === 1000) return "sunny";
  if (code === 1100 || code === 1101 || code === 1102) return "clouds";
  if (code === 1001) return "cloudy";
  if (code === 4000 || code === 4001 || code === 4200 || code === 4201) return "rain";
  if (code === 5000 || code === 5001 || code === 5100 || code === 5101) return "snow";
  if (code === 2000 || code === 2100) return "fog";
  if (code === 8000) return "storm";
  return "—";
}

// ----- The custom element ---------------------------------------------------

export class WooWeatherChartElement extends HTMLElement {
  private model: ChartProps = {};
  private dialog: HTMLDialogElement | null = null;

  set data(value: ChartProps) {
    this.model = value ?? {};
    if (this.dialog?.open) this.render();
  }

  open(props?: ChartProps): void {
    if (props) this.model = props;
    this.ensureDialog();
    this.render();
    if (!this.dialog!.open) {
      // jsdom (used in tests) doesn't implement showModal; fall back to
      // toggling the `open` attribute so unit tests can still verify the
      // open/close lifecycle. Real browsers honour showModal's top-layer
      // and backdrop semantics.
      if (typeof this.dialog!.showModal === "function") this.dialog!.showModal();
      else this.dialog!.setAttribute("open", "");
    }
  }

  close(): void {
    if (!this.dialog?.open) return;
    if (typeof this.dialog.close === "function") this.dialog.close();
    else this.dialog.removeAttribute("open");
  }

  private ensureDialog(): void {
    if (this.dialog) return;
    const dialog = document.createElement("dialog");
    dialog.className = "weather-chart-dialog";
    dialog.addEventListener("click", (event) => {
      // Click on the backdrop (not on inner content) closes. Use the
      // element's close() so the jsdom test path stays valid.
      if (event.target === dialog) this.close();
    });
    this.appendChild(dialog);
    this.dialog = dialog;
  }

  private render(): void {
    if (!this.dialog) return;
    const { current, daily, timeseries, place } = this.model;
    const todayDate = todayLocalDate(timeseries);
    const headline = headlineHtml(place, current);
    const strip = dailyStripHtml(daily ?? [], todayDate);
    const tempPanel = temperaturePanelSvg(timeseries);
    const precipPanel = precipPanelSvg(timeseries);
    this.dialog.innerHTML = `<div class="card card--raised weather-chart-card">`
      + `<button type="button" class="icon-button weather-chart-close" aria-label="Close" data-weather-close>×</button>`
      + headline
      + strip
      + tempPanel
      + precipPanel
      + `</div>`;
    const close = this.dialog.querySelector<HTMLButtonElement>("[data-weather-close]");
    // Use the element's own close() so the jsdom fallback path (no
    // native dialog.close) still works in unit tests.
    close?.addEventListener("click", () => this.close());
  }
}

function headlineHtml(place: string | undefined, current: CurrentBundle | undefined): string {
  const placeLabel = place && place.trim() ? place.trim() : "this location";
  const temp = current && typeof current.temperature === "number" ? `${formatRound(current.temperature)}${current.temperature_unit ?? ""}` : "—";
  const observed = current?.observed_at_text ? `as of ${current.observed_at_text}` : "";
  return `<div class="weather-chart-headline">`
    + `<div class="weather-chart-headline-place">${escapeHtml(placeLabel)}</div>`
    + `<div class="weather-chart-headline-temp">${escapeHtml(temp)}</div>`
    + `<div class="weather-chart-headline-observed">${escapeHtml(observed)}</div>`
    + `</div>`;
}

function todayLocalDate(ts: Timeseries | undefined): string | null {
  if (!ts || typeof ts.anchor !== "number") return null;
  const d = new Date(ts.anchor);
  // We don't have the tz here cheaply; ISO local-day is acceptable since
  // `daily` keys were built in the configured tz and we only use this to
  // highlight the matching card. A 1-tz-off mismatch is harmless cosmetic.
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-weather-chart", WooWeatherChartElement);
}
