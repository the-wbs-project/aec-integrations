# My stack: the saved software list build spec

**Issue:** AECI-2034. **Status:** build contract, written 2026-11-26. Nothing is built yet.
**Replaces:** `docs/MY_STACK_PLAN.md` as the contract. The plan keeps the reasoning behind each decision.
**Legal source of truth:** `docs/LEGAL_COUNSEL_RECORD.md`, Q55 to Q59 and Q72, and rulings 16, 28, 32, 37
to 40, 56 and 57. Where this spec and the record differ, the record wins. Raise the difference.

"My stack" is the reader-facing name. It is the private list of catalog products a signed-in reader says
their firm uses. Counsel's questions call it the "saved software list". Both names mean this feature.

## 1. Scope

Three build steps. Each ships alone, and each stays switched off until the legal text that covers it is
live (§12).

| Step | Scope | Sections | Project |
|---|---|---|---|
| A | The list, groups, the "Works with my stack" filter, the match count, "Download my stack", the first-save notice, the switch that leaves the vendor totals | §3 to §6, §11, §13 | Insights |
| C | Monthly vendor totals, shown as bands in the vendor portal | §10 | Insights |
| D | Emails about changes to listed software: the opt-in box, the consent record, the confirmation email, unsubscribe | §7 to §9 | Insights |

Step B, the public "used by N accounts" count, is gone (ruling 39). No public page shows anything drawn
from a stack. A sort by match count is not a step. It returns only as its own `decision`, and the ranking
page changes first (plan finding 5.1).

## 2. Decisions this spec builds on

| Topic | Rule | Source |
|---|---|---|
| Owner | One personal account. No firm record and no shared lists in v1 | Plan §3, 2026-11-13 |
| Who sees a list | Only its owner, except where the law compels us | Plan §3, finding 5.9 |
| Operators | See counts only. No operator reads one person's list | Plan §3, 2026-11-13 |
| Access requests | Self-serve "Download my stack" | Plan §3, 2026-11-13 |
| Catalog only | A reader can add only catalog products in v1 | Plan §3 |
| Matches | Every integration counts toward a match | Plan §3 |
| Co-usage | None. No "accounts that use X also use Y" | Plan §3 |
| Legal basis | A notice, not consent. Contract for the reader's own filtering. Legitimate interests for the vendor total | Ruling 37 (Q55) |
| Leaving the totals | A switch on the account page | Ruling 37 |
| First notice | Names the vendor total from day one. The switch ships in the same step | Ruling 57 |
| Groups | General groups with a free-text label. Not an office list. Labels never leave the account | Ruling 38 (Q59) |
| Retention | Kept while the account exists. Deleted when the reader deletes it or the account | Ruling 56 |
| Vendor totals | Monthly, never live. A floor of 5. Bands, never the exact number. A vendor promise not to identify accounts | Rulings 32, 40 (Q57) |
| Emails | One unticked box. Full wording beside it. A record of the tick | Q56, Q72 |

## 3. Data model (proposed)

The columns below are the contract's shape. Final names land in `apps/api/src/db/schema.ts` and
`docs/DATABASE_SCHEMA.md` §7 with the build. Every table keys to `profiles(id)` with `ON DELETE CASCADE`
and is also deleted explicitly in the erasure batch (§11.1). Read `docs/migrations.md` §0 before any
migration that recreates a table here.

| Table | Step | Columns |
|---|---|---|
| `stack_groups` | A | `id`, `profile_id`, `label` (text, 1 to 40 characters, trimmed), `position`, `created_at`, `updated_at` |
| `stack_items` | A | `id`, `profile_id`, `product_id`, `group_id` (null means "no group"), `added_at`. Unique on (`profile_id`, `product_id`, `group_id`) |
| `profiles.stack_excluded_from_totals` | A | Integer boolean, default `0`. `1` leaves the list out of every vendor total (§10) |
| `profiles.stack_notice_seen_at` | A | When the first-save notice was shown (§6). Null until then |
| `stack_email_consents` | D | §8 |
| `stack_usage_snapshots` | C | `product_id`, `period` (`YYYY-MM`), `band` (text from §10.3, or null below the floor), `computed_at`. Primary key (`product_id`, `period`). Holds no account id and no exact count |

A product the reader saved can later leave the catalog. The item row stays, the list shows it as "No
longer listed", and it counts toward nothing. A product deleted outright cascades its item rows away.

Caps: 200 items and 20 groups per account. They stop abuse and bound the match query. A write over a cap
returns `422 STACK_LIMIT`.

## 4. Access controls (Q59, plan finding 5.9)

Counsel said a firm's software list is useful to an attacker and a leak is a negligence claim of its own.
These rules are the "real access controls".

1. **The owner comes from the session.** Every stack route reads the profile id from the authenticated
   session. No route takes a profile id in its path, query or body. There is no route that reads another
   account's list. `docs/AUTH_AND_RLS.md` §4 is the guard model.
2. **No operator surface.** No admin page, admin endpoint, export, data-quality check or ops script reads
   list rows or labels. Admin reports may show counts of lists and items, never their contents.
3. **Audit rows record the change, not the contents.** Each write is domain state, so it emits an
   `audit_log` row in the same `db.batch` (`apps/api/src/lib/audit.ts`). The row's action says what kind of
   change it was, for example `stack.item_added`. It holds no product id, no group id and no label. This
   keeps the AECI-1869 gap out of the stack (plan finding 5.7).
4. **Analytics gets counts only.** PostHog events may carry item and group counts and outcomes. They never
   carry a product id from a list, a group label, or the match set. `docs/ANALYTICS.md` §2.
5. **Nothing public reads it.** The stack never reaches Algolia, the sitemap, an SSR render or a cached
   response. Browse pages fetch it after hydration and render visitor-state-neutral HTML
   (`docs/CACHE_STRATEGY.md` §6.1). Every stack response is `Cache-Control: private, no-store`.
6. **Logs hold no contents.** No `console.*` line, trace attribute or error report includes list contents
   or labels.
7. **Access requests are self-serve.** "Download my stack" on `/account/stack` returns the owner's own
   list as a JSON or CSV file. Support answers an access request by pointing at it and never reads the list.
8. **Legal process is the only exception.** The Privacy Policy says only the reader sees their list, except
   where the law compels us to disclose it (§12).

Rate limits follow `docs/waf-rate-limits.md` §6: writes only, after the guard. Reads are never limited.

## 5. Groups (ruling 38)

- A reader groups products however they like, under a free-text label they type.
- A group is a general tool. Labels, placeholders, examples and help text never suggest an office, a
  location or a deal. Use neutral examples such as "Preconstruction" or "Field tools".
- A label never leaves the account. It appears in no total, report, email, notification, analytics event,
  audit row or log line. "Download my stack" is the one place it leaves the page, to its own owner.
- The filter and the match count can apply to the whole stack or to one group. The group is chosen on the
  client and never sent in a URL.

## 6. Step A: the first-save notice and the switch (Q55, rulings 37 and 57)

The first time a reader saves a product, the page shows one short notice. It is the privacy notice for the
stack (Art. 13). It is not consent, so it has no tick box and blocks nothing. The save goes through. The
notice sits at normal weight beside the save, and `profiles.stack_notice_seen_at` records that it was shown.

It names, in plain words:

1. that only the reader sees the list;
2. that we use it to filter and annotate the directory for them;
3. that vendors on a paid plan see a monthly total of how many accounts list each of their own products,
   shown as a range, never below 5, never who;
4. that the account page has a switch to leave their list out of those totals;
5. a link to the Privacy Policy section on the stack.

Use 3 is named from day one even though totals are off until step C (ruling 57). Step C then adds no new
use and needs no second notice (Q60).

**The switch.** `/account` gains "Leave my stack out of vendor totals". It sets
`profiles.stack_excluded_from_totals`. It ships in step A. A change takes effect at the next monthly
snapshot. The help text says so.

**Terms sentence.** The Terms gain a sentence in which the reader confirms they may share this
information. Counsel called it weak protection (Q59). We keep it.

## 7. Step D: the email opt-in box (Q56, Q72)

The box appears in the first-save notice once step D ships. Readers who saved before step D find the same
box on `/account/stack`. It is the same component in both places.

**The box.** One checkbox, unticked by default, never pre-ticked by any code path:

> Email me when something changes for software on my list.

**Beside it, always visible, the same text for every reader in every country:**

- who we are: AEC Integrations, operated by The WBS Project, Inc.;
- what the emails cover: changes to products on the list, such as a new integration;
- that the reader can withdraw at any time, from any email or from the account page;
- our postal address and `support@aecintegrations.com`. The address string is `OPERATOR_POSTAL_ADDRESS`.
  It lives in `apps/api/src/lib/email-layout.ts` today. The build moves it into `@aeci/shared` and
  re-exports it there, so the box and the email footer render one string;
- a link to the Privacy Policy.

The four CASL items (name, purpose, withdrawal, address plus one other contact point) are all required.
Removing any of them breaks Canadian consent (Q72). A link to a contact page that shows both the address
and the email also meets the rule, but the default is the text itself.

The wording is not localised by country. Every reader sees the same words.

## 8. Step D: the consent record (Q56, Q72, ruling 16)

Table `stack_email_consents`, one row per tick. Columns:

| Column | Holds |
|---|---|
| `id` | Row id |
| `profile_id` | Who ticked |
| `consented_at` | When the box was ticked and saved |
| `source` | `first_save` or `account_page` |
| `label_text` | The box label, exactly as shown |
| `disclosure_text` | The text beside the box, exactly as shown, including the address line and the contact email |
| `text_sha256` | SHA-256 (lowercase hex, UTF-8) of `label_text` and `disclosure_text` joined by `\n` |
| `started_unticked` | Integer boolean. Always `1`. A test holds it |
| `confirmed_at` | When the confirmation link was used (§9.1). Null until then |
| `withdrawn_at` | When the reader withdrew. Null while active |
| `withdrawn_via` | `email_link`, `one_click` or `account_page` |

This follows ruling 16: store the text itself, with the hash beside it. The client sends the text it
rendered. The API compares it with the server's own copy of the current wording and refuses a mismatch with
`409 STALE_WORDING`. The stored text is the server's copy.

A withdrawal updates the row and never deletes it. A new tick after a withdrawal writes a new row. Only
the latest row decides whether we send.

Retention: the rows are kept for as long as the account exists, as proof of consent. They are deleted in
the erasure batch. The Privacy Policy names this.

Each write emits its `audit_log` row in the same batch. The audit row holds the consent row id, not the
text.

## 9. Step D: the emails (Q56, Q72, CAN-SPAM)

### 9.1 Confirmation before the first send

Counsel requires a confirmation email before the first send for EU readers (Q56). Canada and the UK do not
need one, and counsel said one does no harm there (Q72).

**Who gets it is not decided (Chris, 2026-11-26: "TBD later").** Step D cannot be built until he rules.
The two choices are every reader, which needs no country check, or EU readers only. For EU only, the
country comes from `request.cf.country` at tick time and is stored on the consent row. A VPN or travel can
put a reader in the wrong group.

The confirmation email names what the reader asked for and has one button, "Confirm these emails". The link
is single-use and lasts 7 days, the same lifetime as the existing confirmation links named in the Privacy
Policy. Using it sets `confirmed_at`. No change email goes out until `confirmed_at` is set. An unconfirmed
consent never sends anything else, and the reader can ask for a new link from the account page.

### 9.2 What a change email is

**A weekly digest, at most one email a week per reader (Chris, 2026-11-26).** The digest
lists every qualifying change since the last digest for products on the reader's list. A week with no
change sends nothing.

Qualifying changes in v1:

- a new published integration between a listed product and any product;
- a published integration of a listed product retired;
- a listed product leaving the catalog.

The email names products and integrations. It never names a group label. It never says how many other
readers list a product. We write and send it. No vendor pays for it, picks its content or receives the
reader's address (Q56).

### 9.3 Every email

- Uses the house layout, so it carries `OPERATOR_POSTAL_ADDRESS` in the footer (`docs/email.md`).
- Has an honest from line and a subject that says what changed.
- Carries an unsubscribe link in the body and an RFC 8058 `List-Unsubscribe` one-click header, on the
  same token pattern as the marketing mute (`notification_preferences`).
- Has no advertisement label. The tick is affirmative consent under CAN-SPAM (Q56).
- Never blind-copies the operator, as for every send with `List-Unsubscribe`.

### 9.4 Unsubscribe

- **Every unsubscribe link works for at least 60 days after its email was sent** (Q72). The token behind
  it must not rotate inside that window. A token rotation, if any, keeps the old token valid for 60 days.
  A test holds this.
- An unsubscribe takes effect at once. It sets `withdrawn_at` and stops the next digest. The legal limit
  is 10 business days (CAN-SPAM, CASL). We do not use it.
- The confirm page is noindex and non-cacheable. A GET never changes state. The one-click POST does.
- Withdrawing from the account page has the same effect.

### 9.5 Plumbing

- Registry entry in `apps/api/src/lib/notifications/registry.ts`, then `pnpm docs:notifications` to
  regenerate `docs/NOTIFICATIONS.md`.
- Cron enqueues, a Queue consumer sends, with `sendBatch()` for producers and `mapWithConcurrency` for
  fan-out.
- Each send writes its `notification_sends` ledger row. The dedupe key is per reader per week.
- `production-external` delivery, as for other reader mail.

## 10. Step C: vendor totals (Q57, rulings 32 and 40)

### 10.1 What a vendor sees

For each of its own products, a band such as "10 to 24 accounts list this product". Nothing else: never an
exact number, never who, never which firm, never a group label, never what else those accounts list.

It is shown on `/vendor/:slug/performance` behind `analytics.view`, the Insights capability
(`docs/VENDOR_PERFORMANCE_SPEC.md`, `docs/STAGE_2_PAID_TIERS_SPEC.md` §3). The figure's caveat says it is
self-reported and counts accounts, not firms.

### 10.2 How it is computed

- A monthly cron enqueues one snapshot job. The consumer computes every product's count and writes
  `stack_usage_snapshots` for the new period in one batch. The total never updates live, so a vendor cannot
  watch it move (ruling 32).
- An account counts once per product, however many groups hold it.
- Left out: accounts with `stack_excluded_from_totals = 1`, accounts with a vendor role or a seat, banned
  accounts, and products no longer in the catalog.
- Below 5, the band is null and the portal shows "Fewer than 5". The exact count is not stored.
- Only the band leaves the job. The exact count exists only in the job's memory.

### 10.3 Bands (ruling 40)

| Count | Band |
|---|---|
| 0 to 4 | Fewer than 5 |
| 5 to 9 | 5 to 9 |
| 10 to 24 | 10 to 24 |
| 25 to 49 | 25 to 49 |
| 50 or more | Not decided. Chris will set the bands above 49 before step C is built (2026-11-26) |

### 10.4 What must be in place before a vendor sees a band

- The Vendor Terms promise not to try to identify the accounts behind a total (ruling 32).
- The Privacy Policy's public commitment that we do not try to re-identify the accounts behind a total and
  that totals are shown only as ranges. Counsel said the promise counts toward the "deidentified"
  definition of Cal. Civ. Code 1798.140(m) together with a public commitment and technical measures (Q57
  follow-up). The bands, the floor and the monthly refresh are the technical measures.
- The written legitimate-interests balancing test, on file (ruling 37). The Privacy Policy states the basis.

## 11. Retention and deletion (ruling 56, Q59)

### 11.1 The reader's own deletion

- Deleting an item or group deletes the rows at once.
- Deleting the whole list deletes every `stack_items` and `stack_groups` row for the account.
- Deleting the account deletes all stack rows and consent rows in the erasure batch (`docs/AUTH_AND_RLS.md`
  §8), explicitly, not only by cascade.
- A deleted list stops counting from the next monthly snapshot. A snapshot holds no account id, so nothing
  in it needs deleting.
- Deleted rows stay in D1 Time Travel for up to 30 days (`docs/DATABASE_SCHEMA.md` §15). The Privacy
  Policy already states that window for backups.

### 11.2 An employer's notice (Q59)

Once an employer gives notice, we have actual knowledge. Counsel said deletion must then be fast and
complete: the lists, the totals they fed, caches and backups.

1. Verify the employer's identity, as `docs/runbooks/listing-submissions.md` verifies a company.
2. Within 10 business days of verification (Chris, 2026-11-26), delete every list whose owner's sign-in email is at the
   employer's verified domain, or whose owner the employer names. The operator runs a scripted deletion that
   takes account ids. It never displays list contents.
3. Recompute the current period's snapshot for every product those lists held, at once, outside the monthly
   cycle. This is the one exception to the monthly rule, and it only ever lowers a band.
4. Purge any cache that holds a vendor performance response for those products.
5. Write one `audit_log` row per account, with no contents.
6. Reply to the employer that the lists are deleted and that backups age out within 30 days.

A Time Travel restore inside those 30 days would bring deleted lists back. After any restore, re-run every
whole-list, account and employer deletion recorded in `audit_log` after the restore point. Those rows carry
the account id, which is all a replay needs. Single-item edits carry no product id (§4.3), so they are lost
like any other write after the restore point. No D1 restore runbook exists today. The build adds this step
to `docs/runbooks/legal.md` and points at it from wherever the restore procedure is first written.

The build adds an "Employer asks us to delete its staff's software lists" entry to
`docs/runbooks/legal.md`.

## 12. Legal text gates (Q60)

No step switches on until its text is live. Each step's PR states its verdict
(`docs/LEGAL_IMPACT_REVIEW.md`).

| Step | Text that must be live first | Expected verdict |
|---|---|---|
| A | Privacy Policy: the stack and its groups under "What we collect"; filtering on contract; the vendor total on legitimate interests; the switch; only the reader sees it, except where the law compels us; kept while the account exists, deleted with it, out of backups within 30 days. Terms: the reader confirms they may share the information. `/docs/account/your-data`: "Download my stack". `LEGAL_IMPACT_REVIEW.md` §3 gains a trigger row for personal lists and per-user filtering | `text` |
| C | Vendor Terms: the promise not to identify accounts. Privacy Policy: the public re-identification commitment and the bands. Balancing test on file | `text` |
| D | Privacy Policy: list emails, the consent record and its retention, the confirmation email, how to withdraw | `text` |

Text added before the first effective date is part of the first version and owes no 30-day notice (Q60).
Text added after it is a material change and needs the notice and the `legal-account-change` email.

## 13. Browse behaviour (step A)

- **Filter.** "Works with my stack" shows only products that integrate with at least one product in the
  stack, or in the chosen group. It changes which products appear, never their order.
- **Match count.** Each row shows how many stack products it integrates with and names them, each with its
  integration's verification state, so a reader can check the number (plan finding 5.2).
- **Who sees the filter.** Only a signed-in reader with at least one saved product. A signed-out reader, or
  a reader with an empty stack, sees no filter and no match count (Chris, 2026-11-26). This is a ruled
  exception to `DESIGN.md` "The Same-Behavior Rule", which says a page that differs goes to Chris. It
  keeps the help page sentence "Browsing the directory needs no account" true.
- The filter and the count are computed on the client from the reader's stack and the page's data, or by an
  uncached authenticated API call. The cached HTML never changes.

## 14. Issue map

Each step is its own epic in the Insights project. Build issues are filed as sub-issues of the epic when
the step is broken down.

| Step | Epic |
|---|---|
| A | AECI-2209 |
| C | AECI-2210 |
| D | AECI-2211. AECI-2032 (the Canada box rules) relates to it |

## 15. Rulings and open questions

Chris ruled on 2026-11-26:

| # | Question | Ruling |
|---|---|---|
| 1 | Who gets the confirmation email before the first send | Not decided. Blocks step D (§9.1) |
| 2 | Email cadence | A weekly digest (§9.2) |
| 3 | Bands above 49 | Not decided. Blocks step C (§10.3) |
| 4 | How a signed-out reader sees the filter | Hidden (§13) |
| 5 | Project and structure | Each step is its own epic, in Insights (§14) |
| 6 | Deadline to delete lists after an employer's verified notice | 10 business days (§11.2) |

Step A has no open question.

## 16. Tests each step owes

- **A:** an API test that no stack route accepts a profile id from the request; an audit-row test that no
  product id or label is written; a PostHog payload test with no label; an erasure test that every stack
  row goes; a component spec that the notice names the vendor total and links the policy.
- **C:** a snapshot test for the floor, the bands, each exclusion and the one-count-per-account rule; a
  test that no exact count is stored or returned; a test that the employer recompute only lowers a band.
- **D:** a component spec that the box is unticked and that the postal address, the contact email and the
  Privacy Policy link render beside it (AECI-2032); a test that the stored text matches the rendered text
  and the hash; a test that nothing sends before `confirmed_at`; a test that an unsubscribe link still works
  60 days after its send.
