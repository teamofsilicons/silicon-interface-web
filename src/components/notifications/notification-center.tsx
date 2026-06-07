"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, Trash, X } from "@phosphor-icons/react/dist/ssr";

import {
  browserNotificationPermission,
  clearNotifications,
  loadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_EVENT,
  requestBrowserNotifications,
  type InterfaceNotification,
} from "@/lib/notifications";
import { cn, relativeTime } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IdAvatar } from "@/components/profile/id-avatar";

export function NotificationCenter({ ownerId }: { ownerId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<InterfaceNotification[]>([]);
  const [permission, setPermission] = React.useState<NotificationPermission | "unsupported">("unsupported");

  const reload = React.useCallback(() => {
    setItems(loadNotifications(ownerId));
  }, [ownerId]);

  React.useEffect(() => {
    setPermission(browserNotificationPermission());
    reload();
  }, [reload]);

  React.useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ ownerId?: string }>).detail;
      if (!detail?.ownerId || detail.ownerId === ownerId) reload();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith("silicon-interface:notifications:")) reload();
    };
    window.addEventListener(NOTIFICATION_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(NOTIFICATION_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [ownerId, reload]);

  const unread = items.filter((item) => !item.read).length;

  const openRoom = (item: InterfaceNotification) => {
    markNotificationRead(ownerId, item.id);
    reload();
    setOpen(false);
    router.push(`/chat?room=${encodeURIComponent(item.roomId)}`);
  };

  const enableBrowser = async () => {
    const next = await requestBrowserNotifications();
    setPermission(next);
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
            <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center bg-foreground px-1 font-mono text-[10px] font-semibold leading-none text-background">
              {unread > 99 ? "99+" : unread}
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

        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <PermissionStatus permission={permission} onEnable={enableBrowser} />
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
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No notifications yet.
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
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PermissionStatus({
  permission,
  onEnable,
}: {
  permission: NotificationPermission | "unsupported";
  onEnable: () => void;
}) {
  if (permission === "unsupported") {
    return <span className="text-xs text-muted-foreground">browser notifications unavailable</span>;
  }
  if (permission === "granted") {
    return <span className="text-xs text-muted-foreground">browser notifications on</span>;
  }
  if (permission === "denied") {
    return <span className="text-xs text-muted-foreground">browser notifications blocked</span>;
  }
  return (
    <button
      type="button"
      onClick={onEnable}
      className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
    >
      enable browser notifications
    </button>
  );
}
