"use client";

import * as React from "react";

import {
  applicationConnectionStatusCopy,
  connectionStatusCanRetry,
  type ChatConnectionState,
} from "@/lib/connection-status";
import { createBannerConfirmationController } from "@/lib/banner-confirmation";

type ConnectionBannerValue = {
  state: ChatConnectionState;
  retry: (() => void) | null;
  issue: GlobalChatIssue | null;
  setConnection: (state: ChatConnectionState, retry: () => void) => void;
  setGlobalIssue: (issue: GlobalChatIssue | null) => void;
};

export type GlobalChatIssue = {
  kind: "session" | "storage" | "catching_up";
  message: string;
  retry?: (() => void) | null;
  retryLabel?: string;
  assertive?: boolean;
};

type AppBannerCondition = { key: string };

const ConnectionBannerContext = React.createContext<ConnectionBannerValue>({
  state: "online",
  retry: null,
  issue: null,
  setConnection: () => undefined,
  setGlobalIssue: () => undefined,
});

export function ChatConnectionProvider({ children }: { children: React.ReactNode }) {
  const [model, setModel] = React.useState<
    Pick<ConnectionBannerValue, "state" | "retry" | "issue">
  >({
    state: "online",
    retry: null,
    issue: null,
  });
  const setConnection = React.useCallback(
    (state: ChatConnectionState, retry: () => void) => {
      setModel((current) =>
        current.state === state && current.retry === retry
          ? current
          : { ...current, state, retry },
      );
    },
    [],
  );
  const setGlobalIssue = React.useCallback((issue: GlobalChatIssue | null) => {
    setModel((current) => ({ ...current, issue }));
  }, []);
  const value = React.useMemo(
    () => ({ ...model, setConnection, setGlobalIssue }),
    [model, setConnection, setGlobalIssue],
  );
  return (
    <ConnectionBannerContext.Provider value={value}>
      {children}
    </ConnectionBannerContext.Provider>
  );
}

export function useChatConnectionBanner(): ConnectionBannerValue {
  return React.useContext(ConnectionBannerContext);
}

export function ChatConnectionBanner() {
  const { state, retry, issue } = useChatConnectionBanner();
  const connectionCopy = applicationConnectionStatusCopy(state);
  // An ended session outranks every transport message: reconnecting cannot fix
  // it, and the offline copy would send the owner to wait rather than sign in.
  const selectedIssue = issue?.kind === "session" || issue?.kind === "storage"
    ? issue
    : connectionCopy
      ? null
      : issue;
  const copy = selectedIssue?.message ?? connectionCopy;
  const conditionKey = copy
    ? JSON.stringify(
        selectedIssue
          ? [
              "issue",
              selectedIssue.kind,
              copy,
              selectedIssue.retryLabel ?? "Retry",
              Boolean(selectedIssue.retry),
              Boolean(selectedIssue.assertive),
            ]
          : ["connection", state, copy],
      )
    : null;
  const condition = React.useMemo<AppBannerCondition | null>(
    () => (conditionKey ? { key: conditionKey } : null),
    [conditionKey],
  );
  const [confirmedCondition, setConfirmedCondition] =
    React.useState<AppBannerCondition | null>(null);
  const confirmationRef = React.useRef<
    ReturnType<typeof createBannerConfirmationController<AppBannerCondition>> | null
  >(null);

  React.useEffect(() => {
    const confirmation = createBannerConfirmationController<AppBannerCondition>({
      onVisibilityChange: setConfirmedCondition,
    });
    confirmationRef.current = confirmation;
    return () => {
      confirmation.dispose();
      confirmationRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    confirmationRef.current?.update(condition);
  }, [condition]);

  if (!copy || confirmedCondition !== condition) return null;

  const retryAction = selectedIssue?.retry ??
    (connectionStatusCanRetry(state) ? retry : null);
  const assertive = selectedIssue?.assertive || state === "offline" || state === "captive";
  return (
    <div
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      className="flex min-h-7 w-full items-center justify-center gap-3 bg-foreground px-3 py-1 text-center text-[11px] font-medium leading-4 text-background"
    >
      <span>{copy}</span>
      {retryAction ? (
        <button
          type="button"
          onClick={retryAction}
          className="border-l border-background/40 pl-3 font-semibold underline underline-offset-2 hover:no-underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-background"
        >
          {selectedIssue?.retryLabel ?? "Retry"}
        </button>
      ) : null}
    </div>
  );
}
