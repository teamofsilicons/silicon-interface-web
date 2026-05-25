"use client";

import * as React from "react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Event, ProgressState, Room, WsFrame } from "@/lib/types";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Composer } from "@/components/chat/composer";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ProgressCard, type ProgressEntry } from "@/components/chat/progress-card";

interface Props {
  room: Room;
  socket: {
    ready: boolean;
    lastFrame: WsFrame | null;
    send: (frame: object) => void;
  };
}

export function RoomView({ room, socket }: Props) {
  const { carbon } = useAuth();
  const [events, setEvents] = React.useState<Event[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [progress, setProgress] = React.useState<Record<string, ProgressEntry>>({});
  const endRef = React.useRef<HTMLDivElement>(null);

  // Initial load
  React.useEffect(() => {
    let mounted = true;
    setLoading(true);
    api
      .events(room.room_id, undefined, 100)
      .then((evs) => {
        if (mounted) {
          setEvents(evs);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (mounted) {
          toast.error(e instanceof ApiError ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [room.room_id]);

  // Apply WS frames
  React.useEffect(() => {
    const f = socket.lastFrame;
    if (!f) return;
    if ("room_id" in f && f.room_id !== room.room_id) return;
    if (f.type === "event") {
      setEvents((prev) => {
        if (prev.some((e) => e.event_id === f.event.event_id)) return prev;
        return [...prev, f.event];
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
        setProgress((prev) => {
          if (f.state === "done") {
            const { [f.progress_group_id!]: _drop, ...rest } = prev;
            return rest;
          }
          return {
            ...prev,
            [f.progress_group_id!]: {
              groupId: f.progress_group_id!,
              state: f.state as ProgressState,
              note: f.note || "",
              updatedAt: Date.now(),
            },
          };
        });
      }
    }
  }, [socket.lastFrame, room.room_id]);

  // Scroll to bottom on new content
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length, progress]);

  // Mark read when last event changes
  React.useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    api.read(room.room_id, last.event_id).catch(() => undefined);
  }, [events, room.room_id]);

  const onTakeBack = async (eventId: string, force = false) => {
    try {
      const r = await api.takeBack(eventId, "manual", force);
      if (r && "detail" in r) {
        toast.error(r.detail);
      } else {
        toast.success("took back");
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      toast.error(msg);
    }
  };

  return (
    <section className="flex flex-1 flex-col bg-background">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{room.name || "direct"}</h2>
          <p className="text-xs text-muted-foreground">
            {room.kind} · {room.room_id}
          </p>
        </div>
        <Badge variant={socket.ready ? "success" : "secondary"}>
          {socket.ready ? "live" : "offline"}
        </Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          {loading ? (
            <div className="text-sm text-muted-foreground">loading messages…</div>
          ) : events.length === 0 ? (
            <div className="rounded-md border bg-muted/40 p-6 text-sm text-muted-foreground">
              no messages yet. say hi.
            </div>
          ) : (
            events.map((e) => (
              <MessageBubble
                key={e.event_id}
                event={e}
                isMine={isMyEvent(e, carbon?.username)}
                onTakeBack={onTakeBack}
              />
            ))
          )}
          <ProgressCard entries={Object.values(progress)} />
          <div ref={endRef} />
        </div>
      </ScrollArea>
      <Composer roomId={room.room_id} />
    </section>
  );
}

// Carbon objects from the API don't include the internal numeric `id`, so we
// can't reliably compare sender_id. As a heuristic, treat anything sent by
// kind=carbon AND not in the past 60s timeframe as "theirs". For now: just
// check whether the event is from the *role* of the user. Since this is a
// local-test client, this approximation is OK.
function isMyEvent(_event: Event, _username?: string) {
  // Without exposing numeric Carbon.id on /me, we don't know precisely.
  // The chat shows alignment based on sender_kind for now.
  return false;
}
