"use client";

const MIN_WAKE_DELAY_MS = 250;

export interface ModerationReportRecoveryClock {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface ModerationReportRecoveryScheduler {
  /** Run recovery now. Concurrent wakes collapse into one follow-up pass. */
  wake: () => void;
  /** Arm the earliest known durable retry deadline. */
  schedule: (deadlineMs: number) => void;
  /** Permanently stop timers and ignore in-flight completion. */
  cancel: () => void;
}

function browserClock(): ModerationReportRecoveryClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

/**
 * Owns one moderation-recovery timer for a mounted room. The durable journal
 * remains authoritative; this coordinator only decides when to rescan it.
 */
export function createModerationReportRecoveryScheduler(input: {
  recover: () => Promise<number | null>;
  clock?: ModerationReportRecoveryClock;
}): ModerationReportRecoveryScheduler {
  const clock = input.clock ?? browserClock();
  let active = true;
  let running = false;
  let rerun = false;
  let timer: unknown = null;
  let timerDeadline: number | null = null;

  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    timerDeadline = null;
  };

  const schedule = (deadlineMs: number) => {
    if (!active || !Number.isFinite(deadlineMs)) return;
    // Repeated journal notifications must not create parallel timers, and a
    // later report must never postpone an earlier report's retry.
    if (timer !== null && timerDeadline !== null && timerDeadline <= deadlineMs) return;
    clearTimer();
    timerDeadline = deadlineMs;
    timer = clock.setTimeout(() => {
      timer = null;
      timerDeadline = null;
      wake();
    }, Math.max(MIN_WAKE_DELAY_MS, deadlineMs - clock.now()));
  };

  const run = async () => {
    running = true;
    try {
      do {
        rerun = false;
        let nextWake: number | null = null;
        try {
          nextWake = await input.recover();
        } catch {
          // The next browser/network signal can retry an unexpected scan
          // failure. Never create a tight automatic loop from an exception.
        }
        if (!active) return;
        if (nextWake !== null) schedule(nextWake);
        if (rerun) clearTimer();
      } while (active && rerun);
    } finally {
      running = false;
    }
  };

  const wake = () => {
    if (!active) return;
    clearTimer();
    if (running) {
      rerun = true;
      return;
    }
    void run();
  };

  return {
    wake,
    schedule,
    cancel: () => {
      active = false;
      rerun = false;
      clearTimer();
    },
  };
}
