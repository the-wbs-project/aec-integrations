# Subscription runbooks

Operator procedures for vendor subscriptions, Stripe billing, pilot and granted terms, and ending a
vendor. The governing docs are `docs/VENDOR_SIGNUP_PROCESS.md`, `docs/PRICING_RULES.md` and
`docs/STAGE_2_PAID_TIERS_SPEC.md`; ADR 0047 for Stripe. Alert runbooks for everything else are in
[`alerts.md`](./alerts.md). Keep the heading anchors stable: other docs and code comments cite them
by name.

## Stripe reconcile changed subscriptions

**Signal:** a `[AECi] Stripe reconcile changed N Stripe plans` email to `SUPPORT_EMAIL`
(`stripe-reconcile-alert`), or a `job_runs` row for `stripe-reconcile` with `changed` above 0
on `/admin/system`. A `failed` run sends the `cron-job-failed-alert` email.

**What it means.** The daily reconcile (AECI-1503, `15 1 * * *`, `STAGE_2_PAID_TIERS_SPEC.md`
§7.6 point 2) re-read Stripe and found subscriptions that did not match. It has already fixed them:
granted, ended, moved an end date, or cancelled a ban-dead Stripe subscription. It may also have
backfilled a missed checkout's agreement acceptance or billing email. So nothing is
broken now. But a Stripe webhook did not arrive, or the termination's post-commit cancel failed. Find out which, because the
vendor waited up to a day for the change. The email lists each Stripe subscription, its Stripe status,
the subscriptions granted and ended, any backfill, and a link to the vendor.

**Staging sends no alert.** Staging has no reachable Stripe webhook endpoint by design, so every
test purchase there lands through the reconcile and would alert every day. The alert email goes out
on demo and production only. Staging's changes still show in its `job_runs` rows.

**Triage.**

1. Open the endpoint in Stripe: Developers, Webhooks, the endpoint for the tier. If Stripe
   disabled it, re-enable it. Read the failed deliveries for the Stripe subscription in the email.
2. A delivery answered 401 means a signature failure. Check the PostHog metric
   `aeci.webhooks.stripe.signature_failure` by `reason`. `missing_secret` means the tier's
   `STRIPE_WEBHOOK_SECRET` was never pushed. `mismatch` means the secret was rotated in Stripe
   but not in the Worker.
3. A delivery answered 5xx means the handler failed. Read the API Worker logs for
   `aeci.stripe.webhook_transient` or the error at that time.
4. No delivery at all, and the change is "Ban cancel: cancelled now, the vendor is banned": the
   termination's own cancel failed. The vendor was terminated, and the Stripe subscription stayed billable
   in Stripe with no live subscription on it. The reconcile cancelled it now
   (a ban-dead Stripe subscription, `stripe_events.outcome = 'ban-dead'`). Search the logs for
   `aeci.stripe.ban_cancel_now_failed` at the time of the termination to see why the first cancel failed.
   The `job_runs` detail counts these as `banCancelsNow`. See "Vendor suspension and termination".

**Look up the Stripe subscription.** Set `SUB` in your shell to the Stripe subscription id from the email.
Then read the subscriptions on it and the rows the reconcile wrote. Production D1 is read from
`/tmp` by its full name.

```bash
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT id, source, ends_at, ended_at, end_reason, assigned_product_id, cancel_at_term_end, cancel_reason FROM licenses WHERE stripe_subscription_id = '$SUB'"
```

```bash
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT created_at, action, json_extract(metadata, '$.license_id') AS license_id FROM audit_log WHERE json_extract(metadata, '$.source') = 'stripe-reconcile' AND json_extract(metadata, '$.stripe_subscription_id') = '$SUB' ORDER BY created_at DESC LIMIT 20"
```

```bash
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT started_at, outcome, json_extract(detail, '$.changed') AS changed, json_extract(detail, '$.granted') AS granted, json_extract(detail, '$.ended') AS ended, json_extract(detail, '$.failed') AS failed, json_extract(detail, '$.reason') AS reason FROM job_runs WHERE job = 'stripe-reconcile' ORDER BY id DESC LIMIT 7"
```

In the Stripe Dashboard the Stripe subscription is at `dashboard.stripe.com/subscriptions/` plus the id.
Its Events tab lists every event Stripe tried to send for it.

**A `failed` run.** The list walk failed, or one or more Stripe subscriptions did not sync. The run
synced the rest and sent its alert before it failed. The queue retries it 3 times. A retry is
safe because the sync converges on what Stripe has now. The `job_runs` reason names up to ten
Stripe subscriptions and why. A subscription Stripe answers 404 for will fail every day: it belongs to
another Stripe account or mode. Ask Chris before you touch its subscriptions.

**What the reconcile also repairs.** When `checkout.session.completed` never arrived, it backfills
the missing Checkout agreement acceptance. It also sets an empty billing email to the buyer's
email from the Checkout Session, as the webhook would. Either backfill counts as a change, so the
email lists it under "Acceptance" or "Billing email". When it moves a term to a new period end, it binds the
current agreement version, as a renewal through the webhook does. So a grant in the email needs no
manual acceptance fix. A missed `invoice.payment_failed` cannot be repaired: our email is lost, but
Stripe's own failed-payment email still went.

**`outcome:skipped`** means `STRIPE_SECRET_KEY` is unset on the tier. That is expected on local dev
without a `.dev.vars` key. On a deployed tier it means the secret push warned and skipped: check the
deploy log for the tier's `STRIPE_SECRET_KEY_*` step. Production checkout being off
(`STRIPE_CHECKOUT_ENABLED="false"`) does not skip the reconcile.

## Stripe: refund a paid subscription

Not an alert. A vendor asks for a refund by email. Ruling: a full refund within 14 days of the first
charge or of a renewal charge, and none after, except where applicable law provides otherwise
(Managed plan agreement, "Refunds"; `docs/PRICING_RULES.md` §5).

**A charge we made in error is different.** A double charge, a wrong amount, or a charge after a
cancellation took effect is always reversed, with no 14-day limit. Refund that payment in full
from its page in the Stripe Dashboard. Do not cancel the Stripe subscription unless the charge was after a
cancellation. Reply to the vendor that it was our error and is reversed. A subscription the vendor
bought twice is not our error: it follows the 14-day rule below.

**Never revoke a paid subscription (by card) in the admin panel.** The Stripe subscription still holds the quantity, so
the next webhook or the 01:15 reconcile grants the subscription back. Every change to a paid subscription goes
through Stripe, and the webhook writes D1.

1. **Check the date.** In the Stripe Dashboard open the customer, then the first payment. The ask
   must be within 14 days of it. Past that, reply with the refund rule and stop.
2. **Refund the payment** in full from the payment's page.
3. **Cancel the Stripe subscription immediately.** Open the Stripe subscription, choose Cancel, and pick
   "Immediately", not "At the end of the period". Stripe sends `customer.subscription.deleted`.
4. **Watch the subscriptions end.** The webhook ends every live subscription on the Stripe subscription `lapsed`,
   carries products over where it can, purges the pages and sends `managed-ended`. Check with the
   first query under "Stripe reconcile changed subscriptions", with `SUB` set to the Stripe subscription id.
5. **Reply to the vendor** that the refund is made and the products are on Free.

**Part of a purchase.** To refund some subscriptions of several, lower the Stripe subscription quantity in
Stripe with no proration, then refund that amount. The sync ends the surplus `released`: unassigned
subscriptions first, then those flagged release-at-renewal, then the most recently assigned. If the
vendor wants a particular product kept, ask them to unassign the others first.

## Stripe: annual opt-out

Not an alert. An owner can stop an annual renewal themselves: **Manage billing in Stripe** on the
Billing tab opens the annual portal configuration, which cancels at the end of the period only
(AECI-1516). Nothing for us to do then, and step 3 shows the same flag. These steps are the
fallback, for a vendor who emails before the renewal date instead.

1. **Check the Stripe subscription is annual and live.** In the Stripe Dashboard open the Stripe subscription.
   A Stripe subscription whose subscriptions all ended `banned` is not the vendor's to cancel: a termination cancels
   it at once, so it should already be canceled (see "Vendor suspension and termination").
2. **Cancel at the end of the period.** Choose Cancel and pick "At the end of the current period".
   Never "Immediately": the vendor paid for the term.
3. **Check the tab.** `customer.subscription.updated` flags every live subscription on it
   `cancel_at_term_end` with reason `vendor-cancelled`. The vendor's Billing tab says the
   Stripe subscription will not renew.
4. **Check the confirmation went.** The sync emails `renewal-cancelled` to every seat and the
   billing email, with the end date and that no further charge will be made (AECI-1596). Nothing
   more to send. The subscriptions end on that date, when Stripe deletes the Stripe
   subscription.

**Undo before the date.** Open the Stripe subscription and choose "Don't cancel" (Stripe's renew). The
webhook clears the `vendor-cancelled` flags.

**A monthly cancel by email.** Do the same as step 2. The subscriptions run to the end of the paid
month, and the same confirmation goes.

## Stripe: a company gives up its claim

Not an alert. A company gives up its claim, or loses its last seat without a termination: an owner asks us,
the last seat is removed, or the last account is deleted. Ruling (Chris, 2026-10-28, AECI-1516; the
Managed plan agreement, "If you give up your claim"): its subscriptions run to the end of the paid term,
do not renew, and are not refunded. Nothing does this automatically. A seat removal writes nothing
in billing (`VENDOR_SIGNUP_PROCESS.md` decision 15). Only a termination cancels by itself, and it cancels
at once ("Vendor suspension and termination"), which a give-up never does.

1. **Find the Stripe subscriptions.** Run this against production with `VENDOR` set to the vendor id. A
   complimentary or invoice subscription needs nothing: it ends on its end date as usual.

```bash
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT DISTINCT l.stripe_subscription_id, b.stripe_customer_id FROM licenses l JOIN billing_accounts b ON b.id = l.billing_account_id WHERE b.vendor_id = 'VENDOR' AND l.source = 'stripe' AND l.ended_at IS NULL"
```

2. **Cancel each at the end of the period.** In the Stripe Dashboard open the Stripe subscription, choose
   Cancel, and pick "At the end of the current period". This is the vendor's own cancel. Do
   not choose "Immediately", and do not refund.
3. **Check the flags.** `customer.subscription.updated` flags every live subscription on it
   `cancel_at_term_end` with reason `vendor-cancelled`. The subscriptions end when Stripe deletes the
   Stripe subscription, and the products move to Free. The sync also emails `renewal-cancelled` to any
   seats left and the billing email (AECI-1596).

Nothing clears this cancel for you: not a new seat, an unban or the reconcile. A company that claims
again before the date renews in **Manage billing in Stripe** itself, or asks us to choose "Don't
cancel".

## Vendor suspension and termination

Not an alert. An operator ends a vendor in two steps from `/admin/vendors/:id`: Suspend, then Terminate.
A suspension that sits past its window is a daily digest warning (`vendor_suspension_past_window`).
Ruled 2026-11-05 (AECI-1623, counsel's Q13 and follow-up, `VENDOR_SIGNUP_PROCESS.md` §2 decision 15).
Non-payment is a different path: a failed card keeps Managed on through Stripe's retries, and only a
Stripe cancel ends the subscriptions. Banning one seat from `/admin/users/:id` is a third thing. It
touches that seat only, and it is refused with `409 VENDOR_LAST_SEAT_USE_SUSPEND` on the last unbanned
seat. Use Suspend for that vendor.

**Write the rule and the evidence as facts.** Both are printed in the notice and stored in the audit
record. Say what was seen, where and when. Name no person unless the fact needs a name. Give no opinion
about motive. The internal reason is never sent, but it is stored too, so keep it factual as well.

**1. Suspend.** Choose Suspend on the vendor page. Pick the kind (`breach` or `false_claim`), write the
rule and the evidence for the vendor, and write the internal reason.

- Every seat loses the portal at once. Every `/api/vendor/*` call answers `403 VENDOR_SUSPENDED`, reads
  included. The one route that still works is the Stripe portal link, `POST /api/vendor/billing/portal`.
  The Billing tab stays blocked. A seat invite cannot be accepted while the vendor is suspended.
- The listing stays live. Billing, subscriptions and records are untouched. Nothing is purged.
- One notice (`vendor-suspended`) goes to the owner seats and the billing email. It names the rule and
  the evidence, states the 7 business days, and says the vendor can cancel by replying to the notice or
  from the Stripe portal.

**The clock.** The window of 7 business days starts at the first confirmed send of that stage's notice.
Business days are Monday to Friday with US federal holidays excluded. The window ends at the end of the
7th business day in New York, up to an hour late and never early. A failed send leaves the suspension
in place with no clock. The page says "not confirmed sent". Choose Re-send notice until it is
confirmed. A timed-out send counts as not confirmed. Until one send is confirmed, each re-send goes to every address, so an address can get the notice twice. Once the clock runs, a re-send reaches only addresses not yet reached. On staging and preview the delivery rule
withholds mail to outside addresses, and that counts as confirmed there so the flow can be tested.
In production it never does.

**2. Stage 2, only for a false claim.** If the vendor did not cure or rebut in stage 1 and you found it
claimed a company it does not represent, choose Start stage 2 after the stage 1 window ends. Write the
finding for the vendor. A second notice asks it to prove identity and authority, and a further 7
business days run from its first confirmed send. A suspension of kind `false_claim` cannot be
terminated before stage 2 has run its window. A `breach` suspension has no stage 2.

**3. Keep the cost log while the window runs.** Log cost the day it is incurred, one entry per task.
The server stamps the time, and an entry cannot be edited. A wrong entry is voided with a reason and
stays on the record. Only cost the breach caused counts.

| Kind | You enter | Counts as |
|---|---|---|
| `staff` | Work date, description, minutes | Minutes x $150 an hour, which is 250 cents a minute |
| `third_party` | Work date, description, amount | The amount paid to others |
| `recovery` | Work date, description, amount | A credit against the cost |

A work date cannot be in the future. The total is floored at zero, and it is capped at the refund
due, so it can never take more than the vendor would be owed. It is never used to keep prepaid fees
for the unused term.

**4a. Lift it.** If the vendor cured, or we were wrong, choose Lift and write the reason. Access is back
at once, billing never changed, and one `vendor-suspension-lifted` email goes out. Cost entries stay on
the record.

**4b. Terminate it.** Terminate is refused until the applicable stage has elapsed. There is no early
path, because the window is also the vendor's chance to show we are wrong. The page shows a preview
read from Stripe: each payment, the refund before cost, the cost total from the log and the refund
after cost.

1. Check the cost log. Terminate reads the log and nothing else.
2. For each invoice-paid subscription, type the amount it paid. Stripe cannot say. Card subscriptions
   need no typing.
3. Check the preview, then confirm. The page sends the gross refund and the cost total it showed. If either
   changed since the page loaded, the API answers `409 VENDOR_TERMINATION_REFUND_CHANGED` and writes
   nothing. Reload and check the new numbers.

The refund is paid x unused days / term days, minus cost, floored at zero. The period used ends on the
suspension date. A renewal charged inside the window comes back in full before cost. A payment
already part-refunded counts only for what is left.

One database batch then does all of this.

- Every unbanned seat is banned, with its audit and workflow rows. The vendor keeps its text.
- Every live subscription ends now, `end_reason = 'banned'`. An annual or complimentary row keeps its
  `ends_at` as the paid term end. A monthly Stripe row takes Stripe's `current_period_end`, or has no
  `ends_at` when Stripe could not be read.
- `vendors.owned_at` is cleared and the records return to AECi: markers back to `aeci`, integrations
  un-claimed, open contests moved to AECi, open product proposals deleted. The audit row is
  `vendor.records_returned` with `metadata.cause = 'vendor-banned'`. `usefulness_source` stays
  `vendor`. The claim ends too (`vendors.claim_ended_at`, AECI-1618), so pages read Unclaimed at once, and the
  daily brand asset removal clears `logo_source = 'vendor'` logos within 14 days (see `docs/runbooks/alerts.md` "Brand asset removal (AECI-1618)").
- Every pending seat invite is revoked.
- The suspension closes with the statement, and one refund row per payment lands `pending`.

If Stripe cannot be read while the vendor has card subscriptions, Terminate answers
`503 VENDOR_TERMINATION_STRIPE_UNAVAILABLE` and writes nothing. Try again shortly.

After commit, in order: one cache purge, the review app told the records are AECi's again, then every
Stripe subscription on the vendor's Stripe customer that Stripe can still bill is cancelled now with
no proration, and open Checkout pages are expired. That step gives up after 15 seconds. The refunds
follow, one at a time, each under its own idempotency key. Last, one `vendor-terminated` email goes to
every seat, banned seats included, and the billing email. It carries the itemized statement and states
what each refund really did. The statement is the vendor's route to dispute a cost: it writes to
`SUPPORT_EMAIL`. `managed-ended` is not sent.

**Check the termination.**

1. Open `/admin/vendors/:id` and the Billing section. Each subscription reads "ended by the vendor's
   ban". The products are on Free. The "Return records to AECi" control is gone.
2. In the Stripe Dashboard open the vendor's customer. Every Stripe subscription must be Canceled, no
   Checkout session may be open, and each refund must show on its payment.
3. Read the refund rows with `SUSPENSION` set to the suspension id.

```bash
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT id, status, paid_cents, gross_cents, cost_applied_cents, refund_cents, stripe_refund_id FROM vendor_termination_refunds WHERE suspension_id = '$SUSPENSION'"
```

4. Read the audit rows with `VENDOR` set to the vendor id.

```bash
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT created_at, action, json_extract(metadata, '$.paid_term_end_source') AS term_end_source FROM audit_log WHERE vendor_id = '$VENDOR' AND action IN ('vendor.suspended', 'vendor.suspension_notice_sent', 'vendor.terminated', 'vendor.termination_refund_paid', 'vendor.termination_refund_failed', 'license.banned', 'vendor.records_returned') ORDER BY created_at DESC LIMIT 30"
```

`term_end_source` is `ends_at`, `stripe` or `unknown`. `unknown` means Stripe could not be read, and
the log has `aeci.stripe.ban_period_end_unavailable`.

**A refund failed.** The refund row is `failed`, the audit row is `vendor.termination_refund_failed`
and the log line is `aeci.stripe.termination_refund_failed` with the reason. The termination stands and
the vendor is owed the money. The `termination_refund_unsettled` digest check lists a `failed` or
stranded `pending` row after a day. Fix the cause, then choose Retry refunds on the vendor page. Retry
looks up the payment's refunds first and treats one carrying this row's `aeci_refund_id` as paid, so a
first attempt that took the refund but lost its response cannot pay twice, however late the retry is. A
lookup that cannot answer pays nothing and leaves the row `failed`. Stripe replays a stored error for the
same idempotency key for up to 24 hours, so a retry inside that time can show the same failure. Try again
after 24 hours. A success sends the
statement again with the refund made. A `manual` row is an invoice-paid subscription. Pay it by hand,
outside Stripe, then write to the vendor from `SUPPORT_EMAIL` that it is paid. If
`aeci.stripe.termination_refund_record_failed` appears, Stripe took the refund but the row did not
update. Check the payment in the Stripe Dashboard before you retry.

**The cancel failed.** The log line is `aeci.stripe.ban_cancel_now_failed` with the vendor and the
Stripe subscription. A `reason` of `deadline 15000 ms` means Stripe was too slow and the step gave up.
The Stripe subscription is not cancelled in Stripe and no subscription on it is live. Nothing grants on
it: the vendor is terminated and fully banned, so the sync treats every billable Stripe subscription
of the vendor as ban-dead. A webhook event for it answers 503 until a cancel succeeds. The next
`customer.subscription.updated` event, or the daily reconcile at 01:15 UTC, cancels it. The reconcile
then emails `SUPPORT_EMAIL` with "Ban cancel: cancelled now" (`banCancelsNow` in `job_runs.detail`,
"Stripe reconcile changed subscriptions"). To act sooner, cancel the Stripe subscription in the Stripe
Dashboard: choose Cancel and pick "Immediately", with no proration. Refund the unused term from the
statement by hand, or choose Retry refunds.

A vendor left with only banned seats by a seat revoke is not ban-dead. It got no notice and no
refund, so its Stripe subscription is not cancelled. Suspend it first.

**Other warn lines from Terminate.** Each is isolated, and the termination stands.

| Log line | Meaning | Do |
|---|---|---|
| `aeci.moderation.terminate_followup_failed` | The whole post-commit step failed | Check the purge, the Stripe cancel, the refunds and the email by hand |
| `aeci.moderation.terminate_product_read_failed` | The product names could not be read | The email may name no products. Nothing to repair |
| `aeci.moderation.terminate_purge_failed` | The cache purge was not queued | Purge the vendor's `product:{slug}` and vendor tags (`CACHE_STRATEGY.md`) |
| `aeci.moderation.terminate_email_failed` | The `vendor-terminated` email did not go | Write to the vendor from `SUPPORT_EMAIL` with the statement |
| `aeci.stripe.ban_checkout_expire_failed` | An open Checkout page was not expired | Expire it in the Stripe Dashboard. If the vendor pays it first, the sync cancels the new Stripe subscription as ban-dead |
| `aeci.stripe.termination_refund_failed` | A refund was not made | See "A refund failed" |
| `aeci.stripe.termination_refund_record_failed` | A refund row did not update | See "A refund failed" |

**A `409 VENDOR_SEATS_CHANGED` on Suspend, Stage 2 or Terminate.** A seat, an invite, a product proposal
or a subscription landed while the request ran. Nothing was saved. Reload the page and try again.

**A vendor asks to cancel while suspended.** It can reply to the notice, or use "Manage billing in
Stripe" on its suspended screen. The portal cancels at the end of the period. For a reply, cancel the
Stripe subscription at the end of the period, as in "Stripe: annual opt-out", never "Immediately".
A cancel does not lift or end the suspension. Decide that separately.

**Reinstate a seat after Terminate.** On the seat holder's page choose Reinstate. It lifts the seat
ban and re-stamps `vendors.owned_at`, so the vendor owns its records again. It restores no
subscription, no invite and no contest, and the suspension stays terminated. The contests the
termination moved to AECi stay with AECi. The portal is open again for that seat. Then give the vendor
its term back.

**Grant the ban term.** Open `/admin/vendors/:id` and the Billing section. The control "Grant
complimentary subscriptions for the ban term" lists one row per product whose subscription the
termination ended and that holds no live subscription now. A product drops off the list once any
subscription on it was created after the ban, even one that has since ended. So a ban-term
subscription that lapsed or that you revoked does not bring the row back, and the API refuses a second
grant from the same ended subscription. Each date is prefilled from the ended subscription's
`ends_at`. Where the date is empty, Stripe could not be read at the time: the control says "Term end
unknown", and you must enter the date the vendor had paid through. A prefilled date you leave alone is
sent as stored. Untick a product to leave it on Free. Choose "Review the ban-term subscriptions", then
confirm with "Grant complimentary subscriptions for the ban term". Since AECI-1615 (2026-11-10) this
writes one pending grant, and the owner seats get `license-grant-pending`. Nothing is on Managed until an
owner accepts it on the vendor's Billing tab. Then each subscription is complimentary, assigned to its
product, with the reference "Complimentary for the ban term", and the vendor gets one
`licenses-granted` email per end date. A product that took a subscription while the grant waited gets
its new one unassigned in the pool. A product already named by a pending ban-term grant drops off the
list. The control refuses while the vendor has no unbanned seat
(`VENDOR_STILL_BANNED`) and for a product that already holds a live subscription
(`LICENSE_PRODUCT_ALREADY_LICENSED`). If the last seat is banned again while you grant, the grant
answers `VENDOR_SEATS_CHANGED` and writes nothing. Each end date must be after today in UTC, the rule
the API applies, so late in a US evening tomorrow's date may still be refused. A retry of the same
grant answers 200 and writes nothing, even though the products are subscribed now.

**Any other grant waits for the unban.** Unban first, then grant. The ordinary "Grant subscriptions"
control refuses a vendor whose every owner seat is banned with `VENDOR_STILL_BANNED` and writes
nothing (ruled 2026-11-03). A vendor nobody has claimed yet, with no seat at all, is still
grantable. If the last seat is banned while you grant, the grant answers `VENDOR_SEATS_CHANGED`
and writes nothing. A retry of a grant made before the ban still answers 200.

**One-off: a vendor banned before AECI-1589.** Before 2026-11-03 a last-seat ban only flagged the
subscriptions `cancel_at_term_end` with `cancel_reason = 'vendor-banned'` and set the Stripe subscription
to cancel at period end, marked `aeci_ban_cancel = "true"` in its metadata. Production has no
Stripe subscriptions, so this concerns staging only. Nothing reads that marker any more, so nothing
clears or re-applies it. Find the vendor's flagged subscriptions with `VENDOR` set.

```bash
cd /tmp && npx wrangler d1 execute aeci-app-staging --remote --command "SELECT l.id, l.stripe_subscription_id, l.ends_at FROM licenses l JOIN billing_accounts b ON b.id = l.billing_account_id WHERE b.vendor_id = '$VENDOR' AND l.ended_at IS NULL AND l.cancel_reason = 'vendor-banned'"
```

To apply the new rule to such a vendor: reinstate the last seat, which clears the legacy flags, then
Suspend and Terminate it. To keep the vendor instead: reinstate the seat, then open the Stripe
subscription in the Stripe Dashboard and choose "Don't cancel", because the old period-end cancel stays
set until someone clears it. Delete the stale `aeci_ban_cancel` metadata key by hand if it bothers you.
Nothing depends on it.

## Stripe webhook endpoint disabled

**Signal:** Stripe emails that an endpoint is failing or was disabled, or the reconcile alert fires
every day for new purchases. Stripe disables an endpoint after days of failed deliveries. Until it
is enabled again, subscriptions arrive only through the 01:15 reconcile, up to a day late.

1. **Fix the cause first.** Read the failed deliveries in Workbench, Webhooks, the tier's endpoint.
   A 401 is a secret mismatch: see "Stripe: rotate the webhook secret". A 503 with reason
   `stripe_unconfigured` is "Stripe webhook answers 503". A 503 with reason `http_error` is the
   Stripe subscription re-read failing with a Stripe 5xx, 429, 401 or 403. A 503 with reason
   `ban_dead_cancel_failed` is a terminated vendor's Stripe subscription whose cancel failed again: see
   "The cancel failed" under "Vendor suspension and termination". A lasting 401 or 403 means
   `STRIPE_SECRET_KEY` is wrong or revoked, so push the right key. A 404 means the deployed Worker has no
   route yet, which is expected before the AECI-1339 promote reaches that tier.
2. **Enable the endpoint** in Workbench, Webhooks, the endpoint, Enable.
3. **Resend what matters.** Stripe keeps events for 30 days. Resend the failed
   `checkout.session.completed` and `invoice.paid` events from the endpoint's event list. A
   replay of an event we already handled answers 200 `replay`, so resending is safe.
4. **Or wait for the reconcile.** It syncs every Stripe subscription at 01:15 UTC and backfills a missing
   acceptance. Lost `invoice.payment_failed` emails are not resent by it.

## Stripe: rotate the webhook secret

Do this when the secret may have leaked, or when a 401 `mismatch` shows the two sides disagree.
The steps are for production. For demo use `STRIPE_WEBHOOK_SECRET_DEMO` and `--env demo`.

1. **Prep.** Have the Stripe Dashboard open on the live account, and a shell in the repo root.
2. **Roll the secret in Stripe.** Workbench, Webhooks, the endpoint, Roll secret. Let the old
   secret expire in 24 hours, not now. Until then Stripe signs each event with both secrets, and
   the verifier accepts either `v1=` signature.
3. **Store the new secret in GitHub**, so every later promote pushes it. The command prompts for
   the value.

```bash
gh secret set STRIPE_WEBHOOK_SECRET_PRODUCTION
```

4. **Push it to the Worker now**, so you need no promote. The command prompts for the value.

```bash
pnpm --filter @aeci/api exec wrangler secret put STRIPE_WEBHOOK_SECRET --env production
```

5. **Check a delivery.** Send a test event from the endpoint or wait for a real one. It must answer
   200, and `aeci.webhooks.stripe.signature_failure` must stay at 0.

## Stripe webhook answers 503

**Signal:** Stripe shows deliveries answered 503 with `reason: stripe_unconfigured` in the body.

**What it means.** `STRIPE_WEBHOOK_SECRET` is set on the tier, so the signature passed, but
`STRIPE_SECRET_KEY` is not. The webhook cannot re-read the Stripe subscription, so it refuses with a
retryable 503 and writes nothing. This is kept on purpose: Stripe retries a 503 for three days, so
no event is lost while the key is missing. A 200 would drop it.

1. Push the key. Set `STRIPE_SECRET_KEY_PRODUCTION` (or the tier's suffix) in GitHub, then push it
   to the Worker. Each command prompts for the value.

```bash
gh secret set STRIPE_SECRET_KEY_PRODUCTION
```

```bash
pnpm --filter @aeci/api exec wrangler secret put STRIPE_SECRET_KEY --env production
```

2. Stripe's next retry succeeds. If retries have stopped, follow "Stripe webhook endpoint disabled"
   from step 2.

## Stripe: set the webhook endpoint API version

Stripe renders each event in its endpoint's API version. That version must equal
`STRIPE_API_VERSION` in `apps/api/src/lib/stripe.ts`, today `2026-09-30.endive`. Stripe fixes an
endpoint's version when it is created, and an existing endpoint cannot change it. So a wrong version
means a new endpoint.

1. **Prep.** Have the Stripe Dashboard open on the tier's account, and the Stripe CLI logged in to
   it.
2. **Read the version.** Workbench, Webhooks, the endpoint, shows its API version. If it already
   reads `2026-09-30.endive`, stop.
3. **Create a new endpoint** at that version, with the same URL and the same five events:
   `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.updated` and `customer.subscription.deleted`. The Dashboard creates at the
   account's default version only, so use the API or the CLI and pass the version. This is the
   production command. For demo, run it in the demo sandbox with `https://demo.aecintegrations.com`.

```bash
stripe webhook_endpoints create --live --url https://www.aecintegrations.com/api/webhooks/stripe --api-version 2026-09-30.endive -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=invoice.paid" -d "enabled_events[]=invoice.payment_failed" -d "enabled_events[]=customer.subscription.updated" -d "enabled_events[]=customer.subscription.deleted"
```

4. **Swap the secret.** The output carries the new endpoint's `secret`. Store and push it as in
   "Stripe: rotate the webhook secret" steps 3 and 4.
5. **Delete the old endpoint** in Workbench. While both exist, each event arrives twice. The second
   copy answers 200 `replay`, because the `stripe_events` row has the event id, so the overlap is
   safe. Only the old endpoint's deliveries fail, with 401, once the secret is swapped.
6. **Record the new endpoint id** in `.context/stripe-setup-checklist.md` or the epic.

## Turning on Stripe in production

Run once, in this order (AECI-1339, the P7 switch-on). Each step depends on the one before it.
Until step 8, production keeps `STRIPE_CHECKOUT_ENABLED="false"`, so no vendor sees Pay by card.

1. **Prep: re-set the staging secrets under their tier names.** The staging values sit in GitHub
   under the unsuffixed names, which no workflow reads (`environments.md`, "Stripe secrets per
   tier"). Set the two suffixed names, then delete the old pair. Each `set` prompts for the value.

```bash
gh secret set STRIPE_SECRET_KEY_STAGING
gh secret set STRIPE_WEBHOOK_SECRET_STAGING
gh secret delete STRIPE_SECRET_KEY
gh secret delete STRIPE_WEBHOOK_SECRET
```

2. **Set the webhook endpoint API versions** on staging, demo and live, by "Stripe: set the webhook
   endpoint API version". Push each new secret before the next step.
3. **Confirm the live portal configurations.** In the live account, Settings, Billing, Customer
   portal. The monthly configuration must have quantity update off and plan switching off, with
   cancel at period end on. The annual one must match: cancel at period end on, no immediate
   cancel, no proration (AECI-1516). A quantity change in the portal would bypass the Add
   subscriptions pro-rating, and a plan switch would mix intervals. Also in the live account's customer
   email settings, turn on emails for successful payments. Stripe attaches the
   invoice PDF, with its renewal footer, only when these are on (AECI-1596).
4. **Rehearse on demo** with a sandbox test card. Demo ships `STRIPE_CHECKOUT_ENABLED="false"`
   while it mirrors production, so first set it to `"true"` in the `demo` block of
   `apps/api/wrangler.jsonc` and in `apps/api/src/stripe-secrets-ci.spec.ts`, merge, and promote
   to demo. Then: buy 2 annual with `PILOT2026`, assign one, add 1,
   open Manage billing in Stripe, cancel the annual Stripe subscription at period end and check the tab
   says it will not renew, cancel a monthly Stripe subscription, and trigger a failed payment
   with `stripe trigger invoice.payment_failed`. Check three AECI-1596 items: the renewal disclosure
   sits above the terms box on Stripe's page, the invoice PDF carries the renewal footer, and each
   cancel sends `renewal-cancelled`. A customer linked before AECI-1596 has no footer, and no
   backfill exists, so rehearse with a new vendor. Production had no Stripe customers at that date. Record the run in `STAGE_2_1_REHEARSAL.md` style.
5. **Get the lawyer read** of the Managed plan agreement, including the tax line. If counsel
   changes the text, bump the version in both registries and append `1.0` to
   `LEGAL_AGREEMENT_KNOWN_VERSIONS` (`packages/shared/src/api/agreements.ts`).
6. **Promote to production** as usual. The promote pushes the two `_PRODUCTION` secrets and creates
   the reconcile queue.
7. **Re-enable any disabled endpoint.** Stripe may have disabled the live endpoint while the route
   did not exist. Follow "Stripe webhook endpoint disabled" from step 2. Then confirm the live
   endpoint's next deliveries answer 200. Do this before step 8, so the first purchase has a
   working webhook.
8. **Flip `STRIPE_CHECKOUT_ENABLED`** to `"true"` in the `production` block of
   `apps/api/wrangler.jsonc`, and update the matching expectation in
   `apps/api/src/stripe-secrets-ci.spec.ts`. Merge, then promote again.
9. **Move the reconcile liveness date.** In `observability/posthog/project-config.json`, set the
   `stripe-reconcile` entry's `activeFrom` (today the placeholder `2026-11-15T02:00:00Z`) to the
   step 6 promote plus one day, at `02:00:00Z`. It may ride the step 8 change. Delete it once the
   first production heartbeat is in.

**Rolling back.** Set `STRIPE_CHECKOUT_ENABLED` back to `"false"` and promote. The panel hides and
the checkout routes answer 503. The webhook and the reconcile keep running, so existing Stripe
subscriptions stay in sync.

## Pilot vendor terms: set, extend, end

Not an alert. This is the operator procedure for a pilot vendor's free Managed term.

*As revised 2026-10-19 (AECI-1404, E6.1):* a subscription now ends on its own on its end date. The 11:00 UTC job ends every passed term before it sends the 45-day warnings (`STAGE_2_PAID_TIERS_SPEC.md` §7.6). The operator no longer ends a pilot by hand, so the AECI-1325 ruling (`STAGE_2_PAID_TIERS_SPEC.md` §7.3) is superseded on that point. Every step runs on the Billing tab with subscriptions (AECI-1375). The older procedures are in git history.

**The model.** Each pilot vendor gets its own one-month term, counted from the day it signs on. There is no shared end date. An extension is case by case, one month at a time. A pilot that is not extended ends on its end date with no operator step.

**Which vendors are on a pilot.** There is no fixed list. A pilot vendor is one holding complimentary subscriptions granted with "Pilot" in the grant notes. The notes go to the audit trail only. A calendar reminder per vendor is optional now. It is only useful to decide on an extension before the end date.

### 1. Start the pilot

1. Open the vendor at `/admin/vendors/:id?tab=billing`.
2. Choose **Grant subscriptions**. Number: one per product in the pilot. Source: Complimentary.
3. Set the start date to the sign-on date and the end date to the sign-on date plus one month.
4. Put "Pilot" and the sign-on date in **Notes**.
5. Confirm.
6. Tell the vendor's owner to accept the grant on its own Billing tab, then assign the subscriptions to products there. A grant assigns nothing.

*As built 2026-11-10 (AECI-1615):* the grant waits until an owner accepts it, so no subscription exists before then. If the pilot has a signed deal, record it instead (see "Grant subscriptions: record a signed deal, withdraw a pending grant"). The warning email below starts once the grant is accepted.

The next 11:00 UTC run emails the vendor's seats, its billing email when set, and `SUPPORT_EMAIL`. A one-month term is inside the 45-day warning window from its first day, so this is expected. The vendor copy gives the end date and the renewal offer, then says what the vendor keeps on the Free plan if it does not renew. It does not promise the plan continues. A vendor's reply goes to `SUPPORT_EMAIL`.

### 2. Extend the pilot

Do this **before** the end date. On the end date itself, do it before 11:00 UTC.

1. Open the vendor at `/admin/vendors/:id?tab=billing`.
2. On each live `licenses` row, choose **Extend**. Or check the rows and choose **Set end date**. Set the new end date one month later.
3. Confirm.

Extend resets the subscription's warning stamp, so the vendor gets a fresh notice for the new term. An extend that commits while the 11:00 run is ending the same term wins. The run rolls that term back, reads it again once, and ends only the subscriptions still on the term. An extended subscription stays live.

### 3. The pilot ends

Nothing to do. On the end date, the 11:00 UTC run ends every live subscription of the term.

| Effect | Detail |
|---|---|
| Subscription | `ended_at` is set. `end_reason` is `lapsed`, or `released` for a subscription the vendor flagged "release at renewal". The subscription keeps its product as history. |
| Plan | Each product on an ended subscription moves to the Free plan, unless the account holds a live unassigned subscription that does not end yet. Then the products assigned longest move onto those subscriptions and stay Managed (decision 12, AECI-1405). Seats, logins and everything the vendor entered stay. |
| Portal | The plan-ended banner shows once no subscription is live (`STAGE_2_PAID_TIERS_SPEC.md` §13.11). |
| Email | Each seat and the billing email get one `managed-ended` email per term for the products that lapsed, and a separate one for the products released. |
| Cache | The product and vendor pages are purged. |
| Owner contests | A lapse moves no contest. Since ruling 14 (2026-11-09, AECI-1663) an owner decides contests on its connector-powered rows on any plan. Older `integration.contest.rerouted` rows with source `license-lapse-cron` are from the retired ruling B, and those contests stay with AECi. |

To end a pilot **early**, revoke the subscriptions on the Billing tab with "Pilot ended" as the reason. A revoke records `revoked` and emails `managed-ended` per product. It moves no contest (since AECI-1663).

To check a run, read the latest `entitlement-expiry` row in `job_runs`. Its `detail` carries `lapsed_terms`, `lapsed_licenses`, `carried` and `lapse_batch_failures`. A raced term is rebuilt once from a fresh read. A non-zero `lapse_batch_failures` is a term that raced twice, or a D1 error. Either way the next run reads that term again.

### 4. Undo a wrong lapse

A lapse is terminal. An ended subscription never comes back, and Extend works on live subscriptions only. So a wrong lapse is undone with a new grant plus a re-assign.

1. Open the vendor at `/admin/vendors/:id?tab=billing`. Choose **Grant subscriptions** with the same number, source and reference as the ended subscriptions, and the correct end date. This is the extend.
2. Ask the vendor's owner to accept the new grant and re-assign the subscriptions to the same products from its own Billing tab. There is no admin assign. Until the owner accepts and assigns them, the products stay on Free. Since AECI-1615 the grant waits for that accept unless you record a signed deal.

The accept emails `licenses-granted`. The `managed-ended` email has already gone, so tell the vendor that Managed is back. The Managed-field content was never removed, so nothing else needs restoring.

### `lapsed` versus `revoked`

A pilot that ends on schedule reads as `lapsed` in the audit log and in reports (`license.lapsed`). One flagged "release at renewal" reads as `released`. A revoke stays `revoked`. Rows written before 2026-10-19 show scheduled pilot ends as `revoked` with the reason "Pilot ended". Treat those as normal pilot ends. The vendor sees no difference: the banner reads "Your Managed plan has ended" for every cause.

## Grant subscriptions: record a signed deal, withdraw a pending grant

Not an alert. The operator procedure for a grant that must not wait for the owner's click, and for
taking back a grant nobody should accept. Since AECI-1615 (2026-11-10, counsel Q5) every grant waits as
"Waiting for acceptance" until an owner ticks the box on the vendor's Billing tab
(`VENDOR_SIGNUP_PROCESS.md` §3 step 5). A grant nobody accepts expires at its end date on its own.

### Record a signed deal

Use this only when a person with authority for the vendor has signed a deal that names the Managed plan
agreement by version and date and says that signing accepts it.

1. Have the signed deal open. Check it names the current Managed plan agreement version. The grant form
   refuses any other version, because a substituted version needs a new acceptance.
2. Open the vendor at `/admin/vendors/:id?tab=billing` and choose **Grant subscriptions**.
3. Fill in the grant as usual: number, source, dates, reference and notes.
4. Open **Recorded signed deal**. Enter the signer's name and role, the company's legal name, the
   signer's email, the deal reference, the version and date the deal names, and the date it was signed.
   Tick the box that the deal says signing accepts the agreement.
5. Confirm. The message reads "Active: recorded signed deal". The subscriptions are in the vendor's pool
   now, and the vendor gets `licenses-granted`. The owner sees no prompt.

Check the Grants table on the same tab: the row reads Accepted with method Signed deal. The acceptance
row records the signer, the deal reference and the signed date, and no IP address.

### Withdraw a pending grant

Use this when a grant was made in error, or its deal fell through before an owner accepted.

1. Open the vendor at `/admin/vendors/:id?tab=billing` and find the row in **Grants** that reads
   "Waiting for acceptance".
2. Choose **Withdraw**. Enter the reason, up to 500 characters. It stays in AECi's records and is not
   sent to the vendor.
3. Confirm. The row reads Withdrawn. No email goes out and no page changes.
4. Tell the vendor's owners yourself if they already saw the `license-grant-pending` email.

If the answer says the grant is no longer waiting, an owner accepted it or it expired first. Reload the
tab. An accepted grant's subscriptions are ended with **Revoke** on each subscription row, as in
"Pilot vendor terms: set, extend, end".
