"use client";

const DB_NAME = "silicon-interface-abuse-proofs";
const STORE = "proofs";
let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "token" });
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("proof database upgrade blocked"));
  });
  return database;
}

export async function readAbuseProof(token: string): Promise<string | null> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(token);
    return await new Promise<string | null>((resolve, reject) => {
      request.onsuccess = () => {
        const answer = (request.result as { answer?: unknown } | undefined)?.answer;
        resolve(typeof answer === "string" && answer ? answer : null);
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function removeAbuseProof(token: string): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(token);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // An expired proof is unusable server-side; cleanup is best effort.
  }
}

export async function clearAbuseProofs(): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // Best effort on logout; server expiry still bounds every proof.
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("silicon-interface:auth-clear", () => void clearAbuseProofs());
}
