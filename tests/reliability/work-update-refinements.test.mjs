import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRealisticConfettiBursts,
  REALISTIC_CONFETTI_PARTICLE_COUNT,
} from "../../src/lib/work-confetti.ts";

const [confettiSource, packageJson] = await Promise.all([
  readFile(
    new URL("../../src/components/chat/work-confetti.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
]);

test("completion uses canvas-confetti's layered realistic-look recipe", () => {
  assert.equal(REALISTIC_CONFETTI_PARTICLE_COUNT, 200);
  assert.deepEqual(buildRealisticConfettiBursts(), [
    {
      origin: { y: 0.7 },
      spread: 26,
      startVelocity: 55,
      particleCount: 50,
    },
    {
      origin: { y: 0.7 },
      spread: 60,
      particleCount: 40,
    },
    {
      origin: { y: 0.7 },
      spread: 100,
      decay: 0.91,
      scalar: 0.8,
      particleCount: 70,
    },
    {
      origin: { y: 0.7 },
      spread: 120,
      startVelocity: 25,
      decay: 0.92,
      scalar: 1.2,
      particleCount: 20,
    },
    {
      origin: { y: 0.7 },
      spread: 120,
      startVelocity: 45,
      particleCount: 20,
    },
  ]);

  assert.equal(packageJson.dependencies["canvas-confetti"], "1.9.4");
  assert.match(confettiSource, /from "canvas-confetti"/);
  assert.match(confettiSource, /disableForReducedMotion: true/);
  assert.match(confettiSource, /zIndex: 90/);
  assert.match(confettiSource, /confetti\.reset\(\)/);
  assert.doesNotMatch(confettiSource, /createPortal|work-confetti-fall|PARTICLES/);
});
