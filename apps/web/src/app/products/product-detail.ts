import { NgTemplateOutlet } from '@angular/common';
import { Component, afterNextRender, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { ProductDetail } from '@aeci/shared';
import { connectorKindFor } from '@aeci/shared/api/connector-kind';

import { Analytics } from '../analytics/analytics';
import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { RequestDrawer } from '../requests/request-drawer';
import { correctionLabel } from '../shared/field-caption/correction-labels';
import type { FieldCaptionPage } from '../shared/field-caption/field-caption';
import {
  correctionsInSlots,
  countUnderReview,
  isUnderReview,
} from '../shared/field-caption/field-caption-facts';
import {
  ListingProvenance,
  type ProvenanceCorrection,
  type ProvenanceGroup,
} from '../shared/listing-provenance/listing-provenance';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { SectionNav, type SectionNavItem } from '../shared/section-nav/section-nav';

import { poweredNavLabel } from './connector-kind-labels';
import { countLaneUnderReview, splitIntegrationLanes } from './connector-lane-grouping';
import { groupPoweredIntegrations } from './powered-hub-grouping';
import { ProductAbout } from './product-about';
import { ProductExtensionsSection } from './product-extensions';
import { ProductFactsCard } from './product-facts-card';
import { ProductHero } from './product-hero';
import { ProductIntegrationsSection } from './product-integrations-section';
import { ProductPoweredHub } from './product-powered-hub';
import { ProductReviews } from './product-reviews';
import { ProductSimilarProducts } from './product-similar-products';
import { ProductUsefulnessSection } from './product-usefulness';
import { ProductWhatItSyncs, hasWhatItSyncs } from './product-what-it-syncs';
import { ProductWhoItIsFor, hasWhoItIsFor } from './product-who-it-is-for';

/** A product field group, as the provenance panel names it (AECI-1666). */
type ProductCaptionGroup = 'description' | 'profile' | 'usefulness' | 'managed';

/** The panel's name for each product field group: the page's own section names. */
function groupLabel(group: ProductCaptionGroup): string {
  switch (group) {
    case 'description':
      return $localize`:@@products.detail.provenance.group.description:About`;
    case 'profile':
      return $localize`:@@products.detail.provenance.group.profile:Website and categories`;
    case 'usefulness':
      return $localize`:@@products.detail.provenance.group.usefulness:How teams use it`;
    case 'managed':
      return $localize`:@@products.detail.provenance.group.managed:Audiences, trades, phases and resources`;
  }
}

/**
 * Every field this page marks "Under review" in its slot (AECI-1238): the website in the
 * hero, the two Resources links in the facts card and the description in the About band.
 * The panel's count reads this list (AECI-1666). The children mount the markers, so a new
 * marker in one of them must be added here too.
 */
const UNDER_REVIEW_MARKED_FIELDS = [
  'website',
  'tool_integrations_url',
  'api_docs_url',
  'description',
] as const;

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
    ListingProvenance,
    MailingListSignup,
    NgTemplateOutlet,
    NotFound,
    ProductAbout,
    ProductExtensionsSection,
    ProductFactsCard,
    ProductHero,
    ProductIntegrationsSection,
    ProductPoweredHub,
    ProductReviews,
    ProductSimilarProducts,
    ProductUsefulnessSection,
    ProductWhatItSyncs,
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
              <!-- The label, "About {product}" and the description (AECI-1720 restore). -->
              <aec-product-about [product]="p" />
              @if (hasWhoItIsFor()) {
                <aec-product-who-it-is-for class="min-w-0" [product]="p" />
              }
            </section>
          </div>
        }

        <!-- Mock-up 6 .band + .band.plain + .band.plain (AECI-1720 restore): each body
             section is its own white band, 64px of space above and below, 96px from md,
             with a hairline between neighbours. The colour is the unlayered border rule's
             --border-default. The body band's own padding gives the first and last their
             outer space. Usefulness mounts on the same test as its nav entry, so a hidden
             host never takes a band. -->
        <div
          slot="body"
          class="divide-y [&>*]:py-16 md:[&>*]:py-24 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0"
          data-testid="product-body-bands"
        >
          @if (hasUsefulness() && p.usefulness; as u) {
            <aec-product-usefulness
              id="how-teams-use-it"
              class="scroll-mt-20"
              [data]="u"
              [productName]="p.name"
            />
          }

          <!-- AECI-2046 (ruling 15 on AECI-2035): a Sync Service's "What it syncs"
               block, ahead of the pairs it delivers. The API sends both parts as null
               on any other product, and the page mounts it only with something in it. -->
          @if (showWhatItSyncs()) {
            <section
              aec-product-what-it-syncs
              id="what-it-syncs"
              aria-labelledby="what-it-syncs-title"
              data-testid="what-it-syncs"
              [productName]="p.name"
              [syncs]="p.what_it_syncs ?? null"
              [syncFacts]="p.sync_facts ?? null"
            ></section>
          }

          <!-- Powered ("this product IS the connector") integrations, per Stage
               1.5 Addendum B. Distinct from the endpoint table: these edges name
               this product in powered_by_product_id, so it is neither endpoint and
               the endpoint table is legitimately empty for a pure connector.

               Declared as a template and rendered through an outlet on either side
               of #integrations, because §13.6 swaps the two sections on a connector
               page. The swap has to move real DOM order: CSS order would leave
               screen readers and crawlers on the old sequence (WCAG 1.3.2).
               <ng-container> emits no element, so the body's bands still land on
               the sections themselves. -->
          <ng-template #poweredSection>
            <section
              aec-product-powered-hub
              id="powered-integrations"
              aria-labelledby="powered-integrations-title"
              class="scroll-mt-20 space-y-4"
              [view]="poweredView()"
              [slug]="p.slug"
              [kind]="connectorKind()"
            ></section>
          </ng-template>

          @if (leadWithPowered()) {
            <ng-container [ngTemplateOutlet]="poweredSection" />
          }

          <!-- AECI-2046 (ruled 2026-11-24): hidden, with its nav link, on a page that
               only powers pairs and has nothing of its own to say here. -->
          @if (showIntegrations()) {
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
              [product]="p"
              [poweredPairCount]="poweredView().pairCount"
            ></section>
          }

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

          <!-- AECI-1666: "About this listing", the page's one provenance panel, as the last
               band. The band shell has no sidebar, so both copies sit here: the card from
               lg, the closed disclosure below it. Only the card copy carries the test id.
               One wrapper, so the pair is one band of the divided body. -->
          <div data-testid="listing-provenance-band">
            <aec-listing-provenance
              data-testid="listing-provenance"
              variant="card"
              [maintainedBy]="p.maintenance.maintained_by"
              [reviewedAt]="p.maintenance.last_reviewed_at"
              [ownerName]="p.vendor?.name ?? null"
              [claimed]="p.claim_status !== 'unclaimed'"
              [groups]="provenance().groups"
              [corrections]="provenance().corrections"
              [underReviewCount]="provenance().underReviewCount"
              [integrationsNote]="provenance().integrationsNote"
              [page]="captionPage()"
            />
            <aec-listing-provenance
              variant="disclosure"
              [maintainedBy]="p.maintenance.maintained_by"
              [reviewedAt]="p.maintenance.last_reviewed_at"
              [ownerName]="p.vendor?.name ?? null"
              [claimed]="p.claim_status !== 'unclaimed'"
              [groups]="provenance().groups"
              [corrections]="provenance().corrections"
              [underReviewCount]="provenance().underReviewCount"
              [integrationsNote]="provenance().integrationsNote"
              [page]="captionPage()"
            />
          </div>
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

  /** The page, for a correction's source link click in "About this listing". */
  protected readonly captionPage = computed<FieldCaptionPage>(() => ({
    surface: 'product_detail',
    entityType: 'product',
    entityId: this.product()?.id ?? '',
  }));

  /**
   * What "About this listing" holds (AECI-1666). Each group's caption shows while the
   * group shows anything, because a caption on a group the page does not render says
   * nothing. A correction is listed only where the page has its slot (§4.5.8): one that
   * set a value while the value renders, one that cleared it while the slot is empty. The
   * under-review count is every marker the page mounts: the product fields it marks, plus
   * each Integrations row's markers (`countLaneUnderReview`). The integrations note shows
   * when any row carried a caption or a correction, since the rows no longer say so
   * themselves.
   */
  protected readonly provenance = computed<{
    groups: readonly ProvenanceGroup[];
    corrections: readonly ProvenanceCorrection[];
    underReviewCount: number;
    integrationsNote: boolean;
  }>(() => {
    const p = this.product();
    if (!p) return { groups: [], corrections: [], underReviewCount: 0, integrationsNote: false };
    const captions = p.captions;
    // `managed` covers the two Resources links, audiences, trades and phases; `profile`
    // covers the website and categories (`apps/api/src/lib/field-captions.ts`).
    const shown = {
      description: !!p.description,
      profile: !!p.website || p.categories.length > 0,
      usefulness: this.hasUsefulness(),
      managed:
        p.audiences.length > 0 ||
        p.trades.length > 0 ||
        p.phases.length > 0 ||
        !!p.tool_integrations_url ||
        !!p.api_docs_url,
    };
    const groups: ProvenanceGroup[] = [];
    const add = (caption: ProvenanceGroup['caption'] | null | undefined, label: string) => {
      if (caption) groups.push({ label, caption });
    };
    if (shown.description) add(captions?.description, groupLabel('description'));
    if (shown.profile) add(captions?.profile, groupLabel('profile'));
    if (shown.usefulness) add(captions?.usefulness, groupLabel('usefulness'));
    if (shown.managed) add(captions?.managed, groupLabel('managed'));
    const rows = [...p.integrations_as_source, ...p.integrations_as_target];
    return {
      groups,
      corrections: correctionsInSlots(captions?.corrections, {
        logo_url: !!p.logo_url,
        website: !!p.website,
        tool_integrations_url: !!p.tool_integrations_url,
        api_docs_url: !!p.api_docs_url,
        category_slugs: p.categories.length > 0,
        audience_slugs: p.audiences.length > 0,
        trade_slugs: p.trades.length > 0,
        phase_slugs: p.phases.length > 0,
      }).map((correction) => ({ correction, label: correctionLabel(correction.field) })),
      // The page's own markers plus one per row marker, from the same lane split the
      // Integrations section renders, so the two cannot drift.
      underReviewCount:
        countUnderReview(p.under_review, UNDER_REVIEW_MARKED_FIELDS) +
        countLaneUnderReview(
          splitIntegrationLanes(p.integrations_as_source, p.integrations_as_target),
        ),
      integrationsNote: rows.some((row) => !!row.caption || (row.corrections?.length ?? 0) > 0),
    };
  });

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
   * Whether the "What it syncs" block renders (AECI-2046): a Sync Service with at least
   * one record type or one curated fact. The nav entry reads the same test.
   */
  protected readonly showWhatItSyncs = computed(() => {
    const p = this.product();
    return !!p && hasWhatItSyncs(p.what_it_syncs, p.sync_facts);
  });

  /**
   * Whether `#integrations` renders (AECI-2046, ruled by Chris 2026-11-24). It hides,
   * with its nav link, on a page that lists pairs under "Integrations it powers" and
   * has nothing of its own for that section: no endpoint row, no "runs inside {host}"
   * sentence and no §13.7 reach line. After AECI-2050 that section would print only its
   * heading. A product with no integrations of any kind keeps the section and its empty
   * state, because the powered count is zero there.
   */
  protected readonly showIntegrations = computed(() => {
    const p = this.product();
    if (!p) return false;
    if (this.poweredView().pairCount === 0) return true;
    const endpointRows = p.integrations_as_source.length + p.integrations_as_target.length;
    return endpointRows > 0 || p.extension_of.length > 0 || p.reachable_pair_count > 0;
  });

  /**
   * The page product's connector kind (AECI-2037), or `null`: the powered section's
   * heading, empty state and nav label read it.
   */
  protected readonly connectorKind = computed(() => {
    const p = this.product();
    return p ? connectorKindFor(p.product_role, p.connector_kind) : null;
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
    // AECI-2046: the block leads the integrations sections, so its entry does too.
    if (this.showWhatItSyncs()) {
      items.push({
        id: 'what-it-syncs',
        label: $localize`:@@products.detail.nav.whatItSyncs:What it syncs`,
      });
    }
    // AECI-2046: gated on the section's own condition, so the nav never links to it
    // when it is hidden.
    const integrations: SectionNavItem | null = this.showIntegrations()
      ? { id: 'integrations', label: $localize`:@@products.detail.nav.integrations:Integrations` }
      : null;
    // Gated on the same condition as the section itself, or the nav would link
    // to an anchor that isn't on the page. Label matches the section heading
    // verbatim (minus the count) so the two never read as different sections —
    // they sit next to each other, which is exactly the pair the pronoun is
    // there to separate.
    const powered: SectionNavItem | null = this.showPowered()
      ? {
          id: 'powered-integrations',
          label: poweredNavLabel(this.connectorKind()),
        }
      : null;
    // §13.6: "section-nav follows render order", so the connector swap moves
    // these two together. No anchor id changes, so there is no link, sitemap or
    // cache-tag churn to manage.
    if (powered && this.leadWithPowered()) {
      items.push(powered);
      if (integrations) items.push(integrations);
    } else {
      if (integrations) items.push(integrations);
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
