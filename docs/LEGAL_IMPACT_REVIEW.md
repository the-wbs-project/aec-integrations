# Legal impact review

**Audience:** anyone planning, building or reviewing a change in this repo, human or agent.
**Companions:** `docs/STAGE_1_SPEC.md` §27 (legal document lifecycle), `apps/web/src/content/legal/README.md`
(files, versions, counsel workflow), `.agents/skills/spec-anchor/plan-check.md` (plan time),
`docs/CODE_REVIEW_CHECKLIST.md` (diff time), `docs/PRICING_RULES.md` (the prices the agreements state).

## 1. Why this exists

The six `/legal/*` pages are public promises. They say what we collect, what we do with it, who may
publish without our review, how a contest is decided, what a subscription costs and when it is refunded.
Code changes those facts every week, and until 2026-10-29 nothing in the planning or review chain
asked whether a legal page still told the truth. `docs/CODE_REVIEW_CHECKLIST.md` had no legal
category, the plan check had none, and the Linear template had no field for it.

The gap was real. AECI-1305 (2026-10-29) shipped the first marketing email to accounts and a
marketing opt-out. It updated thirteen docs and no legal page. The Privacy Policy's "What we
collect" names every purpose we contact a person for, and marketing is not one of them. The Vendor
Terms' "Personal data" section says the same. Both were wrong the moment it merged.

A legal text change is slow: it needs a Linear issue, counsel review and, once a document is in
force, a version bump and an archive (§27.2). So the question has to be asked while the plan is
still cheap to change. Chris may then scale the change back to a version that needs no legal text,
rethink it, or defer it. That is his decision to make, and he can only make it if the plan says so
first.

## 2. The rule

> **In-place edits before the first acceptance (ruled 2026-11-03).** A text change to the Vendor Terms or the Managed plan agreement needs no version bump while no acceptance of the current version exists in production. Check `agreement_acceptances` by document and version first. Once one acceptance exists at that version, every later text change bumps and archives.


**Every plan and every PR states its legal impact, in this form, before anything else is judged:**

```
**Legal impact:** none | text | decision — <one sentence>
```

| Verdict | Meaning | What must follow |
|---|---|---|
| `none` | No legal page describes the behaviour the change touches, and the change creates no new promise. | The sentence names which classes in §3 were checked ("no personal data, no vendor, billing or moderation behaviour"). "n/a" alone is not a verdict. |
| `text` | A legal page already describes this behaviour and the change makes that text wrong, or adds a fact the page should state. | Name the document and the section. The plan carries the §27.2 steps: the legal issue, the text change, counsel review, and the version bump if the document is in force. Code and text merge together, or the code waits. |
| `decision` | The change would alter a promise we make, create a new obligation, or take a position no legal page takes today. | Name the document and the section, state what the promise becomes, and state the smallest version of the change that would need no legal text, if one exists. **Stop and wait for Chris's ruling before building.** |

The verdict goes in three places, and it is the same verdict in each:

1. **The plan.** The `## Spec Review` block's header line, and the first bullet of the plan's
   closing summary whenever the verdict is not `none`.
2. **The Linear issue.** The `**Legal impact:**` line of the Build Issue Template
   (`docs/linear-issue-conventions.md` §4). An issue filed before the plan exists carries the
   author's best guess; the plan check corrects it.
3. **The PR description.** The `Legal impact` section of `.github/pull_request_template.md`.
   `legal-impact-check.yml` fails the PR when the line is missing or still reads as the placeholder.
   It is not a required check, so it reports rather than blocks, and a red run is the signal.

**Code never outruns the document.** All six pages are live and public, whether or not counsel has
signed them. A change that makes a live page false does not merge before the text that fixes it.
A diff reviewer rates that 🔴 BLOCKER. A change that adds a fact a page should state but does not
contradict one is 🟡 MAJOR until the text step is in the same PR or a named, linked follow-up.

**The agreements bind what the portal does.** The Vendor Terms and the Managed plan agreement are
accepted by vendors at a recorded version (`LEGAL_AGREEMENT_CURRENT_VERSIONS`). Portal behaviour
that departs from the accepted text is a breach on our side, not a bug. A `text` verdict on either
document always needs a version bump, because they are in force for the vendors who accepted them.

## 3. Trigger map

Read this table at plan time. For each row the change touches, open the section named and quote
the sentence that would become wrong. A change outside every row is `none`, and the verdict sentence
says which rows were considered. The second column names the document and its heading as written
in `apps/web/src/content/legal/`.

### Privacy Policy (`privacy-policy.md`)

| Change class | Section | What it promises today |
|---|---|---|
| A new field collected from a person: a form input, a profile attribute, a schema column that holds personal data, a question on a form | What we collect | Lists every class of data by name: account details, About you answers, contact details per form, the "How did you find us?" question, claim fields, acceptance records, review content, and each log. A new field not in the list is undisclosed. |
| A new email to a person, or an existing email sent for a new reason (service, reminder, nudge, digest, marketing) | What we collect; Vendor Terms › Personal data | Names the purposes we contact people for: the claim, seats, subscriptions, and the requests they sent. The Privacy Policy names one marketing email, the vendor-program email, and its opt-out (AECI-1583). The Vendor Terms do not name marketing. An opt-out we offer must be described. |
| A new log, store, backup, export or analytics stream that holds request or visitor data | What we collect; Retention | Each log is named with what it holds, what it never holds (raw IP, cookies, tokens), and whether it honours Do Not Track and Global Privacy Control. Cloudflare Workers traces and Workers Logs are the "Debugging record": 7 days, every request, link parameters removed by `redact_query_string`, no IP and no cookies (AECI-1594). Invocation logs stay off (`invocation_logs: false`) because they store the raw IP. The policy allows a fuller record for up to 72 hours at about 1 request in 10, with each on and off recorded (AECI-1656). Turning invocation logs on outside such a window, a longer window, a higher rate, removing `redact_query_string`, or logging an IP or a full URL from our code is a `decision`. |
| A new third-party script, provider, SDK or processor (hosting, email, payments, analytics, bot check, search) | How we share data; What we collect | Names the provider classes, including bot and network checks on requests, and says Cloudflare runs the page-load count and the bot check. Cloudflare is our service provider for the page-load count, sees the visitor's IP address, and gives us an aggregated count. A separate sentence names Brandfetch as the third-party image service our vendor logos load from: the visitor's browser sends it the IP address and browser details, and it is not our processor (AECI-1654). A new provider that receives personal data is a new disclosure, and third-party content the browser loads from elsewhere gets its own sentence, outside the processors list. |
| Any cookie, localStorage key or identifier set in the browser | Cookies and similar technologies | "A small number of strictly necessary cookies" plus consented analytics; the Turnstile identifier is named, and so is the per-notice flag a dismissed legal notice leaves (AECI-1592), which we remove on the first visit after the notice period ends. The sign-in page's "Last used" word (`aeci.auth.lastMethod`, `google` or `email`) is named too. |
| Do Not Track or Global Privacy Control handling | Do Not Track, Global Privacy Control, and operational telemetry | States per data class whether the signal is honoured. "No identifiers" covers only the error and performance reports sent from the browser. The debugging record, and a debugging window, run for DNT and GPC requests too (AECI-1594). The policy says the signals opt out of product analytics only, and name the edge request log, the debugging record and the page-load count as kept regardless. |
| A retention window, a scheduled prune or `DELETE`, a change to how long a table or log is kept | Retention | Gives a period per class: 13 months, 400 days, "as long as the account exists". Acceptance records: email, time and version for as long as the vendor account exists and six years after it ends. The audit record: four years after the action. Deleted data stays in database backups for up to 30 days. |
| Account deletion, anonymisation, what survives a deleted account | Deletion; Retention | Lists what is removed and what is kept for the purposes stated under Retention: acceptance records, the audit record, and a message sent to another company, with the author's name removed. A read record on a thread is deleted with the account (the `claim_thread_reads` cascade). |
| How we announce a material change to the policy | Changes to this policy | A notice on every page of the site for 30 days before the change takes effect, and an email to every account holder, as the Terms describe (the band is AECI-1592; the first notice also needs the upcoming-version page, AECI-1610; the email is AECI-1637, not built). |
| What we record when someone accepts an agreement | What we collect › Agreement acceptance records | Email, time, version, and for a claim or an in-portal acceptance of a granted subscription the IP address and browser (the grant half since AECI-1615, 2026-11-10). The IP address and browser are deleted 90 days after acceptance by the daily `acceptance-evidence-removal` job (AECI-1636, built 2026-11-10, `DATABASE_SCHEMA.md` §8.6d). A signed-deal acceptance records no IP address or browser. For checkout, the signer's name, title and company legal name go to Stripe with the session. The buyer types the title on the buy form, and the legal name comes from `vendors.legal_name` (AECI-1625). Since AECI-1619 (2026-11-11) every row also stores the box's label text, a claim the two policy versions, and a checkout or grant the Plans page version and its hash. None of these is personal data, so the policy needs no new line for them. |
| Anything shown on a published review or kept private from it (firm, role, years of use) | What we collect › Review and request content | The firm is aggregate-only and never shown. |

### Terms of Service (`terms-of-service.md`)

| Change class | Section | What it promises today |
|---|---|---|
| Who may publish on the site without our review, what AECi seeds, what vendors maintain | How listings are sourced | Vendor-maintained listings publish without prior review; listings come from public information. Vendor-maintained fields carry "Maintained by {vendor} · updated {date}" under each field group, an endpoint vendor's own link reads "Link from {vendor}", and a correction by us carries "Corrected by AEC Integrations on {date}" with its source beside the value (built, AECI-1614). Seeded AECi copy stays unmarked, and the Terms sentence says so: only text we write or correct on a vendor-maintained listing is marked as ours (legal text item 10.9, applied 2026-11-06). Since AECI-1628 (built 2026-11-09) an AECi contest accept on a claimed row and an admin logo overwrite on a vendor-held record write a record-only `field_overrides` row with a required source, so they carry the same caption; a correction that cleared a value reads "Removed by AEC Integrations on {date}". An admin-set logo is still not locked, so a vendor can replace it. |
| Our powers to edit, reclassify, retire or remove a listing or review | Reservation of rights to correct or remove | Sole discretion, without notice, no obligation to list. We correct listings and facts; submitted text is removed or redacted, never reworded. |
| Any label about reviewer identity or verification, any claim about moderation strength | Reviews are opinions; Review Guidelines › Moderation process | Reviews are opinions; we do not verify every statement. A "verified" label is a stronger promise than the text makes. |
| Rate limits, scraping rules, API access, reverse-engineering, bulk export | Acceptable use | Users agree not to scrape, crawl or extract data in bulk by automated means without our written permission, or overload the service. A public data API would need a new position. |
| The license we take over submitted content, or who is responsible for vendor-published content | Acceptable use (last paragraph) | Non-exclusive, worldwide, royalty-free, irrevocable license for named operations; it does not let us reword. The vendor is responsible for its portal content. Vendor Terms carries the same license, and a logo and screenshot permission that ends with the claim (14 days, AECI-1618). Since Vendor Terms 1.2 (item 10.5) uploads come down as soon as we can and within 14 days, caches and copies included, and a logo we sourced comes down at once if the vendor objects. |
| The copyright agent, the complaint address, the DMCA block | Copyright complaints | Must stay identical to the U.S. Copyright Office registration (`legal/README.md`). |
| Governing law, venue, arbitration, jury trial | Disputes | Martin County state courts, or the Southern District of Florida where it has jurisdiction, exclusively, with any venue objection waived; no arbitration (AECI-312). Either party gives 30 days' written notice before a court action. The Terms keep the consumer-law exception. The Managed plan agreement and the Vendor Terms (since 1.2) drop it and carry a bold jury waiver (ruling 13). |
| How a change to the Terms is announced and when it binds | Changes to these terms | A 30-day site notice and an email to every account holder before a material change. A change that reduces rights binds an account holder only after they accept it at their next sign-in, and never reaches an earlier claim (ruling 12, AECI-1637, not built). |

### Review Guidelines (`review-guidelines.md`)

| Change class | Section | What it promises today |
|---|---|---|
| The moderation flow: auto-approval, pre-moderation, who sees a review before approval, suspension | Moderation process | Every review enters a queue before publication; automated checks plus human review. We may remove or redact a published review, and never reword one. Where redaction would change the meaning we remove the whole review. Rules apply evenly, with a record of each decision. An update to a published review is moderated the same way before publication (AECI-1613, built 2026-11-06). |
| Vendor replies: who may post, how many, whether moderated, how labelled, what a reply can change | Vendor responses | One response per vendor per review, from any company that has claimed its product, on any plan (AECI-1590, built 2026-11-03). Moderated before publication, labelled "Response from", never alters the review or its rank. A reply may give a support email address or a help link, and may say a problem is fixed and invite an updated review (AECI-1613). |
| Reviewer updates: who may add one, what it can change, how it shows, whether it moves ratings or counts | Updating your review | The author may add a dated update to a published review from the account page. The original text and ratings stay visible. An update may carry new ratings, and the latest approved ratings count toward the product's averages. The review count does not change. Moderated before publication (AECI-1613, built 2026-11-06). |
| What a review may contain, new fields shown on a review | What makes a good review; What is not allowed | No reviews by people who work for the vendor or a competitor, disclosed or not. Also a Privacy Policy row above. |
| How a review is reported and what happens next | Reporting a review | Email to support, reviewed promptly. |

### Listing Accuracy Policy (`listing-accuracy-policy.md`)

| Change class | Section | What it promises today |
|---|---|---|
| Who owns or maintains an integration, claim of an integration, what promote may still change, retire and restore, who may restore | Who maintains an integration | The named owner maintains it after a claim, edits publish without review, catalog updates no longer touch it, only we restore what we retired. |
| Connector-delivered integrations becoming claimable or editable | Who maintains an integration (last sentences) | Claimed, edited and contested "in the same way by its owner", on any plan (ruling 14, November 9, 2026; built by AECI-1663 on November 10, 2026). A correction request still applies. |
| Contest lifecycle: who decides, end states, what the public page shows while open, windows | Contesting an integration detail | Three end states; the page does not indicate a contest exists; the decider is fixed at send time. |
| The protest to AECi: windows, reply rights, what our view does, cooling-off | Asking us to review an owner's decision | 30-day ask, 14-day owner reply, our view comes after the reply or the 14 days, sooner only if the owner says it will not reply or the value on record causes harm that cannot wait, and an early view says so, our view is advice only, 90-day bar, nothing published. A verifiable factual error may still be corrected under the correction path. |
| Correction requests: who may ask, what we change, response | Requesting a correction; What we will and will not change | Anyone may ask, with a public source we can verify; it is not a second route for a declined contest; the listed limits on what we change. A source arrives by email or through the correction option in the service. We hide or flag a value within two business days of receiving that source, and correct a verified error within five, sooner where verification is immediate. Hiding is interim, not a finding. On a genuinely disputed value we say within five business days what we need and when we expect to decide. Business days are Monday to Friday, excluding US federal holidays. We keep a record of each step. |
| Hiding a listing or part of one, removal requests | What we will and will not change | Hiding is not deletion: off the public site and out of search, data kept. We tell the vendor of a claimed listing and it may dispute. |

### Vendor Terms (`vendor-terms.md`)

| Change class | Section | What it promises today |
|---|---|---|
| Claim eligibility, the checks we run, competing claims, the 7-day step-in, what an approved claim starts on, who gets the owner seat | Who may claim | Work email, domain and LinkedIn checks, Free plan on every product, first claimant is an owner. |
| The claim form's fields, what we record at acceptance | Personal data | Name, title, company legal name, work email, optional LinkedIn and note (title and legal name arrive with AECI-1617; the role field went with AECI-1649, matching Vendor Terms 1.2); IP and browser at acceptance. |
| Seat roles and powers, invitations, who may buy or assign or change the billing email or the company's legal name, revocation and its effect on billing, bans | Seats and revocation | Owner powers listed; revoking a seat changes nothing in billing. Suspension comes first, then notice naming the rule and evidence, then 7 business days from receipt to fix or rebut, and on a false-claim finding a further 7 business days to prove identity and authority, then the subscriptions end with a refund of the unused term less fees used and documented cost (ruling 1, AECI-1623). The code is built (2026-11-05). Item 10.3 landed in Vendor Terms 1.2 on 2026-11-07, so text and code agree. The owner's legal name edit (AECI-1625) is in the owner-powers list since Vendor Terms 1.2 (AECI-1639). |
| The claim box: its label, the policies it incorporates, the line naming their versions, what the acceptance records | Accepting these terms | The label is quoted word for word. The Listing Accuracy Policy and the Review Guidelines are part of the terms, and "the form names their versions beside the box". We record the version of the terms and of both policies. Built 2026-11-11 (AECI-1619): `@@requests.terms.policies` names both versions from `LEGAL_POLICY_CURRENT_VERSIONS`, and the claim row stores them. A label change, or a policy bump without the matching constant, makes this text false. |
| Giving up a claim: what happens to seats, content, subscriptions | Ending your claim; Managed plan agreement › If you give up your claim | Seats removed, listing and content stay, subscriptions handled under the agreement. |
| What a claimed badge or label means | Claimed is not endorsed | Only that we approved a claim. |
| Any ranking or review behaviour that could depend on a plan | Plans never affect ranking or reviews | Also `CLAUDE.md` no pay-for-placement. |
| What happens to Managed fields when Managed ends | When Managed ends on a product | The fields stay the vendor's (v1.1, AECI-1428). For 30 days after Managed ends an owner seat may ask us to blank its text (AECI-1618). The public page reads "Maintained by {vendor} until {date}" under the Managed group and "How teams use it", dated from the plan end (built, AECI-1614). |
| The indemnity, its cap and exceptions, the vendor-side liability limit | Indemnity; Disclaimers and liability | Capped at the greater of $10,000 or ten times trailing fees, with named uncapped exceptions, excluding our own content or negligence. Our limit is $100, and we exclude lost profits and indirect or consequential loss (item 10.6). Neither the cap nor that exclusion applies to the named carve-outs, and the exclusion covers only claims against us (item 11.19, Vendor Terms 1.2). |
| Portal performance or analytics data and how a vendor may use it | Personal data (last paragraph) | Internal use only. |

### Managed plan agreement (`managed-plan-agreement.md`)

| Change class | Section | What it promises today |
|---|---|---|
| Price, interval, volume tiers, proration, discounts, tax, price-change notice | Prices and billing options; `docs/PRICING_RULES.md` | $250 a year or $25 a month, no tiers, 30 days' notice for a monthly price change, never mid-term. |
| What Managed includes at a minimum; moving a feature, seats or the search-engine notice between plans; the Plans page record | What a subscription is and does | "At a minimum, Managed gives…" names the core inclusions: the Managed fields, "How teams use it", trades, audiences and phases, the integrations-page and API docs links, confirmed data flows and the search-engine notice, for the paid term at the checkout price. The notice sentence says a notice does not decide crawling, indexing or ranking. Review replies and colleague seats follow "As on every plan", so they are not presented as paid (legal agent, 2026-11-12). Rewritten in place in the 1.1 draft on 2026-11-11 (AECI-1619). "We record the Plans page as it stood when you accepted" is built: a checkout or grant row stores the Plans version and its snapshot hash. Taking one of the named inclusions out of Managed is a `decision`. |
| How a subscription comes to exist: Stripe purchase, a grant we record, complimentary; transfer on the sale of a business | What a subscription is and does; General terms | Three sources; a subscription may pass to a buyer of the business if the holder tells us first, and otherwise cannot move between companies. |
| A grant without checkout: how it is accepted, which version binds it | Opening paragraphs | It does not start until an owner seat accepts it in the portal, or until a person with authority signs a deal that names the agreement by version and date and says signing accepts it. The grant-date version governs the whole term. A signed deal controls on conflict. Built 2026-11-10 (AECI-1615): a grant waits as `pending_acceptance` until an owner ticks the box on the Billing tab or AECi records a signed deal naming the current version. An accept must name the version pinned at grant. A grant nobody accepts expires at its end date. Grants live before AECI-1615 stay live. A grant that starts on any other act, or binds a version other than the grant-date one, is a `decision`. |
| Renewal mechanics, opt-out route, the renewal notice and its contents | Annual renewal; Renewal notice | Renews unless opted out in the Stripe portal or by email; notice 45 days before (the code since AECI-1596, the text since AECI-1363). |
| Monthly cancellation | Monthly billing | Cancel any time, runs to month end. |
| Refund windows, what a refund ends, error reversals | Refunds | 14 days on the first charge and on a renewal charge, then none except where law provides otherwise; errors always reversed; card dispute rights unaffected. |
| Subscription assignment, early unassignment, release at renewal, which products keep a subscription on a shortfall | Subscriptions stay assigned until renewal | Stays until renewal; oldest assignments keep theirs. |
| Suspension, non-payment, what a lapsed card does to the products | Suspension and non-payment | Suspend at once, written notice, 7 business days from receipt to fix or rebut, and on a false-claim finding a further 7 business days to prove identity and authority. Then end with a refund of the unused term less fees used and documented cost at $150 an hour, logged at the time, only where the breach caused it, recoveries credited, never more than the refund due, with an itemized statement. Text from counsel Q13 and ruling 1, item 10.2 applied 2026-11-06. The code is built (AECI-1623, 2026-11-05) and runs each window from the first confirmed send of that stage's notice. |
| What happens to subscriptions when a claim is given up | If you give up your claim | As written (AECI-1516 touched this behaviour). |
| How a change to the agreements is announced, who gets it, what it contains | Changes to this agreement; Vendor Terms › Changes to these terms | Owner seats and billing email; names the version and date, summarizes material changes, links the archive, attaches a copy. A material monthly change needs a click (AECI-1620). |

### Cross-document triggers

- `/docs/vendors/plans` is linked from both agreements as the description of what Managed includes.
  A change to what Managed unlocks is a `text` verdict on that page and on the agreements that cite it.
  Since AECI-1619 (2026-11-11) the page is versioned, because acceptances record it. Any change to
  the page is a Plans version bump: a new snapshot file and its hash in `PLANS_PAGE_SHA256`
  (`apps/web/src/content/legal/README.md`, "The Plans page is versioned too"). Moving a capability
  between plans, or changing a price, bumps it too, because `TIER_CAPABILITIES` and the
  `MANAGED_*_PRICE_CENTS` constants feed the snapshot. `plans-snapshot.spec.ts` fails until it is done.
- `docs/PRICING_RULES.md` and the Managed plan agreement must agree. `PRICING_RULES.md` names the
  agreement as the binding contract, so a change to one is a change to both.
- `LEGAL_AGREEMENT_CURRENT_VERSIONS` in `packages/shared/src/api/agreements.ts` must equal each
  agreement's frontmatter `version`; a spec enforces it. A version bump touches both.
- The DMCA block in the Terms and the U.S. Copyright Office registration must stay identical.

## 4. How to check, at plan time

This is the same technique as plan-check category 1, aimed at the legal folder.

1. Name the **behaviour** the plan changes in plain words: "sends an email", "stores a field",
   "lets a vendor publish without review", "changes a refund window".
2. Find its row in §3. If there is no row, grep the legal folder for the nouns anyway:

   ```bash
   grep -rn -i '<noun>' apps/web/src/content/legal/*.md
   ```

3. Open the section and **quote the sentence** that would become wrong. Paraphrase is how we drift.
4. Write the verdict. For `text`, add the §27.2 steps to the plan. For `decision`, write the
   smallest no-legal-text version of the change beside it and stop.
5. Put the verdict in the `## Spec Review` header and, when not `none`, as the first bullet of the
   plan summary.

## 5. How to check, at diff time

1. Read the PR's `Legal impact` line. If it is missing, the placeholder, or `none` with no reason,
   that is a finding on its own.
2. Walk the diff against §3. A changed file under these paths is a prompt to look, not a verdict:
   `apps/api/src/db/schema.ts`, `apps/api/src/lib/notifications/registry.ts`, `apps/api/src/lib/email*`,
   `apps/api/src/lib/stripe*`, `apps/api/src/lib/billing-*`, `apps/api/src/routes/admin-claims.ts`,
   `apps/api/src/routes/admin-vendors*`, `apps/api/src/routes/admin-vendor-suspension.ts`, `apps/api/src/routes/admin-contest*`,
   `apps/api/src/routes/*review*`, `apps/web/src/content/docs/vendors/**`, `docs/PRICING_RULES.md`,
   any form component, anything that sets a cookie or adds a third-party script.
3. If the diff touches a legal page, check the lifecycle: `last_updated` moved; a version bump if the
   document is in force, with the archive and the `## Change history` line (`legal/README.md`);
   `LEGAL_AGREEMENT_CURRENT_VERSIONS` for the two agreements; the counsel step recorded on the issue.
4. Report under the checklist's "Legal documents" category with the severities in §2.

## 6. Asking a legal question

A legal agent runs in its own Conductor workspace and holds the counsel-facing context: the six
documents, the open rulings, and what counsel has already said. When a verdict is unclear, when the
trigger map has no row for the behaviour, or when a `decision` needs a first legal read before it
reaches Chris, ask that agent instead of guessing:

```
SendMessage({ to: "dodoma-8c", message: "..." })
```

Write the question the way §2 wants the verdict: the behaviour in plain words, the document and
section you think it touches, the sentence you quoted, and the verdict you are leaning to. One
question per message. Record the answer on the Linear issue, and put it in the plan beside the
verdict, because the plan check and the diff review both read the issue, not the message log.

We will try to keep the agent you are looking for named **"Legal Agent"**, so check `ListAgents`
for that name first; `dodoma-8c` is the workspace it runs in today and may change. If neither is
listed, say so in the verdict sentence and continue with the trigger map alone.

The agent's answer is a legal read, not a ruling. A `decision` verdict still waits for Chris, and a
text change still goes through counsel under §27.2.

## 7. What is not a legal impact

To keep the signal clean, these are `none` and the verdict sentence may say so in four words:

- Internal tooling, CI, lint, dependency bumps, test-only changes.
- Observability that holds no personal data (metrics, dashboards, alerts on counts).
- Catalog data content: a vendor, product or integration row changing value.
- Copy changes that do not change a behaviour a legal page describes. A relabelled button is a
  product-docs sync (`STAGE_2_PRODUCT_DOCS_SPEC.md` §4), not a legal one, unless the label is the
  one the legal page uses ("Response from", "Offered by").
- Performance, caching and SEO work, unless it adds a request log, a cookie or a third-party script.

## 8. Maintaining this document

- When a legal page gains a section, add its rows here in the same PR.
- When the legal agent's workspace name changes, update §6; the "Legal Agent" name is the stable one.
- When a trigger fires that this table did not predict, add the row with the issue id. That is the
  only kind of history this file keeps.
- When counsel changes a position (arbitration, governing law, a retention period), the row's third
  column changes with the text.
