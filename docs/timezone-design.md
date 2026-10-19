# SunCal named timezone decision (TODO-85 / TODO-86)

Status: accepted after research review; Nick approved the narrow second-fold UTC
exception. Apple/Google presentation requires client verification.

## Representation and compatibility

`tz` accepts finite legacy Number spellings first (missing/empty still fixed
zero), or safe slash-containing IANA names/aliases and explicit `UTC`. Reject
bare abbreviations, `local`/`system`, offset identifiers and unsupported names
before forecast access. Resolve aliases with pinned Moment timezone data and
the generated alias table, not host Intl. Numeric output stays byte-identical
ignoring DTSTAMP; do not infer a zone from coordinates.

Normal named events use local DTSTART/DTEND with canonical TZID and one matching
trusted VTIMEZONE. Named UTC maps to Etc/UTC because ical-generator normalizes
literal event timezone `UTC` to an unqualified value. Preserve exact instants,
UID strings, height semantics, captured UTC-day -180 through +179 solar window,
and independent 30-minute UV freshness.

RFC 5545 §3.3.5 assigns a repeated local clock to its first occurrence. Only
when either endpoint is in a backward-clock interval's **second occurrence**,
write both endpoints as UTC. This approved exception preserves the second
instant without shifting, omitting, splitting or duplicating events. First
occurrences, spring crossings and unambiguous transition crossings keep TZID.
Descriptions show local times.
An exceptional event may retain a GMT source label in clients.

Use the public explicit event timezone API with correctly zoned Moment values
and ASCII/English date formatting. Calendar.timezone stays unset so DTSTAMP
remains UTC. Native Date plus explicit event zone does not convert the clock;
a calendar zone makes stamps non-UTC. Compose public empty calendar properties,
trusted generated VTIMEZONE, then folded public event serialization.
X-WR-TIMEZONE is a hint before components. All events remain timed, with no
floating or VALUE=DATE endpoints.

## Data, coverage and maintenance

Pin Moment Timezone 0.6.5 / Moment 2.31.0 and IANA 2026e. Generate full explicit
observances from the exact official release tag with pinned libical/vzic
`--pure --no-rrules --no-rdates`. Compact current-rule components can lose past
changes. Explicit observances avoid measured recurrence-termination consumer
bugs. Pins, reproduction and sizes: [timezone-assets.md](timezone-assets.md).

Descriptions derive fixed per-instant offsets from the same pinned data. Named
Luxon/Intl reconversion can reintroduce stale legislative rules. Named UV rows
show hours and minutes, including Kathmandu and Lord Howe. Each forecast hour
has its own row, including separate rows with identical local time labels during
a repeated hour. Numeric UV rows show hours.

Guard the selected solar date window and every actual solar/UV endpoint within
**2006-01-01T00:00Z inclusive to 2088-01-01T00:00Z exclusive**. Outside coverage,
return the existing calendar-build error response (502); never extend the final
recurring offset indefinitely. The latest first explicit onset is Antarctica/Troll
in 2005; all 105 recurring components extend through 2088. These are structural
bounds, not exhaustive historical testing or a legislative guarantee. Update
conversion and assets together as rules change, well before reaching the guard.

## Cache and composition

Solar namespace v5 includes mode/canonical zone, IANA version and asset digest,
alongside date, coordinates, height and resolved formatting inputs.
Aliases share keys; numeric and named modes have separate keys. Cache reads and
writes use the rendering namespace.
Regenerate asset metadata for data changes and bump namespace for serialization
changes. Keep SHA256 integrity and best-effort cache fallback.

The daily cached named solar calendar contains one VTIMEZONE. Hits skip astronomy
and solar serialization. UV uses its independent forecast cache and appends only
its freshly serialized event, retaining one VCALENDAR and existing refresh TTL.
Never daily-cache the merged response.

## Evidence and limitations

Research covered 19 fixtures spanning spring gaps, both folds, half-hour folds,
aliases, UTC, fractional offsets and recent Morocco/Canada changes. Icalendar
with pinned Python ZoneInfo and vobject with embedded definitions preserved
every endpoint. The extra icalendar embedded check shares dateutil with vobject;
ZoneInfo supplies the independent timezone engine.

An independent RFC transition-table oracle matched Moment and Python IANA at
125,519 daily and transition-minus/exact/plus-second probes across 344 canonical
zones in the current guarded window. Five dateutil UTC-to-local fold/fromutc
edge deviations remain in Dublin/Morocco. ICAL.js 2.2.1 and node-ical 0.27.3
misread focused first-fold values; node-ical also follows stale Intl rules for
some changes. These consumer limits do not widen the approved second-fold
exception. Independently parse actual Worker output with explicit UTC expectations.
Protocol checks do not establish Apple/Google UI; verify Nick's named URL directly
in those clients separately.

## Primary sources

* [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545), §§3.3.5, 3.6.5,
  3.8.2.2 and 3.8.7.2: repeated clocks, definitions, endpoint form and UTC stamps.
* [ical-generator 11.1.2](https://github.com/sebbo2002/ical-generator/tree/v11.1.2):
  public event timezone conversion/serialization APIs.
* [IANA 2026e](https://github.com/eggert/tz/tree/2026e) and
  [official libical/vzic](https://github.com/libical/libical/tree/0dec1575bc81de232b8bea18f5d9c22fbc0daa12/vzic).
* [Moment Timezone](https://momentjs.com/timezone/): versioned conversion data.
