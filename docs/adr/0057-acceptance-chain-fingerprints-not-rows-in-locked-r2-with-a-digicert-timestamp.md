# ADR 0057: The acceptance chain: fingerprints, not rows, in locked R2 with a DigiCert timestamp

- Status: Accepted. Built.
- Date: 2026-11-17
- Issue: AECI-1680
- Relates to: ADR 0022 (log-class writes, amended 2026-11-17); ADR 0053 (grants and their acceptance); ADR 0056 (the `evidence/` bucket lock pattern); `docs/DATABASE_SCHEMA.md` §8.6d, §8.6h and §9.17; `docs/VENDOR_SIGNUP_PROCESS.md` §4; `docs/ANALYTICS.md` §11e; `docs/LEGAL_COUNSEL_RECORD.md` ruling 15 and Q5

## Context

Counsel's Q5(c) asked for a record of who accepted which agreement that an outsider can check was not edited later. Chris said yes on 2026-11-11 (ruling 15). Until this ADR, `agreement_acceptances` was append-only by convention only. Nothing proved to a court that a row had not been changed by someone with database access.

Three facts shaped the design.

- **R2 has no object versioning.** An object can only be made immutable with an R2 bucket lock on its prefix, plus a writer that `head`s before it `put`s. This is the ADR 0056 pattern.
- **The rows change after insert, legitimately.** The claim approval fills in `profile_id`. The 90-day sweep blanks `ip` and `user_agent` and stamps `evidence_removed_at` (AECI-1636). `license_grants` rows change status in place. Neither table has a trustworthy "changed since" column, so the job compares every row each night. Both tables are small.
- **Both tables are in `NEVER_PRUNED` today.** AECI-1638 will let the retention prune delete old rows later.

## Decision

Chris ruled on 2026-11-17.

1. **R2 holds row fingerprints, never rows (ruling 1A).** A fingerprint is `sha256(canonicalJson(the row's hashed columns))`. Every column of both tables is classified in `COLUMN_MANIFEST` (`apps/api/src/lib/acceptance-chain.ts`): `hashed`, `public` (hashed and also copied as a plain field) or `excluded`. A spec fails when a column is in no class. The public fields are ids, versions, dates, statuses and a text hash. None is personal. R2 is therefore not a backup: it shows that a row changed, but cannot restore it.
2. **`ip` and `user_agent` are excluded from the hash input.** An IPv4 address can be recovered from its unsalted hash by trying every address, and the Privacy Policy promises both are deleted after 90 days. So they are left out of the input, not only the output. Changing either never changes a fingerprint, and a spec proves it. Fingerprints that cover a name and an email stay in R2 after the D1 row is deleted. Chris accepts that exposure.
3. **One hash-chained file a night.** The `acceptance-chain` cron (`0 18 * * *`, after the 17:00 evidence removal) enqueues on `RECONCILE_QUEUE`. The job writes `evidence/acceptance-chain/<seq, 6 digits>.json` to `UPLOADS`. The file lists an `upsert` entry for every new or changed row, and a `delete` tombstone for every exported row gone from D1. It carries `prev_sha256`, the SHA-256 of the previous file, and `state_sha256`, one hash over every live row's `table:id:fingerprint` line. Changing an old file breaks every later link. A file is written every night, even with no entries, so the chain shows no silent gap. The day is inside the file, not in the key, because `wrangler` cannot list a bucket and the verify walks the keys by seq.
4. **Head before put, then the ledger.** The job `head`s the key first. An object already there was written by an earlier attempt whose D1 batch failed, and the job adopts it, unless it does not continue the chain, which stops the run for an operator. Then `put` with the `sha256` option, `head` to confirm, and one `db.batch` with the `acceptance_chain_exports` row first. Its `seq` primary key refuses a second row for one file.
5. **A DigiCert RFC 3161 timestamp per file (ruling 2A).** The job POSTs a hand-built DER request with the file's SHA-256 to `http://timestamp.digicert.com`, with a 10-second timeout. Only the 32-byte hash leaves us. A granted token is stored beside the file as `.tsr`, under the same lock. A failure never fails the export: the file stays, `tsa_status` is `failed`, `aeci.acceptance_chain.timestamp_failed` is logged, and each run retries up to 7 earlier files. A late token still proves the file existed at that later time. Chris chose DigiCert over FreeTSA.
6. **The lock is an operator step.** One rule per tier on `evidence/acceptance-chain/`, held indefinitely, because acceptance retention is the life of the account plus six years, which has no fixed end. The `evidence/` 4-year rule from ADR 0056 overlaps, and the longer rule wins. The command is in `docs/environments.md`.
7. **The verify trusts R2, not D1.** `pnpm --filter @aeci/api ops:verify-acceptance-chain -- --env <tier>` is read-only. It checks the lock (`LOCK MISSING` and `LOCK NOT INDEFINITE` are both failures, legal ruling 2026-11-17), walks the files from seq 1 and reports the first broken link as `CHAIN BROKEN`. `wrangler` cannot list a bucket, so a missing key does not end the walk: it probes 30 seqs further and always walks up to the highest seq in the D1 ledger, so a deleted file in the middle is a broken link, never a short chain that passes. A malformed file or entry is a broken link at that seq, never a crash. Deleting the newest files breaks no link, so on a deployed tier a newest file over 50 hours old is `CHAIN STALE`, a failure. It also verifies each token with `openssl ts -verify` against the pinned chain in `apps/api/scripts/certs/digicert-tsa-chain.pem`, and compares every D1 row with its last fingerprint in the chain (`CHANGED`, `UNEXPORTED`, `ABSENT`, `TOMBSTONE WITHOUT PRUNE AUDIT`). It reads only the export ledger's `MAX(seq)` as a minimum walk length, never its stored hashes or `acceptance_chain_rows`; R2 supplies the evidence. Ledger damage can cause re-exports or verification failures. It ends with three separate results, `LOCK:`, `CHAIN:` and `ROWS:`, so a missing lock is never reported as a broken chain or the other way round. The export stores a DigiCert reply only after the Worker verifies it, because the reply arrives over plain HTTP and a stored token can never be replaced. `lib/rfc3161.ts` checks it with Web Crypto. The TSTInfo must name our SHA-256 digest and our nonce, with a `genTime` within 24 hours. The `contentType` and `messageDigest` signed attributes must match the TSTInfo. The RSA signature over the signed attributes must verify under the responder certificate. That certificate must be valid at `genTime`, carry a critical `id-kp-timeStamping` extended key usage, and be signed by a pinned DigiCert intermediate key (`PINNED_TSA_ISSUERS`). Any failure is a failed timestamp with a named reason, and a later run retries it. `openssl ts -verify` repeats the check offline and adds the intermediate's link to the DigiCert root. The DigiCert token stays even with the lock in place, because an account admin can remove a lock rule and the token does not depend on our account.
8. **The prune contract with AECI-1638.** R2 files are never deleted. When a prune deletes an acceptance or grant row, the next export writes its tombstone. The verify accepts a tombstone only when a `retention.pruned` audit row names the row, in `metadata.tables[]` as `{ table, ids: [...] }`.

## Consequences

- **A row edited between exports reads `CHANGED` until the next export.** The verify cannot tell a legitimate change from tampering. The audit log does: every legitimate write to these tables has its own audit row. The runbook says to run the verify after 18:15 UTC and to match each `CHANGED` row to an audit row.
- **The ledger tables are log-class.** `acceptance_chain_exports` and `acceptance_chain_rows` write no `audit_log` row (ADR 0022, 2026-11-17 amendment). The acceptance and grant writes carry their own.
- **A bucket with an indefinite lock rule cannot be emptied.** Retiring a tier's `UPLOADS` bucket means removing that rule first.
- **The pinned DigiCert chain expires in 2038 and DigiCert rotates intermediates.** A rotation shows first as `timestamp_failed` with `reason=unpinned_issuer` on every night, and later as `openssl ts -verify` failing with "unable to get local issuer certificate". Fetch the new intermediate from the responder certificate's CA Issuers URL. Append it to the PEM and add its SPKI to `PINNED_TSA_ISSUERS` in `lib/rfc3161.ts`. A spec fails if the two differ. The backfill then retries the files that lack a token. The PEM's header says how.
- **Health.** The `aeci.acceptance_chain.run` heartbeat, the `acceptance-chain` row on `/admin/system`, and the runbook section in `docs/runbooks/alerts.md`.
- **Cost.** Two full-table reads, one R2 write and one DigiCert request a night.

## Alternatives not taken

- **Export the rows themselves.** Ruled out by ruling 1A. R2 would become a second copy of personal data, past the D1 deletion promises.
- **Hash `ip` and `user_agent` with the rest.** Ruled out: an unsalted IPv4 hash is reversible by enumeration, which would keep the address past its 90-day deletion.
- **R2 object versioning.** R2 has none.
- **FreeTSA.** Ruled out by ruling 2A in favour of DigiCert.
- **A fixed-day lock.** Retention has no fixed end, so a fixed number of days could lapse before the record may be destroyed. Chris may still choose `--retention-days` when he applies the rule.
- **Trust the D1 ledger in the verify.** Ruled out: anyone who can edit the acceptance rows can edit the ledger beside them.
