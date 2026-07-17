import assert from "node:assert/strict";
import test from "node:test";

function directives(policy) {
  return new Map(
    policy.split(";").map((entry) => {
      const [name, ...values] = entry.trim().split(/\s+/);
      return [name, values.join(" ")];
    }),
  );
}

function unwrapDefault(value) {
  let current = value;
  while (typeof current?.headers !== "function" && current?.default !== undefined) {
    current = current.default;
  }
  return current;
}

test("production CSP permits Next's prerendered bootstrap without relaxing eval", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const imported = await import("../../next.config.ts");
    const nextConfig = unwrapDefault(imported);
    // Vercel rewrites the Turbopack runtime after Next computes experimental
    // SRI, which makes the browser reject the otherwise valid runtime chunk.
    assert.equal(nextConfig.experimental?.sri, undefined);
    const rules = await nextConfig.headers();
    const appHeaders = rules.find((rule) => rule.source === "/:path*").headers;
    const policy = appHeaders.find(
      (header) => header.key === "Content-Security-Policy",
    ).value;
    const parsed = directives(policy);

    assert.equal(parsed.get("script-src"), "'self' 'unsafe-inline'");
    assert.doesNotMatch(policy, /'unsafe-eval'/);
    assert.equal(parsed.get("object-src"), "'none'");
    assert.equal(parsed.get("connect-src"), "'self' blob: https: wss:");
    assert.equal(parsed.get("frame-src"), "blob: https://challenges.cloudflare.com");
    assert.equal(parsed.get("base-uri"), "'self'");
    assert.equal(parsed.get("form-action"), "'self'");
    assert.equal(parsed.get("frame-ancestors"), "'none'");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
