import { isToolSetupRequestId } from "./tool-setup-request";

export const TOOL_SETUP_STATE_EVENT = "silicon-interface:tool-setup-state";

export type ToolSetupStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed"
  | "expired";

export type ToolSetupCompletionKind = "redirect" | "form" | "none";

export interface ToolSetupAssignment {
  request_id: string;
  team_id: string;
  team_slug: string;
  tool_id: string;
  tool_key: string;
  tool_name: string;
  integration_id: string;
  integration: string;
  integration_name: string;
  target_carbon_id: string;
  target_carbon_name: string;
  room_id: string | null;
  request_type: string;
  requested_scope: "carbon" | "team" | "silicon";
  note: string;
  status: ToolSetupStatus;
  completion_kind: ToolSetupCompletionKind;
  completion_schema: Record<string, unknown>;
  tool_enabled: boolean;
  will_enable_tool: boolean;
  connection_id: string | null;
  error_code: string;
  expires_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ToolSetupRequestResponse {
  request: unknown;
}

export interface ToolSetupStartResponse extends ToolSetupRequestResponse {
  connect_url?: unknown;
}

export interface ToolSetupStartPayload {
  label?: string;
  fields?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  restart?: true;
}

export type ToolSetupFieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean";

export interface ToolSetupFieldOption {
  token: string;
  label: string;
  value: string | number | boolean | null;
}

export interface ToolSetupField {
  key: string;
  label: string;
  description: string;
  kind: ToolSetupFieldKind;
  format: string;
  required: boolean;
  secret: boolean;
  options: ToolSetupFieldOption[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export type ToolSetupFieldValues = Record<string, string | boolean>;

const STATUSES = new Set<ToolSetupStatus>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "failed",
  "expired",
]);
const COMPLETION_KINDS = new Set<ToolSetupCompletionKind>([
  "redirect",
  "form",
  "none",
]);
const SCOPES = new Set<ToolSetupAssignment["requested_scope"]>([
  "carbon",
  "team",
  "silicon",
]);
const FIELD_KINDS = new Set<ToolSetupFieldKind>([
  "string",
  "number",
  "integer",
  "boolean",
]);
const UNSAFE_FIELD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONNECTION_SCHEMA_ROOT_KEYS = new Set([
  "additionalProperties",
  "description",
  "properties",
  "required",
  "title",
  "type",
]);
const CONNECTION_SCHEMA_FIELD_KEYS = new Set([
  "description",
  "enum",
  "format",
  "maxLength",
  "maximum",
  "minLength",
  "minimum",
  "title",
  "type",
  "writeOnly",
]);
const ASSIGNMENT_KEYS = new Set([
  "request_id",
  "team",
  "team_slug",
  "team_id",
  "tool_id",
  "tool_key",
  "tool_name",
  "integration_id",
  "integration",
  "integration_name",
  "requester_kind",
  "requested_by_kind",
  "requester_id",
  "requested_by_id",
  "requester_name",
  "requested_by_name",
  "target_carbon_id",
  "target_carbon_name",
  "room_id",
  "request_type",
  "completion_kind",
  "completion_schema",
  "tool_enabled",
  "will_enable_tool",
  "requested_scope",
  "client_id",
  "note",
  "status",
  "connection_id",
  "error_code",
  "expires_at",
  "completed_at",
  "cancelled_at",
  "created_at",
  "updated_at",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maximum = 500): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  return value.trim();
}

function requiredText(value: unknown, maximum = 500): string | null {
  const valueText = text(value, maximum);
  return valueText ? valueText : null;
}

function nullableText(value: unknown, maximum = 500): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return text(value, maximum) ?? undefined;
}

/**
 * Connection setup deliberately implements a small, flat JSON Schema subset.
 * Rejecting every unrecognized keyword keeps the browser and Glass secret
 * classifiers identical; references/applicators must never be able to hide a
 * credential-bearing child schema.
 */
function connectionSchemaSubsetIssue(schema: unknown): string | null {
  const root = record(schema);
  if (!root) return "This integration has no usable setup schema.";
  try {
    if (new TextEncoder().encode(JSON.stringify(root)).byteLength > 64_000) {
      return "This setup form is too large for Interface.";
    }
  } catch {
    return "This setup form is invalid.";
  }
  if (Object.keys(root).some((key) => !CONNECTION_SCHEMA_ROOT_KEYS.has(key))) {
    return "This setup form uses unsupported JSON Schema features.";
  }
  if (root.type !== "object") {
    return "This setup form must use an object schema.";
  }
  for (const [annotation, maximum] of [
    ["title", 120],
    ["description", 500],
  ] as const) {
    const value = root[annotation];
    if (
      value !== undefined
      && (typeof value !== "string" || value.length > maximum)
    ) {
      return "This setup form contains an invalid annotation.";
    }
  }
  if (
    root.additionalProperties !== undefined
    && typeof root.additionalProperties !== "boolean"
  ) {
    return "This setup form uses unsupported additional properties.";
  }
  const properties = record(root.properties);
  if (!properties) return "This integration has no usable setup schema.";
  if (Object.keys(properties).length > 64) {
    return "This setup form has too many fields.";
  }
  const required = root.required === undefined ? [] : root.required;
  if (
    !Array.isArray(required)
    || required.length > 64
    || required.some((key) => typeof key !== "string")
    || new Set(required).size !== required.length
    || required.some((key) => !Object.hasOwn(properties, key))
  ) {
    return "This setup form has invalid required fields.";
  }
  for (const [key, raw] of Object.entries(properties)) {
    const specification = record(raw);
    if (
      !specification
      || !key
      || key.length > 120
      || UNSAFE_FIELD_KEYS.has(key)
      || Object.keys(specification).some(
        (keyword) => !CONNECTION_SCHEMA_FIELD_KEYS.has(keyword),
      )
      || typeof specification.type !== "string"
      || !FIELD_KINDS.has(specification.type as ToolSetupFieldKind)
    ) {
      return "This setup form contains an unsupported field schema.";
    }
    for (const [annotation, maximum] of [
      ["title", 120],
      ["description", 500],
      ["format", 64],
    ] as const) {
      const value = specification[annotation];
      if (
        value !== undefined
        && (typeof value !== "string" || value.length > maximum)
      ) {
        return "This setup form contains an invalid field annotation.";
      }
    }
    if (
      specification.writeOnly !== undefined
      && typeof specification.writeOnly !== "boolean"
    ) {
      return "This setup form contains an invalid secret marker.";
    }
    for (const bound of ["minimum", "maximum"] as const) {
      const value = specification[bound];
      if (
        value !== undefined
        && (typeof value !== "number" || !Number.isFinite(value))
      ) {
        return "This setup form contains an invalid numeric bound.";
      }
    }
    for (const bound of ["minLength", "maxLength"] as const) {
      const value = specification[bound];
      if (
        value !== undefined
        && (
          typeof value !== "number"
          || !Number.isInteger(value)
          || value < 0
          || value > 1_000_000
        )
      ) {
        return "This setup form contains an invalid length bound.";
      }
    }
    const options = specification.enum;
    if (
      options !== undefined
      && (
        !Array.isArray(options)
        || options.length > 100
        || options.some(
          (value) => value !== null
            && typeof value !== "string"
            && typeof value !== "boolean"
            && (typeof value !== "number" || !Number.isFinite(value)),
        )
      )
    ) {
      return "This setup form contains an invalid choice list.";
    }
    const format = typeof specification.format === "string"
      ? specification.format
      : "";
    if (options !== undefined && isSecretField(key, specification, format)) {
      return "A secret setup field cannot contain preset choices.";
    }
  }
  return null;
}

/**
 * Clone only the public, closed v1 JSON Schema subset. Account projections are
 * persisted, so unsupported legacy schemas are replaced with an empty object
 * before a validated assignment can enter the durable ledger.
 */
export function sanitizeToolSetupSchema(schema: unknown): Record<string, unknown> {
  const root = record(schema);
  if (!root || connectionSchemaSubsetIssue(root)) return {};
  let serialized = "";
  try {
    serialized = JSON.stringify(root);
  } catch {
    return {};
  }
  if (!serialized || serialized.length > 64_000) return {};

  let cloned: Record<string, unknown>;
  try {
    cloned = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return {};
  }
  return cloned;
}

/**
 * Validate the request-specific server response before allowing it to drive a
 * credential form or external OAuth navigation. In particular, request IDs
 * must match the event/query that initiated the fetch and response payloads
 * must not smuggle Glass/provider navigation fields.
 */
export function parseToolSetupAssignment(
  value: unknown,
  expectedRequestId: string,
): ToolSetupAssignment | null {
  const row = record(value);
  if (
    !row
    || !isToolSetupRequestId(expectedRequestId)
    || row.request_id !== expectedRequestId
    || Object.keys(row).some((key) => !ASSIGNMENT_KEYS.has(key))
    || row.setup_url !== undefined
    || row.completion_url !== undefined
    || typeof row.tool_enabled !== "boolean"
    || typeof row.will_enable_tool !== "boolean"
  ) {
    return null;
  }

  const status =
    typeof row.status === "string" && STATUSES.has(row.status as ToolSetupStatus)
      ? row.status as ToolSetupStatus
      : null;
  const completionKind =
    typeof row.completion_kind === "string"
      && COMPLETION_KINDS.has(row.completion_kind as ToolSetupCompletionKind)
      ? row.completion_kind as ToolSetupCompletionKind
      : null;
  const requestedScope =
    typeof row.requested_scope === "string"
      && SCOPES.has(row.requested_scope as ToolSetupAssignment["requested_scope"])
      ? row.requested_scope as ToolSetupAssignment["requested_scope"]
      : null;
  const completionSchema = record(row.completion_schema);
  const roomId = nullableText(row.room_id, 64);
  const connectionId = nullableText(row.connection_id, 64);
  const expiresAt = nullableText(row.expires_at, 64);
  const completedAt = nullableText(row.completed_at, 64);
  const cancelledAt = nullableText(row.cancelled_at, 64);
  const createdAt = nullableText(row.created_at, 64);
  const updatedAt = nullableText(row.updated_at, 64);

  const required = {
    team_id: requiredText(row.team_id, 64),
    team_slug: requiredText(row.team_slug, 120),
    tool_id: requiredText(row.tool_id, 64),
    tool_key: requiredText(row.tool_key, 240),
    tool_name: requiredText(row.tool_name, 160),
    integration_id: requiredText(row.integration_id, 64),
    integration: requiredText(row.integration, 120),
    integration_name: requiredText(row.integration_name, 120),
    target_carbon_id: requiredText(row.target_carbon_id, 64),
    target_carbon_name: requiredText(row.target_carbon_name, 120),
    request_type: requiredText(row.request_type, 24),
  };
  const note = text(row.note ?? "", 500);
  const errorCode = text(row.error_code ?? "", 64);

  if (
    Object.values(required).some((item) => !item)
    || !status
    || !completionKind
    || !requestedScope
    || !completionSchema
    || note === null
    || errorCode === null
    || roomId === undefined
    || connectionId === undefined
    || expiresAt === undefined
    || completedAt === undefined
    || cancelledAt === undefined
    || createdAt === undefined
    || updatedAt === undefined
  ) {
    return null;
  }

  return {
    request_id: expectedRequestId,
    team_id: required.team_id!,
    team_slug: required.team_slug!,
    tool_id: required.tool_id!,
    tool_key: required.tool_key!,
    tool_name: required.tool_name!,
    integration_id: required.integration_id!,
    integration: required.integration!,
    integration_name: required.integration_name!,
    target_carbon_id: required.target_carbon_id!,
    target_carbon_name: required.target_carbon_name!,
    room_id: roomId,
    request_type: required.request_type!,
    requested_scope: requestedScope,
    note,
    status,
    completion_kind: completionKind,
    completion_schema: completionSchema,
    tool_enabled: row.tool_enabled,
    will_enable_tool: row.will_enable_tool,
    connection_id: connectionId,
    error_code: errorCode,
    expires_at: expiresAt,
    completed_at: completedAt,
    cancelled_at: cancelledAt,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * Durable account history can outlive a rolling deployment. Old request
 * projections carried Glass navigation fields and predate the enablement
 * disclosure booleans. Strip those fields before validation and persistence;
 * this compatibility path is never used for an HTTP response that can trigger
 * setup or navigation.
 */
export function parseToolSetupAccountState(
  value: unknown,
  expectedRequestId: string,
): ToolSetupAssignment | null {
  const row = record(value);
  if (!row) return null;
  const sanitized: Record<string, unknown> = { ...row };
  delete sanitized.setup_url;
  delete sanitized.completion_url;
  sanitized.completion_schema = sanitizeToolSetupSchema(sanitized.completion_schema);
  if (typeof sanitized.tool_enabled !== "boolean") sanitized.tool_enabled = true;
  if (typeof sanitized.will_enable_tool !== "boolean") sanitized.will_enable_tool = false;
  return parseToolSetupAssignment(sanitized, expectedRequestId);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function fieldKind(value: unknown): ToolSetupFieldKind {
  return typeof value === "string" && FIELD_KINDS.has(value as ToolSetupFieldKind)
    ? value as ToolSetupFieldKind
    : "string";
}

function optionLabel(value: ToolSetupFieldOption["value"]): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function isSecretField(
  key: string,
  specification: Record<string, unknown>,
  format: string,
): boolean {
  const normalizedKey = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return specification.writeOnly === true
    || format.toLowerCase() === "password"
    || /(?:^|[_-])(api[_-]?)?(?:key|secret|token|password)(?:$|[_-])/i.test(normalizedKey);
}

/**
 * Return a safe, user-facing reason when the server schema cannot be rendered
 * without silently dropping required input or exposing a secret preset.
 */
export function toolSetupSchemaIssue(schema: unknown): string | null {
  const root = record(schema);
  const properties = record(root?.properties);
  const subsetIssue = connectionSchemaSubsetIssue(root);
  if (subsetIssue) return subsetIssue;
  if (!root || !properties) return "This integration has no usable setup schema.";
  try {
    if (JSON.stringify(root).length > 64_000) {
      return "This setup form is too large for Interface.";
    }
  } catch {
    return "This setup form is invalid.";
  }
  const entries = Object.entries(properties);
  if (entries.length > 64) return "This setup form has too many fields.";
  const requiredValues = Array.isArray(root.required) ? root.required : [];
  if (
    requiredValues.length > 64
    || requiredValues.some((value) => typeof value !== "string")
  ) {
    return "This setup form has invalid required fields.";
  }
  const required = new Set(requiredValues as string[]);
  for (const key of required) {
    const specification = record(properties[key]);
    if (
      !specification
      || !key
      || key.length > 120
      || UNSAFE_FIELD_KEYS.has(key)
    ) {
      return "This setup form contains an unsupported required field.";
    }
    if (
      specification.type !== undefined
      && (
        typeof specification.type !== "string"
        || !FIELD_KINDS.has(specification.type as ToolSetupFieldKind)
      )
    ) {
      return `The required field “${key}” uses an unsupported type.`;
    }
    const format = text(specification.format ?? "", 64) ?? "";
    const secret = isSecretField(key, specification, format);
    if (
      secret
      && (
        fieldKind(specification.type) !== "string"
        || Array.isArray(specification.enum)
      )
    ) {
      return `The required secret field “${key}” cannot be displayed safely.`;
    }
  }
  return null;
}

/**
 * Convert the intentionally supported JSON Schema subset into bounded native
 * form fields. Unsupported/unsafe property names are omitted and the backend
 * remains authoritative for complete Draft 2020-12 validation.
 */
export function toolSetupFields(schema: unknown): ToolSetupField[] {
  const root = record(schema);
  const properties = record(root?.properties);
  if (!root || !properties || connectionSchemaSubsetIssue(root)) return [];
  const required = new Set(
    Array.isArray(root.required)
      ? root.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  return Object.entries(properties).slice(0, 64).flatMap(([key, raw]) => {
    const specification = record(raw);
    if (
      !specification
      || !key
      || key.length > 120
      || UNSAFE_FIELD_KEYS.has(key)
    ) {
      return [];
    }
    const kind = fieldKind(specification.type);
    const format = text(specification.format ?? "", 64) ?? "";
    const options: ToolSetupFieldOption[] = Array.isArray(specification.enum)
      ? specification.enum.slice(0, 100).flatMap((value, index) => {
        if (
          value !== null
          && typeof value !== "string"
          && typeof value !== "number"
          && typeof value !== "boolean"
        ) {
          return [];
        }
        return [{
          token: String(index),
          label: optionLabel(value),
          value,
        }];
      })
      : [];
    const secret = isSecretField(key, specification, format);
    if (
      (specification.type !== undefined
        && (
          typeof specification.type !== "string"
          || !FIELD_KINDS.has(specification.type as ToolSetupFieldKind)
        ))
      || (secret && (kind !== "string" || options.length > 0))
    ) {
      return [];
    }

    return [{
      key,
      label:
        requiredText(specification.title, 120)
        ?? key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      description: text(specification.description ?? "", 500) ?? "",
      kind,
      format,
      required: required.has(key),
      secret,
      options,
      minimum: finiteNumber(specification.minimum),
      maximum: finiteNumber(specification.maximum),
      minLength: finiteInteger(specification.minLength),
      maxLength: finiteInteger(specification.maxLength),
    }];
  });
}

export function initialToolSetupFieldValues(
  fields: readonly ToolSetupField[],
): ToolSetupFieldValues {
  const values: ToolSetupFieldValues = Object.create(null) as ToolSetupFieldValues;
  for (const field of fields) {
    values[field.key] = field.kind === "boolean" ? false : "";
  }
  return values;
}

export function serializeToolSetupFields(
  fields: readonly ToolSetupField[],
  values: ToolSetupFieldValues,
): { fields: Record<string, unknown> } | { error: string } {
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const field of fields) {
    const raw = values[field.key];
    if (field.kind === "boolean") {
      if (field.required || raw === true) output[field.key] = raw === true;
      continue;
    }
    const value = typeof raw === "string" ? raw : "";
    if (!value) {
      if (field.required) return { error: `${field.label} is required.` };
      continue;
    }
    if (field.options.length) {
      const option = field.options.find((item) => item.token === value);
      if (!option) return { error: `Choose a valid ${field.label}.` };
      output[field.key] = option.value;
      continue;
    }
    if (field.kind === "number" || field.kind === "integer") {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number))) {
        return {
          error: `${field.label} must be ${field.kind === "integer" ? "a whole number" : "a number"}.`,
        };
      }
      output[field.key] = number;
      continue;
    }
    output[field.key] = value;
  }

  return { fields: output };
}

export function safeToolSetupConnectUrl(
  value: unknown,
  allowLoopbackHttp = process.env.NODE_ENV !== "production",
): string | null {
  if (
    typeof value !== "string"
    || !/^https?:\/\//i.test(value)
    || /[\u0000-\u001F\u007F\\]/.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const protocolAllowed =
      url.protocol === "https:"
      || (allowLoopbackHttp && url.protocol === "http:" && loopback);
    if (!protocolAllowed || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function toolSetupCanStart(assignment: ToolSetupAssignment): boolean {
  if (!assignment.tool_enabled && !assignment.will_enable_tool) return false;
  return assignment.status === "pending"
    || (assignment.status === "failed" && assignment.completion_kind === "redirect");
}

export function toolSetupCanCancel(assignment: ToolSetupAssignment): boolean {
  return !["completed", "cancelled", "expired"].includes(assignment.status);
}
