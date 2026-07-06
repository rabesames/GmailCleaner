import { describe, it, expect, beforeEach, vi } from 'vitest';

// auth.js keeps module-level state (currentClientId, tokenClient,
// pendingTokenRequests) with no reset export, so each test gets a fresh
// module instance via resetModules + dynamic import rather than sharing
// state across tests.
async function loadAuth() {
  vi.resetModules();
  return import('./auth.js');
}

function installGoogleMock() {
  const requestAccessToken = vi.fn();
  const revoke = vi.fn((_token, cb) => cb());
  let capturedCallback;
  const initTokenClient = vi.fn((config) => {
    capturedCallback = config;
    return { requestAccessToken };
  });
  window.google = { accounts: { oauth2: { initTokenClient, revoke } } };
  return {
    initTokenClient,
    revoke,
    requestAccessToken,
    getCallback: () => capturedCallback.callback,
    getLastConfig: () => capturedCallback,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  delete window.google;
});

describe('isSignedIn / stored token expiry', () => {
  it('is false with nothing stored', async () => {
    const auth = await loadAuth();
    expect(auth.isSignedIn()).toBe(false);
  });

  it('is true for a token that has not expired', async () => {
    const auth = await loadAuth();
    sessionStorage.setItem('gmailCleaner.auth', JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() + 60000 }));
    expect(auth.isSignedIn()).toBe(true);
  });

  it('is false once within the 30s pre-expiry buffer', async () => {
    const auth = await loadAuth();
    sessionStorage.setItem('gmailCleaner.auth', JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() + 1000 }));
    expect(auth.isSignedIn()).toBe(false);
  });

  it('is false for an already-expired token', async () => {
    const auth = await loadAuth();
    sessionStorage.setItem('gmailCleaner.auth', JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() - 1000 }));
    expect(auth.isSignedIn()).toBe(false);
  });
});

describe('getAccessToken', () => {
  it('returns the cached token without touching Google APIs', async () => {
    const auth = await loadAuth();
    sessionStorage.setItem('gmailCleaner.auth', JSON.stringify({ accessToken: 'cached-tok', expiresAt: Date.now() + 60000 }));
    await expect(auth.getAccessToken()).resolves.toBe('cached-tok');
  });

  it('rejects when no Client ID has been set', async () => {
    const auth = await loadAuth();
    await expect(auth.getAccessToken()).rejects.toThrow('Enter your Google OAuth Client ID first');
  });

  it('initializes a token client and resolves with the token from a successful callback', async () => {
    const google = installGoogleMock();
    const auth = await loadAuth();
    auth.setCurrentClientId('client-123');

    const promise = auth.getAccessToken();
    expect(google.initTokenClient).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'client-123', scope: 'https://www.googleapis.com/auth/gmail.modify' })
    );
    expect(google.requestAccessToken).toHaveBeenCalledWith({ prompt: '' });

    google.getCallback()({ access_token: 'fresh-tok', expires_in: 3600 });
    await expect(promise).resolves.toBe('fresh-tok');

    const stored = JSON.parse(sessionStorage.getItem('gmailCleaner.auth'));
    expect(stored.accessToken).toBe('fresh-tok');
  });

  it('rejects with the error_description when the callback reports an error', async () => {
    const google = installGoogleMock();
    const auth = await loadAuth();
    auth.setCurrentClientId('client-123');

    const promise = auth.getAccessToken();
    google.getCallback()({ error: 'access_denied', error_description: 'user declined' });
    await expect(promise).rejects.toThrow('user declined');
  });

  it('rejects with the bare error code when no error_description is given', async () => {
    const google = installGoogleMock();
    const auth = await loadAuth();
    auth.setCurrentClientId('client-123');

    const promise = auth.getAccessToken();
    google.getCallback()({ error: 'access_denied' });
    await expect(promise).rejects.toThrow('access_denied');
  });

  it('batches concurrent requests onto a single callback invocation', async () => {
    const google = installGoogleMock();
    const auth = await loadAuth();
    auth.setCurrentClientId('client-123');

    const first = auth.getAccessToken();
    const second = auth.getAccessToken();
    expect(google.requestAccessToken).toHaveBeenCalledTimes(2);

    google.getCallback()({ access_token: 'shared-tok', expires_in: 3600 });
    await expect(first).resolves.toBe('shared-tok');
    await expect(second).resolves.toBe('shared-tok');
  });

  it('reuses the same token client when the Client ID has not changed', async () => {
    const google = installGoogleMock();
    const auth = await loadAuth();
    auth.setCurrentClientId('client-123');

    const first = auth.getAccessToken();
    google.getCallback()({ access_token: 'tok-1', expires_in: -10 }); // already expired
    await first;

    auth.getAccessToken();
    expect(google.initTokenClient).toHaveBeenCalledTimes(1);
  });

  it('re-initializes the token client when the Client ID changes', async () => {
    const google = installGoogleMock();
    const auth = await loadAuth();
    auth.setCurrentClientId('client-123');

    const first = auth.getAccessToken();
    google.getCallback()({ access_token: 'tok-1', expires_in: -10 });
    await first;

    auth.setCurrentClientId('client-456');
    auth.getAccessToken();
    expect(google.initTokenClient).toHaveBeenCalledTimes(2);
    expect(google.initTokenClient).toHaveBeenLastCalledWith(expect.objectContaining({ client_id: 'client-456' }));
  });
});

describe('signOut', () => {
  it('is a no-op when nothing is stored', async () => {
    const google = installGoogleMock();
    const auth = await loadAuth();
    auth.signOut();
    expect(google.revoke).not.toHaveBeenCalled();
  });

  it('clears storage and revokes the token when one is stored', async () => {
    const google = installGoogleMock();
    const auth = await loadAuth();
    sessionStorage.setItem('gmailCleaner.auth', JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() + 60000 }));

    auth.signOut();

    expect(sessionStorage.getItem('gmailCleaner.auth')).toBeNull();
    expect(google.revoke).toHaveBeenCalledWith('tok', expect.any(Function));
  });
});

describe('invalidateStoredToken', () => {
  it('removes the stored token', async () => {
    const auth = await loadAuth();
    sessionStorage.setItem('gmailCleaner.auth', JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() + 60000 }));
    auth.invalidateStoredToken();
    expect(auth.isSignedIn()).toBe(false);
  });
});
