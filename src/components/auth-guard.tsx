"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { api } from "@/lib/api";
import { authStore } from "@/lib/auth";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => {
    if (authStore.getAccess() || authStore.getSiliconKey()) {
      setOk(true);
      // P0-5: backfill the carbon profile when we hold a session token but have
      // no cached profile — e.g. login navigated here before its own me()
      // resolved. Without this the app would run with a null carbon.
      if (authStore.getAccess() && !authStore.getCarbon()) {
        api
          .me()
          .then((me) => authStore.setCarbon(me))
          .catch(() => undefined);
      }
    } else {
      router.replace("/auth/login");
    }
  }, [router]);
  if (!ok) {
    return <BootSequence />;
  }
  return <>{children}</>;
}

// §2e — boot sequence. While the guard resolves the session, print a terminal
// boot log line-by-line instead of a bare "authenticating…". Under
// prefers-reduced-motion we render every line at once (no typewriter reveal).
const BOOT_LINES = [
  "silicon-interface",
  "> linking carbons + silicons…",
  "> authenticating…",
];

function BootSequence() {
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
