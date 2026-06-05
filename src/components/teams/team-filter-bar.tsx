"use client";

import * as React from "react";
import { Sparkle, Tray, UsersThree } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

export interface ChatFilters {
  unread: boolean;
  kinds: ("carbon" | "silicon")[];
}

export const EMPTY_FILTERS: ChatFilters = { unread: false, kinds: [] };

interface Props {
  filters: ChatFilters;
  onChange: (f: ChatFilters) => void;
}

/** WhatsApp-style filter row for unread + counterpart kind. */
export function TeamFilterBar({ filters, onChange }: Props) {
  const toggleKind = (k: "carbon" | "silicon") =>
    onChange({
      ...filters,
      kinds: filters.kinds.includes(k)
        ? filters.kinds.filter((x) => x !== k)
        : [...filters.kinds, k],
    });

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b py-2 pl-6 pr-3">
      <Chip active={filters.unread} onClick={() => onChange({ ...filters, unread: !filters.unread })}>
        <Tray className="h-3.5 w-3.5" /> Unread
      </Chip>
      <Chip active={filters.kinds.includes("carbon")} onClick={() => toggleKind("carbon")}>
        <UsersThree className="h-3.5 w-3.5" /> Carbons
      </Chip>
      <Chip active={filters.kinds.includes("silicon")} onClick={() => toggleKind("silicon")}>
        <Sparkle className="h-3.5 w-3.5" /> Silicons
      </Chip>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-card hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}
