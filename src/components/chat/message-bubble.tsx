"use client";

import * as React from "react";
import {
  ArrowClockwise,
  ArrowBendUpLeft,
  Check,
  Clock,
  Copy,
  DotsThree,
  DownloadSimple,
  Flag,
  ImageSquare,
  ListChecks,
  MusicNote,
  PencilSimple,
  PuzzlePiece,
  Share,
  Smiley,
  Sparkle,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { readMediaUpload } from "@/lib/media-upload-store";
import { getCachedMedia, setCachedMedia } from "@/lib/media-cache";
import { isGifMedia } from "@/lib/media-meta";
import { usePdfThumbnail } from "@/lib/pdf-thumb";
import { isTextLike, useTextSnippetState } from "@/lib/text-preview";
import { languageForFile } from "@/lib/programmatic-files";
import type { AnnotationDraft, Event, EventType, ProgressState } from "@/lib/types";
import { editableTextForEvent, eventShowsEdited } from "@/lib/event-edit";
import { extractUrls, renderMarkdown, looksLikeMarkdown } from "@/lib/markdown";
import { emojiOnly } from "@/lib/emoji";
import { type MessageReceiptStatus } from "@/lib/message-receipt";
import { cn, messageTime } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { workEventPreview } from "@/lib/work-update-presentation";
import {
  toolSetupRequestFromEvent,
  type ToolSetupRequestMessage,
} from "@/lib/tool-setup-request";
import {
  parseToolSetupAssignment,
  TOOL_SETUP_STATE_EVENT,
  type ToolSetupStatus,
} from "@/lib/tool-setup";
import type { MentionTarget } from "@/lib/mentions";
import {
  correctionActionLabel,
  sendFailureMessage,
  type CorrectionAction,
  type SendFailureRecord,
} from "@/lib/send-failure";

import { downloadAsset, MediaPreviewer, type AnnotationOpenRequest } from "./media-previewer";
import { MessageReceiptGlyph } from "./message-receipt-glyph";
import { ToolSetupDialog } from "./tool-setup-dialog";

import { Badge } from "@/components/ui/badge";
import { IdAvatar } from "@/components/profile/id-avatar";
import { AttachmentCard } from "@/components/chat/attachment-card";
import { MarkdownView } from "@/components/chat/markdown-view";
import { fileGlyph, isPreviewable } from "@/components/chat/file-icon";
import { fallbackLinkPreview, LinkPreviewCard } from "@/components/chat/link-preview-card";
import { MediaAttachment } from "@/components/chat/media-attachment";
import { SiliconAudio } from "@/components/chat/silicon-audio";
import { RemoteBrowserCard } from "@/components/chat/remote-browser-card";
import { albumMediaItems } from "@/lib/albums";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const REACTION_EMOJI = ["❤️", "👍", "👎", "😂", "😊", "😢"] as const;
const SELECTABLE_FORWARD_TYPES = new Set<EventType>([
  "m.text",
  "m.image",
  "m.file",
  "m.album",
  "m.voice",
  "m.tts",
]);
const VISIBLE_SILICON_HOLD_SECONDS = 300;

/** Deterministic tilt in [-3, 3] degrees, hashed from a stable key so each
 *  pin keeps its angle across re-renders (a fresh Math.random would jitter on
 *  every paint). */
function pinTilt(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  // Map the hash to [-3, 3] with one decimal of variation.
  return Math.round(((Math.abs(h) % 61) / 10 - 3) * 10) / 10;
}

/**
 * A tilted card pin for an attachment that was sent alongside a text message.
 * Images/videos show a real thumbnail in the preview area; other files show a
 * large type icon. A footer row carries a small type-glyph + the filename.
 * Clicking previews supported attachments in place or downloads the rest.
 * The cards overlap and tilt over the top edge of the text bubble.
 */
function AttachmentPin({
  content,
  tilt,
  replyToEventId,
  roomId,
  annotationSourceEventId,
  onAttachAnnotations,
  onOpenAnnotation,
}: {
  content: Record<string, unknown>;
  tilt: number;
  replyToEventId?: string;
  roomId?: string;
  annotationSourceEventId?: string;
  onAttachAnnotations?: (draft: AnnotationDraft) => void;
  onOpenAnnotation?: (request: AnnotationOpenRequest) => void;
}) {
  const mediaId = String(content.media_id ?? "");
  const mime = String(content.mime ?? "").toLowerCase();
  const filename = String(content.filename ?? content.caption ?? "file");
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  const isPdf = mime.includes("pdf") || filename.toLowerCase().endsWith(".pdf");
  const isVisual = isImage || isVideo;
  const Icon = isVisual ? ImageSquare : fileGlyph(filename, mime);

  // Fetch the presigned URL once on mount so visual cards can show a real
  // thumbnail and so a click can preview in place without a fetch round-trip.
  // Seed from the session cache so scrolling back to a pin paints instantly.
  const [url, setUrl] = React.useState<string | null>(
    () => getCachedMedia(mediaId)?.download_url ?? null,
  );
  const [previewOpen, setPreviewOpen] = React.useState(false);
  React.useEffect(() => {
    if (!mediaId) return;
    if (getCachedMedia(mediaId)?.download_url) return; // already seeded
    let alive = true;
    api
      .mediaDetail(mediaId)
      .then((r) => {
        // Cache before the alive check so a fast scroll still warms it.
        setCachedMedia(mediaId, { media: r.media, download_url: r.download_url });
        if (!alive) return;
        setUrl(r.download_url ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mediaId]);

  // Mini first-page preview for PDFs, rendered once the presigned URL lands.
  const pdfThumb = usePdfThumbnail(isPdf ? url : null, mediaId, isPdf);
  const thumbnailUrl = isVisual ? url : isPdf ? pdfThumb : null;
  // Content peek for text/markdown/code files.
  const textLike = !isVisual && !isPdf && isTextLike(filename, mime);
  const textPeek = useTextSnippetState(textLike ? url : null, mediaId, textLike);
  const textPreviewLanguage = languageForFile(filename, mime)?.id;

  const canPreview = isPreviewable(filename, mime);
  const open = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!mediaId) return;
    // Make sure we have the presigned URL, then either preview in place
    // (image/video/audio/pdf/text) or download (zip, docx, …).
    let href = url;
    if (!href) {
      try {
        href = (await api.mediaDetail(mediaId)).download_url ?? null;
        if (href) setUrl(href);
      } catch {
        toast.error("couldn't open attachment");
        return;
      }
    }
    if (!href) return;
    if (canPreview) setPreviewOpen(true);
    else downloadAsset(href, filename, { mediaId });
  };

  return (
    <>
      <AttachmentCard
        glyph={Icon}
        filename={filename}
        thumbnailUrl={thumbnailUrl}
        isVideo={isVideo}
        textPreview={textPeek.text}
        textPreviewFormat={
          textPreviewLanguage === "markdown"
            ? "markdown"
            : textPreviewLanguage === "csv"
              ? "csv"
              : "plain"
        }
        textPreviewLoading={textPreviewLanguage === "csv" && (textPeek.loading || !url)}
        tilt={tilt}
        onClick={open}
      />
      {url && (
        <MediaPreviewer
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          url={url}
          mime={mime}
          filename={filename}
          replyToEventId={replyToEventId}
          roomId={roomId}
          sourceMediaId={mediaId}
          sourceEventId={annotationSourceEventId}
          onAttachAnnotations={onAttachAnnotations}
          onOpenAnnotation={onOpenAnnotation}
        />
      )}
    </>
  );
}

export type MessageStatus = MessageReceiptStatus;

interface Props {
  event: Event;
  isMine: boolean;
  /** Collapsed manager work history grouped with, but outside, the message bubble. */
  managerActivity?: React.ReactNode;
  /** My own handle — used to highlight reactions I've already given. */
  myHandle?: string | null;
  /** The message this one is replying to, if any — rendered as a quote. */
  replyToEvent?: Event;
  /** Jump to the replied-to event, loading older history if needed. */
  onJumpToEvent?: (eventId: string) => void;
  /** Per-reply lookup state surfaced inline in the preview. */
  replyJumpState?: { status: "loading" | "continue" | "error"; message?: string };
  isOwnSilicon?: boolean;
  onTakeBack?: (eventId: string, force?: boolean) => void;
  /** Send-receipt for messages this Carbon authored. Ignored for received messages. */
  status?: MessageStatus;
  /** The Silicon hold is waiting on typing/editing, so its ETA is not active. */
  holdCountdownPaused?: boolean;
  /** Photo URL for the sender — used when rendering the message-side avatar. */
  senderPhotoUrl?: string | null;
  /** Delights §0a — colored ASCII treatment for the sender's avatar. */
  senderAsciiUrl?: string | null;
  senderAvatarKind?: "carbon" | "silicon" | "system";
  /** Saved-contact display name for the sender, when the user set one. */
  senderDisplayName?: string | null;
  /** Click on the avatar/profile chip opens the sender's profile. */
  onSenderClick?: (sender: { kind: "carbon" | "silicon"; handle: string }) => void;
  /**
   * Set by the parent based on whether this message is the *last* in a
   * (sender, minute) group. When false, we skip the meta row entirely —
   * earlier messages in the same minute share the time + receipt rendered
   * on the last bubble in the run.
   */
  showTime?: boolean;
  /** First bubble of a (received) sender run renders the avatar + handle. */
  showSender?: boolean;
  /** When true the @handle line is dropped — there's only one peer. */
  isDirect?: boolean;
  /** Per-event reactions, keyed by emoji → list of handles who reacted. */
  reactions?: Record<string, string[]>;
  /** Set this event as the active reply target on the composer. */
  onReply?: (event: Event) => void;
  /** Toggle one of REACTION_EMOJI on this event. */
  onReact?: (event: Event, emoji: string) => void;
  /** Open a forward picker (a no-op stub today). */
  onForward?: (event: Event) => void;
  /** Open the safety report flow for a received authoritative event. */
  onReport?: (event: Event) => void;
  /** Enter multi-select mode with this message pre-selected (options menu). */
  onSelect?: (event: Event) => void;
  /** True while the room is in multi-select mode. */
  selectMode?: boolean;
  /** Whether this message is currently in the selection set. */
  selected?: boolean;
  /** Toggle this message's membership in the selection set. */
  onToggleSelect?: (event: Event) => void;
  /** Unsend this message when the backend read/delivery window allows it. */
  onDelete?: (event: Event) => void;
  /** Re-send a failed message (same client id — the server dedupes). When set,
   *  the failed receipt becomes a tap-to-retry affordance. */
  onRetry?: (event: Event) => void;
  /** Persisted structured failure details. */
  failure?: SendFailureRecord;
  failureMessage?: string;
  onCorrection?: (event: Event, action: CorrectionAction) => void;
  /** Load this message back into the composer for editing. */
  onEdit?: (event: Event) => void;
  /** Attachment events sent alongside this text message — rendered as tilted
   *  pins over the bubble instead of as their own standalone bubbles. */
  pinnedAttachments?: Event[];
  /** Real people that should be linked when mentioned as @handle/@name. */
  mentionTargets?: MentionTarget[];
  onMentionClick?: (target: MentionTarget) => void;
  roomId?: string;
  onAttachAnnotations?: (draft: AnnotationDraft) => void;
  onOpenAnnotation?: (request: AnnotationOpenRequest) => void;
}

export function MessageBubble({
  event,
  isMine,
  managerActivity,
  myHandle,
  replyToEvent,
  onJumpToEvent,
  replyJumpState,
  isOwnSilicon,
  onTakeBack,
  status,
  holdCountdownPaused = false,
  senderPhotoUrl,
  senderAsciiUrl,
  senderAvatarKind,
  senderDisplayName,
  onSenderClick,
  showTime = true,
  showSender = true,
  isDirect = false,
  reactions,
  onReply,
  onReact,
  onForward,
  onReport,
  onSelect,
  onDelete,
  onRetry,
  failure,
  failureMessage,
  onCorrection,
  onEdit,
  selectMode = false,
  selected = false,
  onToggleSelect,
  pinnedAttachments,
  mentionTargets,
  onMentionClick,
  roomId,
  onAttachAnnotations,
  onOpenAnnotation,
}: Props) {
  // §4c — flash the bubble briefly when its text is copied. Declared before any
  // early return so the Hook order is stable across render branches.
  const [copyFlash, setCopyFlash] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const triggerCopyFlash = React.useCallback(() => {
    setCopyFlash(false);
    requestAnimationFrame(() => setCopyFlash(true));
    window.setTimeout(() => setCopyFlash(false), 320);
  }, []);
  if (event.type === "m.system") {
    return (
      <div className="my-2 flex justify-center">
        <Badge variant="secondary">{String(event.content.body ?? "system event")}</Badge>
      </div>
    );
  }
  if (event.type === "m.session_marker") {
    const action = String(event.content.action ?? "new");
    return (
      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <div className="text-xs text-muted-foreground">
          session {action} {event.content.summary ? `· ${event.content.summary}` : ""}
        </div>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }
  const redacted = event.redacted_at !== null;
  const toolSetupRequest = redacted ? null : toolSetupRequestFromEvent(event);
  // §1.3 — only text/tts can stream; never show the pill for non-streamable
  // types whose `is_final` happens to be false (e.g. a media event).
  const mightStream =
    !toolSetupRequest
    && (event.type === "m.text" || event.type === "m.tts")
    && !event.is_final;
  // Prefer the sender's handle (carbon username == carbon_id, or silicon name);
  // fall back to the kind only if we don't have it (e.g. system events).
  const senderLabel = senderDisplayName?.trim()
    ? senderDisplayName.trim()
    : event.sender_handle
    ? `@${event.sender_handle}`
    : event.sender_kind === "silicon"
      ? "Silicon"
      : event.sender_kind === "carbon"
        ? "Carbon"
        : "system";
  const senderHandle = event.sender_handle ?? "";
  const senderKind = event.sender_kind === "silicon" ? "silicon" : "carbon";
  const handleAvatarClick = () => {
    if (!senderHandle) return;
    if (event.sender_kind !== "carbon" && event.sender_kind !== "silicon") return;
    onSenderClick?.({ kind: senderKind, handle: senderHandle });
  };

  // Which of the quick-reaction emojis I've already given on this message —
  // drives the filled/active state in the picker and the chips. Plain compute
  // (not a hook) since this component early-returns above for system events.
  const myReactionEmojis = new Set<string>();
  if (myHandle && reactions) {
    for (const [emoji, who] of Object.entries(reactions)) {
      if (who.includes(myHandle)) myReactionEmojis.add(emoji);
    }
  }

  // Vertical rhythm: a larger top margin ONLY on the first bubble of a group
  // (where the avatar/handle shows) to separate it from the previous turn;
  // every other bubble keeps a uniform tight margin. Using my-1.5 on both the
  // first AND last bubble of a group (the old `!showSender && !showTime`) made
  // the gap after the first and before the last bubble bigger than the gaps
  // between middle bubbles — visibly inconsistent.

  // Message actions are reached via the 3-dot button (and the hover reply/react
  // buttons) only — no right-click takeover, no double-click. `moreOpen` is the
  // controlled state for that dropdown.
  const canForward =
    !toolSetupRequest
    && SELECTABLE_FORWARD_TYPES.has(event.type)
    && event.is_final !== false
    && !redacted;
  // Failure details are attempt-local. Once a message has any accepted/
  // delivered/read state they must not keep a stale correction menu alive.
  const actionableFailure =
    status === "failed" || status === "challenge" ? failure : undefined;
  const hasActions =
    !redacted &&
      !!(onReply ||
      onReact ||
      onEdit ||
      (onForward && canForward) ||
      onDelete ||
      (status === "failed" && onRetry) ||
      (onSelect && canForward) ||
      (actionableFailure?.correctionActions.length && onCorrection));
  // Multi-select eligibility mirrors the forward gate: a real, settled,
  // non-deleted bubble whose type the backend forward endpoint supports.
  // Streaming/optimistic (`is_final === false`) and deleted messages are never
  // selectable. (m.system / m.session_marker already early-return above.)
  const selectable = !!onToggleSelect && canForward;
  const inSelect = selectMode && selectable;

  // Emoji-only messages render large and WITHOUT a filled bubble. Replies,
  // forwards, link previews, and any emoji mixed with text retain the normal
  // message treatment.
  const emojiBody =
    event.type === "m.text" ? String(event.content.body ?? "").replace(/^\s+|\s+$/g, "") : "";
  const emojiMeta = emojiOnly(emojiBody);
  const soloEmoji =
    event.type === "m.text" &&
    !redacted &&
    !toolSetupRequest &&
    // Base the reply exclusion on the event field, not the resolved parent:
    // `replyToEvent` is undefined when the parent isn't loaded in `eventById`,
    // which would otherwise let a reply render bare/big (QA hold on #125).
    !event.reply_to_event_id &&
    !event.link_preview &&
    // ANY forward_from object keeps the normal bubble — including a forward
    // whose sender_handle is missing/empty.
    !(event.content as { forward_from?: unknown }).forward_from &&
    emojiMeta.ok;
  const bareGif =
    event.type === "m.image" &&
    !redacted &&
    isGifMedia(event.content.mime, event.content.filename);
  const holdReleaseAt =
    typeof event.content.hold_release_at === "string"
      ? event.content.hold_release_at
      : null;
  const showHeldCountdown =
    isMine && status === "pending" && Boolean(holdReleaseAt) && !holdCountdownPaused;
  const showPausedHoldClock =
    isMine && status === "pending" && Boolean(holdReleaseAt) && holdCountdownPaused;

  return (
    <div
      className={cn(
        // `group` on the full-width row so hovering anywhere in the row —
        // bubble, avatar gutter, or the empty space beside it — reveals the
        // actions, not just the bubble itself.
        "group flex w-full gap-2 mb-0.5",
        showSender ? "mt-1.5" : "mt-0.5",
        isMine ? "justify-end" : "justify-start",
        // In select-mode the whole row is a big toggle target; suppress text
        // selection so a click reads as "select", not "highlight".
        inSelect && "cursor-pointer select-none",
      )}
      // Capture before quotes, links, media, mentions, avatars, or menus can
      // consume the click. In selection flow the whole row is one Telegram-
      // style toggle target, so the same gesture selects and deselects.
      onClickCapture={inSelect ? (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        onToggleSelect?.(event);
      } : undefined}
    >
      {selectMode && (
        // Leading select affordance, shown for every bubble while in select-
        // mode. Eligible bubbles get a real checkbox; ineligible ones (system
        // rows early-return above; streaming/deleted are handled here) get a
        // blank spacer so the timeline doesn't shift horizontally.
        <div className="mt-1 flex w-5 shrink-0 items-center justify-center">
          {selectable && (
            <span
              aria-hidden
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40",
              )}
            >
              {selected && <Check className="h-3 w-3" weight="bold" />}
            </span>
          )}
        </div>
      )}
      {!isMine && (
        // Avatar slot stays present even on middle-of-group bubbles so the
        // text aligns vertically; we just hide the actual mark when it's
        // not the first message in the run.
        <div className="mt-1 w-7 shrink-0">
          {showSender && (
            <button
              type="button"
              onClick={handleAvatarClick}
              aria-label={senderDisplayName || senderHandle ? `${senderDisplayName || senderHandle} - profile` : "profile"}
              className="block transition-opacity hover:opacity-80"
            >
              <IdAvatar
                seed={senderHandle || "?"}
                src={senderPhotoUrl}
                asciiSrc={senderAsciiUrl}
                size={28}
                family={senderAvatarKind === "silicon" ? "silicon" : "carbon"}
              />
            </button>
          )}
        </div>
      )}
      <div className={cn("min-w-0 max-w-[70%] space-y-1", isMine && "items-end")}>
        {/* Sender label on the first received bubble of a run only. Skipped
            entirely in a direct (1-on-1) room since the peer is implicit. */}
        {!isMine && showSender && !isDirect && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{senderLabel}</span>
          </div>
        )}
        {managerActivity ? (
          <div
            className="max-w-full"
            data-manager-activity-grouped="true"
          >
            {managerActivity}
          </div>
        ) : null}
        {/* §2 — attachments sent with this text peek over the bubble's top edge
            as tilted bookmarks; the negative margin tucks them onto the bubble. */}
        {pinnedAttachments && pinnedAttachments.length > 0 && (
          <div
            className={cn(
              "relative z-10 -mb-2 flex flex-wrap gap-1.5 px-1",
              isMine ? "justify-end" : "justify-start",
              // In select-mode a click anywhere on the row must toggle the
              // whole bundle; disable the pins' own open/preview handlers so
              // they don't swallow the click (and can't be opened mid-select).
              inSelect && "pointer-events-none",
            )}
          >
            {pinnedAttachments.map((att, idx) => (
              <AttachmentPin
                key={att.event_id || idx}
                content={att.content as Record<string, unknown>}
                tilt={pinTilt(att.event_id || String(idx))}
                replyToEventId={event.event_id}
                roomId={roomId}
                annotationSourceEventId={att.event_id}
                onAttachAnnotations={onAttachAnnotations}
                onOpenAnnotation={onOpenAnnotation}
              />
            ))}
          </div>
        )}
        <div
          data-message-bubble="true"
          className={cn(
            // Symmetric p-3 padding so an inline image/file inside the bubble
            // has equal whitespace on top and left (previously px-3 py-2 left
            // visible asymmetry around media attachments). `group` lives on the
            // message column wrapper so hovering anywhere on the block (bubble,
            // padding, label, time) reveals the actions — not just the text.
            "relative min-w-0 max-w-full",
            !inSelect && "select-text",
            // Lone emoji and GIFs render bare: no bubble background, frame, or
            // padding around the visual itself.
            soloEmoji || bareGif ? "py-0.5" : "p-3 text-sm shadow-sm",
            copyFlash && "copy-flash",
            // Selected bubbles get a highlight ring in select-mode.
            selected && "ring-2 ring-primary",
            !soloEmoji &&
              !bareGif &&
              (redacted
                ? "border bg-muted text-muted-foreground italic"
                : isMine
                  // `bubble-sent` carries a dedicated ::selection rule in
                  // globals.css — the global highlight is ink, which vanishes
                  // into this ink bubble, so we reverse it to cream-on-ink there.
                  // (A Tailwind `selection:` utility can't win against the
                  // unlayered global ::selection rule, hence the explicit class.)
                  ? "bubble-sent bg-primary text-primary-foreground"
                  : "bg-bubble-received"),
          )}
        >
          {/* Quoted parent: clickable backlink to the original message. */}
          {event.reply_to_event_id && !redacted && (
            <ReplyPreviewButton
              replyToEvent={replyToEvent}
              targetId={event.reply_to_event_id}
              state={replyJumpState}
              onJump={onJumpToEvent}
              isMine={isMine}
            />
          )}
          {redacted ? (
            <span className="italic">message deleted</span>
          ) : (
            <Body
              event={event}
              isMine={isMine}
              soloEmoji={soloEmoji}
              mentionTargets={mentionTargets}
              onMentionClick={onMentionClick}
              roomId={roomId}
              onAttachAnnotations={onAttachAnnotations}
              onOpenAnnotation={onOpenAnnotation}
            />
          )}

          {/* Hover actions: reply / react / more. Floats above the bubble on
              hover; on mobile, tap-to-reveal is not supported here — a small-
              screen affordance is a follow-up. */}
          {/* Hover actions are suppressed while selecting — the row is a toggle. */}
          {hasActions && !selectMode && (
            <BubbleActions
              event={event}
              isMine={isMine}
              isOwnSilicon={!!isOwnSilicon}
              canForward={canForward}
              myReactions={myReactionEmojis}
              moreOpen={moreOpen}
              onMoreOpenChange={setMoreOpen}
              onReply={redacted ? undefined : onReply}
              onReact={redacted ? undefined : onReact}
              onForward={redacted ? undefined : onForward}
              onReport={redacted ? undefined : onReport}
              onSelect={!redacted && selectable ? onSelect : undefined}
              onEdit={redacted ? undefined : onEdit}
              onDelete={redacted ? undefined : onDelete}
              onTakeBack={onTakeBack}
              onCopied={triggerCopyFlash}
              failure={actionableFailure}
              onRetry={status === "failed" ? onRetry : undefined}
              onCorrection={onCorrection}
            />
          )}
        </div>

        {/* Reaction chips — surfaced under the bubble, grouped by emoji. */}
        {reactions && Object.keys(reactions).length > 0 && (
          <div className={cn("flex flex-wrap gap-1", isMine && "justify-end", inSelect && "pointer-events-none")}>
            {Object.entries(reactions).map(([emoji, who]) => {
              const reactedByMe = !!myHandle && who.includes(myHandle);
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onReact?.(event, emoji)}
                  title={`${who.join(", ")}${reactedByMe ? " · click to remove" : ""}`}
                  className={cn(
                    "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] transition-colors",
                    reactedByMe
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card hover:bg-accent",
                  )}
                >
                  <span className="emoji-glyph">{emoji}</span>
                  <span className="font-mono opacity-70">{who.length}</span>
                </button>
              );
            })}
          </div>
        )}
        {/* Time + receipt — rendered only on the last bubble of a (sender,
            minute) run, so a quick back-to-back exchange shows one common
            timestamp instead of one per line. Streaming indicator escapes
            the gate because it's a live state, not historical metadata. */}
        {(showTime ||
          showHeldCountdown ||
          showPausedHoldClock ||
          status === "failed" ||
          status === "resolving" ||
          status === "retry_wait" ||
          status === "retrying" ||
          status === "challenge" ||
          mightStream ||
          eventShowsEdited(event)) && (
          // Reserve only vertical space in normal flow. The status itself is
          // absolutely anchored to the message edge, so labels such as
          // "sending in 5" cannot widen a short bubble or make it pulse as
          // the countdown text changes.
          <div className="relative h-4">
            <div
              className={cn(
                "absolute top-0 flex items-center gap-1.5 whitespace-nowrap text-[10px] text-muted-foreground",
                isMine ? "right-0" : "left-0",
              )}
            >
              {showHeldCountdown && holdReleaseAt ? (
                <HeldSendCountdown releaseAt={holdReleaseAt} />
              ) : (
                showTime && !showPausedHoldClock && <HoverTime iso={event.created_at} />
              )}
              {eventShowsEdited(event) && <span>edited</span>}
              {(showTime ||
                showPausedHoldClock ||
                status === "failed" ||
                status === "resolving" ||
                status === "retry_wait" ||
                status === "retrying" ||
                status === "challenge") &&
                isMine && status && !showHeldCountdown && (
                status === "failed" && onRetry ? (
                  // Failed → the receipt becomes tap-to-retry (same clientId,
                  // so server-side idempotency guarantees no duplicate).
                  <button
                    type="button"
                    onClick={() => onRetry(event)}
                    title="send failed — click to retry"
                    className="inline-flex items-center gap-1 text-destructive transition-colors hover:underline"
                  >
                    <Receipt status={status} />
                    <span>retry</span>
                  </button>
                ) : status === "failed" && failure ? (
                  <span
                    className="inline-flex items-center gap-1 text-destructive"
                    role="status"
                    aria-live="polite"
                    title={failureMessage ?? sendFailureMessage(failure)}
                  >
                    <Receipt status={status} />
                    <span>needs attention</span>
                  </span>
                ) : status === "resolving" ? (
                  <span className="inline-flex items-center gap-1" role="status" aria-live="polite">
                    <Receipt status={status} />
                    <span>waiting</span>
                  </span>
                ) : status === "retry_wait" ? (
                  <span className="inline-flex items-center gap-1" role="status" aria-live="polite">
                    <Receipt status={status} />
                    <span>waiting</span>
                  </span>
                ) : status === "retrying" ? (
                  <span className="inline-flex items-center gap-1" role="status" aria-live="polite">
                    <Receipt status={status} />
                    <span>waiting</span>
                  </span>
                ) : status === "challenge" && failure?.correctionActions[0] && onCorrection ? (
                  <button
                    type="button"
                    onClick={() => onCorrection(event, failure.correctionActions[0])}
                    title={failureMessage ?? sendFailureMessage(failure)}
                    className="inline-flex items-center gap-1 text-destructive transition-colors hover:underline"
                  >
                    <Receipt status={status} />
                    <span>{failureMessage ?? correctionActionLabel(failure.correctionActions[0])}</span>
                  </button>
                ) : status === "challenge" ? (
                  <span
                    className="inline-flex items-center gap-1 text-destructive"
                    role="status"
                    aria-live="polite"
                  >
                    <Receipt status={status} />
                    <span>{failureMessage ?? "verification required"}</span>
                  </span>
                ) : (
                  <Receipt status={status} />
                )
              )}
              {mightStream && <StreamingPill body={String(event.content.body ?? "")} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Floating action bar revealed on hover. Three controls:
 *   • Reply       — sets the message as the composer's reply target.
 *   • React       — popover with six reactions, fires onReact(event, emoji).
 *   • More (⋮)    — dropdown with copy text, forward, delete (self, 5 min),
 *                   take-back (Silicon-only path, only when isOwnSilicon).
 *
 * Positioned outside the bubble's rounded corner so it doesn't sit on top
 * of the message content; flips edge based on who sent the message.
 */
function BubbleActions({
  event,
  isMine,
  isOwnSilicon,
  canForward,
  myReactions,
  moreOpen,
  onMoreOpenChange,
  onReply,
  onReact,
  onForward,
  onReport,
  onSelect,
  onEdit,
  onDelete,
  onTakeBack,
  onCopied,
  failure,
  onRetry,
  onCorrection,
}: {
  event: Event;
  isMine: boolean;
  isOwnSilicon: boolean;
  canForward: boolean;
  myReactions: Set<string>;
  /** Controlled open state for the "more" dropdown — shared with the bubble's
   *  right-click / double-click gestures so all three open the same menu. */
  moreOpen: boolean;
  onMoreOpenChange: (open: boolean) => void;
  onReply?: (event: Event) => void;
  onReact?: (event: Event, emoji: string) => void;
  onForward?: (event: Event) => void;
  onReport?: (event: Event) => void;
  onSelect?: (event: Event) => void;
  onEdit?: (event: Event) => void;
  onDelete?: (event: Event) => void;
  onTakeBack?: (eventId: string, force?: boolean) => void;
  onCopied?: () => void;
  failure?: SendFailureRecord;
  onRetry?: (event: Event) => void;
  onCorrection?: (event: Event, action: CorrectionAction) => void;
}) {
  const canDelete = isMine && !!onDelete;
  const canTakeBack = isMine && isOwnSilicon;
  const canEdit = canForward && isMine && !!onEdit && editableTextForEvent(event) !== null;
  // Session repair is an app-level recovery operation, never a valid action
  // on one message. In particular, a message menu must never offer "sign in".
  const correctionActions = (failure?.correctionActions ?? []).filter(
    (action) => action !== "repair_session",
  );
  const textBody = event.type === "m.text" ? String(event.content.body ?? "") : "";
  const handleCopy = async () => {
    // §7.1 — copyText handles insecure contexts (LAN/http) with an execCommand
    // fallback and only resolves true on a real copy.
    if (await copyText(textBody)) {
      onCopied?.(); // §4c — flash the bubble
      toast.success("text copied");
    } else toast.error("couldn't copy");
  };
  // Media messages (voice/file/image/…) expose download here in the options
  // menu rather than inline next to the player.
  const mediaContent = event.content as {
    media_id?: unknown;
    mime?: unknown;
    filename?: unknown;
  };
  const hasMedia = Boolean(mediaContent.media_id);
  const hasDownloadableMedia =
    hasMedia && !(event.type === "m.image" && isGifMedia(mediaContent.mime, mediaContent.filename));
  const handleDownload = async () => {
    try {
      const mediaId = String((event.content as { media_id?: unknown }).media_id);
      const r = await api.mediaDetail(mediaId);
      if (!r.download_url) return;
      const name =
        String((event.content as { caption?: unknown }).caption || "") ||
        event.type.replace("m.", "") ||
        "download";
      downloadAsset(r.download_url, name, {
        mediaId,
        attachmentUrl: r.attachment_url,
      });
    } catch {
      toast.error("couldn't download");
    }
  };
  // Keep the bar shown while ANY menu/popover spawned from it is open.
  // Otherwise moving the cursor toward the menu leaves the bubble's :hover, the
  // bar flips to display:none, and Radix loses the trigger's layout box — so the
  // menu re-anchors to the top-left (0,0). A counter (not a boolean) survives
  // the overlap when opening one menu auto-closes the other: the close fires
  // -1 while the open fired +1, so the bar never blinks hidden in between.
  const [openMenus, setOpenMenus] = React.useState(0);
  const onMenuOpenChange = React.useCallback(
    (open: boolean) => setOpenMenus((n) => Math.max(0, n + (open ? 1 : -1))),
    [],
  );
  // Keep the bar visible while the reaction popover OR the shared "more" menu is
  // open (the latter can be triggered from the bubble itself, not just here).
  const menuOpen = openMenus > 0 || moreOpen;
  return (
    <div
      className={cn(
        // Float beside the bubble (vertically centered) instead of on top:
        // received → just right of the bubble, sent → just left of it (mirrored
        // so it never runs off the right edge).
        "message-actions absolute top-1/2 z-10 flex -translate-y-1/2 gap-0.5 border bg-card p-0.5 transition-opacity",
        // Keep actions in the keyboard accessibility tree. Tabbing to the
        // first action reveals the bar through :focus-within; pointer users
        // still get the same hover behavior.
        menuOpen
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
        isMine ? "right-full mr-2" : "left-full ml-2",
      )}
      // Stop propagation so an action click doesn't double-fire onDoubleClick
      // on the bubble.
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {onReply && (
        <ActionIconButton title="reply" onClick={() => onReply(event)}>
          <ArrowBendUpLeft />
        </ActionIconButton>
      )}
      {onReact && (
        <Popover onOpenChange={onMenuOpenChange}>
          <PopoverTrigger asChild>
            <ActionIconButton title="react">
              <Smiley />
            </ActionIconButton>
          </PopoverTrigger>
          <PopoverContent
            align={isMine ? "end" : "start"}
            sideOffset={6}
            className="w-auto !p-0.5"
          >
            <div className="flex items-center gap-0.5">
              {REACTION_EMOJI.map((e) => {
                const active = myReactions.has(e);
                return (
                  // PopoverClose closes the picker the moment a reaction is
                  // chosen — re-open it with another click if needed.
                  <PopoverClose asChild key={e}>
                    <button
                      type="button"
                      onClick={() => onReact(event, e)}
                      className={cn(
                        "emoji-glyph inline-flex h-7 w-7 items-center justify-center text-base transition-colors",
                        active ? "bg-primary" : "hover:bg-accent",
                      )}
                      title={active ? `remove ${e}` : `react ${e}`}
                    >
                      {e}
                    </button>
                  </PopoverClose>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
      <DropdownMenu open={moreOpen} onOpenChange={onMoreOpenChange}>
        <DropdownMenuTrigger asChild>
          <ActionIconButton title="more options">
            <DotsThree />
          </ActionIconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={isMine ? "end" : "start"}>
          {textBody && (
            <DropdownMenuItem onClick={handleCopy}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              copy text
            </DropdownMenuItem>
          )}
          {onReply && (
            <DropdownMenuItem onClick={() => onReply(event)}>
              <ArrowBendUpLeft className="mr-2 h-3.5 w-3.5" />
              reply
            </DropdownMenuItem>
          )}
          {canEdit && (
            <DropdownMenuItem onClick={() => onEdit(event)}>
              <PencilSimple className="mr-2 h-3.5 w-3.5" />
              edit
            </DropdownMenuItem>
          )}
          {onForward && canForward && (
            <DropdownMenuItem onClick={() => onForward(event)}>
              <Share className="mr-2 h-3.5 w-3.5" />
              forward
            </DropdownMenuItem>
          )}
          {onSelect && canForward && (
            <DropdownMenuItem onClick={() => onSelect(event)}>
              <ListChecks className="mr-2 h-3.5 w-3.5" />
              select
            </DropdownMenuItem>
          )}
          {hasDownloadableMedia && (
            <DropdownMenuItem onClick={handleDownload}>
              <DownloadSimple className="mr-2 h-3.5 w-3.5" />
              download
            </DropdownMenuItem>
          )}
          {!isMine && onReport && (event.sender_kind === "carbon" || event.sender_kind === "silicon") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onReport(event)}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive"
              >
                <Flag className="mr-2 h-3.5 w-3.5" />
                report message
              </DropdownMenuItem>
            </>
          )}
          {(onRetry || (onCorrection && correctionActions.length > 0)) && (
            <>
              <DropdownMenuSeparator />
              {onRetry && (
                <DropdownMenuItem onClick={() => onRetry(event)}>
                  <ArrowClockwise className="mr-2 h-3.5 w-3.5" />
                  retry
                </DropdownMenuItem>
              )}
              {correctionActions.map((action) => (
                <DropdownMenuItem
                  key={action}
                  onClick={() => onCorrection?.(event, action)}
                  className={action === "discard_local" ? "text-destructive" : undefined}
                >
                  {action === "discard_local" ? (
                    <Trash className="mr-2 h-3.5 w-3.5" />
                  ) : (
                    <WarningCircle className="mr-2 h-3.5 w-3.5" />
                  )}
                  {correctionActionLabel(action)}
                </DropdownMenuItem>
              ))}
            </>
          )}
          {(canDelete || canTakeBack) && <DropdownMenuSeparator />}
          {canDelete && onDelete && (
            <DropdownMenuItem
              onClick={() => onDelete(event)}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <Trash className="mr-2 h-3.5 w-3.5" />
              {event.event_id.startsWith("temp-") ? "cancel send" : "unsend"}
            </DropdownMenuItem>
          )}
          {canTakeBack && onTakeBack && (
            <>
              <DropdownMenuItem onClick={() => onTakeBack(event.event_id)}>
                <Trash className="mr-2 h-3.5 w-3.5" />
                take back (if unread)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onTakeBack(event.event_id, true)}>
                <Trash className="mr-2 h-3.5 w-3.5" />
                take back (force)
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Telegram-style chip rendered above a forwarded bubble's body. */
function ForwardedFromChip({ handle, isMine }: { handle: string; isMine?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 border-l-2 pl-2 py-0.5 text-[10px]",
        // On the ink "mine" bubble the dark foreground color vanishes — flip to
        // the cream primary-foreground so the chip stays legible.
        isMine
          ? "border-primary-foreground/50 bg-primary-foreground/10 text-primary-foreground/90"
          : "border-foreground/40 bg-foreground/5 text-foreground/80",
      )}
    >
      <Share className="h-3 w-3 opacity-60" />
      <span>
        Forwarded from <span className="font-medium">@{handle}</span>
      </span>
    </div>
  );
}

const ActionIconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }
>(({ children, title, className, ...rest }, ref) => (
  <button
    ref={ref}
    type="button"
    title={title}
    aria-label={title}
    className={cn(
      "inline-flex h-6 w-6 items-center justify-center text-foreground/70 transition-colors hover:bg-accent hover:text-foreground [&_svg]:h-3.5 [&_svg]:w-3.5",
      className,
    )}
    {...rest}
  >
    {children}
  </button>
));
ActionIconButton.displayName = "ActionIconButton";

/**
 * WhatsApp/Telegram-style send-state pip rendered next to the timestamp on
 * my own messages.
 *   • pending   → single ✓, low opacity (POST in flight)
 *   • sent      → single ✓ (server acked)
 *   • delivered → double ✓ (WS broadcast confirms it's been distributed)
 *   • read      → double ✓ in success green (peer issued a read_receipt)
 *   • failed    → a small alert (POST errored, retry on next send)
 */
/**
 * §1.3 — the "streaming…" pill, with IMPLICIT finalization. The server flips a
 * stream to final with an `event.final` frame; if that frame is dropped (a
 * reconnect gap, frame coalescing) the bubble would otherwise read "streaming…"
 * forever even though the text is complete. We treat ~5s with no new delta as
 * done and stop showing the pill.
 */
const STREAM_IDLE_MS = 5000;
function StreamingPill({ body }: { body: string }) {
  const [idleBody, setIdleBody] = React.useState<string | null>(null);
  React.useEffect(() => {
    const t = window.setTimeout(() => setIdleBody(body), STREAM_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [body]);
  if (idleBody === body) return null;
  return <span className="text-primary">streaming…</span>;
}

// §4b — hovering the timestamp ("5 mins ago" / "2:07 PM") reveals the full
// absolute date+time inline.
function HoverTime({ iso }: { iso: string }) {
  const [hover, setHover] = React.useState(false);
  const absolute = React.useMemo(() => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  }, [iso]);
  return (
    <span
      className="cursor-default tabular-nums transition-opacity"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {hover && absolute ? absolute : messageTime(iso)}
    </span>
  );
}

function HeldSendCountdown({ releaseAt }: { releaseAt: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [releaseAt]);
  const deadline = Date.parse(releaseAt);
  const seconds = Number.isFinite(deadline)
    ? Math.min(
        VISIBLE_SILICON_HOLD_SECONDS,
        Math.max(0, Math.ceil((deadline - now) / 1000)),
      )
    : 0;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <Clock className="h-3 w-3 opacity-60" aria-hidden="true" />
      {seconds > 0 ? `waiting · ${seconds}s` : "waiting…"}
    </span>
  );
}

function Receipt({ status }: { status: MessageStatus }) {
  // Match the full height of the metadata rail so the receipt reads as part of
  // the timestamp instead of a tiny mark floating beside it.
  return <MessageReceiptGlyph status={status} className="h-4 w-4 shrink-0" />;
}

/** One-line preview of a quoted (replied-to) message. */
function replyPreview(ev: Event): string {
  if (ev.redacted_at) return "deleted message";
  const c = ev.content as Record<string, unknown>;
  switch (ev.type) {
    case "m.text":
      return String(c.body ?? "");
    case "m.image": {
      const caption = c.caption ? String(c.caption) : "";
      if (isGifMedia(c.mime, c.filename)) return caption ? `GIF · ${caption}` : "GIF";
      return caption || "photo";
    }
    case "m.file":
      return c.filename ? String(c.filename) : c.caption ? String(c.caption) : "attachment";
    case "m.album":
      return c.caption ? String(c.caption) : "attachments";
    case "m.voice":
      return c.transcript ? String(c.transcript) : "voice note";
    case "m.remote_browser":
      return "Silicon Browser link";
    case "m.tts":
      return c.text ? String(c.text) : "audio";
    case "m.work_task":
    case "m.work_event":
      return workEventPreview(ev) ?? "work update";
    default:
      return "message";
  }
}

/** Failed/restored voice sends do not have a server media_id yet, but their
 * exact Blob remains in the durable media journal. Render that source through
 * the normal compact player instead of degrading to a generic music label. */
function DurableVoiceAttachment({
  event,
  peaks,
}: {
  event: Event;
  peaks: number[] | null;
}) {
  const clientId = (event as Event & { _clientId?: string })._clientId;
  const owner = authStore.getCarbon()?.carbon_id;
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    if (!owner || !clientId) return;
    void readMediaUpload(`carbon:${owner}`, clientId).then((stored) => {
      if (!alive || !stored?.blob) return;
      objectUrl = URL.createObjectURL(stored.blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [clientId, owner]);
  return (
    <SiliconAudio
      url={url}
      peaks={peaks}
      durationMs={typeof event.content.duration_ms === "number" ? event.content.duration_ms : null}
      className="w-full max-w-[20rem]"
    />
  );
}

/** A few words of the voice transcript, with a "View transcript" link that
 *  opens the full text in a small modal. */
function VoiceTranscript({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  const words = text.trim().split(/\s+/);
  const truncated = words.length > 6;
  const preview = words.slice(0, 6).join(" ");
  return (
    <div className="flex items-center gap-1.5 text-xs opacity-70">
      <span className="min-w-0 truncate italic">
        “{preview}{truncated ? "…" : ""}”
      </span>
      {truncated && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
            className="shrink-0 whitespace-nowrap underline underline-offset-2 hover:opacity-80"
          >
            View transcript
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Transcript</DialogTitle>
              </DialogHeader>
              <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
                {text}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

function replyVoiceLabel(ev: Event): string {
  const c = ev.content as Record<string, unknown>;
  const duration = typeof c.duration_ms === "number" ? Math.round(c.duration_ms / 1000) : null;
  if (!duration || duration < 1) return "Voice message";
  const m = Math.floor(duration / 60);
  const s = String(duration % 60).padStart(2, "0");
  return `Voice message · ${m}:${s}`;
}

function ReplyPreviewButton({
  replyToEvent,
  targetId,
  state,
  onJump,
  isMine,
}: {
  replyToEvent?: Event;
  targetId: string;
  state?: { status: "loading" | "continue" | "error"; message?: string };
  onJump?: (eventId: string) => void;
  isMine: boolean;
}) {
  const sender = replyToEvent?.sender_handle ? `@${replyToEvent.sender_handle}` : "message";
  const label = replyToEvent
    ? replyToEvent.type === "m.voice"
      ? replyVoiceLabel(replyToEvent)
      : replyPreview(replyToEvent)
    : "Replying to message";
  const srLabel =
    state?.status === "continue"
      ? replyToEvent?.type === "m.voice"
        ? "Continue looking for replied voice message"
        : "Continue looking for replied message"
      : replyToEvent?.sender_handle
        ? `Jump to message from ${replyToEvent.sender_handle}`
        : replyToEvent?.type === "m.voice"
          ? "Jump to replied voice message"
          : "Jump to replied message";
  const disabled = state?.status === "loading" || !onJump;
  const previewText =
    state?.status === "loading"
      ? "Finding original message..."
      : state?.status === "continue"
        ? state.message || "Still looking farther back. Click to continue."
        : state?.status === "error"
          ? state.message || "Couldn’t find the original message."
          : label;
  return (
    <button
      type="button"
      aria-label={srLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onJump?.(targetId);
      }}
      className={cn(
        "mb-1 block min-h-11 w-full border-l-2 border-current/40 py-1.5 pl-2 pr-2 text-left text-[11px] opacity-80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:bg-muted/70 disabled:cursor-wait disabled:opacity-80",
        isMine ? "hover:bg-primary-foreground/10" : "hover:bg-muted/50",
      )}
    >
      <div className="font-medium">{replyToEvent ? sender : "reply"}</div>
      <div className="flex min-w-0 items-center gap-1 truncate">
        {replyToEvent?.type === "m.voice" && <MusicNote className="h-3 w-3 shrink-0" />}
        <span className="truncate">
          {previewText}
        </span>
      </div>
    </button>
  );
}

function Body({
  event,
  isMine,
  soloEmoji,
  mentionTargets,
  onMentionClick,
  roomId,
  onAttachAnnotations,
  onOpenAnnotation,
}: {
  event: Event;
  isMine?: boolean;
  soloEmoji?: boolean;
  mentionTargets?: MentionTarget[];
  onMentionClick?: (target: MentionTarget) => void;
  roomId?: string;
  onAttachAnnotations?: (draft: AnnotationDraft) => void;
  onOpenAnnotation?: (request: AnnotationOpenRequest) => void;
}) {
  // #17 — forwarded chip rendered above the bubble body for *every* message
  // type (text, images, files, voice…), not just text. Telegram style:
  // "Forwarded from @alice".
  const forwarded = (event.content as { forward_from?: { sender_handle?: string } }).forward_from;
  const forwardedFrom = forwarded?.sender_handle ?? null;
  if (!forwardedFrom) {
    return (
      <BodyContent
        event={event}
        isMine={isMine}
        soloEmoji={soloEmoji}
        mentionTargets={mentionTargets}
        onMentionClick={onMentionClick}
        roomId={roomId}
        onAttachAnnotations={onAttachAnnotations}
        onOpenAnnotation={onOpenAnnotation}
      />
    );
  }
  return (
    <div className="space-y-1">
      <ForwardedFromChip handle={forwardedFrom} isMine={isMine} />
      <BodyContent
        event={event}
        isMine={isMine}
        soloEmoji={soloEmoji}
        mentionTargets={mentionTargets}
        onMentionClick={onMentionClick}
        roomId={roomId}
        onAttachAnnotations={onAttachAnnotations}
        onOpenAnnotation={onOpenAnnotation}
      />
    </div>
  );
}

function ToolSetupRequestCard({
  request,
  isMine,
}: {
  request: ToolSetupRequestMessage;
  isMine?: boolean;
}) {
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [liveStatus, setLiveStatus] = React.useState<ToolSetupStatus | null>(null);
  React.useEffect(() => {
    const onSetupState = (event: globalThis.Event) => {
      const next = parseToolSetupAssignment(
        (event as CustomEvent<unknown>).detail,
        request.requestId,
      );
      if (next) setLiveStatus(next.status);
    };
    window.addEventListener(TOOL_SETUP_STATE_EVENT, onSetupState);
    return () => window.removeEventListener(TOOL_SETUP_STATE_EVENT, onSetupState);
  }, [request.requestId]);
  const context = request.integrationName || request.toolKey;
  const actionLabel =
    liveStatus === "completed"
      ? "Setup complete"
      : liveStatus === "in_progress"
        ? "View setup status"
        : liveStatus === "failed"
          ? "Retry setup"
          : liveStatus === "cancelled" || liveStatus === "expired"
            ? "View request"
            : "Set up now";
  return (
    <>
      <section
        aria-label={`Set up ${request.toolName}`}
        className={cn(
          "w-80 max-w-full overflow-hidden border text-foreground",
          isMine ? "border-primary-foreground/25 bg-primary-foreground/95" : "bg-card",
        )}
      >
        <div className="flex items-start gap-3 border-b px-3.5 py-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center bg-foreground text-background">
            <PuzzlePiece className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Silicon Extend
            </div>
            <div className="truncate text-sm font-semibold">{request.toolName}</div>
            {context && (
              <div className="truncate text-[11px] text-muted-foreground">{context}</div>
            )}
          </div>
        </div>
        <div className="space-y-2.5 px-3.5 py-3">
          <p className="text-xs leading-relaxed">{request.body}</p>
          {request.note && !request.body.trim().endsWith(request.note) && (
            <p className="border-l-2 border-foreground/20 pl-2 text-[11px] leading-relaxed text-muted-foreground">
              {request.note}
            </p>
          )}
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {actionLabel}
          </button>
        </div>
      </section>
      <ToolSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        requestId={request.requestId}
        summary={request}
      />
    </>
  );
}

function BodyContent({
  event,
  isMine,
  soloEmoji,
  mentionTargets,
  onMentionClick,
  roomId,
  onAttachAnnotations,
  onOpenAnnotation,
}: {
  event: Event;
  isMine?: boolean;
  soloEmoji?: boolean;
  mentionTargets?: MentionTarget[];
  onMentionClick?: (target: MentionTarget) => void;
  roomId?: string;
  onAttachAnnotations?: (draft: AnnotationDraft) => void;
  onOpenAnnotation?: (request: AnnotationOpenRequest) => void;
}) {
  const c = event.content;
  const mentionOptions = {
    mentions: mentionTargets,
    onMentionClick,
    mentionInverted: isMine,
  };
  switch (event.type) {
    case "m.text": {
      const setupRequest = toolSetupRequestFromEvent(event);
      if (setupRequest) {
        return <ToolSetupRequestCard request={setupRequest} isMine={isMine} />;
      }
      // §2.8 — a silicon can emit an empty/whitespace m.text; don't render a
      // blank padded bubble. Show a quiet placeholder only once it's final and
      // there's nothing else to show (no link preview, not mid-stream).
      // Trim leading/trailing blank lines and trailing spaces so a short
      // message like "hi" (or one carrying stray newlines from the composer /
      // queued-merge) renders a snug bubble instead of one padded out by
      // whitespace-pre-wrap. Internal blank lines are preserved.
      const body = String(c.body ?? "").replace(/^\s+|\s+$/g, "");
      const blank = !body && !event.link_preview;
      if (blank && event.is_final) {
        return <span className="text-xs italic text-muted-foreground">(empty message)</span>;
      }
      // The bubble wrapper drops its background for an emoji-only message
      // (decided in MessageBubble, which also excludes replies, forwards, and
      // link previews). Emoji mixed with text keeps the standard renderer.
      if (soloEmoji) {
        return <div className="emoji-glyph text-5xl leading-none">{body}</div>;
      }
      // A message written in markdown renders as real markdown (headings,
      // lists, code, tables…); plain chatter keeps the lightweight inline
      // renderer (bold/italic/links + preserved newlines).
      const asMarkdown = looksLikeMarkdown(body);
      const bodyUrls = extractUrls(body);
      const stableLinkPreview = event.link_preview ??
        (bodyUrls.length === 1 ? fallbackLinkPreview(bodyUrls[0]) : null);
      return (
        <div className="space-y-1">
          {asMarkdown ? (
            <div className="min-w-0 max-w-full break-words">
              <MarkdownView
                source={body}
                compact
                className={cn("min-w-0 max-w-full text-sm", isMine && "text-primary-foreground")}
                mentions={mentionTargets}
                onMentionClick={onMentionClick}
                mentionInverted={isMine}
              />
              {stableLinkPreview && <LinkPreviewCard preview={stableLinkPreview} />}
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words">
              {renderMarkdown(body, mentionOptions)}
              {stableLinkPreview && <LinkPreviewCard preview={stableLinkPreview} />}
            </div>
          )}
        </div>
      );
    }
    case "m.image":
      return c.media_id || c.local_url ? (
        <div className="space-y-1.5">
          <MediaAttachment
            mediaId={c.media_id ? String(c.media_id) : ""}
            mime={c.mime ? String(c.mime) : undefined}
            localUrl={c.local_url ? String(c.local_url) : null}
            caption={c.caption ? String(c.caption) : undefined}
            showCaption={false}
            initialStatus={event.media_meta?.status}
            width={event.media_meta?.width ?? (typeof c.width === "number" ? c.width : null)}
            height={event.media_meta?.height ?? (typeof c.height === "number" ? c.height : null)}
            replyToEventId={event.event_id}
            roomId={roomId}
            eventId={event.event_id}
            onAttachAnnotations={onAttachAnnotations}
            onOpenAnnotation={onOpenAnnotation}
          />
          {/* The text rides with the image as a normal message line, not a
              tiny grey caption. */}
          {c.caption ? (
            <div className="whitespace-pre-wrap break-words text-sm">
              {renderMarkdown(String(c.caption), mentionOptions)}
            </div>
          ) : null}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{String(c.caption ?? "attachment")}</span>
      );
    case "m.file":
      return c.media_id ? (
        <div className="space-y-1.5">
          <MediaAttachment
            mediaId={String(c.media_id)}
            mime={c.mime ? String(c.mime) : undefined}
            filename={c.filename ? String(c.filename) : undefined}
            caption={c.caption ? String(c.caption) : undefined}
            showCaption={false}
            initialStatus={event.media_meta?.status}
            width={event.media_meta?.width ?? null}
            height={event.media_meta?.height ?? null}
            replyToEventId={event.event_id}
            roomId={roomId}
            eventId={event.event_id}
            onAttachAnnotations={onAttachAnnotations}
            onOpenAnnotation={onOpenAnnotation}
          />
          {/* New-format messages carry the filename separately, so the caption
              is the user's typed text — render it as a normal message line.
              Legacy messages stored the filename in `caption`, so we leave it
              to the chip and don't echo it here. */}
          {c.filename && c.caption ? (
            <div className="whitespace-pre-wrap break-words text-sm">
              {renderMarkdown(String(c.caption), mentionOptions)}
            </div>
          ) : null}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{String(c.caption ?? "attachment")}</span>
      );
    case "m.album": {
      const items = albumMediaItems(event);
      return (
        <div className="space-y-1.5">
          <div
            className="grid max-w-[36rem] grid-cols-2 gap-1 overflow-hidden"
            role="group"
            aria-label={`${items.length} attachments`}
          >
            {items.map((item) => (
              <div
                key={`${item.position}:${item.media_id}`}
                className={cn(
                  "min-w-0 overflow-hidden bg-card",
                  items.length % 2 === 1 && item.position === items.length - 1 && "col-span-2",
                )}
              >
                <MediaAttachment
                  mediaId={item.media_id}
                  mime={item.mime}
                  filename={item.filename || undefined}
                  showCaption={false}
                  initialStatus={item.status}
                  width={item.width}
                  height={item.height}
                  replyToEventId={event.event_id}
                  roomId={roomId}
                  eventId={event.event_id}
                  onAttachAnnotations={onAttachAnnotations}
                  onOpenAnnotation={onOpenAnnotation}
                />
              </div>
            ))}
          </div>
          {c.caption ? (
            <div className="whitespace-pre-wrap break-words text-sm">
              {renderMarkdown(String(c.caption), mentionOptions)}
            </div>
          ) : null}
        </div>
      );
    }
    case "m.voice": {
      const localPeaks = Array.isArray(c.peaks)
        ? c.peaks.filter((v): v is number => typeof v === "number")
        : null;
      return (
        <div className="space-y-1">
          {c.media_id || c.local_url ? (
            <MediaAttachment
              mediaId={c.media_id ? String(c.media_id) : ""}
              mime={c.mime ? String(c.mime) : "audio/webm"}
              localUrl={c.local_url ? String(c.local_url) : null}
              localDurationMs={typeof c.duration_ms === "number" ? c.duration_ms : null}
              localPeaks={localPeaks}
              initialStatus={event.media_meta?.status}
              replyToEventId={event.event_id}
            />
          ) : (
            <DurableVoiceAttachment event={event} peaks={localPeaks} />
          )}
          {c.transcript ? <VoiceTranscript text={String(c.transcript)} /> : null}
        </div>
      );
    }
    case "m.tts":
      return (
        <div className="space-y-1">
          {c.media_id ? (
            <MediaAttachment
              mediaId={String(c.media_id)}
              mime={c.mime ? String(c.mime) : "audio/mpeg"}
              initialStatus={event.media_meta?.status}
              replyToEventId={event.event_id}
            />
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <Sparkle className="h-4 w-4" /> tts
            </div>
          )}
          {c.text ? <VoiceTranscript text={String(c.text)} /> : null}
        </div>
      );
    case "m.remote_browser":
      return (
        <RemoteBrowserCard
          url={String(c.url ?? "")}
          expiresAt={c.expires_at ? String(c.expires_at) : undefined}
          ttlMinutes={Number(c.ttl_minutes) || 60}
          closed={Boolean(c.closed)}
        />
      );
    case "m.progress": {
      const state = (c.state as ProgressState) || "thinking";
      return (
        <div className="flex items-center gap-2 text-xs">
          <Sparkle className="h-3.5 w-3.5" />
          <span>{state.replaceAll("_", " ")}</span>
          {c.note ? <span className="text-muted-foreground">· {String(c.note)}</span> : null}
        </div>
      );
    }
    default:
      return <pre className="text-xs">{JSON.stringify(c, null, 2)}</pre>;
  }
}
