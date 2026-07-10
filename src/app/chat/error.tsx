"use client";

import * as React from "react";

import { markRecoveryAttempt } from "@/lib/recovery";

export default function ChatError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  const details = [error.message, error.digest].filter(Boolean).join(" | ");

  React.useEffect(() => {
    console.error(error);
    // A segment retry keeps the same mounted renderer and persisted state. That
    // is exactly what we need to replace after a maximum-depth loop (and after
    // a long-lived desktop WKWebView has survived a deployment), so recover
    // with one real document load instead.
    if (markRecoveryAttempt("chat-error-document-v2", 10_000)) {
      queueMicrotask(() => {
        window.location.reload();
      });
      return;
    }
    // If a clean document immediately reaches the same bad room state, leave
    // that room selected only in the URL and return to the usable chat list.
    // Drafts and other user data are deliberately left intact.
    if (markRecoveryAttempt("chat-error-safe-route-v2", 60_000)) {
      queueMicrotask(() => window.location.replace("/chat"));
    }
  }, [error]);

  return (
    <main
      data-silicon-chat-error="true"
      className="grid h-full min-h-0 w-full flex-1 place-items-center bg-background px-6 text-center"
    >
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
        <button
          type="button"
          className="ml-2 border px-3 py-2 text-sm hover:bg-accent"
          onClick={() => window.location.replace("/chat")}
        >
          Back to chats
        </button>
      </div>
    </main>
  );
}
