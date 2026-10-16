import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(new URL('./fixtures/calendar-baseline.json', import.meta.url)));
const forecast = JSON.parse(readFileSync(new URL('./fixtures/uv-forecast.json', import.meta.url)));
const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1];
const compatibilityFlags = JSON.parse(config.match(/^compatibility_flags\s*=\s*(\[[^\n]+\])/m)[1]);
const endpoint = 'https://sun-cal.invalid/sun-cal.ics?latitude=30.48&longitude=-97.65&height=800&tz=-6';
const cacheKey = 'https://cache.sun-cal/uv?lat=30.48&lng=-97.65&alt=800';
const summary = 'Sun, UV; \\ ☀️\nSecond line';
const description = 'Unicode 🌅 █ 𝟬; comma, backslash \\ and newline\n'.repeat(12);
let mf;
let script;
let outboundAttempts = 0;

function unfold(body) {
  return body.replace(/\r\n[ \t]/g, '');
}

function eventsFrom(body) {
  return [...unfold(body).matchAll(/BEGIN:VEVENT\r\n([\s\S]*?)END:VEVENT/g)]
    .map(([, block]) => Object.fromEntries(block.trim().split('\r\n').map(line => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon), line.slice(colon + 1)];
    })));
}

function assertCalendarLines(body) {
  assert.equal(body.replaceAll('\r\n', '').includes('\n'), false, 'all line endings use CRLF');
  for (const line of body.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, 'physical lines fit 75 UTF-8 octets');
  }
  assert.ok(!body.includes('\uFFFD'), 'folding preserves Unicode code points');
}

function localWorker(bindings = { OPENUV_API_KEY: 'INERT_TEST_KEY' }) {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate,
    compatibilityFlags,
    cf: false,
    bindings,
    outboundService() {
      outboundAttempts += 1;
      // Block every network destination. An invalid forecast response makes an
      // accidental cache miss fail immediately instead of entering retry waits.
      return new LocalResponse('{"result":null}', {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}

before(async () => {
  const bundled = await build({
    stdin: {
      resolveDir: root,
      loader: 'ts',
      contents: `
        import worker from './src/index.ts';
        import ical from 'ical-generator';
        import { Settings } from 'luxon';
        Settings.now = () => Date.parse(${JSON.stringify(baseline.now)});
        Settings.defaultLocale = 'en-US';
        export default { async fetch(request, env, ctx) {
          if (new URL(request.url).pathname === '/__serializer') {
            const calendar = ical({ name: 'Escaping test' });
            calendar.createEvent({
              id: 'escape-fixture',
              start: new Date('2026-10-16T12:00:00Z'),
              end: new Date('2026-10-16T13:00:00Z'),
              summary: ${JSON.stringify(summary)},
              description: ${JSON.stringify(description)},
            });
            return new Response(calendar.toString());
          }
          const shape = request.headers.get('x-test-fixture');
          const fixture = shape === 'empty' ? [] : shape === 'envelope'
            ? { result: ${JSON.stringify(forecast)} } : ${JSON.stringify(forecast)};
          await caches.default.put(${JSON.stringify(cacheKey)}, new Response(
            shape === 'invalid-json' ? '{' : JSON.stringify(fixture),
            { headers: { 'Cache-Control': 'max-age=1800' } }
          ));
          return worker.fetch(request, env, ctx);
        }};
      `,
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
  });
  script = bundled.outputFiles[0].text;
  mf = localWorker();
  await mf.ready;
});

after(async () => {
  await mf?.dispose();
  assert.equal(outboundAttempts, 0, 'no test attempted an outbound request');
});

test('complete endpoint preserves the pre-upgrade calendar and headers', async () => {
  const response = await mf.dispatchFetch(endpoint);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'max-age=1800');
  const body = await response.text();
  assert.match(body, /^BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);
  assert.match(body, /\r\nNAME:☀️ Sun\r\n/);
  assert.match(body, /\r\nREFRESH-INTERVAL;VALUE=DURATION:PT30M\r\n/);
  assert.match(body, /\r\nX-PUBLISHED-TTL:PT30M\r\n/);
  assert.ok(body.endsWith('\r\nEND:VCALENDAR'));
  const events = eventsFrom(body);
  assert.equal(events.length, baseline.eventCount);
  assert.equal(new Set(events.map(event => event.UID)).size, 721);
  for (const { index, ...expected } of baseline.events) {
    const { DTSTAMP, ...actual } = events[index];
    assert.match(DTSTAMP, /^\d{8}T\d{6}Z$/);
    assert.deepEqual(actual, expected);
  }
  for (const event of events) {
    assert.match(event.DTSTART, /^\d{8}T\d{6}Z$/);
    assert.match(event.DTEND, /^\d{8}T\d{6}Z$/);
    assert.ok(event.DTSTART < event.DTEND);
  }
  const normalized = body.replace(/^DTSTAMP:[^\r\n]+/gm, 'DTSTAMP:IGNORED');
  assert.equal(createHash('sha256').update(normalized).digest('hex'), baseline.normalizedSha256);
  assert.equal(Buffer.byteLength(body), baseline.bytes);
  assertCalendarLines(body);
});

test('both supported UV cache shapes produce the same events', async () => {
  const arrayResponse = await mf.dispatchFetch(endpoint);
  const envelopeResponse = await mf.dispatchFetch(endpoint, { headers: { 'x-test-fixture': 'envelope' } });
  assert.equal(envelopeResponse.status, 200);
  const withoutStamp = event => {
    const { DTSTAMP, ...fields } = event;
    return fields;
  };
  assert.deepEqual(eventsFrom(await arrayResponse.text()).map(withoutStamp),
    eventsFrom(await envelopeResponse.text()).map(withoutStamp));
});

test('empty forecasts and an unmet min-uv threshold omit only the UV event', async () => {
  for (const [url, init] of [
    [endpoint, { headers: { 'x-test-fixture': 'empty' } }],
    [endpoint + '&min-uv=99', {}],
  ]) {
    const response = await mf.dispatchFetch(url, init);
    assert.equal(response.status, 200);
    const events = eventsFrom(await response.text());
    assert.equal(events.length, 720);
    assert.ok(events.every(event => !event.UID.includes('peak-uv')));
  }
});

test('serializer escapes text and folds multibyte lines without corruption', async () => {
  const response = await mf.dispatchFetch('https://sun-cal.invalid/__serializer');
  assert.equal(response.status, 200);
  const body = await response.text();
  const [event] = eventsFrom(body);
  assert.equal(event.SUMMARY, 'Sun\\, UV\\; \\\\ ☀️\\nSecond line');
  assert.equal(event.DESCRIPTION.replace(/\\([\\;,n])/g, (_, char) => char === 'n' ? '\n' : char), description);
  assert.match(body, /\r\n /, 'long lines are folded');
  assertCalendarLines(body);
});

test('routing, method and query errors retain their status and message', async () => {
  const cases = [
    ['https://sun-cal.invalid/', {}, 404, 'Not found'],
    [endpoint, { method: 'POST' }, 405, 'Method not allowed'],
    ['https://sun-cal.invalid/sun-cal.ics', {}, 400, 'Missing required query params: latitude, longitude, height'],
    [endpoint.replace('latitude=30.48', 'latitude='), {}, 400, 'Missing required query params: latitude'],
    [endpoint.replace('latitude=30.48', 'latitude=nope'), {}, 400, 'Invalid latitude'],
    [endpoint.replace('longitude=-97.65', 'longitude=Infinity'), {}, 400, 'Invalid longitude'],
    [endpoint.replace('height=800', 'height=1.5'), {}, 400, 'Invalid height'],
    [endpoint + '&min-uv=-1', {}, 400, 'Invalid min-uv'],
    [endpoint + '&min-uv=1.5', {}, 400, 'Invalid min-uv'],
    [endpoint.replace('tz=-6', 'tz=nope'), {}, 400, 'Invalid tz'],
  ];
  for (const [url, init, status, message] of cases) {
    const response = await mf.dispatchFetch(url, init);
    assert.equal(response.status, status, url);
    assert.equal(await response.text(), message, url);
  }
});

test('missing API key remains a configuration error', async () => {
  const unconfigured = localWorker({});
  try {
    const response = await unconfigured.dispatchFetch(endpoint);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Server misconfigured');
  } finally {
    await unconfigured.dispose();
  }
});

test('malformed UV cache JSON remains a calendar build error', async () => {
  const response = await mf.dispatchFetch(endpoint, { headers: { 'x-test-fixture': 'invalid-json' } });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /^Failed to build calendar: /);
});
