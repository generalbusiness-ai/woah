import { describe, expect, it } from "vitest";
import { buildCurrent, buildDaily, buildTimeseries, fetchWeather, mergeDaily, mergeTimeseries, weekdayFromDate, type WeatherDailyEntry, type WeatherTimeseries } from "../src/tomorrow-io";

const HOUR_MS = 3_600_000;

describe("buildCurrent", () => {
  it("flattens realtime values to {temperature, humidity, weather_code, observed_at}", () => {
    const realtime = {
      data: {
        time: "2026-05-05T18:00:00Z",
        values: { temperature: 72.4, humidity: 60, weatherCode: 1000 }
      }
    };
    const current = buildCurrent(realtime, "imperial", 0);
    expect(current).toEqual({
      temperature: 72.4,
      temperature_unit: "°F",
      humidity: 60,
      weather_code: 1000,
      observed_at: Date.parse("2026-05-05T18:00:00Z")
    });
  });

  it("returns nulls for missing values and falls back to fetched_at when time is missing", () => {
    const current = buildCurrent({ data: { values: {} } }, "metric", 1_700_000_000_000);
    expect(current).toMatchObject({
      temperature: null,
      temperature_unit: "°C",
      humidity: null,
      weather_code: null,
      observed_at: 1_700_000_000_000
    });
  });
});

describe("buildTimeseries", () => {
  // Pin the anchor so we can assert exact array indices for the placed
  // hourly samples.
  const anchor = Date.parse("2026-05-05T18:00:00Z");
  const anchorHour = Math.floor(anchor / HOUR_MS) * HOUR_MS;
  const t0 = anchorHour - 168 * HOUR_MS;

  it("places hourly samples by ms-aligned index, fills the rest with nulls, exposes column-major fields", () => {
    const forecast = {
      timelines: {
        hourly: [
          // anchor + 1h = index 169
          { time: "2026-05-05T19:00:00Z", values: { temperature: 73, humidity: 58, weatherCode: 1000 } },
          // anchor + 2h = index 170
          { time: "2026-05-05T20:00:00Z", values: { temperature: 71, humidity: 62, weatherCode: 1100 } }
        ]
      }
    };
    const history = {
      timelines: {
        hourly: [
          // anchor - 2h = index 166
          { time: "2026-05-05T16:00:00Z", values: { temperature: 68, humidity: 67, weatherCode: 1000 } },
          // anchor - 1h = index 167
          { time: "2026-05-05T17:00:00Z", values: { temperature: 70, humidity: 65, weatherCode: 1000 } }
        ]
      }
    };
    const ts = buildTimeseries(forecast, history, anchor, "imperial");
    expect(ts.anchor).toBe(anchor);
    expect(ts.t0).toBe(t0);
    expect(ts.step).toBe(HOUR_MS);
    expect(ts.units).toBe("imperial");
    expect(ts.fields.temperature.values).toHaveLength(336);
    expect(ts.fields.temperature.unit).toBe("°F");
    expect(ts.fields.temperature.agg).toBe("mean");
    expect(ts.fields.temperature.values[166]).toBe(68);
    expect(ts.fields.temperature.values[167]).toBe(70);
    expect(ts.fields.temperature.values[169]).toBe(73);
    expect(ts.fields.temperature.values[170]).toBe(71);
    // Slot 168 (the anchor hour itself) has no sample → null gap.
    expect(ts.fields.temperature.values[168]).toBeNull();
    expect(ts.fields.humidity.values[167]).toBe(65);
    expect(ts.fields.weather_code.values[170]).toBe(1100);
    // Untouched slots stay null so d3.line()'s .defined() can skip them.
    expect(ts.fields.temperature.values[0]).toBeNull();
    expect(ts.fields.temperature.values[335]).toBeNull();
  });

  it("ignores samples outside the ±7d window", () => {
    const out = buildTimeseries(
      {
        timelines: {
          hourly: [
            { time: "2025-01-01T00:00:00Z", values: { temperature: 99 } },          // way before
            { time: "2030-01-01T00:00:00Z", values: { temperature: 99 } }           // way after
          ]
        }
      },
      null,
      anchor,
      "imperial"
    );
    expect(out.fields.temperature.values.every((v) => v === null)).toBe(true);
  });

  it("supports the alternate {data: {timelines: [{timestep, intervals}]}} response shape", () => {
    const ts = buildTimeseries(
      {
        data: {
          timelines: [
            { timestep: "1h", intervals: [{ startTime: "2026-05-05T19:00:00Z", values: { temperature: 73 } }] }
          ]
        }
      },
      null,
      anchor,
      "imperial"
    );
    expect(ts.fields.temperature.values[169]).toBe(73);
  });

  it("metric units relabel the field unit strings", () => {
    const ts = buildTimeseries(null, null, anchor, "metric");
    expect(ts.fields.temperature.unit).toBe("°C");
    expect(ts.fields.dew_point.unit).toBe("°C");
    expect(ts.fields.cloud_cover.unit).toBe("%");
    expect(ts.fields.precip_intensity.unit).toBe("mm/hr");
    expect(ts.fields.wind_speed.unit).toBe("m/s");
  });
});

describe("buildDaily", () => {
  it("merges history+forecast daily entries by local date, ascending, with forecast winning the overlap", () => {
    const history = {
      timelines: {
        daily: [
          // 2026-05-04 in America/Los_Angeles (07:00Z is midnight PDT-1)
          { time: "2026-05-04T07:00:00Z", values: { temperatureMin: 50, temperatureMax: 60, temperatureAvg: 55, humidityAvg: 70, rainAccumulationSum: 0.10, weatherCodeMax: 4000 } },
          // Overlap day — forecast should overwrite this one
          { time: "2026-05-05T07:00:00Z", values: { temperatureMin: 99, temperatureMax: 99, temperatureAvg: 99, humidityAvg: 99, rainAccumulationSum: 9.99, weatherCodeMax: 9999 } }
        ]
      }
    };
    const forecast = {
      timelines: {
        daily: [
          { time: "2026-05-05T07:00:00Z", values: { temperatureMin: 60, temperatureMax: 76, temperatureAvg: 68, humidityAvg: 60, rainAccumulationSum: 0.0, weatherCodeMax: 1000 } },
          { time: "2026-05-06T07:00:00Z", values: { temperatureMin: 58, temperatureMax: 74, temperatureAvg: 66, humidityAvg: 62, rainAccumulationSum: 0.05, weatherCodeMax: 1100 } }
        ]
      }
    };
    const daily = buildDaily(forecast, history, "imperial", "America/Los_Angeles");
    expect(daily.map((d) => d.date)).toEqual(["2026-05-04", "2026-05-05", "2026-05-06"]);
    // Overlap day: forecast won.
    expect(daily[1]).toMatchObject({
      temperature: { min: 60, max: 76, mean: 68, unit: "°F" },
      humidity: { mean: 60 },
      precip_total: 0.0,
      weather_code: 1000
    });
    // Each entry carries a 3-letter weekday so woocode :ask can match
    // "thursday" without doing date math in the VM. 2026-05-04 was a Monday.
    expect(daily.map((d) => d.weekday)).toEqual(["mon", "tue", "wed"]);
  });

  it("uses metric precip unit and accepts the temperatureMean alias", () => {
    const daily = buildDaily(
      { timelines: { daily: [{ time: "2026-05-05T00:00:00Z", values: { temperatureMin: 10, temperatureMax: 22, temperatureMean: 16 } }] } },
      null,
      "metric",
      "Europe/Berlin"
    );
    expect(daily[0]).toMatchObject({
      temperature: { min: 10, max: 22, mean: 16, unit: "°C" },
      precip_unit: "mm",
      weekday: "tue"
    });
  });

  it("returns an empty array when neither endpoint provided daily timelines", () => {
    expect(buildDaily(null, null, "imperial", "UTC")).toEqual([]);
  });
});

describe("mergeTimeseries", () => {
  // Helper: build a sparse timeseries with chosen non-null entries.
  // `populated` is a map of slot index → temperature value; humidity uses
  // the same indices to keep the test brief.
  function ts(t0: number, populated: Record<number, number>, length = 336): WeatherTimeseries {
    const tempValues: Array<number | null> = new Array(length).fill(null);
    const humValues: Array<number | null> = new Array(length).fill(null);
    for (const [k, v] of Object.entries(populated)) {
      tempValues[Number(k)] = v;
      humValues[Number(k)] = v + 10;
    }
    return {
      anchor: t0 + 168 * HOUR_MS,
      t0,
      step: HOUR_MS,
      units: "imperial",
      fields: {
        temperature: { unit: "°F", agg: "mean", values: tempValues },
        humidity:    { unit: "%",  agg: "mean", values: humValues  }
      }
    };
  }

  it("falls through to next when prev is null/undefined/empty", () => {
    const next = ts(0, { 168: 70 });
    expect(mergeTimeseries(null, next)).toBe(next);
    expect(mergeTimeseries(undefined, next)).toBe(next);
    expect(mergeTimeseries({} as any, next)).toBe(next);
  });

  it("falls through to next when steps disagree (cannot align)", () => {
    const prev = ts(0, { 168: 70 });
    const next: WeatherTimeseries = { ...ts(0, { 168: 71 }), step: HOUR_MS * 2 };
    expect(mergeTimeseries(prev, next).fields.temperature.values[168]).toBe(71);
  });

  it("fills nulls in next from prev at matching absolute timestamps", () => {
    // Prior tick at T0; next tick one hour later (anchor advances).
    const prevT0 = 1_000_000_000_000;
    const nextT0 = prevT0 + HOUR_MS;
    // Prior populated slots 100..200 with temp values.
    const prevPopulated: Record<number, number> = {};
    for (let i = 100; i <= 200; i++) prevPopulated[i] = 50 + i * 0.1;
    const prev = ts(prevT0, prevPopulated);
    // Next only populates the API window (e.g. slots 144..264 in next-grid).
    const nextPopulated: Record<number, number> = {};
    for (let i = 144; i <= 264; i++) nextPopulated[i] = 100;          // distinct sentinel
    const next = ts(nextT0, nextPopulated);

    const merged = mergeTimeseries(prev, next);
    // Slot 0 in next-grid corresponds to slot 1 in prev-grid (next.t0 = prev.t0 + 1h).
    // Prev had no value at slot 1, so merged stays null.
    expect(merged.fields.temperature.values[0]).toBeNull();
    // Slot 99 in next-grid → slot 100 in prev-grid (populated). Next had no value here.
    expect(merged.fields.temperature.values[99]).toBeCloseTo(50 + 100 * 0.1);
    // Slot 144 in next-grid is populated by next (sentinel 100). Next wins.
    expect(merged.fields.temperature.values[144]).toBe(100);
    // Slot 199 in next-grid → slot 200 in prev-grid (populated, last prev slot).
    // Next also covers it (144..264). Next wins.
    expect(merged.fields.temperature.values[199]).toBe(100);
    // Slot 265 in next-grid is past prev's coverage and past next's coverage. Stays null.
    expect(merged.fields.temperature.values[265]).toBeNull();
  });

  it("keeps next-only fields untouched and tolerates prev missing a field", () => {
    const prev = ts(0, { 100: 60 });
    const next = ts(0, {});
    next.fields.wind_speed = { unit: "mph", agg: "max", values: new Array(336).fill(null) };
    delete (prev as any).fields.humidity;       // prev lacks humidity
    const merged = mergeTimeseries(prev, next);
    expect(merged.fields.wind_speed.values).toHaveLength(336);
    // humidity in next stays null because prev doesn't carry it.
    expect(merged.fields.humidity.values[100]).toBeNull();
    // temperature still inherited from prev.
    expect(merged.fields.temperature.values[100]).toBe(60);
  });
});

describe("mergeDaily", () => {
  const tz = "America/Los_Angeles";

  function entry(date: string, mean: number): WeatherDailyEntry {
    return {
      date,
      weekday: weekdayFromDate(date),
      temperature: { min: mean - 5, max: mean + 5, mean, unit: "°F" },
      humidity: { min: 60, max: 80, mean: 70 },
      precip_total: 0,
      precip_unit: "in",
      weather_code: 1000
    };
  }

  it("returns next when prev is null/empty", () => {
    const next = [entry("2026-05-09", 65)];
    expect(mergeDaily(null, next, Date.parse("2026-05-09T18:00Z"), tz)).toEqual(next);
    expect(mergeDaily([], next, Date.parse("2026-05-09T18:00Z"), tz)).toEqual(next);
  });

  it("merges by date, with new winning the overlap, and keeps prior dates outside the API window", () => {
    const prev = [
      entry("2026-05-02", 60),         // 7 days back: kept
      entry("2026-05-05", 62),         // 4 days back: kept
      entry("2026-05-08", 99)          // overlap: overwritten by next
    ];
    const next = [
      entry("2026-05-08", 64),         // overwrites prev's 99
      entry("2026-05-09", 66),         // today
      entry("2026-05-10", 68),         // forecast
      entry("2026-05-13", 70)          // forecast end
    ];
    const merged = mergeDaily(prev, next, Date.parse("2026-05-09T18:00Z"), tz);
    expect(merged.map((e) => e.date)).toEqual(["2026-05-02", "2026-05-05", "2026-05-08", "2026-05-09", "2026-05-10", "2026-05-13"]);
    expect(merged.find((e) => e.date === "2026-05-08")?.temperature.mean).toBe(64);
  });

  it("trims entries outside ±7 d of the anchor", () => {
    const anchor = Date.parse("2026-05-09T18:00Z");
    const prev = [
      entry("2026-04-01", 50),         // way old: dropped
      entry("2026-05-01", 55),         // 8 days back: dropped
      entry("2026-05-02", 60),         // 7 days back: kept (boundary)
      entry("2026-05-09", 65)
    ];
    const merged = mergeDaily(prev, [], anchor, tz);
    expect(merged.map((e) => e.date)).toEqual(["2026-05-02", "2026-05-09"]);
  });

  // Pre-1.1 plug versions wrote daily entries without `weekday`. Those
  // entries can ride forward across many ticks (prev-side dates outside the
  // API window are kept as-is). $weather_block:ask uses `weekday` to match
  // "thursday" by string equality, so any retained entry must be backfilled
  // — otherwise "ask weather thursday" silently misses days the API stopped
  // covering. mergeDaily normalizes both prev and next on the way in.
  it("backfills weekday on legacy prev entries that pre-date the v1.1 schema", () => {
    const anchor = Date.parse("2026-05-09T18:00Z");
    // Cast through unknown to simulate a v1.0 entry shape that does NOT
    // have `weekday`. (The TS type guarantees the field for v1.1 builders,
    // but stored data from older deployments has no such guarantee.)
    const legacy = {
      date: "2026-05-08",
      temperature: { min: 60, max: 70, mean: 65, unit: "°F" },
      humidity: { min: 60, max: 80, mean: 70 },
      precip_total: 0,
      precip_unit: "in",
      weather_code: 1000
    } as unknown as WeatherDailyEntry;
    const merged = mergeDaily([legacy], [], anchor, tz);
    expect(merged).toHaveLength(1);
    // 2026-05-08 was a Friday.
    expect(merged[0].weekday).toBe("fri");
    // The rest of the entry shape is preserved.
    expect(merged[0]).toMatchObject({
      date: "2026-05-08",
      temperature: { min: 60, max: 70, mean: 65, unit: "°F" }
    });
  });
});

describe("fetchWeather", () => {
  it("wires three parallel GETs and assembles the {current, daily, timeseries, fetched_at} bundle", async () => {
    const responses: Record<string, any> = {
      "/weather/realtime": {
        data: { time: "2026-05-05T18:00:00Z", values: { temperature: 22, humidity: 60, weatherCode: 1000 } }
      },
      "/weather/forecast": {
        timelines: {
          hourly: [{ time: "2026-05-05T19:00:00Z", values: { temperature: 21 } }],
          daily: [{ time: "2026-05-05T07:00:00Z", values: { temperatureMin: 18, temperatureMax: 24, temperatureAvg: 21 } }]
        }
      },
      "/weather/history/recent": {
        timelines: {
          hourly: [{ time: "2026-05-05T17:00:00Z", values: { temperature: 23 } }],
          daily: [{ time: "2026-05-04T07:00:00Z", values: { temperatureMin: 16, temperatureMax: 23, temperatureAvg: 19 } }]
        }
      }
    };
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const key = Object.keys(responses).find((k) => url.includes(k));
      const body = key ? responses[key] : { error: "no match" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const snapshot = await fetchWeather({
      apiKey: "k", place: "Berlin", timezone: "Europe/Berlin", units: "metric",
      fetchImpl, now: () => Date.parse("2026-05-05T18:00:00Z")
    });

    expect(calls).toHaveLength(3);
    expect(calls.some((u) => u.includes("/weather/realtime"))).toBe(true);
    expect(calls.some((u) => u.includes("/weather/forecast") && u.includes("timesteps=1h%2C1d"))).toBe(true);
    expect(calls.some((u) => u.includes("/weather/history/recent") && u.includes("timesteps=1h%2C1d"))).toBe(true);

    expect(snapshot.fetched_at).toBe(Date.parse("2026-05-05T18:00:00Z"));
    expect(snapshot.current.temperature).toBe(22);
    expect(snapshot.current.temperature_unit).toBe("°C");
    expect(snapshot.daily.map((d) => d.date)).toEqual(["2026-05-04", "2026-05-05"]);
    expect(snapshot.timeseries.fields.temperature.unit).toBe("°C");
    expect(snapshot.timeseries.fields.temperature.values).toHaveLength(336);
  });
});
