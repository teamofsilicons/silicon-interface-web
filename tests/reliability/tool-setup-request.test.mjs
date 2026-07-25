import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  parseToolSetupRequest,
  toolSetupRequestFromEvent,
} from "../../src/lib/tool-setup-request.ts";
import {
  initialToolSetupFieldValues,
  parseToolSetupAccountState,
  parseToolSetupAssignment,
  safeToolSetupConnectUrl,
  sanitizeToolSetupSchema,
  serializeToolSetupFields,
  toolSetupCanStart,
  toolSetupFields,
  toolSetupSchemaIssue,
} from "../../src/lib/tool-setup.ts";
import { validateAccountSyncPage } from "../../src/lib/sync-integrity.ts";

const requestId = "01K1ABCDEF0123456789GHJKMN";
const content = {
  message_type: "tool_setup_request",
  schema_version: 1,
  body: "Gmail needs a connected account before I can continue.",
  request_id: requestId,
  team_id: "01K1TEAMDEMO123456789GHJKM",
  team_slug: "product",
  team_name: "Product",
  tool_id: "01K1TOOLDEMO123456789GHJKM",
  tool_key: "gmail.send_email",
  tool_name: "Send email",
  integration_id: "01K1INTDEMO0123456789GHJKM",
  integration_key: "gmail",
  integration_name: "Gmail",
  request_type: "connection",
  requested_scope: "carbon",
  note: "Connect your inbox.",
};

const assignment = {
  request_id: requestId,
  team_slug: "product",
  team_id: content.team_id,
  tool_id: content.tool_id,
  tool_key: content.tool_key,
  tool_name: content.tool_name,
  integration_id: content.integration_id,
  integration: "gmail",
  integration_name: content.integration_name,
  target_carbon_id: "carbon-alice",
  target_carbon_name: "Alice",
  room_id: "01K1ROOMDEMO123456789GHJKM",
  request_type: "connection",
  requested_scope: "carbon",
  note: content.note,
  status: "pending",
  completion_kind: "form",
  completion_schema: {
    type: "object",
    properties: {
      base_url: {
        type: "string",
        format: "uri",
        title: "API URL",
      },
      secret: {
        type: "string",
        writeOnly: true,
        title: "API key",
      },
      region: {
        type: "string",
        enum: ["us", "eu"],
      },
      retries: {
        type: "integer",
        minimum: 0,
      },
    },
    required: ["secret", "region"],
    additionalProperties: false,
  },
  tool_enabled: true,
  will_enable_tool: false,
  connection_id: null,
  error_code: "",
  expires_at: "2026-07-24T00:00:00Z",
  completed_at: null,
  cancelled_at: null,
  created_at: "2026-07-23T00:00:00Z",
  updated_at: "2026-07-23T00:00:00Z",
};

test("a Silicon-authored request parses as an Interface-native semantic card", () => {
  assert.deepEqual(
    toolSetupRequestFromEvent({
      type: "m.text",
      sender_kind: "silicon",
      content,
    }),
    {
      body: content.body,
      requestId: content.request_id,
      teamSlug: content.team_slug,
      teamName: content.team_name,
      toolName: content.tool_name,
      toolKey: content.tool_key,
      integrationName: content.integration_name,
      note: content.note,
      requestType: content.request_type,
      requestedScope: content.requested_scope,
    },
  );
  assert.equal(
    parseToolSetupRequest({ ...content, tool_name: "T".repeat(160) })?.toolName.length,
    160,
  );
  assert.equal(
    parseToolSetupRequest({ ...content, tool_name: "T".repeat(161) }),
    null,
  );
});

test("lookalikes, forwarded events, old Glass links, and malformed payloads remain text", () => {
  assert.equal(
    toolSetupRequestFromEvent({
      type: "m.text",
      sender_kind: "carbon",
      content,
    }),
    null,
  );
  assert.equal(
    toolSetupRequestFromEvent({
      type: "m.image",
      sender_kind: "silicon",
      content,
    }),
    null,
  );
  assert.deepEqual(
    parseToolSetupRequest({
      ...content,
      setup_url: "https://glass.example/glass/#team/product/extend",
    }),
    parseToolSetupRequest(content),
  );
  assert.equal(
    parseToolSetupRequest({ ...content, setup_url: { href: "https://glass.example" } }),
    null,
  );
  for (const malformed of [
    { ...content, schema_version: "1" },
    { ...content, request_id: "not-a-request-id" },
    { ...content, tool_name: null },
    { ...content, requested_scope: "global" },
    { ...content, request_type: "execute" },
    { ...content, forward_from: { sender_handle: "another-silicon" } },
    { ...content, completion_url: "https://provider.example/oauth" },
  ]) {
    assert.equal(parseToolSetupRequest(malformed), null);
  }

  const malformed = { ...content, request_id: "" };
  assert.equal(parseToolSetupRequest(malformed), null);
  assert.equal(malformed.body, content.body);
});

test("assigned request responses are exact-request bound and cannot supply navigation", () => {
  assert.deepEqual(
    parseToolSetupAssignment(assignment, requestId),
    assignment,
  );
  assert.equal(
    parseToolSetupAssignment(
      { ...assignment, request_id: "01K1OTHER000123456789GHJKMN" },
      requestId,
    ),
    null,
  );
  assert.equal(
    parseToolSetupAssignment(
      { ...assignment, setup_url: "https://glass.example/glass/" },
      requestId,
    ),
    null,
  );
  assert.equal(
    parseToolSetupAssignment(
      { ...assignment, completion_url: "https://provider.example/oauth" },
      requestId,
    ),
    null,
  );
  for (const sensitiveKey of [
    "connect_url",
    "credentials",
    "fields",
    "config",
    "provider_state",
    "secret_ciphertext",
  ]) {
    assert.equal(
      parseToolSetupAssignment(
        { ...assignment, [sensitiveKey]: { secret: "must-not-persist" } },
        requestId,
      ),
      null,
      sensitiveKey,
    );
  }
  assert.equal(
    parseToolSetupAssignment({ ...assignment, completion_kind: "html" }, requestId),
    null,
  );
  assert.equal(
    parseToolSetupAssignment({ ...assignment, will_enable_tool: "yes" }, requestId),
    null,
  );
  assert.equal(
    toolSetupCanStart({
      ...assignment,
      tool_enabled: false,
      will_enable_tool: false,
    }),
    false,
  );
  assert.equal(
    toolSetupCanStart({
      ...assignment,
      tool_enabled: false,
      will_enable_tool: true,
    }),
    true,
  );
});

test("native connection schema becomes bounded typed fields and secrets serialize once", () => {
  const fields = toolSetupFields(assignment.completion_schema);
  assert.deepEqual(fields.map((field) => field.key), [
    "base_url",
    "secret",
    "region",
    "retries",
  ]);
  assert.equal(fields.find((field) => field.key === "secret")?.secret, true);
  assert.equal(fields.find((field) => field.key === "region")?.options.length, 2);

  const values = initialToolSetupFieldValues(fields);
  values.base_url = "https://api.example";
  values.secret = "write-only";
  values.region = "1";
  values.retries = "3";
  const serialized = serializeToolSetupFields(fields, values);
  assert.ok("fields" in serialized);
  assert.deepEqual({ ...serialized.fields }, {
    base_url: "https://api.example",
    secret: "write-only",
    region: "eu",
    retries: 3,
  });
  assert.deepEqual(
    serializeToolSetupFields(fields, { ...values, retries: "3.5" }),
    { error: "Retries must be a whole number." },
  );

  const poisoned = {
    type: "object",
    properties: JSON.parse('{"__proto__":{"type":"string"},"safe":{"type":"string"}}'),
  };
  assert.deepEqual(toolSetupFields(poisoned), []);
  const camelCaseSecrets = toolSetupFields({
    type: "object",
    properties: {
      clientSecret: { type: "string" },
      accessToken: { type: "string" },
      apiKey: { type: "string" },
      credential: { type: "string", format: "PASSWORD" },
    },
  });
  assert.equal(camelCaseSecrets.every((field) => field.secret), true);

  const nestedSecretSchema = {
    type: "object",
    properties: {
      settings: {
        type: "object",
        properties: {
          endpoint: { type: "string" },
          accessToken: { type: "string" },
        },
        required: ["accessToken"],
      },
    },
    required: ["settings"],
  };
  assert.match(
    toolSetupSchemaIssue(nestedSecretSchema) ?? "",
    /unsupported field schema|cannot be displayed safely/,
  );
  assert.deepEqual(toolSetupFields(nestedSecretSchema), []);

  const safeProjection = sanitizeToolSetupSchema({
    type: "object",
    properties: {
      clientSecret: {
        type: "string",
        writeOnly: true,
      },
      publicRegion: {
        type: "string",
        enum: ["us", "eu"],
      },
    },
  });
  assert.deepEqual(safeProjection.properties.clientSecret, {
    type: "string",
    writeOnly: true,
  });
  assert.deepEqual(safeProjection.properties.publicRegion, {
    type: "string",
    enum: ["us", "eu"],
  });

  for (const unsupported of [
    {
      type: "object",
      properties: {
        credential: { $ref: "#/$defs/secret" },
      },
      $defs: {
        secret: { type: "string", writeOnly: true },
      },
    },
    {
      type: "object",
      properties: {
        vault: {
          type: "object",
          writeOnly: true,
          properties: {
            value: {
              type: "string",
              default: "nested-persisted-default",
            },
          },
        },
      },
    },
    {
      type: "object",
      properties: {
        credential: {
          type: "object",
          patternProperties: {
            ".*": { type: "string", writeOnly: true },
          },
        },
      },
    },
    {
      type: "object",
      properties: {
        accessToken: {
          type: "string",
          writeOnly: true,
          default: "must-never-persist",
        },
      },
    },
  ]) {
    assert.match(
      toolSetupSchemaIssue(unsupported) ?? "",
      /unsupported JSON Schema|unsupported field schema/,
    );
    assert.deepEqual(toolSetupFields(unsupported), []);
    assert.deepEqual(sanitizeToolSetupSchema(unsupported), {});
  }
});

test("provider navigation requires HTTPS, with opt-in development loopback only", () => {
  assert.equal(
    safeToolSetupConnectUrl("https://connect.composio.dev/link?a=1", false),
    "https://connect.composio.dev/link?a=1",
  );
  assert.equal(
    safeToolSetupConnectUrl("http://127.0.0.1:9000/oauth", true),
    "http://127.0.0.1:9000/oauth",
  );
  for (const rejected of [
    "http://127.0.0.1:9000/oauth",
    "http://provider.example/oauth",
    "https://user:password@provider.example/oauth",
    "https://provider.example\\@evil.example/oauth",
    "https://provider.example/\nredirect",
    "javascript:alert(1)",
    "//provider.example/oauth",
  ]) {
    assert.equal(safeToolSetupConnectUrl(rejected, false), null, rejected);
  }
});

test("durable account sync accepts exact Extend request state and rejects malformed state", () => {
  const update = {
    position: 11,
    kind: "extend.request",
    room_id: assignment.room_id,
    object_id: requestId,
    data: assignment,
    created_at: "2026-07-23T00:00:00Z",
  };
  const page = {
    updates: [update],
    cursor: "account-next",
    through: "account-through",
    has_more: false,
    range: {
      stream: "account",
      from_position: 10,
      next_position: 11,
      through_position: 11,
      first_item_position: 11,
      last_item_position: 11,
      item_count: 1,
      has_more: false,
      complete_through: true,
      coverage: "contiguous",
    },
  };
  assert.equal(validateAccountSyncPage(page, 10, 11).next_position, 11);
  const legacyData = {
    ...assignment,
    setup_url: "https://glass.example/glass/#team/product/extend",
    completion_url: "https://glass.example/glass/#team/product/extend",
    completion_schema: {
      type: "object",
      properties: {
        accessToken: {
          type: "string",
          default: "must-not-persist",
          examples: ["must-not-persist"],
        },
      },
    },
  };
  delete legacyData.tool_enabled;
  delete legacyData.will_enable_tool;
  const legacyPage = {
    ...page,
    updates: [{ ...update, data: legacyData }],
  };
  assert.equal(validateAccountSyncPage(legacyPage, 10, 11).next_position, 11);
  assert.equal("setup_url" in legacyPage.updates[0].data, false);
  assert.equal("completion_url" in legacyPage.updates[0].data, false);
  assert.deepEqual(legacyPage.updates[0].data.completion_schema, {});
  assert.equal(
    parseToolSetupAccountState(legacyData, requestId)?.will_enable_tool,
    false,
  );
  assert.throws(
    () => validateAccountSyncPage({
      ...page,
      updates: [{
        ...update,
        data: { ...assignment, request_id: "01K1OTHER000123456789GHJKMN" },
      }],
    }, 10, 11),
    /tool-setup request is malformed/,
  );
});

test("Interface and CLI expose no Extend directory or management surface", () => {
  const source = (path) =>
    fs.readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  assert.equal(
    fs.existsSync(new URL("../../src/app/extend/page.tsx", import.meta.url)),
    false,
  );
  assert.equal(
    fs.existsSync(new URL("../../src/app/extend/layout.tsx", import.meta.url)),
    false,
  );
  assert.equal(
    fs.existsSync(new URL("../../src/lib/extend.ts", import.meta.url)),
    false,
  );
  assert.doesNotMatch(source("src/components/app-header.tsx"), /href="\/extend"/);
  assert.doesNotMatch(source("src/app/settings/page.tsx"), /Silicon Extend/);

  const client = source("src/lib/api.ts");
  assert.match(client, /toolSetupRequest:/);
  assert.match(client, /startToolSetupRequest:/);
  assert.match(client, /cancelToolSetupRequest:/);
  assert.doesNotMatch(client, /extend\/directory|extend\/tools|extend\/connections/);

  const cli = source("packages/silicon-interface-cli/bin/silicon-interface.mjs");
  assert.doesNotMatch(cli, /function cmdExtend/);
  assert.doesNotMatch(cli, /case "extend":/);
  assert.doesNotMatch(cli, /\/api\/v1\/extend/);
  assert.doesNotMatch(
    source("packages/silicon-interface-cli/README.md"),
    /^## Silicon Extend$/m,
  );
});

test("message cards and OAuth callbacks open the inline request-scoped dialog", () => {
  const bubble = fs.readFileSync(
    new URL("../../src/components/chat/message-bubble.tsx", import.meta.url),
    "utf8",
  );
  const dialog = fs.readFileSync(
    new URL("../../src/components/chat/tool-setup-dialog.tsx", import.meta.url),
    "utf8",
  );
  const chat = fs.readFileSync(
    new URL("../../src/app/chat/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(bubble, /toolSetupRequestFromEvent\(event\)/);
  assert.match(bubble, /<ToolSetupDialog/);
  assert.match(bubble, /Set up now/);
  assert.doesNotMatch(bubble, /Set up in Glass|request\.setupUrl|href=\{request\./);
  assert.match(bubble, /const canForward =\s*!toolSetupRequest/);

  assert.match(dialog, /api\.toolSetupRequest\(requestId/);
  assert.match(dialog, /api\.startToolSetupRequest/);
  assert.match(dialog, /api\.cancelToolSetupRequest/);
  assert.match(dialog, /window\.open\(\s*"about:blank"/);
  assert.match(dialog, /popup\.opener = null/);
  assert.match(dialog, /safeToolSetupConnectUrl/);
  assert.match(
    dialog,
    /if \(safeConnectUrl\) setConnectUrl\(safeConnectUrl\);[\s\S]*popup\.location\.replace\(safeConnectUrl\)/,
  );
  assert.match(dialog, /Continue in connection window/);
  assert.match(dialog, /Restart connection/);
  assert.match(dialog, /restart: true as const/);
  assert.match(dialog, /unfinished provider attempt will be discarded/);
  assert.match(dialog, /\(actionable \|\| restartable\)/);
  assert.match(dialog, /Completing this request will enable/);
  assert.match(dialog, /A team manager must enable/);
  assert.match(dialog, /Who can use this connection/);
  assert.match(dialog, /Choose an account intended for shared use/);
  assert.match(dialog, /dedicated to the requesting Silicon/);
  assert.match(dialog, /belongs to your Carbon account/);
  assert.match(dialog, /ph-no-capture/);
  assert.match(dialog, /data-private="true"/);
  assert.match(dialog, /document\.visibilityState === "hidden"/);
  assert.match(dialog, /autocomplete="new-password"|autoComplete=\{field\.secret \? "new-password"/);

  assert.match(chat, /search\.get\("extend_request"\)/);
  assert.match(chat, /callbackSetupRequestId/);
  assert.match(chat, /<ToolSetupDialog/);
  assert.match(chat, /TOOL_SETUP_STATE_EVENT/);
});
