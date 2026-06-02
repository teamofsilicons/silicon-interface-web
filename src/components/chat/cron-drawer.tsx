"use client";

import * as React from "react";

import { api } from "@/lib/api";
import type { Cron } from "@/lib/types";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CronList } from "@/components/teams/cron-list";

/**
 * Crons a given silicon set up that include me. Opened from the cron icon in a
 * silicon DM header. `siliconId` is the peer's public silicon_id.
 */
export function CronDrawer({
  siliconId,
  siliconName,
  open,
  onOpenChange,
}: {
  siliconId: string;
  siliconName?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>crons from {siliconName ?? "this silicon"}</DialogTitle>
        </DialogHeader>
        {/* Remounts on each open (Radix unmounts closed content), so the body
            starts in its loading state and only setState's after the fetch. */}
        {open && <CronDrawerBody siliconId={siliconId} />}
      </DialogContent>
    </Dialog>
  );
}

function CronDrawerBody({ siliconId }: { siliconId: string }) {
  const [crons, setCrons] = React.useState<Cron[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await api.crons({ for: "me", setup_by: siliconId });
        if (alive) setCrons(rows);
      } catch {
        if (alive) setCrons([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [siliconId]);

  return <CronList crons={crons} loading={loading} />;
}
