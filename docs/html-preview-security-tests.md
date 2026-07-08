# HTML preview — security test plan (Dope #116)

Same-origin HTML preview served through a **sealed single-use ticket** + a
server-side **proxy** that re-serves the body under a strict header-only CSP +
`sandbox`. We NEVER iframe a presigned URL directly.

Two routes (App Router, `runtime = "nodejs"`):

| Route | File | Purpose |
| --- | --- | --- |
| `POST /api/media/[id]/html/ticket` | `src/app/api/media/[id]/html/ticket/route.ts` | Mint a sealed, single-use ticket after authz + validation. |
| `GET  /api/media/[id]/html?t=…`    | `src/app/api/media/[id]/html/route.ts`        | Consume the ticket (GETDEL) and proxy the HTML same-origin. |

Shared crypto/store/headers: `src/lib/html-preview-ticket.ts`.
Crypto self-test (no framework): `scripts/html-preview-ticket.selftest.mjs`.

## Environment

```
HTML_PREVIEW_TICKET_SECRET   # required; SHA-256 → 32-byte AES-256-GCM key. Missing ⇒ fail closed.
HTML_PREVIEW_ALLOWED_HOSTS   # comma-separated EXACT hostnames of the presign origin(s).
HTML_PREVIEW_MAX_BYTES       # optional; default 5*1024*1024 (5 MiB).
HTML_PREVIEW_TTL_SECONDS     # optional; default 90, clamped to [60,120].
UPSTASH_REDIS_REST_URL       # required; single-use store. Missing ⇒ fail closed.
UPSTASH_REDIS_REST_TOKEN     # required; single-use store. Missing ⇒ fail closed.
NEXT_PUBLIC_API_BASE         # Glass base (prod fallback https://glass.teamofsilicons.com).
```

`AUTH` below is a real bearer token (or `-H "X-Silicon-Key: <key>"`); `BASE` is
the web origin (e.g. `http://localhost:3000`); `MID` is a media id.

---

## A. Crypto invariants — automated

Covered by the self-test; run:

```
node scripts/html-preview-ticket.selftest.mjs   # exits 0, prints "ALL PASS"
```

| # | Scenario | Expected |
| --- | --- | --- |
| A1 | **ticket seal/open valid** | `open(seal(p))` returns `p` verbatim. |
| A2 | **tampered ticket fails** | flip a ciphertext byte ⇒ `open` throws (GCM tag). |
| A3 | **truncated ticket fails** | drop trailing bytes ⇒ `open` throws. |
| A4 | **wrong media_id fails** | seal AAD=`media-A`, open AAD=`media-B` ⇒ throws (AAD binding). |
| A5 | **expired ticket** | `open` succeeds but `exp <= now` ⇒ route returns 410 (see B/C). |
| A6 | **wrong key fails** | seal under secret-1, open under secret-2 ⇒ throws. |
| A7 | **key = 32 bytes, secret-bound** | SHA-256 length 32; differs per secret. |
| A8 | **missing secret fails closed** | `ticketKey()` throws with no `HTML_PREVIEW_TICKET_SECRET`. |
| A9 | **host allow-list exact-match** | trim/lower-case; `evil-assets.example.com` and `assets.example.com.evil.com` are rejected. |

---

## B. Mint route — `POST /api/media/[id]/html/ticket`

### B1. Glass 403/401/404 does NOT mint

Use a media id the caller cannot access (or a bad token).

```
curl -i -X POST "$BASE/api/media/$MID/html/ticket" -H "Authorization: Bearer BAD"
```

**Expected:** status mirrors Glass (401/403/404); JSON `{"error":"not_authorized"}`;
**no** `src` in the body. Nothing minted.

### B2. Pending media does NOT mint

Media whose `status !== "ready"` (e.g. an in-flight TTS render).

```
curl -i -X POST "$BASE/api/media/$MID/html/ticket" -H "Authorization: Bearer $AUTH"
```

**Expected:** `409` `{"error":"not_ready"}`. No ticket.

### B3. Non-HTML media does NOT mint

Media whose mime is not `text/html` and whose presigned URL path is not `.html/.htm`.

**Expected:** `415` `{"error":"unsupported_media_type"}`. No ticket.

### B4. Bad host does NOT mint

Glass returns a `download_url` whose hostname is **not** in `HTML_PREVIEW_ALLOWED_HOSTS`
(temporarily unset/alter the env to force this).

**Expected:** `400` `{"error":"host_not_allowed"}`. No ticket. (Exact-hostname
match: a look-alike such as `evil-assets.example.com` is also rejected.)

### B5. Oversize does NOT mint (declared size)

Media whose `size > HTML_PREVIEW_MAX_BYTES`.

**Expected:** `413` `{"error":"too_large"}`. No ticket.

### B6. Missing ticket secret ⇒ fail closed

Unset `HTML_PREVIEW_TICKET_SECRET`, restart, mint a valid HTML media.

**Expected:** `503` `{"error":"ticket_secret_unavailable"}`. No ticket.

### B7. Missing / broken store ⇒ fail closed

Unset `UPSTASH_REDIS_REST_URL`/`TOKEN` (or point them at a dead host).

**Expected:** `503` `{"error":"store_unavailable"}`. No ticket. (The `SET … NX EX`
must actually land; an error is never treated as success.)

### B8. Happy path mints

Valid, ready, allow-listed `text/html` media under the cap.

```
curl -i -X POST "$BASE/api/media/$MID/html/ticket" -H "Authorization: Bearer $AUTH"
```

**Expected:** `200` `{"src":"/api/media/<MID>/html?t=<token>","exp":<unix>}`.
A `SET htmlpreview:jti:<uuid> 1 NX EX <ttl>` key now exists in Upstash with a
TTL in `[60,120]`.

---

## C. Proxy route — `GET /api/media/[id]/html?t=…`

Take the `src` from B8 as `$SRC`.

### C1. Valid ticket returns the body + ALL security headers, fetches upstream once

```
curl -i "$BASE$SRC"
```

**Expected:** `200`, the HTML body, and **every** header below (verify each):

```
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; frame-ancestors 'self'; sandbox
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: SAMEORIGIN
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-store
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), payment=()
```

The single-use marker is now consumed (GETDEL) — the upstream presigned URL was
fetched exactly once.

### C2. Replay fails and does NOT re-fetch upstream

Immediately re-run C1 with the **same** `$SRC`.

**Expected:** `410` friendly HTML page ("already been used"), with the full
security header set. The upstream is **not** fetched again (marker already
deleted). Watch the presign origin's access log to confirm no second hit.

### C3. Tampered ticket ⇒ 403

Mutate a character in the `t=` value.

**Expected:** `403` friendly HTML page, full security headers.

### C4. Wrong media id in path ⇒ 403

Request the ticket from B8 at a **different** `[id]` path.

```
curl -i "$BASE/api/media/OTHER_ID/html?t=<token from MID>"
```

**Expected:** `403` (AAD is bound to the path id; open fails).

### C5. Expired ticket ⇒ 410

Set `HTML_PREVIEW_TTL_SECONDS=60`, mint, wait > 60 s (or mint with a clock skew),
then consume.

**Expected:** `410` friendly HTML page, full security headers. (Expiry is a
distinct code from tamper/replay.)

### C6. Missing/broken store on consume ⇒ fail closed

Break Upstash env, then consume a freshly minted ticket.

**Expected:** `503` friendly HTML page, full security headers. Body never served.

### C7. Oversize / streaming cap ⇒ 413, body withheld

Point at an HTML asset larger than `HTML_PREVIEW_MAX_BYTES` (set it low, e.g.
`HTML_PREVIEW_MAX_BYTES=1024`). Test **both**:
  - upstream sends an honest `Content-Length > cap`, and
  - upstream omits/lies about `Content-Length` (streamed bytes exceed cap).

**Expected:** `413` friendly HTML page, full security headers, and the oversized
body is **never** returned (the stream is aborted mid-read).

### C8. Missing `t=` ⇒ 403

```
curl -i "$BASE/api/media/$MID/html"
```

**Expected:** `403` friendly HTML page, full security headers.

### C9. Redirect-based SSRF blocked

If the presign origin 3xx-redirects to a non-allow-listed host, the proxy uses
`redirect: "error"`.

**Expected:** `502` friendly page — the redirect target is never fetched.

### C10. `t=` is never logged

Grep server logs/stdout after any of the above.

**Expected:** the token/full request URL never appears in any log or error line.

---

## D. In-browser rendering (open the previewer on an `.html` attachment)

The client (`src/components/chat/media-previewer.tsx`) mints a ticket then renders:

```html
<iframe sandbox="" src={ticket.src} referrerPolicy="no-referrer" loading="lazy" allow="" title=… />
```

### D1. Script in the HTML does NOT run

Preview an HTML file containing `<script>document.title='pwned';…</script>` and
an `onload=` handler.

**Expected:** nothing executes. Two independent controls stop it: the response
CSP has **no** `script-src` (falls back to `default-src 'none'`), and the `sandbox`
CSP directive + the iframe's empty `sandbox=""` attribute both withhold script
execution (no `allow-scripts`).

### D2. External image blocked by CSP

HTML with `<img src="https://evil.example/track.gif">`.

**Expected:** the request is blocked — CSP `img-src data:` only. No network hit
to the external host (check devtools → Network / the CSP violation report).

### D3. `data:` image renders

HTML with `<img src="data:image/png;base64,…">`.

**Expected:** the inline image renders (CSP `img-src data:` allows it).

### D4. Inline styles apply; external CSS/fonts blocked

`style="…"` / `<style>` apply (`style-src 'unsafe-inline'`); `<link rel=stylesheet href=https://…>`
and non-`data:` fonts are blocked (`font-src data:`).

### D5. No form submission / navigation / framing escape

`form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`, `frame-ancestors 'self'`
prevent form posts, `<base>` hijack, nested frames, and embedding off-origin.

### D6. Replay/expiry recovery in the UI

Let a ticket expire (or reuse it) so the iframe shows the 410 page. Click
**reload / retry** — the client re-mints a fresh ticket and the preview loads.

### D7. Download still works

The previewer's header **download** button (and the non-previewable
`AttachmentCard` download button) fetch the original asset via the presigned URL
and save it unchanged — independent of the preview proxy.
```
