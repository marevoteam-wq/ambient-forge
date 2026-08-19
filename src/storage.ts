import { Library, starterLibrary, validLibrary } from "./model";

const DB_NAME = "ambient-forge";
const STORE_NAME = "library";
const KEY = "main";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadLibrary(): Promise<Library> {
  try {
    const db = await openDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return validLibrary(value) ? value : starterLibrary();
  } catch {
    const fallback = localStorage.getItem(DB_NAME);
    if (fallback) {
      try { const value: unknown = JSON.parse(fallback); if (validLibrary(value)) return value; } catch { /* ignored */ }
    }
    return starterLibrary();
  }
}

export async function saveLibrary(library: Library): Promise<void> {
  localStorage.setItem(DB_NAME, JSON.stringify(library));
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(library, KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch { /* localStorage remains as fallback */ }
}
