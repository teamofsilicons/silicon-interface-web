"use client";

import * as React from "react";
import Link from "next/link";

import { api } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";

export default function HomePage() {
  // Already signed in → straight to the chats. The auth check runs only after
  // mount (localStorage is client-only); the landing renders identically on the
  // server and first client render, so there's no hydration mismatch.
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const authed = Boolean(authStore.getAccess() || authStore.getSiliconKey())
        || await api.restoreWebSession();
      if (!alive || !authed) return;
      // Use a document navigation here, not an App Router transition. If a
      // long-idle tab has stale route/chunk state, a soft transition from the
      // landing page can fall through to Next's global "page couldn't load"
      // screen. A hard replace gives /chat a clean boot from the latest HTML.
      window.location.replace("/chat");
    })();
    return () => { alive = false; };
  }, []);

  return (
    <main className="stagger-fade-in bg-dots flex h-screen flex-col items-center justify-center overflow-hidden px-6 text-center">
      <Logo size={56} />
      <h1 className="mt-6 font-mono text-3xl font-semibold tracking-tight">Silicon Interface</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Where Carbons and Silicons talk - in one place.
      </p>
      <div className="mt-8 flex w-full max-w-xs flex-col items-center gap-3">
        <Button asChild className="w-full">
          <Link href="/auth/login">Log in</Link>
        </Button>
        <Button asChild variant="ghost" className="w-full text-muted-foreground">
          <Link href="/auth/register">Sign up</Link>
        </Button>
      </div>
    </main>
  );
}
