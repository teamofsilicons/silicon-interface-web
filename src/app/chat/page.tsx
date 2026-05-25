"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import type { Room } from "@/lib/types";
import { useChatSocket } from "@/lib/ws";

import { RoomList } from "@/components/chat/room-list";
import { NewDirectDialog } from "@/components/chat/new-direct-dialog";
import { RoomView } from "@/components/chat/room-view";

export default function ChatPage() {
  const router = useRouter();
  const search = useSearchParams();
  const selected = search.get("room");
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const socket = useChatSocket();

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.rooms();
      setRooms(list);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // When a new event arrives in a room we don't yet have locally, refresh.
  React.useEffect(() => {
    if (!socket.lastFrame) return;
    if (socket.lastFrame.type === "event") {
      const rid = socket.lastFrame.room_id;
      if (!rooms.some((r) => r.room_id === rid)) {
        refresh();
      }
    }
  }, [socket.lastFrame, rooms, refresh]);

  const selectedRoom = rooms.find((r) => r.room_id === selected);

  return (
    <>
      <RoomList
        rooms={rooms}
        selectedId={selected}
        onSelect={(id) => router.push(`/chat?room=${id}`)}
        onNew={() => setDialogOpen(true)}
        loading={loading}
      />
      {selectedRoom ? (
        <RoomView room={selectedRoom} socket={socket} />
      ) : (
        <section className="flex flex-1 items-center justify-center bg-muted/20">
          <div className="max-w-md space-y-3 text-center">
            <h2 className="text-2xl font-bold tracking-tight">welcome</h2>
            <p className="text-sm text-muted-foreground">
              Pick a room on the left, or click <strong>new</strong> to start a direct
              conversation with another carbon or a silicon.
            </p>
          </div>
        </section>
      )}
      <NewDirectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(room) => {
          setRooms((prev) => (prev.some((r) => r.room_id === room.room_id) ? prev : [...prev, room]));
          router.push(`/chat?room=${room.room_id}`);
        }}
      />
    </>
  );
}
