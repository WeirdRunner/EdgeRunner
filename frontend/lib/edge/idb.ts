// A tiny IndexedDB key/value store (browser storage that survives reloads and holds far more than localStorage).

const DB = "edgerunner";
const STORE = "kv";
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ||= new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  }));
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await open();
  return new Promise((ok, bad) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => ok((req as IDBRequest | undefined)?.result as T);
    t.onerror = () => bad(t.error);
  });
}

export const idb = {
  get: <T = unknown>(key: string) => tx<T | undefined>("readonly", (s) => s.get(key)),
  set: (key: string, value: unknown) => tx<void>("readwrite", (s) => s.put(value, key)),
  del: (key: string) => tx<void>("readwrite", (s) => s.delete(key)),
};
