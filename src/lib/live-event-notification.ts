export function isGenuinelyNewLiveEvent(input: {
  seenEventIdentity: boolean;
  cachedEventIdentity: boolean;
  patchesProjectedLastEvent: boolean;
  edited: boolean;
}): boolean {
  return (
    !input.seenEventIdentity &&
    !input.cachedEventIdentity &&
    !input.patchesProjectedLastEvent &&
    !input.edited
  );
}

export function shouldPlayReceivedSound(input: {
  quiet: boolean;
  notificationAllowed: boolean;
  soundAllowed: boolean;
  mine: boolean;
  countable: boolean;
  genuinelyNew: boolean;
  observed: boolean;
}): boolean {
  return (
    !input.quiet &&
    input.notificationAllowed &&
    input.soundAllowed &&
    !input.mine &&
    !input.observed &&
    input.countable &&
    input.genuinelyNew
  );
}
