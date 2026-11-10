# ADR 0053: A pending grant is its own table, and licenses exist only after acceptance

- Status: Accepted. Built as AECI-1615.
- Date: 2026-11-10
- Issue: AECI-1615. Counsel's Q5 answer (2026-11-04, follow-up 2026-11-05) and Chris's rulings R1 to R6 and 16 of 2026-11-10.
- Relates to: ADR 0016 (`db.batch`), ADR 0022 (audit in the same batch), ADR 0047 (Stripe billing), ADR 0048 (the Free plan and per-product subscriptions); `VENDOR_SIGNUP_PROCESS.md` §3 step 5 and §4, `DATABASE_SCHEMA.md` §8.6c, §8.6d and §8.6h

## Context

Counsel's Q5 answer says a complimentary or invoice grant must not start by use. It starts only on an affirmative acceptance: an owner seat ticks the box in the portal, or a person with authority signs a deal that names the agreement by version and date. The Managed plan agreement 1.1 already says so.

Before AECI-1615 an admin grant wrote live `licenses` rows at once. A subscription is live when `licenses.ended_at IS NULL`, and more than 20 readers use that test. They include plan resolution, the assign route, the lapse, the 45-day notice, the Stripe sync, contests, retraction, data quality and the `vendors.verified` mirror.

A `pending` state on `licenses` would have needed a new clause in every one of those readers. One missed reader would have let a grant act live before acceptance, which is the exact breach counsel described. A CHECK on a new status column would also have forced a table recreate on D1 (`docs/migrations.md` §0).

## Decision

1. **A pending grant lives in `license_grants`, not in `licenses`.** The row holds the kind (`grant` or `ban_term`), count, source, dates, reference, ban-term items, the version pinned at grant and the status (`pending_acceptance`, `accepted`, `withdrawn`, `expired`). No CHECK on any of them.
2. **`licenses` rows exist only after acceptance.** The only path that writes a grant's licenses is `activateLicenseGrantStatements` in `lib/license-grants.ts`. One `db.batch` holds the guarded grant UPDATE, the `agreement_acceptances` row, the licenses and the audit rows. No live reader changed, so "nothing is live before acceptance" holds by construction.
3. **Two ways to activate.** The owner accept route (`POST /api/vendor/license-grants/:id/accept`), or a signed deal recorded at create that names the pinned version (R5). The deal activates at once, and that grant gets no click prompt.
4. **The grant id stays the form-minted id.** License ids stay `uuidv5('license:{grant_id}:{i}')`, so a replayed grant writes nothing twice.
5. **The record is append-only and never pruned.** It is kept at least five years after the grant's last subscription ends. Each acceptance records a hash of the agreement text and of the checkbox label shown, plus a flag that the box started unticked (ruling 16).
6. **Grants live before AECI-1615 stay live** with no acceptance (R3).

## Consequences

- Readers of `licenses` need no change. A new reader must not read `license_grants` as live.
- An admin who expects a grant to show at once now sees it waiting until an owner accepts. The 11:00 job expires a grant nobody accepted at its end date, and sends one reminder after 7 days.
- The store is append-only in D1, not tamper-evident against AECi itself. A nightly export to a versioned R2 bucket with a running hash is a separate Platform issue (ruling 15).
