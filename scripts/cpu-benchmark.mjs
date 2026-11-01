import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const baselineRoot = resolve(projectRoot, '../baseline-src');
const solarFixturePath = join(projectRoot, 'test/fixtures/cpu-solar-cache.json');
const nowIso = '2026-10-16T12:00:00.000Z';
const forecast = JSON.parse(await readFile(join(projectRoot, 'test/fixtures/uv-forecast.json'), 'utf8'));
const config = await readFile(join(projectRoot, 'wrangler.toml'), 'utf8');
const compatibilityDateMatch = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m);
const compatibilityFlagsMatch = config.match(/^compatibility_flags\s*=\s*(\[[^\n]+\])/m);
assert.ok(compatibilityDateMatch, 'wrangler.toml must set compatibility_date');
assert.ok(compatibilityFlagsMatch, 'wrangler.toml must set compatibility_flags');
const compatibilityDate = compatibilityDateMatch[1];
const compatibilityFlags = JSON.parse(compatibilityFlagsMatch[1]);

export const BENCHMARK_CASES = [
  { name: 'fixed-minus-6', tz: '-6', latitude: 30.48, longitude: -97.65, height: 800 },
  { name: 'America/Chicago', tz: 'America/Chicago', latitude: 41.88, longitude: -87.63, height: 600 },
  { name: 'Asia/Kathmandu', tz: 'Asia/Kathmandu', latitude: 27.7172, longitude: 85.324, height: 4500 },
  { name: 'Australia/Lord_Howe', tz: 'Australia/Lord_Howe', latitude: -31.55, longitude: 159.08, height: 30 },
];

function wrapperSource(baselineEntry, candidateEntry) {
  return `
import baselineWorker from ${JSON.stringify(baselineEntry)};
import candidateWorker from ${JSON.stringify(candidateEntry)};
import { Settings } from 'luxon';
Settings.defaultLocale = 'en-US';
Settings.defaultZone = 'UTC';

const FIXTURE = ${JSON.stringify(forecast)};
const BENCH_NOW = ${JSON.stringify(nowIso)};
const BENCH_LOCATIONS = ${JSON.stringify(Object.fromEntries(BENCHMARK_CASES.map(({ tz, latitude, longitude, height }) => [tz, { latitude, longitude, height }] )))};
const PRECOMPUTED_SOLAR = __BENCHMARK_SOLAR_FIXTURES__;
const BENCH_ENV = {
  OPENUV_API_KEY: 'SYNTHETIC_BENCHMARK_KEY',
  SENTRY_DSN: 'https://publictestkey@o1.ingest.sentry.io/42',
  SENTRY_RELEASE: '0123456789abcdef0123456789abcdef01234567',
};
const cacheEntries = new Map();
const sentryEnvelopes = [];
let stats = freshStats();
let activeUpstreamMode = 'success';
let activeCacheState = 'cold';
let clockMs = Date.parse(BENCH_NOW);
Settings.now = () => clockMs;
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clockMs])); }
  static now() { return clockMs; }
}
globalThis.Date = FrozenDate;

function freshStats() {
  return { cacheMatch: 0, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 0 };
}
function cacheKey(input) { return input instanceof Request ? input.url : String(input); }
const memoryCache = {
  async match(input) {
    stats.cacheMatch += 1;
    const key = cacheKey(input);
    const url = new URL(key);
    if (url.pathname.startsWith('/solar/')) {
      if (activeCacheState !== 'solar-hit' && activeCacheState !== 'stale-fallback') return undefined;
      const fixture = PRECOMPUTED_SOLAR[url.searchParams.get('tz')];
      if (!fixture) throw new Error('Missing embedded solar fixture for ' + url.searchParams.get('tz'));
      return new Response(fixture.body, { headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'max-age=86400',
        'X-Sun-Cal-Key': key,
        'X-Sun-Cal-SHA256': fixture.sha256,
      } });
    }
    if (url.pathname.startsWith('/uv/')) {
      if (!['solar-hit', 'uv-hit', 'stale-fallback'].includes(activeCacheState)) return undefined;
      const stale = activeCacheState === 'stale-fallback';
      return new Response(JSON.stringify({
        schema: 1,
        localDate: '2026-10-16',
        fetchedAt: new RealDate(clockMs - (stale ? 31 : 1) * 60_000).toISOString(),
        forecast: FIXTURE,
      }), { headers: { 'Cache-Control': 'max-age=86400' } });
    }
    return cacheEntries.get(key)?.clone();
  },
  async put(input, response) {
    stats.cachePut += 1;
    cacheEntries.set(cacheKey(input), response.clone());
  },
  async delete(input) {
    stats.cacheDelete += 1;
    return cacheEntries.delete(cacheKey(input));
  },
};
Object.defineProperty(globalThis, 'caches', {
  configurable: true,
  value: { default: memoryCache },
});

globalThis.fetch = async function(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'api.openuv.io') {
    stats.upstream += 1;
    if (activeUpstreamMode === 'failure') return new Response('', { status: 503 });
    return new Response(JSON.stringify({ result: FIXTURE }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.hostname === 'o1.ingest.sentry.io') {
    stats.sentry += 1;
    const body = typeof init.body === 'string' ? init.body
      : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body)
      : input instanceof Request ? await input.clone().text() : '';
    sentryEnvelopes.push({ url: url.href, body });
    return new Response('', { status: 200 });
  }
  throw new Error('Blocked unexpected fetch destination: ' + url.origin);
};

function bodyForCacheState(state) {
  if (state === 'cold') return cacheEntries.clear();
  if (state === 'uv-hit') {
    for (const key of cacheEntries.keys()) if (new URL(key).pathname.startsWith('/solar/')) cacheEntries.delete(key);
  }
}
function endpointFor(request, caseName) {
  const input = new URL(request.url);
  input.pathname = caseName === 'not-found' ? '/missing' : '/sun-cal.ics';
  input.searchParams.delete('__bench_case');
  input.searchParams.delete('__bench_state');
  const tz = request.headers.get('x-bench-tz') || '-6';
  const location = BENCH_LOCATIONS[tz] || BENCH_LOCATIONS['-6'];
  input.searchParams.set('latitude', String(location.latitude));
  input.searchParams.set('longitude', String(location.longitude));
  input.searchParams.set('height', String(location.height));
  input.searchParams.set('tz', tz);
  if (caseName === 'invalid-input') input.searchParams.set('latitude', 'nope');
  if (caseName === 'validation') input.search = '';
  return input;
}
async function invoke(worker, input, env, ctx) {
  const background = [];
  const context = { waitUntil(promise) {
    const pending = Promise.resolve(promise);
    background.push(pending);
    ctx.waitUntil(pending);
  } };
  const response = await worker.fetch(input, env, context);
  const body = await response.text();
  await Promise.all(background);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
export default {
  async fetch(request, env, ctx) {
    const caseName = request.headers.get('x-bench-case') || new URL(request.url).searchParams.get('__bench_case') || 'calendar';
    const state = request.headers.get('x-bench-cache-state') || new URL(request.url).searchParams.get('__bench_state') || 'cold';
    clockMs = Date.parse(request.headers.get('x-bench-now') || BENCH_NOW);
    Settings.now = () => clockMs;
    activeCacheState = state;
    activeUpstreamMode = state === 'stale-fallback' ? 'success' : 'success';
    sentryEnvelopes.length = 0;
    stats = freshStats();
    const input = endpointFor(request, caseName);
    if (state === 'stale-fallback') {
      activeUpstreamMode = 'failure';
    } else {
      bodyForCacheState(state);
    }
    const bindings = caseName === 'sentry-error'
      ? { SENTRY_DSN: BENCH_ENV.SENTRY_DSN, SENTRY_RELEASE: BENCH_ENV.SENTRY_RELEASE }
      : BENCH_ENV;
    const variant = request.headers.get('x-bench-variant') || new URL(request.url).searchParams.get('bench_variant');
    if (variant !== 'baseline' && variant !== 'candidate') throw new Error('x-bench-variant must be baseline or candidate');
    const worker = variant === 'baseline' ? baselineWorker : candidateWorker;
    const response = await invoke(worker, new Request(input, { method: 'GET' }), bindings, ctx);
    const body = await response.text();
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    wrapped.headers.set('x-bench-counts', JSON.stringify(stats));
    wrapped.headers.set('x-bench-sentry-envelopes', String(sentryEnvelopes.length));
    wrapped.headers.set('x-bench-cache-size', String(cacheEntries.size));
    return wrapped;
  },
};
`;
}

export async function buildBenchmarkBundle({ baselineDir = baselineRoot, candidateDir = projectRoot, outfile, minify = true } = {}) {
  const baselineSource = resolve(baselineDir);
  const candidateSource = resolve(candidateDir);
  const solarFixtures = await loadSolarFixtures();
  const contents = wrapperSource(
    join(baselineSource, 'src/index.ts'),
    join(candidateSource, 'src/index.ts'),
  ).replace('__BENCHMARK_SOLAR_FIXTURES__', JSON.stringify(solarFixtures));
  const result = await build({
    stdin: { contents, resolveDir: projectRoot, loader: 'ts', sourcefile: 'cpu-benchmark-wrapper.ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    nodePaths: [join(projectRoot, 'node_modules')],
    minify,
    sourcemap: false,
    write: false,
    logLevel: 'silent',
  });
  if (outfile) {
    const outputPath = resolve(outfile);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.outputFiles[0].text);
    return {
      outfile: outputPath,
      bundleSha256: createHash('sha256').update(result.outputFiles[0].text).digest('hex'),
      fixtureSha256: createHash('sha256').update(await readFile(solarFixturePath)).digest('hex'),
      sourceHashes: {
        baseline: await hashSourceTree(baselineSource),
        candidate: await hashSourceTree(candidateSource),
      },
    };
  }
  return result.outputFiles[0].text;
}

async function loadSolarFixtures() {
  const fixtures = JSON.parse(await readFile(solarFixturePath, 'utf8'));
  for (const testCase of BENCHMARK_CASES) {
    const fixture = fixtures[testCase.tz];
    assert.ok(fixture?.body && fixture?.sha256, `missing frozen solar fixture for ${testCase.name}`);
    assert.equal(createHash('sha256').update(fixture.body).digest('hex'), fixture.sha256);
    assert.equal(parseEvents(fixture.body).length, 720);
  }
  return fixtures;
}

async function hashSourceTree(root) {
  const src = join(root, 'src');
  const paths = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await walk(src);
  paths.sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path.slice(src.length + 1)).update('\0').update(await readFile(path)).update('\0');
  }
  return hash.digest('hex');
}

function parseEvents(body) {
  const unfolded = body.replace(/\r\n[ \t]/g, '');
  return [...unfolded.matchAll(/BEGIN:VEVENT\r\n([\s\S]*?)END:VEVENT/g)].map(([, block]) => {
    const fields = {};
    for (const line of block.trim().split('\r\n')) {
      const colon = line.indexOf(':');
      fields[line.slice(0, colon)] = line.slice(colon + 1);
    }
    return fields;
  });
}

function validateResponse(response, { caseName, expectUv = true }) {
  const expectedStatus = caseName === 'not-found' ? 404
    : ['invalid-input', 'validation'].includes(caseName) ? 400
    : caseName === 'sentry-error' ? 500 : 200;
  assert.equal(response.status, expectedStatus, 'unexpected benchmark response status');
  if (expectedStatus !== 200) return { eventCount: 0, uvEvents: 0, digest: null };
  const body = response.body;
  const events = parseEvents(body);
  const solar = events.filter(event => !event.UID?.includes('peak-uv'));
  const uv = events.filter(event => event.UID?.includes('peak-uv'));
  assert.equal(solar.length, 720, 'calendar must have 720 solar events');
  assert.equal(new Set(solar.map(event => event.UID)).size, 720, 'solar event IDs must be unique');
  assert.equal(uv.length, expectUv ? 1 : 0, 'UV event count must match the synthetic forecast');
  assert.ok(events.every(event => {
    const start = Object.entries(event).find(([name]) => name.startsWith('DTSTART'))?.[1];
    const end = Object.entries(event).find(([name]) => name.startsWith('DTEND'))?.[1];
    return /^\d{8}T\d{6}Z?$/.test(start ?? '') && /^\d{8}T\d{6}Z?$/.test(end ?? '');
  }), 'event starts and ends must use valid iCalendar date-time values');
  const normalized = body.replace(/^DTSTAMP:[^\r\n]+/gm, 'DTSTAMP:IGNORED');
  return {
    eventCount: events.length,
    solarEvents: solar.length,
    uvEvents: uv.length,
    digest: createHash('sha256').update(normalized).digest('hex'),
  };
}

export async function createRunner(bundle, label) {
  let outboundSentryRequests = 0;
  const mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate,
    compatibilityFlags,
    cf: false,
    logLevel: 'ERROR',
    inspectorPort: 0,
    bindings: {
      OPENUV_API_KEY: 'SYNTHETIC_BENCHMARK_KEY',
      SENTRY_DSN: 'https://publictestkey@o1.ingest.sentry.io/42',
      SENTRY_RELEASE: '0123456789abcdef0123456789abcdef01234567',
    },
    outboundService(request) {
      const url = new URL(request.url);
      if (url.hostname === 'o1.ingest.sentry.io') {
        outboundSentryRequests += 1;
        return new Response('', { status: 200 });
      }
      throw new Error('Blocked Miniflare outbound request from ' + label + ': ' + request.url);
    },
  });
  await mf.ready;
  return { mf, label, get outboundSentryRequests() { return outboundSentryRequests; } };
}

export async function requestCalendar(runner, testCase, state, caseName = 'calendar', variant = 'baseline', round = 0, measured = true) {
  const url = new URL('http://sun-cal.invalid/sun-cal.ics');
  url.searchParams.set('__bench_case', caseName);
  url.searchParams.set('__bench_state', state);
  url.searchParams.set('bench_variant', variant);
  const started = performance.now();
  const sentryBefore = runner.outboundSentryRequests;
  const response = await runner.mf.dispatchFetch(url.href, {
    headers: { 'x-bench-case': caseName, 'x-bench-cache-state': state, 'x-bench-tz': testCase?.tz ?? '-6', 'x-bench-variant': variant },
  });
  const body = await response.text();
  const elapsedMs = performance.now() - started;
  const result = validateResponse({ status: response.status, body }, { caseName });
  const counts = JSON.parse(response.headers.get('x-bench-counts') || '{}');
  const sentryEnvelopes = Number(response.headers.get('x-bench-sentry-envelopes') || 0) +
    runner.outboundSentryRequests - sentryBefore;
  assert.equal(runner.outboundSentryRequests - sentryBefore, 0, 'synthetic Sentry fetch must stay inside the wrapper');
  if (caseName === 'sentry-error') assert.equal(sentryEnvelopes, 1);
  const expectedCounts = caseName !== 'calendar' ? {
    'not-found': { cacheMatch: 0, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 0 },
    validation: { cacheMatch: 0, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 0 },
    'invalid-input': { cacheMatch: 0, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 0 },
    'sentry-error': { cacheMatch: 0, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 1 },
  }[caseName] : {
    cold: { cacheMatch: 2, cachePut: 2, cacheDelete: 0, upstream: 1, sentry: 0 },
    'uv-hit': { cacheMatch: 2, cachePut: 1, cacheDelete: 0, upstream: 0, sentry: 0 },
    'solar-hit': { cacheMatch: 2, cachePut: 0, cacheDelete: 0, upstream: 0, sentry: 0 },
    'stale-fallback': { cacheMatch: 2, cachePut: 0, cacheDelete: 0, upstream: 2, sentry: 0 },
  }[state];
  for (const [name, value] of Object.entries(expectedCounts)) assert.equal(counts[name], value, `${caseName}/${state}/${variant} expected ${name}=${value}`);
  return {
    variant,
    case: testCase?.name ?? caseName,
    cacheState: state,
    round,
    measured,
    status: response.status,
    elapsedMs,
    timing: 'local Miniflare request wall time; proxy for Worker CPU, not billed CPU time',
    ...result,
    counts,
    sentryEnvelopes,
  };
}

export async function runBenchmark({ baselineDir = baselineRoot, candidateDir = projectRoot, runs = 5, warmup = 1, states = ['cold', 'solar-hit', 'uv-hit', 'stale-fallback'], includeErrors = true } = {}) {
  const bundle = await buildBenchmarkBundle({ baselineDir, candidateDir });
  const runner = await createRunner(bundle, 'paired');
  const variants = ['baseline', 'candidate'];
  const measurements = [];
  try {
    for (const testCase of BENCHMARK_CASES) {
      for (const variant of variants) {
        for (let index = 0; index < warmup; index += 1) {
          measurements.push(await requestCalendar(runner, testCase, 'solar-hit', 'calendar', variant, 0, false));
        }
      }
      for (const state of states) {
        for (let round = 0; round < runs; round += 1) {
          const order = round % 2 === 0 ? variants : [...variants].reverse();
          for (const variant of order) {
            measurements.push(await requestCalendar(runner, testCase, state, 'calendar', variant, round + 1));
          }
        }
      }
    }
    if (includeErrors) {
      const validationCases = [
        { name: 'not-found', status: 404 },
        { name: 'validation', status: 400 },
        { name: 'invalid-input', status: 400 },
        { name: 'sentry-error', status: 500 },
      ];
      for (const check of validationCases) {
        for (let round = 0; round < runs; round += 1) {
          const order = round % 2 === 0 ? variants : [...variants].reverse();
          for (const variant of order) measurements.push(await requestCalendar(runner, null, 'cold', check.name, variant, round + 1));
        }
      }
    }
  } finally {
    await runner.mf.dispose();
  }
  const paired = new Map();
  for (const row of measurements.filter(item => item.digest)) {
    const key = `${row.case}/${row.cacheState}`;
    const values = paired.get(key) ?? {};
    values[row.variant] = row.digest;
    paired.set(key, values);
  }
  for (const [key, values] of paired) assert.equal(values.baseline, values.candidate, `paired calendar digest differs for ${key}`);
  return {
    createdAt: new Date().toISOString(),
    clock: nowIso,
    runs,
    warmup,
    sources: { baseline: resolve(baselineDir), candidate: resolve(candidateDir) },
    methodology: 'Both handlers run in one Miniflare Worker. Requests select a variant by header and alternate order. Times include local Miniflare dispatch and body transfer. They are a local wall-time proxy for Worker CPU and are not Cloudflare billed CPU measurements.',
    digestPairs: Object.fromEntries(paired),
    measurements,
  };
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

async function main() {
  const [mode = 'run'] = process.argv.slice(2).filter(value => !value.startsWith('--'));
  if (mode === 'build') {
    const baselineDir = resolve(argValue('--baseline', baselineRoot));
    const candidateDir = resolve(argValue('--candidate', projectRoot));
    const outfile = resolve(argValue('--out', join(projectRoot, '.wrangler/cpu-benchmark-paired.js')));
    const result = await buildBenchmarkBundle({ baselineDir, candidateDir, outfile });
    const manifestPath = `${outfile}.manifest.json`;
    const manifest = {
      schema: 1,
      baselineDir,
      candidateDir,
      ...result,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ...manifest, manifestPath }) + '\n');
    return;
  }
  const options = {
    baselineDir: resolve(argValue('--baseline', baselineRoot)),
    candidateDir: resolve(argValue('--candidate', projectRoot)),
    runs: Number(argValue('--runs', '5')),
    warmup: Number(argValue('--warmup', '1')),
  };
  assert.ok(Number.isInteger(options.runs) && options.runs >= 1 && options.runs <= 100, '--runs must be 1..100');
  assert.ok(Number.isInteger(options.warmup) && options.warmup >= 0 && options.warmup <= 20, '--warmup must be 0..20');
  const result = await runBenchmark(options);
  const outPath = argValue('--out', null);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (outPath) {
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(resolve(outPath), json);
    process.stdout.write(JSON.stringify({ out: resolve(outPath), requests: result.measurements.length }) + '\n');
  } else process.stdout.write(json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
