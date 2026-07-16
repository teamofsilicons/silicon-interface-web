"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { ensureDeviceRegistration } from "@/lib/device-registration";
import {
  sessionBootDecision,
  type WebSessionRestoreState,
} from "@/lib/session-bootstrap";

const RESTORE_RETRY_MS = 1_500;
const ANONYMOUS_CONFIRM_MS = 500;

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    let retryTimer: number | null = null;
    let running = false;
    let anonymousConfirmations = 0;

    const schedule = (delay: number) => {
      if (!alive) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void boot(), delay);
    };
    const restoreAuthority = async (): Promise<WebSessionRestoreState> => {
      if (authStore.getAccess() || authStore.getSiliconKey()) return "restored";
      return api.restoreWebSessionState();
    };
    const boot = async () => {
      if (!alive || running) return;
      running = true;
      try {
        const state = await restoreAuthority();
        if (!alive) return;
        anonymousConfirmations = state === "anonymous" ? anonymousConfirmations + 1 : 0;
        const decision = sessionBootDecision(
          state,
          Boolean(authStore.getCarbon()),
          anonymousConfirmations,
        );
        if (decision === "login") {
          router.replace("/auth/login");
          return;
        }
        if (decision === "confirm-anonymous") {
          schedule(ANONYMOUS_CONFIRM_MS);
          return;
        }
        if (decision === "retry" || decision === "enter-and-retry") {
          if (decision === "enter-and-retry") setOk(true);
          schedule(RESTORE_RETRY_MS);
          return;
        }

        if (authStore.getAccess()) {
          try {
            await api.me().then((me) => authStore.setCarbon(me));
          } catch (error) {
            const rejected =
              error instanceof ApiError &&
              (error.status === 400 || error.status === 401 || error.status === 403);
            if (rejected) authStore.expireAccess();
            if (authStore.getCarbon()) setOk(true);
            schedule(rejected ? ANONYMOUS_CONFIRM_MS : RESTORE_RETRY_MS);
            return;
          }
        }
        await ensureDeviceRegistration().catch(() => false);
        await navigator.storage?.persist?.().catch(() => false);
        if (alive) setOk(true);
      } catch {
        // Fetch/CORS/runtime failures are availability failures, not logout.
        if (authStore.getCarbon()) setOk(true);
        schedule(RESTORE_RETRY_MS);
      } finally {
        running = false;
      }
    };
    void boot();
    // An offline first boot must not strand a legacy, installation-unbound
    // session until the guard happens to remount. Registration is idempotent
    // and coalesced, so every online transition is a safe retry point.
    const onOnline = () => {
      schedule(0);
    };
    window.addEventListener("online", onOnline);
    return () => {
      alive = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.removeEventListener("online", onOnline);
    };
  }, [router]);
  if (!ok) {
    return <BootSequence />;
  }
  return <>{children}</>;
}

/** Hide login/register UI until the HttpOnly browser session is resolved. */
export function AuthRouteGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [anonymous, setAnonymous] = React.useState(() => authStore.wasExplicitlyLoggedOut());

  React.useEffect(() => {
    let alive = true;
    let retryTimer: number | null = null;
    let running = false;
    let anonymousConfirmations = 0;
    if (authStore.wasExplicitlyLoggedOut()) {
      return () => { alive = false; };
    }
    const schedule = (delay: number) => {
      if (!alive) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void resolve(), delay);
    };
    const resolve = async () => {
      if (!alive || running) return;
      running = true;
      try {
        const state: WebSessionRestoreState =
          authStore.getAccess() || authStore.getSiliconKey()
            ? "restored"
            : await api.restoreWebSessionState();
        if (!alive) return;
        anonymousConfirmations = state === "anonymous" ? anonymousConfirmations + 1 : 0;
        const decision = sessionBootDecision(
          state,
          Boolean(authStore.getCarbon()),
          anonymousConfirmations,
        );
        if (decision === "enter" || decision === "enter-and-retry") {
          router.replace("/chat");
        } else if (decision === "login") {
          setAnonymous(true);
        } else {
          schedule(decision === "confirm-anonymous" ? ANONYMOUS_CONFIRM_MS : RESTORE_RETRY_MS);
        }
      } catch {
        schedule(RESTORE_RETRY_MS);
      } finally {
        running = false;
      }
    };
    void resolve();
    return () => {
      alive = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [router]);

  return anonymous ? <>{children}</> : <BootSequence />;
}

// §2e — boot sequence. While the guard resolves the session, print a terminal
// boot log line-by-line instead of a bare "authenticating…". Under
// prefers-reduced-motion we render every line at once (no typewriter reveal).
const BOOT_LINES = [
  "silicon-interface",
  "> linking carbons + silicons…",
  "> authenticating…",
];

export function BootSequence() {
  const [shown, setShown] = React.useState(1);

  React.useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reveal-all under reduced motion
      setShown(BOOT_LINES.length);
      return;
    }
    if (shown >= BOOT_LINES.length) return;
    const t = window.setTimeout(() => setShown((n) => n + 1), 260);
    return () => window.clearTimeout(t);
  }, [shown]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="font-mono text-sm leading-relaxed text-muted-foreground">
        {BOOT_LINES.slice(0, shown).map((line, i) => (
          <div key={line} className={i === 0 ? "text-foreground" : undefined}>
            {line}
          </div>
        ))}
      </div>
    </main>
  );
}
