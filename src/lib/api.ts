// Typed REST client over fetch. Auto-attaches Authorization or X-Silicon-Key based on auth store.

import { env } from "./env";
import { authStore } from "./auth";
import type {
  AuthSession,
  Carbon,
  CarbonPublic,
  DevOtpResponse,
  Event,
  JwtPair,
  LoginStartResponse,
  MediaObject,
  Room,
  Silicon,
  SiliconPublic,
  TakeBackPolicy,
} from "./types";

class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (opts.auth !== false) {
    const tok = authStore.getAccess();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    const silKey = authStore.getSiliconKey();
    if (silKey) headers["X-Silicon-Key"] = silKey;
  }
  const url = `${env.apiBase}${path}`;
  const resp = await fetch(url, {
    method,
    headers,
    body:
      body instanceof FormData
        ? body
        : body !== undefined
          ? JSON.stringify(body)
          : undefined,
  });
  const ct = resp.headers.get("content-type") || "";
  const parsed: unknown = ct.includes("application/json")
    ? await resp.json().catch(() => null)
    : await resp.text().catch(() => null);
  if (!resp.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "detail" in parsed
        ? (parsed as { detail: string }).detail
        : null) ?? `${method} ${path} → ${resp.status}`;
    throw new ApiError(resp.status, parsed, msg);
  }
  return parsed as T;
}

export const api = {
  // -------- health / dev --------
  healthz: () => call<{ status: string }>("GET", "/healthz", undefined, { auth: false }),
  readyz: () => call<{ ready: boolean; checks: Record<string, string> }>("GET", "/readyz", undefined, { auth: false }),
  version: () => call<{ version: string; commit: string }>("GET", "/api/v1/version", undefined, { auth: false }),
  devLastOtp: (target: string) =>
    call<DevOtpResponse>(
      "GET",
      `/api/v1/dev/last-otp?target=${encodeURIComponent(target)}`,
      undefined,
      { auth: false },
    ),

  // -------- registration --------
  registerPhoneStart: (phone: string, flow_id?: string) =>
    call<{ flow_id: string }>("POST", "/api/v1/auth/register/phone/start", { phone, flow_id }, { auth: false }),
  registerPhoneVerify: (flow_id: string, phone: string, code: string) =>
    call<{ verified: boolean }>("POST", "/api/v1/auth/register/phone/verify", { flow_id, phone, code }, { auth: false }),
  registerEmailStart: (flow_id: string, email: string) =>
    call<unknown>("POST", "/api/v1/auth/register/email/start", { flow_id, email }, { auth: false }),
  registerEmailVerify: (flow_id: string, email: string, code: string) =>
    call<{ verified: boolean }>("POST", "/api/v1/auth/register/email/verify", { flow_id, email, code }, { auth: false }),
  registerUsername: (flow_id: string, username?: string) =>
    call<AuthSession>("POST", "/api/v1/auth/register/username", { flow_id, username }, { auth: false }),

  // -------- login --------
  loginStart: (identifier: string) =>
    call<LoginStartResponse>("POST", "/api/v1/auth/login/start", { identifier }, { auth: false }),
  loginVerify: (challenge_id: string, code: string) =>
    call<JwtPair>("POST", "/api/v1/auth/login/verify", { challenge_id, code }, { auth: false }),
  refresh: (refresh: string) =>
    call<{ access: string }>("POST", "/api/v1/auth/refresh", { refresh }, { auth: false }),

  // -------- profile --------
  me: () => call<Carbon>("GET", "/api/v1/carbons/me"),
  meSilicon: () => call<Silicon>("GET", "/api/v1/silicons/me"),
  patchMe: (patch: Partial<Carbon>) => call<Carbon>("PATCH", "/api/v1/carbons/me", patch),
  carbonByHandle: (handle: string) => call<CarbonPublic>("GET", `/api/v1/handle/carbon/${encodeURIComponent(handle)}`),
  siliconByHandle: (handle: string) => call<SiliconPublic>("GET", `/api/v1/handle/silicon/${encodeURIComponent(handle)}`),

  takeBackPolicy: () => call<TakeBackPolicy>("GET", "/api/v1/carbons/me/take-back-policy"),
  setTakeBackPolicy: (p: Partial<TakeBackPolicy>) =>
    call<TakeBackPolicy>("PATCH", "/api/v1/carbons/me/take-back-policy", p),

  // -------- orgs --------
  orgs: () => call<unknown[]>("GET", "/api/v1/orgs/"),
  createOrg: (data: { name: string; slug?: string }) => call<unknown>("POST", "/api/v1/orgs/", data),

  // -------- silicons (admin) --------
  createSilicon: (data: { name: string; org_slug: string; capabilities?: Record<string, unknown> }) =>
    call<Silicon>("POST", "/api/v1/silicons/", data),
  mintSiliconKey: (silicon_id: string, label = "") =>
    call<{ id: number; prefix: string; label: string; plaintext: string; warning: string }>(
      "POST",
      `/api/v1/silicons/${silicon_id}/api-keys`,
      { label },
    ),

  // -------- chat --------
  rooms: () => call<Room[]>("GET", "/api/v1/rooms/"),
  createRoom: (name: string, topic = "") => call<Room>("POST", "/api/v1/rooms/", { name, topic }),
  directRoom: (target_kind: "carbon" | "silicon", target_id: string) =>
    call<Room>("POST", "/api/v1/rooms/direct", { target_kind, target_id }),
  roomDetail: (room_id: string) => call<Room>("GET", `/api/v1/rooms/${room_id}/`),

  roomMembers: (room_id: string) => call<unknown[]>("GET", `/api/v1/rooms/${room_id}/members`),
  addRoomMember: (room_id: string, member_kind: "carbon" | "silicon", member_id: number, role = "member") =>
    call<unknown>("POST", `/api/v1/rooms/${room_id}/members`, { member_kind, member_id, role }),

  events: (room_id: string, before?: string, limit = 50) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set("before", before);
    return call<Event[]>("GET", `/api/v1/rooms/${room_id}/events?${q.toString()}`);
  },
  sendEvent: (
    room_id: string,
    payload: {
      type: string;
      content?: Record<string, unknown>;
      reply_to_event_id?: string;
      is_final?: boolean;
    },
  ) => call<Event>("POST", `/api/v1/rooms/${room_id}/events`, payload),

  appendDelta: (event_id: string, delta: string, seq = 0) =>
    call<{ ok: boolean }>("POST", `/api/v1/events/${event_id}/delta`, { delta, seq }),
  finalizeEvent: (event_id: string) =>
    call<{ ok: boolean }>("POST", `/api/v1/events/${event_id}/final`, {}),

  read: (room_id: string, event_id: string) =>
    call<{ marked: number }>("POST", `/api/v1/rooms/${room_id}/read`, { event_id }),

  typing: (room_id: string, is_typing = true) =>
    call<{ ok: boolean }>("POST", `/api/v1/rooms/${room_id}/typing`, { is_typing }),

  postProgress: (
    room_id: string,
    payload: {
      state: string;
      progress_group_id?: string;
      note?: string;
      progress_pct?: number;
      summary?: string;
    },
  ) => call<{ ok: boolean; state: string; event_id?: string; persisted?: boolean }>(
    "POST",
    `/api/v1/rooms/${room_id}/progress`,
    payload,
  ),

  takeBack: (event_id: string, reason = "manual", force = false) =>
    call<{ ok: boolean } | { detail: string }>(
      "POST",
      `/api/v1/events/${event_id}/take_back`,
      { reason, force },
    ),

  // -------- sessions --------
  sessionNew: (room_id: string, summary = "") =>
    call<{ session_id: string; started_at: string }>(
      "POST",
      `/api/v1/rooms/${room_id}/sessions`,
      { summary },
    ),
  sessionEnd: (session_id: string, summary = "") =>
    call<{ ok: boolean; ended_at: string }>(
      "POST",
      `/api/v1/silicons/me/sessions/${session_id}/end`,
      { summary },
    ),
  sessions: () => call<unknown[]>("GET", "/api/v1/silicons/me/sessions"),

  // -------- search --------
  search: (params: { q: string; room?: string; sender_kind?: string; since?: string; until?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    return call<Event[]>("GET", `/api/v1/events/search?${qs.toString()}`);
  },

  // -------- media --------
  presignUpload: (data: { mime: string; size: number; kind: string; filename?: string; room_id?: string }) =>
    call<{ upload: { url: string; fields: Record<string, string>; method: string; dev_mode?: boolean }; media: MediaObject }>(
      "POST",
      "/api/v1/media/upload-url",
      data,
    ),
  mediaDetail: (media_id: string) =>
    call<{ media: MediaObject; download_url: string | null }>(
      "GET",
      `/api/v1/media/${media_id}`,
    ),

  // -------- voice --------
  tts: (data: { text: string; voice?: string; scene?: string; style?: string; room_id?: string }) =>
    call<{ job: string; media_id: string; status: string }>("POST", "/api/v1/tts", data),
  stt: (data: { media_id: string; language?: string }) =>
    call<{ job: string; media_id: string }>("POST", "/api/v1/stt", data),

  // -------- cost (staff) --------
  costSummary: () =>
    call<{ rows: unknown[]; grand_total_cents: number }>("GET", "/api/v1/cost/summary"),
  costRecent: () => call<unknown[]>("GET", "/api/v1/cost/recent"),
};

export { ApiError };
