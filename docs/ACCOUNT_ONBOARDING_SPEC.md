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

There is also a vendor tie. A user who says they work for a software vendor is shown the way to the
claim dialog on `/vendor-program`. That is the vendor-activation hook that places this work in 2.1.

## 2. The questions

One screen. Only the display name is required. "Skip for now" is always available.

| # | Question | Input | Shown to | Stored in |
|---|---|---|---|---|
| 1 | Display name | Text, 1 to 80 characters, pre-filled from the Google name | Everyone | `profiles.display_name` |
| 2 | Where do you work? | Single choice (§2.1) | Everyone | `profile_details.company_type` |
| 3 | Your role | Single choice, the review-form role list | Everyone | `profile_details.primary_role` |
| 4 | Company size | Single choice (§2.1) | Not a software vendor | `profile_details.company_size` |
| 5 | Which audiences describe you? | Multi-select from `taxonomy_audiences`, at most 10 | Not a software vendor | `profile_audiences` |
| 6 | Firm name | Text, at most 100 characters, private | Not a software vendor | `profile_details.firm_name` |
| 7 | LinkedIn profile | URL, optional, private | Everyone | `profile_details.linkedin_url` |

Every single choice has a "Prefer not to say" row, so an answer can be taken back.

### 2.1 Stored values

The values are stable slugs. The labels live in the Angular form and are `$localize` strings.

| Field | Values |
|---|---|
| `company_type` | `general_contractor`, `trade_contractor`, `architect`, `engineer`, `owner_developer`, `construction_manager`, `consultant`, `software_vendor`, `other` |
| `company_size` | `1-10`, `11-50`, `51-200`, `201-1000`, `1001-5000`, `5000+` |
| `primary_role` | `practitioner`, `manager`, `IT`, `exec`, `other` |

`primary_role` is the same list as `reviews.role_at_company`. `PrimaryRoleSchema` in
`packages/shared/src/api/profile-details.ts` defines it once, and `SubmitReviewSchema` reuses it.
The two lists cannot drift. The form shows plain labels such as "Hands-on user" and "Manager or
team lead".

### 2.2 The software vendor branch

Picking "Software vendor" hides questions 4 to 6. It shows a short note with a link to
`/vendor-program`, where the claim dialog lives. Role and LinkedIn are still asked.

A save with "Software vendor" clears `company_size`, `firm_name` and the audience set. An answer
given under a different company type must not linger out of sight.

### 2.3 LinkedIn

The value must be a profile URL: `linkedin.com/in/<handle>` or `www.linkedin.com/in/<handle>`.
The scheme is optional on input, so a pasted `linkedin.com/in/jane` passes. A query string or a
fragment is allowed and dropped.

It is normalized on write to `https://www.linkedin.com/in/<handle>`. The host is lowercased and the
handle keeps its case. A company page, another host or a lookalike host is a 400.

It is never public. Only the user's own `/account` page and the admin user detail show it.

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
- **Save** sends the answers with `onboarding: 'completed'`, then goes to `next`.
- **Skip** sends `onboarding: 'skipped'`, then goes to `next`. A failed skip still leaves. Skip
  must never trap the user.

### 7.2 `/account`

- An "About you" section sits under the display name. It uses the same `ProfileDetailsForm`. Its
  own Save button sends the answers. The first save while `pending` also sends
  `onboarding: 'completed'`.
- While `onboarding` is `pending`, a "Tell us about yourself" card sits above the profile.
  "Answer now" moves focus to the section. "Not now" records a skip, so the card does not return.
- Existing users are never redirected.

### 7.3 Shared form component

`apps/web/src/app/account/profile-details/profile-details-form.ts` holds questions 2 to 7.
Single choices use `AecSelect` (Angular Aria, ADR 0010). Audiences are a filterable checkbox list
in a `fieldset`, sorted with `compareText`. At 10 picks the unchosen boxes are disabled. A chosen
term stays visible under any filter.

## 8. Review form pre-fill

`reviews/review-form.ts` reads `GET /api/account` after hydration, beside the already-reviewed
check.

- Role takes `primary_role` while the role control is empty.
- Firm takes `firm_name` while the firm field is empty.
- Both stay editable. Stage 1 spec §4.8: pre-fill, never lock.
- It runs only in the browser. Cached HTML never carries a person's answers (Phase 5 spec §5.5).
- Years using is not pre-filled. It describes the product, not the person.
- A failed read leaves the form as it was.

## 9. Privacy and erasure

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
| `onboarding_completed` | A save that completes onboarding, on `/welcome` or `/account` | `source`, `company_type`, `company_size`, `primary_role`, `audience_count` |
| `onboarding_skipped` | Skip on `/welcome`, or "Not now" on the `/account` card | Same keys. The answers are `null` and the count is 0 |

The firm name and LinkedIn URL are never sent. `Analytics.onboardingCompleted` copies the allowed
keys only, so a wider object cannot leak them.

## 11. Deferred

These were proposed and are not in this build: the software the user uses now, why they came to
the site, trades for trade contractors, buying role, market sectors, country, and years in the
industry.
