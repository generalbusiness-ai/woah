# weather — design notes

## Concept

`$weather_block` is the canonical first `$block` subclass: a clear
example of "owner sets the upstream key, plug pushes the data, UI
renders the canonical kinds without weather-specific code." It also
exercises three property roles in one class:

1. a tiny **scalar bundle** (`current`) for chat verbs and the badge,
2. a small **rollup array** (`daily`) for "how was the week" verbs, and
3. a larger **chart payload** (`timeseries`) for a d3-driven detail UI.

The class object is a fertile template: behavior and owner tools live on
`$weather_block`, while deployed panels are ordinary non-fertile instances.

## Property surface (plug → block)

The plug fetches tomorrow.io's `weather/realtime`, `weather/forecast`, and
`weather/history/recent` endpoints for the configured `place`, then writes
three internally-consistent props in a single `:set_properties({...})`
bundle so a reader never sees a torn snapshot.

`place` is the owner-configured town name or zip code; the plug sends that
value upstream and the block displays the same value. `timezone` is the
IANA zone used by the plug to render the local-time strings on the
client-facing surfaces. If the upstream API does not recognise `place`,
the plug writes a helpful `last_error` instead of inventing a fallback
display location.

### `current` — scalar bundle (~80 bytes)

Read by chat verbs (`weather_line`, `look_self`, `ask`) and the title
badge. Flat keys, one read per verb, no JSON traversal in woocode beyond
a `has(...)` check.

```jsonc
{
  "temperature":      72.4,
  "temperature_unit": "°F",
  "humidity":         71,
  "weather_code":     1000,
  "observed_at":      1715260800000,            // ms epoch (UTC)
  "observed_at_text": "May 9, 10:00 AM EDT",    // plug renders, verb returns as-is
  "local_date":       "2026-05-09"              // YYYY-MM-DD in `timezone` at observed_at
}
```

`local_date` is stamped by the plug at push time so woocode `:ask` can
resolve "today" by string equality against `daily[*].date` without
running IANA timezone or DST math in the VM (the substrate has no Intl
access). It tracks `observed_at` in the configured timezone, not the
reader's wall clock — close enough at hourly cadence, but worth
remembering when the data is stale.

### `daily` — per-day rollup array (~1 KB, 14 entries)

Ordered ascending by date, spanning the past 7 days through the next 7
days. Each entry carries pre-computed min/max/mean per metric; chat verbs
that summarize the week never have to iterate the hourly chart payload.

```jsonc
[
  { "date":         "2026-05-03",
    "weekday":      "sun",                      // 3-letter lowercase, computed from `date`
    "temperature":  { "min": 55.1, "max": 72.0, "mean": 64.2, "unit": "°F" },
    "humidity":     { "min": 48,   "max": 81,   "mean": 67 },
    "precip_total": 0.05,
    "precip_unit":  "in",
    "weather_code": 1100 },
  // ...
]
```

`weekday` lets `:ask thursday` match by string without computing a day
of the week in pure DSL. Plug-side derivation: parse `date` as UTC
midnight, read getUTCDay (the input is already a calendar date in the
configured timezone, so the weekday is well-defined).

### `timeseries` — column-major chart payload (~16 KB, 336 hourly samples × 7 fields)

Read only by the d3 detail UI, never by chat verbs. Column-major shape:
each field is a single homogeneous array, `d3.line()` consumes it
directly without inflation. Regular grid (`t0 + step`) keeps timestamps
implicit so the array compresses well over the wire.

```jsonc
{
  "anchor":   1715260800000,        // epoch ms when "now" was at fetch time
  "place":    "Brooklyn, NY",
  "timezone": "America/New_York",
  "units":    "imperial",
  "t0":       1714656000000,        // epoch ms of every field's index 0
  "step":     3600000,              // ms between samples (always 1 hour for v1)
  "fields": {
    "temperature":      { "unit": "°F",   "agg": "mean", "values": [62.1, 61.7, /* ... */] },
    "temperature_apparent": { "unit": "°F", "agg": "mean", "values": [/* ... */] },
    "humidity":         { "unit": "%",    "agg": "mean", "values": [/* ... */] },
    "precip_prob":      { "unit": "%",    "agg": "max",  "values": [/* ... */] },
    "precip_intensity": { "unit": "in/hr","agg": "max",  "values": [/* ... */] },
    "wind_speed":       { "unit": "mph",  "agg": "max",  "values": [/* ... */] },
    "weather_code":     { "unit": "",     "agg": "mode", "values": [/* ... */] }
  }
}
```

### Status props

`last_pushed_at` (epoch ms) and `last_error` ride the standard `$block`
writable_self surface so `:look` surfaces freshness. `config_state` rides
weather-specific `writable_self`: `confirmed` after a successful fetch
for the current location/timezone, or `error` for configuration failures
such as an invalid timezone or an upstream "unknown place" response.

## Field semantics & consumer rules

- **Numbers, not strings.** Every numeric value is a JSON number. The plug
  never coerces to string. Display formatting happens at the UI/verb edge.
- **`null` for gaps.** If the upstream omits a sample, the column entry is
  `null` rather than absent. d3's `.defined(d => d !== null)` skips it cleanly.
- **`weather_code` is a Tomorrow.io integer code** (0, 1000, 1001, 1100, …).
  Consumers map to icons/labels; the plug never renames the code space.
- **`agg`** records how each field was rolled up into `daily`. Future fields
  follow the same convention so a generic UI can label rollups without a
  hardcoded table.
- **`anchor` is authoritative for "now"**, not `Date.now()` in the UI.
  The d3 chart positions the now-line from `anchor` so chart and data agree
  even if the client clock is skewed or the snapshot is stale.

## Size budget

Sized for ±7 days hourly across 7 fields:

| Section        | Size      |
|----------------|-----------|
| `current`      | ~80 B     |
| `daily`        | ~1 KB     |
| `timeseries`   | ~16 KB    |
| **Total**      | **~17 KB** — about 6 % of the 256 KB per-property ceiling |

Plenty of headroom: doubling the field count to 14 still lands ~30 KB.

## Chat verbs

`:weather_line` and `:look_self` are the always-on quick reads —
"temperature in <place>: 14°C" for the badge and the room title.

`:ask(query)` answers "ask weather <when>" in chat. Accepted queries:

| query              | resolves to                             |
|--------------------|-----------------------------------------|
| `today`, `now`     | `daily[]` entry whose `date` matches `current.local_date` |
| `tomorrow`         | one day after `current.local_date`      |
| `yesterday`        | one day before `current.local_date`     |
| `monday`..`sunday` | upcoming match in `daily[]` (falls back to past match if none) |
| `mon`..`sun`       | same as the full names                  |
| `M/D`, `M-D`       | `<year-of-local_date>-MM-DD` in `daily[]` (tries year ±1 if not found, for rollover) |
| `YYYY-MM-DD`       | exact `daily[]` entry                   |
| empty / blank      | same as `today`                         |

The verb returns one line, e.g. `Weather thu (2026-05-14) in Seattle: 18°C to 26°C`,
and `tell()`s the same line to the asker so it lands in chat. The line
includes precipitation (`, precip 1.2mm`) only when `daily[i].precip_total > 0`.

Command pattern: `dobj: "this", prep: "none", iobj: "none", args_from: ["dobj_prefix_rest"]`.
This routes "ask weather thursday" to the block via `dobj_prefix` (longest
prefix of the argstr that matches an object), with the remainder
("thursday") passed as the verb's `query` argument. Helpers
(`:resolve_day`, `:find_date_index`, `:normalize_weekday`, `:parse_md`,
`:zpad2`, `:format_day_line`) are all `direct_callable` so chat-style
override or composition is straightforward — none are tool-exposed.

The verb uses no IANA timezone math: it only walks `daily[]` (which is
already keyed by local calendar date) and matches strings. The plug is
responsible for keeping `current.local_date` and `daily[*].weekday` in
sync with the configured timezone.

## Owner-writable config

`place`, `timezone`, `units` are gated by `writable_owner`. Owners and
wizards use narrow exposed verbs (`set_location`, `set_units`) rather
than the raw generic `$block:set_property` surface. `set_location`
performs only local shape checks, writes `place` and `timezone`, clears
stale `last_error`, and marks `config_state.status` as `pending`. The
plug owns the semantic checks: IANA timezone validation and source-API
location failures all report back through `config_state` and `last_error`.

The plug subscribes to its own block's room — when an owner sets a
config prop, the resulting `block_data` observation reaches the plug;
the next poll cycle picks up the new value. (The plug also re-reads
config on each cycle, so a missed observation is harmless — the
queue-as-truth shape applies here too.)

## Draft UI

### Title badge

`weather.badge` / `<woo-weather-badge>` — a small `title-badge` component
declared in the manifest. The web client mounts title badges in the chat
room title bar when the current room's contents include a matching object.
The badge reads only the projected `current`, `config_state`, `place`, and
`last_error`; it never touches `timeseries` or even `daily`. Icon selection
uses `current.weather_code` so the badge does not infer condition from
temperature.

### Detail chart (planned)

A `block-detail` surface component (not yet shipped) will read
`timeseries` and render a multi-line d3 chart spanning the past week
through the next week, with the now-line positioned from `anchor`. Chart
work is tracked separately; it is not part of the v1 schema landing.

## Connection mode

Scheduled / disconnected. The plug Worker has a cron trigger (hourly).
On each fire it:

1. Authenticates via `apikey:<id>:<secret>`.
2. Reads `place`, `timezone`, `units` from the block.
3. Calls tomorrow.io's `weather/realtime`, `weather/forecast` (1h + 1d
   timesteps), and `weather/history/recent` endpoints.
4. Computes the `daily` rollups from the hourly samples (mean / min / max /
   sum / mode per `fields[name].agg`).
5. Calls `:set_properties({current, daily, timeseries, last_pushed_at, config_state})`
   in a single bundle.
6. Disconnects.

Failure paths set `last_error` and skip the data write; `:look` surfaces
the freshness state for operators.

### Free-tier budget

Per-tick API calls: 3 (realtime + forecast + history). Hourly cron:
72 calls/day per block, 3 calls/hour per block. Free-tier ceilings
(25/hour, 500/day) admit ~6 blocks per shared API key on hourly cron, or
many more if the cron is dropped to every 3-4 hours. The plug surfaces
429 with `retry-after` so degradation is graceful.

## Migration from v0.x to v1

The v1.0.0 manifest replaces the property surface:

- **Removed** — `forecast`, `history`, `forecast_hours` properties and
  the `set_forecast_hours` verb. `forecast_hours` was a v0 knob; the v1
  window is fixed at ±7 days.
- **Reshaped** — `current` was `{kind: "scalar", value, unit, label, weather_code, observed_at, observed_at_text?}`;
  it is now `{temperature, temperature_unit, humidity, weather_code, observed_at, observed_at_text}`.
  Verbs (`weather_line`, `look_self`) read `current.temperature` /
  `current.temperature_unit` instead of `current.value` / `current.unit`.
  No transform step ships — the plug rewrites `current` on its next tick;
  in the interim `:weather_line` falls back to "no current reading yet".
- **Added** — `daily` (list<map>), `timeseries` (map),
  `dew_point` and `cloud_cover` fields inside `timeseries.fields`.

This is a major-version bump (`0.x` → `1.0.0`); the catalog migrations
guard requires `migration-v0-to-v1.json` next to this DESIGN. The
migration drops the four dead surface elements via `drop_property` and
`drop_verb` steps so already-installed worlds don't keep stale state.

## Out of scope for v1

- The d3 detail-chart UI module (schema only this round).
- Multiple places per block (one block, one location; spawn another
  block for another location).
- Push-on-config-change (cron is enough for the demo).
- Persistent-WS mode (no real-time data here).

See [`notes/2026-05-05-block-and-plug.md`](../../notes/2026-05-05-block-and-plug.md)
for the broader pattern.
