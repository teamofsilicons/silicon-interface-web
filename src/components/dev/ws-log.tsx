"use client";

import * as React from "react";
import { Pause, Play, Pulse, Trash } from "@phosphor-icons/react/dist/ssr";

import { useChatSocket } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

type Entry = { id: number; ts: number; data: unknown };

export function WsLog() {
  const [paused, setPaused] = React.useState(false);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const pausedRef = React.useRef(paused);
  // Keep the ref in sync outside render so the onFrame closure always sees the
  // latest `paused` without re-subscribing the socket.
  React.useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  // Monotonic id so list keys are stable. The list is prepended, so array index
  // would reassign every existing row's key on each new frame, defeating React's
  // reconciliation (Date.now() also collides during a same-tick burst).
  const seqRef = React.useRef(0);

  const socket = useChatSocket({
    onFrame: (f) => {
      if (pausedRef.current) return;
      setEntries((prev) => [{ id: seqRef.current++, ts: Date.now(), data: f }, ...prev].slice(0, 200));
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Pulse className="h-4 w-4" />
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
            <Trash className="h-3.5 w-3.5" />
            clear
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ScrollArea className="h-80 rounded border bg-muted">
          <div className="p-2 space-y-1">
            {entries.length === 0 ? (
              <div className="p-2 font-mono text-xs text-muted-foreground">
                waiting for frames…
                {/* §2d — faint pulsing cursor, a heartbeat while the wire is
                    quiet; stilled under prefers-reduced-motion. */}
                <span
                  aria-hidden
                  className="ml-1 inline-block motion-reduce:animate-none"
                  style={{ animation: "ws-heartbeat 1.1s ease-in-out infinite" }}
                >
                  ▮
                </span>
                <style>{"@keyframes ws-heartbeat{0%,100%{opacity:0.25}50%{opacity:0.8}}"}</style>
              </div>
            ) : (
              entries.map((e) => (
                <pre
                  key={e.id}
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
