// Runtime configuration. Override via NEXT_PUBLIC_* env vars in .env.local.

export const env = {
  apiBase:
    (process.env.NEXT_PUBLIC_API_BASE as string | undefined)?.replace(/\/$/, "") ??
    "http://127.0.0.1:8000",
  wsBase:
    (process.env.NEXT_PUBLIC_WS_BASE as string | undefined)?.replace(/\/$/, "") ??
    "ws://127.0.0.1:8000",
};
