"use client";

import {
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
 * waiting          clock
 * accepted by Glass one outlined circled check
 * receiver delivery two overlapping outlined circled checks
 * fully read       two overlapping filled circled checks
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
        className={cn("opacity-60", className)}
        aria-label={presentation.label}
      />
    );
  }
  if (presentation.visual === "read") {
    return (
      <SignalReceiptMark
        state="read"
        label={presentation.label}
        className={cn("receipt-fill", className)}
      />
    );
  }
  if (presentation.visual === "delivered") {
    return (
      <SignalReceiptMark
        state="delivered"
        label={presentation.label}
        className={className}
      />
    );
  }
  return (
    <SignalReceiptMark
      state="sent"
      label={presentation.label}
      className={className}
    />
  );
}

/** Signal-style receipt marks. The state is communicated by shape as well as
 * colour: one ring is accepted, two rings are delivered, and two solid rings
 * are read. That keeps the three states distinct in monochrome/high contrast. */
function SignalReceiptMark({
  state,
  label,
  className,
}: {
  state: "sent" | "delivered" | "read";
  label: string;
  className?: string;
}) {
  const read = state === "read";
  const centers = state === "sent" ? [10] : [7.1, 12.9];
  return (
    <svg
      viewBox="0 0 20 14"
      fill="none"
      className={cn("shrink-0", className)}
      role="img"
      aria-label={label}
    >
      {centers.map((cx) => (
        <g key={cx}>
          <circle
            cx={cx}
            cy="7"
            r="5.15"
            fill={read ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.45"
          />
          <path
            d={`M ${cx - 2.35} 7.05 l 1.55 1.55 l 3.15 -3.25`}
            stroke={read ? "var(--background)" : "currentColor"}
            strokeWidth="1.45"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      ))}
    </svg>
  );
}
