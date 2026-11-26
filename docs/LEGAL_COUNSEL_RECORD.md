# Counsel questions and answers: the November 2026 legal review

Every written question put to counsel through Rocket Lawyer Ask an Attorney, the answer as received, and what we did with it. Answers are general guidance, not representation, and are reproduced verbatim. Chris's rulings are at the end. The exact legal-text changes that followed are the numbered items on AECI-1363 (comments dated 2026-11-05 to 2026-11-11); the build issues are named per question.

Governing docs: `docs/LEGAL_IMPACT_REVIEW.md` for the verdict rule, `apps/web/src/content/legal/README.md` for versions and the gate list, `docs/STAGE_1_SPEC.md` §27 for legal pages.

## Index

| Q | Document | Topic | Attorney | Answered |
|---|---|---|---|---|
| Q1 | Managed plan agreement | Liability cap in the Managed plan agreement | Josh Begg | 2026-11-04 |
| Q2 | Managed plan agreement | 14-day refund and consumer-law carve-outs | Josh Begg | 2026-11-05 |
| Q3 | Managed plan agreement | Changes bind at the next renewal or purchase | Josh Begg | 2026-11-05 |
| Q4 | Vendor Terms | Keeping a vendor's text live after the paid plan ends | Josh Begg | 2026-11-05 |
| Q5 | Managed plan agreement | Licenses granted without a checkout: how the holder accepts | Josh Begg | 2026-11-04 |
| Q6 | Managed plan agreement | Exceptions to the liability cap | Josh Begg | 2026-11-04 |
| Q7 | Managed plan agreement | Florida automatic renewal law (Fla. Stat. 501.165) | Josh Begg | 2026-11-04 |
| Q8 | Vendor Terms | Asking customers for reviews, under the FTC Consumer Reviews rule | Josh Begg | 2026-11-04 |
| Q9 | Vendor Terms | Private messages between two vendors: is a carve-out enough? | Josh Begg | 2026-11-04 |
| Q10 | Vendor Terms | Keeping message bodies after the author deletes their account | Josh Begg | 2026-11-04 |
| Q11 | Vendor Terms | Two acceptance checkbox wordings | Josh Begg | 2026-11-04 |
| Q12 | Vendor Terms | Names and logos after a vendor gives up its claim | Josh Begg | 2026-11-04 |
| Q13 | Managed plan agreement | Ban for abuse: ending licences at once with no refund | Josh Begg | 2026-11-04 |
| Q14 | Managed plan agreement | Policies incorporated by hyperlink | Josh Begg | 2026-11-04 |
| Q15 | Managed plan agreement | Conspicuous formatting for the liability cap and disclaimers | Josh Begg | 2026-11-04 |
| Q16 | Vendor Terms | Venue: Martin County state courts and the Southern District of Florida | Josh Begg | 2026-11-04 |
| Q17 | Terms of Service | Section 230 and how far we may moderate, curate and decide | Josh Begg | 2026-11-04 |
| Q18 | Review Guidelines | Review Guidelines against the Consumer Review Fairness Act and the FTC reviews rule | Josh Begg | 2026-11-04 |
| Q19 | Terms of Service | Vendor-maintained listings: is the responsibility sentence enough? | Josh Begg | 2026-11-04 |
| Q20 | Listing Accuracy Policy | Removal requests: which ones oblige us to act | Josh Begg | 2026-11-04 |
| Q21 | Listing Accuracy Policy | Injurious falsehood once we are on written notice | Josh Begg | 2026-11-04 |
| Q22 | Terms of Service | Intellectual property claim over the directory | Josh Begg | 2026-11-04 |
| Q23 | Terms of Service | Records behind "never influenced by payment" | Josh Begg | 2026-11-04 |
| Q24 | Terms of Service | Are unclaimed vendors bound by anything? | Josh Begg | 2026-11-04 |
| Q25 | Terms of Service | A subpoena for a reviewer's identity | Josh Begg | 2026-11-04 |
| Q26 | Privacy Policy | US-primary posture, and stripping the GDPR-style rights | Josh Begg | 2026-11-06 |
| Q27 | Privacy Policy | Records we keep after a user deletes their account | Josh Begg | 2026-11-06 |
| Q28 | Privacy Policy | Do Not Track, Global Privacy Control, and what runs anyway | Josh Begg | 2026-11-06 |
| Q29 | Privacy Policy | Bot checks before consent, for visitors in the EU | Alexander Coffin | 2026-11-06 |
| Q30 | Privacy Policy | One marketing email to an account holder who works for an unclaimed vendor | Alexander Coffin | 2026-11-06 |
| Q31 | Privacy Policy | Age threshold and children | Alexander Coffin | 2026-11-06 |
| Q32 | Privacy Policy | The processors we name, and the agreements we need with them | Alexander Coffin | 2026-11-06 |
| Q33 | Terms of Service | The Terms of Service have no liability cap | Josh Begg | 2026-11-07 |
| Q34 | Terms of Service | Changing the Terms by continued use, with no notice to account holders | Alexander Coffin | 2026-11-06 |
| Q35 | Terms of Service | Confirming no arbitration and no class-action waiver | Alexander Coffin | 2026-11-06 |
| Q36 | Privacy Policy | Private messages between two companies: the privacy disclosures | Alexander Coffin | 2026-11-06 |
| Q37 | Privacy Policy | A first-party browser report that a page view was a person, under ePrivacy Article 5(3) | Alexander Coffin | 2026-11-11 |
| Q38 | Terms of Service | The DMCA copyright-complaints section | Brian D. Lerner | 2026-11-10 |
| Q39 | Managed plan agreement | Five clauses assembled from your colleagues' answers, as they now read | Travis Russell | 2026-11-11 |
| Q40 | Terms of Service | Website accessibility exposure | Alexander Coffin | 2026-11-11 |
| Q41 | Privacy Policy | Breach notification obligations, and the one 1.1 acceptor | Alexander Coffin | 2026-11-11 |
| Q42 | Vendor Terms | Moving vendors who accepted a draft version onto the final Vendor Terms | Alexander Coffin | 2026-11-11 |
| Q43 | Privacy Policy | Is one privacy sentence enough for a yes-or-no browser report, under US state privacy law | Alexander Coffin | 2026-11-11 |
| Q44 | Terms of Service | Is a paid, richer vendor profile advertising that needs a label | Alexander Coffin | 2026-11-16 |
| Q45 | Vendor Terms | A paying vendor posts a customer testimonial on our site: what we must do under 16 CFR Parts 465 and 255 | Alexander Coffin | 2026-11-16 |
| Q46 | Terms of Service | Section 230 when the vendor pays and our staff approve the content first | Alexander Coffin | 2026-11-16 |
| Q47 | Privacy Policy | Privacy notice owed to a person named in a vendor's customer quote | Alexander Coffin | 2026-11-16 |
| Q48 | Vendor Terms | Right of publicity when a vendor's testimonial names a person | Alexander Coffin | 2026-11-16 |
| Q49 | Vendor Terms | A vendor lists its customers by name on our site: false endorsement exposure | Alexander Coffin | 2026-11-17 |
| Q50 | Vendor Terms | Do our vendor warranty and indemnity cover third-party material in screenshots and quotes | Travis Russell | 2026-11-15 |
| Q51 | Privacy Policy | A click-to-play YouTube or Vimeo video for visitors in the EEA, the UK and Switzerland | Alexander Coffin | 2026-11-16 |
| Q52 | Privacy Policy | An embedded third-party video player: Video Privacy Protection Act and Florida wiretap exposure | Alexander Coffin | 2026-11-16 |
| Q53 | Terms of Service | Sending vendor content to a language-model provider for screening: do our licence and Privacy Policy cover it | Travis Russell | 2026-11-15 |
| Q54 | Terms of Service | Does a stored automated risk score give us knowledge under the DMCA or weaken Section 230 | Alexander Coffin | 2026-11-16 |
| Q55 | Privacy Policy | One notice at first save for a private "software my firm uses" list, and its three uses | Alexander Coffin | 2026-11-16 |
| Q56 | Privacy Policy | Emails based on a reader's saved software list: consent in the US, EU, UK and Canada | Alexander Coffin | 2026-11-16 |
| Q57 | Privacy Policy | Paid vendor plans that include usage totals: is that a "sale" or "sharing" of personal information | Alexander Coffin | 2026-11-16 |
| Q58 | Terms of Service | A public "used by N accounts" count on a product page | Alexander Coffin | 2026-11-16 |
| Q59 | Terms of Service | An employee records their employer's software and office names on our site without authority | Alexander Coffin | 2026-11-16 |
| Q60 | Privacy Policy | Adding new sections to a legal page before its first effective date: is the 30-day notice owed | Travis Russell | 2026-11-15 |
| Q61 | Terms of Service | A product's name in plain text in a sticky bar on an unclaimed listing, without the not-affiliated note beside it | Brian D. Lerner | 2026-11-17 |
| Q62 | Vendor Terms | "No plan changes where you rank or appear" when a paid plan lets a vendor set the tags that order our category menus | Alexander Coffin | 2026-11-19 |
| Q63 | Terms of Service | Is a visible line beside the sign-in buttons enough acceptance for a change that reduces a reader's rights | Alexander Morton | 2026-11-19 |
| Q64 | Privacy Policy | How long we may keep a copyright notice and counter-notice, and the privacy wording for it | Alexander Coffin | 2026-11-19 |
| Q65 | Privacy Policy | Forwarding a counter-notice when our privacy policy says we identify users only under legal process | Alexander Coffin | 2026-11-19 |
| Q66 | Privacy Policy | Disclosing a legal hold, and the audit records we keep longer than the stated four years | Alexander Coffin | 2026-11-19 |
| Q67 | Privacy Policy | How long to keep an acceptance record when no vendor account ever existed or the company's record is gone | Alexander Coffin | 2026-11-19 |
| Q68 | Vendor Terms | Does changing a policy that our Vendor Terms incorporate count as changing the Vendor Terms | Travis Russell | 2026-11-19 |
| Q69 | Vendor Terms | Giving the first in-force Vendor Terms a new version number | Travis Russell | 2026-11-19 |
| Q70 | Terms of Service | Three sentences changed since your colleagues' reviews: a wording check | Alexander Coffin | 2026-11-19 |
| Q71 | Vendor Terms | Replacement wording for "No plan changes where you rank or appear" | Travis Russell | 2026-11-24 |
| Q72 | Privacy Policy | Email consent in Canada and the United Kingdom for one unticked opt-in box | Alexander Coffin | 2026-11-24 |
| Q73 | Listing Accuracy Policy | A vendor removing a third company's integration listing from its product, with no review by us | Kyle Usrey | 2026-11-26 |
| Q74 | Listing Accuracy Policy | What step, if any, to add before a vendor's removal of a third company's integration listing takes effect | Alexander Coffin | 2026-11-26 |

## Questions and answers

### Q1. Liability cap in the Managed plan agreement

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc., a Delaware corporation based in Stuart, Florida. We run AEC Integrations, a US directory and review website for construction-industry software. Software vendors (businesses, not consumers) can buy a "Managed" plan for a product at $250 a year or $25 a month. Our draft agreement is governed by Florida law with venue in Martin County and the Southern District of Florida.

The draft says:

"Our total liability under this agreement is limited to the fees you paid us for licenses in the twelve months before the claim arose. We are not liable for lost profits, lost business, or any indirect or consequential loss, even if we were told it was possible. The limit does not apply to your obligation to pay fees, to your indemnity under the Vendor Terms, or to any liability that cannot be limited under applicable law."

A separate document (Vendor Terms, for the free listing claim) caps our liability at one hundred US dollars.

Our view: a trailing-twelve-months cap is standard for a B2B subscription and is enforceable in Florida. Note that a monthly buyer in month one has paid $25, so the cap can be $25.

Questions: (a) Is this cap enforceable under Florida law for a business buyer? (b) Is a cap that can be as low as $25 a problem, and if so what floor would you set, for example "the greater of fees paid in the trailing twelve months or $100"? (c) Any wording change you would make?

**Answer (Josh Begg, 2026-11-04):**

(a) Under Florida law, a limitation clause is enforceable where the parties have equal bargaining power and the clause is clear and unambiguous, and it is strictly construed against the party it protects - here, you. Pier 1 Cruise Experts v. Revelex Corp. (11th Cir. 2019). Your buyers are businesses, the wording is plain, and this fee cap plus consequential damages waiver is a standard B2B risk allocation, so it should hold for ordinary contract claims.
(b) A small cap is not automatically invalid, but a month-one buyer whose listing you wrongfully pull would argue a $25 remedy is illusory and unconscionable. Pier 1 reserved the point that total immunity can make a contract illusory. Do not litigate that argument over $75: adopt your own proposal, "the greater of the fees paid in the twelve months before the claim arose or $100," matching your Vendor Terms.
(c) First, fix the base: you sell a subscription plan, not "licenses," so say "fees paid to us under this agreement." Second, your carve-outs run only in your favor (the buyer's fee and indemnity duties); add carve-outs for your own intellectual property infringement, breach of confidentiality, and gross negligence or willful misconduct. The cap cannot shield intentional misconduct under Florida law anyway, and named carve-outs keep a court from refusing the clause as overbroad; your catch-all is only a backstop. Third, state expressly that the consequential damages waiver covers only your liability, if that is the intent; silence invites a fight over scope. Show the clause conspicuously at purchase and keep acceptance records.
You should seek counsel in Florida to get this finalized.

**Follow-up asked:** Proposed replacement cap clause for check; is 'fees under this agreement' the right base when a vendor holds several subscriptions?

**Follow-up answer (Josh Begg, 2026-11-07):**

Yes, with two wording fixes. 1. The clause adopts the greater of fees paid in the twelve months before the claim or $100, uses agreement fees rather than per license, and lists the carve-outs. But This limit covers our liability only is not the right way to make the consequential loss waiver one-directional. A vendor will read limit as the dollar cap alone, and argue the next sentence, We are not liable to you for lost profits, is a free-standing bar that also blocks the carve-out claims, whose damages are often lost profits, and that nothing preserves a claim by you for the same loss under the vendor indemnity. Say instead: Neither the cap nor the exclusion of lost profits or indirect or consequential loss in this section applies to the claims listed below, and that exclusion applies only to claims against us. Then list, keeping your duties separate from your own conduct: your obligation to pay fees, your indemnity under the Vendor Terms, our infringement of your intellectual property, our breach of confidentiality, our gross negligence or willful misconduct, or liability that cannot be limited under applicable law. 2. Change the base for a one-product claim. Fees you paid to us under this agreement can be read as all fees under a master agreement, inflating the cap for a claim about one $250 product, or only the fees for the subscription sued on. Use: the fees you paid for the Managed subscription for the product to which the claim relates in the twelve months before the claim arose, or $100, whichever is greater. Add a fallback for a claim not tied to one product, such as a site-wide failure, using all fees paid under this agreement in that period. That keeps the cap proportionate to the product at risk and stops a vendor aggregating unrelated subscriptions to lift it.

**What we did:** Adopted: cap is the greater of per-product trailing-12-month fees or $100 (site-wide fallback), carve-outs named, 'neither the cap nor the exclusion' structure. Agreement, Vendor Terms and Terms. Legal branches 1 and 3.

### Q2. 14-day refund and consumer-law carve-outs

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). We sell a $250-a-year or $25-a-month subscription to software vendors, which are businesses. Payment is by card through Stripe. Florida law governs.

The draft says:

"We give a full refund if you ask within 14 days of the first charge. There is no refund after that. A renewal charge is not refundable, because we send notice 30 days before it. A charge we made in error is always reversed, whenever it is found. That covers a double charge, a wrong amount, and a charge after a cancellation took effect. This is a correction, not a refund, so the 14-day limit does not apply."

Our disputes clause ends with "except where applicable consumer law provides otherwise."

Our view: the buyer is a company, so consumer refund rules do not apply, and the "charge made in error" sentence covers the fairness cases.

Questions: (a) Does this refund policy need any consumer-law carve-out, given that a sole proprietor could buy with a personal card? (b) Is "no refund on a renewal charge" defensible when we give 30 days' written notice before it? (c) Is the "except where applicable consumer law provides otherwise" sentence enough, or should the refund section say it too?

**Answer (Josh Begg, 2026-11-05):**

(a) Yes, add a carve-out in the refund section. Your premise is unsafe in Florida: under Fla. Stat. 501.203(7), consumer in FDUTPA includes a business, firm, corporation and any commercial entity, so a business buyer can still claim deception from an absolute no-refund term. A sole proprietor is an individual, but most tests look to the purpose of the purchase, not the personal card. The card matters separately: a personal credit card carries federal billing-error and dispute rights, and Stripe and network rules apply even if you call a reversal a correction, not a refund. That label works for true errors, it does not waive those rights.
(b) No refund on renewal is defensible only on strict conditions: renewal, price and the no-refund term disclosed clearly before the first charge and consented to; the 30-day notice states the renewal date, cancellation deadline and how to cancel; cancellation is as easy as sign-up and timely cancellations are honored; and the bar never covers erroneous or unauthorized charges. Fla. Stat. 501.165, for covered individual service contracts of 12 months or more, requires notice 30 to 60 days before the cancellation deadline and makes a noncompliant renewal term void, though it excludes an individual acting for a business. Meet that and the federal ROSCA online standard anyway. An absolute bar after an annual renewal, with no grace period or pro rata refund for unused time, is your weak point.
(c) No. A disputes-clause carve-out is not enough; a reader should not have to import it, and ambiguity is read against the drafter. Repeat in the refund section: except where applicable law provides otherwise, and nothing here limits reversal of an erroneous or unauthorized charge.

**What we did:** Refund section repeats the savings clause and the erroneous-charge line; 14-day refund now covers renewal charges (ruling 7). Branch 2.

### Q3. Changes bind at the next renewal or purchase

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida) selling an annual or monthly B2B subscription. Florida law governs.

The draft says:

"We may change this agreement. A new version binds you at your next renewal or your next purchase, whichever comes first. We announce it in the renewal notice sent 30 days before your renewal date. Nothing is re-signed mid-term. Monthly billing has no renewal notice. For monthly licenses, we email every seat and your billing email at least 30 days before a new version binds. If you do not agree, cancel before that date."

The renewal notice is an email sent 30 days before renewal that states the date, the price, the number of licenses, any change to the agreement that will bind at renewal, and how to opt out. The customer can cancel the renewal from the Stripe customer portal or by email.

Our view: 30 days' emailed notice with an opt-out, and no mid-term change, is sufficient notice for a business customer.

Questions: (a) Is this notice mechanism sufficient under Florida law? (b) Should the email contain the full new text or is a link to the numbered version on our site enough? (c) Any risk in binding a monthly customer by "cancel if you do not agree"?

**Answer (Josh Begg, 2026-11-05):**

(a) In Florida, generally yes for a B2B renewal. No general Florida statute fixes 30 days for business terms changes; Fla. Stat. 501.165 is for covered individual service contracts. Your strength is contract: the original agreement reserves this mechanism, nothing changes mid-term, and a new version binds only on renewal or a new purchase, which supplies fresh assent and consideration. That works only if notice reaches the account holder, says clearly that terms are changing, and gives a real chance to cancel before the charge.
(b) A link can be enough; the email need not contain the full text. But identify the version by number and effective date, summarize every material change in the email, link directly to that fixed version, and let the customer download, save and print it. Do not link to a living page you can edit later; archive each version. Under Fla. Stat. 668.50, a retained electronic record must accurately reflect the record and remain accessible for later reference, and a record a recipient cannot store or print is risky to enforce. For material changes, attach a PDF or redline.
(c) Yes, monthly is higher risk. Cancel if you do not agree treats silence as assent, and a seat user who receives the email may not be the contracting party or have authority to bind or cancel the company. Send it to the account owner, admin and billing contact, not every seat alone. Fix an internal conflict too: the clause binds at the next purchase, whichever comes first, but the monthly promise is at least 30 days before a new version binds, so a purchase inside 30 days should not bind the customer. For material monthly changes, get an affirmative click or written acceptance, and if they cancel, do not charge again or cut off the month already paid for.

**What we did:** Change-notice emails carry version, summary, archived link and PDF; monthly purchase inside the window stays on the old version; material monthly changes need a click. Text branch 2; build AECI-1620. *Applied 2026-11-18 (legal branch 6, AECI-1690):* the agreement no longer says unaccepted monthly subscriptions end. Until an owner seat accepts, they keep renewing on their version, and the new version binds at the first charge after an acceptance. A subscription added to an existing plan takes that plan's version, or the latest of its versions.

### Q4. Keeping a vendor's text live after the paid plan ends

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). We run a public directory of software products. A vendor on our paid plan can edit certain fields on its own product page. When the plan ends the vendor loses the right to edit, but the text it wrote stays published. Florida law governs.

Our Vendor Terms say:

"You keep ownership of what you submit through the portal. Our Terms of Service grant us a license to host, moderate, reproduce, adapt and display content you submit. That license covers your portal content too. It lasts for as long as we operate the service, including after your seats end, because the listing stays public."

and:

"When Managed ends on that product, you lose the right to edit those fields. The text you wrote stays live, exactly as you left it. The fields stay yours: we do not update them from our own research, and our catalog updates stop reaching them. A new license for that product gives you the edit right back. Nothing reverts and nothing is deleted."

Our view: the licence is wide enough to keep the text live indefinitely, and the vendor's only remedy for a change is to buy a new licence or ask us to correct a factual error under our Listing Accuracy Policy.

Questions: (a) Is the licence wide enough to keep publishing text the vendor can no longer edit? (b) Does the vendor have any right to demand removal of its own text after the plan ends, and should we offer one? (c) Any exposure if that text becomes outdated and we have said we will not update it?

**Answer (Josh Begg, 2026-11-05):**

(a) Mostly yes, on copyright. Host, reproduce, adapt and display, lasting as long as you operate the service and expressly including after seats end, is a post-plan display license. The vendor kept ownership, but ownership and a license can coexist. Losing edit access is a plan feature, not a limit on the license. Weak spots: the license does not say irrevocable or royalty-free, does not expressly cover trademarks and logos, and adapt and moderate sits badly with exactly as you left it. Say irrevocable, and clarify that formatting, moderation and safety edits are allowed.
(b) The vendor has no general right to demand removal while a use stays inside a license that by its terms continues, and a copyright takedown does not erase a license the owner granted. But yes, offer a removal right anyway: after the plan ends, let the vendor elect removal of vendor-authored fields, not your catalog data or reviews, within a set number of days. That costs little and avoids revocation and trademark fights.
(c) Yes, exposure grows as the text ages. Pricing and feature text presented as current can support a Florida FDUTPA and FTC Act deception claim if you know, or are told, it is materially wrong and still publish it unchanged under a we will not update promise; that promise does not override duties to readers, and a stale listing can also imply the vendor still participates in it. Section 230, 47 U.S.C. 230(c)(1), generally shields you as publisher of vendor-supplied content, but 230(e)(2) leaves intellectual property law untouched and it does not shield your own labels. Date-stamp the fields as vendor supplied, last updated on a stated date, with Managed ended, do not present them as verified or current, and on notice of a material error, correct, blank or remove the field promptly under your Listing Accuracy Policy.

**What we did:** Content licence made irrevocable and narrowed to named operations; 30-day removal election after a plan ends (ruling 8); 'Maintained by until' caption. Text branch 1; builds AECI-1614, AECI-1618.

### Q5. Licenses granted without a checkout: how the holder accepts

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). Most customers buy our subscription through a Stripe checkout page with a required checkbox: "I have read and accept the Managed plan agreement." We record who ticked it, when, and the version. Some licenses are instead granted by us directly: a complimentary licence, or a licence paid under a separate invoice or written deal. Those never pass through checkout, so no box is ticked and no acceptance record exists. These grants have a fixed end date and never renew. Florida law governs.

The draft says:

"A license we grant without a checkout is also covered by this agreement. By using it you accept the version in force on the day of the grant."

and, on changes:

"A new version binds you at your next renewal or your next purchase, whichever comes first."

Our view: acceptance by use is weak for a contract with a liability cap and refund terms, and the "changes" sentence leaves a grant holder on the version in force on the grant date for the whole grant.

Questions: (a) Is acceptance by use enforceable here, or should we require an emailed or in-portal acceptance before the grant activates? (b) Which version of the agreement should bind a grant holder when we publish a new version mid-grant? (c) If you recommend an in-portal acceptance step, what minimum record should we keep?

**Answer (Josh Begg, 2026-11-04):**

(a) Your own view is right: do not rely on acceptance by use here. It can work in Florida if the offer clearly said use means acceptance and the holder had actual notice of that, and the full text, before first use, with a chance to decline. Here that is circular, because the use sentence sits inside the agreement the holder may never have seen, and you have no record of notice. That invites a fight, worst for the liability cap and refund terms, which need conspicuous assent. Require affirmative acceptance before the grant activates: an in-portal click is best, or a reply email from an authorized person saying I accept, naming the version. No acceptance, no activation.
(b) The version in force on the grant date governs for the whole fixed grant. Your changes clause by its own words triggers only at the next renewal or the next purchase, and a granted license has neither mid-grant. Publishing a new version changes nothing for that holder. It binds that holder only on a later purchase or renewal, or if the holder separately accepts it for that grant in a click or writing. State that expressly. Also say what controls if the separate invoice or written deal that created the grant conflicts with the standard agreement; a signed deal will usually be read to control.
(c) Keep the same record you keep at checkout, tied to the grant: acceptor name, email, company, account ID and role or authority; product, grant ID and end date; exact version number and date and an archived PDF or hash of the text presented; the wording shown and that the box started unticked; timestamp, method, portal or email, and IP address if collected; and a log showing access was not enabled before acceptance. Store it in an exportable, tamper-evident log and keep it for the life of the grant plus at least five years after it ends.

**Follow-up asked:** Is a signed deal naming the agreement version sufficient acceptance for a grant, or is the portal click still needed?

**Follow-up answer (Josh Begg, 2026-11-05):**

A signed deal that names the agreement version can be sufficient acceptance on its own, and the click is not legally needed for that grant, if four points are true. First, the deal is signed by a person with authority for the company receiving the grant, with name, role, and company stated. Second, the deal expressly incorporates the agreement by version number and date, and states that signing accepts that version, rather than merely referring to terms on your website. Third, the version named is archived exactly as presented at signing, so you can prove what was accepted. Fourth, the grant does not activate before the deal is signed. If any of those points is missing, for example the deal names no version, the signer is not shown to be authorized, or the grant was already active before signing, keep the in-portal click as well. Even where the signed deal is sufficient, a click is still useful as a practical activation control in the portal and as a second timestamped record, but it is not a separate legal requirement if the signed deal already proves assent to the named version. Keep the signed deal and the version archive in the same tamper-evident log as a click record, for the life of the grant plus at least five years after it ends, and require a new acceptance if a different version is substituted before activation.

**What we did:** Grants activate only on an in-portal click or a qualifying signed deal; grant-date version governs. Text branch 2; build AECI-1615.

*Built 2026-11-10 (AECI-1615).* A grant now writes a pending `license_grants` row and no subscription. It activates in one of two ways. An owner seat ticks an unticked box on the Billing tab, or AECi records a signed deal with the four points above. The acceptance row, the subscriptions and the audit rows go in one batch, so nothing is live before acceptance. The record keeps the acceptor's name, title, email, company legal name and seat role, the grant id and end date, the pinned version and a SHA-256 of its text, the method and time, and the IP address and browser for a portal click. For a portal click it also keeps a SHA-256 of the exact box label shown and that the box started unticked. A signed deal leaves both empty, because it has no box. Chris's rulings of 2026-11-10:

- R1. Ban-term grants wait for the click too.
- R2. The record names no product. A grant lands in the pool, and later assignments stay in the audit log. This departs from (c), which lists the product.
- R3. Grants already live in production stay live with no acceptance.
- R4. One reminder goes out 7 days after the grant.
- R5. A qualifying signed deal activates the grant at once, with no click.
- R6. A ban-term product licensed before the accept gets its subscription unassigned in the pool, with a warning.
- Ruling 16. Every acceptance row stores which checkbox was shown: the label's hash and whether it started unticked. Claim, checkout and portal grant rows write both. A signed deal writes neither, and so does a claim confirmed under an older vendor terms version. *Built 2026-11-11 (AECI-1619):* after the 2026-11-11 ruling 16 below, each row also stores the label text itself, beside its hash.

No prune deleted an acceptance or a grant row when this was written. *Since 2026-11-17 (AECI-1638, ADR 0058)* the legal retention prune deletes them six years after the vendor account ends, never before the five-year grant floor, and never while a litigation hold covers the vendor. A grant acceptance is kept at least five years from the day the grant's last subscription ends. A subscription ends at its lapse, revoke, release or Terminate, whichever comes first, so the scheduled end date alone does not set the floor. A grant never accepted is kept five years from its withdraw or expiry. The store is append-only in D1. Since 2026-11-17 it is also tamper-evident: each night the SHA-256 fingerprints of the acceptance and grant rows go to a hash-chained file in locked R2 with a DigiCert RFC 3161 timestamp (ruling 15, AECI-1680). The Privacy Policy draft now says a grant acceptance records the IP address and browser.

### Q6. Exceptions to the liability cap

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida) selling a B2B subscription to software vendors. Florida law governs.

Our draft liability cap reads:

"Our total liability under this agreement is limited to the fees you paid us for licenses in the twelve months before the claim arose. ... The limit does not apply to your obligation to pay fees, to your indemnity under the Vendor Terms, or to any liability that cannot be limited under applicable law."

The cap is one-directional: it limits our liability to the vendor. The vendor's obligations that are carved out are fees and its indemnity to us.

Our view: the carve-out list is short on purpose because we never hold vendor confidential data and never take payment data (Stripe does).

Questions: (a) Is this carve-out list the right one for a Florida B2B contract, or should it also name fraud, wilful misconduct, gross negligence, or infringement of the other party's intellectual property? (b) Is "any liability that cannot be limited under applicable law" sufficient to save the clause if a court finds one carve-out missing? (c) Should the cap be made mutual?

**Answer (Josh Begg, 2026-11-04):**

(a) Neither extreme is best at this price. An uncapped indemnity from a vendor paying $250 a year, for any loss from any statement that was not true, is out of proportion and will be the first term a real vendor negotiates. Folding it into the base cap guts it, because the cap can be $250. Do what is normal: keep fees owed outside the cap, give the indemnity its own higher super-cap for ordinary covered claims, and leave only the vendor-controlled risks in (c) uncapped. Florida courts construe indemnities strictly, so also state that this indemnity does not cover loss caused by your own content or negligence.
(b) Leave the indemnity as is; do not make it mutual. Fla. Stat. 57.105(7) applies when a contract allows attorney fees to a party required to take action to enforce the contract: the court may then allow reasonable fees to the other party when that party prevails in an action on the contract. That is enforcement fees between you and the vendor. The legal fees in this indemnity are part of an indemnified loss, mostly for defending third-party claims arising from vendor content, not a prevailing-party award, so the statute does not turn a one-way indemnity into a mutual indemnity for your content. But assume any separate one-way enforcement fee right will be read as reciprocal in litigation, whatever the draft says.
(c) Yes. Name on the vendor side: fraud and intentional misrepresentation, willful misconduct and gross negligence, infringement of intellectual property or other rights by content the vendor submits, breach of confidentiality, and violation of law in using the portal. Mirror your own carve-outs where the risk is symmetrical. Name fraud: a cap will be tested hardest when the party invoking it committed the fraud, and silence invites an argument that the parties meant the limit to cover it.

**Follow-up asked:** Is the greater of $10,000 or ten times trailing-twelve-month fees proportionate as the indemnity super-cap at a $250-a-year price?

**Follow-up answer (Josh Begg, 2026-11-05):**

At a 250 dollar a year price, the greater of 10,000 dollars or ten times trailing twelve months fees is proportionate as a super-cap for ordinary indemnity, and I would not set the floor higher as a default. For a 250 dollar vendor, ten times fees is only 2,500 dollars, so the 10,000 dollar floor controls, which is 40 times the annual price. That is a real improvement over folding the indemnity into the base cap, which could be as low as 250 dollars, and it is high enough to cover most ordinary correction, takedown, and small third-party costs, while still being a number a small vendor can accept. It is not a guarantee of full recovery: a contested third-party claim can cost more than 10,000 dollars in legal fees alone, so the cap will still leave you exposed on a large claim. That risk is why your uncapped carve-outs matter, because fraud, wilful misconduct, IP infringement, confidentiality, and violation of law are already outside the super-cap, and fees owed should stay outside it as well. For larger vendors, the ten times formula scales sensibly, since it passes 10,000 dollars once trailing fees pass 1,000 dollars. If a vendor is high volume or high risk, negotiate a higher super-cap or require insurance for that vendor rather than raising the floor for every small vendor, which would make the term harder to sell.

**What we did:** Indemnity capped at the greater of $10,000 or ten times trailing fees with named uncapped carve-outs, kept one-way (ruling 2). Vendor Terms 1.2, branch 3.

### Q7. Florida automatic renewal law (Fla. Stat. 501.165)

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). We sell an annual subscription at $250 a year per product to software vendors, which are businesses. It auto-renews. Florida law governs.

The draft says:

"An annual license renews each year on its renewal date. It renews unless you opt out before the renewal date. To opt out, cancel the renewal in the Stripe customer portal, or email us, before that date. The licenses then end on the renewal date. We send written notice by email 30 days before the renewal date."

The notice states the renewal date, the price, the number of licenses, any change to the agreement, and how to opt out. The checkout page shows the price, the renewal term, and the required acceptance box before payment.

Our view: Fla. Stat. 501.165 applies to consumer contracts, so a company buying for its business is outside it. Even so, our 30-day emailed notice with price and a cancel route meets the statute's notice requirement.

Questions: (a) Does 501.165 apply to a business buyer, in particular a sole proprietor paying by card? (b) If it can apply, does our checkout disclosure plus the 30-day emailed notice satisfy it? (c) Does any other state's auto-renewal law reach us because the vendor is located there, and if so what single disclosure would cover the common ones (California, New York, Illinois)?

**Answer (Josh Begg, 2026-11-04):**

(a) Section 501.165 does not reach your business buyers. Its definition of "consumer" expressly excludes an individual who enters the contract as part of or ancillary to his business activities or on behalf of a business. A sole proprietor buying a Managed listing to market his software buys for his business and is outside the statute; a personal card changes nothing, because the test is purpose, not the buyer's form or card.
(b) If it did apply, your structure is close. The statute requires clear and conspicuous disclosure of the renewal provision in the contract or offer and, for terms of 12 months or more, notice no less than 30 and no more than 60 days before the cancellation deadline, stating that it renews unless cancelled and how to cancel; a violation makes the renewal provision void and unenforceable. Your checkout disclosure, acceptance box and email cover the substance. One fix: send the notice 45 days out, not exactly 30 - the floor leaves no margin for a delivery or counting dispute.
(c) The California, New York and Illinois statutes are also consumer statutes, keyed to personal, family or household purchases, so they do not reach a business buyer because he is located there. Keep one strict flow anyway, for borderline buyers and card-network rules: at checkout, immediately above the acceptance control, state today's charge, the yearly charge and renewal date, automatic renewal until cancelled, and cancellation in the Stripe portal or by email before the renewal date; take a separate affirmative acceptance; send the 45-day reminder with date, amount and cancel method; and confirm cancellations by email. That satisfies Sec. 501.165 and the three named statutes for any consumer buyer, and is your best chargeback defense for the rest.

**Follow-up asked:** Does a month-to-month plan need a periodic reminder, or is the checkout disclosure plus cancel-any-time enough?

**Follow-up answer (Josh Begg, 2026-11-04):**

For the monthly plan, no periodic reminder is required, and the checkout disclosure plus cancel-any-time is enough, for two reasons.

First, your buyers are businesses, outside the consumer definitions, as covered in my earlier answer. Second, even for a consumer, Sec. 501.165 would not impose the reminder duty on a month-to-month plan. The 30-to-60-day pre-deadline notice in subsection (2)(b) applies only to a service contract whose term is a specified period of 12 months or more, and the definition in (1)(a) treats a provision as an automatic renewal provision only where each renewal runs for a period of more than 1 month. A monthly plan renews one month at a time, so neither element is met and no interval or content is prescribed.

What still governs any auto-renewing plan is the baseline: clear and conspicuous disclosure of the renewal terms in the contract or offer under subsection (2)(a), and under the federal Restore Online Shoppers' Confidence Act, 15 U.S.C. Sec. 8403, disclosure of the material terms before billing information is collected, the customer's informed consent, and a simple cancellation mechanism. Your checkout disclosure above the acceptance control, cancellation in the Stripe portal or by email, and service running to the end of the paid month satisfy that structure.

Two practical additions, not legal requirements: have the monthly Stripe receipt show the next charge date, the amount and how to cancel, which is your cheapest chargeback defense, and confirm each monthly cancellation by email as you are doing on the annual plan. If you later sell a monthly plan to consumers, some states, California in particular, reach continuous service month to month and add an acknowledgment requirement, so keep the same strict flow if that channel ever opens.

**What we did:** Confirmed B2B exemption; adopted the strict flow anyway: 45-day renewal notice, checkout disclosure above the box, cancellation confirmation, receipt footer. Text branch 1; build AECI-1596 (done).

### Q8. Asking customers for reviews, under the FTC Consumer Reviews rule

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). We run a website where construction professionals write reviews of software products. Software vendors claim their listing and agree to our Vendor Terms. We want vendors to be allowed to ask their customers for reviews, while complying with the FTC rule on Consumer Reviews and Testimonials (16 CFR Part 465) and the Consumer Review Fairness Act.

The draft says:

"You may not write reviews of your own products or a competitor's products, buy reviews, or offer anything of value for a review or for its content. You may ask your customers to review your products, as long as you do not direct what they write and do not choose who may review based on how they feel about the product. You may not ask a reviewer to change or remove a review, and you may not take any action against a reviewer because of a review."

Our view: this permits a neutral ask and bans paid reviews, sentiment-based review gating, and retaliation, which is what the FTC rule prohibits.

Questions: (a) Is this wording consistent with 16 CFR Part 465, in particular the rules on incentivized reviews and review suppression? (b) Does "offer anything of value for a review" correctly ban incentives tied to sentiment while allowing an incentive that is not conditioned on sentiment, or should we ban all incentives? (c) Does the clause need a disclosure duty on the vendor, such as telling its customers the review is unpaid?

**Answer (Josh Begg, 2026-11-04):**

(a) Mostly, but the clause is both broader and narrower than 16 C.F.R. Part 465. It is broader on incentives and on asking a reviewer to change a review, which the rule does not ban in every form. It is narrower in three places to add: reviews by people who did not actually use the product, or that misstate their experience; reviews by vendor officers, employees and close family, or anyone connected to the vendor, without clear disclosure; and misleading display, because a vendor that republishes reviews it collected may not show only the positive ones or present a set as complete when negative reviews were withheld for their sentiment, which is review suppression under Part 465. The Consumer Review Fairness Act also voids terms that penalize a person for a review.
(b) No, the sentence does not do that. As written, offer anything of value for a review bans every incentive, sentiment-based or not, because no sentiment condition appears in it. Part 465 bans compensation or an incentive given in exchange for, or expressly or impliedly conditioned on, a review expressing a particular sentiment. An incentive not tied to sentiment is not banned by that rule. Keep the total ban: it is stricter than the rule, lawful as a platform term, simpler to police, and protects your credibility. If you want to allow untied incentives, rewrite the sentence to say so and add the duty in (c).
(c) Yes, add a disclosure duty. Do not have the vendor tell customers the review is unpaid if that may not be true. Require the vendor to instruct every reviewer, in its ask, to disclose in the review, clearly, any material connection: an incentive, a free or discounted product, employment, ownership, or a family or business relationship with the vendor, and not to edit that disclosure out or reuse the review in advertising without it.

**What we did:** Kept the total incentive ban; added non-user and misleading-republication bans and the vendor's disclosure duty. Text branch 1.

### Q9. Private messages between two vendors: is a carve-out enough?

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). We run a directory of software integrations. Each integration involves two vendors. We may let the two vendors exchange private messages about a specific data row of their integration. Only those two companies and we can read the thread. This feature is built but switched off. Florida law governs.

Our Vendor Terms say:

"Do not submit anything confidential. The portal is for information you want published. If the portal lets you message another company in a private thread, that message is the exception. We share it only with that company. We can read it too. It is still not confidential as against that company or us."

Our view: because the vendor is told the message is readable by the other company and by us, and told not to send anything confidential, we take on no confidentiality duty, and a short carve-out is enough.

Questions: (a) Is this carve-out enough, or does offering a private channel create an implied confidentiality duty on us toward the sender? (b) Should the other company be bound not to share the sender's messages outside the thread, and if so does that belong in these terms or in a separate undertaking? (c) Any wording you would add so we are not liable for what one vendor says to another in a thread?

**Answer (Josh Begg, 2026-11-04):**

(a) The carve-out helps but is not enough alone. Private does not by itself create a fiduciary duty between arm-length businesses in Florida, and a clear, accepted warning that you may read the thread and that messages are not confidential as against you defeats most implied-duty and trade secret arguments (see Fla. Stat. 688.002(4) on secrecy efforts). But your sentence also promises you share a message only with that company, and that binds you. Duties remain that the clause cannot remove: limit staff access, secure the thread, disclose only as stated plus legal process and abuse review, and keep the stated retention. Show the warning in the thread header and get a first-use acknowledgment before the feature is switched on.
(b) Yes, bind the recipient in these terms. Both companies accept the same terms and alternate as sender and recipient, so a mutual term works: use and share thread messages only inside its own organization on a need-to-know basis and only for that integration, except legal process and professional advice. State the term is for the benefit of the sending company, so the sender has a direct right. Repeat it in a short in-thread acknowledgment naming the other company at first use; no separate signed document per thread.
(c) Add that each company is solely responsible for its own messages, their accuracy and its right to send them; that you do not write, endorse or verify messages, are not a party to the exchange, and are not liable for what a company says or for decisions made on it; that you may but need not monitor, remove or suspend for abuse or unlawful use; and that private means not published, not encrypted or hidden from you. Section 230, 47 U.S.C. 230(c)(1), generally shields a platform from publisher liability for another party content, not its own statements.

**What we did:** Mutual recipient term, no-liability lines, thread header warning and first-use acknowledgment. Text branch 1; build AECI-1616.

### Q10. Keeping message bodies after the author deletes their account

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). In the private messaging feature from the previous question, when a person deletes their account we keep the message body so the other company's record stays intact, but we remove the author's name. We are US-only and do not target EU residents. Florida law governs.

Our Vendor Terms say:

"If the portal lets you send messages in a private thread, they are kept with the integration for 2 years after the thread's last message. Your name is removed from them if you delete your account. Our Privacy Policy says how we handle personal data and what rights you have."

Our view: a fixed two-year retention with the author's name removed on deletion is acceptable for a US B2B service, and this sentence plus the privacy policy is sufficient disclosure.

Questions: (a) Is keeping the message body after account deletion acceptable under US law, including state privacy laws with deletion rights such as California's, given the author was a business user? (b) Is removing the name enough, or must we also remove anything in the text that identifies the author? (c) Is the sentence above sufficient disclosure in the terms themselves?

**Answer (Josh Begg, 2026-11-04):**

(a) Generally yes, with conditions, and Florida choice of law does not end it. Most state privacy statutes protect an individual acting outside a commercial or employment context, and the Florida Digital Bill of Rights also has revenue thresholds you will not meet, so a business user message is usually outside them. California is the exception: its CCPA business-to-business exemption has expired, so a California resident acting for a company can hold deletion rights if you meet the CCPA thresholds. Even then, Cal. Civ. Code 1798.105(d) permits retention to keep the counterparty record, meet a legal duty, and for internal uses aligned with expectations. Keeping a thread two years for records and disputes fits if you honor requests case by case, restrict access, never sell or reuse the body, and delete it at two years, including backups.
(b) Removing the name alone is not anonymization. It is enough only if nothing else identifies the author: no signature block, email, phone, title and company, self-identifying facts, or thread metadata such as the company and integration it sits in. The other company knows who wrote to it anyway. Treat the retained body as personal information held under a retention exception, not as deleted or anonymous data, unless you strip those identifiers and the link back to the account. Do not promise anonymization for that.
(c) No, not alone. The deletion screen should say, before the user confirms, that message bodies stay with the thread for two years, and the privacy notice at collection should state the category, purpose, period, what is removed, how deletion requests are handled and which exceptions may apply, and what happens in backups. A promise elsewhere that deletion erases everything would undercut the sentence and create a Florida FDUTPA and FTC Act deception risk.

**What we did:** Retained bodies described as kept under an exception, never anonymised; deletion screen warns; purposes and backup ceiling stated. Text branches 1 and 2; build AECI-1616.

### Q11. Two acceptance checkbox wordings

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). Two online agreements are accepted by ticking a required box. We record email, time, version, IP address and browser with each tick. Florida law governs.

Claim form (free listing claim, accepting our Vendor Terms): "I represent this company and accept the vendor terms."

Stripe checkout (paid plan, accepting our Managed plan agreement): "I have read and accept the Managed plan agreement."

Both labels link to the full text. Our Vendor Terms also say: "The person who ticks the box accepts these terms for themselves and on behalf of the company. If you do not have the authority to bind the company, do not claim. If you claim anyway, you are personally bound by these terms."

Questions: (a) Are these two wordings sufficient to form a binding clickwrap agreement in Florida? (b) Is "I represent this company" enough to bind the company, or should it read "I am authorized to bind this company"? (c) Is binding the individual personally when they lacked authority enforceable, and is it wise?

**Answer (Josh Begg, 2026-11-04):**

(a) Yes. A required unticked box, no way forward without it, the label beside the box, the full text linked and openable before ticking, and your record of email, time, version, IP address and browser (Fla. Stat. 668.50) make a binding Florida clickwrap. The Stripe wording is stronger because it says read; add I have read to the claim label, and surface the fee, cap and license terms near the label, because clickwrap fails when notice is unreasonable or a term is a surprise.
(b) Change it. I represent this company is ambiguous: I speak for it, or I warrant I may bind it, and ambiguity is read against you. Use: I have read and accept the Vendor Terms on behalf of the company named above, and I am authorized to bind that company. Capture the signer name, title and company legal name; your record names only an email, and this company needs a certain referent.
(c) Partly, and not wise as a blanket rule. Whoever claims authority he lacks is liable for breach of his warranty of authority and for the loss that false claim causes, and a clear undertaking can bind him to terms that are personal in nature. But this liability sits behind a link, not in the label, and would make a junior employee liable for a company indemnity on a free claim: a likely surprise term, and employees will refuse. Put the warning in the label, make an unauthorized claim voidable so you can un-claim the listing, and hold the individual to the accuracy of his claim and the loss it causes, not to all the company terms.
(d) On the added line, yes. The party must be a legal person: define The WBS Project, Inc. (we, us) as the operator of AEC Integrations (the Site), with entity form, state and notice address at first use. A brand cannot contract or hold rights. Define you as the company, the person ticking acting for you.

**What we did:** Claim label reworded to state authority; signer title and legal name captured; unauthorised claimant answers for the loss, claim voidable. Text branch 1; build AECI-1617 (done).

### Q12. Names and logos after a vendor gives up its claim

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). We run AEC Integrations, a public directory of construction-industry software, compiled from public information. A vendor may claim its listing and then upload its logo, screenshots and product text. If it later gives up the claim, the listing stays public because the directory is independent. Florida law governs.

Our Vendor Terms say:

"Our Terms of Service grant us a license to host, moderate, reproduce, adapt and display content you submit. That license covers your portal content too. It lasts for as long as we operate the service, including after your seats end, because the listing stays public."

and:

"You give us permission to show your company name, product names and logos on the service to identify your company and products. We use them only for identification and to say that the listing is claimed. We claim no ownership of them."

Our view: the content licence must survive so the listing stays whole, and showing a name or logo to identify a product is nominative fair use whether or not a licence exists.

Questions: (a) Should the trademark permission end when the claim ends, with identification use continuing as nominative fair use, and if so what wording keeps the two apart? (b) Does keeping a vendor-uploaded logo and screenshots live after the claim ends expose us to a Lanham Act false-association claim? (c) Is "adapt" needed in the licence, or is "format and excerpt" enough?

**Answer (Josh Begg, 2026-11-04):**

(a) Yes, split them. The trademark permission, unlike the Q04 content license, has no survival words and is tied to a purpose: identification and saying the listing is claimed. When the claim ends the second purpose is not just ended, it is false. End the permission for vendor-uploaded brand assets when the claim ends, and remove the uploaded logo and screenshots within a set number of days. Then say, separately and not as a permission: Nothing here limits our right to refer to a company and product by name in text to identify them in our independent directory. Nominative fair use is a defense you assert if challenged, not a license.
(b) Yes, that is where the exposure sits. Under Lanham Act section 43(a), 15 U.S.C. 1125(a), a use that is likely to suggest affiliation, sponsorship or participation is actionable, and a live uploaded logo in the same treatment as claimed listings, next to a claimed badge or vendor-supplied screenshots presented as current, does exactly that after the claim ends. Text use of a name to identify a real product, with the listing marked Unclaimed or Independent and a line that you are not affiliated with or endorsed by the vendor, is nominative use and low risk. Remove the badge at once and do not let the page look official.
(c) You do not need adapt for a directory that hosts and displays content as submitted, and dropping it is better. Format and excerpt, plus naming the operations you actually perform, resize, crop, compress, thumbnail, cache, index and make accessible, covers your real uses and avoids the fight that adapt invites about rewritten or repurposed content. Keep adapt only if you in fact create derivative material, such as edited summaries or translations, and then limit it to those uses and to not changing the meaning.

**Follow-up asked:** After a claim ends: badge off at once, uploaded assets removed within 14 days, then an AECi-sourced logo marked Unclaimed. Any issue, and is 14 days reasonable?

**Follow-up answer (Josh Begg, 2026-11-05):**

Sourcing the logo yourself does not solve the issue, because nominative fair use does not depend on who supplied the image. The test is whether the product cannot readily be identified without the mark, whether you use only so much as reasonably necessary, and whether you do nothing to suggest sponsorship or endorsement. A word name usually passes that test when the listing is marked Unclaimed and carries a clear not-affiliated line. A logo is riskier, because a logo in the same size, placement, and style as a claimed listing can still look official, even with a disclaimer, and a court may find that a word name would have been enough. If you keep an own-sourced logo, keep it small, do not use it as a badge or header image, do not alter it in a misleading way, keep the Unclaimed and not-affiliated wording immediately next to it, and remove it at once if the vendor objects or if the page could be read as endorsed. Fourteen days is a reasonable outer window for removing uploaded logos and screenshots, because the claimed label and any claim of affiliation come off at once, which stops the false impression immediately. Treat 14 days as a maximum, not a target, purge caches and copies as part of it, and remove sooner where you can, because a longer live period after the claim ends weakens your position if a vendor complains.

**What we did:** Brand-asset permission ends with the claim; assets removed within 14 days (ruling 3), sooner where possible; 'adapt' dropped. Logo-on-unclaimed listings: ruling 9 pending. Text branch 1; build AECI-1618.

### Q13. Ban for abuse: ending licences at once with no refund

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). We sell a $250-a-year or $25-a-month subscription to software vendors, which are businesses. Vendors edit their own listing data on our site. Florida law governs.

The draft Managed plan agreement says:

"We may end licenses for abuse, for misrepresentation or for non-payment. In those cases we may keep or revoke seats under our Vendor Terms. Licenses we end for abuse or misrepresentation are not refunded."

and the Vendor Terms say:

"We may end a company's vendor account, with or without notice, if you break these terms or the Terms of Service, if we reasonably believe the claim was not genuine, or if we stop operating the vendor portal."

We intend to tighten this to one rule: a ban for breaking the acceptable-use rules or for a false claim revokes every seat, ends every licence and cancels the subscription at once, with no refund, and control of the vendor's listing data returns to us so we can undo any damage.

Our view: immediate termination is justified because the abuse is to the public listing data itself, but keeping prepaid fees is forfeiture and may need objective grounds.

Questions: (a) Is forfeiture of prepaid fees on an immediate ban enforceable in Florida for a business customer, if the grounds are tied to a written acceptable-use rule? (b) Does a breach ban need a notice-and-cure period, and if so is "with or without notice" acceptable for the false-claim case? (c) If outright forfeiture will not hold, is a pro-rata refund of the unused term the right fallback?

**Answer (Josh Begg, 2026-11-04):**

(a) Immediate termination, yes; keeping all prepaid fees, only sometimes. Florida enforces clear termination rights between businesses, so a ban tied to a written, objective acceptable-use rule is defensible for a material breach. Fee retention is the weak half: Florida courts disfavor forfeitures and read them strictly. Keeping a whole $250 year, in month one, for a minor or disputed breach, with no loss to you, looks like a penalty, not a price, and invites a refund claim and a Florida FDUTPA argument. Retention holds best for a serious, proved breach. List the grounds and keep an evidence record; reasonably believe is enough to suspend, not to keep money.
(b) Florida law does not impose a cure period on a business contract that does not promise one. But with or without notice is too blunt. Rewrite it in two stages: we may suspend seats and edit access at once, without prior notice, to protect the listing; termination then follows written notice naming the rule broken and the evidence, with a short period to cure a breach that can be cured or to show the finding is wrong. A false claim cannot be cured, so no cure period is needed there, but give a brief chance to prove identity and authority before any forfeiture, because a mistaken-belief case is the one you will lose.
(c) Yes. A pro rata refund of the unused term, less fees for the period used and your documented loss from the abuse, cleanup, chargebacks and third-party claims, is the outcome a court is most likely to reach anyway. Money kept as damages must be credited against the loss, not counted twice. Also change control of the listing data returns to us: termination ends the vendor edit right and lets you remove its fields; it does not transfer ownership of vendor data.

**Follow-up asked:** Is a 7-day cure or rebuttal window customary, and does a stated $150-an-hour rate make the abuse-cost deduction a price rather than a penalty?

**Follow-up answer (Josh Begg, 2026-11-05):**

Florida law does not set a customary 7 day period for this kind of business contract, so 7 days is a contract choice, not a statutory norm. Seven days is common for a simple notice and cure period, and it is workable where the notice identifies the clause, the listing, and the evidence, but it can be short where the vendor must gather records or get legal review, so start each stage on receipt of the specific notice and consider business days. Keep the two stages separate: Stage 1, within 7 days after notice, the vendor may cure or rebut with evidence. Stage 2, if Stage 1 does not resolve it, the vendor has 7 more days to prove identity and authority on a false-claim finding. A stated rate of 150 dollars an hour alone does not make a deduction a price rather than a penalty. Florida courts test a deduction as liquidated damages or a penalty by whether it was a reasonable estimate of actual loss when the contract was made, whether actual loss is hard to prove, and whether it is punitive in effect. Your proposal helps on that test because it is limited to staff time logged by task, plus costs actually paid to others, capped at the refund due, with an itemised statement sent to the vendor. Keep those limits, require contemporaneous logs, deduct only costs caused by the false claim, credit any other recovery, and refund the balance, and do not use the deduction to keep prepaid fees for an unused term, which would still look like forfeiture.

**What we did:** Suspend first, then written notice, 7 business days to cure or rebut, further 7 for a false-claim finding, pro-rata refund less itemised cost at $150/hour (ruling 1). Text branch 1; build AECI-1623 (done).

### Q14. Policies incorporated by hyperlink

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). Our four public documents are the Terms of Service, the Vendor Terms, the Managed plan agreement, and two policies (Listing Accuracy Policy, Review Guidelines). Each is a web page. The Terms of Service link to both policies as the process for corrections and review complaints. The Managed plan agreement links to a "Plans" page that describes what the paid plan includes. The Vendor Terms are accepted by a checkbox on the claim form; the agreement by a checkbox at checkout; the Terms of Service by use. Florida law governs.

The precedence sentence reads: "If they conflict, this agreement wins for licenses and billing, then the Vendor Terms, then the Terms of Service."

Our view: a clearly labelled hyperlink to a numbered, dated page is enough to incorporate a policy by reference, and the precedence order is right because the agreement is the most specific document.

Questions: (a) Are hyperlinked policies incorporated clearly enough to bind a vendor that clicked the checkbox, and what sentence should the Terms carry to make it explicit? (b) Does the precedence order risk letting the agreement override protections in the Terms of Service such as the disclaimers and the content licence, and should those be carved out? (c) Is a link to the "Plans" page an acceptable way to define what the paid plan includes, or should the agreement list the capabilities?

**Answer (Josh Begg, 2026-11-04):**

(a) A labelled hyperlink to a numbered, dated page can incorporate a policy under Florida law, if the referenced document is identified clearly and the intent to make it part of the bargain is plain. Your weak link is the path: the policies sit behind the Terms of Service, accepted only by use, while their duties bind vendors who assented by checkbox to a different document. Incorporate them in the checkbox documents themselves: The Listing Accuracy Policy and the Review Guidelines, each as numbered and dated at the links in this section, are part of these terms and bind you as if set out in full. Name them beside the checkbox, archive the accepted version with the acceptance record under Fla. Stat. 668.50, and change them only as in my Q03 answer, never by silent edits.
(b) Yes, the risk is real, and the topic limit is only a partial answer. Read broadly, agreement wins for licenses could let a narrow license or billing sentence displace the content license, disclaimers or liability limits elsewhere whenever the two can be said to conflict. Carve those out by name: precedence applies only to a direct conflict on the same subject, the documents are read together first, and nothing in the agreement overrides the content license, IP ownership, disclaimers, liability cap and indemnity, or governing law and dispute terms. Rank the policies below the document that incorporates them.
(c) A Plans page link works for detail, not as the only statement of the bargain. It is marketing copy you can edit at will, so a capability dropped mid-term becomes a breach and a deceptive practice argument. List the core inclusions in the agreement or checkout record, seats, edit rights, term, price, headline features, and incorporate a dated snapshot of the Plans page into the acceptance record. Later changes apply at renewal.

**What we did:** Policies incorporated by version in the checkbox documents; precedence limited to direct conflicts with named carve-outs; core inclusions listed; Plans snapshot in the acceptance record. Text branch 1; build AECI-1619.

*Built 2026-11-11 (AECI-1619).* A line under the claim box names the Listing Accuracy Policy and the Review Guidelines with their versions, and the claim's acceptance row records both versions. The Plans page now has a version. Each version is kept as a dated snapshot file at `/docs/vendors/plans/v<version>`. A checkout or grant acceptance records the Plans version and a SHA-256 of that snapshot. Any change to the page, a capability or a price is a new version. The Managed plan agreement 1.1 now lists the core inclusions in "What a subscription is and does", edited in place without a bump. Counsel review of that sentence is pending on AECI-1363 (`DATABASE_SCHEMA.md` §8.6d).

### Q15. Conspicuous formatting for the liability cap and disclaimers

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida). Our documents are written in plain English with short sentences, no capitals and no bold inside the body. The Managed plan agreement caps our liability at fees paid in the trailing twelve months; the Vendor Terms cap at one hundred US dollars; the Terms of Service exclude indirect damages and disclaim warranties. All three sections sit in normal body text under their own headings. Florida law governs.

Our view: a heading of its own and plain language make the clause conspicuous enough; we would rather not use capitals.

Questions: (a) Does Florida require the warranty disclaimer and the liability limit to be conspicuous, and does a dedicated heading with plain text meet that? (b) If more is needed, is bold type on those sections enough, or must it be capitals? (c) Any other section you would treat the same way?

**Answer (Josh Begg, 2026-11-04):**

(a) Florida has no statute requiring capitals in a business services contract. Fla. Stat. 672.316(2) makes a disclaimer of implied warranties in a sale of goods effective only if conspicuous, and Fla. Stat. 671.201 defines conspicuous as written so a reasonable person ought to have noticed it; larger or contrasting type is the standard example. Florida courts also read clauses that cut off remedies strictly, and a buried term invites an unconscionability or no-assent argument in clickwrap. A clear heading over plain text is a start, but here it is not enough: the three sections look like every other section, so nothing signals that they take rights away. The 100 dollar cap in the Vendor Terms is most exposed, because the amount is startling and formatted as routine text.
(b) No capitals requirement. Bold is enough if it is real contrast: a bold heading and the whole operative clause in bold, kept that way on mobile and in the archived copy, not a bold heading over normal text. One practical exception: put the warranty disclaimer sentence itself in capitals. That is the clause the UCC trains judges to look for in capitals, the site sells nationwide, and other states treat capitals as the safe form. Also repeat the cap and the damages exclusion in short form beside the checkout and claim checkboxes, as in my Q11 answer; formatting inside a linked document helps less.
(c) Yes: the indemnity, which Florida courts construe strictly; any arbitration, jury waiver or class waiver wording; the renewal and no-refund terms, which 15 U.S.C. 8403 independently requires to be clear and conspicuous before consent; the content license; the personal liability wording for an unauthorized signer; and termination without refund. Use one rule: only clauses that take money, a right or a loss get this treatment, so it lasts.

**What we did:** Whole operative clauses in bold, warranty disclaimer in capitals, short-form cap beside both checkboxes. Text branch 1; build AECI-1617.

### Q16. Venue: Martin County state courts and the Southern District of Florida

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc., a Delaware corporation based in Stuart, Florida (Martin County). Our customers are software vendors across the US, and some outside it. All three contracts say:

"The state courts located in Martin County, Florida, and the United States District Court for the Southern District of Florida have exclusive jurisdiction over any dispute arising from these terms or the service, and you consent to that jurisdiction and venue, except where applicable consumer law provides otherwise."

Our view: Florida law plus our home county is the right choice for a small operator, and naming the federal court as well is harmless.

Questions: (a) Is naming the federal court harmless when most disputes will fall under the $75,000 diversity threshold, or does it create confusion? (b) Is a Martin County forum clause enforceable against an out-of-state vendor with no contact with Florida beyond the website? (c) Should a Delaware corporation prefer Delaware for anything here?

**Answer (Josh Begg, 2026-11-04):**

(a) Naming the Southern District is not harmless surplus, but it does not create federal jurisdiction. A clause cannot confer subject-matter jurisdiction: under 28 U.S.C. 1331 and 1332, a federal case needs a federal question or complete diversity plus more than $75,000 in controversy. Below that, or without diversity, the federal part is simply inoperative and suit belongs in Martin County state court, after motion practice the clause invites. Cleaner wording is state court, or federal court in the Southern District if federal jurisdiction exists there. Martin County is in that district.
(b) Against a vendor that actually assented, Florida law presumptively enforces a mandatory forum clause unless the challenger shows enforcement would be unreasonable or unjust, fraud or overreaching aside, Manrique v. Fabbri, 493 So. 2d 437 (Fla. 1986); Carnival Cruise and Burger King treat a freely communicated commercial forum term as consent and purposeful availment. Fla. Stat. 48.193(1)(a)1. and 7. may also fit a vendor doing business or breaching in Florida, but Fla. Stat. 685.101-685.102 help only for a transaction of at least $250,000, so do not rely on them for small deals. The weak case is a vendor that never agreed - mere viewing of a website, with no click or signed assent and no other Florida contact, is not consent, and the clause alone will not bind it. Keep clear clickwrap proof.
(c) No. Delaware incorporation governs internal affairs - director, officer and stockholder claims, see 8 Del. C. 115 - not ordinary vendor contracts. Your operations, witnesses and records are in Stuart, so Florida is the rational forum. Do not add Delaware to these terms; reserve Delaware, if at all, in the charter or bylaws for internal corporate claims.

**What we did:** Venue reworded to the Southern District 'where federal jurisdiction exists'; later made exclusive (Q35). No Delaware. Text branches 1 and 2.

### Q17. Section 230 and how far we may moderate, curate and decide

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. We compile listings from public sources into our own taxonomy, pre-moderate every user review before publication, and may remove a review or redact part of it (personal data, confidential information) but never reword it. Vendors maintain some listings themselves. When two vendors disagree about a detail of an integration, we give a non-binding view, and we may correct a verifiable factual error ourselves. Florida law governs.

Our Terms say reviews are "the opinions of the individuals who submitted them, not statements of fact by the operator", and our Review Guidelines say: "We may remove a published review at any time if it later appears to breach these guidelines, or redact the part that breaches them, for example personal data or confidential information. We never reword a review."

Our view: pre-moderation, removal and narrow redaction are traditional publisher functions protected by Section 230; rewording would not be, so we have excluded it.

Questions: (a) Does our moderation and redaction standard keep Section 230 immunity for user reviews under Eleventh Circuit law, and is "never reword" the right line? (b) Does curating public data into our own taxonomy, or giving a view on a contest between two vendors, make us an information content provider for the listing data? (c) Any wording you would add to the Terms or Guidelines to protect the posture?

**Answer (Josh Begg, 2026-11-04):**

(a) Yes, as an operating line, with one caution. Under 47 U.S.C. 230(c)(1), a provider is not treated as the publisher of information provided by another information content provider, and under (f)(3) you are a content provider only if responsible in whole or part for creating or developing the content. Pre-moderation, removal and narrow redaction of reviews are traditional editorial functions courts protect, including in the Eleventh Circuit. The limit is material contribution: an edit that changes meaning or adds the unlawful sting can make that material partly yours. Never reword is the right rule, but not a safe harbor, because a redaction that distorts context contributes as a rewrite would. Add a fallback: if a part cannot be removed without changing meaning, remove the whole review.
(b) Split it. Sorting public facts into categories is organization of others' data, but your taxonomy labels, summaries, integration statements and any view in a vendor dispute are your own statements, and Section 230 never shields your own content. Vendor-written fields remain the vendor's unless you materially develop them. If you correct an error yourselves, the corrected statement becomes yours; have the vendor submit the correction, or label, date and source your note.
(c) Add wording that: (1) user content is the author's alone and moderation is not adoption or endorsement; (2) you redact only personal or confidential material and remove rather than edit where redaction would change meaning; (3) content you author is labeled AEC Integrations content, sourced and dated, and vendors answer for fields they maintain; (4) a named correction contact and process. One uncertainty: the Eleventh Circuit has not squarely adopted the material contribution test and Florida district courts vary, so draft to the stricter standard.

**What we did:** Added 'remove the whole review where redaction would change meaning'; operator-authored text labelled. Text branch 1; build AECI-1614, AECI-1628.

### Q18. Review Guidelines against the Consumer Review Fairness Act and the FTC reviews rule

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating a US review website for construction-industry software. We want our Review Guidelines to comply with the Consumer Review Fairness Act and the FTC rule on Consumer Reviews and Testimonials (16 CFR Part 465). Florida law governs.

The Guidelines ban: "reviews of products you have not used, reviews submitted in exchange for compensation, or coordinated attempts to inflate or suppress a rating"; "reviews of a product by people who work for the vendor or for a competitor, with or without disclosure"; and ask reviewers to "disclose any other relationship that could color your view, for example if you are a reseller, a consultant, or a former employee." Vendors may reply, and a reply "must not identify or speculate about the reviewer, offer them anything, or ask them to change or remove their review."

Our view: a platform may set stricter rules than the FTC rule (which bans sentiment-conditioned incentives, not all incentives), and the outright ban on insider reviews is the safer line.

Questions: (a) Is the outright ban on compensated and insider reviews consistent with the rule, or does banning all compensated reviews create a problem of its own? (b) May a vendor invite a reviewer to post an updated review after fixing the reported problem, without this being an "ask to change or remove"? (c) Does anything here restrict or penalize a reviewer in a way the Consumer Review Fairness Act forbids?

**Answer (Josh Begg, 2026-11-04):**

(a) The outright ban is consistent with the rule. 16 CFR Part 465 is a floor against deception, not a right to be published: it bans compensation only when conditioned on a particular sentiment (465.4), allows insider reviews with clear disclosure (465.5), and treats review hosting separately (465.2(d), 465.5(b)). A private platform may be stricter. The ban creates a problem only if enforced unevenly: removing compensated or insider reviews only when they are negative risks a suppression and misrepresentation claim under 465.7(b) and Section 5. Apply it categorically and keep enforcement records.
(b) An update invitation is fine under the rule, but not under your text as written. A neutral invitation, with nothing offered and no pressure, violates neither 465.4 nor 465.7(a). Your reply rule, though, bars asking a reviewer to change a review, and an update request is literally that. Amend it to permit this: the vendor may state that the problem has been fixed and invite an updated or additional review reflecting current experience, without asking for deletion, a rating, or favorable content. Use an update feature that keeps the original and dates the update.
(c) Nothing here offends the CRFA. 15 U.S.C. 45b(b) voids provisions in a seller's own form contract that bar, penalize, or charge a customer for a review; it does not govern a platform's display rules, and 45b(b)(2)(C) preserves removal of reviews containing personal information or that are unrelated or clearly false or misleading, which covers most of your bans. Nothing imposes a fee or penalty on an honest reviewer. Two cautions: vendors must not copy these Guidelines into their own customer contracts, and do not remove an honest review on an unproven claim it was compensated or insider-written; let the reviewer verify use and disclose first.

**What we did:** Update invitation permitted; 'Add an update' feature keeps the original (ruling 4). Text branch 1; build AECI-1613.

### Q19. Vendor-maintained listings: is the responsibility sentence enough?

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory of construction-industry software. A vendor that has claimed its listing can edit certain fields and add integrations, which we publish without prior review. Florida law governs.

Our Terms say: "Some listings are maintained by the vendor that offers the product or integration. That vendor's changes to them, and listings it adds, are published without prior review by us." And: "Content a vendor publishes through its vendor account, including product and integration details it edits or adds, is content it submits for the purposes of these terms, and the vendor is responsible for it." The Vendor Terms carry an indemnity for content the vendor submits.

Our view: this makes the vendor the author of its own listing data and preserves our Section 230 posture for it.

Questions: (a) Is that sentence enough to make the vendor responsible for its own listing data, or does it need a representation of accuracy and a duty to correct in the Terms as well as in the Vendor Terms? (b) Does publishing vendor data without prior review change our liability for it compared with data we compiled ourselves? (c) Should the public page say which fields the vendor maintains?

**Answer (Josh Begg, 2026-11-04):**

(a) The sentence is good evidence, but it is not enough by itself. Against third parties, Section 230 status turns on who in fact created or developed the content under 47 U.S.C. 230(f)(3), not on a label the parties agree between themselves, and the indemnity only shifts loss between you and the vendor; it does not stop a claimant from suing you. Put the operative promises in the Vendor Terms the vendor accepts when claiming and editing: a representation that submitted data is accurate, complete and current and does not infringe or deceive, a continuing duty to correct promptly on learning of an error, and your right to suspend or remove a listing for breach. Keep an audit log of vendor edits; that record, more than the sentence, proves authorship.
(b) No. Section 230 neither requires prior review nor punishes it, and learning that third-party content is false does not by itself defeat immunity for it. The dividing line remains origin: vendor-entered data is the vendor's content whether or not you screen it; data you compile yourselves is your content however carefully you review it, with exposure under trade libel, the Lanham Act and FDUTPA if it is false. One caution: do not market listings as verified unless you actually verify them; that claim would be your own.
(c) Yes. Label the vendor-maintained fields, for example Vendor-supplied with a last-updated date. It is not required by Section 230, but it is strong evidence of third-party origin, it keeps the page from implying you verified vendor data, and it supports the indemnity. Keep the same distinction in the Terms so the public page and the contracts tell one story.

**What we did:** Accuracy representation and duty to correct in the Vendor Terms; 'Maintained by' captions (ruling 5); never 'verified'. Text branch 1; build AECI-1614.

### Q20. Removal requests: which ones oblige us to act

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, an independent US directory of construction-industry software compiled from public information. Florida law governs.

Our Listing Accuracy Policy says: "We will not remove an accurate listing simply because a vendor asks us to. ... We remove a listing only to correct an error, reflect that a company or product is defunct, comply with a legal obligation, or enforce our terms." We are building a reversible "hidden" state that takes a listing off the site and out of search but keeps the data so it can be restored.

For each request type below, we want to know whether we are obliged to act, what we are exposed to if we refuse, and whether hiding is enough or deletion is required:

1. A vendor asks to be removed and the listing is accurate.
2. A vendor says the listing is inaccurate and we cannot verify either way.
3. The company or product is defunct.
4. A trademark or copyright complaint about a name or logo on a listing (not a DMCA notice on a user review, which has its own process).
5. A defamation claim about a listing's text (not a review).
6. A court order or a lawful government request.
7. A request about a named person rather than a company.
8. A cease-and-desist letter from a vendor that has never claimed its listing and has no contract with us.

Questions: (a) Which of these oblige us to act, and which may we refuse? (b) Does a reversible hidden state satisfy a takedown demand, or do some requests require deletion? (c) What notice must the vendor get, and is a stated dispute route required or just good practice?

**Answer (Josh Begg, 2026-11-04):**

No Florida law imposes a general duty to remove a truthful, accurate listing because a vendor objects, has not claimed it, or sends a cease-and-desist letter. With no contract, that letter is a demand, not an obligation, so you may refuse 1 and 8.
You must obey a valid court order directed to you, and a subpoena or other lawful government process within its scope, in 6. An informal government request is not an order.
A complaint in 2, 3, 4 or 5 is an allegation, not proof. 2 and 3 are governed by your policy, but knowingly keeping a materially false listing risks a claim under Fla. Stat. 501.204 (FDUTPA). Investigate, correct what is proved wrong, and hide pending verification. 4: using a name to identify a company is ordinarily nominative use. A logo complaint alone does not oblige removal; a compliant DMCA notice, 17 U.S.C. 512, or a court order, changes that. 5: Florida defamation requires a false statement of fact; Fla. Stat. 770.01 gives a presuit notice rule for media defendants. If your own text is proved false, correct or remove it; Section 230 does not protect your own content.
7: Florida has no general deletion right for public business information about a named person. The Florida Digital Bill of Rights, Fla. Stat. 501.701 et seq., gives deletion rights only against covered controllers, generally over $1 billion in global revenue plus a qualifying business model.
A reversible hidden state that removes a listing from public view and search will normally meet the practical purpose of removal. It does not meet an order or duty requiring deletion of the underlying data. Retained data remains discoverable, so state what hidden means.
No statute generally requires notice or a stated dispute route. Both are good practice, and are binding if your policy promises them.

**What we did:** Decision rule recorded on AECI-1238: refuse 1 and 8, obey 6, investigate 2 to 5 and hide pending verification, hidden state defined. Unblocked AECI-1238.

### Q21. Injurious falsehood once we are on written notice

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory of software integrations. Each integration listing involves two vendors. The vendor that built the integration owns the listing and maintains its details. The other vendor can contest a detail; the owner decides; we give a non-binding view on request. Florida law governs.

Our Listing Accuracy Policy says: "Our view is advice. We do not change the integration, because the owner maintains its details. The value on record stays unless the owner changes it. If our review shows the value on record is a factual error we can verify against a public source, we may correct it under Requesting a correction above."

Our view: once we hold verifiable evidence that an owner-maintained value about the other vendor's product is false, the correction route lets us fix it, and that is enough to avoid joint liability.

Questions: (a) If an owner states something false about the other vendor's product and we are told in writing, does leaving it live expose us to injurious falsehood or commercial disparagement under Florida law, and does Section 230 apply to vendor-authored listing data? (b) Is "we may correct" enough, or should it be "we will correct" when the evidence is clear? (c) How long may we take to act after notice?

**Answer (Josh Begg, 2026-11-04):**

(a) Section 230 will shield you, and notice alone does not remove it. Under 47 U.S.C. 230(c)(1), a provider is not treated as the publisher of information provided by another information content provider. Vendor-authored data is third-party content, so leaving it live after a written complaint does not by itself make you liable for the vendor's false statement. The shield weakens for content you author, materially develop, or adopt as your own verified finding. If Section 230 does not apply, Florida injurious falsehood, or trade libel, requires a false statement about another's business or product, publication, malice, and special damages, which must be pleaded and proved. Bothmann v. Harrington, 458 So. 2d 1105 (Fla. 3d DCA 1984). Malice can be shown by knowledge of falsity or reckless disregard. Written notice plus verifiable proof matters for that reason: it does not create the claim, but continued publication after you can verify falsity is evidence of knowledge, and damages grow while the statement stays live. A bare allegation or unverifiable dispute does not have that effect.
(b) 'We may correct' preserves discretion on disputed claims, and 'will' wording in a public policy can be treated as a promise. Neither word shields you once falsity is verified. Safer drafting is a two-step commitment: you will promptly hide or flag the contested value on receipt of specified proof, and will correct it within a stated period if review verifies a factual error against the named public source. That commits you to process and deadline for clear cases without promising an outcome in every dispute.
(c) Florida law sets no fixed number of days to act on such a notice. Act in days, not weeks, on a documented timetable, and record receipt, verification, interim hiding, and the decision. Delay after clear proof helps prove malice and damages.

**Follow-up asked:** Are two business days to hide or flag and five business days to correct defensible to state publicly?

**Follow-up answer (Josh Begg, 2026-11-05):**

Yes, two business days to hide or flag and five business days to correct a confirmed error are defensible to state publicly, and they fit the standard from the original answer, which was to act in days, not weeks, on a documented timetable. Florida law sets no fixed number of days for this, so the periods are defensible as a reasonable process commitment, not as a statutory safe harbor. Start both clocks on receipt of a public source that actually shows the value is wrong, not on a bare complaint, and define business days and the method for submitting the source, so the trigger is clear. Hiding or flagging within two business days is the key protection, because it stops further harm while you verify, and it should be stated as interim action, not as an admission that the value is false. Correct within five business days only where review confirms a factual error against the named public source; for a genuinely disputed or complex value, state that you will tell the requester within five business days what further verification is needed and when you expect to decide, rather than promising a correction you cannot make. Only publish periods you can reliably meet, because a missed public deadline will be used as evidence of knowledge and delay in a trade libel claim, and correct sooner than five days where verification is immediate, since damages can grow while a known error stays live.

**What we did:** Two-step commitment: hide or flag within two business days of proof, correct within five (ruling 6), status reply for disputed values. Text branch 2; build AECI-1238.

### Q22. Intellectual property claim over the directory

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory that organizes construction-industry software by a taxonomy of our own design. We know facts are not copyrightable and that a US appeals court held a construction classification system (MasterFormat) uncopyrightable. Florida law governs.

Our Terms say: "The service's design, software, and editorial content, and the selection and arrangement of its taxonomy, listings, and integration data as a compilation, are owned by the operator or its licensors and are protected by intellectual-property laws to the extent the law allows. We do not claim ownership of the facts about any product or integration, or of any vendor's name, logo or trademark."

Our view: this claims only what is claimable (design, software, editorial text, the compilation) and disclaims the facts and the marks.

Questions: (a) Is this the right scope, and is "to the extent the law allows" helpful or a red flag? (b) Does displaying vendor logos and product screenshots to identify a product in a comparative directory meet the Eleventh Circuit's nominative fair use standard, and what disclaimer wording helps? (c) Does the "scrape at scale" ban in Acceptable use give us any remedy against a competitor copying the directory, given the facts are free?

**Answer (Josh Begg, 2026-11-04):**

(a) The scope is broadly right. Under Feist Publications v. Rural Telephone Service, 499 U.S. 340 (1991), and 17 U.S.C. 102(b) and 103(b), facts, ideas and systems are not copyrightable, and a compilation is protected, thinly, only in its original selection, coordination or arrangement. Software, original design and editorial text are claimable. A functional taxonomy is at risk under section 102(b), as the MasterFormat ruling shows, and an original arrangement protects only that expression, not the facts. 'To the extent the law allows' helps: it keeps the clause from claiming more than the law gives.
(b) Eleventh Circuit nominative fair use, as in TracFone Wireless, Inc. v. Cabrera, 883 F.3d 1354 (11th Cir. 2018), asks whether the product is not readily identifiable without the mark, only so much is used as is reasonably necessary, and the use suggests no sponsorship or endorsement. A listing-size logo, used the same way for every vendor to identify its own product, should meet it. Keep screenshots small and identifying: that supports fair use under 17 U.S.C. 107. This notice helps: 'Names, logos and screenshots belong to their owners, are used only to identify the product, and do not imply endorsement or affiliation.'
(c) A scrape ban gives a contract remedy only against a person bound by the Terms, such as a scraper who assented after clear notice. It creates no right in the facts and does not bind a stranger competitor. Copying original editorial text or original selection and arrangement can be infringement. Scraping public pages, after hiQ Labs v. LinkedIn and Van Buren, is unlikely alone to be unauthorized access under the Computer Fraud and Abuse Act. Other routes are notice revoking access, technical blocking, and Fla. Stat. 501.204 (FDUTPA) if the copy passes itself off deceptively.

**What we did:** Added the 'names, logos and screenshots belong to their owners' line; scrape ban understood as contract-only. Text branch 1.

### Q23. Records behind "never influenced by payment"

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Vendors can buy a paid plan that changes what they can edit on their listing. It never changes ranking, placement, or whether a review is published, and tests in our code enforce that. Florida law governs.

Our Terms say: "Our editorial judgment and search ranking are algorithmic and are never influenced by payment." The Vendor Terms and the paid-plan agreement repeat it.

Our view: the claim is true and we can prove it from the ranking code and its tests, the audit log, and the paid-plan capability list.

Questions: (a) Under Florida's Deceptive and Unfair Trade Practices Act, what records should we keep to defend that statement against a competitor or vendor claim? (b) Does "Plans never affect ranking or reviews" protect us if a paying vendor receives negative reviews or drops in ranking and claims tortious interference? (c) Should the public ranking explanation page be referenced from the Terms?

**Answer (Josh Begg, 2026-11-04):**

(a) Under Fla. Stat. 501.204 (FDUTPA), this claim is defended with substantiation held when the statement was made. Keep, versioned and dated: ranking code and its input list showing payment status is not an input, with change logs; automated tests and results for the rule that plans do not affect ranking, placement or review publication; the paid-plan capability list and each version of the Terms and paid-plan agreement; audit logs of manual ranking or moderation actions, with actor and reason; moderation records showing the same standards for paying and non-paying vendors; and ranking snapshots before and after a plan purchase or cancellation. Keep them at least four years, the limitations period generally applicable to these Florida claims, and longer on litigation hold.
(b) The statement helps but is not a shield alone. Florida tortious interference requires a business relationship, knowledge, intentional and unjustified interference, and damage. Ethan Allen, Inc. v. Georgetown Manor, Inc., 647 So. 2d 812 (Fla. 1994). A vendor in contract with you is not a stranger to it, reviews by others are not your interference, and a drop from neutral, pre-disclosed criteria applied as promised is justified. The wording is evidence no ranking was promised and payment bought only editing capability. It will not protect conduct contradicting it, such as demotion after cancellation.
(c) Yes, reference the ranking page from the Terms with a stable link, if accurate and kept current. That can incorporate it and show the factors used. The page then becomes part of your representations, so version and archive it, and state that the Terms control on any conflict.

**What we did:** Terms link the ranking page; ranking snapshots on plan change and ranking-page versioning. Text branch 1; build AECI-1621. *Applied 2026-11-18 (legal branch 6, AECI-1857):* the Terms sentence now reads "Search ranking is algorithmic. Neither it nor our editorial choices are ever influenced by payment." The old wording called all editorial judgment algorithmic, which hand-set orders such as category display order made untrue. Counsel has not seen the new sentence. *Superseded 2026-11-26 (AECI-2230, item 14.8):* "Neither it nor our editorial choices are ever influenced by payment" is replaced by ruling 65's wording. "Search ranking is algorithmic" stays.

*Built 2026-11-16 (AECI-1621).* The Terms link and the "these terms control" sentence shipped earlier, in #1163. When a plan starts or ends on a product, we now record a ranking snapshot at the event and again 30 days later (Chris, 2026-11-16). Each snapshot holds the product's ranking inputs and its position in each public list, and no personal data. Snapshots are kept four years under a storage lock on the `evidence/` prefix (Chris, 2026-11-16). The lock is an operator step after deploy. `/docs/trust/how-ranking-works` is now versioned at 1.0, recorded November 16, 2026. Each version is archived at `/docs/trust/how-ranking-works/v<version>`, and any change to the page is a new version. No legal text changed.

### Q24. Are unclaimed vendors bound by anything?

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory compiled from public information. Most listed vendors have never created an account with us. Only a vendor that claims its listing clicks to accept our Vendor Terms. Our Listing Accuracy Policy sets correction and contest procedures with time limits; contests are only available from a vendor account. Florida law governs.

Our view: an unclaimed vendor is a subject of the directory, not a party to any contract with us; it can use the free correction route and nothing in our documents binds it; our obligations to it come from general law (defamation, trademark, unfair competition), not contract.

Questions: (a) Is that analysis right? (b) Is there anything in the Terms or policies we should state as applying only to account holders, to avoid an argument that we tried to bind non-parties by browsewrap? (c) When an unclaimed vendor writes to us, should our reply reference the policy at all?

**Answer (Josh Begg, 2026-11-04):**

(a) Yes, your analysis is right. A vendor that has never claimed its listing has accepted nothing; the Vendor Terms bind only the vendor that clicks to accept them on claiming. It is not bound by browsewrap either: courts enforce browsewrap only where the user had actual or inquiry notice of the terms and assented by using the site, and being listed in a directory compiled from public sources is not use of your site. What governs your dealings with an unclaimed vendor is general law: defamation for false statements of fact in a listing, trademark limits on using its name and marks, and unfair competition, including Sec. 501.204, Florida Statutes (FDUTPA). Two qualifications. Your Policy's time limits cannot bind a non-party: they are your internal process for account holders and do not shorten a non-party's legal claims or deadlines. And the correction route should be open to an unclaimed vendor in writing; if the only way to contest a listing is to claim it and accept terms, you weaken your position in a defamation dispute.
(b) Add a scope clause to the Terms and the Policy: "These Terms and this Policy apply only to account holders and to vendors that have claimed a listing. Nothing in them imposes any obligation on, or limits the rights of, any person that has not accepted them." Keep the Policy's contract language (duties, deadlines, waiver) inside the account-holder contest procedure, and describe corrections for everyone else as a process you offer, not terms imposed.
(c) Yes, reference the Policy, framed as your process, not their obligation: "Our Listing Accuracy Policy sets out how we handle correction requests; send the facts you say are wrong and your documentation." Do not write that they are bound by it, missed a deadline under it, or must claim the listing to be heard, and do not admit a listing is false; acknowledge, review, and answer.

**What we did:** Scope clause added to the Terms and the policy; correction route stays open to unclaimed vendors. Text branch 1.

### Q25. A subpoena for a reviewer's identity

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating a US review website for construction-industry software. Reviewers sign in by email. We hold the reviewer's email address, optional profile answers, and a monthly keyed hash of their IP address; we never store the raw IP. Reviews are published under the reviewer's chosen display name. Florida law governs.

Our view: we should not disclose a reviewer's identity without legal process, we should tell the reviewer before we comply where the law allows, and our data minimisation means we have little to produce.

Questions: (a) If a vendor sues a reviewer for defamation and subpoenas us for their identity, what must we produce, and must we notify the reviewer first? (b) Should the Terms or Privacy Policy state that we disclose identity only under legal process and that we notify the user where permitted? (c) Does keeping only a hashed IP create any problem for us as a custodian?

**Answer (Josh Begg, 2026-11-04):**

(a) Produce what you actually hold that is responsive, if the subpoena is valid and not quashed or limited: the email address, account and profile records, the review and its submission records, and the hashed IP in the form you keep it. You cannot produce a raw IP you never stored. As a nonparty you may object and seek a protective order under Fla. R. Civ. P. 1.351, 1.410 and 1.280(c). In unmasking cases, Florida courts applying the Dendrite approach, see Munson v. Scotland, weigh notice to the speaker, the exact statements, a prima facie showing of defamation, and the balance of the plaintiff's need against the First Amendment right to speak anonymously. A lawyer-issued subpoena is not a court finding on that balance. Preserve everything at once. Florida law does not generally make the custodian's own notice a condition of compliance, but give notice where the process does not bar it: it lets the reviewer move to quash before the return date. Check any order for a non-disclosure direction first.
(b) Yes. State in the Privacy Policy, cross-referenced in the Terms, that identifying information is disclosed only in response to legal process, and that you will notify the affected user before disclosure where permitted, in time to object where practicable. That promise binds you, so keep the 'where permitted' qualifier.
(c) Keeping only a hashed IP is not a custodian problem. You produce records in the form kept, and minimisation adopted before any claim is lawful. Once a subpoena or claim is reasonably anticipated, a litigation hold overrides routine deletion and key rotation for relevant records; destroying a key then risks spoliation. While its key survives, a monthly keyed hash is pseudonymous, not anonymous, so produce it under protective order and tell the requesting party early that you hold no raw address.

**What we did:** Legal-process-only disclosure with notice where permitted in the policy and Terms; subpoena runbook with litigation hold on the IP hash key. Text branch 2; AECI-1622. *Written 2026-11-11 (AECI-1622):* `docs/runbooks/legal.md` "Subpoena or legal process for a reviewer's identity". No code switch is needed to freeze the key: month keys are derived from one secret and never stored, so the hold keeps `PAGE_VIEW_IP_HASH_SECRET` unchanged. *Applied 2026-11-18 (legal branch 6, ruling 45):* the Privacy Policy's "Deletion" now says we keep a copy of information the law requires us to preserve, such as after legal process, for as long as that requirement lasts.

### Q26. US-primary posture, and stripping the GDPR-style rights

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc., a Delaware corporation based in Stuart, Florida, operating AEC Integrations, a US directory and review website for construction-industry software. We do not target the EU or UK and have no presence there. We know our revenue and user counts are far below the thresholds of Florida's Digital Bill of Rights and California's CCPA. Florida law governs.

Our Privacy Policy still says: "Subject to applicable law, you have the right to access, correct, delete, restrict, or object to the processing of your personal data, to data portability, and to withdraw consent. You also have the right to lodge a complaint with your local data-protection authority." And in sharing: "where they do, we rely on appropriate safeguards such as the European Commission's standard contractual clauses."

Our view: promising rights Florida does not require creates obligations we could fail to meet on time, and a Florida-only company cannot meaningfully rely on standard contractual clauses. We propose to keep access, correct and delete, and drop restrict, object, portability, the authority complaint and the SCC sentence.

Questions: (a) Do you agree with stripping those four rights and the SCC sentence for a US-primary service? (b) Does offering rights voluntarily and then missing a deadline create exposure under Florida's deceptive-practices act? (c) Is there any US state privacy law that reaches us at our size, and if so which rights must the policy keep?

**Answer (Josh Begg, 2026-11-06):**

Do not use the clause as written. A privacy policy cannot choose away privacy rights by saying US law only. Rights attach based on where the person is and where you collect or target data, not on what your policy says. If the site is accessible to people in the EU or UK and you offer services to them or monitor them, the GDPR can apply even to a US company, and it gives access, correction, deletion, portability, and objection rights. If you have California residents, the California Consumer Privacy Act gives rights to know, delete, correct, and opt out of sale or sharing, regardless of Florida law. Other US states, including Virginia, Colorado, Connecticut, and Texas, have similar rights for their residents. Florida law does not solve this. The Florida Digital Bill of Rights, Fla. Stat. 501.701-501.721, applies only to large controllers meeting high revenue and data thresholds, so it may not apply to WBS, but Florida's Deceptive and Unfair Trade Practices Act, Fla. Stat. 501.204, bars misleading statements, and Florida's breach notice law, Fla. Stat. 501.171, still applies. Keep a US-state rights section, add state-specific addenda where you have users, and either geo-block the EU and UK if you are truly US-only or comply with GDPR for those users. Do not promise no GDPR-style rights while the law may grant them.

**What we did:** Reversed the plan to strip GDPR-style rights; rights section kept, opening softened; keep serving EU and UK visitors (ruling 10); state addenda under AECI-309.

### Q27. Records we keep after a user deletes their account

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. When a vendor representative claims a listing, we record their acceptance of our Vendor Terms with email, time, version, IP address and browser. When someone deletes their account we delete or anonymise their data, except an audit record for abuse prevention, the acceptance record, and the body of any private message they sent to another company (name removed, kept two years after the thread's last message). Florida law governs.

The Privacy Policy says: "We will delete or anonymize the data we hold about you, except where we are required or permitted by law to retain it (for example, a limited audit record kept for abuse prevention, a record that you accepted an agreement on behalf of a company, or a message you sent to another company, with your name removed, until it is deleted 2 years after the thread's last message)."

Our view: each exception is a legitimate interest (contract evidence, abuse prevention, the other company's record) and is disclosed.

Questions: (a) Are these retention exceptions acceptable under US law, including California's deletion right if it ever applied? (b) Is keeping the IP address and browser in the acceptance record after deletion justified, or should those two fields be dropped at deletion while the rest stays? (c) Is the disclosure sufficient as written?

**Answer (Josh Begg, 2026-11-06):**

(a) Yes. Florida has no general deletion right, and its Digital Bill of Rights, Fla. Stat. ss. 501.701-721, applies only to very large controllers, so it likely does not reach a small directory site. The real constraint is your own policy promise, enforced through Fla. Stat. s. 501.204 and FTC Act s. 5 if the policy misleads. If California law ever applied, Cal. Civ. Code s. 1798.105 gives a deletion right but lists exceptions: completing a transaction, security, legal obligations, and internal uses aligned with consumer expectations. Your three exceptions map onto those. One caution: legitimate interest is a GDPR term, not a US test, so do not rely on a balancing test here. Also confirm whether you meet CCPA thresholds at all. One unsettled point: California law also requires telling service providers and third parties to delete, and whether the other company counts as one is not settled.
(b) Drop the IP address and browser at deletion and keep email, time, and version. Those three prove acceptance. IP and browser add little proof value, are personal information under California law, and keeping them undercuts the promise to delete. If you need them for fraud checks, keep them for a short defined period, such as 90 days, then drop them.
(c) Mostly sufficient, but fix three points. State a retention period for the audit record and the acceptance record; right now neither has one, and indefinite retention is hard to defend. Change required or permitted by law, since these retentions are your business purposes, not legal duties, and that wording can mislead. Clarify that the message body stays because it is the other company's record and is deleted 2 years after the thread's last message.

**What we did:** IP and browser dropped from acceptance records 90 days after acceptance (ruling 11, AECI-1636); retention periods stated; 'required or permitted by law' replaced. *Corrected 2026-11-10 (AECI-1615):* this line said "prune built under AECI-1638". No such prune exists. `lib/retention-prune.ts` never touches `agreement_acceptances`, and the 90-day IP and browser removal (AECI-1636) is not built. *Built 2026-11-10 (AECI-1636):* the daily `acceptance-evidence-removal` job (17:00 UTC) nulls both columns on every acceptance more than 90 days old, with one audit row per batch. The row itself is kept (`DATABASE_SCHEMA.md` §8.6d). *Built 2026-11-17 (AECI-1638):* the legal retention prune (`lib/legal-retention-prune.ts`, ADR 0058) now deletes audit rows four years after the action and acceptance records six years after the vendor account ends, or five years after a granted subscription ends if later. A litigation hold placed on `/admin/legal` stops it. Both periods now have an end, which answers (c).

### Q28. Do Not Track, Global Privacy Control, and what runs anyway

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US website. We honor the Do Not Track and Global Privacy Control browser signals as an opt-out of product analytics: no consent banner, no analytics events, no analytics identifier. Three things run for every visitor regardless: anonymous error and performance telemetry, an anonymous visit tally, and a cookieless page-load count by our network provider, Cloudflare. We do not sell or share personal data. Florida law governs.

The Privacy Policy says: "Because we do not sell or share personal data, the statutory scope of the GPC signal does not apply to us in any case; we honor it as an analytics opt-out regardless." And it discloses that the Cloudflare page-load count "runs for every visitor, including when your browser sends Do Not Track or Global Privacy Control."

Our view: GPC's legal meaning is an opt-out of sale and sharing, which we never do; honoring it more broadly is a courtesy; and the three always-on measurements carry no identifier and are outside the signal.

Questions: (a) Is that framing of GPC correct under the state laws that give it legal effect (California, Colorado, Connecticut and others), for a site that may have visitors from those states? (b) Is disclosing the always-on cookieless page-load count as outside the signal sufficient, or does any state treat it as covered? (c) Is the sentence "the statutory scope of the GPC signal does not apply to us" wise to keep, or better removed?

**Answer (Josh Begg, 2026-11-06):**

(a) Largely correct. Under California law, GPC is a legally recognized opt-out of the sale and sharing of personal information, Cal. Civ. Code s. 1798.120 and 11 CCR s. 7025, and covered businesses must honor it. Colorado requires honoring a recognized universal opt-out signal from July 1, 2024, and Connecticut from Jan. 1, 2025, with the same sale and targeted advertising scope. Since you do not sell or share, the signal has no operative effect for you, and honoring it more broadly for analytics is a courtesy. Do Not Track has no legal effect under any state law. One caution: confirm you fall below the CCPA, Colorado and Connecticut thresholds, since a covered business must honor GPC even if it does not sell.
(b) The disclosure is sufficient if the count is truly aggregated with no identifier stored, and no state treats an identifier-free count as a sale or targeted advertising. The risk is the word anonymous: Cloudflare necessarily sees visitor IP addresses, so say the count is aggregated and no identifier is retained, and name Cloudflare as a service provider. Do not call the measurements anonymous unless no IP address is stored anywhere.
(c) Remove it. The sentence reads as a refusal to honor the signal, which is the conduct California penalized in the Sephora settlement and in a 2025 multistate enforcement sweep, and it invites a challenge to your claim that you never sell or share. Say instead: We do not sell or share personal information, and we honor GPC as an opt-out of product analytics.

**What we did:** Removed the sentence that read as refusing GPC; page-load count described as aggregated with Cloudflare named. Text branch 2.

### Q29. Bot checks before consent, for visitors in the EU

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US website that does not target the EU. On public pages our network provider, Cloudflare, runs an invisible bot check (Turnstile) that reads browser signals and stores its own identifier in the visitor's browser; we keep only the outcome. A second provider, Spur, classifies the visitor's network. Both run before any consent banner. We currently do not run the Turnstile check for visitors in the EEA, UK and Switzerland until this question is answered. Florida law governs.

Our view: a security check that stores no identifier we can read is strictly necessary and needs no consent anywhere, but Turnstile's own browser identifier is the uncertain part, and we would rather not maintain a geographic exclusion.

Questions: (a) For a US site that does not target the EU, do we need to treat EU visitors differently at all? (b) If we do, is a bot check that sets a provider-owned identifier "strictly necessary" under the ePrivacy rules so that it may run before consent? (c) Do we need a data-processing agreement with Spur, and with Cloudflare for the bot check, given we receive only an outcome?

**Answer (Alexander Coffin, 2026-11-06):**

Your view mostly holds, but not for the reason the draft gives. (a) Do EU visitors need different treatment? Probably not under the GDPR, but don't count on it. With no EU establishment and no targeting, Article 3(2)(a) doesn't catch you. That leaves 3(2)(b), monitoring behaviour, and a one-off pass/fail bot check isn't really tracking or profiling anyone. The ePrivacy cookie rule is the weaker spot. Article 5(3) is about accessing or storing data on a device located in the EU. Some regulators, the CNIL in particular, read their national cookie laws broadly. Will anyone enforce that against a Florida directory site? Unlikely. Is the exposure zero? No. (b) Is it "strictly necessary"? Whether you can read the identifier yourself doesn't decide it. Who sets it doesn't matter either. EDPB Guidelines 2/2023 make reading browser signals a 5(3) event in its own right, so the "stores no identifier we can read" framing in paragraph 3 should go. What decides it is purpose. Security tools that protect a service the user asked for can fall inside the exemption. The Article 29 Working Party's 2012 opinion and CNIL guidance both point that way, though their clearest examples are things like login and fraud protection. Bot checks on public pages are a reasonable but less settled fit. The real risk is Cloudflare's or Spur's own reuse of the signals, for example to train their detection models. If they do that, the "strictly necessary" argument weakens a lot. Check their terms before you drop the geographic exclusion. (c) Data-processing agreements? Yes, if the GDPR applies. Getting back only a result doesn't change anything, because both providers handle IP addresses and browser data for you, and that makes them processors. Cloudflare's DPA is usually built into its customer terms already, so confirm it covers Turnstile. Spur needs its own check.

**What we did:** EU bot-check exclusion stays until the Cloudflare and Spur reuse check and DPAs are confirmed (AECI-1458, AECI-310).

### Q30. One marketing email to an account holder who works for an unclaimed vendor

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. When someone creates a free account they may tell us they work for a software vendor. If that vendor has not claimed its listing, we plan to send them one email about our vendor program, with an unsubscribe link and our postal address, sent only once per account. Florida law governs.

The Privacy Policy says: "If you tell us in 'About you' that you work for a software vendor and your company has not claimed its listing, we may send you one email about the vendor program. Every such email has an unsubscribe link, and using it stops all marketing email from us."

Our view: this is a commercial email under CAN-SPAM, so it needs truthful headers, an opt-out honored within ten business days, and a physical postal address, all of which we have; no prior consent is required under US law.

Questions: (a) Is our CAN-SPAM analysis right, and is one email with those elements compliant? (b) Does the profile answer "I work for a software vendor" create any consent or expectation issue beyond CAN-SPAM? (c) Should the account sign-up page itself mention this email, or is the policy disclosure enough?

**Answer (Alexander Coffin, 2026-11-06):**

(a) Mostly right, but you've missed one element. CAN-SPAM requires no prior consent, and a B2B email is still covered. You need: truthful headers; a subject line that isn't misleading; a clear statement that the email is an advertisement (required because you don't have affirmative consent); your postal address; an opt-out that works for at least 30 days after sending and is honored within ten business days, at no cost to the recipient. Your list leaves out the ad label. Add it and one email is compliant. Florida's Electronic Mail Communications Act (Fla. Stat. 668.60 et seq.) adds little here. CAN-SPAM preempts most state email law except rules against falsity or deception, so if the email is honest you're fine.
(b) Not a consent issue under US law, but there is an expectation issue, and it's really a promise issue. Your policy says "one email," and the FTC treats broken privacy-policy promises as deceptive under Section 5. So the system has to: actually cap it at one per account, with no "just checking in" follow-up three weeks later; make the unsubscribe stop all marketing email, not just the vendor-program list. A second point is that the profile answer was given to describe the user, not to invite a sales pitch. That's fine legally, but the email shouldn't suggest the person speaks for the company or can claim the listing on its behalf. Lots of people who say "I work for a vendor" are junior staff. And if you have non-US users, this analysis falls apart: Canada's CASL and the EU's GDPR/ePrivacy rules are consent-based.
(c) The policy is legally enough. Practically, I'd add one line next to the "About you" field, something like: "If your company hasn't claimed its listing, we may email you once about our vendor program." That costs you nothing and backs up your Section 5 position. It also cuts down on complaints, since nobody's surprised when the email arrives. Disclosure at the point of collection beats a policy nobody reads.

**What we did:** Nudge email gains an advertisement label and neutral copy; About-you disclosure line; cap and unsubscribe asserted. AECI-1595.

### Q31. Age threshold and children

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US professional website for construction-industry software. Our Terms require users to be at least 18 to create an account or submit content, and the Privacy Policy says the service "is intended for professional use and is not directed at anyone under 18. We do not knowingly collect personal data from children." We do not age-gate. Florida law governs.

Our view: a general-audience professional site has no COPPA duty beyond not knowingly collecting from under-13s, and the 18 line is a terms representation, not an age gate.

Questions: (a) Is that right, and does stating 18 rather than 13 create any obligation to verify? (b) Does Florida's online protections for minors law reach a site like ours? (c) Any wording change?

**Answer (Alexander Coffin, 2026-11-06):**

(a) Mostly right. A general-audience professional site has two COPPA triggers: it's directed to children, or you have actual knowledge that a particular user is under 13. Neither applies to a construction-software directory. Setting the line at 18 doesn't create a duty to verify ages. It's a contract term, not an age gate. One catch, though. Once you say you don't knowingly collect children's data, the FTC can treat that as a promise under Section 5. So if a 12-year-old posts a review and announces their age, you need to delete it. You're not obliged to go looking, but you can't ignore what you learn.
(b) Probably not, but test it against the definition rather than assuming. HB 3 (Fla. Stat. 501.1736) only reaches a "social media platform" that meets several conditions together: users can upload content and see others' content; a usage threshold: at least 10% of daily active users under 16 spend two or more hours a day on it; "addictive" features like infinite scroll or autoplay; algorithmic feeds. A B2B review site with user reviews ticks the first box and fails the rest. Section 501.1737 targets material harmful to minors. Not you. The Florida Digital Bill of Rights has children's provisions too, but its controller thresholds, including roughly $1B in revenue, almost certainly leave you out. These provisions have been challenged in court and amended, so check their current status before you finalize.
(c) Yes, a few small changes: Add a response commitment: "If we learn that we have collected personal data from anyone under 18, we will delete it and close the related account." Then make sure operations will actually do that. Give people a way to report it, like an email address. Make it consistent: the Terms say 18 and so does the Policy, which is good. Just don't anywhere suggest 13 is the line. One mismatch in the draft. The question calls this a "professional website," but you've described it as a directory and review site.

**What we did:** Children section gains the delete-and-close commitment and a report route. Text branch 2.

### Q32. The processors we name, and the agreements we need with them

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Our processors are Cloudflare (hosting, network, bot check, page-load count), Supabase (sign-in), Algolia (search), PostHog (product analytics and logs), Resend (email), Stripe (payments), and Spur (network classification). The Privacy Policy describes them by function, not by name, except Cloudflare and Stripe. Florida law governs.

Our view: naming the function is enough for a US policy, and we need each provider's standard data-processing terms on file but not a negotiated agreement.

Questions: (a) Must a US privacy policy name its processors, or is describing them by function sufficient? (b) Which of these providers do we need a signed data-processing agreement with under US law, as opposed to simply accepting their standard terms? (c) Does receiving only an outcome from a provider (bot check passed or failed, network class) make that provider a processor of personal data at all?

**Answer (Alexander Coffin, 2026-11-06):**

(a) Naming processors. Short answer: describing them by function is enough. No general US privacy law makes you list your vendors by name. CCPA-style laws ask for categories of recipients, and "a search provider" or "an email delivery service" covers that. Naming Cloudflare and Stripe does no harm. Just make sure the function descriptions stay accurate as vendors change.
(b) Signed DPAs. This is where I'd adjust your view a little. US law doesn't require a signed or negotiated agreement. It requires a written contract with specific terms. CCPA service-provider rules and the Virginia, Colorado and Texas processor provisions all list what the contract has to say: limits on purpose, confidentiality, flow-down to subprocessors, deletion, and audit or assistance. A click-through DPA can satisfy that. Cloudflare, Stripe, Supabase, Algolia, PostHog and Resend all publish DPAs that are generally built to meet those lists. So file them, confirm they're actually incorporated into your account terms (some only apply once you opt in), and check them against each statute you're subject to. Florida itself is narrow. The Digital Bill of Rights likely won't reach you, given its roughly $1B revenue threshold. Fla. Stat. 501.171 still expects reasonable security from third-party agents, and a contract is how you show that. Spur is the one to look at closely. Smaller vendors' standard terms sometimes have no DPA at all.
(c) Outcome-only providers. Probably yes, they're still processors. The outcome isn't the issue, the input is. To score a visitor, Cloudflare's bot check and Spur both receive the visitor's IP address, and often browser signals too. State laws generally treat an IP address linked to a device as personal data. Getting back only "pass/fail" or "residential proxy" doesn't change the fact that they processed personal data for you. Treat both as processors.

**What we did:** Processors by function suffices; click-through DPAs filed and incorporation confirmed; bot-check providers named as processors. AECI-310; text branch 2.

### Q33. The Terms of Service have no liability cap

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc., a Delaware corporation based in Stuart, Florida. We operate AEC Integrations, a free public directory and review website for construction-industry software. Readers are US professionals; they pay us nothing. Florida law governs, venue Martin County and the Southern District of Florida.

Our Terms of Service say:

"The service is provided 'as is' and 'as available', without warranties of any kind, express or implied, including warranties of accuracy, merchantability, or fitness for a particular purpose. To the maximum extent permitted by law, the operator is not liable for any indirect, incidental, special, consequential, or punitive damages, or for any decision you make in reliance on the service. Nothing in these terms excludes liability that cannot be excluded under applicable law."

There is no cap on direct damages. Our separate Vendor Terms cap our liability to a vendor at one hundred US dollars, and our paid-plan agreement caps it at twelve months' fees.

Our view: a reader pays nothing, so a direct-damages cap of one hundred US dollars matching the Vendor Terms is reasonable and should be added.

Questions: (a) Should the Terms carry a direct-damages cap, and is one hundred US dollars defensible for a free service? (b) Is the "as is" disclaimer enforceable in Florida in plain text under its own heading, or does it need conspicuous formatting? (c) Any carve-outs you would add?

**Answer (Josh Begg, 2026-11-07):**

(a) Yes, a $100 cap is defensible for a free service. Under Florida law a limitation of liability clause is enforced when it is clear and unambiguous, see Sanislo v. Give Kids the World, 164 So. 3d 1204 (Fla. 2015), and it is read strictly against the party relying on it. A $100 cap on direct damages is proportionate where readers pay nothing, and your existing exclusion of indirect and consequential damages already does much of the work. The weak point is acceptance by use, not the amount. A browsewrap term binds a reader only if the reader had actual or inquiry notice of the terms, so the Terms link must be conspicuous on every page and the cap itself must stand out. A click or express acknowledgment would be stronger.
(b) Yes, carry the same carve-outs. State that the cap covers your liability only and does not apply to your own intellectual property infringement, breach of confidentiality, or gross negligence or willful misconduct. Florida courts will not enforce a clause that excuses gross negligence or willful misconduct, and identical carve-outs across all three documents avoid an argument that the reader terms were meant to be broader than the paid agreement.
(c) Yes, and it matters more here, not less. Under Fla. Stat. sec. 672.316, a disclaimer of the implied warranty of merchantability must mention merchantability and be conspicuous, and a fitness disclaimer must be in writing and conspicuous. Conspicuous means a reasonable person ought to have noticed it, Fla. Stat. sec. 671.201, such as capitals or larger bold type. Put the whole limitation clause in bold and the warranty disclaimer sentence in capitals, where a reader cannot miss them.

**What we did:** $100 reader cap in the Terms, bold, with the same carve-outs. Text branch 3.

### Q34. Changing the Terms by continued use, with no notice to account holders

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Readers may create a free account to write reviews. Florida law governs.

The Terms of Service say:

"We may update these terms from time to time. Material changes are versioned and dated; the current version and its effective date are shown at the top of this page, and every version is listed under Change history at the end of this page, with a link to the full text of each earlier version. Your continued use of the service after an update constitutes acceptance of the revised terms."

Our Vendor Terms, by contrast, email every vendor seat 30 days before a change. Our Privacy Policy will say that a material change is announced by a notice on every page of the site for 30 days before it takes effect.

Our view: for a free reader account, a dated version with a public change history and a 30-day site notice is enough; an email to every account holder is not needed.

Questions: (a) Is "continued use constitutes acceptance" enforceable against an existing account holder in Florida and the Eleventh Circuit without direct notice? (b) Would adding the same 30-day site notice to the Terms cure it, or is email required for material changes? (c) Should the Terms require a fresh click-to-accept on the next sign-in after a material change?

**Answer (Alexander Coffin, 2026-11-06):**

Your view is too thin, mostly because of who the notice actually reaches. (a) A 30-day banner only reaches people who visit during those 30 days. An account holder who logs in on day 45 never saw it, and "continued use" gets weak when there was no real notice to continue past. Courts applying Florida law generally look for actual or reasonably conspicuous notice before enforcing browsewrap-style terms, and unilateral changes by posting alone get treated with suspicion. You already have their email addresses, so emailing is cheap and it fixes the problem. I'd send one for every material change. One more thing: right now the 30-day promise is in the Privacy Policy, not the Terms. Move it into the Terms so the change mechanism sits in one document. (b) Yes, but only for changes that cut back a reader's rights. The liability cap is the obvious one, and the same goes for any arbitration clause, class waiver or new venue clause. Put those behind a click at the next sign-in. Anyone who never signs in again is just a visitor, and the old terms keep applying to them. Pure clarifications don't need a click. Also make adverse changes prospective only. A new cap shouldn't reach a claim that already exists. That's a separate fight, and you'd likely lose it. (c) I think this is the wrong statute for the question. Section 668.50 is Florida's UETA. It gives electronic records and signatures legal effect and covers retaining them. It doesn't decide whether anyone assented. The archive shows what each version said, which helps, but it doesn't show that a given reader agreed to it. Your colleague got this right on the vendor side: log the click, the version and the timestamp for each user. That log, together with the archive, is what proves assent.

**What we did:** Email every account holder before a material change and a click at next sign-in for rights-reducing changes (ruling 12, AECI-1637); 30-day notice promise moved into the Terms. Text branch 2. Built 2026-11-13 (AECI-1637). The email goes to every account holder before a material change. Chris ruled on 2026-11-13 that signing in is the acceptance (ruling 43). The sign-in page always shows "By signing in, you agree to our Terms of Service and Privacy Policy.", with both names linked. Each sign-in logs the user, email, version, time, that line's exact text, the IP address and the browser for the Terms version in force, once per version. The line alone did not bind a reader to a rights-reducing version. Counsel answered that as Q63, and ruling 53 narrowed ruling 43: that version needs a ticked box at the first sign-in after it. Nothing else is blocked.

### Q35. Confirming no arbitration and no class-action waiver

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations. In 2026 we decided not to include an arbitration clause or a class-action waiver in any of our documents, because our readers are professionals who use a free service and our vendors are businesses, and because we believe the clause would read as hostile. Our disputes clause names Florida law and Martin County and the Southern District of Florida courts. Florida law governs.

We are not asking you to recommend arbitration. We are asking you to confirm the consequences of leaving it out.

Questions: (a) For a free consumer-facing review website, what exposure does the absence of a class-action waiver create in practice? (b) Does anything else in the Disputes section need strengthening as a result, such as a notice-and-cure step before suit? (c) Is "except where applicable consumer law provides otherwise" the right savings clause, or should it name the reader's home state?

**Answer (Alexander Coffin, 2026-11-06):**

(a) Exposure. On a free review site, a class action usually doesn't come from a contract claim. It comes from statutes with fixed per-violation damages: TCPA texts, wiretap and session-replay claims under Fla. Stat. ch. 934, VPPA-style pixel theories, and ADA website accessibility suits. Without a waiver, small statutory damages multiplied across every user is the risk. That's your real exposure, and it's a compliance problem more than a drafting one. A notice-and-cure step is worth adding, say 30 days' written notice and a chance to resolve before suit. Courts won't let it block a statutory claim, but it does weed out some demand letters. One caution: don't try to shorten limitation periods. Fla. Stat. 95.03 voids contract terms that do. A jury waiver is an option to consider, and Florida generally enforces conspicuous ones. (b) Savings clause. It works for the ToS. It's vague, but harmless, and it avoids an all-or-nothing fight if some state's consumer law overrides venue. In the two B2B contracts, drop it. It invites a business counterparty to argue some consumer statute applies, and that's an argument you'd be handing them for nothing. (c) Mandatory and exclusive? Probably not, and this is the real problem. Florida courts read a forum clause as permissive unless it has words of exclusivity. Fix it with something like: "...shall be brought exclusively in the state courts in Martin County, Florida, or the United States District Court for the Southern District of Florida..., and you waive any objection to venue there..."

**What we did:** Notice-and-cure before suit; exclusive forum wording with venue waiver; savings clause kept in the Terms, dropped from the two contracts; mutual jury waiver in the two contracts only (ruling 13). Text branches 2 and 3.

### Q36. Private messages between two companies: the privacy disclosures

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory of software integrations. We may let the two vendors on an integration exchange private messages. We can read them. They are kept for two years after the thread's last message; if the author deletes their account the body stays and the name is removed. The feature is built but switched off. Florida law governs.

The Privacy Policy lists "Messages to other companies: what you write, with the time you sent it and your seat. We also keep a record of when you read a thread", says "a message you send in a private thread is shared with the other company on that integration and is visible to us. It is not public", and the deletion sentence above.

Our view: three disclosures (collected, shared with the other company and visible to us, retained two years with name removed on deletion) are what a US reader needs.

Questions: (a) Are those three disclosures sufficient? (b) Does Florida's two-party consent statute (Fla. Stat. 934.03) have any bearing on our reading stored messages on our own platform, given the disclosure? (c) Should read receipts be disclosed as personal data of the reader?

**Answer (Alexander Coffin, 2026-11-06):**

Mostly there, but each of the three disclosures has a gap. (a) Are they sufficient? The basics are covered: what you collect, who sees it, and what happens on deletion. The California part is the issue. The CCPA's exemption for business-to-business data ended on January 1, 2023, so a California employee writing on behalf of a vendor counts as a "consumer." If you meet a CCPA threshold, the notice has to give the purposes and the retention period for each category of data. Do the threshold check first (revenue, 100,000+ consumers, or revenue from selling or sharing data). Even if you fall below it, the FTC Act and FDUTPA still punish statements that turn out to be inaccurate. So "visible to us" should become "we can read it," and you should say when you do. "Not public" also needs a carve-out for legal process and law enforcement requests. (b) Purposes and backups? Yes to both. The purposes do real work here, because the other company's record, dispute resolution, and abuse review are what justify keeping a message after the author deletes their account. Without them the "exception" has no stated basis. On backups, you don't need detail specific to each thread. You do need a ceiling, something like "deleted data remains in backups for up to [X] days and is then overwritten." Otherwise "2 years" is quietly wrong, because the real number is 2 years plus however long backups run. Check with engineering before you pick X. (c) Read receipts? They are the reader's personal data, so yes, disclose them. "We keep a record of when you read a thread" isn't enough on its own. Three things are missing: Who sees it. If the other company can see that a thread was read, that is a disclosure to a third party and it belongs in the sharing section. How long it's kept. Say whether it's on the same 2-year clock or a different one. What happens on deletion. Say whether the receipt is deleted or kept with the reader's name removed, like the message body.

**What we did:** 'We can read it' and when; legal-process carve-out; purposes; 30-day backup ceiling; read-record handling. Text branches 2 and 3; AECI-1616.

### Q37. A first-party browser report that a page view was a person, under ePrivacy Article 5(3)

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. We do not target the EU or UK, but visitors from there reach the site. You advised us on Q29 that reading browser signals is an Article 5(3) event under EDPB Guidelines 2/2023, that purpose decides the strictly-necessary exemption, and that our third-party bot check should stay switched off for EEA, UK and Swiss visitors until we confirm the providers do not reuse the signals.

We want to add a first-party signal to our own visit count, which already runs without consent and honors Do Not Track and Global Privacy Control as an opt-out. Our own page script would send one word to our own server once per page load: "ran" when the script executed, or "interacted" when the visitor scrolled, clicked, tapped or pressed a key. It sends nothing else: not what was clicked, not what was typed, no coordinates, no timings. Nothing is written to or read from the device except the page's own navigation timing entry, which our server put there, to recover the request's own Cloudflare Ray ID so the report can be matched to the visit row. That Ray ID is generated per request, is never written to the browser, and is never compared across visits. Nothing goes to a third party. Visitors who send Do Not Track or Global Privacy Control send nothing. The purpose is to count how many daily visits were people rather than programs, as a floor beside the total. The privacy policy would name both facts as a yes or no.

What is sent and stored:

| Item | Sent by the browser | Stored | Never |
|---|---|---|---|
| The page load's own Ray ID | Yes, read from the navigation timing entry | Already on the visit row | Written to the browser; linked across visits |
| One word, "ran" or "interacted" | Yes | One column on the visit row | What was clicked, typed, scroll depth, coordinates, timing |
| IP address | Implicit in the request | No | |
| Anything for Do Not Track or GPC visitors | Nothing | Nothing | |

Our view: this is first-party audience measurement with no identifier and no cross-site linkage, the case several EU regulators, the CNIL in particular, allow without consent, so it can run everywhere; and the per-request Ray ID is not an identifier of the visitor under any state law because it is not persistent.

Questions: (a) Does reading the page's own navigation timing entry and listening for an input event fall within Article 5(3), and if so does a first-party audience-measurement exemption cover it on these facts, or must it carry the same EEA, UK and Swiss hold as the third-party bot check? (b) Is the per-request Ray ID a "unique identifier" or personal information under California or other US state law, given it is not persistent and never stored in the browser? (c) Is the proposed privacy sentence enough: "For visitors who do not send Do Not Track or Global Privacy Control, the tally also records whether our page script ran and whether the page was scrolled, clicked or typed in, as a yes or no only, never which key or what was clicked"?

**Answer (Alexander Coffin, 2026-11-11):**

Yes, it's an Article 5(3) event. The audience-measurement exemption is real, but it's not EU-wide. Is it in scope? I think so, and I don't think it's close. EDPB Guidelines 2/2023 treat a script that runs on the device and reports information back as "gaining access." That covers information the device generates, like an input event, and arguably information your server put there, like the navigation timing entry. Sending only one word doesn't take it out of scope. It just makes the intrusion small. Your purpose is to count how many daily visits were people rather than programs, and that goes to the exemption question, not to scope. The exemption. This is where your view goes too far. The Directive itself has only two exemptions: transmission, and what's strictly necessary for a service the user requested. "Audience measurement" isn't one of them. The CNIL reads it into "strictly necessary" under French law, with conditions: measurement is the only purpose, output is anonymous and aggregated, nothing is linked across sites, and users get notice and an opt-out. Your design probably meets all of that. But that's France. The EDPB guidelines don't endorse a general carve-out, and Germany's §25 TDDDG is read narrowly. So "it can run everywhere" overstates it. UK and Switzerland. These are friendlier. The Data (Use and Access) Act 2025 adds a PECR exemption for statistical analytics used to improve your own service, as long as you give clear information and an easy way to object. Check that the provision has commenced. Switzerland's Article 45c FMG is already an inform-and-refuse regime, so your notice plus the Do Not Track and Global Privacy Control opt-out likely works.

**What we did:** The plan became epic AECI-1711. On 2026-11-13, with Chris's approval, AECI-1712 put this sentence into the Privacy Policy 1.1 draft: "If your browser sends neither signal, our record of your visit also notes whether our page script ran and whether the page was scrolled, clicked or typed in, as a yes or no only, never which key or what was clicked. We do not collect this for visitors in the European Economic Area, the United Kingdom or Switzerland." AECI-1714 builds the EEA, UK and Swiss hold into the browser gate. Production capture waits until 1.1 is in force (AECI-1715). The browser report is an Article 5(3) event with no EU-wide exemption, so it cannot run in the EEA without consent. Where it runs is ruling 21: the same EEA, UK and Switzerland hold as the bot check. The privacy sentence ships with Phase 1 of the human-traffic floor plan. The answer does not reach (b) the Ray ID or (c) the sentence. Both are re-asked as Q43, answered on 2026-11-11.

### Q38. The DMCA copyright-complaints section

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. Readers post reviews, and vendors upload logos, screenshots and text. We registered a DMCA designated agent with the Copyright Office (DMCA-1084399, October 2026). Our Terms of Service carry this section, which we have never had reviewed:

**Copyright complaints**

We respond to notices of claimed copyright infringement under the Digital Millennium Copyright Act (DMCA). If you believe content on the service infringes your copyright, send a notice to our designated agent:

Copyright Agent, The WBS Project, Inc.
315 SE Saint Lucie Blvd, Stuart, FL 34996, USA
[copyright@thewbsproject.com](mailto:copyright@thewbsproject.com)

Our designated agent is registered with the U.S. Copyright Office DMCA Designated Agent Directory.

Your notice must identify the copyrighted work, identify the content you say infringes it and where it is on the service, give your contact details, state that you have a good-faith belief the use is not authorized, state under penalty of perjury that the information is accurate and that you are the owner or authorized to act for the owner, and carry your physical or electronic signature. We may remove or disable access to the content and tell the person who submitted it.

If your content was removed and you believe it was removed by mistake, you may send a counter-notice to the same address. It must identify the removed content, state under penalty of perjury that you have a good-faith belief it was removed by mistake or misidentification, give your contact details, consent to the jurisdiction of the United States District Court for the Southern District of Florida (or, if you are outside the United States, any judicial district in which we may be found), state that you will accept service of process from the person who sent the notice, and carry your signature. We may restore the content after 10 business days unless that person tells us they have filed a court action. We may end the accounts of repeat infringers.

Our view: the section states the notice elements, the counter-notice elements with consent to the Southern District of Florida, the 10-business-day restore window, and a repeat-infringer line, which is what Section 512(c) and (g) require for the safe harbor.

Questions: (a) Does this section, with the registration, give us the Section 512 safe harbor for user reviews and vendor uploads, or is anything missing? (b) Is "We may end the accounts of repeat infringers" enough, or must we adopt and state a repeat-infringer policy with a threshold? (c) Vendor-uploaded logos are the vendor's own marks, and a complaint about them is more often trademark than copyright. Should the section say that trademark complaints go through the Listing Accuracy Policy route instead, and does a logo complaint from the mark's owner ever need the DMCA process?

**Answer (Brian D. Lerner, 2026-11-10):**

The section has three defects. The counter-notice must consent to the federal district of the user's address, not the Southern District of Florida. After forwarding the counter-notice to the complainant, you must restore the content within 10 to 14 business days, not merely "may." And change "tell the person" to "will promptly notify." For repeat infringers, no threshold is required, but you must adopt and actually enforce a policy: say you "will terminate repeat infringers in appropriate circumstances" and log notices. Trademark complaints can go through Listing Accuracy, but a logo may also be copyrighted artwork, so accept DMCA notices for logos too. Renew the agent registration every three years.

**What we did:** Text items 13.1 to 13.4 on AECI-1363, for legal branch 5: 'will promptly notify', counter-notice consent to the user's own district, mandatory restore between 10 and 14 business days, a stated repeat-infringer policy, and DMCA notices accepted for logos. The agent renewal (2029-10-28) is in the legal README. Legal branch 5 applied the items on November 12, 2026, in place and without a bump. AECI-1665 built the notice log on November 17, 2026. Every notice and counter-notice is a row in `dmca_notices`, worked on `/admin/dmca`. A counter-notice shows its restore window, business day 10 to business day 14 after receipt, and whether it is overdue. Each account's takedown count shows on `/admin/users/:id` for the repeat-infringer review. There is no fixed threshold. The decision is recorded in the notice's notes and in a Linear issue (ruling 44). The steps are in `docs/runbooks/legal.md` "Copyright notice or counter-notice". The log is new personal data, so the Privacy Policy v1.1 draft gained a collection line, a retention line and a deletion line. The retention period is an open question below.

### Q39. Five clauses assembled from your colleagues' answers, as they now read

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. Over the past week your colleagues answered questions on our Managed Plan Agreement and Vendor Terms. We assembled their points into the clauses below, which are now live as drafts. We are asking for a defect check on the wording as written, not for new advice on the positions.

Managed Plan Agreement, Limit of liability:

**Our total liability under this agreement is limited to the greater of the fees you paid for the Managed subscription for the product to which the claim relates in the twelve months before the claim arose, or one hundred US dollars. For a claim not tied to one product, the base is all fees you paid under this agreement in that period. We are not liable to you for lost profits, lost business, or any indirect or consequential loss, even if we were told it was possible.**
**Neither the cap nor the exclusion of lost profits or indirect or consequential loss in this section applies to the claims listed below, and that exclusion applies only to claims against us. The claims are: your obligation to pay fees; your indemnity under the [Vendor Terms](/legal/vendor-terms); our infringement of your intellectual property; our breach of confidentiality; our gross negligence or willful misconduct; and any liability that cannot be limited under applicable law.**

Managed Plan Agreement, Suspension and non-payment (first two paragraphs):

If we reasonably believe you have broken the acceptable-use rules in the [Terms of Service](/legal/terms), or the Truthfulness section of the [Vendor Terms](/legal/vendor-terms), we may suspend every seat and all editing at once, without prior notice, to protect the listing. We then write to you naming the rule and the evidence. You have 7 business days from receiving that notice to fix a breach that can be fixed, or to show us we are wrong. If you do not, or if the breach cannot be fixed, we end your subscriptions and cancel your billing.
When we end your subscriptions this way, we refund the unused part of the term, less the fees for the period you used and our documented cost of the abuse: staff time at $150 an hour, logged by task at the time, and costs we paid to others such as chargeback fees and claims from third parties, in each case only where the breach caused them. We credit anything we recover from elsewhere. That cost is never more than the refund due, and we send you an itemized statement with the refund. A false claim cannot be fixed. If the first 7 business days do not resolve a false-claim finding, you have a further 7 business days to prove your identity and authority before we keep anything. When your subscriptions end you lose the edit right, and we may correct or remove the fields you maintained. You keep ownership of what you wrote.

Managed Plan Agreement, General terms, precedence:

We read them together first. Only where they directly conflict on the same subject does this agreement win for subscriptions and billing, then the Vendor Terms, then the Terms of Service. Nothing in this agreement overrides the content license, intellectual property, disclaimers, liability limits, indemnity, governing law or disputes sections of the other two documents. The Listing Accuracy Policy and the Review Guidelines rank below the document that incorporates them. Where a grant we record has its own written deal, that deal wins on price and term for those subscriptions.

Vendor Terms, Disputes (including the jury waiver):

If you have a problem with us, contact us first at the address below. Most issues are resolved this way.
These terms are governed by the laws of the State of Florida, without regard to its conflict-of-laws rules. Any dispute arising from these terms or the service shall be brought exclusively in the state courts in Martin County, Florida, or in the United States District Court for the Southern District of Florida where that court has jurisdiction. You consent to that jurisdiction and venue and waive any objection to venue there.
**Each of us gives up any right to a jury trial in any court action about these terms or the service. A judge decides the case.**

Questions: (a) Any sentence in these five clauses that a vendor's counsel would read against us, or that is ambiguous? (b) Is the jury waiver conspicuous and mutual enough as written to be enforced in Florida? (c) Does the suspension clause's "reasonably believe" standard for the suspension, with the evidence named in the notice, hold together with the pro-rata refund and the capped cost deduction?

**Answer (Travis Russell, 2026-11-11):**

Overall, the five clauses hang together, but a few spots could be read against you.

Liability cap: the line saying the exclusion applies "only to claims against us" clashes with carve-outs that list the customer's own obligations, like fees and indemnity. Florida courts read unclear wording against the drafter, and a vendor's counsel may argue the cap is one-sided or unclear. Decide whether the cap and lost-profits exclusion are mutual or vendor-only, and say so plainly.

Jury waiver: Florida generally enforces contractual jury waivers between businesses when made knowingly and voluntarily. Courts look at how visible the clause is and the parties' bargaining power. A bold, plain-language, mutual waiver is a good start. One caution: it binds only someone who actually agreed to the document containing it, and yours is in the Vendor Terms. Make sure each customer clearly accepts the Vendor Terms, such as a checkbox at signup, and consider a separate heading or acknowledgment where they accept.

Suspension and refund: a "reasonable belief" standard with immediate suspension is common. Florida reads a duty of good faith into contracts, so your notice, evidence, and cure period help. The staff-time deduction is the likeliest target. Tying it to logged time and actual breach-caused costs, capped at the refund, helps it look like real damages rather than a penalty. Also say whether these deductions count against the liability cap.

Precedence and venue: "read together first" is sound, but the list of sections the Managed Plan Agreement can't override may overlap its own billing and refund terms. Exclusive Martin County or Southern District of Florida venue is generally enforceable between businesses.

For a line-by-line review, consider a consultation with a Florida contracts attorney.

This is general legal information and does not create an attorney-client relationship.

**What we did:** Text items 13.6 to 13.11 on AECI-1363, for legal branch 5: the liability clauses in all three documents say in plain words that they limit what we can owe and not what the vendor owes; the jury paragraph is labelled; the refund deduction is stated as outside our cap and credited against the vendor's indemnity; the precedence sentence names refunds and suspension. Rulings 18 to 20 are open. Legal branch 5 applied the items on November 12, 2026. The Vendor Terms items went into a new version 1.3, because production held two 1.2 acceptances.

### Q40. Website accessibility exposure

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. The site is free to readers. We test every interface change with the axe-core accessibility checker against the WCAG 2.1 AA standard, we run a manual keyboard and screen-reader checklist, and we fix every error and serious finding before shipping. We have no accessibility statement page. Your colleague noted on Q35 that ADA website-accessibility suits are the most likely class exposure for a free review site.

Our view: WCAG 2.1 AA is the right standard to hold ourselves to, a public accessibility statement helps show good faith, and a demand letter should get a prompt, specific response rather than silence.

Questions: (a) Does the ADA reach a US website with no physical place of business, and does Florida add anything? (b) Is WCAG 2.1 AA the standard courts and the Department of Justice apply, and does a published accessibility statement with a contact route reduce exposure or create a promise we could breach? (c) What should the first response to an accessibility demand letter contain, and within what time?

**Answer (Alexander Coffin, 2026-11-11):**

(a) Does the ADA reach you? In Florida, probably not on a website-only theory. The Eleventh Circuit that a website isn't a "place of public accommodation" under Title III. That opinion was later vacated as moot, so it isn't binding precedent. It still signals how the circuit reads the statute, and the nexus-to-a-physical-store line from Haynes v. Dunkin' Donuts helps you, since you have no store. The catch is that plaintiffs pick their forum. SDNY and some other courts have let standalone-website claims go forward. You're national and free to readers, so you can be sued wherever a reader lives. Florida doesn't add a private website-accessibility claim that I'd worry about. (b) Is WCAG 2.1 AA the standard? It's the de facto benchmark. DOJ's 2024 rule adopted it, but only for state and local governments under Title II. No Title III private-sector regulation exists. Courts and settlements use 2.1 AA anyway, so you're aiming at the right target. One caution: axe only catches a minority of real barriers, which is why your manual screen-reader pass matters. Keep records of both. The statement helps, as long as it's worded as aspiration and process. Say "we aim to conform" and "we test each release." Never write "fully compliant." Add a contact route and a response window you can actually meet. Then honor that window every time, because a missed self-imposed deadline makes great exhibit material. (c) The first response to a demand letter. No statute sets a deadline. Answer within the letter's stated deadline, and if it doesn't give one, within about 14 days. Before you write, notify your insurer, since CGL or cyber policies may require prompt notice, and send an internal hold notice to preserve documents.

**What we did:** No change to the legal documents. AECI-1673 builds a public accessibility statement worded as aim and process, with a contact route and a reply window. Ruling 22 set the window at 10 business days, and the page is built at `/accessibility` (`docs/STAGE_1_SPEC.md` §27.6). It stays hidden until AECI-1687 runs the first real VoiceOver and NVDA pass, because the page says we run a screen-reader checklist. AECI-1674 writes the demand-letter runbook: insurer first, hold notice, reply by the letter's deadline or within 14 days. The answer does not say what the reply should contain. We did not re-ask, because the runbook step is to retain an attorney before replying. *Written 2026-11-11:* `docs/runbooks/legal.md` "Accessibility demand letter". No insurer exists yet (Chris, 2026-11-11).

### Q41. Breach notification obligations, and the one 1.1 acceptor

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. We hold: account email addresses, optional profile answers (role, company, LinkedIn link), vendor claim records (name, title, work email, the company's legal name, and for 90 days the IP address and browser), reviews, and a monthly keyed hash of visitor IP addresses. We hold no card numbers (Stripe does), no government identifiers, no passwords (sign-in is by emailed link or Google). Your colleague cited Fla. Stat. 501.171 twice.

Our view: under 501.171 a breach of email addresses alone is not a breach of "personal information", so most of what we hold is outside the statute, but we want a plan written before we need it.

Questions: (a) Which of the data we hold counts as personal information under Fla. Stat. 501.171, and under the other state breach laws that could reach a non-resident's data? (b) If a breach occurs, who must be told, in what order, and within what time, and what must the notice contain? (c) Separately: one vendor accepted our Vendor Terms version 1.1 on November 5, 2026. We published 1.2 on November 9 with changes that narrow nothing against that vendor. Is it enough that 1.2 binds them only after the 30-day change email our terms promise, or is anything else owed to a vendor that accepted an earlier draft?

**Answer (Alexander Coffin, 2026-11-11):**

(a) What counts. Short version: you're mostly right. Under 501.171, "personal information" means a first name or initial plus last name, combined with an SSN, a driver's license or ID number, a financial account number with its access code, medical information, or health insurance information. The other branch is a username or email address combined with a password or security question and answer that would allow access to an online account. None of what you hold fits the first branch. Vendor claim records are names and work emails, and nothing more sensitive is attached. The one wrinkle is your emailed sign-in links. If an attacker gets live magic-link tokens or stored Google OAuth tokens along with the email addresses, that starts to look like the "credentials permitting access" branch. Treat that scenario as notifiable, and make sure those tokens expire fast. IP addresses and keyed hashes aren't covered by Florida's law or any other state breach law I know of. Other states like California, follow the same email-plus-credential model, and their extra categories, like biometrics, don't match your data. Each state's law follows where the affected person lives, not where you are. (b) Who, when, what.

Notify affected individuals as fast as practicable, and no later than 30 days after you determine a breach happened or have reason to believe one did. If 500 or more Floridians are affected, notify the Florida Department of Legal Affairs within the same 30 days. You can get 15 more days if you give the Department good cause in writing. If more than 1,000 people are affected, notify the consumer reporting agencies too. Under the Florida statute, the individual notice must include the date or estimated date range of the breach, what information was involved, and how to contact you. Your vendors (hosting, email) must tell you within 10 days. Add a quick check of the residence-state rules, since some have shorter deadlines.

**What we did:** No change to the Privacy Policy. AECI-1674 writes the breach runbook and records three checks: the production sign-in link lifetime, whether Google tokens are stored, and the 10-day breach-notice term in each processor agreement (AECI-310). The answer does not reach (c) the one 1.1 acceptor. That part is re-asked as Q42, widened to all six vendors who accepted a draft, answered on 2026-11-11. *Written 2026-11-11:* `docs/runbooks/legal.md` "Data breach (Fla. Stat. 501.171)", with the three checks recorded there. Six of ten processor agreements promise only "without undue delay", with no deadline, listed on AECI-310.

### Q42. Moving vendors who accepted a draft version onto the final Vendor Terms

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

A vendor claims its company listing by ticking a required box that reads: "I have read and accept the Vendor Terms on behalf of the company named above, and I am authorized to bind that company." We record the person, the time and the version number accepted. Every version so far has carried a banner that says it is a draft, pending legal review and not yet in force. Six vendors accepted while that banner was showing: five accepted version 1.0, and one accepted version 1.1 on November 5, 2026. Version 1.2 replaced 1.1 on November 7, 2026. Nobody has accepted 1.2. None of the six pays us anything. The changes from 1.0 to 1.2 followed your colleagues' advice: a capped indemnity, a liability limit in bold, exclusive Florida venue, and a mutual jury-trial waiver.

We plan to give the final version an effective date, then email all six. Every version has promised a 30-day email and has said that continued use binds. The current wording is:

"When we change these terms, we email every seat at the company and the billing email at least 30 days before the new version takes effect, unless the change is required by law or fixes an error, in which case it may take effect sooner. The email names the version and its effective date, summarizes every material change, links the archived text, and attaches a copy you can save. If you keep using the portal after the effective date, the new version applies to you. If you do not agree, give up your claim before that date."

Our view: the 30-day email followed by continued use binds the six vendors to the final version, and nothing else is owed to them.

Question: is that enough to bind a vendor who accepted a draft version to the final version, including its jury-trial waiver and exclusive venue, or must each of the six tick the acceptance box again at their next sign-in?

**Answer (Alexander Coffin, 2026-11-11):**

No. Have each of the six tick the box again at their next sign-in. Your plan assumes there's already a contract you can amend, and I'm not sure there is. Every version these vendors accepted said it was a draft, pending legal review and "not yet in force." So what did they actually agree to? Arguably a document that told them, in its own banner, that it didn't bind anyone yet. That cuts against mutual assent. And the 30-day change clause lives inside that same draft. If the draft never took effect, the amendment mechanism didn't either. You'd be using a clause that may not exist to pull vendors into terms they've never seen. Then there's what you're adding. A jury-trial waiver isn't ordinary boilerplate. Florida courts enforce these waivers, but they look for a knowing and voluntary relinquishment and read them narrowly against the party relying on them. "We emailed you and you kept logging in" is a weak record for that, especially for something you've only just added. Exclusive venue is easier to enforce, but it has the same assent problem underneath. Your email process is good, honestly: it's specific, archived, and summarizes the changes. That's a solid way to handle changes once a live contract exists. It just shouldn't be what forms the contract in the first place.

**What we did:** Our view was wrong. A vendor who accepted a draft is not moved to the final version by the 30-day email. AECI-1677 builds an acceptance screen in the vendor portal at next sign-in, and it gates the effective date. It covers every acceptance made while the draft banner shows, not only the six. Rulings 24 and 25 set the rules, and text item 13.12 adds one sentence to the change clause. Legal branch 5 applied it in Vendor Terms 1.3 on November 12, 2026. Two more claims accepted Vendor Terms 1.2 on November 11, 2026, so the screen now covers eight draft acceptances, not six. AECI-1677 built the screen on November 12, 2026. A version counts as in force only from its effective day, and the draft versions can never be in force, so every draft acceptance is asked again once the final version takes effect.

### Q43. Is one privacy sentence enough for a yes-or-no browser report, under US state privacy law

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Florida law governs. This is one question about US law only. Your colleague answered the European side on November 11, 2026, and the report described here will not run for visitors in the European Economic Area, the United Kingdom or Switzerland.

We keep our own count of page visits. We want to add one fact to it. Our own page script would send one word to our own server once per page load: "ran" when the script executed, or "interacted" when the visitor scrolled, clicked, tapped or pressed a key. It sends nothing else: not what was clicked, not what was typed, no coordinates, no timings. Nothing is stored in the browser. Nothing goes to a third party. Visitors who send Do Not Track or Global Privacy Control send nothing.

To match the word to the right visit, the script also sends that page load's Cloudflare Ray ID. A Ray ID is a random label our network provider gives each single request. A new one is made for every page load. It is never stored in the browser and never compared across visits. We do not sell or share data, and we believe we are below the California Consumer Privacy Act thresholds.

The Privacy Policy would gain this sentence in its paragraph on our visit count:

"For visitors who do not send Do Not Track or Global Privacy Control, the tally also records whether our page script ran and whether the page was scrolled, clicked or typed in, as a yes or no only, never which key or what was clicked."

Our view: a Ray ID that lasts one request is not a "unique identifier" or personal information under California or any other US state privacy law, so the sentence above is all the disclosure US law requires.

Question: is that sentence sufficient disclosure under US federal and state law for this report, or does the per-request Ray ID make it personal information that needs anything more?

**Answer (Alexander Coffin, 2026-11-11):**

The sentence is probably enough. But I think your reasoning is aimed at the wrong thing. The Ray ID on its own is fine. The California Consumer Privacy Act (CCPA) definition of "unique identifier" is about persistent identifiers that recognize a consumer or device over time and across services. A label that's created for one request and never stored or compared isn't that. So I'd agree it isn't, by itself, personal information. What it does, though, is attach the "ran" or "interacted" word to the visit record. So what's actually in that record? If your visit count keeps IP addresses, user agents or anything similar, even briefly, then the new fact becomes part of a record that probably is personal information under the CCPA and the newer state laws. In that case the Ray ID isn't the problem. The join is. If the count is truly aggregate, with no IPs kept, then you're clean.

**What we did:** The plan became epic AECI-1711. On 2026-11-13, with Chris's approval, AECI-1712 put this sentence into the Privacy Policy 1.1 draft: "If your browser sends neither signal, our record of your visit also notes whether our page script ran and whether the page was scrolled, clicked or typed in, as a yes or no only, never which key or what was clicked. We do not collect this for visitors in the European Economic Area, the United Kingdom or Switzerland." AECI-1714 builds the EEA, UK and Swiss hold into the browser gate. Production capture waits until 1.1 is in force (AECI-1715). The Ray ID is fine and the sentence is probably enough. The visit record for a visitor who sends no privacy signal is not aggregate: it holds a user-agent hash and network details, and links to the request log's keyed IP hash. So the Phase 1 sentence attaches to 'our record of the visit', not to 'the tally'. No change to the live Privacy Policy.

Q44 to Q60 are batch 4, asked on 2026-11-13 about two planned features: the Enhanced profile and the saved software list. Only the answered ones are recorded here. Q49 came back on 2026-11-16 with an answer to a different customer's tax question, so it is not recorded. Chris replied in that conversation and the real answer arrived on 2026-11-17. The attorney's opening and closing lines about live consultations are left out.

### Q44. Is a paid, richer vendor profile advertising that needs a label

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Every product has a free listing. We plan a paid plan that lets a vendor add its own marketing material to its own product page: screenshots, one video, customer quotes, a list of capabilities, a product FAQ and a pricing summary. The plan never changes where a listing appears in search or in any list. A page with these blocks will look fuller than a free page, and the vendor paid for that.

Each block carries a small caption, "Maintained by {Vendor}". Customer quotes carry "Customer quote supplied by {Vendor}". Our methodology page would say that vendors on a paid plan may add media and that we do not check it. No block says "Ad", "Sponsored" or "Paid".

Our public ranking page says:

"No plan, at any price, changes a listing's position in search or in any list. There is no sponsored placement and no promoted tier."

Our view: this is the vendor's own content about its own product, on its own listing, labelled as supplied by the vendor. It is not advertising dressed as editorial content under Section 5 of the FTC Act or the FTC's native advertising policy, so the caption is enough and no "paid" label is needed.

Question: is "Maintained by {Vendor}" enough, or must a paid block or a paid page carry a plainer label that says the vendor paid for it, and if so what wording?

**Answer (Alexander Coffin, 2026-11-16):**

I think your view mostly holds up, but I'd tighten two things before launch. The FTC test asks whether consumers are misled about an ad's "nature or source." The rule is that the Commission will find an advertisement deceptive if the ad misleads reasonable consumers as to its nature or source, including that a party other than the sponsoring advertiser is its source. Your blocks name the vendor as the source, and screenshots and a capabilities list written by a vendor read as promotional anyway. Nobody thinks that's independent editorial content. Concern number one, a third party posing as the source, is covered. There are two weak spots. First, "Maintained by" is soft. It can read as "the vendor keeps it up to date," which isn't the same as "the vendor wrote it." That matters because the FTC looks at the net impression the advertisement conveys to reasonable consumers, not statements in isolation. These blocks also sit on a review site, next to your own content. I'd change the caption to "Supplied by {Vendor}." Small fix, big gain. Second, and this is the real one: your ranking page says there's "no promoted tier." But a paid plan that makes pages look fuller is arguably exactly that, even if search position never changes. A reader could fairly take that sentence to mean nobody pays for anything on your site. So the problem isn't the blocks. It's that your public statement risks creating a misleading impression by leaving out the paid plan.

**What we did:** Nothing built yet. No "Ad" label is needed. Two changes follow. Paid blocks are captioned "Supplied by {Vendor}", not "Maintained by". The ranking page must say that vendors can pay for a plan and what it buys, beside "no promoted tier". Ruling 31 sets the caption. Ruling 36 adds a sentence to the ranking page now. Counsel saw only the two quoted sentences. The live page puts them under the heading "What a plan does not buy", so it already says plans are paid. *Applied 2026-11-18 (legal branch 6, ruling 36, AECI-1871):* How ranking works 1.1 adds, beside "no promoted tier": "A paid plan lets a vendor edit more of its own listing. It changes what a page says, never where it appears." *Superseded 2026-11-26 (AECI-2230, item 14.8):* the unpublished 1.2 replaces both that sentence and "No plan, at any price, changes a listing's position" with ruling 65's wording. "There is no sponsored placement and no promoted tier" stays.

### Q45. A paying vendor posts a customer testimonial on our site: what we must do under 16 CFR Parts 465 and 255

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Readers write independent reviews on our site. We pre-moderate them and never accept a compensated or insider review. Separately, we plan to let a vendor on a paid plan post up to five customer quotes on its own product page. Each quote holds the quote text, the person's name, their job title and their employer.

Our planned controls:

- Quotes sit in their own section, apart from reviews. They are never counted, rated or shown in a review list.
- Each quote is labelled "Customer quote supplied by {Vendor}".
- For each quote the vendor ticks three statements: the person said this, the person agreed to its publication on AEC Integrations, and any compensation or other connection is disclosed.
- If the vendor flags compensation, the quote shows a line that says so.
- One of our staff approves each quote before it is published. We check the ticks and the label. We do not contact the person quoted.
- We remove a quote within two business days of a complaint from the person or their employer.

Our view: the vendor is the advertiser and carries the duties in 16 CFR Part 465 and the Endorsement Guides in Part 255. As the host, paid by the vendor, we meet our own duty with the attestations, the label, the compensation line and removal on complaint. We do not need to confirm each quote with the person quoted.

Question: are those controls enough for us as the paid host under Parts 465 and 255, or must we do more, such as confirm each quote with the person quoted?

**Answer (Alexander Coffin, 2026-11-16):**

Probably close to enough, but not quite. Part 465 doesn't say a paid host has to confirm every quote with the person quoted. What it does is punish disseminating a fake testimonial you "knew or should have known" was fake, and your controls only answer the "knew" half. Here's my thinking. The vendor is the advertiser. Agreed. But under § 465.2 the question isn't who wrote the quote. It's whether a business disseminated it, and you're arguably disseminating it, for money, on your own domain. So the "should have known" standard reaches you. A checkbox the vendor ticks for itself is evidence you asked. It isn't evidence you looked. If the FTC ever pulls a quote that turns out to be invented, "the vendor ticked a box and we checked the box was ticked" is a thin story. Your staff review checks the form and never the substance. Part 255 points the same way. The Guides say intermediaries like ad agencies and review platforms can be liable for deceptive endorsements they help spread, especially when they're paid and take an active role. Approving each quote is an active role. Then there's § 465.6, which is easy to overlook. You run what you market as an independent review site. Your separation and "supplied by {Vendor}" labelling are doing real work there, so keep them prominent and never blur them.

**What we did:** Our view was too thin. The vendor's ticks do not meet the "should have known" standard, because we never look at substance. Nothing built yet. Read with Q48, the fix is one step: the person quoted confirms the quote to us directly. Ruling 30: customer quotes are left out of Enhanced 1.0.

### Q46. Section 230 when the vendor pays and our staff approve the content first

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Your colleagues advised us on November 4, 2026 that vendor-entered listing data is the vendor's content under 47 U.S.C. 230 whether or not we screen it, that content we author or adopt as our own verified finding is ours, and that we must not market anything as verified unless we verify it. Those answers were about free vendor content that publishes without review.

Two facts are new. First, the vendor pays for a plan that lets it add the content. Second, some of the content waits for one of our staff to approve it. The held blocks are customer quotes, screenshots, a video, and security and compliance statements. A compliance statement is text such as "SOC 2 Type II" with a link to the vendor's evidence. It is displayed as "{Vendor} states: SOC 2 Type II".

Our staff approve or reject against a fixed checklist. They never reword. The checklist is: the vendor's required attestations are ticked, images have alt text, no personal data or customer drawings appear without an attestation, nothing on our prohibited list appears, and the evidence link on a compliance statement opens. Staff do not check whether any claim is true. Other blocks, such as capabilities, FAQ answers and pricing, go live when the vendor saves them.

Our view: being paid to host the content, and approving or rejecting it without rewording, are publisher functions that do not make us an information content provider. Checking that an evidence link opens is not adopting the claim as our own finding.

Question: does the payment, or the checklist approval, and in particular the evidence-link check on a security statement, make these vendor claims our own content outside Section 230?

**Answer (Alexander Coffin, 2026-11-16):**

No. Neither the payment nor the checklist approval, the link check included, should make these vendor claims your content. Payment. Courts have long held that paying for content doesn't take away immunity. In Blumenthal v. Drudge (D.D.C. 1998), AOL paid Drudge and was still protected. What matters is who created or developed the information, not whether money changed hands. FTC v. Accusearch (10th Cir. 2009) is the case to watch, but it turned on the site soliciting and paying for unlawful content, not on payment as such. A paid plan for adding listings is nowhere near that. Approval. Deciding whether to publish or withdraw content is the core publisher function Zeran protects. Under Roommates and Jones v. Dirty World, you lose immunity only if you "materially contribute" to what makes the content unlawful. You never reword anything, and your checklist covers formatting, attestations, prohibited items and personal data, not truth. That's screening, which your colleagues already said doesn't change who authored the content. The evidence link. Confirming that a URL opens doesn't endorse what's behind it. And the "{Vendor} states:" display helps a lot, because it tells readers the claim is the vendor's. If the label said "Verified SOC 2," that would be a different conversation.

**What we did:** Our view holds. Nothing built yet. The build keeps three rules: staff never reword, the checklist never tests truth, and a compliance statement reads "{Vendor} states:" and never "Verified".

### Q47. Privacy notice owed to a person named in a vendor's customer quote

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

We plan to let a vendor post customer quotes on its product page. Each quote shows a person's name, job title and employer. That person never dealt with us and has no account. The vendor gives us the data. We do not target the EU or the UK, but visitors and customers from there reach the site, and a quoted person could live there or in California.

Our Privacy Policy today covers visitors, account holders and vendor staff. It has no section for a person named in content a vendor submits.

Our plan:

- The vendor confirms, for each quote, that the person agreed to its publication on AEC Integrations.
- The Privacy Policy gains a section for people named in vendor content. It says what we hold, where it came from, why we publish it and how long we keep it.
- A named person can have a quote removed by email, with no account.
- We allow no photographs of people.

Our view: the vendor's confirmation of consent, the new policy section and the removal route are enough. We do not need to send a notice ourselves to each person named.

Question: is that enough in the United States, the EU and the UK, or must we notify each named person directly, as GDPR Article 14 would require where it applies?

**Answer (Alexander Coffin, 2026-11-16):**

Mostly yes. I'd add one cheap fix, though, and it covers you everywhere. EU and UK. Start with scope, not Article 14. GDPR reaches a non-EU controller under Art. 3(2) only if it offers goods or services to people in the EU or monitors their behaviour there. Publishing a quote about someone who might happen to live in Lyon isn't targeting that person. UK GDPR works the same way. You've said we do not target the EU or the UK, so Article 14 probably never applies to the quoted person. If your analytics track EU visitors, that's a "monitoring" argument about visitors, not about the person quoted. Now say a regulator disagrees. Article 14 would then require notice within a month, unless an exception applies. The obvious one is "disproportionate effort" under Art. 14(5)(b), and it's weak here because the vendor obviously knows how to reach the person. The better one is Art. 14(5)(a): no notice is needed if the person already has the information.

**What we did:** Our view mostly holds. Nothing built yet. Article 14 probably does not reach the quoted person. The safe route is that the person already has the information. The confirmation step in Q48 delivers it, if the message to the person carries the privacy notice. The answer names no specific fix beyond that.

### Q48. Right of publicity when a vendor's testimonial names a person

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

We plan to let a vendor on a paid plan post customer quotes on its product page. Each quote shows a person's name, job title and employer, beside words that praise the vendor's product. We publish it. The vendor pays us for the plan. We show no photograph of the person.

For each quote the vendor ticks a statement that the person agreed to publication of their name and words on AEC Integrations. We record who ticked it and when. We do not collect anything from the person. The vendor's indemnity in our Vendor Terms covers "infringement of intellectual property or other rights by content you submit" without a cap.

Our view: this is a commercial use of a name under right-of-publicity law, such as Fla. Stat. 540.08. The vendor's recorded statement that the person consented, backed by the indemnity and removal on request, is enough to protect us as publisher. We do not need the person's own consent on file.

Question: is the vendor's recorded statement of consent enough to protect us against a right-of-publicity claim by the person named, or do we need the person's own consent on record?

**Answer (Alexander Coffin, 2026-11-16):**

No. The vendor's checkbox doesn't protect you. You need the person's own consent on record, or at least a way to check it with them. Section 540.08(1) bars publishing a person's name for trade or advertising purposes without express written or oral consent given by that person (or certain authorized others, such as a licensee or estate). What matters is whether the person actually consented. Your belief that they did isn't a defense. The statute has no good-faith reliance exception for publishers, and the exemptions in 540.08(4), like news and bona fide public-interest uses, don't fit a paid vendor testimonial. You publish it and you're paid for the plan, so you're a "person" who "publicly uses" the name. Common-law misappropriation points the same way. So if the customer never agreed, the vendor's tick doesn't cure anything. It's just the vendor's word, which is effectively hearsay on the one fact that decides the claim. The person can seek an injunction plus damages, including a reasonable royalty, and potentially punitive damages. The indemnity helps, but it moves the cost. It doesn't move the liability. You're still the defendant. It's also only worth what the vendor's balance sheet is worth, and the "IP or other rights" wording invites a fight over whether publicity claims are covered. Removal on request limits ongoing exposure but does nothing about the period before removal.

**What we did:** Our view was wrong. Under Fla. Stat. 540.08 we need the named person's own consent on record. The vendor's tick is not a defence. Nothing built yet. No quote that names a person may be published on the vendor's word alone. The remark on "IP or other rights" confirms text item 14.3 from Q50. Ruling 30: customer quotes are left out of Enhanced 1.0.

### Q49. A vendor lists its customers by name on our site: false endorsement exposure

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

We plan to let a vendor on a paid plan show two things on its product page. One is a plain-text list of firms that use the product. The other is up to three short case studies, each naming a customer firm with a link to the full study on the vendor's site. We show firm names as text only. We show no customer logos.

Your colleague advised us on November 4, 2026 that nominative fair use is a defense and not a license, and that a use suggesting sponsorship or endorsement is actionable under Lanham Act section 43(a). That answer was about a vendor's own name and logo. Here the names belong to third parties who never dealt with us.

Our planned controls: the section is labelled as supplied by the vendor. For each name the vendor ticks a statement that the firm agreed to be named. One of our staff approves the list before it is published, checking the ticks only. We remove a name within two business days of a complaint from the named firm.

Our view: plain-text names, a per-name statement of permission from the vendor, the vendor label and prompt removal keep our exposure to a false-endorsement claim low. We do not need written proof of each firm's permission.

Question: are those controls enough to protect us against a false-endorsement claim by a named customer firm, or must we hold proof of each firm's permission?

**Answer (Alexander Coffin, 2026-11-17):**

Sorry about that. Mostly yes. You don't need written proof of each firm's permission on file. But a tick-box alone is weaker than it looks, and two small changes would close most of the gap. Section 43(a) doesn't require consent as such. The question is whether the use is likely to confuse people about whether a firm endorses or is affiliated with a product. The tricky part is that a true customer list usually isn't false at all. If the firm really uses the product, saying so is accurate. The risk is in the case studies. A named case study reads like a testimonial, and that's where "they never agreed to this" claims come from. On your exposure: the vendor makes the statement and you host it. So the realistic claim against you is contributory liability, which under the Inwood standard turns on what you knew or had reason to know. Your controls fit that well. You don't verify anything up front, but once a complaint arrives, you have actual knowledge and the clock starts. Two business days is fine for the plain name list. For a case study the firm says it never approved, I'd take it down the same day while you look into it. Don't count on Section 230. It excludes intellectual property claims, and some courts treat Lanham Act claims as IP. Also, a staff member who "approves" the list arguably makes you more of a co-publisher, even if all they check is the ticks. I'd describe that step as a completeness check, not an approval.

**What we did:** Our view mostly holds. Nothing built yet. We do not need proof of each firm's permission. Two changes follow. A case study a named firm disputes comes down the same day while we look into it, and a plain name stays at two business days. The staff step on these two blocks is called a completeness check, never an approval, in the product, the content policy and the docs. Section 230 is not a defence to this claim. The first answer received on 2026-11-16 was to another customer's question and is not recorded.

### Q50. Do our vendor warranty and indemnity cover third-party material in screenshots and quotes

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

We plan to let vendors upload screenshot galleries and customer quotes. A construction-software screenshot often shows a real customer project: drawings owned by an architect or engineer, a site address, staff names and costs. A quote names a person and their employer. None of that belongs to the vendor.

Our Vendor Terms say:

"You confirm that you have the right to submit what you submit. That includes logos, product names, screenshots and text. You confirm that it does not infringe anyone's intellectual property, breach a confidentiality obligation, or break any law."

and, in the indemnity:

"Your total liability under this indemnity is limited to the greater of ten thousand US dollars or ten times the fees you paid to us in the twelve months before the claim arose. That limit does not apply to your fraud or intentional misrepresentation, your willful misconduct or gross negligence, infringement of intellectual property or other rights by content you submit, your breach of confidentiality, or your violation of law in using the portal."

Our view: "the right to submit" and "infringement of intellectual property or other rights" already reach a customer's drawings, a named person's privacy and publicity rights, and a customer's confidential project data. Claims of those kinds are therefore outside the ten thousand dollar cap, and no new wording is needed.

Question: do those two clauses already cover third-party drawings, personal data and publicity claims without a cap, or should we add a specific warranty and name privacy and publicity claims in the uncapped list?

**Answer (Travis Russell, 2026-11-15):**

In general, your current language probably reaches some of these claims, but not reliably. Florida courts read contracts by their plain meaning, read general words like "other rights" in light of the specific words around them, and often construe unclear terms against the drafter. Indemnity terms are expected to be clear and specific. "Infringement of intellectual property or other rights" fits copyright in an architect's drawings well. A vendor could argue it does not clearly cover privacy, right of publicity (Florida has a statute on commercial use of a person's name or likeness), data-protection claims, or a customer's confidential project information. Also, "your breach of confidentiality" may be read to cover only the vendor's duties to you, not a duty it owes its own customer.

Because the cap exclusions are where the money is, most drafters don't rely on general wording. Common practice is to add a specific warranty that the vendor has every consent and license needed for third-party content, including drawings, names, likenesses, quotes, and personal or confidential data, and that it will redact project details it isn't allowed to share. The same claims are then named expressly in the uncapped list, and the indemnity itself, not just the cap carve-out, is made to cover them. A takedown process also helps, since some claims could be brought against you directly.

So the safer course is to add the specific language rather than rely on interpretation. For a review of your actual Vendor Terms and proposed wording, please schedule a live consultation and upload the documents for that appointment.

**What we did:** Our view was wrong. The general wording does not reliably cover privacy, publicity, data-protection or customer-confidentiality claims. Nothing is changed yet. The Vendor Terms need three edits: a specific warranty for third-party material with a duty to redact, those claims named in the uncapped list and in the indemnity itself, and "your breach of confidentiality" widened to a duty the vendor owes its own customer. Screenshots can be uploaded today, so the edits do not wait for the Enhanced plan. Ruling 26: they go into the first in-force Vendor Terms, as text items 14.1 to 14.4 on AECI-1363. *Applied 2026-11-18 (legal branch 6):* text items 14.1 to 14.4 are in the Vendor Terms 1.3 draft, in place, because production held no 1.3 acceptance. The upload warranty covers third-party material with a duty to remove what may not be shared, the indemnity and its uncapped list name privacy, name and likeness, data-protection and confidentiality claims, and the confidentiality carve-out covers a duty owed to anyone.

### Q51. A click-to-play YouTube or Vimeo video for visitors in the EEA, the UK and Switzerland

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question about European law only.

Your colleague advised us on November 6 and November 11, 2026 that reading or storing data on a visitor's device is an ePrivacy Article 5(3) event, and that purpose decides the "strictly necessary" exemption. We do not target the EU or the UK, but visitors from there reach the site.

We plan to let a vendor show one product video, hosted by YouTube or Vimeo. Our design:

- The page shows a still image that we host, with a play button.
- A line beside it reads "Plays from YouTube. YouTube will receive your IP address and may set cookies."
- Nothing loads from the video provider until the visitor clicks play.
- On the click, the provider's player loads in its reduced-tracking mode.
- Our Privacy Policy names the video providers as third parties that are not our processors.

Our view: a visitor who clicks play on a video that names its provider has explicitly requested that service, so the player is strictly necessary for it and needs no consent banner. If that is wrong, the click after that line is itself valid consent.

Question: is the click, after that line, enough for visitors in the EEA, the UK and Switzerland, or do those visitors need a separate consent step before the player loads?

**Answer (Alexander Coffin, 2026-11-16):**

The click works, but only as consent, not under the "strictly necessary" exemption. And the line next to the video needs a little more detail before the click can count as informed consent. Strictly necessary. I don't think this holds. Playing the video is a service the visitor asked for, so cookies the player needs just to play it are arguably exempt. YouTube and Vimeo set more than that, though. YouTube's privacy-enhanced mode still writes local storage and other identifiers once playback starts. Those serve the provider's own purposes, not the playback. Regulators look at each cookie's purpose, so the exemption covers the playback cookies and nothing else. Your colleague's purpose test points the same way. The click as consent. This is the stronger argument, and it's basically the "two-click" model that the German and French regulators have accepted. Consent has to be freely given, specific, informed and a clear affirmative act. Clicking play after a clear notice can meet that. Nothing loads before the click, and the visitor can skip the video and still use the page, so it's freely given. The weak spot is "informed." "May set cookies" is thin.

**What we did:** Nothing built yet. The click-to-play design stands, as consent and not as strictly necessary. The line beside the player must say more than "may set cookies": who the provider is, what it receives and stores, and that it uses the data for its own purposes. The answer does not give the wording.

### Q52. An embedded third-party video player: Video Privacy Protection Act and Florida wiretap exposure

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question about US law only.

Your colleague noted on November 6, 2026 that class exposure for a free review site comes from statutes with fixed damages, and named Video Privacy Protection Act pixel theories and Fla. Stat. ch. 934.

We plan to let a vendor show one product video on its product page, hosted by YouTube or Vimeo. The page shows a still image that we host and a line reading "Plays from YouTube. YouTube will receive your IP address and may set cookies." Nothing loads from the provider until the visitor clicks play. Then the visitor's browser loads the provider's player directly from the provider. We send the provider nothing ourselves. We run no advertising pixel. Most visitors are not signed in. Some are signed in to a free account that holds their email address. We never pass an account identifier to the provider.

Our view: we do not disclose who watched what, because we send the provider no identifier and the browser makes the request only after the visitor clicks. The line beside the player gives notice, which answers a Florida wiretap claim. So this design creates no real exposure under the Video Privacy Protection Act or chapter 934.

Question: does this click-to-load design, with that line, avoid Video Privacy Protection Act and Florida chapter 934 exposure for us, or is a further step needed?

**Answer (Alexander Coffin, 2026-11-16):**

Tou're mostly fine, but I'd add two small technical steps. And your reasoning is a little off in a couple of places. VPPA. Your best defense isn't that you send the provider nothing. It's that you probably aren't a "video tape service provider" at all. The statute covers someone engaged in the business of renting, selling or delivering video content (18 U.S.C. § 2710(a)(4)). A software directory that lets one vendor show one demo clip is a weak fit for that, even under the broader readings some circuits have adopted. Your "the browser does it, not us" point is weaker than you think. Plaintiffs argue that the site's own embed code causes the disclosure. Once a visitor clicks play, YouTube receives the page URL as the referrer. That URL can show which product video was watched. If the visitor is signed in to Google, YouTube can tie the view to a real person. You don't control that, but you did set it up. So:

Use youtube-nocookie.com, or Vimeo's do-not-track setting (dnt=1). Add referrerpolicy="no-referrer", or at least "origin", to the iframe.

Also, the notice line is not VPPA consent. The statute requires separate, distinct written consent. Don't rely on the notice for this part.

**Follow-up asked:**

Thank you. One part of the question is left. One question: under Fla. Stat. ch. 934, does this same click-to-load design, where nothing loads from the video provider until the visitor clicks play beside a line naming the provider, create any wiretap exposure for us, or does the notice and the click answer it?

**Follow-up answer (Alexander Coffin, 2026-11-19):**

The click-to-load design handles chapter 934 well. The notice line isn't really what protects you, though, and as written it has a gap you should fix. Start with who intercepts what. A claim under § 934.03 needs someone to intercept the contents of a communication without consent from all parties. Once the visitor clicks, their browser talks directly to YouTube. That's a two-party exchange, and YouTube is a party to it. A party to a communication isn't intercepting it, and you aren't in the middle of it at all. That's your main defense, and it's a good one. Florida courts have also been unreceptive to session-replay and tracking theories, often finding no "contents" were captured. Where does exposure remain? The aiding or procuring theory: you put the player there, so you "procured" YouTube's collection. That's weak when YouTube is the endpoint, but plaintiffs still plead it. The other issue is content. When the player loads, YouTube learns the video ID, and the referrer tells it the page URL. A URL that shows which product page someone visited can look a lot like content.

**What we did:** Nothing built yet. The design is mostly fine. Two build rules are added: the player loads from `youtube-nocookie.com` or with Vimeo's `dnt=1`, and the iframe carries `referrerpolicy="no-referrer"`. The notice line is not Video Privacy Protection Act consent, so we do not rely on it for that. The follow-up covers Fla. Stat. ch. 934: the design holds, because the provider is a party to the exchange and we are not in it. The remaining exposure is the page address the provider learns from the referrer. That makes `referrerpolicy="no-referrer"` a required rule, not an optional one. The answer says the notice line has a gap and does not say what to add to it.

### Q53. Sending vendor content to a language-model provider for screening: do our licence and Privacy Policy cover it

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

We plan an automated screening job. Each time a vendor creates or edits text or an image on its listing, we send that content to a language-model provider together with our content policy. The provider returns a risk score from 0 to 100 and reason codes. A score above a threshold puts the item in front of one of our staff. The model never removes, hides or rewords anything. The provider's contract bars it from training on our data. Screening covers every vendor on every plan, including vendors who accepted the current terms before screening existed. Some content, such as a customer quote, names a person who is not our user.

The content licence in our Terms of Service, which the Vendor Terms repeat, says:

"you grant the operator a non-exclusive, worldwide, royalty-free, irrevocable license to host, store, reproduce, format, excerpt, resize, crop, compress, index, make accessible and display that content in connection with operating the service, and to moderate it under our policies."

Our Privacy Policy lists processor functions, including "automated content checks on submitted reviews".

Our view: "to moderate it under our policies" already permits automated screening by a processor. We can widen the Privacy Policy phrase to "automated content checks on submitted content" as an ordinary update. Vendors who accepted the current terms do not need to accept anything new.

Question: is that right, or must screening by a third-party model be a named operation in the licence that existing vendors accept again?

**Answer (Travis Russell, 2026-11-15):**

Your view is reasonable but not risk-free. A license to host, reproduce and "moderate it under our policies" in connection with operating the service is fairly read to cover moderation tools, including automated screening a vendor does for you. Using service providers for licensed activities is routine. But the license doesn't expressly mention sharing content with service providers, a vendor could point to that gap, and unclear terms are often construed against the drafter. Many platforms add simple wording such as "you also authorize our service providers to do these things on our behalf."

For existing vendors, a change that only clarifies an existing right is usually lower risk. You can roll it out under your modification clause with notice, applying going forward. Fresh click-through acceptance is safer where a change materially expands how content or personal data is used, and it is the strongest evidence of consent.

On privacy, the FTC has warned that quietly changing terms to allow new AI uses of data already collected can be unfair or deceptive. Your facts help: screening only, no training by the provider, and human review of flagged items. Your disclosure should still accurately describe automated screening by third-party AI providers, including content that names non-users. Your provider contract should cover confidentiality and use limits. EU or UK users bring separate rules.

The practical course is to update both the license and the privacy disclosure, give advance notice, and consider click-through acceptance.

**What we did:** Nothing built yet. The licence probably covers screening, but it does not name service providers. Before screening runs, the licence gains a sentence authorising our service providers to act for us, and the Privacy Policy names automated screening by a third-party AI provider, including content that names people who are not users. Screening content already collected is a new use of it, so it needs advance notice. Ruling 27: the service-provider sentence goes into the first in-force versions as text item 14.5, so every vendor accepts it on the acceptance screen. The EU and UK side was not answered. Ruling 29 holds that follow-up until screening is scheduled. *Applied 2026-11-18 (legal branch 6):* text item 14.5 is in the Terms of Service 1.1 and Vendor Terms 1.3 drafts, in place. The Privacy Policy screening disclosure still waits for the screening build.

### Q54. Does a stored automated risk score give us knowledge under the DMCA or weaken Section 230

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Your colleagues advised us that learning third-party content is false does not by itself defeat Section 230, that continued publication after verifiable proof is evidence of knowledge in a trade-libel claim, and that our DMCA safe harbor needs an enforced repeat-infringer policy and a notice log.

We plan an automated screening job for vendor content. A language model scores each new or edited block from 0 to 100 and attaches reason codes. The codes are: named competitor, unsourced superlative, personal data, project data in an image, compliance claim without evidence, testimonial without attestation, advertising in a factual field, and off-topic or abusive. We store the score, the codes, the model version and a hash of the content beside the block.

A block that scores above the threshold goes to a staff queue. If the block is already live, it stays live until a person acts. A block below the threshold is never looked at by a person. The model makes mistakes in both directions.

Our view: an automated score is a triage signal. It is not actual knowledge or red-flag knowledge of infringement under 17 U.S.C. 512(c)(1)(A), and it is not knowledge that a statement is false. Keeping the score does not weaken our position, provided a person reviews flagged items within a stated time.

Question: is that right, or does a stored flag on content we leave live, such as "project data in an image", create knowledge that weakens the DMCA safe harbor or our Section 230 position, and if so what must we do when a flag is raised?

**Answer (Alexander Coffin, 2026-11-16):**

Mostly right. The weak spot is the queue, not the score. DMCA. In Florida, the Eleventh Circuit adopted Viacom's test in Athos v. YouTube (2026). It found YouTube protected because it expeditiously removed infringing material identified by valid takedown notices and did not have actual or red flag knowledge of other specific infringements. Red-flag knowledge turns on whether the provider was subjectively aware of facts that would have made the specific infringement "objectively" obvious to a reasonable person. A probability score that nobody reads isn't subjective awareness. "Project data in an image" isn't even a copyright code. It's a privacy or confidentiality flag. Once a person opens the item, though, things change. If what they see makes infringement obvious, say a competitor's watermarked screenshot, that's red-flag knowledge. The clock starts then, because the provider that gains knowledge or awareness of infringing activity retains safe-harbor protection if it acts expeditiously to remove, or disable access to, the material. So leaving it live "until a person acts" is fine. Leaving it live after a person has looked is the exposure. Also watch willful blindness: a backlog of unopened flags that stays big for months looks like you chose not to know. Section 230. A stored flag doesn't change your status. You're still not the content's developer, and knowledge alone doesn't defeat 230, which matches what my colleagues told you. The risk is the trade-libel claim.

**What we did:** Our view mostly holds. Nothing built yet. A stored score is not knowledge. Two build rules follow. A staff member who opens a flagged item must decide it then, and remove obvious infringement at once. The flag queue needs a review deadline and an alert on its age, so it never sits unopened for months. The answer names the trade-libel claim as the remaining risk and says no more about it.

### Q55. One notice at first save for a private "software my firm uses" list, and its three uses

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

We plan a feature for signed-in readers. A reader records which products in our catalog their firm uses, and can group them under office labels they type, such as "Chicago". Only that reader can see their list. Our staff cannot read it. We do not target the EU or the UK, but people there can create accounts.

We would use the list in three ways:

1. To filter and annotate the directory for that reader only.
2. To show a public count on each product page, "used by N accounts", only when N is 5 or more.
3. To show the vendor of a product, in its paid portal, the same kind of total for its own products, only when 5 or more. Never who, never which firm, never an office label.

Our Privacy Policy today says of the legal basis: "Consent: where required, for example for non-essential analytics cookies and the optional About you answers; you can withdraw consent at any time".

Our plan: the first time a reader saves a list, we show one short notice that names all three uses in plain words. The reader confirms once. The Privacy Policy gains matching text. Marketing email based on the list is a separate question and is not covered here.

Our view: one clear notice at the point of collection that names the three uses is valid consent for all three, in the United States, the EU and the UK.

Question: is that single notice enough for all three uses, or does the public count or the vendor total need its own separate opt-in tick in any of those places?

**Answer (Alexander Coffin, 2026-11-16):**

One notice is enough for all three uses, but only if you stop calling it consent. United States. The notice is fine. Florida's Digital Bill of Rights only applies above roughly $1 billion in revenue, so it almost certainly doesn't reach you. The other state laws (California and the rest) mostly require you to tell people and let them opt out of sales, not to get opt-in consent. A list of software a firm uses isn't sensitive data under any of them. And a count of 5 or more, with no names and no office labels, looks like aggregate or deidentified data. Clear notice at first save does the job here. EU and UK. This is where your stated view breaks down. First, a threshold point: if you don't target people there, GDPR's reach under Art. 3(2) is arguable. Still, plan as if it applies. Under GDPR, consent has to be granular. The EDPB consent guidelines and the ICO both say that one confirm covering several separate purposes isn't valid consent for any of them. The public count and the vendor total are clearly separate purposes. So if consent is your legal basis, yes, each needs its own unticked opt-in, and a person who declines must still be able to use the private filtering. My advice is not to use consent at all:

Use 1 (private filtering) is the service the reader asked for. Contract, Art. 6(1)(b), covers it. Uses 2 and 3 produce counts with nobody identified. Legitimate interests, Art. 6(1)(f), fits well if you document a short balancing test: no names, a minimum of 5, staff can't read lists. Offer an easy way to exclude your list from counts and you're in good shape.

On that approach, your single notice at first save becomes the Art. 13 transparency notice, which is exactly what it should be. There's no consent to bundle and no need for ticks.

**What we did:** Nothing built yet. One notice at first save stands, but not as consent. The Privacy Policy states contract as the basis for the reader's own filtering and legitimate interests for the two counts. We write a short balancing test and keep it on file. The account page gains a switch that leaves a reader's list out of the vendor totals. Ruling 37 adopts this. Ruling 39 removed the public count, so only the vendor total remains.

### Q56. Emails based on a reader's saved software list: consent in the US, EU, UK and Canada

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

A signed-in reader may save a private list of the software their firm uses. We plan to email that reader when something relevant changes, for example: "Product X now integrates with Product Y, which is on your list." We write and send the email. No vendor pays for it, picks its content or receives the reader's address. Every email carries an unsubscribe link and our postal address.

Your colleague advised us on November 6, 2026 that a single marketing email needs no prior consent under CAN-SPAM, needs an advertisement label when sent without affirmative consent, and that Canada's CASL and the EU rules are consent-based.

Our plan: the notice shown when a reader first saves a list carries one unticked box, "Email me when something changes for software on my list." We send these emails only to readers who tick it, in every country.

Our view: these are commercial emails. An unticked box at the point of collection, ticked by the reader, is valid consent under CAN-SPAM, the GDPR and ePrivacy rules, the UK rules and CASL. With that consent on record, no advertisement label is needed.

Question: is one unticked opt-in box at first save sufficient consent for these emails in the United States, the EU, the UK and Canada, or does any of the four need something more?

**Answer (Alexander Coffin, 2026-11-16):**

The box works in all four places. In Canada and the EU, though, the box alone isn't the whole job. What has to go around it differs by region. US (CAN-SPAM). You don't need consent to send at all. A reader who ticks an unticked box has given "affirmative consent," which is what removes the advertisement label requirement. Your view is right here. You still need the unsubscribe link, your postal address, an honest "from" line and an honest subject line, and you must honor opt-outs within 10 business days. EU (GDPR plus ePrivacy). Planet49 confirms that an unticked box is the right mechanism. A box doesn't make the consent informed, though. The text near it has to:

say who you are, describe what the emails will be about, and tell the reader they can withdraw at any time (Article 7(3)).

Keep records of who ticked the box, when, and what wording they saw. Germany and Austria expect a confirmation email (double opt-in) as proof. It isn't strictly required, but it's cheap, so add it for EU readers.

**What we did:** Our view holds. Nothing built yet. Build rules: the text beside the box names us, says what the emails cover and says the reader can withdraw. We record who ticked, when and the wording shown. EU readers get a confirmation email before the first send. The answer does not cover Canada or the UK.

### Q57. Paid vendor plans that include usage totals: is that a "sale" or "sharing" of personal information

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Signed-in readers may save a private list of the software their firm uses. We plan to show each vendor, in a paid portal plan, how many accounts list each of its own products. The vendor sees a single number per product. It never sees who, which firm, which office, or what else those accounts use. A number below 5 is hidden. Our market is small. A product might be listed by a few dozen accounts in total.

Our Privacy Policy says:

"We do not sell or share personal information, and we honor GPC as an opt-out of product analytics."

Our Vendor Terms say:

"Information we show you in the portal about how your listings perform is for your company's internal use. Do not publish it or pass it to anyone outside your company without our written permission."

We believe we are below the California Consumer Privacy Act thresholds, but we want the sentence above to stay true under that law's definitions.

Our view: a single count per product, hidden below 5, is aggregate or deidentified information and not personal information. Giving it to a paying vendor is therefore not a sale or sharing, and the internal-use clause is enough.

Question: is that right, or do we need a higher minimum count, or a promise from the vendor not to try to identify the accounts, to keep "we do not sell or share personal information" true?

**Answer (Alexander Coffin, 2026-11-16):**

Mostly right, but I'd add the vendor promise. It costs you almost nothing and covers the weak spot. The count probably qualifies as "aggregate consumer information" under Cal. Civ. Code §1798.140(b). That means data about a group that isn't linked or reasonably linkable to any consumer or household. If it fits there, it isn't personal information. Handing it over isn't a "sale," even though vendors pay for it. "Sharing" isn't really in play either, because it's limited to cross-context behavioral advertising. So far, so good. The problem is your market size. When a product has a few dozen listers and the number updates live, a vendor can watch it change. Say it goes from 11 to 12 the week after a firm signs up, and the vendor already knows that firm is its customer. Now the number is about one firm, which is exactly the "reasonably linkable" problem. Raising the floor to 10 doesn't fix that. The leak comes from the changes over time, not the floor.

**Follow-up asked:**

Thank you. You said the leak is a vendor watching the total change, and that a higher floor does not fix it. One question: if we refresh each total once a month instead of live, keep the minimum of 5, and add the vendor's promise not to identify accounts, is the total then aggregate consumer information under Cal. Civ. Code 1798.140(b), or is something more needed, such as rounding?

**Follow-up answer (Alexander Coffin, 2026-11-17):**

Monthly refresh, a floor of 5, and the vendor promise get you closer. I don't think they get you all the way to "aggregate consumer information" under 1798.140(b). Something more is needed, and rounding or noise is the practical fix. The (b) test doesn't turn on whether the vendor promises to behave. It asks whether the count is "linked or reasonably linkable" to a consumer or household. A contractual promise not to re-identify is one of the elements of the deidentified definition in 1798.140(m), alongside a public commitment and technical measures. It doesn't make a linkable number unlinkable. So the promise helps if you rely on (m), but it doesn't fix (b) on its own.

**What we did:** Our view mostly holds, with one addition. Nothing built yet. The Vendor Terms gain a promise that a vendor will not try to identify the accounts behind a total. Ruling 32 set a monthly refresh. The follow-up says that monthly refresh, a floor of 5 and the promise are still not enough to make the total aggregate information. The number itself must be rounded or have noise added. The promise counts toward the separate "deidentified" definition, together with a public commitment and technical measures. Ruling 40 adds bands to ruling 32.

### Q58. A public "used by N accounts" count on a product page

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Signed-in readers may save a private list of the software their firm uses. We plan to show a count on each product's public page, drawn from those lists. The count is our own statement. Your colleagues advised us on November 4, 2026 that Section 230 never shields our own statements, and that we must not present anything as verified unless we verify it.

Facts about the number:

- It is self-reported. We do not check that an account's firm uses the product.
- It counts accounts, not firms. Three colleagues at one firm are three accounts.
- We exclude accounts that hold a vendor role, so a vendor's staff cannot add to their own product's count.
- We show it only when it is 5 or more.
- It never affects search order or any ranking.

Our planned wording is "N accounts on AEC Integrations say they use this", and our methodology page would say the count is self-reported and unverified.

Our view: that wording states exactly what we hold. With the methodology note, it is not a false or misleading statement about a vendor's market position under the Florida Deceptive and Unfair Trade Practices Act or Lanham Act section 43(a), and it needs no further disclaimer.

Question: is that wording, with the methodology note, enough to protect us against a false-advertising or deceptive-practice claim by a competing vendor, or is more needed on the page itself?

**Answer (Alexander Coffin, 2026-11-16):**

Mostly yes, but put a few words on the page itself. The wording is literally true. "N accounts on AEC Integrations say they use this" describes exactly what you hold, so a literal-falsity claim under section 43(a) shouldn't get far. The exposure is implied falsity, meaning a message that's technically true but misleads. A competing vendor would argue that a big number on a product page reads as market share or adoption, as in "N firms use this." And because you count accounts rather than firms, three people at one firm count three times, so the number can overstate adoption. The methodology note doesn't fully fix that, because it lives on a different page. Courts and the FTC look at the net impression of the page as people actually see it. A disclosure one click away that most readers never open won't cure a misleading impression on the page they're reading. FDUTPA asks a similar question: would a reasonable consumer, acting reasonably, be misled? A reasonable reader might well take the number at face value. The Lanham Act also has threshold problems for a plaintiff. Under Lexmark, the vendor has to show commercial injury proximately caused by your statement. They'd also have to show the count is "commercial advertising or promotion," which is arguable for a neutral directory that doesn't sell competing software. Those are real defenses, but I wouldn't rely on them alone.

**What we did:** Our view mostly holds. Nothing built yet. The wording stands. The qualifier must sit beside the number on the product page, not only on the methodology page. It says the count is self-reported and counts accounts, not firms. The answer does not give the on-page words. Ruling 33 set them. Ruling 39 then removed the public count, so nothing is built from this answer.

### Q59. An employee records their employer's software and office names on our site without authority

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

We plan a feature for signed-in readers. A reader records which products in our catalog their firm uses, and can group them under office labels they type. Only that reader sees the list. We use it to filter the directory for them, and to produce counts of 5 or more accounts per product. Office labels are never used in any count, report, email or analytics event.

The reader is usually an employee. They may have no authority to tell us what software their employer runs. An office label such as "Acquired firm" could reveal something the employer treats as confidential. A firm's software list could also be useful to an attacker. Our Terms of Service today cover content a user submits for publication. They say nothing about private information a user gives us about a third party.

Our plan: the Terms gain a sentence in which the reader confirms they are allowed to share this information. We keep each list private to the reader. If an employer proves who it is and asks, we delete lists that name it.

Our view: a firm's choice of commercial software is rarely a trade secret. The reader's confirmation, the privacy of the list and deletion on the employer's verified request are enough to protect us against a confidentiality or trade-secret claim by the employer.

Question: are those three steps enough to protect us against a claim by the employer, or do we need something more?

**Answer (Alexander Coffin, 2026-11-16):**

The three steps get you most of the way, but not all of it. Under the Florida Uniform Trade Secrets Act, you're liable for misappropriation only if you knew, or had reason to know, that the information came through improper means or from someone who owed the employer a duty of confidence. You're right that a list of off-the-shelf software usually won't qualify as a trade secret. Office labels are different. "Acquired firm" could reveal an unannounced deal, and that's the kind of thing an employer guards. Here's where the plan is thin. The user confirmation helps, but it isn't a shield. The worry is that the feature itself puts you on notice: you invite people to type in free text, and if you know employees may lack authority, that knowledge is close to "reason to know." A clause in the Terms doesn't erase it. What it really gives you is a contract claim against the user, which you'll probably never bring. Deletion on verified request is good. But once an employer gives notice, you have actual knowledge, so deletion has to be fast and complete. That means backups, caches and any counts the list fed into. If you keep using the data after notice, that's textbook misappropriation. Privacy of the list covers disclosure. It doesn't cover a breach, and you've already spotted that a firm's software stack is useful to an attacker. If you hold the data loosely and it leaks, you face a negligence-style claim, separate from trade secrets.

**What we did:** Our view mostly holds for the software list and not for office labels. Nothing built yet. The free-text office label is the exposure, because inviting free text gives us reason to know it may hold a confidence. Deletion on an employer's notice must be fast and complete: the lists, the counts they fed, caches and backups. The lists need real access controls, because a leak is a separate negligence claim. Ruling 38: labels stay free text and become general groups, not offices. Counsel's concern about free text stands and is accepted. The answer gives no remedy for the free-text point.

### Q60. Adding new sections to a legal page before its first effective date: is the 30-day notice owed

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Our Privacy Policy and Terms of Service are published with a banner that says each is a draft, pending legal review and not yet in force. Neither has an effective date yet. Your colleague advised us on November 11, 2026 that a change clause inside a draft that never took effect may not itself be in effect.

The Privacy Policy says:

"Where a change materially affects how we use your personal data, we tell you the way our Terms of Service describe: a notice on every page of the site for 30 days before it takes effect, and an email to every account holder."

We plan new features that collect new data and use it in new ways. Each needs new sections in the Privacy Policy. Some of that text may be ready before the policy's first effective date. The related features would not be switched on until the text is in the policy.

Our view: text added before the first effective date is simply part of the first version that takes force. No 30-day notice and no email is owed for it. The same text added after the effective date is a material change and needs both.

Question: is that right, or does the 30-day notice and email promise already bind us for changes made while the pages still carry the draft banner?

**Answer (Travis Russell, 2026-11-15):**

In general, your view is sound as a matter of contract. A notice-of-change promise in a policy that has not yet taken effect usually does not bind you until the policy does. Text added before the first effective date is part of the first version, not a "change" to it. That holds best when the draft label is clear and consistent, nobody has been asked to accept the draft, and the first version gets a clear effective date.

The bigger risk is regulatory rather than contractual. The FTC and state consumer-protection laws, including Florida's, look at what you actually represent to the public and what you actually do. A banner saying "draft" doesn't fully neutralize a publicly posted privacy policy if the site is live and collecting data. If people are creating accounts or submitting information now, they may reasonably rely on the posted text. Expanding how you use data you have already collected can draw scrutiny even if the change technically lands before an effective date. Some states that may apply to visitors, such as California, also expect a live site to have an operative privacy policy with an effective date. So the practical risk depends on whether you are collecting data now.

Common approaches:

If you are collecting real user data now, put a short, accurate interim policy in effect for current practices.
Keep new features off until the policy covering them is live, as you plan.
Don't apply new uses to data collected earlier without notice or consent.
Even if not strictly required, give a short notice or email when the first version takes effect. It costs little and builds goodwill.

**What we did:** Our view holds as contract: text added before the first effective date is part of the first version and owes no 30-day notice. Two limits follow. A new use of data we already hold needs notice or consent whenever its text lands, which reaches the screening job in Q53. The draft banner does not protect a live site that collects data, so the first effective date should not slip behind new features. Ruling 28: a short notice or email goes out when the first version takes effect. *Built 2026-11-26 (AECI-1870).* An email to every account and a 14-day site band, under ruling 68.

Q61 and Q62 are batch 5, asked on 2026-11-16 from AECI-1826, the product page redesign. Q63 to Q69 are batch 6, written on 2026-11-18 and not yet sent. They put the five open items below and the legal README's two open items to counsel, with three reworded sentences to confirm.

### Q61. A product's name in plain text in a sticky bar on an unclaimed listing, without the not-affiliated note beside it

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, an independent US directory of construction-industry software compiled from public information. Florida law governs. This is one question, with one decision at the end.

Most listed vendors have never claimed their listing. Your colleague advised us on November 4 and 5, 2026 that using a product's name in text to identify it is nominative use and low risk when the listing is marked Unclaimed and carries a clear not-affiliated line, that a logo is riskier, and that the page must not look official. We followed that advice. On an unclaimed listing the logo is never larger than 32 pixels, we use none of the vendor's colours, and the top of the page carries this line beside the product name:

"Unclaimed · not affiliated with or endorsed by this vendor"

We are redesigning the product page. Two things are new, and both use the name as text only.

1. At the top of the page, under our own site header, the product name is the page title in large type on our own dark green background. The line above sits beside it.
2. When the reader scrolls down, a slim bar stays fixed at the top of the screen. It reads "AEC Integrations › Revit": our own wordmark first, then the product name in small plain text, then links to the page's sections. It shows no vendor logo and no vendor colour. The not-affiliated line is not repeated in this bar. By then it has scrolled out of view with the top of the page.

Our view: both are nominative use of a word name. The bar leads with our own wordmark, so it reads as our page about the product, not the vendor's own site. The line does not need to be repeated in the bar.

Question: on an unclaimed listing, may the fixed bar show the product name in text without the not-affiliated line beside it, or must the bar repeat that line or leave the name out?

**Answer (Brian D. Lerner, 2026-11-17):**

The bar may show the name without repeating the line. Nominative fair use permits using a product’s name to identify it if you use only what is needed and nothing suggests sponsorship. Plain text, no logo, smaller than your own wordmark, which comes first and identifies you as the source, meets that standard. A disclaimer helps but is not required, and Lanham Act 43(a) does not require you to repeat it wherever the name appears. Courts in the Eleventh Circuit, which covers Florida, ask whether the overall page is likely to confuse users about affiliation, so keep the bar free of “official,” vendor colors or styling, and claim language. If you want extra margin at low cost, add a short “Unclaimed” tag beside the name in the bar.

**What we did:** Our view holds. The sticky bar keeps the product name for every product, as built. The bar stays free of vendor colours, vendor styling, the word "official" and any claim language. Counsel offers an optional "Unclaimed" tag beside the name. Ruling 41 adds it as a trial. Recorded on AECI-1826. *Built 2026-11-18 (AECI-1931). Removed 2026-11-23 (AECI-2012).*

### Q62. "No plan changes where you rank or appear" when a paid plan lets a vendor set the tags that order our category menus

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 4, 2026 that our statement that ranking is never influenced by payment must be backed by records, and that it will not protect conduct that contradicts it.

Our Vendor Terms say:

"No plan changes where you rank or appear, or whether a review is published. That holds on Free, on Managed, and for anything else you pay us for."

Our Managed plan agreement says:

"No plan changes where you rank or appear, or whether a review is published. A subscription changes what you can edit. It never changes the order of listings."

Products carry tags for the trades and the audiences they serve, such as "Electrical" or "General contractors". We set these tags from our own research when we list a product. A vendor can change them on its own product only on the paid Managed plan. That is one of the things the plan is sold as including.

The tags feed three things:

- Each trade and each audience has its own page listing the products that carry the tag. A product appears there only if it carries the tag.
- Our site menu and home page show the ten trades and the ten audiences with the most products. So tags a Managed vendor adds can lift a term into that top ten, or make a trade with no products appear for the first time.
- The order of products inside any list never reads the plan. No product moves up or down a list because of a plan.

Our public page "How ranking works" already says the directory menu lists "the trades with the most products". It does not say that only a paying vendor can change its own product's trade tags.

Our view: the two sentences stay true. The plan changes how a product is described and which category terms our menus show. It never changes the order of listings. One added sentence on "How ranking works", saying that a Managed vendor can set its product's trades and audiences and that those tags decide which category pages list it, is enough.

Question: is that disclosure on "How ranking works" enough, or do the words "or appear" in both agreements need a qualifier because a Managed vendor can put its product on a trade or audience page that a Free vendor cannot?

**Answer (Alexander Coffin, 2026-11-19):**

The page disclosure isn't enough on its own. "Or appear" needs a qualifier. The problem is that the clause is simply false as written. Your terms say "No plan changes where you rank or appear", but a vendor can change them on its own product only on the paid Managed plan, and a product appears there only if it carries the tag. So the plan does change where a product appears. That's the literal reading, and it's the one a Free vendor will argue when it can't get onto the "Electrical" page and a competitor paying for Managed can. Contract law. A public web page doesn't amend a signed agreement. If the agreement makes an express promise, a disclosure somewhere else won't cure it, especially when the agreement itself never points to that page. And the Vendor Terms make it worse by extending the promise to anything else you pay us for. FDUTPA. Florida asks whether the overall impression is likely to mislead someone acting reasonably. A plain "no" in the agreement next to a caveat on a separate page is the classic pattern where the caveat loses. Your colleague already flagged this: the statement will not protect conduct that contradicts it. There's also a second exposure. Your menu claims to show "the trades with the most products", but only paying vendors can push those counts up. Directory users could see that as payment-shaped, even if the order within each list is clean.

**What we did:** Our view was wrong. "No plan changes where you rank or appear" is false as written in both agreements, because only a Managed vendor can put its product on a trade or audience page. A sentence on the ranking page does not cure a promise in the agreement. Not applied yet. Either the sentence is qualified in both agreements, or trade and audience tags become editable on every plan so the sentence is true. The menu's "trades with the most products" is a second exposure, tracked on AECI-1836. Ruling 52 replaces the promise with one about what ranking reads. Trade and audience tags stay on Managed. This gates the first effective date. Recorded on AECI-1826. *Applied 2026-11-26 (AECI-2230):* ruling 65's wording replaces the sentence in both agreements, in place in Vendor Terms 1.3 and Managed plan agreement 1.1. The section heading "Plans never affect ranking or reviews" is now "Plans, listing order and reviews" in both. Each keeps "No plan changes whether a review is published." The Vendor Terms drop "That holds on Free, on Managed, and for anything else you pay us for." The Managed plan agreement keeps "A subscription changes what you can edit. It never changes the order of listings."

Q63 to Q70 are batch 6, asked on 2026-11-19: the items that gate the first effective date. All eight are answered.

### Q63. Is a visible line beside the sign-in buttons enough acceptance for a change that reduces a reader's rights

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Readers may create a free account to write reviews. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 6, 2026 that "continued use" is weak against an existing account holder, that we should email every account holder before a material change, and that a change which cuts back a reader's rights should sit "behind a click at the next sign-in", with the click, the version and the time logged for each user.

We built it this way. Sign-in is by an emailed link or by Google, so every sign-in is a deliberate click. The sign-in page always shows this line directly beside the sign-in buttons:

"By signing in, you agree to our Terms of Service and Privacy Policy."

Both names are links. Each sign-in writes a record: the user, the Terms version in force, the time, the wording of the line, and for 90 days the IP address and browser. There is no separate screen and no checkbox. We chose this because a full-screen prompt drives free readers away. We email every account holder before a material change takes effect.

Our Terms of Service say:

"A change that reduces your rights, such as a change to the liability limit or the disputes section, applies to an account holder only after they accept it at their next sign-in, and never to a claim that arose before it took effect."

Our view: the email gives actual notice, and a logged sign-in beside a clear and always-present line is the click your colleague described. A reader who never signs in again stays on the earlier version.

Question: is a visible line beside the sign-in buttons, with each sign-in logged against the version in force, enough to bind an existing account holder to a change that reduces their rights, or must it be a box the reader ticks?

**Answer (Alexander Morton, 2026-11-19):**

You'll need the check box for an affirmative agreement.

**What we did:** Our view was wrong. A line beside the sign-in buttons, with the sign-in logged, does not bind an account holder to a change that reduces their rights. It needs a box the reader ticks. The answer is one sentence and gives no reasoning. Nothing is in force yet, so no reader is affected today. The Terms promise acceptance "at their next sign-in", so the tick box must exist before the first rights-reducing change after an effective date (AECI-1637). Ruling 53: the box shows only at the first sign-in after a rights-reducing version.

*Built 2026-11-19 (AECI-1637).* The sign-in sends such a reader to `/auth/terms`, which shows one unticked box and a link to the version. `POST /api/auth/terms/accept` records the tick. A reader who leaves without ticking stays on the earlier version, and the next sign-in asks again. An account created by that sign-in never sees the box. Nothing else is blocked.

### Q64. How long we may keep a copyright notice and counter-notice, and the privacy wording for it

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Readers post reviews, and vendors upload logos, screenshots and text. We have a registered DMCA designated agent. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 10, 2026 on our copyright complaints section. Our Terms now say "we keep a log of every notice and counter-notice we receive". We have built that log.

A notice or counter-notice holds the sender's name, postal address, phone number, email address and signature, the work claimed, and the material identified. The sender may have no account with us. Where the material was posted from an account, we record that account with the notice.

We keep each notice and counter-notice for three years after we close the matter. We chose three years because it is the limitation period for a civil copyright claim under 17 U.S.C. 507(b). We keep them after the account involved is deleted. At that point the link to the account is removed, and the sender's own details stay.

Our Privacy Policy says, under Retention:

"Copyright notices and counter-notices: for three years after we close the matter, as evidence if a copyright claim is brought. We keep them even if you delete your account. They are then no longer linked to your account."

Our view: three years after closing is a reasonable period tied to a real limitation period, and the sentence above is enough disclosure.

Question: is three years after the matter closes the right period to keep a copyright notice and counter-notice, including the sender's contact details after an account is deleted, and is the retention sentence above sufficient, or should the period or the wording change?

**Answer (Alexander Coffin, 2026-11-19):**

Three years is defensible. I'd keep it, but add a legal-hold carve-out and fix the wording. The period. Section 507(b) gives three years from when the claim accrues, not from when you close the file. Courts mostly apply a discovery rule, so a claim can arrive later than you'd expect. In Warner Chappell v. Nimmer (2024), the Supreme Court held that a timely claim can recover damages going back more than three years. Your clock starts at closing, which is usually later than accrual, so you mostly have cover. The likeliest claim is a § 512(f) misrepresentation suit, which is also under Title 17 and so also subject to 507(b). The gap is a late-discovered claim. The fix is easy: add "or longer if a claim, dispute or legal hold is pending." Also, deleting the account link is fine, but check that you can still enforce your repeat-infringer policy under § 512(i) if someone re-registers. The sentence. It's close, but it has three problems:

It's written to account holders. Many senders have no account, so "if you delete your account" doesn't speak to them at all. It leaves out sharing. Under § 512(g), you have to send the counter-notice, contact details included, to the person who filed the original notice. You'll probably forward notices to the uploader too. People should know that before they send one. It doesn't say what you keep. Name, address, phone, email, signature. If you hit CCPA thresholds, you need retention periods by category anyway, and CalOPPA expects you to say what you collect. Florida's Digital Bill of Rights almost certainly doesn't reach you, because its threshold is $1B in revenue.

**What we did:** Three years stays. Applied in legal branch 7 on 2026-11-19 (item 14.9). The retention sentence now adds "or longer if a claim, dispute or legal hold is pending", to speak to senders who have no account, to name what we keep, and to say who we send a notice or counter-notice to. Ruling 44 already settles the repeat-infringer point: a deleted and re-created account starts with a clean count. The case counsel cites is reproduced as written. We believe its name is Warner Chappell Music v. Nealy.

### Q65. Forwarding a counter-notice when our privacy policy says we identify users only under legal process

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Reviews are published under the reviewer's chosen display name. We have a registered DMCA designated agent. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 4, 2026 that we should disclose a reviewer's identity only in response to legal process, with notice to the reviewer where the law permits. Our Privacy Policy said so in these words:

"We disclose information that identifies you only in response to legal process, and we tell you first where the law permits, in time for you to object where practicable."

Our Terms of Service also say, as your colleague reviewed on November 10, 2026:

"We forward your counter-notice to the person who sent the notice."

A counter-notice carries the sender's name, address and phone number. Forwarding it is required by 17 U.S.C. 512(g), and it is not a response to legal process. So the two sentences disagreed. We added this to the Privacy Policy, directly after the "only in response to legal process" sentence:

"There is one exception. If you send a copyright counter-notice, we forward it to the person who sent the notice, with the name and contact details you put in it, as copyright law requires."

Our view: the exception is narrow, required by statute, and stated beside the promise it qualifies, so the Privacy Policy is now accurate.

Question: is that added sentence the right way to reconcile the two promises, or should the wording change?

**Answer (Alexander Coffin, 2026-11-19):**

Mostly yes. Putting the exception right next to the promise it qualifies is the right move. I'd still change three things in the wording.

1. Drop "There is one exception." That's a promise in itself, and a risky one. If you also share data with hosting vendors, or in an emergency, the policy is wrong again, and an absolute privacy statement that turns out false invites a deception claim under Florida's consumer protection statute (FDUTPA) or Section 5 of the FTC Act. Just state the counter-notice rule on its own. Then check the rest of the policy for any other sharing the "only" sentence doesn't cover.
2. Deal with the "tell you first" promise. The base sentence promises advance notice "in time for you to object." Forwarding a counter-notice doesn't work that way. The statute says you forward it promptly, and there's nothing for the user to object to. A user could read your exception as still promising a heads-up before you forward. Say plainly that sending the counter-notice is the notice.
3. Describe what you actually send. "Name and contact details" is vague. Section 512(g)(3) requires the counter-notice to include name, address, phone number and a statement consenting to jurisdiction. You forward a copy of the whole document, including anything else the user chose to put in it. Say that.

**What we did:** The placement stands. Applied in legal branch 7 on 2026-11-19 (item 14.10): no "There is one exception", a plain statement that we give no advance notice before forwarding, and that we forward a copy of the whole counter-notice. One check follows: read the rest of the policy for any other sharing the "only in response to legal process" sentence does not cover.

### Q66. Disclosing a legal hold, and the audit records we keep longer than the stated four years

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Florida law governs. This is one question, with one decision at the end.

Your colleagues advised us on November 4 and 6, 2026 to keep records that back our public statements, to state retention periods in our Privacy Policy, and that a litigation hold overrides routine deletion for relevant records.

We now run a daily job that deletes two kinds of record when their period ends. The job stops while a litigation hold is open. We place a hold with a written reason, for one company or for everything.

Our Privacy Policy says, under Retention:

"Agreement acceptance records: your name, your title, the company's legal name, your email address, the time and the version are kept for as long as the company has a vendor account, and for six years after it ends, or for five years after a granted subscription ends, if later, or longer while a legal hold requires it, as evidence of the agreement, even if you delete your account."

"Audit record for abuse prevention: the record of who submitted or changed what, kept for four years after the action. We pause this deletion while we are under a legal duty to preserve records, for example after receiving legal process. Four kinds of audit record are kept longer, for as long as the acceptance record they belong to: the record that an agreement was accepted, the record that the Terms of Service were accepted, the record that an account was deleted, which dates the start of the six-year period, and the record that a company was deleted from the site, which dates the six-year period when the company's record is gone."

Two further facts. While any hold is open, the job pauses all audit deletion, including for people the hold does not concern. And we keep, with no end date, a record of each deletion run. It holds internal row numbers only and no personal information. It lets us show why a record is gone.

Our view: the two hold phrases are enough disclosure, the "Four kinds" sentence is a clear exception to the four years, and the deletion-run record needs no disclosure because it holds no personal information.

Question: are the hold wording and the "Four kinds" exception above sufficient as written, and may we keep the deletion-run record without disclosing it, or does any of the three need to change?

**Answer (Alexander Coffin, 2026-11-19):**

Two of the three are fine. The hold wording needs to change. Hold wording: change it, or change the job. The acceptance-record wording is fine. The audit sentence says you pause deletion "while we are under a legal duty to preserve records, for example after receiving legal process." Your practice goes further in two ways. First, holds can be "for one company or for everything," based on your own written reason, which may come before any legal duty actually exists. Second, "the job pauses all audit deletion, including for people the hold does not concern." So someone with no connection to a dispute can have their audit record kept past four years, which the policy doesn't tell them. That's the kind of gap between what you say and what you do that the FTC Act and Florida's deceptive trade practices statute (FDUTPA) target. The cleaner fix is to scope the pause to the held company's records. If you can't, disclose that deletion of audit records generally may pause while any hold is open, and say "when we reasonably anticipate or are subject to a legal duty," not just "legal process." "Four kinds": sufficient, with one gap. The exception is clear and tied to a defined period. But think about a reviewer who accepted the Terms of Service and never had an agreement acceptance record. What does their ToS acceptance record "belong to"? Add a fallback, for example "or four years, if there is no acceptance record.\"

**What we did:** Partly applied in legal branch 7 on 2026-11-19 (item 14.11). The policy now says a hold pauses audit deletion for every record while it is open, with the trigger "when we reasonably anticipate or are subject to a legal duty". That was counsel's second option and was true of the job that day. AECI-1970 then built counsel's first option the same day, and the sentence narrowed with it: a hold for one company pauses deletion only for that company's records, and a hold for all records pauses every one. The "Four kinds" fallback is not applied, because the job's behaviour for that case is unchecked. *(Applied 2026-11-26, AECI-1971, ruling 60, in a widened form. The job now deletes these audit rows four years after the action, and the v1.1 draft names the grant and the Terms acceptance as records they belong to. See ruling 60.)* The original choice was: either the pause covers only the held company's records, or the policy says audit deletion in general may pause while any hold is open. Either way the trigger reads "when we reasonably anticipate or are subject to a legal duty". The "Four kinds" sentence gains a fallback for a Terms acceptance with no agreement record. The answer does not discuss the deletion-run record. "Two of the three are fine" covers it by implication only. Ruling 55: the job changes, so the pause covers only the held company's records.

### Q67. How long to keep an acceptance record when no vendor account ever existed or the company's record is gone

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. A vendor representative claims a company's listing by ticking a box that accepts our Vendor Terms. We record that acceptance. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 6, 2026 that we may keep the acceptance record after a user deletes their account, and we set the period at six years after the vendor account ends.

Some acceptance records have no vendor account whose end could start that period:

1. A claim we rejected. The person accepted the terms, and no account was ever created.
2. An acceptance given on an older "request a listing" form, which never creates an account.
3. An acceptance whose company we later deleted from the site.

We now delete each of these six years after the latest date we hold for it. For case 1 that is the day we rejected the claim. For case 2 it is the day of the acceptance. For case 3 it is the day we deleted the company.

Our Privacy Policy now adds, under Retention:

"If a claim is never approved, we keep its acceptance record for six years after the claim is closed. Where a record has no such date, we keep it for six years after the latest date we hold for it."

Our view: a rejected claim is where a dispute over a false claim is most likely, so six years is justified, one period for every acceptance is simpler to state, and the two sentences are enough disclosure.

Question: is six years from those dates a reasonable period for an acceptance record where no vendor account existed, and are the two sentences above sufficient, or should the period or the wording change?

**Answer (Alexander Coffin, 2026-11-19):**

Six years is fine. The two sentences need some tightening. On the period. In Florida, a claim on a written contract has a five-year limitations period (Fla. Stat. § 95.11(2)(b)). Fraud has four years, but under § 95.031(2)(a) the clock runs from discovery, with a 12-year outer limit. So six years covers the contract claim with a year to spare, and it covers most false-claim fraud disputes, though not every one. That's defensible. You're right that a rejected claim is where false-claim fights are most likely. I wouldn't go longer just to chase the 12-year outer limit. That would be hard to justify as a privacy matter, and no US privacy law requires it. Keeping one period for every acceptance is also smart, because it's easier to defend and easier to run. On the wording, there are three problems. First, "never approved" isn't the same as "rejected." A claim that's still pending has never been approved, so the sentence technically covers it, and pending claims have no close date yet. Say "rejected or withdrawn." Second, "closed" isn't defined, and your internal rule says "rejected." Use one word in both places. Third, the big one: "the latest date we hold for it" floats. If someone later adds a log entry, a note, or a support ticket, the date moves and the clock restarts. That gives you an open-ended retention period while the policy reads like a fixed one, which is the kind of gap the FTC looks at under Section 5. You already know the three triggers, so name them.

**What we did:** Six years stays. Applied in legal branch 7 on 2026-11-19 (item 14.12), in the words of rulings 48 and 50: "rejected or withdrawn" in place of "never approved" and "closed", and the three start dates named in place of "the latest date we hold". The build check of 2026-11-19 confirmed the three dates are fixed: a decline is dated by `vendor_requests.resolved_at`, a form acceptance or one whose claim row is gone by `accepted_at`, and a deleted company by its latest `vendor.deleted` audit row. A claim has no withdrawn or expired state, so the policy names only the decline. Ruling 48's "withdrawn or expires" describes states that do not exist for a claim.

### Q68. Does changing a policy that our Vendor Terms incorporate count as changing the Vendor Terms

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Vendors claim their listings under our Vendor Terms. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 4, 2026 to name the policies our Vendor Terms incorporate by version and date, and we did. Our Vendor Terms say:

"The Listing Accuracy Policy and the Review Guidelines, each as numbered and dated at those links, are part of these terms and bind you as if set out in them."

They also say, under Changes to these terms:

"When we change these terms, we email every seat at the company and the billing email at least 30 days before the new version takes effect, unless the change is required by law or fixes an error, in which case it may take effect sooner."

The two policies are public pages that also govern readers and unclaimed listings. When we change one of them, we show a notice on every page of the site for 30 days before the new version takes effect. We do not send the vendor email for a policy change. We record, on each claim, which version of each policy the vendor accepted.

Our view: a policy change is not a change to the Vendor Terms document, so the 30-day site notice is enough, and the vendor email is owed only when the Vendor Terms themselves change.

Question: when we change the Listing Accuracy Policy or the Review Guidelines, do our Vendor Terms require us to send claimed vendors the 30-day email, and does a vendor stay bound to the policy version it accepted until it accepts a new one?

**Answer (Travis Russell, 2026-11-19):**

Yes, I would send the email. And yes, the vendor likely stays bound to the version it accepted.

Your terms say the policies, as numbered and dated, are part of the terms and bind the vendor as if set out in them. That makes them part of the contract. So a new policy version is a change to what the vendor agreed to, even if the Vendor Terms page itself doesn't change.

If a court finds the clause unclear and can't sort it out from the rest of the contract, Florida law lets it read the language against the party that wrote it, which is you. And a site banner probably won't count as the email you promised.

Because you tied the policies to a specific number and date, the vendor is bound to that version. A new version likely doesn't bind it until you follow the change process in your terms, or it accepts the new version.

The simple fix is to send the 30 day email for policy changes too, or use the email process once to amend the change clause so it spells out how policy updates work.

**What we did:** Our view was wrong. A change to the Listing Accuracy Policy or the Review Guidelines is a change to what a vendor agreed to. The site notice is not the promised email. A vendor stays on the policy version it accepted until we follow the change process. Nothing is in force yet, so no vendor is affected today. Two routes: the publish flow sends the 30-day email for the two policies as well, or the change clause is amended to say how policy updates work. Ruling 54: the publish flow sends the 30-day email for the two policies as well. It closes the open item in the legal README. *Built 2026-11-19 by AECI-1969:* a policy version publishes on `/admin/legal`, goes to every seat and the billing email of each claimed company by the Vendor Terms change notice, and switches in only once published. A company the email did not reach stays on the version it accepted, and its admin Billing tab says which version that is.

### Q69. Giving the first in-force Vendor Terms a new version number

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 11, 2026 that a vendor who accepted a draft marked "not yet in force" is not moved to the final version by an email, and must accept the final version in the portal. We built that screen. Every acceptance so far was of a draft: versions 1.0 to 1.3 of our Vendor Terms. We plan to publish the first in-force Vendor Terms as version 1.4, even if its words equal 1.3, so that no record ever shows a draft number as binding. Each company's owner then accepts 1.4 once on the portal screen. Until an owner accepts, the portal opens only that screen.

Our view: a new version number for the first in-force version is the cleaner record and creates no gap in what binds a vendor.

Question: is publishing the first in-force Vendor Terms under a new version number, with one portal acceptance per company, sound, or does it leave any gap in what binds a vendor before that acceptance?

**Answer (Travis Russell, 2026-11-19):**

Yes, that is a sound approach. Giving the first version in force its own number, and getting one clear portal acceptance for it, makes a clean record. It doesn't matter that the words match 1.3. What matters is that each vendor clearly agreed to the terms that are actually in force.

The new number doesn't create a gap, but there is a window. Version 1.4 doesn't bind a company until it accepts. A draft clearly marked not yet in force is strong evidence nobody meant to be bound by it, so 1.0 to 1.3 likely don't fill that period. That doesn't mean nothing binds the vendor, other terms it agreed to, or the parties' conduct, can still create obligations. The lockout screen helps going forward, but it doesn't by itself deal with things already in place, like an existing listing, reviews, or content the vendor gave you, or with a vendor who never accepts.

So have 1.4 say it replaces all drafts, and spell out how it treats existing listings and content. Decide now what happens to a listing if a company never accepts. Keep a record of who accepted, when, and which version, and make sure that person had authority to bind the company.

**What we did:** Our view holds. The first in-force Vendor Terms take a new version number, which closes the open item in the legal README. Not applied yet. The new version gains two statements: it replaces every draft, and it covers listings and content the vendor already gave us. Ruling 24 already says a company that never accepts keeps its claimed listing behind the acceptance screen with no deadline. Counsel asks us to decide that on purpose. Ruling 58 confirms it. The acceptance record already holds who, when, which version and the authority statement.

### Q70. Three sentences changed since your colleagues' reviews: a wording check

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website. Florida law governs. We changed three sentences after your colleagues' reviews. We are asking for a defect check on the wording as written, not for new advice on the positions.

In our Terms of Service, "Our editorial judgment and search ranking are algorithmic and are never influenced by payment" became:

"Search ranking is algorithmic. Neither it nor our editorial choices are ever influenced by payment."

We changed it because a person sets a few orders by hand, such as which categories a menu shows first. No order reads a vendor's plan.

On the account deletion screen, "Reviews you've published stay online but are anonymized" became:

"Reviews you've published stay online, but they are no longer linked to your account."

We changed it because the text of a review may still identify its author.

In our Privacy Policy, under Deletion, we added:

"We also keep a copy of information that the law requires us to preserve, for example when we have received legal process about it, for as long as that requirement lasts."

Our view: each of the three sentences is more accurate than what it replaced, and none creates a new promise.

Question: is any of the three sentences above inaccurate, ambiguous, or likely to be read against us, and if so which one and how should it read?

**Answer (Alexander Coffin, 2026-11-19):**

I'd fix the first sentence. The other two mostly work but have small gaps.

Ranking and payment. This is the weak one. "Never influenced by payment" is absolute, and "influenced" is a broad word. Does a paid plan give vendors anything that feeds the algorithm, like more photos, fuller profiles or badges that improve ranking? If so, payment influences ranking indirectly, even though no order looks at the plan itself. A plaintiff or the FTC would read the sentence that way. "Search ranking is algorithmic" also sits awkwardly next to orders a person sets by hand. Suggested: "Search ranking and editorial choices do not take into account whether, or how much, a vendor pays us." Only use it if it's true of every paid feature.
Deletion screen. Mostly fine. "No longer linked to your account" is odd once the account is gone, though, and a user may read it as "my name comes off." If a display name or photo stays, that's a problem. It could also conflict with sentence 3 if a preserved copy keeps the link. Suggested: "Reviews you've published stay online. We remove your name and profile from them, but the text stays as written, so anything in it that identifies you will remain visible."
Legal process. This one is close. The catch is that receiving legal process doesn't always create a legal duty to preserve. A preservation request under 18 U.S.C. § 2703(f) does. A subpoena or a reasonably anticipated lawsuit is less clear, and suits can trigger holds the law doesn't strictly "require." So if you ever preserve in those situations, the sentence understates what you do. Suggested: "We also keep a copy of information we are legally required to preserve, or that we need to keep for an actual or reasonably anticipated legal claim, for as long as that need lasts.\"

**What we did:** All three sentences change. The legal-process sentence is applied in legal branch 7 on 2026-11-19 (item 14.14). The other two are not. Counsel gave wording for each. The ranking sentence is the weak one, and counsel's wording may be used only if it is true of every paid feature. Read with Q62, it is not true today: Managed-only trade and audience tags feed search matching and category pages. Ruling 52 settles the ranking sentence. *Applied 2026-11-26 (AECI-2230, item 14.8):* the Terms now read "Search ranking is algorithmic." followed by ruling 65's wording. The editorial-choices promise is dropped, because the Browse menu's top trades are ordered by product count (ruling 63). The deletion-screen wording needs one check first: that a deleted account's display name and photo really come off its reviews.

Q71 and Q72 are batch 7, asked on 2026-11-23. They restate the Q62 and Q56 follow-ups, which got no reply.

### Q71. Replacement wording for "No plan changes where you rank or appear"

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 19, 2026 that this sentence in our Vendor Terms and our Managed plan agreement is false as written, and that a disclosure on a separate public page does not cure it:

"No plan changes where you rank or appear, or whether a review is published."

The reason is this. Products carry tags for the trades and audiences they serve. We set every tag when we list a product. A vendor can change the trades and audiences on its own product only while that product is on our paid Managed plan. A product is listed on a trade or audience page only if it carries that tag. So a paid plan can change where a product appears. No list of products reads the plan, and no plan moves a product up or down any list.

We will replace the sentence, not qualify it. The same wording would be used in the Vendor Terms, the Managed plan agreement, our Terms of Service and our public page "How ranking works". The words about reviews stay as they are. The proposed wording is:

"You cannot buy a position. Search order and list order never read a vendor's plan or what it pays us. A paid plan lets a vendor describe its product in more detail, such as the trades and audiences it serves. A product described in more detail can match more searches and appear on more category pages. That comes from what the listing says, not from the payment."

Our view: this states what our ranking reads, not an outcome, so it stays true as we add paid features, and it tells a vendor and a reader plainly that a paid plan can put a product in more places.

Question: does that wording fix the problem your colleague described, or is any part of it still likely to be read against us, and if so how should that part read?

**Answer (Travis Russell, 2026-11-24):**

The new wording is much better and mostly fixes the problem, because it now tells vendors and readers that a paid plan can put a product in more places. Two parts could still be read against you.

The last sentence, "That comes from what the listing says, not from the payment," is the weak spot. Only paying vendors can change their tags, so the wider placement does come from paying, even if the ranking formula never looks at the plan. Under FDUTPA the question is whether a statement is likely to mislead a reasonable reader in context, and Florida courts may read a truly ambiguous contract term against the drafter as a last resort. A reader could take that sentence as denying a link that plainly exists. Drop it, or say it directly, such as "Only vendors on a paid plan can change these details."

"You cannot buy a position" has a similar risk, since a vendor can pay its way onto more category pages, which some readers would call a position. Tie it to order instead, such as "Payment never changes the order in which products are listed or returned in search."

A version that holds up better reads: "Payment never changes the order in which products are listed or returned in search. A paid plan lets a vendor edit the trades and audiences tagged on its product, which can help it match more searches and appear on more category pages." Then confirm your practice matches it, including any future featured or sponsored spots. New wording also will not undo any claim tied to the old sentence while it was in use.

**What we did:** The approach of ruling 52 holds. Two parts of our draft do not: "You cannot buy a position" and "That comes from what the listing says, not from the payment". Counsel gave replacement wording that ties the promise to order. Not applied yet. Our question named only trades and audiences. A paid plan also lets a vendor set phases and add data to its integrations, and both can put a product in more places, so the second sentence must name them or say "such as". Chris ruled the final wording on 2026-11-24 (ruling 65). It is text item 14.8 and gates the first effective date. *Applied 2026-11-26 (AECI-2230):* in place in Vendor Terms 1.3, Managed plan agreement 1.1, Terms of Service 1.1, the unpublished How ranking works 1.2 and `/methodology`, with no version bump. The Plans page moved to 1.6 to quote the portal plan panel line, which now reads "Payment never changes the order in which products are listed or returned in search, or whether a review is published." The claim-approved email and `/docs/vendors/overview` say the same. Counsel has not seen the "such as" widening, the new heading "Plans, listing order and reviews", or the review sentence "No plan changes whether a review is published." All three go on the sign-off brief.

### Q72. Email consent in Canada and the United Kingdom for one unticked opt-in box

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. This is one question about Canada and the United Kingdom only.

A signed-in reader may save a private list of the software their firm uses. We plan to email that reader when something relevant changes, for example: "Product X now integrates with Product Y, which is on your list." We write and send the email. No vendor pays for it or receives the reader's address.

When a reader first saves a list, we show one unticked box: "Email me when something changes for software on my list." We send these emails only to readers who tick it. The text beside the box names us, says what the emails cover, and says the reader can withdraw at any time. We record who ticked it, when, and the wording shown. Every email carries an unsubscribe link and our postal address.

Your colleague advised us on November 16, 2026 that this is enough in the United States, and that in the EU we should also send a confirmation email before the first send. That answer did not cover Canada or the United Kingdom.

Our view: the same box, text and record give valid express consent under Canada's anti-spam law (CASL) and under the UK's Privacy and Electronic Communications Regulations, with no further step.

Question: for a reader in Canada under CASL, and a reader in the United Kingdom under PECR, is that box with that text and record enough, or what else must sit beside the box or be done after it?

**Answer (Alexander Coffin, 2026-11-24):**

In the UK, yes. In Canada, nearly, but you need one addition beside the box. Canada. I'm assuming these emails count as commercial electronic messages. They point readers to products, so the CRTC would probably say they do. The unticked box is fine, and so is your record of who ticked it and when. The gap is in what sits beside the box. Under s. 10(1) of CASL and the CRTC's Electronic Commerce Protection Regulations, the consent request has to:

name you; say what the emails are for; say the reader can withdraw; give your mailing address plus one other contact point (a phone number, email address or web address).

You've covered the first three. You haven't covered the fourth. So add the postal address and a link or email address next to the box, or link to a contact page. Also check how the emails work. Each one needs a working unsubscribe that stays live for 60 days, and you must act on an unsubscribe within 10 business days. CASL doesn't require a confirmation email, although sending one does no harm. UK. Regulation 22 requires consent to the UK GDPR standard: freely given, specific, informed and unambiguous. An unticked box that names you and says what the emails cover, with withdrawal available at any time, meets that. Your record helps show consent if the ICO asks. Regulation 23 covers the rest, since every email identifies you and gives a valid opt-out. Double opt-in isn't required. The UK GDPR does expect a privacy notice, so a link next to the box is sensible. One point in your favour: many readers will use firm addresses. Regulation 22 doesn't apply to corporate subscribers, so for them only regulation 23 matters (sole traders and some partnerships still count as individuals). The Data (Use and Access) Act 2025 raised PECR fines, which makes it worth getting this right, but it doesn't change this analysis.

**What we did:** Our view holds in the UK and nearly holds in Canada. Nothing built yet. This completes Q56, whose follow-up got no reply. Build rules for the box, in every country: beside it sit our postal address and one other contact point, or a link to a contact page that has both, and a link to the Privacy Policy. Every email's unsubscribe link works for at least 60 days, and we act on it within 10 business days. No confirmation email is needed for Canada or the UK.

Q73 is batch 8, asked on 2026-11-25 from AECI-2035, the Sync Services work.

### Q73. A vendor removing a third company's integration listing from its product, with no review by us

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory of construction-industry software and the integrations between products. Florida law governs. This is one question, with one decision at the end.

Some integrations between two products are built, sold and run by a third company. We call that company's product a Sync Service. The Sync Service is not either of the two products. It may list the integrations it delivers between any two products on our site, and we tell the vendors of both products when it does.

We plan to give the vendor of either product a right to remove such an integration from its own product's listing. The integration may be real, and the listing may be accurate. Our Listing Accuracy Policy would say:

"We do not review a removal. It takes effect when the vendor sends it, and the integration is taken off the public site at once. The Sync Service cannot restore the integration or add it again. The vendor that removed it can withdraw the removal. We may end a removal where it was sent from an account that should not have had access to that product, where the vendor's claim to that product ends or is suspended, or where the law requires it. We tell both vendors why."

The same policy says elsewhere: "We will not remove an accurate listing simply because a vendor asks us to." The new section would be stated as an exception to that sentence.

Three more facts. The policy is part of our Vendor Terms, which a company accepts when it claims its listing. A Sync Service that has claimed its listing has accepted them. A Sync Service that has not claimed its listing has no contract with us. Our Terms of Service say we have no obligation to list anything.

Your colleagues advised us on November 4, 2026 that we need not remove an accurate listing at a vendor's request, that a neutral rule disclosed in advance and applied evenly is a justified basis for a ranking or listing outcome, and that our time limits and policies cannot bind a company that never accepted them.

Our view: we are free to decide what our directory lists. A removal rule that is published, applies to every Sync Service alike and is triggered by the vendor whose product is named gives the Sync Service no claim against us, whether or not it has a contract with us. Taking an accurate integration off the site is an omission, not a false statement.

Question: does this removal right expose us to a claim by the Sync Service, such as tortious interference or a deceptive-practice claim, and if so what must the policy say or what step must we add before a removal takes effect?

**Answer (Kyle Usrey, 2026-11-26):**

Yes, instant, unreviewed removal creates real litigation and cost exposure, even without a contract with the third company. While strong defenses may exist, a disgruntled third party can still sue, and claims under FDUTPA carry potential prevailing-party attorney's fees.

Where Your Exposure Comes From

Tortious Interference with a Business Relationship: Under Florida law, a plaintiff must show (1) an existing or identifiable business relationship, (2) your knowledge of it, (3) intentional and unjustified interference, and (4) damages. If the third company sells integrations to customers or partners, it can argue an automatic, unreviewed takedown (especially of an accurate listing) disrupts those relationships without justification. Defenses like business justification or Section 230 may help, but fact disputes often survive early dismissal.

FDUTPA (Fla. Stat. § 501.201 et seq.): Businesses can sue other businesses under FDUTPA for unfair or deceptive acts or practices in trade or commerce that cause actual damages. If your site promises "open" or "independent" integration listings while silently allowing vendors to wipe out accurate third-party listings on demand, a claimant could frame that gap as unfair or misleading.

What Your Policy Should Say

No Right to Listing or Placement: State clearly that listing on the directory is discretionary, revocable, and confers no property, exclusivity, or continued-visibility rights.

Vendor / Ecosystem Controls: Explicitly disclose that product vendors may control or request removal of listings associated with their products, ecosystems, or APIs, even if the listing is accurate or complies with general directory rules.

No Guarantee of Accuracy or Neutrality: Clarify that the directory does not endorse, verify, or guarantee ongoing availability of third-party integrations, and may remove or hide content without prior notice or investigation.

**What we did:** Our view was too confident. The removal right creates real exposure to a tortious interference or FDUTPA claim, even from a Sync Service with no contract with us. Not applied yet. Counsel gave three things the policy should say: a listing is discretionary and revocable and gives no right to stay visible; a product's vendor may remove a listing tied to its product even when it is accurate; and we do not guarantee that a third party's integration stays listed. The answer ran out of space before it reached the second half of the question, which asked what step to add before a removal takes effect. That half is re-asked as Q74. Counsel's "no guarantee of neutrality" is not adopted as worded, because the site's own promise is that it is independent. The disclosure of the vendor's removal right is what closes the gap counsel described. Q74 answers it: a removal stays instant.

### Q74. What step, if any, to add before a vendor's removal of a third company's integration listing takes effect

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory of construction-industry software and the integrations between products. Florida law governs. This is one question, with one decision at the end.

Your colleague advised us on November 26, 2026 on a planned rule in our Listing Accuracy Policy. Some integrations between two products are built, sold and run by a third company, which we call a Sync Service. Under the rule, the vendor of either product can remove such an integration from its own product's listing. The removal takes effect at once, with no review by us, even where the listing is accurate. The Sync Service may have no contract with us.

Your colleague said this creates real exposure to a tortious interference claim and a claim under FDUTPA, and told us what the policy should say: that a listing is discretionary and revocable, that a product's vendor may remove a listing tied to its product even when it is accurate, and that we do not guarantee a third party's integration stays listed. We will add all three. The answer ran out of space before it reached the process itself.

We are choosing between three ways to run a removal:

A. As planned. The removal takes effect at once. We tell the Sync Service at the same moment, with the vendor's stated reason. The Sync Service can write to us, and we end a removal only on narrow grounds, such as one sent from an account that should not have had access.

B. Notice first. We tell the Sync Service and the listing stays up for a short fixed period, such as five business days. The removal then takes effect without our review, unless the vendor withdraws it.

C. Instant, with a required reason and a record. The removal takes effect at once, but the vendor must pick a reason from a fixed list, such as "we do not support this integration" or "it is not offered for our product". We keep the reason and the time. We tell the Sync Service at once and say how to object.

Our view: with the three disclosures added, option C is enough. A recorded reason given by the vendor whose product is named is a business justification, and immediate notice to the Sync Service with a way to object shows the interference is not unjustified. A waiting period adds little, because we do not review the removal either way.

Question: which of these three processes best protects us against a tortious interference or FDUTPA claim by the Sync Service, and is option C enough, or do we need the waiting period in option B or a review of our own?

**Answer (Alexander Coffin, 2026-11-26):**

Option C gives you the most protection, and it's enough. A waiting period or your own review probably wouldn't add much. But I'd change two things, and I'd adjust one part of your reasoning. The adjustment first. The vendor's recorded reason justifies the vendor's conduct, not automatically yours. Your own protection comes from acting on a published, disclosed, evenly applied policy about your own directory. That's why the three disclosures matter more than the timing. Under Florida law the Sync Service would also have to show actual relationships with identifiable customers that you knowingly and unjustifiably disrupted, not just lost reach in the market. That's a real hurdle for them, whichever option you pick. So why not B? The waiting period cuts damages a bit, since the Sync Service gets five days to warn its customers. It doesn't change whether you're liable, though, because you still don't review anything. And it builds a lag into a policy you're describing as the vendor's right. Small gain, real friction. The real FDUTPA risk is what the page says, not how fast the removal happens. If the vendor picks "it is not offered for our product" and that's false, and your site shows it, you've published something misleading. So:

Show the public a neutral label, something like "removed at the request of [Vendor]." Keep the vendor's chosen reason in your internal record and in the notice to the Sync Service, not on the listing. Make the objection process actually able to reinstate a listing on narrow grounds. Unauthorized account, wrong product, or a reason that's plainly false on its face, say where the vendor's own public materials show it supports the integration. An objection channel that can never change anything looks like a formality.

**What we did:** Option C stands: a removal stays instant, with a required reason from a fixed list, a record, and notice to the Sync Service at once. No waiting period and no review of our own. Not applied yet. Our protection is the published, evenly applied policy, so Q73's three disclosures matter more than the timing. Two changes follow. The vendor's reason is never shown to the public. It goes in our record and in the notice to the Sync Service. And an objection must be able to reinstate a listing on narrow grounds: an account that should not have had access, the wrong product, or a reason plainly false on its face. Ruling 66 settles both: the public sees nothing, and the "plainly false" ground is added.

## Chris's rulings

1. **Ban structure (Q13, 2026-11-05).** Suspend at once; written notice with evidence; 7 business days to cure or rebut, a further 7 on a false-claim finding; then subscriptions end with a pro-rata refund of the unused term less fees for the period used and the itemised cost of the abuse (staff time at $150 an hour logged at the time, costs paid to others, only where the breach caused them, recoveries credited, never more than the refund due). Ending a subscription ends the edit right; the vendor keeps ownership of its text.
2. **Indemnity super-cap (Q6).** The greater of $10,000 or ten times the fees paid in the trailing twelve months; fraud, wilful misconduct and gross negligence, IP infringement by submitted content, breach of confidentiality and violation of law stay uncapped; one-way.
3. **Brand assets after a claim ends (Q12).** Badge off at once; uploaded logos and screenshots removed within 14 days, sooner where possible.
4. **Updated reviews (Q18).** Build 'Add an update': original kept, dated addendum, latest rating counts (AECI-1613).
5. **Captions (Q19, Q4).** 'Maintained by {Vendor} · updated {date}' and 'Maintained by {Vendor} until {date}' on vendor-maintained fields; 'Corrected by AEC Integrations on {date}' on operator corrections (AECI-1614, AECI-1628). *Since AECI-1666 (2026-11-17) these captions sit in one "About this listing" panel per page, not under each field group. The wording is unchanged.*
6. **Correction deadlines (Q21).** Hide or flag within two business days of proof; correct within five if verified.
7. **Renewal refund (Q2).** The 14-day full refund applies after a renewal charge too.
8. **Removal election (Q4).** A vendor may have its own authored fields removed within 30 days after its plan ends.
9. **Logos on unclaimed listings (Q12 follow-up, 2026-11-11).** Keep small sourced logos, never as a badge or header, with the Unclaimed and not-affiliated line beside them, removed at once on objection (AECI-1618).
10. **EU and UK visitors (Q26, Q29, 2026-11-06).** Keep serving them; no geo-block; rights section stays; GDPR and state addenda under AECI-309.
11. **Acceptance-record IP and browser (Q27).** Deleted 90 days after acceptance (AECI-1636).
12. **Reader-account changes (Q34).** Email every account holder before a material change; click-to-accept at next sign-in for rights-reducing changes; prospective only (AECI-1637). The site banner (AECI-1592) stays for visitors. Since 2026-11-13 the click is the sign-in itself (ruling 43). Ruling 53 (2026-11-19) narrows that: a rights-reducing version needs a ticked box at the first sign-in after it.
13. **Jury waiver (Q35).** Mutual jury-trial waiver in the Managed plan agreement and the Vendor Terms only, not the Terms of Service.
14. **Connector-delivered integrations (2026-11-09).** Claim, edit and contest are open to every claimed owner, with no Managed gate (AECI-1663, text item 12.17).
15. **Tamper-evident acceptance record (AECI-1615 review, 2026-11-11).** Yes: a nightly export of the fingerprints (SHA-256 hashes) of acceptance and grant rows, not the rows themselves, to a hash-chained file in a locked R2 prefix, with a DigiCert RFC 3161 timestamp on each file. The IP address and browser are left out of the fingerprint. *Built 2026-11-17 (AECI-1680, ADR 0057).* R2 has no object versioning, so a bucket lock holds the files instead.
16. **Stored checkbox wording (AECI-1615 review, 2026-11-11).** Yes: the acceptance row stores the label text itself, not a hash, and a flag that the box started unticked. Built 2026-11-11 (AECI-1619): `checkbox_label` holds the text, and the hash column stays beside it.
17. **Retention clause in text item 13.5 (2026-11-11).** Yes: 'or five years after a granted subscription ends, if later'.
18. **Direction of the liability cap (Q39, 2026-11-11).** One-way: the cap and the lost-profits exclusion limit what we can owe, not what the vendor owes (items 13.6 and 13.7).
19. **Jury waiver acknowledgment (Q39, 2026-11-11).** No separate acknowledgment beyond the labelled bold paragraph and the required box.
20. **Refund deduction and the caps (Q39, 2026-11-11).** Yes: the deduction sits outside our liability cap and is credited against the vendor's indemnity for the same breach (item 13.9).
21. **Where the browser report runs (Q37, 2026-11-11).** Held in the EEA, the UK and Switzerland, the same as the bot check. Built by AECI-1714.
22. **Accessibility statement (Q40, 2026-11-11).** Publish it, with a reply window of 10 business days (AECI-1673).
23. **Platform gate issues (2026-11-11).** Build AECI-1621, AECI-1622 and AECI-1638 before any effective date. No text is softened.
24. **Vendor re-acceptance (Q42, 2026-11-11).** Until an owner seat accepts the in-force Vendor Terms, the portal opens only the acceptance screen. Any owner seat accepts for the company, the listing stays claimed, and no deadline ends the claim (AECI-1677).
25. **Later rights-reducing changes to the Vendor Terms (Q42, 2026-11-11).** Yes: a change that reduces a vendor's rights under the liability, indemnity, disputes or content license sections applies to a company only after an owner seat accepts it in the portal, mirroring ruling 12 (text item 13.12, AECI-1677).
26. **Third-party material in vendor uploads (Q50, 2026-11-15).** Before the first effective date, the Vendor Terms gain a specific warranty for third-party material with a duty to redact. Privacy, name and likeness, data-protection and third-party confidentiality claims are named in the indemnity and in its uncapped list. "Your breach of confidentiality" covers a duty owed to anyone (text items 14.1 to 14.4, AECI-1363).
27. **Service providers in the content license (Q53, 2026-11-15).** The license gains a sentence authorising our service providers to act for us, in the first in-force versions (text item 14.5). If it lands after an effective date, it applies to a company only after an owner seat accepts it in the portal, under ruling 25.
28. **Notice at the first effective date (Q60, 2026-11-15).** Yes: a short notice or email goes out when the first versions take effect, though counsel said none is strictly owed. *Built 2026-11-26 (AECI-1870).* Ruling 68 sets the audience, the band and the wording.
29. **EU and UK side of screening (Q53, 2026-11-15).** Not re-asked now. It goes back as one question when the screening job is scheduled.
30. **Customer quotes (Q45, Q48, 2026-11-16).** Left out of Enhanced 1.0. No quote that names a person is published on a vendor's word alone. If quotes return, the person quoted confirms to us directly first.
31. **Caption on Enhanced blocks (Q44, 2026-11-16).** "Supplied by {Vendor}". The "Maintained by" caption on Managed fields under ruling 5 is not changed by this ruling.
32. **Vendor usage totals (Q57, 2026-11-16).** A total refreshes monthly and never live, so a vendor cannot watch it change. The Vendor Terms gain a promise not to identify the accounts behind a total.
33. **Public usage count wording (Q58, 2026-11-16).** "N accounts on AEC Integrations say they use this", with "Self-reported. Counts accounts, not firms." directly under the number.
34. **Brand colours on unclaimed listings (AECI-1826, 2026-11-16).** None, on any page, including the product's own page. This is tighter than the redesign plan's §4.5.
35. **Caption on Managed fields (Q44, 2026-11-16).** Stays "Maintained by {Vendor}". Ruling 5 stands. "Supplied by" is for Enhanced blocks only.
36. **Ranking page says what a plan buys (Q44, 2026-11-16).** Add it now, in quiet wording, not when Enhanced ships. The page is versioned, so this is a version bump.
37. **Legal basis for the saved software list (Q55, 2026-11-16).** One notice at first save, not called consent. Contract for the reader's own filtering, legitimate interests for the vendor total, a written balancing test on file, and a switch on the account page that leaves a list out of the totals. This replaces the consent approach of 2026-11-13.
38. **Groups in the saved software list (Q59, 2026-11-16).** A reader groups products however they like, under a free-text label. It is a general grouping tool, not an office list. Counsel named free text as the exposure, and Chris accepted it. Labels never leave the account and are in no total, report, email or analytics event. Deletion on an employer's notice is fast and complete.
39. **Public usage count (Q58, 2026-11-16).** Removed. A count of accounts is not useful, and only a count of firms would be. Ruling 33 is spent.
40. **Vendor usage totals are shown as bands (Q57 follow-up, 2026-11-17).** A vendor sees a band such as "5 to 9", "10 to 24" or "25 to 49", never the exact number. This adds to ruling 32: monthly refresh, a floor of 5 and the vendor's promise all stay.
41. **"Unclaimed" tag in the sticky bar (Q61, 2026-11-17).** Add a short "Unclaimed" tag beside the product name in the sticky bar on an unclaimed listing, at least to see how it looks. Counsel called it optional, so removing it later needs no counsel question. *Built 2026-11-18 (AECI-1931).* The tag reads "Unclaimed" beside the name in the product page's stuck section bar. Below `md` the bar shows no name, so since 2026-11-22 it shows no tag either, as the ruling's "beside the product name" reads (AECI-1931 follow-up). A claimed listing's bar is unchanged. *Removed 2026-11-23 (AECI-2012), Chris: "let's remove it from the sticky bar for now, but still show."* The bar now shows only the name on every listing. The Unclaimed note stays in the hero.
42. **Vendor reply inside the review card (AECI-1872, 2026-11-17).** The redesigned layout stays: the reply sits in its own labelled, dated panel inside the review card, after the review text. The Review Guidelines sentence "It is never shown as part of the review" is reworded to say the response appears after the review text in its own labelled panel and is never mixed with the reviewer's words (text item 14.6). The text merges with or before the layout. No counsel question was asked.
43. **Signing in is the acceptance (Q34, 2026-11-13).** For the Terms of Service, the sign-in page shows one line beside the sign-in buttons, "By signing in, you agree to our Terms of Service and Privacy Policy.", and the sign-in is the click. Each sign-in logs the acceptance of the Terms version in force (AECI-1637). There is no separate acceptance screen and nothing is blocked. A rights-reducing version applies to an account holder from their next sign-in, never on continued use (ruling 53, 2026-11-19, narrows this: that sign-in shows a tick box, and the version applies once it is ticked). This replaces the click-to-accept screen in ruling 12. The vendor portal is unchanged (ruling 24). Recorded on `main` as ruling 26 until the two lists were merged on 2026-11-18.
44. **The copyright notice log (Q38, 2026-11-17).** Account deletion clears the account from a notice and keeps the notice. A deleted and re-created account starts with a clean count. Notices are kept three years after they close, the limitation period for a copyright claim, pending counsel's view. The repeat-infringer count is notices that led to a takedown. A notice we took no action on, and a takedown restored after a counter-notice, do not count. Counter-notices the account filed show as a second number (AECI-1665). Recorded on `main` as ruling 27 until the two lists were merged on 2026-11-18.
45. **A legal hold and a reviewer's own deletion (Q25, AECI-1683, 2026-11-17).** No hold flag. A reviewer's account deletes as it does today, and nothing blocks or delays it. The subpoena runbook exports the reviewer's record on the day legal process arrives, before any notice goes to the reviewer. The Privacy Policy's "Deletion" section gains one sentence: "We also keep a copy of information that the law requires us to preserve, for example when we have received legal process about it, for as long as that requirement lasts." (text item 14.7). The retention prune keeps its own hold (AECI-1638), which pauses a scheduled deletion and blocks no user's deletion.
46. **Terms of Service, what is algorithmic (AECI-1857, 2026-11-18).** "Our editorial judgment and search ranking are algorithmic" became "Search ranking is algorithmic. Neither it nor our editorial choices are ever influenced by payment." Some orders are set by a person, so only the payment promise is stated for editorial choices. Applied in legal branch 6. Counsel has not seen the sentence, and Q62 may touch it again. *Superseded 2026-11-26 (AECI-2230):* item 14.8 replaced "Neither it nor our editorial choices are ever influenced by payment" with ruling 65's wording.
47. **Wording for reviews after an account is deleted (AECI-1915, 2026-11-18).** The account page and its confirmation dialog say published reviews "stay online, but they are no longer linked to your account". The word "anonymized" is not used, because a review's text can still identify its author. Applied in legal branch 6.
48. **An acceptance from a claim that was never approved (AECI-1914, 2026-11-18).** Kept for six years after the claim closes, then deleted. A claim closes when it is declined, withdrawn or expires. This is the same period as every other acceptance. It needs one clause in the Privacy Policy's "Retention" and one rule in the legal retention prune. *Built 2026-11-18 (AECI-1914).* The claim close is dated by `vendor_requests.resolved_at` on a rejected claim, because no withdraw or expiry exists in the code.
49. **No IP address or browser on a portal acceptance (2026-11-18).** The portal acceptance screen keeps recording no IP address and no browser. The owner seat is signed in, and the record holds the account, name, title, email, time, version and box text. An IP address adds little to that, and it would be deleted after 90 days, before most disputes arise. A claim still records both, because a claim comes from a person we have not yet verified. No text or code changes. `PORTAL_RECORDS_EVIDENCE` stays `false`.
50. **Acceptances that ruling 48 cannot date (AECI-1914, 2026-11-18).** No acceptance is kept without an end date. An acceptance from the old "Not listed?" form, which has no vendor and no claim, is deleted six years after it was accepted. So is an acceptance whose claim was deleted by hand. An acceptance whose vendor was deleted is deleted six years after the vendor's deletion. If that date is missing, the row is kept and counted in a data-quality check for a person to look at. The Privacy Policy's "Retention" gains: "Where a record has no such date, we keep it for six years after the latest date we hold for it." Two points were added the same day. First, the `vendor.deleted` audit record that dates a deleted company's acceptances is kept past four years, for as long as an acceptance or grant still names that company, and is deleted in the same batch as the last one. The Privacy Policy's audit record bullet therefore reads "Four kinds of audit record are kept longer", and its fourth kind is "the record that a company was deleted from the site, which dates the six-year period when the company's record is gone". Second, when a company is promoted back under the same id, its acceptances are dated by the normal account end again, and the old deletion record becomes an ordinary four-year audit record. No text changes for the second point. The claim date in ruling 48 is the day the claim was rejected, because the code has no withdrawn or expired claim state. *Built 2026-11-18 (AECI-1914).* Counsel has not seen either new sentence: the catch-all and "Four kinds".
51. **Retention for the workflow tables (AECI-1913, 2026-11-18).** `workflow_instances` and `workflow_transitions` are kept four years after the action, the same as the audit record, because they record who moved a request and when. No Privacy Policy sentence changes. Built in AECI-1913 (`lib/legal-retention-prune.ts`).
52. **The ranking promise is about what ranking reads, not about outcomes (Q62, Q70, Q44, 2026-11-19).** "No plan changes where you rank or appear" and "never influenced by payment" are replaced everywhere by one wording. Its two parts: nobody can buy a position, because search order and list order never read a vendor's plan or what it pays us. And a paid plan lets a vendor describe its product in more detail, which can make it match more searches and appear on more category pages. The text says "found in more places", never "ranked higher". Trade and audience tags stay a Managed inclusion. The rule that no paid field feeds the ranking score does not change. The wording goes to counsel as a follow-up on Q62 before any page carries it. It is text item 14.8. It replaces the sentence AECI-1871 added under ruling 36 and the Terms sentence of ruling 46. *Applied 2026-11-26 (AECI-2230)* with ruling 65's final wording.
53. **Tick box for a rights-reducing Terms change (Q63, 2026-11-19).** A reader ticks a box only at the first sign-in after a version that reduces their rights. Ordinary sign-ins keep the line beside the buttons and no box (AECI-1637). Built 2026-11-19: `/auth/terms` and `POST /api/auth/terms/accept`. This narrows ruling 43. Chris confirmed two points on 2026-11-19. An account created after the change took effect never sees the box, because it never had the earlier version. Leaving the box page without ticking is not blocked: the reader stays on the earlier version, and the next sign-in asks again. The page shows the published summary of the change and a visible "Not now" link (2026-11-20, legal agent read on Q3 and Q42: summarize every material change, and acceptance must be knowing and voluntary).
54. **Policy changes get the vendor email (Q68, 2026-11-19).** A change to the Listing Accuracy Policy or the Review Guidelines goes to claimed vendors by the same 30-day email as a Vendor Terms change. The change clause is not narrowed. No policy version is published after an effective date until the publish flow covers both policies.
55. **A legal hold pauses only the held company's records (Q66, 2026-11-19).** The deletion job is changed so a hold on one company no longer pauses audit deletion for everyone. The trigger wording becomes "when we reasonably anticipate or are subject to a legal duty". *Built 2026-11-19 (AECI-1970).* ADR 0058 decision 3 says which audit rows are a company's. Counsel has not seen the new Privacy Policy sentence.
56. **How long a saved software list is kept (2026-11-19).** For as long as the account exists. It is deleted when the reader deletes it or the account.
57. **The first saved-list notice names the vendor total (Q55, Q60, 2026-11-19).** The notice at first save names the vendor total as a use, and the opt-out switch ships in the same step. The total itself stays off until its own step ships.
58. **A company that never accepts the in-force Vendor Terms (Q69, 2026-11-19).** Ruling 24 is confirmed on purpose, after counsel asked for a decision. The portal opens only the acceptance screen, the listing stays claimed, and no deadline ends the claim. The first in-force version says so in its own text.
59. **Account deletion screen wording (Q70, 2026-11-19).** Counsel's wording said we remove the name and profile from reviews. A build check showed a review never shows either. The screen will read: "Reviews you've published stay online. They never showed your name or profile, and they are no longer linked to your account. The text stays as written, so anything in it that identifies you will remain visible." This replaces the wording of ruling 47. Not built yet.
60. **Audit rows of an acceptance that no longer exists (Q66, 2026-11-19).** They are deleted four years after the action. The Privacy Policy then gains "or for four years if there is no acceptance record" (AECI-1971). *Amended 2026-11-26.* After the legal agent's review, Chris approved this sentence in place of that clause: "Four kinds of audit record are kept longer, for as long as the record they belong to: an agreement acceptance, a Terms of Service acceptance or a granted subscription. If there is no such record, they are kept for four years. The four kinds are the record that an agreement was accepted, the record that the Terms of Service were accepted, the record that an account was deleted, which dates the start of the six-year period, and the record that a company was deleted from the site, which dates the six-year period when the company's record is gone." The legal agent's Q1 (verdict `text`) widened it. A deleted company with a grant never accepted keeps its `vendor.deleted` row while the grant names it (ruling 50), so "acceptance record" alone was false. Both halves now name the grant. Its Q4 (verdict `text`) named the Terms record, which the policy never called an "acceptance record". Its Q2 (verdict `none`): an evidence-removed row whose acceptances are all gone now goes at four years, not six, which is inside this ruling. Its Q3 (verdict `none`): such a row names no company, so only a hold for all records keeps it. Counsel needs no new question. The sentence widens counsel's suggested words, so it goes on the sign-off brief as a confirm item. *Built 2026-11-26 (AECI-1971).*
61. **What a company's owners see of a claimant (Q65, 2026-11-19).** A build check found the Privacy Policy's "only in response to legal process" sentence was broken by four disclosures inside a vendor company. Three changes: the policy names all four; the notice on the claim form says the owners will see the claimant's name, title, work email, LinkedIn link and note; and a claim goes to the owners only when the form showed that notice, otherwise it comes to AECi.
62. **Every Vendor Terms and Managed plan agreement version sends the change email (AECI-1977, Q14, Q68, 2026-11-20).** From the first effective date, no version of either agreement takes effect without the change email, whatever its size. The Managed plan agreement had the same gap for monthly subscriptions, which are promised an email 30 days before a new version binds, with no material limit. Annual subscriptions are covered by the 45-day renewal notice. The Terms of Service and the Privacy Policy promise the email only for a material change and are unchanged. A version that only fixes an error or is required by law may take effect sooner than 30 days, as the change clause says, and its email says so. The change clause is not narrowed. Drafts published before the first effective date are not covered.
63. **The menu's top trades and audiences stay ordered by product count (AECI-1836, Q62, 2026-11-20).** Left as it is for now. The new ranking wording of ruling 52 says a paid plan lets a vendor set its product's trades and audiences, and that is the disclosure. Revisit if counsel's reply on that wording objects, or when a Managed vendor's tags first move a term into the menu.
64. **Logos of unclaimed products on the integrations wheel (AECI-2018, Q12, Q22, 2026-11-24).** Chris's call, made without a new counsel question. A wheel tile may show the logo of an unclaimed product. Two things carry it: a line under the wheel, "Logos identify products only and imply no endorsement or affiliation. Listings may be unclaimed.", built on counsel's Q22 notice and worded so it is true whether none, some or all of the listings shown are unclaimed, and an "Unclaimed" label in the pop-over of each unclaimed product. This widens ruling 9 and the AECI-1769 rule, which kept an unclaimed logo to the product's own page at 32px or smaller. The legal agent's read was to confirm with counsel first, because the Q12 follow-up warns that a logo in the same size and style as a claimed listing can look official even with a disclaimer. A logo still comes down at once if its vendor objects, and no vendor colour is used (ruling 34).

Rulings 52 to 58 were first recorded on a branch as 43 to 49, before rulings 43 to 51 reached it from `main`. Linear comments dated 2026-11-19 on AECI-1363 use the old numbers, and a later comment there gives the mapping.
65. **Final wording of the ranking promise (Q71, 2026-11-24).** Counsel's replacement is used, widened with "such as" because counsel gave general guidance and named only trades and audiences: "Payment never changes the order in which products are listed or returned in search. A paid plan lets a vendor edit more of its own listing, such as the trades, audiences and phases tagged on its product, which can help it match more searches and appear on more category pages." It replaces "You cannot buy a position" and "That comes from what the listing says, not from the payment" in ruling 52's draft. It is text item 14.8, for the Vendor Terms, the Managed plan agreement, the Terms of Service, How ranking works and `/methodology`. Counsel has not seen the widened sentence, so it goes on the sign-off brief. *Applied 2026-11-26 (AECI-2230):* in place in every document named, with no version bump. The section heading in both agreements is now "Plans, listing order and reviews", and each keeps "No plan changes whether a review is published." The new heading and that reworded sentence go on the sign-off brief too.
66. **How a vendor's removal of a Sync Service integration runs (Q73, Q74, AECI-2035, 2026-11-26).** A removal takes effect at once, with no waiting period and no review when it is sent. The vendor picks a reason from a fixed list. We record the reason and the time, and send both to the Sync Service at once with how to object. The public sees nothing: the integration is gone, with no note and no reason. We look at an objection on three grounds only: the removal came from an account that should not have had access, it named the wrong product, or its reason is plainly false on its face, for example where the vendor's own public materials show it supports the integration. We may also end a removal where the vendor's claim ends or is suspended, or where the law requires it. The Listing Accuracy Policy carries counsel's three disclosures: a listing is discretionary and revocable, a product's vendor may remove a listing tied to its product even when it is accurate, and we do not guarantee a third party's integration stays listed. Counsel's "no guarantee of neutrality" is not adopted.
67. **Breach notice: the processor clock, the agreements and geolocation (Q41, 2026-11-26).** Three points, ruled from the statute text and public guidance without a new counsel question. First, if a breach is at a processor, our 30 days count from the day the processor determined it, not the day it told us, because Fla. Stat. 501.171 does not say which and that is the strict reading. Second, the six processor agreements that promise only "without undue delay" are accepted as they stand. The 10-day duty is the processor's own under 501.171(6)(a), the agreements are self-serve, and we subscribe to the security notices of Supabase, Resend and Cloudflare. Third, the statute's "personal information" also covers a name with "any information regarding an individual's geolocation", which the Q41 answer did not list and the statute does not define. We treat a name with an IP address or any location as notifiable. The breach runbook is updated. No legal page changes.
68. **Notice at the first effective date: audience, band, wording (ruling 28, 2026-11-26).** Four points, ruled without a new counsel question. First, the email goes to every account holder who is not banned, vendor seats included, one email per person. A billing email that belongs to no account does not get it. A deleted account is gone, so it gets nothing. Second, the site shows a band too: "Our legal documents are now in force from {date}." with a "Read them" link to `/legal`. It runs for 14 days from the effective day, and a visitor can dismiss it like the change notice band. Third, the email wording is approved as written. The subject and heading are "Our legal documents are now in force". It says the first in-force versions took effect at 12:00 UTC on the date, and that before then each was a draft. It lists each document that took effect, with its version and date, linked to its page. One email covers every document that took effect at the same moment. It is a service email, with no unsubscribe and no attachment. Fourth, an owner seat also reads that the vendor portal will ask it to accept the Vendor Terms at its next sign-in and that its listing stays claimed while it waits, when the Vendor Terms are in the list. Everyone else reads that there is nothing to do, and that a later version that reduces their rights will be put to them at their next sign-in. The Privacy Policy draft's sentence on dismissing a notice now covers this band too. Built 2026-11-26 (AECI-1870).

Earlier rulings that shaped the questions: no arbitration or class-action waiver (AECI-312, 2026-10-14); replies to reviews open to every claimed company (2026-11-05); AECi is the website's abbreviation, never a party name (2026-11-04); 'subscription' in all copy, 'license' in code and the database (AECI-1609).

## Open items for the next counsel batch

- **Q66 follow-up: confirm the widened audit fallback wording (raised 2026-11-26, AECI-1971, ruling 60).** Counsel suggested the fallback "or four years, if there is no acceptance record". We widened it, because a company deletion record can belong to a granted subscription that was never accepted. The v1.1 draft, not yet in force, now reads in "Retention": "Four kinds of audit record are kept longer, for as long as the record they belong to: an agreement acceptance, a Terms of Service acceptance or a granted subscription. If there is no such record, they are kept for four years. The four kinds are the record that an agreement was accepted, the record that the Terms of Service were accepted, the record that an account was deleted, which dates the start of the six-year period, and the record that a company was deleted from the site, which dates the six-year period when the company's record is gone." Question: does the widened sentence still give the clear fallback you asked for?
- **Ruling 48 follow-up: acceptance records with no vendor account end (raised 2026-11-18, AECI-1914).** Some acceptance records have no vendor account whose end could start the six-year clock: a claim that was never approved, a listing request, and a company we deleted from the site. We now delete each six years after the latest date we hold for it. That is the claim's close, the acceptance itself, or the company's deletion. We keep the audit record of the company's deletion for as long as the acceptance records it dates. The v1.1 draft, not yet in force, now adds to "Retention" under "Agreement acceptance records": "If a claim is never approved, we keep its acceptance record for six years after the claim is closed. Where a record has no such date, we keep it for six years after the latest date we hold for it." The audit record bullet now reads: "Four kinds of audit record are kept longer, for as long as the acceptance record they belong to: the record that an agreement was accepted, the record that the Terms of Service were accepted, the record that an account was deleted, which dates the start of the six-year period, and the record that a company was deleted from the site, which dates the six-year period when the company's record is gone." Questions: (a) Are the two new acceptance sentences clear and enough? (b) Is the fourth kind of audit record described clearly enough?
- **Q27c and Q23a follow-up: the legal hold clause and the audit records kept past four years (raised 2026-11-17, AECI-1638).** After Q27(c) we stated two periods. Audit records are kept four years after the action. Acceptance records are kept six years after the vendor account ends, or five years after a granted subscription ends, if later. A daily job now deletes both when the period ends. Following Q23(a) and Q25(c), the job stops while a litigation hold is open. A hold covers one vendor or everything, and we place it with a written reason. Some audit records must also outlive four years, because they prove an acceptance record that is still kept: the record of the acceptance itself, of a Terms of Service acceptance, and of an account deletion, which starts the six-year clock for the Terms acceptance. We also keep the record of each deletion run, which holds only row ids, so our tamper-evident acceptance chain (ruling 15) can show why a row is gone. The v1.1 draft, not yet in force, now reads in "Retention": "Agreement acceptance records: … kept for as long as the company has a vendor account, and for six years after it ends, or for five years after a granted subscription ends, if later, or longer while a legal hold requires it, as evidence of the agreement, even if you delete your account." And: "Audit record for abuse prevention: the record of who submitted or changed what, kept for four years after the action. We pause this deletion while we are under a legal duty to preserve records, for example after receiving legal process. Three kinds of audit record are kept longer, for as long as the acceptance record they belong to: the record that an agreement was accepted, the record that the Terms of Service were accepted, and the record that an account was deleted, which dates the start of the six-year period." Questions: (a) Is "or longer while a legal hold requires it" on the acceptance record, and "We pause this deletion while we are under a legal duty to preserve records" on the audit record, enough disclosure, or must the policy say more about holds? (b) Is the "Three kinds of audit record are kept longer" sentence a clear enough exception to the four years? (c) Does keeping the deletion-run record, row ids only, with no end date need disclosure?
- **Q38 follow-up: how long may we keep a copyright notice? (raised 2026-11-17, AECI-1665).** We keep each notice and counter-notice for three years after the matter closes, including after the account involved is deleted. Three years is the limitation period for a civil copyright claim (17 U.S.C. 507(b)). Is that the right period, and may we keep the sender's and the account holder's details that long after deletion? Is the Privacy Policy wording right? It reads: "Copyright notices and counter-notices: for three years after we close the matter, as evidence if a copyright claim is brought. We keep them even if you delete your account. They are then no longer linked to your account." Fallback: a shorter period counsel names, with the deletion job (AECI-1905) set to match.
- **Q38 follow-up: confirm the counter-notice forwarding wording (raised 2026-11-17, AECI-1665).** The Privacy Policy said we disclose identifying information "only in response to legal process". Forwarding a counter-notice to the complainant, which the Terms promise and 17 U.S.C. 512(g) requires, is outside that. The v1.1 draft now adds, right after that sentence: "There is one exception. If you send a copyright counter-notice, we forward it to the person who sent the notice, with the name and contact details you put in it, as copyright law requires." Is that wording right? The Terms' "If you ask us to identify a user" sentence is limited to identification requests and is unchanged.
