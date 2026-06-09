"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, Trash, X } from "@phosphor-icons/react/dist/ssr";

import {
  clearNotifications,
  loadNotifications,
  loadUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_EVENT,
  NOTIFICATION_NAVIGATE_EVENT,
  trimmedCount,
  type InterfaceNotification,
} from "@/lib/notifications";
import { cn, relativeTime } from "@/lib/utils";
import { printConsoleBanner } from "@/lib/console-banner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IdAvatar } from "@/components/profile/id-avatar";

export function NotificationCenter({ ownerId }: { ownerId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<InterfaceNotification[]>([]);
  // Unread is read from the decoupled store counter, not derived from `items`,
  // so it stays accurate even when older unread notifications fall out of the
  // kept window. `trimmed` drives the "showing latest N" affordance.
  const [unread, setUnread] = React.useState(0);
  const [trimmed, setTrimmed] = React.useState(0);
  // §4a — one-step scale pop when the unread count *rises*. We bump a key so the
  // badge remounts its animation; the previous count is held in a ref so a
  // re-render that doesn't change `unread` never re-fires the pop.
  const prevUnread = React.useRef(unread);
  const [bump, setBump] = React.useState(0);
  React.useEffect(() => {
    if (unread > prevUnread.current) setBump((b) => b + 1);
    prevUnread.current = unread;
  }, [unread]);

  const reload = React.useCallback(() => {
    setItems(loadNotifications(ownerId));
    setUnread(loadUnreadCount(ownerId));
    setTrimmed(trimmedCount(ownerId));
  }, [ownerId]);

  React.useEffect(() => {
    // Mount-time read of client-only, localStorage-backed notifications.
    reload();
    // §7f — this client component always mounts in the chat shell, so it's a
    // reliable place to print the devtools banner once (guarded module-side).
    printConsoleBanner();
  }, [reload]);

  React.useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ ownerId?: string }>).detail;
      if (!detail?.ownerId || detail.ownerId === ownerId) reload();
    };
    // Cross-tab: only react to *this* owner's key. The previous prefix match
    // reloaded on any owner's notifications, so a second account in another tab
    // would churn this list.
    const onStorage = (event: StorageEvent) => {
      if (event.key === `silicon-interface:notifications:${encodeURIComponent(ownerId)}`) reload();
    };
    // Soft route when an OS notification is clicked — keeps the live socket.
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ roomId?: string }>).detail;
      if (detail?.roomId) router.push(`/chat?room=${encodeURIComponent(detail.roomId)}`);
    };
    window.addEventListener(NOTIFICATION_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    window.addEventListener(NOTIFICATION_NAVIGATE_EVENT, onNavigate);
    return () => {
      window.removeEventListener(NOTIFICATION_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(NOTIFICATION_NAVIGATE_EVENT, onNavigate);
    };
  }, [ownerId, reload, router]);

  const openRoom = (item: InterfaceNotification) => {
    markNotificationRead(ownerId, item.id);
    reload();
    setOpen(false);
    router.push(`/chat?room=${encodeURIComponent(item.roomId)}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          <button
            type="button"
            className="grid h-8 w-8 place-items-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen(false)}
            aria-label="close notifications"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 border-b px-4 py-2">
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              title="mark all read"
              aria-label="mark all notifications read"
              disabled={items.length === 0 || unread === 0}
              onClick={() => {
                markAllNotificationsRead(ownerId);
                reload();
              }}
            >
              <Check className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title="clear"
              aria-label="clear notifications"
              disabled={items.length === 0}
              onClick={() => {
                clearNotifications(ownerId);
                reload();
              }}
            >
              <Trash className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto">
          {items.length === 0 ? (
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
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => openRoom(item)}
                    className={cn(
                      "grid w-full grid-cols-[36px_minmax(0,1fr)] gap-3 px-4 py-3 text-left transition-colors hover:bg-accent",
                      !item.read && "bg-secondary/70",
                    )}
                  >
                    <IdAvatar
                      seed={item.avatarSeed ?? item.roomId}
                      src={item.avatarUrl ?? null}
                      size={36}
                    />
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-sm font-semibold">{item.title}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {relativeTime(item.at)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {item.body}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {trimmed > 0 ? (
            <div className="border-t px-4 py-2 text-center text-[10px] text-muted-foreground">
              showing latest {items.length} · {trimmed} older not shown
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

