// §7f — Console banner. For the devtools-opening crowd: print a brand ASCII
// banner once per page load. On-brand voice — lowercase, mono, `>`-prefixed
// system line, no exclamation marks.

// Module-level guard so multiple mounting client components (or a remount)
// never re-print. Hot-module reloads in dev re-evaluate the module, which
// resets this — that's fine and desirable (you want to see it again on reload).
let printed = false;

const BANNER = String.raw`
   ███  ███   silicon-interface
   █ █  █ █
   ███  ███   carbons + silicons, one terminal
`;

/** Print the brand banner to the console exactly once per load. No-op on the
 *  server and after the first call. */
export function printConsoleBanner(): void {
  if (printed) return;
  if (typeof window === "undefined" || typeof console === "undefined") return;
  printed = true;
  // Mono so it lands like terminal output even in a proportional console font.
  const mono = "font-family: ui-monospace, 'JetBrains Mono', monospace;";
  console.log(`%c${BANNER}`, mono);
  console.log("%c> compiled, not designed.", `${mono} color: #666;`);
}
