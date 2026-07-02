function formatDate(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

function statusText(snapshot) {
  switch (snapshot.status) {
    case 'running': {
      // Listing and fetching run concurrently now, so there's one combined
      // line rather than a "listing" vs "fetching" phase distinction.
      const listingNote = snapshot.listingDone ? '' : ` (${snapshot.listedCount} listed so far, still listing inbox)`;
      return `Syncing... ${snapshot.fetched}/${snapshot.total} synced${listingNote}`;
    }
    case 'paused':
      return `Paused at ${snapshot.fetched}/${snapshot.total}`;
    case 'error':
      return `Sync error: ${snapshot.error}`;
    default:
      return '';
  }
}

// Fetched-vs-listed progress. While listing is still running, `total`
// (messages listed so far that need fetching) can keep growing -- the
// striped/animated fill is a visual cue that the denominator isn't final
// yet, distinct from the solid fill once listingDone makes it a real
// percentage. A plain div pair (not a native <progress>) because cross-
// browser striping/animation on native progress bars needs vendor-
// specific pseudo-elements that are fragile to keep in sync.
function SyncProgressBar({ snapshot }) {
  if (snapshot.total === 0) return null;
  const percent = Math.min(100, Math.round((snapshot.fetched / snapshot.total) * 100));
  return (
    <div
      className="progress-bar"
      role="progressbar"
      aria-valuenow={snapshot.fetched}
      aria-valuemin={0}
      aria-valuemax={snapshot.total}
      aria-label="Sync progress"
    >
      <div className={`progress-bar-fill${snapshot.listingDone ? '' : ' growing'}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

export default function SyncControls({ snapshot, signedIn, lastSyncedAt, onSyncNow, onPause, onResume, onRestart, onClearData }) {
  const active = snapshot.status === 'running' || snapshot.status === 'paused';

  return (
    <>
      <div className="toolbar">
        {!active && (
          <button disabled={!signedIn} onClick={onSyncNow}>
            Sync Now
          </button>
        )}
        {snapshot.status === 'running' && (
          <button className="secondary" onClick={onPause}>
            Pause
          </button>
        )}
        {snapshot.status === 'paused' && <button onClick={onResume}>Resume</button>}
        {active && (
          <button className="secondary" onClick={onRestart}>
            Restart
          </button>
        )}
        <button className="secondary" onClick={onClearData}>
          Clear Data
        </button>
        <span className="status">{statusText(snapshot)}</span>
        <span className="muted">Last synced: {formatDate(lastSyncedAt)}</span>
      </div>
      {active && <SyncProgressBar snapshot={snapshot} />}
    </>
  );
}
