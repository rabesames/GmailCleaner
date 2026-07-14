import { useState } from 'react';
import Pagination from './Pagination.jsx';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function IgnoredSendersList({ emails, onUnignore }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  if (emails.length === 0) return null;
  const sorted = [...emails].sort();

  // See SendersTable.jsx's identical comment: `currentPage` is the clamped
  // value actually used, so a shrinking list (an unignore) can't strand
  // `page` on a now-nonexistent page without a dedicated effect.
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const paged = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const handlePageSizeChange = (newPageSize) => {
    setPageSize(newPageSize);
    setPage(1);
  };

  return (
    <section id="ignoredSection">
      <h2>Ignored senders</h2>
      <ul id="ignoredList">
        {paged.map((email) => (
          <IgnoredSenderItem key={email} email={email} onUnignore={onUnignore} />
        ))}
      </ul>
      <Pagination
        page={currentPage}
        pageCount={pageCount}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        totalItems={sorted.length}
        onPageChange={setPage}
        onPageSizeChange={handlePageSizeChange}
        itemLabel="ignored senders"
      />
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
