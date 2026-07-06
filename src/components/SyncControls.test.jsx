import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SyncControls from './SyncControls.jsx';

const noop = { onSyncNow: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onRestart: vi.fn(), onClearData: vi.fn() };

describe('SyncControls: idle/done/error states', () => {
  it('shows a disabled Sync Now button when signed out and idle', () => {
    render(<SyncControls snapshot={{ status: 'idle' }} signedIn={false} lastSyncedAt={null} {...noop} />);
    expect(screen.getByRole('button', { name: 'Sync Now' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('Last synced: never')).toBeInTheDocument();
  });

  it('enables Sync Now when signed in', () => {
    render(<SyncControls snapshot={{ status: 'idle' }} signedIn lastSyncedAt={null} {...noop} />);
    expect(screen.getByRole('button', { name: 'Sync Now' })).toBeEnabled();
  });

  it('formats a non-null lastSyncedAt', () => {
    render(<SyncControls snapshot={{ status: 'idle' }} signedIn lastSyncedAt="2026-01-01T00:00:00.000Z" {...noop} />);
    expect(screen.getByText(/Last synced: (?!never)/)).toBeInTheDocument();
  });

  it('shows the error message and re-enables Sync Now on error', () => {
    render(<SyncControls snapshot={{ status: 'error', error: 'boom' }} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.getByText('Sync error: boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync Now' })).toBeInTheDocument();
  });

  it('calls onSyncNow when clicked', async () => {
    render(<SyncControls snapshot={{ status: 'idle' }} signedIn lastSyncedAt={null} {...noop} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sync Now' }));
    expect(noop.onSyncNow).toHaveBeenCalledTimes(1);
  });

  it('calls onClearData when clicked, in any state', async () => {
    render(<SyncControls snapshot={{ status: 'idle' }} signedIn lastSyncedAt={null} {...noop} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear Data' }));
    expect(noop.onClearData).toHaveBeenCalledTimes(1);
  });
});

describe('SyncControls: running state', () => {
  const runningSnapshot = { status: 'running', fetched: 3, total: 10, listedCount: 20, listingDone: false, error: null };

  it('shows Pause and Restart but not Sync Now or Resume', () => {
    render(<SyncControls snapshot={runningSnapshot} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.queryByRole('button', { name: 'Sync Now' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('shows the "still listing" note while listing is not done', () => {
    render(<SyncControls snapshot={runningSnapshot} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.getByText('Syncing... 3/10 synced (20 listed so far, still listing inbox)')).toBeInTheDocument();
  });

  it('omits the "still listing" note once listing is done', () => {
    render(<SyncControls snapshot={{ ...runningSnapshot, listingDone: true }} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.getByText('Syncing... 3/10 synced')).toBeInTheDocument();
  });

  it('renders a growing progress bar while total > 0 and listing is not done', () => {
    render(<SyncControls snapshot={runningSnapshot} signedIn {...noop} lastSyncedAt={null} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
    expect(bar.firstChild).toHaveClass('growing');
    expect(bar.firstChild.style.width).toBe('30%');
  });

  it('renders a solid (non-growing) progress bar once listing is done', () => {
    render(<SyncControls snapshot={{ ...runningSnapshot, listingDone: true }} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.getByRole('progressbar').firstChild).not.toHaveClass('growing');
  });

  it('renders no progress bar when nothing has been found yet (total === 0)', () => {
    render(<SyncControls snapshot={{ ...runningSnapshot, total: 0, fetched: 0 }} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('caps the displayed percentage at 100', () => {
    // fetched could momentarily exceed a just-updated total in principle; make sure the bar never overflows past 100%.
    render(<SyncControls snapshot={{ ...runningSnapshot, fetched: 999, total: 10 }} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.getByRole('progressbar').firstChild.style.width).toBe('100%');
  });

  it('calls onPause and onRestart when clicked', async () => {
    render(<SyncControls snapshot={runningSnapshot} signedIn {...noop} lastSyncedAt={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(noop.onPause).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(noop.onRestart).toHaveBeenCalledTimes(1);
  });
});

describe('SyncControls: paused state', () => {
  const pausedSnapshot = { status: 'paused', fetched: 4, total: 10, listedCount: 10, listingDone: true, error: null };

  it('shows Resume and Restart but not Sync Now or Pause', () => {
    render(<SyncControls snapshot={pausedSnapshot} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.queryByRole('button', { name: 'Sync Now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
  });

  it('shows the paused status text and still renders the progress bar', () => {
    render(<SyncControls snapshot={pausedSnapshot} signedIn {...noop} lastSyncedAt={null} />);
    expect(screen.getByText('Paused at 4/10')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('calls onResume when clicked', async () => {
    render(<SyncControls snapshot={pausedSnapshot} signedIn {...noop} lastSyncedAt={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(noop.onResume).toHaveBeenCalledTimes(1);
  });
});
