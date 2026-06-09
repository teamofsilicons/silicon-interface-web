"use client";

import * as React from "react";
import Link from "next/link";

import { useAuth } from "@/lib/auth";

import { Logo } from "@/components/logo";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { IdAvatar } from "@/components/profile/id-avatar";

interface Props {
  // Retained for layout call-site compatibility; the navbar no longer hosts the
  // chat/dev/settings tabs, so this is intentionally unused.
  active?: "chat" | "dev" | "settings";
}

export function AppHeader(_: Props) {
  const { carbon } = useAuth();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="flex w-full items-center justify-between px-6 py-3">
        <Link href="/" className="flex items-center" aria-label="Silicon Interface — home">
          <Logo size={26} withWordmark />
        </Link>
        {carbon && (
          <div className="flex items-center gap-2">
            <NotificationCenter ownerId={carbon.carbon_id} />
            <Link
              href="/settings"
              aria-label={`@${carbon.username} — profile`}
              title="profile"
              className="transition-opacity hover:opacity-80"
            >
              <IdAvatar seed={carbon.carbon_id} src={carbon.profile_photo_url} asciiSrc={carbon.profile_ascii_url} size={32} />
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
