export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export const IPC = {
  environment: "silicon:environment",
  windowGetState: "silicon:window:get-state",
  windowStateChanged: "silicon:window:state-changed",
  windowSetBadge: "silicon:window:set-badge",
  windowShow: "silicon:window:show",
  deepLink: "silicon:deep-link",
  rendererReady: "silicon:lifecycle:renderer-ready",
  downloadSaveUrl: "silicon:download:save-url",
  lifecycleBeforeQuit: "silicon:lifecycle:before-quit",
  lifecycleFlushComplete: "silicon:lifecycle:flush-complete",
  lifecycleResume: "silicon:lifecycle:resume",
  lifecycleSuspend: "silicon:lifecycle:suspend",
} as const;

export interface DesktopWindowState {
  focused: boolean;
  visible: boolean;
  minimized: boolean;
}

export interface DesktopEnvironment {
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  platform: NodeJS.Platform;
  appVersion: string;
  production: boolean;
}

export interface DesktopDeepLink {
  kind: "chat" | "join";
  path: string;
}

export type DesktopDownloadResult = "saved" | "cancelled" | "failed";
