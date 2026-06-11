"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { roomDisplay } from "@/lib/peers";
import type { Room } from "@/lib/types";
import { cn } from "@/lib/utils";
import { IdAvatar } from "@/components/profile/id-avatar";

// Delights §7b — a Cmd+K fuzzy jump menu: rooms, people, and dev, mono-styled.
// The single most loved power feature in any chat app, made terminal-flavored.

interface Entry {
  id: string;
  label: string;
  hint: string;
  seed: string;
  photoUrl: string | null;
  asciiUrl: string | null;
  family: "carbon" | "silicon" | "team";
  go: () => void;
}

/** Subsequence fuzzy match — every char of `q` appears in order in `text`. */
function fuzzy(q: string, text: string): boolean {
  if (!q) return true;
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = t.indexOf(ch, i);
    if (i < 0) return false;
    i += 1;
  }
  return true;
}

export function CommandMenu({ rooms, isStaff }: { rooms: Room[]; isStaff?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);

  // Cmd/Ctrl+K toggles the menu from anywhere.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
    }
  }, [open]);

  const entries = React.useMemo<Entry[]>(() => {
    const list: Entry[] = rooms.map((r) => {
      const d = roomDisplay(r);
      return {
        id: r.room_id,
        label: d.name,
        hint: d.peer ? `@${d.handle}` : "group",
        seed: d.peer?.id ?? d.handle,
        photoUrl: d.photoUrl,
        asciiUrl: d.asciiUrl,
        family: d.peer?.kind ?? "carbon",
        go: () => router.push(`/chat?room=${encodeURIComponent(r.room_id)}`),
      };
    });
    return list;
  }, [rooms, router]);

  const filtered = React.useMemo(
    () => entries.filter((e) => fuzzy(q, `${e.label} ${e.hint}`)).slice(0, 50),
    [entries, q],
  );

  const select = (e?: Entry) => {
    const target = e ?? filtered[active];
    if (!target) return;
    setOpen(false);
    target.go();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg border bg-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="jump to"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <span className="font-mono text-xs text-muted-foreground">{">"}</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                select();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
            placeholder="jump to a room or person…"
            className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="label-mono shrink-0 border px-1.5 py-0.5 text-[10px]">esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center font-mono text-xs text-muted-foreground">
              no matches for &quot;{q}&quot;
            </li>
          ) : (
            filtered.map((e, i) => (
              <li key={e.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => select(e)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
                    i === active ? "bg-secondary" : "hover:bg-accent",
                  )}
                >
                  <IdAvatar seed={e.seed} src={e.photoUrl} asciiSrc={e.asciiUrl} size={28} family={e.family} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{e.label}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {e.hint}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
