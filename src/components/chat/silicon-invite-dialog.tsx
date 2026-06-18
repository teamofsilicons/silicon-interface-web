"use client";

import * as React from "react";
import { Copy, CircleNotch } from "@phosphor-icons/react/dist/ssr";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import type { Invite } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Generate + show a link invite scoped to a single silicon. Whoever accepts
 * joins the silicon's owner team with access to this silicon. The invite API is
 * team-scoped (POST /teams/<slug>/invites with scope=silicon), so the silicon's
 * owner-team slug is required.
 */
export function SiliconInviteDialog({
  open,
  onOpenChange,
  teamSlug,
  siliconId,
  siliconName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  teamSlug: string;
  siliconId: string;
  siliconName: string;
}) {
  const [invite, setInvite] = React.useState<Invite | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  // Mint a fresh link each time the dialog opens (and only once per open).
  React.useEffect(() => {
    if (!open) {
      setInvite(null);
      setError("");
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    api
      .createInvite(teamSlug, { scope: "silicon", silicon_id: siliconId, channel: "link" })
      .then((inv) => {
        if (alive) setInvite(inv);
      })
      .catch((e) => {
        if (alive) {
          setError(
            e instanceof ApiError
              ? e.message
              : "Couldn't create an invite for this silicon.",
          );
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, teamSlug, siliconId]);

  const link = invite
    ? `${typeof window === "undefined" ? "" : window.location.origin}/join/${invite.token}?code=${invite.code}`
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Invite to @{siliconName}</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Anyone who accepts this link joins{" "}
          <span className="font-medium text-foreground">@{siliconName}</span> and can chat with it.
        </p>

        {loading ? (
          <div className="grid place-items-center py-10 text-muted-foreground">
            <CircleNotch className="h-6 w-6 animate-spin" />
          </div>
        ) : error ? (
          <p className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : invite ? (
          <div className="space-y-3">
            <div className="flex min-w-0 items-center gap-2 border bg-background px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  navigator.clipboard.writeText(link);
                  toast.success("invite link copied");
                }}
                aria-label="copy invite link"
              >
                <Copy />
              </Button>
            </div>
            <div className="flex items-center justify-between border bg-background px-3 py-2">
              <span className="label-mono text-[10px] text-muted-foreground">code</span>
              <span className="font-mono text-xl font-semibold tracking-wider">{invite.code}</span>
            </div>
            <div className="flex justify-center border p-3">
              <QRCodeSVG value={link} size={120} bgColor="#ede8e0" fgColor="#111111" level="M" />
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
