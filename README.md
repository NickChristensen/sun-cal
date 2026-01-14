# ☀️ Sun Cal

An ical feed with local daily sunrise/sunset and UV index events, deployable to a Cloudflare Worker.

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

## Deploy

```
wrangler secret put OPENUV_API_KEY
wrangler deploy
```

## Notes

- UV data is cached at the edge for 30 minutes per `latitude/longitude/height`.
- Event timestamps are UTC; description text uses `tz` to format local time.
