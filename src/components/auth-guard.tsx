"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { api } from "@/lib/api";
import { authStore } from "@/lib/auth";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    const hasAccess = authStore.getAccess();
    if (!hasAccess && !authStore.getSiliconKey()) {
      router.replace("/auth/login");
      return;
    }
    // Render immediately when the carbon profile is already cached (or this is a
    // silicon-key session with no carbon). Otherwise — a token but no cached/
    // readable profile — fetch it FIRST and only then reveal the app, so children
    // never flash the default "base" identity (null carbon → no name/photo) before
    // the real one loads. (P0-5 used to render right away and backfill async,
    // which caused that base→set flicker on every load with an empty cache.)
    if (!hasAccess || authStore.getCarbon()) {
      setOk(true);
      return;
    }
    api
      .me()
      .then((me) => authStore.setCarbon(me))
      .catch(() => undefined)
      .finally(() => {
        if (alive) setOk(true);
      });
    return () => {
      alive = false;
    };
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
