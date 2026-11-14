# ADR 0056: The November 2026 design language replaces nine design rules and keeps four floors

- Status: Accepted. Records the rulings of AECI-1720. Built under AECI-1722.
- Date: 2026-11-14. The design rulings are dated 2026-11-13. R1, R2 and R5 are dated 2026-11-14.
- Issue: AECI-1739. Scope and rollout ruling R2 on AECI-1733, ordering ruling R1 on AECI-1732, same-behaviour ruling R5 on AECI-1736.
- Evidence: `docs/design/mockups/redesign-2026-11/records/design-rulings.md`, `docs/design/mockups/redesign-2026-11/PLAN.md` §4 and §9
- Relates to: `DESIGN.md`, `PRODUCT.md` and `docs/BRAND_GUIDELINES.md`, which this ADR makes stale in the places listed

## Context

The redesign plan tested the site's design rules against new mock-ups. It found 45 clashes. Chris ruled on all of them on 2026-11-13.

Seventeen rulings picked the new design over the written rule. Several of those rules are stated as principles in `DESIGN.md` and `PRODUCT.md`. A reader who finds the old principle next to the new pages will think the pages are wrong. Six months from now that reader needs one place that says which side won, and why.

On 2026-11-14 Chris ruled on three questions that shape the build:

- R2 set the scope and the rollout.
- R1 set how lists are ordered.
- R5 set which same-behaviour departures stay.

## Decision

The site adopts the design language in `PLAN.md` §4. The rules below are superseded. Each line number was checked against the files on 2026-11-14.

| Superseded rule | Where it is written today | Clash | What replaces it |
| --- | --- | --- | --- |
| The Surfaces-Are-Neutral Rule: brand colours are never a page background | `DESIGN.md:223` | 1 | Forest may fill the header, the detail page hero and the footer, and one Forest feature card per page (the "Know of one?" card in mock-up 8). The reading area stays white. |
| The dark front door position: "A dark front door pattern-matches to 'internal tool'" | `PRODUCT.md:84` | 1 | The same Forest fill. This is a light theme with a Forest header, hero and footer. It is not a dark theme. |
| "Lucide icons exclusively" | `DESIGN.md:1155`, `PRODUCT.md:104`, `docs/BRAND_GUIDELINES.md:132` | 34 | A custom icon set at 1.75 stroke. The no-emoji rule stays. |
| Global smooth scroll: `html { scroll-behavior: smooth }` | `apps/web/src/styles.css:539` to `541` | 38 | Smooth scrolling for in-page section links only. It is never a global setting. |
| Display type used at most once per page, on About, Home and vendor mastheads | `DESIGN.md:245` | 7 | Display sizes are allowed on detail pages, for the product name. |
| The Borders-Not-Shadows Rule: shadows on cards are forbidden | `DESIGN.md:293`, `DESIGN.md:382` | 11 | One card shadow for top-level floating surfaces. Controls keep borders and take no shadow. |
| Radius: controls 8px, never large | `DESIGN.md:67` to `73`, `DESIGN.md:370` | 12 | Controls 12px, cards 24px, chips full pill. Primary actions are still never pills. |
| "Don't nest cards inside cards" | `DESIGN.md:1146` | 14 | Cards may nest. |
| "Side-stripe borders are banned" | `DESIGN.md:1142` | 15 | Coloured side stripes are allowed. |

The light-only rule is not superseded. There is still no dark theme, no `dark:` variant and no toggle.

This ADR does not rewrite `DESIGN.md`, `PRODUCT.md` or `docs/BRAND_GUIDELINES.md`. Later issues under AECI-1722 do that. Until they land, this ADR wins where the three files disagree with it.

### Floors that hold whatever the ruling

These are accessibility and legal rules, not style. See `PLAN.md` §9.2.

1. **Inputs.** Every form control has a visible boundary at 3 to 1 contrast, per WCAG 1.4.11.
2. **Mobile menu.** The toggle has an accessible name and the open menu traps focus.
3. **Logos.** An unclaimed product shows an initial tile everywhere except its own page. This is counsel's ruling 9.
4. **Smooth scrolling.** It must not break router scroll restoration and it must respect reduced motion. The scroll rule in `CLAUDE.md` stays.

### Scope and rollout, ruling R2 of 2026-11-14

Chris ruled "Just do public pages for now". It applies as follows.

1. **Scope.** Public pages only. The vendor portal and admin take the new tokens and nothing more.
2. **Deferred work.** The portal page issues AECI-1809 to AECI-1812 and the portal and admin icon and button migrations AECI-1756, AECI-1757, AECI-1761 and AECI-1762 are deferred. They are not cancelled. AECI-1813 widens to a token fallout sweep of both the portal and admin.
3. **Rollout.** Tokens, components, header and footer land on one `batch/redesign-shell` branch. That branch merges to `main` once. Page bodies then move one by one on `main`.
4. **Order.** Docs, the shell batch, the product page and the empty pair page, the directory pages, then the content pages.

### Ordering and same-behaviour, rulings R1 and R5

- **R1.** Every new on-page list is A to Z by name with id as the tie-break. Existing count-ordered groups keep their count order. The pair page keeps integrations first, then evidenced pairs. The legal verdict for the redesign's ordered lists is `none`, because no order reads an input a paid plan can change.
- **R5.** Integration filters in their own panel, grouping by category with a sticky jump rail, and "Show more" per group with a load bar are kept. Each becomes the rule for every page with that pattern. Illustrated empty states and a sort control on the integrations list are rejected.

## Consequences

- `DESIGN.md`, `PRODUCT.md` and `docs/BRAND_GUIDELINES.md` are stale in the places above until their rewrite issues land. The rewrite of `DESIGN.md` for R5 is AECI-1743.
- The portal and admin will look different from the public pages for a while. That is deliberate.
- The colour lint rejects loose colour values. New colours must be OKLCH tokens in `styles.css`. The shipped footer spec pins four columns, and the new footer keeps them.
- Smooth scroll moves from `html` to the in-page link handlers. Router scroll restoration, `ScrollBehaviorManager` and `InitialFragmentScroller` are not touched.
- Chris asked to be able to adopt the old smooth-scroll behaviour again if needed. The scoped rule must therefore be one switch, not scattered code.
- A new ADR is needed if the Forest ground or the icon set is reversed later.
