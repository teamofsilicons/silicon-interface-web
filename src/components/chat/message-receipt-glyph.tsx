"use client";

import {
  Check,
  Checks,
  Clock,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";

import {
  messageReceiptPresentation,
  type MessageReceiptStatus,
} from "@/lib/message-receipt";
import { cn } from "@/lib/utils";

/** One receipt renderer shared by timeline bubbles and sidebar rows.
 *
 * waiting          ph ph-clock
 * accepted by Glass ph ph-check
 * receiver delivery ph ph-checks
 * fully read       ph-fill ph-checks
 */
export function MessageReceiptGlyph({
  status,
  className,
}: {
  status: MessageReceiptStatus;
  className?: string;
}) {
  const presentation = messageReceiptPresentation(status);
  if (presentation.visual === "attention") {
    return (
      <WarningCircle
        className={cn("text-destructive", className)}
        aria-label={presentation.label}
      />
    );
  }
  if (presentation.visual === "waiting") {
    return (
      <Clock
        className={cn("ph ph-clock opacity-60", className)}
        aria-label={presentation.label}
      />
    );
  }
  if (presentation.visual === "read") {
    return (
      <Checks
        weight="fill"
        className={cn("ph-fill ph-checks", className)}
        aria-label={presentation.label}
      />
    );
  }
  if (presentation.visual === "delivered") {
    return (
      <Checks
        weight="regular"
        className={cn("ph ph-checks", className)}
        aria-label={presentation.label}
      />
    );
  }
  return (
    <Check
      weight="regular"
      className={cn("ph ph-check", className)}
      aria-label={presentation.label}
    />
  );
}
