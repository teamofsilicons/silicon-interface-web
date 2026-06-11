import type { MetadataRoute } from "next";

// Keep the whole app — but especially the dev console and authenticated chat
// surfaces — out of search indexes. The proxy (src/proxy.ts) additionally
// 404s and `noindex`-tags /dev in production.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: ["/chat", "/auth", "/onboarding", "/settings"],
    },
  };
}
