import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import { NgTemplateOutlet, formatDate } from '@angular/common';
import { RouterLink } from '@angular/router';

import { productTakesSubscription, type VendorEntitlementBlock } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AecCard, type AecCardTone } from '../../shared/card/card';
import { isCatalogueSeat } from '../vendor-capabilities';
import {
  noPlanChangesLine,
  parseDate,
  planPriceSentence,
  planState,
  signedDaysRemaining,
  type PlanState,
} from '../vendor-plan';

import { VendorDocsLink } from './vendor-docs-link';
import { VendorPlanBadge } from './vendor-plan-badge';
import { VendorRemovalElection } from './vendor-removal-election';

/**
 * One product's plan panel (AECI-1218, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18,
 * `STAGE_2_PAID_TIERS_SPEC.md` §13). It sits on each product's overview, beside
 * that product's checklist. Plans live at the product level (decision 2), so the
 * vendor overview carries no plan card.
 *
 * It reads `product.plan`, never `me().entitlement` (§13.7). Until per-product
 * plans exist, every product carries the vendor's block, so this panel says the
 * same thing on every product of one vendor today, and nothing here changes when
 * per-product plans land.
 *
 * ── The states (`vendor-plan.ts`) ───────────────────────────────────────────
 *  - `managed`: what Managed covers for this product, then what Free also gives.
 *  - `expiring`: the same, led by the end date, the days left and a renewal
 *    path. Nothing has been taken away yet, and the copy says so. "Ends today"
 *    only on the end day itself (AECI-1408).
 *  - `overdue`: the end day passed and the daily lapse job has not ended the
 *    license yet. "Managed ended on {date}. The change is on its way." It
 *    offers the `ended` call to action, because the plan is going.
 *  - `pending`: Managed is arranged and not switched on, so the product is on
 *    Free until it is.
 *  - `ended`: the plan ended, the product is on Free, and ending a plan removes
 *    nothing entered (decision 8). The vendor-wide banner says the same at the
 *    top of every portal page (§13.11). This panel says it for the product. An
 *    owner seat also gets the 30-day removal election here (AECI-1618,
 *    `vendor-removal-election.ts`). It cannot sit on the product banner, because
 *    the vendor-wide banner hides that one.
 *  - `free`: never had Managed. What Free includes, what Managed adds.
 *  - `catalogue`: the connector catalogue seat (`STAGE_2_SPEC.md` §8.9). It is
 *    never sold Managed, so it gets no offer, no price and no call to action. It
 *    holds the Free edits like any seat with no plan (ruling 2026-10-02, §13.3).
 *    Since AECI-2044 only a product that is an Integration platform (or has no
 *    kind) AND has a catalogue shows it (`isCatalogueProduct`). Since AECI-2206 the
 *    catalogue must also have been handed to the vendor (`managed_by = 'vendor'`).
 *    A Sync Service is an ordinary product here: it may buy Managed (ruling 6 on
 *    AECI-2035).
 *  - `unavailable` (AECI-2044): a product with no plan that cannot hold a
 *    subscription (an Integration platform, or a connector with no kind, whose
 *    catalogue is absent or still AECi-managed, AECI-2206). What Free includes, a
 *    plain line that Managed is not offered for
 *    it, and no price or call to action. The API refuses the assign
 *    (`PRODUCT_NOT_SUBSCRIBABLE`), so the panel never offers it.
 *
 * ── Copy discipline ─────────────────────────────────────────────────────────
 * Every state carries decision 10's line word for word (§13.1). A product that can
 * hold a subscription shows Managed's price in every state but `catalogue`, and
 * nothing beyond Managed is offered (decision 9). A product that cannot (AECI-2044)
 * shows no price and no "Go to Billing" in any state. Its renewal path stays, because
 * a subscription already on it is never refused. No promise of search placement or instant search. The vendor's
 * own arrangement (amount paid, terms, PO) is never shown. An owner's button
 * goes to the Billing tab (`billingLink`), where owners pay by card: "Get
 * licenses" on `free`, `ended` and `overdue` (AECI-1408, AECI-1396), and
 * "Manage renewal" on `expiring` (AECI-1396). A member seat cannot open
 * Billing, so it keeps the contact path: "Ask about Managed for this product"
 * or "Renew Managed".
 *
 * ── The price line ──────────────────────────────────────────────────────────
 * No "Draft price" label (ruling 2026-10-08). The line is Managed's two list
 * prices, "Managed is $25 a month or $250 a year per product.", the same for
 * every vendor. The per-vendor override is retired (AECI-1357, decision 8).
 * Display only: nothing bills from it.
 *
 * ── The plan readout (AECI-1264) ────────────────────────────────────────────
 * The panel states the plan in words: the "Free" or "Managed" plan badge beside
 * the heading (portal only, `vendor-plan-badge.ts`) and the lede ("This product
 * is on Managed…"). No plan turns a public label on or off, so no list here
 * names one. The public "Active on AEC Integrations" badge was removed
 * (marketing review B1).
 *
 * Not an error surface in any state: no status colour, no alert role. Light
 * theme only.
 */
@Component({
  selector: 'aec-vendor-plan-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AecButton,
    AecCard,
    VendorDocsLink,
    VendorPlanBadge,
    VendorRemovalElection,
  ],
  template: `
    <section
      aecCard
      [tone]="cardTone()"
      class="block p-6"
      [attr.aria-labelledby]="headingId()"
      [attr.data-plan-state]="state()"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <!-- The card title size: the global h2 is 24px, so the 20px sits on the span. -->
        <h2 [id]="headingId()">
          <span class="text-t-20" i18n="@@vendor.plan.panel.heading">This product's plan</span>
        </h2>
        <aec-vendor-plan-badge [plan]="plan()" />
      </div>

      <p class="mt-3 max-w-prose text-sm leading-relaxed text-(--text-primary)">{{ lede() }}</p>

      @switch (state()) {
        @case ('unavailable') {
          <p class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
            <span i18n="@@vendor.plan.unavailable.scope"
              >Managed is not offered for this kind of product. Everything on Free stays
              available.</span
            >
          </p>
          <h3 [class]="listHeadingClass" i18n="@@vendor.plan.free.includes">Free includes</h3>
          <ng-container [ngTemplateOutlet]="freeList" />
        }
        @case ('catalogue') {
          <p class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
            <span i18n="@@vendor.plan.catalogue.scope"
              >Its description, website, logo and categories are yours to edit, like any listing on
              Free.</span
            >
          </p>
        }
        @case ('managed') {
          <ng-container [ngTemplateOutlet]="managedLists" />
        }
        @case ('expiring') {
          <ng-container [ngTemplateOutlet]="managedLists" />
        }
        @case ('overdue') {
          <ng-container [ngTemplateOutlet]="managedLists" />
        }
        @default {
          <h3 [class]="listHeadingClass" i18n="@@vendor.plan.free.includes">Free includes</h3>
          <ng-container [ngTemplateOutlet]="freeList" />
          <h3 [class]="listHeadingClass" i18n="@@vendor.plan.managed.adds">
            Managed adds, for this product
          </h3>
          <ng-container [ngTemplateOutlet]="managedList" />
        }
      }

      @if (offered()) {
        <p class="mt-5 max-w-prose text-sm text-(--text-primary)" data-testid="plan-price">
          {{ priceLine }}
        </p>
      }

      @switch (state()) {
        @case ('free') {
          <ng-container [ngTemplateOutlet]="endedCta" />
        }
        @case ('ended') {
          <ng-container [ngTemplateOutlet]="endedCta" />
        }
        @case ('overdue') {
          <ng-container [ngTemplateOutlet]="endedCta" />
        }
        @case ('expiring') {
          @if (billingLink(); as link) {
            <a
              aecButton
              variant="secondary"
              [routerLink]="link"
              class="mt-5"
              data-testid="plan-manage-renewal"
              i18n="@@vendor.plan.cta.manageRenewal"
              >Manage renewal</a
            >
          } @else {
            <a
              aecButton
              variant="secondary"
              routerLink="/contact"
              class="mt-5"
              i18n="@@vendor.plan.cta.renew"
              >Renew Managed</a
            >
          }
        }
      }

      @if (state() === 'ended' && electionProductId(); as productId) {
        <aec-vendor-removal-election [productId]="productId" />
      }

      <p class="mt-3"><aec-vendor-docs-link page="plans" /></p>

      <p
        class="mt-5 border-t border-(--border-default) pt-3 text-xs leading-relaxed text-(--text-secondary)"
        data-testid="plan-decision10"
      >
        {{ decision10 }}
      </p>
    </section>

    <!--
      AECI-1408 (ruling 4): an owner is sent to the Billing tab to get licenses.
      A member seat cannot open Billing, so it keeps the contact path.
      AECI-1396: the free state uses it too, now that owners can pay by card.
    -->
    <ng-template #endedCta>
      <!-- AECI-2044: never on a product that cannot hold a subscription. -->
      @if (offered()) {
        @if (billingLink(); as link) {
          <a
            aecButton
            variant="secondary"
            [routerLink]="link"
            class="mt-5"
            data-testid="plan-get-licenses"
            i18n="@@vendor.plan.cta.getLicenses"
            >Go to Billing</a
          >
        } @else {
          <a
            aecButton
            variant="secondary"
            routerLink="/contact"
            class="mt-5"
            i18n="@@vendor.plan.cta.askProduct"
            >Ask about Managed for this product</a
          >
        }
      }
    </ng-template>

    <ng-template #managedLists>
      <h3 [class]="listHeadingClass" i18n="@@vendor.plan.managed.covers">Managed covers</h3>
      <ng-container [ngTemplateOutlet]="managedList" />
      <h3 [class]="listHeadingClass" i18n="@@vendor.plan.managed.alsoFree">
        Also included, as on Free
      </h3>
      <ng-container [ngTemplateOutlet]="freeList" />
    </ng-template>

    <ng-template #freeList>
      <ul [class]="listClass" data-testid="plan-free-list">
        <li i18n="@@vendor.plan.free.listing">The product listing, published as it is</li>
        <li i18n="@@vendor.plan.free.basics">Edit its description, website, logo and categories</li>
        <li i18n="@@vendor.plan.free.looksRight">
          Mark its details and its integration list as checked
        </li>
        <li i18n="@@vendor.plan.free.claims">
          Claim its integrations, add links and request corrections
        </li>
        <li i18n="@@vendor.plan.free.create">Add a new integration</li>
        <li i18n="@@vendor.plan.free.flows">Confirm or deny the data flows on its integrations</li>
      </ul>
    </ng-template>

    <ng-template #managedList>
      <ul [class]="listClass" data-testid="plan-managed-list">
        <li i18n="@@vendor.plan.managed.narrative">
          Edit "How teams use it", the integrations page URL and the API documentation URL
        </li>
        <li i18n="@@vendor.plan.managed.taxonomy">Edit trades, audiences and phases</li>
      </ul>
    </ng-template>
  `,
  styles: [':host { display: block; }'],
})
export class VendorPlanPanel {
  private readonly locale = inject(LOCALE_ID);

  /** THIS product's plan (`VendorProduct.plan`, §13.7). */
  readonly plan = input.required<VendorEntitlementBlock>();
  /**
   * The product's `product_role`. With {@link connectorKind} it decides whether the
   * product can hold a subscription (`productTakesSubscription`, AECI-2044). `null`
   * (not passed) reads as an application, the ordinary panel.
   */
  readonly productRole = input<string | null>(null);
  /** The product's `connector_kind` (AECI-2036). Only a connector's kind matters here. */
  readonly connectorKind = input<string | null>(null);
  /**
   * `VendorProduct.connector_catalog_managed_by` (AECI-2206): `vendor` once the
   * product's catalogue is handed to the vendor. Only then is it the §8.9 seat's
   * product, and only then does the panel show the `catalogue` state.
   */
  readonly connectorCatalogManagedBy = input<string | null>(null);
  /** Unique per page, so two panels never share a heading id. */
  readonly headingId = input('vendor-plan-panel-h');
  /**
   * Router commands to the Billing tab, for an owner seat only (AECI-1408,
   * ruling 4). When set, the `free`, `ended` and `overdue` states offer "Get
   * licenses" there, and `expiring` offers "Manage renewal" (AECI-1396). `null` for a member seat, which keeps the contact path. The host
   * builds it relative to its own route, so the preview resolves it too.
   */
  readonly billingLink = input<string | readonly unknown[] | null>(null);

  /**
   * This product's id for an owner seat, `null` for a member (AECI-1618). When set,
   * the `ended` state mounts the removal election, whose lazy read is owner-only.
   */
  readonly electionProductId = input<string | null>(null);

  /**
   * Clock injection point, read at day granularity, so the expiring state is
   * testable and the SSR and hydration renders agree.
   */
  readonly now = input<number>(Date.now());

  protected readonly decision10 = noPlanChangesLine();

  /** Managed's two list prices. The same for every vendor. */
  protected readonly priceLine = planPriceSentence(this.locale);

  /** Can this product hold a subscription? (AECI-2044, ruling 6.) */
  private readonly subscribable = computed(() =>
    productTakesSubscription(this.productRole() ?? 'application', this.connectorKind()),
  );

  protected readonly state = computed<PlanState | 'catalogue' | 'unavailable'>(() => {
    const plan = this.plan();
    const product = {
      product_role: this.productRole(),
      connector_kind: this.connectorKind(),
      connector_catalog_managed_by: this.connectorCatalogManagedBy(),
    };
    if (isCatalogueSeat(plan.status, [product])) return 'catalogue';
    const state = planState(plan, this.now());
    return state === 'free' && !this.subscribable() ? 'unavailable' : state;
  });

  /** Show Managed's price and the purchase path: never on `catalogue` or
   *  `unavailable`, and never on a product that cannot hold a subscription. */
  protected readonly offered = computed(() => {
    const state = this.state();
    return state !== 'catalogue' && state !== 'unavailable' && this.subscribable();
  });

  /**
   * Formatted in UTC, not the ambient zone: the SSR Worker runs in UTC and the
   * browser does not, so a zone-local date could differ across hydration.
   */
  private format(raw: string | null): string | null {
    const d = parseDate(raw);
    return d === null ? null : formatDate(d, 'MMMM d, y', this.locale, 'UTC');
  }

  protected readonly lede = computed<string>(() => {
    const plan = this.plan();
    switch (this.state()) {
      case 'managed': {
        const date = this.format(plan.period_end);
        return date === null
          ? $localize`:@@vendor.plan.lede.managed.noEnd:This product is on Managed, with no end date on record.`
          : $localize`:@@vendor.plan.lede.managed:This product is on Managed, through ${date}:DATE:.`;
      }
      case 'expiring': {
        // `expiring` always carries a term, so the date is never null here.
        const date = this.format(plan.period_end) ?? '';
        const days = signedDaysRemaining(plan, this.now()) ?? 0;
        return days === 0
          ? $localize`:@@vendor.plan.lede.expiring.today:Managed ends today, ${date}:DATE:, for this product. Nothing changes before then.`
          : days === 1
            ? $localize`:@@vendor.plan.lede.expiring.one:Managed ends on ${date}:DATE: for this product, in 1 day. Nothing changes before then.`
            : $localize`:@@vendor.plan.lede.expiring:Managed ends on ${date}:DATE: for this product, in ${days}:DAYS: days. Nothing changes before then.`;
      }
      case 'overdue': {
        // The end day passed and the daily job has not ended the license yet.
        const date = this.format(plan.period_end) ?? '';
        return $localize`:@@vendor.plan.lede.overdue:Managed ended on ${date}:DATE:. The change is on its way.`;
      }
      case 'pending':
        return $localize`:@@vendor.plan.lede.pending:Managed is arranged for this product and switches on shortly. Until it does, the product is on Free.`;
      case 'ended': {
        const date = this.format(plan.ended_at);
        return date === null
          ? $localize`:@@vendor.plan.lede.ended.noDate:Managed has ended for this product, so it is on Free. Ending a plan removes nothing you entered.`
          : $localize`:@@vendor.plan.lede.ended:Managed ended for this product on ${date}:DATE:, so it is on Free. Ending a plan removes nothing you entered.`;
      }
      case 'catalogue':
        return $localize`:@@vendor.plan.lede.catalogue:This seat maintains your connector catalog on AEC Integrations: your listings, the products each one maps to, and the evidence behind each mapping.`;
      default:
        return $localize`:@@vendor.plan.lede.free:This product is on Free. Its listing is published and stays published.`;
    }
  });

  /** The shared white card (AECI-1810). `expiring` and `overdue` take the warm Bone
   *  card because a term running out is a calendar fact, not a failure. */
  protected readonly cardTone = computed<AecCardTone>(() => {
    const state = this.state();
    return state === 'expiring' || state === 'overdue' ? 'warm' : 'base';
  });

  // `aec-overline` beats the unlayered h3 rule in styles.css; a size utility does not.
  protected readonly listHeadingClass = 'aec-overline mt-5 text-(--text-secondary)';
  protected readonly listClass =
    'mt-2 list-disc space-y-2 ps-5 text-sm leading-relaxed text-(--text-secondary)';
}
