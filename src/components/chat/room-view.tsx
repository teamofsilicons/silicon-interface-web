"use client";

import * as React from "react";
import { Clock, Eye, MagnifyingGlass, X } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { roomDisplay } from "@/lib/peers";
import { playSent } from "@/lib/sounds";
import type { Event, ProgressState, Room, WsFrame } from "@/lib/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IdAvatar } from "@/components/profile/id-avatar";
import { Composer, type OptimisticPayload } from "@/components/chat/composer";
import { ForwardDialog } from "@/components/chat/forward-dialog";
import { MessageBubble, type MessageStatus } from "@/components/chat/message-bubble";
import { ProfileDrawer } from "@/components/chat/profile-drawer";
import { CronDrawer } from "@/components/chat/cron-drawer";
import { SaveContactDialog } from "@/components/chat/save-contact-dialog";
import type { Contact } from "@/lib/types";
import { contactKey } from "@/lib/use-contacts";
import { NotePencil, UserPlus } from "@phosphor-icons/react/dist/ssr";

interface Props {
  room: Room;
  /** Full room list passed down so forward picker has its choices. */
  allRooms: Room[];
  socket: {
    ready: boolean;
    lastFrame: WsFrame | null;
    send: (frame: object) => void;
  };
  /** Saved contacts keyed by `${kind}:${id}`. */
  contacts?: Map<string, Contact>;
  /** Called after a contact is saved/edited so the parent can refetch. */
  onContactsChanged?: () => void;
}

type LocalEvent = Event & {
  _status?: MessageStatus;
  _clientId?: string;
};

interface ProgressEntry {
  roomId: string;
  groupId: string;
  state: ProgressState;
  note: string;
  updatedAt: number;
  source: "local" | "server";
}

const TEMP_ID = (clientId: string) => `temp-${clientId}`;
// Background refresh interval — keeps relative timestamps, read receipts,
// and any out-of-band events fresh even if the WS connection blips.
const POLL_INTERVAL_MS = 10_000;
const PROGRESS_MESSAGE_TYPES = new Set([
  "m.text",
  "m.image",
  "m.file",
  "m.voice",
  "m.tts",
  "m.remote_browser",
]);
const SILICON_PROGRESS_COPY = [
  "Polishing the logic wafer",
  "Asking the semicolons to behave",
  "Counting electrons with suspicious confidence",
  "Making the bits stand in a straight line",
  "Convincing the cache it remembers this",
  "Warming up the tiny decision engine",
  "Sorting nonsense into useful nonsense",
  "Consulting the motherboard council",
];
const PROGRESS_STATE_COPY: Partial<Record<ProgressState, string[]>> = {
  reading_file: [
    "Reading the file like it owes rent",
    "Dusting fingerprints off the data",
    "Turning document fog into clues",
  ],
  writing_file: [
    "Negotiating with the blank file",
    "Typing with ceremonial seriousness",
    "Putting pixels where pixels belong",
  ],
  executing: [
    "Pressing the serious-looking buttons",
    "Letting the command line have opinions",
    "Running the tiny factory floor",
  ],
  searching_web: [
    "Checking the outside universe",
    "Borrowing facts from the internet shelf",
    "Peeking over the network fence",
  ],
  thinking: SILICON_PROGRESS_COPY,
};
const MIN_PROGRESS_STATUS_MS = 1000;
const PROGRESS_TYPE_MS = { min: 13, max: 24, erase: 8 };
const MAX_PROGRESS_LINE_CHARS = 64;
const ROOM_SNIPPET_LIMIT = 40;

export function RoomView({ room, allRooms, socket, contacts, onContactsChanged }: Props) {
  const { carbon } = useAuth();
  const myUsername = carbon?.username ?? null;
  const display = roomDisplay(room);
  // Direct 1-on-1 peer and its saved-contact record (if any) — drives the
  // header title (saved name vs @id), avatar, and the Save Contact button.
  const peer = room.kind === "direct" && room.peers.length === 1 ? room.peers[0] : null;
  const contact = peer ? contacts?.get(contactKey(peer.kind, peer.id)) : undefined;
  const [saveOpen, setSaveOpen] = React.useState(false);
  const headerTitle = peer
    ? contact?.name || null // null → render the styled @id below
    : display.name;
  const headerPhoto = contact?.photo_url ?? display.photoUrl;
  const headerSeed = peer?.id ?? display.handle;
  // Observer mode: I'm in the backend allowlist and this is a silicon↔silicon
  // room I may only watch. No composer, no reactions/replies/take-backs, and
  // no read-receipts (I'm not a member, so the read POST would 403 anyway).
  const readOnly = !!room.observed;
  const showsProgressForReplies = !readOnly && room.peers.some((p) => p.kind === "silicon");

  const [events, setEvents] = React.useState<LocalEvent[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [activeProgress, setActiveProgress] = React.useState<ProgressEntry | null>(null);
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [focusSender, setFocusSender] = React.useState<{
    kind: "carbon" | "silicon";
    handle: string;
  } | null>(null);
  const [replyTo, setReplyTo] = React.useState<Event | null>(null);
  const [search, setSearch] = React.useState<string | null>(null);
  const [cronOpen, setCronOpen] = React.useState(false);
  const [droppedFile, setDroppedFile] = React.useState<File | null>(null);
  const [isDropTarget, setIsDropTarget] = React.useState(false);
  // #5 — Per-handle activity state. Each entry expires after `until`.
  const [activities, setActivities] = React.useState<
    Record<string, { state: "typing" | "uploading" | "recording"; until: number }>
  >({});
  // Clear expired activity entries on a 2s interval.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setActivities((prev) => {
        const out: typeof prev = {};
        let changed = false;
        for (const [h, a] of Object.entries(prev)) {
          if (a.until > now) out[h] = a;
          else changed = true;
        }
        return changed ? out : prev;
      });
    }, 2000);
    return () => window.clearInterval(id);
  }, []);
  // Build a (kind, id) → handle lookup so activity frames can name a sender.
  const memberHandleLookup = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const p of room.peers) {
      m.set(`${p.kind}.${p.handle}`, p.handle);
    }
    return m;
  }, [room.peers]);
  const handleFor = React.useCallback(
    (kind: "carbon" | "silicon", id: number): string | null => {
      // We don't reliably know peer member_id ↔ handle on the client (Glass
      // doesn't expose Carbon.id). For 1-on-1 rooms there's exactly one
      // peer — assume it's them. For groups we'd need an extra projection;
      // until then we degrade gracefully to a generic "typing…".
      if (room.peers.length === 1) return room.peers[0].handle;
      // Fallback: any peer whose kind matches.
      return room.peers.find((p) => p.kind === kind)?.handle ?? null;
    },
    // memberHandleLookup is used for future group lookups; kept in deps so
    // a future projection refresh re-evaluates.
    [room.peers, memberHandleLookup],
  );

  const endRef = React.useRef<HTMLDivElement>(null);
  const sectionRef = React.useRef<HTMLElement>(null);
  const scrollRootRef = React.useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = React.useRef(true);
  const forceNextBottomRef = React.useRef(false);

  const scrollViewport = React.useCallback((): HTMLElement | null => {
    return (
      scrollRootRef.current?.querySelector("[data-radix-scroll-area-viewport]") ??
      null
    ) as HTMLElement | null;
  }, []);

  const isNearBottom = React.useCallback(() => {
    const viewport = scrollViewport();
    if (!viewport) return true;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
  }, [scrollViewport]);

  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const viewport = scrollViewport();
      if (viewport) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior });
        return;
      }
      endRef.current?.scrollIntoView({ behavior, block: "end" });
    },
    [scrollViewport],
  );

  const requestBottomStick = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      stickToBottomRef.current = true;
      forceNextBottomRef.current = true;
      requestAnimationFrame(() => scrollToBottom(behavior));
    },
    [scrollToBottom],
  );

  // ----- Photo URL lookup per sender (for in-message avatars) -----
  const peerByHandle = React.useMemo(() => {
    const m = new Map<string, Room["peers"][number]>();
    for (const p of room.peers) m.set(p.handle, p);
    return m;
  }, [room.peers]);
  const contactForSender = React.useCallback(
    (kind: "carbon" | "silicon" | "system", handle: string | null) => {
      if (!handle || (kind !== "carbon" && kind !== "silicon")) return undefined;
      return (
        contacts?.get(contactKey(kind, handle)) ??
        contacts?.get(contactKey(kind, peerByHandle.get(handle)?.id ?? ""))
      );
    },
    [contacts, peerByHandle],
  );
  const peerPhotoByHandle = React.useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of room.peers) m.set(p.handle, p.profile_photo_url);
    return m;
  }, [room.peers]);
  const myPhotoUrl = carbon?.profile_photo_url ?? null;
  const photoFor = React.useCallback(
    (kind: "carbon" | "silicon" | "system", handle: string | null) => {
      if (!handle) return null;
      if (handle === myUsername) return myPhotoUrl;
      const saved = contactForSender(kind, handle);
      if (saved) return saved.photo_url ?? saved.target_photo_url;
      return peerPhotoByHandle.get(handle) ?? null;
    },
    [myUsername, myPhotoUrl, contactForSender, peerPhotoByHandle],
  );
  const displayNameFor = React.useCallback(
    (kind: "carbon" | "silicon" | "system", handle: string | null) => {
      const saved = contactForSender(kind, handle);
      return saved?.name?.trim() || null;
    },
    [contactForSender],
  );

  // ----- Initial events load -----
  // Single fetch on mount / room-switch. We don't poll thereafter — the WS
  // delivers events and read_receipts in real time, and re-polling just
  // duplicates work and (worse) cascades into extra `api.read` calls via the
  // auto-read effect below. The 10s "ping" the design asks for is just a
  // re-render tick for `relativeTime`, not a network fetch.
  React.useEffect(() => {
    let mounted = true;
    const roomId = room.room_id;
    const cachedEvents = readRoomEventSnippet(roomId);
    setLoading(false);
    setEvents(cachedEvents ?? []);
    setActiveProgress(null);
    setActivities({});
    setReplyTo(null);
    setFocusSender(null);
    setProfileOpen(false);
    api
      .events(roomId, undefined, 100)
      .then((evs) => {
        if (!mounted) return;
        setEvents((prev) => {
          const pending = prev.filter((e) => e.event_id.startsWith("temp-") || e._status === "pending");
          return mergeServerEvents(pending, evs, myUsername);
        });
        setLoading(false);
      })
      .catch((e) => {
        if (!mounted) return;
        toast.error(e instanceof ApiError ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [room.room_id, myUsername]);

  React.useEffect(() => {
    if (loading) return;
    saveRoomEventSnippet(room.room_id, events);
  }, [events, loading, room.room_id]);

  // Force a re-render every 10s so `relativeTime` advances ("just now" →
  // "1m" → "2m"). No network — purely a UI tick.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(
      () => forceTick((n) => n + 1),
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, []);

  // ----- WS subscribe + frame handling -----
  React.useEffect(() => {
    if (socket.ready) socket.send({ type: "subscribe", room_id: room.room_id });
  }, [socket.ready, room.room_id, socket.send]);

  // On reconnect, re-pull events for the open room — any frames delivered while
  // the socket was down (backend restart, tab asleep) are gone otherwise.
  const prevReadyRef = React.useRef(socket.ready);
  React.useEffect(() => {
    if (socket.ready && !prevReadyRef.current) {
      api
        .events(room.room_id, undefined, 100)
        .then((evs) => setEvents((prev) => mergeServerEvents(prev, evs, myUsername)))
        .catch(() => undefined);
    }
    prevReadyRef.current = socket.ready;
  }, [socket.ready, room.room_id, myUsername]);

  React.useEffect(() => {
    const f = socket.lastFrame;
    if (!f) return;
    if ("room_id" in f && f.room_id !== room.room_id) return;
    if (f.type === "event") {
      const incoming = f.event;
      const mine = incoming.sender_handle && incoming.sender_handle === myUsername;
      if (incoming.type === "m.progress") {
        const state = (incoming.content.state as ProgressState) || "thinking";
        if (state === "done") {
          setActiveProgress(null);
        } else {
          setActiveProgress({
            roomId: room.room_id,
            groupId: String(incoming.content.progress_group_id || incoming.event_id),
            state,
            note: String(incoming.content.note || ""),
            updatedAt: Date.now(),
            source: "server",
          });
        }
        return;
      }
      if (!mine && PROGRESS_MESSAGE_TYPES.has(incoming.type)) setActiveProgress(null);
      // The received tone is played once, globally, by the chat page (so it
      // fires for any room, not just the open one).
      setEvents((prev) => {
        const existsIdx = prev.findIndex((e) => e.event_id === incoming.event_id);
        if (existsIdx >= 0) {
          if (!mine) return prev;
          const updated = [...prev];
          const cur = updated[existsIdx];
          if (cur._status !== "read") {
            updated[existsIdx] = { ...cur, _status: "delivered" };
          }
          return updated;
        }
        if (mine) {
          const optIdx = prev.findIndex(
            (e) =>
              e._status === "pending" &&
              e.sender_handle === incoming.sender_handle &&
              e.type === incoming.type &&
              JSON.stringify(e.content) === JSON.stringify(incoming.content),
          );
          if (optIdx >= 0) {
            const updated = [...prev];
            updated[optIdx] = {
              ...incoming,
              _clientId: prev[optIdx]._clientId,
              _status: "delivered",
            };
            return updated;
          }
        }
        return [...prev, { ...incoming, _status: mine ? "delivered" : undefined }];
      });
    } else if (f.type === "event.delta") {
      setEvents((prev) =>
        prev.map((e) =>
          e.event_id === f.event_id
            ? {
                ...e,
                content: {
                  ...e.content,
                  body: ((e.content.body as string) ?? "") + f.delta,
                },
              }
            : e,
        ),
      );
    } else if (f.type === "event.final") {
      setEvents((prev) =>
        prev.map((e) => (e.event_id === f.event_id ? { ...e, is_final: true } : e)),
      );
    } else if (f.type === "event.transcript") {
      setEvents((prev) =>
        prev.map((e) =>
          e.event_id === f.event_id
            ? { ...e, content: { ...e.content, transcript: f.transcript } }
            : e,
        ),
      );
    } else if (f.type === "read_receipt") {
      const cutoff = f.event_id;
      setEvents((prev) =>
        prev.map((e) =>
          e.sender_handle === myUsername && e.event_id <= cutoff
            ? { ...e, _status: "read" }
            : e,
        ),
      );
    } else if (f.type === "take_back") {
      setEvents((prev) =>
        prev.map((e) =>
          f.event_ids.includes(e.event_id)
            ? { ...e, redacted_at: new Date().toISOString(), redaction_reason: "redacted" }
            : e,
        ),
      );
    } else if (f.type === "progress") {
      if (f.state && f.progress_group_id) {
        if (f.state === "done") {
          setActiveProgress(null);
        } else {
          setActiveProgress({
            roomId: room.room_id,
            groupId: f.progress_group_id,
            state: f.state as ProgressState,
            note: f.note || "",
            updatedAt: Date.now(),
            source: "server",
          });
        }
      }
      // #5 — Activity beacon (typing | uploading | recording). Skip my own
      // beacons; track per-handle so we can show "@alice is recording…"
      // alongside any other active state.
      const kind = f.kind;
      if (kind === "typing" || kind === "uploading" || kind === "recording") {
        // Prefer the handle the server stamps on the beacon — it identifies the
        // actual sender, so I can attribute it correctly *and* ignore my own
        // (the old handleFor() always returned the peer in a 1-on-1 room, which
        // made my own recording show up as "@peer is recording").
        const handle =
          f.member_handle ??
          (f.member_id !== undefined &&
          (f.member_kind === "carbon" || f.member_kind === "silicon")
            ? handleFor(f.member_kind, f.member_id)
            : null);
        if (handle && handle !== myUsername) {
          const active = f.is_typing !== false;
          setActivities((prev) => {
            const next = { ...prev };
            if (active) next[handle] = { state: kind, until: Date.now() + 8000 };
            else delete next[handle];
            return next;
          });
        }
      }
    }
  }, [socket.lastFrame, room.room_id, myUsername]);

  // ----- Scroll-to-bottom + auto-read -----
  const didInitialScrollRef = React.useRef(false);
  React.useEffect(() => {
    didInitialScrollRef.current = false;
    stickToBottomRef.current = true;
    forceNextBottomRef.current = true;
  }, [room.room_id]);

  React.useEffect(() => {
    const viewport = scrollViewport();
    if (!viewport) return;
    const onScroll = () => {
      stickToBottomRef.current = isNearBottom();
    };
    onScroll();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [room.room_id, scrollViewport, isNearBottom]);

  React.useEffect(() => {
    if (loading) return;
    const initial = !didInitialScrollRef.current;
    const shouldStick = initial || forceNextBottomRef.current || stickToBottomRef.current;
    if (!shouldStick) {
      didInitialScrollRef.current = true;
      return;
    }
    const behavior: ScrollBehavior = initial ? "auto" : "smooth";
    const jump = () =>
      scrollToBottom(behavior);
    // Double rAF runs after layout settles; on first open a delayed pass also
    // catches late media reflow (images/audio that load taller after paint),
    // so we land on the true last message instead of just short of it.
    const raf = requestAnimationFrame(() => requestAnimationFrame(jump));
    const t = window.setTimeout(jump, initial ? 350 : 80);
    didInitialScrollRef.current = true;
    forceNextBottomRef.current = false;
    return () => {
      cancelAnimationFrame(raf);
      if (t) window.clearTimeout(t);
    };
  }, [events.length, activeProgress, replyTo?.event_id, loading, room.room_id, scrollToBottom]);

  // Auto-read: derive the latest event from someone other than me, and only
  // POST when *that event_id* changes. The previous version depended on the
  // entire `events` array, which fires on every poll, every optimistic add,
  // and every WS frame — flooding the server with idempotent reads.
  const lastTheirsEventId = React.useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.sender_handle && e.sender_handle !== myUsername) return e.event_id;
    }
    return null;
  }, [events, myUsername]);

  React.useEffect(() => {
    if (readOnly) return; // observers don't mark read — they aren't members
    if (!lastTheirsEventId) return;
    api.read(room.room_id, lastTheirsEventId).catch(() => undefined);
  }, [lastTheirsEventId, room.room_id, readOnly]);

  // ----- Take-back / self-delete / react / reply / forward -----
  const onTakeBack = async (eventId: string, force = false) => {
    try {
      const r = await api.takeBack(eventId, "manual", force);
      if (r && "detail" in r) toast.error(r.detail);
      else toast.success("took back");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  // Delete is two-step: clicking it stages the target; the confirm dialog
  // actually performs the redaction.
  const [pendingDelete, setPendingDelete] = React.useState<Event | null>(null);
  const onSelfDelete = (ev: Event) => {
    if (ev.event_id === latestVisibleEventId) requestBottomStick();
    setPendingDelete(ev);
  };

  const confirmDelete = async () => {
    const ev = pendingDelete;
    if (!ev) return;
    setPendingDelete(null);
    // Optimistically mark redacted so the bubble updates instantly.
    setEvents((prev) =>
      prev.map((e) =>
        e.event_id === ev.event_id
          ? {
              ...e,
              redacted_at: new Date().toISOString(),
              redaction_reason: "self_delete",
              content: { redacted: true, reason: "self_delete" },
            }
          : e,
      ),
    );
    try {
      const r = await api.deleteEvent(ev.event_id);
      if (r && "detail" in r) toast.error(r.detail);
      else toast.success("deleted successfully");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const onReact = async (ev: Event, emoji: string) => {
    if (ev.event_id === latestVisibleEventId) requestBottomStick();
    // Toggle: if I already reacted to this message with this emoji, remove that
    // reaction; otherwise add one. Reactions are m.reaction events keyed to the
    // target via reply_to_event_id; the WS echo / take_back folds the change
    // into the reaction map below.
    const existing = events.find(
      (e) =>
        e.type === "m.reaction" &&
        !e.redacted_at &&
        e.reply_to_event_id === ev.event_id &&
        e.sender_handle === myUsername &&
        String((e.content as { emoji?: unknown }).emoji ?? "") === emoji,
    );
    if (existing) {
      // Optimistically drop my reaction, then redact it server-side.
      setEvents((prev) =>
        prev.map((e) =>
          e.event_id === existing.event_id
            ? { ...e, redacted_at: new Date().toISOString(), redaction_reason: "unreact" }
            : e,
        ),
      );
      try {
        const r = await api.deleteEvent(existing.event_id);
        if (r && "detail" in r) toast.error(r.detail);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : String(e));
      }
      return;
    }
    try {
      await api.sendEvent(room.room_id, {
        type: "m.reaction",
        content: { emoji },
        reply_to_event_id: ev.event_id,
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const onReply = (ev: Event) => {
    setReplyTo(ev);
    if (ev.event_id === latestVisibleEventId) requestBottomStick();
  };

  // #17 — Forward picker. Setting `forwardingEvent` opens the dialog; the
  // dialog handles room selection and re-posting with forward_from metadata.
  const [forwardingEvent, setForwardingEvent] = React.useState<Event | null>(null);
  const onForward = (ev: Event) => setForwardingEvent(ev);

  // Aggregate reactions: target_event_id → { emoji → [sender_handle] }
  const reactionsByTarget = React.useMemo(() => {
    const map = new Map<string, Record<string, string[]>>();
    for (const e of events) {
      if (e.type !== "m.reaction") continue;
      if (e.redacted_at) continue;
      const target = e.reply_to_event_id;
      const emoji = String((e.content as { emoji?: unknown }).emoji ?? "");
      if (!target || !emoji) continue;
      const bucket = map.get(target) ?? {};
      const who = bucket[emoji] ?? [];
      if (e.sender_handle && !who.includes(e.sender_handle)) {
        who.push(e.sender_handle);
      }
      bucket[emoji] = who;
      map.set(target, bucket);
    }
    return map;
  }, [events]);

  // Visible events drop reactions (they render as chips under the target) and
  // deleted/redacted messages (hidden entirely — no "message deleted" row).
  const visibleEvents = React.useMemo(
    () => events.filter((e) => e.type !== "m.reaction" && e.type !== "m.progress" && !e.redacted_at),
    [events],
  );

  // Lookup so a reply can render the message it's quoting.
  const eventById = React.useMemo(() => {
    const m = new Map<string, LocalEvent>();
    for (const e of events) m.set(e.event_id, e);
    return m;
  }, [events]);

  // ----- Optimistic send plumbing -----
  const onOptimisticAdd = React.useCallback(
    (clientId: string, payload: OptimisticPayload) => {
      if (!myUsername) return;
      const now = new Date().toISOString();
      const placeholder: LocalEvent = {
        event_id: TEMP_ID(clientId),
        room: 0,
        sender_kind: "carbon",
        sender_id: null,
        sender_handle: myUsername,
        type: payload.type,
        content: payload.content ?? {},
        reply_to_event_id: payload.reply_to_event_id ?? "",
        is_final: true,
        created_at: now,
        edited_at: null,
        redacted_at: null,
        redaction_reason: "",
        _status: "pending",
        _clientId: clientId,
      };
      setEvents((prev) => [...prev, placeholder]);
      requestBottomStick("smooth");
      if (showsProgressForReplies && PROGRESS_MESSAGE_TYPES.has(payload.type)) {
        setActiveProgress({
          roomId: room.room_id,
          groupId: `local:${clientId}`,
          state: "thinking",
          note: "",
          updatedAt: Date.now(),
          source: "local",
        });
      }
      // Audible "sent" tone — small ascending chirp. Respects reduced-motion
      // + the silicon-interface:sounds=off opt-out.
      playSent();
    },
    [myUsername, room.room_id, showsProgressForReplies, requestBottomStick],
  );

  const onAck = React.useCallback((clientId: string, real: Event) => {
    requestBottomStick("smooth");
    setEvents((prev) => {
      const optIdx = prev.findIndex((e) => e._clientId === clientId);
      const dupIdx = prev.findIndex(
        (e) => e.event_id === real.event_id && e._clientId !== clientId,
      );
      if (optIdx >= 0 && dupIdx < 0) {
        const updated = [...prev];
        updated[optIdx] = { ...real, _clientId: clientId, _status: "sent" };
        return updated;
      }
      if (optIdx >= 0 && dupIdx >= 0) {
        const updated = [...prev];
        const dup = updated[dupIdx];
        updated[dupIdx] = {
          ...dup,
          _clientId: clientId,
          _status: dup._status ?? "sent",
        };
        updated.splice(optIdx, 1);
        return updated;
      }
      if (dupIdx >= 0) {
        const updated = [...prev];
        updated[dupIdx] = { ...updated[dupIdx], _status: updated[dupIdx]._status ?? "sent" };
        return updated;
      }
      return prev;
    });
  }, [requestBottomStick]);

  const onOptimisticUpdate = React.useCallback(
    (clientId: string, payload: OptimisticPayload) => {
      setEvents((prev) =>
        prev.map((e) =>
          e._clientId === clientId
            ? {
                ...e,
                type: payload.type,
                content: payload.content ?? {},
                reply_to_event_id: payload.reply_to_event_id ?? "",
              }
            : e,
        ),
      );
    },
    [],
  );

  const onFail = React.useCallback((clientId: string, err: unknown) => {
    setEvents((prev) =>
      prev.map((e) => (e._clientId === clientId ? { ...e, _status: "failed" as MessageStatus } : e)),
    );
    setActiveProgress((prev) => (prev?.groupId === `local:${clientId}` ? null : prev));
    toast.error(err instanceof ApiError ? err.message : String(err));
  }, []);

  // ----- Drag-and-drop a file onto the chat surface -----
  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setIsDropTarget(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  };
  const onDragLeave = (e: React.DragEvent) => {
    // We get bogus dragleave events as the cursor crosses child elements.
    // Filter to the actual exit by checking relatedTarget.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDropTarget(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setIsDropTarget(false);
    setDroppedFile(e.dataTransfer.files[0]);
  };

  // ----- Search filter -----
  const filteredEvents = React.useMemo(() => {
    if (!search) return visibleEvents;
    const s = search.toLowerCase();
    return visibleEvents.filter((e) => {
      const searchable = [
        e.content.body,
        e.content.caption,
        e.content.transcript,
        e.content.text,
        e.sender_handle,
      ]
        .map((value) => String(value ?? "").toLowerCase())
        .join("\n");
      return searchable.includes(s);
    });
  }, [visibleEvents, search]);
  const latestVisibleEvent = visibleEvents[visibleEvents.length - 1] ?? null;
  const latestVisibleEventId = latestVisibleEvent?.event_id ?? null;
  const shouldShowActiveProgress =
    !search &&
    activeProgress?.roomId === room.room_id &&
    latestVisibleEvent?.sender_kind !== "silicon";
  const progressAvatarHandle = React.useMemo(() => {
    for (let i = visibleEvents.length - 1; i >= 0; i--) {
      const event = visibleEvents[i];
      if (event.sender_kind === "silicon" && event.sender_handle) return event.sender_handle;
    }
    if (peer?.kind === "silicon") return peer.handle;
    return headerSeed;
  }, [visibleEvents, peer, headerSeed]);
  const progressAvatarSrc = React.useMemo(() => {
    if (!progressAvatarHandle) return headerPhoto;
    return photoFor("silicon", progressAvatarHandle) ?? headerPhoto;
  }, [progressAvatarHandle, photoFor, headerPhoto]);

  const openSenderProfile = React.useCallback(
    (sender: { kind: "carbon" | "silicon"; handle: string }) => {
      setFocusSender(sender);
      setProfileOpen(true);
    },
    [],
  );

  return (
    // `min-h-0` is the key — without it, a flex child grows to its content's
    // intrinsic height, the chat list overflows the viewport, and the
    // sidebar/composer get pushed down. With min-h-0 the section participates
    // in flex sizing properly and only the inner ScrollArea scrolls.
    <section
      ref={sectionRef}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative flex min-h-0 flex-1 flex-col bg-background"
    >
      {/* Header — clicking anywhere on the left side opens the profile. */}
      {/* Header — fixed height so clicking search doesn't shift the row when
          the search field swaps in for the icon button. */}
      <header className="group/header flex h-[68px] items-center gap-3 border-b pl-6 pr-6">
        <button
          type="button"
          onClick={() => {
            setFocusSender(null);
            setProfileOpen(true);
          }}
          className="flex min-w-0 flex-1 items-center gap-3 text-left transition-opacity hover:opacity-80"
          title="view profile & attachments"
        >
          <IdAvatar seed={headerSeed} src={headerPhoto} size={36} family={peer?.kind ?? "carbon"} />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">
              {headerTitle ?? (
                <>
                  <span className="opacity-60">@</span>
                  {peer?.id}
                </>
              )}
            </h2>
            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              {readOnly && <Eye className="h-3 w-3 shrink-0" />}
              {readOnly
                ? "observing · read-only"
                : (formatActivities(activities) ?? display.subtitle)}
            </p>
          </div>
        </button>
        {/* Save Contact — only for unsaved 1-on-1 peers, left of search. */}
        {peer && !contact && (
          <Button
            size="sm"
            onClick={() => setSaveOpen(true)}
            className="shrink-0 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            title="save contact"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Save Contact
          </Button>
        )}
        {peer && contact && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSaveOpen(true)}
            className="shrink-0 gap-1.5 opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
            title="edit saved contact"
          >
            <NotePencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
        {/* Crons — only in a 1-on-1 silicon chat, left of search. */}
        {peer?.kind === "silicon" && search === null && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setCronOpen(true)}
            aria-label="view crons"
            title="crons this silicon set for you"
          >
            <Clock />
          </Button>
        )}
        {search === null ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setSearch("")}
            aria-label="search messages"
            title="search messages"
          >
            <MagnifyingGlass />
          </Button>
        ) : (
          <SearchBar value={search} onChange={setSearch} onClose={() => setSearch(null)} />
        )}
      </header>

      {peer?.kind === "silicon" && (
        <CronDrawer
          siliconId={peer.id}
          siliconName={contact?.name ?? peer.name}
          open={cronOpen}
          onOpenChange={setCronOpen}
        />
      )}

      {peer && (
        <SaveContactDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          peer={peer}
          existing={contact}
          onSaved={() => onContactsChanged?.()}
        />
      )}

      <ProfileDrawer
        room={room}
        events={events}
        currentUsername={carbon?.username}
        contact={contact}
        onEditContact={peer ? () => setSaveOpen(true) : undefined}
        open={profileOpen}
        onOpenChange={(v) => {
          setProfileOpen(v);
          if (!v) setFocusSender(null);
        }}
        focusSender={focusSender}
      />

      <ScrollArea ref={scrollRootRef} className="flex-1">
        {/* Messages bleed to the same horizontal margins as the navbar's
            logo (left) and avatar (right) — px-6 matches the app shell. */}
        <div className="w-full px-6 py-4">
          {loading ? (
            <div className="text-sm text-muted-foreground">loading messages…</div>
          ) : filteredEvents.length === 0 ? (
            <div className="border bg-muted/40 p-6 text-sm text-muted-foreground">
              {search ? "no matches in this chat" : "no messages yet. say hi."}
            </div>
          ) : (
            filteredEvents.map((e, i) => {
              // Group consecutive messages by (sender_handle, minute):
              //   • showSender on the FIRST bubble of a run (received only)
              //   • showTime on the LAST bubble of a run
              // The minute compare uses the YYYY-MM-DDTHH:MM slice of the ISO
              // string so we don't bring a Date constructor + tz math into a
              // hot render path.
              const prev = filteredEvents[i - 1];
              const next = filteredEvents[i + 1];
              const sameAs = (a?: LocalEvent | Event) =>
                !!a &&
                a.sender_handle === e.sender_handle &&
                a.created_at.slice(0, 16) === e.created_at.slice(0, 16);
              const showSender = !sameAs(prev);
              const showTime = !sameAs(next);
              return (
                <MessageBubble
                  key={e._clientId ?? e.event_id}
                  event={e}
                  isMine={isMyEvent(e, myUsername)}
                  myHandle={myUsername}
                  replyToEvent={
                    e.reply_to_event_id ? eventById.get(e.reply_to_event_id) : undefined
                  }
                  isDirect={room.kind === "direct"}
                  status={e._status}
                  senderPhotoUrl={photoFor(e.sender_kind, e.sender_handle)}
                  senderAvatarKind={e.sender_kind}
                  senderDisplayName={displayNameFor(e.sender_kind, e.sender_handle)}
                  onSenderClick={openSenderProfile}
                  onTakeBack={readOnly ? undefined : onTakeBack}
                  showSender={showSender}
                  showTime={showTime}
                  reactions={reactionsByTarget.get(e.event_id) ?? undefined}
                  onReply={readOnly ? undefined : onReply}
                  onReact={readOnly ? undefined : onReact}
                  onForward={readOnly ? undefined : onForward}
                  onDelete={readOnly ? undefined : onSelfDelete}
                />
              );
            })
          )}
          {shouldShowActiveProgress ? (
            <ProgressLine
              entry={activeProgress}
              avatarSeed={progressAvatarHandle || headerSeed}
              avatarSrc={progressAvatarSrc}
              avatarFamily={peer?.kind === "silicon" ? "silicon" : "carbon"}
            />
          ) : null}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      {readOnly ? (
        <div className="flex items-center justify-center gap-2 border-t bg-muted/40 px-6 py-4 text-xs text-muted-foreground">
          <Eye className="h-3.5 w-3.5" />
          You&rsquo;re observing this silicon-to-silicon conversation. It&rsquo;s
          read-only — you can&rsquo;t send messages here.
        </div>
      ) : (
        <Composer
          roomId={room.room_id}
          onOptimisticAdd={onOptimisticAdd}
          onAck={onAck}
          onFail={onFail}
          onOptimisticUpdate={onOptimisticUpdate}
          droppedFile={droppedFile}
          onDroppedFileConsumed={() => setDroppedFile(null)}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          delayTextForSilicon={room.kind === "direct" && peer?.kind === "silicon"}
        />
      )}

      {/* Visual hint while a file is hovering over the chat surface. */}
      <DropOverlay visible={isDropTarget} />

      <ForwardDialog
        open={!!forwardingEvent}
        onOpenChange={(v) => !v && setForwardingEvent(null)}
        event={forwardingEvent}
        rooms={allRooms}
        sourceRoomId={room.room_id}
      />

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete message?</DialogTitle>
            <DialogDescription>
              This removes the message for everyone. This can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ProgressLine({
  entry,
  avatarSeed,
  avatarSrc,
  avatarFamily,
}: {
  entry: ProgressEntry;
  avatarSeed: string;
  avatarSrc?: string | null;
  avatarFamily?: "carbon" | "silicon";
}) {
  const initialTickRef = React.useRef<number | null>(null);
  if (initialTickRef.current === null) {
    initialTickRef.current = randomProgressTick(progressLineOptions(entry).length, -1);
  }
  const [tick, setTick] = React.useState(initialTickRef.current);
  const [typed, setTyped] = React.useState("");
  const typedRef = React.useRef("");
  const pendingTargetRef = React.useRef<string | null>(null);
  const [target, setTarget] = React.useState(() => formatProgressLine(entry, initialTickRef.current ?? 0));
  const targetRef = React.useRef(target);
  const [phase, setPhase] = React.useState<"typing" | "holding" | "erasing">("typing");
  const holdMsRef = React.useRef(6500);
  const typedDoneAtRef = React.useRef(0);

  React.useEffect(() => {
    typedRef.current = typed;
  }, [typed]);

  React.useEffect(() => {
    targetRef.current = target;
  }, [target]);

  React.useEffect(() => {
    const nextTick = randomProgressTick(progressLineOptions(entry).length, tick);
    const next = formatProgressLine(entry, nextTick);
    const currentTyped = typedRef.current;
    const currentTarget = targetRef.current;
    const currentComplete = currentTyped === currentTarget && currentTarget.length > 0;
    setTick(nextTick);

    if (currentTyped === next) {
      pendingTargetRef.current = null;
      return;
    }

    if (currentTyped) {
      pendingTargetRef.current = next;
      if (!currentComplete) return;

      const typedDoneAt = typedDoneAtRef.current || Date.now();
      const remainingHold = MIN_PROGRESS_STATUS_MS - (Date.now() - typedDoneAt);
      if (remainingHold > 0) {
        holdMsRef.current = remainingHold;
        setPhase("holding");
      } else {
        setPhase("erasing");
      }
      return;
    }

    pendingTargetRef.current = null;
    typedDoneAtRef.current = 0;
    if (currentTarget !== next) {
      setTarget(next);
    }
    setTyped("");
    setPhase("typing");
  }, [entry.groupId, entry.state, entry.note, entry.source]);

  React.useEffect(() => {
    let timeoutId: number | null = null;
    if (phase === "typing") {
      if (typed.length < target.length) {
        timeoutId = window.setTimeout(
          () => setTyped(target.slice(0, typed.length + 1)),
          PROGRESS_TYPE_MS.min +
            Math.floor(Math.random() * (PROGRESS_TYPE_MS.max - PROGRESS_TYPE_MS.min + 1)),
        );
      } else {
        if (!typedDoneAtRef.current) typedDoneAtRef.current = Date.now();
        if (pendingTargetRef.current) {
          const remainingHold = MIN_PROGRESS_STATUS_MS - (Date.now() - typedDoneAtRef.current);
          if (remainingHold > 0) {
            holdMsRef.current = remainingHold;
            setPhase("holding");
          } else {
            setPhase("erasing");
          }
          return;
        }
        if (entry.source === "server") return;
        holdMsRef.current = 5000 + Math.floor(Math.random() * 5001);
        setPhase("holding");
      }
    } else if (phase === "holding") {
      timeoutId = window.setTimeout(() => setPhase("erasing"), holdMsRef.current);
    } else if (typed.length > 0) {
      timeoutId = window.setTimeout(() => setTyped((text) => text.slice(0, -1)), PROGRESS_TYPE_MS.erase);
    } else {
      if (pendingTargetRef.current) {
        typedDoneAtRef.current = 0;
        setTarget(pendingTargetRef.current);
        pendingTargetRef.current = null;
        setPhase("typing");
        return;
      }
      const nextTick = randomProgressTick(progressLineOptions(entry).length, tick);
      setTick(nextTick);
      typedDoneAtRef.current = 0;
      setTarget(formatProgressLine(entry, nextTick));
      setPhase("typing");
    }
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [phase, typed, target, entry, tick]);

  return (
    <div className="my-2 flex w-full items-center justify-start gap-2">
      <div className="w-7 shrink-0">
        <IdAvatar seed={avatarSeed || "?"} src={avatarSrc} size={28} family={avatarFamily ?? "carbon"} />
      </div>
      <div className="min-w-0 max-w-[70%]">
        <span className="silicon-activity-line flex min-h-7 items-center text-sm">
          <span className="inline-flex min-w-0 max-w-full items-center gap-3 overflow-hidden">
            <span className="silicon-activity-copy">
              {typed || "\u00a0"}
            </span>
            <span className="silicon-activity-core" aria-hidden="true">
              {Array.from({ length: 16 }, (_, i) => (
                <span key={i} />
              ))}
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}

function progressLineOptions(entry: ProgressEntry): string[] {
  const note = meaningfulProgressNote(entry.note, entry.state);
  if (note) return [sentenceCase(note)];
  if (entry.source === "server") return [progressStateLabel(entry.state)];
  return PROGRESS_STATE_COPY[entry.state] ?? SILICON_PROGRESS_COPY;
}

function randomProgressTick(length: number, previous: number): number {
  if (length <= 1) return 0;
  let next = Math.floor(Math.random() * length);
  if (next === previous) {
    next = (next + 1 + Math.floor(Math.random() * (length - 1))) % length;
  }
  return next;
}

function formatProgressLine(entry: ProgressEntry, tick = 0): string {
  const lines = progressLineOptions(entry);
  return truncateProgressLine(lines[tick % lines.length]);
}

function truncateProgressLine(value: string): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= MAX_PROGRESS_LINE_CHARS) return text;
  return `${text.slice(0, Math.max(0, MAX_PROGRESS_LINE_CHARS - 2)).trimEnd()}..`;
}

function progressStateLabel(state: ProgressState): string {
  switch (state) {
    case "reading_file":
      return "Reading file";
    case "writing_file":
      return "Writing file";
    case "executing":
      return "Executing command";
    case "searching_web":
      return "Searching web";
    case "done":
      return "Wrapping up";
    case "thinking":
    default:
      return "Working";
  }
}

function meaningfulProgressNote(note: string, state: ProgressState): string {
  const text = collapsePathMentions(note.trim());
  if (!text) return "";
  const normalized = text.toLowerCase().replace(/[.…]+$/g, "").trim();
  if (state === "thinking" && (normalized === "thinking" || normalized.startsWith("thought for "))) {
    return "";
  }
  if (
    state === "executing" &&
    (normalized.startsWith("executing command failed") ||
      normalized.startsWith("message failed:"))
  ) {
    return sentenceCase(text);
  }
  if (
    state === "executing" &&
    (normalized.startsWith("executing:") ||
      normalized === "executing command" ||
      normalized.startsWith("executing output:") ||
      normalized.startsWith("executing done:"))
  ) {
    return "Executing command";
  }
  return text;
}

function collapsePathMentions(value: string): string {
  return value.replace(
    /(`?)(?!(?:[a-z][a-z0-9+.-]*:\/\/))((?:~?\/|\.{1,2}\/|[A-Za-z]:[\\/]|(?:[A-Za-z0-9_.-]+[\\/]))[^\s`"'<>]*)(`?)/gi,
    (match, open: string, rawPath: string, close: string, offset: number, input: string) => {
      if (input.slice(Math.max(0, offset - 8), offset).includes("://")) return match;
      const suffixMatch = rawPath.match(/[),.;:\]}]+$/);
      const suffix = suffixMatch?.[0] ?? "";
      const path = suffix ? rawPath.slice(0, -suffix.length) : rawPath;
      const parts = path.split(/[\\/]+/).filter(Boolean);
      const fileName = parts[parts.length - 1];
      if (!fileName || fileName === path) return match;
      const tick = open || close ? "`" : "";
      return `${tick}${fileName}${tick}${suffix}`;
    },
  );
}

function sentenceCase(value: string): string {
  const text = value.trim();
  if (!text) return SILICON_PROGRESS_COPY[0];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function SearchBar({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex w-56 items-center gap-1 border border-input bg-transparent px-2 transition-colors focus-within:border-ring">
      <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 opacity-60" />
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Stop here so Esc closes the search field, not the whole chat.
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="search messages"
        className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="close search"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="border-2 border-dashed border-foreground/30 bg-card px-6 py-4 text-sm text-foreground/80">
        drop to attach
      </div>
    </div>
  );
}

function isMyEvent(e: Event, myUsername: string | null) {
  if (!myUsername) return false;
  return e.sender_kind === "carbon" && e.sender_handle === myUsername;
}

/**
 * Reconcile a fresh server snapshot with our locally-tracked events without
 * blowing away optimistic rows or hard-won _status upgrades.
 *
 * • Every server event is the source of truth for its content — but we keep
 *   our existing `_status` so a poll never downgrades a "read" tick back to
 *   "delivered".
 * • Any local row the server didn't echo back this round is preserved (our
 *   optimistic placeholders, and any just-sent rows that didn't fit in the
 *   100-event polling window).
 */
/**
 * Render the active-state map as a single subtitle line.
 *   • @alice is typing…
 *   • @alice is uploading…
 *   • @alice is recording…
 *   • @alice, @bob are typing…
 * Returns null when nothing is active, so the caller falls back to the
 * static room subtitle.
 */
function formatActivities(
  acts: Record<string, { state: "typing" | "uploading" | "recording"; until: number }>,
): string | null {
  const entries = Object.entries(acts);
  if (entries.length === 0) return null;
  // If everyone is doing the same thing, fold the verb. Otherwise pick one.
  const states = new Set(entries.map(([, a]) => a.state));
  const verb = states.size === 1 ? [...states][0] : "typing";
  const handles = entries.map(([h]) => `@${h}`);
  const who =
    handles.length === 1
      ? handles[0]
      : `${handles.slice(0, -1).join(", ")} & ${handles.slice(-1)}`;
  return `${who} is ${verb}…`;
}

function roomSnippetKey(roomId: string): string {
  return `silicon-interface:room-snippet:${roomId}`;
}

function readRoomEventSnippet(roomId: string): LocalEvent[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(roomSnippetKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { events?: Event[] };
    if (!Array.isArray(parsed.events)) return null;
    return parsed.events.filter((event) => event && typeof event.event_id === "string");
  } catch {
    return null;
  }
}

function saveRoomEventSnippet(roomId: string, events: LocalEvent[]): void {
  if (typeof window === "undefined") return;
  try {
    const durable = events
      .filter((event) => !event.event_id.startsWith("temp-") && event.type !== "m.progress")
      .slice(-ROOM_SNIPPET_LIMIT)
      .map(({ _clientId, _status, ...event }) => event);
    window.localStorage.setItem(
      roomSnippetKey(roomId),
      JSON.stringify({ savedAt: Date.now(), events: durable }),
    );
  } catch {
    /* Keep chat usable when localStorage is unavailable or full. */
  }
}

function mergeServerEvents(
  prev: LocalEvent[],
  server: Event[],
  myUsername: string | null,
): LocalEvent[] {
  const serverIds = new Set(server.map((e) => e.event_id));
  const byPrev = new Map(prev.map((e) => [e.event_id, e] as const));
  const merged: LocalEvent[] = server.map((ev) => {
    const existing = byPrev.get(ev.event_id);
    if (existing) {
      return { ...ev, _status: existing._status, _clientId: existing._clientId };
    }
    const mine = ev.sender_handle && ev.sender_handle === myUsername;
    return { ...ev, _status: mine ? ("delivered" as MessageStatus) : undefined };
  });
  const localOnly = prev.filter((e) => !serverIds.has(e.event_id));
  return [...merged, ...localOnly];
}
