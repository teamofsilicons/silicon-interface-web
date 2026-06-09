"use client";

import * as React from "react";
import { CircleNotch, ShareNetwork, UploadSimple } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { validateImageFile } from "@/lib/image-upload";
import { guessTimezone } from "@/lib/timezones";
import type { Carbon } from "@/lib/types";

// QA §7.3: the tagline is capped at 160 but the name had no bounds at all — a
// whitespace-only name renders blank everywhere and a 5000-char name breaks the
// share card and drawer. Trim-validate against these.
const NAME_MAX = 80;

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
  const [photoBusy, setPhotoBusy] = React.useState(false);
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

  // QA §7.3: validate the trimmed name. Empty/whitespace and over-length are
  // both blocked, with the error surfaced inline (not just on the toast).
  const trimmedName = name.trim();
  const nameError = !trimmedName
    ? "name can't be empty"
    : trimmedName.length > NAME_MAX
      ? `name must be ${NAME_MAX} characters or fewer`
      : null;

  // Track whether the user has started editing so the mount refetch below
  // can't clobber in-progress typing on a slow network (QA medium). Written in
  // an effect (not during render) so it stays a pure side-channel for the
  // one-shot mount fetch.
  const dirtyRef = React.useRef(false);
  React.useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Refresh from the server (gets profile_photo_url + latest fields).
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await api.me();
        if (!alive) return;
        setMe(c);
        // QA medium: only overwrite the form fields if the user hasn't started
        // editing — otherwise a slow `me()` resolving mid-keystroke wipes their
        // input. Always seed with `?? ""` so a null server value can't flip the
        // controlled input to uncontrolled (React warning).
        if (!dirtyRef.current) {
          setName(c.name ?? "");
          setTagline(c.tagline ?? "");
          setTz(c.timezone || guessTimezone());
        }
        authStore.setCarbon(c);
      } catch {
        /* keep cached */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // QA §7.4: warn before a full-page unload (closing the tab, hard reload)
  // while there are unsaved name/tagline/timezone edits. In-app navigation is
  // guarded separately on the header-logo click path; this covers the browser.
  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require a returnValue to trigger the native prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  if (!me) return null; // not signed in as a Carbon

  const save = async () => {
    // QA §7.3: never persist an empty/whitespace or over-length name.
    if (nameError) {
      toast.error(nameError);
      return;
    }
    setBusy(true);
    try {
      const c = await api.patchMe({ name: trimmedName, tagline, timezone: tz });
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
    // QA §7.5: validate size + real image MIME before presign; never relabel an
    // empty type as png.
    const v = validateImageFile(file);
    if (!v.ok) {
      toast.error(v.error ?? "unsupported image");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setBusy(true);
    setPhotoBusy(true);
    try {
      const r = await api.presignUpload({
        mime: file.type,
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
      setPhotoBusy(false);
      if (fileRef.current) fileRef.current.value = "";
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
          <div className="relative h-16 w-16 shrink-0">
            <div className={photoBusy ? "opacity-45" : ""}>
              <IdAvatar seed={me.carbon_id} src={me.profile_photo_url} asciiSrc={me.profile_ascii_url} size={64} />
            </div>
            {photoBusy ? (
              <div className="absolute inset-0 grid place-items-center border border-border bg-background/55">
                <CircleNotch className="h-5 w-5 animate-spin" />
              </div>
            ) : null}
          </div>
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
              {photoBusy ? <CircleNotch className="animate-spin" /> : <UploadSimple />} change photo
            </Button>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              @{me.username} · {me.carbon_id}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <Label htmlFor="pname">name</Label>
          <Input
            id="pname"
            value={name}
            maxLength={NAME_MAX}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "pname-error" : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError && (
            <p id="pname-error" className="text-xs text-destructive">
              {nameError}
            </p>
          )}
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

        <Button onClick={save} disabled={busy || !dirty || Boolean(nameError)}>
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
