# ADR 0042: Anonymous submissions wait outside the domain table until the address is confirmed

- Status: Accepted
- Date: 2026-10-21
- Issue: AECI-1435
- Relates to: `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.3 and §15.4, `docs/VENDOR_SIGNUP_PROCESS.md` §3, `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10, ADR 0022 (audit in the batch), ADR 0026 (rate limiting)

## Context

The claim form and the typed-in listing request are anonymous. Anyone can type any address. Before this change the submit wrote the claim at once. It reached the admin queue, routed to the company's owners, emailed them, and recorded a vendor terms acceptance in the typed person's name. The only defence was the receipt, sent after the fact.

We want the typed address to prove it received our mail before any of that happens. A signed-in visitor whose verified email is the typed address has already proved it.

## Decision

1. **A pending submission never enters `vendor_requests` or `listing_requests`.** It waits in a new table, `request_confirmations`, with its validated body as JSON, a SHA-256 hash of a single-use token, and the vendor terms evidence of the submit (version, IP, user agent). The submit writes that row and its `request_confirmation.created` audit row in one batch, then emails `claim-confirm`. Nothing else runs.
2. **The click runs today's submit code unchanged.** `POST /api/requests/confirm` loads the row by token hash and calls the same function the signed-in submit calls (`submitClaimNow`, `submitListingNow`). The AECI-1420 account check, owner routing, the duplicate probe, the domain match, the Linear issue, the alert and the receipt all run at confirm. When the account check rejects the claim, the confirm answers `status: 'rejected'` with the reason, and the page says why (ruled 2026-10-21). The click proved the mailbox, so the page may name the company the address already manages, as the reasoned email does.
3. **The pending id becomes the request id.** The confirm inserts the claim or listing row with the pending row's id as its primary key. A second confirm, or the loser of two racing confirms, trips that key. Its batch rolls back whole, and the handler answers `already_confirmed`. The post-commit chain runs only after a batch commits, so it runs once.
4. **The acceptance row is written at confirm.** It carries the submit's terms version, IP and user agent, from the pending row, and the confirm time. Ruled 2026-10-21 (Chris).
5. **Who skips it.** A visitor whose strictly verified session email (`verifySupabaseJwt`, never the grace verifier) equals the typed address, compared trimmed and lowercased. Anything else, including a failed verify, takes the confirm path.
6. **The link works for 7 days.** A daily cron deletes rows past `expires_at`, with one summary audit row. Ruled 2026-10-21.

## Why a holding table and not a status value

A `pending_confirmation` status on `vendor_requests` was the obvious alternative. We declined it for two reasons.

- **The CHECK recreate hazard.** `vendor_requests.status` has a CHECK. SQLite cannot alter a CHECK, so drizzle-kit would recreate the table. `vendor_requests` has FK children (`agreement_acceptances.vendor_request_id`), and a recreate's DROP fires `ON DELETE CASCADE` (`docs/migrations.md` §0). `listing_requests` has no CHECK, but one shape for both is simpler.
- **Readers that would leak.** Every reader of `vendor_requests` would need a new filter, and a missed one shows an unconfirmed claim. Two readers we found have no status filter at all: the vendor dashboard (`routes/vendor.ts`, through `vendorRequestsWhere` in `routes/vendor-shared.ts`) and the admin related-requests lookup (`loadRelatedRequests` in `routes/admin-claims.ts`, by submitter email). A table nobody reads yet cannot leak.

The holding table is a plain CREATE TABLE. Every existing reader stays untouched.

## Consequences

- An anonymous claim is one click slower. The dialog, the claim page and the drawer say "Check your inbox", and the receipt arrives after the click.
- `RequestSubmitResponse` gains `confirmation_required`. On the confirm path `request_id` is the pending id, so analytics joins on it still hold.
- The confirm link is never blind-copied to the operator list, because the copy would be a second working link (`SendInput.withholdOperatorCopy`).
- The `claim-confirm` mail is bounded to 3 per address per UTC day, counted from the send ledger by recipient hash. Every submit is still parked. Two racing submits can both pass the count, so the bound is not exact.
- A vendor terms bump inside the 7 days makes the acceptance stale, and the confirm refuses it with `400 VALIDATION_FAILED` on `version`. The page shows the expired state, and the visitor starts again.
- The account erasure deletes pending rows by email (`docs/AUTH_AND_RLS.md` §8).
- The expired-link answer reuses the expired-invite precedent, `422 INVALID_STATE_TRANSITION`, with `details.reason = 'expired'`, rather than minting a 410 (`docs/API_CONTRACTS.md` §6.7).
