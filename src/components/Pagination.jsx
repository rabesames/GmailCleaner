// Purely presentational -- page/pageSize state and the actual slicing live
// in whichever list is paginating (SendersTable, IgnoredSendersList), same
// pattern as those components' own local sort/filter state. Renders nothing
// when there's nothing to paginate, so callers can render it unconditionally.
export default function Pagination({
  page,
  pageCount,
  pageSize,
  pageSizeOptions,
  totalItems,
  onPageChange,
  onPageSizeChange,
  itemLabel,
}) {
  if (totalItems === 0) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <div className="pagination">
      <span className="muted">
        Showing {start}-{end} of {totalItems} {itemLabel}
      </span>
      <div className="pagination-controls">
        <label>
          Per page:
          <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </button>
        <span className="muted">
          Page {page} of {pageCount}
        </span>
        <button className="secondary" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
