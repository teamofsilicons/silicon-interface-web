import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { identiconDataUrl, identiconSvg } from "../../src/lib/avatar.ts";
import { resolveTeamLogo } from "../../src/lib/team-logo.ts";

test("team marks contain no document-global SVG references", () => {
  const small = identiconSvg("team:tos", 28, "team");
  const large = identiconSvg("team:tos", 72, "team");

  for (const svg of [small, large]) {
    assert.doesNotMatch(svg, /\bid=/);
    assert.doesNotMatch(svg, /url\(#/);
    assert.match(svg, /<svg[^>]+viewBox="0 0 50 100"/);
    assert.match(svg, /<svg[^>]+viewBox="50 0 50 100"/);
  }
});

test("generated logos are deterministic isolated image resources", () => {
  const first = identiconDataUrl("team:tos", 36, "team");
  const second = identiconDataUrl("team:tos", 36, "team");
  assert.equal(first, second);
  assert.match(first, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.match(decodeURIComponent(first.split(",", 2)[1]), /^<svg/);
});

test("billing banners prefer the authoritative live team logo", () => {
  const cached = { slug: "tos", name: "Old TOS", logo_url: null };
  const live = [{ slug: "tos", name: "TOS", logo_url: "https://cdn.example/tos.png" }];
  assert.deepEqual(resolveTeamLogo(cached, live, false), {
    ...live[0],
    ready: true,
  });
  assert.deepEqual(resolveTeamLogo(cached, [], true), {
    ...cached,
    logo_url: null,
    ready: false,
  });
  assert.equal(resolveTeamLogo(cached, [], false), null);
});

test("avatars keep a neutral surface while an authoritative photo refreshes", async () => {
  const source = await readFile(
    new URL("../../src/components/profile/id-avatar.tsx", import.meta.url),
    "utf8",
  );

  const neutral = source.indexOf('"block shrink-0 border bg-foreground/[0.06]"');
  const generated = source.indexOf("src={markSrc}");
  assert.match(source, /const delay = effective \? 2_000 : 1_200/);
  assert.match(source, /if \(readyFallbackKey !== fallbackKey\)/);
  assert.ok(neutral >= 0 && generated > neutral);
});
