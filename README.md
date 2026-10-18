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
- `tz` (optional): fixed hours offset from UTC (e.g. `-6`, `5.75`), or an IANA
  region (e.g. `America/Chicago`). Missing or empty values default to fixed `0`.

Example:

```
https://<your-subdomain>.workers.dev/sun-cal.ics?latitude=30.48&longitude=-97.65&height=800&min-uv=1&tz=-6
```

For events and descriptions that follow Chicago daylight-saving rules, replace
`tz=-6` in your subscription URL with `tz=America%2FChicago`:

```
https://<your-subdomain>.workers.dev/sun-cal.ics?latitude=30.48&longitude=-97.65&height=800&min-uv=1&tz=America%2FChicago
```

Existing numeric subscriptions keep their fixed-offset descriptions. Named
subscriptions use the canonical regional name and each event/hour's UTC offset;
UV rows include minutes, including fractional-offset regions such as Kathmandu.
Slash-containing region/alias identifiers, `Etc/*`, and `UTC` are supported when
present in the pinned IANA 2026e data. Bare abbreviations such as `CST`,
`local`/`system`, offset strings such as `+05:30`, and unsupported names return HTTP 400 before
forecast access. Numeric values are parsed first, preserving existing finite
numeric spellings; encode literal plus signs in URLs (`Etc/GMT%2B5` means UTC-05).

Named feeds use local `DTSTART`/`DTEND` values with the canonical `TZID` and one
matching `VTIMEZONE`. Their absolute instants and UIDs stay the same as numeric
feeds; all `DTSTAMP` values remain UTC. One narrow exception preserves exact
instants: if either endpoint occurs in the second occurrence of a backward-clock
fold, the entire event uses UTC endpoints. RFC 5545 can only identify the first
occurrence with an ordinary local TZID value. Descriptions still show the
requested region and actual offset. First occurrences and other transition
crossings retain TZID.

Named feeds also include `X-WR-TIMEZONE`. Viewers can display events in their own
zone; source-zone labels and Apple's secondary GMT label still require a client
check. Upgrade the subscription URL and refresh it directly in your calendar
client to check its presentation. Named conversion and definitions share pinned
IANA 2026e rules, independent of runtime Intl. Future legislative changes require
updating the conversion data and assets together. All named solar/UV endpoints
must lie within 2006-01-01 inclusive through 2088-01-01 exclusive (UTC); requests
outside coverage fail with HTTP 502 instead of extrapolating a terminal offset.
See [the design decision](docs/timezone-design.md) and
[asset generation instructions](docs/timezone-assets.md).

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
Named-zone tests check actual Worker output across DST gaps and both fold
occurrences, fractional-offset rows, aliases, cache separation and invalid input
handling. ICAL.js's known first-fold deviation is retained as negative evidence;
it does not widen the approved UTC exception. To independently verify complete
Worker feeds with Python ZoneInfo and an embedded-definition parser:

```sh
python3 -m venv /tmp/sun-cal-python
/tmp/sun-cal-python/bin/pip install -r test/timezone-requirements.txt
SUN_CAL_TIMEZONE_FIXTURES=/tmp/sun-cal-worker-feeds npm test
/tmp/sun-cal-python/bin/python test/verify-timezones.py /tmp/sun-cal-worker-feeds
```

These remain local synthetic forecasts with all outbound requests blocked.
The calendar baseline was captured with `ical-generator` 6.0.1 at the fixed time
recorded in `test/fixtures/calendar-baseline.json`; its digest ignores only
`DTSTAMP` values and protects the complete feed during the serializer upgrade.

## Deploy

```
wrangler secret put OPENUV_API_KEY
wrangler deploy
```

## GitHub Actions

Pull requests run `npm ci`, the test suite, and a Wrangler dry-run. Every push to `master`, including a merge, runs these checks. A queued run skips deployment if a newer commit is now at the production branch head. Production deployment stays disabled until the repository variable `CLOUDFLARE_DEPLOY_ENABLED` is set to `true` and the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured. Set the account ID secret to `311170064ca42bf2b861a7d78ccf4f2a`. Before enabling deployment, review the token's persistent access and scope it to this account with `Workers Scripts: Edit`; this workers.dev service needs no zone permissions. Keep `OPENUV_API_KEY` in Cloudflare Worker secrets; the workflow does not upload runtime secrets.

## Notes

- UV data is cached at the edge for 30 minutes per `latitude/longitude/height`.
- The already serialized solar calendar is cached separately in the Workers
  Cache API, using the request's UTC day, canonical numeric latitude, longitude,
  height, explicit timezone mode and canonical numeric offset or regional name,
  resolved locale/numbering system/calendar, and a versioned
  namespace. `min-uv` does not fragment this solar cache. Bump
  `SOLAR_CACHE_VERSION` when solar calculations, window rules, formatting or
  serialization, runtime compatibility or timezone-data assumptions change;
  prior versions expire naturally. Rendering uses namespace `v3`; named keys
  also include the pinned IANA release and asset digest.
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
- Numeric endpoints remain UTC; named endpoints normally carry a regional TZID.
  Both forms preserve the same absolute instants.
- The solar window uses the UTC date when the request starts: 180 days before
  through 179 days after that date (360 days, two solar events per day).
  Each date's sunrise/sunset uses its local solar cycle, independent of the
  request time or `tz`. Solar UIDs retain the intended date even when the event
  timestamp falls on an adjacent UTC date. Numeric `tz` is a fixed description
  offset; named `tz` follows the region's rules at each instant.
- At the date line, `+180` and `-180` intentionally label opposite sides of the
  same meridian: a given UID date selects the solar cycle on that side's local
  solar date, so their event timestamps differ by one day. Longitudes are not
  normalized into a different date-label convention.
- Solar calculations now consistently select the intended date's solar cycle.
  Previously the request time could select an adjacent cycle, changing event
  times under the same UID during the day. Existing UIDs may receive corrected
  event times once when this fix is deployed; subsequent requests remain stable
  for each intended date.
