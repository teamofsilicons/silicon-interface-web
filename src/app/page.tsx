"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { authStore } from "@/lib/auth";

export default function HomePage() {
  const router = useRouter();
  React.useEffect(() => {
    if (authStore.getAccess() || authStore.getSiliconKey()) router.replace("/chat");
    else router.replace("/auth/login");
  }, [router]);
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="text-sm text-muted-foreground">loading…</div>
    </main>
  );
}
