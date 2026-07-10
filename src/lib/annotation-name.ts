"use client";

export async function generateAnnotationName(opts: {
  comment: string;
  fallback: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch("/api/annotations/name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
      signal: controller.signal,
    });
    if (!resp.ok) return opts.fallback;
    const data = (await resp.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    return name || opts.fallback;
  } catch {
    return opts.fallback;
  } finally {
    window.clearTimeout(timeout);
  }
}
