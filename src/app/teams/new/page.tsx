"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  Plugs,
  Robot,
  Terminal as TerminalIcon,
  UploadSimple,
} from "@phosphor-icons/react/dist/ssr";

import { toast } from "sonner";

import { api } from "@/lib/api";
import { toastError } from "@/lib/errors";
import { validateImageFile } from "@/lib/image-upload";
import { useProvisionSocket, type ProvisionFrame } from "@/lib/use-provision";
import type { ArchitectMessage, BrowserProfile, SetupSession, Team } from "@/lib/types";

import { Logo } from "@/components/logo";
import { IdAvatar } from "@/components/profile/id-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { QuarkFrame } from "@/components/teams/quark-frame";
import { SetupChat, type ChatTurn } from "@/components/teams/setup-chat";
import {
  RemoteTerminal,
  type RemoteTerminalHandle,
} from "@/components/teams/remote-terminal";

type Step =
  | "basics"
  | "server"
  | "architecture"
  | "brains"
  | "brain_login"
  | "install"
  | "done";

const STEPS: { key: Step; label: string }[] = [
  { key: "basics", label: "Basics" },
  { key: "server", label: "Server" },
  { key: "architecture", label: "Architecture" },
  { key: "brains", label: "Brains" },
  { key: "brain_login", label: "Sign in" },
  { key: "install", label: "Install" },
  { key: "done", label: "Done" },
];

export default function NewTeamPage() {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>("basics");
  const [team, setTeam] = React.useState<Team | null>(null);
  const [session, setSession] = React.useState<SetupSession | null>(null);

  const goTo = React.useCallback((s: Step) => setStep(s), []);
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo className="h-7" />
          <span className="label-mono text-muted-foreground">Create Team</span>
        </div>
        <button
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => router.push("/chat")}
        >
          Save &amp; exit
        </button>
      </header>

      <Stepper index={stepIndex} />

      <main className="mt-6 flex-1">
        {step === "basics" && (
          <BasicsStep
            onDone={(t, s) => {
              setTeam(t);
              setSession(s);
              goTo("server");
            }}
          />
        )}
        {step === "server" && team && session && (
          <ServerStep team={team} session={session} onSession={setSession} onDone={() => goTo("architecture")} />
        )}
        {step === "architecture" && team && (
          <ArchitectureStep team={team} onDone={() => goTo("brains")} />
        )}
        {step === "brains" && team && session && (
          <BrainsStep team={team} session={session} onSession={setSession} onDone={() => goTo("brain_login")} />
        )}
        {step === "brain_login" && session && (
          <BrainLoginStep session={session} onDone={() => goTo("install")} />
        )}
        {step === "install" && team && session && (
          <InstallStep team={team} session={session} onDone={() => goTo("done")} />
        )}
        {step === "done" && team && <DoneStep team={team} onFinish={() => router.push("/chat")} />}
      </main>
    </div>
  );
}

function Stepper({ index }: { index: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={
              "flex h-5 w-5 items-center justify-center text-[10px] font-medium " +
              (i < index
                ? "bg-primary text-primary-foreground"
                : i === index
                  ? "border border-primary text-primary"
                  : "border text-muted-foreground")
            }
          >
            {i < index ? <Check weight="bold" className="h-3 w-3" /> : i + 1}
          </span>
          <span
            className={
              "label-mono " + (i === index ? "text-foreground" : "text-muted-foreground")
            }
          >
            {s.label}
          </span>
          {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">·</span>}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- Step 1
function BasicsStep({ onDone }: { onDone: (team: Team, session: SetupSession) => void }) {
  const [name, setName] = React.useState("");
  const [logo, setLogo] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const pickLogo = (file: File | null) => {
    if (!file) return;
    const check = validateImageFile(file);
    if (!check.ok) {
      toastError(check.error ?? "That image can't be used.");
      return;
    }
    setLogo(file);
    setPreview(URL.createObjectURL(file));
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const team = await api.createTeam({ name: name.trim() });
      if (logo) {
        try {
          await api.uploadTeamLogo(team.slug, logo);
        } catch (e) {
          toastError(e); // non-fatal — logo can be set later in team settings
        }
      }
      const session = await api.createSetupSession(team.slug, {});
      onDone(team, session);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Name your Team" subtitle="Give it a name and an optional logo. You can change both later.">
      <div className="flex items-center gap-4">
        <label className="cursor-pointer" title="Upload a logo">
          <IdAvatar seed={name || "team"} src={preview} size={64} />
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => pickLogo(e.target.files?.[0] ?? null)}
          />
          <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <UploadSimple className="h-3 w-3" /> logo
          </span>
        </label>
        <div className="flex-1">
          <Label htmlFor="team-name">Team name</Label>
          <Input
            id="team-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Robotics"
            onKeyDown={(e) => e.key === "Enter" && create()}
            autoFocus
          />
        </div>
      </div>
      <div className="mt-6 flex justify-end">
        <Button onClick={create} disabled={!name.trim() || busy}>
          {busy ? <Spinner /> : <>Continue <ArrowRight /></>}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Step 2
function ServerStep({
  team,
  session,
  onSession,
  onDone,
}: {
  team: Team;
  session: SetupSession;
  onSession: (s: SetupSession) => void;
  onDone: () => void;
}) {
  const [hostname, setHostname] = React.useState(session.server?.hostname ?? "");
  const [port, setPort] = React.useState(String(session.server?.port ?? 22));
  const [username, setUsername] = React.useState(session.server?.username ?? "ubuntu");
  const [secretKind, setSecretKind] = React.useState<"pem" | "password">(
    (session.server?.secret_kind as "pem" | "password") ?? "pem",
  );
  const [secret, setSecret] = React.useState("");
  const [connected, setConnected] = React.useState(false);
  const [phaseOk, setPhaseOk] = React.useState(false);
  const [turns, setTurns] = React.useState<ChatTurn[]>([]);
  const [log, setLog] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const onFrame = React.useCallback((f: ProvisionFrame) => {
    if (f.type === "assistant") setTurns((t) => [...t, { role: "assistant", text: f.text }]);
    else if (f.type === "command.started") setLog((l) => l + `\n$ ${f.command}\n`);
    else if (f.type === "command.output") setLog((l) => l + f.data);
    else if (f.type === "phase.done" && f.phase === "connect") setPhaseOk(f.ok);
    else if (f.type === "error") toastError(f.detail);
  }, []);

  const { ready, send } = useProvisionSocket({
    sessionId: connected ? session.session_id : null,
    onFrame,
    enabled: connected,
  });

  React.useEffect(() => {
    if (connected && ready) send({ type: "connect" });
  }, [connected, ready, send]);

  const readPem = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSecret(String(reader.result || ""));
    reader.readAsText(file);
  };

  const connect = async () => {
    if (!hostname.trim() || !secret.trim()) return;
    setBusy(true);
    try {
      const server = await api.createTeamServer(team.slug, {
        hostname: hostname.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        secret_kind: secretKind,
        secret,
      });
      const updated = await api.patchSetupSession(session.session_id, { server_id: server.id });
      onSession(updated);
      setSecret(""); // don't keep the key in memory longer than needed
      setConnected(true);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  if (connected) {
    return (
      <Card
        title="Connecting to your server"
        subtitle="The setup agent is verifying it can operate the server. Watch it work below."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <SetupChat
            turns={turns}
            busy={!phaseOk}
            disabled
            onSend={() => {}}
            placeholder="The agent will report what it finds…"
            className="h-[360px]"
          />
          <LogView text={log} />
        </div>
        <div className="mt-6 flex items-center justify-between">
          <span className="label-mono text-muted-foreground">
            {phaseOk ? "server ready" : ready ? "verifying…" : "opening connection…"}
          </span>
          <Button onClick={onDone} disabled={!phaseOk}>
            Continue <ArrowRight />
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Connect your server"
      subtitle="Enter the SSH details for the server your Silicons will run on. Credentials are encrypted at rest."
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div>
          <Label htmlFor="host">Hostname or IP</Label>
          <Input id="host" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="203.0.113.4" />
        </div>
        <div className="w-24">
          <Label htmlFor="port">Port</Label>
          <Input id="port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </div>
      </div>
      <div className="mt-4">
        <Label htmlFor="user">Username</Label>
        <Input id="user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ubuntu" />
      </div>

      <div className="mt-4 flex gap-2">
        <TabButton active={secretKind === "pem"} onClick={() => setSecretKind("pem")}>
          PEM key
        </TabButton>
        <TabButton active={secretKind === "password"} onClick={() => setSecretKind("password")}>
          Password
        </TabButton>
      </div>

      {secretKind === "pem" ? (
        <div className="mt-3">
          <label className="flex cursor-pointer items-center gap-2 border bg-background px-3 py-2 text-sm">
            <UploadSimple />
            <span>{secret ? "PEM loaded ✓ — choose a different file" : "Upload .pem private key"}</span>
            <input
              type="file"
              accept=".pem,.key,text/plain"
              className="sr-only"
              onChange={(e) => readPem(e.target.files?.[0] ?? null)}
            />
          </label>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Or paste it below.
          </p>
          <textarea
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            rows={4}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            className="mt-1 w-full resize-y border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      ) : (
        <div className="mt-3">
          <Label htmlFor="pw">Password</Label>
          <Input id="pw" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button onClick={connect} disabled={!hostname.trim() || !secret.trim() || busy}>
          {busy ? <Spinner /> : <><Plugs /> Connect</>}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Step 3
function ArchitectureStep({ team, onDone }: { team: Team; onDone: () => void }) {
  const [turns, setTurns] = React.useState<ChatTurn[]>([]);
  const [history, setHistory] = React.useState<ArchitectMessage[]>([]);
  const [dsl, setDsl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Seed the conversation on mount.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ask("Let's design our team. Ask me what you need to know.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ask = async (text: string) => {
    const nextHistory: ArchitectMessage[] = [...history, { role: "user", text }];
    setHistory(nextHistory);
    setTurns((t) => [...t, { role: "user", text }]);
    setBusy(true);
    try {
      const out = await api.teamArchitect(team.slug, nextHistory, dsl);
      if (out.code) setDsl(out.code);
      const answer = out.question || "(updated the chart)";
      setHistory((h) => [...h, { role: "model", text: answer }]);
      setTurns((t) => [...t, { role: "assistant", text: answer }]);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveTeamStructure(team.slug, dsl, true); // materialize the Silicons
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Define your team"
      subtitle="Talk through your org and the Silicons you need. The chart updates live; save when it looks right."
      wide
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <SetupChat
          turns={turns}
          busy={busy}
          onSend={ask}
          placeholder="Describe your team, your pain points, your tools…"
          className="h-[440px]"
        />
        <div className="h-[440px]">
          {dsl ? (
            <QuarkFrame dsl={dsl} className="relative h-full overflow-hidden border bg-card" />
          ) : (
            <div className="grid h-full place-items-center border bg-card text-sm text-muted-foreground">
              Your architecture will appear here as you talk.
            </div>
          )}
        </div>
      </div>
      <div className="mt-6 flex items-center justify-end">
        <Button onClick={save} disabled={!dsl || saving}>
          {saving ? <Spinner /> : <>Looks right — create Silicons <ArrowRight /></>}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Step 4
function BrainsStep({
  team,
  session,
  onSession,
  onDone,
}: {
  team: Team;
  session: SetupSession;
  onSession: (s: SetupSession) => void;
  onDone: () => void;
}) {
  const [brain, setBrain] = React.useState<string>(session.brain || "claude");
  const [backup, setBackup] = React.useState(session.backup_enabled ?? true);
  const [profiles, setProfiles] = React.useState<BrowserProfile[]>([]);
  const [profileId, setProfileId] = React.useState(session.browser_profile_id || "");
  const [configured, setConfigured] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void api
      .teamBrowserProfiles(team.slug)
      .then((r) => {
        setConfigured(r.configured);
        setProfiles(r.profiles || []);
      })
      .catch(() => setConfigured(false));
  }, [team.slug]);

  const startProfileSetup = async () => {
    try {
      const { token } = await api.teamBrowserProfileSetup(team.slug);
      const s = await api.browserProfileSetupStart(token);
      // Open the branded remote viewer so the head logs into their services.
      if (s.viewer_url) window.open(s.viewer_url, "_blank", "noopener");
      toast.info(
        "A browser viewer opened in a new tab. Sign into your services there, then come back and finish.",
        { className: "font-mono" },
      );
      // Stash so "finish" can be called; keep it simple: store on window scope.
      (window as unknown as Record<string, unknown>).__profileSetup = { token, before: s.before_profile_ids };
    } catch (e) {
      toastError(e);
    }
  };

  const finishProfileSetup = async () => {
    const stash = (window as unknown as Record<string, unknown>).__profileSetup as
      | { token: string; before: string[] }
      | undefined;
    if (!stash) return;
    try {
      const r = await api.browserProfileSetupFinish(stash.token, "", stash.before);
      if (r.profile?.id) {
        setProfileId(r.profile.id);
        setProfiles((p) => [...p, r.profile]);
      }
    } catch (e) {
      toastError(e);
    }
  };

  const next = async () => {
    setBusy(true);
    try {
      if (profileId) await api.assignTeamBrowserProfile(team.slug, profileId);
      const updated = await api.patchSetupSession(session.session_id, {
        brain,
        browser_profile_id: profileId,
        backup_enabled: backup,
        step: "brains",
      });
      onSession(updated);
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Brains & browser" subtitle="Choose the model that powers your Silicons and the browser profile they'll use.">
      <div>
        <Label>Brain</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {[
            { v: "claude", l: "Claude" },
            { v: "codex", l: "Codex" },
            { v: "both", l: "Both (Claude primary)" },
          ].map((o) => (
            <TabButton key={o.v} active={brain === o.v} onClick={() => setBrain(o.v)}>
              <Robot className="mr-1 inline h-4 w-4" />
              {o.l}
            </TabButton>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <Label>Browser profile</Label>
        {!configured ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Browser profiles aren&apos;t configured for this team — you can set one up later.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {profiles.length > 0 && (
              <select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                className="w-full border bg-background px-3 py-2 text-sm"
              >
                <option value="">No shared profile</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </select>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={startProfileSetup}>
                Set up a new profile
              </Button>
              <Button variant="ghost" size="sm" onClick={finishProfileSetup}>
                I&apos;ve signed in — save profile
              </Button>
            </div>
          </div>
        )}
      </div>

      <label className="mt-6 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
        Enable automatic daily backups (recommended)
      </label>

      <div className="mt-6 flex justify-end">
        <Button onClick={next} disabled={busy}>
          {busy ? <Spinner /> : <>Continue <ArrowRight /></>}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Step 5
function BrainLoginStep({ session, onDone }: { session: SetupSession; onDone: () => void }) {
  const termRef = React.useRef<RemoteTerminalHandle>(null);
  const brain = session.brain || "claude";

  const onFrame = React.useCallback((f: ProvisionFrame) => {
    if (f.type === "terminal.output") termRef.current?.write(f.data);
    else if (f.type === "terminal.closed") termRef.current?.write("\r\n[session closed]\r\n");
    else if (f.type === "error") toastError(f.detail);
  }, []);

  const { ready, send } = useProvisionSocket({ sessionId: session.session_id, onFrame });

  React.useEffect(() => {
    if (ready) send({ type: "terminal_open", cols: 100, rows: 28 });
  }, [ready, send]);

  const runLogin = (tool: string) => {
    const cmd = tool === "codex" ? "codex login --device-auth\n" : "claude\n";
    send({ type: "terminal_input", data: cmd });
    termRef.current?.focus();
  };

  return (
    <Card
      title="Sign your brains in"
      subtitle="Run the login for each brain you chose. Follow the prompts in the terminal — device-code logins print a URL to open."
      wide
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {(brain === "codex" ? ["codex"] : brain === "both" ? ["claude", "codex"] : ["claude"]).map(
          (t) => (
            <Button key={t} variant="outline" size="sm" onClick={() => runLogin(t)}>
              <TerminalIcon className="mr-1 h-4 w-4" /> {t} login
            </Button>
          ),
        )}
      </div>
      <div className="h-[420px] overflow-hidden border">
        <RemoteTerminal
          ref={termRef}
          onData={(d) => send({ type: "terminal_input", data: d })}
          onResize={(cols, rows) => send({ type: "terminal_resize", cols, rows })}
        />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="label-mono text-muted-foreground">
          {ready ? "terminal live" : "connecting…"}
        </span>
        <Button onClick={onDone}>
          I&apos;m signed in <ArrowRight />
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Step 6
function InstallStep({
  team,
  session,
  onDone,
}: {
  team: Team;
  session: SetupSession;
  onDone: () => void;
}) {
  const [turns, setTurns] = React.useState<ChatTurn[]>([]);
  const [log, setLog] = React.useState("");
  const [done, setDone] = React.useState(false);
  const [ok, setOk] = React.useState(false);
  const started = React.useRef(false);

  const onFrame = React.useCallback((f: ProvisionFrame) => {
    if (f.type === "assistant") setTurns((t) => [...t, { role: "assistant", text: f.text }]);
    else if (f.type === "command.started") setLog((l) => l + `\n$ ${f.command}\n`);
    else if (f.type === "command.output") setLog((l) => l + f.data);
    else if (f.type === "phase.done" && f.phase === "install") {
      setDone(true);
      setOk(f.ok);
    } else if (f.type === "error") toastError(f.detail);
  }, []);

  const { ready, send } = useProvisionSocket({ sessionId: session.session_id, onFrame });

  React.useEffect(() => {
    if (ready && !started.current) {
      started.current = true;
      send({ type: "install", context: { brain: session.brain, runtime: "docker" } });
    }
  }, [ready, send, session.brain]);

  return (
    <Card
      title="Setting up your Silicons"
      subtitle="The agent is installing everything and bringing every Silicon online. This can take a few minutes."
      wide
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <SetupChat turns={turns} busy={!done} disabled onSend={() => {}} className="h-[420px]" />
        <LogView text={log} className="h-[420px]" />
      </div>
      <div className="mt-6 flex items-center justify-between">
        <span className="label-mono text-muted-foreground">
          {done ? (ok ? "all silicons online" : "needs attention") : ready ? "installing…" : "connecting…"}
        </span>
        <Button onClick={onDone} disabled={!done || !ok}>
          Finish <ArrowRight />
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Step 7
function DoneStep({ team, onFinish }: { team: Team; onFinish: () => void }) {
  const [email, setEmail] = React.useState("");
  const [inviteLink, setInviteLink] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const addHead = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const invite = await api.createInvite(team.slug, {
        scope: "team",
        channel: "email",
        email_target: email.trim(),
        role: "head",
      });
      setInviteLink(invite.token ? `${window.location.origin}/join/${invite.token}` : "sent");
      setEmail("");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={`${team.name} is live 🎉`}
      subtitle="You're the founding head. Add more heads now, or jump straight into the Interface."
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center bg-primary text-primary-foreground">
          <Check weight="bold" />
        </div>
        <p className="text-sm text-muted-foreground">
          Your Silicons are set up and connected. You can manage them anytime from the team panel.
        </p>
      </div>

      <div className="mt-6">
        <Label htmlFor="head-email">Invite another head (optional)</Label>
        <div className="mt-1 flex gap-2">
          <Input
            id="head-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            onKeyDown={(e) => e.key === "Enter" && addHead()}
          />
          <Button variant="outline" onClick={addHead} disabled={!email.trim() || busy}>
            {busy ? <Spinner /> : "Invite"}
          </Button>
        </div>
        {inviteLink && (
          <p className="mt-2 break-all text-xs text-muted-foreground">
            {inviteLink === "sent" ? "Invite sent." : `Invite link: ${inviteLink}`}
          </p>
        )}
      </div>

      <div className="mt-8 flex justify-end">
        <Button onClick={onFinish}>
          Enter Silicon Interface <ArrowRight />
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- shared UI
function Card({
  title,
  subtitle,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={"mx-auto w-full " + (wide ? "max-w-5xl" : "max-w-2xl")}>
      <div className="border bg-card p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "border px-3 py-1.5 text-sm " +
        (active ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted")
      }
    >
      {children}
    </button>
  );
}

function LogView({ text, className }: { text: string; className?: string }) {
  const ref = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className={
        "overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs " + (className ?? "h-[360px]")
      }
      style={{ background: "var(--terminal-bg)", color: "var(--terminal-fg)" }}
    >
      {text || "waiting for output…"}
    </pre>
  );
}
