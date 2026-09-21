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

## Loop — for each row in the admin queue, top to bottom

1. Read the URL from the top row of the admin queue table.
2. Switch to the GSC tab. Click the search bar at the top, select all (Cmd+A), type the full URL, press Enter.
3. Wait ~3–4s for the "URL Inspection" result to load.
4. If the "Page indexing" panel is collapsed, click it to expand and reveal "Last crawl".
5. Decide based on status:
   - **"URL is on Google" AND last crawl is within the past 7 days** → no reindex needed. Skip to step 7.
   - **"URL is on Google" but last crawl is older than 7 days** → reindex needed. Go to step 6.
   - **"URL is not on Google"** (not indexed / discovered but not indexed) → reindex needed. Go to step 6.
6. Click **REQUEST INDEXING** (or **REQUEST AGAIN** if already requested once this session).
   - Wait ~8s for "Testing if live URL can be indexed" to resolve.
   - Wait another ~6s for the "Indexing requested" success toast.
   - Dismiss the toast (click "Dismiss" or click elsewhere on the panel).
   - If instead you see **"Quota exceeded"** — stop the whole run immediately (see "Stopping" below).
7. Switch to the admin queue tab and click **Done** on that row.
   - If the row shows "Something went wrong. Please try again." after clicking Done, reload the admin queue page (`https://www.aecintegrations.com/admin/reindex`) and click Done again on the same row — this is a transient error, not a real failure.
8. Return to step 1 for the next row.

## Reliability notes

- **Empty-looking queue table**: occasionally the admin queue page renders with zero rows even though the counter badge (e.g. "1147") shows remaining items. This is a stale render, not actually empty. Reload the page to fix it before concluding the queue is done.
- **GSC hangs mid-inspection**: if a screenshot/action times out repeatedly waiting on the URL Inspection panel, don't keep retrying indefinitely — close and reopen the GSC tab (or navigate it back to the base GSC URL) and resume.
- **Quota exceeded**: this is Google's daily cap on URL Inspection API usage for the property. It resets ~daily. When you hit it, stop the run entirely — retrying won't work again until the quota resets. Report the count of reindex requests submitted and rows still remaining in the queue.

## Stopping / reporting

When you stop (quota exceeded, or told to stop, or queue empty), report:
- How many rows were marked **Done** total this run.
- How many of those were actual **reindex requests** (vs. skipped because already recently crawled).
- How many rows remain in the queue (from the Operations tab counter badge).
