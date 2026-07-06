import { describe, it, expect, beforeEach } from 'vitest';
import * as store from './store.js';

// store.js opens exactly one IndexedDB connection and never closes it (by
// design -- it's meant to live for the whole page session), so per-test
// isolation can't use indexedDB.deleteDatabase(): that requires every open
// connection to close first, and store.js's connection never will, which
// would deadlock deleteDatabase() forever. Instead, each test clears the
// object stores' *contents* through a second, short-lived connection at the
// same version -- opening another connection at an unchanged version never
// blocks, unlike a version bump/delete would.
function clearAllStores() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('gmailCleaner', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('ignoredSenders')) db.createObjectStore('ignoredSenders', { keyPath: 'email' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['messages', 'meta', 'ignoredSenders'], 'readwrite');
      tx.objectStore('messages').clear();
      tx.objectStore('meta').clear();
      tx.objectStore('ignoredSenders').clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(async () => {
  await clearAllStores();
});

describe('messages: upsert / markGone / getActiveIds', () => {
  it('returns an empty list before anything is stored', async () => {
    await expect(store.getActiveIds()).resolves.toEqual([]);
  });

  it('tracks inserted messages as active', async () => {
    await store.upsertMessages([
      { id: '1', from: 'a@example.com', sizeEstimate: 10 },
      { id: '2', from: 'b@example.com', sizeEstimate: 20 },
    ]);
    const active = await store.getActiveIds();
    expect(active.sort()).toEqual(['1', '2']);
  });

  it('excludes ids marked gone from the active set', async () => {
    await store.upsertMessages([
      { id: '1', from: 'a@example.com', sizeEstimate: 10 },
      { id: '2', from: 'b@example.com', sizeEstimate: 20 },
    ]);
    await store.markGone(['1']);
    await expect(store.getActiveIds()).resolves.toEqual(['2']);
  });

  it('silently ignores markGone for an id that was never stored', async () => {
    await expect(store.markGone(['does-not-exist'])).resolves.toBeUndefined();
  });

  it('upsert overwrites an existing record for the same id', async () => {
    await store.upsertMessages([{ id: '1', from: 'a@example.com', sizeEstimate: 10 }]);
    await store.upsertMessages([{ id: '1', from: 'a@example.com', sizeEstimate: 999 }]);
    const senders = await store.getTopSenders();
    expect(senders[0].totalSize).toBe(999);
  });
});

describe('lastSyncedAt', () => {
  it('is null before it has ever been set', async () => {
    await expect(store.getLastSyncedAt()).resolves.toBeNull();
  });

  it('returns the value after being set', async () => {
    await store.setLastSyncedAt('2026-01-01T00:00:00.000Z');
    await expect(store.getLastSyncedAt()).resolves.toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('clearAllData', () => {
  it('wipes messages and lastSyncedAt but preserves ignoredSenders', async () => {
    await store.upsertMessages([{ id: '1', from: 'a@example.com', sizeEstimate: 10 }]);
    await store.setLastSyncedAt('2026-01-01T00:00:00.000Z');
    await store.ignoreSender('spam@example.com');

    await store.clearAllData();

    await expect(store.getActiveIds()).resolves.toEqual([]);
    await expect(store.getLastSyncedAt()).resolves.toBeNull();
    await expect(store.getIgnoredSenders()).resolves.toEqual(['spam@example.com']);
  });
});

describe('ignoreSender / unignoreSender / getIgnoredSenders', () => {
  it('starts empty', async () => {
    await expect(store.getIgnoredSenders()).resolves.toEqual([]);
  });

  it('adds and removes senders', async () => {
    await store.ignoreSender('a@example.com');
    await store.ignoreSender('b@example.com');
    await expect(store.getIgnoredSenders()).resolves.toEqual(expect.arrayContaining(['a@example.com', 'b@example.com']));

    await store.unignoreSender('a@example.com');
    await expect(store.getIgnoredSenders()).resolves.toEqual(['b@example.com']);
  });

  it('unignoring a sender that was never ignored is a no-op', async () => {
    await store.unignoreSender('nobody@example.com');
    await expect(store.getIgnoredSenders()).resolves.toEqual([]);
  });
});

describe('decodeMimeWords', () => {
  it('returns falsy input unchanged', () => {
    expect(store.decodeMimeWords(null)).toBeNull();
    expect(store.decodeMimeWords('')).toBe('');
    expect(store.decodeMimeWords(undefined)).toBeUndefined();
  });

  it('leaves plain text with no encoded words unchanged', () => {
    expect(store.decodeMimeWords('Plain Subject')).toBe('Plain Subject');
  });

  it('decodes a base64 (B) encoded word', () => {
    expect(store.decodeMimeWords('=?UTF-8?B?SGVsbG8=?=')).toBe('Hello');
  });

  it('decodes a base64 encoded word in a non-utf-8 charset', () => {
    // "Caf" + 0xE9 (é in latin1/iso-8859-1) base64-encoded.
    const b64 = btoa('Caf\xe9');
    expect(store.decodeMimeWords(`=?ISO-8859-1?B?${b64}?=`)).toBe('Café');
  });

  it('decodes a quoted-printable (Q) encoded word with underscores as spaces', () => {
    expect(store.decodeMimeWords('=?UTF-8?Q?Hello_World?=')).toBe('Hello World');
  });

  it('decodes a quoted-printable encoded word with hex escapes', () => {
    expect(store.decodeMimeWords('=?UTF-8?Q?Caf=C3=A9?=')).toBe('Café');
  });

  it('falls back to the raw text when base64 decoding throws', () => {
    expect(store.decodeMimeWords('=?UTF-8?B?not valid base64!!!?=')).toBe('not valid base64!!!');
  });

  it('falls back to utf-8 decoding when the charset label is unsupported', () => {
    const b64 = btoa('Hello');
    expect(store.decodeMimeWords(`=?totally-bogus-charset?B?${b64}?=`)).toBe('Hello');
  });
});

describe('getTopSenders', () => {
  it('groups by sender email and sums size/count', async () => {
    await store.upsertMessages([
      { id: '1', from: 'Alice <alice@example.com>', sizeEstimate: 100 },
      { id: '2', from: 'Alice <alice@example.com>', sizeEstimate: 50 },
      { id: '3', from: 'Bob <bob@example.com>', sizeEstimate: 10 },
    ]);
    const senders = await store.getTopSenders();
    const alice = senders.find((s) => s.email === 'alice@example.com');
    expect(alice.messageCount).toBe(2);
    expect(alice.totalSize).toBe(150);
    expect(alice.ids.sort()).toEqual(['1', '2']);
  });

  it('sorts by total size descending', async () => {
    await store.upsertMessages([
      { id: '1', from: 'small@example.com', sizeEstimate: 10 },
      { id: '2', from: 'big@example.com', sizeEstimate: 1000 },
    ]);
    const senders = await store.getTopSenders();
    expect(senders.map((s) => s.email)).toEqual(['big@example.com', 'small@example.com']);
  });

  it('excludes deleted messages', async () => {
    await store.upsertMessages([{ id: '1', from: 'a@example.com', sizeEstimate: 10 }]);
    await store.markGone(['1']);
    await expect(store.getTopSenders()).resolves.toEqual([]);
  });

  it('excludes ignored senders entirely', async () => {
    await store.upsertMessages([{ id: '1', from: 'spam@example.com', sizeEstimate: 10 }]);
    await store.ignoreSender('spam@example.com');
    await expect(store.getTopSenders()).resolves.toEqual([]);
  });

  it('excludes messages with no parseable sender', async () => {
    await store.upsertMessages([
      { id: '1', from: null, sizeEstimate: 10 },
      { id: '2', from: 'not an email and no angle brackets', sizeEstimate: 10 },
    ]);
    await expect(store.getTopSenders()).resolves.toEqual([]);
  });

  it('parses a bare email address with no display name', async () => {
    await store.upsertMessages([{ id: '1', from: 'plain@example.com', sizeEstimate: 5 }]);
    const [sender] = await store.getTopSenders();
    expect(sender).toMatchObject({ email: 'plain@example.com', name: null });
  });

  it('strips quotes from a quoted display name', async () => {
    await store.upsertMessages([{ id: '1', from: '"Quoted Name" <quoted@example.com>', sizeEstimate: 5 }]);
    const [sender] = await store.getTopSenders();
    expect(sender.name).toBe('Quoted Name');
  });

  it('treats an angle-bracket address with an empty name as having no name', async () => {
    await store.upsertMessages([{ id: '1', from: '<bare@example.com>', sizeEstimate: 5 }]);
    const [sender] = await store.getTopSenders();
    expect(sender).toMatchObject({ email: 'bare@example.com', name: null });
  });

  it('treats a missing sizeEstimate as contributing zero bytes', async () => {
    await store.upsertMessages([{ id: '1', from: 'a@example.com' }]);
    const [sender] = await store.getTopSenders();
    expect(sender.totalSize).toBe(0);
  });

  it('keeps the last known non-null name across messages', async () => {
    await store.upsertMessages([
      { id: '1', from: 'Alice <alice@example.com>', sizeEstimate: 1 },
      { id: '2', from: 'alice@example.com', sizeEstimate: 1 }, // no display name this time
    ]);
    const [sender] = await store.getTopSenders();
    expect(sender.name).toBe('Alice'); // not overwritten by the nameless message
  });

  it('picks the message with the latest parseable date as the preview', async () => {
    await store.upsertMessages([
      { id: '1', from: 'a@example.com', sizeEstimate: 1, date: 'Wed, 1 Jan 2025 00:00:00 +0000', subject: 'Old' },
      { id: '2', from: 'a@example.com', sizeEstimate: 1, date: 'Thu, 1 Jan 2026 00:00:00 +0000', subject: 'New' },
    ]);
    const [sender] = await store.getTopSenders();
    expect(sender.latestMessage.subject).toBe('New');
  });

  it('falls back to (no subject) when the latest message has no subject', async () => {
    await store.upsertMessages([{ id: '1', from: 'a@example.com', sizeEstimate: 1, date: 'Wed, 1 Jan 2025 00:00:00 +0000' }]);
    const [sender] = await store.getTopSenders();
    expect(sender.latestMessage.subject).toBe('(no subject)');
  });

  it('uses a fallback preview when no message has a parseable date', async () => {
    await store.upsertMessages([{ id: '1', from: 'a@example.com', sizeEstimate: 1, subject: 'No date here' }]);
    const [sender] = await store.getTopSenders();
    expect(sender.latestMessage).toEqual({ subject: 'No date here', snippet: '', date: null });
  });

  it('keeps the first fallback preview when a later message also has no parseable date', async () => {
    await store.upsertMessages([
      { id: '1', from: 'a@example.com', sizeEstimate: 1, subject: 'First' },
      { id: '2', from: 'a@example.com', sizeEstimate: 1, subject: 'Second' },
    ]);
    const [sender] = await store.getTopSenders();
    expect(sender.latestMessage.subject).toBe('First');
  });

  it('replaces an undated fallback once a message with a real date arrives', async () => {
    await store.upsertMessages([
      { id: '1', from: 'a@example.com', sizeEstimate: 1, subject: 'Undated' },
      { id: '2', from: 'a@example.com', sizeEstimate: 1, subject: 'Dated', date: 'Wed, 1 Jan 2025 00:00:00 +0000' },
    ]);
    const [sender] = await store.getTopSenders();
    expect(sender.latestMessage.subject).toBe('Dated');
  });
});
