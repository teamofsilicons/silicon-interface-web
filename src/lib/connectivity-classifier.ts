import { env } from "./env";

export type ConnectivityClass = "offline" | "captive" | "degraded" | "reachable";

export interface ConnectivityEvidence {
  navigatorOnline: boolean;
  responseKind?: "ok-json" | "redirect" | "html" | "http-error";
  transportFailed?: boolean;
}

/** Finite classification; navigator.onLine alone is never treated as reachability. */
export function classifyConnectivity(evidence: ConnectivityEvidence): ConnectivityClass {
  if (!evidence.navigatorOnline) return "offline";
  if (evidence.responseKind === "ok-json") return "reachable";
  if (evidence.responseKind === "redirect" || evidence.responseKind === "html") {
    return "captive";
  }
  return "degraded";
}

/** Probe Glass over HTTPS without auth, cookies, cache, or redirect following. */
export async function probeApiConnectivity(timeoutMs = 3_000): Promise<ConnectivityClass> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetch(`${env.apiBase}/healthz`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      return "captive";
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (response.ok && !contentType.includes("application/json")) return "captive";
    if (!response.ok) return "degraded";
    const payload = await response.json().catch(() => null);
    return classifyConnectivity({
      navigatorOnline: true,
      responseKind:
        payload && typeof payload === "object" && (payload as { status?: unknown }).status === "ok"
          ? "ok-json"
          : "html",
    });
  } catch {
    return classifyConnectivity({ navigatorOnline: true, transportFailed: true });
  } finally {
    clearTimeout(timer);
  }
}
