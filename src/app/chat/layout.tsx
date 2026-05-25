"use client";

import { AppHeader } from "@/components/app-header";
import { AuthGuard } from "@/components/auth-guard";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex min-h-screen flex-col">
        <AppHeader active="chat" />
        <div className="flex flex-1 overflow-hidden">{children}</div>
      </div>
    </AuthGuard>
  );
}
