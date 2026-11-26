# My stack: planning document

**Status:** superseded on 2026-11-26 by `docs/MY_STACK_SPEC.md`, the build contract (AECI-2034). This plan keeps the reasoning. Drafted 2026-11-13, revised 2026-11-16. No code is written.
**Purpose:** find every legal question before build, so counsel can be asked first.
**Legal source of truth:** `docs/LEGAL_COUNSEL_RECORD.md`, questions Q55 to Q60, rulings 28, 32, 37, 38 and 39. Where this plan and the record differ, the record wins.
**Legal impact:** each build step is `text` (`MY_STACK_SPEC.md` §12). Both counsel follow-ups have landed: the Q57 follow-up (2026-11-17, ruling 40 adds bands) and Q72 (2026-11-24, email in Canada and the UK).

"My stack" is a working name. It means the list of catalog products a practitioner says their firm uses today.

## 1. What the feature is

A signed-in practitioner records the software their firm uses. They can sort it into groups, each with a
label they type. A group means whatever the reader wants: an office, a region, a business unit or a project.
Ruling 38 made groups general. They are not an office list.

The stack then changes how that person browses:

- **Filter.** Show only products that integrate with software in my stack.
- **Match count.** Each row shows how many of my stack products it integrates with, and names them.
- **Scope.** Apply either to the whole stack or to one group.

Example: one ERP integrates with ten of my products and the next best with five. Each row shows its number.
The order of the list does not change. A sort by match count is deferred (section 3).

No public page shows anything drawn from a stack. Ruling 39 removed the public usage count.

## 2. What already exists

| Fact | Source |
|---|---|
| "Stack-aware discovery" is a named candidate, marked undecided and unscheduled | `docs/STAGE_3_SPEC.md` §2.3 and §5(3), `docs/ROADMAP.md` §4.2 |
| "The software the user uses now" was proposed for onboarding and deferred | `docs/ACCOUNT_ONBOARDING_SPEC.md` §11 |
| A global "Most integrations" sort was retired because vendors can inflate the count | `docs/SEARCH_RANKING.md` §3.1 and §5a |
| No firm or office entity exists for practitioners. The firm is one private free-text field | `docs/DATABASE_SCHEMA.md` §7.1a |
| No saved-product, favourite or compare list exists | searched `docs/` and Linear |
| About-you edits write old and new values into the audit record, which outlives account deletion | AECI-1869 |
| Counsel answered on the stack's legal basis, emails, vendor totals, the public count and employer data | `docs/LEGAL_COUNSEL_RECORD.md` Q55 to Q59 |

This plan would settle the open Stage 3 §5(3) question. That is a roadmap decision for Chris.

## 3. Decisions

| Topic | Answer | When |
|---|---|---|
| Who owns a stack | One personal account. No firm record, no colleagues, in v1 | 2026-11-13 |
| Who sees one person's stack | Only that person, except where the law compels us. See finding 5.9 | 2026-11-13 |
| What vendors see | A total per product for their own products, above a floor of 5, refreshed monthly. Never who | Ruling 32 |
| What AECi admins see | Counts only. No operator reads one person's stack | 2026-11-13 |
| Access requests | A self-serve "Download my stack" on the account page | 2026-11-13 |
| Roadmap | Approved to plan, split in two. The reader half and the vendor half are separate projects | 2026-11-13 |
| Other uses of the data | Vendor totals and AECi emails. No public count | Ruling 39 |
| How finely reports slice | Totals only. Co-usage ("accounts that use X also use Y") is removed for now | 2026-11-13 |
| Groups | A general group with a free-text label. Not office-specific. No address | Ruling 38 |
| Software not in the catalog | Cannot be added in v1 | 2026-11-13 |
| Link to reviews | None in v1 | 2026-11-13 |
| Sort by match count | Dropped for now. Revisit when there are enough users to make it worthwhile | 2026-11-13 |
| Which integrations count toward a match | All of them. Too few are dual-verified today to restrict it | 2026-11-13 |
| The notice at first save | One notice. It is the privacy notice, not consent | Ruling 37 |
| Legal basis | Contract for the reader's own filtering. Legitimate interests for the vendor total | Ruling 37 |
| Leaving the totals | A switch on the account page leaves a reader's list out of the vendor totals | Ruling 37 |
| What the first notice names | Filtering and the vendor total, from day one. The switch ships with it | 2026-11-16 |

## 4. Feature sketch

This is enough shape to reason about legally. It is not a design.

**Data.** New tables keyed to the account.

| Table | Holds |
|---|---|
| `stack_groups` | owner, label (free text, short), sort position |
| `stack_items` | owner, product id, group id or null for "the whole stack", added date |
| A column on the account | whether the reader has left the vendor totals |
| A consent record for emails | who ticked the box, when, and the exact wording shown. Step D only |

**Surfaces.**

| Surface | Behaviour |
|---|---|
| `/account/stack` | Add, remove and group products. "Download my stack" gives the user a file of their own list. Private, never cached |
| First save | One notice at normal weight. It is the privacy notice for the stack. The email box joins it in step D |
| Account page | A switch that leaves the reader's list out of vendor totals |
| Browse pages | A "Works with my stack" filter, for signed-in users with a stack. No new sort |
| Product rows | Show the match count and which stack products matched |
| Vendor portal | Totals for the vendor's own products, above 5, refreshed monthly. No co-usage. Step C only |
| Email | Notices driven by the stack, for example a new integration with software you use. Step D only |

**Rules the existing architecture already forces.**

- Browse pages are cached by URL. The stack is fetched after hydration and never rendered on the server. `docs/CACHE_STRATEGY.md` §6.1.
- The stack never reaches Algolia or any public read. `docs/DATABASE_SCHEMA.md` §7.1a.
- PostHog receives counts and outcomes only. Group labels are never sent. `docs/ANALYTICS.md` §2.
- Stack writes are domain state, so each one emits an audit row in the same batch. The row records that the
  list changed, not its contents. See finding 5.7.

**Rules counsel and Chris added.**

- Group labels never leave the account. They are in no total, report, email or analytics event (ruling 38).
- Lists sit behind real access controls. A leak is a negligence claim separate from trade secrets (Q59).
- No feature is switched on until the policy text that covers it is live (Q60).

## 5. Findings

Each finding states what is wrong, why it matters, and what to do. A finding that counsel has settled says so.

### 5.1 The sort is deferred, so the ranking page stays true

**What was wrong.** A sort by match count would contradict `/docs/trust/how-ranking-works`. That page says
integration counts never change where a listing appears, and the Terms link to it.

**Why it matters.** Chris dropped the sort on 2026-11-13. The filter and the displayed match count do not
change order, and the page already says filters change which products you see.

**What to do.** Nothing now. If the sort returns, it is a `decision` and the ranking page changes first.

### 5.2 Vendors can inflate the match count

**What is wrong.** A seated vendor's integration rows go live with no moderation. Each row can put that
vendor into a user's filtered list and raise its displayed match count.

**Why it matters.** Chris ruled that all integrations count, because too few are dual-verified today. With
no sort, an inflated count cannot move a listing up. It can still mislead a buyer who reads the number.

**What to do.** Always show the matched products by name, with each integration's verification state, so
the buyer can check the number. Revisit the rule when dual-verified coverage grows.

### 5.3 The Privacy Policy does not disclose the data or its uses

**What is wrong.** The policy lists every class of data by name, and the stack and its groups are not on it.
Neither of its two About-you purposes covers filtering, vendor totals or emails. It has no retention period
for a stack.

**Why it matters.** The trigger map in `docs/LEGAL_IMPACT_REVIEW.md` says a field not on the list is
undisclosed. Counsel's Q36 answer needs a purpose and a retention period for each category.

**What to do.** Draft policy text for collection, each purpose, its legal basis, retention and deletion. The
legal basis follows ruling 37: contract for the reader's own filtering, legitimate interests for the vendor
total. The text merges before the feature is switched on.

### 5.4 The notice at first save is a privacy notice, not consent: settled by Q55

**What counsel said.** One notice covers all the uses, but only if we stop calling it consent (Q55). Under
GDPR, one confirm that covers several purposes is not valid consent for any of them. Contract covers the
reader's own filtering. Legitimate interests fits the totals, with a documented balancing test and an easy
way out.

**What to do.** Ruling 37 adopts this and replaces the consent approach of 2026-11-13.

- The notice at first save is the privacy notice itself. It sits at normal weight and asks for no tick.
- Write a short balancing test for the vendor total and keep it on file.
- Add a switch on the account page that leaves a reader's list out of the vendor totals.
- The Privacy Policy states the two legal bases. It no longer treats the stack as consent-based.

### 5.5 Vendor totals: settled by Q57, with a follow-up open

**What counsel said.** A single count per product, hidden below 5, is probably aggregate information and
not a sale or sharing (Q57). The weak spot is a live number in a small market. A vendor who watches it move
from 11 to 12 can tie the change to one firm. A higher floor does not fix that.

**What to do.** Ruling 32 sets the rules.

- The floor stays at 5.
- The total refreshes monthly, never live.
- The Vendor Terms gain a promise not to identify the accounts behind a total.
- A list whose reader used the account-page switch is left out.

**Settled since.** The Q57 follow-up (2026-11-17) said monthly, the floor and the promise are not enough on
their own. Ruling 40 shows totals as bands. Step C is specced in `MY_STACK_SPEC.md` §10 (AECI-2210).

### 5.6 The public count is removed

**What was open.** A public "used by N accounts" count on product pages.

**What happened.** Counsel said the wording was true but needed a qualifier beside the number (Q58). Ruling
33 set that wording. Ruling 39 then removed the count, because a count of accounts is not useful and only a
count of firms would be. Ruling 33 is spent.

**What to do.** Nothing. No public page shows anything drawn from a stack. A public count returns only as its
own `decision`.

### 5.7 A stack audited like About-you data would survive account deletion

**What is wrong.** Profile edits write an audit row that holds the before and after values. Account
deletion nulls the actor on that row and keeps the values and the user id for four years. The policy says
About-you answers "are deleted when you delete your account".

**Why it matters.** This gap exists in production today for firm name and LinkedIn link. It is now filed as
AECI-1869. A stack built the same way would copy it, with group labels included.

**What to do.** Stack audit rows record that the list changed, not its contents. This is the legal agent's
reading of counsel's Q27 answer.

**Retention, settled by the legal agent on 2026-11-16.** A stack is kept for as long as the account exists.
It is deleted when the reader deletes the list or the account, and it is gone from backups within 30 days.
Q27 says to state a period, so the Privacy Policy states this one. Counsel is not asked.

### 5.8 The stack is information about an employer, given by an employee: settled by Q59

**What counsel said.** A list of off-the-shelf software is rarely a trade secret (Q59). Free-text labels are
the exposure. A label such as "Acquired firm" can reveal an unannounced deal, and inviting free text gives us
reason to know it may hold a confidence. Once an employer gives notice, we have actual knowledge.

**What to do.** Ruling 38 keeps free text, makes groups general, and accepts counsel's concern.

- Group labels never leave the account. They are in no total, report, email or analytics event.
- If an employer proves who it is and asks, we delete the lists that name it, fast and completely. That
  covers the lists, the totals they fed, caches and backups.
- Backups last up to 30 days, and the reply to the employer says so.
- Lists sit behind real access controls.
- The Terms gain a sentence where the reader confirms they may share this information. Counsel called it weak
  protection. We keep it anyway.

### 5.9 Access requests are answered by a self-serve download

**What was wrong.** The policy promises access and portability by email to support. An operator cannot
answer that for a stack without reading it, and Chris ruled that admins see counts only.

**Why it matters.** A promise that only the user sees their stack must hold for support staff too. It must
also allow for legal process. Counsel's Q36 answer means the policy sentence needs that exception.

**What to do.** Chris ruled on 2026-11-13 to add "Download my stack". The policy says only the user sees
their stack, except where the law compels us to disclose it. The download is part of step A.

### 5.10 The change notice and new uses: settled by Q60

**What counsel said.** Text added before the first effective date is part of the first version and owes no
30-day notice (Q60). After that date, new text is a material change and needs the notice and the email in
AECI-1637. A new use of data we already hold needs notice or consent whenever its text lands.

**What this means for the build order.** Steps C and D are each a new use of lists saved under step A.

**Ruling (Chris, 2026-11-16).** Step A's notice and policy name the vendor total from day one. Step C then
adds no new use and needs no second notice. The switch that leaves a list out of the totals ships with step A.
The policy text for the total, its legitimate-interests basis and the balancing test must therefore be ready
for step A. Totals are still not computed or shown until step C ships.

The alternative was a filtering-only notice, with advance notice to every reader before the first total.
The legal agent confirmed the ruling on 2026-11-16 under Q55 and Q60.

Email consent is opt-in, so step D adds no use without a tick. Readers who saved before step D need a place to
tick the box later, such as the account page.

A short notice or email goes out when the first versions take effect, under ruling 28 and AECI-1870.

### 5.11 A signed-in-only filter breaks the same-behaviour rule

**What is wrong.** `DESIGN.md` says sort and filter work alike on every page and for everyone. This filter
exists only for signed-in users who have a stack.

**Why it matters.** It is a house rule, not a legal one. It also touches the help page sentence "Browsing
the directory needs no account".

**What to do.** Chris decides how a signed-out user sees the option. I suggest a visible, disabled option
that explains itself.

### 5.12 Stack-based emails: settled by Q56 for the US and EU

**What counsel said.** One unticked box at first save works (Q56). Under CAN-SPAM, a reader who ticks it has
given affirmative consent, so no advertisement label is needed. In the EU the text beside the box makes the
consent informed.

**Build rules.**

- One unticked box, for every country.
- The text beside it names us, says what the emails cover, and says the reader can withdraw at any time.
- We record who ticked, when, and the wording shown.
- EU readers get a confirmation email before the first send.
- Every email has an unsubscribe link and our postal address. Opt-outs are honoured within 10 business days.

**Settled since.** Q72 (2026-11-24) answered for Canada and the UK. The box needs our postal address and one
other contact point beside it, and a Privacy Policy link. Unsubscribe links work for 60 days. Step D is
specced in `MY_STACK_SPEC.md` §7 to §9 (AECI-2211).

## 6. Counsel's answers and what is still open

### 6.1 The ten plan questions and where they stand

| # | Plan question, short form | Where it went | State |
|---|---|---|---|
| 1 | Is an employer's software list personal information? Whose data is it? | Q55, Q59 | Not asked as such. Counsel's answers treat it as personal data and as employer information |
| 2 | Is one notice at first save enough for every use? | Q55 | Answered. Yes, as a notice, not consent. Ruling 37 |
| 3 | Are stack emails marketing email, and what does each region need? | Q56 | Answered for the US and EU. Canada and the UK open |
| 4 | Are paid vendor totals a sale or sharing? | Q57 | Answered. Probably aggregate. Vendor promise added. Ruling 32 |
| 5 | What floor is safe in a small market? | Q57 | Answered. The floor is not the leak. Monthly refresh, ruling 32. Follow-up open |
| 6 | Must a public count be qualified? | Q58 | Answered, then moot. Ruling 39 removed the count |
| 7 | Retention, and audit rows after deletion | Legal agent, 2026-11-16 | Kept while the account exists. Gone from backups within 30 days of deletion. Audit rows record the change, not the contents |
| 8 | Should the reader confirm they may share the list? | Q59 | Answered. Weak protection. Keep it |
| 9 | Does text added before the effective date owe notice? | Q60 | Answered. No, but a new use of held data does |
| 10 | Vendor Terms text on usage statistics | Q57 | Answered. A promise not to identify the accounts |

### 6.2 Open with counsel

| Item | Blocks |
|---|---|
| Q56 follow-up: email consent in Canada and the UK | Answered by Q72, 2026-11-24 |
| Q57 follow-up: is a monthly total enough | Answered 2026-11-17. Ruling 40 adds bands |

### 6.3 Settled by the legal agent on 2026-11-16

| Item | Answer | Basis |
|---|---|---|
| The stack's retention period | Kept while the account exists. Deleted with the list or the account. Gone from backups within 30 days | Q27 |
| Naming the vendor total in step A's notice | Yes. A use added later is a new use of data we already hold and needs fresh notice to every list holder | Q55, Q60 |

Neither needs counsel.

## 7. Decisions for Chris

### 7.1 Ruled on 2026-11-13

| # | Decision | Ruling |
|---|---|---|
| 1 | Per-user sort | Dropped until there are enough users |
| 2 | Which integrations count toward a match | All of them |
| 3 | Consent | One short notice at first save. Replaced by ruling 37 |
| 4 | Co-usage in the vendor portal | Removed. Risk and reward analysed later |
| 5 | Operator access to a stack | None. The user gets "Download my stack" |
| 6 | Roadmap | Approved to plan, split in two |

### 7.2 Ruled after counsel's answers, 2026-11-15 and 2026-11-16

| Ruling | Topic | Effect on this plan |
|---|---|---|
| 28 | Notice at the first effective date | A short notice or email goes out then. Finding 5.10 |
| 32 | Vendor usage totals | Monthly, never live. Vendor promise not to identify. Finding 5.5 |
| 37 | Legal basis for the list | Notice, not consent. Contract and legitimate interests. Opt-out switch. Finding 5.4 |
| 38 | Groups | General free-text groups, not offices. Labels never leave the account. Finding 5.8 |
| 39 | Public usage count | Removed. Finding 5.6 |
| Chris, 2026-11-16 | Step A's notice and the vendor total | The notice and policy name the total from day one. Finding 5.10 |

### 7.3 Still for Chris

| Decision | Options |
|---|---|
| How a signed-out reader sees the filter | Ruled 2026-11-26: hidden (`MY_STACK_SPEC.md` §13). Finding 5.11 |
| Project for the reader half | Ruled 2026-11-26: each step is its own epic in Insights (`MY_STACK_SPEC.md` §14) |

**The split.**

| Half | Scope | Project |
|---|---|---|
| Reader | Private stack, groups, filter, match count, download, opt-out switch, emails | Open |
| Vendor | Monthly usage totals in the portal | Insights |

## 8. Suggested order of build

Each step can ship alone. Every step stays off until the policy text that covers it is live.

| Step | Scope | Verdict expected | Waits on |
|---|---|---|---|
| A | Private stack with groups, the filter, the match count, the download, the opt-out switch and the first-save notice naming the vendor total | `text`: Privacy Policy, Terms sentence, account help page | Policy text drafted and live, including the vendor-total use, the retention period and the balancing test |
| B | ~~Public usage counts~~ | Removed by ruling 39 | |
| C | Vendor totals, monthly | `decision`: Vendor Terms, Vendor Performance spec | Q57 follow-up. Vendor Terms promise |
| D | Stack-based emails | `decision`: policy, notification registry | Q56 follow-up for Canada and the UK |

Both follow-ups have landed. Steps A, C and D are AECI-2209, AECI-2210 and AECI-2211 (`MY_STACK_SPEC.md` §14). The sort is not a step. It
returns as its own `decision` if Chris revives it.

## 9. Documents a build would change

- Legal pages: Privacy Policy, Terms of Service, Vendor Terms.
- Public pages: `/docs/account/your-data`, `/docs/account/signing-in`.
- Specs: a new stack spec, `STAGE_3_SPEC.md` §2.3 and §5(3), `ROADMAP.md` §4.2, `ACCOUNT_ONBOARDING_SPEC.md` §11, `VENDOR_PERFORMANCE_SPEC.md` §1.1 and §2.4.
- Contracts: `DATABASE_SCHEMA.md` §7, `API_CONTRACTS.md`, `AUTH_AND_RLS.md` §8 (erasure batch, employer deletion), `CACHE_STRATEGY.md` §6.1, `ANALYTICS.md`, `NOTIFICATIONS.md`.
- `LEGAL_IMPACT_REVIEW.md` §3: a new trigger row for personal lists and per-user filtering.
- `LEGAL_COUNSEL_RECORD.md`: the Q56 and Q57 follow-up answers when they land.
- A balancing test for the vendor total, kept on file.

## 10. Summary

- The public "used by N accounts" count is gone under ruling 39. Build step B is gone with it.
- Groups are general free-text labels, not offices. Labels never leave the account.
- The first-save notice is a privacy notice, not consent. Contract covers filtering. Legitimate interests covers the vendor total.
- An account-page switch leaves a reader's list out of the vendor totals.
- Vendor totals sit above 5, refresh monthly and never live. Step C waits on the Q57 follow-up.
- Stack emails need one unticked box with full wording and a record. Step D waits on the Q56 follow-up.
- Step A's notice names the vendor total from day one, so step C needs no second notice. The opt-out switch ships with step A.
- The verdict stays `decision` until the text is drafted. The reader half still needs a project.
