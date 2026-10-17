import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse } from 'miniflare';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(new URL('./fixtures/calendar-baseline.json', import.meta.url)));
const forecast = JSON.parse(readFileSync(new URL('./fixtures/uv-forecast.json', import.meta.url)));
const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1];
const compatibilityFlags = JSON.parse(config.match(/^compatibility_flags\s*=\s*(\[[^\n]+\])/m)[1]);
const endpoint = 'https://sun-cal.invalid/sun-cal.ics?latitude=30.48&longitude=-97.65&height=800&tz=-6';
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

function withoutStamp(event) {
  const { DTSTAMP, ...fields } = event;
  return fields;
}

async function cacheRequest(url = endpoint, headers = {}) {
  const response = await mf.dispatchFetch(url, {
    headers: { 'x-test-solar-cache': 'use', ...headers },
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return {
    response, body, events: eventsFrom(body),
    counts: JSON.parse(response.headers.get('x-test-counts')),
    key: response.headers.get('x-test-solar-key'),
  };
}

function withTimezone(value) {
  const url = new URL(endpoint);
  if (value === null) url.searchParams.delete('tz');
  else url.searchParams.set('tz', value);
  return url.href;
}

async function namedCalendar(zone, forecastItems = forecast, now = baseline.now) {
  const response = await mf.dispatchFetch(withTimezone(zone), {
    headers: { 'x-test-forecast': JSON.stringify(forecastItems), 'x-test-now': now },
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const parsed = new ICAL.Component(ICAL.parse(body));
  return { body, response, parsed, events: parsed.getAllSubcomponents('vevent').map(event => new ICAL.Event(event)) };
}

function plainChart(text) {
  const unicode = '𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵𝖺𝗉𝗆';
  const ascii = '0123456789apm';
  return Array.from(text, char => {
    const index = Array.from(unicode).indexOf(char);
    return index === -1 ? char : ascii[index];
  }).join('');
}

async function solarEvents(url = endpoint, now = baseline.now, zone = 'UTC') {
  const response = await mf.dispatchFetch(url, {
    headers: { 'x-test-now': now, 'x-test-zone': zone },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return eventsFrom(await response.text())
    .filter(event => !event.UID.includes('peak-uv')).map(withoutStamp);
}

function locationEndpoint(latitude, longitude, tz = 0) {
  return `https://sun-cal.invalid/sun-cal.ics?latitude=${latitude}&longitude=${longitude}&height=800&tz=${tz}`;
}

function isoDateFromIcal(value) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
}

function assertSolarWindow(events, firstDay, lastDay) {
  assert.equal(events.length, 720);
  assert.equal(new Set(events.map(event => event.UID)).size, 720);
  assert.equal(events[0].UID, `sun-cal-sunrise-${firstDay}`);
  assert.equal(events.at(-1).UID, `sun-cal-sunset-${lastDay}`);
  const first = Date.parse(`${firstDay}T00:00:00Z`);
  for (let index = 0; index < 360; index += 1) {
    const day = new Date(first + index * 86400000).toISOString().slice(0, 10);
    for (const [position, kind] of [[0, 'sunrise'], [1, 'sunset']]) {
      const event = events[index * 2 + position];
      assert.equal(event.UID, `sun-cal-${kind}-${day}`);
      assert.match(event.DTSTART, /^\d{8}T\d{6}Z$/);
      assert.match(event.DTEND, /^\d{8}T\d{6}Z$/);
      assert.ok(event.DTSTART < event.DTEND);
    }
  }
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
        import ical, { ICalCalendar, ICalEvent } from 'ical-generator';
        import SunCalc from 'suncalc';
        import { Settings } from 'luxon';
        Settings.defaultLocale = 'en-US';
        let clockNow;
        let nextNow;
        let uvClockAdvanced;
        let solarMode;
        let counts;
        let solarKey;
        let solarTtl;
        let solarContainsUv;
        let digestCalls;
        let hashFailure;
        let legacyCachePresent;
        const subtlePrototype = Object.getPrototypeOf(crypto.subtle);
        const originalDigest = subtlePrototype.digest;
        subtlePrototype.digest = function(...args) {
          digestCalls += 1;
          if (hashFailure) return Promise.reject(new Error('Synthetic checksum failure'));
          return originalDigest.apply(this, args);
        };
        const originalSunTimes = SunCalc.getTimes;
        SunCalc.getTimes = function(...args) {
          counts.sunCalc += 1;
          return originalSunTimes.apply(this, args);
        };
        const originalCalendarString = ICalCalendar.prototype.toString;
        ICalCalendar.prototype.toString = function(...args) {
          counts.calendarSerializations += 1;
          return originalCalendarString.apply(this, args);
        };
        const originalEventString = ICalEvent.prototype.toString;
        ICalEvent.prototype.toString = function(...args) {
          counts[this.id().includes('peak-uv') ? 'uvSerializations' : 'solarSerializations'] += 1;
          return originalEventString.apply(this, args);
        };
        const cachePrototype = Object.getPrototypeOf(caches.default);
        const originalMatch = cachePrototype.match;
        const originalPut = cachePrototype.put;
        const originalDelete = cachePrototype.delete;
        cachePrototype.match = async function(...args) {
          const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url);
          if (url.pathname.startsWith('/solar/')) {
            counts.solarReads += 1;
            solarKey = url.href;
            if (solarMode === 'bypass' || solarMode.startsWith('write-')) return undefined;
            if (solarMode === 'reset') {
              await originalDelete.call(this, args[0]);
              return undefined;
            }
            if (solarMode === 'v1-only') {
              const current = await originalMatch.apply(this, args);
              const legacy = new URL(url);
              legacy.pathname = '/solar/v1';
              const headers = new Headers(current.headers);
              headers.set('X-Sun-Cal-Key', legacy.href);
              await originalPut.call(this, legacy.href, new Response(current.body, { headers }));
              await originalDelete.call(this, args[0]);
              legacyCachePresent = Boolean(await originalMatch.call(this, legacy.href));
              return originalMatch.apply(this, args);
            }
            if (solarMode === 'read-error') throw new Error('Synthetic cache read failure');
            if (['corrupt', 'empty', 'body-error'].includes(solarMode)) {
              const body = solarMode === 'body-error'
                ? new ReadableStream({ start(controller) { controller.error(new Error('Synthetic body failure')); } })
                : solarMode === 'empty' ? 'BEGIN:VCALENDAR\\r\\nVERSION:2.0\\r\\nEND:VCALENDAR' : 'truncated calendar';
              return new Response(body, { headers: { 'X-Sun-Cal-Key': url.href } });
            }
          }
          const cached = await originalMatch.apply(this, args);
          if (url.pathname.startsWith('/solar/') && cached && ['wrong-key', 'missing-key', 'bad-status'].includes(solarMode)) {
            const headers = new Headers(cached.headers);
            if (solarMode === 'wrong-key') headers.set('X-Sun-Cal-Key', 'wrong-key');
            if (solarMode === 'missing-key') headers.delete('X-Sun-Cal-Key');
            return new Response(cached.body, { status: solarMode === 'bad-status' ? 503 : cached.status, headers });
          }
          if (url.pathname.startsWith('/solar/') && cached &&
              ['broken-interior', 'nested', 'tampered', 'missing-hash', 'wrong-hash'].includes(solarMode)) {
            const headers = new Headers(cached.headers);
            let body = await cached.text();
            if (solarMode === 'broken-interior') {
              body = 'BEGIN:VCALENDAR\\r\\nVERSION:2.0\\r\\nBEGIN:VEVENT\\r\\nEND:VEVENT\\r\\nEND:VCALENDAR';
            }
            if (solarMode === 'nested') {
              body = body.replace('BEGIN:VEVENT\\r\\n',
                'BEGIN:VCALENDAR\\r\\nVERSION:2.0\\r\\nEND:VCALENDAR\\r\\nBEGIN:VEVENT\\r\\n');
            }
            if (solarMode === 'tampered') body = body.replace('SUMMARY:🌅 Sunrise', 'SUMMARY:🌅 Altered sunrise');
            if (solarMode === 'missing-hash') headers.delete('X-Sun-Cal-SHA256');
            if (solarMode === 'wrong-hash') headers.set('X-Sun-Cal-SHA256', '0'.repeat(64));
            return new Response(body, { status: cached.status, headers });
          }
          if (nextNow && url.hostname === 'cache.sun-cal' && url.pathname === '/uv') {
            clockNow = Date.parse(nextNow);
            nextNow = null;
            uvClockAdvanced = true;
          }
          if (url.pathname === '/uv') counts.uvReads += 1;
          return cached;
        };
        cachePrototype.put = function(key, response) {
          const url = new URL(typeof key === 'string' ? key : key.url);
          if (!url.pathname.startsWith('/solar/')) return originalPut.call(this, key, response);
          counts.solarWrites += 1;
          solarKey = url.href;
          solarTtl = response.headers.get('Cache-Control');
          if (solarMode === 'bypass') return Promise.resolve();
          if (solarMode === 'write-sync-error') throw new Error('Synthetic synchronous write failure');
          if (solarMode === 'write-error') return Promise.reject(new Error('Synthetic rejected write'));
          return (async () => {
            solarContainsUv = (await response.clone().text()).includes('peak-uv');
            await originalPut.call(this, key, response);
          })();
        };
        export default { async fetch(request, env, ctx) {
          solarMode = request.headers.get('x-test-solar-cache') || 'bypass';
          counts = { sunCalc: 0, solarSerializations: 0, uvSerializations: 0,
            calendarSerializations: 0, solarReads: 0, solarWrites: 0, uvReads: 0 };
          solarKey = '';
          solarTtl = '';
          solarContainsUv = false;
          digestCalls = 0;
          hashFailure = request.headers.has('x-test-hash-failure');
          legacyCachePresent = false;
          clockNow = Date.parse(request.headers.get('x-test-now') || ${JSON.stringify(baseline.now)});
          nextNow = request.headers.get('x-test-next-now');
          uvClockAdvanced = false;
          Settings.now = () => clockNow;
          Settings.defaultLocale = request.headers.get('x-test-locale') || 'en-US';
          Settings.defaultNumberingSystem = request.headers.get('x-test-numbering-system');
          Settings.defaultOutputCalendar = request.headers.get('x-test-output-calendar');
          Settings.defaultZone = request.headers.get('x-test-zone') || 'UTC';
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
          const forecast = request.headers.has('x-test-forecast')
            ? JSON.parse(request.headers.get('x-test-forecast')) : ${JSON.stringify(forecast)};
          const fixture = shape === 'empty' ? [] : shape === 'envelope' ? { result: forecast }
            : shape === 'changed' ? forecast.map(item => ({ ...item, uv: item.uv + 1 })) : forecast;
          const params = new URL(request.url).searchParams;
          const cacheKey = 'https://cache.sun-cal/uv?lat=' + encodeURIComponent(params.get('latitude'))
            + '&lng=' + encodeURIComponent(params.get('longitude'))
            + '&alt=' + encodeURIComponent(params.get('height'));
          await caches.default.put(cacheKey, new Response(
            shape === 'invalid-json' ? '{' : JSON.stringify(fixture),
            { headers: { 'Cache-Control': 'max-age=1800' } }
          ));
          const pending = [];
          const response = await worker.fetch(request, env, {
            waitUntil(promise) { pending.push(promise); ctx.waitUntil(promise); },
          });
          await Promise.all(pending);
          response.headers.set('x-test-counts', JSON.stringify(counts));
          response.headers.set('x-test-solar-key', solarKey);
          response.headers.set('x-test-solar-ttl', solarTtl);
          response.headers.set('x-test-solar-contains-uv', String(solarContainsUv));
          response.headers.set('x-test-digest-calls', String(digestCalls));
          response.headers.set('x-test-legacy-cache-present', String(legacyCachePresent));
          if (request.headers.has('x-test-next-now')) {
            response.headers.set('x-test-uv-clock-advanced', String(uvClockAdvanced));
          }
          return response;
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
  assert.deepEqual(eventsFrom(await arrayResponse.text()).map(withoutStamp),
    eventsFrom(await envelopeResponse.text()).map(withoutStamp));
});

test('solar events are stable for a UTC day across longitudes, including both date-line edges', async () => {
  for (const [name, latitude, longitude] of [
    ['Austin', 30.48, -97.65],
    ['Greenwich', 51.48, 0],
    ['Tokyo', 35.68, 139.69],
    ['Auckland', -36.85, 174.76],
    ['Honolulu', 21.31, -157.86],
    ['east date line', -17.7, 180],
    ['west date line', -17.7, -180],
  ]) {
    const url = locationEndpoint(latitude, longitude);
    const morning = await solarEvents(url, '2026-10-16T00:00:00Z');
    assertSolarWindow(morning, '2026-04-19', '2027-04-13');
    for (const now of ['2026-10-16T12:00:00Z', '2026-10-16T23:59:59.999Z']) {
      assert.deepEqual(await solarEvents(url, now), morning, `${name}: ${now}`);
    }
    // In these non-polar locations the dawn/sunset start, expressed as local
    // mean solar time, belongs to its UID's date. This catches a stable but
    // wrong adjacent solar cycle at the date line.
    for (const event of morning) {
      const localSolarDate = new Date(Date.parse(isoDateFromIcal(event.DTSTART))
        + longitude * 4 * 60000).toISOString().slice(0, 10);
      assert.equal(localSolarDate, event.UID.slice(-10), name);
    }
  }
});

test('UTC midnight shifts the exact 360-day window while overlapping events stay identical', async () => {
  for (const longitude of [-180, -97.65, 180]) {
    const url = locationEndpoint(30.48, longitude);
    const previous = await solarEvents(url, '2026-10-16T23:59:59.999Z');
    const next = await solarEvents(url, '2026-10-17T00:00:00Z');
    assertSolarWindow(previous, '2026-04-19', '2027-04-13');
    assertSolarWindow(next, '2026-04-20', '2027-04-14');
    assert.deepEqual(previous.slice(2), next.slice(0, -2));
  }
});

test('the entire solar window uses the request day when the UV cache read crosses UTC midnight', async () => {
  const expected = await solarEvents(endpoint, '2026-10-16T23:59:59.999Z');
  const response = await mf.dispatchFetch(endpoint, {
    headers: {
      'x-test-now': '2026-10-16T23:59:59.999Z',
      'x-test-next-now': '2026-10-17T00:00:00Z',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-test-uv-clock-advanced'), 'true');
  const actual = eventsFrom(await response.text())
    .filter(event => !event.UID.includes('peak-uv')).map(withoutStamp);
  assert.deepEqual(actual, expected);
});

test('DST transition dates and default timezones do not change solar instants or UID dates', async () => {
  for (const [date, latitude, longitude, zone] of [
    ['2026-03-08', 30.48, -97.65, 'America/Chicago'],
    ['2026-11-01', 30.48, -97.65, 'America/Chicago'],
    ['2026-04-05', -36.85, 174.76, 'Pacific/Auckland'],
    ['2026-09-27', -36.85, 174.76, 'Pacific/Auckland'],
  ]) {
    const url = locationEndpoint(latitude, longitude);
    const midnight = await solarEvents(url, `${date}T00:00:00Z`);
    assert.deepEqual(await solarEvents(url, `${date}T12:00:00Z`, zone), midnight);
    assert.deepEqual(await solarEvents(url, `${date}T23:59:59.999Z`, 'Pacific/Kiritimati'), midnight);
  }
});

test('numeric tz remains a fixed description offset without changing solar instants or UIDs', async () => {
  const utc = await solarEvents(locationEndpoint(30.48, -97.65, 0));
  const shifted = await solarEvents(locationEndpoint(30.48, -97.65, -6));
  const withoutDescription = event => {
    const { DESCRIPTION, ...fields } = event;
    return fields;
  };
  assert.deepEqual(shifted.map(withoutDescription), utc.map(withoutDescription));
  assert.notEqual(shifted[0].DESCRIPTION, utc[0].DESCRIPTION);
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

test('a solar cache hit bypasses astronomy and all solar serialization while preserving the complete feed', async () => {
  const miss = await cacheRequest(endpoint, { 'x-test-solar-cache': 'reset' });
  assert.deepEqual(miss.counts, {
    sunCalc: 360, solarSerializations: 720, uvSerializations: 1,
    calendarSerializations: 1, solarReads: 1, solarWrites: 1, uvReads: 1,
  });
  assert.equal(miss.response.headers.get('x-test-solar-ttl'), 'max-age=86400');
  assert.equal(miss.response.headers.get('x-test-solar-contains-uv'), 'false');
  const hit = await cacheRequest();
  assert.deepEqual(hit.counts, {
    sunCalc: 0, solarSerializations: 0, uvSerializations: 1,
    calendarSerializations: 0, solarReads: 1, solarWrites: 0, uvReads: 1,
  });
  assert.equal(hit.key, miss.key);
  assert.equal(hit.response.headers.get('Cache-Control'), 'max-age=1800');
  assert.equal(hit.response.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  for (const { body } of [miss, hit]) {
    assert.equal((body.match(/BEGIN:VCALENDAR/g) || []).length, 1);
    assert.equal((body.match(/END:VCALENDAR/g) || []).length, 1);
    const normalized = body.replace(/^DTSTAMP:[^\r\n]+/gm, 'DTSTAMP:IGNORED');
    assert.equal(createHash('sha256').update(normalized).digest('hex'), baseline.normalizedSha256);
    assert.equal(Buffer.byteLength(body), baseline.bytes);
    assertCalendarLines(body);
  }
  // Solar DTSTAMP values are retained with the serialized events on hits.
  assert.deepEqual(hit.events.slice(0, 720), miss.events.slice(0, 720));
});

test('solar keys canonicalize numbers, ignore min-uv, and isolate every render option', async () => {
  const base = await cacheRequest(endpoint, { 'x-test-solar-cache': 'reset' });
  const canonical = endpoint.replace('latitude=30.48', 'latitude=3.048e1')
    .replace('longitude=-97.65', 'longitude=-9.765e1')
    .replace('height=800', 'height=8e2').replace('tz=-6', 'tz=-6.0');
  for (const url of [canonical, canonical + '&min-uv=99', endpoint + '&min-uv=0&ignored=anything']) {
    const hit = await cacheRequest(url);
    assert.equal(hit.key, base.key);
    assert.equal(hit.counts.sunCalc, 0);
  }
  assert.equal(new URL(base.key).pathname, '/solar/v2');
  for (const [url, headers] of [
    [endpoint.replace('latitude=30.48', 'latitude=30.49'), {}],
    [endpoint.replace('longitude=-97.65', 'longitude=-97.66'), {}],
    [endpoint.replace('height=800', 'height=801'), {}],
    [endpoint.replace('tz=-6', 'tz=-5'), {}],
    [endpoint, { 'x-test-now': '2026-10-18T12:00:00Z' }],
    [endpoint, { 'x-test-locale': 'en-GB' }],
    [endpoint, { 'x-test-numbering-system': 'arab' }],
    [endpoint, { 'x-test-output-calendar': 'islamic' }],
  ]) {
    const miss = await cacheRequest(url, headers);
    assert.notEqual(miss.key, base.key);
    assert.equal(miss.counts.sunCalc, 360, miss.key);
    const hit = await cacheRequest(url, headers);
    assert.equal(hit.key, miss.key);
    assert.equal(hit.counts.sunCalc, 0, hit.key);
  }
  const zero = await cacheRequest(locationEndpoint(30.48, -97.65), { 'x-test-solar-cache': 'reset' });
  for (const url of [locationEndpoint(30.48, -97.65).replace('&tz=0', ''), locationEndpoint(30.48, -97.65, -0).replace('tz=0', 'tz=-0')]) {
    const hit = await cacheRequest(url);
    assert.equal(hit.key, zero.key);
    assert.equal(hit.counts.sunCalc, 0);
  }
  const east = await cacheRequest(locationEndpoint(-17.7, 180), { 'x-test-solar-cache': 'reset' });
  const west = await cacheRequest(locationEndpoint(-17.7, -180), { 'x-test-solar-cache': 'reset' });
  assert.notEqual(east.key, west.key);
  assert.notEqual(east.events[0].DTSTART, west.events[0].DTSTART);
});

test('UV refreshes, thresholds, empty forecasts and errors remain independent of a solar hit', async () => {
  const base = await cacheRequest(endpoint, { 'x-test-solar-cache': 'reset' });
  for (const [url, headers, uvCount] of [
    [endpoint, { 'x-test-fixture': 'changed' }, 1],
    [endpoint, { 'x-test-fixture': 'empty' }, 0],
    [endpoint + '&min-uv=99', {}, 0],
  ]) {
    const hit = await cacheRequest(url, headers);
    assert.equal(hit.counts.sunCalc, 0);
    assert.equal(hit.counts.solarSerializations, 0);
    assert.equal(hit.counts.uvReads, 1);
    assert.equal(hit.events.length, 720 + uvCount);
    assert.deepEqual(hit.events.slice(0, 720), base.events.slice(0, 720));
    if (uvCount) assert.notEqual(hit.events.at(-1).SUMMARY, base.events.at(-1).SUMMARY);
    assertCalendarLines(hit.body);
  }
  const restored = await cacheRequest();
  assert.equal(restored.counts.sunCalc, 0);
  assert.deepEqual(withoutStamp(restored.events.at(-1)), withoutStamp(base.events.at(-1)));
  const error = await mf.dispatchFetch(endpoint, {
    headers: { 'x-test-solar-cache': 'use', 'x-test-fixture': 'invalid-json' },
  });
  assert.equal(error.status, 502);
  assert.match(await error.text(), /^Failed to build calendar: /);
});

test('daily solar keys retain the captured request day and shift the window only at the next request day', async () => {
  const before = await cacheRequest(endpoint, {
    'x-test-solar-cache': 'reset', 'x-test-now': '2026-10-16T23:59:59.999Z',
  });
  const crossing = await cacheRequest(endpoint, {
    'x-test-now': '2026-10-16T23:59:59.999Z', 'x-test-next-now': '2026-10-17T00:00:00Z',
  });
  assert.equal(crossing.response.headers.get('x-test-uv-clock-advanced'), 'true');
  assert.equal(crossing.key, before.key);
  assert.equal(crossing.counts.sunCalc, 0);
  assert.deepEqual(crossing.events.slice(0, 720), before.events.slice(0, 720));
  const next = await cacheRequest(endpoint, { 'x-test-now': '2026-10-17T00:00:00Z' });
  assert.notEqual(next.key, before.key);
  assert.equal(next.counts.sunCalc, 360);
  assertSolarWindow(before.events.slice(0, 720), '2026-04-19', '2027-04-13');
  assertSolarWindow(next.events.slice(0, 720), '2026-04-20', '2027-04-14');
  assert.deepEqual(before.events.slice(2, 720).map(withoutStamp), next.events.slice(0, 718).map(withoutStamp));
  assert.equal((await cacheRequest(endpoint, { 'x-test-now': '2026-10-17T18:00:00Z' })).counts.sunCalc, 0);
});

test('solar cache read, body, metadata and write failures safely regenerate the feed', async () => {
  const base = await cacheRequest(endpoint, { 'x-test-solar-cache': 'reset' });
  for (const mode of ['read-error', 'body-error', 'corrupt', 'empty', 'wrong-key', 'missing-key', 'bad-status', 'write-error', 'write-sync-error']) {
    const fallback = await cacheRequest(endpoint, { 'x-test-solar-cache': mode });
    assert.equal(fallback.counts.sunCalc, 360, mode);
    assert.equal(fallback.counts.solarSerializations, 720, mode);
    assert.deepEqual(fallback.events.map(withoutStamp), base.events.map(withoutStamp), mode);
    assertCalendarLines(fallback.body);
  }
  const recovered = await cacheRequest();
  assert.equal(recovered.counts.sunCalc, 0);
  assert.deepEqual(recovered.events.map(withoutStamp), base.events.map(withoutStamp));
});

test('solar cache checksums reject tampered interiors, nested calendars and missing or wrong hashes', async () => {
  const base = await cacheRequest(endpoint, { 'x-test-solar-cache': 'reset' });
  for (const mode of ['tampered', 'broken-interior', 'nested', 'missing-hash', 'wrong-hash']) {
    const fallback = await cacheRequest(endpoint, { 'x-test-solar-cache': mode });
    assert.equal(fallback.counts.sunCalc, 360, mode);
    assert.equal(fallback.counts.solarSerializations, 720, mode);
    assert.deepEqual(fallback.events.map(withoutStamp), base.events.map(withoutStamp), mode);
    assert.equal((fallback.body.match(/BEGIN:VCALENDAR/g) || []).length, 1, mode);
    assert.equal((fallback.body.match(/END:VCALENDAR/g) || []).length, 1, mode);
  }
  const recovered = await cacheRequest();
  assert.equal(recovered.counts.sunCalc, 0);
  assert.equal(recovered.counts.solarSerializations, 0);
  assert.equal(recovered.response.headers.get('x-test-digest-calls'), '1');
});

test('checksum computation failures fall back to generation and do not prevent serving the feed', async () => {
  const base = await cacheRequest(endpoint, { 'x-test-solar-cache': 'reset' });
  for (const [mode, expectedDigestCalls] of [['use', '2'], ['reset', '1']]) {
    const fallback = await cacheRequest(endpoint, {
      'x-test-solar-cache': mode, 'x-test-hash-failure': 'true',
    });
    assert.equal(fallback.counts.sunCalc, 360, mode);
    assert.equal(fallback.counts.solarSerializations, 720, mode);
    assert.equal(fallback.response.headers.get('x-test-digest-calls'), expectedDigestCalls, mode);
    assert.equal(fallback.counts.solarWrites, 0, mode);
    assert.deepEqual(fallback.events.map(withoutStamp), base.events.map(withoutStamp), mode);
  }
});

test('legacy defaults, Number spellings and fractional offsets retain their numeric output', async () => {
  const zero = await namedCalendar('0');
  for (const spelling of [null, '', ' ', '-0', '0e3']) {
    const result = await namedCalendar(spelling);
    assert.deepEqual(eventsFrom(result.body).map(withoutStamp), eventsFrom(zero.body).map(withoutStamp));
    assert.equal(result.parsed.getFirstProperty('x-wr-timezone'), null);
  }
  for (const spelling of ['-6', '-6e0', ' -6 ']) {
    const { body } = await namedCalendar(spelling);
    const normalized = body.replace(/^DTSTAMP:[^\r\n]+/gm, 'DTSTAMP:IGNORED');
    assert.equal(createHash('sha256').update(normalized).digest('hex'), baseline.normalizedSha256);
  }
  const fractional = await namedCalendar('+5.75');
  const chart = plainChart(fractional.events.at(-1).description);
  assert.match(chart, /05pm /);
  assert.ok(!chart.includes('05:45'), 'numeric mode retains its legacy hour-only chart');
  assert.equal(fractional.parsed.getFirstProperty('x-wr-timezone'), null);
});

test('unsupported named spellings fail before forecast or solar cache access', async () => {
  for (const value of ['CST', 'PST', 'local', 'system', '+05:30', 'UTC+05:30',
    'America/Not_A_Zone', 'America/../Chicago', ' America/Chicago ', 'NaN', 'Infinity',
    'America/Chicago\r\nX-INJECTED:bad']) {
    const response = await mf.dispatchFetch(withTimezone(value));
    assert.equal(response.status, 400, value);
    assert.equal(await response.text(), 'Invalid tz', value);
    const counts = JSON.parse(response.headers.get('x-test-counts'));
    assert.equal(counts.uvReads, 0, value);
    assert.equal(counts.solarReads, 0, value);
  }
});

test('named Worker feeds contain one calendar, a property-position hint and exact legacy UTC instants', async () => {
  const legacy = await namedCalendar('-6');
  const named = await namedCalendar('America/Chicago');
  assert.equal(named.parsed.getFirstPropertyValue('x-wr-timezone'), 'America/Chicago');
  assert.ok(named.body.indexOf('X-WR-TIMEZONE:') < named.body.indexOf('BEGIN:VEVENT'));
  assert.equal((named.body.match(/BEGIN:VCALENDAR/g) || []).length, 1);
  assert.equal((named.body.match(/END:VCALENDAR/g) || []).length, 1);
  assert.equal(named.parsed.getAllSubcomponents('vtimezone').length, 0);
  assert.equal(named.events.length, 721);
  assert.equal(new Set(named.events.map(event => event.uid)).size, 721);
  assertCalendarLines(named.body);
  for (const [index, event] of named.events.entries()) {
    assert.equal(event.uid, legacy.events[index].uid);
    assert.equal(event.startDate.toUnixTime(), legacy.events[index].startDate.toUnixTime());
    assert.equal(event.endDate.toUnixTime(), legacy.events[index].endDate.toUnixTime());
    for (const propertyName of ['dtstart', 'dtend', 'dtstamp']) {
      const property = event.component.getFirstProperty(propertyName);
      assert.equal(property.getParameter('tzid'), undefined);
      assert.equal(property.getFirstValue().zone.tzid, 'UTC');
      assert.equal(property.getFirstValue().isDate, false);
    }
  }
  const winter = named.events.find(event => event.uid === 'sun-cal-sunrise-2027-01-15');
  const summer = named.events.find(event => event.uid === 'sun-cal-sunrise-2026-07-15');
  assert.match(winter.description, /America\/Chicago, UTC-06:00/);
  assert.match(summer.description, /America\/Chicago, UTC-05:00/);
});

test('named UV rows preserve both fold occurrences, spring gaps and half-hour transitions', async () => {
  for (const [zone, hours, expectedEnd, expectedRows] of [
    ['America/Chicago', ['2026-03-08T07:00:00Z', '2026-03-08T08:00:00Z'], '2026-03-08T09:00:00.000Z',
      ['01:00am (America/Chicago, UTC-06:00)', '03:00am (America/Chicago, UTC-05:00)']],
    ['America/Chicago', ['2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z'], '2026-11-01T08:00:00.000Z',
      ['01:00am (America/Chicago, UTC-05:00)', '01:00am (America/Chicago, UTC-06:00)']],
    ['Europe/Berlin', ['2026-03-29T00:00:00Z', '2026-03-29T01:00:00Z'], '2026-03-29T02:00:00.000Z',
      ['01:00am (Europe/Berlin, UTC+01:00)', '03:00am (Europe/Berlin, UTC+02:00)']],
    ['Europe/Berlin', ['2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z'], '2026-10-25T02:00:00.000Z',
      ['02:00am (Europe/Berlin, UTC+02:00)', '02:00am (Europe/Berlin, UTC+01:00)']],
    ['Australia/Lord_Howe', ['2026-04-04T14:00:00Z', '2026-04-04T15:00:00Z'], '2026-04-04T16:00:00.000Z',
      ['01:00am (Australia/Lord_Howe, UTC+11:00)', '01:30am (Australia/Lord_Howe, UTC+10:30)']],
  ]) {
    const forecastItems = hours.map(uv_time => ({ uv: 7, uv_time }));
    const { events } = await namedCalendar(zone, forecastItems, hours[0]);
    const event = events.at(-1);
    assert.equal(event.uid, 'sun-cal-peak-uv-' + hours[0].slice(0, 10));
    assert.equal(event.startDate.toJSDate().toISOString(), hours[0].replace('Z', '.000Z'));
    assert.equal(event.endDate.toJSDate().toISOString(), expectedEnd);
    const chart = plainChart(event.description);
    assert.equal(chart.split('\n').length, 2);
    for (const row of expectedRows) assert.ok(chart.includes(row), chart);
  }
});

test('fractional named zones retain UV minutes, encoded Etc offsets and viewer travel preserve instants', async () => {
  for (const [zone, time, expectedClock, offset] of [
    ['Asia/Kathmandu', '2026-10-16T12:00:00Z', '05:45pm', '+05:45'],
    ['Australia/Lord_Howe', '2026-07-16T12:00:00Z', '10:30pm', '+10:30'],
    ['Australia/Lord_Howe', '2026-12-16T12:00:00Z', '11:00pm', '+11:00'],
    ['Etc/GMT+5', '2026-10-16T12:00:00Z', '07:00am', '-05:00'],
  ]) {
    const result = await namedCalendar(zone, [{ uv: 7, uv_time: time }], time);
    const chart = plainChart(result.events.at(-1).description);
    assert.ok(chart.includes(expectedClock), chart);
    assert.ok(chart.includes('UTC' + offset), chart);
    assert.equal(result.events.at(-1).startDate.toJSDate().toISOString(), time.replace('Z', '.000Z'));
    assert.ok(result.parsed.getFirstPropertyValue('x-wr-timezone'));
  }
  assert.ok(withTimezone('Etc/GMT+5').includes('Etc%2FGMT%2B5'));
  const result = await namedCalendar('America/Chicago', [
    { uv: 7, uv_time: '2026-10-17T17:00:00Z' }, { uv: 7, uv_time: '2026-10-17T18:00:00Z' },
  ]);
  const start = DateTime.fromJSDate(result.events.at(-1).startDate.toJSDate());
  assert.equal(start.toUTC().toISO(), '2026-10-17T17:00:00.000Z');
  assert.equal(start.setZone('America/Chicago').hour, 12);
  assert.equal(start.setZone('America/Los_Angeles').hour, 10);
  assert.match(plainChart(result.events.at(-1).description), /12:00pm \(America\/Chicago, UTC-05:00\)/);
});

test('named cache modes, canonical aliases and daily keys preserve hits and fresh UV behavior', async () => {
  const chicago = withTimezone('America/Chicago');
  const base = await cacheRequest(chicago, { 'x-test-solar-cache': 'reset' });
  const key = new URL(base.key);
  assert.equal(key.pathname, '/solar/v2');
  assert.equal(key.searchParams.get('tzMode'), 'iana');
  assert.equal(key.searchParams.get('tz'), 'America/Chicago');
  for (const alias of ['US/Central', 'america/chicago']) {
    const hit = await cacheRequest(withTimezone(alias));
    assert.equal(hit.key, base.key);
    assert.equal(hit.counts.sunCalc, 0);
    assert.equal(hit.counts.solarSerializations, 0);
    assert.equal(hit.counts.calendarSerializations, 0);
    assert.equal(hit.counts.uvSerializations, 1);
    assert.deepEqual(hit.events.slice(0, 720), base.events.slice(0, 720));
  }
  for (const [url, headers, expectedCount] of [
    [chicago + '&min-uv=99', {}, 720],
    [chicago, { 'x-test-fixture': 'changed' }, 721],
    [chicago, { 'x-test-fixture': 'empty' }, 720],
  ]) {
    const hit = await cacheRequest(url, headers);
    assert.equal(hit.key, base.key);
    assert.equal(hit.counts.sunCalc, 0);
    assert.equal(hit.counts.uvReads, 1);
    assert.equal(hit.events.length, expectedCount);
    if (headers['x-test-fixture'] === 'changed') assert.notEqual(hit.events.at(-1).SUMMARY, base.events.at(-1).SUMMARY);
    assert.equal((hit.body.match(/X-WR-TIMEZONE:/g) || []).length, 1);
  }
  for (const value of ['America/New_York', '-5', '0', 'UTC']) {
    const other = await cacheRequest(withTimezone(value), { 'x-test-solar-cache': 'reset' });
    assert.notEqual(other.key, base.key);
    assert.equal(new URL(other.key).searchParams.get('tzMode'), Number.isFinite(Number(value)) ? 'fixed' : 'iana');
  }
  const utc = await cacheRequest(withTimezone('UTC'));
  for (const alias of ['utc', 'Etc/UTC']) {
    const hit = await cacheRequest(withTimezone(alias));
    assert.equal(hit.key, utc.key);
    assert.equal(hit.counts.sunCalc, 0);
  }
  const rollover = await cacheRequest(chicago, { 'x-test-now': '2026-10-17T00:00:00Z' });
  assert.notEqual(rollover.key, base.key);
  assertSolarWindow(rollover.events.slice(0, 720), '2026-04-20', '2027-04-14');
  assert.deepEqual(base.events.slice(2, 720).map(withoutStamp), rollover.events.slice(0, 718).map(withoutStamp));
});

test('v1 entries cannot satisfy v2 reads and named offsets stay ASCII under another numbering system', async () => {
  await cacheRequest(endpoint, { 'x-test-solar-cache': 'reset' });
  const miss = await cacheRequest(endpoint, { 'x-test-solar-cache': 'v1-only' });
  assert.equal(miss.response.headers.get('x-test-legacy-cache-present'), 'true');
  assert.equal(new URL(miss.key).pathname, '/solar/v2');
  assert.equal(miss.counts.sunCalc, 360);
  assert.equal(miss.counts.solarSerializations, 720);
  assert.equal((await cacheRequest()).counts.sunCalc, 0);
  const named = await cacheRequest(withTimezone('America/Chicago'), {
    'x-test-numbering-system': 'arab', 'x-test-solar-cache': 'reset',
  });
  const parsed = new ICAL.Component(ICAL.parse(named.body));
  const uv = new ICAL.Event(parsed.getAllSubcomponents('vevent').at(-1));
  assert.match(uv.description, /America\/Chicago, UTC-05:00/);
});
