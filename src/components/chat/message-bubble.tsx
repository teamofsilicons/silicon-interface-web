"use client";

import * as React from "react";
import {
  ArrowBendUpLeft,
  Check,
  Checks,
  Copy,
  DotsThree,
  MusicNote,
  Share,
  Smiley,
  Sparkle,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import type { Event, ProgressState } from "@/lib/types";
import { renderMarkdown } from "@/lib/markdown";
import { cn, relativeTime } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IdAvatar } from "@/components/profile/id-avatar";
import { MediaAttachment } from "@/components/chat/media-attachment";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

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
  isOwnSilicon?: boolean;
  onTakeBack?: (eventId: string, force?: boolean) => void;
  /** Send-receipt for messages this Carbon authored. Ignored for received messages. */
  status?: MessageStatus;
  /** Photo URL for the sender — used when rendering the message-side avatar. */
  senderPhotoUrl?: string | null;
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
  isOwnSilicon,
  onTakeBack,
  status,
  senderPhotoUrl,
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
  if (event.type === "m.progress" && event.content.state === "done") {
    return (
      <div className="my-2 flex items-start gap-2">
        <Sparkle className="mt-1 h-4 w-4 text-primary" />
        <div className="text-sm">
          <div className="font-medium">Silicon finished</div>
          {event.content.summary ? (
            <div className="text-muted-foreground">{String(event.content.summary)}</div>
          ) : null}
        </div>
      </div>
    );
  }

  const redacted = event.redacted_at !== null;
  // Prefer the sender's handle (carbon username == carbon_id, or silicon name);
  // fall back to the kind only if we don't have it (e.g. system events).
  const senderLabel = event.sender_handle
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

  // We tighten the vertical gap between consecutive bubbles in the same
  // (sender, minute) group so they read as a single block.
  const inGroupGap = !showSender && !showTime;

  return (
    <div
      className={cn(
        "flex w-full gap-2",
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
              aria-label={senderHandle ? `${senderHandle} — profile` : "profile"}
              className="block transition-opacity hover:opacity-80"
            >
              <IdAvatar seed={senderHandle || "?"} src={senderPhotoUrl} size={28} />
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
            // visible asymmetry around media attachments).
            "group relative p-3 text-sm",
            redacted
              ? "border bg-muted text-muted-foreground italic"
              : isMine
                // Selection colors are inverted on sent bubbles — the global
                // ::selection rule paints ink-on-ink, which is invisible on
                // top of bg-primary (ink). Flip to cream-on-ink here.
                ? "bg-primary text-primary-foreground selection:bg-primary-foreground selection:text-primary"
                : "border bg-bubble-received",
          )}
          // Double-click anywhere on a non-redacted bubble triggers a reply
          // — same as Telegram/iMessage.
          onDoubleClick={() => !redacted && onReply?.(event)}
        >
          {redacted ? (
            <span>[message redacted: {event.redaction_reason}]</span>
          ) : (
            <Body event={event} />
          )}

          {/* Hover actions: reply / react / more. Floats above the bubble on
              hover; on mobile, tap-to-reveal is not supported here — a small-
              screen affordance is a follow-up. */}
          {!redacted && (onReply || onReact || onForward || onDelete) && (
            <BubbleActions
              event={event}
              isMine={isMine}
              isOwnSilicon={!!isOwnSilicon}
              onReply={onReply}
              onReact={onReact}
              onForward={onForward}
              onDelete={onDelete}
              onTakeBack={onTakeBack}
            />
          )}
        </div>

        {/* Reaction chips — surfaced under the bubble, grouped by emoji. */}
        {reactions && Object.keys(reactions).length > 0 && (
          <div className={cn("flex flex-wrap gap-1", isMine && "justify-end")}>
            {Object.entries(reactions).map(([emoji, who]) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact?.(event, emoji)}
                title={who.join(", ")}
                className="inline-flex items-center gap-1 border bg-card px-1.5 py-0.5 text-[11px] transition-colors hover:bg-accent"
              >
                <span>{emoji}</span>
                <span className="font-mono opacity-70">{who.length}</span>
              </button>
            ))}
          </div>
        )}
        {/* Time + receipt — rendered only on the last bubble of a (sender,
            minute) run, so a quick back-to-back exchange shows one common
            timestamp instead of one per line. Streaming indicator escapes
            the gate because it's a live state, not historical metadata. */}
        {(showTime || !event.is_final) && (
          <div
            className={cn(
              "flex items-center gap-1.5 text-[10px] text-muted-foreground",
              isMine && "justify-end",
            )}
          >
            {showTime && <span>{relativeTime(event.created_at)}</span>}
            {showTime && isMine && status && <Receipt status={status} />}
            {!event.is_final && <span className="text-primary">streaming…</span>}
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
  onReply,
  onReact,
  onForward,
  onDelete,
  onTakeBack,
}: {
  event: Event;
  isMine: boolean;
  isOwnSilicon: boolean;
  onReply?: (event: Event) => void;
  onReact?: (event: Event, emoji: string) => void;
  onForward?: (event: Event) => void;
  onDelete?: (event: Event) => void;
  onTakeBack?: (eventId: string, force?: boolean) => void;
}) {
  // 5-minute self-delete window only applies to my carbon-side messages.
  const within5Min =
    Date.now() - new Date(event.created_at).getTime() < FIVE_MIN_MS;
  const canDelete = isMine && within5Min;
  const canTakeBack = isMine && isOwnSilicon;
  const textBody = event.type === "m.text" ? String(event.content.body ?? "") : "";
  const handleCopy = () => {
    navigator.clipboard.writeText(textBody).then(
      () => toast.success("text copied"),
      () => toast.error("couldn't copy"),
    );
  };
  return (
    <div
      className={cn(
        "absolute -top-3 z-10 hidden gap-0.5 border bg-card p-0.5 transition-opacity group-hover:flex",
        isMine ? "right-2" : "left-2",
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
        <Popover>
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
              {REACTION_EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => onReact(event, e)}
                  className="inline-flex h-7 w-7 items-center justify-center text-base transition-colors hover:bg-accent"
                  title={`react ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
      <DropdownMenu>
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
  if (status === "delivered")
    return <Checks className="h-3 w-3" aria-label={title} />;
  if (status === "read")
    return <Checks className="h-3 w-3 text-[var(--success)]" aria-label={title} />;
  return (
    <Check
      className={cn("h-3 w-3", status === "pending" && "opacity-40")}
      aria-label={title}
    />
  );
}

function Body({ event }: { event: Event }) {
  const c = event.content;
  switch (event.type) {
    case "m.text":
      return (
        <div className="whitespace-pre-wrap break-words">
          {renderMarkdown(String(c.body ?? ""))}
        </div>
      );
    case "m.image":
    case "m.file":
      return c.media_id ? (
        <MediaAttachment
          mediaId={String(c.media_id)}
          mime={c.mime ? String(c.mime) : undefined}
          caption={c.caption ? String(c.caption) : undefined}
        />
      ) : (
        <span className="text-xs text-muted-foreground">{String(c.caption ?? "attachment")}</span>
      );
    case "m.voice":
      return (
        <div className="space-y-1">
          {c.media_id ? (
            <MediaAttachment mediaId={String(c.media_id)} mime="audio/mpeg" />
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <MusicNote className="h-4 w-4" /> voice note
            </div>
          )}
          {c.transcript ? (
            <div className="text-xs text-muted-foreground">“{String(c.transcript)}”</div>
          ) : null}
        </div>
      );
    case "m.tts":
      return (
        <div className="space-y-1">
          {c.media_id ? (
            <MediaAttachment mediaId={String(c.media_id)} mime="audio/mpeg" />
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <Sparkle className="h-4 w-4" /> tts
            </div>
          )}
          {c.text ? <div className="text-xs italic">“{String(c.text)}”</div> : null}
        </div>
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
