"use client";

import * as React from "react";

import { api } from "./api";
import { loadCachedContacts, saveCachedContacts } from "./sidebar-cache";
import type { Contact } from "./types";

/** Key for the contacts map: "<kind>:<public_id>". */
export function contactKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

interface UseContacts {
  /** Map keyed by `${kind}:${id}` → Contact, for O(1) per-peer lookup. */
  byPeer: Map<string, Contact>;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Loads the signed-in carbon's saved contacts once and exposes them as a map
 * keyed by peer. Call `refresh()` after saving/deleting a contact.
 */
export function useContacts(ownerId?: string | null): UseContacts {
  const [byPeer, setByPeer] = React.useState<Map<string, Contact>>(new Map());
  const [loading, setLoading] = React.useState(true);

  const setRows = React.useCallback((rows: Contact[]) => {
    const m = new Map<string, Contact>();
    for (const c of rows) m.set(contactKey(c.target_kind, c.target_id), c);
    setByPeer(m);
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const rows = await api.contacts();
      setRows(rows);
      if (ownerId) saveCachedContacts(ownerId, rows);
    } catch {
      /* unauthenticated or offline — leave the map as-is */
    } finally {
      setLoading(false);
    }
  }, [ownerId, setRows]);

  React.useEffect(() => {
    let alive = true;
    const cached = ownerId ? loadCachedContacts(ownerId) : null;
    if (cached) {
      setRows(cached);
      setLoading(false);
    } else {
      setRows([]);
      setLoading(true);
    }
    (async () => {
      try {
        const rows = await api.contacts();
        if (!alive) return;
        setRows(rows);
        if (ownerId) saveCachedContacts(ownerId, rows);
      } catch {
        /* unauthenticated or offline — leave the cached map as-is */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ownerId, setRows]);

  return { byPeer, loading, refresh };
}
