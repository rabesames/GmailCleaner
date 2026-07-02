import { useState } from 'react';

export default function IgnoredSendersList({ emails, onUnignore }) {
  if (emails.length === 0) return null;
  const sorted = [...emails].sort();

  return (
    <section id="ignoredSection">
      <h2>Ignored senders</h2>
      <ul id="ignoredList">
        {sorted.map((email) => (
          <IgnoredSenderItem key={email} email={email} onUnignore={onUnignore} />
        ))}
      </ul>
    </section>
  );
}

function IgnoredSenderItem({ email, onUnignore }) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    try {
      await onUnignore(email);
      // On success this item unmounts as part of the parent list shrinking.
    } catch (err) {
      alert(err.message);
      setBusy(false);
    }
  };

  return (
    <li>
      <span>{email}</span>
      <button className="secondary" disabled={busy} onClick={handleClick}>
        Unignore
      </button>
    </li>
  );
}
