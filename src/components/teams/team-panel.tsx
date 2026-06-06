"use client";

import * as React from "react";
import {
  CircleNotch,
  Copy,
  Envelope,
  ImageSquare,
  LinkSimple,
  UploadSimple,
  X,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { env } from "@/lib/env";
import { isTeamHead } from "@/lib/use-teams";
import { cn, relativeTime } from "@/lib/utils";
import type {
  BillingCycle,
  BillingData,
  Invite,
  Invitee,
  Team,
  TeamMembership,
} from "@/lib/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IdAvatar } from "@/components/profile/id-avatar";
import { ReactivityKpi } from "./reactivity-kpi";
import { CronList } from "./cron-list";
import type { Cron } from "@/lib/types";

export function TeamPanel({
  slug,
  onClose,
}: {
  slug: string;
  onClose?: () => void;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <TeamPanelBody key={slug} slug={slug} onClose={onClose} />
    </section>
  );
}

type TeamPanelTab = "overview" | "structure" | "members" | "crons" | "invites" | "settings" | "billing";

function TeamPanelBody({ slug, onClose }: { slug: string; onClose?: () => void }) {
  const [team, setTeam] = React.useState<Team | null>(null);
  const [members, setMembers] = React.useState<TeamMembership[]>([]);
  const [structureSvg, setStructureSvg] = React.useState<string>("");
  const [structureDsl, setStructureDsl] = React.useState<string>("");
  const [tab, setTab] = React.useState<TeamPanelTab>("overview");

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [t, m, s] = await Promise.all([
          api.team(slug),
          api.teamMembers(slug),
          api.teamStructure(slug),
        ]);
        if (!alive) return;
        setTeam(t);
        setMembers(m);
        setStructureSvg(s.svg || "");
        setStructureDsl(s.dsl || "");
      } catch (e) {
        if (alive) toast.error(e instanceof ApiError ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  if (!team) {
    return (
      <div className="grid flex-1 place-items-center text-muted-foreground">
        <CircleNotch className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const head = isTeamHead(team);
  const allTabs: Array<{ id: TeamPanelTab; label: string; headOnly?: boolean }> = [
    { id: "overview", label: "Overview" },
    { id: "structure", label: "Structure" },
    { id: "members", label: "Members" },
    { id: "crons", label: "Crons" },
    { id: "invites", label: "Invites", headOnly: true },
    { id: "settings", label: "Settings", headOnly: true },
    { id: "billing", label: "Billing", headOnly: true },
  ];
  const tabs = allTabs.filter((item) => !item.headOnly || head);

  return (
    <>
      <div className="flex min-h-[72px] items-center justify-between gap-3 border-b px-8">
        <div className="flex min-w-0 items-center gap-3">
          <IdAvatar seed={`team:${team.slug}`} src={team.logo_url} size={42} />
          <div className="min-w-0">
            <div className="truncate text-xl font-semibold">{team.name}</div>
            <div className="label-mono mt-1">{slug}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {onClose ? (
            <Button size="icon" variant="ghost" onClick={onClose} aria-label="close team">
              <X />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex h-12 shrink-0 items-stretch overflow-x-auto border-b px-6">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              "relative h-full shrink-0 px-4 text-sm font-medium transition-colors",
              tab === item.id
                ? "text-foreground after:absolute after:inset-x-4 after:bottom-[-1px] after:h-[3px] after:bg-black"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {tab === "overview" && (
          <div className="space-y-6">
            <ReactivityKpi slug={slug} className="w-full p-4 [&_span.font-mono]:text-3xl" />
            <div className="grid gap-6 xl:grid-cols-2">
              <MembersPreview members={members} onViewAll={() => setTab("members")} />
              <CronsSection limit={10} onViewAll={() => setTab("crons")} />
            </div>
          </div>
        )}
        {tab === "structure" && (
          <Section title="structure">
            {structureSvg ? (
              <div
                className="flex h-[min(74vh,820px)] min-h-[460px] items-center justify-center overflow-hidden border bg-card p-4 [&_svg]:max-h-full [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: structureSvg }}
              />
            ) : structureDsl ? (
              <QuarkStructureFrame dsl={structureDsl} />
            ) : (
              <p className="text-sm text-muted-foreground">No structure chart yet.</p>
            )}
          </Section>
        )}
        {tab === "members" && <MembersSection members={members} />}
        {tab === "crons" && <CronsSection />}
        {tab === "invites" && head && (
          <div className="space-y-6">
            <InviteSection slug={slug} />
            <InviteesSection slug={slug} />
          </div>
        )}
        {tab === "settings" && head && <SettingsSection team={team} onSaved={setTeam} />}
        {tab === "billing" && head && <BillingSection slug={slug} />}
      </div>
    </>
  );
}

function QuarkStructureFrame({ dsl }: { dsl: string }) {
  const srcDoc = React.useMemo(() => {
    const cssUrl = `${env.apiBase}/static/glass/quark/quark.css`;
    const jsUrl = `${env.apiBase}/static/glass/quark/quark.js`;
    const source = JSON.stringify(dsl).replace(/<\/script/gi, "<\\/script");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${cssUrl}" />
  <style>
    html, body { margin: 0; height: 100%; background: #ede8e0; overflow: hidden; }
    #stage { flex: 1 1 auto; min-height: 0; height: 100vh; width: 100vw; }
    #src, #dl, #png, #pdf { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
  </style>
</head>
<body>
  <textarea id="src" spellcheck="false"></textarea>
  <button id="dl"></button><button id="png"></button><button id="pdf"></button>
  <div class="stage" id="stage">
    <div class="viewport" id="viewport">
      <div class="canvas" id="canvas"><svg class="rough" id="rough" preserveAspectRatio="none"></svg></div>
    </div>
    <div class="zoombadge" id="zoombadge">100%</div>
    <div class="zoomctl">
      <button id="zin" title="Zoom in">+</button>
      <button id="zout" title="Zoom out">-</button>
      <button id="zfit" class="fit" title="Fit to screen">fit</button>
      <button id="zreset" class="fit" title="Reset to 100%">1:1</button>
    </div>
    <div class="err" id="err" style="display:none;"></div>
  </div>
  <script src="${jsUrl}"></script>
  <script>
    (function () {
      var source = ${source};
      function focusMain(attempts) {
        var svg = document.getElementById("rough");
        if (!window.Quark || !svg || !svg.children.length) {
          if (attempts > 0) window.setTimeout(function () { focusMain(attempts - 1); }, 100);
          return;
        }
        if (window.Quark.fitMain) window.Quark.fitMain();
        else if (window.Quark.fit) window.Quark.fit();
      }
      function apply() {
        if (window.Quark) {
          window.Quark.setSource(source || "");
          window.setTimeout(function () { focusMain(20); }, 80);
          window.setTimeout(function () { focusMain(1); }, 500);
        } else window.setTimeout(apply, 80);
      }
      apply();
    })();
  </script>
</body>
</html>`;
  }, [dsl]);

  return (
    <div className="h-[min(70vh,760px)] min-h-[420px] overflow-hidden border bg-card">
      <iframe
        title="team structure"
        srcDoc={srcDoc}
        className="h-full w-full"
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}

function MembersPreview({
  members,
  onViewAll,
}: {
  members: TeamMembership[];
  onViewAll: () => void;
}) {
  const preview = members.slice(0, 10);
  return (
    <Section title={`members · ${members.length}`}>
      {preview.length === 0 ? (
        <p className="border bg-muted/40 p-4 text-sm text-muted-foreground">No members in this team yet.</p>
      ) : (
        <ul className="divide-y border">
          {preview.map((m) => {
            const handle = m.member_handle ? `@${m.member_handle}` : `${m.member_kind} #${m.member_id}`;
            return (
              <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
                <span className="flex min-w-0 items-center gap-3">
                  <IdAvatar
                    seed={`${m.member_kind}:${m.member_handle ?? m.member_id}`}
                    src={m.member_photo_url}
                    size={32}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{handle}</span>
                    <span className="label-mono">{m.member_kind}</span>
                  </span>
                </span>
                <span className="label-mono shrink-0">{m.role}</span>
              </li>
            );
          })}
        </ul>
      )}
      {members.length > 10 ? (
        <Button variant="outline" size="sm" onClick={onViewAll}>
          View all members
        </Button>
      ) : null}
    </Section>
  );
}

function MembersSection({ members }: { members: TeamMembership[] }) {
  const [active, setActive] = React.useState<"carbon" | "silicon">("carbon");
  const carbons = members.filter((m) => m.member_kind === "carbon");
  const silicons = members.filter((m) => m.member_kind === "silicon");
  const rows = active === "carbon" ? carbons : silicons;

  return (
    <Section title={`members · ${members.length}`}>
      <div className="flex h-10 items-stretch border-b">
        <MemberTab
          active={active === "carbon"}
          count={carbons.length}
          label="Carbons"
          onClick={() => setActive("carbon")}
        />
        <MemberTab
          active={active === "silicon"}
          count={silicons.length}
          label="Silicons"
          onClick={() => setActive("silicon")}
        />
      </div>
      {rows.length === 0 ? (
        <p className="border px-3 py-6 text-sm text-muted-foreground">No {active}s in this team.</p>
      ) : (
        <ul className="divide-y border-x border-b">
          {rows.map((m) => {
            const handle = m.member_handle ? `@${m.member_handle}` : `${m.member_kind} #${m.member_id}`;
            return (
              <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
                <span className="flex min-w-0 items-center gap-3">
                  <IdAvatar
                    seed={`${m.member_kind}:${m.member_handle ?? m.member_id}`}
                    src={m.member_photo_url}
                    size={34}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{handle}</span>
                    <span className="label-mono">{m.member_kind}</span>
                  </span>
                </span>
                <span className="label-mono shrink-0">{m.role}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function MemberTab({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 border-x border-t px-4 text-sm font-medium transition-colors",
        active ? "bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      <span>{label}</span>
      <span className="text-xs opacity-70">{count}</span>
    </button>
  );
}

function fmtCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function monthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function BillingSection({ slug }: { slug: string }) {
  const [data, setData] = React.useState<BillingData | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const d = await api.teamBilling(slug);
      setData(d);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  }, [slug]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const payOutstanding = (cycleIds: number[]) => {
    const checkoutTab = window.open("about:blank", "_blank");
    if (checkoutTab) checkoutTab.opener = null;
    return run(async () => {
      if (cycleIds.length === 0) {
        checkoutTab?.close();
        toast.info("No pending balance.");
        return;
      }
      const r = await api.teamCheckout(slug, { cycle_ids: cycleIds, return_url: window.location.href });
      if (r.checkout_url) {
        if (checkoutTab) checkoutTab.location.href = r.checkout_url;
        else window.open(r.checkout_url, "_blank", "noopener,noreferrer");
      } else {
        checkoutTab?.close();
        toast.error(r.error || "Checkout unavailable.");
      }
    })();
  };

  if (!data) {
    return (
      <Section title="billing">
        <div className="grid place-items-center py-6 text-muted-foreground">
          <CircleNotch className="h-5 w-5 animate-spin" />
        </div>
      </Section>
    );
  }

  const unpaidCycles = data.cycles.filter((cycle) => cycle.status !== "paid");
  const pendingAmount =
    data.pending?.amount_cents ?? unpaidCycles.reduce((sum, cycle) => sum + cycle.total_cents, 0);
  const pendingCurrency = data.pending?.currency ?? data.plan.currency;
  const pendingCycleIds = data.pending?.cycle_ids ?? unpaidCycles.map((cycle) => cycle.id);
  const statusCopy = billingStatusCopy(data);

  return (
    <Section title="billing">
      <div className="space-y-6">
        <div className="grid gap-4 border bg-card p-5 md:grid-cols-[1fr_auto] md:items-end">
          <div className="space-y-3">
            <div className="label-mono">pending balance</div>
            <div className="font-mono text-5xl font-semibold leading-none tabular-nums">
              {fmtCents(pendingAmount, pendingCurrency)}
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">{statusCopy}</p>
          </div>
          <Button
            className="h-12 min-w-40"
            disabled={busy || pendingAmount <= 0}
            onClick={() => payOutstanding(pendingCycleIds)}
          >
            {pendingAmount > 0 ? `Pay ${fmtCents(pendingAmount, pendingCurrency)}` : "Paid up"}
          </Button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>ledger</Label>
            {data.cycles.length === 0 ? (
              <p className="border bg-muted/40 p-4 text-sm text-muted-foreground">
                No billing cycles yet.
              </p>
            ) : (
              data.cycles.map((c) => <CycleCard key={c.id} cycle={c} />)
            )}
          </div>

          <div className="border bg-background p-4">
            <Label>active add-ons</Label>
            {data.addons.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No active add-ons.</p>
            ) : (
              <ul className="mt-3 divide-y text-sm">
                {data.addons.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{a.label}</span>
                      <span className="label-mono">{a.recurring ? "recurring" : "one-time"}</span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {fmtCents(a.amount_cents, a.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function billingStatusCopy(data: BillingData): string {
  const payment = data.payment;
  if (payment.state === "paused") {
    return "Payment is overdue. Services are paused until the pending balance is cleared.";
  }
  if (payment.state === "grace") {
    return `Payment is due now. Services pause on ${payment.pause_date}.`;
  }
  if (payment.state === "warning") {
    return `Due ${longDueDate(payment.due_date)}; ${payment.days_left} day${payment.days_left === 1 ? "" : "s"} left.`;
  }
  if ((data.pending?.amount_cents ?? 0) > 0) {
    return payment.due_date ? `Due ${longDueDate(payment.due_date)}.` : "A balance is open.";
  }
  return "No pending balance. The ledger below is kept for audit.";
}

function longDueDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.getDate();
  const month = date.toLocaleDateString(undefined, { month: "long" });
  const year = date.getFullYear();
  return `${day} ${month}, ${year}`;
}

function CycleCard({ cycle }: { cycle: BillingCycle }) {
  const variant =
    cycle.status === "paid" ? "success" : cycle.status === "failed" ? "destructive" : "secondary";
  const payable = cycle.status !== "paid";
  return (
    <div className="border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">
          {monthLabel(cycle.period_start)}
          {cycle.due_date && payable && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">due {cycle.due_date}</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <Badge variant={variant}>{cycle.status}</Badge>
          <span className="tabular-nums text-sm font-semibold">
            {fmtCents(cycle.total_cents, cycle.currency)}
          </span>
        </span>
      </div>
      <ul className="divide-y text-sm">
        {cycle.records.map((r) => (
          <li key={r.id} className="flex items-center justify-between px-3 py-1.5">
            <span>
              {r.description}
              <span className="text-muted-foreground"> · {r.kind}</span>
            </span>
            <span className="tabular-nums text-muted-foreground">
              {fmtCents(r.amount_cents, r.currency)}
            </span>
          </li>
        ))}
        {cycle.records.length === 0 && (
          <li className="px-3 py-2 text-sm text-muted-foreground">No ledger lines.</li>
        )}
      </ul>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="label-mono">{title}</h3>
      {children}
    </section>
  );
}

function CronsSection({
  limit,
  onViewAll,
}: {
  limit?: number;
  onViewAll?: () => void;
}) {
  const [crons, setCrons] = React.useState<Cron[]>([]);
  const [loading, setLoading] = React.useState(true);
  const visible = limit ? crons.slice(0, limit) : crons;

  React.useEffect(() => {
    let alive = true;
    api
      .crons({ for: "me" })
      .then((rows) => alive && setCrons(rows))
      .catch(() => alive && setCrons([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Section title={`crons${loading ? "" : ` · ${crons.length}`}`}>
      <CronList crons={visible} loading={loading} showSilicon />
      {limit && crons.length > limit && onViewAll ? (
        <Button variant="outline" size="sm" onClick={onViewAll}>
          View all crons
        </Button>
      ) : null}
    </Section>
  );
}

function InviteesSection({ slug }: { slug: string }) {
  const [items, setItems] = React.useState<Invitee[]>([]);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(
    async (offset: number, limit: number) => {
      setBusy(true);
      try {
        const r = await api.teamInvitees(slug, offset, limit);
        setItems((prev) => (offset === 0 ? r.results : [...prev, ...r.results]));
        setTotal(r.total);
        setHasMore(r.has_more);
      } catch {
        /* ignore */
      }
      setBusy(false);
    },
    [slug],
  );

  React.useEffect(() => {
    void load(0, 5);
  }, [load]);

  return (
    <Section title={`recent invitees · ${total}`}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one has joined via invite yet.</p>
      ) : (
        <ul className="divide-y border">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>
                {i.member_handle ? `@${i.member_handle}` : i.member_kind}
                {i.invited_by ? (
                  <span className="text-muted-foreground"> · invited by @{i.invited_by}</span>
                ) : null}
                {i.silicon_name ? (
                  <span className="text-muted-foreground"> · {i.silicon_name}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(i.joined_at)}</span>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => load(items.length, 20)}
        >
          {busy && <CircleNotch className="animate-spin" />} load more
        </Button>
      )}
    </Section>
  );
}

function InviteSection({ slug }: { slug: string }) {
  const [invite, setInvite] = React.useState<Invite | null>(null);
  const [email, setEmail] = React.useState("");
  const [maxUses, setMaxUses] = React.useState(5);
  const [busy, setBusy] = React.useState(false);

  const make = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createLink = make(async () => {
    const inv = await api.createInvite(slug, { channel: "link", max_uses: maxUses });
    setInvite(inv);
  });

  const inviteByEmail = make(async () => {
    if (!email.includes("@")) {
      toast.error("Enter a valid email.");
      return;
    }
    await api.createInvite(slug, { channel: "email", email_target: email });
    toast.success(`invite sent to ${email}`);
    setEmail("");
  });

  const link = invite
    ? `${window.location.origin}/join/${invite.token}?code=${invite.code}`
    : "";

  return (
    <Section title="invites">
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="maxuses">seats per code</Label>
            <Input
              id="maxuses"
              type="number"
              min={1}
              value={maxUses}
              onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
              className="w-24"
            />
          </div>
          <Button onClick={createLink} disabled={busy}>
            {busy ? <CircleNotch className="animate-spin" /> : <LinkSimple />} create link
          </Button>
        </div>

        {invite && (
          <div className="space-y-1 border bg-card p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs">{link}</span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  navigator.clipboard.writeText(link);
                  toast.success("link copied");
                }}
              >
                <Copy />
              </Button>
            </div>
            <p className="text-muted-foreground">
              code <span className="font-mono text-foreground">{invite.code}</span> · rotates after{" "}
              {invite.max_uses} {invite.max_uses === 1 ? "join" : "joins"}
            </p>
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="invemail">invite by email</Label>
            <Input
              id="invemail"
              type="email"
              placeholder="person@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button variant="outline" onClick={inviteByEmail} disabled={busy}>
            <Envelope /> send
          </Button>
        </div>
      </div>
    </Section>
  );
}

type TeamSettingsDraft = {
  name: string;
  letInvite: boolean;
  verify: boolean;
  domains: string;
  emails: string;
};

function settingsDraftKey(slug: string): string {
  return `silicon-interface:team-settings:${slug}`;
}

function draftFromTeam(team: Team): TeamSettingsDraft {
  return {
    name: team.name,
    letInvite: team.settings.let_employees_invite,
    verify: team.settings.verify_carbons,
    domains: (team.email_whitelist.domains || []).join(", "),
    emails: (team.email_whitelist.emails || []).join(", "),
  };
}

function readSettingsDraft(team: Team): TeamSettingsDraft {
  const fallback = draftFromTeam(team);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(settingsDraftKey(team.slug));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<TeamSettingsDraft>;
    return {
      name: typeof parsed.name === "string" ? parsed.name : fallback.name,
      letInvite: typeof parsed.letInvite === "boolean" ? parsed.letInvite : fallback.letInvite,
      verify: typeof parsed.verify === "boolean" ? parsed.verify : fallback.verify,
      domains: typeof parsed.domains === "string" ? parsed.domains : fallback.domains,
      emails: typeof parsed.emails === "string" ? parsed.emails : fallback.emails,
    };
  } catch {
    return fallback;
  }
}

function sameSettingsDraft(a: TeamSettingsDraft, b: TeamSettingsDraft): boolean {
  return (
    a.name === b.name &&
    a.letInvite === b.letInvite &&
    a.verify === b.verify &&
    a.domains === b.domains &&
    a.emails === b.emails
  );
}

function SettingsSection({ team, onSaved }: { team: Team; onSaved: (t: Team) => void }) {
  const savedDraft = React.useMemo(() => draftFromTeam(team), [team]);
  const [draft, setDraft] = React.useState<TeamSettingsDraft>(() => readSettingsDraft(team));
  const [busy, setBusy] = React.useState(false);
  const [logoBusy, setLogoBusy] = React.useState(false);
  const dirty = !sameSettingsDraft(draft, savedDraft);

  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  React.useEffect(() => {
    setDraft(readSettingsDraft(team));
  }, [team.slug]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const key = settingsDraftKey(team.slug);
      if (dirty) window.localStorage.setItem(key, JSON.stringify(draft));
      else window.localStorage.removeItem(key);
    } catch {
      /* localStorage may be unavailable; the visible dirty marker still works */
    }
  }, [dirty, draft, team.slug]);

  const uploadLogo = async (file: File | null | undefined) => {
    if (!file) return;
    setLogoBusy(true);
    try {
      const updated = await api.uploadTeamLogo(team.slug, file);
      onSaved(updated);
      toast.success("team logo updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLogoBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const updated = await api.patchTeam(team.slug, {
        name: draft.name,
        settings: {
          ...team.settings,
          let_employees_invite: draft.letInvite,
          verify_carbons: draft.verify,
        },
        email_whitelist: { domains: split(draft.domains), emails: split(draft.emails) },
      });
      window.localStorage.removeItem(settingsDraftKey(team.slug));
      setDraft(draftFromTeam(updated));
      onSaved(updated);
      toast.success("settings saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="settings (heads only)">
      <div className="space-y-4">
        <div className="grid gap-4 border bg-card p-4 sm:grid-cols-[88px_1fr] sm:items-center">
          <div className="relative size-20 overflow-hidden border bg-background">
            <IdAvatar
              seed={`team:${team.slug}`}
              src={team.logo_url}
              size={80}
              className="border-0"
            />
            {logoBusy ? (
              <div className="absolute inset-0 grid place-items-center bg-background/75">
                <CircleNotch className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : null}
          </div>
          <div className="min-w-0 space-y-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ImageSquare className="h-4 w-4" />
                <Label htmlFor="team-logo">team logo</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                Upload a square mark for the team tab, sidebar, and Glass workspace.
              </p>
            </div>
            <Input
              id="team-logo"
              type="file"
              accept="image/*"
              className="sr-only"
              disabled={logoBusy}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                void uploadLogo(file);
              }}
            />
            <label
              htmlFor="team-logo"
              className={cn(
                "inline-flex h-10 cursor-pointer items-center gap-2 border bg-background px-4 text-sm font-medium transition-colors hover:bg-accent",
                logoBusy && "pointer-events-none opacity-60",
              )}
            >
              {logoBusy ? (
                <CircleNotch className="h-4 w-4 animate-spin" />
              ) : (
                <UploadSimple className="h-4 w-4" />
              )}
              change logo
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="teamname">team name</Label>
          <Input
            id="teamname"
            value={draft.name}
            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
          />
        </div>

        <Toggle
          label="Let employees invite"
          hint="Members can create invites to specific Silicons."
          on={draft.letInvite}
          onToggle={() => setDraft((prev) => ({ ...prev, letInvite: !prev.letInvite }))}
        />

        <Toggle
          label="Verify carbons before joining"
          hint="Require a whitelisted, verified email to join."
          on={draft.verify}
          onToggle={() => setDraft((prev) => ({ ...prev, verify: !prev.verify }))}
        />

        <div className={draft.verify ? "space-y-2" : "pointer-events-none space-y-2 opacity-50"}>
          <div className="space-y-1">
            <Label htmlFor="wldomains">allowed domains</Label>
            <Input
              id="wldomains"
              placeholder="acme.com, acme.io"
              value={draft.domains}
              onChange={(e) => setDraft((prev) => ({ ...prev, domains: e.target.value }))}
              disabled={!draft.verify}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wlemails">allowed emails</Label>
            <Input
              id="wlemails"
              placeholder="ceo@acme.com"
              value={draft.emails}
              onChange={(e) => setDraft((prev) => ({ ...prev, emails: e.target.value }))}
              disabled={!draft.verify}
            />
          </div>
          {!draft.verify && (
            <p className="text-xs text-muted-foreground">
              Enable “Verify carbons before joining” to use the whitelist.
            </p>
          )}
        </div>

        <Button onClick={save} disabled={busy} className="w-full">
          {busy && <CircleNotch className="animate-spin" />} save settings
        </Button>
        {dirty ? (
          <p className="label-mono text-center text-[11px] text-muted-foreground">
            unsaved settings
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function Toggle({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 border bg-card px-3 py-2 text-left transition-colors hover:bg-accent"
    >
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <span
        className={
          "relative h-5 w-9 shrink-0 border transition-colors " +
          (on ? "border-primary bg-primary" : "bg-background")
        }
      >
        <span
          className={
            "absolute top-0.5 h-3.5 w-3.5 transition-all " +
            (on ? "left-[18px] bg-primary-foreground" : "left-0.5 bg-foreground")
          }
        />
      </span>
    </button>
  );
}
