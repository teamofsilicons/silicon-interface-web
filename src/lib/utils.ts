import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function relativeTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  // Guard malformed input: `new Date("nonsense").getTime()` is NaN, which used
  // to fall through to `d.toLocaleDateString()` → "Invalid Date".
  const ms = d.getTime();
  if (Number.isNaN(ms)) return "";
  // Guard clock skew: a timestamp slightly in the future (server/client clock
  // drift) produced a negative diff that still satisfied `diff < 60` and read
  // "just now" — acceptable — but a larger future drift fell through to a date.
  // Clamp non-positive diffs to "just now" so the future never renders oddly.
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString();
}

// Message-timeline timestamps: relative only within the first hour, then the
// message's own clock time. Older days are disambiguated by the date band the
// timeline renders at each day boundary, so the time alone is never ambiguous.
export function messageTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const ms = d.getTime();
  if (Number.isNaN(ms)) return "";
  // Same clock-skew clamp as relativeTime: never render a future drift oddly.
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} min${m === 1 ? "" : "s"} ago`;
  }
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Day-boundary band label: "12 June", with the year appended only when it
// isn't the current one ("12 June 2025"). Built by hand instead of
// toLocaleDateString so the day-before-month order holds across locales.
export function dayLabel(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const month = d.toLocaleString(undefined, { month: "long" });
  const year = d.getFullYear();
  return `${d.getDate()} ${month}${year === new Date().getFullYear() ? "" : ` ${year}`}`;
}

export function shortId(id: string, head = 6, tail = 4): string {
  if (!id || id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}
