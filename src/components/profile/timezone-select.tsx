"use client";

import * as React from "react";
import { CaretDown, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";

import {
  formatTimeInZone,
  formatZoneOffset,
  listZones,
  matchesZone,
  tzCountry,
  type ZoneInfo,
} from "@/lib/timezones";
import { useNow } from "@/lib/use-clock";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Props {
  value: string;
  onChange: (tz: string) => void;
}

/**
 * Searchable timezone picker. Lists every supported zone sorted by current
 * UTC offset (earliest → latest), labeled with its country name and a GMT
 * offset like "GMT+5:30". Search accepts IANA names, country names, ISO
 * codes, or offset strings.
 */
export function TimezoneSelect({ value, onChange }: Props) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const now = useNow();

  // Recompute every now-tick so DST transitions reorder the list correctly.
  // The cost is trivial — ~400 zones, one Intl call each.
  const zones = React.useMemo(() => listZones(now), [now]);

  const filtered = React.useMemo(
    () => zones.filter((z) => matchesZone(z, q)),
    [zones, q],
  );

  // The currently selected zone may not appear in `zones` for any reason
  // (e.g. data from an older runtime) — derive its country and offset on the
  // fly for the trigger label so the chip stays accurate.
  const selectedCountry = tzCountry(value).name;
  const selectedOffset = formatZoneOffset(value, now);
  const selectedTime = formatTimeInZone(value, now);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger
        type="button"
        className="flex h-11 w-full items-center gap-2 border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:border-ring"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left">
          <span className="truncate">{value}</span>
          {selectedCountry && (
            <span className="truncate text-muted-foreground">· {selectedCountry}</span>
          )}
        </span>
        <span className="shrink-0 label-mono">
          {selectedOffset} · {selectedTime}
        </span>
        <CaretDown className="h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-80 p-0"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <MagnifyingGlass className="h-4 w-4 shrink-0 opacity-50" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search by city, country, or GMT offset"
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul className="max-h-72 overflow-auto py-1">
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              no matches
            </li>
          )}
          {filtered.map((z) => (
            <ZoneRow
              key={z.iana}
              zone={z}
              now={now}
              selected={z.iana === value}
              onPick={() => {
                onChange(z.iana);
                setOpen(false);
                setQ("");
              }}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ZoneRow({
  zone,
  now,
  selected,
  onPick,
}: {
  zone: ZoneInfo;
  now: Date;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
          selected && "bg-secondary",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{zone.iana}</span>
          {zone.country && (
            <span className="truncate text-xs text-muted-foreground">
              {zone.country}
            </span>
          )}
        </span>
        <span className="shrink-0 label-mono text-muted-foreground">
          {zone.offsetLabel} · {formatTimeInZone(zone.iana, now)}
        </span>
      </button>
    </li>
  );
}
