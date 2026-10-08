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
  daysRemaining,
  noPlanChangesLine,
  parseDate,
  planState,
  type PlanState,
} from '../vendor-plan';

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
 *  - `expiring`: the same, led by the end date and a renewal path. Nothing has
 *    been taken away yet, and the copy says so.
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
 * Every state carries decision 10's line word for word (§13.1). Managed shows a
 * draft price label, and nothing beyond Managed is offered (decision 9). No
 * promise of search placement or instant search. The vendor's own arrangement
 * (amount paid, terms, PO) is never shown: the price is the list price, marked
 * as a draft. Renewal is a conversation (`/contact`), not a checkout.
 *
 * Not an error surface in any state: no status colour, no alert role. Light
 * theme only.
 */
@Component({
  selector: 'aec-vendor-plan-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, VendorPlanBadge],
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
              Free. Catalogue maintenance carries no public account label.</span
            >
          </p>
        }
        @case ('managed') {
          <ng-container [ngTemplateOutlet]="managedLists" />
        }
        @case ('expiring') {
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
        <p
          class="mt-5 flex flex-wrap items-center gap-2 text-sm text-(--text-primary)"
          data-testid="plan-price"
        >
          <span i18n="@@vendor.plan.price">Managed is $25 a month per product.</span>
          <span
            class="rounded-(--radius-sm) bg-(--surface-sunken) px-1.5 py-px text-[0.6875rem] font-semibold tracking-[0.04em] text-(--text-secondary) uppercase"
            i18n="@@vendor.plan.price.draft"
            >Draft price</span
          >
        </p>
      }

      @switch (state()) {
        @case ('free') {
          <a routerLink="/contact" [class]="ctaClass" i18n="@@vendor.plan.cta.askProduct"
            >Ask about Managed for this product</a
          >
        }
        @case ('ended') {
          <a routerLink="/contact" [class]="ctaClass" i18n="@@vendor.plan.cta.askProduct"
            >Ask about Managed for this product</a
          >
        }
        @case ('expiring') {
          <a routerLink="/contact" [class]="ctaClass" i18n="@@vendor.plan.cta.renew"
            >Renew Managed</a
          >
        }
      }

      <p
        class="mt-5 border-t border-(--border-default) pt-3 text-xs leading-relaxed text-(--text-secondary)"
        data-testid="plan-decision10"
      >
        {{ decision10 }}
      </p>
    </section>

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
        <li i18n="@@vendor.plan.managed.label">
          Counts toward the "Active on AECi" label on your vendor page
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
   * Clock injection point, read at day granularity, so the expiring state is
   * testable and the SSR and hydration renders agree.
   */
  readonly now = input<number>(Date.now());

  protected readonly decision10 = noPlanChangesLine();

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
        const days = daysRemaining(plan, this.now()) ?? 0;
        return days === 0
          ? $localize`:@@vendor.plan.lede.expiring.today:Managed ends today for this product. Nothing changes before then.`
          : days === 1
            ? $localize`:@@vendor.plan.lede.expiring.one:Managed ends in 1 day for this product. Nothing changes before then.`
            : $localize`:@@vendor.plan.lede.expiring:Managed ends in ${days}:DAYS: days for this product. Nothing changes before then.`;
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
        return $localize`:@@vendor.plan.lede.catalogue:This seat maintains your connector catalogue on AECi: your listings, the products each one maps to, and the evidence behind each mapping.`;
      default:
        return $localize`:@@vendor.plan.lede.free:This product is on Free. Its listing is published and stays published.`;
    }
  });

  /** Bordered, never a fill. `expiring` takes the warm Bone wash because a term
   *  running out is a calendar fact, not a failure. */
  protected readonly shellClass = computed(() => {
    const base = 'block rounded-(--radius-md) border p-5 md:p-6';
    return this.state() === 'expiring'
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
