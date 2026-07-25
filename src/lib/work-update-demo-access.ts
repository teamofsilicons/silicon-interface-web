/**
 * The work-update demo is a local visual-verification surface, never a
 * production feature. Keep this check server-side in the route so production
 * requests terminate with Next's not-found response before the client demo is
 * rendered.
 */
export function workUpdateDemoAvailable(
  environment: string | undefined,
): boolean {
  return environment === "development";
}
