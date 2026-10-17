# ☀️ Sun Cal

An iCal feed with local daily sunrise/sunset and UV index events, deployable to a Cloudflare Worker.

<img width="566" height="503" alt="Calendar example" src="https://github.com/user-attachments/assets/8e236a12-fa63-4c4b-ae98-7b8a7118c77c" />

## Endpoint

- `GET /sun-cal.ics`

### Query params

- `latitude` (required): decimal degrees
- `longitude` (required): decimal degrees
- `height` (required): feet (integer)
- `min-uv` (optional): integer, default `1`
- `tz` (optional): hours offset from UTC for description text (e.g. `-6`)

Example:

```
https://<your-subdomain>.workers.dev/sun-cal.ics?latitude=30.48&longitude=-97.65&height=800&min-uv=1&tz=-6
```

## Requirements
- An [OpenUV](https://www.openuv.io) API key (free for up to 50 reqs/day)

## Local development

Use Node.js 22 or 24+ (required by `ical-generator`).

```
npm install
```

Create `.dev.vars`:

```
OPENUV_API_KEY=your_key_here
```

Run:

```
wrangler dev
```

## Tests

```
npm ci
npm test
```

Tests run the Worker in local workerd with the compatibility date and flags from
`wrangler.toml`. Synthetic UV forecasts populate its local cache; outbound
requests and Cloudflare metadata lookups are disabled. No API key is needed.
Solar-generation tests bypass the solar cache; separate cache tests count actual
astronomy and event serialization calls, and exercise UV refreshes and failures.
The calendar baseline was captured with `ical-generator` 6.0.1 at the fixed time
recorded in `test/fixtures/calendar-baseline.json`; its digest ignores only
`DTSTAMP` values and protects the complete feed during the serializer upgrade.

## Deploy

```
wrangler secret put OPENUV_API_KEY
wrangler deploy
```

## Notes

- UV data is cached at the edge for 30 minutes per `latitude/longitude/height`.
- The already serialized solar calendar is cached separately in the Workers
  Cache API, using the request's UTC day, canonical numeric latitude, longitude,
  height and `tz`, resolved locale/numbering system/calendar, and a versioned
  namespace. `min-uv` does not fragment this solar cache. Bump
  `SOLAR_CACHE_VERSION` when solar calculations, window rules, formatting or
  serialization change; prior versions expire naturally.
- A solar cache hit skips astronomy and serialization of all 720 solar events.
  UV keeps its independent 30-minute forecast cache, and its event is rendered
  for every request and appended to the solar calendar. The merged feed keeps
  its existing 30-minute HTTP and iCalendar refresh TTL; it is never stored in
  the daily solar cache.
- Solar entries have a maximum age of one day. A new UTC day immediately uses
  a different key, even if the previous entry remains physically cached until
  its TTL expires. Cache storage is per data center and best effort: eviction,
  concurrent misses, or read/write failures can cause regeneration. No new
  storage binding is required; cache failures leave the generated feed usable.
- Cached solar `DTSTAMP` values reflect the cache fill and remain unchanged on
  hits. A new day's fill can update stamps on overlapping events, while their
  UIDs, event times and descriptions remain stable. UV is serialized separately
  each time. Cache hits check the entry's key metadata and calendar boundaries,
  then verify its SHA-256 body checksum recorded at cache fill. Interior changes,
  truncation or missing integrity metadata trigger regeneration without parsing
  every event; checksum failures also leave the generated feed usable.
- Event timestamps are UTC; description text uses `tz` to format local time.
- The solar window uses the UTC date when the request starts: 180 days before
  through 179 days after that date (360 days, two solar events per day).
  Each date's sunrise/sunset uses its local solar cycle, independent of the
  request time or `tz`. Solar UIDs retain the intended date even when the event
  timestamp falls on an adjacent UTC date. `tz` is a fixed description offset,
  not a timezone or daylight-saving rule.
- At the date line, `+180` and `-180` intentionally label opposite sides of the
  same meridian: a given UID date selects the solar cycle on that side's local
  solar date, so their event timestamps differ by one day. Longitudes are not
  normalized into a different date-label convention.
- Solar calculations now consistently select the intended date's solar cycle.
  Previously the request time could select an adjacent cycle, changing event
  times under the same UID during the day. Existing UIDs may receive corrected
  event times once when this fix is deployed; subsequent requests remain stable
  for each intended date.
