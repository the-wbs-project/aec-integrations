# Account onboarding: the "About you" form

**Issue:** AECI-1296. **Stage:** 2.1, admitted as a named exception (`STAGE_2_1_SPEC.md` §3.3.6).
**Status:** built 2026-10-13.

This is the contract for the short form a new account sees after first sign-in. It says what we
ask, where it is stored, who can read it, and how it pre-fills the review form.

## 1. Why

New accounts tell us nothing about the person. `profiles` holds only a display name. The answers
serve two purposes:

- **Segmenting users later.** Who signs up, what kind of firm, what role.
- **Pre-filling the review form.** Role and firm fill in for the reviewer, who can still change them.

There is also a vendor tie. A user who says they work for a software company is recorded as one
(`company_type` in `SOFTWARE_COMPANY_TYPES`, §2.1). The form shows them no claim prompt. The in-form note and its
link to `/vendor-program` were removed on 2026-10-13 by Chris's decision. Reaching those users with
the claim offer is a separate follow-up: a later marketing email to software company profiles that
hold no claim (AECI-1305). `software_vendor` (AEC software) is the closest fit for that email. The
other software types are not AEC vendors as a rule. That follow-up is not built here.

## 2. The questions

One screen. Only the display name is required. "Skip for now" is always available.

| # | Question | Input | Asked of | Stored in |
|---|---|---|---|---|
| 1 | Display name | Text, 1 to 80 characters, pre-filled from the Google name | Everyone | `profiles.display_name` |
| 2 | Where do you work? | Single choice in three groups (§2.1) | Everyone | `profile_details.company_type` |
| 3 | Your role | Single choice. The review-form role list, or the software company role list (§2.2) | Everyone | `profile_details.primary_role` |
| 4 | Company size | Single choice (§2.1) | Not a software company | `profile_details.company_size` |
| 5 | Which audiences describe you? | Multi-select from `taxonomy_audiences`, at most 10 | Not a software company | `profile_audiences` |
| 6 | Firm name | Text, at most 100 characters, private | Not a software company | `profile_details.firm_name` |
| 7 | LinkedIn profile | URL, optional, private | Everyone | `profile_details.linkedin_url` |

Every single choice ends with an "I'd rather not say" row, after "Other". It is a stored answer
(`undisclosed`), not the absence of one. An unanswered question shows the "Choose one" placeholder
and no row is selected. Once a question has an answer, a "Clear answer" row leads its list, so the
answer can be taken back to unanswered.

### 2.1 Stored values

The values are stable slugs. The labels live in the Angular form and are `$localize` strings.

| Field | Values |
|---|---|
| `company_type`, AEC firms | `general_contractor`, `trade_contractor`, `architect`, `engineer`, `owner_developer`, `construction_manager`, `consultant` |
| `company_type`, software companies | `software_vendor` (AEC software), `backoffice_software`, `integration_platform`, `other_software`, `software_partner` |
| `company_type`, other options | `other`, `undisclosed` |
| `company_size` | `1-10`, `11-50`, `51-200`, `201-1000`, `1001-5000`, `5000+`, `undisclosed` |
| `primary_role`, AEC roles | `practitioner`, `manager`, `IT`, `exec`, `other`, `undisclosed` |
| `primary_role`, software company roles | `vendor_exec`, `vendor_product`, `vendor_engineering`, `vendor_partnerships`, `vendor_sales`, `vendor_marketing`, `vendor_customer_success`, `vendor_services`, `other`, `undisclosed` |

`software_vendor` is the AEC software answer. It keeps the slug it shipped with, so stored answers
needed no migration. The form labels it "AEC software". `SOFTWARE_COMPANY_TYPES` and
`SOFTWARE_COMPANY_ROLES` in `packages/shared/src/api/profile-details.ts` are the group lists.

`undisclosed` is the "I'd rather not say" answer. `null` means the question was never answered.

`primary_role` is the `reviews.role_at_company` list plus `undisclosed`. `PrimaryRoleSchema` in
`packages/shared/src/api/profile-details.ts` defines the review list once, and `SubmitReviewSchema`
reuses it. `ProfilePrimaryRoleSchema` extends it with the software company roles and `undisclosed`
for the profile only, so a review can never carry either. The two lists cannot drift. The form shows plain labels such as
"Hands-on user" and "Manager or team lead".

"Where do you work?" shows three headed groups: "AEC firms", "Software companies", then "Other
options" holding "Other" and "I'd rather not say". Each heading names an ARIA `group` in the listbox
(`AecSelect`'s optional `group` field). The first two groups and both role lists are alphabetical
by label. Each role list ends with "Other", then "I'd rather not say". The sizes run small to large,
then "I'd rather not say".

### 2.2 The software company branch

Picking any software company type hides questions 4 to 6. Nothing is shown in their place: no note
and no claim link. Role and LinkedIn are still asked, but the role list becomes the software company
roles: customer success or support, engineering, founder or executive, implementation or
professional services, marketing, partnerships or integrations, product management, sales or
business development. The live region on `/welcome` (§7.1) says which fields were removed and that
the role list changed, and says so again when they come back.

Switching between an AEC firm and a software company clears a role that is not on the new list.
"Other" and "I'd rather not say" are on both lists, so they survive the switch.

A save with a software company type clears `company_size`, `firm_name` and the audience set. A save
also clears a role that is not on the list for the saved company type. An answer given under a
different company type must not linger out of sight. The API does not cross-check the role
against the company type. The form is the only writer that pairs them.

### 2.3 LinkedIn

The value must be a profile URL: `linkedin.com/in/<handle>` or `www.linkedin.com/in/<handle>`.
The scheme is optional on input, so a pasted `linkedin.com/in/jane` passes. A query string or a
fragment is allowed and dropped.

It is normalized on write to `https://www.linkedin.com/in/<handle>`. The host is lowercased and the
handle keeps its case. A company page, another host or a lookalike host is a 400.

It is never public. Only the user's own `/account` page and the admin user detail show it.

The field's hint says why we ask: it helps us confirm that reviews come from real people working in
the industry.

### 2.4 Firm name

The firm name is never shown on a published review. The hint on the About you form says so. It also
says the review form is filled in from it, and that the reviewer can change or clear it there for
any review. The review form's own firm field carries a matching hint.

## 3. Storage

Migration `0071` adds two tables and nothing else. It is `CREATE TABLE` and `CREATE INDEX` only.
It does not rebuild `profiles`. `DATABASE_SCHEMA.md` §7.1 has the columns.

- **`profile_details`.** One row per profile, keyed by `profile_id` (FK to `profiles`,
  `ON DELETE CASCADE`). The five answers plus `onboarding_completed_at` and
  `onboarding_skipped_at`. All nullable.
- **`profile_audiences`.** `(profile_id, audience_id)`, both FKs with cascade. Modelled on
  `product_audiences`.

**Side tables, not columns on `profiles`.** A later rule change on `profiles` would force a
drizzle-kit table rebuild. A rebuild of `profiles` fires cascades into its child tables
(`migrations.md` §0). This follows `notification_preferences`.

**No CHECK constraints.** The Zod enums in `packages/shared` hold the allowed values, so a list can
change without a migration. A stored value the current build does not know reads as `null`.

**Writer.** Only `PATCH /api/account` writes these tables. `ensureProfileRow` never touches them.
Its no-clobber contract stands.

## 4. Onboarding state

`onboarding` on the account read shapes is derived, never stored as a word:

| State | Rule |
|---|---|
| `completed` | `onboarding_completed_at` is set |
| `skipped` | `onboarding_skipped_at` is set and `onboarding_completed_at` is not |
| `pending` | No row, or neither timestamp is set |

A completed save after a skip reads as `completed`.

## 5. API

`API_CONTRACTS.md` §6.8 has the full shapes.

**`GET /api/account`** adds three fields:

- `details`: the five answers plus `audience_ids`. All `null` (and `[]`) until answered.
- `onboarding`: `pending`, `completed` or `skipped`.
- `suggested_display_name`: the provider name from the verified session JWT,
  `user_metadata.full_name` else `user_metadata.name`. `null` when absent, which is the usual case
  for a magic-link account. The API never writes it.

The profile, its details row and its audience ids are read in one `db.batch`.

**`PATCH /api/account`** accepts these optional fields. Present-key semantics: an omitted key is
left alone.

- `company_type`, `company_size`, `primary_role`: an enum value or `null`.
- `firm_name`: trimmed, at most 100 characters. A blank string clears it.
- `linkedin_url`: §2.3. A blank string clears it.
- `audience_ids`: uuids, at most 10, replace-set. `[]` clears the set. Duplicates collapse.
- `onboarding`: `completed` or `skipped`. Stamps the matching timestamp.

At least one field must be present. Unknown audience ids are a 400 `VALIDATION_FAILED` with
`field: 'audience_ids'`. They are found by a read before the batch, so nothing is written.

The write is one `db.batch`: the `profiles` update if needed, the `profile_details` upsert, the
audience delete and insert, and one `profile.updated` audit row. The audit row's before and after
state carry exactly the keys the request touched. `rateLimit('write')` already covers the route.

**Admin.** `GET /api/admin/users` rows carry `company_type` and `company_size`.
`GET /api/admin/users/:id` carries `about`: every answer, LinkedIn included, the audience names A
to Z, and the onboarding state. `ADMIN_PANEL_SPEC.md` §5.8.

## 6. The sign-in redirect

`/auth/callback` reads `created` from the profile-ensure response. When it is `true`, the callback
redirects with a 303 to `/welcome?next=<return>`. A return of `/` becomes bare `/welcome`.

Two returns are never diverted:

- `/vendor/invite/…`, so a seat invitee reaches the accept page first.
- `/welcome` itself.

The return is cleaned by `sanitizeReturnPath` first. `/welcome` cleans `next` again with
`safeReturnPath`, and a `next` that points at `/welcome` becomes `/`.

`created` is not the only first-time signal. A profile made by the `GET /api/account` self-heal
(AECI-770) never reports `created` to the callback. The `/account` card (§7.2) covers that user.

## 7. Pages

### 7.1 `/welcome`

- **Gating.** `isWelcomePath` in `server-runtime.ts`. A signed-out GET bounces to login like
  `/account`. A signed-in GET gets the server-side session refresh.
- **Caching.** Not in `ROUTE_CACHE_PATTERNS`, so it is `private, no-store` by the fail-closed
  default. The page is `noindex`.
- **Behaviour.** SSR paints a loading state only. After hydration the page reads
  `GET /api/account`. If `onboarding` is not `pending`, it goes straight to `next`. Otherwise the
  display name is the stored name, else the suggested name, else empty.
- **Save** sends the answers with `onboarding: 'completed'`, then goes to `next`. Save is disabled
  only while a write is in flight, so Enter in any field submits. A Save with an invalid display
  name or LinkedIn link writes nothing. It shows each error, gives the field a `--status-error`
  border, and moves focus to the first bad field, top to bottom.
- **Skip** sends `onboarding: 'skipped'`, then goes to `next`. A failed skip still leaves. Skip
  must never trap the user. Starting a skip clears a shown save failure.
- **Leaving.** The client navigation to `next` falls back to a full page load when it resolves
  `false` or throws. If the user is still on the page after that, Skip and Save are enabled again.
  For a user who is not `pending`, a started full load keeps the loading state. The "couldn't load"
  alert and its Continue button show only when both navigations failed.
- **Announcements.** One polite live region (`role="status"`, visually hidden) is in the SSR HTML and
  stays for the page's life. It announces "Loading…", the form being ready, the fields a software
  vendor is not asked (and their return), and each audience count change. When the form appears,
  focus moves to the `h1`.
- **Copy.** The lede reads "A few questions about where you work. Reviewers get their review forms
  filled in from this. You can change any of it on your account page." It works for a vendor and a
  reviewer alike.
- **Layout (AECI-987).** The 7xl canvas with the form + context rail (`DESIGN.md` §5 → Layout shells).
  The rail says the role and firm fill in review forms (§8), that the firm name stays private
  while the role shows on published reviews (§9), and that any answer can be changed later on
  `/account`. It has no link: leaving would drop the answers, and Skip is the way out.

### 7.2 `/account`

- An "About you" section sits under the display name. It uses the same `ProfileDetailsForm`. Its
  own Save button sends the answers. The first save while `pending` also sends
  `onboarding: 'completed'`.
- While `onboarding` is `pending`, a "Tell us about yourself" card sits above the profile.
  "Answer now" moves focus to the section. "Not now" records a skip, so the card does not return.
- Existing users are never redirected.
- **Layout (AECI-987).** The page sits on the 7xl canvas. From `lg` a sticky section nav takes the
  left columns. The section order above is unchanged.

### 7.3 Shared form component

`apps/web/src/app/account/profile-details/profile-details-form.ts` holds questions 2 to 7.
Single choices use `AecSelect` (Angular Aria, ADR 0010). Audiences are a filterable checkbox list
in a `fieldset`, sorted with `compareText`. At 10 picks the unchosen boxes are disabled. A chosen
term stays visible under any filter.

A filter that matches no unchosen term shows "No audience matches that filter.", even while chosen
terms stay listed. The list scrolls inside a box with a bottom hairline and an always-drawn thin
scrollbar, so a clipped last row reads as scrollable.

Layout follows the claim dialog (`apps/web/src/app/shared/form-field/form-field-classes.ts`).
Each field stacks label, control, then hint, and fields sit `space-y-6` apart. Audiences render as
the claim dialog's choice cards. Control borders use `--border-input` (3:1), and an invalid field
takes a `--status-error` border (`DESIGN.md` "Inputs / Fields"). `/welcome` ends in the dialog's
footer row: "Skip for now" at the start, "Save and continue" at the end. Below `sm` the two stack
full width with "Save and continue" on top.

The `/account` "About you" Save follows the same rule as `/welcome`: enabled except while saving, and
an invalid LinkedIn link shows its error and takes focus. `/account` carries its own persistent polite live region
under the form, which announces the software company fields leaving and returning and each audience
count change, as on `/welcome`.

## 8. Review form pre-fill

`reviews/review-form.ts` reads `GET /api/account` after hydration, beside the already-reviewed
check.

- Role takes `primary_role` while the role control is empty. `undisclosed` and the software company
  roles are not review roles and read as empty: the role control stays unanswered.
- Firm takes `firm_name` while the firm field is empty.
- Both stay editable. Stage 1 spec §4.8: pre-fill, never lock.
- It runs only in the browser. Cached HTML never carries a person's answers (Phase 5 spec §5.5).
- Years using is not pre-filled. It describes the product, not the person.
- A failed read leaves the form as it was.

## 9. Privacy and erasure

- Published reviews never show the display name. It appears in the user's own account menu, on a
  vendor's seat roster, and on admin screens. The `/welcome` and `/account` forms carry no hint
  that says otherwise.
- The firm name and LinkedIn link are private. Search, Algolia, ranking and every public page
  never read these tables.
- The privacy policy (`apps/web/src/content/legal/privacy-policy.md`, version 1.1) names the
  fields, their purposes and their retention.
- Account deletion removes both tables by `ON DELETE CASCADE`. `AUTH_AND_RLS.md` §8 lists the
  inbound FKs, now eighteen.

## 10. Analytics

Two PostHog events, both consent-gated like every other product event. `ANALYTICS.md` lists them.

| Event | When | Properties |
|---|---|---|
| `onboarding_completed` | A save that completes onboarding, on `/welcome` or `/account` | `source`, `company_type`, `company_size`, `primary_role`, `audience_count`. `undisclosed` is a legal answer value |
| `onboarding_skipped` | Skip on `/welcome`, or "Not now" on the `/account` card | Same keys. The answers are `null` and the count is 0 |

The firm name and LinkedIn URL are never sent. `Analytics.onboardingCompleted` copies the allowed
keys only, so a wider object cannot leak them.

## 11. Deferred

These were proposed and are not in this build: the software the user uses now, why they came to
the site, trades for trade contractors, buying role, market sectors, country, and years in the
industry.

Onboarding still does not ask "How did you find AEC Integrations?". Since AECI-1063 (2026-10-29)
the claim, listing, mailing-list and feedback forms ask it instead (`docs/ANALYTICS.md` §11b).
