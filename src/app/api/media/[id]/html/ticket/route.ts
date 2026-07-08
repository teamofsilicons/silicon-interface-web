// Route A — mint a single-use, sealed HTML-preview ticket (Dope #116).
//
//   POST /api/media/[id]/html/ticket
//
// Forwards the caller's auth to Glass (Glass enforces authz), validates the
// media is a ready text/html object served from an allow-listed host under the
// size cap, atomically records a single-use marker in Upstash (FAIL CLOSED),
// and returns a sealed ticket pointing at the same-origin consume route. The
// browser never sees the presigned URL and never iframes it directly.
import type { NextRequest } from "next/server";

import {
  apiBase,
  isAllowedPreviewUrl,
  jtiKey,
  kvSetNx,
  maxBytes,
  newJti,
  seal,
  storeConfigured,
  ticketAad,
  ttlSeconds,
  type HtmlTicketPayload,
} from "@/lib/html-preview-ticket";
import type { MediaObject } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const HTML_EXT = /\.html?$/i;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  // 1) Forward the incoming auth headers to Glass and let it enforce authz.
  const auth = req.headers.get("authorization");
  const silKey = req.headers.get("x-silicon-key");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth) headers["Authorization"] = auth;
  if (silKey) headers["X-Silicon-Key"] = silKey;

  let glassResp: Response;
  try {
    glassResp = await fetch(`${apiBase()}/api/v1/media/${encodeURIComponent(id)}`, {
      headers,
      cache: "no-store",
    });
  } catch {
    return json({ error: "upstream_unavailable" }, 502);
  }
  if (!glassResp.ok) {
    // Mirror Glass's decision — pass client-error statuses (401/403/404)
    // through, collapse upstream 5xx to 502. NEVER mint when Glass declined.
    const status =
      glassResp.status >= 400 && glassResp.status < 500 ? glassResp.status : 502;
    return json({ error: "not_authorized" }, status);
  }

  let detail: { media?: MediaObject; download_url?: string | null };
  try {
    detail = (await glassResp.json()) as typeof detail;
  } catch {
    return json({ error: "bad_upstream_response" }, 502);
  }
  const media = detail.media;
  const downloadUrl = detail.download_url ?? null;

  // 2) Must be ready with a usable presigned URL.
  if (!media || media.status !== "ready" || !downloadUrl) {
    return json({ error: "not_ready" }, 409);
  }

  // 3) text/html only — either by mime or by a .html/.htm URL extension.
  //    (Glass MediaObject has no filename, so the extension is read off the
  //    presigned URL path.) The proxy re-serves as text/html under sandbox+CSP.
  const mime = (media.mime || "").toLowerCase();
  const mimeIsHtml = mime === "text/html" || mime.startsWith("text/html;");
  let host: string;
  let urlPath: string;
  try {
    const u = new URL(downloadUrl);
    if (!isAllowedPreviewUrl(u)) {
      return json({ error: "host_not_allowed" }, 400);
    }
    host = u.hostname;
    urlPath = u.pathname;
  } catch {
    return json({ error: "bad_download_url" }, 400);
  }
  if (!mimeIsHtml && !HTML_EXT.test(urlPath)) {
    return json({ error: "unsupported_media_type" }, 415);
  }

  // 4) Reject over-cap objects up front when the size is known.
  const cap = maxBytes();
  if (typeof media.size === "number" && media.size > cap) {
    return json({ error: "too_large" }, 413);
  }

  // 5) Seal the ticket. Missing HTML_PREVIEW_TICKET_SECRET → seal() throws → 503.
  const ttl = ttlSeconds();
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const jti = newJti();
  const payload: HtmlTicketPayload = {
    v: 1,
    jti,
    media_id: id,
    exp,
    host,
    url: downloadUrl,
    mime: mimeIsHtml ? mime : "text/html",
    ...(typeof media.size === "number" ? { size: media.size } : {}),
  };
  let sealed: string;
  try {
    sealed = seal(payload, ticketAad(id));
  } catch {
    return json({ error: "ticket_secret_unavailable" }, 503);
  }

  // 6) Claim the single-use marker. FAIL CLOSED: unconfigured store or a write
  //    that did not land (NX collision / error) → do NOT hand back a ticket.
  if (!storeConfigured()) {
    return json({ error: "store_unavailable" }, 503);
  }
  const stored = await kvSetNx(jtiKey(jti), ttl);
  if (!stored) {
    return json({ error: "store_unavailable" }, 503);
  }

  // 7) Hand back the same-origin consume URL + absolute expiry.
  return json(
    { src: `/api/media/${encodeURIComponent(id)}/html?t=${sealed}`, exp },
    200,
  );
}
