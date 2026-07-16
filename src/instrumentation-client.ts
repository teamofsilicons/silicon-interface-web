// Client-side PostHog initialization. In Next.js 15.3+ this file is the
// canonical place to boot client instrumentation — it runs once, early, before
// React hydrates. Do NOT also initialize PostHog via a <PostHogProvider
// apiKey=...> (that would double-init); components read the singleton with
// `import posthog from "posthog-js"`.
//
// Config posture: capture product analytics broadly, but session replay is
// PRIVACY-HARDENED. High-ticket / GDPR-sensitive clients must never have a
// live bearer token, OTP code, or private DM content liftable from a replay.
// Concretely that means: inputs are masked, chat surfaces are masked
// (`[data-private]`, applied to the message list), console capture is off (it
// can echo tokens from debug logs), and the auth/silicon-key headers + request
// & response bodies are stripped from captured network requests. Network
// *timing* is still kept (it lives in performance capture, not the replay body).
import posthog from "posthog-js";
import type { CapturedNetworkRequest } from "posthog-js";

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

// Older PostHog defaults can leave analytics cookies on the parent domain.
// That makes an Interface cookie travel to glass.teamofsilicons.com where it
// is both unnecessary and capable of triggering an edge WAF false positive.
// Remove only PostHog-owned legacy cookies from our fixed parent domain before
// initializing the new localStorage-only policy.
function clearLegacyParentDomainPosthogCookies() {
  if (typeof document === "undefined" || typeof location === "undefined") return;
  if (
    location.hostname !== "teamofsilicons.com" &&
    !location.hostname.endsWith(".teamofsilicons.com")
  ) {
    return;
  }
  for (const pair of document.cookie.split(";")) {
    const name = pair.split("=", 1)[0]?.trim();
    if (!name || !/^ph_[A-Za-z0-9_.-]+_posthog(?:_cross_subdomain)?$/.test(name)) continue;
    for (const domain of ["teamofsilicons.com", ".teamofsilicons.com"]) {
      document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${domain}; Secure; SameSite=Lax`;
    }
  }
}

// Header names that must never reach a replay. Compared case-insensitively.
const SENSITIVE_HEADERS = ["authorization", "x-silicon-key", "cookie", "set-cookie"];

function redactHeaders(headers: Record<string, string> | undefined) {
  if (!headers) return headers;
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.includes(key.toLowerCase())) headers[key] = "[redacted]";
  }
  return headers;
}

// Strip credentials and bodies from every captured request. We keep the URL +
// timing (useful for perf debugging) but drop payloads, which routinely carry
// tokens, OTP codes, message contents, and PII.
function maskNetworkRequest(
  request: CapturedNetworkRequest,
): CapturedNetworkRequest | null | undefined {
  request.requestHeaders = redactHeaders(request.requestHeaders);
  request.responseHeaders = redactHeaders(request.responseHeaders);
  if (request.requestBody != null) request.requestBody = "[redacted]";
  if (request.responseBody != null) request.responseBody = "[redacted]";
  return request;
}

if (token) {
  clearLegacyParentDomainPosthogCookies();
  posthog.init(token, {
    // First-party reverse proxy (see next.config.ts rewrites).
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    // Required modern defaults bundle (history-change pageviews, etc.).
    defaults: "2026-01-30",
    cross_subdomain_cookie: false,
    persistence: "localStorage",

    // ---- product analytics: capture as much as possible ----
    autocapture: true, // clicks, input changes, form submits, $autocapture
    capture_pageview: "history_change", // SPA route changes (App Router)
    capture_pageleave: true,
    rageclick: true,
    person_profiles: "always", // profile anonymous + identified users
    capture_performance: { network_timing: true, web_vitals: true },

    // ---- error tracking ----
    capture_exceptions: true, // unhandled errors + rejections + console.error

    // ---- session replay: privacy-hardened (see header note) ----
    disable_session_recording: false,
    enable_recording_console_log: false, // console can echo tokens — never record
    session_recording: {
      maskAllInputs: true, // never record what users type (composer, OTP, forms)
      maskTextSelector: "[data-private]", // mask chat content (tagged on the message list)
      maskInputOptions: { password: true }, // belt-and-suspenders on password fields
      recordCrossOriginIframes: true,
      collectFonts: true,
      captureCanvas: { recordCanvas: true }, // record <canvas> elements
      // Headers + bodies are still captured, but scrubbed of credentials and
      // payloads by maskNetworkRequestFn below before they leave the browser.
      recordHeaders: true,
      recordBody: true,
      maskCapturedNetworkRequestFn: maskNetworkRequest,
    },

    debug: process.env.NODE_ENV === "development",
  });
  // §4.2 — honour a returning user's analytics opt-out immediately, before any
  // autocapture/pageview fires.
  void import("./lib/analytics").then((m) => m.applyAnalyticsConsent());
}
