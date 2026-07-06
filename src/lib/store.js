// All message data lives in IndexedDB (the "gmailCleaner" database) rather
// than sessionStorage, so it survives tab closes and browser restarts --
// no more re-syncing the whole inbox every session, and no ~5-10MB cap.
// This is a deliberate exception to this app's usual "nothing persists"
// rule; the OAuth Client ID (auth.js, fed from a React input, never
// stored) and the access token (sessionStorage, short-lived and revocable)
// remain exactly as ephemeral as before. There is still no server.
const DB_NAME = 'gmailCleaner';
const DB_VERSION = 2;
const MESSAGES_STORE = 'messages';
const META_STORE = 'meta';
const IGNORED_STORE = 'ignoredSenders';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(IGNORED_STORE)) {
          db.createObjectStore(IGNORED_STORE, { keyPath: 'email' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDb();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await callback(store);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    /* v8 ignore start -- every call site in this file passes correctly-shaped
       data through put/get/delete/clear, and IndexedDB reports misuse of
       those (bad keys, read-only violations) synchronously, not via
       onerror/onabort. Those events are reserved for things like quota/disk
       errors that aren't practically reproducible through this module's own
       valid-input call patterns without reaching into fake-indexeddb internals. */
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    /* v8 ignore stop */
  });
  return result;
}

async function getAllMessages() {
  return withStore(MESSAGES_STORE, 'readonly', (store) => promisifyRequest(store.getAll()));
}

export async function upsertMessages(records) {
  return withStore(MESSAGES_STORE, 'readwrite', (store) => {
    for (const record of records) store.put(record);
  });
}

export async function markGone(ids) {
  return withStore(MESSAGES_STORE, 'readwrite', async (store) => {
    for (const id of ids) {
      // IndexedDB has no partial-update op -- read the full record, flip
      // the flag, write it back. Fine at personal-mailbox scale.
      const record = await promisifyRequest(store.get(id));
      if (record) {
        record.deleted = true;
        store.put(record);
      }
    }
  });
}

export async function getActiveIds() {
  const messages = await getAllMessages();
  return messages.filter((m) => !m.deleted).map((m) => m.id);
}

export async function getLastSyncedAt() {
  const record = await withStore(META_STORE, 'readonly', (store) => promisifyRequest(store.get('lastSyncedAt')));
  return record ? record.value : null;
}

export async function setLastSyncedAt(iso) {
  return withStore(META_STORE, 'readwrite', (store) => store.put({ key: 'lastSyncedAt', value: iso }));
}

// "Clear Data" wipes synced mail and the last-synced marker so the next
// sync starts from scratch, but deliberately leaves ignoredSenders alone
// -- ignoring a sender is a lasting preference, not sync progress, and
// should survive a reset (otherwise it'd reappear on the very next sync).
export async function clearAllData() {
  await withStore(MESSAGES_STORE, 'readwrite', (store) => store.clear());
  await withStore(META_STORE, 'readwrite', (store) => store.clear());
}

export async function ignoreSender(email) {
  return withStore(IGNORED_STORE, 'readwrite', (store) => store.put({ email }));
}

export async function unignoreSender(email) {
  return withStore(IGNORED_STORE, 'readwrite', (store) => store.delete(email));
}

export async function getIgnoredSenders() {
  const rows = await withStore(IGNORED_STORE, 'readonly', (store) => promisifyRequest(store.getAll()));
  return rows.map((row) => row.email);
}

// The Gmail API returns raw header text, including RFC 2047 encoded-words
// (e.g. "=?UTF-8?B?...?=") for non-ASCII sender names -- it does not decode them.
export function decodeMimeWords(input) {
  if (!input) return input;
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return decodeBytes(base64ToBytes(text), charset);
      }
      const cleaned = text.replace(/_/g, ' ');
      const bytes = [];
      for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === '=' && i + 2 < cleaned.length) {
          bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(cleaned.charCodeAt(i));
        }
      }
      return decodeBytes(new Uint8Array(bytes), charset);
    } catch {
      return text;
    }
  });
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeBytes(bytes, charset) {
  const normalized = charset.toLowerCase();
  const label = normalized.includes('utf-8') || normalized.includes('utf8') ? 'utf-8' : normalized;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function parseFromHeader(value) {
  if (!value) return { name: null, email: null };
  const decoded = decodeMimeWords(value);
  const angleMatch = decoded.match(/^(.*)<([^>]+)>\s*$/);
  if (angleMatch) {
    const name = angleMatch[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return { name: name || null, email: angleMatch[2].trim().toLowerCase() };
  }
  if (/^[^\s@]+@[^\s@]+$/.test(decoded.trim())) {
    return { name: null, email: decoded.trim().toLowerCase() };
  }
  // `|| null` here (empty-string case) is unobservable through the only
  // caller: getTopSenders() always skips entries with a null email, and
  // this branch always returns email: null, so whether `name` ends up ''
  // or null never affects anything a test could see without exporting
  // this function purely to satisfy coverage.
  /* v8 ignore next */
  return { name: decoded.trim() || null, email: null };
}

export async function getTopSenders() {
  const [messages, ignoredEmails] = await Promise.all([getAllMessages(), getIgnoredSenders()]);
  const ignoredSet = new Set(ignoredEmails);
  const bySender = new Map();
  for (const m of messages) {
    if (m.deleted) continue;
    const { name, email } = parseFromHeader(m.from);
    if (!email || ignoredSet.has(email)) continue;
    const entry =
      bySender.get(email) ||
      { email, name: null, messageCount: 0, totalSize: 0, ids: [], latestMessage: null, latestTimestamp: -Infinity };
    entry.messageCount += 1;
    entry.totalSize += m.sizeEstimate || 0;
    if (name) entry.name = name;
    entry.ids.push(m.id);

    const timestamp = m.date ? Date.parse(m.date) : NaN;
    if (!Number.isNaN(timestamp) && timestamp > entry.latestTimestamp) {
      entry.latestTimestamp = timestamp;
      entry.latestMessage = {
        subject: decodeMimeWords(m.subject) || '(no subject)',
        snippet: m.snippet || '',
        date: m.date,
      };
    } else if (!entry.latestMessage) {
      // No parseable date yet seen for this sender -- fall back to *some* preview.
      entry.latestMessage = { subject: decodeMimeWords(m.subject) || '(no subject)', snippet: m.snippet || '', date: null };
    }

    bySender.set(email, entry);
  }
  return [...bySender.values()].sort((a, b) => b.totalSize - a.totalSize);
}
