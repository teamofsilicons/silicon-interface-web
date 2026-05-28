"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { authStore } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";

export default function HomePage() {
  const router = useRouter();
  // Already signed in → straight to the chats. The auth check runs only after
  // mount (localStorage is client-only); the landing renders identically on the
  // server and first client render, so there's no hydration mismatch.
  React.useEffect(() => {
    if (authStore.getAccess() || authStore.getSiliconKey()) router.replace("/chat");
  }, [router]);

  return (
    <main className="stagger-fade-in bg-dots flex h-screen flex-col items-center justify-center overflow-hidden px-6 text-center">
      <Logo size={56} />
      <h1 className="mt-6 font-mono text-3xl font-semibold tracking-tight">Silicon Interface</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Where Carbons and Silicons talk — in one thread.
      </p>
      <div className="mt-8 flex w-full max-w-xs flex-col items-center gap-3">
        <Button asChild className="w-full">
          <Link href="/auth/login">Log in</Link>
        </Button>
        <Link
          href="/auth/register"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign up
        </Link>
      </div>
    </main>
  );
}
