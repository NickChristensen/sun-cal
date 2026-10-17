# SunCal timezone decision (TODO-85)

Status: accepted after independent review, 2026-10-17. Baseline: `78ee8ee`.

## Decision and compatibility

Extend the existing `tz` parameter to accept an IANA timezone name, for example
`tz=America%2FChicago`. Missing or empty values retain the existing numeric UTC
offset of zero. Finite numeric values, including fractional offsets, retain their
existing parsing and output. Existing subscriptions continue to work; they must
opt into a named-zone URL to gain DST-aware descriptions. Do not guess a zone
from coordinates or silently reinterpret a numeric offset.

For named values, support slash-containing IANA region/alias identifiers and the
explicit special case `UTC` (case-insensitive). Require safe IANA identifier
characters, validate through the Worker runtime's Intl timezone support, and
canonicalize aliases through `resolvedOptions().timeZone`. Reject bare
abbreviations such as `CST`/`PST`, numeric offset strings accepted by newer Intl
APIs, unsupported names, and malformed values with HTTP 400 before any forecast
access. `Etc/*` identifiers are supported. Canonical aliases share solar cache
entries. Finite legacy Number parsing happens first, preserving whitespace,
fractional and exponent spellings; unsupported named forms never use a fallback.
Validation must not treat Luxon's special `local` or `system` values as regions.

Use Luxon `setZone` on each absolute event instant to produce descriptions in
the requested region. Include the canonical IANA name and the actual UTC offset
for that instant. For example, Chicago uses UTC-06:00 in winter and UTC-05:00 in
summer under current rules. Label each UV chart row's offset so repeated local
hours remain distinguishable. Named UV row labels must include minutes: a
12:00Z forecast is 17:45 in Kathmandu, not 17:00. Preserve legacy numeric row
formatting. Do not shift event timestamps to change their displayed clock time.

Keep all `DTSTART`, `DTEND` and `DTSTAMP` values as UTC date-times ending in `Z`.
For named mode, add `X-WR-TIMEZONE:America/Chicago` among the calendar properties,
before the first component. This is a nonstandard regional hint; clients may
ignore it. The standard UTC values remain sufficient to interpret every event.
Serialize the empty header calendar with the library's public `x` API, then append
serialized events before its final END:VCALENDAR, as in the existing UV merge.
This keeps the property before components without configuring a calendar timezone
or rewriting serialized timestamp fields.
Do not attach a TZID to UTC values, generate floating times, or add a VTIMEZONE
component that is not referenced by any TZID. Numeric mode adds no metadata and
must preserve the existing complete-feed baseline, ignoring only DTSTAMP.

This deliberately prioritizes correct instants and regional descriptions over
changing the event's source-zone representation. It does **not** promise to
remove Apple's secondary GMT label. That remains an explicit client test.

## What was verified

The baseline `src/index.ts` accepts finite numeric `tz` only. `buildSunEvents`
and `createBarChartLine` add those hours to UTC purely for description text.
The serializer receives native Date objects and writes UTC event endpoints.
The existing original and performance-updated fixtures have no TZID,
VTIMEZONE, TIMEZONE-ID or X-WR-TIMEZONE metadata. There is no demonstrated
timezone-encoding regression from the performance work.

The window is **360 days**, offsets -180 through +179 from the request's captured
UTC day, with 720 solar events plus zero or one UV event. It is approximately six
months of history and six months ahead, rather than six months total. Solar noon
anchors and UID dates describe the selected solar cycle; timezone selection
must not change either. The UV event retains its UTC-date-based UID and forecast
cache independently of the solar representation.

Nick's Apple screenshots show the correct noon-to-2pm local event interval with
a secondary 5pm-to-7pm GMT interval. The UV description's 11am/noon rows fit a
fixed -6 offset during daylight time, but his exact subscription URL is missing,
so that parameter is unconfirmed. A synthetic October forecast reproduces the
one-hour description difference between numeric -6 and Chicago's daylight -5
without changing event instants. Nick subscribes directly in Apple Calendar.

The Longhorns Google Calendar settings show Central Time–Chicago. Its actual
source ICS was unavailable; a settings screenshot does not establish that its
VEVENTs use TZID or contain a VTIMEZONE. No source-format comparison is claimed.
The live Worker hostname is blocked by the execution environment's explicit
outbound restriction. Do not retry through alternate proxies or credentials.

## Serialization alternatives and local evidence

Local prototypes used ical-generator 11.1.2, Luxon 3.7.2, Node 24.19.0 with
Intl tzdata 2026b, and independent ical.js 2.2.1. No real UV calls were made.
The selected UTC-plus-hint prototype preserved all 13 test intervals in both
ical.js and Python icalendar 7.3.0, including spring crossings, both fold
occurrences and half-hour folds. See `utc-hint-prototype.mjs`, `verify-utc.py` and
`utc-results.json` in the research artifacts. Production tests must exercise the
actual Worker, rather than only reproducing the serializer setup.

* Setting the calendar timezone to Chicago makes the library write a DTSTAMP
  without `Z`. With native Date event values it also uses host wall-clock fields
  instead of converting the instant. Explicit event zones plus correctly zoned
  Luxon values avoid the endpoint problem, but require a correct VTIMEZONE and
  special handling for repeated hours. See the installed library's
  `src/calendar.ts`, `src/event.ts` and `src/tools.ts` at the pinned version.
* A fall-back local wall time cannot uniquely encode both occurrences. The RFC
  selects the first occurrence; the tested ical.js parser selected the second.
  UTC endpoints unambiguously encode both, including intervals crossing a DST
  change. Parser success alone is therefore insufficient evidence for a TZID
  design: it needs explicit UTC expectations at transition boundaries.
* The library-recommended compact `timezones-ical-library` 2.3.2 matched daily
  Chicago offsets throughout this 360-day fixture, but its Casablanca component
  used a constant zero offset retroactively across historical dates that had
  +01:00. The other suggested package, `@touch4it/ical-timezones` 1.9.0, contained
  2018g data and filesystem imports. Neither establishes broad current IANA
  correctness for the full moving past/future window.
* A research-only Python icalendar 7.3.0 generator with pinned tzdata 2026.5
  (IANA 2026e) exposed transition/consumer interoperability problems as well.
  A maintained full IANA/vzic asset pipeline is possible, but adds data-version,
  supported-range, alias and parser-maintenance obligations. Defer it until a
  verified client requirement justifies changing source-zone serialization.

Timezone legislation also changes. IANA 2026c changed Morocco to permanent
UTC+00 from 2026-09-20; local Node Intl's older 2026b still disagreed afterward.
Named descriptions use the deployed runtime's timezone rules, not a promise of
the latest global legislation. Document this dependency, verify relevant zones
when runtime rules change, and bump the solar namespace when changing formatting,
runtime compatibility or timezone data assumptions. UTC event instants are
independent of that display-data limitation. Do not claim that local Node's
tzdata version proves the production Worker's version.

Research scripts and results are retained separately under
`/workspace/sun-cal-timezone-work/research/`; they are investigation artifacts,
not runtime dependencies or production code.

## Cache, identity and freshness

Increment the solar cache namespace from v1 to v2. Encode the mode explicitly
(`fixed` or `iana`) and the canonical value, alongside the existing UTC day,
coordinates, height and resolved locale/numbering-system/calendar inputs.
Aliases that canonicalize identically may share entries; different regions and
legacy offsets must not. No `min-uv` in solar identity. Old entries expire
naturally; they cannot satisfy v2 reads.

Keep the 24-hour solar TTL and immediate key rollover at UTC midnight. This
already bounds cached description exposure after an unannounced runtime data
update; explicit deployment changes to timezone assumptions require a namespace
bump. Cache failures continue to regenerate a usable feed. UV keeps its separate
30-minute cache and per-request event rendering; do not cache the combined feed
for a day. Keep one VCALENDAR and the existing 30-minute HTTP/iCalendar refresh
hints. UID strings, astronomical inputs and the UTC date window stay unchanged.

## Examples and verification matrix

Illustrative October UV interval, unchanged absolute instants and UID:

```ics
; Existing numeric tz=-6 (excerpt)
DTSTART:20261017T170000Z
DTEND:20261017T190000Z
DESCRIPTION:11 AM ...\n12 PM ...

; Proposed tz=America/Chicago (calendar property, before VEVENT)
X-WR-TIMEZONE:America/Chicago
; Inside the same event
DTSTART:20261017T170000Z
DTEND:20261017T190000Z
DESCRIPTION:12:00 PM (America/Chicago\, UTC-05:00) ...\n01:00 PM ...
```

These excerpts omit Unicode chart styling, folding and other required event
properties; they are not complete import files. In winter, 17:00Z is 11:00 CST.
When a viewer travels to Los Angeles, that October instant is 10:00 local; the
regional description still reads noon Chicago. Client timezone override settings
may affect the displayed clock. The feed must not change its instant to follow
the viewer. All SunCal events remain timed; no VALUE=DATE or floating endpoints.

Before releasing TODO-86, verify:

| Case | Required evidence |
| --- | --- |
| Legacy/missing/empty/numeric/fractional tz | Existing full-feed digest and defaults; no new regional hint |
| Named validation and aliases | Invalid values return 400 before UV; canonical aliases share keys |
| Chicago winter/summer | Expected -06:00/-05:00 descriptions; endpoints and UIDs equal legacy |
| Fractional regional offsets | Kathmandu 12:00Z → 17:45; Lord Howe half-hour offsets; UV labels retain minutes |
| Spring-forward, fall-back, both repeated hours | Explicit expected UTC endpoints and row-specific offsets; independent parser agrees |
| Viewer travel and all-day distinction | Same absolute instant viewed in different regions; only timed UTC endpoints |
| Cache | Zone/mode separation, aliases, v2 invalidation, daily rollover, miss/hit generation counts |
| Dynamic forecast | New forecast changes UV while reusing solar text; min-uv stays independent |
| Complete feed | One VCALENDAR, 720 unique solar events, zero/one UV event, UTF-8 folding and UTC stamps |
| Actual clients | Nick refreshes the named URL directly in Apple Calendar; record GMT-label behavior; Google import if available |

Independent parser and local tests verify protocol semantics, not Apple/Google
UI. Keep actual client validation explicitly pending when unavailable. Do not
recommend switching Nick to Google subscription refresh or changing account
timezone/security settings.

## Primary sources

* [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545), §§3.2.19,
  3.3.5, 3.6, 3.6.5 and 3.8.7.2: UTC, floating and TZID forms; repeated times;
  calendar structure; referenced zone definitions; UTC DTSTAMP.
* [ical-generator 11.1.2 README](https://github.com/sebbo2002/ical-generator/blob/v11.1.2/README.md):
  recommends UTC where possible; explains explicit zone conversion and generators.
* [Luxon timezone guide](https://github.com/moment/luxon/blob/master/docs/zones.md):
  Intl-backed zones and preserving an instant through `setZone`.
* [IANA releases](https://www.iana.org/time-zones/releases) and
  [2026e release](https://www.iana.org/time-zones/releases/2026e): current data and
  legislation changes; also checked the maintainer's `eggert/tz` NEWS and africa.
* [Apple iPhone calendar timezone guide](https://support.apple.com/guide/iphone/schedule-display-events-a-time-zone-iph69525c028/ios):
  display follows location or override; original timezone can remain visible.
* [Google Calendar timezone guide](https://support.google.com/calendar/answer/37064?hl=en):
  UTC instants and local display; account settings do not prove source encoding.

## Research review resolution

Intent: establish the contract before changing production code, preserving legacy
subscriptions, instants, identities and UV freshness. Reviewers: A, gpt-6-astra
xhigh; B, gpt-6.1-sol xhigh. Both reviewed the same frozen packet and baseline.
Unavailable configured reviewer models required the previously disclosed fallback.

Act on: B found that named chart rows could lose fractional-offset minutes; both
reviewers confirmed the issue. The contract and matrix now explicitly require
minutes and Kathmandu/Lord Howe Worker coverage. Both also confirmed Intl accepts
ambiguous abbreviations; the supported spelling policy now explicitly rejects
them while preserving numeric precedence. These corrections are required in
TODO-86. No remaining consider, noted or dismissed findings. B reran both parser
checks; A reran the Python check; all 13 retained UTC intervals passed. Neither
identified another blocking issue with the selected representation. Shared
follow-up context means confirmation is not counted as independent discovery.
