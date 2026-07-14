import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SendersSection from './SendersSection.jsx';

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

function renderSection(props = {}) {
  return render(
    <SendersSection
      senders={[]}
      cleanupSuggestions={[]}
      cleanupThresholdYears={2}
      onThresholdYearsChange={vi.fn()}
      onTrash={vi.fn()}
      onIgnore={vi.fn()}
      onTrashSelected={vi.fn()}
      {...props}
    />
  );
}

function bulkButton() {
  return screen.getByRole('button', { name: 'Move selected senders to Trash' });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'open').mockImplementation(() => {});
});

describe('tabs', () => {
  it('shows the All Senders tab by default', () => {
    renderSection({ senders: [sender({ email: 'a@example.com', name: 'Alice' })] });
    expect(screen.getByRole('tab', { name: 'All Senders' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Cleanup Suggestions' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Alice <a@example.com>')).toBeInTheDocument();
  });

  it('switches to the Cleanup Suggestions tab and shows its data instead', async () => {
    renderSection({
      senders: [sender({ email: 'a@example.com', name: 'Alice' })],
      cleanupSuggestions: [sender({ email: 'b@example.com', name: 'Bob' })],
    });

    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));

    expect(screen.getByRole('tab', { name: 'Cleanup Suggestions' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Alice <a@example.com>')).not.toBeInTheDocument();
    expect(screen.getByText('Bob <b@example.com>')).toBeInTheDocument();
  });

  it('remembers the active tab across remounts', async () => {
    const { unmount } = renderSection();
    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));
    unmount();

    renderSection();
    expect(screen.getByRole('tab', { name: 'Cleanup Suggestions' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the years-threshold control only on the Cleanup Suggestions tab', async () => {
    renderSection();
    expect(screen.queryByText(/Suggest cleanup for senders inactive/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));
    expect(screen.getByText(/Suggest cleanup for senders inactive/)).toBeInTheDocument();
  });

  it('calls onThresholdYearsChange with a valid new value', async () => {
    const onThresholdYearsChange = vi.fn();
    renderSection({ onThresholdYearsChange });
    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));

    const input = screen.getByRole('spinbutton', { name: 'Inactive threshold in years' });
    fireEvent.change(input, { target: { value: '3' } });

    expect(onThresholdYearsChange).toHaveBeenCalledWith(3);
  });

  it('does not call onThresholdYearsChange for a negative value', async () => {
    const onThresholdYearsChange = vi.fn();
    renderSection({ onThresholdYearsChange });
    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));

    const input = screen.getByRole('spinbutton', { name: 'Inactive threshold in years' });
    fireEvent.change(input, { target: { value: '-1' } });

    expect(onThresholdYearsChange).not.toHaveBeenCalled();
  });
});

describe('Move to Trash toolbar', () => {
  const senders = [
    sender({ email: 'a@example.com', name: 'Alice', messageCount: 3, totalSize: 300 }),
    sender({ email: 'b@example.com', name: 'Bob', messageCount: 4, totalSize: 200 }),
  ];

  it('is disabled until at least one sender is selected, and enables once one is', async () => {
    renderSection({ senders });
    expect(bulkButton()).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    expect(bulkButton()).toBeEnabled();
    expect(bulkButton()).toHaveTextContent('Move to Trash (1)');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    expect(bulkButton()).toBeDisabled();
  });

  it('selects and deselects every visible sender via the header checkbox', async () => {
    renderSection({ senders });
    const selectAll = screen.getByRole('checkbox', { name: 'Select all senders on this page' });

    await userEvent.click(selectAll);
    expect(screen.getByRole('checkbox', { name: 'Select Alice' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Bob' })).toBeChecked();
    expect(bulkButton()).toHaveTextContent('Move to Trash (2)');

    await userEvent.click(selectAll);
    expect(screen.getByRole('checkbox', { name: 'Select Alice' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Bob' })).not.toBeChecked();
    expect(bulkButton()).toBeDisabled();
  });

  it('marks the header checkbox indeterminate when only some senders are selected', async () => {
    renderSection({ senders });
    const selectAll = screen.getByRole('checkbox', { name: 'Select all senders on this page' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    expect(selectAll.indeterminate).toBe(true);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Bob' }));
    expect(selectAll.indeterminate).toBe(false);
  });

  it('asks for confirmation naming the total messages and sender count before bulk trashing', async () => {
    const onTrashSelected = vi.fn().mockResolvedValue(undefined);
    renderSection({ senders, onTrashSelected });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Bob' }));
    await userEvent.click(bulkButton());

    expect(window.confirm).toHaveBeenCalledWith('Move all 7 email(s) from 2 senders to Trash?');
    expect(onTrashSelected).toHaveBeenCalledWith(senders);
  });

  it('uses singular phrasing when exactly one sender is selected', async () => {
    const onTrashSelected = vi.fn().mockResolvedValue(undefined);
    renderSection({ senders, onTrashSelected });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    await userEvent.click(bulkButton());

    expect(window.confirm).toHaveBeenCalledWith('Move all 3 email(s) from 1 sender to Trash?');
  });

  it('does not bulk trash when the confirmation is declined', async () => {
    window.confirm.mockReturnValue(false);
    const onTrashSelected = vi.fn();
    renderSection({ senders, onTrashSelected });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    await userEvent.click(bulkButton());

    expect(onTrashSelected).not.toHaveBeenCalled();
  });

  it('shows a working state while bulk trashing, then re-enables the button on success', async () => {
    let resolveTrash;
    const onTrashSelected = vi.fn(() => new Promise((resolve) => (resolveTrash = resolve)));
    renderSection({ senders, onTrashSelected });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    await userEvent.click(bulkButton());
    expect(bulkButton()).toBeDisabled();

    resolveTrash();
    await waitFor(() => expect(onTrashSelected).toHaveBeenCalledTimes(1));
  });

  it('alerts and re-enables the bulk button when bulk trashing fails', async () => {
    const onTrashSelected = vi.fn().mockRejectedValue(new Error('bulk trash failed'));
    renderSection({ senders, onTrashSelected });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    await userEvent.click(bulkButton());

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('bulk trash failed'));
    expect(bulkButton()).toBeEnabled();
  });

  it('drops a sender from the selection once it disappears from the senders list (e.g. after being trashed)', async () => {
    const { rerender } = renderSection({ senders });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    expect(bulkButton()).toHaveTextContent('Move to Trash (1)');

    rerender(
      <SendersSection
        senders={[senders[1]]}
        cleanupSuggestions={[]}
        cleanupThresholdYears={2}
        onThresholdYearsChange={vi.fn()}
        onTrash={vi.fn()}
        onIgnore={vi.fn()}
        onTrashSelected={vi.fn()}
      />
    );
    expect(bulkButton()).toBeDisabled();
  });
});

describe('selection shared across tabs', () => {
  it('keeps a sender selected (and counted in the toolbar) after switching tabs, if they appear in both lists', async () => {
    const shared = sender({ email: 'shared@example.com', name: 'Shared' });
    renderSection({ senders: [shared], cleanupSuggestions: [shared] });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Shared' }));
    expect(bulkButton()).toHaveTextContent('Move to Trash (1)');

    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));
    expect(screen.getByRole('checkbox', { name: 'Select Shared' })).toBeChecked();
    expect(bulkButton()).toHaveTextContent('Move to Trash (1)');
  });

  it('resolves selected senders made while viewing Cleanup Suggestions against the full senders list for bulk trash', async () => {
    const target = sender({ email: 'target@example.com', name: 'Target', messageCount: 5, totalSize: 500 });
    const onTrashSelected = vi.fn().mockResolvedValue(undefined);
    renderSection({ senders: [target], cleanupSuggestions: [target], onTrashSelected });

    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Target' }));
    await userEvent.click(bulkButton());

    expect(onTrashSelected).toHaveBeenCalledWith([target]);
  });

  it('drops a sender from the selection once it disappears from both lists', async () => {
    const senders = [sender({ email: 'a@example.com', name: 'Alice' })];
    const { rerender } = renderSection({ senders, cleanupSuggestions: [] });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alice' }));
    expect(bulkButton()).toHaveTextContent('Move to Trash (1)');

    rerender(
      <SendersSection
        senders={[]}
        cleanupSuggestions={[]}
        cleanupThresholdYears={2}
        onThresholdYearsChange={vi.fn()}
        onTrash={vi.fn()}
        onIgnore={vi.fn()}
        onTrashSelected={vi.fn()}
      />
    );
    expect(bulkButton()).toBeDisabled();
  });
});
