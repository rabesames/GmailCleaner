# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A client-side-only React SPA (no backend) that talks to the Gmail REST
API directly from the browser, ranks senders by total email size, and
moves a sender's messages to Trash on request. Message data lives in
this browser's IndexedDB and persists across sessions; the OAuth Client
ID is cached in `localStorage` and the access token lives in
`sessionStorage` (see Credential handling below). See `README.md` for
one-time Google Cloud OAuth setup and behavioral notes/limits.

## Commands

```bash
npm install
npm start           # Vite dev server (HMR) at http://localhost:5500
npm run build       # production build to dist/
npm run preview     # serve dist/ at http://localhost:5500
```

There is no test suite. `npm run build` is the fastest way to catch
JSX/import mistakes without a browser (Rollup fails loudly on those);
beyond that, most of what can go wrong here (OAuth config, Gmail API
errors, IndexedDB behavior) only surfaces at runtime in a real browser
devtools console/network tab, not via any static check.

## Why this shape

The original version of this app ran IMAP against Gmail from a Node
server. It was rebuilt as pure client-side because that's the only way
to get a genuinely serverless app: browsers have no raw TCP/TLS socket
API, so a page cannot speak IMAP or POP3 to `imap.gmail.com` directly —
there is no workaround for that short of a server acting as a protocol
bridge, which would defeat the point. The Gmail REST API is plain
HTTPS/JSON with CORS enabled for browser use, which is what makes a
zero-backend design possible at all. The Vite build step introduced for
React doesn't change that: `npm run build` produces a plain static
`dist/` folder, and OAuth's requirement for an `http(s)` origin (not
`file://`) is the only reason a dev/preview server is needed at all —
see the README section "Why there's a build step now."

The port is pinned to 5500 in `vite.config.js` (`server.port` /
`preview.port`), not Vite's default 5173, so it matches whatever origin
you've already registered as an Authorized JavaScript origin in Google
Cloud Console. If you ever change it, update both the config and the
Google Cloud Console client.

## Architecture

`src/lib/*.js` holds all the business logic as framework-agnostic ES
modules (no React imports) — this is a deliberate boundary: the
resumable sync state machine and IndexedDB access were carried over
near-verbatim from the app's pre-React vanilla-JS version, and keeping
them free of React APIs means they're easy to reason about (and test in
isolation, if that's ever added) independently of rendering concerns.
`src/components/*.jsx` and `src/App.jsx` are the only files that import
React; they call into `src/lib/` and translate its callback/Promise
style into `useState`.

**`src/lib/`** (unchanged in *behavior* from the pre-React version — see
git history / prior CLAUDE.md revisions for the original design
rationale of each; only the module boundaries changed):
1. **`auth.js`** — Google Identity Services' token-client (implicit)
   flow via `google.accounts.oauth2.initTokenClient` (referenced as
   `window.google`, provided by the `<script>` tag in `index.html`, not
   an npm package). Requests the `gmail.modify` scope.
   `setCurrentClientId(value)` is exported specifically so
   `AuthControls`'s controlled `<input>` can push its value into this
   module on every keystroke — the module keeps its own
   `currentClientId` variable rather than reading a DOM element (there's
   no DOM element to read in the React version). It's a write-through
   cache: every call also mirrors the value into `localStorage` (key
   `gmailCleaner.clientId`), and the module initializes `currentClientId`
   from that same key at load time — `getStoredClientId()` is what
   `App.jsx` calls for the input's initial React state, so a Client ID
   entered once is pre-filled on the next visit. `ensureTokenClient()`
   only re-initializes the underlying `google.accounts.oauth2` client
   when that value actually changes. `getAccessToken()` returns a cached
   *token* from `sessionStorage` if still valid (the token, unlike the
   Client ID, is short-lived and revocable, hence the shorter-lived
   storage), otherwise calls `requestAccessToken()` —
   which must run from a user-gesture handler (a click), since browsers
   block programmatic popups otherwise. There is no refresh token; when
   the ~1hr access token expires the user just signs in again.
2. **`gmailApi.js`** — thin, stateless wrapper over
   `gmail.googleapis.com`: `listInboxMessagePages` is an async generator
   that `yield`s one `messages.list` page (up to 500 ids) at a time
   instead of paging through the whole mailbox and returning one final
   array — that's what lets `sync.js` interleave fetching with listing;
   `getMessageMetadata` fetches one message's `messages.get?format=metadata`
   (sender/subject/date/size/snippet); `trashMessages` calls
   `messages.batchModify` (chunked at 1000 ids, the API's per-call cap).
   `withRetry` backs off on HTTP 429. `gmailFetch`'s success path reads
   the response as text and only `JSON.parse`s it if non-empty —
   `messages.batchModify` returns an empty body on success, and
   `res.json()` on empty text throws `Unexpected end of JSON input` even
   though the request succeeded. This file has no notion of a
   multi-message "job" — that's `sync.js`'s job, so pause/resume/restart
   has somewhere to hook in.
3. **`store.js`** — the entire data layer, backed by IndexedDB (the
   `gmailCleaner` database, version 2: a `messages` object store keyed by
   message id, a `meta` store for `lastSyncedAt`, and an `ignoredSenders`
   store keyed by email) rather than sessionStorage — deliberately, so
   data survives tab closes/restarts and isn't capped at sessionStorage's
   ~5-10MB. Every exported function here is `async`/returns a Promise —
   callers in `sync.js`/`App.jsx` all `await` them. `markGone` does a
   read-modify-write per id (`store.get` then `store.put`) since
   IndexedDB has no partial-update operation. `deleted: true` is the
   soft-delete marker used for both already-trashed and no-longer-in-INBOX
   messages. `getTopSenders` groups/sums in JS over a full `getAll()` scan
   on every call (cheap at personal-mailbox scale, no maintained index),
   skips any sender in `getIgnoredSenders()` up front (rather than
   filtering the finished list after building it — cheaper, and it means
   an ignored sender's rows never even get a `latestMessage`/`ids`
   computed), and also tracks each sender's `latestMessage` (by parsed
   `Date` header) for the hover-preview feature. `clearAllData` (backing
   the "Clear Data" button) only `.clear()`s the `messages` and `meta`
   stores — it deliberately leaves `ignoredSenders` alone, since ignoring
   a sender is a standing preference, not sync progress; wiping it on
   every reset would make an ignored sender reappear on the very next
   sync. Also owns RFC 2047 decoding (`decodeMimeWords`): the Gmail API
   returns raw header text, encoded words and all, it does not decode
   them server-side.
4. **`sync.js`** — the resumable sync job controller (pause / resume /
   restart / real-time progress). A single module-level `job` object is
   the whole mechanism: starting a new sync (`startSync`, used by both
   "Sync Now" and "Restart") creates a new job object and reassigns the
   module-level `job` binding; any loop left over from a superseded job
   notices `job !== myJob` and silently drops its result instead of
   writing it, rather than trying to cancel in-flight `fetch()` calls
   (there's no clean way to do that here). Every single processed message
   calls `onUpdate` (passed in by whoever started the sync — in the React
   app, `App.jsx`'s `handleSyncUpdate`, which calls `setSyncSnapshot` and
   re-triggers a senders refresh), which is what makes the grid update in
   real time rather than only at the end of a sync. Since `store.js`
   calls are async, every `job !== myJob` staleness check is re-verified
   *after* each `await` on a storage call too, not just around the
   network fetch — a restart can land while a `store.put`/`getAll` is in
   flight, and without those extra checks a superseded job's write could
   land after the new job already started reading.

   Listing and fetching are a **producer/consumer pipeline**, running
   concurrently rather than in alternating turns: `listingLoop` keeps
   paging `gmailApi.js`'s `listInboxMessagePages()` async generator and
   pushing newly-seen ids onto `myJob.queue`, while a fixed pool of
   `METADATA_FETCH_CONCURRENCY` `fetchWorker`s drains that queue as fast
   as quota allows — listing page 4 can be in flight while a worker is
   still fetching metadata for something found on page 1. `runJob` is
   what launches both sides together via `Promise.all` and is called by
   both `startSync` and `resumeSync` (pausing stops every loop below it,
   so resuming has to relaunch the whole pipeline, not just the workers).
   An idle `fetchWorker` (queue momentarily empty but listing not done)
   polls every `IDLE_POLL_MS` (150ms) rather than waiting on an explicit
   wake-up signal — deliberately simple: an event-based signal would need
   its own cleanup path for a worker left waiting when a job gets
   superseded mid-wait, whereas a poll loop just re-checks `job !== myJob`
   on its own next tick and exits cleanly either way. `pauseSync` just
   flips `job.status`; both `listingLoop` and every `fetchWorker` check it
   at the top of their loop and exit (leaving `myJob.queue` and the
   listing generator's internal `pageToken` closure intact), so
   `resumeSync`'s call into `runJob` picks up exactly where it left off —
   including mid-page for the listing side. One consequence of listing
   and fetching happening concurrently: `total` (the denominator shown in
   the UI) grows as more pages are listed rather than being known
   upfront, since new ids are only discovered one page at a time —
   `listingDone` in the snapshot tells the UI whether that number is
   still likely to grow, and there's no separate "listing" vs "fetching"
   phase to show in status text anymore since both are always happening
   at once while `status === 'running'`. `resetSync()` (backing "Clear
   Data") just sets `job = null`, reusing the exact same staleness-check
   mechanism as a fresh `startSync()` supersession — every in-flight
   check already compares against the old job reference, which can never
   equal `null`, so no separate cancellation path was needed.

**`src/components/` and `src/App.jsx`**:
- **`App.jsx`** — the only component holding real application state
  (`clientId`, `signedIn`, `syncSnapshot`, `senders`, `lastSyncedAt`,
  `ignoredSenders`). `refreshSenders`/`refreshIgnored`/`refreshAll` wrap
  `store.js`'s reads with `setState`; `refreshSenders` guards against
  out-of-order resolution with a `refreshTokenRef` counter (a `useRef`
  incremented per call, discarding results from calls that were
  superseded before they resolved) — necessary because IndexedDB reads
  are async and `handleSyncUpdate` fires once per synced message without
  awaiting the refresh, so a slower/older read could otherwise resolve
  after a newer one and flash stale data. `refreshIgnored` is kept
  separate from `refreshSenders` (composed together only via
  `refreshAll`) so the ignored list isn't re-queried on every one of
  those rapid-fire sync ticks — it can't change mid-sync, so
  `handleSyncUpdate` calls `refreshSenders` alone. All the actual
  mutating operations (`handleTrash`, `handleIgnore`, `handleUnignore`,
  `handleClearData`) live here too, passed down as props — child
  components own *only* their local/presentational state (row-level
  `busy` flags, sort/filter state), never call `src/lib/` directly.
- **`AuthControls.jsx`** — Client ID input + sign in/out, purely
  presentational (controlled input, no local state).
- **`SyncControls.jsx`** — Sync Now/Pause/Resume/Restart/Clear Data
  buttons, status text, and the progress bar, all derived entirely from
  the `snapshot` prop (`App.jsx`'s `syncSnapshot` state, straight from
  `sync.js`'s `getSyncSnapshot()` shape) — no local state of its own.
  `SyncProgressBar` renders `fetched/total` as width%, shown only while
  `active` (running or paused); it's a plain nested-div pair rather than
  a native `<progress>` element specifically so the "still growing"
  striped/animated treatment (the `.growing` class, applied whenever
  `!snapshot.listingDone`) is simple flat CSS instead of vendor-prefixed
  `::-webkit-progress-bar`/`::-moz-progress-bar` pseudo-elements. That
  visual distinction matters here: since listing and fetching run
  concurrently (see `sync.js` below), `total` can still be climbing while
  the bar is drawn, so a solid fill would misleadingly imply the
  percentage shown is final when it might not be.
- **`SendersTable.jsx`** — owns column sort and filter state locally
  (see below) since neither needs to be known outside this component;
  computes the filtered+sorted list via `useMemo`. `SenderRow` (defined
  in the same file, not exported) owns a local `busy` flag per row for
  the Ignore/Trash buttons — set before calling the `onTrash`/`onIgnore`
  prop and *not* reset in the success path, since a successful
  trash/ignore removes that sender from the parent's list and unmounts
  the row; only the `catch` branch resets `busy`, since that's the only
  outcome where the row still exists afterward. The hover preview is a
  native `title` attribute (see Notes and limitations in the README for
  why); clicking the sender cell opens
  `https://mail.google.com/mail/u/0/#search/from:<email>` in a new tab.
- **`IgnoredSendersList.jsx`** — same per-item `busy`-flag pattern as
  `SenderRow`, for the same reason (a successful Unignore removes the
  item from the list).
- **`Pagination.jsx`** — purely presentational (page/pageSize/pageCount
  in, `onPageChange`/`onPageSizeChange` callbacks out); see Pagination
  below for why the paging state itself lives in each caller instead of
  here.

### Column sorting

`sortState = { column, direction }`, local `useState` in
`SendersTable.jsx`; three clicks on the same header cycle
`asc -> desc -> null` (the third state sets `column` to `null` too, not
just `direction`, so the *next* click on any header cleanly starts a new
`asc` sort rather than resuming stale column state). When `column` is
`null`, the `useMemo` falls back to `getTopSenders()`'s natural order,
which is already total-size descending — that's why "unsorted" and
"initial load" look identical; they're deliberately the same code path,
not two implementations of the same default.

### Column filtering

A second `<thead>` row (`tr.filters`, three plain `<input>`s, controlled
by a `filters` state object local to `SendersTable.jsx`) drives a
`useMemo`-computed filtered list, which then feeds the sort `useMemo`
(filter narrows, then sort orders what's left — order of the two hooks
matters). Parsing is deliberately permissive: an unparseable
Messages/Total Size value returns `null` from `parseMessagesFilter`/
`parseSizeFilter` and is treated as "no filter," not an error — there's
no inline validation UI, so silently ignoring garbage input is the only
non-surprising behavior available. `parseSizeFilter`'s regex accepts an
optional `b|kb|mb|gb` suffix (case-insensitive) and defaults to bytes
when omitted; it reuses the same 1024-based multipliers as `formatSize`.
`SendersTable` distinguishes "no data synced yet" from "filters matched
nothing" for the empty-state message — compare `senders.length` (the
prop, pre-filter) against `sortedSenders.length` (post-filter) rather
than only checking the final rendered count, or an active filter would
incorrectly show the "click Sync Now" message instead of "no senders
match."

### Pagination

`SendersTable.jsx` and `IgnoredSendersList.jsx` each keep their own local
`page`/`pageSize` state (same "state lives where it's used" pattern as
sort/filter above) and pass the current slice plus callbacks down to the
shared `Pagination.jsx`, which only renders controls and knows nothing
about senders or emails. Both callers derive `pageCount` and a *clamped*
`currentPage = Math.min(page, pageCount)` at render time rather than
syncing `page` back into range via an effect — `page` can legitimately
point past the end after a filter narrows the result set or the
underlying list shrinks (a trash/unignore, or a filter/page-size change),
and clamping at render is simpler than an effect that has to run before
the out-of-range page ever paints. Navigation (`onPageChange`) and
slicing both use `currentPage`, never the raw `page` state, so clicking
Next while clamped advances from where the user can actually see, not
from a stale page number. Filter/page-size changes explicitly call
`setPage(1)` in the same handler that changes the filter/size — that's a
UX choice (a new filter should start you back at the top of its
results), not something the clamp alone would do, since clamping only
kicks in when the current page falls *out* of range, not merely when it
changes. `SendersTable`'s "select all" checkbox is scoped to
`pagedSenders` (the current page), not the full filtered/sorted list —
selecting across pages would silently bulk-trash senders the user never
saw checked, so it follows the same per-page convention as Gmail's own
inbox.

## Gmail API quota (why the sync loop looks the way it does)

Per-user limit is 6,000 quota units/minute. `messages.get` costs 20
units → ~300 calls/minute (~5/sec) is the hard ceiling for metadata
fetches, `messages.list` costs 5, `messages.batchModify` costs 50
regardless of batch size (hence always batching trash actions instead of
calling `messages.trash` per id). `gmailApi.js`'s
`METADATA_FETCH_CONCURRENCY = 5` and backoff-on-429 retry (used by
`sync.js`'s worker pool) are tuned to this, not guessed — don't raise
concurrency without accounting for the per-minute cap, and don't remove
the retry logic, since large first-syncs are expected to occasionally
hit 429 by design rather than a bug.

## IndexedDB transaction lifetime (a real gotcha if you edit `store.js`)

`markGone`'s `await store.get(id)` immediately followed by `store.put(...)`
inside the same `readwrite` transaction works because both calls are
chained through microtasks only (`promisifyRequest`'s Promise resolution),
which modern browsers keep an IndexedDB transaction alive across. The
moment you `await` something that isn't wrapping an IndexedDB request —
a `fetch()`, a `setTimeout`, anything crossing a macrotask boundary —
inside a `withStore` callback, the transaction auto-commits early and
the next request on that transaction throws `TransactionInactiveError`.
If you need to mix in a network call, finish the IndexedDB work in its
own `withStore` call first.

## Credential handling

Two different things are commonly conflated here — keep them distinct:

- **OAuth Client ID**: cached in `localStorage` (`gmailCleaner.clientId`)
  since it's a public, non-secret identifier — remembering it across
  browser restarts is a convenience, not a security concern. Lives as
  React state in `App.jsx` (for the controlled `<input>`, initialized
  from `auth.js`'s `getStoredClientId()`) plus a mirrored copy in
  `auth.js`'s module-level `currentClientId` (kept in sync via
  `setCurrentClientId`, called from `AuthControls`'s `onChange`, which
  write-throughs to `localStorage` on every change).
- **OAuth access token**: cached in `sessionStorage` (`gmailCleaner.auth`)
  instead, since — unlike the Client ID — it's a live credential:
  short-lived (~1hr) and revocable, so tying it to the tab's session
  (cleared on tab close) rather than persisting it indefinitely limits
  how long a stale token could be replayed.
