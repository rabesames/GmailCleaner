import { useState, useMemo, useEffect } from 'react';
import SendersTable from './SendersTable.jsx';

const TABS = [
  { key: 'all', label: 'All Senders' },
  { key: 'cleanup', label: 'Cleanup Suggestions' },
];
const TAB_STORAGE_KEY = 'gmailCleaner.sendersActiveTab';

function loadStoredTab() {
  const stored = localStorage.getItem(TAB_STORAGE_KEY);
  return TABS.some((tab) => tab.key === stored) ? stored : 'all';
}

// Selection and the "Move to Trash" toolbar live here, above both tabs,
// rather than inside SendersTable.jsx -- a single Set shared across both
// tab instances (keyed by email) means a sender checked while viewing one
// tab stays checked (and counted in the toolbar) if they also appear in the
// other, which is what makes one shared toolbar above two tabs coherent
// instead of surprising. getCleanupSuggestions() is always a subset of
// getTopSenders() (see store.js), so resolving selected emails against
// `senders` alone is sufficient regardless of which tab a selection was
// made in.
export default function SendersSection({
  senders,
  cleanupSuggestions,
  cleanupThresholdYears,
  onThresholdYearsChange,
  onTrash,
  onIgnore,
  onTrashSelected,
}) {
  const [activeTab, setActiveTab] = useState(loadStoredTab);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // A sender that drops out of both lists (trashed, ignored) should also
  // drop out of the selection -- otherwise a stale email could linger in
  // `selected` indefinitely with nothing in either list to ever deselect it.
  useEffect(() => {
    setSelected((prev) => {
      const emails = new Set([...senders.map((s) => s.email), ...cleanupSuggestions.map((s) => s.email)]);
      const next = new Set([...prev].filter((email) => emails.has(email)));
      return next.size === prev.size ? prev : next;
    });
  }, [senders, cleanupSuggestions]);

  const selectedSenders = useMemo(() => senders.filter((sender) => selected.has(sender.email)), [senders, selected]);

  const handleTabChange = (key) => {
    setActiveTab(key);
    localStorage.setItem(TAB_STORAGE_KEY, key);
  };

  const toggleSelected = (email) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  const toggleSelectAll = (visibleSenders) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = visibleSenders.length > 0 && visibleSenders.every((sender) => next.has(sender.email));
      visibleSenders.forEach((sender) => (allSelected ? next.delete(sender.email) : next.add(sender.email)));
      return next;
    });
  };

  const handleTrashSelected = async () => {
    const totalMessages = selectedSenders.reduce((sum, sender) => sum + sender.messageCount, 0);
    const label = selectedSenders.length === 1 ? '1 sender' : `${selectedSenders.length} senders`;
    if (!confirm(`Move all ${totalMessages} email(s) from ${label} to Trash?`)) return;
    setBulkBusy(true);
    try {
      await onTrashSelected(selectedSenders);
      // On success every trashed sender drops out of `senders`, which the
      // effect above already prunes from `selected` -- nothing more to do.
    } catch (err) {
      alert(err.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleThresholdInputChange = (event) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value) && value >= 0) onThresholdYearsChange(value);
  };

  return (
    <>
      <div className="table-toolbar">
        <button
          className="danger"
          aria-label="Move selected senders to Trash"
          disabled={selectedSenders.length === 0 || bulkBusy}
          onClick={handleTrashSelected}
        >
          {bulkBusy ? 'Working...' : `Move to Trash${selectedSenders.length ? ` (${selectedSenders.length})` : ''}`}
        </button>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            className={activeTab === tab.key ? 'tab active' : 'tab'}
            onClick={() => handleTabChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === 'all' && (
        <SendersTable
          senders={senders}
          onTrash={onTrash}
          onIgnore={onIgnore}
          selected={selected}
          onToggleSelect={toggleSelected}
          onToggleSelectAll={toggleSelectAll}
          storageKeyPrefix="gmailCleaner.senders"
          noDataMessage='Sign in and click "Sync Now" to fetch your inbox.'
        />
      )}
      {activeTab === 'cleanup' && (
        <>
          <div className="cleanup-controls">
            <label>
              Suggest cleanup for senders inactive at least{' '}
              <input
                type="number"
                min="0"
                step="0.5"
                value={cleanupThresholdYears}
                onChange={handleThresholdInputChange}
                aria-label="Inactive threshold in years"
              />{' '}
              year(s), that you've never emailed or replied to -- or that you've moved to Trash here before.
            </label>
          </div>
          <SendersTable
            senders={cleanupSuggestions}
            onTrash={onTrash}
            onIgnore={onIgnore}
            selected={selected}
            onToggleSelect={toggleSelected}
            onToggleSelectAll={toggleSelectAll}
            storageKeyPrefix="gmailCleaner.cleanupSuggestions"
            noDataMessage="No cleanup suggestions right now."
            showReasonColumn
          />
        </>
      )}
    </>
  );
}
