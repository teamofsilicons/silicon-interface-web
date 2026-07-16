export type ComposerEnterBehavior = "send" | "newline";

export const COMPOSER_ENTER_BEHAVIOR_EVENT =
  "silicon:composer-enter-behavior";

const STORAGE_KEY = "silicon-interface:composer-enter-behavior";

export function subscribeComposerEnterBehavior(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(COMPOSER_ENTER_BEHAVIOR_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(COMPOSER_ENTER_BEHAVIOR_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function readComposerEnterBehavior(): ComposerEnterBehavior {
  if (typeof window === "undefined") return "send";
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "newline"
      ? "newline"
      : "send";
  } catch {
    return "send";
  }
}

export function writeComposerEnterBehavior(
  behavior: ComposerEnterBehavior,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, behavior);
  } catch {
    // Private/restricted storage should not make the composer unusable.
  }
  window.dispatchEvent(
    new CustomEvent(COMPOSER_ENTER_BEHAVIOR_EVENT, { detail: behavior }),
  );
}

export type ComposerEnterAction = "send" | "newline" | "ignore";

export function composerEnterAction(input: {
  key: string;
  behavior: ComposerEnterBehavior;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): ComposerEnterAction {
  if (input.key !== "Enter") return "ignore";
  if (input.isComposing || input.keyCode === 229) return "ignore";
  if (input.altKey) return "newline";

  if (input.behavior === "send") {
    return input.shiftKey ? "newline" : "send";
  }

  return input.metaKey || input.ctrlKey ? "send" : "newline";
}
