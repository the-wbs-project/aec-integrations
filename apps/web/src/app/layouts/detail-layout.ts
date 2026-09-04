import { Component } from '@angular/core';

/**
 * Detail layout shell — projected into by product, vendor, and integration
 * detail pages. Named slots only; no state, no inputs. Concrete page issues
 * project body content via `slot="*"` attributes (shadcn-style composition).
 *
 * Anchor: Stripe (inherited from AECi site chrome, `apps/web/src/app/layout/
 * site-header.ts`). See `DESIGN.md` §"Named Rules" → "The Anchor-Site Rule".
 *
 * Spec: Phase 2 Spec §11.1 (`docs/STAGE_1_PHASE_2_SPEC.md:423`).
 *
 * Slots:
 *   - `breadcrumbs` — top-of-page breadcrumb trail (optional)
 *   - `hero`        — name, vendor, key facts (required)
 *   - `nav`         — the sticky in-page section nav (optional). Rendered as a
 *                     direct child of the page container, NOT inside the grid —
 *                     see "Why `nav` is unwrapped" below
 *   - `body-lead`   — the body sections that must stay ABOVE the metadata when
 *                     the page is single-column (in practice: the About
 *                     section). Optional; absent collapses to nothing
 *   - `metadata`    — metadata sidebar. Docks into column 2 from `xl`; below
 *                     `xl` it renders between `body-lead` and `body`
 *   - `body`        — the remaining vertically stacked body sections (required)
 *
 * **Why `body-lead` exists.** The sidebar carries the facts a visitor wants
 * first (vendor, taxonomy, the claim/correction actions). In a single column the
 * naive collapse puts it last — under Reviews, at the very bottom of a long
 * page — which is where information goes to die. Splitting the body in two lets
 * the one instance of the sidebar sit directly under About at narrow widths and
 * still dock into column 2 at `xl`, with no duplicated markup. Duplicating it
 * (render twice, hide one per breakpoint) is not an option here: the projected
 * content labels its sections with `aria-labelledby`, so a second copy would
 * duplicate those DOM ids and break the very labels it re-renders.
 *
 * **Why `nav` is unwrapped.** `position: sticky` only travels within its
 * containing block, so a sticky nav sticks for exactly as long as its PARENT
 * element is on screen. Projecting it into `body-lead` would pin it to the
 * height of the lead alone — it would unstick the moment About scrolled past,
 * long before the sections it links to. It is therefore projected bare (no
 * wrapper element) as a direct child of the page container, whose box spans the
 * whole page, so it stays pinned for the full scroll. Any wrapper added around
 * this `ng-content` re-breaks it.
 *
 * Usage:
 * ```html
 * <aec-detail-layout>
 *   <nav slot="breadcrumbs">…</nav>
 *   <header slot="hero">…</header>
 *   <aec-section-nav slot="nav" />
 *   <div slot="body-lead">…</div>
 *   <div slot="metadata">…</div>
 *   <section slot="body">…</section>
 * </aec-detail-layout>
 * ```
 */
@Component({
  selector: 'aec-detail-layout',
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 pt-3 pb-8 md:px-8 md:pt-4 md:pb-12">
        <nav
          class="mb-4"
          i18n-aria-label="@@app.layouts.detail.breadcrumbs.aria"
          aria-label="Breadcrumb"
        >
          <ng-content select="[slot=breadcrumbs]" />
        </nav>

        <header class="mb-8 border-b border-(--border-default) pb-8 md:mb-12 md:pb-12">
          <ng-content select="[slot=hero]" />
        </header>

        <!--
          The in-page nav is projected BARE, straight into the page container,
          with no wrapper element. position:sticky is bounded by the containing
          block, i.e. the parent's box: inside a wrapper (or inside the body-lead
          column) the nav would unstick as soon as that box scrolled past, which
          on a detail page is well before the sections it links to. The page
          container spans the whole page, so here it stays pinned for the full
          scroll. Do not wrap this ng-content.
        -->
        <ng-content select="[slot=nav]" />

        <!--
          Two columns only from xl. The body column carries data tables whose own
          minimum width is 44rem (product integrations) / 52rem (browse); at md-lg
          a docked 1fr sidebar leaves the 2fr body under 40rem, so every table fell
          back to horizontal scroll inside a narrow well. Below xl the page goes
          single-column and the tables get the full content width.

          Placement is explicit (col-start / row-start), not source order, because
          the three children are read in two different orders: at xl the lead and
          the rest of the body stack in column 1 with the sidebar docked alongside
          spanning both rows; below xl the source order (lead, sidebar, body) IS the
          reading order. Vertical rhythm is margins rather than gap-y so that an
          absent lead collapses to exactly nothing instead of leaving a gapped
          phantom row.
        -->
        <div class="grid xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:gap-x-12">
          <!-- Plain <div>s: the app shell (app.ts) already provides <main id="main"> wrapping
               the router outlet. Using <main> here would create a duplicate main landmark. -->
          <div class="min-w-0 space-y-12 empty:hidden xl:col-start-1 xl:row-start-1">
            <ng-content select="[slot=body-lead]" />
          </div>

          <aside
            class="mt-10 min-w-0 space-y-6 empty:hidden xl:sticky xl:top-8 xl:col-start-2
              xl:row-span-2 xl:row-start-1 xl:mt-0 xl:self-start"
            i18n-aria-label="@@app.layouts.detail.metadata.aria"
            aria-label="Metadata"
          >
            <ng-content select="[slot=metadata]" />
          </aside>

          <div class="mt-10 min-w-0 space-y-12 xl:col-start-1 xl:row-start-2 xl:mt-12">
            <ng-content select="[slot=body]" />
          </div>
        </div>
      </div>
    </div>
  `,
})
export class DetailLayout {}
