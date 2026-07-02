export default function AuthControls({ clientId, onClientIdChange, signedIn, onSignIn, onSignOut }) {
  return (
    <div className="toolbar">
      <input
        id="googleClientId"
        type="text"
        placeholder="Google OAuth Client ID"
        autoComplete="off"
        spellCheck="false"
        value={clientId}
        onChange={(event) => onClientIdChange(event.target.value)}
      />
      {signedIn ? (
        <button className="secondary" onClick={onSignOut}>
          Sign out
        </button>
      ) : (
        <button onClick={onSignIn}>Sign in with Google</button>
      )}
      <span className="muted">{signedIn ? 'Signed in' : 'Not signed in'}</span>
    </div>
  );
}
