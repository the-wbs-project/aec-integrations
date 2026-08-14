# Local tracing — agent-queryable OTel traces in `wrangler dev`

Since **wrangler 4.118.0**, `wrangler dev` captures OpenTelemetry traces for every local
Worker invocation with no SDK, no config, and no code change. `workerd` auto-instruments
handler lifecycle, outbound `fetch()`, and **binding calls (D1, KV, R2, Durable Objects,
Queues)**; Miniflare assembles them into a SQLite-backed trace store and exposes a
**read-only SQL endpoint** over the Local Explorer API.

This repo pins **wrangler ^4.123.0** (AECI-548), which additionally brings batched trace
writes (4.120.0 — lower per-request overhead) and the improved Local Explorer Observability
views, including trace lookup by ID (4.119.0).

**Why it matters here.** The debug loop for a 500 used to be: add a `console.log` → rebuild →
re-curl → read text. With tracing you query the runtime directly and get the failing
statement, its arguments' shape, its timing, and its error — including inside a `db.batch()`,
where the §26.1 audit-row invariant is now *directly observable* instead of inferred.

> **Dev-only.** These traces live in the dev process, are wiped when it exits, and are never
> shipped anywhere. They are unrelated to the Datadog / PostHog production pipes — see
> `docs/OBSERVABILITY.md`.

---

## 1. Getting the endpoint URL — never hardcode 8787

Cloudflare's blog post and docs use `http://localhost:8787`. **That is wrong for this repo.**
`pnpm dev:agent` auto-scans for a free SSR/API port pair starting at **8790/8789**; only
`pnpm dev:conductor` pins **8788/8787**, and that pair belongs to the human's workspace.
Querying `8787` from an agent workspace reads *someone else's* dev server.

**Primary source — wrangler prints it.** When the dev session is running inside a coding
agent, each Worker prints its own hint on boot with the port it actually bound:

```
apps/web dev:preview: Wrangler detected this dev session is running in an AI agent.
apps/web dev:preview: The Local Explorer API is available at http://localhost:8790/cdn-cgi/local/explorer/api
apps/api dev:preview: The Local Explorer API is available at http://localhost:8789/cdn-cgi/local/explorer/api
```

`scripts/dev-launch.sh` also prints the pair on its first line:

```
▶ dev:agent → SSR http://localhost:8790  ·  API :8789 (proxied via http://localhost:8790/api/*)
```

**Fallback — re-derive it** when the dev server was backgrounded and the banner has scrolled
away:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep workerd   # the two ports this workspace owns
```

The canonical path is **`/cdn-cgi/local/explorer/api`**. The older `/cdn-cgi/explorer/api`
from the blog post still resolves (wrangler 4.117.0 added a transparent rewrite), but prefer
the canonical form.

---

## 2. Two Workers means two trace stores — verified

`pnpm dev:bound` (what both `dev:agent` and `dev:conductor` run) starts **two separate
`wrangler dev` processes** via `pnpm --parallel`. Two processes means two Miniflare
instances, and therefore **two independent trace stores on two different ports**:

| Store | Endpoint base | Contains |
|---|---|---|
| SSR Worker | `http://localhost:<WEB_PORT>/cdn-cgi/local/explorer/api` | `service = aeci-web` — the browser-facing request, the WC-4 gateway→`Renderer` hop, and the **outbound** `env.API` fetch |
| API Worker | `http://localhost:<API_PORT>/cdn-cgi/local/explorer/api` | `service = aeci-api-preview` — the **inbound** API request and every D1 / KV span beneath it |

**A request crossing the `env.API` service binding produces two traces, not one.** Trace
context does *not* propagate across the cross-process dev-registry hop. Verified by clearing
both stores, issuing a single `GET /api/health`, and reading back:

```
SSR store  trace_id = 00ac386e1a7901f930e00921497d3701
API store  trace_id = d670913dcb6708877cfab6cd280c6aae
```

So: **when you don't find what you expect, you are probably querying the wrong port.** D1
spans are always on the API store. Recipe 6 below joins the two halves.

---

## 3. Request and response shape

```bash
curl -sX POST "http://localhost:8789/cdn-cgi/local/explorer/api/local/observability/query" \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT service, name, outcome, duration_ms FROM spans WHERE parent_id IS NULL LIMIT 20"}'
```

Body is `{"sql": "...", "params": [...]}` (`params` binds `?` placeholders). The response is
the Cloudflare API envelope:

```jsonc
{
  "success": true,
  "errors": [],
  "messages": [],
  "result": {
    "columns": ["service", "name", "outcome", "duration_ms"],
    "rows": [["aeci-api-preview", "GET", "ok", 540]]
  }
}
```

**`rows` are positional arrays, not objects** — zip them against `result.columns`. A rejected
query comes back as `{"success": false, "errors": [{"code": 10131, "message": "..."}]}` with
HTTP 400.

There is one mutation, useful for isolating a repro:

```bash
curl -sX POST "http://localhost:8789/cdn-cgi/local/explorer/api/local/observability/clear"
```

### A tiny helper

Most of this file's recipes are easier to read through a formatter. Drop this anywhere
(it is not checked in — deliberately, per AECI-548 scope):

```python
# /tmp/q.py — usage: python3 /tmp/q.py 8789 "SELECT ..."
import json, sys, urllib.request
port, sql = sys.argv[1], sys.argv[2]
req = urllib.request.Request(
    f"http://localhost:{port}/cdn-cgi/local/explorer/api/local/observability/query",
    data=json.dumps({"sql": sql}).encode(), headers={"Content-Type": "application/json"})
d = json.load(urllib.request.urlopen(req))
if not d.get("success"):
    print("ERROR:", json.dumps(d["errors"])); raise SystemExit(1)
r = d["result"]
print(" | ".join(r["columns"]))
for row in r["rows"]:
    print(" | ".join("" if v is None else str(v)[:70] for v in row))
```

---

## 4. Schema

```sql
spans(trace_id TEXT, span_id TEXT, parent_id TEXT, service TEXT, name TEXT, kind TEXT,
      start_ms INTEGER, duration_ms INTEGER,   -- NULL while the span is still open
      outcome TEXT, error TEXT, attributes BLOB, created_at TEXT,
      PRIMARY KEY (trace_id, span_id))

logs(trace_id TEXT, span_id TEXT, seq INTEGER, ts_ms INTEGER, level TEXT,
     message TEXT, operation TEXT, created_at TEXT,
     PRIMARY KEY (trace_id, seq))
```

A trace is the root span (`parent_id IS NULL`) plus its subtree. Request-level facts — HTTP
status, CPU/wall time, trigger — live on the **root span's `attributes`**.

`kind` values seen in this repo: `http` (handler invocations), `fetch` (outbound requests,
including the `env.API` binding call, the D1 transport, and the Datadog `ctx.waitUntil`
forwards), and `d1` (`d1_all` / `d1_run` / `d1_batch`).

### Reading `attributes`

`attributes` is **JSONB** — wrap it in `json()` first. Attribute keys contain dots, so the
JSON path segment must be quoted or SQLite reads it as a nested path:

```sql
-- correct
json_extract(json(attributes), '$."db.query.text"')
-- WRONG: parses as $.db → .query → .text, silently returns NULL
json_extract(json(attributes), '$.db.query.text')
```

Attributes worth knowing:

| Attribute | On | Value |
|---|---|---|
| `url.full`, `http.request.method` | `http`, `fetch` | Request line |
| `http.response.status_code` | `http`, `fetch` | **The real status** |
| `faas.invocation_id` | `http` | Distinguishes the WC-4 gateway span from the `Renderer` span |
| `db.query.text` | `d1` | The exact SQL Drizzle generated (all statements, newline-joined, for a batch) |
| `db.operation.name` | `d1` | `raw` / `run` / `batch` |
| `db.operation.batch.size` | `d1_batch` | Statement count |
| `cloudflare.d1.response.rows_read` / `rows_written` / `changes` | `d1` | Post-execution counters |
| `error.type` | any | **The failure message** |

### ⚠️ Failures do not land in `spans.outcome` / `spans.error`

This is the single biggest trap. A request that returned **HTTP 500 because a D1 batch threw**
still records `outcome = 'ok'` and `error = NULL` on **every** span. The failure appears only
in the attributes:

```jsonc
// the d1_batch span of a 500 response
{"db.operation.name": "batch", "db.operation.batch.size": 4,
 "error.type": "no such table: audit_log: SQLITE_ERROR"}
// its root http span
{"http.response.status_code": 500, "cloudflare.outcome": "ok"}
```

So filter on `json_extract(json(attributes), '$."error.type"')` and
`$."http.response.status_code"`. **A `WHERE outcome <> 'ok'` query returns zero rows and looks
like "no failures".**

### Guardrails

- `SELECT` / `WITH` only, **one statement**, no embedded `;` (a single trailing `;` is fine).
- A keyword blacklist rejects `INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH|VACUUM|
  ANALYZE|BEGIN|COMMIT|…`; quoted strings and comments are stripped before the check, so
  `WHERE name LIKE '%DELETE%'` is fine but an unquoted alias `AS create` is not.
- Every statement runs inside a transaction that is always rolled back — the real read-only
  barrier.
- At most **10,000 rows** per response.

---

## 5. Recipes

Every query below was executed against a live `pnpm dev:agent` session. Substitute your own
ports; `8790` = SSR, `8789` = API in these examples.

### 1. Last failed invocations

Catches both a non-2xx status and a swallowed error deeper in the trace.

```sql
SELECT r.trace_id,
       json_extract(json(r.attributes), '$."http.request.method"')       AS method,
       json_extract(json(r.attributes), '$."url.full"')                  AS url,
       json_extract(json(r.attributes), '$."http.response.status_code"') AS status,
       r.duration_ms,
       (SELECT json_extract(json(c.attributes), '$."error.type"')
          FROM spans c
         WHERE c.trace_id = r.trace_id
           AND json_extract(json(c.attributes), '$."error.type"') IS NOT NULL
         LIMIT 1)                                                        AS first_error
FROM spans r
WHERE r.parent_id IS NULL
  AND (json_extract(json(r.attributes), '$."http.response.status_code"') >= 400
       OR r.outcome <> 'ok'
       OR EXISTS (SELECT 1 FROM spans c
                   WHERE c.trace_id = r.trace_id
                     AND json_extract(json(c.attributes), '$."error.type"') IS NOT NULL))
ORDER BY r.start_ms DESC
LIMIT 10
```

```
trace_id                         | method | url                                           | status | duration_ms | first_error
3570434cd536ab60a2a2fdfcc6c6c11a | POST   | http://localhost:8790/api/requests/correction  | 500    | 575         | no such table: audit_log: SQLITE_ERROR
d400d6ddab9a1d8af59d95b951f1840a | GET    | https://api/api/products/does-not-exist-at-all | 404    | 530         |
```

### 2. Slowest D1 calls in one request

```sql
SELECT name,
       duration_ms,
       json_extract(json(attributes), '$."db.operation.name"')                AS op,
       json_extract(json(attributes), '$."cloudflare.d1.response.rows_read"') AS rows_read,
       substr(json_extract(json(attributes), '$."db.query.text"'), 1, 60)     AS query_head
FROM spans
WHERE kind = 'd1' AND trace_id = '<TRACE_ID>'
ORDER BY duration_ms DESC
LIMIT 10
```

```
name     | duration_ms | op    | rows_read | query_head
d1_all   | 4           | raw   | 17        | select "id", "slug", "name", "logo_url", "product_role", "in
d1_all   | 1           | raw   | 1         | select "id" from "products" "products" where "products"."id"
d1_run   | 1           | run   | 3         | insert into "page_views" ("id", "path", "product_id", "vendo
d1_batch | 1           | batch | 6         | insert into "vendor_requests" ("id", "kind", "target_type",
```

Drop the `trace_id` predicate to rank across the whole session.

### 3. Every span in one trace, as a tree

```sql
WITH RECURSIVE tree(span_id, parent_id, name, kind, duration_ms, depth, ord) AS (
  SELECT span_id, parent_id, name, kind, duration_ms, 0, start_ms
    FROM spans WHERE trace_id = '<TRACE_ID>' AND parent_id IS NULL
  UNION ALL
  SELECT s.span_id, s.parent_id, s.name, s.kind, s.duration_ms, t.depth + 1, s.start_ms
    FROM spans s JOIN tree t ON s.parent_id = t.span_id
   WHERE s.trace_id = '<TRACE_ID>'
)
SELECT printf('%s%s', substr('                ', 1, depth * 2), name) AS span,
       kind, duration_ms
FROM tree ORDER BY depth, ord
```

```
span       | kind  | duration_ms
POST       | http  | 575
  d1_all   | d1    | 1
  d1_batch | d1    | 1
  d1_all   | d1    | 0
  fetch    | fetch | 570
  fetch    | fetch | 521
    fetch  | fetch | 1
```

### 4. Console output for a trace

`console.*` from the Worker is captured in `logs` — you can read logs that already exist
without re-running anything.

```sql
SELECT l.seq, l.level, s.name AS span, l.message
FROM logs l
LEFT JOIN spans s ON s.trace_id = l.trace_id AND s.span_id = l.span_id
WHERE l.trace_id = '<TRACE_ID>'
ORDER BY l.seq
```

```
seq | level | span | message
0   | error | POST | ["Unhandled error in /api/requests/correction:","Error: D1_ERROR: no such table: audit_log: SQLITE_ERROR"]
1   | info  | POST | "POST http://localhost:8790/api/requests/correction"
```

### 5. The `db.batch()` audit-row invariant (§26.1)

Every state-changing write must carry its `audit_log` insert in the **same** batch. The batch
span makes that checkable per request.

```sql
SELECT trace_id,
       json_extract(json(attributes), '$."db.operation.batch.size"') AS stmts,
       CASE WHEN json_extract(json(attributes), '$."db.query.text"') LIKE '%insert into "audit_log"%'
            THEN 'yes' ELSE 'NO — §26.1 VIOLATION' END               AS audit_row_in_batch,
       COALESCE(json_extract(json(attributes), '$."error.type"'), 'committed') AS result
FROM spans
WHERE kind = 'd1' AND name = 'd1_batch'
ORDER BY start_ms DESC
LIMIT 10
```

```
trace_id                         | stmts | audit_row_in_batch | result
3570434cd536ab60a2a2fdfcc6c6c11a | 4     | yes                | no such table: audit_log: SQLITE_ERROR
0fe83b91679ed222ae01eaccccd0a0ed | 4     | yes                | committed
```

### 6. Correlating the two Workers across `env.API`

The trace IDs differ, but the SSR Worker's **outbound `fetch` span** and the API Worker's
**root span** share `url.full` and overlap in `start_ms`. That is the join key.

Step 1 — on the **SSR** store, find the binding call:

```sql
SELECT trace_id, name, kind, duration_ms, start_ms,
       json_extract(json(attributes), '$."url.full"')                  AS url,
       json_extract(json(attributes), '$."http.response.status_code"') AS status
FROM spans
WHERE kind = 'fetch'
  AND json_extract(json(attributes), '$."url.full"') LIKE 'https://api/%'
ORDER BY start_ms DESC LIMIT 10
```

Step 2 — on the **API** store, match the URL and window:

```sql
SELECT trace_id, name, duration_ms, start_ms,
       json_extract(json(attributes), '$."url.full"')                  AS url,
       json_extract(json(attributes), '$."http.response.status_code"') AS status
FROM spans
WHERE parent_id IS NULL
  AND json_extract(json(attributes), '$."url.full"') = '<url from step 1>'
ORDER BY start_ms DESC LIMIT 5
```

One `GET /products/fixture-procore`, both halves:

```
SSR (:8790)  fetch  https://api/api/products/fixture-procore  200  17ms   start_ms 1786678922241
API (:8789)  GET    https://api/api/products/fixture-procore  200  532ms  start_ms 1786678922243
```

Two URL forms show up, and they are not interchangeable:

- The SSR `/api/*` **passthrough** forwards the request untouched, so the API root span's
  `url.full` is the browser-facing `http://localhost:<WEB_PORT>/api/...`.
- An SSR **resolver's** internal API call goes out as `https://api/api/...`.

Take the URL from step 1 rather than assuming which form applies.

---

## 6. Turning it off

Capture is on by default (wrangler 4.118.0+). Set `X_LOCAL_OBSERVABILITY=false` to disable
it — the upstream escape hatch for multi-process dev-registry setups, which is exactly what
`pnpm dev:bound` is:

```bash
DEV_SKIP_BUILD=1 X_LOCAL_OBSERVABILITY=false pnpm dev:agent
```

With capture disabled the query endpoint answers HTTP 404:

```jsonc
{"success": false, "errors": [{"code": 10130,
  "message": "Local observability is not enabled for this dev session."}], "result": null}
```

**Measured cost.** `pnpm dev:agent`, warm, 20× `GET /api/health` (crosses the `env.API`
binding and runs a D1 `SELECT 1`):

| | median | min |
|---|---|---|
| capture on | 6.1 ms | 4.2 ms |
| capture off | 4.0 ms | 3.0 ms |

≈2 ms per request, and boot time was indistinguishable. Trace writes have been batched since
wrangler 4.120.0, and the store held only ~120 span rows across a full manual exploration
session. The overhead is not something you need to manage — reach for the flag only if the
collector actually misbehaves.

`X_LOCAL_EXPLORER=false` disables the Local Explorer (UI **and** API) entirely.

---

## 7. Local traces vs. the production stack

| | Local tracing (this doc) | Datadog / PostHog (`docs/OBSERVABILITY.md`) |
|---|---|---|
| Where | Inside the `wrangler dev` process | Deployed tiers |
| Lifetime | Wiped when the dev server exits | 7–15 day retention |
| Transport | None — never leaves the machine | HTTP intake, `ctx.waitUntil` |
| Content | Every span of every local request | Curated `aeci.*` metric catalog + gated logs |
| Configured by | Nothing — automatic | `wrangler.jsonc` vars + `DD_API_KEY` / `POSTHOG_KEY` secrets |

They are complementary, not alternatives. Do not add local-trace assumptions to a Datadog
dashboard, and do not expect a local span to explain deployed behaviour.

One overlap is worth knowing: because the Datadog forwards run through `ctx.waitUntil`, they
show up in local traces as outbound `fetch` spans to `http-intake.logs.us5.datadoghq.com` and
`api.us5.datadoghq.com`. That is a handy way to confirm the §26.5 forwards actually fire
without reading any Datadog UI.

---

## References

- `CLAUDE.md` §"Build and dev workflow" — the short version and the port rules
- `docs/OBSERVABILITY.md` — the production Datadog/PostHog pipes
- [Local Explorer](https://developers.cloudflare.com/workers/local-development/local-explorer/) ·
  [Your agent can now debug Workers with local tracing](https://blog.cloudflare.com/local-tracing/)
- AECI-548
