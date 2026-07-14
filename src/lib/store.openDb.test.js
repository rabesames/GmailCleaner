import { describe, it, expect } from 'vitest';

// Split into its own file, deliberately: this test needs to be the very
// first thing to touch this worker's `gmailCleaner` IndexedDB database, so
// store.js's own onupgradeneeded handler (schema creation) fires against a
// genuinely fresh database -- every other test file's beforeEach pre-creates
// the schema via its own connection first. store.js never closes the
// connection it opens (by design -- see store.js), so a second test in this
// same file attempting a version bump (see store.versionConflict.test.js)
// would deadlock waiting for this one's connection to close first.
describe('openDb schema creation', () => {
  it('creates all six object stores on a genuinely fresh database', async () => {
    const store = await import('./store.js');

    // Exercises all six stores so this fails loudly if the upgrade
    // handler is broken for any one of them, not just "some" store.
    await expect(store.getActiveIds()).resolves.toEqual([]);
    await expect(store.getLastSyncedAt()).resolves.toBeNull();
    await expect(store.getIgnoredSenders()).resolves.toEqual([]);
    await expect(store.getContactedAddresses()).resolves.toEqual([]);
    await expect(store.getTrashedSenders()).resolves.toEqual([]);
    await expect(store.getScannedSentIds()).resolves.toEqual([]);
  });
});
