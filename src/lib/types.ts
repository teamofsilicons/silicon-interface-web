// Backend response shapes — matches apps/*/serializers.py.

export type Kind = "carbon" | "silicon" | "system";

export type TrustLevel =
  | "very_low"
  | "low"
  | "ok"
  | "high"
  | "very_high"
  | "ultimate";

export type EventType =
  | "m.text"
  | "m.image"
  | "m.file"
  | "m.voice"
  | "m.tts"
  | "m.progress"
  | "m.session_marker"
  | "m.take_back"
  | "m.system";

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
  trust_level: TrustLevel;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  created_at: string;
}

export interface CarbonPublic {
  carbon_id: string;
  username: string;
  name: string;
  profile_photo_key: string;
  trust_level: TrustLevel;
}

export interface Silicon {
  silicon_id: string;
  name: string;
  profile_photo_key: string;
  owner_org_id: number;
  capabilities: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
}

export interface SiliconPublic {
  silicon_id: string;
  name: string;
  profile_photo_key: string;
}

export interface Room {
  room_id: string;
  kind: "direct" | "group";
  org: number | null;
  name: string;
  topic: string;
  settings: Record<string, unknown>;
  created_by_kind: string;
  created_by_id: number | null;
  created_at: string;
  updated_at: string;
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
      kind?: string; // 'typing' overload
      member_kind?: Kind;
      member_id?: number;
      is_typing?: boolean;
    };
