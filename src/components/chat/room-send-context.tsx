"use client";

import * as React from "react";

interface RoomSendContextValue {
  roomId: string;
  readOnly: boolean;
  sendText: (body: string, options?: { replyToEventId?: string }) => Promise<void>;
}

const RoomSendContext = React.createContext<RoomSendContextValue | null>(null);

export function RoomSendProvider({
  value,
  children,
}: {
  value: RoomSendContextValue;
  children: React.ReactNode;
}) {
  return <RoomSendContext.Provider value={value}>{children}</RoomSendContext.Provider>;
}

export function useRoomSend(): RoomSendContextValue | null {
  return React.useContext(RoomSendContext);
}
