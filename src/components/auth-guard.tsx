"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { ensureDeviceRegistration } from "@/lib/device-registration";
import {
  canPaintRetainedSession,
  isAuthoritativeSessionRevocation,
  sessionBootDecision,
  type WebSessionRestoreState,
} from "@/lib/session-bootstrap";

const RESTORE_RETRY_MS = 1_500;
const RESTORE_RETRY_MAX_MS = 60_000;
const ANONYMOUS_CONFIRM_MS = 500;

async function restoreBrowserAuthority(): Promise<WebSessionRestoreState> {
  // The renewable HttpOnly cookie is the browser session authority. Missing,
  // unavailable, or evicted localStorage must never turn into logout: the user
  // remains signed in until explicit logout or an authoritative backend
  // rejection proves that the cookie/session is no longer valid.
  if (authStore.getAccess() || authStore.getSiliconKey()) return "restored";
  return api.restoreWebSessionState();
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    let retryTimer: number | null = null;
    let deviceRetryTimer: number | null = null;
    let running = false;
    let anonymousConfirmations = 0;
    let retryDelay = RESTORE_RETRY_MS;

    const schedule = (delay: number) => {
      if (!alive) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void boot(), delay);
    };
    const scheduleRetry = () => {
      schedule(retryDelay);
      retryDelay = Math.min(retryDelay * 2, RESTORE_RETRY_MAX_MS);
    };
    const scheduleDeviceRegistration = (delay = 0) => {
      if (!alive || authStore.getSiliconKey() || authStore.getBoundDeviceId()) return;
      if (deviceRetryTimer !== null) window.clearTimeout(deviceRetryTimer);
      deviceRetryTimer = window.setTimeout(() => {
        deviceRetryTimer = null;
        if (!alive || !authStore.getAccess() || authStore.getBoundDeviceId()) return;
        void ensureDeviceRegistration().then((registered) => {
          if (alive && !registered) scheduleDeviceRegistration(5_000);
        });
      }, delay);
    };
    const boot = async () => {
      if (!alive || running) return;
      running = true;
      try {
        const state = await restoreBrowserAuthority();
        if (!alive) return;
        if (state === "restored") retryDelay = RESTORE_RETRY_MS;
        anonymousConfirmations = state === "anonymous" ? anonymousConfirmations + 1 : 0;
        const hasRetainedOwner = state === "anonymous"
          ? authStore.hasPersistedOwner()
          : Boolean(authStore.getCarbon());
        const decision = sessionBootDecision(
          state,
          hasRetainedOwner,
          anonymousConfirmations,
        );
        if (decision === "login") {
          // A retained shell may already be visible while restoration runs.
          // Cover it before an authoritative revocation redirects the page.
          setOk(false);
          if (state === "revoked") authStore.clear("revoked");
          router.replace("/auth/login");
          return;
        }
        if (decision === "confirm-anonymous") {
          schedule(ANONYMOUS_CONFIRM_MS);
          return;
        }
        if (decision === "retry" || decision === "enter-and-retry") {
          if (decision === "enter-and-retry") {
            setOk(true);
            scheduleDeviceRegistration();
          }
          scheduleRetry();
          return;
        }

        if (authStore.getAccess()) {
          try {
            await api.me().then((me) => authStore.setCarbon(me));
          } catch (error) {
            const rejected = error instanceof ApiError &&
              isAuthoritativeSessionRevocation(error.status, error.body);
            if (rejected) {
              // Only a typed backend revocation may end an established local
              // session. Generic 401s can be stale-token or cookie-availability
              // races and remain in the retry path below.
              setOk(false);
              authStore.clear("revoked");
              router.replace("/auth/login");
              return;
            }
            if (authStore.getCarbon()) {
              setOk(true);
              scheduleDeviceRegistration();
            }
            scheduleRetry();
            return;
          }
        }
        // Token validity is the entry gate. Installation registration and
        // durable-storage permission are important follow-up work, but neither
        // should hold a valid returning user behind the boot screen on a slow
        // network. Both operations are idempotent and continue in background;
        // installation registration retries until presence and explicit
        // delivery ACKs are device-aware instead of silently remaining legacy.
        if (alive) {
          setOk(true);
          scheduleDeviceRegistration();
        }
        void navigator.storage?.persist?.().catch(() => false);
      } catch {
        // Fetch/CORS/runtime failures are availability failures, not logout.
        if (authStore.getCarbon()) setOk(true);
        scheduleRetry();
      } finally {
        running = false;
      }
    };
    // The restricted persisted identity and owner-namespaced chat caches are
    // deliberately the app's offline-capable state. Paint that shell now for a
    // returning browser instead of holding it behind refresh + /me round trips;
    // boot still starts in the same effect and refreshes authority/profile in
    // the background. A first-time or explicitly logged-out browser continues
    // to see the boot sequence until its session state is known.
    if (canPaintRetainedSession(
      Boolean(authStore.getAccess() || authStore.getSiliconKey()),
      authStore.hasPersistedOwner(),
      authStore.wasExplicitlyLoggedOut(),
    )) {
      queueMicrotask(() => {
        if (alive) setOk(true);
      });
    }
    void boot();
    // An offline first boot must not strand a legacy, installation-unbound
    // session until the guard happens to remount. Registration is idempotent
    // and coalesced, so every online transition is a safe retry point.
    const onOnline = () => {
      retryDelay = RESTORE_RETRY_MS;
      schedule(0);
      scheduleDeviceRegistration();
    };
    window.addEventListener("online", onOnline);
    return () => {
      alive = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (deviceRetryTimer !== null) window.clearTimeout(deviceRetryTimer);
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
        const state = await restoreBrowserAuthority();
        if (!alive) return;
        anonymousConfirmations = state === "anonymous" ? anonymousConfirmations + 1 : 0;
        const hasRetainedOwner = state === "anonymous"
          ? authStore.hasPersistedOwner()
          : Boolean(authStore.getCarbon());
        const decision = sessionBootDecision(
          state,
          hasRetainedOwner,
          anonymousConfirmations,
        );
        if (decision === "enter" || decision === "enter-and-retry") {
          router.replace("/chat");
        } else if (decision === "login") {
          if (state === "revoked") authStore.clear("revoked");
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
