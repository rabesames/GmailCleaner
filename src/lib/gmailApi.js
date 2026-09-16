import { getAccessToken, invalidateStoredToken } from './auth.js';

// Thin wrapper over the Gmail REST API. Quota is charged per user per
// minute (6,000 units/min as of writing): messages.list costs 5,
// messages.get costs 20, messages.batchModify costs 50 regardless of how
// many ids are in the batch. That caps messages.get at ~300/minute (~5/sec)
// per user, which is why metadata fetches below run at modest concurrency
// rather than as fast as the browser allows -- but concurrency alone only
// bounds how many requests are ever in flight at once, not units/minute,
// so hitting the per-user "Total Query Cost" quota during a large sync is
// still expected by design (see CLAUDE.md's Gmail API quota section),
// not a bug -- withRetry below is what's relied on to ride it out.
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const METADATA_FETCH_CONCURRENCY = 5;
const BATCH_MODIFY_CHUNK_SIZE = 1000;

function isQuotaExceededBody(body) {
  const error = body && body.error;
  if (!error) return false;
  if (error.status === 'RESOURCE_EXHAUSTED') return true;
  const reasons = (error.errors || []).map((e) => e.reason || '');
  if (reasons.some((reason) => /rateLimitExceeded|quotaExceeded/i.test(reason))) return true;
  return /quota exceeded/i.test(error.message || '');
}

async function gmailFetch(path, options = {}, _retriedAuth = false) {
  const token = await getAccessToken();
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 && !_retriedAuth) {
    invalidateStoredToken();
    await getAccessToken();
    return gmailFetch(path, options, true);
  }

  if (res.status === 429) {
    const err = new Error('Gmail API rate limit exceeded');
    err.rateLimited = true;
    throw err;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body.error && body.error.message) || `Gmail API error (${res.status})`;
    const err = new Error(message);
    // The per-user "Total Query Cost" quota this app is tuned against (see
    // CLAUDE.md's Gmail API quota section) isn't always reported as HTTP
    // 429 -- this Discovery-based API can also report it as a 403, an
    // older Google API convention that predates 429 being a standard
    // status code. Detect that case by response content, not just status,
    // so it gets the same retry-with-backoff treatment a real 429 gets
    // instead of failing the sync outright after a couple hundred
    // milliseconds of generic-error backoff.
    if (res.status === 403 && isQuotaExceededBody(body)) err.rateLimited = true;
    throw err;
  }

  // messages.batchModify (and other write endpoints) return an empty body
  // on success -- res.json() on empty text throws "Unexpected end of JSON
  // input" even though the request succeeded, so parse manually instead.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function withRetry(fn, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === attempts) throw err;
      // A per-*minute* quota (see the Gmail API quota section of
      // CLAUDE.md) needs real time to free back up -- growing the
      // rate-limited backoff toward roughly a minute across the retry
      // attempts gives it a realistic chance to recover, where the old
      // flat ~1s-per-attempt backoff (max ~6s total) never could. A
      // non-rate-limited error is likely a genuine failure rather than a
      // transient quota bump, so it keeps the short backoff.
      const backoffMs = err.rateLimited ? Math.min(2 ** attempt * 2000, 20000) : 300 * attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

// Yields one page (up to 500) of message ids at a time, rather than paging
// through the whole mailbox before returning anything, so callers (sync.js)
// can interleave metadata-fetching with listing instead of waiting for the
// full listing to finish first. Shared by both the INBOX and SENT scans
// below -- only the label differs.
async function* listMessagePages(labelId) {
  let pageToken;
  do {
    const params = new URLSearchParams({ labelIds: labelId, maxResults: '500' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await withRetry(() => gmailFetch(`/messages?${params}`));
    pageToken = data.nextPageToken;
    yield (data.messages || []).map((m) => m.id);
  } while (pageToken);
}

export function listInboxMessagePages() {
  return listMessagePages('INBOX');
}

export function listSentMessagePages() {
  return listMessagePages('SENT');
}

function extractHeaders(data) {
  const headers = {};
  for (const h of (data.payload && data.payload.headers) || []) {
    headers[h.name.toLowerCase()] = h.value;
  }
  return headers;
}

export async function getMessageMetadata(id) {
  const params = new URLSearchParams({ format: 'metadata' });
  params.append('metadataHeaders', 'From');
  params.append('metadataHeaders', 'Subject');
  params.append('metadataHeaders', 'Date');
  const data = await gmailFetch(`/messages/${id}?${params}`);
  const headers = extractHeaders(data);
  return {
    id: data.id,
    sizeEstimate: data.sizeEstimate || 0,
    from: headers.from || null,
    subject: headers.subject || null,
    date: headers.date || null,
    snippet: data.snippet || '',
  };
}

// Used by sync.js's Sent-mail scan phase to build the "addresses I've ever
// emailed" set (see store.js's recordSentMessageRecipients). Returns raw
// header text, not parsed addresses -- same division of responsibility as
// getMessageMetadata's `from`, where address parsing stays store.js's job.
// Same 20-unit quota cost as getMessageMetadata (same endpoint).
export async function getMessageRecipients(id) {
  const params = new URLSearchParams({ format: 'metadata' });
  params.append('metadataHeaders', 'To');
  params.append('metadataHeaders', 'Cc');
  const data = await gmailFetch(`/messages/${id}?${params}`);
  const headers = extractHeaders(data);
  return { id: data.id, to: headers.to || null, cc: headers.cc || null };
}

export async function trashMessages(ids) {
  for (let i = 0; i < ids.length; i += BATCH_MODIFY_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + BATCH_MODIFY_CHUNK_SIZE);
    await withRetry(() =>
      gmailFetch('/messages/batchModify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }),
      })
    );
  }
}
