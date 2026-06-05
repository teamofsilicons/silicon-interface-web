"use client";

import * as React from "react";

import { api } from "./api";
import { authStore } from "./auth";
import { loadCachedTeams, saveCachedTeams } from "./sidebar-cache";
import type { Team } from "./types";

/** Loads the teams the current principal belongs to. */
export function useTeams() {
  const [teams, setTeams] = React.useState<Team[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [ownerId, setOwnerId] = React.useState<string | null>(
    () => authStore.getCarbon()?.carbon_id ?? null,
  );

  React.useEffect(() => {
    return authStore.subscribe(() => {
      setOwnerId(authStore.getCarbon()?.carbon_id ?? null);
    });
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const next = await api.teams();
      setTeams(next);
      if (ownerId) saveCachedTeams(ownerId, next);
    } catch {
      /* leave prior teams */
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  React.useEffect(() => {
    let alive = true;
    const cached = ownerId ? loadCachedTeams(ownerId) : null;
    if (cached) {
      setTeams(cached);
      setLoading(false);
    } else {
      setTeams([]);
      setLoading(true);
    }
    (async () => {
      try {
        const next = await api.teams();
        if (!alive) return;
        setTeams(next);
        if (ownerId) saveCachedTeams(ownerId, next);
      } catch {
        /* leave prior teams */
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [ownerId]);

  return { teams, loading, refresh };
}

/** Is the signed-in Carbon a head of this team? */
export function isTeamHead(team: Team): boolean {
  const me = authStore.getCarbon();
  return Boolean(me && team.team_heads.includes(me.carbon_id));
}
