export interface TeamLogoIdentity {
  slug: string;
  name: string;
  logo_url: string | null;
}

export interface ResolvedTeamLogo extends TeamLogoIdentity {
  /** False means the cached banner may render, but its logo must stay neutral. */
  ready: boolean;
}

/**
 * Resolve cached banner identity against the authoritative live team list.
 * Cached billing rows are useful for instant copy, but their logo URL may be
 * absent, expired, or older than the team record currently shown elsewhere.
 */
export function resolveTeamLogo(
  cached: TeamLogoIdentity,
  liveTeams: readonly TeamLogoIdentity[],
  teamsLoading: boolean,
): ResolvedTeamLogo | null {
  const live = liveTeams.find((team) => team.slug === cached.slug);
  if (live) {
    return {
      slug: live.slug,
      name: live.name || cached.name,
      logo_url: live.logo_url,
      ready: true,
    };
  }
  if (teamsLoading) {
    return { ...cached, logo_url: null, ready: false };
  }
  // The user is no longer a head of this team (or the cached row is stale).
  // Do not render an old team identity after the live list has resolved.
  return null;
}
