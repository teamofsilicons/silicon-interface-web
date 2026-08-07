"use client";

/**
 * A durable, synchronous answer to "can this browser still renew its session?".
 *
 * The renewable credential is an HttpOnly cookie the page cannot read, so the
 * only way to learn it is gone is to ask Glass — a round trip every cold boot
 * would otherwise have to finish before it could route anywhere. This record is
 * the local memory of what that round trip last proved, so the *next* boot can
 * route immediately: a browser whose session was working goes straight to the
 * chats, and only one that was proven expired is sent to the landing page.
 *
 * It is not a credential and never holds one — only timestamps. `expiredAt` is
 * written from positive evidence alone (a reachable Glass that kept answering
 * anonymous, or a typed revocation). Absence of evidence always reads as "not
 * expired", so an offline browser, a cleared localStorage, or one that has
 * simply never asked keeps its offline-capable session exactly as before.
 */

const KEY = "silicon-interface:session-expiry";

export interface SessionExpiryRecord {
  /** Last moment Glass proved this browser could still renew. */
  renewedAt: number | null;
  /** Exact expiry, on the flows where a readable refresh JWT carries one. */
  expiresAt: number | null;
  /** When the renewable credential was proven gone. Positive evidence only. */
  expiredAt: number | null;
}

const EMPTY: SessionExpiryRecord = { renewedAt: null, expiresAt: null, expiredAt: null };

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRaw(): SessionExpiryRecord {
  if (typeof window === "undefined") return EMPTY;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return EMPTY;
  }
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionExpiryRecord>;
    return {
      renewedAt: finiteNumber(parsed.renewedAt),
      expiresAt: finiteNumber(parsed.expiresAt),
      expiredAt: finiteNumber(parsed.expiredAt),
    };
  } catch {
    return EMPTY;
  }
}

function writeRaw(record: SessionExpiryRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Private mode / disabled storage. Routing falls back to asking Glass,
    // which is exactly the behaviour this record exists to skip.
  }
}

export function readSessionExpiry(): SessionExpiryRecord {
  return readRaw();
}

/**
 * The `exp` claim of a refresh token, when the flow hands one to the page at
 * all. The web session keeps its refresh token in an HttpOnly cookie, so this
 * is normally null and the record falls back to proof-by-observation.
 */
function refreshTokenExpiry(token: string | null | undefined): number | null {
  if (!token || typeof window === "undefined") return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base = payload.replace(/-/g, "+").replace(/_/g, "/");
    const normalized = base.padEnd(Math.ceil(base.length / 4) * 4, "=");
    const parsed = JSON.parse(window.atob(normalized)) as { exp?: unknown };
    const exp = finiteNumber(parsed.exp);
    return exp === null ? null : exp * 1_000;
  } catch {
    return null;
  }
}

/**
 * Glass just renewed request authority, so the credential is live right now.
 * Clears any expiry proof: whatever was true before, it is not true now.
 */
export function noteSessionRenewed(refreshToken?: string | null): void {
  writeRaw({
    renewedAt: Date.now(),
    expiresAt: refreshTokenExpiry(refreshToken),
    expiredAt: null,
  });
}

/**
 * The renewable credential is proven gone. Idempotent: repeated reports keep
 * the first observation, so the boot path sees a stable answer.
 */
export function noteSessionExpired(): void {
  const current = readRaw();
  if (current.expiredAt !== null) return;
  writeRaw({ ...current, expiredAt: Date.now() });
}

/** Explicit logout has its own marker; leave nothing behind to contradict it. */
export function forgetSessionExpiry(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — nothing retained to clear */
  }
}

/**
 * Whether this browser is *known* to have lost its renewable credential.
 *
 * Never a guess. An unknown record, an unreachable Glass, and a browser that
 * has never booted all answer false, so nothing here can turn a transient
 * failure into a logout.
 */
export function renewableSessionExpired(now = Date.now()): boolean {
  const record = readRaw();
  if (record.expiredAt !== null) return true;
  return record.expiresAt !== null && record.expiresAt <= now;
}
