"use client";

import * as React from "react";
import { Loader2, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

interface Props {
  target: string;
  onFill: (code: string) => void;
}

export function DevCodeButton({ target, onFill }: Props) {
  const [loading, setLoading] = React.useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={loading || !target}
      title="Fetches the most recent OTP for this target from the backend (DEBUG-only endpoint)."
      onClick={async () => {
        setLoading(true);
        try {
          const r = await api.devLastOtp(target);
          onFill(r.code);
          toast.success(`dev code for ${target}: ${r.code}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "no code yet";
          toast.error(msg);
        } finally {
          setLoading(false);
        }
      }}
    >
      {loading ? <Loader2 className="animate-spin" /> : <Wand2 />}
      <span>fetch dev code</span>
    </Button>
  );
}
