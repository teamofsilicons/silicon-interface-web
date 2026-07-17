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

/** Native autoFocus/select events can fire before a controlled textarea has
 * received its restored value. They must not replace the saved draft range. */
export function mayPersistComposerSelection(
  editingMessage: boolean,
  applyingDraftSnapshot: boolean,
): boolean {
  return !editingMessage && !applyingDraftSnapshot;
}
