import { DateTime } from "luxon";
import moment from "moment-timezone";
import { captureWorkerError } from "./sentry";
import { regionalTime, TIMEZONE_ASSET_VERSION, TIMEZONE_DATA_VERSION } from "./timezones";

export type DisplayTimezone =
  | { mode: "fixed"; offset: number }
  | { mode: "iana"; zone: string };

export type UvForecastItem = {
  uv: number;
  uv_time: string;
};

export type UvForecast = {
  forecast: UvForecastItem[];
  fetchedAt: string;
  localDate: string;
  stale: boolean;
};

export type LocalUvDay = {
  date: string;
  start: number;
  end: number;
};

const UV_CACHE_SCHEMA = "v1";
const UV_CACHE_SCHEMA_NUMBER = 1;
const UV_FRESH_MS = 30 * 60 * 1000;
const UV_REFRESH_BUDGET_MS = 3000;
const UV_ATTEMPT_TIMEOUT_MS = 1000;
const UV_MAX_ATTEMPTS = 2;
const UV_RETRY_DELAY_MS = 100;
const UV_BODY_LIMIT_BYTES = 128 * 1024;

type CachedForecast = {
  forecast: UvForecastItem[];
  fetchedAt: string;
  fetchedAtMs: number;
};

class RetryableUvError extends Error {}
class OversizedUvResponseError extends Error {}

export function localUvDay(now: number, timezone: DisplayTimezone): LocalUvDay {
  if (timezone.mode === "fixed") {
    const offsetMs = timezone.offset * 60 * 60 * 1000;
    const date = DateTime.fromMillis(now + offsetMs, { zone: "UTC" }).toISODate() as string;
    const start = DateTime.fromISO(date, { zone: "UTC" }).toMillis() - offsetMs;
    return { date, start, end: start + 24 * 60 * 60 * 1000 };
  }

  const local = regionalTime(now, timezone.zone);
  const date = local.format("YYYY-MM-DD");
  const nominalStart = DateTime.fromISO(date, { zone: "UTC" }).toMillis();
  const zone = moment.tz.zone(timezone.zone);
  if (!zone) throw new Error("Unknown pinned timezone");

  // Map this local date through each pinned constant-offset UTC interval.
  // Merge adjacent intervals across DST. Some historical midnight rollbacks
  // briefly enter tomorrow before returning to today, so select the current
  // contiguous interval rather than reusing data from before that boundary.
  const intervals: { start: number; end: number }[] = [];
  let previousEnd = -Infinity;
  for (let index = 0; index < zone.untils.length; index += 1) {
    const segmentEnd = zone.untils[index];
    const offsetMs = Math.round(zone.offsets[index] * 60_000); // Minutes west of UTC.
    const start = Math.max(previousEnd, nominalStart + offsetMs);
    const end = Math.min(segmentEnd, nominalStart + 86_400_000 + offsetMs);
    if (start < end) {
      const previous = intervals.at(-1);
      if (previous && previous.end === start) previous.end = end;
      else intervals.push({ start, end });
    }
    previousEnd = segmentEnd;
  }
  const interval = intervals.find(({ start, end }) => start <= now && now < end);
  if (!interval) throw new Error("Unable to determine pinned local day");
  return { date, ...interval };
}

export function localDayHttpMaxAge(now: number, timezone: DisplayTimezone): number {
  const day = localUvDay(now, timezone);
  return Math.max(0, Math.min(30 * 60, Math.floor((day.end - now) / 1000)));
}

export async function getUvForecast(
  latitude: number,
  longitude: number,
  height: number,
  timezone: DisplayTimezone,
  apiKey: string,
  ctx: ExecutionContext
): Promise<UvForecast | null> {
  const startedAt = DateTime.utc().toMillis();
  const deadline = startedAt + UV_REFRESH_BUDGET_MS;
  let day = localUvDay(startedAt, timezone);
  let cache: Cache | null = null;
  try {
    cache = caches.default;
  } catch {
    // The forecast can still be fetched when Cache API setup is unavailable.
  }

  let cached: CachedForecast | null = null;
  let cacheLoaded = false;
  let attempts = 0;

  while (attempts < UV_MAX_ATTEMPTS && DateTime.utc().toMillis() < deadline) {
    const beforeRead = DateTime.utc().toMillis();
    const beforeDay = localUvDay(beforeRead, timezone);
    if (beforeDay.date !== day.date) {
      day = beforeDay;
      cached = null;
      cacheLoaded = false;
    }

    if (!cacheLoaded) {
      cached = await readCachedForecast(cache, latitude, longitude, height, timezone, day);
      cacheLoaded = true;
      const afterRead = DateTime.utc().toMillis();
      const afterDay = localUvDay(afterRead, timezone);
      if (afterDay.date !== day.date) {
        day = afterDay;
        cached = null;
        cacheLoaded = false;
        continue;
      }
      if (cached && isFresh(cached, afterRead)) {
        return { forecast: cached.forecast, fetchedAt: cached.fetchedAt,
          localDate: day.date, stale: false };
      }
    }

    const beforeFetch = DateTime.utc().toMillis();
    const remaining = deadline - beforeFetch;
    if (remaining <= 0) break;

    attempts += 1;
    let forecast: unknown = null;
    let fetchError: unknown = null;
    try {
      forecast = await fetchUpstreamForecast(
        latitude, longitude, height, apiKey,
        Math.max(1, Math.min(UV_ATTEMPT_TIMEOUT_MS, remaining))
      );
    } catch (error) {
      fetchError = error;
    }

    const afterFetch = DateTime.utc().toMillis();
    const afterFetchDay = localUvDay(afterFetch, timezone);
    if (afterFetchDay.date !== day.date) {
      day = afterFetchDay;
      cached = await readCachedForecast(cache, latitude, longitude, height, timezone, day);
      cacheLoaded = true;
      const afterNewDayRead = DateTime.utc().toMillis();
      if (localUvDay(afterNewDayRead, timezone).date !== day.date) {
        day = localUvDay(afterNewDayRead, timezone);
        cached = null;
        cacheLoaded = false;
        continue;
      }
      if (cached && isFresh(cached, afterNewDayRead)) {
        return { forecast: cached.forecast, fetchedAt: cached.fetchedAt,
          localDate: day.date, stale: false };
      }

      // Do not store or serve a response that started on the prior local date.
      if (fetchError === null && attempts < UV_MAX_ATTEMPTS) continue;
      if (fetchError !== null && isRetryable(fetchError) && attempts < UV_MAX_ATTEMPTS) {
        await sleepWithinBudget(deadline);
        continue;
      }
      break;
    }

    if (fetchError !== null) {
      if (isRetryable(fetchError) && attempts < UV_MAX_ATTEMPTS) {
        await sleepWithinBudget(deadline);
        continue;
      }
      break;
    }

    const validForecast = validateForecast(forecast, day);
    if (!validForecast) break;

    const fetchedAt = new Date(afterFetch).toISOString();
    const key = uvCacheKey(latitude, longitude, height, timezone, day);
    await writeCachedForecast(cache, key, day, timezone, validForecast, fetchedAt, ctx);
    return { forecast: validForecast, fetchedAt, localDate: day.date, stale: false };
  }

  const finishedAt = DateTime.utc().toMillis();
  const finishedDay = localUvDay(finishedAt, timezone);
  if (finishedDay.date !== day.date) {
    day = finishedDay;
    cached = await readCachedForecast(cache, latitude, longitude, height, timezone, day);
    const afterRead = DateTime.utc().toMillis();
    if (localUvDay(afterRead, timezone).date !== day.date) return null;
    if (cached && isFresh(cached, afterRead)) {
      return { forecast: cached.forecast, fetchedAt: cached.fetchedAt,
        localDate: day.date, stale: false };
    }
  }

  if (cached && cached.fetchedAtMs <= finishedAt && day.date === finishedDay.date) {
    return { forecast: cached.forecast, fetchedAt: cached.fetchedAt,
      localDate: day.date, stale: true };
  }
  return null;
}

async function readCachedForecast(
  cache: Cache | null,
  latitude: number,
  longitude: number,
  height: number,
  timezone: DisplayTimezone,
  day: LocalUvDay
): Promise<CachedForecast | null> {
  if (!cache) return null;
  const key = uvCacheKey(latitude, longitude, height, timezone, day);
  try {
    const response = await cache.match(key);
    if (!response?.ok) return null;
    const text = await readLimitedText(response, UV_BODY_LIMIT_BYTES);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;
    const envelope = value as {
      schema?: unknown;
      localDate?: unknown;
      fetchedAt?: unknown;
      forecast?: unknown;
    };
    if (envelope.schema !== UV_CACHE_SCHEMA_NUMBER || envelope.localDate !== day.date ||
        typeof envelope.fetchedAt !== "string") return null;
    const fetchedAtMs = Date.parse(envelope.fetchedAt);
    if (!Number.isFinite(fetchedAtMs) || new Date(fetchedAtMs).toISOString() !== envelope.fetchedAt ||
        fetchedAtMs < day.start || fetchedAtMs >= day.end ||
        fetchedAtMs > DateTime.utc().toMillis()) return null;
    const forecast = validateForecast(envelope.forecast, day);
    if (!forecast) return null;
    return { forecast, fetchedAt: envelope.fetchedAt, fetchedAtMs };
  } catch {
    // A broken or unavailable cache is an ordinary miss for the feed.
    return null;
  }
}

function isFresh(cached: CachedForecast, now: number): boolean {
  const age = now - cached.fetchedAtMs;
  return age >= 0 && age < UV_FRESH_MS;
}

function uvCacheKey(
  latitude: number,
  longitude: number,
  height: number,
  timezone: DisplayTimezone,
  day: LocalUvDay
): Request {
  const url = new URL("https://cache.sun-cal/uv/" + UV_CACHE_SCHEMA);
  url.searchParams.set("day", day.date);
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lng", String(longitude));
  url.searchParams.set("alt", String(height));
  url.searchParams.set("tzMode", timezone.mode);
  url.searchParams.set("tz", timezone.mode === "fixed" ? String(timezone.offset) : timezone.zone);
  if (timezone.mode === "iana") {
    url.searchParams.set("tzData", TIMEZONE_DATA_VERSION);
    url.searchParams.set("tzAssets", TIMEZONE_ASSET_VERSION);
  }
  return new Request(url);
}

async function writeCachedForecast(
  cache: Cache | null,
  key: Request,
  day: LocalUvDay,
  timezone: DisplayTimezone,
  forecast: UvForecastItem[],
  fetchedAt: string,
  ctx: ExecutionContext
): Promise<void> {
  if (!cache) return;
  try {
    const now = DateTime.utc().toMillis();
    const currentDay = localUvDay(now, timezone);
    if (currentDay.date !== day.date) return;
    const ttl = Math.max(0, Math.floor((currentDay.end - now) / 1000));
    if (ttl === 0) return;
    const envelope = {
      schema: UV_CACHE_SCHEMA_NUMBER,
      localDate: day.date,
      fetchedAt,
      forecast,
    };
    const response = new Response(JSON.stringify(envelope), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "max-age=" + ttl,
      },
    });
    const pending = cache.put(key, response).catch((error) => {
      captureWorkerError(error, "uv_cache_write_failed");
    });
    ctx.waitUntil(pending);
  } catch (error) {
    // Cache setup and write failures do not change the feed response.
    captureWorkerError(error, "uv_cache_write_failed");
  }
}

async function fetchUpstreamForecast(
  latitude: number,
  longitude: number,
  height: number,
  apiKey: string,
  timeoutMs: number
): Promise<unknown> {
  const url = new URL("https://api.openuv.io/api/v1/forecast");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lng", String(longitude));
  url.searchParams.set("alt", String(height));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { "x-access-token": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RetryableUvError(error instanceof Error ? error.message : "UV transport failure");
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableUvError("openuv returned " + response.status);
    }
    throw new Error("openuv returned " + response.status);
  }

  let text: string;
  try {
    text = await readLimitedText(response, UV_BODY_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof OversizedUvResponseError) {
      throw new Error("openuv response exceeded the size limit");
    }
    throw new RetryableUvError(error instanceof Error ? error.message : "UV response read failure");
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Malformed openuv response JSON");
  }
  if (!json || typeof json !== "object" || !Array.isArray((json as { result?: unknown }).result)) {
    throw new Error("Unexpected openuv response");
  }
  return (json as { result: unknown }).result;
}

async function readLimitedText(response: Response, byteLimit: number): Promise<string> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > byteLimit) {
    await response.body?.cancel().catch(() => undefined);
    throw new OversizedUvResponseError("Response too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > byteLimit) {
      await reader.cancel().catch(() => undefined);
      throw new OversizedUvResponseError("Response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validateForecast(value: unknown, day: LocalUvDay): UvForecastItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const valid: UvForecastItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as { uv?: unknown; uv_time?: unknown };
    if (typeof candidate.uv !== "number" || !Number.isFinite(candidate.uv) || candidate.uv < 0 ||
        typeof candidate.uv_time !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(candidate.uv_time)) {
      return null;
    }
    const timestamp = DateTime.fromISO(candidate.uv_time, { setZone: true });
    if (!timestamp.isValid) return null;
    const instant = timestamp.toUTC().toMillis();
    if (instant >= day.start && instant < day.end) {
      valid.push({ uv: candidate.uv, uv_time: candidate.uv_time });
    }
  }
  return valid.length > 0 ? valid : null;
}

function isRetryable(error: unknown): boolean {
  return error instanceof RetryableUvError;
}

async function sleepWithinBudget(deadline: number): Promise<void> {
  const remaining = deadline - DateTime.utc().toMillis();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(UV_RETRY_DELAY_MS, remaining)));
  }
}
