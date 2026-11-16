import { NgTemplateOutlet } from '@angular/common';
import { Component, input } from '@angular/core';

import { BAND_WRAP_CLASS } from '../shared/band-wrap';

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
 *   - `metadata`    — metadata sidebar. Docks into column 2 from `lg`; below
 *                     `lg` it renders between `body-lead` and `body`
 *   - `body`        — the remaining vertically stacked body sections (required)
 *
 * **Why `body-lead` exists.** The sidebar carries the facts a visitor wants
 * first (vendor, taxonomy, the claim/correction actions). In a single column the
 * naive collapse puts it last — under Reviews, at the very bottom of a long
 * page — which is where information goes to die. Splitting the body in two lets
 * the one instance of the sidebar sit directly under About at narrow widths and
 * still dock into column 2 at `lg`, with no duplicated markup. Duplicating it
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
 * **Two shells (AECI-1778).** `shell="columns"` (the default) is the shipped two-column
 * page with the docked metadata sidebar. The vendor page stays on it until its mock-up
 * lands (AECI-1791, AECI-1797). `shell="bands"` is the product page's band shell
 * (DESIGN.md §4 "The detail page band shell"), one column at every width:
 *
 *   1. `hero` full bleed. The caller projects its own `aec-hero-band`, which holds the
 *      breadcrumb, so `breadcrumbs` is not rendered in this shell.
 *   2. `metadata`, the facts position. It sits in the page wrap on a Bone ground and is
 *      pulled up over the hero: 64px below `md` and 96px from `md`. The hero's bottom
 *      padding is 96px and 128px, so the hero's last control keeps 32px at every width.
 *   3. `nav`, bare, a direct child of the page container, as in the column shell.
 *   4. `body-lead` on the page's one Bone band (`aec-bone-band first` spacing).
 *   5. `body` on white, in the page wrap.
 *
 * The metadata keeps its `aside` landmark. DOM order is the reading order. Each slot's
 * `ng-content` is declared once, in a template, and placed by an outlet in the active
 * shell, because a selector declared in both branches projects into one of them only.
 *
 * Usage:
 * ```html
 * <aec-detail-layout>
 *   <aec-breadcrumb slot="breadcrumbs" [items]="crumbs" />
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
  imports: [NgTemplateOutlet],
  template: `
    <ng-template #breadcrumbsSlot><ng-content select="[slot=breadcrumbs]" /></ng-template>
    <ng-template #heroSlot><ng-content select="[slot=hero]" /></ng-template>
    <ng-template #navSlot><ng-content select="[slot=nav]" /></ng-template>
    <ng-template #leadSlot><ng-content select="[slot=body-lead]" /></ng-template>
    <ng-template #metadataSlot><ng-content select="[slot=metadata]" /></ng-template>
    <ng-template #bodySlot><ng-content select="[slot=body]" /></ng-template>

    @if (shell() === 'bands') {
      <!-- The band shell (AECI-1778). See the class comment for the order. -->
      <!-- The nav host takes the band wrap's gutters as padding, so its bar spans the page
           and its links line up with every band. 3rem plus half the space beyond 1328px is
           BAND_WRAP_CLASS's content edge. The container is Bone, so a nav with rest="clear"
           shows the Bone band behind it at rest. The body below sits on its own white band. -->
      <div
        class="bg-(--accent-warm) text-(--text-primary) [&>[slot=nav]]:px-6 md:[&>[slot=nav]]:px-8 lg:[&>[slot=nav]]:px-[max(3rem,calc((100%-1328px)/2+3rem))]"
        data-shell="bands"
      >
        <ng-container [ngTemplateOutlet]="heroSlot" />

        <!-- The Bone ground starts at the hero's bottom edge, so it sits behind the lower
             half of the facts card. relative + z-10 paints the card over the band.
             flow-root stops the card's negative margin collapsing through this box, which
             would drag the Bone ground up over the hero. -->
        <div class="aec-bone-band flow-root bg-(--accent-warm)">
          <div [class]="wrap" class="pb-12 md:pb-16">
            <aside
              class="relative z-10 -mt-16 min-w-0 empty:hidden md:-mt-24"
              data-testid="detail-facts"
              i18n-aria-label="@@app.layouts.detail.metadata.aria"
              aria-label="Metadata"
            >
              <ng-container [ngTemplateOutlet]="metadataSlot" />
            </aside>
          </div>
        </div>

        <!-- Bare, as in the column shell: sticky is bounded by the parent's box. -->
        <ng-container [ngTemplateOutlet]="navSlot" />

        <!-- The page's one Bone band, the About band. With no lead it is not shown: the
             outer has() hides it when the inner wrap holds nothing. The facts ground above
             is the same band. It runs through the nav at rest when the nav is rest="clear";
             a solid nav cuts it with a white bar. -->
        <div
          class="aec-bone-band bg-(--accent-warm) has-[>[data-lead]:empty]:hidden"
          data-testid="detail-lead-band"
        >
          <div [class]="wrap" class="space-y-12 pt-8 pb-16 md:pt-12 md:pb-24" data-lead>
            <ng-container [ngTemplateOutlet]="leadSlot" />
          </div>
        </div>

        <div class="bg-(--surface-base)" data-testid="detail-body-band">
          <div [class]="wrap" class="space-y-12 py-16 md:py-24">
            <ng-container [ngTemplateOutlet]="bodySlot" />
          </div>
        </div>
      </div>
    } @else {
      <div class="bg-(--surface-base) text-(--text-primary)">
        <div class="mx-auto w-full max-w-7xl px-6 pt-3 pb-8 md:px-8 md:pt-4 md:pb-12">
          <div class="mb-4">
            <ng-container [ngTemplateOutlet]="breadcrumbsSlot" />
          </div>

          <header class="mb-8 border-b border-(--border-default) pb-8 md:mb-12 md:pb-12">
            <ng-container [ngTemplateOutlet]="heroSlot" />
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
          <ng-container [ngTemplateOutlet]="navSlot" />

          <!--
          Two columns from lg. The breakpoint is arithmetic, not taste: the body
          column is (content - 48px gap) * 2/3, which is 608px at a 1024px
          viewport and 778px at 1280px. A body-column table whose min-width
          exceeds that figure does not wrap. It overflows its own
          overflow-x-auto wrapper and scrolls inside a narrow well.

          This docked at xl until AECI-853, because the product-integrations
          table asked for 44rem (704px) and only 1280px cleared it. Folding that
          table's Direction column into the partner cell's meta line took its
          worst case to 545px, so 1024px now clears it with 63px to spare. The
          vendor-detail products table was cut the same way, for the same reason.

          Before lowering any body-column table's min-width ceiling, check it
          against 608px, not against the viewport. The browse tables are NOT
          governed by this comment. They live in BrowseLayout, whose sidebar
          splits 1fr/3fr at md.

          Placement is explicit (col-start / row-start), not source order, because
          the three children are read in two different orders: at lg the lead and
          the rest of the body stack in column 1 with the sidebar docked alongside
          spanning both rows; below lg the source order (lead, sidebar, body) IS the
          reading order. Vertical rhythm is margins rather than gap-y so that an
          absent lead collapses to exactly nothing instead of leaving a gapped
          phantom row.
        -->
          <!-- lg:grid-rows-[auto_1fr]: the sidebar spans both rows, and auto rows would share
             its extra height, opening a gap above the body. The body row takes it all. -->
          <div
            class="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-12"
          >
            <!-- Plain <div>s: the app shell (app.ts) already provides <main id="main"> wrapping
               the router outlet. Using <main> here would create a duplicate main landmark. -->
            <div class="min-w-0 space-y-12 empty:hidden lg:col-start-1 lg:row-start-1">
              <ng-container [ngTemplateOutlet]="leadSlot" />
            </div>

            <!-- Sticky below the section bar when the page has one: --aec-sticky-offset is
               its height (styles.css, AECI-1768), and unset with no bar, so 2rem. Under the
               bar it sticks only on screens tall enough to show it whole (.aec-detail-aside
               in styles.css). -->
            <aside
              class="aec-detail-aside mt-10 min-w-0 space-y-6 empty:hidden lg:sticky lg:top-[calc(var(--aec-sticky-offset,0px)+2rem)] lg:col-start-2
              lg:row-span-2 lg:row-start-1 lg:mt-0 lg:self-start"
              i18n-aria-label="@@app.layouts.detail.metadata.aria"
              aria-label="Metadata"
            >
              <ng-container [ngTemplateOutlet]="metadataSlot" />
            </aside>

            <div class="mt-10 min-w-0 space-y-12 lg:col-start-1 lg:row-start-2 lg:mt-12">
              <ng-container [ngTemplateOutlet]="bodySlot" />
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class DetailLayout {
  /** `columns` is the shipped sidebar page (vendor). `bands` is the product band shell. */
  readonly shell = input<'columns' | 'bands'>('columns');

  protected readonly wrap = BAND_WRAP_CLASS;
}
