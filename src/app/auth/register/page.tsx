"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DevCodeButton } from "@/components/dev-code-button";

type Step = "phone" | "email" | "username";

export default function RegisterPage() {
  const router = useRouter();
  const [flowId, setFlowId] = React.useState<string>("");
  const [phone, setPhone] = React.useState("");
  const [phoneCode, setPhoneCode] = React.useState("");
  const [phoneVerified, setPhoneVerified] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [emailCode, setEmailCode] = React.useState("");
  const [emailVerified, setEmailVerified] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [step, setStep] = React.useState<Step>("phone");

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

  const sendPhone = () =>
    wrap(async () => {
      const r = await api.registerPhoneStart(phone, flowId || undefined);
      setFlowId(r.flow_id);
      toast.success(`code sent to ${phone}`);
    });

  const verifyPhone = () =>
    wrap(async () => {
      const r = await api.registerPhoneVerify(flowId, phone, phoneCode);
      if (r.verified) {
        setPhoneVerified(true);
        setStep("email");
        toast.success("phone verified");
      }
    });

  const sendEmail = () =>
    wrap(async () => {
      await api.registerEmailStart(flowId, email);
      toast.success(`code sent to ${email}`);
    });

  const verifyEmail = () =>
    wrap(async () => {
      const r = await api.registerEmailVerify(flowId, email, emailCode);
      if (r.verified) {
        setEmailVerified(true);
        setStep("username");
        toast.success("email verified");
      }
    });

  const finalize = () =>
    wrap(async () => {
      const session = await api.registerUsername(flowId, username || undefined);
      authStore.setSession(session);
      toast.success(`welcome, ${session.carbon.username}`);
      router.replace("/chat");
    });

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">register</h1>
        <p className="text-sm text-muted-foreground">
          Three steps: phone, email, username. Phone and email order doesn&apos;t matter.
        </p>
      </header>

      <Stepper step={step} phoneVerified={phoneVerified} emailVerified={emailVerified} />

      {step === "phone" && (
        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phone">phone (E.164)</Label>
            <Input
              id="phone"
              placeholder="+14155551212"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={phoneVerified}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={sendPhone} disabled={!phone || loading}>
              {loading && <Loader2 className="animate-spin" />}
              send code
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => setStep("email")}
            >
              skip → email first
            </Button>
          </div>
          {flowId && (
            <div className="space-y-2 border-t pt-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="phoneCode">code</Label>
                <DevCodeButton target={phone} onFill={setPhoneCode} />
              </div>
              <Input
                id="phoneCode"
                placeholder="123456"
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
              />
              <Button onClick={verifyPhone} disabled={!phoneCode || loading}>
                verify phone
              </Button>
            </div>
          )}
        </section>
      )}

      {step === "email" && (
        <section className="space-y-4">
          {!flowId && (
            <p className="text-xs text-destructive">
              You need a flow_id — start with phone first OR call email-start directly here:
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={emailVerified}
            />
          </div>
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                if (!flowId) {
                  // start a phone-less flow by passing empty phone:start with a placeholder phone
                  // (the API requires phone:start to begin a flow). Easier path: tell the user.
                  toast.error("complete phone step first to obtain a flow_id");
                  setStep("phone");
                  return;
                }
                await sendEmail();
              }}
              disabled={!email || loading || !flowId}
            >
              send code
            </Button>
            <Button variant="ghost" type="button" onClick={() => setStep("phone")}>
              ← back
            </Button>
          </div>
          <div className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="emailCode">code</Label>
              <DevCodeButton target={email} onFill={setEmailCode} />
            </div>
            <Input
              id="emailCode"
              placeholder="123456"
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
              inputMode="numeric"
              maxLength={6}
            />
            <Button onClick={verifyEmail} disabled={!emailCode || loading}>
              verify email
            </Button>
          </div>
        </section>
      )}

      {step === "username" && (
        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">username</Label>
            <Input
              id="username"
              placeholder={email ? email.split("@")[0] : "alice"}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits, _, ., -. Leave blank to use the email local part.
            </p>
          </div>
          <Button onClick={finalize} disabled={loading} className="w-full">
            {loading && <Loader2 className="animate-spin" />}
            finish & sign in
          </Button>
        </section>
      )}
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
    { id: "username", label: "username", done: false },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs">
      {items.map((it, i) => (
        <li key={it.id} className="flex items-center gap-2">
          <div
            className={
              "flex h-6 w-6 items-center justify-center rounded-full border " +
              (it.done
                ? "border-primary bg-primary text-primary-foreground"
                : step === it.id
                  ? "border-foreground text-foreground"
                  : "border-border text-muted-foreground")
            }
          >
            {it.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </div>
          <span
            className={
              step === it.id
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            }
          >
            {it.label}
          </span>
          {i < items.length - 1 && <span className="h-px w-8 bg-border" />}
        </li>
      ))}
    </ol>
  );
}
