import { writeFile } from "node:fs/promises";
import path from "node:path";

const SMOKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export type DesktopSmokeResult = {
  status: "ready" | "load-failed" | "renderer-gone";
  url: string;
  detail?: string;
  appVersion?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  packaged?: boolean;
};

export function parseDesktopSmokeToken(value: unknown): string | null {
  return typeof value === "string" && SMOKE_TOKEN_PATTERN.test(value) ? value : null;
}

export function desktopSmokeResultPath(tempDirectory: string, token: string): string {
  const safeToken = parseDesktopSmokeToken(token);
  if (!safeToken) throw new Error("Invalid desktop smoke token");
  return path.join(tempDirectory, `silicon-interface-smoke-${safeToken}.json`);
}

export function desktopSmokeProfilePath(tempDirectory: string, token: string): string {
  const safeToken = parseDesktopSmokeToken(token);
  if (!safeToken) throw new Error("Invalid desktop smoke token");
  return path.join(tempDirectory, `silicon-interface-smoke-profile-${safeToken}`);
}

export async function writeDesktopSmokeResult(
  tempDirectory: string,
  token: string,
  result: DesktopSmokeResult,
): Promise<string> {
  const resultPath = desktopSmokeResultPath(tempDirectory, token);
  const record = {
    schema: 1,
    ...result,
    pid: process.pid,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(resultPath, JSON.stringify(record) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return resultPath;
}
