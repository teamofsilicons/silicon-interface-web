"use client";

import * as React from "react";
import { Activity, Pause, Play, Trash2 } from "lucide-react";

import { useChatSocket } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

type Entry = { ts: number; data: unknown };

export function WsLog() {
  const [paused, setPaused] = React.useState(false);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;

  const socket = useChatSocket({
    onFrame: (f) => {
      if (pausedRef.current) return;
      setEntries((prev) => [{ ts: Date.now(), data: f }, ...prev].slice(0, 200));
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" />
          live WS event log
          <Badge variant={socket.ready ? "success" : "secondary"}>
            {socket.ready ? "live" : "offline"}
          </Badge>
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? "resume" : "pause"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEntries([])}>
            <Trash2 className="h-3.5 w-3.5" />
            clear
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ScrollArea className="h-80 rounded border bg-muted">
          <div className="p-2 space-y-1">
            {entries.length === 0 ? (
              <div className="text-xs text-muted-foreground p-2">waiting for frames…</div>
            ) : (
              entries.map((e, i) => (
                <pre
                  key={i}
                  className="font-mono text-[11px] leading-tight whitespace-pre-wrap break-all"
                >
                  <span className="text-muted-foreground">
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>{" "}
                  {JSON.stringify(e.data)}
                </pre>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
