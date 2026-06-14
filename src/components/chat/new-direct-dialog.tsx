"use client";

import * as React from "react";
import { CircleNotch } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import type { Room } from "@/lib/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (room: Room) => void;
}

export function NewDirectDialog({ open, onOpenChange, onCreated }: Props) {
  const [kind, setKind] = React.useState<"carbon" | "silicon">("carbon");
  const [handle, setHandle] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const closeRef = React.useRef<HTMLButtonElement>(null);

  // QA medium: a whitespace-only handle was treated as valid and sent to the
  // API. Validate against the trimmed value everywhere.
  const trimmedHandle = handle.trim();

  const start = async () => {
    if (!trimmedHandle) return;
    setLoading(true);
    try {
      const target =
        kind === "carbon"
          ? await api.carbonByHandle(trimmedHandle)
          : await api.siliconByHandle(trimmedHandle);
      const id = "carbon_id" in target ? target.carbon_id : target.silicon_id;
      const room = await api.directRoom(kind, id);
      onCreated(room);
      onOpenChange(false);
      setHandle("");
      toast.success(`opened room with @${trimmedHandle}`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>new direct conversation</DialogTitle>
          <DialogDescription>
            Start a direct conversation - reach a person by their username, email, or
            phone, or a silicon by its name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant={kind === "carbon" ? "default" : "outline"}
              onClick={() => setKind("carbon")}
              type="button"
            >
              carbon
            </Button>
            <Button
              variant={kind === "silicon" ? "default" : "outline"}
              onClick={() => setKind("silicon")}
              type="button"
            >
              silicon
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="handle">handle</Label>
            <Input
              id="handle"
              autoFocus
              placeholder={kind === "carbon" ? "alice / +14155551212 / alice@..." : "Ada"}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && trimmedHandle && !loading) start();
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose ref={closeRef} asChild>
              <Button variant="ghost" type="button">
                cancel
              </Button>
            </DialogClose>
            <Button onClick={start} disabled={!trimmedHandle || loading}>
              {loading && <CircleNotch className="animate-spin" />}
              open
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
