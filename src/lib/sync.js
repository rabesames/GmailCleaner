import {
  listInboxMessagePages,
  listSentMessagePages,
  getMessageMetadata,
  getMessageRecipients,
  withRetry,
  METADATA_FETCH_CONCURRENCY,
} from './gmailApi.js';
import {
  getActiveIds,
  markGone,
  upsertMessages,
  setLastSyncedAt,
  getScannedSentIds,
  recordSentMessageRecipients,
} from './store.js';

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
//
// A job runs two sequential phases: `phase: 'inbox'` (as above) then
// `phase: 'sent'` (an analogous producer/consumer pipeline over Sent mail,
// building the "addresses I've ever emailed" set used by Cleanup
// Suggestions). The two phases never run concurrently -- the Sent phase's
// worker pool isn't even started until the inbox phase's Promise.all has
// resolved -- which is what keeps this within Gmail's quota ceiling
// (doubling METADATA_FETCH_CONCURRENCY across both phases at once would
// double the effective messages.get rate). Unlike the inbox phase, Sent has
// no gone-id reconciliation: Sent mail only grows, and "did I ever email
// X" never becomes stale once true, so there's nothing to detect as removed.
let job = null;

// How long an idle worker sleeps before re-checking the queue. Simpler and
// leak-free compared to an explicit wake-up/notify list (which would need
// its own cleanup when a job is superseded mid-wait); short enough to be
// imperceptible next to real network latency.
const IDLE_POLL_MS = 150;

// `total`/`fetched`/`listedCount`/`listingDone` are reused across both
// phases (reading from the Sent-phase fields once job.phase === 'sent')
// rather than adding phase-prefixed fields -- this is what lets
// SyncControls.jsx's progress bar work unchanged for both phases; only its
// status text needs to branch on `phase`.
export function getSyncSnapshot() {
  if (!job) return { status: 'idle' };
  const shared = { status: job.status, phase: job.phase, error: job.error };
  if (job.phase === 'sent') {
    return {
      ...shared,
      total: job.sentTotalNew,
      fetched: job.sentFetchedCount,
      listedCount: job.sentListedCount,
      listingDone: job.sentListingDone,
    };
  }
  return {
    ...shared,
    total: job.totalNew,
    fetched: job.fetchedCount,
    listedCount: job.listedCount,
    listingDone: job.listingDone,
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
    phase: 'inbox',

    listingIterator: listInboxMessagePages(),
    listingDone: false,
    knownIds: null,
    currentIdSet: new Set(),
    queue: [],
    totalNew: 0,
    fetchedCount: 0,
    listedCount: 0,

    sentListingIterator: listSentMessagePages(),
    sentListingDone: false,
    scannedIds: null,
    sentQueue: [],
    sentTotalNew: 0,
    sentFetchedCount: 0,
    sentListedCount: 0,

    error: null,
  };
  job = myJob;

  try {
    const [activeIds, scannedSentIds] = await Promise.all([getActiveIds(), getScannedSentIds()]);
    myJob.knownIds = new Set(activeIds);
    myJob.scannedIds = new Set(scannedSentIds);
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

// Runs the inbox phase's listing producer and fetch-worker pool
// concurrently and waits for both to settle -- called by runJob() and, via
// resumeSync(), again after a pause, since pausing stops every loop below.
async function runInboxPipeline(myJob, onUpdate) {
  const listing = myJob.listingDone ? Promise.resolve() : listingLoop(myJob, onUpdate);
  const workers = Array.from({ length: METADATA_FETCH_CONCURRENCY }, () => fetchWorker(myJob, onUpdate));
  await Promise.all([listing, ...workers]);
}

// Same shape as runInboxPipeline, for the Sent-mail scan phase.
async function runSentPipeline(myJob, onUpdate) {
  const listing = myJob.sentListingDone ? Promise.resolve() : sentListingLoop(myJob, onUpdate);
  const workers = Array.from({ length: METADATA_FETCH_CONCURRENCY }, () => sentFetchWorker(myJob, onUpdate));
  await Promise.all([listing, ...workers]);
}

// Runs the inbox phase, then the Sent-scan phase, sequentially -- called by
// startSync() and again by resumeSync() after a pause, since pausing stops
// every loop in whichever phase was active. The `if (myJob.phase ===
// 'inbox')` block only runs once per job: pausing/resuming mid-inbox
// re-enters it (the pipeline itself resumes mid-queue/mid-page, same as
// before phases existed) and it falls through into the Sent phase once
// inbox genuinely finishes; pausing/resuming mid-Sent skips the block
// entirely (myJob.phase is already 'sent'), so the goneIds reconciliation
// below never re-runs a second time.
async function runJob(myJob, onUpdate) {
  if (myJob.phase === 'inbox') {
    await runInboxPipeline(myJob, onUpdate);

    // If we got here because of a pause, an error, or a supersession, the
    // relevant code already updated status/error -- only a job that's still
    // 'running' with nothing left to list or fetch counts as truly done
    // with this phase.
    if (job !== myJob || myJob.status !== 'running') return;

    const goneIds = [...myJob.knownIds].filter((id) => !myJob.currentIdSet.has(id));
    if (goneIds.length) await markGone(goneIds);
    if (job !== myJob || myJob.status !== 'running') return;

    myJob.phase = 'sent';
    onUpdate(getSyncSnapshot());
  }

  await runSentPipeline(myJob, onUpdate);
  if (job !== myJob || myJob.status !== 'running') return;

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

// Sent-phase producer: mirrors listingLoop, but with no gone-id
// reconciliation to feed -- Sent mail only grows, so there's nothing to
// detect as removed. `sentListedCount` is a running total, not a Set size
// like `listedCount`, since there's no "already listed on an earlier page"
// dedup concern within a single listing pass.
async function sentListingLoop(myJob, onUpdate) {
  while (job === myJob && myJob.status === 'running') {
    let result;
    try {
      result = await myJob.sentListingIterator.next();
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
      myJob.sentListingDone = true;
      onUpdate(getSyncSnapshot());
      return;
    }

    const pageIds = result.value;
    myJob.sentListedCount += pageIds.length;

    const newIds = pageIds.filter((id) => !myJob.scannedIds.has(id));
    if (newIds.length) {
      myJob.sentQueue.push(...newIds);
      myJob.sentTotalNew += newIds.length;
    }
    onUpdate(getSyncSnapshot());
  }
}

// Sent-phase consumer: mirrors fetchWorker, fetching To/Cc recipients
// instead of sender metadata and recording them via
// recordSentMessageRecipients instead of upsertMessages.
async function sentFetchWorker(myJob, onUpdate) {
  while (true) {
    if (job !== myJob || myJob.status !== 'running') return;

    if (myJob.sentQueue.length === 0) {
      if (myJob.sentListingDone) return;
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
      continue;
    }

    const id = myJob.sentQueue.shift();
    let record;
    try {
      record = await withRetry(() => getMessageRecipients(id));
    } catch (err) {
      if (job !== myJob) return;
      myJob.status = 'error';
      myJob.error = err.message;
      onUpdate(getSyncSnapshot());
      return;
    }

    if (job !== myJob) return;
    await recordSentMessageRecipients(record);
    if (job !== myJob) return;
    myJob.scannedIds.add(id); // keep the in-memory set current so a resumed pipeline doesn't re-queue it
    myJob.sentFetchedCount += 1;
    onUpdate(getSyncSnapshot());
  }
}
