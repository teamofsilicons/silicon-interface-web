"use client";

export interface AbuseCaptchaOption {
  provider: "turnstile";
  site_key: string;
  action: "abuse_challenge";
  cdata: string;
}

export interface AbuseChallenge {
  token: string;
  options: Array<"push" | "captcha">;
  expires_at: string;
  captcha?: AbuseCaptchaOption;
}

export interface StoredAbuseChallenge {
  key: string;
  ownerId: string;
  challenge: AbuseChallenge;
  updatedAt: number;
}

export const ABUSE_CHALLENGE_EVENT = "silicon-interface:abuse-challenge";
export const ABUSE_CHALLENGE_SOLVED_EVENT = "silicon-interface:abuse-challenge-solved";
const PREFIX = "silicon-interface:abuse-challenges";
const REMOVED_PREFIX = "silicon-interface:abuse-challenge-tombstones";
const DB_NAME = "silicon-interface-abuse-challenges";
const STORE = "challenges";
let database: Promise<IDBDatabase> | null = null;
const solvedTokens = new Set<string>();

function mirrorKey(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

function removedKey(ownerId: string): string {
  return `${REMOVED_PREFIX}:${encodeURIComponent(ownerId)}`;
}

function readRemoved(ownerId: string): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(removedKey(ownerId)) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeRemoved(ownerId: string, tokens: Set<string>): void {
  try {
    window.localStorage.setItem(
      removedKey(ownerId),
      JSON.stringify([...tokens].slice(-256)),
    );
  } catch {
    // IndexedDB deletion remains authoritative when the mirror is unavailable.
  }
}

function parseChallenge(value: unknown): AbuseChallenge | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.token !== "string" ||
    !row.token ||
    typeof row.expires_at !== "string" ||
    !Array.isArray(row.options) ||
    !row.options.every((option) => option === "push" || option === "captcha")
  ) return null;
  const captcha = row.captcha;
  const parsedCaptcha =
    captcha &&
    typeof captcha === "object" &&
    (captcha as Record<string, unknown>).provider === "turnstile" &&
    typeof (captcha as Record<string, unknown>).site_key === "string" &&
    (captcha as Record<string, unknown>).action === "abuse_challenge" &&
    typeof (captcha as Record<string, unknown>).cdata === "string"
      ? (captcha as AbuseCaptchaOption)
      : undefined;
  return {
    token: row.token,
    options: [...row.options] as Array<"push" | "captcha">,
    expires_at: row.expires_at,
    ...(parsedCaptcha ? { captcha: parsedCaptcha } : {}),
  };
}

export function challengeFromErrorBody(body: unknown): AbuseChallenge | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  if (row.code !== "challenge_required") return null;
  return parseChallenge(row.challenge);
}

function readMirror(ownerId: string): StoredAbuseChallenge[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(mirrorKey(ownerId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): StoredAbuseChallenge[] => {
      if (!value || typeof value !== "object") return [];
      const row = value as Partial<StoredAbuseChallenge>;
      const challenge = parseChallenge(row.challenge);
      if (
        row.ownerId !== ownerId ||
        typeof row.key !== "string" ||
        typeof row.updatedAt !== "number" ||
        !challenge
      ) return [];
      return [{ key: row.key, ownerId, challenge, updatedAt: row.updatedAt }];
    });
  } catch {
    return [];
  }
}

function writeMirror(ownerId: string, rows: StoredAbuseChallenge[]): boolean {
  try {
    window.localStorage.setItem(mirrorKey(ownerId), JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("owner", "ownerId");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("challenge database upgrade blocked"));
  });
  return database;
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function rememberAbuseChallenge(
  ownerId: string,
  challenge: AbuseChallenge,
): Promise<void> {
  if (!ownerId || typeof window === "undefined") return;
  const row: StoredAbuseChallenge = {
    key: `${ownerId}:${challenge.token}`,
    ownerId,
    challenge,
    updatedAt: Date.now(),
  };
  const removed = readRemoved(ownerId);
  removed.delete(challenge.token);
  writeRemoved(ownerId, removed);
  const mirrored = writeMirror(ownerId, [
    ...readMirror(ownerId).filter((item) => item.challenge.token !== challenge.token),
    row,
  ]);
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    transaction.objectStore(STORE).put(row);
    await complete(transaction);
  } catch (error) {
    if (!mirrored) throw error;
  }
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(ABUSE_CHALLENGE_EVENT, { detail: challenge }));
  }
}

export async function listAbuseChallenges(ownerId: string): Promise<AbuseChallenge[]> {
  if (!ownerId || typeof window === "undefined") return [];
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).index("owner").getAll(ownerId);
    const rows = await new Promise<StoredAbuseChallenge[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as StoredAbuseChallenge[]);
      request.onerror = () => reject(request.error);
    });
    const merged = new Map<string, StoredAbuseChallenge>();
    for (const row of [...readMirror(ownerId), ...rows]) {
      if (!merged.has(row.challenge.token) || merged.get(row.challenge.token)!.updatedAt < row.updatedAt) {
        merged.set(row.challenge.token, row);
      }
    }
    const removed = readRemoved(ownerId);
    const result = [...merged.values()]
      .filter((row) => !removed.has(row.challenge.token))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    writeMirror(ownerId, result);
    return result.map((row) => row.challenge);
  } catch {
    return readMirror(ownerId).map((row) => row.challenge);
  }
}

export async function removeAbuseChallenge(ownerId: string, token: string): Promise<void> {
  const removed = readRemoved(ownerId);
  removed.add(token);
  writeRemoved(ownerId, removed);
  writeMirror(ownerId, readMirror(ownerId).filter((row) => row.challenge.token !== token));
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(`${ownerId}:${token}`);
    await complete(transaction);
  } catch {
    // The recovery mirror already removed it; a later merge uses updated rows.
  }
}

export async function markAbuseChallengeSolved(ownerId: string, token: string): Promise<void> {
  solvedTokens.add(token);
  await removeAbuseChallenge(ownerId, token);
}

export function wasAbuseChallengeSolved(token: string): boolean {
  return solvedTokens.has(token);
}

export async function clearAbuseChallenges(ownerId: string): Promise<void> {
  const rows = await listAbuseChallenges(ownerId).catch(() => []);
  await Promise.all(rows.map((row) => removeAbuseChallenge(ownerId, row.token)));
  solvedTokens.clear();
  try {
    window.localStorage.removeItem(mirrorKey(ownerId));
  } catch {
    // Best effort; tombstones still prevent resurrection.
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("silicon-interface:auth-clear", (event) => {
    const ownerKey = (event as CustomEvent<{ ownerKey?: string | null }>).detail?.ownerKey;
    const owner = ownerKey?.startsWith("carbon:") ? ownerKey.slice("carbon:".length) : ownerKey;
    if (owner) void clearAbuseChallenges(owner);
  });
}
