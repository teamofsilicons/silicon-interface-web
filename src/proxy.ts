import { NextRequest, NextResponse } from "next/server";

const LORDS_HOST = "lords.interface.teamofsilicons.com";

/** Host-level product split. Authorization remains at the Glass API boundary. */
export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").split(":", 1)[0].toLowerCase();
  const url = request.nextUrl.clone();
  if (host === LORDS_HOST && url.pathname === "/chat") {
    url.pathname = "/lords";
    return NextResponse.rewrite(url);
  }
  if (host !== LORDS_HOST && url.pathname === "/lords") {
    url.pathname = "/chat";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/chat", "/lords"],
};
