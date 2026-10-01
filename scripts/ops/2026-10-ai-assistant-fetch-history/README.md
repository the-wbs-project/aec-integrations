# 2026-10 AI-assistant fetch history (AECI-1169)

Saved history of on-demand AI-assistant requests to the `aecintegrations.com` zone, pulled from
Cloudflare. An on-demand fetch (`ChatGPT-User`, `Claude-User`, `Perplexity-User` and similar)
means a person asked an assistant a question and the assistant fetched one of our pages.

Cloudflare keeps this data for **31 days** on the Pro plan. These files are the only copy older
than that. `page_views` cannot replace them: it discards the raw user agent, merges assistant
fetches into crawler labels, and does not record Cloudflare's verified-bot flag. AECI-1169 builds
the daily job that makes this directory obsolete. Until it ships, re-run the pull by hand at least
every 30 days and commit the new file, or the history gets a gap.

| File | What it is | Touches Cloudflare? |
|---|---|---|
| `pull.mjs` | Pulls the last 31 days into a CSV, one day per query | Read only |
| `fetches-2026-08-31_2026-10-01.csv` | First snapshot: 2,281 rows, 5,222 requests, 1,059 verified | No |

## Re-run

Needs `CF_READONLY_API_TOKEN` with zone Analytics: Read. It is set in Conductor's environment.

```bash
node scripts/ops/2026-10-ai-assistant-fetch-history/pull.mjs
```

It writes `fetches-<first-day>_<last-day>.csv` beside itself and prints a one-line total.

## Columns

| Column | Meaning |
|---|---|
| `date` | UTC day. The first and last day of each file are partial |
| `agent` | Which assistant name the user agent carries, or `other AI assistant` for Cloudflare's category |
| `verified` | Cloudflare confirmed the request came from the operator's published network |
| `genuine_guess` | `verified`, or a `Claude-User` from a consumer network (a Claude app on someone's machine). Our rule, not Cloudflare's |
| `host`, `path`, `query`, `method`, `status` | The request and our edge response |
| `country`, `asn`, `asn_name` | Where it came from. No IP addresses are stored |
| `security_source` | Which Cloudflare layer acted, such as `firewallCustom` for a 403 from our WAF rules |
| `user_agent` | The raw user agent |
| `count` | Requests with exactly these values. Cloudflare's sample-adjusted estimate |

## Reading it

- **Filter to `genuine_guess = true`.** A scanner on Google Cloud borrows every assistant name and
  gets only 403 and 404. In September it was 930 of the requests on `www`.
- **Filter to `host = www.aecintegrations.com` for pages served.** The apex host holds the 301s
  that redirect to `www`. Other hosts are non-production.
- **Files overlap when combined.** De-duplicate on every column except `count`. For a day in two
  files, keep the newer file's rows, because the older file's last day is partial.

## First snapshot, `www` and genuine only (2026-09-01 to 09-30)

| Agent | Requests |
|---|---|
| ChatGPT-User, verified | 713 |
| Claude-User, verified | 35 |
| Claude apps on user machines | 23 |
| DuckAssistBot, verified | 20 |

About 240 distinct pages were fetched. Product pages took 300 requests, the homepage 262 and
integration pair pages 142. No genuine `Perplexity-User` or `MistralAI-User` request reached us.

## Copy in R2

Uploaded on 2026-10-01 to the temporary bucket `aeci-views-temp` on **The WBS Project** account
(`004dc1af737b22a8aa83b3550fa9b9d3`), under the prefix `cloudflare-backfill-2026-10-01/<this directory>/`.
Download with your wrangler OAuth login and the target account set, run from a directory with no
`wrangler.jsonc` (the repo's configs pin the AEC Integrations account and override the variable):

```bash
cd /tmp && env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 npx wrangler r2 object get aeci-views-temp/cloudflare-backfill-2026-10-01/2026-10-traffic-history/daily-rollup/2026-09.csv.gz --remote --file daily-rollup-2026-09.csv.gz
```
