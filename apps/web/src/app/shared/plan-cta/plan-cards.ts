/**
 * The Free and Managed plan cards (`placement: card`), shared by the vendor
 * guide's Plans page (inside `docs/docs-plans-comparison.ts`) and the vendor
 * program page (`VENDOR_PROGRAM_PAGE_SPEC.md` §3 item 6: reuse, do not copy).
 * Extracted from `DocsPlansComparisonComponent` in AECI-1285, markup unchanged.
 *
 * Anchor site: **Mintlify**'s billing page, Mobbin screen
 * `c74405c6-a307-4e35-b8eb-21a1129ce5f3`. Flat bordered plan cards, the paid
 * one marked by a heavier border rather than a shadow or a gradient.
 *
 * The price is the default list price (`MANAGED_LIST_PRICE_CENTS`,
 * `STAGE_2_PAID_TIERS_SPEC.md` §13.13), formatted by the same helper as the
 * portal's plan panel. Managed copy must never suggest it changes where a
 * listing ranks or appears (`STAGE_2_PAID_TIERS_SPEC.md` §3.2).
 *
 * Inputs, as on the other plan calls to action (`plan-cta.ts`): `page` and the
 * signed-in `portal` swap. Both buttons open the claim dialog (AECI-1293, spec
 * §15.1), and both read "Claim your listing" (E8.2, 2026-10-19, retired "Start with
 * Managed"). The Managed card's inquiry link and reply line were removed on 2026-10-19 (E8.1): claim is the only
 * plan action. A vendor seat sees "Go to your portal" on both.
 *
 * Static: no fetch and no visitor state, so the SSR HTML and the hydrated HTML
 * match and the page stays edge-cacheable. Every string is `$localize`d or
 * `i18n`. Light only. Styled by the unlayered `.aec-plan-*` classes in
 * `styles.css`, because a border-color utility loses to the unlayered `*` rule.
 */
import { Component, LOCALE_ID, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MANAGED_LIST_PRICE_CENTS } from '@aeci/shared/entitlements';

import { Analytics, type PlanCtaPage } from '../../analytics/analytics';
import { formatPlanPrice, planLabel } from '../../vendor/vendor-plan';
import { ClaimDialogTrigger } from '../claim-dialog/claim-dialog-trigger';
import { CLAIM_DIALOG_FALLBACK_HREF } from '../claim-dialog/claim-dialog.service';
import { PORTAL_PATH } from './plan-cta';

@Component({
  selector: 'aec-plan-cards',
  imports: [RouterLink, ClaimDialogTrigger],
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
        @if (portal()) {
          <a
            [routerLink]="portalPath"
            class="mt-4 rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-center text-sm font-medium text-(--text-primary) hover:bg-(--surface-muted) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@planCta.portal"
            >Go to your portal</a
          >
        } @else {
          <a
            [href]="claimHref"
            aecClaimDialogTrigger="card"
            [aecClaimDialogPage]="page()"
            (click)="track('free')"
            class="mt-4 rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-center text-sm font-medium text-(--text-primary) no-underline hover:bg-(--surface-muted) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@planCta.claim"
            >Claim your listing</a
          >
        }
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
            >USD a month per product</span
          >
        </p>
        @if (portal()) {
          <a [routerLink]="portalPath" [class]="managedButtonClass" i18n="@@planCta.portal"
            >Go to your portal</a
          >
        } @else {
          <a
            [href]="claimHref"
            aecClaimDialogTrigger="card"
            [aecClaimDialogPage]="page()"
            (click)="track('managed')"
            [class]="managedButtonClass"
            i18n="@@planCta.claim"
            >Claim your listing</a
          >
        }
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
  `,
})
export class PlanCardsComponent {
  private readonly locale = inject(LOCALE_ID);
  private readonly analytics = inject(Analytics);
  protected readonly claimHref = CLAIM_DIALOG_FALLBACK_HREF;
  protected readonly portalPath = PORTAL_PATH;
  protected readonly managedButtonClass =
    'mt-4 rounded-(--radius-md) bg-(--accent-primary) px-5 py-3.5 text-center text-base font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  /** Which page the cards sit on, for `plan_cta_clicked` and the claim dialog. */
  readonly page = input.required<PlanCtaPage>();
  /** A signed-in vendor: the claim link becomes "Go to your portal" (spec §5). */
  readonly portal = input(false);

  protected readonly freeName = planLabel('free');
  protected readonly managedName = planLabel('managed');
  protected readonly freePrice = formatPlanPrice(0, this.locale);
  protected readonly managedPrice = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, this.locale);

  protected readonly freeHighlights: readonly string[] = [
    $localize`:@@app.docs.plans.free.h1:Keep your company details and logo current`,
    $localize`:@@app.docs.plans.free.h2:Keep each product's description, website and categories current`,
    $localize`:@@app.docs.plans.free.h3:Claim and maintain the integrations you build`,
    $localize`:@@app.docs.plans.free.h4:Invite your colleagues`,
  ];

  protected readonly managedHighlights: readonly string[] = [
    $localize`:@@app.docs.plans.managed.h1:"How teams use it", in your own words`,
    $localize`:@@app.docs.plans.managed.h2:The trades, audiences and phases you serve`,
    $localize`:@@app.docs.plans.managed.integrationDetail:More detailed information about integrations (additional URLs, data flow, etc.).`,
    $localize`:@@app.docs.plans.managed.h6:Public answers to reviews`,
    $localize`:@@app.docs.plans.managed.h7:Search engines told when you update a page`,
  ];

  protected track(plan: 'free' | 'managed'): void {
    this.analytics.planCtaClicked({ plan, placement: 'card', page: this.page() });
  }
}
