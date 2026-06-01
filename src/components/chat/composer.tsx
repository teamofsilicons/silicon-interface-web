"use client";

import * as React from "react";
import {
  ArrowBendUpLeft,
  CircleNotch,
  File as FileIcon,
  FilePdf,
  Microphone,
  Paperclip,
  PaperPlaneRight,
  X,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { searchEmoji } from "@/lib/emoji";
import { computePeaks, measureImage, measureVideo } from "@/lib/media-meta";
import type { Event, EventType } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VoiceRecorder } from "@/components/chat/voice-recorder";

/** Upload to a presigned URL via XHR (fetch can't report upload progress).
 *  Reports 0–100% and supports abort; rejects with an AbortError when the
 *  user cancels so the caller can distinguish it from a real failure. */
function xhrUpload(
  url: string,
  form: FormData,
  onProgress: (pct: number) => void,
  xhrRef: React.MutableRefObject<XMLHttpRequest | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    const clear = () => {
      xhrRef.current = null;
    };
    xhr.onload = () => {
      clear();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload failed (${xhr.status})`));
    };
    xhr.onerror = () => {
      clear();
      reject(new Error("upload failed"));
    };
    xhr.onabort = () => {
      clear();
      reject(new DOMException("aborted", "AbortError"));
    };
    xhr.send(form);
  });
}

/** Slice of an `Event` we can fabricate locally before the server responds. */
export interface OptimisticPayload {
  type: EventType;
  content?: Record<string, unknown>;
  reply_to_event_id?: string;
}

interface Props {
  roomId: string;
  /**
   * Called the instant the user presses send, before any network roundtrip,
   * so the parent can insert a "pending" placeholder bubble.
   */
  onOptimisticAdd: (clientId: string, payload: OptimisticPayload) => void;
  /** Server acked the POST — swap the optimistic placeholder for the real event. */
  onAck: (clientId: string, real: Event) => void;
  /** POST failed — mark the optimistic placeholder as failed. */
  onFail: (clientId: string, error: unknown) => void;
  /** A file dropped onto the chat surface gets handed in here. */
  droppedFile?: File | null;
  onDroppedFileConsumed?: () => void;
  /** When set, the next send will carry reply_to_event_id. */
  replyTo?: Event | null;
  onClearReply?: () => void;
}

// Composer height bounds, in line-heights. Single line by default, expands
// up to twelve before the textarea starts scrolling internally.
const MIN_ROWS = 1;
const MAX_ROWS = 12;

// Emoji quick-picker is a fixed grid so keyboard nav is true 2-D: ←/→ move one
// cell, ↑/↓ move a whole row (EMOJI_COLS cells).
const EMOJI_COLS = 8;
const EMOJI_LIMIT = EMOJI_COLS * 4; // 4 rows

/**
 * Renders the file the user has queued to send. Images get a real thumbnail
 * via `URL.createObjectURL`; everything else gets a type-appropriate icon.
 * The object URL is revoked when the file changes (or this unmounts) so we
 * don't leak blob memory across attachments.
 */
function StagedAttachment({
  file,
  uploadPct,
  onRemove,
}: {
  file: File;
  /** 0–100 while uploading; null/undefined when idle. */
  uploadPct?: number | null;
  onRemove: () => void;
}) {
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const isAudio = file.type.startsWith("audio/");
  const isPdf = file.type.includes("pdf");
  const uploading = uploadPct !== null && uploadPct !== undefined;

  const thumbUrl = React.useMemo(
    () => (isImage || isVideo ? URL.createObjectURL(file) : null),
    [file, isImage, isVideo],
  );
  React.useEffect(() => {
    return () => {
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    };
  }, [thumbUrl]);

  return (
    <div className="relative flex items-center gap-3 border bg-card px-3 py-2">
      {/* Upload progress bar across the top of the preview. */}
      {uploading && (
        <div
          className="absolute left-0 top-0 h-0.5 bg-primary transition-all"
          style={{ width: `${uploadPct}%` }}
        />
      )}
      <div className="h-12 w-12 shrink-0 overflow-hidden border bg-muted">
        {isImage && thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local blob URL
          <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
        ) : isVideo && thumbUrl ? (
          // Muted poster of the first frame — no controls, just the still.
          <video src={thumbUrl} muted className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            {isPdf ? <FilePdf className="h-5 w-5" /> : isAudio ? <Microphone className="h-5 w-5" /> : <FileIcon className="h-5 w-5" />}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{file.name}</div>
        <div className="label-mono text-[10px] text-muted-foreground">
          {uploading
            ? `${formatBytes((file.size * (uploadPct ?? 0)) / 100)} / ${formatBytes(file.size)} (${uploadPct}%)`
            : formatBytes(file.size)}
        </div>
      </div>
      <Button
        size="icon"
        variant="ghost"
        onClick={onRemove}
        aria-label={uploading ? "cancel upload" : "remove attachment"}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * Inline emoji picker rendered above the textarea when the user types `:`.
 * Up/down navigates, Tab/Enter inserts. Mouse click inserts.
 */
function EmojiQuickPicker({
  query,
  selectedIndex,
  onPick,
}: {
  query: string;
  selectedIndex: number;
  onPick: (emoji: string) => void;
}) {
  const results = React.useMemo(() => searchEmoji(query, EMOJI_LIMIT), [query]);
  if (results.length === 0) return null;
  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 grid w-max gap-1 border bg-card p-2 shadow-md"
      style={{ gridTemplateColumns: `repeat(${EMOJI_COLS}, minmax(0, 1fr))` }}
    >
      {results.map((r, i) => (
        <button
          key={r.name}
          type="button"
          onClick={() => onPick(r.emoji)}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center border transition-colors hover:bg-accent",
            i === selectedIndex
              ? "border-foreground bg-accent"
              : "border-transparent",
          )}
          title={`:${r.name}:`}
        >
          <span className="text-lg leading-none">{r.emoji}</span>
        </button>
      ))}
    </div>
  );
}

/** Quick one-line label of an event for the reply preview chip. */
function previewOf(ev: Event): string {
  const c = ev.content as Record<string, unknown>;
  if (ev.type === "m.text") {
    const body = String(c.body ?? "");
    return body.length > 80 ? `${body.slice(0, 80)}…` : body;
  }
  if (ev.type === "m.image") return "📷 photo";
  if (ev.type === "m.file") return `📎 ${String(c.caption ?? "attachment")}`;
  if (ev.type === "m.voice") return "🎙 voice note";
  if (ev.type === "m.tts") return "🔊 audio";
  return ev.type;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function Composer({
  roomId,
  onOptimisticAdd,
  onAck,
  onFail,
  droppedFile,
  onDroppedFileConsumed,
  replyTo,
  onClearReply,
}: Props) {
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // Upload progress (0–100) while a staged file is sending; null when idle.
  const [uploadPct, setUploadPct] = React.useState<number | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const xhrRef = React.useRef<XMLHttpRequest | null>(null);
  // The attached file uploads in the background as soon as it's staged; `send`
  // then just posts the message referencing the ready media.
  const [uploadStatus, setUploadStatus] = React.useState<
    "idle" | "uploading" | "ready" | "error"
  >("idle");
  const uploadedRef = React.useRef<{ mediaId: string; mime: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // Abort the in-flight upload and discard the staged file.
  const cancelUpload = () => {
    xhrRef.current?.abort();
    setConfirmCancel(false);
    setUploadPct(null);
    setFile(null);
  };
  // #21 — Emoji picker triggered by `:` followed by alphanumerics. We track
  // the active token (':grin', ':lol', …) and surface matches in a small
  // popover anchored to the textarea.
  const [emojiQuery, setEmojiQuery] = React.useState<string | null>(null);
  const [emojiIdx, setEmojiIdx] = React.useState(0);

  // Pull dropped files in from RoomView. We only treat it as a hint — the
  // parent clears its own state via `onDroppedFileConsumed` once we've taken
  // ownership.
  React.useEffect(() => {
    if (droppedFile) {
      setFile(droppedFile);
      onDroppedFileConsumed?.();
    }
  }, [droppedFile, onDroppedFileConsumed]);

  // Clicking "reply" on a message sets a reply target — focus the input right
  // away so the user can start typing without a second click.
  React.useEffect(() => {
    if (replyTo) taRef.current?.focus();
  }, [replyTo]);

  // Start uploading the instant a file is attached — don't wait for "send".
  // The upload (and metadata decode) run in the background; pressing send then
  // just posts the message referencing the already-uploaded media.
  React.useEffect(() => {
    if (!file) {
      uploadedRef.current = null;
      setUploadStatus("idle");
      setUploadPct(null);
      return;
    }
    let cancelled = false;
    uploadedRef.current = null;
    setUploadStatus("uploading");
    api.activity(roomId, "uploading", true).catch(() => undefined);
    (async () => {
      try {
        const r = await api.presignUpload({
          mime: file.type || "application/octet-stream",
          size: file.size,
          kind: file.type.startsWith("image/") ? "image" : "file",
          filename: file.name,
          room_id: roomId,
        });
        const mediaId = r.media.media_id;
        if (!r.upload.dev_mode) {
          setUploadPct(0);
          const form = new FormData();
          for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
          form.append("file", file);
          await xhrUpload(r.upload.url, form, setUploadPct, xhrRef);
          // Decode metadata (#22 image dims; #6 audio/video duration) so the
          // bubble reserves the right aspect / shows duration immediately.
          let meta: Parameters<typeof api.mediaComplete>[1] = {};
          if (file.type.startsWith("image/")) {
            const d = await measureImage(file);
            if (d) meta = { width: d.width, height: d.height };
          } else if (file.type.startsWith("video/")) {
            const d = await measureVideo(file);
            if (d) meta = { width: d.width, height: d.height, duration_ms: d.duration_ms };
          } else if (file.type.startsWith("audio/")) {
            const d = await computePeaks(file);
            if (d) meta = { duration_ms: d.duration_ms, peaks: d.peaks };
          }
          await api.mediaComplete(mediaId, meta);
        }
        if (cancelled) return;
        uploadedRef.current = { mediaId, mime: file.type || "application/octet-stream" };
        setUploadStatus("ready");
        setUploadPct(null);
      } catch (e) {
        if (cancelled) return;
        setUploadPct(null);
        if (e instanceof DOMException && e.name === "AbortError") {
          setUploadStatus("idle");
        } else {
          setUploadStatus("error");
          toast.error(e instanceof ApiError ? e.message : String(e));
        }
      } finally {
        api.activity(roomId, "uploading", false).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, roomId]);

  // ----- Draft persistence (per room, in localStorage) -----
  // Each room keeps its own in-progress draft so switching away and back — or
  // reloading — restores exactly what was being typed. The draft is removed
  // the moment the message is sent or the field is fully cleared.
  const draftKey = `silicon-interface:draft:${roomId}`;
  const persistDraft = React.useCallback(
    (v: string) => {
      try {
        if (v.trim()) window.localStorage.setItem(`silicon-interface:draft:${roomId}`, v);
        else window.localStorage.removeItem(`silicon-interface:draft:${roomId}`);
      } catch {
        /* storage may be unavailable (private mode / quota) — ignore */
      }
    },
    [roomId],
  );
  // Load the room's saved draft when the active room changes.
  React.useEffect(() => {
    let saved = "";
    try {
      saved = window.localStorage.getItem(draftKey) ?? "";
    } catch {
      /* ignore */
    }
    setText(saved);
    setEmojiQuery(null);
  }, [draftKey]);

  // #5 — Typing beacon. POSTs `activity('typing', true)` on the first
  // character and `false` after 3s of idle. Survives across rapid keystrokes
  // via a single shared timer.
  const typingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = React.useRef(false);
  const beaconTyping = React.useCallback(() => {
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      api.activity(roomId, "typing", true).catch(() => undefined);
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      api.activity(roomId, "typing", false).catch(() => undefined);
    }, 3000);
  }, [roomId]);
  React.useEffect(() => () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (isTypingRef.current) {
      // Reset the ref too — otherwise it stays `true` across a room switch and
      // the next room never re-sends a "typing" beacon (so the other side
      // never sees the indicator).
      isTypingRef.current = false;
      api.activity(roomId, "typing", false).catch(() => undefined);
    }
  }, [roomId]);

  // Auto-grow the textarea between MIN_ROWS and MAX_ROWS lines. Done
  // imperatively because Tailwind has no rows-from-content primitive — we
  // measure scrollHeight, clamp, and scroll internally past the ceiling.
  React.useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const padding =
      parseFloat(getComputedStyle(el).paddingTop) +
      parseFloat(getComputedStyle(el).paddingBottom);
    const minH = lineH * MIN_ROWS + padding;
    const maxH = lineH * MAX_ROWS + padding;
    el.style.height = "0px";
    const next = Math.min(Math.max(el.scrollHeight, minH), maxH);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, [text]);

  const reset = () => {
    setText("");
    persistDraft("");
    setFile(null);
  };

  const sendTextOptimistic = (body: string) => {
    const clientId = newClientId();
    const payload: OptimisticPayload = {
      type: "m.text",
      content: { body },
      reply_to_event_id: replyTo?.event_id,
    };
    onOptimisticAdd(clientId, payload);
    api
      .sendEvent(roomId, payload)
      .then((real) => onAck(clientId, real))
      .catch((err) => onFail(clientId, err));
    // Clear the reply target on send.
    onClearReply?.();
  };

  const send = async () => {
    const body = text.trim();

    // File path — the upload already started on attach. Post once it's ready
    // (the send button stays disabled until then).
    if (file) {
      const up = uploadedRef.current;
      if (uploadStatus !== "ready" || !up) return;
      setBusy(true);
      try {
        await api.sendEvent(roomId, {
          type: up.mime.startsWith("image/") ? "m.image" : "m.file",
          content: { media_id: up.mediaId, mime: up.mime, caption: body || file.name },
        });
        reset();
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    // Text only — optimistic, doesn't block the input.
    if (!body) return;
    sendTextOptimistic(body);
    setText("");
    persistDraft("");
  };

  // ----- Voice recording -----

  const onVoiceSubmit = async (blob: Blob, durationMs: number) => {
    setRecording(false);
    // Show the voice note instantly (with a pending clock) — don't make the
    // user stare at nothing while it uploads.
    const clientId = newClientId();
    onOptimisticAdd(clientId, { type: "m.voice", content: { duration_ms: durationMs } });
    api.activity(roomId, "recording", false).catch(() => undefined);
    api.activity(roomId, "uploading", true).catch(() => undefined);
    setBusy(true);
    try {
      const filename = `voice-${Date.now()}.webm`;
      const r = await api.presignUpload({
        mime: blob.type || "audio/webm",
        size: blob.size,
        kind: "voice",
        filename,
        room_id: roomId,
      });
      const mediaId = r.media.media_id;
      if (!r.upload.dev_mode) {
        const form = new FormData();
        for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
        form.append("file", blob, filename);
        const up = await fetch(r.upload.url, { method: "POST", body: form });
        if (!up.ok) throw new Error(`upload failed (${up.status})`);
        // #6 — Send the peaks we computed during recording (durationMs is
        // already known; the recorder reports it).
        const peaks = await computePeaks(blob);
        await api.mediaComplete(mediaId, {
          duration_ms: durationMs,
          ...(peaks ? { peaks: peaks.peaks } : {}),
        });
      }
      const real = await api.sendEvent(roomId, {
        type: "m.voice",
        content: {
          media_id: mediaId,
          mime: blob.type || "audio/webm",
          duration_ms: durationMs,
        },
      });
      onAck(clientId, real);
    } catch (e) {
      onFail(clientId, e);
    } finally {
      setBusy(false);
      api.activity(roomId, "uploading", false).catch(() => undefined);
    }
  };

  // Render the recorder in place of the textarea row when active.
  if (recording) {
    return (
      <div className="border-t bg-background p-3">
        <VoiceRecorder
          active
          onCancel={() => {
            setRecording(false);
            api.activity(roomId, "recording", false).catch(() => undefined);
          }}
          onSubmit={onVoiceSubmit}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t bg-background p-2">
      {replyTo && (
        <div className="flex items-start gap-2 border-l-2 border-foreground/60 bg-card px-2 py-1 text-xs">
          <ArrowBendUpLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
          <div className="min-w-0 flex-1">
            <div className="label-mono text-[10px] opacity-60">
              replying to {replyTo.sender_handle ? `@${replyTo.sender_handle}` : "message"}
            </div>
            <div className="truncate text-foreground/80">
              {replyTo.type === "m.voice" ? (
                <span className="inline-flex items-center gap-1 align-middle">
                  <Microphone className="h-3 w-3 shrink-0" /> voice note
                </span>
              ) : (
                previewOf(replyTo)
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            aria-label="cancel reply"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {file && (
        <StagedAttachment
          file={file}
          uploadPct={uploadPct}
          onRemove={() => {
            // Mid-upload, the cross asks for confirmation before aborting.
            if (uploadPct !== null) setConfirmCancel(true);
            else setFile(null);
          }}
        />
      )}
      {/* One container, hairline border, focus-within bumps to ring colour.
          Internal 1px dividers visually separate attach | input | voice/send
          while still reading as a single field. */}
      {/* `items-end` docks the fixed-size attach/send buttons to the bottom so
          they keep a constant height while the textarea grows upward. */}
      <div className="flex items-end border border-transparent transition-colors focus-within:border-ring">
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="attach file"
          aria-label="attach file"
          disabled={busy}
          className="flex h-11 w-11 shrink-0 items-center justify-center border-r border-input text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Paperclip />
        </button>
        <div className="relative flex min-w-0 flex-1 flex-col">
          <textarea
            ref={taRef}
            autoFocus
            value={text}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              persistDraft(v);
              if (v) beaconTyping();
              // Detect a `:foo` token at the caret. If found, open picker.
              const caret = e.target.selectionStart ?? v.length;
              const upTo = v.slice(0, caret);
              const m = upTo.match(/:([a-z0-9_+\-]*)$/i);
              if (m) {
                setEmojiQuery(m[1] ?? "");
                setEmojiIdx(0);
              } else {
                setEmojiQuery(null);
              }
            }}
            placeholder="message…"
            rows={MIN_ROWS}
            className="resize-none self-stretch bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              // Emoji picker keyboard navigation — true 2-D grid: ←/→ move one
              // cell, ↑/↓ move a whole row.
              if (emojiQuery !== null) {
                const results = searchEmoji(emojiQuery, EMOJI_LIMIT);
                const n = results.length;
                if (n > 0 && e.key === "ArrowRight") {
                  e.preventDefault();
                  setEmojiIdx((i) => Math.min(i + 1, n - 1));
                  return;
                }
                if (n > 0 && e.key === "ArrowLeft") {
                  e.preventDefault();
                  setEmojiIdx((i) => Math.max(0, i - 1));
                  return;
                }
                if (n > 0 && e.key === "ArrowDown") {
                  e.preventDefault();
                  setEmojiIdx((i) => Math.min(i + EMOJI_COLS, n - 1));
                  return;
                }
                if (n > 0 && e.key === "ArrowUp") {
                  e.preventDefault();
                  setEmojiIdx((i) => Math.max(0, i - EMOJI_COLS));
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && results.length > 0)) {
                  e.preventDefault();
                  const picked = results[emojiIdx] ?? results[0];
                  if (picked) {
                    const caret = taRef.current?.selectionStart ?? text.length;
                    const before = text.slice(0, caret);
                    const after = text.slice(caret);
                    const replaced = before.replace(/:([a-z0-9_+\-]*)$/i, picked.emoji);
                    const nextText = replaced + after;
                    setText(nextText);
                    persistDraft(nextText);
                    setEmojiQuery(null);
                    queueMicrotask(() => {
                      const el = taRef.current;
                      if (!el) return;
                      const pos = replaced.length;
                      el.selectionStart = el.selectionEnd = pos;
                    });
                  }
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEmojiQuery(null);
                  return;
                }
              }
              // Esc cancels an in-progress reply first; preventDefault stops the
              // page-level handler from also closing the chat. With no reply
              // active it falls through and the chat-close handler takes over.
              if (e.key === "Escape" && replyTo) {
                e.preventDefault();
                onClearReply?.();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {emojiQuery !== null && (
            <EmojiQuickPicker
              query={emojiQuery}
              selectedIndex={emojiIdx}
              onPick={(em) => {
                const caret = taRef.current?.selectionStart ?? text.length;
                const before = text.slice(0, caret);
                const after = text.slice(caret);
                const replaced = before.replace(/:([a-z0-9_+\-]*)$/i, em);
                setText(replaced + after);
                persistDraft(replaced + after);
                setEmojiQuery(null);
                queueMicrotask(() => taRef.current?.focus());
              }}
            />
          )}
        </div>
        {!text.trim() && !file ? (
          <button
            type="button"
            onClick={() => {
              setRecording(true);
              api.activity(roomId, "recording", true).catch(() => undefined);
            }}
            disabled={busy}
            title="record voice message"
            aria-label="record voice message"
            className="flex h-11 w-11 shrink-0 items-center justify-center border-l border-input text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            <Microphone />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={busy || (!!file && uploadStatus !== "ready")}
            aria-label="send"
            className="flex h-11 w-11 shrink-0 items-center justify-center border-l border-input bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy || (!!file && uploadStatus === "uploading") ? (
              <CircleNotch className="animate-spin" />
            ) : (
              <PaperPlaneRight />
            )}
          </button>
        )}
      </div>

      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel upload?</DialogTitle>
            <DialogDescription>
              The file is still uploading. Cancel and discard it?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              keep uploading
            </Button>
            <Button variant="destructive" onClick={cancelUpload}>
              cancel upload
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
