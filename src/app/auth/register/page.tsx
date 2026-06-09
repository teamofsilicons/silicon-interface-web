"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Warning } from "@phosphor-icons/react/dist/ssr";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { useResendCooldown } from "@/lib/use-resend";
import {
  findCountry,
  guessCountryIso2,
  normalizePhonePaste,
  parseE164,
  type Country,
} from "@/lib/country-codes";
import { isValidEmail, looksLikeWorkEmail } from "@/lib/email";
import { safeSession } from "@/lib/safe-storage";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CountryCodeSelect } from "@/components/auth/country-code-select";
import { OtpDialog } from "@/components/auth/otp-dialog";

// Carbon-ID picking + the final registerUsername call live in the personalized
// /onboarding flow (entered after phone verify). Register only owns the two
// verification steps, so there's no "carbonid" step here anymore.
type Step = "email" | "phone";

// Suspense wrapper so `useSearchParams()` (email/phone/notice handoff from
// /login) doesn't blow up static prerender.
export default function RegisterPage() {
  return (
    <React.Suspense fallback={null}>
      <RegisterPageInner />
    </React.Suspense>
  );
}

function RegisterPageInner() {
  const router = useRouter();
  // Either or both may be handed over from a login pivot ("no account yet"):
  // ?email=…   ?phone=+E.164   ?notice=new
  const search = useSearchParams();
  const initialEmail = search.get("email") ?? "";
  const initialPhone = parseE164(search.get("phone") ?? "");
  const noticeNew = search.get("notice") === "new";

  // Checked after mount (localStorage is client-only) to avoid a hydration
  // mismatch — server and first client render both treat the user as not-yet-known.
  const [authed, setAuthed] = React.useState(false);
  React.useEffect(() => {
    setAuthed(Boolean(authStore.getAccess()));
  }, []);
  // Banner is dismissed the moment the user commits to step 1 — no need to keep
  // shouting "no account" once they're actively creating one.
  const [noticeDismissed, setNoticeDismissed] = React.useState(false);
  const [flowId, setFlowId] = React.useState("");
  const [step, setStep] = React.useState<Step>("email");
  const [loading, setLoading] = React.useState(false);

  const [email, setEmail] = React.useState(() => initialEmail);
  const [emailVerified, setEmailVerified] = React.useState(false);
  const [emailDialog, setEmailDialog] = React.useState(false);
  const [nudge, setNudge] = React.useState(false);
  // Persist across refresh so a reload on the OTP dialog keeps the throttle.
  const emailResend = useResendCooldown({ persistKey: "silicon-interface:resend:register-email" });

  const [country, setCountry] = React.useState<Country>(
    () => initialPhone?.country ?? findCountry(guessCountryIso2()) ?? findCountry("US")!,
  );
  const [number, setNumber] = React.useState(() => initialPhone?.number ?? "");
  const [phoneVerified, setPhoneVerified] = React.useState(false);
  const [phoneDialog, setPhoneDialog] = React.useState(false);
  const phoneResend = useResendCooldown({ persistKey: "silicon-interface:resend:register-phone" });

  const phoneE164 = number ? `+${country.dial}${number.replace(/\D/g, "")}` : "";

  const goLogin = (id: string) =>
    router.push(
      `/auth/login?identifier=${encodeURIComponent(id)}&notice=existing`,
    );

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

  // ---- email ----
  const submitEmail = () => {
    if (!isValidEmail(email)) {
      toast.error("Enter a valid email address.");
      return;
    }
    setNoticeDismissed(true);
    if (looksLikeWorkEmail(email)) {
      setNudge(true);
      return;
    }
    proceedEmail();
  };

  const proceedEmail = () =>
    wrap(async () => {
      // Keep the nudge dialog open through the API round-trip — the "Continue
      // anyway" button's `loading` state already shows a spinner. Closing it
      // *before* the next dialog mounts (the previous approach) races Radix's
      // exit animation: in dev the API resolves in <100ms, the OTP portal
      // opens while the nudge is still animating out, and the OTP content
      // ends up trapped behind the leaving overlay + focus-lock. The user
      // sees only the dim and has to click again to dismiss the ghost.
      const r = await api.registerEmailStart(email.trim(), flowId || undefined);
      if (r.existing) {
        setNudge(false);
        toast.message("You already have an account — taking you to log in.");
        goLogin(email.trim());
        return;
      }
      if (r.flow_id) setFlowId(r.flow_id);
      // Close the nudge, then let one frame pass before mounting the OTP
      // dialog. One render is enough for Radix to flip the nudge to
      // data-state="closed" and release its body locks; the next render
      // mounts the OTP onto a clean slate.
      setNudge(false);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      setEmailDialog(true);
      emailResend.send();
    });

  const verifyEmail = (code: string) =>
    wrap(async () => {
      const r = await api.registerEmailVerify(flowId, email.trim(), code);
      if (r.verified) {
        setEmailVerified(true);
        setEmailDialog(false);
        setStep("phone");
        toast.success("email verified");
      }
    });

  const resendEmail = () =>
    wrap(async () => {
      await api.registerEmailStart(email.trim(), flowId || undefined);
      emailResend.send();
      toast.success("code resent");
    });

  // ---- phone ----
  const submitPhone = () =>
    wrap(async () => {
      const r = await api.registerPhoneStart(phoneE164, flowId || undefined);
      if (r.existing) {
        toast.message("You already have an account — taking you to log in.");
        goLogin(phoneE164);
        return;
      }
      if (r.flow_id) setFlowId(r.flow_id);
      setPhoneDialog(true);
      phoneResend.send();
    });

  const verifyPhone = (code: string) =>
    wrap(async () => {
      const r = await api.registerPhoneVerify(flowId, phoneE164, code);
      if (r.verified) {
        setPhoneVerified(true);
        setPhoneDialog(false);
        toast.success("phone verified");
        // #1 — Both factors are done; hand off to the personalized onboarding
        // flow which handles Carbon-ID picking, name+bio, glyph generation,
        // and the final registerUsername call. P0-6: use safeSession so a
        // private-mode storage throw can't strand the user in a register↔
        // onboarding bounce.
        safeSession.set("silicon-interface:onboarding-flow", flowId);
        // Carry the verified email through so onboarding can pre-fill the
        // Carbon ID suggestion (local-part, normalised).
        safeSession.set("silicon-interface:onboarding-email", email.trim());
        router.replace("/onboarding");
      }
    });

  const resendPhone = () =>
    wrap(async () => {
      await api.registerPhoneStart(phoneE164, flowId || undefined);
      phoneResend.send();
      toast.success("code resent");
    });

  if (authed) {
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center bg-accent text-accent-foreground">
          <Check className="h-6 w-6" />
        </div>
        <header className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">you&apos;re already set up</h1>
          <p className="text-sm text-muted-foreground">
            You seem to have already created an account. Log in to continue.
          </p>
        </header>
        <div className="space-y-4">
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
    <div className="stagger-fade-in space-y-7">
      {step === "phone" && (
        <button
          type="button"
          onClick={() => setStep("email")}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> back
        </button>
      )}
      {noticeNew && !noticeDismissed && (
        <div className="notice-fade-in flex items-start gap-2 border border-destructive bg-destructive/10 px-3 py-2 text-xs">
          <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <span>
            <span className="font-medium text-destructive">Seems like you don&apos;t have an account yet.</span>{" "}
            Sign up below to get started.
          </span>
        </div>
      )}
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">create your account</h1>
        <p className="text-sm text-muted-foreground">
          We verify your email and phone, then you pick a Carbon ID.
        </p>
      </header>

      <Stepper step={step} emailVerified={emailVerified} phoneVerified={phoneVerified} />

      {step === "email" && (
        <section className="space-y-4">
          <div className="space-y-4">
            <Label htmlFor="email">email address</Label>
            <Input
              id="email"
              type="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitEmail()}
            />
          </div>
          <Button onClick={submitEmail} disabled={!email.trim() || loading} className="w-full">
            {loading && <Spinner />}
            Get OTP
          </Button>
        </section>
      )}

      {step === "phone" && (
        <section className="space-y-4">
          <div className="space-y-4">
            <Label htmlFor="phone">phone number</Label>
            <div className="flex gap-2">
              <CountryCodeSelect value={country.iso2} onChange={setCountry} />
              <Input
                id="phone"
                autoFocus
                inputMode="tel"
                placeholder="555 123 4567"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                onPaste={(e) => {
                  // Normalize pasted E.164/international input so we don't
                  // double the country code or keep a national trunk "0".
                  const text = e.clipboardData.getData("text");
                  if (!text.trim()) return;
                  e.preventDefault();
                  const { country: c, number: n } = normalizePhonePaste(text, country);
                  setCountry(c);
                  setNumber(n);
                }}
                onKeyDown={(e) => e.key === "Enter" && number.trim() && submitPhone()}
              />
            </div>
          </div>
          <Button onClick={submitPhone} disabled={!number.trim() || loading} className="w-full">
            {loading && <Spinner />}
            Get OTP
          </Button>
        </section>
      )}

      <footer className="border-t pt-5 text-sm text-muted-foreground">
        already have an account?{" "}
        <Link href="/auth/login" className="font-medium text-primary hover:underline">
          log in
        </Link>
      </footer>

      {/* Work-email nudge */}
      <Dialog open={nudge} onOpenChange={setNudge}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Use a personal email?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{email}</span>
              {" "}looks like a work address. Use a personal email so you always have access to the interface — we&apos;ll ask for a work email when you join your team&apos;s Silicon.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4">
            <Button onClick={() => setNudge(false)} className="w-full">
              Edit email
            </Button>
            <button
              type="button"
              onClick={proceedEmail}
              disabled={loading}
              className="inline-flex items-center gap-1.5 text-sm text-black transition-opacity hover:underline disabled:opacity-50"
            >
              {loading && <Spinner />}
              Continue anyway
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Email OTP */}
      <OtpDialog
        open={emailDialog}
        onOpenChange={setEmailDialog}
        title="Verify your email"
        target={email.trim()}
        onEdit={() => {
          setEmailDialog(false);
          setStep("email");
        }}
        onVerify={verifyEmail}
        resend={emailResend}
        onResend={resendEmail}
        loading={loading}
      />

      {/* Phone OTP */}
      <OtpDialog
        open={phoneDialog}
        onOpenChange={setPhoneDialog}
        title="Verify your phone"
        target={phoneE164}
        onEdit={() => setPhoneDialog(false)}
        onVerify={verifyPhone}
        resend={phoneResend}
        onResend={resendPhone}
        loading={loading}
      />
    </div>
  );
}

function Stepper({
  step,
  emailVerified,
  phoneVerified,
}: {
  step: Step;
  emailVerified: boolean;
  phoneVerified: boolean;
}) {
  // Carbon ID is picked during the personalized onboarding flow (post-phone-
  // verify), so register only surfaces the two verification steps here.
  const items: { id: Step; label: string; done: boolean }[] = [
    { id: "email", label: "email", done: emailVerified },
    { id: "phone", label: "phone", done: phoneVerified },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs">
      {items.map((it, i) => (
        <li key={it.id} className="flex items-center gap-2">
          <div
            className={
              "flex h-6 w-6 items-center justify-center border text-[11px] font-medium transition-colors " +
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
