import ical from "ical-generator";
import { DateTime } from "luxon";
import SunCalc from "suncalc";

interface Env {
  OPENUV_API_KEY: string;
}

type UvForecastItem = {
  uv: number;
  uv_time: string;
  [key: string]: unknown;
};

type UvHour = {
  uv: number;
  hour: DateTime;
};

const UV_CACHE_TTL_SECONDS = 60 * 30;
const UV_MAX_RETRIES = 6;
const UV_BACKOFF_START_MS = 1000;
const UV_REQUEST_TIMEOUT_MS = 10_000;

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/sun-cal.ics") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!env.OPENUV_API_KEY) {
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
    const tzOffset = tzParam === null || tzParam === "" ? 0 : Number(tzParam);

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

    if (!Number.isFinite(tzOffset)) {
      return new Response("Invalid tz", { status: 400 });
    }

    try {
      const uvForecast = await getUvForecast(
        latitudeParam as string,
        longitudeParam as string,
        heightParam as string,
        env.OPENUV_API_KEY,
        ctx
      );

      const sunEvents = buildSunEvents(latitude, longitude, height, tzOffset);
      const uvEvent = buildUvEvent(uvForecast, minUv, tzOffset);

      const calendar = ical({ name: "☀️ Sun" });
      sunEvents.forEach((event) => calendar.createEvent(event));
      if (uvEvent) {
        calendar.createEvent(uvEvent);
      }
      calendar.ttl(UV_CACHE_TTL_SECONDS);

      return new Response(calendar.toString(), {
        status: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": `max-age=${UV_CACHE_TTL_SECONDS}`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return new Response(`Failed to build calendar: ${message}`, { status: 502 });
    }
  },
};

async function getUvForecast(
  latitudeParam: string,
  longitudeParam: string,
  heightParam: string,
  apiKey: string,
  ctx: ExecutionContext
): Promise<UvForecastItem[]> {
  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.sun-cal/uv?lat=${encodeURIComponent(latitudeParam)}&lng=${encodeURIComponent(
      longitudeParam
    )}&alt=${encodeURIComponent(heightParam)}`
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedData = await cached.json();
    if (Array.isArray(cachedData)) {
      return cachedData as UvForecastItem[];
    }
    if (cachedData && Array.isArray(cachedData.result)) {
      return cachedData.result as UvForecastItem[];
    }
  }

  const uvUrl = new URL("https://api.openuv.io/api/v1/forecast");
  uvUrl.searchParams.set("lat", latitudeParam);
  uvUrl.searchParams.set("lng", longitudeParam);
  uvUrl.searchParams.set("alt", heightParam);

  const json = await fetchWithRetries(uvUrl.toString(), apiKey);

  if (!json || !Array.isArray(json.result)) {
    throw new Error("Unexpected openuv response");
  }

  const forecast = json.result as UvForecastItem[];
  const responseToCache = new Response(JSON.stringify(forecast), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${UV_CACHE_TTL_SECONDS}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, responseToCache));

  return forecast;
}

async function fetchWithRetries(url: string, apiKey: string): Promise<any> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= UV_MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const delayMs = UV_BACKOFF_START_MS * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    }

    try {
      const response = await fetch(url, {
        headers: {
          "x-access-token": apiKey,
        },
        signal: AbortSignal.timeout(UV_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`openuv returned ${response.status}`);
      }

      const text = await response.text();
      const json = JSON.parse(text);

      return json;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Failed to fetch openuv forecast");
}

function buildSunEvents(
  latitude: number,
  longitude: number,
  height: number,
  tzOffset: number
) {
  const events = [] as {
    summary: string;
    start: Date;
    end: Date;
    description: string;
  }[];

  for (let offset = -180; offset < 180; offset += 1) {
    const currentDate = DateTime.utc().plus({ days: offset }).toJSDate();
    const times = SunCalc.getTimes(currentDate, latitude, longitude, height);

    events.push(
      {
        summary: "🌅 Sunrise",
        start: times.dawn,
        end: times.sunriseEnd,
        description: `Sunrise: ${DateTime.fromJSDate(times.sunrise)
          .toUTC()
          .plus({ hours: tzOffset })
          .toLocaleString(DateTime.TIME_SIMPLE)}`,
      },
      {
        summary: "🌇 Sunset",
        start: times.sunsetStart,
        end: times.dusk,
        description: `Sunset: ${DateTime.fromJSDate(times.sunset)
          .toUTC()
          .plus({ hours: tzOffset })
          .toLocaleString(DateTime.TIME_SIMPLE)}`,
      }
    );
  }

  return events;
}

function buildUvEvent(uvForecast: UvForecastItem[], minUv: number, tzOffset: number) {
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
  const start = DateTime.min(...maxUvTimeRange.map((item) => item.hour)).toUTC();
  const end = DateTime.max(...maxUvTimeRange.map((item) => item.hour))
    .plus({ hours: 1 })
    .toUTC();

  return {
    summary: `☀️ Peak UV index (${maxUv})`,
    start: start.toJSDate(),
    end: end.toJSDate(),
    description: roundedValues
      .map((item) => createBarChartLine(item, minUv, tzOffset))
      .join("\n"),
  };
}

function createBarChartLine({ hour, uv }: UvHour, minUv: number, tzOffset: number) {
  const formattedHour = hour
    .plus({ hours: tzOffset })
    .toLocaleString({ hour: "2-digit" });
  const fixedWidthTime = formattedHour
    .replace(/\s+/g, "")
    .split("")
    .map((char) => FIXED_WIDTH_CHARS[char] ?? char)
    .join("");

  const barLength = Math.max(uv - (minUv - 1), 0);
  const bar = new Array(barLength).fill("█").join("");

  return `${fixedWidthTime} ${bar} ${uv}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
