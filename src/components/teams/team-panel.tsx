"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import { Spinner } from "@/components/ui/spinner";
import { QRCodeSVG } from "qrcode.react";
import { safeSession } from "@/lib/safe-storage";
import type {
  BillingCycle,
  BillingData,
  Invite,
  Invitee,
  Team,
  TeamMembership,
  TeamServer,
} from "@/lib/types";
import { toastError } from "@/lib/errors";
import { useProvisionSocket, type ProvisionFrame } from "@/lib/use-provision";
import { RemoteTerminal, type RemoteTerminalHandle } from "./remote-terminal";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IdAvatar } from "@/components/profile/id-avatar";
import { ReactivityKpi } from "./reactivity-kpi";
import { CronList } from "./cron-list";
import type { Cron } from "@/lib/types";

export function TeamPanel({
  slug,
  onClose,
  initialTab,
}: {
  slug: string;
  onClose?: () => void;
  initialTab?: TeamPanelTab;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <TeamPanelBody key={slug} slug={slug} onClose={onClose} initialTab={initialTab} />
    </section>
  );
}

type TeamPanelTab = "overview" | "structure" | "members" | "crons" | "server" | "invites" | "settings" | "billing";

function TeamPanelBody({
  slug,
  onClose,
  initialTab,
}: {
  slug: string;
  onClose?: () => void;
  initialTab?: TeamPanelTab;
}) {
  const [team, setTeam] = React.useState<Team | null>(null);
  const [members, setMembers] = React.useState<TeamMembership[]>([]);
  const [structureSvg, setStructureSvg] = React.useState<string>("");
  const [structureDsl, setStructureDsl] = React.useState<string>("");
  const [tab, setTab] = React.useState<TeamPanelTab>(initialTab ?? "overview");

  // Honour a changed initialTab (e.g. "Pay now" deep-links to ?tab=billing
  // while this panel is already open) — the panel isn't remounted, so the
  // useState initializer alone wouldn't switch tabs.
  React.useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

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
        <Spinner className="text-lg" />
      </div>
    );
  }

  const head = isTeamHead(team);
  const allTabs: Array<{ id: TeamPanelTab; label: string; headOnly?: boolean }> = [
    { id: "overview", label: "Overview" },
    { id: "structure", label: "Structure" },
    { id: "members", label: "Members" },
    { id: "crons", label: "Crons" },
    { id: "server", label: "Server", headOnly: true },
    { id: "invites", label: "Invites", headOnly: true },
    { id: "settings", label: "Settings", headOnly: true },
    { id: "billing", label: "Billing", headOnly: true },
  ];
  const tabs = allTabs.filter((item) => !item.headOnly || head);

  return (
    <>
      <div className="flex min-h-[72px] items-center justify-between gap-3 border-b px-8">
        <div className="flex min-w-0 items-center gap-3">
          <IdAvatar seed={`team:${team.slug}`} src={team.logo_url} size={42} family="team" />
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
              <CronsSection slug={slug} limit={10} onViewAll={() => setTab("crons")} />
            </div>
          </div>
        )}
        {tab === "structure" && (
          <Section title="structure">
            {structureSvg ? (
              <SvgStructureFrame svg={structureSvg} />
            ) : structureDsl ? (
              <QuarkStructureFrame dsl={structureDsl} />
            ) : (
              <p className="text-sm text-muted-foreground">No structure chart yet.</p>
            )}
          </Section>
        )}
        {tab === "members" && <MembersSection members={members} />}
        {tab === "crons" && <CronsSection slug={slug} />}
        {tab === "server" && head && <ServerSection slug={slug} />}
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

// QA P0-3: the team-structure SVG is server-provided and was previously
// injected with `dangerouslySetInnerHTML` straight into the app origin — a
// stored-XSS path able to read the access token. We render it inside a
// sandboxed iframe instead. `sandbox=""` (no flags) means: no script execution
// (inline `<script>` / `onload=` handlers are inert) AND a unique null origin
// (no access to the parent's localStorage, cookies, or token). The image still
// renders; the attack surface is gone.
function SvgStructureFrame({ svg }: { svg: string }) {
  const srcDoc = React.useMemo(
    () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; height: 100%; }
    body { display: flex; align-items: center; justify-content: center; background: #ede8e0; overflow: hidden; }
    svg { max-width: 100%; max-height: 100%; }
  </style>
</head>
<body>${svg}</body>
</html>`,
    [svg],
  );
  return (
    <div className="h-[min(74vh,820px)] min-h-[460px] overflow-hidden border bg-card">
      <iframe
        title="team structure"
        srcDoc={srcDoc}
        className="h-full w-full"
        sandbox=""
      />
    </div>
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
        // Tell the parent we've actually rendered, so it can lift the cover that
        // hides Quark's internal "Loading rough.js…" flash during init.
        try { window.parent.postMessage({ type: "quark:ready" }, "*"); } catch (e) {}
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

  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = React.useState(false);

  // Keep an opaque cover over the iframe until Quark signals it has rendered, so
  // its internal "Loading rough.js…" flash never reaches the user. A timeout
  // fallback lifts the cover anyway (e.g. if Quark genuinely fails to load, so
  // its own error message becomes visible).
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === iframeRef.current?.contentWindow && e.data?.type === "quark:ready") {
        setReady(true);
      }
    };
    window.addEventListener("message", onMessage);
    const fallback = window.setTimeout(() => setReady(true), 6000);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(fallback);
    };
  }, []);

  return (
    <div className="relative h-[min(70vh,760px)] min-h-[420px] overflow-hidden border bg-card">
      <iframe
        ref={iframeRef}
        title="team structure"
        srcDoc={srcDoc}
        className="h-full w-full"
        sandbox="allow-scripts allow-same-origin"
      />
      {!ready && (
        <div className="absolute inset-0 grid place-items-center bg-card">
          <Spinner className="text-lg" />
        </div>
      )}
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
  const visibleMembers = members;
  const orderedMembers = [...visibleMembers].sort((a, b) => {
    if (a.member_kind !== b.member_kind) return a.member_kind === "carbon" ? -1 : 1;
    return teamMemberHandle(a).localeCompare(teamMemberHandle(b));
  });
  const preview = orderedMembers.slice(0, 10);
  return (
    <Section title={`members · ${visibleMembers.length}`}>
      {preview.length === 0 ? (
        <p className="border bg-muted/40 p-4 text-sm text-muted-foreground">No members in this team yet.</p>
      ) : (
        <ul className="divide-y border">
          {preview.map((m) => {
            const handle = teamMemberHandle(m);
            return (
              <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
                <span className="flex min-w-0 items-center gap-3">
                  <IdAvatar
                    seed={`${m.member_kind}:${m.member_handle ?? m.member_id}`}
                    src={m.member_photo_url}
                    size={32}
                    family={memberAvatarFamily(m)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{handle}</span>
                    <span className="label-mono">{m.member_kind}</span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="label-mono">{m.role}</span>
                  <MessageMemberButton member={m} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {visibleMembers.length > 10 ? (
        <Button variant="outline" size="sm" onClick={onViewAll}>
          View all members
        </Button>
      ) : null}
    </Section>
  );
}

function MembersSection({ members }: { members: TeamMembership[] }) {
  const [active, setActive] = React.useState<"carbon" | "silicon">("carbon");
  const visibleMembers = members;
  const carbons = visibleMembers.filter((m) => m.member_kind === "carbon");
  const silicons = visibleMembers.filter((m) => m.member_kind === "silicon");
  const rows = active === "carbon" ? carbons : silicons;

  return (
    <Section title={`members · ${visibleMembers.length}`}>
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
            const handle = teamMemberHandle(m);
            return (
              <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
                <span className="flex min-w-0 items-center gap-3">
                  <IdAvatar
                    seed={`${m.member_kind}:${m.member_handle ?? m.member_id}`}
                    src={m.member_photo_url}
                    size={34}
                    family={memberAvatarFamily(m)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{handle}</span>
                    <span className="label-mono">{m.member_kind}</span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="label-mono">{m.role}</span>
                  <MessageMemberButton member={m} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// Lords never reach the interface — Glass filters them out of members and
// heads server-side, so no client-side masking is needed.
function memberAvatarFamily(m: TeamMembership): "carbon" | "silicon" {
  return m.member_kind === "silicon" ? "silicon" : "carbon";
}

function teamMemberHandle(m: TeamMembership): string {
  const handle = m.member_handle || "";
  return handle ? `@${handle}` : `${m.member_kind} #${m.member_id}`;
}

// Opens (or reuses) a direct room with a team member and jumps to it. The
// member's public id isn't in the membership row, so we resolve it by handle —
// the same path the new-conversation dialog uses.
function MessageMemberButton({ member }: { member: TeamMembership }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const handle = member.member_handle;
  const kind = member.member_kind === "silicon" ? "silicon" : "carbon";
  const open = async () => {
    if (!handle) {
      toast.error("This member has no handle to message.");
      return;
    }
    setBusy(true);
    try {
      const target =
        kind === "carbon"
          ? await api.carbonByHandle(handle)
          : await api.siliconByHandle(handle);
      const id = "carbon_id" in target ? target.carbon_id : target.silicon_id;
      const room = await api.directRoom(kind, id);
      router.push(`/chat?room=${encodeURIComponent(room.room_id)}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={open} disabled={busy}>
      {busy ? <Spinner className="h-3.5 w-3.5" /> : "message"}
    </Button>
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

// §8c — render seat usage as a fixed-width mono meter `[####------] 3/10`.
function seatMeter(uses: number, maxUses: number): string {
  if (!maxUses || maxUses < 0) return `${uses} · ∞`;
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((uses / maxUses) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${uses}/${maxUses}`;
}

function fmtCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    // QA §3.9: the old fallback hardcoded "$" regardless of the actual
    // currency, so a EUR/GBP amount silently rendered as dollars when `Intl`
    // couldn't format it. Echo the real currency code instead of guessing a
    // symbol we may not have.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

// QA §3.7: `monthLabel` and `longDueDate` are the two date formatters on this
// surface and they used to disagree — `longDueDate` guarded NaN, this one did
// not, so a malformed `period_start` rendered "Invalid Date". Guard NaN here
// too and fall back to the raw string the same way `longDueDate` does, so the
// two helpers behave consistently.
function monthLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function BillingSection({ slug }: { slug: string }) {
  const [data, setData] = React.useState<BillingData | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [checkoutLoading, setCheckoutLoading] = React.useState(false);

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

  // §8e — "paid up" beat. We stash a flag before redirecting to checkout; on
  // return, if the balance is now clear, mark the moment instead of a silent
  // ledger refresh.
  React.useEffect(() => {
    if (!data) return;
    if (!safeSession.get(`si:checkout:${slug}`)) return;
    safeSession.remove(`si:checkout:${slug}`);
    if (!data.pending || (data.pending.amount_cents ?? 0) === 0) {
      toast.success("> balance cleared");
    }
  }, [data, slug]);

  // QA P0-4: checkout had no idempotency. A lost response after the server
  // committed the charge, followed by a retry, could double-charge. We keep a
  // stable key per cycle-set for the life of this panel so every retry of the
  // *same* outstanding balance carries the same token and the server dedupes.
  const idempotencyKeys = React.useRef<Map<string, string>>(new Map());
  const keyFor = (cycleIds: number[]) => {
    const sig = [...cycleIds].sort((a, b) => a - b).join(",");
    let key = idempotencyKeys.current.get(sig);
    if (!key) {
      key =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${slug}:${sig}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      idempotencyKeys.current.set(sig, key);
    }
    return key;
  };

  const payOutstanding = async (cycleIds: number[]) => {
    if (busy) return; // guard against a second concurrent submit
    if (cycleIds.length === 0) {
      toast.info("No pending balance.");
      return;
    }
    setBusy(true);
    setCheckoutLoading(true);
    try {
      const r = await api.teamCheckout(slug, {
        cycle_ids: cycleIds,
        return_url: window.location.href,
        idempotency_key: keyFor(cycleIds),
      });
      if (r.checkout_url) {
        // Navigation is starting. Deliberately leave the button disabled (do
        // NOT reset busy/checkoutLoading) so a second click can't fire another
        // checkout during the redirect.
        safeSession.set(`si:checkout:${slug}`, "1"); // §8e — celebrate on return
        window.location.assign(r.checkout_url);
        return;
      }
      // QA §3.5: in demo/staging the server settles the charge itself and
      // returns `dev_mode: true` with no checkout_url. Previously this fell
      // through to "Checkout unavailable." — a confusing error in front of a
      // prospective client. Treat it as a simulated success and refresh the
      // ledger so the cycle flips to paid.
      if (r.dev_mode) {
        setCheckoutLoading(false);
        setBusy(false);
        toast.success("Payment simulated (dev mode).");
        void load();
        return;
      }
      setCheckoutLoading(false);
      setBusy(false);
      toast.error(r.error || "Checkout unavailable.");
    } catch (e) {
      setCheckoutLoading(false);
      setBusy(false);
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!data) {
    return (
      <Section title="billing">
        <div className="grid place-items-center py-6 text-muted-foreground">
          <Spinner className="text-base" />
        </div>
      </Section>
    );
  }

  // QA §3.2 + §3.3: figuring out what is *actually payable*.
  //
  // §3.3 — `status !== "paid"` used to sweep `open` (unbilled) cycles into the
  // payable set, so a head could be asked to pre-pay an unbilled cycle or the
  // checkout would 400 on an `open` id. When the server tells us exactly what's
  // pending via `data.pending`, we trust it *exclusively*. Only when `pending`
  // is absent do we fall back to deriving payable cycles ourselves, and in that
  // fallback only `charged`/`failed` cycles are payable — never `open`/`paid`.
  //
  // §3.2 — `reduce((s,c)=>s+c.total_cents,0)` summed cents *across currencies*
  // and formatted the sum with one currency, so a USD plan with a EUR add-on
  // cycle produced a silently wrong total. We never sum mixed currencies into a
  // single figure: we group the payable cycles by currency. If everything
  // shares one currency we show a single total as before; if multiple
  // currencies are present we render them stacked and disable the single Pay
  // button (the checkout endpoint settles one currency at a time).
  const payableCycles = data.pending
    ? // Trust the server's pending set verbatim — resolve the cycle objects so
      // we can group/total them by currency for display.
      data.pending.cycle_ids
        .map((id) => data.cycles.find((c) => c.id === id))
        .filter((c): c is BillingCycle => Boolean(c))
    : // Fallback: only charged/failed cycles are genuinely payable.
      data.cycles.filter((c) => c.status === "charged" || c.status === "failed");

  // Group the payable cycles by currency so we never conflate them.
  const byCurrency = new Map<string, { cycleIds: number[]; amountCents: number }>();
  for (const c of payableCycles) {
    const bucket = byCurrency.get(c.currency) ?? { cycleIds: [], amountCents: 0 };
    bucket.cycleIds.push(c.id);
    bucket.amountCents += c.total_cents;
    byCurrency.set(c.currency, bucket);
  }
  const currencyGroups = [...byCurrency.entries()].map(([currency, g]) => ({
    currency,
    ...g,
  }));
  const mixedCurrencies = currencyGroups.length > 1;

  // The headline figure. Prefer the server's `pending` (it's authoritative and
  // single-currency by construction); only fall back to a locally-derived total
  // when there's exactly one currency in play — never sum across currencies.
  const singleGroup = currencyGroups.length === 1 ? currencyGroups[0] : null;
  const pendingAmount = data.pending?.amount_cents ?? singleGroup?.amountCents ?? 0;
  const pendingCurrency = data.pending?.currency ?? singleGroup?.currency ?? data.plan.currency;
  const pendingCycleIds = data.pending?.cycle_ids ?? singleGroup?.cycleIds ?? [];
  const statusCopy = billingStatusCopy(data);

  return (
    <Section title="billing">
      <div className="space-y-6">
        <div className="grid gap-4 border bg-card p-5 md:grid-cols-[1fr_auto] md:items-end">
          <div className="min-w-0 space-y-3">
            <div className="label-mono">pending balance</div>
            {mixedCurrencies ? (
              // Multiple currencies: render each separately. `break-words`/the
              // min-w-0 parent keep a huge total from blowing out the layout
              // (QA §3.9 width clamp).
              <ul className="space-y-1">
                {currencyGroups.map((g) => (
                  <li
                    key={g.currency}
                    className="font-mono text-3xl font-semibold leading-none tabular-nums break-words"
                  >
                    {fmtCents(g.amountCents, g.currency)}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="font-mono text-5xl font-semibold leading-none tabular-nums break-words">
                {fmtCents(pendingAmount, pendingCurrency)}
              </div>
            )}
            <p className="max-w-2xl text-sm text-muted-foreground">
              {statusCopy}
              {mixedCurrencies ? (
                <>
                  {" "}
                  This balance spans multiple currencies; pay each currency
                  separately from its cycle below.
                </>
              ) : null}
            </p>
          </div>
          <Button
            className="h-12 min-w-40"
            // §3.2: with mixed currencies the single Pay button can't represent
            // a correct total, so we disable it and direct the head to the
            // per-cycle rows (the endpoint settles one currency at a time).
            disabled={busy || mixedCurrencies || pendingAmount <= 0}
            onClick={() => payOutstanding(pendingCycleIds)}
          >
            {checkoutLoading ? (
              <>
                <Spinner /> loading
              </>
            ) : mixedCurrencies ? (
              "Pay below"
            ) : pendingAmount > 0 ? (
              `Pay ${fmtCents(pendingAmount, pendingCurrency)}`
            ) : (
              "Paid up"
            )}
          </Button>
        </div>
        {checkoutLoading ? (
          <div className="border bg-background p-3 text-sm text-muted-foreground">
            Preparing checkout. You will be redirected once the payment link is ready.
          </div>
        ) : null}

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
    // QA §3.7: the panel and the banner used to show two different countdowns
    // at once — the banner recomputes from `due_date` while the panel printed
    // `payment.days_left` verbatim from a possibly-stale snapshot. Recompute
    // here from `due_date` so both surfaces agree; fall back to the snapshot
    // only when there's no usable date.
    const left = daysLeftFromDue(payment.due_date) ?? payment.days_left;
    if (left === null) return `Due ${longDueDate(payment.due_date)}.`;
    return `Due ${longDueDate(payment.due_date)}; ${left} day${left === 1 ? "" : "s"} left.`;
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

// QA §3.7: derive the live day-count from a due date so the panel and the
// payment banner never show two disagreeing countdowns. Mirrors the banner's
// `daysUntil` (local-midnight delta) and returns null for missing/NaN input so
// callers can fall back gracefully.
function daysLeftFromDue(iso: string | null): number | null {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function CycleCard({ cycle }: { cycle: BillingCycle }) {
  // QA §3.10: `open` and `charged` both mapped to "secondary" and were visually
  // indistinguishable, yet they mean very different things — `open` is an
  // unbilled cycle still accruing (not yet payable), while `charged` is billed
  // and awaiting payment. Give them distinct treatments: `charged` uses the
  // warning style (action needed) and `open` stays a quiet outline (nothing to
  // do yet). `paid`/`failed` keep their existing success/destructive.
  const variant =
    cycle.status === "paid"
      ? "success"
      : cycle.status === "failed"
        ? "destructive"
        : cycle.status === "charged"
          ? "warning"
          : "outline";
  // QA §3.3: only charged/failed cycles are genuinely payable; an `open` cycle
  // is not yet due, so we don't surface its (provisional) due date as if it
  // were owed.
  const payable = cycle.status === "charged" || cycle.status === "failed";
  return (
    <div className="border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">
          {monthLabel(cycle.period_start)}
          {cycle.due_date && payable && (
            // QA §3.7: route the due date through `longDueDate` (the same nice
            // formatter the banner uses) instead of dumping the raw ISO string.
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              due {longDueDate(cycle.due_date)}
            </span>
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
  slug,
  limit,
  onViewAll,
}: {
  slug: string;
  limit?: number;
  onViewAll?: () => void;
}) {
  const [crons, setCrons] = React.useState<Cron[]>([]);
  const [loading, setLoading] = React.useState(true);
  const visible = limit ? crons.slice(0, limit) : crons;

  React.useEffect(() => {
    let alive = true;
    // §3.6 — scope to the team being viewed: crons owned by this team's
    // silicons (backend `?team=<slug>` filter), not the viewer's own crons.
    setLoading(true);
    api
      .crons({ team: slug })
      .then((rows) => alive && setCrons(rows))
      .catch(() => alive && setCrons([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug]);

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
  const [invites, setInvites] = React.useState<Invite[]>([]);
  const [emailInvites, setEmailInvites] = React.useState<Invite[]>([]);
  const [email, setEmail] = React.useState("");
  const [maxUses, setMaxUses] = React.useState(5);
  const [busy, setBusy] = React.useState(false);
  const [linksOpen, setLinksOpen] = React.useState(false);
  const [invitationsOpen, setInvitationsOpen] = React.useState(false);
  const [newInviteOpen, setNewInviteOpen] = React.useState(false);
  const [newInvite, setNewInvite] = React.useState<Invite | null>(null);

  const loadInvites = React.useCallback(async () => {
    const rows = await api.teamInvites(slug);
    setInvites(rows.filter((i) => i.channel === "link"));
    setEmailInvites(rows.filter((i) => i.channel === "email"));
  }, [slug]);

  React.useEffect(() => {
    const id = window.setTimeout(() => {
      void loadInvites().catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)));
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadInvites]);

  const make = <Args extends unknown[]>(fn: (...args: Args) => Promise<void>) => async (...args: Args) => {
    setBusy(true);
    try {
      await fn(...args);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createLink = make(async () => {
    const invite = await api.createInvite(slug, { channel: "link", max_uses: maxUses });
    setNewInvite(invite);
    setNewInviteOpen(true);
    await loadInvites();
  });

  const inviteByEmail = make(async () => {
    if (!email.includes("@")) {
      toast.error("Enter a valid email.");
      return;
    }
    await api.createInvite(slug, { channel: "email", email_target: email });
    toast.success(`invite sent to ${email}`);
    setEmail("");
    await loadInvites();
  });

  const disableInvite = make(async (invite: Invite) => {
    const ok = window.confirm("Disable this invite link? This cannot be reversed.");
    if (!ok) return;
    const updated = await api.disableInvite(slug, invite.id);
    setInvites((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    toast.success("invite link disabled");
  });

  const inviteLink = (invite: Invite) =>
    `${typeof window === "undefined" ? "" : window.location.origin}/join/${invite.token}?code=${invite.code}`;

  const renderInviteCard = (invite: Invite, compact = false) => {
    const link = inviteLink(invite);
    return (
      <div
        key={invite.id}
        className={cn("w-full min-w-0 max-w-full overflow-hidden border bg-background", !invite.is_active && "opacity-60")}
      >
        <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              navigator.clipboard.writeText(link);
              toast.success("link copied");
            }}
            aria-label="copy invite link"
          >
            <Copy />
          </Button>
          {!compact ? (
            <Button
              size="sm"
              variant={invite.is_active ? "destructive" : "ghost"}
              className="shrink-0"
              disabled={busy || !invite.is_active}
              onClick={() => disableInvite(invite)}
            >
              {invite.is_active ? "disable" : "disabled"}
            </Button>
          ) : null}
        </div>
        <div className="grid grid-cols-1 divide-y text-sm sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="min-w-0 p-3">
            <div className="label-mono">code</div>
            <div className="mt-1 font-mono text-xl font-semibold">{invite.code}</div>
          </div>
          <div className="min-w-0 p-3">
            <div className="label-mono">seats</div>
            {/* §8c — usage as a mono meter instead of a bare "seats left". */}
            <div className="mt-1 truncate font-mono text-sm font-semibold tabular-nums">
              {seatMeter(invite.uses, invite.max_uses)}
            </div>
          </div>
          <div className="min-w-0 p-3">
            <div className="label-mono">status</div>
            <div className="mt-1 font-mono text-sm font-semibold">
              {invite.is_active ? "active" : "disabled"}
            </div>
          </div>
        </div>
        {/* §8b — a scannable QR for in-person onboarding (brand beige/ink). */}
        {invite.is_active ? (
          <div className="flex items-center justify-center border-t p-3">
            <QRCodeSVG value={link} size={92} bgColor="#ede8e0" fgColor="#111111" level="M" />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <Section title="invites">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="border bg-card">
          <div className="flex items-center gap-3 border-b p-4">
            <div className="grid size-10 place-items-center border bg-background">
              <LinkSimple className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h4 className="font-semibold">Shareable link</h4>
              <p className="text-sm text-muted-foreground">Create a rotating join code for a limited number of seats.</p>
            </div>
          </div>
          <div className="space-y-4 p-4">
            <div className="flex items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="maxuses">seats</Label>
                <Input
                  id="maxuses"
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
                  className="h-11 w-24 text-center font-mono"
                />
              </div>
              <Button onClick={createLink} disabled={busy} className="h-11 flex-1">
                {busy ? <CircleNotch className="animate-spin" /> : <LinkSimple />} create link
              </Button>
            </div>

            <div className="border border-dashed bg-background/50 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {invites.length > 0
                    ? `${invites.length} generated invite link${invites.length === 1 ? "" : "s"}.`
                    : "Generated invite links will appear here."}
                </span>
                {invites.length > 0 ? (
                  <Dialog open={linksOpen} onOpenChange={setLinksOpen}>
                    <DialogTrigger asChild>
                      <Button variant="link" size="sm" className="h-auto p-0 text-xs">
                        view all generated links
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl overflow-hidden">
                      <DialogHeader>
                        <DialogTitle>Generated invite links</DialogTitle>
                        <DialogDescription>
                          Disable is permanent. Create a new link if you need seats again.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
                        {invites.map((invite) => renderInviteCard(invite))}
                      </div>
                    </DialogContent>
                  </Dialog>
                ) : null}
              </div>
            </div>

            <Dialog open={newInviteOpen} onOpenChange={setNewInviteOpen}>
              <DialogContent className="w-[calc(100vw-2rem)] max-w-xl overflow-hidden">
                <DialogHeader>
                  <DialogTitle>Invite link created</DialogTitle>
                  <DialogDescription>
                    Share this link or code now. All generated links stay under the generated-links view.
                  </DialogDescription>
                </DialogHeader>
                {newInvite ? renderInviteCard(newInvite, true) : null}
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => setNewInviteOpen(false)}>
                    done
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="border bg-card">
          <div className="flex items-center gap-3 border-b p-4">
            <div className="grid size-10 place-items-center border bg-background">
              <Envelope className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h4 className="font-semibold">Email invite</h4>
              <p className="text-sm text-muted-foreground">Send a targeted one-time invite to a specific carbon.</p>
            </div>
          </div>
          <div className="space-y-3 p-4">
            <div className="space-y-1">
              <Label htmlFor="invemail">email</Label>
              <Input
                id="invemail"
                type="email"
                placeholder="person@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11"
              />
            </div>
            <Button variant="outline" onClick={inviteByEmail} disabled={busy} className="h-11 w-full">
              {busy ? <CircleNotch className="animate-spin" /> : <Envelope />} send invite
            </Button>

            <div className="border border-dashed bg-background/50 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {emailInvites.length > 0
                    ? `${emailInvites.length} email invitation${emailInvites.length === 1 ? "" : "s"} sent.`
                    : "Email invitations you send will appear here."}
                </span>
                {emailInvites.length > 0 ? (
                  <Dialog open={invitationsOpen} onOpenChange={setInvitationsOpen}>
                    <DialogTrigger asChild>
                      <Button variant="link" size="sm" className="h-auto p-0 text-xs">
                        View all invitations
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="w-[calc(100vw-2rem)] max-w-lg overflow-hidden">
                      <DialogHeader>
                        <DialogTitle>Email invitations</DialogTitle>
                        <DialogDescription>
                          Everyone you&apos;ve invited by email, and who has accepted.
                        </DialogDescription>
                      </DialogHeader>
                      <ul className="max-h-[60vh] divide-y overflow-y-auto border">
                        {emailInvites.map((inv) => {
                          const accepted = !!inv.claimed_at || inv.uses > 0;
                          return (
                            <li
                              key={inv.id}
                              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                {inv.email_target || "—"}
                              </span>
                              {accepted ? (
                                <span className="shrink-0 text-xs font-medium text-foreground">
                                  accepted
                                  {inv.claimed_at ? (
                                    <span className="text-muted-foreground">
                                      {" "}
                                      · {relativeTime(inv.claimed_at)}
                                    </span>
                                  ) : null}
                                </span>
                              ) : (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {inv.is_active ? "pending" : "expired"}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </DialogContent>
                  </Dialog>
                ) : null}
              </div>
            </div>
          </div>
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
              family="team"
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

// --- Server tab: manage team servers + a live remote terminal --------------
function ServerSection({ slug }: { slug: string }) {
  const [servers, setServers] = React.useState<TeamServer[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [terminalFor, setTerminalFor] = React.useState<TeamServer | null>(null);

  const load = React.useCallback(() => {
    void api
      .teamServers(slug)
      .then(setServers)
      .catch((e) => {
        toastError(e);
        setServers([]);
      });
  }, [slug]);

  React.useEffect(load, [load]);

  const remove = async (id: number) => {
    try {
      await api.deleteTeamServer(slug, id);
      if (terminalFor?.id === id) setTerminalFor(null);
      load();
    } catch (e) {
      toastError(e);
    }
  };

  if (terminalFor) {
    return (
      <ServerTerminal
        slug={slug}
        server={terminalFor}
        onBack={() => setTerminalFor(null)}
      />
    );
  }

  return (
    <Section title="servers">
      {servers === null ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No servers yet. Add one to open a live terminal to it.
        </p>
      ) : (
        <ul className="divide-y border">
          {servers.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {s.username}@{s.hostname}
                  <span className="text-muted-foreground">:{s.port}</span>
                </div>
                <div className="label-mono">{s.secret_kind}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={() => setTerminalFor(s)}>
                  Open terminal
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(s.id)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddServerForm slug={slug} onDone={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setAdding(true)}>
          Add a server
        </Button>
      )}
    </Section>
  );
}

function AddServerForm({
  slug,
  onDone,
  onCancel,
}: {
  slug: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [hostname, setHostname] = React.useState("");
  const [port, setPort] = React.useState("22");
  const [username, setUsername] = React.useState("ubuntu");
  const [secretKind, setSecretKind] = React.useState<"pem" | "password">("pem");
  const [secret, setSecret] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const readPem = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSecret(String(reader.result || ""));
    reader.readAsText(file);
  };

  const save = async () => {
    if (!hostname.trim() || !secret.trim()) return;
    setBusy(true);
    try {
      await api.createTeamServer(slug, {
        hostname: hostname.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        secret_kind: secretKind,
        secret,
      });
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 border p-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <div>
          <Label htmlFor="s-host">Host</Label>
          <Input id="s-host" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="203.0.113.4" />
        </div>
        <div className="w-20">
          <Label htmlFor="s-port">Port</Label>
          <Input id="s-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </div>
        <div>
          <Label htmlFor="s-user">User</Label>
          <Input id="s-user" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant={secretKind === "pem" ? "default" : "outline"} onClick={() => setSecretKind("pem")}>
          PEM key
        </Button>
        <Button size="sm" variant={secretKind === "password" ? "default" : "outline"} onClick={() => setSecretKind("password")}>
          Password
        </Button>
      </div>
      {secretKind === "pem" ? (
        <>
          <label className="flex cursor-pointer items-center gap-2 border bg-background px-3 py-2 text-sm">
            {secret ? "PEM loaded ✓" : "Upload .pem key"}
            <input type="file" accept=".pem,.key,text/plain" className="sr-only" onChange={(e) => readPem(e.target.files?.[0] ?? null)} />
          </label>
          <textarea
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            rows={3}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            className="w-full resize-y border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </>
      ) : (
        <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="password" />
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={busy || !hostname.trim() || !secret.trim()}>
          {busy ? <Spinner /> : "Save server"}
        </Button>
      </div>
    </div>
  );
}

function ServerTerminal({
  slug,
  server,
  onBack,
}: {
  slug: string;
  server: TeamServer;
  onBack: () => void;
}) {
  const termRef = React.useRef<RemoteTerminalHandle>(null);
  const [sessionId, setSessionId] = React.useState<string | null>(null);

  // The terminal rides the provisioning socket, which needs a SetupSession bound
  // to this server. Mint an ephemeral one for the terminal's lifetime.
  React.useEffect(() => {
    let active = true;
    void api
      .createSetupSession(slug, { server_id: server.id })
      .then((s) => {
        if (active) setSessionId(s.session_id);
      })
      .catch(toastError);
    return () => {
      active = false;
    };
  }, [slug, server.id]);

  const onFrame = React.useCallback((f: ProvisionFrame) => {
    if (f.type === "terminal.output") termRef.current?.write(f.data);
    else if (f.type === "terminal.closed") termRef.current?.write("\r\n[session closed]\r\n");
    else if (f.type === "error") toastError(f.detail);
  }, []);

  const { ready, send } = useProvisionSocket({ sessionId, onFrame });

  React.useEffect(() => {
    if (ready) send({ type: "terminal_open", cols: 100, rows: 30 });
  }, [ready, send]);

  return (
    <Section title={`terminal · ${server.username}@${server.hostname}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="label-mono text-muted-foreground">{ready ? "live" : "connecting…"}</span>
        <Button size="sm" variant="ghost" onClick={onBack}>Back to servers</Button>
      </div>
      <div className="h-[440px] overflow-hidden border">
        <RemoteTerminal
          ref={termRef}
          onData={(d) => send({ type: "terminal_input", data: d })}
          onResize={(cols, rows) => send({ type: "terminal_resize", cols, rows })}
        />
      </div>
    </Section>
  );
}
