"use client";

import * as React from "react";

import { api } from "./api";
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
export function useContacts(): UseContacts {
  const [byPeer, setByPeer] = React.useState<Map<string, Contact>>(new Map());
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const rows = await api.contacts();
      const m = new Map<string, Contact>();
      for (const c of rows) m.set(contactKey(c.target_kind, c.target_id), c);
      setByPeer(m);
    } catch {
      /* unauthenticated or offline — leave the map as-is */
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return { byPeer, loading, refresh };
}
