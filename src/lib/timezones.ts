// IANA timezone helpers for the profile picker.
//
// We expose a normalized "ZoneInfo" — IANA name + display country + current
// GMT offset — so the picker can render a single consistent label and sort by
// real-world offset (earliest to latest). DST is folded into the offset
// because we recompute it against `new Date()` rather than caching a baseline.

import { TZ_COUNTRY } from "./tz-countries";

const FALLBACK = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export interface ZoneInfo {
  /** IANA zone name, e.g. "Asia/Kolkata". */
  iana: string;
  /** Displayed country, e.g. "India". Empty when no mapping exists. */
  country: string;
  /** ISO 3166 alpha-2 code, e.g. "IN". Empty when no mapping exists. */
  countryCode: string;
  /** Current offset from UTC, in minutes. East positive (India = +330). */
  offsetMinutes: number;
  /** Pretty offset: "GMT+5:30", "GMT-3:00", "GMT+0:00". */
  offsetLabel: string;
}

export function allTimezones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const v = fn?.("timeZone");
    if (Array.isArray(v) && v.length) return v;
  } catch {
    /* fall through */
  }
  return FALLBACK;
}

export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function formatTimeInZone(tz: string, d: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz || "UTC",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return "";
  }
}

/**
 * Current UTC offset for a zone, in whole minutes. Positive = east of UTC.
 * Computed by asking Intl for the wall-clock time in `tz` and subtracting it
 * from the same instant in UTC — this naturally accounts for DST.
 */
export function tzOffsetMinutes(tz: string, d: Date = new Date()): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(d)) map[p.type] = p.value;
    const asUTC = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return Math.round((asUTC - d.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Format a minute-offset as "GMT+5:30" / "GMT-3:00" / "GMT+0:00".
 *
 * One uniform style across every zone — no IST / EST / GMT+05:30 inconsistency
 * across browser locales. Hours are single-digit (matches casual conventions
 * like "GMT+1"), minutes are always two digits.
 */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `GMT${sign}${h}:${String(m).padStart(2, "0")}`;
}

/** Convenience: GMT-style offset label for a zone at a given moment. */
export function formatZoneOffset(tz: string, d: Date = new Date()): string {
  return formatOffset(tzOffsetMinutes(tz, d));
}

// Lazily-built country-name display; falls back to the raw code if Intl is
// unavailable (older runtimes).
let _displayNames: Intl.DisplayNames | null = null;
function countryDisplay(): Intl.DisplayNames | null {
  if (_displayNames) return _displayNames;
  try {
    _displayNames = new Intl.DisplayNames(undefined, { type: "region" });
    return _displayNames;
  } catch {
    return null;
  }
}

export function tzCountry(tz: string): { name: string; code: string } {
  const code = TZ_COUNTRY[tz] ?? "";
  if (!code) return { name: "", code: "" };
  const dn = countryDisplay();
  const name = dn?.of(code) ?? code;
  return { name: name || code, code };
}

/**
 * Enrich + sort every supported zone. Result is sorted by current offset
 * ascending (earliest in real-world time first → westernmost first), then by
 * IANA name for stable ordering within the same offset.
 */
export function listZones(d: Date = new Date()): ZoneInfo[] {
  const entries: ZoneInfo[] = allTimezones().map((iana) => {
    const offsetMinutes = tzOffsetMinutes(iana, d);
    const c = tzCountry(iana);
    return {
      iana,
      country: c.name,
      countryCode: c.code,
      offsetMinutes,
      offsetLabel: formatOffset(offsetMinutes),
    };
  });
  entries.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.iana.localeCompare(b.iana);
  });
  return entries;
}

/**
 * Search predicate. Matches any of:
 *   - IANA name fragment ("kolkata", "asia/")
 *   - country name fragment ("india", "united states")
 *   - country code ("in", "us")
 *   - GMT offset ("gmt+5:30", "gmt+05:30", "+5:30", "-3", "5:30")
 *
 * Trailing/leading whitespace, case, and an optional leading "gmt" are all
 * normalized away so users can type the offset however feels natural.
 */
export function matchesZone(z: ZoneInfo, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;

  // Treat anything starting with gmt / + / - / a digit as a possible offset
  // query and try to match against the zone's offset label.
  const looksLikeOffset =
    q.startsWith("gmt") ||
    q.startsWith("+") ||
    q.startsWith("-") ||
    /^\d/.test(q);
  if (looksLikeOffset) {
    const normQ = q.replace(/\s+/g, "").replace(/^gmt/, "");
    const normZ = z.offsetLabel.toLowerCase().replace(/^gmt/, "");
    // Strip leading zeros on the hour so "+05:30" matches our "+5:30" form.
    const stripZero = (s: string) => s.replace(/^([+-])0(\d)/, "$1$2");
    if (stripZero(normZ).includes(stripZero(normQ))) return true;
    // Don't `return false` here — fall through so e.g. "+1" can still match
    // an IANA name fragment if no offset matches.
  }

  if (z.iana.toLowerCase().includes(q)) return true;
  if (z.country && z.country.toLowerCase().includes(q)) return true;
  if (z.countryCode && z.countryCode.toLowerCase() === q) return true;
  return false;
}
