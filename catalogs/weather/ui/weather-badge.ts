import { escapeHtml, type ObservationRegistry, type WooComponentRegistry } from "../../../src/client/framework";
import { WooWeatherChartElement, registerWooComponents as registerChartComponents } from "./weather-chart";

export type WeatherBadgeData = {
  id?: string;
  name?: string;
  props?: Record<string, unknown>;
};

// Window event used to trigger the detail overlay. Both the badge's own
// click handler and the `weather_open` observation handler dispatch this;
// any badge listening on the page that owns the matching block id opens
// its dialog. Decoupling the launcher from the trigger keeps the verb
// path (`open weather` chat command) and the click path identical.
const OPEN_EVENT = "woo-weather-open";

// Field shape mirrors $weather_block's `current` (v0.2): a small flat
// scalar bundle written by the plug. The badge reads only the four
// fields it needs; if upstream adds more (e.g. dewpoint), unknown keys
// are ignored.
type WeatherCurrent = {
  temperature?: unknown;
  temperature_unit?: unknown;
  weather_code?: unknown;
};

export class WooWeatherBadgeElement extends HTMLElement {
  private model: WeatherBadgeData = {};
  private chart: WooWeatherChartElement | null = null;
  private openListener: ((event: Event) => void) | null = null;

  set data(value: WeatherBadgeData) {
    this.model = value ?? {};
    this.render();
  }

  connectedCallback(): void {
    this.addEventListener("click", this.handleClick);
    // role="button" + tabindex on a non-button element means the browser
    // makes it focusable but does NOT auto-fire click on Enter/Space —
    // we wire that ourselves. Without this the badge is reachable by
    // keyboard but un-activatable, which fails accessibility.
    this.addEventListener("keydown", this.handleKeydown);
    this.openListener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      // An open trigger fired anywhere on the page; if it names this
      // badge's block, we own the data and open the chart. Other badges
      // ignore it. Block id missing → fall back to "this badge opens"
      // (single-block deployments are the common case).
      if (!detail || !detail.block || detail.block === this.model.id) this.openChart();
    };
    window.addEventListener(OPEN_EVENT, this.openListener);
    this.render();
  }

  disconnectedCallback(): void {
    if (this.openListener) {
      window.removeEventListener(OPEN_EVENT, this.openListener);
      this.openListener = null;
    }
    this.removeEventListener("click", this.handleClick);
    this.removeEventListener("keydown", this.handleKeydown);
  }

  private handleClick = (event: Event): void => {
    // Don't re-trigger via the chart's own internal clicks.
    if ((event.target as HTMLElement | null)?.closest(".weather-chart-dialog")) return;
    event.preventDefault();
    this.openChart();
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    // Ignore key activations bubbled up from the chart's controls
    // (close button, etc.) so Enter inside the dialog doesn't reopen it.
    if ((event.target as HTMLElement | null)?.closest(".weather-chart-dialog")) return;
    event.preventDefault();
    this.openChart();
  };

  private openChart(): void {
    if (!this.chart) {
      this.chart = document.createElement("woo-weather-chart") as WooWeatherChartElement;
      // Append at the end of <body> so the modal's top-layer doesn't
      // fight with stacking contexts in the title bar.
      document.body.appendChild(this.chart);
    }
    this.chart.open({
      current: this.model.props?.current as any,
      daily: this.model.props?.daily as any,
      timeseries: this.model.props?.timeseries as any,
      place: typeof this.model.props?.place === "string" ? this.model.props.place : undefined,
      timezone: typeof this.model.props?.timezone === "string" ? this.model.props.timezone : undefined
    });
  }

  private render(): void {
    const props = this.model.props ?? {};
    const config = mapValue(props.config_state);
    const current = mapValue(props.current) as WeatherCurrent | null;
    const status = typeof config?.status === "string" ? config.status : "";
    const title = weatherTitle(this.model, props, current, status);
    // role/tabindex make the badge keyboard-activatable so the chart
    // overlay isn't gated on a mouse.
    const accessibleAttrs = `role="button" tabindex="0" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"`;
    if (status === "pending") {
      this.innerHTML = `<span class="pill weather-badge pending" ${accessibleAttrs}><span aria-hidden="true">...</span></span>`;
      return;
    }
    if (status === "error") {
      this.innerHTML = `<span class="pill pill--danger weather-badge error" ${accessibleAttrs}><span aria-hidden="true">!</span></span>`;
      return;
    }
    const temp = formatTemperature(current);
    const code = weatherCode(current);
    const icon = iconForWeatherCode(code);
    const condition = conditionForWeatherCode(code);
    this.innerHTML = `<span class="pill weather-badge" ${accessibleAttrs}><span class="weather-badge-icon" aria-hidden="true">${escapeHtml(icon)}</span><span class="weather-badge-temp">${escapeHtml(temp)}</span><span class="weather-badge-condition">${escapeHtml(condition)}</span></span>`;
  }
}

function mapValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function formatTemperature(current: WeatherCurrent | null): string {
  const raw = current?.temperature;
  if (raw === undefined || raw === null || raw === "") return "--";
  const value = typeof raw === "number" ? Math.round(raw) : String(raw);
  const unit = typeof current?.temperature_unit === "string" ? current.temperature_unit : "";
  return `${value}${unit}`;
}

function weatherCode(current: WeatherCurrent | null): number | null {
  const direct = Number(current?.weather_code);
  return Number.isFinite(direct) && direct > 0 ? direct : null;
}

function iconForWeatherCode(code: number | null): string {
  if (code === 1000) return "☀";
  if (code === 1100 || code === 1101 || code === 1102) return "◐";
  if (code === 4000 || code === 4001 || code === 4200 || code === 4201) return "☂";
  if (code === 5000 || code === 5001 || code === 5100 || code === 5101) return "❄";
  if (code === 2000 || code === 2100) return "≋";
  if (code === 8000) return "⚡";
  return "°";
}

function conditionForWeatherCode(code: number | null): string {
  if (code === 1000) return "sunny";
  if (code === 1100 || code === 1101 || code === 1102) return "clouds";
  if (code === 4000 || code === 4001 || code === 4200 || code === 4201) return "rain";
  if (code === 5000 || code === 5001 || code === 5100 || code === 5101) return "snow";
  if (code === 2000 || code === 2100) return "fog";
  if (code === 8000) return "storm";
  return "weather";
}

function weatherTitle(model: WeatherBadgeData, props: Record<string, unknown>, current: WeatherCurrent | null, status: string): string {
  const place = typeof props.place === "string" && props.place.trim() ? props.place.trim() : model.name ?? "weather";
  if (status === "pending") return `Weather for ${place} is updating`;
  if (status === "error") {
    const lastError = props.last_error === undefined || props.last_error === null ? "" : String(props.last_error);
    return lastError ? `Weather for ${place}: ${lastError}` : `Weather for ${place} has an error`;
  }
  return `Weather for ${place}: ${formatTemperature(current)}`;
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-weather-badge", WooWeatherBadgeElement);
  // Register the chart as well so it's a defined custom element wherever
  // the badge instantiates it (or wherever the open observation lands).
  registerChartComponents(registry);
}

// The `:open` verb on $weather_block emits a `weather_open` observation
// directed to the actor. We re-broadcast that as a window event so the
// in-page badge owning the named block opens its detail dialog. This
// gives us a unified open path for both the badge click and the
// "open weather" chat command — the badge listens once and doesn't care
// who pulled the trigger.
export function registerWooObservationHandlers(registry: ObservationRegistry): void {
  registry.observation({
    types: ["weather_open"],
    reduce: (_draft, envelope) => {
      // The verb emits `block: this`, not `target:` — `target` would
      // collide with the runtime's "actor target hijack" rule and route
      // the observation to the block itself instead of the calling actor.
      const block = (envelope.observation as { block?: unknown }).block;
      const blockId = typeof block === "string" ? block : undefined;
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
        window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { block: blockId } }));
      }
    }
  });
}
