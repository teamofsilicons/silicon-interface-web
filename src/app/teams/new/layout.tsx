"use client";

import { AuthGuard } from "@/components/auth-guard";

export default function NewTeamLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-background">{children}</div>
    </AuthGuard>
  );
}
