# Catalog runbooks

Procedures for the catalog and the review app upstream of it: promote jobs, the strand audit, retractions,
the ownership mirror, removal requests and slug renames. The governing docs are
`docs/REVIEW_APP_PROMOTE_API.md`, ADR 0021, ADR 0030 and ADR 0044. Alert runbooks for everything else are
in [`RUNBOOKS.md`](./RUNBOOKS.md). Keep the heading anchors stable: other docs and code cite them by name.

## Promote job errored or stuck

**Signal:** `aeci.api.promote.job{outcome:errored}` (with a `code` tag), the
`aeci.api.promote.job_failed` error log, or `aeci.api.promote.job.duration_ms` running long.
There is **no alert on this on either plane** — promote volume is a handful per day, so the trigger
is usually a curator reporting "the promote never finished". It is not among the 26 dispositioned
monitors and it is not in `observability/posthog/alerts.json`, so the cutover changes nothing here.
(AECI-563 / ADR 0021.)

**What it means:** since AECI-563 `POST /api/promote` only *starts* the ingest. The commit runs
in the `PROMOTE_WORKFLOW` Cloudflare Workflow, one instance per promote, whose **instance id is
the review-app-supplied `promote_job_id`**. A failure never surfaces as an HTTP status to the
caller — it lands as `{ status: 'errored', error: { code } }` on `GET /api/promote/jobs/:id` and
as the log above. An `errored` job **wrote nothing**: the ingest is one atomic `db.batch`, so
there is no partial state to clean up.

**First checks**

1. **Get the job id.** From the curator (the review app's product row `promote_job_id`), or from the
   `job_id` attribute on the `aeci.api.promote.job_failed` log
   (`service:aeci-api source:review-app-promote`).
2. **Read the job.** Either the API (`GET /api/promote/jobs/{jobId}` with the
   `REVIEW_APP_TOKEN` bearer) or the Cloudflare dashboard → **Workers & Pages → Workflows →
   `aeci-promote-<env>`** → the instance. The dashboard shows the per-step history, which the
   API does not.
3. **Which code?**
   - `SLUG_CONFLICT` — two first-time promotes raced for the same slug. Benign and
     caller-resolvable: re-push with a **new** job id and slug disambiguation (`-2`, `-3`) will
     settle it.
   - `VALIDATION_FAILED` — a product name that can't be turned into a slug (reserved or empty
     after normalization). Needs the name fixed in the review app.
   - `INTERNAL_ERROR` — a real fault. Read the log's `reason` (D1 errors put the detail in the
     `cause` chain) and the step history.
4. **Stuck rather than failed?** A job sitting in `running` far longer than
   `aeci.api.promote.job.duration_ms`'s normal range is usually a slow plan phase on a
   heavily-integrated product (many sequential D1 reads) — not a hang. The commit step has a
   10-minute timeout, after which the instance errors. A job stuck in `queued` means the
   account is at its concurrent-instance ceiling, which our volume will not reach.
5. **Was it even started?** A poll returning `404` means AECi has no record of the id: either
   the kick-off never succeeded (check for a 4xx/5xx `source:review-app-promote` log with that
   window's `trace_id`) or the job is past its retention (30 days for the instance, 90 for the
   KV result mirror).

**Repair**

- **Normal path — let the review app re-push.** A new job id, same bundle. Because an `errored`
  job wrote nothing, this is safe and is the expected remedy for every code above.
  **One exception (AECI-571):** an `errored` job whose reason reads *"has already committed, but
  its stored result is unreadable"* **did** write. Its rows are live. Do **not** re-push — recover
  the ID map from the KV mirror (`promote:result:{jobId}`) or straight from D1
  (`SELECT result FROM promote_jobs WHERE job_id = '…'`) and hand it to the write-back. This is
  the only `errored` promote that ever committed, and it means the ledger row itself is corrupt;
  escalate it.
- **The IDs committed but the review app never collected them** (the exact class of damage this
  design exists to prevent): poll the job id; a `complete` job still serves its full ID map, so
  the write-back can be re-run. This is what the review-app reconcile sweep (AECI-570) automates.
- **`restart()` no longer risks a duplicate (AECI-571), but is still not a retry.** If the commit
  already succeeded, a restart replays it, trips the `promote_jobs` primary key, rolls back, and
  returns the recorded ID map — which makes it the fastest way to recover an instance that is
  wedged *after* a silently-successful commit. It is still **not** the remedy for a genuinely
  failed commit: the step is deliberately non-retried (`NonRetryableError`), and a failure that
  reproduces will simply fail again. Re-push with a new job id for that.
- **`terminate()`** an instance only to clear a genuinely wedged job, and note that the id is then
  permanently consumed for its retention window — the review app must use a new one.

**Escalation:** repeated `INTERNAL_ERROR`s across different products point at the ingest itself
(`apps/api/src/routes/promote.ts`) or at D1 — capture the job id, the `reason`, and the step
history. Repeated `SLUG_CONFLICT`s with no concurrency suggest a slug-generation regression, not
a race.

**Duplicate safety (AECI-571).** Workflows guarantee a step runs *at least* once, so an engine
crash between the `db.batch` committing and the step result being persisted replays the commit.
That used to be able to duplicate a **created** row; it can't any more. The ingest writes a
`promote_jobs` row keyed by the job id as the first statement of the promote's own batch, so a
replayed batch trips the primary key, D1 rolls the whole batch back, and the recorded ID map is
returned instead — same ids, same slug.

- `sum:aeci.api.promote.replay` is non-zero **exactly when the window fired and was absorbed**.
  This is informational, not actionable: the promote is correct. Capture the `job_id` from the
  `aeci.api.promote.replay_detected` log if you want the step history, and note the `via` tag
  (`pre-read` = the ordinary replay, `batch-conflict` = a replay that raced the original batch).
- A duplicated product whose promote job reported `complete` exactly once is now a **bug**, not
  the known gap. Capture the job id and the instance's step history and escalate.

**Pruning the ledger.** `promote_jobs` grows by a handful of ~10 KB rows a day and has no
automatic prune (deliberately — see `DATABASE_SCHEMA.md` §8.5). If it ever needs one:

```sql
DELETE FROM promote_jobs WHERE created_at < datetime('now', '-180 days');
```

**The floor is 90 days, hard.** Below that the guard expires before the `promote:result:{jobId}`
KV mirror it backstops, leaving a window where a poll still serves IDs while a re-push of that
job id would duplicate them.

---

## Promote strand audit is red

> **Rewritten 2026-09-08 (AECI-796). Read this before triaging an old run.** Between
> 2026-08-13 and 2026-09-06 this workflow read Airtable and **skipped green** when
> `AIRTABLE_TOKEN` was absent. That secret was never provisioned, so all 25 scheduled runs
> reported success having audited nothing — and the secret was not the fix either, because
> the review app had moved off Airtable onto its own D1, leaving the transport pointed at a
> decommissioned system. The job now runs `scripts/ops/2026-09-stranded-row-audit/` over
> `AECI_MCP_TOKEN`, with **no skip branch**, and its buckets are the six below rather than
> the five Airtable-shaped ones it used to report. A green run before 2026-09-08 is evidence
> of nothing.

**Signal:** the daily `promote-strand-audit` GitHub Action (09:00 UTC, `.github/workflows/promote-strand-audit.yml`)
exits non-zero. There is no monitor on either plane — the workflow's own red **is** the alert, the
same pattern the AECI-647 cron liveness sweep uses for absence detection, and for the same
reason: the check has to live outside the system it is checking. (AECI-568 / AECI-593 / AECI-796.)

**Which red is this? Check the exit code first — they are different problems.**

| Exit | Meaning | What to do |
|---|---|---|
| `1` | Stranded rows found. Production holds a row no upstream record claims. | Triage below. |
| `2` | The audit **could not run**: a missing credential, an incomplete sweep, or a crash. | The catalog is **unverified, not clean**. Fix the run, then re-dispatch. Do not close this as a pass. |

An exit 2 on a missing `AECI_MCP_TOKEN` means the repo secret is absent — add it under
Settings → Secrets and variables → Actions. An exit 2 with buckets printed means the sweep
could not read part of upstream (`unresolvedUpstream` non-empty) or its product classes did
not reconcile; the bucket list is untrustworthy in both directions, so re-run rather than
triaging it.

**What it means:** production D1 and the review app's curation catalog disagree about which rows
exist. The only link between them is the `supabase_*_id` column the review app holds — D1 stores no
curation-tool key (AECI-562 was rejected deliberately) — so one broken pointer makes a live row
permanently unreachable. Which bucket fired tells you what broke:

| Bucket | Meaning |
|---|---|
| `integrationSourceGone` | An `integrations` edge no upstream record claims. **The common one.** |
| `evidencedPairSourceGone` | A `connector_evidenced_pairs` edge no upstream record claims. **New 2026-09-14 (AECI-897)** — this table was counted but never classified, which is why the job read green on 2026-09-10 and 2026-09-11 with 215 retracted pairs live. **Its repair is not the same as the others, and it has two routes — see below.** Its first two findings were both real and were retracted the same day (AECI-916). |
| `integrationEndpointStranded` | An edge whose endpoint, connector or builder is itself stranded. Falls out with that row. Spans **both** anchor tables; read the entry's `table` field. |
| `productDeletedUpstream` | A D1 product no upstream record claims at all. |
| `productRejectedUpstream` | A D1 product whose upstream record is `rejected` — promoted once, then rejected, never retracted here. |
| `vendorSourceGone` | A D1 vendor whose upstream record is gone. |
| `vendorNoLiveProducts` | A D1 vendor whose products have all moved to another vendor. Usually a re-parenting that left the old row behind. |

`orphanChildren` is reported alongside them as cascade weight (claims and attestations that
would go with the rows), not as a bucket — it does not affect the exit code. It reads **both**
`claims.integration_id` and `claims.connector_evidenced_pair_id` since AECI-897; before that it
reported zero cascade for every pair finding, understating the cost of a retraction by exactly
the rows that make one dangerous.

Every edge finding also carries `table` and, where one exists, `twin` — the row on the *other*
anchor table covering the same product pair. A twin is **not** by itself a defect: under the
Addendum C model a pair can legitimately carry both a delivered edge and a connector-delivered
one, and two production pairs do. Only "both tables, one unreferenced upstream" is the strand
shape, which is the AECI-888 signature.

> **`evidencedPairSourceGone` has a repair tool since 2026-09-14 (AECI-916), and which route
> you take is a question about the UPSTREAM record. Do not hand-DELETE either way.** The
> datatool prune cannot touch `connector_evidenced_pairs`. `ops:retract-product` deletes (and
> tombstones) them only as a side effect of retracting an endpoint or connector product, and
> only under `--delete-evidenced-pairs`, which `--force` does not imply (AECI-687, AECI-904), and never for a vendor-held pair, flag or not (AECI-1088). The plan re-checks that at write time and aborts before any write if a pair was claimed after the dry run. The CLI then says a vendor-held row entered scope and nothing was written, and exits `1`. It does not mean a credentials problem. So it is not a tool for one stranded pair. The retraction consumer is,
> and it takes two cohorts:
>
> - **Route A, the upstream record still exists — prefer this.** Confirm the ruling, have the
>   curator delete the record so the journal carries it, then run the consumer normally. It
>   preserves the curator's own words, which beats an operator's reconstruction.
> - **Route B, no upstream record and no journal entry.** Write a committed ruling file and run
>   `consume.mjs --env production --ruling <file>`. Same guards, same `audit_log` row per id,
>   same count repair, same rollback; `confirm_retractions` is never called and the run refuses
>   if the journal is non-empty.
>
> **This runbook used to prescribe route A only, and that was a real defect, not a stale
> sentence.** A journal entry is written only when the deleted upstream record carried a
> `supabase_integration_id` — and a strand is by definition a row nothing upstream points at.
> So for the rows this bucket finds most often, "have the curator delete the record" reaches a
> record that is already gone or was never linked, and journals nothing. AECI-916 is the worked
> case: the route closed under the issue while it was open, three days after it was written
> down. Raw SQL is still wrong in both routes — it skips the `audit_log` row and the
> `integration_count` reconcile, which is what made the 2026-09-07 cleanup a one-off nobody can
> replay, and under route B that audit row is the *only* surviving account of the deletion.
>
> **The bar has not moved.** A finding here is still a curation judgement; the escalation path
> below still applies. What changed is that executing a ruling no longer requires raw SQL.
> Format, refusals and the worked example: `scripts/ops/2026-09-retraction-consumer/README.md`
> §"Operator-ruling mode".

**First checks**

1. **Re-run locally for the full per-bucket dump** (the CI log prints the table and the ids; the
   report file and id list go to `RUNNER_TEMP` and are not uploaded):
   ```bash
   AECI_MCP_TOKEN=<token> CLOUDFLARE_API_TOKEN=<token> \
     node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production --refresh-cache
   ```
2. **`integrationSourceGone`: was this an editorial retraction, or duplicate residue?** Read the affected
   product's upstream `research_notes` and `tool_integration_check_notes` *before* anything
   else, and read the notes on any **surviving sibling row** too — a merge ruling is recorded
   on the survivor, not on the row that went away. All three shapes below flip the repair from
   "adopt" to "delete", and there are now three worked examples, executed end to end (plan →
   rollback → audit row → delete → count repair → Algolia → re-audit):
   - `scripts/ops/2026-09-polycam-retraction/README.md` — **editorial retraction**. The row
     was the only copy; the guards tripped and were correctly overridden.
   - `scripts/ops/2026-09-procore-followup-retraction/README.md` — **duplicate residue** from
     an upstream merge. The guards *also* tripped, and this time they were wrong to:
     `orphansWithoutATwin` is orientation-blind, so it could not see the surviving reverse
     twin. Use it as the reminder that the guard sheet cannot classify a stray on its own.
   - `scripts/ops/2026-09-dynamics-monday-retraction/README.md` — **no ruling on either side.**
     This is the case the other two do not cover, and the one the "Escalation" note below is
     written for. Read it before concluding that a missing note means you must stop
     indefinitely: escalating produced a ruling, the ruling was recorded on the issue and in
     the `audit_log` row as `no_upstream_ruling: true`, and the delete then proceeded. A
     plausible cause was visible in the row's own data and was deliberately **not** asserted,
     because consistency is not causation.
3. **`productRejectedUpstream` is not automatically a delete.** A rejected upstream record
   means the curator ruled against the product *after* it was promoted, so the D1 row is
   almost certainly residue — but read the ruling, because rejection and retraction are
   recorded differently and only `find_product` with `include_rejected` can see the record
   at all.

> **The retired `pendingJobMarkers` bucket.** The Airtable-era audit also reported uncollected
> `promote_job_id` markers, which doubled as the liveness check for the AECI-570 hourly
> reconcile sweep. The current audit does not compute it. If you are chasing a stuck job, go
> to "Promote job errored or stuck" above; never clear the marker by hand, it is the recovery
> handle and a `complete` job still serves its full ID map.

**Repair**

Every bucket's recipe lives in `scripts/ops/2026-08-promote-strand-audit/README.md` §Healing.
That lane is **retired** — its `audit.mjs` was deleted on 2026-09-08 — but the README is kept
precisely for this section, and the reasoning survives the transport change. Its bucket *names*
are the old five; map `stray` onto `integrationSourceGone` / `productDeletedUpstream` as you
read. The audit itself has no `--apply` and never writes. Two things worth repeating here:

- **A stranded row is a curation judgement, not a mechanical delete.** Adopt (recreate the
  upstream record carrying the existing uuid) or delete (datatool `POST /api/prune-integrations`).
  **A tripped guard is not evidence in either direction.** `orphansWithoutATwin` matches on
  `(source_product_id, target_product_id, mechanism_name)` and is orientation-blind, so it reports
  "no twin" on a reverse-orientation duplicate that plainly has one; `claimsUniqueToOrphans`
  inherits that plus an exact `direction` match. AECI-794 is the worked case — both guards tripped
  on a row that really was redundant residue. Go to the claim data and the upstream ruling
  (`docs/REVIEW_APP_PROMOTE_API.md` §5.1). With a ruling, acknowledge exactly the guards the dry
  run reported plus an `acknowledgeReason`; save `rollbackSql` first (`apps/datatool/README.md`).
- **A prune does not recompute `stats_cache`.** After deleting integrations the home-page totals
  read high until the next promote of any product triggers the debounced home-stats refresh
  (about a minute later, AECI-1509) or the 07:00 UTC cron runs. Harmless and self-healing; only
  chase it if no promote is expected soon.

**Root cause, and why this job exists:** promote can create and update but **never retracts**
(`docs/REVIEW_APP_PROMOTE_API.md` §5.1) — it deletes only rows a payload names by id, never rows
a payload merely omits. A curator deleting an upstream record therefore always
strands the D1 row, and destroys the only pointer that could have found it. Nothing in the promote
path can guard that, so this scheduled audit is the backstop. The other half shipped in
**AECI-882** — the review app's `list_retractions` feed, which says *why* a record went away — and
it runs as this job's seventh bucket rather than as a separate job. A feed only journals forward,
so this stock check stays; see the next section for what a non-zero `pendingRetractions` means.

**Escalation:** a stranded row with no recorded ruling and no obvious curator action is a real unknown
— do **not** delete to make the audit green. Capture the ids and the affected pair pages, and
raise it with whoever owns the catalog.

**Escalating is a step, not a dead end.** AECI-795 is the worked example (`scripts/ops/2026-09-dynamics-monday-retraction/`).
The catalog owner answered "no upstream record and no defence; if the edge is real it should be
re-materialised deliberately with current evidence, not adopted from a stranded row", and that
answer *is* the ruling. Three things make it safe to act on:

- **Record the absence, not a guess.** The `audit_log` row carries `no_upstream_ruling: true`
  and names the escalation as the ruling source, so a future auditor sees that nothing was
  found rather than assuming nobody looked.
- **Do not promote a hypothesis to a cause.** That row's own data pointed hard at one
  explanation and it was still filed as `suspected_cause.asserted: false`, because nothing
  recorded why the row actually went.
- **Adoption is the riskier exit when there is no note.** Creating an upstream record to justify
  a live row whose only evidence is that it exists gets the direction backwards.


---

## `pendingRetractions` is non-zero

**Signal:** the daily `promote-strand-audit` is red and the `pendingRetractions` bucket is the
non-zero one. Every other bucket may be clean; this is a different class of finding.

**What it means:** a curator deleted a record upstream, and the public row it produced is still
live here. Promote cannot remove it (§5.1), so the only way it goes is the consumer.

**This bucket is the exception to "never delete a row to make this job green".** That rule exists
because a stranded row might be correct and you cannot tell without a ruling. Here the ruling
**already exists** — it is on the journal entry, in the curator's own words, and the run prints
it. You are executing a decision, not making one.

**Triage:**

1. Read the entry's `reason` in the audit output. If it does not justify a delete, stop and raise
   it — a retraction with an unconvincing reason is an upstream problem, not a D1 one.
1a. Check the entry's `entity`. The consumer handles **`integration` only** and parks everything
   else, so a `product` entry will never clear through it — that one goes through
   `pnpm --filter @aeci/api ops:retract-product`, and its journal entry stays pending (and the
   bucket stays non-zero) until someone confirms it separately. `vendor` never appears: AECI-685
   refuses the upstream delete while a supabase id is attached.
   If the dry run lists a **live subscription** on the product, it refuses without `--force`
   (AECI-1350). Retracting the product frees a Managed slot the vendor pays for. Tell the vendor,
   or move the subscription to another product, before you re-run with `--force`. With `--force` every
   subscription on the product is unassigned and keeps its billing account. Each one gets a
   `license.unassigned` audit row in the same batch. An ended subscription never blocks.
2. Dry-run the consumer. It resolves each `supabaseId` against **both** delivered-tier tables and
   prints the plan, the cascade, the affected products and the rollback path.
   ```
   node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
   ```
3. If the plan looks right, execute it with the count the dry run reported:
   ```
   node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count <N>
   ```
4. Afterwards: `db:reconcile-algolia-drift -- --env production` to measure orphans (purge with
   `--apply --allow-production`), then `db:reconcile-counts -- --fix --allow-production` as an
   independent check on the count repair.

**Three things to know before you run it:**

- **Never confirm an entry you have not deleted.** `confirm_retractions` stamps `synced_at` and
  the entry leaves the feed, which holds the only copy of the row's `supabaseId`. Confirming
  early loses a live public row permanently. The script enforces the order; do not route around
  it. The opposite mistake is harmless — an unconfirmed entry is just re-reported.
- **A product retracted by hand still opens an entry.** The order for a product is
  `ops:retract-product` first, then `delete_product` upstream. That delete opens a journal entry
  for a row that is already gone, and the consumer parks product entries. Read back the 404, then
  call `confirm_retractions` on that entry yourself, or the next audit goes red. Worked example:
  `scripts/ops/2026-10-cove-retraction/README.md` (AECI-1496).
- **A held entry is not a finding.** Entries on the script's `HELD_RETRACTIONS` list are printed
  with their reason and do not fail the run. If the job is red, something *new* arrived.
  - **The list is EMPTY as of 2026-09-14 (AECI-909).** The two Agave holds were released and their
    rows deleted, verified and confirmed, so every entry the bucket now reports is unhandled. A
    non-zero `pendingRetractions` today means run the consumer, not "check the hold list".
  - **If you add a hold, delete it in the same change as the run that releases it.** A discharged
    hold left in place is worse than no hold: the bucket reports a steady count, the job stays
    green, and the next retraction sits invisible behind ids nobody re-reads. The two Agave holds
    are the worked example of doing it right — each named its release condition, that condition
    was evaluated against live evidence, and the map was emptied the same day.
  - **Write a release condition you can actually evaluate.** The Agave wording had to be corrected
    once: "when AECI-891 ships" would have held those two forever, because that issue delivers the
    claim *anchor* while the reach-tier *render* is AECI-716 and is still unbuilt. The condition
    that worked named two checkable facts — AECI-891 live in production, and the re-anchored claims
    counted in production D1. `REVIEW_APP_PROMOTE_API.md` §5.1.
- **A parked entry is not a consumer job.** Anything whose `entity` is not `integration` is
  reported and then left alone — never deleted, never confirmed. That is deliberate: a `product`
  entry resolves against neither delivered-tier table, so to the consumer it is indistinguishable
  from an edge that is already gone, and confirming it would discard the curator's ruling while
  the live row stayed. Leaving it pending is the harmless direction.
- **A refusal is the script working.** It stops rather than adapting when the resolved shape
  differs from the recorded ruling, when the cascade exceeds its ceiling, when a held id has
  vanished, when an id is in both tables, or when the sentinel edge moves. Re-establish the
  ruling before editing a constant to make it proceed.
- **Expect the first refusal, every time.** `EXPECTED` and `MAX_CASCADE` rest at zero between
  cohorts (reset 2026-09-14, AECI-909), so a new cohort refuses on the shape gate before it can
  delete anything. That is not production having moved unexpectedly — it is the lane asking you
  to measure this cohort and pin it. Reset both to zero again in the same change as the run that
  used them, for the same reason you empty a discharged hold: a spent authorisation left in the
  file would clear a later cohort of the same shape with nobody ruling on it. Raising
  `MAX_CASCADE` is the one edit that can destroy data, so raise it only after confirming by count
  that every claim it will cascade away already exists somewhere else.

**Residue that is normal:** `stats_cache` reads high until the 07:00 cron, and `metrics_daily`
history keeps the pre-delete totals (ADR 0027 — a snapshot is corrected, not final). A retracted
pair leaves a **noindexed empty pair page, not a 404** — and, unlike a re-pointed endpoint,
not a redirect either. AECI-953 301s an emptied pair only when `integration_endpoint_moves`
says the edge moved somewhere; a retraction deletes the edge, writes no move row, and has
nowhere to point.

**Retracting a PRODUCT is the other case, and it 404s unless you seed a mapping.** Every
pair URL under a deleted product 404s — the pair read checks that both slugs resolve to
rows before it uses any other result (its one `db.batch` runs every statement, AECI-1506). If the product was merged into another (rather than simply removed), add
its `slug_redirects` row and every `/products/{retired}/integrations/*` URL 301s onto the
survivor's pair page instead (AECI-991, `STAGE_1_5_SPEC.md` §7.2b). The row can be seeded
before or after the retraction: a live product row always beats a mapping, so an early
seed is inert rather than harmful. Move rows themselves no longer cascade away with the
product — that was the AECI-991 defect, and `apps/api/src/test/d1.spec.ts` pins the
absence of the foreign key that caused it.

---

## Ownership records not reaching the review app

Not a paging alert yet. Use this when the review app shows a vendor's records as editable
after a claim approval, or when `aeci.ownership_sync.delivery` shows anything but
`delivered` and `stale` (AECI-1418, `REVIEW_APP_PROMOTE_API.md` §4d).

**Read the ledger first.** Every delivery attempt is one `ownership_sync_deliveries` row
(`DATABASE_SCHEMA.md` §9.14). The `--filter` runs it in `apps/api`, so `--env production`
resolves the binding from `wrangler.jsonc`. Put the vendor's id in place of `VENDOR_UUID`.

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --command "SELECT created_at, reason, attempt, outcome, http_status, error FROM ownership_sync_deliveries WHERE vendor_id = 'VENDOR_UUID' ORDER BY created_at DESC LIMIT 10"
```

| Latest outcome | Meaning | Do |
|---|---|---|
| `unconfigured` | The tier has no `REVIEW_APP_OWNERSHIP_URL` or `_TOKEN`. Expected on staging and demo. On production a promote cannot ship without both (AECI-1427), so a secret was deleted out of band | Restore both (`environments.md` "Ownership receiver per tier"), promote, then re-send the vendor |
| `permanent` with `401` or `403` | The token does not match the review app's | Rotate the pair on both sides, then re-send |
| `permanent` with `404` | The review app has never stored this vendor id. The daily `ownership_sync_unknown_vendor` data-quality check (`warn`) lists it too | Expected for a vendor the review app never promoted. Otherwise check the id mapping in the review app, then re-send |
| `exhausted` | Six attempts over about 15 minutes all failed with a retryable status | Check the review app is up, then re-send |
| no row at all | The message was never enqueued (`aeci.ownership_sync.enqueue{outcome:failed}` or `unbound`) | Re-send |
| no row, with `aeci.ownership_sync.delivery{outcome:read_failed}` | The record could not be built. Either D1 failed, or under v2 (`REVIEW_APP_MIRROR_SCHEMA` = `"2"`) a stored value fails its v2 content schema. The warn, or the error on the last attempt, carries the Zod issue and its field path | Fix the stored value in the live app, then re-send |

**Re-send one vendor.** The record is the whole current state, so a re-send is always safe.
Read the queue id, dry-run, then apply with that id in place of `QUEUE_ID`. Production needs Chris's go-ahead.

```bash
pnpm --filter @aeci/api exec wrangler queues info aeci-ownership-sync-production
pnpm --filter @aeci/api ops:backfill-ownership-sync -- --env production --vendor VENDOR_UUID
pnpm --filter @aeci/api ops:backfill-ownership-sync -- --env production --vendor VENDOR_UUID --apply --allow-production --queue-id QUEUE_ID
```

**The first backfill (ruling Q7).** The same script without `--vendor` sends one message per
vendor with `owned_at` set. Run it once per tier after that tier's receiver is live. The
dry run prints the vendors. The script writes nothing to D1. It needs
`CLOUDFLARE_API_TOKEN` with Queues Edit and D1 Read, and `CLOUDFLARE_ACCOUNT_ID`.
`--local --apply` is refused: the local queue lives inside `wrangler dev`, so approve a claim
locally instead.

## Review-app mirror drift

Pages through the existing `data-quality-error` alert. Use this when the daily
`aeci.data_quality.check{check:review_mirror_drift}` gauge is above 0 or is -1 (AECI-1455).

**What it means.** For every owned vendor the check builds the v2 ownership record we would
send now, then asks the review app for the hash of the last v2 record it accepted
(`REVIEW_APP_PROMOTE_API.md` §4d). A line means the review app is curating from a stale or
absent copy of that vendor's records. It runs only when the tier sends v2
(`REVIEW_APP_MIRROR_SCHEMA` is `"2"`) and both receiver secrets are set. Otherwise it is
skipped and reads 0.

**Read the lines first.** Open `/admin/system`, run the data-quality checks, and read the
`review_mirror_drift` sample. Each line names the vendor id and one of five causes.

| Line says | Meaning | Do |
|---|---|---|
| `missing on the review side` | The review app holds no record for this vendor | Read the vendor's ledger ("Ownership records not reaching the review app" above). A `404` there is the unknown-vendor case. Otherwise re-send the vendor |
| `the review side holds no v2 record` | The review app last accepted a v1 record | Expected once, right after the v2 flip and before the backfill. Afterwards, re-send the vendor |
| `hash differs` | The review app's v2 record is older than the live state | A mirrored edit did not deliver. Read the ledger, then re-send the vendor |
| `build_failed` | A stored value on this vendor's records violates the v2 contract, so the record cannot be built. The text after it is the builder's error, cut at 200 characters. The queue consumer is retrying this vendor too, and drops it after its last attempt, so nothing reaches the review app | Fix the stored value the error names, then re-send the vendor. Other vendors are still checked, so the rest of the sample is real |
| `partial` | The review app holds this exact record, but did not apply every part of it. The number is its `skipped` count (AECI-1488). Typical causes are a product it could not bind or an endpoint it does not hold | Do not re-send first: the same record skips the same parts again. Read which parts were skipped on the review side (AECI-1490). Fix the cause there, or on our side if it names a live value. Then re-send the vendor |

The re-send is the `--vendor` command in the section above. The record is the whole current
state, so a re-send is always safe. Production needs Chris's go-ahead.

**The value is -1.** The versions read failed: a network error, a timeout after 10 s, a
non-2xx answer, or a body that failed the schema. The check's `error` text on
`/admin/system` names which. A `401` or `403` means the token pair is out of step. A `404`
on the versions path means the review app's receiver does not serve the versions read yet.

**Many vendors drift at once.** Look for one cause before re-sending vendor by vendor. A
review-app deploy that changed how it stores records, or a v2 field change on our side
(`review-mirror-fields.ts`), moves every hash. Fix the cause, then run the full backfill
below.

## Turning on the v2 ownership mirror in production

Run once, in this order (AECI-1413). Each step depends on the one before it. AECI-1455 runs
it on production starting 2026-10-27. The var is `"2"` there from that deploy on.

1. **Confirm the review app's v2 receiver is live in production.** The `REVIEW - ` sub-issue
   of AECI-1413 must be shipped, and so must AECI-1491, which accepts
   `products[].fromProposalRef` (AECI-1489). The live receiver answers `400` to a v2 record
   it does not parse, and the consumer treats a `400` as permanent. So a flip before this
   step drops every send.
2. **Flip the production var.** Set `REVIEW_APP_MIRROR_SCHEMA` to `"2"` in the
   `production` block of `apps/api/wrangler.jsonc`, and update the matching expectation in
   `apps/api/src/wrangler-ownership-sync.spec.ts`. Merge, then promote to production. It is
   a plain var, not a secret, so it ships with the deploy.
3. **Re-send every owned vendor as v2.** Read the queue id, dry-run, then apply with that
   id in place of `QUEUE_ID`. Needs Chris's go-ahead. Run it before the next 04:00 UTC
   data-quality run. Until it lands, every owned vendor's mirror holds a v1 record, so
   `review_mirror_drift` reads above 0 and the `data-quality-error` alert pages.

```bash
pnpm --filter @aeci/api exec wrangler queues info aeci-ownership-sync-production
pnpm --filter @aeci/api ops:backfill-ownership-sync -- --env production
pnpm --filter @aeci/api ops:backfill-ownership-sync -- --env production --apply --allow-production --queue-id QUEUE_ID
```

4. **Expect `review_mirror_drift` to read 0 on the next daily run** (04:00 UTC). To check
   sooner, run the data-quality checks on `/admin/system` once the queue has drained. Any
   line left is triaged with "Review-app mirror drift" above.

**Rolling back.** Set the var back to `"1"` and promote. The check then skips, and the
consumer sends v1 again.

---

## Removal requests

Not an alert. Use this when someone asks AECi to take down a listing, or a part of one. The request comes by email to support@aecintegrations.com, or as a correction request. **A request to be removed never deletes anything by itself.** There are two tools. The listing hide (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6, ADR 0052) takes a company or product off the public site and out of search, and it keeps the data, so a restore is exact. The value hide (§11d.7) blanks one value on a vendor-held record while AECi checks it, and shows "Under review" in its place.

**What "hidden" means.** Counsel's Q20 answer says a reversible hidden state "will normally meet the practical purpose of removal". It "does not meet an order or duty requiring deletion of the underlying data". Retained data "remains discoverable". So a hide never answers an order to delete. Send any deletion order to Chris before you act.

### Which requests oblige us to act

Counsel's table, from the Q20 and Q21 answers of 2026-11-04 (`LEGAL_COUNSEL_RECORD.md`). The decision rule was recorded on AECI-1238 the same day. The first three columns are that rule. The last column maps it to the tool we have.

| # | Request | Obliged? | Action | In the admin panel |
|---|---|---|---|---|
| 1 | A vendor asks to be removed, and the listing is accurate | No | Refuse politely. Offer the correction route. | No hide. |
| 2 | A vendor says the listing is inaccurate, and we cannot verify either way | No. But knowingly keeping a materially false listing risks a claim under Fla. Stat. 501.204 (FDUTPA) | Investigate. Hide the contested value pending verification. Correct what is proved. Record receipt, verification, interim hide and decision. Act in days. | A single value on a vendor-held record: the value hide ("Hide a value" below). Once it is proved wrong, correct it with a field correction (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5), which ends the hide. On an AECi-held record, correct it upstream in the review app. A whole listing that is materially false: hide it as `complaint_under_review`. |
| 3 | The company or product is defunct | Policy | Verify it: a dissolution record, or the product site says it is discontinued. Then take it down. | Hide as `defunct`, with the evidence as the source. |
| 4 | A trademark or copyright complaint about a name or logo | No for a name, which is nominative use. A compliant DMCA notice (17 U.S.C. 512) or a court order changes that for a logo or screenshot | Name: refuse. Logo or screenshot: the DMCA process or the order. Otherwise refuse. | No hide for a name. A logo under a compliant notice or order: Remove on objection (`LISTING_SUBMISSIONS_RUNBOOK.md` §6a). An order that covers the whole listing: hide as `lawful_order`. |
| 5 | A defamation claim about a listing's text, not a review | Vendor-authored text: Section 230 applies, and a bare notice creates no duty. Our own text: correct or remove it if proved false | Investigate with proof. Hide pending verification. Correct our own text when it is proved false. Fla. Stat. 770.01's presuit notice rule applies to media defendants. | One text value on a vendor-held record: the value hide ("Hide a value" below). A whole listing: hide as `complaint_under_review`. Correct our own text upstream in the review app and promote it. |
| 6 | A court order, or lawful government process | Yes, within its scope | Comply. An informal government request is not an order. | Hide as `lawful_order`, with the order as the source. An order that requires deletion goes to Chris first. |
| 7 | A request about a named person, not a company | No general right. The Florida Digital Bill of Rights does not reach us | Refuse, unless it is personal data we hold in a review. Handle that under the privacy policy. | No hide. |
| 8 | A cease-and-desist letter from a vendor that never claimed its listing and has no contract with us | No. It is a demand, not an obligation | Reply with the correction route as a process we offer, never as terms we impose. Never admit falsity. | No hide. |

Two further rules from the same answers:

- **Notice and a dispute route are not required by statute.** Both bind us once a policy promises them (Q20). The Listing Accuracy Policy promises both. The hide sends the notice and shows the dispute line for you.
- **A hide is interim, never a finding** (Q21 follow-up, 2026-11-05). The reason you write must not say the listing is false.

### The timeline

Counsel set a clock for a contested value (Q21 follow-up, 2026-11-05, ruling 6 in `LEGAL_COUNSEL_RECORD.md`):

| Step | Deadline | Starts |
|---|---|---|
| Hide or flag the value | 2 business days | On receipt of a public source that shows the value is wrong. A bare complaint does not start it |
| Correct a confirmed error | 5 business days | The same receipt. Only where review confirms the error against the named source |
| A disputed or complex value | 5 business days | The same receipt. Tell the requester what further verification is needed and when we expect to decide |

A business day is Monday to Friday, excluding US federal holidays, in America/New_York (`apps/api/src/lib/business-days.ts`). Correct sooner when verification is quick, because "damages can grow while a known error stays live" (Q21 follow-up). Counsel set no fixed clock for a whole-listing hide. The rule there is to "act in days, not weeks, on a documented timetable" (Q21 (c)).

The value hide computes the two value deadlines from the received date: "Hide by" (2 business days) and "Decide by" (5 business days), shown on each row under "Values under review". A whole-listing hide has no computed deadline. Count it from the received date by hand.

### Hide a listing

1. **Record the request.** Note the date AECi received it and the link to the public source. A `complaint_under_review` hide is refused without a source link.
2. **Open the company** at `/admin/vendors/:id`.
   - A whole company: the Vendor tab, "Listing visibility", **Hide from the public site**.
   - One product: the Products tab, **Hide** on the product's row.
3. **Fill in the form.** Pick the kind from the table above. Enter the received date and the source link. Write the reason for the vendor to read. Put anything else in the internal note, which no vendor sees.
4. **Confirm.** For a company, the confirm step lists every product that will also be hidden. That includes a product shared with another company that stays live (ruled 2026-11-09).
5. **Check the result.** The company, product and pair pages answer 404 once the queued purge runs. The records leave Algolia through a sync that runs right after the save.
6. **Tell the requester** by email. A claimed vendor of an affected listing gets a portal notice and a banner automatically. No email goes to it. An unclaimed company gets nothing automatically.

### Restore a listing

1. **Open the company** at `/admin/vendors/:id`.
   - A hidden company: "Listing visibility", **Restore the listing**. The confirm step lists the products that come back with it.
   - A product hidden on its own: the Products tab, **Restore** on its row.
2. **Write the reason** for the vendor to read, and confirm. The pages return once the purge runs. The edge caches a 404 for up to 60 seconds, so a page can lag by that much.
3. **A product hidden with its company** has a disabled Restore. Restore the company instead. The API answers `409 LISTING_HIDDEN_WITH_VENDOR` for the same case.
4. **A product joined to two hidden companies** stays hidden when you restore one of them. It moves under the other company's hide.

### When something looks wrong

- **`409 LISTING_HIDDEN` or `LISTING_NOT_HIDDEN`.** Someone else acted first. Reload the page.
- **`409 LISTING_CHANGED_WHILE_SAVING`.** The listing changed during the save. Reload and try again.
- **A hidden listing is still in search.** The by-id sync failed. Look for `aeci.api.admin.listing_hide_algolia_sync_failed` in Workers Logs. The hide stamps `updated_at`, so the 08:00 Algolia sync removes it. To clear it sooner, see `RUNBOOKS.md` "Algolia sync failed".
- **The digest reports `product_live_under_hidden_vendor`.** A visible product is joined to a hidden company. A promote or a portal write raced the hide. Hide the product on its own row. It then needs its own restore after the company's. A line ending "still hidden by a restored hide" is the reverse. The product's hide row, or its company's hide, was restored without it, and no restore will ever reach it. Check that no company joined to it is hidden. Then clear its `hidden_at` and `hidden_hide_id` with an ops script, and run a by-id Algolia sync for it.
- **The review app still shows the listing as live.** That is expected. The review mirror does not carry the hide (ADR 0044), and a `REVIEW - ` follow-up covers it.

### Hide a value

Use this for one wrong value on a record a vendor holds: a company, a product the vendor holds, or an integration it holds. An AECi-held record is corrected upstream in the review app instead, and the hide refuses it with `409 FIELD_HIDE_NOT_VENDOR_HELD`. Hiding is an interim step while we verify, not a finding that the value is false.

1. **Record the request.** Note the date AECi received it and the link to the public source. The hide is refused without an https source link.
2. **Open the company** at `/admin/vendors/:id`. On the Vendor tab, find "Values under review" and choose **Hide a value**.
3. **Pick the record and the field.** The fields are the ones a field correction offers, plus the company and product descriptions. A product's categories, audiences, phases and trades cannot be hidden, and neither can an integration's name, type or direction.
4. **Fill in the form.** Enter the received date and the source link. Write the reason for the vendor to read. It must not say the value is false. Put anything else in the internal note. Confirm.
5. **Check the result.** The public page shows the field blank with "Under review. AEC Integrations is checking this detail." once the queued purge runs. The search record drops the value in a sync that runs right after the save. The vendor gets a portal notice with the reason and the dispute line, and a note on the field. No email goes to it.
6. **Do it within 2 business days** of the received date. The row's "Hide by" date shows the deadline.

### Decide a hidden value

Decide within 5 business days of the received date. The row's "Decide by" date shows the deadline.

- **The value is right.** Choose **Restore** on the row, and write the reason for the vendor to read. The value returns to the public page.
- **The value is wrong.** Correct it under "Field corrections" with the source. That ends the hide in the same save, and the page shows "Corrected by AEC Integrations".
- **You cannot decide yet.** Email the requester what further verification is needed and when you expect to decide. Then choose **Record status reply** on the row, and note what you told them. The note is internal. It changes nothing public.
- **The vendor changed the value itself.** Its save ended the hide, and the row leaves the list.

The vendor can always edit a hidden field. A save that changes it ends the hide at once, and the new value goes public. If the new value is still wrong, hide it again.

### When a value hide looks wrong

- **`409 FIELD_HIDE_ACTIVE`.** The field is already hidden. Reload the page.
- **`409 FIELD_HIDE_CLEARED`.** The hide ended before your restore or status reply: someone restored it, corrected it, or the vendor changed the value. Reload the page.
- **The digest reports `field_hide_decision_overdue`.** A hide is past its "Decide by" date with no status reply. Decide it now, or send the requester a status reply and record it.
- **A hidden value is still in search.** The by-id sync failed. Check Workers Logs for the field-hide Algolia sync failure, then see `RUNBOOKS.md` "Algolia sync failed".

## Rename a live slug

Not an alert. This is the procedure for changing the slug of a vendor or product that stays live, for example after a rebrand. First used for AECI-1495 (Coda to Superhuman, 2026-10-28). Used again for AECI-1574 (`openasset-connector` to `openasset-source`, product only, `scripts/ops/2026-11-openasset-slug-rename/`). Retiring a row is a different case: it seeds only the redirect.

Slugs are immutable by default (`STAGE_1_PHASE_2_SPEC.md` §6.2). Promote never sends or changes one. Its update branch keeps the stored slug, so a rename has to be done on the app side. There is no admin action for it.

**Use an ops script, not a migration.** A migration only changes data that migrations created. A rename touches rows that exist only in production, and as a migration its redirect rows would land on every fresh database pointing at nothing (ruled 2026-10-28). Copy `scripts/ops/2026-10-coda-slug-rename/`: an `apply.sql`, a `rollback.sql`, and a README with the commands in run order. The SQL does four things, keyed on the production ids:

1. Updates `slug` in place, guarded so it cannot collide with an existing slug.
2. Sets `updated_at` by hand in the same UPDATE. Raw SQL skips Drizzle's `$onUpdate`, and the Algolia sync is a delta on `updated_at`. Without this the search records keep the old slug.
3. Seeds one `slug_redirects` row per old slug (`DATABASE_SCHEMA.md` §4.3b). The detail resolvers and the pair route then 301 the old URLs. Since AECI-979 a taxonomy term (`category`, `audience`, `phase`, `trade`) can be mapped the same way, and the browse resolver 301s it.
4. Writes a `vendor.updated` / `product.updated` audit row with the slug in `before_state` and `after_state`, once, and only where the rename landed.

Test both files on a scratch database built from every migration before running them: apply twice, then rollback twice. Production D1 is reached from `/tmp` as `aeci-app-production-us`. The README holds the full commands.

After the SQL runs, in run order:

1. **Purge the edge, if needed.** The SQL purges nothing, and editing the map has no purge hook (`CACHE_STRATEGY.md` §3 rule 6). Detail pages cache for 900 s, so a stale copy expires by itself. If one must go sooner, run `POST /admin/purge` with the `ADMIN_PURGE_TOKEN` bearer (GitHub secrets, not an admin session) and `{ "tags": [...] }` naming `vendor:` or `product:` with each old and each new slug. A product's old `product:` tag also covers its pair pages.
2. **Promote the product from the review app, if the display name has not arrived yet.** For AECI-1495 it already had. It also purges the new-slug tags and marks the sitemap dirty. If the vendor has `owned_at` set, promote skips the vendor row, so check that in the preflight read.
3. **Check the review app's copy of the slug.** Read the review record's `supabaseSlug` with the `aeci-review` read tools. No tool writes it directly. The review app stores the slug a promote returns, so a promote in step 2 is what fixes it. Run that promote even when the name has already arrived.
4. **Check the discovery queues.** URLs already in `gsc_recrawl_queue` and `indexnow_queue` under the old slug were queued before the mapping existed, and now only 301. The IndexNow drain drops its own copies before sending (`indexnow-drain.ts`), so only the Google queue keeps them. Report them. Do not delete them without a ruling. For AECI-1574 Chris ruled to delete them, once the promote had queued the new-slug URLs. `scripts/ops/2026-11-openasset-slug-rename/delete-queued-old-slug.sql` is the template. It matches with `substr` because D1 rejects a long LIKE pattern as too complex.
5. **Verify.** With a browser user agent (the WAF answers curl's default with 403), `curl -sI` the old vendor URL, the old product URL and one old pair URL on `www.aecintegrations.com`. Each should return `301` with `location` on the new slug.
