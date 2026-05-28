"use client";

import * as React from "react";
import { CircleNotch, ShareNetwork, UploadSimple } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { guessTimezone } from "@/lib/timezones";
import type { Carbon } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IdAvatar } from "./id-avatar";
import { ShareDialog } from "./share-dialog";
import { TimezoneSelect } from "./timezone-select";

export function ProfileEditor() {
  const [me, setMe] = React.useState<Carbon | null>(() => authStore.getCarbon());
  const [name, setName] = React.useState(me?.name ?? "");
  const [tagline, setTagline] = React.useState(me?.tagline ?? "");
  const [tz, setTz] = React.useState(me?.timezone || guessTimezone());
  const [busy, setBusy] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Save button stays disabled until something actually changed vs the loaded
  // server values. Falls back to the guessed timezone when the server has none.
  const baselineTz = me?.timezone || guessTimezone();
  const dirty = Boolean(
    me &&
      (name !== (me.name ?? "") ||
        tagline !== (me.tagline ?? "") ||
        tz !== baselineTz),
  );

  // Refresh from the server (gets profile_photo_url + latest fields).
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await api.me();
        if (!alive) return;
        setMe(c);
        setName(c.name);
        setTagline(c.tagline);
        setTz(c.timezone || guessTimezone());
        authStore.setCarbon(c);
      } catch {
        /* keep cached */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!me) return null; // not signed in as a Carbon

  const save = async () => {
    setBusy(true);
    try {
      const c = await api.patchMe({ name, tagline, timezone: tz });
      setMe(c);
      authStore.setCarbon(c);
      toast.success("profile saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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
      const c = await api.patchMe({ profile_photo_key: key });
      setMe(c);
      authStore.setCarbon(c);
      toast.success("photo updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">profile</CardTitle>
        <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
          <ShareNetwork /> share
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <IdAvatar seed={me.carbon_id} src={me.profile_photo_url} size={64} />
          <div>
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
            <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              <UploadSimple /> change photo
            </Button>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              @{me.username} · {me.carbon_id}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <Label htmlFor="pname">name</Label>
          <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-3">
          <Label htmlFor="ptag">tagline</Label>
          <Input
            id="ptag"
            maxLength={160}
            placeholder="a line about you"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
          />
        </div>
        <div className="space-y-3">
          <Label htmlFor="ptz">timezone</Label>
          <TimezoneSelect value={tz} onChange={setTz} />
        </div>

        <Button onClick={save} disabled={busy || !dirty}>
          {busy && <CircleNotch className="animate-spin" />} save profile
        </Button>
      </CardContent>
      <ShareDialog
        carbonId={me.carbon_id}
        name={me.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </Card>
  );
}
