# 2026-09 mechanism_kind re-promote — the AECI-727 tail

**Status: RUN — complete.** Ten serialized re-promotes applied to `aeci-app-production`
2026-09-07, verified. Issue: AECI-766. Data half of AECI-727.

## What was wrong

AECI-698 re-keyed and cleared `mechanism_kind` across the review app but **ran no
re-promote**, so none of it reached the public site. AECI-727 later fixed the promote
contract so a cleared field travels as an explicit `null` (`e3ccc9b`, review repo,
2026-08-31) — but the corrective pass over the already-stale rows was never run.

Production held **16** `integrations` rows reading `mechanism_kind = 'api'`. The review app
held **0**. Every one of the 16 disagreed with curation.

## Divergence from the brief — the set was 16, not 6

`docs/mechanism-backlog-2026-08-31.md` (review repo, `0330931`) scoped Tier 1 as **6 edges /
5 promotes**. That was an undercount, and the issue's own hedge ("Tier 1 set is larger") was
right for a reason nobody had guessed.

The doc's Tier 1 criterion was *"carries a kind the review app has **retracted**"* — i.e. only
rows AECI-698 **cleared to unset**. It never counted the rows AECI-698 **re-keyed to a
different value**. Those were equally never propagated, for the identical reason. AECI-698
split 20 re-keyed / 16 cleared; on promoted products that landed as **10 re-keys + 6 clears**
(plus the 2 Unanet ERP clears already done as the proof case).

The issue also asked whether AECI-712's closing re-promote pass ran. **It did not, and could
not have: AECI-712's batch never ran at all** — only its enabling code shipped. Verified from
live data, not the timeline: `partner` still reads **117**, the exact count recorded on
2026-08-31. AECI-712 contributed nothing to this cohort and has been reopened.

| Edge | was | now |
|---|---|---|
| BigTime PSA → Power BI | `api` | *(NULL)* |
| Deltek Costpoint → Power BI | `api` | *(NULL)* |
| HeavyJob → Microsoft Project | `api` | *(NULL)* |
| HeavyJob → Oracle Primavera P6 | `api` | *(NULL)* |
| Oracle Aconex → Power BI | `api` | *(NULL)* |
| SmartPM → Tableau | `api` | *(NULL)* |
| ADP Workforce Now → busybusy | `api` | `native` |
| Deltek Vantagepoint → ADP Workforce Now | `api` | `iPaaS` |
| Deltek Vantagepoint → BambooHR | `api` | `iPaaS` |
| Deltek Vantagepoint → Paylocity | `api` | `iPaaS` |
| Deltek Vantagepoint → SAP Concur | `api` | `iPaaS` |
| Deltek Vantagepoint → Planifi | `api` | `native` |
| Oracle Fusion Cloud HCM → Microsoft Entra ID | `api` | `native` |
| Oracle Primavera P6 → Octave Sequence Enterprise | `api` | `native` |
| Oracle Primavera P6 → Oracle Aconex | `api` | `native` |
| Ramp → ADP Workforce Now | `api` | `native` |

## The preflight that mattered — table routing

A re-promote carries **every** edge of the product, not just the stale one. Since migration
`0027`, a **resolvable** `powered_by` *routes* a promoted edge between `integrations` and
`connector_evidenced_pairs`, and flipping that routing strands the old row — the defect
cleaned up in `56dae156` (Roofr → QuickBooks) two commits before this run.

Ten edges across these ten products carry a `powered_by` pointing at a **promoted**
connector. All ten were checked before anything was written, and none could move:

- **6 are self-referential** — the connector *is* the far endpoint (Aquifer, Kroo Connector).
  `routesToEvidencedPair` requires `connectorId !== sourceId && connectorId !== targetId`
  (`apps/api/src/routes/promote.ts:2130`), so they stay in `integrations`.
- **4 are the Ramp edges** (via AnyWare Apps / ClearSync: AP) and were **already in
  `connector_evidenced_pairs`** — `0027` moved them, and the promote reads
  `connectorEvidencedPairs` first for a preserved id, so it updates in place.
- Deltek Vantagepoint's 11 `powered_by` links all point at **Blackbox Connector, which is
  `unreviewed`**. It does not resolve, so `connectorId` is `null` and AECI-730's `preserved`
  branch leaves the column alone.

Membership was re-checked after the run: **unchanged, 6 / 4.** Nothing was stranded.

Blast radius was also bounded in advance: all 66 not-yet-live edges on these products have an
unpromoted far endpoint, so **zero new integrations** could be created. Confirmed — the
`integrations` row count is 926 before and after.

## What was run

Ten `promote_product` calls, **serialized**, each polled with `get_promote_status` to a
terminal status before the next. Every one returned `status: ok`, `operation: updated`,
`withheld: []`, `skipped: []`. Job ids and per-step counts are in `promote-jobs.json`.

Order was smallest blast radius first, with a checkpoint after #1 (a clear) and #2 (a re-key)
to prove both behaviours before scaling up:

SmartPM → Oracle Fusion Cloud HCM → BigTime PSA → Deltek Costpoint → Oracle Aconex →
HeavyJob → Oracle Primavera P6 → Ramp → ADP Workforce Now → Deltek Vantagepoint.

Two promotes each fixed an extra edge because promoting *either* endpoint carries it:
Oracle Aconex also carried `Oracle Primavera P6 → Oracle Aconex`, and ADP Workforce Now also
carried `Deltek Vantagepoint → ADP Workforce Now`.

Unlike the 2026-08 and 2026-09 orphan cleanups, this went through the **promote path**, not
raw SQL — so it audited normally and fired the usual post-commit cache purge and Algolia
upsert.

## Verification (2026-09-07, prod)

| Check | Result |
|---|---|
| `SELECT … WHERE mechanism_kind='api'` | **0 rows** (was 16) |
| Per-row expected value, all 16 | **16/16 match** the review app |
| `mechanism_kind` distribution | `api` −16 = `(NULL)` +6, `iPaaS` +4, `native` +6 |
| `integrations` total | 926 → 926 (nothing created or deleted) |
| Powered-edge table membership | 6 `integrations` / 4 `connector_evidenced_pairs`, unchanged |
| `integration_count` on the 10 products | unchanged |
| `db:reconcile-counts` (read-only, production) | `✓ No product-count drift.` |

### Live spot-check (cache-busted, browser UA)

| Page | Expected | Got |
|---|---|---|
| `/products/deltek-vantagepoint/integrations/sap-concur` | `iPaaS` badge | **iPaaS** |
| `/products/smartpm/integrations/tableau` | no kind badge | no kind badge |
| `/products/oracle-aconex/integrations/power-bi` | no kind badge | no kind badge |

The two cleared pages still contain the string "API", twice each — both are the free-text
`description` ("SmartPM's Open API exposes…", "…via the Cost REST APIs…"), rendered once in
HTML and once in the TransferState JSON. That is curation copy, not the mechanism kind, and
is expected to stay.

Note these pages 403 to a default `curl` User-Agent. That is the Cloudflare bot setting on
catalog pages, not our WAF rule — pass a browser UA.

## Tier 2 drift — measured, and the baseline has moved

The issue expected ~24 residual "fingerprint only" products from AECI-727's null-key change.
Measured after this run with the shipped code (`scripts/drift-check.ts` against a
`wrangler d1 export` of `aeci-review`): **195 of 247 promoted products read as drifted.**

That is a rise, not the expected fall, and **it is not AECI-727's fan-out.** The cause is a
later payload-shape change: **`3c34c49` — "Retire the attestation note as a promoted field
(AECI-780)", 2026-09-04**, the review-side counterpart to AECI-779. Dropping a field from the
payload moves the fingerprint of every product carrying an attestation note, which is most of
the catalogue. The evidence is the shape of the distribution — drift is almost exactly
"anything not re-promoted since 2026-09-04":

| last promoted | promoted | drifted |
|---|---|---|
| 2026-08-25 | 111 | 75 |
| 2026-08-26 | 47 | 46 |
| 2026-08-27 | 74 | 72 |
| 2026-08-31 | 1 | 1 |
| 2026-09-07 | 14 | 1 |

All **10 products re-promoted here are clean.** Of the doc's named 24, **3 cleared** (Deltek
Vantagepoint and Oracle Primavera P6 via this run, Procore Project Management separately);
21 remain.

This is still housekeeping — nothing downstream is wrong, because the app stopped reading
`attestations.note` under AECI-779 — and it clears on any future re-promote. **It was left
alone deliberately.** Re-promoting 195 products to clear a badge is a separate decision with
its own blast radius, not something to fold into a 16-row data correction.

Do **not** "fix" this by excluding nulls (or absent keys) from the fingerprint. It is the
tempting fix and it would stop a genuine clear from registering as drift — the same defect
relocated.

## Files

| File | What |
|---|---|
| `preflight-prod-distribution.json` | `mechanism_kind` counts before |
| `preflight-prod-api-rows.json` | the 16 `api` rows before |
| `preflight-review-expected.json` | what the review app says each of the 16 should be |
| `preflight-powered-edge-tables.json` | table membership of the 10 powered edges, before |
| `preflight-integration-counts.json` | `integration_count` for the 10 products, before |
| `promote-jobs.json` | the 10 job ids, operations, per-step `api` countdown |
| `verify-16-rows.json` | the 16 rows after |
| `verify-prod-distribution.json` | `mechanism_kind` counts after |
| `verify-powered-edge-tables.json` | table membership after (unchanged) |
| `verify-integration-counts.json` | `integration_count` after (unchanged) |
| `verify-drift-check-after.txt` | full `drift-check.ts` output, 195 named products |

## Reproducing the reads

```
export CLOUDFLARE_ACCOUNT_ID=e62ec9d8012c3e0c225f8e4dbab76b79
apps/api/node_modules/.bin/wrangler d1 execute aeci-app-production --remote --json --command \
  "SELECT id, COALESCE(mechanism_kind,'(NULL)') k FROM integrations WHERE mechanism_kind='api'"
```

The review app's own D1 is `aeci-review` and answers the same way, which is how the expected
values were derived without 10 MCP round trips.

The drift check needs the review repo at current `origin/main` with deps installed; the
local checkout at `/Users/chris/Documents/dev/apps/aec-integrations-review` was 89 commits
behind and has active Conductor sessions on it, so this run used a throwaway
`git worktree add --detach … origin/main`, removed afterwards. `tsx` is not a dependency
there and had to be added to the worktree.
