"use client";

import * as React from "react";
import { GearSix, Sparkle, Tray, UsersThree } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";
import { IdAvatar } from "@/components/profile/id-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

/** Kind filter row (Unread / Carbons / Silicons). Renders below the search. */
export function TeamFilterBar({
  filters,
  onChange,
}: {
  filters: ChatFilters;
  onChange: (f: ChatFilters) => void;
}) {
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

/**
 * The teams band — the original team switcher styling, but acting as a
 * horizontally-scrollable MULTI-SELECT filter (+ Others / Observing). None
 * selected = every team shows. The gear opens a team's workspace; when no
 * single team is selected it asks which team. Rendered above the search field.
 */
export function TeamSlider({
  filters,
  onChange,
  teams,
  hasOthers,
  hasObserving,
  unread,
  onOpenTeamSettings,
}: {
  filters: ChatFilters;
  onChange: (f: ChatFilters) => void;
  teams: TeamChip[];
  hasOthers: boolean;
  hasObserving: boolean;
  unread?: { teams: Record<string, number>; others: number; observing: number };
  onOpenTeamSettings?: (slug: string) => void;
}) {
  if (!(teams.length > 0 || hasOthers || hasObserving)) return null;

  const toggleTeam = (slug: string) =>
    onChange({
      ...filters,
      teams: filters.teams.includes(slug)
        ? filters.teams.filter((x) => x !== slug)
        : [...filters.teams, slug],
    });

  const selectedTeams = teams.filter((t) => filters.teams.includes(t.slug));
  const singleSelected = selectedTeams.length === 1 ? selectedTeams[0] : null;

  return (
    <div className="flex items-stretch border-b">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-2 pl-6 pr-3">
        {teams.map((team) => {
          const active = filters.teams.includes(team.slug);
          return (
            <button
              key={team.slug}
              type="button"
              onClick={() => toggleTeam(team.slug)}
              className={cn(
                "inline-flex max-w-48 shrink-0 items-center gap-2 overflow-hidden border p-0 pr-3 text-xs font-semibold leading-none transition-colors",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <IdAvatar
                seed={`team:${team.slug}`}
                src={team.logo_url}
                size={28}
                family="team"
                className={cn("m-0.5 border-0", active ? "bg-background" : "bg-muted")}
              />
              <span className="min-w-0 truncate">{team.name}</span>
              <BandBadge n={unread?.teams[team.slug] ?? 0} active={active} />
            </button>
          );
        })}
        {hasOthers && (
          <BandPill active={filters.teams.includes(OTHERS_TAB)} onClick={() => toggleTeam(OTHERS_TAB)}>
            Others
            <BandBadge n={unread?.others ?? 0} active={filters.teams.includes(OTHERS_TAB)} />
          </BandPill>
        )}
        {hasObserving && (
          <BandPill active={filters.teams.includes(OBSERVING_TAB)} onClick={() => toggleTeam(OBSERVING_TAB)}>
            Observing
            <BandBadge n={unread?.observing ?? 0} active={filters.teams.includes(OBSERVING_TAB)} />
          </BandPill>
        )}
      </div>

      {onOpenTeamSettings && teams.length > 0 ? (
        singleSelected ? (
          <button
            type="button"
            aria-label={`${singleSelected.name} team workspace`}
            title={`${singleSelected.name} team workspace`}
            onClick={() => onOpenTeamSettings(singleSelected.slug)}
            className="m-2 grid h-8 w-8 shrink-0 self-center place-items-center border border-border text-foreground transition-colors hover:bg-accent"
          >
            <GearSix className="h-4 w-4" />
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="team workspace"
                title="team workspace"
                className="m-2 grid h-8 w-8 shrink-0 self-center place-items-center border border-border text-foreground transition-colors hover:bg-accent"
              >
                <GearSix className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Which team&rsquo;s settings?</DropdownMenuLabel>
              {teams.map((t) => (
                <DropdownMenuItem key={t.slug} onSelect={() => onOpenTeamSettings(t.slug)}>
                  <IdAvatar
                    seed={`team:${t.slug}`}
                    src={t.logo_url}
                    size={18}
                    family="team"
                    className="mr-2 border-0 bg-muted"
                  />
                  {t.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      ) : null}
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

function BandPill({
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
        "inline-flex shrink-0 items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function BandBadge({ n, active }: { n: number; active: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none",
        active ? "bg-background text-foreground" : "bg-primary text-primary-foreground",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}
