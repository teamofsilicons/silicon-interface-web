"use client";

import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * A live xterm terminal wired to a provisioning socket. The parent owns the
 * socket (there is one per SetupSession) and passes:
 *   - `output`: terminal.output data pushed from the server (write to screen)
 *   - `onData`: keystrokes to send back (terminal_input)
 *   - `onResize`: PTY resize (terminal_resize)
 *   - `onReady`: called once mounted so the parent can open the PTY (terminal_open)
 *
 * Skinned with the design system's --terminal-* tokens + JetBrains Mono. This is
 * the only real terminal emulator in the Interface; the rest are aesthetic.
 */
export interface RemoteTerminalHandle {
  write: (data: string) => void;
  clear: () => void;
  focus: () => void;
}

interface Props {
  onData: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onReady?: (cols: number, rows: number) => void;
  className?: string;
}

export const RemoteTerminal = React.forwardRef<RemoteTerminalHandle, Props>(
  function RemoteTerminal({ onData, onResize, onReady, className }, ref) {
    const hostRef = React.useRef<HTMLDivElement>(null);
    const termRef = React.useRef<Terminal | null>(null);
    const fitRef = React.useRef<FitAddon | null>(null);
    const onDataRef = React.useRef(onData);
    const onResizeRef = React.useRef(onResize);
    const onReadyRef = React.useRef(onReady);
    onDataRef.current = onData;
    onResizeRef.current = onResize;
    onReadyRef.current = onReady;

    React.useImperativeHandle(ref, () => ({
      write: (data: string) => termRef.current?.write(data),
      clear: () => termRef.current?.clear(),
      focus: () => termRef.current?.focus(),
    }));

    React.useEffect(() => {
      if (!hostRef.current) return;
      // Read the design tokens so the terminal matches the theme exactly.
      const css = getComputedStyle(document.documentElement);
      const term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'var(--font-jetbrains), "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        theme: {
          background: css.getPropertyValue("--terminal-bg").trim() || "#1a1a1a",
          foreground: css.getPropertyValue("--terminal-fg").trim() || "#ede8e0",
          cursor: css.getPropertyValue("--terminal-accent").trim() || "#c9b99a",
          selectionBackground: "rgba(201,185,154,0.35)",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fit;

      try {
        fit.fit();
      } catch {
        /* container not sized yet */
      }
      term.onData((d) => onDataRef.current(d));
      term.onResize(({ cols, rows }) => onResizeRef.current?.(cols, rows));
      onReadyRef.current?.(term.cols, term.rows);

      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      });
      ro.observe(hostRef.current);

      return () => {
        ro.disconnect();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    return (
      <div
        ref={hostRef}
        className={className ?? "h-full w-full overflow-hidden"}
        style={{ background: "var(--terminal-bg)", padding: "8px" }}
      />
    );
  },
);
