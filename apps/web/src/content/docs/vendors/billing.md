---
title: Billing
description: How Managed subscriptions work on AEC Integrations. What a subscription costs, paying by card, adding subscriptions, managing billing in Stripe, renewal and cancelling, refunds, failed payments, the Billing tab, and what happens when a subscription ends.
section: vendors
order: 12
last_updated: November 10, 2026
---

Managed is sold as subscriptions. One subscription puts one product on Managed. Your company's subscriptions are held on its billing account. Owners see them on the **Billing** tab and put each one on a product.

## Subscriptions and prices

- One subscription covers one product. A product is on Managed while it holds a subscription. A product with no subscription is on Free.
- A Managed subscription costs $250 a year, or $25 a month. Monthly has no commitment.
- A subscription stays on its product until renewal. Taking it off sooner is a request to us. See "Free a product's subscription" below.
- Each subscription shows its source. **Card** means an owner bought it on the Billing tab and it is paid by card through Stripe. **Invoice** means we granted it against your invoice reference. **Complimentary** means we granted it at no charge, with an end date.
- A subscription we grant starts when an owner accepts it on the Billing tab. See "Accept a subscription we grant" below.

Plans change what a listing can show, never where it ranks. [Plans](/docs/vendors/plans#compare-plans) compares what Free and Managed include.

## Paying by card

Only an owner can pay. On the **Billing** tab, the **Pay by card** panel takes you to Stripe, which handles the payment.

1. Choose **Annual**, at $250 a year per subscription, or **Monthly**, at $25 a month per subscription.
2. Enter the number of subscriptions, from 1 to 100. The panel shows what you pay today, what renews and when, and how to cancel. The Stripe page repeats this.
3. Check **Your title**. The field is filled in from your claim when you made one, and you must have a title in it. We record it with your acceptance of the agreement.
4. Choose **Continue to Stripe**.
5. On the Stripe page, enter your card and billing address. Tick the box to accept the [Managed plan agreement](/legal/managed-plan-agreement). The page repeats the renewal terms and the agreement's limit of liability above the Pay button. If you have a discount code, enter it there.
6. Pay. Stripe emails you a receipt and sends you back to the Billing tab.

Prices do not include tax. Stripe adds sales tax where it applies, and shows it before you pay and on the receipt. You can add your company's tax ID on the Stripe page.

Your new subscriptions usually appear on the tab within a minute. The tab checks for them and tells you when they arrive. They land in your pool, unassigned, and we email you how many you have. Then put each one on a product. See "Put a subscription on a product" below.

A company has one Stripe plan, billed either yearly or monthly. Every subscription paid by card is on it and follows the same schedule. Once you have a Stripe plan, the panel offers **Add subscriptions** instead.

If the tab shows no **Pay by card** panel, paying by card is not open for your company yet. If you need subscriptions before then, you will need to [contact us](/contact).

### Your card statement

Your card statement shows the charge as **THE WBS PROJECT**. The WBS Project operates AEC Integrations.

## Adding subscriptions

Choose **Add subscriptions** on the Billing tab and enter how many. New subscriptions join your Stripe plan and are billed on the same schedule.

Stripe charges your card at once for the rest of the current period, pro-rated, plus tax where it applies. From your next renewal, each subscription is billed at the full price. The new subscriptions appear in your pool once Stripe confirms the payment.

If Stripe cannot take that payment, for example because the card is declined or your bank's security check is not finished, your card is not charged and no subscriptions are added. The dialog says so. Check your card in **Manage billing in Stripe**, then add the subscriptions again.

## Manage billing in Stripe

**Manage billing in Stripe** opens Stripe's billing page for your company. There you can:

- change the card you pay with,
- see and download your invoices and receipts,
- cancel monthly billing.

The number of subscriptions and the billing schedule are not changed there. To add subscriptions, use **Add subscriptions**. Reducing your subscriptions is a request to us.

After your billing ends, **Manage billing in Stripe** still shows on the Billing tab. It opens your past invoices and receipts.

## Renewal and cancelling

**Annual.** Annual billing renews each year unless you opt out before the renewal date. To opt out, an owner cancels the renewal in **Manage billing in Stripe** before that date. Or email us before that date, and we cancel it for you. Either way the subscriptions run to the renewal date and then end. Until then the tab shows that your billing will not renew, and you can renew it in Stripe if you change your mind. Forty-five days before that date, we email every seat and your billing email the date, the price, the subscription count and any change to the terms.

**Monthly.** Cancel any time, in **Manage billing in Stripe** or by emailing us. Cancelled monthly billing runs to the end of the month you paid for. Until then the tab shows that it will not renew. If you change your mind before that date, you can renew it in Stripe.

A new price never applies mid-term.

To opt out or cancel by email, write to [support@aecintegrations.com](mailto:support@aecintegrations.com).

When your card billing is cancelled, either way, we email every seat and your billing email. The email gives the date it ends and confirms we will not charge you again.

## Refunds

We refund a subscription in full if you ask within 14 days of the first charge, and within 14 days of a renewal charge. We do not refund after that, except where applicable law provides otherwise. To ask, write to [support@aecintegrations.com](mailto:support@aecintegrations.com).

If we charged you in error, we reverse it whenever you tell us, with no 14-day limit. That covers a double charge, a wrong amount, and a charge after your cancellation took effect. A subscription you bought twice is not a charge made in error.

A refund ends the subscriptions it paid for, and their products move to Free. The money goes back to the payment method you paid with. Your card's own dispute rights are not affected.

If we end your subscriptions after suspending your company's account, a different rule applies. We refund the unused part of the term, less the fees for the period you used and our documented cost, and we send you an itemized statement. The [Managed plan agreement](/legal/managed-plan-agreement) sets out the terms.

## If a payment fails

Stripe retries a failed card payment on its own schedule and emails you. We also email your billing email and every seat. Your products stay on Managed while Stripe retries. To fix it, update your card in **Manage billing in Stripe**.

If the last retry fails, Stripe cancels your billing. The subscriptions on it then end, and their products move to Free.

## The Billing tab

Owners see a **Billing** tab in the vendor portal. Members do not. It has these parts.

- **Subscriptions waiting for you.** Shown only while we have granted your company subscriptions that no owner has accepted yet. See "Accept a subscription we grant" below.
- **Billing email.** Subscription, payment, renewal notice and plan-end emails go to this address and to every seat. Choose **Change** to set it. Leave it empty and save to remove it. The change is recorded on your **Changes** tab. The address itself is not shown there. AEC Integrations can also set or remove it for you, and that change is recorded there too. If it is empty when you first pay by card, it is set to the email you gave Stripe.
- **Company legal name.** Your company's full legal name. We record it when an owner accepts the Managed plan agreement. A claim fills it in when you first claim, and only while it is empty. Choose **Change** to correct it. Leave it empty and save to remove it. The change is recorded on your **Changes** tab. AEC Integrations can also set or remove it for you.
- **Pay by card**, or **Your Stripe plan** once you have one. It shows how many subscriptions it holds, whether it is billed yearly or monthly, and when it renews or ends. **Add subscriptions** and **Manage billing in Stripe** are here.
- **At a glance.** A card that counts your live subscriptions: how many are on a product and how many are unassigned. It also shows how many of your products are on Free, and how many subscriptions come off at renewal, when either count is above zero.
- **Subscriptions.** One subscription covers one product. Each row shows the source, the product, the start and end dates, the status and your reference, such as an invoice or purchase order number. A subscription with no product reads **In pool, not assigned**. A monthly subscription paid by card has no end date.
- **Agreements.** The agreements your company accepted, with who accepted each one and when, and the signer's name, title and the company's legal name where we recorded them.

### Accept a subscription we grant

When we grant your company subscriptions, at no charge or against your invoice, they wait for an owner to accept them. Nothing changes on your listings until then. Each owner gets an email, and one reminder a week later.

1. Open the **Billing** tab. The **Subscriptions waiting for you** panel shows each grant: how many subscriptions, the source, the dates, and the version of the Managed plan agreement that applies to it.
2. Read the agreement. The link opens that version.
3. Check **Your title**. We record it with your acceptance.
4. Tick the box to accept the Managed plan agreement, then choose **Accept**.

The subscriptions land in your pool, unassigned, and we email you how many you have. Then put each one on a product. A grant that gives back subscriptions we ended puts each one back on its product, unless that product already has one.

The version shown applies to that grant for its whole term, even if we publish a later version meanwhile. If no owner accepts by the grant's end date, the grant ends unused. We may also withdraw a grant before it is accepted. If your company signed a deal with us that accepts the agreement, we record the deal and the subscriptions start without this step.

### Put a subscription on a product

On a subscription in the pool, pick the product in the **Product** list, choose **Assign**, then confirm with **Assign subscription**. The list offers only products that hold no live subscription. Once assigned, the product is on Managed. The subscription stays on that product until renewal. If a subscription from a grant is still in the pool a week after it was accepted, and a product of yours is on Free, each owner gets one email reminder.

### Free a product's subscription

Open the actions menu at the end of the subscription's row and choose **Release subscription**. Then pick when:

- **At renewal.** The subscription comes off its product at the next renewal, and the product goes back to Free then. The row shows **Releases at renewal**. To undo it, choose **Keep at renewal** from the same menu.
- **Now.** Give a reason and choose **Send request**. We review the request. If we approve it, the subscription goes back to your pool and the product goes back to Free. The row shows **Early unassign requested** until we answer.

## When a subscription ends

When a subscription ends, its product moves to Free. Its Managed fields become read-only. To change them in the future, you will need to purchase a subscription.

If your pool has spare subscriptions, the products assigned longest keep one and stay on Managed. A product you set to release at renewal does not move.

Ending a plan removes nothing you entered, and your seats and listings stay. An owner can still remove the text the company wrote for 30 days. [When a Managed plan ends](/docs/vendors/plans#when-a-managed-plan-ends) lists what keeps working and what changes.

## Related

- Previous: [Plans](/docs/vendors/plans).
- Next: [Your checklists](/docs/vendors/checklists).
- [Your seat](/docs/vendors/your-seat), for owners and members.
- [Notifications and messages](/docs/vendors/notifications-and-messages), for the emails we send about subscriptions.
