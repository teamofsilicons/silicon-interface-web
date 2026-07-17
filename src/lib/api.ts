// Typed REST client over fetch. Auto-attaches Authorization or X-Silicon-Key based on auth store.

import { env } from "./env";
import { authStore } from "./auth";
import { outboxTraceparent } from "./outbox";
import { newTraceparent, validTraceparent } from "./trace-context";
import {
  classifySessionRestoreFailure,
  compatibilityRestoreAllowsEntry,
  type WebSessionRestoreState,
} from "./session-bootstrap";
import {
  challengeFromErrorBody,
  rememberAbuseChallenge,
} from "./abuse-challenge-store";
import type {
  Announcement,
  AuthSession,
  BillingAddon,
  BillingCycle,
  BillingData,
  Carbon,
  CarbonPublic,
  Contact,
  ClientOperationStatus,
  Cron,
  CronWriteResult,
  DevOtpResponse,
  DraftState,
  DraftsListResponse,
  DraftWritePayload,
  Event,
  EventVectorRange,
  HistoryPage,
  AccountSyncUpdate,
  HeldSend,
  HeldSendsListResponse,
  InitialSyncResponse,
  Invite,
  InviteInfo,
  Invitee,
  JwtPair,
  LoginStartResponse,
  MediaObject,
  Room,
  Silicon,
  SiliconPublic,
  TakeBackPolicy,
  Team,
  TeamMembership,
  TeamRole,
  ThreadPage,
  ThreadReadResult,
  SyncPageRange,
} from "./types";

export type ReactivityBucket = "hour" | "day" | "month";

export interface ReactivityPoint {
  /** ISO timestamp of the bucket start (UTC). */
  t: string;
  /** Triggers in this bucket. */
  count: number;
  /** Running total through this bucket. */
  cumulative: number;
}

export interface ReactivitySeries {
  bucket: ReactivityBucket;
  /** Cumulative total before the window opened (line starts here, not zero). */
  baseline: number;
  points: ReactivityPoint[];
  /** Grand cumulative total at the end of the window. */
  total: number;
}

export interface ModerationRestriction {
  restriction_id: string;
  state: string;
  rate_cost: number;
  starts_at: string;
  expires_at: string;
  appealed: boolean;
}

export interface ModerationAppeal {
  appeal_id: string;
  restriction_id: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

// tsx/ESM can load the same TypeScript module through both extensionless and
// explicit `.ts` specifiers on case-sensitive CI filesystems. A plain
// `instanceof` then fails because each loader instance owns a different class
// constructor. Brand the error through the process-wide symbol registry so the
// finite failure contracts remain stable across loader instances and realms.
const API_ERROR_BRAND = Symbol.for("silicon-interface.api-error.v1");

function hasApiErrorBrand(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  try {
    return (value as Record<symbol, unknown>)[API_ERROR_BRAND] === true;
  } catch {
    return false;
  }
}

class ApiError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return hasApiErrorBrand(value);
  }

  constructor(
    public status: number,
    public body: unknown,
    message: string,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    Object.defineProperty(this, API_ERROR_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

function retryAfterMs(resp: Response, body: unknown): number | null {
  const header = resp.headers.get("retry-after");
  const failure =
    body && typeof body === "object" && "failure" in body &&
    (body as { failure?: unknown }).failure &&
    typeof (body as { failure: unknown }).failure === "object"
      ? (body as { failure: { retry_after_seconds?: unknown } }).failure
      : null;
  const bodySeconds =
    body && typeof body === "object" && "retry_after_seconds" in body
      ? Number((body as { retry_after_seconds?: unknown }).retry_after_seconds)
      : failure
        ? Number(failure.retry_after_seconds)
      : NaN;
  const seconds = header != null ? Number(header) : bodySeconds;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  if (header) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return null;
}

// Transparent refresh: when an authed call returns 401 and we have a refresh
// token, swap the access token (and rotated refresh, since Glass has
// ROTATE_REFRESH_TOKENS=True) and replay the original request exactly once.
// Refresh failures are swallowed — we do NOT clear the auth store here. The
// user stays "signed in" client-side; the next attempt will simply try again.
// Concurrent 401s share a single in-flight refresh so we don't stampede the
// endpoint.
let refreshInflight: Promise<WebSessionRestoreState> | null = null;
async function tryRefresh(): Promise<WebSessionRestoreState> {
  if (refreshInflight) return refreshInflight;
  const refreshOnce = async () => {
    const refreshTok = authStore.getRefresh();
    try {
      const r = await call<{ access: string; refresh?: string }>(
        "POST",
        "/api/v1/auth/refresh",
        refreshTok ? { refresh: refreshTok } : {},
        { auth: false },
      );
      authStore.setTokens(
        r.access,
        r.refresh ?? null,
        authStore.getCarbon() ?? undefined,
      );
      return "restored" as const;
    } catch (error) {
      return classifySessionRestoreFailure(error instanceof ApiError ? error.status : null);
    }
  };
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  // The HttpOnly refresh cookie is shared across tabs and rotates on use.
  // Serialize refreshes across tabs so one reload cannot invalidate the cookie
  // another reload is about to submit.
  const coordinated: Promise<WebSessionRestoreState> = locks?.request
    ? (async () => await locks.request(
        "silicon-interface:web-session-refresh",
        { mode: "exclusive" },
        async () => await refreshOnce(),
      ))()
    : refreshOnce();
  const inflight = coordinated.finally(() => {
    refreshInflight = null;
  });
  refreshInflight = inflight;
  return inflight;
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: {
    auth?: boolean;
    _retried?: boolean;
    _staleTokenRetried?: boolean;
    signal?: AbortSignal;
    traceparent?: string;
    includeDeviceId?: boolean;
  } = {},
): Promise<T> {
  const traceparent = validTraceparent(opts.traceparent) || newTraceparent();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Chat-Protocol": "1",
    "X-Silicon-Web-Session": "1",
    traceparent,
  };
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  let usedAccess: string | null = null;
  if (opts.auth !== false) {
    usedAccess = authStore.getAccess();
    if (usedAccess) headers["Authorization"] = `Bearer ${usedAccess}`;
    const silKey = authStore.getSiliconKey();
    if (silKey) headers["X-Silicon-Key"] = silKey;
    const boundDeviceId = opts.includeDeviceId === false ? null : authStore.getBoundDeviceId();
    if (boundDeviceId) headers["X-Device-ID"] = boundDeviceId;
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
    signal: opts.signal,
    credentials: "include",
  });
  if (
    resp.status === 401 &&
    opts.auth !== false &&
    !authStore.getSiliconKey()
  ) {
    const currentAccess = authStore.getAccess();
    // A concurrent request may have already renewed the session while this
    // request (sent with the previous access token) was still in flight. Replay
    // with that newer token before rotating the shared refresh cookie again.
    if (
      !opts._staleTokenRetried &&
      usedAccess &&
      currentAccess &&
      currentAccess !== usedAccess
    ) {
      return call<T>(method, path, body, {
        ...opts,
        _staleTokenRetried: true,
        traceparent,
      });
    }
    if (!opts._retried) {
      const refreshState = await tryRefresh();
      if (refreshState === "restored") {
        return call<T>(method, path, body, { ...opts, _retried: true, traceparent });
      }
    }
  }
  const ct = resp.headers.get("content-type") || "";
  const parsed: unknown = ct.includes("application/json")
    ? await resp.json().catch(() => null)
    : await resp.text().catch(() => null);
  if (!resp.ok) {
    const abuseChallenge = challengeFromErrorBody(parsed);
    const carbonId = authStore.getCarbon()?.carbon_id;
    if (abuseChallenge && carbonId) {
      await rememberAbuseChallenge(carbonId, abuseChallenge).catch(() => undefined);
    }
    const msg =
      (parsed && typeof parsed === "object" && "detail" in parsed
        ? (parsed as { detail: string }).detail
        : null) ?? `${method} ${path} → ${resp.status}`;
    throw new ApiError(resp.status, parsed, msg, retryAfterMs(resp, parsed));
  }
  return parsed as T;
}

async function callBlob(
  path: string,
  retried = false,
  staleTokenRetried = false,
): Promise<Blob> {
  const headers: Record<string, string> = {
    "X-Chat-Protocol": "1",
    "X-Silicon-Web-Session": "1",
  };
  const tok = authStore.getAccess();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const silKey = authStore.getSiliconKey();
  if (silKey) headers["X-Silicon-Key"] = silKey;
  const boundDeviceId = authStore.getBoundDeviceId();
  if (boundDeviceId) headers["X-Device-ID"] = boundDeviceId;
  const resp = await fetch(`${env.apiBase}${path}`, { headers, credentials: "include" });
  if (resp.status === 401 && !retried && tok) {
    const currentAccess = authStore.getAccess();
    if (!staleTokenRetried && currentAccess && currentAccess !== tok) {
      return callBlob(path, false, true);
    }
    const refreshState = await tryRefresh();
    if (refreshState === "restored") return callBlob(path, true);
  }
  if (!resp.ok) {
    const parsed = await resp.json().catch(() => null) as { detail?: string } | null;
    throw new ApiError(
      resp.status,
      parsed,
      parsed?.detail ?? `GET ${path} → ${resp.status}`,
      retryAfterMs(resp, parsed),
    );
  }
  return resp.blob();
}

export type GlobalNotificationPreferences = {
  enabled: boolean;
  paused_until: string;
  quiet_hours: {
    enabled: boolean;
    timezone: string;
    start: string;
    end: string;
    weekdays: number[];
    allow_mentions: boolean;
    allow_keywords: boolean;
  };
  keywords: string[];
};

export type ChatPreferences = {
  read_receipts_enabled: boolean;
  notifications: GlobalNotificationPreferences;
  presence_visibility: "everyone" | "contacts" | "nobody";
};

export type GlobalNotificationPreferencesPatch = Partial<
  Omit<GlobalNotificationPreferences, "quiet_hours">
> & {
  quiet_hours?: Partial<GlobalNotificationPreferences["quiet_hours"]>;
};

export const api = {
  // -------- registered installation --------
  registerDevice: (payload: {
    device_id: string;
    platform?: string;
    name?: string;
    app_version?: string;
    capabilities?: Record<string, unknown>;
  }) =>
    call<{
      device: { device_id: string };
      access: string;
      refresh?: string;
    }>("POST", "/api/v1/devices", payload),
  chatPreferences: () =>
    call<ChatPreferences>("GET", "/api/v1/chat/preferences"),
  updateChatPreferences: (payload: {
    read_receipts_enabled?: boolean;
    notifications?: GlobalNotificationPreferencesPatch;
    presence_visibility?: "everyone" | "contacts" | "nobody";
  }) => call<ChatPreferences>("PATCH", "/api/v1/chat/preferences", payload),
  requestAbuseChallengePush: (token: string) =>
    call<{ queued: boolean; solved?: boolean; expires_at?: string }>(
      "POST",
      "/api/v1/challenges/push",
      { token },
    ),
  answerAbuseChallenge: (payload: {
    token: string;
    type: "push" | "captcha";
    answer: string;
  }) => call<{ solved: true }>("PUT", "/api/v1/challenges", payload),

  // -------- web push --------
  pushVapidKey: () => call<{ public_key: string }>("GET", "/api/v1/push/vapid-key"),
  pushSubscribe: (sub: PushSubscriptionJSON & { preview_mode?: "full" | "sender" | "none" }) =>
    call<{ subscribed: boolean }>("POST", "/api/v1/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) =>
    call<{ ok: boolean }>("POST", "/api/v1/push/unsubscribe", { endpoint }),

  // -------- websocket auth --------
  /** Mint a single-use, 60s-TTL WS ticket so the socket URL never carries the
   *  long-lived JWT. One ticket per connect attempt (single-use). */
  wsTicket: () => call<{ ticket: string; expires_in: number }>("POST", "/api/v1/ws/ticket", {}),

  // -------- health / dev --------
  healthz: () => call<{ status: string }>("GET", "/healthz", undefined, { auth: false }),
  readyz: () => call<{ ready: boolean; checks: Record<string, string> }>("GET", "/readyz", undefined, { auth: false }),
  version: () => call<{
    version: string;
    commit: string;
    protocol: { current: number; minimum: number; maximum: number; sync_schema: number };
  }>("GET", "/api/v1/version", undefined, { auth: false }),
  devLastOtp: (target: string) =>
    call<DevOtpResponse>(
      "GET",
      `/api/v1/dev/last-otp?target=${encodeURIComponent(target)}`,
      undefined,
      { auth: false },
    ),

  // -------- registration --------
  registerPhoneStart: (phone: string, flow_id?: string) =>
    call<{ flow_id?: string; existing?: boolean }>("POST", "/api/v1/auth/register/phone/start", { phone, flow_id }, { auth: false }),
  registerPhoneVerify: (flow_id: string, phone: string, code: string) =>
    call<{ verified: boolean }>("POST", "/api/v1/auth/register/phone/verify", { flow_id, phone, code }, { auth: false }),
  registerEmailStart: (email: string, flow_id?: string) =>
    call<{ flow_id?: string; existing?: boolean }>("POST", "/api/v1/auth/register/email/start", { email, flow_id }, { auth: false }),
  registerEmailVerify: (flow_id: string, email: string, code: string) =>
    call<{ verified: boolean }>("POST", "/api/v1/auth/register/email/verify", { flow_id, email, code }, { auth: false }),
  registerUsername: (flow_id: string, username?: string) =>
    call<AuthSession>("POST", "/api/v1/auth/register/username", { flow_id, username }, { auth: false }),
  carbonIdAvailable: (value: string) =>
    call<{ available: boolean; valid: boolean; reason: string }>(
      "GET",
      `/api/v1/auth/carbon-id/available?value=${encodeURIComponent(value)}`,
      undefined,
      { auth: false },
    ),

  // -------- login --------
  loginStart: (identifier: string) =>
    call<LoginStartResponse>("POST", "/api/v1/auth/login/start", { identifier }, { auth: false }),
  loginSelectChannel: (challenge_id: string, channel: "sms" | "email") =>
    call<LoginStartResponse>(
      "POST",
      "/api/v1/auth/login/select-channel",
      { challenge_id, channel },
      { auth: false },
    ),
  loginVerify: (challenge_id: string, code: string) =>
    call<JwtPair>("POST", "/api/v1/auth/login/verify", { challenge_id, code }, { auth: false }),
  refresh: (refresh?: string) =>
    call<{ access: string; refresh?: string }>(
      "POST", "/api/v1/auth/refresh", refresh ? { refresh } : {}, { auth: false },
    ),
  restoreWebSessionState: () => tryRefresh(),
  // Compatibility for non-guard entry points. Known owners retain offline and
  // transient-failure access; only an authoritative anonymous result is false.
  restoreWebSession: async () => {
    const state = await tryRefresh();
    return compatibilityRestoreAllowsEntry(state, Boolean(authStore.getCarbon()));
  },

  // -------- profile --------
  me: () => call<Carbon>("GET", "/api/v1/carbons/me"),
  meSilicon: () => call<Silicon>("GET", "/api/v1/silicons/me"),
  patchMe: (patch: Partial<Carbon>) => call<Carbon>("PATCH", "/api/v1/carbons/me", patch),
  carbonByHandle: (handle: string) => call<CarbonPublic>("GET", `/api/v1/handle/carbon/${encodeURIComponent(handle)}`),
  siliconByHandle: (handle: string) => call<SiliconPublic>("GET", `/api/v1/handle/silicon/${encodeURIComponent(handle)}`),

  // Open (or join) a silicon's cloud browser session on demand. Reuses the
  // silicon's live session when one exists, else launches a new one in its
  // browser profile + team region. Returns the Silicon Browser viewer URL.
  openSiliconBrowser: (siliconId: string) =>
    call<{ session_id: string; viewer_url: string; reused: boolean; region?: string; live?: boolean }>(
      "POST",
      `/api/v1/silicons/${encodeURIComponent(siliconId)}/browser-session`,
    ),

  takeBackPolicy: () => call<TakeBackPolicy>("GET", "/api/v1/carbons/me/take-back-policy"),
  setTakeBackPolicy: (p: Partial<TakeBackPolicy>) =>
    call<TakeBackPolicy>("PATCH", "/api/v1/carbons/me/take-back-policy", p),

  // -------- teams --------
  teams: () => call<Team[]>("GET", "/api/v1/teams/"),
  team: (slug: string) => call<Team>("GET", `/api/v1/teams/${slug}/`),
  createTeam: (data: { name: string; slug?: string }) => call<Team>("POST", "/api/v1/teams/", data),
  patchTeam: (slug: string, patch: Partial<Team>) => call<Team>("PATCH", `/api/v1/teams/${slug}/`, patch),
  uploadTeamLogo: (slug: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<Team>("POST", `/api/v1/teams/${slug}/logo`, form);
  },
  teamMembers: (slug: string) => call<TeamMembership[]>("GET", `/api/v1/teams/${slug}/members`),
  teamSilicons: (slug: string) => call<Silicon[]>("GET", `/api/v1/teams/${slug}/silicons`),
  teamReactivity: (slug: string) => call<{ value: number }>("GET", `/api/v1/teams/${slug}/reactivity`),
  teamReactivitySeries: (slug: string, bucket: ReactivityBucket = "hour") =>
    call<ReactivitySeries>(
      "GET",
      `/api/v1/teams/${slug}/reactivity/series?bucket=${bucket}`,
    ),
  teamStructure: (slug: string) =>
    call<{ svg: string; dsl?: string }>("GET", `/api/v1/teams/${slug}/structure`),
  teamInvites: (slug: string) => call<Invite[]>("GET", `/api/v1/teams/${slug}/invites`),
  createInvite: (
    slug: string,
    data: {
      scope?: "team" | "silicon";
      silicon_id?: string;
      channel?: "link" | "email";
      email_target?: string;
      role?: TeamRole;
      max_uses?: number;
      ttl_minutes?: number;
    },
  ) => call<Invite>("POST", `/api/v1/teams/${slug}/invites`, data),
  disableInvite: (slug: string, inviteId: number) =>
    call<Invite>("DELETE", `/api/v1/teams/${slug}/invites/${inviteId}`),
  teamInvitees: (slug: string, offset = 0, limit = 5) =>
    call<{ results: Invitee[]; total: number; has_more: boolean }>(
      "GET",
      `/api/v1/teams/${slug}/invitees?offset=${offset}&limit=${limit}`,
    ),
  inviteInfo: (token: string) => call<InviteInfo>("GET", `/api/v1/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, body: { code?: string } = {}) =>
    call<{ joined: string; scope: string; role: TeamRole }>(
      "POST",
      `/api/v1/invites/${encodeURIComponent(token)}/accept`,
      body,
    ),
  inviteVerifyEmailStart: (token: string, email: string) =>
    call<{ sent?: boolean; verified?: boolean }>(
      "POST",
      `/api/v1/invites/${encodeURIComponent(token)}/verify-email/start`,
      { email },
    ),
  inviteVerifyEmailCheck: (token: string, email: string, code: string) =>
    call<{ verified: boolean }>(
      "POST",
      `/api/v1/invites/${encodeURIComponent(token)}/verify-email/check`,
      { email, code },
    ),

  // -------- billing (team heads) --------
  teamBilling: (slug: string) => call<BillingData>("GET", `/api/v1/teams/${slug}/billing`),
  setTeamPlan: (slug: string, amount_cents: number, currency = "USD") =>
    call<{ monthly_cost_cents: number; currency: string }>(
      "POST",
      `/api/v1/teams/${slug}/billing/plan`,
      { amount_cents, currency },
    ),
  addTeamAddon: (slug: string, data: { label: string; amount_cents: number; recurring?: boolean }) =>
    call<BillingAddon>("POST", `/api/v1/teams/${slug}/billing/addons`, data),
  rollTeamCycle: (slug: string) =>
    call<BillingCycle>("POST", `/api/v1/teams/${slug}/billing/roll`, {}),
  teamCheckout: (
    slug: string,
    opts: {
      return_url?: string;
      cycle_id?: number;
      cycle_ids?: number[];
      // Stable token so a retry after a lost response reuses the same intent
      // instead of creating (and charging) a second one. See team-panel.tsx.
      idempotency_key?: string;
    } = {},
  ) =>
    call<{
      checkout_url: string;
      payment_id: string;
      dev_mode?: boolean;
      error?: string;
      amount_cents?: number;
      cycle_ids?: number[];
    }>(
      "POST",
      `/api/v1/teams/${slug}/billing/checkout`,
      {
        return_url: opts.return_url ?? "",
        cycle_id: opts.cycle_id,
        cycle_ids: opts.cycle_ids,
        idempotency_key: opts.idempotency_key,
      },
    ),

  // -------- chat --------
  rooms: (signal?: AbortSignal) =>
    call<Room[]>("GET", "/api/v1/rooms/", undefined, { signal }),
  createRoom: (name: string, topic = "") => call<Room>("POST", "/api/v1/rooms/", { name, topic }),
  directRoom: (target_kind: "carbon" | "silicon", target_id: string) =>
    call<Room>("POST", "/api/v1/rooms/direct", { target_kind, target_id }),
  roomDetail: (room_id: string) => call<Room>("GET", `/api/v1/rooms/${room_id}/`),
  updateRoomListPreferences: (
    room_id: string,
    preferences: Partial<{ pinned: boolean; archived: boolean }>,
  ) => call<{ preferences: { pinned: boolean; archived: boolean } }>(
    "PATCH",
    `/api/v1/rooms/${room_id}/list-preferences`,
    preferences,
  ),

  roomMembers: (room_id: string) => call<unknown[]>("GET", `/api/v1/rooms/${room_id}/members`),
  addRoomMember: (room_id: string, member_kind: "carbon" | "silicon", member_id: number, role = "member") =>
    call<unknown>("POST", `/api/v1/rooms/${room_id}/members`, { member_kind, member_id, role }),

  events: (room_id: string, before?: string, limit = 50) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set("before", before);
    return call<Event[]>("GET", `/api/v1/rooms/${room_id}/events?${q.toString()}`);
  },
  historyPage: (
    room_id: string,
    cursor = "",
    limit = 50,
    direction: "backward" | "forward" = "backward",
    anchor?: string,
  ) => {
    const q = new URLSearchParams({
      cursor,
      limit: String(limit),
      direction,
    });
    if (anchor) q.set("anchor", anchor);
    return call<HistoryPage>(
      "GET",
      `/api/v1/rooms/${room_id}/events?${q.toString()}`,
    );
  },
  threadPage: (event_id: string, cursor = "", limit = 50) => {
    const q = cursor
      ? new URLSearchParams({ cursor })
      : new URLSearchParams({ limit: String(limit) });
    return call<ThreadPage>(
      "GET",
      `/api/v1/events/${encodeURIComponent(event_id)}/thread?${q.toString()}`,
    );
  },
  markThreadRead: (event_id: string, through_event_id: string) =>
    call<ThreadReadResult>(
      "POST",
      `/api/v1/events/${encodeURIComponent(event_id)}/thread/read`,
      { event_id: through_event_id },
    ),
  sendEvent: async (
    room_id: string,
    payload: {
      type: string;
      content?: Record<string, unknown>;
      reply_to_event_id?: string;
      is_final?: boolean;
    },
    // The backend uses content.client_id as the device-scoped idempotency key.
    // It is never trusted for timeline reconciliation: Glass separately emits
    // top-level transaction_id only to the exact authoring X-Device-ID.
    client_id?: string,
  ) => {
    const ownerId = authStore.getCarbon()?.carbon_id ?? "";
    const traceparent = client_id && ownerId
      ? await outboxTraceparent(ownerId, client_id).catch(() => "")
      : "";
    return call<Event>("POST", `/api/v1/rooms/${room_id}/events`, {
      ...payload,
      content: client_id ? { ...(payload.content ?? {}), client_id } : payload.content,
    }, { traceparent });
  },

  clientOperation: (
    room_id: string,
    kind: "event_send" | "held_send",
    client_id: string,
  ) =>
    call<ClientOperationStatus>(
      "GET",
      `/api/v1/rooms/${encodeURIComponent(room_id)}/operations/${kind}/${encodeURIComponent(client_id)}?include=result`,
    ),

  forwardEvents: (
    target_room_id: string,
    source_room_id: string,
    source_event_ids: string[],
    comment?: string,
  ) => {
    const body: Record<string, unknown> = {
      source_room_id,
      source_event_ids,
    };
    const trimmed = comment?.trim();
    if (trimmed) body.comment = trimmed;
    return call<Event[]>("POST", `/api/v1/rooms/${target_room_id}/forward`, body);
  },
  forwardEvent: (target_room_id: string, source_room_id: string, source_event_id: string) =>
    api.forwardEvents(target_room_id, source_room_id, [source_event_id]),

  draft: (room_id: string) => call<DraftState>("GET", `/api/v1/rooms/${room_id}/draft`),
  drafts: () => call<DraftsListResponse>("GET", "/api/v1/drafts"),
  putDraft: (room_id: string, payload: DraftWritePayload) =>
    call<DraftState>("PUT", `/api/v1/rooms/${room_id}/draft`, payload),
  deleteDraft: (room_id: string, payload: { base_version?: number; origin_device?: string }) =>
    call<DraftState>("DELETE", `/api/v1/rooms/${room_id}/draft`, payload),
  recordClientDurableCommits: (payload: {
    schema: 1;
    platform: "web";
    counters: {
      draft: { attempted: number; succeeded: number; failed: number };
      send: { attempted: number; succeeded: number; failed: number };
    };
  }) => call<void>(
    "POST",
    "/api/v1/telemetry/client-durable-commits",
    payload,
    { includeDeviceId: false },
  ),

  heldSends: (room_id: string) =>
    call<HeldSendsListResponse>("GET", `/api/v1/rooms/${room_id}/held-sends`),
  heldSendsAll: () => call<HeldSendsListResponse>("GET", "/api/v1/held-sends"),
  createHeldSend: (
    room_id: string,
    payload: {
      type: "m.text";
      content: Record<string, unknown>;
      reply_to_event_id?: string;
      hold_seconds?: number;
      client_id?: string;
    },
  ) => call<HeldSend>("POST", `/api/v1/rooms/${room_id}/held-sends`, payload),
  cancelHeldSend: (room_id: string, held_send_id: string) =>
    call<HeldSend>("DELETE", `/api/v1/rooms/${room_id}/held-sends/${held_send_id}`),
  updateHeldSend: (
    room_id: string,
    held_send_id: string,
    payload: {
      base_version: number;
      hold_seconds?: number;
      delay_seconds?: number;
      content?: Record<string, unknown>;
      client_id?: string;
      reply_to_event_id?: string;
    },
  ) => call<HeldSend>("PATCH", `/api/v1/rooms/${room_id}/held-sends/${held_send_id}`, payload),
  sendHeldNow: (room_id: string, held_send_id: string) =>
    call<HeldSend>("POST", `/api/v1/rooms/${room_id}/held-sends/${held_send_id}/send-now`, {}),

  appendDelta: (event_id: string, delta: string, seq = 0) =>
    call<{ ok: boolean }>("POST", `/api/v1/events/${event_id}/delta`, { delta, seq }),
  finalizeEvent: (event_id: string) =>
    call<{ ok: boolean }>("POST", `/api/v1/events/${event_id}/final`, {}),
  editEvent: (event_id: string, body: string, baseVersion: number) =>
    call<Event>("POST", `/api/v1/events/${event_id}/edit`, {
      body,
      base_version: baseVersion,
    }),
  setReaction: (
    event_id: string,
    emoji: string,
    active: boolean,
    client_id?: string,
  ) => call<{ active: boolean; event: Event | null }>(
    "PUT",
    `/api/v1/events/${event_id}/reaction`,
    { emoji, active, ...(client_id ? { client_id } : {}) },
  ),

  /** Global ULID-cursor backfill across all visible rooms — replays events
   *  created after `after` as WS-shaped frames, for reconnect resync. */
  eventsSync: (after: string, limit = 200) =>
    call<{
      frames: { type: "event"; room_id: string; event: Event }[];
      next: string | null;
      has_more: boolean;
    }>(
      "GET",
      `/api/v1/events/sync?after=${encodeURIComponent(after)}&limit=${limit}`,
    ),

  initialSync: (cursor = "", limit = 50, timelineLimit = 20, signal?: AbortSignal) => {
    const query = new URLSearchParams({
      limit: String(limit),
      timeline_limit: String(timelineLimit),
    });
    if (cursor) query.set("cursor", cursor);
    return call<InitialSyncResponse>(
      "GET",
      `/api/v1/sync/initial?${query.toString()}`,
      undefined,
      { signal },
    );
  },
  eventsSyncCursor: (cursor: string, through = "", limit = 200, signal?: AbortSignal) => {
    const query = new URLSearchParams({ cursor, limit: String(limit) });
    if (through) query.set("through", through);
    return call<{
      frames: { type: "event"; room_id: string; event: Event }[];
      cursor: string;
      through: string;
      has_more: boolean;
      range: SyncPageRange | null;
      vector_range?: EventVectorRange;
    }>("GET", `/api/v1/events/sync?${query.toString()}`, undefined, { signal });
  },
  accountSync: (cursor: string, through = "", limit = 200, signal?: AbortSignal) => {
    const query = new URLSearchParams({ cursor, limit: String(limit) });
    if (through) query.set("through", through);
    return call<{
      updates: AccountSyncUpdate[];
      cursor: string;
      through: string;
      has_more: boolean;
      range: SyncPageRange;
    }>("GET", `/api/v1/sync/account?${query.toString()}`, undefined, { signal });
  },
  syncPoll: (
    eventCursor: string,
    accountCursor: string,
    timeout = 25_000,
    limit = 200,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({
      event_cursor: eventCursor,
      account_cursor: accountCursor,
      timeout: String(timeout),
      limit: String(limit),
    });
    return call<{
      events: {
        frames: { type: "event"; room_id: string; event: Event }[];
        cursor: string;
        through: string;
        has_more: boolean;
        range: SyncPageRange | null;
        vector_range?: EventVectorRange;
      };
      account: {
        updates: AccountSyncUpdate[];
        cursor: string;
        through: string;
        has_more: boolean;
        range: SyncPageRange;
      };
    }>("GET", `/api/v1/sync/poll?${query.toString()}`, undefined, { signal });
  },
  acknowledgeDelivered: (event_ids: string[], traceparent = "") =>
    call<{ acknowledged: number; device_id: string }>(
      "POST",
      "/api/v1/events/delivered",
      { event_ids },
      { traceparent },
    ),

  read: (room_id: string, event_id: string) =>
    call<{ marked: number }>("POST", `/api/v1/rooms/${room_id}/read`, { event_id }),

  typing: (room_id: string, is_typing = true) =>
    call<{ ok: boolean }>("POST", `/api/v1/rooms/${room_id}/typing`, { is_typing }),
  /** Generic activity beacon: typing | uploading | recording. */
  activity: (
    room_id: string,
    state: "typing" | "uploading" | "recording",
    active = true,
  ) =>
    call<{ ok: boolean }>("POST", `/api/v1/rooms/${room_id}/activity`, {
      state,
      active,
    }),

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
  /** Carbon self-delete: works within 5 minutes of authoring the event. */
  deleteEvent: (event_id: string) =>
    call<{ ok: boolean } | { detail: string }>(
      "POST",
      `/api/v1/events/${event_id}/delete`,
      {},
    ),

  // -------- safety / moderation --------
  reportMessage: (data: {
    target_kind: "carbon" | "silicon";
    target_id: string;
    reason: "spam" | "harassment" | "inappropriate" | "other";
    details: string;
    client_id: string;
    event_id: string;
  }) => call<{ id: number; report_id: string; status: string }>(
    "POST",
    "/api/v1/moderation/reports",
    data,
  ),
  moderationRestrictions: () => call<{ restrictions: ModerationRestriction[] }>(
    "GET",
    "/api/v1/moderation/restrictions",
  ),
  moderationAppeals: () => call<{ appeals: ModerationAppeal[] }>(
    "GET",
    "/api/v1/moderation/appeals",
  ),
  submitModerationAppeal: (data: { restriction_id: string; reason: string }) =>
    call<ModerationAppeal>("POST", "/api/v1/moderation/appeals", data),

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
  // A continuation is opaque and principal-bound. Once present it is the only
  // allowed parameter, preserving Glass's fixed boundary and filters.
  search: (params: {
    q?: string;
    room?: string;
    sender_kind?: string;
    since?: string;
    until?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    return call<{
      results: Event[];
      cursor: string | null;
      limit: number;
      total: number;
      has_more: boolean;
      block?: number;
      interval?: number;
    }>(
      "GET",
      `/api/v1/events/search?${qs.toString()}`,
    );
  },

  // -------- media --------
  presignUpload: (data: { mime: string; size: number; kind: string; filename?: string; room_id?: string }) =>
    call<{ upload: { url: string; fields: Record<string, string>; method: string; dev_mode?: boolean }; media: MediaObject }>(
      "POST",
      "/api/v1/media/upload-url",
      data,
    ),
  createMultipartUpload: (data: {
    client_id: string;
    mime: string;
    size: number;
    kind: "image" | "file" | "voice";
    filename?: string;
    room_id?: string;
    sha256?: string;
  }) => call<MultipartUploadState>("POST", "/api/v1/media/uploads", data),
  multipartUpload: (sessionId: string) =>
    call<MultipartUploadState>("GET", `/api/v1/media/uploads/${encodeURIComponent(sessionId)}`),
  signMultipartParts: (
    sessionId: string,
    parts: Array<{ part_number: number; checksum_sha256: string }>,
  ) => call<{
    session_id: string;
    parts: Array<{ part_number: number; checksum_sha256: string; url: string; method: "PUT" }>;
  }>("POST", `/api/v1/media/uploads/${encodeURIComponent(sessionId)}/parts`, { parts }),
  completeMultipartUpload: (
    sessionId: string,
    data: {
      sha256: string;
      parts: Array<{ part_number: number; etag: string; checksum_sha256: string }>;
    },
  ) => call<MultipartUploadState>(
    "POST", `/api/v1/media/uploads/${encodeURIComponent(sessionId)}/complete`, data,
  ),
  cancelMultipartUpload: (sessionId: string) =>
    call<MultipartUploadState>("DELETE", `/api/v1/media/uploads/${encodeURIComponent(sessionId)}`),
  mediaDetail: (media_id: string) =>
    call<{
      media: MediaObject;
      download_url: string | null;
      attachment_url?: string | null;
    }>(
      "GET",
      `/api/v1/media/${media_id}`,
    ),
  /** Authenticated, CORS-readable bytes for canvas/PDF processing. Normal
   * playback still uses the direct presigned download URL. */
  mediaContent: (media_id: string) =>
    callBlob(`/api/v1/media/${encodeURIComponent(media_id)}/content`),
  /** A bounded authenticated text head for CSV/Markdown previews. This route
   * stays valid after the direct object-storage grant embedded in old events
   * has expired. */
  mediaTextPreview: async (media_id: string, maxBytes = 64 * 1024) => {
    const bounded = Math.max(4 * 1024, Math.min(Math.trunc(maxBytes), 256 * 1024));
    const blob = await callBlob(
      `/api/v1/media/${encodeURIComponent(media_id)}/content?head=${bounded}`,
    );
    return blob.text();
  },
  /**
   * Confirm an S3 upload completed. Flips MediaObject.status from "pending"
   * to "ready" so subsequent /media/<id> returns a download_url instead of
   * the loading placeholder. Idempotent.
   *
   * Optional metadata (image width/height, audio duration + waveform peaks)
   * is backfilled into the MediaObject so subsequent renders can reserve
   * the right aspect and show the bars before audio finishes downloading.
   */
  mediaComplete: (
    media_id: string,
    meta?: { width?: number; height?: number; duration_ms?: number; peaks?: number[] },
  ) =>
    call<MediaObject>("POST", `/api/v1/media/${media_id}/complete`, meta ?? {}),

  // -------- voice --------
  tts: (data: { text: string; voice?: string; scene?: string; style?: string; room_id?: string }) =>
    call<{ job: string; media_id: string; status: string }>("POST", "/api/v1/tts", data),
  stt: (data: { media_id: string; language?: string }) =>
    call<{
      job: "queued" | "complete";
      media_id: string;
      transcription_status: "pending" | "ready";
    }>("POST", "/api/v1/stt", data),

  // -------- contacts --------
  contacts: () => call<Contact[]>("GET", "/api/v1/contacts/"),
  saveContact: (data: {
    target_kind: "carbon" | "silicon";
    target_id: string;
    name?: string;
    note?: string;
    photo_key?: string;
  }) => call<Contact>("POST", "/api/v1/contacts/", data),
  updateContact: (
    id: number,
    data: { name?: string; note?: string; photo_key?: string },
  ) => call<Contact>("PATCH", `/api/v1/contacts/${id}`, data),
  deleteContact: (id: number) => call<void>("DELETE", `/api/v1/contacts/${id}`),

  // -------- crons --------
  // Reads are open; create/update/delete are silicon-only (creator-owned) and
  // simply 403 for carbon callers — the UI keeps them read-only.
  crons: (params: { for?: string; setup_by?: string; mine?: boolean; team?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.for) q.set("for", params.for);
    if (params.setup_by) q.set("setup_by", params.setup_by);
    if (params.mine) q.set("mine", "1");
    // §3.6 — scope to crons owned by a team's silicons.
    if (params.team) q.set("team", params.team);
    const qs = q.toString();
    return call<Cron[]>("GET", `/api/v1/crons/${qs ? `?${qs}` : ""}`);
  },
  cron: (cron_id: string) => call<Cron>("GET", `/api/v1/crons/${cron_id}`),
  createCron: (data: { trigger: string; for_targets: { kind: "carbon" | "silicon"; id: string }[]; task: string }) =>
    call<CronWriteResult>("POST", "/api/v1/crons/", data),
  patchCron: (cron_id: string, patch: Partial<{ trigger: string; task: string; is_active: boolean }>) =>
    call<CronWriteResult>("PATCH", `/api/v1/crons/${cron_id}`, patch),
  deleteCron: (cron_id: string) => call<void>("DELETE", `/api/v1/crons/${cron_id}`),

  // -------- announcements --------
  announcements: () => call<Announcement[]>("GET", "/api/v1/announcements"),

  // -------- cost (staff) --------
  costSummary: () =>
    call<{ rows: unknown[]; grand_total_cents: number }>("GET", "/api/v1/cost/summary"),
  costRecent: () => call<unknown[]>("GET", "/api/v1/cost/recent"),
};

export interface MultipartUploadState {
  session_id: string;
  client_id: string;
  state: "creating" | "uploading" | "completed" | "cancelled" | "expired" | "failed";
  part_size: number;
  part_count: number;
  expires_at: string;
  media: MediaObject;
  dev_mode: boolean;
  uploaded_parts?: Array<{
    part_number: number;
    etag: string;
    size: number;
    checksum_sha256: string;
  }>;
}

export { ApiError };
