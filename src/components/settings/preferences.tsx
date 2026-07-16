"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  disablePush,
  enablePush,
  getPushPreviewMode,
  isPushEnabled,
  pushSupported,
  setPushPreviewMode,
  type PushPreviewMode,
} from "@/lib/push";
import { cn } from "@/lib/utils";
import { api, type GlobalNotificationPreferences } from "@/lib/api";
import {
  readComposerEnterBehavior,
  subscribeComposerEnterBehavior,
  writeComposerEnterBehavior,
} from "@/lib/composer-preferences";

// Sound preferences. Persist to localStorage; sounds read the same
// `silicon-interface:sounds` key that lib/sounds consults, decoupled from
// prefers-reduced-motion.
const SOUNDS_KEY = "silicon-interface:sounds";
const DEFAULT_NOTIFICATIONS: GlobalNotificationPreferences = {
  enabled: true,
  paused_until: "",
  quiet_hours: {
    enabled: false,
    timezone: "UTC",
    start: "22:00",
    end: "07:00",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    allow_mentions: true,
    allow_keywords: true,
  },
  keywords: [],
};

function readSounds(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SOUNDS_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeSounds(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOUNDS_KEY, on ? "on" : "off");
  } catch {
    /* private mode — preference can't persist */
  }
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          // Sharp corners, no shadow — a flat track + ink knob, on-brand.
          "relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors",
          checked ? "bg-primary" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "block h-4 w-4 bg-background transition-transform",
            checked ? "translate-x-6" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}

export function PreferencesSection() {
  // Hydration-safe: localStorage isn't readable on the server, so we read after
  // mount. Defaults match the "on" baseline the helper falls back to.
  const [sounds, setSounds] = React.useState(true);
  const enterSends = React.useSyncExternalStore(
    subscribeComposerEnterBehavior,
    () => readComposerEnterBehavior() === "send",
    () => true,
  );
  const [pushAvailable, setPushAvailable] = React.useState(false);
  const [push, setPush] = React.useState(false);
  const [pushBusy, setPushBusy] = React.useState(false);
  const [pushPreview, setPushPreview] = React.useState<PushPreviewMode>("full");
  const [readReceipts, setReadReceipts] = React.useState(true);
  const [readReceiptsBusy, setReadReceiptsBusy] = React.useState(false);
  const [presenceVisibility, setPresenceVisibility] = React.useState<
    "everyone" | "contacts" | "nobody"
  >("everyone");
  const [presenceBusy, setPresenceBusy] = React.useState(false);
  const [notifications, setNotifications] = React.useState(DEFAULT_NOTIFICATIONS);
  const [notificationBusy, setNotificationBusy] = React.useState(false);
  const [keywordText, setKeywordText] = React.useState("");

  React.useEffect(() => {
    // Read persisted prefs once after mount (localStorage is client-only).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time hydration of client-only storage
    setSounds(readSounds());
    setPushPreview(getPushPreviewMode());
    if (pushSupported()) {
      setPushAvailable(true);
      void isPushEnabled().then(setPush);
    }
    void api.chatPreferences()
      .then((value) => {
        setReadReceipts(value.read_receipts_enabled);
        setPresenceVisibility(value.presence_visibility);
        setNotifications(value.notifications);
        setKeywordText(value.notifications.keywords.join(", "));
      })
      .catch(() => undefined);
    const onRemotePreferences = (event: Event) => {
      const value = (event as CustomEvent<Record<string, unknown>>).detail;
      if (typeof value?.read_receipts_enabled === "boolean") {
        setReadReceipts(value.read_receipts_enabled);
      }
      if (
        value?.presence_visibility === "everyone" ||
        value?.presence_visibility === "contacts" ||
        value?.presence_visibility === "nobody"
      ) {
        setPresenceVisibility(value.presence_visibility);
      }
      if (value?.notifications && typeof value.notifications === "object") {
        const next = value.notifications as GlobalNotificationPreferences;
        setNotifications(next);
        setKeywordText(next.keywords.join(", "));
      }
    };
    window.addEventListener("silicon:chat-preferences", onRemotePreferences);
    return () => window.removeEventListener("silicon:chat-preferences", onRemotePreferences);
  }, []);

  const togglePush = async (next: boolean) => {
    setPushBusy(true);
    try {
      if (next) {
        const result = await enablePush();
        if (result === "enabled") {
          setPush(true);
          toast.success("push notifications on");
        } else if (result === "denied") {
          toast.error("notifications are blocked for this site - allow them in the browser");
        } else if (result === "unconfigured") {
          toast.error("push isn't configured on this server yet");
        } else {
          toast.error("this browser doesn't support push");
        }
      } else {
        await disablePush();
        setPush(false);
        toast.success("push notifications off");
      }
    } catch {
      toast.error("couldn't update push subscription");
    } finally {
      setPushBusy(false);
    }
  };

  const updateNotifications = async (
    patch: Parameters<typeof api.updateChatPreferences>[0]["notifications"],
  ) => {
    setNotificationBusy(true);
    try {
      const value = await api.updateChatPreferences({ notifications: patch });
      setNotifications(value.notifications);
      setKeywordText(value.notifications.keywords.join(", "));
      toast.success("notification rules updated");
    } catch {
      toast.error("couldn't update notification rules");
    } finally {
      setNotificationBusy(false);
    }
  };

  return (
    <section className="border-t pt-5">
      <h2 className="text-sm font-semibold">Preferences</h2>
      <div className="mt-1 divide-y">
        <Toggle
          label="Sound cues"
          description="Short tones for sent and received messages."
          checked={sounds}
          onChange={(next) => {
            setSounds(next);
            writeSounds(next);
          }}
        />
        <Toggle
          label="Enter sends"
          description={
            enterSends
              ? "Enter sends; Shift+Enter inserts a new line."
              : "Enter inserts a new line; Command/Ctrl+Enter sends."
          }
          checked={enterSends}
          onChange={(next) => {
            writeComposerEnterBehavior(next ? "send" : "newline");
          }}
        />
        <div className={readReceiptsBusy ? "pointer-events-none opacity-60" : undefined}>
          <Toggle
            label="Read receipts"
            description="Let people know when you have read their messages. Your unread messages still stay up to date across your devices when this is off."
            checked={readReceipts}
            onChange={(next) => {
              const previous = readReceipts;
              setReadReceipts(next);
              setReadReceiptsBusy(true);
              void api.updateChatPreferences({ read_receipts_enabled: next })
                .then(() => toast.success(next ? "read receipts on" : "read receipts off"))
                .catch(() => {
                  setReadReceipts(previous);
                  toast.error("couldn't update read receipts");
                })
                .finally(() => setReadReceiptsBusy(false));
            }}
          />
        </div>
        <label
          className={cn(
            "flex items-center justify-between gap-4 py-3",
            presenceBusy && "pointer-events-none opacity-60",
          )}
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium">Online status &amp; last seen</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Blocks always hide both, regardless of this setting.
            </span>
          </span>
          <select
            aria-label="Who can see online status and last seen"
            value={presenceVisibility}
            disabled={presenceBusy}
            onChange={(event) => {
              const next = event.target.value as "everyone" | "contacts" | "nobody";
              const previous = presenceVisibility;
              setPresenceVisibility(next);
              setPresenceBusy(true);
              void api.updateChatPreferences({ presence_visibility: next })
                .then(() => toast.success("presence privacy updated"))
                .catch(() => {
                  setPresenceVisibility(previous);
                  toast.error("couldn't update presence privacy");
                })
                .finally(() => setPresenceBusy(false));
            }}
            className="h-10 shrink-0 border bg-background px-3 text-sm"
          >
            <option value="everyone">Everyone</option>
            <option value="contacts">My contacts</option>
            <option value="nobody">Nobody</option>
          </select>
        </label>
        <div className={notificationBusy ? "pointer-events-none opacity-60" : undefined}>
          <Toggle
            label="Message notifications"
            description="Applies on all your devices."
            checked={notifications.enabled}
            onChange={(enabled) => void updateNotifications({ enabled })}
          />
          <Toggle
            label="Quiet hours"
            description="Silence ordinary alerts on your local schedule."
            checked={notifications.quiet_hours.enabled}
            onChange={(enabled) => void updateNotifications({
              quiet_hours: {
                enabled,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
              },
            })}
          />
          {notifications.quiet_hours.enabled && (
            <div className="grid gap-3 py-3 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">
                Starts
                <input
                  type="time"
                  value={notifications.quiet_hours.start}
                  onChange={(event) => void updateNotifications({
                    quiet_hours: { start: event.target.value },
                  })}
                  className="mt-1 block h-10 w-full border bg-background px-3 text-sm text-foreground"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Ends
                <input
                  type="time"
                  value={notifications.quiet_hours.end}
                  onChange={(event) => void updateNotifications({
                    quiet_hours: { end: event.target.value },
                  })}
                  className="mt-1 block h-10 w-full border bg-background px-3 text-sm text-foreground"
                />
              </label>
              <div className="sm:col-span-2">
                <Toggle
                  label="Mentions during quiet hours"
                  description="Let direct @mentions break through."
                  checked={notifications.quiet_hours.allow_mentions}
                  onChange={(allow_mentions) => void updateNotifications({
                    quiet_hours: { allow_mentions },
                  })}
                />
                <Toggle
                  label="Keywords during quiet hours"
                  description="Let your keyword rules break through."
                  checked={notifications.quiet_hours.allow_keywords}
                  onChange={(allow_keywords) => void updateNotifications({
                    quiet_hours: { allow_keywords },
                  })}
                />
              </div>
            </div>
          )}
          <label className="block py-3 text-sm font-medium">
            Notification keywords
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              Comma-separated words or phrases; matching is case-insensitive.
            </span>
            <input
              value={keywordText}
              maxLength={1024}
              onChange={(event) => setKeywordText(event.target.value)}
              onBlur={() => {
                const keywords = keywordText.split(",").map((item) => item.trim()).filter(Boolean);
                if (keywords.join("\u0000") !== notifications.keywords.join("\u0000")) {
                  void updateNotifications({ keywords });
                }
              }}
              className="mt-2 h-10 w-full border bg-background px-3 text-sm"
              placeholder="urgent, launch, incident"
            />
          </label>
        </div>
        {pushAvailable && (
          <div className={pushBusy ? "pointer-events-none opacity-60" : undefined}>
            <Toggle
              label="Push notifications"
              description="Messages and announcements reach this browser even when the tab is closed."
              checked={push}
              onChange={(next) => void togglePush(next)}
            />
          </div>
        )}
        {pushAvailable && push && (
          <label className="flex items-center justify-between gap-4 py-3">
            <span className="min-w-0">
              <span className="block text-sm font-medium">Notification previews</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Applies only to this browser.
              </span>
            </span>
            <select
              aria-label="Notification preview detail"
              value={pushPreview}
              disabled={pushBusy}
              onChange={(event) => {
                const next = event.target.value as PushPreviewMode;
                const previous = pushPreview;
                setPushPreview(next);
                setPushBusy(true);
                void setPushPreviewMode(next)
                  .then(() => toast.success("notification privacy updated"))
                  .catch(() => {
                    setPushPreview(previous);
                    void setPushPreviewMode(previous).catch(() => undefined);
                    toast.error("couldn't update notification privacy");
                  })
                  .finally(() => setPushBusy(false));
              }}
              className="h-10 border bg-background px-3 text-sm"
            >
              <option value="full">Sender + message</option>
              <option value="sender">Sender only</option>
              <option value="none">No details</option>
            </select>
          </label>
        )}
      </div>
    </section>
  );
}
