"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { probeApiConnectivity } from "@/lib/connectivity-classifier";
import { ensureDeviceRegistration } from "@/lib/device-registration";
import { noteSessionExpired, renewableSessionExpired } from "@/lib/session-expiry";
import { clearSessionIssue, reportSignInRequired } from "@/lib/session-health";
import {
  canPaintRetainedSession,
  isAuthoritativeSessionRevocation,
  sessionBootDecision,
  type WebSessionRestoreState,
} from "@/lib/session-bootstrap";

const RESTORE_RETRY_MS = 1_500;
const RESTORE_RETRY_MAX_MS = 60_000;
const ANONYMOUS_CONFIRM_MS = 500;

/**
 * Consecutive anonymous answers, shared by both guards and deliberately *not*
 * per-mount. A count that resets on mount can never reach its own threshold
 * when the guard unmounts on every decision: /auth/login mounted fresh, counted
 * its first anonymous answer, resolved to `enter-and-retry`, and redirected to
 * /chat — so the owner it was meant to let sign in was bounced away every time.
 * Reset by any non-anonymous answer, exactly as before.
 */
let anonymousConfirmations = 0;

function countAnonymous(state: WebSessionRestoreState): number {
  anonymousConfirmations = state === "anonymous" ? anonymousConfirmations + 1 : 0;
  return anonymousConfirmations;
}

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
    let retryDelay = RESTORE_RETRY_MS;
    const unsubscribe = authStore.subscribe((change) => {
      if (!alive || change !== "cleared") return;
      // API-level expiry/revocation can happen long after the initial boot.
      // Remove the protected shell immediately instead of leaving mounted
      // children to repeat unauthenticated requests until the next reload.
      setOk(false);
      router.replace("/auth/login");
    });
    // Whether this page load ever held a working session. It separates "still
    // loading" from "in use", which is the only thing that decides whether a
    // proven expiry routes the owner out or is reported in place.
    let restoredSinceMount = false;

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
        if (state === "restored") {
          retryDelay = RESTORE_RETRY_MS;
          restoredSinceMount = true;
          clearSessionIssue();
        }
        const confirmations = countAnonymous(state);
        const hasRetainedOwner = state === "anonymous"
          ? authStore.hasPersistedOwner()
          : Boolean(authStore.getCarbon());
        // Only an anonymous answer for a retained owner can be an expired
        // session rather than an unreachable one, so that is the only case
        // worth spending a probe on. The evidence must describe this attempt:
        // a reachability result from an earlier retry could mislabel a network
        // that has since dropped.
        const glassReachable = state === "anonymous" && hasRetainedOwner
          ? (await probeApiConnectivity()) === "reachable"
          : false;
        if (!alive) return;
        const decision = sessionBootDecision(
          state,
          hasRetainedOwner,
          confirmations,
          glassReachable,
        );
        if (decision === "enter-and-signin-required") {
          // Reachable Glass, repeatedly anonymous: the renewable credential is
          // genuinely gone. Record it so the next cold boot routes on the
          // record alone, without re-deriving it over the network.
          noteSessionExpired();
          if (!restoredSinceMount) {
            // Still loading. Send them to the landing page, where signing in is
            // the whole point — nothing local is deleted on the way.
            setOk(false);
            router.replace("/");
            return;
          }
          // The owner is already inside and reading. Yanking them out mid-scroll
          // to say "sign in" is worse than saying it in place: durable history
          // stays readable, the composer keeps queueing, and the banner offers
          // the same destination whenever they choose to take it.
          reportSignInRequired();
          setOk(true);
          scheduleRetry();
          return;
        }
        if (decision === "login") {
          // A retained shell may already be visible while restoration runs.
          // Cover it and discard the stale owner before redirecting. Both an
          // explicit revocation and a confirmed absent session are
          // authoritative responses from the reachable refresh endpoint.
          setOk(false);
          authStore.clear(state === "revoked" ? "revoked" : "expired");
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
    // A previous boot already proved this browser cannot renew. Route on that
    // record alone — no paint, no probe, no refresh round trip — so the one
    // case that genuinely needs the landing page reaches it immediately instead
    // of re-deriving the same answer over the network on every load.
    if (renewableSessionExpired()) {
      router.replace("/");
      return () => {
        alive = false;
      };
    }
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
      unsubscribe();
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
  // A session already proven expired needs no round trip to hide the form: the
  // answer is on disk, and asking again would only delay the one page that can
  // fix it behind a boot screen.
  const [anonymous, setAnonymous] = React.useState(
    () => authStore.wasExplicitlyLoggedOut() || renewableSessionExpired(),
  );

  React.useEffect(() => {
    let alive = true;
    let retryTimer: number | null = null;
    let running = false;
    if (authStore.wasExplicitlyLoggedOut() || renewableSessionExpired()) {
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
        const confirmations = countAnonymous(state);
        const hasRetainedOwner = state === "anonymous"
          ? authStore.hasPersistedOwner()
          : Boolean(authStore.getCarbon());
        const glassReachable = state === "anonymous" && hasRetainedOwner
          ? (await probeApiConnectivity()) === "reachable"
          : false;
        if (!alive) return;
        const decision = sessionBootDecision(
          state,
          hasRetainedOwner,
          confirmations,
          glassReachable,
        );
        if (decision === "enter-and-signin-required") {
          // A retained owner whose credential is provably gone must be able to
          // reach this form. Bouncing them to /chat would strand them behind a
          // banner whose only action returns here.
          noteSessionExpired();
          setAnonymous(true);
        } else if (decision === "enter" || decision === "enter-and-retry") {
          router.replace("/chat");
        } else if (decision === "login") {
          authStore.clear(state === "revoked" ? "revoked" : "expired");
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
