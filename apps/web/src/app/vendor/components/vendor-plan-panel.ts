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

import type { VendorEntitlementBlock } from '@aeci/shared';

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
 *  - `ended`: the plan ended, the product is on Free, and nothing entered was
 *    removed (decision 8). The vendor-wide banner says the same at the top of
 *    every portal page (§13.11). This panel says it for the product.
 *  - `free`: never had Managed. What Free includes, what Managed adds.
 *  - `catalogue`: the connector catalogue seat (`STAGE_2_SPEC.md` §8.9). It is
 *    never sold Managed, so it gets no offer, no price and no call to action. It
 *    holds the Free edits like any seat with no plan (ruling 2026-10-02, §13.3).
 *
 * ── Copy discipline ─────────────────────────────────────────────────────────
 * Every state carries decision 10's line word for word (§13.1). Every state but
 * `catalogue` shows Managed's price, and nothing beyond Managed is offered
 * (decision 9). No promise of search placement or instant search. The vendor's
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
  imports: [NgTemplateOutlet, RouterLink, VendorDocsLink, VendorPlanBadge],
  template: `
    <section
      [attr.aria-labelledby]="headingId()"
      [class]="shellClass()"
      [attr.data-plan-state]="state()"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <h2 [id]="headingId()" class="font-display text-xl font-semibold text-(--text-primary)">
          <span i18n="@@vendor.plan.panel.heading">This product's plan</span>
        </h2>
        <aec-vendor-plan-badge [plan]="plan()" />
      </div>

      <p class="mt-3 max-w-prose text-sm leading-relaxed text-(--text-primary)">{{ lede() }}</p>

      @switch (state()) {
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

      @if (state() !== 'catalogue') {
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
              [routerLink]="link"
              [class]="ctaClass"
              data-testid="plan-manage-renewal"
              i18n="@@vendor.plan.cta.manageRenewal"
              >Manage renewal</a
            >
          } @else {
            <a routerLink="/contact" [class]="ctaClass" i18n="@@vendor.plan.cta.renew"
              >Renew Managed</a
            >
          }
        }
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
      @if (billingLink(); as link) {
        <a
          [routerLink]="link"
          [class]="ctaClass"
          data-testid="plan-get-licenses"
          i18n="@@vendor.plan.cta.getLicenses"
          >Get licenses</a
        >
      } @else {
        <a routerLink="/contact" [class]="ctaClass" i18n="@@vendor.plan.cta.askProduct"
          >Ask about Managed for this product</a
        >
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
      </ul>
    </ng-template>

    <ng-template #managedList>
      <ul [class]="listClass" data-testid="plan-managed-list">
        <li i18n="@@vendor.plan.managed.narrative">
          Edit "How teams use it", the integrations page URL and the API documentation URL
        </li>
        <li i18n="@@vendor.plan.managed.taxonomy">Edit trades, audiences and phases</li>
        <li i18n="@@vendor.plan.managed.flows">
          Confirm or deny the data flows on its integrations
        </li>
        <li i18n="@@vendor.plan.managed.connector">
          Manage its integrations delivered through a connector
        </li>
      </ul>
    </ng-template>
  `,
  styles: [':host { display: block; }'],
})
export class VendorPlanPanel {
  private readonly locale = inject(LOCALE_ID);

  /** THIS product's plan (`VendorProduct.plan`, §13.7). */
  readonly plan = input.required<VendorEntitlementBlock>();
  /** The product's `product_role`: a `connector` with no plan row is the §8.9 seat. */
  readonly productRole = input<string | null>(null);
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
   * Clock injection point, read at day granularity, so the expiring state is
   * testable and the SSR and hydration renders agree.
   */
  readonly now = input<number>(Date.now());

  protected readonly decision10 = noPlanChangesLine();

  /** Managed's two list prices. The same for every vendor. */
  protected readonly priceLine = planPriceSentence(this.locale);

  protected readonly state = computed<PlanState | 'catalogue'>(() => {
    const plan = this.plan();
    if (isCatalogueSeat(plan.status, [{ product_role: this.productRole() }])) return 'catalogue';
    return planState(plan, this.now());
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
          ? $localize`:@@vendor.plan.lede.ended.noDate:Managed has ended for this product, so it is on Free. Nothing you entered was removed.`
          : $localize`:@@vendor.plan.lede.ended:Managed ended for this product on ${date}:DATE:, so it is on Free. Nothing you entered was removed.`;
      }
      case 'catalogue':
        return $localize`:@@vendor.plan.lede.catalogue:This seat maintains your connector catalog on AEC Integrations: your listings, the products each one maps to, and the evidence behind each mapping.`;
      default:
        return $localize`:@@vendor.plan.lede.free:This product is on Free. Its listing is published and stays published.`;
    }
  });

  /** Bordered, never a fill. `expiring` and `overdue` take the warm Bone wash
   *  because a term running out is a calendar fact, not a failure. */
  protected readonly shellClass = computed(() => {
    const base = 'block rounded-(--radius-md) border p-5 md:p-6';
    const state = this.state();
    return state === 'expiring' || state === 'overdue'
      ? `${base} border-(--border-strong) bg-(--accent-warm)`
      : `${base} border-(--border-default) bg-(--surface-raised)`;
  });

  // `aec-overline` beats the unlayered h3 rule in styles.css; a size utility does not.
  protected readonly listHeadingClass = 'aec-overline mt-5 text-(--text-secondary)';
  protected readonly listClass =
    'mt-2 list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-(--text-secondary)';
  protected readonly ctaClass =
    'mt-5 inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-4 py-2 text-sm font-semibold text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}
