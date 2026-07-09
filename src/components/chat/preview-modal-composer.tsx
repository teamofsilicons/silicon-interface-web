"use client";

import * as React from "react";
import { Microphone, PaperPlaneRight, Stop } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import { useRoomSend } from "@/components/chat/room-send-context";
import { useVoiceRecording } from "@/components/chat/voice-recording-provider";
import { cn } from "@/lib/utils";

export function PreviewModalComposer() {
  const roomSend = useRoomSend();
  const voice = useVoiceRecording();
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const statusId = React.useId();

  if (!roomSend) return null;

  const body = text.trim();
  const currentVoice = voice.draft;
  const voiceInThisRoom = currentVoice?.roomId === roomSend.roomId;
  const voiceBusy = currentVoice?.status === "recording" || currentVoice?.status === "sending";
  const voiceBlockedByOtherRoom = currentVoice && !voiceInThisRoom;

  const submit = async () => {
    if (!body || sending || roomSend.readOnly) return;
    setSending(true);
    setError(null);
    try {
      await roomSend.sendText(body);
      setText("");
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    } catch {
      setError("Couldn’t send. Your message is still here.");
    } finally {
      setSending(false);
    }
  };

  const startVoice = async () => {
    setError(null);
    if (roomSend.readOnly) return;
    if (voiceBlockedByOtherRoom) {
      setError(`You’re already recording in ${voice.roomName(currentVoice.roomId)}. Finish that recording before starting another.`);
      return;
    }
    await voice.start(roomSend.roomId);
  };

  const voiceStatus = currentVoice && voiceInThisRoom
    ? currentVoice.status === "recording"
      ? "Recording protected voice message. Closing the preview won’t discard it."
      : currentVoice.status === "failed"
        ? "Voice send failed. Your recording is still saved."
        : currentVoice.status === "sending"
          ? "Sending voice message..."
          : "Voice draft saved."
    : null;

  return (
    <div className="border-t bg-background p-3 sm:p-4">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {error ?? (sending ? "Sending..." : voiceStatus ?? "")}
      </div>
      <label htmlFor="preview-modal-message" className="sr-only">
        Message while viewing preview
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <textarea
          ref={textareaRef}
          id="preview-modal-message"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Message while viewing preview..."
          aria-describedby={statusId}
          disabled={roomSend.readOnly || sending}
          rows={1}
          className="max-h-28 min-h-11 flex-1 resize-none border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!body || sending || roomSend.readOnly}
            aria-label="Send message"
            className="min-h-11"
          >
            <PaperPlaneRight className="mr-1 h-4 w-4" />
            {sending ? "Sending..." : "Send message"}
          </Button>
          {currentVoice && voiceInThisRoom && currentVoice.status === "recording" ? (
            <Button type="button" variant="outline" onClick={voice.stop} className="min-h-11">
              <Stop className="mr-1 h-4 w-4" /> Stop voice
            </Button>
          ) : currentVoice && voiceInThisRoom && currentVoice.status !== "recording" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void voice.send()}
              disabled={currentVoice.status === "sending"}
              className="min-h-11"
            >
              <PaperPlaneRight className="mr-1 h-4 w-4" />
              {currentVoice.status === "failed" ? "Retry voice" : "Send voice"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => void startVoice()}
              disabled={roomSend.readOnly || (voiceBusy && voiceInThisRoom)}
              aria-label="Record voice message"
              className="min-h-11"
            >
              <Microphone className="mr-1 h-4 w-4" /> Record voice message
            </Button>
          )}
        </div>
      </div>
      <div
        id={statusId}
        className={cn(
          "mt-2 min-h-4 text-xs",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {roomSend.readOnly
          ? "This room is read-only."
          : error ?? voiceStatus ?? "Enter sends. Shift+Enter adds a new line."}
      </div>
    </div>
  );
}
