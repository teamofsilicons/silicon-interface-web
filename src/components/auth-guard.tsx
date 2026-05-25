"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { authStore } from "@/lib/auth";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => {
    if (authStore.getAccess() || authStore.getSiliconKey()) setOk(true);
    else router.replace("/auth/login");
  }, [router]);
  if (!ok) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-muted-foreground">authenticating…</div>
      </main>
    );
  }
  return <>{children}</>;
}
