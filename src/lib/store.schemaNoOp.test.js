import { describe, it, expect } from 'vitest';

// Split into its own file for the same connection-lifecycle reason as
// store.openDb.test.js, store.schemaUpgrade.test.js, and
// store.versionConflict.test.js: store.js never closes its connection, so
// this needs to be the only thing that has ever touched this worker's
// `gmailCleaner` database.
//
// store.schemaUpgrade.test.js exercises the "already exists, skip" branch
// for the three *original* stores, and the "doesn't exist yet, create"
// branch for the three v3 additions, in the same pass -- but it never
// exercises the "already exists, skip" branch for the v3 stores themselves,
// since nothing in this codebase's history has ever opened a database that
// already had them. This simulates that (e.g. a hypothetical future
// DB_VERSION bump that adds no new stores) by pre-creating all six at v1,
// so every `if (!db.objectStoreNames.contains(...))` check in store.js's
// upgrade handler hits its "skip" branch.
describe('openDb schema upgrade with everything already present', () => {
  it('skips creating every object store when all six already exist', async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('gmailCleaner', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('messages', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('ignoredSenders', { keyPath: 'email' });
        db.createObjectStore('contactedAddresses', { keyPath: 'email' });
        db.createObjectStore('trashedSenders', { keyPath: 'email' });
        db.createObjectStore('scannedSentIds', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    const store = await import('./store.js');

    // All six pre-existing stores must survive untouched and still work.
    await expect(store.getActiveIds()).resolves.toEqual([]);
    await expect(store.getLastSyncedAt()).resolves.toBeNull();
    await expect(store.getIgnoredSenders()).resolves.toEqual([]);
    await expect(store.getContactedAddresses()).resolves.toEqual([]);
    await expect(store.getTrashedSenders()).resolves.toEqual([]);
    await expect(store.getScannedSentIds()).resolves.toEqual([]);
  });
});
