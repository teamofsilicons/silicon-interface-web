"use client";

import { AppHeader } from "@/components/app-header";
import { AuthGuard } from "@/components/auth-guard";

export default function DevLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex min-h-screen flex-col">
        <AppHeader active="dev" />
        <main className="flex-1 bg-background">
          <div className="mx-auto w-full max-w-6xl px-6 py-8">{children}</div>
        </main>
      </div>
    </AuthGuard>
  );
}
