// Ablage des Zwischenspeichers in IndexedDB: eine Datei je Browser und Sitzung. Alles ist best effort. Fehlt IndexedDB oder
// schlägt etwas fehl (privater Modus, volle Platte), bleibt es beim Neuladen vom Server.

export interface SnapshotBackend {
  get(): Promise<Uint8Array | null>;
  put(bytes: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}

const DB_NAME = 'warera-cases';
const STORE = 'snapshot';
const KEY = 'session';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB lässt sich nicht öffnen'));
    request.onblocked = () => reject(new Error('IndexedDB ist blockiert'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    let request: IDBRequest<T>;
    try {
      const tx = db.transaction(STORE, mode);
      request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? request.error ?? new Error('IndexedDB-Vorgang abgebrochen'));
      };
    } catch (err) {
      db.close();
      reject(err);
    }
  });
}

/** Der Speicher des Browsers, oder null, wenn es keinen gibt. */
export function indexedDbBackend(): SnapshotBackend | null {
  if (typeof indexedDB === 'undefined') return null;
  return {
    async get() {
      const value = await run<unknown>('readonly', (store) => store.get(KEY));
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      return null;
    },
    async put(bytes) {
      await run('readwrite', (store) => store.put(bytes, KEY));
    },
    async remove() {
      await run('readwrite', (store) => store.delete(KEY));
    },
  };
}
