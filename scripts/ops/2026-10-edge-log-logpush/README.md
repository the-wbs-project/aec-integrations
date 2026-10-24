# 2026-10 edge request log: bucket, Logpush jobs, custom fields, notification (AECI-1447)

Creates the edge request log that ADR 0045 decided: one R2 bucket, two zone Logpush jobs, one
custom-fields rule and one Cloudflare notification. Done 2026-10-22. The ids are in
`docs/environments.md` "Edge request log". This file holds the exact requests so the setup can be
rebuilt or repaired. It holds no secrets.

| File | What it is |
|---|---|
| `fields-http_requests.json` | The 107 field names the `http_requests` job sends: every field the zone offered on 2026-10-22 except `ClientIP` |
| `fields-firewall_events.json` | The 43 field names the `firewall_events` job sends: every offered field except `ClientIP` |

## Credentials

The account is The WBS Project (`004dc1af737b22a8aa83b3550fa9b9d3`). The zone is
`aecintegrations.com` (`2246ff6dadcf91ea2d8a0160427b23ac`).

| Name | What | Lifetime |
|---|---|---|
| `CF_LOGPUSH_ONEOFF_TOKEN` | Account API token: zone Logs Edit, account Notifications Edit | Revoke when done |
| `R2_EDGE_LOG_ACCESS_KEY_ID`, `R2_EDGE_LOG_SECRET_ACCESS_KEY` | R2 token `aeci-edge-log-logpush-writer`, Object Read & Write on `aeci-edge-log-prod-us` | Never revoke. Both jobs write with it |

The one-off token is account-owned (`cfat_` prefix). Verify it at
`/accounts/<account id>/tokens/verify`. The `/user/tokens/verify` endpoint calls it invalid.

Keep the three values in a file only you can read and source it. Never paste them into a doc or an
issue. A job's `destination_conf` carries the R2 secret, so redact it from any API response you
share.

```bash
umask 077 && cat > /tmp/aeci-1447.env <<'EOF'
export CF_LOGPUSH_ONEOFF_TOKEN=''
export R2_EDGE_LOG_ACCESS_KEY_ID=''
export R2_EDGE_LOG_SECRET_ACCESS_KEY=''
EOF
```

## 1. Bucket and lifecycle rule

Run wrangler from `/tmp` on the OAuth login. The env token cannot reach this account.

```bash
cd /tmp
export CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3
env -u CLOUDFLARE_API_TOKEN npx wrangler r2 bucket create aeci-edge-log-prod-us --location enam
env -u CLOUDFLARE_API_TOKEN npx wrangler r2 bucket lifecycle add aeci-edge-log-prod-us delete-after-400-days "" --expire-days 400 --force
env -u CLOUDFLARE_API_TOKEN npx wrangler r2 bucket lifecycle list aeci-edge-log-prod-us
```

R2 honours `--location` only on a bucket name's first create. A recreate under the same name keeps the
first placement. That is why the bucket is `aeci-edge-log-prod-us` and not `aeci-edge-log-production`,
which first landed in APAC.

## 2. Custom-fields rule

Read the entrypoint first. A `PUT` replaces every rule in the phase. On 2026-10-22 it returned code
`10003`, meaning no entrypoint existed.

```bash
source /tmp/aeci-1447.env
curl -s "https://api.cloudflare.com/client/v4/zones/2246ff6dadcf91ea2d8a0160427b23ac/rulesets/phases/http_log_custom_fields/entrypoint" -H "Authorization: Bearer $CF_LOGPUSH_ONEOFF_TOKEN"
```

```bash
source /tmp/aeci-1447.env
curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/2246ff6dadcf91ea2d8a0160427b23ac/rulesets/phases/http_log_custom_fields/entrypoint" -H "Authorization: Bearer $CF_LOGPUSH_ONEOFF_TOKEN" -H 'Content-Type: application/json' -d '{"rules":[{"action":"log_custom_field","expression":"true","description":"AECI-1447 edge log client signals (ADR 0045)","enabled":true,"action_parameters":{"request_fields":[{"name":"sec-gpc"},{"name":"dnt"},{"name":"sec-fetch-mode"},{"name":"sec-fetch-site"},{"name":"sec-fetch-dest"},{"name":"accept-language"},{"name":"sec-ch-ua"},{"name":"sec-ch-ua-mobile"},{"name":"sec-ch-ua-platform"}]}}]}'
```

## 3. Logpush jobs

Re-read the offered fields before a rebuild. A field Cloudflare adds later is not in these lists. A
Bot Management field must stay out (ADR 0045 item 2). The zone did not offer any on 2026-10-22
because Bot Management is unlicensed.

```bash
source /tmp/aeci-1447.env
curl -s "https://api.cloudflare.com/client/v4/zones/2246ff6dadcf91ea2d8a0160427b23ac/logpush/datasets/http_requests/fields" -H "Authorization: Bearer $CF_LOGPUSH_ONEOFF_TOKEN"
```

This creates one job per dataset from the field files. Run it from the repo root, because it reads the
field files by relative path. Step 1 left the shell in `/tmp`. It never prints the destination.

```bash
source /tmp/aeci-1447.env && export CF_LOGPUSH_ONEOFF_TOKEN R2_EDGE_LOG_ACCESS_KEY_ID R2_EDGE_LOG_SECRET_ACCESS_KEY && python3 - <<'EOF'
import json, os, urllib.request
zone = "2246ff6dadcf91ea2d8a0160427b23ac"
account = "004dc1af737b22a8aa83b3550fa9b9d3"
here = "scripts/ops/2026-10-edge-log-logpush"
for dataset, name in [("http_requests", "aeci-edge-log-http-requests"), ("firewall_events", "aeci-edge-log-firewall-events")]:
    dest = (f"r2://aeci-edge-log-prod-us/{dataset}/{{DATE}}?account-id={account}"
            f"&access-key-id={os.environ['R2_EDGE_LOG_ACCESS_KEY_ID']}"
            f"&secret-access-key={os.environ['R2_EDGE_LOG_SECRET_ACCESS_KEY']}")
    body = {"name": name, "dataset": dataset, "enabled": True, "destination_conf": dest,
            "output_options": {"output_type": "ndjson", "timestamp_format": "rfc3339", "sample_rate": 1,
                               "field_names": json.load(open(f"{here}/fields-{dataset}.json"))}}
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/zones/{zone}/logpush/jobs", method="POST",
                                 data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + os.environ["CF_LOGPUSH_ONEOFF_TOKEN"], "Content-Type": "application/json"})
    res = json.load(urllib.request.urlopen(req))
    print(dataset, res["success"], res["errors"], (res.get("result") or {}).get("id"))
EOF
```

Health, for either job id:

```bash
source /tmp/aeci-1447.env
curl -s "https://api.cloudflare.com/client/v4/zones/2246ff6dadcf91ea2d8a0160427b23ac/logpush/jobs/1978506" -H "Authorization: Bearer $CF_LOGPUSH_ONEOFF_TOKEN" | jq '.result | {id, dataset, enabled, last_complete, last_error, error_message}'
```

## 4. Notification

The alert type is `failing_logpush_job_disabled_alert` ("Failing Logpush Job Disabled"). It is an
account alerting policy and needs account Notifications Edit.

```bash
source /tmp/aeci-1447.env
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/004dc1af737b22a8aa83b3550fa9b9d3/alerting/v3/policies" -H "Authorization: Bearer $CF_LOGPUSH_ONEOFF_TOKEN" -H 'Content-Type: application/json' -d '{"name":"AECi edge log: Logpush job disabled","description":"AECI-1447, ADR 0045. Runbook: docs/RUNBOOKS.md Logpush job disabled","alert_type":"failing_logpush_job_disabled_alert","enabled":true,"filters":{},"mechanisms":{"email":[{"id":"chrisw@thewbsproject.com"}]}}'
```

## 5. Day-two check

Read one full UTC day with DuckDB (`docs/ANALYTICS.md` §11a). Use a separate R2 token with Object Read on `aeci-edge-log-prod-us`,
exported as `R2_EDGE_LOG_READ_KEY_ID` and `R2_EDGE_LOG_READ_SECRET`. Do not reuse the writer key pair. Then compare the count with
Cloudflare's own count for the same day and host. The two must agree within 1%.

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET edge (TYPE s3, KEY_ID getenv('R2_EDGE_LOG_READ_KEY_ID'), SECRET getenv('R2_EDGE_LOG_READ_SECRET'), ENDPOINT '004dc1af737b22a8aa83b3550fa9b9d3.r2.cloudflarestorage.com', URL_STYLE 'path', REGION 'auto');
SELECT ClientRequestHost, count(*) AS requests, count(VerifiedBotCategory) FILTER (WHERE VerifiedBotCategory <> '') AS verified_bot_rows
FROM read_json('s3://aeci-edge-log-prod-us/http_requests/20261023/*.log.gz', format = 'newline_delimited')
GROUP BY ALL ORDER BY requests DESC;
```

R2 serves these objects with `Content-Encoding: gzip`. `wrangler r2 object get` hands back plain NDJSON
despite the `.log.gz` name. If DuckDB reports a gzip error, add `compression = 'none'` to `read_json`.
The DuckDB recipe is still untested. The day-two check ran on 2026-10-24 with a read-only Node count over
the S3 API instead, because DuckDB was not installed. Result on AECI-1447: 101,781 `http_requests` rows
against Cloudflare's 101,965 (−0.18%). Firewall events were +4.85%, because Cloudflare's figure is sampled.
`ClientRequestHost` keeps a non-default port, so group on the host with the port stripped.

Check that the columns hold no `ClientIP` and no `BotScore`:

```sql
DESCRIBE SELECT * FROM read_json('s3://aeci-edge-log-prod-us/http_requests/20261023/*.log.gz', format = 'newline_delimited');
```

Cloudflare's count for the same day comes from the read-only GraphQL token:

```bash
curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $CF_READONLY_API_TOKEN" -H 'Content-Type: application/json' -d '{"query":"{ viewer { zones(filter:{zoneTag:\"2246ff6dadcf91ea2d8a0160427b23ac\"}) { httpRequestsAdaptiveGroups(limit: 20, filter:{date: \"2026-10-23\"}) { count dimensions { clientRequestHTTPHost } } } } }"}'
```
