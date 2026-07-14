import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IgnoredSendersList from './IgnoredSendersList.jsx';

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('IgnoredSendersList', () => {
  it('renders nothing when there are no ignored senders', () => {
    const { container } = render(<IgnoredSendersList emails={[]} onUnignore={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders emails sorted alphabetically regardless of input order', () => {
    render(<IgnoredSendersList emails={['zeta@example.com', 'alpha@example.com']} onUnignore={vi.fn()} />);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('alpha@example.com');
    expect(items[1]).toContain('zeta@example.com');
  });

  it('calls onUnignore with the email and disables the button immediately', async () => {
    let resolveUnignore;
    const onUnignore = vi.fn(() => new Promise((resolve) => (resolveUnignore = resolve)));
    render(<IgnoredSendersList emails={['a@example.com']} onUnignore={onUnignore} />);

    const button = screen.getByRole('button', { name: 'Unignore' });
    await userEvent.click(button);

    expect(onUnignore).toHaveBeenCalledWith('a@example.com');
    expect(button).toBeDisabled();

    resolveUnignore();
    await waitFor(() => expect(button).toBeDisabled()); // stays disabled -- success unmounts the row in the real app
  });

  it('alerts and re-enables the button when onUnignore fails', async () => {
    const onUnignore = vi.fn().mockRejectedValue(new Error('could not unignore'));
    render(<IgnoredSendersList emails={['a@example.com']} onUnignore={onUnignore} />);

    await userEvent.click(screen.getByRole('button', { name: 'Unignore' }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('could not unignore'));
    expect(screen.getByRole('button', { name: 'Unignore' })).toBeEnabled();
  });
});

describe('pagination', () => {
  function manyEmails(count) {
    return Array.from({ length: count }, (_, i) => `s${String(i).padStart(2, '0')}@example.com`);
  }

  it('shows only the first page by default (page size 10) and reports the right counts', () => {
    render(<IgnoredSendersList emails={manyEmails(25)} onUnignore={vi.fn()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('Showing 1-10 of 25 ignored senders')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });

  it('navigates to the next page', async () => {
    render(<IgnoredSendersList emails={manyEmails(25)} onUnignore={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('s10@example.com'),
      expect.stringContaining('s11@example.com'),
      expect.stringContaining('s12@example.com'),
      expect.stringContaining('s13@example.com'),
      expect.stringContaining('s14@example.com'),
      expect.stringContaining('s15@example.com'),
      expect.stringContaining('s16@example.com'),
      expect.stringContaining('s17@example.com'),
      expect.stringContaining('s18@example.com'),
      expect.stringContaining('s19@example.com'),
    ]);
  });

  it('changing the page size re-pages the list and resets to page 1', async () => {
    render(<IgnoredSendersList emails={manyEmails(25)} onUnignore={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.selectOptions(screen.getByRole('combobox'), '25');
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
  });

  it('clamps to the last page when unignoring shrinks the list out from under the current page', async () => {
    const { rerender } = render(<IgnoredSendersList emails={manyEmails(11)} onUnignore={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next' })); // page 2 of 2, showing the 11th item
    rerender(<IgnoredSendersList emails={manyEmails(10)} onUnignore={vi.fn()} />);
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });

  it('still shows the per-page control with both nav buttons disabled when everything fits on one page', () => {
    render(<IgnoredSendersList emails={['a@example.com']} onUnignore={vi.fn()} />);
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
