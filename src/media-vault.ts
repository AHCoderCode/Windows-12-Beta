export type MediaKind = 'image' | 'audio' | 'paint-session';
export type SavedUpload = {
  id: string;
  kind: MediaKind;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  savedAt: string;
  blob: Blob;
};

const DB_NAME = 'aeroshell-user-media';
const DB_VERSION = 1;
const STORE_NAME = 'uploads';

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Persistent browser storage is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('kind', 'kind', { unique: false });
        store.createIndex('savedAt', 'savedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the media library.'));
    request.onblocked = () => reject(new Error('The media library is busy in another tab. Close older AeroShell tabs and retry.'));
  });
}

export async function saveUserUpload(file: File, kind: MediaKind): Promise<SavedUpload> {
  const id = crypto.randomUUID();
  const item: SavedUpload = {
    id, kind, name: file.name || (kind === 'image' ? 'image-upload' : 'audio-upload'),
    type: file.type || (kind === 'image' ? 'application/octet-stream' : 'application/octet-stream'),
    size: file.size, lastModified: file.lastModified, savedAt: new Date().toISOString(), blob: file,
  };
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not save the uploaded file.'));
      tx.onabort = () => reject(tx.error ?? new Error('Saving the uploaded file was cancelled.'));
    });
    return item;
  } finally {
    db.close();
  }
}

export async function listUserUploads(kind: MediaKind): Promise<SavedUpload[]> {
  const db = await openDatabase();
  try {
    return await new Promise<SavedUpload[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).index('kind').getAll(kind);
      request.onsuccess = () => resolve((request.result as SavedUpload[]).sort((a,b)=>a.savedAt.localeCompare(b.savedAt)));
      request.onerror = () => reject(request.error ?? new Error('Could not load saved uploads.'));
    });
  } finally {
    db.close();
  }
}

export async function removeUserUpload(id: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not remove the uploaded file.'));
      tx.onabort = () => reject(tx.error ?? new Error('Removing the uploaded file was cancelled.'));
    });
  } finally {
    db.close();
  }
}
