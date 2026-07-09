"use client";

import * as React from "react";
import { DownloadSimple, Microphone, PaperPlaneRight, Stop, Trash, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { computePeaks } from "@/lib/media-meta";
import { roomDisplay } from "@/lib/peers";
import { track } from "@/lib/analytics";
import type { Room } from "@/lib/types";
import {
  appendVoiceChunk,
  cleanupStaleVoiceDrafts,
  clearAllVoiceDrafts,
  deleteVoiceDraft,
  listVoiceMetas,
  newVoiceDraftId,
  openVoiceDraftDb,
  putVoiceMeta,
  readVoiceChunks,
  type VoiceDraftMeta,
} from "@/lib/voice-drafts";
import { Button } from "@/components/ui/button";

interface VoiceRecordingContextValue {
  draft: VoiceDraftMeta | null;
  now: number;
  remoteActive: boolean;
  start: (roomId: string, replyToEventId?: string) => Promise<void>;
  stop: () => void;
  discard: () => Promise<void>;
  send: () => Promise<void>;
  retry: () => Promise<void>;
  download: () => Promise<void>;
  play: () => Promise<void>;
  returnToDraftRoom: () => void;
  roomName: (roomId: string) => string;
}

const VoiceRecordingContext = React.createContext<VoiceRecordingContextValue | null>(null);

export function useVoiceRecording(): VoiceRecordingContextValue {
  const ctx = React.useContext(VoiceRecordingContext);
  if (!ctx) throw new Error("useVoiceRecording must be used inside VoiceRecordingProvider");
  return ctx;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function xhrUpload(url: string, form: FormData): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.send(form);
  });
}

function ownerKeyFor(carbonId?: string | null): string | null {
  return carbonId ? `carbon:${carbonId}` : null;
}

export function VoiceRecordingProvider({
  rooms,
  onReturnToRoom,
  children,
}: {
  rooms: Room[];
  onReturnToRoom: (roomId: string) => void;
  children: React.ReactNode;
}) {
  const { carbon } = useAuth();
  const ownerKey = ownerKeyFor(carbon?.carbon_id);
  const [draft, setDraft] = React.useState<VoiceDraftMeta | null>(null);
  const draftRef = React.useRef<VoiceDraftMeta | null>(null);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const chunkSeqRef = React.useRef(0);
  const startedAtRef = React.useRef(0);
  const stoppingIntentRef = React.useRef<"draft" | "discard">("draft");
  const [now, setNow] = React.useState(() => Date.now());
  const bcRef = React.useRef<BroadcastChannel | null>(null);
  const [remoteActive, setRemoteActive] = React.useState(false);

  React.useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const roomName = React.useCallback(
    (roomId: string) => {
      const room = rooms.find((r) => r.room_id === roomId);
      return room ? roomDisplay(room).name : "that room";
    },
    [rooms],
  );

  const persistMeta = React.useCallback(async (patch: Partial<VoiceDraftMeta>) => {
    const cur = draftRef.current;
    if (!cur) return;
    const next: VoiceDraftMeta = { ...cur, ...patch, updatedAt: Date.now() };
    draftRef.current = next;
    setDraft(next);
    await putVoiceMeta(next);
  }, []);

  const stopTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
  }, []);

  React.useEffect(() => {
    if (!ownerKey) {
      void clearAllVoiceDrafts().catch(() => undefined);
      queueMicrotask(() => setDraft(null));
      return;
    }
    void (async () => {
      await openVoiceDraftDb();
      await cleanupStaleVoiceDrafts(ownerKey);
      const drafts = await listVoiceMetas(ownerKey);
      const recoverable = drafts
        .filter((d) => d.status !== "sending")
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
      if (recoverable) setDraft({ ...recoverable, status: recoverable.status === "recording" ? "draft" : recoverable.status });
    })().catch(() => undefined);
  }, [ownerKey]);

  React.useEffect(() => {
    const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("silicon-voice-recording") : null;
    bcRef.current = bc;
    if (bc) {
      bc.onmessage = (ev) => {
        const data = ev.data as { ownerKey?: string; active?: boolean };
        if (data.ownerKey === ownerKey) setRemoteActive(!!data.active);
      };
    }
    return () => {
      bc?.close();
      bcRef.current = null;
    };
  }, [ownerKey]);

  React.useEffect(() => {
    if (draft?.status !== "recording") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [draft?.status]);

  React.useEffect(() => {
    const flush = () => {
      try {
        if (recRef.current?.state === "recording") recRef.current.requestData();
      } catch {
        /* best effort */
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (draftRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const start = React.useCallback(
    async (roomId: string, replyToEventId?: string) => {
      if (!ownerKey) {
        toast.error("Can’t protect a recording until you’re signed in.");
        return;
      }
      if (draftRef.current || remoteActive) {
        toast.error(`You’re already recording in ${draftRef.current ? roomName(draftRef.current.roomId) : "another tab"}. Finish that recording before starting another.`, {
          action: draftRef.current ? { label: "Return", onClick: () => onReturnToRoom(draftRef.current!.roomId) } : undefined,
        });
        return;
      }
      try {
        await openVoiceDraftDb();
      } catch {
        toast.error("Protected recording storage is unavailable. Voice recording cannot start safely.");
        return;
      }

      const draftId = newVoiceDraftId();
      const mime = pickMime() || "audio/webm";
      const now = Date.now();
      const meta: VoiceDraftMeta = {
        draftId,
        ownerKey,
        roomId,
        ...(replyToEventId ? { replyToEventId } : {}),
        mime,
        createdAt: now,
        updatedAt: now,
        durationMs: 0,
        bytes: 0,
        chunkCount: 0,
        status: "recording",
      };
      try {
        await putVoiceMeta(meta);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        streamRef.current = stream;
        recRef.current = rec;
        chunksRef.current = [];
        chunkSeqRef.current = 0;
        startedAtRef.current = Date.now();
        stoppingIntentRef.current = "draft";
        setDraft(meta);
        draftRef.current = meta;
        bcRef.current?.postMessage({ ownerKey, active: true });
        api.activity(roomId, "recording", true).catch(() => undefined);
        rec.ondataavailable = (e) => {
          if (!e.data || e.data.size === 0) return;
          const blob = e.data;
          chunksRef.current.push(blob);
          const seq = chunkSeqRef.current++;
          void appendVoiceChunk(draftId, seq, blob)
            .then(() => {
              const cur = draftRef.current;
              if (!cur || cur.draftId !== draftId) return;
              void persistMeta({
                bytes: cur.bytes + blob.size,
                chunkCount: Math.max(cur.chunkCount, seq + 1),
                durationMs: Date.now() - startedAtRef.current,
              });
            })
            .catch(() => {
              toast.error("Storage is full. We stopped and kept this recording in memory only.");
              try {
                rec.requestData();
                rec.stop();
              } catch {
                /* ignore */
              }
            });
        };
        rec.onstop = () => {
          stopTracks();
          bcRef.current?.postMessage({ ownerKey, active: false });
          api.activity(roomId, "recording", false).catch(() => undefined);
          const cur = draftRef.current;
          if (!cur || stoppingIntentRef.current === "discard") return;
          void persistMeta({ status: "draft", durationMs: Date.now() - startedAtRef.current });
        };
        rec.start(1000);
      } catch (e) {
        await deleteVoiceDraft(draftId).catch(() => undefined);
        setDraft(null);
        draftRef.current = null;
        toast.error(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone permission denied." : "Couldn’t start voice recording safely.");
        stopTracks();
      }
    },
    [ownerKey, onReturnToRoom, persistMeta, remoteActive, roomName, stopTracks],
  );

  const stop = React.useCallback(() => {
    stoppingIntentRef.current = "draft";
    try {
      recRef.current?.requestData();
      recRef.current?.stop();
    } catch {
      void persistMeta({ status: "draft" });
      stopTracks();
    }
  }, [persistMeta, stopTracks]);

  const discard = React.useCallback(async () => {
    const cur = draftRef.current;
    if (!cur) return;
    if (!window.confirm("Discard this voice recording? This cannot be undone.")) return;
    stoppingIntentRef.current = "discard";
    try {
      if (recRef.current?.state === "recording") recRef.current.stop();
    } catch {
      /* ignore */
    }
    stopTracks();
    bcRef.current?.postMessage({ ownerKey, active: false });
    api.activity(cur.roomId, "recording", false).catch(() => undefined);
    await deleteVoiceDraft(cur.draftId).catch(() => undefined);
    chunksRef.current = [];
    draftRef.current = null;
    setDraft(null);
  }, [ownerKey, stopTracks]);

  const blobForDraft = React.useCallback(async (cur: VoiceDraftMeta): Promise<Blob> => {
    const chunks = await readVoiceChunks(cur.draftId).catch(() => []);
    const source = chunks.length ? chunks : chunksRef.current;
    return new Blob(source, { type: cur.mime || "audio/webm" });
  }, []);

  const send = React.useCallback(async () => {
    const cur = draftRef.current;
    if (!cur || cur.status === "recording" || cur.status === "sending") return;
    await persistMeta({ status: "sending", error: undefined });
    try {
      const blob = await blobForDraft(cur);
      if (blob.size === 0) throw new Error("empty recording");
      const filename = `voice-${Date.now()}.webm`;
      const presigned = await api.presignUpload({ mime: cur.mime, size: blob.size, kind: "voice", filename, room_id: cur.roomId });
      const mediaId = presigned.media.media_id;
      if (!presigned.upload.dev_mode) {
        const form = new FormData();
        for (const [k, v] of Object.entries(presigned.upload.fields)) form.append(k, v);
        form.append("file", blob, filename);
        await xhrUpload(presigned.upload.url, form);
      }
      const peaks = await computePeaks(blob).catch(() => null);
      await api.mediaComplete(mediaId, {
        duration_ms: peaks?.duration_ms || cur.durationMs,
        ...(peaks ? { peaks: peaks.peaks } : {}),
      });
      await api.sendEvent(cur.roomId, {
        type: "m.voice",
        content: { media_id: mediaId, mime: cur.mime, duration_ms: peaks?.duration_ms || cur.durationMs },
        reply_to_event_id: cur.replyToEventId,
      });
      track.messageSent({ room_id: cur.roomId, message_type: "m.voice", has_attachment: true, is_reply: Boolean(cur.replyToEventId) });
      await deleteVoiceDraft(cur.draftId);
      chunksRef.current = [];
      draftRef.current = null;
      setDraft(null);
      toast.success("voice note sent");
    } catch (e) {
      const message = e instanceof ApiError && [401, 403, 404].includes(e.status)
        ? "Can’t send to that room anymore."
        : "Couldn’t send voice note. Your recording is still saved.";
      await persistMeta({ status: "failed", error: message });
      toast.error(message);
    }
  }, [blobForDraft, persistMeta]);

  const download = React.useCallback(async () => {
    const cur = draftRef.current;
    if (!cur) return;
    const blob = await blobForDraft(cur);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `voice-draft-${new Date(cur.createdAt).toISOString().slice(0, 10)}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [blobForDraft]);

  const play = React.useCallback(async () => {
    const cur = draftRef.current;
    if (!cur) return;
    const blob = await blobForDraft(cur);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.onerror = () => URL.revokeObjectURL(url);
    await audio.play().catch(() => {
      URL.revokeObjectURL(url);
    });
  }, [blobForDraft]);

  const returnToDraftRoom = React.useCallback(() => {
    const cur = draftRef.current;
    if (cur) onReturnToRoom(cur.roomId);
  }, [onReturnToRoom]);

  const value = React.useMemo<VoiceRecordingContextValue>(
    () => ({
      draft,
      now,
      remoteActive,
      start,
      stop,
      discard,
      send,
      retry: send,
      download,
      play,
      returnToDraftRoom,
      roomName,
    }),
    [discard, download, draft, now, play, remoteActive, returnToDraftRoom, roomName, send, start, stop],
  );

  return (
    <VoiceRecordingContext.Provider value={value}>
      {children}
      <VoiceRecordingTray />
    </VoiceRecordingContext.Provider>
  );
}

function VoiceRecordingTray() {
  const voice = useVoiceRecording();
  const d = voice.draft;
  if (!d) return null;
  const active = d.status === "recording";
  const title = active ? "Recording voice note" : d.status === "failed" ? "Voice draft failed to send" : "Voice draft";
  const liveText = active
    ? `Recording voice note in ${voice.roomName(d.roomId)}.`
    : d.status === "failed"
      ? "Couldn’t send voice note. Your recording is still saved."
      : `Voice draft saved in ${voice.roomName(d.roomId)}.`;
  return (
    <div className="fixed inset-x-3 top-3 z-50 mx-auto max-w-3xl border bg-background/95 p-3 text-sm shadow-lg backdrop-blur md:left-[calc(var(--sidebar-w,320px)+0.75rem)] md:right-3 md:mx-0">
      <div className="sr-only" aria-live="polite" aria-atomic="true">{liveText}</div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {d.status === "failed" ? <WarningCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <Microphone className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium" aria-hidden="true">
              {title} in {voice.roomName(d.roomId)} · {formatElapsed(d.durationMs || (active ? voice.now - d.createdAt : 0))}
            </div>
            {d.error ? <div className="truncate text-xs text-destructive">{d.error}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={voice.returnToDraftRoom}>Return</Button>
          {active ? <Button size="sm" onClick={voice.stop}><Stop className="mr-1 h-3.5 w-3.5" /> Stop</Button> : null}
          {!active ? <Button size="sm" onClick={voice.send} disabled={d.status === "sending"}><PaperPlaneRight className="mr-1 h-3.5 w-3.5" /> {d.status === "failed" ? "Retry" : "Send"}</Button> : null}
          {!active ? <Button size="sm" variant="outline" onClick={voice.download}><DownloadSimple className="mr-1 h-3.5 w-3.5" /> Download</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => void voice.discard()} className="ml-auto text-destructive sm:ml-0"><Trash className="mr-1 h-3.5 w-3.5" /> Discard</Button>
        </div>
      </div>
    </div>
  );
}
