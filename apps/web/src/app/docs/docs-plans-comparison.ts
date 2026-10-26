/**
 * The Plans page's pricing layout (`/docs/vendors/plans`): the Free and Managed
 * cards (`shared/plan-cta/plan-cards.ts`, shared with `/vendor-program` since
 * AECI-1285), the sort rule, then a side-by-side comparison table. Placed in the
 * page by the `<!-- docs:plans-comparison -->` line in `content/docs/vendors/plans.md`
 * (`docs-markdown.ts`, "Widgets"). The Markdown keeps the full prose, so search
 * and the "On this page" rail still read it. This is the at-a-glance view.
 *
 * Anchor site: **Mintlify**'s billing page, Mobbin screen
 * `c74405c6-a307-4e35-b8eb-21a1129ce5f3`. Flat bordered plan cards, the paid
 * one marked by a heavier border rather than a shadow or a gradient, then a
 * check-mark table grouped by area. AECi keeps its own tokens and type.
 *
 * **Every capability cell comes from `TIER_CAPABILITIES`.** A row that one or
 * more capabilities gate names them, and the cell reads the registry, so the
 * table cannot promise what the API will refuse. Rows with no capability (seat
 * rights, search-engine notice) state their values here and follow
 * `STAGE_2_PAID_TIERS_SPEC.md` §13. Connector-delivered integrations are not a
 * plan benefit and have no row (Chris, 2026-10-13).
 *
 * **Copy is benefit-first (marketing review, 2026-10-12).** Labels say what a
 * vendor gets, not what the portal calls the control. Portal how-tos
 * ("Looks right", checklist counts) live on `vendors/checklists`, and work not
 * yet shipped appears nowhere: not as a table row and not as a teaser in the
 * Markdown (Chris, 2026-10-13). Managed copy must never suggest it changes where a listing ranks or
 * appears (decision 10, §3.2): the note under the cards states the sort rule
 * instead.
 *
 * The price row prints the monthly and the annual list price (`MANAGED_LIST_PRICE_CENTS`
 * and `MANAGED_ANNUAL_PRICE_CENTS`, §13.13, E8.2), formatted by the same helper as the
 * portal's plan panel.
 *
 * Static: no fetch and no visitor state, so the SSR HTML and the hydrated HTML
 * match and the page stays edge-cacheable. Chrome only, so every string is
 * `$localize`d. Light only. Styled by the unlayered `.aec-plan-*` classes in
 * `styles.css`, because a border-color utility loses to the unlayered `*` rule
 * and this renders outside `.aec-prose`.
 */
import { Component, LOCALE_ID, inject } from '@angular/core';

import {
  type Capability,
  MANAGED_ANNUAL_PRICE_CENTS,
  MANAGED_LIST_PRICE_CENTS,
  TIER_CAPABILITIES,
} from '@aeci/shared/entitlements';

import type { PlanCtaPage } from '../analytics/analytics';
import { PlanCardsComponent } from '../shared/plan-cta/plan-cards';
import { formatPlanPrice, planLabel } from '../vendor/vendor-plan';

/** A cell: included, not included, or a value to print (a count, a price). */
export type PlanCell = boolean | string;

export interface PlanRow {
  readonly label: string;
  readonly free: PlanCell;
  readonly managed: PlanCell;
}

export interface PlanRowGroup {
  readonly label: string;
  readonly rows: readonly PlanRow[];
}

/** A row gated by capabilities. A plan has it when it holds all of them. */
function capabilityRow(label: string, ...capabilities: Capability[]): PlanRow {
  return {
    label,
    free: capabilities.every((cap) => TIER_CAPABILITIES.unclaimed.includes(cap)),
    managed: capabilities.every((cap) => TIER_CAPABILITIES.verified.includes(cap)),
  };
}

/** The comparison table, grouped. Exported for the spec. */
export function planComparisonGroups(locale: string): readonly PlanRowGroup[] {
  const price = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  const annualPrice = formatPlanPrice(MANAGED_ANNUAL_PRICE_CENTS, locale);
  return [
    {
      label: $localize`:@@app.docs.plans.group.listing:Your listing`,
      rows: [
        capabilityRow(
          $localize`:@@app.docs.plans.row.company:Company details, logo and contact links`,
          'profile.edit',
        ),
        capabilityRow(
          $localize`:@@app.docs.plans.row.productBasics:Product description, website, logo and categories`,
          'product.listing.edit',
          'product.categories.edit',
        ),
        capabilityRow(
          $localize`:@@app.docs.plans.row.usefulness:"How teams use it", in your own words`,
          'product.usefulness.edit',
        ),
        capabilityRow(
          $localize`:@@app.docs.plans.row.taxonomy:The trades, audiences and phases each product serves`,
          'product.taxonomy.edit',
        ),
        capabilityRow(
          $localize`:@@app.docs.plans.row.urls:Links to your integrations page and API docs`,
          'product.edit',
        ),
      ],
    },
    {
      label: $localize`:@@app.docs.plans.group.integrations:Integrations`,
      rows: [
        {
          label: $localize`:@@app.docs.plans.row.own:Claim and maintain the integrations you build`,
          free: true,
          managed: true,
        },
        {
          label: $localize`:@@app.docs.plans.row.contest:Request a change to an integration you do not own`,
          free: true,
          managed: true,
        },
        capabilityRow(
          $localize`:@@app.docs.plans.row.dataFlows:Confirm which data each integration moves`,
          'attestation.author',
        ),
      ],
    },
    {
      label: $localize`:@@app.docs.plans.group.reach:Reviews and search engines`,
      rows: [
        capabilityRow(
          $localize`:@@app.docs.plans.row.reply:Answer reviews in public`,
          'review.reply',
        ),
        {
          label: $localize`:@@app.docs.plans.row.indexNow:We tell search engines when you update a page`,
          free: false,
          managed: true,
        },
      ],
    },
    {
      label: $localize`:@@app.docs.plans.group.account:Account and billing`,
      rows: [
        {
          label: $localize`:@@app.docs.plans.row.seats:Seats for your colleagues`,
          free: true,
          managed: true,
        },
        {
          label: $localize`:@@app.docs.plans.row.price:Price`,
          free: formatPlanPrice(0, locale),
          managed: $localize`:@@app.docs.plans.row.priceManaged:${price}:MONTHLY: USD a month or ${annualPrice}:ANNUAL: USD a year per product`,
        },
        {
          label: $localize`:@@app.docs.plans.row.billing:Billing`,
          free: $localize`:@@app.docs.plans.row.billingFree:Nothing to pay`,
          managed: $localize`:@@app.docs.plans.row.billingManaged:Monthly with no commitment, or yearly`,
        },
      ],
    },
  ];
}

@Component({
  selector: 'app-docs-plans-comparison',
  imports: [PlanCardsComponent],
  host: { class: 'block' },
  template: `
    <aec-plan-cards [page]="page" />

    <p
      class="aec-plan-note mt-4 px-4 py-3 text-sm text-(--text-primary)"
      i18n="@@app.docs.plans.sortRule"
    >
      Every listing is sorted by the same published rules. Your plan is not part of that.
    </p>

    <div class="mt-8 overflow-x-auto">
      <table class="aec-plan-table w-full text-sm">
        <caption class="sr-only" i18n="@@app.docs.plans.table.caption">
          What each plan includes
        </caption>
        <thead>
          <tr>
            <th scope="col" class="aec-plan-table-feature">
              <span class="sr-only" i18n="@@app.docs.plans.table.feature">Feature</span>
            </th>
            <th scope="col" class="aec-plan-table-plan">{{ freeName }}</th>
            <th scope="col" class="aec-plan-table-plan">{{ managedName }}</th>
          </tr>
        </thead>
        @for (group of groups; track group.label) {
          <tbody>
            <tr>
              <th scope="colgroup" colspan="3" class="aec-plan-table-group">
                {{ group.label }}
              </th>
            </tr>
            @for (row of group.rows; track row.label) {
              <tr>
                <th scope="row" class="aec-plan-table-feature">{{ row.label }}</th>
                @for (cell of [row.free, row.managed]; track $index) {
                  <td class="aec-plan-table-plan">
                    @if (cell === true) {
                      <svg
                        class="mx-auto size-4 text-(--accent-primary)"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.25"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      <span class="sr-only" i18n="@@app.docs.plans.table.included">Included</span>
                    } @else if (cell === false) {
                      <svg
                        class="mx-auto size-4 text-(--text-tertiary)"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        aria-hidden="true"
                      >
                        <path d="M5 12h14" />
                      </svg>
                      <span class="sr-only" i18n="@@app.docs.plans.table.notIncluded"
                        >Not included</span
                      >
                    } @else {
                      <span>{{ cell }}</span>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        }
      </table>
    </div>
  `,
})
export class DocsPlansComparisonComponent {
  private readonly locale = inject(LOCALE_ID);
  /** This component lives on the vendor guide's Plans page only. */
  protected readonly page: PlanCtaPage = 'docs_plans';

  protected readonly freeName = planLabel('free');
  protected readonly managedName = planLabel('managed');
  protected readonly groups = planComparisonGroups(this.locale);
}
