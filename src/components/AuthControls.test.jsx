import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthControls from './AuthControls.jsx';

describe('AuthControls', () => {
  it('shows Sign in and "Not signed in" when signed out', () => {
    render(<AuthControls clientId="" onClientIdChange={vi.fn()} signedIn={false} onSignIn={vi.fn()} onSignOut={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
  });

  it('shows Sign out and "Signed in" when signed in', () => {
    render(<AuthControls clientId="" onClientIdChange={vi.fn()} signedIn onSignIn={vi.fn()} onSignOut={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).not.toBeInTheDocument();
    expect(screen.getByText('Signed in')).toBeInTheDocument();
  });

  it('calls onSignIn when the sign-in button is clicked', async () => {
    const onSignIn = vi.fn();
    render(<AuthControls clientId="" onClientIdChange={vi.fn()} signedIn={false} onSignIn={onSignIn} onSignOut={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('calls onSignOut when the sign-out button is clicked', async () => {
    const onSignOut = vi.fn();
    render(<AuthControls clientId="" onClientIdChange={vi.fn()} signedIn onSignIn={vi.fn()} onSignOut={onSignOut} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('reflects the clientId prop and reports changes', async () => {
    const onClientIdChange = vi.fn();
    render(<AuthControls clientId="abc" onClientIdChange={onClientIdChange} signedIn={false} onSignIn={vi.fn()} onSignOut={vi.fn()} />);
    const input = screen.getByPlaceholderText('Google OAuth Client ID');
    expect(input).toHaveValue('abc');

    await userEvent.type(input, 'X');
    expect(onClientIdChange).toHaveBeenCalled();
  });
});
