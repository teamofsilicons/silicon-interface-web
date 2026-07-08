export const runtime = "nodejs";

const DEFAULT_MODEL = "gemini-2.5-flash-lite";

function cleanName(raw: string, fallback: string): string {
  const oneLine = raw
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[^a-zA-Z0-9 _-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return fallback;
  const words = oneLine.split(" ").slice(0, 4);
  const titled = words
    .join(" ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .slice(0, 28)
    .trim();
  return titled || fallback;
}

export async function POST(request: Request) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
  if (!key) return Response.json({ detail: "Gemini key is not configured." }, { status: 503 });

  const body = (await request.json().catch(() => null)) as
    | { comment?: unknown; fallback?: unknown }
    | null;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";
  const fallback = typeof body?.fallback === "string" ? body.fallback.trim() : "A1";
  if (!comment) return Response.json({ name: fallback });

  const model = process.env.GEMINI_ANNOTATION_MODEL || DEFAULT_MODEL;
  const prompt = [
    "Create a short reference id for a document annotation.",
    "Rules:",
    "- Return only the reference id text.",
    "- 1 to 4 words.",
    "- Title Case.",
    "- No punctuation except hyphen if necessary.",
    "- Make it specific to the comment.",
    "",
    `Comment: ${comment.slice(0, 600)}`,
  ].join("\n");

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 16,
        },
      }),
    },
  );

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "Gemini naming failed.");
    return Response.json({ detail }, { status: 502 });
  }

  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join(" ") || "";
  return Response.json({ name: cleanName(text, fallback) });
}
