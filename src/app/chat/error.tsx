"use client";

import * as React from "react";

import { markRecoveryAttempt } from "@/lib/recovery";

export default function ChatError({
  error,
  unstable_retry,
  reset,
}: {
  error: Error & { digest?: string };
  unstable_retry?: () => void;
  reset?: () => void;
}) {
  const details = [error.message, error.digest].filter(Boolean).join(" | ");

  React.useEffect(() => {
    console.error(error);
    if (markRecoveryAttempt("chat-error", 8_000)) {
      queueMicrotask(() => {
        if (unstable_retry) unstable_retry();
        else reset?.();
      });
    }
  }, [error, reset, unstable_retry]);

  return (
    <main className="grid h-full min-h-0 w-full flex-1 place-items-center bg-background px-6 text-center">
      <div className="space-y-4">
        <p className="font-mono text-sm text-muted-foreground">chat could not reopen cleanly</p>
        {details ? (
          <p className="mx-auto max-w-lg break-words font-mono text-[11px] text-muted-foreground/70">
            {details}
          </p>
        ) : null}
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
