"use client";

import * as React from "react";

import type { ChatFilters } from "@/components/teams/team-filter-bar";

interface LordsSidebarBridge {
  addon: React.ReactNode;
  initialFilters: ChatFilters;
  onFiltersChange: (filters: ChatFilters) => void;
}

const LordsSidebarAddonContext = React.createContext<LordsSidebarBridge | null>(null);

export function LordsSidebarAddonProvider({
  addon,
  initialFilters,
  onFiltersChange,
  children,
}: {
  addon: React.ReactNode;
  initialFilters: ChatFilters;
  onFiltersChange: (filters: ChatFilters) => void;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({
    addon,
    initialFilters,
    onFiltersChange,
  }), [addon, initialFilters, onFiltersChange]);

  return (
    <LordsSidebarAddonContext.Provider value={value}>
      {children}
    </LordsSidebarAddonContext.Provider>
  );
}

export function useLordsSidebarBridge(): LordsSidebarBridge | null {
  return React.useContext(LordsSidebarAddonContext);
}
