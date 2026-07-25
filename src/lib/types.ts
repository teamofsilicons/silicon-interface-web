// Glass response shapes — matches apps/*/serializers.py.

export type Kind = "carbon" | "silicon" | "system";

export type EventType =
  | "m.text"
  | "m.image"
  | "m.file"
  | "m.album"
  | "m.voice"
  | "m.tts"
  | "m.progress"
  | "m.session_marker"
  | "m.take_back"
  | "m.system"
  | "m.reaction"
  | "m.remote_browser"
  | "m.work_task"
  | "m.work_event";

/** One annotation's serialized shape (kept in localStorage + used to label the
 *  composer draft chip). */
export interface AnnotationItem {
  ref_code: string;
  page: number;
  kind: "pen" | "rect" | "pin";
  geometry: Record<string, unknown>;
  markups?: { geometry: Record<string, unknown>; color?: string }[];
  comment: string;
}

/**
 * The payload the annotation studio hands to the composer when "attach to chat"
 * stages the generated annotated file as a reply-linked draft. The annotated
 * file (PDF for a PDF source, PNG for an image) is already uploaded; on send it
 * goes as a normal `m.file`/`m.image` reply to the source message.
 */
export interface AnnotationDraft {
  sourceMediaId: string;
  /** Original file event id when the source is already in chat. Staged outgoing
   *  attachments do not have one yet, so those send without reply_to_event_id. */
  sourceEventId?: string;
  sourceFilename: string;
  /** media_id of the generated annotated file (PDF or image). */
  annotatedMediaId: string;
  /** "application/pdf" or "image/png". */
  annotatedMime: string;
  annotatedName: string;
  /** The annotations, for the chip label + reference (not sent as event data). */
  annotations: AnnotationItem[];
  /** Composer copy generated from the positional references. */
  feedbackText: string;
}

export type ProgressState =
  | "reading"
  | "reading_file"
  | "writing"
  | "writing_file"
  | "executing"
  | "searching_web"
  | "spawning_worker"
  | "calling"
  | "thinking"
  | "done";

export interface Carbon {
  carbon_id: string;
  username: string;
  email: string;
  phone: string;
  name: string;
  profile_photo_key: string;
  profile_photo_url: string | null;
  /** Delights §0a — colored ASCII treatment of the photo; preferred for avatars. */
  profile_ascii_url?: string | null;
  tagline: string;
  timezone: string;
  // Core-team flag. Gates the /dev console client-side; the backend
  // independently gates /api/v1/dev/* (DEBUG) and /api/v1/cost/* (IsAdminUser).
  is_staff?: boolean;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  created_at: string;
}

export interface CarbonPublic {
  carbon_id: string;
  username: string;
  name: string;
  profile_photo_key: string;
  profile_photo_url: string | null;
  profile_ascii_url?: string | null;
  tagline: string;
  timezone: string;
}

export interface Silicon {
  silicon_id: string;
  name: string;
  profile_photo_key: string;
  profile_photo_url: string | null;
  profile_ascii_url?: string | null;
  tagline: string;
  owner_team_id: number;
  capabilities: Record<string, unknown>;
  is_active: boolean;
  connection_state?: "online" | "connecting" | "offline" | string;
  created_at: string;
}

export interface SiliconPublic {
  silicon_id: string;
  name: string;
  profile_photo_key: string;
  profile_photo_url: string | null;
  profile_ascii_url?: string | null;
  tagline: string;
  /** Owner team — lets the profile offer "invite people to this silicon". */
  owner_team_slug?: string;
  owner_team_name?: string;
  connection_state?: "online" | "connecting" | "offline" | string;
}

export interface RoomPeer {
  kind: "carbon" | "silicon";
  /** Public id (carbon_id / silicon_id) — used to match a saved contact and to
   *  render "@id" for unsaved chats. */
  id: string;
  handle: string;
  name: string;
  profile_photo_url: string | null;
  /** Delights §0a — colored ASCII treatment of the photo; preferred for avatars. */
  profile_ascii_url?: string | null;
  connection_state?: "online" | "connecting" | "offline" | string;
  presence?: PresenceProjection;
  maintenance?: SiliconMaintenanceProjection;
}

export interface PresenceProjection {
  state: "online" | "offline" | "hidden";
  expires_at: string;
  last_seen_at: string;
  revision: number;
}

export interface SiliconMaintenanceProjection {
  /** The updater currently holds a live Glass lease. */
  active: boolean;
  /** Glass is still durably accepting messages for automatic delivery. This
   * remains true during the bounded reconnect grace after a missed heartbeat. */
  delivery_deferred?: boolean;
  phase:
    | "preparing"
    | "draining"
    | "checkpointing"
    | "updating"
    | "validating"
    | "resuming"
    | "deferred"
    | "rolled_back"
    | "failed"
    | "status_unknown"
    | string;
  update_id: string;
  target_version: string;
  queued_count: number;
  revision: number;
  message: string;
  started_at: string | null;
  updated_at: string | null;
  lease_expires_at: string | null;
  silicon_id?: string;
  name?: string;
}

/** A cron a silicon scheduled. Carbons see these read-only. */
export interface CronTarget {
  kind: "carbon" | "silicon";
  id: string;
}
export interface Cron {
  cron_id: string;
  trigger: string; // linux-cron expression
  timezone: string; // IANA zone the trigger is anchored to ("" == UTC)
  next_run: string | null; // next absolute fire instant (UTC ISO)
  for_targets: CronTarget[];
  task: string;
  is_active: boolean;
  setup_by: { silicon_id: string; name: string };
  created_at: string;
  updated_at: string;
}
export interface CronConflict {
  carbon_id: string;
  cron_id: string;
  task: string;
  trigger: string;
  message: string;
}
/** create/patch return the saved cron plus any scheduling conflicts. */
export interface CronWriteResult {
  cron: Cron;
  conflicts: CronConflict[];
}

/** A saved contact (private address book entry). */
export interface Contact {
  id: number;
  target_kind: "carbon" | "silicon";
  target_id: string; // public id of the carbon/silicon
  name: string; // custom label (defaults to target's name)
  note: string; // private to the owner
  custom_photo: boolean; // true when the owner set their own picture
  photo_url: string | null; // custom photo, else the target's
  target_name: string;
  target_photo_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomLastEvent {
  /** ULID of the event — lets the sidebar compare against read receipts. */
  event_id?: string;
  /** One-line preview suitable for the sidebar — already type-aware. */
  preview: string;
  /** ISO of when this event was authored. */
  at: string;
  /** Sender handle, when applicable (system events have null). */
  sender_handle: string | null;
  /** Who sent it — lets the sidebar mirror the chat's progress gating (a run's
   *  status is hidden once the silicon has replied). */
  sender_kind?: "carbon" | "silicon" | "system" | null;
  /** The Event.type, so the sidebar can prefix or icon-decorate appropriately. */
  type: string;
  /** True when someone other than the sender has read up to this event —
   *  drives the sent (✓) vs read (✓✓) tick on my own latest message. */
  read?: boolean;
  /** Authoritative aggregate for the exact tail event, exposed only when the
   * signed-in member authored it. Sidebar and timeline consume this verbatim. */
  delivery?: Event["delivery"];
  stream_position?: number;
  stream_writer?: string;
  edit_version?: number;
  edited_at?: string | null;
}

export interface UnreadBoundary {
  last_read_stream_position: number;
  last_read_stream_vector?: StreamVectorPosition;
  first_unread_event_id: string | null;
  first_unread_stream_position: number | null;
  first_unread_stream_writer?: string | null;
  unread_count: number;
  /** Fixed event-stream barrier at which this projection was calculated. */
  through_stream_position: number;
  through_stream_vector?: StreamVectorPosition;
}

export interface RoomListPreferences {
  pinned: boolean;
  archived: boolean;
}

export interface RoomListProjection {
  version: 1;
  complete: true;
  through_stream_position: number;
  through_stream_vector?: StreamVectorPosition;
  activity_stream_position: number;
  activity_at: string;
  draft: {
    active: boolean;
    version: number;
    updated_at: string;
    content_updated_at?: string;
    origin_device?: string;
  };
  held: { active_count: number; attention_count: number; next_release_at: string };
}

export interface Room {
  room_id: string;
  kind: "direct" | "group";
  team: number | null;
  team_slug: string | null;
  peer_kinds: Kind[]; // member kinds excluding self — for Carbons/Silicons filters
  peers: RoomPeer[]; // resolved counterpart projections (one entry for direct rooms)
  unread: boolean;
  /** Number of unread messages to me — drives the numbered sidebar badge.
   *  Patched live on the client as event frames arrive. */
  unread_count?: number;
  /** Server-authoritative unread anchor. The UI freezes the first unread
   * identity for a room-viewing session so paging and receipt refreshes cannot
   * make the divider jump. */
  unread_boundary: UnreadBoundary;
  /** True when I see this room only as a read-only observer (my carbon_id is
   *  in the backend SILICON_OBSERVER_CARBON_IDS allowlist and this is a
   *  silicon↔silicon room). Drives the read-only sidebar/room treatment. */
  observed?: boolean;
  notification_preferences?: {
    mode: "all" | "mentions" | "mute";
    mute_until: string;
    show_preview: boolean;
    sound: boolean;
  } | null;
  list_preferences: RoomListPreferences | null;
  list_projection: RoomListProjection;
  /** Lightweight last-event projection so the sidebar can show a preview
   *  without an N+1 fetch per room. Null when the room has no events. */
  last_event: RoomLastEvent | null;
  name: string;
  topic: string;
  settings: Record<string, unknown>;
  security_mode: "server_managed" | "private_e2ee";
  security_version: number;
  security_frozen_at: string | null;
  created_by_kind: string;
  created_by_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Team {
  team_id: string;
  name: string;
  slug: string;
  team_heads: string[]; // carbon_ids
  logo_key: string;
  logo_url: string | null;
  settings: { let_employees_invite: boolean; verify_carbons: boolean } & Record<string, unknown>;
  email_whitelist: { domains: string[]; emails: string[] };
  trust_chart: Record<string, unknown>;
  tags: unknown[];
  notes: string;
  /** Team-defined silicon folders authored in Glass: named folders + which
   *  silicon (by silicon_id) is in which. Drives the sidebar's default grouping. */
  silicon_folders?: {
    folders: { id: string; name: string }[];
    assignments: Record<string, string>;
  };
  created_at: string;
  updated_at: string;
}

export type TeamRole = "member" | "head";

export interface TeamMembership {
  id: number;
  team: number;
  member_kind: Kind;
  member_id: number;
  member_handle: string | null;
  /** Stable public id (carbon_id / silicon_id) — matches RoomPeer.id. */
  member_public_id: string | null;
  member_photo_url: string | null;
  role: TeamRole;
  joined_at: string;
}

export interface Invite {
  id: number;
  token: string;
  scope: "team" | "silicon";
  silicon_id: string | null;
  silicon_name: string | null;
  channel: "link" | "email";
  code: string;
  email_target: string;
  role: TeamRole;
  max_uses: number;
  uses: number;
  remaining_uses: number;
  is_active: boolean;
  expires_at: string;
  claimed_at: string | null;
  created_at: string;
}

export interface Invitee {
  id: number;
  member_kind: Kind;
  member_handle: string | null;
  invited_by: string | null;
  silicon_name: string | null;
  joined_at: string;
}

export interface BillingRecord {
  id: number;
  kind: "one_time" | "recurring";
  description: string;
  amount_cents: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
}

export interface BillingAddon {
  id: number;
  label: string;
  amount_cents: number;
  currency: string;
  recurring: boolean;
  active: boolean;
  created_at: string;
}

export interface BillingCycle {
  id: number;
  period_start: string;
  period_end: string;
  due_date: string | null;
  status: "open" | "charged" | "paid" | "failed";
  total_cents: number;
  currency: string;
  records: BillingRecord[];
  created_at: string;
}

/** Payment-deadline signal for the head-only banner. */
export interface PaymentStatus {
  state: "ok" | "warning" | "grace" | "paused";
  due_date: string | null;
  days_left: number | null;
  pause_date?: string | null;
  days_to_pause?: number | null;
  grace_days?: number;
  amount_cents: number;
  currency: string;
  cycle_id?: number;
}

export interface BillingData {
  plan: { monthly_cost_cents: number; currency: string };
  addons: BillingAddon[];
  cycles: BillingCycle[];
  pending?: {
    amount_cents: number;
    currency: string;
    cycle_ids: number[];
  };
  payment: PaymentStatus;
}

export interface InviteInfo {
  scope: "team" | "silicon";
  team_slug: string;
  team_name: string;
  /** Uploaded team logo (permanent URL); null falls back to a generated mark. */
  team_logo_url?: string | null;
  silicon_name: string | null;
  channel: "link" | "email";
  needs_code: boolean;
  verify_carbons: boolean;
  whitelist: { domains: string[]; emails: string[] } | null;
  role: TeamRole;
  /** True when the signed-in visitor already belongs to this team. */
  already_member?: boolean;
}

export interface LinkPreview {
  url: string;
  host: string;
  title: string;
  description: string;
  image: string;
}

export interface Event {
  event_id: string;
  /** Device-scoped transaction echo. Glass only exposes this to the exact
   * authoring X-Device-ID; peers and the author's other devices receive null. */
  transaction_id?: string | null;
  stream_position?: number;
  stream_writer?: string;
  room: number;
  sender_kind: Kind;
  sender_id: number | null;
  sender_handle: string | null; // carbon username (== carbon_id) or silicon name
  /** Stable public Carbon/Silicon identity for report/block actions. Never
   * infer a Silicon id from its mutable display name. */
  sender_public_id?: string | null;
  type: EventType;
  content: Record<string, unknown>;
  reply_to_event_id: string;
  /** Canonical root for a non-reaction reply chain; empty on root events. */
  thread_root_event_id?: string;
  /** The carbon message that triggered this silicon reply's run — lets the UI
   *  group the reply (and its progress) under the message it answers. Set
   *  server-side; empty for carbon messages and cron/proactive silicon sends. */
  run_anchor_event_id?: string;
  is_final: boolean;
  created_at: string;
  /** Immutable server acceptance timestamp. Equal to created_at for events. */
  accepted_at?: string;
  edited_at: string | null;
  /** Optimistic-concurrency token for content edits (original event is 0). */
  edit_version?: number;
  redacted_at: string | null;
  redaction_reason: string;
  /** Sender-scoped affordance from Glass. False when read/delivered gates have
   *  already closed the unsend window for this signed-in user. */
  can_unsend?: boolean;
  delivery?: {
    state: "sent" | "partially_delivered" | "delivered" | "partially_read" | "read";
    recipient_count: number;
    delivered_count: number;
    read_count: number;
  } | null;
  /** Glass accepted this event while a recipient Silicon was in a fenced
   * update. The event is durable and will be delivered after maintenance. */
  delivery_state?: "queued_for_maintenance" | string;
  /** Authoritative Carbon-facing acknowledgement for a maintenance-queued send. */
  delivery_acknowledgement?: string;
  maintenance?: SiliconMaintenanceProjection;
  maintenance_recipients?: SiliconMaintenanceProjection[];
  /** #25 — OG-style link preview projection, only set when body contains
   *  exactly one URL. */
  link_preview?: LinkPreview | null;
  /** Human's local wall-clock time, e.g. "4:13pm (utc+5:30 - user's timezone)".
   *  Only populated for silicon fetches; null for carbon requesters. */
  display_time?: string | null;
  /** Dimensions/metadata of attached media, so the bubble reserves its exact
   *  size before the media loads (no timeline shift while scrolling). */
  media_meta?: {
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    kind: "file" | "image" | "voice" | "tts_output";
    mime: string;
    /** S3-complete attachments may be published while their bytes remain
     * quarantined. Older Glass responses omit this during a rolling deploy. */
    status?: "pending" | "ready" | "infected" | "failed";
  } | null;
  /** Ordered authoritative metadata for an atomically published media album.
   * Optimistic rows may omit this and render from content.items until ack. */
  media_items?: Array<{
    position: number;
    media_id: string;
    filename: string;
    kind: "file" | "image";
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    status?: "pending" | "ready" | "infected" | "failed";
  }> | null;
}

export interface HistoryPage {
  events: Event[];
  cursor: string | null;
  has_more: boolean;
  direction: "backward" | "forward";
  through_event_id: string | null;
}

export interface ThreadPage {
  root: Event;
  events: Event[];
  cursor: string | null;
  has_more: boolean;
  through_event_id: string | null;
  reply_count: number;
  unread_count: number;
}

export interface ThreadReadResult {
  marked: number;
  event_id: string;
  unread_count: number;
  removed_unread_count: number;
}

export interface SyncPageRange {
  stream: "events" | "account";
  from_position: number;
  next_position: number;
  through_position: number;
  first_item_position: number | null;
  last_item_position: number | null;
  item_count: number;
  has_more: boolean;
  complete_through: boolean;
  coverage: "authoritative_projection" | "contiguous";
}

export interface StreamVectorPosition {
  floor: number;
  writers: Record<string, number>;
}

export interface EventVectorRange {
  version: 1;
  stream: "events";
  from: StreamVectorPosition;
  next: StreamVectorPosition;
  through: StreamVectorPosition;
  items: Array<{ writer: string; position: number }>;
  item_count: number;
  has_more: boolean;
  complete_through: boolean;
  coverage: "authoritative_projection";
}

export interface MediaObject {
  media_id: string;
  uploader_kind: Kind;
  uploader_id: number;
  mime: string;
  size: number;
  sha256: string;
  status: "pending" | "ready" | "infected" | "failed";
  kind: "file" | "image" | "voice" | "tts_output";
  transcript: string;
  transcription_status: "not_started" | "pending" | "ready" | "failed";
  transcription_provider: string;
  duration_ms: number | null;
  /** #6 — pre-computed audio waveform peaks (0..1, ~60 buckets). */
  peaks: number[] | null;
  /** #22 — pixel dimensions for image/video so bubbles reserve aspect. */
  width: number | null;
  height: number | null;
  created_at: string;
  updated_at: string;
}

export interface JwtPair {
  access: string;
  refresh?: string;
}

export interface AuthSession {
  carbon: Carbon;
  access: string;
  refresh?: string;
}

export type LoginChannel = "sms" | "email";

export interface LoginChannelOption {
  channel: LoginChannel;
  label: string; // masked target, e.g. "a***e@example.com" / "+1******7777"
}

export interface LoginStartResponse {
  challenge_id: string;
  status: "sent" | "choose_channel";
  channel?: LoginChannel; // present when status === "sent"
  sent_to?: string; // masked target when status === "sent"
  options?: LoginChannelOption[]; // present when status === "choose_channel"
}

export interface DevOtpResponse {
  code: string;
  purpose: string;
  purpose_ref: string;
  channel: string;
  target: string;
  expires_at: string;
}

export interface TakeBackPolicy {
  unread_threshold_msgs: number;
  unread_duration_secs: number;
  enabled: boolean;
}

export interface TakeBackRequest {
  request_id: string;
  room_id: string;
  carbon_id: string;
  silicon_id: string;
  status: "scheduled" | "pending" | "completed" | "cancelled";
  event_ids: string[];
  message_count: number;
  scheduled_for: string | null;
  requested_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  replacement_event_id: string | null;
  events: Array<Pick<Event, "event_id" | "type" | "content" | "created_at">>;
}


export interface DraftAttachment {
  id?: string;
  mediaId: string;
  media_id?: string;
  mime: string;
  name: string;
  size?: number;
  kind?: string;
}

export interface ReplyDraftTarget {
  event_id: string;
  sender_handle?: string;
  sender_kind?: Kind;
  type?: string;
  preview?: string;
}

export interface DraftState {
  room_id: string;
  text: string;
  attachments: DraftAttachment[];
  reply_to_event_id: string;
  reply_to_snapshot: ReplyDraftTarget | Record<string, never>;
  version: number;
  updated_at: string;
  /** When the composer contents changed, distinct from a retry/save time. */
  content_updated_at?: string;
  cleared_at?: string;
  origin_device?: string;
}

export interface DraftsListResponse {
  drafts: DraftState[];
}

export interface DraftWritePayload {
  text: string;
  attachments?: DraftAttachment[];
  reply_to_event_id?: string;
  base_version?: number;
  origin_device?: string;
  content_updated_at?: string;
}

export interface HeldSend {
  held_send_id: string;
  room_id: string;
  client_id: string;
  device_id?: string;
  type: EventType;
  content: Record<string, unknown>;
  reply_to_event_id: string;
  state:
    | "pending"
    | "releasing"
    | "blocked"
    | "challenge"
    | "sent"
    | "cancelled"
    | "failed";
  phase?:
    | "held"
    | "sending"
    | "retry_wait"
    | "blocked"
    | "challenge"
    | "accepted"
    | "cancelled";
  release_at: string;
  next_attempt_at?: string;
  sent_event_id: string;
  version: number;
  release_attempts?: number;
  error: string;
  failure_code?: string;
  failure?: {
    domain?: unknown;
    code?: unknown;
    retryable?: unknown;
    automatic?: unknown;
    correction_actions?: unknown;
    retry_after_seconds?: unknown;
  } | null;
  failure_at?: string;
  challenge?: Record<string, unknown>;
  created_at: string;
  accepted_at?: string;
  updated_at: string;
  terminal_at: string;
}

export interface ClientOperationStatus {
  operation_id: string;
  room_id: string;
  kind: "event_send" | "held_send";
  client_id: string;
  device_id: string;
  state: "pending" | "succeeded" | "cancelled" | "failed";
  resource_id: string;
  result_event_id: string;
  http_status: number;
  accepted_at: string;
  terminal_at: string;
  expires_at: string;
  result?:
    | { kind: "event"; event: Event }
    | { kind: "held_send"; held_send: HeldSend };
}

export interface HeldSendsListResponse {
  held_sends: HeldSend[];
}

export interface AccountSyncUpdate {
  position: number;
  kind: string;
  room_id: string;
  object_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface InitialSyncResponse {
  sync_version: number;
  server_time: string;
  through: string;
  account_through: string;
  continuity: {
    event_position: number;
    event_vector?: StreamVectorPosition;
    account_position: number;
    complete_at_barrier: boolean;
  };
  rooms: Array<Room & {
    timeline: { events: Event[]; limited: boolean; before: string | null };
  }>;
  account_data: null | {
    drafts: DraftState[];
    held_sends: HeldSend[];
    operations: ClientOperationStatus[];
    chat_preferences: {
      read_receipts_enabled: boolean;
      presence_visibility: "everyone" | "contacts" | "nobody";
    };
    devices: Array<Record<string, unknown>>;
    blocks: Array<Record<string, unknown>>;
  };
  next: string | null;
  has_more: boolean;
}

// ---- WebSocket frames ----
export interface Announcement {
  id: number;
  title: string;
  body: string;
  url: string;
  kind: "announcement" | "update";
  created_at: string;
}

export type WsFrame =
  | {
      type: "hello";
      subscribed_rooms: string[];
      cursor: string;
      account_cursor: string;
      device_aware: boolean;
      protocol_version?: number;
      protocol_min?: number;
      protocol_max?: number;
      heartbeat_interval_ms?: number;
      heartbeat_timeout_ms?: number;
      presence_timeout_ms?: number;
    }
  | { type: "announcement"; announcement: Announcement }
  | { type: "pong" }
  | { type: "presence.ok"; state: "active" | "inactive"; revision: number }
  | { type: "presence.error"; code: string }
  | {
      type: "presence";
      room_id: string;
      member_kind: "carbon";
      member_id: number;
      member_handle: string;
      state: "online" | "offline" | "hidden";
      expires_at: string;
      last_seen_at: string;
      revision: number;
    }
  | { type: "event"; room_id: string; event: Event; traceparent?: string }
  | { type: "event.delta"; room_id: string; event_id: string; delta: string; seq: number }
  | { type: "event.final"; room_id: string; event_id: string }
  | {
      type: "media.status";
      room_id: string;
      media_id: string;
      status: MediaObject["status"];
      media: MediaObject;
      download_url: string | null;
    }
  | { type: "event.transcript"; room_id: string; event_id: string; transcript: string }
  | { type: "event.remote_browser_close"; room_id: string; event_id: string; expires_at: string }
  | { type: "draft"; draft: DraftState }
  | { type: "held_send"; held_send: HeldSend }
  | {
      type: "delivery_receipt";
      room_id: string;
      member_kind: Kind;
      member_id: number;
      member_handle?: string;
      event_ids: string[];
      deliveries?: Record<string, NonNullable<Event["delivery"]>>;
    }
  | { type: "room.updated" | "room.removed"; room_id: string }
  | { type: "account.state"; kind: string; data: Record<string, unknown> }
  | { type: "event.ack.ok"; acknowledged: number; request_id?: string }
  | { type: "event.ack.error"; code: string; detail: string; request_id?: string }
  | {
      type: "read_receipt";
      room_id: string;
      member_kind: Kind;
      member_id: number;
      /** Reader's public handle (carbon username or silicon name) — lets a
       *  client tell its OWN reads (cross-device sync) from a peer's. */
      member_handle?: string;
      event_id: string;
      /** Authoritative monotonic position committed by Glass. */
      read_stream_position: number;
      read_stream_vector?: StreamVectorPosition;
      deliveries?: Record<string, NonNullable<Event["delivery"]>>;
      deliveries_limited?: boolean;
    }
  | {
      type: "thread_read_receipt";
      room_id: string;
      root_event_id: string;
      member_kind: Kind;
      member_id: number;
      member_handle?: string;
      event_id: string;
      unread_count: number;
      removed_unread_count: number;
      deliveries?: Record<string, NonNullable<Event["delivery"]>>;
      deliveries_limited?: boolean;
      shared?: boolean;
    }
  | {
      type: "take_back";
      room_id: string;
      event_ids: string[];
      by_kind: Kind;
      by_id: number | null;
    }
  | {
      type: "take_back_request";
      request: TakeBackRequest;
    }
  | {
      type: "progress";
      room_id: string;
      /** Stable minor-status identity and revision for replay-safe history. */
      frame_id?: string;
      progress_group_id?: string;
      task_id?: string | null;
      revision?: number;
      occurred_at?: string;
      /** Carbon message this run is working on — anchors the status under it. */
      run_anchor_event_id?: string;
      state?: ProgressState;
      note?: string;
      progress_pct?: number | null;
      summary?: string;
      sender_kind?: Kind;
      sender_id?: number;
      /** 'typing' | 'uploading' | 'recording' for activity indicators. */
      kind?: string;
      member_kind?: Kind;
      member_id?: number;
      /** Sender's public handle — lets the client attribute the beacon (and
       *  ignore its own) without knowing numeric member ids. */
      member_handle?: string;
      is_typing?: boolean;
    }
  | {
      /** #2 — a new room was added with me as a member. The sidebar should
       *  re-fetch /api/v1/rooms/ to project the row. */
      type: "room.added";
      room_id: string;
      kind: "direct" | "group";
    };
