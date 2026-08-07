const WEB_SESSION_AUTHORITY_LOCK = "silicon-interface:web-session-authority";

// Web Locks coordinate cookie-changing requests across tabs. The promise tail
// preserves the same ordering in browsers without Web Locks and in tests.
let localAuthorityTail: Promise<void> = Promise.resolve();

export async function withWebSessionAuthority<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    return await locks.request(
      WEB_SESSION_AUTHORITY_LOCK,
      { mode: "exclusive" },
      operation,
    );
  }

  const previous = localAuthorityTail;
  let release: () => void = () => void 0;
  localAuthorityTail = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
