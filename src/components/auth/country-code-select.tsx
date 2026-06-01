"use client";

import * as React from "react";
import { CaretDown, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";

import { COUNTRY_CODES, findCountry, iso2ToFlag, type Country } from "@/lib/country-codes";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Props {
  /** Selected country, by ISO-3166-1 alpha-2 code. */
  value: string;
  onChange: (country: Country) => void;
  disabled?: boolean;
}

/** Searchable country dial-code picker. Filter by country name, ISO code, or +dial. */
export function CountryCodeSelect({ value, onChange, disabled }: Props) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  // Keyboard-highlighted row (arrow keys move it, Enter selects).
  const [active, setActive] = React.useState(0);
  React.useEffect(() => setActive(0), [q]);

  const selected = findCountry(value) ?? COUNTRY_CODES.find((c) => c.iso2 === "US")!;

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return COUNTRY_CODES;
    const digits = s.replace(/\D/g, "");
    return COUNTRY_CODES.filter(
      (c) =>
        c.name.toLowerCase().includes(s) ||
        c.iso2.toLowerCase().includes(s) ||
        (digits && c.dial.includes(digits)),
    );
  }, [q]);

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
        disabled={disabled}
        aria-label={`Country code: ${selected.name} +${selected.dial}`}
        className="flex h-11 shrink-0 items-center gap-1.5 border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:border-ring disabled:opacity-50"
      >
        <span className="text-base leading-none">{iso2ToFlag(selected.iso2)}</span>
        <span className="tabular-nums">+{selected.dial}</span>
        <CaretDown className="h-3 w-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <MagnifyingGlass className="h-4 w-4 shrink-0 opacity-50" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const c = filtered[active];
                if (c) {
                  onChange(c);
                  setOpen(false);
                  setQ("");
                }
              }
            }}
            placeholder="search country or code"
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul className="max-h-64 overflow-auto py-1">
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">no matches</li>
          )}
          {filtered.map((c, idx) => (
            <li key={c.iso2}>
              <button
                type="button"
                ref={
                  idx === active
                    ? (el) => el?.scrollIntoView({ block: "nearest" })
                    : undefined
                }
                onMouseEnter={() => setActive(idx)}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                  setQ("");
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                  idx === active
                    ? "bg-accent"
                    : c.iso2 === selected.iso2
                      ? "bg-secondary"
                      : "hover:bg-accent",
                )}
              >
                <span className="text-base leading-none">{iso2ToFlag(c.iso2)}</span>
                <span className="flex-1 truncate">{c.name}</span>
                <span className="tabular-nums text-muted-foreground">+{c.dial}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
