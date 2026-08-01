"use client";

import * as React from "react";
import { ArrowDown } from "@phosphor-icons/react/dist/ssr";

import { MessageBubble } from "@/components/chat/message-bubble";
import { WorkEventCard, WorkManagerActivityHistory } from "@/components/chat/work-updates";
import { IdAvatar } from "@/components/profile/id-avatar";
import { aggregateReactions } from "@/lib/reaction-state";
import { preserveCanonicalTimelineOrder } from "@/lib/run-anchored-timeline";
import { belongsToSameTimelinePanel } from "@/lib/timeline-panel";
import { timelineRenderKey } from "@/lib/timeline-identity";
import type { Event, LordIdentity, Room } from "@/lib/types";
import { cn, dayLabel } from "@/lib/utils";
import {
  createManagerActivityState,
  eventReplacesManagerActivity,
  managerActivityReplacementEvent,
  normalizeManagerActivityFrame,
  placeManagerActivityGroups,
  presentedManagerActivityGroups,
  reduceManagerActivityFrame,
  resolveManagerActivityForSettlement,
  settleManagerActivity,
} from "@/lib/work-manager-activity";
import {
  createWorkUpdateState,
  reduceWorkTimelineRecord,
  type WorkUpdateState,
} from "@/lib/work-update-state";
import type { ManagerActivityGroup, WorkTimelineRecord } from "@/lib/work-update-types";
import { dedupeWorkTimelineEnvelopes } from "@/lib/work-timeline-dedupe";
import { parseWorkTimelineRecord } from "@/lib/work-update-validation";

interface Props {
  room: Room;
  events: Event[];
  identity: LordIdentity;
  identityBySender: Map<string, LordIdentity>;
  loading: boolean;
}

type TimelineItem =
  | { kind: "panel"; events: Event[]; key: string; dayLabel: string | null }
  | { kind: "system"; event: Event; key: string; dayLabel: string | null }
  | { kind: "manager"; group: ManagerActivityGroup; key: string; dayLabel: string | null };

function senderKey(event: Event): string {
  return `${event.sender_kind}:${event.sender_public_id || event.sender_handle || ""}`;
}

function eventIsMine(event: Event, identity: LordIdentity): boolean {
  return event.sender_kind === identity.kind && (
    event.sender_public_id === identity.id ||
    event.sender_handle === identity.handle ||
    event.sender_handle === identity.id
  );
}

function materializedWorkRecord(
  state: WorkUpdateState,
  incoming: WorkTimelineRecord,
): WorkTimelineRecord {
  if (incoming.type === "m.work_task") {
    const task = state.tasks[incoming.task.task_id];
    return task ? { type: "m.work_task", task } : incoming;
  }
  const event = state.events[incoming.event.work_event_id];
  return event ? { type: "m.work_event", event } : incoming;
}

/** Rebuild the same safe, collapsed manager history that RoomView derives from
 * persisted progress events. This stays local to oversight and never mutates
 * the signed-in Lord's normal-chat activity cache. */
function reconstructManagerActivity(events: readonly Event[], roomId: string) {
  const ordered = [...events].sort((left, right) =>
    left.created_at.localeCompare(right.created_at) ||
    left.event_id.localeCompare(right.event_id),
  );
  let state = createManagerActivityState();
  let sawActivity = false;
  let pendingGroupId: string | null = null;

  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index];
    if (event.type === "m.progress") {
      const groupId = String(event.content.progress_group_id || event.event_id);
      const frame = normalizeManagerActivityFrame(
        {
          ...event.content,
          room_id: roomId,
          progress_group_id: groupId,
          event_id: event.event_id,
        },
        {
          room_id: roomId,
          occurred_at: event.created_at,
          frame_id: event.event_id,
        },
      );
      if (!frame) continue;
      state = reduceManagerActivityFrame(state, frame);
      sawActivity = true;
      if (frame.kind !== "done") pendingGroupId = groupId;
      if (frame.kind === "done") {
        const priorFinalMessage = managerActivityReplacementEvent(ordered.slice(0, index), groupId);
        if (priorFinalMessage) {
          state = settleManagerActivity(state, roomId, groupId, {
            reason: "final_message",
            occurred_at: event.created_at,
            final_message_event_id: priorFinalMessage.event_id,
          });
          if (pendingGroupId === groupId) pendingGroupId = null;
        } else {
          pendingGroupId = groupId;
        }
      }
      continue;
    }

    if (!sawActivity || !eventReplacesManagerActivity(event)) continue;
    const explicitGroupId = typeof event.content.progress_group_id === "string"
      ? event.content.progress_group_id
      : null;
    const group = resolveManagerActivityForSettlement(
      state,
      roomId,
      explicitGroupId ?? pendingGroupId,
    );
    if (!group) continue;
    state = settleManagerActivity(state, roomId, group.progress_group_id, {
      reason: "final_message",
      occurred_at: event.created_at,
      final_message_event_id: event.event_id,
    });
    if (group.progress_group_id === pendingGroupId) pendingGroupId = null;
  }

  return state;
}

function buildPresentation(events: readonly Event[], room: Room) {
  const reactions = aggregateReactions(events);
  const eventById = new Map(events.map((event) => [event.event_id, event]));
  const visibleEvents = events.filter(
    (event) => event.type !== "m.reaction" && event.type !== "m.progress",
  );

  const bundles = new Map<string, { text?: Event; attachments: Event[] }>();
  for (const event of visibleEvents) {
    const bundleId = event.content.bundle_id;
    if (typeof bundleId !== "string" || !bundleId) continue;
    const bundle = bundles.get(bundleId) ?? { attachments: [] };
    if (event.type === "m.text") bundle.text = event;
    else if (event.type === "m.image" || event.type === "m.file") {
      bundle.attachments.push(event);
    }
    bundles.set(bundleId, bundle);
  }
  const skippedAttachments = new Set<Event>();
  const pinsByKey = new Map<string, Event[]>();
  for (const bundle of bundles.values()) {
    if (!bundle.text || bundle.attachments.length === 0) continue;
    for (const attachment of bundle.attachments) skippedAttachments.add(attachment);
    pinsByKey.set(timelineRenderKey(bundle.text), bundle.attachments);
  }

  const displayRows = skippedAttachments.size > 0
    ? visibleEvents.filter((event) => !skippedAttachments.has(event))
    : visibleEvents;
  const canonicalRows = preserveCanonicalTimelineOrder(
    dedupeWorkTimelineEnvelopes(displayRows),
  );

  let workState = createWorkUpdateState();
  for (const event of canonicalRows) {
    const record = parseWorkTimelineRecord(event.type, event.content);
    if (!record) continue;
    const recordRoomId = record.type === "m.work_task"
      ? record.task.room_id
      : record.event.room_id;
    if (recordRoomId !== room.room_id) continue;
    try {
      workState = reduceWorkTimelineRecord(workState, record);
    } catch {
      // Match RoomView: retain the last coherent state if a producer mutates
      // immutable work-card identity fields.
    }
  }

  const managerState = reconstructManagerActivity(events, room.room_id);
  const managerGroups = presentedManagerActivityGroups(managerState, room.room_id, {
    asOfMs: Date.now(),
  });
  const managerPlacement = placeManagerActivityGroups(managerGroups, canonicalRows);
  const trailingManagers = managerPlacement.trailing
    .map((group, index) => ({
      group,
      index,
      iso: group.history[0]?.occurred_at ?? group.updated_at,
    }))
    .sort((left, right) => {
      const time = Date.parse(left.iso) - Date.parse(right.iso);
      return Number.isFinite(time) && time !== 0 ? time : left.index - right.index;
    });

  const raw: Array<{ item: TimelineItem; iso: string }> = [];
  let current: Event[] = [];
  let nextManagerIndex = 0;
  const flush = () => {
    if (current.length > 0) {
      raw.push({
        item: {
          kind: "panel",
          events: current,
          key: timelineRenderKey(current[0]),
          dayLabel: null,
        },
        iso: current[0].created_at,
      });
    }
    current = [];
  };
  const pushManager = (group: ManagerActivityGroup, iso: string) => {
    flush();
    raw.push({
      item: {
        kind: "manager",
        group,
        key: `manager:${group.room_id}:${group.progress_group_id}`,
        dayLabel: null,
      },
      iso,
    });
  };
  const pushManagersThrough = (iso: string) => {
    const eventAt = Date.parse(iso);
    if (!Number.isFinite(eventAt)) return;
    while (nextManagerIndex < trailingManagers.length) {
      const manager = trailingManagers[nextManagerIndex];
      const managerAt = Date.parse(manager.iso);
      if (!Number.isFinite(managerAt) || managerAt > eventAt) break;
      pushManager(manager.group, manager.iso || iso);
      nextManagerIndex += 1;
    }
  };

  let lastIso = canonicalRows[0]?.created_at ?? new Date(0).toISOString();
  for (const event of canonicalRows) {
    pushManagersThrough(event.created_at);
    lastIso = event.created_at;
    if (event.type === "m.system" || event.type === "m.session_marker") {
      flush();
      raw.push({
        item: {
          kind: "system",
          event,
          key: timelineRenderKey(event),
          dayLabel: null,
        },
        iso: event.created_at,
      });
      continue;
    }
    const previous = current.at(-1);
    if (
      previous &&
      !belongsToSameTimelinePanel(previous, event, current[0])
    ) flush();
    current.push(event);
  }
  flush();
  while (nextManagerIndex < trailingManagers.length) {
    const manager = trailingManagers[nextManagerIndex];
    pushManager(manager.group, manager.iso || lastIso);
    nextManagerIndex += 1;
  }

  let previousDay: string | null = null;
  for (const row of raw) {
    const date = new Date(row.iso);
    const localDay = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (localDay !== previousDay) {
      row.item.dayLabel = dayLabel(row.iso);
      previousDay = localDay;
    }
  }

  return {
    eventById,
    items: raw.map((row) => row.item),
    managerPlacement,
    pinsByKey,
    reactions,
    visibleCount: canonicalRows.length,
    workState,
  };
}

export function ObservedChatTimeline({
  room,
  events,
  identity,
  identityBySender,
  loading,
}: Props) {
  const presentation = React.useMemo(
    () => buildPresentation(events, room),
    [events, room],
  );
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const followBottomRef = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "auto") => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    followBottomRef.current = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    setAtBottom(true);
  }, []);

  React.useLayoutEffect(() => {
    if (!followBottomRef.current || loading) return;
    scrollToBottom();
  }, [loading, presentation.items, scrollToBottom]);

  const senderFor = (event: Event) =>
    identityBySender.get(senderKey(event)) ??
    (event.sender_handle
      ? identityBySender.get(`${event.sender_kind}:${event.sender_handle}`)
      : undefined);
  const latestSilicon = [...events]
    .reverse()
    .find((event) => event.sender_kind === "silicon" && event.sender_handle);
  const latestSiliconIdentity = latestSilicon ? senderFor(latestSilicon) : undefined;

  const renderItem = (item: TimelineItem) => {
    const dayBand = item.dayLabel ? (
      <div className="py-1 text-center text-[10px] text-muted-foreground">{item.dayLabel}</div>
    ) : null;

    if (item.kind === "system") {
      return (
        <>
          {dayBand}
          <MessageBubble
            event={item.event}
            isMine={eventIsMine(item.event, identity)}
            myHandle={identity.handle}
            isDirect={room.kind === "direct"}
            roomId={room.room_id}
          />
        </>
      );
    }

    if (item.kind === "manager") {
      return (
        <>
          {dayBand}
          <div className="my-3">
            <WorkManagerActivityHistory
              group={item.group}
              avatarSeed={latestSiliconIdentity?.id ?? latestSilicon?.sender_handle ?? room.room_id}
              avatarSrc={latestSiliconIdentity?.profile_photo_url}
              avatarAsciiSrc={latestSiliconIdentity?.profile_ascii_url}
              avatarFamily="silicon"
            />
          </div>
        </>
      );
    }

    return (
      <>
        {dayBand}
        <div className="my-3">
          {item.events.map((event, index) => {
            const sender = senderFor(event);
            const mine = eventIsMine(event, identity);
            const parsed = parseWorkTimelineRecord(event.type, event.content);
            const parsedRoomId = parsed
              ? parsed.type === "m.work_task"
                ? parsed.task.room_id
                : parsed.event.room_id
              : null;
            const workRecord = parsed && parsedRoomId === room.room_id
              ? materializedWorkRecord(presentation.workState, parsed)
              : null;
            const attachedManagerGroups =
              presentation.managerPlacement.attachedToEvent.get(event.event_id) ?? [];

            return (
              <div key={timelineRenderKey(event)} data-event-id={event.event_id}>
                {workRecord ? (
                  <div
                    className={cn(
                      "flex w-full items-start",
                      mine ? "justify-end" : "justify-start",
                      !mine && event.sender_kind === "silicon" && "gap-2",
                    )}
                  >
                    {!mine && event.sender_kind === "silicon" ? (
                      <IdAvatar
                        seed={sender?.id || event.sender_public_id || event.sender_handle || "?"}
                        src={sender?.profile_photo_url}
                        asciiSrc={sender?.profile_ascii_url}
                        size={28}
                        family="silicon"
                        className="mt-0.5"
                      />
                    ) : null}
                    <WorkEventCard
                      event={workRecord}
                      task={
                        workRecord.type === "m.work_event" && workRecord.event.task_id
                          ? presentation.workState.tasks[workRecord.event.task_id]
                          : undefined
                      }
                    />
                  </div>
                ) : (
                  <MessageBubble
                    event={event}
                    isMine={mine}
                    managerActivity={
                      attachedManagerGroups.length > 0 ? (
                        <div className="space-y-1">
                          {attachedManagerGroups.map((group) => (
                            <WorkManagerActivityHistory
                              key={`${group.room_id}:${group.progress_group_id}`}
                              group={group}
                              className="max-w-none"
                            />
                          ))}
                        </div>
                      ) : undefined
                    }
                    myHandle={identity.handle}
                    replyToEvent={event.reply_to_event_id
                      ? presentation.eventById.get(event.reply_to_event_id)
                      : undefined}
                    isDirect={room.kind === "direct"}
                    status={mine ? event.delivery?.state : undefined}
                    senderPhotoUrl={sender?.profile_photo_url}
                    senderAsciiUrl={sender?.profile_ascii_url}
                    senderAvatarKind={event.sender_kind}
                    senderDisplayName={sender?.name || event.sender_handle}
                    showSender={index === 0}
                    showTime={index === item.events.length - 1}
                    reactions={presentation.reactions.get(event.event_id)}
                    pinnedAttachments={presentation.pinsByKey.get(timelineRenderKey(event))}
                    roomId={room.room_id}
                  />
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  if (loading && presentation.visibleCount === 0) {
    return <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">Loading…</div>;
  }

  if (presentation.visibleCount === 0) {
    return (
      <div className="flex-1 px-6 py-4">
        <div className="border bg-muted/40 p-6 text-sm text-muted-foreground">
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span>no messages yet - say hi.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={scrollerRef}
        data-private
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none] [overscroll-behavior-y:contain]"
        onScroll={(event) => {
          const scroller = event.currentTarget;
          const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
          followBottomRef.current = bottom;
          setAtBottom(bottom);
        }}
      >
        <div className="flex min-h-full flex-col justify-end">
          <div className="w-full shrink-0">
            {presentation.items.map((item) => (
              <div key={item.key} className="px-6" style={{ display: "flow-root" }}>
                {renderItem(item)}
              </div>
            ))}
          </div>
          <div data-timeline-tail className="h-4 shrink-0" />
        </div>
      </div>

      <div
        className={cn(
          "timeline-page-down absolute bottom-4 right-6 z-10 transition-all duration-200 ease-out",
          !atBottom
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-2 scale-95 opacity-0",
        )}
      >
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          aria-label="go to bottom"
          className="grid h-10 w-10 place-items-center border border-foreground bg-foreground text-background shadow-sm transition-transform duration-200 ease-out hover:-translate-y-0.5"
        >
          <ArrowDown className="h-4 w-4" weight="bold" />
        </button>
      </div>
    </div>
  );
}
