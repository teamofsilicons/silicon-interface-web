"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, X } from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import type { Announcement } from "@/lib/types";
import { relativeTime } from "@/lib/utils";
import { printConsoleBanner } from "@/lib/console-banner";
import {
  loadNotifications,
  loadUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_EVENT,
  NOTIFICATION_NAVIGATE_EVENT,
  type InterfaceNotification,
} from "@/lib/notifications";

import { IdAvatar } from "@/components/profile/id-avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const ANNOUNCEMENT_EVENT = "silicon-interface:announcement";

function seenKey(ownerId: string) {
  return `silicon-interface:announcements-seen:${encodeURIComponent(ownerId)}`;
}

function loadSeen(ownerId: string): number {
  try {
    return Number(window.localStorage.getItem(seenKey(ownerId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** The bell — per-message notifications (the store the chat page writes on
 *  every incoming message) plus team announcements: product news, updates. */
export function NotificationCenter({ ownerId }: { ownerId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<Announcement[]>([]);
  const [seen, setSeen] = React.useState(0);
  // Per-message room notifications from src/lib/notifications.ts. Loaded in an
  // effect (never at render) so SSR/hydration match; kept live via the store's
  // change event.
  const [messages, setMessages] = React.useState<InterfaceNotification[]>([]);
  const [messageUnread, setMessageUnread] = React.useState(0);

  const announcementUnread = items.filter((a) => a.id > seen).length;
  const unread = announcementUnread + messageUnread;

  // §4a — one-step scale pop when the unread count *rises*.
  const prevUnread = React.useRef(unread);
  const [bump, setBump] = React.useState(0);
  React.useEffect(() => {
    if (unread > prevUnread.current) setBump((b) => b + 1);
    prevUnread.current = unread;
  }, [unread]);

  const reload = React.useCallback(() => {
    api
      .announcements()
      .then(setItems)
      .catch(() => undefined);
  }, []);

  const reloadMessages = React.useCallback(() => {
    setMessages(loadNotifications(ownerId));
    setMessageUnread(loadUnreadCount(ownerId));
  }, [ownerId]);

  React.useEffect(() => {
    setSeen(loadSeen(ownerId));
    reload();
    printConsoleBanner();
  }, [ownerId, reload]);

  // Message-store sync: seed on mount/owner switch (deferred a microtask so
  // the effect body stays free of sync setState), then follow the change
  // event `addNotification`/`markNotificationRead`/… dispatch on every write.
  React.useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) reloadMessages();
    });
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ ownerId?: string }>).detail;
      if (!detail?.ownerId || detail.ownerId === ownerId) reloadMessages();
    };
    window.addEventListener(NOTIFICATION_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(NOTIFICATION_EVENT, onChange);
    };
  }, [ownerId, reloadMessages]);

  // A live announcement frame landed on the socket — fold it in.
  React.useEffect(() => {
    const onAnnouncement = (event: Event) => {
      const a = (event as CustomEvent<Announcement>).detail;
      if (!a?.id) return;
      setItems((prev) => (prev.some((x) => x.id === a.id) ? prev : [a, ...prev]));
    };
    window.addEventListener(ANNOUNCEMENT_EVENT, onAnnouncement);
    return () => window.removeEventListener(ANNOUNCEMENT_EVENT, onAnnouncement);
  }, []);

  // Opening the inbox is seeing it (announcements only — message rows stay
  // unread until clicked or "mark all read").
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && items.length > 0) {
      const top = items[0].id;
      try {
        window.localStorage.setItem(seenKey(ownerId), String(top));
      } catch {
        /* private mode — fine */
      }
      setSeen(top);
    }
  };

  // Clicking a message notification marks it read and opens its room. On the
  // chat page we raise the soft-navigation event it already listens for (the
  // History-API path that keeps the live socket); anywhere else, route there.
  const openMessage = (n: InterfaceNotification) => {
    markNotificationRead(ownerId, n.id);
    setOpen(false);
    if (window.location.pathname.startsWith("/chat")) {
      window.dispatchEvent(
        new CustomEvent(NOTIFICATION_NAVIGATE_EVENT, { detail: { roomId: n.roomId } }),
      );
    } else {
      router.push(`/chat?room=${encodeURIComponent(n.roomId)}`);
    }
  };

  const empty = messages.length === 0 && items.length === 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative grid h-9 w-9 place-items-center border text-foreground transition-colors hover:bg-accent"
          aria-label={unread > 0 ? `${unread} unread notifications` : "notifications"}
          title="notifications"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 ? (
            <span
              key={bump}
              className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center bg-foreground px-1 font-mono text-[10px] font-semibold leading-none text-background motion-reduce:animate-none"
              style={bump > 0 ? { animation: "unread-bump 0.28s ease-out" } : undefined}
            >
              {unread > 99 ? "99+" : unread}
              <style>{"@keyframes unread-bump{0%{transform:scale(1)}40%{transform:scale(1.35)}100%{transform:scale(1)}}"}</style>
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-1.5rem))]">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Notifications</div>
            <div className="label-mono mt-0.5">{unread} unread</div>
          </div>
          <div className="flex items-center gap-1">
            {messageUnread > 0 ? (
              <button
                type="button"
                className="label-mono border px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => markAllNotificationsRead(ownerId)}
              >
                mark all read
              </button>
            ) : null}
            <button
              type="button"
              className="grid h-8 w-8 place-items-center text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setOpen(false)}
              aria-label="close notifications"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto">
          {empty ? (
            <div className="px-4 py-8 text-center font-mono text-xs text-muted-foreground">
              <span>&gt; inbox is quiet.</span>
              {/* blinking caret — steps(1) hard blink, stilled under reduced-motion */}
              <span
                aria-hidden
                className="ml-0.5 inline-block h-[1em] w-[0.55ch] translate-y-[0.12em] border-r border-current motion-reduce:animate-none"
                style={{ animation: "qi-caret 0.9s steps(1, end) infinite" }}
              />
              <style>{"@keyframes qi-caret{0%,49%{opacity:1}50%,100%{opacity:0}}"}</style>
            </div>
          ) : (
            <>
              {/* Per-message notifications — newest first, click to open the room. */}
              {messages.length > 0 ? (
                <>
                  <div className="label-mono border-b bg-muted/40 px-4 py-1.5">messages</div>
                  <ul className="divide-y border-b">
                    {messages.map((n) => (
                      <li key={n.id} className="relative">
                        {!n.read ? (
                          <span
                            aria-label="unread"
                            className="pointer-events-none absolute right-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary"
                          />
                        ) : null}
                        <button
                          type="button"
                          onClick={() => openMessage(n)}
                          className="block w-full px-4 py-3 text-left transition-colors hover:bg-accent"
                        >
                          <span className="flex items-start gap-3 pr-4">
                            <IdAvatar
                              seed={n.avatarSeed ?? n.roomId}
                              src={n.avatarUrl}
                              size={28}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center justify-between gap-3">
                                <span className="min-w-0 truncate text-sm font-semibold leading-snug">
                                  {n.title}
                                </span>
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {relativeTime(n.at)}
                                </span>
                              </span>
                              <span className="mt-0.5 block truncate text-xs leading-relaxed text-muted-foreground">
                                {n.body}
                              </span>
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {/* Team announcements — product news, updates. */}
              {items.length > 0 ? (
                <>
                  {messages.length > 0 ? (
                    <div className="label-mono border-b bg-muted/40 px-4 py-1.5">
                      announcements
                    </div>
                  ) : null}
                  <ul className="divide-y">
                    {items.map((item) => {
                      const isUnread = item.id > seen;
                      // Hierarchy: kind chip → title → description → link. A single
                      // dot on the right marks unread; read and unread rows are
                      // otherwise identical.
                      const inner = (
                        <span className="block min-w-0 pr-4">
                          <span className="flex items-center justify-between gap-3">
                            <span className="label-mono shrink-0 border px-1.5 py-0.5">
                              {item.kind}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {relativeTime(item.created_at)}
                            </span>
                          </span>
                          <span className="mt-1.5 block text-sm font-semibold leading-snug">
                            {item.title}
                          </span>
                          {item.body ? (
                            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                              {item.body}
                            </span>
                          ) : null}
                          {item.url ? (
                            <span className="mt-1.5 block truncate text-xs text-foreground/70 underline underline-offset-2">
                              {item.url}
                            </span>
                          ) : null}
                        </span>
                      );
                      return (
                        <li key={item.id} className="relative">
                          {/* Unread dot — rightmost, vertically centered. */}
                          {isUnread ? (
                            <span
                              aria-label="unread"
                              className="pointer-events-none absolute right-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary"
                            />
                          ) : null}
                          {item.url ? (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block px-4 py-3 transition-colors hover:bg-accent"
                            >
                              {inner}
                            </a>
                          ) : (
                            <div className="px-4 py-3 transition-colors hover:bg-accent">{inner}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
