import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SendersTable from './SendersTable.jsx';

function sender(overrides = {}) {
  return {
    email: 'a@example.com',
    name: null,
    messageCount: 1,
    totalSize: 100,
    ids: ['1'],
    latestMessage: null,
    ...overrides,
  };
}

// Selection is now a controlled prop owned by the parent (see
// SendersSection.jsx) rather than local state, so every render needs a
// selected Set plus onToggleSelect/onToggleSelectAll -- default them here so
// tests that don't care about selection don't have to repeat the boilerplate.
function renderTable(props = {}) {
  return render(
    <SendersTable
      senders={[]}
      onTrash={vi.fn()}
      onIgnore={vi.fn()}
      selected={new Set()}
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      storageKeyPrefix="gmailCleaner.senders"
      noDataMessage='Sign in and click "Sync Now" to fetch your inbox.'
      {...props}
    />
  );
}

function rerenderTable(rerender, props = {}) {
  return rerender(
    <SendersTable
      senders={[]}
      onTrash={vi.fn()}
      onIgnore={vi.fn()}
      selected={new Set()}
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      storageKeyPrefix="gmailCleaner.senders"
      noDataMessage='Sign in and click "Sync Now" to fetch your inbox.'
      {...props}
    />
  );
}

function rowEmails() {
  return screen.getAllByRole('row').slice(2) // skip the two header rows
    .map((row) => within(row).getAllByRole('cell')[1].textContent); // cell[0] is the select checkbox
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'open').mockImplementation(() => {});
});

describe('empty states', () => {
  it('shows the sign-in prompt when there is no data at all', () => {
    renderTable({ senders: [] });
    expect(screen.getByText('Sign in and click "Sync Now" to fetch your inbox.')).toBeInTheDocument();
  });

  it('shows a "no matches" message when filters exclude everything', async () => {
    renderTable({ senders: [sender()] });
    await userEvent.type(screen.getByPlaceholderText('Contains...'), 'nonexistent');
    expect(screen.getByText('No senders match the current filters.')).toBeInTheDocument();
  });

  it('uses the caller-supplied noDataMessage when there is no data at all', () => {
    renderTable({ senders: [], noDataMessage: 'No cleanup suggestions right now.' });
    expect(screen.getByText('No cleanup suggestions right now.')).toBeInTheDocument();
  });
});

describe('rendering', () => {
  it('renders a bare email when there is no display name', () => {
    renderTable({ senders: [sender({ email: 'plain@example.com', name: null })] });
    expect(screen.getByText('plain@example.com')).toBeInTheDocument();
  });

  it('renders "name <email>" when a display name is present', () => {
    renderTable({ senders: [sender({ email: 'a@example.com', name: 'Alice' })] });
    expect(screen.getByText('Alice <a@example.com>')).toBeInTheDocument();
  });

  it.each([
    [0, '0 B'],
    [500, '500 B'],
    [2048, '2.0 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [3 * 1024 * 1024 * 1024, '3.0 GB'],
  ])('formats %i bytes as %s', (bytes, expected) => {
    renderTable({ senders: [sender({ totalSize: bytes })] });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('shows the latest message date, formatted', () => {
    renderTable({ senders: [sender({ latestMessage: { date: 'Wed, 1 Jan 2025 00:00:00 +0000', subject: 'Hi', snippet: '' } })] });
    expect(screen.getByText(new Date('Wed, 1 Jan 2025 00:00:00 +0000').toLocaleDateString())).toBeInTheDocument();
  });

  it('shows a dash for the latest message date when no message has a parseable date', () => {
    renderTable({ senders: [sender({ latestMessage: { date: null, subject: 'Hi', snippet: '' } })] });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows a dash for the latest message date when there is no latest message at all', () => {
    renderTable({ senders: [sender({ latestMessage: null })] });
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('sorting', () => {
  const senders = [
    sender({ email: 'b@example.com', name: 'Bravo', messageCount: 5, totalSize: 200 }),
    sender({ email: 'a@example.com', name: 'Alpha', messageCount: 10, totalSize: 300 }),
    sender({ email: 'c@example.com', name: 'Charlie', messageCount: 1, totalSize: 100 }),
  ];

  it('defaults to total size descending', () => {
    renderTable({ senders });
    expect(rowEmails()).toEqual(['Alpha <a@example.com>', 'Bravo <b@example.com>', 'Charlie <c@example.com>']);
  });

  it('sorts by Sender ascending then descending then back to the default on a third click', async () => {
    renderTable({ senders });
    const senderHeader = screen.getByText('Sender').closest('th');

    await userEvent.click(senderHeader);
    expect(rowEmails()).toEqual(['Alpha <a@example.com>', 'Bravo <b@example.com>', 'Charlie <c@example.com>']);
    expect(within(senderHeader).getByText('▲', { exact: false })).toBeInTheDocument();

    await userEvent.click(senderHeader);
    expect(rowEmails()).toEqual(['Charlie <c@example.com>', 'Bravo <b@example.com>', 'Alpha <a@example.com>']);
    expect(within(senderHeader).getByText('▼', { exact: false })).toBeInTheDocument();

    await userEvent.click(senderHeader);
    // Back to unsorted -- the original prop order, not necessarily total-size order.
    expect(rowEmails()).toEqual(['Bravo <b@example.com>', 'Alpha <a@example.com>', 'Charlie <c@example.com>']);

    // A fourth click on the same column restarts the cycle at ascending.
    await userEvent.click(senderHeader);
    expect(rowEmails()).toEqual(['Alpha <a@example.com>', 'Bravo <b@example.com>', 'Charlie <c@example.com>']);
    expect(within(senderHeader).getByText('▲', { exact: false })).toBeInTheDocument();
  });

  it('leaves equal-key senders in their relative order when sorting', async () => {
    const tied = [
      sender({ email: 'x@example.com', name: 'X', messageCount: 5, totalSize: 100 }),
      sender({ email: 'y@example.com', name: 'Y', messageCount: 5, totalSize: 200 }),
    ];
    renderTable({ senders: tied });
    await userEvent.click(screen.getByText('Messages').closest('th')); // both have messageCount: 5 -- a tie
    expect(rowEmails()).toEqual(['X <x@example.com>', 'Y <y@example.com>']);
  });

  it('sorts by Messages', async () => {
    renderTable({ senders });
    await userEvent.click(screen.getByText('Messages').closest('th'));
    expect(rowEmails()).toEqual(['Charlie <c@example.com>', 'Bravo <b@example.com>', 'Alpha <a@example.com>']);
  });

  it('sorts by Sender using the email when a sender has no display name', async () => {
    const mixed = [
      sender({ email: 'bbb@example.com', name: 'ZZZ Named' }),
      sender({ email: 'aaa@example.com', name: null }), // sorts by email "aaa@..." here, which comes first
    ];
    renderTable({ senders: mixed });
    await userEvent.click(screen.getByText('Sender').closest('th')); // ascending
    expect(rowEmails()).toEqual(['aaa@example.com', 'ZZZ Named <bbb@example.com>']);
  });

  it('clicking Total Size (already the default sort) goes straight to unsorted', async () => {
    renderTable({ senders });
    // Initial state already represents "totalSize desc", so the first click
    // on that same header cycles directly to unsorted, not ascending.
    await userEvent.click(screen.getByText('Total Size').closest('th'));
    expect(rowEmails()).toEqual(['Bravo <b@example.com>', 'Alpha <a@example.com>', 'Charlie <c@example.com>']);
  });

  it('sorts by Latest Message', async () => {
    const byDate = [
      sender({ email: 'mid@example.com', name: 'Mid', latestTimestamp: Date.parse('2026-02-01') }),
      sender({ email: 'newest@example.com', name: 'Newest', latestTimestamp: Date.parse('2026-03-01') }),
      sender({ email: 'oldest@example.com', name: 'Oldest', latestTimestamp: Date.parse('2026-01-01') }),
    ];
    renderTable({ senders: byDate });
    await userEvent.click(screen.getByText('Latest Message').closest('th')); // ascending
    expect(rowEmails()).toEqual(['Oldest <oldest@example.com>', 'Mid <mid@example.com>', 'Newest <newest@example.com>']);
  });
});

describe('filtering', () => {
  const senders = [
    sender({ email: 'newsletter@shop.com', name: 'Shop Newsletter', messageCount: 50, totalSize: 600 * 1024 }),
    sender({ email: 'friend@example.com', name: 'A Friend', messageCount: 2, totalSize: 1024 }),
  ];

  it('filters Sender by substring against name or email, case-insensitively', async () => {
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('Contains...'), 'NEWSLETTER');
    expect(rowEmails()).toEqual(['Shop Newsletter <newsletter@shop.com>']);
  });

  it('filters Messages by a >= threshold', async () => {
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('>= count'), '10');
    expect(rowEmails()).toEqual(['Shop Newsletter <newsletter@shop.com>']);
  });

  it('ignores an invalid Messages filter instead of excluding everything', async () => {
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('>= count'), '-5');
    expect(rowEmails()).toHaveLength(2);
  });

  it('filters Total Size using a unit suffix', async () => {
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('>= e.g. 500KB or 2MB'), '500KB');
    expect(rowEmails()).toEqual(['Shop Newsletter <newsletter@shop.com>']);
  });

  it('treats a bare number as bytes for the Total Size filter', async () => {
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('>= e.g. 500KB or 2MB'), '2000');
    expect(rowEmails()).toEqual(['Shop Newsletter <newsletter@shop.com>']);
  });

  it('ignores an unparseable Total Size filter instead of excluding everything', async () => {
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('>= e.g. 500KB or 2MB'), 'garbage');
    expect(rowEmails()).toHaveLength(2);
  });

  it('ignores a Total Size filter that matches the number pattern but has no actual digits', async () => {
    // "..." matches the [\d.]+ character class (dots alone qualify) but
    // parseFloat('...') is NaN -- a distinct failure mode from non-matching
    // garbage like "garbage" above.
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('>= e.g. 500KB or 2MB'), '...');
    expect(rowEmails()).toHaveLength(2);
  });

  it('combines filters with AND', async () => {
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('Contains...'), 'example.com'); // matches only "friend"
    await userEvent.type(screen.getByPlaceholderText('>= count'), '10'); // matches only "newsletter"
    expect(rowEmails()).toEqual([]);
  });
});

describe('hover preview', () => {
  it('has no title when there is no latest message', () => {
    renderTable({ senders: [sender({ latestMessage: null })] });
    expect(screen.getByText('a@example.com')).not.toHaveAttribute('title');
  });

  it('builds a title from date, subject, and snippet', () => {
    renderTable({
      senders: [
        sender({
          latestMessage: { date: 'Wed, 1 Jan 2025 00:00:00 +0000', subject: 'Hello', snippet: 'a short preview' },
        }),
      ],
    });
    const title = screen.getByText('a@example.com').getAttribute('title');
    expect(title).toContain('Hello');
    expect(title).toContain('a short preview');
  });

  it('omits the date line when the latest message has no date', () => {
    renderTable({ senders: [sender({ latestMessage: { date: null, subject: 'Hello', snippet: '' } })] });
    expect(screen.getByText('a@example.com').getAttribute('title')).toBe('Hello');
  });
});

describe('reason column', () => {
  it('does not render a Why column when showReasonColumn is not set', () => {
    renderTable({ senders: [sender({ reasons: ['trashedBefore'] })] });
    expect(screen.queryByText('Why')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders an icon with a tooltip for each reason when showReasonColumn is set', () => {
    renderTable({
      senders: [sender({ reasons: ['staleNoContact', 'trashedBefore'] })],
      showReasonColumn: true,
    });
    expect(screen.getByText('Why')).toBeInTheDocument();
    const icons = screen.getAllByRole('img');
    expect(icons).toHaveLength(2);
    expect(icons[0]).toHaveAttribute(
      'title',
      "You've never emailed or replied to this sender, and their most recent message is older than the threshold."
    );
    expect(icons[1]).toHaveAttribute('title', "You've moved mail from this sender to Trash here before.");
  });

  it('renders no icons for a sender with no reasons field, even with the column shown', () => {
    renderTable({ senders: [sender()], showReasonColumn: true }); // default sender() has no `reasons` field at all
    expect(screen.getByText('Why')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('click-to-search', () => {
  it('opens a Gmail search for the sender in a new tab', async () => {
    renderTable({ senders: [sender({ email: 'a@example.com' })] });
    await userEvent.click(screen.getByText('a@example.com'));
    expect(window.open).toHaveBeenCalledWith(
      'https://mail.google.com/mail/u/0/#search/from%3Aa%40example.com',
      '_blank',
      'noopener,noreferrer'
    );
  });
});

describe('Move to Trash', () => {
  it('asks for confirmation before trashing', async () => {
    const onTrash = vi.fn().mockResolvedValue(undefined);
    renderTable({ senders: [sender({ messageCount: 7, name: 'Alice' })], onTrash });
    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(window.confirm).toHaveBeenCalledWith('Move all 7 email(s) from Alice to Trash?');
    expect(onTrash).toHaveBeenCalledTimes(1);
  });

  it('does not trash when the confirmation is declined', async () => {
    window.confirm.mockReturnValue(false);
    const onTrash = vi.fn();
    renderTable({ senders: [sender()], onTrash });
    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(onTrash).not.toHaveBeenCalled();
  });

  it('shows a working state while trashing and disables both action buttons', async () => {
    let resolveTrash;
    const onTrash = vi.fn(() => new Promise((resolve) => (resolveTrash = resolve)));
    renderTable({ senders: [sender()], onTrash });

    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(screen.getByRole('button', { name: 'Working...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ignore' })).toBeDisabled();

    resolveTrash();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Working...' })).toBeDisabled());
  });

  it('alerts and re-enables the buttons when trashing fails', async () => {
    const onTrash = vi.fn().mockRejectedValue(new Error('trash failed'));
    renderTable({ senders: [sender()], onTrash });

    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('trash failed'));
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Ignore' })).toBeEnabled();
  });
});

describe('Ignore', () => {
  it('calls onIgnore without requiring confirmation', async () => {
    const onIgnore = vi.fn().mockResolvedValue(undefined);
    renderTable({ senders: [sender()], onIgnore });
    await userEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(onIgnore).toHaveBeenCalledTimes(1);
  });

  it('alerts and re-enables the buttons when ignoring fails', async () => {
    const onIgnore = vi.fn().mockRejectedValue(new Error('ignore failed'));
    renderTable({ senders: [sender()], onIgnore });

    await userEvent.click(screen.getByRole('button', { name: 'Ignore' }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('ignore failed'));
    expect(screen.getByRole('button', { name: 'Ignore' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeEnabled();
  });
});

// Selection itself (the shared Set, the "Move to Trash" toolbar) now lives
// in SendersSection.jsx -- these tests only cover SendersTable's side of the
// controlled-prop contract: it reflects the `selected` prop and reports
// interactions via onToggleSelect/onToggleSelectAll, nothing more.
describe('selection (controlled props)', () => {
  const senders = [
    sender({ email: 'a@example.com', name: 'Alice' }),
    sender({ email: 'b@example.com', name: 'Bob' }),
  ];

  it('reflects the selected prop on each row checkbox', () => {
    renderTable({ senders, selected: new Set(['a@example.com']) });
    expect(screen.getByRole('checkbox', { name: 'Select Alice' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Bob' })).not.toBeChecked();
  });

  it('calls onToggleSelect with the row email when a row checkbox is clicked', async () => {
    const onToggleSelect = vi.fn();
    renderTable({ senders, onToggleSelect });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    expect(onToggleSelect).toHaveBeenCalledWith('a@example.com');
  });

  it('calls onToggleSelectAll with the currently visible (paged) senders when the header checkbox is clicked', async () => {
    const onToggleSelectAll = vi.fn();
    renderTable({ senders, onToggleSelectAll });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all senders on this page' }));
    expect(onToggleSelectAll).toHaveBeenCalledWith(senders);
  });

  it('checks the header checkbox only when every visible sender is selected', () => {
    renderTable({ senders, selected: new Set(['a@example.com', 'b@example.com']) });
    expect(screen.getByRole('checkbox', { name: 'Select all senders on this page' })).toBeChecked();
  });

  it('marks the header checkbox indeterminate when only some visible senders are selected', () => {
    renderTable({ senders, selected: new Set(['a@example.com']) });
    expect(screen.getByRole('checkbox', { name: 'Select all senders on this page' }).indeterminate).toBe(true);
  });
});

describe('pagination', () => {
  function manySenders(count) {
    return Array.from({ length: count }, (_, i) =>
      sender({ email: `s${String(i).padStart(2, '0')}@example.com`, name: `Sender ${String(i).padStart(2, '0')}`, totalSize: count - i })
    );
  }

  it('shows only the first page by default and reports the right counts', () => {
    renderTable({ senders: manySenders(30) });
    expect(rowEmails()).toHaveLength(25); // default page size
    expect(screen.getByText('Showing 1-25 of 30 senders')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('navigates to the next/previous page', async () => {
    renderTable({ senders: manySenders(30) });

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(rowEmails()).toHaveLength(5);
    expect(screen.getByText('Showing 26-30 of 30 senders')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(rowEmails()).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('changing the page size re-pages the list and resets to page 1', async () => {
    renderTable({ senders: manySenders(30) });

    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // go to page 2 of the default size
    await userEvent.selectOptions(screen.getByRole('combobox'), '10');

    expect(rowEmails()).toHaveLength(10);
    expect(screen.getByText('Showing 1-10 of 30 senders')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });

  it('resets to page 1 when a filter narrows the result set', async () => {
    renderTable({ senders: manySenders(30) });

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Contains...'), 'Sender 0');
    expect(screen.getByText(/Page 1 of/)).toBeInTheDocument();
    expect(rowEmails().every((text) => text.includes('Sender 0'))).toBe(true);
  });

  it('clamps to the last page when the result set shrinks out from under the current page', async () => {
    const { rerender } = renderTable({ senders: manySenders(30) });
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // now on page 2 of 2
    rerenderTable(rerender, { senders: manySenders(3) });
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    expect(rowEmails()).toHaveLength(3);
  });

  it('does not render pagination controls when there are no senders', () => {
    renderTable({ senders: [] });
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
  });

  it('select-all only reports the current page, not senders on other pages', async () => {
    const onToggleSelectAll = vi.fn();
    renderTable({ senders: manySenders(30), onToggleSelectAll });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all senders on this page' }));
    const [visibleSenders] = onToggleSelectAll.mock.calls[0];
    expect(visibleSenders).toHaveLength(25);
  });
});

describe('sort/filter persistence', () => {
  const senders = [
    sender({ email: 'b@example.com', name: 'Bravo', messageCount: 5, totalSize: 200 }),
    sender({ email: 'a@example.com', name: 'Alpha', messageCount: 10, totalSize: 300 }),
    sender({ email: 'c@example.com', name: 'Charlie', messageCount: 1, totalSize: 100 }),
  ];

  it('restores a previously remembered sort order on mount', () => {
    localStorage.setItem('gmailCleaner.sendersSort', JSON.stringify({ column: 'name', direction: 'asc' }));
    renderTable({ senders });
    expect(rowEmails()).toEqual(['Alpha <a@example.com>', 'Bravo <b@example.com>', 'Charlie <c@example.com>']);
  });

  it('restores previously remembered filters on mount', () => {
    localStorage.setItem('gmailCleaner.sendersFilters', JSON.stringify({ sender: 'bravo', messages: '', totalSize: '' }));
    renderTable({ senders });
    expect(rowEmails()).toEqual(['Bravo <b@example.com>']);
    expect(screen.getByPlaceholderText('Contains...')).toHaveValue('bravo');
  });

  it('persists sort changes as they happen', async () => {
    renderTable({ senders });
    await userEvent.click(screen.getByText('Messages').closest('th'));
    expect(JSON.parse(localStorage.getItem('gmailCleaner.sendersSort'))).toEqual({ column: 'messageCount', direction: 'asc' });
  });

  it('persists filter changes as they happen', async () => {
    renderTable({ senders });
    await userEvent.type(screen.getByPlaceholderText('>= count'), '5');
    expect(JSON.parse(localStorage.getItem('gmailCleaner.sendersFilters'))).toEqual({ sender: '', messages: '5', totalSize: '' });
  });

  it('falls back to the default sort/filters when stored values are malformed', () => {
    localStorage.setItem('gmailCleaner.sendersSort', 'not json');
    localStorage.setItem('gmailCleaner.sendersFilters', JSON.stringify({ sender: 'ok' })); // missing keys
    renderTable({ senders });
    // Default sort (total size descending) plus no filters applied.
    expect(rowEmails()).toEqual(['Alpha <a@example.com>', 'Bravo <b@example.com>', 'Charlie <c@example.com>']);
  });

  it('ignores a stored sort column that no longer exists', () => {
    localStorage.setItem('gmailCleaner.sendersSort', JSON.stringify({ column: 'nonexistentColumn', direction: 'asc' }));
    renderTable({ senders });
    expect(rowEmails()).toEqual(['Alpha <a@example.com>', 'Bravo <b@example.com>', 'Charlie <c@example.com>']);
  });

  it('uses a distinct storage key per storageKeyPrefix, so two instances do not collide', async () => {
    renderTable({ senders, storageKeyPrefix: 'gmailCleaner.cleanupSuggestions' });
    await userEvent.click(screen.getByText('Messages').closest('th'));

    expect(localStorage.getItem('gmailCleaner.sendersSort')).toBeNull();
    expect(JSON.parse(localStorage.getItem('gmailCleaner.cleanupSuggestionsSort'))).toEqual({
      column: 'messageCount',
      direction: 'asc',
    });
  });
});
