import { NgTemplateOutlet } from '@angular/common';
import { Component, afterNextRender, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { ProductDetail } from '@aeci/shared';

import { AecButton } from '../shared/button/button';
import { Analytics, type ExternalLinkContext } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { RequestDrawer } from '../requests/request-drawer';
import { RequestTrigger } from '../requests/request-trigger';
import { companySizeLabel, ownershipTypeLabel } from '../shared/company-facts/company-fact-labels';
import { FieldCaptionLine, type FieldCaptionPage } from '../shared/field-caption/field-caption';
import { correctionInSlot, isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';
import { SectionNav, type SectionNavItem } from '../shared/section-nav/section-nav';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

import { groupPoweredIntegrations } from './powered-hub-grouping';
import { ProductBuiltWithin, ProductExtensionsSection } from './product-extensions';
import { ProductHero } from './product-hero';
import { ProductIntegrationsSection } from './product-integrations-section';
import { ProductPoweredHub } from './product-powered-hub';
import { ProductReviews } from './product-reviews';
import { ProductUsefulnessSection } from './product-usefulness';
import { fieldOverrideLabel } from '../vendor/components/field-override-labels';
import { AecIcon } from '../shared/icon/icon';
import { AecCard } from '../shared/card/card';

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
 *   - `product` set → render the hero (`aec-product-hero`), the facts card,
 *     the description and the integrations sections inside the shared
 *     `DetailLayout` on its band shell (AECI-1778, DESIGN.md §4).
 *
 * Integrations section: extracted to `aec-product-integrations-section`
 * (AECI-841), which owns the §13.2/§13.3 lane split, the `@defer` cut, the
 * collapsible lane cards and the name filter. Nothing else on this page needs
 * any of the four, so the page component keeps only the facts card, the
 * powered section's render gates and the jump nav. The hero is its own
 * component (`product-hero.ts`).
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
    AecButton,
    AecCard,
    AecIcon,
    DetailLayout,
    ExternalLinkTracker,
    FieldCaptionLine,
    UnderReviewMarker,
    LogoOrInitial,
    MailingListSignup,
    NgTemplateOutlet,
    NewTabIcon,
    NotFound,
    ProductBuiltWithin,
    ProductExtensionsSection,
    ProductHero,
    ProductIntegrationsSection,
    ProductPoweredHub,
    ProductReviews,
    ProductUsefulnessSection,
    RequestDrawer,
    RequestTrigger,
    RouterLink,
    SectionNav,
    TaxonomyBadge,
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

        <!--
          The facts position on the band shell (AECI-1778): one elevated card that the
          layout pulls up over the hero's lower edge. Its groups are the shipped sidebar's,
          unchanged. Groups pair up into two columns from md and four from xl. AECI-1779
          rebuilds what the card holds.
        -->
        <div
          slot="metadata"
          aecCard
          class="grid gap-x-8 gap-y-6 p-6 md:grid-cols-2 md:p-8 xl:grid-cols-4"
          data-testid="product-facts"
        >
          <section aria-labelledby="vendor-card-title" class="space-y-3 md:col-span-2">
            <h2
              id="vendor-card-title"
              class="aec-overline text-(--text-secondary)"
              i18n="@@products.detail.metadata.vendor"
            >
              Vendor
            </h2>
            @if (p.vendor; as v) {
              <a
                [routerLink]="['/vendors', v.slug]"
                class="flex items-center gap-3 rounded-(--radius-lg) border
                  border-(--border-default) bg-(--surface-base) p-3 no-underline
                  transition-colors hover:border-(--border-strong)"
              >
                <aec-logo-or-initial
                  [claimStatus]="'server-filtered'"
                  [src]="v.logo_url"
                  [name]="v.name"
                  [alt]="logoAlt(v.name)"
                  size="sm"
                />
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="min-w-0 break-words font-semibold text-(--text-primary)">{{
                    v.name
                  }}</span>
                  @if (vendorFactsLine(); as line) {
                    <span
                      class="text-xs text-(--text-secondary)"
                      data-testid="product-vendor-facts"
                      >{{ line }}</span
                    >
                  }
                </span>
              </a>
            } @else {
              <p
                class="rounded-(--radius-lg) border border-(--border-default)
                  bg-(--surface-base) p-3 text-(--text-secondary)"
                i18n="@@products.detail.vendor.none"
              >
                No vendor listed
              </p>
            }
          </section>

          <!-- §13.3b (AECI-710): the host(s) this product is built within. The
               same card as Vendor because it is the same kind of fact: what the
               product IS. Never an integration, never counted. -->
          @if (p.extension_of.length > 0) {
            <section
              aec-product-built-within
              aria-labelledby="built-within-title"
              class="space-y-3 md:col-span-2"
              [hosts]="p.extension_of"
            ></section>
          }

          @if (p.categories.length > 0 || slotCorrection('category_slugs', false)) {
            <section aria-labelledby="categories-label" class="space-y-3">
              <h2
                id="categories-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.categories"
              >
                Categories
              </h2>
              @if (p.categories.length > 0) {
                <div class="flex flex-wrap gap-2">
                  @for (c of p.categories; track c.slug) {
                    <aec-taxonomy-badge kind="category" [slug]="c.slug" [name]="c.name" />
                  }
                </div>
              }
              <aec-field-caption
                [correction]="slotCorrection('category_slugs', p.categories.length > 0)"
                [page]="captionPage()"
              />
              @if (p.captions?.profile; as c) {
                <aec-field-caption
                  data-testid="profile-caption"
                  [caption]="c"
                  [page]="captionPage()"
                />
              }
            </section>
          }

          @if (p.audiences.length > 0 || slotCorrection('audience_slugs', false)) {
            <section aria-labelledby="audiences-label" class="space-y-3">
              <h2
                id="audiences-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.audiences"
              >
                Audiences
              </h2>
              @if (p.audiences.length > 0) {
                <div class="flex flex-wrap gap-2">
                  @for (d of p.audiences; track d.slug) {
                    <aec-taxonomy-badge kind="audience" [slug]="d.slug" [name]="d.name" />
                  }
                </div>
              }
              <aec-field-caption
                [correction]="slotCorrection('audience_slugs', p.audiences.length > 0)"
                [page]="captionPage()"
              />
            </section>
          }

          <!--
            Trades (AECI-544). Sparse by design: a product is tagged only when
            it has trade-specific value, so horizontal platforms render nothing
            here and the length guard is the common path. Never gated on the
            publication floor, because the tag is true even when the trade page
            isn't promoted yet (TRADES_VOCABULARY.md §6). Sits between Audiences
            and Project phases to match the facet sidebar's dimension order.
          -->
          @if (p.trades.length > 0 || slotCorrection('trade_slugs', false)) {
            <section aria-labelledby="trades-label" class="space-y-3">
              <h2
                id="trades-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.trades"
              >
                Trades
              </h2>
              @if (p.trades.length > 0) {
                <div class="flex flex-wrap gap-2">
                  @for (tr of p.trades; track tr.slug) {
                    <aec-taxonomy-badge kind="trade" [slug]="tr.slug" [name]="tr.name" />
                  }
                </div>
              }
              @if (slotCorrection('trade_slugs', p.trades.length > 0); as c) {
                <aec-field-caption [correction]="c" [page]="captionPage()" />
              }
            </section>
          }

          @if (p.phases.length > 0 || slotCorrection('phase_slugs', false)) {
            <section aria-labelledby="phases-label" class="space-y-3">
              <h2
                id="phases-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.phases"
              >
                Project phases
              </h2>
              @if (p.phases.length > 0) {
                <div class="flex flex-wrap gap-2">
                  @for (ph of p.phases; track ph.slug) {
                    <aec-taxonomy-badge kind="phase" [slug]="ph.slug" [name]="ph.name" />
                  }
                </div>
              }
              @if (slotCorrection('phase_slugs', p.phases.length > 0); as c) {
                <aec-field-caption [correction]="c" [page]="captionPage()" />
              }
            </section>
          }

          <!-- AECI-1309: the two Managed doc links. Shown on every plan when the
               product has a value; Managed is what lets the vendor edit them. -->
          @if (
            p.tool_integrations_url ||
            p.api_docs_url ||
            slotCorrection('tool_integrations_url', false) ||
            slotCorrection('api_docs_url', false) ||
            underReview('tool_integrations_url') ||
            underReview('api_docs_url')
          ) {
            <section aria-labelledby="resources-label" class="space-y-3">
              <h2
                id="resources-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.resources"
              >
                Resources
              </h2>
              <ul class="m-0 list-none space-y-2 p-0">
                @if (p.tool_integrations_url) {
                  <li>
                    <a
                      [href]="p.tool_integrations_url"
                      target="_blank"
                      rel="noopener nofollow"
                      aecTrackExternalLink="product_detail"
                      [aecLinkContext]="docsLinkContext('listing')!"
                      [class]="resourceLinkClass"
                    >
                      <ng-container i18n="@@products.detail.metadata.integrationsPage"
                        >Integrations page</ng-container
                      >
                      <aec-new-tab-icon />
                    </a>
                    @if (slotCorrection('tool_integrations_url', true); as c) {
                      <aec-field-caption class="mt-1" [correction]="c" [page]="captionPage()" />
                    }
                  </li>
                } @else if (underReview('tool_integrations_url')) {
                  <li>
                    <aec-under-review
                      data-testid="tool-integrations-under-review"
                      [label]="correctionLabel('tool_integrations_url')"
                    />
                  </li>
                } @else if (slotCorrection('tool_integrations_url', false); as c) {
                  <li>
                    <aec-field-caption
                      [correction]="c"
                      [label]="correctionLabel('tool_integrations_url')"
                      [page]="captionPage()"
                    />
                  </li>
                }
                @if (p.api_docs_url) {
                  <li>
                    <a
                      [href]="p.api_docs_url"
                      target="_blank"
                      rel="noopener nofollow"
                      aecTrackExternalLink="product_detail"
                      [aecLinkContext]="docsLinkContext('docs')!"
                      [class]="resourceLinkClass"
                    >
                      <ng-container i18n="@@products.detail.metadata.apiDocs"
                        >API documentation</ng-container
                      >
                      <aec-new-tab-icon />
                    </a>
                    @if (slotCorrection('api_docs_url', true); as c) {
                      <aec-field-caption class="mt-1" [correction]="c" [page]="captionPage()" />
                    }
                  </li>
                } @else if (underReview('api_docs_url')) {
                  <li>
                    <aec-under-review
                      data-testid="api-docs-under-review"
                      [label]="correctionLabel('api_docs_url')"
                    />
                  </li>
                } @else if (slotCorrection('api_docs_url', false); as c) {
                  <li>
                    <aec-field-caption
                      [correction]="c"
                      [label]="correctionLabel('api_docs_url')"
                      [page]="captionPage()"
                    />
                  </li>
                }
              </ul>
            </section>
          }

          <!-- AECI-1614: the Managed group's one caption (audiences, trades, phases and the
               two Resources links). One line, after the last of them, not one per group:
               the same sentence four times down a sidebar is noise that starts to read as
               a badge. A sibling of Resources, not inside it, because the group can hold
               facets alone and Resources then does not render. Below lg it spans the
               card, since it speaks for every column. -->
          @if (managedCaption(); as c) {
            <aec-field-caption
              class="md:col-span-2 xl:col-span-4"
              data-testid="managed-caption"
              [caption]="c"
              [page]="captionPage()"
            />
          }

          <section aria-labelledby="actions-label" class="space-y-3 md:col-span-2">
            <h2
              id="actions-label"
              class="aec-overline text-(--text-secondary)"
              i18n="@@products.detail.metadata.actions"
            >
              Actions
            </h2>
            <div class="flex flex-wrap gap-2">
              <a
                aecButton
                variant="secondary"
                aecRequestTrigger
                [entity]="'product'"
                [kind]="'claim'"
                [slug]="p.slug"
                [company]="p.vendor?.name ?? null"
                [contextProduct]="p.name"
                [href]="'/products/' + p.slug + '/claim'"
              >
                <aec-icon name="flag" decorative [size]="4" />
                <!-- AECI-1365: a claim is on the company (VENDOR_SIGNUP_PROCESS.md §3),
                     so the button names the product's vendor. -->
                @if (p.vendor?.name; as company) {
                  <ng-container i18n="@@products.detail.metadata.claimCompany"
                    >Claim {{ company }}</ng-container
                  >
                } @else {
                  <ng-container i18n="@@products.detail.metadata.claimYourCompany"
                    >Claim your company</ng-container
                  >
                }
              </a>
              <a
                aecButton
                variant="secondary"
                aecRequestTrigger
                [entity]="'product'"
                [kind]="'correction'"
                [slug]="p.slug"
                [href]="'/products/' + p.slug + '/correction'"
              >
                <aec-icon name="pen" decorative [size]="4" />
                <ng-container i18n="@@products.detail.metadata.correction"
                  >Suggest a correction</ng-container
                >
              </a>
            </div>
            <!-- AECI-1283: the vendor landing page, beside the claim button
                 (VENDOR_PROGRAM_PAGE_SPEC.md §2.4). Visitor-neutral, so it stays in
                 the cached HTML. It explains claiming, so it must not read like a
                 second claim button, and it opens a new tab so the visitor can come
                 back here to claim. ?vendor= lets the page's claim dialog skip the
                 search for this company. -->
            <a
              routerLink="/vendor-program"
              [queryParams]="p.vendor ? { vendor: p.vendor.slug } : {}"
              target="_blank"
              rel="noopener"
              data-testid="product-vendor-program-link"
              class="inline-flex items-center gap-1 text-sm font-semibold text-(--accent-primary)
                underline-offset-4 hover:text-(--accent-primary-hover) hover:underline
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                focus-visible:ring-offset-(--surface-base)"
              ><ng-container i18n="@@products.detail.metadata.vendorProgram"
                >Learn more about claiming</ng-container
              ><aec-new-tab-icon
            /></a>
          </section>
        </div>

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
          About goes in the LEAD slot, not the body slot: below lg the layout
          renders the metadata sidebar directly after this block, so the vendor /
          taxonomy / actions facts read as part of About instead of being dumped
          under Reviews at the foot of the page. At lg this is simply the top of
          column 1, and nothing moves. See DetailLayout.
        -->
        @if (p.description || underReview('description')) {
          <div slot="body-lead" class="space-y-12">
            <section id="about" aria-labelledby="description-title" class="scroll-mt-20 space-y-4">
              <h2
                id="description-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@products.detail.body.description"
              >
                About
              </h2>
              @if (p.description) {
                <p
                  class="max-w-prose break-words text-base leading-relaxed text-(--text-secondary)"
                >
                  {{ p.description }}
                </p>
                @if (p.captions?.description; as c) {
                  <aec-field-caption [caption]="c" [page]="captionPage()" />
                }
              } @else {
                <!-- AECI-1238 (§11d.7): AECi hid the description while it checks it. -->
                <aec-under-review data-testid="description-under-review" />
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

  protected readonly logoAlt = logoAlt;

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

  /** The vendor card's one line (AECI-1310). Sources stay on the vendor page. */
  protected readonly vendorFactsLine = computed<string | null>(() => {
    const facts = this.product()?.vendor_facts;
    if (!facts) return null;
    const parts: string[] = [];
    if (facts.company_size) {
      const size = companySizeLabel(facts.company_size);
      parts.push($localize`:@@products.detail.vendor.employees:${size}:SIZE: employees`);
    }
    if (facts.ownership_type) parts.push(ownershipTypeLabel(facts.ownership_type));
    return parts.length > 0 ? parts.join(' · ') : null;
  });

  /**
   * Ownership facts for the "Resources" links. The owner is the product's primary vendor.
   * The hero builds the same facts for "Visit website" (`product-hero.ts`).
   */
  protected readonly websiteLinkContext = computed<ExternalLinkContext | null>(() => {
    const p = this.product();
    if (!p) return null;
    return {
      owner_vendor_id: p.vendor?.id ?? null,
      link_origin: 'vendor',
      source_entity_type: 'product',
      source_entity_id: p.id,
      link_purpose: 'website',
    };
  });

  /**
   * The "Resources" links (AECI-1309): the integrations page is `listing`, the API
   * docs are `docs`, with the same owner rule as the website click
   * (`VENDOR_PERFORMANCE_SPEC.md` §3.2).
   */
  protected docsLinkContext(purpose: 'listing' | 'docs'): ExternalLinkContext | null {
    const website = this.websiteLinkContext();
    return website ? { ...website, link_purpose: purpose } : null;
  }

  protected readonly resourceLinkClass =
    'inline-flex items-center gap-1.5 text-sm font-semibold text-(--accent-primary) ' +
    'underline-offset-4 hover:text-(--accent-primary-hover) hover:underline ' +
    'focus-visible:outline-none focus-visible:rounded-(--radius-sm) focus-visible:ring-2 ' +
    'focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2 ' +
    'focus-visible:ring-offset-(--surface-base)';

  /** The page, for each caption's source link click. */
  protected readonly captionPage = computed<FieldCaptionPage>(() => ({
    surface: 'product_detail',
    entityType: 'product',
    entityId: this.product()?.id ?? '',
  }));

  protected readonly correctionLabel = fieldOverrideLabel;

  /**
   * AECi's correction in one value's slot (AECI-1628): a value-setting one while the
   * value shows, a removal while it does not.
   */
  protected slotCorrection(field: string, present: boolean) {
    return correctionInSlot(this.product()?.captions?.corrections, field, present);
  }

  /** AECI-1238 (§11d.7): whether AECi hid `field` while it checks it. */
  protected underReview(field: string): boolean {
    return isUnderReview(this.product()?.under_review, field);
  }

  /**
   * The Managed group's caption, while the group shows anything. A vendor can clear every
   * field in it, and a caption under nothing says nothing. Categories and the website are
   * not in the group (`field-captions.ts`).
   */
  protected readonly managedCaption = computed(() => {
    const p = this.product();
    if (!p) return null;
    const hasValues =
      p.audiences.length > 0 ||
      p.trades.length > 0 ||
      p.phases.length > 0 ||
      !!p.tool_integrations_url ||
      !!p.api_docs_url;
    return hasValues ? (p.captions?.managed ?? null) : null;
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
    if (p.description || isUnderReview(p.under_review, 'description')) {
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
    return items;
  });
}
