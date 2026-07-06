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
