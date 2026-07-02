import { getAccessToken, invalidateStoredToken } from './auth.js';

// Thin wrapper over the Gmail REST API. Quota is charged per user per
// minute (6,000 units/min as of writing): messages.list costs 5,
// messages.get costs 20, messages.batchModify costs 50 regardless of how
// many ids are in the batch. That caps messages.get at ~300/minute (~5/sec)
// per user, which is why metadata fetches below run at modest concurrency
// with retry-on-429 rather than as fast as the browser allows.
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const METADATA_FETCH_CONCURRENCY = 5;
const BATCH_MODIFY_CHUNK_SIZE = 1000;

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
    throw new Error((body.error && body.error.message) || `Gmail API error (${res.status})`);
  }

  // messages.batchModify (and other write endpoints) return an empty body
  // on success -- res.json() on empty text throws "Unexpected end of JSON
  // input" even though the request succeeded, so parse manually instead.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function withRetry(fn, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === attempts) throw err;
      const backoffMs = (err.rateLimited ? 1000 : 300) * attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

// Yields one page (up to 500) of INBOX message ids at a time, rather than
// paging through the whole mailbox before returning anything, so callers
// (sync.js) can interleave metadata-fetching with listing instead of
// waiting for the full inbox listing to finish first.
export async function* listInboxMessagePages() {
  let pageToken;
  do {
    const params = new URLSearchParams({ labelIds: 'INBOX', maxResults: '500' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await withRetry(() => gmailFetch(`/messages?${params}`));
    pageToken = data.nextPageToken;
    yield (data.messages || []).map((m) => m.id);
  } while (pageToken);
}

export async function getMessageMetadata(id) {
  const params = new URLSearchParams({ format: 'metadata' });
  params.append('metadataHeaders', 'From');
  params.append('metadataHeaders', 'Subject');
  params.append('metadataHeaders', 'Date');
  const data = await gmailFetch(`/messages/${id}?${params}`);
  const headers = {};
  for (const h of (data.payload && data.payload.headers) || []) {
    headers[h.name.toLowerCase()] = h.value;
  }
  return {
    id: data.id,
    sizeEstimate: data.sizeEstimate || 0,
    from: headers.from || null,
    subject: headers.subject || null,
    date: headers.date || null,
    snippet: data.snippet || '',
  };
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
