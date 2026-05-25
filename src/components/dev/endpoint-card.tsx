"use client";

import * as React from "react";
import { Loader2, Play } from "lucide-react";

import { ApiError } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  title: string;
  description?: string;
  controls: React.ReactNode;
  run: () => Promise<unknown>;
  method: string;
  path: string;
}

export function EndpointCard({ title, description, controls, run, method, path }: Props) {
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<unknown>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setStatus(null);
    try {
      const r = await run();
      setResult(r);
      setStatus(200);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setStatus(e.status);
        setResult(e.body);
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-1 pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{title}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {method} {path}
          </span>
        </CardTitle>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="space-y-2">{controls}</div>
        <div className="flex items-center gap-2">
          <Button onClick={handleRun} disabled={loading} size="sm">
            {loading ? <Loader2 className="animate-spin" /> : <Play />}
            run
          </Button>
          {status !== null && (
            <span
              className={
                "rounded px-2 py-0.5 text-xs font-mono " +
                (status >= 200 && status < 300
                  ? "bg-green-100 text-green-800"
                  : "bg-red-100 text-red-800")
              }
            >
              {status}
            </span>
          )}
        </div>
        {error && (
          <pre className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </pre>
        )}
        {result !== null && (
          <pre className="max-h-96 overflow-auto rounded border bg-muted p-3 font-mono text-xs">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
