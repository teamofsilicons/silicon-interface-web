"use client";

import * as React from "react";

import { markRecoveryAttempt } from "@/lib/recovery";

export default function GlobalError({
  error,
  unstable_retry,
  reset,
}: {
  error: Error & { digest?: string };
  unstable_retry?: () => void;
  reset?: () => void;
}) {
  React.useEffect(() => {
    console.error(error);
    if (markRecoveryAttempt("global-error", 10_000)) {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#ede8e0",
          color: "#1a1a1a",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        <main style={{ display: "grid", gap: 16, justifyItems: "center", textAlign: "center" }}>
          <div style={{ fontSize: 14 }}>interface hit a bad page state</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button type="button" onClick={() => (unstable_retry ? unstable_retry() : reset?.())}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
