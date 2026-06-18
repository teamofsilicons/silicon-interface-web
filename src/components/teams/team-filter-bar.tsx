"use client";

import * as React from "react";
import { GearSix, Sparkle, Tray, UsersThree } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";
import { IdAvatar } from "@/components/profile/id-avatar";

// Sentinel "team" values usable inside ChatFilters.teams alongside real slugs.
export const OTHERS_TAB = "__others__";
export const OBSERVING_TAB = "__observing__";

export interface ChatFilters {
  unread: boolean;
  kinds: ("carbon" | "silicon")[];
  /** Selected team slugs (+ OTHERS_TAB / OBSERVING_TAB). Empty = show all. */
  teams: string[];
}

export const EMPTY_FILTERS: ChatFilters = { unread: false, kinds: [], teams: [] };

export interface TeamChip {
  slug: string;
  name: string;
  logo_url?: string | null;
}

interface Props {
  filters: ChatFilters;
  onChange: (f: ChatFilters) => void;
  teams: TeamChip[];
  hasOthers: boolean;
  hasObserving: boolean;
  /** Unread counts for the chip badges. */
  unread?: { teams: Record<string, number>; others: number; observing: number };
  /** Opens the team workspace when exactly one team is selected. */
  onOpenTeamSettings?: () => void;
}

/**
 * WhatsApp-style filter row: unread + counterpart kind, plus the user's teams
 * as multi-select chips (none selected = every chat shows; selecting teams
 * narrows to those). Teams are a filter here, not separate sections.
 */
export function TeamFilterBar({
  filters,
  onChange,
  teams,
  hasOthers,
  hasObserving,
  unread,
  onOpenTeamSettings,
}: Props) {
  const toggleKind = (k: "carbon" | "silicon") =>
    onChange({
      ...filters,
      kinds: filters.kinds.includes(k)
        ? filters.kinds.filter((x) => x !== k)
        : [...filters.kinds, k],
    });

  const toggleTeam = (slug: string) =>
    onChange({
      ...filters,
      teams: filters.teams.includes(slug)
        ? filters.teams.filter((x) => x !== slug)
        : [...filters.teams, slug],
    });

  const showTeamRow = teams.length > 0 || hasOthers || hasObserving;

  return (
    <div className="flex flex-col border-b">
      {/* Kind filters. */}
      <div className="flex items-center gap-1.5 overflow-x-auto py-2 pl-6 pr-3">
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

      {/* Teams slider — multi-select; none selected = every team shows. */}
      {showTeamRow && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-t py-2 pl-6 pr-3">
          {teams.map((team) => (
            <Chip
              key={team.slug}
              active={filters.teams.includes(team.slug)}
              onClick={() => toggleTeam(team.slug)}
            >
              <IdAvatar
                seed={`team:${team.slug}`}
                src={team.logo_url}
                size={16}
                family="team"
                className="-ml-0.5 border-0 bg-transparent"
              />
              {team.name}
              <CountBadge n={unread?.teams[team.slug] ?? 0} active={filters.teams.includes(team.slug)} />
            </Chip>
          ))}
          {hasOthers && (
            <Chip active={filters.teams.includes(OTHERS_TAB)} onClick={() => toggleTeam(OTHERS_TAB)}>
              Others
              <CountBadge n={unread?.others ?? 0} active={filters.teams.includes(OTHERS_TAB)} />
            </Chip>
          )}
          {hasObserving && (
            <Chip active={filters.teams.includes(OBSERVING_TAB)} onClick={() => toggleTeam(OBSERVING_TAB)}>
              Observing
              <CountBadge n={unread?.observing ?? 0} active={filters.teams.includes(OBSERVING_TAB)} />
            </Chip>
          )}
          {onOpenTeamSettings && (
            <button
              type="button"
              onClick={onOpenTeamSettings}
              aria-label="team workspace"
              title="team workspace"
              className="ml-auto grid h-7 w-7 shrink-0 place-items-center border border-border text-foreground transition-colors hover:bg-accent"
            >
              <GearSix className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
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

function CountBadge({ n, active }: { n: number; active: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none",
        active ? "bg-primary-foreground text-primary" : "bg-primary text-primary-foreground",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}
