import { useState, useMemo } from 'react';

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

function formatDate(iso) {
  if (!iso) return 'never';
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
  if (prev.column === column) {
    if (prev.direction === 'asc') return { column, direction: 'desc' };
    if (prev.direction === 'desc') return { column: null, direction: null };
    return { column, direction: 'asc' };
  }
  return { column, direction: 'asc' };
}

function sortIndicator(sortState, column) {
  if (sortState.column !== column) return '';
  return sortState.direction === 'asc' ? ' ▲' : ' ▼';
}

export default function SendersTable({ senders, onTrash, onIgnore }) {
  const [sortState, setSortState] = useState({ column: 'totalSize', direction: 'desc' });
  const [filters, setFilters] = useState({ sender: '', messages: '', totalSize: '' });

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
    emptyMessage = senders.length > 0 ? 'No senders match the current filters.' : 'Sign in and click "Sync Now" to fetch your inbox.';
  }

  return (
    <>
      <table id="sendersTable">
        <thead>
          <tr>
            <th data-sort="name" onClick={() => setSortState((prev) => cycleSortState(prev, 'name'))}>
              Sender<span className="sort-indicator">{sortIndicator(sortState, 'name')}</span>
            </th>
            <th data-sort="messageCount" onClick={() => setSortState((prev) => cycleSortState(prev, 'messageCount'))}>
              Messages<span className="sort-indicator">{sortIndicator(sortState, 'messageCount')}</span>
            </th>
            <th data-sort="totalSize" onClick={() => setSortState((prev) => cycleSortState(prev, 'totalSize'))}>
              Total Size<span className="sort-indicator">{sortIndicator(sortState, 'totalSize')}</span>
            </th>
            <th></th>
          </tr>
          <tr className="filters">
            <th>
              <input
                type="text"
                placeholder="Contains..."
                autoComplete="off"
                value={filters.sender}
                onChange={(event) => setFilters((f) => ({ ...f, sender: event.target.value }))}
              />
            </th>
            <th>
              <input
                type="number"
                min="0"
                placeholder=">= count"
                autoComplete="off"
                value={filters.messages}
                onChange={(event) => setFilters((f) => ({ ...f, messages: event.target.value }))}
              />
            </th>
            <th>
              <input
                type="text"
                placeholder=">= e.g. 500KB or 2MB"
                autoComplete="off"
                value={filters.totalSize}
                onChange={(event) => setFilters((f) => ({ ...f, totalSize: event.target.value }))}
              />
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedSenders.map((sender) => (
            <SenderRow key={sender.email} sender={sender} onTrash={onTrash} onIgnore={onIgnore} />
          ))}
        </tbody>
      </table>
      {emptyMessage && <p className="muted">{emptyMessage}</p>}
    </>
  );
}

function SenderRow({ sender, onTrash, onIgnore }) {
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
      <td className="sender-link" title={title} onClick={() => openGmailSearch(sender.email)}>
        {sender.name ? `${sender.name} <${sender.email}>` : sender.email}
      </td>
      <td>{sender.messageCount}</td>
      <td>{formatSize(sender.totalSize)}</td>
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
