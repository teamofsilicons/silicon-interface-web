"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { authStore } from "@/lib/auth";

/** Deep link: open (or start) a direct chat with a Carbon, composer ready. */
export default function CarbonDeepLink() {
  const params = useParams<{ carbonId: string }>();
  const router = useRouter();

  React.useEffect(() => {
    const handle = params.carbonId;
    if (!authStore.getAccess()) {
      router.replace(`/auth/login?identifier=${encodeURIComponent(handle)}`);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const carbon = await api.carbonByHandle(handle);
        const room = await api.directRoom("carbon", carbon.carbon_id);
        if (alive) router.replace(`/chat?room=${room.room_id}`);
      } catch {
        // QA medium: a stale QR / deleted Carbon used to bounce silently to
        // /chat, leaving the user at a dead end with no idea why. Explain it.
        if (alive) {
          toast.error(`couldn't find “${handle}” - that link may be expired`);
          router.replace("/chat");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [params.carbonId, router]);

  return (
    <main className="grid min-h-screen place-items-center">
      <span className="text-sm text-muted-foreground">opening chat…</span>
    </main>
  );
}
