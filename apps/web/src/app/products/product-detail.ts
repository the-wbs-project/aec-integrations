import { NgTemplateOutlet } from '@angular/common';
import { Component, afterNextRender, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { ProductDetail } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { RequestDrawer } from '../requests/request-drawer';
import { FieldCaptionLine, type FieldCaptionPage } from '../shared/field-caption/field-caption';
import { isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { SectionNav, type SectionNavItem } from '../shared/section-nav/section-nav';

import { groupPoweredIntegrations } from './powered-hub-grouping';
import { ProductExtensionsSection } from './product-extensions';
import { ProductFactsCard } from './product-facts-card';
import { ProductHero } from './product-hero';
import { ProductIntegrationsSection } from './product-integrations-section';
import { ProductPoweredHub } from './product-powered-hub';
import { ProductReviews } from './product-reviews';
import { ProductSimilarProducts } from './product-similar-products';
import { ProductUsefulnessSection } from './product-usefulness';
import { ProductWhoItIsFor, hasWhoItIsFor } from './product-who-it-is-for';

/**
 * AECI-57 — Product detail page at `/products/:slug`.
 *
 * Single page with sections (sub-routes were explicitly rejected by the
 * Phase 2 decision — see §3.2). All data is supplied by
 * `productDetailResolver` via `route.data['product']`:
 *
 *   - `product === null` → render the global `aec-not-found` shell (AECI-62);
 *     the resolver already set `RESPONSE_INIT.status = 404` and
 *     `MetaService.setNotFoundMeta`. URL stays at /products/:slug so the
 *     visitor can correct a typo in place — no router redirect.
 *   - `product` set → render the hero (`aec-product-hero`), the facts card
 *     (`aec-product-facts-card`), the description and the integrations sections
 *     inside the shared `DetailLayout` on its band shell (AECI-1778, DESIGN.md §4).
 *
 * Integrations section: extracted to `aec-product-integrations-section`
 * (AECI-841), which owns the §13.2/§13.3 lane split, the `@defer` cut, the
 * collapsible lane cards and the name filter. Nothing else on this page needs
 * any of the four, so the page component keeps only the powered section's
 * render gates and the jump nav. The hero (`product-hero.ts`) and the facts
 * card (`product-facts-card.ts`, AECI-1779) are their own components.
 *
 * Powered-integrations section (Stage 1.5 Addendum B): a *second*, distinct
 * integrations surface for connector-role products. The table above lists edges
 * this product TERMINATES; `#powered-integrations` lists edges it POWERS
 * (`integrations.powered_by_product_id`), where it is the mechanism and neither
 * endpoint — so a pure connector's endpoint table is legitimately empty while
 * its real value sits here. Rendered as a grouped hub view
 * (`aec-product-powered-hub`), not a table.
 *
 * Role-varied ordering (Stage 1.5 Addendum C, §13.6 / AECI-707): on
 * `product_role === 'connector'` with a populated hub, `#powered-integrations`
 * renders BEFORE `#integrations` and the section-nav follows. `hybrid` and
 * `application` keep the default order. The section is declared once as an
 * `<ng-template>` and placed by an `ngTemplateOutlet` on whichever side wins, so
 * the swap moves real DOM order rather than visual order. Anchor ids never
 * change, so there is no link, sitemap or cache-tag churn.
 *
 * Cache discipline: tags are written by the SSR runtime (vendor + each
 * integration shown, both endpoints of each powered edge). The arrival page
 * view is written by the SSR gateway, not this page. Nothing here triggers
 * HTTP: hydration reads the resolved data out of `route.data`.
 */
@Component({
  selector: 'aec-product-detail',
  imports: [
    DetailLayout,
    FieldCaptionLine,
    UnderReviewMarker,
    MailingListSignup,
    NgTemplateOutlet,
    NotFound,
    ProductExtensionsSection,
    ProductFactsCard,
    ProductHero,
    ProductIntegrationsSection,
    ProductPoweredHub,
    ProductReviews,
    ProductSimilarProducts,
    ProductUsefulnessSection,
    ProductWhoItIsFor,
    RequestDrawer,
    SectionNav,
  ],
  template: `
    @let p = product();
    @if (p === null) {
      <aec-not-found />
    } @else {
      <aec-detail-layout shell="bands">
        <!-- The Forest hero (AECI-1778): breadcrumb, name, vendor, ratings and the two
             actions, in its own component so the other product-page issues do not collide
             here. It renders the page's only h1. -->
        <aec-product-hero slot="hero" [product]="p" />

        <!-- The facts card (AECI-1779): one elevated card that the layout pulls up over the
             hero's lower edge. Its own component, like the hero. -->
        <aec-product-facts-card slot="metadata" [product]="p" />

        <!--
          The nav takes its own slot rather than riding along in the body: the
          layout projects it bare into the page container so its sticky bound is
          the whole page. Inside a body column it would unstick partway down. The
          bottom margin is on the nav itself for the same reason: it has no
          wrapper to inherit spacing from. See DetailLayout.
        -->
        @if (sectionNav().length >= 2) {
          <aec-section-nav slot="nav" rest="clear" [pageName]="p.name" [sections]="sectionNav()" />
        }

        <!--
          About is the page's one Bone band (AECI-1780, mock-up 6): the description on the
          left and "Who it is for" on the right from lg, stacked below it. It goes in the
          LEAD slot, which the band shell paints Bone. It renders when either column has
          something to show, and the section nav applies the same test (hasAbout).
        -->
        @if (hasAbout()) {
          <div slot="body-lead">
            <section
              id="about"
              aria-labelledby="description-title"
              class="grid scroll-mt-20 items-start"
              [class]="aboutColumns()"
            >
              <div class="min-w-0 space-y-6">
                <h2 id="description-title">
                  <span
                    class="font-display text-t-36 font-semibold tracking-[-0.02em] text-(--text-primary)"
                    i18n="@@products.detail.body.description"
                    >About</span
                  >
                </h2>
                @if (p.description) {
                  <p
                    class="max-w-prose break-words text-t-16 leading-relaxed text-(--text-primary) md:text-t-20"
                    data-testid="product-description"
                  >
                    {{ p.description }}
                  </p>
                  @if (p.captions?.description; as c) {
                    <aec-field-caption [caption]="c" [page]="captionPage()" />
                  }
                } @else if (underReview('description')) {
                  <!-- AECI-1238 (§11d.7): AECi hid the description while it checks it. -->
                  <aec-under-review data-testid="description-under-review" />
                }
              </div>
              @if (hasWhoItIsFor()) {
                <aec-product-who-it-is-for class="min-w-0" [product]="p" [page]="captionPage()" />
              }
            </section>
          </div>
        }

        <div slot="body" class="space-y-12">
          @if (p.usefulness; as u) {
            <aec-product-usefulness
              id="how-teams-use-it"
              class="scroll-mt-20"
              [data]="u"
              [caption]="p.captions?.usefulness"
              [page]="captionPage()"
            />
          }

          <!-- Powered ("this product IS the connector") integrations, per Stage
               1.5 Addendum B. Distinct from the endpoint table: these edges name
               this product in powered_by_product_id, so it is neither endpoint and
               the endpoint table is legitimately empty for a pure connector.

               Declared as a template and rendered through an outlet on either side
               of #integrations, because §13.6 swaps the two sections on a connector
               page. The swap has to move real DOM order: CSS order would leave
               screen readers and crawlers on the old sequence (WCAG 1.3.2).
               <ng-container> emits no element, so the body's space-y-12 still lands
               on the sections themselves. -->
          <ng-template #poweredSection>
            <section
              aec-product-powered-hub
              id="powered-integrations"
              aria-labelledby="powered-integrations-title"
              class="scroll-mt-20 space-y-4"
              [view]="poweredView()"
              [slug]="p.slug"
            ></section>
          </ng-template>

          @if (leadWithPowered()) {
            <ng-container [ngTemplateOutlet]="poweredSection" />
          }

          <section
            aec-product-integrations-section
            id="integrations"
            aria-labelledby="integrations-title"
            class="scroll-mt-20 space-y-4"
            [slug]="p.slug"
            [asSource]="p.integrations_as_source"
            [asTarget]="p.integrations_as_target"
            [reachableCount]="p.reachable_pair_count"
            [productName]="p.name"
            [hosts]="p.extension_of"
          ></section>

          @if (showPowered() && !leadWithPowered()) {
            <ng-container [ngTemplateOutlet]="poweredSection" />
          }

          <!-- §13.3b (AECI-710): products built within this one. After every
               integrations section and outside it: an extension is not an edge,
               so it is never a lane of #integrations and never in its count. -->
          @if (p.extensions.length > 0) {
            <section
              aec-product-extensions-section
              id="extensions"
              aria-labelledby="extensions-title"
              class="scroll-mt-20 space-y-4"
              [productName]="p.name"
              [extensions]="p.extensions"
            ></section>
          }

          <section id="reviews" aria-labelledby="reviews-title" class="scroll-mt-20">
            <aec-product-reviews
              [slug]="p.slug"
              [productId]="p.id"
              [reviewCount]="p.review_count"
              [ratingOverallAvg]="p.rating_overall_avg"
              [ratingOnboardingAvg]="p.rating_onboarding_avg"
              [firstPage]="p.reviews"
            />
          </section>

          <!-- AECI-1785: the last section, hidden with its nav link when the list is empty. -->
          @if (p.related_products.length > 0) {
            <section
              aec-product-similar-products
              id="similar"
              aria-labelledby="similar-title"
              [productName]="p.name"
              [products]="p.related_products"
            ></section>
          }
        </div>
      </aec-detail-layout>

      <!-- White on the band shell: the About band is the page's one Bone band. -->
      <aec-mailing-list-signup ground="white" />

      <!-- In-place claim/correction drawer (AECI-128); opened by the
           aecRequestTrigger anchors above. Renders nothing until opened. -->
      <aec-request-drawer />
    }
  `,
})
export class ProductDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly analytics = inject(Analytics);

  /**
   * Resolved data. `productDetailResolver` runs server-side and on hydration
   * reads from `TransferState`; the snapshot value is the SSR-resolved
   * product (or null on a NOT_FOUND).
   */
  protected readonly product = toSignal<ProductDetail | null, ProductDetail | null>(
    this.route.data.pipe(map((d) => (d['product'] ?? null) as ProductDetail | null)),
    { initialValue: (this.route.snapshot.data['product'] ?? null) as ProductDetail | null },
  );

  constructor() {
    // Browser-only `product_viewed` (§14.1). `afterNextRender` keeps it out of
    // SSR; consent-gating + fire-and-forget live in `Analytics`. A fresh
    // component instance per route means this fires once per product view.
    afterNextRender(() => {
      const p = this.product();
      if (p) this.analytics.productViewed(p.id);
    });
  }

  /** The page, for the About caption's source link click. */
  protected readonly captionPage = computed<FieldCaptionPage>(() => ({
    surface: 'product_detail',
    entityType: 'product',
    entityId: this.product()?.id ?? '',
  }));

  /** AECI-1238 (§11d.7): whether AECi hid `field` while it checks it. */
  protected underReview(field: string): boolean {
    return isUnderReview(this.product()?.under_review, field);
  }

  /** Whether the About band's "Who it is for" column renders (AECI-1780). */
  protected readonly hasWhoItIsFor = computed(() => {
    const p = this.product();
    return !!p && hasWhoItIsFor(p);
  });

  /**
   * Whether the About band renders: the description, its under-review marker, or "Who it
   * is for". An empty band does not render, and the section nav drops it (AECI-1780).
   */
  protected readonly hasAbout = computed(() => {
    const p = this.product();
    if (!p) return false;
    return !!p.description || isUnderReview(p.under_review, 'description') || this.hasWhoItIsFor();
  });

  /**
   * Ruling 36 (2026-11-16): the About band splits into two columns only when the left
   * column has the description or its under-review line. With neither, "Who it is for"
   * takes the band's full width under the heading, 24px below it as the description
   * would sit. Product data only, so the server and the browser render the same layout.
   */
  protected readonly aboutColumns = computed(() => {
    const p = this.product();
    const hasDescription = !!p?.description || isUnderReview(p?.under_review, 'description');
    return hasDescription
      ? 'gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-12'
      : 'gap-6';
  });

  /**
   * Whether the "Integrations it powers" section renders. Three branches, in
   * order (Stage 1.5 §12.3 as amended by §13.4(2) / AECI-707):
   *
   * 1. **Populated → show.** Anything the section can actually render, whatever
   *    the role — an application that powers edges is a data-driven safety net
   *    for a product whose `product_role` hasn't caught up with its data.
   * 2. **Emptied by self-exclusion → hide.** The product has powered edges but
   *    every one of them names the product itself as an endpoint (the review
   *    app's Convention A, §13.2a), so `groupPoweredIntegrations` filtered them
   *    all out and they are rendering in `#integrations` instead. §12.3's
   *    always-render rule exists so a connector page never reads as "integrates
   *    with nothing"; on a page whose endpoint table carries every one of those
   *    edges that purpose is already met, and the empty state would contradict
   *    the hero line directly above it ("Connects N products" over "powers 0,
   *    none recorded yet, suggest a correction", soliciting data already on
   *    the page).
   * 3. **Genuinely none → §12.3's empty state**, for connector / hybrid only.
   *    "We have no record of this connector powering anything" is a different
   *    claim from branch 2, and it is worth inviting a correction for.
   */
  protected readonly showPowered = computed(() => {
    const p = this.product();
    if (!p) return false;
    if (this.poweredView().pairCount > 0) return true;
    if (p.integrations_as_connector.length > 0) return false;
    return p.product_role !== 'application';
  });

  /**
   * Whether `#powered-integrations` renders BEFORE `#integrations` (§13.6).
   *
   * On a pure connector the endpoint table is legitimately sparse and the
   * powered set is the page's entire subject, so it leads. **`hybrid` and
   * `application` keep the default order**: on a hybrid the endpoint table is
   * real content, and swapping would demote it.
   *
   * Guarded on the section having content, which §13.6 did not anticipate: it
   * rejected a *comparative* "swap when powered exceeds endpoint" rule, on the
   * grounds that page order would shift under readers as data moves. This is
   * the degenerate empty/non-empty case instead. Without it the swap would lead
   * with an empty section on a Convention-A connector or one with no powered
   * edges.
   */
  protected readonly leadWithPowered = computed(() => {
    const p = this.product();
    if (!p) return false;
    return p.product_role === 'connector' && this.poweredView().pairCount > 0;
  });

  /**
   * The Addendum B hub view, computed HERE rather than inside
   * `ProductPoweredHub` and passed down, because three page-level decisions
   * read the same pair count: `showPowered`, `leadWithPowered` and the
   * section-nav. The section's own `<h2>` count reads this same object, so the
   * heading and the rendered rows are provably the same set. The page slug is
   * the §13.4(2) self-exclusion — see `groupPoweredIntegrations`.
   */
  protected readonly poweredView = computed(() => {
    const p = this.product();
    if (!p) return groupPoweredIntegrations([], '');
    return groupPoweredIntegrations(p.integrations_as_connector, p.slug);
  });

  /**
   * Whether the "How teams use it" section actually renders. Mirrors
   * `ProductUsefulnessSection.hasContent` (product-usefulness.ts) — that child
   * hides itself via `[hidden]` when a non-null `usefulness` carries no usable
   * points, so the jump nav must apply the same test or it would link to a
   * collapsed section.
   */
  protected readonly hasUsefulness = computed(() => {
    const u = this.product()?.usefulness;
    if (!u) return false;
    return (
      u.audiences.some((g) => g.points.length > 0) || u.phases.some((g) => g.points.length > 0)
    );
  });

  /**
   * Present body sections, in render order, for the sticky in-page nav. Only
   * sections that are actually on the page are listed; Integrations always is
   * (its empty state still renders). The parent owns the (localized) labels so
   * `SectionNav` stays generic.
   */
  protected readonly sectionNav = computed<readonly SectionNavItem[]>(() => {
    const p = this.product();
    if (!p) return [];
    const items: SectionNavItem[] = [];
    if (this.hasAbout()) {
      items.push({ id: 'about', label: $localize`:@@products.detail.nav.about:About` });
    }
    if (this.hasUsefulness()) {
      items.push({
        id: 'how-teams-use-it',
        label: $localize`:@@products.detail.nav.usefulness:How teams use it`,
      });
    }
    const integrations: SectionNavItem = {
      id: 'integrations',
      label: $localize`:@@products.detail.nav.integrations:Integrations`,
    };
    // Gated on the same condition as the section itself, or the nav would link
    // to an anchor that isn't on the page. Label matches the section heading
    // verbatim (minus the count) so the two never read as different sections —
    // they sit next to each other, which is exactly the pair the pronoun is
    // there to separate.
    const powered: SectionNavItem | null = this.showPowered()
      ? {
          id: 'powered-integrations',
          label: $localize`:@@products.detail.nav.powers:Integrations it powers`,
        }
      : null;
    // §13.6: "section-nav follows render order", so the connector swap moves
    // these two together. No anchor id changes, so there is no link, sitemap or
    // cache-tag churn to manage.
    if (powered && this.leadWithPowered()) {
      items.push(powered, integrations);
    } else {
      items.push(integrations);
      if (powered) items.push(powered);
    }
    // Gated on the same condition as the section, after every integrations
    // entry because the section renders after them (§13.3b).
    if (p.extensions.length > 0) {
      items.push({
        id: 'extensions',
        label: $localize`:@@products.detail.nav.extensions:Extensions`,
        count: p.extensions.length,
      });
    }
    // Reviews always renders (its empty state still does), so it is always in
    // the nav — same rule as Integrations above.
    // Counts are quiet facts about the section (AECI-1768), the same figures the sections
    // print. Integrations carries none yet: its count lives in the integrations section and
    // AECI-1782 rebuilds it, so the bar would risk a second, disagreeing figure.
    items.push({
      id: 'reviews',
      label: $localize`:@@products.detail.nav.reviews:Reviews`,
      count: p.review_count,
    });
    // AECI-1785: gated on the same condition as the section, which renders last.
    if (p.related_products.length > 0) {
      items.push({
        id: 'similar',
        label: $localize`:@@products.detail.nav.similar:Similar products`,
      });
    }
    return items;
  });
}
