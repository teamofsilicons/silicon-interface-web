"use client";

import * as React from "react";
import { Loader2, Paperclip, Send, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  roomId: string;
}

export function Composer({ roomId }: Props) {
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [voiceMode, setVoiceMode] = React.useState(false);
  const [voiceName, setVoiceName] = React.useState("Puck");
  const [scene, setScene] = React.useState("");
  const [style, setStyle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const reset = () => {
    setText("");
    setFile(null);
    setVoiceMode(false);
    setScene("");
    setStyle("");
  };

  const sendText = async () => {
    if (!text.trim() && !file && !voiceMode) return;
    setBusy(true);
    try {
      if (file) {
        const r = await api.presignUpload({
          mime: file.type || "application/octet-stream",
          size: file.size,
          kind: file.type.startsWith("image/") ? "image" : "file",
          filename: file.name,
          room_id: roomId,
        });
        const mediaId = r.media.media_id;
        if (!r.upload.dev_mode) {
          const form = new FormData();
          for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
          form.append("file", file);
          await fetch(r.upload.url, { method: "POST", body: form });
        }
        await api.sendEvent(roomId, {
          type: file.type.startsWith("image/") ? "m.image" : "m.file",
          content: {
            media_id: mediaId,
            mime: file.type,
            caption: text.trim() || file.name,
          },
        });
      }
      if (voiceMode && text.trim()) {
        await api.tts({
          text: text.trim(),
          voice: voiceName,
          scene: scene || undefined,
          style: style || undefined,
          room_id: roomId,
        });
        toast.success("TTS queued");
      } else if (!file && text.trim()) {
        await api.sendEvent(roomId, {
          type: "m.text",
          content: { body: text.trim() },
        });
      }
      reset();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t bg-background p-3">
      {file && (
        <div className="flex items-center justify-between rounded-md border bg-muted px-3 py-1.5 text-xs">
          <span className="truncate">
            attached: <strong>{file.name}</strong> ({Math.round(file.size / 1024)} KB)
          </span>
          <Button size="icon" variant="ghost" onClick={() => setFile(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {voiceMode && (
        <div className="grid grid-cols-3 gap-2 rounded-md border bg-muted/40 p-2">
          <div className="space-y-1">
            <label className="text-[10px] uppercase text-muted-foreground">voice</label>
            <Input value={voiceName} onChange={(e) => setVoiceName(e.target.value)} placeholder="Puck" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase text-muted-foreground">scene</label>
            <Input value={scene} onChange={(e) => setScene(e.target.value)} placeholder="on terrace" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase text-muted-foreground">style</label>
            <Input value={style} onChange={(e) => setStyle(e.target.value)} placeholder="dreamy" />
          </div>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => fileInputRef.current?.click()}
          title="attach file"
          disabled={busy}
        >
          <Paperclip />
        </Button>
        <Button
          size="icon"
          variant={voiceMode ? "default" : "ghost"}
          onClick={() => setVoiceMode((v) => !v)}
          title="send as silicon-spoken voice (TTS)"
          disabled={busy}
        >
          <Sparkles />
        </Button>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={voiceMode ? "what should the silicon say?" : "message…"}
          className="min-h-[40px] flex-1 resize-none"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendText();
            }
          }}
        />
        <Button onClick={sendText} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Send />}
          <span className="hidden sm:inline">send</span>
        </Button>
      </div>
    </div>
  );
}
