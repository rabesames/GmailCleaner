import { describe, it, expect } from 'vitest';

// Split into its own file, deliberately: this test bumps the on-disk
// database version past what store.js will ever request, which requires no
// other connection to gmailCleaner to be open at the time. store.js never
// closes the connection it opens (by design -- see store.js), so this can
// only run safely in a worker where store.js hasn't been imported/used yet
// at all -- including by store.openDb.test.js's own schema-creation test,
// which is why that one lives in a separate file too.
describe('openDb error handling', () => {
  it('rejects when the requested version is lower than an existing database', async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('gmailCleaner', 99);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    const store = await import('./store.js');
    await expect(store.getActiveIds()).rejects.toBeTruthy();
  });
});
