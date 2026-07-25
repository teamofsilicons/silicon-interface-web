import { findCountry } from "./country-codes";

const COUNTRY_HEADERS = [
  "x-vercel-ip-country",
  "cloudfront-viewer-country",
  "cf-ipcountry",
] as const;

/** Read deployment-provided geolocation without exposing or storing an IP. */
export function countryIso2FromHeaders(headers: Pick<Headers, "get">): string | null {
  for (const name of COUNTRY_HEADERS) {
    const raw = (headers.get(name) ?? "").trim().toUpperCase();
    const iso2 = raw === "UK" ? "GB" : raw;
    if (findCountry(iso2)) return iso2;
  }
  return null;
}
