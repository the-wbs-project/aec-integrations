# GSC Re-index Queue Playbook

Manual runbook for draining the `/admin/reindex` queue against Google Search Console. Google accepts no re-index request from us by API, so this is done by hand via URL Inspection.

Tag this file into a prompt (e.g. "follow @docs/gsc-reindex-playbook.md") and go — no further instructions needed.

## Pages involved

- Admin queue: `https://www.aecintegrations.com/admin/reindex`
- Google Search Console: `https://search.google.com/search-console?resource_id=sc-domain%3Aaecintegrations.com`

## Setup

1. Open the admin queue page in one tab.
2. Open GSC (resource `sc-domain:aecintegrations.com`) in a second tab.
3. Confirm GSC is already signed into the account with access to this property (it should be — no login step needed in practice).
4. **Browser-agent runs (claude-in-chrome): the agent's tab group must sit in its own Chrome window**, not share a window with the operator's other tabs. When the group shares a window, the window loses the foreground within 3–30 minutes: both tabs report `document.visibilityState === 'hidden'`, screenshots time out, and clicks and typing are silently dropped. Moving the group to its own window fixed this for a full run (2026-09-28).

## Loop — for each row in the admin queue, top to bottom

1. Read the URL from the top row of the admin queue table.
2. Switch to the GSC tab. If a dialog from the previous row is still on screen, dismiss it first (see step 6). Click the search bar at the top, select all (Cmd+A), type the full URL, press Enter.
3. Wait **~15–18s** for the "URL Inspection" result to load. It is rarely ready in 3–4s, and a click made while "Retrieving data from Google Index" is still showing does nothing. Confirm the URL printed at the top of the result matches the row before deciding.
4. If the "Page indexing" panel is collapsed, click it to expand and reveal "Last crawl".
5. Decide based on status. "7 days" is measured against today's date.
   - **"URL is on Google" AND last crawl is within the past 7 days** → no reindex needed. Skip to step 7.
   - **"URL is on Google" but last crawl is older than 7 days** → reindex needed. Go to step 6.
   - **"URL is not on Google"** (not indexed / discovered but not indexed) → reindex needed. Go to step 6.
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
- How many rows were marked **Done** total this run.
- How many of those were actual **reindex requests** (vs. skipped because already recently crawled).
- Any rows **rejected** by Google, with the live-test reason.
- The next row still in the queue, and any row that was requested but not yet marked Done.
- How many rows remain in the queue (from the Operations tab counter badge).
