"use client";

import * as React from "react";
import { CircleNotch, ShieldCheck } from "@phosphor-icons/react/dist/ssr";

import { api, ApiError } from "@/lib/api";
import { authStore, useAuth } from "@/lib/auth";
import {
  ABUSE_CHALLENGE_EVENT,
  ABUSE_CHALLENGE_SOLVED_EVENT,
  listAbuseChallenges,
  markAbuseChallengeSolved,
  removeAbuseChallenge,
  type AbuseChallenge,
} from "@/lib/abuse-challenge-store";
import { releaseOutboxChallenge } from "@/lib/outbox";
import { readAbuseProof, removeAbuseProof } from "@/lib/abuse-proof-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

declare global {
  interface Window {
    turnstile?: {
      render(
        element: HTMLElement,
        options: {
          sitekey: string;
          action: string;
          cData: string;
          callback: (token: string) => void;
          "error-callback": () => void;
          "expired-callback": () => void;
        },
      ): string;
      remove(widgetId: string): void;
    };
  }
}

let turnstileScript: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScript) return turnstileScript;
  turnstileScript = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-silicon-turnstile="true"]',
    );
    const script = existing ?? document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.siliconTurnstile = "true";
    script.onload = () => resolve();
    script.onerror = () => {
      turnstileScript = null;
      reject(new Error("Verification widget could not load."));
    };
    if (!existing) document.head.appendChild(script);
  });
  return turnstileScript;
}

function ownerId(): string | null {
  const carbonId = authStore.getCarbon()?.carbon_id;
  return carbonId ?? null;
}

export function AbuseChallengeGate() {
  const { carbon } = useAuth();
  const owner = carbon?.carbon_id ?? null;
  const [active, setActive] = React.useState<AbuseChallenge | null>(null);
  const [status, setStatus] = React.useState("");
  const [working, setWorking] = React.useState(false);
  const captchaRef = React.useRef<HTMLDivElement | null>(null);
  const requestedPushRef = React.useRef<string | null>(null);
  const solvingRef = React.useRef(false);

  const loadNext = React.useCallback(async () => {
    if (!owner) {
      setActive(null);
      return;
    }
    const rows = await listAbuseChallenges(owner).catch(() => []);
    let next: AbuseChallenge | null = null;
    for (const row of rows) {
      if (Date.parse(row.expires_at) > Date.now()) {
        next = row;
        break;
      }
      await removeAbuseProof(row.token);
      await removeAbuseChallenge(owner, row.token);
      await releaseOutboxChallenge(owner, row.token).catch(() => undefined);
      window.dispatchEvent(new CustomEvent(ABUSE_CHALLENGE_SOLVED_EVENT));
    }
    setActive(next);
  }, [owner]);

  React.useEffect(() => {
    queueMicrotask(() => void loadNext());
    const announced = (event: Event) => {
      const challenge = (event as CustomEvent<AbuseChallenge>).detail;
      if (challenge?.token) setActive(challenge);
    };
    window.addEventListener(ABUSE_CHALLENGE_EVENT, announced);
    return () => window.removeEventListener(ABUSE_CHALLENGE_EVENT, announced);
  }, [loadNext]);

  const solve = React.useCallback(
    async (challenge: AbuseChallenge, type: "push" | "captcha", answer: string) => {
      const currentOwner = ownerId();
      if (!currentOwner || solvingRef.current) return;
      solvingRef.current = true;
      setWorking(true);
      setStatus("Checking verification…");
      try {
        await api.answerAbuseChallenge({ token: challenge.token, type, answer });
        await removeAbuseProof(challenge.token);
        await markAbuseChallengeSolved(currentOwner, challenge.token);
        await releaseOutboxChallenge(currentOwner, challenge.token);
        setStatus("Verified. Sending your saved message now.");
        window.dispatchEvent(new CustomEvent(ABUSE_CHALLENGE_SOLVED_EVENT));
        setActive(null);
        await loadNext();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          await removeAbuseProof(challenge.token);
          await removeAbuseChallenge(currentOwner, challenge.token);
          await releaseOutboxChallenge(currentOwner, challenge.token);
          window.dispatchEvent(new CustomEvent(ABUSE_CHALLENGE_SOLVED_EVENT));
          setActive(null);
          await loadNext();
          return;
        }
        setStatus(
          error instanceof ApiError
            ? error.message
            : "Verification could not be completed. Your message is still saved.",
        );
      } finally {
        solvingRef.current = false;
        setWorking(false);
      }
    },
    [loadNext],
  );

  const requestPush = React.useCallback(async () => {
    if (!active || !active.options.includes("push")) return;
    setWorking(true);
    setStatus("Sending a private verification to your device…");
    try {
      const result = await api.requestAbuseChallengePush(active.token);
      if (result.solved) {
        const currentOwner = ownerId();
        if (currentOwner) {
          await removeAbuseProof(active.token);
          await markAbuseChallengeSolved(currentOwner, active.token);
          await releaseOutboxChallenge(currentOwner, active.token);
        }
        window.dispatchEvent(new CustomEvent(ABUSE_CHALLENGE_SOLVED_EVENT));
        setActive(null);
        await loadNext();
      } else {
        setStatus("Verification sent. Open the notification on your registered device.");
      }
    } catch (error) {
      setStatus(
        error instanceof ApiError
          ? error.message
          : "Push verification is temporarily unavailable. Your message is still saved.",
      );
    } finally {
      setWorking(false);
    }
  }, [active, loadNext]);

  React.useEffect(() => {
    if (!active?.options.includes("push") || requestedPushRef.current === active.token) return;
    requestedPushRef.current = active.token;
    void requestPush();
  }, [active, requestPush]);

  React.useEffect(() => {
    const receiveProof = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (
        data?.type !== "silicon-abuse-challenge-proof" ||
        typeof data.token !== "string" ||
        typeof data.answer !== "string"
      ) return;
      void (async () => {
        const currentOwner = ownerId();
        if (!currentOwner) return;
        const challenge = (await listAbuseChallenges(currentOwner)).find(
          (row) => row.token === data.token,
        );
        if (challenge) await solve(challenge, "push", data.answer as string);
      })();
    };
    navigator.serviceWorker?.addEventListener("message", receiveProof);
    return () => navigator.serviceWorker?.removeEventListener("message", receiveProof);
  }, [solve]);

  React.useEffect(() => {
    if (!active?.options.includes("push")) return;
    void readAbuseProof(active.token).then((answer) => {
      if (answer) void solve(active, "push", answer);
    });
  }, [active, solve]);

  React.useEffect(() => {
    const captcha = active?.captcha;
    if (!captcha || !active.options.includes("captcha") || !captchaRef.current) return;
    let cancelled = false;
    let widgetId: string | null = null;
    void loadTurnstile()
      .then(() => {
        if (cancelled || !captchaRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(captchaRef.current, {
          sitekey: captcha.site_key,
          action: captcha.action,
          cData: captcha.cdata,
          callback: (token) => void solve(active, "captcha", token),
          "error-callback": () => setStatus("Verification widget failed. Try push or reload."),
          "expired-callback": () => setStatus("Verification expired. Please try again."),
        });
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : "Verification failed."));
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [active, solve]);

  return (
    <Dialog open={Boolean(active)} onOpenChange={() => undefined}>
      <DialogContent className="max-w-md" aria-describedby="abuse-challenge-description">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" /> Verify this device
          </DialogTitle>
          <DialogDescription id="abuse-challenge-description">
            We paused sending after unusual activity. Your message and attachments remain safely
            saved on this device.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4" aria-live="polite">
          {active?.options.includes("push") ? (
            <Button type="button" className="w-full" onClick={() => void requestPush()} disabled={working}>
              {working ? <CircleNotch className="mr-2 animate-spin" aria-hidden="true" /> : null}
              Send device verification
            </Button>
          ) : null}
          {active?.captcha ? (
            <div>
              <p className="mb-2 text-sm text-muted-foreground">
                Or complete the accessible browser check:
              </p>
              <div ref={captchaRef} className="min-h-16" />
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {status || "Choose a verification method to continue."}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
