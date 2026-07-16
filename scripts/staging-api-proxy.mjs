#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const GLASS_COOKIE_NAMES = new Set(["__Secure-silicon_refresh", "silicon_refresh"]);
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function glassCookieHeader(value) {
  if (!value) return "";
  return value
    .split(";")
    .map((item) => item.trim())
    .filter((item) => GLASS_COOKIE_NAMES.has(item.split("=", 1)[0]))
    .join("; ");
}

export function upstreamHeaders(headers, { canonicalHost, canonicalOrigin }) {
  const result = { ...headers, host: canonicalHost };
  if (result.origin) result.origin = canonicalOrigin;

  // Production UI and API use different hostnames, so UI analytics cookies are
  // never sent to Glass. Local ports share one 127.0.0.1 cookie jar. Strip
  // those UI cookies while preserving only Glass's refresh-cookie contract;
  // analytics current-URL values otherwise legitimately trip AWS WAF's
  // EC2MetaDataSSRF_COOKIE rule during local staging acceptance.
  const cookie = glassCookieHeader(result.cookie);
  if (cookie) result.cookie = cookie;
  else delete result.cookie;
  return result;
}

export function downstreamHeaders(headers, requestOrigin, { localOrigin }) {
  const result = { ...headers };
  delete result["access-control-allow-origin"];
  delete result["access-control-allow-credentials"];
  if (requestOrigin !== localOrigin) return result;

  result["access-control-allow-origin"] = localOrigin;
  result["access-control-allow-credentials"] = "true";
  const vary = String(result.vary ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!vary.some((value) => value.toLowerCase() === "origin")) vary.push("Origin");
  result.vary = vary.join(", ");
  return result;
}

export function configuration(environ = process.env) {
  const upstreamHost = (environ.SILICON_STAGING_PROXY_UPSTREAM_HOST || "").trim();
  const canonicalHost = (
    environ.SILICON_STAGING_PROXY_CANONICAL_HOST || "glass.teamofsilicons.com"
  ).trim();
  const canonicalOrigin = (
    environ.SILICON_STAGING_PROXY_CANONICAL_ORIGIN || "https://interface.teamofsilicons.com"
  ).trim();
  const localOrigin = (
    environ.SILICON_STAGING_PROXY_UI_ORIGIN || "http://127.0.0.1:3001"
  ).trim();
  const listenHost = (environ.SILICON_STAGING_PROXY_LISTEN_HOST || "127.0.0.1").trim();
  const listenPort = Number(environ.SILICON_STAGING_PROXY_LISTEN_PORT || "8002");
  let localOriginUrl;
  try {
    localOriginUrl = new URL(localOrigin);
  } catch {
    localOriginUrl = null;
  }
  if (
    !HOSTNAME.test(upstreamHost) ||
    !HOSTNAME.test(canonicalHost) ||
    canonicalOrigin !== `https://${new URL(canonicalOrigin).hostname}` ||
    !localOriginUrl ||
    localOriginUrl.origin !== localOrigin ||
    localOriginUrl.protocol !== "http:" ||
    localOriginUrl.hostname !== "127.0.0.1" ||
    !localOriginUrl.port ||
    listenHost !== "127.0.0.1" ||
    !Number.isInteger(listenPort) ||
    listenPort < 1024 ||
    listenPort > 65535
  ) {
    throw new Error("invalid staging proxy configuration");
  }
  return {
    upstreamHost,
    canonicalHost,
    canonicalOrigin,
    localOrigin,
    listenHost,
    listenPort,
  };
}

export function createStagingProxy(config) {
  const server = http.createServer((request, response) => {
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== config.localOrigin) {
      response.writeHead(403, {
        "cache-control": "no-store",
        "content-type": "application/json",
        vary: "Origin",
      });
      response.end('{"detail":"forbidden local origin"}');
      return;
    }
    const upstream = https.request(
      {
        hostname: config.upstreamHost,
        port: 443,
        servername: config.canonicalHost,
        rejectUnauthorized: true,
        method: request.method,
        path: request.url,
        headers: upstreamHeaders(request.headers, config),
      },
      (upstreamResponse) => {
        const headers = downstreamHeaders(
          upstreamResponse.headers,
          requestOrigin,
          config,
        );
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, clientSocket, head) => {
    if (request.headers.origin && request.headers.origin !== config.localOrigin) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstreamSocket = tls.connect(
      {
        host: config.upstreamHost,
        port: 443,
        servername: config.canonicalHost,
        rejectUnauthorized: true,
      },
      () => {
        const headers = upstreamHeaders(request.headers, config);
        let prelude = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
        for (const [name, value] of Object.entries(headers)) {
          if (Array.isArray(value)) {
            for (const item of value) prelude += `${name}: ${item}\r\n`;
          } else if (value !== undefined) {
            prelude += `${name}: ${value}\r\n`;
          }
        }
        upstreamSocket.write(`${prelude}\r\n`);
        if (head.length) upstreamSocket.write(head);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      },
    );
    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstreamSocket.destroy());
  });
  return server;
}

export function main(environ = process.env) {
  const config = configuration(environ);
  const server = createStagingProxy(config);
  server.listen(config.listenPort, config.listenHost, () => {
    process.stdout.write(
      `staging API proxy ready on http://${config.listenHost}:${config.listenPort}\n`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    process.stderr.write("staging API proxy refused invalid configuration\n");
    process.exitCode = 64;
  }
}
