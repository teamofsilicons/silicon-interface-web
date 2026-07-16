"use client";

export interface DesktopWindowState {
  focused: boolean;
  visible: boolean;
  minimized: boolean;
}

export interface DesktopDeepLink {
  kind: "chat" | "join";
  path: string;
}

export interface SiliconDesktopBridge {
  protocolVersion: 1;
  environment(): Promise<{
    protocolVersion: 1;
    platform: string;
    appVersion: string;
    production: boolean;
  }>;
  window: {
    getState(): Promise<DesktopWindowState>;
    setBadgeCount(count: number): void;
    show(): void;
    onStateChanged(callback: (state: DesktopWindowState) => void): () => void;
  };
  links: {
    onDeepLink(callback: (link: DesktopDeepLink) => void): () => void;
  };
  lifecycle: {
    rendererReady(): void;
    onBeforeQuit(callback: () => void): () => void;
    flushComplete(ready: boolean): void;
    onResume(callback: () => void): () => void;
    onSuspend(callback: () => void): () => void;
  };
  downloads: {
    saveUrl(
      url: string,
      suggestedName: string,
    ): Promise<"saved" | "cancelled" | "failed">;
  };
}

declare global {
  interface Window {
    siliconDesktop?: SiliconDesktopBridge;
  }
}

export function desktopBridge(): SiliconDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.siliconDesktop;
  return bridge?.protocolVersion === 1 ? bridge : null;
}

export function isDesktopShell(): boolean {
  return desktopBridge() !== null;
}
