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

  // QA medium: the list of ~400 zones was rebuilt and re-sorted on every
  // one-second clock tick even while the popover was closed. Pin the value the
  // sort uses to a single timestamp captured when the popover opens, so the
  // expensive listZones() only re-runs on open (not every second). The trigger
  // label below still uses live `now`, so the closed chip stays a live clock.
  const [openedAt, setOpenedAt] = React.useState<Date>(() => new Date());

  const zones = React.useMemo(() => listZones(openedAt), [openedAt]);

  const filtered = React.useMemo(
    () => zones.filter((z) => matchesZone(z, q)),
    [zones, q],
  );

  // QA a11y: keyboard arrow navigation + aria-activedescendant. `active` is the
  // index into `filtered` that's visually highlighted and announced. Reset it
  // whenever the query changes or the popover opens so it never points past the
  // end of the (re-filtered) list.
  const [active, setActive] = React.useState(0);

  const listId = React.useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const listRef = React.useRef<HTMLUListElement>(null);

  // Keep the active row scrolled into view as the user arrows through.
  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(optionId(active))}`,
    );
    el?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId is stable per render
  }, [active, open]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(filtered.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const z = filtered[active];
      if (z) {
        onChange(z.iana);
        setOpen(false);
        setQ("");
      }
    }
  };

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
        setActive(0);
        if (o) setOpenedAt(new Date());
        else setQ("");
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
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="search by city, country, or GMT offset"
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            // QA a11y: the input drives the listbox below (combobox pattern).
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              filtered.length > 0 ? optionId(active) : undefined
            }
          />
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="timezones"
          className="max-h-72 overflow-auto py-1"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              no matches
            </li>
          )}
          {filtered.map((z, i) => (
            <ZoneRow
              key={z.iana}
              id={optionId(i)}
              zone={z}
              now={now}
              selected={z.iana === value}
              active={i === active}
              onHover={() => setActive(i)}
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
  id,
  zone,
  now,
  selected,
  active,
  onHover,
  onPick,
}: {
  id: string;
  zone: ZoneInfo;
  now: Date;
  selected: boolean;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    // QA a11y: each row is an option; aria-selected conveys the chosen zone to
    // screen readers (previously selection was a background color only). The
    // keyboard-active row is highlighted via `active` to match aria-activedescendant.
    <li id={id} role="option" aria-selected={selected}>
      <button
        type="button"
        tabIndex={-1}
        onClick={onPick}
        onMouseMove={onHover}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
          active && "bg-accent",
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
