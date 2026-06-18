"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CaretLeft, CaretRight } from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import { isTeamHead, useTeams } from "@/lib/use-teams";
import type { PaymentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { IdAvatar } from "@/components/profile/id-avatar";

// Cache the last-seen banner rows so a reload shows them instantly instead of
// flashing nothing while billing re-fetches.
const CACHE_KEY = "silicon-interface:payment-banner";
function readCache(): TeamPayment[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    const arr = raw ? (JSON.parse(raw) as TeamPayment[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeCache(rows: TeamPayment[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(rows));
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
function daysUntil(due: string): number {
  const target = new Date(`${due}T00:00:00`);
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
 * Team logo on the left, "Pay now" on the right. Re-checks hourly and
 * recomputes the day count at local midnight.
 */
export function PaymentBanner() {
  const router = useRouter();
  const { teams } = useTeams();
  // Seed from cache so the banner shows instantly on reload.
  const [rows, setRows] = React.useState<TeamPayment[]>(() => readCache());
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
    let alive = true;
    const check = async () => {
      const out = await Promise.all(
        headTeams.map(async (t) => {
          try {
            const b = await api.teamBilling(t.slug);
            return b.payment && b.payment.state !== "ok"
              ? { ...t, payment: b.payment }
              : null;
          } catch {
            return null;
          }
        }),
      );
      if (alive) {
        const next = out.filter(Boolean) as TeamPayment[];
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
  }, [headKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flip the local day at midnight so the countdown ticks down.
  React.useEffect(() => {
    const id = setInterval(() => setDay(new Date().toDateString()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Pay now opens the team's billing page (the workspace's Billing tab).
  const payNow = (r: TeamPayment) => {
    router.push(`/chat?team=${encodeURIComponent(r.slug)}&tab=billing`);
  };

  if (!rows.length) return null;
  const i = Math.min(index, rows.length - 1);
  const r = rows[i];
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

  const { title, line } = copy(r.name, d, daysToPause, amount, paused);
  const multiple = rows.length > 1;

  return (
    <div
      role="alert"
      className={cn(
        // px-6 + 36px mark to line up with the folder / chat rows below.
        "flex gap-3 border-b py-3 pl-6 pr-4",
        tier === "critical" && "bg-destructive text-white",
        tier === "urgent" && "bg-warning/60 text-foreground",
        tier === "warn" && "bg-warning/25 text-foreground",
        tier === "info" && "bg-secondary text-foreground",
      )}
    >
      <IdAvatar
        seed={`team:${r.slug}`}
        src={r.logo_url}
        size={36}
        family="team"
        className={cn("mt-0.5 h-9 w-9 shrink-0 border-0", tier === "critical" ? "bg-white/15" : "bg-muted")}
      />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", tier === "info" ? "font-medium" : "font-semibold")}>
          {title}
        </div>
        <div className={cn("mt-0.5 truncate text-xs", tier === "critical" ? "text-white/85" : "text-muted-foreground")}>
          {line}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => payNow(r)}
            className={cn(
              "h-8 px-4 text-xs",
              tier === "critical" && "bg-white text-destructive hover:bg-white/90",
            )}
          >
            Pay now
          </Button>
          {multiple && (
            <div className="flex items-center gap-0.5">
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
    </div>
  );
}

function copy(
  team: string,
  d: number | null,
  daysToPause: number | null,
  amount: string,
  paused: boolean,
): { title: string; line: string } {
  const plural = (n: number) => (n === 1 ? "" : "s");
  if (paused) {
    return {
      title: `${team} — services paused`,
      line: `${amount} overdue. Pay now to bring your silicons back online.`,
    };
  }
  if (d !== null && d < 0) {
    // Past the due date, still inside the grace window.
    return {
      title: `${team} — payment overdue`,
      line:
        daysToPause !== null && daysToPause >= 0
          ? `${amount} overdue · silicons stop working in ${daysToPause} day${plural(daysToPause)} if unpaid.`
          : `${amount} overdue · silicons will stop working if unpaid.`,
    };
  }
  if (d === 0) {
    return {
      title: `${team} — Last Day to pay`,
      line: `${amount} due today · silicons will stop working if this isn't paid.`,
    };
  }
  if (d !== null && d <= 2) {
    return {
      title: `Payment due for the month — ${team}`,
      line: `Only ${d} day${plural(d)} left · ${amount} · silicons will stop working very soon if unpaid.`,
    };
  }
  if (d !== null && d <= 7) {
    return {
      title: `Payment due for the month — ${team}`,
      line: `${d} days remaining · ${amount} · silicons will stop working if this isn't paid.`,
    };
  }
  return {
    title: `Payment due for the month — ${team}`,
    line: d !== null ? `${d} days remaining · ${amount}` : `${amount} due soon`,
  };
}
