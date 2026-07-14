import { useState, useCallback, useEffect, useRef } from 'react';
import { setCurrentClientId, getStoredClientId, isSignedIn, signOut, getAccessToken } from './lib/auth.js';
import {
  getTopSenders,
  getCleanupSuggestions,
  getLastSyncedAt,
  getIgnoredSenders,
  ignoreSender,
  unignoreSender,
  markGone,
  recordTrashedSenders,
  clearAllData,
} from './lib/store.js';
import { startSync, pauseSync, resumeSync, resetSync, getSyncSnapshot } from './lib/sync.js';
import { trashMessages } from './lib/gmailApi.js';
import AuthControls from './components/AuthControls.jsx';
import SyncControls from './components/SyncControls.jsx';
import SendersSection from './components/SendersSection.jsx';
import IgnoredSendersList from './components/IgnoredSendersList.jsx';

const THRESHOLD_YEARS_STORAGE_KEY = 'gmailCleaner.cleanupThresholdYears';
const DEFAULT_THRESHOLD_YEARS = 2;

function getStoredThresholdYears() {
  const raw = localStorage.getItem(THRESHOLD_YEARS_STORAGE_KEY);
  if (raw === null) return DEFAULT_THRESHOLD_YEARS;
  const stored = Number(raw);
  return Number.isFinite(stored) && stored >= 0 ? stored : DEFAULT_THRESHOLD_YEARS;
}

export default function App() {
  const [clientId, setClientId] = useState(() => getStoredClientId());
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [syncSnapshot, setSyncSnapshot] = useState(getSyncSnapshot());
  const [senders, setSenders] = useState([]);
  const [cleanupSuggestions, setCleanupSuggestions] = useState([]);
  const [cleanupThresholdYears, setCleanupThresholdYears] = useState(getStoredThresholdYears);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [ignoredSenders, setIgnoredSenders] = useState([]);

  // IndexedDB reads are async, so rapid-fire calls (e.g. one per synced
  // message) could resolve out of order. This token makes a stale call
  // discard its result instead of momentarily showing older data.
  const refreshTokenRef = useRef(0);

  // Lets refreshSenders() (a useCallback with an empty dep array, so it
  // stays referentially stable for sync.js's handleSyncUpdate) always read
  // the current threshold without needing to be reconstructed every time
  // the threshold changes.
  const cleanupThresholdYearsRef = useRef(cleanupThresholdYears);
  useEffect(() => {
    cleanupThresholdYearsRef.current = cleanupThresholdYears;
  }, [cleanupThresholdYears]);

  const refreshSenders = useCallback(async () => {
    const token = ++refreshTokenRef.current;
    const [topSenders, suggestions, lastSynced] = await Promise.all([
      getTopSenders(),
      getCleanupSuggestions(cleanupThresholdYearsRef.current),
      getLastSyncedAt(),
    ]);
    if (token !== refreshTokenRef.current) return;
    setSenders(topSenders);
    setCleanupSuggestions(suggestions);
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
    // Written before refreshSenders() so the "this sender was manually
    // trashed" fact (the thing Cleanup Suggestions needs to keep surfacing
    // them if they email again) is durable even if the refresh fails.
    await recordTrashedSenders([sender.email]);
    await refreshSenders();
  };

  const handleTrashSelected = async (selectedSenders) => {
    const ids = selectedSenders.flatMap((sender) => sender.ids);
    await trashMessages(ids);
    await markGone(ids);
    await recordTrashedSenders(selectedSenders.map((sender) => sender.email));
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

  // Deliberately bypasses cleanupThresholdYearsRef -- goes straight to
  // getCleanupSuggestions with the new value so this doesn't race the ref's
  // own sync effect (which wouldn't have flushed yet on this same tick).
  const handleThresholdYearsChange = useCallback(async (value) => {
    setCleanupThresholdYears(value);
    localStorage.setItem(THRESHOLD_YEARS_STORAGE_KEY, String(value));
    const token = ++refreshTokenRef.current;
    const suggestions = await getCleanupSuggestions(value);
    if (token !== refreshTokenRef.current) return;
    setCleanupSuggestions(suggestions);
  }, []);

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
          OAuth Client ID is remembered in this browser so you don't have to re-enter it every visit. Your access
          token lives in this tab's session storage and clears when you close the tab. Synced message data is kept
          in this browser's IndexedDB and persists across sessions, so you won't need to re-sync your whole inbox
          every time.
        </p>
      </header>
      <main>
        <SendersSection
          senders={senders}
          cleanupSuggestions={cleanupSuggestions}
          cleanupThresholdYears={cleanupThresholdYears}
          onThresholdYearsChange={handleThresholdYearsChange}
          onTrash={handleTrash}
          onIgnore={handleIgnore}
          onTrashSelected={handleTrashSelected}
        />
        <IgnoredSendersList emails={ignoredSenders} onUnignore={handleUnignore} />
      </main>
    </>
  );
}
