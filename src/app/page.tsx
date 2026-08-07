"use client";

import * as React from "react";
import Link from "next/link";

import { api } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { renewableSessionExpired } from "@/lib/session-expiry";
import { canEnterAppFromLanding } from "@/lib/session-bootstrap";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";

export default function HomePage() {
  // Whether this browser is on its way to /chat. Starts false so the first
  // client render matches the server's (localStorage is client-only), then
  // flips in the effect below — a returning owner sees at most one frame of
  // this page instead of the whole thing while a refresh round trip decides.
  const [leaving, setLeaving] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    // Use a document navigation here, not an App Router transition. If a
    // long-idle tab has stale route/chunk state, a soft transition from the
    // landing page can fall through to Next's global "page couldn't load"
    // screen. A hard replace gives /chat a clean boot from the latest HTML.
    const enterApp = () => {
      setLeaving(true);
      window.location.replace("/chat");
    };
    // Everything this reads is local, so the common case — a returning owner
    // whose session was working the last time anyone asked — redirects on the
    // first frame. Only a session *proven* expired stays here to sign in.
    if (canEnterAppFromLanding(
      Boolean(authStore.getAccess() || authStore.getSiliconKey()),
      authStore.hasPersistedOwner(),
      authStore.wasExplicitlyLoggedOut(),
      renewableSessionExpired(),
    )) {
      enterApp();
      return () => { alive = false; };
    }
    if (authStore.wasExplicitlyLoggedOut() || renewableSessionExpired()) {
      // Nothing to ask about: this browser has no session to restore, and a
      // needless refresh call would only advertise the landing page to Glass.
      return () => { alive = false; };
    }
    // No local owner, but the HttpOnly cookie outlives localStorage — a cleared
    // profile or a brand-new device that was signed in elsewhere still deserves
    // its chats. That case, and only that case, pays for the round trip.
    void (async () => {
      const authed = await api.restoreWebSession();
      if (!alive || !authed) return;
      enterApp();
    })();
    return () => { alive = false; };
  }, []);

  if (leaving) return null;

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
