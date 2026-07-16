import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../bin/silicon-interface.mjs", import.meta.url));

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startMediaServer(onEvent) {
  const state = {
    presigns: 0,
    uploads: 0,
    completions: 0,
    events: [],
  };
  let baseUrl = "";
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, baseUrl);
      if (request.method === "POST" && url.pathname === "/api/v1/media/upload-url") {
        state.presigns += 1;
        await requestJson(request);
        json(response, 200, {
          upload: { url: `${baseUrl}/upload`, method: "POST", fields: {}, dev_mode: false },
          media: { media_id: "media-1", status: "pending" },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/upload") {
        state.uploads += 1;
        for await (const chunk of request) {
          // Consume the multipart upload.
          if (!chunk.length) break;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/media/media-1/complete") {
        state.completions += 1;
        await requestJson(request);
        json(response, 200, { media_id: "media-1", status: "pending" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/rooms/room-1/events") {
        const payload = await requestJson(request);
        state.events.push(payload);
        await onEvent({ request, response, payload, attempt: state.events.length });
        return;
      }
      json(response, 404, { detail: `Unexpected route: ${request.method} ${url.pathname}` });
    } catch (error) {
      json(response, 500, { detail: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, state, baseUrl };
}

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        SILICON_INTERFACE_HOME: path.join(cwd, "home"),
        SILICON_CHAT_CREDS: path.join(cwd, "missing-credentials.toml"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("send-file retries media_not_ready without uploading the file again", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "silicon-cli-media-"));
  const filePath = path.join(tempDir, "payload.txt");
  await fs.writeFile(filePath, "hello from the retry test\n");
  const mock = await startMediaServer(async ({ response, payload, attempt }) => {
    if (attempt === 1) {
      json(response, 409, {
        detail: "Message media upload is not ready.",
        code: "media_not_ready",
        retry_after_seconds: 0.01,
        failure: {
          domain: "chat.operation",
          code: "media_not_ready",
          retryable: true,
          automatic: true,
          correction_actions: [],
          retry_after_seconds: 0.01,
        },
      });
      return;
    }
    json(response, 201, {
      event_id: "event-1",
      type: payload.type,
      content: payload.content,
      sender_handle: "test-silicon",
      created_at: "2026-07-15T00:00:00Z",
    });
  });

  try {
    const result = await runCli(
      ["--api", mock.baseUrl, "--key", "test-key", "send-file", "room-1", filePath],
      tempDir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.state.presigns, 1);
    assert.equal(mock.state.uploads, 1);
    assert.equal(mock.state.completions, 1);
    assert.equal(mock.state.events.length, 2);
    assert.deepEqual(mock.state.events[1], mock.state.events[0]);
    assert.equal(mock.state.events[1].content.media_id, "media-1");
    assert.match(result.stdout, /media: media-1/);
  } finally {
    await closeServer(mock.server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file does not retry unrelated conflicts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "silicon-cli-media-"));
  const filePath = path.join(tempDir, "payload.txt");
  await fs.writeFile(filePath, "hello from the terminal error test\n");
  const mock = await startMediaServer(async ({ response }) => {
    json(response, 409, {
      detail: "Message media belongs to another room.",
      code: "media_mismatch",
      failure: {
        domain: "chat.operation",
        code: "media_mismatch",
        retryable: false,
        automatic: false,
        correction_actions: ["replace_attachment", "discard_local"],
      },
    });
  });

  try {
    const result = await runCli(
      ["--api", mock.baseUrl, "--key", "test-key", "send-file", "room-1", filePath],
      tempDir,
    );
    assert.equal(result.code, 1);
    assert.equal(mock.state.events.length, 1);
    assert.match(result.stderr, /media_mismatch/);
  } finally {
    await closeServer(mock.server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
