# Legal documents

Markdown source of truth for the `/legal/*` pages: the four launch-required ones (AECI-237, Phase 7.2)
and the two vendor agreements from `docs/VENDOR_SIGNUP_PROCESS.md` §4 (AECI-1359, AECI-1360).
These files are the **canonical, versioned source** for the `/legal/*` pages — the site renders
the current version of each on SSR. See `STAGE_1_SPEC.md` §13 (required documents) and §27
(lifecycle) for the governing spec.

**Glossary (AECI-1609).** "Subscription" in copy is "license" in code and the database. Copy about Stripe's one object says "your billing" or "your Stripe plan". Engineering docs say "Stripe subscription".

> **These files are NOT loaded as runtime assets.** They are inlined into the bundle at build
> time via the esbuild `text` loader (`"loader": { ".md": "text" }` in `apps/web/angular.json`)
> and parsed by the content registry at `apps/web/src/app/legal/legal-content.ts`. Editing a file
> here changes the rendered page on the next build/deploy.

**Not in this registry: the accessibility statement.** `/accessibility` renders
`../accessibility.md` on the `/methodology` pattern. It is hidden until AECI-1687. It has no version, archive or change
history, because nobody accepts it. Its wording rules are `STAGE_1_SPEC.md` §27.6, and its legal
triggers are in `docs/LEGAL_IMPACT_REVIEW.md` §3.

## Files ↔ routes

The route slug (short, public, set by the footer links) maps to a long filename per spec §27.1.
The mapping lives in `LEGAL_SOURCE_FILES` (`app/legal/legal-slugs.ts`, re-exported by
`app/legal/legal-manifest.ts`). Eager code imports `legal-slugs.ts` only, so the version lists in
`legal-manifest.ts` stay out of the initial bundle:

| Route (public)                  | Source file                   | Frontmatter `title`     |
| ------------------------------- | ----------------------------- | ----------------------- |
| `/legal` (index, AECI-2237)     | none: one row per slug below  | Legal                   |
| `/legal/terms`                  | `terms-of-service.md`         | Terms of Service        |
| `/legal/privacy`                | `privacy-policy.md`           | Privacy Policy          |
| `/legal/review-guidelines`      | `review-guidelines.md`        | Review Guidelines       |
| `/legal/listing-accuracy`       | `listing-accuracy-policy.md`  | Listing Accuracy Policy |
| `/legal/vendor-terms`           | `vendor-terms.md`             | Vendor Terms            |
| `/legal/managed-plan-agreement` | `managed-plan-agreement.md`   | Managed Plan Agreement  |
| `/legal/terms/v1.0` (archive)   | `versions/terms/v1.0.md`      | Terms of Service        |
| `/legal/privacy/v1.0` (archive) | `versions/privacy/v1.0.md`    | Privacy Policy          |
| `/legal/vendor-terms/v1.0` (archive) | `versions/vendor-terms/v1.0.md` | Vendor Terms |
| `/legal/managed-plan-agreement/v1.0` (archive) | `versions/managed-plan-agreement/v1.0.md` | Managed Plan Agreement |
| `/legal/vendor-terms/v1.1` (archive) | `versions/vendor-terms/v1.1.md` | Vendor Terms |
| `/legal/vendor-terms/v1.2` (archive) | `versions/vendor-terms/v1.2.md` | Vendor Terms |

## Frontmatter

Each file opens with a YAML frontmatter block (scalar keys only — parsed by the hand-rolled
`parseFrontmatter` in `legal-frontmatter.ts`, not a YAML library):

```yaml
---
title: Privacy Policy
version: 1.0
effective_date: 2026-08-01      # blank while a doc is an unapproved draft
last_updated: June 23, 2026
counsel_approved_by:            # blank until counsel signs off
counsel_approved_on:            # blank until counsel signs off
linear_issue: AECI-237
---
```

`title`, `version`, and `last_updated` render in the page header. `effective_date` renders only
when present. Dates are authored **pre-formatted as display strings** — never parsed/reformatted
at render time (that would be an SSR/CSR hydration and edge-cache trap). Write them in US format,
"Month D, YYYY" (for example `October 10, 2026`), the same as `methodology.md` (AECI-1262). Copy is
US English throughout.

## Status: pre-launch drafts

These remain **drafts pending counsel review** (AECI-308). The `counsel_approved_by` /
`counsel_approved_on` frontmatter now carries the literal marker `pending sign-off` — the
machine-readable "not yet approved" signal (it was blank as of AECI-237) — and each body still
opens with a visible "Draft, pending legal review" notice. The Privacy Policy's notice is shortened
to "Pending Legal Review", because Google's OAuth brand review read "not yet in force" as no
policy at all. It also carries the "Signing in with Google" disclosure that review requires.
`effective_date` stays blank until launch. The counsel review is a human gate tracked separately and verified at completion
checkpoint 7.12; it does not block the page scaffolding.

The governing law and venue in `terms-of-service.md` are filled with the **AECI-306** values
(State of Florida; state courts of Martin County, Florida, plus the U.S. District Court for the
Southern District of Florida), applied under **AECI-312** on October 14, 2026 (ToS v1.1). The
operator legal entity (The WBS Project, Inc.) and registered address in `privacy-policy.md`, and
the entity name in every operator definition, were committed on October 28, 2026 (the AECI-306
values, applied in the legal week-0 pass). The Privacy Policy's opening states that the service is operated from the United States and that we honor the data rights of the place a person lives, including a US state, the European Union or the United Kingdom (counsel Q26, November 6, 2026); the full GDPR-section removal is still **AECI-309**. The same pass bumped the
vendor terms and the Managed plan agreement to v1.1 (**AECI-1428**: when Managed ends, the fields
stay the vendor's), disclosed the Cloudflare Web Analytics page-load count (**AECI-1472**),
softened the Terms' taxonomy IP claim to a compilation claim (**AECI-1135**), and added the
vendor-maintained-listings sentences to the Terms (from AECI-1023, via AECI-308). On October 29,
2026 **AECI-1431** added a sentence to the Managed plan agreement's "Refunds" section, still in the
v1.1 draft: a charge we made in error is always reversed, outside the 14-day window. Counsel should
check it with the rest of the draft. The pricing rules behind it are `docs/PRICING_RULES.md` §5. The same day
**AECI-1228** added a line to the Privacy Policy's "Retention" list: our own visit record is copied to
a long-term archive before its 400-day deletion and kept indefinitely (ADR 0050). It went into the v1.1
draft in place, without a bump, because that draft has never taken effect.

On November 2, 2026 **AECI-1581** added a sentence to the Privacy Policy's bot-check bullet and to "Cookies and similar technologies": the check does not run in the European Economic Area, the United Kingdom or Switzerland until our review is complete. It went into the v1.1 draft in place, without a bump, because that draft has never taken effect. Counsel should check it with AECI-1458.

**AECI-1540** covered private row threads between two companies in all three v1.1 drafts: the
vendor terms' confidentiality and personal-data sections, the Privacy Policy's collection, sharing,
retention and deletion sections, and the Terms' acceptable use. The governing spec is
`docs/STAGE_2_ATTESTATIONS_SPEC.md` §15.15. Counsel is asked whether a message body may be kept
after its author deletes their account. The thread wording is conditional ("if the portal lets
you…") since AECI-1553, because threads ship behind the `THREADS_ENABLED` switch.

On November 3, 2026 **AECI-1363** and **AECI-308** applied a plain-language pass to all six drafts in place, without a bump. Some of its text was ahead of the code. **AECI-1589** (a ban ends licenses at once, since replaced in the text by the suspend-then-end rule below), **AECI-1590** (replies on any plan), **AECI-1591** (postal address in the house email footer) and **AECI-1592** (the 30-day site-wide notice band) were on this list and are built. The band alone does not let us publish a notice: see "Site-wide notice of a material change" below. The pass also lets licenses pass to a buyer of the business and bans insider reviews, disclosed or not. Counsel reads this text once it is on `main`.

On November 5, 2026 **AECI-1363** and **AECI-308** applied counsel's answers (Josh Begg, Rocket Lawyer) and Chris's rulings 1 to 8 to all six drafts in place, without a bump, and finished the AECI-1609 rename of the product noun from license to subscription. No effective date may be set until these ship: **AECI-1238**, **AECI-1590**, **AECI-1591**, **AECI-1592**, **AECI-1596**, **AECI-1613** to **AECI-1622**, **AECI-1636**, **AECI-1637** and **AECI-1665**. **AECI-1677** (the portal acceptance screen) is built as of November 12, 2026, with no text change (see below). **AECI-1621** (a ranking snapshot when a plan starts or ends and again 30 days later, and the How ranking works page the Terms link served as dated versions with archives) is built as of November 16, 2026, with no text change. The Terms link and the "these terms control" sentence shipped earlier, in #1163. **AECI-1628** (contest accepts and logo overwrites marked as our correction, with source and date) is built as of November 9, 2026, with no text change. **AECI-1238** (a hidden listing kept off the public site and out of search with its data kept, and one contested value hidden as "under review" within two business days of a public source, with the received date, the hide, any status reply and the decision on record) is built as of November 9, 2026, with no text change. **AECI-1619** (a claim records the versions of the two policies the Vendor Terms incorporate, a checkout or grant records the dated Plans page version and its snapshot hash, and every acceptance stores the label text beside its box) is built as of November 11, 2026. Its one text change is the Managed plan agreement edit described below. **AECI-1613** (a reviewer's dated update to a published review) is built as of November 6, 2026, and the Review Guidelines describe it in place under "Updating your review", without a bump. **AECI-1623** (suspend, then end, replacing the ban AECI-1589 shipped) is built as of November 5, 2026, with one known gap: the pages on `main` say "7 days", and counsel's follow-up the same day set 7 **business** days (Monday to Friday, US federal holidays excluded), each from the first confirmed send of that stage's notice, in two sequential stages. The code is more generous than the current text. Text item 10.2 landed in the Managed plan agreement on November 6, 2026, and item 10.3 in Vendor Terms 1.2 on November 7, 2026. The bold clauses and the capitals in the disclaimers are deliberate, because counsel asked for them to be conspicuous. The conspicuous clauses are the liability limits, the disclaimer capitals and the jury waiver. They must survive archiving, so an archive copies the Markdown as it is. "License" now means only the copyright license in these pages.

On November 6, 2026 **AECI-1363** applied counsel's batch-1 follow-up and batch-2 answers (legal change list sections 10 and 11) to the Managed plan agreement, the Privacy Policy, the Terms and the Listing Accuracy Policy, in place and without a bump. Those four have no acceptance at their current version in production. The Vendor Terms items were held that day and landed in 1.2 the next (see November 7, 2026 below). The bracketed read-receipt sentence in 11.16 was dropped: **AECI-1616** found the read record is internal only. New promises with no code yet: the 90-day deletion of a claim's IP address and browser (**AECI-1636**), and the email to account holders and click-to-accept of a rights-reducing change (**AECI-1637**). Both are on the gate list above.

On November 7, 2026 **AECI-1363** bumped the Vendor Terms to **1.2** and archived 1.1 unchanged at `/legal/vendor-terms/v1.1`. The reason is the rule in `docs/LEGAL_IMPACT_REVIEW.md` §2: production holds one Vendor Terms 1.1 acceptance, a claim from November 5, 2026, so no further edit could change 1.1 in place. 1.2 carries the held items 10.3 (business-day windows), 10.5 (asset removal within 14 days, caches included, a sourced logo removed on objection), 10.6 (the lost-profits exclusion in the bold cap block), the Vendor Terms half of 11.2 (IP address and browser deleted 90 days after acceptance), 11.12, 11.13 (exclusive courts, venue objection waived), 11.17 (bold jury waiver) and the Vendor Terms part of 11.19. The claim box's short form now credits the Vendor Terms for the exclusion, and the server stamps 1.2 (`LEGAL_AGREEMENT_CURRENT_VERSIONS`). The same day, in place and without a bump, the Terms took item 11.18 (a bold $100 cap on our liability to readers) and their part of 11.19, the Managed plan agreement took its part of 11.19 (a per-product cap base with a site-wide fallback), and the Privacy Policy now says a thread read record is deleted with the account (branch-2 review ruling 1). Item 11.19 replaces "This limit covers our liability only" in all three with counsel's one-directional wording (Q1 follow-up, November 7, 2026). The read-receipt sharing sentence is not added: AECI-1616 found the other company cannot see read state.

On November 9, 2026, still inside the unaccepted 1.2 draft, **AECI-1639** added the company's legal name to the owner-seat powers under "Seats and revocation", and **AECI-1649** dropped "your role" from the claim form's fields in the Vendor Terms' "Personal data" and the Privacy Policy's "Vendor claims and seats". The 1.1 change-history line records the one claim accepted under 1.1. The checkout's cap short form now names the per-product base (`MANAGED_PLAN_CAP_SHORT_FORM` and the Pay by card panel). The AECI-1649 code must not merge before this text.

On November 9, 2026 **AECI-1654** added one sentence to the Privacy Policy's "How we share data", after the processors paragraph (text item 11.20): vendor logos load from Brandfetch, which receives the visitor's IP address and browser details. Brandfetch is an independent controller for those logs, not our processor (ruling on AECI-310), so it is not in the processors list. It went into the v1.1 draft in place, without a bump, because the Privacy Policy is never accepted by a click. Counsel should check it with AECI-308.

On November 9, 2026 **AECI-1594** named the "Debugging record" in the Privacy Policy's "What we collect" and "Retention": Cloudflare Workers traces and our own log lines, kept 7 days, for every request including DNT and GPC, with link parameters removed (`redact_query_string`) and no IP address or cookies (`invocation_logs: false` in every `wrangler.jsonc` observability block). It also allows a fuller record for up to 72 hours at about 1 request in 10, which holds the IP address and full URL, with each on and off recorded (Chris's ruling of the same day, built by AECI-1656). The same change limits the "no identifiers" bullets under "Do Not Track, Global Privacy Control, and operational telemetry" to the error and performance reports sent from the browser, and adds a paragraph there pointing at the debugging record. It went into the v1.1 draft in place, without a bump. Counsel should check it with AECI-308.

On November 9, 2026 **AECI-1363** applied legal branch 4 (change list section 12, the second Rocket Copilot pass) to all six drafts in place, without a bump. Production holds no acceptance of Vendor Terms 1.2 and none of the Managed plan agreement, so 1.2 and 1.1 change in place. The items are drafting fixes: the agreement's own liability and disputes sections govern claims under it, a false-claim finding is defined, both agreements give a postal notice address, the confidentiality carve-out names a written duty in all three contracts, the Terms name bulk automated extraction and urgent court relief, the Privacy Policy no longer promises more than the law requires and says what the privacy signals do not switch off, the Review Guidelines stop adjudicating private contracts, and the Listing Accuracy Policy splits trademark from copyright logo complaints and fixes when we give our view on a protest: after the owner's reply or its 14 days, sooner only if the owner says it will not reply or the value causes harm that cannot wait, and an early view says which (Chris's wording of item 12.5, November 9, 2026, which keeps the §11b.12 early-decision ruling). Item 12.17 (ruling 14) opens claim, edit and contest of a connector-delivered integration to every owner, not only one holding a Managed subscription. That text was ahead of the code. **AECI-1663** built it on November 10, 2026, with no text change, so it is off the gate list.

On November 10, 2026 **AECI-1615** built the grant acceptance the Managed plan agreement 1.1 already describes (counsel Q5). A subscription AECi grants now waits until an owner seat ticks the box on the Billing tab, or until AECi records a signed deal that names the agreement by version and date. The portal acceptance records the IP address and browser, as a claim does. So two Privacy Policy sentences changed in the v1.1 draft, in place and without a bump: the "Agreement acceptance records" bullet under "What we collect" and the same bullet under "Retention". The Managed plan agreement needed no change. Once this merges, AECI-1615 no longer holds the effective date. Counsel should check the two sentences with AECI-308.

On November 11, 2026 counsel's Q42 answer added **AECI-1677** to the list of issues that must ship before any effective date. Every Vendor Terms acceptance so far was made against a draft marked "not yet in force", so the 30-day change email cannot move those vendors to the final version. An owner seat accepts the in-force version on a portal screen at next sign-in. No text changed.

On November 11, 2026 **AECI-1619** rewrote one sentence of the Managed plan agreement's "What a subscription is and does", in place in the v1.1 draft, without a bump. "At a minimum, Managed gives…" now names each core inclusion: the Managed fields, "How teams use it", the trades, audiences and phases, the integrations-page and API docs links, confirmed data flows and the search-engine notice, with the limit that a notice does not decide crawling, indexing or ranking. Review replies and seats for colleagues follow "As on every plan", because Free has them too (legal agent review, November 12, 2026). The change-history line for 1.1 says so. The edit changes the file's hash in `LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.1']`, which a grant acceptance stores. It is safe only while production holds no `managed_plan` 1.1 acceptance of any source. A read of the production database on November 12, 2026 found none: it holds Vendor Terms acceptances only (five at 1.0, one at 1.1, two at 1.2). Check again before merge. If any exist by then, the edit becomes version 1.2 and 1.1 is archived unchanged. Counsel review of the sentence is pending on **AECI-1363**.

On November 12, 2026 **AECI-1363** applied legal branch 5 (change list section 13: counsel's Q38, Q39 and Q42 answers and Chris's rulings 17, 18, 20 and 25). Production held two Vendor Terms 1.2 acceptances, both claims from November 11, 2026, so the rule in `docs/LEGAL_IMPACT_REVIEW.md` §2 bumped the Vendor Terms to **1.3** and archived 1.2 unchanged at `/legal/vendor-terms/v1.2`. The server now stamps 1.3 (`LEGAL_AGREEMENT_CURRENT_VERSIONS`). The Terms, the Privacy Policy, the Managed plan agreement and the Listing Accuracy Policy changed in place, without a bump, because none has an acceptance at its current version. The Managed plan agreement's text hash in `LEGAL_AGREEMENT_TEXT_SHA256` is regenerated for the same reason. The items: the Terms' copyright section promises to notify the poster, takes the counter-notice consent to the sender's own district, restores content between 10 and 14 business days after a counter-notice, and keeps a log of every notice. A copyright notice about a logo is accepted. An acceptance record holds the signer's name and title and the company's legal name, and keeps them after account deletion. Every liability clause says it limits only what we can owe. The jury waiver is labelled. A refund deduction is credited against what the vendor owes for the same breach. The Managed plan agreement's own refund and suspension sections govern claims under it. A rights-reducing Vendor Terms change applies to a company only after an owner seat accepts it in the portal. Two items were ahead of the code. Item 13.3 promises the notice log, which **AECI-1665** built on November 17, 2026 (see below). Item 13.12 promises the portal acceptance of a rights-reducing change, which **AECI-1677** built on November 12, 2026. Both are off the gate list.

On November 13, 2026 **AECI-1712** added two sentences to the Privacy Policy's "Our own visit count" paragraph, after the tally sentences: "If your browser sends neither signal, our record of your visit also notes whether our page script ran and whether the page was scrolled, clicked or typed in, as a yes or no only, never which key or what was clicked. We do not collect this for visitors in the European Economic Area, the United Kingdom or Switzerland." It went into the v1.1 draft in place, without a bump, because that draft has never taken effect. Chris approved the wording the same day on AECI-1659. Counsel answered the design as Q37 and Q43 (`docs/LEGAL_COUNSEL_RECORD.md`). The final wording differs from the Q43 wording in two places. It attaches to "our record of your visit", not to "the tally", and it adds the regional hold of ruling 21. Counsel should check it with AECI-308. The capture code, AECI-1713 and AECI-1714, stays off in production until 1.1 is in force.

**The copyright notice log is built (AECI-1665, November 17, 2026), with a Privacy Policy text change, so it is off the gate list.** It makes text item 13.3 true: the Terms' "Copyright complaints" says "we keep a log of every notice and counter-notice we receive". The log is the `dmca_notices` table (`docs/DATABASE_SCHEMA.md` §8.14), worked on `/admin/dmca`. It computes the restore window from the counter-notice's received date, business day 10 to business day 14. It counts each account's takedowns for the repeat-infringer review on `/admin/users/:id`. The operator steps are in `docs/runbooks/legal.md` "Copyright notice or counter-notice". The log is new personal data, kept after account deletion, so the Privacy Policy changed in the v1.1 draft, in place and without a bump, because that draft has never taken effect. "What we collect" gains a "Copyright notices" bullet. "Retention" keeps notices and counter-notices for three years after the matter closes, even after account deletion. "Deletion" lists them as kept. The account deletion screen names them too. Counsel has not been asked about the three years or the wording. The question is open in `docs/LEGAL_COUNSEL_RECORD.md`. The deletion job that ends the three years is **AECI-1905**, not built. No record can fall due before late 2029.

**The legal retention prune is built (AECI-1638, November 17, 2026), with a Privacy Policy text change, so it is off the gate list.** Ruling 23 made AECI-1638 a gate before any effective date, but it was never added to the November 5 list above. It is recorded here instead. The prune makes the two retention periods in the Privacy Policy's "Retention" true. Audit records go four years after the action. Agreement acceptance records go six years after the vendor account ends, or five years after a granted subscription ends, if later. It runs nightly from the 03:00 tick (`apps/api/src/lib/legal-retention-prune.ts`, ADR 0058). A litigation hold placed on `/admin/legal` stops deletion of the records it covers: since AECI-1970 (November 19, 2026, ruling 55), a vendor hold keeps that vendor's audit and acceptance records while other records go on schedule, and a global hold keeps everything. Two bullets changed in the v1.1 draft, in place and without a bump, because that draft has never taken effect. The "Agreement acceptance records" bullet gains "or longer while a legal hold requires it". The "Audit record for abuse prevention" bullet gains two sentences, after the legal agent's review: "We pause this deletion while we are under a legal duty to preserve records, for example after receiving legal process." and "Three kinds of audit record are kept longer, for as long as the acceptance record they belong to: the record that an agreement was accepted, the record that the Terms of Service were accepted, and the record that an account was deleted, which dates the start of the six-year period." The change history line says so. Counsel has not been asked about the hold wording or the kept-longer sentence. The question is open in `docs/LEGAL_COUNSEL_RECORD.md`. The Terms of Service acceptance record was not pruned at first. AECI-1718 (November 19, 2026) added its prune: six years after the account's `account.deleted` audit row, with no text change, because the Privacy Policy already promises that period.

On November 18, 2026 **AECI-1914** gave every agreement acceptance record an end, under Chris's rulings 48 and 50. Before it, the prune kept forever a record with no company linked, such as the acceptance of a claim that was never approved, and a record whose company was deleted from the site. That broke the Privacy Policy's retention promise. Three clauses changed in the v1.1 draft, in place and without a bump, because that draft has never taken effect. The "Agreement acceptance records" bullet under "Retention" gains, after "even if you delete your account.": "If a claim is never approved, we keep its acceptance record for six years after the claim is closed. Where a record has no such date, we keep it for six years after the latest date we hold for it." The "Audit record for abuse prevention" bullet now reads "Four kinds of audit record are kept longer, for as long as the acceptance record they belong to: the record that an agreement was accepted, the record that the Terms of Service were accepted, the record that an account was deleted, which dates the start of the six-year period, and the record that a company was deleted from the site, which dates the six-year period when the company's record is gone." The change history line for 1.1 gains a clause that says so. The "Deletion" section and the `/account` deletion screen still hold: they say the agreement record is kept, and they name no period. Counsel has not been asked about these sentences yet. The question is open in `docs/LEGAL_COUNSEL_RECORD.md`.

On November 26, 2026 **AECI-1971** applied the fallback of Chris's ruling 60 (counsel's Q66), in a wider form Chris approved after the legal agent's review. Before it, an audit record of an acceptance that no longer existed, or that named none, was kept forever. The prune now deletes it four years after the action. The "Audit record for abuse prevention" bullet under "Retention" changed in the v1.1 draft, in place and without a bump, because that draft has never taken effect. It read: "Four kinds of audit record are kept longer, for as long as the acceptance record they belong to: the record that an agreement was accepted, the record that the Terms of Service were accepted, the record that an account was deleted, which dates the start of the six-year period, and the record that a company was deleted from the site, which dates the six-year period when the company's record is gone." It now reads: "Four kinds of audit record are kept longer, for as long as the record they belong to: an agreement acceptance, a Terms of Service acceptance or a granted subscription. If there is no such record, they are kept for four years. The four kinds are the record that an agreement was accepted, the record that the Terms of Service were accepted, the record that an account was deleted, which dates the start of the six-year period, and the record that a company was deleted from the site, which dates the six-year period when the company's record is gone." It replaces ruling 60's clause "or for four years if there is no acceptance record". The grant is named because a deleted company's record is kept while a granted subscription never accepted still names the company. The change history line for 1.1 gains: "After a review of audit records with no acceptance record: keeps them for four years, and names the granted subscription and the Terms of Service acceptance among the records they belong to." Counsel has not seen the widened sentence. It is a confirm item in `docs/LEGAL_COUNSEL_RECORD.md`'s open items.

On November 24, 2026 **AECI-2038** took confirmed data flows out of the Managed plan agreement's "At a minimum, Managed gives…" sentence, in place in the v1.1 draft, without a bump. Chris ruled that confirming data flows is accuracy, not promotion, so every plan has it (ruling 5 on epic AECI-2035, no counsel question). The sentence now names the Managed fields, "How teams use it", the trades, audiences and phases, the integrations-page and API docs links and the search-engine notice. Confirming which data each integration moves joins review replies and seats under "As on every plan". The change-history line for 1.1 says so. The edit changes `LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.1']`, which is regenerated in the same change. It is safe only while production holds no `managed_plan` 1.1 acceptance. The epic recorded none on November 24, 2026. Check again before merge. If one exists by then, the edit becomes version 1.2 and 1.1 is archived unchanged. The same change bumped the Plans page to 1.2, because its comparison table and cards moved the item to Free. It also edited the provisional ranking page 1.2 in place: "A vendor on a paid plan can add data to its own integrations" now reads "on any plan". Counsel has not seen these sentences.

On November 24, 2026 **AECI-2044** added one paragraph to the Managed plan agreement's "What a subscription is and does", in place in the v1.1 draft, without a bump. It says which products can hold a subscription: an application, a product that is both an application and a connector, or a Sync Service, and never an integration platform or an unclassified connector. A subscription already on a product stays. It also says what Managed gives a Sync Service, which is not one of the two products in the integrations it delivers: its own product's Managed fields and the search-engine notice. Claiming and editing those integrations is the same on every plan. Chris ruled it (ruling 6 on epic AECI-2035, a `decision`, final). The change-history line for 1.1 says so. The edit changes `LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.1']`, regenerated in the same change. It is safe only while production holds no `managed_plan` 1.1 acceptance. The epic recorded none on November 24, 2026. Check again before merge. If one exists by then, the edit becomes version 1.2 and 1.1 is archived unchanged. The same change bumped the Plans page to 1.3, with a new "Which products can hold a subscription" section. The help page "For connector vendors" still says a vendor whose products are all connectors is not invoiced for a seat, which stays true: the seat is free, and a Sync Service pays only if it chooses Managed. Counsel has not seen these sentences.

On November 24, 2026 **AECI-2043** edited the provisional ranking page 1.2 in place again, with its archive copy, without a bump and without a date change, as Chris ruled for this epic. A new section, "A pair page", states the card order: integrations A to Z by name in two runs, those recorded under the connector that delivers them second, then Sync Service cards A to Z by the company that offers each one (ruling 14 on epic AECI-2035). The 1.2 line under `## Versions` names it. The same change added a factual line to every Sync Service card on a pair page, "Offered by {vendor}. Not offered or endorsed by {A} or {B}." (ruling 12). It changes no `/legal` page: the Terms of Service already say we are "not affiliated with, endorsed by, or acting on behalf of the vendors we list", and the line applies that to the endpoint vendors. Counsel has not seen these sentences.

On November 24, 2026 **AECI-1662** edited the provisional ranking page 1.2 in place again, with its archive copy, without a bump and without a date change, as for AECI-2037, AECI-2038 and AECI-2043. "What does not count" gains one bullet: "Whether a connector is an integration platform or a Sync Service, which you can filter by in search and in the lists." The change added a "Connector type" filter to `/search`, `/products` and the browse pages. It filters and orders nothing, and the kind is set by AECi, never bought. The 1.2 line under `## Versions` is unchanged. No `/legal` page changes. Counsel has not seen the sentence.

On November 24, 2026 **AECI-2042** edited the Listing Accuracy Policy 1.0 draft in place, without a bump, because it has never taken effect. Chris ruled the change a `decision` the same day (rulings 8 to 10 on epic AECI-2035, and the ruling on AECI-2042 that a removal takes effect when it is sent), with no counsel question. A new subsection under "Contesting an integration detail", "Integrations a Sync Service delivers", states three rights for a vendor at one end of such an integration: remove it from its product, at once and without our review, with only that vendor able to withdraw it and us able to end it only for an account that should not have had access; report that it is not offered, which we decide, the integration staying listed while we check; and report one wrong data flow, which the Sync Service decides, with our review of a decline being advice. It keeps the section's three sentences true: each report is accepted, declined or withdrawn, the decider is fixed when it is sent, and an open report is not shown. "We will not remove an accurate listing simply because a vendor asks us to" gains one sentence naming this exception. "Who maintains an integration" gains one sentence after "the owner may restore it": the owner cannot restore it while a vendor's removal of it from its product stands. `last_updated` is November 24, 2026, and the change-history line says so. Claims record `listing_accuracy_version` 1.0 (`LEGAL_POLICY_CURRENT_VERSIONS`), so check before merge that no Vendor Terms acceptance in force carries it. If one does, the edit becomes version 1.1 and 1.0 is archived unchanged. Counsel has not seen these sentences.

On November 24, 2026 **AECI-2046** edited the provisional ranking page 1.2 in place again, with its archive copy, without a bump and without a date change, as for the changes above. "A product page" gains one bullet: "What it syncs", on a Sync Service's own page, lists the types of data its integrations move, A to Z by name, and the count beside each one does not change the order (ruling 15 on epic AECI-2035). The same change shows three facts AECi records on a Sync Service's page, marked "Recorded by AEC Integrations on {date}" with a Source link, so the Terms of Service sentence "Where we write or correct text on a listing a vendor maintains, that text is marked as ours, with its source and date" stays true. No `/legal` page changes. Counsel has not seen these sentences.

On November 24, 2026 the **public QA pass on epic AECI-2035** edited the provisional ranking page 1.2 in place again, with its archive copy, without a bump and without a date change, as for the changes above. Two wheel sentences in "A product page" were false once a connector's hero wheel shows the products its pairs reach: "A product with no integration of its own has no wheel" and "On a connector's own page, the wheel leaves out the pairs it powers between other products". They now say that a connector's wheel shows every product at either end of an integration it powers or delivers, the same set as its "Connects N products" line, on one slide, A to Z by product name, one dot per product; that a hybrid shows its own integrations first; and that the wheel counts products. The order rule is the one the wheel already used. No plan input is read. The 1.2 line under `## Versions` is unchanged. No `/legal` page changes. Counsel has not seen these sentences.

On November 25, 2026 the legal agent read the eight **AECI-2035** edits to the provisional ranking page 1.2 and found none needs counsel. Production still served 1.1 that day, so 1.2 stays edited in place. Its wording fixes were applied to the page and its archive copy: a dot on a connector's page stands for a product, the hybrid sentence is split in two, the pair page order is stated as three groups, the connector-kind bullet under "What does not count" says the kind does set the pair page order, and the Versions line names what a Sync Service's page lists. Two things stay open. Chris has not ruled on Sync Service integrations being the last group on a pair page. Ruling 65's replacement for "It changes what a page says, never where it appears" is not yet in 1.2 and must be before 1.2 is published. It was folded into 1.2 on November 26, 2026 (AECI-2230, item 14.8). Re-check on merge day that production still serves 1.1, and set the date to the day 1.2 reaches production.

On November 25, 2026 the legal agent read the four documents **AECI-2035** changed: the Listing Accuracy Policy, `/methodology`, the Managed plan agreement and the Plans page. Its wording fixes were applied the same day. No change was sent to counsel.

- **Listing Accuracy Policy 1.0, in place, without a bump**, because it has never taken effect. "We may end a removal only where it was sent from an account that should not have had access to that product" now also names the vendor's claim to that product ending or being suspended, and the law requiring it. A confirmed "not offered" report takes the integration off the public site "within five business days", the period and business-day definition "Requesting a correction" already uses. On a pair AECi holds, that is the operator's retraction in the review app, so the five days are a manual deadline (`docs/runbooks/catalog.md`). The "One data flow" bullet now says a correction request still applies to a data flow (counsel Q21), and that on an integration the Sync Service has claimed we act by taking the integration off the public site. That is the only step the code allows: no admin path corrects or hides a single flow on a claimed Sync Service pair (`admin-field-overrides.ts` and `admin-field-hides.ts` cover no flows). "We will not remove an accurate listing simply because a vendor asks us to" already names the Sync Service removal as its one exception, so it is unchanged. `last_updated` is November 25, 2026, and the change-history line says so.
- **`/methodology` and the help pages, in place.** The agreement-label row now says the Sync Service "built and runs the integration". It no longer says it "runs both sides", because it does not run the two products at the ends. The same fix reached the agreement states help page, "For connector vendors", the pair page provenance line (`@@pair.claim.provenance.closing.ownerConfirmed.runs`) and the owner's flows panel (`@@vendor.ownedFlows.intro.claimed.runs`). The three policy changes above are mirrored in `/methodology`, "Requesting changes and appeals", "For connector vendors" and "Owning an integration".
- **Managed plan agreement 1.1, in place, without a bump.** "A subscription already assigned to a product stays on it until it ends" now reads "A subscription already assigned to a product stays on it, and renews there as before, until you release it at renewal or it ends." The legal agent proposed "It does not renew on that product". That would be false: the Stripe webhook and the daily reconcile renew it on the product, and only the release-at-renewal flag moves it (`STAGE_2_PAID_TIERS_SPEC.md` §13.14). The text does not promise that we never reclassify a subscribed product, because a promote that changes `product_role` is not refused. `LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.1']` is regenerated. It is safe only while production holds no `managed_plan` 1.1 acceptance. Check again before merge.
- **Plans page bumped to 1.4**, with the same sentence. "Every content change bumps. There is no draft window." (above) has no exception for a version that never reached production, so 1.2 and 1.3 stay as recorded and 1.4 is new. The snapshot `v1.4.md` and `PLANS_PAGE_SHA256['1.4']` are added.
- **One question is recommended for counsel before any effective date, not yet asked.** A vendor at one end of a Sync Service integration can take a third company's truthful listing off the site with no review by us. Is that removal right safe for us to grant, and does it need limits or a statement of reasons? It is proposed as Q73. It is not yet in `docs/LEGAL_COUNSEL_RECORD.md`, and Chris decides whether to send it.

On November 26, 2026 **AECI-2192** edited the Listing Accuracy Policy 1.0 draft in place again, without a bump, because it has never taken effect. Counsel answered Q73 and Q74 the same day, and Chris ruled the change a `decision` as ruling 66 (`docs/LEGAL_COUNSEL_RECORD.md` on the legal agent's branch). `last_updated` is November 26, 2026, and the change-history line says so. The legal agent read the final text on November 26, 2026, and found it matches ruling 66. Its changes, listed in the last bullet below, were applied in place the same day. Nothing went back to counsel.

- **Counsel's three disclosures.** "Where listing data comes from" gains two sentences after "A listing is a factual catalog entry": whether we list something is at our discretion, we may withdraw a listing, and a listing gives no one a right to stay visible. It sits there, not under Sync Services, because it is true of every listing and that is where the policy says what a listing is. It agrees with the Terms of Service, "We are under no obligation to list, or to continue listing, any product, vendor, or integration", so the Terms are unchanged. The other two open "Integrations a Sync Service delivers", before the rights: the vendor of a product at one end may remove the integration from its product even when the listing is accurate, and we do not guarantee that an integration a third company delivers stays listed. Counsel's "no guarantee of neutrality" is not adopted, because the site's promise is that it is independent. No user-facing text says "neutral".
- **The removal bullet.** "We do not review a removal." is gone. It now says the vendor must choose its reason from a fixed list, that we record the reason and the time, that a removal takes effect when the vendor sends it and we do not check it first, that the public site shows nothing about it, and that the Sync Service is told at once with the reason and how to object. "We may end a removal only where…" moves out of the bullet.
- **A new paragraph on objections**, after "Each report is accepted, declined or withdrawn". We look at an objection after the removal has taken effect, on the three grounds of ruling 66, with its example. We do not decide whether the vendor should support the integration. We may also end a removal where the vendor's claim ends or is suspended, or the law requires it. We tell both vendors why. Since the legal agent's read, we also answer an objection within five business days of receiving it, as the last bullet below says.
- **"We will not remove an accurate listing simply because a vendor asks us to"** keeps its one-exception sentence, now saying the vendor can remove it "even when the listing is accurate".
- **Mirrored in place, with `last_updated`:** `/methodology` "When a product's vendor objects to a Sync Service integration" (and its "We will not remove an accurate listing" sentence now names the exception), "Requesting changes and appeals", "For connector vendors" (a "Before you add one" note above the data rows, and "How to object"), and "Owning an integration".
- **The legal agent's read, applied on November 26, 2026.** "has three more rights" reads "has three rights". "the Sync Service decides the listing" ends "of that data flow". "On an integration the Sync Service has claimed, we do that by taking the integration off the public site" now says why: the Sync Service maintains its data flows and we cannot change one, so we take the integration off the public site. The code still allows only that step. No admin path corrects or hides one flow on a claimed Sync Service pair, and the only tool is retiring the whole integration (AECI-2139 is the follow-up). The objection paragraph gains "We answer an objection within five business days of receiving it." The business-day definition under "Requesting a correction" covers it. The operator owns the deadline (`docs/runbooks/listing-submissions.md` §6c), and `/admin/contests` shows each open objection's answer-by date and marks it overdue. The removal's reason list drops "It is not offered for our product", because it states that the integration does not exist and the "Not offered" report covers that. "We ended our relationship with this company" reads "We no longer work with this company". The Sync Service now reads the reason as the vendor's statement: "{vendor} gave this reason". The same edits are mirrored in the four pages above and the portal.

On November 26, 2026 **AECI-2139** edited the Listing Accuracy Policy 1.0 draft in place again, without a bump, because it has never taken effect. Chris ruled it the same day: edit in place, with a public caption and an admin lift. Before it, "One data flow" said that on a claimed Sync Service integration we cannot change one flow, so we take the whole integration off the site. That stopped being true when AECi gained a way to correct one flow (`POST /api/admin/flows/:claimId/correction`). The sentence now reads: "On an integration the Sync Service has claimed, if a public source we can verify shows the data flow is wrong, we correct it or remove it from the public site within five business days. The rest of the integration stays listed. We tell the Sync Service why, and it cannot undo the correction." The five business days are the ones "Requesting a correction" already promises, with its definition of business days. The operator owns that deadline. The pair page says so in "About this listing": "A data flow: Removed by AEC Integrations on {date}" or "Corrected by…", with the source, so "A correction we make ourselves is marked as ours, with its source and date" stays true. `last_updated` is unchanged at November 26, 2026, and the change-history line says so.

- **Mirrored in place:** `/methodology` "When a product's vendor objects to a Sync Service integration", "Requesting changes and appeals" and "For connector vendors" (which also names Messages and the support address). Each already carried `last_updated` November 26, 2026.
- **Counsel has not seen the sentence.** It narrows what we do, from taking a whole integration down to correcting one flow, and keeps the five-day promise. It should be read by counsel with the rest of the 1.0 draft before an effective date is set.

On November 26, 2026 **AECI-2208** edited the Privacy Policy 1.1 draft in place, without a bump, because it has never taken effect. `/welcome` now asks "How did you find AEC Integrations?" (Chris's ruling of November 26, 2026, reversing the October 29 scope). The "About you (optional)" bullet in "What we collect" lists the question, its optional follow-up box and the purpose. The "Contact details you give us" bullet says the About you questions ask it too, that the answer is kept with the other About you answers, and that the audit record keeps the choice but never the typed text. Chris then ruled twice the same day (rulings on AECI-2208). Ruling 1 keeps the channel in the `profile.updated` audit row, which survives account deletion. That changed the promise in "Retention" that About you answers "are deleted when you delete your account", so it is a `decision`, and his ruling is the decision. The "About you answers" bullet now names the one exception: the audit record keeps the choice, not the typed text, for the audit record's own period. Ruling 2 shows the question on `/account`, so "You can change or clear any answer on your account page" stays true with no exception. `last_updated` is November 26, 2026, and the change-history line says so. Counsel review is pending with the rest of the 1.1 draft. It is recorded on AECI-2208.

On November 24, 2026 **AECI-1913** added the workflow tables (`workflow_instances`, `workflow_transitions`) to the legal retention prune, four years after the action, under ruling 51. No text changed. They record who moved a request and when, so the "Audit record for abuse prevention" bullet already covers them: "kept for four years after the action". A vendor hold keeps that company's workflow rows by the same categories the hold sentence names. No acceptance record depends on a workflow row, so the kept-longer sentence is unaffected.

**The portal acceptance screen is built (AECI-1677, November 12, 2026).** It makes text item 13.12 true and gives counsel's Q42 answer its screen. No text changed. Rulings 24 and 25 set the rules (`docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §6.24).

- **How the API knows a version is in force.** `LEGAL_AGREEMENT_EFFECTIVE_ON` (`packages/shared/src/api/agreements.ts`) holds each known version's effective day, mirrored from its frontmatter `effective_date` (`legal-page.component.spec.ts` checks every version with a page). A published `legal_versions` row dates its version too. A version is in force from 12:00 UTC of that day. Today every entry is `null` and no row exists, so nothing is in force and the screen shows to no one.
- **A draft is never in force.** Vendor Terms 1.0 to 1.3 and Managed plan agreement 1.0 and 1.1 stay `null` for good (`agreements.spec.ts`), because every acceptance of them was given against "draft, not yet in force". **So the effective-date change must bump to a new version** with its own entry, even if its words equal 1.3's. Setting `effective_date` on 1.3 in place fails CI.
- **Required mode (ruling 24).** Once the Vendor Terms are in force, a company with no acceptance of a version in force sees only the acceptance screen, and every vendor write but the accept and the Stripe portal link is refused. Any owner seat accepts for the company. The listing stays claimed. No deadline ends the claim. A draft acceptance does not count.
- **Optional mode (ruling 25, counsel Q3).** A published version with "Does it need acceptance?" Yes is offered to owner seats of covered companies, who may choose "Not now" for the session. Until an owner accepts, the earlier version applies. For the Managed plan agreement, only companies paying monthly by card are asked. The screen records the click and nothing else. It does not say what happens without an acceptance. AECI-1690 builds that: see the next paragraph.
- **The record.** Source `portal`, with the claim's fields: name, title, legal name, email, time, version, the box label naming the version and the company, its hash and the unticked flag. **No IP address or browser yet.** The Privacy Policy's "Agreement acceptance records" names them only "for a claim or an in-portal acceptance of a granted subscription". Recording them on this screen needs that sentence changed first, then `PORTAL_RECORDS_EVIDENCE` set to true.
- **Who has accepted.** `/admin/legal` lists, per final version, the accepted and not-yet counts and the companies not yet accepted (`docs/ADMIN_PANEL_SPEC.md` §5.22a). The effective-date change uses it.

**The renewal bind is built (AECI-1690, November 12, 2026), and it puts two text items on the gate list.** A Stripe renewal now binds the Managed plan agreement version in force at the new period's start. A monthly charge does not bind a version that needs acceptance until an owner seat has accepted it. Until then the version the subscriptions are on keeps applying, and they keep renewing (ADR 0047 decision 9). That version can be one the company never clicked: an annual bind, or a version that needed no acceptance. Chris ruled against an automatic cancel. The 45-day renewal notice names the version that binds, its effective date and summary, links its fixed copy and attaches its PDF.

**Applied in legal branch 6 (AECI-1363, November 18, 2026), in place in the Managed plan agreement 1.1 draft, because production holds no acceptance of it.** Both sentences now match the build, so they are off the gate list.

- **"If you do not accept, your subscriptions end at the end of the month you have paid for, and we do not charge you again."** Nothing ends them, by decision. It now reads: "If no owner seat has accepted it by your next charge, your monthly subscriptions keep renewing on the version they are on. The new version then binds at the first charge after an owner seat accepts it." (`terms-binding.ts`).
- **"A new version binds you at your next renewal or your next purchase, whichever comes first."** It stays, followed by: "A subscription you add to a plan you already have is not a new purchase for this purpose. It takes the version that plan's subscriptions already carry, or the latest of them if they carry different versions." The build gives an added subscription the highest version its live siblings on the same Stripe subscription carry (`stripe-licenses.ts`). One account can still hold two versions: a granted subscription keeps its grant-date version, and siblings can differ when only some were carried forward. The change-notice email's "your next purchase" stays true, because an added subscription is not a new purchase.

Built rules that match the current text, for the legal stream to know:

- **A click binds at the next charge, never mid-period** ("binds you at your next renewal", "Nothing is re-signed mid-term"). A monthly charge counts only the acceptances recorded at or before its period start. An owner who accepts mid-period is bound at the following charge. The daily reconcile only completes a charge whose webhook was missed, by the same rule.
- **An annual renewal binds only a version its notice announced** ("We announce it in the renewal notice sent 45 days before your renewal date"). A version published less than 45 days before the renewal date binds at the following renewal. The notice and the renewal make the same call, so the notice never names a version the renewal will not bind.
- **A new subscription's first period is never a renewal.** A checkout that straddles an effective moment keeps the version it was sold under, and so does a subscription added mid-period. That keeps "A purchase you make inside those 30 days stays on the version you accepted" true, and so does the checkout stamp: the version in force at request time, which before an upcoming version's moment is the current one.
- **Each subscription moves only as far as its own version allows.** A subscription is never carried past an unaccepted version because another subscription of the same plan is on a later one.

**Publishing is gated too (AECI-1688, AECI-1677).** The API var `LEGAL_PUBLISH_ENABLED` is `"true"` on local and staging and `"false"` on demo and production, and the publish answers `409 LEGAL_PUBLISH_DISABLED` while it is off (`docs/environments.md` "Legal publish per tier"). **Demo and production stay off until every issue on the gate list above has shipped. The release that sets the first effective date turns them on.** The reason: once a published version's effective moment passes, the acceptance screen blocks every claimed vendor's writes until an owner seat accepts. The change-notice email (AECI-1620) has shipped, so a publish tells vendors before that moment.

**Decided, no change (ruling 49, November 18, 2026): the IP address and browser on a portal acceptance.** The acceptance screen records no IP address or browser, and it stays that way. The owner seat is signed in, so the record already names the account, and an IP address deleted after 90 days would be gone before most disputes. The Privacy Policy's "Agreement acceptance records" names them only "for a claim or an in-portal acceptance of a granted subscription", which stays true. `PORTAL_RECORDS_EVIDENCE` stays `false` in `apps/api/src/lib/agreement-acceptances.ts`. This is no longer an open item before the first effective date.

**Open item for the legal stream (AECI-1363): does a policy change need the Vendor Terms email?** Since AECI-1689 the Listing Accuracy Policy and the Review Guidelines switch to an upcoming version on its date alone, with the site-wide notice band as their notice. The Vendor Terms make both policies "part of these terms" and promise an email 30 days before "we change these terms". Whether a policy change is therefore a change to the Vendor Terms, and needs that email, is a legal question that predates AECI-1689. Answer it before the first policy change after an effective date goes out. **Answered by counsel on November 19, 2026 (Q68): yes.** A policy change is a change to what the vendor agreed to, the site band is not the promised email, and a vendor stays on the policy version it accepted until the change process is followed. Either the publish flow sends the 30-day email for the two policies, or the change clause is amended. **Ruled the same day (ruling 54): the publish flow sends the email. Built by AECI-1969 (November 19, 2026), so this item is closed.** A policy version now publishes on `/admin/legal` like the Vendor Terms, and switches in only once published ("The effective date switches by itself" below). Which version a company is on is in "Which policy version a company is on" below.

**Open item for the legal stream (AECI-1363): the first in-force version is a new version number.** The code requires it (the draft versions are pinned undated). It stands pending the legal stream's confirmation.

**Counsel's batch 4 answers, November 15 and 16, 2026: applied in legal branch 6 (AECI-1363, November 18, 2026).** Counsel answered Q44 to Q60 on two planned features. Most of it waits for those features. The items that touch the documents that exist today are applied, all in place, because production held no acceptance of Vendor Terms 1.3, no acceptance recording a Review Guidelines version and no acceptance of Managed plan agreement 1.1 on November 18, 2026. The answers and rulings 26 to 45 are in `docs/LEGAL_COUNSEL_RECORD.md`.

- **Text items 14.1 to 14.4, Vendor Terms 1.3 (Q50, ruling 26). Applied.** The upload warranty adds that third-party material (a customer's drawings or project details, a person's name, likeness or words, personal or confidential information) needs every consent and license, and that a vendor removes what it may not share. The indemnity now says it includes privacy, name and likeness, data-protection and confidentiality claims about submitted content. The uncapped list names those claims, and the confidentiality carve-out is "your breach of any duty of confidentiality, whether you owe it to us, to your customers or to anyone else".
- **Text item 14.5, Terms and Vendor Terms content license (Q53, ruling 27). Applied.** Both licenses now say "You also authorize our service providers to do these things on our behalf." The Q53 Privacy Policy disclosure of automated screening still waits for the screening build (ruling 29).
- **Gate.** Items 14.1 to 14.5 are in the drafts that become the first in-force versions, so every vendor accepts them once on the acceptance screen. Landed after an effective date, they would reduce a vendor's rights under the indemnity and content license sections, and ruling 25 would make each company accept them in the portal.
- **Text item 14.6, Review Guidelines "Vendor responses" (AECI-1872, ruling 42). Applied.** "Labeled" now reads: "A response appears after the review text, in its own panel labeled "Response from" the company's name, with the date it was published. It is never mixed with the reviewer's words." It is true of `main`'s separate block and of the redesigned panel inside the review card, so it reaches `main` before AECI-1784's layout, as ruling 42 requires. When the redesign merges, `content/docs/vendors/replying-to-reviews.md` ("never inside it") must change with it.
**Counsel's batch 6 answers, November 19, 2026 (Q62 to Q70), and legal branch 7 (AECI-1363, November 19, 2026).** The answers and rulings 52 to 58 are in `docs/LEGAL_COUNSEL_RECORD.md`. Legal branch 7 changed the Privacy Policy 1.1 draft only, in place, because it has never taken effect.

- **Item 14.8, the ranking promise (Q62, Q70, Q71, rulings 52 and 65). Applied November 26, 2026 (AECI-2230).** "No plan changes where you rank or appear" was false as written, counsel said. Ruling 65's wording replaces it, all in place: "Payment never changes the order in which products are listed or returned in search. A paid plan lets a vendor edit more of its own listing, such as the trades, audiences and phases tagged on its product, which can help it match more searches and appear on more category pages." The places it landed:
  - **Vendor Terms 1.3.** The heading "Plans never affect ranking or reviews" is now "Plans, listing order and reviews". The ruled wording is followed by "No plan changes whether a review is published." The sentence "That holds on Free, on Managed, and for anything else you pay us for." is gone. The change-history line says so, and `LEGAL_AGREEMENT_TEXT_SHA256.vendor_terms['1.3']` is regenerated.
  - **Managed plan agreement 1.1.** The same heading change and the same two sentences. "A subscription changes what you can edit. It never changes the order of listings." is kept after them. The change-history line says so, and `LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.1']` is regenerated.
  - **Terms of Service 1.1, "What the service is".** "Neither it nor our editorial choices are ever influenced by payment." is replaced by the ruled wording. "Search ranking is algorithmic." and "we do not sell ranking position" stay. The promise about editorial choices is dropped, because the Browse menu's top trades are ordered by product count, which Managed tags can move (ruling 63). The change-history line says so.
  - **How ranking works 1.2, folded in.** "No plan, at any price, changes a listing's position…It changes what a page says, never where it appears." is replaced by the ruled wording, then "There is no sponsored placement and no promoted tier." The live page and `versions/how-ranking-works/v1.2.md` are edited together, and the 1.2 `## Versions` line names the change. 1.2 has never been published, so there is no 1.3. The description now ends "what a paid plan changes".
  - **Plans page bumped to 1.6.** It quotes the portal line below. The snapshot `v1.6.md` and `PLANS_PAGE_SHA256['1.6']` are added.
  - **Outside `/legal`.** The portal plan panel line (`@@vendor.plan.decision10`) reads "Payment never changes the order in which products are listed or returned in search, or whether a review is published." `/methodology` and `/docs/vendors/overview` carry the ruled wording. On `/methodology`, "These are the details that feed search, so no payment is needed to improve them" became "These details feed search, and no payment is needed to edit them", because Managed-only tags now feed search too. The claim-approved email's account-status note ends "payment never changes the order in which products are listed or returned in search". The Vendor Terms meta description ends "seats, plans, listing order and reviews".
  - **Counsel.** Counsel has not seen the "such as" widening, the new heading, or the reworded review sentence. All three go on the sign-off brief (ruling 65). Both agreements are edited in place because they are unaccepted drafts. Check before merge that production holds no acceptance of Vendor Terms 1.3 or Managed plan agreement 1.1.
- **Item 14.9, Retention, copyright notices (Q64). Applied.** Three years, "or longer if a claim, dispute or legal hold is pending", "whether or not you have an account".
- **Item 14.10, How we share data, the counter-notice (Q65). Applied.** "There is one exception" is gone. The whole counter-notice is forwarded, with no further notice to the sender. The poster is told of a removal.
- **Item 14.11, Retention, the audit hold (Q66). Applied for the hold (AECI-1970, ruling 55, November 19, 2026).** The job now pauses audit deletion only for the held company's records, and the sentence says so: "A hold placed for one company pauses deletion only for that company's records: records about the company, its products and their reviews, the integrations and connections it built or its products take part in, and requests to claim its listings, and records of what its current team did. Every other audit record is still deleted on schedule. When the duty is not limited to one company, or we do not yet know its scope, we place a hold for all records, and it pauses deletion of every audit record while it is open." The trigger stays "when we reasonably anticipate or are subject to a legal duty". Edited in place in the 1.1 draft, which has no effective date, so no bump. The list matches the six ties of `auditRowOfVendor` (ADR 0058 decision 3). Counsel has not seen the new sentence. The "or four years if there is no acceptance record" fallback is AECI-1971 (ruling 60).
- **Item 14.12, Retention, acceptances with no vendor account (Q67). Applied.** The three start days are named: the day a claim is declined, withdrawn or expires, the day of the acceptance, the day the company was deleted.
- **Item 14.14, Deletion, the legal-process sentence (Q70). Applied.** "legally required to preserve, or that we need to keep for an actual or reasonably anticipated legal claim".

**After the build checks of November 19, 2026 (AECI-1972, rulings 59 to 61).** Still the Privacy Policy 1.1 draft, in place.

- **Retention.** The acceptance sentence names only a declined claim, because a claim has no withdrawn or expired state.
- **How we share data.** "Only in response to legal process" now covers a person or company outside the service. Four things shown inside a vendor company are named: a claimant's details to the company's owners, seats to each other, acceptances to owners, and the sender's name on an invitation. The sentence "The claim form tells you this before you send it" is kept true by the claim form's notice and by the route, which sends a claim to the owners only when the form showed that notice (`routed_notice_shown`).
- **AECI-1971 (ruling 60). Built November 26, 2026, with a Privacy Policy text change, off the gate list.** Audit rows of an acceptance that no longer exists were kept forever. The prune now deletes them four years after the action. The fallback went in widened, naming the grant and the Terms acceptance (see the AECI-1971 paragraph above). Counsel has not seen the widened sentence.

**Not applied, and each gates the first effective date:**

- **Item 14.13, the first in-force Vendor Terms (Q69, ruling 58).** It takes a new version number, says it replaces every earlier draft, says it covers the listing and content already submitted, and says a company that has not accepted sees only the acceptance screen and keeps its claimed listing. It lands in the change that creates that version.
- **Item 14.14, the account deletion screen (Q70).** Counsel's wording says we remove the name and profile from published reviews. Confirm that first.
- **Ruling 53 (Q63): a tick box.** A line beside the sign-in buttons does not bind a reader to a rights-reducing change. The box shows at the first sign-in after such a version (AECI-1637). This narrows ruling 43.
- **Ruling 54 (Q68): AECI-1969. Built November 19, 2026, no text change, off the gate list.** A policy version is published on `/admin/legal`, emailed to every seat and the billing email of each claimed company by `legal-terms-change`, and switches in only once published. A company the email did not reach stays on the version it accepted.
- **Ruling 55 (Q66): AECI-1970.** A hold pauses only the held company's records.

- **AECI-1869, Privacy Policy "Retention": done, no text change (November 17, 2026).** The audit record no longer stores About you values, and a one-time scrub removes the old ones (`scripts/ops/2026-11-about-you-audit-scrub/`). The sentence is true once the scrub has run on a tier.
- **Text item 14.7, Privacy Policy "Deletion" (AECI-1683, ruling 45). Applied.** After the list of what is kept: "We also keep a copy of information that the law requires us to preserve, for example when we have received legal process about it, for as long as that requirement lasts."
- **AECI-1871, `/docs/trust/how-ranking-works` (Q44, ruling 36). Applied in ranking page 1.1.** "A paid plan lets a vendor edit more of its own listing. It changes what a page says, never where it appears." **Superseded in 1.2 by item 14.8 (AECI-2230, November 26, 2026).**
- **AECI-1870 (Q60, ruling 28).** A short notice when the first versions take effect. Counsel said none is owed for text added before the first effective date. A new use of data we already hold needs notice whenever its text lands.

**Also applied in legal branch 6 (AECI-1363, November 18, 2026), all in place:**

- **AECI-1681, Privacy Policy "Edge request log" and "Debugging record".** "They stop working within days" is replaced, in both, by: "A sign-in link stops working within a day, a confirmation link after 7 days, and a seat invite 14 days after it was last sent." A seat invite re-send keeps its token and moves the expiry forward (`vendor-seat-invites.ts`), so the sentence counts from the last send. Unsubscribe and mute links, which never expire, stay unnamed (ruling 4A, 2026-11-18).
- **AECI-1532, Privacy Policy "Contact details" and "Retention".** A waitlist signup or feedback message keeps the referring page and approximate location from the connection. A waitlist signup also keeps campaign tags, metro area and network provider. Retention now reads "Waitlist and feedback records".
- **AECI-1857, Terms of Service "What the service is".** "Our editorial judgment and search ranking are algorithmic" became "Search ranking is algorithmic. Neither it nor our editorial choices are ever influenced by payment." Chris ruled option B on 2026-11-18. Counsel has not seen it. Q62 may touch it again. **Superseded on November 26, 2026 by item 14.8 (AECI-2230):** the second sentence is replaced by ruling 65's wording.
- **AECI-1894, ranking page 1.1, "A product page".** The order of every list `main`'s product page renders, taken from the code. The redesign's lists (Similar products, the long-list groups, the hero category list, the empty-pair closest matches) and its Browse menu section go into the redesign branch's ranking bump, which becomes 1.2.
- **AECI-1915, `/account` delete text.** The sentence saying published reviews are anonymized now reads "Reviews you've published stay online, but they are no longer linked to your account." That wording is ruling 3 of 2026-11-18. The confirmation dialog says the same ("Your published reviews stay online, but are no longer linked to your account."). The missing space before "Read the Retention section" is back. Both the page and the dialog gained one line for the rest of the Privacy Policy's "Deletion" list, which the screen did not name before (the audit record, an agreement accepted for a company, and the new legal-preservation copy), so "The deletion screen tells you what is kept" holds. The em dash guard for `.html` templates is still open on that issue. **Superseded on November 19, 2026 by ruling 59 (AECI-1972):** both now read "Reviews you've published stay online. They never showed your name or profile, and they are no longer linked to your account. The text stays as written, so anything in it that identifies you will remain visible."

**The gate list after legal branch 6.** Every counsel text item for the documents as they stand today is applied. The Q53 screening disclosure waits for the screening build (ruling 29). Every build issue named on the November 5 list, AECI-1677, AECI-1638, AECI-1665 and AECI-1690 is Done in Linear. AECI-1621 reads On Hold in Linear, though this README records it built on November 16, 2026. Before the first effective date, these remain: counsel's sign-off on the drafts (with the sentences counsel has not seen, listed on AECI-1363), the open item above (the first in-force version number; the policy-change email was built by AECI-1969), and the AECI-1870 notice for the day the first versions take effect.

On November 6, 2026 **AECI-1625** added one clause to the Privacy Policy's "Vendor claims and seats" bullet: a buyer of Managed subscriptions is asked for their title, and we use the company's legal name on record. An owner seat invited by a colleague has no claim, so checkout asks its title. It went into the v1.1 draft in place, without a bump, because that draft has never taken effect. The "Agreement acceptance records" bullet is left as counsel batch 2 (AECI-1363) wrote it, which says the signer fields go to Stripe with the checkout. Counsel should check the clause with AECI-308.

On November 7, 2026 the sign-in page redesign added a paragraph to the Privacy Policy's "Cookies and similar technologies": the sign-in page keeps one word in local storage, the method last chosen, to mark it "Last used". It went into the v1.1 draft in place, without a bump, because that draft has never taken effect. Counsel should check it with AECI-308.

On November 4, 2026 **AECI-1592** added a paragraph to the Privacy Policy's "Cookies and similar technologies": dismissing a notice is the visitor's choice, the browser keeps a per-notice flag, and we remove the flag on the first visit after the notice period ends. It went into the v1.1 draft in place, without a bump, because that draft has never taken effect. Counsel should check it with AECI-308.

**DMCA designated agent: registered** with the U.S. Copyright Office DMCA Designated Agent
Directory on October 28, 2026 (**AECI-305**, registration number DMCA-1084399), as the role
"Copyright Agent, The WBS Project, Inc." at the address and `copyright@thewbsproject.com` printed in
the Terms' "Copyright complaints" section. The directory entry and the Terms block must stay
identical; change both together. The registration **lapses on October 28, 2029** unless renewed
before then, and a lapse loses the §512 safe harbor for user reviews.

**Arbitration / class-action waiver: decided against** (AECI-312, October 14, 2026). Disputes go
to the courts named above. Rationale is on the issue; revisit if user volume grows.

## Versions and URLs (spec §27.3, AECI-1361)

Every version has a stable URL. The repo is private, so git history is not the public version log.

| What                | Where                                   | URL                          |
| ------------------- | --------------------------------------- | ---------------------------- |
| Current version     | `<name>.md` (this folder)               | `/legal/<slug>`              |
| Current version, at its own address | `<name>.md` (this folder) | `/legal/<slug>/v<version>` |
| Upcoming version    | `versions/<slug>/v<version>.md`         | `/legal/<slug>/v<version>`   |
| Superseded version  | `versions/<slug>/v<version>.md`         | `/legal/<slug>/v<version>`   |

- An archive file is the superseded version's **final text, copied unchanged**, frontmatter
  included. Recover it with `git show <sha>:apps/web/src/content/legal/<name>.md`, where `<sha>`
  is the last commit before the bump.
- The current pointer is the current file's frontmatter `version`. `currentLegalVersion(slug)` in
  `app/legal/legal-content.ts` reads it. The shared agreement map
  (`LEGAL_AGREEMENT_CURRENT_VERSIONS`, `packages/shared/src/api/agreements.ts`) must equal it for
  the vendor terms and the Managed plan agreement; a spec checks this.
- Each archive is listed in `LEGAL_ARCHIVES` (`app/legal/legal-manifest.ts`) with its superseded
  date: the date of the commit that bumped the current file. Every `/legal/<slug>/v<version>`
  page is served by one route: a URL matcher (`legal-version-matcher.ts`) and a lazy guard
  (`legal-version-route.ts`) that reads this manifest. A version with no page falls through to
  the 404 route. The manifest also holds them out of the index (`NOINDEX_PATH_PREFIXES`).
- An archive page opens with "This is version X, superseded on <date>. Read the current version."
  It is noindex, canonicalises to the current page, and is not in `sitemap.xml`.
- An **upcoming version** (AECI-1610) is a version committed before it takes effect. It uses
  the same `versions/` slot and URL as an archive. Its entry in `LEGAL_UPCOMING`
  (`app/legal/legal-manifest.ts`) is `{ slug, version, effectiveOn: 'YYYY-MM-DD' }`, and
  `LEGAL_UPCOMING_PATHS` derives from it. **The manifest entry is what makes it upcoming, not a
  frontmatter flag.** A flag would have to be edited out of the text on bump day, and the text
  must stay as published. The file's `effective_date` is `effectiveOn` written out ("March 31,
  2027"). The page opens with "This version takes effect on <date>. Until then the current
  version applies.", linking the current page. It is noindex, canonicalises to the current
  page, gets the egress `X-Robots-Tag`, and is not in `sitemap.xml`, the same as an archive. It
  keeps the static `/legal/*` TTL with no purge. That TTL ends at the effective moment, when the
  page switches by itself (next section).
- **The current page announces it, not the current file.** While an entry is listed, `/legal/<slug>`
  and the current version at its own address show "Version X takes effect on <date>. Read version
  X.", linking the upcoming page. `LegalPage` builds that line from the manifest. **Announcing a
  version never edits the current Markdown file**, and the registry does not ask for a
  `## Change history` line for it. The current files promise that every version is listed under
  Change history, so the page also lists the upcoming version there, from the manifest: a line
  "Version X: takes effect on <date>." right after the body, with the version linked. The
  registry checks `## Change history` is the body's last section, so that line always lands in
  it. The promise holds without a text edit. The current file of an agreement is hashed
  (`LEGAL_AGREEMENT_TEXT_SHA256`), and an acceptance stamped with that hash must keep matching
  the file while the version is in force (the ruling on AECI-1610, 2026-11-12).
- The **current version is served at its own address** too, `/legal/<slug>/v<version>`
  (AECI-1610). A change notice links that address, and on bump day the upcoming file moves into
  `<name>.md`. Without this route the link in every notice already shown would 404 from the
  effective date. So one address serves one version for life: upcoming, then current, then
  archived. The route's guard reads the current version from `LEGAL_CURRENT_VERSIONS`
  (`app/legal/legal-manifest.ts`), because it cannot import the Markdown. The page serves the
  current text and opens with "This address always shows version X. For the version that
  currently applies, see <document title>.", linking `/legal/<slug>`. It does not say the
  version is in force, because a draft's own text says it is not. It is noindex, canonicalises
  to `/legal/<slug>`, gets the egress `X-Robots-Tag`, and is not in `sitemap.xml`. It serves the
  text rather than redirecting, because a notice must link a fixed copy.
- For the vendor terms and the Managed plan agreement, `LEGAL_AGREEMENT_UPCOMING_VERSIONS`
  (`packages/shared/src/api/agreements.ts`) mirrors the upcoming entry as
  `{ version, effectiveOn }`. For the Listing Accuracy Policy and the Review Guidelines,
  `LEGAL_POLICY_UPCOMING_VERSIONS` (same file) does the same, because a claim records their
  versions. Specs check each mirror equals the manifest. `agreement-text-hash.spec.ts` requires
  the upcoming agreement file's hash in `LEGAL_AGREEMENT_TEXT_SHA256` from the change that adds
  it, because the version can be in force, and stamped, before bump day (AECI-1689).
- Every current file **ends with** `## Change history`: one list line per version, naming
  `Version X.Y` once. Give the effective date, or say "draft, never in force" for a version that
  never took effect. A superseded version's line links its archive URL and gives its superseded
  date. For example:

  ```markdown
  ## Change history

  - **Version 1.1** (this version): draft, not yet in force.
  - [Version 1.0](/legal/terms/v1.0): draft, never in force. Superseded October 14, 2026.
  ```

  An upcoming version gets no line in the current file. Its own file carries its final change
  history: "this version", then the old current version linked and superseded on the effective
  date. The registry checks that history as if the file were current (AECI-1689).

- The registry (`app/legal/legal-versions.ts`) checks all of this at module init. It throws, and
  fails `ng test`, on any of these:
  - a version collision, or a file in both manifests;
  - a filename/frontmatter mismatch;
  - a `versions/` file missing from both `LEGAL_ARCHIVES` and `LEGAL_UPCOMING`, or an entry with
    no file;
  - a `LEGAL_CURRENT_VERSIONS` entry that is not the current file's `version`;
  - a second upcoming entry for the same document;
  - an upcoming version not later than the current one, an `effectiveOn` that is not a real
    `YYYY-MM-DD` day, or an `effective_date` that is not that day written out;
  - an archived version not listed, with its link and superseded date, in the change history;
  - a listed version or link that does not resolve;
  - an upcoming file whose own change history, read as current, breaks any of the last two: the
    old current version must be listed with its link and the effective date as its superseded
    date.
- No check reads the clock. An upcoming entry whose date has passed still builds, so `main`
  never turns red on a date. The site switches on the date by itself (next section), and
  `scripts/legal-upcoming-overdue.mjs` prints a CI warning, never a failure, once an entry is more
  than 14 days past its moment.

### The effective date switches by itself (AECI-1689)

From the effective moment, 12:00 UTC of `effectiveOn`, an upcoming version is the current one
with no deploy. One rule decides it everywhere: `legalAgreementVersionInForce`,
`legalReaderVersionInForce` and `legalPolicyVersionInForce`
(`packages/shared/src/api/legal-in-force.ts`).

- **Every document switches only once published: the Vendor Terms, the Managed plan agreement,
  the Terms, the Privacy Policy, the Review Guidelines and the Listing Accuracy Policy.** Until
  AECI-1637 (2026-11-13) the Terms and the Privacy Policy switched on their date alone, and until
  AECI-1969 (2026-11-19, counsel Q68, ruling 54) the two policies did. The upcoming
  version needs a `legal_versions` row with the same effective moment ("Publishing an upcoming
  agreement version" below). A row means its change notice went out. No row, no switch, on any
  surface, ever: the page keeps the old version current and keeps saying "takes effect on
  <date>", and new claims and checkouts keep stamping the old version. Publishing is refused in
  demo and production while `LEGAL_PUBLISH_ENABLED` is `"false"`, so each agreement's first
  effective date waits for that release.
- **A policy version is the Vendor Terms change email too (AECI-1969).** The Vendor Terms make
  both policies "part of these terms", so publishing one emails every seat and the billing email
  of each claimed company (`legal-terms-change`), with the version, its effective date, the
  summary, the archived link and the PDF. Every policy version is material and none needs
  acceptance; the API refuses either answer. It may be expedited for the Vendor Terms' two
  reasons. The site-wide band in `notices.json` still announces it to readers, but it is not the
  vendors' notice.
- **What switches.** `/legal/<slug>` serves the new text as current. `/legal/<slug>/v<new>` is the
  current version at its own address. `/legal/<slug>/v<old>` serves the old text, superseded on
  the effective date. The announcement and the extra Change history line stop. A new claim,
  listing request, checkout or grant stamps the new version, its text hash and, for a policy,
  its version on the claim row. The 45-day renewal notice compares against it.
- **How the pages know.** The legal pages have no database. Once the moment of any upcoming version has come,
  the SSR Worker reads `GET /api/legal/published` over the service binding, decides, and hands
  the browser the same answer. If that read fails, the page shows the old version and is cached
  for a minute (`docs/CACHE_STRATEGY.md` §4). Every cacheable page's cache ends at the moment, the
  claim box and the docs included, so no purge is needed.
- **A daily warning.** The data-quality digest lists `legal_agreement_unpublished` when an upcoming
  version of any publishable document (the two policies included since AECI-1969) is 30 days or
  less from its moment, or past it, with no publish. Publish it or
  move the date.

### Which policy version a company is on (AECI-1969, counsel Q68, ruling 54)

A claim records the Listing Accuracy Policy and Review Guidelines versions its box named
(`agreement_acceptances.listing_accuracy_version` / `review_guidelines_version`), and so does an
owner's Vendor Terms acceptance on the portal screen (AECI-1677). Counsel: a company stays bound
to that version until we follow the change process. So a company is on the **newest** of:

- the version its latest Vendor Terms acceptance recorded (a claim or a portal accept; a claim
  older than the policy columns recorded none and is skipped); and
- each published version whose effective moment has passed **and** whose change email reached
  that company (`legal_notice_deliveries.status = 'delivered'`).

A company the email did not reach (no address, dropped, expired, or claimed after the fan-out)
stays on its earlier version. A re-send before the moment reaches it, because the re-send queues
every company not yet delivered. After the moment, only the next version's email moves it on.
No new row is written: the acceptance row and the delivery row are the record, and
`companyPolicyVersion` (`packages/shared/src/api/policy-binding.ts`) reads them. The admin
Billing tab of each company shows the answer, with any version it missed and the one coming next
(`GET /api/admin/vendors/:id/billing`, `policy_versions`). The public page and a new claim follow
the version in force (`legalPolicyVersionInForce`), which is the same for everyone.

**When to bump.** Once a version is in force (`effective_date` set), any text change is a new
version: bump and archive. While a document is still a draft that never took effect, a wording
fix may be made in place without a bump; update `last_updated`. AECI-1361 did this for the four
launch documents when it replaced the "public commit log" sentence.

**Announcing a version is not a text change to the current one.** It adds the new file and the
manifest entry only. Never edit the current file to announce it: for an agreement that changes
the hashed text of a version in force.

**When the change materially affects how we use personal data, add the notice first.** Add the entry to
`notices.json` and deploy it at least 31 days before the effective date. If that date is missed, move
the effective date. See "Site-wide notice of a material change" below.

### The Plans page is versioned too (AECI-1619)

`/docs/vendors/plans` is not a legal page, but a checkout or grant acceptance records it (counsel
ruling 16, and the Managed plan agreement's "We record the Plans page as it stood when you
accepted"). So it joins the versioned set, with its own rules. The governing doc is
`docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §4, and the how-to is `apps/web/src/content/README.md`.

- **A rendered snapshot per version, not a copy of the source.** The page is Markdown plus code
  widgets: the plan cards, the comparison table built from `TIER_CAPABILITIES`, and the prices. So
  each version's file, `content/docs/vendors/versions/plans/v<version>.md`, prints them as
  Markdown (`plans-snapshot.ts`, written by `pnpm docs:plans-snapshot`). The current version has a
  file too, so every stored hash resolves. The acceptance row stores the version and the file's
  SHA-256 (`PLANS_PAGE_SHA256`).
- **`## Versions`, not `## Change history`.** The live page lists each version just before
  `## Related`, with its recorded date (`PLANS_PAGE_RECORDED_ON`). The section is left out of the
  snapshot, so a new line does not change an older hash. `buildDocsManifest` checks it the way
  `legal-versions.ts` checks a change history.
- **Every content change bumps.** There is no draft window. Acceptances can already reference the
  page, so any change to its copy, the cards, the table, a capability or a price is a new version.
  `plans-snapshot.spec.ts` fails until the bump is done. Never edit an older version's file.
- **The archive route.** Each version is served at `/docs/vendors/plans/v<version>`. It is
  noindex, canonicalises to `/docs/vendors/plans`, and is not in `sitemap.xml` or the docs search.

### The ranking page is versioned too (AECI-1621)

`/docs/trust/how-ranking-works` is not a legal page either. The Terms of Service link it for
"Payment never changes the order in which products are listed or returned in search" (since
November 26, 2026, item 14.8), with "If that page and these terms conflict, these terms control", and the
Vendor Terms link it too. Counsel Q23 asks that we can show what the page said on any past date. So
it joins the versioned set, on the Plans pattern with three differences. The how-to is
`apps/web/src/content/README.md`.

- **A copy, not a rendered snapshot.** The page is plain Markdown with no widgets. Each version's
  file, `content/docs/trust/versions/how-ranking-works/v<version>.md`, is the page's body with the
  `## Versions` section left out.
- **No hash.** No acceptance stores this page's version, so there is nothing to hash. Its constants
  live in `apps/web/src/app/docs/ranking-page-versions.ts`, not in `@aeci/shared`.
- **Every content change bumps, a typo included.** `ranking-page-versions.spec.ts` fails until the
  bump is done. The `## Versions` line names what changed. Never edit an older version's file.

The archive route is `/docs/trust/how-ranking-works/v<version>`, on the same terms as Plans.

Version 1.1 (November 18, 2026, legal branch 6) says what a paid plan does change and adds the order of each product page list `main` renders. The redesign branch, which also cut a 1.1 for its Browse menu, renumbers its bump to 1.2.

Version 1.2 is still unpublished, so on November 26, 2026 item 14.8 (AECI-2230) was folded into it in place, live page and archive copy together, with no 1.3. It replaces the 1.1 sentence "It changes what a page says, never where it appears" with ruling 65's wording.

## Change workflow (spec §27.2)

Most changes to these files start as a code change somewhere else. `docs/LEGAL_IMPACT_REVIEW.md`
maps each behaviour the app changes to the section here that describes it, and every plan and PR
states a `Legal impact` verdict against it. A `text` verdict is step 1 below.

To change a legal document:

1. **Proposed change** — identify the needed update (regulatory change, terminology fix, a new
   feature requiring a policy update).
2. **Linear issue** — open one describing the rationale, scope, and urgency.
3. **Branch + PR** — commit the text change on a branch; open a PR linking the Linear issue.
   Reviewers (and counsel) can read the rendered change from the diff, or by running the branch locally. There is no per-PR preview deploy (retired 2026-10-10, AECI-1268).
4. **Counsel review** — counsel reviews the PR diff; capture their approval in the Linear issue.
5. **Bump frontmatter** — increment `version`, set `effective_date`, fill `counsel_approved_by` /
   `counsel_approved_on`, update `last_updated`, and remove the draft notice. Archive the
   superseded text and add its `## Change history` line in the same PR (see above). For the
   vendor terms or the Managed plan agreement, add the new version to
   `LEGAL_AGREEMENT_EFFECTIVE_ON` with the same day (AECI-1677). The first effective date of
   either agreement is always a new version number: the draft versions stay undated for good.
6. **Merge** — the new version goes live on the next deploy.
7. **Close the Linear issue** — link the merged PR and note the effective date.

When a change materially affects users, see §27.4 and the next two sections.

## Announcing a new version before it takes effect (spec §27.3, AECI-1610)

Use this when a version is published ahead of its effective date, so a notice can link it. Run the
steps in this order.

1. **Prepare the text on a branch.** Copy the current `<name>.md` to `versions/<slug>/v<new>.md` and
   make the change there. Set `version` to the new version, `effective_date` to the effective day
   written out ("March 31, 2027"), and `last_updated`. Pick an effective date at least 31 days after
   the day you expect to deploy. Write its `## Change history` as it will read once it is current:
   the new version is "this version", and the old one links `/legal/<slug>/v<old>` with the
   effective date as its superseded date. The file then moves unchanged on bump day, so the text
   published ahead is the text that takes effect. **For an agreement, the date is fixed once the
   version is published** (next section): never edit its `effectiveOn` after that. A wrong date
   means a new version.
2. **Register it in the same branch.**
   - Add `{ slug, version, effectiveOn: 'YYYY-MM-DD' }` to `LEGAL_UPCOMING` in
     `app/legal/legal-manifest.ts`. This alone puts the announcement on the current page.
   - Import the file in `app/legal/legal-content.ts` and add it to `ARCHIVE_SOURCES`.
   - For the vendor terms or the Managed plan agreement, add the same `{ version, effectiveOn }` to
     `LEGAL_AGREEMENT_UPCOMING_VERSIONS` (`packages/shared/src/api/agreements.ts`). For the Terms
     or the Privacy Policy (AECI-1637), add it to `LEGAL_READER_UPCOMING_VERSIONS` in the same
     file. They have no text-hash map.
   - Do **not** edit the current `<name>.md`.
   - For the vendor terms or the Managed plan agreement, add the file's hash to
     `LEGAL_AGREEMENT_TEXT_SHA256` under the new version (`agreement-text-hash.spec.ts` prints it
     when it is missing). For the Listing Accuracy Policy or the Review Guidelines, add the same
     `{ version, effectiveOn }` to `LEGAL_POLICY_UPCOMING_VERSIONS`.
   - If the change is material, add the `notices.json` entry (next section).
3. **Merge and deploy to production** at least 31 days before the effective date. The page goes
   live at `/legal/<slug>/v<new>`. Publish it next ("Publishing an upcoming agreement version"
   below): without a publish no document switches, the two policies included since AECI-1969.
4. **On the effective moment, nothing to do.** At 12:00 UTC of the effective day the site switches
   to the new version by itself ("The effective date switches by itself" above). Check
   `/legal/<slug>` shows the new version after the moment.
5. **Clean up within two weeks, in one change.** For a version that switched, it changes no page
   and no stamp: the switch already shows exactly what this change builds
   (`legal-bump-equivalence.spec.ts`). Run these steps in order:
   - **First, for any document (the two policies included since AECI-1969), confirm the switch happened.**
     `/admin/legal` on production must show the version published with the same effective date
     as the entry (no "will not take effect" alert), and its change notice delivered. If it does
     not, do NOT clean up: this change would make the version current with no notice sent. Move
     the effective date instead, and publish.
   - Move `versions/<slug>/v<new>.md` into `<name>.md` byte for byte, and delete the `versions/`
     file. Its change history was written in step 1, so nothing in it changes.
   - Archive the old current text unchanged at `versions/<slug>/v<old>.md`, with a `LEGAL_ARCHIVES`
     entry whose `supersededOn` is the effective date. Fix the imports in `legal-content.ts`.
   - Remove the `LEGAL_UPCOMING` entry, and the `LEGAL_AGREEMENT_UPCOMING_VERSIONS`,
     `LEGAL_READER_UPCOMING_VERSIONS` or `LEGAL_POLICY_UPCOMING_VERSIONS` entry.
   - If this lands on the effective day itself, leave the version's `notices.json` entry in place:
     the band runs through that whole day, and `legal-notices.spec.ts` accepts a notice for the
     version that is now current. On any later day, remove it here (step 6).
   - Set the slug's `LEGAL_CURRENT_VERSIONS` entry to the new version. The notice's link
     `/legal/<slug>/v<new>` then keeps serving the same text as the current version, and
     `/legal/<slug>/v<old>` serves the archive.
   - For the Terms or the Privacy Policy, set `LEGAL_READER_CURRENT_VERSIONS` to the new version,
     append it to `LEGAL_READER_KNOWN_VERSIONS`, add its day to `LEGAL_READER_EFFECTIVE_ON` (never
     `null`, as for the agreements) and remove its `LEGAL_READER_UPCOMING_VERSIONS` entry (all in
     `agreements.ts`). Confirm the switch happened first, as for an agreement above.
   - For the vendor terms or the Managed plan agreement, set `LEGAL_AGREEMENT_CURRENT_VERSIONS` to
     the new version and append it to `LEGAL_AGREEMENT_KNOWN_VERSIONS`. Its
     `LEGAL_AGREEMENT_TEXT_SHA256` entry is already there from step 2, and the file moved byte for
     byte, so it does not change.
   - In the same file, add the new version to `LEGAL_AGREEMENT_EFFECTIVE_ON` with its
     `effectiveOn` day (`'YYYY-MM-DD'`), the day its `effective_date` writes out (AECI-1677). This
     is how the API knows the version is in force. Never date a version listed there as `null`:
     each was accepted as a draft. `agreements.spec.ts` and `legal-page.component.spec.ts` fail
     until the entry matches the file.
   - For the Listing Accuracy Policy or the Review Guidelines, set `LEGAL_POLICY_CURRENT_VERSIONS`
     to the new version, append it to `LEGAL_POLICY_KNOWN_VERSIONS`, and remove its
     `LEGAL_POLICY_UPCOMING_VERSIONS` entry (same file). A claim records those two versions. The
     Terms and the Privacy Policy use the `LEGAL_READER_*` maps above, not these.
   - Deploy it through the normal release. There is no deadline: no spec fails when the date
     passes. More than 14 days after the moment, the `Legal bump reminder` CI step prints a
     warning on every run until this lands. It never fails a check.
6. **Once the effective day is over, remove the `notices.json` entry.** The band closed at the end of
   that day (UTC), so a closed entry renders nothing. This is tidying, and can ride the cleanup
   change in step 5.

## Publishing an upcoming agreement version (AECI-1688)

For the Vendor Terms and the Managed plan agreement, since AECI-1637 (2026-11-13) for the
Terms of Service and the Privacy Policy too (see "Publishing a Terms or Privacy version" at the
end of this section), and since AECI-1969 (2026-11-19) for the Listing Accuracy Policy and the
Review Guidelines (see "Publishing a policy version"). Publishing records the announcement in
D1 (`legal_versions`, `docs/DATABASE_SCHEMA.md` §8.6i): a summary of the changes, the two flags
(material, needs acceptance; since AECI-1977 an agreement or policy is always material), and the fingerprint of a PDF a customer can save. A material version's publish
also emails the change notice (`legal-terms-change`, AECI-1620) to every affected company. The
vendor acceptance screen (AECI-1677) and the sign-in Terms acceptance (AECI-1637) read the record too. Since AECI-1689
the record is also what lets the version become current at its moment: an unpublished agreement
version never switches. ADR 0054 is
the decision. Run the steps in this order, once per tier.

1. **Commit the upcoming file and its manifest entries.** Steps 1 and 2 of "Announcing a new
   version before it takes effect" above: `versions/<slug>/v<new>.md` with its `effective_date`
   filled, the `LEGAL_UPCOMING` entry, and the same `{ version, effectiveOn }` in
   `LEGAL_AGREEMENT_UPCOMING_VERSIONS`. The publish reads the version and the day from that map,
   never from the form. Pick an effective date at least 31 days after the day you expect to
   publish.
2. **Deploy** to the tier: staging from `main`, production through `promote-to-prod`. The page
   lists only versions in the deployed map.
3. **Run the PDF workflow** for that tier, dispatched from `main`: `.github/workflows/legal-pdf.yml`
   with the slug, the version and the env (`docs/CICD_PLAN.md` §11a-ter). It refuses any other
   branch. It prints the version with its title, "Version X, effective <date>", absolute links
   and a footer with the version's URL and page numbers, and uploads it to
   `legal/<slug>/v<version>.pdf` in the tier's uploads bucket, `aeci-uploads-<env>`. It fails when
   `effective_date` is blank. It never overwrites a file that is already there. A production run
   waits for the `production` reviewer.
4. **Check the PDF before you publish.** The run's summary names the commit (`github.sha`), the
   slug, the version, the env, and the stored object's sha256 and size. Confirm that the upcoming
   file at that commit is the text the tier serves at `/legal/<slug>/v<version>`: the commit must
   be the one deployed to that tier, or one with the same upcoming file. Then open the PDF. On the
   run's page in GitHub Actions, the Artifacts section at the bottom holds a zip named
   `legal-pdf-<slug>-v<version>-<env>` with the PDF in it. From a terminal, the same download is:

   ```bash
   gh run download 19234567890 --name legal-pdf-vendor-terms-v1.4-staging --dir legal-pdf
   ```

   Here `19234567890` is the run id from the run's URL, the name is the artifact's (slug
   `vendor-terms`, version `1.4`, env `staging` in this example), and `legal-pdf` is the folder it
   is saved to. Read the title, the "Version X, effective <date>" line, the footer and a few links.

   **A wrong PDF found before publishing** is removed and printed again, because the workflow
   never overwrites. Delete the object from the same tier's bucket, then re-run the workflow:

   ```bash
   pnpm --filter @aeci/api exec wrangler r2 object delete aeci-uploads-staging/legal/vendor-terms/v1.4.pdf --remote
   ```

   The path is the bucket `aeci-uploads-staging` (use `aeci-uploads-production` or
   `aeci-uploads-demo` for those tiers) followed by the key `legal/vendor-terms/v1.4.pdf`, which is
   `legal/<slug>/v<version>.pdf` for the version you printed. It needs Cloudflare credentials for
   the AEC account with R2 write access.

   **After publishing, never move the effective date either.** The row records the moment. If a
   later commit changes the `effectiveOn` of `LEGAL_UPCOMING` or `LEGAL_AGREEMENT_UPCOMING_VERSIONS`,
   the row no longer matches and the version takes effect NOWHERE: the page keeps the old version,
   new acceptances keep stamping it, and the acceptance screen asks nothing (AECI-1689). The card on
   `/admin/legal` then says so, and the digest lists `legal_agreement_date_moved`. Move the entry back
   to the published date. A different date needs a new version, announced and published again.

   **After publishing, never replace the stored PDF.** The `legal_versions` row records its sha256,
   and every reader of the file re-hashes it. A replaced file no longer matches the record. If the
   published text is wrong, that is a new version.
5. **Publish on `/admin/legal`** on that tier. Answer "Does it need acceptance?" (no default),
   write one summary line per change (1 to 10 lines, each up to 300 characters, plain text with
   no tabs or hidden characters), and give an expedited reason only for a Vendor Terms version
   inside 30 days. **Every agreement version is a material change and is emailed (AECI-1977,
   ruling 62, 2026-11-20):** both agreements promise the email for every new version, so the
   card does not ask, and the API refuses "not material". A version that only fixes an error
   still gets the email; say so in the summary ("This version fixes a typo. Nothing else
   changed."), and give the "fixes an error" reason only if it must take effect sooner than 30
   days. The Terms of Service and the Privacy Policy still ask "Is this a material change?". The
   confirmation says what each answer causes. A publish cannot be undone. The summary lines go
   into the email word for word.
6. **Check the change notice on the card** (every agreement version), after a minute and a
   Refresh. It should say "The last send queued N companies". The Vendor Terms notice goes to
   every unbanned seat and the billing email of every company with a seat. The Managed plan
   notice goes to the owner seats and the billing email of every company with a live
   subscription, grants and complimentary included. Each email carries the version and date, the
   summary, a link to `/legal/<slug>/v<version>` and the PDF. Over the next hour "Delivered"
   should reach "Companies queued" and "Not yet delivered" should reach 0. Every company listed
   under "Companies not reached" has its reason beside it. Fix the cause and press "Send the
   notice again": it queues only the companies not yet delivered and never emails an address
   twice for one company. `docs/runbooks/legal.md` "A legal change notice did not go out" has
   the checks. Staging delivers every notice to the support inbox, so a staging publish is the
   rehearsal. A notice can only go before the effective moment: after it, the re-send is
   refused and a queued retry sends nothing.

The publish refuses, in this order: publishing off on the tier (`LEGAL_PUBLISH_ENABLED`), a
version that is not the upcoming one, a version already published, an effective moment that has
already passed (move the date; an expedited reason does not help) or is less than 30 days away
(move the date, or expedite a Vendor Terms change), and a missing, non-PDF or over-5 MB file.

**The effective moment is 12:00 UTC on the `effectiveOn` day.** Not midnight: 00:00 UTC is the
evening before in the Americas, which would start a version early there and shorten the 30-day
notice. Noon UTC falls on the named day from UTC-12 to UTC+11. `legalEffectiveAtMs`
(`packages/shared/src/api/legal-moment.ts`) is the one conversion. It sets
`legal_versions.effective_at` and measures the 30-day window. Anything else that has to know when
a version takes effect should call it rather than build its own date.

### Publishing a Terms or Privacy version (AECI-1637)

The steps are the ones above, with these differences.

- **Slug and maps.** Dispatch the PDF workflow with slug `terms` or `privacy`. The upcoming entry
  goes in `LEGAL_READER_UPCOMING_VERSIONS`, not the agreement map. Until a row publishes the
  version it never switches, so the Terms' first effective date waits for the release that turns
  `LEGAL_PUBLISH_ENABLED` on.
- **The notice goes to accounts, not companies.** A material publish emails every unbanned
  account holder (`legal-account-change`, no unsubscribe link: it is a legal notice), with the
  summary, the version link and the PDF. The card says "accounts". `docs/runbooks/legal.md`
  "A legal change notice did not go out" has the checks.
- **Window and expedite.** The 30-day window applies, because the Terms promise 30 days. No
  reader document can be expedited, so a date inside 30 days means moving the date.
- **Set `material` to Yes** when the change materially affects users: new data collection,
  wider use of personal data, a new restriction, or a change to how they may use the service. A
  wording fix or a correction that changes nothing for them is No, and sends nothing. When in
  doubt, ask counsel before publishing: a publish cannot be undone, and the 30-day banner
  (`notices.json`) is separate.
- **Set `requires_acceptance` to Yes only for a Terms change that reduces a reader's rights.**
  Signing in is the acceptance (ruling of 2026-11-13): the login page always says "By signing
  in, you agree to our Terms of Service and Privacy Policy." A version with Yes needs more
  (counsel Q63, ruling 53, built 2026-11-19). At each account holder's first sign-in after it
  takes effect, `/auth/terms` shows one unticked box, "I have read and accept the updated Terms
  of Service." The version applies to that account only once they tick it, never on continued
  use, and the email says so. Until then the earlier version applies. A reader who leaves
  without ticking stays signed in on the earlier version, and the next sign-in asks again. An
  account created by that sign-in never sees the box. Nothing else is blocked, and a live
  session is not interrupted. A Terms change that does not reduce rights is material at most, and binds by
  continued use. **Privacy never takes it.** The form hides the
  question and the API refuses `requires_acceptance` for a Privacy publish: a Privacy change
  gets the email and the 30-day window and nothing else.
- **Check the card** for "Accounts queued", "Delivered" and "Accounts not reached", and the
  account count in "The last send queued N accounts". The count is of every unbanned account.
- **After the effective moment** every sign-in records the acceptance of the new Terms version,
  once per account. With Yes, the record is the ticked box, not the sign-in line. The acceptance records are in `terms_acceptances`
  (`docs/DATABASE_SCHEMA.md` §8.6k).
  They are kept for the life of the account plus 6 years, even after deletion, and the IP
  address and browser go at 90 days. The legal retention prune deletes them six years after
  the account's `account.deleted` audit row (AECI-1718). The Privacy Policy "Agreement acceptance records" names
  this record. The sign-in line's text is `SIGN_IN_TERMS_LINE`: change it only with the legal
  text, and the record stores the exact text shown. The box label is `TERMS_CHANGE_BOX_LABEL`
  (`packages/shared/src/api/agreements.ts`) and follows the same rule.

### Publishing a policy version (AECI-1969, counsel Q68, ruling 54)

The steps are the agreement steps above, with these differences.

- **Slug and maps.** Dispatch the PDF workflow with slug `listing-accuracy` or
  `review-guidelines`. The upcoming entry goes in `LEGAL_POLICY_UPCOMING_VERSIONS`. Until a row
  publishes the version it never switches, on the page or in a new claim.
- **The notice is the Vendor Terms notice.** The Vendor Terms make both policies "part of these
  terms", so the publish emails every unbanned seat and the billing email of every claimed
  company (`legal-terms-change`), with the summary, the version link and the PDF. The card says
  "companies".
- **No questions.** Every policy version is material, because the Vendor Terms promise the email
  for every change, and none needs acceptance. The card asks neither, and the API refuses
  `material: false` and `requires_acceptance: true` for a policy.
- **Window and expedite.** The 30-day window applies. Like the Vendor Terms, a policy version
  may take effect sooner when the law requires the change or it corrects an error.
- **Check the card** for "Companies queued", "Delivered" and "Companies not reached". A company
  not reached stays on the version it accepted ("Which policy version a company is on"). Send
  the notice again before the effective moment to reach it.

## Runbooks behind these promises (AECI-1622, AECI-1674)

Some sentences here are promises about what we do when something happens. The procedure for each is in
`docs/runbooks/legal.md`. Change the runbook when the promise changes.

| Promise | Document and section | Runbook |
|---|---|---|
| We disclose identifying information only in response to legal process, and tell the user first where the law permits | Privacy Policy "How we share data"; Terms of Service | "Subpoena or legal process for a reviewer's identity" |
| Single-use links stop working: a sign-in link within a day, a confirmation link after 7 days, a seat invite 14 days after its last send | Privacy Policy "Edge request log" and "Debugging record" | "Data breach (Fla. Stat. 501.171)", recorded checks |
| We promptly notify the poster, forward a counter-notice, restore between 10 and 14 business days after it unless a court action is filed, and keep a log of every notice and counter-notice | Terms of Service "Copyright complaints" | "Copyright notice or counter-notice" |

### The acceptance evidence chain (AECI-1680)

Every acceptance of these agreements is a row in `agreement_acceptances`. Each night at 18:00 UTC
a job writes the SHA-256 fingerprint of every new or changed acceptance and grant row to a
hash-chained file in the `UPLOADS` R2 bucket under `evidence/acceptance-chain/`, and DigiCert
timestamps each file (ADR 0057). The files hold fingerprints and fields that are not personal,
never the rows, and the IP address and browser are not in the fingerprint. To prove an acceptance
was not edited, run `pnpm --filter @aeci/api ops:verify-acceptance-chain -- --env production`.
The steps are in `docs/runbooks/legal.md` "Prove an acceptance was not edited". No page promises
this record, so a change to it needs no new legal version.

## Site-wide notice of a material change (spec §27.4, AECI-1592)

The Privacy Policy promises a notice on every page for 30 days before a material change takes effect,
naming what changes and linking to the new version. `LegalNoticeBand` (`app/legal/legal-notice-band.ts`)
renders it from `notices.json` in this folder. The file ships as `[]`.

**No notice entry without an upcoming version in the manifest.** A notice links to the new version
at `/legal/<slug>/v<version>`, the upcoming page ("Announcing a new version before it takes effect"
above, AECI-1610). `LEGAL_UPCOMING_PATHS` (`app/legal/legal-manifest.ts`) derives from the
`LEGAL_UPCOMING` entries. `legal-notices.spec.ts` fails on any notice whose URL is not listed, and on
one whose `effectiveDate` is not the entry's `effectiveOn`. After the bump it accepts a notice for the
version now current. Add the upcoming version and its notice in the same change, and remove the
notice once the effective day is over. This does not gate a document's first effective date.

Each entry:

```json
{
  "slug": "privacy",
  "title": "Privacy Policy",
  "version": "1.2",
  "effectiveDate": "2027-03-31",
  "effectiveDateLabel": "March 31, 2027",
  "summary": "One line naming what changes."
}
```

- `title` is the document's frontmatter `title`. `effectiveDateLabel` is `effectiveDate` written out.
  The spec checks both, and keeps `summary` to 200 characters.
- The band opens at 00:00 UTC, 30 days before `effectiveDate`, and closes when that date has passed.
- Merging is publishing. Deploy to production at least 31 days before the effective date. A late deploy
  shortens the 30 days, so move the effective date instead.
- Nothing has to happen on either boundary. Every page's cache TTL ends at the boundary
  (`docs/CACHE_STRATEGY.md` §4).
- Remove the entry once the effective day is over (step 6 above). The band runs through that day,
  so do not remove it before the day is over. A closed entry renders nothing.
- `summary` is content, like the Markdown body, so it is not extracted into `messages.xlf`.

## Open Government Licence attribution (AECI-1310)

Company facts can come from Companies House under the Open Government Licence v3.0. Its attribution is
not in these files. It is the blanket line in `app/shared/company-facts-note/company-facts-note.ts`,
ruled on 2026-11-04, on the vendor page's sidebar and `/search`. Keep it while any company fact comes from
Companies House. The review app's `docs/company-data-sources.md` is the source register.

## i18n

The markdown body is **content**, not UI strings — it is not extracted into `messages.xlf`. Only
the page chrome (title/meta/labels) is `$localize`-wrapped in `legal-page.ts`. Future localization
adds per-locale files (e.g. `terms-of-service.es-ES.md`) selected by the active locale, not message
catalogue entries.
