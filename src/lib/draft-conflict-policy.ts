export type DraftConflictChoiceResult = {
  text: string;
  version: number;
  needsSync: boolean;
};

export function resolveDraftChoice(
  localText: string,
  localVersion: number,
  remoteText: string,
  remoteVersion: number,
  choice: "local" | "remote",
): DraftConflictChoiceResult {
  return {
    text: choice === "remote" ? remoteText : localText,
    version: Math.max(0, Math.trunc(localVersion), Math.trunc(remoteVersion)),
    needsSync: choice === "local",
  };
}
