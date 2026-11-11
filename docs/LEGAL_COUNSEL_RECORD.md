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

**What we did:** Change-notice emails carry version, summary, archived link and PDF; monthly purchase inside the window stays on the old version; material monthly changes need a click. Text branch 2; build AECI-1620.

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
- Ruling 16. Every acceptance row stores which checkbox was shown: the label's hash and whether it started unticked. Claim, checkout and portal grant rows write both. A signed deal writes neither, and so does a claim confirmed under an older vendor terms version.

No prune deletes an acceptance or a grant row. A grant acceptance is kept at least five years from the day the grant's last subscription ends. A subscription ends at its lapse, revoke, release or Terminate, whichever comes first, so the scheduled end date alone does not set the floor. A grant never accepted is kept five years from its withdraw or expiry. The store is append-only in D1, not cryptographically tamper-evident. The Privacy Policy draft now says a grant acceptance records the IP address and browser.

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

**What we did:** Terms link the ranking page; ranking snapshots on plan change and ranking-page versioning. Text branch 1; build AECI-1621.

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

**What we did:** Legal-process-only disclosure with notice where permitted in the policy and Terms; subpoena runbook with litigation hold on the IP hash key. Text branch 2; AECI-1622.

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

**What we did:** IP and browser dropped from acceptance records 90 days after acceptance (ruling 11, AECI-1636); retention periods stated; 'required or permitted by law' replaced. *Corrected 2026-11-10 (AECI-1615):* this line said "prune built under AECI-1638". No such prune exists. `lib/retention-prune.ts` never touches `agreement_acceptances`, and the 90-day IP and browser removal (AECI-1636) is not built. *Built 2026-11-10 (AECI-1636):* the daily `acceptance-evidence-removal` job (17:00 UTC) nulls both columns on every acceptance more than 90 days old, with one audit row per batch. The row itself is kept (`DATABASE_SCHEMA.md` §8.6d).

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

**What we did:** Email every account holder before a material change and a click at next sign-in for rights-reducing changes (ruling 12, AECI-1637); 30-day notice promise moved into the Terms. Text branch 2.

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

**What we did:** Nothing built yet. The browser report is an Article 5(3) event with no EU-wide exemption, so it cannot run in the EEA without consent. Where it runs is ruling 21, open: proposal is the same EEA, UK and Switzerland hold as the bot check. The privacy sentence ships with Phase 1 of the human-traffic floor plan. The answer does not reach (b) the Ray ID or (c) the sentence. Both are re-asked as Q43, drafted on AECI-308 and not yet answered.

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

**What we did:** Text items 13.1 to 13.4 on AECI-1363, for legal branch 5: 'will promptly notify', counter-notice consent to the user's own district, mandatory restore between 10 and 14 business days, a stated repeat-infringer policy, and DMCA notices accepted for logos. The notice log is AECI-1665. The agent renewal (2029-10-28) is in the legal README. Not yet applied to the text.

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

**What we did:** Text items 13.6 to 13.11 on AECI-1363, for legal branch 5: the liability clauses in all three documents say in plain words that they limit what we can owe and not what the vendor owes; the jury paragraph is labelled; the refund deduction is stated as outside our cap and credited against the vendor's indemnity; the precedence sentence names refunds and suspension. Rulings 18 to 20 are open. Not yet applied to the text.

### Q40. Website accessibility exposure

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. The site is free to readers. We test every interface change with the axe-core accessibility checker against the WCAG 2.1 AA standard, we run a manual keyboard and screen-reader checklist, and we fix every error and serious finding before shipping. We have no accessibility statement page. Your colleague noted on Q35 that ADA website-accessibility suits are the most likely class exposure for a free review site.

Our view: WCAG 2.1 AA is the right standard to hold ourselves to, a public accessibility statement helps show good faith, and a demand letter should get a prompt, specific response rather than silence.

Questions: (a) Does the ADA reach a US website with no physical place of business, and does Florida add anything? (b) Is WCAG 2.1 AA the standard courts and the Department of Justice apply, and does a published accessibility statement with a contact route reduce exposure or create a promise we could breach? (c) What should the first response to an accessibility demand letter contain, and within what time?

**Answer (Alexander Coffin, 2026-11-11):**

(a) Does the ADA reach you? In Florida, probably not on a website-only theory. The Eleventh Circuit that a website isn't a "place of public accommodation" under Title III. That opinion was later vacated as moot, so it isn't binding precedent. It still signals how the circuit reads the statute, and the nexus-to-a-physical-store line from Haynes v. Dunkin' Donuts helps you, since you have no store. The catch is that plaintiffs pick their forum. SDNY and some other courts have let standalone-website claims go forward. You're national and free to readers, so you can be sued wherever a reader lives. Florida doesn't add a private website-accessibility claim that I'd worry about. (b) Is WCAG 2.1 AA the standard? It's the de facto benchmark. DOJ's 2024 rule adopted it, but only for state and local governments under Title II. No Title III private-sector regulation exists. Courts and settlements use 2.1 AA anyway, so you're aiming at the right target. One caution: axe only catches a minority of real barriers, which is why your manual screen-reader pass matters. Keep records of both. The statement helps, as long as it's worded as aspiration and process. Say "we aim to conform" and "we test each release." Never write "fully compliant." Add a contact route and a response window you can actually meet. Then honor that window every time, because a missed self-imposed deadline makes great exhibit material. (c) The first response to a demand letter. No statute sets a deadline. Answer within the letter's stated deadline, and if it doesn't give one, within about 14 days. Before you write, notify your insurer, since CGL or cyber policies may require prompt notice, and send an internal hold notice to preserve documents.

**What we did:** No change to the legal documents. AECI-1673 builds a public accessibility statement worded as aim and process, with a contact route and a reply window (ruling 22, open). AECI-1674 writes the demand-letter runbook: insurer first, hold notice, reply by the letter's deadline or within 14 days. The answer does not say what the reply should contain. We did not re-ask, because the runbook step is to retain an attorney before replying.

### Q41. Breach notification obligations, and the one 1.1 acceptor

**Asked (sent as a Word attachment with the clause quoted inline):**

We are The WBS Project, Inc. (Delaware corporation, Stuart, Florida), operating AEC Integrations, a US directory and review website for construction-industry software. Florida law governs. We hold: account email addresses, optional profile answers (role, company, LinkedIn link), vendor claim records (name, title, work email, the company's legal name, and for 90 days the IP address and browser), reviews, and a monthly keyed hash of visitor IP addresses. We hold no card numbers (Stripe does), no government identifiers, no passwords (sign-in is by emailed link or Google). Your colleague cited Fla. Stat. 501.171 twice.

Our view: under 501.171 a breach of email addresses alone is not a breach of "personal information", so most of what we hold is outside the statute, but we want a plan written before we need it.

Questions: (a) Which of the data we hold counts as personal information under Fla. Stat. 501.171, and under the other state breach laws that could reach a non-resident's data? (b) If a breach occurs, who must be told, in what order, and within what time, and what must the notice contain? (c) Separately: one vendor accepted our Vendor Terms version 1.1 on November 5, 2026. We published 1.2 on November 9 with changes that narrow nothing against that vendor. Is it enough that 1.2 binds them only after the 30-day change email our terms promise, or is anything else owed to a vendor that accepted an earlier draft?

**Answer (Alexander Coffin, 2026-11-11):**

(a) What counts. Short version: you're mostly right. Under 501.171, "personal information" means a first name or initial plus last name, combined with an SSN, a driver's license or ID number, a financial account number with its access code, medical information, or health insurance information. The other branch is a username or email address combined with a password or security question and answer that would allow access to an online account. None of what you hold fits the first branch. Vendor claim records are names and work emails, and nothing more sensitive is attached. The one wrinkle is your emailed sign-in links. If an attacker gets live magic-link tokens or stored Google OAuth tokens along with the email addresses, that starts to look like the "credentials permitting access" branch. Treat that scenario as notifiable, and make sure those tokens expire fast. IP addresses and keyed hashes aren't covered by Florida's law or any other state breach law I know of. Other states like California, follow the same email-plus-credential model, and their extra categories, like biometrics, don't match your data. Each state's law follows where the affected person lives, not where you are. (b) Who, when, what.

Notify affected individuals as fast as practicable, and no later than 30 days after you determine a breach happened or have reason to believe one did. If 500 or more Floridians are affected, notify the Florida Department of Legal Affairs within the same 30 days. You can get 15 more days if you give the Department good cause in writing. If more than 1,000 people are affected, notify the consumer reporting agencies too. Under the Florida statute, the individual notice must include the date or estimated date range of the breach, what information was involved, and how to contact you. Your vendors (hosting, email) must tell you within 10 days. Add a quick check of the residence-state rules, since some have shorter deadlines.

**What we did:** No change to the Privacy Policy. AECI-1674 writes the breach runbook and records three checks: the production sign-in link lifetime, whether Google tokens are stored, and the 10-day breach-notice term in each processor agreement (AECI-310). The answer does not reach (c) the one 1.1 acceptor. That part is re-asked as Q42, widened to all six vendors who accepted a draft, drafted on AECI-308 and not yet answered.

## Chris's rulings

1. **Ban structure (Q13, 2026-11-05).** Suspend at once; written notice with evidence; 7 business days to cure or rebut, a further 7 on a false-claim finding; then subscriptions end with a pro-rata refund of the unused term less fees for the period used and the itemised cost of the abuse (staff time at $150 an hour logged at the time, costs paid to others, only where the breach caused them, recoveries credited, never more than the refund due). Ending a subscription ends the edit right; the vendor keeps ownership of its text.
2. **Indemnity super-cap (Q6).** The greater of $10,000 or ten times the fees paid in the trailing twelve months; fraud, wilful misconduct and gross negligence, IP infringement by submitted content, breach of confidentiality and violation of law stay uncapped; one-way.
3. **Brand assets after a claim ends (Q12).** Badge off at once; uploaded logos and screenshots removed within 14 days, sooner where possible.
4. **Updated reviews (Q18).** Build 'Add an update': original kept, dated addendum, latest rating counts (AECI-1613).
5. **Captions (Q19, Q4).** 'Maintained by {Vendor} · updated {date}' and 'Maintained by {Vendor} until {date}' on vendor-maintained fields; 'Corrected by AEC Integrations on {date}' on operator corrections (AECI-1614, AECI-1628).
6. **Correction deadlines (Q21).** Hide or flag within two business days of proof; correct within five if verified.
7. **Renewal refund (Q2).** The 14-day full refund applies after a renewal charge too.
8. **Removal election (Q4).** A vendor may have its own authored fields removed within 30 days after its plan ends.
9. **Logos on unclaimed listings (Q12 follow-up).** Open: keep small sourced logos with the Unclaimed and not-affiliated line beside them, or names only.
10. **EU and UK visitors (Q26, Q29, 2026-11-06).** Keep serving them; no geo-block; rights section stays; GDPR and state addenda under AECI-309.
11. **Acceptance-record IP and browser (Q27).** Deleted 90 days after acceptance (AECI-1636).
12. **Reader-account changes (Q34).** Email every account holder before a material change; click-to-accept at next sign-in for rights-reducing changes; prospective only (AECI-1637). The site banner (AECI-1592) stays for visitors.
13. **Jury waiver (Q35).** Mutual jury-trial waiver in the Managed plan agreement and the Vendor Terms only, not the Terms of Service.
14. **Connector-delivered integrations (2026-11-09).** Claim, edit and contest are open to every claimed owner, with no Managed gate (AECI-1663, text item 12.17).
15. **Tamper-evident acceptance record (AECI-1615 review).** Open: proposal is a nightly export of acceptance and grant rows to a versioned R2 bucket with a running hash.
16. **Stored checkbox wording (AECI-1615 review).** Open: proposal is to store a hash of the label text and a default-unticked flag on the acceptance row.
17. **Retention clause in text item 13.5.** Open: 'or five years after a granted subscription ends, if later'.
18. **Direction of the liability cap (Q39).** Open: confirm the cap and the lost-profits exclusion protect us only, as items 13.6 and 13.7 say.
19. **Jury waiver acknowledgment (Q39).** Open: proposal is no separate acknowledgment beyond the labelled bold paragraph and the required box.
20. **Refund deduction and the caps (Q39).** Open: the deduction sits outside our liability cap and is credited against the vendor's indemnity for the same breach (item 13.9).
21. **Where the browser report runs (Q37).** Open: proposal is the same EEA, UK and Switzerland hold as the bot check.
22. **Accessibility statement (Q40).** Open: publish it, with a reply window of 10 business days (AECI-1673).

Earlier rulings that shaped the questions: no arbitration or class-action waiver (AECI-312, 2026-10-14); replies to reviews open to every claimed company (2026-11-05); AECi is the website's abbreviation, never a party name (2026-11-04); 'subscription' in all copy, 'license' in code and the database (AECI-1609).
