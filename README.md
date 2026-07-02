# Gmail Cleaner

A client-side-only React SPA that talks to Gmail's REST API directly from
your browser, ranks senders by the total size of the emails they've sent
you, and lets you move all of a sender's emails to Trash with one click.

There is no backend. This is a static site built with [Vite](https://vite.dev/)
— all Gmail access happens straight from the browser to
`gmail.googleapis.com`, authenticated with your own Google sign-in.
Synced message data lives in this browser's IndexedDB and persists across
sessions (so you're not re-syncing your whole inbox every time you open
the app); your OAuth Client ID and access token remain intentionally
ephemeral — see [Notes and limitations](#notes-and-limitations).

## One-time Google Cloud setup

Gmail's REST API is the only way for a browser page to touch Gmail
without a backend server — browsers have no way to speak IMAP/POP3
directly (no raw socket API), so this app authenticates with a Google
sign-in popup (OAuth2) instead of an IMAP App Password. That requires
registering your own OAuth client, once:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
   and create a project (or pick an existing one).
2. Search bar → **Gmail API** → open it → **Enable**.
3. Go to **Google Auth Platform** (Google's current name for OAuth
   consent screen setup). First time through it'll ask you to configure
   branding: set **User type** to **External** and fill in an app name
   and support email — the rest can be left minimal for personal use.
4. **Google Auth Platform → Audience** tab: add your own Gmail address
   under **Test users**. Leave **Publishing status** as **Testing** —
   that's fine for personal use and doesn't require Google's app
   verification process.
5. **Google Auth Platform → Clients** tab → **Create Client**:
   choose **Web application**, and add
   `http://localhost:5500` (or whatever port you run this on) under
   **Authorized JavaScript origins**. No redirect URI is needed — this
   app uses the token flow, not the redirect-based code flow.
6. Copy the generated **Client ID** (ends in `.apps.googleusercontent.com`)
   — you'll paste it into the app's UI each time you use it (see Usage
   below). It isn't stored in any file; while it's a public identifier,
   not a secret, this app keeps it out of persisted config the same way
   it keeps everything else out of persisted storage.

Because the app requests the `gmail.modify` scope (needed to move mail to
Trash) and the OAuth consent screen stays in "Testing" status, Google
will show an **"unverified app"** warning at sign-in. Click
**Advanced → Go to (app name) (unsafe)** to proceed — this is expected
for a personal tool only you (as a registered test user) can sign into.

## Running it

```bash
npm install
npm start
```

Then open http://localhost:5500. `npm start` runs Vite's dev server
(with hot module reloading) pinned to port 5500 so it matches the
Authorized JavaScript origin from step 5 above. For a production-style
build instead: `npm run build` (outputs static files to `dist/`) then
`npm run preview` (serves `dist/` on the same port 5500). Any static
host works for `dist/` too, as long as its origin is likewise registered.

## Usage

1. Paste your **Google OAuth Client ID** into the field at the top, then
   click **Sign in with Google** and approve access for your account.
   The Client ID lives only in that input field for as long as the page
   is open — it's read fresh each time it's needed and never written to
   `sessionStorage`, `localStorage`, or disk.
2. Click **Sync Now**. This lists your INBOX (`messages.list`, up to 500
   ids per page) and fetches sender/subject/date/size/snippet
   (`messages.get`, `format=metadata`) for not-yet-stored messages
   *concurrently* — listing keeps paging in the background while a pool
   of workers fetches details for whatever's been found so far, rather
   than listing one page, waiting for its messages to finish, then
   listing the next. The table updates in real time as each message's
   details come in, not just when the sync finishes. A progress bar shows
   fetched-vs-listed; while it's still animated/striped, the total is
   still growing as more of the inbox gets listed, so the percentage
   isn't final yet — it turns solid once listing finishes and the
   percentage means what it says.
   - **Pause** stops both listing and fetching without losing progress;
     **Resume** continues from exactly where it left off.
   - **Restart** abandons the current sync attempt and starts over —
     already-fetched messages stay in the store, so this mainly redoes
     the inbox listing step rather than wasting completed work.
3. The table ranks every sender by total size of their mail, with a
   message count and a **Move to Trash** button. Click any column header
   (Sender, Messages, Total Size) to sort by it — clicking cycles through
   ascending → descending → unsorted (back to the default: total size,
   descending). Hovering over a sender shows a short preview (date,
   subject, snippet) of the latest message from them; clicking a sender
   opens a new tab searching Gmail for `from:<their address>`.
   - The row under the headers filters each column: **Sender** matches
     as a substring against name or email (e.g. "newsletter" matches
     "newsletter@example.com"); **Messages** and **Total Size** are both
     "at least" thresholds — type a number for Messages, and a number
     with a unit for Total Size (e.g. `500KB`, `2MB`, `1.5GB`; a bare
     number is treated as bytes). Filters combine (all must match) and
     apply on top of whatever sort is active. Invalid or empty filter
     text is simply ignored rather than erroring.
4. Clicking **Move to Trash** calls `messages.batchModify` to add the
   `TRASH` label (and remove `INBOX`) on every stored message from that
   sender in one request.
5. Clicking **Ignore** on a sender removes them from the table (and keeps
   them out of it on future syncs) without touching their mail in Gmail
   at all — no Trash button is ever shown for an ignored sender, so
   there's no way to trash their mail through this app while ignored.
   Ignored senders are listed at the bottom of the page with an
   **Unignore** button to reverse it; this list is stored in IndexedDB
   and — unlike synced mail data — is *not* cleared by **Clear Data**,
   since it's a standing preference rather than sync progress.
6. **Clear Data** wipes all synced mail data and the last-synced
   timestamp from IndexedDB and resets the table to empty, so the next
   **Sync Now** rebuilds everything from scratch. It only affects data
   cached in this browser — it does not touch your actual Gmail account.
7. Re-run **Sync Now** any time; it also reconciles messages that
   disappeared from INBOX since the last sync (moved/deleted elsewhere)
   by marking them inactive locally.

## Notes and limitations

- **Message data persists across sessions; credentials don't.** Synced
  mail metadata is kept in this browser's IndexedDB (`gmailCleaner`
  database) and survives closing the tab or restarting the browser — a
  deliberate exception to how everything else in this app behaves. Your
  OAuth Client ID is never stored anywhere (re-enter it each page load),
  and your access token lives only in `sessionStorage` (cleared when the
  tab closes, ~1hr lifetime regardless). To fully reset, clear this
  site's data via your browser's DevTools (Application → IndexedDB) or
  site settings — closing the tab is no longer enough.
- **Gmail API quota**: each account is limited to 6,000 quota units per
  minute. `messages.get` costs 20 units, capping metadata fetches at
  ~300/minute (~5/sec). Syncing a mailbox with many thousands of
  never-before-seen messages can take several minutes the first time;
  this is a hard API limit, not something the app can work around
  (`src/lib/gmailApi.js` already retries with backoff on HTTP 429). Once
  synced, though, only genuinely new mail needs fetching on future syncs.
- **Sizes are approximate.** `sizeEstimate` is Gmail's own estimated
  byte size per message, not an exact figure the way IMAP's `LIST`
  response is.
- **Pause** stops new metadata fetches from starting but can't cancel
  requests already in flight (the browser has no way to abort a fetch
  Google is already processing) — at most a handful finish shortly after
  you click it.
- The hover preview is a native browser tooltip (the `title` attribute),
  not custom-styled — kept intentionally simple rather than building
  tooltip positioning/dismissal logic for a personal tool.

## Why there's a build step now

OAuth requires the page to be served from a registered `http(s)` origin
— it won't work opened as a `file://` page, which is why this needs a
dev/preview server rather than just opening `index.html` directly. The
build step itself (Vite compiling JSX) doesn't change anything about the
"no backend" design: `npm run build` produces a plain static `dist/`
folder, and nothing in it ever talks to anything but Google's APIs.
