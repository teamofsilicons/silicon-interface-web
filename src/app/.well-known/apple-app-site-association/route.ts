// Apple App Site Association — enables iOS universal links so /c/* (carbon
// deep links) and /join/* (team invites) open in the Silicon Interface app
// when it's installed. Apple's CDN fetches this at
// https://interface.teamofsilicons.com/.well-known/apple-app-site-association
// and requires a 200 with an application/json content type and no redirect.
const AASA = {
  applinks: {
    apps: [],
    details: [
      {
        appIDs: ["LTBSK59BJ2.ai.tos.siliconinterface"],
        appID: "LTBSK59BJ2.ai.tos.siliconinterface",
        paths: ["/c/*", "/join/*"],
        components: [{ "/": "/c/*" }, { "/": "/join/*" }],
      },
    ],
  },
};

export const dynamic = "force-static";

export function GET() {
  return Response.json(AASA);
}
