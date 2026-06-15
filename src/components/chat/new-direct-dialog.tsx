"use client";

import * as React from "react";
import { CircleNotch } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTeams } from "@/lib/use-teams";
import type { Room, TeamMembership } from "@/lib/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IdAvatar } from "@/components/profile/id-avatar";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (room: Room) => void;
}

interface Person {
  kind: "carbon" | "silicon";
  handle: string;
  photoUrl: string | null;
}

// Flatten the members of every team I'm in into a single de-duplicated people
// list. A person can appear in more than one team; key by kind+handle so they
// show once.
function peopleFromMembers(rows: TeamMembership[], me: string | null): Person[] {
  const seen = new Map<string, Person>();
  for (const m of rows) {
    if (m.member_kind !== "carbon" && m.member_kind !== "silicon") continue;
    if (!m.member_handle) continue;
    if (me && m.member_handle === me) continue;
    const key = `${m.member_kind}:${m.member_handle}`;
    if (!seen.has(key)) {
      seen.set(key, {
        kind: m.member_kind,
        handle: m.member_handle,
        photoUrl: m.member_photo_url,
      });
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "carbon" ? -1 : 1;
    return a.handle.localeCompare(b.handle);
  });
}

export function NewDirectDialog({ open, onOpenChange, onCreated }: Props) {
  const { teams } = useTeams();
  const { carbon } = useAuth();
  const myUsername = carbon?.username ?? null;

  const [people, setPeople] = React.useState<Person[]>([]);
  const [loadingPeople, setLoadingPeople] = React.useState(false);
  const [query, setQuery] = React.useState("");
  // Manual fallback for reaching someone not in any of my teams (by username,
  // email, or phone for a carbon; by name for a silicon).
  const [manualKind, setManualKind] = React.useState<"carbon" | "silicon">("carbon");
  const [opening, setOpening] = React.useState<string | null>(null);

  // Load every team's members once the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadingPeople(true);
    Promise.all(teams.map((t) => api.teamMembers(t.slug).catch(() => [] as TeamMembership[])))
      .then((lists) => {
        if (!alive) return;
        setPeople(peopleFromMembers(lists.flat(), myUsername));
      })
      .finally(() => {
        if (alive) setLoadingPeople(false);
      });
    return () => {
      alive = false;
    };
  }, [open, teams, myUsername]);

  // Reset transient state on close.
  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setOpening(null);
    }
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q ? people.filter((p) => p.handle.toLowerCase().includes(q)) : people;

  const openWith = async (kind: "carbon" | "silicon", handle: string, busyKey: string) => {
    const trimmed = handle.trim();
    if (!trimmed) return;
    setOpening(busyKey);
    try {
      const target =
        kind === "carbon"
          ? await api.carbonByHandle(trimmed)
          : await api.siliconByHandle(trimmed);
      const id = "carbon_id" in target ? target.carbon_id : target.silicon_id;
      const room = await api.directRoom(kind, id);
      onCreated(room);
      onOpenChange(false);
      toast.success(`opened room with @${trimmed}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>new conversation</DialogTitle>
          <DialogDescription>
            Pick someone from your teams, or reach a person by username, email, or phone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            autoFocus
            placeholder="search people…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="max-h-72 overflow-y-auto border">
            {loadingPeople ? (
              <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                <CircleNotch className="animate-spin" /> loading people…
              </div>
            ) : filtered.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {people.length === 0 ? "No team members found." : "No match."}
              </p>
            ) : (
              <ul className="divide-y">
                {filtered.map((p) => {
                  const busyKey = `${p.kind}:${p.handle}`;
                  return (
                    <li key={busyKey}>
                      <button
                        type="button"
                        disabled={opening !== null}
                        onClick={() => openWith(p.kind, p.handle, busyKey)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        <IdAvatar
                          seed={`${p.kind}:${p.handle}`}
                          src={p.photoUrl}
                          size={32}
                          family={p.kind === "silicon" ? "silicon" : "carbon"}
                        />
                        <span className="min-w-0 flex-1 truncate">@{p.handle}</span>
                        <span className="label-mono shrink-0 text-[10px] text-muted-foreground">
                          {p.kind}
                        </span>
                        {opening === busyKey && <CircleNotch className="animate-spin shrink-0" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Manual fallback — reach someone who isn't in any of my teams. */}
          {q && filtered.length === 0 && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                Reach “{query.trim()}” directly:
              </p>
              <div className="flex gap-2">
                <div className="flex gap-1">
                  <Button
                    variant={manualKind === "carbon" ? "default" : "outline"}
                    size="sm"
                    type="button"
                    onClick={() => setManualKind("carbon")}
                  >
                    carbon
                  </Button>
                  <Button
                    variant={manualKind === "silicon" ? "default" : "outline"}
                    size="sm"
                    type="button"
                    onClick={() => setManualKind("silicon")}
                  >
                    silicon
                  </Button>
                </div>
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={opening !== null}
                  onClick={() => openWith(manualKind, query, "manual")}
                >
                  {opening === "manual" && <CircleNotch className="animate-spin" />}
                  open
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
