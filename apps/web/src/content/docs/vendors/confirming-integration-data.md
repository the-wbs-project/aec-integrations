---
title: Confirming integration data
description: How to say whether the data flows recorded under an integration are right, what readers see as a result, what happens when the two companies disagree, and how to talk a row over with the other company.
section: vendors
order: 7
last_updated: October 30, 2026
---

An integration's own page lists the data that moves between two products: a model, a schedule, an RFI, and so on, each in one direction. We call each of those a data flow. In the portal they are the rows under **Data that's shared**. The public integration page shows the same rows as types of data, under headings such as "Sends to (other product)". Most of them were recorded by AEC Integrations from public sources. Answering Yes or No on that page is how the company at either end says whether a flow is right.

Answering needs a seat and the Managed plan. A company on Free can see every flow and every answer, but cannot answer. See [Your seat](/docs/vendors/your-seat) and [Plans](/docs/vendors/plans).

## Open the integration's page

In the vendor portal, open one of your products, choose **Integrations**, then choose the integration from the list. Each integration has its own page, with a **Data that's shared** section listing every flow.

## Say Yes or No to a data flow

A row you have not answered yet has two buttons:

- **Yes** says the flow is right.
- **No** says it is wrong.

**Yes** saves at once. If the other company has already said No, choosing Yes instead opens a short form so you can add a note explaining your side. The note is optional there.

**No** opens a form asking why. Give a reason: it is required, so the other company and AEC Integrations know what to fix. If the direction is wrong, say so there too. Saving records your No and adds a corrected row for you, in one step.

## Change an answer

Once you have answered a row, it shows your answer as text, Yes or No, with a **Change** link beside it. This stops a stray click from changing an answer you meant to keep.

Choose **Change** to bring back the two buttons for that row. Then choose the other answer, or choose the pressed button again to take back your answer. Press Escape to leave the row as it was. Once you save, the row shows your answer as text again.

## When the direction is wrong

If you say No because the direction is wrong, the page records your No on the row and adds the corrected row for you. It shows the two together: the row you said No to, and under it a box headed **You submitted a change**. The box says what the direction becomes, gives your reason, and says whether the other company has answered the corrected row yet: it has not answered, it agrees, or it disagrees. If it gave a reason, choose the i button beside that line to read it.

The box ends with two links:

- **Change** opens the reason form again, with your reason and the corrected direction filled in. Edit the reason, pick another direction, or pick another reason for the No.
- **Cancel** takes back both answers: your Yes on the corrected row and your No on the original. The original row then needs your answer again.

A corrected row you added stays on record after you cancel the change or pick another direction. It shows again as a row with no answer from you, and it no longer says it is waiting for the other company. See [Current limits](/docs/vendors#current-limits).

Readers do not see that row. A row your company added leaves the public integration page once no company's Yes stands on it. It comes back if a company says Yes to it again or AEC Integrations lists it.

Your note is not public. Only the company at the other end of the integration and AEC Integrations see it. If your company makes both products, only AEC Integrations sees it.

Several people at your company can hold seats, but your company has one position on each flow. The latest answer from anyone at your company is your company's answer.

You can answer on any integration where one of your products is at an end. An integration that runs through a connector product shows its rows as **Not needed**: AEC Integrations keeps those up to date, and neither company answers for them.

## Add a data flow

If a flow is missing, choose the **Add data that's shared** button above the table. Pick the data type from the list, set the direction, and add a note if it helps. Adding a flow also records your company's Yes on it.

The list of data types is fixed. If what you need is not on it, tell us through the correction route.

When the company at the other end adds a flow, it shows in your table with **Needs your answer**, and **Change requests** asks "(Company) added (data). Is this right?". If that company later takes back its Yes, says No to it, or changes its direction, the question leaves **Change requests** and your to-do lists. The row stays in your table, reads **Withdrawn by (company)**, and you can still answer it.

## Talk it over with the other company

A data flow that either company added, and a flow the two companies disagree on, each has a private conversation. It sits at the end of the row's item under **Change requests**, on the integration's own page. The two companies can use it to settle the row without AEC Integrations.

A row has a conversation only when two different companies make its two products, and the integration does not run through a connector product. A change request has none. You do not need the Managed plan to write in one.

### Who sees it

Only the two companies on the row and AEC Integrations see a conversation. The line above the message box says so: "Only (Company) and AEC Integrations see this." Everyone with a seat at your company sees the same conversation. Nothing in it shows on a public page, and it does not change how a flow is labelled or where a product ranks.

The heading names the company you are writing to: "Conversation with (Company)". If one of the products later moves to another company, the two companies that started the conversation can still read it. Only a company that still makes one of the two products can write in it. The new company does not see it.

### Write a message

At first the row shows only a summary: how many messages the conversation has and the date of the latest, or "No messages yet." Choose **Show the conversation** or **Write a message** to see the messages and the message box.

Type in the box and choose **Send**. A message is plain text, from 1 to 2,000 characters. The count under the box shows how many you have used. A link shows as text and cannot be clicked. A message cannot be edited once it is sent. To correct one, send another.

Each message shows its company and date, "(Company) · (date)". It keeps your company's name after you leave your seat. If its author deletes their account, it reads "Former member of (Company)".

Everyone at the other company gets a notice in **Messages**. No message is emailed on its own. See [Notifications and messages](/docs/vendors/notifications-and-messages).

### Delete your own message

Choose **Delete** under a message you wrote, then **Yes, delete it**. **Keep it** leaves the message as it was. Both companies then see "Message deleted" in its place. You cannot delete a colleague's message or the other company's.

AEC Integrations can still read a deleted message until the conversation itself is deleted. See "How long we keep a conversation" below.

### Ask AEC Integrations

Once a conversation has a message, **Ask AEC Integrations** asks us to look at it. We get an email. Both companies then read "AEC Integrations was asked to look at this conversation on (date)." You can ask once per conversation.

We read conversations but cannot write in them, so any answer from us comes outside the conversation. To report abuse in a conversation, email [support@aecintegrations.com](mailto:support@aecintegrations.com). The [Terms of Service](/legal/terms) say what a message may not contain.

### When a conversation closes

A conversation closes when:

- the integration is retired, by its owner or by AEC Integrations,
- the company that added the row withdraws it, by taking back its Yes or saying No,
- the row is removed from the directory,
- the integration moves to a connector product, which neither company builds.

A closed conversation is read-only. Its messages stay, and one sentence says why it closed. It never reopens, even if the integration is restored or the row gets a Yes again. Both companies get a notice when it closes.

### Conversations and each conversation's page

**Conversations** on your company's tabs lists every conversation your company is on, open and closed, newest activity first. Each one names the other company and the data, with the date of its last activity, **Open** or **Closed**, and its number of messages. It also says "AEC Integrations was asked to look" when someone asked. Filter with **All**, **Open** and **Closed**, and page with **Previous** and **Next**. Opening the list does not mark anything as read.

Each conversation has its own page, linked from the list and from both conversation notices. While the conversation is open and your company can still answer the row, you can write, delete and ask there too. Otherwise the page is read-only. A conversation whose row was removed has no row on the integration page any more, but it stays on the list and keeps its page. The list keeps every conversation after its notices leave **Recent notifications**, which holds 90 days.

### How long we keep a conversation

A conversation is deleted 2 years after its last message, whether it is open or closed. All its messages go with it. Deleting a message does not restart the 2 years. Retiring the integration or removing the row does not shorten them.

If you delete your account, your messages stay until the conversation is deleted, with your name removed. They read "Former member of (Company)". The [Privacy Policy](/legal/privacy) says how we handle messages.

## What readers see

The public integration page shows where each flow stands. It shows each company's answer, but never its note. Your company counts once, however many seats it holds. What readers see does not depend on either company's plan. An answer already on record shows the same way whether its company is on Free or Managed.

| Where it stands | What the page says |
| --- | --- |
| Nobody has confirmed it | Listed by AEC Integrations |
| One company confirms | Confirmed by (that company) |
| Both companies confirm | Confirmed by both companies |
| One confirms and the other says no | Companies disagree |
| Only "no" answers | A company says no |

A flow reads "Listed by AEC Integrations" until a company answers. The one exception is a flow a company added and then took back its Yes on. AEC Integrations never listed it, so it does not show at all. AEC Integrations' own record is never counted as a vote, so it cannot create a disagreement.

When the only answers are No, the flow reads "A company says no". That label does not name your company, and your reason is never public. The flow stays on the page, but it no longer counts toward the "types of data shared" heading.

If your company makes the products at both ends, it still has one position. That flow can show "Confirmed by" your company, but not "Confirmed by both companies".

The integration page updates shortly after you answer. Search results catch up on the next nightly update.

## What happens next

The page tells you, on the integration's own page, what your answer sets in motion. In short:

- **When you say Yes and the other company has not answered,** it is reminded after 14 days.
- **When you say No,** the other company and AEC Integrations are told. A No does not delete the flow. It stays on the page, shown as the table above describes, until we look at it.
- **When the two companies disagree for 7 days,** we email both and review the listing.
- **When your Yes is 12 months old,** we ask you to confirm it again. It does not expire, and the public page shows it as before.

## What "confirmed" means, and what it does not

"Confirmed by" and "Confirmed by both companies" mean the companies at the ends of the integration stand behind that data flow. It is a statement by the companies, not a test by AEC Integrations.

## Related

- Previous: [Notifications and messages](/docs/vendors/notifications-and-messages).
- Next: [Owning an integration](/docs/vendors/owning-an-integration).
- [Requesting changes and appeals](/docs/vendors/requesting-changes-and-appeals), for asking to change an integration's other details.
- [How we research and verify listings](/methodology).
