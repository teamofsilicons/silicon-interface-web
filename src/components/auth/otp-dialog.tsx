"use client";

import * as React from "react";
import { CircleNotch, PencilSimple } from "@phosphor-icons/react/dist/ssr";

import type { useResendCooldown } from "@/lib/use-resend";
import {
  verificationDeliveryMessage,
  type VerificationDeliveryFailure,
} from "@/lib/verification-delivery";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OtpInput } from "./otp-input";
import { ResendRow } from "./resend-row";

interface OtpDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  /** The target shown to the user (email or +phone). */
  target: string;
  /** Pencil → go back and edit the target. */
  onEdit: () => void;
  onVerify: (code: string) => void;
  resend: ReturnType<typeof useResendCooldown>;
  onResend: () => void;
  loading: boolean;
  deliveryFailure?: VerificationDeliveryFailure | null;
  providerWaitSeconds?: number;
}

/** OTP entry dialog with a pencil-to-edit affordance and escalating resend. */
export function OtpDialog({
  open,
  onOpenChange,
  title,
  target,
  onEdit,
  onVerify,
  resend,
  onResend,
  loading,
  deliveryFailure = null,
  providerWaitSeconds = 0,
}: OtpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            <span>
              {deliveryFailure ? "delivery not confirmed for " : "code sent to "}
              <span className="font-medium text-foreground">{target}</span>
            </span>
            <button
              type="button"
              onClick={onEdit}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label="edit"
              title="edit"
            >
              <PencilSimple className="h-3.5 w-3.5" />
            </button>
          </DialogDescription>
        </DialogHeader>
        {/* Body lives inside DialogContent so it unmounts on close — the code box
            resets itself on each open without an effect. */}
        <OtpBody
          onVerify={onVerify}
          resend={resend}
          onResend={onResend}
          loading={loading}
          deliveryFailure={deliveryFailure}
          providerWaitSeconds={providerWaitSeconds}
        />
      </DialogContent>
    </Dialog>
  );
}

function OtpBody({
  onVerify,
  resend,
  onResend,
  loading,
  deliveryFailure,
  providerWaitSeconds,
}: Pick<
  OtpDialogProps,
  | "onVerify"
  | "resend"
  | "onResend"
  | "loading"
  | "deliveryFailure"
  | "providerWaitSeconds"
>) {
  const [code, setCode] = React.useState("");
  return (
    <div className="space-y-4">
      {deliveryFailure && (
        <div
          role="status"
          aria-live="polite"
          className="border border-amber-600/50 bg-amber-500/10 px-3 py-2 text-xs"
        >
          <p>{verificationDeliveryMessage(deliveryFailure)}</p>
          {(providerWaitSeconds ?? 0) > 0 && (
            <p className="mt-1 font-mono text-muted-foreground">
              retry available in {providerWaitSeconds}s
            </p>
          )}
        </div>
      )}
      <OtpInput value={code} onChange={setCode} autoFocus onComplete={onVerify} />
      <ResendRow
        resend={resend}
        onResend={onResend}
        loading={loading}
        providerWaitSeconds={providerWaitSeconds}
      />
      <Button
        onClick={() => onVerify(code)}
        disabled={code.length !== 6 || loading}
        className="w-full"
      >
        {loading && <CircleNotch className="animate-spin" />}
        verify
      </Button>
    </div>
  );
}
