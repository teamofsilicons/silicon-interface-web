"use client";

import * as React from "react";
import { Warning, X } from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import { isTeamHead, useTeams } from "@/lib/use-teams";
import type { PaymentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface TeamPayment {
  slug: string;
  name: string;
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

/**
 * Head-only payment-deadline banner. For every team the signed-in Carbon heads,
 * we read the billing payment status; in the 7 days before the deadline we warn
 * (counting down daily), and once it passes while unpaid we show "Expired".
 * Re-checks hourly and recomputes the day count at local midnight.
 */
export function PaymentBanner() {
  const { teams } = useTeams();
  const [rows, setRows] = React.useState<TeamPayment[]>([]);
  const [dismissed, setDismissed] = React.useState<Record<string, string>>({});
  const [day, setDay] = React.useState(() => new Date().toDateString());

  const headSlugs = React.useMemo(
    () => teams.filter(isTeamHead).map((t) => ({ slug: t.slug, name: t.name })),
    [teams],
  );
  const headKey = headSlugs.map((t) => t.slug).join(",");

  // Poll billing for each headed team (hourly + on team-set change).
  React.useEffect(() => {
    let alive = true;
    const check = async () => {
      const out = await Promise.all(
        headSlugs.map(async ({ slug, name }) => {
          try {
            const b = await api.teamBilling(slug);
            return b.payment && b.payment.state !== "ok"
              ? { slug, name, payment: b.payment }
              : null;
          } catch {
            return null; // non-heads / errors simply don't surface a banner
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

  const visible = rows.filter((r) => dismissed[r.slug] !== `${day}:${r.payment.due_date}`);
  if (!visible.length) return null;

  return (
    <div className="flex flex-col">
      {visible.map((r) => {
        const pay = r.payment;
        const due = pay.due_date;
        const daysToDue = due ? daysUntil(due) : null;
        const daysToPause = pay.pause_date ? daysUntil(pay.pause_date) : pay.days_to_pause ?? null;
        const paused = pay.state === "paused" || (daysToPause !== null && daysToPause < 0);
        const grace = !paused && (pay.state === "grace" || (daysToDue !== null && daysToDue <= 0));
        const amount = money(pay.amount_cents, pay.currency);
        const plural = (n: number) => (n === 1 ? "" : "s");
        return (
          <div
            key={r.slug}
            className={cn(
              "flex items-center gap-3 border-b px-6 py-2 text-sm",
              paused || grace ? "bg-destructive/15 text-destructive" : "bg-warning/25 text-foreground",
            )}
            role="alert"
          >
            <Warning weight="fill" className="h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              {paused ? (
                <span>
                  <strong>{r.name}</strong> — <strong>services paused.</strong> {amount} is overdue
                  {due ? ` (due ${due})` : ""}. Pay now to resume.
                </span>
              ) : grace ? (
                <span>
                  <strong>{r.name}</strong> — payment overdue. Your services will{" "}
                  <strong>
                    pause in {daysToPause} day{plural(daysToPause as number)}
                  </strong>{" "}
                  unless {amount} is paid{due ? ` (was due ${due})` : ""}.
                </span>
              ) : (
                <span>
                  <strong>{r.name}</strong> — payment of {amount} due in{" "}
                  <strong>
                    {daysToDue} day{plural(daysToDue as number)}
                  </strong>
                  {due ? ` (by ${due})` : ""}.
                </span>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
              onClick={() =>
                setDismissed((d) => ({ ...d, [r.slug]: `${day}:${r.payment.due_date}` }))
              }
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
