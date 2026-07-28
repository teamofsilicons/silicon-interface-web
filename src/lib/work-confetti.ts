export const REALISTIC_CONFETTI_PARTICLE_COUNT = 200;

const REALISTIC_CONFETTI_BURSTS = [
  {
    particleRatio: 0.25,
    options: { spread: 26, startVelocity: 55 },
  },
  {
    particleRatio: 0.2,
    options: { spread: 60 },
  },
  {
    particleRatio: 0.35,
    options: { spread: 100, decay: 0.91, scalar: 0.8 },
  },
  {
    particleRatio: 0.1,
    options: { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 },
  },
  {
    particleRatio: 0.1,
    options: { spread: 120, startVelocity: 45 },
  },
] as const;

/** The layered five-burst recipe from canvas-confetti's Realistic Look demo. */
export function buildRealisticConfettiBursts() {
  return REALISTIC_CONFETTI_BURSTS.map(({ particleRatio, options }) => ({
    origin: { y: 0.7 },
    ...options,
    particleCount: Math.floor(
      REALISTIC_CONFETTI_PARTICLE_COUNT * particleRatio,
    ),
  }));
}
