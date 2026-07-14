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

`npm test` (Vitest) runs the test suite; `npx vitest run --coverage`
enforces this repo's 100%-statement/branch/function/line threshold on
every file except `src/lib/store.js`, which has one pre-existing,
practically-unreachable gap (`promisifyRequest`'s `onerror` callback —
IndexedDB reports request-level errors synchronously for every valid-input
call pattern this file's tests can drive, without reaching into
`fake-indexeddb` internals to force it). `npm run build` is the fastest
way to catch JSX/import mistakes without a browser (Rollup fails loudly
on those); beyond that, most of what can go wrong here (OAuth config,
Gmail API errors, IndexedDB behavior) only surfaces at runtime in a real
browser devtools console/network tab, not via any static check.

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
   `gmail.googleapis.com`: `listInboxMessagePages`/`listSentMessagePages`
   are both thin wrappers over a private `listMessagePages(labelId)` async
   generator (`labelIds=INBOX` / `labelIds=SENT`) that `yield`s one
   `messages.list` page (up to 500 ids) at a time instead of paging
   through the whole mailbox and returning one final array — that's what
   lets `sync.js` interleave fetching with listing, for both the inbox and
   Sent phases. `getMessageMetadata` fetches one message's
   `messages.get?format=metadata` (sender/subject/date/size/snippet, used
   by the inbox phase); `getMessageRecipients` fetches the same endpoint
   but for `To`/`Cc` only (used by the Sent-scan phase, same 20-unit quota
   cost as `getMessageMetadata` — same endpoint), returning raw header
   text rather than parsed addresses (address parsing stays `store.js`'s
   job, same division of responsibility as `getMessageMetadata`'s `from`).
   `trashMessages` calls `messages.batchModify` (chunked at 1000 ids, the
   API's per-call cap). `withRetry` backs off on HTTP 429. `gmailFetch`'s
   success path reads the response as text and only `JSON.parse`s it if
   non-empty — `messages.batchModify` returns an empty body on success,
   and `res.json()` on empty text throws `Unexpected end of JSON input`
   even though the request succeeded. This file has no notion of a
   multi-message "job" — that's `sync.js`'s job, so pause/resume/restart
   has somewhere to hook in. No new OAuth scope was needed for Sent access
   — `gmail.modify` already covers reading `SENT`-labeled mail.
3. **`store.js`** — the entire data layer, backed by IndexedDB (the
   `gmailCleaner` database, version 3: `messages` keyed by message id,
   `meta` for `lastSyncedAt`, `ignoredSenders` keyed by email, and three
   v3 additions — `contactedAddresses` (every address ever sent-TO/CC'd,
   keyed by email), `trashedSenders` (senders manually Move-to-Trash'd via
   this app, keyed by email), and `scannedSentIds` (Sent message ids
   already scanned, keyed by id) — all three added the same
   `if (!db.objectStoreNames.contains(...))` way as the original three)
   rather than sessionStorage — deliberately, so data survives tab
   closes/restarts and isn't capped at sessionStorage's ~5-10MB. Every
   exported function here is `async`/returns a Promise — callers in
   `sync.js`/`App.jsx` all `await` them. `markGone` does a read-modify-write
   per id (`store.get` then `store.put`) since IndexedDB has no
   partial-update operation. `deleted: true` is the soft-delete marker
   used for both already-trashed and no-longer-in-INBOX messages. The
   per-message grouping loop that was originally `getTopSenders`'s own
   body is now a private `aggregateBySender(messages, excludeEmails)`
   helper, shared with `getCleanupSuggestions` (see Cleanup Suggestions
   below) — a pure extraction, so `getTopSenders`'s own behavior/tests are
   unaffected. It groups/sums in JS over a full `getAll()` scan on every
   call (cheap at personal-mailbox scale, no maintained index), skips any
   excluded (ignored) sender up front (rather than filtering the finished
   list after building it — cheaper, and it means an ignored sender's rows
   never even get a `latestMessage`/`ids` computed), and also tracks each
   sender's `latestMessage` (by parsed `Date` header, kept internally as
   `latestTimestamp` too — reused by `getCleanupSuggestions`'s age
   comparison) for the hover-preview feature. `clearAllData` (backing the
   "Clear Data" button) only `.clear()`s the `messages` and `meta` stores
   — it deliberately leaves `ignoredSenders` *and* all three v3 stores
   alone, since all four are standing facts/preferences, not sync
   progress; wiping `contactedAddresses`/`scannedSentIds` in particular
   would force an expensive full Sent-folder rescan even though "did I
   ever email X" never goes stale once true. Also owns RFC 2047 decoding
   (`decodeMimeWords`): the Gmail API returns raw header text, encoded
   words and all, it does not decode them server-side.

   **`parseAddressListHeader(raw)`** parses a To/Cc header (which, unlike
   From, can carry several comma-separated addresses) into an array of
   lowercased emails. It's a quote-aware comma splitter (tracks whether
   it's inside a `"..."` display name so a literal comma there, e.g.
   `"Doe, Jane" <jane@x.com>, john@y.com`, doesn't cause a false split)
   feeding each resulting token through the existing single-address
   `parseFromHeader` rather than duplicating its angle-bracket/RFC-2047
   logic.

   **`getCleanupSuggestions(thresholdYears)`** is the query behind the
   Cleanup Suggestions tab — see that section below for the full
   criteria/rationale. It's always a subset of `getTopSenders()`'s result
   (same `aggregateBySender` call, same ignored-exclusion, just an
   additional filter), which the UI layer relies on (see Tabs and shared
   selection below).

   **Sent-scan bookkeeping**: `addContactedAddresses`/`getContactedAddresses`,
   `getScannedSentIds`, `recordTrashedSenders`/`getTrashedSenders` mirror
   the existing `ignoreSender`/`getIgnoredSenders` shape (bulk-write-only,
   like `upsertMessages` — no singular `recordTrashedSender`, and
   deliberately no "un-trash" function, since that judgment is meant to be
   permanent). `recordSentMessageRecipients({ id, to, cc })` (called once
   per fetched Sent message by `sync.js`'s Sent-phase worker) parses To+Cc
   via `parseAddressListHeader`, writes any new addresses, *then* marks the
   id scanned — in that order, so a job superseded between the two writes
   only risks a harmless re-scan of that id next time, never a silently
   lost "did I ever email X" fact.
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
   still fetching metadata for something found on page 1. `runInboxPipeline`
   is what launches both sides together via `Promise.all`. An idle
   `fetchWorker` (queue momentarily empty but listing not done) polls
   every `IDLE_POLL_MS` (150ms) rather than waiting on an explicit
   wake-up signal — deliberately simple: an event-based signal would need
   its own cleanup path for a worker left waiting when a job gets
   superseded mid-wait, whereas a poll loop just re-checks `job !== myJob`
   on its own next tick and exits cleanly either way. `pauseSync` just
   flips `job.status`; both `listingLoop` and every `fetchWorker` check it
   at the top of their loop and exit (leaving `myJob.queue` and the
   listing generator's internal `pageToken` closure intact), so resuming
   picks up exactly where it left off — including mid-page for the
   listing side. One consequence of listing and fetching happening
   concurrently: `total` (the denominator shown in the UI) grows as more
   pages are listed rather than being known upfront, since new ids are
   only discovered one page at a time — `listingDone` in the snapshot
   tells the UI whether that number is still likely to grow, and there's
   no separate "listing" vs "fetching" distinction to show in status text
   *within* a phase, since both are always happening at once while
   `status === 'running'`. `resetSync()` (backing "Clear Data") just sets
   `job = null`, reusing the exact same staleness-check mechanism as a
   fresh `startSync()` supersession — every in-flight check already
   compares against the old job reference, which can never equal `null`,
   so no separate cancellation path was needed.

   **Two sequential phases, not one.** A job runs `phase: 'inbox'` (as
   above) and then `phase: 'sent'` — an analogous producer/consumer
   pipeline (`sentListingLoop`/`sentFetchWorker`, mirroring
   `listingLoop`/`fetchWorker` exactly, including the same `job !== myJob`
   staleness checks after every `await`) that scans Sent mail to build the
   "addresses I've ever emailed" set behind Cleanup Suggestions (see
   `store.js`'s `recordSentMessageRecipients` above). `runJob`'s
   `if (myJob.phase === 'inbox') { ...; myJob.phase = 'sent'; }` block only
   executes once per job (the goneIds reconciliation inside it must not
   re-run on a Sent-phase resume), then falls through unconditionally into
   `runSentPipeline`. Unlike the inbox phase, Sent has no gone-id
   reconciliation to do — Sent mail only grows, and "did I ever email X"
   never becomes stale once true, so there's nothing to detect as removed.
   **The two phases never run concurrently with each other** — the Sent
   phase's worker pool isn't even started until the inbox phase's own
   `Promise.all` has resolved — which is what keeps this within Gmail's
   quota ceiling (see Gmail API quota below); running
   `METADATA_FETCH_CONCURRENCY` workers for *both* phases at once would
   double the effective `messages.get` rate. `getScannedSentIds()` is
   fetched once up front in `startSync` (alongside `getActiveIds()`, in
   the same `Promise.all`) exactly like `knownIds`, so a later
   pause/resume of the Sent phase never needs to re-derive it.
   `getSyncSnapshot()` reuses the same `total`/`fetched`/`listedCount`/
   `listingDone` field names for both phases (reading from the Sent-phase
   job fields once `job.phase === 'sent'`) rather than adding
   phase-prefixed fields — that's what lets `SyncControls.jsx`'s progress
   bar work unchanged for both phases; only its status text branches on
   the new `phase` field, and is written so `phase === undefined` (every
   snapshot from before this existed) falls through to the original
   inbox-only wording.

**`src/components/` and `src/App.jsx`**:
- **`App.jsx`** — the only component holding real application state
  (`clientId`, `signedIn`, `syncSnapshot`, `senders`, `cleanupSuggestions`,
  `cleanupThresholdYears`, `lastSyncedAt`, `ignoredSenders`).
  `refreshSenders`/`refreshIgnored`/`refreshAll` wrap `store.js`'s reads
  with `setState`; `refreshSenders` guards against out-of-order resolution
  with a `refreshTokenRef` counter (a `useRef` incremented per call,
  discarding results from calls that were superseded before they
  resolved) — necessary because IndexedDB reads are async and
  `handleSyncUpdate` fires once per synced message without awaiting the
  refresh, so a slower/older read could otherwise resolve after a newer
  one and flash stale data. `refreshSenders` now fetches both
  `getTopSenders()` and `getCleanupSuggestions(threshold)` in the same
  `Promise.all` under that one guard — it reads the current threshold via
  a `cleanupThresholdYearsRef` (kept in sync with `cleanupThresholdYears`
  state by its own small effect) rather than closing over the state value
  directly, since `refreshSenders` has an empty dependency array (it must
  stay referentially stable — `sync.js`'s `startSync`/`resumeSync` are
  handed `handleSyncUpdate`, which closes over it, mid-job) and a `useRef`
  is the standard way to let a stable callback read a "current" value.
  `handleThresholdYearsChange` (the years-input's `onChange` handler)
  deliberately does *not* go through that ref — it calls
  `getCleanupSuggestions(value)` directly with the new value so it can't
  race the ref's own sync effect (which wouldn't have flushed to the ref
  yet on the same tick), reusing the same `refreshTokenRef` guard so a
  slower stale call still can't clobber a faster newer one.
  `refreshIgnored` is kept separate from `refreshSenders` (composed
  together only via `refreshAll`) so the ignored list isn't re-queried on
  every one of those rapid-fire sync ticks — it can't change mid-sync, so
  `handleSyncUpdate` calls `refreshSenders` alone. All the actual
  mutating operations (`handleTrash`, `handleIgnore`, `handleUnignore`,
  `handleClearData`) live here too, passed down as props — child
  components own *only* their local/presentational state (row-level
  `busy` flags, sort/filter state), never call `src/lib/` directly.
  `handleTrash`/`handleTrashSelected` call `recordTrashedSenders` (see
  `store.js` above) *before* `markGone`/`refreshSenders`, so the "this
  sender was manually trashed" fact is durably written even if something
  later in that chain fails.
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
- **`SendersTable.jsx`** — reused for both the All Senders and Cleanup
  Suggestions tabs (see Tabs and shared selection below), so it's no
  longer senders-ranking-specific despite the name. Owns column sort and
  filter state locally (see below) since neither needs to be known
  outside this component; computes the filtered+sorted list via
  `useMemo`. Selection, by contrast, is a **controlled prop**
  (`selected: Set<string>`, `onToggleSelect(email)`,
  `onToggleSelectAll(visibleSenders)`) rather than local state — it lives
  in the parent (`SendersSection.jsx`) because two instances of this
  table share one selection Set and one "Move to Trash" toolbar (this is
  also why there's no `onTrashSelected` prop here anymore; the bulk-trash
  confirm/busy/error handling moved to `SendersSection.jsx` too).
  `storageKeyPrefix` (e.g. `'gmailCleaner.senders'` vs
  `'gmailCleaner.cleanupSuggestions'`) is what lets the two tab instances
  persist independent sort/filter choices without clobbering each other's
  `localStorage` keys — passing `'gmailCleaner.senders'` for the All
  Senders instance reproduces the exact keys this component used before
  it was split into two, so no prior user's persisted prefs are lost. An
  optional `noDataMessage` prop overrides the empty-state text shown when
  there's no data at all (as opposed to "filters matched nothing," which
  is always the same wording) — All Senders points it at the "Sign in..."
  copy, Cleanup Suggestions at "No cleanup suggestions right now."
  `SenderRow` (defined in the same file, not exported) owns a local
  `busy` flag per row for the Ignore/Trash buttons — set before calling
  the `onTrash`/`onIgnore` prop and *not* reset in the success path,
  since a successful trash/ignore removes that sender from the parent's
  list and unmounts the row; only the `catch` branch resets `busy`, since
  that's the only outcome where the row still exists afterward. The hover
  preview is a native `title` attribute (see Notes and limitations in the
  README for why); clicking the sender cell opens
  `https://mail.google.com/mail/u/0/#search/from:<email>` in a new tab.
- **`SendersSection.jsx`** — owns the shared `selected` Set + `bulkBusy` +
  the "Move to Trash" toolbar (moved here from `SendersTable.jsx`) and the
  All Senders / Cleanup Suggestions tab switcher (active tab persisted to
  `localStorage['gmailCleaner.sendersActiveTab']`). Only the active tab's
  `SendersTable` is mounted at a time (conditional render, not
  both-mounted-and-hidden) — losing the unpersisted `page` on tab switch
  is fine, since sort/filter reload from storage regardless. `selected`
  being a single Set keyed by email, shared across both tab instances, is
  what makes "one toolbar above two tabs" coherent instead of surprising:
  a sender checked while viewing one tab stays checked (and counted in
  the toolbar) if they also appear in the other. Resolving selected
  emails against `senders` (not `cleanupSuggestions`) is always
  sufficient for the bulk-trash call, since `getCleanupSuggestions()` is
  provably a subset of `getTopSenders()` (see `store.js` above). Also
  renders the Cleanup Suggestions tab's years-threshold `<input
  type="number">` (validated inline — non-finite or negative input is
  silently ignored rather than propagated, same "permissive, no error UI"
  philosophy as the column filters below).
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
`null`, the `useMemo` falls back to the `senders` prop's natural order,
which both `getTopSenders()` and `getCleanupSuggestions()` already return
as total-size descending — that's why "unsorted" and "initial load" look
identical; they're deliberately the same code path, not two
implementations of the same default, for either tab.

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

### Sort/filter persistence

`sortState` and `filters` are both remembered in `localStorage`, under
keys derived from the `storageKeyPrefix` prop (`gmailCleaner.sendersSort`
/ `gmailCleaner.sendersFilters` for the All Senders instance,
`gmailCleaner.cleanupSuggestionsSort` / `...Filters` for the Cleanup
Suggestions instance — the two tabs' choices are independent) — same
"public, non-secret, convenience only" treatment as the OAuth Client ID
in `auth.js` (see Credential handling), just scoped to UI preference
instead of a credential. `loadStoredSort`/`loadStoredFilters` are used as
the lazy `useState` initializer for each, and a `useEffect` per piece of
state writes it back out on every change. Both loaders are deliberately
permissive about bad input (missing key, malformed JSON, a sort column
that no longer exists) — `try/catch` around the `JSON.parse` plus a
shape check on the parsed value, falling back to the same defaults used
before persistence existed, rather than surfacing a parse error or
crashing the table. Page/pageSize are *not* persisted alongside them
(see Pagination below) — which page you were on stops being meaningful
as soon as the sender list changes shape after a fresh sync.

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
inbox. Since selection is now a controlled prop (see Tabs and shared
selection below), the header checkbox reports this scoping by calling
`onToggleSelectAll(pagedSenders)` rather than mutating any state itself.

### Cleanup Suggestions

The tab surfaces senders worth bulk-cleaning: people the user has never
emailed or replied to (not in `contactedAddresses`) whose most recent
message is older than a user-configurable number of years
(`cleanupThresholdYears`, `App.jsx` state, default 2, persisted to
`localStorage['gmailCleaner.cleanupThresholdYears']`), **or** anyone the
user has previously used "Move to Trash" on via this app before
(`trashedSenders`), regardless of how recently they've emailed —
`store.js`'s `getCleanupSuggestions(thresholdYears)` has the exact
filter/rationale. The years input is a plain controlled `<input
type="number">` in `SendersSection.jsx` rather than a permissive
raw-string-plus-parse layer like the column filters — the threshold is a
required, always-active value with a sane default rather than an
optional "narrow further" filter, so the simpler direct-`Number`-plus-
range-check validation is enough. Ignored senders are excluded from
Cleanup Suggestions too, same as All Senders (consistent "ignore =
invisible everywhere" semantics) — this falls out for free since both
tabs' data comes from the same `aggregateBySender` exclusion in
`store.js`.

### Tabs and shared selection

`SendersSection.jsx` renders a `role="tablist"` switcher between two
`SendersTable.jsx` instances (`storageKeyPrefix="gmailCleaner.senders"`
fed `senders`, `storageKeyPrefix="gmailCleaner.cleanupSuggestions"` fed
`cleanupSuggestions`) and owns the selection Set + "Move to Trash"
toolbar that sits above both. Only the active tab is mounted — switching
tabs doesn't lose sort/filter (both reload from their own `localStorage`
keys) but does lose the unpersisted current page, which is an accepted
tradeoff for the simplicity of not keeping both tab bodies alive at once.
Selection is keyed by email in a single shared `Set`, so a sender checked
on one tab stays checked (and counted in the toolbar) if the same email
also appears on the other — this is what makes one toolbar spanning two
tabs coherent rather than surprising, and it's safe specifically because
`getCleanupSuggestions()` is provably a subset of `getTopSenders()` (see
`store.js` above): resolving a selected email against `senders` alone
(never `cleanupSuggestions`) is always sufficient to find the sender
object needed for the bulk-trash call, no matter which tab the checkbox
was actually clicked on.

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
hit 429 by design rather than a bug. `getMessageRecipients` (the Sent
phase) costs the same 20 units as `getMessageMetadata` per call, so a
first-time sync's worst-case time roughly doubles now that it also scans
the entire Sent folder — this is deliberately paid once, though: the
Sent phase is incremental (`scannedSentIds`), so a mailbox that's already
been fully scanned only pays for genuinely new Sent messages on
subsequent syncs, same as the inbox phase already did for INBOX mail.

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
