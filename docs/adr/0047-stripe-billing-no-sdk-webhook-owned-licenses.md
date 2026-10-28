# ADR 0047: Stripe billing: no SDK, webhook-owned licenses, daily reconcile

- Status: Accepted
- Date: 2026-10-28
- Issue: AECI-1339 (epic E9), sub-issues AECI-1499 to AECI-1504
- Relates to: ADR 0016 (`db.batch` is the atomic unit); ADR 0021 (the promote ledger pattern); ADR 0022 (audit exemptions, 2026-10-28 amendment for `stripe_events`); ADR 0023 (client revalidation, not sockets); `docs/VENDOR_SIGNUP_PROCESS.md` §2 and §5; `docs/STAGE_2_PAID_TIERS_SPEC.md` §7.6 points 2 and 9; `docs/DATABASE_SCHEMA.md` §8.6g; `docs/API_CONTRACTS.md` §6.11

## Context

Managed is sold as licenses on a billing account (`VENDOR_SIGNUP_PROCESS.md` decision 5). Until E9, every license was granted by an operator: complimentary or invoice. E9 lets an owner pay by card. Stripe Checkout takes the payment, Stripe Billing renews it, and the Customer Portal holds the card and invoices.

That raises three questions. How does the API Worker talk to Stripe? Which side decides how many card licenses a company holds? And what happens when Stripe's message about a change never arrives?

The Worker has constraints that shape the answers. It holds about six pending connections, and a cancelled `fetch` never settles (the ADR 0021 2026-08-27 amendment). D1 has no interactive transactions, so an atomic write is one `db.batch`. Every domain-state write audits in its own batch (ADR 0022). Stripe events arrive at least once, in any order, and are retried for three days on any non-2xx answer.

## Decision

1. **No Stripe SDK.** `apps/api/src/lib/stripe.ts` is a thin `fetch` client in the house pattern of `linearGraphql`. It uses form-encoded bodies, an `Idempotency-Key` on every POST, `AbortSignal.timeout`, an injectable `fetchImpl`, and `discardResponseBody` on every unread path. It never throws. It pins one `Stripe-Version` (`STRIPE_API_VERSION`, `2026-09-30.endive`), so an account-level upgrade changes nothing until the constant moves. The SDK was declined: it adds a Node-flavoured dependency to a Worker that needs a handful of calls, and it hides the connection handling the Worker must control.

2. **Stripe is the truth for card licenses, and one function applies it.** A Stripe subscription of quantity N is N `licenses` rows sharing `stripe_subscription_id`. There is no subscription table. `syncSubscriptionLicensesStatements` (`lib/stripe-licenses.ts`), with its batch built by `syncStripeLicensesStatements` in `lib/license.ts`, takes a subscription object and returns statements and audit entries. It grants the delta, ends the surplus with the carry-over, sets term dates by interval, maps `cancel_at_period_end` to `cancel_at_term_end` with reason `vendor-cancelled`, and ends every live license on a dead subscription. Every caller re-reads the subscription from Stripe before it runs, so event order never matters and a replay converges.

3. **The webhook owns license writes.** `POST /api/webhooks/stripe` verifies `Stripe-Signature` with a 5-minute tolerance and a constant-time compare, then writes a `stripe_events` row as the first statement of its batch. A replay trips the primary key and answers 200 `replay`, as `promote_jobs` does for promote. The row is log-class (ADR 0022, 2026-10-28 amendment). The license, acceptance and billing writes the event causes audit in the same batch. It handles five events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` and `customer.subscription.deleted`. A transient Stripe failure, or `STRIPE_SECRET_KEY` unset with the webhook secret set, answers 503, so Stripe retries rather than drops. The route reads no checkout flag.

4. **The request routes never write licenses.** Checkout, Add licenses and the portal open Stripe pages or change a quantity. Licenses land only when Stripe confirms, through the webhook. The Billing tab revalidates its read every 3 seconds for up to 60 seconds after a return from Stripe (ADR 0023).

5. **A daily reconcile is the backstop.** The `stripe-reconcile` cron (`15 1 * * *`) enqueues one message, and the consumer walks Stripe's non-canceled subscriptions, retrieves each subscription D1 still holds live licenses for that the walk missed, and runs the same sync. It also backfills a missing Checkout acceptance and an empty billing email, re-applies a ban's cancel that is missing on a vendor still banned, and binds the current agreement version at a renewal. Any change emails `SUPPORT_EMAIL`, on demo and production only. A change means an event was missed.

6. **One subscription, one interval, per billing account.** Checkout refuses a second subscription. Added licenses join the existing one at its interval. The Customer Portal has quantity update and plan switching off. Monthly may cancel at period end in the portal. Annual cancels by email to an operator. *Amended 2026-10-28 (AECI-1516, legal week 0): annual cancels at period end in the portal too, with no immediate cancel and no proration. Email to an operator stays as the fallback. The sync needs no change: it already maps `cancel_at_period_end` to `vendor-cancelled`.*

7. **Production is gated by a var, not by a missing secret.** `STRIPE_CHECKOUT_ENABLED` is `"false"` on production until the switch-on. Stripe secrets are recommended on every tier and never required, so a missing secret degrades to 503 and a skipped reconcile, not a failed deploy.

## Consequences

- A missed or disabled webhook delays a change by at most a day. It never loses one, because the reconcile reads Stripe directly. A lost `payment-failed` email is the one thing it cannot repeat.
- An admin cannot end a card license in the admin panel. A revoke ends the row, and the next sync grants it back because the subscription quantity has not changed. Refunds and opt-outs are done in Stripe (`RUNBOOKS.md`).
- The license rows are the only place the portal, plan resolution and ranking read. Stripe never enters a request path that renders a public page.
- A Stripe API version upgrade is a code change to `STRIPE_API_VERSION` plus a new webhook endpoint per account, because Stripe fixes an endpoint's version at creation.
- The card statement reads THE WBS PROJECT. Subscription-mode Checkout accepts no statement descriptor suffix, so the account descriptor is the only one (ruling R3, 2026-10-28).
- Every bump of the Managed plan agreement must append the old version to `LEGAL_AGREEMENT_KNOWN_VERSIONS`. A Checkout session opened before the bump records the version it showed (ruling R1).
- No dispute event is handled. A chargeback is an operator action.
