import { countryIso2FromHeaders } from "@/lib/location-country";

export async function GET(request: Request) {
  return Response.json(
    { country: countryIso2FromHeaders(request.headers) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
