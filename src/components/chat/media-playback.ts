// A single playback bus for every custom audio/video surface. Registering a
// pause callback keeps the coordinator independent from React and from the
// concrete HTMLMediaElement type.
const mediaPausers = new Set<() => void>();

export function registerMediaPauser(pause: () => void): () => void {
  mediaPausers.add(pause);
  return () => mediaPausers.delete(pause);
}

export function pauseOtherMedia(self: () => void): void {
  for (const pause of mediaPausers) {
    if (pause !== self) pause();
  }
}
