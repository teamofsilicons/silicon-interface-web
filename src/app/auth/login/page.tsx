"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Mail, Phone, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { useCooldown } from "@/lib/use-cooldown";
import type { LoginChannel, LoginChannelOption } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DevCodeButton } from "@/components/dev-code-button";

type Phase = "identify" | "choose" | "code";
const RESEND_COOLDOWN = 30;

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>("identify");
  const [challengeId, setChallengeId] = React.useState("");
  const [options, setOptions] = React.useState<LoginChannelOption[]>([]);
  const [chosenChannel, setChosenChannel] = React.useState<LoginChannel | "">("");
  const [sentTo, setSentTo] = React.useState("");
  const [code, setCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const cooldown = useCooldown();

  // Prefill from ?identifier=... — used when signup pivots a returning user here.
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("identifier");
    if (id) setIdentifier(id);
  }, []);

  const looksLikeEmailOrPhone = identifier.includes("@") || identifier.startsWith("+");

  const wrap = async (fn: () => Promise<void>) => {
    setLoading(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const start = () =>
    wrap(async () => {
      const r = await api.loginStart(identifier);
      if (!r.challenge_id) {
        // No account for this identifier — continue straight into sign-up,
        // carrying what they typed so they don't re-enter it.
        router.push(`/auth/register?identifier=${encodeURIComponent(identifier.trim())}`);
        return;
      }
      setChallengeId(r.challenge_id);
      if (r.status === "choose_channel" && (r.options?.length ?? 0) > 0) {
        setOptions(r.options ?? []);
        setPhase("choose");
      } else {
        setChosenChannel(r.channel ?? "");
        setSentTo(r.sent_to ?? "");
        setPhase("code");
        cooldown.start(RESEND_COOLDOWN);
      }
    });

  const choose = (channel: LoginChannel) =>
    wrap(async () => {
      const r = await api.loginSelectChannel(challengeId, channel);
      setChosenChannel(channel);
      setSentTo(r.sent_to ?? "");
      setPhase("code");
      cooldown.start(RESEND_COOLDOWN);
    });

  const resend = () =>
    wrap(async () => {
      // username flow → re-send on the chosen channel; direct identifier → restart
      const r = chosenChannel
        ? await api.loginSelectChannel(challengeId, chosenChannel)
        : await api.loginStart(identifier);
      if (r.challenge_id) setChallengeId(r.challenge_id);
      setSentTo(r.sent_to ?? sentTo);
      cooldown.start(RESEND_COOLDOWN);
      toast.success("code resent");
    });

  const verify = () =>
    wrap(async () => {
      const r = await api.loginVerify(challengeId, code);
      authStore.setTokens(r.access, r.refresh);
      const me = await api.me();
      authStore.setCarbon(me);
      toast.success(`welcome back, @${me.username}`);
      router.replace("/chat");
    });

  const reset = () => {
    setPhase("identify");
    setChallengeId("");
    setOptions([]);
    setChosenChannel("");
    setSentTo("");
    setCode("");
  };

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">welcome back</h1>
        <p className="text-sm text-muted-foreground">
          {phase === "identify" && "Enter your username, email, or phone to get a one-time code."}
          {phase === "choose" && "Where should we send your code?"}
          {phase === "code" && (sentTo ? `Enter the code we sent to ${sentTo}.` : "Enter the code we sent you.")}
        </p>
      </header>

      {phase === "identify" && (
        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="identifier">username · email · phone</Label>
            <Input
              id="identifier"
              autoFocus
              placeholder="alice · you@example.com · +14155551212"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && identifier && start()}
            />
          </div>
          <Button onClick={start} disabled={!identifier || loading} className="w-full">
            {loading && <Loader2 className="animate-spin" />}
            continue
          </Button>
        </section>
      )}

      {phase === "choose" && (
        <section className="space-y-3">
          {options.map((opt) => (
            <button
              key={opt.channel}
              onClick={() => choose(opt.channel)}
              disabled={loading}
              className="flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent disabled:opacity-60"
            >
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-accent-foreground">
                {opt.channel === "email" ? <Mail className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-medium">
                  {opt.channel === "email" ? "Email" : "Text message"}
                </span>
                <span className="block text-xs text-muted-foreground">{opt.label}</span>
              </span>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </button>
          ))}
          <Button variant="ghost" size="sm" onClick={reset} className="gap-1">
            <ArrowLeft className="h-3.5 w-3.5" /> use a different account
          </Button>
        </section>
      )}

      {phase === "code" && (
        <section className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="code">verification code</Label>
              {looksLikeEmailOrPhone && <DevCodeButton target={identifier} onFill={setCode} />}
            </div>
            <Input
              id="code"
              autoFocus
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && code.length === 6 && verify()}
              inputMode="numeric"
              maxLength={6}
              className="text-center text-lg tracking-[0.4em]"
            />
            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={resend}
                disabled={cooldown.active || loading}
                className="text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cooldown.active ? `resend code in ${cooldown.remaining}s` : "resend code"}
              </button>
            </div>
          </div>
          <Button onClick={verify} disabled={code.length !== 6 || loading} className="w-full">
            {loading && <Loader2 className="animate-spin" />}
            log in
          </Button>
          <Button variant="ghost" size="sm" onClick={reset} className="gap-1">
            <ArrowLeft className="h-3.5 w-3.5" /> start over
          </Button>
        </section>
      )}

      <footer className="border-t pt-5 text-sm text-muted-foreground">
        new here?{" "}
        <Link href="/auth/register" className="font-medium text-primary hover:underline">
          create an account
        </Link>
      </footer>
    </div>
  );
}
