export const TOOL_SETUP_REQUEST_MESSAGE_TYPE = "tool_setup_request";
export const TOOL_SETUP_REQUEST_SCHEMA_VERSION = 1;

const REQUEST_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TEAM_SLUG_RE = /^[A-Za-z0-9_-]{1,120}$/;
const REQUEST_TYPES = new Set([
  "connection",
  "configuration",
  "reauthentication",
  "account_selection",
]);
const REQUEST_SCOPES = new Set(["carbon", "team", "silicon"]);
const CONTENT_KEYS = new Set([
  "message_type",
  "schema_version",
  "body",
  "request_id",
  "team_id",
  "team_slug",
  "team_name",
  "tool_id",
  "tool_key",
  "tool_name",
  "integration_id",
  "integration_key",
  "integration_name",
  "request_type",
  "requested_scope",
  "note",
  // Rolling-deploy compatibility only. The value is deliberately discarded;
  // Interface never renders or follows it.
  "setup_url",
]);

export interface ToolSetupRequestMessage {
  body: string;
  requestId: string;
  teamSlug: string;
  teamName: string;
  toolName: string;
  toolKey: string;
  integrationName: string;
  note: string;
  requestType: string;
  requestedScope: string;
}

export interface ToolSetupRequestEventLike {
  type?: unknown;
  sender_kind?: unknown;
  content?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(
  value: unknown,
  maximum: number,
  required = false,
): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  const text = value.trim();
  if (required && !text) return null;
  return text;
}

export function isToolSetupRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_RE.test(value);
}

/**
 * Parse the deliberately small semantic payload carried by an ordinary
 * `m.text` event. There is intentionally no URL in this contract: the card
 * opens Interface's request-scoped setup dialog and the authenticated API
 * decides whether the signed-in Carbon is the assigned person.
 *
 * Returning null is a security and rolling-deploy boundary. Callers render the
 * compatibility `body` through the ordinary text path whenever the event is
 * forwarded, malformed, from the wrong sender kind, or contains an unexpected
 * action field. The one legacy `setup_url` key is recognized but discarded.
 */
export function parseToolSetupRequest(value: unknown): ToolSetupRequestMessage | null {
  const content = record(value);
  if (
    !content
    || content.message_type !== TOOL_SETUP_REQUEST_MESSAGE_TYPE
    || content.schema_version !== TOOL_SETUP_REQUEST_SCHEMA_VERSION
    || Object.keys(content).some((key) => !CONTENT_KEYS.has(key))
    || (
      content.setup_url !== undefined
      && (typeof content.setup_url !== "string" || content.setup_url.length > 2_048)
    )
  ) {
    return null;
  }

  const body = boundedText(content.body, 4_096, true);
  const requestId = isToolSetupRequestId(content.request_id)
    ? content.request_id
    : null;
  const teamSlug =
    typeof content.team_slug === "string" && TEAM_SLUG_RE.test(content.team_slug)
      ? content.team_slug
      : null;
  const teamName = boundedText(content.team_name, 120, true);
  const toolName = boundedText(content.tool_name, 160, true);
  const toolKey = boundedText(content.tool_key, 240, true);
  const integrationName = boundedText(content.integration_name, 120, true);
  const note = boundedText(content.note ?? "", 500);
  const requestType =
    typeof content.request_type === "string" && REQUEST_TYPES.has(content.request_type)
      ? content.request_type
      : null;
  const requestedScope =
    typeof content.requested_scope === "string" && REQUEST_SCOPES.has(content.requested_scope)
      ? content.requested_scope
      : null;

  if (
    !body
    || !requestId
    || !teamSlug
    || !teamName
    || !toolName
    || !toolKey
    || !integrationName
    || note === null
    || !requestType
    || !requestedScope
  ) {
    return null;
  }

  return {
    body,
    requestId,
    teamSlug,
    teamName,
    toolName,
    toolKey,
    integrationName,
    note,
    requestType,
    requestedScope,
  };
}

/**
 * Carbon-authored lookalikes remain ordinary text. Glass authenticates event
 * authorship and separately authorizes the request-scoped API; both checks are
 * required before Interface exposes a setup affordance.
 */
export function toolSetupRequestFromEvent(
  event: ToolSetupRequestEventLike,
): ToolSetupRequestMessage | null {
  if (event.type !== "m.text" || event.sender_kind !== "silicon") return null;
  return parseToolSetupRequest(event.content);
}
