"use client";

import * as React from "react";
import { CircleNotch, X } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { isTeamHead, useTeams } from "@/lib/use-teams";
import type { PaymentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { IdAvatar } from "@/components/profile/id-avatar";

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
  const { teams } = useTeams();
  const [rows, setRows] = React.useState<TeamPayment[]>([]);
  const [dismissed, setDismissed] = React.useState<Record<string, string>>({});
  const [day, setDay] = React.useState(() => new Date().toDateString());
  const [paying, setPaying] = React.useState<string | null>(null);

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
      if (alive) setRows(out.filter(Boolean) as TeamPayment[]);
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

  const payNow = async (r: TeamPayment) => {
    setPaying(r.slug);
    try {
      const res = await api.teamCheckout(r.slug, {
        cycle_id: r.payment.cycle_id,
        return_url: typeof window === "undefined" ? "" : window.location.href,
      });
      if (res.checkout_url) {
        window.location.href = res.checkout_url;
      } else {
        toast.error(res.error || "Couldn't start checkout.");
        setPaying(null);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't start checkout.");
      setPaying(null);
    }
  };

  const visible = rows.filter((r) => dismissed[r.slug] !== `${day}:${r.payment.due_date}`);
  if (!visible.length) return null;

  return (
    <div className="flex flex-col">
      {visible.map((r) => {
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
        // Only the quiet early heads-up is dismissible — once it's urgent the
        // banner stays put.
        const dismissible = tier === "info";

        return (
          <div
            key={r.slug}
            role="alert"
            className={cn(
              "flex items-center gap-3 border-b px-6 py-2.5",
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
              className={cn("shrink-0 border-0", tier === "critical" ? "bg-white/15" : "bg-muted")}
            />
            <div className="min-w-0 flex-1">
              <div className={cn("truncate text-sm", tier === "info" ? "font-medium" : "font-semibold")}>
                {title}
              </div>
              <div className={cn("truncate text-xs", tier === "critical" ? "text-white/85" : "text-muted-foreground")}>
                {line}
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => payNow(r)}
              disabled={paying === r.slug}
              className={cn(
                "shrink-0",
                tier === "critical" && "bg-white text-destructive hover:bg-white/90",
              )}
            >
              {paying === r.slug && <CircleNotch className="animate-spin" />} Pay now
            </Button>
            {dismissible && (
              <button
                type="button"
                aria-label="Dismiss"
                className="shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
                onClick={() => setDismissed((m) => ({ ...m, [r.slug]: `${day}:${r.payment.due_date}` }))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
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
