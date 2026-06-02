// Glass response shapes — matches apps/*/serializers.py.

export type Kind = "carbon" | "silicon" | "system";

export type EventType =
  | "m.text"
  | "m.image"
  | "m.file"
  | "m.voice"
  | "m.tts"
  | "m.progress"
  | "m.session_marker"
  | "m.take_back"
  | "m.system"
  | "m.reaction"
  | "m.remote_browser";

export type ProgressState =
  | "reading_file"
  | "writing_file"
  | "executing"
  | "searching_web"
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
  tagline: string;
  timezone: string;
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
  tagline: string;
  timezone: string;
}

export interface Silicon {
  silicon_id: string;
  name: string;
  profile_photo_key: string;
  profile_photo_url: string | null;
  tagline: string;
  owner_team_id: number;
  capabilities: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
}

export interface SiliconPublic {
  silicon_id: string;
  name: string;
  profile_photo_key: string;
  profile_photo_url: string | null;
  tagline: string;
}

export interface RoomPeer {
  kind: "carbon" | "silicon";
  /** Public id (carbon_id / silicon_id) — used to match a saved contact and to
   *  render "@id" for unsaved chats. */
  id: string;
  handle: string;
  name: string;
  profile_photo_url: string | null;
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
  /** The Event.type, so the sidebar can prefix or icon-decorate appropriately. */
  type: string;
  /** True when someone other than the sender has read up to this event —
   *  drives the sent (✓) vs read (✓✓) tick on my own latest message. */
  read?: boolean;
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
  /** True when I see this room only as a read-only observer (my carbon_id is
   *  in the backend SILICON_OBSERVER_CARBON_IDS allowlist and this is a
   *  silicon↔silicon room). Drives the read-only sidebar/room treatment. */
  observed?: boolean;
  /** Lightweight last-event projection so the sidebar can show a preview
   *  without an N+1 fetch per room. Null when the room has no events. */
  last_event: RoomLastEvent | null;
  name: string;
  topic: string;
  settings: Record<string, unknown>;
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
  settings: { let_employees_invite: boolean; verify_carbons: boolean } & Record<string, unknown>;
  email_whitelist: { domains: string[]; emails: string[] };
  trust_chart: Record<string, unknown>;
  tags: unknown[];
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMembership {
  id: number;
  team: number;
  member_kind: Kind;
  member_id: number;
  member_handle: string | null;
  role: string;
  joined_at: string;
}

export interface Invite {
  id: number;
  token: string;
  scope: "team" | "silicon";
  silicon_id: string | null;
  channel: "link" | "email";
  code: string;
  email_target: string;
  role: string;
  max_uses: number;
  uses: number;
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
  payment: PaymentStatus;
}

export interface InviteInfo {
  scope: "team" | "silicon";
  team_slug: string;
  team_name: string;
  silicon_name: string | null;
  channel: "link" | "email";
  needs_code: boolean;
  verify_carbons: boolean;
  whitelist: { domains: string[]; emails: string[] } | null;
  role: string;
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
  room: number;
  sender_kind: Kind;
  sender_id: number | null;
  sender_handle: string | null; // carbon username (== carbon_id) or silicon name
  type: EventType;
  content: Record<string, unknown>;
  reply_to_event_id: string;
  is_final: boolean;
  created_at: string;
  edited_at: string | null;
  redacted_at: string | null;
  redaction_reason: string;
  /** #25 — OG-style link preview projection, only set when body contains
   *  exactly one URL. */
  link_preview?: LinkPreview | null;
  /** Human's local wall-clock time, e.g. "9:33 (GMT+5:30)". Only populated
   *  for silicon fetches; null for carbon requesters. */
  display_time?: string | null;
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
  refresh: string;
}

export interface AuthSession {
  carbon: Carbon;
  access: string;
  refresh: string;
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

// ---- WebSocket frames ----
export type WsFrame =
  | { type: "hello"; subscribed_rooms: string[] }
  | { type: "pong" }
  | { type: "event"; room_id: string; event: Event }
  | { type: "event.delta"; room_id: string; event_id: string; delta: string; seq: number }
  | { type: "event.final"; room_id: string; event_id: string }
  | { type: "event.transcript"; room_id: string; event_id: string; transcript: string }
  | {
      type: "read_receipt";
      room_id: string;
      member_kind: Kind;
      member_id: number;
      event_id: string;
    }
  | {
      type: "take_back";
      room_id: string;
      event_ids: string[];
      by_kind: Kind;
      by_id: number | null;
    }
  | {
      type: "progress";
      room_id: string;
      progress_group_id?: string;
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
