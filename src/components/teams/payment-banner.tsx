"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CaretLeft, CaretRight } from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import { isTeamHead, useTeams } from "@/lib/use-teams";
import type { PaymentStatus } from "@/lib/types";
import { resolveTeamLogo } from "@/lib/team-logo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { IdAvatar } from "@/components/profile/id-avatar";

// Cache the last-seen banner rows so a reload shows them instantly instead of
// flashing nothing while billing re-fetches.
const CACHE_KEY = "silicon-interface:payment-banner";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizePayment(value: unknown): PaymentStatus | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const state =
    raw.state === "ok" || raw.state === "warning" || raw.state === "grace" || raw.state === "paused"
      ? raw.state
      : "warning";
  return {
    state,
    due_date: nullableStr(raw.due_date),
    days_left: nullableNumber(raw.days_left),
    pause_date: nullableStr(raw.pause_date),
    days_to_pause: nullableNumber(raw.days_to_pause),
    grace_days: number(raw.grace_days),
    amount_cents: number(raw.amount_cents),
    currency: str(raw.currency, "USD"),
    cycle_id: nullableNumber(raw.cycle_id) ?? undefined,
  };
}

function normalizeTeamPayment(value: unknown): TeamPayment | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const slug = str(raw.slug);
  if (!slug) return null;
  const payment = normalizePayment(raw.payment);
  if (!payment) return null;
  return {
    slug,
    name: str(raw.name, slug),
    logo_url: nullableStr(raw.logo_url),
    payment,
  };
}

function shouldShowPayment(row: TeamPayment): boolean {
  return row.payment.state !== "ok" && row.payment.amount_cents > 0;
}

function readCache(): TeamPayment[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr)
      ? arr
          .map(normalizeTeamPayment)
          .filter((row): row is TeamPayment => row !== null)
          .filter(shouldShowPayment)
      : [];
  } catch {
    return [];
  }
}
function writeCache(rows: TeamPayment[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(rows.filter(shouldShowPayment)));
  } catch {
    /* quota / unavailable — non-fatal */
  }
}

interface TeamPayment {
  slug: string;
  name: string;
  logo_url: string | null;
  payment: PaymentStatus;
}

/** Local day delta so the countdown advances daily without re-polling. */
function daysUntil(due: string): number | null {
  const target = new Date(`${due}T00:00:00`);
  if (!Number.isFinite(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function money(cents: number, currency: string): string {
  try {
    return (cents / 100).toLocaleString(undefined, { style: "currency", currency });
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

type Tier = "info" | "warn" | "urgent" | "critical";

/**
 * Head-only payment-deadline banner, escalating over the final stretch:
 *   • 15→8 days  — quiet heads-up (not attention-seeking)
 *   • 7→3 days   — prominent; spells out that silicons will stop working
 *   • 2→1 days   — loud
 *   • due day    — red "Last Day"; overdue/paused stays red
 * Team logo on the left, with the payment action beside the amount. Re-checks hourly and
 * recomputes the day count at local midnight.
 */
export function PaymentBanner() {
  const router = useRouter();
  const { teams, loading: teamsLoading } = useTeams();
  // Seed from cache so the banner shows instantly on reload (dropping any stale
  // $0 rows so they don't flash before the re-fetch).
  const [rows, setRows] = React.useState<TeamPayment[]>(readCache);
  const [index, setIndex] = React.useState(0);
  const [, setDay] = React.useState(() => new Date().toDateString());

  const headTeams = React.useMemo(
    () =>
      teams
        .filter(isTeamHead)
        .map((t) => ({ slug: t.slug, name: t.name, logo_url: t.logo_url ?? null })),
    [teams],
  );
  const headKey = headTeams.map((t) => t.slug).join(",");

  // Poll billing for each headed team (hourly + on team-set change).
  React.useEffect(() => {
    // Never let the initial empty useTeams frame erase the cached banner or
    // replace its logo before the authoritative team list has hydrated.
    if (teamsLoading) return;
    let alive = true;
    const check = async () => {
      const out = await Promise.all(
        headTeams.map(async (t) => {
          try {
            const b = await api.teamBilling(t.slug);
            const payment = normalizePayment(b.payment);
            // Nothing owed ($0.00) ⇒ no banner, even if state isn't "ok".
            return payment && shouldShowPayment({ ...t, payment }) ? { ...t, payment } : null;
          } catch {
            return null;
          }
        }),
      );
      if (alive) {
        const next = (out.filter(Boolean) as TeamPayment[]).filter(shouldShowPayment);
        setRows(next);
        writeCache(next);
      }
    };
    void check();
    const id = setInterval(check, 60 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [headKey, teamsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flip the local day at midnight so the countdown ticks down.
  React.useEffect(() => {
    const id = setInterval(() => setDay(new Date().toDateString()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Continue Payment opens the team's billing page (the workspace's Billing tab).
  const payNow = (r: TeamPayment) => {
    router.push(`/chat?team=${encodeURIComponent(r.slug)}&tab=billing`);
  };

  if (!rows.length) return null;
  const i = Math.min(index, rows.length - 1);
  const r = rows[i];
  const identity = resolveTeamLogo(r, headTeams, teamsLoading);
  if (!identity) return null;
  const pay = r.payment;
  const due = pay.due_date;
  const d = due ? daysUntil(due) : pay.days_left;
  const daysToPause = pay.pause_date ? daysUntil(pay.pause_date) : pay.days_to_pause ?? null;
  const paused = pay.state === "paused" || (daysToPause !== null && daysToPause < 0);
  const amount = money(pay.amount_cents, pay.currency);

  const tier: Tier = paused
    ? "critical"
    : d === null
      ? "warn"
      : d <= 0
        ? "critical"
        : d <= 2
          ? "urgent"
          : d <= 7
            ? "warn"
            : "info";

  const timing = paymentTimingCopy(d, daysToPause, paused);
  const multiple = rows.length > 1;

  return (
    <div
      role="alert"
      className={cn(
        // px-6 + 36px mark to line up with the folder / chat rows below.
        "flex items-center gap-3 border-b py-4 pl-6 pr-4",
        tier === "critical" && "bg-destructive text-white",
        tier === "urgent" && "bg-warning/60 text-foreground",
        tier === "warn" && "bg-warning/25 text-foreground",
        tier === "info" && "bg-secondary text-foreground",
      )}
    >
      {identity.ready ? (
        <IdAvatar
          seed={`team:${identity.slug}`}
          src={identity.logo_url}
          size={36}
          family="team"
          className={cn("h-9 w-9 shrink-0 border-0", tier === "critical" ? "bg-white/15" : "bg-muted")}
        />
      ) : (
        <span
          aria-hidden
          className={cn("h-9 w-9 shrink-0 animate-pulse", tier === "critical" ? "bg-white/15" : "bg-muted")}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", tier === "info" ? "font-medium" : "font-semibold")}>
          Payment due for {identity.name}
        </div>
        <div className={cn("mt-0.5 truncate text-xs", tier === "critical" ? "text-white/85" : "text-muted-foreground")}>
          {timing}
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-3">
          <div className="min-w-0 truncate text-base font-semibold tracking-tight tabular-nums">
            {amount}
          </div>
          <Button
            size="sm"
            onClick={() => payNow(r)}
            className={cn(
              "ml-auto h-9 shrink-0 px-4 text-xs",
              tier === "critical" && "bg-white text-destructive hover:bg-white/90",
            )}
          >
            Continue Payment
          </Button>
        </div>
        {multiple && (
          <div className="mt-1 flex items-center justify-end gap-0.5">
            <button
              type="button"
              aria-label="previous notification"
              onClick={() => setIndex((n) => (n - 1 + rows.length) % rows.length)}
              className="grid h-7 w-6 place-items-center opacity-70 transition-opacity hover:opacity-100"
            >
              <CaretLeft className="h-4 w-4" weight="bold" />
            </button>
            <span className="label-mono text-[9px] tabular-nums opacity-70">
              {i + 1}/{rows.length}
            </span>
            <button
              type="button"
              aria-label="next notification"
              onClick={() => setIndex((n) => (n + 1) % rows.length)}
              className="grid h-7 w-6 place-items-center opacity-70 transition-opacity hover:opacity-100"
            >
              <CaretRight className="h-4 w-4" weight="bold" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function paymentTimingCopy(
  d: number | null,
  daysToPause: number | null,
  paused: boolean,
): string {
  const plural = (n: number) => (n === 1 ? "" : "s");
  if (paused) return "Services paused · Pay to bring your silicons back online";
  if (d !== null && d < 0) {
    return daysToPause !== null && daysToPause >= 0
      ? `Overdue · ${daysToPause} day${plural(daysToPause)} until services pause`
      : "Payment overdue";
  }
  if (d === 0) return "Due today";
  return d !== null ? `${d} day${plural(d)} remaining` : "Due soon";
}
