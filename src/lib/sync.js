import { listInboxMessagePages, getMessageMetadata, withRetry, METADATA_FETCH_CONCURRENCY } from './gmailApi.js';
import { getActiveIds, markGone, upsertMessages, setLastSyncedAt } from './store.js';

// Resumable sync job controller. Listing and metadata-fetching run
// concurrently as a producer/consumer pipeline, not in alternating turns:
// one loop keeps paging `listInboxMessagePages()` and pushing newly-seen
// ids onto a shared queue, while a fixed pool of workers drains that queue
// as fast as quota allows -- listing page 4 can be in flight while a
// worker is still fetching metadata for something found on page 1. Job
// identity (`job !== myJob`) is how a fresh startSync() call (Sync Now /
// Restart) invalidates every loop from a previous job without needing to
// cancel in-flight fetch() calls -- stale loops just notice the mismatch
// and stop instead of writing their result.
let job = null;

// How long an idle worker sleeps before re-checking the queue. Simpler and
// leak-free compared to an explicit wake-up/notify list (which would need
// its own cleanup when a job is superseded mid-wait); short enough to be
// imperceptible next to real network latency.
const IDLE_POLL_MS = 150;

export function getSyncSnapshot() {
  if (!job) return { status: 'idle' };
  return {
    status: job.status,
    total: job.totalNew,
    fetched: job.fetchedCount,
    listedCount: job.listedCount,
    listingDone: job.listingDone,
    error: job.error,
  };
}

export function pauseSync() {
  if (job && job.status === 'running') job.status = 'paused';
}

export function resumeSync(onUpdate) {
  if (!job || job.status !== 'paused') return;
  job.status = 'running';
  onUpdate(getSyncSnapshot());
  runJob(job, onUpdate);
}

// Invalidates any job in progress (same mechanism a fresh startSync() uses
// to supersede a previous one) without starting a new one -- backs the
// "Clear Data" button, which needs to stop any active sync before it's
// safe to wipe the store out from under it. Setting `job` to null alone is
// enough: every in-flight check compares against the old job reference,
// which can never equal null.
export function resetSync() {
  job = null;
}

// Starting fresh always supersedes any job in progress (this is what
// backs both the "Sync Now" and "Restart" buttons). Already-fetched
// messages from an aborted attempt stay in the store and are naturally
// skipped by the new/known-id diff below, so restarting mid-sync doesn't
// throw away completed work -- it just redoes the inbox listing step.
export async function startSync(onUpdate) {
  const myJob = {
    status: 'running',
    listingIterator: listInboxMessagePages(),
    listingDone: false,
    knownIds: null,
    currentIdSet: new Set(),
    queue: [],
    totalNew: 0,
    fetchedCount: 0,
    listedCount: 0,
    error: null,
  };
  job = myJob;

  try {
    myJob.knownIds = new Set(await getActiveIds());
  } catch (err) {
    if (job === myJob) {
      myJob.status = 'error';
      myJob.error = err.message;
      onUpdate(getSyncSnapshot());
    }
    return;
  }
  if (job !== myJob) return;

  onUpdate(getSyncSnapshot());
  await runJob(myJob, onUpdate);
}

// Runs the listing producer and the fetch-worker pool concurrently and
// waits for both to settle -- called by startSync() and again by
// resumeSync() after a pause, since pausing stops every loop below.
async function runJob(myJob, onUpdate) {
  const listing = myJob.listingDone ? Promise.resolve() : listingLoop(myJob, onUpdate);
  const workers = Array.from({ length: METADATA_FETCH_CONCURRENCY }, () => fetchWorker(myJob, onUpdate));
  await Promise.all([listing, ...workers]);

  // If we got here because of a pause, an error, or a supersession, the
  // relevant code already updated status/error -- only a job that's still
  // 'running' with nothing left to list or fetch counts as truly done.
  if (job !== myJob || myJob.status !== 'running') return;

  const goneIds = [...myJob.knownIds].filter((id) => !myJob.currentIdSet.has(id));
  if (goneIds.length) await markGone(goneIds);
  if (job !== myJob) return;

  myJob.status = 'done';
  await setLastSyncedAt(new Date().toISOString());
  onUpdate(getSyncSnapshot());
}

// Producer: keeps paging the inbox and enqueuing newly-seen ids until
// either the mailbox is fully listed or the job is paused/superseded.
async function listingLoop(myJob, onUpdate) {
  while (job === myJob && myJob.status === 'running') {
    let result;
    try {
      result = await myJob.listingIterator.next();
    } catch (err) {
      if (job === myJob) {
        myJob.status = 'error';
        myJob.error = err.message;
        onUpdate(getSyncSnapshot());
      }
      return;
    }
    if (job !== myJob) return;

    if (result.done) {
      myJob.listingDone = true;
      onUpdate(getSyncSnapshot());
      return;
    }

    const pageIds = result.value;
    for (const id of pageIds) myJob.currentIdSet.add(id);
    myJob.listedCount = myJob.currentIdSet.size;

    const newIds = pageIds.filter((id) => !myJob.knownIds.has(id));
    if (newIds.length) {
      myJob.queue.push(...newIds);
      myJob.totalNew += newIds.length;
    }
    onUpdate(getSyncSnapshot());
  }
}

// Consumer: one of a fixed pool draining the shared queue. Idles (polling)
// when the queue is momentarily empty but listing isn't finished yet,
// since more ids could still show up.
async function fetchWorker(myJob, onUpdate) {
  while (true) {
    if (job !== myJob || myJob.status !== 'running') return;

    if (myJob.queue.length === 0) {
      if (myJob.listingDone) return;
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
      continue;
    }

    const id = myJob.queue.shift();
    let record;
    try {
      record = await withRetry(() => getMessageMetadata(id));
    } catch (err) {
      if (job !== myJob) return;
      myJob.status = 'error';
      myJob.error = err.message;
      onUpdate(getSyncSnapshot());
      return;
    }

    if (job !== myJob) return;
    await upsertMessages([record]);
    if (job !== myJob) return;
    myJob.fetchedCount += 1;
    onUpdate(getSyncSnapshot());
  }
}
