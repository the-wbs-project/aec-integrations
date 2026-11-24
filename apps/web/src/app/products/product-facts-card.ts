import { formatNumber } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductDetail } from '@aeci/shared';

import type { ExternalLinkContext } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { RequestTrigger } from '../requests/request-trigger';
import { AecButton } from '../shared/button/button';
import { AecCard } from '../shared/card/card';
import { companySizeLabel, ownershipTypeLabel } from '../shared/company-facts/company-fact-labels';
import { correctionLabel } from '../shared/field-caption/correction-labels';
import { isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { AecFigure } from '../shared/figure/figure';
import { AecIcon } from '../shared/icon/icon';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

import { splitIntegrationLanes } from './connector-lane-grouping';
import { integrationsOnRecordCount } from './integrations-on-record';
import { integrationNoun } from './integration-stat';
import { hasNoIntegrationsOnRecord } from './integrations-on-record';
import { groupPoweredIntegrations } from './powered-hub-grouping';
import { ProductBuiltWithin } from './product-extensions';

/**
 * One column of the top row. From `xl` every column after the stat panel carries the
 * mock-up's inset hairline on its start edge (mock-up 6 line 116). It is a pseudo-element
 * fill, not a border. It was built while the `* { border-color }` rule was unlayered and
 * beat every border-colour utility (fixed in AECI-2088). Forced colours drops it, which is fine: it only separates columns.
 */
const COLUMN =
  'relative min-w-0 p-6 xl:before:absolute xl:before:inset-y-6 xl:before:start-0 xl:before:w-px xl:before:bg-(--border-default)';

/** A group heading: the overline with its 16px glyph. */
const GROUP_HEADING = 'aec-overline flex items-center gap-2 text-(--text-secondary)';

/** The shared focus ring on a light ground, 3px at 3px. */
const FOCUS_RING =
  'focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/**
 * AECI-1779: the product page's facts card (`PLAN.md` §5.2 row 3, mock-up 6). One elevated
 * `aecCard` that `DetailLayout`'s band shell pulls up over the Forest hero (AECI-1778). Its
 * own file, so the other product-page issues do not collide in `product-detail.ts`.
 *
 * The top row is the mock-up's four columns, from `xl`. Two from `md`, one below:
 *
 *   1. the Bone stat panel: `integration_count` through `aec-figure`. The label is the
 *      noun the product cards print. A zero takes the figure's legal-reviewed zero mode,
 *      so no caller writes its own words for it. A stored zero over listed rows shows
 *      the row count instead (`count`);
 *   2. Vendor, with its size and ownership line (the §6.23 display rule is applied by the
 *      API, which nulls a hidden fact), and "Built within" under it;
 *   3. Categories;
 *   4. Resources, then the claim and correction entries and "Learn more about claiming".
 *
 * Audiences, Trades and Project phases are not here. AECI-1780 moved them into the About
 * band (`product-who-it-is-for.ts`). No caption or correction renders here: every one is
 * in the page's "About this listing" panel (AECI-1666). The "Under review" markers stay.
 *
 * Not here: the reach line. `STAGE_1_5_SPEC.md` §13.7 places "N more pairs reachable via
 * connectors" under the Integrations section, and the payload contract says
 * `reachable_pair_count` feeds that one sentence and nothing else. The hero keeps the
 * connector's "Connects N products" line (DESIGN.md §4).
 *
 * Every value is a static product field, so the cached SSR HTML is the same for every
 * visitor. Nothing here orders anything, and no paid-plan input is read.
 */
@Component({
  selector: 'aec-product-facts-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AecButton,
    AecCard,
    AecFigure,
    AecIcon,
    ExternalLinkTracker,
    LogoOrInitial,
    NewTabIcon,
    ProductBuiltWithin,
    RequestTrigger,
    RouterLink,
    TaxonomyBadge,
    UnderReviewMarker,
  ],
  host: { class: 'block' },
  template: `
    @let p = product();
    <div aecCard class="overflow-hidden" data-testid="product-facts">
      <!-- The top row: the mock-up's column ratios from xl, three columns when there is
           no Categories group. From md to xl an odd last column spans both. -->
      <div [class]="topRowClass()">
        <!-- The Bone stat panel, a nested fill inside the card (DESIGN.md section 4). -->
        <div
          class="flex min-w-0 flex-col justify-center bg-(--accent-warm) p-6"
          data-testid="product-facts-count"
        >
          <aec-figure
            [value]="count()"
            [text]="countText()"
            [label]="countNoun()"
            zero="integrations-not-on-record"
            [product]="p.name"
          >
            <!-- Mock-up 8 .f-stat: at zero the figure's projected slot points to the
                 Integrations section's own "Know of one?" block, where the reader can
                 suggest one. A plain link, no promise (AECI-1720 restore). It shows on the
                 same test as that block, so it never points at a section without one. -->
            @if (showKnowOfOne()) {
              <a
                [href]="'/products/' + p.slug + '#integrations'"
                data-smooth-scroll
                data-testid="product-facts-know-of-one"
                class="mt-2 inline-flex min-h-6 w-fit items-center text-t-13 text-(--text-secondary) underline decoration-(--border-underline) underline-offset-4 hover:text-(--text-primary) hover:decoration-(--text-secondary) {{
                  focusRing
                }}"
                i18n="@@products.detail.metadata.knowOfOne"
                >Know of one?</a
              >
            }
          </aec-figure>
        </div>

        <div [class]="column" class="space-y-6">
          <section aria-labelledby="vendor-card-title" class="space-y-3">
            <h2 id="vendor-card-title" [class]="groupHeading">
              <aec-icon name="building" decorative [size]="4" />
              <span i18n="@@products.detail.metadata.vendor">Vendor</span>
            </h2>
            @if (p.vendor; as v) {
              <a
                [routerLink]="['/vendors', v.slug]"
                class="-ms-2 flex items-center gap-3 rounded-control py-2 ps-2 pe-3 no-underline transition-colors duration-fast ease-standard hover:bg-(--surface-sunken) {{
                  focusRing
                }}"
              >
                <aec-logo-or-initial
                  [claimStatus]="'server-filtered'"
                  [src]="v.logo_url"
                  [name]="v.name"
                  [alt]="logoAlt(v.name)"
                  size="sm"
                />
                <span class="flex min-w-0 flex-col gap-1">
                  <span
                    class="min-w-0 break-words font-display text-t-20 font-semibold text-(--text-primary)"
                    >{{ v.name }}</span
                  >
                  @if (vendorFactsLine(); as line) {
                    <span
                      class="text-t-13 text-(--text-secondary)"
                      data-testid="product-vendor-facts"
                      >{{ line }}</span
                    >
                  }
                </span>
              </a>
            } @else {
              <p class="text-t-16 text-(--text-secondary)" i18n="@@products.detail.vendor.none">
                No vendor listed
              </p>
            }
          </section>

          <!-- §13.3b (AECI-710): the host(s) this product is built within. Under Vendor
               because it is the same kind of fact: what the product IS. Never an
               integration, never counted. -->
          @if (p.extension_of.length > 0) {
            <section
              aec-product-built-within
              aria-labelledby="built-within-title"
              class="space-y-3"
              [hosts]="p.extension_of"
            ></section>
          }
        </div>

        @if (hasCategories()) {
          <section aria-labelledby="categories-label" [class]="column" class="space-y-3">
            <h2 id="categories-label" [class]="groupHeading">
              <aec-icon name="tag" decorative [size]="4" />
              <span i18n="@@products.detail.metadata.categories">Categories</span>
            </h2>
            <div class="flex flex-wrap gap-2">
              @for (c of p.categories; track c.slug) {
                <aec-taxonomy-badge kind="category" icon="tag" [slug]="c.slug" [name]="c.name" />
              }
            </div>
          </section>
        }

        <div [class]="column" class="space-y-6">
          <!-- AECI-1309: the two Managed doc links. Shown on every plan when the product
               has a value. Managed is what lets the vendor edit them. -->
          @if (
            p.tool_integrations_url ||
            p.api_docs_url ||
            underReview('tool_integrations_url') ||
            underReview('api_docs_url')
          ) {
            <section aria-labelledby="resources-label" class="space-y-3">
              <h2 id="resources-label" [class]="groupHeading">
                <aec-icon name="book" decorative [size]="4" />
                <span i18n="@@products.detail.metadata.resources">Resources</span>
              </h2>
              <ul class="m-0 grid list-none gap-1 p-0">
                @if (p.tool_integrations_url) {
                  <li>
                    <a
                      [href]="p.tool_integrations_url"
                      target="_blank"
                      rel="noopener nofollow"
                      aecTrackExternalLink="product_detail"
                      [aecLinkContext]="docsLinkContext('listing')"
                      [class]="resourceLinkClass"
                    >
                      <span [class]="resourceTileClass"
                        ><aec-icon name="grid" decorative [size]="4"
                      /></span>
                      <span
                        class="min-w-0 flex-1"
                        i18n="@@products.detail.metadata.integrationsPage"
                        >Integrations page</span
                      >
                      <span class="text-(--text-secondary)"><aec-new-tab-icon /></span>
                    </a>
                  </li>
                } @else if (underReview('tool_integrations_url')) {
                  <li>
                    <aec-under-review
                      data-testid="tool-integrations-under-review"
                      [label]="correctionLabel('tool_integrations_url')"
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
                      [aecLinkContext]="docsLinkContext('docs')"
                      [class]="resourceLinkClass"
                    >
                      <span [class]="resourceTileClass"
                        ><aec-icon name="code" decorative [size]="4"
                      /></span>
                      <span class="min-w-0 flex-1" i18n="@@products.detail.metadata.apiDocs"
                        >API documentation</span
                      >
                      <span class="text-(--text-secondary)"><aec-new-tab-icon /></span>
                    </a>
                  </li>
                } @else if (underReview('api_docs_url')) {
                  <li>
                    <aec-under-review
                      data-testid="api-docs-under-review"
                      [label]="correctionLabel('api_docs_url')"
                    />
                  </li>
                }
              </ul>
            </section>
          }

          <!-- Mock-up 6 .f-acts: the two buttons sit under Resources with no heading of their
               own (AECI-1720 restore). "Claim" stays first (ruled 2026-11-16). -->
          <div class="space-y-3" data-testid="product-facts-actions">
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
                <aec-icon name="seal" decorative [size]="4" />
                <!-- AECI-1365: a claim is on the company (VENDOR_SIGNUP_PROCESS.md section 3),
                     so the button names the product's vendor. AECI-1925: the label reads
                     "Claim Vendor" (Chris, 2026-11-18) and the name stays in the accessible
                     name, after the visible words. -->
                @if (p.vendor?.name; as company) {
                  <ng-container i18n="@@products.detail.metadata.claimVendor"
                    >Claim Vendor<span class="sr-only"> {{ company }}</span></ng-container
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
                <aec-icon name="flag" decorative [size]="4" />
                <ng-container i18n="@@products.detail.metadata.correction"
                  >Suggest a correction</ng-container
                >
              </a>
            </div>
            <!-- AECI-1283: the vendor landing page, beside the claim button
                 (VENDOR_PROGRAM_PAGE_SPEC.md section 2.4). Visitor-neutral, so it stays in
                 the cached HTML. It explains claiming, so it must not read like a second
                 claim button, and it opens a new tab so the visitor can come back here to
                 claim. The vendor query lets the page's claim dialog skip the search. -->
            <a
              routerLink="/vendor-program"
              [queryParams]="p.vendor ? { vendor: p.vendor.slug } : {}"
              target="_blank"
              rel="noopener"
              data-testid="product-vendor-program-link"
              class="inline-flex items-center gap-1 text-t-13 text-(--text-secondary) underline decoration-(--border-underline) underline-offset-4 hover:text-(--text-primary) hover:decoration-(--text-secondary) {{
                focusRing
              }}"
              ><ng-container i18n="@@products.detail.metadata.vendorProgram"
                >Learn more about claiming</ng-container
              ><aec-new-tab-icon
            /></a>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class ProductFactsCard {
  readonly product = input.required<ProductDetail>();

  private readonly locale = inject(LOCALE_ID);

  protected readonly logoAlt = logoAlt;
  protected readonly correctionLabel = correctionLabel;
  protected readonly column = COLUMN;
  protected readonly groupHeading = GROUP_HEADING;
  protected readonly focusRing = FOCUS_RING;

  protected readonly resourceLinkClass =
    '-ms-2 flex items-center gap-3 rounded-control py-2 ps-2 pe-3 text-t-16 font-semibold text-(--text-primary) no-underline transition-colors duration-fast ease-standard hover:bg-(--surface-sunken) ' +
    FOCUS_RING;

  /** The 32px Forest-soft tile behind a resource glyph (mock-up 6 line 133). */
  protected readonly resourceTileClass =
    'grid size-8 shrink-0 place-items-center rounded-control bg-(--accent-primary-soft) text-(--accent-primary)';

  /** Whether the Categories column renders. A removal that emptied it takes the column
   *  away, and "About this listing" lists the removal (AECI-1666). */
  protected readonly hasCategories = computed(() => this.product().categories.length > 0);

  /**
   * The top row's grid. From `xl` it takes mock-up 6's ratios (line 114): the stat panel
   * a little narrower, the Resources and Actions column a little wider, so a long
   * "Claim {vendor}" button has room. With no Categories group the row has three columns.
   */
  protected readonly topRowClass = computed(
    () =>
      'grid md:grid-cols-2 md:[&>:last-child:nth-child(odd)]:col-span-2 xl:[&>:last-child:nth-child(odd)]:col-span-1 ' +
      (this.hasCategories()
        ? 'xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)]'
        : 'xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)_minmax(0,1.15fr)]'),
  );

  /**
   * The rows the page lists below the card: the Integrations heading's count plus the
   * "Integrations it powers" heading's count. Both read the same functions as those
   * headings, so the three numbers come from one definition.
   */
  private readonly pageRowCount = computed(() => {
    const p = this.product();
    return (
      splitIntegrationLanes(p.integrations_as_source, p.integrations_as_target).rowCount +
      groupPoweredIntegrations(p.integrations_as_connector, p.slug).pairCount
    );
  });

  /**
   * The card's count. Normally the stored `integration_count`. That column is recomputed
   * after each write, so it can lag the rows. A stored zero never wins over listed rows:
   * the card must not say "We have no integrations on record" above a list of them.
   */
  protected readonly count = computed(() =>
    integrationsOnRecordCount(this.product().integration_count, this.pageRowCount()),
  );

  /**
   * Whether the stat panel shows "Know of one?". The Integrations section shows its own
   * "Know of one?" block only in the true zero state: no integrations on record and no
   * §13.7 reach line (`ProductIntegrationsSection.zero`). The link takes the same test,
   * so it never points at a section that lacks the block.
   */
  protected readonly showKnowOfOne = computed(() => {
    const p = this.product();
    return hasNoIntegrationsOnRecord(p) && (p.reachable_pair_count ?? 0) === 0;
  });

  /** The printed count. `aec-figure` never formats. */
  protected readonly countText = computed(() => formatNumber(this.count(), this.locale, '1.0-0'));

  /** The noun the product cards print with the same count. */
  protected readonly countNoun = computed(() => integrationNoun(this.count()));

  /** The vendor's one line (AECI-1310). Sources stay on the vendor page. */
  protected readonly vendorFactsLine = computed<string | null>(() => {
    const facts = this.product().vendor_facts;
    const parts: string[] = [];
    if (facts.company_size) {
      const size = companySizeLabel(facts.company_size);
      parts.push($localize`:@@products.detail.vendor.employees:${size}:SIZE: employees`);
    }
    if (facts.ownership_type) parts.push(ownershipTypeLabel(facts.ownership_type));
    return parts.length > 0 ? parts.join(' · ') : null;
  });

  /**
   * The "Resources" links (AECI-1309): the integrations page is `listing`, the API docs
   * are `docs`. The owner is the product's primary vendor, the same rule as the hero's
   * "Visit website" click (`VENDOR_PERFORMANCE_SPEC.md` §3.2).
   */
  protected docsLinkContext(purpose: 'listing' | 'docs'): ExternalLinkContext {
    const p = this.product();
    return {
      owner_vendor_id: p.vendor?.id ?? null,
      link_origin: 'vendor',
      source_entity_type: 'product',
      source_entity_id: p.id,
      link_purpose: purpose,
    };
  }

  /** AECI-1238 (§11d.7): whether AECi hid `field` while it checks it. */
  protected underReview(field: string): boolean {
    return isUnderReview(this.product().under_review, field);
  }
}
