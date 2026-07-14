import { useState, useCallback, useEffect, useRef } from 'react';
import { setCurrentClientId, isSignedIn, signOut, getAccessToken } from './lib/auth.js';
import { getTopSenders, getLastSyncedAt, getIgnoredSenders, ignoreSender, unignoreSender, markGone, clearAllData } from './lib/store.js';
import { startSync, pauseSync, resumeSync, resetSync, getSyncSnapshot } from './lib/sync.js';
import { trashMessages } from './lib/gmailApi.js';
import AuthControls from './components/AuthControls.jsx';
import SyncControls from './components/SyncControls.jsx';
import SendersTable from './components/SendersTable.jsx';
import IgnoredSendersList from './components/IgnoredSendersList.jsx';

export default function App() {
  const [clientId, setClientId] = useState('');
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [syncSnapshot, setSyncSnapshot] = useState(getSyncSnapshot());
  const [senders, setSenders] = useState([]);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [ignoredSenders, setIgnoredSenders] = useState([]);

  // IndexedDB reads are async, so rapid-fire calls (e.g. one per synced
  // message) could resolve out of order. This token makes a stale call
  // discard its result instead of momentarily showing older data.
  const refreshTokenRef = useRef(0);

  const refreshSenders = useCallback(async () => {
    const token = ++refreshTokenRef.current;
    const [topSenders, lastSynced] = await Promise.all([getTopSenders(), getLastSyncedAt()]);
    if (token !== refreshTokenRef.current) return;
    setSenders(topSenders);
    setLastSyncedAt(lastSynced);
  }, []);

  // The ignore list can't change mid-sync, so it's refreshed alongside
  // refreshSenders() only where it can actually change (ignore/unignore,
  // initial load) rather than on every sync progress tick.
  const refreshIgnored = useCallback(async () => {
    setIgnoredSenders(await getIgnoredSenders());
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshSenders(), refreshIgnored()]);
  }, [refreshSenders, refreshIgnored]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const handleClientIdChange = (value) => {
    setClientId(value);
    setCurrentClientId(value);
  };

  const handleSignIn = async () => {
    try {
      await getAccessToken();
      setSignedIn(true);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSignOut = () => {
    signOut();
    setSignedIn(false);
  };

  const handleSyncUpdate = useCallback(
    (snapshot) => {
      setSyncSnapshot(snapshot);
      refreshSenders();
    },
    [refreshSenders]
  );

  const handleSyncNow = () => startSync(handleSyncUpdate);
  const handleRestart = () => startSync(handleSyncUpdate);

  const handlePause = () => {
    pauseSync();
    handleSyncUpdate(getSyncSnapshot());
  };

  const handleResume = () => resumeSync(handleSyncUpdate);

  const handleClearData = async () => {
    if (
      !confirm('Clear all synced data and start over? This only affects data cached in this browser -- your actual Gmail is untouched.')
    ) {
      return;
    }
    // Safe to run any time, including mid-sync: resetSync() invalidates the
    // current job first (any in-flight fetch that resolves afterward finds
    // job !== myJob and discards its result instead of writing to a store
    // that's about to be wiped).
    resetSync();
    await clearAllData();
    handleSyncUpdate(getSyncSnapshot());
    await refreshSenders();
  };

  const handleTrash = async (sender) => {
    await trashMessages(sender.ids);
    await markGone(sender.ids);
    await refreshSenders();
  };

  const handleTrashSelected = async (selectedSenders) => {
    const ids = selectedSenders.flatMap((sender) => sender.ids);
    await trashMessages(ids);
    await markGone(ids);
    await refreshSenders();
  };

  const handleIgnore = async (sender) => {
    await ignoreSender(sender.email);
    await refreshAll();
  };

  const handleUnignore = async (email) => {
    await unignoreSender(email);
    await refreshAll();
  };

  return (
    <>
      <header>
        <h1>Gmail Cleaner</h1>
        <AuthControls
          clientId={clientId}
          onClientIdChange={handleClientIdChange}
          signedIn={signedIn}
          onSignIn={handleSignIn}
          onSignOut={handleSignOut}
        />
        <SyncControls
          snapshot={syncSnapshot}
          signedIn={signedIn}
          lastSyncedAt={lastSyncedAt}
          onSyncNow={handleSyncNow}
          onPause={handlePause}
          onResume={handleResume}
          onRestart={handleRestart}
          onClearData={handleClearData}
        />
        <p className="muted">
          Runs entirely in this browser — nothing is sent anywhere except directly to Google's Gmail API. Your
          OAuth Client ID lives only in the field above and is never stored. Your access token lives in this tab's
          session storage and clears when you close the tab. Synced message data is kept in this browser's
          IndexedDB and persists across sessions, so you won't need to re-sync your whole inbox every time.
        </p>
      </header>
      <main>
        <SendersTable senders={senders} onTrash={handleTrash} onIgnore={handleIgnore} onTrashSelected={handleTrashSelected} />
        <IgnoredSendersList emails={ignoredSenders} onUnignore={handleUnignore} />
      </main>
    </>
  );
}
