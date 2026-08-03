import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../bin/silicon-interface.mjs", import.meta.url));
const PROTOCOL_HEADERS = {
  "x-chat-protocol": "1",
  "x-chat-protocol-min": "1",
  "x-chat-protocol-max": "1",
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...PROTOCOL_HEADERS,
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startServer(handler) {
  let baseUrl = "";
  const server = http.createServer(async (request, response) => {
    try {
      await handler(request, response, baseUrl);
    } catch (error) {
      json(response, 500, { detail: error.stack || error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

function runCli(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        SILICON_INTERFACE_HOME: path.join(cwd, "home"),
        SILICON_CHAT_CREDS: path.join(cwd, "missing-credentials.toml"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function daemonRpc(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.once("close", () => {
      try {
        resolve(JSON.parse(response.trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "silicon-cli-v2-"));
  try {
    return await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function event(eventId, body, position = 1) {
  return {
    event_id: eventId,
    stream_writer: "primary",
    stream_position: position,
    sender_kind: "carbon",
    sender_handle: "alice",
    type: "m.text",
    content: { body },
    created_at: "2026-07-16T00:00:00Z",
  };
}

function serverWebSocketFrame(value, opcode = 1) {
  const payload = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }
  if (payload.length <= 65_535) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error("Test WebSocket frame is too large.");
}

function consumeClientWebSocketFrames(buffer, onText, onClose = () => {}) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }
    const masked = Boolean(second & 0x80);
    const total = headerLength + (masked ? 4 : 0) + length;
    if (buffer.length - offset < total) break;
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + (masked ? 4 : 0);
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    const opcode = first & 0x0f;
    if (opcode === 1) onText(payload.toString("utf8"));
    if (opcode === 8) onClose();
    offset += total;
  }
  return buffer.subarray(offset);
}

test("clean installs default API and WebSocket traffic to production Glass", async () => {
  await withTempDir(async (tempDir) => {
    const result = await runCli(["--json", "config", "show"], tempDir, {
      SILICON_INTERFACE_API_BASE: "",
      SILICON_INTERFACE_WS_BASE: "",
      NEXT_PUBLIC_API_BASE: "",
      NEXT_PUBLIC_WS_BASE: "",
    });
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.effectiveApiBase, "https://glass.teamofsilicons.com");
    assert.equal(config.effectiveWsBase, "wss://glass.teamofsilicons.com");
  });
});

test("Silicon authentication automatically starts and clears the live inbox daemon", async () => {
  await withTempDir(async (tempDir) => {
    const apiBase = "http://127.0.0.1:1";
    const wsBase = "ws://127.0.0.1:1";
    try {
      const authenticated = await runCli(
        ["--api", apiBase, "--ws", wsBase, "auth", "set-key", "silicon-key-one"],
        tempDir,
      );
      assert.equal(authenticated.code, 0, authenticated.stderr);
      assert.match(authenticated.stdout, /Live inbox daemon started automatically/);

      const firstStatus = await runCli(["--json", "daemon", "status"], tempDir);
      assert.equal(firstStatus.code, 0, firstStatus.stderr);
      const firstDaemon = JSON.parse(firstStatus.stdout);
      assert.equal(firstDaemon.running, true);
      assert.equal(Number.isSafeInteger(firstDaemon.pid), true);
      const rpcDiscovery = JSON.parse(
        await fs.readFile(path.join(tempDir, ".silicon-interface", "daemon-rpc.json"), "utf8"),
      );
      const socketPath = rpcDiscovery.socket;
      const socketMode = (await fs.stat(socketPath)).mode & 0o777;
      assert.equal(socketMode, 0o600);
      const rpcStatus = await daemonRpc(socketPath, {
        version: 1,
        id: "status-one",
        command: "daemon",
        args: ["status"],
      });
      assert.equal(rpcStatus.ok, true);
      assert.equal(rpcStatus.result.running, true);
      assert.equal(rpcStatus.result.pid, firstDaemon.pid);
      const unsupported = await daemonRpc(socketPath, {
        version: 1,
        id: "stop-one",
        command: "daemon",
        args: ["stop"],
      });
      assert.equal(unsupported.ok, false);
      assert.equal(unsupported.error.code, "UNSUPPORTED_COMMAND");

      const rotated = await runCli(
        ["--api", apiBase, "--ws", wsBase, "auth", "set-key", "silicon-key-two"],
        tempDir,
      );
      assert.equal(rotated.code, 0, rotated.stderr);
      const rotatedStatus = await runCli(["--json", "daemon", "status"], tempDir);
      assert.equal(rotatedStatus.code, 0, rotatedStatus.stderr);
      assert.equal(JSON.parse(rotatedStatus.stdout).running, true);

      const cleared = await runCli(["auth", "clear"], tempDir);
      assert.equal(cleared.code, 0, cleared.stderr);
      assert.match(cleared.stdout, /live inbox daemon stopped/);
      const stoppedStatus = await runCli(["--json", "daemon", "status"], tempDir);
      assert.equal(stoppedStatus.code, 0, stoppedStatus.stderr);
      assert.equal(JSON.parse(stoppedStatus.stdout).running, false);
    } finally {
      await runCli(["daemon", "stop"], tempDir);
    }
  });
});

test("standalone voice tools transcribe local audio and download synthesized audio", async () => {
  await withTempDir(async (tempDir) => {
    const synthesized = Buffer.from("SYNTHESIZED_MP3");
    const synthesizedSha = createHash("sha256").update(synthesized).digest("hex");
    const requests = [];
    let ttsReads = 0;
    let sttQueued = false;
    let sttReads = 0;
    const mock = await startServer(async (request, response, baseUrl) => {
      requests.push({ method: request.method, url: request.url });
      if (request.method === "POST" && request.url === "/api/v1/tts") {
        const payload = await requestJson(request);
        assert.deepEqual(payload, { text: "hello locally" });
        json(response, 202, {
          job: "queued",
          media_id: "tts-media",
          status: "pending",
          synthesis_state: "pending",
        });
        return;
      }
      if (request.method === "GET" && request.url === "/api/v1/media/tts-media") {
        ttsReads += 1;
        const ready = ttsReads > 1;
        json(response, 200, {
          media: {
            media_id: "tts-media",
            mime: "audio/mpeg",
            size: ready ? synthesized.length : 0,
            sha256: ready ? synthesizedSha : "",
            status: ready ? "ready" : "pending",
            kind: "tts_output",
            synthesis_state: ready ? "ready" : "pending",
          },
          download_url: ready ? `${baseUrl}/download/tts-media` : null,
          attachment_url: ready ? `${baseUrl}/download/tts-media` : null,
        });
        return;
      }
      if (request.method === "GET" && request.url === "/download/tts-media") {
        response.writeHead(200, { "content-type": "audio/mpeg", "content-length": synthesized.length });
        response.end(synthesized);
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/media/uploads") {
        json(response, 404, { detail: "multipart unavailable" });
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/media/upload-url") {
        const payload = await requestJson(request);
        assert.equal(payload.kind, "voice");
        assert.equal(payload.mime, "audio/wav");
        assert.equal(payload.room_id, "");
        json(response, 201, {
          upload: { dev_mode: true },
          media: { media_id: "stt-media", status: "ready", kind: "voice", mime: "audio/wav" },
        });
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/stt") {
        const payload = await requestJson(request);
        assert.deepEqual(payload, { media_id: "stt-media", language: "en" });
        sttQueued = true;
        json(response, 202, {
          job: "queued",
          media_id: "stt-media",
          transcription_status: "pending",
        });
        return;
      }
      if (request.method === "GET" && request.url === "/api/v1/media/stt-media") {
        if (!sttQueued) {
          json(response, 200, {
            media: {
              media_id: "stt-media",
              status: "ready",
              kind: "voice",
              mime: "audio/wav",
              transcription_status: "none",
              transcript: "",
            },
          });
          return;
        }
        sttReads += 1;
        const ready = sttReads > 1;
        json(response, 200, {
          media: {
            media_id: "stt-media",
            status: "ready",
            kind: "voice",
            mime: "audio/wav",
            transcription_status: ready ? "ready" : "pending",
            transcription_provider: ready ? "glass-stt" : "",
            transcript: ready ? "authoritative local transcript" : "",
          },
        });
        return;
      }
      json(response, 404, { detail: `Unexpected ${request.method} ${request.url}` });
    });
    try {
      const ttsPath = path.join(tempDir, "spoken.mp3");
      const tts = await runCli(
        [
          "--api", mock.baseUrl,
          "--key", "silicon-key",
          "tts", "hello", "locally",
          "--output", ttsPath,
          "--poll-ms", "250",
        ],
        tempDir,
      );
      assert.equal(tts.code, 0, tts.stderr);
      assert.equal(tts.stdout.trim(), ttsPath);
      assert.deepEqual(await fs.readFile(ttsPath), synthesized);

      const audioPath = path.join(tempDir, "separate-voice.wav");
      await fs.writeFile(audioPath, Buffer.from("LOCAL_WAVE_BYTES"));
      const stt = await runCli(
        [
          "--api", mock.baseUrl,
          "--key", "silicon-key",
          "stt", audioPath,
          "--language", "en",
          "--poll-ms", "250",
        ],
        tempDir,
      );
      assert.equal(stt.code, 0, stt.stderr);
      assert.equal(stt.stdout.trim(), "authoritative local transcript");
      assert.equal(requests.some((row) => row.url === "/api/v1/media/uploads"), true);
      assert.equal(requests.some((row) => row.url === "/api/v1/media/upload-url"), true);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("v2 sends protocol metadata and reuses a pending client id after failure", async () => {
  await withTempDir(async (tempDir) => {
    const requests = [];
    const mock = await startServer(async (request, response) => {
      assert.equal(request.url, "/api/v1/rooms/room-1/events");
      const payload = await requestJson(request);
      requests.push({ payload, headers: request.headers });
      if (requests.length === 1) {
        json(response, 500, { detail: "response was lost" });
      } else {
        json(response, 201, {
          ...event("event-1", payload.content.body),
          client_id: payload.content.client_id,
          content: payload.content,
        });
      }
    });
    try {
      const args = ["--api", mock.baseUrl, "--key", "test-key", "--json", "send", "room-1", "hello"];
      const first = await runCli(args, tempDir);
      assert.equal(first.code, 1);
      const second = await runCli(args, tempDir);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(requests.length, 2);
      assert.match(requests[0].payload.content.client_id, /^cli_[a-f0-9]{32}$/);
      assert.equal(requests[1].payload.content.client_id, requests[0].payload.content.client_id);
      assert.equal(requests[0].headers["x-chat-protocol"], "1");
      assert.equal(requests[0].headers["x-silicon-key"], "test-key");
      assert.match(requests[0].headers["user-agent"], /silicon-interface-cli\/2\.0\.4/);
      assert.match(requests[0].headers.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("normal sends carry manager activity continuation and run identity fields", async () => {
  await withTempDir(async (tempDir) => {
    const requests = [];
    const mock = await startServer(async (request, response) => {
      assert.equal(request.url, "/api/v1/rooms/room-activity/events");
      const payload = await requestJson(request);
      requests.push(payload);
      json(response, 201, {
        ...event(`event-${requests.length}`, payload.content.body, requests.length),
        content: payload.content,
        reply_to_event_id: payload.reply_to_event_id || "",
        is_final: payload.is_final ?? true,
      });
    });
    try {
      const common = ["--api", mock.baseUrl, "--key", "test-key", "--json", "send", "room-activity"];
      const interim = await runCli([
        ...common,
        "Quick note while I keep working",
        "--work-continues",
        "--group", "run-fitness",
        "--reply-to", "event-prompt",
        "--final", "false",
        "--client-id", "activity-note-1",
      ], tempDir);
      assert.equal(interim.code, 0, interim.stderr);

      const final = await runCli([
        ...common,
        "Finished",
        "--group", "run-fitness",
        "--client-id", "activity-final-1",
      ], tempDir);
      assert.equal(final.code, 0, final.stderr);

      assert.deepEqual(requests, [
        {
          type: "m.text",
          content: {
            body: "Quick note while I keep working",
            work_continues: true,
            progress_group_id: "run-fitness",
            client_id: "activity-note-1",
          },
          reply_to_event_id: "event-prompt",
          is_final: false,
        },
        {
          type: "m.text",
          content: {
            body: "Finished",
            progress_group_id: "run-fitness",
            client_id: "activity-final-1",
          },
        },
      ]);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("send-file resumes Glass multipart uploads and submits full checksum proof", async () => {
  await withTempDir(async (tempDir) => {
    const bytes = Buffer.from("abcdefghij");
    const source = path.join(tempDir, "ten.txt");
    await fs.writeFile(source, bytes);
    const firstChecksum = createHash("sha256").update(bytes.subarray(0, 5)).digest("base64");
    const secondChecksum = createHash("sha256").update(bytes.subarray(5)).digest("base64");
    const wholeSha256 = createHash("sha256").update(bytes).digest("hex");
    let uploadedSecond = false;
    let creation = null;
    let signed = null;
    let completed = null;
    let eventPayload = null;
    let legacyCalls = 0;
    const uploadedParts = () => [
      { part_number: 1, etag: "etag-1", size: 5, checksum_sha256: firstChecksum },
      ...(uploadedSecond
        ? [{ part_number: 2, etag: "etag-2", size: 5, checksum_sha256: secondChecksum }]
        : []),
    ];
    const session = () => ({
      session_id: "session-1",
      client_id: creation?.client_id || "upload-client",
      state: "uploading",
      part_size: 5,
      part_count: 2,
      expires_at: "2026-07-17T00:00:00Z",
      media: { media_id: "media-1", status: "pending" },
      dev_mode: false,
      uploaded_parts: uploadedParts(),
    });
    const mock = await startServer(async (request, response, baseUrl) => {
      if (request.method === "POST" && request.url === "/api/v1/media/uploads") {
        creation = await requestJson(request);
        json(response, 201, session());
        return;
      }
      if (request.method === "GET" && request.url === "/api/v1/media/uploads/session-1") {
        json(response, 200, session());
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/media/uploads/session-1/parts") {
        signed = await requestJson(request);
        json(response, 200, {
          session_id: "session-1",
          parts: [{
            part_number: 2,
            checksum_sha256: secondChecksum,
            url: `${baseUrl}/storage/part-2`,
            method: "PUT",
          }],
        });
        return;
      }
      if (request.method === "PUT" && request.url === "/storage/part-2") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), bytes.subarray(5));
        assert.equal(request.headers["x-amz-checksum-sha256"], secondChecksum);
        uploadedSecond = true;
        response.writeHead(200, { etag: "etag-2" });
        response.end();
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/media/uploads/session-1/complete") {
        completed = await requestJson(request);
        json(response, 200, { ...session(), state: "completed", media: { media_id: "media-1", status: "ready", sha256: wholeSha256 } });
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/rooms/room-1/events") {
        eventPayload = await requestJson(request);
        json(response, 201, {
          ...event("event-1", "ten.txt"),
          type: eventPayload.type,
          content: eventPayload.content,
        });
        return;
      }
      if (request.url === "/api/v1/media/upload-url") {
        legacyCalls += 1;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl, "--key", "test-key", "--json",
        "send-file", "room-1", source,
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(legacyCalls, 0);
      assert.equal(creation.sha256, wholeSha256);
      assert.equal(creation.size, 10);
      assert.deepEqual(signed.parts, [{ part_number: 2, checksum_sha256: secondChecksum }]);
      assert.equal(completed.sha256, wholeSha256);
      assert.deepEqual(completed.parts, uploadedParts().map(({ part_number, etag, checksum_sha256 }) => ({
        part_number,
        etag,
        checksum_sha256,
      })));
      assert.equal(eventPayload.content.media_id, "media-1");
      assert.match(eventPayload.content.client_id, /^cli_/);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("GIF sends use the Glass multipart identity instead of the legacy upload path", async () => {
  await withTempDir(async (tempDir) => {
    const gifBytes = Buffer.from("GIF89a-test");
    let creation = null;
    let metadata = null;
    let sent = null;
    let legacyCalls = 0;
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      if (url.pathname === "/giphy/gifs/gif-1") {
        json(response, 200, {
          data: {
            id: "gif-1",
            title: "Test GIF",
            url: "https://giphy.example/gif-1",
            images: {
              original: { url: `${baseUrl}/giphy/blob/gif-1`, width: "320", height: "180" },
            },
          },
        });
        return;
      }
      if (url.pathname === "/giphy/blob/gif-1") {
        response.writeHead(200, { "content-type": "image/gif" });
        response.end(gifBytes);
        return;
      }
      if (url.pathname === "/api/v1/media/uploads") {
        creation = await requestJson(request);
        json(response, 201, {
          session_id: "gif-session",
          client_id: creation.client_id,
          state: "completed",
          part_size: gifBytes.length,
          part_count: 1,
          expires_at: "2026-07-17T00:00:00Z",
          media: { media_id: "gif-media", status: "ready" },
          dev_mode: true,
          uploaded_parts: [],
        });
        return;
      }
      if (url.pathname === "/api/v1/media/gif-media/complete") {
        metadata = await requestJson(request);
        json(response, 200, { media_id: "gif-media", status: "ready" });
        return;
      }
      if (url.pathname === "/api/v1/rooms/room-1/events") {
        sent = await requestJson(request);
        json(response, 201, { ...event("gif-event", "", 1), type: sent.type, content: sent.content });
        return;
      }
      if (url.pathname === "/api/v1/media/upload-url") legacyCalls += 1;
      json(response, 404, { detail: request.url });
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl, "--key", "test-key", "--json",
        "gif", "send", "room-1", "gif-1", "celebrate",
      ], tempDir, {
        GIPHY_API_KEY: "giphy-key",
        SILICON_INTERFACE_GIPHY_BASE: `${mock.baseUrl}/giphy/gifs`,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(legacyCalls, 0);
      assert.match(creation.client_id, /^upload_cli_[a-f0-9]{32}$/);
      assert.equal(creation.sha256, createHash("sha256").update(gifBytes).digest("hex"));
      assert.deepEqual(metadata, { width: 320, height: 180 });
      assert.equal(sent.type, "m.image");
      assert.equal(sent.content.media_id, "gif-media");
      assert.match(sent.content.client_id, /^cli_[a-f0-9]{32}$/);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("ambiguous sends reconcile through Glass's body-free operation ledger", async () => {
  await withTempDir(async (tempDir) => {
    let clientId = "";
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      if (request.method === "POST" && url.pathname === "/api/v1/rooms/room-1/events") {
        clientId = (await requestJson(request)).content.client_id;
        json(response, 500, { detail: "commit response lost" });
        return;
      }
      const expected = `/api/v1/rooms/room-1/operations/event_send/${clientId}`;
      if (request.method === "GET" && url.pathname === expected) {
        const operation = {
          operation_id: "operation-1",
          room_id: "room-1",
          kind: "event_send",
          client_id: clientId,
          state: "succeeded",
          resource_id: "event-1",
          result_event_id: "event-1",
        };
        json(response, 200, url.searchParams.get("include") === "result"
          ? { ...operation, result: { kind: "event", event: event("event-1", "hello") } }
          : operation);
        return;
      }
      json(response, 404, { detail: request.url, code: "operation_not_found" });
    });
    try {
      const common = ["--api", mock.baseUrl, "--key", "test-key"];
      const sent = await runCli([...common, "send", "room-1", "hello"], tempDir);
      assert.equal(sent.code, 1);
      assert.match(clientId, /^cli_/);
      const resolved = await runCli([...common, "--json", "operations", "resolve", "all"], tempDir);
      assert.equal(resolved.code, 0, resolved.stderr);
      assert.equal(JSON.parse(resolved.stdout)[0].state, "succeeded");
      const journal = JSON.parse(
        await fs.readFile(path.join(tempDir, ".silicon-interface", "operations.json"), "utf8"),
      );
      assert.equal(journal.operations[0].status, "complete");
      assert.equal(journal.operations[0].result.operation.resource_id, "event-1");
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("history and search consume Glass signed cursors without offset paging", async () => {
  await withTempDir(async (tempDir) => {
    const historyQueries = [];
    const searchQueries = [];
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      if (url.pathname === "/api/v1/rooms/room-1/events") {
        historyQueries.push(Object.fromEntries(url.searchParams));
        if (!url.searchParams.get("cursor")) {
          json(response, 200, {
            events: [event("event-3", "three", 3), event("event-4", "four", 4)],
            cursor: "history-cursor",
            has_more: true,
            direction: "backward",
            through_event_id: "event-4",
          });
        } else {
          json(response, 200, {
            events: [event("event-1", "one", 1), event("event-2", "two", 2)],
            cursor: null,
            has_more: false,
            direction: "backward",
            through_event_id: "event-4",
          });
        }
        return;
      }
      if (url.pathname === "/api/v1/events/search") {
        searchQueries.push(Object.fromEntries(url.searchParams));
        if (!url.searchParams.get("cursor")) {
          json(response, 200, {
            results: [event("event-4", "needle", 4)],
            cursor: "search-cursor",
            limit: 1,
            total: 2,
            has_more: true,
          });
        } else {
          json(response, 200, {
            results: [event("event-2", "needle again", 2)],
            cursor: null,
            limit: 1,
            total: 2,
            has_more: false,
          });
        }
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const common = ["--api", mock.baseUrl, "--key", "test-key", "--json"];
      const history = await runCli([...common, "history", "room-1", "--limit", "2"], tempDir);
      assert.equal(history.code, 0, history.stderr);
      const parsedHistory = JSON.parse(history.stdout);
      assert.deepEqual(parsedHistory.events.map((row) => row.event_id), [
        "event-1", "event-2", "event-3", "event-4",
      ]);
      assert.equal(parsedHistory.complete, true);
      assert.equal(historyQueries[1].cursor, "history-cursor");

      const search = await runCli([...common, "search", "needle", "--limit", "1", "--all"], tempDir);
      assert.equal(search.code, 0, search.stderr);
      assert.equal(JSON.parse(search.stdout).results.length, 2);
      assert.deepEqual(searchQueries[0], { q: "needle", limit: "1" });
      assert.deepEqual(searchQueries[1], { cursor: "search-cursor" });
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("complete history repairs an expired cursor with an anchored continuation", async () => {
  await withTempDir(async (tempDir) => {
    const queries = [];
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      queries.push(Object.fromEntries(url.searchParams));
      const cursor = url.searchParams.get("cursor");
      const anchor = url.searchParams.get("anchor");
      if (!cursor && !anchor && queries.length === 1) {
        json(response, 200, {
          events: [event("event-5", "five", 5), event("event-6", "six", 6)],
          cursor: "expired-cursor",
          has_more: true,
          direction: "backward",
          through_event_id: "event-6",
        });
      } else if (cursor === "expired-cursor") {
        json(response, 410, { detail: "expired", code: "cursor_expired" });
      } else if (anchor === "event-5") {
        json(response, 200, {
          events: [event("event-3", "three", 3), event("event-4", "four", 4)],
          cursor: "older-cursor",
          has_more: true,
          direction: "backward",
          through_event_id: "event-6",
        });
      } else if (cursor === "older-cursor") {
        json(response, 200, {
          events: [event("event-1", "one", 1), event("event-2", "two", 2)],
          cursor: null,
          has_more: false,
          direction: "backward",
          through_event_id: "event-6",
        });
      } else {
        json(response, 400, { detail: `unexpected query ${url.search}` });
      }
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl, "--key", "test-key", "--json",
        "history", "room-1", "--limit", "2",
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).events.map((row) => row.event_id), [
        "event-1", "event-2", "event-3", "event-4", "event-5", "event-6",
      ]);
      assert.equal(queries[2].cursor, "");
      assert.equal(queries[2].anchor, "event-5");
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("durable sync validates both streams, commits checkpoints, spools, then acknowledges", async () => {
  await withTempDir(async (tempDir) => {
    const requests = [];
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers });
      if (url.pathname === "/api/v1/sync/initial") {
        json(response, 200, {
          sync_version: 1,
          through: "event-cursor-0",
          account_through: "account-cursor-0",
          continuity: {
            event_position: 0,
            event_vector: { floor: 0, writers: {} },
            account_position: 0,
            complete_at_barrier: true,
          },
          rooms: [],
          account_data: { drafts: [], held_sends: [] },
          next: null,
          has_more: false,
        });
        return;
      }
      if (url.pathname === "/api/v1/events/sync") {
        json(response, 200, {
          frames: [{ type: "event", room_id: "room-1", event: event("event-1", "hello", 1) }],
          cursor: "event-cursor-1",
          through: "event-through-1",
          has_more: false,
          range: null,
          vector_range: {
            version: 1,
            stream: "events",
            coverage: "authoritative_projection",
            from: { floor: 0, writers: {} },
            next: { floor: 0, writers: { primary: 1 } },
            through: { floor: 0, writers: { primary: 1 } },
            items: [{ writer: "primary", position: 1 }],
            item_count: 1,
            has_more: false,
            complete_through: true,
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/sync/account") {
        json(response, 200, {
          updates: [{
            kind: "draft.upsert",
            object_id: "room-1",
            room_id: "room-1",
            position: 1,
            data: { text: "draft" },
            created_at: "2026-07-16T00:00:01Z",
          }],
          cursor: "account-cursor-1",
          through: "account-through-1",
          has_more: false,
          range: {
            stream: "account",
            from_position: 0,
            next_position: 1,
            through_position: 1,
            first_item_position: 1,
            last_item_position: 1,
            item_count: 1,
            has_more: false,
            complete_through: true,
            coverage: "contiguous",
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/events/delivered") {
        assert.deepEqual((await requestJson(request)).event_ids, ["event-1"]);
        json(response, 200, { acknowledged: 1, device_id: "cli-device" });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl,
        "--access-token", "access-token",
        "--device-id", "cli-device",
        "--json",
        "messages", "sync", "--spool",
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).total, 2);
      const state = JSON.parse(await fs.readFile(path.join(tempDir, ".silicon-interface", "state.json"), "utf8"));
      const checkpoint = Object.values(state.streams)[0];
      assert.equal(checkpoint.event, "event-cursor-1");
      assert.equal(checkpoint.account, "account-cursor-1");
      assert.deepEqual(state.pendingDeliveries || {}, {});
      const inbox = await fs.readFile(path.join(tempDir, ".silicon-interface", "inbox.jsonl"), "utf8");
      assert.match(inbox, /"event_id":"event-1"/);
      assert.match(inbox, /"kind":"draft.upsert"/);
      assert.deepEqual(requests.map((row) => row.path), [
        "/api/v1/sync/initial",
        "/api/v1/events/sync",
        "/api/v1/events/delivered",
        "/api/v1/sync/account",
      ]);
      for (const request of requests) {
        assert.equal(request.headers["x-chat-protocol"], "1");
        assert.equal(request.headers["x-device-id"], "cli-device");
      }
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("durable sync rejects a corrupt proof before spooling and rebuilds from Glass", async () => {
  await withTempDir(async (tempDir) => {
    let initialCalls = 0;
    const mock = await startServer(async (request, response) => {
      if (request.url.startsWith("/api/v1/sync/initial?")) {
        initialCalls += 1;
        json(response, 200, {
          sync_version: 1,
          through: initialCalls === 1 ? "event-cursor-0" : "event-cursor-rebuilt",
          account_through: initialCalls === 1 ? "account-cursor-0" : "account-cursor-rebuilt",
          continuity: {
            event_position: 0,
            event_vector: { floor: 0, writers: {} },
            account_position: 0,
            complete_at_barrier: true,
          },
          rooms: [],
          account_data: { drafts: [], held_sends: [] },
          next: null,
          has_more: false,
        });
        return;
      }
      if (request.url.startsWith("/api/v1/events/sync?")) {
        json(response, 200, {
          frames: [{ type: "event", room_id: "room-1", event: event("untrusted-event", "must not spool", 1) }],
          cursor: "corrupt-cursor",
          through: "corrupt-through",
          has_more: false,
          vector_range: {
            version: 1,
            stream: "events",
            coverage: "authoritative_projection",
            from: { floor: 0, writers: {} },
            next: { floor: 0, writers: { primary: 1 } },
            through: { floor: 0, writers: { primary: 1 } },
            items: [{ writer: "forged-writer", position: 1 }],
            item_count: 1,
            has_more: false,
            complete_through: true,
          },
        });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl, "--access-token", "access", "--device-id", "device", "--json",
        "messages", "sync", "--spool",
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.rebuilt, true);
      assert.match(output.reason, /does not match its event/);
      assert.equal(initialCalls, 2);
      const state = JSON.parse(await fs.readFile(path.join(tempDir, ".silicon-interface", "state.json"), "utf8"));
      const checkpoint = Object.values(state.streams)[0];
      assert.equal(checkpoint.event, "event-cursor-rebuilt");
      assert.equal(checkpoint.account, "account-cursor-rebuilt");
      const inbox = await fs.readFile(path.join(tempDir, ".silicon-interface", "inbox.jsonl"), "utf8");
      assert.equal(inbox.includes("untrusted-event"), false);
      assert.equal(inbox.includes("must not spool"), false);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("delivery acknowledgement survives failure after durable spool and flushes on restart", async () => {
  await withTempDir(async (tempDir) => {
    let acknowledgementCalls = 0;
    const paths = [];
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      paths.push(url.pathname);
      if (url.pathname === "/api/v1/sync/initial") {
        json(response, 200, {
          sync_version: 1,
          through: "event-cursor-0",
          account_through: "account-cursor-0",
          continuity: {
            event_position: 0,
            event_vector: { floor: 0, writers: {} },
            account_position: 0,
            complete_at_barrier: true,
          },
          rooms: [],
          account_data: { drafts: [], held_sends: [] },
          next: null,
          has_more: false,
        });
        return;
      }
      if (url.pathname === "/api/v1/events/sync") {
        const cursor = url.searchParams.get("cursor");
        const frames = cursor === "event-cursor-0"
          ? [{ type: "event", room_id: "room-1", event: event("event-durable", "persist me", 1) }]
          : [];
        const vector = cursor === "event-cursor-0"
          ? { floor: 0, writers: { primary: 1 } }
          : { floor: 0, writers: { primary: 1 } };
        json(response, 200, {
          frames,
          cursor: "event-cursor-1",
          through: "event-through-1",
          has_more: false,
          vector_range: {
            version: 1,
            stream: "events",
            coverage: "authoritative_projection",
            from: cursor === "event-cursor-0" ? { floor: 0, writers: {} } : vector,
            next: vector,
            through: vector,
            items: frames.length ? [{ writer: "primary", position: 1 }] : [],
            item_count: frames.length,
            has_more: false,
            complete_through: true,
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/events/delivered") {
        acknowledgementCalls += 1;
        assert.deepEqual((await requestJson(request)).event_ids, ["event-durable"]);
        if (acknowledgementCalls === 1) {
          json(response, 400, { detail: "simulated interruption" });
        } else {
          json(response, 200, { acknowledged: 1, device_id: "device" });
        }
        return;
      }
      if (url.pathname === "/api/v1/sync/account") {
        json(response, 200, {
          updates: [],
          cursor: "account-cursor-1",
          through: "account-through-0",
          has_more: false,
          range: {
            stream: "account",
            from_position: 0,
            next_position: 0,
            through_position: 0,
            first_item_position: null,
            last_item_position: null,
            item_count: 0,
            has_more: false,
            complete_through: true,
            coverage: "contiguous",
          },
        });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const command = [
        "--api", mock.baseUrl, "--access-token", "access", "--device-id", "device", "--json",
        "messages", "sync", "--spool",
      ];
      const first = await runCli(command, tempDir);
      assert.equal(first.code, 1);
      let state = JSON.parse(await fs.readFile(path.join(tempDir, ".silicon-interface", "state.json"), "utf8"));
      assert.deepEqual(Object.values(state.pendingDeliveries)[0], ["event-durable"]);
      const inboxAfterFailure = await fs.readFile(path.join(tempDir, ".silicon-interface", "inbox.jsonl"), "utf8");
      assert.match(inboxAfterFailure, /event-durable/);

      const second = await runCli(command, tempDir);
      assert.equal(second.code, 0, second.stderr);
      state = JSON.parse(await fs.readFile(path.join(tempDir, ".silicon-interface", "state.json"), "utf8"));
      assert.deepEqual(state.pendingDeliveries || {}, {});
      const inboxAfterRestart = await fs.readFile(path.join(tempDir, ".silicon-interface", "inbox.jsonl"), "utf8");
      assert.equal((inboxAfterRestart.match(/event-durable/g) || []).length, 1);
      assert.equal(acknowledgementCalls, 2);
      assert.deepEqual(paths.slice(-3), [
        "/api/v1/events/delivered",
        "/api/v1/events/sync",
        "/api/v1/sync/account",
      ]);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("durable inbox deduplicates replayed events across CLI processes", async () => {
  await withTempDir(async (tempDir) => {
    let acknowledgements = 0;
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      if (url.pathname === "/api/v1/sync/initial") {
        json(response, 200, {
          sync_version: 1,
          through: "event-cursor-0",
          account_through: "account-cursor-0",
          continuity: {
            event_position: 0,
            event_vector: { floor: 0, writers: {} },
            account_position: 0,
            complete_at_barrier: true,
          },
          rooms: [],
          account_data: { drafts: [], held_sends: [] },
          next: null,
          has_more: false,
        });
        return;
      }
      if (url.pathname === "/api/v1/events/sync") {
        json(response, 200, {
          frames: [{ type: "event", room_id: "room-1", event: event("event-replayed", "once", 1) }],
          cursor: "event-cursor-1",
          through: "event-through-1",
          has_more: false,
          vector_range: {
            version: 1,
            stream: "events",
            coverage: "authoritative_projection",
            from: { floor: 0, writers: {} },
            next: { floor: 0, writers: { primary: 1 } },
            through: { floor: 0, writers: { primary: 1 } },
            items: [{ writer: "primary", position: 1 }],
            item_count: 1,
            has_more: false,
            complete_through: true,
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/events/delivered") {
        acknowledgements += 1;
        assert.deepEqual((await requestJson(request)).event_ids, ["event-replayed"]);
        json(response, 200, { acknowledged: 1, device_id: "device" });
        return;
      }
      if (url.pathname === "/api/v1/sync/account") {
        json(response, 200, {
          updates: [],
          cursor: "account-cursor-0",
          through: "account-through-0",
          has_more: false,
          range: {
            stream: "account",
            from_position: 0,
            next_position: 0,
            through_position: 0,
            first_item_position: null,
            last_item_position: null,
            item_count: 0,
            has_more: false,
            complete_through: true,
            coverage: "contiguous",
          },
        });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const command = [
        "--api", mock.baseUrl, "--access-token", "access", "--device-id", "device", "--json",
        "messages", "sync", "--reset", "--spool",
      ];
      const first = await runCli(command, tempDir);
      const second = await runCli(command, tempDir);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);
      const inbox = await fs.readFile(path.join(tempDir, ".silicon-interface", "inbox.jsonl"), "utf8");
      assert.equal((inbox.match(/event-replayed/g) || []).length, 1);
      assert.equal(acknowledgements, 2, "Glass replays are acknowledged even when already durable");
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("media download verifies the Glass SHA-256 before publishing the file", async () => {
  await withTempDir(async (tempDir) => {
    const bytes = Buffer.from("verified attachment bytes\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mock = await startServer(async (request, response, baseUrl) => {
      if (request.url === "/api/v1/media/media-1") {
        json(response, 200, {
          media: { media_id: "media-1", filename: "report.txt", status: "ready", sha256 },
          download_url: `${baseUrl}/blob/media-1`,
        });
        return;
      }
      if (request.url === "/blob/media-1") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(bytes);
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const destination = path.join(tempDir, "downloaded.txt");
      const result = await runCli([
        "--api", mock.baseUrl, "--key", "test-key", "media", "download", "media-1", destination,
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(await fs.readFile(destination), bytes);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("attachment history includes every ordered album item and single attachment", async () => {
  await withTempDir(async (tempDir) => {
    const mock = await startServer(async (request, response) => {
      if (request.url.startsWith("/api/v1/rooms/room-1/events?")) {
        json(response, 200, {
          events: [
            {
              ...event("event-album", "", 1),
              room: "room-1",
              type: "m.album",
              content: { caption: "two files" },
              media_items: [
                { position: 0, media_id: "media-a", filename: "a.png", mime: "image/png", size: 10, kind: "image" },
                { position: 1, media_id: "media-b", filename: "b.pdf", mime: "application/pdf", size: 20, kind: "file" },
              ],
            },
            {
              ...event("event-file", "", 2),
              room: "room-1",
              type: "m.file",
              content: { media_id: "media-c", filename: "c.txt", mime: "text/plain" },
              media_meta: { size: 30, kind: "file" },
            },
            {
              ...event("event-redacted", "", 3),
              room: "room-1",
              type: "m.file",
              redacted_at: "2026-07-16T00:01:00Z",
              content: { media_id: "secret", filename: "secret.txt" },
            },
          ],
          cursor: null,
          has_more: false,
          direction: "backward",
          through_event_id: "event-redacted",
        });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl, "--key", "test-key", "--json",
        "attachments", "list", "room-1", "--all",
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      const rows = JSON.parse(result.stdout);
      assert.deepEqual(rows.map((row) => row.media_id), ["media-a", "media-b", "media-c"]);
      assert.deepEqual(rows.map((row) => row.position), [0, 1, 0]);
      assert.equal(rows.some((row) => row.media_id === "secret"), false);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("raw Glass access preserves multipart uploads and binary downloads", async () => {
  await withTempDir(async (tempDir) => {
    const uploadBytes = Buffer.from("logo bytes\n");
    const downloadBytes = Buffer.from([0, 1, 2, 3, 255, 128, 64]);
    const source = path.join(tempDir, "logo.png");
    const destination = path.join(tempDir, "content.bin");
    await fs.writeFile(source, uploadBytes);
    let sawUpload = false;
    const mock = await startServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/v1/teams/acme/logo") {
        assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
        assert.equal(request.headers["x-audit-test"], "present");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        assert.ok(body.includes(uploadBytes));
        assert.match(body.toString("latin1"), /name="file"; filename="logo\.png"/);
        assert.match(body.toString("latin1"), /name="label"\r\n\r\nteam logo/);
        sawUpload = true;
        json(response, 200, { uploaded: true });
        return;
      }
      if (request.method === "GET" && request.url === "/api/v1/media/media-1/content") {
        response.writeHead(200, {
          ...PROTOCOL_HEADERS,
          "content-type": "application/octet-stream",
        });
        response.end(downloadBytes);
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const common = ["--api", mock.baseUrl, "--key", "test-key"];
      const upload = await runCli([
        ...common,
        "--json",
        "glass", "post", "/api/v1/teams/acme/logo",
        "--file", `file=${source}`,
        "--form", "label=team logo",
        "--header", "X-Audit-Test: present",
      ], tempDir);
      assert.equal(upload.code, 0, upload.stderr);
      assert.deepEqual(JSON.parse(upload.stdout), { uploaded: true });
      assert.equal(sawUpload, true);

      const download = await runCli([
        ...common,
        "glass", "get", "/api/v1/media/media-1/content",
        "--response", "binary",
        "--output", destination,
      ], tempDir);
      assert.equal(download.code, 0, download.stderr);
      assert.deepEqual(await fs.readFile(destination), downloadBytes);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("Carbon presence uses a single-use ticket and Glass WebSocket hello contract", async () => {
  await withTempDir(async (tempDir) => {
    let presenceFrame = null;
    let upgradedSocket = null;
    const mock = await startServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/v1/ws/ticket") {
        assert.equal(request.headers.authorization, "Bearer access-token");
        assert.equal(request.headers["x-device-id"], "cli-device");
        await requestJson(request);
        json(response, 200, { ticket: "single-use-ticket", expires_in: 60 });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    mock.server.on("upgrade", (request, socket) => {
      upgradedSocket = socket;
      const url = new URL(request.url, mock.baseUrl);
      assert.equal(url.pathname, "/ws/v1/");
      assert.equal(url.searchParams.get("ticket"), "single-use-ticket");
      assert.equal(url.searchParams.has("token"), false);
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(serverWebSocketFrame({
        type: "hello",
        subscribed_rooms: [],
        cursor: "event-cursor",
        account_cursor: "account-cursor",
        protocol_version: 1,
        protocol_min: 1,
        protocol_max: 1,
        heartbeat_interval_ms: 25_000,
        heartbeat_timeout_ms: 62_500,
      }));
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffered = consumeClientWebSocketFrames(
          Buffer.concat([buffered, chunk]),
          (text) => {
            const frame = JSON.parse(text);
            if (frame.type !== "presence") return;
            presenceFrame = frame;
            socket.write(serverWebSocketFrame({ type: "presence.ok", state: frame.state, revision: 7 }));
          },
          () => socket.end(),
        );
      });
      socket.on("error", () => {});
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl,
        "--access-token", "access-token",
        "--device-id", "cli-device",
        "--json",
        "presence", "active",
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { type: "presence.ok", state: "active", revision: 7 });
      assert.deepEqual(presenceFrame, { type: "presence", state: "active" });
    } finally {
      upgradedSocket?.destroy();
      await closeServer(mock.server);
    }
  });
});

test("Silicon listener delegates its permanent key through a single-use ticket", async () => {
  await withTempDir(async (tempDir) => {
    let upgradedSocket = null;
    const mock = await startServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/v1/ws/ticket") {
        assert.equal(request.headers["x-silicon-key"], "permanent-silicon-key");
        await requestJson(request);
        json(response, 200, { ticket: "delegated-silicon-ticket", expires_in: 60 });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    mock.server.on("upgrade", (request, socket) => {
      upgradedSocket = socket;
      const url = new URL(request.url, mock.baseUrl);
      assert.equal(url.pathname, "/ws/v1/");
      assert.equal(url.searchParams.get("ticket"), "delegated-silicon-ticket");
      assert.equal(url.searchParams.has("silicon_key"), false);
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(serverWebSocketFrame({
        type: "hello",
        subscribed_rooms: [],
        cursor: "event-cursor",
        account_cursor: "account-cursor",
        protocol_version: 1,
        protocol_min: 1,
        protocol_max: 1,
        heartbeat_interval_ms: 25_000,
        heartbeat_timeout_ms: 62_500,
      }));
      setImmediate(() => socket.end());
      socket.on("error", () => {});
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl,
        "--key", "permanent-silicon-key",
        "--json",
        "listen", "all", "--once", "--no-sync", "--no-spool",
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "");
    } finally {
      upgradedSocket?.destroy();
      await closeServer(mock.server);
    }
  });
});

test("Carbon registration completes both verified channels and binds a CLI device", async () => {
  await withTempDir(async (tempDir) => {
    const calls = [];
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      const body = request.method === "GET" ? null : await requestJson(request);
      calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: request.headers });
      if (url.pathname === "/api/v1/auth/carbon-id/available") {
        json(response, 200, { available: true, valid: true, reason: "" });
      } else if (url.pathname === "/api/v1/auth/register/email/start") {
        json(response, 202, { flow_id: "flow-1" });
      } else if (url.pathname === "/api/v1/auth/register/email/verify") {
        json(response, 200, { verified: true });
      } else if (url.pathname === "/api/v1/auth/register/phone/start") {
        json(response, 202, { flow_id: "flow-1" });
      } else if (url.pathname === "/api/v1/auth/register/phone/verify") {
        json(response, 200, { verified: true });
      } else if (url.pathname === "/api/v1/auth/register/username") {
        json(response, 201, {
          carbon: { carbon_id: "carbon-1", username: "new-carbon" },
          access: "legacy-access",
          refresh: "legacy-refresh",
        });
      } else if (url.pathname === "/api/v1/devices") {
        assert.equal(request.headers.authorization, "Bearer legacy-access");
        assert.equal(request.headers["x-device-id"], undefined);
        json(response, 201, {
          device: { device_id: "cli-device" },
          access: "bound-access",
          refresh: "bound-refresh",
        });
      } else {
        json(response, 404, { detail: request.url });
      }
    });
    try {
      const result = await runCli([
        "--api", mock.baseUrl,
        "--json",
        "auth", "register",
        "--email", "person@example.com",
        "--email-code", "111111",
        "--phone", "+15551234567",
        "--phone-code", "222222",
        "--username", "new-carbon",
        "--device-id", "cli-device",
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        carbon: { carbon_id: "carbon-1", username: "new-carbon" },
        device_id: "cli-device",
      });
      assert.deepEqual(calls.map((call) => call.path).filter((value) => value !== "/api/v1/ws/ticket"), [
        "/api/v1/auth/carbon-id/available",
        "/api/v1/auth/register/email/start",
        "/api/v1/auth/register/email/verify",
        "/api/v1/auth/register/phone/start",
        "/api/v1/auth/register/phone/verify",
        "/api/v1/auth/register/username",
        "/api/v1/devices",
      ]);
      assert.deepEqual(calls[2].body, {
        flow_id: "flow-1",
        email: "person@example.com",
        code: "111111",
      });
      assert.deepEqual(calls[4].body, {
        flow_id: "flow-1",
        phone: "+15551234567",
        code: "222222",
      });
      const config = JSON.parse(await fs.readFile(path.join(tempDir, "home", "config.json"), "utf8"));
      assert.equal(config.accessToken, "bound-access");
      assert.equal(config.refreshToken, "bound-refresh");
      assert.equal(config.deviceId, "cli-device");
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("concurrent Carbon commands serialize rotating refresh tokens", async () => {
  await withTempDir(async (tempDir) => {
    const home = path.join(tempDir, "home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({
      accessToken: "expired-access",
      refreshToken: "refresh-old",
      deviceId: "device-1",
    }));
    let staleRequests = 0;
    let refreshRequests = 0;
    let releaseStale;
    const staleBarrier = new Promise((resolve) => { releaseStale = resolve; });
    const mock = await startServer(async (request, response) => {
      if (request.url === "/api/v1/rooms/") {
        if (request.headers.authorization === "Bearer expired-access") {
          staleRequests += 1;
          if (staleRequests === 2) releaseStale();
          await staleBarrier;
          json(response, 401, { detail: "expired" });
          return;
        }
        assert.equal(request.headers.authorization, "Bearer access-new");
        json(response, 200, []);
        return;
      }
      if (request.url === "/api/v1/auth/refresh") {
        refreshRequests += 1;
        assert.deepEqual(await requestJson(request), { refresh: "refresh-old" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        json(response, 200, { access: "access-new", refresh: "refresh-new" });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const command = ["--api", mock.baseUrl, "--json", "rooms", "list"];
      const [first, second] = await Promise.all([
        runCli(command, tempDir),
        runCli(command, tempDir),
      ]);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(JSON.parse(first.stdout), []);
      assert.deepEqual(JSON.parse(second.stdout), []);
      assert.equal(staleRequests, 2);
      assert.equal(refreshRequests, 1);
      const config = JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8"));
      assert.equal(config.accessToken, "access-new");
      assert.equal(config.refreshToken, "refresh-new");
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("a rejected Silicon key opens a shared request circuit until credentials change", async () => {
  await withTempDir(async (tempDir) => {
    let requests = 0;
    const mock = await startServer(async (request, response) => {
      if (request.url !== "/api/v1/rooms/") {
        json(response, 404, { detail: request.url });
        return;
      }
      requests += 1;
      if (request.headers["x-silicon-key"] === "valid-key") {
        json(response, 200, []);
      } else {
        json(response, 401, { detail: "invalid key" });
      }
    });
    try {
      const invalid = ["--api", mock.baseUrl, "--key", "invalid-key", "--json", "rooms", "list"];
      const first = await runCli(invalid, tempDir);
      const second = await runCli(invalid, tempDir);
      assert.equal(first.code, 1);
      assert.equal(second.code, 1);
      assert.equal(requests, 1);
      assert.match(second.stderr, /waiting for a key change/i);

      const repaired = await runCli(
        ["--api", mock.baseUrl, "--key", "valid-key", "--json", "rooms", "list"],
        tempDir,
      );
      assert.equal(repaired.code, 0, repaired.stderr);
      assert.equal(requests, 2);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("first-class frontend parity commands keep Glass routes and mutation identities", async () => {
  await withTempDir(async (tempDir) => {
    const calls = [];
    let checkoutAttempts = 0;
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      const body = request.method === "GET" ? null : await requestJson(request);
      calls.push({ method: request.method, path: url.pathname, body });
      if (url.pathname === "/api/v1/teams/acme/billing/checkout") {
        checkoutAttempts += 1;
        if (checkoutAttempts === 1) {
          json(response, 503, { detail: "temporary checkout outage" });
        } else {
          json(response, 200, { checkout_url: "https://payments.example/checkout-1", payment_id: "pay-1" });
        }
        return;
      }
      if (url.pathname === "/api/v1/moderation/reports") {
        json(response, 201, { id: 1, report_id: "report-1", status: "open" });
        return;
      }
      if (url.pathname === "/api/v1/carbons/me/take-back-policy") {
        json(response, 200, body);
        return;
      }
      if (url.pathname === "/api/v1/silicons/silicon-1/browser-session") {
        json(response, 200, { session_id: "browser-1", viewer_url: "https://browser.example/1", reused: false });
        return;
      }
      if (url.pathname === "/api/v1/invites/public-token") {
        json(response, 200, { token: "public-token", team: { slug: "acme" } });
        return;
      }
      json(response, 404, { detail: request.url });
    });
    try {
      const common = ["--api", mock.baseUrl, "--access-token", "access", "--device-id", "device", "--json"];
      const checkout = await runCli([
        ...common,
        "teams", "checkout", "acme", "--cycle-ids", "1,2", "--return-url", "https://app.example/billing",
      ], tempDir);
      assert.equal(checkout.code, 0, checkout.stderr);
      assert.equal(JSON.parse(checkout.stdout).payment_id, "pay-1");
      const checkoutCalls = calls.filter((call) => call.path.endsWith("/billing/checkout"));
      assert.equal(checkoutCalls.length, 2);
      assert.match(checkoutCalls[0].body.idempotency_key, /^cli_[a-f0-9]{32}$/);
      assert.equal(checkoutCalls[1].body.idempotency_key, checkoutCalls[0].body.idempotency_key);
      assert.deepEqual(checkoutCalls[0].body.cycle_ids, [1, 2]);
      assert.equal(checkoutCalls[0].body.slug, undefined);

      const report = await runCli([
        ...common,
        "moderation", "report", "carbon", "carbon-2", "--event", "event-9", "--reason", "spam",
      ], tempDir);
      assert.equal(report.code, 0, report.stderr);
      const reportCall = calls.find((call) => call.path === "/api/v1/moderation/reports");
      assert.match(reportCall.body.client_id, /^cli_[a-f0-9]{32}$/);

      const policy = await runCli([
        ...common,
        "take-back-policy", "set", "--enabled", "false", "--unread-threshold", "3", "--unread-duration", "90",
      ], tempDir);
      assert.equal(policy.code, 0, policy.stderr);
      assert.deepEqual(JSON.parse(policy.stdout), {
        enabled: false,
        unread_threshold_msgs: 3,
        unread_duration_secs: 90,
      });

      const browser = await runCli([...common, "browser-session", "open", "silicon-1"], tempDir);
      assert.equal(browser.code, 0, browser.stderr);
      assert.equal(JSON.parse(browser.stdout).session_id, "browser-1");

      const invite = await runCli(["--api", mock.baseUrl, "--json", "invites", "show", "public-token"], tempDir);
      assert.equal(invite.code, 0, invite.stderr);
      assert.equal(JSON.parse(invite.stdout).team.slug, "acme");
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("durable work help is available before authentication", async () => {
  await withTempDir(async (tempDir) => {
    for (const args of [["work", "--help"], ["work", "task", "--help"]]) {
      const result = await runCli(args, tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Durable work updates/);
      assert.match(result.stdout, /work blocker create\|resolve/);
      assert.doesNotMatch(result.stderr, /authentication|API key|access token/i);
    }
  });
});

test("durable work commands preserve the complete task and work-event REST contract", async () => {
  await withTempDir(async (tempDir) => {
    const calls = [];
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      const body = request.method === "GET" ? null : await requestJson(request);
      calls.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
      });
      json(response, request.method === "POST" ? 201 : 200, {
        ok: true,
        task_id: "task-fitness",
        revision: calls.length,
      });
    });
    try {
      const common = [
        "--api", mock.baseUrl,
        "--key", "silicon-key",
        "--json",
        "work",
      ];
      const invoke = async (...args) => {
        const result = await runCli([...common, ...args], tempDir);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).ok, true);
      };
      const timing = {
        estimate_seconds: 21_600,
        active_elapsed_seconds: 1_200,
        timer_state: "running",
        timer_updated_at: "2026-07-23T08:20:00Z",
      };
      const historyEntry = (overrides = {}) => ({
        history_id: "history-1",
        kind: "note",
        summary: "Work progressed",
        revision: 1,
        created_at: "2026-07-23T08:20:00Z",
        ...overrides,
      });
      const eventBase = {
        schema_version: 1,
        task_id: "task-fitness",
        room_id: "room-fitness",
        task_title: "Build Fitness App",
        timing,
        history: [],
        revision: 1,
        created_at: "2026-07-23T08:20:00Z",
        updated_at: "2026-07-23T08:20:00Z",
      };
      const task = {
        schema_version: 1,
        task_id: "task-fitness",
        room_id: "room-fitness",
        title: "Build Fitness App",
        description: "Build and verify the application",
        state: "running",
        estimate_seconds: 21_600,
        active_elapsed_seconds: 0,
        timer_state: "running",
        timer_updated_at: "2026-07-23T08:00:00Z",
        todos: [],
        history: [],
        revision: 1,
        created_at: "2026-07-23T08:00:00Z",
        updated_at: "2026-07-23T08:00:00Z",
      };
      const taskPatch = {
        description: "UI completed; data flow is now being implemented",
        active_elapsed_seconds: 1_200,
        history: [
          historyEntry({
            history_id: "history-ui-complete",
            kind: "description_updated",
            summary: "UI completed",
            blocks: [{ type: "text", body: "Starting the data layer", format: "plain" }],
          }),
        ],
        revision: 2,
      };
      const todo = {
        todo_id: "todo-ui",
        title: "UI/UX",
        description: "Design the main flow",
        state: "yet_to_start",
        revision: 1,
        history: [],
        created_at: "2026-07-23T08:00:00Z",
        updated_at: "2026-07-23T08:00:00Z",
      };
      const todoPatch = {
        state: "completed",
        description: "Main flow designed and reviewed",
        history: [
          historyEntry({
            history_id: "history-todo-reviewed",
            kind: "todo_updated",
            summary: "Review passed",
            entity_id: "todo-ui",
            state: "completed",
          }),
        ],
        revision: 2,
      };
      const milestone = {
        ...eventBase,
        work_event_id: "event-ui-done",
        kind: "milestone",
        body: "UI/UX done",
        blocks: [
          { type: "text", body: "UI/UX step completed. Onto code now.", format: "plain" },
          { type: "image", media_id: "media-preview", alt: "Approved preview" },
        ],
      };
      const milestonePath = path.join(tempDir, "milestone.json");
      await fs.writeFile(milestonePath, JSON.stringify(milestone));
      const blocker = {
        ...eventBase,
        work_event_id: "event-blocker-color",
        kind: "blocker",
        body: "Should the primary color be red or blue?",
        blocks: [
          { type: "text", body: "Should the primary color be red or blue?", format: "plain" },
          { type: "image", media_id: "media-options", alt: "Color options" },
          { type: "remote_browser", session_id: "browser-1", url: "https://preview.example" },
        ],
        blocker_id: "blocker-color",
        state: "open",
        resolved_at: null,
        timing: { ...timing, timer_state: "paused", timer_pause_reason: "blocker" },
      };
      const blockerResolution = {
        state: "resolved",
        resolved_at: "2026-07-23T08:40:00Z",
        body: "Use blue",
        blocks: [
          { type: "text", body: "Use blue", format: "plain" },
          { type: "file", media_id: "media-brand-guide", filename: "brand.pdf" },
        ],
        revision: 2,
      };
      const workerGroup = {
        ...eventBase,
        work_event_id: "event-workers",
        kind: "worker_group",
        body: "Started 3 workers",
        blocks: [],
        group_id: "group-social",
        workers: [],
      };
      const workerGroupPatch = {
        body: "All three social tasks completed",
        history: [historyEntry({ history_id: "history-workers-complete", kind: "worker_updated" })],
        revision: 4,
      };
      const worker = {
        worker_id: "worker-linkedin",
        invocation_id: "invoke-linkedin-1",
        name: "LinkedIn post",
        state: "in_progress",
        description: "Drafting the post",
        revision: 1,
        history: [],
        created_at: "2026-07-23T08:45:00Z",
        updated_at: "2026-07-23T08:45:00Z",
      };
      const workerPatch = {
        state: "completed",
        description: "Post drafted and scheduled",
        history: [
          historyEntry({
            history_id: "history-worker-approved",
            kind: "worker_updated",
            summary: "Draft approved",
            entity_id: "invoke-linkedin-1",
          }),
        ],
        revision: 2,
        updated_at: "2026-07-23T09:00:00Z",
      };
      const call = {
        ...eventBase,
        work_event_id: "event-call-saket",
        kind: "call",
        body: "Calling Saket's manager",
        blocks: [],
        call_id: "call-saket",
        direction: "outbound",
        target_kind: "manager",
        target_id: "saket",
        target_name: "Saket's manager",
        state: "connecting",
        transcript: [],
      };
      const callPatch = {
        state: "completed",
        transcript: [
          {
            transcript_id: "transcript-1",
            speaker_kind: "silicon",
            speaker_id: "saket-manager",
            speaker_name: "Saket's manager",
            body: "Approved",
            blocks: [
              { type: "text", body: "Approved", format: "plain" },
              { type: "file", media_id: "media-approval", filename: "approval.pdf" },
            ],
            revision: 1,
            created_at: "2026-07-23T09:10:00Z",
            updated_at: "2026-07-23T09:10:00Z",
          },
        ],
        revision: 2,
      };
      const completion = {
        ...eventBase,
        work_event_id: "event-complete",
        kind: "completion",
        body: "Fitness app delivered and verified",
        blocks: [],
        timing: { ...timing, active_elapsed_seconds: 17_532, timer_state: "stopped" },
      };
      const failure = {
        ...eventBase,
        work_event_id: "event-failure",
        kind: "failure",
        body: "Build could not recover",
        blocks: [{ type: "file", media_id: "media-build-log", filename: "build.log" }],
        timing: { ...timing, timer_state: "stopped" },
      };
      const cancellation = {
        ...eventBase,
        work_event_id: "event-cancel",
        kind: "cancellation",
        body: "Cancelled by the requester",
        blocks: [],
        timing: { ...timing, timer_state: "stopped" },
      };

      await invoke("task", "create", "--data", JSON.stringify(task));
      await invoke(
        "task", "list", "room-fitness", "--state", "running", "--cursor", "next page", "--limit", "25",
      );
      await invoke("task", "show", "task-fitness");
      await invoke("task", "patch", "task-fitness", "--data", JSON.stringify(taskPatch));
      await invoke("todo", "add", "task-fitness", "--data", JSON.stringify(todo));
      await invoke("todo", "patch", "task-fitness", "todo-ui", "--data", JSON.stringify(todoPatch));
      await invoke("milestone", "update", "task-fitness", "--data-file", milestonePath);
      await invoke("blocker", "create", "task-fitness", "--data", JSON.stringify(blocker));
      await invoke(
        "blocker", "resolve", "task-fitness", "blocker-color", "--data", JSON.stringify(blockerResolution),
      );
      await invoke("worker-group", "create", "task-fitness", "--data", JSON.stringify(workerGroup));
      await invoke(
        "worker-group", "patch", "task-fitness", "group-social", "--data", JSON.stringify(workerGroupPatch),
      );
      await invoke("worker", "create", "task-fitness", "group-social", "--data", JSON.stringify(worker));
      await invoke(
        "worker", "patch", "task-fitness", "group-social", "invoke-linkedin-1", "--data", JSON.stringify(workerPatch),
      );
      await invoke("call", "create", "task-fitness", "--data", JSON.stringify(call));
      await invoke("call", "patch", "task-fitness", "call-saket", "--data", JSON.stringify(callPatch));
      await invoke("complete", "task-fitness", "--data", JSON.stringify(completion));
      await invoke("fail", "task-fitness", "--data", JSON.stringify(failure));
      await invoke("cancel", "task-fitness", "--data", JSON.stringify(cancellation));

      const durablePosts = calls.filter((call) => call.method === "POST");
      assert.equal(durablePosts.length, 11);
      for (const call of durablePosts) {
        assert.match(call.body.client_id, /^cli_[a-f0-9]{32}$/);
        delete call.body.client_id;
      }

      assert.deepEqual(calls, [
        { method: "POST", path: "/api/v1/work/tasks", query: {}, body: task },
        {
          method: "GET",
          path: "/api/v1/work/tasks",
          query: { room_id: "room-fitness", state: "running", cursor: "next page", limit: "25" },
          body: null,
        },
        { method: "GET", path: "/api/v1/work/tasks/task-fitness", query: {}, body: null },
        { method: "PATCH", path: "/api/v1/work/tasks/task-fitness", query: {}, body: taskPatch },
        { method: "POST", path: "/api/v1/work/tasks/task-fitness/todos", query: {}, body: todo },
        {
          method: "PATCH",
          path: "/api/v1/work/tasks/task-fitness/todos/todo-ui",
          query: {},
          body: todoPatch,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/milestones",
          query: {},
          body: milestone,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/blockers",
          query: {},
          body: blocker,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/blockers/blocker-color/resolve",
          query: {},
          body: blockerResolution,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/worker-groups",
          query: {},
          body: workerGroup,
        },
        {
          method: "PATCH",
          path: "/api/v1/work/tasks/task-fitness/worker-groups/group-social",
          query: {},
          body: workerGroupPatch,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/worker-groups/group-social/invocations",
          query: {},
          body: worker,
        },
        {
          method: "PATCH",
          path: "/api/v1/work/tasks/task-fitness/worker-groups/group-social/invocations/invoke-linkedin-1",
          query: {},
          body: workerPatch,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/calls",
          query: {},
          body: call,
        },
        {
          method: "PATCH",
          path: "/api/v1/work/tasks/task-fitness/calls/call-saket",
          query: {},
          body: callPatch,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/complete",
          query: {},
          body: completion,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/fail",
          query: {},
          body: failure,
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/cancel",
          query: {},
          body: cancellation,
        },
      ]);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("standalone work calls use room-scoped create and direct call patch routes", async () => {
  await withTempDir(async (tempDir) => {
    const calls = [];
    const mock = await startServer(async (request, response) => {
      const body = await requestJson(request);
      calls.push({ method: request.method, path: request.url, body });
      json(response, request.method === "POST" ? 201 : 200, {
        ...body,
        schema_version: 1,
        work_event_id: "event-standalone-call",
        task_id: null,
        task_title: null,
        timing: null,
        room_id: body.room_id ?? "room-fleet",
        kind: "call",
        call_id: "call-fleet",
      });
    });
    try {
      const common = [
        "--api", mock.baseUrl,
        "--key", "silicon-key",
        "--json",
        "work", "call",
      ];
      const missingRoom = await runCli([
        ...common,
        "create",
        "--data", JSON.stringify({
          kind: "call",
          call_id: "call-invalid",
        }),
      ], tempDir);
      assert.equal(missingRoom.code, 2);
      assert.match(missingRoom.stderr, /requires a non-empty room_id/);
      assert.equal(calls.length, 0);

      const createPayload = {
        room_id: "room-fleet",
        work_event_id: "event-standalone-call",
        kind: "call",
        call_id: "call-fleet",
        direction: "outbound",
        target_kind: "manager",
        target_id: "architecture-manager",
        target_name: "Architecture manager",
        state: "connecting",
        body: "Calling Architecture manager",
        blocks: [],
        transcript: [],
      };
      const created = await runCli([
        ...common,
        "create",
        "--data", JSON.stringify(createPayload),
      ], tempDir);
      assert.equal(created.code, 0, created.stderr);

      const patchPayload = {
        state: "completed",
        transcript: [{
          transcript_id: "line-1",
          speaker_kind: "manager",
          speaker_id: "architecture-manager",
          speaker_name: "Architecture manager",
          body: "Approved",
          blocks: [],
          revision: 1,
        }],
      };
      const patched = await runCli([
        ...common,
        "patch", "call-fleet",
        "--data", JSON.stringify(patchPayload),
      ], tempDir);
      assert.equal(patched.code, 0, patched.stderr);

      assert.match(calls[0].body.client_id, /^cli_[a-f0-9]{32}$/);
      delete calls[0].body.client_id;
      assert.deepEqual(calls, [
        {
          method: "POST",
          path: "/api/v1/work/calls",
          body: createPayload,
        },
        {
          method: "PATCH",
          path: "/api/v1/work/calls/call-fleet",
          body: patchPayload,
        },
      ]);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("work POST mutations reuse a journaled client id and respect an explicit override", async () => {
  await withTempDir(async (tempDir) => {
    const requests = [];
    const mock = await startServer(async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/v1/work/tasks");
      const payload = await requestJson(request);
      requests.push(payload);
      if (requests.length === 1) {
        json(response, 500, { detail: "response was lost" });
        return;
      }
      json(response, 201, { ok: true, task_id: `task-${requests.length}` });
    });
    try {
      const basePayload = {
        schema_version: 1,
        room_id: "room-fitness",
        title: "Build Fitness App",
        description: "Build and verify the application",
        state: "running",
        estimate_seconds: 21_600,
      };
      const common = [
        "--api", mock.baseUrl,
        "--key", "silicon-key",
        "--json",
        "work", "task", "create",
      ];
      const first = await runCli([...common, "--data", JSON.stringify(basePayload)], tempDir);
      assert.equal(first.code, 1);
      const retried = await runCli([...common, "--data", JSON.stringify(basePayload)], tempDir);
      assert.equal(retried.code, 0, retried.stderr);
      assert.match(requests[0].client_id, /^cli_[a-f0-9]{32}$/);
      assert.equal(requests[1].client_id, requests[0].client_id);

      const explicit = await runCli([
        ...common,
        "--data", JSON.stringify({ ...basePayload, title: "Build Fitness App v2" }),
        "--client-id", "work-task-explicit-1",
      ], tempDir);
      assert.equal(explicit.code, 0, explicit.stderr);
      assert.equal(requests[2].client_id, "work-task-explicit-1");
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("work estimate inputs add the 5 percent buffer without changing the wire schema", async () => {
  await withTempDir(async (tempDir) => {
    const requests = [];
    const mock = await startServer(async (request, response) => {
      const payload = await requestJson(request);
      requests.push({ method: request.method, path: request.url, payload });
      json(response, 201, {
        ok: true,
        task_id: "task-fitness",
        ...(request.url.endsWith("/milestones") ? { work_event_id: "event-ui" } : {}),
      });
    });
    try {
      const common = ["--api", mock.baseUrl, "--key", "silicon-key", "--json", "work"];
      const task = await runCli([
        ...common,
        "task", "create",
        "--data", JSON.stringify({
          schema_version: 1,
          room_id: "room-fitness",
          title: "Build Fitness App",
          realistic_estimate_seconds: 100,
        }),
        "--client-id", "task-estimate-1",
      ], tempDir);
      assert.equal(task.code, 0, task.stderr);

      const milestone = await runCli([
        ...common,
        "milestone", "update", "task-fitness",
        "--data", JSON.stringify({
          work_event_id: "event-ui",
          kind: "milestone",
          body: "UI complete",
          timing: {
            realistic_estimate_seconds: 200,
            active_elapsed_seconds: 40,
            timer_state: "running",
            timer_updated_at: "2026-07-23T08:00:00Z",
          },
        }),
        "--client-id", "milestone-estimate-1",
      ], tempDir);
      assert.equal(milestone.code, 0, milestone.stderr);

      assert.deepEqual(requests, [
        {
          method: "POST",
          path: "/api/v1/work/tasks",
          payload: {
            schema_version: 1,
            room_id: "room-fitness",
            title: "Build Fitness App",
            estimate_seconds: 105,
            client_id: "task-estimate-1",
          },
        },
        {
          method: "POST",
          path: "/api/v1/work/tasks/task-fitness/milestones",
          payload: {
            work_event_id: "event-ui",
            kind: "milestone",
            body: "UI complete",
            timing: {
              estimate_seconds: 210,
              active_elapsed_seconds: 40,
              timer_state: "running",
              timer_updated_at: "2026-07-23T08:00:00Z",
            },
            client_id: "milestone-estimate-1",
          },
        },
      ]);

      const conflict = await runCli([
        ...common,
        "task", "create",
        "--data", JSON.stringify({
          room_id: "room-fitness",
          title: "Conflicting estimate",
          realistic_estimate_seconds: 100,
          estimate_seconds: 106,
        }),
      ], tempDir);
      assert.equal(conflict.code, 2);
      assert.match(conflict.stderr, /conflicts with the 5% buffered realistic estimate \(105\)/);

      const invalid = await runCli([
        ...common,
        "milestone", "update", "task-fitness",
        "--data", JSON.stringify({
          body: "Invalid estimate",
          timing: { realistic_estimate_seconds: -1 },
        }),
      ], tempDir);
      assert.equal(invalid.code, 2);
      assert.match(invalid.stderr, /must be a non-negative finite number/);

      const ambiguous = await runCli([
        ...common,
        "milestone", "update", "task-fitness",
        "--data", JSON.stringify({
          body: "Ambiguous estimate location",
          realistic_estimate_seconds: 100,
          timing: { timer_state: "running" },
        }),
      ], tempDir);
      assert.equal(ambiguous.code, 2);
      assert.match(ambiguous.stderr, /payload with timing must place estimate fields inside timing/);
      assert.equal(requests.length, 2);
    } finally {
      await closeServer(mock.server);
    }
  });
});

test("manager progress preserves stable activity history identity", async () => {
  await withTempDir(async (tempDir) => {
    let captured = null;
    const mock = await startServer(async (request, response, baseUrl) => {
      const url = new URL(request.url, baseUrl);
      captured = {
        method: request.method,
        path: url.pathname,
        body: await requestJson(request),
      };
      json(response, 200, { ok: true });
    });
    try {
      const missingGroup = await runCli([
        "--api", mock.baseUrl,
        "--key", "silicon-key",
        "progress", "room-fitness", "thinking", "Starting",
      ], tempDir);
      assert.equal(missingGroup.code, 2);
      assert.match(missingGroup.stderr, /requires --group/);
      assert.equal(captured, null);

      const result = await runCli([
        "--api", mock.baseUrl,
        "--key", "silicon-key",
        "--json",
        "progress", "room-fitness", "spawning_worker", "Starting the UI worker",
        "--group", "run-fitness",
        "--task", "task-fitness",
        "--frame", "activity-2",
        "--revision", "3",
        "--at", "2026-07-23T08:20:00Z",
        "--pct", "0",
      ], tempDir);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(captured, {
        method: "POST",
        path: "/api/v1/rooms/room-fitness/progress",
        body: {
          state: "spawning_worker",
          note: "Starting the UI worker",
          progress_group_id: "run-fitness",
          task_id: "task-fitness",
          frame_id: "activity-2",
          revision: 3,
          occurred_at: "2026-07-23T08:20:00Z",
          progress_pct: 0,
        },
      });
    } finally {
      await closeServer(mock.server);
    }
  });
});
