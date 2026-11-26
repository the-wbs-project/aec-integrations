# Enhanced profile: planning document

**Status:** planning draft, 2026-11-13. Revised 2026-11-16 after counsel's batch 4 answers. Not a build contract. No Linear issue exists and no code is written.
**Purpose:** describe every Enhanced feature fully enough that the legal agents can find the questions for counsel.
**Legal source of truth:** `docs/LEGAL_COUNSEL_RECORD.md`, questions Q44 to Q54 and Q60, rulings 26 to 31 and 34 to 36. Where this plan and the record differ, the record wins.
**Legal impact:** `decision`. It stays `decision` until the legal text for each step is drafted. Customer names and case studies wait on Q49, which counsel has not answered.
**Scope:** the profile features. Plan packaging, price and the agreement are set aside for now. See section 7.

"Enhanced" is the plan rung above Insights in `docs/ROADMAP.md` §1.5. It makes a vendor's public profile
richer. It never changes where a listing ranks.

## 1. What the plan is

A vendor on Enhanced can add rich content to its product pages, its integration pages and its company page.
The content is the vendor's own marketing material. Every block carries the caption "Supplied by {Vendor}".

Three things were asked for: screenshots, testimonials and extra documentation. Section 3 adds eleven more.
Testimonials, which the plan calls customer quotes, were removed from 1.0 on 2026-11-16 by ruling 30. That
leaves thirteen features.

The admission test in the roadmap still holds. Enhanced content does not touch search cards, ranking inputs
or the `reviews` table.

## 2. What already exists

| Fact | Source |
|---|---|
| Enhanced has two lines of scope and no spec. Milestone 1.0 is "undefined until a spec exists" | `docs/ROADMAP.md` §1.5 |
| No `enhanced` or `insights` tier exists in code. Tiers today are `unclaimed` and `verified` | `packages/shared/src/entitlements.ts` |
| A `profile.rich_fields` capability exists and nothing uses it | `docs/STAGE_2_PAID_TIERS_SPEC.md` §3.1 and §3.4 |
| No media, gallery, testimonial or lead table exists | `docs/VENDOR_PLAN_DATA_READINESS.md` §1 |
| Logo uploads go to private R2 with byte-level checks. PNG, JPEG and static WebP only, 2 MiB, 2048 px | `docs/STAGE_2_5_SPEC.md` §11.1, ADR 0032 |
| Uploads are not re-encoded, keep their metadata and are not scanned | same |
| Vendor Terms already grant permission for "logos and screenshots you upload" and promise removal in 14 days | `apps/web/src/content/legal/vendor-terms.md` |
| That 14-day removal runs when a claim ends, not when a plan ends | ADR 0051, counsel Q12, ruling 3 |
| When Managed ends, vendor text stays live and frozen. An owner has 30 days to ask for removal | `managed-plan-agreement.md`, counsel Q4, ruling 8 |
| Managed fields carry "Maintained by {Vendor}". That caption does not change | rulings 5 and 35 |
| The ranking page gains one plain sentence on what a paid plan buys, now and not when Enhanced ships | ruling 36, AECI-1871 |
| The Vendor Terms gain a warranty for third-party material, a duty to redact, and a wider indemnity | ruling 26, text items 14.1 to 14.4 on AECI-1363 |
| The content licence gains a sentence that lets our service providers act for us | ruling 27, text item 14.5 on AECI-1363 |
| No vendor brand colour appears on an unclaimed listing, on any page | ruling 34 |
| A capability id may not contain "feature", "top", "pin", "sort" and nine other words | `docs/STAGE_2_PAID_TIERS_SPEC.md` §3.2 test 2 |
| No input to the completeness score may need a paid plan to edit | `docs/STAGE_2_PAID_TIERS_SPEC.md` §13.4 |
| Public pages may not name a plan that has not shipped | `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §8 |
| Lead generation is deferred to a spec that does not exist | `docs/VENDOR_PERFORMANCE_SPEC.md` §8 |
| Enhanced and Insights have no price | `docs/PRICING_RULES.md` §2 |
| The Linear project summary lists "company facts" under Enhanced. Company facts already shipped on Free | Linear project Enhanced, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23 |

Counsel answered batch 4 on 2026-11-15 and 2026-11-16. The answers cover advertising disclosure (Q44),
testimonials (Q45, Q47, Q48), Section 230 for paid and approved content (Q46), third-party material (Q50),
video (Q51, Q52), screening (Q53, Q54) and legal text timing (Q60). Counsel's answers are general guidance,
not a review of final wording.

Counsel has not answered on customer names and case studies (Q49) or Florida's wiretap law (Fla. Stat. ch.
934). Batch 4 did not ask about hosted files, the agreement shape or rejection refunds. On 2026-11-16 the legal
agent settled four plan questions from earlier answers, with no new counsel question. Section 6 lists them.

## 3. The feature list

### 3.1 Asked for

| # | Feature | What it is |
|---|---|---|
| 1 | Screenshot gallery | Up to 8 images on a product page. Each has required alt text and an optional caption |
| 2 | ~~Customer quotes~~ | **Removed from 1.0 by ruling 30.** The number is kept so earlier references still resolve |
| 3 | Documents | Up to 6 documents on a product page, such as a datasheet or a setup guide. Links only |

### 3.2 Additions

Chris accepted all eleven on 2026-11-13.

| # | Feature | What it is | Why add it |
|---|---|---|---|
| 4 | Integration walkthrough | Screenshots and a short setup guide on an integration page | It is the one rich block no other directory has. The pair page is our core page |
| 5 | Video | One video on a product page, hosted by YouTube or Vimeo | Buyers expect a demo video |
| 6 | Key capabilities | Up to 8 short bullets written by the vendor | Readers scan bullets before prose |
| 7 | Product FAQ | Up to 10 questions and answers written by the vendor | It answers pre-sales questions and reads well to answer engines |
| 8 | Security and compliance facts | Structured vendor statements: SOC 2, ISO 27001, single sign-on, data residency, each with an evidence link | Security review is a buying step at every large AEC firm |
| 9 | Deployment facts | Platforms, hosting model, languages, regions served, supported file formats | Roadmap §1.5 already names file-format capabilities. See AECI-709 |
| 10 | Pricing summary | Starting price, pricing model, free trial yes or no, an "as of" date, a link | Price is the fact buyers most often cannot find |
| 11 | Case studies | Up to 3 entries: customer firm, project type, a short summary, a link to the full study | Longer proof than a quote. **Blocked on Q49** |
| 12 | Customer names | A text list of firms that use the product. Names only, no logos | Social proof with less trademark weight than logos. **Blocked on Q49** |
| 13 | Resource links | Training, community, release notes, status page, support hours | Shows the product is alive and supported |
| 14 | Demo link | One outbound "Book a demo" link to the vendor's own site | Gives the vendor a result without a lead form |

Features 11 and 12 stay in Enhanced 1.0, but no spec or issue is written for them until counsel answers Q49.

### 3.3 Excluded from Enhanced 1.0

Chris confirmed the first six exclusions on 2026-11-13. Ruling 30 added customer quotes on 2026-11-16.

| Feature | Reason |
|---|---|
| Customer quotes | Ruling 30. Counsel said the vendor's tick does not meet the FTC "should have known" test (Q45) or Florida's consent rule (Q48). See finding 5.4 |
| A lead form that passes a visitor's details to the vendor | It makes "we do not sell or share personal information" false. It belongs in its own plan and spec |
| Featuring or pinning a review | Counsel Q8 calls a favourable selection a misleading display |
| Customer logos | The vendor cannot license a third party's trademark to us. See finding 5.6 |
| Hero images, brand colours or any highlighted card | `PRODUCT.md` bars any treatment that signals "promoted". Ruling 34 also bars brand colour on any unclaimed listing |
| Compliance badge images | A badge reads as "verified". Auditors' marks carry their own licence terms |
| Claims that name a competitor | False-advertising exposure with no counsel answer. See finding 5.11 |

## 4. Feature sketch

This is enough shape to reason about legally. It is not a design.

**Data.** New tables, each keyed to a product or an integration.

| Table | Holds |
|---|---|
| `product_media` | kind (screenshot or video), R2 key or video URL, alt text, caption, position, review state |
| `product_documents` | title, kind, URL, published date, review state |
| `product_faqs` | question, answer, position, review state |
| `product_case_studies` | firm name, project type, summary, link, review state. Waits on Q49 |
| `product_customers` | firm name, position, review state. Waits on Q49 |
| `integration_media` | the same shape as `product_media`, plus setup steps |
| New columns on `products` | capabilities, compliance facts, deployment facts, pricing summary, resource links, demo link |

No `product_quotes` table is built. Ruling 30 removed quotes.

**Capabilities.** One new tier, `enhanced`, and a handful of new capability ids. The firewall regex bans
"feature", so the bullets are "capabilities" in the id and in the copy.

**Publishing.** Some blocks are held for an operator and some go live on save. Section 7.3 defines the
split. Staff approve or reject. Staff never reword.

**Labelling.**

- Every Enhanced block is captioned "Supplied by {Vendor}" (ruling 31). Counsel said "Maintained by" can read
  as "the vendor keeps it up to date" rather than "the vendor wrote it" (Q44).
- Managed fields keep "Maintained by {Vendor}" (ruling 35). The two captions sit on different content.
- No block says "Ad", "Sponsored" or "Paid". Counsel said the vendor caption is enough (Q44).
- The caption may be muted. It uses the secondary text colour, passes contrast and shows without hover. This
  styling rule is the legal agent's reading of Q44, not counsel's words.
- A compliance fact reads "{Vendor} states: ...", at the same weight as the claim. It never says "Verified" (Q46).

**Rules the existing architecture already forces.**

- No Enhanced block reaches Algolia, a search card or the completeness score. `STAGE_2_PAID_TIERS_SPEC.md` §3.2 and §13.4.
- Pages stay cached by URL. Rich blocks are public content, so they render on the server with a cache tag.
- Every write is domain state and emits an audit row in the same batch. Moderation emits a workflow transition.
- Uploaded files join the `brand_asset_removal` job. ADR 0051 says a screenshot feature must.
- No page that exists today moves behind a sign-in or a form.
- No feature is switched on until the legal text that covers it is live (counsel Q60).

## 5. Findings

Each finding states what is wrong, why it matters, and what to do. A finding that counsel has settled says so.

### 5.1 No legal page describes a plan above Managed

**What is wrong.** `/methodology` says of Managed's effects, "this is the complete list". The Managed plan
agreement lists what Managed includes. No page describes Enhanced, its price, its refund terms or its end.

**Why it matters.** A second paid plan makes the "complete list" sentence false. Counsel said in Q14 that a
capability on the Plans page is a term a vendor can hold us to. Counsel said in Q44 that a public statement
which leaves out the paid plan risks a misleading impression.

**What to do.** The ranking page gains one plain sentence on what a paid plan buys now, under ruling 36 and
AECI-1871. When Enhanced ships, `/methodology` also says that paid plans add media we do not check, and the
"complete list" sentence is rewritten. The contract shape is set aside until the plan ladder settles.

### 5.2 A paid richer profile and advertising labels: settled by Q44

**What was open.** Whether a fuller paid page needs an "Ad" or "Sponsored" label.

**What counsel said.** No such label is needed. The vendor caption names the source. "Maintained by" is soft,
so Enhanced blocks use "Supplied by {Vendor}". The real risk was the ranking page's "no promoted tier"
sentence, which ruling 36 addresses.

**What to do.** Caption every Enhanced block "Supplied by {Vendor}" (ruling 31). Keep every block visually
plain. Ship the ranking page sentence under AECI-1871.

### 5.3 Enhanced edits move "Recently updated", and that is acceptable

**What is wrong.** Nothing, after Chris's ruling. Any edit to a product stamps `updated_at`, on any plan. The
public "Recently updated" sort reads that stamp.

**Why it matters.** A free vendor can edit its description at any moment and move to the head of the same
sort. No plan is needed to get there. The ranking page already describes the sort as "the most recently
changed listings first", and that stays true.

**What to do.** No new public text and no counsel question. One build rule: an edit held for moderation moves
the stamp when it is published, not when it is submitted.

No Enhanced field joins the completeness score, under §13.4. Paid blocks emit no structured data in 1.0, by
Chris's ruling.

### 5.4 Customer quotes are out of 1.0

**What counsel said.** The vendor's tick is evidence that we asked, not that we looked. Under 16 CFR §465.2 a
paid host can be reached by the "should have known" standard (Q45). Under Fla. Stat. 540.08 we need the
named person's own consent, and the vendor's tick is no defence (Q48).

**Ruling.** Ruling 30 leaves quotes out of Enhanced 1.0. No quote that names a person is published on a
vendor's word alone.

**If quotes ever return, three rules apply.**

- The person quoted confirms the quote to us directly, not through the vendor (Q45, Q48).
- The message to that person carries our privacy notice. That gives the person the information, which removes
  the Article 14 notice duty where it might apply (Q47).
- Quotes stay in their own table and their own page section. They are never counted, rated or shown in a
  review list. Counsel stressed this separation under §465.6 (Q45).

### 5.5 A person named in vendor content: not needed in 1.0

**What changed.** With quotes removed, no Enhanced block names a person. The Privacy Policy section for
people named in vendor content is not needed while that stays true.

**What to do.** Allow no photographs of people. If quotes return, the section and the confirmation message in
finding 5.4 come back with them.

### 5.6 Customer names and case studies are third-party trademarks: waiting on Q49

**What is wrong.** A "used by" list and a case study show other firms' names. The vendor can warrant it has
permission, but it cannot license the mark to us.

**Why it matters.** Counsel said in Q12 that nominative fair use "is a defense you assert if challenged, not
a license". A list of customers implies the customers endorse the product. That is the Lanham Act §43(a)
exposure counsel already named.

**What to do.** Nothing yet. Q49 asks whether a per-name vendor statement is enough or we must hold proof of
each firm's permission. The answer that came back on 2026-11-16 was for another client, so Q49 is still
open. Do not write a spec or an issue for features 11 and 12 until it lands.

### 5.7 Screenshots can carry other people's data and are not scanned

**What is wrong.** An AEC screenshot often shows a real project: drawings, addresses, staff names, costs.
Uploads keep their metadata and are not re-encoded. Nothing scans them. Logos publish live on save today.

**What counsel said.** The general warranty does not reliably cover privacy, publicity, data-protection or
customer-confidentiality claims (Q50). Ruling 26 puts text items 14.1 to 14.4 into the first in-force Vendor
Terms, on AECI-1363. Screenshots can be uploaded today, so those items do not wait for Enhanced.

**What to do.** Re-encode every screenshot and strip metadata. Pre-moderate. The content rules require demo
data or redaction. Keep DMCA handling as it is under Q38.

### 5.8 What happens to media when the plan ends

**What is wrong.** The 14-day removal promise is tied to the claim ending. The Managed rule is that text
stays live and frozen. Neither rule was written for a gallery or a video.

**Why it matters.** Counsel said in Q4 that stale vendor text creates deceptive-practice exposure. If content
stays forever, one month of Enhanced buys a permanent rich page.

**What to do.** Chris ruled that Enhanced blocks are hidden at once when the plan ends. Hidden content is kept
for 90 days, then the rows and the uploaded files are deleted. A returning vendor inside that window gets the
content back. Counsel was not asked about the 90 days, and Chris's ruling stands.

Two rules sit on top of the 90 days.

- If the claim ends, the 14-day screenshot removal promise in the Vendor Terms wins over the 90 days.
- Counsel said in Q20 that a hidden state "does not meet an order or duty requiring deletion", so a removal
  demand still deletes at once.

The Plans page says all of this in plain words.

### 5.9 Video: settled by Q51 and Q52

**What counsel said.** The click is valid consent in the EEA, the UK and Switzerland. It is not "strictly
necessary", because the provider sets storage for its own purposes (Q51). The notice line must say more than
"may set cookies". The notice line is not Video Privacy Protection Act consent, and we must not rely on it
for that (Q52). Our best VPPA defence is that we are not a video tape service provider.

**Build rules.**

- Nothing loads from the provider until the visitor clicks play, for every visitor.
- Show a still image we host, with a play button.
- The player loads from `youtube-nocookie.com`, or from Vimeo with `dnt=1`.
- The iframe carries `referrerpolicy="no-referrer"`.
- A notice line sits beside the play button at normal weight. It names the provider, says what the provider
  receives and stores, and says the provider uses the data for its own purposes. Counsel gave no wording.
- The Privacy Policy names the video providers as third parties that are not our processors.

Q52's answer does not reach Florida's wiretap law, Fla. Stat. ch. 934. The legal agent confirmed on
2026-11-16 that this needs counsel. It goes back as a follow-up to Q52. Step F waits on it.

### 5.10 Hosting vendor documents makes us a file host

**What is wrong.** A PDF can carry scripts or malware. A security report is often shared under a
non-disclosure agreement. Nothing in the upload pipeline scans files. PDFs are often not accessible.

**What to do.** Chris ruled that documents are links to the vendor's own site. We store no files. Show each
link with its title, kind and date. Check each link daily and hide one that stops resolving. The hosting
question was not sent in batch 4. It goes to the legal agent only if hosting is ever wanted.

### 5.11 Vendor claims become richer: Section 230 settled by Q46

**What counsel said.** Neither the payment nor the checklist approval makes vendor claims our content (Q46).
Checking that an evidence link opens does not adopt the claim. "{Vendor} states:" helps. "Verified SOC 2"
would be a different conversation.

**Build rules.**

- Staff approve or reject. They never reword.
- The checklist never tests truth. Checking that an evidence link opens is fine.
- A compliance fact reads "{Vendor} states: ..." at the same weight as the claim, and never "Verified".
- Pricing shows its "as of" date.
- Write a vendor content policy with a prohibited list: named competitors, superlatives without a source,
  mock-ups shown as the real product.

**False claims, settled by the legal agent on 2026-11-16.** A vendor's pricing, capability or security claim
is the vendor's content. Payment and checklist approval do not make it ours. Our duty starts when someone
sends proof that a claim is false. We then hide or flag it within 2 business days and correct it within 5,
under ruling 6. No claim is ever labelled "Verified". Q4, Q19, Q21 and Q46 cover this, so counsel is not asked.

**Competitor claims stay barred.** Chris ruled them out on 2026-11-13. The content policy bars them and the
screening job flags them. Counsel is needed only if Chris ever wants to allow them.

### 5.12 A demo link is safe only if it stays a plain link

**What is wrong.** Vendors will ask for leads. `VENDOR_PERFORMANCE_SPEC.md` §1 says a report must never "turn
a click into a lead". `ANALYTICS.md` says off-site links are never tagged.

**Why it matters.** A plain outbound link passes nothing about the visitor. Tracking parameters or a form
would pass data to the vendor and contradict the Privacy Policy.

**What to do.** Ship one outbound link with no added parameters. Count clicks in aggregate only, above the
existing floor of 5. Leave lead forms to their own plan and their own counsel questions.

### 5.13 We are responsible for the accessibility of media we did not make

**What is wrong.** Vendor screenshots need alt text. Vendor videos need captions. The `/accessibility`
statement is hidden until AECI-1687 and says nothing about third-party content.

**Why it matters.** The site operator answers a barrier complaint, not the vendor. Counsel's Q40 answer
limits what the statement may claim. Ruling 22 gives 10 business days to reply to a report.

**What to do.** Make alt text a required field. Require the vendor to confirm a video has captions. Reject
media that fails at moderation. We answer for inaccessible vendor media, not the vendor. When vendor media
ships, the `/accessibility` statement gains one sentence about it. The legal agent settled this on 2026-11-16
under Q40, so counsel is not asked.

### 5.14 Moderation has an operating cost and a refund question

**What is wrong.** Held blocks wait on an operator. A vendor may pay for Enhanced and have content rejected.
The refund rule today is 14 days under ruling 7 and says nothing about rejection.

**Why it matters.** Thirteen features across many products is a real queue for a small team. A vendor who
paid and saw nothing published will ask for money back.

**What to do.** Counsel settled that approval does not make the content ours (Q46). Whether a rejection is a
refund ground was not asked. It goes to counsel with the agreement, once the plan ladder is drafted. Repeat
infringers lose upload rights, which needs the notice log in AECI-1665.

### 5.15 The licence and warranty: settled by Q50 and Q53

**What counsel said.** The general warranty does not reliably reach third-party material (Q50). The licence
probably covers screening but does not name service providers (Q53).

**What to do.** Text items 14.1 to 14.5 on AECI-1363 go into the first in-force Vendor Terms, under rulings 26
and 27. If item 14.5 lands after an effective date, it binds a company only once an owner seat accepts it.

### 5.16 The order of legal text, notice and build: settled by Q60

**What counsel said.** Text added before the first effective date is part of the first version and owes no
30-day notice (Q60). After that date, new text is a material change and needs the notice and the email in
AECI-1637. A draft banner does not protect a live site that collects data.

**Rules for this plan.**

- A new use of data we already hold needs notice or consent whenever its text lands. Screening existing
  vendor content is such a use (finding 5.17).
- Every feature stays off until the policy text that covers it is live.
- A short notice or email goes out when the first versions take effect, under ruling 28 and AECI-1870.

The same rules govern `MY_STACK_PLAN.md`.

### 5.17 Automated screening: settled by Q53 and Q54, with the EU and UK side open

**What counsel said.** Before screening runs, the licence names service providers and the Privacy Policy
describes automated screening by a third-party AI provider (Q53). Screening content we already hold is a new
use and needs advance notice. A stored score that nobody reads is not knowledge (Q54). Once a person opens a
flagged item, obvious infringement must come down at once. A backlog of unopened flags looks like wilful
blindness.

**Before the job runs.**

- Text item 14.5 is in force.
- The Privacy Policy names automated screening by a third-party AI provider, including content that names
  people who are not users.
- The provider contract bars training on our data and covers confidentiality and use limits.
- Every vendor gets advance notice that existing content will be screened. Screening covers Free and Managed
  content too, so the notice goes to every vendor, not only Enhanced ones.
- `/methodology` says content is screened by software for policy breaches, and that this is not a check of
  truth.

**Build rules.**

- A staff member who opens a flagged item decides it then, and removes obvious infringement at once.
- The flag queue has a review deadline and an alert on its age.
- Scores have a retention period.

**Still open.** The EU and UK side of screening was not answered. Under ruling 29 it goes to counsel as one
question when the job is scheduled.

## 6. Counsel's answers and what is still open

### 6.1 The twenty plan questions and where they stand

| # | Plan question, short form | Where it went | State |
|---|---|---|---|
| 1 | Is a paid richer profile advertising? | Q44 | Answered. "Supplied by {Vendor}", no "Ad" label |
| 2 | One agreement with schedules, or one per plan? | Not asked | Goes to counsel with the plan ladder |
| 3 | FTC Parts 465 and 255 for testimonials | Q45 | Answered. Quotes removed, ruling 30 |
| 4 | Section 230 for paid, pre-moderated content | Q46 | Answered. Our view holds |
| 5 | Does approving without rewording change Q17, Q19 or Q21? | Q46 | Answered. It does not |
| 6 | Notice to a person named in a testimonial | Q47 | Answered. Moot while quotes are out |
| 7 | Right of publicity for a named person | Q48 | Answered. Person's own consent needed. Quotes removed |
| 8 | Customer firm names, and logos | Q49 | **Open.** Blocks features 11 and 12 |
| 9 | Warranty for third-party project content | Q50 | Answered. Items 14.1 to 14.4, ruling 26 |
| 10 | Is 90 days of hidden content sound? | Not asked | Chris's ruling stands. The claim-end 14-day promise wins |
| 11 | Click-to-play video in the EEA, UK and Switzerland | Q51, plus Q52 for US law | Answered. Click is consent. Build rules in 5.9 |
| 12 | Hosting vendor PDFs | Not asked | Parked. Documents link out |
| 13 | Presenting an unverified SOC 2 statement | Q46 | Answered. "{Vendor} states:", never "Verified" |
| 14 | Exposure for a vendor's false claim while its plan runs | Legal agent, 2026-11-16 | Settled from Q4, Q19, Q21, Q46. The claim is the vendor's. Act on proof in 2 and 5 business days |
| 15 | Claims that name a competitor | Legal agent, 2026-11-16 | Barred by Chris's 2026-11-13 ruling. Counsel only if Chris wants to allow them |
| 16 | Accessibility of vendor media | Legal agent, 2026-11-16 | Settled from Q40. We answer for it. One sentence on `/accessibility` when media ships |
| 17 | Rejection as a refund ground | Not asked | Goes to counsel with the agreement |
| 18 | Text added to pages not yet in force | Q60 | Answered. Rules in 5.16 |
| 19 | Screening: Privacy Policy and licence text | Q53 | Answered. Item 14.5, ruling 27. EU and UK open, ruling 29 |
| 20 | Does a stored score create knowledge? | Q54 | Answered. Not until a person opens it |

### 6.2 Still open with counsel

| Item | Blocks |
|---|---|
| Q49: customer firm names and case studies | Step G |
| Follow-up to Q52: Florida wiretap law, Fla. Stat. ch. 934 | Step F, video |
| EU and UK side of screening, under ruling 29 | Step S, when it is scheduled |
| Agreement shape and rejection as a refund ground | Plan packaging, when the ladder is drafted |

The legal agent settled plan questions 14, 15 and 16 on 2026-11-16 from earlier answers. Section 6.1 shows
how.

## 7. Decisions

### 7.1 Ruled by Chris on 2026-11-13

| Topic | Ruling |
|---|---|
| Features in Enhanced 1.0 | All fourteen in sections 3.1 and 3.2. Ruling 30 later removed quotes, leaving thirteen |
| Exclusions | All six in section 3.3 stand |
| Plan ladder and licensing | Set aside. Enhanced may be combined with another plan. This document covers the features only |
| Content when the plan ends | Hidden at once |
| Vendor documents | Links to the vendor's site. No hosted files |
| "Recently updated" | Any edit to a product counts, on any plan. See finding 5.3 |
| `profile.rich_fields` | Retired. One capability for each block |
| Agreement shape | One paid-plan agreement with a schedule for each plan. Written when the plan ladder is settled |
| Structured data for search engines | None to start |
| Which blocks wait for operator approval | The split in section 7.3. Third-party content and media wait. The vendor's own claims go live |
| Automated screening | A job scores all changed vendor content with a decision model. A score above a threshold goes to the admins. Section 7.4a |
| Hidden content after the plan ends | Kept 90 days, then rows and files are deleted |
| Link domains | Demo and document links must sit on a domain approved for that vendor. Section 7.5 |

### 7.1a Ruled by Chris after counsel's answers, 2026-11-15 and 2026-11-16

| Ruling | Topic | Effect on this plan |
|---|---|---|
| 26 | Third-party material in vendor uploads | Text items 14.1 to 14.4 in the first in-force Vendor Terms. Finding 5.7 |
| 27 | Service providers in the content licence | Text item 14.5. Finding 5.17 |
| 28 | Notice at the first effective date | A short notice or email goes out then. Finding 5.16 |
| 29 | EU and UK side of screening | Asked when the job is scheduled. Finding 5.17 |
| 30 | Customer quotes | Out of Enhanced 1.0. Finding 5.4 |
| 31 | Caption on Enhanced blocks | "Supplied by {Vendor}" |
| 34 | Brand colours on unclaimed listings | None, on any page |
| 35 | Caption on Managed fields | Stays "Maintained by {Vendor}" |
| 36 | Ranking page says what a plan buys | Added now, under AECI-1871 |

### 7.2 Ruled: the agreement shape

Chris chose the first option. The table is kept so the legal agents can see what was weighed.

| Option | For | Against |
|---|---|---|
| One paid-plan agreement, with a schedule for each plan | One acceptance and one version history. Shared terms cannot drift apart. It still works if plans are combined | A change to one schedule is a new version for every paying vendor. Each one gets the change email and PDF that counsel's Q3 answer requires |
| One agreement for each plan | A change to Enhanced terms touches Enhanced vendors only | A vendor on two plans accepts two documents. Refund, renewal and end-of-plan terms are written twice and can disagree. The acceptance ledger tracks two documents for one vendor |
| Keep the Managed agreement and add an Enhanced addendum | The least new text. Managed vendors see no change | The addendum must restate which base terms apply. It breaks if Enhanced is ever sold alone |

Renewals already bind the agreement version in force, under AECI-1690. Each extra document adds a second
version for that logic to track. The first option is the only one that survives a combined plan unchanged.

### 7.3 Ruled: which blocks are held for an operator

Chris chose this split on 2026-11-13.

**The test.** A block is held when it carries someone else's rights or someone else's personal data, or when
it is an image or video that software cannot read. A block goes live on save when it is the vendor's own
statement about its own product. That matches today: the "How teams use it" text goes live unmoderated, and
review replies are held.

| Block | Handling | Reason |
|---|---|---|
| Case studies | Held. Waits on Q49 | Names a third firm |
| Customer names | Held. Waits on Q49 | Third-party trademarks |
| Screenshots and integration walkthrough images | Held | May show project data. Not machine-readable |
| Video | Held | Third-party host. Captions must be checked |
| Security and compliance facts | Held | The claim buyers rely on most |
| Key capabilities, FAQ, deployment facts | Live on save | The vendor's own claims, the same class as today's narrative |
| Pricing summary | Live on save | The same class. Must carry an "as of" date |
| Resource links, document links, demo link | Live on save, after automated checks | The link must use HTTPS and resolve. See below |

**What an operator checks on a held block.** A fixed checklist, never the truth of the claim (Q46).

- The required attestations are ticked.
- Alt text is present and describes the image.
- No personal data, project drawings or customer names appear without an attestation. Demo data or redaction
  is required.
- Nothing on the prohibited list: a named competitor, an unsourced superlative, a mock-up shown as real.
- A compliance fact has an evidence link that opens.

**How it works.**

- States are draft, pending, published, rejected and hidden.
- An edit to a published block leaves the old version live until the new one is approved.
- A rejection picks a reason from a fixed list. Staff never reword.
- The published turnaround is 2 business days.
- Blocks that go live on save are still subject to removal on complaint, in 2 business days under ruling 6.
- A vendor with two upheld complaints has every block held from then on.

**Automated checks on links.** HTTPS only. The link must resolve when saved and is rechecked daily. The
domain rule is in section 7.5.

**The alternative** was to hold every block at launch. Chris chose the split.

### 7.4 Ruled: no structured data to start

Chris ruled none for 1.0. The reasoning is kept for a later revisit under the SEO project.

Structured data is machine-readable markup in the page that tells a search engine what a block is. Examples
are a video, an image, a question with its answer, or a review.

Leaving it out hides nothing. The text and images stay in the page, and search engines and answer engines
still read them. The markup only makes a block eligible for special display, such as a video thumbnail in
results.

| | Detail |
|---|---|
| **For** | Video and image markup can earn a thumbnail in search results and bring more visits to the page |
| **For** | It is a concrete benefit to sell, and it fits the SEO project |
| **Against** | It gives paying vendors a search-engine advantage. `/methodology` says nothing about that today |
| **Against** | The markup carries no "Supplied by" caption. A vendor's claim reaches the search engine as a statement from our site |
| **Against** | Question-and-answer markup earns little. Google limited that display to government and health sites in 2023 |
| **Against** | Our own review markup is the trust signal. Vendor markup beside it risks blurring the two |

| Option | Effect |
|---|---|
| None | No risk and no change to any public page. The content is still indexed as ordinary page text |
| Video and screenshots only | Most of the benefit. Needs one sentence on `/methodology`. These describe media and assert no claim |
| Everything else | Adds FAQ and pricing markup. Little gain, and vendor claims go out under our name |

A later step could add video and screenshots. Compliance facts and pricing should never carry markup. If
quotes ever return, they never carry review markup either.

### 7.4a Ruled: an automated screening job

Chris asked for a job that runs all changed content through a decision model. Content that scores above a
threshold goes to the admins.

**How it works.**

| Step | Behaviour |
|---|---|
| Trigger | Every create or edit of a vendor-authored block puts a message on a queue |
| Screen | A queue consumer sends the block to a language model with the content policy as its instructions |
| Score | The model returns a risk score from 0 to 100 and one or more reason codes from a fixed list |
| Flag | A score above the threshold opens an item in the admin review queue with the reasons |
| Record | The score, reasons, model version and content hash are stored with the block |

**Rules.**

- The model never rejects, hides or rewords anything. It only puts work in front of a person.
- A flagged block that is already live stays live until a person opens it. Counsel said this is fine (Q54).
- A person who opens a flagged item decides it then. Obvious infringement comes down at once.
- The queue has a review deadline and an alert on the age of its oldest unopened item.
- A held block is screened too. The score sits beside it in the queue so the operator sees the reasons first.
- The threshold is a setting, not code. It starts at 60 and is tuned against what operators decide.
- A failed or missing screen never blocks a save. The block is retried and then sent to the admins unscored.
- Vendor content is untrusted input. The model's reply is read as a score and reason codes and nothing else.
- Images are screened where the model can read them. Video is not screened.

**Reason codes.** Named competitor. Unsourced superlative. Personal data. Project data in an image. Compliance
claim without evidence. Advertising in a factual field. Off-topic or abusive. "Testimonial without
attestation" is dropped with quotes.

**What must be true before it runs.** See finding 5.17.

### 7.5 Ruled: link domains

Demo links and document links must sit on a domain approved for that vendor. Resource links are free of the
rule, because community and status pages often sit elsewhere.

A vendor's domain and a product's domain can differ, so each vendor holds a list of approved domains.

| Rule | Behaviour |
|---|---|
| Starting list | The vendor's website domain and each of its products' website domains |
| Adding a domain | An owner seat requests it. An operator approves it once |
| Using a domain | A link on any approved domain, or a subdomain of one, saves without review |
| Removing a domain | Links on it are hidden and the vendor is told |
| Acquired products | The acquirer's and the product's domains both sit on the list |

The approval is an operator judgement, the same kind made for listing submissions today. It needs a small
admin screen and a vendor portal screen. It also gives the screening job a fact to check links against.

### 7.6 Ruled: screening details

| Topic | Ruling |
|---|---|
| Scope of screening | All changed vendor text, including existing fields such as descriptions and "How teams use it" |
| Starting threshold | 60 out of 100, reviewed after the first 200 screened blocks |
| A very high score | Never hides a live block. It only warrants an operator response |
| What the vendor sees | The reason an operator gives on rejection. Never the score |

Screening existing fields means the job covers Free and Managed content too. The Privacy Policy text, item
14.5 and the advance notice in finding 5.17 therefore reach every vendor, not only Enhanced ones.

## 8. Suggested order of build

Each step can ship alone. Every step stays off until the legal text that covers it is live.

| Step | Scope | Verdict expected | Waits on |
|---|---|---|---|
| A | The capability for each block, the content policy, the moderation queue, the "Supplied by" caption | `decision`: `/methodology`, Vendor Terms | Plan packaging and the agreement. The ranking page sentence ships first under AECI-1871 |
| B | Structured vendor facts: capabilities, deployment, resource links, demo link | `text`: content policy | Step A |
| C | Screenshots and the integration walkthrough | `text`: content policy, removal job, `/accessibility` sentence | Items 14.1 to 14.4 in force |
| D | FAQ, pricing summary, document links | `text`: content policy | Step A |
| E | Security and compliance facts | `text`: `/methodology` | Q46 settled the "{Vendor} states:" display |
| F | Video | `text`: Privacy Policy third-party content, `/accessibility` sentence | Q52 follow-up on ch. 934. Wording of the notice line |
| S | The screening job | `text`: Privacy Policy, licence, advance notice | Item 14.5, the provider contract, ruling 29's EU and UK question |
| G | Case studies and customer names | `decision` | Q49. No spec or issue until it lands |

Customer quotes are not a step. They return only as their own `decision`, under the rules in finding 5.4.

Which plan carries these capabilities, its price and its agreement are set aside. They must be settled before
step A can reach vendors. No step is announced on a public page before it ships.

## 9. Documents a build would change

- Legal pages: Vendor Terms (items 14.1 to 14.5 on AECI-1363), the paid plan agreement, Privacy Policy, Terms of Service.
- A new public page: the vendor content policy.
- Public pages: `/methodology`, `/docs/trust/how-ranking-works` (AECI-1871), `/docs/vendors/plans`, the vendor guide, `/accessibility`.
- Specs: a new Enhanced spec, `ROADMAP.md` §1.5, `STAGE_2_PAID_TIERS_SPEC.md` §3 and §13, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8 for the "Supplied by" caption, `STAGE_2_5_SPEC.md` §11, `ADMIN_PANEL_SPEC.md` for the moderation and flag queues, `PRICING_RULES.md` §2.
- Contracts: `DATABASE_SCHEMA.md`, `API_CONTRACTS.md`, `CACHE_STRATEGY.md`, `ANALYTICS.md`, `NOTIFICATIONS.md`, ADR 0051 for the removal job.
- `LEGAL_IMPACT_REVIEW.md` §3: new trigger rows for vendor media, embeds, automated screening and a new plan rung.
- `LEGAL_COUNSEL_RECORD.md`: Q49's answer when it lands.
- The Linear project summary for Enhanced, which still lists company facts.

## 10. Summary

- Enhanced 1.0 is now thirteen features. Customer quotes are out under ruling 30.
- Every Enhanced block is captioned "Supplied by {Vendor}". Managed fields keep "Maintained by". No "Ad" label.
- Customer names and case studies stay in but wait on Q49. No spec or issue until counsel answers.
- Video, screening, Section 230 and the warranty are settled. Their build rules are in findings 5.7, 5.9, 5.11 and 5.17.
- Screening needs item 14.5, new Privacy Policy text and advance notice to every vendor before it runs.
- The ranking page sentence on what a plan buys ships now under AECI-1871.
- False-claim exposure, competitor claims and media accessibility are settled without counsel. Florida wiretap law goes back to counsel and blocks video.
- The verdict stays `decision` until the legal text is drafted. Plan packaging and price are still set aside.
