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

On November 5, 2026 **AECI-1363** and **AECI-308** applied counsel's answers (Josh Begg, Rocket Lawyer) and Chris's rulings 1 to 8 to all six drafts in place, without a bump, and finished the AECI-1609 rename of the product noun from license to subscription. No effective date may be set until these ship: **AECI-1238**, **AECI-1590**, **AECI-1591**, **AECI-1592**, **AECI-1596**, **AECI-1613** to **AECI-1622**, **AECI-1636**, **AECI-1637**, **AECI-1665** and **AECI-1677**. **AECI-1628** (contest accepts and logo overwrites marked as our correction, with source and date) is built as of November 9, 2026, with no text change. **AECI-1238** (a hidden listing kept off the public site and out of search with its data kept, and one contested value hidden as "under review" within two business days of a public source, with the received date, the hide, any status reply and the decision on record) is built as of November 9, 2026, with no text change. **AECI-1619** (a claim records the versions of the two policies the Vendor Terms incorporate, a checkout or grant records the dated Plans page version and its snapshot hash, and every acceptance stores the label text beside its box) is built as of November 11, 2026. Its one text change is the Managed plan agreement edit described below. **AECI-1613** (a reviewer's dated update to a published review) is built as of November 6, 2026, and the Review Guidelines describe it in place under "Updating your review", without a bump. **AECI-1623** (suspend, then end, replacing the ban AECI-1589 shipped) is built as of November 5, 2026, with one known gap: the pages on `main` say "7 days", and counsel's follow-up the same day set 7 **business** days (Monday to Friday, US federal holidays excluded), each from the first confirmed send of that stage's notice, in two sequential stages. The code is more generous than the current text. Text item 10.2 landed in the Managed plan agreement on November 6, 2026, and item 10.3 in Vendor Terms 1.2 on November 7, 2026. The bold clauses and the capitals in the disclaimers are deliberate, because counsel asked for them to be conspicuous. The conspicuous clauses are the liability limits, the disclaimer capitals and the jury waiver. They must survive archiving, so an archive copies the Markdown as it is. "License" now means only the copyright license in these pages.

On November 6, 2026 **AECI-1363** applied counsel's batch-1 follow-up and batch-2 answers (legal change list sections 10 and 11) to the Managed plan agreement, the Privacy Policy, the Terms and the Listing Accuracy Policy, in place and without a bump. Those four have no acceptance at their current version in production. The Vendor Terms items were held that day and landed in 1.2 the next (see November 7, 2026 below). The bracketed read-receipt sentence in 11.16 was dropped: **AECI-1616** found the read record is internal only. New promises with no code yet: the 90-day deletion of a claim's IP address and browser (**AECI-1636**), and the email to account holders and click-to-accept of a rights-reducing change (**AECI-1637**). Both are on the gate list above.

On November 7, 2026 **AECI-1363** bumped the Vendor Terms to **1.2** and archived 1.1 unchanged at `/legal/vendor-terms/v1.1`. The reason is the rule in `docs/LEGAL_IMPACT_REVIEW.md` §2: production holds one Vendor Terms 1.1 acceptance, a claim from November 5, 2026, so no further edit could change 1.1 in place. 1.2 carries the held items 10.3 (business-day windows), 10.5 (asset removal within 14 days, caches included, a sourced logo removed on objection), 10.6 (the lost-profits exclusion in the bold cap block), the Vendor Terms half of 11.2 (IP address and browser deleted 90 days after acceptance), 11.12, 11.13 (exclusive courts, venue objection waived), 11.17 (bold jury waiver) and the Vendor Terms part of 11.19. The claim box's short form now credits the Vendor Terms for the exclusion, and the server stamps 1.2 (`LEGAL_AGREEMENT_CURRENT_VERSIONS`). The same day, in place and without a bump, the Terms took item 11.18 (a bold $100 cap on our liability to readers) and their part of 11.19, the Managed plan agreement took its part of 11.19 (a per-product cap base with a site-wide fallback), and the Privacy Policy now says a thread read record is deleted with the account (branch-2 review ruling 1). Item 11.19 replaces "This limit covers our liability only" in all three with counsel's one-directional wording (Q1 follow-up, November 7, 2026). The read-receipt sharing sentence is not added: AECI-1616 found the other company cannot see read state.

On November 9, 2026, still inside the unaccepted 1.2 draft, **AECI-1639** added the company's legal name to the owner-seat powers under "Seats and revocation", and **AECI-1649** dropped "your role" from the claim form's fields in the Vendor Terms' "Personal data" and the Privacy Policy's "Vendor claims and seats". The 1.1 change-history line records the one claim accepted under 1.1. The checkout's cap short form now names the per-product base (`MANAGED_PLAN_CAP_SHORT_FORM` and the Pay by card panel). The AECI-1649 code must not merge before this text.

On November 9, 2026 **AECI-1654** added one sentence to the Privacy Policy's "How we share data", after the processors paragraph (text item 11.20): vendor logos load from Brandfetch, which receives the visitor's IP address and browser details. Brandfetch is an independent controller for those logs, not our processor (ruling on AECI-310), so it is not in the processors list. It went into the v1.1 draft in place, without a bump, because the Privacy Policy is never accepted by a click. Counsel should check it with AECI-308.

On November 9, 2026 **AECI-1594** named the "Debugging record" in the Privacy Policy's "What we collect" and "Retention": Cloudflare Workers traces and our own log lines, kept 7 days, for every request including DNT and GPC, with link parameters removed (`redact_query_string`) and no IP address or cookies (`invocation_logs: false` in every `wrangler.jsonc` observability block). It also allows a fuller record for up to 72 hours at about 1 request in 10, which holds the IP address and full URL, with each on and off recorded (Chris's ruling of the same day, built by AECI-1656). The same change limits the "no identifiers" bullets under "Do Not Track, Global Privacy Control, and operational telemetry" to the error and performance reports sent from the browser, and adds a paragraph there pointing at the debugging record. It went into the v1.1 draft in place, without a bump. Counsel should check it with AECI-308.

On November 9, 2026 **AECI-1363** applied legal branch 4 (change list section 12, the second Rocket Copilot pass) to all six drafts in place, without a bump. Production holds no acceptance of Vendor Terms 1.2 and none of the Managed plan agreement, so 1.2 and 1.1 change in place. The items are drafting fixes: the agreement's own liability and disputes sections govern claims under it, a false-claim finding is defined, both agreements give a postal notice address, the confidentiality carve-out names a written duty in all three contracts, the Terms name bulk automated extraction and urgent court relief, the Privacy Policy no longer promises more than the law requires and says what the privacy signals do not switch off, the Review Guidelines stop adjudicating private contracts, and the Listing Accuracy Policy splits trademark from copyright logo complaints and fixes when we give our view on a protest: after the owner's reply or its 14 days, sooner only if the owner says it will not reply or the value causes harm that cannot wait, and an early view says which (Chris's wording of item 12.5, November 9, 2026, which keeps the §11b.12 early-decision ruling). Item 12.17 (ruling 14) opens claim, edit and contest of a connector-delivered integration to every owner, not only one holding a Managed subscription. That text was ahead of the code. **AECI-1663** built it on November 10, 2026, with no text change, so it is off the gate list.

On November 10, 2026 **AECI-1615** built the grant acceptance the Managed plan agreement 1.1 already describes (counsel Q5). A subscription AECi grants now waits until an owner seat ticks the box on the Billing tab, or until AECi records a signed deal that names the agreement by version and date. The portal acceptance records the IP address and browser, as a claim does. So two Privacy Policy sentences changed in the v1.1 draft, in place and without a bump: the "Agreement acceptance records" bullet under "What we collect" and the same bullet under "Retention". The Managed plan agreement needed no change. Once this merges, AECI-1615 no longer holds the effective date. Counsel should check the two sentences with AECI-308.

On November 11, 2026 counsel's Q42 answer added **AECI-1677** to the list of issues that must ship before any effective date. Every Vendor Terms acceptance so far was made against a draft marked "not yet in force", so the 30-day change email cannot move those vendors to the final version. An owner seat accepts the in-force version on a portal screen at next sign-in. No text changed.

On November 11, 2026 **AECI-1619** rewrote one sentence of the Managed plan agreement's "What a subscription is and does", in place in the v1.1 draft, without a bump. "At a minimum, Managed gives…" now names each core inclusion: the Managed fields, "How teams use it", the trades, audiences and phases, the integrations-page and API docs links, confirmed data flows and the search-engine notice, with the limit that a notice does not decide crawling, indexing or ranking. Review replies and seats for colleagues follow "As on every plan", because Free has them too (legal agent review, November 12, 2026). The change-history line for 1.1 says so. The edit changes the file's hash in `LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.1']`, which a grant acceptance stores. It is safe only while production holds no `managed_plan` 1.1 acceptance of any source. A read of the production database on November 12, 2026 found none: it holds Vendor Terms acceptances only (five at 1.0, one at 1.1, two at 1.2). Check again before merge. If any exist by then, the edit becomes version 1.2 and 1.1 is archived unchanged. Counsel review of the sentence is pending on **AECI-1363**.

On November 12, 2026 **AECI-1363** applied legal branch 5 (change list section 13: counsel's Q38, Q39 and Q42 answers and Chris's rulings 17, 18, 20 and 25). Production held two Vendor Terms 1.2 acceptances, both claims from November 11, 2026, so the rule in `docs/LEGAL_IMPACT_REVIEW.md` §2 bumped the Vendor Terms to **1.3** and archived 1.2 unchanged at `/legal/vendor-terms/v1.2`. The server now stamps 1.3 (`LEGAL_AGREEMENT_CURRENT_VERSIONS`). The Terms, the Privacy Policy, the Managed plan agreement and the Listing Accuracy Policy changed in place, without a bump, because none has an acceptance at its current version. The Managed plan agreement's text hash in `LEGAL_AGREEMENT_TEXT_SHA256` is regenerated for the same reason. The items: the Terms' copyright section promises to notify the poster, takes the counter-notice consent to the sender's own district, restores content between 10 and 14 business days after a counter-notice, and keeps a log of every notice. A copyright notice about a logo is accepted. An acceptance record holds the signer's name and title and the company's legal name, and keeps them after account deletion. Every liability clause says it limits only what we can owe. The jury waiver is labelled. A refund deduction is credited against what the vendor owes for the same breach. The Managed plan agreement's own refund and suspension sections govern claims under it. A rights-reducing Vendor Terms change applies to a company only after an owner seat accepts it in the portal. Two items are ahead of the code. Item 13.3 promises the notice log, which **AECI-1665** builds. Item 13.12 promises the portal acceptance of a rights-reducing change, which **AECI-1677** builds. Both are on the gate list above.

**Publishing is gated too (AECI-1688).** Recording a version on `/admin/legal` is not a way around the list of issues that must ship before any effective date. The API var `LEGAL_PUBLISH_ENABLED` is `"true"` on local and staging and `"false"` on demo and production, and the publish answers `409 LEGAL_PUBLISH_DISABLED` while it is off (`docs/environments.md` "Legal publish per tier"). AECI-1677 turns production on, once the list has shipped.

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
  keeps the static `/legal/*` TTL with no purge, because the bump-day deploy replaces it.
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
  `{ version, effectiveOn }`. A spec checks the two are equal. `agreement-text-hash.spec.ts`
  skips the upcoming file in `versions/`, because no one has accepted it yet. Its hash is added
  on bump day.
- Every current file **ends with** `## Change history`: one list line per version, naming
  `Version X.Y` once. Give the effective date, or say "draft, never in force" for a version that
  never took effect. A superseded version's line links its archive URL and gives its superseded
  date. For example:

  ```markdown
  ## Change history

  - **Version 1.1** (this version): draft, not yet in force.
  - [Version 1.0](/legal/terms/v1.0): draft, never in force. Superseded October 14, 2026.
  ```

  An upcoming version gets no line until bump day, when it becomes "this version".

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
  - a listed version or link that does not resolve.
- No check reads the clock. An upcoming entry whose date has passed still builds, so `main`
  never turns red on a date. What happens on the date is AECI-1689.

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
   superseded text and add its `## Change history` line in the same PR (see above).
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
   published ahead is the text that takes effect.
2. **Register it in the same branch.**
   - Add `{ slug, version, effectiveOn: 'YYYY-MM-DD' }` to `LEGAL_UPCOMING` in
     `app/legal/legal-manifest.ts`. This alone puts the announcement on the current page.
   - Import the file in `app/legal/legal-content.ts` and add it to `ARCHIVE_SOURCES`.
   - For the vendor terms or the Managed plan agreement, add the same `{ version, effectiveOn }` to
     `LEGAL_AGREEMENT_UPCOMING_VERSIONS` (`packages/shared/src/api/agreements.ts`).
   - Do **not** edit the current `<name>.md`.
   - If the change is material, add the `notices.json` entry (next section).
3. **Merge and deploy to production** at least 31 days before the effective date. The page goes
   live at `/legal/<slug>/v<new>`.
4. **Bump day, on the effective date, in one change:**
   - Move `versions/<slug>/v<new>.md` into `<name>.md` byte for byte, and delete the `versions/`
     file. Its change history was written in step 1, so nothing in it changes.
   - Archive the old current text unchanged at `versions/<slug>/v<old>.md`, with a `LEGAL_ARCHIVES`
     entry whose `supersededOn` is the effective date. Fix the imports in `legal-content.ts`.
   - Remove the `LEGAL_UPCOMING` entry, and the `LEGAL_AGREEMENT_UPCOMING_VERSIONS` entry if there
     is one.
   - Leave the version's `notices.json` entry in place. The band runs through the whole effective
     day. `legal-notices.spec.ts` accepts a notice for the version that is now current.
   - Set the slug's `LEGAL_CURRENT_VERSIONS` entry to the new version. The notice's link
     `/legal/<slug>/v<new>` then keeps serving the same text as the current version, and
     `/legal/<slug>/v<old>` serves the archive.
   - For the vendor terms or the Managed plan agreement, set `LEGAL_AGREEMENT_CURRENT_VERSIONS` to
     the new version, append it to `LEGAL_AGREEMENT_KNOWN_VERSIONS`, and add its
     `LEGAL_AGREEMENT_TEXT_SHA256` entry.
   - For the Listing Accuracy Policy or the Review Guidelines, set `LEGAL_POLICY_CURRENT_VERSIONS`
     to the new version and append it to `LEGAL_POLICY_KNOWN_VERSIONS` (same file). A claim
     records those two versions. The Terms and the Privacy Policy have no shared map.
5. **Deploy the bump the same day.** Nothing switches on the date by itself yet, so until this
   deploy the old version stays current on the site. AECI-1689 removes that deadline. No spec fails
   when the date passes, so CI will not remind you.
6. **Once the effective day is over, remove the `notices.json` entry.** The band closed at the end of
   that day (UTC), so a closed entry renders nothing. This is tidying.

## Publishing an upcoming agreement version (AECI-1688)

For the Vendor Terms and the Managed plan agreement only. Publishing records the announcement in
D1 (`legal_versions`, `docs/DATABASE_SCHEMA.md` §8.6i): a summary of the changes, two answers the
operator gives, and the fingerprint of a PDF a customer can save. A material version's publish
also emails the change notice (`legal-terms-change`, AECI-1620) to every affected company. The
acceptance screen (AECI-1677) and reader accounts (AECI-1637) read the record too. ADR 0054 is
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

   **After publishing, never replace the stored PDF.** The `legal_versions` row records its sha256,
   and every reader of the file re-hashes it. A replaced file no longer matches the record. If the
   published text is wrong, that is a new version.
5. **Publish on `/admin/legal`** on that tier. Answer "Is this a material change?" and "Does it
   need acceptance?" (no default; acceptance needs a material change), write one summary line
   per change (1 to 10 lines, each up to 300 characters, plain text with no tabs or hidden
   characters), and give an expedited reason only for a Vendor Terms version inside 30 days. The
   confirmation says what each answer causes. A publish cannot be undone. The summary lines go
   into the email word for word.
6. **Check the change notice on the card** (material versions only), after a minute and a
   Refresh. It should say "The last send queued N companies". The Vendor Terms notice goes to
   every unbanned seat and the billing email of every company with a seat. The Managed plan
   notice goes to the owner seats and the billing email of every company with a live
   subscription, grants and complimentary included. Each email carries the version and date, the
   summary, a link to `/legal/<slug>/v<version>` and the PDF. Over the next hour "Delivered"
   should reach "Companies queued" and "Not yet delivered" should reach 0. Every company listed
   under "Companies not reached" has its reason beside it. Fix the cause and press "Send the
   notice again": it queues only the companies not yet delivered and never emails an address
   twice for one company. `docs/RUNBOOKS.md` "A legal change notice did not go out" has
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
(`packages/shared/src/api/legal-versions.ts`) is the one conversion. It sets
`legal_versions.effective_at` and measures the 30-day window. Anything else that has to know when
a version takes effect should call it rather than build its own date.

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
  so do not remove it in the same-day bump. A closed entry renders nothing.
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
