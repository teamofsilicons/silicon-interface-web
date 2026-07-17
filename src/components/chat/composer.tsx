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
  Smiley,
  X,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { authStore } from "@/lib/auth";
import {
  ackOutbox,
  enqueueOutbox,
  listOutbox,
  type OutboxEntry,
} from "@/lib/outbox";
import {
  getHeldCancellation,
  maySendHeldOutbox,
  reconcileHeldCancellation,
  requestHeldCancellation,
  withOutboxClientLock,
} from "@/lib/held-cancellation";
import {
  ABUSE_CHALLENGE_SOLVED_EVENT,
  challengeFromErrorBody,
} from "@/lib/abuse-challenge-store";
import {
  classifyOutboxFailure,
  persistHeldOutboxState,
  persistOutboxFailure,
  wakeOutboxRecovery,
} from "@/lib/outbox-recovery";
import { track } from "@/lib/analytics";
import { ALL_EMOJI_LIST, searchEmoji } from "@/lib/emoji";
import { emojiShortcodeQuery } from "@/lib/emoji-shortcode";
import { computePeaks, isGifMedia, measureImage, measureVideo } from "@/lib/media-meta";
import { uploadMediaResumable } from "@/lib/media-upload";
import {
  acknowledgeMediaSend,
  ensureMediaOutboxStaged,
  journalRemoteGifIntent,
  MEDIA_OUTBOX_ACKNOWLEDGED_EVENT,
  MEDIA_OUTBOX_STAGED_EVENT,
  prepareMediaOutboxPayload,
  stageMediaSendIntent,
} from "@/lib/media-send";
import {
  listRoomMediaUploads,
  patchMediaUpload,
  readMediaUpload,
  removeMediaUpload,
} from "@/lib/media-upload-store";
import {
  clearDraftAfterSend,
  DRAFT_DURABILITY_BLOCKED_EVENT,
  flushDraft,
  getDraftComposerState,
  hydrateDraftJournal,
  loadServerDraft,
  retryLocalDraftPersistence,
  retryDraftSync,
  setDraft,
  setDraftFocused,
  setDraftSelection,
  useDraft,
  useDraftSyncStatus,
  type DraftSelectionDirection,
} from "@/lib/drafts";
import {
  COMPOSER_SELECTION_COMMIT_DELAY_MS,
  mayPersistComposerSelection,
  mayRestoreComposerSnapshot,
} from "@/lib/composer-selection";
import { getDraftAttachments, setDraftAttachments } from "@/lib/draft-attachments";
import {
  clearVoiceDraft,
  getVoiceDraft,
  saveVoiceDraft,
  type VoiceDraft,
} from "@/lib/voice-drafts";
import {
  useVoiceRecordingSession,
  voiceRecordingSession,
} from "@/lib/voice-recording-session";
import { editableTextForEvent } from "@/lib/event-edit";
import { clearAnnotationSession } from "@/lib/annotation-session";
import {
  MAX_COMPOSER_ATTACHMENTS,
  planAttachmentBatch,
} from "@/lib/attachment-batch";
import {
  buildMentionLookup,
  mentionClassName,
  splitMentionText,
} from "@/lib/mentions";
import type { AnnotationDraft, Event, EventType, HeldSend } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VoiceRecorder } from "@/components/chat/voice-recorder";
import { ComposerExpressionPicker } from "@/components/chat/expression-picker";
import { SiliconAudio } from "@/components/chat/silicon-audio";
import {
  SILICON_TEXT_HOLD_MS,
  SILICON_TEXT_HOLD_SECONDS,
  siliconHoldReleaseAt,
} from "@/lib/silicon-hold";
import { FileName } from "@/components/chat/file-name";
import { MarkdownView } from "@/components/chat/markdown-view";
import { MediaPreviewer } from "@/components/chat/media-previewer";
import { looksLikeMarkdown } from "@/lib/markdown";
import { IdAvatar } from "@/components/profile/id-avatar";
import { sendTimeoutMs } from "@/lib/send-timeout";
import type { GifResult } from "@/lib/giphy";
import { albumMediaIdsOwnedByOutbox, buildAlbumContent } from "@/lib/albums";
import {
  composerEnterAction,
  readComposerEnterBehavior,
  subscribeComposerEnterBehavior,
  type ComposerEnterBehavior,
} from "@/lib/composer-preferences";


/** Slice of an `Event` we can fabricate locally before the server responds. */
export interface OptimisticPayload {
  type: EventType;
  content?: Record<string, unknown>;
  reply_to_event_id?: string;
  edited_at?: string | null;
}

/** Explicit recovery action payload. This is intentionally separate from
 * unsend: deleting a message must never create one of these. */
export interface ComposerCopyAttachment {
  mediaId: string;
  mime: string;
  name: string;
  size?: number;
}

export interface ComposerCopyDraft {
  id: string;
  text: string;
  attachments?: ComposerCopyAttachment[];
}

export type CancelQueuedResult =
  | "cancelled"
  | "pending"
  | "sent"
  | "not-held"
  | "failed";

function SavedVoicePlayer({ draft }: { draft: VoiceDraft }) {
  const [url] = React.useState(() => URL.createObjectURL(draft.blob));
  const [peaks, setPeaks] = React.useState<number[] | null>(null);
  React.useEffect(() => () => URL.revokeObjectURL(url), [url]);
  React.useEffect(() => {
    let alive = true;
    void computePeaks(draft.blob).then((result) => {
      if (alive && result) setPeaks(result.peaks);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [draft.blob]);
  return (
    <SiliconAudio
      url={url}
      peaks={peaks}
      durationMs={draft.durationMs}
      className="w-full max-w-[22rem]"
    />
  );
}

interface Props {
  roomId: string;
  /**
   * Called the instant the user presses send, before any network roundtrip,
   * so the parent can insert a "pending" placeholder bubble.
   */
  onOptimisticAdd: (
    clientId: string,
    payload: OptimisticPayload,
    options?: { timeoutMs?: number },
  ) => void;
  /** Server acked the POST — swap the optimistic placeholder for the real event. */
  onAck: (clientId: string, real: Event) => void;
  /** POST failed — mark the optimistic placeholder as failed. */
  onFail: (clientId: string, error: unknown) => void;
  /** Update a local pending bubble before the server has acked it. */
  onOptimisticUpdate?: (clientId: string, payload: OptimisticPayload) => void;
  /** Files dropped onto the chat surface get handed in here as one ordered batch. */
  droppedFiles?: readonly File[] | null;
  onDroppedFilesConsumed?: () => void;
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
  cancelQueuedRef?: React.MutableRefObject<
    ((clientId: string) => Promise<CancelQueuedResult>) | null
  >;
  /** Parent calls this when the server reports a held send terminal state. */
  clearHeldClientRef?: React.MutableRefObject<((clientId: string) => void) | null>;
  /** Project a direct held-send response without waiting for a second socket or
   * history round trip to reconcile its optimistic row. */
  onHeldSendUpdate?: (held: HeldSend) => void;
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
  /** Explicit “copy to composer” recovery action; never populated by unsend. */
  copyDraft?: ComposerCopyDraft | null;
  onComposerCopyConsumed?: () => void;
  /** Keyboard path for cancelling the latest held message. */
  onCancelHeldLast?: () => void;
  /** Keep draft editing available while blocking new sends. */
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  /** The composer changed the amount of vertical space available to chat. */
  onLayoutChange?: () => void;
}

// Composer height bounds, in line-heights. Single line by default, expands
// up to twelve before the textarea starts scrolling internally.
const MIN_ROWS = 1;
const MAX_ROWS = 12;

// Emoji quick-picker is a fixed grid so keyboard nav is true 2-D: ←/→ move one
// cell, ↑/↓ move a whole row (EMOJI_COLS cells).
const EMOJI_COLS = 8; // minimum / fallback column count; actual count tracks bar width
// Once a held silicon message is paused (you kept typing past the 5s mark),
// emptying the input must NOT fire the send instantly — wait at least this long
// after the box goes empty, so a quick clear/send of a follow-up doesn't
// prematurely flush the held message.
const SILICON_EMPTY_HOLD_MS = SILICON_TEXT_HOLD_MS;
const CONTINUING_DRAFT_MIN_CHARS = 2;
const EDIT_INACTIVITY_MS = 60_000;
// Cap concurrent staged attachments so a stray multi-select can't queue hundreds.

interface QueuedTextSend {
  clientId: string;
  body: string;
  replyToEventId?: string;
  holdGroupId: string;
  holdIndex: number;
  releaseAt: string;
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
  failed = false,
  onRetry,
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
  /** The upload exceeded its deadline or errored and can be attempted again. */
  failed?: boolean;
  onRetry?: () => void;
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
            {failed
              ? "upload failed"
              : uploading
              ? size > 0
                ? `${formatBytes(uploadLoaded ?? (size * (uploadPct ?? 0)) / 100)} / ${formatBytes(size)} (${uploadPct}%)`
                : `${uploadPct}%`
              : size > 0
                ? formatBytes(size)
                : "uploaded"}
          </div>
        </div>
      </button>
      {failed && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 text-xs font-medium text-destructive underline-offset-2 hover:underline"
        >
          retry
        </button>
      )}
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
                i === selectedIndex
                  ? "border-foreground bg-foreground/30 shadow-inner"
                  : "border-transparent",
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
            i === selectedIndex
              ? "border-foreground bg-foreground/30 shadow-inner"
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
  if (ev.redacted_at) return "deleted message";
  const c = ev.content as Record<string, unknown>;
  if (ev.type === "m.text") {
    const body = String(c.body ?? "");
    return body.length > 80 ? `${body.slice(0, 80)}…` : body;
  }
  if (ev.type === "m.image") {
    return isGifMedia(c.mime, c.filename) ? "GIF" : "photo";
  }
  if (ev.type === "m.file") return String(c.filename ?? c.caption ?? "attachment");
  if (ev.type === "m.album") {
    return String(c.caption ?? "attachments");
  }
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
  droppedFiles,
  onDroppedFilesConsumed,
  pendingAnnotationDraft,
  onAnnotationDraftConsumed,
  replyTo,
  onClearReply,
  delayTextForSilicon = false,
  onHoldStateChange,
  cancelQueuedRef,
  clearHeldClientRef,
  onHeldSendUpdate,
  mentionCandidates = [],
  editingEvent = null,
  onEditComplete,
  onPersistedEdit,
  onRequestEditLast,
  copyDraft,
  onComposerCopyConsumed,
  onCancelHeldLast,
  sendDisabled = false,
  sendDisabledReason = "sending is disabled",
  onLayoutChange,
}: Props) {
  const [text, setText] = React.useState("");
  const enterBehavior: ComposerEnterBehavior = React.useSyncExternalStore(
    subscribeComposerEnterBehavior,
    readComposerEnterBehavior,
    (): ComposerEnterBehavior => "send",
  );
  const publishedDraftText = useDraft(roomId);
  const draftSync = useDraftSyncStatus(roomId);
  const localDraftUnsafe =
    draftSync.localDurabilityPending || Boolean(draftSync.localDurabilityError);
  const [composerAnnouncement, setComposerAnnouncement] = React.useState("");
  const annotationFeedbackRef = React.useRef(new Map<string, string>());
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
  const uploadAbortRefs = React.useRef<Map<string, AbortController>>(new Map());
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
  // MediaRecorder is browser-tab-wide rather than Composer-owned, so a keyed
  // RoomView remount cannot interrupt a voice note when the user changes chat.
  const voiceSession = useVoiceRecordingSession();
  const recordingActive = voiceSession.phase !== "idle";
  const [busy, setBusy] = React.useState(false);
  const [expressionPickerOpen, setExpressionPickerOpen] = React.useState(false);
  const gifUploadsInFlightRef = React.useRef(0);
  const gifAcquisitionsInFlightRef = React.useRef(new Set<string>());
  const [gifAcquisitions, setGifAcquisitions] = React.useState<
    Array<{ entry: OutboxEntry; error?: string }>
  >([]);
  const [editSaving, setEditSaving] = React.useState(false);
  // The durable outbox is the sole network owner for finalized voice notes.
  // Running a second composer uploader here raced upload completion and could
  // turn an already accepted note into a visible failure.
  const [pendingVoice, setPendingVoice] = React.useState<VoiceDraft | null>(null);
  const voiceLocalUrlsRef = React.useRef(new Map<string, string>());
  React.useEffect(() => () => {
    for (const url of voiceLocalUrlsRef.current.values()) URL.revokeObjectURL(url);
    voiceLocalUrlsRef.current.clear();
  }, [roomId]);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const textRef = React.useRef(text);
  const composerInteractionEpochRef = React.useRef(0);
  const applyingComposerSnapshotRef = React.useRef(true);
  const pendingComposerRestoreRef = React.useRef<{
    roomId: string;
    text: string;
    start: number;
    end: number;
    direction: DraftSelectionDirection;
    expectedInteractionEpoch?: number;
  } | null>(null);
  const noteComposerInteraction = React.useCallback(() => {
    pendingComposerRestoreRef.current = null;
    applyingComposerSnapshotRef.current = false;
    composerInteractionEpochRef.current += 1;
  }, []);
  const pendingDraftSelectionRef = React.useRef<{
    roomId: string;
    start: number;
    end: number;
    direction: DraftSelectionDirection;
  } | null>(null);
  const draftSelectionTimerRef = React.useRef<number | null>(null);
  const delayedTextQueueRef = React.useRef<QueuedTextSend[]>([]);
  const heldIntentsRef = React.useRef<Map<string, QueuedTextSend>>(new Map());
  const heldSendIdsRef = React.useRef<Map<string, string>>(new Map());
  const heldSendsRef = React.useRef<Map<string, HeldSend>>(new Map());
  const cancelledHeldClientIdsRef = React.useRef<Set<string>>(new Set());
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
  const editingClientId =
    ((editingEvent as (Event & { _clientId?: string }) | null)?._clientId ?? null);
  const editingHeld = Boolean(editingEvent?.event_id.startsWith("temp-") && editingClientId);
  const isEditing = editingEvent !== null;

  const commitPendingDraftSelection = React.useCallback(() => {
    if (draftSelectionTimerRef.current) {
      window.clearTimeout(draftSelectionTimerRef.current);
      draftSelectionTimerRef.current = null;
    }
    const pending = pendingDraftSelectionRef.current;
    pendingDraftSelectionRef.current = null;
    if (!pending) return;
    setDraftSelection(
      pending.roomId,
      pending.start,
      pending.end,
      pending.direction,
    );
  }, []);
  const persistComposerSelection = React.useCallback(
    (textarea: HTMLTextAreaElement, immediate = false) => {
      if (!mayPersistComposerSelection(isEditing, applyingComposerSnapshotRef.current)) return;
      pendingDraftSelectionRef.current = {
        roomId,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        direction: textarea.selectionDirection as DraftSelectionDirection,
      };
      if (immediate) {
        commitPendingDraftSelection();
        return;
      }
      // Native selection emits many `select` events during a mouse/touch drag.
      // Writing localStorage + IndexedDB for every intermediate pixel makes the
      // handles visibly stutter. Keep the latest range in memory and durably
      // checkpoint it after the gesture settles (pointer/key up flushes now).
      if (draftSelectionTimerRef.current) {
        window.clearTimeout(draftSelectionTimerRef.current);
      }
      draftSelectionTimerRef.current = window.setTimeout(
        commitPendingDraftSelection,
        COMPOSER_SELECTION_COMMIT_DELAY_MS,
      );
    },
    [commitPendingDraftSelection, isEditing, roomId],
  );

  React.useEffect(() => () => {
    commitPendingDraftSelection();
  }, [commitPendingDraftSelection, roomId]);

  React.useEffect(() => {
    textRef.current = text;
  }, [text]);

  const applyPendingComposerRestore = React.useCallback(() => {
    const pending = pendingComposerRestoreRef.current;
    if (!pending) return;
    if (
      pending.roomId !== roomId ||
      !mayRestoreComposerSnapshot(
        pending.expectedInteractionEpoch,
        composerInteractionEpochRef.current,
      )
    ) {
      pendingComposerRestoreRef.current = null;
      applyingComposerSnapshotRef.current = false;
      return;
    }
    const textarea = taRef.current;
    // A changed controlled value is committed on the next React layout pass.
    // Keep the restore guard raised until that exact value is in the DOM.
    if (!textarea || textarea.value !== pending.text) return;
    const start = Math.min(pending.start, textarea.value.length);
    const end = Math.max(start, Math.min(pending.end, textarea.value.length));
    textarea.setSelectionRange(start, end, pending.direction);
    pendingComposerRestoreRef.current = null;
    applyingComposerSnapshotRef.current = false;
  }, [roomId]);

  const restoreComposerSnapshot = React.useCallback(
    (targetRoomId: string, expectedInteractionEpoch?: number) => {
      if (!mayRestoreComposerSnapshot(
        expectedInteractionEpoch,
        composerInteractionEpochRef.current,
      )) {
        return;
      }
      const snapshot = getDraftComposerState(targetRoomId);
      applyingComposerSnapshotRef.current = true;
      pendingComposerRestoreRef.current = {
        roomId: targetRoomId,
        text: snapshot.text,
        start: snapshot.selectionStart,
        end: snapshot.selectionEnd,
        direction: snapshot.selectionDirection,
        expectedInteractionEpoch,
      };
      setText(snapshot.text);
      applyPendingComposerRestore();
    },
    [applyPendingComposerRestore],
  );

  // React owns the textarea value, so selection restoration belongs in the
  // same pre-paint layout phase as that value commit. This also prevents the
  // initial autoFocus event from overwriting a saved range with 0..0.
  React.useLayoutEffect(() => {
    applyPendingComposerRestore();
  }, [applyPendingComposerRestore, recordingActive, text]);

  React.useLayoutEffect(() => {
    applyingComposerSnapshotRef.current = true;
    restoreComposerSnapshot(roomId);
  }, [restoreComposerSnapshot, roomId]);

  // Realtime cloud updates flow into the same composer state without a dialog.
  // A dirty local draft remains authoritative in drafts.ts, so only a clean
  // adopted projection can replace the visible textarea here.
  React.useEffect(() => {
    if (
      isEditing ||
      draftSync.dirty ||
      publishedDraftText === textRef.current
    ) {
      return;
    }
    restoreComposerSnapshot(roomId);
  }, [
    draftSync.dirty,
    isEditing,
    publishedDraftText,
    restoreComposerSnapshot,
    roomId,
  ]);

  React.useEffect(() => {
    const focusDurabilityWarning = (event: globalThis.Event) => {
      const blockedRoom = (
        event as CustomEvent<{ roomId?: string | null }>
      ).detail?.roomId;
      if (blockedRoom && blockedRoom !== roomId) return;
      setComposerAnnouncement(
        "Draft navigation blocked until this device saves the composer locally.",
      );
      taRef.current?.focus();
    };
    window.addEventListener(DRAFT_DURABILITY_BLOCKED_EVENT, focusDurabilityWarning);
    return () =>
      window.removeEventListener(DRAFT_DURABILITY_BLOCKED_EVENT, focusDurabilityWarning);
  }, [roomId]);

  React.useEffect(() => {
    const onStaged = (event: globalThis.Event) => {
      const detail = (event as CustomEvent<{ entry?: OutboxEntry }>).detail;
      const entry = detail?.entry;
      if (!entry || entry.roomId !== roomId) return;
      setGifAcquisitions((current) =>
        current.map((item) =>
          item.entry.clientId === entry.clientId ? { entry } : item,
        ),
      );
    };
    const onAcknowledged = (event: globalThis.Event) => {
      const clientId = (event as CustomEvent<{ clientId?: string }>).detail?.clientId;
      if (!clientId) return;
      setGifAcquisitions((current) =>
        current.filter((item) => item.entry.clientId !== clientId),
      );
      const localUrl = voiceLocalUrlsRef.current.get(clientId);
      if (localUrl) {
        URL.revokeObjectURL(localUrl);
        voiceLocalUrlsRef.current.delete(clientId);
      }
      void getVoiceDraft(roomId).then((draft) => {
        if (draft?.clientId !== clientId) return;
        setPendingVoice((current) => current?.clientId === clientId ? null : current);
        return clearVoiceDraft(roomId);
      }).catch(() => undefined);
    };
    window.addEventListener(MEDIA_OUTBOX_STAGED_EVENT, onStaged);
    window.addEventListener(MEDIA_OUTBOX_ACKNOWLEDGED_EVENT, onAcknowledged);
    return () => {
      window.removeEventListener(MEDIA_OUTBOX_STAGED_EVENT, onStaged);
      window.removeEventListener(MEDIA_OUTBOX_ACKNOWLEDGED_EVENT, onAcknowledged);
    };
  }, [roomId]);

  // Recover a finalized voice note retained after a failed upload/reload.
  React.useEffect(() => {
    let alive = true;
    const owner = authStore.getCarbon()?.carbon_id;
    void Promise.all([
      getVoiceDraft(roomId),
      owner ? listOutbox(owner) : Promise.resolve([]),
    ]).then(([draft, outbox]) => {
      if (!alive || !draft) return;
      // A matching outbox row already renders in the timeline and owns its
      // retry/discard controls. Never duplicate it as a saved composer row.
      const staged = outbox.some(
        (entry) => entry.roomId === roomId && entry.clientId === draft.clientId,
      );
      if (!staged) setPendingVoice(draft);
    });
    return () => {
      alive = false;
    };
  }, [roomId]);

  // A GIF click is journaled before its external source fetch. Restore those
  // acquiring intents as actionable composer chips after a kill/reload; they
  // are intentionally not rendered as sent timeline bubbles yet.
  React.useEffect(() => {
    let alive = true;
    const owner = authStore.getCarbon()?.carbon_id;
    if (!owner) {
      return () => {
        alive = false;
      };
    }
    const refresh = () => {
      void listOutbox(owner).then((rows) => {
        if (!alive) return;
        setGifAcquisitions(
          rows
            .filter(
              (row) =>
                row.roomId === roomId &&
                row.operation === "media" &&
                row.media?.phase === "acquiring" &&
                row.media.acquisition?.provider === "giphy",
            )
            .map((entry) => ({ entry, error: entry.lastError })),
        );
      }).catch(() => undefined);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith("silicon-interface:outbox:v2:")) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    return () => {
      alive = false;
      window.removeEventListener("storage", onStorage);
    };
  }, [roomId]);

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
      const abortController = new AbortController();
      xhrRefs.current.set(id, ref);
      uploadAbortRefs.current.set(id, abortController);
      try {
        updateAttachment(id, { pct: 0, loaded: 0 });
        const mime = file.type || "application/octet-stream";
        const mediaId = await uploadMediaResumable({
          clientId: id,
          file,
          mime,
          kind: file.type.startsWith("image/") ? "image" : "file",
          filename: file.name,
          roomId,
          onProgress: (pct, loaded) => updateAttachment(id, { pct, loaded }),
          xhrRef: ref,
          signal: abortController.signal,
        });
        updateAttachment(id, {
          status: "ready",
          mediaId,
          mime,
          pct: null,
          loaded: null,
        });
        void (async () => {
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
          if (Object.keys(meta).length) await api.mediaComplete(mediaId, meta);
        })().catch(() => undefined);
      } catch (e) {
        if (abortController.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
          return; // user removed the attachment
        }
        updateAttachment(id, { status: "error", pct: null, loaded: null });
        toast.error(e instanceof ApiError ? e.message : String(e));
      } finally {
        xhrRefs.current.delete(id);
        uploadAbortRefs.current.delete(id);
      }
    },
    [roomId, updateAttachment],
  );

  // Abort (if uploading) and drop a staged attachment.
  const removeAttachment = React.useCallback((id: string) => {
    uploadAbortRefs.current.get(id)?.abort();
    uploadAbortRefs.current.delete(id);
    xhrRefs.current.get(id)?.current?.abort();
    xhrRefs.current.delete(id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    const carbonId = authStore.getCarbon()?.carbon_id;
    if (carbonId) {
      const owner = `carbon:${carbonId}`;
      void readMediaUpload(owner, id).then(async (row) => {
        if (row?.sessionId && row.state !== "completed") {
          await api.cancelMultipartUpload(row.sessionId).catch(() => undefined);
        }
        await removeMediaUpload(owner, id).catch(() => undefined);
      });
    }
  }, []);

  const retryAttachment = React.useCallback(
    (id: string) => {
      const stage = attachmentsRef.current.find((item) => item.id === id);
      if (!stage?.file || stage.status !== "error") return;
      const retrying = { ...stage, status: "uploading" as const, pct: null, loaded: null };
      setAttachments((prev) => prev.map((item) => (item.id === id ? retrying : item)));
      void uploadOne(retrying);
    },
    [uploadOne],
  );

  React.useEffect(() => {
    const resume = () => {
      for (const item of attachmentsRef.current) {
        if (item.status === "error") retryAttachment(item.id);
      }
    };
    window.addEventListener(ABUSE_CHALLENGE_SOLVED_EVENT, resume);
    return () => window.removeEventListener(ABUSE_CHALLENGE_SOLVED_EVENT, resume);
  }, [retryAttachment]);

  // Stage one or more files from the picker, a drag-drop, or a paste. Selection
  // goes straight into the upload path; Glass remains the authority for any
  // storage or processing constraints.
  const attachFiles = React.useCallback(
    (list: FileList | File[] | null | undefined) => {
      if (isEditing) {
        toast.message("finish editing before adding attachments.");
        return;
      }
      const batch = planAttachmentBatch(list, attachmentsRef.current.length);
      if (batch.accepted.length === 0) {
        if (batch.rejected > 0) {
          toast.error(`up to ${MAX_COMPOSER_ATTACHMENTS} attachments at a time.`);
        }
        return;
      }
      const staged: StagedFile[] = [];
      for (const file of batch.accepted) {
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
      if (batch.rejected > 0) {
        toast.message(`up to ${MAX_COMPOSER_ATTACHMENTS} attachments at a time.`);
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
  const [mentionInputComposing, setMentionInputComposing] = React.useState(false);
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
  const mentionInputLookup = React.useMemo(
    () => buildMentionLookup(mentionCandidates),
    [mentionCandidates],
  );
  const mentionInputPieces = React.useMemo(
    () => splitMentionText(text, mentionInputLookup),
    [mentionInputLookup, text],
  );
  const mentionMirrorRef = React.useRef<HTMLDivElement>(null);
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
    const nextCaret = replaced.length;
    setText(nextText);
    if (!isEditing) {
      persistDraft(nextText, { start: nextCaret, end: nextCaret, direction: "none" });
    }
    setMentionQuery(null);
    queueMicrotask(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = nextCaret;
    });
  };
  // Shared by the explicit Emoji/GIF picker and the `:shortcode` autocomplete.
  // The textarea keeps its selection while the popover owns focus, so an emoji
  // lands exactly where the user left the caret without disturbing attachments,
  // reply state, or the rest of the existing draft.
  const insertEmoji = (emoji: string, replaceShortcode = false) => {
    const current = textRef.current;
    const el = taRef.current;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? start;
    const before = current.slice(0, start);
    const prefix = replaceShortcode
      ? before.replace(/:([a-z0-9_+\-]*)$/i, emoji)
      : `${before}${emoji}`;
    const nextText = prefix + current.slice(end);
    const nextCaret = prefix.length;
    textRef.current = nextText;
    setText(nextText);
    if (!isEditing) {
      persistDraft(nextText, {
        start: nextCaret,
        end: nextCaret,
        direction: "none",
      });
    }
    setEmojiQuery(null);
    queueMicrotask(() => {
      const textarea = taRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = nextCaret;
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

  // Pull the complete ordered drop batch in from RoomView. We only treat it as
  // a hint — the parent clears its own state once we've taken ownership.
  React.useEffect(() => {
    if (droppedFiles?.length) {
      const batch = Array.from(droppedFiles);
      queueMicrotask(() => {
        attachFiles(batch);
        onDroppedFilesConsumed?.();
      });
    }
  }, [droppedFiles, onDroppedFilesConsumed, attachFiles]);

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
    const current = textRef.current;
    const nextFeedback = draft.feedbackText.trim();
    const previousFeedback = annotationFeedbackRef.current.get(draft.sourceMediaId);
    annotationFeedbackRef.current.set(draft.sourceMediaId, nextFeedback);
    let next = current;
    if (nextFeedback && !current.includes(nextFeedback)) {
      next = previousFeedback && current.includes(previousFeedback)
        ? current.replace(previousFeedback, nextFeedback)
        : current.trim()
          ? `${current.trimEnd()}\n\n${nextFeedback}`
          : nextFeedback;
    }
    if (next !== current) {
      textRef.current = next;
      setText(next);
      if (!isEditing) setDraft(roomId, next);
    }
  }, [isEditing, roomId]);

  // Pull an annotation draft in from the studio (via RoomView) — same consume-
  // hint pattern as the dropped-file effect above.
  React.useEffect(() => {
    if (pendingAnnotationDraft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consume-hint prop, mirrors the dropped-files effect above
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
    (
      v: string,
      selection?: {
        start: number;
        end: number;
        direction?: DraftSelectionDirection;
      },
    ) => {
      return setDraft(roomId, v, selection);
    },
    [roomId],
  );
  const pendingCommittedClearRef = React.useRef(false);
  const clearComposerAfterDurableTransfer = React.useCallback(async () => {
    const committed = await clearDraftAfterSend(roomId);
    if (committed) {
      pendingCommittedClearRef.current = false;
      setText("");
      return true;
    }
    pendingCommittedClearRef.current = true;
    setComposerAnnouncement(
      "Message saved. This text will clear as soon as saving finishes.",
    );
    return false;
  }, [roomId]);

  React.useEffect(() => {
    if (
      !pendingCommittedClearRef.current ||
      draftSync.localDurabilityPending ||
      draftSync.localDurabilityError
    ) {
      return;
    }
    pendingCommittedClearRef.current = false;
    restoreComposerSnapshot(roomId);
  }, [
    draftSync.localDurabilityError,
    draftSync.localDurabilityPending,
    restoreComposerSnapshot,
    roomId,
  ]);
  // Load the room's saved draft when the active room changes. On leaving the
  // room, flush its draft to the sidebar immediately (don't wait for the typing
  // pause) so switching chats surfaces the draft right away.
  React.useEffect(() => {
    let cancelled = false;
    const untouchedInteractionEpoch = composerInteractionEpochRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset room-scoped picker state with the room switch.
    setEmojiQuery(null);
    // Restore any uploaded attachments staged in this room's draft.
    setAttachments(restoreStagedAttachments(roomId));
    void hydrateDraftJournal(roomId).then(() => loadServerDraft(roomId)).then(async () => {
      if (cancelled) return;
      // Cloud/journal hydration may finish after the user has already placed a
      // caret, selected text, or started typing. The durable merge still runs,
      // but it must never overwrite that live UI range.
      restoreComposerSnapshot(roomId, untouchedInteractionEpoch);
      const restored = restoreStagedAttachments(roomId);
      const carbonId = authStore.getCarbon()?.carbon_id;
      if (!carbonId) {
        setAttachments(restored);
        return;
      }
      let durableRows = [] as Awaited<ReturnType<typeof listRoomMediaUploads>>;
      let albumOutboxMediaIds = new Set<string>();
      try {
        durableRows = await listRoomMediaUploads(`carbon:${carbonId}`, roomId);
        const outboxRows = await listOutbox(carbonId).catch(() => []);
        albumOutboxMediaIds = albumMediaIdsOwnedByOutbox(outboxRows, roomId);
      } catch {
        // Existing uploaded cloud-draft attachments still restore below.
      }
      if (cancelled) return;
      const durableStages: StagedFile[] = [];
      for (const row of durableRows) {
        // Rows bound to an already-saved outbox belong to that immutable send,
        // not the draft composer. They must never appear as a second draft chip.
        if (row.outboxClientId && row.outboxClientId !== row.clientId) continue;
        // The outbox commit is the ownership boundary. If the renderer died
        // before it could stamp/remove every upload row, the immutable album
        // manifest still proves that this media is already queued exactly once.
        if (row.mediaId && albumOutboxMediaIds.has(row.mediaId)) continue;
        if (row.state === "completed" && row.mediaId) {
          durableStages.push({
            id: row.clientId, file: null, name: row.name, size: row.size,
            status: "ready" as const, pct: null, loaded: null,
            mediaId: row.mediaId, mime: row.mime,
          });
          continue;
        }
        if (!row.blob) continue;
        durableStages.push({
          id: row.clientId,
          file: new File([row.blob], row.name, { type: row.mime }),
          name: row.name,
          size: row.size,
          status: "uploading" as const,
          pct: null,
          loaded: null,
          mediaId: null,
          mime: row.mime,
        });
      }
      const durableIds = new Set(durableStages.map((row) => row.id));
      setAttachments([...restored.filter((row) => !durableIds.has(row.id)), ...durableStages]);
      durableStages.filter((row) => row.file && row.status === "uploading")
        .forEach((row) => void uploadOne(row));
    });
    return () => {
      cancelled = true;
      setDraftFocused(roomId, false);
      flushDraft(roomId);
    };
  }, [roomId, restoreComposerSnapshot, uploadOne]);

  // Only the explicit recovery action “copy to composer” enters here. Unsend
  // has no path to this prop, so a redacted message can never repopulate text
  // or attachments as a side effect of deletion.
  React.useEffect(() => {
    if (!copyDraft) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (editingEvent) onEditComplete?.();
      const copiedText = copyDraft.text;
      const copiedAttachments = (copyDraft.attachments ?? []).map((attachment) => ({
        id: newClientId(),
        file: null,
        name: attachment.name,
        size: attachment.size ?? 0,
        status: "ready" as const,
        pct: null,
        loaded: null,
        mediaId: attachment.mediaId,
        mime: attachment.mime || "application/octet-stream",
      }));
      setText(copiedText);
      persistDraft(copiedText);
      setAttachments(copiedAttachments);
      setEmojiQuery(null);
      setMentionQuery(null);
      onComposerCopyConsumed?.();
      taRef.current?.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [copyDraft, editingEvent, onComposerCopyConsumed, onEditComplete, persistDraft]);

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
    // Once a follow-up starts, the existing hold no longer has a truthful ETA:
    // it must wait for this draft. Pause the real timer immediately as well as
    // hiding its countdown; RoomView keeps the explanatory holding flag up.
    if (delayedTextQueueRef.current.length > 0) {
      if (delayTimerRef.current) {
        clearTimeout(delayTimerRef.current);
        delayTimerRef.current = null;
      }
      if (emptyHoldTimerRef.current) {
        clearTimeout(emptyHoldTimerRef.current);
        emptyHoldTimerRef.current = null;
      }
      setQueuePaused(true);
      onHoldStateChange?.(true);
    }
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
  }, [onHoldStateChange, roomId, setTypingActive]);
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
    const previousScrollTop = el.scrollTop;
    const caretAtEnd =
      document.activeElement === el &&
      el.selectionStart === text.length &&
      el.selectionEnd === text.length;
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
    // Resetting height to measure scrollHeight can also reset the textarea's
    // internal viewport. Keep the caret in view at the end of a long draft;
    // preserve an intentional mid-paragraph editing position otherwise.
    el.scrollTop = caretAtEnd ? el.scrollHeight : previousScrollTop;
    onLayoutChange?.();
  }, [onLayoutChange, text]);

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
          hold_release_at: item.releaseAt,
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
    clearDelayTimer();
    onHoldStateChange?.(false);
  }, [clearDelayTimer, onHoldStateChange]);

  // Drop a held message from the queue when its bubble is deleted — never send.
  const cancelQueued = React.useCallback(
    async (clientId: string): Promise<CancelQueuedResult> => {
      const heldSendId = heldSendIdsRef.current.get(clientId);
      const current = delayedTextQueueRef.current;
      const item =
        current.find((queued) => queued.clientId === clientId) ??
        heldIntentsRef.current.get(clientId);
      const held = heldSendsRef.current.get(clientId);
      const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
      const existingCancellation = outboxOwner
        ? await getHeldCancellation(outboxOwner, clientId)
        : null;
      // A temp event from an ordinary immediate send is not a held message.
      // Hiding it here would leave its durable event outbox free to deliver.
      if (!item && !held && !heldSendId && !existingCancellation) return "not-held";

      const payload = item
        ? buildQueuedPayload(item, Math.max(1, current.length))
        : {
            type: "m.text" as const,
            content: { ...(held?.content ?? {}), body: String(held?.content?.body ?? "") },
            reply_to_event_id: held?.reply_to_event_id || undefined,
          };

      if (!outboxOwner) {
        // Without a durable owner namespace, only an authoritative DELETE may
        // hide the bubble. A local/storage failure leaves it visible.
        try {
          const target = heldSendId ?? held?.held_send_id;
          if (!target) return "failed";
          const result = await api.cancelHeldSend(roomId, target);
          if (result.state === "sent") return "sent";
          if (result.state !== "cancelled" && result.state !== "failed") return "failed";
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "couldn't cancel this message");
          return "failed";
        }
      } else {
        try {
          await requestHeldCancellation(outboxOwner, {
            roomId,
            clientId,
            heldSendId: heldSendId ?? held?.held_send_id,
            body: item?.body ?? String(held?.content?.body ?? existingCancellation?.body ?? ""),
            content: payload.content ?? existingCancellation?.content,
            replyTo: payload.reply_to_event_id ?? existingCancellation?.replyTo,
            releaseAt: item?.releaseAt ?? held?.release_at ?? existingCancellation?.releaseAt,
          });
          wakeOutboxRecovery(outboxOwner, clientId);
        } catch (error) {
          // Do not mutate the queue or UI if neither durability layer accepted
          // the user's cancellation.
          toast.error(error instanceof Error ? error.message : "couldn't save this cancellation");
          return "failed";
        }
      }

      heldSendIdsRef.current.delete(clientId);
      heldSendsRef.current.delete(clientId);
      heldIntentsRef.current.delete(clientId);
      cancelledHeldClientIdsRef.current.add(clientId);
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
      if (!outboxOwner) return "cancelled";
      try {
        const state = await reconcileHeldCancellation(
          (await getHeldCancellation(outboxOwner, clientId))!,
        );
        wakeOutboxRecovery(outboxOwner, clientId);
        if (state === "cancelled" || state === "failed") return "cancelled";
        if (state === "sent") toast.message("that held message was already sent");
        return state === "sent" ? "sent" : "pending";
      } catch {
        toast.message("Cancel request saved. We’ll confirm it when connected.");
        return "pending";
      }
    },
    [buildQueuedPayload, clearDelayedQueue, onOptimisticUpdate, roomId],
  );
  React.useEffect(() => {
    if (!cancelQueuedRef) return;
    cancelQueuedRef.current = cancelQueued;
    return () => {
      cancelQueuedRef.current = null;
    };
  }, [cancelQueuedRef, cancelQueued]);

  const clearHeldClient = React.useCallback(
    (clientId: string) => {
      heldSendIdsRef.current.delete(clientId);
      heldSendsRef.current.delete(clientId);
      heldIntentsRef.current.delete(clientId);
      cancelledHeldClientIdsRef.current.delete(clientId);
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
    if (!clearHeldClientRef) return;
    clearHeldClientRef.current = clearHeldClient;
    return () => {
      clearHeldClientRef.current = null;
    };
  }, [clearHeldClientRef, clearHeldClient]);

  const flushDelayedTextQueue = React.useCallback(
    async (extra?: QueuedTextSend, optimistic = true) => {
      const items = [
        ...delayedTextQueueRef.current,
        ...(extra ? [extra] : []),
      ];
      if (!items.length) return;
      for (const item of items) heldIntentsRef.current.set(item.clientId, item);
      clearDelayedQueue();

      const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
      const total = items.length;
      for (const item of items) {
        if (outboxOwner && !(await maySendHeldOutbox(outboxOwner, item.clientId))) continue;
        const heldSendId = heldSendIdsRef.current.get(item.clientId);
        if (heldSendId) {
          const knownHeld = heldSendsRef.current.get(item.clientId);
          if (
            knownHeld &&
            (knownHeld.state === "blocked" ||
              knownHeld.state === "challenge" ||
              knownHeld.state === "failed" ||
              knownHeld.phase === "retry_wait")
          ) {
            clearHeldClient(item.clientId);
            continue;
          }
          try {
            const release = async (): Promise<HeldSend | null> => {
              if (outboxOwner && !(await maySendHeldOutbox(outboxOwner, item.clientId))) {
                return null;
              }
              return api.sendHeldNow(roomId, heldSendId);
            };
            const released = outboxOwner
              ? await withOutboxClientLock(outboxOwner, item.clientId, release)
              : await release();
            if (released) onHeldSendUpdate?.(released);
          } catch (err) {
            if (optimistic) onFail(item.clientId, err);
            else toast.error(err instanceof ApiError ? err.message : String(err));
          } finally {
            heldSendIdsRef.current.delete(item.clientId);
            heldSendsRef.current.delete(item.clientId);
            heldIntentsRef.current.delete(item.clientId);
          }
          continue;
        }
        let payload = buildQueuedPayload(item, total);
        try {
          if (outboxOwner) {
            const existing = (await listOutbox(outboxOwner)).find(
              (row) => row.clientId === item.clientId,
            );
            const durable = existing ?? await enqueueOutbox(outboxOwner, {
                roomId,
                clientId: item.clientId,
                operation: "held",
                type: payload.type,
                body: item.body,
                content: payload.content,
                replyTo: payload.reply_to_event_id,
                releaseAt: item.releaseAt,
                at: Date.now(),
              });
            if (durable.roomId !== roomId || durable.operation !== "held") {
              throw new Error("saved held send has a conflicting operation scope");
            }
            // A lost create response must replay the exact durable payload,
            // not a newly recomputed group projection from current UI state.
            payload = {
              type: (durable.type ?? "m.text") as Event["type"],
              content: { ...(durable.content ?? {}), body: durable.body },
              ...(durable.replyTo ? { reply_to_event_id: durable.replyTo } : {}),
            };
          }
          // If the create response was lost, retrying the SAME held operation
          // retrieves it idempotently. Never fall back to immediate-send with a
          // different operation namespace: that can duplicate a hold which was
          // accepted just before the network disappeared.
          const createAndRelease = async (): Promise<HeldSend | null> => {
            if (outboxOwner && !(await maySendHeldOutbox(outboxOwner, item.clientId))) return null;
            const held = await api.createHeldSend(roomId, {
              type: "m.text",
              content: { ...payload.content, client_id: item.clientId },
              client_id: item.clientId,
              reply_to_event_id: payload.reply_to_event_id,
              hold_seconds: 1,
            });
            // A cancellation can commit while create is in flight. Re-read its
            // independent tombstone before both local ack and release.
            if (outboxOwner && !(await maySendHeldOutbox(outboxOwner, item.clientId))) {
              await api.cancelHeldSend(roomId, held.held_send_id).catch(() => undefined);
              return null;
            }
            if (
              held.state === "blocked" ||
              held.state === "challenge" ||
              held.state === "failed"
            ) {
              if (outboxOwner) {
                await persistHeldOutboxState(outboxOwner, item.clientId, held);
              }
              return null;
            }
            if (held.phase === "retry_wait") {
              if (outboxOwner) await ackOutbox(outboxOwner, item.clientId);
              return null;
            }
            if (outboxOwner) await ackOutbox(outboxOwner, item.clientId).catch(() => undefined);
            if (outboxOwner && !(await maySendHeldOutbox(outboxOwner, item.clientId))) {
              await api.cancelHeldSend(roomId, held.held_send_id).catch(() => undefined);
              return null;
            }
            return api.sendHeldNow(roomId, held.held_send_id);
          };
          const released = outboxOwner
            ? await withOutboxClientLock(outboxOwner, item.clientId, createAndRelease)
            : await createAndRelease();
          if (!released) continue;
          onHeldSendUpdate?.(released);
          heldIntentsRef.current.delete(item.clientId);
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
      clearHeldClient,
      onFail,
      onHeldSendUpdate,
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
    onHoldStateChange?.(false);
    delayTimerRef.current = setTimeout(() => {
      delayTimerRef.current = null;
      if (hasContinuingDraft()) {
        setQueuePaused(true);
        onHoldStateChange?.(true);
      } else {
        void flushDelayedTextQueue();
      }
    }, SILICON_TEXT_HOLD_MS);
  }, [
    clearDelayedQueue,
    clearDelayTimer,
    flushDelayedTextQueue,
    hasContinuingDraft,
    onHoldStateChange,
  ]);

  const queueDelayedTextSend = React.useCallback(
    async (body: string): Promise<boolean> => {
      const clientId = newClientId();
      const existingQueue = delayedTextQueueRef.current;
      const holdGroupId = existingQueue[0]?.holdGroupId ?? newClientId();
      const item: QueuedTextSend = {
        clientId,
        body,
        replyToEventId: replyTo?.event_id,
        holdGroupId,
        holdIndex: existingQueue.length,
        releaseAt: siliconHoldReleaseAt(Date.now()),
      };
      const queuedPayload = buildQueuedPayload(item, existingQueue.length + 1);
      const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
      try {
        if (outboxOwner) {
          await enqueueOutbox(outboxOwner, {
            roomId,
            clientId,
            operation: "held",
            type: queuedPayload.type,
            body,
            content: queuedPayload.content,
            replyTo: item.replyToEventId,
            releaseAt: item.releaseAt,
            at: Date.now(),
          });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Message couldn’t be saved");
        return false;
      }

      const createOnGlass = () => {
        const create = async () => {
          if (outboxOwner && !(await maySendHeldOutbox(outboxOwner, clientId))) {
            throw new Error("held message was cancelled");
          }
          const held = await api.createHeldSend(roomId, {
            type: "m.text",
            content: { body, client_id: clientId },
            client_id: clientId,
            reply_to_event_id: replyTo?.event_id,
            hold_seconds: SILICON_TEXT_HOLD_SECONDS,
          });
          if (outboxOwner && !(await maySendHeldOutbox(outboxOwner, clientId))) {
            return api.cancelHeldSend(roomId, held.held_send_id);
          }
          return held;
        };
        return outboxOwner
          ? withOutboxClientLock(outboxOwner, clientId, create)
          : create();
      };

      // A non-Carbon session has no local outbox namespace. Do not clear its
      // composer until Glass has durably accepted the held operation.
      let acceptedWithoutOutbox: HeldSend | null = null;
      if (!outboxOwner) {
        try {
          acceptedWithoutOutbox = await createOnGlass();
        } catch (error) {
          toast.error(error instanceof ApiError ? error.message : String(error));
          return false;
        }
      }

      delayedTextQueueRef.current = [...existingQueue, item];
      const queue = delayedTextQueueRef.current;
      setQueuedTextCount(queue.length);
      setQueuePaused(false);
      onHoldStateChange?.(false);
      onOptimisticAdd(clientId, buildQueuedPayload(item, queue.length));
      for (const queued of queue) {
        onOptimisticUpdate?.(queued.clientId, buildQueuedPayload(queued, queue.length));
      }
      restartDelayedFlushTimer();
      const accepted = acceptedWithoutOutbox
        ? Promise.resolve(acceptedWithoutOutbox)
        : createOnGlass();
      void accepted
        .then(async (held) => {
          const durablyCancelled = outboxOwner
            ? !(await maySendHeldOutbox(outboxOwner, clientId))
            : false;
          if (cancelledHeldClientIdsRef.current.has(clientId) || durablyCancelled) {
            if (outboxOwner) {
              void requestHeldCancellation(outboxOwner, {
                roomId,
                clientId,
                heldSendId: held.held_send_id,
                body,
                content: queuedPayload.content,
                replyTo: item.replyToEventId,
                releaseAt: item.releaseAt,
              })
                .then((row) => reconcileHeldCancellation(row))
                .catch(() => undefined);
            } else {
              api.cancelHeldSend(roomId, held.held_send_id).catch(() => undefined);
            }
            return;
          }
          if (
            held.state === "blocked" ||
            held.state === "challenge" ||
            held.state === "failed"
          ) {
            if (outboxOwner) {
              await persistHeldOutboxState(outboxOwner, clientId, held);
            }
            clearHeldClient(clientId);
            return;
          }
          if (held.phase === "retry_wait") {
            if (outboxOwner) await ackOutbox(outboxOwner, clientId);
            clearHeldClient(clientId);
            return;
          }
          if (outboxOwner) void ackOutbox(outboxOwner, clientId).catch(() => undefined);
          heldSendIdsRef.current.set(clientId, held.held_send_id);
          heldSendsRef.current.set(clientId, held);
          onHeldSendUpdate?.(held);
          // Keep the locally-anchored 5s display deadline. `held.release_at`
          // is an absolute server timestamp; replacing the local deadline with
          // it makes clock skew look like a 60s+ hold even though Glass stored
          // exactly five seconds.
        })
        .catch(async (err) => {
          if (cancelledHeldClientIdsRef.current.has(clientId)) {
            // The user explicitly deleted this optimistic bubble while create was
            // in flight. If create fails, do not fall back to immediate send.
            return;
          }
          // Keep the durable held operation. The timer/reconnect flusher retries
          // create with this same client ID, so an ambiguous response cannot
          // become a second immediate event.
          onFail(clientId, err);
        });
      onClearReply?.();
      return true;
    },
    [
      buildQueuedPayload,
      clearHeldClient,
      onClearReply,
      onFail,
      onHoldStateChange,
      onHeldSendUpdate,
      onOptimisticAdd,
      onOptimisticUpdate,
      replyTo,
      restartDelayedFlushTimer,
      roomId,
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
  }, [clearEditInactivityTimer, onEditComplete, persistDraft, setEmojiQuery, setMentionQuery]);

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
        setQueuedTextCount(delayedTextQueueRef.current.length);
        onHoldStateChange?.(true);
      }
      taRef.current?.focus();
    });
    return () => {
      cancelled = true;
    };
    // Deliberately hydrate only when entering a different edit. Parent renders
    // (receipts, timers, presence, inline callbacks) must never overwrite what
    // the user has already typed into this edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingEvent?.event_id]);

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
      }
      return;
    }
    if (editingHeld) {
      if (emptyHoldTimerRef.current) {
        clearTimeout(emptyHoldTimerRef.current);
        emptyHoldTimerRef.current = null;
      }
      return;
    }
    // Still typing a follow-up → keep holding; cancel any empty-hold countdown.
    if (hasContinuingDraft()) {
      if (emptyHoldTimerRef.current) {
        clearTimeout(emptyHoldTimerRef.current);
        emptyHoldTimerRef.current = null;
      }
      return;
    }
    // Input is empty while paused: wait at least SILICON_EMPTY_HOLD_MS before
    // sending (NOT instantly). Don't restart an already-running countdown.
    if (emptyHoldTimerRef.current) return;
    emptyHoldTimerRef.current = setTimeout(() => {
      emptyHoldTimerRef.current = null;
      // Re-check: if they resumed typing in the meantime, this effect will have
      // cancelled us; only send if the box is still empty.
      if (!hasContinuingDraft()) void flushDelayedTextQueue();
    }, SILICON_EMPTY_HOLD_MS);
  }, [editingHeld, flushDelayedTextQueue, hasContinuingDraft, queuePaused, queuedTextCount, text, typingActive]);

  React.useEffect(
    () => () => {
      // Server-accepted holds survive room switches, unmounts, tab closes, and
      // logout. Do not flush/cancel them from cleanup; Glass owns the timer.
      clearDelayTimer();
      delayedTextQueueRef.current = [];
      heldSendIdsRef.current.clear();
      heldSendsRef.current.clear();
      heldIntentsRef.current.clear();
      // Do NOT clear explicit-cancel tombstones here. A held-create request may
      // still resolve after unmount; its then() must see the tombstone and issue
      // cancelHeldSend so a user-deleted optimistic message cannot later release.
      setQueuedTextCount(0);
      onHoldStateChange?.(false);
    },
    [clearDelayTimer, onHoldStateChange],
  );

  const sendOptimistic = async (
    payload: OptimisticPayload,
    options?: {
      sizeBytes?: number;
      /** Runs after the outbox owns the immutable intent and before transport. */
      afterDurableEnqueue?: (clientId: string) => Promise<void>;
    },
  ): Promise<boolean> => {
    const clientId = newClientId();
    const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
    try {
      if (outboxOwner) {
        await enqueueOutbox(outboxOwner, {
          roomId,
          clientId,
          type: payload.type,
          body: String(payload.content?.body ?? ""),
          content: payload.content ?? {},
          replyTo: payload.reply_to_event_id,
          at: Date.now(),
        });
        if (options?.afterDurableEnqueue) {
          try {
            await options.afterDurableEnqueue(clientId);
          } catch {
            // The outbox is already authoritative, so a secondary cleanup-link
            // failure must never invite a duplicate resend or hide the queued
            // message. Recovery also correlates the immutable album manifest.
            setComposerAnnouncement(
              "Message saved. We’ll finish preparing its attachment automatically.",
            );
          }
        }
      }
      // The optimistic row and any composer cleanup happen only after the
      // local outbox transaction has committed. For sessions without a Carbon
      // outbox owner, wait for authoritative server acceptance instead.
      onOptimisticAdd(clientId, payload, {
        timeoutMs: sendTimeoutMs(options?.sizeBytes),
      });
      if (!outboxOwner) {
        const real = await api.sendEvent(roomId, payload, clientId);
        onAck(clientId, real);
        return true;
      }
      void api
        .sendEvent(roomId, payload, clientId)
        .then((real) => {
          onAck(clientId, real);
          void ackOutbox(outboxOwner, clientId, { roomId, event: real });
        })
        .catch((error) => onFail(clientId, error));
      return true;
    } catch (error) {
      // No optimistic item was created if local durability failed, so leave
      // the composer untouched and explain why Send could not be accepted.
      toast.error(error instanceof Error ? error.message : "Message couldn’t be saved");
      return false;
    }
  };

  const processDurableGif = async (
    initial: OutboxEntry,
    optimisticAlreadyAdded = false,
  ) => {
    if (gifAcquisitionsInFlightRef.current.has(initial.clientId)) return;
    const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
    if (!outboxOwner) return;
    gifAcquisitionsInFlightRef.current.add(initial.clientId);
    setGifAcquisitions((current) =>
      current.map((item) =>
        item.entry.clientId === initial.clientId ? { ...item, error: undefined } : item,
      ),
    );
    let entry = initial;
    let optimisticAdded = optimisticAlreadyAdded;
    let activityStarted = false;
    try {
      // This is the first external fetch. The provider id/URL/title/dimensions,
      // room, reply, and immutable client id are already in the outbox.
      entry = await ensureMediaOutboxStaged(outboxOwner, entry);
      setGifAcquisitions((current) =>
        current.filter((item) => item.entry.clientId !== entry.clientId),
      );
      const acquisition = entry.media?.acquisition;
      if (!optimisticAlreadyAdded) {
        onOptimisticAdd(entry.clientId, {
          type: "m.image",
          content: {
            ...(entry.content ?? {}),
            ...(acquisition?.url ? { local_url: acquisition.url } : {}),
          },
          ...(entry.replyTo ? { reply_to_event_id: entry.replyTo } : {}),
        });
        optimisticAdded = true;
      }
      gifUploadsInFlightRef.current += 1;
      activityStarted = true;
      if (gifUploadsInFlightRef.current === 1) {
        api.activity(roomId, "uploading", true).catch(() => undefined);
      }
      await withOutboxClientLock(outboxOwner, entry.clientId, async () => {
        const current = (await listOutbox(outboxOwner)).find(
          (item) => item.clientId === entry.clientId,
        );
        // Another tab or the global recovery loop may already have committed
        // and acknowledged this exact durable GIF intent.
        if (!current) return;
        entry = current;
        const payload = await prepareMediaOutboxPayload(outboxOwner, entry);
        const real = await api.sendEvent(roomId, payload, entry.clientId);
        onAck(entry.clientId, real);
        await acknowledgeMediaSend(outboxOwner, entry, undefined, {
          roomId,
          event: real,
        });
      });
      track.messageSent({ room_id: roomId, message_type: "m.image", has_attachment: true });
      onClearReply?.();
    } catch (error) {
      if (optimisticAdded) {
        onFail(entry.clientId, error);
        const message = error instanceof Error ? error.message : "GIF source is unavailable";
        setGifAcquisitions((current) => {
          const without = current.filter((item) => item.entry.clientId !== entry.clientId);
          return [...without, { entry, error: message }];
        });
      } else {
        await persistOutboxFailure(outboxOwner, entry.clientId, error).catch(() => false);
        const message = error instanceof Error ? error.message : "GIF source is unavailable";
        setGifAcquisitions((current) => {
          const without = current.filter((item) => item.entry.clientId !== entry.clientId);
          return [...without, { entry, error: message }];
        });
        toast.error(`${message}. The GIF is saved here — retry when ready.`);
      }
    } finally {
      gifAcquisitionsInFlightRef.current.delete(initial.clientId);
      if (activityStarted) {
        gifUploadsInFlightRef.current = Math.max(0, gifUploadsInFlightRef.current - 1);
        if (gifUploadsInFlightRef.current === 0) {
          api.activity(roomId, "uploading", false).catch(() => undefined);
        }
      }
    }
  };

  const sendGif = async (gif: GifResult) => {
    if (sendDisabled || busy || isEditing) return;
    const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
    if (!outboxOwner) {
      toast.error("A signed-in owner is required for a durable GIF send");
      return;
    }
    const safeTitle = gif.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    try {
      // Strict click journal: no fetch, picker close, reply clear, composer
      // clear, activity POST, or optimistic timeline row precedes this commit.
      const entry = await journalRemoteGifIntent({
        outboxOwnerId: outboxOwner,
        mediaOwnerId: `carbon:${outboxOwner}`,
        roomId,
        clientId: newClientId(),
        gifId: gif.id,
        sourceUrl: gif.downloadUrl,
        title: gif.title,
        filename: `${safeTitle || gif.id}.gif`,
        width: gif.width,
        height: gif.height,
        replyTo: replyTo?.event_id,
      });
      // The durable click journal already owns ordering and recovery. Paint the
      // lightweight GIPHY preview immediately while the full rendition uploads
      // in the background, so later messages can never overtake this GIF.
      onOptimisticAdd(entry.clientId, {
        type: "m.image",
        content: {
          ...(entry.content ?? {}),
          local_url: gif.previewUrl,
        },
        ...(entry.replyTo ? { reply_to_event_id: entry.replyTo } : {}),
      });
      setGifAcquisitions((current) => [...current, { entry }]);
      setExpressionPickerOpen(false);
      void processDurableGif(entry, true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "GIF could not be saved for sending");
    }
  };

  const sendTextOptimistic = async (body: string, extraContent?: Record<string, unknown>) => {
    const clientId = newClientId();
    const payload: OptimisticPayload = {
      type: "m.text",
      content: { body, ...(extraContent ?? {}) },
      reply_to_event_id: replyTo?.event_id,
    };
    // Persisted outbox: enqueue BEFORE the POST, ack on success. On failure
    // the entry stays — the reconnect/mount flusher (and the failed bubble's
    // tap-to-retry) re-POSTs it with the same client id, which the server
    // dedupes. Persist the complete text payload (mentions, bundles, attachment
    // refs) so a crash cannot silently downgrade or discard its semantics.
    const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
    try {
      if (outboxOwner) {
        await enqueueOutbox(outboxOwner, {
          roomId,
          clientId,
          body,
          content: payload.content,
          replyTo: replyTo?.event_id,
          at: Date.now(),
        });
      }
      onOptimisticAdd(clientId, payload, { timeoutMs: sendTimeoutMs() });
      if (!outboxOwner) {
        const real = await api.sendEvent(roomId, payload, clientId);
        onAck(clientId, real);
      } else {
        void api
          .sendEvent(roomId, payload, clientId)
          .then((real) => {
            onAck(clientId, real);
            void ackOutbox(outboxOwner, clientId, { roomId, event: real });
          })
          .catch((error) => {
            const attempts = 1;
            const challenge =
              error instanceof ApiError ? challengeFromErrorBody(error.body) : null;
            if (challenge) {
              setComposerAnnouncement(
                "Message saved. Verify this device to continue sending.",
              );
              onFail(clientId, error);
              return;
            }
            const decision = classifyOutboxFailure({
              status: error instanceof ApiError ? error.status : 0,
              attempts,
              now: Date.now(),
              retryAfterMs: error instanceof ApiError ? error.retryAfterMs : null,
              message: error instanceof Error ? error.message : "temporarily unavailable",
            });
            setComposerAnnouncement(
              decision.state === "queued"
                ? "Message saved. We’ll keep trying."
                : "Message saved, but it needs your attention.",
            );
            onFail(clientId, error);
          });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Message couldn’t be saved");
      return false;
    }
    track.messageSent({
      room_id: roomId,
      message_type: "m.text",
      is_reply: Boolean(replyTo),
    });
    // Clear the reply target on send.
    onClearReply?.();
    return true;
  };

  const send = async () => {
    if (draftSync.localDurabilityPending || draftSync.localDurabilityError) {
      toast.error("Save this draft locally before sending or leaving the chat.");
      return;
    }
    if (sendDisabled) {
      toast.message(sendDisabledReason);
      return;
    }
    if (replyTo?.redacted_at) {
      toast.error("The message you were replying to was deleted. Remove the reply to send without losing this draft.");
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
        await clearComposerAfterDurableTransfer();
        if (result.clearReply) onClearReply?.();
        return;
      }
      if (result.replaceWith !== undefined) body = result.replaceWith; // transform + send
    }

    // Attachment path — uploads already started on attach. Two or more files
    // publish as ONE ordered m.album event after every item is ready. This is
    // the atomic boundary: retries reuse one client id and peers can never see
    // a partial group. A single file retains the legacy one-event flow.
    if (attachments.length > 0) {
      if (anyUploading) return;
      if (attachments.some((attachment) => attachment.status !== "ready" || !attachment.mediaId)) {
        toast.error("Retry or remove failed attachments before sending this group.");
        return;
      }
      const ready = attachments.filter((a) => a.status === "ready" && a.mediaId);
      if (ready.length === 0 && !body) return;
      setBusy(true);
      try {
        // When text rides along with attachments, tag both with a shared
        // bundle_id so the timeline can render the attachments as pins on the
        // text bubble. With no text, attachments stand alone (no bundle).
        const isAlbum = ready.length >= 2;
        const bundleId = !isAlbum && body && ready.length > 0 ? newClientId() : null;
        let sentAnnotations = false;
        let albumQueued = false;
        const queuedAttachmentIds = new Set<string>();
        if (isAlbum) {
          const annotationParents = new Set(
            ready.flatMap((attachment) =>
              attachment.kind === "annotations" && attachment.annotation?.sourceEventId
                ? [attachment.annotation.sourceEventId]
                : [],
            ),
          );
          const albumReply = replyTo?.event_id ??
            (annotationParents.size === 1 ? [...annotationParents][0] : undefined);
          const content = buildAlbumContent(
            ready.map((attachment) => ({
              mediaId: attachment.mediaId as string,
              filename:
                attachment.kind === "annotations" && attachment.annotation
                  ? attachment.annotation.annotatedName
                  : attachment.name,
            })),
            body,
          );
          const sent = await sendOptimistic(
            {
              type: "m.album",
              content,
              ...(albumReply ? { reply_to_event_id: albumReply } : {}),
            },
            {
              sizeBytes: ready.reduce((total, attachment) => total + attachment.size, 0),
              afterDurableEnqueue: async (albumClientId) => {
                const carbonId = authStore.getCarbon()?.carbon_id;
                if (!carbonId) return;
                const results = await Promise.allSettled(
                  ready.map((attachment) =>
                    patchMediaUpload(`carbon:${carbonId}`, attachment.id, {
                      outboxClientId: albumClientId,
                      state: "cleanup",
                    }),
                  ),
                );
                if (results.some((result) => result.status === "rejected")) {
                  throw new Error("album ownership binding did not fully commit");
                }
              },
            },
          );
          if (sent) {
            albumQueued = true;
            for (const attachment of ready) {
              queuedAttachmentIds.add(attachment.id);
              if (attachment.kind === "annotations" && attachment.annotation) {
                clearAnnotationSession(roomId, attachment.annotation.sourceMediaId);
                sentAnnotations = true;
              }
              const carbonId = authStore.getCarbon()?.carbon_id;
              if (carbonId) {
                await removeMediaUpload(`carbon:${carbonId}`, attachment.id).catch(() => undefined);
              }
            }
            track.messageSent({ room_id: roomId, message_type: "m.album", has_attachment: true });
          }
        }
        for (const a of isAlbum ? [] : ready) {
          if (a.kind === "annotations" && a.annotation) {
            // The generated annotated file → a normal m.file/m.image, reply-
            // linked to the original so replies + the silicon reference it.
            const d = a.annotation;
            const annType = d.annotatedMime.startsWith("image/") ? "m.image" : "m.file";
            const sent = await sendOptimistic({
              type: annType,
              content: {
                media_id: d.annotatedMediaId,
                mime: d.annotatedMime,
                filename: d.annotatedName,
                ...(bundleId ? { bundle_id: bundleId } : {}),
              },
              ...(d.sourceEventId ? { reply_to_event_id: d.sourceEventId } : {}),
            });
            if (sent) {
              queuedAttachmentIds.add(a.id);
              clearAnnotationSession(roomId, d.sourceMediaId);
              sentAnnotations = true;
              track.messageSent({ room_id: roomId, message_type: annType, has_attachment: true });
            }
            continue;
          }
          const fileType = a.mime.startsWith("image/") ? "m.image" : "m.file";
          const sent = await sendOptimistic(
            {
              type: fileType,
              content: {
                media_id: a.mediaId,
                mime: a.mime,
                filename: a.name,
                ...(bundleId ? { bundle_id: bundleId } : {}),
              },
              ...(replyTo ? { reply_to_event_id: replyTo.event_id } : {}),
            },
            { sizeBytes: a.size },
          );
          if (sent) {
            queuedAttachmentIds.add(a.id);
            const carbonId = authStore.getCarbon()?.carbon_id;
            if (carbonId) {
              await removeMediaUpload(`carbon:${carbonId}`, a.id).catch(() => undefined);
            }
            track.messageSent({ room_id: roomId, message_type: fileType, has_attachment: true });
          }
        }
        // Remove only attachments whose complete send semantics are now in the
        // durable outbox. A storage failure leaves that row staged instead of
        // clearing the whole composer and inviting an accidental duplicate.
        const remainingAttachments = attachments.filter(
          (attachment) => !queuedAttachmentIds.has(attachment.id),
        );
        setAttachments(remainingAttachments);
        setDraftAttachments(
          roomId,
          remainingAttachments
            .filter(
              (attachment) =>
                attachment.status === "ready" &&
                attachment.mediaId &&
                attachment.kind !== "annotations",
            )
            .map((attachment) => ({
              id: attachment.id,
              mediaId: attachment.mediaId as string,
              mime: attachment.mime,
              name: attachment.name,
              size: attachment.size,
            })),
        );
        // An attached annotation set carried the reply to the file — clear it so
        // the next message isn't unexpectedly a reply (unless text handles it).
        if (sentAnnotations && !body && remainingAttachments.length === 0) onClearReply?.();
        // For an album, typed text is its one root caption. For a lone legacy
        // attachment it rides as a separate bundled message.
        // carrying the same bundle_id so they render together. If the user
        // typed @filename references, persist the resolved attachment ids too.
        if (albumQueued) {
          if (remainingAttachments.length === 0) {
            await clearComposerAfterDurableTransfer();
            onClearReply?.();
          }
        } else if (body) {
          const attachmentRefs = attachmentRefsForBody(body, ready);
          const extraContent = {
            ...(bundleId ? { bundle_id: bundleId } : {}),
            ...(attachmentRefs.length > 0 ? { attachment_refs: attachmentRefs } : {}),
          };
          const textQueued = await sendTextOptimistic(
            body,
            Object.keys(extraContent).length > 0 ? extraContent : undefined,
          );
          if (textQueued) {
            if (remainingAttachments.length === 0) {
              await clearComposerAfterDurableTransfer();
            } else if (await persistDraft("")) {
              setText("");
            }
          }
        } else if (remainingAttachments.length === 0 && queuedAttachmentIds.size > 0) {
          await clearComposerAfterDurableTransfer();
          onClearReply?.();
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
      const queued = await queueDelayedTextSend(body);
      if (queued) {
        await clearComposerAfterDurableTransfer();
      }
      return;
    }
    const queued = await sendTextOptimistic(body);
    if (queued) {
      await clearComposerAfterDurableTransfer();
    }
  };

  // ----- Voice recording -----

  const uploadVoice = async (blob: Blob, durationMs: number, savedClientId?: string) => {
    const clientId = savedClientId ?? newClientId();
    const mime = blob.type || "audio/webm";
    const replyEventId = replyTo?.event_id;
    let localUrl: string | null = null;
    let optimisticAdded = false;
    setBusy(true);
    try {
      const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
      if (!outboxOwner) throw new Error("Please sign in again before sending this voice note");
      const extension = mime.includes("mp4")
        ? "m4a"
        : mime.includes("ogg")
          ? "ogg"
          : "webm";
      const filename = `voice-${clientId}.${extension}`;
      const peaks = await computePeaks(blob).catch(() => null);
      const resolvedDuration = peaks?.duration_ms || durationMs;
      const eventContent = {
        duration_ms: resolvedDuration,
        ...(peaks ? { peaks: peaks.peaks } : {}),
      };
      const entry = await stageMediaSendIntent({
        outboxOwnerId: outboxOwner,
        mediaOwnerId: `carbon:${outboxOwner}`,
        roomId,
        clientId,
        blob,
        kind: "voice",
        type: "m.voice",
        filename,
        mime,
        optimisticContent: { ...eventContent, mime },
        eventContent,
        completionMeta: eventContent,
        // Glass queues authoritative speech-to-text after accepting the
        // message. Audio delivery must never wait on an optional STT provider.
        transcribe: false,
        replyTo: replyEventId,
      });
      // The voice draft and media/outbox journals are now strict-commit safe.
      // Only now may the timeline change or an upload/STT request begin.
      localUrl = URL.createObjectURL(blob);
      onOptimisticAdd(
        clientId,
        {
          type: "m.voice",
          content: { ...(entry.content ?? {}), local_url: localUrl },
          ...(replyEventId ? { reply_to_event_id: replyEventId } : {}),
        },
        { timeoutMs: sendTimeoutMs(blob.size) },
      );
      optimisticAdded = true;
      voiceLocalUrlsRef.current.set(clientId, localUrl);
      localUrl = null;
      // The page-level recovery worker exclusively owns upload, readiness
      // polling, idempotency resolution, and acknowledgement from this point.
      setPendingVoice(null);
      wakeOutboxRecovery(outboxOwner, clientId);
      onClearReply?.();
      track.messageSent({ room_id: roomId, message_type: "m.voice", has_attachment: true });
    } catch (e) {
      if (optimisticAdded) onFail(clientId, e);
      // Aborts, offline failures, and room switches all retain the same durable
      // draft. Only an explicit discard is allowed to delete captured audio.
      const draft = { blob, durationMs, savedAt: Date.now(), clientId };
      setPendingVoice(draft);
      await saveVoiceDraft(roomId, draft);
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        toast.error("voice note failed to send - tap retry to try again.");
      }
    } finally {
      setBusy(false);
      if (localUrl) URL.revokeObjectURL(localUrl);
    }
  };

  const onVoiceSubmit = (blob: Blob, durationMs: number) => {
    api.activity(roomId, "recording", false).catch(() => undefined);
    const draft = { blob, durationMs, savedAt: Date.now(), clientId: newClientId() };
    void (async () => {
      // Persist before beginning the upload so a refresh/crash during transfer
      // still leaves a recoverable copy.
      await saveVoiceDraft(roomId, draft);
      await uploadVoice(blob, durationMs, draft.clientId);
    })();
  };

  // The complete recorder follows the user into every writable chat. Its
  // callbacks remain captured from the origin room in the global session, so
  // send/discard can never target whichever room merely happens to be visible.
  if (recordingActive) {
    return (
      <div className="border-t bg-background p-3">
        <VoiceRecorder />
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t bg-background p-2">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {busy || editSaving
          ? "Sending message"
          : anyUploading
            ? "Uploading attachment"
            : composerAnnouncement}
      </div>
      {draftSync.error && draftSync.blocked && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border border-input bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          role="status"
        >
          <span>
            This draft is safe here, but needs your attention before it can be saved everywhere.
          </span>
          <button
            type="button"
            onClick={() => retryDraftSync(roomId)}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Try again
          </button>
        </div>
      )}
      {(draftSync.localDurabilityPending || draftSync.localDurabilityError) && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
          aria-live="assertive"
        >
          <span>
            {draftSync.localDurabilityError ??
              "Saving this draft to the device. Stay in this chat until it finishes."}
          </span>
          <button
            type="button"
            disabled={draftSync.localDurabilityPending}
            onClick={() => void retryLocalDraftPersistence(roomId)}
            className="font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            {draftSync.localDurabilityPending ? "Saving…" : "Try again"}
          </button>
        </div>
      )}
      {replyTo && (
        <div className="flex items-start gap-2 border-l-2 border-foreground/60 bg-card px-2 py-1 text-xs">
          <ArrowBendUpLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
          <div className="min-w-0 flex-1">
            <div className="label-mono text-[10px] opacity-60">
              replying to {replyTo.sender_handle ? `@${replyTo.sender_handle}` : "message"}
            </div>
            <div
              className={cn(
                "truncate text-foreground/80",
                replyTo.redacted_at && "text-destructive",
              )}
              role={replyTo.redacted_at ? "alert" : undefined}
            >
              {replyTo.redacted_at ? (
                "original message was deleted — remove this reply target to send"
              ) : replyTo.type === "m.voice" ? (
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
      {gifAcquisitions.map(({ entry, error }) => (
        <div
          key={entry.clientId}
          className="flex flex-wrap items-center justify-between gap-3 border border-input bg-card px-3 py-2 text-xs"
          role="status"
        >
          <span className="min-w-0">
            <span className="font-medium">
              {entry.media?.acquisition?.title || entry.media?.filename || "GIF"}
            </span>{" "}
            <span className="text-muted-foreground">
              {error
                ? `— ${error}`
                : entry.media?.phase === "staged"
                  ? "— saved; sending…"
                  : "— saved; acquiring source…"}
            </span>
          </span>
          {error && (
            <button
              type="button"
              onClick={() => void processDurableGif(entry)}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              retry
            </button>
          )}
        </div>
      ))}
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
                failed={a.status === "error"}
                onRetry={() => retryAttachment(a.id)}
                onRemove={() => removeAttachment(a.id)}
                roomId={roomId}
                onAttachAnnotations={stageAnnotationDraft}
              />
            ),
          )}
        </div>
      )}
      {/* A finalized/failed voice note is durable. It can be previewed and sent
          after returning to the room; only this explicit discard deletes it. */}
      {pendingVoice && (
        <div className="flex items-center justify-between gap-3 border border-input bg-card px-3 py-2 text-xs">
          <div className="min-w-0 flex-1">
            <div className="label-mono mb-1 text-[10px] text-muted-foreground">
              saved voice note
            </div>
            <SavedVoicePlayer key={pendingVoice.savedAt} draft={pendingVoice} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void uploadVoice(
                  pendingVoice.blob,
                  pendingVoice.durationMs,
                  pendingVoice.clientId,
                )
              }
              disabled={busy}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              send
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingVoice(null);
                void clearVoiceDraft(roomId);
              }}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground"
            >
              discard
            </button>
          </div>
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
          <div
            ref={mentionMirrorRef}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2.5 text-sm text-foreground",
              mentionInputComposing && "invisible",
            )}
          >
            {mentionInputPieces.map((piece, index) =>
              piece.kind === "mention" ? (
                <span
                  key={`${piece.value}-${index}`}
                  className={cn(
                    mentionClassName(false),
                    // The mirror sits over a transparent textarea. Padding or
                    // a heavier font changes its advance width without moving
                    // the real caret, so all text after a mention looks offset.
                    "px-0 font-normal",
                  )}
                >
                  {piece.value}
                </span>
              ) : (
                <React.Fragment key={`text-${index}`}>{piece.value}</React.Fragment>
              ),
            )}
            {text.endsWith("\n") ? " " : null}
          </div>
          <textarea
            ref={taRef}
            autoFocus
            value={text}
            onFocus={(event) => {
              setDraftFocused(roomId, true);
              persistComposerSelection(event.currentTarget, true);
            }}
            onBlur={(event) => {
              persistComposerSelection(event.currentTarget, true);
              setDraftFocused(roomId, false);
              flushDraft(roomId);
            }}
            onSelect={(event) => {
              persistComposerSelection(event.currentTarget);
            }}
            onPointerDown={noteComposerInteraction}
            onPointerUp={(event) => persistComposerSelection(event.currentTarget, true)}
            onKeyUp={(event) => persistComposerSelection(event.currentTarget, true)}
            onCompositionStart={() => {
              noteComposerInteraction();
              setMentionInputComposing(true);
            }}
            onCompositionEnd={() => setMentionInputComposing(false)}
            onChange={(e) => {
              noteComposerInteraction();
              const v = e.target.value;
              setText(v);
              if (!isEditing) {
                persistDraft(v, {
                  start: e.target.selectionStart,
                  end: e.target.selectionEnd,
                  direction: e.target.selectionDirection as DraftSelectionDirection,
                });
              }
              if (v) beaconTyping();
              // Detect a `:foo` token at the caret. If found, open picker.
              // The `(?<![\w])` lookbehind stops the trigger firing inside
              // times/ratios like `12:30` or URLs like `http://` — the colon
              // must follow whitespace or the start of the line, not a word
              // character, to be treated as an emoji shortcode start.
              const caret = e.target.selectionStart ?? v.length;
              const upTo = v.slice(0, caret);
              const shortcode = emojiShortcodeQuery(upTo);
              if (shortcode !== null) {
                setEmojiQuery(shortcode);
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
            className={cn(
              "relative z-10 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground",
              mentionInputComposing ? "text-foreground" : "text-transparent caret-foreground",
            )}
            onScroll={(event) => {
              const mirror = mentionMirrorRef.current;
              if (!mirror) return;
              mirror.scrollTop = event.currentTarget.scrollTop;
              mirror.scrollLeft = event.currentTarget.scrollLeft;
            }}
            onPaste={(e) => {
              noteComposerInteraction();
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
              noteComposerInteraction();
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
                  if (picked) insertEmoji(picked.emoji, true);
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
              const enterAction = composerEnterAction({
                key: e.key,
                behavior: enterBehavior,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
                altKey: e.altKey,
                isComposing: e.nativeEvent.isComposing,
                keyCode: e.keyCode,
              });
              if (enterAction === "send") {
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
              if (pendingVoice) {
                toast.message("send or discard the saved voice note first");
                return;
              }
              api.activity(roomId, "recording", true).catch(() => undefined);
              void voiceRecordingSession.start(roomId, {
                onSubmit: ({ blob, durationMs }) => onVoiceSubmit(blob, durationMs),
                onCancel: () => {
                  api.activity(roomId, "recording", false).catch(() => undefined);
                },
              }).catch((error) => {
                api.activity(roomId, "recording", false).catch(() => undefined);
                if (error instanceof DOMException && error.name === "AbortError") return;
                toast.error(
                  error instanceof DOMException && error.name === "NotAllowedError"
                    ? "microphone permission denied"
                    : error instanceof Error
                      ? error.message
                      : "couldn't start recorder",
                );
              });
            }}
            disabled={
              busy ||
              sendDisabled ||
              Boolean(pendingVoice) ||
              voiceSession.phase !== "idle"
            }
            title={
              voiceSession.phase === "idle"
                ? "record voice message"
                : "a voice note is already being recorded"
            }
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
              localDraftUnsafe ||
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
        <Popover open={expressionPickerOpen} onOpenChange={setExpressionPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title="add emoji or GIF"
              aria-label="add emoji or GIF"
              disabled={sendDisabled || busy || isEditing}
              className="flex h-11 w-11 shrink-0 items-center justify-center border border-input bg-transparent text-foreground transition-opacity hover:opacity-70 disabled:opacity-50"
            >
              <Smiley className="h-5 w-5" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" sideOffset={8} className="w-auto">
            <ComposerExpressionPicker
              onPickEmoji={(emoji) => {
                insertEmoji(emoji);
                setExpressionPickerOpen(false);
              }}
              onPickGif={(gif) => void sendGif(gif)}
            />
          </PopoverContent>
        </Popover>
        {emojiQuery !== null && (
          <EmojiQuickPicker
            query={emojiQuery}
            selectedIndex={emojiIdx}
            cols={emojiCols}
            limit={emojiLimit}
            onPick={(emoji) => insertEmoji(emoji, true)}
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
