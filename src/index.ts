import ical, { foldLines } from "ical-generator";
import { DateTime, FixedOffsetZone } from "luxon";
import SunCalc from "suncalc";
import { captureWorkerError, isSentryDsn, withSentry, type SentryEnv } from "./sentry";
import { canonicalTimezone, namedEventDates, regionalOffsetMinutesEast,
  requireTimezoneCoverage, timezoneComponent, TIMEZONE_ASSET_VERSION, TIMEZONE_DATA_VERSION } from "./timezones";
import { getUvForecast, localDayHttpMaxAge, localUvDay, type DisplayTimezone,
  type UvForecastItem } from "./uv";

interface Env extends SentryEnv {
  OPENUV_API_KEY: string;
}

type UvHour = {
  uv: number;
  hour: DateTime;
};

const UV_CACHE_TTL_SECONDS = 60 * 30;
// Bump this namespace when solar calculation, window, or serialization changes.
const SOLAR_CACHE_VERSION = "v5";
const SOLAR_CACHE_TTL_SECONDS = 60 * 60 * 24;
const CALENDAR_END = "END:VCALENDAR";

const FIXED_WIDTH_CHARS: Record<string, string> = {
  0: "𝟬",
  1: "𝟭",
  2: "𝟮",
  3: "𝟯",
  4: "𝟰",
  5: "𝟱",
  6: "𝟲",
  7: "𝟳",
  8: "𝟴",
  9: "𝟵",
  A: "𝖺",
  P: "𝗉",
  M: "𝗆",
};

const workerHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/sun-cal.ics") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!env.OPENUV_API_KEY) {
      captureWorkerError(new Error("Worker configuration is missing"), "worker_configuration_error");
      return new Response("Server misconfigured", { status: 500 });
    }

    const latitudeParam = url.searchParams.get("latitude");
    const longitudeParam = url.searchParams.get("longitude");
    const heightParam = url.searchParams.get("height");
    const minUvParam = url.searchParams.get("min-uv");
    const tzParam = url.searchParams.get("tz");

    const missingParams = [
      ["latitude", latitudeParam],
      ["longitude", longitudeParam],
      ["height", heightParam],
    ]
      .filter(([, value]) => value === null || value === "")
      .map(([name]) => name);

    if (missingParams.length > 0) {
      return new Response(
        `Missing required query params: ${missingParams.join(", ")}`,
        { status: 400 }
      );
    }

    const latitude = Number(latitudeParam);
    const longitude = Number(longitudeParam);
    const height = Number(heightParam);
    const minUv = minUvParam === null || minUvParam === "" ? 1 : Number(minUvParam);
    const timezone = parseDisplayTimezone(tzParam);

    if (!Number.isFinite(latitude)) {
      return new Response("Invalid latitude", { status: 400 });
    }

    if (!Number.isFinite(longitude)) {
      return new Response("Invalid longitude", { status: 400 });
    }

    if (!Number.isFinite(height) || !Number.isInteger(height)) {
      return new Response("Invalid height", { status: 400 });
    }

    if (!Number.isFinite(minUv) || !Number.isInteger(minUv) || minUv < 0) {
      return new Response("Invalid min-uv", { status: 400 });
    }

    if (!timezone) {
      return new Response("Invalid tz", { status: 400 });
    }

    try {
      // Keep the window tied to one UTC day, even if the UV request crosses midnight.
      const calendarDay = DateTime.utc().startOf("day");
      if (timezone.mode === "iana") {
        requireTimezoneCoverage(calendarDay.minus({ days: 180 }).toMillis());
        requireTimezoneCoverage(calendarDay.plus({ days: 180 }).toMillis() - 1);
      }
      const uvForecast = await getUvForecast(
        latitude, longitude, height, timezone, env.OPENUV_API_KEY, ctx
      );

      const solarCalendar = await getSolarCalendar(
        latitude, longitude, height, timezone, calendarDay, ctx
      );
      let uvEvent = null;
      if (uvForecast && localUvDay(DateTime.utc().toMillis(), timezone).date === uvForecast.localDate) {
        uvEvent = buildUvEvent(uvForecast.forecast, minUv, timezone);
        if (uvEvent && uvForecast.stale) {
          uvEvent.description = `Earlier forecast, fetched ${uvForecast.fetchedAt}.\n${uvEvent.description}`;
        }
      }
      // Event.toString() escapes text; foldLines is the public serializer's
      // folding step. Only this dynamic event is rendered on a solar cache hit.
      const uvText = uvEvent ? foldLines(ical().createEvent({ ...uvEvent,
        ...(timezone.mode === "iana" ? namedEventDates(uvEvent.start, uvEvent.end, timezone.zone) : {}),
      }).toString()) : "";
      let body = uvText
        ? solarCalendar.slice(0, -CALENDAR_END.length) + uvText + CALENDAR_END
        : solarCalendar;

      // Solar generation can take long enough to cross local midnight. Check
      // the date again before returning so yesterday's UV rows do not escape.
      const responseNow = DateTime.utc().toMillis();
      const responseDay = localUvDay(responseNow, timezone);
      if (uvForecast && uvText && (responseDay.date !== uvForecast.localDate ||
          Date.parse(uvForecast.fetchedAt) < responseDay.start)) {
        body = solarCalendar;
      }

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": `max-age=${localDayHttpMaxAge(responseNow, timezone)}`,
        },
      });
    } catch (error) {
      captureWorkerError(error, "calendar_build_failed");
      const message = error instanceof Error ? error.message : "Unknown error";
      return new Response(`Failed to build calendar: ${message}`, { status: 502 });
    }
  },
};

const sentryHandler = withSentry({ ...workerHandler });

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return isSentryDsn(env.SENTRY_DSN)
      ? sentryHandler.fetch(request, env, ctx)
      : workerHandler.fetch(request, env, ctx);
  },
};

function parseDisplayTimezone(value: string | null): DisplayTimezone | null {
  // Preserve all finite legacy Number spellings, including whitespace/exponents.
  const offset = Number(value);
  if (Number.isFinite(offset)) {
    return { mode: "fixed", offset };
  }
  // Do not admit bare abbreviations or offset identifiers as IANA names.
  if (value === null || !(/^UTC$/i.test(value) ||
      /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) {
    return null;
  }
  const zone = canonicalTimezone(value);
  return zone ? { mode: "iana", zone } : null;
}

async function getSolarCalendar(
  latitude: number,
  longitude: number,
  height: number,
  timezone: DisplayTimezone,
  calendarDay: DateTime,
  ctx: ExecutionContext
): Promise<string> {
  let cache: Cache | null = null;
  try {
    cache = caches.default;
  } catch (error) {
    captureWorkerError(error, "solar_cache_read_failed");
  }
  const keyUrl = new URL(`https://cache.sun-cal/solar/${SOLAR_CACHE_VERSION}`);
  keyUrl.searchParams.set("day", calendarDay.toISODate() as string);
  keyUrl.searchParams.set("lat", String(latitude));
  keyUrl.searchParams.set("lng", String(longitude));
  keyUrl.searchParams.set("height", String(height));
  keyUrl.searchParams.set("tzMode", timezone.mode);
  keyUrl.searchParams.set("tz", timezone.mode === "fixed" ? String(timezone.offset) : timezone.zone);
  if (timezone.mode === "iana") {
    keyUrl.searchParams.set("tzData", TIMEZONE_DATA_VERSION);
    keyUrl.searchParams.set("tzAssets", TIMEZONE_ASSET_VERSION);
  }
  const localeOptions = calendarDay.resolvedLocaleOptions();
  for (const [name, value] of Object.entries(localeOptions)) {
    keyUrl.searchParams.set(name, String(value));
  }
  const cacheKey = new Request(keyUrl);

  try {
    const cached = cache ? await cache.match(cacheKey) : undefined;
    if (cached?.ok && cached.headers.get("X-Sun-Cal-Key") === cacheKey.url) {
      const body = await cached.text();
      // Entries are written only here. Verify identity, boundaries and the
      // writer's body checksum without parsing and recreating 720 events.
      if (body.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") &&
          body.includes("\r\nBEGIN:VEVENT\r\n") &&
          body.endsWith(`\r\nEND:VEVENT\r\n${CALENDAR_END}`) &&
          cached.headers.get("X-Sun-Cal-SHA256") === await calendarDigest(body)) {
        return body;
      }
    }
  } catch (error) {
    // The solar cache is an optimization; read failures must not break the feed.
    captureWorkerError(error, "solar_cache_read_failed");
  }

  const calendar = ical({ name: "☀️ Sun" });
  calendar.ttl(UV_CACHE_TTL_SECONDS);
  if (timezone.mode === "iana") {
    calendar.x("X-WR-TIMEZONE", timezone.zone);
  }
  // Serialize calendar properties before adding components. Calendar.timezone()
  // stays unset so DTSTAMP remains UTC. Named endpoints use per-event zones.
  const header = calendar.toString();
  const eventsText = buildSunEvents(latitude, longitude, height, timezone, calendarDay)
    .map((event) => foldLines(calendar.createEvent({ ...event,
      ...(timezone.mode === "iana" ? namedEventDates(event.start, event.end, timezone.zone) : {}),
    }).toString())).join("");
  const component = timezone.mode === "iana" ? timezoneComponent(timezone.zone) : "";
  const body = header.slice(0, -CALENDAR_END.length) + component + eventsText + CALENDAR_END;

  try {
    const cached = new Response(body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": `max-age=${SOLAR_CACHE_TTL_SECONDS}`,
        "X-Sun-Cal-Key": cacheKey.url,
        "X-Sun-Cal-SHA256": await calendarDigest(body),
      },
    });
    ctx.waitUntil(cache?.put(cacheKey, cached).catch((error) => {
      captureWorkerError(error, "solar_cache_write_failed");
    }) ?? Promise.resolve());
  } catch (error) {
    // Synchronous write/setup failures likewise leave the generated feed usable.
    captureWorkerError(error, "solar_cache_write_failed");
  }
  return body;
}

async function calendarDigest(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildSunEvents(
  latitude: number,
  longitude: number,
  height: number,
  timezone: DisplayTimezone,
  calendarDay: DateTime
) {
  const events = [] as {
    id: string;
    summary: string;
    start: Date;
    end: Date;
    description: string;
  }[];

  const calendarDayMs = calendarDay.toMillis();
  const solarNoonMs = (12 - longitude / 15) * 3_600_000;
  for (let offset = -180; offset < 180; offset += 1) {
    const currentDayMs = calendarDayMs + offset * 86_400_000;
    // SunCalc selects the nearest solar cycle. Approximate local solar noon
    // selects this intended day even at +/-180 longitude; UTC noon alone can
    // select the adjacent day. UIDs continue to use the intended UTC date.
    let solarAnchor = new Date(currentDayMs + solarNoonMs);
    if (Number.isNaN(solarAnchor.valueOf())) {
      solarAnchor = calendarDay.plus({ days: offset })
        .plus({ hours: 12 - longitude / 15 }).toJSDate();
    }
    const currentDate = new Date(currentDayMs);
    const times = SunCalc.getTimes(solarAnchor, latitude, longitude, height);

    events.push(
      {
        id: createEventId("sunrise", currentDate),
        summary: "🌅 Sunrise",
        start: times.dawn,
        end: times.sunriseEnd,
        description: `Sunrise: ${formatSunTime(times.sunrise, timezone)}`,
      },
      {
        id: createEventId("sunset", currentDate),
        summary: "🌇 Sunset",
        start: times.sunsetStart,
        end: times.dusk,
        description: `Sunset: ${formatSunTime(times.sunset, timezone)}`,
      }
    );
  }

  return events;
}

function formatSunTime(date: Date, timezone: DisplayTimezone): string {
  const utc = DateTime.fromJSDate(date).toUTC();
  if (timezone.mode === "fixed") {
    return utc.plus({ hours: timezone.offset }).toLocaleString(DateTime.TIME_SIMPLE);
  }
  const local = utc.setZone(FixedOffsetZone.instance(regionalOffsetMinutesEast(date.valueOf(), timezone.zone)));
  return local.toLocaleString(DateTime.TIME_SIMPLE);
}

function buildUvEvent(uvForecast: UvForecastItem[], minUv: number, timezone: DisplayTimezone) {
  const hourlyValues: UvHour[] = uvForecast
    .map((item) => ({
      uv: item.uv,
      hour: DateTime.fromISO(item.uv_time).startOf("hour").toUTC(),
    }))
    .filter((item) => Number.isFinite(item.uv) && item.uv >= minUv);

  if (hourlyValues.length === 0) {
    return null;
  }

  const roundedValues = hourlyValues.map((item) => ({
    uv: Math.round(item.uv),
    hour: item.hour,
  }));

  const maxUv = Math.max(...roundedValues.map((item) => item.uv));
  const maxUvTimeRange = roundedValues.filter((item) => item.uv === maxUv);
  const start = DateTime.min(...maxUvTimeRange.map((item) => item.hour))!.toUTC();
  const end = DateTime.max(...maxUvTimeRange.map((item) => item.hour))!
    .plus({ hours: 1 })
    .toUTC();

  return {
    id: createEventId("peak-uv", start.toJSDate()),
    summary: `☀️ Peak UV index (${maxUv})`,
    start: start.toJSDate(),
    end: end.toJSDate(),
    description: roundedValues
      .map((item) => createBarChartLine(item, minUv, timezone))
      .join("\n"),
  };
}

function createEventId(type: string, date: Date) {
  return `sun-cal-${type}-${date.toISOString().slice(0, 10)}`;
}

function createBarChartLine({ hour, uv }: UvHour, minUv: number, timezone: DisplayTimezone) {
  const local = timezone.mode === "fixed"
    ? hour.plus({ hours: timezone.offset })
    : hour.setZone(FixedOffsetZone.instance(regionalOffsetMinutesEast(hour.toMillis(), timezone.zone)));
  const formattedHour = local.toLocaleString(timezone.mode === "fixed"
    ? { hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const fixedWidthTime = formattedHour
    .replace(/\s+/g, "")
    .split("")
    .map((char) => FIXED_WIDTH_CHARS[char] ?? char)
    .join("");

  const barLength = Math.min(Math.max(uv - (minUv - 1), 0), 100);
  const bar = new Array(barLength).fill("█").join("");
  return `${fixedWidthTime} ${bar} ${uv}`;
}
