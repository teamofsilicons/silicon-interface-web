"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { CircleNotch } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { useResendCooldown } from "@/lib/use-resend";
import type { InviteInfo } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import { OtpInput } from "@/components/auth/otp-input";
import { ResendRow } from "@/components/auth/resend-row";

// Suspense wrapper so `useSearchParams()` (reads ?code=…) doesn't bail
// static prerender.
export default function JoinPage() {
  return (
    <React.Suspense fallback={null}>
      <JoinPageInner />
    </React.Suspense>
  );
}

function JoinPageInner() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = params.token;
  const queryCode = useSearchParams().get("code") ?? "";

  // Checked after mount (localStorage is client-only) to avoid a hydration mismatch.
  const [authed, setAuthed] = React.useState(false);
  React.useEffect(() => {
    setAuthed(Boolean(authStore.getAccess()));
  }, []);
  const [info, setInfo] = React.useState<InviteInfo | null>(null);
  const [error, setError] = React.useState("");
  const [code, setCode] = React.useState(queryCode.replace(/\D/g, "").slice(0, 4));
  const [needEmail, setNeedEmail] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [emailSent, setEmailSent] = React.useState(false);
  const [emailCode, setEmailCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const resend = useResendCooldown();

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const i = await api.inviteInfo(token);
        if (alive) setInfo(i);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : "Invalid or expired invite.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

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

  const accept = () =>
    wrap(async () => {
      try {
        await api.acceptInvite(token, { code });
        toast.success("you're in");
        router.replace("/chat");
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          (e.body as { needs_email_verification?: boolean })?.needs_email_verification
        ) {
          setNeedEmail(true);
          return;
        }
        throw e;
      }
    });

  const sendEmail = () =>
    wrap(async () => {
      const r = await api.inviteVerifyEmailStart(token, email.trim());
      if (r.verified) {
        toast.success("email already verified");
        await accept();
        return;
      }
      setEmailSent(true);
      resend.send();
      toast.success(`code sent to ${email.trim()}`);
    });

  const verifyEmail = () =>
    wrap(async () => {
      await api.inviteVerifyEmailCheck(token, email.trim(), emailCode);
      toast.success("email verified");
      await accept();
    });

  return (
    <main className="bg-dots flex min-h-screen flex-col items-center justify-center px-6">
      <div className="w-full max-w-md space-y-6 border bg-card p-8">
        <Link href="/" className="flex justify-center">
          <Logo size={40} />
        </Link>

        {error ? (
          <div className="space-y-3 text-center">
            <h1 className="text-xl font-semibold tracking-tight">Invite unavailable</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button asChild variant="outline" className="w-full">
              <Link href="/chat">go to your chats</Link>
            </Button>
          </div>
        ) : !info ? (
          <div className="grid place-items-center py-8 text-muted-foreground">
            <CircleNotch className="h-6 w-6 animate-spin" />
          </div>
        ) : !authed ? (
          <div className="space-y-3 text-center">
            <h1 className="text-xl font-semibold tracking-tight">
              Join {info.silicon_name ?? info.team_name}
            </h1>
            <p className="text-sm text-muted-foreground">Log in or sign up to accept this invite.</p>
            <Button asChild className="w-full">
              <Link href="/auth/login">Log in</Link>
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link href="/auth/register">Sign up</Link>
            </Button>
          </div>
        ) : needEmail ? (
          <section className="space-y-4">
            <header className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">Verify your email</h1>
              <p className="text-sm text-muted-foreground">
                {info.team_name} only admits whitelisted emails. Verify a work email to join.
              </p>
            </header>
            {!emailSent ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="wlemail">work email</Label>
                  <Input
                    id="wlemail"
                    type="email"
                    autoFocus
                    placeholder="you@work.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <Button onClick={sendEmail} disabled={!email.includes("@") || loading} className="w-full">
                  {loading && <CircleNotch className="animate-spin" />} send code
                </Button>
              </>
            ) : (
              <>
                <OtpInput value={emailCode} onChange={setEmailCode} autoFocus onComplete={() => verifyEmail()} />
                <ResendRow resend={resend} onResend={sendEmail} loading={loading} />
                <Button onClick={verifyEmail} disabled={emailCode.length !== 6 || loading} className="w-full">
                  {loading && <CircleNotch className="animate-spin" />} verify &amp; join
                </Button>
              </>
            )}
          </section>
        ) : (
          <section className="space-y-4">
            <header className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">
                Join {info.silicon_name ?? info.team_name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {info.silicon_name
                  ? `on the ${info.team_name} team`
                  : "Accept your invite to join the team."}
              </p>
            </header>

            {info.needs_code && (
              <div className="space-y-2">
                <Label>4-digit code</Label>
                <OtpInput value={code} onChange={setCode} length={4} autoFocus />
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">
                    don&apos;t have a code?
                  </summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-4">
                    <li>Ask whoever shared this link for the current 4-digit code.</li>
                    <li>They&apos;ll find it in the team&apos;s invite panel - it rotates as people join.</li>
                  </ol>
                </details>
              </div>
            )}

            <Button
              onClick={accept}
              disabled={loading || (info.needs_code && code.length !== 4)}
              className="w-full"
            >
              {loading && <CircleNotch className="animate-spin" />} Join
            </Button>
          </section>
        )}
      </div>
    </main>
  );
}
