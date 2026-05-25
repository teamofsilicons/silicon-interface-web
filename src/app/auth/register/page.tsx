"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { useCooldown } from "@/lib/use-cooldown";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DevCodeButton } from "@/components/dev-code-button";

type Step = "phone" | "email" | "username";
const RESEND_COOLDOWN = 30;

/** Suggest a handle from the email local part, cleaned to the allowed charset. */
function suggestUsername(email: string): string {
  const local = (email.split("@")[0] || "").toLowerCase();
  const cleaned = local.replace(/[^a-z0-9._-]/g, "").slice(0, 24);
  return cleaned.length >= 3 ? cleaned : "";
}

export default function RegisterPage() {
  const router = useRouter();
  const [authed, setAuthed] = React.useState<boolean | null>(null);
  const [flowId, setFlowId] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [phoneCode, setPhoneCode] = React.useState("");
  const [phoneSent, setPhoneSent] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [emailCode, setEmailCode] = React.useState("");
  const [emailSent, setEmailSent] = React.useState(false);
  const [phoneVerified, setPhoneVerified] = React.useState(false);
  const [emailVerified, setEmailVerified] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [step, setStep] = React.useState<Step>("phone");
  const phoneCd = useCooldown();
  const emailCd = useCooldown();

  // If they already have a session, they already have an account.
  React.useEffect(() => {
    setAuthed(Boolean(authStore.getAccess()));
  }, []);

  // Carried over from a login attempt for an account that doesn't exist yet —
  // pre-fill so they don't re-enter it.
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("identifier");
    if (!id) return;
    if (id.startsWith("+")) setPhone(id);
    else if (id.includes("@")) setEmail(id);
    else setUsername(id.toLowerCase());
  }, []);

  const goLogin = (id: string) =>
    router.push(`/auth/login?identifier=${encodeURIComponent(id)}`);

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

  const sendPhone = () =>
    wrap(async () => {
      const r = await api.registerPhoneStart(phone, flowId || undefined);
      // returning user? treat as a login instead of a signup.
      if (r.existing) {
        toast.message("You already have an account — taking you to log in.");
        goLogin(phone);
        return;
      }
      setFlowId(r.flow_id!);
      setPhoneSent(true);
      phoneCd.start(RESEND_COOLDOWN);
      toast.success(`code sent to ${phone}`);
    });

  const verifyPhone = () =>
    wrap(async () => {
      const r = await api.registerPhoneVerify(flowId, phone, phoneCode);
      if (r.verified) {
        setPhoneVerified(true);
        setStep("email");
        toast.success("phone verified ✓");
      }
    });

  const sendEmail = () =>
    wrap(async () => {
      const r = await api.registerEmailStart(flowId, email);
      if (r.existing) {
        toast.message("You already have an account — taking you to log in.");
        goLogin(email);
        return;
      }
      setEmailSent(true);
      emailCd.start(RESEND_COOLDOWN);
      toast.success(`code sent to ${email}`);
    });

  const verifyEmail = () =>
    wrap(async () => {
      const r = await api.registerEmailVerify(flowId, email, emailCode);
      if (r.verified) {
        setEmailVerified(true);
        setUsername((u) => u || suggestUsername(email)); // pre-fill, editable
        setStep("username");
        toast.success("email verified ✓");
      }
    });

  const finalize = () =>
    wrap(async () => {
      const session = await api.registerUsername(flowId, username || undefined);
      authStore.setSession(session);
      toast.success(`welcome, @${session.carbon.username}`);
      router.replace("/chat");
    });

  // Already logged in → don't let them sign up again.
  if (authed) {
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent text-accent-foreground">
          <Check className="h-6 w-6" />
        </div>
        <header className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">you&apos;re already set up</h1>
          <p className="text-sm text-muted-foreground">
            You seem to have already created an account. Log in to continue.
          </p>
        </header>
        <div className="space-y-2">
          <Button asChild className="w-full">
            <Link href="/auth/login">log in to continue</Link>
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <Link href="/chat">continue to your chats</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">create your account</h1>
        <p className="text-sm text-muted-foreground">
          We verify your phone and email, then you pick a handle. Takes a minute.
        </p>
      </header>

      <Stepper step={step} phoneVerified={phoneVerified} emailVerified={emailVerified} />

      {step === "phone" && (
        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phone">phone number</Label>
            <Input
              id="phone"
              autoFocus
              placeholder="+14155551212"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={phoneVerified}
            />
            <p className="text-xs text-muted-foreground">International format, e.g. +1 415 555 1212.</p>
          </div>
          {!phoneSent ? (
            <Button onClick={sendPhone} disabled={!phone || loading} className="w-full">
              {loading && <Loader2 className="animate-spin" />}
              send code
            </Button>
          ) : (
            <div className="space-y-2 rounded-xl border bg-secondary/50 p-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="phoneCode">enter the code</Label>
                <DevCodeButton target={phone} onFill={setPhoneCode} />
              </div>
              <Input
                id="phoneCode"
                placeholder="123456"
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                maxLength={6}
                className="text-center text-lg tracking-[0.4em]"
              />
              <div className="flex items-center justify-between">
                <Button onClick={verifyPhone} disabled={phoneCode.length !== 6 || loading} className="flex-1">
                  verify
                </Button>
                <button
                  type="button"
                  onClick={sendPhone}
                  disabled={phoneCd.active || loading}
                  className="ml-3 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                >
                  {phoneCd.active ? `resend in ${phoneCd.remaining}s` : "resend"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {step === "email" && (
        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">email address</Label>
            <Input
              id="email"
              type="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={emailVerified}
            />
          </div>
          {!emailSent ? (
            <Button onClick={sendEmail} disabled={!email || loading} className="w-full">
              {loading && <Loader2 className="animate-spin" />}
              send code
            </Button>
          ) : (
            <div className="space-y-2 rounded-xl border bg-secondary/50 p-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="emailCode">enter the code</Label>
                <DevCodeButton target={email} onFill={setEmailCode} />
              </div>
              <Input
                id="emailCode"
                placeholder="123456"
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                maxLength={6}
                className="text-center text-lg tracking-[0.4em]"
              />
              <div className="flex items-center justify-between">
                <Button onClick={verifyEmail} disabled={emailCode.length !== 6 || loading} className="flex-1">
                  verify
                </Button>
                <button
                  type="button"
                  onClick={sendEmail}
                  disabled={emailCd.active || loading}
                  className="ml-3 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                >
                  {emailCd.active ? `resend in ${emailCd.remaining}s` : "resend"}
                </button>
              </div>
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => setStep("phone")} className="gap-1">
            <ArrowLeft className="h-3.5 w-3.5" /> back
          </Button>
        </section>
      )}

      {step === "username" && (
        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">choose your handle</Label>
            <div className="flex items-center rounded-md border bg-card focus-within:ring-2 focus-within:ring-ring">
              <span className="pl-3 text-muted-foreground">@</span>
              <input
                id="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                className="h-9 w-full rounded-md bg-transparent px-1.5 text-sm outline-none"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              This is your ID — how people and silicons find you. Lowercase letters, digits, <code>_ . -</code>. Edit it if you like.
            </p>
          </div>
          <Button onClick={finalize} disabled={loading} className="w-full">
            {loading && <Loader2 className="animate-spin" />}
            finish &amp; enter
          </Button>
        </section>
      )}

      <footer className="border-t pt-5 text-sm text-muted-foreground">
        already have an account?{" "}
        <Link href="/auth/login" className="font-medium text-primary hover:underline">
          log in
        </Link>
      </footer>
    </div>
  );
}

function Stepper({
  step,
  phoneVerified,
  emailVerified,
}: {
  step: Step;
  phoneVerified: boolean;
  emailVerified: boolean;
}) {
  const items: { id: Step; label: string; done: boolean }[] = [
    { id: "phone", label: "phone", done: phoneVerified },
    { id: "email", label: "email", done: emailVerified },
    { id: "username", label: "handle", done: false },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs">
      {items.map((it, i) => (
        <li key={it.id} className="flex items-center gap-2">
          <div
            className={
              "flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-medium transition-colors " +
              (it.done
                ? "border-primary bg-primary text-primary-foreground"
                : step === it.id
                  ? "border-foreground text-foreground"
                  : "border-border text-muted-foreground")
            }
          >
            {it.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </div>
          <span className={step === it.id ? "font-medium text-foreground" : "text-muted-foreground"}>
            {it.label}
          </span>
          {i < items.length - 1 && <span className="h-px w-6 bg-border" />}
        </li>
      ))}
    </ol>
  );
}
