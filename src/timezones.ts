import moment from "moment-timezone";
import database from "./data/timezones.json";
import manifest from "./data/timezones-manifest.json";

export const TIMEZONE_DATA_VERSION = database.iana;
export const TIMEZONE_ASSET_VERSION = manifest.sha256;
const COVERAGE_START = Date.parse("2006-01-01T00:00:00Z");
const COVERAGE_END = Date.parse("2088-01-01T00:00:00Z");
const aliases: Record<string, string> = Object.fromEntries(
  Object.entries(database.aliases).map(([name, zone]) => [name.toLowerCase(), zone])
);
const assets: Record<string, string> = database.assets;

if (moment.tz.dataVersion !== TIMEZONE_DATA_VERSION) {
  throw new Error("Timezone conversion and VTIMEZONE data versions differ");
}

export function canonicalTimezone(value: string): string | null {
  // Match actual pinned IANA spellings. Moment's lookup also treats slashes and
  // underscores as interchangeable, admitting names absent from the database.
  const name = value.toLowerCase();
  return Object.hasOwn(aliases, name) ? aliases[name] : null;
}

export function timezoneComponent(zone: string): string {
  return assets[zone];
}

export function requireTimezoneCoverage(milliseconds: number): void {
  if (!(milliseconds >= COVERAGE_START && milliseconds < COVERAGE_END)) {
    throw new Error("Named timezone coverage is 2006-01-01 through 2087-12-31 UTC");
  }
}

export function regionalOffsetMinutesEast(milliseconds: number, zoneName: string): number {
  requireTimezoneCoverage(milliseconds);
  return -moment.tz.zone(zoneName)!.utcOffset(milliseconds);
}

export function regionalTime(milliseconds: number, zone: string) {
  requireTimezoneCoverage(milliseconds);
  // Explicit English locale keeps serializer date fields in ASCII, regardless
  // of process locale. The Moment value already has the pinned regional offset.
  return moment.utc(milliseconds).tz(zone).locale("en");
}

function secondOccurrence(milliseconds: number, zoneName: string): boolean {
  const zone = moment.tz.zone(zoneName)!;
  // Zone offsets are minutes west of UTC; untils are exclusive UTC instants.
  const index = zone.untils.findIndex((until) => milliseconds < until);
  if (index < 1) return false;
  const repeatedMinutes = zone.offsets[index] - zone.offsets[index - 1];
  return repeatedMinutes > 0 &&
    milliseconds < zone.untils[index - 1] + repeatedMinutes * 60_000;
}

export function namedEventDates(start: Date, end: Date, zone: string) {
  requireTimezoneCoverage(start.valueOf());
  requireTimezoneCoverage(end.valueOf());
  // RFC 5545 selects the first occurrence of a repeated local clock. Only the
  // second occurrence needs the approved whole-event UTC representation.
  if (secondOccurrence(start.valueOf(), zone) || secondOccurrence(end.valueOf(), zone)) {
    return { start, end };
  }
  return { start: regionalTime(start.valueOf(), zone),
    end: regionalTime(end.valueOf(), zone), timezone: zone };
}
