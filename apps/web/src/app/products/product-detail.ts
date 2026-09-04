import { NgTemplateOutlet } from '@angular/common';
import { Component, afterNextRender, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { ProductDetail } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { RequestDrawer } from '../requests/request-drawer';
import { RequestTrigger } from '../requests/request-trigger';
import { ReviewCta } from '../reviews/review-cta';
import { ReviewStars } from '../reviews/review-stars';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { MaintenanceMarker } from '../shared/maintenance-marker/maintenance-marker';
import { SectionNav, type SectionNavItem } from '../shared/section-nav/section-nav';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';
import { VerifiedBadge } from '../shared/verified-badge/verified-badge';

import {
  applyDeferCut,
  INTEGRATIONS_ABOVE_FOLD,
  splitIntegrationLanes,
  type IntegrationLaneView,
} from './connector-lane-grouping';
import { connectedProductCount, groupPoweredIntegrations } from './powered-hub-grouping';
import { ProductIntegrationsTable } from './product-integrations-table';
import { ProductPoweredHub } from './product-powered-hub';
import { ProductReviews } from './product-reviews';
import { ProductUsefulnessSection } from './product-usefulness';
import { RoleBadge } from './role-badge';

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
 *   - `product` set → render hero / metadata sidebar / description /
 *     integrations sections inside the shared `DetailLayout`.
 *
 * Integrations section: column-aligned tables (partner · direction ·
 * connection), one `ProductIntegrationRow` per rendered row — replacing the old
 * stack of near-identical cards, which was hard to scan and nested an `<a>`
 * (partner product) inside an `<a>` (pair page).
 *
 * Since AECI-713 the section is SPLIT into lanes (`STAGE_1_5_SPEC.md` §13.3):
 * the direct list first, then one "Via {connector}" group per connector, each
 * lane its own `<table>` (a group-header row inside a shared `<tbody>` has no
 * accessible name relationship to the rows under it). It stays ONE section with
 * one anchor and one section-nav entry, and a page with no connector-delivered
 * edges renders the single unheaded table it always did. `lanes()` does the
 * routing and the pair collapse; `connector-lane-grouping.ts` holds the rules.
 *
 * If the section exceeds 20 rows, everything past the first 20 ships as deferred
 * `<tr>`s in an `@defer (on viewport; hydrate on viewport)` block. The budget is
 * spent across the FLATTENED lane order, so it lands after 20 visible rows
 * rather than 20 rows into every lane.
 * Under v22 incremental hydration the deferred rows are SSR-rendered (crawlable,
 * no hydration layout shift); the `on viewport` trigger still defers the block on
 * client-side navigations (see AECI-130). Each row's whole surface links to the
 * product-PAIR page `/products/:contextSlug/integrations/:otherSlug` (this
 * product as the context slug) via a stretched-link overlay, with the *other*
 * product linked separately on top — AECI-294 retired the standalone
 * `/integrations/:id` detail route the original AC named.
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
 * integration shown, both endpoints of each powered edge), and the page-view
 * payload was queued by the resolver.
 * Nothing here triggers HTTP — hydration reads the resolved data out of
 * `route.data`.
 */
@Component({
  selector: 'aec-product-detail',
  imports: [
    DetailLayout,
    ExternalLinkTracker,
    LogoOrInitial,
    MailingListSignup,
    MaintenanceMarker,
    NgTemplateOutlet,
    NotFound,
    ProductIntegrationsTable,
    ProductPoweredHub,
    ProductReviews,
    ProductUsefulnessSection,
    RequestDrawer,
    RequestTrigger,
    ReviewCta,
    ReviewStars,
    RoleBadge,
    RouterLink,
    SectionNav,
    TaxonomyBadge,
    VerifiedBadge,
  ],
  template: `
    @let p = product();
    @if (p === null) {
      <aec-not-found />
    } @else {
      <aec-detail-layout>
        <ol
          slot="breadcrumbs"
          class="flex flex-wrap items-center gap-2 text-sm text-(--text-secondary)"
        >
          <li>
            <a
              routerLink="/"
              class="text-(--text-secondary) no-underline hover:text-(--accent-primary)"
              i18n="@@products.detail.breadcrumbs.home"
            >
              Home
            </a>
          </li>
          <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
          <li>
            <a
              routerLink="/products"
              class="text-(--text-secondary) no-underline hover:text-(--accent-primary)"
              i18n="@@products.detail.breadcrumbs.products"
            >
              Products
            </a>
          </li>
          <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
          <li class="min-w-0 break-words text-(--text-primary)" aria-current="page">
            {{ p.name }}
          </li>
        </ol>

        <div slot="hero" class="space-y-5">
          <div class="flex items-start gap-5">
            <aec-logo-or-initial
              [src]="p.logo_url"
              [name]="p.name"
              [alt]="p.name + ' logo'"
              size="lg"
              [priority]="true"
            />
            <div class="min-w-0 space-y-2">
              <!-- Eyebrow + role chip. The role badge renders nothing for the
                   default "application" role, so most products keep the bare
                   eyebrow; a connector / hybrid is flagged where the visitor
                   first looks (Stage 1.5 Addendum B). -->
              <div class="flex flex-wrap items-center gap-2">
                <p
                  class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
                  i18n="@@products.detail.eyebrow"
                >
                  Product
                </p>
                <aec-role-badge [role]="p.product_role" />
                <aec-maintenance-marker
                  [maintainedBy]="p.maintenance.maintained_by"
                  [reviewedAt]="p.maintenance.last_reviewed_at"
                />
              </div>
              <h1
                class="font-display text-3xl font-semibold leading-tight tracking-tight text-(--text-primary) break-words sm:text-4xl"
              >
                {{ p.name }}
              </h1>
              <!-- Connector reach line (Stage 1.5 Addendum C, §13.6). Rendered
                   whenever the product reaches at least one catalog product,
                   with no role gate: §13.6 states only the N > 0 condition, and
                   a mis-roled application that powers edges is described just
                   as accurately by it. "in the AECi catalog" carries §12.7's
                   scope framing inline, so the number never reads as the
                   vendor's full partner set. -->
              @if (connectsLabel(); as connects) {
                <p class="text-sm text-(--text-secondary)">{{ connects }}</p>
              }
            </div>
          </div>

          <!-- Rating / review meta line. Always rendered: a rated product (≥5
               approved reviews) shows the aggregate; below that §5.5 threshold the
               API nulls the average, so we show a "Not Yet Rated" label + the live
               review count instead of hiding the line. Every value derives from
               static product fields, so this stays edge-cache-neutral (§8). -->
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            @if (p.rating_overall_avg !== null) {
              <aec-review-stars [rating]="p.rating_overall_avg" kind="overall" />
              <span class="font-display text-xl font-semibold text-(--text-primary)">{{
                decimal(p.rating_overall_avg)
              }}</span>
            } @else {
              <span
                class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
                  bg-(--surface-raised) px-2 py-0.5 text-xs font-medium uppercase tracking-[0.08em]
                  text-(--text-secondary)"
                i18n="@@products.detail.hero.notRated"
              >
                Not Yet Rated
              </span>
            }
            <span aria-hidden="true" class="text-(--text-tertiary)">·</span>
            @if (p.review_count > 0) {
              <a
                [href]="'/products/' + p.slug + '#reviews'"
                class="text-sm font-medium text-(--text-secondary) no-underline transition-colors
                  hover:text-(--accent-primary) focus-visible:outline-none
                  focus-visible:rounded-(--radius-sm) focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                {{ reviewCountLabel(p.review_count) }}
              </a>
            } @else {
              <span class="text-sm font-medium text-(--text-secondary)">{{
                reviewCountLabel(p.review_count)
              }}</span>
            }
          </div>

          <!-- Primary action ("Visit website", when present) sits beside the
               write-a-review CTA. The CTA reuses the cache-neutral, auth-aware
               aec-review-cta (its SSR render is the generic "Write a review"); the
               secondary variant keeps "Visit website" the single accent button.
               The row renders even with no website so the CTA is always present. -->
          <div class="flex flex-wrap items-center gap-3">
            @if (p.website) {
              <a
                [href]="p.website"
                target="_blank"
                rel="noopener noreferrer"
                aecTrackExternalLink="product_detail"
                class="inline-flex items-center gap-2 rounded-(--radius-md)
                  border border-(--border-strong) bg-(--accent-primary)
                  px-4 py-2 text-sm font-bold text-(--surface-base) no-underline
                  transition-colors hover:bg-(--accent-primary-hover)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                <ng-container i18n="@@products.detail.visitWebsite">Visit website</ng-container>
                <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
              </a>
            }
            <aec-review-cta [slug]="p.slug" [productId]="p.id" variant="secondary" />
          </div>
        </div>

        <!--
          One instance, two formats. At xl this is the docked sidebar: a single
          column of stacked groups on the page background. Below xl the layout
          drops it in right under About, where a full-bleed stack of stretched
          rows read as leftovers. There it becomes a contained fact panel: groups
          pair up into two columns from sm, the vendor row and the action buttons
          become surface-base cards on the panel, and the actions sit inline at
          their natural width instead of spanning the viewport.
        -->
        <div
          slot="metadata"
          class="grid gap-x-8 gap-y-6 rounded-(--radius-lg) border border-(--border-default)
            bg-(--surface-raised) p-5 sm:grid-cols-2 sm:p-6 xl:block xl:space-y-6
            xl:rounded-none xl:border-0 xl:bg-transparent xl:p-0"
        >
          <section
            aria-labelledby="vendor-card-title"
            class="space-y-3 sm:col-span-2 xl:col-span-1"
          >
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
                  transition-colors hover:border-(--border-strong)
                  xl:bg-(--surface-raised) xl:p-4"
              >
                <aec-logo-or-initial [src]="v.logo_url" [name]="v.name" alt="" size="sm" />
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="min-w-0 break-words font-medium text-(--text-primary)">{{
                    v.name
                  }}</span>
                  <aec-verified-badge [verified]="v.verified" variant="compact" />
                </span>
              </a>
            } @else {
              <p
                class="rounded-(--radius-lg) border border-(--border-default)
                  bg-(--surface-base) p-3 text-(--text-secondary)
                  xl:bg-(--surface-raised) xl:p-4"
                i18n="@@products.detail.vendor.none"
              >
                No vendor listed
              </p>
            }
          </section>

          @if (p.categories.length > 0) {
            <section aria-labelledby="categories-label" class="space-y-3">
              <h2
                id="categories-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.categories"
              >
                Categories
              </h2>
              <div class="flex flex-wrap gap-2">
                @for (c of p.categories; track c.slug) {
                  <aec-taxonomy-badge kind="category" [slug]="c.slug" [name]="c.name" />
                }
              </div>
            </section>
          }

          @if (p.audiences.length > 0) {
            <section aria-labelledby="audiences-label" class="space-y-3">
              <h2
                id="audiences-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.audiences"
              >
                Audiences
              </h2>
              <div class="flex flex-wrap gap-2">
                @for (d of p.audiences; track d.slug) {
                  <aec-taxonomy-badge kind="audience" [slug]="d.slug" [name]="d.name" />
                }
              </div>
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
          @if (p.trades.length > 0) {
            <section aria-labelledby="trades-label" class="space-y-3">
              <h2
                id="trades-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.trades"
              >
                Trades
              </h2>
              <div class="flex flex-wrap gap-2">
                @for (tr of p.trades; track tr.slug) {
                  <aec-taxonomy-badge kind="trade" [slug]="tr.slug" [name]="tr.name" />
                }
              </div>
            </section>
          }

          @if (p.phases.length > 0) {
            <section aria-labelledby="phases-label" class="space-y-3">
              <h2
                id="phases-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.phases"
              >
                Project phases
              </h2>
              <div class="flex flex-wrap gap-2">
                @for (ph of p.phases; track ph.slug) {
                  <aec-taxonomy-badge kind="phase" [slug]="ph.slug" [name]="ph.name" />
                }
              </div>
            </section>
          }

          <section aria-labelledby="actions-label" class="space-y-3 sm:col-span-2 xl:col-span-1">
            <h2
              id="actions-label"
              class="aec-overline text-(--text-secondary)"
              i18n="@@products.detail.metadata.actions"
            >
              Actions
            </h2>
            <div class="flex flex-wrap gap-2 xl:flex-col">
              <a
                aecRequestTrigger
                [entity]="'product'"
                [kind]="'claim'"
                [slug]="p.slug"
                [claimed]="p.vendor?.verified ?? false"
                [href]="'/products/' + p.slug + '/claim'"
                class="inline-flex items-center justify-center gap-2 rounded-(--radius-md)
                  border border-(--border-default) bg-(--surface-base) px-4 py-2.5
                  xl:bg-(--surface-raised)
                  text-sm font-medium text-(--text-secondary) no-underline transition-colors
                  hover:border-(--border-strong) hover:text-(--accent-primary)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                <svg
                  aria-hidden="true"
                  class="h-4 w-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <path d="M4 22v-7" />
                </svg>
                @if (p.vendor?.verified) {
                  <ng-container i18n="@@products.detail.metadata.requestAccess"
                    >Request access to this listing</ng-container
                  >
                } @else {
                  <ng-container i18n="@@products.detail.metadata.claim"
                    >Claim this listing</ng-container
                  >
                }
              </a>
              <a
                aecRequestTrigger
                [entity]="'product'"
                [kind]="'correction'"
                [slug]="p.slug"
                [href]="'/products/' + p.slug + '/correction'"
                class="inline-flex items-center justify-center gap-2 rounded-(--radius-md)
                  border border-(--border-default) bg-(--surface-base) px-4 py-2.5
                  xl:bg-(--surface-raised)
                  text-sm font-medium text-(--text-secondary) no-underline transition-colors
                  hover:border-(--border-strong) hover:text-(--accent-primary)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                <svg
                  aria-hidden="true"
                  class="h-4 w-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                <ng-container i18n="@@products.detail.metadata.correction"
                  >Suggest a correction</ng-container
                >
              </a>
            </div>
            @if (p.vendor?.verified) {
              <p
                class="text-xs leading-relaxed text-(--text-secondary)"
                i18n="@@products.detail.metadata.claimedNote"
              >
                Already managed by a verified vendor. Request access if you work there too.
              </p>
            }
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
          <aec-section-nav
            slot="nav"
            class="mb-12"
            [basePath]="'/products/' + p.slug"
            [sections]="sectionNav()"
          />
        }

        <!--
          About goes in the LEAD slot, not the body slot: below xl the layout
          renders the metadata sidebar directly after this block, so the vendor /
          taxonomy / actions facts read as part of About instead of being dumped
          under Reviews at the foot of the page. At xl this is simply the top of
          column 1, and nothing moves. See DetailLayout.
        -->
        <div slot="body-lead" class="space-y-12">
          @if (p.description) {
            <section id="about" aria-labelledby="description-title" class="scroll-mt-20 space-y-4">
              <h2
                id="description-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@products.detail.body.description"
              >
                About
              </h2>
              <p class="max-w-prose break-words text-base leading-relaxed text-(--text-secondary)">
                {{ p.description }}
              </p>
            </section>
          }
        </div>

        <div slot="body" class="space-y-12">
          @if (p.usefulness; as u) {
            <aec-product-usefulness id="how-teams-use-it" class="scroll-mt-20" [data]="u" />
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
              id="powered-integrations"
              aria-labelledby="powered-integrations-title"
              class="scroll-mt-20 space-y-4"
            >
              <h2
                id="powered-integrations-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
              >
                {{ poweredHeading() }}
              </h2>

              @if (poweredView().pairCount === 0) {
                <p
                  class="rounded-(--radius-lg) border border-dashed border-(--border-default)
                    bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
                  i18n="@@products.detail.body.powers.empty"
                >
                  No integrations are recorded as running on this connector yet. Vendor data is
                  curated; if you know of one,
                  <a
                    aecRequestTrigger
                    [entity]="'product'"
                    [kind]="'correction'"
                    [slug]="p.slug"
                    [href]="'/products/' + p.slug + '/correction'"
                    class="text-(--accent-primary) underline underline-offset-2"
                    >suggest a correction</a
                  >.
                </p>
              } @else {
                <aec-product-powered-hub [view]="poweredView()" />

                <!-- Same boundary as the endpoint table above, and it bites
                     harder here: a connector's whole value proposition is
                     breadth, so "Integrations it powers (4)" for a product that
                     markets ~14 ERP connections understates the vendor in an
                     h2. That is the mirror of the defect Addendum B closed, and
                     an understatement is as much a trust failure as an
                     overstatement on a directory that refuses pay-for-placement.
                     Both sections carry the note, deliberately: caveating one
                     would imply the other is complete. -->
                <p
                  class="text-xs text-(--text-secondary)"
                  i18n="@@products.detail.body.powers.scope"
                >
                  Only integrations between products listed on AECi appear here. If one is missing,
                  <a
                    aecRequestTrigger
                    [entity]="'product'"
                    [kind]="'correction'"
                    [slug]="p.slug"
                    [href]="'/products/' + p.slug + '/correction'"
                    class="text-(--accent-primary) underline underline-offset-2"
                    >suggest a correction</a
                  >.
                </p>
              }
            </section>
          </ng-template>

          @if (leadWithPowered()) {
            <ng-container [ngTemplateOutlet]="poweredSection" />
          }

          <section
            id="integrations"
            aria-labelledby="integrations-title"
            class="scroll-mt-20 space-y-4"
          >
            <h2
              id="integrations-title"
              class="font-display text-2xl font-semibold text-(--text-primary)"
            >
              {{ integrationsHeading() }}
            </h2>

            @if (lanes().rowCount === 0) {
              <p
                class="rounded-(--radius-lg) border border-dashed border-(--border-default)
                  bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
                i18n="@@products.detail.body.integrations.empty"
              >
                No integrations recorded yet. Vendor data is curated; if you know of one,
                <a
                  aecRequestTrigger
                  [entity]="'product'"
                  [kind]="'correction'"
                  [slug]="p.slug"
                  [href]="'/products/' + p.slug + '/correction'"
                  class="text-(--accent-primary) underline underline-offset-2"
                  >suggest a correction</a
                >.
              </p>
            } @else {
              <!-- ONE <table> PER LANE (§13.3). The direct lane leads, because
                   an accountable-party integration is a stronger answer to "does
                   A integrate with B" than a configurable one: someone is on the
                   hook for it. Then one group per connector. A single <tbody>
                   with interleaved group-header rows was rejected, since a
                   header row inside a table body has no accessible name
                   relationship to the rows beneath it.
                   A page with no connector edges renders exactly what it always
                   did: one unheaded table named by the section heading. -->
              @if (lanes().via.length === 0) {
                <aec-product-integrations-table
                  [above]="laneCut().direct.above"
                  [deferred]="laneCut().direct.deferred"
                  [contextSlug]="p.slug"
                  i18n-ariaLabel="@@products.detail.body.integrations.table.aria"
                  ariaLabel="Integrations"
                />
              } @else {
                @if (lanes().direct.length > 0) {
                  <h3
                    id="integrations-direct"
                    class="font-display text-lg font-semibold text-(--text-primary)"
                  >
                    <span i18n="@@products.detail.body.integrations.lane.direct"
                      >Direct integrations</span
                    >
                    <span class="ms-2 font-normal text-(--text-secondary)"
                      >({{ lanes().direct.length }})</span
                    >
                  </h3>
                  <aec-product-integrations-table
                    [above]="laneCut().direct.above"
                    [deferred]="laneCut().direct.deferred"
                    [contextSlug]="p.slug"
                    ariaLabelledby="integrations-direct"
                  />
                }
                @for (lane of laneCut().via; track lane.lane.key) {
                  <h3
                    [id]="'integrations-via-' + lane.lane.key"
                    class="font-display mt-8 text-lg font-semibold text-(--text-primary)"
                  >
                    <!-- The connector name links its product page: the return
                         path into the Addendum B hub, mirroring §12.3's linked
                         hub heading in the opposite direction. -->
                    @if (lane.lane.connector; as connector) {
                      <span i18n="@@products.detail.body.integrations.lane.via"
                        >Via
                        <a
                          [routerLink]="['/products', connector.slug]"
                          class="rounded-sm underline underline-offset-4 transition-colors
                            hover:text-(--accent-primary) focus-visible:outline-2
                            focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                          >{{ connector.name }}</a
                        ></span
                      >
                    } @else {
                      <!-- §13.2(c): connector-delivered, but its connector has
                           no product record to name. NEVER invent one. -->
                      <span i18n="@@products.detail.body.integrations.lane.via.unnamed"
                        >Via a connector</span
                      >
                    }
                    <span class="ms-2 font-normal text-(--text-secondary)"
                      >({{ lane.lane.rows.length }})</span
                    >
                  </h3>
                  <aec-product-integrations-table
                    [above]="lane.above"
                    [deferred]="lane.deferred"
                    [contextSlug]="p.slug"
                    [ariaLabelledby]="'integrations-via-' + lane.lane.key"
                  />
                }
              }

              <!-- Catalog-scope note. An integration row only exists once BOTH
                   endpoints are promoted products, so this table is bounded by
                   the directory, not by the vendor's real partner list: a
                   product with hundreds of marketplace partners can render a
                   dozen. The empty state already hedges ("Vendor data is
                   curated"); without this line the POPULATED state makes a bare
                   confident count, which is the one people screenshot. Scope,
                   not apology: it states the boundary and offers the fix. -->
              <p
                class="text-xs text-(--text-secondary)"
                i18n="@@products.detail.body.integrations.scope"
              >
                Only partners listed on AECi appear here. If one is missing,
                <a
                  aecRequestTrigger
                  [entity]="'product'"
                  [kind]="'correction'"
                  [slug]="p.slug"
                  [href]="'/products/' + p.slug + '/correction'"
                  class="text-(--accent-primary) underline underline-offset-2"
                  >suggest a correction</a
                >.
              </p>
            }
          </section>

          @if (showPowered() && !leadWithPowered()) {
            <ng-container [ngTemplateOutlet]="poweredSection" />
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

      <aec-mailing-list-signup />

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

  /** One-decimal display of an average rating, e.g. 4 → "4.0", 4.25 → "4.3". */
  protected decimal(value: number): string {
    return value.toFixed(1);
  }

  /**
   * Hero review-count label. Now renders for any count (the meta line shows
   * "Not Yet Rated · N reviews" below the §5.5 5-review rating threshold, not
   * just for rated products), so it pluralizes all three cases. Pluralization
   * lives in the component rather than a template ICU, matching `IntegrationStat`.
   */
  protected reviewCountLabel(count: number): string {
    if (count === 0) return $localize`:@@products.detail.hero.reviewCount.none:No reviews yet`;
    if (count === 1) return $localize`:@@products.detail.hero.reviewCount.one:1 review`;
    return $localize`:@@products.detail.hero.reviewCount.other:${count}:COUNT: reviews`;
  }

  /**
   * The Integrations section split into its two lanes — the direct list, then
   * one group per connector (Stage 1.5 §13.2 / §13.3).
   *
   * **The split is a sourcing question, not a rendering one.** Both payload
   * buckets already span both delivered-tier tables (`integrations` and
   * `connector_evidenced_pairs`), and which table a row came from reaches this
   * component only as `via`. That is why §13.3 is written source-agnostically and
   * why the AECI-721 migration moved rows without touching this file's contract.
   *
   * The source/target buckets survive only as *which endpoint is the partner*.
   * The direction shown per row is the server-precomputed, context-relative
   * `context_direction` (claims-aware, §3.2), never the bucket — so the two
   * interleave rather than concatenate inside each lane, and a reader never sees
   * an unexplained break in the alphabet.
   *
   * Sorting and grouping have to happen here rather than in SQL. The relations
   * can only `ORDER BY` columns of their own table — the partner name lives on
   * the joined product — and the lane a row belongs to is a three-clause rule
   * over two nullable FKs. Client-side is also where the full list exists before
   * the `@defer` cut, so the cut lands on the alphabet.
   */
  protected readonly lanes = computed(() => {
    const p = this.product();
    if (!p) return { direct: [], via: [], rowCount: 0 } satisfies IntegrationLaneView;
    return splitIntegrationLanes(p.integrations_as_source, p.integrations_as_target);
  });

  /**
   * The same view with the `@defer (on viewport)` boundary applied.
   *
   * The cut is over the FLATTENED render order (§13.3), so it still lands after
   * 20 visible rows rather than 20 rows into every lane — a section of six
   * three-row groups would otherwise defer nothing at all.
   */
  protected readonly laneCut = computed(() => applyDeferCut(this.lanes(), INTEGRATIONS_ABOVE_FOLD));

  /** Section heading with the count inline — "Integrations (10)" — so the total
   *  reads next to the title instead of drifting to the far right where it's missed.
   *
   *  Counts the rows ACTUALLY RENDERED across both lanes, which after the Via
   *  lane's pair collapse is not the number of edges: §13.3's rule is that a
   *  reader counting rows must never find fewer than the heading promised. The
   *  per-group sub-counts sum to this by construction (`rowCount`). */
  protected readonly integrationsHeading = computed(() => {
    const count = this.lanes().rowCount;
    return $localize`:@@products.detail.body.integrations.heading:Integrations (${count}:count:)`;
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
   *    the hero line directly above it ("Connects 43 products" over "powers 0,
   *    none recorded yet, suggest a correction" — soliciting data already on
   *    the page). This is live on half the promoted connector surface: all of
   *    Aquifer's 43 and Kroo's 44 powered edges are Convention A.
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
   * `application` keep today's order**: there are exactly two hybrids
   * catalog-wide and swapping them would demote a surface that is half of
   * AnyWare Apps' real content.
   *
   * Guarded on the section having content, which §13.6 did not anticipate: it
   * rejected a *comparative* "swap when powered exceeds endpoint" rule, on the
   * grounds that page order would shift under readers as data moves. This is
   * the degenerate empty/non-empty case instead, and without it the swap leads
   * with an empty section on four of the eight promoted connector pages (the
   * two Convention-A connectors above, plus two with no powered edges at all).
   */
  protected readonly leadWithPowered = computed(() => {
    const p = this.product();
    if (!p) return false;
    return p.product_role === 'connector' && this.poweredView().pairCount > 0;
  });

  /**
   * The Addendum B hub view, computed HERE rather than inside
   * `ProductPoweredHub` so the heading count and the rendered rows are
   * provably the same set (see `poweredHeading`). The page slug is the
   * §13.4(2) self-exclusion — see `groupPoweredIntegrations`.
   */
  protected readonly poweredView = computed(() => {
    const p = this.product();
    if (!p) return groupPoweredIntegrations([], '');
    return groupPoweredIntegrations(p.integrations_as_connector, p.slug);
  });

  /**
   * Hero line — "Connects N products in the AECi catalog" (§13.6).
   *
   * `null` when N is 0, which is the section's own render gate turned into a
   * copy gate: a connector with nothing to count says nothing rather than
   * saying zero. Deliberately NOT gated on `product_role`: §13.6 states only
   * the `N > 0` condition, and a mis-roled application that powers edges is
   * described just as accurately by the line as a connector is — the same
   * data-driven reading `showPowered` takes.
   *
   * "in the AECi catalog" carries §12.7's catalog-scope framing inline, so this
   * line needs no separate scope note: an `integrations` row only exists once
   * BOTH endpoints are promoted products, and the count must not read as the
   * vendor's full partner set.
   *
   * Pluralized in the component rather than a template ICU, matching
   * `reviewCountLabel` above and `IntegrationStat`.
   */
  protected readonly connectsLabel = computed<string | null>(() => {
    const p = this.product();
    if (!p) return null;
    const count = connectedProductCount(p.integrations_as_connector, p.slug);
    if (count === 0) return null;
    if (count === 1) {
      return $localize`:@@products.detail.hero.connects.one:Connects 1 product in the AECi catalog`;
    }
    return $localize`:@@products.detail.hero.connects.other:Connects ${count}:count: products in the AECi catalog`;
  });

  /**
   * "Integrations it powers (N)".
   *
   * The copy is a noun phrase, parallel to the endpoint "Integrations (N)"
   * heading directly above it, because on a connector page **both sections can
   * be populated at once** — live data has a connector carrying its own
   * endpoint integrations *and* powered edges (NetSuite Connector by
   * Appficiency), so the two headings have to be told apart. The former
   * "Powers these integrations" failed at that: verb-first (breaking the
   * `About` / `How teams use it` / `Integrations` / `Reviews` heading grammar),
   * "these" pointed forward at nothing, and "powers" is vendor marketing voice
   * rather than the neutral catalog voice PRODUCT.md asks for. The pronoun in
   * "it powers" does the disambiguating work "these" was not doing.
   *
   * N counts the distinct product PAIRS the section renders, not raw edges.
   * Counting edges made the heading lie: live data carries duplicate rows for a
   * pair (that same NetSuite connector has 4 edges over 2 pairs) and several
   * mechanisms between one pair collapse to a single row, so a reader counting
   * rows found fewer than the heading promised. Same inline-count treatment as
   * the endpoint heading above.
   */
  protected readonly poweredHeading = computed(() => {
    const count = this.poweredView().pairCount;
    return $localize`:@@products.detail.body.powers.heading:Integrations it powers (${count}:count:)`;
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
    if (p.description) {
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
    // Reviews always renders (its empty state still does), so it is always in
    // the nav — same rule as Integrations above.
    items.push({
      id: 'reviews',
      label: $localize`:@@products.detail.nav.reviews:Reviews`,
    });
    return items;
  });
}
