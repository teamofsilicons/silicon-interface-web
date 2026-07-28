import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const developmentConnectSources = isDev
  ? " http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*"
  : "";
const defaultApiBase = isDev
  ? "http://127.0.0.1:8000"
  : "https://glass.teamofsilicons.com";

function externalOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    // A relative API base is already covered by 'self'.
    return "";
  }
}

const glassAssetOrigin = externalOrigin(
  process.env.NEXT_PUBLIC_API_BASE || defaultApiBase,
);
const quarkScriptSources = [
  glassAssetOrigin,
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://cdnjs.cloudflare.com",
].filter(Boolean).join(" ");
const contentSecurityPolicy = [
  "default-src 'self'",
  // App Router prerenders its bootstrap and RSC payload as inline scripts.
  // Per-request nonces require dynamic rendering, so static/CDN builds must
  // permit those framework-owned inline scripts in production too.
  // Team Structure runs the pinned Quark renderer in an isolated srcDoc. Its
  // CSS/JS come from Glass and Rough.js has three explicit fallback origins.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} ${quarkScriptSources}`,
  `style-src 'self' 'unsafe-inline'${glassAssetOrigin ? ` ${glassAssetOrigin}` : ""}`,
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  // Annotation export reads locally rendered object URLs back through fetch()
  // before upload. Browsers enforce that operation through connect-src.
  `connect-src 'self' blob: https: wss:${developmentConnectSources}`,
  "worker-src 'self' blob:",
  // PDFs are fetched through the authenticated media endpoint and framed from
  // a local object URL. Remote frames remain limited to the abuse challenge.
  "frame-src blob: https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Browser-based local QA opens the development fixture through 127.0.0.1.
  // Allow that exact loopback host so Client Components hydrate normally.
  ...(isDev ? { allowedDevOrigins: ["127.0.0.1"] } : {}),
  // Keep parallel local/staging test servers from sharing build state.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // This repository lives below a user-level package-lock.json. Pinning the
  // project root prevents Turbopack/output tracing from treating the home
  // directory as a monorepo and nesting desktop standalone output beneath
  // `.next/standalone/Documents/...`.
  turbopack: { root: process.cwd() },
  // Desktop (Electron) builds run the bundled Next server inside the app, so
  // they need `output: "standalone"`. Web builds are untouched — only the
  // desktop build script (see desktop/) sets NEXT_OUTPUT.
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: process.cwd(),
        // The desktop app serves itself from localhost, and sharp's win/linux
        // binaries aren't traced when building on a Mac — skip optimization.
        images: { unoptimized: true },
      }
    : {}),
  // Reverse-proxy PostHog ingestion through our own origin (/ingest) so the
  // SDK isn't blocked by ad/tracker blockers and first-party cookies apply.
  // Targets are US Cloud. The SDK is pointed at `/ingest` in
  // instrumentation-client.ts.
  async rewrites() {
    return [
      ...(isDev
          ? [
            {
              source: "/glass-api/:path*/",
              destination: "http://127.0.0.1:8001/:path*/",
            },
            {
              source: "/glass-api/:path*",
              destination: "http://127.0.0.1:8001/:path*",
            },
          ]
        : []),
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), browsing-topics=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  // PostHog's API expects trailing-slash requests to pass through untouched.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
