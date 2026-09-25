---
title: How we research and verify listings
last_updated: 24 September 2026
---

AEC Integrations is an independent directory of the software integrations that architecture, engineering, and construction teams depend on. This page sets out how the catalogue is built: what we list, where the data comes from, what verification does and does not mean here, and how to challenge anything on the site. It describes how the site works today, and the standards we hold ourselves to.

## What we list, and why

We catalogue software products used in AEC work, the vendors behind them, and the integrations between them. A product is listed when it is relevant to the industry and we can describe it from public sources. Inclusion is an editorial decision. It is never bought, and it does not imply any relationship with the vendor.

We classify every product four ways: what the software does, who uses it, which project phases it supports, and which specialty trades it serves. Each of the four draws on a fixed set of terms we maintain rather than free-form tags, so similar products can be compared consistently.

An integration appears only when both products at its ends are listed here. An entry naming a product we had never assessed would be a claim we could not stand behind. If an integration you rely on is missing, tell us.

## Where the data comes from

Our catalogue data is compiled from publicly available sources: vendor documentation, public API and developer references, public integration directories and marketplaces, and vendor websites. We curate that material into the classification above. That is how every listing starts. An integration can then pass to the vendor that offers it, as the section on ownership below explains.

Curation happens in a separate review application, not on the live site. A curator reviews a record there and publishes it deliberately. Nothing we research reaches the public catalogue on its own. Each publication is written in one step together with an audit record, so the catalogue is never left half-updated and the change is logged.

Integrations are recorded in a set shape rather than as prose. Each one names the two products, the mechanism that connects them, and the direction data moves. The mechanism is one of seven: native, API, webhook, marketplace app, iPaaS (a third-party connector platform such as Zapier or Workato), partner, or integrator.

Underneath sits the smallest unit we work in, a claim: one kind of data, moving one direction, through one integration. Recording integrations this way is what makes them comparable across vendors, and it is what lets a vendor confirm or dispute one specific detail instead of a whole page.

We do not warrant that a listing is complete, current, or free of error. Public sources change, and they are sometimes wrong themselves. The correction route below is the remedy, and we use it ourselves.

## What verification means

Verification tells you who has confirmed a specific claim. It does not rate the quality of an integration.

Every claim carries one of four states. "AECi" below is our own short name, and it is what the label shows on the page.

| What you see | What it means |
| --- | --- |
| Unverified · AECi | AEC Integrations recorded this from public sources. No vendor has confirmed it. |
| Confirmed by [vendor name] | One of the two vendors has confirmed this claim. The other has not responded. |
| Both vendors confirmed | Both vendors have independently confirmed this claim. |
| Vendors disagree | The two vendors describe this data flow differently. We show both accounts rather than pick one. |

Two rules govern that table.

**Our own entry never counts as a confirmation.** We record the claim, and our own record is excluded from the count. We can be the only voice on a claim. We can never produce a disagreement on our own.

**"Both vendors confirmed" means two different companies.** One company sometimes owns the products at both ends of an integration. The state is computed from distinct vendor identities, so a vendor cannot confirm both sides of its own integration and have it read as independent agreement.

**Where this stands today.** Confirming a claim needs an approved vendor account, and so does owning an integration. Vendor accounts opened in September 2026, so most claims and integrations are still recorded by AEC Integrations, and you will see "Unverified · AECi" nearly everywhere. We would rather label that plainly than imply an endorsement nobody has given.

Two other markers appear on listings and are easy to confuse with verification.

- **Who maintains a page.** Product, vendor, and integration pages carry either "Maintained by AEC Integrations" or "Vendor-maintained". "Vendor-maintained" means a vendor has acted on that record through its own account. On a product or vendor page, the company edited it, so the words on the page are theirs rather than ours. On an integration page, a vendor at one end has claimed it, edited it, confirmed one of its claims, or added its own links. The marker does not say which vendor owns the integration. The "Offered by" line does that. A date appears beside the marker only where a person actually touched the record, and the wording says which person: we write "Reviewed" when we re-checked it, and "Updated" when a vendor acted on it. Most records carry no date at all, because nobody has been back to them yet. We will not manufacture one from a bulk update, and a routine catalog sync on our side never stamps a date onto a record a vendor maintains.
- **The "Active on AECi" label.** It means a company has an active vendor plan and can manage its AECi profile. It does not verify product quality or integration accuracy, and it carries no weight in ranking. The label appears only while that account access is active, on the vendor's own page.

## Who owns an integration

An integration belongs to the vendor that offers it: the company a customer buys it from or gets it from. The integration page names that vendor on its "Offered by" line. Usually it is the vendor of one of the two products. Sometimes it is a third company that sells a connector between them.

We seeded the catalogue. Most integrations here were first recorded by us from public sources, and until an owner claims one, we keep it up to date from our own research. Owning an integration and confirming its claims are separate things. The owner keeps the integration's details. The vendors at both ends still confirm or dispute its claims, as described above.

**Claiming an integration.** The vendor named as the owner can claim the integration from its vendor account. There is no approval step, because the ownership is already on record. If no owner is on record, a vendor at one end can tell us it offers the integration, and we decide. Once an integration is claimed, the updates we publish from our research stop reaching it: not its details, not its owner, and not the claims recorded under it. The owner edits its details from then on, and each edit goes live without review by us. The vendor at the other end is told when an integration on its product is added, claimed, edited, retired, or restored.

**Each side's own links.** The vendor at each end can add its own listing and documentation links to an integration, whoever owns it. The page shows them beside the other side's. They are that vendor's links, and adding them gives it no say over the integration.

**Contests.** A vendor at either end of an integration that does not own it can contest one detail. It names the detail, the value it believes is right, and its reason. Who decides depends on the integration:

- If the owner has claimed it, the owner decides.
- If it has not been claimed, we decide.
- A contest about who owns the integration always comes to us, even after a claim, because an owner cannot fairly rule on its own ownership.

A contest stays with whoever was deciding when it was sent. A contest is a request, not a change. While one is open, the page keeps showing the value on record and does not say a contest exists. An accepted contest changes the page. When we accept one on an integration nobody has claimed, the change usually arrives with our next catalogue update. A declined contest changes nothing, and the vendor that sent it is told.

**Asking us to review an owner's decision.** When the owner declines a contest, the vendor that sent it has 30 days to ask us to review it. It can also ask once the owner has left the contest unanswered for 30 days, and then it has 30 days more. The owner can reply once, within 14 days. We read both sides and say which one we agree with. Our answer is advice. We do not change the integration, because the owner keeps its details, and the value on record stays unless the owner changes it. When we agree with the owner, that vendor cannot contest the same detail again for 90 days, unless its value changes. Nothing about a review is public.

**Retiring is not deleting.** An owner that stops offering an integration can retire it. A retired integration is taken off the public site, out of search, and out of the counts on product pages. Nothing is deleted. The owner can restore it later, and it comes back as it was, with its claims and confirmations. Open contests on it close when it is retired, and restoring it does not reopen them. AEC Integrations can also retire an integration a vendor holds, to take a false or abusive listing off the public site. That retire is recorded in our audit log with a reason, and only we can restore it. Deleting is different: we delete an integration only when its record was wrong or a product at one end is gone, and today our catalogue tools refuse to delete an integration a vendor holds.

**Integrations a vendor adds.** A vendor can also add an integration it offers for one of its own products. It belongs to that vendor and is claimed from the moment it is added, and it goes live without review by us. We did not research it, and its page says "Added by the vendor" beside the "Offered by" line. If we already list an integration that looks the same, the vendor is told, but it is not stopped. Our catalogue updates will not add a second copy of an integration a vendor holds.

**Integrations delivered through a connector.** Where a third-party connector product carries the data, no vendor can yet claim, edit, retire, add, or put its own links on the integration. Those stay as we recorded them. If a vendor added its own links before we recorded the integration as connector-delivered, those links are no longer shown. A vendor that thinks one is wrong can tell us through the correction route below.

## No pay-for-placement

Position is never for sale. Not the order of search results, not the order of any listing, not a slot on the home page. There is no sponsored placement, no promoted tier, and no arrangement under which a payment moves a product up.

A vendor plan affects four things, and this is the complete list:

- what a vendor may edit about its own company and products,
- whether a vendor can confirm or dispute integration details,
- whether the "Active on AECi" label appears on its vendor page,
- how far back the version history on an integration page goes.

The last of those is the only place a payment changes what a reader sees, so it is worth being exact about the limits. The current state of an integration is always shown in full, to everyone, including whether the two vendors agree or disagree. Only the comparison between older versions is affected, and it opens when either vendor at the ends of that integration holds a plan. Readers are never asked to pay, to sign in, or to be identified.

A vendor plan never affects position in search or in any listing, whether a review is published or removed, or whether a listing exists at all.

We hold ourselves to this with a test rather than a promise. The set of things a vendor plan can unlock is checked automatically against the set of signals that order search results, and the build fails if any item appears in both.

## Reviews

We do not review products ourselves.

Reviewers are asked to write about software they have used, and to score it on two separate measures: how well the product works, and what onboarding was like. Those answer different questions, and averaging them into one number hides the part that varies most between products.

Every review is moderated before publication against our [Review Guidelines](/legal/review-guidelines). A published review is the opinion of the person who wrote it. It is not a statement of fact by us, and it is not our endorsement. We show no rating at all until a product has at least five approved reviews, because an average drawn from one or two is noise presented as signal.

## Corrections and disputes

Anyone, vendors included, can challenge anything on this site. There is no charge for a correction, and there never will be.

Every product and vendor listing carries two routes: a way to suggest a correction, and a way to claim the listing or request access to one a colleague already manages. Neither requires an account.

When you send a correction, tell us what is wrong and what it should say, with a public source where you have one. We check it against public sources and update the listing where the evidence supports it. We may decline or hold a request we cannot verify.

An integration its owner has claimed is kept by that owner, and our catalogue updates no longer reach it. A vendor at either end can contest it, as described above. Anyone else can send us the correction. We will share it with the owner, who decides whether to change it.

We correct factual errors, and we remove listings for companies and products that no longer exist. We will not remove an accurate listing because a vendor would prefer not to be listed. That independence is the point of the directory.

The [Listing Accuracy Policy](/legal/listing-accuracy) and the [Review Guidelines](/legal/review-guidelines) set out the detail. Both are pre-launch drafts pending legal review, and each says so at the top. This page describes the practice they will formalise.

## Who is responsible

AEC Integrations is built and maintained by The WBS Project, which operates the site and is accountable for what is on it.

Corrections, questions, and disputes reach us at [founders@thewbsproject.com](mailto:founders@thewbsproject.com), or through the [contact page](/contact). Reports about a specific review go to [reviews@thewbsproject.com](mailto:reviews@thewbsproject.com).
