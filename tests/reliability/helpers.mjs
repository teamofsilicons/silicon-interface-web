import { IDBKeyRange, indexedDB } from "fake-indexeddb";

export { indexedDB };

export class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key) {
    return this.#values.has(String(key)) ? this.#values.get(String(key)) : null;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key) {
    this.#values.delete(String(key));
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }
}

export function installBrowser(storage = new MemoryStorage(), database = indexedDB) {
  globalThis.window = { indexedDB: database, localStorage: storage };
  globalThis.IDBKeyRange = IDBKeyRange;
  return storage;
}

export function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database ${name} is blocked`));
  });
}

export function event(eventId, createdAt, body) {
  return {
    event_id: eventId,
    room: 1,
    sender_kind: "carbon",
    sender_id: 1,
    sender_handle: "tester",
    type: "m.text",
    content: { body },
    reply_to_event_id: "",
    is_final: true,
    created_at: createdAt,
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
  };
}
