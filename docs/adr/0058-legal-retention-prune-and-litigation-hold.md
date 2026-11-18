# ADR 0058: Legal retention prune and litigation hold

- Status: Accepted. Built.
- Date: 2026-11-17
- Issue: AECI-1638
- Relates to: ADR 0022 (scheduled deletes audit, amended 2026-11-17); ADR 0057 (the acceptance chain's prune contract); ADR 0056 (the 4-year `evidence/` lock); `docs/STAGE_1_SPEC.md` §26.6; `docs/DATABASE_SCHEMA.md` §8.4, §8.6d, §8.6h and §8.15; `docs/ADMIN_PANEL_SPEC.md` §5.22b and §7.4; `docs/LEGAL_COUNSEL_RECORD.md` Q23a, Q27c and ruling 23

## Context

Counsel's Q27c said indefinite retention of the audit and acceptance records is hard to defend. Counsel's Q23a said the substantiation for a ranking claim, audit rows included, must be kept at least four years, and longer on litigation hold. The v1.1 Privacy Policy draft promised both periods. Ruling 23 made this issue a gate before any effective date.

Until this ADR nothing deleted these rows. `audit_log` was a hard exclusion of the 400-day prune, and `agreement_acceptances` and `license_grants` were in its `NEVER_PRUNED` list. Nothing falls due before about 2030 for audit rows and 2032 for acceptances. The job must be correct now, because it will run unattended for years.

Three facts shaped the design.

- **No column said when a vendor account ended.** `DATABASE_SCHEMA.md` §8.6d said "Nothing computes this floor".
- **The acceptance chain verify reads every `retention.pruned` row with no date bound** (ADR 0057). Deleting one would turn a legitimate tombstone into a failure.
- **`audit_log` has a UUID primary key**, so the 400-day prune's integer cursor does not apply.

## Decision

Chris ruled on 2026-11-17.

1. **Account end (ruling 1).** A vendor's account has ended when `vendors.claim_ended_at` is set and it holds no live license. The end instant is the later of `claim_ended_at` and the latest `licenses.ended_at` on its billing account. A reclaim or a new license restarts the clock. The `licenses` table decides, not the `plan_ended_at` mirror. An acceptance row goes six calendar years after the end. If it names a grant, that grant must also be five calendar years past its end: its last license's `ended_at`, or `decided_at` for a grant withdrawn or expired before acceptance (ruling 17). A grant row goes on the same two tests. *(Amended 2026-11-18, AECI-1914: a row with a NULL `vendor_id`, or whose vendor row is gone, was never pruned. See "Every acceptance has a date" below.)*
2. **Audit exemptions (ruling 2).** The four-year prune keeps `retention.pruned`, `litigation_hold.*`, `agreement.*`, `terms.*` and `account.deleted` rows whatever their age. They prove an acceptance record, so they follow it. An `agreement.accepted` row goes in the batch that deletes its acceptance. The Privacy Policy audit bullet says so: "Three kinds of audit record are kept longer, for as long as the acceptance record they belong to". Durable vendor-authored provenance is a follow-up.
3. **Hold scope (ruling 3).** Any open hold, global or vendor, pauses the whole `audit_log` prune. A vendor hold keeps only that vendor's acceptance and grant rows. A global hold keeps everything. The acceptance-record bullet gains "or longer while a legal hold requires it". After the legal agent's review the audit bullet says instead "We pause this deletion while we are under a legal duty to preserve records, for example after receiving legal process." Both changed in place in the v1.1 draft, with no bump.
4. **Job shape (ruling 4).** A new `legal-retention-prune` job is enqueued from the existing 03:00 tick and consumed on `RECONCILE_QUEUE`. No new trigger. The 400-day prune and its gates do not change.

How it is built:

- **A separate module.** `apps/api/src/lib/legal-retention-prune.ts`, so §7.4's gates and `PRUNABLE` list stay as they were, and that module still never names these tables.
- **Calendar years, not days, for the six and five years.** A day count falls short across a leap year. The audit period is 1,461 days, the span of the `evidence/` lock. No env override: a legal period is not an operator tunable.
- **The audit part pages `(created_at, id)`.** Each chunk reads up to 500 keys and deletes the row-value range under the authority predicate, at most 20 chunks a run. The bind count is the same whatever the chunk size.
- **The acceptance part caps at 200 ids per table** and binds them as one JSON array through `json_each(?)`. Every DELETE repeats the eligibility predicate.
- **One batch, one audit row.** Every delete and one `retention.pruned` row commit together. The row lists `{ table, cutoff, rowsDeleted, ids }`, the shape `pruneAuditIds` reads.
- **Sentinels make a retry safe.** Every delete in the batch has a commit-time count sentinel before it: a hold landed, an acceptance or grant stopped being eligible, or a concurrent run of the job already deleted the planned rows (the four-year chunks and the released-hold cleanup included). A D1 batch is one serialized transaction, so a passing sentinel holds for the statements after it. An abort replans once at once; a second abort is `skipped: concurrent_run`, never a failure, so a duplicate delivery that loses the race sends no failure email and writes no second `retention.pruned` row.
- **The hold is a table.** `litigation_holds`, one open hold per scope by partial unique indexes, placed and released on `/admin/legal` with an audit row in each batch.

## Consequences

- **Queued, unlike the 400-day prune.** That prune is queue-less because a retry could replay against state it already changed. Here each run is one atomic batch bounded by its cutoff, and the sentinels abort a stale plan. A retry re-plans against the current state, so it cannot over-delete.
- **Two jobs share one cron expression.** `scheduled.ts` matches `RETENTION_CRON` once, and its case starts both. `cron-schedules.spec.ts` allows exactly this one shared expression.
- **No R2 copy.** The deletion is the promise. D1 Time Travel restores about 30 days.
- **Every exempt kind has an end (Chris's ruling of 2026-11-17).** The code matches the reviewed Privacy Policy sentence "Three kinds of audit record are kept longer, for as long as the acceptance record they belong to". *(Since AECI-1914 the draft reads "Four kinds", adding the record that a company was deleted. See below.)* `agreement.accepted`, `agreement.linked` (approver and profile id, `after_state.acceptance_ids`) and `agreement.evidence_removed` (`metadata.acceptance_ids`) go in the batch that deletes the last acceptance they name, after the acceptance delete. A `litigation_holds` row and its `litigation_hold.*` audit rows go four years after release, because the reason is free text that can name a person; any open hold pauses that. `retention.pruned` rows are kept: they hold ids only (counsel's question (c)), and a spec pins their keys.
- **Every acceptance has a date (Chris's ruling 48 and its extension, 2026-11-18, AECI-1914).** No acceptance row is kept forever. The predicate is one OR of four arms, each also requiring `accepted_at` before the six-year cutoff and no open global hold. A: the vendor exists and its account ended six years ago (a legacy checkout row with a NULL `vendor_id` takes its billing account's vendor). B: a claim never approved, with no vendor, billing account or grant, goes six years after the claim was rejected (`resolved_at`). An open, in-review or approved claim keeps it, and so does a vendor hold on the company the claim targeted. C: a row with no vendor, billing account, grant or claim (a listing-request acceptance, or one whose claim was deleted) goes six years after acceptance. D: a row whose vendor row is gone goes six years after the latest `vendor.deleted` audit row for that id, under arm A's grant test. A grant whose vendor row is gone follows arm D too. With no `vendor.deleted` row the record is kept and the `acceptance_without_retention_date` data-quality check (`warn`) reports it. That check's note also counts NULL-vendor acceptances of an approved claim, a linking defect arm B keeps.
- **The `vendor.deleted` row dates arm D, so it is kept with what it dates.** The four-year prune skips it while its vendor row is gone and an acceptance or grant still names that vendor. The legal prune deletes it in the batch that removes the last of them, after the acceptance and grant deletes and before the four-year part, behind its own count sentinel. The Privacy Policy audit bullet names it as the fourth kind kept longer.
- **Rows that stay for now.** `terms_acceptances` and the `account.deleted` and `terms.*` audit rows wait for the Terms-acceptance prune. `workflow_instances` and `workflow_transitions` stay indefinite. Each is a follow-up.
- **A vendor hold does not stop companion deletes for other vendors.** An `agreement.*` row goes with its own acceptance, even while another vendor's hold pauses the four-year part. It proves a record that no longer exists.
- **A forgotten hold is reminded.** Before it prunes, the job emails `SUPPORT_EMAIL` (`litigation-hold-reminder`, `lib/litigation-hold-reminder.ts`) for each hold open more than 90 days, at most once every 30 days per hold (`LITIGATION_HOLD_REMINDER_AFTER_DAYS`, `LITIGATION_HOLD_REMINDER_EVERY_DAYS`). It uses the transactional email transport and its `notification_sends` ledger, the path every operator alert uses: the ledger is the 30-day memory, and the day key makes a queue retry a duplicate. Production only, not pausable. It goes to AECi's own inbox and names no person, so it needs no Privacy Policy change.
- **Health.** The `aeci.legal_retention.prune` heartbeat, the `legal-retention-prune` row on `/admin/system`, and the runbook section in `docs/runbooks/alerts.md`.

## Alternatives not taken

- **Extend the 400-day prune.** Its gates (the snapshot and archive checks) and its queue-less posture are about `page_views`, and a skip there would have stopped the legal deletes too.
- **A day count for every period.** It falls short of "six years" across a leap day.
- **An R2 archive before deleting.** It would keep the data the policy promises to delete.
- **Use `plan_ended_at` for the account end.** It is a mirror for a retired caption. The `licenses` table is the source.
- **`IN (?, ?, …)` id lists.** They put the chunk size into the bound-parameter count, which D1 caps well below 200.
