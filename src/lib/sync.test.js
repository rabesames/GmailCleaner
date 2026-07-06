import { describe, it, expect, beforeEach, vi } from 'vitest';

// Concurrency pinned to 1 for most tests so worker interleaving is
// deterministic; a dedicated test below overrides it to verify multiple
// workers really do get spawned and dispatch concurrently.
let concurrency = 1;

vi.mock('./gmailApi.js', () => ({
  listInboxMessagePages: vi.fn(),
  getMessageMetadata: vi.fn(),
  withRetry: vi.fn((fn) => fn()),
  get METADATA_FETCH_CONCURRENCY() {
    return concurrency;
  },
}));

vi.mock('./store.js', () => ({
  getActiveIds: vi.fn().mockResolvedValue([]),
  markGone: vi.fn().mockResolvedValue(undefined),
  upsertMessages: vi.fn().mockResolvedValue(undefined),
  setLastSyncedAt: vi.fn().mockResolvedValue(undefined),
}));

import { listInboxMessagePages, getMessageMetadata } from './gmailApi.js';
import { getActiveIds, markGone, upsertMessages, setLastSyncedAt } from './store.js';
import { startSync, pauseSync, resumeSync, resetSync, getSyncSnapshot } from './sync.js';

// A hand-driven async generator standing in for listInboxMessagePages():
// the test decides exactly when each page (or the end of listing) becomes
// available, instead of a fixed canned sequence resolving instantly.
function createManualPager() {
  let release;
  let waiting = new Promise((resolve) => (release = resolve));
  async function* generator() {
    while (true) {
      const step = await waiting;
      waiting = new Promise((resolve) => (release = resolve));
      if (step.done) return;
      yield step.value;
    }
  }
  return {
    generator: generator(),
    pushPage(ids) {
      release({ value: ids, done: false });
    },
    finish() {
      release({ done: true });
    },
  };
}

// A hand-driven getMessageMetadata(): resolves only when the test calls the
// resolver it hands back, so fetch completion can be sequenced precisely.
function createManualFetcher() {
  const pending = new Map();
  const fn = vi.fn(
    (id) =>
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      })
  );
  return {
    fn,
    resolve(id, record) {
      pending.get(id).resolve(record);
      pending.delete(id);
    },
    reject(id, err) {
      pending.get(id).reject(err);
      pending.delete(id);
    },
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  concurrency = 1;
  getActiveIds.mockResolvedValue([]);
  markGone.mockResolvedValue(undefined);
  upsertMessages.mockResolvedValue(undefined);
  setLastSyncedAt.mockResolvedValue(undefined);
  resetSync();
});

describe('getSyncSnapshot', () => {
  it('reports idle when no sync has ever run', () => {
    expect(getSyncSnapshot()).toEqual({ status: 'idle' });
  });
});

describe('startSync happy paths', () => {
  it('lists, fetches, and stores every new message, then marks itself done', async () => {
    listInboxMessagePages.mockImplementation(async function* () {
      yield ['a', 'b'];
    });
    getMessageMetadata.mockImplementation(async (id) => ({ id, from: `${id}@example.com` }));

    const onUpdate = vi.fn();
    await startSync(onUpdate);

    const snapshot = getSyncSnapshot();
    expect(snapshot).toMatchObject({ status: 'done', total: 2, fetched: 2, listedCount: 2, listingDone: true, error: null });
    expect(upsertMessages).toHaveBeenCalledWith([{ id: 'a', from: 'a@example.com' }]);
    expect(upsertMessages).toHaveBeenCalledWith([{ id: 'b', from: 'b@example.com' }]);
    expect(setLastSyncedAt).toHaveBeenCalledTimes(1);
    expect(markGone).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
  });

  it('only fetches ids not already known', async () => {
    getActiveIds.mockResolvedValue(['a']);
    listInboxMessagePages.mockImplementation(async function* () {
      yield ['a', 'b'];
    });
    getMessageMetadata.mockImplementation(async (id) => ({ id }));

    await startSync(vi.fn());

    expect(getMessageMetadata).toHaveBeenCalledTimes(1);
    expect(getMessageMetadata).toHaveBeenCalledWith('b');
    expect(getSyncSnapshot()).toMatchObject({ total: 1, fetched: 1 });
  });

  it('marks previously-known ids gone when they no longer appear in the listing', async () => {
    getActiveIds.mockResolvedValue(['a', 'b']);
    listInboxMessagePages.mockImplementation(async function* () {
      yield ['a']; // "b" has disappeared from INBOX
    });
    getMessageMetadata.mockResolvedValue({});

    await startSync(vi.fn());

    expect(markGone).toHaveBeenCalledWith(['b']);
  });

  it('spawns one worker per unit of concurrency and dispatches to all of them', async () => {
    vi.useFakeTimers();
    try {
      concurrency = 2;
      listInboxMessagePages.mockImplementation(async function* () {
        yield ['a', 'b'];
      });
      const fetcher = createManualFetcher();
      getMessageMetadata.mockImplementation(fetcher.fn);

      const donePromise = startSync(vi.fn());
      // Both workers see an empty queue before listing (a microtask chain)
      // has populated it, so they fall into the idle poll first; advancing
      // past IDLE_POLL_MS lets them wake back up and notice the new items.
      await vi.advanceTimersByTimeAsync(200);

      // Both ids should have been dispatched concurrently, not one-at-a-time.
      expect(getMessageMetadata).toHaveBeenCalledTimes(2);

      fetcher.resolve('a', { id: 'a' });
      fetcher.resolve('b', { id: 'b' });
      await donePromise;

      expect(getSyncSnapshot()).toMatchObject({ status: 'done', fetched: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startSync error handling', () => {
  it('goes to the error state when getActiveIds fails', async () => {
    getActiveIds.mockRejectedValue(new Error('db unavailable'));
    const onUpdate = vi.fn();

    await startSync(onUpdate);

    expect(getSyncSnapshot()).toMatchObject({ status: 'error', error: 'db unavailable' });
    // listInboxMessagePages() itself is still called to create the iterator
    // (cheap -- an async generator function call doesn't run its body until
    // .next() is invoked), but that body must never actually execute.
    expect(getMessageMetadata).not.toHaveBeenCalled();
  });

  it('goes to the error state when the listing iterator throws', async () => {
    listInboxMessagePages.mockImplementation(async function* () {
      throw new Error('listing failed');
    });

    await startSync(vi.fn());

    expect(getSyncSnapshot()).toMatchObject({ status: 'error', error: 'listing failed' });
    expect(getMessageMetadata).not.toHaveBeenCalled();
  });

  it('goes to the error state when a metadata fetch fails', async () => {
    listInboxMessagePages.mockImplementation(async function* () {
      yield ['a'];
    });
    getMessageMetadata.mockRejectedValue(new Error('fetch failed'));

    await startSync(vi.fn());

    expect(getSyncSnapshot()).toMatchObject({ status: 'error', error: 'fetch failed' });
  });
});

describe('pause / resume', () => {
  it('pauseSync is a no-op when nothing is running', () => {
    pauseSync();
    expect(getSyncSnapshot()).toEqual({ status: 'idle' });
  });

  it('resumeSync is a no-op when nothing is paused', () => {
    resumeSync(vi.fn());
    expect(getSyncSnapshot()).toEqual({ status: 'idle' });
  });

  it('freezes progress on pause (in-flight work finishes, new work does not start) and resumes correctly', async () => {
    vi.useFakeTimers();
    try {
      const pager = createManualPager();
      listInboxMessagePages.mockImplementation(() => pager.generator);
      const fetcher = createManualFetcher();
      getMessageMetadata.mockImplementation(fetcher.fn);

      const onUpdate = vi.fn();
      startSync(onUpdate); // fire-and-forget, matching how App.jsx calls it
      await vi.advanceTimersByTimeAsync(0);

      // Finish listing up front so this test isolates worker-side pause/
      // resume specifically -- a pause while the listing generator itself
      // still has an outstanding .next() call is a separate, narrower
      // scenario covered by the next test.
      pager.pushPage(['a', 'b']);
      // Give the generator a tick to advance past the page and register a
      // new pending .next() before finish() targets it -- calling finish()
      // synchronously right after pushPage() would resolve the *same*
      // already-settled promise a second time (a no-op) instead of the next one.
      await vi.advanceTimersByTimeAsync(0);
      pager.finish();
      // The single worker (concurrency=1) was idle-polling before the page
      // arrived; advancing past IDLE_POLL_MS wakes it to dispatch to 'a'.
      // 'b' stays queued -- only one fetch runs at a time.
      await vi.advanceTimersByTimeAsync(200);
      expect(getMessageMetadata).toHaveBeenCalledWith('a');
      expect(getMessageMetadata).not.toHaveBeenCalledWith('b');

      // Pause while 'a' is in flight and 'b' is still sitting in the queue.
      pauseSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(getSyncSnapshot().status).toBe('paused');

      // The in-flight fetch for 'a' is allowed to finish even though paused...
      fetcher.resolve('a', { id: 'a' });
      await vi.advanceTimersByTimeAsync(0);
      expect(getSyncSnapshot()).toMatchObject({ status: 'paused', fetched: 1 });
      // ...but the worker must not start 'b' until resumed.
      expect(getMessageMetadata).not.toHaveBeenCalledWith('b');

      // resumeSync() doesn't return anything awaitable -- it launches its
      // own runJob() internally, same as production usage -- so completion
      // has to be observed by advancing time and polling the snapshot
      // rather than awaiting `donePromise` again (that promise belongs to
      // the *original* startSync() call, which already resolved the moment
      // its own paused runJob settled, independent of the resumed work).
      resumeSync(onUpdate);
      await vi.advanceTimersByTimeAsync(200);
      fetcher.resolve('b', { id: 'b' });
      await vi.advanceTimersByTimeAsync(0);

      expect(getSyncSnapshot()).toMatchObject({ status: 'done', fetched: 2, total: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes the listing side too when paused before listing finished', async () => {
    vi.useFakeTimers();
    try {
      let releaseSecondPage;
      listInboxMessagePages.mockImplementation(async function* () {
        yield ['a'];
        await new Promise((resolve) => {
          releaseSecondPage = resolve;
        });
        yield ['b'];
      });
      getMessageMetadata.mockResolvedValue({});

      const onUpdate = vi.fn();
      startSync(onUpdate); // fire-and-forget, matching how App.jsx calls it
      // Let page 'a' list and fetch fully, then the generator blocks
      // internally (not the caller's .next() call) until released below.
      await vi.advanceTimersByTimeAsync(200);
      expect(getSyncSnapshot()).toMatchObject({ fetched: 1, listingDone: false });

      pauseSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(getSyncSnapshot().status).toBe('paused');

      // resumeSync() launches its own internal runJob() rather than
      // returning anything awaitable (matching production usage), so
      // completion is observed by advancing time and polling the snapshot.
      resumeSync(onUpdate);
      releaseSecondPage();
      await vi.advanceTimersByTimeAsync(200);

      expect(getSyncSnapshot()).toMatchObject({ status: 'done', listingDone: true, fetched: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resetSync', () => {
  it('returns to idle immediately', async () => {
    listInboxMessagePages.mockImplementation(async function* () {
      yield ['a'];
    });
    getMessageMetadata.mockResolvedValue({});
    await startSync(vi.fn());

    resetSync();
    expect(getSyncSnapshot()).toEqual({ status: 'idle' });
  });

  it('discards a stale in-flight fetch instead of writing it to the store', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = createManualFetcher();
      listInboxMessagePages.mockImplementation(async function* () {
        yield ['a'];
      });
      getMessageMetadata.mockImplementation(fetcher.fn);

      startSync(vi.fn());
      // Worker idle-polls once before listing (a microtask chain) populates
      // the queue; advancing past IDLE_POLL_MS lets it wake and dispatch.
      await vi.advanceTimersByTimeAsync(200);
      expect(getMessageMetadata).toHaveBeenCalledWith('a');

      resetSync();
      fetcher.resolve('a', { id: 'a' });
      await vi.advanceTimersByTimeAsync(0);

      expect(upsertMessages).not.toHaveBeenCalled();
      expect(getSyncSnapshot()).toEqual({ status: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a fresh startSync supersede a job left running by a stale one', async () => {
    const firstPager = createManualPager();
    listInboxMessagePages.mockImplementationOnce(() => firstPager.generator);
    getMessageMetadata.mockResolvedValue({});

    const firstRun = startSync(vi.fn());
    await flushMicrotasks();

    listInboxMessagePages.mockImplementation(async function* () {
      yield ['x'];
    });
    const secondRun = startSync(vi.fn());
    await secondRun;

    expect(getSyncSnapshot()).toMatchObject({ status: 'done', total: 1 });

    // Let the first job's abandoned listing settle so it doesn't dangle.
    firstPager.finish();
    await firstRun;
    expect(getSyncSnapshot()).toMatchObject({ status: 'done', total: 1 }); // unchanged by the stale job
  });
});

// Each of these targets one specific "job !== myJob" recheck that runs
// immediately after an await -- the guard only matters if a supersession
// can land *during* that exact await, so each test engineers precisely that.
describe('supersession mid-await guards', () => {
  it('does not mark the job errored if superseded while getActiveIds was about to reject', async () => {
    let rejectGetActiveIds;
    getActiveIds.mockImplementation(() => new Promise((_, reject) => (rejectGetActiveIds = reject)));

    startSync(vi.fn());
    await flushMicrotasks();

    resetSync();
    rejectGetActiveIds(new Error('db exploded'));
    await flushMicrotasks();

    expect(getSyncSnapshot()).toEqual({ status: 'idle' });
  });

  it('does not start runJob if superseded right after getActiveIds resolved', async () => {
    let resolveGetActiveIds;
    getActiveIds.mockImplementation(() => new Promise((resolve) => (resolveGetActiveIds = resolve)));

    startSync(vi.fn());
    await flushMicrotasks();

    // Resolve and supersede back-to-back, synchronously: the awaited
    // continuation in startSync() is already queued as a microtask by the
    // time resetSync() runs, so it observes job !== myJob and bails before
    // ever calling runJob() for this (now-stale) job. (listInboxMessagePages()
    // itself was already called earlier just to construct the iterator --
    // cheap and harmless -- so the real proxy for "runJob never ran" is that
    // nothing ever calls .next() on it, i.e. no metadata fetch happens.)
    resolveGetActiveIds([]);
    resetSync();
    await flushMicrotasks();

    expect(getMessageMetadata).not.toHaveBeenCalled();
    expect(getSyncSnapshot()).toEqual({ status: 'idle' });
  });

  it('does not finalize as done if superseded while markGone is in flight', async () => {
    vi.useFakeTimers();
    try {
      getActiveIds.mockResolvedValue(['gone-one']); // known, but will not reappear in the listing
      listInboxMessagePages.mockImplementation(async function* () {
        yield []; // empty page -- "gone-one" never shows up, so it's reconciled as gone
      });
      let resolveMarkGone;
      markGone.mockImplementation(() => new Promise((resolve) => (resolveMarkGone = resolve)));

      startSync(vi.fn());
      // The single worker finds an empty queue and idle-polls until it
      // notices listingDone; advancing past IDLE_POLL_MS lets runJob's
      // Promise.all settle and reach the markGone call.
      await vi.advanceTimersByTimeAsync(200);
      expect(markGone).toHaveBeenCalledWith(['gone-one']);

      resetSync();
      resolveMarkGone();
      await vi.advanceTimersByTimeAsync(0);

      expect(setLastSyncedAt).not.toHaveBeenCalled();
      expect(getSyncSnapshot()).toEqual({ status: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mark the job errored if superseded while the listing iterator was about to reject', async () => {
    let rejectNext;
    listInboxMessagePages.mockImplementation(async function* () {
      await new Promise((_, reject) => {
        rejectNext = reject;
      });
    });

    startSync(vi.fn());
    await flushMicrotasks();

    resetSync();
    rejectNext(new Error('listing exploded'));
    await flushMicrotasks();

    expect(getSyncSnapshot()).toEqual({ status: 'idle' });
  });

  it('does not mark the job errored if superseded while a metadata fetch was about to reject', async () => {
    vi.useFakeTimers();
    try {
      listInboxMessagePages.mockImplementation(async function* () {
        yield ['a'];
      });
      const fetcher = createManualFetcher();
      getMessageMetadata.mockImplementation(fetcher.fn);

      startSync(vi.fn());
      await vi.advanceTimersByTimeAsync(200);
      expect(getMessageMetadata).toHaveBeenCalledWith('a');

      resetSync();
      fetcher.reject('a', new Error('fetch exploded'));
      await vi.advanceTimersByTimeAsync(0);

      expect(getSyncSnapshot()).toEqual({ status: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not increment fetchedCount if superseded while upsertMessages was in flight', async () => {
    vi.useFakeTimers();
    try {
      listInboxMessagePages.mockImplementation(async function* () {
        yield ['a'];
      });
      getMessageMetadata.mockResolvedValue({ id: 'a' });
      let resolveUpsert;
      upsertMessages.mockImplementation(() => new Promise((resolve) => (resolveUpsert = resolve)));

      startSync(vi.fn());
      await vi.advanceTimersByTimeAsync(200);
      expect(upsertMessages).toHaveBeenCalledWith([{ id: 'a' }]);

      resetSync();
      resolveUpsert();
      await vi.advanceTimersByTimeAsync(0);

      expect(getSyncSnapshot()).toEqual({ status: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });
});
