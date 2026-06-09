"use client";

import * as React from "react";

// Delights §7d — a mono shortcut cheatsheet on Shift+? (a "?" keypress). Reads
// like a terminal man page.
const KEYS: [string, string][] = [
  ["⌘K / ctrl K", "jump to a room, person, or dev"],
  ["j / k", "move through the room list"],
  ["esc", "close the open conversation"],
  ["enter", "send a message"],
  ["/shrug", "¯\\_(ツ)_/¯"],
  ["/me <action>", "send an action line"],
  ["/clear", "empty the draft"],
  ["?", "show this cheatsheet"],
];

export function KeymapCheatsheet() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-md border bg-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="keyboard shortcuts"
      >
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="label-mono">keyboard shortcuts</span>
          <kbd className="label-mono border px-1.5 py-0.5 text-[10px]">esc</kbd>
        </div>
        <table className="w-full font-mono text-xs">
          <tbody>
            {KEYS.map(([k, v]) => (
              <tr key={k} className="border-b last:border-b-0">
                <td className="w-40 whitespace-nowrap px-4 py-2 text-foreground">{k}</td>
                <td className="px-4 py-2 text-muted-foreground">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
