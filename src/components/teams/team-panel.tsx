"use client";

import * as React from "react";
import { CircleNotch, Copy, Envelope, LinkSimple, X } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
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

type TeamPanelTab = "structure" | "members" | "crons" | "invites" | "settings" | "billing";

function TeamPanelBody({ slug, onClose }: { slug: string; onClose?: () => void }) {
  const [team, setTeam] = React.useState<Team | null>(null);
  const [members, setMembers] = React.useState<TeamMembership[]>([]);
  const [structure, setStructure] = React.useState<string>("");
  const [tab, setTab] = React.useState<TeamPanelTab>("structure");

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
        setStructure(s.svg || "");
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
        <div className="min-w-0">
          <div className="truncate text-xl font-semibold">{team.name}</div>
          <div className="label-mono mt-1">{slug}</div>
        </div>
        <div className="flex items-center gap-3">
          <ReactivityKpi slug={slug} className="hidden w-40 p-3 sm:block [&_span.font-mono]:text-2xl" />
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
              "shrink-0 border-b-2 px-4 text-sm font-medium transition-colors",
              tab === item.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {tab === "structure" && (
          <Section title="structure">
            {structure ? (
              <div
                className="overflow-x-auto border bg-card p-4 [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: structure }}
              />
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
  const [planUsd, setPlanUsd] = React.useState("");
  const [addonLabel, setAddonLabel] = React.useState("");
  const [addonUsd, setAddonUsd] = React.useState("");
  const [addonRecurring, setAddonRecurring] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const d = await api.teamBilling(slug);
      setData(d);
      setPlanUsd((d.plan.monthly_cost_cents / 100).toString());
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

  const savePlan = run(async () => {
    await api.setTeamPlan(slug, Math.round((Number(planUsd) || 0) * 100));
    await load();
    toast.success("plan updated · applies to future cycles");
  });

  const addAddon = run(async () => {
    if (!addonLabel.trim() || !(Number(addonUsd) > 0)) {
      toast.error("Enter a label and amount.");
      return;
    }
    await api.addTeamAddon(slug, {
      label: addonLabel.trim(),
      amount_cents: Math.round(Number(addonUsd) * 100),
      recurring: addonRecurring,
    });
    setAddonLabel("");
    setAddonUsd("");
    await load();
  });

  const rollNow = run(async () => {
    await api.rollTeamCycle(slug);
    await load();
    toast.success("cycle rolled");
  });

  const payCycle = (cycleId: number) =>
    run(async () => {
      const r = await api.teamCheckout(slug, { cycle_id: cycleId, return_url: window.location.href });
      if (r.checkout_url) window.location.href = r.checkout_url;
      else toast.error(r.error || "Checkout unavailable.");
    })();

  if (!data) {
    return (
      <Section title="billing">
        <div className="grid place-items-center py-6 text-muted-foreground">
          <CircleNotch className="h-5 w-5 animate-spin" />
        </div>
      </Section>
    );
  }

  return (
    <Section title="billing (heads only)">
      <div className="space-y-4">
        {/* plan */}
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="plan">monthly plan (USD)</Label>
            <Input
              id="plan"
              type="number"
              min={0}
              step="0.01"
              value={planUsd}
              onChange={(e) => setPlanUsd(e.target.value)}
              className="w-32"
            />
          </div>
          <Button onClick={savePlan} disabled={busy}>
            save
          </Button>
          <span className="ml-auto flex gap-2">
            <Button variant="outline" onClick={rollNow} disabled={busy}>
              roll cycle
            </Button>
          </span>
        </div>

        {/* add-ons */}
        <div className="space-y-2">
          <Label>add-ons</Label>
          {data.addons.length > 0 && (
            <ul className="divide-y border text-sm">
              {data.addons.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-3 py-1.5">
                  <span>
                    {a.label}{" "}
                    <span className="text-muted-foreground">
                      · {a.recurring ? "recurring" : "one-time"}
                    </span>
                  </span>
                  <span className="tabular-nums">{fmtCents(a.amount_cents, a.currency)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <Input
              placeholder="label"
              value={addonLabel}
              onChange={(e) => setAddonLabel(e.target.value)}
              className="flex-1"
            />
            <Input
              type="number"
              min={0}
              step="0.01"
              placeholder="USD"
              value={addonUsd}
              onChange={(e) => setAddonUsd(e.target.value)}
              className="w-24"
            />
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={addonRecurring}
                onChange={(e) => setAddonRecurring(e.target.checked)}
              />
              recurring
            </label>
            <Button variant="outline" onClick={addAddon} disabled={busy}>
              add
            </Button>
          </div>
        </div>

        {/* ledger */}
        <div className="space-y-2">
          <Label>ledger</Label>
          {data.cycles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No billing cycles yet.</p>
          ) : (
            data.cycles.map((c) => (
              <CycleCard key={c.id} cycle={c} busy={busy} onPay={() => payCycle(c.id)} />
            ))
          )}
        </div>
      </div>
    </Section>
  );
}

function CycleCard({ cycle, busy, onPay }: { cycle: BillingCycle; busy: boolean; onPay: () => void }) {
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
      </ul>
      {payable && (
        <div className="border-t px-3 py-2">
          <Button className="w-full" onClick={onPay} disabled={busy}>
            Pay {fmtCents(cycle.total_cents, cycle.currency)} now
          </Button>
        </div>
      )}
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

function CronsSection() {
  const [crons, setCrons] = React.useState<Cron[]>([]);
  const [loading, setLoading] = React.useState(true);

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
    <Section title="crons">
      <CronList crons={crons} loading={loading} showSilicon />
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

function SettingsSection({ team, onSaved }: { team: Team; onSaved: (t: Team) => void }) {
  const [name, setName] = React.useState(team.name);
  const [letInvite, setLetInvite] = React.useState(team.settings.let_employees_invite);
  const [verify, setVerify] = React.useState(team.settings.verify_carbons);
  const [domains, setDomains] = React.useState((team.email_whitelist.domains || []).join(", "));
  const [emails, setEmails] = React.useState((team.email_whitelist.emails || []).join(", "));
  const [busy, setBusy] = React.useState(false);

  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    setBusy(true);
    try {
      const updated = await api.patchTeam(team.slug, {
        name,
        settings: { ...team.settings, let_employees_invite: letInvite, verify_carbons: verify },
        email_whitelist: { domains: split(domains), emails: split(emails) },
      });
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
        <div className="space-y-1">
          <Label htmlFor="teamname">team name</Label>
          <Input id="teamname" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <Toggle
          label="Let employees invite"
          hint="Members can create invites to specific Silicons."
          on={letInvite}
          onToggle={() => setLetInvite((v) => !v)}
        />

        <Toggle
          label="Verify carbons before joining"
          hint="Require a whitelisted, verified email to join."
          on={verify}
          onToggle={() => setVerify((v) => !v)}
        />

        <div className={verify ? "space-y-2" : "pointer-events-none space-y-2 opacity-50"}>
          <div className="space-y-1">
            <Label htmlFor="wldomains">allowed domains</Label>
            <Input
              id="wldomains"
              placeholder="acme.com, acme.io"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              disabled={!verify}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wlemails">allowed emails</Label>
            <Input
              id="wlemails"
              placeholder="ceo@acme.com"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              disabled={!verify}
            />
          </div>
          {!verify && (
            <p className="text-xs text-muted-foreground">
              Enable “Verify carbons before joining” to use the whitelist.
            </p>
          )}
        </div>

        <Button onClick={save} disabled={busy} className="w-full">
          {busy && <CircleNotch className="animate-spin" />} save settings
        </Button>
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
