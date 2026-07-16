export const APP_BANNER_CONFIRMATION_MS = 2_000;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

type TimerScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type BannerConfirmationController<Condition = string> = {
  update: (condition: Condition | null) => void;
  dispose: () => void;
};

/**
 * Confirms a single, continuously-present app-wide condition before exposing
 * it. Replacing or clearing the condition cancels the old confirmation, and a
 * visible condition is withdrawn immediately as soon as it is no longer true.
 */
export function createBannerConfirmationController<Condition = string>({
  onVisibilityChange,
  scheduler = globalThis,
  delayMs = APP_BANNER_CONFIRMATION_MS,
}: {
  onVisibilityChange: (confirmedCondition: Condition | null) => void;
  scheduler?: TimerScheduler;
  delayMs?: number;
}): BannerConfirmationController<Condition> {
  let currentCondition: Condition | null = null;
  let visibleCondition: Condition | null = null;
  let timer: TimerHandle | null = null;
  let disposed = false;

  const cancelPending = () => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };

  const hideVisible = () => {
    if (visibleCondition === null) return;
    visibleCondition = null;
    onVisibilityChange(null);
  };

  return {
    update(condition) {
      if (disposed || condition === currentCondition) return;

      currentCondition = condition;
      cancelPending();

      if (visibleCondition !== condition) hideVisible();
      if (condition === null || visibleCondition === condition) return;

      const pendingCondition = condition;
      timer = scheduler.setTimeout(() => {
        timer = null;
        if (disposed || currentCondition !== pendingCondition) return;
        visibleCondition = pendingCondition;
        onVisibilityChange(pendingCondition);
      }, delayMs);
    },
    dispose() {
      disposed = true;
      currentCondition = null;
      cancelPending();
    },
  };
}
