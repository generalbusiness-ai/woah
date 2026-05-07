import { escapeHtml, type WooComponentRegistry } from "../../../src/client/framework";

export type WeatherBadgeData = {
  id?: string;
  name?: string;
  props?: Record<string, unknown>;
};

type WeatherCurrent = {
  value?: unknown;
  unit?: unknown;
  weather_code?: unknown;
  condition?: unknown;
};

export class WooWeatherBadgeElement extends HTMLElement {
  private model: WeatherBadgeData = {};

  set data(value: WeatherBadgeData) {
    this.model = value ?? {};
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const props = this.model.props ?? {};
    const config = mapValue(props.config_state);
    const current = mapValue(props.current) as WeatherCurrent | null;
    const status = typeof config?.status === "string" ? config.status : "";
    const title = weatherTitle(this.model, props, current, status);
    if (status === "pending") {
      this.innerHTML = `<span class="weather-badge pending" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><span aria-hidden="true">...</span></span>`;
      return;
    }
    if (status === "error") {
      this.innerHTML = `<span class="weather-badge error" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><span aria-hidden="true">!</span></span>`;
      return;
    }
    const temp = formatTemperature(current);
    const code = weatherCode(current, props);
    const icon = iconForWeatherCode(code);
    const condition = conditionForWeatherCode(code);
    this.innerHTML = `<span class="weather-badge" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><span class="weather-badge-icon" aria-hidden="true">${escapeHtml(icon)}</span><span class="weather-badge-temp">${escapeHtml(temp)}</span><span class="weather-badge-condition">${escapeHtml(condition)}</span></span>`;
  }
}

function mapValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function formatTemperature(current: WeatherCurrent | null): string {
  if (!current || current.value === undefined || current.value === null || current.value === "") return "--";
  const value = typeof current.value === "number" ? Math.round(current.value) : String(current.value);
  const unit = typeof current.unit === "string" ? current.unit : "";
  return `${value}${unit}`;
}

function weatherCode(current: WeatherCurrent | null, props: Record<string, unknown>): number | null {
  const direct = Number(current?.weather_code);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const forecast = mapValue(props.forecast);
  const hourly = Array.isArray(forecast?.hourly) ? forecast.hourly : [];
  const first = mapValue(hourly[0]);
  const fallback = Number(first?.weather_code);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
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
}
