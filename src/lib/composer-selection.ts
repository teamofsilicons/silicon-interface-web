export const COMPOSER_SELECTION_COMMIT_DELAY_MS = 120;

/**
 * Async draft hydration may restore the textarea only if the user has not
 * touched its caret/range since that hydration pass began.
 */
export function mayRestoreComposerSnapshot(
  expectedInteractionEpoch: number | undefined,
  currentInteractionEpoch: number,
): boolean {
  return expectedInteractionEpoch === undefined ||
    expectedInteractionEpoch === currentInteractionEpoch;
}
