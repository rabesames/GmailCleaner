import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./auth.js', () => ({
  getAccessToken: vi.fn().mockResolvedValue('test-token'),
  invalidateStoredToken: vi.fn(),
}));

import { getAccessToken, invalidateStoredToken } from './auth.js';
import {
  withRetry,
  listInboxMessagePages,
  listSentMessagePages,
  getMessageMetadata,
  getMessageRecipients,
  trashMessages,
  METADATA_FETCH_CONCURRENCY,
} from './gmailApi.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyOkResponse() {
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
}

function unparsableErrorResponse(status) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => {
      throw new Error('not json');
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAccessToken.mockResolvedValue('test-token');
  global.fetch = vi.fn();
});

describe('METADATA_FETCH_CONCURRENCY', () => {
  it('is a positive number', () => {
    expect(METADATA_FETCH_CONCURRENCY).toBeGreaterThan(0);
  });
});

describe('withRetry', () => {
  it('returns the result on first success without delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure and eventually succeeds', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
      const promise = withRetry(fn, 4);
      await vi.advanceTimersByTimeAsync(300);
      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off longer for rate-limited errors', async () => {
    vi.useFakeTimers();
    try {
      const rateLimited = new Error('rate limited');
      rateLimited.rateLimited = true;
      const fn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValueOnce('ok');
      const promise = withRetry(fn, 4);

      await vi.advanceTimersByTimeAsync(300);
      expect(fn).toHaveBeenCalledTimes(1); // 300ms isn't enough for the 1000ms rate-limit backoff

      await vi.advanceTimersByTimeAsync(700);
      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws the final error once attempts are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const err = new Error('always fails');
      const fn = vi.fn().mockRejectedValue(err);
      const promise = withRetry(fn, 2);
      const assertion = expect(promise).rejects.toThrow('always fails');
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('gmailFetch (via exported callers)', () => {
  it('sends a bearer token and parses a JSON body on success', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { id: 'abc', payload: { headers: [] } }));
    const result = await getMessageMetadata('abc');
    expect(result.id).toBe('abc');
    const [, options] = fetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-token');
  });

  it('treats an empty response body as a successful null result', async () => {
    fetch.mockResolvedValueOnce(emptyOkResponse());
    await expect(trashMessages(['a'])).resolves.toBeUndefined();
  });

  it('re-authenticates once on a 401 and retries the request', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(401, {})).mockResolvedValueOnce(jsonResponse(200, { id: 'x', payload: { headers: [] } }));
    const result = await getMessageMetadata('x');
    expect(result.id).toBe('x');
    expect(invalidateStoredToken).toHaveBeenCalledTimes(1);
    // Once for the initial attempt, once explicitly after invalidating (forces
    // the actual re-auth), once more at the top of the retried gmailFetch call
    // (returns the now-cached token instantly) -- three calls is correct.
    expect(getAccessToken).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a second time if still 401 after re-authenticating', async () => {
    fetch.mockResolvedValue(jsonResponse(401, { error: { message: 'still unauthorized' } }));
    await expect(getMessageMetadata('x')).rejects.toThrow('still unauthorized');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a rate-limited error on 429', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(429, {}));
    let caught;
    try {
      await getMessageMetadata('x');
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toBe('Gmail API rate limit exceeded');
    expect(caught.rateLimited).toBe(true);
  });

  it('throws the server error message for other non-ok statuses', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(500, { error: { message: 'server exploded' } }));
    await expect(getMessageMetadata('x')).rejects.toThrow('server exploded');
  });

  it('falls back to a generic message when the error body is not parseable JSON', async () => {
    fetch.mockResolvedValueOnce(unparsableErrorResponse(500));
    await expect(getMessageMetadata('x')).rejects.toThrow('Gmail API error (500)');
  });
});

describe('listInboxMessagePages', () => {
  it('yields a single page when there is no nextPageToken', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: '1' }, { id: '2' }] }));
    const pages = [];
    for await (const page of listInboxMessagePages()) pages.push(page);
    expect(pages).toEqual([['1', '2']]);
  });

  it('pages through multiple results using pageToken', async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: '1' }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: '2' }] }));

    const pages = [];
    for await (const page of listInboxMessagePages()) pages.push(page);
    expect(pages).toEqual([['1'], ['2']]);

    const secondCallUrl = fetch.mock.calls[1][0];
    expect(secondCallUrl).toContain('pageToken=p2');
  });

  it('yields an empty array for a page with no messages', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, {}));
    const pages = [];
    for await (const page of listInboxMessagePages()) pages.push(page);
    expect(pages).toEqual([[]]);
  });

  it('requests labelIds=INBOX', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { messages: [] }));
    await listInboxMessagePages().next();
    expect(fetch.mock.calls[0][0]).toContain('labelIds=INBOX');
  });
});

describe('listSentMessagePages', () => {
  it('yields a single page when there is no nextPageToken', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: '1' }, { id: '2' }] }));
    const pages = [];
    for await (const page of listSentMessagePages()) pages.push(page);
    expect(pages).toEqual([['1', '2']]);
  });

  it('pages through multiple results using pageToken', async () => {
    fetch
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: '1' }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: '2' }] }));

    const pages = [];
    for await (const page of listSentMessagePages()) pages.push(page);
    expect(pages).toEqual([['1'], ['2']]);

    const secondCallUrl = fetch.mock.calls[1][0];
    expect(secondCallUrl).toContain('pageToken=p2');
  });

  it('requests labelIds=SENT', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { messages: [] }));
    await listSentMessagePages().next();
    expect(fetch.mock.calls[0][0]).toContain('labelIds=SENT');
  });
});

describe('getMessageMetadata', () => {
  it('extracts headers case-insensitively and fills in defaults', async () => {
    fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'm1',
        sizeEstimate: 4321,
        snippet: 'hello there',
        payload: {
          headers: [
            { name: 'From', value: 'a@example.com' },
            { name: 'SUBJECT', value: 'Hi' },
            { name: 'date', value: 'Wed, 1 Jan 2026 00:00:00 +0000' },
          ],
        },
      })
    );
    const result = await getMessageMetadata('m1');
    expect(result).toEqual({
      id: 'm1',
      sizeEstimate: 4321,
      from: 'a@example.com',
      subject: 'Hi',
      date: 'Wed, 1 Jan 2026 00:00:00 +0000',
      snippet: 'hello there',
    });
  });

  it('defaults missing fields when payload/headers are absent', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { id: 'm2' }));
    const result = await getMessageMetadata('m2');
    expect(result).toEqual({ id: 'm2', sizeEstimate: 0, from: null, subject: null, date: null, snippet: '' });
  });

  it('defaults missing headers array when payload has no headers field', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { id: 'm3', payload: {} }));
    const result = await getMessageMetadata('m3');
    expect(result.from).toBeNull();
  });
});

describe('getMessageRecipients', () => {
  it('extracts To/Cc headers case-insensitively', async () => {
    fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 's1',
        payload: {
          headers: [
            { name: 'TO', value: 'a@example.com' },
            { name: 'Cc', value: 'b@example.com' },
          ],
        },
      })
    );
    const result = await getMessageRecipients('s1');
    expect(result).toEqual({ id: 's1', to: 'a@example.com', cc: 'b@example.com' });
  });

  it('defaults missing To/Cc to null', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { id: 's2' }));
    const result = await getMessageRecipients('s2');
    expect(result).toEqual({ id: 's2', to: null, cc: null });
  });

  it('requests only the To and Cc headers', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { id: 's3' }));
    await getMessageRecipients('s3');
    const url = fetch.mock.calls[0][0];
    expect(url).toContain('metadataHeaders=To');
    expect(url).toContain('metadataHeaders=Cc');
    expect(url).not.toContain('metadataHeaders=From');
  });
});

describe('trashMessages', () => {
  it('sends a single batchModify request for <= 1000 ids', async () => {
    fetch.mockResolvedValue(emptyOkResponse());
    await trashMessages(['a', 'b', 'c']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toContain('/messages/batchModify');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ ids: ['a', 'b', 'c'], addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] });
  });

  it('chunks requests at 1000 ids per call', async () => {
    fetch.mockResolvedValue(emptyOkResponse());
    const ids = Array.from({ length: 1500 }, (_, i) => `id${i}`);
    await trashMessages(ids);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1].body).ids).toHaveLength(1000);
    expect(JSON.parse(fetch.mock.calls[1][1].body).ids).toHaveLength(500);
  });
});
