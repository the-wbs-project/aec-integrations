# Build plan: the November 2026 redesign as Linear issues

**Legal impact:** none — ruling R1 (AECI-1732) was made on 2026-11-14: existing orders stay and every new on-page list is A to Z by name with id as the tie-break, so no order reads an input a paid plan can change. The pair page captures and the "How ranking works" additions are still `text`, and each of those issues carries its own line.

| Field | Value |
| --- | --- |
| Written | 2026-11-14 |
| Umbrella issue | AECI-1720, project Platform |
| Plan it implements | `PLAN.md` in this folder |
| Issues filed | 115 new, plus AECI-341 and AECI-343 re-scoped |
| Code written | None |

This file is the map from `PLAN.md` to Linear. `PLAN.md` stays the design record. Linear holds each issue's scope, acceptance criteria and verification steps.

## 1. How the work is split

Every build issue is sized for one agent and one PR. Each carries a `model` label:

- `model:sonnet` means it is tightly specified, mechanical, or one surface. Sonnet can do it.
- `model:opus` means it needs design judgment, touches data, cache or a write path, or carries accessibility behaviour or a legal floor.

| Kind | Count |
| --- | --- |
| Epics | 11 |
| Rulings for Chris | 7: five under AECI-1721, two under AECI-1731 |
| `model:sonnet` | 67 |
| `model:opus` | 30, including AECI-341 and AECI-343 |
| Legal project | 2 |

Every build issue has:

- a `**Spec section:**` line and a `**Legal impact:**` line;
- acceptance criteria and test expectations;
- an "Agent notes" block with the exact verification commands, ending with the `self-review` skill.

Sub-issues share their parent's project. The empty pair page work is SEO, so it is its own epic, related to AECI-1720 rather than under it. The two legal issues sit in the Legal project.

## 2. The issue map

### Redesign 0: rulings (AECI-1721)

| Issue | Ruling | Blocks most |
| --- | --- | --- |
| AECI-1732 | R1: the ordering rule, today's count-ordered groups, the pair list order, "confirmed by both" as a filter | Every ordered list, the firewall test, closest matches |
| AECI-1733 | R2: scope (public, portal, admin) and rollout (batch branch or page by page) | All docs, the portal and admin epic |
| AECI-1734 | R3: hero visual, score figures, lead card, Reviewed date, nav bar colour, category chart, long-list grouping | Product page hero and long lists |
| AECI-1735 | R4: Browse menu key categories and column length | The Browse menu |
| AECI-1736 | R5: same-behaviour departures on the integrations list | Integrations section, browse mock-up |

R6 and R7 started here. They moved to the empty pair page epic on 2026-11-14, because they decide feature content, not the redesign.

### Redesign 1: docs (AECI-1722)

These run one after another, because they all edit `DESIGN.md`.

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1739 | ADR for the new design language | Sonnet |
| AECI-1740 | `DESIGN.md` §2 Colors, clashes 1 to 6 | Sonnet |
| AECI-1741 | `DESIGN.md` §3 Typography, clashes 7 to 10, 17 | Sonnet |
| AECI-1742 | `DESIGN.md` §4 Elevation and layout, clashes 11 to 18 | Sonnet |
| AECI-1743 | `DESIGN.md` §5 Components, clashes 19 to 25, 39 to 41, 43 | Sonnet |
| AECI-1744 | `DESIGN.md` §5 Navigation, clashes 26 to 32, 42 | Sonnet |
| AECI-1746 | `DESIGN.md` icons, motion, logos, floors, clashes 33 to 38, 44, 45 | Sonnet |
| AECI-1745 | `PRODUCT.md` and `BRAND_GUIDELINES.md` | Sonnet |

### Redesign 2: foundations (AECI-1723)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1747 | Colour tokens | Sonnet |
| AECI-1748 | Type ramp tokens, remap Tailwind's text scale | Opus |
| AECI-1749 | Snap stray font sizes | Sonnet |
| AECI-1750 | Radius, shadow and spacing tokens | Sonnet |
| AECI-1751 | Motion tokens | Sonnet |
| AECI-1752 | Smooth scroll: remove the global setting, scope it | Opus |
| AECI-1753 | `aec-icon` component and registry | Sonnet |
| AECI-1754 | Reversed wordmark and `tone` input | Sonnet |
| AECI-1755 | Icon migration: public | Sonnet |
| AECI-1756 | Icon migration: vendor portal | Sonnet |
| AECI-1757 | Icon migration: admin | Sonnet |

### Redesign 3: components (AECI-1724)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1758 | `aecButton` primitive | Opus |
| AECI-1759 | Button migration: directory pages | Sonnet |
| AECI-1760 | Button migration: content pages and flows | Sonnet |
| AECI-1761 | Button migration: vendor portal | Sonnet |
| AECI-1762 | Button migration: admin | Sonnet |
| AECI-1763 | `aec-chip` and the seven badges | Sonnet |
| AECI-1764 | Inputs with the 3 to 1 edge | Sonnet |
| AECI-1765 | Card surface and the three-column grid | Sonnet |
| AECI-1766 | Forest hero band and Bone band | Sonnet |
| AECI-1767 | Meter and large figure | Sonnet |
| AECI-1768 | Section nav and sticky bar | Opus |
| AECI-1769 | Logo rule for unclaimed products | Opus |
| AECI-1770 | Overlay surfaces | Sonnet |

### Redesign 4: shell (AECI-1725)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1771 | Header on Forest | Sonnet |
| AECI-1772 | Search pill and "/" shortcut | Sonnet |
| AECI-1773 | `GET /api/taxonomy` total count | Sonnet |
| AECI-1774 | Browse mega-menu, desktop | Opus |
| AECI-1775 | Mobile menu | Opus |
| AECI-1776 | Footer on Forest | Sonnet |
| AECI-1777 | Shell bands and breadcrumb | Sonnet |

### Redesign 5: product page (AECI-1726)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1778 | DetailLayout and the hero | Opus |
| AECI-1779 | Facts card | Sonnet |
| AECI-1780 | About, "Who it is for", "How teams use it" | Sonnet |
| AECI-1781 | API: partner categories, agreement, data-object names on rows | Opus |
| AECI-1782 | Integrations section | Opus |
| AECI-1783 | Long integration lists | Opus |
| AECI-1784 | Reviews and extensions | Sonnet |
| AECI-1785 | Similar products | Sonnet |
| AECI-1786 | Zero-integration, unclaimed and no-reviews states | Sonnet |
| AECI-1787 | Hero visual per R3 | Opus |
| AECI-1788 | Connector and hybrid products | Opus |

### Redesign 6: directory pages (AECI-1727)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1789 | Mock-up: home | Opus |
| AECI-1790 | Mock-up: browse lists | Opus |
| AECI-1791 | Mock-up: vendor page and the pair page with integrations | Opus |
| AECI-1792 | Home build | Sonnet |
| AECI-1793 | Browse shell | Sonnet |
| AECI-1794 | `/products` and the four term pages | Sonnet |
| AECI-1795 | The four taxonomy index pages | Sonnet |
| AECI-1796 | `/search` and the autocomplete | Sonnet |
| AECI-1797 | Vendor page build | Sonnet |
| AECI-1798 | Pair page with integrations, build | Opus |
| AECI-1799 | Not-found and the mailing list signup | Sonnet |
| AECI-1835 | Empty pair page restyle to mock-up 5 | Sonnet |

### Redesign 7: content pages and flows (AECI-1728)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1800 | About and Methodology | Sonnet |
| AECI-1801 | Updates, Roadmap, Contact | Sonnet |
| AECI-1802 | Vendor program, list-your-product, plan cards | Sonnet |
| AECI-1803 | Help center shell | Sonnet |
| AECI-1804 | Article prose: docs, legal, accessibility | Sonnet |
| AECI-1805 | Sign-in | Sonnet |
| AECI-1806 | Account and Welcome | Sonnet |
| AECI-1807 | Request forms and the review form | Sonnet |
| AECI-1808 | Unsubscribe, mute, claim confirm | Sonnet |

### Redesign 8: vendor portal and admin (AECI-1729)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1809 | Portal shell, nav, banners, legal acceptance | Sonnet |
| AECI-1810 | Overview, profile, products, facet editor | Sonnet |
| AECI-1811 | Integrations and integration detail | Sonnet |
| AECI-1812 | Reviews, messages, history, seats, billing, proposals | Sonnet |
| AECI-1813 | Admin token fallout sweep | Sonnet |

### Redesign 9: guard rails (AECI-1730)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1814 | Firewall test for on-page ordering | Opus |
| AECI-1815 | "How ranking works" additions | Sonnet |
| AECI-1816 | Measure data-object coverage by plan | Opus |
| AECI-1817 | Baseline screenshots | Sonnet |
| AECI-1818 | Accessibility gate 1: shell and components | Opus |
| AECI-1819 | Accessibility gate 2: full site and screen readers | Opus |
| AECI-1820 | Doc close-out | Sonnet |

### Empty pair page (AECI-1731, project SEO)

| Issue | Scope | Model |
| --- | --- | --- |
| AECI-1737 | Ruling R6: correction style, matches position, data object filter | Chris |
| AECI-1738 | Ruling R7: look-up floor, watch retention, public count | Chris |
| AECI-1821 | Spec: STAGE_1_5_SPEC §11.3 to §11.5. The bridge copy is removed, per Chris's 2026-11-14 ruling on AECI-342. | Sonnet |
| AECI-1822 | API: taxonomy and links on each side of the pair payload | Sonnet |
| AECI-1823 | Pair finder falls back to search | Sonnet |
| AECI-1824 | Production slug check, top 50 | Opus |
| AECI-1827 | Statement, caveat, side by side, "Look it up yourself" | Sonnet |
| AECI-343 | Re-scoped: a correction request records both products | Opus |
| AECI-1828 | "It does exist" entry | Sonnet |
| AECI-341 | Re-scoped: the closest-matches read | Opus |
| AECI-1829 | Closest matches UI | Opus |
| AECI-1830 | "What you would be moving" and the data object filter | Opus |
| AECI-1831 | Public look-up count | Opus |
| AECI-1832 | "I need this too" | Opus |
| AECI-1833 | "Watch this pair" capture | Opus |
| AECI-1834 | "Watch this pair" send and deletion | Opus |

Related, not children: AECI-342 (indexing, SEO) and AECI-1679 (weekly chart, Pilot, now blocked by AECI-1831).

### Legal project

| Issue | Scope |
| --- | --- |
| AECI-1825 | Privacy Policy lines for the pair captures and public counts |
| AECI-1826 | Ask legal about the product hero and unclaimed brand colours |

## 3. Recommended order

1. **Now, no ruling needed:**
   - AECI-1817 baseline screenshots
   - AECI-1816 coverage measurement
   - AECI-1773 taxonomy total
   - AECI-1781 integration row fields
   - AECI-1822 pair payload
   - AECI-1823 slug fallback
   - AECI-1824 slug check
   - AECI-1826 legal question
2. **Chris rules**, R1 and R2 first.
3. **Docs**: AECI-1739 to AECI-1746, in sequence.
4. **The shell batch.** Foundations, components and shell on one `batch/redesign-shell` branch (`docs/CICD_PLAN.md` §10a), if R2 picks that. AECI-1818 is its exit gate.
5. **In parallel with step 4:** the firewall test (AECI-1814), then the empty pair page epic in its listed order.
6. **Pages.** The product page, then the mock-ups and the directory pages, then the content pages, then the portal.
7. **Close-out:** AECI-1819, then AECI-1820.

## 4. What the 2026-11-14 code survey changed in PLAN.md

Three read-only surveys checked PLAN.md against the code before filing. These corrections are folded into the issues, and into PLAN.md §6 and §7.4.

| PLAN.md said | The code shows | Folded into |
| --- | --- | --- |
| §6.1: requests "partly" carry the pair through `context_product_id` | That column is for claims only. A correction passes `contextProduct: null` (`apps/api/src/routes/requests.ts:764`). The pair page has no request trigger. | AECI-343 |
| §6.2: `last_reviewed_at` is "not confirmed" in the payload | It is there as `maintenance.last_reviewed_at` | AECI-1778 |
| §6.3: per-term counts are "not confirmed as one read" | `GET /api/taxonomy` already returns `product_count` for all four vocabularies. It has no total. The header fetches it in the browser. | AECI-1773, AECI-1774 |
| §7.4: "All four are clean" | Via-lane groups and powered-hub groups sort by count. The pair list is integrations, then evidenced pairs, not one A to Z list. | AECI-1732 questions 2 and 3, AECI-1814 |
| §4.6 and clash 38: smooth scroll in-page only | `html { scroll-behavior: smooth }` is global in `styles.css` | AECI-1752 |
| §4.4: a custom icon set | There is no icon library. 136 inline Lucide SVGs use stroke 2. | AECI-1753 to AECI-1757 |
| §4.4: one button height | No shared button exists. Heights in use: 32, 36, 40, 44 and 48px. | AECI-1758 to AECI-1762 |
| §10.5: a reversed wordmark is missing | Bone-type SVGs exist, but each bakes in a Forest rectangle | AECI-1754 |

## 5. Plan check

The `spec-anchor` plan check, step 4.5, run against this breakdown on 2026-11-14.

```
## Spec Review — AECI-1720

**Plan:** full-site redesign broken into 117 Linear issues (BUILD_PLAN.md)
**Spec anchor:** docs/design/mockups/redesign-2026-11/PLAN.md (plan, not a build contract); each child carries its own anchor
**Reviewed against:** PLAN.md §4 to §12; STAGE_1_5_SPEC.md §7, §11, §13.3; STAGE_2_PAID_TIERS_SPEC.md §3.2; LEGAL_IMPACT_REVIEW.md §2 and §3; CICD_PLAN.md §10a; CLAUDE.md constraints; .github/workflows/*.yml pull_request triggers
**Doc updates the plan already carries:** each child names its docs; AECI-1820 sweeps PLAN.md §9.5
**Legal impact:** decision — new on-page list orders would read Managed-only inputs (attestation.author, packages/shared/src/entitlements.ts:113) against the Terms' "never influenced by payment"; the smallest version needing no ruling is everything except the ordered lists, which stay A to Z per PLAN.md §7.8

🔴 CRITICAL
- `P0` — "order integrations and closest matches" — the legal verdict is `decision` and Chris has not ruled. Every ordering issue is blocked by AECI-1732. A to Z binds until then. (LEGAL_IMPACT_REVIEW.md §2; entitlements.ts:113)

🟡 MAJOR (folded in)
- `P2` — "smooth scrolling in-page only" — styles.css sets it globally today. Without a removal step the clash 38 ruling would be false. Folded into AECI-1752. (PLAN.md §4.6; apps/web/src/styles.css ~540)
- `P1` — "rewrite DESIGN.md" — reversing the Surfaces-Are-Neutral Rule, PRODUCT.md's dark-front-door position and "Lucide icons exclusively" is ADR-worthy. No ADR step existed. Folded into AECI-1739. (docs/adr/README.md; DESIGN.md line 223, PRODUCT.md line 84)
- `P5` — "correction carries both products" — PLAN.md §6.1 relies on context_product_id, which corrections never set. Folded into AECI-343 as a schema change with migration, Zod, contract and audit. (STAGE_1_5_SPEC.md §11.5; apps/api/src/routes/requests.ts:764)

🔵 MINOR
- `P0` — PLAN.md §7.4 "All four are clean" is wrong: two product-page groupings sort by count. Corrected in PLAN.md and asked in AECI-1732. (connector-lane-grouping.ts:274-281)
- `P0` — PLAN.md §6.2 and §6.3 marked shipped fields "not confirmed". Corrected in PLAN.md. (products.ts:181; packages/shared/src/api/taxonomy.ts:20-23)

❌ Revise the plan before implementing — 1 critical, 3 major.
```

The ❌ applies only to the ordered lists. Every other issue is implementable once its own blockers clear, and the rulings are filed as issues. Base branch: `main`, with batch branches under §10a. `deploy.yml` and `integration-db-tests.yml` have no base-branch filter, so every lane runs on PRs into `batch/**`.

## 6. Rulings made on 2026-11-14

Chris ruled on all seven by Slack. Each ruling is recorded, with his words, as a comment on its issue. This section supersedes the "until Chris rules" wording in §2, §3 and §5 above.

| Ruling | Issue | Chris's answer | Applied as |
| --- | --- | --- | --- |
| R1 ordering | AECI-1732 | "Maintain orders as they are. If its a new feature a to z" | Existing orders stay, including the two count-ordered groups and the pair page list. Every new list is A to Z. "Confirmed by both" stays a label only. |
| R2 scope and rollout | AECI-1733 | "Just do public pages for now" | Public pages only. The portal and admin take tokens only. The shell lands on `batch/redesign-shell` and merges once. |
| R3 product page | AECI-1734 | "A" | All six recommendations. |
| R4 Browse menu | AECI-1735 | "A" | No "How we rank" card. Key categories: AI, Project management, BIM authoring, Accounting and ERP. Seven items per column. |
| R5 departures | AECI-1736 | "A" | Keep the filter panel, the grouped list with a jump rail, and "Show more". Reject illustrated empty states and the sort control. |
| R6 empty pair layout | AECI-1737 | "However the mockup had it. I liked the mockup" | Mock-up 5's default state decides the correction style, the matches position and the data object filter. |
| R7 demand captures | AECI-1738 | "A" | All six recommendations. Floor of 10, 12-month retention, server-side repeat-click guard. |

What R2 defers, not cancels:

- AECI-1809 to AECI-1812, the portal page restyles.
- AECI-1756 and AECI-1757, the portal and admin icon migrations.
- AECI-1761 and AECI-1762, the portal and admin button migrations.
- AECI-1813 widens to a token fallout sweep of both the portal and admin.

Chris also approved the orchestrator opening PRs and squash-merging them once the required checks are green and an independent review passes.

Chris settled the row agreement roll-up on 2026-11-14 (AECI-1781): "A", the weakest flow decides. A `single_source` row reads "Confirmed by one company".

## 7. Summary

- **Legal impact is `none`** for ordering since ruling R1 on 2026-11-14. Existing orders stay, and every new list is A to Z.
- 117 issues are in Linear: 11 epics, 7 rulings, 67 Sonnet-sized, 30 Opus-sized, 2 Legal.
- All seven rulings are made. §6 holds Chris's words and how each is applied.
- Scope is public pages only. The portal and admin take tokens only, and ten portal and admin issues are deferred.
- The shell lands on one `batch/redesign-shell` branch and merges once. Pages then move one by one on `main`.
- The `DESIGN.md` rewrite runs as a chain of 8 doc issues, so no two edit the file at once.
- Four unmocked surfaces (home, browse lists, vendor page, pair page with integrations) get three Opus mock-up issues. Chris approves each before its Sonnet build issue starts.
- No question is open. The row agreement roll-up was ruled "A" on 2026-11-14 (AECI-1781).
