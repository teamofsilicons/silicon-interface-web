import type {
  AccountSyncUpdate,
  Event,
  EventVectorRange,
  HistoryPage,
  Room,
  StreamVectorPosition,
  SyncPageRange,
} from "./types";
import { parseToolSetupAccountState } from "./tool-setup";

export type SyncStream = "events" | "account" | "history" | "initial";

export type SyncIntegrityReason =
  | "position_discontinuity"
  | "page_invariant"
  | "invalid_cursor"
  | "retention_floor"
  | "transient_failure";

export type SyncIntegrityDetails = {
  expectedPosition?: number;
  observedPosition?: number;
  fromPosition?: number;
  nextPosition?: number;
  throughPosition?: number;
  itemCount?: number;
  roomId?: string;
};

export const SUPPORTED_ACCOUNT_SYNC_KINDS = new Set([
  "draft",
  "held_send",
  "read_receipt",
  "thread.read_receipt",
  "delivery_receipt",
  "room.upsert",
  "room.remove",
  "room.notifications",
  "room.list_preferences",
  "moderation.block",
  "device",
  "chat.preferences",
  "client.operation",
  "extend.request",
]);

export class SyncIntegrityError extends Error {
  readonly reason: Extract<
    SyncIntegrityReason,
    "position_discontinuity" | "page_invariant"
  >;
  readonly stream: SyncStream;
  readonly details: SyncIntegrityDetails;

  constructor(
    stream: SyncStream,
    reason: SyncIntegrityError["reason"],
    message: string,
    details: SyncIntegrityDetails = {},
  ) {
    super(message);
    this.name = "SyncIntegrityError";
    this.stream = stream;
    this.reason = reason;
    this.details = details;
  }
}

function invariant(
  condition: unknown,
  stream: SyncStream,
  message: string,
  details: SyncIntegrityDetails = {},
): asserts condition {
  if (!condition) {
    throw new SyncIntegrityError(stream, "page_invariant", message, details);
  }
}

function safePosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function itemPosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

type RangedPage = {
  cursor: string;
  through: string;
  has_more: boolean;
  range: SyncPageRange;
};

type EventRangedPage = Omit<RangedPage, "range"> & {
  range: SyncPageRange | null;
  vector_range?: EventVectorRange;
};

export type ValidatedEventRange = SyncPageRange & {
  from_vector: StreamVectorPosition;
  next_vector: StreamVectorPosition;
  through_vector: StreamVectorPosition;
};

/**
 * Validate Glass' authenticated numeric coverage proof before a signed cursor
 * is persisted. The opaque token is deliberately never decoded by the client:
 * this range is the server-authenticated bridge between two cursor tokens.
 */
export function validateSyncPageRange(
  stream: "events" | "account",
  page: RangedPage,
  positions: readonly number[],
  expectedFromPosition: number,
  expectedThroughPosition?: number,
): SyncPageRange {
  const range = page?.range;
  invariant(range && typeof range === "object", stream, "Sync page is missing its coverage range.");
  invariant(isNonBlankString(page.cursor), stream, "Sync page is missing its next signed cursor.");
  invariant(isNonBlankString(page.through), stream, "Sync page is missing its signed high-water cursor.");
  invariant(typeof page.has_more === "boolean", stream, "Sync page has an invalid continuation marker.");
  invariant(range.stream === stream, stream, "Sync page range names the wrong stream.");
  invariant(
    range.coverage === (stream === "events" ? "authoritative_projection" : "contiguous"),
    stream,
    "Sync page has an unsupported coverage mode.",
  );
  invariant(
    safePosition(range.from_position) &&
      safePosition(range.next_position) &&
      safePosition(range.through_position),
    stream,
    "Sync page contains an invalid numeric position.",
  );
  if (range.from_position !== expectedFromPosition) {
    throw new SyncIntegrityError(
      stream,
      "position_discontinuity",
      "Sync page does not continue from the durable checkpoint.",
      {
        expectedPosition: expectedFromPosition,
        observedPosition: range.from_position,
        fromPosition: range.from_position,
        nextPosition: range.next_position,
        throughPosition: range.through_position,
      },
    );
  }
  if (
    expectedThroughPosition !== undefined &&
    range.through_position !== expectedThroughPosition
  ) {
    throw new SyncIntegrityError(
      stream,
      "position_discontinuity",
      "Sync page changed its fixed high-water position mid-traversal.",
      {
        expectedPosition: expectedThroughPosition,
        observedPosition: range.through_position,
        fromPosition: range.from_position,
        nextPosition: range.next_position,
        throughPosition: range.through_position,
      },
    );
  }
  invariant(
    range.from_position <= range.next_position &&
      range.next_position <= range.through_position,
    stream,
    "Sync page range moves backward or beyond its high-water position.",
    {
      fromPosition: range.from_position,
      nextPosition: range.next_position,
      throughPosition: range.through_position,
    },
  );
  invariant(range.item_count === positions.length, stream, "Sync page item count does not match its payload.", {
    itemCount: positions.length,
  });
  invariant(range.has_more === page.has_more, stream, "Sync page continuation markers disagree.");
  invariant(
    range.complete_through ===
      (!page.has_more && range.next_position === range.through_position),
    stream,
    "Sync page completion proof is inconsistent.",
  );

  if (positions.length === 0) {
    invariant(
      range.first_item_position === null && range.last_item_position === null,
      stream,
      "Empty sync page contains item boundaries.",
    );
    invariant(!page.has_more, stream, "An empty sync page cannot require a continuation.");
    invariant(
      range.next_position === range.through_position && range.complete_through,
      stream,
      "Empty sync page does not complete its fixed range.",
    );
    invariant(
      stream === "events" || range.from_position === range.next_position,
      stream,
      "Empty account page skipped a contiguous position range.",
    );
    return range;
  }

  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    invariant(itemPosition(position), stream, "Sync item has an invalid position.");
    const previous = index === 0 ? range.from_position : positions[index - 1];
    const expected = stream === "account" ? previous + 1 : undefined;
    if (position <= previous || (expected !== undefined && position !== expected)) {
      throw new SyncIntegrityError(
        stream,
        "position_discontinuity",
        stream === "account"
          ? "Account sync page skipped or repeated a durable position."
          : "Event sync page is not strictly commit ordered.",
        {
          expectedPosition: expected ?? previous + 1,
          observedPosition: position,
          fromPosition: range.from_position,
          nextPosition: range.next_position,
          throughPosition: range.through_position,
          itemCount: positions.length,
        },
      );
    }
    invariant(position <= range.next_position, stream, "Sync item lies beyond the page checkpoint.");
  }

  invariant(
    range.first_item_position === positions[0] &&
      range.last_item_position === positions[positions.length - 1],
    stream,
    "Sync page item boundaries do not match its payload.",
  );
  invariant(
    range.last_item_position === range.next_position ||
      (stream === "events" && !page.has_more && range.next_position === range.through_position),
    stream,
    "Sync page checkpoint does not cover its last item.",
  );
  invariant(
    !page.has_more || range.next_position < range.through_position,
    stream,
    "Sync page requests a continuation after reaching its high-water position.",
  );
  return range;
}

function normalizeStreamVector(value: unknown, label: string): StreamVectorPosition {
  invariant(value && typeof value === "object" && !Array.isArray(value), "events", `${label} vector is malformed.`);
  const raw = value as Partial<StreamVectorPosition>;
  invariant(safePosition(raw.floor), "events", `${label} vector has an invalid floor.`);
  invariant(raw.writers && typeof raw.writers === "object" && !Array.isArray(raw.writers), "events", `${label} vector has an invalid writer map.`);
  const entries = Object.entries(raw.writers);
  invariant(entries.length <= 64, "events", `${label} vector has too many writers.`);
  const writers: Record<string, number> = {};
  for (const [writer, position] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    invariant(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(writer), "events", `${label} vector has an invalid writer.`);
    invariant(safePosition(position) && position > raw.floor!, "events", `${label} vector is not canonical.`);
    writers[writer] = position;
  }
  return { floor: raw.floor!, writers };
}

export function validateStreamVectorPosition(value: unknown): StreamVectorPosition {
  return normalizeStreamVector(value, "Stored");
}

function vectorPositionFor(vector: StreamVectorPosition, writer: string): number {
  return vector.writers[writer] ?? vector.floor;
}

function vectorMaximum(vector: StreamVectorPosition): number {
  return Math.max(vector.floor, ...Object.values(vector.writers));
}

export function streamVectorIncludes(
  vector: StreamVectorPosition,
  writer: string,
  position: number,
): boolean {
  const normalized = normalizeStreamVector(vector, "Stored");
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(writer) &&
    safePosition(position) && position <= vectorPositionFor(normalized, writer);
}

export function streamVectorAdvanced(
  vector: StreamVectorPosition,
  writer: string,
  position: number,
): StreamVectorPosition {
  const normalized = normalizeStreamVector(vector, "Stored");
  invariant(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(writer), "events", "Event writer is invalid.");
  invariant(safePosition(position), "events", "Event writer position is invalid.");
  if (position <= vectorPositionFor(normalized, writer)) return normalized;
  return normalizeStreamVector({
    floor: normalized.floor,
    writers: { ...normalized.writers, [writer]: position },
  }, "Advanced");
}

export function streamVectorEqual(
  left: StreamVectorPosition | undefined,
  right: StreamVectorPosition | undefined,
): boolean {
  if (!left || !right) return left === right;
  const normalizedLeft = normalizeStreamVector(left, "Stored");
  const normalizedRight = normalizeStreamVector(right, "Stored");
  if (normalizedLeft.floor !== normalizedRight.floor) return false;
  const names = new Set([
    ...Object.keys(normalizedLeft.writers),
    ...Object.keys(normalizedRight.writers),
  ]);
  return [...names].every(
    (writer) => vectorPositionFor(normalizedLeft, writer) === vectorPositionFor(normalizedRight, writer),
  );
}

export function streamVectorBeforeOrEqual(
  left: StreamVectorPosition,
  right: StreamVectorPosition,
): boolean {
  const normalizedLeft = normalizeStreamVector(left, "Stored");
  const normalizedRight = normalizeStreamVector(right, "Stored");
  if (normalizedLeft.floor > normalizedRight.floor) return false;
  const names = new Set([
    ...Object.keys(normalizedLeft.writers),
    ...Object.keys(normalizedRight.writers),
  ]);
  return [...names].every(
    (writer) => vectorPositionFor(normalizedLeft, writer) <= vectorPositionFor(normalizedRight, writer),
  );
}

export function validateEventSyncPage(
  page: EventRangedPage & { frames: Array<{ type: "event"; room_id: string; event: Event }> },
  expectedFromPosition: number,
  expectedThroughPosition?: number,
  expectedFromVector?: StreamVectorPosition,
  expectedThroughVector?: StreamVectorPosition,
): ValidatedEventRange {
  invariant(Array.isArray(page?.frames), "events", "Event sync payload is not an array.");
  const positions = page.frames.map((frame) => {
    invariant(frame?.type === "event", "events", "Event sync payload contains a non-event frame.");
    invariant(typeof frame.room_id === "string" && frame.room_id.length > 0, "events", "Event sync frame has no room identity.");
    invariant(
      frame.event && typeof frame.event.event_id === "string" && frame.event.event_id.length === 26,
      "events",
      "Event sync frame has no event identity.",
    );
    return frame.event.stream_position as number;
  });
  if (!page.vector_range) {
    const range = validateSyncPageRange(
      "events",
      page as RangedPage,
      positions,
      expectedFromPosition,
      expectedThroughPosition,
    );
    return {
      ...range,
      from_vector: { floor: range.from_position, writers: {} },
      next_vector: { floor: range.next_position, writers: {} },
      through_vector: { floor: range.through_position, writers: {} },
    };
  }

  invariant(isNonBlankString(page.cursor), "events", "Sync page is missing its next signed cursor.");
  invariant(isNonBlankString(page.through), "events", "Sync page is missing its signed high-water cursor.");
  invariant(typeof page.has_more === "boolean", "events", "Sync page has an invalid continuation marker.");
  const vectorRange = page.vector_range;
  invariant(vectorRange.version === 1 && vectorRange.stream === "events", "events", "Event vector range has an unsupported version.");
  invariant(vectorRange.coverage === "authoritative_projection", "events", "Event vector range has an unsupported coverage mode.");
  const from = normalizeStreamVector(vectorRange.from, "From");
  const next = normalizeStreamVector(vectorRange.next, "Next");
  const through = normalizeStreamVector(vectorRange.through, "Through");
  const expectedFrom = expectedFromVector ?? { floor: expectedFromPosition, writers: {} };
  invariant(streamVectorEqual(from, expectedFrom), "events", "Event vector does not continue from the durable checkpoint.");
  if (expectedThroughVector || expectedThroughPosition !== undefined) {
    const expectedThrough = expectedThroughVector ?? {
      floor: expectedThroughPosition!,
      writers: {},
    };
    invariant(streamVectorEqual(through, expectedThrough), "events", "Event vector changed its fixed high-water checkpoint.");
  }
  invariant(streamVectorBeforeOrEqual(from, next), "events", "Event vector moved behind its submitted checkpoint.");
  invariant(streamVectorBeforeOrEqual(next, through), "events", "Event vector moved beyond its fixed boundary.");
  invariant(Array.isArray(vectorRange.items), "events", "Event vector items are malformed.");
  invariant(vectorRange.item_count === page.frames.length && vectorRange.items.length === page.frames.length, "events", "Event vector item count does not match its payload.");
  invariant(vectorRange.has_more === page.has_more, "events", "Event vector continuation markers disagree.");
  invariant(vectorRange.complete_through === !page.has_more, "events", "Event vector completion proof is inconsistent.");
  invariant(!page.has_more || !streamVectorEqual(next, through), "events", "Event vector requests continuation at its boundary.");
  invariant(page.has_more || streamVectorEqual(next, through), "events", "Terminal event vector does not complete its boundary.");
  let previous = -1;
  vectorRange.items.forEach((item, index) => {
    invariant(item && typeof item === "object", "events", "Event vector item is malformed.");
    invariant(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.writer), "events", "Event vector item has an invalid writer.");
    invariant(itemPosition(item.position), "events", "Event vector item has an invalid position.");
    invariant(item.position === positions[index], "events", "Event vector item does not match its frame.");
    invariant(item.position > previous, "events", "Event vector page is not numerically ordered.");
    invariant(item.position > vectorPositionFor(from, item.writer), "events", "Event vector repeated an already-covered event.");
    invariant(item.position <= vectorPositionFor(next, item.writer), "events", "Event vector checkpoint does not cover its event.");
    previous = item.position;
  });
  invariant(!page.has_more || page.frames.length > 0, "events", "Empty event vector page cannot require continuation.");
  return {
    stream: "events",
    from_position: from.floor,
    next_position: next.floor,
    through_position: through.floor,
    first_item_position: positions[0] ?? null,
    last_item_position: positions.at(-1) ?? null,
    item_count: positions.length,
    has_more: page.has_more,
    complete_through: !page.has_more,
    coverage: "authoritative_projection",
    from_vector: from,
    next_vector: next,
    through_vector: through,
  };
}

export function validateAccountSyncPage(
  page: RangedPage & { updates: AccountSyncUpdate[] },
  expectedFromPosition: number,
  expectedThroughPosition?: number,
): SyncPageRange {
  invariant(Array.isArray(page?.updates), "account", "Account sync payload is not an array.");
  for (const update of page.updates) {
    invariant(update && typeof update === "object", "account", "Account sync item is malformed.");
    invariant(
      typeof update.kind === "string" && update.kind.length > 0 && update.kind.length <= 64,
      "account",
      "Account sync item has an invalid kind.",
    );
    invariant(
      SUPPORTED_ACCOUNT_SYNC_KINDS.has(update.kind),
      "account",
      "Account sync item kind is unsupported by this client.",
    );
    invariant(
      typeof update.room_id === "string" &&
        typeof update.object_id === "string" &&
        update.data && typeof update.data === "object" && !Array.isArray(update.data) &&
        typeof update.created_at === "string" && Number.isFinite(Date.parse(update.created_at)),
      "account",
      "Account sync item has an invalid projection.",
    );
    if (update.kind === "draft") {
      invariant(
        typeof update.data.room_id === "string" && update.data.room_id.length > 0,
        "account",
        "Account sync draft has no room identity.",
      );
    }
    if (update.kind === "held_send") {
      invariant(
        typeof update.data.room_id === "string" && update.data.room_id.length > 0 &&
          typeof update.data.held_send_id === "string" && update.data.held_send_id.length > 0,
        "account",
        "Account sync held send has no stable identity.",
      );
    }
    if (update.kind === "room.list_preferences") {
      const preferences = update.data.preferences as Record<string, unknown> | undefined;
      invariant(
        update.data.room_id === update.room_id &&
          preferences && typeof preferences === "object" &&
          typeof preferences.pinned === "boolean" &&
          typeof preferences.archived === "boolean" &&
          Object.keys(preferences).length === 2 &&
          Object.keys(update.data).length === 2,
        "account",
        "Account room-list preferences are malformed.",
      );
    }
    if (update.kind === "client.operation") {
      invariant(
        validClientOperation(update.data) && update.data.operation_id === update.object_id &&
          update.data.room_id === update.room_id,
        "account",
        "Account client operation is malformed.",
      );
    }
    if (update.kind === "extend.request") {
      const sanitized = parseToolSetupAccountState(update.data, update.object_id);
      invariant(
        sanitized !== null,
        "account",
        "Account tool-setup request is malformed.",
      );
      // The validated page is subsequently committed to the durable account
      // projection ledger. Replace the row so legacy URLs never reach storage.
      update.data = sanitized as unknown as Record<string, unknown>;
    }
  }
  return validateSyncPageRange(
    "account",
    page,
    page.updates.map((update) => update?.position),
    expectedFromPosition,
    expectedThroughPosition,
  );
}

export type InitialContinuity = {
  event_position: number;
  event_vector?: StreamVectorPosition;
  account_position: number;
  complete_at_barrier: boolean;
};

export function validateInitialContinuity(value: unknown): InitialContinuity {
  invariant(value && typeof value === "object", "initial", "Initial snapshot has no continuity proof.");
  const continuity = value as InitialContinuity;
  invariant(
    safePosition(continuity.event_position) && safePosition(continuity.account_position),
    "initial",
    "Initial snapshot continuity positions are invalid.",
  );
  if (continuity.event_vector) {
    const vector = normalizeStreamVector(continuity.event_vector, "Initial");
    invariant(
      vector.floor === continuity.event_position,
      "initial",
      "Initial event vector does not match its compatibility position.",
    );
    continuity.event_vector = vector;
  }
  invariant(
    continuity.complete_at_barrier === true,
    "initial",
    "Initial snapshot is not complete at its declared barrier.",
  );
  return continuity;
}

export type InitialAccountManifest = {
  drafts: unknown[];
  held_sends: unknown[];
  operations: Array<Record<string, unknown>>;
  chat_preferences: { read_receipts_enabled: boolean };
  devices: Array<Record<string, unknown>>;
  blocks: Array<Record<string, unknown>>;
};

function isoTimestampOrEmpty(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === "string" &&
    ((allowEmpty && value === "") || Number.isFinite(Date.parse(value)));
}

function validClientOperation(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.operation_id === "string" && row.operation_id.length === 26 &&
    typeof row.room_id === "string" && row.room_id.length === 26 &&
    (row.kind === "event_send" || row.kind === "held_send") &&
    typeof row.client_id === "string" && row.client_id.length > 0 && row.client_id.length <= 128 &&
    typeof row.device_id === "string" && row.device_id.length <= 64 &&
    ["pending", "succeeded", "cancelled", "failed"].includes(String(row.state)) &&
    typeof row.resource_id === "string" && row.resource_id.length === 26 &&
    typeof row.result_event_id === "string" &&
    (row.result_event_id === "" || row.result_event_id.length === 26) &&
    row.http_status === 201 && isoTimestampOrEmpty(row.accepted_at, false) &&
    isoTimestampOrEmpty(row.terminal_at, true) && isoTimestampOrEmpty(row.expires_at, false) &&
    Object.keys(row).length === 12;
}

/** Validate complete account manifests before absence can be interpreted as
 * authoritative empty state. In particular, omitted device/block fields must
 * never silently revoke the client's durable projection. */
export function validateInitialAccountManifest(
  value: unknown,
): asserts value is InitialAccountManifest {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    "initial",
    "Initial snapshot has no account manifest.",
  );
  const manifest = value as Partial<InitialAccountManifest>;
  invariant(
    Array.isArray(manifest.drafts) &&
      Array.isArray(manifest.held_sends) &&
      Array.isArray(manifest.operations) &&
      Array.isArray(manifest.devices) &&
      Array.isArray(manifest.blocks),
    "initial",
    "Initial snapshot account manifests are incomplete.",
  );
  invariant(
    manifest.devices.every((device) =>
      device && typeof device === "object" && !Array.isArray(device) &&
      typeof device.device_id === "string" && device.device_id.length > 0 &&
      device.device_id.length <= 64 &&
      typeof device.platform === "string" && device.platform.length <= 16 &&
      typeof device.name === "string" && device.name.length <= 120 &&
      typeof device.app_version === "string" && device.app_version.length <= 64 &&
      device.capabilities && typeof device.capabilities === "object" &&
      !Array.isArray(device.capabilities) &&
      isoTimestampOrEmpty(device.created_at, false) &&
      isoTimestampOrEmpty(device.last_seen_at, false) &&
      isoTimestampOrEmpty(device.revoked_at, true)
    ) &&
      manifest.blocks.every((block) =>
        block && typeof block === "object" && !Array.isArray(block) &&
        (block.target_kind === "carbon" || block.target_kind === "silicon") &&
        typeof block.target_id === "string" && block.target_id.length > 0 &&
        block.target_id.length <= 64 &&
        isoTimestampOrEmpty(block.created_at, false)
      ),
    "initial",
    "Initial snapshot device or block manifest contains a malformed row.",
  );
  invariant(
    manifest.operations.every(validClientOperation) &&
      new Set(manifest.operations.map((operation) => operation.operation_id)).size ===
        manifest.operations.length,
    "initial",
    "Initial snapshot operation manifest contains a malformed or repeated row.",
  );
  const deviceIds = manifest.devices.map((device) => device.device_id as string);
  const blockIdentities = manifest.blocks.map((block) =>
    JSON.stringify([block.target_kind, block.target_id])
  );
  invariant(
    new Set(deviceIds).size === deviceIds.length &&
      new Set(blockIdentities).size === blockIdentities.length,
    "initial",
    "Initial snapshot device or block manifest repeats an identity.",
  );
  invariant(
    typeof manifest.chat_preferences?.read_receipts_enabled === "boolean",
    "initial",
    "Initial snapshot chat preferences are incomplete.",
  );
}

/** Observers receive exactly null; members receive exactly a complete
 * preference object at the initial barrier. */
export function validateInitialRoomNotificationProjection(
  room: Pick<Room, "observed" | "notification_preferences" | "unread_boundary" |
    "list_preferences" | "list_projection" | "last_event"> | null | undefined,
): void {
  invariant(room && typeof room === "object", "initial", "Initial snapshot room is malformed.");
  invariant(
    typeof room.observed === "boolean",
    "initial",
    "Initial snapshot room has no explicit observed membership flag.",
  );
  const preferences = room.notification_preferences;
  validateUnreadBoundary(room.unread_boundary);
  validateRoomListProjection(room.list_projection, room.last_event);
  if (room.observed === true) {
    invariant(
      preferences === null,
      "initial",
      "Initial snapshot exposed member notification preferences to an observed room.",
    );
    invariant(
      room.list_preferences === null,
      "initial",
      "Initial snapshot exposed member list preferences to an observed room.",
    );
    return;
  }
  invariant(
    preferences !== null,
    "initial",
    "Initial snapshot omitted notification preferences for a member room.",
  );
  invariant(
    preferences &&
      typeof preferences === "object" &&
      ["all", "mentions", "mute"].includes(preferences.mode) &&
      typeof preferences.mute_until === "string" &&
      typeof preferences.show_preview === "boolean" &&
      typeof preferences.sound === "boolean",
    "initial",
    "Initial snapshot room notification preferences are malformed.",
  );
  const listPreferences = room.list_preferences;
  invariant(
    listPreferences && typeof listPreferences === "object" &&
      typeof listPreferences.pinned === "boolean" &&
      typeof listPreferences.archived === "boolean" &&
      Object.keys(listPreferences).length === 2,
    "initial",
    "Initial snapshot room list preferences are malformed.",
  );
}

export function validateRoomListProjection(value: unknown, lastEvent: Room["last_event"]): void {
  invariant(value && typeof value === "object" && !Array.isArray(value), "initial",
    "Room has no complete list projection.");
  const projection = value as Record<string, unknown>;
  const draft = projection.draft as Record<string, unknown> | undefined;
  const held = projection.held as Record<string, unknown> | undefined;
  const through = projection.through_stream_position;
  const throughVector = projection.through_stream_vector
    ? normalizeStreamVector(projection.through_stream_vector, "Room list")
    : undefined;
  const activity = projection.activity_stream_position;
  invariant(
    projection.version === 1 && projection.complete === true &&
      Number.isSafeInteger(through) && Number(through) >= 0 &&
      Number.isSafeInteger(activity) && Number(activity) >= 0 && Number(activity) <= Number(through) &&
      typeof projection.activity_at === "string" &&
      ((activity === 0 && projection.activity_at === "") ||
        (Number(activity) > 0 && Number.isFinite(Date.parse(projection.activity_at as string)))),
    "initial", "Room list projection has invalid activity coverage.",
  );
  if (throughVector) {
    invariant(
      vectorMaximum(throughVector) === through,
      "initial",
      "Room list vector disagrees with its compatibility boundary.",
    );
  }
  invariant(
    draft && typeof draft.active === "boolean" && Number.isSafeInteger(draft.version) &&
      Number(draft.version) >= 0 && typeof draft.updated_at === "string" &&
      (draft.content_updated_at === undefined || typeof draft.content_updated_at === "string") &&
      (draft.active
        ? Number(draft.version) > 0 &&
          Number.isFinite(Date.parse(draft.updated_at as string)) &&
          (draft.content_updated_at === undefined ||
            draft.content_updated_at === "" ||
            Number.isFinite(Date.parse(draft.content_updated_at as string)))
        : draft.version === 0 && draft.updated_at === "" &&
          (draft.content_updated_at === undefined || draft.content_updated_at === "")),
    "initial", "Room list projection has invalid draft state.",
  );
  invariant(
    held && Number.isSafeInteger(held.active_count) && Number(held.active_count) >= 0 &&
      Number.isSafeInteger(held.attention_count) && Number(held.attention_count) >= 0 &&
      Number(held.attention_count) <= Number(held.active_count) &&
      typeof held.next_release_at === "string" &&
      (held.next_release_at === "" || Number.isFinite(Date.parse(held.next_release_at as string))),
    "initial", "Room list projection has invalid held-send state.",
  );
  if (lastEvent === null) {
    invariant(activity === 0, "initial", "Room list activity exists without a last event.");
  } else {
    invariant(
      Number.isSafeInteger(lastEvent?.stream_position) &&
        lastEvent?.stream_position === activity && lastEvent?.at === projection.activity_at,
      "initial", "Room list activity disagrees with its last event.",
    );
  }
}

/** A boundary is a complete fixed-barrier projection, never a best-effort
 * hint. Rejecting malformed cached/network state prevents a corrupt count from
 * silently moving the divider or clearing notifications. */
export function validateUnreadBoundary(value: unknown): void {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    "initial",
    "Room has no authoritative unread boundary.",
  );
  const boundary = value as Record<string, unknown>;
  const lastRead = boundary.last_read_stream_position;
  const lastReadVector = boundary.last_read_stream_vector
    ? normalizeStreamVector(boundary.last_read_stream_vector, "Last read")
    : undefined;
  const firstId = boundary.first_unread_event_id;
  const firstPosition = boundary.first_unread_stream_position;
  const firstWriter = boundary.first_unread_stream_writer;
  const count = boundary.unread_count;
  const through = boundary.through_stream_position;
  const throughVector = boundary.through_stream_vector
    ? normalizeStreamVector(boundary.through_stream_vector, "Unread")
    : undefined;
  invariant(
    Number.isSafeInteger(lastRead) && Number(lastRead) >= 0 &&
      Number.isSafeInteger(count) && Number(count) >= 0 &&
      Number.isSafeInteger(through) && Number(through) >= 0 &&
      Number(lastRead) <= Number(through),
    "initial",
    "Room unread boundary has invalid positions.",
  );
  if (throughVector) {
    invariant(
      vectorMaximum(throughVector) === through,
      "initial",
      "Unread vector disagrees with its compatibility boundary.",
    );
  }
  if (lastReadVector) {
    invariant(
      vectorMaximum(lastReadVector) === lastRead,
      "initial",
      "Last-read vector disagrees with its compatibility position.",
    );
  }
  const empty = count === 0;
  const firstAfterRead = lastReadVector && typeof firstWriter === "string"
    ? Number(firstPosition) > vectorPositionFor(lastReadVector, firstWriter)
    : Number(firstPosition) > Number(lastRead);
  invariant(
    empty
      ? firstId === null && firstPosition === null
      : typeof firstId === "string" && firstId.length === 26 &&
        Number.isSafeInteger(firstPosition) && firstAfterRead &&
        Number(firstPosition) <= Number(through) &&
        (firstWriter === undefined ||
          (typeof firstWriter === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(firstWriter))),
    "initial",
    "Room unread boundary has an inconsistent first-unread anchor.",
  );
}

export type HistoryTraversal = {
  throughEventId: string | null | undefined;
  seenEventIds: Set<string>;
  oldestEventId?: string;
};

/** Validate a room-history page before replacing its active opaque cursor. */
export function validateHistoryPage(
  page: HistoryPage,
  traversal: HistoryTraversal,
  roomId: string,
): HistoryTraversal {
  const details = { roomId };
  invariant(page && typeof page === "object", "history", "History response is missing.", details);
  invariant(Array.isArray(page.events), "history", "History response is not an event array.", details);
  invariant(page.direction === "backward", "history", "History response changed direction.", details);
  invariant(typeof page.has_more === "boolean", "history", "History response has an invalid continuation marker.", details);
  invariant(
    page.has_more
      ? isNonBlankString(page.cursor)
      : page.cursor === null,
    "history",
    "History cursor disagrees with its continuation marker.",
    details,
  );
  invariant(
    page.through_event_id === null || isNonBlankString(page.through_event_id),
    "history",
    "History response has an invalid high-water event.",
    details,
  );
  if (
    traversal.throughEventId !== undefined &&
    page.through_event_id !== traversal.throughEventId
  ) {
    throw new SyncIntegrityError(
      "history",
      "position_discontinuity",
      "History high-water event changed mid-traversal.",
      details,
    );
  }

  let previous = "";
  for (const event of page.events) {
    invariant(
      event && typeof event.event_id === "string" && event.event_id.length === 26,
      "history",
      "History event has an invalid identity.",
      details,
    );
    invariant(event.event_id > previous, "history", "History page is not chronological.", details);
    invariant(
      !traversal.seenEventIds.has(event.event_id),
      "history",
      "History traversal repeated an event.",
      details,
    );
    invariant(
      page.through_event_id === null || event.event_id <= page.through_event_id,
      "history",
      "History event lies beyond the fixed high-water event.",
      details,
    );
    previous = event.event_id;
  }
  if (traversal.oldestEventId && page.events.length > 0) {
    invariant(
      page.events[page.events.length - 1].event_id < traversal.oldestEventId,
      "history",
      "History continuation crossed or moved beyond its previous boundary.",
      details,
    );
  }
  invariant(
    page.events.length > 0 || !page.has_more,
    "history",
    "Empty history page cannot require a continuation.",
    details,
  );
  const seenEventIds = new Set(traversal.seenEventIds);
  for (const event of page.events) seenEventIds.add(event.event_id);
  return {
    throughEventId: page.through_event_id,
    seenEventIds,
    oldestEventId: page.events[0]?.event_id ?? traversal.oldestEventId,
  };
}
