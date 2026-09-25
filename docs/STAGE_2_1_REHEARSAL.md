# Stage 2.1 — Vendor Lifecycle Dress Rehearsal

**Version:** 0.1
**Date:** 2026-09-23
**Issue:** AECI-1103. **Governs:** `STAGE_2_1_SPEC.md` §3.1 (the rehearsal) and the first box of §5
(the vendor go-live gate).
**Status:** Script written, no run logged. The script is the contract for both sittings. The run log
lives in §"Runs" below and is committed with each sitting.

**Purpose.** Walk the whole vendor lifecycle as a real vendor would meet it. Do it on staging
first, then on dark production. The rehearsal passes only when a full pass needs **zero manual DB
intervention** (§"What counts as manual DB intervention"). Every expected state below was derived
from the code at `374043ff` and the governing specs. It was not written from memory. Where a spec
and the code disagreed, the code won here. AECI-1108 corrected those docs on 2026-09-23, and split
the one UX gap it found into AECI-1109 (step 14b). AECI-1109 is now fixed.

**Shape.** Modelled on `STAGE_2_DEMO_TEST_PLAN.md`: blockers first, environment caveats second,
then the numbered script. Each script row carries the surface, the action, the expected state,
the evidence to capture, and the vendor-guide page that should explain the step to a real vendor.

---

## Preconditions

Check every box before a sitting starts. A box you cannot tick is a blocker, not a caveat.

### Both environments

- [ ] **Three browser identities, each in its own browser profile.** A site admin gets
      `403 FORBIDDEN` on `/vendor` (`authz.ts`, "Vendor admin role required"), so the admin and the
      vendor can never be the same account. You need:

      | Identity | Role at start | Used for |
      |---|---|---|
      | **Admin** | `profiles.role = 'admin'` in that environment's D1 | steps 3–5, 12, 16 |
      | **Claimant** | no `profiles` row, or a plain `reviewer` row | steps 1, 6–15 |
      | **Colleague** | no `vendor_id` on any vendor | step 14 |

      All three need a mailbox you can read during the sitting. All environments share one Supabase
      auth project (ADR 0017), so an address used on staging is already an auth user on production.
      The identity outcome at step 4 will then read `linked`, not `invited`. Both are a pass.
- [ ] **The admin session is live.** Sign in as Admin and load `/admin/claims`. A 404 page here
      means the account is not an admin in this environment's D1. Fixing that is a precondition
      for the sitting, done before it starts, and it is not part of the run.
- [ ] **Claimant and Colleague are not admins and not seated.** Check each on `/admin/users/:id`.
      The page shows role and vendor. Do not use `wrangler d1` to check.
- [ ] **The deployed SHA is known.** Record `/api/version` **and** `/_version` in the run log. Two
      endpoints, because `/api/version` alone cannot catch a stale SSR deploy.
- [ ] **DevTools is open on the Claimant profile** with the Network panel filtered to `updates`
      and "Preserve log" on. Step 10 depends on it.

### Staging (`https://staging.aecintegrations.com`)

- [ ] **Cloudflare Access lets all three identities through** (`docs/access.md`). Access sits in
      front of staging for every visitor, the claimant included.
- [ ] **A test vendor pair exists in staging D1 as catalog data.** Pick two vendors, **A** and
      **B**, whose products share a **direct** integration (not connector-powered). Neither may be
      `verified`. Neither may be a pure connector vendor. Record both slugs and the pair URL in the
      run log. The pair must already exist. Creating it through the review app is a review-app
      write and fails the run.
- [ ] **A second claimant mailbox for vendor B.** Step 11c needs B seated through the same claim
      pipeline, so it can deny what A affirmed.
- [ ] **Know what staging sends.** Staging holds a live Resend key, so every email below really
      sends. Staging holds **no** `LINEAR_API_KEY` by design (`environments.md`). Expect no Linear
      issue at step 1, and expect one `stuck-request-alert` to `ADMIN_ALERT_EMAIL` about 60 minutes
      after submission. Both are correct behaviour on staging.

### Dark production (`https://www.aecintegrations.com`)

- [ ] **The input is AECI-857.** It is a product claim on `companycam`, submitted by
      `aecintegrations@gmail.com`, request id `80924132-868f-424b-a11e-e48387331e30`. Load
      `/admin/claims/80924132-868f-424b-a11e-e48387331e30`. It must show **Open**. Steps 1–2 are
      not re-run on production. The claim already exists, and its row is the evidence for them.
- [ ] **Parked test claims to clear in the same sitting.** AECI-855 (Procore Project Management)
      and AECI-856 (Oracle Textura) are production claims by `aecintegrations@gmail.com`. Reject
      both in production's `/admin/claims/:id` (close-out C4). Each reject sends a real
      `Your claim for {name} was not approved` email to that mailbox. **AECI-923 (Autodesk) is a
      demo claim**, not production: its admin link is `demo.aecintegrations.com`. Reject it in
      demo's admin.
- [ ] **Steps 11a–11e do not run on production.** No attestation is written on a real pair. Steps
      12b and 12c still prove the AECI-623 gate on production, with a request that writes nothing
      (see step 12b).
- [ ] **Accept the public exposure, or stop.** Production is dark, but the approve at step 4 is
      live. The table below lists what a real visitor can see during the sitting and what undoes
      it. Close-out (§"Close-out") must leave every row reverted.

      | Step | What becomes public | Undone by |
      |---|---|---|
      | 4 approve, 12c set | "Active on AECi" on the CompanyCam vendor page (SSR, on the next request after the purge). The badge no longer renders on the product or pair pages (AECI-1131). | C1 entitlement clear |
      | 4 approve, 12c set | the Algolia vendor record's `verified` field, **only if** the 08:00 UTC sync runs while verified — it is not rendered on any search card (AECI-1131) | C1 clear, then the next 08:00 UTC sync |

- [ ] **The production sitting ends before 08:00 UTC,** C1 included. Then the search index never
      sees CompanyCam as verified. Start early enough to finish. If the clock runs short, run C1
      and C3 first and stop.

---

## What counts as manual DB intervention

The Stage 2.1 exit gate is "zero manual DB intervention". For this script that means **any** of the
following, at any step, **fails the run**. That includes a read taken only to confirm a state.

| Counts as intervention | Why |
|---|---|
| Any `wrangler d1 execute` or `wrangler d1 migrations` against the environment, read or write | The rehearsal proves an operator can run the lifecycle from the product. A state provable only by SQL is a missing admin surface. |
| Any review-app write: the `aeci-review` MCP `create_*`, `update_*`, `delete_*`, `add_attestation` or `promote_*` tools, or the review app's own UI | Catalog shape is an input, not something the rehearsal may adjust mid-run. |
| Any `apps/datatool` action against the environment | It writes D1 directly. |
| Editing a user in the Supabase dashboard, or any GoTrue admin call made by hand | The claim pipeline owns identity resolution (step 4). |
| A manual Algolia push, reindex, or record edit | The label must reach search through the 08:00 UTC sync (step 13b). |
| Triggering a cron by hand | The run waits for the schedule. |

**Allowed:** the admin console, the vendor portal, the public site, reading email, DevTools on the
tester's own browser (including the cookie edit at step 15), Linear status changes, and the
PostHog read surface.

**If a step cannot proceed without intervention,** stop. Record the step as ❌ with the reason.
File the gap as a §3.2 refinement issue. Do not intervene and carry on: that pass no longer counts.

---

## Environment caveats — things a sitting cannot tell you

| Caveat | Consequence |
|---|---|
| **`/preview/vendor-dashboard` is not the portal.** It runs on a fixture API that never returns `ENTITLEMENT_REQUIRED` and never polls. It is blocked on production and demo. | Use it for a surface pass before a sitting, never as evidence for steps 10 or 12. |
| **Search updates once a day.** The Algolia sync runs at 08:00 UTC and reads `vendors.updated_at`. | The search half of step 13 is a next-morning check. The SSR half is immediate. |
| **Native caching is live on staging, off on production.** | On staging, confirm step 13a after the purge by checking the `Cache-Tag` response header. On production every request is a fresh render. |
| **The profile-ensure failure path cannot be induced without intervention.** | Step 8 checks the happy path only. The failure copy is covered by `login.component.spec.ts` (AECI-770). |
| **The expiry sweep runs at 11:00 UTC** and warns when a term ends within 30 days. | A term set at step 12 with an end date inside 30 days sends real warning mail at the next 11:00 UTC. Set far terms. |
| **The attestation detector sweep runs at 10:00 UTC.** | It nudges a silent counterparty after 14 days and an open conflict after 7. A same-day sitting triggers neither. |

---

## The script

Column key: **Surface** is the screen and its URL pattern, then the API call behind it. **Expected**
quotes the exact error code, email subject or UI string where one exists. **Evidence** is what goes
in the run log. **Guide** is the AECI-1104 vendor-guide page that should explain the step. The
slugs are provisional until AECI-1104 lands; see §"Vendor-guide mapping".

Every error body has the shape `{ error: { code, message, field?, details? }, trace_id }`.

### Part 1 — Claim to seat

| # | Surface | Action | Expected | Evidence | Guide |
|---|---|---|---|---|---|
| 1 | **Claimant.** `/vendors/:slug/claim` (or `/products/:slug/claim`). Calls `POST /api/requests/claim`. No session needed. | Submit name, email, role, a body of at least 20 characters, and optionally a LinkedIn URL. | `201` with `message: "Your claim has been received. We will review it and follow up by email."` The page shows "Submission received". **The claimant gets no email.** Support gets `[AECi] New vendor claim: {target}`. On staging that email reads "Linear issue: not created yet, the reconciliation sweep will retry". On production a Linear issue `Claim: {name} ({vendor\|product})` lands in Vendor Requests. A second claim on the same target is **not** refused: it returns `201` and records a duplicate pointer. | 201 response body. Screenshot of the confirmation. The support email. On production, the Linear issue id. | [claiming-your-listing] |
| 2 | **Admin.** `/admin/claims` then `/admin/claims/:id`. Calls `GET /api/admin/claims/:id`. | Open the claim. Read the two identity signals. | "Email domain" shows Domain matches, Domain mismatch, Manual review, or Domain check pending. It was computed at submit. A freemail address such as `gmail.com` shows **Domain mismatch**, not Manual review. "Claimant account" shows "Existing account: approve links it" or "No account: approve provisions one". Reading the detail writes no audit row. | Screenshot of the detail, both signals visible. | [claiming-your-listing] |
| 3 | **Admin.** `/admin/claims/:id`. Calls `PATCH /api/admin/claims/:id/notes`. | Write an operator note of the form "Rehearsal run N, step 3". Save. | `200`. The note persists on reload. The Audit trail gains `vendor_claim.note_updated`. A pure-connector vendor with no owned integrations shows "Pure connector vendor — do not Grant or Reject". Stop if you see it, because the test vendor is wrong. | Screenshot after reload. | none: operator-only |
| 4 | **Admin.** `/admin/claims/:id`, "Grant vendor account" then "Confirm grant". Calls `PATCH /api/admin/claims/:id` with `{ action: "approve" }`. | Approve. | `200` with `identity_outcome` of `linked` or `invited`, `verified: true`, `tier: "verified"`, `entitlement_created: true`. One batch writes: the seat, `vendor_requests.status = 'resolved'`, the workflow transition, and a `verified` entitlement with the `vendors.verified` flip. Audit rows are `vendor_claim.granted` and `vendor_entitlement.granted`. Cache purge covers `vendor:{slug}`, each owned `product:{slug}`, and `index:products`. Failures to recognise: `409 GRANT_CONFLICT` (`details.reason` is `already_admin` or `other_vendor`), `503 DEPENDENCY_FAILURE` (no service-role key), and `422 INVALID_STATE_TRANSITION` (already rejected). Approving again is a `200` that writes nothing. | The PATCH response. The claim now shows under **Approved**. | [claiming-your-listing] |
| 5 | **Admin.** `/admin/vendors/:id`. | Open the vendor. Read seats, entitlement, and audit. | The seat list shows the Claimant as seat owner. The entitlement panel shows **Active**, tier `verified`. The Audit tab shows both step-4 rows. The approve is the seat grant: there is no separate grant step. | Screenshot of seats plus entitlement. | [your-seat] |
| 6 | **Claimant's mailbox.** | Open the decision email. | Subject is exactly `Your claim for {name} is approved`, where `{name}` is the **product** name for a product claim and the company name for a vendor claim. Sender is `AEC Integrations <notifications@aecintegrations.com>`. The CTA "Go to your vendor portal" links to `{PUBLIC_SITE_URL}/vendor`. The sign-in copy differs between `invited` and `linked`. | Screenshot of the email with headers. Record the CTA's host. It must be the environment under test. | [claiming-your-listing] |
| 7 | **Claimant**, signed out. Click the CTA, which goes to `/vendor`, then to `/auth/login?return=/vendor`. | Request a magic link. Open it from the mailbox. | `/vendor` answers `303` to `/auth/login?return=/vendor`. The page shows "Check your email". The link email's subject is `Sign in to AEC Integrations` (Supabase template). The link opens `/auth/callback?return=/vendor&method=magic_link`. | The 303 in the Network panel. The magic-link email subject. | [your-seat] |
| 8 | **Claimant.** `GET /auth/callback`, which calls `POST /api/auth/profile/ensure`. | None: this observes the callback. | Ensure is insert-if-missing, so it keeps the `vendor_admin` row step 4 wrote. It retries up to 3 times on a 5xx. Success is `303` to the return path. **Fail condition:** the browser lands on `/auth/login?error=profile_unavailable` with "We couldn't finish setting up your account, so you're not signed in yet." That is an AECI-770 regression. Then call `GET /api/account` once in the browser: it must return `200` with role `vendor_admin`, not `503 PROFILE_UNAVAILABLE`. | The callback 303 chain. The `GET /api/account` body. | [your-seat] |
| 9 | **Claimant.** `/vendor`, which goes to `/vendor/:slug/overview`. Calls `GET /api/vendor/me`. | Tour the tabs: overview, profile, products, messages, seats, and one product's integrations tab. | `/vendor/me` returns `200` with `entitlement.tier: "verified"` and all eight capabilities. The plan panel shows the active state and the "Active on AECi" badge (`portal` variant, no link). No tab 404s. A wrong `:vendorSlug` renders the 404 page, not a stack trace. | `/vendor/me` body. Screenshot of overview. | [your-seat] |

### Part 2 — Portal behaviour

| # | Surface | Action | Expected | Evidence | Guide |
|---|---|---|---|---|---|
| 10a | **Claimant.** Any `/vendor/:slug/*` page. Calls `GET /api/vendor/updates`. | Keep the tab focused for 2 minutes. | The first poll fires right after render and only records a baseline. Later polls come **20 s** apart. The response header is `Cache-Control: private, no-store`. The body is `{ revisions: { profile, entitlement, products, integrations, notifications, requests, contests }, server_time }`. | Network panel screenshot with timestamps. | [your-seat] |
| 10b | Same. | Undock DevTools and click into another window for 3 minutes. | The gap becomes **60 s**. `document.hasFocus()` decides the interval each time the next poll is scheduled. | Timestamps. | [your-seat] |
| 10c | Same. | Switch to another browser tab for 2 minutes, then back. | **No** requests while hidden. **One** request fires immediately on return. | Timestamps across the gap. | [your-seat] |
| 10d | **Admin** changes something this vendor can see, for example the entitlement at step 12a. | Watch the Claimant tab without reloading. | Within one interval the moved cursor triggers a refetch. `entitlement` and `profile` both refetch `/api/vendor/me`. The screen updates without a reload. | Before and after screenshots, no reload in between. | [your-seat] |
| 11a | **Staging only.** **Claimant (A).** `/vendor/:slug/products/:productSlug/integrations`. Calls `POST /api/vendor/claims` or `PUT /api/vendor/claims/:claimId/attestation`. | Affirm one data flow on the chosen pair. | `2xx` echoing `agreement: "single_source"`. The public pair page `/products/:contextSlug/integrations/:otherSlug` shows **"Confirmed by {vendor}"**, with aria-label "…The other vendor has not responded." The listing flips from "Maintained by AEC Integrations" to "Vendor-maintained · Updated {date}". Audit rows are `attestation.created`, plus `claim.created` if the flow was new, plus `integration.updated` (`reason: maintenance-marker`). Cache purge covers `pair:{min}__{max}` and both `product:` tags. The announcer says "{dataObject} · you confirmed this flow." | Response. Pair-page screenshot. Portal screenshot. | [attesting-an-integration], [owning-an-integration] |
| 11b | **Staging only.** Repeat steps 1–9 for **vendor B**, from the second claimant mailbox. | Seat B through the same pipeline. | As steps 1–9. | Abbreviated: the step-4 response and the step-9 `/vendor/me` body. | as 1–9 |
| 11c | **Staging only.** **Claimant (B)**, same pair from B's side. | Deny the flow A affirmed. | `2xx` echoing `agreement: "conflict"`. The pair page shows **"Vendors disagree"**, the only red state, with a ✕. The portal shows "You and {other} describe this flow differently." The announcer says "{dataObject} · you denied this flow." | Response. Pair-page screenshot. Both portals. | [attesting-an-integration] |
| 11d | **Staging only.** **Claimant (B).** | Retract B's denial, then affirm. | Retract (`DELETE …/attestation`) returns `204` and the state goes back to `single_source`. The announcer says "Position withdrawn." Affirm returns `agreement: "confirmed"`, and the pair page shows **"Both vendors confirmed"**. | Responses. Pair-page screenshot. | [attesting-an-integration] |
| 11e | **Staging only.** **Claimant (B)**, then **Admin** at `/admin/vendors/:id` for B. | B retracts its affirm. Then Admin clears B's entitlement and revokes B's seat (the paths of 12a and 16a). | The retract returns `204` and the pair goes back to `single_source`. Revoking a seat retracts nothing, which is why B retracts first. B's portal then renders the 404 page. | Responses. Pair-page screenshot. | [your-seat] |
| 12a | **Admin.** `/admin/vendors/:id`, "Clear entitlement" then "Confirm clear". Calls `PATCH /api/admin/vendors/:id/entitlement` with `{ action: "clear" }`. | Clear A's entitlement. | `200`. The admin screen says "Entitlement cleared for {name}. Portal access continues, read-only. Search results update within a day." Status becomes `revoked` and `vendors.verified` becomes false. Audit row `vendor_entitlement.cleared` carries `seats_untouched: true`. Cache purge covers `vendor:`, each `product:`, and `index:products`. Within one poll the Claimant's plan panel shows the lapsed state: "What is paused: the public account label, editing your profile and products, confirming, denying or clearing data flows on your integrations, and managing the integrations you own that are delivered through a connector." The integrations page shows the read-only notice: "You can review everything on record here. Confirming data flows and adding new ones opens up with active vendor access…" | Admin response. Claimant screen before and after, no reload. | [plans-and-the-account-label] |
| 12b | **Claimant (A)**, DevTools console on any `/vendor` page. Read a `claim_id` on a direct, live integration from `GET /api/vendor/integrations`. Then send `PUT /api/vendor/claims/:claimId/attestation` with the body `{}`. | Attempt an attestation write while unentitled. | **`403 ENTITLEMENT_REQUIRED`**, `details: { capability: "attestation.author", tier: "unclaimed" }`, message "This action requires an active Verified plan. Contact AEC Integrations to activate or renew it." This is the AECI-623 gate. The capability check runs before the body is parsed, so the empty body writes nothing. That makes this safe on production. The ordinary UI hides the write controls, so a hand-sent request is the only way to reach the 403. A connector-powered edge answers `403 FORBIDDEN` first: pick a direct one. | The 403 body. | [plans-and-the-account-label] |
| 12c | **Admin.** "Grant entitlement" then "Confirm grant". `{ action: "set" }`, with a `period_end` more than 30 days out. | Set it again. | `200`. The admin screen says "Entitlement granted for {name}. Search results update within a day." `vendors.verified` becomes true, with audit `vendor_entitlement.set`. The Claimant's controls unlock within one poll, no reload. Sending the step-12b request again now returns **`400 VALIDATION_FAILED`**. The gate passed, and the empty body was refused, so nothing is written. On staging, also affirm a flow in the UI and expect `2xx`. `set` on an already-active entitlement is `422 INVALID_STATE_TRANSITION`. | Admin response. The `400` body. On staging, the `2xx`. | [plans-and-the-account-label] |
| 12d | **Admin.** "Renew term" then "Confirm renewal". `{ action: "renew" }`. | Renew. | `200`, audit `vendor_entitlement.renewed`. **No** `vendors` write and **no** cache purge. The Claimant's `entitlement` revision still moves and `/vendor/me` refetches. `renew` on an inactive entitlement is `422 INVALID_STATE_TRANSITION`. Renew and clear send **no** email. | Admin response. The `updates` response showing the moved `entitlement` revision. | [plans-and-the-account-label] |
| 13a | **Anonymous visitor.** `/vendors/:slug`, `/products/:slug`, and one of A's pair pages (the step-11 pair on staging). | Load each while A is entitled. | The vendor page shows **"Active on AECi"**, followed by a visible "What this means" link to [plans-and-the-account-label]. The product page and both pair-page rails show **no label** (AECI-1131 removed it there — a reader comparing products gains nothing from a vendor's plan state). No surface says "Verified". | Three screenshots. On staging, the `Cache-Tag` header. | [plans-and-the-account-label] |
| 13b | **Anonymous visitor.** `/search`, vendor results. **Next morning, after 08:00 UTC.** | Search for A by name. | **No label on the vendor card, by design (AECI-1131).** The Algolia vendor record still carries `verified`, but nothing renders it. Product records never carried the label. | Screenshot. | [plans-and-the-account-label] |

### Part 3 — Seats and sessions

| # | Surface | Action | Expected | Evidence | Guide |
|---|---|---|---|---|---|
| 14a | **Claimant (A).** `/vendor/:slug/seats`, "Invite". Calls `POST /api/vendor/seats/invites` with `{ email }`. | Invite the Colleague. | `201`, audit `vendor_seat.invited`. The Colleague receives `You're invited to manage {name} on AEC Integrations`. The email states the bound address and the expiry. The CTA links to `/vendor/invite/{token}`. A second live invite to the same address is `409 GRANT_CONFLICT`. More than 10 invites per vendor in 24 h is `429 RATE_LIMITED` with `Retry-After: 86400`. A non-owner seat gets `403 FORBIDDEN` "Only a vendor account owner can manage seats". | Response. The invite email. | [your-seat] |
| 14b | **Colleague**, signed out. `/vendor/invite/:token`. Calls `GET /api/seat-invites/:token`, then `POST …/accept`. | Sign in by magic link as the invited address. Accept. | Signed out, the page bounces to login and back to the same path. The page reads "Join your team on AEC Integrations" and "Accept invite". Accepting makes the Colleague `vendor_admin` with `seat_owner = false`, audit `vendor_seat.invite_accepted`, and lands on `/vendor/:slug/overview`. Signed in as another address, the page says "This invite was sent to {email}. Sign out and sign back in with that address…" A redeemer who is an AECi admin, or already holds another vendor's seat, gets `409 GRANT_CONFLICT`. The page reads "This account can't join this team" and tells them to get the invite re-sent to a different address and sign in with it (AECI-1109). The generic "We couldn't load this invite" on a 409 is a fail. | Accept response. The overview screenshot as the Colleague. | [your-seat] |
| 15a | **Claimant (A).** DevTools, Application, Cookies, `sb-ktuhnlypztujpsseujzx-auth-token` (possibly split into `.0`, `.1`). | Decode the `base64-` value. Set `expires_at` to a past time. Re-encode and save. Close other tabs. Load `/vendor`. | **Server-side refresh (AECI-1049):** the page renders normally, with no login bounce. The response carries a rotated `Set-Cookie` and `private, no-store`. Production verified this for `/admin` and `/account` only. This row is the first `/vendor` verification. | The document response headers. | [your-seat] |
| 15b | Same cookie. | Also replace `refresh_token` with junk. Load `/vendor`. | The refresh fails. The browser probes for a live session, retries once, then goes to `/auth/login?return=/vendor/…`. The login form shows, because the SDK cleared the dead cookies. Signing in returns to the same URL. **Fail condition:** a "Page not found" render, which is the AECI-954 regression. | The redirect chain. | [your-seat] |
| 15c | **Admin**, the same technique as 15a. | Load `/admin/claims` with an expired access token. | Renders normally, with a rotated `Set-Cookie`. | Headers. | none: operator-only |
| 16a | **Admin.** `/admin/vendors/:id`, seats, remove the Colleague. Calls `DELETE /api/admin/vendors/:id/seats/:userId`. | Revoke the Colleague's seat. | `204`. The profile returns to `role = 'reviewer'`, `vendor_id = null`, `seat_owner = 0`, audit `vendor_claim.seat_revoked`. `vendors.verified` is untouched. The Colleague's next `/api/vendor/*` call is `403 FORBIDDEN` "Vendor admin role required", and `/vendor` renders the 404 page "We couldn't find that page." | Response. The Colleague's 404 screenshot. | [your-seat] |
| 16b | **Claimant (A).** `/vendor/:slug/seats`. Calls `DELETE /api/vendor/seats/:userId`. | Re-invite and re-accept the Colleague as in step 14, then remove them from the vendor side. Then try to remove yourself. | Removing the Colleague returns `204`, with audit source `vendor-portal`. Removing yourself is **`422 FORBIDDEN`** "You cannot remove your own seat". | Both responses. | [your-seat] |

### Close-out

Run these before the sitting ends. On production they are mandatory, not tidy-up.

| # | Action | Expected |
|---|---|---|
| C1 | Admin clears A's entitlement (as 12a). **Production:** in the sitting, before 08:00 UTC. **Staging:** the next morning, after step 13b has seen the label. | Status `revoked`, `vendors.verified` false, public label gone on the next request. |
| C2 | **Staging only.** Claimant (A) retracts every attestation written in steps 11 and 12c. | Each `DELETE` returns `204`. The pair returns to `unverified`, and "Maintained by AEC Integrations" returns. `last_reviewed_at` stays by design. |
| C3 | Admin revokes every seat on A (and B on staging) through `/admin/vendors/:id`. | As 16a. The **last** revoke also hands the record back (AECI-989, `STAGE_2_ATTESTATIONS_SPEC.md` §13.9). The vendor and each product it owns alone read "Maintained by AEC Integrations" again, with `last_reviewed_at` kept. Every live integration it claimed has `claimed_at` NULL, so promote writes it again. Its open owner contests sit in `/admin/contests`. Claims and attestations remain. The vendor is inert again. |
| C4 | **Production:** reject AECI-855 and AECI-856 in `/admin/claims/:id`, then cancel their Linear issues. Reject AECI-923 in **demo's** admin, then cancel its issue. Close AECI-857's Linear issue with a pointer to this run. | Each reject returns `200` and sends `Your claim for {name} was not approved` to the submitter. The `reason` goes to the audit log only. |
| C5 | The morning after C1, after 08:00 UTC, load `/search` on both environments. | No vendor card shows the label. On staging this proves the clear reached search. |

---

## Screen-reader pass (AECI-633)

Run at the end of the **staging** sitting, while A is still seated and entitled (after step 13a,
before C1). AECI-633 was on hold. AECI-1103 schedules it here.

**Method.** Use the scripted walkthroughs in `a11y-manual-testing-checklist.md` **§6 (VoiceOver,
Safari)** and **§7 (NVDA, Firefox then Chrome)**: the key conventions, the "expected announcement"
format, and the ✅/❌ marking. Those tables cover public surfaces. The vendor-portal checks below
come from AECI-633 and use the same format. Run them with live sync **running**. They depend on
`STAGE_2_REALTIME_SPEC.md` §6.3: one announcer channel for anything the user did not just do.

| # | Surface | Action | Expected | VO | NVDA |
|---|---|---|---|---|---|
| SR1 | `/vendor/:slug/profile`, mid-edit | Admin changes something on another tab | No interruption. The section offers "Updated elsewhere — reload this section". | ☐ | ☐ |
| SR2 | Any portal page | Admin runs 12a, then 12c | Each flip is announced once, comprehensibly. Focus does not move. | ☐ | ☐ |
| SR3 | Integrations page | Affirm, deny, retract | Each is announced exactly once. No doubled utterance from a local region. | ☐ | ☐ |
| SR4 | Integrations page | Retract twice in a row | Both are announced. This tests the U+00A0 re-announce in `vendor-announcer.ts` against real AT. | ☐ | ☐ |
| SR5 | Add-claim form, profile form, product form | Trigger the duplicate notice or a save as a poll lands | Each reads sensibly with no collision. | ☐ | ☐ |
| SR6 | Any portal page | Watch during a revalidation | Nothing reflows under the pointer or the focus ring. | ☐ | ☐ |

**Record** a dated entry in `ACCESSIBILITY_AUDIT.md` with the AT and browser versions, and add a row
to `a11y-manual-testing-checklist.md` §4. File every ❌ against AECI-633.

---

## Vendor-guide mapping

AECI-1104 built the six pages under `/docs/vendors/*`, and every slug below is the built one
(`apps/web/src/app/docs/docs-content.ts`). Each link points at the production URL, which renders once this deploys. The pages stay
noindex and unlinked from the site until AECI-1105 opens the portal. Page 6 names
the "Active on AECi" label (AECI-965 retired "Verified badge"; AECI-1131 relabeled it from
"Vendor account active"/"Account active").

| AECI-1104 page | Slug | Steps |
|---|---|---|
| 1. Claiming your vendor listing | [claiming-your-listing] | 1, 2, 4, 6 |
| 2. Your seat | [your-seat] | 5, 7–10, 11e, 14–16 |
| 3. Attesting an integration | [attesting-an-integration] | 11a–11d |
| 4. Owning an integration | [owning-an-integration] | 11a (the maintenance marker) |
| 5. Contests and protests | [contests-and-protests] | **none.** This lifecycle has no field contest. The page gets no proof from this script. |
| 6. Plans and the account label | [plans-and-the-account-label] | 12a–13b |

[claiming-your-listing]: https://www.aecintegrations.com/docs/vendors/claiming-your-listing
[your-seat]: https://www.aecintegrations.com/docs/vendors/your-seat
[attesting-an-integration]: https://www.aecintegrations.com/docs/vendors/attesting-an-integration
[owning-an-integration]: https://www.aecintegrations.com/docs/vendors/owning-an-integration
[contests-and-protests]: https://www.aecintegrations.com/docs/vendors/contests-and-protests
[plans-and-the-account-label]: https://www.aecintegrations.com/docs/vendors/plans-and-the-account-label

---

## Section pointers

The cadence contract is `STAGE_2_REALTIME_SPEC.md` §4.1. §6 is what the
screen shows. The agreement states are `STAGE_2_ATTESTATIONS_SPEC.md` §4.2. §5 is the authoring API.

---

## Recording findings

- Mark each row ✅ or ❌ in the run's copy. A ❌ needs what happened, the response or screenshot,
  and the Linear issue.
- File every defect as a §3.2 refinement issue in the Stage 2.1 project. Put the step number in
  the title: `Rehearsal step 12b: …`. Add it to `STAGE_2_1_SPEC.md` §3.2's findings table.
- A **missing capability**, not a defect in a built one, goes to 2.5/3 triage (`STAGE_2_1_SPEC.md`
  §4). It is not built in 2.1.
- Put evidence on a comment on AECI-1103, one comment per sitting. Link that comment from the
  run row below.

## Runs

A run passes only when every row is ✅ and no intervention was needed. Both environments must pass
for the §5 gate.

| Date | Env | Web SHA / API SHA | Tester | Steps ✅ / total | Intervention | Result | Evidence | Refinement issues |
|---|---|---|---|---|---|---|---|---|
