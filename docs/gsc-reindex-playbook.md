# GSC Re-index Queue Playbook

Runbook for draining the `/admin/reindex` queue against Google Search Console. It has two parts:

1. **Step 0, the automated inspection.** A daily cron (`gsc-inspect`, 13:00 UTC, AECI-1236) asks the Search Console URL Inspection API about every queued URL. It removes the rows Google has already re-crawled since the page last changed, and tags the rest with what Google said. `scripts/gsc-reindex-triage.mjs` is the manual fallback when the cron did not run.
2. **The manual loop.** Google accepts no re-index request by API, so every row left is requested by hand via URL Inspection.

Tag this file into a prompt (e.g. "follow @docs/gsc-reindex-playbook.md") and go — no further instructions needed.

## Pages involved

- Admin queue: `https://www.aecintegrations.com/admin/reindex`
- Google Search Console: `https://search.google.com/search-console?resource_id=sc-domain%3Aaecintegrations.com`

## Setup

1. Open the admin queue page in one tab.
2. Open GSC (resource `sc-domain:aecintegrations.com`) in a second tab.
3. Confirm GSC is already signed into the account with access to this property (it should be — no login step needed in practice).
4. **Browser-agent runs (claude-in-chrome): the agent's tab group must sit in its own Chrome window**, not share a window with the operator's other tabs. When the group shares a window, the window loses the foreground within 3–30 minutes: both tabs report `document.visibilityState === 'hidden'`, screenshots time out, and clicks and typing are silently dropped. Moving the group to its own window fixed this for a full run (2026-09-28).

## Step 0 — check that today's inspection ran

The `gsc-inspect` cron runs daily at 13:00 UTC. Check it before starting the loop:

- Open `/admin/system`. The `gsc-inspect` row should show a run today. A run is several rows, one per chunk of 100 URLs.
- On `/admin/reindex`, the **Google says** column should be filled for most rows. "Not checked yet" on most rows means the run did not happen.

If it ran, go straight to the loop. If it did not, run the triage script below, then the loop.

**What the inspection removes.** A row is removed only when Google reports the page indexed AND its last crawl is after the page's last change (`last_changed_at`). A page Google could not fetch (404 and the like) is tagged, never removed. Removed rows are listed in one `reindex.auto_cleared` audit row per batch.

### The triage script (fallback)

`scripts/gsc-reindex-triage.mjs` applies the same rule as the cron. It clears through `DELETE /api/admin/reindex/:id`, the same call as the **Done** button, so each clear writes an `audit_log` row attributed to the admin whose session is supplied. Never clear rows with a direct D1 delete instead. Before migration 0064 is in production it clears nothing, because it cannot tell which change Google saw.

**What it needs.**

- The GSC service-account key in the `GSC_SA_KEY_JSON` environment variable, as the JSON text of the key file. Set it in `~/.zshrc` so every shell has it. Failing that, the script reads the file at `GSC_SA_KEY`, default `~/.config/aeci/gsc-sa.json`. The account needs read access to the `sc-domain:aecintegrations.com` property. The script uses the read-only scope.
- An admin session, as either `AECI_ADMIN_TOKEN` (the Supabase access token) or `AECI_ADMIN_COOKIE` (the `Cookie` request header). To get the cookie: open `https://www.aecintegrations.com/admin/reindex` signed in, open DevTools → Network, select any `/api/admin/...` request, and copy its `Cookie` request header. It expires about an hour after sign-in, so copy it just before the run.

**One authorized exception (2026-10-08).** Migration 0064 stamped `last_changed_at` = 2026-10-05 07:30 UTC on every row then queued, not the page's real last change. So rows Google had already re-crawled read "crawled before the change". With the operator's written authorization, 411 such rows were cleared by one direct SQL run. The run wrote a single `reindex.bulk_cleared` audit row listing every cleared row and the rule used. The rule: Google reports the page indexed and last crawled it at least an hour after its real last change, taken from `audit_log`. This was a one-off. It is not a pattern to repeat. The 919 rows left still carry the placeholder date.

**Dry run without a session.** `--from-d1` reads the worklist from production D1 with a read-only `SELECT` through wrangler, so a dry run needs no admin session. It uses your wrangler OAuth login on The WBS Project account, and drops `CLOUDFLARE_API_TOKEN` for that call because the token in Conductor's environment reaches only the old account. `--apply` still needs the admin session, because rows are only ever cleared through the audited Done call.

```bash
node scripts/gsc-reindex-triage.mjs --from-d1
```

**How to run it.** Run a dry run first. It prints one line per row and writes a JSON report to `.context/gsc-triage/`. Nothing is cleared.

```bash
AECI_ADMIN_COOKIE='paste the Cookie header here' node scripts/gsc-reindex-triage.mjs
```

If the summary looks right, run it again with `--apply` to clear the done rows.

```bash
AECI_ADMIN_COOKIE='paste the Cookie header here' node scripts/gsc-reindex-triage.mjs --apply
```

**Saved results.** The script saves each inspection in `.context/gsc-triage/state.json`, keyed by row id, and does not re-inspect a row checked within the last 72 hours, or whose page changed since. A done row is cleared from its saved result. So the `--apply` run after a dry run inspects nothing again, and several runs a day stay inside the inspection quota. A URL queued again gets a new row id and is always inspected fresh.

Other flags: `--limit N` inspects only the first N rows, `--priority N` only one tier, `--recheck-hours N` changes the 12-hour window, `--fresh` ignores saved results, `--out PATH` moves the report.

**When it stops.**

- **Admin API 401 or 403**: the session expired or is not an admin. Copy a fresh `Cookie` header and re-run. Re-running is safe: a row already cleared answers 404 and counts as cleared.
- **"usually a Cloudflare challenge"**: the zone's bot protection blocked the script. Run the manual loop without step 0 and report it.
- **Search Console 401 or 403**: the service account lost access to the property. Nothing was cleared. Run the manual loop without step 0 and report it.
- **"quota is spent for today"**: Search Console still answered 429 after two waits. Rows already decided are still cleared with `--apply`. Rows not reached stay queued for the manual loop.

Record the script's summary (`inspected`, `done`, `cleared`, `request`, `error`) in the run report. Then start the loop on what is left. The URL Inspection API's own quota (2,000 calls a day per property, 600 a minute) is separate from the Request Indexing quota, so step 0 does not eat into the requests. The cron spends up to 1,500 of those calls a day, so run the script only on a day the cron did not run, or with `--limit`. Both run four inspections at a time.

## Loop — for each row in the admin queue, top to bottom

The queue is sorted for this loop: inside each priority, rows Google says need a request come first, and among those, pages Google has never crawled ("Not known to Google", "Discovered, not indexed") come before indexed pages with a stale crawl. Working top-down spends the request quota where it gains most.

After step 0, read the **Google says** column first. Every row with a reason other than "Could not fetch the page" needs a request, so go straight to step 6 for it after confirming the URL in Search Console. "Not checked yet" means the row is new or its page changed since the last inspection: request it.

1. Read the URL from the top row of the admin queue table.
2. Switch to the GSC tab. If a dialog from the previous row is still on screen, dismiss it first (see step 6). Click the search bar at the top, select all (Cmd+A), type the full URL, press Enter.
3. Wait **~15–18s** for the "URL Inspection" result to load. It is rarely ready in 3–4s, and a click made while "Retrieving data from Google Index" is still showing does nothing. Confirm the URL printed at the top of the result matches the row before deciding.
4. If the "Page indexing" panel is collapsed, click it to expand and reveal "Last crawl".
5. Decide based on status.
   - **"Google says: Could not fetch the page"** → open **View live test** first. If the live page is a 404, the page was removed. Mark the row Done and list it in the report. If the live page loads, request indexing (step 6).
   - **"URL is on Google" with a recent last crawl** → only possible on a row the inspection has not seen. Request it anyway, because the screen does not show when the page last changed. Go to step 6.
   - **Anything else** (crawled before the change, not on Google, discovered but not indexed) → reindex needed. Go to step 6.
6. Click **REQUEST INDEXING** (or **REQUEST AGAIN** if already requested once this session).
   - "Testing if live URL can be indexed" takes **20–60s**, not 8s. Do not click anywhere while it is showing: a click on the backdrop cancels the test.
   - The "Indexing requested" dialog then fades in slowly. Once it is fully visible, dismiss it by clicking an empty area of the page backdrop (bottom-right corner). **Escape does not close it.** Avoid clicking where the dialog *was* after it has gone, because the "Referring page" links sit underneath.
   - Success is confirmed by the inline "✓ Indexing requested" label beside **REQUEST AGAIN**. That label persists after the dialog closes, so use it rather than the dialog.
   - If instead you see **"Quota exceeded"** — stop the whole run immediately (see "Stopping" below). A quota error on a *second* click does not undo the first; if the inline "Indexing requested" label is showing, the row was requested and can be marked Done.
   - If instead you see **"Indexing request rejected"**, click **View live test**. If the live page returns **Not found (404)**, the page was removed and a request cannot help. Mark the row Done and list it in the report. This is expected for vendors or products that were retracted (e.g. `/vendors/nemetschek-group`, 2026-09-25). Any other rejection reason: leave the row, and report it.
7. Switch to the admin queue tab and click **Done** on that row.
   - If the row shows "Something went wrong. Please try again." after clicking Done, reload the admin queue page (`https://www.aecintegrations.com/admin/reindex`) and click Done again on the same row — this is a transient error, not a real failure.
   - The table can take a few seconds to re-render. Before inspecting the next row, re-read the top row; if it has not changed, check again before clicking Done a second time.
8. Return to step 1 for the next row.

## Browser-agent mechanics (claude-in-chrome)

These apply when an agent drives the loop rather than a person.

- **Activate a tab before clicking in it.** Taking a screenshot of a tab brings it to the front. Wait ~1s after that before clicking; a click sent immediately after switching tabs is dropped.
- **Click by screen coordinates.** Clicking Done through a `find`/`read_page` element reference did nothing, and clicking it via page JavaScript is blocked by the agent's permission layer. Reading the page with JavaScript is fine and is the reliable way to get the top row's URL and GSC's status text.
- **Re-measure coordinates whenever the window size changes.** The screenshot frame changed several times mid-run (1244×952, 1380×868, 1438×840, 1450×840, 1310×924), and the two tabs can report different frames at the same moment. Take a screenshot of each tab at the start of a run and after any size change.
- **The queue page loads 25 rows.** When the rendered rows run out, reload the page to fetch the next 25.
- **The Operations badge is not the queue length.** It rose during runs as new rows were enqueued, and it counts more than this queue, so treat it as approximate.

## Reliability notes

- **Empty-looking queue table**: occasionally the admin queue page renders with zero rows even though the counter badge (e.g. "1147") shows remaining items. This is a stale render, not actually empty. Reload the page to fix it before concluding the queue is done.
- **GSC hangs mid-inspection**: if a screenshot/action times out repeatedly waiting on the URL Inspection panel, don't keep retrying indefinitely — close and reopen the GSC tab (or navigate it back to the base GSC URL) and resume. If *both* tabs time out, the window is hidden rather than GSC being slow; see Setup step 4.
- **Quota exceeded**: this is Google's cap on indexing requests for the property. When you hit it, stop the run entirely — retrying won't work again until the quota resets. The cap is not a fixed daily number: observed runs got 11, then 1, then 22, then about 33 accepted requests on consecutive days (2026-09-25 to 2026-09-28). That pattern fits a rolling 24-hour window better than a midnight reset, so wait a full 24 hours after a quota error before the next run.

## Stopping / reporting

When you stop (quota exceeded, window hidden, told to stop, or queue empty), report:
- Step 0: whether today's `gsc-inspect` run happened, or the triage script's summary (rows inspected, cleared, left for requests, errors) if you ran it.
- How many rows were marked **Done** total this run.
- How many of those were actual **reindex requests** (vs. skipped because already recently crawled).
- Any rows **rejected** by Google, with the live-test reason.
- The next row still in the queue, and any row that was requested but not yet marked Done.
- How many rows remain in the queue (from the Operations tab counter badge).
