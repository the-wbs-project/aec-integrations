/**
 * The Plans page's pricing layout (`/docs/vendors/plans`): a Free card, a
 * Managed card, then a side-by-side comparison table. Placed in the page by the
 * `<!-- docs:plans-comparison -->` line in `content/docs/vendors/plans.md`
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
 * rights, search-engine notice, connector integrations) state their values here
 * and follow `STAGE_2_PAID_TIERS_SPEC.md` §13.
 *
 * **Copy is benefit-first (marketing review, 2026-10-12).** Labels say what a
 * vendor gets, not what the portal calls the control. Portal how-tos
 * ("Looks right", checklist counts) live on `vendors/checklists`, and work not
 * yet shipped is a short "Coming soon" section in the Markdown, never a table
 * row. Managed copy must never suggest it changes where a listing ranks or
 * appears (decision 10, §3.2): the note under the cards states the sort rule
 * instead.
 *
 * The price is the default list price (`MANAGED_LIST_PRICE_CENTS`, §13.13),
 * formatted by the same helper as the portal's plan panel. A company with a
 * price override sees its own price in the portal; the card says so.
 *
 * Static: no fetch and no visitor state, so the SSR HTML and the hydrated HTML
 * match and the page stays edge-cacheable. Chrome only, so every string is
 * `$localize`d. Light only. Styled by the unlayered `.aec-plan-*` classes in
 * `styles.css`, because a border-color utility loses to the unlayered `*` rule
 * and this renders outside `.aec-prose`.
 */
import { Component, LOCALE_ID, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  type Capability,
  MANAGED_LIST_PRICE_CENTS,
  TIER_CAPABILITIES,
} from '@aeci/shared/entitlements';

import { Analytics, type PlanCtaPlacement } from '../analytics/analytics';
import { PlanInquiryTrigger } from '../shared/plan-inquiry/plan-inquiry-trigger';
import { formatPlanPrice, planLabel } from '../vendor/vendor-plan';
import { CLAIM_PATH, MANAGED_CONTACT_HREF } from './docs-plans-cta';

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
          label: $localize`:@@app.docs.plans.row.contest:Contest a detail on an integration you do not own`,
          free: true,
          managed: true,
        },
        capabilityRow(
          $localize`:@@app.docs.plans.row.dataFlows:Confirm which data each integration moves`,
          'attestation.author',
        ),
        {
          label: $localize`:@@app.docs.plans.row.connector:Claim the integrations you deliver through a connector`,
          free: false,
          managed: true,
        },
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
          managed: $localize`:@@app.docs.plans.row.priceManaged:${price}:AMOUNT: a month per product`,
        },
        {
          label: $localize`:@@app.docs.plans.row.billing:Billing`,
          free: $localize`:@@app.docs.plans.row.billingFree:Nothing to pay`,
          managed: $localize`:@@app.docs.plans.row.billingManaged:Invoice or purchase order`,
        },
      ],
    },
  ];
}

@Component({
  selector: 'app-docs-plans-comparison',
  imports: [RouterLink, PlanInquiryTrigger],
  host: { class: 'block' },
  template: `
    <div class="grid gap-4 sm:grid-cols-2">
      <section class="aec-plan-card flex flex-col p-5" aria-labelledby="plan-card-free">
        <h3 id="plan-card-free" class="aec-plan-card-name text-(--text-primary)">
          {{ freeName }}
        </h3>
        <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@app.docs.plans.free.summary">
          Keep your listing accurate.
        </p>
        <p class="mt-4 flex items-baseline gap-1.5">
          <span class="aec-plan-price text-(--text-primary)">{{ freePrice }}</span>
          <span class="text-sm text-(--text-secondary)" i18n="@@app.docs.plans.free.unit"
            >for every company with a seat</span
          >
        </p>
        <a
          [routerLink]="claimPath"
          (click)="track('free', 'card')"
          class="mt-4 rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-center text-sm font-medium text-(--text-primary) hover:bg-(--surface-muted) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          i18n="@@app.docs.plans.free.cta"
          >Claim your listing</a
        >
        <p
          class="mt-5 text-xs font-medium text-(--text-secondary)"
          i18n="@@app.docs.plans.free.includes"
        >
          Includes
        </p>
        <ul class="mt-2 space-y-2 text-sm text-(--text-primary)">
          @for (item of freeHighlights; track item) {
            <li class="flex gap-2">
              <svg
                class="mt-0.5 size-4 shrink-0 text-(--accent-primary)"
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
              <span>{{ item }}</span>
            </li>
          }
        </ul>
      </section>

      <section
        class="aec-plan-card aec-plan-card-featured flex flex-col p-5"
        aria-labelledby="plan-card-managed"
      >
        <h3 id="plan-card-managed" class="aec-plan-card-name text-(--text-primary)">
          {{ managedName }}
        </h3>
        <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@app.docs.plans.managed.summary">
          Tell the full story of each product.
        </p>
        <p class="mt-4 flex items-baseline gap-1.5">
          <span class="aec-plan-price text-(--text-primary)">{{ managedPrice }}</span>
          <span class="text-sm text-(--text-secondary)" i18n="@@app.docs.plans.managed.unit"
            >a month per product</span
          >
        </p>
        <a
          [href]="contactHref"
          aecPlanInquiryTrigger="card"
          (click)="track('managed', 'card')"
          class="mt-4 rounded-(--radius-md) bg-(--accent-primary) px-5 py-3.5 text-center text-base font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          i18n="@@app.docs.plans.managed.cta"
          >Talk to us about Managed</a
        >
        <p
          class="mt-2 text-center text-xs text-(--text-secondary)"
          i18n="@@app.docs.plans.managed.reply"
        >
          We reply to most messages within a couple of business days.
        </p>
        <p
          class="mt-5 text-xs font-medium text-(--text-secondary)"
          i18n="@@app.docs.plans.managed.includes"
        >
          Everything in Free, plus
        </p>
        <ul class="mt-2 space-y-2 text-sm text-(--text-primary)">
          @for (item of managedHighlights; track item) {
            <li class="flex gap-2">
              <svg
                class="mt-0.5 size-4 shrink-0 text-(--accent-primary)"
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
              <span>{{ item }}</span>
            </li>
          }
        </ul>
      </section>
    </div>

    <p
      class="aec-plan-note mt-4 px-4 py-3 text-sm text-(--text-primary)"
      i18n="@@app.docs.plans.sortRule"
    >
      Every listing is sorted the same way: how well it matches the search, then how complete it is.
      Your plan is not part of that.
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
  private readonly analytics = inject(Analytics);
  protected readonly contactHref = MANAGED_CONTACT_HREF;
  protected readonly claimPath = CLAIM_PATH;

  protected readonly freeName = planLabel('free');
  protected readonly managedName = planLabel('managed');
  protected readonly freePrice = formatPlanPrice(0, this.locale);
  protected readonly managedPrice = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, this.locale);
  protected readonly groups = planComparisonGroups(this.locale);

  protected readonly freeHighlights: readonly string[] = [
    $localize`:@@app.docs.plans.free.h1:Keep your company details and logo current`,
    $localize`:@@app.docs.plans.free.h2:Keep each product's description, website and categories current`,
    $localize`:@@app.docs.plans.free.h3:Claim and maintain the integrations you build`,
    $localize`:@@app.docs.plans.free.h4:Invite your colleagues`,
  ];

  protected readonly managedHighlights: readonly string[] = [
    $localize`:@@app.docs.plans.managed.h1:"How teams use it", in your own words`,
    $localize`:@@app.docs.plans.managed.h2:The trades, audiences and phases you serve`,
    $localize`:@@app.docs.plans.managed.h3:Links to your integrations page and API docs`,
    $localize`:@@app.docs.plans.managed.h4:Your answer on every data flow`,
    $localize`:@@app.docs.plans.managed.h5:The integrations you deliver through a connector`,
    $localize`:@@app.docs.plans.managed.h6:Public answers to reviews`,
    $localize`:@@app.docs.plans.managed.h7:Search engines told when you update a page`,
  ];

  protected track(plan: 'free' | 'managed', placement: PlanCtaPlacement): void {
    this.analytics.planCtaClicked({ plan, placement });
  }
}
