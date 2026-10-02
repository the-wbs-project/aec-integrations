# Vendor plan data-readiness audit

- **Commit reviewed:** `2380b3675dfa79e8151117ce7428066ffcd3bc8c` (equal to `origin/main`)
- **Date:** 2026-09-30. **Revised 2026-10-01** to fold in a separate Cloudflare traffic
  investigation (see "Cloudflare edge data" below).
- **Production at audit time:** `d269cf71`, deployed 2026-09-25 02:15 UTC (from `GET /_version`).
  Production is 12 commits behind `main`. That includes the AECI-1147 epic (`1ddfefbc`).
- **Method:** read-only. Code and specs on `main`. Linear issues read over GraphQL. PostHog project
  354071 (production) queried with HogQL for 2026-07-02 to 2026-09-30. Nothing was changed anywhere.
- **Status words:** _specified_ = in a spec, no code. _merged_ = in code on `main`. _deployed_ = in
  the production SHA. _observed_ = seen in production data. _edge-observed_ = seen in Cloudflare's
  own request logs for September 2026.

### Cloudflare edge data (added 2026-10-01)

A separate session on 2026-10-01 pulled Cloudflare's analytics for the `www` zone. This audit did
not re-run those pulls. Its figures are quoted from that session's handoff. Four facts change this
report:

- **Cloudflare is the only consent-independent, user-agent-level record we have.** `page_views`
  keeps only a user-agent hash and only successful renders. PostHog custom events cover about 1 in 8
  visitors. Cloudflare's per-request dataset has path, user agent, verified-bot flag, referrer and
  query string for every request. Cloudflare Web Analytics page loads are already on our pages, keep
  paths for 184 days, and need no consent. They are a candidate source for Insights view counts.
- **That record expires.** Per-request detail is kept 31 days on Pro. The zone moves to Enterprise
  the week of 2026-10-05, which raises it to 90 days. Logpush is self-service on Pro, about 1 to 2 GB
  a month for us, and captures only from the day it starts.
- **A one-off backup exists.** Thirty-one days of hourly requests, daily rollups since 2026-04-08
  and six months of Web Analytics page loads are in R2 bucket `aeci-views-temp` on The WBS Project
  account, prefix `cloudflare-backfill-2026-10-01/`. It is the only copy. The pull scripts sit on
  the unmerged branch `chris-walton-wbs/cloudflare-pay-per-use-investigate`.
- **AI assistants are a real, measurable audience.** September had about 790 verified on-demand
  assistant fetches and 51 ChatGPT-referred visits. Our own data shows almost none of it (items 13
  and 11d).

### Decisions and issues filed (added 2026-10-01)

Chris reviewed this report on 2026-10-01. These rulings supersede the matching findings below.

- **Free plan is a deliberate state of the existing portal.** Plans and checklists live at the
  product level. Epic AECI-1212.
- **Company details are editable on every plan.** So are product description, website, logo and
  categories, the four `listing_tier` ranking inputs. Section 5 coupling 1 is resolved by this.
- **Data-flow confirmation stays a Managed feature.** Free vendors cannot create vendor agreement.
  Section 5 coupling 2 stands as a deliberate positioning choice.
- **"Looked and changed nothing" counts as a pilot step.** The "Looks right" action records it
  (AECI-1216). A Free product's checklist is finishable without data flows.
- **Nothing beyond Managed is shown in the portal yet.**

| Report item or gap | Filed as |
| ------------------ | -------- |
| Item 2, G10 first-response time | AECI-1195 (Stage 2.5) |
| Item 6 vendor replies to reviews | Epic AECI-1173 |
| Item 7, G9 search-engine submission log | Epic AECI-1182 |
| Item 8, G8 change receipts and override reasons | Epic AECI-1190 |
| Item 9, G7 notification control and send records | Epic AECI-1197 |
| Items 24 and 3/5, G3 Free plan, checklists, "Looks right" | Epic AECI-1212 |
| Item 25, G2 usage tracking | Epic AECI-1207 |
| G0 permanent Cloudflare request log | Epic AECI-1196 (Stage 2.5) |

This is a point-in-time report for a commercial decision. It is not a spec. It does not govern any
code. The drafted plan model (Free, Managed, Insights, Enhanced, per product) is not approved.

## 1. Answer first

The application can support the **seat-only and Managed edit features** today. It cannot yet
support **per-product plans, billing, Insights reporting, Enhanced content or leads**.

- **Edit history is good.** Every vendor edit, claim, contest and attestation writes an
  `audit_log` row with actor, time, and before/after state in the same batch as the change.
- **Plans are per vendor, with one paid tier.** `vendor_entitlements` is unique on `vendor_id`.
  The only paid tier is `verified`, and it holds all eight capabilities, including `analytics.view`.
  (Ten since AECI-1214, which also gave `unclaimed` the three Free capabilities.)
  There is no billing identity, no discount field and no automatic lapse.
- **Insights has no data path.** `integration_viewed` has not fired since 2026-07-02. No event
  carries a vendor id. No vendor self-visit flag exists. The performance endpoint is not built.
- **Production analytics are thin.** About 90% of `product_viewed` events are the operator. Only
  about 12% of other browsers fall inside the consented slice. No vendor has ever been seen in
  PostHog.
- **The pilot can be measured only partly.** Three of the five review steps leave a trace. A
  vendor who looks and changes nothing leaves none. Return visits are not recorded.
- **The best traffic record is Cloudflare's, and it expires.** It sees AI-assistant fetches and
  ChatGPT referrals that `page_views` and PostHog miss. Nothing stores it past 31 days (90 after the
  Enterprise move). Logpush (AECI-1169) should start before the pilot.
- **Enhanced and leads are greenfield.** There is no media, testimonial, question or lead model.
- **No ranking leak was found.** No sort key or Algolia ranking setting reads plan state. There are
  four indirect couplings to rule on (section 5).

## 2. Feature table

Tiers: **F** = Free listing and seat, **M** = Managed, **I** = Insights, **E** = Enhanced,
**B** = billing and entitlements, **P** = pilot measurement, **R** = referral and compatibility.

| #   | Tier | Data needed                                                                    | Status                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                          | Gap                                                                                                                                                                                                                                                                                 |
| --- | ---- | ------------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | F    | Claim, link and contest with no plan. Who did it, when                         | Captured (merged, deployed)                         | Audit actions `integration.claimed`, `integration.link_set`, `integration.contest.submitted`, `integration.created`. Routes `vendor-integration-claims.ts`, `vendor-integration-links.ts`, `vendor-contests.ts`                                                                                                                                                                                                                    | Claim, edit, retire and restore on a **connector-powered** integration need a plan since AECI-1089 (`lib/integration-entitlement.ts:48`). The help page says so. Marketing copy must match. Audit rows do not record the plan held at the time                                      |
| 2   | F    | Inbound correction with timestamp, requester, plan, first response             | Partial                                             | `vendor_requests` (`kind='correction'`, `created_at`, `resolved_at`, `status`, `linear_issue_id`). Linear webhook syncs status (`routes/webhooks.ts:68-75`)                                                                                                                                                                                                                                                                        | Public form, email only. No seat or plan on the row. No first-response time. A 14-day vs 48-hour target cannot be measured                                                                                                                                                         |
| 3   | M    | Per-field before/after, actor, time, product id. Product-scoped access         | History captured. Product scope missing             | `vendor.updated`, `product.updated`, `integration.updated` audit rows with `before_state`/`after_state` (`routes/vendor.ts:835-1060`, `vendor-integration-edits.ts:252-273`)                                                                                                                                                                                                                                                      | History is JSON in `audit_log`, not a field table. Seats and plans are vendor-wide. Any co-owner in `product_vendors` can edit a product                                                                                                                                             |
| 4   | M    | Attestation history and actor per integration and product                      | Captured                                            | `claims`, `attestations` (`asserted`, `attested_by_vendor_id`, `retracted_at`). Audit `attestation.created`, `attestation.retracted`, `claim.created`                                                                                                                                                                                                                                                                              | Person is only on the audit row. Product id is not in audit metadata and must be derived. Orientation swaps (AECI-920) make that ambiguous                                                                                                                                          |
| 5   | M    | Which actions are plan-gated and how                                           | Captured                                            | `requireCapability()` (`lib/authz.ts:485`) for profile, product, taxonomy, usefulness, attestation and version writes. `hasActiveEntitlement()` for connector-powered owner writes, and since AECI-1186 for a vendor write's IndexNow and Google worklist buffering. `canViewVersionDiff()` for public version-diff depth                                                                                                                                                                                           | Every gate reads one vendor-wide tier. `analytics.view` and `profile.rich_fields` have no consumer                                                                                                                                                                                  |
| 6   | M    | Vendor reply to a review, with author and moderation state                     | Missing (not specified)                             | `reviews` table has moderation fields (`schema.ts:1146-1210`). No reply column, table, route or spec                                                                                                                                                                                                                                                                                                                              | New table, capability, moderation queue and public render                                                                                                                                                                                                                           |
| 7   | M    | URLs changed by an edit, and a submission log                                  | Partial                                             | `afterVendorWrite()` derives URLs per edit (`routes/vendor-recrawl.ts`) into `indexnow_queue`. Daily drain writes one `indexnow.drained` audit row with counts                                                                                                                                                                                                                                                                   | Drain deletes sent rows. No per-URL log of what was sent, when, with what status, or which edit caused it. AECI-1160 ruled IndexNow is a Managed benefit                                                                                                                              |
| 8   | M    | Per-vendor receipt of edits and admin overrides, with reason                   | Partial                                             | Reason required on admin retire/restore and protest decisions. Optional on entitlement changes, claim decisions. As built 2026-10-02 (AECI-1191): now required on admin logo overwrite, seat revoke and a contest accept that changes a vendor-held value                                                                                                                                                                                                                                                                                                  | ~~No reason on admin logo overwrite or seat revoke.~~ Fixed by AECI-1191. Admin rows do not carry `vendorId` consistently. Retire reason stays internal (AECI-1159). No receipt view                                                                                                                         |
| 9   | M    | Alerts sent, delivery, portal read, action that followed                       | Partial. Built and wired in all envs                | Daily sweep `0 10 * * *` in staging, demo and production crons. `notification.sent` audit rows (`lib/attestation-notify.ts:162-189`). Portal feed `GET /api/vendor/notifications`                                                                                                                                                                                                                                                 | Resend message id not stored. No bounce or delivery webhook. No read state in the portal. No link from a notification to a later action. "Led to action" is only a time-window join                                                                                                 |
| 10  | M    | Request arrival and first AECi response                                        | Partial                                             | `created_at` on requests and contests. `in_review` transition when Linear moves to Started                                                                                                                                                                                                                                                                                                                                        | "Started" is not a reply. Replies go by email outside the app. No `first_response_at`                                                                                                                                                                                               |
| 11a | I    | Product views with product id and vendor id                                    | Partial                                             | PostHog `product_viewed {product_id, source}`: 306 in 90 days, 90% operator (observed). D1 `page_views.product_id` on SSR arrivals only                                                                                                                                                                                                                                                                                           | No vendor id. SPA hops leave D1 `product_id` NULL. Pre-2026-09-24 operator traffic is not tagged `is_internal`                                                                                                                                                                      |
| 11b | I    | Pair views, one per pair, both orientations merged                             | Missing                                             | `integrationViewed()` exists (`analytics.ts:223`) with no caller since `ebb12474` (AECI-294). Never observed in production. Pair pages appear only as `$pageview` paths (60 in 90 days, orientation-specific)                                                                                                                                                                                                                      | No pair key on any event or `page_views` row. Specified in AECI-929 and AECI-935, not built. The new AECI-1147 detail page is portal-only and emits nothing                                                                                                                          |
| 11c | I    | Outbound clicks with link purpose and connector                                | Partial                                             | `external_link_clicked {destination, source}`: 36 in 90 days (observed). `source` is `product_detail`, `pair_detail`, `vendor_detail`, `vendor_detail_social`                                                                                                                                                                                                                                                                    | Cannot tell site from docs on pair pages. No owner vendor, pair id or connector. Specified in AECI-933, not built                                                                                                                                                                   |
| 11d | I    | Exclude bots, internal and vendor self-visits. Consent coverage                | Partial                                             | D1 `page_views.is_bot`, `client_verdict`, `is_operator`. PostHog `is_internal` since 2026-09-24. Consent: about 12% of non-operator browser starts are in a consented session (observed, 48 of 386)                                                                                                                                                                                                                                | Vendor self-visits not flagged anywhere (AECI-934). Cannot be backfilled. Every custom event is consent-only, so PostHog sees about 1 in 8 visitors. **Defect:** `bot-classification.ts` has no `Claude-User` rule, so its variants without "bot" in the user agent are stored as human. `cf_asn` has been null since 2026-09-07 (AECI-868), so nothing else catches them. Cloudflare's verified-bot flag is not stored. 403s and 404s never reach `page_views`                                                                                                                                  |
| 11e | I    | Vendor sees only own products, only on Insights or Enhanced                    | Missing                                             | `analytics.view` declared with no consumer. Gate reads one tier per vendor (`lib/authz.ts:276-311`)                                                                                                                                                                                                                                                                                                                               | No endpoint. No per-product gate. `VENDOR_PERFORMANCE_SPEC.md` puts Performance in Verified, not Insights                                                                                                                                                                          |
| 11f | I    | Spec vs build                                                                  | Specified, not built                                | `VENDOR_PERFORMANCE_SPEC.md` Epics A to C (AECI-930 family). Views tile is a placeholder: "coming soon", no server read (`vendor-views-tile.ts:73,100-111`)                                                                                                                                                                                                                                                                         | Whole reporting stack                                                                                                                                                                                                                                                               |
| 12  | I    | GSC and Bing impressions, clicks, index status per page                        | Missing (manual only)                               | GSC and Bing properties exist and are read by hand. `gsc_recrawl_queue` is a manual worklist. URLs map to entities by slug rule (`lib/public-urls.ts`, `slug_redirects`)                                                                                                                                                                                                                                                           | No API credential or stored data. AECI-949, 936, 937 specified. GSC keeps about 16 months, Bing about 6                                                                                                                                                                              |
| 13  | I    | Referrer, including AI services                                                | Partial                                             | D1 `page_views.referrer` (host) and `referrer_source`. PostHog `app_started` carries `$referring_domain` for every visitor. About 5 AI referrals in 90 days (observed). Cloudflare, September only (edge-observed): 51 visits with `utm_source=chatgpt.com`, of which only 2 sent a ChatGPT referrer. About 790 verified assistant fetches: ChatGPT-User 713, Claude-User 35, Claude desktop apps 23, DuckAssistBot 20. A further 930 spoofed assistant requests, all 403 or 404                                                                                                                                                                                                                                                               | No AI label. `utm_source` is dropped from D1, and ChatGPT arrives mostly via `utm_source=chatgpt.com`. So both our stores undercount ChatGPT referrals about tenfold. Assistant fetches are not split from crawlers. `bot_name` merges ChatGPT-User with OAI-SearchBot under `OpenAI` (AECI-762). Only Cloudflare holds the verified per-request record, for 31 days                                                                                                                       |
| 14  | I    | Vendor-scoped API or MCP credentials, product-limited, audited                 | Missing                                             | Every vendor route uses the Supabase session. `aeci-review` MCP runs on one operator bearer (`AECI_MCP_TOKEN`) with production write tools                                                                                                                                                                                                                                                                                          | No vendor credential exists. The MCP token must never go to a vendor. A vendor API needs a new token model routed through the same audit path                                                                                                                                      |
| 15  | E    | Screenshots and video with permission, review state, relevance                 | Missing                                             | R2 is used only for logos (`routes/logos.ts`, `STAGE_2_5_SPEC.md` §11)                                                                                                                                                                                                                                                                                                                                                             | New media table, R2 lifecycle and moderation queue                                                                                                                                                                                                                                  |
| 16  | E    | Testimonials with consent, editorial state, "vendor-supplied" label            | Missing                                             | `reviews` is buyer-authored only                                                                                                                                                                                                                                                                                                                                                                                                  | New table. It must not write to `reviews`, or it would feed `review_count`, a ranking signal                                                                                                                                                                                        |
| 17  | E    | Structured use cases and implementation context                                | Partial                                             | `products.usefulness` JSON of bullet groups by audience and phase, fenced by `usefulness_source` (`STAGE_2_5_SPEC.md` §12)                                                                                                                                                                                                                                                                                                         | No scenario, prerequisites, effort or example fields                                                                                                                                                                                                                                |
| 18  | B    | Per-product plan, start, term end, renewal, frequency, status incl. read-only  | Partial, vendor-level only                          | `vendor_entitlements` (`schema.ts:1328-1389`): unique `vendor_id`, `tier` (no CHECK), `status` in pending/active/expired/revoked, `period_start`/`period_end`, free-text `amount`, `terms`, `payer`, `invoice_ref`                                                                                                                                                                                                                  | No `product_id`, renewal date, frequency or auto-renew. No warning or read-only status. Authorization ignores `period_end`, so a lapsed term keeps paid access until an admin clears it                                                                                             |
| 19  | B    | Paid-product count, plan per product, stable quote order                       | Missing                                             | Products per vendor countable via `product_vendors`                                                                                                                                                                                                                                                                                                                                                                               | No per-product plan, so no paid count. No defined quote order                                                                                                                                                                                                                       |
| 20  | B    | Discount, reason, expiry                                                       | Missing                                             | Free text only in `amount`, `terms`, `notes`                                                                                                                                                                                                                                                                                                                                                                                      | The founding 20% cannot be computed, reported or expired                                                                                                                                                                                                                            |
| 21  | B    | Pilot: comp Managed 10-14, warning 11-14, read-only 12-14, seat kept, logged   | Partial                                             | 30-day expiry cron at 11:00 UTC emails and writes `vendor_entitlement.expiry_warned` (`lib/entitlement-expiry.ts`). Admin Clear keeps seats (`seats_untouched: true`)                                                                                                                                                                                                                                                              | The 11-14 warning works only if `period_end=2026-12-14` is entered. Claim approval accepts a null end, which never warns. Nothing fires on 12-14. An admin must Clear, which records `revoked` (for cause), not `expired`. Tier granted is `verified`, not Managed                  |
| 22  | B    | Stripe customer id, invoice status, paid-outside-Stripe, billing identity      | Missing                                             | Free text `payer`, `invoice_ref`. `vendors.headquarters` is display text                                                                                                                                                                                                                                                                                                                                                          | No billing account, invoice mirror, legal name, country, address or tax id. New PII must join the erasure register (`docs/AUTH_AND_RLS.md` §8)                                                                                                                                       |
| 23  | B    | Pure connector vendor vs connector vendor that manages owned integrations      | Partial, derivable                                  | `products.product_role`, `integrations.built_by_vendor_id` and `claimed_at`, `connector_catalogs.managed_by`. `STAGE_2_SPEC.md` §8.10(1)                                                                                                                                                                                                                                                                                          | The test turns on intent ("wants to manage"). No column records it. The provision-seat route computes `is_pure_connector_vendor` into audit metadata only                                                                                                                             |
| 24  | P    | Five review steps per pilot vendor                                             | Partial (3 of 5)                                    | Steps 4 and 5 captured (`integration.claimed`, owner contests, `attestations`, `claim.created`). Steps 1 and 2 captured only when the vendor edits (`vendor.updated`, `product.updated`, `last_reviewed_at`)                                                                                                                                                                                                                        | Edit schemas reject an empty save. There is no "confirm, nothing to change" action. Step 3 "integrations checked" leaves no trace                                                                                                                                                   |
| 25  | P    | Vendor sessions, unprompted returns, second team member                        | Partial                                             | Second member captured (`vendor_seat_invites`, `vendor_seat.*` audit). PostHog `identify` and `groupVendor` exist in code for consented users. Zero `/vendor` visits and zero `$groupidentify` observed in 90 days                                                                                                                                                                                                                  | No D1 login or visit log. Supabase `last_sign_in_at` is one overwritten value. Consent hides most users from PostHog. Nothing ties a return to a notification                                                                                                                        |
| 26  | R    | Pair-level views, clicks, questions per period, vs previous period             | Missing                                             | Only `page_views.concrete_path` and consented `$pageview` paths name the pair. Cloudflare saw 142 assistant fetches of pair pages in September (edge-observed)                                                                                                                                                                                                                                                                                                                                                     | Rebuildable from paths within the 400-day `page_views` retention. Assistant interest per pair exists only in Cloudflare logs, which expire. Clicks have no pair key. Questions have no table                                                                                                                                                                  |
| 27  | R    | Demand for pairs with no page                                                  | Missing                                             | `search_performed` has query, counts and `results_bucket` in code (since 2026-08-28). Only 5 events ever observed, none since 2026-09-01, none carrying the new fields. Autocomplete untracked (AECI-717). Empty pair URLs render 200 + `noindex` and still write a route-only `page_views` row                                                                                                                                      | No "request this pair" capture. AECI-343 (per-pair missing-integration CTA) is backlog. The new search payload has not been seen in production yet                                                                                                                                   |
| 28  | R    | Structured two-product question, triage, routing, separate vendor-contact consent | Missing (not specified)                          | `vendor_requests` is claim/correction on a product or vendor only. `/contact` is a `mailto:` link. Contests' `routed_to` / `owner_vendor_id` is a pattern to copy                                                                                                                                                                                                                                                                  | New `compatibility_questions` table with consent columns. Sketch in section 7                                                                                                                                                                                                       |
| 29  | R    | Lead to vendor link, qualification, invoicing in arrears                       | Missing (not specified)                             | Nothing                                                                                                                                                                                                                                                                                                                                                                                                                           | New `leads` table plus the billing tables from section 4                                                                                                                                                                                                                            |

> **Item 9, updated 2026-10-01 (epic AECI-1197, ADR 0038).** The audit row above describes `main`
> at `2380b367`. Epic AECI-1197 changes three of its facts. Each email send now writes a
> `notification_sends` row with the Resend message id (AECI-1202). The `?n=` link and portal open
> or click recording are AECI-1209, not built. No bounce or delivery webhook exists. The vendor nudge is one daily digest per
> seat, and a `notification.sent` row is written whether or not a seat was emailed, with
> `metadata.emailedSeats` (AECI-1204). Staging and demo no longer email vendors at all, because
> non-production email goes only to `thewbsproject.com` and `aecintegrations.com` (AECI-1198). The
> `attestation-notify.ts` line range in the row is out of date.

## 3. Gaps to close before the pilot starts on 2026-10-14

These are cheap, and every day without them is history we cannot rebuild. Ordered by how much
each loses per day. G0 comes first because it covers every visitor, not only the consented slice.

| #   | Gap                                                                                                                  | Why now                                                                                          | Size         | Issue                          |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------ | ------------------------------ |
| G0  | Start Logpush of zone `http_requests` to R2 on the AEC Integrations account. Until it runs, re-run the backfill pull at least every 30 days | Cloudflare's per-request record is the only consent-independent source for assistant fetches and AI referrals. Each lapsed day is gone | Small to start, medium for the store | AECI-1169 (exists) |
| G1  | Flag a vendor's own visits on `page_views` (`is_owner_visit`)                                                        | Pilot vendors will inflate their own view counts from day one. Cannot be backfilled              | Small to medium | AECI-934 (exists)              |
| G2  | Once-a-day vendor portal visit row in D1 (user, vendor, day, utm)                                                    | Only way to count return visits for vendors who decline analytics                                | Small        | New                            |
| G3  | "Confirm, nothing to change" action on vendor, product and integration, with an audit row and `last_reviewed_at`    | Pilot steps 1 to 3 are invisible when the data was already right                                 | Small        | New                            |
| G4  | Restore a pair view event with a canonical pair key and both product ids                                             | Dead for three months. It is the denominator for pair clicks                                     | Small        | AECI-935 (exists)              |
| G5  | Add link purpose, owner vendor, pair key and connector id to `external_link_clicked`                                | Every click before this ships stays unattributed                                                 | Small        | AECI-933 (exists)              |
| G6  | Store `utm_source` on `page_views` arrivals. Add a `Claude-User` rule. Split assistant fetches from crawlers. Label AI referrer hosts | `utm_source` and the raw user agent are dropped today and cannot be recovered. `Claude-User` is miscounted as human now | Small        | AECI-762 (exists) plus new     |
| G7  | Store the Resend message id on each notification. Put a notification id in email links. Record portal open or click | Needed to measure "notification led to an action" in the pilot                                   | Small        | New                            |
| G8  | Put the vendor's plan tier and status, and the product id, on every vendor audit row                                 | Makes "actions on Managed vs after lapse" and per-product receipts queryable without joins       | Small        | New                            |
| G9  | Keep a per-URL IndexNow submission log linked to the causing audit row                                               | The drain deletes URLs. Managed's SEO benefit cannot be evidenced later                          | Small        | Related AECI-944, AECI-1160    |
| G10 | Add `first_response_at` to `vendor_requests` and AECi-routed contests                                                | The free vs Managed support target cannot be measured without it                                 | Small        | New                            |
| G11 | Record each 2026-11-14 warning send as a dated audit row per vendor, and make `period_end` required on pilot grants  | AECI-1157 asks for delivery evidence. A null end never warns                                     | Small        | AECI-1157 (exists)             |
| G12 | Promote production to at least `2380b367`                                                                            | Pilot vendors would otherwise see the pre-AECI-1147 integration panel                            | Operator     | n/a                            |

> **G2 and G3, updated 2026-10-02.** **G2 is superseded by AECI-1208.** The shipped design is
> wider than the gap: `user_activity_daily` keeps one row per signed-in user per UTC day for
> every role, not vendors only, with first and last seen, the surfaces used, and the arrival
> `utm_source`, `utm_campaign` and `n` (`DATABASE_SCHEMA.md` §9.11). Admin rows let reports
> filter operator traffic out. **G3 is closed by AECI-1216**, which shipped "Looks right" on the
> vendor profile, each product, and each product's integrations, stamping `last_reviewed_at`
> with an audit row.
>
> **The per-vendor daily snapshot now exists (AECI-1210).** `vendor_activity_daily` keeps one
> row per activated vendor per UTC day: seats, live invites, active users over 1, 7 and 30 days,
> the plan, open contests owned and filed, live attestations, and products total and confirmed
> (`DATABASE_SCHEMA.md` §9.12). These stock numbers overwrite themselves, so a trend starts on
> the first 00:30 UTC run after deploy and cannot be backfilled.

> **G7, updated 2026-10-02.** The Resend message id is stored by AECI-1202
> (`notification_sends.provider_message_id`). The notification id in email links is AECI-1209:
> every site link in a transactional email carries `utm_source=email`,
> `utm_campaign=<template id>` and `n=<notification_sends.id>`, and a signed-in landing records
> them on `user_activity_daily` (`docs/email.md` §Link tagging). Still open: the cron digests and
> the Supabase sign-in email are not tagged, by decision, and a signed-out click that never signs
> in records nothing. Portal opens are counted by `user_activity_daily` surfaces. A per-link
> click record does not exist.

Also worth doing before the pilot, but not history-critical:

- Tag the operator's pre-2026-09-24 PostHog identity as internal, or exclude it at query time.
  Otherwise any historic baseline is 90% operator.
- Confirm `search_performed` fires with the full payload on the current build. The 5 observed rows
  report `results_count` of 175 or 247 regardless of query.

## 4. Schema changes for per-product entitlements and mixed plans

**Hazard first.** A drizzle-kit table recreate on D1 fires `ON DELETE CASCADE` two levels deep
(`docs/migrations.md` §0). `vendor_entitlements` cascades from `vendors` today, so a
future `vendors` recreate would delete every plan row. New billing tables must not cascade from
`vendors` or `products`. Promote retraction hard-deletes products, and billing history must survive
that. Keep enums in code, as `tier` already is.

| #   | Change                                                                                                                                                                                                                                                                                                                             | Size   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| S1  | Tier ladder in `packages/shared/src/entitlements.ts`: `unclaimed`, `managed`, `insights`, `enhanced`. Capability subsets per tier. Move `analytics.view` out of Managed. Map existing `verified` rows to `managed`                                                                                                                 | Small  |
| S2  | New `product_plans` table: `vendor_id`, `product_id`, `tier`, `status`, `period_start`, `period_end`, `renews_at`, `billing_frequency`, `auto_renew`, `commitment_months`, `ended_at`, `expiry_notice_sent_at`. Partial unique index for one live plan per product. Session carries a product-to-tier map. `requireCapability` becomes product-scoped, after `requireOwnedProduct` | Large  |
| S3  | Label mirror: `vendors.verified` becomes "any active product plan", written in the same batch                                                                                                                                                                                                                                      | Medium |
| S4  | Lifecycle: either a `read_only` status, or an auto-lapse cron writing `expired` at `period_end` with its own audit action. The second reverses the "warn, never lapse" rule in `STAGE_2_PAID_TIERS_SPEC.md` §7.3                                                                                                                  | Medium |
| S5  | `plan_discounts`: kind (volume, founding, manual), percent, reason, start, end, approver. Volume position computed at quote time                                                                                                                                                                                                    | Small  |
| S6  | `billing_accounts`, one per vendor: legal name, country, address, tax id, billing contact, `stripe_customer_id`, payment method (Stripe or wire). PII, so add it to the erasure register                                                                                                                                             | Medium |
| S7  | `invoices` mirror: Stripe invoice id or Mercury reference, status, amount, period, `paid_at`, `paid_outside_stripe`. Fed by a Stripe webhook                                                                                                                                                                                     | Medium |
| S8  | Connector billing class: a derived query over `product_role`, ownership and plan rows. Optionally a stored exemption reason on `billing_accounts`                                                                                                                                                                                    | Small  |
| S9  | Audit `product_plan.*` rows on every plan write and scheduled transition                                                                                                                                                                                                                                                            | Small  |

Order: S1, then S2 with S3, then S4. S5 to S9 are independent. S2 touches about 25 readers of
`vendor_entitlements`. The main ones are `lib/authz.ts`, `lib/integration-entitlement.ts`,
`lib/integration-contests.ts`, `lib/vendor-entitlement.ts`, `lib/entitlement-expiry.ts`,
`lib/data-quality.ts`, `routes/admin-entitlements.ts`, `routes/admin-claims.ts`,
`routes/vendor-updates.ts` and the portal plan panel.

Also: every approved claim opens a `verified` entitlement today (`routes/admin-claims.ts:178,526`,
confirmed in AECI-1103). Under a free-seat model that hands out paid capability. Claim approval needs
a "seat, no plan" option.

## 5. Plan-state leaks and cross-vendor exposure

**Ranking and placement.** No sort key, Algolia ranking setting or record builder reads plan state.
Algolia `customRanking` is `listing_tier, review_count` for products (`packages/shared/src/algolia.ts:408`).
The `entitlement` and `term` sorts are admin-only. The firewall test in `entitlements.spec.ts` holds.

Four indirect couplings need a ruling:

1. **Paid vendors can raise their own ranking input.** `listing_tier` ranks on description,
   website, logo and categories. Only plan holders can edit those themselves today. A free vendor
   must file a correction and wait. **Resolved 2026-10-01 by AECI-1212, built in AECI-1214:** these
   four fields become editable on every plan. Spec: `STAGE_2_PAID_TIERS_SPEC.md` §13.4.
2. **Only paid vendors can create vendor agreement.** Attestation needs `attestation.author`. The
   public pair page shows whether both vendors agree. So the "both vendors agree" trust state is
   reachable only by paying vendors. **Ruled 2026-10-01 in AECI-1212:** this stays a Managed
   feature. Spec: `STAGE_2_PAID_TIERS_SPEC.md` §13.1.
3. **Public version-diff depth depends on payment.** It opens when either endpoint vendor holds a
   plan (`lib/pair-version-diff.ts:76-114`). It is disclosed on `/methodology`. Per-product plans
   must re-key it to the endpoint product.
4. **The paid flag is named `verified`.** `vendors.verified` mirrors an active plan. The public label
   now reads "Active on AECi", but the column, the API field, the tier id and the public
   `GET /api/vendors?verified=` filter still say `verified`. Anyone can list paying vendors with it.

A minor one: `sort=updated` on public lists orders by `updated_at`, and paid saves bump it.

Cloudflare data does not change this picture. It records requests, not plans, and nothing in it
feeds ranking.

**Cross-vendor data.** No leak was found. Every `/api/vendor/*` handler scopes by the session's
`vendor_id`. The notification feed filters by the caller's id. Per-product plans open three risks:

- **Co-owned products.** `requireOwnedProduct` accepts any `product_vendors` link. A plan keyed on
  `product_id` alone would let a co-owner ride on another vendor's plan. Key plans on vendor and
  product together, or restrict paid writes to the primary vendor.
- **Insights scope.** With a vendor-wide gate, Insights on one product would expose every product's
  stats. The gate must filter server-side to products on Insights or Enhanced.
- **Assistant fetches on shared pages.** A vendor-facing line such as "ChatGPT fetched your product
  page 12 times" is safe for a product page. On a pair page the same fetch belongs to both vendors.
  Apply the same scoping rule as pair views.
- **Competitor clicks.** The spec's `outbound_clicks_elsewhere` field would show vendor A how many
  clicks went to vendor B from their shared pair page. That is competitor data.

## 6. Proposed issues

Issues marked "filed" were created on 2026-10-01. The rest are still proposals.

| #   | Title                                                                        | Repo | Tier   | Size     |
| --- | ---------------------------------------------------------------------------- | ---- | ------ | -------- |
| 1   | Vendor portal daily visit log in D1 (G2)                                     (filed AECI-1208) | app  | P      | Small    |
| 2   | "Confirm, nothing to change" on vendor, product, integration (G3)            (filed AECI-1216) | app  | P      | Small    |
| 3   | Store `utm_source` and label AI referrer hosts on `page_views` (G6)          | app  | I      | Small    |
| 4   | Notification delivery and click attribution: Resend id, `?n=` link, open (G7) (filed AECI-1202, AECI-1209) | app  | M      | Small    |
| 5   | Plan tier, status and product id on vendor audit rows (G8)                   (filed AECI-1192, AECI-1193) | app  | M      | Small    |
| 6   | Per-URL recrawl submission log (G9)                                          (filed AECI-1183, AECI-1184) | app  | M      | Small    |
| 7   | `first_response_at` on requests and AECi-routed contests (G10)               (filed AECI-1195) | app  | F/M    | Small    |
| 8   | Pilot grant requires `period_end`, and the warning send is audited per vendor (G11) | app | B | Small |
| 9   | Reasons required on admin logo overwrite, seat revoke and contest accept     (filed AECI-1191, built 2026-10-02) | app  | M      | Small    |
| 10  | Claim approval can grant a seat with no plan                                 (filed AECI-1215) | app  | B      | Small    |
| 11  | Tier ladder: Managed, Insights, Enhanced capability subsets (S1)             | app  | B      | Small    |
| 12  | `product_plans` table and per-product capability gate (S2, S3)               | app  | B      | Large    |
| 13  | Plan lifecycle: read-only state or auto-lapse, with audit (S4)               | app  | B      | Medium   |
| 14  | `billing_accounts`, `invoices`, `plan_discounts` (S5 to S7)                  | app  | B      | Medium   |
| 15  | Enhanced: media table, testimonials table, structured use cases              | app  | E      | Large    |
| 16  | Vendor replies to reviews                                                    (filed AECI-1173) | app  | M      | Medium   |
| 17  | Compatibility questions and leads (section 7)                                | app  | R      | Large    |
| 18  | Rename the `verified` plan flag and tier id                                  | app  | B      | Medium   |
| 19  | Spec update: move Performance from Verified to Insights in `VENDOR_PERFORMANCE_SPEC.md` | app | I | Small |
| 20  | ADR and build: Logpush to an R2 Iceberg table, daily rollup into D1 by cron and queue (G0). Fold into AECI-1169 (filed AECI-1196) | app | I | Medium |
| 21  | Vendor-facing assistant-fetch line on Performance, fed by the D1 rollup (`VENDOR_PERFORMANCE_SPEC.md` §2.3 item 3) | app | I | Medium |

Existing issues that already cover gaps: AECI-1169 (G0), AECI-934 (G1), AECI-935 (G4), AECI-933 (G5), AECI-762
(G6), AECI-944 and AECI-1160 (G9), AECI-1157 (G11), AECI-343 (item 27), AECI-717 (autocomplete),
AECI-949 and AECI-936/937 (item 12), AECI-1159 (override reason to vendor), AECI-868 (blocks any
per-request bot score). None of these is started. The §2.3 item 3 pointer in
`VENDOR_PERFORMANCE_SPEC.md` exists only on the unmerged Cloudflare branch.

## 7. Compatibility questions and leads: minimal model

This is the April 2027 target. It shares nothing with `vendor_requests`, because a buyer question
carries personal data and a consent obligation.

- `compatibility_questions`: `product_a_id`, `product_b_id` (canonical order), `source`,
  `question_body`, `use_case`, asker name, email, company and role,
  `consent_vendor_contact` with timestamp and consent text version, `status`
  (received, awaiting_response, answered, closed), `routed_to_vendor_id`, `routed_to_kind`
  (endpoint A, endpoint B, connector owner, AECi), `first_response_at`, `answered_at`, `closed_at`.
- `leads`: one row per vendor a question is shared with, only when consent is true.
  `qualification_status`, `qualified_at`, `qualified_by`, vendor-reported outcome, fee amount,
  billing period, invoice reference.
- Audit actions `compatibility_question.*` and `lead.*`. A portal read scoped by the session vendor.
  A retention rule and erasure coverage. A privacy policy change.

## 8. Open questions that block a decision

1. **Answered 2026-10-01: yes.** "Looks right" records it (AECI-1216).
2. **Should a plan lapse automatically on its end date?** The current rule is "warn, never lapse".
   The pilot schedule assumes read-only happens on 2026-12-14 without an operator.
3. **Answered 2026-10-01.** Attestation stays a Managed feature. The four `listing_tier` fields
   become editable on every plan.
4. **On a product listed under two vendors, who can buy its plan?** Company-profile editing is
   answered: it is free on every plan.
5. **May a vendor see clicks that went to another vendor from a shared pair page?**
6. **May we log vendor portal visits in D1 without analytics consent?** It is a first-party
   service log. The privacy policy may need a sentence.
7. **Which Cloudflare account holds Logpush?** Planning started in epic AECI-1196. AECI-1161 moves
   AECi resources to The WBS Project account, which conflicts with the AEC Integrations account
   named here. It needs an ADR because it adds Logpush, Pipelines and R2 Data Catalog to the stack.

## Summary

- Seat-only and Managed edit features are ready. Per-product plans, billing, Insights, Enhanced and
  leads are not.
- Thirteen cheap gaps (G0 to G12) should start before 2026-10-14. Five are already filed.
- Start Cloudflare Logpush first (AECI-1196). It is the only consent-independent record of
  AI-assistant traffic, and today it expires after 31 days.
- Per-product plans are a large change: a new `product_plans` table and a product-scoped gate.
- No ranking leak exists. Of four indirect couplings, one is resolved and one is ruled deliberate.
- Production is 12 commits behind `main`. Promote before the pilot.
- Two of seven open questions are answered. Question 2, automatic plan lapse, still blocks the
  pilot.
- Seven epics and one issue were filed on 2026-10-01 (see the table near the top).
