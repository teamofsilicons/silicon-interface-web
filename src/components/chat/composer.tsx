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
import { track } from "@/lib/analytics";
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
import { IdAvatar } from "@/components/profile/id-avatar";

/** Upload to a presigned URL via XHR (fetch can't report upload progress).
 *  Reports 0–100% and supports abort; rejects with an AbortError when the
 *  user cancels so the caller can distinguish it from a real failure. */
function xhrUpload(
  url: string,
  form: FormData,
  onProgress: (pct: number, loaded: number) => void,
  xhrRef: React.MutableRefObject<XMLHttpRequest | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      // Report the *real* loaded byte count alongside the percent so the UI's
      // "X / Y" label reflects actual progress, not a count derived from a
      // rounded percentage.
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100), e.loaded);
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
  /** Update a local pending bubble before the server has acked it. */
  onOptimisticUpdate?: (clientId: string, payload: OptimisticPayload) => void;
  /** A file dropped onto the chat surface gets handed in here. */
  droppedFile?: File | null;
  onDroppedFileConsumed?: () => void;
  /** When set, the next send will carry reply_to_event_id. */
  replyTo?: Event | null;
  onClearReply?: () => void;
  /** Delay text sends in direct silicon chats so nearby follow-ups can merge. */
  delayTextForSilicon?: boolean;
  /** Fires when a silicon text enters / leaves the held state, so the parent
   *  can reflect "holding the message…" on the progress line. */
  onHoldStateChange?: (holding: boolean) => void;
  /** The parent stashes our `cancelQueued(clientId)` here so deleting a held
   *  message's bubble can drop it from the queue (never sends it). */
  cancelQueuedRef?: React.MutableRefObject<((clientId: string) => void) | null>;
  /** People in this room offered by the `@` mention autocomplete. */
  mentionCandidates?: MentionCandidate[];
}

// Composer height bounds, in line-heights. Single line by default, expands
// up to twelve before the textarea starts scrolling internally.
const MIN_ROWS = 1;
const MAX_ROWS = 12;

// Emoji quick-picker is a fixed grid so keyboard nav is true 2-D: ←/→ move one
// cell, ↑/↓ move a whole row (EMOJI_COLS cells).
const EMOJI_COLS = 8; // minimum / fallback column count; actual count tracks bar width
const SILICON_TEXT_SEND_DELAY_MS = 5000;
// Once a held silicon message is paused (you kept typing past the 5s mark),
// emptying the input must NOT fire the send instantly — wait at least this long
// after the box goes empty, so a quick clear/send of a follow-up doesn't
// prematurely flush the held message.
const SILICON_EMPTY_HOLD_MS = 10_000;
// "wait 1 more minute" extends the post-empty hold by this much.
const SILICON_WAIT_MORE_MS = 60_000;
const CONTINUING_DRAFT_MIN_CHARS = 2;

// §6.6 — Up-front file validation, before we even ask for a presigned URL.
// A sane cap keeps a 5 GB drop from OOM-ing the metadata decode / hanging the
// upload; a zero-byte guard stops empty files; and we refuse types the bubble
// has no way to render so the user gets a clear toast instead of a broken tile.
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

/** HEIC/HEIF aren't renderable as <img> in most browsers — treat them as a
 *  generic file rather than a broken image (and warn so the user isn't
 *  surprised it shows as a chip, not a thumbnail). */
function isHeic(file: File): boolean {
  const t = (file.type || "").toLowerCase();
  if (t === "image/heic" || t === "image/heif") return true;
  return /\.(heic|heif)$/i.test(file.name || "");
}

/** Returns an error string if the file can't be attached, or null if it's OK. */
function validateFile(file: File): string | null {
  if (file.size === 0) return "that file is empty (0 bytes).";
  if (file.size > MAX_FILE_BYTES) {
    return `that file is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`;
  }
  return null;
}

interface QueuedTextSend {
  clientId: string;
  body: string;
  replyToEventId?: string;
}

/**
 * Renders the file the user has queued to send. Images get a real thumbnail
 * via `URL.createObjectURL`; everything else gets a type-appropriate icon.
 * The object URL is revoked when the file changes (or this unmounts) so we
 * don't leak blob memory across attachments.
 */
function StagedAttachment({
  file,
  uploadPct,
  uploadLoaded,
  onRemove,
}: {
  file: File;
  /** 0–100 while uploading; null/undefined when idle. */
  uploadPct?: number | null;
  /** Real bytes uploaded so far (from the XHR progress event). */
  uploadLoaded?: number | null;
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
            ? `${formatBytes(uploadLoaded ?? (file.size * (uploadPct ?? 0)) / 100)} / ${formatBytes(file.size)} (${uploadPct}%)`
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
  cols,
  limit,
  onPick,
}: {
  query: string;
  selectedIndex: number;
  cols: number;
  limit: number;
  onPick: (emoji: string) => void;
}) {
  const results = React.useMemo(() => searchEmoji(query, limit), [query, limit]);
  if (results.length === 0) return null;
  return (
    <div
      className="absolute bottom-full inset-x-0 z-50 mb-2 grid gap-1 border bg-card p-2 shadow-md"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {results.map((r, i) => (
        <button
          key={r.name}
          type="button"
          onClick={() => onPick(r.emoji)}
          className={cn(
            "inline-flex h-9 w-full items-center justify-center border transition-colors hover:bg-accent",
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

/** A person that can be @-mentioned from the composer (a room participant). */
export interface MentionCandidate {
  kind: "carbon" | "silicon";
  handle: string;
  name: string;
  photoUrl?: string | null;
  asciiUrl?: string | null;
}

// `@token` immediately before the caret. The lookbehind stops it firing inside
// an email ("alice@…") or any word — `@` must follow whitespace / line start.
const MENTION_RE = /(?<![\w@])@([a-z0-9_.\-]*)$/i;

function filterMentions(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.toLowerCase();
  return candidates
    .filter((c) => !q || c.handle.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .slice(0, 8);
}

/**
 * Inline @-mention picker rendered above the textarea when the user types `@`.
 * Up/down navigates, Tab/Enter inserts. Mouse click inserts.
 */
function MentionQuickPicker({
  results,
  selectedIndex,
  onPick,
}: {
  results: MentionCandidate[];
  selectedIndex: number;
  onPick: (c: MentionCandidate) => void;
}) {
  if (results.length === 0) return null;
  return (
    <div className="absolute bottom-full inset-x-0 z-50 mb-2 max-h-64 overflow-y-auto border bg-card p-1 shadow-md">
      {results.map((c, i) => (
        <button
          key={`${c.kind}:${c.handle}`}
          type="button"
          onClick={() => onPick(c)}
          className={cn(
            "flex w-full items-center gap-2 border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-accent",
            i === selectedIndex && "border-foreground bg-accent",
          )}
        >
          <IdAvatar
            seed={`${c.kind}:${c.handle}`}
            src={c.photoUrl}
            asciiSrc={c.asciiUrl}
            size={24}
            family={c.kind === "silicon" ? "silicon" : "carbon"}
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-medium">{c.name}</span>{" "}
            <span className="text-muted-foreground">@{c.handle}</span>
          </span>
          <span className="label-mono shrink-0 text-[10px] text-muted-foreground">{c.kind}</span>
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

// Delights §7a/§7e — terminal-flavored slash commands. `handled` means the
// command was fully dealt with locally (clear the input, don't send);
// `replaceWith` transforms the outgoing message and lets it send.
const SLASH_HELP = "/shrug · /me <action> · /clear · /sudo";
function runSlashCommand(body: string): {
  handled: boolean;
  replaceWith?: string;
  clearReply?: boolean;
} {
  const space = body.indexOf(" ");
  const cmd = (space < 0 ? body.slice(1) : body.slice(1, space)).toLowerCase();
  const arg = space < 0 ? "" : body.slice(space + 1).trim();
  switch (cmd) {
    case "shrug":
      return { handled: false, replaceWith: `${arg ? `${arg} ` : ""}¯\\_(ツ)_/¯` };
    case "me":
      // classic action message — rendered italic by our inline markdown
      return arg ? { handled: false, replaceWith: `_${arg}_` } : { handled: true };
    case "clear":
      return { handled: true, clearReply: true };
    case "sudo":
      toast.error("permission denied"); // §7e — the xkcd sandwich
      return { handled: true };
    case "help":
    case "?":
      toast.message("commands", { description: SLASH_HELP });
      return { handled: true };
    default:
      return { handled: false }; // unknown — send the "/…" text literally
  }
}

export function Composer({
  roomId,
  onOptimisticAdd,
  onAck,
  onFail,
  onOptimisticUpdate,
  droppedFile,
  onDroppedFileConsumed,
  replyTo,
  onClearReply,
  delayTextForSilicon = false,
  onHoldStateChange,
  cancelQueuedRef,
  mentionCandidates = [],
}: Props) {
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  // Mirror of `file` so `attachFile` can guard against replacing an in-flight
  // attachment without taking `file` as a dependency (which would re-create the
  // callback on every staged change).
  const fileRef = React.useRef<File | null>(null);
  React.useEffect(() => {
    fileRef.current = file;
  }, [file]);
  const [recording, setRecording] = React.useState(false);
  // §6.5 — Mirror `recording` in a ref so the unmount cleanup can clear a
  // dangling "recording…" beacon for the *current* room even if the room
  // switches while we're mid-record.
  const recordingRef = React.useRef(false);
  React.useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  React.useEffect(
    () => () => {
      // On unmount (e.g. switching rooms while recording), explicitly clear the
      // peer "recording…" beacon — otherwise it sticks until it times out
      // server-side. The VoiceRecorder's own cleanup stops the MediaStream.
      if (recordingRef.current) {
        api.activity(roomId, "recording", false).catch(() => undefined);
      }
    },
    [roomId],
  );
  const [busy, setBusy] = React.useState(false);
  // Upload progress (0–100) while a staged file is sending; null when idle.
  const [uploadPct, setUploadPct] = React.useState<number | null>(null);
  // Real bytes uploaded so far — drives the "X / Y" label instead of deriving
  // it from a rounded percent.
  const [uploadLoaded, setUploadLoaded] = React.useState<number | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const xhrRef = React.useRef<XMLHttpRequest | null>(null);
  // §6.3/§6.4 — Voice-note upload state. We surface progress + an abort
  // control during the upload, and retain the recorded blob if it fails so the
  // user can retry instead of losing the recording.
  const voiceXhrRef = React.useRef<XMLHttpRequest | null>(null);
  const [voiceUploadPct, setVoiceUploadPct] = React.useState<number | null>(null);
  const [pendingVoice, setPendingVoice] = React.useState<{
    blob: Blob;
    durationMs: number;
  } | null>(null);
  // The attached file uploads in the background as soon as it's staged; `send`
  // then just posts the message referencing the ready media.
  const [uploadStatus, setUploadStatus] = React.useState<
    "idle" | "uploading" | "ready" | "error"
  >("idle");
  const uploadedRef = React.useRef<{ mediaId: string; mime: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const textRef = React.useRef(text);
  const delayedTextQueueRef = React.useRef<QueuedTextSend[]>([]);
  const delayTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timer for the post-empty hold: after a paused queue's input goes empty, we
  // wait SILICON_EMPTY_HOLD_MS before sending instead of flushing immediately.
  const emptyHoldTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [typingActive, setTypingActiveState] = React.useState(false);
  const typingActiveRef = React.useRef(false);
  const [queuePaused, setQueuePaused] = React.useState(false);
  const [queuedTextCount, setQueuedTextCount] = React.useState(0);
  // When the held message has entered its final countdown, this is the wall
  // time it will auto-send at (null otherwise). Drives the "will send in {N}s".
  const [emptyHoldEndsAt, setEmptyHoldEndsAt] = React.useState<number | null>(null);
  // True once "wait 1 more minute" has extended the hold — flips the flush
  // button label from "send anyways" to "send now".
  const [waitExtended, setWaitExtended] = React.useState(false);
  // Bumped on an interval while the countdown runs so the banner re-renders.
  const [, setHoldTick] = React.useState(0);

  React.useEffect(() => {
    textRef.current = text;
  }, [text]);

  const setTypingActive = React.useCallback((active: boolean) => {
    typingActiveRef.current = active;
    setTypingActiveState(active);
  }, []);

  // Abort the in-flight upload and discard the staged file.
  const cancelUpload = () => {
    xhrRef.current?.abort();
    setConfirmCancel(false);
    setUploadPct(null);
    setUploadLoaded(null);
    setFile(null);
  };

  // §6.6 / §6.7 — Single entry point for staging an attachment, whether it
  // arrives from the picker, a drag-drop, or a paste. It validates up front,
  // refuses to silently replace an in-flight upload, and warns on HEIC.
  const attachFile = React.useCallback(
    (next: File | null) => {
      if (!next) {
        setFile(null);
        return;
      }
      // §6.7 — One file at a time. If something is already staged/uploading,
      // surface a clear message instead of silently aborting the first.
      if (fileRef.current) {
        toast.error("one file at a time - send or remove the current attachment first.");
        return;
      }
      const err = validateFile(next);
      if (err) {
        toast.error(err);
        return;
      }
      // §6.6 — HEIC can't render as a normal image; let the user know it'll
      // attach as a file chip rather than show a (broken) thumbnail.
      if (isHeic(next)) {
        toast.message("HEIC photo attached as a file (browsers can't preview it inline).");
      }
      setFile(next);
    },
    [],
  );

  // §6.7 — Multi-file selection (picker or drop) can only keep one; tell the
  // user the rest were ignored instead of dropping them silently.
  const attachFromList = React.useCallback(
    (list: FileList | File[] | null | undefined) => {
      const files = list ? Array.from(list) : [];
      if (files.length === 0) return;
      if (files.length > 1) {
        toast.message(`attaching the first of ${files.length} files - one at a time.`);
      }
      attachFile(files[0] ?? null);
    },
    [attachFile],
  );
  // #21 — Emoji picker triggered by `:` followed by alphanumerics. We track
  // the active token (':grin', ':lol', …) and surface matches in a small
  // popover anchored to the textarea.
  const [emojiQuery, setEmojiQuery] = React.useState<string | null>(null);
  const [emojiIdx, setEmojiIdx] = React.useState(0);
  // @-mention picker — null when inactive; otherwise the partial handle typed.
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = React.useState(0);
  const mentionResults = React.useMemo(
    () => (mentionQuery === null ? [] : filterMentions(mentionCandidates, mentionQuery)),
    [mentionQuery, mentionCandidates],
  );
  // Replace the `@token` immediately before the caret with `@handle ` and drop
  // the picker. Shared by keyboard (Tab/Enter) and mouse selection. Plain
  // function so it can reference `persistDraft` (declared below) lazily.
  const insertMention = (cand: MentionCandidate) => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const replaced = before.replace(MENTION_RE, `@${cand.handle} `);
    const nextText = replaced + after;
    setText(nextText);
    persistDraft(nextText);
    setMentionQuery(null);
    queueMicrotask(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const pos = replaced.length;
      ta.selectionStart = ta.selectionEnd = pos;
    });
  };
  // The emoji picker spans the full chat bar; its column count is derived from
  // the bar's width so it fills the row instead of sitting in a narrow box.
  const barRef = React.useRef<HTMLDivElement>(null);
  const [emojiCols, setEmojiCols] = React.useState(EMOJI_COLS);
  React.useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // ~44px per cell (button + gap); clamp so it's never absurdly sparse/dense.
      const cols = Math.max(EMOJI_COLS, Math.min(40, Math.floor((el.clientWidth - 16) / 44)));
      setEmojiCols(cols);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const emojiLimit = emojiCols * 3;

  // Pull dropped files in from RoomView. We only treat it as a hint — the
  // parent clears its own state via `onDroppedFileConsumed` once we've taken
  // ownership.
  React.useEffect(() => {
    if (droppedFile) {
      attachFile(droppedFile);
      onDroppedFileConsumed?.();
    }
  }, [droppedFile, onDroppedFileConsumed, attachFile]);

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
      setUploadLoaded(null);
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
          setUploadLoaded(0);
          const form = new FormData();
          for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
          form.append("file", file);
          await xhrUpload(
            r.upload.url,
            form,
            (pct, loaded) => {
              setUploadPct(pct);
              setUploadLoaded(loaded);
            },
            xhrRef,
          );
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
        setUploadLoaded(null);
      } catch (e) {
        if (cancelled) return;
        setUploadPct(null);
        setUploadLoaded(null);
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
      setTypingActive(true);
      api.activity(roomId, "typing", true).catch(() => undefined);
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      setTypingActive(false);
      api.activity(roomId, "typing", false).catch(() => undefined);
    }, 3000);
  }, [roomId, setTypingActive]);
  React.useEffect(() => () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (isTypingRef.current) {
      // Reset the ref too — otherwise it stays `true` across a room switch and
      // the next room never re-sends a "typing" beacon (so the other side
      // never sees the indicator).
      isTypingRef.current = false;
      setTypingActive(false);
      api.activity(roomId, "typing", false).catch(() => undefined);
    }
  }, [roomId, setTypingActive]);

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
    const contentH = el.scrollHeight;
    const next = Math.min(Math.max(contentH, minH), maxH);
    el.style.height = `${next}px`;
    el.style.overflowY = contentH > maxH ? "auto" : "hidden";
  }, [text]);

  const reset = () => {
    setText("");
    persistDraft("");
    setFile(null);
  };

  const clearDelayTimer = React.useCallback(() => {
    if (delayTimerRef.current) {
      clearTimeout(delayTimerRef.current);
      delayTimerRef.current = null;
    }
    if (emptyHoldTimerRef.current) {
      clearTimeout(emptyHoldTimerRef.current);
      emptyHoldTimerRef.current = null;
    }
  }, []);

  const hasContinuingDraft = React.useCallback(
    () => textRef.current.trim().length >= CONTINUING_DRAFT_MIN_CHARS,
    [],
  );

  const buildQueuedPayload = React.useCallback((items: QueuedTextSend[]): OptimisticPayload => {
    const replyIds = new Set(items.map((item) => item.replyToEventId || ""));
    const sharedReplyId = replyIds.size === 1 ? items[0]?.replyToEventId : undefined;
    return {
      type: "m.text",
      content: { body: items.map((item) => item.body).join("\n\n") },
      reply_to_event_id: sharedReplyId,
    };
  }, []);

  const clearDelayedQueue = React.useCallback(() => {
    delayedTextQueueRef.current = [];
    setQueuedTextCount(0);
    setQueuePaused(false);
    setEmptyHoldEndsAt(null);
    setWaitExtended(false);
    clearDelayTimer();
    onHoldStateChange?.(false);
  }, [clearDelayTimer, onHoldStateChange]);

  // Drop a held message from the queue when its bubble is deleted — never send.
  const cancelQueued = React.useCallback(
    (clientId: string) => {
      if (delayedTextQueueRef.current.some((it) => it.clientId === clientId)) {
        clearDelayedQueue();
      }
    },
    [clearDelayedQueue],
  );
  React.useEffect(() => {
    if (!cancelQueuedRef) return;
    cancelQueuedRef.current = cancelQueued;
    return () => {
      cancelQueuedRef.current = null;
    };
  }, [cancelQueuedRef, cancelQueued]);

  const flushDelayedTextQueue = React.useCallback(
    async (extra?: QueuedTextSend, optimistic = true) => {
      const items = [
        ...delayedTextQueueRef.current,
        ...(extra ? [extra] : []),
      ];
      if (!items.length) return;
      const payload = buildQueuedPayload(items);
      const ackClientId = delayedTextQueueRef.current[0]?.clientId;
      clearDelayedQueue();
      if (ackClientId) onOptimisticUpdate?.(ackClientId, payload);
      try {
        const real = await api.sendEvent(roomId, payload, ackClientId); // §2.3
        if (optimistic && ackClientId) onAck(ackClientId, real);
        track.messageSent({
          room_id: roomId,
          message_type: "m.text",
          is_reply: Boolean(payload.reply_to_event_id),
        });
      } catch (err) {
        if (optimistic && ackClientId) onFail(ackClientId, err);
        else toast.error(err instanceof ApiError ? err.message : String(err));
      }
    },
    [
      buildQueuedPayload,
      clearDelayedQueue,
      onAck,
      onFail,
      onOptimisticUpdate,
      roomId,
    ],
  );

  const queueDelayedTextSend = React.useCallback(
    (body: string) => {
      const clientId = newClientId();
      const item: QueuedTextSend = {
        clientId,
        body,
        replyToEventId: replyTo?.event_id,
      };
      delayedTextQueueRef.current = [item];
      setQueuedTextCount(1);
      setQueuePaused(false);
      onOptimisticAdd(clientId, buildQueuedPayload([item]));
      clearDelayTimer();
      delayTimerRef.current = setTimeout(() => {
        delayTimerRef.current = null;
        // Only once the 5s merge window ends and you're still typing do we flip
        // to the "holding…" state. Before that, the normal silicon progress
        // (the random copy) shows.
        if (hasContinuingDraft()) {
          setQueuePaused(true);
          onHoldStateChange?.(true);
        } else {
          void flushDelayedTextQueue();
        }
      }, SILICON_TEXT_SEND_DELAY_MS);
      onClearReply?.();
    },
    [
      buildQueuedPayload,
      clearDelayTimer,
      flushDelayedTextQueue,
      hasContinuingDraft,
      onClearReply,
      onHoldStateChange,
      onOptimisticAdd,
      replyTo,
    ],
  );

  React.useEffect(() => {
    // Not paused → no post-empty countdown should be pending.
    if (!queuePaused || queuedTextCount === 0) {
      if (emptyHoldTimerRef.current) {
        clearTimeout(emptyHoldTimerRef.current);
        emptyHoldTimerRef.current = null;
        setEmptyHoldEndsAt(null);
      }
      return;
    }
    // Still typing a follow-up → keep holding; cancel any empty-hold countdown.
    if (hasContinuingDraft()) {
      if (emptyHoldTimerRef.current) {
        clearTimeout(emptyHoldTimerRef.current);
        emptyHoldTimerRef.current = null;
        setEmptyHoldEndsAt(null);
      }
      return;
    }
    // Input is empty while paused: wait at least SILICON_EMPTY_HOLD_MS before
    // sending (NOT instantly). Don't restart an already-running countdown.
    if (emptyHoldTimerRef.current) return;
    setWaitExtended(false);
    setEmptyHoldEndsAt(Date.now() + SILICON_EMPTY_HOLD_MS);
    emptyHoldTimerRef.current = setTimeout(() => {
      emptyHoldTimerRef.current = null;
      setEmptyHoldEndsAt(null);
      // Re-check: if they resumed typing in the meantime, this effect will have
      // cancelled us; only send if the box is still empty.
      if (!hasContinuingDraft()) void flushDelayedTextQueue();
    }, SILICON_EMPTY_HOLD_MS);
  }, [flushDelayedTextQueue, hasContinuingDraft, queuePaused, queuedTextCount, text, typingActive]);

  // Re-render once a second while the countdown is live so "will send in {N}s"
  // ticks down.
  React.useEffect(() => {
    if (emptyHoldEndsAt == null) return;
    const id = window.setInterval(() => setHoldTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [emptyHoldEndsAt]);

  // "wait 1 more minute" — push the auto-send out by SILICON_WAIT_MORE_MS.
  const waitOneMoreMinute = React.useCallback(() => {
    if (emptyHoldTimerRef.current) clearTimeout(emptyHoldTimerRef.current);
    setWaitExtended(true);
    setEmptyHoldEndsAt(Date.now() + SILICON_WAIT_MORE_MS);
    emptyHoldTimerRef.current = setTimeout(() => {
      emptyHoldTimerRef.current = null;
      setEmptyHoldEndsAt(null);
      if (!hasContinuingDraft()) void flushDelayedTextQueue();
    }, SILICON_WAIT_MORE_MS);
  }, [flushDelayedTextQueue, hasContinuingDraft]);

  React.useEffect(
    () => () => {
      const queued = delayedTextQueueRef.current;
      if (!queued.length) return;
      clearDelayTimer();
      const payload = buildQueuedPayload(queued);
      delayedTextQueueRef.current = [];
      api.sendEvent(roomId, payload, queued[0]?.clientId).catch((err) => {
        toast.error(err instanceof ApiError ? err.message : String(err));
      });
    },
    [buildQueuedPayload, clearDelayTimer, roomId],
  );

  const sendTextOptimistic = (body: string) => {
    const clientId = newClientId();
    const payload: OptimisticPayload = {
      type: "m.text",
      content: { body },
      reply_to_event_id: replyTo?.event_id,
    };
    onOptimisticAdd(clientId, payload);
    api
      .sendEvent(roomId, payload, clientId) // §2.3 — echo-match by client id
      .then((real) => onAck(clientId, real))
      .catch((err) => onFail(clientId, err));
    track.messageSent({
      room_id: roomId,
      message_type: "m.text",
      is_reply: Boolean(replyTo),
    });
    // Clear the reply target on send.
    onClearReply?.();
  };

  const send = async () => {
    let body = text.trim();

    // §7a/§7e — slash command palette (text only; a "/" with a file is a caption).
    if (!file && body.startsWith("/")) {
      const result = runSlashCommand(body);
      if (result.handled) {
        setText("");
        persistDraft("");
        if (result.clearReply) onClearReply?.();
        return;
      }
      if (result.replaceWith !== undefined) body = result.replaceWith; // transform + send
    }

    // File path — the upload already started on attach. Post once it's ready
    // (the send button stays disabled until then).
    if (file) {
      const up = uploadedRef.current;
      if (uploadStatus !== "ready" || !up) return;
      setBusy(true);
      try {
        const fileType = up.mime.startsWith("image/") ? "m.image" : "m.file";
        await api.sendEvent(roomId, {
          type: fileType,
          content: { media_id: up.mediaId, mime: up.mime, caption: body || file.name },
        });
        track.messageSent({ room_id: roomId, message_type: fileType, has_attachment: true });
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
    if (delayTextForSilicon) {
      if (delayedTextQueueRef.current.length) {
        void flushDelayedTextQueue({
          clientId: newClientId(),
          body,
          replyToEventId: replyTo?.event_id,
        });
        onClearReply?.();
      } else {
        queueDelayedTextSend(body);
      }
      setText("");
      persistDraft("");
      return;
    }
    sendTextOptimistic(body);
    setText("");
    persistDraft("");
  };

  // ----- Voice recording -----

  const uploadVoice = async (blob: Blob, durationMs: number) => {
    // Show the voice note instantly (with a pending clock) — don't make the
    // user stare at nothing while it uploads.
    const clientId = newClientId();
    const mime = blob.type || "audio/webm";
    const localUrl = URL.createObjectURL(blob);
    onOptimisticAdd(clientId, {
      type: "m.voice",
      content: { duration_ms: durationMs, mime, local_url: localUrl },
    });
    const peaksPromise = computePeaks(blob)
      .then((peaks) => {
        if (peaks) {
          onOptimisticUpdate?.(clientId, {
            type: "m.voice",
            content: {
              duration_ms: peaks.duration_ms || durationMs,
              mime,
              local_url: localUrl,
              peaks: peaks.peaks,
            },
          });
        }
        return peaks;
      })
      .catch(() => null);
    api.activity(roomId, "uploading", true).catch(() => undefined);
    setBusy(true);
    try {
      const filename = `voice-${Date.now()}.webm`;
      const r = await api.presignUpload({
        mime,
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
        // §6.3 — Route the voice upload through the same xhr-with-progress +
        // abort path the file picker uses, so a long note on a slow uplink
        // shows progress and can be cancelled instead of an inert spinner.
        setVoiceUploadPct(0);
        await xhrUpload(r.upload.url, form, setVoiceUploadPct, voiceXhrRef);
      }
      // #6 — Send the peaks we computed during recording (durationMs is
      // already known; the recorder reports it). This runs for dev uploads too
      // so the server event has metadata after the optimistic row is replaced.
      const peaks = await peaksPromise;
      await api.mediaComplete(mediaId, {
        duration_ms: peaks?.duration_ms || durationMs,
        ...(peaks ? { peaks: peaks.peaks } : {}),
      });
      const real = await api.sendEvent(
        roomId,
        {
          type: "m.voice",
          content: {
            media_id: mediaId,
            mime,
            duration_ms: peaks?.duration_ms || durationMs,
          },
        },
        clientId, // §2.3
      );
      onAck(clientId, real);
      // §6.4 — Succeeded: the recording is safely on the server, so drop the
      // retained blob.
      setPendingVoice(null);
      track.messageSent({ room_id: roomId, message_type: "m.voice", has_attachment: true });
    } catch (e) {
      onFail(clientId, e);
      // §6.4 — A user-initiated abort isn't a failure to recover from; just
      // drop it. Any *real* failure retains the blob so the user can retry
      // instead of losing an unrecoverable recording (the blob URL was the
      // only handle to the audio).
      if (e instanceof DOMException && e.name === "AbortError") {
        setPendingVoice(null);
      } else {
        setPendingVoice({ blob, durationMs });
        toast.error("voice note failed to send - tap retry to try again.");
      }
    } finally {
      setBusy(false);
      setVoiceUploadPct(null);
      voiceXhrRef.current = null;
      // §6.4 — Revoke the object URL in `finally` regardless of outcome. The
      // optimistic bubble has already captured the bytes it needs (peaks +
      // duration); leaving the URL live leaked blob memory on every failure.
      URL.revokeObjectURL(localUrl);
      api.activity(roomId, "uploading", false).catch(() => undefined);
    }
  };

  const onVoiceSubmit = (blob: Blob, durationMs: number) => {
    setRecording(false);
    api.activity(roomId, "recording", false).catch(() => undefined);
    void uploadVoice(blob, durationMs);
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
          uploadLoaded={uploadLoaded}
          onRemove={() => {
            // Mid-upload, the cross asks for confirmation before aborting.
            if (uploadPct !== null) setConfirmCancel(true);
            else setFile(null);
          }}
        />
      )}
      {/* §6.3 — Voice upload progress + abort. */}
      {voiceUploadPct !== null && (
        <div className="flex items-center gap-3 border bg-card px-3 py-2 text-xs">
          <Microphone className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="label-mono text-[10px] text-muted-foreground">
              sending voice note… {voiceUploadPct}%
            </div>
            <div className="mt-1 h-0.5 w-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${voiceUploadPct}%` }}
              />
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => voiceXhrRef.current?.abort()}
            aria-label="cancel voice upload"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {/* §6.4 — A failed voice note is retained; offer retry / discard so the
          recording isn't lost to a transient network blip. */}
      {pendingVoice && voiceUploadPct === null && (
        <div className="flex items-center justify-between gap-3 border border-destructive/40 bg-card px-3 py-2 text-xs">
          <span className="min-w-0 text-destructive">voice note didn&apos;t send.</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const v = pendingVoice;
                setPendingVoice(null);
                void uploadVoice(v.blob, v.durationMs);
              }}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              retry
            </button>
            <button
              type="button"
              onClick={() => setPendingVoice(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              discard
            </button>
          </div>
        </div>
      )}
      {queuePaused && queuedTextCount > 0 && (
        <div className="flex items-center justify-between gap-3 border border-input bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
          {emptyHoldEndsAt != null ? (
            // Final countdown — auto-send is imminent.
            <>
              <span className="min-w-0">
                will send in {Math.max(0, Math.ceil((emptyHoldEndsAt - Date.now()) / 1000))} second
                {Math.max(0, Math.ceil((emptyHoldEndsAt - Date.now()) / 1000)) === 1 ? "" : "s"}.
              </span>
              <div className="flex shrink-0 items-center gap-4">
                <button
                  type="button"
                  onClick={waitOneMoreMinute}
                  className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
                >
                  wait 1 more minute
                </button>
                <button
                  type="button"
                  onClick={() => void flushDelayedTextQueue()}
                  className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {waitExtended ? "send now" : "send anyways"}
                </button>
              </div>
            </>
          ) : (
            // Still typing — hold open-endedly until they finish.
            <>
              <span className="min-w-0">holding the message until you finish typing.</span>
              <button
                type="button"
                onClick={() => void flushDelayedTextQueue()}
                className="shrink-0 text-xs font-medium text-foreground underline-offset-2 hover:underline"
              >
                Send anyway
              </button>
            </>
          )}
        </div>
      )}
      {/* One bordered field. Controls stay fixed-height at the bottom while
          multiline drafts grow the text area. */}
      <div
        ref={barRef}
        className="relative flex items-end gap-2"
      >
        <input
          type="file"
          ref={fileInputRef}
          multiple
          className="hidden"
          onChange={(e) => {
            attachFromList(e.target.files);
            // Reset so picking the same file again still fires onChange, and a
            // rejected pick doesn't leave a stale selection on the input.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="attach file"
          aria-label="attach file"
          disabled={busy}
          className="flex h-11 w-11 shrink-0 items-center justify-center border border-input text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Paperclip />
        </button>
        <div className="relative flex min-h-11 min-w-0 flex-1 items-center border border-input transition-colors focus-within:border-ring">
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
              // The `(?<![\w])` lookbehind stops the trigger firing inside
              // times/ratios like `12:30` or URLs like `http://` — the colon
              // must follow whitespace or the start of the line, not a word
              // character, to be treated as an emoji shortcode start.
              const caret = e.target.selectionStart ?? v.length;
              const upTo = v.slice(0, caret);
              const m = upTo.match(/(?<![\w]):([a-z0-9_+\-]*)$/i);
              if (m) {
                setEmojiQuery(m[1] ?? "");
                setEmojiIdx(0);
              } else {
                setEmojiQuery(null);
              }
              // `@handle` autocomplete for the people in this room.
              const at = upTo.match(MENTION_RE);
              if (at && mentionCandidates.length > 0) {
                setMentionQuery(at[1] ?? "");
                setMentionIdx(0);
              } else {
                setMentionQuery(null);
              }
            }}
            placeholder="message…"
            rows={MIN_ROWS}
            className="w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
            onPaste={(e) => {
              // Paste a screenshot (or any file) to attach it. We only consume
              // the event when the clipboard actually carries a file — a normal
              // text paste falls through to the default behavior untouched.
              const items = e.clipboardData?.files;
              if (items && items.length > 0) {
                e.preventDefault();
                attachFromList(items);
              }
            }}
            onKeyDown={(e) => {
              // §6.8 — Suppress all of the picker/send key handling while an
              // IME is composing so a composition-commit Enter doesn't pick an
              // emoji or send.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              // @-mention picker — a vertical list: ↑/↓ move, Tab/Enter insert,
              // Esc dismisses. Takes the keys before the emoji/send handling.
              if (mentionQuery !== null && mentionResults.length > 0) {
                const n = mentionResults.length;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIdx((i) => Math.min(i + 1, n - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIdx((i) => Math.max(0, i - 1));
                  return;
                }
                if (e.key === "Tab" || e.key === "Enter") {
                  e.preventDefault();
                  insertMention(mentionResults[mentionIdx] ?? mentionResults[0]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionQuery(null);
                  return;
                }
              }
              // Emoji picker keyboard navigation — true 2-D grid: ←/→ move one
              // cell, ↑/↓ move a whole row.
              if (emojiQuery !== null) {
                const results = searchEmoji(emojiQuery, emojiLimit);
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
                  setEmojiIdx((i) => Math.min(i + emojiCols, n - 1));
                  return;
                }
                if (n > 0 && e.key === "ArrowUp") {
                  e.preventDefault();
                  setEmojiIdx((i) => Math.max(0, i - emojiCols));
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
                // §6.8 — Don't send mid-IME-composition. While a CJK (or any)
                // input method is composing, Enter *commits the candidate* —
                // sending here would fire a half-composed message. `isComposing`
                // is the modern signal; keyCode 229 is the legacy fallback some
                // browsers still report during composition.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                send();
              }
            }}
          />
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
            className="flex h-11 w-11 shrink-0 items-center justify-center border border-input text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            <Microphone />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={busy || (!!file && uploadStatus !== "ready")}
            aria-label="send"
            className="flex h-11 w-11 shrink-0 items-center justify-center border border-input bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy || (!!file && uploadStatus === "uploading") ? (
              <CircleNotch className="animate-spin" />
            ) : (
              <PaperPlaneRight />
            )}
          </button>
        )}
        {emojiQuery !== null && (
          <EmojiQuickPicker
            query={emojiQuery}
            selectedIndex={emojiIdx}
            cols={emojiCols}
            limit={emojiLimit}
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
        {mentionQuery !== null && (
          <MentionQuickPicker
            results={mentionResults}
            selectedIndex={mentionIdx}
            onPick={insertMention}
          />
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
