"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DevCodeButton } from "@/components/dev-code-button";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = React.useState("");
  const [challengeId, setChallengeId] = React.useState("");
  const [channels, setChannels] = React.useState<string[]>([]);
  const [code, setCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  // For the "fetch dev code" button we need an OTP target. If the identifier looks
  // like a phone/email, we use it directly. For usernames, we'd need to know the
  // associated phone/email — so we expose two buttons.
  const lookingLikeEmail = identifier.includes("@");
  const lookingLikePhone = identifier.startsWith("+");
  const looksLikeUsername = !lookingLikeEmail && !lookingLikePhone && identifier.length > 0;

  const wrap = async (fn: () => Promise<void>) => {
    setLoading(true);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const start = () =>
    wrap(async () => {
      const r = await api.loginStart(identifier);
      setChallengeId(r.challenge_id);
      setChannels(r.channels);
      if (!r.challenge_id) {
        toast.message("if this account exists, a code was sent.");
      } else {
        toast.success(`code sent via ${r.channels.join(" + ")}`);
      }
    });

  const verify = () =>
    wrap(async () => {
      const r = await api.loginVerify(challengeId, code);
      // We don't have the carbon object here; fetch /carbons/me.
      authStore.setTokens(r.access, r.refresh);
      const me = await api.me();
      authStore.setCarbon(me);
      toast.success(`welcome back, ${me.username}`);
      router.replace("/chat");
    });

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">log in</h1>
        <p className="text-sm text-muted-foreground">
          Use your phone, email, or username. For username, a code is sent to both your
          verified phone and email — either delivery works.
        </p>
      </header>

      <section className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="identifier">phone / email / username</Label>
          <Input
            id="identifier"
            placeholder="+14155551212 · you@example.com · alice"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            disabled={!!challengeId}
          />
        </div>
        {!challengeId ? (
          <Button onClick={start} disabled={!identifier || loading} className="w-full">
            {loading && <Loader2 className="animate-spin" />}
            send code
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => {
            setChallengeId("");
            setChannels([]);
            setCode("");
          }}>
            ← use a different identifier
          </Button>
        )}
      </section>

      {challengeId && (
        <section className="space-y-4 border-t pt-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="code">code</Label>
              <div className="flex gap-1">
                {(lookingLikeEmail || looksLikeUsername) && (
                  <DevCodeButton
                    target={lookingLikeEmail ? identifier : identifier}
                    onFill={setCode}
                  />
                )}
                {lookingLikePhone && (
                  <DevCodeButton target={identifier} onFill={setCode} />
                )}
              </div>
            </div>
            <Input
              id="code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              maxLength={6}
            />
            <p className="text-xs text-muted-foreground">
              channels used: {channels.join(", ") || "—"}
            </p>
          </div>
          <Button onClick={verify} disabled={!code || loading} className="w-full">
            {loading && <Loader2 className="animate-spin" />}
            log in
          </Button>
        </section>
      )}

      <footer className="border-t pt-6 text-sm text-muted-foreground">
        no account?{" "}
        <Link href="/auth/register" className="text-primary hover:underline">
          register
        </Link>
      </footer>
    </div>
  );
}
