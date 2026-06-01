"use client";

import * as React from "react";
import { Camera, CircleNotch } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import type { Contact, RoomPeer } from "@/lib/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IdAvatar } from "@/components/profile/id-avatar";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  peer: RoomPeer;
  /** When set, the dialog edits an existing contact instead of creating one. */
  existing?: Contact;
  onSaved: () => void;
}

export function SaveContactDialog({ open, onOpenChange, peer, existing, onSaved }: Props) {
  const [name, setName] = React.useState("");
  const [note, setNote] = React.useState("");
  // photoKey: the owner's custom photo key ("" = use the target's default).
  const [photoKey, setPhotoKey] = React.useState("");
  const [photoUrl, setPhotoUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Seed the form whenever it opens.
  React.useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? peer.name ?? peer.id);
    setNote(existing?.note ?? "");
    setPhotoKey("");
    setPhotoUrl(existing?.photo_url ?? peer.profile_photo_url ?? null);
  }, [open, existing, peer]);

  const customPhoto = photoKey !== "" || (existing?.custom_photo ?? false);

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      const r = await api.presignUpload({
        mime: file.type || "image/png",
        size: file.size,
        kind: "profile_icon",
        filename: file.name,
      });
      if (!r.upload.dev_mode) {
        const form = new FormData();
        for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
        form.append("file", file);
        const up = await fetch(r.upload.url, { method: r.upload.method || "POST", body: form });
        if (!up.ok) throw new Error(`upload failed (${up.status})`);
        await api.mediaComplete(r.media.media_id);
      }
      const key = (r.upload.fields as Record<string, string>).key || r.media.media_id;
      setPhotoKey(key);
      setPhotoUrl(URL.createObjectURL(file));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        note: note.trim(),
        ...(photoKey ? { photo_key: photoKey } : {}),
      };
      if (existing) await api.updateContact(existing.id, payload);
      else await api.saveContact({ target_kind: peer.kind, target_id: peer.id, ...payload });
      toast.success(existing ? "contact updated" : "contact saved");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit contact" : "Save contact"}</DialogTitle>
          <DialogDescription>
            Saved to your private contacts — the name, picture, and note are only
            visible to you.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Photo (defaults to the user's; click to set your own) */}
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="group relative"
              aria-label="set contact picture"
            >
              <IdAvatar seed={peer.id} src={photoUrl} size={72} />
              <span className="absolute inset-0 flex items-center justify-center bg-foreground/0 opacity-0 transition-opacity group-hover:bg-foreground/30 group-hover:opacity-100">
                <Camera className="h-5 w-5 text-background" />
              </span>
            </button>
            {customPhoto && (
              <span className="label-mono text-[10px] text-muted-foreground">
                Picture set by you
              </span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="label-mono text-[10px] text-muted-foreground">
              {peer.kind === "carbon" ? "Carbon ID" : "Silicon ID"}
            </Label>
            <div className="truncate border border-input bg-muted/40 px-3 py-2 text-sm">
              @{peer.id}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="contact-name">Name</Label>
            <Input
              id="contact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={peer.name || peer.id}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="contact-note">Note (only visible to you)</Label>
            <Textarea
              id="contact-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="a mini note about them…"
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy && <CircleNotch className="animate-spin" />}
              {existing ? "save" : "save contact"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
