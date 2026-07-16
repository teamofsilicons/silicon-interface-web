import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type Session,
} from "electron";
import path from "node:path";

import {
  DESKTOP_PROTOCOL_VERSION,
  IPC,
  type DesktopDeepLink,
  type DesktopWindowState,
} from "./contracts";
import { extractDeepLinkArg, parseDeepLink } from "./deep-links";
import {
  isTrustedRendererUrl,
  normalizeBadgeCount,
  permissionAllowed,
  rendererOrigin,
  resolveRendererUrl,
  safeDownloadUrl,
  safeExternalUrl,
  safeSuggestedFilename,
} from "./policy";
import {
  desktopSmokeProfilePath,
  parseDesktopSmokeToken,
  writeDesktopSmokeResult,
  type DesktopSmokeResult,
} from "./smoke";
import { startDesktopUpdater, type DesktopUpdater } from "./updater";

app.enableSandbox();

const smokeToken = parseDesktopSmokeToken(process.env.SILICON_DESKTOP_SMOKE_TOKEN);
if (smokeToken) {
  // A smoke candidate must never hand its launch to an already-running user
  // session through requestSingleInstanceLock, nor read that session's
  // cookies/drafts. The token is path-safe and unique to one bounded run.
  const smokeProfile = desktopSmokeProfilePath(app.getPath("temp"), smokeToken);
  app.setPath("userData", smokeProfile);
  app.setPath("sessionData", smokeProfile);
}

const production = app.isPackaged;
const rendererUrl = resolveRendererUrl(production);
const trustedOrigin = rendererOrigin(rendererUrl);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let rendererReady = false;
let pendingDeepLink: DesktopDeepLink | null = null;
let recoveryAttempts = 0;
let persistentSession: Session | null = null;
let quitHandshakeInFlight = false;
let quitApproved = false;
let quitHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingUpdateInstall = false;
let updater: DesktopUpdater | null = null;
let smokeResultRecorded = false;

function recordSmokeResult(result: DesktopSmokeResult): void {
  if (!smokeToken || smokeResultRecorded) return;
  smokeResultRecorded = true;
  void writeDesktopSmokeResult(app.getPath("temp"), smokeToken, {
    ...result,
    appVersion: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    packaged: app.isPackaged,
  }).catch((error) => {
    console.error("Failed to write desktop smoke result", error);
  });
}

function iconPath(): string {
  return path.join(app.getAppPath(), "build", "icon.png");
}

function currentWindowState(): DesktopWindowState {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { focused: false, visible: false, minimized: false };
  }
  return {
    focused: mainWindow.isFocused(),
    visible: mainWindow.isVisible(),
    minimized: mainWindow.isMinimized(),
  };
}

function sendWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(IPC.windowStateChanged, currentWindowState());
}

function sendDeepLink(): void {
  if (!rendererReady || !pendingDeepLink || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.deepLink, pendingDeepLink);
  pendingDeepLink = null;
}

function queueDeepLink(link: DesktopDeepLink | null): void {
  if (!link) return;
  pendingDeepLink = link;
  if (!app.isReady()) return;
  showMainWindow();
  sendDeepLink();
}

function setBadgeCount(rawCount: unknown): void {
  const count = normalizeBadgeCount(rawCount);
  if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
    if (count === 0) {
      mainWindow.setOverlayIcon(null, "");
      return;
    }
    const label = count > 99 ? "99+" : String(count);
    const fontSize = label.length > 2 ? 22 : 28;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<circle cx="32" cy="32" r="30" fill="#c73e3a" stroke="#fff" stroke-width="4"/>' +
      '<text x="32" y="41" text-anchor="middle" font-family="Arial" font-size="' +
      String(fontSize) +
      '" font-weight="700" fill="#fff">' +
      label +
      "</text></svg>";
    mainWindow.setOverlayIcon(
      nativeImage.createFromDataURL("data:image/svg+xml;base64," + Buffer.from(svg).toString("base64")),
      count + " unread messages",
    );
    return;
  }
  app.setBadgeCount(count);
}

async function saveDownload(
  rawUrl: unknown,
  rawSuggestedName: unknown,
): Promise<"saved" | "cancelled" | "failed"> {
  if (typeof rawUrl !== "string" || !mainWindow || mainWindow.isDestroyed()) return "failed";
  const url = safeDownloadUrl(rawUrl, trustedOrigin);
  if (!url) return "failed";
  const suggestedName = safeSuggestedFilename(rawSuggestedName);
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: "Save attachment",
    defaultPath: path.join(app.getPath("downloads"), suggestedName),
  });
  if (choice.canceled || !choice.filePath) return "cancelled";

  const target = configureSession();
  return new Promise((resolve) => {
    let started = false;
    const startTimeout = setTimeout(() => {
      if (started) return;
      target.removeListener("will-download", onDownload);
      resolve("failed");
    }, 15_000);

    const onDownload = (
      _event: Electron.Event,
      item: Electron.DownloadItem,
    ) => {
      const chain = item.getURLChain();
      if (item.getURL() !== url && !chain.includes(url)) return;
      started = true;
      clearTimeout(startTimeout);
      target.removeListener("will-download", onDownload);
      item.setSavePath(choice.filePath);
      item.once("done", (_doneEvent, state) => {
        resolve(state === "completed" ? "saved" : "failed");
      });
    };

    target.on("will-download", onDownload);
    target.downloadURL(url);
  });
}

function isTrustedIpcSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return Boolean(
    frame &&
      frame === event.sender.mainFrame &&
      isTrustedRendererUrl(frame.url, trustedOrigin),
  );
}

function registerIpc(): void {
  ipcMain.handle(IPC.environment, (event) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted renderer");
    return {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      platform: process.platform,
      appVersion: app.getVersion(),
      production,
    };
  });

  ipcMain.handle(IPC.windowGetState, (event) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted renderer");
    return currentWindowState();
  });

  ipcMain.on(IPC.windowSetBadge, (event, count: unknown) => {
    if (isTrustedIpcSender(event)) setBadgeCount(count);
  });

  ipcMain.on(IPC.windowShow, (event) => {
    if (isTrustedIpcSender(event)) showMainWindow();
  });

  ipcMain.on(IPC.rendererReady, (event) => {
    if (!isTrustedIpcSender(event)) return;
    rendererReady = true;
    recordSmokeResult({
      status: "ready",
      url: event.senderFrame?.url ?? mainWindow?.webContents.getURL() ?? "",
    });
    sendWindowState();
    sendDeepLink();
  });

  ipcMain.handle(
    IPC.downloadSaveUrl,
    async (event, input: { url?: unknown; suggestedName?: unknown } | null) => {
      if (!isTrustedIpcSender(event)) throw new Error("Untrusted renderer");
      return saveDownload(input?.url, input?.suggestedName);
    },
  );

  ipcMain.on(IPC.lifecycleFlushComplete, (event, ready: unknown) => {
    if (!isTrustedIpcSender(event) || !quitHandshakeInFlight) return;
    quitHandshakeInFlight = false;
    if (quitHandshakeTimer) clearTimeout(quitHandshakeTimer);
    quitHandshakeTimer = null;
    if (ready === true) {
      quitApproved = true;
      quitting = true;
      if (pendingUpdateInstall) updater?.installDownloaded();
      else app.quit();
      return;
    }
    pendingUpdateInstall = false;
    showMainWindow();
    if (mainWindow) {
      void dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Silicon Interface is still saving",
        message: "Your work is still being saved.",
        detail: "Finish or cancel the active recording or attachment transfer, then quit again.",
      });
    }
  });
}

function beginQuitHandshake(options: { surfaceFailure?: boolean } = {}): void {
  if (quitHandshakeInFlight) return;
  const surfaceFailure = options.surfaceFailure !== false;
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    // Renderer state is continuously journaled. If there is no live renderer
    // capable of answering, there is no in-memory recording/upload to drain.
    quitApproved = true;
    quitting = true;
    if (pendingUpdateInstall) updater?.installDownloaded();
    else app.quit();
    return;
  }
  quitHandshakeInFlight = true;
  if (surfaceFailure) showMainWindow();
  mainWindow.webContents.send(IPC.lifecycleBeforeQuit);
  quitHandshakeTimer = setTimeout(() => {
    quitHandshakeInFlight = false;
    pendingUpdateInstall = false;
    if (surfaceFailure) showMainWindow();
    if (surfaceFailure && mainWindow) {
      void dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Silicon Interface could not finish saving",
        message: "The app stayed open to protect your work.",
        detail: "Try quitting again after the current work has finished.",
      });
    }
  }, 10_000);
}

function configureSession(): Session {
  if (persistentSession) return persistentSession;
  // The legacy desktop prototype used defaultSession. Keeping it here is a
  // deliberate no-data-loss migration: local drafts, IndexedDB history,
  // cookies, and cached attachments remain in the exact Chromium profile users
  // already have. Any future untrusted/secondary surface must get its own
  // non-default partition instead of sharing this primary profile.
  const target = session.defaultSession;

  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let requestingOrigin = "";
    try {
      requestingOrigin = new URL(details.requestingUrl).origin;
    } catch {
      callback(false);
      return;
    }
    const allowed = permissionAllowed(
      permission,
      requestingOrigin,
      trustedOrigin,
      details.isMainFrame && webContents.mainFrame.url === details.requestingUrl,
    );
    callback(allowed);
  });

  target.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return permissionAllowed(
      permission,
      requestingOrigin,
      trustedOrigin,
      Boolean(
        webContents &&
          details.isMainFrame &&
          (!details.requestingUrl || webContents.mainFrame.url === details.requestingUrl),
      ),
    );
  });

  target.setDevicePermissionHandler(() => false);
  target.setUSBProtectedClassesHandler(() => []);
  persistentSession = target;
  return target;
}

function openExternal(candidate: string): void {
  const safe = safeExternalUrl(candidate);
  if (safe) void shell.openExternal(safe);
}

function installContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      if (template.length > 0) template.push({ type: "separator" });
    }
    if (params.isEditable) {
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText) {
      template.push({ role: "copy" });
    }
    const external = params.linkURL ? safeExternalUrl(params.linkURL) : null;
    if (external) {
      if (template.length > 0) template.push({ type: "separator" });
      template.push({ label: "Open link in browser", click: () => openExternal(external) });
    }
    if (!production) {
      if (template.length > 0) template.push({ type: "separator" });
      template.push({
        label: "Inspect element",
        click: () => win.webContents.inspectElement(params.x, params.y),
      });
    }
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function loadOfflinePage(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  rendererReady = false;
  const offlinePath = path.join(__dirname, "..", "resources", "offline.html");
  void mainWindow.loadFile(offlinePath);
}

function loadRenderer(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  rendererReady = false;
  void mainWindow.loadURL(rendererUrl);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#f4efe6",
    title: "Silicon Interface",
    icon: iconPath(),
    webPreferences: {
      session: configureSession(),
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: !production,
    },
  });
  mainWindow = win;
  installContextMenu(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedRendererUrl(url, trustedOrigin)) {
      setImmediate(() => {
        if (!win.isDestroyed()) void win.loadURL(url);
      });
    } else {
      openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url, trustedOrigin)) return;
    event.preventDefault();
    openExternal(url);
  });

  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  win.webContents.on("did-finish-load", () => {
    recoveryAttempts = 0;
  });

  win.webContents.on("did-fail-load", (_event, errorCode, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || validatedUrl.startsWith("file:")) return;
    recordSmokeResult({
      status: "load-failed",
      url: validatedUrl,
      detail: `${errorCode}: ${description}`,
    });
    loadOfflinePage();
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    recordSmokeResult({
      status: "renderer-gone",
      url: win.webContents.getURL(),
      detail: details.reason,
    });
    rendererReady = false;
    recoveryAttempts += 1;
    if (recoveryAttempts <= 3) {
      setTimeout(loadRenderer, Math.min(3_000, recoveryAttempts * 750));
    } else {
      loadOfflinePage();
    }
  });

  win.on("ready-to-show", () => {
    win.show();
    sendWindowState();
  });
  win.on("focus", sendWindowState);
  win.on("blur", sendWindowState);
  win.on("show", sendWindowState);
  win.on("hide", sendWindowState);
  win.on("minimize", sendWindowState);
  win.on("restore", sendWindowState);
  if (process.platform === "win32") {
    // Windows does not emit app.before-quit during shutdown, restart, or
    // sign-out. Hold the session end only for the same bounded local-durability
    // handshake used by an ordinary quit; once the renderer confirms its
    // journal, app.quit() releases the process so Windows can continue.
    win.on("query-session-end", (event) => {
      if (quitApproved) {
        quitting = true;
        return;
      }
      event.preventDefault();
      beginQuitHandshake({ surfaceFailure: false });
    });
    win.on("session-end", () => {
      quitting = true;
    });
  }
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  loadRenderer();
  return win;
}

function showMainWindow(): void {
  if (!app.isReady()) return;
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(): void {
  if (process.platform === "darwin" || tray) return;
  const image = nativeImage.createFromPath(iconPath());
  if (image.isEmpty()) return;
  tray = new Tray(process.platform === "win32" ? image.resize({ width: 16, height: 16 }) : image);
  tray.setToolTip("Silicon Interface");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Silicon Interface", click: showMainWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showMainWindow);
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(production ? [] : [{ role: "toggleDevTools" as const }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates…",
          click: () => void updater?.check(true),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (process.platform === "win32") app.setAppUserModelId("ai.45d.silicon-interface");
if (app.isPackaged && !smokeToken) app.setAsDefaultProtocolClient("silicon");

app.on("open-url", (event, url) => {
  event.preventDefault();
  queueDeepLink(parseDeepLink(url));
});

// macOS enforces the lock at the application/bundle level even when userData is
// redirected. A tokenized smoke launch is already isolated from every real
// profile and must be able to run beside an installed production instance.
const ownsInstanceLock = smokeToken ? true : app.requestSingleInstanceLock();
if (!ownsInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    queueDeepLink(extractDeepLinkArg(argv));
    showMainWindow();
  });

  app.whenReady().then(() => {
    registerIpc();
    installMenu();
    createWindow();
    createTray();
    updater = startDesktopUpdater({
      production,
      getWindow: () => mainWindow,
      onInstallRequested: () => {
        pendingUpdateInstall = true;
        beginQuitHandshake();
      },
    });
    queueDeepLink(extractDeepLinkArg(process.argv));
    powerMonitor.on("resume", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.lifecycleResume);
      }
    });
    powerMonitor.on("suspend", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.lifecycleSuspend);
      }
    });
    app.on("activate", showMainWindow);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !tray) app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitApproved) {
      quitting = true;
      return;
    }
    event.preventDefault();
    beginQuitHandshake();
  });

  app.on("will-quit", () => {
    updater?.stop();
  });
}
