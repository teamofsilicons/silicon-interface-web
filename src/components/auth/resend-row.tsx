"use client";

import type { useResendCooldown } from "@/lib/use-resend";

/** Resend control shared by login & sign-up: shows the cooldown, then a humorous lockout. */
export function ResendRow({
  resend,
  onResend,
  loading,
  providerWaitSeconds = 0,
}: {
  resend: ReturnType<typeof useResendCooldown>;
  onResend: () => void;
  loading: boolean;
  providerWaitSeconds?: number;
}) {
  if (resend.lockedOut) {
    return (
      <p className="text-xs text-muted-foreground">
        That&apos;s a lot of codes. Take a breather and try again later. ☕
      </p>
    );
  }
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={onResend}
        disabled={resend.active || providerWaitSeconds > 0 || loading}
        className="text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {providerWaitSeconds > 0
          ? `provider retry in ${providerWaitSeconds}s`
          : resend.active
            ? `resend code in ${resend.remaining}s`
            : "resend code"}
      </button>
    </div>
  );
}
