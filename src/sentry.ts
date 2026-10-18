import * as Sentry from "@sentry/cloudflare";
import type { CloudflareOptions, ErrorEvent, EventHint } from "@sentry/cloudflare";

export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
}

export type ErrorClassification =
  | "worker_configuration_error"
  | "calendar_build_failed"
  | "solar_cache_read_failed"
  | "solar_cache_write_failed"
  | "uv_cache_write_failed"
  | "worker_unhandled";

const SERVICE = "sun-cal";
const ENVIRONMENT = "production";
const SAFE_CLASSIFICATIONS = new Set<ErrorClassification>([
  "worker_configuration_error",
  "calendar_build_failed",
  "solar_cache_read_failed",
  "solar_cache_write_failed",
  "uv_cache_write_failed",
  "worker_unhandled",
]);
const SAFE_SOURCE_FILES = new Set([
  "src/index.ts",
  "src/timezones.ts",
  "src/sentry.ts",
  "index.js",
  "worker.js",
]);
const SAFE_FUNCTIONS = new Set([
  "default.fetch",
  "Object.fetch",
  "fetch",
  "parseDisplayTimezone",
  "getSolarCalendar",
  "getUvForecast",
  "fetchWithRetries",
  "buildSunEvents",
  "calendarDigest",
  "buildUvEvent",
  "formatSunTime",
  "regionalLabel",
  "createEventId",
  "createBarChartLine",
  "sleep",
]);
const MAX_FRAMES = 12;

export function withSentry<T extends { fetch: (...args: any[]) => any }>(handler: T): T {
  return Sentry.withSentry<SentryEnv, unknown, unknown, T, CloudflareOptions>(
    (rawEnv) => {
      const env = rawEnv as SentryEnv;
      return isSentryDsn(env.SENTRY_DSN) ? makeSentryOptions(env) : undefined;
    },
    handler,
  );
}

export function isSentryDsn(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      /^o\d+\.ingest(?:\.(?:us|de))?\.sentry\.io$/i.test(url.hostname) &&
      /^[\da-z_]+$/i.test(url.username) &&
      url.password === "" &&
      /^\/\d+$/.test(url.pathname) &&
      url.search === "" && url.hash === "" &&
      !url.port;
  } catch {
    return false;
  }
}

export function captureWorkerError(error: unknown, classification: ErrorClassification): void {
  try {
    Sentry.withScope((scope) => {
      scope.setTag("diagnostic", classification);
      Sentry.captureException(error);
    });
  } catch {
    // Telemetry failures must not change the Worker response or cache behavior.
  }
}

function makeSentryOptions(env: SentryEnv): CloudflareOptions {
  const release = safeRelease(env.SENTRY_RELEASE);
  return {
    dsn: env.SENTRY_DSN,
    environment: ENVIRONMENT,
    release,
    serverName: SERVICE,
    // A zero rate alone still trusts an inbound `sampled=1` trace header.
    // The sampler and transaction filter make the errors-only contract explicit.
    tracesSampler: () => 0,
    beforeSendTransaction: () => null,
    tracePropagationTargets: [],
    traceLifecycle: "static",
    debug: false,
    cacheClient: false,
    sendClientReports: false,
    defaultIntegrations: [],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeSend(event: ErrorEvent, hint: EventHint) {
      return safeEvent(event, hint, release);
    },
  };
}

function safeEvent(input: ErrorEvent, hint: EventHint, release: string | undefined): ErrorEvent | null {
  const event = asRecord(input);
  const eventHint = asRecord(hint);
  if (Array.isArray(eventHint.attachments) && eventHint.attachments.length > 0) {
    try {
      eventHint.attachments = [];
    } catch {
      return null;
    }
  }

  const eventId = typeof event.event_id === "string" && /^[\da-f]{32}$/i.test(event.event_id)
    ? event.event_id
    : undefined;
  const timestamp = typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
    ? event.timestamp
    : undefined;
  const eventTags = asRecord(event.tags);
  const diagnostic = typeof eventTags.diagnostic === "string" &&
    SAFE_CLASSIFICATIONS.has(eventTags.diagnostic as ErrorClassification)
    ? eventTags.diagnostic as ErrorClassification
    : "worker_unhandled";
  const exceptionValues = asRecord(event.exception).values;
  const firstException = Array.isArray(exceptionValues)
    ? exceptionValues[0]
    : undefined;
  const safeFrames = filterFrames(asRecord(asRecord(firstException).stacktrace).frames);
  const safeEvent: Record<string, unknown> = {
    event_id: eventId,
    timestamp,
    platform: "javascript",
    level: "error",
    environment: ENVIRONMENT,
    release,
    tags: { service: SERVICE, diagnostic },
    exception: {
      values: [{
        type: "WorkerError",
        value: diagnostic,
        ...(safeFrames.length > 0 ? { stacktrace: { frames: safeFrames } } : {}),
      }],
    },
  };
  return safeEvent as unknown as ErrorEvent;
}

function filterFrames(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const valueFrame of value) {
    const frame = asRecord(valueFrame);
    const filename = safeFilename(frame.filename);
    const lineno = frame.lineno;
    if (!filename || typeof lineno !== "number" || !Number.isInteger(lineno) || lineno < 1 || lineno > 100_000) {
      continue;
    }
    const functionName = typeof frame.function === "string" && SAFE_FUNCTIONS.has(frame.function)
      ? frame.function
      : undefined;
    const colno = frame.colno;
    result.push({
      filename,
      lineno,
      in_app: true,
      ...(typeof colno === "number" && Number.isInteger(colno) && colno > 0 && colno <= 1_000_000
        ? { colno }
        : {}),
      ...(functionName ? { function: functionName } : {}),
    });
  }
  return result.slice(-MAX_FRAMES);
}

function safeFilename(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\\", "/").split(/[?#]/, 1)[0];
  const candidates = normalized.split("/");
  const sourcePath = candidates.slice(-2).join("/");
  const basename = candidates.at(-1);
  if (sourcePath.startsWith("src/") && SAFE_SOURCE_FILES.has(sourcePath)) {
    return `app:///${sourcePath}`;
  }
  if (basename === "index.js" || basename === "worker.js") {
    // Wrangler emits one bundled Worker plus a matching source map. Keep a stable
    // generated filename so a later release upload can map this exact code file.
    return "app:///index.js";
  }
  return undefined;
}

function safeRelease(value: unknown): string | undefined {
  return typeof value === "string" && /^[\da-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
