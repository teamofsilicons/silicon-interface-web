"use client";

import { AppHeader } from "@/components/app-header";
import { AuthGuard } from "@/components/auth-guard";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex min-h-screen flex-col">
        <AppHeader active="settings" />
        <main className="flex-1 bg-background">
          <div className="mx-auto w-full max-w-3xl px-6 py-8">{children}</div>
        </main>
      </div>
    </AuthGuard>
  );
}
