# AEC Integrations roadmap

**Date:** 2026-10-14.
**Status:** Active. This is the index of the Linear projects that replaced the stage projects.
**Replaces:** the stage line after Stage 2.1. `STAGE_2_5_SPEC.md` and `STAGE_3_SPEC.md` are retired as stages. Their sections still govern where an issue cites them. §4 maps each open section to its project.

Stage 1, Stage 2 and Stage 2.1 shipped. Stage 2.1 closed as a stage on 2026-10-13 (`STAGE_2_1_SPEC.md` §5). Work now runs in parallel projects, not in a sequence of stages. Each project has an admission test. The test decides where an issue goes, the way `STAGE_2_1_SPEC.md` §1 did for its stage.

---

## 1. The six projects

| Project | Kind | Versioned |
|---|---|---|
| Pilot | Finite | No. Closes on its exit criterion |
| Managed | The paid plan (`verified` tier) | Yes. Milestones 1.0, 1.1 |
| SEO | Finite per epic | No. Each epic closes on its own exit |
| Insights | The plan rung above Managed | Yes. Milestone 1.0 |
| Enhanced | The plan rung after Insights | Yes. Milestone 1.0 |
| Platform | Standing | No. Never versioned |

### 1.1 Pilot

Everything that must be true before the first paying vendor. It also takes anything with a date or a pilot vendor in its blast radius, whatever the topic.

**Admission test.** A pilot vendor, reviewer or operator would notice it this quarter. Or it is on the path to the first paid invoice: the payment rail, terms, per-product plans or expiry. Or it has a hard date before 2026-12-31.

**Exit criterion.** The first paid Managed license is paid for. Every pilot vendor's term has reached its end date and been renewed or ended. The parked claim queue is empty. There is no shared pilot end date. AECI-1325 withdrew the 2026-12-14 date on 2026-10-14, and each pilot vendor now has its own term (`STAGE_2_PAID_TIERS_SPEC.md` §7.3). Once E1 ships, a pilot term is a complimentary license with an end date (`VENDOR_SIGNUP_PROCESS.md` §1).

**Governing docs.** `docs/VENDOR_SIGNUP_PROCESS.md` (the agreed claim, license and billing process, epics E1 to E10), `docs/STAGE_2_1_SPEC.md` (closed), `docs/STAGE_2_PAID_TIERS_SPEC.md` §13, `docs/STAGE_2_VENDOR_PORTAL_SPEC.md`.

### 1.2 Managed

The paid plan. Its stored tier id is `verified`. Milestone 1.0 is the capability set in `TIER_CAPABILITIES.verified` plus the terms on `/docs/vendors/plans` as of 2026-10-14.

**Admission test.** A gap between what Managed is sold as and what the portal does. New benefits do not pass. A new benefit belongs to a higher rung or to a minor version with a ruling.

**Exit criterion.** None. A plan does not close. Each milestone closes when its capability set ships.

**Governing docs.** `docs/STAGE_2_PAID_TIERS_SPEC.md`, `docs/STAGE_2_VENDOR_PORTAL_SPEC.md`, `docs/STAGE_2_ATTESTATIONS_SPEC.md`.

### 1.3 SEO

It absorbs the former "Pair-Page Search Intent (pSEO)" project and epic AECI-788.

**Admission test.** The work is justified by search engines or answer engines reaching and ranking our pages. That covers pSEO pair pages, structured data, sitemaps, indexing and Google Search Console. It also covers server response time on catalog pages, and Algolia ranking where it affects crawlable listing pages.

**Exit criterion.** Per epic. Each epic states its own.

**Governing docs.** `docs/STAGE_1_5_SPEC.md` §11, `docs/SEARCH_RANKING.md`, `docs/STAGE_2_5_SPEC.md` §2 and §7.

### 1.4 Insights

The next plan rung above Managed. It is vendor-facing performance reporting: `analytics.view`, `/vendor/:vendorSlug/performance`, and per-vendor Search Console data.

**Ruled 2026-10-13: Insights is a rung above Managed, not part of it.** The public pages stopped promising performance reporting to Managed in #960. Insights is built as a rung that contains Managed. The `vendors.verified` mirror keys off `status`, so an Insights row that lacked Managed's capabilities would still open Managed's side effects. The license model allows one live license per product (`licenses_live_product_idx`). An Insights add-on beside Managed on the same product therefore needs its own design on the license model. AECI-1294 is closed or re-scoped under E10.

**Admission test.** Data or surfaces a vendor pays to see about their own listings. Operator-side observability is Platform.

**Exit criterion.** Milestone 1.0 is the Performance page shipping behind a new rung that contains Managed.

**Governing docs.** `docs/VENDOR_PERFORMANCE_SPEC.md`, `docs/design/vendor-performance-direction.md`, `docs/VENDOR_PLAN_DATA_READINESS.md`.

### 1.5 Enhanced

The plan rung after Insights. It makes profiles richer: company facts, rich media, extended product fields and file-format capabilities.

**Admission test.** It makes a vendor or product profile richer. It does not touch search cards, ranking inputs or the `reviews` table.

**Exit criterion.** Milestone 1.0 is undefined until a spec exists.

**Governing docs.** `PRODUCT.md` (richness, never ranking), `docs/STAGE_3_SPEC.md` §4 (reference only), `docs/VENDOR_PLAN_DATA_READINESS.md`.

### 1.6 Platform

Internal engineering with no date. That covers CI, developer experience, data archives, docs sweeps, accessibility remediation, connector-seat follow-ups and cleanup.

**Admission test.** No pilot vendor notices it this quarter, and it has no date. If it gains either, it moves to Pilot.

**Exit criterion.** None. Platform is standing.

**Parked: the Trust ladder.** The epic AECI-1329 "Trust ladder (parked)" sits in Platform. It holds the unbuilt `STAGE_3_SPEC.md` §2.1 rungs and `evidence_tier`. No project schedules it. It is parked pending Chris's ruling: schedule it as its own project, or leave it parked.

**Governing docs.** `docs/CICD_PLAN.md`, `docs/TESTING_STRATEGY.md`, `docs/ACCESSIBILITY_AUDIT.md`, `docs/STAGE_3_SPEC.md` §2.1, §2.4 and §2.5.

---

## 2. The standing projects

These existed before the reorganization and do not change.

| Project | Admission test | Governing docs |
|---|---|---|
| Bugs | A live production defect. A pilot-visible defect with a date may sit in Pilot instead | The spec that governs the broken surface |
| Legal | Terms, policies, contracts and counsel review. The order form and the processor list live here | `apps/web/src/content/legal/` |
| Marketing | Work in the `aec-integrations-marketing` repo. No title prefix | That repo's docs |
| Vendor Requests | Claim and correction tickets the request pipeline files. They carry a `Request:` trailer, not a spec anchor | `docs/linear-issue-conventions.md` §1 |

`REVIEW - ` issues keep their routing: no project, title prefix only (`docs/linear-issue-conventions.md` §3).

---

## 3. Version convention

Only plans carry version numbers. The app does not.

- **A plan version** is the capability set in `TIER_CAPABILITIES` plus the terms on `/docs/vendors/plans`. Managed, Insights and Enhanced each carry milestones: 1.0, 1.1 and so on.
- **The major number bumps** when a paying vendor loses something, or a term moves against them. A price never changes mid-term, and a change needs at least 30 days' written notice (`docs/PRICING_RULES.md` §6). So a major bump needs written notice first.
- **The minor number bumps** when a capability ships.
- **Pilot, SEO and Platform carry no version.** They close on exit criteria.
- **App deploys stay SHA-promoted** (`docs/environments.md`, `docs/CICD_PLAN.md`). A plan version does not change how code ships. An optional git tag such as `managed-1.0` may mark the production SHA that completed a version.
- **The plan version is written onto the license.** Each license carries a terms version, for example "Managed 1.0" (epic E1, `VENDOR_SIGNUP_PROCESS.md` §5). A dispute can then name what was sold. Until E1 ships, the operator writes it into the entitlement `terms` field at grant.

---

## 4. Retired spec sections mapped to projects

Section numbers in the retired specs are frozen. Open issues anchor to them, and `spec-anchor` resolves by path. Only sections with unshipped work are listed. Shipped sections that still govern code are listed in §4.3.

### 4.1 `docs/STAGE_2_5_SPEC.md`

| § | Open item | Project |
|---|---|---|
| §2 step 2 | Ranking change 2: `evidence_tier`, `limits`, `file-transfer`, integrations index ordering | Platform (AECI-1329, parked) |
| §2 step 4 | Release the blocked home-page copy | SEO |
| §2 fold-in | AECI-283 tuning loop and the `SEARCH_RANKING.md` §7 rewrite | SEO |
| §2 fold-in | AECI-534 remove `has_api_docs` | SEO |
| §3 | AECI-531 GDPR erasure: log a skipped auth delete, clean up orphaned auth rows. Logging, metric and alert built 2026-10-23; the one-time orphan cleanup is still to run | Pilot |
| §3 | AECI-591 reconcile sweep writes no audit row. Built 2026-10-26 | Platform |
| §3 | AECI-589 purge secrets. No open issue. The §8 box is unticked, so verify and tick | Platform |
| §4 | AECI-559 Procurement category, under AECI-1068 | Pilot |
| §5 | AECI-244 VoiceOver and NVDA speech run. No open issue. The run is not logged | Platform |
| §5 | AECI-1254 docs FAQ, waiting on real pilot questions | Managed |
| §6 | Docs de-stale sweep: AECI-599 under epic AECI-1067 | Platform |
| §7 | AECI-784 site-wide JSON-LD entity graph, AECI-785 `llms.txt`, AECI-787 RSS feed, under AECI-788 | SEO |
| §7.1 | The owed `/methodology` and trust-line edits at the first seated vendor. No issue yet | Pilot |
| §10 | Vendor Performance page, epics AECI-930, AECI-931, AECI-932 | Insights |
| §13 | AECI-715 connector coverage surface, AECI-716 reachable-lane publication | SEO |

§8 (exit criteria) and §9 (out of scope) no longer gate anything. Each open §8 box follows the section it names.

### 4.2 `docs/STAGE_3_SPEC.md`

| § | Open item | Project |
|---|---|---|
| §2.1 | Trust ladder: rung 2 AECi-verified, rung 3 dual-vendor, the demand-ordered queue, review trust, anti-gaming | Platform (AECI-1329, parked) |
| §2.2 | pSEO: AECI-340 to AECI-344 | SEO |
| §2.2 | AECI-560 sitemap split, gated on 50,000 URLs | SEO |
| §2.3 | Stack-aware discovery. §5(3) is undecided | None. Unscheduled |
| §2.4 | DX tail: AECI-533, AECI-602, AECI-621, under epic AECI-1070 | Platform |
| §2.5 | AECI-829 status messages never announced, on sign-in, review and account. Fixed 2026-10-23 | Pilot |
| §2.5 | AECI-830, AECI-831, AECI-832, under epic AECI-1069 | Platform |
| §2.6 | Rebrand options A, D and E and the admin rename-slug action. §5(6) decisions are open | SEO |
| §2.6 | AECI-979 taxonomy redirects | Platform |
| §4 | Rich media profiles | Enhanced |
| §4 | Comparative figures and the emailed report | Insights |
| §4 | Automated billing | Pilot. Stripe is epic E9 (AECI-1339), built 2026-10-28; production checkout waits on the switch-on (`VENDOR_SIGNUP_PROCESS.md` §5, ADR 0047) |
| §4 | Review translation, a public write API | None. Unscheduled |

`STAGE_3_SPEC.md` §5 (open decisions) stays the record of what is undecided. Settle a decision before its item is built.

### 4.3 Sections that remain live contracts

These sections govern shipped code. Edit them as specs, not as history.

| Doc | § | Governs |
|---|---|---|
| `STAGE_2_5_SPEC.md` | §11 | Vendor and product logo editing (ADR 0032) |
| `STAGE_2_5_SPEC.md` | §12 | Vendor-authored "How teams use it" (ADR 0033) |
| `STAGE_2_5_SPEC.md` | §14 | `/vendor-program` (build contract `VENDOR_PROGRAM_PAGE_SPEC.md`) |
| `STAGE_2_5_SPEC.md` | §7.1 | The `/methodology` build contract |

### 4.4 `docs/VENDOR_PERFORMANCE_SPEC.md`

This spec is not retired. It is the Insights build contract. Its open sections, for reference:

| § | Open item | Project |
|---|---|---|
| §3.1 | The vendor-total dedupe rule for pair pages | Insights |
| §3.4 | AECI-935 consented pair-page view event | Insights |
| §3.5 | AECI-762 crawler purpose split, under AECI-788 | SEO |
| §6 | Epic AECI-931: Search Console and Bing, AECI-936 to AECI-938 and AECI-949 | Insights |
| §4, §5 | Epic AECI-932: endpoint, CSV and page, AECI-939 to AECI-941 | Insights |
| §7 | AECI-942 privacy sentence, shipped in the same release as the page | Insights |

---

## 5. Moving an issue between projects

An issue moves when it fails its project's admission test. Sub-issues share the parent's project. A cross-project link is a `relatedTo` relation, never a parent.

An issue anchored to a retired spec keeps its anchor. Do not re-point it to this file. This file names the project, and the retired section stays the contract.
