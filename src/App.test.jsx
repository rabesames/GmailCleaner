import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./lib/auth.js', () => ({
  setCurrentClientId: vi.fn(),
  getStoredClientId: vi.fn().mockReturnValue(''),
  isSignedIn: vi.fn().mockReturnValue(false),
  signOut: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue('token'),
}));

vi.mock('./lib/store.js', () => ({
  getTopSenders: vi.fn().mockResolvedValue([]),
  getCleanupSuggestions: vi.fn().mockResolvedValue([]),
  getLastSyncedAt: vi.fn().mockResolvedValue(null),
  getIgnoredSenders: vi.fn().mockResolvedValue([]),
  ignoreSender: vi.fn().mockResolvedValue(undefined),
  unignoreSender: vi.fn().mockResolvedValue(undefined),
  markGone: vi.fn().mockResolvedValue(undefined),
  recordTrashedSenders: vi.fn().mockResolvedValue(undefined),
  clearAllData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./lib/sync.js', () => ({
  startSync: vi.fn(),
  pauseSync: vi.fn(),
  resumeSync: vi.fn(),
  resetSync: vi.fn(),
  getSyncSnapshot: vi.fn().mockReturnValue({ status: 'idle' }),
}));

vi.mock('./lib/gmailApi.js', () => ({
  trashMessages: vi.fn().mockResolvedValue(undefined),
}));

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
import App from './App.jsx';

function sender(overrides = {}) {
  return { email: 'a@example.com', name: null, messageCount: 1, totalSize: 100, ids: ['1'], latestMessage: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getStoredClientId.mockReturnValue('');
  isSignedIn.mockReturnValue(false);
  getSyncSnapshot.mockReturnValue({ status: 'idle' });
  getTopSenders.mockResolvedValue([]);
  getCleanupSuggestions.mockResolvedValue([]);
  getLastSyncedAt.mockResolvedValue(null);
  getIgnoredSenders.mockResolvedValue([]);
  getAccessToken.mockResolvedValue('token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('initial load', () => {
  it('refreshes senders and the ignored list on mount', async () => {
    getTopSenders.mockResolvedValue([sender({ email: 'a@example.com' })]);
    getIgnoredSenders.mockResolvedValue(['blocked@example.com']);

    render(<App />);

    await screen.findByText('a@example.com');
    expect(await screen.findByText('blocked@example.com')).toBeInTheDocument();
  });

  it('starts signed out when isSignedIn() is false', () => {
    render(<App />);
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
  });

  it('starts signed in when isSignedIn() is true', () => {
    isSignedIn.mockReturnValue(true);
    render(<App />);
    expect(screen.getByText('Signed in')).toBeInTheDocument();
  });
});

describe('Client ID', () => {
  it('mirrors input changes into auth.js via setCurrentClientId', async () => {
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Google OAuth Client ID'), 'x');
    expect(setCurrentClientId).toHaveBeenCalledWith('x');
  });

  it('pre-fills the input from auth.js\'s remembered Client ID on mount', () => {
    getStoredClientId.mockReturnValue('remembered-client-id');
    render(<App />);
    expect(screen.getByPlaceholderText('Google OAuth Client ID')).toHaveValue('remembered-client-id');
  });
});

describe('sign in / sign out', () => {
  it('signs in successfully', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Signed in')).toBeInTheDocument();
  });

  it('alerts on a failed sign-in and stays signed out', async () => {
    getAccessToken.mockRejectedValue(new Error('popup closed'));
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('popup closed'));
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
  });

  it('signs out', async () => {
    isSignedIn.mockReturnValue(true);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
  });
});

describe('sync controls', () => {
  it('starts a sync when Sync Now is clicked', async () => {
    isSignedIn.mockReturnValue(true);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Sync Now' }));
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(startSync).toHaveBeenCalledWith(expect.any(Function));
  });

  it('refreshes the sender grid every time the sync callback fires', async () => {
    isSignedIn.mockReturnValue(true);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Sync Now' }));

    const onUpdate = startSync.mock.calls[0][0];
    getTopSenders.mockResolvedValue([sender({ email: 'fresh@example.com' })]);
    getCleanupSuggestions.mockResolvedValue([sender({ email: 'suggestion@example.com', name: 'Suggested' })]);
    act(() => {
      onUpdate({ status: 'running', fetched: 1, total: 2, listedCount: 2, listingDone: false, error: null });
    });

    expect(await screen.findByText('Syncing... 1/2 synced (2 listed so far, still listing inbox)')).toBeInTheDocument();
    expect(await screen.findByText('fresh@example.com')).toBeInTheDocument();

    // Cleanup Suggestions was refreshed alongside All Senders, even though
    // the Cleanup Suggestions tab isn't the one currently visible.
    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));
    expect(screen.getByText('Suggested <suggestion@example.com>')).toBeInTheDocument();
  });

  it('pauses a running sync and immediately reflects the new snapshot', async () => {
    isSignedIn.mockReturnValue(true);
    getSyncSnapshot.mockReturnValue({ status: 'running', fetched: 1, total: 2, listedCount: 2, listingDone: false, error: null });
    render(<App />);
    await screen.findByRole('button', { name: 'Pause' });

    getSyncSnapshot.mockReturnValue({ status: 'paused', fetched: 1, total: 2, listedCount: 2, listingDone: false, error: null });
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));

    expect(pauseSync).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Paused at 1/2')).toBeInTheDocument();
  });

  it('resumes a paused sync', async () => {
    isSignedIn.mockReturnValue(true);
    getSyncSnapshot.mockReturnValue({ status: 'paused', fetched: 1, total: 2, listedCount: 2, listingDone: false, error: null });
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resumeSync).toHaveBeenCalledWith(expect.any(Function));
  });

  it('restarts an active sync', async () => {
    isSignedIn.mockReturnValue(true);
    getSyncSnapshot.mockReturnValue({ status: 'running', fetched: 1, total: 2, listedCount: 2, listingDone: false, error: null });
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(startSync).toHaveBeenCalledWith(expect.any(Function));
  });
});

describe('Clear Data', () => {
  it('does nothing when the confirmation is declined', async () => {
    window.confirm.mockReturnValue(false);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear Data' }));
    expect(resetSync).not.toHaveBeenCalled();
    expect(clearAllData).not.toHaveBeenCalled();
  });

  it('resets sync state and wipes data when confirmed', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear Data' }));
    expect(resetSync).toHaveBeenCalledTimes(1);
    expect(clearAllData).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getTopSenders).toHaveBeenCalled());
  });
});

describe('sender actions wired through to the lib layer', () => {
  it('trashes a sender: calls trashMessages, then markGone, then refreshes', async () => {
    getTopSenders.mockResolvedValue([sender({ email: 'spammy@example.com', messageCount: 3, ids: ['1', '2', '3'] })]);
    render(<App />);
    await screen.findByText('spammy@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));

    await waitFor(() => expect(trashMessages).toHaveBeenCalledWith(['1', '2', '3']));
    expect(markGone).toHaveBeenCalledWith(['1', '2', '3']);
    expect(recordTrashedSenders).toHaveBeenCalledWith(['spammy@example.com']);
  });

  it('trashes multiple selected senders: merges their ids into one trashMessages/markGone call', async () => {
    getTopSenders.mockResolvedValue([
      sender({ email: 'spammy@example.com', name: 'Spammy', messageCount: 3, ids: ['1', '2', '3'] }),
      sender({ email: 'other@example.com', name: 'Other', messageCount: 2, ids: ['4', '5'] }),
    ]);
    render(<App />);
    await screen.findByText('Spammy <spammy@example.com>');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Spammy' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Other' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move selected senders to Trash' }));

    await waitFor(() => expect(trashMessages).toHaveBeenCalledWith(['1', '2', '3', '4', '5']));
    expect(markGone).toHaveBeenCalledWith(['1', '2', '3', '4', '5']);
    expect(recordTrashedSenders).toHaveBeenCalledWith(['spammy@example.com', 'other@example.com']);
  });

  it('ignores a sender: calls ignoreSender then refreshes senders and the ignore list', async () => {
    getTopSenders.mockResolvedValue([sender({ email: 'spammy@example.com' })]);
    render(<App />);
    await screen.findByText('spammy@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Ignore' }));

    await waitFor(() => expect(ignoreSender).toHaveBeenCalledWith('spammy@example.com'));
    expect(getIgnoredSenders).toHaveBeenCalled();
  });

  it('unignores a sender: calls unignoreSender then refreshes', async () => {
    getIgnoredSenders.mockResolvedValue(['blocked@example.com']);
    render(<App />);
    await screen.findByText('blocked@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Unignore' }));

    await waitFor(() => expect(unignoreSender).toHaveBeenCalledWith('blocked@example.com'));
  });
});

describe('Cleanup Suggestions', () => {
  it('fetches suggestions with the default threshold (2 years) on mount', async () => {
    render(<App />);
    await waitFor(() => expect(getCleanupSuggestions).toHaveBeenCalledWith(2));
  });

  it('pre-fills the threshold input from localStorage', async () => {
    localStorage.setItem('gmailCleaner.cleanupThresholdYears', '5');
    render(<App />);
    await waitFor(() => expect(getCleanupSuggestions).toHaveBeenCalledWith(5));
  });

  it('falls back to the default threshold when the stored value is malformed', async () => {
    localStorage.setItem('gmailCleaner.cleanupThresholdYears', 'not a number');
    render(<App />);
    await waitFor(() => expect(getCleanupSuggestions).toHaveBeenCalledWith(2));
  });

  it('changing the threshold input re-queries getCleanupSuggestions and updates the rendered list', async () => {
    render(<App />);
    await screen.findByRole('tab', { name: 'Cleanup Suggestions' });
    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));

    getCleanupSuggestions.mockResolvedValue([sender({ email: 'newly-suggested@example.com', name: 'Newly Suggested' })]);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Inactive threshold in years' }), { target: { value: '3' } });

    await waitFor(() => expect(getCleanupSuggestions).toHaveBeenCalledWith(3));
    expect(await screen.findByText('Newly Suggested <newly-suggested@example.com>')).toBeInTheDocument();
  });

  it('discards a stale threshold-driven refresh that resolves after a later one', async () => {
    render(<App />);
    await screen.findByRole('tab', { name: 'Cleanup Suggestions' });
    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup Suggestions' }));

    let resolveFirst;
    getCleanupSuggestions.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    const input = screen.getByRole('spinbutton', { name: 'Inactive threshold in years' });
    fireEvent.change(input, { target: { value: '3' } }); // slow call, still pending

    getCleanupSuggestions.mockResolvedValueOnce([sender({ email: 'second@example.com' })]);
    fireEvent.change(input, { target: { value: '4' } }); // second, faster call supersedes it
    expect(await screen.findByText('second@example.com')).toBeInTheDocument();

    // Resolving the stale first call afterward must not clobber the newer result.
    resolveFirst([sender({ email: 'stale@example.com' })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('stale@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('second@example.com')).toBeInTheDocument();
  });
});

describe('stale refresh guard', () => {
  it('discards an earlier refreshSenders() call that resolves after a later one', async () => {
    isSignedIn.mockReturnValue(true);
    let resolveFirst;
    getTopSenders
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce([sender({ email: 'second@example.com' })]);

    render(<App />);
    // Mount's own refreshAll() call is the "first" (slow) one; trigger a
    // second refresh via a sync update before it resolves.
    await userEvent.click(screen.getByRole('button', { name: 'Sync Now' }));
    const onUpdate = startSync.mock.calls[0][0];
    await act(async () => {
      onUpdate({ status: 'running', fetched: 0, total: 0, listedCount: 0, listingDone: false, error: null });
    });

    expect(await screen.findByText('second@example.com')).toBeInTheDocument();

    // Resolving the stale first call afterward must not clobber the newer result.
    resolveFirst([sender({ email: 'stale@example.com' })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('stale@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('second@example.com')).toBeInTheDocument();
  });
});
