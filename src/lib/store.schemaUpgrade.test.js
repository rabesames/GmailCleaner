import { describe, it, expect } from 'vitest';

// Split into its own file for the same connection-lifecycle reason as
// store.openDb.test.js and store.versionConflict.test.js: store.js never
// closes its connection, so this needs to be the only thing that has ever
// touched this worker's `gmailCleaner` database.
//
// Simulates a version bump where only the original three stores already
// exist (e.g. a user upgrading from the v2 schema) by pre-creating just
// those three at version 1, then letting store.js open at its current
// DB_VERSION. onupgradeneeded still fires on any version increase
// regardless of whether the schema itself changed, so this is what actually
// exercises both branches of each `if (!db.objectStoreNames.contains(...))`
// check in the same pass: "already exists, skip" for the original three,
// and "doesn't exist yet, create" for the three v3 additions -- every other
// test only ever sees a totally-fresh database, where all six checks are
// unconditionally true (covered by store.openDb.test.js).
describe('openDb schema upgrade', () => {
  it('skips creating object stores that already exist, and creates newly-added ones', async () => {
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

    // The three pre-existing stores must survive untouched and still work.
    await expect(store.getActiveIds()).resolves.toEqual([]);
    await expect(store.getLastSyncedAt()).resolves.toBeNull();
    await expect(store.getIgnoredSenders()).resolves.toEqual([]);
    // The three v3 stores must have been newly created in the same upgrade.
    await expect(store.getContactedAddresses()).resolves.toEqual([]);
    await expect(store.getTrashedSenders()).resolves.toEqual([]);
    await expect(store.getScannedSentIds()).resolves.toEqual([]);
  });
});
