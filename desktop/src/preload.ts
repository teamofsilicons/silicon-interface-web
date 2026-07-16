import { contextBridge, ipcRenderer } from "electron";

// Keep the sandboxed preload self-contained. Electron's sandbox preload
// loader does not resolve arbitrary relative CommonJS modules.
const DESKTOP_PROTOCOL_VERSION = 1 as const;
const IPC = {
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

interface DesktopWindowState {
  focused: boolean;
  visible: boolean;
  minimized: boolean;
}

interface DesktopEnvironment {
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  platform: NodeJS.Platform;
  appVersion: string;
  production: boolean;
}

interface DesktopDeepLink {
  kind: "chat" | "join";
  path: string;
}

type DesktopDownloadResult = "saved" | "cancelled" | "failed";

type Unsubscribe = () => void;

function subscribe<T>(channel: string, callback: (value: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge = Object.freeze({
  protocolVersion: DESKTOP_PROTOCOL_VERSION,
  environment: (): Promise<DesktopEnvironment> => ipcRenderer.invoke(IPC.environment),
  window: Object.freeze({
    getState: (): Promise<DesktopWindowState> => ipcRenderer.invoke(IPC.windowGetState),
    setBadgeCount: (count: number): void => ipcRenderer.send(IPC.windowSetBadge, count),
    show: (): void => ipcRenderer.send(IPC.windowShow),
    onStateChanged: (callback: (state: DesktopWindowState) => void): Unsubscribe =>
      subscribe(IPC.windowStateChanged, callback),
  }),
  links: Object.freeze({
    onDeepLink: (callback: (link: DesktopDeepLink) => void): Unsubscribe =>
      subscribe(IPC.deepLink, callback),
  }),
  lifecycle: Object.freeze({
    rendererReady: (): void => ipcRenderer.send(IPC.rendererReady),
    onBeforeQuit: (callback: () => void): Unsubscribe =>
      subscribe(IPC.lifecycleBeforeQuit, callback),
    flushComplete: (ready: boolean): void =>
      ipcRenderer.send(IPC.lifecycleFlushComplete, ready === true),
    onResume: (callback: () => void): Unsubscribe =>
      subscribe(IPC.lifecycleResume, callback),
    onSuspend: (callback: () => void): Unsubscribe =>
      subscribe(IPC.lifecycleSuspend, callback),
  }),
  downloads: Object.freeze({
    saveUrl: (url: string, suggestedName: string): Promise<DesktopDownloadResult> =>
      ipcRenderer.invoke(IPC.downloadSaveUrl, { url, suggestedName }),
  }),
});

contextBridge.exposeInMainWorld("siliconDesktop", bridge);

// Temporary compatibility hooks for Interface versions released before the
// versioned desktop bridge. Remove after all supported web deployments use
// window.siliconDesktop.
contextBridge.exposeInMainWorld("__siliconBridge", true);
contextBridge.exposeInMainWorld("__siliconSetBadge", (count: number) => {
  ipcRenderer.send(IPC.windowSetBadge, count);
});
