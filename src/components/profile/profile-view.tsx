"use client";

import { useNow } from "@/lib/use-clock";
import { formatTimeInZone, formatZoneOffset, tzCountry } from "@/lib/timezones";
import type { CarbonPublic, SiliconPublic } from "@/lib/types";

import { IdAvatar } from "./id-avatar";

/** Shared profile header used by the mini-profile popover and the chat drawer. */
export function ProfileView({
  profile,
  kind,
}: {
  profile: CarbonPublic | SiliconPublic;
  kind: "carbon" | "silicon";
}) {
  const now = useNow();
  const isCarbon = kind === "carbon";
  const publicId = isCarbon
    ? (profile as CarbonPublic).carbon_id
    : (profile as SiliconPublic).silicon_id;
  const displayName =
    profile.name ||
    (isCarbon ? `@${(profile as CarbonPublic).username}` : publicId);
  const tz = isCarbon ? (profile as CarbonPublic).timezone : "";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <IdAvatar seed={publicId} src={profile.profile_photo_url} size={56} />
        <div className="min-w-0">
          <div className="truncate text-base font-semibold">{displayName}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{publicId}</div>
        </div>
      </div>
      {profile.tagline ? (
        <p className="text-sm text-muted-foreground">{profile.tagline}</p>
      ) : null}
      {isCarbon && tz ? (
        <p className="label-mono">
          {tz}
          {tzCountry(tz).name ? ` · ${tzCountry(tz).name}` : ""}
          {" · "}
          {formatZoneOffset(tz, now)} · {formatTimeInZone(tz, now)}
        </p>
      ) : null}
    </div>
  );
}
