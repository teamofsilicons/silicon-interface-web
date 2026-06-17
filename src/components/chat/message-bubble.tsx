"use client";

import * as React from "react";
import {
  ArrowBendUpLeft,
  Check,
  Checks,
  Clock,
  Copy,
  DotsThree,
  DownloadSimple,
  MusicNote,
  Share,
  Smiley,
  Sparkle,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { Event, ProgressState } from "@/lib/types";
import { renderMarkdown } from "@/lib/markdown";
import { cn, messageTime } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";

import { downloadAsset } from "./media-previewer";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IdAvatar } from "@/components/profile/id-avatar";
import { LinkPreviewCard } from "@/components/chat/link-preview-card";
import { MediaAttachment } from "@/components/chat/media-attachment";
import { RemoteBrowserCard } from "@/components/chat/remote-browser-card";
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

const FIVE_MIN_MS = 5 * 60 * 1000;

export type MessageStatus =
  | "pending" // optimistic local insert — POST not acked yet
  | "sent" // server acked POST → at server, awaiting broadcast
  | "delivered" // WS broadcast echoed back to us → on its way to peers
  | "read" // peer issued a read_receipt at or past this event
  | "failed"; // POST errored — show retry affordance

interface Props {
  event: Event;
  isMine: boolean;
  /** My own handle — used to highlight reactions I've already given. */
  myHandle?: string | null;
  /** The message this one is replying to, if any — rendered as a quote. */
  replyToEvent?: Event;
  isOwnSilicon?: boolean;
  onTakeBack?: (eventId: string, force?: boolean) => void;
  /** Send-receipt for messages this Carbon authored. Ignored for received messages. */
  status?: MessageStatus;
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
  /** Self-delete (5-min carbon window). */
  onDelete?: (event: Event) => void;
}

export function MessageBubble({
  event,
  isMine,
  myHandle,
  replyToEvent,
  isOwnSilicon,
  onTakeBack,
  status,
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
  onDelete,
}: Props) {
  // §4c — flash the bubble briefly when its text is copied. Declared before any
  // early return so the Hook order is stable across render branches.
  const [copyFlash, setCopyFlash] = React.useState(false);
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
  // §1.3 — only text/tts can stream; never show the pill for non-streamable
  // types whose `is_final` happens to be false (e.g. a media event).
  const mightStream =
    (event.type === "m.text" || event.type === "m.tts") && !event.is_final;
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

  // We tighten the vertical gap between consecutive bubbles in the same
  // (sender, minute) group so they read as a single block.
  const inGroupGap = !showSender && !showTime;

  // §5 — one consistent way to reach a message's actions: the 3-dot button,
  // right-click, and double-click all open the same menu. `moreOpen` controls
  // that shared dropdown; `hasActions` gates whether the gestures do anything.
  const [moreOpen, setMoreOpen] = React.useState(false);
  const hasActions = !redacted && !!(onReply || onReact || onForward || onDelete);
  const openMenuGesture = (e: React.MouseEvent) => {
    if (!hasActions) return;
    e.preventDefault();
    setMoreOpen(true);
  };

  return (
    <div
      className={cn(
        // `group` on the full-width row so hovering anywhere in the row —
        // bubble, avatar gutter, or the empty space beside it — reveals the
        // actions, not just the bubble itself.
        "group flex w-full gap-2",
        inGroupGap ? "my-0.5" : "my-1.5",
        isMine ? "justify-end" : "justify-start",
      )}
    >
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
      <div className={cn("max-w-[70%] space-y-1", isMine && "items-end")}>
        {/* Sender label on the first received bubble of a run only. Skipped
            entirely in a direct (1-on-1) room since the peer is implicit. */}
        {!isMine && showSender && !isDirect && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{senderLabel}</span>
          </div>
        )}
        <div
          className={cn(
            // Symmetric p-3 padding so an inline image/file inside the bubble
            // has equal whitespace on top and left (previously px-3 py-2 left
            // visible asymmetry around media attachments). `group` lives on the
            // message column wrapper so hovering anywhere on the block (bubble,
            // padding, label, time) reveals the actions — not just the text.
            "relative p-3 text-sm shadow-sm",
            copyFlash && "copy-flash",
            redacted
              ? "border bg-muted text-muted-foreground italic"
              : isMine
                // `bubble-sent` carries a dedicated ::selection rule in
                // globals.css — the global highlight is ink, which vanishes
                // into this ink bubble, so we reverse it to cream-on-ink there.
                // (A Tailwind `selection:` utility can't win against the
                // unlayered global ::selection rule, hence the explicit class.)
                ? "bubble-sent bg-primary text-primary-foreground"
                : "border bg-bubble-received",
          )}
          onContextMenu={openMenuGesture}
          onDoubleClick={openMenuGesture}
        >
          {/* Quoted parent so a reply visibly references its target. */}
          {replyToEvent && !redacted && (
            <div className="mb-1 border-l-2 border-current/40 pl-2 text-[11px] opacity-70">
              <div className="font-medium">
                {replyToEvent.sender_handle ? `@${replyToEvent.sender_handle}` : "message"}
              </div>
              <div className="truncate">{replyPreview(replyToEvent)}</div>
            </div>
          )}
          {redacted ? (
            <span className="italic">message deleted</span>
          ) : (
            <Body event={event} />
          )}

          {/* Hover actions: reply / react / more. Floats above the bubble on
              hover; on mobile, tap-to-reveal is not supported here — a small-
              screen affordance is a follow-up. */}
          {hasActions && (
            <BubbleActions
              event={event}
              isMine={isMine}
              isOwnSilicon={!!isOwnSilicon}
              myReactions={myReactionEmojis}
              moreOpen={moreOpen}
              onMoreOpenChange={setMoreOpen}
              onReply={onReply}
              onReact={onReact}
              onForward={onForward}
              onDelete={onDelete}
              onTakeBack={onTakeBack}
              onCopied={triggerCopyFlash}
            />
          )}
        </div>

        {/* Reaction chips — surfaced under the bubble, grouped by emoji. */}
        {reactions && Object.keys(reactions).length > 0 && (
          <div className={cn("flex flex-wrap gap-1", isMine && "justify-end")}>
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
                  <span>{emoji}</span>
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
        {(showTime || mightStream) && (
          <div
            className={cn(
              "flex items-center gap-1.5 text-[10px] text-muted-foreground",
              isMine && "justify-end",
            )}
          >
            {showTime && <HoverTime iso={event.created_at} />}
            {showTime && isMine && status && <Receipt status={status} />}
            {mightStream && <StreamingPill body={String(event.content.body ?? "")} />}
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
  myReactions,
  moreOpen,
  onMoreOpenChange,
  onReply,
  onReact,
  onForward,
  onDelete,
  onTakeBack,
  onCopied,
}: {
  event: Event;
  isMine: boolean;
  isOwnSilicon: boolean;
  myReactions: Set<string>;
  /** Controlled open state for the "more" dropdown — shared with the bubble's
   *  right-click / double-click gestures so all three open the same menu. */
  moreOpen: boolean;
  onMoreOpenChange: (open: boolean) => void;
  onReply?: (event: Event) => void;
  onReact?: (event: Event, emoji: string) => void;
  onForward?: (event: Event) => void;
  onDelete?: (event: Event) => void;
  onTakeBack?: (eventId: string, force?: boolean) => void;
  onCopied?: () => void;
}) {
  // 5-minute self-delete window only applies to my carbon-side messages.
  const within5Min =
    Date.now() - new Date(event.created_at).getTime() < FIVE_MIN_MS;
  const canDelete = isMine && within5Min;
  const canTakeBack = isMine && isOwnSilicon;
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
  const hasMedia = Boolean((event.content as { media_id?: unknown }).media_id);
  const handleDownload = async () => {
    try {
      const mediaId = String((event.content as { media_id?: unknown }).media_id);
      const r = await api.mediaDetail(mediaId);
      if (!r.download_url) return;
      const name =
        String((event.content as { caption?: unknown }).caption || "") ||
        event.type.replace("m.", "") ||
        "download";
      downloadAsset(r.download_url, name);
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
        "absolute top-1/2 z-10 -translate-y-1/2 gap-0.5 border bg-card p-0.5 transition-opacity",
        menuOpen ? "flex" : "hidden group-hover:flex",
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
                        "inline-flex h-7 w-7 items-center justify-center text-base transition-colors",
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
          {onForward && (
            <DropdownMenuItem onClick={() => onForward(event)}>
              <Share className="mr-2 h-3.5 w-3.5" />
              forward
            </DropdownMenuItem>
          )}
          {hasMedia && (
            <DropdownMenuItem onClick={handleDownload}>
              <DownloadSimple className="mr-2 h-3.5 w-3.5" />
              download
            </DropdownMenuItem>
          )}
          {(canDelete || canTakeBack) && <DropdownMenuSeparator />}
          {canDelete && onDelete && (
            <DropdownMenuItem onClick={() => onDelete(event)}>
              <Trash className="mr-2 h-3.5 w-3.5" />
              delete
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
function ForwardedFromChip({ handle }: { handle: string }) {
  return (
    <div className="flex items-center gap-1 border-l-2 border-foreground/40 bg-foreground/5 pl-2 py-0.5 text-[10px] text-foreground/80">
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
  const [idle, setIdle] = React.useState(false);
  React.useEffect(() => {
    setIdle(false);
    const t = window.setTimeout(() => setIdle(true), STREAM_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [body]);
  if (idle) return null;
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

function Receipt({ status }: { status: MessageStatus }) {
  const title =
    status === "pending"
      ? "sending"
      : status === "sent"
        ? "sent"
        : status === "delivered"
          ? "delivered"
          : status === "read"
            ? "read"
            : "failed";
  if (status === "failed")
    return <WarningCircle className="h-3 w-3 text-destructive" aria-label={title} />;
  // Pending: show a clock until the server actually accepts the message — a
  // tick would imply it's already sent.
  if (status === "pending")
    return <Clock className="h-3 w-3 opacity-60" aria-label={title} />;
  if (status === "delivered")
    return <Checks className="h-3 w-3 opacity-60" aria-label={title} />;
  // §1.5 — "read" must be unmistakable vs "delivered" (the old pair differed
  // only by text colour on a beige canvas). Use the brand success colour, full
  // opacity — the confident "they saw it" beat every messenger gets right.
  if (status === "read")
    return <Checks className="receipt-fill h-3 w-3 text-[var(--success)]" aria-label={title} weight="bold" />;
  return <Check className="h-3 w-3" aria-label={title} />;
}

/** One-line preview of a quoted (replied-to) message. */
function replyPreview(ev: Event): string {
  if (ev.redacted_at) return "deleted message";
  const c = ev.content as Record<string, unknown>;
  switch (ev.type) {
    case "m.text":
      return String(c.body ?? "");
    case "m.image":
      return c.caption ? String(c.caption) : "photo";
    case "m.file":
      return c.filename ? String(c.filename) : c.caption ? String(c.caption) : "attachment";
    case "m.voice":
      return c.transcript ? String(c.transcript) : "voice note";
    case "m.remote_browser":
      return "Silicon Browser link";
    case "m.tts":
      return c.text ? String(c.text) : "audio";
    default:
      return "message";
  }
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

function Body({ event }: { event: Event }) {
  const c = event.content;
  // #17 — forwarded chip rendered at the top of the bubble body. Telegram
  // style: "Forwarded from @alice".
  const forwarded = (c as { forward_from?: { sender_handle?: string } }).forward_from;
  const forwardedFrom = forwarded?.sender_handle ?? null;
  switch (event.type) {
    case "m.text": {
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
      return (
        <div className="space-y-1">
          {forwardedFrom && <ForwardedFromChip handle={forwardedFrom} />}
          <div className="whitespace-pre-wrap break-words">
            {renderMarkdown(body)}
            {event.link_preview && <LinkPreviewCard preview={event.link_preview} />}
          </div>
        </div>
      );
    }
    case "m.image":
      return c.media_id ? (
        <div className="space-y-1.5">
          <MediaAttachment
            mediaId={String(c.media_id)}
            mime={c.mime ? String(c.mime) : undefined}
            caption={c.caption ? String(c.caption) : undefined}
            showCaption={false}
          />
          {/* The text rides with the image as a normal message line, not a
              tiny grey caption. */}
          {c.caption ? (
            <div className="whitespace-pre-wrap break-words text-sm">
              {renderMarkdown(String(c.caption))}
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
          />
          {/* New-format messages carry the filename separately, so the caption
              is the user's typed text — render it as a normal message line.
              Legacy messages stored the filename in `caption`, so we leave it
              to the chip and don't echo it here. */}
          {c.filename && c.caption ? (
            <div className="whitespace-pre-wrap break-words text-sm">
              {renderMarkdown(String(c.caption))}
            </div>
          ) : null}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{String(c.caption ?? "attachment")}</span>
      );
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
            />
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <MusicNote className="h-4 w-4" /> voice note
            </div>
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
