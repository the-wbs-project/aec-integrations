# Legal impact review

**Audience:** anyone planning, building or reviewing a change in this repo, human or agent.
**Companions:** `docs/STAGE_1_SPEC.md` §27 (legal document lifecycle), `apps/web/src/content/legal/README.md`
(files, versions, counsel workflow), `.agents/skills/spec-anchor/plan-check.md` (plan time),
`docs/CODE_REVIEW_CHECKLIST.md` (diff time), `docs/PRICING_RULES.md` (the prices the agreements state).

## 1. Why this exists

The six `/legal/*` pages are public promises. They say what we collect, what we do with it, who may
publish without our review, how a contest is decided, what a license costs and when it is refunded.
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
| A new email to a person, or an existing email sent for a new reason (service, reminder, nudge, digest, marketing) | What we collect; Vendor Terms › Personal data | Names the purposes we contact people for: the claim, seats, licenses, and the requests they sent. Marketing is not named. An opt-out we offer must be described. |
| A new log, store, backup, export or analytics stream that holds request or visitor data | What we collect; Retention | Each log is named with what it holds, what it never holds (raw IP, cookies, tokens), and whether it honours Do Not Track and Global Privacy Control. |
| A new third-party script, provider, SDK or processor (hosting, email, payments, analytics, bot check, search) | How we share data; What we collect | Names the provider classes and says Cloudflare runs the page-load count and the bot check. A new provider that receives personal data is a new disclosure. |
| Any cookie, localStorage key or identifier set in the browser | Cookies and similar technologies | "A small number of strictly necessary cookies" plus consented analytics; the Turnstile identifier is named. |
| Do Not Track or Global Privacy Control handling | Do Not Track, Global Privacy Control, and operational telemetry | States per data class whether the signal is honoured. |
| A retention window, a scheduled prune or `DELETE`, a change to how long a table or log is kept | Retention | Gives a period per class: 13 months, 400 days, "as long as the account exists". |
| Account deletion, anonymisation, what survives a deleted account | Deletion; Retention | Lists what is removed and what is kept (acceptance records, a limited audit record). |
| What we record when someone accepts an agreement | What we collect › Agreement acceptance records | Email, time, version, and for a claim the IP address and browser. |
| Anything shown on a published review or kept private from it (firm, role, years of use) | What we collect › Review and request content | The firm is aggregate-only and never shown. |

### Terms of Service (`terms-of-service.md`)

| Change class | Section | What it promises today |
|---|---|---|
| Who may publish on the site without our review, what AECi seeds, what vendors maintain | How listings are sourced | Vendor-maintained listings publish without prior review; listings come from public information. |
| Our powers to edit, reclassify, retire or remove a listing or review | Reservation of rights to correct or remove | Sole discretion, without notice, no obligation to list. |
| Any label about reviewer identity or verification, any claim about moderation strength | Reviews are opinions; Review Guidelines › Moderation process | Reviews are opinions; we do not verify every statement. A "verified" label is a stronger promise than the text makes. |
| Rate limits, scraping rules, API access, reverse-engineering, bulk export | Acceptable use | Users agree not to "scrape at scale" or overload the service. A public data API would need a new position. |
| The license we take over submitted content, or who is responsible for vendor-published content | Acceptable use (last paragraph) | Non-exclusive worldwide license; the vendor is responsible for its portal content. |
| The copyright agent, the complaint address, the DMCA block | Copyright complaints | Must stay identical to the U.S. Copyright Office registration (`legal/README.md`). |
| Governing law, venue, arbitration | Disputes | Florida courts; no arbitration (AECI-312). |

### Review Guidelines (`review-guidelines.md`)

| Change class | Section | What it promises today |
|---|---|---|
| The moderation flow: auto-approval, pre-moderation, who sees a review before approval, suspension | Moderation process | Every review enters a queue before publication; automated checks plus human review. |
| Vendor replies: who may post, how many, whether moderated, how labelled, what a reply can change | Vendor responses | One response per owner per review, moderated before publication, labelled "Response from", never alters the review or its rank. |
| What a review may contain, new fields shown on a review | What makes a good review; What is not allowed | Also a Privacy Policy row above. |
| How a review is reported and what happens next | Reporting a review | Email to support, reviewed promptly. |

### Listing Accuracy Policy (`listing-accuracy-policy.md`)

| Change class | Section | What it promises today |
|---|---|---|
| Who owns or maintains an integration, claim of an integration, what promote may still change, retire and restore, who may restore | Who maintains an integration | The named owner maintains it after a claim, edits publish without review, catalog updates no longer touch it, only we restore what we retired. |
| Connector-delivered integrations becoming claimable or editable | Who maintains an integration (last sentence) | "Not yet open to any of this." Opening them is a `text` verdict. |
| Contest lifecycle: who decides, end states, what the public page shows while open, windows | Contesting an integration detail | Three end states; the page does not indicate a contest exists; the decider is fixed at send time. |
| The protest to AECi: windows, reply rights, what our view does, cooling-off | Asking us to review an owner's decision | 30-day ask, 14-day owner reply, our view is advice only, 90-day bar, nothing published. |
| Correction requests: who may ask, what we change, response | Requesting a correction; What we will and will not change | Anyone may ask; the listed limits on what we change. |

### Vendor Terms (`vendor-terms.md`)

| Change class | Section | What it promises today |
|---|---|---|
| Claim eligibility, the checks we run, competing claims, the 7-day step-in, what an approved claim starts on, who gets the owner seat | Who may claim | Work email, domain and LinkedIn checks, Free plan on every product, first claimant is an owner. |
| The claim form's fields, what we record at acceptance | Personal data | Name, role, work email, optional LinkedIn and note; IP and browser at acceptance. |
| Seat roles and powers, invitations, who may buy or assign or change the billing email, revocation and its effect on billing, bans | Seats and revocation | Owner powers listed; revoking a seat changes nothing in billing; a ban cancels at term end with no refund. |
| Giving up a claim: what happens to seats, content, licenses | Ending your claim; Managed plan agreement › If you give up your claim | Seats removed, listing and content stay, licenses handled under the agreement. |
| What a claimed badge or label means | Claimed is not endorsed | Only that we approved a claim. |
| Any ranking or review behaviour that could depend on a plan | Plans never affect ranking or reviews | Also `CLAUDE.md` no pay-for-placement. |
| What happens to Managed fields when Managed ends | When Managed ends on a product | The fields stay the vendor's (v1.1, AECI-1428). |
| Portal performance or analytics data and how a vendor may use it | Personal data (last paragraph) | Internal use only. |

### Managed plan agreement (`managed-plan-agreement.md`)

| Change class | Section | What it promises today |
|---|---|---|
| Price, interval, volume tiers, proration, discounts, tax, price-change notice | Prices and billing options; `docs/PRICING_RULES.md` | $250 a year or $25 a month, no tiers, 30 days' notice for a monthly price change, never mid-term. |
| How a license comes to exist: Stripe purchase, AECi grant, complimentary | What a license is and does | Three sources; a license cannot move between companies. |
| Renewal mechanics, opt-out route, the 30-day notice and its contents | Annual renewal; Renewal notice | Renews unless opted out in the Stripe portal or by email; notice 30 days before. |
| Monthly cancellation | Monthly billing | Cancel any time, runs to month end. |
| Refund windows, what a refund ends, error reversals | Refunds | 14 days on the first charge, renewals not refundable, errors always reversed. |
| License assignment, early unassignment, release at renewal, which products keep a license on a shortfall | Licenses stay assigned until renewal | Stays until renewal; oldest assignments keep theirs. |
| Suspension, non-payment, what a lapsed card does to the products | Suspension and non-payment | As written. |
| What happens to licenses when a claim is given up | If you give up your claim | As written (AECI-1516 touched this behaviour). |

### Cross-document triggers

- `/docs/vendors/plans` is linked from both agreements as the description of what Managed includes.
  A change to what Managed unlocks is a `text` verdict on that page and on the agreements that cite it.
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
   `apps/api/src/routes/admin-vendors*`, `apps/api/src/routes/admin-contest*`,
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
