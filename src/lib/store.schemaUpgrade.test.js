import { describe, it, expect } from 'vitest';

// Split into its own file for the same connection-lifecycle reason as
// store.openDb.test.js and store.versionConflict.test.js: store.js never
// closes its connection, so this needs to be the only thing that has ever
// touched this worker's `gmailCleaner` database.
//
// Simulates a version bump that doesn't actually need new stores (e.g. a
// future DB_VERSION increase for some unrelated reason) by pre-creating all
// three stores at version 1, then letting store.js open at its current
// DB_VERSION. onupgradeneeded still fires on any version increase
// regardless of whether the schema itself changed, so this is what actually
// exercises the "already exists, skip" branch of each
// `if (!db.objectStoreNames.contains(...))` check -- every other test only
// ever sees a totally-fresh database, where all three checks are
// unconditionally true (the "create" branch, covered by
// store.openDb.test.js).
describe('openDb schema upgrade', () => {
  it('skips creating object stores that already exist', async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('gmailCleaner', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('messages', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('ignoredSenders', { keyPath: 'email' });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    const store = await import('./store.js');

    // All three pre-existing stores must survive untouched and still work.
    await expect(store.getActiveIds()).resolves.toEqual([]);
    await expect(store.getLastSyncedAt()).resolves.toBeNull();
    await expect(store.getIgnoredSenders()).resolves.toEqual([]);
  });
});
