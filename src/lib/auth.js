// Google sign-in via Google Identity Services' token-client (implicit) flow.
// The access token is the only credential involved; it's short-lived (~1hr),
// scoped to gmail.modify, and kept only in sessionStorage -- cleared the
// moment this tab closes. There is no refresh token and nothing server-side.
//
// The OAuth Client ID itself is never written to sessionStorage/localStorage
// -- only the resulting access token is cached, same treatment as the old
// IMAP password. `setCurrentClientId` is called by the React input's
// onChange handler to keep this module's copy in sync with the controlled
// input's value; this module never reads the DOM directly.
const AUTH_STORAGE_KEY = 'gmailCleaner.auth';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

let currentClientId = '';
let tokenClient = null;
let tokenClientId = null;
let pendingTokenRequests = [];

export function setCurrentClientId(clientId) {
  currentClientId = clientId;
}

function ensureTokenClient() {
  if (!currentClientId) throw new Error('Enter your Google OAuth Client ID first');
  if (tokenClient && tokenClientId === currentClientId) return tokenClient;
  tokenClientId = currentClientId;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: currentClientId,
    scope: GMAIL_SCOPE,
    callback: (response) => {
      const waiters = pendingTokenRequests;
      pendingTokenRequests = [];
      if (response.error) {
        waiters.forEach(({ reject }) => reject(new Error(response.error_description || response.error)));
        return;
      }
      storeToken(response.access_token, response.expires_in);
      waiters.forEach(({ resolve }) => resolve(response.access_token));
    },
  });
  return tokenClient;
}

function storeToken(accessToken, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ accessToken, expiresAt }));
}

function getStoredToken() {
  const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) return null;
  const { accessToken, expiresAt } = JSON.parse(raw);
  // Treat as expired a little early so an in-flight request doesn't fail on the wire.
  if (Date.now() > expiresAt - 30000) return null;
  return accessToken;
}

export function isSignedIn() {
  return Boolean(getStoredToken());
}

export function signOut() {
  const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  if (raw) {
    const { accessToken } = JSON.parse(raw);
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
}

// Called by gmailApi.js on a 401 so the next getAccessToken() re-authenticates.
export function invalidateStoredToken() {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

// Must be called from a user-gesture handler (click) -- browsers block
// programmatic popups otherwise.
function requestAccessToken() {
  const client = ensureTokenClient();
  return new Promise((resolve, reject) => {
    pendingTokenRequests.push({ resolve, reject });
    client.requestAccessToken({ prompt: '' });
  });
}

export async function getAccessToken() {
  const cached = getStoredToken();
  if (cached) return cached;
  return requestAccessToken();
}
