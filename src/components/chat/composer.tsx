"use client";

import * as React from "react";
import {
  ArrowBendUpLeft,
  ArrowsOutSimple,
  CircleNotch,
  File as FileIcon,
  FilePdf,
  Microphone,
  Paperclip,
  PaperPlaneRight,
  PencilSimple,
  X,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { ackOutbox, enqueueOutbox } from "@/lib/outbox";
import { track } from "@/lib/analytics";
import { ALL_EMOJI_LIST, searchEmoji } from "@/lib/emoji";
import { computePeaks, measureImage, measureVideo } from "@/lib/media-meta";
import { xhrUpload } from "@/lib/media-upload";
import {
  clearDraftAfterSend,
  flushDraft,
  getDraft,
  loadServerDraft,
  setDraft,
  setDraftFocused,
  setDraftReply,
} from "@/lib/drafts";
import { getDraftAttachments, setDraftAttachments } from "@/lib/draft-attachments";
import { editableTextForEvent } from "@/lib/event-edit";
import { clearAnnotationSession } from "@/lib/annotation-session";
import type { AnnotationDraft, Event, EventType } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { VoiceRecorder } from "@/components/chat/voice-recorder";
import { FileName } from "@/components/chat/file-name";
import { MarkdownView } from "@/components/chat/markdown-view";
import { MediaPreviewer } from "@/components/chat/media-previewer";
import { looksLikeMarkdown } from "@/lib/markdown";
import { IdAvatar } from "@/components/profile/id-avatar";


/** Slice of an `Event` we can fabricate locally before the server responds. */
export interface OptimisticPayload {
  type: EventType;
  content?: Record<string, unknown>;
  reply_to_event_id?: string;
  edited_at?: string | null;
}

export interface ComposerRestoreAttachment {
  mediaId: string;
  mime: string;
  name: string;
  size?: number;
}

export interface ComposerRestoreDraft {
  id: string;
  text: string;
  attachments?: ComposerRestoreAttachment[];
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
  /** A flattened annotation set handed off from the studio, staged as a draft. */
  pendingAnnotationDraft?: AnnotationDraft | null;
  onAnnotationDraftConsumed?: () => void;
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
  /** Message currently being edited in the composer. */
  editingEvent?: Event | null;
  /** Clear the parent-held edit target. */
  onEditComplete?: () => void;
  /** Persist an edit for an already-sent message. */
  onPersistedEdit?: (event: Event, body: string) => Promise<void>;
  /** Ask the parent to select the latest editable message, usually via ↑. */
  onRequestEditLast?: () => void;
  /** Restore an unsent message back into the composer. */
  restoreDraft?: ComposerRestoreDraft | null;
  onRestoreDraftConsumed?: () => void;
  /** Keyboard path for cancelling the latest held message. */
  onCancelHeldLast?: () => void;
  /** Keep draft editing available while blocking new sends. */
  sendDisabled?: boolean;
  sendDisabledReason?: string;
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
const EDIT_INACTIVITY_MS = 60_000;
// Cap concurrent staged attachments so a stray multi-select can't queue hundreds.
const MAX_ATTACHMENTS = 10;

// §6.6 — Up-front file validation, before we even ask for a presigned URL.
// A sane cap keeps a 5 GB drop from OOM-ing the metadata decode / hanging the
// upload; a zero-byte guard stops empty files; and we refuse types the bubble
// has no way to render so the user gets a clear toast instead of a broken tile.
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB

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
    return `that file is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024 / 1024)} GB).`;
  }
  return null;
}

interface QueuedTextSend {
  clientId: string;
  body: string;
  replyToEventId?: string;
  holdGroupId: string;
  holdIndex: number;
  editedAt?: string | null;
}

/** One staged attachment, uploading in the background until ready to send. */
interface StagedFile {
  id: string;
  /** The raw File while it's being uploaded; null for an attachment restored
   *  from a persisted draft (we only kept its metadata + media_id). */
  file: File | null;
  /** Display name + size, kept independent of `file` so restored rows render. */
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  /** 0–100 while uploading; null once done. */
  pct: number | null;
  loaded: number | null;
  mediaId: string | null;
  mime: string;
  /** "annotations" for the generated annotated file staged from the studio (sent
   *  as a normal m.file/m.image, reply-linked to its source file); a plain file
   *  otherwise. */
  kind?: "annotations";
  /** The annotation payload, present only when `kind === "annotations"`. */
  annotation?: AnnotationDraft;
}

/** Rebuild staged rows from a room's persisted (already-uploaded) draft. */
function restoreStagedAttachments(roomId: string): StagedFile[] {
  return getDraftAttachments(roomId).map((a) => ({
    id: a.id,
    file: null,
    name: a.name,
    size: a.size,
    status: "ready" as const,
    pct: null,
    loaded: null,
    mediaId: a.mediaId,
    mime: a.mime,
  }));
}

/**
 * Renders the file the user has queued to send. Images get a real thumbnail
 * via `URL.createObjectURL`; everything else gets a type-appropriate icon.
 * The object URL is revoked when the file changes (or this unmounts) so we
 * don't leak blob memory across attachments.
 */
function StagedAttachment({
  file,
  name,
  size,
  mime,
  mediaId,
  uploadPct,
  uploadLoaded,
  onRemove,
  roomId,
  onAttachAnnotations,
}: {
  /** Raw File while uploading; null for a draft-restored (already-uploaded) row. */
  file: File | null;
  name: string;
  size: number;
  mime: string;
  /** Set once uploaded — lets a restored row fetch a URL to preview. */
  mediaId?: string | null;
  /** 0–100 while uploading; null/undefined when idle. */
  uploadPct?: number | null;
  /** Real bytes uploaded so far (from the XHR progress event). */
  uploadLoaded?: number | null;
  onRemove: () => void;
  /** Room the draft will be sent to — enables annotating the staged file. */
  roomId?: string;
  /** Annotating a not-yet-sent draft has no message to reply to — this stages
   *  the annotated result in place of the plain file (no sourceEventId, so the
   *  eventual send carries no reply_to_event_id). */
  onAttachAnnotations?: (draft: AnnotationDraft) => void;
}) {
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  const isAudio = mime.startsWith("audio/");
  const isPdf = mime.includes("pdf");
  const uploading = uploadPct !== null && uploadPct !== undefined;

  // A blob URL for the raw file (when we still hold it) — drives both the
  // thumbnail and the in-place preview. A restored row fetches a URL on click.
  const fileUrl = React.useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );
  React.useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [fileUrl]);

  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const previewUrl = fileUrl ?? remoteUrl;

  const openPreview = async () => {
    if (previewUrl) {
      setPreviewOpen(true);
      return;
    }
    if (!mediaId) return;
    try {
      const r = await api.mediaDetail(mediaId);
      if (r.download_url) {
        setRemoteUrl(r.download_url);
        setPreviewOpen(true);
      }
    } catch {
      toast.error("couldn't open attachment");
    }
  };

  return (
    <div className="relative flex items-center gap-3 border bg-card px-3 py-2">
      {/* Upload progress bar across the top of the preview. */}
      {uploading && (
        <div
          className="absolute left-0 top-0 h-0.5 bg-primary transition-all"
          style={{ width: `${uploadPct}%` }}
        />
      )}
      {/* The thumbnail + name is a button that opens an in-place preview. */}
      <button
        type="button"
        onClick={openPreview}
        title={`preview ${name}`}
        className="group flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div className="relative h-12 w-12 shrink-0 overflow-hidden border bg-muted">
          {isImage && fileUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local blob URL
            <img src={fileUrl} alt="" className="sdr-media h-full w-full object-cover" />
          ) : isVideo && fileUrl ? (
            <video src={fileUrl} muted className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              {isPdf ? <FilePdf className="h-5 w-5" /> : isAudio ? <Microphone className="h-5 w-5" /> : <FileIcon className="h-5 w-5" />}
            </div>
          )}
          {/* Hover affordance — it's clickable to expand. */}
          <div className="absolute inset-0 hidden place-items-center bg-black/35 group-hover:grid">
            <ArrowsOutSimple className="h-4 w-4 text-white" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <FileName name={name} className="text-xs font-medium" />
          <div className="label-mono text-[10px] text-muted-foreground">
            {uploading
              ? size > 0
                ? `${formatBytes(uploadLoaded ?? (size * (uploadPct ?? 0)) / 100)} / ${formatBytes(size)} (${uploadPct}%)`
                : `${uploadPct}%`
              : size > 0
                ? formatBytes(size)
                : "uploaded"}
          </div>
        </div>
      </button>
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0"
        onClick={onRemove}
        aria-label={uploading ? "cancel upload" : "remove attachment"}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
      {previewUrl && (
        <MediaPreviewer
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          url={previewUrl}
          mime={mime}
          filename={name}
          roomId={roomId}
          sourceMediaId={mediaId ?? undefined}
          onAttachAnnotations={onAttachAnnotations}
        />
      )}
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
  const isDefault = query.trim() === "";
  const resultLimit = isDefault ? ALL_EMOJI_LIST.length : limit;
  const results = React.useMemo(() => searchEmoji(query, resultLimit), [query, resultLimit]);
  if (results.length === 0) return null;

  if (isDefault) {
    const stripCols = Math.ceil(results.length / 3);
    return (
      <div className="absolute bottom-full inset-x-0 z-50 mb-2 overflow-x-auto border bg-card p-2 shadow-md">
        <div
          className="grid w-max gap-1"
          style={{ gridTemplateColumns: `repeat(${stripCols}, 2.25rem)` }}
        >
          {results.map((r, i) => (
            <button
              key={`${r.emoji}-${r.name}`}
              type="button"
              onClick={() => onPick(r.emoji)}
              className={cn(
                "inline-flex h-9 w-9 items-center justify-center border transition-colors hover:bg-accent",
                i === selectedIndex ? "border-foreground bg-accent" : "border-transparent",
              )}
              title={`:${r.name}:`}
            >
              <span className="text-lg leading-none">{r.emoji}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="absolute bottom-full inset-x-0 z-50 mb-2 grid gap-1 border bg-card p-2 shadow-md"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {results.map((r, i) => (
        <button
          key={`${r.emoji}-${r.name}`}
          type="button"
          onClick={() => onPick(r.emoji)}
          className={cn(
            "inline-flex h-9 w-full items-center justify-center border transition-colors hover:bg-accent",
            i === selectedIndex ? "border-foreground bg-accent" : "border-transparent",
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

interface AttachmentMentionCandidate {
  kind: "attachment";
  handle: string;
  name: string;
  mime: string;
  status: StagedFile["status"];
}

type ComposerMentionCandidate = MentionCandidate | AttachmentMentionCandidate;

// `@token` immediately before the caret. The lookbehind stops it firing inside
// an email ("alice@…") or any word — `@` must follow whitespace / line start.
const MENTION_RE = /(?<![\w@])@([a-z0-9_.\-]*)$/i;

function filterMentions(candidates: ComposerMentionCandidate[], query: string): ComposerMentionCandidate[] {
  const q = query.toLowerCase();
  return candidates
    .filter((c) => !q || c.handle.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .slice(0, 50);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attachmentRefsForBody(body: string, files: StagedFile[]): Record<string, unknown>[] {
  const refs: Record<string, unknown>[] = [];
  for (const file of files) {
    if (!file.mediaId) continue;
    const name = file.name.trim();
    if (!name) continue;
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=$|\\s|[.,!?;:)\\]])`, "i");
    if (!pattern.test(body)) continue;
    refs.push({
      filename: name,
      media_id: file.mediaId,
      mime: file.mime,
    });
  }
  return refs;
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
  results: ComposerMentionCandidate[];
  selectedIndex: number;
  onPick: (c: ComposerMentionCandidate) => void;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  // Keep the keyboard-highlighted row visible as the user arrows through a long
  // roster. `block: "nearest"` only scrolls when the row is out of view, so it
  // never yanks the list around unnecessarily.
  React.useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);
  if (results.length === 0) return null;
  return (
    <div
      ref={listRef}
      className="absolute bottom-full inset-x-0 z-50 mb-2 max-h-64 overflow-y-auto border bg-card p-1 shadow-md"
    >
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
          {c.kind === "attachment" ? (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center border bg-background text-muted-foreground">
              <FileIcon className="h-3.5 w-3.5" />
            </span>
          ) : (
            <IdAvatar
              seed={`${c.kind}:${c.handle}`}
              src={c.photoUrl}
              asciiSrc={c.asciiUrl}
              size={24}
              family={c.kind === "silicon" ? "silicon" : "carbon"}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-medium">{c.name}</span>{" "}
            <span className="text-muted-foreground">@{c.handle}</span>
          </span>
          <span className="label-mono shrink-0 text-[10px] text-muted-foreground">
            {c.kind === "attachment" ? c.status : c.kind}
          </span>
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
  if (ev.type === "m.image") return "photo";
  if (ev.type === "m.file") return String(c.filename ?? c.caption ?? "attachment");
  if (ev.type === "m.voice") return "voice note";
  if (ev.type === "m.remote_browser") return "Silicon Browser link";
  if (ev.type === "m.tts") return "audio";
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

/** A staged annotation set in the composer — a compact chip showing the source
 *  file + the reference codes; sent as a normal m.file/m.image reply on Send. */
function AnnotationChip({ draft, onRemove }: { draft: AnnotationDraft; onRemove: () => void }) {
  const codes = draft.annotations.map((a) => a.ref_code).filter(Boolean);
  const shown = codes.slice(0, 6).join(", ");
  const more = codes.length > 6 ? ` +${codes.length - 6}` : "";
  return (
    <div className="relative flex items-center gap-3 border bg-card px-3 py-2">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center border bg-muted text-muted-foreground">
        <PencilSimple className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <FileName name={`annotations · ${draft.sourceFilename}`} className="text-xs font-medium" />
        <div className="label-mono text-[10px] text-muted-foreground">
          {draft.annotations.length} mark{draft.annotations.length === 1 ? "" : "s"}
          {shown ? ` · ${shown}${more}` : ""}
        </div>
      </div>
      <Button size="icon" variant="ghost" className="shrink-0" onClick={onRemove} aria-label="remove annotations">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
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
  pendingAnnotationDraft,
  onAnnotationDraftConsumed,
  replyTo,
  onClearReply,
  delayTextForSilicon = false,
  onHoldStateChange,
  cancelQueuedRef,
  mentionCandidates = [],
  editingEvent = null,
  onEditComplete,
  onPersistedEdit,
  onRequestEditLast,
  restoreDraft,
  onRestoreDraftConsumed,
  onCancelHeldLast,
  sendDisabled = false,
  sendDisabledReason = "sending is disabled",
}: Props) {
  const [text, setText] = React.useState("");
  // Multiple attachments can be staged at once; each uploads in the background
  // and is sent as its own message. `xhrRefs` lets us abort a specific in-flight
  // upload when its chip is removed.
  const [attachments, setAttachments] = React.useState<StagedFile[]>(() =>
    restoreStagedAttachments(roomId),
  );
  // Mirror so `attachFiles` can read the current count without side effects in a
  // state updater (StrictMode invokes updaters twice).
  const attachmentsRef = React.useRef<StagedFile[]>([]);
  React.useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  const xhrRefs = React.useRef<Map<string, React.MutableRefObject<XMLHttpRequest | null>>>(
    new Map(),
  );
  const updateAttachment = React.useCallback((id: string, patch: Partial<StagedFile>) => {
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);
  const anyUploading = attachments.some((a) => a.status === "uploading");
  // Mirror the staged list to the room's "uploading…" presence.
  React.useEffect(() => {
    api.activity(roomId, "uploading", anyUploading).catch(() => undefined);
  }, [anyUploading, roomId]);
  // Clear the beacon if we unmount (e.g. switch rooms) mid-upload.
  React.useEffect(
    () => () => {
      api.activity(roomId, "uploading", false).catch(() => undefined);
    },
    [roomId],
  );
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
  const [editSaving, setEditSaving] = React.useState(false);
  // §6.3/§6.4 — Voice-note upload state. We surface progress + an abort
  // control during the upload, and retain the recorded blob if it fails so the
  // user can retry instead of losing the recording.
  const voiceXhrRef = React.useRef<XMLHttpRequest | null>(null);
  const [voiceUploadPct, setVoiceUploadPct] = React.useState<number | null>(null);
  const [pendingVoice, setPendingVoice] = React.useState<{
    blob: Blob;
    durationMs: number;
  } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const textRef = React.useRef(text);
  const delayedTextQueueRef = React.useRef<QueuedTextSend[]>([]);
  const delayTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftBeforeEditRef = React.useRef("");
  const editInactivityTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEditingEventIdRef = React.useRef<string | null>(null);
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
  // Tracks whether "wait 1 more minute" has extended the hold. The value isn't
  // read for the label (the flush button always reads "send now"), but the
  // setter still resets the flag across hold cycles.
  const [, setWaitExtended] = React.useState(false);
  // Bumped on an interval while the countdown runs so the banner re-renders.
  const [, setHoldTick] = React.useState(0);
  const editingClientId =
    ((editingEvent as (Event & { _clientId?: string }) | null)?._clientId ?? null);
  const editingHeld = Boolean(editingEvent?.event_id.startsWith("temp-") && editingClientId);
  const isEditing = editingEvent !== null;

  React.useEffect(() => {
    textRef.current = text;
  }, [text]);

  const setTypingActive = React.useCallback((active: boolean) => {
    typingActiveRef.current = active;
    setTypingActiveState(active);
  }, []);

  // Upload a single staged attachment in the background, updating its row by id
  // as progress comes in. The XHR ref is registered so `removeAttachment` can
  // abort it mid-flight.
  const uploadOne = React.useCallback(
    async (stage: StagedFile) => {
      const { id, file } = stage;
      if (!file) return; // restored attachment — already uploaded, nothing to do
      const ref: React.MutableRefObject<XMLHttpRequest | null> = { current: null };
      xhrRefs.current.set(id, ref);
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
          updateAttachment(id, { pct: 0, loaded: 0 });
          const form = new FormData();
          for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
          form.append("file", file);
          await xhrUpload(
            r.upload.url,
            form,
            (pct, loaded) => updateAttachment(id, { pct, loaded }),
            ref,
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
        updateAttachment(id, {
          status: "ready",
          mediaId,
          mime: file.type || "application/octet-stream",
          pct: null,
          loaded: null,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // removed
        updateAttachment(id, { status: "error", pct: null, loaded: null });
        toast.error(e instanceof ApiError ? e.message : String(e));
      } finally {
        xhrRefs.current.delete(id);
      }
    },
    [roomId, updateAttachment],
  );

  // Abort (if uploading) and drop a staged attachment.
  const removeAttachment = React.useCallback((id: string) => {
    xhrRefs.current.get(id)?.current?.abort();
    xhrRefs.current.delete(id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // §6.6 / §6.7 — Stage one or more files from the picker, a drag-drop, or a
  // paste. Each is validated, staged, and starts uploading immediately.
  const attachFiles = React.useCallback(
    (list: FileList | File[] | null | undefined) => {
      if (isEditing) {
        toast.message("finish editing before adding attachments.");
        return;
      }
      const incoming = list ? Array.from(list) : [];
      if (incoming.length === 0) return;
      const room = MAX_ATTACHMENTS - attachmentsRef.current.length;
      if (room <= 0) {
        toast.error(`up to ${MAX_ATTACHMENTS} attachments at a time.`);
        return;
      }
      const staged: StagedFile[] = [];
      for (const file of incoming) {
        if (staged.length >= room) {
          toast.message(`only the first ${MAX_ATTACHMENTS} attachments were added.`);
          break;
        }
        const err = validateFile(file);
        if (err) {
          toast.error(`${file.name}: ${err}`);
          continue;
        }
        if (isHeic(file)) {
          toast.message("HEIC photo attached as a file (browsers can't preview it inline).");
        }
        staged.push({
          id: newClientId(),
          file,
          name: file.name,
          size: file.size,
          status: "uploading",
          pct: null,
          loaded: null,
          mediaId: null,
          mime: file.type || "application/octet-stream",
        });
      }
      if (staged.length === 0) return;
      setAttachments((prev) => [...prev, ...staged]);
      staged.forEach((s) => void uploadOne(s));
    },
    [isEditing, uploadOne],
  );
  // #21 — Emoji picker triggered by `:` followed by alphanumerics. We track
  // the active token (':grin', ':lol', …) and surface matches in a small
  // popover anchored to the textarea.
  const [emojiQuery, setEmojiQuery] = React.useState<string | null>(null);
  const [emojiIdx, setEmojiIdx] = React.useState(0);
  // @-mention picker — null when inactive; otherwise the partial handle typed.
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = React.useState(0);
  const attachmentMentionCandidates = React.useMemo<AttachmentMentionCandidate[]>(
    () =>
      attachments
        .filter((a) => a.status !== "error")
        .map((a) => ({
          kind: "attachment" as const,
          handle: a.name,
          name: a.name,
          mime: a.mime,
          status: a.status,
        })),
    [attachments],
  );
  const composerMentionCandidates = React.useMemo<ComposerMentionCandidate[]>(
    () => [...attachmentMentionCandidates, ...mentionCandidates],
    [attachmentMentionCandidates, mentionCandidates],
  );
  const mentionResults = React.useMemo(
    () => (mentionQuery === null ? [] : filterMentions(composerMentionCandidates, mentionQuery)),
    [mentionQuery, composerMentionCandidates],
  );
  // Replace the `@token` immediately before the caret with `@handle ` and drop
  // the picker. Shared by keyboard (Tab/Enter) and mouse selection. Plain
  // function so it can reference `persistDraft` (declared below) lazily.
  const insertMention = (cand: ComposerMentionCandidate) => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const replaced = before.replace(MENTION_RE, `@${cand.handle} `);
    const nextText = replaced + after;
    setText(nextText);
    if (!isEditing) persistDraft(nextText);
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
      attachFiles([droppedFile]);
      onDroppedFileConsumed?.();
    }
  }, [droppedFile, onDroppedFileConsumed, attachFiles]);

  // Stage a flattened annotation set as a ready "annotations" row. Removes any
  // earlier annotation row for the same source (re-attaching replaces rather
  // than piles up) AND the plain staged file being annotated, if the source was
  // a not-yet-sent draft attachment — annotating your own outgoing file swaps it
  // for the annotated version instead of sending both.
  const stageAnnotationDraft = React.useCallback((draft: AnnotationDraft) => {
    setAttachments((prev) => {
      const withoutDupe = prev.filter(
        (a) =>
          !(a.kind === "annotations" && a.annotation?.sourceMediaId === draft.sourceMediaId) &&
          a.mediaId !== draft.sourceMediaId,
      );
      const row: StagedFile = {
        id: newClientId(),
        file: null,
        name: `annotations · ${draft.sourceFilename}`,
        size: 0,
        status: "ready",
        pct: null,
        loaded: null,
        mediaId: draft.annotatedMediaId,
        mime: draft.annotatedMime,
        kind: "annotations",
        annotation: draft,
      };
      return [...withoutDupe, row];
    });
  }, []);

  // Pull an annotation draft in from the studio (via RoomView) — same consume-
  // hint pattern as the dropped-file effect above.
  React.useEffect(() => {
    if (pendingAnnotationDraft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consume-hint prop, mirrors the droppedFile effect above
      stageAnnotationDraft(pendingAnnotationDraft);
      onAnnotationDraftConsumed?.();
    }
  }, [pendingAnnotationDraft, onAnnotationDraftConsumed, stageAnnotationDraft]);

  // Clicking "reply" on a message sets a reply target — focus the input right
  // away so the user can start typing without a second click.
  React.useEffect(() => {
    if (replyTo) taRef.current?.focus();
  }, [replyTo]);

  // ----- Draft persistence (per room, in localStorage) -----
  // Each room keeps its own in-progress draft so switching away and back — or
  // reloading — restores exactly what was being typed. The draft is removed
  // the moment the message is sent or the field is fully cleared.
  // Drafts live in a shared store (localStorage-backed) so the sidebar can show
  // a live "draft: …" preview as the user types.
  const persistDraft = React.useCallback(
    (v: string) => {
      setDraft(roomId, v);
    },
    [roomId],
  );
  // Load the room's saved draft when the active room changes. On leaving the
  // room, flush its draft to the sidebar immediately (don't wait for the typing
  // pause) so switching chats surfaces the draft right away.
  React.useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- room restore must hydrate composer before user types.
    setText(getDraft(roomId));
    setEmojiQuery(null);
    // Restore any uploaded attachments staged in this room's draft.
    setAttachments(restoreStagedAttachments(roomId));
    void loadServerDraft(roomId).then(() => {
      if (cancelled) return;
      setText(getDraft(roomId));
      setAttachments(restoreStagedAttachments(roomId));
    });
    return () => {
      cancelled = true;
      setDraftFocused(roomId, false);
      flushDraft(roomId);
    };
  }, [roomId]);

  React.useEffect(() => {
    setDraftReply(
      roomId,
      replyTo
        ? {
            event_id: replyTo.event_id,
            sender_handle: replyTo.sender_handle || undefined,
            sender_kind: replyTo.sender_kind,
            type: replyTo.type,
            preview: previewOf(replyTo),
          }
        : null,
    );
  }, [replyTo, roomId]);

  React.useEffect(() => {
    if (!restoreDraft) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (editingEvent) onEditComplete?.();
      const restoredText = restoreDraft.text;
      const restoredAttachments = (restoreDraft.attachments ?? []).map((a) => ({
        id: newClientId(),
        file: null,
        name: a.name,
        size: a.size ?? 0,
        status: "ready" as const,
        pct: null,
        loaded: null,
        mediaId: a.mediaId,
        mime: a.mime || "application/octet-stream",
      }));
      setText(restoredText);
      persistDraft(restoredText);
      setAttachments(restoredAttachments);
      setEmojiQuery(null);
      setMentionQuery(null);
      onRestoreDraftConsumed?.();
      taRef.current?.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [editingEvent, onEditComplete, onRestoreDraftConsumed, persistDraft, restoreDraft]);

  // Persist the room's uploaded attachments so a chat-switch / refresh keeps
  // them. Skip the render where roomId just changed (the effect above restores
  // there) so we never write the outgoing room's files under the new room's key.
  const persistRoomRef = React.useRef(roomId);
  React.useEffect(() => {
    if (persistRoomRef.current !== roomId) {
      persistRoomRef.current = roomId;
      return;
    }
    setDraftAttachments(
      roomId,
      attachments
        // Annotation rows aren't persisted here — their content lives in the
        // studio's autosave (annotation-session), which restores the full set.
        .filter((a) => a.status === "ready" && a.mediaId && a.kind !== "annotations")
        .map((a) => ({
          id: a.id,
          mediaId: a.mediaId as string,
          mime: a.mime,
          name: a.name,
          size: a.size,
        })),
    );
  }, [attachments, roomId]);

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
    clearDraftAfterSend(roomId);
    for (const ref of xhrRefs.current.values()) ref.current?.abort();
    xhrRefs.current.clear();
    setAttachments([]);
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

  const buildQueuedPayload = React.useCallback(
    (item: QueuedTextSend, total: number): OptimisticPayload => {
      return {
        type: "m.text",
        content: {
          body: item.body,
          hold_group_id: item.holdGroupId,
          hold_index: item.holdIndex,
          hold_count: total,
          ...(item.editedAt ? { edited_before_send: true } : {}),
        },
        reply_to_event_id: item.replyToEventId,
        edited_at: item.editedAt ?? null,
      };
    },
    [],
  );

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
      const current = delayedTextQueueRef.current;
      if (!current.some((it) => it.clientId === clientId)) return;
      const next = current
        .filter((it) => it.clientId !== clientId)
        .map((it, index) => ({ ...it, holdIndex: index }));
      delayedTextQueueRef.current = next;
      setQueuedTextCount(next.length);
      if (next.length === 0) {
        clearDelayedQueue();
      } else {
        for (const queued of next) {
          onOptimisticUpdate?.(queued.clientId, buildQueuedPayload(queued, next.length));
        }
      }
    },
    [buildQueuedPayload, clearDelayedQueue, onOptimisticUpdate],
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
      clearDelayedQueue();

      const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
      const total = items.length;
      for (const item of items) {
        const payload = buildQueuedPayload(item, total);
        const sendPayload = {
          type: payload.type,
          content: payload.content,
          reply_to_event_id: payload.reply_to_event_id,
        };
        if (outboxOwner) {
          enqueueOutbox(outboxOwner, {
            roomId,
            clientId: item.clientId,
            body: item.body,
            content: payload.content,
            replyTo: payload.reply_to_event_id,
            at: Date.now(),
          });
        }
        try {
          const real = await api.sendEvent(roomId, sendPayload, item.clientId); // §2.3
          if (outboxOwner) ackOutbox(outboxOwner, item.clientId);
          if (optimistic) onAck(item.clientId, real);
          track.messageSent({
            room_id: roomId,
            message_type: "m.text",
            is_reply: Boolean(payload.reply_to_event_id),
          });
        } catch (err) {
          if (optimistic) onFail(item.clientId, err);
          else toast.error(err instanceof ApiError ? err.message : String(err));
        }
      }
    },
    [
      buildQueuedPayload,
      clearDelayedQueue,
      onAck,
      onFail,
      roomId,
    ],
  );

  const restartDelayedFlushTimer = React.useCallback(() => {
    if (!delayedTextQueueRef.current.length) {
      clearDelayedQueue();
      return;
    }
    clearDelayTimer();
    setQueuePaused(false);
    setEmptyHoldEndsAt(null);
    setWaitExtended(false);
    onHoldStateChange?.(false);
    delayTimerRef.current = setTimeout(() => {
      delayTimerRef.current = null;
      if (hasContinuingDraft()) {
        setQueuePaused(true);
        onHoldStateChange?.(true);
      } else {
        void flushDelayedTextQueue();
      }
    }, SILICON_TEXT_SEND_DELAY_MS);
  }, [
    clearDelayedQueue,
    clearDelayTimer,
    flushDelayedTextQueue,
    hasContinuingDraft,
    onHoldStateChange,
  ]);

  const queueDelayedTextSend = React.useCallback(
    (body: string) => {
      const clientId = newClientId();
      const existingQueue = delayedTextQueueRef.current;
      const holdGroupId = existingQueue[0]?.holdGroupId ?? newClientId();
      const item: QueuedTextSend = {
        clientId,
        body,
        replyToEventId: replyTo?.event_id,
        holdGroupId,
        holdIndex: existingQueue.length,
      };
      // Append to the held burst and restart the 5s window, but keep every
      // user send as its own visible message bubble.
      delayedTextQueueRef.current = [...existingQueue, item];
      const queue = delayedTextQueueRef.current;
      setQueuedTextCount(queue.length);
      // Back to the open hold window (not "holding…") — the restarted timer
      // re-decides whether to hold once it elapses.
      setQueuePaused(false);
      onHoldStateChange?.(false);
      onOptimisticAdd(clientId, buildQueuedPayload(item, queue.length));
      for (const queued of queue) {
        onOptimisticUpdate?.(queued.clientId, buildQueuedPayload(queued, queue.length));
      }
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
      onOptimisticUpdate,
      replyTo,
    ],
  );

  const clearEditInactivityTimer = React.useCallback(() => {
    if (editInactivityTimerRef.current) {
      clearTimeout(editInactivityTimerRef.current);
      editInactivityTimerRef.current = null;
    }
  }, []);

  const finishEdit = React.useCallback(() => {
    clearEditInactivityTimer();
    setEditSaving(false);
    setEmojiQuery(null);
    setMentionQuery(null);
    const restore = draftBeforeEditRef.current;
    textRef.current = restore;
    setText(restore);
    persistDraft(restore);
    onEditComplete?.();
    queueMicrotask(() => taRef.current?.focus());
  }, [clearEditInactivityTimer, onEditComplete, persistDraft]);

  const cancelEdit = React.useCallback(() => {
    if (!editingEvent) return;
    const wasHeld = editingHeld;
    finishEdit();
    if (wasHeld) restartDelayedFlushTimer();
  }, [editingEvent, editingHeld, finishEdit, restartDelayedFlushTimer]);

  const confirmEdit = React.useCallback(async () => {
    if (!editingEvent) return;
    const original = editableTextForEvent(editingEvent);
    if (original === null) {
      finishEdit();
      return;
    }
    const nextBody = text.trim();
    if (editingEvent.type === "m.text" && !nextBody) {
      toast.error("message body is required.");
      return;
    }

    if (editingHeld && editingClientId) {
      const current = delayedTextQueueRef.current;
      const editedAt = new Date().toISOString();
      const next = current.map((item) =>
        item.clientId === editingClientId
          ? { ...item, body: nextBody, editedAt }
          : item,
      );
      delayedTextQueueRef.current = next;
      setQueuedTextCount(next.length);
      for (const queued of next) {
        onOptimisticUpdate?.(queued.clientId, buildQueuedPayload(queued, next.length));
      }
      finishEdit();
      void flushDelayedTextQueue();
      return;
    }

    if (nextBody === original.trim()) {
      finishEdit();
      return;
    }
    if (!onPersistedEdit) {
      finishEdit();
      return;
    }
    setEditSaving(true);
    try {
      await onPersistedEdit(editingEvent, nextBody);
      finishEdit();
    } catch {
      setEditSaving(false);
    }
  }, [
    buildQueuedPayload,
    editingClientId,
    editingEvent,
    editingHeld,
    finishEdit,
    flushDelayedTextQueue,
    onOptimisticUpdate,
    onPersistedEdit,
    text,
  ]);

  React.useEffect(() => {
    if (!editingEvent) {
      lastEditingEventIdRef.current = null;
      return;
    }
    const current = editableTextForEvent(editingEvent);
    if (current === null) {
      onEditComplete?.();
      return;
    }
    if (lastEditingEventIdRef.current !== editingEvent.event_id) {
      draftBeforeEditRef.current = textRef.current;
      lastEditingEventIdRef.current = editingEvent.event_id;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setText(current);
      setEmojiQuery(null);
      setMentionQuery(null);
      onClearReply?.();
      if (editingHeld) {
        clearDelayTimer();
        setQueuePaused(true);
        setEmptyHoldEndsAt(null);
        setWaitExtended(false);
        setQueuedTextCount(delayedTextQueueRef.current.length);
        onHoldStateChange?.(true);
      }
      taRef.current?.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [
    clearDelayTimer,
    editingEvent,
    editingHeld,
    onClearReply,
    onEditComplete,
    onHoldStateChange,
  ]);

  React.useEffect(() => {
    if (!editingEvent) return;
    clearEditInactivityTimer();
    editInactivityTimerRef.current = setTimeout(() => {
      void confirmEdit();
    }, EDIT_INACTIVITY_MS);
    return clearEditInactivityTimer;
  }, [clearEditInactivityTimer, confirmEdit, editingEvent, text]);

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
    if (editingHeld) {
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
  }, [editingHeld, flushDelayedTextQueue, hasContinuingDraft, queuePaused, queuedTextCount, text, typingActive]);

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
      delayedTextQueueRef.current = [];
      const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
      const total = queued.length;
      // Unmount flush is fire-and-forget — persist each text to the outbox so a
      // failure (or the page dying mid-POST) still gets retried later.
      void queued.reduce<Promise<void>>(
        (chain, item) =>
          chain.then(async () => {
            const payload = buildQueuedPayload(item, total);
            const sendPayload = {
              type: payload.type,
              content: payload.content,
              reply_to_event_id: payload.reply_to_event_id,
            };
            if (outboxOwner) {
              enqueueOutbox(outboxOwner, {
                roomId,
                clientId: item.clientId,
                body: item.body,
                content: payload.content,
                replyTo: payload.reply_to_event_id,
                at: Date.now(),
              });
            }
            try {
              await api.sendEvent(roomId, sendPayload, item.clientId);
              if (outboxOwner) ackOutbox(outboxOwner, item.clientId);
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : String(err));
            }
          }),
        Promise.resolve(),
      );
    },
    [buildQueuedPayload, clearDelayTimer, roomId],
  );

  const sendTextOptimistic = (body: string, extraContent?: Record<string, unknown>) => {
    const clientId = newClientId();
    const payload: OptimisticPayload = {
      type: "m.text",
      content: { body, ...(extraContent ?? {}) },
      reply_to_event_id: replyTo?.event_id,
    };
    onOptimisticAdd(clientId, payload);
    // Persisted outbox: enqueue BEFORE the POST, ack on success. On failure
    // the entry stays — the reconnect/mount flusher (and the failed bubble's
    // tap-to-retry) re-POSTs it with the same client id, which the server
    // dedupes. Plain-text only: extraContent (bundle_id) can't be rebuilt by
    // the flusher, so those sends keep the ephemeral path.
    const outboxOwner = extraContent ? null : (authStore.getCarbon()?.carbon_id ?? null);
    if (outboxOwner) {
      enqueueOutbox(outboxOwner, {
        roomId,
        clientId,
        body,
        replyTo: replyTo?.event_id,
        at: Date.now(),
      });
    }
    api
      .sendEvent(roomId, payload, clientId) // §2.3 — echo-match by client id
      .then((real) => {
        if (outboxOwner) ackOutbox(outboxOwner, clientId);
        onAck(clientId, real);
      })
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
    if (sendDisabled) {
      toast.message(sendDisabledReason);
      return;
    }
    if (editingEvent) {
      await confirmEdit();
      return;
    }

    let body = text.trim();

    // §7a/§7e — slash command palette (text only; a "/" with files is just text).
    if (attachments.length === 0 && body.startsWith("/")) {
      const result = runSlashCommand(body);
      if (result.handled) {
        setText("");
        clearDraftAfterSend(roomId);
        if (result.clearReply) onClearReply?.();
        return;
      }
      if (result.replaceWith !== undefined) body = result.replaceWith; // transform + send
    }

    // Attachment path — uploads already started on attach. Each ready file is
    // posted as its own message (the send button stays disabled until none are
    // still uploading), then any typed text follows as a separate message.
    if (attachments.length > 0) {
      if (anyUploading) return;
      const ready = attachments.filter((a) => a.status === "ready" && a.mediaId);
      if (ready.length === 0 && !body) return;
      setBusy(true);
      try {
        // When text rides along with attachments, tag both with a shared
        // bundle_id so the timeline can render the attachments as pins on the
        // text bubble. With no text, attachments stand alone (no bundle).
        const bundleId = body && ready.length > 0 ? newClientId() : null;
        let sentAnnotations = false;
        for (const a of ready) {
          if (a.kind === "annotations" && a.annotation) {
            // The generated annotated file → a normal m.file/m.image, reply-
            // linked to the original so the thread + silicon reference it.
            const d = a.annotation;
            const annType = d.annotatedMime.startsWith("image/") ? "m.image" : "m.file";
            await api.sendEvent(roomId, {
              type: annType,
              content: {
                media_id: d.annotatedMediaId,
                mime: d.annotatedMime,
                filename: d.annotatedName,
                ...(bundleId ? { bundle_id: bundleId } : {}),
              },
              ...(d.sourceEventId ? { reply_to_event_id: d.sourceEventId } : {}),
            });
            clearAnnotationSession(roomId, d.sourceMediaId);
            sentAnnotations = true;
            track.messageSent({ room_id: roomId, message_type: annType, has_attachment: true });
            continue;
          }
          const fileType = a.mime.startsWith("image/") ? "m.image" : "m.file";
          await api.sendEvent(roomId, {
            type: fileType,
            content: {
              media_id: a.mediaId,
              mime: a.mime,
              filename: a.name,
              ...(bundleId ? { bundle_id: bundleId } : {}),
            },
          });
          track.messageSent({ room_id: roomId, message_type: fileType, has_attachment: true });
        }
        reset();
        // An attached annotation set carried the reply to the file — clear it so
        // the next message isn't unexpectedly a reply (unless text handles it).
        if (sentAnnotations && !body) onClearReply?.();
        // Typed text rides as a *separate* message after the attachments,
        // carrying the same bundle_id so they render together. If the user
        // typed @filename references, persist the resolved attachment ids too.
        if (body) {
          const attachmentRefs = attachmentRefsForBody(body, ready);
          const extraContent = {
            ...(bundleId ? { bundle_id: bundleId } : {}),
            ...(attachmentRefs.length > 0 ? { attachment_refs: attachmentRefs } : {}),
          };
          sendTextOptimistic(
            body,
            Object.keys(extraContent).length > 0 ? extraContent : undefined,
          );
        }
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
      // Every send (first or follow-up) enters the hold: it merges into the
      // held batch and restarts the 5s window. The batch goes out once the
      // window elapses with no new send / typing, or via "send now".
      queueDelayedTextSend(body);
      setText("");
      clearDraftAfterSend(roomId);
      return;
    }
    sendTextOptimistic(body);
    setText("");
    clearDraftAfterSend(roomId);
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
      reply_to_event_id: replyTo?.event_id,
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
            reply_to_event_id: replyTo?.event_id,
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
          reply_to_event_id: replyTo?.event_id,
        },
        clientId, // §2.3
      );
      onAck(clientId, real);
      onClearReply?.();
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
      {editingEvent && (
        <div className="flex items-center gap-2 border-l-2 border-foreground/60 bg-card px-2 py-1 text-xs">
          <PencilSimple className="h-3.5 w-3.5 shrink-0 opacity-60" />
          <div className="min-w-0 flex-1">
            <div className="label-mono text-[10px] opacity-60">
              {editingHeld ? "editing held message" : "editing message"}
            </div>
            <div className="truncate text-foreground/80">
              {editingEvent.sender_handle ? `@${editingEvent.sender_handle}` : "message"}
            </div>
          </div>
          <button
            type="button"
            onClick={cancelEdit}
            aria-label="cancel edit"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        // Inset to line up with the text box (past the 44px attach/send buttons
        // + 8px gap on each side), so attachments are as wide as the chat box.
        // Capped height with scroll so a big batch of files doesn't push the
        // composer (and the conversation) off-screen.
        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto px-[52px]">
          {attachments.map((a) =>
            a.kind === "annotations" && a.annotation ? (
              <AnnotationChip
                key={a.id}
                draft={a.annotation}
                onRemove={() => removeAttachment(a.id)}
              />
            ) : (
              <StagedAttachment
                key={a.id}
                file={a.file}
                name={a.name}
                size={a.size}
                mime={a.mime}
                mediaId={a.mediaId}
                uploadPct={a.status === "uploading" ? (a.pct ?? 0) : null}
                uploadLoaded={a.loaded}
                onRemove={() => removeAttachment(a.id)}
                roomId={roomId}
                onAttachAnnotations={stageAnnotationDraft}
              />
            ),
          )}
        </div>
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
                  send now
                </button>
              </div>
            </>
          ) : (
            // Still typing — hold open-endedly until they finish.
            <>
              <span className="min-w-0">
                {editingHeld
                  ? "holding this message until you finish editing."
                  : "holding the message until you finish typing."}
              </span>
              {!editingHeld && (
                <button
                  type="button"
                  onClick={() => void flushDelayedTextQueue()}
                  className="shrink-0 text-xs font-medium text-foreground underline-offset-2 hover:underline"
                >
                  send now
                </button>
              )}
            </>
          )}
        </div>
      )}
      {/* Live markdown preview — appears once the draft contains markdown, so
          you can see how it'll render as you write it. */}
      {looksLikeMarkdown(text) && (
        <div className="border bg-card">
          <div className="label-mono border-b px-2 py-1 text-[10px] text-muted-foreground">
            markdown preview
          </div>
          <div className="max-h-40 overflow-y-auto px-3 py-2">
            <MarkdownView source={text} />
          </div>
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
            attachFiles(e.target.files);
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
          disabled={busy || isEditing}
          className="flex h-11 w-11 shrink-0 items-center justify-center border border-input text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Paperclip />
        </button>
        <div className="relative flex min-h-11 min-w-0 flex-1 items-center border border-input transition-colors focus-within:border-ring">
          <textarea
            ref={taRef}
            autoFocus
            value={text}
            onFocus={() => setDraftFocused(roomId, true)}
            onBlur={() => {
              setDraftFocused(roomId, false);
              flushDraft(roomId);
            }}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              if (!isEditing) persistDraft(v);
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
              // `@handle` autocomplete for people and staged attachments.
              const at = upTo.match(MENTION_RE);
              if (at && composerMentionCandidates.length > 0) {
                setMentionQuery(at[1] ?? "");
                setMentionIdx(0);
              } else {
                setMentionQuery(null);
              }
            }}
            placeholder={isEditing ? "edit message…" : "message…"}
            rows={MIN_ROWS}
            className="w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
            onPaste={(e) => {
              // Paste a screenshot (or any file) to attach it. We only consume
              // the event when the clipboard actually carries a file — a normal
              // text paste falls through to the default behavior untouched.
              const items = e.clipboardData?.files;
              if (items && items.length > 0) {
                e.preventDefault();
                if (isEditing) {
                  toast.message("finish editing before adding attachments.");
                  return;
                }
                attachFiles(items);
              }
            }}
            onKeyDown={(e) => {
              // §6.8 — Suppress all of the picker/send key handling while an
              // IME is composing so a composition-commit Enter doesn't pick an
              // emoji or send.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              // @-mention picker — a vertical list: ↑/↓ move (wrapping around at
              // the ends), Tab/Enter insert, Esc dismisses. Takes the keys
              // before the emoji/send handling.
              if (mentionQuery !== null && mentionResults.length > 0) {
                const n = mentionResults.length;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIdx((i) => (i + 1) % n);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIdx((i) => (i - 1 + n) % n);
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
                const isDefaultEmojiQuery = emojiQuery.trim() === "";
                const results = searchEmoji(emojiQuery, isDefaultEmojiQuery ? ALL_EMOJI_LIST.length : emojiLimit);
                const n = results.length;
                const navCols = isDefaultEmojiQuery ? Math.ceil(n / 3) : emojiCols;
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
                  setEmojiIdx((i) => Math.min(i + navCols, n - 1));
                  return;
                }
                if (n > 0 && e.key === "ArrowUp") {
                  e.preventDefault();
                  setEmojiIdx((i) => Math.max(0, i - navCols));
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
                    if (!isEditing) persistDraft(nextText);
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
              if (
                e.ctrlKey &&
                !e.metaKey &&
                !e.altKey &&
                e.key.toLowerCase() === "c" &&
                !text.trim() &&
                attachments.length === 0 &&
                onCancelHeldLast
              ) {
                e.preventDefault();
                onCancelHeldLast();
                return;
              }
              if (
                e.key === "ArrowUp" &&
                !isEditing &&
                !text.trim() &&
                attachments.length === 0 &&
                !replyTo &&
                onRequestEditLast
              ) {
                e.preventDefault();
                onRequestEditLast();
                return;
              }
              if (e.key === "Escape" && isEditing) {
                e.preventDefault();
                cancelEdit();
                return;
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
                if (sendDisabled) {
                  toast.message(sendDisabledReason);
                  return;
                }
                send();
              }
            }}
          />
        </div>
        {!isEditing && !text.trim() && attachments.length === 0 ? (
          <button
            type="button"
            onClick={() => {
              setRecording(true);
              api.activity(roomId, "recording", true).catch(() => undefined);
            }}
            disabled={busy || sendDisabled}
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
            disabled={
              sendDisabled ||
              busy ||
              editSaving ||
              anyUploading ||
              (isEditing && editingEvent?.type === "m.text" && !text.trim())
            }
            aria-label={isEditing ? "save edit" : "send"}
            className="flex h-11 w-11 shrink-0 items-center justify-center border border-input bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy || editSaving || anyUploading ? (
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
              if (!isEditing) persistDraft(replaced + after);
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
    </div>
  );
}
