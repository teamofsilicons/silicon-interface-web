"use client";

import * as React from "react";

import { markRecoveryAttempt } from "@/lib/recovery";

export default function ChatError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    if (markRecoveryAttempt("chat-error", 8_000)) {
      reset();
    }
  }, [reset]);

  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-center">
      <div className="space-y-4">
        <p className="font-mono text-sm text-muted-foreground">chat could not reopen cleanly</p>
        <button
          type="button"
          className="border px-3 py-2 text-sm hover:bg-accent"
          onClick={() => window.location.reload()}
        >
          Reload chat
        </button>
      </div>
    </main>
  );
}
