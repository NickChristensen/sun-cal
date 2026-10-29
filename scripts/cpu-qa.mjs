import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const QA_URLS = {
  baseline: 'https://sun-cal-cpu-qa-a-01a188c4.nickchristensen.workers.dev',
  candidate: 'https://sun-cal-cpu-qa-b-01a188c4.nickchristensen.workers.dev',
};
const FIXED_NOW = '2026-10-16T12:00:00.000Z';
const CALENDAR_CASES = [
  { name: 'fixed-minus-6', tz: '-6', latitude: 30.48, longitude: -97.65, height: 800 },
  { name: 'America/Chicago', tz: 'America/Chicago', latitude: 41.88, longitude: -87.63, height: 600 },
  { name: 'Asia/Kathmandu', tz: 'Asia/Kathmandu', latitude: 27.7172, longitude: 85.324, height: 4500 },
  { name: 'Australia/Lord_Howe', tz: 'Australia/Lord_Howe', latitude: -31.55, longitude: 159.08, height: 30 },
];
const CACHE_STATES = ['cold', 'uv-hit', 'solar-hit', 'stale-fallback'];
const ERROR_CASES = ['not-found', 'validation', 'sentry-error'];
const MAX_REQUESTS = 400;
const REQUEST_TIMEOUT_MS = 15_000;
const EXPECTED_COUNTS = {
  cold: { cacheMatch: 2, cachePut: 2, cacheDelete: 0, upstream: 1, sentry: 0 },
  'uv-hit': { cacheMatch: 2, cachePut: 1, cacheDelete: 0, upstream: 0, sentry: 0 },
  'solar-hit': { cacheMatch: 2, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 0 },
  'stale-fallback': { cacheMatch: 2, cachePut: 0, cacheDelete: 0, upstream: 2, sentry: 0 },
  'not-found': { cacheMatch: 0, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 0 },
  validation: { cacheMatch: 0, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 0 },
  'sentry-error': { cacheMatch: 0, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 1 },
};

const scriptPath = fileURLToPath(import.meta.url);

function expectedStatus(caseName) {
  if (caseName === 'not-found') return 404;
  if (caseName === 'validation') return 400;
  if (caseName === 'sentry-error') return 500;
  return 200;
}

function parseCalendarEvents(body) {
  const unfolded = body.replace(/\r\n[ \t]/g, '');
  return [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/g)].map(([, block]) => {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 1);
    }
    return fields;
  });
}

function digestBody(body) {
  const normalized = body.replace(/^DTSTAMP(?:;[^:]*)?:[^\r\n]+/gm, line => `${line.slice(0, line.indexOf(':') + 1)}IGNORED`);
  return createHash('sha256').update(normalized).digest('hex');
}

function validateCalendar(body, { caseName, cacheState }) {
  if (expectedStatus(caseName) !== 200) return { eventCount: 0, solarEvents: 0, uvEvents: 0 };
  const events = parseCalendarEvents(body);
  const uvEvents = events.filter(event => event.UID?.includes('peak-uv'));
  const solarEvents = events.filter(event => !event.UID?.includes('peak-uv'));
  assert.equal(solarEvents.length, 720, `${caseName}/${cacheState} must have 720 solar events`);
  assert.equal(new Set(solarEvents.map(event => event.UID)).size, 720, `${caseName}/${cacheState} solar IDs must be unique`);
  assert.equal(uvEvents.length, 1, `${caseName}/${cacheState} must have one UV event`);
  if (cacheState === 'stale-fallback') {
    assert.ok(uvEvents[0].DESCRIPTION?.startsWith('Earlier forecast'), 'stale-fallback UV description must start with Earlier forecast');
  }
  return { eventCount: events.length, solarEvents: solarEvents.length, uvEvents: uvEvents.length };
}

function validateResponseContent(response, body, { caseName, cacheState }) {
  if (expectedStatus(caseName) === 200) {
    assert.equal(response.headers.get('content-type'), 'text/calendar; charset=utf-8', `${caseName}/${cacheState} must return a calendar content type`);
    assert.equal(response.headers.get('cache-control'), 'max-age=1800', `${caseName}/${cacheState} must return max-age=1800`);
    return;
  }
  const expectedBody = {
    'not-found': 'Not found',
    validation: 'Missing required query params: latitude, longitude, height',
    'sentry-error': 'Server misconfigured',
  }[caseName];
  assert.equal(body, expectedBody, `${caseName} returned an unexpected error body`);
}

function parseCounts(response, { caseName, cacheState }) {
  const rawCounts = response.headers.get('x-bench-counts');
  assert.ok(rawCounts, `${caseName}/${cacheState} is missing x-bench-counts`);
  let counts;
  try {
    counts = JSON.parse(rawCounts);
  } catch (error) {
    throw new Error(`${caseName}/${cacheState} has invalid x-bench-counts: ${error.message}`);
  }
  assert.ok(counts && typeof counts === 'object' && !Array.isArray(counts), `${caseName}/${cacheState} has invalid operation counters`);
  const expected = EXPECTED_COUNTS[caseName === 'calendar' ? cacheState : caseName];
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(counts[name], value, `${caseName}/${cacheState} expected ${name}=${value}, got ${counts[name]}`);
  }
  return counts;
}

function parseIntegerHeader(response, name, fallback) {
  const value = response.headers.get(name);
  if (value === null) return fallback;
  const number = Number(value);
  assert.ok(Number.isInteger(number) && number >= 0, `invalid ${name} header`);
  return number;
}

async function requestQa({ source, scenario, round, measured, benchRun, nextBenchId, requestCount }) {
  assert.ok(requestCount.value < MAX_REQUESTS, `request limit exceeded (${MAX_REQUESTS})`);
  const caseName = scenario.caseName;
  const cacheState = scenario.cacheState;
  const caseType = caseName === 'calendar' ? 'calendar' : caseName;
  const timezone = scenario.tz ?? '-6';
  const latitude = scenario.latitude ?? 30.48;
  const longitude = scenario.longitude ?? -97.65;
  const height = scenario.height ?? 800;
  const benchId = `${benchRun}-${String(nextBenchId.value++).padStart(4, '0')}`;
  const url = new URL('/sun-cal.ics', QA_URLS[source]);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('height', String(height));
  url.searchParams.set('tz', timezone);
  url.searchParams.set('__bench_case', caseType);
  url.searchParams.set('__bench_state', cacheState);
  url.searchParams.set('bench_run', benchRun);
  url.searchParams.set('bench_id', benchId);
  if (caseName === 'validation') url.search = `?__bench_case=validation&__bench_state=${encodeURIComponent(cacheState)}&bench_run=${encodeURIComponent(benchRun)}&bench_id=${encodeURIComponent(benchId)}`;

  const controller = new AbortController();
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(new Error(`QA request exceeded ${REQUEST_TIMEOUT_MS} ms`)), REQUEST_TIMEOUT_MS);
  requestCount.value += 1;
  let response;
  let body;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-bench-case': caseType,
        'x-bench-cache-state': cacheState,
        'x-bench-tz': timezone,
        'x-bench-now': FIXED_NOW,
      },
      signal: controller.signal,
    });
    body = await response.text();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${source} ${benchId} timed out after ${REQUEST_TIMEOUT_MS} ms`);
    throw new Error(`${source} ${benchId} failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const httpWallMs = performance.now() - startedAt;
  assert.equal(response.status, expectedStatus(caseName), `${source} ${benchId} returned an unexpected status`);
  validateResponseContent(response, body, { caseName, cacheState });
  const counts = parseCounts(response, { caseName: caseType, cacheState });
  const sentryEnvelopes = parseIntegerHeader(response, 'x-bench-sentry-envelopes', counts.sentry);
  assert.equal(sentryEnvelopes, caseName === 'sentry-error' ? 1 : 0, `${caseName}/${cacheState} has an unexpected Sentry envelope count`);
  if (caseName === 'sentry-error') assert.equal(counts.sentry, 1, 'sentry-error must capture one Sentry event');

  const cfRay = response.headers.get('cf-ray');
  assert.ok(cfRay, `${source} ${benchId} is missing the Cloudflare cf-ray response header`);
  const calendar = validateCalendar(body, { caseName, cacheState });
  return {
    benchRun,
    benchId,
    source,
    case: scenario.displayCase,
    tz: timezone,
    latitude,
    longitude,
    height,
    cacheState,
    round,
    measured,
    status: response.status,
    cfRay,
    httpWallMs,
    timing: 'HTTP wall time from the local driver; not Cloudflare CPU time',
    digest: digestBody(body),
    ...calendar,
    counts,
    sentryEnvelopes,
  };
}

function comparePair(rows, description) {
  if (rows.length !== 2) return;
  assert.equal(rows[0].source === 'baseline' ? rows[0].digest : rows[1].digest,
    rows[0].source === 'candidate' ? rows[0].digest : rows[1].digest,
    `A/B response digest differs for ${description}`);
}

function summarize(values) {
  if (values.length === 0) return { n: 0, min: null, p50: null, p95: null, max: null, range: null, over10: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = p => {
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const fraction = position - lower;
    const value = sorted[lower] + ((sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction);
    return Number(value.toFixed(3));
  };
  return {
    n: sorted.length,
    min: Number(sorted[0].toFixed(3)),
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: Number(sorted.at(-1).toFixed(3)),
    range: Number((sorted.at(-1) - sorted[0]).toFixed(3)),
    over10: sorted.filter(value => value > 10).length,
  };
}

function groupedSummary(rows, property) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.measured || !Number.isFinite(row[property])) continue;
    const key = `${row.source}/${row.case}/${row.cacheState}`;
    const values = groups.get(key) ?? [];
    values.push(row[property]);
    groups.set(key, values);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, summarize(values)]));
}

function parseJsonObjects(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Wrangler tail can print multiple pretty JSON objects without separators.
  }

  const objects = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (depth === 0) {
      if (character !== '{') continue;
      start = index;
      depth = 1;
      quoted = false;
      escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        objects.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  assert.equal(depth, 0, 'unterminated JSON object in CPU event file');
  return objects;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function eventRequest(raw) {
  return asRecord(asRecord(asRecord(raw).event).request);
}

function eventBenchIds(raw) {
  const request = eventRequest(raw);
  assert.equal(typeof request.url, 'string', 'Wrangler CPU event is missing event.request.url');
  const url = new URL(request.url);
  return {
    benchRun: url.searchParams.get('bench_run') ?? undefined,
    benchId: url.searchParams.get('bench_id') ?? undefined,
  };
}

function eventRay(raw) {
  const request = eventRequest(raw);
  const ray = asRecord(request.headers)['cf-ray'];
  return typeof ray === 'string' ? ray.split('-')[0] : undefined;
}

function eventCpuMs(raw) {
  const value = asRecord(raw).cpuTime;
  if (value === undefined || value === null) return undefined;
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Wrangler cpuTime must be a non-negative number');
  return value;
}

function eventWallMs(raw) {
  const value = asRecord(raw).wallTime;
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Wrangler wallTime must be a non-negative number');
  return value;
}

export function summarizeCpuEvents(input, measurements) {
  const rawEvents = Array.isArray(input) ? input : parseJsonObjects(String(input));
  const byBenchId = new Map(measurements.map(row => [row.benchId, row]));
  const byRay = new Map(measurements.filter(row => row.cfRay).map(row => [row.cfRay.split('-')[0], row]));
  const normalizedEvents = [];
  const eventCounts = new Map();
  let unmatchedEvents = 0;
  for (const raw of rawEvents) {
    const { benchRun, benchId } = eventBenchIds(raw);
    const ray = eventRay(raw);
    const row = (benchId ? byBenchId.get(benchId) : undefined) ?? (ray ? byRay.get(ray) : undefined);
    if (!row) {
      unmatchedEvents += 1;
      continue;
    }
    if (benchId) assert.equal(benchId, row.benchId, 'Wrangler event bench_id does not match its cf-ray request');
    if (benchRun) assert.equal(benchRun, row.benchRun, 'Wrangler event bench_run does not match its request');
    if (ray) assert.equal(ray, row.cfRay.split('-')[0], 'Wrangler event cf-ray does not match its bench_id request');
    const count = (eventCounts.get(row.benchId) ?? 0) + 1;
    assert.equal(count, 1, `duplicate Wrangler CPU events for bench_id ${row.benchId}`);
    eventCounts.set(row.benchId, count);
    const cpuMs = eventCpuMs(raw);
    const outer = asRecord(raw);
    const event = asRecord(outer.event);
    const response = asRecord(event.response);
    const scriptVersion = asRecord(outer.scriptVersion);
    normalizedEvents.push({
      benchRun,
      benchId: row.benchId,
      cfRay: row.cfRay,
      source: row.source,
      case: row.case,
      cacheState: row.cacheState,
      measured: row.measured,
      wallMs: eventWallMs(raw),
      ...(cpuMs === undefined ? {} : { cpuMs }),
      ...(typeof outer.outcome === 'string' ? { outcome: outer.outcome } : {}),
      ...(typeof outer.scriptName === 'string' ? { scriptName: outer.scriptName } : {}),
      ...(typeof scriptVersion.id === 'string' ? { scriptVersionId: scriptVersion.id } : {}),
      ...(typeof outer.eventTimestamp === 'number' || typeof outer.eventTimestamp === 'string'
        ? { eventTimestamp: outer.eventTimestamp }
        : {}),
      responseStatus: response.status,
    });
    assert.equal(response.status, row.status, `Wrangler response status does not match bench_id ${row.benchId}`);
  }
  const measuredRows = measurements.filter(row => row.measured);
  const unmatchedRequests = measuredRows.filter(row => !eventCounts.has(row.benchId));
  assert.equal(unmatchedRequests.length, 0,
    `missing Wrangler CPU events for measured bench_ids: ${unmatchedRequests.map(row => row.benchId).join(', ')}`);
  const measuredEvents = normalizedEvents.filter(event => event.measured);
  const cpuRows = measuredEvents.filter(event => Number.isFinite(event.cpuMs));
  return {
    events: normalizedEvents,
    summary: groupedSummary(cpuRows, 'cpuMs'),
    wallSummary: groupedSummary(measuredEvents, 'wallMs'),
    join: {
      eventMatchedRequests: measuredRows.length,
      cpuMatchedRequests: cpuRows.length,
      missingCpuRequests: measuredRows.length - cpuRows.length,
      unmatchedRequests: unmatchedRequests.length,
      unmatchedEvents,
    },
  };
}

export async function runQaBenchmark({ only, rounds = 5, runId = 'cpu-qa', cpuEventsPath } = {}) {
  assert.ok(Number.isInteger(rounds) && rounds >= 1, '--rounds must be a positive integer');
  assert.ok(only === undefined || ['baseline', 'candidate'].includes(only), '--only must be baseline or candidate');
  const sources = only ? [only] : ['baseline', 'candidate'];
  const plannedRequests = sources.length * (CALENDAR_CASES.length * CACHE_STATES.length * (rounds + 1) + ERROR_CASES.length * rounds);
  assert.ok(plannedRequests <= MAX_REQUESTS, `planned ${plannedRequests} requests; maximum is ${MAX_REQUESTS}`);
  const runLabel = String(runId).trim();
  assert.ok(runLabel.length > 0 && runLabel.length <= 120, '--run-id must contain 1 to 120 characters');
  const benchRun = `${runLabel}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const measurements = [];
  const requestCount = { value: 0 };
  const nextBenchId = { value: 1 };

  for (const testCase of CALENDAR_CASES) {
    for (const cacheState of CACHE_STATES) {
      const scenario = { caseName: 'calendar', displayCase: testCase.name, tz: testCase.tz, cacheState };
      const warmups = [];
      for (const source of sources) {
        warmups.push(await requestQa({ source, scenario, round: 0, measured: false, benchRun, nextBenchId, requestCount }));
      }
      comparePair(warmups, `${testCase.name}/${cacheState}/warmup`);
      measurements.push(...warmups);

      for (let round = 1; round <= rounds; round += 1) {
        const order = sources.length === 2 && round % 2 === 0 ? [...sources].reverse() : sources;
        const pair = [];
        for (const source of order) {
          pair.push(await requestQa({ source, scenario, round, measured: true, benchRun, nextBenchId, requestCount }));
        }
        comparePair(pair, `${testCase.name}/${cacheState}/round-${round}`);
        measurements.push(...pair);
      }
    }
  }

  for (const caseName of ERROR_CASES) {
    const scenario = { caseName, displayCase: caseName, tz: '-6', cacheState: 'cold' };
    for (let round = 1; round <= rounds; round += 1) {
      const order = sources.length === 2 && round % 2 === 0 ? [...sources].reverse() : sources;
      const pair = [];
      for (const source of order) {
        pair.push(await requestQa({ source, scenario, round, measured: true, benchRun, nextBenchId, requestCount }));
      }
      comparePair(pair, `${caseName}/round-${round}`);
      measurements.push(...pair);
    }
  }

  const output = {
    createdAt: new Date().toISOString(),
    runLabel,
    benchRun,
    frozenNow: FIXED_NOW,
    rounds,
    warmupsPerCalendarScenario: 1,
    requests: requestCount.value,
    sources: Object.fromEntries(sources.map(source => [source, QA_URLS[source]])),
    methodology: 'Sequential requests with alternating A/B order by measured round. HTTP wall time includes network and body transfer. It is not Cloudflare CPU time.',
    summary: { httpWallMs: groupedSummary(measurements, 'httpWallMs') },
    measurements,
  };
  if (cpuEventsPath) {
    const parsedEvents = parseJsonObjects(await readFile(resolve(cpuEventsPath), 'utf8'));
    const cpu = summarizeCpuEvents(parsedEvents, measurements);
    output.summary.cpuMs = cpu.summary;
    output.summary.wallMs = cpu.wallSummary;
    output.cpuEventJoin = cpu.join;
    output.cpuEvents = cpu.events;
  }
  return output;
}

function readArgs(argv) {
  const options = {};
  const names = new Map([
    ['--only', 'only'],
    ['--rounds', 'rounds'],
    ['--out', 'out'],
    ['--run-id', 'runId'],
    ['--cpu-events', 'cpuEventsPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split('=', 2);
    const key = names.get(name);
    assert.ok(key, `unknown argument: ${name}`);
    const value = inlineValue ?? argv[++index];
    assert.ok(value !== undefined && !value.startsWith('--'), `${name} requires a value`);
    options[key] = value;
  }
  if (options.rounds !== undefined) options.rounds = Number(options.rounds);
  return options;
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const outPath = options.out ? resolve(options.out) : undefined;
  const result = await runQaBenchmark(options);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, json);
    process.stdout.write(JSON.stringify({ out: outPath, requests: result.requests, benchRun: result.benchRun }) + '\n');
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
