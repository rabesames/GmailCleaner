import { useState, useMemo, useEffect, useRef } from 'react';
import Pagination from './Pagination.jsx';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const SORT_COLUMNS = ['name', 'messageCount', 'totalSize'];
const DEFAULT_SORT_STATE = { column: 'totalSize', direction: 'desc' };
const DEFAULT_FILTERS = { sender: '', messages: '', totalSize: '' };

function loadStoredSort(storageKeyPrefix) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${storageKeyPrefix}Sort`));
    const validColumn = parsed.column === null || SORT_COLUMNS.includes(parsed.column);
    const validDirection = parsed.direction === 'asc' || parsed.direction === 'desc';
    if (validColumn && (parsed.column === null || validDirection)) return parsed;
  } catch {
    // Malformed/missing storage -- fall through to the default below.
  }
  return DEFAULT_SORT_STATE;
}

function loadStoredFilters(storageKeyPrefix) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${storageKeyPrefix}Filters`));
    if (Object.keys(DEFAULT_FILTERS).every((key) => typeof parsed[key] === 'string')) return parsed;
  } catch {
    // Malformed/missing storage -- fall through to the default below.
  }
  return DEFAULT_FILTERS;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

// Unlike the identically-named helper in SyncControls.jsx, this one is only
// ever called from inside a truthy-date check (see the hover-preview title
// below), so it never needs to handle a missing date itself.
function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

function openGmailSearch(email) {
  const query = encodeURIComponent(`from:${email}`);
  window.open(`https://mail.google.com/mail/u/0/#search/${query}`, '_blank', 'noopener,noreferrer');
}

// --- Column filtering: Sender is a substring "contains" match; Messages ---
// and Total Size are ">= " thresholds. Invalid/empty input for a filter
// just means that filter isn't applied, rather than erroring or blocking.
function parseMessagesFilter(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const SIZE_UNIT_MULTIPLIERS = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };

function parseSizeFilter(raw) {
  const match = raw.trim().match(/^([\d.]+)\s*(b|kb|mb|gb)?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  const unit = (match[2] || 'b').toLowerCase();
  return value * SIZE_UNIT_MULTIPLIERS[unit];
}

// --- Sorting: 3-state (ascending / descending / unsorted) per column. ---
// "Unsorted" always shows the same order as the initial load (total size,
// descending), since that's the underlying natural order getTopSenders()
// already returns.
function cycleSortState(prev, column) {
  // Reaching "unsorted" always clears `column` to null (below), so whenever
  // prev.column matches the clicked column, prev.direction can only ever be
  // 'asc' or 'desc' -- there's no third case to handle here.
  if (prev.column !== column) return { column, direction: 'asc' };
  if (prev.direction === 'asc') return { column, direction: 'desc' };
  return { column: null, direction: null };
}

function sortIndicator(sortState, column) {
  if (sortState.column !== column) return '';
  return sortState.direction === 'asc' ? ' ▲' : ' ▼';
}

// Explains *why* a Cleanup Suggestions row is suggested (see store.js's
// getCleanupSuggestions, which attaches `reasons` to each sender). A sender
// can carry both reasons at once (e.g. trashed before, and currently
// stale/uncontacted again) -- SenderRow renders one icon per reason present,
// each with its own native-tooltip explanation (title attribute), same
// pattern as the hover-preview elsewhere in this file.
const REASON_META = {
  trashedBefore: { icon: '🗑️', label: "You've moved mail from this sender to Trash here before." },
  staleNoContact: {
    icon: '🕸️',
    label: "You've never emailed or replied to this sender, and their most recent message is older than the threshold.",
  },
};

// Selection lives above this component (see SendersSection.jsx) since two
// instances of this table (All Senders / Cleanup Suggestions) share one
// selection Set and one "Move to Trash" toolbar. Sort/filter/pagination stay
// local here -- each tab's sort/filter is independently remembered via
// `storageKeyPrefix` (so the two instances don't clobber each other's
// localStorage keys), and pagination is never persisted at all.
export default function SendersTable({
  senders,
  onTrash,
  onIgnore,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  storageKeyPrefix,
  noDataMessage,
  showReasonColumn,
}) {
  const [sortState, setSortState] = useState(() => loadStoredSort(storageKeyPrefix));
  const [filters, setFilters] = useState(() => loadStoredFilters(storageKeyPrefix));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    localStorage.setItem(`${storageKeyPrefix}Sort`, JSON.stringify(sortState));
  }, [storageKeyPrefix, sortState]);

  useEffect(() => {
    localStorage.setItem(`${storageKeyPrefix}Filters`, JSON.stringify(filters));
  }, [storageKeyPrefix, filters]);

  const filteredSenders = useMemo(() => {
    const senderQuery = filters.sender.trim().toLowerCase();
    const messagesMin = parseMessagesFilter(filters.messages);
    const totalSizeMin = parseSizeFilter(filters.totalSize);

    return senders.filter((sender) => {
      if (senderQuery) {
        const haystack = `${sender.name || ''} ${sender.email}`.toLowerCase();
        if (!haystack.includes(senderQuery)) return false;
      }
      if (messagesMin !== null && sender.messageCount < messagesMin) return false;
      if (totalSizeMin !== null && sender.totalSize < totalSizeMin) return false;
      return true;
    });
  }, [senders, filters]);

  const sortedSenders = useMemo(() => {
    if (!sortState.column) return filteredSenders;
    const factor = sortState.direction === 'asc' ? 1 : -1;
    const decorated = filteredSenders.map((sender) => ({
      sender,
      key: sortState.column === 'name' ? (sender.name || sender.email).toLowerCase() : sender[sortState.column],
    }));
    decorated.sort((a, b) => {
      if (a.key < b.key) return -1 * factor;
      if (a.key > b.key) return 1 * factor;
      return 0;
    });
    return decorated.map((d) => d.sender);
  }, [filteredSenders, sortState]);

  let emptyMessage = null;
  if (sortedSenders.length === 0) {
    emptyMessage = senders.length > 0 ? 'No senders match the current filters.' : noDataMessage;
  }

  // `page` can point past the end after filtering/page-size shrinks the
  // result set (e.g. typing a filter while on page 3) -- `currentPage` is
  // the clamped value actually used for display/slicing/navigation, so
  // there's no separate effect needed to keep `page` itself in range.
  const pageCount = Math.max(1, Math.ceil(sortedSenders.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedSenders = useMemo(
    () => sortedSenders.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sortedSenders, currentPage, pageSize]
  );

  const handlePageSizeChange = (newPageSize) => {
    setPageSize(newPageSize);
    setPage(1);
  };

  // Select-all applies to the current page only, matching how paginated
  // tables typically scope "select all" (Gmail's own inbox included).
  const allVisibleSelected = pagedSenders.length > 0 && pagedSenders.every((sender) => selected.has(sender.email));
  const someVisibleSelected = !allVisibleSelected && pagedSenders.some((sender) => selected.has(sender.email));
  const selectAllRef = useRef(null);
  useEffect(() => {
    selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  return (
    <>
      <table className="sendersTable">
        <thead>
          <tr>
            <th className="select-col">
              <label className="checkbox-target">
                <input
                  type="checkbox"
                  ref={selectAllRef}
                  checked={allVisibleSelected}
                  onChange={() => onToggleSelectAll(pagedSenders)}
                  aria-label="Select all senders on this page"
                />
              </label>
            </th>
            <th data-sort="name" onClick={() => setSortState((prev) => cycleSortState(prev, 'name'))}>
              Sender<span className="sort-indicator">{sortIndicator(sortState, 'name')}</span>
            </th>
            <th data-sort="messageCount" onClick={() => setSortState((prev) => cycleSortState(prev, 'messageCount'))}>
              Messages<span className="sort-indicator">{sortIndicator(sortState, 'messageCount')}</span>
            </th>
            <th data-sort="totalSize" onClick={() => setSortState((prev) => cycleSortState(prev, 'totalSize'))}>
              Total Size<span className="sort-indicator">{sortIndicator(sortState, 'totalSize')}</span>
            </th>
            {showReasonColumn && <th>Why</th>}
            <th></th>
          </tr>
          <tr className="filters">
            <th></th>
            <th>
              <input
                type="text"
                placeholder="Contains..."
                autoComplete="off"
                value={filters.sender}
                onChange={(event) => {
                  setFilters((f) => ({ ...f, sender: event.target.value }));
                  setPage(1);
                }}
              />
            </th>
            <th>
              <input
                type="number"
                min="0"
                placeholder=">= count"
                autoComplete="off"
                value={filters.messages}
                onChange={(event) => {
                  setFilters((f) => ({ ...f, messages: event.target.value }));
                  setPage(1);
                }}
              />
            </th>
            <th>
              <input
                type="text"
                placeholder=">= e.g. 500KB or 2MB"
                autoComplete="off"
                value={filters.totalSize}
                onChange={(event) => {
                  setFilters((f) => ({ ...f, totalSize: event.target.value }));
                  setPage(1);
                }}
              />
            </th>
            {showReasonColumn && <th></th>}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {pagedSenders.map((sender) => (
            <SenderRow
              key={sender.email}
              sender={sender}
              onTrash={onTrash}
              onIgnore={onIgnore}
              selected={selected.has(sender.email)}
              onToggleSelect={onToggleSelect}
              showReasonColumn={showReasonColumn}
            />
          ))}
        </tbody>
      </table>
      {emptyMessage && <p className="muted">{emptyMessage}</p>}
      <Pagination
        page={currentPage}
        pageCount={pageCount}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        totalItems={sortedSenders.length}
        onPageChange={setPage}
        onPageSizeChange={handlePageSizeChange}
        itemLabel="senders"
      />
    </>
  );
}

function SenderRow({ sender, onTrash, onIgnore, selected, onToggleSelect, showReasonColumn }) {
  const [busy, setBusy] = useState(false);

  const title = sender.latestMessage
    ? [
        sender.latestMessage.date ? formatDate(new Date(sender.latestMessage.date).toISOString()) : '',
        sender.latestMessage.subject,
        sender.latestMessage.snippet,
      ]
        .filter(Boolean)
        .join('\n')
    : undefined;

  const handleTrash = async () => {
    const label = sender.name || sender.email;
    if (!confirm(`Move all ${sender.messageCount} email(s) from ${label} to Trash?`)) return;
    setBusy(true);
    try {
      await onTrash(sender);
      // On success this row unmounts (the sender drops out of the parent's
      // list once all its messages are trashed) -- only reset busy on error.
    } catch (err) {
      alert(err.message);
      setBusy(false);
    }
  };

  const handleIgnore = async () => {
    setBusy(true);
    try {
      await onIgnore(sender);
      // Same as above: success removes this row entirely.
    } catch (err) {
      alert(err.message);
      setBusy(false);
    }
  };

  return (
    <tr>
      <td className="select-col">
        <label className="checkbox-target">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(sender.email)}
            aria-label={`Select ${sender.name || sender.email}`}
          />
        </label>
      </td>
      <td className="sender-link" title={title} onClick={() => openGmailSearch(sender.email)}>
        {sender.name ? `${sender.name} <${sender.email}>` : sender.email}
      </td>
      <td>{sender.messageCount}</td>
      <td>{formatSize(sender.totalSize)}</td>
      {showReasonColumn && (
        <td className="reason-col">
          {(sender.reasons || []).map((reason) => (
            <span key={reason} className="reason-icon" role="img" aria-label={REASON_META[reason].label} title={REASON_META[reason].label}>
              {REASON_META[reason].icon}
            </span>
          ))}
        </td>
      )}
      <td>
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={handleIgnore}>
            Ignore
          </button>
          <button className="danger" disabled={busy} onClick={handleTrash}>
            {busy ? 'Working...' : 'Move to Trash'}
          </button>
        </div>
      </td>
    </tr>
  );
}
