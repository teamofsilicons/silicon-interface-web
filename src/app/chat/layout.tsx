"use client";

import { AppHeader } from "@/components/app-header";
import { AuthGuard } from "@/components/auth-guard";
import { PaymentBanner } from "@/components/teams/payment-banner";
import { TimezoneSync } from "@/components/timezone-sync";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  // h-screen (not min-h-screen) clamps the chat surface to exactly the
  // viewport. Inside, the header has its intrinsic height and the chat row
  // takes the remainder via flex-1; the inner ScrollArea is the *only*
  // thing that scrolls. Without this clamp, a long thread pushes the
  // sidebar and composer off-screen and the whole document scrolls.
  return (
    <AuthGuard>
      <TimezoneSync />
      <div className="flex h-screen flex-col overflow-hidden">
        <AppHeader active="chat" />
        {/* Head-only: escalating payment-deadline banner over the final 15 days. */}
        <PaymentBanner />
        <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </AuthGuard>
  );
}
