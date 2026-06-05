"use client";

import * as React from "react";
import { CircleNotch, Sparkle } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import type { Room, Silicon, Team } from "@/lib/types";
import { cn } from "@/lib/utils";

import { IdAvatar } from "@/components/profile/id-avatar";

interface TeamSiliconGroup {
  team: Team;
  silicons: Silicon[];
}

export function TeamSiliconRoster({
  teams,
  onOpenRoom,
}: {
  teams: Team[];
  onOpenRoom: (room: Room) => void;
}) {
  const [groups, setGroups] = React.useState<TeamSiliconGroup[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [opening, setOpening] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;

    (async () => {
      if (teams.length === 0) {
        if (alive) {
          setGroups([]);
          setLoading(false);
        }
        return;
      }
      if (alive) setLoading(true);
      const next = await Promise.all(
        teams.map(async (team) => {
          try {
            const silicons = await api.teamSilicons(team.slug);
            return { team, silicons };
          } catch (e) {
            const msg = e instanceof ApiError ? e.message : String(e);
            toast.error(`${team.name}: ${msg}`);
            return { team, silicons: [] };
          }
        }),
      );
      if (!alive) return;
      setGroups(next);
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [teams]);

  if (teams.length === 0) return null;

  const openSilicon = async (silicon: Silicon) => {
    if (!silicon.is_active) return;
    setOpening(silicon.silicon_id);
    try {
      onOpenRoom(await api.directRoom("silicon", silicon.silicon_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="border-b bg-background">
      <div className="flex items-center justify-between px-6 pb-1.5 pt-3">
        <span className="label-mono">team silicons</span>
        {loading ? <CircleNotch className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </div>
      <div className="max-h-64 overflow-y-auto pb-2">
        {groups.map((group) => (
          <div key={group.team.slug} className="py-1">
            <div className="px-6 pb-1 text-[11px] font-medium text-muted-foreground">
              {group.team.name}
            </div>
            {group.silicons.length === 0 ? (
              <div className="px-6 py-2 text-xs text-muted-foreground">No silicons yet.</div>
            ) : (
              <ul>
                {group.silicons.map((silicon) => {
                  const busy = opening === silicon.silicon_id;
                  return (
                    <li key={silicon.silicon_id}>
                      <button
                        type="button"
                        disabled={!silicon.is_active || busy}
                        onClick={() => void openSilicon(silicon)}
                        className={cn(
                          "flex w-full items-center gap-3 px-6 py-2 text-left transition-colors",
                          silicon.is_active
                            ? "hover:bg-secondary/60"
                            : "cursor-not-allowed opacity-50",
                        )}
                      >
                        <IdAvatar
                          seed={silicon.silicon_id}
                          src={silicon.profile_photo_url}
                          size={30}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{silicon.name}</span>
                          {silicon.tagline ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {silicon.tagline}
                            </span>
                          ) : null}
                        </span>
                        {busy ? (
                          <CircleNotch className="h-4 w-4 shrink-0 animate-spin" />
                        ) : (
                          <Sparkle className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
