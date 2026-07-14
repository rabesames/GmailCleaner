# Product Requirements Document: Gmail Cleaner

## 1. Overview

Gmail Cleaner is a client-side-only web application that helps a user
identify which senders are consuming the most space in their Gmail
inbox, and lets them move that sender's mail to Trash in one action. It
runs entirely as a static React single-page application in the user's
browser: there is no backend server, and all Gmail access happens
directly from the browser to Google's Gmail REST API, authenticated via
the user's own Google sign-in.

## 2. Problem Statement

Gmail's own UI makes it easy to search or sort by individual message
size, but does not surface "which sender, in aggregate, is costing me
the most storage." A user who wants to reclaim inbox/storage space has
to manually search, estimate, and delete sender-by-sender. Gmail Cleaner
automates the aggregation step (group all mail by sender, sum size,
count messages) and turns cleanup into a single click per sender.

## 3. Goals

- Give the user a ranked view of Gmail senders by total mail size.
- Let the user move all of a sender's mail to Trash in one action.
- Let the user permanently exclude specific senders from consideration
  (e.g. senders they never want to bulk-trash, such as themselves or a
  work contact who happens to send large attachments).
- Do all of this without standing up any server component or requiring
  the user to trust a third party with their Gmail credentials.
- Keep the user informed of sync progress in real time rather than
  presenting a blocking "please wait" state, since a full inbox sync can
  take minutes on a large mailbox (see Non-Functional Requirements).

## 4. Non-Goals

- Reading, composing, or sending email. The app only ever reads message
  *metadata* (sender, subject, date, size, snippet) and modifies Gmail
  labels (Trash); it never reads message bodies or attachments.
- Managing labels/folders beyond Trash, or any Gmail settings.
- Supporting mailboxes other than the signed-in user's own `INBOX`.
- Multi-user, multi-account, or team/admin functionality of any kind.
- Guaranteeing byte-exact size figures — see Non-Functional Requirements.
- Working offline or as an installable app (no service worker/PWA).

## 5. Target User

A single individual with a personal Gmail account who wants to reduce
inbox storage usage and is comfortable with a short one-time setup step
in Google Cloud Console (see Section 9.4). This is a personal tool, not
a product intended for distribution to end users who can't perform that
setup themselves.

## 6. Background: Why This Is Client-Side Only

Browsers have no raw TCP/TLS socket API, so a web page cannot speak
IMAP or POP3 to a mail server directly — there is no way to build a
zero-backend version of this tool on top of those protocols. Gmail's
REST API is plain HTTPS/JSON with CORS enabled for browser use, which
is what makes a genuinely serverless design possible: the browser
authenticates directly with Google via OAuth and calls
`gmail.googleapis.com` itself. This constraint shapes several
requirements below (notably OAuth setup and Gmail API quota limits).

## 7. Functional Requirements

### 7.1 Authentication

| # | Requirement |
|---|---|
| 7.1.1 | The user must supply a Google OAuth Client ID (created by the user in Google Cloud Console) via a text field in the UI before signing in. |
| 7.1.2 | The Client ID, a public non-secret identifier, is cached in `localStorage` and pre-filled on future visits so the user only has to paste it in once per browser — this is a convenience, not a security boundary. |
| 7.1.3 | Clicking "Sign in with Google" must trigger Google's OAuth consent flow (via Google Identity Services) requesting the `gmail.modify` scope, the minimum scope that allows both reading mail metadata and modifying labels (needed for Trash). |
| 7.1.4 | On successful sign-in, the resulting access token is cached in `sessionStorage` so the user isn't re-prompted for every action within the same tab session. |
| 7.1.5 | The access token must never be cached beyond its own expiry (~1 hour) or beyond the browser tab's session (`sessionStorage`, not `localStorage`). |
| 7.1.6 | There is no refresh-token flow. When the cached token is absent or expired, the next action that needs one triggers a new interactive sign-in. |
| 7.1.7 | The user can explicitly sign out, which revokes the token with Google and clears it from `sessionStorage`. |
| 7.1.8 | The UI must indicate whether the user is currently signed in. |

### 7.2 Inbox Sync

| # | Requirement |
|---|---|
| 7.2.1 | A "Sync Now" action lists every message currently in the user's `INBOX` and fetches sender, subject, date, size, and a short snippet for any message not already known to the app. |
| 7.2.2 | Listing (paging through the inbox) and metadata fetching must run concurrently — fetching does not wait for the entire inbox to be listed first, and listing does not wait for fetching to finish a page before continuing. This minimizes time-to-first-useful-data on large inboxes. |
| 7.2.3 | The sender grid must update in real time as each message's data is fetched, not only once the whole sync completes. |
| 7.2.4 | The user can **Pause** an in-progress sync. Pausing stops new work from starting (both listing and fetching) but does not need to cancel a request already in flight. |
| 7.2.5 | The user can **Resume** a paused sync, continuing from exactly where it left off (including partway through a page of listing results) without re-doing already-completed work. |
| 7.2.6 | The user can **Restart** a sync in progress. This re-does the inbox listing step but must not re-fetch metadata for messages already fetched in the aborted attempt. |
| 7.2.7 | A visual progress indicator shows fetched-message count against the number of messages discovered so far as needing a fetch. Because that denominator can still grow while listing continues, the indicator must visually distinguish "still growing" from "final" (see Section 9.2). |
| 7.2.8 | On each sync, messages previously known to the app that no longer appear in the current `INBOX` listing (e.g. deleted or moved via another client) must be marked inactive so they drop out of the sender rankings. |
| 7.2.9 | Sync must tolerate and recover from Gmail API rate-limit responses (HTTP 429) via retry with backoff, rather than failing the whole sync. |
| 7.2.10 | The UI must show the timestamp of the last completed sync. |
| 7.2.11 | After the `INBOX` phase completes, the same "Sync Now" action also scans the user's `SENT` mail to build the set of addresses the user has ever emailed or replied to (used by Cleanup Suggestions, see 7.6). This scan runs strictly after the inbox phase, never concurrently with it, to stay within the same per-minute quota ceiling (see 9.2). |
| 7.2.12 | The Sent-mail scan must be incremental across syncs — it re-fetches only Sent messages not already scanned in a prior sync, never the whole Sent folder again, since "has the user ever emailed address X" is a fact that never becomes stale once true. |
| 7.2.13 | Pause/Resume/Restart (7.2.4–7.2.6) apply to the Sent-mail scan phase exactly as they do to the inbox phase. |

### 7.3 Sender Grid

| # | Requirement |
|---|---|
| 7.3.1 | The app displays one row per distinct sender (by email address) among all active, non-ignored, synced messages, showing: display name and/or email, message count, and total size. |
| 7.3.2 | The grid's default ordering is total size, descending. |
| 7.3.3 | Each of the Sender, Messages, and Total Size columns must be independently sortable by clicking its header. Each click cycles the column through three states: ascending, descending, then unsorted (back to the default order). |
| 7.3.4 | Each column has an independent filter: **Sender** matches as a case-insensitive substring against the sender's name or email; **Messages** and **Total Size** are both "at least" (`>=`) numeric thresholds. |
| 7.3.5 | The Total Size filter must accept a unit suffix (`B`, `KB`, `MB`, `GB`, case-insensitive); a value with no unit is treated as bytes. |
| 7.3.6 | Filters combine with AND logic, and apply before sorting. Invalid or empty filter input must be treated as "no filter for this column," never as an error. |
| 7.3.7 | The grid must distinguish, in its empty state, between "no data has been synced yet" and "filters matched zero senders," and show an appropriately different message for each. |
| 7.3.8 | Hovering over a sender must show a preview (date, subject, and snippet) of the most recent message from that sender. |
| 7.3.9 | Clicking a sender's name/email must open Gmail's web UI in a new tab, pre-filtered to a search for mail from that sender's address. |

### 7.4 Sender Actions

| # | Requirement |
|---|---|
| 7.4.1 | Each sender row has a **Move to Trash** action that, after user confirmation, moves every one of that sender's known messages to Gmail's Trash in a single batched request. |
| 7.4.2 | Each sender row has an **Ignore** action that removes that sender from the grid, on this sync and all future syncs, until explicitly reversed. |
| 7.4.3 | Ignoring a sender must not modify anything in the user's actual Gmail account — it only affects what this app displays and allows. |
| 7.4.4 | Because an ignored sender never appears in the grid, there must be no way to trash an ignored sender's mail through this app while they remain ignored. |
| 7.4.5 | A separate "Ignored senders" list shows every currently-ignored sender with an **Unignore** action to reverse it. |
| 7.4.6 | The ignored-senders list must persist across sync data resets (see 7.5) and across browser sessions, since it represents a standing user preference rather than sync progress. |

### 7.5 Data Management

| # | Requirement |
|---|---|
| 7.5.1 | A **Clear Data** action wipes all locally synced mail data and the last-synced timestamp, resetting the grid to empty, without affecting the user's actual Gmail account. |
| 7.5.2 | Clear Data must require user confirmation before proceeding. |
| 7.5.3 | Clear Data must not clear the ignored-senders list (see 7.4.6). |
| 7.5.4 | Clear Data must be safe to trigger even while a sync is actively running or paused, cleanly stopping that sync first. |

### 7.6 Cleanup Suggestions

| # | Requirement |
|---|---|
| 7.6.1 | The sender grid is presented as two tabs: **All Senders** (the ranked view described in 7.3) and **Cleanup Suggestions**. Both tabs offer the full grid feature set — sorting, filtering, pagination, Ignore, per-sender Move to Trash, and multi-select (7.6.6–7.6.8) — independently of each other. |
| 7.6.2 | Cleanup Suggestions shows senders the user has never sent mail to or replied to (see 7.2.11) **and** whose most recent message is older than a user-configurable number of years, **or** any sender the user has previously used Move to Trash on via this app before (7.6.5), regardless of how recently that sender has emailed. |
| 7.6.3 | The age threshold (in years) is a number the user can adjust directly in the Cleanup Suggestions tab; changing it re-evaluates the suggestions immediately from already-synced local data, without requiring a new sync. |
| 7.6.4 | Cleanup Suggestions excludes ignored senders, identically to All Senders (7.4.3–7.4.4). |
| 7.6.5 | Every sender the user moves to Trash (individually or via multi-select, 7.6.8) is permanently remembered by this app, so that if they email again, they keep appearing in Cleanup Suggestions per 7.6.2 without the user needing to wait out the age threshold again. This record is not affected by Clear Data (7.5.3 applies here too). |
| 7.6.6 | The user can select multiple senders via a checkbox per row and a "select all" checkbox scoped to the currently visible page. |
| 7.6.7 | A single "Move to Trash" action, positioned above both tabs, moves every selected sender's mail to Trash in one confirmation step, after showing the total message and sender count. It is disabled whenever no sender is selected. |
| 7.6.8 | A sender selected while viewing one tab remains selected (and counted toward 7.6.7) if the user switches to the other tab and the same sender also appears there. |

## 8. Data Model

Synced state is stored in the browser's IndexedDB (database
`gmailCleaner`), in six object stores:

| Store | Key | Fields |
|---|---|---|
| `messages` | Gmail message `id` | `from`, `subject`, `date`, `sizeEstimate`, `snippet`, `deleted` (soft-delete flag) |
| `meta` | fixed key | `lastSyncedAt` (ISO timestamp) |
| `ignoredSenders` | sender email | (presence in the store is the only fact recorded) |
| `contactedAddresses` | email address | (presence only) every address ever sent-to/CC'd, from scanning Sent mail (7.2.11) |
| `trashedSenders` | sender email | (presence only) senders previously Move-to-Trash'd via this app (7.6.5) |
| `scannedSentIds` | Sent message `id` | (presence only) tracks which Sent messages have already been scanned, for the incremental scan (7.2.12) |

The OAuth Client ID is cached in `localStorage` (7.1.2) and the OAuth
access token lives only in `sessionStorage`; the user-configured Cleanup
Suggestions age threshold (7.6.3) is also cached in `localStorage` as a
UI preference, not mailbox data.

## 9. Non-Functional Requirements

### 9.1 Privacy & Security

- No server component of any kind exists; the app cannot see, log, or
  transmit the user's data to anyone other than Google's own API.
- Nothing sensitive is ever written to persistent storage: the OAuth
  Client ID is never stored, and the access token is confined to
  `sessionStorage` (cleared when the tab closes) with a natural ~1-hour
  expiry regardless.
- The app requests only the `gmail.modify` scope — the minimum needed
  for its functionality — never full-mailbox (`https://mail.google.com/`)
  or send-capable scopes.

### 9.2 Performance & API Constraints

- Gmail API quota is a hard external constraint: 6,000 quota
  units/minute per user. `messages.get` costs 20 units (capping
  metadata fetches at ~300/minute), `messages.list` costs 5, and
  `messages.batchModify` costs 50 regardless of how many message IDs
  are included — which is why Trash is always implemented as one
  batched call per sender rather than one call per message.
- A first-time sync of a large, never-before-synced mailbox can
  therefore take several minutes; this is a Google-imposed limit the
  app cannot work around, only communicate honestly (progress bar,
  status text noting when the total is still growing). The Sent-mail
  scan (7.2.11) uses the same `messages.get`-equivalent cost per message,
  so a first-time sync's worst-case time roughly doubles versus syncing
  `INBOX` alone — paid once, since the scan is incremental (7.2.12) on
  every subsequent sync.
- Reported message sizes are Gmail's own `sizeEstimate` field — an
  approximation, not an exact byte count.

### 9.3 Compatibility

- Requires a modern browser with IndexedDB support.
- Must be served from an `http(s)` origin (not opened as a local
  `file://` page), because Google's OAuth flow requires a registered
  origin.

### 9.4 Setup Requirements

- The user must have (or create) a Google Cloud project with the Gmail
  API enabled and an OAuth Client ID (Web application type) whose
  Authorized JavaScript origins include wherever the app is served
  from.
- Because the app requests a sensitive scope (`gmail.modify`) and the
  OAuth consent screen is expected to remain in "Testing" publishing
  status for personal use, Google will show an "unverified app"
  warning at sign-in that the user must click through.

## 10. Key User Flows

**First-time setup**
1. User completes one-time Google Cloud OAuth Client ID setup.
2. User opens the app, pastes the Client ID, signs in with Google,
   and approves the requested scope (clicking through the "unverified
   app" warning).
3. User clicks Sync Now and watches the grid populate in real time.

**Routine cleanup**
1. User opens the app (already signed in if the access token hasn't
   expired and the tab session persisted).
2. User clicks Sync Now to pick up new mail since the last sync.
3. User sorts/filters the grid to find high-impact senders.
4. User hovers a sender to confirm (via the message preview) they
   recognize it, then clicks Move to Trash — or clicks Ignore if it's a
   sender they never want to bulk-trash.

**Bulk cleanup via suggestions**
1. User switches to the Cleanup Suggestions tab and optionally adjusts
   the age threshold.
2. User reviews the pre-filtered list of senders they've never emailed
   and haven't heard from recently (or have trashed before).
3. User checks several senders and clicks the single "Move to Trash"
   action above the tabs, confirming the combined message/sender count
   once.

**Recovering from a bad state**
1. If sync data looks wrong or stale, the user clicks Clear Data and
   re-syncs from scratch, without losing their ignored-senders list.

## 11. Known Limitations

- Progress totals shown mid-sync can still grow, since listing and
  fetching happen concurrently — the UI communicates this but cannot
  avoid it, as the true total isn't knowable until listing finishes.
- Pausing a sync cannot cancel network requests already in flight; a
  small number may still complete just after Pause is clicked.
- The sender-preview tooltip is a native browser tooltip
  (`title` attribute), not a custom-styled popover.
- Very large mailboxes could in principle approach browser-imposed
  IndexedDB storage quotas, though this is far more headroom than the
  ~5-10MB `sessionStorage` would have allowed.

## 12. Out of Scope for Future Consideration

- Multi-account support (syncing more than one Gmail account per
  session).
- Any action beyond Trash (e.g., Archive, permanent delete, applying
  custom labels).
- A packaged/hosted version that removes the one-time Google Cloud
  setup step for non-technical users.
