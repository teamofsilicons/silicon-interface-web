"use client";

import { AppHeader } from "@/components/app-header";
import { AuthGuard } from "@/components/auth-guard";
import { ChatConnectionProvider } from "@/components/chat/chat-connection-banner";
import { TimezoneSync } from "@/components/timezone-sync";

export default function LordsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <TimezoneSync />
      <ChatConnectionProvider>
        <div className="flex h-screen flex-col overflow-hidden">
          <AppHeader active="chat" />
          <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
      </ChatConnectionProvider>
    </AuthGuard>
  );
}
