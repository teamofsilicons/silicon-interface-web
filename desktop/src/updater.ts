import { dialog, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

import { disableDifferentialUpdate, updateFeedUrl } from "./policy";

export interface DesktopUpdater {
  supported: boolean;
  check(manual?: boolean): Promise<void>;
  installDownloaded(): void;
  stop(): void;
}

export function startDesktopUpdater(options: {
  production: boolean;
  getWindow(): BrowserWindow | null;
  onInstallRequested(): void;
}): DesktopUpdater {
  const supported =
    options.production &&
    process.env.SILICON_DISABLE_UPDATES !== "1" &&
    (process.platform === "darwin" || process.platform === "win32");
  let manualCheck = false;
  let downloaded = false;
  let firstCheck: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  const show = async (message: string, detail: string): Promise<void> => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) return;
    await dialog.showMessageBox(win, {
      type: "info",
      title: "Silicon Interface updates",
      message,
      detail,
    });
  };

  const check = async (manual = false): Promise<void> => {
    if (!supported) {
      if (manual) {
        await show(
          "Updates are managed by your Linux package or app download.",
          "Install the latest package from the same trusted source you used for this app.",
        );
      }
      return;
    }
    manualCheck = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      if (manualCheck) {
        manualCheck = false;
        await show("Couldn’t check for updates.", "Check your connection and try again.");
      }
    }
  };

  if (supported) {
    const feedUrl = updateFeedUrl(process.platform, process.arch);
    if (!feedUrl) throw new Error("Unsupported desktop update architecture");
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableDifferentialDownload = disableDifferentialUpdate(
      process.platform,
      process.arch,
    );

    autoUpdater.on("update-not-available", () => {
      if (!manualCheck) return;
      manualCheck = false;
      void show("You’re up to date.", "Silicon Interface is already on the latest release.");
    });
    autoUpdater.on("update-available", () => {
      manualCheck = false;
    });
    autoUpdater.on("error", () => {
      if (!manualCheck) return;
      manualCheck = false;
      void show("Couldn’t check for updates.", "Check your connection and try again.");
    });
    autoUpdater.on("update-downloaded", () => {
      downloaded = true;
      const win = options.getWindow();
      if (!win || win.isDestroyed()) return;
      void dialog.showMessageBox(win, {
        type: "info",
        title: "Update ready",
        message: "A Silicon Interface update is ready.",
        detail: "Your drafts and pending messages will be saved before the app restarts.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) options.onInstallRequested();
      });
    });

    firstCheck = setTimeout(() => void check(false), 30_000);
    firstCheck.unref?.();
    interval = setInterval(() => void check(false), 4 * 60 * 60 * 1_000);
    interval.unref?.();
  }

  return {
    supported,
    check,
    installDownloaded() {
      if (supported && downloaded) autoUpdater.quitAndInstall(false, true);
    },
    stop() {
      if (firstCheck) clearTimeout(firstCheck);
      firstCheck = null;
      if (interval) clearInterval(interval);
      interval = null;
      autoUpdater.removeAllListeners();
    },
  };
}
