// Route B — consume a sealed ticket and proxy the HTML same-origin (Dope #116).
//
//   GET /api/media/[id]/html?t=<sealed>
//
// Decrypts + verifies the ticket (AAD-bound to the PATH id), atomically
// consumes its single-use marker (GETDEL), then fetches the upstream HTML
// server-side under a hard timeout + byte cap and returns it with a strict
// header-only CSP + sandbox. EVERY response — success OR friendly error —
// carries the full security header set. The ticket value is NEVER logged.
import type { NextRequest } from "next/server";

import {
  htmlError,
  isAllowedPreviewUrl,
  jtiKey,
  kvGetDel,
  maxBytes,
  open,
  securityHeaders,
  storeConfigured,
  ticketAad,
  type HtmlTicketPayload,
} from "@/lib/html-preview-ticket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 10_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const token = req.nextUrl.searchParams.get("t");
  if (!token) return htmlError(403, "This preview link is invalid.");

  // 1) Decrypt + verify. AAD is bound to the PATH id, so a ticket sealed for a
  //    different media id fails the GCM tag check here. Missing secret → open()
  //    throws → 403. Any failure → 403 (never distinguishes tamper reasons).
  let ticket: HtmlTicketPayload;
  try {
    ticket = open(token, ticketAad(id));
  } catch {
    return htmlError(403, "This preview link is invalid.");
  }

  // 2) Structural validation. media_id must match the path; host must match the
  //    url and stay on the allow-list; expiry is a distinct 410.
  if (ticket.media_id !== id) return htmlError(403, "This preview link is invalid.");
  let urlHost: string;
  try {
    const u = new URL(ticket.url);
    urlHost = u.hostname;
    if (!isAllowedPreviewUrl(u)) {
      return htmlError(403, "This preview link is invalid.");
    }
  } catch {
    return htmlError(403, "This preview link is invalid.");
  }
  if (ticket.host !== urlHost) {
    return htmlError(403, "This preview link is invalid.");
  }
  if (ticket.exp <= Math.floor(Date.now() / 1000)) {
    return htmlError(410, "This preview link has expired. Reopen the file to try again.");
  }

  // 3) Atomic single-use consume. GETDEL lets exactly one caller observe the
  //    marker; replays see null → 410. Store unavailable → FAIL CLOSED 503.
  //    (Headers are sent on both branches via htmlError.)
  if (!storeConfigured()) return htmlError(503, "Preview is temporarily unavailable.");
  const marker = await kvGetDel(jtiKey(ticket.jti));
  if (marker === null) {
    // Could be replay OR a store error — both must refuse. Treat as consumed/
    // gone (fail closed): the caller re-mints a fresh ticket to retry.
    return htmlError(410, "This preview link has already been used. Reopen the file to try again.");
  }

  // 4) Fetch upstream with a hard timeout AND a byte cap. `redirect: "error"`
  //    blocks redirect-based SSRF to a non-allow-listed host.
  const cap = maxBytes();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let upstream: Response;
    try {
      upstream = await fetch(ticket.url, {
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "text/html" },
      });
    } catch {
      return htmlError(502, "Could not load this file for preview.");
    }
    if (!upstream.ok || !upstream.body) {
      return htmlError(502, "Could not load this file for preview.");
    }

    // Reject on a declared Content-Length over the cap before reading a byte.
    const declared = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) {
      controller.abort();
      return htmlError(413, "This file is too large to preview.");
    }

    // Stream with a running cap so a lying/absent Content-Length can't blow past
    // the limit — we NEVER return a body that exceeded the cap.
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > cap) {
            controller.abort();
            return htmlError(413, "This file is too large to preview.");
          }
          chunks.push(value);
        }
      }
    } catch {
      return htmlError(502, "Could not load this file for preview.");
    }

    return new Response(Buffer.concat(chunks), { status: 200, headers: securityHeaders() });
  } finally {
    clearTimeout(timer);
  }
}
