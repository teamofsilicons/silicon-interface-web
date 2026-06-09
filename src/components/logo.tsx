import Image from "next/image";

import { cn } from "@/lib/utils";

interface LogoProps {
  /** Edge length of the square mark, in px. */
  size?: number;
  /** Render the "Silicon Interface" wordmark beside the mark. */
  withWordmark?: boolean;
  className?: string;
}

/**
 * The Silicon Interface logo. Centralizes the brand mark so it can be swapped
 * in one place everywhere it's used (landing, navbar, auth). The asset lives at
 * `public/logo.png` — replace that file to rebrand.
 */
export function Logo({ size = 28, withWordmark = false, className }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Image
        src="/logo.png"
        alt=""
        aria-hidden
        width={size}
        height={size}
        className="shrink-0 select-none"
        draggable={false}
        priority
      />
      {withWordmark && (
        <span className="font-mono text-sm font-semibold tracking-tight">Silicon Interface</span>
      )}
      <span className="sr-only">Silicon Interface</span>
    </span>
  );
}
