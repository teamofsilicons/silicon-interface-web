import {
  createManagerActivityState,
  getManagerActivityGroup,
  normalizeManagerActivityFrame,
  reduceManagerActivityFrame,
  resolveManagerActivityForSettlement,
  settleManagerActivity,
  visibleManagerActivityGroups,
} from "./work-manager-activity";
import type {
  ManagerActivityGroup,
  ManagerActivityState,
} from "./work-update-types";

const STORAGE_KEY = "silicon-interface:manager-activity:v1";

let hydrated = false;
let activityState = createManagerActivityState();

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(activityState));
  } catch {
    // Session persistence is best-effort; the in-memory projection stays live.
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ManagerActivityState>;
    if (!parsed.groups || typeof parsed.groups !== "object") return;
    let next = createManagerActivityState();
    for (const group of Object.values(parsed.groups)) {
      if (!group || typeof group !== "object" || !Array.isArray(group.history)) continue;
      for (const candidate of group.history) {
        const frame = normalizeManagerActivityFrame(candidate, {
          room_id: typeof candidate?.room_id === "string" ? candidate.room_id : undefined,
          occurred_at:
            typeof candidate?.occurred_at === "string"
              ? candidate.occurred_at
              : new Date(0).toISOString(),
          frame_id: typeof candidate?.frame_id === "string" ? candidate.frame_id : undefined,
        });
        if (frame) next = reduceManagerActivityFrame(next, frame);
      }
      if (typeof group.room_id !== "string" || typeof group.progress_group_id !== "string") {
        continue;
      }
      const restored = getManagerActivityGroup(
        next,
        group.room_id,
        group.progress_group_id,
      );
      if (!restored) continue;
      if (typeof group.replaced_by_event_id === "string") {
        next = settleManagerActivity(next, group.room_id, group.progress_group_id, {
          occurred_at:
            typeof group.updated_at === "string" ? group.updated_at : restored.updated_at,
          reason: "final_message",
          final_message_event_id: group.replaced_by_event_id,
        });
      } else if (group.display === "replaced") {
        next = settleManagerActivity(next, group.room_id, group.progress_group_id, {
          occurred_at:
            typeof group.updated_at === "string" ? group.updated_at : restored.updated_at,
          reason: "dismissed",
        });
      } else if (group.display === "history") {
        next = settleManagerActivity(next, group.room_id, group.progress_group_id, {
          occurred_at:
            typeof group.updated_at === "string" ? group.updated_at : restored.updated_at,
          reason: "done",
        });
      }
    }
    activityState = next;
  } catch {
    activityState = createManagerActivityState();
  }
}

export function getManagerActivityState(): ManagerActivityState {
  hydrate();
  return activityState;
}

export function recordManagerActivity(
  value: unknown,
  defaults: { room_id?: string; occurred_at: string; frame_id?: string },
): ManagerActivityState {
  hydrate();
  const frame = normalizeManagerActivityFrame(value, defaults);
  if (!frame) return activityState;
  activityState = reduceManagerActivityFrame(activityState, frame);
  persist();
  return activityState;
}

export type CachedManagerActivitySettlement =
  | {
      reason: "done";
      final_message_event_id?: never;
    }
  | {
      reason: "final_message";
      final_message_event_id: string;
    }
  | {
      reason: "dismissed";
      final_message_event_id?: never;
    };

/** Settle an explicit run, the sole active run, or the newest retained history. */
export function settleCachedManagerActivity(
  roomId: string,
  options: {
    progress_group_id?: string | null;
    occurred_at: string;
  } & CachedManagerActivitySettlement,
): ManagerActivityState {
  hydrate();
  if (
    options.reason !== "done" &&
    options.reason !== "final_message" &&
    options.reason !== "dismissed"
  ) return activityState;
  const group = resolveManagerActivityForSettlement(
    activityState,
    roomId,
    options.progress_group_id,
  );
  if (!group) return activityState;
  activityState = options.reason === "final_message"
    ? settleManagerActivity(activityState, roomId, group.progress_group_id, {
        occurred_at: options.occurred_at,
        reason: "final_message",
        final_message_event_id: options.final_message_event_id,
      })
    : settleManagerActivity(activityState, roomId, group.progress_group_id, {
        occurred_at: options.occurred_at,
        reason: options.reason,
      });
  persist();
  return activityState;
}

export function visibleCachedManagerActivities(roomId: string): ManagerActivityGroup[] {
  hydrate();
  return visibleManagerActivityGroups(activityState, roomId);
}
