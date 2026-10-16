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
- Event timestamps are UTC; description text uses `tz` to format local time.
