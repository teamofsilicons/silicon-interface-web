// Runtime configuration. Override via NEXT_PUBLIC_* env vars in .env.local.
// Local dev should hit the local backend; production/Vercel previews should not
// ship a localhost fallback into the browser bundle.

const isProduction = process.env.NODE_ENV === "production";

const defaultApiBase = isProduction ? "https://glass.teamofsilicons.com" : "http://127.0.0.1:8000";
const defaultWsBase = isProduction ? "wss://glass.teamofsilicons.com" : "ws://127.0.0.1:8000";

export const env = {
  apiBase: (process.env.NEXT_PUBLIC_API_BASE as string | undefined)?.replace(/\/$/, "") ?? defaultApiBase,
  wsBase: (process.env.NEXT_PUBLIC_WS_BASE as string | undefined)?.replace(/\/$/, "") ?? defaultWsBase,
};
