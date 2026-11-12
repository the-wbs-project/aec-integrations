/**
 * The Plans comparison table's rows, as pure data (AECI-1619). Split out of
 * `docs-plans-comparison.ts` so the Plans snapshot (`plans-snapshot.ts`) can print
 * the same table without loading Angular. See that component's header for the
 * rules the rows follow: every capability cell reads `TIER_CAPABILITIES`, and
 * the price row reads the list prices.
 *
 * No Angular component import: plain Vitest runs it with `@angular/localize/init`.
 * `$localize` runs on each call, never at module init.
 */
import {
  type Capability,
  MANAGED_ANNUAL_PRICE_CENTS,
  MANAGED_LIST_PRICE_CENTS,
  TIER_CAPABILITIES,
} from '@aeci/shared/entitlements';

import { formatPlanPrice } from '../vendor/vendor-plan';

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
          managed: $localize`:@@app.docs.plans.row.billingManaged:By card, monthly or yearly`,
        },
      ],
    },
  ];
}

/** The note under the cards: the sort rule (decision 10, §3.2). */
export function planSortRuleNote(): string {
  return $localize`:@@app.docs.plans.sortRule:Every listing is sorted by the same published rules. Your plan is not part of that.`;
}
